#!/usr/bin/env bash
# launchd entry point for the daily eLC sweep.
#
# Kept as a shell wrapper so the interpreter and environment are pinned in one
# place: launchd runs with a near-empty PATH, so /opt/anaconda3 (which is where
# pypdf / python-pptx / olefile live) has to be named explicitly. /opt/homebrew/bin
# likewise - ffmpeg and whisper-cli live there on Apple Silicon, and leaving it out
# cost the MGMT 4280 ERP demo videos a day of "FileNotFoundError: 'ffmpeg'" while
# ffmpeg was installed the whole time. /usr/local/bin is the Intel brew prefix and
# does not cover it.

set -uo pipefail

PY=/opt/anaconda3/bin/python3
[[ -x "$PY" ]] || PY=/usr/bin/python3

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="/opt/anaconda3/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"


# caffeinate: this Mac sleeps in Maintenance Sleep / DarkWake cycles roughly every
# minute, and a run interrupted that way leaves Chrome unresponsive and the job
# blocked on AppleScript indefinitely. -u asserts user activity (promoting a
# DarkWake to a full wake, which the browser-driving steps need), -i and -s hold
# it awake for the duration. It cannot wake a sleeping Mac at the scheduled time;
# only `sudo pmset repeat` does that.
exec /usr/bin/caffeinate -u -i -s "$PY" "$HERE/elc_daily.py" "$@"
