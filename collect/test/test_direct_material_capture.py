"""Synthetic exact-file transport tests; no browser or production data."""
import base64
import hashlib
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bin'))
import direct_material_capture as direct


class DirectTests(unittest.TestCase):
    def setUp(self):
        self.item = {'id': 7, 'type': 'File', 'ext': 'txt',
                     'url_path': '/content/enforced4/123-test.20272/lesson.txt'}
        self.body = b'FICTIONAL lesson: explain your reasoning.'

    def test_path_and_course_allowlist(self):
        self.assertTrue(direct.eligible(self.item, 123))
        for path in ('https://elsewhere.test/lesson.txt', '//elsewhere.test/x.txt',
                     '/content/enforced4/124-test/x.txt',
                     '/content/enforced4/123-test/../x.txt',
                     '/content/enforced4/123-test/x%2fsecret.txt',
                     '/content/enforced4/123-test/x%252fsecret.txt',
                     '/content/enforced4/123-test/x.txt?token=secret',
                     '/content/enforced4/123-test/x.mp4'):
            self.assertFalse(direct.eligible(dict(self.item, url_path=path), 123), path)

    def exercise(self, mutate=None, body=None, **capture_options):
        body = self.body if body is None else body
        receipt = {'ok': True, 'topic': '7', 'org': '123', 'path': self.item['url_path'],
                   'size': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
        if mutate: receipt.update(mutate)
        def run(w, t, script, **kwargs):
            if '// Runs in' in script:
                budget = min(direct.MAX_BYTES, capture_options.get('max_bytes', direct.MAX_BYTES))
                self.assertIn(f'"maxBytes": {budget}', script)
                return 'started'
            if '?.result' in script: return receipt
            match = re.search(r'subarray\((\d+),(\d+)\)', script)
            if match:
                start, end = map(int, match.groups())
                self.assertLessEqual(end - start, 1024 * 1024)
                encoded = base64.b64encode(body[start:end]).decode()
                self.assertLess(len(json.dumps(encoded).encode()), 8 * 1024 * 1024)
                return encoded
            raise AssertionError('unexpected browser operation')
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(direct.cb, 'tab_id', return_value=17), \
             patch.object(direct.cb, 'find_tab_id', return_value=(1, 2)), \
             patch.object(direct.cb, 'run_js_json', side_effect=run), \
             patch.object(direct.cb, 'run_js') as cleanup:
            try:
                path, actual = direct.capture(1, 2, 123, self.item, tmp, **capture_options)
                self.assertEqual(Path(path).read_bytes(), body)
                self.assertEqual(actual['sha256'], hashlib.sha256(body).hexdigest())
                self.assertEqual(Path(path).stat().st_mode & 0o777, 0o600)
            except Exception:
                self.assertFalse(list(Path(tmp).iterdir()))
                raise
            finally:
                cleanup.assert_called_once()

    def test_exact_transfer_and_cleanup(self): self.exercise(body=self.body * 9000)
    def test_budget_and_chunk_ceiling_remain_bounded(self):
        self.assertEqual(direct.MAX_BYTES, 48 * 1024 * 1024)
        self.assertEqual(direct.CHUNK_BYTES, 1024 * 1024)
        self.exercise(max_bytes=64 * 1024 * 1024)

    def test_file_above_old_ceiling_transfers_exactly(self):
        self.exercise(body=b'F' * (36 * 1024 * 1024 + 7))

    def test_exact_ceiling_transfers_without_widening_budget(self):
        self.exercise(body=b'F' * (48 * 1024 * 1024))

    def test_lower_caller_budget_still_applies(self):
        with self.assertRaisesRegex(ValueError, 'capture_size_invalid'):
            self.exercise(max_bytes=3)

    def test_safe_oversize_reason_is_preserved(self):
        with self.assertRaisesRegex(ValueError, '^source_too_large$'):
            self.exercise({'ok': False, 'reason': 'source_too_large'})

    def test_arbitrary_failure_text_is_not_preserved(self):
        with self.assertRaisesRegex(ValueError, '^direct_source_unconfirmed$'):
            self.exercise({'ok': False, 'reason': 'source_too_large private source body'})

    def test_hash_mismatch_removes_file(self):
        with self.assertRaisesRegex(ValueError, 'hash'): self.exercise({'sha256': '0' * 64})
    def test_wrong_topic_never_saved(self):
        with self.assertRaisesRegex(ValueError, 'identity'): self.exercise({'topic': '8'})
    def test_missing_chunk_never_saved(self):
        with self.assertRaisesRegex(ValueError, 'chunk'): self.exercise({'size': len(self.body) + 1})
    def test_html_login_never_saved(self):
        with self.assertRaises(ValueError): self.exercise(body=b'<html><input type="password"></html>')
    def test_oversize_receipt_never_read(self):
        with self.assertRaisesRegex(ValueError, 'size'): self.exercise({'size': direct.MAX_BYTES + 1})
    def test_workbook_and_legacy_signatures(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'fictional.xlsx'
            with zipfile.ZipFile(p, 'w') as z: z.writestr('xl/workbook.xml', '<workbook/>')
            direct.validate_payload(p, 'xlsx')
            with self.assertRaises(ValueError): direct.validate_payload(p, 'docx')
            p.write_bytes(b'not an office file')
            with self.assertRaises(ValueError): direct.validate_payload(p, 'ppt')

    def test_unsupported_pdf_and_office(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'bad.pdf'; p.write_bytes(b'<html>not a PDF</html>')
            with self.assertRaises(ValueError): direct.validate_payload(p, 'pdf')


if __name__ == '__main__': unittest.main()
