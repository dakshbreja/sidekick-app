#!/usr/bin/env python3
"""Connect verified Cluely exports to existing course bundles and GPT File Library.

Session IDs are identities; hashes acknowledge bytes, not filenames. Raw exports
stay in meetings/Classes. Only transcript-derived text passes to course materials.
No grade, calendar, progress, or unrelated meeting data is read or written.
"""
import argparse
import errno
import fcntl
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SUITE = Path(os.environ.get('SCHOOL_SUITE_ROOT', str(Path(__file__).resolve().parents[2])))
sys.path.insert(0, str(SUITE / 'collect/bin'))
sys.path.insert(0, str(SUITE / 'meetings/bin'))
import bundle
import verify
from push_notes import load_env, frontmatter

COURSES = ['BUSN5000','MGMT4280','MGMT5560','MGMT5850','LAND2510','BUSN3040']
COLLECT_CODES = {'LAND2510':'LAND2510E'}
MEETINGS = SUITE / 'meetings'
MANIFEST = MEETINGS / '.lecture-sync.json'
DRIVE = Path.home() / 'Library/CloudStorage/owner@example.com/My Drive/College/UGA/Year 4 - 2026-27/Classes/Fall 2026'


def now():
    return datetime.now(timezone.utc).isoformat()


def read(path, default):
    return json.loads(read_text(path)) if path.exists() else default


class ReadBudget:
    """Share transient retry time across a destination, then stop probing it.

    A rejected read is never permission to overwrite. Each sync gets fresh
    budgets; unavailable providers do not cause N identical hydration waits.
    """
    def __init__(self, seconds=15):
        self.remaining = seconds
        self.open = False
        self.recovered = 0


def read_text(path, budget=None):
    if budget is not None and budget.open:
        raise OSError(errno.EAGAIN, 'provider read circuit open for this run')
    for attempt in range(4):
        started = time.monotonic()
        delay = 0
        try:
            text = path.read_text()
            if budget is not None and attempt:
                budget.recovered += 1
            return text
        except OSError as exc:
            if exc.errno not in {errno.EDEADLK, errno.EAGAIN}:
                raise
            remaining = (budget.remaining - (time.monotonic()-started)
                         if budget is not None else float('inf'))
            if attempt == 3 or remaining <= 0:
                if budget is not None:
                    budget.open = True
                raise
            delay = min(2 ** attempt, remaining)
            time.sleep(delay)
            if budget is not None:
                budget.remaining = max(0, budget.remaining - delay)
        finally:
            if budget is not None:
                # Subtract read time only; sleep has already consumed budget.
                budget.remaining = max(0, budget.remaining - max(0, time.monotonic()-started - delay))


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(value)
    tmp.replace(path)


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def normalize(transcript):
    # Cluely's Copy Transcript and DOM export use different speaker framing.
    return re.sub(r'^([^\n]{1,40}?) \[(\d{1,2}:\d{2}(?::\d{2})?)\]: ?',
                  r'\1\n\2\n', transcript, flags=re.M)


def render(rec, sid, raw):
    fm = frontmatter(raw)
    if fm.get('session_id') != sid:
        raise ValueError('session identity does not match export state')
    transcript = normalize(raw.split('## Transcript',1)[1]) if '## Transcript' in raw else ''
    report = verify.check(rec['course'], rec['title'], '', transcript)
    if report['blocking'] or not report['turns']:
        raise ValueError('transcript held: ' + ', '.join(report['blocking'] or ['no parsed turns']))
    foreign = report['foreign_blocks']
    turns = [t for t in verify.parse_turns(transcript)
             if not any(a <= t[1] < b for a,b in foreign)]
    code = rec['course'].replace(' ','').rstrip('E')
    text = '\n'.join([
        f"# {code} — Cluely lecture notes — {rec['date']}", '',
        f"Session ID: {sid}", f"Recorded at: {fm.get('date', rec['date'])}",
        f"Course: {rec['title']}", 'Source: Cluely recorded transcript',
        'Speaker names are unreliable channel labels. ASR may mishear names/numbers.',
        'Cluely generated summaries are excluded; the timestamped transcript is the evidence.',
        f"Unrelated audio intervals excluded by existing verification gate: {foreign}",
        '', '=' * 72, '',
        *[f"[{verify.fmt(sec)}] {tx}" for _,sec,tx in turns], ''
    ])
    return text, {'turns':len(turns),'foreign_blocks':foreign,'notes':report['notes']}


def bridge_get(cfg, path, params, timeout=45):
    req = urllib.request.Request(cfg['WORKER_URL'].rstrip('/') + path + '?' + urllib.parse.urlencode(params),
        headers={'Authorization':'Bearer '+cfg['API_KEY'],'User-Agent':'lecture-sync/1.0'})
    with urllib.request.urlopen(req,timeout=timeout) as response:
        return json.load(response)


def verify_library(cfg, course, name, text, doc_id=None, deadline=None):
    # Drive Desktop publishes asynchronously. Retest exact bytes for a bounded
    # period; neither a local copy nor a matching filename proves delivery.
    deadline = time.monotonic() + 60 if deadline is None else deadline
    error = ValueError('GPT File Library did not return the exact current lecture bytes')
    def get(path, params):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('GPT File Library verification deadline reached')
        return bridge_get(cfg, path, params, timeout=min(20, remaining))
    for attempt in range(6):
        try:
            if doc_id:
                body = get('/library/doc', {'id':doc_id,'max_chars':120000})
                document = body.get('document', {})
                if document.get('title') == name and not body.get('truncated') and body.get('text') == text:
                    return {'status':'verified','verified_at':now(),'doc_id':doc_id,
                            'sha256':digest(text),'destination':'GPT Action File Library','link':document.get('link')}
                # A moved/deleted/replaced ID is not proof of publication.
                doc_id = None
            listing = get('/library', {'course':course,'q':name,'limit':50})
            matches = [d for d in listing.get('documents',[]) if d['title'] == name]
            for doc in matches:
                body = get('/library/doc', {'id':doc['doc_id'],'max_chars':120000})
                if not body.get('truncated') and body.get('text') == text:
                    return {'status':'verified','verified_at':now(),'doc_id':doc['doc_id'],
                            'sha256':digest(text),'destination':'GPT Action File Library','link':doc.get('link')}
            error = ValueError('GPT File Library did not return the exact current lecture bytes')
        except urllib.error.HTTPError as exc:
            if exc.code not in (404, 408, 429, 500, 502, 503, 504):
                raise
            if exc.code == 404:
                doc_id = None
            error = exc
        except (TimeoutError, urllib.error.URLError) as exc:
            error = exc
        remaining = deadline - time.monotonic()
        if attempt == 5 or remaining <= 0:
            break
        time.sleep(min(2 ** (attempt + 1), 20, remaining))
    raise error


def sync(courses, dry=False, publish=False, check_library=False):
    state = read(MEETINGS/'.state.json', {'exported':{}})
    manifest = read(MANIFEST, {'schema_version':1,'sessions':{},'courses':{}})
    observed = read(MEETINGS/'.raw-inventory.json', {})
    raw_by_id = {sid:{'sid':sid,'course':(r.get('course') or '').replace(' ','').rstrip('E'),
        'created':r.get('created',r['date']), 'ongoing':False,'observation':'existing export'}
        for sid,r in state['exported'].items() if r.get('course')}
    raw_by_id.update({r['sid']:r for r in observed.get('sessions',[])})
    raw_sessions = list(raw_by_id.values())
    cfg = load_env() if check_library else None
    errors=[]
    local_reads, drive_reads = ReadBudget(), ReadBudget()
    # The existing sixty-second eventual-consistency allowance is shared by
    # the run, not multiplied by the number of historical recordings.
    remote_deadline = None
    remote_exhausted = False
    def verification_order(item):
        sid, rec = item
        prior = manifest['sessions'].get(sid,{})
        publication = prior.get('publication',{})
        verified = publication.get('status') == 'verified'
        # Deferred rows have no new attempt timestamp. They get the next turn
        # before a repeatedly failing old recording can consume another budget.
        last = (publication.get('verified_at','') if verified else
                prior.get('last_readback_attempt_at', publication.get('attempted_at','')))
        return (verified, last, rec['date'], sid)
    ordered = sorted(state['exported'].items(), key=verification_order if check_library else lambda x:x[1]['date'])
    for sid,rec in ordered:
        code=(rec.get('course') or '').replace(' ','').rstrip('E')
        if code not in courses:
            continue
        previous = manifest['sessions'].get(sid,{})
        record = previous.copy()
        if previous.get('publication', {}).get('status') == 'verified':
            record['previous_verified_publication'] = previous['publication'].copy()
        record['publication'] = {'status':'pending','reason':'current readback not attempted'}
        record['stages'] = {k: {'status':'not_attempted'} for k in
                            ('source', 'local_import', 'drive_copy', 'remote_readback')}
        stage = 'source'
        try:
            raw=read_text(MEETINGS/rec['path'], local_reads)
            record['stages']['source']={'status':'ok'}
            stage = 'local_import'
            text,check=render(rec,sid,raw)
            ccode=COLLECT_CODES.get(code,code)
            name=f"{ccode}_Cluely_{rec['date']}_{sid}_transcript.txt"
            dest=SUITE/'collect'/ccode/'text'/name
            changed=not dest.exists() or read_text(dest, local_reads)!=text
            record={**record,'course':code,'date':rec['date'],'raw_path':rec['path'],
                    'source_sha256':digest(raw),'sha256':digest(text),'text_path':str(dest),
                    'verification':check,'error':None}
            if changed:
                record['imported_at']=now()
                record['publication']={'status':'pending','reason':'new or changed lecture bytes'}
            if not dry:
                if changed: atomic(dest,text)
                # Reuse the existing queue format. The collector owns flushing.
                pending=SUITE/'collect/.pending-upload.json'
                q=read(pending,{'files':[]})
                if changed:
                    for e in q['files']:
                        if e['text']==str(dest):
                            e.update(attempts=0,last_error=None,queued_at=now())
                if changed and not any(e['text']==str(dest) for e in q['files']):
                    q['files'].append({'course':ccode,'text':str(dest),'title':f"Cluely lecture {rec['date']}",
                        'queued_at':now(),'attempts':0,'last_error':None})
                if changed:
                    atomic(pending,json.dumps(q,indent=2))
                record['stages']['local_import']={'status':'copied' if changed else 'unchanged'}
                if publish:
                    stage = 'drive_copy'
                    try:
                        if not DRIVE.is_dir(): raise ValueError('Drive desktop mount unavailable')
                        label=re.sub(r'([A-Z]+)(\d+)',r'\1 \2',code)
                        drive_path=DRIVE/label/'07 - Dailies & Class Notes'/name
                        drive_changed=not drive_path.exists() or read_text(drive_path, drive_reads)!=text
                        if drive_changed:
                            atomic(drive_path,text)
                        record['drive_path']=str(drive_path)
                        # A copied file is not a remotely verified publication.
                        if record.get('publication',{}).get('sha256') != digest(text):
                            record['publication']={'status':'pending','reason':'awaiting GPT File Library readback'}
                        record['stages']['drive_copy']={'status':'copied' if drive_changed else 'unchanged'}
                    except (OSError, ValueError) as exc:
                        record['stages']['drive_copy']={'status':'failed','reason':str(exc)}
                        errors.append(f'{code} {sid}: Drive copy unavailable: {exc}')
                        record['error']=str(exc)
                # An unreadable Drive mount does not prevent independent remote
                # readback of the exact, locally verified transcript.
                if check_library:
                    stage = 'remote_readback'
                    if remote_deadline is None:
                        remote_deadline = time.monotonic() + 60
                    if time.monotonic() >= remote_deadline:
                        if not remote_exhausted:
                            errors.append('GPT File Library run verification budget exhausted; remaining readbacks deferred')
                        remote_exhausted = True
                        record['publication']={'status':'pending','reason':'run verification budget exhausted'}
                        record['stages']['remote_readback']={'status':'deferred','reason':'run verification budget exhausted'}
                    else:
                        record['last_readback_attempt_at']=now()
                        record['publication']=verify_library(cfg,code,name,text,
                            doc_id=previous.get('publication',{}).get('doc_id'), deadline=remote_deadline)
                        record['stages']['remote_readback']={'status':'verified'}
                manifest['sessions'][sid]=record
                atomic(MANIFEST,json.dumps(manifest,indent=2))
            print(f"{code} {rec['date']} {sid}: {'would import' if dry else 'imported' if changed else 'unchanged'}")
        except Exception as exc:
            record['stages'][stage]={'status':'failed','reason':str(exc)}
            errors.append(f'{code} {sid}: {exc}')
            if not dry:
                manifest['sessions'][sid]={**record,'course':code,'date':rec['date'],
                    'error':str(exc),'publication':{'status':'failed','attempted_at':now(),'reason':str(exc)}}
            print(errors[-1])
    for code in COURSES:
        ccode=COLLECT_CODES.get(code,code)
        if code in courses and not dry:
            built=bundle.build(ccode)
        else: built=[]
        sessions=[dict(r,session_id=sid) for sid,r in manifest['sessions'].items() if r.get('course')==code]
        imported=sorted([r for r in sessions if r.get('imported_at')],key=lambda r:r['date'])
        raw=sorted([r for r in raw_sessions if r.get('course')==code],key=lambda r:r['created'])
        bundles=list((SUITE/'collect'/ccode/'bundles').glob('*.txt'))
        rows=[r for r in sessions if r.get('publication',{}).get('status')!='verified']
        missing=[r['sid'] for r in raw if not r.get('ongoing') and r['sid'] not in manifest['sessions']]
        knowledge = read(SUITE/'collect/.bundle-publication.json',{}).get(ccode,{})
        transcript_bundle = SUITE/'collect'/ccode/'bundles'/f'{ccode}_Transcripts.txt'
        knowledge_current = (transcript_bundle.exists() and
            knowledge.get('digests',{}).get(transcript_bundle.name) == bundle.digest(str(transcript_bundle)))
        reasons=[]
        if imported and not knowledge_current: reasons.append('GPT Knowledge transcript bundle publication unconfirmed')
        if knowledge_current and knowledge.get('retrieval') == 'failed':
            reasons.append('GPT Knowledge bundle published but retrieval failed')
        if knowledge_current and knowledge.get('retrieval') == 'partial':
            reasons.append('GPT Knowledge bundle published; retrieval only partially verified (use File Library for missing passages)')
        if not observed.get('observed_at'): reasons.append('raw source not checked')
        elif (datetime.now(timezone.utc)-datetime.fromisoformat(observed['observed_at'].replace('Z','+00:00'))).total_seconds()>36*3600:
            reasons.append('raw source observation older than 36 hours')
        if observed.get('source_automation',{}).get('status') == 'blocked':
            reasons.append(observed['source_automation']['reason'])
        if missing: reasons.append('recorded lectures not imported')
        if rows: reasons.append('lecture publication unverified or failed')
        if raw and raw[-1].get('ongoing'): reasons.append('newest recording in progress')
        if not raw: reasons.append('no raw record observed; absence not established')
        manifest['courses'][code]={
            'newest_raw_cluely_record':raw[-1] if raw else None,
            'raw_observed_at':observed.get('observed_at'),
            'newest_imported_lecture':{k:imported[-1].get(k) for k in ['session_id','date','imported_at']} if imported else None,
            'newest_bundle_generation_time':datetime.fromtimestamp(max(p.stat().st_mtime for p in bundles),timezone.utc).isoformat() if bundles else None,
            'publication': {'file_library':'failed' if any(r.get('error') for r in sessions) else 'pending' if rows or missing else 'verified' if imported else 'unknown',
                'gpt_knowledge':'publication_confirmed' if knowledge_current else 'pending' if transcript_bundle.exists() else 'unknown'},
            'gpt_knowledge':knowledge,
            'state':'stale' if reasons else 'current','errors':reasons,'missing_session_ids':missing,
            'lecture_count':len(imported),'verified_library_count':sum(r.get('publication',{}).get('status')=='verified' for r in sessions)}
    manifest['read_probes']={'local_recovered':local_reads.recovered,'drive_recovered':drive_reads.recovered,
        'local_circuit_open':local_reads.open,'drive_circuit_open':drive_reads.open,
        'remote_budget_exhausted':remote_exhausted}
    manifest['updated_at']=now()
    if not dry: atomic(MANIFEST,json.dumps(manifest,indent=2))
    return 1 if errors else 0


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--course',choices=COURSES,action='append')
    p.add_argument('--dry-run',action='store_true')
    p.add_argument('--publish',action='store_true',help='copy verified transcripts to existing Drive destination')
    p.add_argument('--verify-library',action='store_true',help='read exact bytes through GPT Action destination')
    a=p.parse_args()
    if a.dry_run:
        return sync(a.course or COURSES,True,a.publish,a.verify_library)
    # The hourly uploader and this daily import share bundle/queue state.
    # Serialize both owners, including the entire publication/readback window.
    lock_path = SUITE/'collect/.material-run.lock'
    with lock_path.open('a') as lock:
        try:
            fcntl.flock(lock,fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('lecture materials deferred: material collector is active')
            return 2
        return sync(a.course or COURSES,False,a.publish,a.verify_library)

if __name__=='__main__': sys.exit(main())
