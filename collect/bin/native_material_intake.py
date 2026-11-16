"""Resume explicitly registered native source downloads in the existing collector.

Registration is an operator action grounded in the observed native topic/download.
The consumer never opens a browser, starts downloads, or guesses topic identity.
Call only while holding the collector's material-run lock.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
from urllib.parse import unquote, urlsplit

import material_revisions
from material_delivery import sha256_file, COURSE_RE

STATE_NAME = '.pending-native-materials.json'
MAX_SOURCE_BYTES = 4 * 1024 ** 3
MAX_ACCEPTED_PER_RUN = 2


def _load(root):
    path = Path(root) / STATE_NAME
    if not path.exists(): return {'version': 1, 'captures': []}
    try:
        state = json.loads(path.read_text())
        assert state['version'] == 1 and isinstance(state['captures'], list) and len(state['captures']) <= 32
        ids = set()
        for row in state['captures']:
            assert isinstance(row, dict) and row['capture_id'] not in ids
            ids.add(row['capture_id'])
            assert row['status'] in ('pending', 'complete')
            assert isinstance(row['course'], str) and COURSE_RE.fullmatch(row['course']) and str(row['topic_id']).isdigit()
            assert isinstance(row['org_unit'], str) and row['org_unit'].isdigit()
            assert isinstance(row['term'], str) and row['term']
            for key in ('partial_name', 'final_name'):
                assert isinstance(row[key], str) and Path(row[key]).name == row[key] and row[key] not in ('.', '..')
                assert not any(ord(c) < 32 for c in row[key]) and '\\' not in row[key]
                decoded = unquote(row[key])
                assert Path(decoded).name == decoded and decoded not in ('.', '..') and '\\' not in decoded
                assert not any(ord(c) < 32 for c in decoded)
            assert row['partial_name'].endswith('.crdownload') and not row['final_name'].endswith('.crdownload')
            assert all(isinstance(row[k], int) and row[k] > 0 for k in ('device', 'inode', 'minimum_bytes'))
            assert 0 < row['minimum_bytes'] <= MAX_SOURCE_BYTES
            assert isinstance(row['source_path'], str) and '?' not in row['source_path'] and '#' not in row['source_path']
        return state
    except Exception:
        raise ValueError('invalid_native_intake_state') from None


def save_state(root, state):
    """Atomic receipt persistence; caller has the existing collector run lock."""
    path = Path(root) / STATE_NAME
    fd, temp = tempfile.mkstemp(prefix=STATE_NAME + '.', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as f:
            json.dump(state, f, indent=2); f.write('\n'); f.flush(); os.fsync(f.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(temp): os.unlink(temp)


def pending_topics(root, courses=None):
    return {(r['course'], str(r['topic_id'])) for r in _load(root)['captures']
            if r['status'] == 'pending' and (courses is None or r['course'] in courses)}


def summary(root):
    rows = _load(root)['captures']
    return {'pending': sum(r['status'] == 'pending' for r in rows),
            'complete': sum(r['status'] == 'complete' for r in rows),
            'reasons': sorted({r.get('reason', 'native_download_in_progress') for r in rows if r['status'] == 'pending'})}


def _media_duration(path):
    result = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', str(path)], capture_output=True,
        text=True, timeout=30, check=True)
    return float(result.stdout.strip())


def _stamp(stat):
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


def _identity(row, manifest, source_config, courses):
    course, topic = row['course'], str(row['topic_id'])
    if course not in courses: return None, 'outside_scope'
    canonical = course[:-1] if course in ('LAND2510E', 'BUSN3040E') else course
    org = str(source_config.get('courses', {}).get(canonical, ''))
    term = str(source_config.get('elc_term_code', ''))
    if row['org_unit'] != org or row['term'] != term:
        return None, 'native_scope_changed'
    matches = [i for i in manifest.get('courses', {}).get(course, {}).get('items', [])
               if str(i.get('id')) == topic and i.get('type') == 'File']
    if len(matches) != 1: return None, 'native_topic_missing'
    path = row['source_path']
    if (not path.startswith('/content/enforced4/' + org + '-')
            or '.' + term + '/' not in path
            or unquote(path.rsplit('/', 1)[-1]) != unquote(row['final_name'])
            or Path(unquote(row['final_name'])).suffix.lower() != '.' + str(matches[0].get('ext', '')).lower()):
        return None, 'native_source_identity_mismatch'
    for field in ('url_path', 'url', 'Url', 'URL'):
        known = matches[0].get(field)
        if known and unquote(urlsplit(str(known)).path) != unquote(path):
            return None, 'native_source_identity_mismatch'
    return matches[0], None


def recover(root, downloads, manifest, fetched, courses, source_config, queue, save_fetched,
            inspect_media=_media_duration):
    state = _load(root)
    accepted, waiting = 0, 0
    root, downloads = Path(root), Path(downloads).resolve()
    for row in state['captures']:
        if row['status'] != 'pending' or row['course'] not in courses: continue
        if accepted >= MAX_ACCEPTED_PER_RUN: break
        item, reason = _identity(row, manifest, source_config, courses)
        if reason: row['reason'] = reason; waiting += 1; continue
        source, partial = downloads / row['final_name'], downloads / row['partial_name']
        if partial.exists(): row['reason'] = 'native_download_in_progress'; waiting += 1; continue
        if not source.exists(): row['reason'] = 'native_final_missing'; waiting += 1; continue
        try:
            before = source.stat()
            if (source.is_symlink() or source.resolve().parent != downloads or not source.is_file()
                    or (before.st_dev, before.st_ino) != (row['device'], row['inode'])):
                row['reason'] = 'native_file_identity_mismatch'; waiting += 1; continue
            if not row['minimum_bytes'] <= before.st_size <= MAX_SOURCE_BYTES:
                row['reason'] = 'native_size_mismatch'; waiting += 1; continue
            seconds = inspect_media(source)
            expected = row.get('expected_duration_seconds')
            if not 0 < seconds <= 4 * 3600 or (expected is not None and abs(seconds - float(expected)) > 2):
                row['reason'] = 'native_duration_mismatch'; waiting += 1; continue
            digest = sha256_file(source)
            if _stamp(source.stat()) != _stamp(before):
                row['reason'] = 'native_source_changed'; waiting += 1; continue
            rawdir = root / row['course'] / 'raw'; rawdir.mkdir(parents=True, exist_ok=True)
            # Topic-bound filename cannot overwrite an unrelated prior source.
            raw = rawdir / ('native_' + str(row['topic_id']) + '_' + digest[:16] + '_' + unquote(row['final_name']))
            if not raw.exists():
                fd, temporary = tempfile.mkstemp(prefix='.native-intake-', dir=rawdir); os.close(fd)
                try:
                    shutil.copyfile(source, temporary)
                    if sha256_file(temporary) != digest or _stamp(source.stat()) != _stamp(before):
                        raise ValueError('native_source_changed')
                    with open(temporary, 'rb') as copied: os.fsync(copied.fileno())
                    os.replace(temporary, raw)
                finally:
                    if os.path.exists(temporary): os.unlink(temporary)
            elif sha256_file(raw) != digest:
                raise ValueError('native_copy_mismatch')
            old = fetched.get(str(row['topic_id']), {})
            if old.get('course', row['course']) != row['course']:
                raise ValueError('native_source_identity_mismatch')
            record = queue.enqueue(row['course'], str(row['topic_id']), str(raw), item['title'], item.get('unit', ''))
            updated = material_revisions.record_success(old, item, row['course'], row['org_unit'], row['term'],
                material_revisions.content_digest(raw), raw.stat().st_size, raw.name)
            updated.update(course=row['course'], title=item['title'], raw=raw.name)
            if updated.get('source_quarantine', {}).get('raw_sha256') not in (None, digest):
                updated['superseded_source_quarantine'] = updated.pop('source_quarantine')
            updated['native_source_receipt'] = {k: row[k] for k in ('capture_id', 'course', 'topic_id', 'org_unit', 'term', 'source_path', 'registered_at')}
            updated['native_source_receipt'].update(verified_at=time.time(), source_sha256=digest,
                evidence='Observed native download partial identity; browser final rename retained device/inode; complete media duration and stable original bytes verified')
            fetched[str(row['topic_id'])] = updated
            save_fetched(fetched)  # Durable enqueue precedes compatibility receipt.
            row.update(status='complete', reason=None, source_sha256=digest, revision_id=record['revision_id'], completed_at=time.time())
            accepted += 1
        except Exception as exc:
            reason = str(exc)
            row['reason'] = reason if reason in ('native_source_changed', 'native_copy_mismatch', 'native_source_identity_mismatch') else 'native_intake_failed'
            waiting += 1
        save_state(root, state)
    if state['captures']: save_state(root, state)
    return {'accepted': accepted, 'waiting': waiting, 'pending': sum(r['status'] == 'pending' for r in state['captures'])}
