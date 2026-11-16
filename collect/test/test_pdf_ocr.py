"""OCR bounds/provenance and failure checks, without invoking local OCR."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bin'))
import pdf_ocr


class PdfOcrTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'image.pdf'; self.path.write_bytes(b'fake pdf')
        self.platform = patch.object(pdf_ocr.sys, 'platform', 'darwin'); self.platform.start(); self.addCleanup(self.platform.stop)

    def response(self, pages, count=1):
        return Mock(stdout=json.dumps({'pages': pages, 'page_count': count}).encode())

    def test_complete_ocr_is_explicitly_machine_derived(self):
        with patch.object(pdf_ocr.subprocess, 'run', return_value=self.response([{'page':1,'text':'Stroll Garden\nPond'}])) as run:
            text = pdf_ocr.extract_pdf_ocr(self.path, 1)
        self.assertIn('Machine OCR', text); self.assertIn('Pond', text)
        self.assertEqual(run.call_args.kwargs['timeout'], 120)
        self.assertEqual(self.path.read_bytes(), b'fake pdf')

    def test_limits_reject_without_invoking_ocr(self):
        with patch.object(pdf_ocr.subprocess, 'run', side_effect=AssertionError('must not run')):
            for count in (0, 11):
                with self.assertRaisesRegex(ValueError, 'ocr_bounds'): pdf_ocr.extract_pdf_ocr(self.path, count)

    def test_partial_and_empty_results_never_count_as_extracted(self):
        for response in (self.response([]), self.response([{'page':2,'text':'Wrong page'}]), self.response([{'page':1,'text':''}])):
            with patch.object(pdf_ocr.subprocess, 'run', return_value=response):
                with self.assertRaises(ValueError): pdf_ocr.extract_pdf_ocr(self.path, 1)

    def test_timeout_remains_retryable_failure(self):
        with patch.object(pdf_ocr.subprocess, 'run', side_effect=subprocess.TimeoutExpired('swift',120)):
            with self.assertRaises(subprocess.TimeoutExpired): pdf_ocr.extract_pdf_ocr(self.path, 1)


if __name__ == '__main__': unittest.main()
