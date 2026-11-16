"""Large course datasets remain original files, with honest teaching previews."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import openpyxl
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bin'))
import extract_text


class WorkbookProjectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'source.xlsx'

    def workbook(self, rows):
        book = openpyxl.Workbook(); sheet = book.active; sheet.title = 'Teaching data'
        for row in rows: sheet.append(row)
        book.save(self.path); book.close()

    def test_small_workbook_preserves_every_nonempty_row(self):
        self.workbook([['age','earnings'], [22,50000], [None,None], [24,60000]])
        text = extract_text.from_xlsx(self.path)
        self.assertEqual(text, '## Sheet: Teaching data\nage | earnings\n22 | 50000\n24 | 60000')

    def test_large_projection_exposes_count_and_sample_limits_without_false_fullness(self):
        self.workbook([['id','value']] + [[i, 'value-' + str(i)] for i in range(1,101)])
        before = self.path.read_bytes()
        with patch.object(extract_text, 'XLSX_FULL_TEXT_CHARS', 100): text = extract_text.from_xlsx(self.path)
        self.assertIn('not the complete dataset', text)
        self.assertIn('Nonempty rows observed in scan: 101', text)
        self.assertIn('Sample: first 20 nonempty rows', text)
        self.assertNotIn('value-100', text)
        self.assertEqual(self.path.read_bytes(), before)

    def test_scan_bounds_are_explicit_and_never_report_whole_sheet_coverage(self):
        self.workbook([[i, 'visible', 'outside scanned columns'] for i in range(10)])
        with patch.object(extract_text, 'XLSX_SCAN_ROWS', 3), patch.object(extract_text, 'XLSX_SCAN_COLUMNS', 2):
            text = extract_text.from_xlsx(self.path)
        self.assertIn('Declared dimensions: 10 rows × 3 columns', text)
        self.assertIn('Nonempty rows observed in scan: 3', text)
        self.assertIn('later rows or columns were not inspected', text)
        self.assertNotIn('All declared rows and columns were scanned', text)
        self.assertNotIn('outside scanned columns', text)

    def test_long_sample_cells_are_marked_not_silently_cut(self):
        self.workbook([['header'], ['x' * 1000]])
        with patch.object(extract_text, 'XLSX_FULL_TEXT_CHARS', 100): text = extract_text.from_xlsx(self.path)
        self.assertIn('[cell excerpt]', text)
        self.assertNotIn('x' * 1000, text)


if __name__ == '__main__': unittest.main()
