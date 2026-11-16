import contextlib
import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bin'))
import elc_submission as s

NOW = '2026-10-11T01:00:00+00:00'
PAST = '2026-10-10T01:00:00+00:00'
ORG = '4048786'


def receipt(kind='quiz', **overrides):
    row = {'kind': kind, 'item_id': '100', 'receipt_id': '200',
           'title': 'Quiz 5', 'submitted_at': '2026-10-09T20:00:00Z',
           'own_user_receipt': True, 'own_user_id': '300', 'receipt_user_id': '300',
           'receipt_status': 'completed', 'due_at': '2026-10-10T03:59:00Z',
           'source_url': 'https://uga.view.usg.edu/d2l/api/le/1.82/4048786/quizzes/100/attempts/?userId=300'}
    if kind == 'assignment':
        row.update(title='Exercise 5', receipt_status='submitted', submission_type='0',
                   source_url='https://uga.view.usg.edu/d2l/api/le/1.82/4048786/dropbox/folders/100/submissions/mysubmissions/')
    row.update(overrides)
    return row


def bucket(rows=None, **overrides):
    data = {'org_unit_id': ORG, 'version': '1.82', 'receipts': rows or [],
            'coverage': {k: {'status': 'ok', 'error': None} for k in s.KINDS}}
    data.update(overrides)
    return data


class SubmissionReceiptTests(unittest.TestCase):
    def test_explicit_quiz_completed_timestamp_projects_only_receipt_fields(self):
        row = receipt(Score=93, AttemptFeedback={'Text': 'Private'}, Answers=['private'])
        out = s.normalized_observations('BUSN5000', ORG, bucket([row]), NOW)
        self.assertEqual(len(out), 1)
        result = out[0]
        self.assertEqual(result['status'], 'submitted')
        self.assertEqual(result['provider_item_id'], 'quiz:100:attempt:200')
        self.assertEqual(result['submitted_at'], '2026-10-09T20:00:00+00:00')
        self.assertEqual(result['term_id'], 'fall-2026')
        self.assertFalse({'Score', 'AttemptFeedback', 'Answers', 'own_user_id'} & result.keys())
        self.assertNotIn('93', json.dumps(result))

    def test_assignment_submission_receipt_does_not_need_grade(self):
        out = s.normalized_observations('BUSN5000', ORG, bucket([receipt('assignment')]), NOW)
        self.assertEqual(out[0]['provider_item_id'], 'assignment:100:submission:200')
        self.assertIn('SubmissionDate', out[0]['source_evidence'])

    def test_score_grade_flag_view_and_due_expiry_are_never_proof(self):
        for extra in ({'Score': 100}, {'IsPublished': True}, {'IsComplete': True}, {'Viewed': True}):
            row = receipt(submitted_at=None, **extra)
            self.assertEqual(s.normalized_observations('BUSN5000', ORG, bucket([row]), NOW), [])

    def test_in_progress_attempt_and_manual_paper_completion_are_not_submissions(self):
        for row in (receipt(receipt_status='in_progress'),
                    receipt('assignment', submission_type='2'),
                    receipt('assignment', submission_type='3')):
            self.assertEqual(s.normalized_observations('BUSN5000', ORG, bucket([row]), NOW), [])

    def test_wrong_user_org_or_source_receipt_cannot_authorize_updates(self):
        for row in (receipt(receipt_user_id='999'), receipt(source_url='https://example.com/'),
                    receipt(item_id='101'), receipt(receipt_id='not-id')):
            with self.assertRaises(ValueError):
                s.normalized_observations('BUSN5000', ORG, bucket([row]), NOW)
        with self.assertRaises(ValueError):
            s.normalized_observations('BUSN5000', '999', bucket([receipt()]), NOW)

    def test_current_term_and_future_observation_guards(self):
        for date in ('2025-10-01T00:00:00Z', '2026-10-12T00:00:00Z', '2026-10-09', 'invalid'):
            self.assertEqual(s.normalized_observations('BUSN5000', ORG, bucket([receipt(submitted_at=date)]), NOW), [])

    def test_privacy_and_duplicate_identity_reject_bucket(self):
        for rows in ([receipt(title='Quiz score 85%')], [receipt(title='Password: superprivate')], [receipt(), receipt()]):
            with self.assertRaises(ValueError):
                s.normalized_observations('BUSN5000', ORG, bucket(rows), NOW)

    def test_api_version_is_per_receipt_and_obsolete_is_rejected(self):
        row = receipt(api_version='1.98', source_url=receipt()['source_url'].replace('/1.82/', '/1.98/'))
        self.assertEqual(len(s.normalized_observations('BUSN5000', ORG, bucket([row]), NOW)), 1)
        with self.assertRaises(ValueError):
            s.normalized_observations('BUSN5000', ORG, bucket([receipt(api_version='1.67')]), NOW)


class SubmissionStageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / 'state.json'
        self.cfg = s.news.source_config()

    def results(self, rows=None):
        return {c: bucket(rows if c == 'BUSN5000' else [], org_unit_id=org)
                for c, org in self.cfg['courses'].items()}

    def test_fresh_receipts_call_reconciler_and_save_owner_only_evidence(self):
        reconcile = Mock()
        with patch.dict(sys.modules, {'submission_reconcile': types.SimpleNamespace(reconcile=reconcile)}):
            result = s.record(self.results([receipt()]), cfg=self.cfg, observed_at=NOW, state_path=self.state)
        reconcile.assert_called_once_with(result['observations'], log=unittest.mock.ANY, dry=False)
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(result['last_receipts']), 1)
        self.assertTrue(all(r['status'] == 'ok' for r in result['coverage']))

    def test_unknown_read_never_calls_reconciler_and_retains_real_previous_success(self):
        with patch.dict(sys.modules, {'submission_reconcile': types.SimpleNamespace(reconcile=Mock())}):
            s.record(self.results([receipt()]), cfg=self.cfg, observed_at=PAST, state_path=self.state)
        reconcile = Mock()
        failed = {c: {'error': 'permission'} for c in self.cfg['courses']}
        with patch.dict(sys.modules, {'submission_reconcile': types.SimpleNamespace(reconcile=reconcile)}):
            result = s.record(failed, cfg=self.cfg, observed_at=NOW, state_path=self.state)
        reconcile.assert_not_called()
        self.assertTrue(all(r['status'] == 'unknown' and r['last_success_at'] == PAST for r in result['coverage']))
        self.assertEqual(result['observations'], [])
        self.assertEqual(result['last_receipts'][0]['observed_at'], PAST)

    def test_dry_run_does_not_save_or_reconcile(self):
        reconcile = Mock()
        with patch.dict(sys.modules, {'submission_reconcile': types.SimpleNamespace(reconcile=reconcile)}), patch.object(s.news, 'save_json') as save:
            result = s.record(self.results([receipt()]), cfg=self.cfg, observed_at=NOW, dry=True, state_path=self.state)
        self.assertEqual(len(result['observations']), 1)
        save.assert_not_called()
        reconcile.assert_not_called()

    def test_bad_bucket_unknown_and_no_receipt_reconciliation(self):
        results = self.results()
        results['BUSN5000'] = bucket([receipt(receipt_user_id='999')])
        reconcile = Mock()
        with patch.dict(sys.modules, {'submission_reconcile': types.SimpleNamespace(reconcile=reconcile)}):
            result = s.record(results, cfg=self.cfg, observed_at=NOW, state_path=self.state)
        reconcile.assert_not_called()
        self.assertTrue(all(r['status'] == 'unknown' for r in result['coverage'] if r['course_code'] == 'BUSN5000'))

    def test_wrong_term_or_org_does_not_read_browser(self):
        with patch.object(s.cb, 'run_js') as run:
            result = s.read_courses(1, 1, self.cfg['courses'], cfg=self.cfg, term_code='20281')
        run.assert_not_called()
        self.assertTrue(all(r['error'] == 'course_identity' for r in result.values()))

    def test_reader_whitelists_get_only_own_user_and_has_bounds(self):
        with patch.object(s.cb, 'run_js') as run, patch.object(s.cb, 'await_global', return_value=self.results()):
            s.read_courses(1, 1, self.cfg['courses'], cfg=self.cfg, term_code='20272')
        js = run.call_args.args[2]
        self.assertIn("method:'GET'", js)
        self.assertIn("/submissions/mysubmissions/", js)
        self.assertIn("?userId='+user", js)
        self.assertIn("String(a.UserId)!==user", js)
        self.assertIn('120000', js)
        self.assertNotIn('a.Score', js)
        self.assertNotIn('entity.Feedback', js)

    def test_hourly_stage_has_independent_throttle(self):
        s.news.save_json(self.state, {'last_attempt_epoch': 100000})
        self.assertFalse(s.due(state_path=self.state, now=100001))
        self.assertTrue(s.due(state_path=self.state, now=100000 + s.MIN_GAP_SECONDS))

    def run_reader_fixture(self, responses, origin='https://uga.view.usg.edu'):
        node = shutil.which('node')
        if not node:
            self.skipTest('Node unavailable for offline page-reader fixture')
        with patch.object(s.cb, 'run_js') as run, patch.object(s.cb, 'await_global', return_value={}):
            s.read_courses(1, 1, {'BUSN5000': ORG}, cfg=self.cfg, term_code='20272')
        js = run.call_args.args[2]
        fixture = """
          const responses=RESPONSES;
          global.window={location:{origin:ORIGIN}};
          global.document={querySelectorAll:()=>[]};
          let calls=[];
          global.fetch=async function(path,options) {
            calls.push({path,method:options.method});
            const result=responses[path];
            if(!result) return {ok:false,status:404};
            if(result.status) return {ok:false,status:result.status};
            return {ok:true,text:async()=>JSON.stringify(result.json)};
          };
          new Function(SCRIPT)();
          async function finish(){
            for(let i=0;i<200&&window.__submissionRead==='pending';i++) await new Promise(r=>setTimeout(r,1));
            process.stdout.write(JSON.stringify({out:window.__submissionRead,calls}));
          }
          finish();
        """.replace('RESPONSES', json.dumps(responses)).replace('ORIGIN', json.dumps(origin)).replace('SCRIPT', json.dumps(js))
        result = subprocess.run([node, '-e', fixture], text=True, capture_output=True, check=True, timeout=5)
        return json.loads(result.stdout)

    def api_fixture(self):
        return {
            '/d2l/api/le/versions/': {'json': {'SupportedVersions': ['1.67', '1.82']}},
            '/d2l/api/lp/1.9/users/whoami': {'json': {'Identifier': '300'}},
            '/d2l/api/le/1.82/4048786/quizzes/': {'json': {'Objects': [{'QuizId': 100, 'Name': 'Quiz 5'}], 'Next': None}},
            '/d2l/api/le/1.82/4048786/quizzes/100/attempts/?userId=300': {'json': {'Objects': [
                {'QuizId': 100, 'UserId': 300, 'AttemptId': 200, 'Completed': '2026-10-09T20:00:00Z', 'Score': 98.76},
                {'QuizId': 100, 'UserId': 300, 'AttemptId': 201, 'Completed': None, 'Score': 77.77},
                {'QuizId': 100, 'UserId': 999, 'AttemptId': 202, 'Completed': '2026-10-09T20:00:00Z', 'Score': 66.66}
            ], 'Next': None}},
            '/d2l/api/le/1.82/4048786/dropbox/folders/': {'json': [{'Id': 101, 'Name': 'Exercise 5', 'SubmissionType': 0}]},
            '/d2l/api/le/1.82/4048786/dropbox/folders/101/submissions/mysubmissions/': {'json': [
                {'Entity': {'EntityType': 'User', 'EntityId': 300}, 'Feedback': {'Score': 55.55},
                 'CompletionDate': '2026-10-09T20:00:00Z', 'Submissions': [
                     {'Id': 205, 'SubmissionDate': '2026-10-09T20:00:00Z', 'Files': [{'FileName': 'private.pdf'}]},
                     {'Id': 206, 'SubmissionDate': None}
                 ]}
            ]}
        }

    def test_offline_reader_processes_documented_shapes_without_score_or_foreign_user(self):
        result = self.run_reader_fixture(self.api_fixture())
        bucket = result['out']['BUSN5000']
        self.assertEqual({r['receipt_id'] for r in bucket['receipts']}, {'200', '205'})
        self.assertEqual(bucket['coverage']['quiz']['status'], 'partial')
        self.assertEqual(bucket['coverage']['quiz']['error'], 'identity')
        self.assertEqual(bucket['coverage']['assignment']['status'], 'ok')
        for value in ('98.76', '77.77', '66.66', '55.55', 'private.pdf'):
            self.assertNotIn(value, json.dumps(bucket))
        self.assertTrue(all(call['method'] == 'GET' for call in result['calls']))
        self.assertEqual(len(s.normalized_observations('BUSN5000', ORG, bucket, NOW)), 2)

    def test_offline_reader_denied_receipts_remain_unknown_or_partial(self):
        fixture = self.api_fixture()
        fixture['/d2l/api/le/1.82/4048786/quizzes/'] = {'status': 403}
        fixture['/d2l/api/le/1.82/4048786/dropbox/folders/101/submissions/mysubmissions/'] = {'status': 403}
        bucket = self.run_reader_fixture(fixture)['out']['BUSN5000']
        self.assertEqual(bucket['receipts'], [])
        self.assertEqual(bucket['coverage']['quiz']['status'], 'unknown')
        self.assertEqual(bucket['coverage']['quiz']['error'], 'permission')
        self.assertEqual(bucket['coverage']['assignment']['status'], 'partial')

    def test_offline_reader_does_not_query_a_retargeted_non_elc_tab(self):
        result = self.run_reader_fixture(self.api_fixture(), origin='https://example.com')
        self.assertEqual(result['calls'], [])
        self.assertEqual(result['out']['BUSN5000']['error'], 'identity')


class ExistingHourlyHookTests(unittest.TestCase):
    def setUp(self):
        import elc_daily as daily
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        # Material recovery now precedes source checks. Keep these hourly-hook
        # tests scoped to their original assertion with fully fake recovery and
        # health stages, and place the main wrapper's lock/state under a temp root.
        for name, value in {'ROOT': str(root), 'MANIFEST': str(root/'.manifest.json'),
                'FETCHED': str(root/'.fetched.json'), 'STATE': str(root/'.daily-state.json'),
                'PENDING': str(root/'.pending-upload.json'), 'REPORTS': str(root/'reports'),
                'LOG': str(root/'logs/daily.log'), 'DOWNLOADS': str(root/'downloads'),
                'BRIDGE_NOTE': str(root/'note.sh')}.items():
            stack.enter_context(patch.object(daily, name, value))
        stack.enter_context(patch.object(daily, 'recovery_scope', return_value={'BUSN5000'}))
        self.recover = stack.enter_context(patch.object(daily, 'recover_materials', return_value={'pending':0}))
        self.health = stack.enter_context(patch.object(daily, 'material_health'))
        for obj, name in ((daily.subprocess,'run'), (daily.subprocess,'Popen'),
                          (daily.transcribe,'transcribe'), (daily.drive_sync,'file_item'),
                          (daily.gpt_upload,'upload_many'), (daily.material_bridge,'request'),
                          (daily.cb,'open_tab'), (daily.cb,'run_js'), (daily.cb,'run_js_json')):
            stack.enter_context(patch.object(obj, name, side_effect=AssertionError('offline hook test')))

    def test_submission_reader_runs_when_material_and_news_have_recent_receipts(self):
        import elc_daily as daily
        cfg = {'courses': {'BUSN5000':4048786}}
        discovered = Mock(return_value=cfg['courses'], current_term='20272')
        with patch.object(sys, 'argv', ['elc_daily.py']), patch.object(daily.time, 'time', return_value=100000000), \
                patch.object(daily, 'load_json', return_value={'last_success_epoch': 99999999}), \
                patch.object(daily, 'load_pending', return_value={'files': []}), patch.object(daily, 'log'), \
                patch.object(daily.cb, 'is_running', return_value=True), patch.object(daily.cb, 'find_tab', return_value=(1, 1)), \
                patch.object(daily, 'js_json', return_value={'ok': True}), patch.object(daily, 'discover_courses', discovered), \
                patch.object(daily.elc_announcements, 'due', return_value=False), \
                patch.object(daily.elc_announcements, 'read_rss_courses') as rss, \
                patch.object(daily.elc_announcements, 'publish_pending'), \
                patch.object(daily.elc_submission, 'due', return_value=True), \
                patch.object(daily.elc_submission, 'collect') as collect, patch.object(daily, 'sweep') as sweep, \
                patch.object(daily, 'save_json') as save:
            self.assertEqual(daily.main(), 0)
        collect.assert_called_once()
        self.assertEqual(collect.call_args.kwargs['term_code'], '20272')
        rss.assert_not_called()
        sweep.assert_not_called()
        save.assert_not_called()
        self.recover.assert_called_once_with({'BUSN5000'})
        self.health.assert_called_once()

    def test_browser_failure_records_unknown_submission_coverage(self):
        import elc_daily as daily
        with patch.object(sys, 'argv', ['elc_daily.py']), patch.object(daily, 'load_json', return_value={}), \
                patch.object(daily, 'log'), patch.object(daily.cb, 'is_running', return_value=False), \
                patch.object(daily.elc_announcements, 'due', return_value=False), \
                patch.object(daily.elc_announcements, 'publish_pending'), \
                patch.object(daily.elc_submission, 'due', return_value=True), \
                patch.object(daily.elc_submission, 'blocked') as blocked:
            self.assertEqual(daily.main(), 0)
        self.assertEqual(blocked.call_args.args, ('browser',))

    def test_upload_only_has_no_submission_read_or_progress_write(self):
        import elc_daily as daily
        with patch.object(sys, 'argv', ['elc_daily.py', '--upload-only']), patch.object(daily, 'log'), \
                patch.object(daily.cb, 'is_running', return_value=True), \
                patch.object(daily, 'flush_upload_queue', return_value=([], [], [])), \
                patch.object(daily.elc_submission, 'collect') as collect, patch.object(daily.elc_submission, 'blocked') as blocked:
            self.assertEqual(daily.main(), 0)
        collect.assert_not_called()
        blocked.assert_not_called()


if __name__ == '__main__':
    unittest.main()
