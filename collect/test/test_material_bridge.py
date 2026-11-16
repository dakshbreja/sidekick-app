"""Collector transport tests: fixture bytes and mocked HTTP only."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.error
import urllib.parse

source = Path(__file__).resolve().parents[1] / 'bin/material_bridge.py'
spec = importlib.util.spec_from_file_location('material_bridge', source)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'fixture.txt'
        self.path.write_bytes(b'FAKE extracted\r\ncourse content\r\n')
        self.sha = hashlib.sha256(self.path.read_bytes()).hexdigest()
        self.raw_sha = hashlib.sha256(b'FAKE original').hexdigest()
        self.record = {'course': 'BUSN3040', 'drive_rel': 'BUSN 3040E/01 - Syllabus & Course Info/Fake lesson.pdf',
                       'title': 'Fake lesson', 'text_path': str(self.path),
                       'text_sha256': self.sha, 'source_sha256': self.raw_sha}
        self.filename = Path(self.record['drive_rel']).name
        self.folder = str(Path(self.record['drive_rel']).parent)
        self.document = {'doc_id': 'fake-doc', 'title': self.filename, 'folder': self.folder}
        self.receipt = {'ok': True, 'stored': self.filename, 'course': 'BUSN3040',
                        'text_sha256': self.sha, 'truncated': False}
        self.listing = {'course': 'BUSN3040', 'documents': [self.document]}
        self.doc = {'document': self.document, 'source': 'sweep_extraction',
                    'text': 'FAKE excerpt', 'text_sha256': self.sha, 'truncated': False}
        # A missing mock is a test failure, never an accidental production call.
        block = patch.object(bridge.urllib.request, 'urlopen', side_effect=AssertionError('unexpected network'))
        block.start()
        self.addCleanup(block.stop)

    def readback(self, receipt=None, listing=None, doc=None):
        with patch.object(bridge, 'request', side_effect=[self.receipt if receipt is None else receipt,
                                                       self.listing if listing is None else listing,
                                                       self.doc if doc is None else doc]) as request:
            result = bridge.readback(self.record)
            return result, request

    def test_topic_readback_reassembles_exact_pages_with_utf16_offsets(self):
        text = "abc😀def"
        self.path.write_text(text)
        self.sha = hashlib.sha256(text.encode()).hexdigest()
        self.record.update(topic_id="123", text_sha256=self.sha)
        receipt = {**self.receipt, 'text_sha256': self.sha}
        pages = [{**self.doc, 'text': 'abc😀', 'text_sha256': self.sha,
                  'offset': 0, 'next_offset': 5, 'total_chars': 8, 'truncated': True},
                 {**self.doc, 'text': 'def', 'text_sha256': self.sha,
                  'offset': 5, 'next_offset': None, 'total_chars': 8, 'truncated': False}]
        with patch.object(bridge, 'request', side_effect=[receipt, self.listing, *pages]) as request:
            self.assertTrue(bridge.readback(self.record)['ok'])
            self.assertIn('text_sha256='+self.sha, request.call_args_list[0].args[0])
            self.assertIn('offset=5', request.call_args_list[-1].args[0])
        for change in ({'text':'wrong'}, {'offset':4}, {'total_chars':9}, {'next_offset':6}):
            with patch.object(bridge, 'request', side_effect=[receipt, self.listing, pages[0], {**pages[1], **change}]):
                self.assertFalse(bridge.readback(self.record)['ok'])

    def test_matching_source_receipt_drive_identity_and_readable_extraction(self):
        result, request = self.readback()
        self.assertEqual(result, {'ok': True, 'text_sha256': self.sha})
        self.assertEqual(request.call_count, 3)
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(request.call_args_list[0].args[0]).query)
        self.assertEqual(query['filename'], [self.filename])
        self.assertEqual(query['course'], ['BUSN3040'])

    def test_receipt_missing_or_content_mismatch_permits_bounded_publish(self):
        for answer, reason in [({'ok': False, 'reason': 'not_found'}, 'not_found'),
                               ({**self.receipt, 'text_sha256': '0' * 64}, 'hash_mismatch'),
                               ({**self.receipt, 'truncated': True}, 'hash_mismatch')]:
            with self.subTest(reason=reason):
                result, request = self.readback(receipt=answer)
                self.assertEqual(result, {'ok': False, 'reason': reason})
                self.assertEqual(request.call_count, 1)

    def test_receipt_identity_mismatch_never_authorizes_publish(self):
        for changes in ({'course': 'MGMT4280'}, {'stored': 'Other.pdf'}):
            result, request = self.readback(receipt={**self.receipt, **changes})
            self.assertEqual(result['reason'], 'receipt_identity_pending')
            self.assertEqual(request.call_count, 1)

    def test_provider_error_is_sanitized_and_not_mistaken_for_missing(self):
        result, request = self.readback(receipt={'ok': False, 'reason': 'token=private secret'})
        self.assertEqual(result['reason'], 'readback_unconfirmed')
        self.assertNotIn('secret', str(result))
        self.assertEqual(request.call_count, 1)

    def test_listing_requires_exact_course_folder_name_unique_id(self):
        malformed = [
            {'course': 'MGMT4280', 'documents': [self.document]},
            {'course': 'BUSN3040', 'documents': None},
            {'course': 'BUSN3040', 'documents': [self.document, self.document]},
            {'course': 'BUSN3040', 'documents': [{**self.document, 'folder': 'BUSN 5000'}]},
            {'course': 'BUSN3040', 'documents': [{**self.document, 'title': 'Other.pdf'}]},
            {'course': 'BUSN3040', 'documents': [{**self.document, 'doc_id': None}]},
            {'course': 'BUSN3040', 'documents': [None]},
        ]
        for listing in malformed:
            with self.subTest(listing=listing):
                result, request = self.readback(listing=listing)
                self.assertEqual(result['reason'], 'drive_identity_pending')
                self.assertEqual(request.call_count, 2)

    def test_document_reader_must_return_same_source_identity(self):
        for changes in ({'doc_id': 'wrong'}, {'title': 'Wrong.pdf'}, {'folder': 'Wrong course'}, {'doc_id': None}):
            result, _ = self.readback(doc={**self.doc, 'document': {**self.document, **changes}})
            self.assertEqual(result['reason'], 'document_identity_pending')

    def test_full_stored_digest_can_prove_large_text_with_bounded_excerpt(self):
        result, _ = self.readback(doc={**self.doc, 'truncated': True})
        self.assertTrue(result['ok'])
        result, _ = self.readback(doc={**self.doc, 'text': None})
        self.assertEqual(result['reason'], 'document_readback_pending')
        result, _ = self.readback(doc={**self.doc, 'text_sha256': '0' * 64})
        self.assertEqual(result['reason'], 'document_readback_pending')

    def test_direct_source_requires_known_reader_complete_body_and_matching_hash(self):
        for body, sha in [(self.path.read_bytes().decode(), self.sha), ('FAKE original', self.raw_sha)]:
            for source in ('drive_export', 'drive_download'):
                result, _ = self.readback(doc={**self.doc, 'source': source, 'text': body})
                self.assertTrue(result['ok'])
        for changes in ({'source': 'invented'}, {'truncated': True}, {'truncated': None}, {'text': 'Wrong bytes'}):
            base = {**self.doc, 'source': 'drive_download', 'text': self.path.read_bytes().decode()}
            result, _ = self.readback(doc={**base, **changes})
            self.assertEqual(result['reason'], 'document_readback_pending')

    def test_archive_container_hash_cannot_verify_the_filed_video_payload(self):
        self.record['drive_representation'] = 'archive_video'
        self.record['archive_member'] = 'Lecture.mp4'
        self.record['drive_sha256'] = hashlib.sha256(b'FAKE video member').hexdigest()
        result, _ = self.readback(doc={**self.doc, 'source': 'drive_download', 'text': 'FAKE original'})
        self.assertEqual(result['reason'], 'document_readback_pending')
        result, _ = self.readback(doc={**self.doc, 'source': 'drive_download', 'text': 'FAKE video member'})
        self.assertTrue(result['ok'])
        result, _ = self.readback()
        self.assertTrue(result['ok'])  # Full extracted transcript remains a valid reader source.

    def test_publish_preserves_exact_utf8_newlines_and_requires_bound_receipt(self):
        with patch.object(bridge, 'request', return_value=self.receipt) as request:
            result = bridge.publish(self.record)
        self.assertTrue(result['ok'])
        path, payload = request.call_args.args
        self.assertEqual(path, '/library/text')
        self.assertEqual(payload['text'].encode(), self.path.read_bytes())
        self.assertEqual(payload['filename'], self.filename)
        for changes in ({'stored': 'Other.pdf'}, {'course': 'MGMT4280'}, {'truncated': True}, {'text_sha256': '0' * 64}):
            with patch.object(bridge, 'request', return_value={**self.receipt, **changes}):
                self.assertFalse(bridge.publish(self.record)['ok'])

    def test_changed_oversized_invalid_utf8_or_missing_local_text_never_posts(self):
        for content in (b'Changed', b'x' * (bridge.MAX_TEXT_BYTES + 1), b'\xff'):
            self.path.write_bytes(content)
            self.record['text_sha256'] = hashlib.sha256(content).hexdigest() if content != b'Changed' else self.sha
            with patch.object(bridge, 'request') as request:
                self.assertFalse(bridge.publish(self.record)['ok'])
                request.assert_not_called()
        self.path.unlink()
        with patch.object(bridge, 'request') as request:
            self.assertFalse(bridge.publish(self.record)['ok'])
            request.assert_not_called()

    def test_busn_alias_normalizes_to_canonical_receipt_course(self):
        self.record['course'] = 'BUSN3040E'
        result, request = self.readback()
        self.assertTrue(result['ok'])
        self.assertIn('course=BUSN3040&', request.call_args_list[0].args[0])

    def test_land_alias_keeps_original_folder_but_uses_canonical_course(self):
        self.record['course'] = 'LAND2510E'
        self.record['drive_rel'] = self.record['drive_rel'].replace('BUSN 3040E', 'LAND 2510E')
        self.document['folder'] = self.document['folder'].replace('BUSN 3040E', 'LAND 2510E')
        self.receipt['course'] = self.listing['course'] = 'LAND2510'
        result, request = self.readback()
        self.assertTrue(result['ok'])
        self.assertIn('course=LAND2510&', request.call_args_list[0].args[0])

    def test_request_bounds_response_and_rejects_non_object_shape(self):
        for body, reason in [(b'x' * (bridge.MAX_RESPONSE + 1), 'response_size'), (b'[]', 'response_shape')]:
            response = Mock()
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=False)
            response.read.return_value = body
            with patch.object(bridge, 'config', return_value=('https://fake.invalid', 'fake-key')), \
                 patch.object(bridge.urllib.request, 'urlopen', return_value=response):
                result = bridge.request('/library/text')
            self.assertEqual(result['reason'], reason)
            response.read.assert_called_once_with(bridge.MAX_RESPONSE + 1)

    def test_request_maps_http_errors_without_reading_private_response(self):
        for code, reason in ((404, 'not_found'), (401, 'http_401'), (503, 'http_503')):
            error = urllib.error.HTTPError('https://fake.invalid', code, 'private secret body', {}, io.BytesIO(b'private secret body'))
            with patch.object(bridge, 'config', return_value=('https://fake.invalid', 'fake-key')), \
                 patch.object(bridge.urllib.request, 'urlopen', side_effect=error):
                result = bridge.request('/library/text')
            self.assertEqual(result, {'ok': False, 'reason': reason})
            self.assertNotIn('secret', str(result))

    def test_configuration_failure_never_opens_network(self):
        with patch.object(bridge, 'config', side_effect=ValueError('secret')), \
             patch.object(bridge.urllib.request, 'urlopen') as request:
            self.assertEqual(bridge.request('/library/text')['reason'], 'connection_or_configuration')
            request.assert_not_called()

    def test_config_requires_https_nonempty_key_and_no_url_credentials(self):
        config_path = Path(self.temp.name) / '.env'
        for url, key in [('http://fake.invalid', 'key'), ('https://a:b@fake.invalid', 'key'),
                         ('https://fake.invalid?token=secret', 'key'), ('https://fake.invalid', '')]:
            config_path.write_text(f'WORKER_URL={url}\nAPI_KEY={key}\n')
            with patch.object(bridge, 'CONFIG', config_path):
                with self.assertRaises(ValueError):
                    bridge.config()
        config_path.write_text('WORKER_URL="https://fake.invalid/"\nAPI_KEY=fake-key\n')
        with patch.object(bridge, 'CONFIG', config_path):
            self.assertEqual(bridge.config(), ('https://fake.invalid', 'fake-key'))


if __name__ == '__main__':
    unittest.main()
