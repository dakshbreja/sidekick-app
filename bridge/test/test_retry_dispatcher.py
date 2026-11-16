import importlib.util
import sys
from pathlib import Path
import unittest
from unittest.mock import patch
from datetime import datetime,timezone
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import retry_dispatcher as d
class DispatcherTests(unittest.TestCase):
    def test_zero_exit_without_new_evidence_is_blocked(self):
        self.assertEqual(d.outcome('board-refresh',{'checks':[]},100,0),'blocked')
    def test_new_partial_evidence_is_not_success(self):
        at=datetime.fromtimestamp(200,timezone.utc).isoformat()
        p={'checks':[{'id':'board-refresh','last_attempt_at':at,'outcome':'degraded'}]}
        self.assertEqual(d.outcome('board-refresh',p,199,0),'attention')
        self.assertEqual(d.outcome('board-refresh',p,300,0),'blocked')
        p['checks'][0]['outcome']='healthy'
        self.assertEqual(d.outcome('board-refresh',p,199,0),'succeeded')
    def test_running_job_and_unknown_target_never_started(self):
        # A synthetic registry keeps this contract test independent of live roots.
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            registry=Path(folder)/'routines.json'
            registry.write_text('{"routines":[{"id":"board-refresh"}]}')
            with patch.object(d,'REGISTRY',registry),patch.object(d,'job_status',return_value={'pid':123,'code':0}),patch.object(d.subprocess,'run') as run:
                self.assertEqual(d.run_job({'target':'board-refresh'},{}),'blocked')
                self.assertEqual(d.run_job({'target':'rentcheck'},{}),'blocked')
                run.assert_not_called()
    def test_launchctl_pid_parser(self):
        with patch.object(d.subprocess,'run') as run:
            run.return_value.returncode=0;run.return_value.stdout='service = {\n  pid = 42\n  last exit code = 1\n}'
            self.assertEqual(d.job_status('board-refresh'),{'pid':42,'code':1})
            self.assertEqual(run.call_args.args[0],['/bin/launchctl','print',f'gui/{d.os.getuid()}/com.daksh.board-refresh'])
    def test_waiting_job(self):
        with patch.object(d.subprocess,'run') as run:
            run.return_value.returncode=0;run.return_value.stdout='service = {\n last exit code = -15\n}'
            self.assertEqual(d.job_status('board-refresh'),{'pid':None,'code':-15})
    def test_unavailable_status(self):
        with patch.object(d.subprocess,'run') as run:
            run.return_value.returncode=1
            self.assertIsNone(d.job_status('board-refresh'))
    def test_sanitized_failure_receipt(self):
        e=d.urllib.error.HTTPError('https://secret.invalid',503,'secret',{},None)
        self.assertEqual(d.failure_message(e,False),'Retry dispatcher unavailable (HTTP 503); no pending local receipt.')
        self.assertIn('pending receipt retained',d.failure_message(ValueError('secret'),True))
        self.assertNotIn('secret',d.failure_message(ValueError('secret'),True))
if __name__=='__main__':unittest.main()
