"""Bounded exact-file capture; never reads or writes the shared Downloads queue."""
import base64
import hashlib
import json
from pathlib import Path
import re
import time
from urllib.parse import urlsplit, unquote
import uuid
import zipfile

import chrome_bridge as cb

EXTENSIONS = {'pdf', 'html', 'htm', 'docx', 'pptx', 'txt', 'md', 'r', 'rmd', 'csv', 'srt', 'vtt', 'xlsx', 'xlsm', 'doc', 'ppt'}
# Course documents slightly above 32 MiB must not stay permanently due. Keep a
# hard 48 MiB document ceiling; media and smaller caller budgets stay protected.
MAX_BYTES = 48 * 1024 * 1024
# One MiB avoids hundreds of Neo round trips within the existing 110 s deadline.
# Its base64 JSON is under 1.4 MiB, comfortably below Neo's 8 MiB result limit.
CHUNK_BYTES = 1024 * 1024


def failure_reason(value):
    """Persist only fixed source codes, never arbitrary exception/page text."""
    reason = str(value)
    safe = re.fullmatch(r'(session_required|unsafe_source_path|source_unavailable|source_identity_changed|topic_unavailable|inventory_limit|source_too_large|empty_source|http_[45][0-9]{2})', reason)
    return reason if safe else 'direct_source_unconfirmed'


def eligible(item, org):
    if not str(org).isdigit() or not str(item.get('id', '')).isdigit() or item.get('type') != 'File':
        return False
    path = item.get('url_path', '')
    if not isinstance(path, str) or not path.startswith('/') or path.startswith('//'):
        return False
    parts = urlsplit(path)
    ext = Path(unquote(parts.path)).suffix.lower().lstrip('.')
    return (not parts.query and not parts.fragment and '\\' not in path
            and not re.search(r'%(?:2f|5c|2e|00|25)', path, re.I)
            and '..' not in path.split('/')
            and bool(re.match(r'^/content/enforced[0-9]*/' + str(org) + r'(?:-[^/]+)?/', path))
            and ext in EXTENSIONS and ext == str(item.get('ext', '')).lower())


def validate_payload(path, ext):
    """Do not accept an HTTP-200 login page as a document or source refresh."""
    data = path.read_bytes()
    if ext == 'pdf':
        if not data.startswith(b'%PDF-'): raise ValueError('invalid_pdf')
    elif ext in ('doc', 'ppt'):
        if not data.startswith(bytes.fromhex('d0cf11e0a1b11ae1')): raise ValueError('invalid_legacy_office')
    elif ext in ('docx', 'pptx', 'xlsx', 'xlsm'):
        with zipfile.ZipFile(path) as archive:
            marker = {'docx': 'word/document.xml', 'pptx': 'ppt/presentation.xml',
                      'xlsx': 'xl/workbook.xml', 'xlsm': 'xl/workbook.xml'}[ext]
            if marker not in archive.namelist(): raise ValueError('invalid_office')
    else:
        text = data.decode('utf-8-sig')
        if '\x00' in text: raise ValueError('binary_source')
        if re.search(r'<input\b[^>]*type\s*=\s*[\'\"]?password\b', text, re.I):
            raise ValueError('login_response')
        if ext not in ('html', 'htm') and re.search(r'<!doctype\s+html|<html\b', text, re.I):
            raise ValueError('unexpected_html')


def capture(win, tab, org, item, directory, *, max_bytes=MAX_BYTES, timeout=110):
    """Return exact bytes and a receipt only after identity, size and SHA readback.

    Caller owns a private temporary directory and commits through the existing
    durable delivery queue. A failure has no native-download side effects.
    """
    if not eligible(item, org): raise ValueError('unsupported_direct_source')
    max_bytes = min(MAX_BYTES, int(max_bytes))
    if max_bytes < 1: raise ValueError('source_budget_exhausted')
    key = '__sidekick_file_' + uuid.uuid4().hex
    identity = cb.tab_id(win, tab)
    deadline = time.monotonic() + timeout
    def run(script):
        remaining = deadline - time.monotonic()
        if remaining <= 0: raise TimeoutError('direct_capture_timeout')
        position = cb.find_tab_id(identity)
        if not position: raise ValueError('source_tab_closed')
        return cb.run_js_json(*position, script, timeout=max(1, min(15, remaining)))
    request = {'key': key, 'org': str(org), 'topic': str(item['id']),
               'path': item['url_path'], 'maxBytes': max_bytes,
               'timeoutMs': int(min(60, timeout) * 1000)}
    script = Path(__file__).with_suffix('.js').read_text().replace('__REQUEST__', json.dumps(request))
    target = Path(directory) / ('source.' + item['ext'].lower())
    try:
        if run(script) != 'started': raise ValueError('capture_not_started')
        while True:
            result = run(f'JSON.stringify(window[{json.dumps(key)}]?.result ?? null)')
            if result != 'pending': break
            time.sleep(0.3)
        if not isinstance(result, dict) or result.get('ok') is not True:
            reason = result.get('reason', '') if isinstance(result, dict) else ''
            raise ValueError(failure_reason(reason))
        if any(result.get(k) != request[k] for k in ('topic', 'org', 'path')):
            raise ValueError('capture_identity_mismatch')
        size = result.get('size')
        if type(size) is not int or not 0 < size <= max_bytes: raise ValueError('capture_size_invalid')
        digest = hashlib.sha256()
        with target.open('xb') as output:
            target.chmod(0o600)
            for offset in range(0, size, CHUNK_BYTES):
                end = min(size, offset + CHUNK_BYTES)
                encoded = run(f'''(function(){{const s=window[{json.dumps(key)}];
                  if(!s?.bytes)return JSON.stringify(null);
                  let b='';for(const v of s.bytes.subarray({offset},{end}))b+=String.fromCharCode(v);
                  return JSON.stringify(btoa(b));}})()''')
                chunk = base64.b64decode(encoded, validate=True)
                if len(chunk) != end - offset: raise ValueError('capture_chunk_incomplete')
                output.write(chunk); digest.update(chunk)
        if digest.hexdigest() != result.get('sha256'): raise ValueError('capture_hash_mismatch')
        validate_payload(target, item['ext'].lower())
        return str(target), dict(result, transport='same_origin_exact_file')
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    finally:
        try:
            position = cb.find_tab_id(identity)
            if position: cb.run_js(*position, f'window[{json.dumps(key)}]?.dispose(); "cleared"', timeout=10)
        except Exception:
            pass  # Browser-side expiry independently destroys this operation's bytes.
