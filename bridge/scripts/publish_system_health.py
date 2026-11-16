#!/usr/bin/env python3
"""Publish metadata from existing school routine results, never run collectors.

Explicit fields and reason codes prevent logs, grade values, assignments, private
URLs and credentials from entering telemetry. File mtime is not proof a job ran.
"""
import argparse
import json
import os
from pathlib import Path
import sys
from datetime import datetime, timezone
import urllib.request
import urllib.error

IDS = ('elc-daily-sweep', 'globus-watch', 'cluely-gpt-sync', 'grade-check',
       'drive-sync-check', 'board-refresh', 'bridge-health')
MATERIAL_STAGES = {'extraction', 'drive', 'gpt_queue', 'library'}

def _queue_json(path):
    """Read only; never create a lock, repair a queue, or infer a run from mtime."""
    if not path.exists():
        return None
    if not path.is_file() or path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError('unreadable queue')
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError('unexpected queue shape')
    return value

def material_problem(state_path, state):
    """Return only safe health reasons, independently checking persistent queues.

    A clean latest report or an empty GPT queue cannot prove that extraction and
    Bridge readback succeeded. The delivery ledger owns those separate stages.
    Unknown/corrupt queues must never be represented as zero pending records.
    """
    health = state.get('material_health')
    if health is not None:
        if not isinstance(health, dict) or health.get('status') not in ('ok', 'pending', 'blocked'):
            return 'unreadable'
        if health['status'] == 'blocked':
            return 'partial'
        for key in ('gpt_pending', 'revision_deferred'):
            if key in health and (not isinstance(health[key], int) or isinstance(health[key], bool) or health[key] < 0):
                return 'unreadable'
        delivery = health.get('delivery', {})
        if not isinstance(delivery, dict):
            return 'unreadable'
        if 'pending' in delivery and (not isinstance(delivery['pending'], int)
                                      or isinstance(delivery['pending'], bool) or delivery['pending'] < 0):
            return 'unreadable'
    pending = False
    try:
        delivery = _queue_json(state_path.parent / '.material-delivery.json')
        if delivery is not None:
            if delivery.get('version') != 1 or not isinstance(delivery.get('entries'), dict):
                return 'unreadable'
            for entry in delivery['entries'].values():
                if not isinstance(entry, dict) or entry.get('status') not in ('pending', 'complete'):
                    return 'unreadable'
                stages = entry.get('stages')
                if not isinstance(stages, dict) or set(stages) != MATERIAL_STAGES:
                    return 'unreadable'
                if any(not isinstance(stage, dict) or stage.get('status') not in ('pending', 'running', 'done')
                       for stage in stages.values()):
                    return 'unreadable'
                # A corrupt optimistic aggregate cannot hide one incomplete stage.
                pending |= entry['status'] != 'complete' or any(stage['status'] != 'done' for stage in stages.values())
        gpt = _queue_json(state_path.parent / '.pending-upload.json')
        if gpt is not None:
            if not isinstance(gpt.get('files'), list) or any(not isinstance(entry, dict)
                    or not isinstance(entry.get('course'), str) or not isinstance(entry.get('text'), str)
                    for entry in gpt['files']):
                return 'unreadable'
            # Missing source files, retry cooldowns and formerly exhausted retries
            # all remain owed work. No error/title/path is copied into telemetry.
            pending |= bool(gpt['files'])
    except (ValueError, OSError):
        return 'unreadable'
    if health and (health['status'] == 'pending' or health.get('gpt_pending', 0)
                   or health.get('revision_deferred', 0) or health.get('delivery', {}).get('pending', 0)):
        pending = True
    return 'deferred' if pending else None

def stamp(value):
    try:
        if isinstance(value, (int, float)):
            d = datetime.fromtimestamp(value, timezone.utc)
        else:
            d = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
            if d.tzinfo is None:
                return None
        return d.astimezone(timezone.utc).isoformat(timespec='seconds')
    except (ValueError, TypeError, OSError, OverflowError):
        return None

def read_result(routine, loaded=None):
    result = dict(id=routine['id'], outcome='unknown', reason='missing',
                  last_attempt_at=None, last_success_at=None, loaded=loaded)
    path = Path(os.path.expandvars(routine.get('status_file', ''))).expanduser()
    if not path.is_file():
        return result
    try:
        if path.stat().st_size > 4 * 1024 * 1024:
            raise ValueError('oversized state')
        d = json.loads(path.read_text())
        if not isinstance(d, dict):
            raise ValueError('unexpected shape')
    except (ValueError, OSError):
        result['reason'] = 'unreadable'
        return result
    rid = routine['id']
    if rid == 'elc-daily-sweep':
        success = stamp(d.get('last_success_epoch'))
        attempts = [stamp(d.get(key)) for key in ('last_attempt_epoch', 'last_material_attempt_epoch')]
        attempted = max((value for value in attempts if value), default=None)
        result.update(last_attempt_at=attempted or success, last_success_at=success,
                      outcome='healthy' if success else 'unknown', reason='ok' if success else 'missing')
        # The collector records first session failure, not every retry. Label the
        # actual observation rather than making the upload time a new attempt.
        dead = stamp(d.get('session_dead_since'))
        if dead:
            result.update(outcome='degraded', reason='session', last_attempt_at=attempted or dead)
        report = Path(os.path.expandvars(routine.get('report', ''))).expanduser()
        if not dead and report.is_file() and success:
            # A successful sweep marker is written before extraction/upload; its
            # report may still contain errors. Do not mistake that for full success.
            try:
                if report.stat().st_size < 1024 * 1024 and '## PROBLEMS' in report.read_text():
                    result.update(outcome='degraded', reason='report_problem', last_success_at=None)
            except OSError:
                result.update(outcome='unknown', reason='unreadable')
        problem = material_problem(path, d)
        if problem:
            # Preserve an observed session block as the primary user-facing cause,
            # while preventing its old listing timestamp from implying delivery.
            result.update(last_success_at=None)
            if not dead:
                result.update(outcome='unknown' if problem == 'unreadable' else 'degraded', reason=problem)
    elif rid == 'globus-watch':
        success = stamp(d.get('checked_epoch'))
        result.update(last_attempt_at=success, last_success_at=success,
                      outcome='healthy' if success else 'unknown', reason='ok' if success else 'missing')
        if d.get('calendar_health', {}).get('ok') is False:
            result.update(outcome='degraded', reason='calendar', last_success_at=None)
    else:
        at = stamp(d.get('ran_at') or d.get('at'))
        overall = str(d.get('overall', '')).lower()
        result['last_attempt_at'] = at
        if overall == 'ok':
            result.update(outcome='healthy', reason='ok', last_success_at=at)
        elif overall == 'deferred':
            result.update(outcome='degraded', reason='deferred')
        elif overall in ('problem', 'failed', 'degraded'):
            result.update(outcome='failed', reason='failed')
        if rid == 'grade-check':
            outcomes = [s.get('ok') for s in d.get('sources', {}).values() if isinstance(s, dict)]
            if False in outcomes and True in outcomes:
                result.update(outcome='degraded', reason='partial', last_success_at=None)
        if rid == 'drive-sync-check' and d.get('local_files') == 0 and d.get('cloud_files', 0) > 0:
            result.update(outcome='failed', reason='mount', last_success_at=None)
        # A partial stage cannot be hidden by an optimistic overall label.
        stages = d.get('stages', {})
        if isinstance(stages, dict) and any(s in ('failed', 'deferred') for s in stages.values()):
            result.update(outcome='degraded', reason='partial', last_success_at=None)
    return result

def collect(registry):
    rows = json.loads(Path(registry).read_text())['routines']
    checks = []
    for rid in IDS:
        r = next((r for r in rows if r['id'] == rid), None)
        if not r:
            checks.append(dict(id=rid, outcome='unknown', reason='missing', last_attempt_at=None, last_success_at=None, loaded=None))
            continue
        # A launchctl failure may reflect missing GUI access, not a stopped job.
        # Publish observed job outcomes only; schedule liveness stays unverified.
        checks.append(read_result(r))
    return {'checks': checks}

def config(path):
    values = {}
    for line in path.read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip().strip('\"').strip("'")
    return values

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--registry', type=Path, default=Path.home()/'Claude/routines/routines.json')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    payload = collect(args.registry)
    if args.dry_run:
        print(json.dumps(payload, indent=2))
        return 0
    c = config(args.root/'.env')
    req = urllib.request.Request(c['WORKER_URL'].rstrip('/') + '/system/health/report',
        data=json.dumps(payload).encode(), method='POST',
        headers={'Authorization': 'Bearer ' + c['API_KEY'], 'Content-Type': 'application/json',
                 'User-Agent': 'bridge-system-health/1.0', 'X-Bridge-Client': 'dashboard'})
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            answer = json.load(response)
        if answer.get('ok') is not True:
            raise ValueError('report not acknowledged')
        print('System health: published %d routine results.' % len(payload['checks']))
        return 0
    except urllib.error.HTTPError as error:
        print('System health report failed: HTTP %d.' % error.code, file=sys.stderr)
    except (OSError, ValueError):
        print('System health report failed: connection or response unavailable.', file=sys.stderr)
    return 1

if __name__ == '__main__':
    sys.exit(main())


