"""Fault/restart tests use fake source bytes and no browser or network access."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile
from unittest.mock import Mock

source = Path(__file__).resolve().parents[1] / "bin/material_delivery.py"
spec = importlib.util.spec_from_file_location("material_delivery", source)
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


class SimulatedCrash(BaseException):
    pass


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.queue_path = self.root / ".material-delivery.json"
        self.q = delivery.DeliveryQueue(self.queue_path, self.root)
        self.raw = self.put("BUSN3040/raw/source.pdf", b"FAKE source revision one")
        self.text = self.put("BUSN3040/text/source.txt", b"FAKE extracted source")
        self.remote = {}
        self.calls = {"extract": [], "drive": [], "gpt": [], "publish": [], "readback": []}
        self.enqueue()

    def put(self, name, body):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        return path

    def enqueue(self, **kwargs):
        args = dict(course="BUSN3040", topic_id="123", raw_path=self.raw,
                    title="Fake lesson", unit="Fake unit", now=100)
        args.update(kwargs)
        return self.q.enqueue(**args)

    def extract(self, e):
        self.calls["extract"].append(e)
        return {"ok": True, "text_path": str(self.text)}

    def drive(self, e):
        self.calls["drive"].append(e)
        return {"ok": True, "drive_rel": "BUSN 3040E/Slides/source.pdf",
                "source_sha256": e["source_sha256"]}

    def gpt(self, e):
        self.calls["gpt"].append(e)
        return {"ok": True}

    def publish(self, e):
        self.calls["publish"].append(e)
        self.remote[e["revision_id"]] = e["text_sha256"]
        return {"ok": True, "text_sha256": e["text_sha256"]}

    def readback(self, e):
        self.calls["readback"].append(e)
        value = self.remote.get(e["revision_id"])
        return {"ok": True, "text_sha256": value} if value else {"ok": False, "reason": "not_found"}

    def run_queue(self, **kwargs):
        args = dict(extract=self.extract, file_drive=self.drive, queue_gpt=self.gpt,
                    publish=self.publish, readback=self.readback, now=100)
        args.update(kwargs)
        return self.q.run(**args)

    def entry(self):
        return self.q.entries()["BUSN3040:123"]

    def test_local_stage_allowlist_keeps_remote_attempts_and_receipts_untouched(self):
        before = self.entry()
        result = self.run_queue(stages={'extraction', 'gpt_queue'})
        self.assertEqual(result['operations'], 2)
        self.assertEqual(result['pending'], 1)
        for name in ('drive', 'library'):
            self.assertEqual(self.entry()['stages'][name], before['stages'][name])
        for name in ('drive', 'publish', 'readback'):
            self.assertEqual(self.calls[name], [])
        self.assertEqual(self.run_queue(stages={'extraction', 'gpt_queue'})['operations'], 0)
        self.assertEqual(self.run_queue()['complete'], 1)

    def test_local_stage_allowlist_does_not_starve_unextracted_later_records(self):
        self.run_queue(stages={'extraction', 'gpt_queue'})
        for identity in range(2, 9): self.enqueue(topic_id=str(identity))
        result = self.run_queue(stages={'extraction', 'gpt_queue'}, max_records=2, max_operations=4)
        self.assertEqual(result['selected'], 2)
        self.assertEqual(result['operations'], 4)
        self.assertEqual(len(self.calls['extract']), 3)

    def test_invalid_stage_allowlist_rejected_before_any_write(self):
        before = self.queue_path.read_bytes()
        for stages in (set(), {'unknown'}):
            with self.assertRaises(ValueError): self.run_queue(stages=stages)
        self.assertEqual(self.queue_path.read_bytes(), before)

    def test_explicit_retry_preserves_failure_and_identity(self):
        self.run_queue(file_drive=lambda _: {"ok": False, "reason": "drive_unconfirmed"})
        before = self.entry()
        self.assertFalse(self.q.request_retry("BUSN3040", "123", "f" * 64, now=101))
        self.assertEqual(self.entry(), before)
        self.assertTrue(self.q.request_retry("BUSN3040", "123", before["revision_id"], now=101))
        after = self.entry()
        expected = json.loads(json.dumps(before))
        expected["stages"]["drive"]["next_attempt"] = 101
        self.assertEqual(after, expected)
        self.assertEqual(self.run_queue(now=101)["complete"], 1)

    def test_explicit_retry_never_reopens_complete_record(self):
        self.run_queue()
        before = self.entry()
        self.assertFalse(self.q.request_retry("BUSN3040", "123", before["revision_id"], now=101))
        self.assertEqual(self.entry(), before)

    def test_success_requires_four_independent_acknowledgements(self):
        result = self.run_queue()
        self.assertEqual(result["complete"], 1)
        self.assertEqual(result["operations"], 6)
        self.assertEqual({s["status"] for s in self.entry()["stages"].values()}, {"done"})
        self.assertEqual(len(self.calls["gpt"]), 1)
        self.assertEqual(len(self.calls["publish"]), 1)
        self.assertEqual(self.run_queue()["operations"], 0)
        # Source never moved, deleted or rewritten by the queue.
        self.assertEqual(self.raw.read_bytes(), b"FAKE source revision one")

    def test_extraction_failure_retries_without_new_download_and_drive_still_files(self):
        failure = Mock(side_effect=RuntimeError("private secret response body"))
        first = self.run_queue(extract=failure)
        self.assertEqual(first["pending"], 1)
        self.assertEqual(self.entry()["stages"]["drive"]["status"], "done")
        self.assertFalse(self.calls["gpt"])
        self.assertEqual(self.run_queue(now=101)["operations"], 0)
        self.q = delivery.DeliveryQueue(self.queue_path, self.root)
        self.assertEqual(self.run_queue(now=400)["complete"], 1)
        self.assertEqual(len(self.calls["drive"]), 1)
        self.assertNotIn("secret", self.queue_path.read_text())
        self.assertNotIn("response body", self.queue_path.read_text())

    def test_failed_drive_cannot_erase_successful_extraction_or_gpt_handoff(self):
        first = self.run_queue(file_drive=lambda e: {"ok": False})
        self.assertEqual(first["pending"], 1)
        self.assertEqual(self.entry()["stages"]["gpt_queue"]["status"], "done")
        self.assertFalse(self.calls["publish"])
        self.assertEqual(self.run_queue(now=400)["complete"], 1)
        self.assertEqual(len(self.calls["extract"]), 1)
        self.assertEqual(len(self.calls["gpt"]), 1)

    def test_drive_hash_receipt_must_match_original(self):
        self.run_queue(file_drive=lambda e: {"ok": True, "drive_rel": "course/file", "source_sha256": "0" * 64})
        self.assertEqual(self.entry()["stages"]["drive"]["reason"], "drive_receipt_invalid")
        self.assertFalse(self.calls["publish"])

    def test_preflight_unavailable_does_not_blindly_publish(self):
        self.run_queue(readback=lambda e: {"ok": False, "reason": "secret bearer token"})
        self.assertFalse(self.calls["publish"])
        self.assertEqual(self.entry()["stages"]["library"]["reason"], "readback_unavailable")
        self.assertNotIn("bearer", self.queue_path.read_text())
        self.assertEqual(self.run_queue(now=400)["complete"], 1)

    def test_existing_matching_remote_text_avoids_publish(self):
        self.run_queue(readback=lambda e: {"ok": True, "text_sha256": e["text_sha256"]})
        self.assertFalse(self.calls["publish"])
        self.assertEqual(self.entry()["status"], "complete")

    def test_eventual_readback_keeps_acknowledgement_and_does_not_repost(self):
        self.run_queue(readback=lambda e: {"ok": False, "reason": "not_found"})
        first = self.entry()["stages"]["library"]
        self.assertTrue(first["published"])
        self.assertEqual(first["status"], "pending")
        self.q = delivery.DeliveryQueue(self.queue_path, self.root)
        self.run_queue(now=400, readback=lambda e: {"ok": False, "reason": "not_found"})
        self.assertEqual(len(self.calls["publish"]), 1)
        self.assertEqual(self.run_queue(now=1000)["complete"], 1)
        self.assertEqual(len(self.calls["publish"]), 1)

    def test_crash_after_remote_write_recovers_by_readback_without_duplicate(self):
        def crash(e):
            self.publish(e)
            raise SimulatedCrash()
        with self.assertRaises(SimulatedCrash):
            self.run_queue(publish=crash)
        before = self.entry()["stages"]["library"]
        self.assertEqual(before["status"], "running")
        self.q = delivery.DeliveryQueue(self.queue_path, self.root)
        self.assertEqual(self.run_queue(now=101)["complete"], 1)
        self.assertEqual(len(self.calls["publish"]), 1)
        self.assertEqual(before["operation_id"], self.calls["readback"][-1]["operation_id"])

    def test_lost_write_response_retries_same_logical_packet_after_missing_readback(self):
        def uncertain(e):
            self.calls["publish"].append(e)
            raise RuntimeError("network failure")
        self.run_queue(publish=uncertain)
        self.assertEqual(self.entry()["stages"]["library"]["reason"], "publish_unconfirmed")
        self.run_queue(now=400)
        first, second = self.calls["publish"]
        for field in ("operation_id", "revision_id", "source_sha256", "text_sha256", "drive_rel", "title"):
            self.assertEqual(first[field], second[field])
        self.assertEqual(self.entry()["status"], "complete")

    def test_bad_acknowledgement_does_not_establish_delivery(self):
        self.run_queue(publish=lambda e: {"ok": True, "text_sha256": "0" * 64})
        stage = self.entry()["stages"]["library"]
        self.assertEqual(stage["status"], "pending")
        self.assertNotIn("published", stage)
        self.assertEqual(stage["reason"], "publish_unconfirmed")

    def test_changed_revision_supersedes_pending_without_removing_original(self):
        self.run_queue(extract=lambda e: {"ok": False})
        previous = self.entry()
        second_raw = self.put("BUSN3040/raw/source_v2.pdf", b"FAKE revised source")
        self.enqueue(raw_path=second_raw, now=200)
        current = self.entry()
        self.assertNotEqual(current["revision_id"], previous["revision_id"])
        self.assertEqual(current["superseded"][0]["revision_id"], previous["revision_id"])
        self.assertTrue(self.raw.exists())
        self.assertEqual(self.run_queue(now=200)["complete"], 1)
        self.assertEqual(self.calls["publish"][0]["raw_path"], str(second_raw.resolve()))

    def test_same_bytes_metadata_change_resets_delivery_but_exact_duplicate_does_not(self):
        self.run_queue()
        first = self.entry()
        self.enqueue(now=200)
        self.assertEqual(self.entry(), first)
        self.enqueue(title="Renamed fake lesson", now=201)
        current = self.entry()
        self.assertNotEqual(first["revision_id"], current["revision_id"])
        self.assertEqual({s["status"] for s in current["stages"].values()}, {"pending"})

    def test_original_bytes_mutated_in_place_cannot_be_published_under_old_revision(self):
        self.raw.write_bytes(b"different unexpected bytes")
        self.run_queue()
        self.assertEqual(sum(map(len, self.calls.values())), 0)
        self.assertEqual(self.entry()["stages"]["extraction"]["reason"], "raw_unavailable_or_changed")

    def test_overwritten_text_is_reextracted_before_retry(self):
        self.run_queue(max_operations=3)
        old_hash = self.entry()["text_sha256"]
        self.text.write_bytes(b"fake overwritten text")
        def reextract(e):
            self.text.write_bytes(b"freshly recovered proper extraction")
            return self.extract(e)
        self.run_queue(extract=reextract, now=101)
        self.assertNotEqual(self.entry()["text_sha256"], old_hash)
        self.assertEqual(len(self.calls["extract"]), 2)
        self.assertEqual(len(self.calls["gpt"]), 2)
        self.assertEqual(self.entry()["status"], "complete")

    def test_bound_on_records_operations_and_scope(self):
        other = self.put("MGMT4280/raw/other.pdf", b"FAKE other class")
        self.enqueue(course="MGMT4280", raw_path=other, now=1)
        result = self.run_queue(only_courses={"BUSN3040"}, max_records=1, max_operations=2)
        self.assertLessEqual(result["operations"], 2)
        self.assertLessEqual(result["selected"], 1)
        self.assertEqual(result["records"], 1)
        self.assertEqual(self.q.entries()["MGMT4280:123"]["stages"]["drive"]["attempts"], 0)
        self.assertEqual(self.run_queue(only_courses={"BUSN3040"}, now=101)["complete"], 1)

    def test_capped_backoff_does_not_permanently_abandon_failed_stage(self):
        now = 100
        for _ in range(20):
            self.run_queue(extract=lambda e: {"ok": False}, now=now)
            stage = self.entry()["stages"]["extraction"]
            self.assertLessEqual(stage["next_attempt"] - now, delivery.RETRY_MAX)
            now = stage["next_attempt"]
        self.assertEqual(self.run_queue(now=now)["complete"], 1)

    def test_owner_only_state_and_no_source_content_in_ledger(self):
        self.run_queue()
        self.assertEqual(stat.S_IMODE(self.queue_path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(Path(str(self.queue_path) + ".lock").stat().st_mode), 0o600)
        self.assertNotIn("FAKE extracted source", self.queue_path.read_text())
        self.assertNotIn("FAKE source revision one", self.queue_path.read_text())
        self.assertEqual(list(self.root.glob(".material-delivery.json.*")), [Path(str(self.queue_path) + ".lock")])

    def test_corrupt_existing_ledger_fails_closed_and_preserves_original(self):
        self.queue_path.write_text('{"version":1,"entries":')
        original = self.queue_path.read_bytes()
        with self.assertRaisesRegex(delivery.DeliveryStateError, "invalid_delivery_state"):
            self.run_queue()
        self.assertEqual(self.queue_path.read_bytes(), original)
        self.assertEqual(sum(map(len, self.calls.values())), 0)

    def test_cross_course_path_rejected(self):
        other = self.put("MGMT4280/raw/other.pdf", b"FAKE other class")
        with self.assertRaisesRegex(ValueError, "invalid_material_path"):
            self.enqueue(raw_path=other)
        self.run_queue(extract=lambda e: {"ok": True, "text_path": str(other)})
        self.assertEqual(self.entry()["stages"]["extraction"]["reason"], "extraction_receipt_invalid")

    def test_crash_after_final_stage_status_is_reconciled_without_effect(self):
        self.run_queue()
        state = json.loads(self.queue_path.read_text())
        state["entries"]["BUSN3040:123"]["status"] = "pending"
        self.queue_path.write_text(json.dumps(state))
        result = self.run_queue()
        self.assertEqual(result["complete"], 1)
        self.assertEqual(result["operations"], 0)

    def test_legacy_seed_is_scoped_bounded_existing_manifest_and_restart_safe(self):
        fetched, items = {}, []
        for topic in range(5):
            raw = self.put(f"BUSN3040/raw/legacy{topic}.pdf", f"FAKE {topic}".encode())
            fetched[str(topic)] = {"course": "BUSN3040", "raw": raw.name, "title": "Fake legacy", "text": None}
            items.append({"id": str(topic), "title": "Fake legacy", "unit": "Fake unit"})
        fetched["removed"] = {"course": "BUSN3040", "raw": "removed.pdf"}
        fetched["999"] = {"course": "MGMT4280", "raw": "other.pdf"}
        manifest = {"courses": {"BUSN3040": {"items": items}}}
        with self.assertRaisesRegex(ValueError, "legacy_course_scope_required"):
            self.q.seed_legacy(fetched, manifest, None)
        self.assertEqual(self.q.seed_legacy(fetched, manifest, {"BUSN3040"}, limit=2)["seeded"], 2)
        self.q = delivery.DeliveryQueue(self.queue_path, self.root)
        self.assertEqual(self.q.seed_legacy(fetched, manifest, {"BUSN3040"}, limit=2)["seeded"], 2)
        self.assertEqual(self.q.seed_legacy(fetched, manifest, {"BUSN3040"}, limit=2)["seeded"], 1)
        self.assertNotIn("MGMT4280:999", self.q.entries())
        self.assertNotIn("BUSN3040:removed", self.q.entries())
        self.assertEqual(sum(map(len, self.calls.values())), 0)

    def archive_source(self, members, compression=zipfile.ZIP_STORED, title="Fake video"):
        archive_path = self.root / "BUSN3040/raw/video.zip"
        with zipfile.ZipFile(archive_path, "w", compression=compression) as archive:
            for name, body in members:
                archive.writestr(name, body)
        self.enqueue(raw_path=archive_path, title=title, now=100)
        return archive_path

    def video_receipt(self, record, body=b"FAKE original video", member="Lectures/Lesson.mp4"):
        return {"ok": True, "drive_rel": "BUSN 3040E/03 - Lecture Videos/Lesson.mp4",
                "source_sha256": record["source_sha256"], "drive_representation": "archive_video",
                "drive_sha256": hashlib.sha256(body).hexdigest(), "archive_member": member}

    def test_video_member_receipt_preserves_archive_and_independent_hash_across_restart(self):
        raw = self.archive_source([("Lectures/Lesson.mp4", b"FAKE original video")])
        archive_hash = delivery.sha256_file(raw)
        first = self.run_queue(file_drive=self.video_receipt, max_operations=2)
        self.assertEqual(first["pending"], 1)
        record = self.entry()
        self.assertEqual(record["source_sha256"], archive_hash)
        self.assertNotEqual(record["drive_sha256"], archive_hash)
        self.assertEqual(record["archive_member"], "Lectures/Lesson.mp4")
        self.assertEqual(record["drive_representation"], "archive_video")
        self.q = delivery.DeliveryQueue(self.queue_path, self.root)
        forbidden = Mock(side_effect=AssertionError("verified Drive should not refile"))
        self.assertEqual(self.run_queue(file_drive=forbidden, now=101)["complete"], 1)
        forbidden.assert_not_called()
        self.assertEqual(delivery.sha256_file(raw), archive_hash)
        self.assertEqual(self.calls["publish"][0]["drive_sha256"], record["drive_sha256"])

    def test_new_original_revision_clears_previous_archive_member_provenance(self):
        self.archive_source([("Lectures/Lesson.mp4", b"FAKE original video")])
        self.assertEqual(self.run_queue(file_drive=self.video_receipt)["complete"], 1)
        archived_revision = self.entry()["revision_id"]
        self.enqueue(raw_path=self.raw, title="Replaced with original PDF", now=200)
        revised = self.entry()
        self.assertNotEqual(revised["revision_id"], archived_revision)
        self.assertNotIn("archive_member", revised)
        self.assertNotIn("drive_representation", revised)
        self.assertNotIn("drive_sha256", revised)
        self.assertEqual(self.run_queue(now=200)["complete"], 1)
        self.assertEqual(self.entry()["drive_representation"], "original")
        self.assertEqual(self.entry()["drive_sha256"], self.entry()["source_sha256"])
        self.assertNotIn("archive_member", self.entry())

    def test_archive_receipt_cannot_equate_archive_bytes_or_another_member_to_video(self):
        for index, field in enumerate(("archive_hash", "wrong_member", "wrong_video_hash")):
            self.archive_source([("Lectures/Lesson.mp4", b"FAKE original video")], title="Fake " + field)
            def invalid(record):
                result = self.video_receipt(record)
                if field == "archive_hash": result["drive_sha256"] = record["source_sha256"]
                if field == "wrong_member": result["archive_member"] = "Other.mp4"
                if field == "wrong_video_hash": result["drive_sha256"] = "0" * 64
                return result
            self.run_queue(file_drive=invalid, now=100 + index)
            self.assertEqual(self.entry()["stages"]["drive"]["reason"], "drive_receipt_invalid")
            self.assertEqual(self.entry()["stages"]["library"]["status"], "pending")
        self.assertFalse(self.calls["publish"])

    def test_unsafe_ambiguous_or_bomb_archive_cannot_receive_drive_acknowledgement(self):
        cases = [
            [("../Lesson.mp4", b"FAKE original video")],
            [("Lectures/Lesson.mp4", b"FAKE original video"), ("Other.mp4", b"another video")],
            [("Lectures/Lesson.mp4", b"x" * 100000)],
        ]
        for index, members in enumerate(cases):
            with self.subTest(index=index):
                self.archive_source(members, zipfile.ZIP_DEFLATED, title="Fake unsafe " + str(index))
                self.run_queue(file_drive=lambda e: self.video_receipt(e, members[0][1], members[0][0]), now=100 + index)
                self.assertEqual(self.entry()["stages"]["drive"]["reason"], "drive_receipt_invalid")
        self.assertFalse(self.calls["publish"])

    def test_original_receipt_does_not_accept_unproven_different_drive_hash(self):
        self.run_queue(file_drive=lambda e: {**self.drive(e), "drive_sha256": "0" * 64})
        self.assertEqual(self.entry()["stages"]["drive"]["reason"], "drive_receipt_invalid")

    def test_selected_safe_failure_codes_survive_without_exception_or_content_leak(self):
        for index, reason in enumerate(("source_template", "unsafe_archive", "transcription_deferred")):
            self.enqueue(title="Fake reason " + str(index))
            self.run_queue(extract=lambda e: {"ok": False, "reason": reason}, now=100 + index)
            self.assertEqual(self.entry()["stages"]["extraction"]["reason"], reason)
        self.enqueue(title="Fake malicious reason")
        self.run_queue(extract=lambda e: {"ok": False, "reason": "source_template secret-token"})
        self.assertEqual(self.entry()["stages"]["extraction"]["reason"], "extraction_unconfirmed")
        self.assertNotIn("secret-token", self.queue_path.read_text())

    def test_missing_extraction_after_handoff_is_reopened_for_pending_gpt(self):
        self.run_queue()
        before = self.entry()
        self.text.unlink()
        self.assertTrue(self.q.invalidate_text("BUSN3040", "123", before["revision_id"], now=400))
        after = self.entry()
        self.assertEqual(after["stages"]["drive"], before["stages"]["drive"])
        self.assertEqual(after["status"], "pending")
        def reextract(record):
            self.text.write_bytes(b"FAKE extracted source")
            return self.extract(record)
        self.assertEqual(self.run_queue(extract=reextract, now=400)["complete"], 1)
        self.assertEqual(len(self.calls["gpt"]), 2)
        self.assertEqual(len(self.calls["drive"]), 1)

    def test_extraction_invalidation_requires_missing_bytes_and_current_revision(self):
        self.run_queue()
        first = self.entry()
        self.assertFalse(self.q.invalidate_text("BUSN3040", "123", first["revision_id"]))
        self.enqueue(title="New fake title", now=200)
        second = self.entry()
        self.text.unlink()
        self.assertFalse(self.q.invalidate_text("BUSN3040", "123", first["revision_id"]))
        self.assertEqual(self.entry(), second)
        self.assertFalse(self.q.invalidate_text("BUSN3040", "absent", first["revision_id"]))

    def test_changed_extraction_clears_old_library_acknowledgement(self):
        self.run_queue()
        before = self.entry()
        self.text.write_bytes(b"FAKE changed local bytes")
        self.assertTrue(self.q.invalidate_text("BUSN3040", "123", before["revision_id"]))
        self.assertNotIn("published", self.entry()["stages"]["library"])
        self.assertNotIn("text_sha256", self.entry())

    def test_quality_invalidation_retains_drive_and_source_but_reopens_text_stages(self):
        self.run_queue()
        before = self.entry()
        self.assertTrue(self.q.invalidate_quality('BUSN3040', '123', before['revision_id'],
            before['text_sha256'], 'transcript_repetitive', now=400))
        after = self.entry()
        self.assertEqual(after['source_sha256'], before['source_sha256'])
        self.assertEqual(after['stages']['drive'], before['stages']['drive'])
        self.assertEqual(after['quality_invalidated']['text_sha256'], before['text_sha256'])
        self.assertEqual(after['stages']['extraction']['reason'], 'transcript_repetitive')
        self.assertEqual({after['stages'][k]['status'] for k in ('extraction', 'gpt_queue', 'library')}, {'pending'})

    def test_stale_quality_observation_cannot_reject_new_or_changed_bytes(self):
        self.run_queue()
        before = self.entry()
        self.text.write_bytes(b'FAKE corrected visual notes')
        self.assertFalse(self.q.invalidate_quality('BUSN3040', '123', before['revision_id'],
            before['text_sha256'], 'transcript_repetitive'))
        self.text.write_bytes(b'FAKE extracted source')
        self.enqueue(title='New source revision', now=200)
        self.assertFalse(self.q.invalidate_quality('BUSN3040', '123', before['revision_id'],
            before['text_sha256'], 'transcript_repetitive'))
        with self.assertRaises(ValueError):
            self.q.invalidate_quality('BUSN3040', '123', before['revision_id'],
                before['text_sha256'], 'private raw text')

    def test_read_only_snapshot_does_not_create_directory_or_lock(self):
        path = self.root / "untouched" / ".material-delivery.json"
        q = delivery.DeliveryQueue(path, self.root)
        self.assertEqual(q.entries(read_only=True), {})
        self.assertEqual(q.summary(read_only=True)["records"], 0)
        self.assertFalse(path.parent.exists())

    def test_revision_keeps_prior_locators_for_exact_supersession(self):
        self.run_queue()
        previous = self.entry()
        self.enqueue(title="New fake title", now=200)
        revised = self.entry()
        self.assertEqual(revised["previous_drive_rel"], previous["drive_rel"])
        self.assertEqual(revised["previous_text_path"], previous["text_path"])

    def test_legacy_seed_prioritizes_missing_text_and_preserves_drive_locator(self):
        fetched = {
            "complete": {"course": "BUSN3040", "raw": self.raw.name, "text": self.text.name},
            "missing": {"course": "BUSN3040", "raw": self.raw.name, "text": None,
                        "drive_rel": "BUSN 3040E/Slides/source.pdf"}}
        manifest = {"courses": {"BUSN3040": {"items": [
            {"id": topic, "title": "Fake " + topic} for topic in fetched]}}}
        self.q.seed_legacy(fetched, manifest, {"BUSN3040"}, limit=1)
        records = self.q.entries()
        self.assertNotIn("BUSN3040:complete", records)
        self.assertEqual(records["BUSN3040:missing"]["previous_drive_rel"],
                         "BUSN 3040E/Slides/source.pdf")

    def test_legacy_existing_text_never_assumes_remote_publication(self):
        other_raw = self.put("BUSN3040/raw/legacy.pdf", b"FAKE legacy")
        fetched = {"456": {"course": "BUSN3040", "raw": other_raw.name, "text": self.text.name, "title": "Fake legacy"}}
        manifest = {"courses": {"BUSN3040": {"items": [{"id": "456", "title": "Fake legacy"}]}}}
        self.q.seed_legacy(fetched, manifest, {"BUSN3040"}, limit=1)
        record = self.q.entries()["BUSN3040:456"]
        self.assertEqual(record["stages"]["extraction"]["status"], "done")
        self.assertEqual(record["stages"]["library"]["status"], "pending")
        self.assertEqual(record["stages"]["gpt_queue"]["status"], "pending")


if __name__ == "__main__":
    unittest.main()
