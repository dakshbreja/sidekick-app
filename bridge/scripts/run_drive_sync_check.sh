#!/usr/bin/env bash
# launchd + routinectl entry point for the Drive sync check.
#
# A shell wrapper rather than pointing the routine straight at the .py, because
# the two callers disagree: launchd runs `bash -lc "<program>"` (a command line)
# while `routinectl run` does `bash <program>` (a script path). A Python file only
# works under the first. A shell script works under both.
#
# The configured service account uses the existing Google Auth installation in
# the same runtime as the lecture job. Legacy OAuth-only installs need stdlib.

set -uo pipefail

PY=/usr/bin/python3
[[ -x "$PY" ]] || PY=/opt/anaconda3/bin/python3

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$HERE/../.gdrive-service-account.json" ]]; then
  PY=/opt/anaconda3/bin/python3
fi
exec "$PY" "$HERE/drive_sync_check.py" --recover "$@"
