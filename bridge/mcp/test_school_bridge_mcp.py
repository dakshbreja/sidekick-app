#!/usr/bin/env python3
"""Offline tests for the MCP response contract. No network, no .env, no bridge.

Every test here fails against the adapter as it stood on 2026-09-04, where the
status projection was a key allowlist applied after the fact and the serialized
JSON was cut at 20,000 characters:

  - an unreachable bridge projected to `{}` with isError false
  - warnings, feed health, changes and ambiguity were dropped on the floor
  - a long response was not parseable JSON at all, and its tail was simply gone

Run:  python3 mcp/test_school_bridge_mcp.py
"""
import json
import os
import sys
import unittest
from urllib.parse import urlsplit, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import school_bridge_mcp as mcp  # noqa: E402


def call(tool, args=None):
    """One tools/call round trip, decoded the way a client would decode it."""
    resp = mcp.handle({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                       "params": {"name": tool, "arguments": args or {}}})
    text = resp["result"]["content"][0]["text"]
    # Parsing here is the point: a cut response fails at exactly this line.
    return resp["result"]["isError"], json.loads(text), text


class BridgeStub:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def __call__(self, path, payload=None, method="POST"):
        self.calls.append({"path": path, "payload": payload, "method": method})
        return self.response


def status_fixture(**overrides):
    """The shape /status actually returns, small enough to fit whole."""
    base = {
        "generated_at": "2026-09-04T14:00:00.000Z",
        "local_time": "Friday, September 4, 2026 at 10:00 AM",
        "timezone": "America/New_York",
        "term": "Fall 2026",
        "course": {"code": "BUSN5000", "label": "BUSN 5000", "ai_policy": "encouraged"},
        "briefing": "BUSN 5000 — Friday, September 4.",
        "actionable": {
            "scope": "BUSN5000",
            "counts": {"outstanding": 1, "overdue": 1, "awaiting_verification": 1},
            "outstanding": [{"title": "Homework 3", "bucket": "overdue"}],
            "awaiting_verification": [{"title": "Quiz 1", "submission_verification": "reported"}],
            "coverage": {"feeds_ok": 1, "feeds_total": 2, "feeds_failed": ["personal"]},
        },
        "overdue": [{"title": "Homework 3", "days_late": 2}],
        "due_today": [],
        "due_this_week": [],
        "upcoming": [],
        "other_courses_this_week": [],
        "classes_today": [{"course": "BUSN 5000", "when": "Tue 11:35 AM"}],
        "classes_tomorrow": [],
        "optional_this_week": [],
        "optional_ongoing": [],
        "optional_not_tracked": "LAND 2510E syllabus not transcribed",
        "progress": [{"item": "Quiz 1", "status": "done", "verification": "reported"}],
        "progress_summary": {"done": 1, "awaiting_verification": 1, "verified": 0},
        "completion_ambiguous": [{"reported": "quiz", "matches": ["Quiz 1", "Quiz 2"]}],
        "completion_unmatched": [],
        "recent_changes": [{"type": "moved", "title": "Exam 1", "from": "Sep 24", "to": "Sep 29"}],
        "feed_health": [{"source": "elc", "ok": True}, {"source": "personal", "ok": False, "error": "HTTP 500"}],
        "data_warning": "1 of 2 calendar feeds failed to load.",
        "class_notes": [{"date": "2026-09-02", "text": "R Markdown walkthrough"}],
        "claude_note": None,
        # Addressed to the ChatGPT GPTs, not to this client.
        "commands": [{"name": "/due"}],
        "call_policy": "once per conversation",
        "command_help": "…",
        "all_classes_today": [],
    }
    base.update(overrides)
    return base


class UpstreamFailures(unittest.TestCase):
    """An unavailable bridge must never look like a clear semester."""

    def tearDown(self):
        mcp.call_bridge = self._original

    def stub(self, response):
        self._original = mcp.call_bridge
        mcp.call_bridge = BridgeStub(response)

    def test_network_failure_stays_an_error(self):
        self.stub({"error": "request_failed", "detail": "Connection refused",
                   "bridge_reachable": False})
        is_error, out, _ = call("get_school_status")
        self.assertTrue(is_error, "an unreachable bridge must be reported as an error")
        self.assertEqual(out["error"], "request_failed")
        self.assertIn("Connection refused", out["detail"])
        self.assertFalse(out["bridge_reachable"])

    def test_http_error_stays_an_error_with_its_detail(self):
        self.stub({"error": "http_502", "detail": "Bad gateway", "bridge_reachable": True})
        is_error, out, _ = call("get_school_status")
        self.assertTrue(is_error)
        self.assertEqual(out["error"], "http_502")
        self.assertEqual(out["detail"], "Bad gateway")

    def test_an_empty_but_valid_status_is_not_an_error(self):
        quiet = status_fixture(overdue=[], due_today=[], due_this_week=[],
                               completion_ambiguous=[], recent_changes=[], data_warning=None)
        self.stub(quiet)
        is_error, out, _ = call("get_school_status")
        self.assertFalse(is_error, "a genuinely quiet day is a successful response")
        self.assertNotIn("error", out)
        # And it is still distinguishable from a failure: freshness is present.
        self.assertEqual(out["generated_at"], "2026-09-04T14:00:00.000Z")

    def test_a_non_json_body_is_its_own_error(self):
        self.stub({"error": "invalid_json_from_bridge",
                   "detail": "Expecting value | <html>Cloudflare</html>",
                   "bridge_reachable": True})
        is_error, out, _ = call("get_school_status")
        self.assertTrue(is_error)
        self.assertEqual(out["error"], "invalid_json_from_bridge")


class ContextPreserved(unittest.TestCase):
    """Every client must get the same account of what the system knows."""

    def setUp(self):
        self._original = mcp.call_bridge
        mcp.call_bridge = BridgeStub(status_fixture())
        self.is_error, self.out, _ = call("get_school_status")

    def tearDown(self):
        mcp.call_bridge = self._original

    def test_freshness_warnings_changes_and_ambiguity_survive(self):
        for key in ("generated_at", "local_time", "timezone", "data_warning",
                    "feed_health", "recent_changes", "completion_ambiguous",
                    "actionable", "classes_today", "optional_not_tracked",
                    "progress_summary", "course"):
            self.assertIn(key, self.out, "%s must survive the adapter" % key)

    def test_the_failed_feed_is_visible_as_a_failure(self):
        self.assertEqual(self.out["data_warning"], "1 of 2 calendar feeds failed to load.")
        self.assertIn("personal", self.out["actionable"]["coverage"]["feeds_failed"])

    def test_course_ai_policy_travels(self):
        self.assertEqual(self.out["course"]["ai_policy"], "encouraged")

    def test_the_gpt_slash_command_directory_is_dropped(self):
        for key in ("commands", "call_policy", "command_help"):
            self.assertNotIn(key, self.out)

    def test_a_response_that_fits_says_so(self):
        self.assertTrue(self.out["response_completeness"]["complete"])
        self.assertTrue(self.out["response_completeness"]["urgent_work_complete"])
        self.assertEqual(self.out["response_completeness"]["sections_trimmed"], {})


class SizeHandling(unittest.TestCase):
    """Over the limit, the response shrinks by whole sections and says what it dropped."""

    def setUp(self):
        self._original = mcp.call_bridge
        big = status_fixture(
            class_notes=[{"date": "2026-09-%02d" % (d % 28 + 1), "text": "lecture " + "x" * 400}
                         for d in range(40)],
            progress=[{"item": "Item %d" % i, "status": "done", "note": "y" * 300}
                      for i in range(60)],
            upcoming=[{"title": "Upcoming %d" % i, "detail": "z" * 300} for i in range(40)],
        )
        self.big = big
        mcp.call_bridge = BridgeStub(big)
        self.is_error, self.out, self.text = call("get_school_status")

    def tearDown(self):
        mcp.call_bridge = self._original

    def test_the_response_is_still_valid_json(self):
        # The old adapter returned json.dumps(...)[:20000] here, which did not parse.
        json.loads(self.text)
        self.assertFalse(self.is_error)

    def test_it_is_explicitly_incomplete_rather_than_quietly_short(self):
        meta = self.out["response_completeness"]
        self.assertFalse(meta["complete"])
        self.assertTrue(meta["sections_trimmed"], "a trimmed response must name what it trimmed")
        for section, info in meta["sections_trimmed"].items():
            self.assertLess(info["included"], info["total"])
            self.assertEqual(info["retrieve_with"]["tool"], "get_status_section")

    def test_urgent_work_and_warnings_are_never_dropped_to_fit(self):
        meta = self.out["response_completeness"]
        self.assertTrue(meta["urgent_work_complete"])
        self.assertEqual(self.out["overdue"], self.big["overdue"])
        self.assertEqual(self.out["data_warning"], self.big["data_warning"])
        self.assertEqual(self.out["completion_ambiguous"], self.big["completion_ambiguous"])
        self.assertIn("actionable", self.out)

    def test_the_continuation_actually_returns_the_missing_records(self):
        meta = self.out["response_completeness"]
        token = meta["retrieval_token"]
        section = sorted(meta["sections_trimmed"])[0]

        is_error, page, _ = call("get_status_section",
                                 {"token": token, "section": section, "offset": 0, "limit": 25})
        self.assertFalse(is_error)
        self.assertEqual(page["total"], len(self.big[section]))
        self.assertEqual(page["items"], self.big[section][:25])

        # And paging walks the whole section rather than stopping at one page.
        seen, offset = [], 0
        while offset is not None:
            _, page, _ = call("get_status_section",
                              {"token": token, "section": section, "offset": offset, "limit": 25})
            seen.extend(page["items"])
            offset = page["next_offset"]
        self.assertEqual(seen, self.big[section])

    def test_an_expired_or_wrong_token_is_an_error_not_an_empty_page(self):
        is_error, out, _ = call("get_status_section", {"token": "status-nope", "section": "progress"})
        self.assertTrue(is_error)
        self.assertEqual(out["error"], "unknown_retrieval_token")

    def test_an_unknown_section_lists_what_is_available(self):
        token = self.out["response_completeness"]["retrieval_token"]
        is_error, out, _ = call("get_status_section", {"token": token, "section": "nope"})
        self.assertTrue(is_error)
        self.assertIn("overdue", out["available"])


class OversizedButComplete(unittest.TestCase):
    """Too big and missing something are different claims."""

    def setUp(self):
        self._original = mcp.call_bridge
        # One enormous record. Nothing can be trimmed away: no list is long enough
        # to have anything dropped, yet the response clears the size target.
        self.fixture = status_fixture(claude_note={"text": "q" * 40000})
        mcp.call_bridge = BridgeStub(self.fixture)
        self.is_error, self.out, self.text = call("get_school_status")

    def tearDown(self):
        mcp.call_bridge = self._original

    def test_nothing_omitted_means_complete_even_when_oversized(self):
        meta = self.out["response_completeness"]
        self.assertEqual(meta["sections_trimmed"], {})
        self.assertTrue(meta["complete"], "nothing was omitted, so nothing is incomplete")
        self.assertTrue(meta["oversized"])
        self.assertGreater(meta["size_chars"], meta["limit_chars"])
        json.loads(self.text)
        self.assertEqual(self.out["claude_note"], self.fixture["claude_note"])

    def test_a_response_that_fits_is_neither_oversized_nor_incomplete(self):
        mcp.call_bridge = BridgeStub(status_fixture())
        _, out, _ = call("get_school_status")
        meta = out["response_completeness"]
        self.assertTrue(meta["complete"])
        self.assertFalse(meta["oversized"])
        self.assertLessEqual(meta["size_chars"], meta["limit_chars"])


class AnnouncementAuthorityPreserved(unittest.TestCase):
    """A stale news source or unresolved date must not become a clean calendar."""

    def setUp(self):
        self._original = mcp.call_bridge
        self.announcements = {
            "status": "degraded", "revision": 8,
            "last_attempt_at": "2026-10-10T23:00:00Z",
            "last_success_at": "2026-10-10T23:00:00Z",
            "last_complete_success_at": None, "change_safe": False,
            "courses": [{"course_code": "MGMT5560", "state": "partial",
                         "complete": False, "scope": "recent_feed"}],
            "warnings": ["MGMT5560: older announcement edits and removals are not confirmed."],
            "reviews": [{"course_code": "MGMT5560", "reason": "conflicting_announcement_dates",
                         "candidate_assignment_ids": ["synthetic-assignment"],
                         "proposed_dates": ["2026-10-19", "2026-10-21"],
                         "authority": {"url": "https://uga.view.usg.edu/d2l/le/news/3963225/7098040/view",
                                       "observed_at": "2026-10-10T23:00:00Z",
                                       "published_at": None,
                                       "feed_published_at": "2026-10-05T20:04:00Z"}}],
        }
        self.corrections = [{"course_code": "MGMT5560", "assignment_id": "synthetic-assignment",
                             "state": "applied", "date": "2026-10-19", "precision": "date",
                             "time_verification": "unconfirmed",
                             "authority": self.announcements["reviews"][0]["authority"]}]

    def tearDown(self):
        mcp.call_bridge = self._original

    def test_news_gaps_and_date_authority_survive_other_section_pagination(self):
        fixture = status_fixture(
            announcements=self.announcements, date_reconciliations=self.corrections,
            feed_health=[{"source": "elc", "ok": True, "announcements": self.announcements,
                          "date_reconciliations": self.corrections}],
            class_notes=[{"date": "2026-10-10", "text": "x" * 900} for _ in range(40)],
            upcoming=[{"title": "Future %d" % i, "detail": "y" * 400} for i in range(40)],
            data_warning="The instructor announcement source has partial coverage.",
        )
        mcp.call_bridge = BridgeStub(fixture)
        is_error, out, text = call("get_school_status")
        self.assertFalse(is_error)
        json.loads(text)
        self.assertEqual(out["announcements"], self.announcements)
        self.assertEqual(out["date_reconciliations"], self.corrections)
        self.assertEqual(out["feed_health"], fixture["feed_health"])
        meta = out["response_completeness"]
        self.assertFalse(meta["complete"])
        self.assertTrue(meta["warnings_complete"])
        self.assertNotIn("announcements", meta["sections_trimmed"])
        self.assertNotIn("date_reconciliations", meta["sections_trimmed"])
        section = next(iter(meta["sections_trimmed"]))
        _, page, _ = call("get_status_section", {"token": meta["retrieval_token"], "section": section})
        self.assertEqual(page["total"], len(fixture[section]))
        _, authority, _ = call("get_status_section", {"token": meta["retrieval_token"], "section": "announcements"})
        self.assertEqual(authority["value"], self.announcements)

    def test_oversized_warning_evidence_remains_whole_and_parseable(self):
        many = {**self.announcements, "reviews": self.announcements["reviews"] * 100}
        fixture = status_fixture(announcements=many, date_reconciliations=self.corrections)
        mcp.call_bridge = BridgeStub(fixture)
        is_error, out, text = call("get_school_status")
        self.assertFalse(is_error)
        json.loads(text)
        self.assertEqual(out["announcements"], many)
        self.assertEqual(out["date_reconciliations"], self.corrections)
        meta = out["response_completeness"]
        self.assertTrue(meta["oversized"])
        self.assertTrue(meta["complete"])
        self.assertTrue(meta["warnings_complete"])
        self.assertEqual(meta["sections_trimmed"], {})

    def test_protected_authority_cannot_be_added_to_a_future_trim_plan(self):
        original_plan = mcp.TRIM_ORDER
        try:
            mcp.TRIM_ORDER = (("date_reconciliations", 0), ("feed_health", 0)) + original_plan
            fixture = status_fixture(announcements=self.announcements,
                                     date_reconciliations=self.corrections * 100,
                                     feed_health=[{"source": "elc", "ok": True}] * 100)
            mcp.call_bridge = BridgeStub(fixture)
            _, out, text = call("get_school_status")
            json.loads(text)
            self.assertEqual(out["date_reconciliations"], fixture["date_reconciliations"])
            self.assertEqual(out["feed_health"], fixture["feed_health"])
            self.assertTrue(out["response_completeness"]["warnings_complete"])
        finally:
            mcp.TRIM_ORDER = original_plan


class TokenIdentity(unittest.TestCase):
    def tearDown(self):
        mcp.call_bridge = self._original

    def test_a_token_from_another_process_run_cannot_resolve(self):
        self._original = mcp.call_bridge
        mcp.call_bridge = BridgeStub(status_fixture())
        _, out, _ = call("get_school_status")
        token = out["response_completeness"]["retrieval_token"]

        # A bare counter made "status-1" mean whatever the newest run happened to
        # hold. The session prefix is what stops a stale token resolving at all.
        self.assertIn(mcp._SESSION, token)
        is_error, page, _ = call("get_status_section",
                                 {"token": "status-1", "section": "progress"})
        self.assertTrue(is_error)
        self.assertEqual(page["error"], "unknown_retrieval_token")

    def test_tokens_are_unique_within_a_run(self):
        self._original = mcp.call_bridge
        mcp.call_bridge = BridgeStub(status_fixture())
        seen = {call("get_school_status")[1]["response_completeness"]["retrieval_token"]
                for _ in range(3)}
        self.assertEqual(len(seen), 3)


class AdaptivePagination(unittest.TestCase):
    def setUp(self):
        self.original = mcp.call_bridge
        self.urgent = {"title": "Synthetic urgent", "bucket": "overdue", "detail": "urgent evidence"}
        self.unknown = {"title": "Synthetic unknown bucket", "bucket": "new_server_bucket"}
        rows = [{"title": "Synthetic future %d" % i, "bucket": "other_courses_this_week",
                 "days_away": 3, "detail": "future " * 180} for i in range(30)]
        action = status_fixture()["actionable"]
        action.update(outstanding=[self.urgent, *rows, self.unknown],
                      counts={"outstanding": 32, "overdue": 1})
        self.fixture = status_fixture(actionable=action,
            identity_review={"warning": "Preserve identity warning. " * 170},
            progress=[{"item": "Synthetic progress %d" % i, "note": "p" * 900} for i in range(13)],
            class_notes=[{"text": "n" * 1200} for _ in range(10)],
            other_courses_this_week=[{"title": "Synthetic other %d" % i, "days_away": 3, "detail": "d" * 900} for i in range(11)])
        mcp.call_bridge = BridgeStub(self.fixture)

    def tearDown(self):
        mcp.call_bridge = self.original

    def test_fixed_preview_minimums_and_nested_nonurgent_rows_cannot_force_overflow(self):
        is_error, out, text = call("get_school_status")
        self.assertFalse(is_error)
        meta = out["response_completeness"]
        self.assertLessEqual(len(text), mcp.SIZE_TARGET)
        self.assertEqual(meta["size_chars"], len(text))
        self.assertFalse(meta["oversized"])
        self.assertFalse(meta["complete"])
        self.assertTrue(meta["urgent_work_complete"])
        self.assertTrue(meta["warnings_complete"])
        self.assertEqual(out["overdue"], self.fixture["overdue"])
        self.assertEqual(out["identity_review"], self.fixture["identity_review"])
        self.assertEqual(out["actionable"]["counts"], self.fixture["actionable"]["counts"])
        self.assertEqual(out["actionable"]["outstanding"], [self.urgent, self.unknown])
        nested = meta["sections_trimmed"]["actionable.outstanding"]
        self.assertEqual((nested["included"], nested["total"]), (2, 32))
        self.assertEqual(nested["included_selection"], "urgent_and_unknown_urgency_retained")
        self.assertEqual(len(self.fixture["actionable"]["outstanding"]), 32, "projection must not mutate snapshot")

    def test_nested_continuation_is_size_bounded_and_reconstructs_exact_snapshot(self):
        _, out, _ = call("get_school_status")
        token = out["response_completeness"]["retrieval_token"]
        seen, offset = [], 0
        while offset is not None:
            error, page, text = call("get_status_section", {"token": token,
                "section": "actionable.outstanding", "offset": offset, "limit": 500})
            self.assertFalse(error)
            self.assertLessEqual(len(text), mcp.SIZE_TARGET)
            self.assertEqual(page["size_chars"], len(text))
            self.assertEqual(page["total"], 32)
            self.assertEqual(page["requested_limit"], 500)
            self.assertGreater(page["count"], 0)
            self.assertFalse(page["oversized"])
            seen.extend(page["items"])
            offset = page["next_offset"]
        self.assertEqual(seen, self.fixture["actionable"]["outstanding"])

    def test_large_urgent_rows_remain_whole_with_honest_oversize(self):
        urgent = [{"title": "Synthetic urgent %d" % i, "bucket": "due_today",
                   "evidence": "keep " * 150} for i in range(40)]
        mcp.call_bridge = BridgeStub(status_fixture(due_today=urgent,
            actionable={**status_fixture()["actionable"], "outstanding": urgent}))
        _, out, text = call("get_school_status")
        self.assertEqual(out["due_today"], urgent)
        self.assertEqual(out["actionable"]["outstanding"], urgent)
        self.assertTrue(out["response_completeness"]["urgent_work_complete"])
        self.assertTrue(out["response_completeness"]["warnings_complete"])
        self.assertTrue(out["response_completeness"]["oversized"])
        self.assertEqual(out["response_completeness"]["size_chars"], len(text))

    def test_one_oversized_continuation_record_is_explicit_and_never_cut(self):
        rows = [{"text": "whole " * 5000}, {"text": "next"}]
        token = mcp._remember({"class_notes": rows})
        _, page, text = call("get_status_section", {"token": token, "section": "class_notes", "limit": 50})
        self.assertEqual(page["items"], rows[:1])
        self.assertEqual(page["next_offset"], 1)
        self.assertTrue(page["oversized"])
        self.assertEqual(page["size_chars"], len(text))
        _, remainder, _ = call("get_status_section", {"token": token, "section": "class_notes", "offset": 1})
        self.assertEqual(remainder["items"], rows[1:])
        self.assertIsNone(remainder["next_offset"])

    def test_cross_course_today_and_unknown_dates_survive_all_pagination_paths(self):
        future = [{"title": "Future %d" % i, "days_away": 3, "detail": "f" * 400} for i in range(14)]
        required = [{"title": "Other course today", "days_away": 0},
                    {"title": "Other course overdue", "days_away": -1},
                    {"title": "Missing day"}, {"title": "Null day", "days_away": None},
                    {"title": "String day", "days_away": "2"},
                    {"title": "Boolean day", "days_away": True},
                    {"title": "Fractional day", "days_away": 0.5}]
        rows = future + required
        nested = [{**row, "bucket": "other_courses_this_week"} for row in rows]
        fixture = {"other_courses_this_week": rows, "overdue": [], "due_today": [],
                   "actionable": {"outstanding": nested, "counts": {"outstanding": len(rows)}},
                   "data_warning": "Synthetic warning stays complete."}
        token = mcp._remember(fixture)
        out = mcp.fit(fixture, token, limit=3500)
        self.assertEqual(out["other_courses_this_week"], required)
        self.assertEqual(out["actionable"]["outstanding"], nested[-len(required):])
        self.assertTrue(out["response_completeness"]["urgent_work_complete"])
        self.assertTrue(out["response_completeness"]["warnings_complete"])
        self.assertFalse(out["response_completeness"]["oversized"])
        self.assertLessEqual(len(mcp.encode(out)), 3500)
        self.assertEqual(out["actionable"]["counts"], fixture["actionable"]["counts"])
        for section, original in [("other_courses_this_week", rows), ("actionable.outstanding", nested)]:
            recovered, offset = [], 0
            while offset is not None:
                page = mcp.section_page(token, section, offset, 5)
                recovered.extend(page["items"]);offset = page["next_offset"]
            self.assertEqual(recovered, original)
            self.assertEqual(out["response_completeness"]["sections_trimmed"][section]["total"], len(original))
        self.assertEqual(fixture["other_courses_this_week"], rows)

    def test_preferred_preview_preserves_cross_course_today_after_eighth_row(self):
        rows = [{"title": "Future %d" % i, "days_away": 2, "detail": "f" * 500} for i in range(12)]
        today = {"title": "Other course due today", "days_away": 0}
        rows.append(today)
        fixture = {"other_courses_this_week": rows}
        out = mcp.fit(fixture, mcp._remember(fixture), limit=5200)
        self.assertEqual(out["other_courses_this_week"], rows[:8] + [today])
        self.assertLessEqual(len(mcp.encode(out)), 5200)
        self.assertTrue(out["response_completeness"]["urgent_work_complete"])

    def test_large_cross_course_today_remains_whole_when_target_is_impossible(self):
        today = {"title": "Other course due today", "days_away": 0, "detail": "keep " * 1000}
        future = {"title": "Future", "days_away": 2, "detail": "f" * 1000}
        fixture = {"other_courses_this_week": [future, today], "actionable": {
            "outstanding": [{**row, "bucket": "other_courses_this_week"} for row in [future, today]]}}
        out = mcp.fit(fixture, mcp._remember(fixture), limit=2000)
        self.assertIn(today, out["other_courses_this_week"])
        self.assertIn({**today, "bucket": "other_courses_this_week"}, out["actionable"]["outstanding"])
        self.assertTrue(out["response_completeness"]["oversized"])
        self.assertTrue(out["response_completeness"]["urgent_work_complete"])


class MarkProgress(unittest.TestCase):
    """Reporting work is a claim about the work, plus a claim about the evidence."""

    def setUp(self):
        self._original = mcp.call_bridge
        self.stub = BridgeStub({"ok": True, "course": "BUSN5000", "tracked": 3})
        mcp.call_bridge = self.stub

    def tearDown(self):
        mcp.call_bridge = self._original

    def test_a_plain_report_carries_its_reporter_and_no_evidence(self):
        call("mark_progress", {"course": "BUSN5000", "item": "Homework 3"})
        sent = self.stub.calls[0]["payload"]
        self.assertEqual(sent["reported_by"], "codex")
        self.assertEqual(sent["status"], "done")
        self.assertNotIn("verification", sent, "no evidence claim unless one was made")

    def test_evidence_fields_are_passed_through(self):
        call("mark_progress", {"course": "BUSN5000", "item": "Homework 3",
                               "verification": "verified", "evidence": "eLC receipt 8831",
                               "submitted_by": "group"})
        sent = self.stub.calls[0]["payload"]
        self.assertEqual(sent["verification"], "verified")
        self.assertEqual(sent["evidence"], "eLC receipt 8831")
        self.assertEqual(sent["submitted_by"], "group")

    def test_a_rejected_write_is_reported_as_an_error(self):
        mcp.call_bridge = BridgeStub({"error": "verification_requires_evidence",
                                      "detail": "send it in `evidence`"})
        is_error, out, _ = call("mark_progress", {"course": "BUSN5000", "item": "x",
                                                  "verification": "verified"})
        self.assertTrue(is_error, "a refused write must not read as a successful one")
        self.assertEqual(out["error"], "verification_requires_evidence")

    def test_an_empty_item_is_refused_before_any_call(self):
        is_error, out, _ = call("mark_progress", {"course": "BUSN5000", "item": "   "})
        self.assertTrue(is_error)
        self.assertEqual(out["error"], "missing_item")
        self.assertEqual(self.stub.calls, [], "nothing should have been sent")

    def test_identity_revision_zero_and_retry_key_are_passed_through(self):
        args = {"course": "BUSN5000", "item": "Homework 3", "assignment_id": "fixture",
                "term_id": "fall-2026", "expected_revision": 0, "relink": False,
                "when_iso": "2026-09-06T12:00:00Z", "idempotency_key": "same-operation"}
        call("mark_progress", args)
        sent = self.stub.calls[0]["payload"]
        for key in ("assignment_id", "term_id", "expected_revision", "relink", "when_iso", "idempotency_key"):
            self.assertEqual(sent[key], args[key])

    def test_uncertain_save_returns_a_reusable_operation_key(self):
        mcp.call_bridge = BridgeStub({"error": "request_failed"})
        is_error, out, _ = call("mark_progress", {"course": "BUSN5000", "item": "Homework 3"})
        self.assertTrue(is_error)
        self.assertTrue(out["operation_id"])
        self.assertIn("Not confirmed", out["save_confirmation"])
        call("mark_progress", {"course": "BUSN5000", "item": "Homework 3", "idempotency_key": out["operation_id"]})
        self.assertEqual(mcp.call_bridge.calls[0]["payload"]["idempotency_key"],
                         mcp.call_bridge.calls[1]["payload"]["idempotency_key"])


PASS_CATALOG = {"ok": True, "term_id": "fall-2026", "timezone": "America/New_York", "courses": [
    {"code": "BUSN5000", "label": "BUSN 5000", "title": "Introduction to Data Science for Business and Economics"},
    {"code": "MGMT4280", "label": "MGMT 4280", "title": "Supply Chain Analytics"},
    {"code": "MGMT5560", "label": "MGMT 5560", "title": "International Strategic Management"},
    {"code": "MGMT5850", "label": "MGMT 5850", "title": "Performance Management and Compensation"},
    {"code": "LAND2510", "label": "LAND 2510E", "title": "History of the Built Environment I"},
    {"code": "BUSN3040", "label": "BUSN 3040E", "title": "R Programming for Business Analytics I"},
]}


def pass_args(**overrides):
    out = {"session_id": "synthetic-session", "date": "2026-10-31", "title": "BUSN 5000 file import",
           "goal": "Check the file import command.",
           "recorded_by": "synthetic-assistant", "facts": [{"text": "The file import returned object not found.",
           "basis": "observed", "source": "Current synthetic session, first command result"}],
           "next_step": "Check the filename and rerun the import.", "expected_revision": 0, "idempotency_key": "synthetic-pass-save"}
    out.update(overrides)
    return out


class PassBridgeFixture:
    """Synthetic HTTP peer; real SQLite/HTTP storage behavior is covered in JS."""
    def __init__(self):
        self.calls, self.records, self.receipts = [], {}, {}
        self.lose_response = self.fail_readback = self.corrupt_readback = False

    def __call__(self, path, payload=None, method="POST"):
        self.calls.append({"path": path, "payload": payload, "method": method})
        url = urlsplit(path)
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        if path == "/pass/courses":
            return PASS_CATALOG
        if path == "/pass/protocol":
            return {"ok": True, "scope": "all_classes", "record": {"record_id": "e2e2536a-83b9-460f-991b-3f86fd87542a",
                    "revision": 2, "course": "BUSN5000", "text": "PASS applies to all classes; record facts and sources."}}
        if url.path == "/pass":
            selected = [r for r in self.records.values() if r["session_id"].startswith("pass:test:") == (query.get("sandbox") == "true")
                        and all(r.get(k) == query[k] for k in ("course", "record_id", "session_id") if k in query)]
            if "record_id" in query:
                if self.fail_readback:
                    self.fail_readback = False
                    return {"error": "request_failed", "bridge_reachable": False}
                if not selected:
                    return {"error": "pass_not_found", "http_status": 404}
                row = dict(selected[0])
                if self.corrupt_readback:
                    row["text"] = "Different contents"
                return {"ok": True, "record": row}
            rows = sorted(selected, key=lambda r: r["at"], reverse=True)
            courses = sorted({r["course"] for r in rows})
            limit = int(query.get("limit", "10"))
            return {"ok": True, "term_id": "fall-2026", "records": [{k: v for k, v in r.items() if k != "text"} for r in rows[:limit]],
                    "courses_with_passes": [{"course": c, "count": sum(r["course"] == c for r in rows)} for c in courses],
                    "next_cursor": "more" if len(rows) > limit else None}
        if path == "/classnote" and method == "POST":
            key, fingerprint = payload["idempotency_key"], json.dumps(payload, sort_keys=True)
            if key in self.receipts:
                old, result = self.receipts[key]
                return {**result, "replayed": True} if old == fingerprint else {"error": "idempotency_conflict", "http_status": 409}
            prior = next((r for r in self.records.values() if r["course"] == payload["course"] and
                          (r["record_id"] == payload["record_id"] if "record_id" in payload else r["session_id"] == payload["session_id"])), None)
            if payload["expected_revision"] != (prior["revision"] if prior else 0):
                return {"error": "revision_conflict", "http_status": 409, "current_revision": prior["revision"] if prior else 0}
            row = {k: payload[k] for k in ("course", "session_id", "date", "title", "text")}
            row.update(record_id=prior["record_id"] if prior else "synthetic-record-" + str(len(self.records)),
                       revision=payload["expected_revision"] + 1, term_id="fall-2026", at="synthetic-time-%04d" % len(self.calls))
            self.records[row["record_id"]] = row
            result = {"ok": True, "recorded": row, "revision": row["revision"], "operation_id": key}
            self.receipts[key] = fingerprint, result
            if self.lose_response:
                self.lose_response = False
                return {"error": "request_failed", "bridge_reachable": False}
            return result
        raise AssertionError("Unexpected peer call: " + path)


class PassContract(unittest.TestCase):
    def setUp(self):
        self.original = mcp.call_bridge
        self.peer = PassBridgeFixture()
        mcp.call_bridge = self.peer

    def tearDown(self):
        mcp.call_bridge = self.original

    def save(self, **overrides):
        return call("save_pass", pass_args(**overrides))

    def test_protocol_is_read_by_exact_identity_and_remains_course_neutral(self):
        error, out, _ = call("get_pass_protocol")
        self.assertFalse(error)
        self.assertEqual(out["record"]["revision"], 2)
        self.assertEqual(out["scope"], "all_classes")
        self.assertIn("all classes", out["markdown"])

    def test_save_records_provenance_and_requires_matching_fresh_readback(self):
        error, out, _ = self.save()
        self.assertFalse(error)
        self.assertEqual(out["save_confirmation"], "confirmed")
        self.assertEqual(out["readback"], out["recorded"])
        self.assertIn("[observed]", out["markdown"])
        self.assertIn("Current synthetic session", out["markdown"])
        self.assertEqual(out["routing"], "context")
        self.assertEqual(self.peer.calls[-1]["method"], "GET")
        self.assertEqual([c["path"] for c in self.peer.calls if c["method"] == "POST"], ["/classnote"])

    def test_all_six_classes_route_by_code_label_or_canonical_title(self):
        for i, course in enumerate(PASS_CATALOG["courses"]):
            for title in (course["label"], course["title"]):
                error, out, _ = self.save(title=title, session_id="class-%d-%s" % (i, "label" if title == course["label"] else "title"),
                                          idempotency_key="key-%d-%s" % (i, "label" if title == course["label"] else "title"))
                self.assertFalse(error, out)
                self.assertEqual(out["recorded"]["course"], course["code"])

    def test_explicit_class_overrides_incidental_other_course_mentions(self):
        error, out, _ = self.save(course="MGMT 4280", title="MGMT4280 file import", context="BUSN5000 and MGMT5560 also have deadlines.")
        self.assertFalse(error)
        self.assertEqual(out["recorded"]["course"], "MGMT4280")
        self.assertEqual(out["routing"], "explicit")

    def test_named_class_conflicting_with_primary_handoff_evidence_is_refused(self):
        error, out, _ = self.save(course="MGMT4280")
        self.assertTrue(error)
        self.assertEqual(out["error"], "pass_course_conflict")
        self.assertFalse(self.peer.records)

    def test_full_handoff_fact_sources_are_considered_for_routing(self):
        error, out, _ = self.save(title="Import error", facts=[{"basis": "source", "text": "The guide names the import command.", "source": "BUSN 3040E guide, step 2"}])
        self.assertFalse(error)
        self.assertEqual(out["recorded"]["course"], "BUSN3040")

    def test_ambiguous_context_does_not_save_or_default_to_busn5000(self):
        error, out, _ = self.save(context="Compare MGMT4280 with this session.")
        self.assertTrue(error)
        self.assertEqual(out["error"], "pass_course_ambiguous")
        self.assertEqual(len(self.peer.records), 0)

    def test_missing_or_unknown_class_does_not_save(self):
        for overrides in ({"title": "Generic file import"}, {"course": "GENERAL"}, {"course": "MGMT9999"}):
            error, out, _ = self.save(**overrides)
            self.assertTrue(error, out)
        self.assertFalse(self.peer.records)

    def test_factual_and_restricted_content_guards_refuse_subjective_claims(self):
        for text in ("The learner mastered SQL.", "The learner understands regression.", "API_KEY=secret", "Score: 95", "[12:34] lecture words"):
            error, _, _ = self.save(facts=[{"basis": "observed", "text": text, "source": "Synthetic session"}])
            self.assertTrue(error, text)
        self.assertFalse(self.peer.records)

    def test_missing_provenance_invalid_dates_and_inferred_fact_basis_are_rejected(self):
        for overrides in ({"facts": [{"text": "An error occurred", "basis": "observed"}]}, {"date": "2026-02-30"},
                          {"facts": [{"text": "An error occurred", "basis": "inferred", "source": "guess"}]},
                          {"expected_revision": True}, {"session_id": "bad?id"}):
            error, _, _ = self.save(**overrides)
            self.assertTrue(error, overrides)
        self.assertFalse(self.peer.records)

    def test_oversized_handoff_is_rejected_without_silent_truncation(self):
        facts = [{"basis": "observed", "text": "x" * 590, "source": "Synthetic session"} for _ in range(8)]
        error, out, _ = self.save(facts=facts)
        self.assertTrue(error)
        self.assertEqual(out["error"], "pass_too_large")
        self.assertFalse(self.peer.records)

    def test_lost_response_retry_reuses_exact_packet_without_duplicate_session(self):
        self.peer.lose_response = True
        error, lost, _ = self.save()
        self.assertTrue(error)
        error, saved, _ = call("save_pass", lost["retry_arguments"])
        self.assertFalse(error, saved)
        self.assertTrue(saved["replayed"])
        self.assertEqual(len(self.peer.records), 1)
        packets = [c["payload"] for c in self.peer.calls if c["method"] == "POST"]
        self.assertEqual(packets[0], packets[1])

    def test_readback_failure_stays_unconfirmed_and_can_recover_by_exact_retry(self):
        self.peer.fail_readback = True
        error, failed, _ = self.save()
        self.assertTrue(error)
        self.assertIn("Not confirmed", failed["save_confirmation"])
        error, out, _ = call("save_pass", failed["retry_arguments"])
        self.assertFalse(error)
        self.assertTrue(out["replayed"])
        self.assertEqual(len(self.peer.records), 1)

    def test_mismatched_readback_never_confirms_success(self):
        self.peer.corrupt_readback = True
        error, out, _ = self.save()
        self.assertTrue(error)
        self.assertEqual(out["error"], "pass_readback_mismatch")

    def test_conflicting_key_and_stale_revision_do_not_overwrite(self):
        _, first, _ = self.save()
        error, conflict, _ = self.save(next_step="Check the working directory.")
        self.assertTrue(error)
        self.assertEqual(conflict["error"], "idempotency_conflict")
        update = pass_args(record_id=first["recorded"]["record_id"], expected_revision=1, idempotency_key="correction", next_step="Check the directory.")
        error, corrected, _ = call("save_pass", update)
        self.assertFalse(error, corrected)
        self.assertEqual(corrected["revision"], 2)
        error, stale, _ = call("save_pass", {**update, "idempotency_key": "stale"})
        self.assertTrue(error)
        self.assertEqual(stale["error"], "revision_conflict")
        self.assertEqual(self.peer.records[first["recorded"]["record_id"]]["text"], corrected["recorded"]["text"])

    def test_lost_update_response_can_replay_after_revision_has_advanced(self):
        _, first, _ = self.save()
        self.peer.lose_response = True
        error, lost, _ = self.save(record_id=first["recorded"]["record_id"], expected_revision=1, idempotency_key="update", next_step="Rerun after changing the directory.")
        self.assertTrue(error)
        error, replay, _ = call("save_pass", lost["retry_arguments"])
        self.assertFalse(error, replay)
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["revision"], 2)

    def test_update_requires_exact_record_session_and_positive_revision(self):
        _, first, _ = self.save()
        error, _, _ = self.save(expected_revision=1)
        self.assertTrue(error)
        error, out, _ = self.save(record_id=first["recorded"]["record_id"], expected_revision=1, session_id="different")
        self.assertTrue(error)
        self.assertEqual(out["error"], "pass_session_mismatch")

    def test_latest_resume_follows_save_order_and_exact_read_preserves_old_session(self):
        _, first, _ = self.save(session_id="first")
        _, second, _ = self.save(session_id="second", date="2026-01-01", idempotency_key="second-save")
        error, resumed, _ = call("resume_pass", {"context": "BUSN5000"})
        self.assertFalse(error)
        self.assertEqual(resumed["record"]["record_id"], second["recorded"]["record_id"])
        error, exact, _ = call("read_pass", {"record_id": first["recorded"]["record_id"]})
        self.assertFalse(error)
        self.assertEqual(exact["record"], first["recorded"])

    def test_conflicting_read_selectors_unknown_fields_and_invalid_unicode_are_errors(self):
        for tool, args in (("resume_pass", {"record_id": "id", "session_id": "session"}),
                           ("list_passes", {"unknown": "value"}), ("save_pass", pass_args(next_step="\ud800"))):
            error, _, _ = call(tool, args)
            self.assertTrue(error)
        self.assertFalse(self.peer.records)

    def test_empty_preview_resume_reads_saved_contents_fresh_without_writing(self):
        _, first, _ = self.save()
        self.peer.records[first["recorded"]["record_id"]]["extra_future_field"] = {"preserved": True}
        start = len(self.peer.calls)
        error, resumed, _ = call("resume_pass", {"course": "5000"})
        self.assertFalse(error)
        self.assertEqual(resumed["markdown"], first["markdown"])
        self.assertEqual(resumed["record"]["extra_future_field"], {"preserved": True})
        self.assertTrue(all(c["method"] == "GET" for c in self.peer.calls[start:]))

    def test_multiple_classes_or_reused_session_id_require_class_selection(self):
        self.save()
        self.save(course="MGMT4280", title="MGMT4280 file import", idempotency_key="other")
        for args in ({}, {"session_id": "synthetic-session"}):
            error, out, _ = call("resume_pass", args)
            self.assertTrue(error)
            self.assertEqual(out["error"], "pass_course_ambiguous")
        error, out, _ = call("resume_pass", {"course": "MGMT4280", "session_id": "synthetic-session"})
        self.assertFalse(error)
        self.assertEqual(out["record"]["course"], "MGMT4280")

    def test_synthetic_connection_test_is_excluded_from_normal_resume(self):
        _, real, _ = self.save()
        error, synthetic, _ = self.save(sandbox=True, session_id="connection", idempotency_key="connection")
        self.assertFalse(error, synthetic)
        self.assertTrue(synthetic["recorded"]["session_id"].startswith("pass:test:"))
        self.assertIn("synthetic connection test; no student work", synthetic["markdown"])
        self.assertIn("Saved record:", synthetic["markdown"])
        self.assertIn("Base revision: 0", synthetic["markdown"])
        self.assertIn("Protocol record:", synthetic["markdown"])
        error, resumed, _ = call("resume_pass", {"course": "BUSN5000"})
        self.assertFalse(error)
        self.assertEqual(resumed["record"]["record_id"], real["recorded"]["record_id"])
        error, resumed_test, _ = call("resume_pass", {"course": "BUSN5000", "sandbox": True})
        self.assertFalse(error)
        self.assertEqual(resumed_test["record"], synthetic["recorded"])
        for overrides in ({"sandbox": "true"}, {"session_id": "pass:test:hidden"}, {"sandbox": True, "session_id": "pass:real"}):
            error, _, _ = self.save(**overrides)
            self.assertTrue(error)

    def test_list_discloses_canonical_catalog_and_does_not_invent_empty_history(self):
        error, listing, _ = call("list_passes")
        self.assertFalse(error)
        self.assertEqual(listing["available_courses"], PASS_CATALOG["courses"])
        self.assertEqual(listing["records"], [])
        error, out, _ = call("resume_pass", {"course": "BUSN5000"})
        self.assertTrue(error)
        self.assertEqual(out["error"], "pass_not_found")

    def test_upstream_failures_propagate_before_projection(self):
        mcp.call_bridge = BridgeStub({"error": "service_unavailable", "bridge_reachable": False})
        for tool in ("list_passes", "get_pass_protocol", "resume_pass", "read_pass", "save_pass"):
            error, out, _ = call(tool, pass_args() if tool == "save_pass" else {"record_id": "id"} if tool == "read_pass" else {})
            self.assertTrue(error)
            self.assertEqual(out["error"], "service_unavailable")


class ToolSurface(unittest.TestCase):
    def test_existing_connection_advertises_only_approved_learner_tools(self):
        names = {t['name'] for t in mcp.LEARNER_TOOLS}
        self.assertEqual(len(names), 9)
        self.assertIn('read_learner_profile', names)
        self.assertIn('set_hypothesis_status', names)
        self.assertNotIn('capture_wispr_note', names)
        self.assertNotIn('import_elc_outcome', names)
        self.assertNotIn('backfill_pass', names)

    def test_learner_read_uses_existing_bridge_transport_without_new_credentials(self):
        original = mcp.call_bridge
        calls = []
        try:
            def fake(path, payload=None, method='POST'):
                calls.append((path, payload, method))
                return {'ok': True, 'item_count': 0, 'items': []}
            mcp.call_bridge = fake
            args = {'course': 'BUSN5000', 'limit': 1}
            error, out, _ = call('read_learner_profile', args)
            self.assertFalse(error)
            self.assertEqual(out['item_count'], 0)
            self.assertEqual(calls, [('/learner/tools/read_learner_profile', args, 'POST')])
        finally:
            mcp.call_bridge = original

    def test_the_continuation_tool_is_advertised(self):
        listed = mcp.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        names = [t["name"] for t in listed["result"]["tools"]]
        self.assertIn("get_status_section", names)
        self.assertTrue({"get_pass_protocol", "list_passes", "read_pass", "save_pass", "resume_pass"}.issubset(names))

    def test_every_tool_has_a_valid_input_schema(self):
        for tool in mcp.TOOLS:
            self.assertEqual(tool["inputSchema"]["type"], "object")
            self.assertTrue(tool["description"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
