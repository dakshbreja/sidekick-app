#!/usr/bin/env python3
"""Extract plain text from a course document.

Handles the formats UGA instructors actually post: .pdf, .pptx, .ppt (legacy
binary), .docx, .xlsx, .txt/.md/.csv. Returns None for anything else (video,
archives) so the caller can record it as un-extractable rather than crashing.

Usage: extract_text.py FILE [FILE ...]      -> prints text to stdout
"""
import os
import re
import struct
import sys

# --- legacy binary .ppt -------------------------------------------------------
# PowerPoint 97-2003 is an OLE compound file. Slide text lives in TextBytesAtom
# (0x0FA8, one byte per char) and TextCharsAtom (0x0FA0, UTF-16LE) records inside
# the "PowerPoint Document" stream. python-pptx cannot read this format at all.
TEXTBYTES, TEXTCHARS, RT_SLIDE = 0x0FA8, 0x0FA0, 0x03EE


def _walk_ppt(data, out):
    pos, n = 0, len(data)
    while pos + 8 <= n:
        ver_inst, rec_type, rec_len = struct.unpack_from("<HHI", data, pos)
        pos += 8
        rec_len = min(rec_len, n - pos)
        body = data[pos:pos + rec_len]
        if (ver_inst & 0x000F) == 0xF:
            if rec_type == RT_SLIDE:
                out.append(("slide", ""))
            _walk_ppt(body, out)
        elif rec_type == TEXTBYTES:
            out.append(("text", body.decode("latin-1", errors="replace")))
        elif rec_type == TEXTCHARS:
            out.append(("text", body.decode("utf-16-le", errors="replace")))
        pos += rec_len


def _clean_ppt(s):
    s = s.replace("\x0b", "\n").replace("\r", "\n").replace("\x00", "")
    for a, b in (("’", "'"), ("‘", "'"), ("“", '"'),
                 ("”", '"'), ("–", "-"), ("—", "--")):
        s = s.replace(a, b)
    s = "".join(c for c in s if c in "\n\t" or ord(c) >= 32)
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def _is_placeholder(line):
    s = line.strip()
    if not s:
        return False
    return (s == "*" or re.fullmatch(r"\d+-\*", s) is not None
            or s.startswith("Click to edit Master")
            or s in ("Second level", "Third level", "Fourth level", "Fifth level"))


def from_ppt(path):
    import olefile
    ole = olefile.OleFileIO(path)
    try:
        if "PowerPoint Document" not in ["/".join(p) for p in ole.listdir()]:
            return None
        data = ole.openstream("PowerPoint Document").read()
    finally:
        ole.close()
    raw = []
    _walk_ppt(data, raw)
    slides, cur = [], []
    for kind, val in raw:
        if kind == "slide":
            if cur:
                slides.append(cur)
            cur = []
        else:
            t = _clean_ppt(val)
            if t:
                cur.append(t)
    if cur:
        slides.append(cur)
    chunks = []
    for blocks in slides:
        kept = [l for b in blocks for l in b.split("\n") if not _is_placeholder(l)]
        body = "\n".join(kept).strip()
        # a slide holding only the publisher copyright line is a title-slide remnant
        if body and not (body.count("\n") == 0 and "McGraw-Hill" in body):
            chunks.append(body)
    return "\n\n".join(f"## Slide {i}\n{c}" for i, c in enumerate(chunks, 1))


# --- modern formats -----------------------------------------------------------
def from_pptx(path):
    from pptx import Presentation
    prs = Presentation(path)
    out = []
    for i, slide in enumerate(prs.slides, 1):
        parts = []
        for shape in slide.shapes:
            if shape.has_text_frame and shape.text_frame.text.strip():
                parts.append(shape.text_frame.text.strip())
            elif getattr(shape, "has_table", False):
                for row in shape.table.rows:
                    cells = [c.text.strip() for c in row.cells]
                    if any(cells):
                        parts.append(" | ".join(cells))
        if slide.has_notes_slide:
            n = slide.notes_slide.notes_text_frame.text.strip()
            if n:
                parts.append("[Speaker notes] " + n)
        if parts:
            out.append(f"## Slide {i}\n" + "\n".join(parts))
    return "\n\n".join(out)


def from_pdf(path):
    from pypdf import PdfReader
    reader = PdfReader(path)
    out = []
    for i, page in enumerate(reader.pages, 1):
        try:
            t = (page.extract_text() or "").strip()
        except Exception:
            t = ""
        if t:
            out.append(f"## Page {i}\n{t}")
    if not out and reader.pages:
        from pdf_ocr import extract_pdf_ocr
        return extract_pdf_ocr(path, len(reader.pages))
    return "\n\n".join(out)


def from_docx(path):
    import docx
    d = docx.Document(path)
    parts = [p.text.strip() for p in d.paragraphs if p.text.strip()]
    for table in d.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells]
            if any(cells):
                parts.append(" | ".join(cells))
    return "\n".join(parts)


def from_doc(path):
    """Legacy Word 97-2003. macOS ships textutil, which reads the format natively,
    so this needs no third-party dependency — which is why it was worth doing at
    all rather than leaving .doc in the unsupported list."""
    import subprocess
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, "out.txt")
        subprocess.run(["textutil", "-convert", "txt", "-encoding", "UTF-8",
                        "-output", out, path],
                       check=True, capture_output=True, timeout=90)
        with open(out, errors="replace") as f:
            return f.read()


XLSX_FULL_TEXT_CHARS = 150_000
XLSX_SCAN_ROWS = 200_000
XLSX_SCAN_COLUMNS = 256
XLSX_SAMPLE_ROWS = 20
XLSX_SAMPLE_CELL_CHARS = 160


def from_xlsx(path):
    """Keep small workbooks whole; label a bounded sample for large datasets.

    A giant dataset row dump is neither a readable lecture nor safe to silently
    truncate at the Bridge's text limit. Preserve the original workbook in Drive
    and state exactly which rows/columns this derived text represents.
    """
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    full, summaries, total_chars, projection = [], [], 0, False
    try:
        for ws in wb.worksheets:
            declared_rows, declared_columns = ws.max_row or 0, ws.max_column or 0
            bounded = declared_rows > XLSX_SCAN_ROWS or declared_columns > XLSX_SCAN_COLUMNS
            projection = projection or bounded
            rows, samples, nonempty = [], [], 0
            for index, row in enumerate(ws.iter_rows(max_row=min(declared_rows, XLSX_SCAN_ROWS),
                        max_col=min(declared_columns, XLSX_SCAN_COLUMNS), values_only=True), 1):
                cells = ["" if c is None else str(c).strip() for c in row]
                if not any(cells): continue
                nonempty += 1
                text = " | ".join(cells).rstrip(" |")
                total_chars += len(text) + 1
                if total_chars > XLSX_FULL_TEXT_CHARS:
                    projection = True
                    rows.clear(); full.clear()
                if not projection: rows.append(text)
                if len(samples) < XLSX_SAMPLE_ROWS:
                    clipped = [c if len(c) <= XLSX_SAMPLE_CELL_CHARS else c[:XLSX_SAMPLE_CELL_CHARS] + ' [cell excerpt]' for c in cells]
                    samples.append(f'Row {index}: ' + ' | '.join(clipped).rstrip(' |'))
            if nonempty:
                full.append(f"## Sheet: {ws.title}\n" + "\n".join(rows))
                summaries.append((ws.title, declared_rows, declared_columns, nonempty, bounded, samples))
    finally:
        wb.close()
    if not projection: return "\n\n".join(full)
    out = ['[Structured workbook projection; not the complete dataset. The original workbook is retained in Drive.]',
           'Only the first nonempty rows shown below are reproduced. Use the original workbook for calculations, complete records, formulas and unsampled values. Values here use the workbook\'s cached results; formulas are not recalculated.']
    for name, row_count, column_count, nonempty, bounded, samples in summaries:
        coverage = ('Scan bounded: later rows or columns were not inspected.' if bounded
                    else 'All declared rows and columns were scanned for the nonempty-row count; only the sample is reproduced.')
        out.append(f'## Sheet: {name}\nDeclared dimensions: {row_count} rows × {column_count} columns.\n'
                   f'Nonempty rows observed in scan: {nonempty}.\n{coverage}\n'
                   f'Sample: first {len(samples)} nonempty rows, up to {XLSX_SCAN_COLUMNS} columns; long cells are marked as excerpts.\n' + '\n'.join(samples))
    return '\n\n'.join(out)


def from_plain(path):
    with open(path, "r", errors="replace") as f:
        return f.read()


def from_html(path):
    from html.parser import HTMLParser
    class Text(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.parts, self.hidden = [], 0
        def handle_starttag(self, tag, attrs):
            if tag in ('script', 'style'): self.hidden += 1
            if tag in ('p','br','div','li','tr','h1','h2','h3','h4'): self.parts.append('\n')
        def handle_endtag(self, tag):
            if tag in ('script','style'): self.hidden=max(0,self.hidden-1)
            if tag in ('p','div','li','tr','h1','h2','h3','h4'): self.parts.append('\n')
        def handle_data(self, data):
            if not self.hidden: self.parts.append(data)
    parser=Text(); parser.feed(from_plain(path))
    return re.sub(r'\n[ \t]*\n+', '\n\n', ''.join(parser.parts)).strip()


def from_zip(path):
    # D2L wraps HTML topics and other documents in ZIP downloads. Read only
    # bounded members into a temporary directory; never execute archive content.
    import zipfile
    import tempfile
    from pathlib import Path, PurePosixPath
    with zipfile.ZipFile(path) as archive, tempfile.TemporaryDirectory() as tmp:
        members=[i for i in archive.infolist() if not i.is_dir()]
        if len(members)>200 or sum(i.file_size for i in members)>64*1024*1024:
            raise ValueError('archive_limit')
        names=[i.filename for i in members]
        if len(names)!=len(set(names)): raise ValueError('duplicate_archive_member')
        parts=[]
        for i, member in enumerate(members):
            name=PurePosixPath(member.filename)
            if name.is_absolute() or '..' in name.parts or '\\' in member.filename:
                raise ValueError('unsafe_archive_path')
            if member.flag_bits & 1 or member.file_size>max(1,member.compress_size)*1000:
                raise ValueError('archive_limit')
            ext=name.suffix.lower()
            if ext in ('.mp4','.mov','.m4v','.avi','.wmv','.zip'):
                raise ValueError('archive_requires_transcription_or_review')
            if ext not in HANDLERS or ext=='.zip': continue  # images/styles are not text
            dest=Path(tmp)/(str(i)+ext); dest.write_bytes(archive.read(member))
            text,note=extract(str(dest))
            if text is None: raise ValueError('archive_member_extraction_failed')
            parts.append('## Archive document: '+str(name)+'\n'+text)
        return '\n\n'.join(parts)


HANDLERS = {
    ".pdf": from_pdf, ".pptx": from_pptx, ".ppt": from_ppt,
    ".docx": from_docx, ".doc": from_doc,
    ".xlsx": from_xlsx, ".xlsm": from_xlsx,
    ".txt": from_plain, ".md": from_plain, ".csv": from_plain,
    ".r": from_plain, ".rmd": from_plain, ".html": from_html, ".htm": from_html, ".zip": from_zip,
}

UNSUPPORTED_NOTE = {
    ".mp4": "video - handed to bin/transcribe.py",
    ".mov": "video - handed to bin/transcribe.py",
    ".zip": "archive - unpack manually",
}


def extract(path):
    """Return (text, note). text is None when the format is not extractable."""
    ext = os.path.splitext(path)[1].lower()
    fn = HANDLERS.get(ext)
    if not fn:
        return None, UNSUPPORTED_NOTE.get(ext, f"unsupported format {ext}")
    try:
        text = fn(path)
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"
    if not text or not text.strip():
        return None, "no extractable text layer"
    return text, None


if __name__ == "__main__":
    for p in sys.argv[1:]:
        text, note = extract(p)
        if text is None:
            print(f"[{os.path.basename(p)}] SKIPPED: {note}", file=sys.stderr)
        else:
            print(text)
