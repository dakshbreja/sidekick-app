#!/usr/bin/env python3
"""Replace a GPT's per-document Knowledge files with its bundles.

Deletes nothing it cannot prove is reproduced in a bundle. Three categories of
chip are deliberately KEPT rather than migrated:

  * bundles themselves;
  * originals in their posted format (a syllabus PDF or DOCX). The extracted text
    is in a bundle, but the file is not, and a slot is cheaper than losing the
    formatting;
  * anything with no source on disk. LAND 2510E's LECTURE_01/02/03 transcripts and
    BUSN 5000's weekly-schedule.md were uploaded from somewhere the sweep no longer
    tracks, so no bundle can contain them. Deleting those would destroy the only
    copy.

Everything else must match a bundled document byte-for-byte on a mid-document
sample before it is eligible. Coverage by filename or title is not accepted —
a title match would happily "cover" a document whose text was never extracted.

    python3 bin/migrate_gpt_bundles.py COURSE [--dry-run]
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bundle
import chrome_bridge as cb
import gpt_upload as gu

ROOT = os.path.expanduser("~/Claude/school-system-suite/collect")
# Chip text is "<filename><TypeLabel>"; the label set is closed and short.
TYPE_RE = re.compile(r"(PDF|Document|Spreadsheet|Text|Image|Video|File|Audio)$")
KEEP_EXT = (".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".md")
SAMPLE = 180


def chip_name(chip):
    return TYPE_RE.sub("", chip).strip()


def plan(course):
    """(delete, keep, upload, blob_len) — computed before anything is touched."""
    bdir = os.path.join(ROOT, course, "bundles")
    bundles = sorted(os.listdir(bdir)) if os.path.isdir(bdir) else []
    if not bundles:
        raise SystemExit(f"{course}: no bundles built; run bin/bundle.py first")
    blob = "".join(open(os.path.join(bdir, f)).read() for f in bundles)

    tdir = os.path.join(ROOT, course, "text")
    on_disk = {}
    for t in sorted(os.listdir(tdir)) if os.path.isdir(tdir) else []:
        if t.endswith(".txt"):
            on_disk[t] = open(os.path.join(tdir, t)).read()
    return bundles, blob, on_disk


def covered(name, on_disk, blob):
    """True only when a mid-document slice of this file is inside a bundle."""
    body = on_disk.get(name)
    if body is None:
        return False, "no source on disk"
    core = body[len(body) // 2: len(body) // 2 + SAMPLE]
    if core and core in blob:
        return True, "content verified in bundle"
    return False, "source on disk but NOT in any bundle"


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    dry = "--dry-run" in sys.argv
    if not args:
        raise SystemExit(__doc__)
    course = args[0]

    gid = json.load(open(os.path.join(ROOT, "gpts.json"))).get(course)
    if not gid:
        raise SystemExit(f"no GPT id for {course}")
    bundles, blob, on_disk = plan(course)

    win, tab = cb.open_tab(gu.EDITOR % gid)
    try:
        cb.wait_loaded(win, tab, timeout=45)
        state = gu.wait_ready(win, tab)
        if state["instructions"] < gu.MIN_INSTRUCTIONS:
            raise SystemExit(f"{course}: instructions look empty "
                             f"({state['instructions']} chars) — refusing to touch this GPT")
        chips = state["chips"]
        names = [chip_name(c) for c in chips]

        delete, keep = [], []
        for n in names:
            if n in bundles:
                keep.append((n, "bundle")); continue
            if n.lower().endswith(KEEP_EXT):
                keep.append((n, "original format kept")); continue
            ok, why = covered(n, on_disk, blob)
            (delete if ok else keep).append((n, why))

        upload = [b for b in bundles if b not in names]
        print(f"\n=== {course}: {len(chips)} chip(s)")
        for n, why in keep:
            print("   KEEP    %-52s %s" % (n[:50], why))
        for n, why in delete:
            print("   DELETE  %-52s %s" % (n[:50], why))
        for b in upload:
            print("   UPLOAD  %s" % b)
        after = len(chips) - len(delete) + len(upload)
        print(f"   result: {len(chips)} -> {after} chip(s) of {gu.KNOWLEDGE_CAP}")
        if after > gu.KNOWLEDGE_CAP:
            raise SystemExit(f"{course}: would exceed the cap; aborting")
        if dry:
            print("   (dry run — nothing changed)")
            return 0
        if not delete and not upload:
            print("   nothing to do")
            return 0

        bpath = gu.backup(course, gid, state, win, tab)
        print("   backed up ->", os.path.basename(bpath))

        if delete:
            gone = gu.remove_files(win, tab, [n for n, _ in delete],
                                   log=lambda m: print("   " + m))
            if len(gone) != len(delete):
                raise SystemExit(f"{course}: removed {len(gone)}/{len(delete)}; "
                                 f"stopping before upload — Knowledge is unchanged "
                                 f"except for those removals")
            print(f"   removed {len(gone)}")

        if upload:
            for i, b in enumerate(upload):
                gu.send_file(win, tab, os.path.join(ROOT, course, "bundles", b), i)
            res = cb.run_js(win, tab, gu.ATTACH.replace("\n", " "), timeout=60).strip()
            if not res.startswith("attached:"):
                raise SystemExit(f"{course}: attach failed: {res}")
            target = gu.probe(win, tab)["count"]
            deadline = time.time() + 240
            while time.time() < deadline:
                if gu.probe(win, tab)["count"] >= after:
                    break
                time.sleep(3)

        published = False
        for _ in range(3):
            cb.run_js(win, tab, gu.CLICK_UPDATE.replace("\n", " "), timeout=45)
            end = time.time() + 45
            while time.time() < end:
                if gu.probe(win, tab)["updated"]:
                    published = True
                    break
                time.sleep(2)
            if published:
                break
        print("   " + ("PUBLISHED" if published else "NOT PUBLISHED — check the editor"))
        print("   final chips:", gu.probe(win, tab)["count"])
        return 0 if published else 1
    finally:
        cb.close_tab(win, tab)


if __name__ == "__main__":
    sys.exit(main())
