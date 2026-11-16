#!/usr/bin/env python3
"""Diff a fresh eLC inventory against what we already know about.

Reads inventory JSON on stdin (the output of bin/sweep.js), compares it to
.manifest.json, and reports what is new, renamed or gone. Updates the manifest.

Usage:  pbpaste | ./elc_diff.py        or   ./elc_diff.py < inventory.json
        ./elc_diff.py --dry-run        report without updating the manifest
"""
import json, os, sys
from datetime import datetime, timezone

ROOT = os.path.expanduser("~/Claude/school-system-suite/collect")
MANIFEST = os.path.join(ROOT, ".manifest.json")

def load():
    if os.path.exists(MANIFEST):
        with open(MANIFEST) as f:
            return json.load(f)
    return {"synced_at": None, "courses": {}}

def main():
    dry = "--dry-run" in sys.argv
    raw = sys.stdin.read().strip()
    if not raw:
        print("no inventory on stdin"); return 2
    try:
        inv = json.loads(raw)
    except Exception as e:
        print("could not parse inventory: %s" % e); return 2

    man = load()
    now = datetime.now(timezone.utc).isoformat()
    total_new = 0

    for code in sorted(inv):
        items = inv[code]
        if isinstance(items, str):
            print("%-10s FEED ERROR: %s" % (code, items[:60])); continue

        known = {str(i["id"]): i for i in man["courses"].get(code, {}).get("items", [])}
        fresh = {str(i["id"]): i for i in items}

        added = [fresh[k] for k in fresh if k not in known]
        gone = [known[k] for k in known if k not in fresh]
        # Seeded rows carry a placeholder title; the first real sweep filling it in
        # is not a rename, it is the baseline catching up.
        renamed = [(known[k], fresh[k]) for k in fresh
                   if k in known
                   and known[k].get("title") not in (fresh[k].get("title"), "(seeded)")]

        if not man["courses"].get(code):
            print("%-10s baseline: %d items" % (code, len(items)))
        elif added or gone or renamed:
            print("%-10s %d new, %d gone, %d renamed" % (code, len(added), len(gone), len(renamed)))
            for i in added:
                print("    NEW      [%s] %s  (%s)" % (i.get("ext", "?"), i["title"][:60], i.get("unit", "")[:34]))
                total_new += 1
            for i in gone:
                print("    REMOVED  %s" % i["title"][:60])
            for old, new in renamed:
                print("    RENAMED  %s  ->  %s" % (old["title"][:34], new["title"][:34]))
        else:
            print("%-10s no change (%d items)" % (code, len(items)))

        man["courses"][code] = {"items": items, "checked_at": now}

    man["synced_at"] = now
    if not dry:
        with open(MANIFEST, "w") as f:
            json.dump(man, f, indent=2)

    print("\n%s | %d new item(s) across all courses" % (now[:19], total_new))
    if total_new:
        print("Download new items with bin/sweep.js topic IDs + the DirectFileTopicDownload URL.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
