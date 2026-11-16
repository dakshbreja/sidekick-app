import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'bin'))
from cluely_launch import restore
class Fake:
    def __init__(self,guard='idle',capture=False,ready=False):
        self.current=42;self.state=guard;self.capture=capture;self.connected=ready;self.calls=[];self.second=None;self.quit_refused=False
    def pid(self):return self.current
    def ready(self,pid):return bool(pid and self.connected)
    def capture_active(self,pid):return self.capture
    def guard(self,quit=False):
        self.calls.append(('guard',quit));state=self.second if quit and self.second else self.state
        if quit and state=='idle' and not self.quit_refused:self.current=None
        return {'state':state,'pid':42,'reason':'test_'+state}
    def sleep(self,s):pass
    def launch(self):self.calls.append(('launch',));self.current=43;self.connected=True;return True
class Tests(unittest.TestCase):
    def test_idle_checked_twice_then_graceful_restart(self):
        p=Fake();code,r=restore(p);self.assertEqual(code,0);self.assertTrue(r['restarted']);self.assertEqual(p.calls,[('guard',False),('guard',True),('launch',)])
    def test_active_recording_never_quit(self):
        for p in [Fake(guard='active'),Fake(capture=True)]:
            self.assertEqual(restore(p)[0],2);self.assertNotIn(('guard',True),p.calls);self.assertNotIn(('launch',),p.calls)
    def test_unknown_never_quit(self):
        p=Fake(guard='unknown');self.assertEqual(restore(p)[0],2);self.assertNotIn(('guard',True),p.calls)
    def test_recording_starts_between_checks(self):
        p=Fake();p.second='active';self.assertEqual(restore(p)[0],2);self.assertEqual(p.current,42);self.assertNotIn(('launch',),p.calls)
    def test_quit_refusal_is_not_force_killed(self):
        p=Fake();p.quit_refused=True;self.assertEqual(restore(p)[1]['reason'],'app_did_not_quit_cleanly');self.assertNotIn(('launch',),p.calls)
    def test_healthy_export_connection_does_not_restart(self):
        p=Fake(ready=True);self.assertEqual(restore(p)[0],0);self.assertEqual(p.calls,[])
    def test_absent_app_starts_without_quit(self):
        p=Fake();p.current=None;self.assertEqual(restore(p)[0],0);self.assertEqual(p.calls,[('launch',)])
if __name__=='__main__':unittest.main()
