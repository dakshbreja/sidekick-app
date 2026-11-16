import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

source = Path(__file__).resolve().parents[1] / 'bin/globus_watch.py'
spec = importlib.util.spec_from_file_location('watch_recovery', source)
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)
calendar = watch.calendar_sync


class CalendarRecoveryTests(unittest.TestCase):
    def setUp(self):
        for name in ('is_running', 'open_tab', 'run_js', 'run_js_json', 'find_tabs',
                     'wait_loaded', 'close_tab'):
            blocked = patch.object(watch.cb, name, side_effect=AssertionError('unexpected browser operation'))
            blocked.start()
            self.addCleanup(blocked.stop)

    def test_events_permission_is_checked_and_forbidden_is_a_failure(self):
        svc = Mock()
        svc.events.return_value.list.return_value.execute.side_effect = RuntimeError('403 forbidden')
        with patch.object(calendar, 'configured', return_value=True), patch.object(calendar, 'service', return_value=svc):
            self.assertFalse(calendar.healthy()[0])
        svc.calendarList.assert_not_called()

    def test_recovered_calendar_retries_queue_without_new_date_changes(self):
        state = {'health_warned_epoch': 1}
        with patch.object(calendar, 'healthy', return_value=(True, 'ok')), patch.object(calendar, 'apply_queue', return_value=(7, 0)) as retry, patch.object(watch, 'save_json') as save, patch.object(watch, 'log'):
            self.assertTrue(watch.check_calendar(state))
        retry.assert_called_once_with()
        self.assertTrue(state['calendar_health']['ok'])
        self.assertTrue(state['calendar_health']['credentials_ok'])
        self.assertEqual(state['calendar_health']['pending'], 0)
        self.assertNotIn('health_warned_epoch', state)
        save.assert_called_once()

    def test_dry_run_never_saves_notifies_or_applies_calendar_changes(self):
        state = {'health_warned_epoch': 1}
        with patch.object(calendar, 'healthy', return_value=(False, 'expired')), patch.object(calendar, 'apply_queue') as retry, patch.object(watch, 'save_json') as save, patch.object(watch, 'notify') as notify:
            self.assertFalse(watch.check_calendar(state, dry=True))
        self.assertEqual(state, {'health_warned_epoch': 1})
        retry.assert_not_called(); save.assert_not_called(); notify.assert_not_called()

    def test_pending_writes_cannot_be_hidden_by_a_successful_permission_probe(self):
        state = {'calendar_health': {'ok': True, 'checked_at': '2026-10-10T12:00:00Z'}}
        with patch.object(calendar, 'healthy', return_value=(True, 'ok')), patch.object(calendar, 'apply_queue', return_value=(0, 7)), patch.object(watch, 'save_json'), patch.object(watch, 'notify'), patch.object(watch, 'log'):
            self.assertFalse(watch.check_calendar(state))
        health = state['calendar_health']
        self.assertTrue(health['credentials_ok'])
        self.assertFalse(health['ok'])
        self.assertEqual(health['pending'], 7)
        self.assertEqual(health['last_success_at'], '2026-10-10T12:00:00Z')
        self.assertEqual(health['reason'], 'pending_changes')

    def test_retry_failure_preserves_success_and_does_not_expose_the_exception_body(self):
        state = {'calendar_health': {'last_success_at': '2026-10-10T12:00:00Z'}}
        with patch.object(calendar, 'healthy', return_value=(True, 'ok')), patch.object(calendar, 'apply_queue', side_effect=RuntimeError('private refresh_token=secret')), patch.object(watch, 'save_json'), patch.object(watch, 'notify'), patch.object(watch, 'log') as log:
            self.assertFalse(watch.check_calendar(state))
        self.assertEqual(state['calendar_health']['last_success_at'], '2026-10-10T12:00:00Z')
        self.assertNotIn('secret', json.dumps(state))
        self.assertNotIn('secret', str(log.call_args_list))

    def test_quiet_hourly_run_checks_google_without_opening_the_browser(self):
        state = {'checked_epoch': 99999999, 'completion_checked_epoch': 99999999}
        with patch.object(watch, 'load_json', return_value=state), patch.object(watch.time, 'time', return_value=100000000), patch.object(watch, 'check_calendar', return_value=True) as check, patch.object(watch, 'reconcile_completions') as reconciliation, patch.object(watch.cb, 'is_running') as browser, patch.object(sys, 'argv', ['globus_watch.py']):
            self.assertEqual(watch.main(), 0)
        check.assert_called_once_with(state, dry=False)
        reconciliation.assert_called_once_with(state, dry=False)
        browser.assert_not_called()

    def test_health_never_returns_token_or_request_content(self):
        svc = Mock()
        svc.events.return_value.list.return_value.execute.side_effect = RuntimeError('https://example.test/?token=private-token response refresh_token=private-grant')
        with patch.object(calendar, 'configured', return_value=True), patch.object(calendar, 'service', return_value=svc):
            ok, reason = calendar.healthy()
        self.assertFalse(ok)
        self.assertNotIn('private-', reason)
        self.assertNotIn('example.test', reason)
        svc.events.return_value.list.return_value.execute.assert_called_once_with(num_retries=calendar.API_RETRIES)


class CredentialTests(unittest.TestCase):
    """Exercise refresh/consent locally with provider libraries replaced by fakes."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.token = str(Path(self.temp.name) / 'token.json')
        Path(self.token).write_text('{"refresh_token":"old-fake-grant"}')
        self.client = str(Path(self.temp.name) / 'client_secret.json')
        Path(self.client).write_text('{}')
        self.creds = Mock(valid=False, expired=True, refresh_token='old-fake-grant',
                          granted_scopes=None, scopes=calendar.SCOPES)
        self.creds.to_json.return_value = '{"refresh_token":"new-fake-grant"}'
        self.credentials = Mock()
        self.credentials.from_authorized_user_file.return_value = self.creds
        self.flow = Mock()
        self.flow.from_client_secrets_file.return_value.run_local_server.return_value = self.creds
        self.request = Mock()
        self.build = Mock()
        self.http = Mock()
        modules = {
            'google.oauth2.credentials': SimpleNamespace(Credentials=self.credentials),
            'google.auth.transport.requests': SimpleNamespace(Request=self.request),
            'google_auth_oauthlib.flow': SimpleNamespace(InstalledAppFlow=self.flow),
            'googleapiclient.discovery': SimpleNamespace(build=self.build),
            'google_auth_httplib2': SimpleNamespace(AuthorizedHttp=self.http),
            'httplib2': SimpleNamespace(Http=Mock()),
        }
        patches = [patch.dict(sys.modules, modules), patch.object(calendar, 'TOKEN', self.token), patch.object(calendar, 'CLIENT_SECRET', self.client)]
        for p in patches:
            p.start(); self.addCleanup(p.stop)

    def test_expired_access_token_refreshes_offline_and_persists_the_whole_grant(self):
        calendar.service()
        request = self.creds.refresh.call_args.args[0]
        request(url='https://oauth.example.test')
        self.request.return_value.assert_called_once_with(url='https://oauth.example.test', timeout=calendar.API_TIMEOUT)
        self.assertEqual(json.loads(Path(self.token).read_text())['refresh_token'], 'new-fake-grant')
        self.assertEqual(os.stat(self.token).st_mode & 0o777, 0o600)
        self.flow.from_client_secrets_file.assert_not_called()
        self.assertNotIn('credentials', self.build.call_args.kwargs)
        self.assertIn('http', self.build.call_args.kwargs)

    def test_explicit_authorize_replaces_a_valid_testing_grant(self):
        self.creds.valid = True
        calendar.service(interactive=True)
        self.credentials.from_authorized_user_file.assert_not_called()
        self.flow.from_client_secrets_file.assert_called_once_with(self.client, calendar.SCOPES)
        call = self.flow.from_client_secrets_file.return_value.run_local_server.call_args.kwargs
        self.assertEqual(call['access_type'], 'offline')
        self.assertEqual(call['prompt'], 'consent')
        self.assertEqual(json.loads(Path(self.token).read_text())['refresh_token'], 'new-fake-grant')

    def test_revoked_refresh_requires_human_consent_and_preserves_the_old_file(self):
        self.creds.refresh.side_effect = RuntimeError('invalid_grant secret=private-grant')
        with self.assertRaises(calendar.NeedsReauth) as caught:
            calendar.service()
        self.assertNotIn('private-grant', str(caught.exception))
        self.assertEqual(json.loads(Path(self.token).read_text())['refresh_token'], 'old-fake-grant')
        self.flow.from_client_secrets_file.assert_not_called()

    def test_transient_refresh_failure_preserves_credentials_for_next_hour(self):
        self.creds.refresh.side_effect = TimeoutError('secret=private-grant')
        with self.assertRaises(RuntimeError) as caught:
            calendar.service()
        self.assertIn('timed out', str(caught.exception))
        self.assertNotIn('private-grant', str(caught.exception))
        self.assertEqual(json.loads(Path(self.token).read_text())['refresh_token'], 'old-fake-grant')

    def test_consent_without_refresh_token_cannot_overwrite_existing_grant(self):
        self.creds.valid = True
        self.creds.refresh_token = None
        with self.assertRaises(calendar.NeedsReauth):
            calendar.service(interactive=True)
        self.assertEqual(json.loads(Path(self.token).read_text())['refresh_token'], 'old-fake-grant')

    def test_missing_or_broader_granted_scopes_preserve_the_existing_grant(self):
        for actual in ([], ['https://www.googleapis.com/auth/calendar'],
                       calendar.SCOPES + ['https://www.googleapis.com/auth/drive.readonly']):
            with self.subTest(actual=actual):
                self.creds.valid = True
                self.creds.granted_scopes = actual
                with self.assertRaises(calendar.NeedsReauth):
                    calendar.service(interactive=True)
                self.assertEqual(json.loads(Path(self.token).read_text())['refresh_token'], 'old-fake-grant')

    def test_explicit_provider_granted_scopes_are_checked_before_requested_scopes(self):
        self.creds.valid = True
        self.creds.granted_scopes = list(calendar.SCOPES)
        self.creds.scopes = ['https://www.googleapis.com/auth/calendar']
        calendar.service(interactive=True)
        self.assertEqual(json.loads(Path(self.token).read_text())['refresh_token'], 'new-fake-grant')
        self.assertEqual(json.loads(Path(self.token).read_text())['scopes'], calendar.SCOPES)

    def test_unknown_grant_scopes_cannot_replace_existing_authorization(self):
        self.creds.valid = True
        self.creds.granted_scopes = None
        self.creds.scopes = None
        with self.assertRaises(calendar.NeedsReauth):
            calendar.service(interactive=True)
        self.assertEqual(json.loads(Path(self.token).read_text())['refresh_token'], 'old-fake-grant')

    def test_interrupted_save_leaves_the_existing_private_grant_intact(self):
        with patch.object(calendar.json, 'dump', side_effect=OSError('disk unavailable')):
            with self.assertRaises(OSError):
                calendar.save_json(self.token, {'refresh_token': 'new-fake-grant'})
        self.assertEqual(json.loads(Path(self.token).read_text())['refresh_token'], 'old-fake-grant')
        self.assertEqual(sorted(p.name for p in Path(self.temp.name).iterdir()), ['client_secret.json', 'token.json'])


class IdempotentCalendarTests(unittest.TestCase):
    def setUp(self):
        self.svc = Mock()
        self.title = calendar.TITLE_GUARD + ' — Decision Year 9'
        self.change = {'kind': 'add', 'calendar_title': self.title, 'to': '19-Oct-2026, 11:59 PM'}
        self.owned = {'id': 'owned-existing', 'summary': self.title,
                      'start': {'dateTime': '2026-10-19T23:00:00-04:00'},
                      'end': {'dateTime': '2026-10-19T23:59:00-04:00'}}

    def test_add_retry_acknowledges_an_existing_exact_owned_event_without_writing(self):
        self.assertTrue(calendar.apply_patch(self.svc, self.change, {self.title: self.owned})[0])
        self.svc.events.return_value.insert.assert_not_called()
        self.svc.events.return_value.patch.assert_not_called()

    def test_existing_owned_event_with_wrong_date_or_all_day_shape_is_reconciled(self):
        for start, end in (({'dateTime': '2026-10-14T23:00:00-04:00'}, {'dateTime': '2026-10-14T23:59:00-04:00'}),
                           ({'date': '2026-10-19'}, {'date': '2026-10-20'})):
            with self.subTest(start=start):
                self.svc.reset_mock()
                ev = dict(self.owned, start=start, end=end)
                index = {self.title: ev}
                self.assertTrue(calendar.apply_patch(self.svc, self.change, index)[0])
                call = self.svc.events.return_value.patch.call_args.kwargs
                self.assertEqual(call['eventId'], ev['id'])
                self.assertEqual(call['body']['start']['dateTime'], '2026-10-19T23:00:00')
                self.svc.events.return_value.insert.assert_not_called()
                self.assertTrue(calendar.event_at_expected_times(index[self.title], calendar.parse_glo_date(self.change['to'])))

    def test_failed_insert_reply_uses_a_stable_id_and_cannot_duplicate_on_conflict(self):
        first_index = {}
        self.svc.events.return_value.insert.return_value.execute.side_effect = TimeoutError('reply lost')
        with self.assertRaises(TimeoutError):
            calendar.apply_patch(self.svc, self.change, first_index)
        first_id = self.svc.events.return_value.insert.call_args.kwargs['body']['id']
        conflict = RuntimeError('exists')
        conflict.resp = SimpleNamespace(status=409)
        self.svc.events.return_value.insert.return_value.execute.side_effect = conflict
        self.svc.events.return_value.get.return_value.execute.return_value = dict(self.owned, id=first_id)
        self.assertTrue(calendar.apply_patch(self.svc, self.change, {})[0])
        second_id = self.svc.events.return_value.insert.call_args.kwargs['body']['id']
        self.assertEqual(first_id, second_id)
        self.assertTrue(set(first_id) <= set('0123456789abcdefghijklmnopqrstuv'))
        self.svc.events.return_value.get.assert_called_once_with(calendarId=calendar.CALENDAR_ID, eventId=first_id)
        self.svc.events.return_value.patch.assert_not_called()

    def test_conflict_with_unowned_event_is_not_acknowledged_or_patched(self):
        conflict = RuntimeError('exists')
        conflict.resp = SimpleNamespace(status=409)
        self.svc.events.return_value.insert.return_value.execute.side_effect = conflict
        self.svc.events.return_value.get.return_value.execute.return_value = dict(self.owned, summary='A personal appointment')
        self.assertFalse(calendar.apply_patch(self.svc, self.change, {})[0])
        self.svc.events.return_value.patch.assert_not_called()

    def test_two_adds_in_one_queue_use_the_same_index_after_creation(self):
        self.svc.events.return_value.insert.return_value.execute.side_effect = lambda **_kw: dict(self.svc.events.return_value.insert.call_args.kwargs['body'])
        index = {}
        self.assertTrue(calendar.apply_patch(self.svc, self.change, index)[0])
        self.assertTrue(calendar.apply_patch(self.svc, self.change, index)[0])
        self.svc.events.return_value.insert.assert_called_once()
        self.svc.events.return_value.patch.assert_not_called()

    def test_uncertain_insert_identity_is_retained_and_not_added_to_the_index(self):
        self.svc.events.return_value.insert.return_value.execute.return_value = {'id': 'unexpected'}
        index = {}
        with self.assertRaises(RuntimeError):
            calendar.apply_patch(self.svc, self.change, index)
        self.assertEqual(index, {})

    def test_conflict_readback_wrong_id_cannot_patch_another_event(self):
        conflict = RuntimeError('exists')
        conflict.resp = SimpleNamespace(status=409)
        self.svc.events.return_value.insert.return_value.execute.side_effect = conflict
        self.svc.events.return_value.get.return_value.execute.return_value = self.owned
        self.assertFalse(calendar.apply_patch(self.svc, self.change, {})[0])
        self.svc.events.return_value.patch.assert_not_called()

    def test_wrong_title_index_and_recurring_instances_are_retained_without_writes(self):
        for ev in (dict(self.owned, summary='A personal appointment'), dict(self.owned, recurringEventId='recurring')):
            with self.subTest(ev=ev):
                self.assertFalse(calendar.apply_patch(self.svc, self.change, {self.title: ev})[0])
        self.svc.events.return_value.patch.assert_not_called()
        self.svc.events.return_value.insert.assert_not_called()

    def test_dry_reconciliation_never_writes_or_changes_the_index(self):
        ev = dict(self.owned, start={'date': '2026-10-14'})
        index = {self.title: ev}
        self.assertTrue(calendar.apply_patch(self.svc, self.change, index, dry=True)[0])
        self.assertEqual(index, {self.title: ev})
        self.svc.events.return_value.patch.assert_not_called()
        self.svc.events.return_value.insert.assert_not_called()


if __name__ == '__main__': unittest.main()
