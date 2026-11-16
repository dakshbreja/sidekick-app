from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from validate_health import problems


class ProbeTests(unittest.TestCase):
    def test_empty_feeds_and_error_payload_are_not_green(self):
        self.assertTrue(problems({'ok':False,'configured_feeds':0,'feeds':[]}, 'health'))
        self.assertTrue(problems({'error':'offline'}, 'status','BUSN5000'))

    def test_partial_feed_and_wrong_scope_are_not_green(self):
        self.assertTrue(problems({'ok':True,'configured_feeds':1,'feeds':[{'ok':True}]}, 'health'))
        payload={'course':{'code':'BUSN5000'},'feed_health':[{'ok':True},{'ok':True}],
            'generated_at':'2026-10-10','briefing':'Current deadlines',
            'actionable':{'coverage':{'feeds_status':'ok','feeds_total':2}}}
        self.assertFalse(problems(payload,'status','BUSN5000'))
        self.assertTrue(problems(payload,'status','MGMT5560'))


if __name__ == '__main__': unittest.main()
