"""Controlled collector integration: temporary files, fake browser and HTTP."""
import contextlib
import io
import json
import sys
import tempfile
import time
from pathlib import Path
import unittest
import zipfile
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bin'))
import elc_daily as daily


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        for name, value in {'ROOT': str(self.root), 'MANIFEST': str(self.root / '.manifest.json'),
                            'FETCHED': str(self.root / '.fetched.json'), 'STATE': str(self.root / '.daily-state.json'),
                            'PENDING': str(self.root / '.pending-upload.json'), 'REPORTS': str(self.root / 'reports'),
                            'LOG': str(self.root / 'logs/daily.log'), 'DOWNLOADS': str(self.root / 'downloads')}.items():
            self.stack.enter_context(patch.object(daily, name, value))
        self.stack.enter_context(patch.object(daily.bundle, 'ROOT', str(self.root)))
        self.stack.enter_context(patch.object(daily.drive_sync, 'ROOT', str(self.root)))
        self.stack.enter_context(patch.object(daily.drive_sync, 'CACHE', str(self.root / '.drive-index.json')))
        self.stack.enter_context(patch.object(daily.drive_sync, 'DRIVE', str(self.root / 'Drive')))
        self.stack.enter_context(patch.object(daily.material_bridge, 'request', side_effect=AssertionError('no live HTTP')))
        self.stack.enter_context(patch.object(daily.gpt_upload, 'upload_many', side_effect=AssertionError('no live GPT')))
        self.put('gpts.json', json.dumps({'BUSN3040': 'fake-gpt', 'MGMT4280': 'fake-gpt2'}))
        self.put('.manifest.json', json.dumps({'courses': {'BUSN3040': {'items': []}}}))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))

    def put(self, rel, value):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
        return path

    def pending(self, body='FAKE source', course='BUSN3040', name='source.txt', revision='v1'):
        path = self.put(f'{course}/text/{name}', body)
        daily.queue_upload(course, str(path), 'Fake source', revision)
        return path

    def files(self):
        return {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}

    def native_capture(self, course='BUSN3040', topic='1'):
        partial = self.put('downloads/lecture.mp4.crdownload', 'FAKE complete media bytes')
        stat = partial.stat()
        row = {'capture_id': 'fake-native-capture', 'status': 'pending', 'course': course,
               'topic_id': topic, 'org_unit': '123', 'term': '20272',
               'partial_name': partial.name, 'final_name': 'lecture.mp4',
               'device': stat.st_dev, 'inode': stat.st_ino, 'minimum_bytes': 10,
               'source_path': '/content/enforced4/123-test.20272/lecture.mp4',
               'expected_duration_seconds': 30, 'registered_at': '2026-10-12T05:00:00Z'}
        self.put('.pending-native-materials.json', json.dumps({'version': 1, 'captures': [row]}))
        return partial

    def test_native_intake_waits_for_partial_then_recovers_once_before_stage_recovery(self):
        partial = self.native_capture()
        item = {'id': 1, 'title': 'Lecture', 'unit': 'Week 1', 'type': 'File', 'ext': 'mp4',
                'url_path': '/content/enforced4/123-test.20272/lecture.mp4'}
        self.put('.manifest.json', json.dumps({'courses': {'BUSN3040': {'items': [item]}}}))
        original = daily.native_material_intake.recover
        def offline_recover(*args, **kwargs):
            return original(*args, **kwargs, inspect_media=lambda path: 30)
        with patch.object(daily.elc_announcements, 'source_config', return_value={
                'courses': {'BUSN3040': '123'}, 'elc_term_code': '20272'}), \
             patch.object(daily.native_material_intake, 'recover', side_effect=offline_recover), \
             patch.object(daily.material_delivery.DeliveryQueue, 'run', return_value={'pending': 1}):
            waiting = daily.recover_materials({'BUSN3040'}, seed=False)
            self.assertEqual(waiting['native_intake']['accepted'], 0)
            self.assertEqual(daily.delivery_queue().entries(read_only=True), {})
            partial.rename(partial.with_suffix(''))
            accepted = daily.recover_materials({'BUSN3040'}, seed=False)
            self.assertEqual(accepted['native_intake']['accepted'], 1)
            fetched = json.loads(Path(daily.FETCHED).read_text())['1']
            record = daily.delivery_queue().entries(read_only=True)['BUSN3040:1']
            self.assertEqual(fetched['native_source_receipt']['source_sha256'], record['source_sha256'])
            before = Path(daily.FETCHED).read_bytes()
            again = daily.recover_materials({'BUSN3040'}, seed=False)
            self.assertEqual(again['native_intake']['accepted'], 0)
            self.assertEqual(Path(daily.FETCHED).read_bytes(), before)
            self.assertEqual(len(daily.delivery_queue().entries(read_only=True)), 1)

    def test_native_transfer_holds_other_source_capture_and_reports_pending(self):
        self.native_capture()
        items = [{'id': n, 'title': f'Fake {n}', 'unit': 'Week 1', 'type': 'File', 'ext': 'pdf'} for n in (1, 2)]
        trigger = self.simulated_source_run(items, [])
        self.assertEqual(daily.main(), 0)
        trigger.assert_not_called()
        state = json.loads(Path(daily.STATE).read_text())
        self.assertEqual(state['material_revision_deferred'], 2)
        self.assertEqual(state['material_health']['native_downloads']['pending'], 1)
        self.assertEqual(state['material_health']['status'], 'pending')

    def test_corrupt_native_receipt_holds_capture_but_keeps_local_stage_recovery(self):
        self.put('.pending-native-materials.json', '{broken')
        with patch.object(daily.material_delivery.DeliveryQueue, 'run', return_value={'pending': 0}) as run:
            result = daily.recover_materials({'BUSN3040'}, seed=False)
        run.assert_called_once()
        self.assertTrue(result['native_intake']['blocked'])
        trigger = self.simulated_source_run([{'id': 1, 'title': 'Fake', 'unit': 'Week 1', 'type': 'File', 'ext': 'pdf'}], [])
        self.assertEqual(daily.main(), 0)
        trigger.assert_not_called()
        self.assertEqual(json.loads(Path(daily.STATE).read_text())['material_health']['status'], 'blocked')

    def test_pending_native_dry_run_never_consumes_source_or_updates_receipt(self):
        self.native_capture()
        before = self.files()
        with patch.object(sys, 'argv', ['elc_daily.py', '--dry-run']), \
             patch.object(daily.native_material_intake, 'recover', side_effect=AssertionError('preview only')), \
             patch.object(daily.cb, 'is_running', side_effect=AssertionError('no browser')):
            self.assertEqual(daily.main(), 0)
        self.assertEqual(self.files(), before)

    def test_known_wrong_source_bytes_stay_blocked_but_fresh_bytes_can_extract(self):
        raw = self.put('BUSN3040/raw/source.pdf', 'wrong source bytes')
        digest = daily.material_delivery.sha256_file(raw)
        record = {'course': 'BUSN3040', 'topic_id': '1', 'raw_path': str(raw),
                  'source_sha256': digest, 'title': 'Course source', 'unit': ''}
        self.put('.fetched.json', json.dumps({'1': {'course': 'BUSN3040',
                  'source_quarantine': {'raw_sha256': digest}}}))
        with patch.object(daily, 'write_text', side_effect=AssertionError('known wrong source must not extract')):
            self.assertEqual(daily.extract_material(record), {'ok': False, 'reason': 'source_content_mismatch'})
        raw.write_text('fresh original source')
        record['source_sha256'] = daily.material_delivery.sha256_file(raw)
        text = self.put('BUSN3040/text/source.txt', 'fresh extraction')
        with patch.object(daily, 'write_text', return_value=(str(text), None)):
            self.assertTrue(daily.extract_material(record)['ok'])

    def test_source_quarantine_cannot_cross_course_identity(self):
        raw = self.put('BUSN3040/raw/source.pdf', 'valid source bytes')
        digest = daily.material_delivery.sha256_file(raw)
        self.put('.fetched.json', json.dumps({'1': {'course': 'MGMT4280',
                  'source_quarantine': {'raw_sha256': digest}}}))
        text = self.put('BUSN3040/text/source.txt', 'valid extraction')
        record = {'course': 'BUSN3040', 'topic_id': '1', 'raw_path': str(raw),
                  'source_sha256': digest, 'title': 'Course source', 'unit': ''}
        with patch.object(daily, 'write_text', return_value=(str(text), None)):
            self.assertTrue(daily.extract_material(record)['ok'])

    def test_dry_run_is_completely_offline_and_does_not_build_or_write(self):
        self.pending()
        before = self.files()
        with patch.object(sys, 'argv', ['elc_daily.py', '--dry-run']), \
             patch.object(daily.cb, 'is_running', side_effect=AssertionError('no browser')), \
             patch.object(daily.bundle, 'build', side_effect=AssertionError('no rebuild')):
            self.assertEqual(daily.main(), 0)
        self.assertEqual(before, self.files())

    def test_recovery_only_never_enters_browser_or_gpt_publication(self):
        with patch.object(sys, 'argv', ['elc_daily.py', '--recovery-only', '--course', 'BUSN3040']), \
             patch.object(daily, 'recover_materials') as recover, \
             patch.object(daily.cb, 'is_running', side_effect=AssertionError('no browser')):
            self.assertEqual(daily.main(), 0)
        recover.assert_called_once_with({'BUSN3040'})
        self.assertIn('material_health', json.loads(Path(daily.STATE).read_text()))

    def test_cooldown_never_skips_local_stage_recovery(self):
        self.put('.daily-state.json', json.dumps({'last_success_epoch': time.time()}))
        with patch.object(sys, 'argv', ['elc_daily.py']), patch.object(daily, 'recover_materials') as recover, \
             patch.object(daily.elc_announcements, 'due', return_value=False), \
             patch.object(daily.elc_submission, 'due', return_value=False), \
             patch.object(daily.elc_announcements, 'publish_pending'), \
             patch.object(daily.cb, 'is_running', side_effect=AssertionError('no browser needed')):
            self.assertEqual(daily.main(), 0)
        recover.assert_called_once()

    def test_missing_queued_text_is_retained(self):
        path = self.pending(); path.unlink()
        _, pending, errors = daily.flush_upload_queue()
        self.assertEqual(len(pending), 1)
        self.assertTrue(errors)
        self.assertEqual(len(daily.load_pending()['files']), 1)

    def test_more_than_five_gpt_failures_still_retry_with_backoff(self):
        self.pending()
        q = daily.load_pending(); q['files'][0]['attempts'] = 8
        daily.save_json(daily.PENDING, q)
        with patch.object(daily.gpt_upload, 'upload_many', return_value=[{'course': 'BUSN3040', 'ok': False, 'error': 'private secret'}]) as upload:
            _, pending, errors = daily.flush_upload_queue()
        upload.assert_called_once()
        self.assertEqual(pending[0]['attempts'], 9)
        self.assertGreater(pending[0]['next_attempt'], time.time())
        self.assertNotIn('secret', Path(daily.PENDING).read_text())

    def test_new_text_revision_clears_old_retry_backoff(self):
        path = self.pending()
        q = daily.load_pending(); q['files'][0].update(attempts=8, next_attempt=time.time()+9999)
        daily.save_json(daily.PENDING, q)
        path.write_text('FAKE corrected source')
        daily.queue_upload('BUSN3040', str(path), 'Fake source', 'v2')
        entry = daily.load_pending()['files'][0]
        self.assertEqual((entry['attempts'], entry['next_attempt'], entry['revision_id']), (0, 0, 'v2'))

    def test_success_records_prepublication_digest_and_clears_only_selected_entries(self):
        self.pending(); other = self.pending(course='MGMT4280')
        with patch.object(daily.gpt_upload, 'upload_many', return_value=[{'course': 'BUSN3040', 'ok': True}]):
            _, remaining, errors = daily.flush_upload_queue(only_courses={'BUSN3040'})
        self.assertFalse(errors)
        self.assertEqual([e['text'] for e in remaining], [str(other)])
        receipt = json.loads((self.root / '.bundle-publication.json').read_text())['BUSN3040']
        self.assertEqual(receipt['status'], 'publication_confirmed')
        self.assertEqual(receipt['retrieval'], 'not_tested')

    def test_changed_text_during_upload_is_not_acknowledged_or_lost(self):
        path = self.pending()
        def publish(*args, **kwargs):
            path.write_text('FAKE second version')
            daily.queue_upload('BUSN3040', str(path), 'Changed source', 'v2')
            return [{'course': 'BUSN3040', 'ok': True}]
        with patch.object(daily.gpt_upload, 'upload_many', side_effect=publish):
            _, remaining, errors = daily.flush_upload_queue()
        self.assertTrue(errors)
        self.assertEqual(remaining[0]['revision_id'], 'v2')
        self.assertEqual(remaining[0]['attempts'], 0)
        self.assertFalse((self.root / '.bundle-publication.json').exists())

    def test_corrupt_pending_file_is_not_reset(self):
        path = self.put('.pending-upload.json', '{not json')
        before = path.read_bytes()
        with self.assertRaises(ValueError): daily.queue_upload('BUSN3040', 'irrelevant', 'Fake')
        self.assertEqual(path.read_bytes(), before)

    def test_same_title_topics_have_distinct_extractions(self):
        raw = self.put('BUSN3040/raw/source.txt', 'FAKE body')
        with patch.object(daily, 'extract', return_value=('FAKE body', None)):
            one, _ = daily.write_text('BUSN3040', str(raw), 'Repeated lesson', 'Fake module', '1')
            two, _ = daily.write_text('BUSN3040', str(raw), 'Repeated lesson', 'Fake module', '2')
        self.assertNotEqual(one, two)
        self.assertIn('Source topic ID: 1', Path(one).read_text())
        self.assertIn('Source topic ID: 2', Path(two).read_text())

    def test_renamed_topic_archives_exact_legacy_text_and_retires_only_its_queue(self):
        prior = self.pending(name='BUSN3040_Old_title.txt')
        other = self.pending(name='independent.txt')
        raw = self.put('BUSN3040/raw/new.txt', 'FAKE new body')
        record = {'course': 'BUSN3040', 'topic_id': '1', 'title': 'New title', 'unit': 'Fake module',
                  'raw_path': str(raw), 'previous_text_path': str(prior)}
        with patch.object(daily, 'extract', return_value=('FAKE revised source', None)):
            result = daily.extract_material(record)
        self.assertTrue(result['ok'])
        self.assertFalse(prior.exists())
        self.assertTrue(list((self.root / 'BUSN3040/superseded-text').glob('*.txt')))
        self.assertEqual([e['text'] for e in daily.load_pending()['files']], [str(other)])

    def test_known_busn_templates_do_not_enter_teaching_queue(self):
        raw = self.root / 'BUSN3040/raw/template.zip'; raw.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(raw, 'w') as archive: archive.writestr('template.html', 'FAKE template')
        record = {'course': 'BUSN3040', 'topic_id': '62542780', 'title': 'Syllabus',
                  'unit': 'Welcome', 'raw_path': str(raw)}
        with patch.object(daily, 'extract', return_value=('Dr. Insert Name lorem ipsum Example Textbook Here', None)), \
             patch.object(daily, 'maybe_transcribe') as transcribe:
            result = daily.extract_material(record)
        self.assertFalse(result['ok'])
        self.assertEqual(result['reason'], 'source_template')
        transcribe.assert_not_called()
        self.assertFalse((self.root / 'BUSN3040/text').exists())

    def test_existing_download_completion_cannot_be_assigned_to_next_topic(self):
        self.put('downloads/prior.pdf.crdownload', 'FAKE partial')
        names = daily.snapshot_downloads()
        self.assertIn('prior.pdf', names)
        self.assertIn('prior.pdf.crdownload', names)

    def simulated_source_run(self, items, downloaded):
        """Replace every remote surface; main's state/download plumbing is real."""
        self.stack.enter_context(patch.object(sys, 'argv', ['elc_daily.py', '--force']))
        self.stack.enter_context(patch.object(daily.elc_announcements, 'due', return_value=False))
        self.stack.enter_context(patch.object(daily.elc_submission, 'due', return_value=False))
        self.stack.enter_context(patch.object(daily.elc_announcements, 'read_rss_courses', return_value={}))
        self.stack.enter_context(patch.object(daily.elc_announcements, 'publish_pending'))
        self.stack.enter_context(patch.object(daily.elc_announcements, 'collect'))
        self.stack.enter_context(patch.object(daily.elc_submission, 'collect'))
        self.stack.enter_context(patch.object(daily.cb, 'is_running', return_value=True))
        self.stack.enter_context(patch.object(daily.cb, 'find_tab', return_value=(1, 1)))
        self.stack.enter_context(patch.object(daily, 'js_json', return_value={'ok': True}))
        discovery = Mock(return_value={'BUSN3040': 123}); discovery.current_term = '20272'
        self.stack.enter_context(patch.object(daily, 'discover_courses', discovery))
        self.stack.enter_context(patch.object(daily, 'sweep', return_value={'BUSN3040': items}))
        self.stack.enter_context(patch.object(daily, 'recover_materials', return_value={'pending': 0}))
        trigger = self.stack.enter_context(patch.object(daily, 'trigger_download'))
        self.stack.enter_context(patch.object(daily, 'settle_new_file', side_effect=downloaded))
        self.stack.enter_context(patch.object(daily.time, 'sleep'))
        self.stack.enter_context(patch.object(daily, 'notify'))
        self.stack.enter_context(patch.object(daily, 'post_bridge_note'))
        return trigger

    def source_only_run(self, items, payload=b"FAKE original source"):
        self.simulated_source_run(items, [])
        self.stack.enter_context(patch.object(sys, 'argv', ['elc_daily.py', '--source-only', '--force']))
        def capture(win, tab, org, item, directory, **kwargs):
            path = Path(directory) / ('source.' + item['ext'])
            path.write_bytes(payload)
            return str(path), {'transport': 'same_origin_exact_file', 'topic': str(item['id']),
                               'sha256': daily.material_delivery.sha256_file(path)}
        capture_mock = self.stack.enter_context(patch.object(daily.direct_material_capture, 'capture', side_effect=capture))
        # A BaseException survives adapter exception handling, so a forbidden
        # call cannot be converted into an ordinary pending result by this test.
        class ForbiddenEffect(BaseException): pass
        self.forbidden = []
        for obj, names in ((daily, ['recover_materials', 'clear_confirmed_capture', 'snapshot_downloads',
                                   'trigger_download', 'settle_new_file', 'file_material_drive',
                                   'flush_upload_queue', 'post_bridge_note', 'notify']),
                           (daily.native_material_intake, ['recover']),
                           (daily.material_bridge, ['publish', 'readback']),
                           (daily.elc_announcements, ['read_rss_courses', 'publish_pending', 'collect', 'blocked']),
                           (daily.elc_submission, ['collect', 'blocked']),
                           (daily.gpt_upload, ['upload_many'])):
            for name in names:
                self.forbidden.append(self.stack.enter_context(patch.object(obj, name, side_effect=ForbiddenEffect(name))))
        return capture_mock

    @staticmethod
    def direct_item(identity=1, **kwargs):
        return dict({'id': identity, 'title': f'Fake {identity}', 'unit': 'Week 1',
                     'type': 'File', 'ext': 'txt',
                     'url_path': f'/content/enforced4/123-test.20272/source{identity}.txt'}, **kwargs)

    def test_source_only_captures_locally_preserves_hold_and_defers_destinations(self):
        hold = {'course': 'LAND2510E', 'topic_id': '99', 'capture_id': 'old-unconfirmed',
                'reason': 'download_or_capture_unconfirmed'}
        self.put('.daily-state.json', json.dumps({'material_capture_hold': hold,
                    'last_success_epoch': 1234, 'last_success': 'old full run'}))
        self.pending(course='MGMT4280', name='other.txt')
        before = daily.load_pending()['files'][0]
        capture = self.source_only_run([self.direct_item()])
        self.assertEqual(daily.main(), 0)
        capture.assert_called_once()
        for forbidden in self.forbidden: forbidden.assert_not_called()
        state = daily.load_json(daily.STATE, {})
        self.assertEqual(state['material_capture_hold'], hold)
        self.assertEqual(state['last_success_epoch'], 1234)
        self.assertEqual(state['last_success'], 'old full run')
        self.assertEqual(state['source_only_material_check']['captured'], 1)
        self.assertEqual(state['source_only_material_check']['publication'], 'not_attempted')
        self.assertEqual(state['material_health']['status'], 'blocked')
        row = daily.delivery_queue().entries(read_only=True)['BUSN3040:1']
        self.assertEqual(row['status'], 'pending')
        self.assertEqual(row['stages']['extraction']['status'], 'done')
        self.assertEqual(row['stages']['gpt_queue']['status'], 'done')
        for name in ('drive', 'library'):
            self.assertEqual(row['stages'][name]['status'], 'pending')
            self.assertEqual(row['stages'][name]['attempts'], 0)
        self.assertEqual(daily.load_pending()['files'][0], before)
        self.assertEqual(Path(row['raw_path']).read_bytes(), b'FAKE original source')
        self.assertEqual(daily.load_json(daily.FETCHED, {})['1']['direct_source_receipt']['topic'], '1')
        self.assertFalse((self.root / 'reports/latest.md').exists())

    def test_source_only_stash_never_hashes_different_size_material(self):
        video = self.put('BUSN3040/raw/old-video.mp4', 'FAKE unrelated video bytes' * 100)
        capture = self.source_only_run([self.direct_item()])
        real_md5 = daily.md5
        def bounded_md5(path):
            self.assertNotEqual(Path(path), video, 'different-sized source must stay unread')
            return real_md5(path)
        with patch.object(daily, 'md5', side_effect=bounded_md5):
            self.assertEqual(daily.main(), 0)
        capture.assert_called_once()
        self.assertEqual(video.read_text(), 'FAKE unrelated video bytes' * 100)
        self.assertEqual(daily.load_json(daily.STATE, {})['source_only_material_check']['captured'], 1)
        for forbidden in self.forbidden: forbidden.assert_not_called()

    def test_source_only_never_uses_native_fallback_and_keeps_receipt_pending(self):
        self.native_capture(topic='90')
        receipt = (self.root / '.pending-native-materials.json').read_bytes()
        items = [self.direct_item(), self.direct_item(2, ext='mp4', url_path='/content/enforced/123/lecture.mp4')]
        capture = self.source_only_run(items)
        self.assertEqual(daily.main(), 0)
        capture.assert_called_once()
        self.assertEqual((self.root / '.pending-native-materials.json').read_bytes(), receipt)
        state = daily.load_json(daily.STATE, {})
        self.assertEqual(state['source_only_material_check']['deferred'], 1)
        self.assertEqual(state['source_only_material_check']['status'], 'partial')
        self.assertNotIn('2', daily.load_json(daily.FETCHED, {}))
        for forbidden in self.forbidden: forbidden.assert_not_called()

    def test_source_only_failed_exact_capture_never_advances_old_byte_receipt(self):
        item = self.direct_item()
        raw = self.put('BUSN3040/raw/old.txt', 'FAKE old')
        old = daily.material_revisions.record_success(None, item, 'BUSN3040', 123, '20272',
            daily.material_revisions.content_digest(raw), raw.stat().st_size, raw.name, now=1)
        daily.save_json(daily.FETCHED, {'1': old})
        capture = self.source_only_run([item]); capture.side_effect = ValueError('source unavailable')
        self.assertEqual(daily.main(), 1)
        row = daily.load_json(daily.FETCHED, {})['1']
        self.assertEqual(row['revisions']['checked_at_epoch'], old['revisions']['checked_at_epoch'])
        self.assertEqual(row['revisions']['sha256'], old['revisions']['sha256'])
        state = daily.load_json(daily.STATE, {})
        self.assertEqual(state['source_only_material_check']['failed'], 1)
        self.assertNotIn('material_capture_hold', state)
        self.assertNotIn('last_success_epoch', state)

    def test_source_only_keeps_specific_safe_failure_and_native_hold(self):
        hold = {'capture_id': 'old-video', 'reason': 'download_or_capture_unconfirmed'}
        daily.save_json(daily.STATE, {'material_capture_hold': hold})
        capture = self.source_only_run([self.direct_item()])
        capture.side_effect = ValueError('source_too_large')
        self.assertEqual(daily.main(), 1)
        row = daily.load_json(daily.FETCHED, {})['1']
        self.assertEqual(row['revisions']['last_error'], 'source_too_large')
        self.assertNotIn('sha256', row['revisions'])
        self.assertEqual(daily.load_json(daily.STATE, {})['material_capture_hold'], hold)
        for forbidden in self.forbidden: forbidden.assert_not_called()

    def test_source_only_sanitizes_arbitrary_failure_text(self):
        capture = self.source_only_run([self.direct_item()])
        capture.side_effect = ValueError('source_too_large private source body')
        self.assertEqual(daily.main(), 1)
        row = daily.load_json(daily.FETCHED, {})['1']
        self.assertEqual(row['revisions']['last_error'], 'direct_source_unconfirmed')
        for forbidden in self.forbidden: forbidden.assert_not_called()

    def test_source_only_rechecks_unchanged_metadata_using_fresh_bytes(self):
        item = self.direct_item()
        raw = self.put('BUSN3040/raw/old.txt', 'FAKE old')
        old = daily.material_revisions.record_success(None, item, 'BUSN3040', 123, '20272',
            daily.material_revisions.content_digest(raw), raw.stat().st_size, raw.name, now=1)
        daily.save_json(daily.FETCHED, {'1': old})
        self.source_only_run([item], payload=b'FAKE updated exact source')
        self.assertEqual(daily.main(), 0)
        row = daily.load_json(daily.FETCHED, {})['1']
        self.assertNotEqual(row['revisions']['sha256'], old['revisions']['sha256'])
        self.assertEqual(row['revisions']['generation'], 2)
        self.assertEqual(raw.read_text(), 'FAKE old')

    def test_source_only_has_count_budget_and_repeated_runs_drain_new_sources(self):
        capture = self.source_only_run([self.direct_item(i) for i in range(1, 29)])
        self.assertEqual(daily.main(), 0)
        self.assertEqual(capture.call_count, daily.MAX_DOWNLOADS_PER_RUN)
        self.assertEqual(daily.load_json(daily.STATE, {})['source_only_material_check']['deferred'], 3)
        capture.reset_mock()
        self.assertEqual(daily.main(), 0)
        self.assertEqual(capture.call_count, 3)
        self.assertEqual(len(daily.load_json(daily.FETCHED, {})), 28)
        self.assertTrue(all(row['status'] == 'pending' for row in daily.delivery_queue().entries(read_only=True).values()))

    def test_source_only_dry_run_is_read_only_without_browser_or_lock(self):
        self.pending(); before = self.files()
        with patch.object(sys, 'argv', ['elc_daily.py', '--source-only', '--dry-run']), \
             patch.object(daily.cb, 'is_running', side_effect=AssertionError('no browser')), \
             patch.object(daily, 'recover_local_materials', side_effect=AssertionError('no writes')):
            self.assertEqual(daily.main(), 0)
        self.assertEqual(self.files(), before)

    def test_source_only_success_still_cannot_mark_full_routine_healthy(self):
        self.source_only_run([])
        self.assertEqual(daily.main(), 0)
        state = daily.load_json(daily.STATE, {})
        self.assertEqual(state['source_only_material_check']['status'], 'captured')
        self.assertEqual(state['material_health']['status'], 'pending')
        self.assertNotIn('last_success_epoch', state)

    def test_source_only_recovery_preserves_prior_source_observation(self):
        receipt = {'checked_at': 'prior observation', 'status': 'partial', 'publication': 'not_attempted'}
        self.put('.daily-state.json', json.dumps({'source_only_material_check': receipt}))
        self.source_only_run([])
        with patch.object(sys, 'argv', ['elc_daily.py', '--source-only', '--recovery-only']), \
             patch.object(daily.cb, 'is_running', side_effect=AssertionError('no browser')):
            self.assertEqual(daily.main(), 0)
        self.assertEqual(daily.load_json(daily.STATE, {})['source_only_material_check'], receipt)
        for forbidden in self.forbidden: forbidden.assert_not_called()

    def test_source_only_browser_failure_never_contacts_reconciliation(self):
        self.source_only_run([])
        with patch.object(daily.cb, 'is_running', side_effect=daily.cb.ChromeError('Neo unavailable')):
            self.assertEqual(daily.main(), 0)
        state = daily.load_json(daily.STATE, {})
        self.assertEqual(state['source_only_material_check']['status'], 'not_completed')
        self.assertNotIn('last_success_epoch', state)
        for forbidden in self.forbidden: forbidden.assert_not_called()

    def test_source_only_rejects_upload_combination_before_any_state_change(self):
        before = self.files()
        with patch.object(sys, 'argv', ['elc_daily.py', '--source-only', '--upload-only']):
            self.assertEqual(daily.main(), 2)
        self.assertEqual(self.files(), before)

    def test_source_only_respects_existing_collector_lock(self):
        import fcntl
        capture = self.source_only_run([self.direct_item()])
        with (self.root / '.material-run.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            before = self.files()
            self.assertEqual(daily.main(), 0)
            self.assertEqual(self.files(), before)
        capture.assert_not_called()

    def test_same_id_revision_is_enqueued_before_fetched_success_is_saved(self):
        item = {'id': 1, 'title': 'Lesson', 'unit': 'Week 1', 'type': 'File', 'ext': 'txt'}
        old = self.put('BUSN3040/raw/old.txt', 'FAKE old')
        previous = daily.material_revisions.record_success(None, item, 'BUSN3040', 123, '20272',
            daily.material_revisions.content_digest(old), old.stat().st_size, old.name, now=1)
        daily.save_json(daily.FETCHED, {'1': previous})
        incoming = self.put('downloads/new.txt', 'FAKE corrected')
        new_digest = daily.material_revisions.content_digest(incoming)
        self.simulated_source_run([item], [str(incoming)])
        original_save = daily.save_json
        def save(path, value):
            if path == daily.FETCHED and value.get('1', {}).get('revisions', {}).get('sha256') == new_digest:
                entry = daily.delivery_queue().entries(read_only=True)['BUSN3040:1']
                self.assertEqual(entry['source_sha256'], new_digest)
            return original_save(path, value)
        with patch.object(daily, 'save_json', side_effect=save):
            self.assertEqual(daily.main(), 0)
        actual = json.loads(Path(daily.FETCHED).read_text())['1']
        self.assertEqual(actual['revisions']['sha256'], new_digest)
        self.assertEqual(daily.delivery_queue().entries(read_only=True)['BUSN3040:1']['status'], 'pending')

    def test_timed_out_source_never_reuses_delayed_bytes_for_next_topic(self):
        items = [{'id': n, 'title': f'Fake {n}', 'unit': 'Week 1', 'type': 'File', 'ext': 'pdf'} for n in (1, 2)]
        trigger = self.simulated_source_run(items, [None])
        self.assertEqual(daily.main(), 0)
        trigger.assert_called_once()
        fetched = json.loads(Path(daily.FETCHED).read_text())
        self.assertNotIn('sha256', fetched['1']['revisions'])
        self.assertNotIn('2', fetched)
        self.assertEqual(json.loads(Path(daily.STATE).read_text())['material_revision_deferred'], 1)

    def test_unconfirmed_download_hold_survives_next_forced_run(self):
        item = {'id': 1, 'title': 'Fake', 'unit': 'Week 1', 'type': 'File', 'ext': 'pdf'}
        trigger = self.simulated_source_run([item], [None])
        self.assertEqual(daily.main(), 0)
        self.assertTrue(json.loads(Path(daily.STATE).read_text())['material_capture_hold'])
        trigger.reset_mock()
        self.assertEqual(daily.main(), 0)
        trigger.assert_not_called()
        state = json.loads(Path(daily.STATE).read_text())
        self.assertEqual(state['material_health']['reason'], 'download_capture_unconfirmed')

    def test_crash_after_click_leaves_preexisting_capture_intent(self):
        class Crash(BaseException): pass
        item = {'id': 1, 'title': 'Fake', 'unit': 'Week 1', 'type': 'File', 'ext': 'pdf'}
        trigger = self.simulated_source_run([item], [])
        trigger.side_effect = Crash()
        with self.assertRaises(Crash): daily.main()
        hold = json.loads(Path(daily.STATE).read_text())['material_capture_hold']
        self.assertEqual((hold['course'], hold['topic_id']), ('BUSN3040', '1'))

    def test_capture_latch_only_reconciles_matching_durable_source_proof(self):
        raw = self.put('BUSN3040/raw/source.txt', 'FAKE source')
        item = {'id': 1, 'title': 'Fake', 'unit': 'Week 1', 'type': 'File', 'ext': 'txt'}
        row = daily.material_revisions.record_success(None, item, 'BUSN3040', 123, '20272',
            daily.material_revisions.content_digest(raw), raw.stat().st_size, raw.name)
        row['capture_id'] = 'success-id'
        daily.save_json(daily.FETCHED, {'1': row})
        daily.delivery_queue().enqueue('BUSN3040', '1', str(raw), 'Fake', 'Week 1')
        daily.save_json(daily.STATE, {'material_capture_hold': {'course': 'BUSN3040', 'topic_id': '1', 'capture_id': 'other-id'}})
        self.assertFalse(daily.clear_confirmed_capture())
        daily.save_json(daily.STATE, {'material_capture_hold': {'course': 'BUSN3040', 'topic_id': '1', 'capture_id': 'success-id'}})
        secondary = {'course': 'MGMT4280', 'topic_id': '2', 'reason': 'native_completion_unconfirmed'}
        daily.save_json(daily.STATE, {'material_capture_hold': {'course': 'BUSN3040', 'topic_id': '1',
            'capture_id': 'success-id', 'additional_unconfirmed': [secondary]}})
        self.assertFalse(daily.clear_confirmed_capture())
        self.assertEqual(json.loads(Path(daily.STATE).read_text())['material_capture_hold']['additional_unconfirmed'], [secondary])
        daily.save_json(daily.STATE, {'material_capture_hold': {'course': 'BUSN3040', 'topic_id': '1', 'capture_id': 'success-id'}})
        self.assertTrue(daily.clear_confirmed_capture())
        self.assertNotIn('material_capture_hold', json.loads(Path(daily.STATE).read_text()))

    def archive_record(self, names):
        raw = self.root / 'BUSN3040/raw/lecture.zip'; raw.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(raw, 'w') as archive:
            for name, body in names: archive.writestr(name, body)
        return {'course': 'BUSN3040', 'topic_id': '1', 'title': 'Fake lecture', 'unit': 'Week 1',
                'raw_path': str(raw), 'source_sha256': daily.material_delivery.sha256_file(raw)}

    def test_single_video_archive_files_original_member_with_distinct_archive_provenance(self):
        record = self.archive_record([('nested/lecture.mp4', b'FAKE video original bytes'), ('README.txt', b'fake explanation')])
        result = daily.file_archive_video(record)
        self.assertTrue(result['ok'])
        self.assertEqual(result['archive_member'], 'nested/lecture.mp4')
        self.assertEqual(result['drive_representation'], 'archive_video')
        self.assertEqual(result['source_sha256'], record['source_sha256'])
        self.assertNotEqual(result['source_sha256'], result['drive_sha256'])
        filed = Path(daily.drive_sync.DRIVE) / result['drive_rel']
        self.assertEqual(filed.read_bytes(), b'FAKE video original bytes')
        self.assertEqual(daily.material_delivery.sha256_file(filed), result['drive_sha256'])

    def test_multivideo_or_unsafe_zip_never_files_a_guessed_lecture(self):
        for names, reason in [([('one.mp4', b'one'), ('two.mp4', b'two')], 'multiple_video_members'),
                              ([('../outside.mp4', b'bad')], 'unsafe_archive')]:
            with self.subTest(reason=reason):
                result = daily.file_archive_video(self.archive_record(names))
                self.assertEqual(result, {'ok': False, 'reason': reason})
        self.assertFalse(Path(daily.drive_sync.DRIVE).exists())

    def test_multi_video_or_unsafe_archive_never_starts_transcription_or_extracts_readme(self):
        cases = [([('one.mp4', b'one'), ('two.mp4', b'two')], 'multiple_video_members'),
                 ([('../outside.mp4', b'bad')], 'unsafe_archive')]
        for names, reason in cases:
            record = self.archive_record(names + [('README.txt', b'FAKE readable but incomplete')])
            with self.subTest(reason=reason), patch.object(daily, 'write_text') as extract, \
                 patch.object(daily, 'maybe_transcribe') as transcribe:
                self.assertEqual(daily.extract_material(record), {'ok': False, 'reason': reason})
            extract.assert_not_called(); transcribe.assert_not_called()

    def test_single_mkv_and_readme_use_verified_lecture_transcript(self):
        record = self.archive_record([('one.mkv', b'FAKE video'), ('README.txt', b'FAKE readme')])
        legacy = self.put('BUSN3040/text/BUSN3040_Fake_lecture_transcript.txt', '# Fake lecture\nFAKE transcript content')
        with patch.object(daily, 'write_text') as extract, \
             patch.object(daily, 'maybe_transcribe', return_value=(str(legacy), None)) as transcribe:
            result = daily.extract_material(record)
        extract.assert_not_called(); transcribe.assert_called_once()
        self.assertTrue(result['ok'])
        self.assertIn('Source topic ID: 1', Path(result['text_path']).read_text())
        self.assertIn('FAKE transcript content', Path(result['text_path']).read_text())

    def test_stable_transcript_update_archives_prior_complete_bytes(self):
        stable = self.put('BUSN3040/text/BUSN3040_ELC_1_transcript.txt', 'FAKE previous complete transcript')
        daily.write_stable_transcript(stable, 'FAKE replacement complete transcript', 'BUSN3040')
        self.assertEqual(stable.read_text(), 'FAKE replacement complete transcript')
        versions = list((self.root / 'BUSN3040/superseded-text').glob('*.txt'))
        self.assertEqual([p.read_text() for p in versions], ['FAKE previous complete transcript'])

    def test_failed_stable_transcript_replace_leaves_prior_whole_file(self):
        stable = self.put('BUSN3040/text/BUSN3040_ELC_1_transcript.txt', 'FAKE previous complete transcript')
        with patch.object(daily.os, 'replace', side_effect=OSError('simulated interruption')):
            with self.assertRaises(OSError):
                daily.write_stable_transcript(stable, 'FAKE replacement complete transcript', 'BUSN3040')
        self.assertEqual(stable.read_text(), 'FAKE previous complete transcript')
        self.assertEqual(list(stable.parent.glob('.transcript-*')), [])

    def test_transcript_quality_reason_survives_extraction_failure(self):
        raw = self.put('BUSN3040/raw/lecture.mp3', 'FAKE audio')
        record = {'course': 'BUSN3040', 'topic_id': '1', 'title': 'Lecture',
                  'unit': 'Fake module', 'raw_path': str(raw)}
        with patch.object(daily, 'write_text', return_value=(None, None)), \
             patch.object(daily, 'maybe_transcribe', return_value=(None, 'transcript_silent_audio')):
            self.assertEqual(daily.extract_material(record), {'ok': False, 'reason': 'transcript_silent_audio'})

    def test_repetitive_generated_transcript_is_quarantined_before_gpt_handoff(self):
        record = self.archive_record([('one.mp4', b'FAKE video')])
        path = self.put('BUSN3040/text/fake_transcript.txt',
            '# Fake (lecture transcript)\nMachine transcript of 5 minutes\n============\n'
            'Thank you\nThank you\nThank you\nThank you\n')
        with patch.object(daily, 'maybe_transcribe', return_value=(str(path), None)):
            result = daily.extract_material(record)
        self.assertEqual(result, {'ok': False, 'reason': 'transcript_repetitive'})
        self.assertFalse(path.exists())
        self.assertEqual(len(list((path.parent.parent / 'superseded-text').glob('*.txt'))), 1)

    def test_stored_invalid_transcript_is_reopened_without_touching_visualnotes(self):
        raw = self.put('BUSN3040/raw/lecture.mp4', 'FAKE audio')
        bad = self.put('BUSN3040/text/bad_transcript.txt',
            '# Fake (lecture transcript)\nMachine transcript of 5 minutes\n============\n'
            'Thank you\nThank you\nThank you\nThank you\n')
        visual = self.put('BUSN3040/text/visual.txt', '# Visual notes\nSilent visual tutorial')
        queue = daily.delivery_queue()
        queue.enqueue('BUSN3040', '1', raw, 'Fake lecture', text_path=bad)
        queue.enqueue('BUSN3040', '2', raw, 'Fake visual', text_path=visual)
        result = daily.check_stored_transcript_quality(queue, {'BUSN3040'})
        self.assertEqual(result['reopened'], 1)
        record = queue.entries(read_only=True)['BUSN3040:1']
        self.assertEqual(record['stages']['extraction']['reason'], 'transcript_repetitive')
        self.assertEqual(record['status'], 'pending')
        self.assertFalse(bad.exists())
        self.assertTrue(visual.exists())
        self.assertEqual(queue.entries(read_only=True)['BUSN3040:2']['stages']['extraction']['status'], 'done')


class StashTests(unittest.TestCase):
    setUp = PipelineTests.setUp
    put = PipelineTests.put

    def test_different_size_candidate_is_never_hashed(self):
        old = self.put('BUSN3040/raw/old-video.mp4', 'FAKE unrelated video bytes')
        source = self.put('capture/source.pdf', 'FAKE PDF')
        real_md5 = daily.md5
        def bounded_md5(path):
            self.assertNotEqual(Path(path), old, 'metadata mismatch must prevent content read')
            return real_md5(path)
        with patch.object(daily, 'md5', side_effect=bounded_md5) as hashed:
            dest, duplicate = daily.stash('BUSN3040', str(source), 'Fictional PDF')
        self.assertFalse(duplicate)
        self.assertEqual(hashed.call_count, 1)
        self.assertEqual(Path(dest).read_text(), 'FAKE PDF')
        self.assertEqual(old.read_text(), 'FAKE unrelated video bytes')
        self.assertFalse(source.exists())

    def test_same_size_identical_payload_reuses_existing_file(self):
        old = self.put('BUSN3040/raw/prior.pdf', 'FAKE identical payload')
        source = self.put('capture/source.pdf', 'FAKE identical payload')
        with patch.object(daily, 'md5', wraps=daily.md5) as hashed:
            dest, duplicate = daily.stash('BUSN3040', str(source), 'Fictional PDF')
        self.assertTrue(duplicate)
        self.assertEqual(Path(dest), old)
        self.assertEqual(hashed.call_count, 2)
        self.assertEqual(old.read_text(), 'FAKE identical payload')
        self.assertFalse(source.exists())
        self.assertEqual(list(old.parent.iterdir()), [old])

    def test_same_size_different_payload_keeps_unique_filename(self):
        title = 'Fictional PDF'
        old = self.put(f'BUSN3040/raw/{daily.slug(title)}.pdf', 'FAKE old payload')
        source = self.put('capture/source.pdf', 'FAKE new payload')
        self.assertEqual(source.stat().st_size, old.stat().st_size)
        with patch.object(daily, 'md5', wraps=daily.md5) as hashed:
            dest, duplicate = daily.stash('BUSN3040', str(source), title)
        self.assertFalse(duplicate)
        self.assertEqual(Path(dest).name, daily.slug(title) + '_2.pdf')
        self.assertEqual(hashed.call_count, 2)
        self.assertEqual(old.read_text(), 'FAKE old payload')
        self.assertEqual(Path(dest).read_text(), 'FAKE new payload')
        self.assertFalse(source.exists())
        self.assertEqual(len(list(old.parent.iterdir())), 2)


if __name__ == '__main__': unittest.main()

class ExactCaptureIntegrationTests(unittest.TestCase):
    setUp = PipelineTests.setUp
    put = PipelineTests.put
    simulated_source_run = PipelineTests.simulated_source_run
    pending = PipelineTests.pending
    def direct_items(self):
        return [dict(id=n, title=f'Fictional {n}', unit='Synthetic', type='File', ext='txt',
                     url_path=f'/content/enforced4/123-test.20272/{n}.txt') for n in (11, 12)]

    def test_native_hold_does_not_block_exact_files_or_get_cleared(self):
        hold = {'capture_id': 'old-video', 'course': 'LAND2510E', 'topic_id': '99',
                'reason': 'download_or_capture_unconfirmed', 'additional_unconfirmed': [{'topic_id': '98'}]}
        self.put('.daily-state.json', json.dumps({'material_capture_hold': hold}))
        trigger = self.simulated_source_run(self.direct_items(), [])
        def capture(w, t, org, item, directory, **kwargs):
            path = Path(directory) / 'source.txt'; path.write_text('FICTIONAL ' + str(item['id']))
            return str(path), {'transport':'same_origin_exact_file', 'topic':str(item['id'])}
        with patch.object(daily.direct_material_capture, 'capture', side_effect=capture), \
             patch.object(daily, 'snapshot_downloads', side_effect=AssertionError('no shared Downloads')):
            self.assertEqual(daily.main(), 0)
        trigger.assert_not_called()
        state = json.loads(Path(daily.STATE).read_text())
        self.assertEqual(state['material_capture_hold'], hold)
        self.assertEqual(len(daily.delivery_queue().entries(read_only=True)), 2)
        self.assertTrue(json.loads(Path(daily.FETCHED).read_text())['11']['revisions']['sha256'])

    def test_one_failed_exact_file_does_not_stop_next_file(self):
        trigger = self.simulated_source_run(self.direct_items(), [])
        def capture(w, t, org, item, directory, **kwargs):
            if item['id'] == 11: raise ValueError('fictional failure')
            p = Path(directory) / 'source.txt'; p.write_text('FICTIONAL verified source')
            return str(p), {'transport':'same_origin_exact_file'}
        with patch.object(daily.direct_material_capture, 'capture', side_effect=capture):
            self.assertEqual(daily.main(), 0)
        trigger.assert_not_called()
        fetched = json.loads(Path(daily.FETCHED).read_text())
        self.assertNotIn('sha256', fetched['11']['revisions'])
        self.assertTrue(fetched['12']['revisions']['sha256'])
        self.assertNotIn('material_capture_hold', json.loads(Path(daily.STATE).read_text()))

    def test_material_only_never_reconciles_progress_or_uploads_gpts(self):
        self.pending()
        self.simulated_source_run([], [])
        with patch.object(sys, 'argv', ['elc_daily.py', '--force', '--materials-only']), \
             patch.object(daily.elc_announcements, 'publish_pending') as publish, \
             patch.object(daily.elc_announcements, 'collect') as news, \
             patch.object(daily.elc_submission, 'collect') as submissions, \
             patch.object(daily, 'flush_upload_queue', side_effect=AssertionError('scheduled uploader only')):
            self.assertEqual(daily.main(), 0)
        publish.assert_not_called(); news.assert_not_called(); submissions.assert_not_called()

    def test_scoped_check_does_not_delay_other_courses(self):
        self.put('.daily-state.json', json.dumps({'last_success_epoch': 1, 'last_success': 'old'}))
        self.simulated_source_run([], [])
        with patch.object(sys, 'argv', ['elc_daily.py', '--materials-only', '--course', 'BUSN3040']):
            self.assertEqual(daily.main(), 0)
        state = json.loads(Path(daily.STATE).read_text())
        self.assertEqual(state['last_success_epoch'], 1)
        self.assertEqual(state['last_success'], 'old')
        self.assertIn('BUSN3040', state['scoped_material_checks'])
