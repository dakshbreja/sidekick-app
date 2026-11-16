#!/bin/bash
# Daily: export new Cluely class sessions, then push each course's newest
# class note to the GPT status bridge so the ChatGPT GPTs open with it.
#
# Writes a log per run and a machine-readable status file that Claude reads
# at the start of a session to report what worked and what didn't.

# Re-exec under caffeinate once, before doing anything else. This Mac sleeps in
# Maintenance Sleep / DarkWake cycles roughly every minute (30 sleep events on
# 3 Sep alone). A run interrupted that way leaves the Cluely app and Chrome
# unresponsive and the job blocks on AppleScript indefinitely; launchd also fires
# calendar jobs during DarkWake, where there is no usable GUI session to drive.
#   -u  assert user activity, promoting a DarkWake to a full wake
#   -i  no idle sleep for the duration    -s  no system sleep on AC
# The guard variable stops this recursing. caffeinate cannot WAKE a sleeping Mac
# at the scheduled time — only `sudo pmset repeat` does that.
if [ -z "${CLUELY_CAFFEINATED:-}" ]; then
  export CLUELY_CAFFEINATED=1
  exec /usr/bin/caffeinate -u -i -s "$0" "$@"
fi

BIN="$HOME/Claude/school-system-suite/meetings/bin"
LOGDIR="$HOME/Claude/school-system-suite/meetings/logs"
STATUS="$HOME/Claude/school-system-suite/meetings/.last-run.json"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/daily-$(date +%Y-%m-%d).log"

note() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

stage_clubs="skipped"; stage_materials="skipped"; stage_launch="skipped"; stage_export="skipped"; stage_push="skipped"; stage_drive="skipped"; fail=""; defer=""

exported=0; export_failed=0; drive_copied=0; pushed=0
export_outcome="not_run"; drive_outcome="not_run"; push_outcome="not_run"

python3 "$BIN/daily_stage.py" start "$STATUS" || exit 1
trap 'rc=$?; python3 "$BIN/daily_stage.py" interrupt "$STATUS" "$rc"' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
run_stage() { local name="$1" seconds="$2"; shift 2; python3 "$BIN/daily_stage.py" run "$STATUS" "$name" "$seconds" "$@"; }
note "=== daily run start ==="

run_stage launch 120 "$BIN/launch-cluely.sh" >>"$LOG" 2>&1; launch_rc=$?
if [ "$launch_rc" -eq 0 ]; then
  stage_launch="ok"; note "cluely: export connection ready (idle-only recovery enabled)"
elif [ "$launch_rc" -eq 2 ]; then
  stage_launch="deferred"; defer="Recording active or live state unavailable; Cluely was left untouched."
  note "cluely: DEFERRED by recording guard"
else
  stage_launch="failed"; fail="Cluely export connection recovery failed"
  note "cluely: FAILED to expose export connection"
fi

if [ "$stage_launch" = "ok" ]; then
  EXPORTOUT=$(mktemp)
  run_stage export 960 /opt/anaconda3/bin/python3 "$BIN/cluely_export.py" >"$EXPORTOUT" 2>&1; export_rc=$?
  cat "$EXPORTOUT" >>"$LOG"
  python3 "$BIN/daily_stage.py" classify "$STATUS" export < "$EXPORTOUT"
  exported=$(grep -c '^exported ' "$EXPORTOUT" || true)
  export_failed=$(grep -c '^FAILED ' "$EXPORTOUT" || true)
  review_count=$(sed -n 's/^ROUTING REVIEW: \([0-9]*\) .*/\1/p' "$EXPORTOUT" | tail -1)
  export_detail="${exported:-0} recordings refreshed; ${export_failed:-0} recording errors; ${review_count:-0} awaiting review"
  rm -f "$EXPORTOUT"
  if [ "$export_rc" -eq 0 ]; then
    stage_export="ok"; export_outcome="completed"
    [ "${exported:-0}" -eq 0 ] && export_outcome="no_work"
    note "export: $export_detail"
  elif [ "$export_rc" -eq 3 ]; then
    stage_export="deferred"; export_outcome="deferred"; defer="Unclassified recordings need content review; see meetings/.routing-review.json"
    note "export: DEFERRED — recordings need content review"
  else
    stage_export="failed"; export_outcome="failed"
    if [ "${export_failed:-0}" -gt 0 ]; then
      fail="Cluely export incomplete: $export_detail"
    else
      fail="Cluely export failed before a complete result; inspect the run log"
    fi
    note "export: INCOMPLETE — $export_detail"
  fi
fi

# Copy notes into Google Drive (via the desktop mount, so this works headless).
DRIVEOUT=$(mktemp)
run_stage drive 180 python3 "$BIN/sync_drive.py" >"$DRIVEOUT" 2>&1; drive_rc=$?
cat "$DRIVEOUT" >>"$LOG"
python3 "$BIN/daily_stage.py" classify "$STATUS" drive < "$DRIVEOUT"
drive_copied=$(sed -n 's/^drive sync: \([0-9]*\) copied, .*/\1/p' "$DRIVEOUT" | tail -1)
rm -f "$DRIVEOUT"
if [ "$drive_rc" -eq 0 ] && [ -n "$drive_copied" ]; then
  stage_drive="ok"; drive_outcome="copied"
  [ "$drive_copied" -eq 0 ] && drive_outcome="no_work"
  note "drive sync: $drive_copied copied (remote readback not checked by this step)"
else
  stage_drive="failed"; drive_outcome="failed"; fail="${fail:+$fail; }Google Drive sync failed or result missing"; note "drive sync: FAILED"
fi

# Push whatever is on disk even if the export failed - stale notes beat none.
# Exit 2 is the "daily KV write quota is spent" case: the notes are safe on disk
# and nothing was marked as pushed, so the next run delivers them untouched. That
# is a wait, not a fault, and saying "failed" for it trains him to ignore the alert.
PUSHOUT=$(mktemp)
run_stage push 600 python3 "$BIN/push_notes.py" >"$PUSHOUT" 2>&1; push_rc=$?
cat "$PUSHOUT" >>"$LOG"
python3 "$BIN/daily_stage.py" classify "$STATUS" push < "$PUSHOUT"

# push_notes.py context-checks every summary against its own transcript before
# sending it. Cluely records whatever it can hear, so a session can carry audio
# from something else entirely, and its summariser sometimes asserts things the
# transcript never contained. Both have already reached the GPTs. When the check
# trims something, say so here - silently cleaned notes teach him the recorder is
# fine when it is not.
checks=$(grep -c 'CHECK' "$PUSHOUT" 2>/dev/null | tr -d ' ')
held=$(grep -c 'HELD' "$PUSHOUT" 2>/dev/null | tr -d ' ')
dropped=$(sed -n 's/.*dropped \([0-9]*\) unverifiable.*/\1/p' "$PUSHOUT" | awk '{s+=$1} END {print s+0}')
pushed=$(grep -c ' pushed ' "$PUSHOUT" || true)
rm -f "$PUSHOUT"
[ "${checks:-0}" -gt 0 ] && note "context check: ${dropped} unverifiable item(s) trimmed, ${held} session(s) held"

if [ "$push_rc" -eq 0 ]; then
  stage_push="ok"; push_outcome="completed"
  [ "${pushed:-0}" -eq 0 ] && push_outcome="no_work"
  note "push to bridge: ${pushed:-0} notes pushed; no fresh readback claimed"
elif [ "$push_rc" -eq 2 ]; then
  stage_push="deferred"; push_outcome="deferred"
  defer="GPT bridge write quota spent - notes are safe on disk and go out after 8pm ET"
  note "push to bridge: DEFERRED (KV write quota)"
else
  stage_push="failed"; push_outcome="failed"; fail="${fail:+$fail; }push to GPT bridge failed"; note "push to bridge: FAILED"
fi

# Import verified lecture transcripts into the existing bundle/Drive pipeline.
# Readback through the same Action endpoint used by GPTs determines success.
MATERIALOUT=$(mktemp)
run_stage materials 600 /opt/anaconda3/bin/python3 "$BIN/lecture_sync.py" --publish --verify-library >"$MATERIALOUT" 2>&1; materials_rc=$?
cat "$MATERIALOUT" >>"$LOG"
python3 "$BIN/daily_stage.py" classify "$STATUS" materials < "$MATERIALOUT"
rm -f "$MATERIALOUT"
if [ "$materials_rc" -eq 0 ]; then
  stage_materials="ok"; note "lecture materials: completed; per-session import/copy/readback evidence is in .lecture-sync.json"
elif [ "$materials_rc" -eq 2 ]; then
  stage_materials="deferred"; defer="Material collector active; lecture delivery retained for the next run"
  note "lecture materials: DEFERRED by collector lock"
else
  stage_materials="failed"; fail="${fail:+$fail; }lecture import or GPT File Library verification failed"
  note "lecture materials: FAILED (see per-session reason above)"
fi

# Reuse this schedule for clubs; no second collector or independent timer.
CLUBOUT=$(mktemp)
run_stage clubs 300 /opt/anaconda3/bin/python3 "$BIN/club_sync.py" --publish >"$CLUBOUT" 2>&1; clubs_rc=$?
cat "$CLUBOUT" >>"$LOG"
python3 "$BIN/daily_stage.py" classify "$STATUS" clubs < "$CLUBOUT"
rm -f "$CLUBOUT"
if [ "$clubs_rc" -eq 0 ]; then
  stage_clubs="ok"
else
  stage_clubs="failed"; fail="${fail:+$fail; }club transcript publication failed"
fi

if [ "$stage_push" = "ok" ] && [ "$stage_launch" = "ok" ] && [ "$stage_export" = "ok" ] && [ "$stage_drive" = "ok" ] && [ "$stage_materials" = "ok" ] && [ "$stage_clubs" = "ok" ]; then
  overall="ok"; msg="Sync checks completed: ${exported:-0} recordings refreshed, ${drive_copied:-0} notes copied, ${pushed:-0} notes pushed. Zero counts mean no new work, not fresh delivery. Per-session readback is recorded separately; Knowledge uploads remain queued."
  [ "${dropped:-0}" -gt 0 ] && msg="$msg Context check trimmed ${dropped} unverifiable item(s) - see the log."
elif { [ "$stage_push" = "deferred" ] || [ "$stage_launch" = "deferred" ] || [ "$stage_export" = "deferred" ] || [ "$stage_materials" = "deferred" ]; } && [ -z "$fail" ]; then
  overall="deferred"; msg="Sync deferred: ${defer}. ${drive_copied:-0} notes copied; remote delivery is not implied."
else
  overall="failed"; msg="Sync incomplete: ${fail}. See $LOG"
fi

python3 "$BIN/daily_stage.py" finish "$STATUS" <<JSON
{
  "ran_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "ran_at_local": "$(date '+%a %b %d %-I:%M %p')",
  "overall": "$overall",
  "stages": {"launch": "$stage_launch", "export": "$stage_export", "drive": "$stage_drive", "push": "$stage_push", "materials": "$stage_materials", "clubs": "$stage_clubs"},
  "stage_details": {"export": {"outcome": "$export_outcome", "refreshed": ${exported:-0}}, "drive": {"outcome": "$drive_outcome", "copied": ${drive_copied:-0}, "remote_readback": "not_checked"}, "push": {"outcome": "$push_outcome", "pushed": ${pushed:-0}, "remote_readback": "not_checked"}},
  "context_check": {"trimmed": ${dropped:-0}, "held": ${held:-0}},
  "message": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$msg"),
  "log": "$LOG"
}
JSON

python3 "$BIN/../../bridge/scripts/notify_incident.py" --source cluely --status-file "$STATUS" --title "Cluely sync" || note "notification state unavailable"
note "=== done: $overall ==="
[ "$overall" = "ok" ]
