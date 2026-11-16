#!/usr/bin/env python3
"""Validate an explicit local source baseline without displaying secret values.

The index, not the working copy, owns what a commit will store. Runtime state and
credentials cannot enter this repository merely through `git add -f`.
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath

POLICY = 'engineering/source-policy.json'
FORBIDDEN = {'grades-remote', 'node_modules', '.wrangler', '.backups', '.claude',
             '.gcal', '__pycache__', 'logs', 'reports', 'work', '.engineering-state',
             'Classes', 'Clubs', 'Other', 'Review', 'manual', 'models', 'gpt-backups'}


def safe_path(name):
    p = PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts or any(c in name for c in '\n\r\0\\'):
        return False
    if any(part in FORBIDDEN for part in p.parts):
        return False
    if any(part.startswith('.') for part in p.parts) and name not in ('.gitignore', 'bridge/.env.example'):
        return False
    return p.suffix not in {'.log', '.pdf', '.xlsx', '.csv', '.mp3', '.mp4', '.zip', '.pem', '.key', '.bundle'}


def secret_reasons(data, known=()):
    text = data.decode('utf-8', errors='replace')
    reasons = []
    if '\0' in text:
        reasons.append('binary file')
    if any(value and value in text for value in known):
        reasons.append('known local credential')
    patterns = {
        # Parsers and generated test keys mention PEM headers legitimately.
        # Reject embedded key material, rather than the header-removal code.
        'private key': r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[ \t]*(?:\r?\n|\\n)[A-Za-z0-9+/=]{32,}',
        'provider key': r'\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|AIza[A-Za-z0-9_-]{30,})\b',
        'private calendar URL': r'https?://[^\s"\']+/calendar/ical/[^\s"\']+/private-[A-Za-z0-9]+/',
        'OAuth credential': r'\b(?:ya29\.[A-Za-z0-9_-]{25,}|1//[A-Za-z0-9_-]{30,})',
    }
    for label, pattern in patterns.items():
        if re.search(pattern, text):
            reasons.append(label)
    return reasons


def local_secrets(repo):
    """Comparison only. These values are never serialized or copied elsewhere."""
    values = []
    for path in [repo/'bridge/.env', repo/'collect/.gcal/token.json',
                 repo/'bridge/.gdrive-token.json', repo/'bridge/.gdrive-service-account.json']:
        if not path.exists():
            continue  # Source-only checkouts intentionally have no credentials.
        if path.stat().st_size > 1024 * 1024:
            raise ValueError('credential comparison unavailable')
        if path.suffix == '.json':
            obj = json.loads(path.read_text())
            values.extend(str(v) for k, v in obj.items()
                          if k in {'private_key', 'access_token', 'refresh_token', 'client_secret'})
        else:
            for line in path.read_text().splitlines():
                if '=' in line and not line.lstrip().startswith('#'):
                    key, value = line.split('=', 1)
                    if any(word in key.upper() for word in ('KEY', 'TOKEN', 'SECRET', 'ICAL', 'ICS')):
                        values.append(value.strip().strip('"\''))
    return [value for value in values if len(value) >= 16]


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])


def audit(repo, staged=False):
    policy_data = git(repo, 'show', ':' + POLICY) if staged else (repo/POLICY).read_bytes()
    policy = json.loads(policy_data)
    allowed = policy.get('files')
    if policy.get('version') != 1 or not isinstance(allowed, list) or any(not isinstance(n, str) for n in allowed):
        raise ValueError('invalid source policy')
    if len(set(allowed)) != len(allowed) or any(not safe_path(n) for n in allowed):
        raise ValueError('unsafe source policy')
    known = local_secrets(repo)
    if staged:
        entries = []
        for entry in git(repo, 'ls-files', '--stage', '-z').split(b'\0'):
            if not entry:
                continue
            metadata, name = entry.split(b'\t', 1)
            mode, oid, stage = metadata.decode().split()
            entries.append((name.decode(), mode, oid, stage))
    else:
        entries = [(name, None, None, None) for name in allowed]
    findings = []
    for name, mode, oid, stage in entries:
        if name not in allowed or not safe_path(name):
            findings.append((name, 'outside source allowlist'))
            continue
        if staged and (mode not in {'100644', '100755'} or stage != '0'):
            findings.append((name, 'symlink, nested repository, or unresolved index'))
            continue
        path = repo/name
        if not staged and (path.is_symlink() or not path.is_file()):
            findings.append((name, 'missing or linked source'))
            continue
        data = git(repo, 'cat-file', 'blob', oid) if staged else path.read_bytes()
        if len(data) > 2 * 1024 * 1024:
            findings.append((name, 'oversized source'))
            continue
        findings.extend((name, reason) for reason in secret_reasons(data, known))
    return findings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--staged', action='store_true')
    args = parser.parse_args()
    try:
        findings = audit(args.repo.resolve(), args.staged)
    except (OSError, ValueError, subprocess.CalledProcessError):
        print('Source audit unavailable; commit blocked.', file=sys.stderr)
        return 2
    for name, reason in findings:
        print(json.dumps({'file': name, 'reason': reason}), file=sys.stderr)
    if findings:
        return 1
    print('Source allowlist and credential checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
