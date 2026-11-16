#!/usr/bin/env python3
"""Push already-extracted text to the bridge's /library store, once.

From now on the sweep pushes each document as it downloads it, but everything
fetched before that existed has text on disk and nothing in the bridge. Without
this, /library would answer for a PDF's metadata and link but return no text until
the instructor happened to repost the file.

Matching is by CONTENT HASH, not by name. drive_sync copies the raw file into
Drive byte for byte but renames it on the way (W03 prefixes, cleaned titles), and
the Drive name is the only key the Worker can see. Reconstructing that name from
the eLC title needs the unit, which .fetched.json does not record — so the bytes
are the join instead, and they cannot be wrong.

    /opt/anaconda3/bin/python3 bin/backfill_library.py [--dry-run] [COURSE ...]
"""
import hashlib
import json
import os
import re
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import drive_sync

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.expanduser("~/Claude/school-system-suite/bridge/.env")
# [^>\n] rather than [^>]: a negated class still matches newlines, so the first
# version ran straight past the header and captured a fragment of the document
# body as the filename.
SOURCE_RE = re.compile(r"^Source: UGA eLC \(D2L\)(?: > [^>\n]*)* > ([^\n]+)$", re.M)


def config():
    env = {}
    with open(CFG) as f:
        for line in f:
            if "=" in line and not line.startswith("#"):
                k, v = line.strip().split("=", 1)
                env[k] = v.strip().strip('"').strip("'")
    if not (env.get("WORKER_URL") and env.get("API_KEY")):
        sys.exit("WORKER_URL / API_KEY missing from ~/Claude/school-system-suite/bridge/.env")
    return env


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def drive_index(course_label):
    """{sha256: filename} for everything filed under this course in Drive."""
    base = os.path.join(drive_sync.DRIVE, course_label)
    index = {}
    if not os.path.isdir(base):
        return index
    for dirpath, _dirs, files in os.walk(base):
        for name in files:
            if name.startswith("."):
                continue
            p = os.path.join(dirpath, name)
            try:
                index[sha(p)] = name
            except OSError:
                pass
    return index


def push(env, payload):
    req = urllib.request.Request(
        env["WORKER_URL"].rstrip("/") + "/library/text",
        data=json.dumps(payload).encode(),
        # Cloudflare in front of the Worker rejects the default Python-urllib
        # user agent with a 403 before the request ever reaches our code, so this
        # has to name something ordinary.
        headers={"Authorization": "Bearer " + env["API_KEY"],
                 "Content-Type": "application/json",
                 "User-Agent": "elc-sweep/1.0"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.loads(r.read())


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    dry = "--dry-run" in sys.argv
    env = config()

    # Course code -> Drive folder label, which is the code with a space in it.
    labels = {}
    for d in sorted(os.listdir(ROOT)):
        if os.path.isdir(os.path.join(ROOT, d, "text")):
            m = re.match(r"^([A-Z]{2,4})(\d{4}[A-Z]?)$", d)
            labels[d] = f"{m.group(1)} {m.group(2)}" if m else d
    courses = args or sorted(labels)

    pushed = skipped = unmatched = 0
    for course in courses:
        label = labels.get(course, course)
        index = drive_index(label)
        print(f"== {course}  ({len(index)} file(s) in Drive/{label})")
        tdir = os.path.join(ROOT, course, "text")
        for name in sorted(os.listdir(tdir)):
            if not name.endswith(".txt"):
                continue
            tpath = os.path.join(tdir, name)
            body = open(tpath).read()
            m = SOURCE_RE.search(body)
            if not m:
                print(f"   -- {name}: no Source header, skipped")
                skipped += 1
                continue
            raw = os.path.join(ROOT, course, "raw", m.group(1).strip())
            if not os.path.isfile(raw):
                print(f"   -- {name}: raw file gone ({os.path.basename(raw)})")
                unmatched += 1
                continue
            drive_name = index.get(sha(raw))
            if not drive_name:
                print(f"   -- {name}: no Drive copy with matching bytes")
                unmatched += 1
                continue
            title = (body.split("\n", 1)[0].lstrip("# ").split("—", 1)[-1].strip()
                     or os.path.splitext(drive_name)[0])
            pages = len(re.findall(r"^## (?:Slide|Page|Sheet)", body, re.M)) or None
            if dry:
                print(f"   DRY {drive_name}  <- {name} ({len(body):,} chars)")
                pushed += 1
                continue
            res = push(env, {"course": course, "filename": drive_name,
                             "title": title, "pages": pages, "text": body})
            print(f"   ok  {drive_name}  ({res.get('chars'):,} chars"
                  + (", TRUNCATED" if res.get("truncated") else "") + ")")
            pushed += 1

    print(f"\n{pushed} pushed, {unmatched} with no Drive match, {skipped} skipped")


if __name__ == "__main__":
    main()
