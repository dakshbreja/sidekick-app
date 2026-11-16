import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('notify_incident', Path(__file__).resolve().parents[1]/'scripts/notify_incident.py')
n = importlib.util.module_from_spec(spec)
spec.loader.exec_module(n)


class NotificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'state.json'
        self.sent = []

    def update(self, obs, day='2026-11-10', source='bridge'):
        return n.update(self.path, source, obs, 'Fixture only',
                        lambda *args: self.sent.append(args), day)

    def test_failure_repeat_digest_changed_stage_recovery(self):
        failed = {'overall': 'failed', 'stages': {'export': 'failed'}}
        self.assertEqual(self.update(failed), 'failure')
        self.assertIsNone(self.update(failed))
        self.assertEqual(self.update(failed, '2026-11-11'), 'digest')
        self.assertIsNone(self.update(failed, '2026-11-11'))
        self.assertEqual(self.update({'overall':'failed','stages':{'push':'failed'}}, '2026-11-11'), 'failure')
        self.assertEqual(self.update({'overall':'ok'}, '2026-11-11'), 'recovery')
        self.assertIsNone(self.update({'overall':'ok'}, '2026-11-11'))
        self.assertEqual(len(self.sent), 4)

    def test_transient_retry_is_preserved_and_not_green(self):
        obs = {'overall':'degraded','problems':['/health first returned 503; retry recovered']}
        self.assertEqual(self.update(obs), 'failure')
        self.assertIsNone(self.update(obs))
        self.assertEqual(json.loads(self.path.read_text())['sources']['bridge']['observation'], obs)
        self.assertEqual(self.update({'overall':'ok','problems':[]}), 'recovery')

    def test_restart_uses_disk_and_sources_independent(self):
        obs={'overall':'failed'}
        self.assertEqual(self.update(obs), 'failure')
        self.assertIsNone(n.update(self.path, 'bridge', obs, 'Fixture', lambda *a: self.fail('repeat'), '2026-11-10'))
        self.assertEqual(self.update(obs, source='cluely'), 'failure')
        self.assertEqual(len(json.loads(self.path.read_text())['sources']), 2)

    def test_missing_state_never_infers_recovery_and_corrupt_state_visible(self):
        self.assertIsNone(self.update({'overall':'ok'}))
        self.path.write_text('{broken')
        self.assertEqual(self.update({'overall':'ok'}), 'state_warning')
        backups=list(self.path.parent.glob('state.json.invalid.*'))
        self.assertEqual(backups[0].read_text(), '{broken')
        self.assertIsNone(self.update({'overall':'ok'}))

    def test_shape_invalid_falls_back(self):
        self.path.write_text('{"version":1,"sources":{"bridge":null}}')
        self.assertEqual(self.update({'overall':'failed'}), 'state_warning')
        self.assertIsNone(self.update({'overall':'failed'}))

    def test_optimistic_overall_does_not_hide_failed_stage(self):
        self.assertEqual(self.update({'overall':'ok','stages':{'push':'deferred'}}), 'failure')

    def test_normalization_retains_real_error_changes(self):
        a={'overall':'failed','problems':['session_id=abc timed out at 2026-11-10T12:00:00Z']}
        b={'overall':'failed','problems':['session_id=def timed out at 2026-11-10T13:00:00Z']}
        self.assertEqual(self.update(a), 'failure')
        self.assertIsNone(self.update(b))
        b['problems']=['session_id=def permission denied at 2026-11-10T13:00:00Z']
        self.assertEqual(self.update(b), 'failure')

    def test_failed_sender_does_not_consume_notice(self):
        def fail(*args):
            raise RuntimeError('fixture delivery failed')
        with self.assertRaises(RuntimeError):
            n.update(self.path, 'bridge', {'overall':'failed'}, 'Fixture', fail, '2026-11-10')
        self.assertFalse(self.path.exists())
        self.assertEqual(self.update({'overall':'failed'}), 'failure')

    def test_atomic_write_failure_leaves_previous_readable(self):
        self.update({'overall':'failed'})
        original = self.path.read_bytes()
        from unittest.mock import patch
        with patch.object(n.os, 'replace', side_effect=OSError('fixture failure')):
            with self.assertRaises(OSError):
                self.update({'overall':'ok'})
        self.assertEqual(self.path.read_bytes(), original)

    def test_explicit_changed_cause_in_same_stage_not_suppressed(self):
        obs = {'overall':'failed', 'stages':{'export':'failed'},
               'incident_keys':['export:timeout'], 'stage_details':{'error':'raw session abc'}}
        self.assertEqual(self.update(obs), 'failure')
        obs['stage_details']['error'] = 'raw session def'
        self.assertIsNone(self.update(obs))
        obs['incident_keys'] = ['export:unreadable']
        self.assertEqual(self.update(obs), 'failure')
        saved=json.loads(self.path.read_text())['sources']['bridge']['observation']
        self.assertEqual(saved, obs)

    def test_cli_checkpoint_failure_reports_visible_fallback(self):
        from unittest.mock import patch
        status=self.path.parent/'status.json'
        status.write_text(json.dumps({'overall':'failed','message':'Fixture error'}))
        args=['notify_incident.py','--source','bridge','--title','Fixture',
              '--status-file',str(status),'--state-file',str(self.path)]
        with patch.object(n, 'update', side_effect=OSError('fixture disk failure')), \
                patch.object(n, 'send_notice') as sender, \
                patch('sys.argv', args), patch('sys.stderr'):
            self.assertEqual(n.main(), 1)
            sender.assert_called_once()
            self.assertIn('could not be updated', sender.call_args.args[1])
        self.assertEqual(json.loads(status.read_text())['message'], 'Fixture error')

    def test_busy_lock_has_bounded_failure(self):
        from unittest.mock import patch
        with patch.object(n.fcntl, 'flock', side_effect=BlockingIOError), \
                patch.object(n.time, 'monotonic', side_effect=[0, 6]):
            with self.assertRaisesRegex(TimeoutError, '5 seconds'):
                self.update({'overall':'failed'})
        self.assertFalse(self.sent)
        self.assertFalse(self.path.exists())

    def test_health_wrapper_retains_degraded_retry_and_uses_shared_helper(self):
        wrapper=(Path(__file__).resolve().parents[1]/'scripts/health_check.sh').read_text()
        self.assertIn('retry recovered', wrapper)
        self.assertIn('overall="degraded"', wrapper)
        self.assertIn('notify_incident.py', wrapper)
        self.assertNotIn('osascript', wrapper)

if __name__ == '__main__':
    unittest.main()
