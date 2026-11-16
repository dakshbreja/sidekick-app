#!/usr/bin/env python3
"""Copy exported class notes into Google Drive, one dated file per class per day.

Writes through the Google Drive desktop mount, so this works from a headless
launchd job. Nothing is ever overwritten - each day is its own file, which is
what "accumulate, don't overwrite" means on the Drive side.
"""
import json, os, shutil, sys

ROOT  = os.path.expanduser("~/Claude/school-system-suite/meetings")
STATE = os.path.join(ROOT, ".state.json")
DRIVE = os.path.expanduser(
    "~/Library/CloudStorage/owner@example.com/My Drive/"
    "College/UGA/Year 4 - 2026-27/Classes/Fall 2026")
DAILIES = "07 - Dailies & Class Notes"

def safe(name):
    return "".join(c for c in name if c not in '/:\\').strip()

def main():
    if not os.path.isdir(DRIVE):
        print("Drive mount not available: %s" % DRIVE)
        return 2

    state = json.load(open(STATE)) if os.path.exists(STATE) else {"exported": {}}
    state.setdefault("drive", {})

    copied = failed = 0
    for sid, rec in sorted(state["exported"].items(), key=lambda kv: kv[1]["date"]):
        if not rec.get("course") or state["drive"].get(sid):
            continue
        src = os.path.join(ROOT, rec["path"])
        if not os.path.exists(src):
            print("%-10s missing source %s" % (rec["course"], rec["path"])); failed += 1; continue

        course_dir = os.path.join(DRIVE, rec["course"])
        dest_dir = os.path.join(course_dir, DAILIES)
        try:
            os.makedirs(dest_dir, exist_ok=True)
            title = safe(rec["title"])[:70]
            dest = os.path.join(dest_dir, "%s - %s.md" % (rec["date"], title))
            n = 2
            while os.path.exists(dest):          # never clobber a prior day's file
                dest = os.path.join(dest_dir, "%s - %s (%d).md" % (rec["date"], title, n)); n += 1
            shutil.copy2(src, dest)
            state["drive"][sid] = os.path.relpath(dest, DRIVE)
            print("%-10s -> %s" % (rec["course"], os.path.relpath(dest, DRIVE)))
            copied += 1
        except Exception as e:
            print("%-10s FAILED %s" % (rec["course"], str(e)[:120])); failed += 1

    json.dump(state, open(STATE, "w"), indent=2)
    print("drive sync: %d copied, %d failed" % (copied, failed))
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())
