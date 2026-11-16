#!/usr/bin/env python3
"""Watch GLO-BUS and feed anything that changes into the same bridge as everything else.

GLO-BUS is the one course system with no feed of any kind — no iCal, no API, and its
deadlines never reach eLC. Left alone it is an island: the dates only exist inside a
lobby Daksh has to remember to open. This closes that gap by reading the lobby the
same way bin/elc_daily.py reads eLC — through his own signed-in BrowserOS neo via its supported MCP
transport — and pushing what it finds to the status bridge, where the class GPTs already
look.

The existing hourly watcher owns both phases; there is no second collector:

  * Schedule/private-grade baselines retain their six-hour cooldown.
  * Score-free completion checks run hourly, including bounded read-only reviews
    of elapsed current-term exercises linked by the enrolled portal.
  * Only explicit item completion/submission receipts reach the transactional
    progress writer. A grade, elapsed date, Review button or question icon does
    not establish a complete submission. Unknown coverage stays unknown.
  * Date changes still go to the calendar queue and course notes. Private grade
    rows remain in an owner-only local cache and never enter shared notes/progress.
    Quiet observations do not duplicate completed progress records.

  --dry-run   report what would happen; touch no state, post nothing
  --force     run even if the last check was less than MIN_GAP ago
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import calendar_sync
import chrome_bridge as cb

ROOT = os.path.expanduser("~/Claude/school-system-suite/collect")
STATE = os.path.join(ROOT, ".globus-state.json")
CAL_QUEUE = os.path.join(ROOT, ".globus-calendar-sync.json")
AUDIT = os.path.join(ROOT, "MGMT5560", "text",
                     "MGMT5560_GLO-BUS_Simulation_Audit.txt")
LOG = os.path.join(ROOT, "logs", "globus.log")
NOTE_SH = os.path.expanduser("~/Claude/school-system-suite/bridge/note.sh")
COURSE = "MGMT5560"

LOBBY = "https://www.glo-bus.com/users/lobby/"
# Every URL this job opens carries ?bw=1. GLO-BUS ignores the unknown parameter, but
# it makes our tab identifiable, and that matters twice over: Daksh may have his own
# GLO-BUS tab open and we must never navigate or close it, and AppleScript addresses
# tabs by POSITION, so an index goes stale the instant any earlier tab closes.
# Re-resolving by this marker before every call is what makes both safe.
MARK = "bw=1"
SCHEDULE = LOBBY + "schedule?" + MARK
GRADES = LOBBY + "assignments/student-grades?" + MARK
MIN_GAP_SECONDS = 6 * 3600      # sim schedules barely move; scores land weekly
TERM = "fall-2026"
COMPLETION_MIN_GAP_SECONDS = 55 * 60
MAX_COMPLETION_REVIEW_PAGES = 5
# Independently inspected through supported CUA on October 10, 2026. Expired
# schedule/gradebook rows lose their exercise hyperlinks, so their absence is not
# evidence the requirement vanished. These exact read-only destinations remain
# source-anchored; other chapters require a confirmed route before enrollment.
AUDITED_EXERCISE_REVIEW_SOURCES = {
    "term_id": TERM,
    "source_confirmed_on": "2026-10-10",
    "chapter_urls": {
        5: "https://www.glo-bus.com/textbook/chex/review/5",
        7: "https://www.glo-bus.com/textbook/chex/review/7",
    },
}


def log(msg):
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    line = f"{datetime.now().isoformat(timespec='seconds')}  {msg}"
    with open(LOG, "a") as f:
        f.write(line + "\n")
    print(line)


def load_json(path, default):
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            pass
    return default


def save_json(path, obj):
    # The legacy watcher cache contains restricted grade data. A new safe receipt
    # projection does not make that cache suitable for other local accounts.
    folder = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".globus-write-", dir=folder)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f, indent=2)
        os.replace(tmp, path)
        os.chmod(path, 0o600)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def notify(title, message):
    def esc(s):
        return s.replace("\\", "\\\\").replace('"', '\\"')
    try:
        subprocess.run(["osascript", "-e",
                        f'display notification "{esc(message)}" with title "{esc(title)}"'],
                       capture_output=True, timeout=15)
    except Exception:
        pass


def post_note(text):
    """Course-scoped note, so it reaches the MGMT 5560 GPT and nothing else."""
    if not os.path.isfile(NOTE_SH):
        return
    try:
        r = subprocess.run(["bash", NOTE_SH, COURSE, text[:1400]],
                           capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            out = (r.stderr or r.stdout).strip()
            if "kv_write_limit" in out:
                log("note DEFERRED: bridge write quota spent, resets 00:00 UTC")
            else:
                log(f"note REJECTED: {out[:200]}")
        return r.returncode == 0
    except Exception as e:
        log(f"note failed: {e}")
    return False


# ---------------------------------------------------------------------- scraping
# One JS payload per page, each returning JSON. Kept as plain table reads rather
# than anything clever: GLO-BUS is a server-rendered app and its markup is stable,
# but it is not ours, so the less structure we assume the longer this keeps working.

SCHEDULE_JS = """
(function(){
  var receipts = [].slice.call(document.querySelectorAll('table tr')).map(function(tr){
    return {cells: [].slice.call(tr.querySelectorAll('td,th')).map(function(c){
      return c.innerText.trim(); })};
  });
  var rows = [].slice.call(document.querySelectorAll('table tr')).map(function(tr){
    return [].slice.call(tr.querySelectorAll('td,th')).map(function(c){
      return c.innerText.trim(); }).filter(Boolean);
  }).filter(function(r){ return r.length >= 2 && !/^ASSIGNMENT$/i.test(r[0]); });
  var head = (document.querySelector('.company-name, h1, .sidebar-title') || {}).innerText || '';
  var msg = (document.body.innerText.match(/MESSAGE CENTER\\s+(\\d+)/) || [,'0'])[1];
  return JSON.stringify({
    rows: rows.map(function(r){ return r[0] + ' || ' + r[1]; }),
    identity: (document.body.innerText.match(/Industry \\d+[^\\n]*/) || [''])[0].trim(),
    messages: parseInt(msg, 10) || 0,
    receipt_rows: receipts
  });
})()
"""

GRADES_JS = """
(function(){
  var out = [], receipts = [];
  [].slice.call(document.querySelectorAll('table')).forEach(function(t){
    [].slice.call(t.querySelectorAll('tr')).forEach(function(tr){
      var c = [].slice.call(tr.querySelectorAll('td,th')).map(function(x){
        return x.innerText.trim(); });
      if (c.length >= 2 && c.join('').length) {
        out.push(c.join(' | '));
        receipts.push({cells: c});
      }
    });
  });
  var links = [].slice.call(document.querySelectorAll('a[href]')).map(function(a){
    return {url: a.href, title: (a.innerText || '').trim()};
  }).filter(function(a){ return /\\/textbook\\/chex\\/(?:review\\/)?\\d+\\/?(?:[?#]|$)/.test(a.url); });
  return JSON.stringify({grades: out, receipt_rows: receipts, completion_sources: links});
})()
"""

# This hourly projection never captures grade cells. Review targets use exact
# independently confirmed routes scoped by the fresh enrolled schedule below.
COMPLETION_SOURCES_JS = """
(function(){
  var links = [].slice.call(document.querySelectorAll('a[href]')).map(function(a){
    return {url: a.href, title: (a.innerText || '').trim()};
  }).filter(function(a){ return /\\/textbook\\/chex\\/(?:review\\/)?\\d+\\/?(?:[?#]|$)/.test(a.url); });
  var rows = [].slice.call(document.querySelectorAll('table tr')).map(function(tr){
    return {cells: [].slice.call(tr.querySelectorAll('td,th')).map(function(c){
      var s = c.innerText.trim();
      if (/^(?:Deadline:\\s*)?Chapter\\s+\\d+\\s+(?:Exercises?|Quiz)(?:\\s+Deadline)?$/i.test(s)) return s;
      // Discarding a negative cell would turn Completed + In progress into a
      // positive-only receipt. Preserve only its bounded status token, without
      // copying adjacent score/answer text into this hourly projection.
      var negative = s.match(/\\b(?:not\\s+(?:(?:yet|fully)\\s+)?(?:completed|submitted|finished|started|attempted)|no\\s+submission|incomplete|in\\s+progress|pending|unsubmitted|unattempted)\\b/i);
      if (negative) return negative[0].replace(/\\s+/g, ' ').slice(0,80);
      return s.length <= 240 && /^(?:Status:\\s*)?(?:Submitted|Completed|Finished)(?:\\s+(?:on|at)\\s+.+)?[.!]?$/i.test(s) ? s : '';
    })};
  });
  return JSON.stringify({receipt_rows: rows, completion_sources: links,
    signedIn: !/sign in|log in/i.test((document.body.innerText || '').slice(0,400))});
})()
"""

COMPLETION_REVIEW_JS = """
(function(){
  var questionLinks = [].slice.call(document.querySelectorAll('a.list-group-item')).filter(function(a){
    return /^Q(?:uestion)?\\s*\\d+\\b/i.test((a.innerText || '').trim());
  });
  var lines = (document.body.innerText || '').split('\\n').map(function(s){return s.trim();});
  var receiptLines = lines.filter(function(s){
    var negative = /^(?:Status:\\s*)?(?:not\\s+(?:(?:yet|fully)\\s+)?(?:completed|submitted|finished|started|attempted)|no\\s+submission|incomplete|in\\s+progress|pending|unsubmitted|unattempted)[.!]?$/i.test(s);
    return negative || (/^(?:You have|You successfully|All (?:chapter )?exercises|Chapter\\s+\\d+\\s+Exercises)/i.test(s) &&
      /\\b(?:completed|submitted|finished)\\b/i.test(s) && s.length < 300);
  });
  return JSON.stringify({question_count: questionLinks.length,
    marked_question_count: questionLinks.filter(function(a){
      return !!a.querySelector('svg[data-icon="check-square"]'); }).length,
    unmarked_question_count: questionLinks.filter(function(a){
      return !!a.querySelector('svg[data-icon="square"]'); }).length,
    receipt_lines: receiptLines,
    signedIn: !/sign in|log in/i.test(lines.slice(0,15).join(' '))});
})()
"""


def our_tab():
    """Re-resolve our own tab by its marker. Never returns one of his."""
    hits = cb.find_tabs(MARK)
    if not hits:
        raise cb.ChromeError("our GLO-BUS tab disappeared")
    return hits[-1]


def read_page(url, js, label):
    win, tab = our_tab()
    cb.run_js(win, tab, f"window.location.href={json.dumps(url)};'ok'")
    time.sleep(4)
    win, tab = our_tab()               # the index can move while the page loads
    cb.wait_loaded(win, tab, timeout=45)
    time.sleep(1.5)
    # Read until the row count repeats. GLO-BUS renders its tables progressively,
    # and a read that lands mid-render returns a SHORT table — which then diffs as
    # "your deadlines were removed". Crying wolf about a vanished deadline is worse
    # than saying nothing, so the count has to hold still before we believe it.
    prev_n, data = None, None
    for _ in range(6):
        win, tab = our_tab()
        data = cb.run_js_json(win, tab, js.replace("\n", " "), timeout=60)
        if not isinstance(data, dict):
            raise cb.ChromeError(f"{label}: unexpected payload")
        n = len(data.get("rows") or data.get("grades") or data.get("receipt_rows") or
                data.get("completion_sources") or [])
        if data.get("question_count") is not None:
            n = data["question_count"]
        if prev_n is not None and n == prev_n:
            return data
        prev_n = n
        time.sleep(1.5)
    return data


def clean_grades(rows):
    """Keep only gradebook rows that actually carry a score.

    The grade book renders its headers and an empty score row as ordinary table
    rows, so a naive diff announces "CHAPTER | 1 | 2 | 3..." as news on the first
    run and again any time the layout twitches. Nothing is more corrosive to a
    change alert than firing when nothing changed.
    """
    out = []
    for r in rows:
        cells = [c.strip() for c in r.split("|")]
        if not cells or not cells[0]:
            continue
        if cells[0].upper() in ("CHAPTER", "ASSIGNMENT", "SCORE"):
            continue
        if not any(any(ch.isdigit() for ch in c) for c in cells[1:]):
            continue            # a row with no numbers is not a grade
        out.append(r)
    return out


CHAPTER_ITEM = re.compile(
    r"^(?:Deadline:\s*)?Chapter\s+(\d{1,2})\s+(Exercises?|Quiz)"
    r"(?:\s+Deadline)?$", re.I)
RECEIPT_STATUS = re.compile(
    r"^(?:[\u2713\u2714]\s*)?(?:Status:\s*)?(Submitted|Completed|Finished)"
    r"(?:\s+(?:on|at)\s+(.+))?[.!]?$", re.I)
ISO_RECEIPT_TIME = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?"
    r"(?:Z|[+-]\d{2}:\d{2})")
NEGATIVE_RECEIPT_STATUS = re.compile(
    r"\b(?:not\s+(?:(?:yet|fully)\s+)?(?:completed|submitted|finished|started|attempted)|"
    r"no\s+submission|incomplete|in\s+progress|pending|unsubmitted|unattempted)\b", re.I)


def completion_observations(pages, observed_at):
    """Extract explicit, item-scoped receipts without carrying grade cells.

    A score and an elapsed deadline are deliberately insufficient: the chapter
    exercise and quiz are separate requirements even when their numbers match.
    Only a recognised assignment label beside an affirmative receipt survives.
    The original read time is kept on retries; rereading a cache is not a source
    check. Unknown page shapes therefore leave work outstanding rather than
    manufacturing completion.
    """
    try:
        stamp = datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            return []
    except (TypeError, ValueError, AttributeError):
        return []
    out = {}
    for page in pages:
        if not isinstance(page, dict) or page.get("signedIn") is False:
            continue
        source_url = page.get("source_url")
        if source_url not in (LOBBY + "schedule", LOBBY + "assignments/student-grades"):
            continue
        for row in page.get("receipt_rows", []):
            cells = row.get("cells") if isinstance(row, dict) else None
            if not isinstance(cells, list) or not 2 <= len(cells) <= 40:
                continue
            titles = [(i, CHAPTER_ITEM.fullmatch(str(cell).strip()))
                      for i, cell in enumerate(cells)]
            titles = [(i, match) for i, match in titles if match]
            # A table with several assignment labels cannot establish which
            # requirement a lone completion cell belongs to.
            if len(titles) != 1:
                continue
            title_column, title_match = titles[0]
            chapter = int(title_match.group(1))
            if not 1 <= chapter <= 12:
                continue
            receipts = [RECEIPT_STATUS.fullmatch(str(cell).strip())
                        for i, cell in enumerate(cells) if i != title_column]
            receipts = [match for match in receipts if match]
            if len(receipts) != 1:
                continue
            # A contradictory status in the same item row invalidates the read.
            if any(NEGATIVE_RECEIPT_STATUS.search(str(cell))
                   for i, cell in enumerate(cells) if i != title_column):
                continue
            receipt = receipts[0]
            kind = "quiz" if title_match.group(2).lower() == "quiz" else "exercise"
            title = f"Chapter {chapter} {'Quiz' if kind == 'quiz' else 'Exercises'}"
            status = "submitted" if receipt.group(1).lower() == "submitted" else "completed"
            item = {
                "provider": "globus", "course_code": COURSE, "term_id": TERM,
                "provider_item_id": f"chapter:{chapter}:{kind}",
                "kind": f"chapter_{kind}", "chapter": chapter, "title": title,
                "status": status, "source_url": source_url,
                "observed_at": observed_at,
                "source_evidence": f"GLO-BUS shows {receipt.group(1).lower()} for {title}.",
            }
            # A visible date without a timezone/clock cannot become an invented
            # submission time. The explicit completion receipt still suffices.
            when = ISO_RECEIPT_TIME.fullmatch((receipt.group(2) or "").strip().rstrip(".!"))
            if when:
                try:
                    parsed = datetime.fromisoformat(when.group(0).replace("Z", "+00:00"))
                    if parsed <= stamp:
                        item["submitted_at"] = parsed.isoformat()
                except ValueError:
                    pass
            key = item["provider_item_id"]
            if key not in out or item["status"] == "submitted":
                out[key] = item
    return list(out.values())


def reconcile_completions(state, dry=False):
    """Retry verified observations through the shared identity/receipt writer.

    This also runs before the six-hour scrape throttle, so a lost save response
    does not leave an already observed receipt falsely overdue for six hours.
    Cached observations retain their original timestamp and never become new
    verification merely because this job ran again.
    """
    observations = state.get("completion_observations", state.get("data", {}).get("completions", []))
    try:
        from submission_reconcile import reconcile
        return reconcile(observations, log=log, dry=dry)
    except Exception:
        # Never print exception/request bodies from the authenticated writer.
        if observations:
            log("submission reconciliation unavailable; source receipts retained for retry")
        return None


def fetch_state():
    sched = read_page(SCHEDULE, SCHEDULE_JS, "schedule")
    grades = read_page(GRADES, GRADES_JS, "grades")
    stamp = datetime.now(timezone.utc).isoformat()
    completions = completion_observations([
        dict(sched, source_url=LOBBY + "schedule"),
        dict(grades, source_url=LOBBY + "assignments/student-grades"),
    ], stamp) if current_term_schedule(sched) else []
    return {
        "identity": sched.get("identity", ""),
        "messages": sched.get("messages", 0),
        "schedule": sched.get("rows", []),
        "grades": clean_grades(grades.get("grades", [])),
        "at": stamp,
        "completions": completions,
        "completion_sources": grades.get("completion_sources", []),
    }


def current_term_schedule(schedule):
    dates = []
    for row in schedule.get("rows", []):
        title, when = split_row(row)
        if CHAPTER_ITEM.fullmatch(title):
            due = parse_when(when)
            if due:
                dates.append(due)
    # An authenticated lobby may belong to a later simulation enrollment. Reused
    # chapter numbers cannot authorize a Fall 2026 save from a different term.
    return bool(dates) and all(datetime(2026, 8, 1) <= due < datetime(2027, 1, 1) for due in dates)


def exercise_review_targets(navigation, schedule, now=None):
    """Read only audited, recently elapsed current-term exercise review pages.

    GLO-BUS removes exercise hyperlinks after deadlines. A fresh enrolled source
    schedule and an independently inspected read-only route therefore establish
    coverage; absent gradebook links cannot hide a recently overdue exercise.
    Open/future exercises and unconfirmed destinations remain unchecked.
    """
    now = now or datetime.now(timezone.utc)
    if not current_term_schedule(schedule):
        return []
    eastern_day = now.astimezone(ZoneInfo("America/New_York")).date()
    earliest_day = eastern_day - timedelta(days=10)
    chapters = set()
    for row in schedule.get("rows", []):
        title, when = split_row(row)
        match = CHAPTER_ITEM.fullmatch(title)
        due = parse_when(when)
        if (match and match.group(2).lower() != "quiz" and due and
                datetime(2026, 8, 1) <= due < datetime(2027, 1, 1) and
                earliest_day <= due.date() < eastern_day):
            chapters.add(int(match.group(1)))
    configured = AUDITED_EXERCISE_REVIEW_SOURCES["chapter_urls"]
    return [{"chapter": chapter, "source_url": configured[chapter]}
            for chapter in sorted(chapters)
            if chapter in configured][:MAX_COMPLETION_REVIEW_PAGES]


def review_completion_observation(review, target, observed_at):
    """Question icons are coverage metadata, not a completed-submission receipt.

    The live Chapter 5 review had mixed check-square/square icons without a
    Completed label. Even all checked icons cannot establish a terminal receipt
    by themselves; only an explicit whole-exercise source statement can clear it.
    """
    chapter = target["chapter"]
    count = review.get("question_count", 0)
    if review.get("signedIn") is False or not isinstance(count, int) or not 1 <= count <= 60:
        return None
    lines = review.get("receipt_lines", [])
    if any(NEGATIVE_RECEIPT_STATUS.search(str(line)) for line in lines):
        return None
    accepted = re.compile(
        r"^(?:You have (?:successfully )?(?:completed|submitted|finished) "
        r"(?:all (?:of )?(?:the )?)?(?:chapter )?exercises|"
        r"You successfully (?:completed|submitted|finished) (?:all (?:of )?(?:the )?)?(?:chapter )?exercises|"
        r"All (?:chapter )?exercises (?:have been |are )?(?:completed|submitted|finished)|"
        rf"Chapter\s+{chapter}\s+Exercises\s+(?:(?:are|have been)\s+)?(?:completed|submitted|finished))"
        r"[.!]?$", re.I)
    if not any(accepted.fullmatch(str(line).strip()) for line in lines):
        return None
    return {"provider": "globus", "course_code": COURSE, "term_id": TERM,
            "provider_item_id": f"chapter:{chapter}:exercise", "kind": "chapter_exercise",
            "chapter": chapter, "title": f"Chapter {chapter} Exercises", "status": "completed",
            "observed_at": observed_at, "source_url": target["source_url"],
            "source_evidence": f"GLO-BUS review explicitly states the Chapter {chapter} exercises are completed."}


def fetch_completion_state(schedule=None, navigation=None, observations=None, now=None):
    """Hourly score-free checks in the existing watcher; no second scheduler."""
    schedule = schedule if schedule is not None else read_page(SCHEDULE, SCHEDULE_JS, "completion schedule")
    navigation = navigation if navigation is not None else read_page(GRADES, COMPLETION_SOURCES_JS, "completion sources")
    now = now or datetime.now(timezone.utc)
    stamp = now.isoformat()
    observed = list(observations or [])
    observed += completion_observations([
        dict(schedule, source_url=LOBBY + "schedule"),
        dict(navigation, source_url=LOBBY + "assignments/student-grades"),
    ], stamp) if current_term_schedule(schedule) else []
    checks = []
    targets = exercise_review_targets(navigation, schedule, now)
    for target in targets:
        check = dict(target, observed_at=stamp, status="unknown", reason="no_explicit_completion_receipt")
        try:
            review = read_page(target["source_url"] + "?" + MARK, COMPLETION_REVIEW_JS, "exercise review")
            count = review.get("question_count", 0)
            check["question_count"] = count if isinstance(count, int) and 0 <= count <= 60 else 0
            check["reason"] = ("session_unavailable" if review.get("signedIn") is False else
                               "review_unavailable" if not check["question_count"] else
                               "no_explicit_completion_receipt")
            observation = review_completion_observation(review, target, stamp)
            if observation:
                observed.append(observation)
                check.update(status="verified", reason="explicit_completion_receipt")
        except cb.ChromeError:
            check["reason"] = "source_read_failed"
        checks.append(check)
    deduplicated = {item["provider_item_id"]: item for item in observed}
    return {"observed_at": stamp, "observations": list(deduplicated.values()), "checks": checks,
            "scope": "audited_recently_elapsed_current_term_exercise_reviews_and_explicit_table_receipts",
            "status": "unknown" if not targets or any(c["status"] != "verified" for c in checks) else "verified"}


def record_completion_state(state, result):
    state["completion_checked_epoch"] = time.time()
    state["completion_observations"] = result["observations"]
    state["completion_health"] = {key: result[key] for key in ("observed_at", "checks", "scope", "status")}
    state["completion_health"]["last_attempt_at"] = result["observed_at"]
    save_json(STATE, state)


def record_completion_failure(state, reason, dry=False):
    if dry:
        return
    prior = dict(state.get("completion_health", {}))
    prior.update(last_attempt_at=datetime.now(timezone.utc).isoformat(), status="blocked", reason=reason)
    state["completion_health"] = prior
    # Keep source-read timestamps and saved receipts unchanged on a skipped read.
    save_json(STATE, state)


# --------------------------------------------------------------- calendar naming
# The calendar events were created with titles derived from these rows, so the same
# derivation run backwards tells us exactly which event a changed row belongs to.
# Matching is by title rather than by stored event id on purpose: an id map is one
# more thing to keep in sync and to be wrong, and these titles are unique.
def calendar_title(assignment):
    a = assignment.strip()
    a = re.sub(r"^Deadline:\s*", "", a)
    a = re.sub(r"\s*Deadline$", "", a)
    a = re.sub(r"\s*-\s*(Practice\s+)?Year\s+(\d+)$", lambda m:
               f" ({m.group(1) or ''}Year {m.group(2)})", a)
    if re.match(r"^Chapter\s+1\b.*Quiz$", a) and "–" not in a:
        pass
    return f"MGMT 5560 — GLO-BUS {a} — Due"


def parse_when(when):
    try:
        return datetime.strptime(when.strip().split(",")[0].strip(), "%d-%b-%Y")
    except ValueError:
        return None


def split_row(row):
    name, _, when = row.partition("||")
    return name.strip(), when.strip()


def calendar_patches(old_rows, new_rows):
    """What would have to change in Google Calendar for it to match GLO-BUS.

    Emitted as instructions rather than applied directly: a launchd job has no
    Google credentials, and inventing some silently in his account is not this
    script's call to make. Everything is queued so that whoever does have access —
    an authorised sync, or Claude in a session — can apply it without re-deriving
    anything.
    """
    was = {split_row(r)[0]: split_row(r)[1] for r in old_rows if "||" in r}
    now = {split_row(r)[0]: split_row(r)[1] for r in new_rows if "||" in r}
    out = []
    for name, when in now.items():
        if name.startswith("Available:"):
            continue                      # availability markers were never events
        if name not in was:
            out.append({"kind": "add", "assignment": name, "to": when,
                        "calendar_title": calendar_title(name)})
        elif was[name] != when:
            out.append({"kind": "move", "assignment": name, "from": was[name],
                        "to": when, "calendar_title": calendar_title(name)})
    for name, when in was.items():
        if name.startswith("Available:") or name in now:
            continue
        out.append({"kind": "remove", "assignment": name, "from": when,
                    "calendar_title": calendar_title(name)})
    return out


def queue_calendar_patches(patches):
    """Durable, and deduplicated against what is already waiting. The eLC pending
    queue taught this lesson: a to-do that lives only in a log line goes silent the
    moment the next run overwrites it."""
    q = load_json(CAL_QUEUE, {"pending": []})
    have = {(p["kind"], p["assignment"], p.get("to")) for p in q["pending"]}
    stamp = datetime.now(timezone.utc).isoformat()
    for p in patches:
        key = (p["kind"], p["assignment"], p.get("to"))
        if key in have:
            continue
        q["pending"].append(dict(p, detected=stamp))
    save_json(CAL_QUEUE, q)
    return q["pending"]


def refresh_audit(state):
    """Rewrite the dated sections of the Knowledge audit in place.

    Only the schedule block is regenerated; the surrounding narrative is left alone,
    because that part is analysis rather than data and regenerating it would lose it.
    """
    if not os.path.isfile(AUDIT):
        return False
    with open(AUDIT) as f:
        body = f.read()
    marker = "## LIVE SCHEDULE (regenerated by bin/globus_watch.py)"
    rows = []
    for r in state.get("schedule", []):
        name, when = split_row(r)
        if name.startswith("Available:"):
            continue
        rows.append(f"{name:<46} {when}")
    block = (marker + "\nLast confirmed against the lobby "
             + datetime.now().strftime("%Y-%m-%d %H:%M") + ".\n\n"
             + "\n".join(rows) + "\n")
    if marker in body:
        body = body[:body.index(marker)] + block
    else:
        body = body.rstrip() + "\n\n" + "=" * 72 + "\n\n" + block
    with open(AUDIT, "w") as f:
        f.write(body)
    return True


# ------------------------------------------------------------------------- diff
def diff_state(old, new):
    """Human-readable changes. Empty list means a quiet run and therefore no writes."""
    if not old:
        return ["baseline recorded"]
    out = []

    was, now = set(old.get("schedule", [])), set(new.get("schedule", []))
    for row in sorted(now - was):
        out.append(f"NEW DATE: {row}")
    for row in sorted(was - now):
        out.append(f"REMOVED: {row}")

    # This list is sent to bridge notes, notifications and operational logs.
    # Grade rows belong only in restricted local state and the private grades repo.
    gw, gn = old.get("grades", []), new.get("grades", [])
    if gw != gn:
        out.append("Gradebook changed; review the private grades dashboard")

    if new.get("messages", 0) > old.get("messages", 0):
        out.append(f"{new['messages']} unread message(s) in the GLO-BUS message centre")

    if new.get("identity") and new["identity"] != old.get("identity"):
        out.append(f"IDENTITY CHANGED: {old.get('identity')} -> {new['identity']}")
    return out


def upcoming(state, limit=3):
    """Next few dated rows, for the note. Parsed loosely — a row we cannot read is
    simply skipped rather than crashing the run."""
    now, items = datetime.now(), []
    for row in state.get("schedule", []):
        if "||" not in row:
            continue
        name, _, when = row.partition("||")
        try:
            dt = datetime.strptime(when.strip().split(",")[0].strip(), "%d-%b-%Y")
        except ValueError:
            continue
        if dt >= now.replace(hour=0, minute=0, second=0, microsecond=0):
            items.append((dt, name.strip()))
    items.sort()
    return [f"{n} ({d.strftime('%b %-d')})" for d, n in items[:limit]]


# ------------------------------------------------------------------------- main
def record_calendar_health(state, credentials_ok, pending=None, reason=None):
    """Credential access and completed delivery are separate outcomes.

    A successful list request cannot turn seven failed calendar corrections
    green. Keep the last successful delivery while later failures remain visible.
    """
    previous = state.get('calendar_health', {})
    stamp = datetime.now(timezone.utc).isoformat()
    ok = credentials_ok and pending == 0 and reason is None
    health = {'ok': ok, 'credentials_ok': credentials_ok, 'checked_at': stamp,
              'pending': pending, 'reason': reason or ('pending_changes' if pending else 'ok')}
    if ok:
        health['last_success_at'] = stamp
    elif previous.get('last_success_at'):
        health['last_success_at'] = previous['last_success_at']
    elif previous.get('ok') is True and previous.get('checked_at'):
        health['last_success_at'] = previous['checked_at']
    state['calendar_health'] = health
    save_json(STATE, state)
    return ok


def check_calendar(state, dry=False):
    """Check the events permission even when the GLO-BUS browser is signed out.

    Previously a queued change was retried only when another date moved, leaving
    existing changes stuck after credentials recovered.
    """
    ok, why = calendar_sync.healthy()
    if dry:
        return ok
    pending = None
    reason = None if ok else why
    if ok:
        try:
            applied, pending = calendar_sync.apply_queue()
            if applied or pending:
                log(f'calendar retry: {applied} applied, {pending} still queued')
        except Exception as exc:
            reason = calendar_sync.safe_error(exc)
            log(f'calendar retry failed: {reason}')
    overall_ok = ok and pending == 0 and reason is None
    if not overall_ok and time.time() - state.get('health_warned_epoch', 0) > 12 * 3600:
        log(f"CALENDAR DELIVERY: {reason or str(pending) + ' change(s) still queued'}")
        notify('Calendar sync needs attention', 'Date changes remain queued for retry. Run: bin/calendar_sync.py --check')
        state['health_warned_epoch'] = time.time()
    elif overall_ok:
        state.pop('health_warned_epoch', None)
    return record_calendar_health(state, ok, pending, reason)


def main():
    dry = "--dry-run" in sys.argv
    force = "--force" in sys.argv

    state = load_json(STATE, {})
    last = state.get("checked_epoch", 0)
    # Date/grade refresh retains its six-hour cadence. Completion checks run on
    # the existing hourly trigger, and retry delivery before either cooldown.
    check_calendar(state, dry=dry)
    reconcile_completions(state, dry=dry)
    full_due = force or dry or time.time() - last >= MIN_GAP_SECONDS
    completion_due = force or dry or time.time() - state.get("completion_checked_epoch", 0) >= COMPLETION_MIN_GAP_SECONDS
    if not full_due and not completion_due:
        return 0

    try:
        if not cb.is_running():
            log("skip: BrowserOS neo is unavailable")
            if completion_due:
                record_completion_failure(state, "browser_unavailable", dry)
            return 0
    except cb.ChromeError:
        log("skip: BrowserOS neo access failed")
        if completion_due:
            record_completion_failure(state, "browser_unavailable", dry)
        return 0

    cb.open_tab(SCHEDULE)
    try:
        win, tab = our_tab()
        cb.wait_loaded(win, tab, timeout=45)
        time.sleep(2)
        win, tab = our_tab()
        here = cb.run_js(win, tab, "document.body.innerText.slice(0,400)")
        if "Corporate Lobby" not in here and "Assignments Schedule" not in here:
            # Not signed in, or GLO-BUS bounced us to the marketing page. Never a
            # reason to prompt for credentials — just come back later.
            log("skip: no live GLO-BUS session")
            if completion_due:
                record_completion_failure(state, "session_unavailable", dry)
            return 0

        fresh = fetch_state() if full_due else None
        completion = None
        if completion_due:
            completion = fetch_completion_state(
                schedule={"rows": fresh["schedule"]} if fresh is not None else None,
                navigation={"completion_sources": fresh.pop("completion_sources", [])} if fresh is not None else None,
                observations=fresh.get("completions", []) if fresh is not None else None)
        elif fresh is not None:
            fresh.pop("completion_sources", None)
    except cb.ChromeError:
        log("skip: GLO-BUS source read failed")
        if completion_due:
            record_completion_failure(state, "source_read_failed", dry)
        return 0
    finally:
        # Close only tabs carrying our marker, highest index first so closing one
        # cannot invalidate the next.
        for w, t in sorted(cb.find_tabs(MARK), reverse=True):
            cb.close_tab(w, t)

    if completion is not None:
        if dry:
            reconcile_completions({"completion_observations": completion["observations"]}, dry=True)
        else:
            record_completion_state(state, completion)
            reconcile_completions(state)
        log(f"GLO-BUS completion check: coverage {completion['status']}; "
            f"{len(completion['observations'])} explicit receipt(s); "
            f"{sum(c['status'] != 'verified' for c in completion['checks'])} review(s) unconfirmed")
    if fresh is None:
        return 0

    prev = state.get("data")

    # Second line of defence, for a scrape that stabilised on a short table anyway.
    # A real GLO-BUS schedule does not lose a tenth of its rows overnight; a scrape
    # that says it did is far more likely to be wrong than the lobby is.
    if prev:
        before, after = len(prev.get("schedule", [])), len(fresh.get("schedule", []))
        if before and after < before * 0.9:
            log(f"SUSPECT SCRAPE: {after} rows vs {before} previously — "
                f"discarding this read and leaving state untouched")
            return 0

    changes = diff_state(prev, fresh)
    if dry:
        log(f"dry run — {len(changes)} change(s): {changes[:6]}")
        return 0

    state["data"] = fresh
    state["checked_epoch"] = time.time()
    state["checked"] = fresh["at"]
    save_json(STATE, state)
    if completion is None:
        # A fresh full read may have a table receipt even when the hourly review
        # phase ran recently. Preserve its true read time when reconciling it.
        reconcile_completions({"completion_observations": fresh.get("completions", [])})

    if not changes:
        return 0                       # quiet run: no note, no notification, no writes

    if changes == ["baseline recorded"]:
        log(f"baseline recorded — {len(fresh['schedule'])} dated rows")
        return 0

    log("CHANGED — " + "; ".join(changes[:6]))

    # A date that moves has to move everywhere, or the calendar quietly starts lying.
    patches = calendar_patches(prev.get("schedule", []), fresh.get("schedule", []))
    pending = queue_calendar_patches(patches) if patches else \
        load_json(CAL_QUEUE, {"pending": []})["pending"]

    applied = 0
    if patches:
        for p in patches:
            log(f"CALENDAR {p['kind'].upper()}: {p['assignment']} "
                f"{p.get('from', '')}{' -> ' if p.get('from') and p.get('to') else ''}"
                f"{p.get('to', '')}")
        if refresh_audit(fresh):
            log("audit file refreshed on disk")
        try:
            applied, pending_n = calendar_sync.apply_queue()
            pending = [None] * pending_n          # only the count is used below
            record_calendar_health(state, True, pending_n)
        except Exception as e:
            # A calendar failure must never cost us the note or the notification —
            # knowing a date moved matters more than the calendar being right.
            reason = calendar_sync.safe_error(e)
            record_calendar_health(state, state.get('calendar_health', {}).get('credentials_ok', False),
                                   len(pending), reason)
            log(f"calendar sync failed: {reason}")

    nxt = upcoming(fresh)
    note = ("GLO-BUS update " + datetime.now().strftime("%b %-d") + ": "
            + "; ".join(changes[:6])
            + (f". {len(patches)} calendar event(s) affected" if patches else "")
            + (". Next up: " + ", ".join(nxt) if nxt else "")
            + ". Full schedule is in my Knowledge file "
              "MGMT5560_GLO-BUS_Simulation_Audit.txt.")
    post_note(note)

    if patches:
        if applied and not pending:
            notify("GLO-BUS dates moved",
                   f"{applied} calendar event(s) updated automatically.")
        else:
            # Loud on purpose: a stale calendar entry is worse than no entry, because
            # it is believed.
            notify("GLO-BUS dates moved",
                   f"{len(patches)} event(s) changed, {len(pending)} still queued — "
                   f"calendar may be out of date.")
    else:
        notify("GLO-BUS update", changes[0][:120])
    return 0


if __name__ == "__main__":
    sys.exit(main())
