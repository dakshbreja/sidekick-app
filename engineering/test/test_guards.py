"""Negative tests for private-data exclusion and truthful health classification."""
import importlib.util
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import git_guard
import reliability


class GuardTests(unittest.TestCase):
    def test_runtime_credentials_and_nested_repo_are_rejected(self):
        for name in ['bridge/.env', 'collect/.manifest.json', 'grades-remote/README.md',
                     'meetings/Classes/lecture.md', '../other.py', '/tmp/source.py',
                     'bridge/.gdrive-token.json', 'work/notes.py', 'meetings/Other/file.md']:
            self.assertFalse(git_guard.safe_path(name), name)
        self.assertTrue(git_guard.safe_path('bridge/src/status.js'))

    def test_known_credential_and_provider_key_are_redacted(self):
        secret = 'synthetic-credential-never-store'
        self.assertEqual(git_guard.secret_reasons(secret.encode(), [secret]), ['known local credential'])
        self.assertIn('provider key', git_guard.secret_reasons(('sk-proj-'+'x'*40).encode()))
        self.assertIn('private key', git_guard.secret_reasons(('-----BEGIN '+'PRIVATE KEY-----\n'+'x'*64).encode()))

    def test_optimistic_health_needs_actual_recent_run_evidence(self):
        now = 2000000
        raw = {'outcome': 'healthy', 'reason': 'ok'}
        self.assertEqual(reliability.assess(raw, 100, now)['outcome'], 'unknown')
        raw.update(last_attempt_at='1970-01-01T00:00:01+00:00', last_success_at='1970-01-01T00:00:01+00:00')
        self.assertEqual(reliability.assess(raw, 100, now)['outcome'], 'stale')
        raw.update(outcome='degraded', reason='partial')
        self.assertEqual(reliability.assess(raw, 100, now)['outcome'], 'degraded')

    def test_future_evidence_and_private_reason_cannot_escape(self):
        raw = {'outcome': 'healthy', 'reason': 'token=private',
               'last_attempt_at': '2099-01-01T00:00:00+00:00',
               'last_success_at': '2099-01-01T00:00:00+00:00'}
        result = reliability.assess(raw, 100, 2000000)
        self.assertEqual(result['outcome'], 'unknown')
        self.assertEqual(result['reason'], 'future_timestamp')
        self.assertNotIn('private', str(result))


if __name__ == '__main__':
    unittest.main()
