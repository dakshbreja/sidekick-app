#!/bin/bash
# Is the bridge actually answering, and is what it answers usable?
#
# The GPTs call /status before they say anything, so a broken bridge is invisible
# from ChatGPT's side - it just quietly stops leading with deadlines. Twice now a
# real outage looked like normal operation: on 24 Aug the KV write quota ran out and
# every read kept working, so the GPTs answered as usual while every write failed.
# This checks the things that fail silently.
#
# Exit 0 = healthy, 1 = degraded (incident/digest policy), 2 = could not run.

set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ROOT="$HOME/Claude/school-system-suite/bridge"
LOG="$ROOT/logs/health-$(date +%Y-%m-%d).log"
STATUS="$ROOT/.health.json"
mkdir -p "$ROOT/logs"

note() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

[ -f "$ROOT/.env" ] || { note "no .env; cannot check"; exit 2; }
set -a; . "$ROOT/.env"; set +a
: "${WORKER_URL:?}" "${API_KEY:?}"

AUTH="Authorization: Bearer $API_KEY"
# Metadata publisher reads existing results only. Also runs after failed probes.
trap 'python3 "$ROOT/scripts/publish_system_health.py" --root "$ROOT" || note "system health report could not be published"' EXIT
problems=()

# Preserve the existing spaced probes while measuring the formatter-cache repair.
# Any failed first attempt remains a degraded observation even if its retry works.
GAP=15
probe() {  # probe METHOD PATH [DATA] -> sets P_CODE / P_BODY, retrying once
  local method="$1" path="$2" data="${3:-}" out code
  local -a args=(-s -m 25 -w '\n%{http_code}' -H "$AUTH" -H 'X-Bridge-Client: dashboard')
  [ "$method" = POST ] && args+=(-X POST -H 'Content-Type: application/json' -d "$data")
  out=$(curl "${args[@]}" "$WORKER_URL$path" 2>/dev/null)
  code=$(tail -1 <<< "$out")
  local first_code="$code"
  if [ "$code" != "200" ]; then
    sleep "$GAP"
    out=$(curl "${args[@]}" "$WORKER_URL$path" 2>/dev/null)
    code=$(tail -1 <<< "$out")
  fi
  P_CODE="$code"; P_BODY=$(sed '$d' <<< "$out")
  if [ "$first_code" != "200" ] && [ "$code" = "200" ]; then
    problems+=("$path first returned $first_code; retry recovered")
  fi
}

# 1. Reachable and authenticating.
#    HTTP success alone does not establish usable feed coverage.
probe GET /health
code="$P_CODE"; body="$P_BODY"
health_bad=""
if [ "$code" != "200" ]; then
  # Report a failed feed probe even when the course-status route still answers.
  health_bad="bridge /health returned $code"
else
  # A feed that stopped resolving is the common quiet failure: the GPT still answers,
  # it just answers with an incomplete deadline list.
  # /health returns feeds as a list of {source, ok, events}, not a map.
  bad=$(python3 "$ROOT/scripts/validate_health.py" health <<< "$body" 2>/dev/null)
  [ -n "$bad" ] && while IFS= read -r l; do problems+=("$l"); done <<< "$bad"
fi

# 2. Courses answer /status, one per run on rotation.
#    Preserve the existing hourly rotation; each payload must match its course
#    and contain both configured feeds.
COURSES=(BUSN5000 MGMT4280 MGMT5560 MGMT5850 LAND2510 BUSN3040)
c=${COURSES[$(( 10#$(date +%H) % ${#COURSES[@]} ))]}
sleep "$GAP"
probe GET "/status?course=$c"
sc="$P_CODE"
if [ "$sc" = "200" ]; then
  bad=$(python3 "$ROOT/scripts/validate_health.py" status "$c" <<< "$P_BODY" 2>/dev/null)
  if [ -n "$bad" ]; then
    while IFS= read -r l; do problems+=("$l"); done <<< "$bad"
  else
    note "status: $c payload verified"
  fi
  [ -n "$health_bad" ] && problems+=("$health_bad")
else
  problems+=("/status?course=$c returned $sc twice")
  [ -n "$health_bad" ] && problems+=("$health_bad")
fi

# 3. A dedicated diagnostic key tests writes without overwriting Claude notes.
sleep "$GAP"
probe POST /system/health/probe '{}'
wcode="$P_CODE"
if [ "$wcode" != "200" ]; then
  problems+=("diagnostic storage write returned $wcode")
fi

# On-demand clients have no heartbeat contract. Quiet GPTs are not failures;
# the system map displays course request markers as unverified activity only.

if [ ${#problems[@]} -eq 0 ]; then
  overall="ok"; msg="Bridge healthy."
else
  overall="degraded"; msg="Bridge: ${problems[0]}"
  [ ${#problems[@]} -gt 1 ] && msg="$msg (+$(( ${#problems[@]} - 1 )) more)"
fi

python3 - "$overall" "$msg" "$LOG" "${problems[@]:-}" > "$STATUS" <<'PY'
import json, sys
from datetime import datetime, timezone
overall, msg, log = sys.argv[1], sys.argv[2], sys.argv[3]
probs = [p for p in sys.argv[4:] if p]
print(json.dumps({
    "ran_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "ran_at_local": datetime.now().strftime("%a %b %d %-I:%M %p"),
    "overall": overall, "message": msg, "problems": probs, "log": log,
}, indent=2))
PY

note "$overall: $msg"
python3 "$ROOT/scripts/notify_incident.py" --source bridge-health --status-file "$STATUS" --title "GPT bridge health" || note "notification checkpoint failed"
if [ "$overall" != "ok" ]; then
  for p in "${problems[@]}"; do note "  - $p"; done
  exit 1
fi
exit 0

