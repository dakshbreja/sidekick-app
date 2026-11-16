"""GLO-BUS ownership/session tests: no browser and no grade payloads."""
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bin'))
from grades import globus


class GlobusTabTests(unittest.TestCase):
    def setUp(self):
        globus._OWNED_TAB_ID = None
        guard = patch.object(globus.cb, '_osascript', side_effect=AssertionError('no live browser'))
        guard.start(); self.addCleanup(guard.stop)
        pause = patch.object(globus.time, 'sleep'); pause.start(); self.addCleanup(pause.stop)

    def tearDown(self):
        globus._OWNED_TAB_ID = None

    def test_redirect_can_drop_marker_without_losing_owned_tab(self):
        with patch.object(globus.cb, 'find_tabs', return_value=[]), \
             patch.object(globus.cb, 'open_owned_tab', return_value=123) as opened, \
             patch.object(globus.cb, 'find_tab_id', side_effect=[(1, 8), (2, 4)]) as locate, \
             patch.object(globus.cb, 'wait_loaded'):
            self.assertEqual(globus.open_tab(), (2, 4))
        opened.assert_called_once_with(globus.SCHEDULE)
        self.assertEqual(locate.call_count, 2)
        self.assertEqual(globus._OWNED_TAB_ID, 123)

    def test_existing_marked_tab_becomes_stably_owned(self):
        with patch.object(globus.cb, 'find_tabs', return_value=[(1, 3)]), \
             patch.object(globus.cb, 'tab_id', return_value=456), \
             patch.object(globus.cb, 'find_tab_id', return_value=(1, 3)), \
             patch.object(globus.cb, 'open_owned_tab') as opened, \
             patch.object(globus.cb, 'wait_loaded'):
            self.assertEqual(globus.open_tab(), (1, 3))
        opened.assert_not_called()
        self.assertEqual(globus._OWNED_TAB_ID, 456)

    def test_expired_session_is_explicit_and_owned_redirected_tab_is_closed(self):
        with patch.object(globus.cb, 'find_tabs', return_value=[]), \
             patch.object(globus.cb, 'open_owned_tab', return_value=123), \
             patch.object(globus.cb, 'find_tab_id', return_value=(2, 4)), \
             patch.object(globus.cb, 'wait_loaded'), patch.object(globus.cb, 'run_js'), \
             patch.object(globus.cb, 'run_js_json', return_value={'signedIn': False, 'rows': []}), \
             patch.object(globus.cb, 'close_tab') as close:
            with self.assertRaisesRegex(globus.cb.ChromeError, 'sign-in is required'):
                globus.collect(log=lambda _: None)
        close.assert_called_once_with(2, 4)
        self.assertIsNone(globus._OWNED_TAB_ID)

    def test_closed_owned_tab_never_falls_back_to_another_marked_tab(self):
        globus._OWNED_TAB_ID = 123
        with patch.object(globus.cb, 'find_tab_id', return_value=None), \
             patch.object(globus.cb, 'find_tabs') as find:
            with self.assertRaisesRegex(globus.cb.ChromeError, 'collector tab was closed'):
                globus.our_tab()
        find.assert_not_called()

    def test_failed_open_does_not_close_an_unowned_tab(self):
        with patch.object(globus.cb, 'find_tabs', return_value=[]), \
             patch.object(globus.cb, 'open_owned_tab', side_effect=globus.cb.ChromeError('unavailable')), \
             patch.object(globus.cb, 'close_tab') as close:
            with self.assertRaises(globus.cb.ChromeError): globus.collect()
        close.assert_not_called()

    def test_unexpected_payload_never_leaks_page_content_into_health(self):
        globus._OWNED_TAB_ID = 123
        with patch.object(globus.cb, 'find_tab_id', return_value=(1, 2)), \
             patch.object(globus.cb, 'wait_loaded'), patch.object(globus.cb, 'run_js'), \
             patch.object(globus.cb, 'run_js_json', return_value='private page contents'):
            with self.assertRaisesRegex(globus.cb.ChromeError, '^schedule: unexpected source response$'):
                globus.read(globus.SCHEDULE, 'schedule')


if __name__ == '__main__': unittest.main()
