"""Local incident notices; status files/logs remain the observation authority.

One state file is shared by existing routines. No scheduler or network is used.
Delivery failures do not advance the notification checkpoint. Corrupt state is
preserved for diagnosis and yields a visible warning, never a guessed recovery.
"""
import argparse
from datetime import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


DEFAULT_STATE = Path(__file__).resolve().parents[2] / '.notification-state.json'


def normalize(value):
    text = str(value)
    text = re.sub(r'https?://\S+', '<url>', text)
    text = re.sub(r'\b\d{4}-\d\d-\d\d(?:[T ][\d:.+Z-]+)?', '<time>', text)
    text = re.sub(r'\b[0-9a-f]{8}-[0-9a-f-]{27,}\b', '<id>', text, flags=re.I)
    text = re.sub(r'\b(?:session|request)[_-]?id[=: ]+\S+', '<id>', text, flags=re.I)
    text = re.sub(r'course=[A-Z]+\d+', 'course=<rotating>', text)
    return text


def incident_keys(observation):
    stages = observation.get('stages', {})
    keys = []
    if isinstance(stages, dict):
        keys += [f'stage:{name}:{value}' for name, value in stages.items()
                 if value in ('failed', 'deferred', 'unknown')]
    # Explicit stable keys are preferred; raw problems stay in the snapshot.
    problems = observation.get('incident_keys', observation.get('problems', []))
    if isinstance(problems, list):
        keys += [normalize(p) for p in problems if p]
    overall = observation.get('overall', 'unknown')
    if not keys and overall not in ('ok', 'success'):
        keys = [f'overall:{overall}']
    return sorted(set(keys))


def plan(previous, observation, today, invalid=False):
    keys = incident_keys(observation)
    old = previous.get('keys', []) if previous else []
    event = None
    if invalid:
        event = 'state_warning'
    elif keys and (previous is None or keys != old):
        event = 'failure'
    elif not keys and old:
        event = 'recovery'
    elif keys and previous.get('notified_day') != today:
        event = 'digest'
    # Store every raw observation even when no notice is warranted.
    current = {'keys': keys, 'observation': observation,
               'observed_at': datetime.now().astimezone().isoformat(),
               'notified_day': today if event else (previous or {}).get('notified_day')}
    return event, current


def atomic_write(path, value):
    fd, temp = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out, indent=2)
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def send_notice(title, message):
    # Arguments, not interpolated AppleScript: error text cannot execute code.
    script = ('on run argv\n display notification (item 2 of argv) '
              'with title (item 1 of argv)\nend run')
    subprocess.run(['/usr/bin/osascript', '-e', script, title, message],
                   check=True, timeout=20, capture_output=True)


def update(state_path, source, observation, title, sender=send_notice, today=None):
    state_path = Path(state_path)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    today = today or datetime.now().astimezone().date().isoformat()
    with open(str(state_path) + '.lock', 'a') as lock:
        deadline = time.monotonic() + 5
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError('notification state lock unavailable after 5 seconds')
                time.sleep(0.05)
        invalid = False
        try:
            raw = state_path.read_text()
            state = json.loads(raw)
            if (not isinstance(state, dict) or state.get('version') != 1
                    or not isinstance(state.get('sources'), dict)):
                raise ValueError('invalid notification state')
            for entry in state['sources'].values():
                if (not isinstance(entry, dict) or not isinstance(entry.get('keys'), list)
                        or any(not isinstance(key, str) for key in entry['keys'])
                        or not isinstance(entry.get('observation'), dict)
                        or (entry.get('notified_day') is not None
                            and not isinstance(entry['notified_day'], str))):
                    raise ValueError('invalid notification source')
        except FileNotFoundError:
            state = {'version': 1, 'sources': {}}
        except (ValueError, UnicodeError):
            # Exact bytes retained; the next valid checkpoint repairs only dedupe.
            fd, backup = tempfile.mkstemp(prefix=state_path.name + '.invalid.', dir=state_path.parent)
            with os.fdopen(fd, 'wb') as out:
                out.write(state_path.read_bytes())
                out.flush()
                os.fsync(out.fileno())
            state = {'version': 1, 'sources': {}}
            invalid = True
        event, current = plan(state['sources'].get(source), observation, today, invalid)
        if event:
            summary = str(observation.get('message') or ('Needs attention: ' + ', '.join(current['keys'])))
            message = {'failure': summary, 'digest': 'Still needs attention: ' + summary,
                       'recovery': 'Recovered: current checks completed successfully.',
                       'state_warning': 'Notification history was unreadable; check the current status. ' + summary}[event]
            sender(title, message)
        state['sources'][source] = current
        atomic_write(state_path, state)
        return event


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--status-file', type=Path, required=True)
    parser.add_argument('--title', required=True)
    parser.add_argument('--state-file', type=Path, default=DEFAULT_STATE)
    args = parser.parse_args()
    try:
        observation = json.loads(args.status_file.read_text())
        if not isinstance(observation, dict):
            raise ValueError('status must be an object')
    except (OSError, ValueError) as exc:
        observation = {'overall': 'unknown', 'problems': ['status unavailable'],
                       'message': 'Current status unavailable; see local logs.', 'error': str(exc)}
    try:
        event = update(args.state_file, args.source, observation, args.title)
        print(json.dumps({'notification': event or 'unchanged', 'source': args.source}))
    except Exception as exc:
        # State permissions/I/O or a rejected OS notice must not silently eat errors.
        print(f'Notification checkpoint failed: {type(exc).__name__}: {exc}', file=__import__('sys').stderr)
        try:
            send_notice(args.title, 'Notification history could not be updated; check local status/logs.')
        except Exception:
            pass
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
