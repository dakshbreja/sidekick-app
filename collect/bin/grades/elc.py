#!/usr/bin/env python3
"""Read the eLC (D2L) gradebook for every Fall 2026 course.

Uses D2L's own REST API from a page on its origin with credentials:'include',
exactly as elc_daily's sweep does, rather than scraping the grades page. The API
gives the score, the denominator and a LastModified timestamp; the rendered page
gives a table that changes shape whenever D2L reskins.

Course discovery is imported from elc_daily rather than reimplemented. The term
filter there is subtle — it picks the highest term id among *in-session* shells,
which is what stops the job pulling a finished summer course — and having two
copies of that logic is how they drift.

WHAT THIS CAN AND CANNOT SEE
  * pending / graded — reliable, straight from the gradebook.
  * completed (submitted, awaiting a mark) — NOT available. The student view of
    /dropbox/folders/<id>/ is a 404, so there is no way to ask "did I hand this
    in?". Those items stay `pending` until a grade lands, and `completed` comes
    from Gradescope or from Daksh saying so.

Coverage is per instructor, not universal: as of 1 Sep, MGMT 4280 and MGMT 5560
have zero grade objects because those instructors do not use the eLC gradebook at
all. An empty course here is a fact about the course, not a failure.
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import chrome_bridge as cb
import elc_daily
from grades import model

# Same marked-tab discipline as globus_watch and the Gradescope adapter: Daksh may
# have his own eLC tab open, and AppleScript addresses tabs by position, so the
# index goes stale the moment an earlier tab closes. Re-resolve by marker.
MARK = "elcg=1"
HOME = elc_daily.ELC + "/d2l/home?" + MARK
API = "/d2l/api/le/1.67"

# Rolled-up totals, not pieces of work. Tracking them would put "Calculated Final
# Grade" on the board as an assignment that is permanently pending.
SKIP_TYPES = {"Calculated", "Formula", "Final"}
SKIP_NAME = re.compile(r"final (calculated|adjusted) grade|^calculated |^adjusted ", re.I)

# NO "//" COMMENTS IN THIS STRING. It is sent as a single line (newlines are
# collapsed before it reaches Chrome), so a line comment would swallow the rest of
# the script and the global would never be set — which presents as a bare
# "timed out waiting for window.__gr". Every JS constant in this repo follows the
# same rule.
#
# Due dates come from the dropbox folder rather than the grade object, matched by
# name below. Best effort: a missing due date is not worth failing a run over.
FETCH_JS = """
window.__gr = 'pending';
(async function(){
  var C = %s, out = {};
  for (var code in C) {
    var ou = C[code], bucket = {defs: [], values: [], due: {}, error: null};
    try {
      var d = await fetch('%s/' + ou + '/grades/', {credentials:'include'});
      bucket.defs = d.ok ? await d.json() : [];
      var v = await fetch('%s/' + ou + '/grades/values/myGradeValues/', {credentials:'include'});
      bucket.values = v.ok ? await v.json() : [];
      var f = await fetch('%s/' + ou + '/dropbox/folders/', {credentials:'include'});
      if (f.ok) (await f.json()).forEach(function(x){
        if (x && x.Name) bucket.due[String(x.Name).trim().toLowerCase()] = x.DueDate || null;
      });
    } catch (e) { bucket.error = String(e).slice(0,160); }
    out[code] = bucket;
  }
  window.__gr = out;
})().catch(function(e){ window.__gr = {__error: String(e).slice(0,200)}; });
'ok'
"""


def our_tab():
    hits = cb.find_tabs(MARK)
    if not hits:
        raise cb.ChromeError("no eLC tab of ours is open")
    return hits[0][0], hits[0][1]


def open_tab():
    hits = cb.find_tabs(MARK)
    if hits:
        return hits[0][0], hits[0][1]
    win, tab = cb.open_tab(HOME)
    cb.wait_loaded(win, tab, timeout=45)
    time.sleep(2)
    return our_tab()


def keep(defn):
    name = str(defn.get("Name") or "")
    if SKIP_NAME.search(name):
        return False
    return str(defn.get("GradeType") or "") not in SKIP_TYPES


def collect(log=print, close=True):
    """[record, ...] across every Fall 2026 course that has a gradebook."""
    win, tab = open_tab()
    try:
        courses = elc_daily.discover_courses(win, tab)
        if not courses:
            raise cb.ChromeError("no current-term courses; eLC session may be dead")

        payload = json.dumps(courses)
        cb.run_js(win, tab, (FETCH_JS % (payload, API, API, API)).replace("\n", " "))
        data = cb.await_global(win, tab, "__gr", timeout=120)
        if isinstance(data, dict) and data.get("__error"):
            raise cb.ChromeError("grades fetch: " + data["__error"])

        out = []
        for code, bucket in (data or {}).items():
            if bucket.get("error"):
                log(f"elc: {code} — {bucket['error']}")
                continue
            defs = [d for d in (bucket.get("defs") or []) if keep(d)]
            if not defs:
                # Two of the six instructors simply do not use the gradebook.
                log(f"elc: {code} — no gradebook items")
                continue
            by_id = {str(v.get("GradeObjectIdentifier")): v for v in (bucket.get("values") or [])}
            due_by_name = bucket.get("due") or {}

            graded = 0
            for d in defs:
                val = by_id.get(str(d.get("Id")))
                num = None if val is None else val.get("PointsNumerator")
                den = None if val is None else val.get("PointsDenominator")
                has_score = num is not None
                if has_score:
                    graded += 1
                out.append(model.record(
                    code, d.get("Name") or "(untitled)",
                    state="graded" if has_score else "pending",
                    score=num,
                    out_of=den or d.get("MaxPoints"),
                    due=due_by_name.get(str(d.get("Name") or "").strip().lower()),
                    source="elc",
                    url=f"{elc_daily.ELC}/d2l/lms/grades/my_grades/main.d2l?ou={courses[code]}",
                    raw=(val or {}).get("DisplayedGrade")))
            log(f"elc: {code} — {len(defs)} item(s), {graded} graded")
        return out
    finally:
        if close:
            try:
                w, t = our_tab()
                cb.close_tab(w, t)
            except Exception:
                pass


if __name__ == "__main__":
    for r in collect():
        print("%-10s %-42s %-9s %s" % (
            r["course"], r["item"][:40], r["state"],
            "" if r["percent"] is None else f"{r['percent']}%"))
