#!/bin/bash
# Automatic idle-only recovery. The old --restart-idle argument is deliberately
# not a bypass: every invocation now performs the same live recording checks.
set -u
BIN="$(cd "$(dirname "$0")" && pwd)"
exec /usr/bin/python3 "$BIN/cluely_launch.py"
