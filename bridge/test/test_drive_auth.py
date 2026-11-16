import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / 'scripts/drive_auth.py'
spec = importlib.util.spec_from_file_location('drive_auth_private', source)
auth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auth)


class PrivateDriveGrantTests(unittest.TestCase):
    def test_replacement_is_private_and_retains_the_existing_readonly_scope(self):
        creds = SimpleNamespace(client_id='fake-client', client_secret='fake-secret',
                                refresh_token='fake-grant', scopes=auth.SCOPES)
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / 'token.json')
            auth.save_grant(creds, path)
            saved = json.loads(Path(path).read_text())
            self.assertEqual(saved['scopes'], ['https://www.googleapis.com/auth/drive.readonly'])
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)

    def test_incomplete_consent_cannot_erase_the_working_grant(self):
        creds = SimpleNamespace(refresh_token=None)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'token.json'
            path.write_text('{"refresh_token":"old-fake-grant"}')
            with self.assertRaises(RuntimeError):
                auth.save_grant(creds, str(path))
            self.assertEqual(json.loads(path.read_text())['refresh_token'], 'old-fake-grant')

    def test_interrupted_write_leaves_the_previous_complete_file(self):
        creds = SimpleNamespace(client_id='fake-client', client_secret='fake-secret',
                                refresh_token='fake-grant', scopes=auth.SCOPES)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'token.json'
            path.write_text('{"refresh_token":"old-fake-grant"}')
            with patch.object(auth.json, 'dump', side_effect=OSError('disk unavailable')):
                with self.assertRaises(OSError):
                    auth.save_grant(creds, str(path))
            self.assertEqual(json.loads(path.read_text())['refresh_token'], 'old-fake-grant')
            self.assertEqual([p.name for p in Path(folder).iterdir()], ['token.json'])

    def test_missing_broader_or_unexpected_scope_cannot_replace_old_grant(self):
        for actual in ([], ['https://www.googleapis.com/auth/drive'],
                       auth.SCOPES + ['https://www.googleapis.com/auth/calendar.events']):
            with self.subTest(actual=actual), tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / 'token.json'
                path.write_text('{"refresh_token":"old-fake-grant"}')
                creds = SimpleNamespace(client_id='fake-client', client_secret='fake-secret',
                                        refresh_token='fake-grant', scopes=auth.SCOPES,
                                        granted_scopes=actual)
                with self.assertRaises(RuntimeError):
                    auth.save_grant(creds, str(path))
                self.assertEqual(json.loads(path.read_text())['refresh_token'], 'old-fake-grant')

    def test_provider_granted_scopes_override_requested_scope_metadata(self):
        creds = SimpleNamespace(client_id='fake-client', client_secret='fake-secret',
                                refresh_token='fake-grant', scopes=['https://www.googleapis.com/auth/drive'],
                                granted_scopes=auth.SCOPES)
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / 'token.json')
            auth.save_grant(creds, path)
            self.assertEqual(json.loads(Path(path).read_text())['scopes'], auth.SCOPES)


if __name__ == '__main__': unittest.main()
