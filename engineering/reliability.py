#!/usr/bin/env python3
"""Read existing operational evidence; never run or publish a collector.

Reuse the live health reader's safe field projection. Observation time, launchd
registration, attempts, and successful stage evidence remain separate facts.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT/'.engineering-state/reliability'
REGISTRY = ROOT.parent/'routines/routines.json'
IDS = ('elc-daily-sweep', 'globus-watch', 'cluely-gpt-sync', 'grade-check',
       'drive-sync-check', 'board-refresh', 'bridge-health')
OUTCOMES = {'healthy', 'degraded', 'failed', 'unknown'}
REASONS = {'ok', 'missing', 'unreadable', 'partial', 'deferred', 'session', 'calendar',
           'mount', 'failed', 'report_problem'}


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def epoch(value):
    if not isinstance(value, str):
        return None
    try:
        d = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return d.timestamp() if d.tzinfo else None
    except (ValueError, OverflowError):
        return None


def assess(raw, stale_after, now):
    """Validate and whitelist even the existing reader's result before storage."""
    outcome = raw.get('outcome') if raw.get('outcome') in OUTCOMES else 'unknown'
    reason = raw.get('reason') if raw.get('reason') in REASONS else 'unreadable'
    attempt, success = epoch(raw.get('last_attempt_at')), epoch(raw.get('last_success_at'))
    if attempt is not None and attempt > now + 300 or success is not None and success > now + 300:
        outcome, reason, attempt, success = 'unknown', 'future_timestamp', None, None
    if outcome == 'healthy' and (attempt is None or success is None):
        outcome, reason = 'unknown', 'missing_run_evidence'
    stale = attempt is None or now - attempt > stale_after
    if outcome == 'healthy' and stale:
        outcome, reason = 'stale', 'stale_run_evidence'
    return {'outcome': outcome, 'reason': reason, 'last_attempt_at':
            datetime.fromtimestamp(attempt, timezone.utc).isoformat() if attempt is not None else None,
            'last_success_at': datetime.fromtimestamp(success, timezone.utc).isoformat() if success is not None else None,
            'evidence_stale': stale, 'stale_after_seconds': stale_after}


def fingerprint(paths):
    return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None for p in paths}


def controls():
    # Hashes establish preservation; raw scheduler contents are never copied.
    paths = [REGISTRY]
    paths.extend(sorted((Path.home()/'Library/LaunchAgents').glob('com.daksh.*.plist')))
    paths.extend(sorted((Path.home()/'.codex/automations').glob('*/automation.toml')))
    return fingerprint(paths)


def scheduler(rid, accessible):
    if not accessible:
        return {'registration': 'unknown', 'process_running': None}
    result = subprocess.run(['launchctl', 'print', 'gui/%d/com.daksh.%s' % (os.getuid(), rid)],
                            capture_output=True, text=True, timeout=10)
    if result.returncode != 0:
        message = result.stderr.lower()
        status = 'not_loaded' if 'could not find service' in message else 'unknown'
        return {'registration': status, 'process_running': None}
    # A waiting job is normal. Registration is never presented as successful work.
    running = any(line.strip().startswith('pid = ') for line in result.stdout.splitlines())
    return {'registration': 'loaded', 'process_running': running}


def collect(registry=REGISTRY, now=None, inspect_scheduler=True):
    now = datetime.now(timezone.utc).timestamp() if now is None else now
    spec = importlib.util.spec_from_file_location('existing_health_reader', ROOT/'bridge/scripts/publish_system_health.py')
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    rows = json.loads(Path(registry).read_text())['routines']
    accessible = False
    if inspect_scheduler:
        try:
            accessible = subprocess.run(['launchctl', 'print', 'gui/%d' % os.getuid()],
                                        capture_output=True, timeout=10).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            pass
    checks = []
    for rid in IDS:
        row = next((r for r in rows if r.get('id') == rid), None)
        raw = reader.read_result(row) if row else {'outcome': 'unknown', 'reason': 'missing'}
        threshold = row.get('stale_after', 86400 if rid == 'cluely-gpt-sync' else 21600) if row else 21600
        if type(threshold) is not int or threshold <= 0:
            threshold = 21600
        check = {'id': rid, **assess(raw, threshold, now)}
        try:
            check.update(scheduler(rid, accessible))
        except (OSError, subprocess.TimeoutExpired):
            check.update(registration='unknown', process_running=None)
        checks.append(check)
    return checks


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as f:
        os.chmod(f.name, 0o600)
        f.write(json.dumps(data, indent=2)+'\n')
        f.flush(); os.fsync(f.fileno())
        temporary = Path(f.name)
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record', action='store_true', help='save safe observations only in ignored engineering state')
    parser.add_argument('--accept-configuration', action='store_true', help='explicitly establish/review scheduler hash baseline')
    args = parser.parse_args()
    try:
        checked = iso_now()
        current = controls()
        baseline_path = STATE/'configuration-baseline.json'
        if args.accept_configuration:
            atomic(baseline_path, {'observed_at': checked, 'hashes': current})
        previous = json.loads(baseline_path.read_text())['hashes'] if baseline_path.is_file() else None
        drift = sorted(p for p in set(current) | set(previous or {})
                       if current.get(p) != (previous or {}).get(p)) if previous is not None else None
        checks = collect()
        prior_path = STATE/'latest.json'
        prior = json.loads(prior_path.read_text()) if prior_path.is_file() else {}
        unchanged = {r['id']: (r.get('outcome'), r.get('reason'), r.get('registration')) for r in prior.get('checks', [])}
        changes = [r['id'] for r in checks if unchanged.get(r['id']) != (r['outcome'], r['reason'], r['registration'])]
        result = {'version': 1, 'observed_at': checked, 'checks': checks,
                  'configuration': {'baseline_present': previous is not None, 'changed_files': drift},
                  'changed_routine_states': changes,
                  'coverage': {'routine_ids': list(IDS), 'retired_and_financial_jobs_read': False,
                               'collectors_executed': False, 'external_requests': False,
                               'submission_or_learning_records_changed': False,
                               'continuous_uptime_established': False}}
        if args.record:
            atomic(prior_path, result)
            history = STATE/'observations.jsonl'
            fd = os.open(history, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            with os.fdopen(fd, 'w') as f:
                f.write(json.dumps(result, separators=(',', ':'))+'\n')
        print(json.dumps(result, indent=2))
        return 0 if previous is not None and not drift and all(r['outcome'] == 'healthy' and r['registration'] == 'loaded' for r in checks) else 1
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print('Reliability evidence unavailable; status is unknown.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
