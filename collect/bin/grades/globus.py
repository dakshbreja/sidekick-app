#!/usr/bin/env python3
"""Read GLO-BUS for MGMT 5560.

GLO-BUS is the *only* grade source for MGMT 5560 — that course has zero eLC grade
objects, because Hill runs assessment entirely inside the simulation. So this is not
a nice-to-have third source; without it MGMT 5560 has no grade tracking at all.

The item list is built from the SCHEDULE page, not the grades page, and scores are
overlaid onto it. The grades page only lists work that already has a score, so
building from it would mean an assignment does not exist until the moment it is
marked — no pending state, no deadline, and no way to notice a missed decision
round. The schedule enumerates the whole term up front.

Two tables carry scores and they are shaped differently:
  * a plain ASSIGNMENT | SCORE table for named work
  * a CHAPTER 1..9 matrix whose single "Score" row holds the quiz results

Existing behaviour in globus_watch.py is untouched. It watches the schedule for
deadline *changes* and posts a note; this reads the same pages for grade state.
"""
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import chrome_bridge as cb
from grades import model

COURSE = "MGMT5560"

# A marker of our own, deliberately NOT globus_watch's "bw=1": both jobs may be in
# flight at once, and each must only ever navigate its own tab. Same reason either
# has a marker at all — AppleScript addresses tabs by position.
MARK = "gg=1"
LOBBY = "https://www.glo-bus.com/users/lobby/"
SCHEDULE = LOBBY + "schedule?" + MARK
GRADES = LOBBY + "assignments/student-grades?" + MARK
_OWNED_TAB_ID = None

ROWS_JS = """
(function(){
  var out = [];
  [].slice.call(document.querySelectorAll('table')).forEach(function(t, ti){
    [].slice.call(t.querySelectorAll('tr')).forEach(function(tr){
      var c = [].slice.call(tr.querySelectorAll('td,th')).map(function(x){
        return (x.innerText||'').replace(/\\s+/g,' ').trim(); });
      if (c.length >= 2 && c.join('').length) out.push({t: ti, cells: c});
    });
  });
  var signedIn = location.hostname === 'www.glo-bus.com' &&
    location.pathname.indexOf('/users/lobby/') === 0 &&
    !document.querySelector('input[type=password]') &&
    !/sign in|log in/i.test((document.body.innerText||'').slice(0,400));
  return JSON.stringify({rows: signedIn ? out : [], signedIn: signedIn});
})()
"""

# Rows that announce rather than assign. GLO-BUS writes availability two ways —
# "Available: Chapter 1 Quiz" and "Simulation Quiz 1 Available" — and only the
# second form has the word at the end, so matching a prefix alone let those
# through as fake pending work with an opening date masquerading as a deadline.
# Matched with .search(), not .match(): .match() anchors the whole pattern at
# position 0, which would make the trailing-"Available" alternative dead code.
SKIP_ROW = re.compile(
    r"^(available:|data reset|assignment$|chapter$|score$)|\savailable$", re.I)
DATE_RE = re.compile(r"^(\d{1,2})-([A-Za-z]{3})-(\d{4}),\s*(\d{1,2}):(\d{2})\s*([AP]M)$")
MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}


def our_tab():
    if _OWNED_TAB_ID is not None:
        hit = cb.find_tab_id(_OWNED_TAB_ID)
        if hit: return hit
        raise cb.ChromeError("GLO-BUS collector tab was closed; source check incomplete")
    hits = cb.find_tabs(MARK)
    if not hits:
        raise cb.ChromeError("no GLO-BUS tab of ours is open")
    return hits[-1][0], hits[-1][1]


def open_tab():
    global _OWNED_TAB_ID
    hits = cb.find_tabs(MARK)
    if hits:
        _OWNED_TAB_ID = cb.tab_id(*hits[-1])
    else:
        _OWNED_TAB_ID = cb.open_owned_tab(SCHEDULE)
    win, tab = our_tab()
    cb.wait_loaded(win, tab, timeout=45)
    time.sleep(2)
    return our_tab()


def read(url, label):
    """Navigate and read, waiting for the row count to settle.

    GLO-BUS renders its tables progressively. A read landing mid-render returns a
    SHORT table, which then diffs as "your deadlines were removed" — the same trap
    globus_watch documents. Being slow beats crying wolf.
    """
    win, tab = our_tab()
    cb.run_js(win, tab, f"window.location.href={json.dumps(url)};'ok'")
    time.sleep(4)
    win, tab = our_tab()
    cb.wait_loaded(win, tab, timeout=45)
    time.sleep(1.5)
    prev_n, data = None, None
    for _ in range(6):
        win, tab = our_tab()
        data = cb.run_js_json(win, tab, ROWS_JS.replace("\n", " "), timeout=60)
        if not isinstance(data, dict):
            raise cb.ChromeError(f"{label}: unexpected source response")
        if data.get("signedIn") is not True:
            raise cb.ChromeError("GLO-BUS sign-in is required; grade source was not read")
        n = len(data.get("rows") or [])
        if prev_n is not None and n == prev_n:
            return data
        prev_n = n
        time.sleep(1.5)
    return data


def parse_date(s):
    m = DATE_RE.match((s or "").strip())
    if not m:
        return None
    day, mon, year, hh, mm, ap = m.groups()
    month = MONTHS.get(mon.lower())
    if not month:
        return None
    hour = int(hh) % 12 + (12 if ap.upper() == "PM" else 0)
    return datetime(int(year), month, int(day), hour, int(mm),
                    tzinfo=timezone.utc).isoformat()


def norm(name):
    """Fold the schedule's and the gradebook's names onto one key.

    "Deadline: Chapter 1 Quiz" and the matrix column "1" both have to land on
    "chapter 1 quiz", or every chapter quiz shows as pending forever while its
    score sits unmatched two tables away.
    """
    s = re.sub(r"^(deadline|due)\s*:\s*", "", (name or "").strip(), flags=re.I)
    s = re.sub(r"\s+deadline$", "", s, flags=re.I)
    return " ".join(s.lower().split())


def title_of(name):
    """Display name: the work itself, with the schedule's event words removed."""
    s = re.sub(r"^(deadline|due)\s*:\s*", "", (name or "").strip(), flags=re.I)
    return re.sub(r"\s+deadline$", "", s, flags=re.I).strip()


def scores_from(rows):
    """{normalised name: (score, out_of)} across both score tables."""
    out = {}
    chapters = {}
    for r in rows:
        cells = r["cells"]
        head = cells[0].strip()
        if head.upper() == "CHAPTER":
            chapters["cols"] = cells[1:]
        elif head.upper() == "SCORE" and "cols" in chapters:
            for col, val in zip(chapters["cols"], cells[1:]):
                if val.strip():
                    out[norm(f"chapter {col} quiz")] = (_num(val), None)
        elif not SKIP_ROW.search(head) and len(cells) >= 2:
            n = _num(cells[1])
            if n is not None:
                out[norm(head)] = (n, None)
    return out


def _num(s):
    m = re.search(r"-?\d+(?:\.\d+)?", (s or ""))
    return float(m.group(0)) if m else None


def collect(log=print, close=True):
    """[record, ...] for MGMT 5560. Raises cb.ChromeError with no live session."""
    global _OWNED_TAB_ID
    try:
        open_tab()
        sched = read(SCHEDULE, "schedule")
        if not sched.get("signedIn", True):
            raise cb.ChromeError("GLO-BUS is not signed in")
        grades = read(GRADES, "grades")
        score_by = scores_from(grades.get("rows") or [])

        out, seen = [], set()
        for r in sched.get("rows") or []:
            head = r["cells"][0].strip()
            if SKIP_ROW.search(head) or head.upper() == "ASSIGNMENT":
                continue
            due = parse_date(r["cells"][1])
            if due is None:
                continue                       # a row with no date is not work
            k = norm(head)
            if k in seen:
                continue
            seen.add(k)
            score, out_of = score_by.get(k, (None, None))
            # Title from the same cleaner the key uses, so "Simulation Quiz 1
            # Deadline" is displayed as the assignment, not as the event.
            out.append(model.record(
                COURSE, title_of(head),
                state="graded" if score is not None else "pending",
                score=score, out_of=out_of, due=due,
                source="globus", url=LOBBY + "schedule"))

        # A score with no matching schedule row is still real — the game-to-date
        # company score has no deadline but is the headline number for the course.
        for k, (score, out_of) in score_by.items():
            if k not in seen:
                out.append(model.record(
                    COURSE, k.title(), state="graded", score=score, out_of=out_of,
                    source="globus", url=LOBBY + "assignments/student-grades"))

        graded = sum(1 for r in out if r["state"] == "graded")
        log(f"globus: {COURSE} — {len(out)} item(s), {graded} graded")
        return out
    finally:
        if close and _OWNED_TAB_ID is not None:
            try:
                w, t = our_tab()
                cb.close_tab(w, t)
            except Exception:
                pass
        _OWNED_TAB_ID = None


if __name__ == "__main__":
    for r in collect():
        print("%-10s %-40s %-9s %-8s %s" % (
            r["course"], r["item"][:38], r["state"],
            "" if r["score"] is None else r["score"], (r["due"] or "")[:10]))
