"""Private collector text transport. Receipts are hashes, never content in logs."""
import hashlib
import json
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

CONFIG = Path.home() / 'Claude/school-system-suite/bridge/.env'
MAX_RESPONSE = 2_000_000
MAX_TEXT_BYTES = 2_000_000  # Finite UTF-8 transport; Worker separately caps at 2,000,000 UTF-16 units.
REASONS = frozenset(('response_size', 'response_shape', 'not_found',
                     'connection_or_configuration', 'local_text_changed',
                     'publication_unconfirmed', 'readback_unconfirmed'))


def config():
    values = {}
    for line in CONFIG.read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            k, v = line.split('=', 1)
            values[k.strip()] = v.strip().strip('\"').strip("'")
    url = values.get('WORKER_URL', '').rstrip('/')
    parsed = urllib.parse.urlsplit(url)
    key = values.get('API_KEY', '')
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment
            or not key or any(ord(c) < 32 for c in key)):
        raise ValueError('configuration')
    return url, key


def request(path, payload=None):
    try:
        url, key = config()
        req = urllib.request.Request(url + path,
            data=None if payload is None else json.dumps(payload).encode(),
            headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json',
                     'User-Agent': 'elc-material-recovery/1.0'})
        with urllib.request.urlopen(req, timeout=25) as response:
            raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            return {'ok': False, 'reason': 'response_size'}
        result = json.loads(raw)
        return result if isinstance(result, dict) else {'ok': False, 'reason': 'response_shape'}
    except urllib.error.HTTPError as error:
        return {'ok': False, 'reason': 'not_found' if error.code == 404 else 'http_' + str(error.code)}
    except Exception:
        return {'ok': False, 'reason': 'connection_or_configuration'}


def _reason(answer, fallback):
    reason = answer.get('reason')
    if reason in REASONS or isinstance(reason, str) and re.fullmatch(r'http_[1-5][0-9]{2}', reason):
        return reason
    return fallback


def _identity(record):
    course = record['course']
    course = {'BUSN3040E': 'BUSN3040', 'LAND2510E': 'LAND2510'}.get(course, course)
    rel = Path(record['drive_rel'])
    return course, rel.name, str(rel.parent).replace('\\', '/').strip('/')


def _receipt_matches(answer, course, filename):
    return (answer.get('ok') is True and answer.get('course') == course
            and answer.get('stored') == filename)


def _document_matches(doc, filename, folder, doc_id=None):
    return (isinstance(doc, dict) and doc.get('title') == filename
            and isinstance(doc.get('folder'), str) and doc['folder'].strip('/') == folder
            and isinstance(doc.get('doc_id'), str) and bool(doc['doc_id'])
            and (doc_id is None or doc['doc_id'] == doc_id))


def publish(record):
    try:
        course, filename, _ = _identity(record)
        with Path(record['text_path']).open('rb') as source:
            raw = source.read(MAX_TEXT_BYTES + 1)
        if len(raw) > MAX_TEXT_BYTES:
            return {'ok': False, 'reason': 'local_text_size'}
        if hashlib.sha256(raw).hexdigest() != record['text_sha256']:
            return {'ok': False, 'reason': 'local_text_changed'}
        # Explicit UTF-8 and no newline rewriting bind the transmitted text to
        # the exact local bytes accepted by the durable delivery ledger.
        text = raw.decode('utf-8')
        answer = request('/library/text', {'course': course,
            'filename': filename, 'title': record['title'], 'text': text})
        if (_receipt_matches(answer, course, filename)
                and answer.get('text_sha256') == record['text_sha256']
                and answer.get('truncated') is False):
            return {'ok': True, 'text_sha256': record['text_sha256']}
        return {'ok': False, 'reason': _reason(answer, 'publication_unconfirmed')}
    except Exception:
        return {'ok': False, 'reason': 'local_text_unavailable'}


def readback(record):
    try:
        course, filename, folder = _identity(record)
        params = {'course': course, 'filename': filename}
        exact = bool(record.get('topic_id'))
        if exact: params['text_sha256'] = record['text_sha256']
        query = urllib.parse.urlencode(params)
        answer = request('/library/text?' + query)
        if answer.get('ok') is not True:
            return {'ok': False, 'reason': _reason(answer, 'readback_unconfirmed')}
        if not _receipt_matches(answer, course, filename):
            return {'ok': False, 'reason': 'receipt_identity_pending'}
        if answer.get('text_sha256') != record['text_sha256'] or answer.get('truncated') is not False:
            return {'ok': False, 'reason': 'hash_mismatch'}
        # The cache receipt alone does not establish that the original is in
        # Drive. Require exact folder/name and the reader's same-document proof.
        listing = request('/library?' + urllib.parse.urlencode({'course': course, 'q': filename, 'limit': 50}))
        documents = listing.get('documents')
        if listing.get('course') != course or not isinstance(documents, list):
            return {'ok': False, 'reason': 'drive_identity_pending'}
        matches = [d for d in documents if _document_matches(d, filename, folder)]
        if len(matches) != 1:
            return {'ok': False, 'reason': 'drive_identity_pending'}
        doc_id = matches[0]['doc_id']
        if exact:
            chunks, offset, total = [], 0, None
            for _ in range(32):
                doc = request('/library/doc?' + urllib.parse.urlencode({'id': doc_id,
                    'max_chars': 120000, 'text_sha256': record['text_sha256'], 'offset': offset}))
                if not _document_matches(doc.get('document'), filename, folder, doc_id):
                    return {'ok': False, 'reason': 'document_identity_pending'}
                text, observed_total = doc.get('text'), doc.get('total_chars')
                if (doc.get('source') != 'sweep_extraction' or doc.get('text_sha256') != record['text_sha256']
                        or not isinstance(text, str) or doc.get('offset') != offset
                        or not isinstance(observed_total, int) or isinstance(observed_total, bool)
                        or not 0 <= observed_total <= MAX_TEXT_BYTES
                        or total is not None and total != observed_total):
                    return {'ok': False, 'reason': 'document_readback_pending'}
                total = observed_total
                chunks.append(text)
                end = offset + len(text.encode('utf-16-le')) // 2
                if doc.get('next_offset') is None:
                    if end != total or doc.get('truncated') is not False:
                        return {'ok': False, 'reason': 'document_readback_pending'}
                    raw = ''.join(chunks).encode('utf-8')
                    if len(raw) <= MAX_TEXT_BYTES and hashlib.sha256(raw).hexdigest() == record['text_sha256']:
                        return {'ok': True, 'text_sha256': record['text_sha256']}
                    return {'ok': False, 'reason': 'document_readback_pending'}
                if (end <= offset or end >= total or doc.get('next_offset') != end
                        or doc.get('truncated') is not True):
                    return {'ok': False, 'reason': 'document_readback_pending'}
                offset = end
            return {'ok': False, 'reason': 'document_readback_pending'}
        doc = request('/library/doc?' + urllib.parse.urlencode({'id': doc_id, 'max_chars': 120000}))
        if not _document_matches(doc.get('document'), filename, folder, doc_id):
            return {'ok': False, 'reason': 'document_identity_pending'}
        text = doc.get('text')
        if doc.get('source') == 'sweep_extraction':
            # The digest covers the full stored extraction, even where the
            # individual read is a documented 120,000-character projection.
            if isinstance(text, str) and doc.get('text_sha256') == record['text_sha256']:
                return {'ok': True, 'text_sha256': record['text_sha256']}
        elif (doc.get('source') in ('drive_export', 'drive_download')
              and isinstance(text, str) and doc.get('truncated') is False):
            value = hashlib.sha256(text.encode('utf-8')).hexdigest()
            # A filed video member is distinct from its retained source ZIP.
            # Only its own bytes can satisfy a direct original readback.
            original_hash = (record.get('drive_sha256') if record.get('drive_representation') == 'archive_video'
                             else record['source_sha256'])
            if value in (record['text_sha256'], original_hash):
                return {'ok': True, 'text_sha256': record['text_sha256']}
        return {'ok': False, 'reason': 'document_readback_pending'}
    except Exception:
        return {'ok': False, 'reason': 'readback_unconfirmed'}
