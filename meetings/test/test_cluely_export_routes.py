import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

# Route tests do not open a websocket or require the collector runtime.
sys.modules.setdefault('cdp', types.SimpleNamespace(find_page=None,evaluate=None))
p=Path(__file__).resolve().parents[1]/'bin/cluely_export.py'
spec=importlib.util.spec_from_file_location('export_routes',p)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class Routes(unittest.TestCase):
    route='/dashboard/sessions/8e66fe83-8772-4d09-9fe4-5a1bb5c95d46?title=Class+%E2%80%94+Lecture&createdAt=2026-09-17T17%3A15%3A00Z'
    def test_new_v2_slash_hash_is_normalized(self):
        self.assertEqual(module.session_route('/#'+self.route),self.route)
    def test_old_and_absolute_links_preserve_query_escaping(self):
        for prefix in ('','#','https://renderer.v2.cluely.com/#'):
            self.assertEqual(module.session_route(prefix+self.route),self.route)
    def test_unrelated_origins_and_nested_routes_are_rejected(self):
        for link in ('https://example.com/#'+self.route,'/#/%23'+self.route,'/#/dashboard','javascript:alert(1)'):
            with self.assertRaises(ValueError):module.session_route(link)

    def test_failed_old_export_is_retried_after_recent_refresh_window(self):
        sid='8e66fe83-8772-4d09-9fe4-5a1bb5c95d46'
        title='BUSN 5000 Lecture'
        state={'exported':{sid:{'title':title,'date':'2000-01-01','course':'BUSN 5000','path':'Classes/example.md'}}}
        link={'href':f'/dashboard/sessions/{sid}?title=BUSN+5000+Lecture&createdAt=2000-01-01T12%3A00%3A00Z'}
        responses=[json.dumps({'sessions':[link],'coverage_complete':True}),json.dumps({'text':'Copy summary\nChecked class summary'}),json.dumps({'text':'Copy transcript\n'+'BUSN 5000 class statistics discussion. '*30})]
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            (root/'.routing-review.json').write_text(json.dumps({'sessions':{sid:{'status':'needs_review','method':'content_unavailable'}}}))
            with patch.object(module,'ROOT',folder), patch.object(module,'CLASSES',str(root/'Classes')), patch.object(module,'load_state',return_value=state), patch.object(module,'save_state'), patch.object(module,'write_index'), patch.object(module,'find_page',return_value={'webSocketDebuggerUrl':'fixture'}), patch.object(module,'ev',side_effect=responses) as read, patch.object(module,'route_transcript',return_value={'status':'routed','course':'BUSN5000'}), patch.object(sys,'argv',['cluely_export.py']):
                self.assertEqual(module.main(),0)
            self.assertEqual(read.call_count,3)
            self.assertTrue((root/'Classes/example.md').is_file())

    def test_inventory_timeout_preserves_historical_timestamp_and_sessions(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);old={'observed_at':'2026-10-01T00:00:00Z','sessions':[{'sid':'fixture'}],'coverage_complete':True}
            for filename in ('.raw-inventory.json','.club-inventory.json'):
                (root/filename).write_text(json.dumps(old))
            with patch.object(module,'ROOT',folder), patch.object(module,'load_state',return_value={'exported':{}}), patch.object(module,'find_page',return_value={'webSocketDebuggerUrl':'fixture'}), patch.object(module,'ev',side_effect=TimeoutError('fixture')), patch.object(sys,'argv',['cluely_export.py']):
                with self.assertRaises(TimeoutError):module.main()
            result=json.loads((root/'.raw-inventory.json').read_text())
            self.assertEqual(result['observed_at'],old['observed_at'])
            self.assertEqual(result['sessions'],old['sessions'])
            self.assertFalse(result['coverage_complete'])
            self.assertEqual(result['source_automation']['status'],'blocked')

    def test_run_deadline_does_not_visit_remaining_sessions(self):
        link={'href':'/dashboard/sessions/8e66fe83-8772-4d09-9fe4-5a1bb5c95d46?title=BUSN+5000&createdAt=2000-01-01T12%3A00%3A00Z'}
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            with patch.object(module,'ROOT',folder), patch.object(module,'CLASSES',str(root/'Classes')), patch.object(module,'load_state',return_value={'exported':{}}), patch.object(module,'write_index'), patch.object(module,'find_page',return_value={'webSocketDebuggerUrl':'fixture'}), patch.object(module,'ev',return_value=json.dumps({'sessions':[link],'coverage_complete':True})) as read, patch.object(module.time,'monotonic',side_effect=[0,1,901]), patch.object(sys,'argv',['cluely_export.py']):
                self.assertEqual(module.main(),1)
            self.assertEqual(read.call_count,1)
            result=json.loads((root/'.raw-inventory.json').read_text())
            self.assertEqual(result['content_attempted_session_ids'],[])
            self.assertFalse(result['content_complete'])

if __name__=='__main__':unittest.main()
