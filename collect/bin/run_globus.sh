#!/usr/bin/env bash
# launchd entry point for the GLO-BUS watcher. Same shape as run_daily.sh: launchd
# starts with a near-empty PATH, so the interpreter is pinned here in one place.
set -uo pipefail
PY=/opt/anaconda3/bin/python3
[[ -x "$PY" ]] || PY=/usr/bin/python3
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="/opt/anaconda3/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# caffeinate: this Mac sleeps in Maintenance Sleep / DarkWake cycles roughly every
# minute, and a run interrupted that way leaves Chrome unresponsive and the job
# blocked on AppleScript indefinitely. -u asserts user activity (promoting a
# DarkWake to a full wake, which the browser-driving steps need), -i and -s hold
# it awake for the duration. It cannot wake a sleeping Mac at the scheduled time;
# only `sudo pmset repeat` does that.
exec /usr/bin/caffeinate -u -i -s "$PY" "$HERE/globus_watch.py" "$@"
