#!/usr/bin/env python3
"""Check every grade source, fold the results together, report what changed.

One routine with per-source adapters rather than a grade check bolted onto each
content sweep. Three reasons, one of them learned the hard way:

  * Grades move on their own clock. Material lands when an instructor posts;
    marks land after grading. Tying grade checks to the eLC sweep pins them to
    that sweep's cadence and its MIN_GAP throttle.
  * A failure in one place must not hide another. The Drive daemon died on 20 Aug
    and the eLC sweep kept reporting success for eleven days because nothing
    compared the two sides. If grade-checking were a step inside that sweep, an
    eLC failure would silently stop it too. Here each adapter fails alone and says
    so, and the run still reports whatever the others found.
  * One diff across all sources is the actual product — "what got marked since I
    last looked" is a single answer, not three.

GRADE VALUES NEVER REACH THE BRIDGE. Adapters can separately reconcile explicit
original submission receipts, with no grades or feedback. Scores stay on this
machine by choice; see grades/model.py. They ARE published to a private GitHub repo (--publish), which is
the only way a phone can read them: Claude Code on a phone runs in a cloud sandbox
attached to a git repo and has no path to this Mac. Collection still has to happen
here, because all three adapters use the logged-in BrowserOS neo session.

    python3 bin/grades/run.py [--html PATH] [--publish] [--quiet] [--json]
    --local-only reads sources and saves local grades/reports without submission
    reconciliation or publication. It cannot be combined with --publish.
"""
import json
import os
import subprocess
import sys
from datetime import datetime
from functools import partial

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import chrome_bridge as cb
from grades import model, report

ROOT = os.path.expanduser("~/Claude/school-system-suite/collect")
# A separate, deliberately tiny repo. Never point this at eLC-Content: that tree
# holds OAuth tokens, client secrets and every instructor's copyrighted material.
PUBLISH_DIR = os.path.expanduser("~/Claude/school-system-suite/grades-remote")
STORE = os.path.join(ROOT, ".grades.json")
STATUS = os.path.join(ROOT, ".grades-state.json")
LOG = os.path.join(ROOT, "logs", "grades.log")

# Add eLC and GLO-BUS here as they are written. Each entry is (name, callable)
# returning a list of model.record(); an adapter that raises is reported and
# skipped, never fatal.
def adapters(local_only=False):
    from grades import elc, globus, gradescope
    # eLC first: it covers the most courses, so a session failure there is the one
    # worth seeing at the top of the log. GLO-BUS last because it is the slowest —
    # two progressively-rendered pages, each read until the row count settles.
    return [("elc", elc.collect), ("gradescope", partial(gradescope.collect, reconcile=False)
            if local_only else gradescope.collect),
            ("globus", globus.collect)]


def log(msg):
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    line = f"{datetime.now().isoformat(timespec='seconds')}  {msg}"
    with open(LOG, "a") as f:
        f.write(line + "\n")
    print(line)


def load(path, default):
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            pass
    return default


def save(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2)
    os.replace(tmp, path)


def publish(records, graded, changes):
    """Copy the two artefacts into the private repo and push.

    Never fails the run. A grade check that worked is still worth having when the
    network is down, and a failed push is visible next time by the file dates.
    """
    if not os.path.isdir(os.path.join(PUBLISH_DIR, ".git")):
        log(f"publish skipped: {PUBLISH_DIR} is not a git repo")
        return
    try:
        import shutil
        shutil.copy(STORE, os.path.join(PUBLISH_DIR, "grades.json"))
        with open(os.path.join(PUBLISH_DIR, "grades.html"), "w") as f:
            f.write(report.render_html(records))
        msg = (f"Grades: {len(records)} items, {len(graded)} graded"
               + (f", {len(changes)} change(s)" if changes else ""))
        for cmd in (["git", "add", "-A"],
                    ["git", "-c", "user.name=Daksh Breja",
                     "-c", "user.email=owner@example.com",
                     "commit", "-m", msg],
                    ["git", "push", "-q", "origin", "main"]):
            r = subprocess.run(cmd, cwd=PUBLISH_DIR, capture_output=True,
                               text=True, timeout=120)
            # "nothing to commit" is the normal quiet case, not a failure.
            if r.returncode != 0 and "nothing to commit" not in (r.stdout + r.stderr):
                log(f"publish: {' '.join(cmd[:2])} failed - "
                    f"{(r.stderr or r.stdout).strip()[:120]}")
                return
        log(f"published to {PUBLISH_DIR}")
    except Exception as e:
        log(f"publish failed: {type(e).__name__}: {str(e)[:120]}")


def main():
    local_only = "--local-only" in sys.argv
    if local_only and "--publish" in sys.argv:
        print("--local-only cannot be combined with --publish")
        return 2
    quiet = "--quiet" in sys.argv
    html_at = None
    if "--html" in sys.argv:
        i = sys.argv.index("--html")
        html_at = sys.argv[i + 1] if i + 1 < len(sys.argv) else os.path.join(ROOT, "reports", "grades.html")

    previous = load(STORE, {})
    merged = dict(previous)
    changes, sources, problems = [], {}, []

    for name, collect in adapters(local_only=local_only):
        try:
            found = collect(log=(lambda m: None) if quiet else log)
            sources[name] = {"ok": True, "items": len(found)}
            if local_only: sources[name]["observed_at"] = model.utcnow()
        except cb.ChromeError as e:
            # No session, or the tab went away. Not a fault worth shouting about:
            # this job never asks him to log in.
            sources[name] = {"ok": False, "error": str(e)[:200]}
            problems.append(f"{name}: {str(e)[:120]}")
            continue
        except Exception as e:
            sources[name] = {"ok": False, "error": str(e)[:200]}
            problems.append(f"{name}: {type(e).__name__}: {str(e)[:120]}")
            continue

        for rec in found:
            was = merged.get(rec["key"])
            what = model.changed(was, rec)
            merged[rec["key"]] = model.merge(was, rec)
            if what:
                changes.append({"key": rec["key"], "course": rec["course"],
                                "item": rec["item"], "change": what,
                                "state": merged[rec["key"]]["state"],
                                "percent": merged[rec["key"]].get("percent"),
                                "at": model.utcnow()})

    save(STORE, merged)
    records = list(merged.values())

    if not quiet:
        print()
        print(report.render_text(records))
        print()
    for c in changes:
        pct = "" if c["percent"] is None else f" ({c['percent']:.0f}%)"
        log(f"CHANGED {c['course']}: {c['item']} — {c['change']}{pct}")
    if not changes and not quiet:
        log("no grade changes")

    if html_at:
        os.makedirs(os.path.dirname(html_at), exist_ok=True)
        with open(html_at, "w") as f:
            f.write(report.render_html(records))
        log(f"wrote {html_at}")

    ok = all(s.get("ok") for s in sources.values()) if sources else False
    graded = [r for r in records if r.get("percent") is not None]
    status = {
        "ran_at": model.utcnow(),
        "overall": "ok" if ok else "problem",
        "message": (f"{len(records)} item(s) tracked, {len(graded)} graded, "
                    f"{len(changes)} change(s) this run") if ok
                   else "; ".join(problems)[:200],
        "problems": problems,
        "sources": sources,
        "tracked": len(records),
        "changes": len(changes),
    }
    if local_only:
        status.update(mode="local_only", source_collection="ok" if ok else "problem",
            overall="partial" if ok else "problem",
            submission_reconciliation="not_attempted", publication="not_attempted")
        if ok:
            status["message"] = "Grade sources checked locally; submission reconciliation and publication not attempted"
    save(STATUS, status)

    if "--publish" in sys.argv:
        publish(records, graded, changes)

    if "--json" in sys.argv:
        print(json.dumps({"records": records, "changes": changes, "sources": sources}, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
