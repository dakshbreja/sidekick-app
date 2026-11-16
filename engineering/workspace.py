#!/usr/bin/env python3
"""Source-only worktrees and fail-closed command isolation for engineering.

Live collectors keep their current roots and permissions. This entrypoint never
copies their excluded state, credentials, downloads, or browser sessions.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT/'.engineering-state'


def call(*args, cwd=None):
    return subprocess.check_output(list(args), cwd=cwd, stderr=subprocess.PIPE, text=True).strip()


def create(name):
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', name):
        raise ValueError('use a short lowercase task name')
    parent = STATE/'worktrees'/name
    if parent.exists():
        raise ValueError('task already exists; reuse its checkout instead')
    roots = {'school-system-suite': ROOT, 'routines': ROOT.parent/'routines'}
    for source in roots.values():
        if call('git', 'status', '--porcelain', cwd=source):
            raise ValueError('commit or preserve tracked changes before creating a task')
        call('git', 'rev-parse', 'HEAD', cwd=source)
    parent.mkdir(parents=True, mode=0o700)
    created = []
    try:
        versions = {}
        for label, source in roots.items():
            dest = parent/label
            call('git', 'worktree', 'add', '-b', 'engineering/'+name, str(dest), 'HEAD', cwd=source)
            created.append((source, dest))
            versions[label] = {'source': str(source), 'checkout': str(dest),
                               'base_commit': call('git', 'rev-parse', 'HEAD', cwd=source)}
        receipt = {'version': 1, 'name': name, 'created_at': datetime.now(timezone.utc).isoformat(),
                   'repositories': versions, 'production_state_copied': False}
        (parent/'manifest.json').write_text(json.dumps(receipt, indent=2)+'\n')
        print(json.dumps(receipt, indent=2))
    except Exception:
        for source, dest in reversed(created):
            # These newly created checkouts have not been handed to a caller.
            subprocess.run(['git', '-C', str(source), 'worktree', 'remove', str(dest)], capture_output=True)
        raise


def validate_checkout(checkout):
    checkout = checkout.resolve()
    parent = checkout.parent
    expected = (STATE/'worktrees').resolve()
    if parent.parent != expected or checkout.name not in {'school-system-suite', 'routines'}:
        raise ValueError('only registered engineering checkouts can be executed')
    receipt = json.loads((parent/'manifest.json').read_text())
    row = receipt['repositories'][checkout.name]
    if receipt.get('version') != 1 or Path(row['checkout']).resolve() != checkout:
        raise ValueError('checkout receipt does not match')
    actual = Path(call('git', 'rev-parse', '--show-toplevel', cwd=checkout)).resolve()
    if actual != checkout:
        raise ValueError('checkout is not an independent worktree')
    return checkout, parent


def clean_environment(tmp):
    # Keep the user's HOME unchanged. Sandbox rules deny private home contents;
    # credentials and caller-controlled Python/Node injection variables are not inherited.
    env = {'PATH': '/opt/anaconda3/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
           'TMPDIR': str(tmp), 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1',
           'LANG': 'en_US.UTF-8', 'TZ': 'America/New_York',
           'XDG_CACHE_HOME': str(tmp/'cache')}
    if 'HOME' in os.environ:
        env['HOME'] = os.environ['HOME']
    return env


def seatbelt_profile(checkout, parent, tmp):
    reads = ['/System', '/usr', '/bin', '/sbin', '/Library/Developer',
             '/Library/Frameworks', '/opt/homebrew', '/opt/anaconda3',
             '/private/preboot', '/private/var/db/dyld', str(checkout), str(tmp),
             str(parent/('routines' if checkout.name == 'school-system-suite' else 'school-system-suite')),
             str(ROOT/'.git'), str(ROOT.parent/'routines/.git')]
    def subpaths(paths):
        return ' '.join('(subpath '+json.dumps(str(p))+')' for p in paths)
    return '\n'.join([
        '(version 1)', '(allow default)', '(deny file-read*)', '(deny file-write*)',
        '(allow file-read-metadata)',
        # dyld opens the root directory itself; allow enumeration, not root contents.
        '(allow file-read* (literal "/") '+subpaths(reads)+
        ' (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random")'+
        ' (literal "/dev/dtracehelper") (subpath "/dev/fd") (literal "/private/etc/localtime")'+
        ' (literal "/private/etc/apache2/mime.types"))',
        '(allow file-write* '+subpaths([checkout, tmp])+
        ' (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))',
        '(deny file-write* (literal '+json.dumps(str(checkout/'.git'))+') '+
        subpaths([checkout/'.codex', checkout/'.agents', ROOT/'.git', ROOT.parent/'routines/.git'])+')',
        '(deny file-read* (literal '+json.dumps(str(checkout/'.env'))+') '+
        '(literal '+json.dumps(str(checkout/'bridge/.env'))+') '+subpaths([checkout/'.aws'])+')',
        '(deny network*)', '(deny appleevent-send)',
        '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.SecurityServer"))',
    ])


def boundary_probe(checkout, parent, tmp, profile):
    """Do not execute the requested command if the real OS boundary is weaker."""
    with tempfile.NamedTemporaryFile(mode='w', prefix='boundary-', dir=parent, delete=False) as f:
        f.write('synthetic isolation canary\n')
        canary = Path(f.name)
    code = '''import errno,json,os,socket,sys
from pathlib import Path
checks={}
for label,path in [('outside_read',sys.argv[1])]:
 try:
  with open(path) as f:f.read(1)
  checks[label]=False
 except OSError as e:checks[label]=e.errno in (errno.EPERM,errno.EACCES)
for label,path in [('outside_write',sys.argv[1]),('production_source_write',sys.argv[2]),('git_metadata_write',sys.argv[3])]:
 try:
  fd=os.open(path,os.O_WRONLY);os.close(fd);checks[label]=False
 except OSError as e:checks[label]=e.errno in (errno.EPERM,errno.EACCES)
try:
 fd=os.open('/private/tmp/engineering-boundary-'+str(os.getpid()),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 os.close(fd);os.unlink('/private/tmp/engineering-boundary-'+str(os.getpid()));checks['shared_tmp_write']=False
except OSError as e:checks['shared_tmp_write']=e.errno in (errno.EPERM,errno.EACCES)
s=socket.socket();s.settimeout(2)
try:s.connect(('127.0.0.1',9));checks['network_connect']=False
except OSError as e:checks['network_connect']=e.errno in (errno.EPERM,errno.EACCES)
s.close()
p=Path(sys.argv[4])/'scratch-canary';p.write_text('synthetic');checks['scratch_write']=p.read_text()=='synthetic'
print(json.dumps(checks,sort_keys=True));sys.exit(0 if all(checks.values()) else 1)
'''
    try:
        source = ROOT/'bridge/src/status.js'
        argv = ['/usr/bin/sandbox-exec', '-p', profile, '/opt/anaconda3/bin/python3', '-c', code,
                str(canary), str(source), str(ROOT/'.git/config'), str(tmp)]
        result = subprocess.run(argv, cwd=checkout, env=clean_environment(tmp),
                                capture_output=True, text=True, timeout=15)
        checks = json.loads(result.stdout) if result.returncode == 0 else None
        if not checks or not all(checks.values()):
            raise ValueError('OS sandbox boundary probe failed')
        return checks
    finally:
        canary.unlink(missing_ok=True)


def run(checkout, command):
    checkout, parent = validate_checkout(checkout)
    if not Path('/usr/bin/sandbox-exec').is_file():
        raise ValueError('macOS sandbox unavailable; no unrestricted fallback')
    with tempfile.TemporaryDirectory(prefix='sandbox-', dir=parent) as scratch:
        tmp = Path(scratch)
        profile = seatbelt_profile(checkout, parent, tmp)
        checks = boundary_probe(checkout, parent, tmp, profile)
        with tempfile.NamedTemporaryFile(mode='w', dir=parent, delete=False) as f:
            f.write(json.dumps({
                'observed_at': datetime.now(timezone.utc).isoformat(), 'checks': checks,
                'scope': 'filesystem and network of sandboxed commands, not controller or GUI'}, indent=2)+'\n')
            receipt = Path(f.name)
        os.replace(receipt, parent/'boundary-check.json')
        argv = ['/usr/bin/sandbox-exec', '-p', profile, *command]
        # Child runtimes must see pipes, not inherited file descriptors for a log
        # outside the sandbox. The controller owns any caller-requested log file.
        with subprocess.Popen(argv, cwd=checkout, env=clean_environment(tmp),
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as child:
            for chunk in iter(lambda: child.stdout.read1(65536), b''):
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
            return child.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('create').add_argument('name')
    for action in ('run',):
        p = sub.add_parser(action)
        p.add_argument('checkout', type=Path)
        p.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    try:
        if args.action == 'create':
            create(args.name)
            return 0
        command = args.command
        if command and command[0] == '--':
            command = command[1:]
        if not command:
            raise ValueError('supply a command')
        return run(args.checkout, command)
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError):
        print('Engineering isolation unavailable or invalid; execution stopped. See engineering/README.md.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
