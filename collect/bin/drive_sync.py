#!/usr/bin/env python3
"""File eLC material into Google Drive in its original format, named by week.

The daily sweep already downloads originals into <COURSE>/raw/ and extracts text for
the GPTs. The text is for the GPTs; this is the copy Daksh actually opens. It goes to
the Drive course folders in the format the instructor posted - never converted.

Placement and naming follow the convention established on 2026-08-25:

    01 - Syllabus & Course Info     syllabus, schedule, setup and access material
    02 - Slides                     lecture decks and topic overviews
    03 - Lecture Videos             video, when it is filed rather than transcribed
    05 - Exams                      study guides and exam material
    06 - Readings & IRL             papers, datasets, IRL pieces
    Project                         project packs and briefs

    "W03 - Making Inferences.pdf"   when the eLC unit names a week
    "Making Inferences.pdf"         when it does not - a week is never invented

Instructors revise material mid-term. When a file lands on a name that already holds
*different* bytes, the newer copy takes the name and the older one moves to
Superseded/ stamped with its date, because a silent overwrite destroys the only record
of what the syllabus used to say.

CLI:
    drive_sync.py --reconcile          file anything in raw/ that Drive is missing
    drive_sync.py --reconcile --dry-run
"""
import hashlib, json, os, re, shutil, sys, tempfile, time

ROOT  = os.path.expanduser("~/Claude/school-system-suite/collect")
DRIVE = os.path.expanduser("~/Library/CloudStorage/owner@example.com/"
                           "My Drive/College/UGA/Year 4 - 2026-27/Classes/Fall 2026")

COURSE_DIR = {"BUSN5000": "BUSN 5000", "LAND2510E": "LAND 2510E", "MGMT4280": "MGMT 4280",
              "MGMT5560": "MGMT 5560", "MGMT5850": "MGMT 5850", "BUSN3040E": "BUSN 3040E",
              "BUSN3040": "BUSN 3040E"}

SYL, SLIDE, VIDEO = "01 - Syllabus & Course Info", "02 - Slides", "03 - Lecture Videos"
EXAM, READ, PROJ  = "05 - Exams", "06 - Readings & IRL", "Project"

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".avi", ".wmv", ".mkv"}
AUDIO_EXT = {".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg"}
DOC_EXT   = {".pdf", ".pptx", ".ppt", ".docx", ".doc", ".xlsx", ".xls", ".csv", ".zip",
             ".rmd", ".r", ".txt", ".md", ".html", ".htm"}


def _norm(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def folder_for(title, unit, ext):
    """Pick the destination folder from the eLC unit, falling back to the title."""
    u, t = (unit or "").lower(), (title or "").lower()
    both = u + " " + t
    if ext.lower() in VIDEO_EXT | AUDIO_EXT:
        return VIDEO
    if "exam" in both or "study guide" in t:
        return EXAM
    if "project" in u:
        return PROJ
    if any(k in both for k in ("syllabus", "schedule", "start here", "orientation",
                               "registration", "reg codes", "access", "sign-up",
                               "sign up", "setup", "tutorial")):
        return SYL
    if any(k in both for k in ("reading", "podcast", "additional resource", "irl",
                               "homework", "dataset", "data description", "extract")):
        return READ
    return SLIDE


def week_of(unit):
    """'... > Week 3 - Making Infer' -> 'W03'; 'Weeks 6-7' -> 'W06-07'; else None."""
    if not unit:
        return None
    m = re.search(r"weeks?\s*(\d{1,2})\s*[-–]\s*(\d{1,2})", unit, re.I)
    if m:
        return "W%02d-%02d" % (int(m.group(1)), int(m.group(2)))
    m = re.search(r"weeks?\s*(\d{1,2})", unit, re.I)
    return "W%02d" % int(m.group(1)) if m else None


def chapter_of(title):
    """'ch. 2 Comp Strategy ppt' -> ('Ch02', 'Comp Strategy')."""
    m = re.match(r"\s*ch(?:apter|\.)?\s*(\d{1,2})\s*[-:.]?\s*(.*)", title or "", re.I)
    if not m:
        return None, title
    rest = re.sub(r"\bppt\b|\boutline\b", "", m.group(2), flags=re.I).strip(" -:")
    return "Ch%02d" % int(m.group(1)), (rest or "Slides")


def clean_title(title):
    t = re.sub(r"\s+", " ", (title or "").strip())
    t = re.sub(r"[\\/:*?\"<>|]", "-", t)
    return t[:110] or "Untitled"


# Items that already have a hand-chosen name in Drive. A revision arrives from eLC
# under the instructor's own filename ("MGMT5850 syllabus F26"), which would land
# beside the curated copy as a second file instead of replacing it - and a stale
# syllabus sitting next to the current one is worse than no copy at all. Pinning the
# canonical name is what lets the supersede path fire on the revision.
CANONICAL = {
    "BUSN5000": {"syllabusprintversion": (SYL, "BUSN 5000 Syllabus - Fall 2026.pdf"),
                 "scheduleprintversion": (SYL, "BUSN 5000 Schedule - Fall 2026.pdf")},
    "LAND2510E": {"fall2026land2510esyllabus": (SYL, "LAND 2510E Syllabus - Fall 2026.pdf"),
                  "land2510escheduletfall2026": (SYL, "LAND 2510E Schedule - Fall 2026.pdf"),
                  "land2510eschedulefall2026": (SYL, "LAND 2510E Schedule - Fall 2026.pdf")},
    "MGMT4280": {"mgmt4280supplychainanalyticssyllabusfall2026":
                 (SYL, "MGMT 4280 Syllabus - Fall 2026.pdf")},
    "MGMT5560": {"mgmt5560hillfall2026syllabus37814copy":
                 (SYL, "MGMT 5560 Syllabus - Fall 2026.pdf"),
                 "mgmt5560hillfall2026syllabus53168":
                 (SYL, "MGMT 5560 Syllabus - Fall 2026.pdf"),
                 "courseschedule080726": (SYL, "MGMT 5560 Course Schedule (07 Aug 26).xlsx")},
    "MGMT5850": {"mgmt5850syllabusf26": (SYL, "MGMT 5850 Syllabus - Fall 2026.docx")},
}


def canonical_for(course, title, ext):
    """(folder, filename) when this item has a pinned name, else None."""
    hit = CANONICAL.get(course, {}).get(_norm(title))
    if not hit:
        return None
    folder, name = hit
    # Honour the incoming extension if the instructor changed format mid-term.
    if os.path.splitext(name)[1].lower() != ext.lower():
        name = os.path.splitext(name)[0] + ext
    return folder, name


def dest_name(title, unit, ext):
    """Final filename: week or chapter prefix when one can be established, else plain."""
    ch, rest = chapter_of(title)
    if ch:
        return "%s - %s%s" % (ch, clean_title(rest), ext)
    wk = week_of(unit)
    base = clean_title(title)
    if wk and not base.upper().startswith(wk):
        return "%s - %s%s" % (wk, base, ext)
    return base + ext


def sha(p):
    h = hashlib.sha1()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


CACHE = os.path.join(ROOT, ".drive-index.json")


def _load_cache():
    try:
        return json.load(open(CACHE))
    except Exception:
        return {}


def _cached_sha(path, cache):
    """sha1 of path, reusing the last result while size and mtime are unchanged.

    This runs on an hourly job and LAND 2510E alone holds ~2.8 GB of lecture video.
    Re-hashing that every wake-up would cost minutes of disk for no new information,
    so a file is only re-read when the filesystem says it actually changed.
    """
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = path
    hit = cache.get(key)
    if hit and hit[0] == st.st_size and hit[1] == st.st_mtime:
        return hit[2]
    try:
        h = sha(path)
    except OSError:
        return None
    cache[key] = [st.st_size, st.st_mtime, h]
    return h


def _index(course_dir, cache=None):
    """hash -> [paths] for one course, so an existing copy is never duplicated."""
    out = {}
    own = cache is None
    cache = _load_cache() if own else cache
    base = os.path.join(DRIVE, course_dir)
    for r, dirs, files in os.walk(base):
        # A historical copy cannot satisfy delivery of the current source. In
        # particular an instructor can revert to bytes that only exist here.
        dirs[:] = [d for d in dirs if d.casefold() != "superseded"]
        for f in files:
            if f.startswith("."):
                continue
            p = os.path.join(r, f)
            h = _cached_sha(p, cache)
            if h:
                out.setdefault(h, []).append(p)
    if own:
        _save_cache(cache)
    return out


def _save_cache(cache):
    # Drop entries for files that no longer exist so the cache cannot grow forever.
    live = {k: v for k, v in cache.items() if os.path.exists(k)}
    tmp = CACHE + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(live, f)
        os.replace(tmp, CACHE)
    except OSError:
        pass


def _current_path(path, course_dir):
    """Keep restored destination hints inside this course's live Drive tree."""
    base = os.path.realpath(os.path.join(DRIVE, course_dir))
    candidate = os.path.realpath(path)
    try:
        relative = os.path.relpath(candidate, base)
        inside = os.path.commonpath([base, candidate]) == base
    except ValueError:
        return False
    return (inside and relative != "." and
            not any(p.startswith(".") or p.casefold() == "superseded"
                    for p in relative.split(os.sep)))


def _archive(path):
    """Retain every revision, including multiple changes on the same day."""
    name = os.path.basename(path)
    stem, ext = os.path.splitext(name)
    stamp = time.strftime("%Y-%m-%d", time.localtime(os.path.getmtime(path)))
    folder = os.path.join(os.path.dirname(path), "Superseded")
    os.makedirs(folder, exist_ok=True)
    base = f"{stem} (as of {stamp})"
    target = os.path.join(folder, base + ext)
    suffix = 2
    while os.path.exists(target):
        target = os.path.join(folder, f"{base} {suffix}{ext}")
        suffix += 1
    shutil.move(path, target)


def file_item(course, raw_path, title, unit, dry=False, index=None,
              preferred_rel=None):
    """Place one downloaded original into Drive.

    Returns (action, relative_path) where action is one of:
      filed      - copied in
      superseded - copied in, and the differing older copy moved to Superseded/
      present    - these bytes are already in this course folder; left alone
      skipped    - not a course we file, or not a filing-worthy extension

    preferred_rel is a previously acknowledged relative destination for this
    source identity. It keeps a renamed topic attached to its current original,
    and prevents a byte match with a different topic from redirecting a revision.
    A format change keeps that destination's stem and adopts the new extension.

    A file whose bytes are already in the course folder is left where it is even if
    this module would have named it differently. Generated names come from raw eLC
    titles, which are often worse than a name chosen by hand ("ERP_MRP_Overview.pdf"
    against "02 - ERP and MRP.pdf"), and a routine that renames on every run would
    churn the folders forever. Absent material is the thing worth acting on.
    """
    cdir = COURSE_DIR.get(course)
    if not cdir or not os.path.exists(raw_path):
        return "skipped", None
    ext = os.path.splitext(raw_path)[1].lower()
    if ext not in DOC_EXT and ext not in VIDEO_EXT and ext not in AUDIO_EXT:
        return "skipped", None
    # A large .zip from eLC is a video pack; those are extracted and the .mp4 filed,
    # so archiving the zip alongside it would just double 1-3 GB in Drive.
    if ext == ".zip" and os.path.getsize(raw_path) > 100_000_000:
        return "skipped", None

    pinned = canonical_for(course, title, ext)
    folder, name = pinned if pinned else (folder_for(title, unit, ext),
                                          dest_name(title, unit, ext))
    dest   = os.path.join(DRIVE, cdir, folder, name)
    rel    = os.path.join(cdir, folder, name)
    previous_dest = None
    if preferred_rel is not None:
        if not isinstance(preferred_rel, str) or os.path.isabs(preferred_rel):
            raise ValueError("invalid prior Drive destination")
        previous_dest = os.path.join(DRIVE, preferred_rel)
        if not _current_path(previous_dest, cdir):
            raise ValueError("prior Drive destination is outside the current course")
        dest = os.path.splitext(previous_dest)[0] + ext
        rel = os.path.relpath(dest, DRIVE)
        if not _current_path(dest, cdir):
            raise ValueError("invalid current Drive destination")

    h = sha(raw_path)
    idx = index if index is not None else _index(cdir, cache=_load_cache()) if dry else _index(cdir)
    # Recheck supplied indexes: earlier filings in this pass may have moved or
    # replaced a path while an old hash bucket still refers to its filename.
    prior = [p for p in idx.get(h, []) if _current_path(p, cdir)
             and os.path.isfile(p) and sha(p) == h]

    if (os.path.isfile(dest) and sha(dest) == h and
            not (previous_dest and previous_dest != dest and os.path.exists(previous_dest))):
        return "present", rel
    if prior and preferred_rel is None:
        return "present", os.path.relpath(prior[0], DRIVE)

    obsolete = []
    if previous_dest and previous_dest != dest and os.path.exists(previous_dest):
        obsolete.append(previous_dest)
    if os.path.exists(dest) and sha(dest) != h:
        obsolete.append(dest)
    action = "superseded" if obsolete else "filed"

    if not dry:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        # Stage the new bytes before moving a usable original. A failed copy
        # therefore leaves the current file intact for the pending retry.
        fd, staged = tempfile.mkstemp(prefix=".material-", dir=os.path.dirname(dest))
        os.close(fd)
        try:
            shutil.copy2(raw_path, staged)
            if sha(staged) != h:
                raise OSError("Drive staging content did not match source")
            for old in obsolete:
                _archive(old)
            os.replace(staged, dest)
        finally:
            if os.path.exists(staged):
                os.remove(staged)
        idx.setdefault(h, []).append(dest)
    return action, rel


def reconcile(dry=False):
    """Ensure every original the sweep has ever downloaded is present in Drive.

    This is what makes a change on eLC land in Drive even when the sweep that pulled
    it predates this step, and what catches a file that was filed once and later lost.
    Titles and units come from .fetched.json / .manifest.json so naming matches what a
    live sweep would produce.
    """
    fetched  = json.load(open(os.path.join(ROOT, ".fetched.json")))
    manifest = json.load(open(os.path.join(ROOT, ".manifest.json")))["courses"]
    meta = {}
    for c, v in manifest.items():
        for it in v.get("items", []):
            meta[str(it["id"])] = (c, it.get("title", ""), it.get("unit", ""))

    cache = _load_cache()
    indexes, results = {}, []
    for fid, rec in sorted(fetched.items(), key=lambda kv: kv[1].get("course", "")):
        raw = rec.get("raw")
        course = rec.get("course")
        if not raw or not course or course not in COURSE_DIR:
            continue
        p = os.path.join(ROOT, course, "raw", raw)
        if not os.path.exists(p):
            continue
        _, title, unit = meta.get(fid, (course, rec.get("title", raw), ""))
        title = title or rec.get("title") or raw
        cdir = COURSE_DIR[course]
        if cdir not in indexes:
            indexes[cdir] = _index(cdir, cache)
        action, rel = file_item(course, p, title, unit, dry=dry, index=indexes[cdir])
        if action not in ("present", "skipped"):
            results.append((action, rel))
    if not dry:
        _save_cache(cache)
    return results


def main():
    dry = "--dry-run" in sys.argv
    if "--reconcile" in sys.argv:
        res = reconcile(dry=dry)
        for action, rel in res:
            print("  %-11s %s" % (action.upper(), rel))
        print("%s: %d change(s)" % ("DRY RUN" if dry else "RECONCILED", len(res)))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
