import contextlib
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bin'))
import elc_announcements as a

NOW = '2026-10-11T01:00:00+00:00'
EARLIER = '2026-10-10T01:00:00+00:00'


def news(identifier='7098040', text=None, **extra):
    row = {'Id': identifier, 'Title': 'Test 2 Day Moved',
        'Body': {'Html': text or '<p>Test 2 has been moved to Monday, October 19th, 2026 instead of October 14th.</p>'},
        'IsPublished': True, 'IsHidden': False,
        'StartDate': '2026-10-05T18:29:00Z', 'LastModifiedDate': '2026-10-05T20:04:00Z'}
    row.update(extra)
    return row


def full_results(cfg, items=None):
    return {c: {'ok': True, 'org_unit_id': org, 'items': (items or {}).get(c, [])}
            for c, org in cfg['courses'].items()}


class AnnouncementSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.cfg = a.source_config()
        initial = full_results(self.cfg, {'MGMT5560': [news()]})
        self.prior = a.snapshot(initial, cfg=self.cfg, observed_at=EARLIER)

    def test_exact_pinned_term_org_and_aliases(self):
        self.assertEqual(self.cfg['courses']['BUSN3040'], '3955142')
        self.assertEqual(self.cfg['elc_term_code'], '20272')
        self.assertEqual(a.course_code('LAND2510E'), 'LAND2510')
        self.assertEqual(a.course_code('BUSN3040E'), 'BUSN3040')
        with patch.object(a.cb, 'run_js') as run:
            result = a.read_courses(1, 1, self.cfg['courses'], cfg=self.cfg, term_code='20281')
        self.assertTrue(all(r['error'] == 'course_identity' for r in result.values()))
        run.assert_not_called()

    def test_full_success_records_course_coverage_and_source_precision(self):
        r = self.prior
        self.assertEqual(len(r['coverage']), 6)
        self.assertTrue(all(row['complete'] for row in r['coverage']))
        self.assertEqual(r['last_complete_success_at'], EARLIER)
        item = r['announcements'][0]
        self.assertEqual(item['published_at'], '2026-10-05T18:29:00+00:00')
        self.assertEqual(item['modified_at'], '2026-10-05T20:04:00+00:00')
        self.assertEqual(item['observed_at'], EARLIER)
        self.assertEqual(item['source_url'], 'https://uga.view.usg.edu/d2l/le/news/3963225/7098040/view?ou=3963225')
        self.assertNotIn('when_iso', item)
        self.assertNotIn('progress', r)

    def test_failed_course_retains_evidence_and_last_complete_success(self):
        results = full_results(self.cfg)
        results['MGMT5560'] = {'error': 'session'}
        r = a.snapshot(results, self.prior, cfg=self.cfg, observed_at=NOW)
        self.assertEqual(r['announcements'], self.prior['announcements'])
        coverage = next(row for row in r['coverage'] if row['course_code'] == 'MGMT5560')
        self.assertEqual(coverage['last_success_at'], EARLIER)
        self.assertEqual(coverage['last_complete_success_at'], EARLIER)
        self.assertEqual(coverage['checked_at'], NOW)
        self.assertFalse(coverage['complete'])
        self.assertEqual(coverage['status'], 'blocked')
        self.assertEqual(r['last_complete_success_at'], EARLIER)

    def test_empty_complete_listing_can_replace_but_error_is_not_empty(self):
        r = a.snapshot(full_results(self.cfg), self.prior, cfg=self.cfg, observed_at=NOW)
        self.assertEqual(r['announcements'], [])
        bad = full_results(self.cfg)
        bad['MGMT5560'] = {'ok': True, 'org_unit_id': '3963225', 'items': {'Items': []}}
        r = a.snapshot(bad, self.prior, cfg=self.cfg, observed_at=NOW)
        self.assertEqual(r['announcements'], self.prior['announcements'])
        self.assertFalse(next(row for row in r['coverage'] if row['course_code'] == 'MGMT5560')['complete'])

    def test_recent_feed_merges_and_never_freshens_missing_older_items(self):
        results = full_results(self.cfg)
        results['MGMT5560'].update(scope='recent_feed', items=[news('7100810')])
        r = a.snapshot(results, self.prior, cfg=self.cfg, observed_at=NOW)
        items = {row['announcement_id']: row for row in r['announcements']}
        self.assertEqual(set(items), {'7098040', '7100810'})
        self.assertEqual(items['7098040']['observed_at'], EARLIER)
        self.assertEqual(items['7100810']['observed_at'], NOW)
        coverage = next(row for row in r['coverage'] if row['course_code'] == 'MGMT5560')
        self.assertEqual(coverage['scope'], 'recent_feed')
        self.assertEqual(coverage['status'], 'ok')
        self.assertFalse(coverage['complete'])
        self.assertEqual(coverage['last_success_at'], NOW)
        self.assertEqual(coverage['last_complete_success_at'], EARLIER)

    def test_unchanged_feed_body_preserves_known_original_api_timestamps(self):
        results = full_results(self.cfg)
        results['MGMT5560'].update(scope='recent_feed', items=[news(StartDate=None, LastModifiedDate=None, FeedPublishedDate='2026-10-05T20:04:00Z')])
        r = a.snapshot(results, self.prior, cfg=self.cfg, observed_at=NOW)
        item = r['announcements'][0]
        self.assertEqual(item['published_at'], self.prior['announcements'][0]['published_at'])
        self.assertEqual(item['modified_at'], self.prior['announcements'][0]['modified_at'])
        self.assertEqual(item['feed_published_at'], '2026-10-05T20:04:00+00:00')
        self.assertEqual(item['observed_at'], NOW)

    def test_duplicate_oversized_or_wrong_course_identity_preserves_last_success(self):
        cases = [dict(ok=True, org_unit_id='3963225', items=[news(), news()]),
                 dict(ok=True, org_unit_id='3963225', items=[news(str(i + 1)) for i in range(a.MAX_PER_COURSE + 1)]),
                 dict(ok=True, org_unit_id='4001788', items=[news()])]
        for bad in cases:
            with self.subTest(bad_type=bad.get('org_unit_id'), length=len(bad['items'])):
                results = full_results(self.cfg)
                results['MGMT5560'] = bad
                r = a.snapshot(results, self.prior, cfg=self.cfg, observed_at=NOW)
                self.assertEqual(r['announcements'], self.prior['announcements'])
                self.assertFalse(next(row for row in r['coverage'] if row['course_code'] == 'MGMT5560')['complete'])

    def test_bodies_carry_only_scheduling_excerpts_and_never_grade_or_secret_text(self):
        html = '<script>refresh_token=private-token</script><p>Course grades average 82%. Your score is 91/100.</p><p>Test 2 is moved to October 19, 2026.</p><p>Watch the Porter video before class.</p><p>password=private-password Monday October 19 exam.</p>'
        row = a.normalize_items('MGMT5560', '3963225', [news(text=html)], NOW)[0]
        self.assertEqual(row['text'], 'Test 2 is moved to October 19, 2026.')
        self.assertTrue(row['privacy_redacted'])
        for forbidden in ('private-token', 'private-password', '82%', '91/100', 'Porter video'):
            self.assertNotIn(forbidden, json.dumps(row))
        self.assertRegex(row['content_sha256'], '^[a-f0-9]{64}$')

    def test_announcement_edit_changes_digest_and_unknown_metadata_stays_unknown(self):
        one = a.normalize_items('MGMT5560', '3963225', [news(StartDate=None, LastModifiedDate=None)], NOW)[0]
        two = a.normalize_items('MGMT5560', '3963225', [news(text='<p>Test 2 is moved to October 20, 2026.</p>')], NOW)[0]
        self.assertNotEqual(one['content_sha256'], two['content_sha256'])
        self.assertIsNone(one['published_at'])
        self.assertIsNone(one['modified_at'])

    def test_hidden_and_unpublished_news_cannot_be_date_authority(self):
        rows = a.normalize_items('MGMT5560', '3963225', [news(IsHidden=True), news('2', IsPublished=False)], NOW)
        self.assertEqual(rows, [])


class RssTests(unittest.TestCase):
    def feed(self, guid='7098040-3963225', description=None):
        body = description or '&lt;p&gt;Test 2 is moved to October 19, 2026.&lt;/p&gt;'
        return ('<rss version="2.0"><channel><item><title>Test 2 Day Moved</title>'
            '<link>https://uga.view.usg.edu/d2l/lms/news/main.d2l?ou=3963225</link>'
            '<guid>' + guid + '</guid><pubDate>Mon, 5 Oct 2026 20:04:00 GMT</pubDate>'
            '<description>' + body + '</description></item></channel></rss>').encode()

    def test_valid_rss_has_exact_course_news_identity_and_explicit_recent_scope(self):
        result = a.parse_rss(self.feed(), 'MGMT5560', '3963225')
        self.assertEqual(result['items'][0]['Id'], '7098040')
        self.assertEqual(result['scope'], 'recent_feed')
        self.assertIsNone(result['items'][0]['StartDate'])
        self.assertEqual(result['items'][0]['FeedPublishedDate'], '2026-10-05T20:04:00+00:00')
        self.assertIsNone(result['items'][0]['LastModifiedDate'])

    def test_wrong_org_entity_or_html_login_is_rejected(self):
        for raw in (self.feed(guid='7098040-4001788'), b'<html>Sign in</html>',
                    b'<!DOCTYPE rss [<!ENTITY x "private">]><rss><channel /></rss>'):
            with self.subTest(raw_kind=raw[:20]):
                with self.assertRaises(ValueError):
                    a.parse_rss(raw, 'MGMT5560', '3963225')

    def test_private_feed_url_errors_are_sanitized_and_redirects_disabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / 'rss.json'
            a.save_json(config, {'schema_version': 1, 'term_id': 'fall-2026',
                'feeds': {'MGMT5560': 'https://uga.view.usg.edu/d2l/le/news/rss/3963225/course?token=private-token&ou=3963225'}})
            opener = Mock()
            opener.open.side_effect = urllib.error.URLError('private-token in request')
            with patch.object(a.urllib.request, 'build_opener', return_value=opener) as build:
                result = a.read_rss_courses(config_path=config)
            self.assertEqual(result['MGMT5560']['error'], 'source_unavailable')
            self.assertNotIn('private-token', json.dumps(result))
            self.assertIsInstance(build.call_args.args[0], a.NoRedirect)
            self.assertIsNone(a.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.test'))


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / 'state.json'
        self.box = Path(self.tmp.name) / 'outbox.json'
        self.cfg = a.source_config()
        self.snapshot = a.snapshot(full_results(self.cfg), cfg=self.cfg, observed_at=NOW)
        self.pending = {'snapshot': self.snapshot, 'idempotency_key': 'logical-save', 'expected_revision': 4}
        a.save_json(self.state, {'snapshot': self.snapshot})
        a.save_json(self.box, self.pending)

    def test_post_plus_matching_readback_is_required_to_clear_private_outbox(self):
        receipt = {'ok': True, 'revision': 5, 'snapshot_digest': 'safe-digest', 'received_at': NOW}
        with patch.object(a, 'bridge_request', side_effect=[receipt, {'revision': 5, 'snapshot_digest': 'safe-digest', 'snapshot': self.snapshot}]):
            self.assertTrue(a.publish_pending(state_path=self.state, outbox_path=self.box, config={'exists': True}))
        self.assertFalse(self.box.exists())
        self.assertEqual(a.load_json(self.state, {})['publication']['revision'], 5)
        self.assertEqual(os.stat(self.state).st_mode & 0o777, 0o600)

    def test_uncertain_reply_reuses_exact_snapshot_key_and_observation_time(self):
        with patch.object(a, 'bridge_request', side_effect=urllib.error.URLError('private-key')), patch.object(a, 'bridge_config', return_value={'exists': True}):
            self.assertFalse(a.publish_pending(state_path=self.state, outbox_path=self.box))
            a.record(full_results(self.cfg), observed_at='2026-10-12T01:00:00Z', state_path=self.state, outbox_path=self.box)
        self.assertEqual(a.load_json(self.box, {}), self.pending)
        self.assertEqual(a.load_json(self.state, {})['snapshot']['attempted_at'], NOW)

    def test_acknowledgement_without_readback_match_stays_pending(self):
        with patch.object(a, 'bridge_request', side_effect=[{'ok': True, 'revision': 5, 'snapshot_digest': 'one'}, {'revision': 5, 'snapshot_digest': 'other'}]):
            self.assertFalse(a.publish_pending(state_path=self.state, outbox_path=self.box, config={'exists': True}))
        self.assertTrue(self.box.exists())
        self.assertNotIn('publication', a.load_json(self.state, {}))

    def test_replayed_committed_receipt_is_retired_when_a_newer_read_is_already_current(self):
        newer = a.snapshot(full_results(self.cfg, {'MGMT5560': [news()]}), cfg=self.cfg,
                           observed_at='2026-10-11T02:00:00+00:00')
        receipt = {'ok': True, 'revision': 5, 'snapshot_digest': 'earlier-digest',
                   'operation_id': 'logical-save', 'received_at': NOW, 'replayed': True}
        current = {'ok': True, 'revision': 6, 'snapshot_digest': 'current-digest', 'snapshot': newer}
        log = Mock()
        with patch.object(a, 'bridge_request', side_effect=[receipt, current]) as request:
            self.assertTrue(a.publish_pending(state_path=self.state, outbox_path=self.box, config={'exists': True}, log=log))
        self.assertEqual(request.call_count, 2)
        self.assertEqual(request.call_args_list[0].args[3], self.pending)
        self.assertFalse(self.box.exists())
        state = a.load_json(self.state, {})
        self.assertEqual(state['snapshot'], newer)
        self.assertEqual(state['publication']['state'], 'superseded')
        self.assertEqual(state['publication']['revision'], 5)
        self.assertEqual(state['publication']['current_revision'], 6)
        self.assertEqual(state['snapshot']['announcements'][0]['observed_at'], '2026-10-11T02:00:00+00:00')
        self.assertNotIn('saved and read back', str(log.call_args_list))

    def test_receipt_for_another_operation_cannot_retire_this_outbox(self):
        wrong = {'ok': True, 'revision': 5, 'snapshot_digest': 'other', 'operation_id': 'another-save'}
        with patch.object(a, 'bridge_request', return_value=wrong):
            self.assertFalse(a.publish_pending(state_path=self.state, outbox_path=self.box, config={'exists': True}))
        self.assertTrue(self.box.exists())

    def test_matching_digest_without_our_source_row_is_not_saved(self):
        populated = a.snapshot(full_results(self.cfg, {'MGMT5560': [news()]}), cfg=self.cfg, observed_at=NOW)
        pending = dict(self.pending, snapshot=populated)
        a.save_json(self.box, pending)
        with patch.object(a, 'bridge_request', side_effect=[{'ok': True, 'revision': 5, 'snapshot_digest': 'one'},
                {'revision': 5, 'snapshot_digest': 'one', 'snapshot': self.snapshot}]):
            self.assertFalse(a.publish_pending(state_path=self.state, outbox_path=self.box, config={'exists': True}))
        self.assertTrue(self.box.exists())

    def test_conclusive_revision_conflict_rebases_without_freshening_observation(self):
        rejected = urllib.error.HTTPError('https://bridge.test', 409, '', {},
            io.BytesIO(b'{"error":"revision_conflict","current_revision":5}'))
        newer = a.snapshot(full_results(self.cfg, {'MGMT5560': [news()]}), cfg=self.cfg,
                           observed_at='2026-10-11T02:00:00+00:00')
        posts = []
        def request(config, method, path, data=None):
            if method == 'POST':
                posts.append(copy.deepcopy(data))
                if len(posts) == 1:
                    raise rejected
                return {'ok': True, 'revision': 6, 'snapshot_digest': 'new', 'received_at': NOW}
            if len(posts) == 1:
                return {'revision': 5, 'snapshot_digest': 'existing', 'snapshot': newer}
            return {'revision': 6, 'snapshot_digest': 'new', 'snapshot': posts[-1]['snapshot']}
        with patch.object(a, 'bridge_request', side_effect=request):
            self.assertTrue(a.publish_pending(state_path=self.state, outbox_path=self.box, config={'exists': True}))
        self.assertEqual(posts[0]['idempotency_key'], 'logical-save')
        self.assertNotEqual(posts[1]['idempotency_key'], 'logical-save')
        self.assertEqual(posts[1]['expected_revision'], 5)
        self.assertEqual(posts[1]['snapshot']['announcements'][0]['observed_at'], '2026-10-11T02:00:00+00:00')

    def test_provider_error_text_never_reaches_logs(self):
        log = Mock()
        with patch.object(a, 'bridge_request', side_effect=urllib.error.URLError('refresh_token=private-grant')):
            self.assertFalse(a.publish_pending(state_path=self.state, outbox_path=self.box, config={'exists': True}, log=log))
        self.assertNotIn('private-grant', str(log.call_args_list))

    def test_dry_run_does_not_save_publish_or_change_existing_receipt(self):
        with patch.object(a, 'save_json') as save, patch.object(a, 'publish_pending') as publish:
            a.record(full_results(self.cfg), dry=True, state_path=self.state, outbox_path=self.box)
        save.assert_not_called()
        publish.assert_not_called()
        self.assertEqual(a.load_json(self.box, {}), self.pending)


class ExistingWakeupTests(unittest.TestCase):
    def setUp(self):
        import elc_daily as daily
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        # main now retries material delivery before checking the news cooldown.
        # Isolate both that new stage and every path used by its wrapper: mocking
        # old load_json alone no longer prevents real extraction/Drive writes.
        for name, value in {'ROOT': str(root), 'MANIFEST': str(root/'.manifest.json'),
                'FETCHED': str(root/'.fetched.json'), 'STATE': str(root/'.daily-state.json'),
                'PENDING': str(root/'.pending-upload.json'), 'REPORTS': str(root/'reports'),
                'LOG': str(root/'logs/daily.log'), 'DOWNLOADS': str(root/'downloads'),
                'BRIDGE_NOTE': str(root/'note.sh')}.items():
            stack.enter_context(patch.object(daily, name, value))
        stack.enter_context(patch.object(daily, 'recovery_scope', return_value={'BUSN5000'}))
        self.recover = stack.enter_context(patch.object(daily, 'recover_materials', return_value={'pending':0}))
        self.health = stack.enter_context(patch.object(daily, 'material_health'))
        # Fail closed if a later refactor adds another unmocked external call.
        for obj, name in ((daily.subprocess,'run'), (daily.subprocess,'Popen'),
                          (daily.transcribe,'transcribe'), (daily.drive_sync,'file_item'),
                          (daily.gpt_upload,'upload_many'), (daily.material_bridge,'request'),
                          (daily.cb,'open_tab'), (daily.cb,'run_js'), (daily.cb,'run_js_json')):
            stack.enter_context(patch.object(obj, name, side_effect=AssertionError('offline hook test')))

    def test_hourly_news_check_runs_before_materials_four_hour_cooldown(self):
        import elc_daily as daily
        cfg = {'courses': {'BUSN5000':4048786}}
        discovered = Mock(return_value=cfg['courses'], current_term='20272')
        with patch.object(sys, 'argv', ['elc_daily.py']), patch.object(daily.time, 'time', return_value=100000000), \
                patch.object(daily, 'load_json', return_value={'last_success_epoch': 99999999}), \
                patch.object(daily, 'load_pending', return_value={'files': []}), patch.object(daily, 'log'), \
                patch.object(daily.cb, 'is_running', return_value=True), patch.object(daily.cb, 'find_tab', return_value=(1, 1)), \
                patch.object(daily, 'js_json', return_value={'ok': True}), patch.object(daily, 'discover_courses', discovered), \
                patch.object(daily.elc_submission, 'due', return_value=False), \
                patch.object(daily.elc_announcements, 'due', return_value=True), \
                patch.object(daily.elc_announcements, 'read_rss_courses', return_value={}), \
                patch.object(daily.elc_announcements, 'publish_pending'), \
                patch.object(daily.elc_announcements, 'collect') as collect, patch.object(daily, 'sweep') as sweep, \
                patch.object(daily, 'save_json') as save:
            self.assertEqual(daily.main(), 0)
        collect.assert_called_once()
        self.assertEqual(collect.call_args.kwargs['term_code'], '20272')
        sweep.assert_not_called()
        save.assert_not_called()
        self.recover.assert_called_once_with({'BUSN5000'})
        self.health.assert_called_once()

    def test_browser_unavailable_retains_rss_fallback_without_marking_materials_success(self):
        import elc_daily as daily
        rss = {'MGMT5560': {'ok': True, 'scope': 'recent_feed'}}
        with patch.object(sys, 'argv', ['elc_daily.py']), patch.object(daily.time, 'time', return_value=100000000), \
                patch.object(daily, 'load_json', return_value={'last_success_epoch': 99999999}), patch.object(daily, 'log'), \
                patch.object(daily.cb, 'is_running', return_value=False), \
                patch.object(daily.elc_submission, 'due', return_value=False), \
                patch.object(daily.elc_announcements, 'due', return_value=True), \
                patch.object(daily.elc_announcements, 'read_rss_courses', return_value=rss), \
                patch.object(daily.elc_announcements, 'publish_pending'), \
                patch.object(daily.elc_announcements, 'blocked') as blocked, patch.object(daily, 'save_json') as save:
            self.assertEqual(daily.main(), 0)
        self.assertEqual(blocked.call_args.args, ('browser',))
        self.assertEqual(blocked.call_args.kwargs['rss_results'], rss)
        save.assert_not_called()

    def test_upload_only_does_not_collect_news_or_require_elc(self):
        import elc_daily as daily
        with patch.object(sys, 'argv', ['elc_daily.py', '--upload-only']), patch.object(daily, 'log'), \
                patch.object(daily.cb, 'is_running', return_value=True), \
                patch.object(daily, 'flush_upload_queue', return_value=([], [], [])), \
                patch.object(daily.elc_announcements, 'read_rss_courses') as rss, \
                patch.object(daily.elc_announcements, 'collect') as collect:
            self.assertEqual(daily.main(), 0)
        rss.assert_not_called()
        collect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
