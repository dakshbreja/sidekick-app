#!/usr/bin/env python3
"""Run the offline regression groups through the enforced engineering boundary."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import workspace

SUITES = {
    'javascript': ['/opt/homebrew/bin/node', '--test', 'bridge/test/*.test.mjs'],
    'mcp': ['/opt/anaconda3/bin/python3', 'bridge/mcp/test_school_bridge_mcp.py'],
    'collectors': ['/opt/anaconda3/bin/python3', '-m', 'unittest', 'discover', '-s', 'collect/test'],
    'meetings': ['/opt/anaconda3/bin/python3', '-m', 'unittest', 'discover', '-s', 'meetings/test'],
    'bridge-python': ['/opt/anaconda3/bin/python3', '-m', 'unittest', 'discover', '-s', 'bridge/test'],
    'engineering': ['/opt/anaconda3/bin/python3', '-m', 'unittest', 'discover', '-s', 'engineering/test'],
}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('checkout', type=Path)
    p.add_argument('--suite', choices=list(SUITES), action='append')
    args = p.parse_args()
    try:
        checkout, parent = workspace.validate_checkout(args.checkout)
        if checkout.name != 'school-system-suite':
            raise ValueError('select the paired school suite checkout')
        logs = parent/'verification'
        logs.mkdir(mode=0o700, exist_ok=True)
        selected = args.suite or list(SUITES)
        results = []
        for name in selected:
            started = time.monotonic()
            log = logs/(name+'.log')
            fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as f:
                r = subprocess.run([sys.executable, str(workspace.ROOT/'engineering/workspace.py'),
                                    'run', str(checkout), '--', *SUITES[name]], stdout=f, stderr=subprocess.STDOUT)
            text = log.read_text(errors='replace')
            match = re.search(r'\btests (\d+)', text) if name == 'javascript' else re.search(r'Ran (\d+) tests?', text)
            count = int(match.group(1)) if match else 0
            passed = r.returncode == 0 and count > 0
            results.append({'suite': name, 'passed': passed, 'exit_code': r.returncode,
                            'test_count': count, 'duration_seconds': round(time.monotonic()-started, 3)})
            print(json.dumps(results[-1]), flush=True)
        source_files = subprocess.check_output(['git', '-C', str(checkout), 'ls-files', '-z']).decode().split('\0')
        hashes = {n: hashlib.sha256((checkout/n).read_bytes()).hexdigest() for n in source_files if n}
        receipt = {'version': 1, 'observed_at': datetime.now(timezone.utc).isoformat(),
                   'base_commit': workspace.call('git', 'rev-parse', 'HEAD', cwd=checkout),
                   'checkout': str(checkout), 'source_hashes': hashes,
                   'suites': results, 'total_tests': sum(r['test_count'] for r in results),
                   'passed': all(r['passed'] for r in results), 'scope': 'offline isolated tests, not live collector execution'}
        target = logs/'latest.json'
        target.write_text(json.dumps(receipt, indent=2)+'\n'); target.chmod(0o600)
        return 0 if receipt['passed'] else 1
    except (OSError, ValueError, subprocess.SubprocessError):
        print('Isolated verification unavailable; no success receipt claimed.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
