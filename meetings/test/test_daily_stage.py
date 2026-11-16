import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock
spec=importlib.util.spec_from_file_location('daily_stage',Path(__file__).resolve().parents[1]/'bin/daily_stage.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class StageTests(unittest.TestCase):
    def test_start_replaces_old_green_and_interrupt_is_terminal(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'status';p.write_text('{"overall":"ok"}')
            m.start(p);self.assertEqual(m.read(p)['overall'],'in_progress')
            m.interrupted(p,143);self.assertEqual(m.read(p)['overall'],'failed')
            self.assertIn('run:interrupted',m.read(p)['incident_keys'])
    def test_success_records_timing_and_finish_keeps_it(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'status';m.start(p)
            self.assertEqual(m.run(p,'fixture',2,[sys.executable,'-c','pass']),0)
            m.finish(p,json.dumps({'overall':'ok','stages':{'fixture':'ok'}}))
            self.assertIn('finished_at',m.read(p)['stage_timing']['fixture'])
            m.interrupted(p,0);self.assertEqual(m.read(p)['overall'],'ok')
    def test_deadline_kills_only_owned_child_group(self):
        import subprocess
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'status';m.start(p);child=MagicMock(pid=876543)
            child.wait.side_effect=[subprocess.TimeoutExpired('fixture',1),0]
            with patch.object(m.subprocess,'Popen',return_value=child) as opened,patch.object(m.os,'killpg') as killed:
                self.assertEqual(m.run(p,'drive',1,['fixture']),124)
            opened.assert_called_once_with(['fixture'],start_new_session=True)
            killed.assert_called_once_with(876543,m.signal.SIGTERM)
            self.assertEqual(m.read(p)['incident_keys'],['drive:timeout'])

    def test_changed_cause_has_stable_identity_without_error_details(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'status';m.start(p);data=m.read(p);data['incident_keys']=['export:exit_1'];m.save(p,data)
            m.classify(p,'export','TimeoutError: private path on 2026-11-10')
            self.assertEqual(m.read(p)['incident_keys'],['export:timeout'])
