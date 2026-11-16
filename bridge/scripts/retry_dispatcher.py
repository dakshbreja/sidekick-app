#!/usr/bin/env python3
"""Dispatch explicit bridge retry requests to existing launchd jobs, once.

This is not a collector. No shell command or argument comes from the network;
only an allowlisted launchd label can be started. launchd prevents a second
instance of a scheduled job. A lost result is retried locally, never reexecuted.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.request
import urllib.error
from publish_system_health import config, collect, stamp

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = Path.home() / 'Claude/routines/routines.json'
ALLOW = frozenset(('elc-daily-sweep','globus-watch','cluely-gpt-sync','grade-check',
                   'drive-sync-check','board-refresh','bridge-health'))
LOCAL = ROOT / '.retry-dispatch'


def api(settings, path, body):
    req = urllib.request.Request(settings['WORKER_URL'].rstrip('/') + path,
        data=json.dumps(body).encode(), method='POST', headers={
            'Authorization': 'Bearer '+settings['API_KEY'], 'Content-Type': 'application/json',
            'User-Agent': 'bridge-retry-dispatch/1.0'})
    with urllib.request.urlopen(req, timeout=25) as response:
        return json.load(response)


def job_status(target):
    r = subprocess.run(['/bin/launchctl','print',f'gui/{os.getuid()}/com.daksh.{target}'], capture_output=True, text=True, timeout=10)
    if r.returncode:
        return None
    pid = re.search(r'^\s*pid\s*=\s*(\d+)\s*$', r.stdout, re.M)
    code = re.search(r'^\s*last exit code\s*=\s*(-?\d+)\s*$', r.stdout, re.M)
    return {'pid': int(pid.group(1)) if pid else None, 'code': int(code.group(1)) if code else None}


def outcome(target, payload, started, exit_code):
    row = next((r for r in payload['checks'] if r['id'] == target), {})
    at = row.get('last_attempt_at')
    # Process exit zero is not evidence of fresh collection: several jobs skip.
    from datetime import datetime
    fresh = bool(at and datetime.fromisoformat(at.replace('Z','+00:00')).timestamp() >= started-2)
    if not fresh:
        return 'blocked'
    if exit_code not in (0, None):
        return 'failed'
    return 'succeeded' if row.get('outcome') == 'healthy' else 'attention'


def run_job(job, settings):
    target = job.get('target')
    if target not in ALLOW:
        return 'blocked'
    registered = {r['id'] for r in json.loads(REGISTRY.read_text())['routines']}
    status = job_status(target)
    if target not in registered or status is None or status['pid']:
        # Do not restart/kill a running collector or a recording.
        return 'blocked'
    started = time.time()
    result = subprocess.run(['/bin/launchctl','kickstart',f'gui/{os.getuid()}/com.daksh.{target}'],
                            capture_output=True, timeout=15)
    if result.returncode:
        return 'blocked'
    # The job itself owns its timeout. Never kill it when our receipt times out.
    time.sleep(2)
    status = job_status(target)
    while status and status['pid'] and time.time()-started < 30*60:
        time.sleep(5)
        status = job_status(target)
    if not status or status['pid']:
        return 'blocked'
    payload = collect(REGISTRY)
    if api(settings, '/system/health/report', payload).get('ok') is not True:
        return 'failed'
    return outcome(target, payload, started, status['code'])


def main():
    LOCAL.mkdir(mode=0o700, exist_ok=True)
    with (LOCAL/'lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        settings = config(ROOT/'.env')
        receipt = LOCAL/'pending.json'
        if receipt.exists():
            prior = json.loads(receipt.read_text())
            # A crash after claim must not silently run the job a second time.
            prior.setdefault('state','blocked')
            result = api(settings, '/system/retry/finish', prior)
            if not result.get('job'):
                raise RuntimeError('receipt_not_acknowledged')
            receipt.unlink()
        job = api(settings, '/system/retry/claim', {}).get('job')
        if not job:
            return
        receipt.write_text(json.dumps({'id':job['id']}))
        try:
            state = run_job(job,settings)
        except Exception:
            state = 'blocked'
        pending = {'id':job['id'],'state':state}
        temp=LOCAL/'pending.tmp';temp.write_text(json.dumps(pending));temp.replace(receipt)
        result=api(settings,'/system/retry/finish',pending)
        if result.get('job'):
            receipt.unlink()
        print('Explicit retry handled: '+job['target']+' — '+state, flush=True)


def failure_message(error, receipt_exists):
    # Only bounded categories/status codes: exception text may contain URLs/secrets.
    category = ('HTTP ' + str(error.code)) if isinstance(error, urllib.error.HTTPError) else (
        'network' if isinstance(error, urllib.error.URLError) else 'local operation')
    receipt = ('pending receipt retained; no job will be reexecuted' if receipt_exists
               else 'no pending local receipt')
    return f'Retry dispatcher unavailable ({category}); {receipt}.'


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Provider errors and credentials must never enter shared logs.
        print(failure_message(error, (LOCAL/'pending.json').exists()), flush=True)
        raise SystemExit(1)
