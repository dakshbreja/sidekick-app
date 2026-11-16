import importlib.util
import json
from pathlib import Path
import os
import sys
import subprocess
import tempfile
from contextlib import ExitStack
from datetime import datetime, timezone
from types import SimpleNamespace
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / 'bin/globus_watch.py'
spec = importlib.util.spec_from_file_location('watch_completion', source)
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)

STAMP = '2026-10-11T01:00:00Z'
NOW = datetime.fromisoformat(STAMP.replace('Z', '+00:00'))
SOURCE = watch.LOBBY + 'assignments/student-grades'


def page(*rows, **kwargs):
    return {'source_url': SOURCE, 'receipt_rows': [{'cells': row} for row in rows], **kwargs}


class CompletionObservationTests(unittest.TestCase):
    def setUp(self):
        # A failed cooldown assertion must fail locally, never open a real tab.
        for name in ('is_running', 'open_tab', 'run_js', 'run_js_json', 'find_tabs',
                     'wait_loaded', 'close_tab'):
            blocked = patch.object(watch.cb, name, side_effect=AssertionError('unexpected browser operation'))
            blocked.start()
            self.addCleanup(blocked.stop)

    def read(self, *rows):
        return watch.completion_observations([page(*rows)], STAMP)

    def test_explicit_exercise_receipt_distinguishes_the_same_chapter_quiz(self):
        observations = self.read(['Chapter 5 Exercises', 'Completed'],
                                 ['Chapter 5 Quiz', 'Submitted'])
        self.assertEqual([item['kind'] for item in observations],
                         ['chapter_exercise', 'chapter_quiz'])
        self.assertEqual([item['provider_item_id'] for item in observations],
                         ['chapter:5:exercise', 'chapter:5:quiz'])
        self.assertEqual([item['status'] for item in observations], ['completed', 'submitted'])
        self.assertTrue(all(item['course_code'] == 'MGMT5560' for item in observations))
        self.assertTrue(all(item['term_id'] == 'fall-2026' for item in observations))

    def test_grade_matrix_numbers_are_not_completion_receipts(self):
        self.assertEqual(self.read(['CHAPTER', '5', '6'], ['SCORE', '88', '99']), [])
        self.assertEqual(self.read(['Chapter 5 Exercises', '100'],
                                  ['Chapter 5 Quiz', '0']), [])

    def test_schedule_dates_and_past_decision_years_are_not_proof(self):
        self.assertEqual(self.read(['Deadline: Chapter 5 Exercises', '5-Oct-2026, 11:59 PM'],
                                  ['Decision Year 8', 'Completed']), [])

    def test_only_supported_source_pages_and_live_sessions_qualify(self):
        for extra in ({'source_url': 'https://other.example.test'}, {'signedIn': False},
                      {'source_url': 'http://www.glo-bus.com/users/lobby/assignments/student-grades'}):
            self.assertEqual(watch.completion_observations(
                [page(['Chapter 5 Exercises', 'Completed'], **extra)], STAMP), [])

    def test_unknown_labels_and_aggregate_completion_do_not_clear_an_assignment(self):
        for title in ('Chapter 5', 'Exercises', 'Simulation Year 9', 'Chapter 15 Exercises',
                      'Chapter 5 Exercises and Quiz', 'Available: Chapter 5 Exercises'):
            self.assertEqual(self.read([title, 'Completed']), [])

    def test_incomplete_or_in_progress_states_do_not_count(self):
        for status in ('Incomplete', 'Not completed', 'Not Submitted', 'No Submission',
                       'In progress', 'Pending', 'Completed 2 of 5', 'Resume',
                       'Last completed attempt', 'Completion Score: 99'):
            self.assertEqual(self.read(['Chapter 5 Exercises', status]), [])

    def test_contradictory_status_invalidates_the_row(self):
        self.assertEqual(self.read(['Chapter 5 Exercises', 'Completed', 'In progress']), [])
        self.assertEqual(self.read(['Chapter 5 Exercises', 'Completed', 'No Submission']), [])

    def test_actual_hourly_dom_projection_preserves_and_rejects_contradictory_states(self):
        fixtures = [['Chapter 5 Exercises', 'Completed', status, 'Score: 98.76']
                    for status in ('In progress', 'No Submission', 'Not completed',
                                   'Not yet submitted', 'Not fully completed', 'Pending')]
        fixtures.append(['Chapter 5 Exercises', 'Completed', 'Score: 98.76'])
        # Execute the shipped source projection against an offline DOM surface.
        # No browser, page network or native UI is available to this fixture.
        script = r'''
const vm = require('node:vm');
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const results = input.rows.map(cells => {
  const row = {querySelectorAll: () => cells.map(innerText => ({innerText}))};
  const document = {body: {innerText: 'Student Grades'}, querySelectorAll: selector =>
    selector === 'table tr' ? [row] : []};
  return JSON.parse(vm.runInNewContext(input.projection, {document}));
});
process.stdout.write(JSON.stringify(results));
'''
        run = subprocess.run(['node', '-e', script],
                             input=json.dumps({'projection': watch.COMPLETION_SOURCES_JS, 'rows': fixtures}),
                             capture_output=True, text=True, timeout=10, check=True)
        results = json.loads(run.stdout)
        for source, original in zip(results[:-1], fixtures[:-1]):
            self.assertEqual(source['receipt_rows'][0]['cells'][2], original[2])
            self.assertEqual(watch.completion_observations([dict(source, source_url=SOURCE)], STAMP), [])
            self.assertNotIn('98.76', json.dumps(source))
        safe_positive = watch.completion_observations([dict(results[-1], source_url=SOURCE)], STAMP)
        self.assertEqual(len(safe_positive), 1)
        self.assertNotIn('98.76', json.dumps(results[-1]))

    def test_ambiguous_rows_with_two_assignment_titles_clear_nothing(self):
        self.assertEqual(self.read(['Chapter 5 Exercises', 'Chapter 5 Quiz', 'Completed']), [])
        self.assertEqual(self.read(['Chapter 5 Exercises', 'Submitted', 'Completed']), [])

    def test_receipt_output_cannot_contain_score_cells_or_other_private_details(self):
        item = self.read(['Chapter 5 Exercises', 'Completed', 'Score: 98.76',
                          'private email: secret@example.test'])[0]
        self.assertNotIn('98.76', str(item))
        self.assertNotIn('secret@example.test', str(item))
        self.assertEqual(item['source_evidence'], 'GLO-BUS shows completed for Chapter 5 Exercises.')

    def test_explicit_timezone_timestamp_is_preserved_when_before_observation(self):
        item = self.read(['Chapter 5 Exercises', 'Submitted on 2026-10-10T13:05:00-04:00'])[0]
        self.assertEqual(item['submitted_at'], '2026-10-10T13:05:00-04:00')

    def test_timestamp_without_clock_or_timezone_is_not_invented(self):
        for timestamp in ('October 10, 2026', '2026-10-10T13:05:00', 'tomorrow',
                          '2026-10-12T13:05:00Z', '2026-99-10T13:05:00Z'):
            item = self.read(['Chapter 5 Exercises', f'Completed on {timestamp}'])[0]
            self.assertNotIn('submitted_at', item)

    def test_invalid_observation_time_yields_no_proof(self):
        for timestamp in (None, 'unknown', '2026-10-10T13:00:00'):
            self.assertEqual(watch.completion_observations(
                [page(['Chapter 5 Exercises', 'Completed'])], timestamp), [])

    def test_duplicate_receipts_keep_one_stable_item_and_prefer_submission(self):
        items = self.read(['Chapter 5 Exercise', 'Completed'],
                          ['Chapter 5 Exercises', 'Submitted'])
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['provider_item_id'], 'chapter:5:exercise')
        self.assertEqual(items[0]['status'], 'submitted')

    def test_fetch_extracts_receipts_but_does_not_promote_a_grade(self):
        schedule = {'rows': ['Deadline: Chapter 5 Exercises || 8-Oct-2026, 11:59 PM'],
                    'receipt_rows': [{'cells': ['Deadline: Chapter 5 Exercises', 'Completed']}]}
        grades = {'grades': ['Chapter 5 Quiz | 88.8'],
                  'receipt_rows': [{'cells': ['Chapter 5 Quiz', '88.8']}]}
        with patch.object(watch, 'read_page', side_effect=[schedule, grades]):
            state = watch.fetch_state()
        self.assertEqual(len(state['completions']), 1)
        self.assertEqual(state['completions'][0]['kind'], 'chapter_exercise')
        self.assertEqual(state['completions'][0]['observed_at'], state['at'])
        self.assertNotIn('88.8', str(state['completions']))
        self.assertNotIn('receipt_rows', state)

    def test_cache_retry_preserves_the_original_observation_and_dry_run(self):
        original = self.read(['Chapter 5 Exercises', 'Completed'])
        calls = []
        fake = SimpleNamespace(reconcile=lambda values, **kwargs: calls.append((values, kwargs)))
        with patch.dict(sys.modules, {'submission_reconcile': fake}):
            watch.reconcile_completions({'data': {'completions': original}}, dry=True)
        self.assertEqual(calls[0][0], original)
        self.assertEqual(calls[0][0][0]['observed_at'], STAMP)
        self.assertTrue(calls[0][1]['dry'])

    def test_reconciliation_error_retains_evidence_without_exposing_request_content(self):
        observations = self.read(['Chapter 5 Exercises', 'Completed'])

        def failed(*args, **kwargs):
            raise RuntimeError('private bearer=secret response Grade: 98.76')

        fake = SimpleNamespace(reconcile=failed)
        state = {'data': {'completions': observations}}
        with patch.dict(sys.modules, {'submission_reconcile': fake}), patch.object(watch, 'log') as log:
            self.assertIsNone(watch.reconcile_completions(state))
        self.assertEqual(state['data']['completions'], observations)
        self.assertNotIn('secret', str(log.call_args_list))
        self.assertNotIn('98.76', str(log.call_args_list))

    def test_cached_receipt_retry_runs_before_browser_throttle(self):
        state = {'checked_epoch': 99999999, 'completion_checked_epoch': 99999999, 'data': {'completions': self.read(
            ['Chapter 5 Exercises', 'Completed'])}}
        with patch.object(watch, 'load_json', return_value=state), \
                patch.object(watch.time, 'time', return_value=100000000), \
                patch.object(watch, 'check_calendar', return_value=True), \
                patch.object(watch, 'reconcile_completions') as reconcile, \
                patch.object(watch.cb, 'is_running') as browser, \
                patch.object(sys, 'argv', ['globus_watch.py']):
            self.assertEqual(watch.main(), 0)
        reconcile.assert_called_once_with(state, dry=False)
        browser.assert_not_called()

    def test_private_legacy_state_and_safe_receipts_are_saved_owner_only(self):
        with tempfile.TemporaryDirectory() as directory:
            target = str(Path(directory) / 'state.json')
            watch.save_json(target, {'completions': self.read(['Chapter 5 Exercises', 'Completed'])})
            self.assertEqual(os.stat(target).st_mode & 0o777, 0o600)

    def test_interrupted_save_keeps_the_prior_cache_and_cleans_temporary_data(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'state.json'
            target.write_text('{"prior":true}')
            with patch.object(watch.json, 'dump', side_effect=OSError('unavailable')):
                with self.assertRaises(OSError):
                    watch.save_json(str(target), {'new': True})
            self.assertEqual(target.read_text(), '{"prior":true}')
            self.assertEqual([p.name for p in Path(directory).iterdir()], ['state.json'])

    def test_review_targets_are_bounded_to_past_current_term_enrolled_exercises(self):
        schedule = {'rows': ['Deadline: Chapter 1 Exercises || 9-Sep-2026, 11:59 PM',
                             'Deadline: Chapter 5 Exercises || 30-Sep-2026, 11:59 PM',
                             'Deadline: Chapter 9 Exercises || 4-Nov-2026, 11:59 PM',
                             'Deadline: Chapter 7 Quiz || 7-Oct-2026, 11:59 PM']}
        sources = {'completion_sources': [{'url': f'https://www.glo-bus.com/textbook/chex/{chapter}'}
                                           for chapter in (1, 2, 5, 7, 9)]}
        targets = watch.exercise_review_targets(sources, schedule, datetime(2026, 10, 11, tzinfo=timezone.utc))
        self.assertEqual([r['chapter'] for r in targets], [5])
        self.assertTrue(all('/review/' in r['source_url'] for r in targets))

    def test_different_or_conflicting_term_cannot_reuse_chapter_numbers(self):
        sources = {'completion_sources': [{'url': 'https://www.glo-bus.com/textbook/chex/5'}]}
        for rows in ([], ['Deadline: Chapter 5 Exercises || 30-Sep-2025, 11:59 PM'],
                     ['Deadline: Chapter 5 Exercises || 30-Sep-2026, 11:59 PM',
                      'Deadline: Chapter 7 Quiz || 7-Oct-2027, 11:59 PM']):
            schedule = {'rows': rows}
            self.assertFalse(watch.current_term_schedule(schedule))
            self.assertEqual(watch.exercise_review_targets(sources, schedule), [])

    def test_expired_link_absence_cannot_erase_an_audited_review_source(self):
        schedule = {'rows': ['Deadline: Chapter 5 Exercises || 30-Sep-2026, 11:59 PM']}
        for url in ('https://other.test/textbook/chex/5', 'https://www.glo-bus.com/textbook/chex/5?token=secret',
                    'http://www.glo-bus.com/textbook/chex/5',
                    'https://user:password@www.glo-bus.com/textbook/chex/5',
                    'https://www.glo-bus.com:443/textbook/chex/5',
                    'https://www.glo-bus.com/textbook/chex/6'):
            targets = watch.exercise_review_targets({'completion_sources': [{'url': url}]}, schedule, NOW)
            self.assertEqual([r['source_url'] for r in targets],
                             ['https://www.glo-bus.com/textbook/chex/review/5'])
        self.assertEqual([r['chapter'] for r in watch.exercise_review_targets({}, schedule, NOW)], [5])

    def test_both_actual_expired_exercises_are_checked_without_gradebook_hrefs(self):
        schedule = {'rows': ['Deadline: Chapter 5 Exercises || 30-Sep-2026, 11:59 PM',
                             'Deadline: Chapter 7 Exercises || 7-Oct-2026, 11:59 PM']}
        targets = watch.exercise_review_targets({}, schedule, NOW)
        self.assertEqual([r['chapter'] for r in targets], [5, 7])
        self.assertEqual([r['source_url'] for r in targets],
                         ['https://www.glo-bus.com/textbook/chex/review/5',
                          'https://www.glo-bus.com/textbook/chex/review/7'])

    def test_unconfirmed_routes_current_day_and_old_exercises_remain_unchecked(self):
        schedules = [['Deadline: Chapter 1 Exercises || 7-Oct-2026, 11:59 PM'],
                     ['Deadline: Chapter 5 Exercises || 10-Oct-2026, 11:59 PM'],
                     ['Deadline: Chapter 5 Exercises || 29-Sep-2026, 11:59 PM']]
        for rows in schedules:
            self.assertEqual(watch.exercise_review_targets({}, {'rows': rows}, NOW), [])

    def test_review_does_not_treat_any_question_icon_pattern_as_completed(self):
        target = {'chapter': 5, 'source_url': 'https://www.glo-bus.com/textbook/chex/review/5'}
        for marked in (0, 3, 6):
            self.assertIsNone(watch.review_completion_observation(
                {'question_count': 6, 'marked_question_count': marked,
                 'unmarked_question_count': 6 - marked, 'receipt_lines': []}, target, STAMP))

    def test_review_requires_a_whole_exercise_completion_statement(self):
        target = {'chapter': 5, 'source_url': 'https://www.glo-bus.com/textbook/chex/review/5'}
        for line in ('You have completed question 1.', 'All exercises are incomplete.',
                     'Chapter 7 Exercises completed.', 'You have not completed all exercises.',
                     'Complete all exercises.', 'You have completed 3 of 6 exercises.'):
            self.assertIsNone(watch.review_completion_observation(
                {'question_count': 6, 'receipt_lines': [line]}, target, STAMP))
        observation = watch.review_completion_observation(
            {'question_count': 6, 'receipt_lines': ['You have completed all exercises.']}, target, STAMP)
        self.assertEqual(observation['provider_item_id'], 'chapter:5:exercise')
        self.assertEqual(observation['source_url'], target['source_url'])

    def test_review_positive_statement_cannot_override_a_contradictory_negative_statement(self):
        target = {'chapter': 5, 'source_url': 'https://www.glo-bus.com/textbook/chex/review/5'}
        for line in ('You have not completed all exercises.',
                     'All exercises are incomplete.', 'You have not yet submitted the exercises.'):
            self.assertIsNone(watch.review_completion_observation(
                {'question_count': 6, 'receipt_lines': ['You have completed all exercises.', line]},
                target, STAMP))

    def test_actual_review_dom_projection_keeps_standalone_negative_receipts(self):
        fixtures = ['You have completed all exercises.\n' + line
                    for line in ('No Submission', 'Status: In progress', 'Not yet submitted')]
        script = r'''
const vm = require('node:vm');
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const results = input.bodies.map(innerText => {
  const links = Array.from({length: 6}, (_, i) => ({innerText: 'Q' + (i + 1), querySelector: () => null}));
  const document = {body: {innerText}, querySelectorAll: () => links};
  return JSON.parse(vm.runInNewContext(input.projection, {document}));
});
process.stdout.write(JSON.stringify(results));
'''
        run = subprocess.run(['node', '-e', script],
                             input=json.dumps({'projection': watch.COMPLETION_REVIEW_JS, 'bodies': fixtures}),
                             capture_output=True, text=True, timeout=10, check=True)
        target = {'chapter': 5, 'source_url': 'https://www.glo-bus.com/textbook/chex/review/5'}
        for projected in json.loads(run.stdout):
            self.assertEqual(len(projected['receipt_lines']), 2)
            self.assertIsNone(watch.review_completion_observation(projected, target, STAMP))

    def test_review_session_and_unavailable_page_never_produce_receipts(self):
        target = {'chapter': 5, 'source_url': 'https://www.glo-bus.com/textbook/chex/review/5'}
        for count, signed_in in ((0, True), ('6', True), (6, False)):
            self.assertIsNone(watch.review_completion_observation(
                {'question_count': count, 'signedIn': signed_in,
                 'receipt_lines': ['You have completed all exercises.']}, target, STAMP))

    def test_hourly_review_retains_unknown_coverage_without_exposing_grades_or_answers(self):
        schedule = {'rows': ['Deadline: Chapter 5 Exercises || 30-Sep-2026, 11:59 PM']}
        sources = {'completion_sources': [{'url': 'https://www.glo-bus.com/textbook/chex/5'}]}
        with patch.object(watch, 'read_page', return_value={
                'question_count': 6, 'marked_question_count': 3, 'unmarked_question_count': 3,
                'receipt_lines': [], 'score': '98.76', 'answer': 'private answer'}):
            result = watch.fetch_completion_state(schedule, sources, now=NOW)
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['observations'], [])
        self.assertEqual(result['checks'][0]['reason'], 'no_explicit_completion_receipt')
        self.assertNotIn('98.76', str(result))
        self.assertNotIn('private answer', str(result))
        self.assertNotIn('marked_question_count', str(result))

    def test_hourly_review_failure_does_not_become_an_empty_success(self):
        schedule = {'rows': ['Deadline: Chapter 5 Exercises || 30-Sep-2026, 11:59 PM']}
        sources = {'completion_sources': [{'url': 'https://www.glo-bus.com/textbook/chex/5'}]}
        with patch.object(watch, 'read_page', side_effect=watch.cb.ChromeError('failed')):
            result = watch.fetch_completion_state(schedule, sources, now=NOW)
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['checks'][0]['reason'], 'source_read_failed')
        self.assertEqual(result['observations'], [])

    def test_hourly_phase_does_not_refresh_six_hour_grade_or_schedule_state(self):
        state = {'checked_epoch': 99999999, 'data': {'grades': ['private'], 'schedule': ['prior']}}
        result = {'observed_at': STAMP, 'observations': [], 'checks': [], 'scope': 'test', 'status': 'unknown'}
        with ExitStack() as stack:
            for target, attribute, value in ((watch, 'load_json', state), (watch.time, 'time', 100000000),
                    (watch, 'check_calendar', True), (watch.cb, 'is_running', True),
                    (watch, 'our_tab', (1, 1)), (watch.cb, 'run_js', 'Assignments Schedule'),
                    (watch.cb, 'find_tabs', [(1, 1)]), (watch, 'fetch_completion_state', result)):
                stack.enter_context(patch.object(target, attribute, return_value=value))
            for target, attribute in ((watch, 'reconcile_completions'), (watch, 'save_json'), (watch, 'log'),
                                      (watch.cb, 'open_tab'), (watch.cb, 'close_tab'),
                                      (watch.cb, 'wait_loaded'), (watch.time, 'sleep')):
                stack.enter_context(patch.object(target, attribute))
            full = stack.enter_context(patch.object(watch, 'fetch_state'))
            stack.enter_context(patch.object(sys, 'argv', ['globus_watch.py']))
            self.assertEqual(watch.main(), 0)
        full.assert_not_called()
        self.assertEqual(state['checked_epoch'], 99999999)
        self.assertEqual(state['data'], {'grades': ['private'], 'schedule': ['prior']})
        self.assertEqual(state['completion_health']['status'], 'unknown')

    def test_failed_source_check_preserves_prior_source_timestamps_and_receipts(self):
        receipt = self.read(['Chapter 5 Exercises', 'Completed'])
        state = {'completion_observations': receipt, 'completion_checked_epoch': 123,
                 'completion_health': {'observed_at': STAMP, 'status': 'unknown'}}
        with patch.object(watch, 'save_json'):
            watch.record_completion_failure(state, 'browser_unavailable')
        self.assertEqual(state['completion_observations'], receipt)
        self.assertEqual(state['completion_checked_epoch'], 123)
        self.assertEqual(state['completion_health']['observed_at'], STAMP)
        self.assertEqual(state['completion_health']['status'], 'blocked')

    def test_failed_dry_source_check_never_writes_state(self):
        state = {}
        with patch.object(watch, 'save_json') as save:
            watch.record_completion_failure(state, 'session_unavailable', dry=True)
        self.assertEqual(state, {})
        save.assert_not_called()


if __name__ == '__main__':
    unittest.main()
