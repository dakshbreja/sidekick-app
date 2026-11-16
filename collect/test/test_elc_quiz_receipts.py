import copy
import json
from datetime import datetime
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bin'))
import elc_quiz_receipts as q
import elc_submission as s

NOW = '2026-10-11T01:00:00+00:00'
ORG = '3962245'
URL = 'https://uga.view.usg.edu/d2l/lms/quizzing/user/quiz_submissions_attempt.d2l?isprv=&qi=4926291&ai=80147309&isInPopup=0&cfql=0&fromQB=0&fromSubmissionsList=1&ou=3962245'
SUBMISSIONS = 'https://uga.view.usg.edu/d2l/lms/quizzing/user/quiz_submissions.d2l?qi=4926291&ou=3962245'


def receipt(**extra):
    row = {'receipt_origin': 'quiz_results', 'kind': 'quiz', 'item_id': '4926291', 'receipt_id': '80147309',
           'title': 'Exam # 2', 'due_at': '2026-10-08T03:59:00+00:00', 'expected_owner': 'Daksh Breja',
           'result_owner': 'Daksh Breja', 'result_title': 'Exam # 2 - Results', 'attempt_heading': 'Attempt 1 of 2',
           'written': 'Written Oct 6, 2026 1:20PM - Oct 6, 2026 1:29PM', 'source_url': URL}
    row.update(extra)
    return row


class QuizResultsReceiptTests(unittest.TestCase):
    def test_observed_land_exam_result_interval_is_explicit_submission_proof(self):
        observation = q.normalize_receipt('LAND2510', ORG, receipt(), NOW)
        self.assertEqual(observation['provider_item_id'], 'quiz:4926291:attempt:80147309')
        self.assertEqual(observation['submitted_at'], '2026-10-06T17:29:00+00:00')
        self.assertEqual(observation['due_at'], '2026-10-08T03:59:00+00:00')
        self.assertEqual(observation['source_url'], URL)
        self.assertEqual(observation['status'], 'submitted')

    def test_compact_visible_timestamp_whitespace_is_supported(self):
        row = receipt(written='Written Oct6,2026 1:20PM - Oct6,2026 1:29PM')
        self.assertEqual(q.normalize_receipt('LAND2510', ORG, row, NOW)['submitted_at'], '2026-10-06T17:29:00+00:00')

    def test_score_answers_and_result_body_are_never_projected(self):
        row = receipt(Score=98.76, questions='Private quiz question', answers='Private answer')
        observation = q.normalize_receipt('LAND2510', ORG, row, NOW)
        for value in ('98.76', 'Private quiz question', 'Private answer', 'Daksh Breja'):
            self.assertNotIn(value, json.dumps(observation))

    def test_unknown_or_different_owner_title_or_in_progress_cannot_clear_work(self):
        changes = ({'expected_owner': None}, {'result_owner': 'Another Student'}, {'result_title': 'Exam # 1 - Results'},
                   {'result_title': 'Exam # 2 - Start'}, {'attempt_heading': 'Attempt in progress'},
                   {'written': 'Written Oct6,2026 1:20PM'}, {'written': 'Written Oct6,2026 1:20PM - In Progress'})
        for changed in changes:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                q.normalize_receipt('LAND2510', ORG, receipt(**changed), NOW)

    def test_result_source_is_exact_discovered_readonly_quiz_attempt(self):
        urls = (URL.replace('uga.view.usg.edu', 'example.com'), URL.replace('ou=3962245', 'ou=4048786'),
                URL.replace('qi=4926291', 'qi=999'), URL.replace('ai=80147309', 'ai=999'),
                URL.replace('quiz_submissions_attempt.d2l', 'quiz_summary.d2l'), URL + '&token=private',
                URL + '&qi=4926291', SUBMISSIONS)
        for url in urls:
            with self.subTest(url=url), self.assertRaises(ValueError):
                q.normalize_receipt('LAND2510', ORG, receipt(source_url=url), NOW)

    def test_timestamp_order_future_term_and_due_occurrence_are_required(self):
        changes = ({'due_at': None}, {'due_at': '2025-10-08T03:59:00Z'},
                   {'written': 'Written Oct6,2026 1:29PM - Oct6,2026 1:20PM'},
                   {'written': 'Written Oct12,2026 1:20PM - Oct12,2026 1:29PM'},
                   {'written': 'Written Oct6,2025 1:20PM - Oct6,2025 1:29PM'},
                   {'written': 'Written Oct6 1:20PM - Oct6 1:29PM'})
        for changed in changes:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                q.normalize_receipt('LAND2510', ORG, receipt(**changed), NOW)

    def test_display_date_rejects_dst_ambiguous_clock(self):
        self.assertIsNone(q.display_time('Nov 1, 2026 1:30AM'))
        self.assertIsNone(q.display_time('Oct 6, 2026 0:20PM'))
        self.assertIsNone(q.display_time('Oct 6, 2026 1:99PM'))

    def test_existing_observation_adapter_accepts_only_valid_ui_receipt(self):
        bucket = {'org_unit_id': ORG, 'receipts': [receipt()], 'coverage': {}}
        observations = s.normalized_observations('LAND2510', ORG, bucket, NOW)
        self.assertEqual(observations[0]['submitted_at'], '2026-10-06T17:29:00+00:00')
        with self.assertRaises(ValueError):
            s.normalized_observations('LAND2510', ORG, {**bucket, 'receipts': [receipt(), receipt()]}, NOW)

    def test_fallback_follows_only_eligible_current_horizon_links(self):
        cfg = s.news.source_config()
        now = datetime.fromisoformat(NOW)
        listed = {'LAND2510': {'rows': [
            {'item_id': '4926291', 'title': 'Exam # 2', 'submissions_url': SUBMISSIONS, 'due_text': 'Oct 7, 2026 11:59PM'},
            {'item_id': '4926291', 'title': 'Old exam', 'submissions_url': SUBMISSIONS, 'due_text': 'Aug 7, 2026 11:59PM'},
            {'item_id': '4926291', 'title': 'Next term exam', 'submissions_url': SUBMISSIONS, 'due_text': 'Jan 7, 2027 11:59PM'},
            {'item_id': '4926291', 'title': 'Wrong-course exam', 'submissions_url': SUBMISSIONS.replace('ou=3962245', 'ou=4048786'), 'due_text': 'Oct 7, 2026 11:59PM'}
        ]}}
        result = {'LAND2510': {'receipts': [receipt()], 'coverage': {'status': 'partial', 'scope': 'current_horizon_results'}}}
        with patch.object(q.cb, 'run_js') as run, patch.object(q.cb, 'await_global', side_effect=[listed, result]):
            output = q.read_courses(1, 1, {'LAND2510': ORG}, {'LAND2510': 'Daksh Breja'}, cfg=cfg, now=now)
        self.assertEqual(len(run.call_args_list), 2)
        listing_script = run.call_args_list[0].args[2]
        self.assertIn('/d2l/lms/quizzing/user/quizzes_list.d2l', listing_script)
        self.assertNotIn('/d2l/lms/quizzing/quizzes_list.d2l', listing_script)
        second_script = run.call_args_list[1].args[2]
        self.assertIn('Exam # 2', second_script)
        for title in ('Old exam', 'Next term exam', 'Wrong-course exam'):
            self.assertNotIn(title, second_script)
        self.assertIn("method:'GET'", second_script)
        self.assertNotIn('quiz_summary.d2l', second_script)
        self.assertEqual(output['LAND2510']['receipts'], result['LAND2510']['receipts'])

    def test_missing_current_owner_does_not_fetch_submission_pages(self):
        with patch.object(q.cb, 'run_js') as run:
            output = q.read_courses(1, 1, {'LAND2510': ORG}, {}, now=datetime.fromisoformat(NOW))
        self.assertEqual(output, {})
        run.assert_not_called()

    def test_reader_failure_remains_unknown(self):
        with patch.object(q.cb, 'run_js'), patch.object(q.cb, 'await_global', side_effect=q.cb.ChromeError('blocked')):
            output = q.read_courses(1, 1, {'LAND2510': ORG}, {'LAND2510': 'Daksh Breja'}, now=datetime.fromisoformat(NOW))
        self.assertEqual(output['LAND2510'], {'error': 'browser'})


if __name__ == '__main__':
    unittest.main()
