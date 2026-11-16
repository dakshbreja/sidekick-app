import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / 'bin/globus_watch.py'
spec = importlib.util.spec_from_file_location('watch', source)
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)


class PrivacyTests(unittest.TestCase):
    def setUp(self):
        for name in ('is_running', 'open_tab', 'run_js', 'run_js_json', 'find_tabs',
                     'wait_loaded', 'close_tab'):
            blocked = patch.object(watch.cb, name, side_effect=AssertionError('unexpected browser operation'))
            blocked.start()
            self.addCleanup(blocked.stop)

    def test_grade_rows_do_not_enter_shared_changes(self):
        old = {'grades':['Company score || 12.34'], 'schedule':['Year 8 || October 8']}
        new = {'grades':['Company score || 98.76'], 'schedule':['Year 8 || October 9']}
        output = '; '.join(watch.diff_state(old, new))
        self.assertNotIn('98.76', output)
        self.assertNotIn('12.34', output)
        self.assertNotIn('GRADEBOOK:', output)
        self.assertIn('NEW DATE:', output)
        self.assertIn('private grades dashboard', output)

    def test_unchanged_grades_remain_quiet(self):
        state = {'grades':['Company score || 12.34']}
        self.assertEqual(watch.diff_state(state, state), [])


if __name__ == '__main__': unittest.main()
