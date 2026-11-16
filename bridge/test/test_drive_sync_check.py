import io
import json
import sys
from pathlib import Path
import unittest
from unittest.mock import patch, MagicMock
from urllib.parse import urlsplit,parse_qs
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import drive_sync_check as check

class DriveCheckTests(unittest.TestCase):
    def test_recovery_never_restarts_a_running_or_unknown_client(self):
        for status in [True,None]:
            with patch.object(check,'daemon_running',return_value=status), patch.object(check.subprocess,'run') as run:
                self.assertFalse(check.recover_daemon())
                run.assert_not_called()

    def test_missing_daemon_is_launched_and_rechecked(self):
        with patch.object(check,'daemon_running',side_effect=[False,True]), patch.object(check.subprocess,'run',return_value=MagicMock(returncode=0)) as run, patch.object(check.time,'sleep'):
            self.assertTrue(check.recover_daemon())
        run.assert_called_once_with(['/usr/bin/open','-gj','-a','Google Drive'],capture_output=True,timeout=20)
    def test_service_account_preferred_with_readonly_scope(self):
        cred=MagicMock(token='test-token')
        with patch.object(check.os.path,'exists',return_value=True), patch('google.oauth2.service_account.Credentials.from_service_account_file',return_value=cred) as factory, patch('google.auth.transport.requests.Request'):
            self.assertEqual(check.token(),'test-token')
        factory.assert_called_once_with(check.SERVICE_ACCOUNT,scopes=['https://www.googleapis.com/auth/drive.readonly'])
        cred.refresh.assert_called_once()

    def test_failed_service_account_does_not_fallback_or_leak(self):
        with patch.object(check.os.path,'exists',return_value=True), patch('google.oauth2.service_account.Credentials.from_service_account_file',side_effect=ValueError('sensitive provider detail')), self.assertRaisesRegex(RuntimeError,'^Drive service-account authorization failed$'):
            check.token()

    def test_all_pages_counted(self):
        pages=[{'files':[{'id':'a'}],'nextPageToken':'next'}, {'files':[{'id':'b'}]}]
        with patch.object(check.urllib.request,'urlopen',side_effect=[io.BytesIO(json.dumps(p).encode()) for p in pages]) as fetch:
            self.assertEqual(check.query('test-token','scope'),[{'id':'a'},{'id':'b'}])
        query=parse_qs(urlsplit(fetch.call_args_list[1].args[0].full_url).query)
        self.assertEqual(query['pageToken'],['next'])
        self.assertEqual(query['q'],['scope'])

    def test_repeated_page_fails_instead_of_hanging(self):
        page={'files':[],'nextPageToken':'same'}
        with patch.object(check.urllib.request,'urlopen',side_effect=[io.BytesIO(json.dumps(page).encode()) for _ in range(2)]), self.assertRaisesRegex(RuntimeError,'repeated page'):
            check.query('test-token','scope')

if __name__=='__main__':unittest.main()
