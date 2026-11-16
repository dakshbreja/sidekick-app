"""Bounded macOS OCR fallback for PDFs with no extractable text layer."""
import json
from pathlib import Path
import subprocess
import sys

MAX_PAGES = 10
MAX_PDF_BYTES = 50 * 1024 * 1024
MAX_OUTPUT_BYTES = 2 * 1024 * 1024


def extract_pdf_ocr(path, page_count):
    path = Path(path).resolve()
    if sys.platform != 'darwin': raise ValueError('ocr_unavailable')
    if not 0 < page_count <= MAX_PAGES or path.stat().st_size > MAX_PDF_BYTES:
        raise ValueError('ocr_bounds')
    result = subprocess.run(['/usr/bin/swift', str(Path(__file__).with_suffix('.swift')),
                             str(path), str(MAX_PAGES)],
                            capture_output=True, timeout=120, check=True)
    if len(result.stdout) > MAX_OUTPUT_BYTES: raise ValueError('ocr_output_size')
    answer = json.loads(result.stdout)
    pages = answer.get('pages')
    if answer.get('page_count') != page_count or not isinstance(pages, list) or len(pages) != page_count:
        raise ValueError('ocr_incomplete')
    out = []
    for index, page in enumerate(pages, 1):
        if page.get('page') != index or not isinstance(page.get('text'), str):
            raise ValueError('ocr_incomplete')
        body = page['text'].strip()
        if not body: raise ValueError('ocr_no_text')
        out.append(f'## Page {index}\n[Machine OCR of original PDF image; verify labels and diagram relationships in the original.]\n{body}')
    return '\n\n'.join(out)
