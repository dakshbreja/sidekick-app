import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bin'))
import gradescope_submission as g

CFG = {'schema_version': 1, 'term_id': 'fall-2026', 'gradescope_courses': {'BUSN5000': '1353639'}}
NOW = '2026-10-11T01:00:00+00:00'
URL = 'https://www.gradescope.com/courses/1353639/assignments/8402934/submissions/432669080'


def row(**extra):
    value = {'name': 'Mini Project 1', 'status': 'Submitted', 'dates': 'Oct 1 at 11:59PM',
             'href': URL, 'submission_href': URL, 'due_at': '2026-10-02 23:59:00 -0400'}
    value.update(extra)
    return value


class GradescopeReceiptTests(unittest.TestCase):
    def test_exact_own_receipt_is_proof_and_submission_time_remains_unknown(self):
        observations, unresolved = g.normalized_observations('BUSN5000', '1353639', [row()], cfg=CFG, observed_at=NOW)
        self.assertEqual(unresolved, 0)
        self.assertEqual(observations[0]['source_url'], URL)
        self.assertEqual(observations[0]['provider_item_id'], 'assignment:8402934:submission:432669080')
        self.assertEqual(observations[0]['status'], 'submitted')
        self.assertNotIn('submitted_at', observations[0])
        self.assertEqual(observations[0]['due_at'], '2026-10-03T03:59:00+00:00')

    def test_due_time_comes_from_explicit_due_attribute_and_missing_stays_unknown(self):
        for value in (None, '', 'Oct 2 at 11:59PM', '2026-10-02T23:59:00', '2025-10-02 23:59:00 -0400', '2026-13-02 23:59:00 -0400'):
            with self.subTest(value=value):
                observations, _ = g.normalized_observations('BUSN5000', '1353639', [row(due_at=value)], cfg=CFG, observed_at=NOW)
                self.assertNotIn('due_at', observations[0])
        self.assertEqual(g.due_time('2026-10-02T23:59:00-04:00'), '2026-10-03T03:59:00+00:00')

    def test_release_attribute_is_not_used_as_due_date(self):
        observations, _ = g.normalized_observations('BUSN5000', '1353639',
            [row(due_at=None, release_at='2026-10-02 23:59:00 -0400')], cfg=CFG, observed_at=NOW)
        self.assertNotIn('due_at', observations[0])
        from grades import gradescope as adapter
        self.assertIn('.submissionTimeChart--dueDate[datetime]', adapter.ASSIGNMENTS_JS)
        self.assertNotIn('.submissionTimeChart--releaseDate', adapter.ASSIGNMENTS_JS)

    def test_numeric_grade_is_ignored_and_own_receipt_link_is_independent_evidence(self):
        a, _ = g.normalized_observations('BUSN5000', '1353639', [row(status='93.0 / 100.0', score=93)], cfg=CFG, observed_at=NOW)
        b, _ = g.normalized_observations('BUSN5000', '1353639', [row(status='0.0 / 100.0', score=0)], cfg=CFG, observed_at=NOW)
        self.assertEqual(a, b)
        self.assertNotIn('93.0 / 100.0', json.dumps(a))
        self.assertNotIn('score', a[0])

    def test_score_or_submitted_word_without_receipt_is_not_proof(self):
        assignment_url = 'https://www.gradescope.com/courses/1353639/assignments/8402934'
        for status in ('99.0 / 100.0', 'Submitted', 'No Submission'):
            observations, unresolved = g.normalized_observations('BUSN5000', '1353639',
                [row(status=status, href=assignment_url, submission_href=None)], cfg=CFG, observed_at=NOW)
            self.assertEqual(observations, [])
            self.assertEqual(unresolved, int(status == 'Submitted'))

    def test_inconsistent_unsubmitted_receipt_does_not_clear_work(self):
        for status in ('No Submission', 'Not Submitted', 'Unsubmitted', 'In Progress'):
            observations, unresolved = g.normalized_observations('BUSN5000', '1353639', [row(status=status)], cfg=CFG)
            self.assertEqual(observations, [])
            self.assertEqual(unresolved, 1)

    def test_current_term_pin_wrong_course_and_foreign_link_guards(self):
        with self.assertRaises(ValueError):
            g.normalized_observations('BUSN5000', '111', [row()], cfg=CFG)
        with self.assertRaises(ValueError):
            g.normalized_observations('MGMT4280', '1353639', [row()], cfg=CFG)
        with self.assertRaises(ValueError):
            g.normalized_observations('BUSN5000', '1353639', [row()], cfg={**CFG, 'term_id': 'fall-2025'})
        with self.assertRaises(ValueError):
            g.normalized_observations('BUSN5000', '1353639', [row(href=URL.replace('/1353639/', '/999/'), submission_href=None)], cfg=CFG)
        observations, _ = g.normalized_observations('BUSN5000', '1353639', [row(href=URL.replace('www.gradescope.com', 'evil.example'), submission_href=None)], cfg=CFG)
        self.assertEqual(observations, [])

    def test_missing_or_invalid_current_pin_is_explicit_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'missing.json'
            self.assertIsNone(g.source_config(path))
            g.news.save_json(path, {'schema_version': 1, 'term_id': 'fall-2025', 'gradescope_courses': CFG['gradescope_courses']})
            self.assertIsNone(g.source_config(path))

    def test_secret_grade_title_or_duplicate_receipt_rejected(self):
        for rows in ([row(name='My Score 93%')], [row(name='password: private')], [row(), row()]):
            with self.assertRaises(ValueError):
                g.normalized_observations('BUSN5000', '1353639', rows, cfg=CFG)

    def test_saved_and_reconciled_receipt_has_no_private_status(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            reconcile = Mock()
            with patch.dict(sys.modules, {'submission_reconcile': types.SimpleNamespace(reconcile=reconcile)}):
                result = g.record('BUSN5000', '1353639', [row(status='93 / 100')], cfg=CFG, observed_at=NOW, state_path=path)
            self.assertEqual(result['status'], 'ok')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            reconcile.assert_called_once()
            self.assertNotIn('93 / 100', path.read_text())
            self.assertNotIn('dates', path.read_text())

    def test_dry_run_never_changes_private_state_or_bridge(self):
        reconcile = Mock()
        with patch.dict(sys.modules, {'submission_reconcile': types.SimpleNamespace(reconcile=reconcile)}), patch.object(g.news, 'save_json') as save:
            result = g.record('BUSN5000', '1353639', [row()], cfg=CFG, observed_at=NOW, dry=True)
        self.assertEqual(len(result['observations']), 1)
        reconcile.assert_not_called()
        save.assert_not_called()

    def test_source_failure_preserves_last_receipt_time_without_reconciling(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            with patch.dict(sys.modules, {'submission_reconcile': types.SimpleNamespace(reconcile=Mock())}):
                g.record('BUSN5000', '1353639', [row()], cfg=CFG, observed_at=NOW, state_path=path)
            result = g.blocked('session', state_path=path)
            self.assertEqual(result['status'], 'unknown')
            self.assertEqual(result['last_success_at'], NOW)
            self.assertEqual(result['last_receipts'][0]['observed_at'], NOW)

    def test_existing_grade_adapter_hook_reads_student_page_context(self):
        from grades import gradescope as adapter
        course = {'id': '1353639', 'short': 'BUSN 5000', 'name': 'Business Analytics', 'text': 'BUSN5000'}
        data = {'rows': [row()], 'url': 'https://www.gradescope.com/courses/1353639?gs=1', 'loggedIn': True}
        with patch.object(adapter, 'read', side_effect=[{'loggedIn': True, 'rows': [course]}, data]), patch.object(adapter.gradescope_submission, 'record') as record:
            result = adapter._collect(lambda text: None)
        record.assert_called_once_with('BUSN5000', '1353639', data['rows'], log=unittest.mock.ANY)
        self.assertEqual(result[0]['state'], 'completed')

    def test_wrong_page_or_login_redirect_cannot_run_receipt_reconciler(self):
        from grades import gradescope as adapter
        course = {'id': '1353639', 'short': 'BUSN5000', 'name': '', 'text': ''}
        data = {'rows': [], 'url': 'https://www.gradescope.com/login', 'loggedIn': False}
        with patch.object(adapter, 'read', side_effect=[{'loggedIn': True, 'rows': [course]}, data]), \
                patch.object(adapter.gradescope_submission, 'record') as record, patch.object(adapter.gradescope_submission, 'blocked') as blocked:
            adapter._collect(lambda text: None)
        record.assert_not_called()
        blocked.assert_called_once_with('session', log=unittest.mock.ANY)


class GradescopeLocalOnlyTests(unittest.TestCase):
    def setUp(self):
        import contextlib
        from grades import gradescope
        self.adapter = gradescope
        self.stack = contextlib.ExitStack(); self.addCleanup(self.stack.close)
        class ForbiddenEffect(BaseException): pass
        self.effects = [self.stack.enter_context(patch.object(gradescope.gradescope_submission, name,
                        side_effect=ForbiddenEffect(name))) for name in ('source_config', 'record', 'blocked')]
        self.stack.enter_context(patch.object(gradescope, 'open_tab'))
        self.stack.enter_context(patch.object(gradescope, 'our_tab', return_value=(1, 1)))
        self.stack.enter_context(patch.object(gradescope.cb, 'close_tab'))

    def test_local_read_still_collects_grades_without_receipt_reconciliation(self):
        course = {'id': '1353639', 'short': 'BUSN5000', 'name': '', 'text': ''}
        data = {'rows': [row(status='93 / 100')], 'url': 'https://www.gradescope.com/courses/1353639?gs=1', 'loggedIn': True}
        with patch.object(self.adapter, 'read', side_effect=[{'loggedIn': True, 'rows': [course]}, data]):
            result = self.adapter.collect(log=lambda _: None, reconcile=False)
        self.assertEqual(result[0]['percent'], 93)
        for effect in self.effects: effect.assert_not_called()

    def test_local_session_failure_never_records_or_publishes_blocked_status(self):
        with patch.object(self.adapter, 'open_tab', side_effect=self.adapter.cb.ChromeError('session missing')):
            with self.assertRaises(self.adapter.cb.ChromeError):
                self.adapter.collect(log=lambda _: None, reconcile=False)
        for effect in self.effects: effect.assert_not_called()

    def test_local_missing_course_and_no_courses_skip_every_submission_hook(self):
        for rows in ([], [{'id': '100', 'short': 'OTHER', 'text': '', 'name': ''}]):
            with patch.object(self.adapter, 'read', return_value={'loggedIn': True, 'rows': rows}):
                self.assertEqual(self.adapter.collect(log=lambda _: None, reconcile=False), [])
        for effect in self.effects: effect.assert_not_called()

    def test_local_login_redirect_never_reconciles(self):
        with patch.object(self.adapter, 'read', return_value={'loggedIn': False, 'rows': []}):
            with self.assertRaises(self.adapter.cb.ChromeError):
                self.adapter.collect(log=lambda _: None, reconcile=False)
        for effect in self.effects: effect.assert_not_called()


class GradeLocalRunTests(unittest.TestCase):
    def setUp(self):
        import contextlib
        import io
        from grades import run, elc, globus, gradescope
        self.run = run
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.stack = contextlib.ExitStack(); self.addCleanup(self.stack.close)
        for name, path in {'ROOT': self.root, 'STORE': self.root / '.grades.json',
                           'STATUS': self.root / '.grades-state.json', 'LOG': self.root / 'logs/grades.log'}.items():
            self.stack.enter_context(patch.object(run, name, str(path)))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.elc = self.stack.enter_context(patch.object(elc, 'collect', return_value=[]))
        self.globus = self.stack.enter_context(patch.object(globus, 'collect', return_value=[]))
        self.gradescope = self.stack.enter_context(patch.object(gradescope, 'collect', return_value=[]))
        self.publish = self.stack.enter_context(patch.object(run, 'publish', side_effect=AssertionError('no Git publication')))
        self.process = self.stack.enter_context(patch.object(run.subprocess, 'run', side_effect=AssertionError('no subprocess')))
        self.stack.enter_context(patch.object(sys, 'argv', ['run.py', '--local-only', '--quiet']))

    def test_local_run_writes_sources_and_html_without_claiming_reconciliation(self):
        rec = self.run.model.record('BUSN5000', 'Fictional assessment', state='graded', score=9,
                                   out_of=10, source='elc')
        self.elc.return_value = [rec]
        html = self.root / 'reports/local.html'
        with patch.object(sys, 'argv', ['run.py', '--local-only', '--quiet', '--html', str(html)]):
            self.assertEqual(self.run.main(), 0)
        self.assertEqual(json.loads(Path(self.run.STORE).read_text())[rec['key']]['percent'], 90)
        state = json.loads(Path(self.run.STATUS).read_text())
        self.assertEqual(state['overall'], 'partial')
        self.assertEqual(state['source_collection'], 'ok')
        self.assertEqual(state['submission_reconciliation'], 'not_attempted')
        self.assertEqual(state['publication'], 'not_attempted')
        for source in ('elc', 'gradescope', 'globus'):
            self.assertTrue(state['sources'][source]['ok'])
            self.assertIn('observed_at', state['sources'][source])
        self.assertTrue(html.is_file())
        self.assertEqual(self.gradescope.call_args.kwargs['reconcile'], False)
        self.assertNotIn('reconcile', self.elc.call_args.kwargs)
        self.assertNotIn('reconcile', self.globus.call_args.kwargs)
        self.publish.assert_not_called(); self.process.assert_not_called()

    def test_source_failure_preserves_prior_grade_and_reports_partial_coverage(self):
        old = self.run.model.record('BUSN5000', 'Fictional assessment', state='graded', score=9,
                                   out_of=10, source='gradescope')
        Path(self.run.STORE).write_text(json.dumps({old['key']: old}))
        self.gradescope.side_effect = self.run.cb.ChromeError('source unavailable')
        self.assertEqual(self.run.main(), 1)
        self.assertEqual(json.loads(Path(self.run.STORE).read_text())[old['key']], old)
        state = json.loads(Path(self.run.STATUS).read_text())
        self.assertEqual(state['overall'], 'problem')
        self.assertFalse(state['sources']['gradescope']['ok'])
        self.assertTrue(state['sources']['elc']['ok'])
        self.assertEqual(state['submission_reconciliation'], 'not_attempted')
        self.publish.assert_not_called(); self.process.assert_not_called()

    def test_local_publish_combination_rejected_before_read_or_write(self):
        before = list(self.root.iterdir())
        with patch.object(sys, 'argv', ['run.py', '--local-only', '--publish']):
            self.assertEqual(self.run.main(), 2)
        self.assertEqual(list(self.root.iterdir()), before)
        self.elc.assert_not_called(); self.gradescope.assert_not_called(); self.globus.assert_not_called()
        self.publish.assert_not_called(); self.process.assert_not_called()

    def test_default_adapter_and_status_behavior_is_unchanged(self):
        with patch.object(sys, 'argv', ['run.py', '--quiet']):
            self.assertEqual(self.run.main(), 0)
        self.assertNotIn('reconcile', self.gradescope.call_args.kwargs)
        state = json.loads(Path(self.run.STATUS).read_text())
        self.assertEqual(state['overall'], 'ok')
        self.assertNotIn('mode', state)
        self.assertNotIn('submission_reconciliation', state)
        self.publish.assert_not_called()


if __name__ == '__main__':
    unittest.main()
