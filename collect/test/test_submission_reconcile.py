"""Submission receipts must clear only their exact assignment, durably.

All sources and bridge calls are synthetic; these tests never read credentials,
open a browser, or write real coursework progress.
"""
import copy
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bin'))
import submission_reconcile as s

STAMP = '2026-10-11T01:00:00Z'
DUE = '2026-10-10T03:59:00Z'
CONFIG = {'WORKER_URL': 'https://ijuh2yp6rf.example-subdomain.workers.dev', 'API_KEY': 'test-only'}
ELC_UI_RECEIPT = ('https://uga.view.usg.edu/d2l/lms/quizzing/user/quiz_submissions_attempt.d2l'
                  '?isprv=&qi=4926291&ai=80147309&isInPopup=0&cfql=0&fromQB=0'
                  '&fromSubmissionsList=1&ou=3962245')


def observation(**overrides):
    row = {'provider': 'globus', 'course_code': 'MGMT5560', 'term_id': 'fall-2026',
           'provider_item_id': 'chapter:5:exercise', 'kind': 'chapter_exercise',
           'chapter': 5, 'title': 'Chapter 5 Exercises', 'status': 'completed',
           'source_url': 'https://www.glo-bus.com/users/lobby/assignments/student-grades',
           'observed_at': STAMP, 'source_evidence': 'GLO-BUS shows completed for Chapter 5 Exercises.'}
    row.update(overrides)
    return row


def elc_observation(**overrides):
    row = {'provider': 'elc', 'course_code': 'BUSN5000', 'term_id': 'fall-2026',
           'provider_item_id': 'quiz:100:attempt:200', 'kind': 'quiz',
           'title': 'Quiz 5', 'status': 'submitted',
           'source_url': 'https://uga.view.usg.edu/d2l/api/le/1.82/4048786/quizzes/100/attempts/?userId=300',
           'observed_at': STAMP, 'submitted_at': '2026-10-09T20:00:00Z', 'due_at': DUE,
           'source_evidence': 'eLC own-user quiz attempt 200 has an explicit Completed timestamp.'}
    row.update(overrides)
    return row


def gradescope_observation(**overrides):
    row = {'provider': 'gradescope', 'course_code': 'BUSN5000', 'term_id': 'fall-2026',
           'provider_item_id': 'assignment:8402934:submission:432669080', 'kind': 'assignment',
           'title': 'Homework 5', 'status': 'submitted',
           'source_url': 'https://www.gradescope.com/courses/1353639/assignments/8402934/submissions/432669080',
           'observed_at': STAMP, 'source_evidence': 'Own submission link is present.'}
    row.update(overrides)
    return row


def elc_ui_observation(**overrides):
    row = elc_observation(course_code='LAND2510', provider_item_id='quiz:4926291:attempt:80147309',
                          title='Exam #2', source_url=ELC_UI_RECEIPT,
                          submitted_at='2026-10-06T17:29:00Z', due_at='2026-10-08T03:59:00Z')
    row.update(overrides)
    return row


def deadline(**overrides):
    row = {'course_code': 'MGMT5560', 'term_id': 'fall-2026',
           'assignment_id': 'fall-2026:MGMT5560:elc:chapter5', 'when_iso': DUE,
           'title': 'MGMT 5560 Chapter 5 Exercises', 'source_namespace': 'elc',
           'source': 'eLC (D2L)', 'completed': False}
    row.update(overrides)
    return row


def http_error(code, category):
    return urllib.error.HTTPError('https://school-bridge.example-subdomain.workers.dev/progress', code,
                                  'synthetic', {}, io.BytesIO(json.dumps({'error': category}).encode()))


class Bridge:
    def __init__(self, rows=None, progress=None):
        self.rows = copy.deepcopy([deadline()] if rows is None else rows)
        self.progress = copy.deepcopy(progress or [])
        self.calls = []
        self.posts = []
        self.receipts = {}
        self.fail_after_commit = False
        self.false_readback = False
        self.bad_receipt = False
        self.receipt_overrides = {}
        self.readback_overrides = {}
        self.conflict = False

    def request(self, method, path, payload=None, operation_id=None):
        self.calls.append((method, path, copy.deepcopy(payload), operation_id))
        route = urlsplit(path).path
        course = parse_qs(urlsplit(path).query).get('course', ['MGMT5560'])[0]
        if method == 'GET' and route == '/status':
            return {'course': {'code': course}, 'overdue': copy.deepcopy(self.rows),
                    'due_today': [], 'due_this_week': [], 'upcoming': [],
                    'urgent_work_complete': True,
                    'actionable': {'coverage': {'feeds_status': 'ok'}},
                    'health': [{'source': 'eLC (D2L)', 'ok': True, 'coverage_complete': True}]}
        if method == 'GET' and route == '/progress':
            values = [r for r in self.progress if r.get('course') == course]
            if self.false_readback:
                values = []
            if self.readback_overrides:
                values = [{**r, **self.readback_overrides} for r in values]
            return {'course': course, 'progress': copy.deepcopy(values)}
        if method == 'POST' and route == '/progress':
            self.posts.append((copy.deepcopy(payload), operation_id))
            if self.conflict:
                self.conflict = False
                current = {'record_id': 'existing', 'revision': 2, 'course': payload['course'],
                           'item': payload['item'], 'assignment_id': payload['assignment_id'],
                           'term_id': payload['term_id'], 'when_iso': payload['when_iso'],
                           'status': 'in_progress', 'verification': 'reported', 'identity_resolution': 'linked'}
                self.progress[:] = [current]
                raise http_error(409, 'revision_conflict')
            if operation_id in self.receipts:
                return copy.deepcopy(self.receipts[operation_id])
            revision = int(payload.get('expected_revision') or 0) + 1
            record = {**copy.deepcopy(payload), 'record_id': payload.get('record_id') or f'record-{len(self.progress)+1}',
                      'revision': revision, 'identity_resolution': 'linked'}
            self.progress[:] = [r for r in self.progress if r.get('assignment_id') != record['assignment_id']] + [record]
            receipt = {'ok': True, 'operation_id': operation_id, 'revision': revision, 'recorded': record}
            self.receipts[operation_id] = copy.deepcopy(receipt)
            if self.bad_receipt:
                receipt['recorded'] = {**record, 'assignment_id': 'different-assignment'}
            if self.receipt_overrides:
                receipt['recorded'] = {**receipt['recorded'], **self.receipt_overrides}
            if self.fail_after_commit:
                self.fail_after_commit = False
                raise OSError('synthetic response lost')
            return receipt
        raise AssertionError(f'Unexpected synthetic request: {method} {route}')


class FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 10, 11, 2, 0, 0, tzinfo=timezone.utc).astimezone(tz) if tz else cls(2026, 10, 11, 2)


class FixedClockTests(unittest.TestCase):
    def setUp(self):
        fixed = patch.object(s, 'datetime', FrozenDatetime)
        fixed.start()
        self.addCleanup(fixed.stop)


class NormalizationTests(FixedClockTests):
    def test_only_explicit_completed_and_submitted_states_are_accepted(self):
        for value in ('completed', 'submitted'):
            self.assertEqual(s.normalize_observation(observation(status=value))['status'], value)
        for value in ('in_progress', 'not_completed', 'graded', 'viewed', 'available', '', None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                s.normalize_observation(observation(status=value))

    def test_grade_score_answers_and_private_cells_are_not_projected(self):
        result = s.normalize_observation(observation(score=98.76, Grade=98.76,
                                                      answers=['private answer'], cells=['private email']))
        serialized = json.dumps(result)
        for private in ('98.76', 'private answer', 'private email'):
            self.assertNotIn(private, serialized)
        self.assertFalse({'score', 'Grade', 'answers', 'cells'} & result.keys())

    def test_wrong_provider_course_term_and_source_do_not_authorize_writes(self):
        cases = ({'provider': 'unknown'}, {'course_code': 'BUSN5000'}, {'term_id': 'fall-2025'},
                 {'source_url': 'https://evil.example.test/receipt'},
                 {'source_url': 'http://www.glo-bus.com/users/lobby/assignments/student-grades'})
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                s.normalize_observation(observation(**changes))

    def test_missing_unzoned_and_invalid_observation_times_are_rejected(self):
        for value in (None, '', 'not-a-time', '2026-10-11', '2026-10-11T01:00:00'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                s.normalize_observation(observation(observed_at=value))

    def test_elc_requires_a_real_timestamped_own_source_receipt(self):
        self.assertEqual(s.normalize_observation(elc_observation())['provider'], 'elc')
        for changes in ({'submitted_at': None}, {'source_url': 'https://uga.view.usg.edu/d2l/home/4048786'},
                        {'source_url': elc_observation()['source_url'].replace('4048786', '4001788')},
                        {'provider_item_id': 'quiz:100:submission:200'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                s.normalize_observation(elc_observation(**changes))

    def test_provider_item_identity_must_match_the_source_requirement(self):
        for changes in ({'provider_item_id': 'chapter:6:exercise'},
                        {'provider_item_id': 'chapter:5:quiz'},
                        {'source_url': 'https://www.glo-bus.com/users/lobby/messages'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                s.normalize_observation(observation(**changes))

    def test_source_evidence_is_synthesized_and_arbitrary_text_is_not_projected(self):
        result = s.normalize_observation(observation(source_evidence='Grade: 98.76; secret password=private'))
        self.assertNotIn('98.76', json.dumps(result))
        self.assertNotIn('password', json.dumps(result))

    def test_future_submission_or_observation_cannot_be_source_evidence(self):
        for changes in ({'observed_at': '2026-10-12T02:00:00Z'},
                        {'submitted_at': '2026-10-11T02:00:00Z'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                s.normalize_observation(elc_observation(**changes))

    def test_gradescope_own_receipt_does_not_invent_submission_time(self):
        result = s.normalize_observation(gradescope_observation(score=98.76, feedback='private'))
        self.assertEqual(result['status'], 'submitted')
        self.assertIsNone(result.get('submitted_at'))
        self.assertNotIn('98.76', json.dumps(result))
        self.assertNotIn('private', json.dumps(result))

    def test_gradescope_source_course_assignment_and_receipt_identity_are_pinned(self):
        url = gradescope_observation()['source_url']
        cases = ({'course_code': 'MGMT4280'}, {'kind': 'quiz'},
                 {'source_url': url.replace('/1353639/', '/999/')},
                 {'source_url': url.replace('/8402934/', '/111/')},
                 {'source_url': url.replace('/432669080', '/222')},
                 {'source_url': 'https://www.gradescope.com/courses/1353639'},
                 {'source_url': url + '?token=private'})
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                s.normalize_observation(gradescope_observation(**changes))

    def test_elc_own_results_ui_url_is_receipt_evidence(self):
        result = s.normalize_observation(elc_ui_observation())
        self.assertEqual(result['provider_item_id'], 'quiz:4926291:attempt:80147309')
        self.assertEqual(result['source_url'], ELC_UI_RECEIPT)
        self.assertEqual(result['submitted_at'], '2026-10-06T17:29:00+00:00')
        self.assertEqual(result['due_at'], '2026-10-08T03:59:00+00:00')

    def test_elc_ui_results_url_must_match_course_quiz_and_attempt(self):
        changes = ('ou=3962245', 'qi=4926291', 'ai=80147309')
        for field in changes:
            with self.subTest(field=field), self.assertRaises(ValueError):
                s.normalize_observation(elc_ui_observation(source_url=ELC_UI_RECEIPT.replace(field, field.split('=')[0] + '=999')))

    def test_elc_quiz_summary_or_start_url_is_not_a_submission_receipt(self):
        for route in ('quiz_summary.d2l', 'quiz_start.d2l', 'quiz_attempt.d2l'):
            with self.subTest(route=route), self.assertRaises(ValueError):
                s.normalize_observation(elc_ui_observation(source_url=ELC_UI_RECEIPT.replace('quiz_submissions_attempt.d2l', route)))

    def test_elc_ui_receipt_cannot_include_foreign_user_or_extra_query(self):
        for extra in ('&userId=999', '&uid=999', '&userId=', '&otherUser=', '&ou=999', '&qi=999', '&ai=999'):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                s.normalize_observation(elc_ui_observation(source_url=ELC_UI_RECEIPT + extra))


class ExactMatchingTests(FixedClockTests):
    def matches(self, obs, rows, progress=None):
        return s.match_deadlines(s.normalize_observation(obs), rows, progress or [])

    def test_chapter_exercise_never_clears_the_same_chapter_quiz(self):
        exercise = deadline()
        quiz = deadline(title='MGMT 5560 Chapter 5 Quiz', assignment_id='quiz5')
        matches, _ = self.matches(observation(), [exercise, quiz])
        self.assertEqual([r['assignment_id'] for r in matches], [exercise['assignment_id']])

    def test_only_exact_chapter_kind_course_and_term_can_match(self):
        wrong = [deadline(title='Chapter 4 Exercises', assignment_id='chapter4'),
                 deadline(course_code='MGMT5850', assignment_id='other-course'),
                 deadline(term_id='fall-2025', assignment_id='old-term')]
        matches, reason = self.matches(observation(), wrong)
        self.assertEqual(matches, [])
        self.assertTrue(reason)

    def test_unique_google_elc_mirrors_on_same_eastern_day_are_both_bound(self):
        mirror = deadline(assignment_id='google-chapter5', source_namespace='google', source='Google Calendar',
                          title='MGMT 5560 — GLO-BUS Chapter 5 Exercises — Due', when_iso='2026-10-10T02:00:00Z')
        matches, _ = self.matches(observation(), [deadline(), mirror])
        self.assertEqual({r['assignment_id'] for r in matches}, {deadline()['assignment_id'], mirror['assignment_id']})

    def test_real_elc_chapter_exercise_word_order_matches_google_mirror(self):
        elc = deadline(title='GLOBUS Chapter Exercise 5 due')
        mirror = deadline(assignment_id='google-chapter5', source_namespace='google', source='Google Calendar',
                          title='MGMT 5560 — GLO-BUS Chapter 5 Exercises — Due')
        matches, _ = self.matches(observation(), [elc, mirror])
        self.assertEqual({r['assignment_id'] for r in matches}, {elc['assignment_id'], mirror['assignment_id']})

    def test_real_elc_chapter_quiz_alias_never_clears_an_exercise(self):
        quiz = deadline(title='GLOBUS Chapter Quiz 5 due', assignment_id='quiz5')
        obs = observation(kind='chapter_quiz', title='Chapter 5 Quiz', provider_item_id='chapter:5:quiz')
        matches, _ = self.matches(obs, [quiz, deadline(title='GLOBUS Chapter Exercise 5 due')])
        self.assertEqual([r['assignment_id'] for r in matches], ['quiz5'])

    def test_elc_course_prefix_with_optional_e_and_due_suffix_are_normalized(self):
        obs = elc_observation(course_code='BUSN3040', kind='assignment', title='Exercise 5',
                              provider_item_id='assignment:100:submission:200',
                              source_url='https://uga.view.usg.edu/d2l/api/le/1.82/3955142/dropbox/folders/100/submissions/mysubmissions/')
        row = deadline(course_code='BUSN3040', title='BUSN 3040E — Exercise 5 — Due', assignment_id='exercise5')
        matches, _ = self.matches(obs, [row])
        self.assertEqual([r['assignment_id'] for r in matches], ['exercise5'])

    def test_same_utc_date_but_different_eastern_due_dates_are_ambiguous(self):
        mirror = deadline(assignment_id='google-chapter5', source_namespace='google', source='Google Calendar',
                          when_iso='2026-10-10T04:00:00Z')
        matches, reason = self.matches(observation(), [deadline(), mirror])
        self.assertEqual(matches, [])
        self.assertTrue(reason)

    def test_two_same_source_occurrences_cannot_be_guessed(self):
        for duplicate in (deadline(assignment_id='other-source-item'),
                          deadline(assignment_id='later-occurrence', when_iso='2026-10-17T03:59:00Z')):
            matches, reason = self.matches(observation(), [deadline(), duplicate])
            self.assertEqual(matches, [])
            self.assertTrue(reason)

    def test_elc_exact_title_and_due_date_selects_the_current_occurrence(self):
        rows = [deadline(course_code='BUSN5000', title='Quiz 5', assignment_id='quiz5'),
                deadline(course_code='BUSN5000', title='Quiz 5', assignment_id='laterquiz5', when_iso='2026-10-17T03:59:00Z'),
                deadline(course_code='MGMT4280', title='Quiz 5', assignment_id='othercoursequiz5')]
        matches, _ = self.matches(elc_observation(), rows)
        self.assertEqual([r['assignment_id'] for r in matches], ['quiz5'])

    def test_elc_unique_title_without_due_date_still_needs_a_source_reference(self):
        row = deadline(course_code='BUSN5000', title='Quiz 5', assignment_id='quiz5')
        matches, reason = self.matches(elc_observation(due_at=None), [row])
        self.assertEqual(matches, [])
        self.assertTrue(reason)

    def test_old_elc_receipt_cannot_clear_reused_current_title_without_history(self):
        row = deadline(course_code='BUSN5000', title='Quiz 5', assignment_id='quiz5-new', when_iso='2026-10-17T03:59:00Z')
        obs = elc_observation(due_at=None, submitted_at='2026-09-12T03:00:00Z')
        matches, reason = self.matches(obs, [row])
        self.assertEqual(matches, [])
        self.assertTrue(reason)

    def test_exact_elc_source_reference_can_identify_the_occurrence_without_due_date(self):
        row = deadline(course_code='BUSN5000', title='Quiz 5', assignment_id='quiz5-source')
        matches, _ = self.matches(elc_observation(due_at=None, source_assignment_id='quiz5-source'), [row])
        self.assertEqual([r['assignment_id'] for r in matches], ['quiz5-source'])

    def test_gradescope_unique_current_title_without_due_date_needs_reference(self):
        row = deadline(course_code='BUSN5000', title='Homework 5', assignment_id='homework5')
        matches, reason = self.matches(gradescope_observation(), [row])
        self.assertEqual(matches, [])
        self.assertTrue(reason)

    def test_verified_land_exam_ui_receipt_matches_exact_exam_title_and_due(self):
        exam = deadline(course_code='LAND2510', title='Exam #2', assignment_id='land-exam2', when_iso='2026-10-08T03:59:00Z')
        wrong = deadline(course_code='LAND2510', title='Exam #3', assignment_id='land-exam3', when_iso=exam['when_iso'])
        matches, _ = self.matches(elc_ui_observation(), [exam, wrong])
        self.assertEqual([r['assignment_id'] for r in matches], ['land-exam2'])

    def test_different_exam_module_titles_are_not_guessed_from_a_shared_due_date(self):
        module = deadline(course_code='LAND2510', title='Module 4', assignment_id='land-module4', when_iso='2026-10-08T03:59:00Z')
        matches, reason = self.matches(elc_ui_observation(), [module])
        self.assertEqual(matches, [])
        self.assertTrue(reason)

    def test_elc_reused_title_with_old_progress_and_no_due_date_needs_review(self):
        row = deadline(course_code='BUSN5000', title='Quiz 5', assignment_id='quiz5-current')
        old = {'course': 'BUSN5000', 'item': 'Quiz 5', 'term_id': 'fall-2026',
               'assignment_id': 'quiz5-old', 'when_iso': '2026-09-12T03:59:00Z', 'status': 'done'}
        matches, reason = self.matches(elc_observation(due_at=None), [row], [old])
        self.assertEqual(matches, [])
        self.assertTrue(reason)

    def test_elc_similar_titles_do_not_match_by_substring(self):
        row = deadline(course_code='BUSN5000', title='Quiz 5 practice', assignment_id='practice')
        matches, _ = self.matches(elc_observation(), [row])
        self.assertEqual(matches, [])


class DurableReconciliationTests(FixedClockTests):
    def setUp(self):
        super().setUp()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / 'submission-outbox.json'
        self.bridge = Bridge()
        self.messages = []

    def run_reconcile(self, rows=None, **kwargs):
        return s.reconcile([observation()] if rows is None else rows, config=CONFIG,
                           state_path=self.state, request=self.bridge.request,
                           log=self.messages.append, **kwargs)

    def test_saved_requires_exact_receipt_and_progress_readback(self):
        result = self.run_reconcile()
        self.assertEqual(result['saved'], 1)
        self.assertEqual(result['pending'], 0)
        self.assertEqual(len(self.bridge.posts), 1)
        payload, key = self.bridge.posts[0]
        self.assertTrue(key)
        for field in ('assignment_id', 'when_iso', 'term_id'):
            self.assertEqual(payload[field], deadline()[field])
        self.assertEqual(payload['status'], 'done')
        self.assertEqual(payload['verification'], 'verified')
        self.assertIn('Codex', payload['note'])
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o600)
        post_index = next(i for i, call in enumerate(self.bridge.calls) if call[0] == 'POST')
        self.assertTrue(any(call[0] == 'GET' and urlsplit(call[1]).path == '/progress'
                            for call in self.bridge.calls[post_index + 1:]))

    def test_receipt_without_matching_readback_stays_pending(self):
        self.bridge.false_readback = True
        result = self.run_reconcile()
        self.assertEqual(result['saved'], 0)
        self.assertGreater(result['pending'], 0)
        self.assertTrue(self.state.exists())

    def test_mismatched_receipt_cannot_report_saved(self):
        self.bridge.bad_receipt = True
        result = self.run_reconcile()
        self.assertEqual(result['saved'], 0)
        self.assertGreater(result['pending'], 0)

    def test_receipt_requires_matching_course_item_and_due_occurrence(self):
        for changes in ({'course': 'MGMT5850'}, {'item': 'Different requirement'},
                        {'when_iso': '2026-10-17T03:59:00Z'}):
            with self.subTest(changes=changes):
                self.bridge = Bridge()
                self.bridge.receipt_overrides = changes
                target = Path(self.temp.name) / ('receipt-' + next(iter(changes)) + '.json')
                result = s.reconcile([observation()], config=CONFIG, state_path=target,
                                     request=self.bridge.request)
                self.assertEqual(result['saved'], 0)
                self.assertGreater(result['pending'], 0)

    def test_same_or_lower_inconsistent_readback_cannot_confirm_a_receipt(self):
        for index, changes in enumerate(({'revision': 0}, {'revision': 1, 'evidence': 'Different evidence at the same revision.'})):
            with self.subTest(changes=changes):
                self.bridge = Bridge()
                self.bridge.readback_overrides = changes
                target = Path(self.temp.name) / f'inconsistent-readback-{index}.json'
                result = s.reconcile([observation()], config=CONFIG, state_path=target, request=self.bridge.request)
                self.assertEqual(result['saved'], 0)
                self.assertEqual(result['already_verified'], 0)
                self.assertGreater(result['pending'], 0)

    def test_progress_readback_requires_the_same_due_occurrence(self):
        self.bridge.readback_overrides = {'when_iso': '2026-10-17T03:59:00Z'}
        result = self.run_reconcile()
        self.assertEqual(result['saved'], 0)
        self.assertGreater(result['pending'], 0)

    def test_lost_response_retries_same_operation_and_exact_payload(self):
        self.bridge.fail_after_commit = True
        first = self.run_reconcile()
        self.assertEqual(first['saved'], 0)
        self.assertGreater(first['pending'], 0)
        first_payload, first_key = copy.deepcopy(self.bridge.posts[0])
        second = self.run_reconcile([])
        self.assertEqual(second['saved'], 1)
        self.assertEqual(len(self.bridge.posts), 2)
        self.assertEqual(self.bridge.posts[1], (first_payload, first_key))

    def test_retry_cannot_rebind_uncertain_operation_to_new_calendar_identity(self):
        self.bridge.fail_after_commit = True
        self.run_reconcile()
        original_payload, original_key = copy.deepcopy(self.bridge.posts[0])
        self.bridge.rows = [deadline(assignment_id='new-reused-title', when_iso='2026-10-17T03:59:00Z')]
        self.run_reconcile([])
        self.assertEqual(self.bridge.posts[-1], (original_payload, original_key))

    def test_replayed_receipt_with_newer_verified_readback_retires_pending_without_overwrite(self):
        self.bridge.fail_after_commit = True
        first = self.run_reconcile()
        self.assertEqual(first['pending'], 1)
        original_payload, original_key = copy.deepcopy(self.bridge.posts[0])
        self.bridge.progress[0].update(revision=2, evidence='Independent stronger verified source receipt.',
                                       note='A newer authorized client verified this same submission.')
        newer = copy.deepcopy(self.bridge.progress[0])
        retry = self.run_reconcile([])
        self.assertEqual(retry['saved'], 0)
        self.assertEqual(retry['already_verified'], 1)
        self.assertEqual(retry['pending'], 0)
        self.assertEqual(self.bridge.progress, [newer])
        self.assertEqual(len(self.bridge.receipts), 1)
        self.assertEqual(self.bridge.posts, [(original_payload, original_key), (original_payload, original_key)])
        next_retry = self.run_reconcile([])
        self.assertEqual(next_retry['pending'], 0)
        self.assertEqual(len(self.bridge.posts), 2)

    def test_newer_readback_cannot_supersede_receipt_for_another_identity_or_unverified_work(self):
        changes = ({'when_iso': '2026-10-17T03:59:00Z'}, {'term_id': 'fall-2025'},
                   {'course': 'MGMT5850'}, {'item': 'Different requirement'},
                   {'assignment_id': 'different-assignment'}, {'record_id': 'different-record'},
                   {'verification': 'reported'}, {'status': 'in_progress'})
        for index, fields in enumerate(changes):
            with self.subTest(fields=fields):
                self.bridge = Bridge()
                self.bridge.fail_after_commit = True
                target = Path(self.temp.name) / f'supersession-{index}.json'
                s.reconcile([observation()], config=CONFIG, state_path=target, request=self.bridge.request)
                self.bridge.progress[0].update(revision=2, evidence='Newer source statement.', **fields)
                current = copy.deepcopy(self.bridge.progress)
                retry = s.reconcile([], config=CONFIG, state_path=target, request=self.bridge.request)
                self.assertEqual(retry['saved'], 0)
                self.assertEqual(retry['already_verified'], 0)
                self.assertEqual(retry['pending'], 1)
                self.assertEqual(self.bridge.progress, current)
                self.assertEqual(len(self.bridge.receipts), 1)

    def test_existing_verified_record_is_not_rewritten_or_downgraded(self):
        self.bridge.progress = [{'record_id': 'verified-prior', 'revision': 7, 'course': 'MGMT5560',
                                 'item': deadline()['title'], 'assignment_id': deadline()['assignment_id'],
                                 'term_id': 'fall-2026', 'when_iso': DUE, 'status': 'done',
                                 'verification': 'verified', 'evidence': 'Existing stronger portal receipt.',
                                 'identity_resolution': 'linked'}]
        result = self.run_reconcile()
        self.assertEqual(result['already_verified'], 1)
        self.assertEqual(self.bridge.posts, [])
        self.assertEqual(self.bridge.progress[0]['revision'], 7)

    def test_reported_completion_is_upgraded_with_current_revision(self):
        self.bridge.progress = [{'record_id': 'reported-prior', 'revision': 3, 'course': 'MGMT5560',
                                 'item': deadline()['title'], 'assignment_id': deadline()['assignment_id'],
                                 'term_id': 'fall-2026', 'when_iso': DUE, 'status': 'done',
                                 'verification': 'reported', 'identity_resolution': 'linked'}]
        result = self.run_reconcile()
        self.assertEqual(result['saved'], 1)
        self.assertEqual(self.bridge.posts[0][0]['expected_revision'], 3)
        self.assertEqual(self.bridge.posts[0][0]['record_id'], 'reported-prior')

    def test_revision_conflict_rereads_and_rebases_without_duplicate_completion(self):
        self.bridge.conflict = True
        self.run_reconcile()
        self.run_reconcile()
        self.assertGreaterEqual(len(self.bridge.posts), 2)
        rebased = self.bridge.posts[-1][0]
        self.assertEqual(rebased['expected_revision'], 2)
        self.assertEqual(rebased['record_id'], 'existing')
        self.assertNotEqual(self.bridge.posts[0][1], self.bridge.posts[-1][1])
        self.assertEqual(len(self.bridge.progress), 1)
        self.assertEqual(self.bridge.progress[0]['verification'], 'verified')

    def test_pending_revision_conflict_cannot_drop_an_observed_receipt(self):
        original = self.bridge.request
        def before_commit(method, path, payload=None, operation_id=None):
            if method == 'POST':
                raise OSError('synthetic disconnected before commit')
            return original(method, path, payload, operation_id)
        first = s.reconcile([observation()], config=CONFIG, state_path=self.state, request=before_commit)
        self.assertEqual(first['pending'], 1)
        self.bridge.conflict = True
        retry = self.run_reconcile([])
        self.assertTrue(retry['saved'] == 1 or retry['pending'] > 0,
                        'A conclusively rejected prior save still has observed evidence to reconcile.')

    def test_corrupt_outbox_is_preserved_and_never_authorizes_a_write(self):
        original = '{"pending": "private malformed value"}'
        self.state.write_text(original)
        try:
            result = self.run_reconcile()
        except ValueError:
            result = {'saved': 0}
        self.assertEqual(result['saved'], 0)
        self.assertEqual(self.bridge.posts, [])
        self.assertEqual(self.state.read_text(), original)

    def test_dry_run_never_posts_or_touches_state(self):
        prior = '{"pending": {}, "receipts": {"prior": true}}'
        self.state.write_text(prior)
        self.run_reconcile(dry=True)
        self.assertEqual(self.bridge.posts, [])
        self.assertEqual(self.state.read_text(), prior)

    def test_dry_run_with_no_state_creates_no_private_files(self):
        self.run_reconcile(dry=True)
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])

    def test_duplicate_observations_do_not_create_duplicate_done_records(self):
        result = self.run_reconcile([observation(), observation()])
        self.assertEqual(result['saved'], 1)
        self.assertEqual(len(self.bridge.posts), 1)
        self.assertEqual(len(self.bridge.progress), 1)

    def test_explicit_incomplete_status_cannot_authorize_a_progress_write(self):
        original = self.bridge.request
        def partial(method, path, payload=None, operation_id=None):
            result = original(method, path, payload, operation_id)
            if method == 'GET' and urlsplit(path).path == '/status':
                result['response_completeness'] = {'complete': False}
            return result
        result = s.reconcile([observation()], config=CONFIG, state_path=self.state, request=partial)
        self.assertEqual(result['saved'], 0)
        self.assertEqual(self.bridge.posts, [])

    def test_invalid_and_unmatched_observations_never_post(self):
        result = self.run_reconcile([observation(status='in_progress'), observation(chapter=6,
                                    title='Chapter 6 Exercises', provider_item_id='chapter:6:exercise')])
        self.assertEqual(result['invalid'], 1)
        self.assertEqual(result['unmatched'], 1)
        self.assertEqual(self.bridge.posts, [])

    def test_transport_errors_are_logged_without_raw_secrets_or_scores(self):
        def unavailable(*args, **kwargs):
            raise OSError('private bearer=secret response Grade: 98.76')
        result = s.reconcile([observation()], config=CONFIG, state_path=self.state,
                             request=unavailable, log=self.messages.append)
        self.assertEqual(result['saved'], 0)
        self.assertNotIn('secret', str(result))
        self.assertNotIn('98.76', str(result))
        self.assertNotIn('secret', str(self.messages))
        self.assertNotIn('98.76', str(self.messages))


class TransportDestinationTests(unittest.TestCase):
    def test_canonical_and_forwarding_hosts_use_mocked_authenticated_transport(self):
        for host in ('ijuh2yp6rf.example-subdomain.workers.dev', 'coursework.example-subdomain.workers.dev'):
            with self.subTest(host=host), patch.object(s.urllib.request, 'build_opener') as opener:
                opener.return_value.open.return_value = io.BytesIO(b'{"ok":true}')
                request = s.transport({**CONFIG, 'WORKER_URL': 'https://' + host})
                self.assertEqual(request('GET', '/status?course=LAND2510'), {'ok': True})
                sent = opener.return_value.open.call_args.args[0]
                self.assertEqual(urlsplit(sent.full_url).hostname, host)
                self.assertEqual(sent.get_header('Authorization'), 'Bearer test-only')
                self.assertIsInstance(opener.call_args.args[0], s.NoRedirect)

    def test_unapproved_or_credential_redirect_destinations_are_rejected_before_network(self):
        urls = ('https://evil.example.test', 'http://ijuh2yp6rf.example-subdomain.workers.dev',
                'https://user:password@ijuh2yp6rf.example-subdomain.workers.dev',
                'https://ijuh2yp6rf.example-subdomain.workers.dev?token=private',
                'https://ijuh2yp6rf.example-subdomain.workers.dev#redirect')
        with patch.object(s.urllib.request, 'build_opener') as opener:
            for url in urls:
                with self.subTest(url=url), self.assertRaises(ValueError):
                    s.transport({**CONFIG, 'WORKER_URL': url})
            opener.assert_not_called()

    def test_redirect_handler_never_follows_a_bearer_request_elsewhere(self):
        self.assertIsNone(s.NoRedirect().redirect_request(None, None, 302, 'redirect', {}, 'https://evil.example.test'))


if __name__ == '__main__':
    unittest.main()
