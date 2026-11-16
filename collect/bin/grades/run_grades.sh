#!/usr/bin/env bash
# launchd + routinectl entry point for the grade check.
#
# A shell wrapper, not the .py directly, because the two callers disagree: launchd
# runs `bash -lc "<program>"` (a command line) while `routinectl run` does
# `bash <program>` (a script path). Only a shell script satisfies both.
#
# Anaconda is named explicitly: launchd's PATH is near-empty, and this imports the
# repo's own modules rather than anything exotic, so the interpreter is the only
# thing that has to be pinned.
#
# caffeinate wraps the run because this Mac sleeps constantly — 30 sleep events on
# 3 Sep alone, in Maintenance Sleep / DarkWake cycles about a minute apart. Two
# things go wrong without it. A run that starts and then sleeps leaves Chrome
# unresponsive and the job blocks on AppleScript forever (a forced sweep sat for 21
# minutes on 0.86s of CPU). And launchd fires calendar jobs during DarkWake, where
# there is no usable GUI session for the adapters to drive.
#   -u  assert user activity, which promotes a DarkWake to a full wake
#   -i  no idle sleep for the duration
#   -s  no system sleep while on AC
# It does NOT wake a sleeping Mac at the scheduled time — only `sudo pmset repeat`
# can do that, and it needs a password this script must never ask for.

set -uo pipefail

PY=/opt/anaconda3/bin/python3
[[ -x "$PY" ]] || PY=/usr/bin/python3

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec /usr/bin/caffeinate -u -i -s "$PY" "$HERE/run.py" --quiet --publish --html "$HOME/Claude/school-system-suite/collect/reports/grades.html"
