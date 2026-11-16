"""Offline regressions for same-ID changes, bounded migration and safe retries."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bin"))
import material_revisions as revisions

NOW = 1_800_000_000
COURSE = "BUSN3040"
ORG = "3955142"
TERM = "fall-2026"


def topic(identity=1, **kwargs):
    return dict({"id": identity, "title": "Syllabus", "type": "File", "ext": "pdf",
                 "unit": "Welcome", "url": "/content/enforced/3955142/syllabus.pdf"}, **kwargs)


def success(item=None, previous=None, when=NOW, content=b"v1", **kwargs):
    return revisions.record_success(previous, item or topic(), COURSE, ORG, TERM,
                                    hashlib.sha256(content).hexdigest(), len(content),
                                    "Syllabus.pdf", now=when, **kwargs)


def plan(items, fetched=None, **kwargs):
    return revisions.select_candidates({COURSE: items}, fetched or {}, {COURSE: ORG},
                                       TERM, now=kwargs.pop("now", NOW), **kwargs)


class MaterialRevisionsTests(unittest.TestCase):
    def test_same_id_same_metadata_is_not_repeated_until_due(self):
        previous = success()
        self.assertEqual(plan([topic()], {"1": previous})["selected"], [])
        self.assertEqual(plan([topic()], {"1": previous})["unchanged"], 1)
        late = plan([topic()], {"1": previous}, now=NOW + revisions.DAY)
        self.assertEqual(late["selected"][0]["reason"], "periodic_recheck")

    def test_same_id_modified_date_and_path_force_immediate_read(self):
        item = topic(last_modified="2026-10-11T12:00:00Z")
        previous = success(item)
        for changed in (dict(item, last_modified="2026-10-12T12:00:00Z"),
                        dict(item, url="/content/enforced/3955142/replacement.pdf")):
            with self.subTest(changed=changed):
                self.assertEqual(plan([changed], {"1": previous})["selected"][0]["reason"],
                                 "metadata_changed")

    def test_no_metadata_bytes_changed_preserve_previous_version(self):
        original = success()
        candidate = plan([topic()], {"1": original}, now=NOW + revisions.DAY)["selected"][0]
        self.assertEqual(candidate["reason"], "periodic_recheck")
        updated = success(previous=original, when=NOW + revisions.DAY, content=b"v2")
        self.assertEqual(updated["revisions"]["generation"], 2)
        self.assertEqual(updated["revisions"]["history"][0]["sha256"],
                         original["revisions"]["sha256"])
        self.assertEqual(updated["revisions"]["history"][0]["raw"], "Syllabus.pdf")
        self.assertNotEqual(updated["revisions"]["sha256"], original["revisions"]["sha256"])

    def test_metadata_hint_without_byte_change_refreshes_without_new_generation(self):
        original = success(topic(last_modified="2026-10-11T00:00:00Z"))
        changed = topic(last_modified="2026-10-12T00:00:00Z")
        updated = success(changed, previous=original, when=NOW + 1)
        self.assertEqual(updated["revisions"]["generation"], 1)
        self.assertEqual(updated["revisions"]["history"], [])
        self.assertEqual(plan([changed], {"1": updated}, now=NOW + 1)["selected"], [])

    def test_legacy_missing_metadata_is_unverified_bounded_not_all_changed(self):
        items = [topic(identity=i) for i in range(1, 13)]
        ledger = {str(i): {"course": COURSE, "raw": "old.pdf", "at": "2026-08-23"}
                  for i in range(1, 13)}
        result = plan(items, ledger)
        self.assertEqual(len(result["selected"]), 4)
        self.assertEqual(len(result["deferred"]), 8)
        self.assertTrue(all(c["reason"] == "migration_unverified" for c in result["selected"]))
        self.assertEqual(result["unchanged"], 0)
        migrated = success(previous=ledger["1"])
        self.assertFalse(migrated["revisions"]["history"][0]["verified"])
        self.assertNotIn("checked_at", migrated["revisions"]["history"][0])

    def test_failed_read_never_advances_success_and_survives_restart(self):
        original = success(when=NOW - 2 * revisions.DAY)
        failed = revisions.record_failure(original, topic(), COURSE, ORG, TERM,
                                          "download_timeout", now=NOW)
        self.assertEqual(failed["revisions"]["checked_at_epoch"],
                         original["revisions"]["checked_at_epoch"])
        self.assertEqual(failed["revisions"]["fingerprint"], original["revisions"]["fingerprint"])
        restarted = json.loads(json.dumps(failed))
        cooling = plan([topic()], {"1": restarted}, now=NOW + 100)
        self.assertEqual(cooling["selected"], [])
        self.assertEqual(cooling["deferred"][0]["deferred_reason"], "retry_cooldown")
        eligible = plan([topic()], {"1": restarted}, now=NOW + 3600)
        self.assertEqual(len(eligible["selected"]), 1)
        recovered = success(previous=restarted, when=NOW + 3600)
        self.assertIsNone(recovered["revisions"]["last_error"])
        self.assertEqual(recovered["revisions"]["failures"], 0)

    def test_new_failed_download_stays_new_after_restart(self):
        failed = revisions.record_failure(None, topic(), COURSE, ORG, TERM, "timeout", now=NOW)
        restarted = json.loads(json.dumps(failed))
        result = plan([topic()], {"1": restarted}, now=NOW + 3600)
        self.assertEqual(result["selected"][0]["reason"], "new")
        self.assertNotIn("checked_at_epoch", restarted["revisions"])

    def test_backlog_drains_across_runs_and_repeated_failures_do_not_starve_others(self):
        items = [topic(identity=i) for i in range(1, 9)]
        ledger = {str(i): {"course": COURSE, "raw": "old.pdf"} for i in range(1, 9)}
        first = plan(items, ledger, max_rechecks=2)
        self.assertEqual([c["item"]["id"] for c in first["selected"]], [1, 2])
        ledger["1"] = revisions.record_failure(ledger["1"], items[0], COURSE, ORG, TERM,
                                               "timeout", now=NOW)
        ledger["2"] = success(items[1], previous=ledger["2"])
        second = plan(items, json.loads(json.dumps(ledger)), max_rechecks=2, now=NOW + 3600)
        self.assertEqual([c["item"]["id"] for c in second["selected"]], [3, 4])

    def test_new_and_changed_precede_periodic_and_count_remains_bounded(self):
        stale = success(topic(1), when=NOW - 2 * revisions.DAY)
        changed = success(topic(2))
        items = [topic(1), topic(2, last_modified="new"), topic(3)]
        result = plan(items, {"1": stale, "2": changed}, max_count=2)
        self.assertEqual({c["reason"] for c in result["selected"]}, {"new", "metadata_changed"})
        self.assertEqual(result["deferred"][0]["reason"], "periodic_recheck")

    def test_ties_interleave_current_courses_and_exclude_undiscovered_courses(self):
        a = [topic(1), topic(2)]
        b = [topic(3), topic(4)]
        courses = {COURSE: ORG, "BUSN5000": "9000"}
        inventory = {COURSE: a, "BUSN5000": b, "OLD1010": [topic(99)]}
        result = revisions.select_candidates(inventory, {}, courses, TERM, now=NOW, max_count=2)
        self.assertEqual({c["course"] for c in result["selected"]}, set(courses))
        self.assertNotIn(99, [c["item"]["id"] for c in result["deferred"]])

    def test_dry_run_plan_and_returned_records_never_mutate_input(self):
        item = topic()
        previous = success()
        original_item, original_previous = copy.deepcopy(item), copy.deepcopy(previous)
        result = plan([item], {"1": previous}, now=NOW + revisions.DAY)
        result["selected"][0]["item"]["title"] = "Changed client copy"
        revisions.record_success(previous, item, COURSE, ORG, TERM,
                                 hashlib.sha256(b"v2").hexdigest(), 2, "new.pdf", now=NOW + 1)
        revisions.record_failure(previous, item, COURSE, ORG, TERM, "failed", now=NOW + 1)
        self.assertEqual(item, original_item)
        self.assertEqual(previous, original_previous)

    def test_query_changes_are_ignored_and_secrets_are_not_retained(self):
        first = topic(url="https://user:password@uga.view.usg.edu/a.pdf?token=secret#secret")
        second = topic(url="https://uga.view.usg.edu/a.pdf?token=rotated")
        self.assertEqual(revisions.metadata_fingerprint(first), revisions.metadata_fingerprint(second))
        record = success(first)
        self.assertEqual(record["revisions"]["metadata"]["url_path"], "/a.pdf")
        self.assertNotIn("secret", json.dumps(record))
        self.assertNotIn("password", json.dumps(record))

    def test_rechecks_obey_bytes_and_estimated_time_budget(self):
        items = [topic(i, size_bytes=20 * revisions.MIB) for i in range(1, 5)]
        fetched = {str(i): {"course": COURSE, "raw": "existing.pdf"} for i in range(1, 5)}
        by_bytes = plan(items, fetched, max_recheck_bytes=25 * revisions.MIB)
        self.assertEqual(len(by_bytes["selected"]), 1)
        self.assertTrue(all(c["deferred_reason"] == "recheck_byte_budget"
                            for c in by_bytes["deferred"]))
        by_time = plan(items, fetched, max_recheck_seconds=9)
        self.assertEqual(len(by_time["selected"]), 1)
        self.assertTrue(all(c["deferred_reason"] == "recheck_time_budget"
                            for c in by_time["deferred"]))

    def test_large_video_is_visible_deferred_and_optional_check_has_separate_budget(self):
        video = topic(ext="mp4", size_bytes=800 * revisions.MIB)
        previous = success(video, when=NOW - 8 * revisions.DAY)
        result = plan([video], {"1": previous})
        self.assertEqual(result["selected"], [])
        self.assertEqual(result["deferred"][0]["deferred_reason"], "large_recheck_deferred")
        self.assertEqual(result["unchanged"], 0)
        opted_in = plan([video], {"1": previous}, max_large_rechecks=1)
        self.assertEqual(len(opted_in["selected"]), 1)
        limited = plan([video], {"1": previous}, max_large_rechecks=1, max_large_bytes=64 * revisions.MIB)
        self.assertEqual(limited["selected"], [])
        current = success(video, when=NOW - 2 * revisions.DAY)
        self.assertEqual(plan([video], {"1": current})["selected"], [])

    def test_scope_change_does_not_reuse_old_success(self):
        previous = success()
        for org, term in (("9000", TERM), (ORG, "spring-2027")):
            result = revisions.select_candidates({COURSE: [topic()]}, {"1": previous},
                                                 {COURSE: org}, term, now=NOW)
            self.assertEqual(result["selected"][0]["reason"], "scope_changed")
        with self.assertRaises(ValueError):
            revisions.select_candidates({COURSE: [topic()]}, {}, {COURSE: ORG}, None)

    def test_query_free_url_alias_and_e_course_alias_are_compatible(self):
        previous = success()
        previous["course"] = "BUSN3040E"
        previous["revisions"]["course"] = "BUSN3040E"
        self.assertEqual(plan([topic()], {"1": previous})["selected"], [])
        self.assertEqual(revisions.metadata({"Url": "/x.html?token=secret", "LastModifiedDate": "x"})[
            "url_path"], "/x.html")

    def test_zip_timestamp_and_compression_changes_are_not_false_revisions(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = [Path(directory) / f"{i}.zip" for i in range(3)]
            for i, path in enumerate(paths):
                info = zipfile.ZipInfo("Syllabus.html", date_time=(2026, 10, 10 + i, 12, 0, 0))
                info.compress_type = zipfile.ZIP_STORED if i == 0 else zipfile.ZIP_DEFLATED
                with zipfile.ZipFile(path, "w") as archive:
                    archive.writestr(info, b"original" if i < 2 else b"changed")
            self.assertNotEqual(paths[0].read_bytes(), paths[1].read_bytes())
            self.assertEqual(revisions.content_digest(paths[0]), revisions.content_digest(paths[1]))
            self.assertNotEqual(revisions.content_digest(paths[0]), revisions.content_digest(paths[2]))

    def test_invalid_content_receipt_does_not_create_success(self):
        with self.assertRaises(ValueError):
            revisions.record_success(None, topic(), COURSE, ORG, TERM, None, 1, "x.pdf", now=NOW)
        with self.assertRaises(ValueError):
            revisions.record_success(None, topic(), COURSE, ORG, TERM, "0" * 64, None, "x.pdf", now=NOW)

    def test_legacy_large_listing_baseline_detects_next_change_without_claiming_bytecheck(self):
        video = topic(ext='mp4', last_modified='2026-10-01T00:00:00Z')
        old = {'1': {'course':COURSE, 'raw':'lecture.mp4', 'at':'2026-09-01'}}
        initial = plan([video],old)
        self.assertEqual(initial['deferred'][0]['reason'],'migration_unverified')
        observed = revisions.observe_inventory({COURSE:[video,topic(2)]},old,{COURSE:ORG},TERM,now=NOW)
        self.assertEqual(set(observed),{'1'})
        self.assertNotIn('checked_at_epoch',observed['1']['revisions'])
        self.assertNotIn('sha256',observed['1']['revisions'])
        self.assertNotIn('revisions',old['1'])
        unchanged = plan([video],observed)
        self.assertEqual(unchanged['deferred'][0]['reason'],'migration_unverified')
        changed = dict(video,last_modified='2026-10-12T00:00:00Z')
        scheduled = plan([changed],json.loads(json.dumps(observed)))
        self.assertEqual(scheduled['selected'][0]['reason'],'metadata_changed')
        # Failed body check preserves unknown byte freshness and listing history.
        failed = revisions.record_failure(observed['1'],changed,COURSE,ORG,TERM,'timeout',now=NOW)
        self.assertNotIn('checked_at_epoch',failed['revisions'])
        self.assertEqual(failed['revisions']['observed'],observed['1']['revisions']['observed'])
        reobserved = revisions.observe_inventory({COURSE:[changed]}, {'1':failed}, {COURSE:ORG},TERM,now=NOW+1)
        persisted = json.loads(json.dumps(reobserved))
        self.assertTrue(persisted['1']['revisions']['pending_metadata_change'])
        self.assertEqual(plan([changed],persisted,now=NOW+3600)['selected'][0]['reason'],'metadata_changed')
        checked = success(changed, previous=persisted['1'], when=NOW+3600)
        self.assertNotIn('pending_metadata_change',checked['revisions'])
        self.assertEqual(plan([changed],{'1':checked},now=NOW+3600)['selected'],[])


if __name__ == "__main__":
    unittest.main()
