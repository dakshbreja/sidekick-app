#!/usr/bin/env python3
"""Read Gradescope's dashboard for whatever courses it carries.

Gradescope holds exactly one of Daksh's courses (BUSN 5000), so this is not the
whole grade picture — the eLC gradebook is the only source that reaches the other
five. It is first because it was already reachable and its table is clean.

Same session rules as the rest of this repo: it drives the Chrome he is already
signed into, never handles credentials, and no-ops when there is no live session.
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import chrome_bridge as cb
import gradescope_submission
from grades import model

# Every URL this job opens carries ?gs=1, copying globus_watch. Two reasons, both
# load-bearing: Daksh may have his own Gradescope tab open and this must never
# navigate or close it, and AppleScript addresses tabs by POSITION, so an index
# goes stale the moment any earlier tab closes. Re-resolve by marker every time.
MARK = "gs=1"
ACCOUNT = "https://www.gradescope.com/account?" + MARK

COURSES_JS = """
(function(){
  var out = [];
  document.querySelectorAll('a').forEach(function(a){
    var m = (a.href||'').match(/\\/courses\\/(\\d+)$/);
    if (!m) return;
    var short = (a.querySelector('.courseBox--shortname')||{}).textContent || '';
    var name  = (a.querySelector('.courseBox--name')||{}).textContent || '';
    out.push({id: m[1], short: short.trim(), name: name.trim(),
              text: (a.textContent||'').replace(/\\s+/g,' ').trim()});
  });
  return JSON.stringify({rows: out, loggedIn: !document.querySelector('input[type=password]')});
})()
"""

# The dashboard table is Name | Status | Released/Due. "Status" carries either a
# word ("No Submission", "Submitted") or the score itself ("3.0 / 3.0"), which is
# why the state and the number are parsed from the same cell.
ASSIGNMENTS_JS = """
(function(){
  var out = [];
  document.querySelectorAll('table tbody tr').forEach(function(tr){
    var cells = Array.from(tr.querySelectorAll('th,td')).map(function(c){
      return (c.textContent||'').replace(/\\s+/g,' ').trim();
    });
    if (!cells.length || !cells[0]) return;
    var a = tr.querySelector('a[href*="/submissions/"], a[href*="/assignments/"]');
    var receipt = tr.querySelector('a[href*="/submissions/"]');
    var due = tr.querySelector('.submissionTimeChart--dueDate[datetime]');
    out.push({name: cells[0], status: cells[1]||'', dates: cells[2]||'',
              href: a ? a.href : null, submission_href: receipt ? receipt.href : null,
              due_at: due ? due.getAttribute('datetime') : null});
  });
  return JSON.stringify({rows: out, title: document.title, url: window.location.href,
    loggedIn: !document.querySelector('input[type=password]')});
})()
"""

SCORE_RE = re.compile(r"^\s*([\d.]+)\s*/\s*([\d.]+)\s*$")


def our_tab():
    hits = cb.find_tabs(MARK)
    if not hits:
        raise cb.ChromeError("no Gradescope tab of ours is open")
    return hits[0][0], hits[0][1]


def open_tab():
    """Open our own marked tab if one is not already there.

    This was missing, and manual testing never caught it: every time this adapter
    was run by hand a Gradescope tab had just been opened to check something, so
    our_tab() always found one. The first genuinely unattended run failed outright
    with "no Gradescope tab of ours is open". The eLC and GLO-BUS adapters both had
    this from the start; this one did not.
    """
    if not cb.find_tabs(MARK):
        win, tab = cb.open_tab(ACCOUNT)
        cb.wait_loaded(win, tab, timeout=45)
        time.sleep(2)
    return our_tab()


def read(url, js, label, expect_rows=True):
    """Navigate our tab and read, waiting for the row count to settle.

    Copied from globus_watch for the same reason it exists there: a read that lands
    mid-render returns a SHORT table, which then diffs as "your work disappeared".
    Being slightly slow beats crying wolf about a vanished submission.
    """
    win, tab = our_tab()
    cb.run_js(win, tab, f"window.location.href={json.dumps(url)};'ok'")
    time.sleep(3)
    win, tab = our_tab()
    cb.wait_loaded(win, tab, timeout=45)
    time.sleep(1.5)
    prev_n, data = None, None
    for _ in range(6):
        win, tab = our_tab()
        data = cb.run_js_json(win, tab, js.replace("\n", " "), timeout=60)
        if not isinstance(data, dict):
            raise cb.ChromeError(f"{label}: unexpected payload {str(data)[:120]}")
        n = len(data.get("rows") or [])
        if not expect_rows or (prev_n is not None and n == prev_n):
            return data
        prev_n = n
        time.sleep(1.5)
    return data


def course_code(short, name, text):
    """Gradescope's own short name is closest to the codes used everywhere here."""
    for candidate in (short, name, text):
        m = re.search(r"([A-Z]{2,4})\s*-?\s*(\d{4}[A-Z]?)", candidate or "")
        if m:
            return f"{m.group(1)}{m.group(2)}"
    return None


def parse_dates(s):
    """'Aug 20 at 6:00AM Aug 26 at 11:59PM' -> (released, due), best effort.

    Left as display strings rather than parsed timestamps: Gradescope omits the
    year, and inventing one is how a September deadline becomes a January one.
    """
    parts = re.findall(r"[A-Z][a-z]{2} \d{1,2} at \d{1,2}:\d{2}[AP]M", s or "")
    if len(parts) >= 2:
        return parts[0], parts[1]
    if len(parts) == 1:
        return None, parts[0]
    return None, None


def state_of(status, due_text):
    """Map Gradescope's Status cell onto our four states."""
    s = (status or "").strip()
    if SCORE_RE.match(s):
        return "graded"
    low = s.lower()
    if "no submission" in low:
        return "pending"
    if "submitted" in low or "submission" in low:
        return "completed"
    return "pending"


def collect(log=print, close=True, *, reconcile=True):
    """Read grades; reconcile=False forbids every submission/bridge side effect."""
    try:
        open_tab()
        return _collect(log, reconcile=reconcile)
    except cb.ChromeError:
        if reconcile: gradescope_submission.blocked('session', log=log)
        raise
    finally:
        if close:
            try:
                w, t = our_tab()
                cb.close_tab(w, t)
            except Exception:
                pass


def _collect(log, *, reconcile=True):
    acct = read(ACCOUNT, COURSES_JS, "courses", expect_rows=False)
    if not acct.get("loggedIn", True):
        raise cb.ChromeError("Gradescope is not signed in")
    courses = acct.get("rows") or []
    if not courses:
        log("gradescope: no courses on the account page")
        if reconcile: gradescope_submission.blocked('course_identity', log=log)
        return []

    out = []
    completion_source = gradescope_submission.source_config() if reconcile else None
    completion_seen = False
    for c in courses:
        code = course_code(c.get("short"), c.get("name"), c.get("text"))
        if not code:
            log(f"gradescope: skipping course with no recognisable code: {c.get('text','')[:40]}")
            continue
        url = f"https://www.gradescope.com/courses/{c['id']}?{MARK}"
        data = read(url, ASSIGNMENTS_JS, f"assignments:{code}")
        if code == 'BUSN5000' and completion_source and str(completion_source['gradescope_courses'].get(code)) == str(c['id']):
            completion_seen = True
            observed_url = data.get('url') or ''
            if data.get('loggedIn') is True and re.fullmatch(
                    r'https://www\.gradescope\.com/courses/' + re.escape(str(c['id'])) + r'/?(?:\?[^#]*)?', observed_url):
                gradescope_submission.record(code, c['id'], data.get('rows') or [], log=log)
            else:
                gradescope_submission.blocked('session', log=log)
        for row in data.get("rows") or []:
            released, due = parse_dates(row.get("dates"))
            m = SCORE_RE.match((row.get("status") or "").strip())
            out.append(model.record(
                code, row["name"],
                state=state_of(row.get("status"), due),
                score=float(m.group(1)) if m else None,
                out_of=float(m.group(2)) if m else None,
                due=due, released=released,
                source="gradescope", url=row.get("href"),
                raw=(row.get("status") or "").strip() or None))
        log(f"gradescope: {code} — {len(data.get('rows') or [])} item(s)")
    if reconcile and not completion_seen:
        gradescope_submission.blocked('course_identity', log=log)
    return out


if __name__ == "__main__":
    for r in collect():
        print("%-10s %-40s %-11s %s" % (
            r["course"], r["item"][:38], r["state"],
            "" if r["percent"] is None else f"{r['percent']}%"))
