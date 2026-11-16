#!/usr/bin/env python3
"""Group a course's per-item text files into a few large Knowledge bundles.

ChatGPT caps Knowledge at 20 *files* per GPT, but a single file can hold far more
than a semester of course text. The sweep used to spend one slot per source
document, so MGMT 4280 reached 17/20 two weeks into the term with 272 KB of
content — full on slots, nearly empty on bytes, and refusing to accept the class
notes that were actually worth having.

Bundling trades slots for size, which is the resource we have. Four bundles per
course leaves 16 slots free and does not grow with the number of documents.

The bundles are rebuilt wholesale from `<course>/text/*.txt` every time, never
appended to. A rebuild is cheap, and it means a corrected or superseded source
file propagates instead of leaving its old text stranded inside a bundle.
"""
import hashlib
import os
import re
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Order matters: the first matching category wins, so put the specific patterns
# above the general ones. A file that matches nothing lands in Course_Materials,
# which is the honest place for "we have it but cannot classify it".
CATEGORIES = [
    ("Transcripts",       lambda n: n.endswith("_transcript.txt")),
    ("Syllabus_and_Admin", lambda n: re.search(
        r"syllabus|exam.*study.*guide|study.*guide|schedule|policies|grading", n, re.I)),
    ("Lecture_Decks",     lambda n: re.search(r"class[_ ]?\d+|lecture|week[_ ]?\d+", n, re.I)),
    ("Course_Materials",  lambda n: True),
]

# Two extractions of the same PDF differ only in their "Extracted <date>" line, so
# an exact hash never catches them. This compares the body after the header block.
NEAR_DUPLICATE = 0.97


def categorize(name):
    for cat, match in CATEGORIES:
        if match(name):
            return cat
    return "Course_Materials"


def body_of(text):
    """Everything after the header rule, which is what actually has to be unique."""
    parts = text.split("=" * 72, 1)
    return (parts[1] if len(parts) > 1 else text).strip()


def title_of(text, fallback):
    m = re.match(r"#\s*(.+)", text)
    return m.group(1).strip() if m else fallback


def _similar(a, b):
    """Cheap length-gated ratio — difflib on every pair is O(n^2) on big files."""
    if not a or not b:
        return 0.0
    lo, hi = sorted((len(a), len(b)))
    if lo / hi < NEAR_DUPLICATE:          # too different in size to be duplicates
        return 0.0
    import difflib
    return difflib.SequenceMatcher(None, a, b).quick_ratio()


def _rank(course, path, body):
    """Preference between two copies of the same document: current format first.

    Files the sweep writes today are named "<COURSE>_<slug>.txt" and carry a
    provenance header; the legacy "NN_Topic.txt" bundles are frozen artefacts of
    the August export and nothing refreshes them.
    """
    name = os.path.basename(path)
    return (bool(re.search(r"_ELC_[0-9]+", name)), name.startswith(course + "_"), len(body))


def collect(course):
    """{category: [(path, text)]} for one course, near-duplicates dropped.

    Returns (groups, dropped) so the caller can log what was folded away rather
    than silently losing a file the user believes is uploaded.
    """
    text_dir = os.path.join(ROOT, course, "text")
    if not os.path.isdir(text_dir):
        return {}, []
    groups, dropped = {}, []
    names = sorted(os.listdir(text_dir))
    for name in names:
        if not name.endswith(".txt"):
            continue
        path = os.path.join(text_dir, name)
        try:
            text = Path(path).read_text()
        except OSError as e:
            dropped.append((name, f"unreadable: {e}"))
            continue
        cat = categorize(title_of(text, name)) if re.search(r"_ELC_[0-9]+\.txt$", name) else categorize(name)
        kept = groups.setdefault(cat, [])
        body = body_of(text)
        dupe = None
        for i, (other_path, other_text) in enumerate(kept):
            # Word-frequency similarity can fold two different lectures together.
            # Cluely session identity is authoritative, even on repeated topics.
            topic = re.search(r"^Source topic ID: (.+)$", text, re.M)
            other_topic = re.search(r"^Source topic ID: (.+)$", other_text, re.M)
            if topic and other_topic and topic[1] != other_topic[1]:
                continue
            session = re.search(r"^Session ID: (.+)$", text, re.M)
            other_session = re.search(r"^Session ID: (.+)$", other_text, re.M)
            if session or other_session:
                if not (session and other_session and session[1] == other_session[1]):
                    continue
            if _similar(body, body_of(other_text)) >= NEAR_DUPLICATE:
                dupe = i
                break
        if dupe is None:
            kept.append((path, text))
            continue
        # Prefer the copy the sweep still maintains over a legacy one it has
        # stopped touching, and only then the longer body. Length alone picked
        # wrong here: the legacy 00_Syllabus.txt carries no "=" rule, so its
        # header counted as body and it beat the current, better-sourced export
        # of the same PDF by ~100 chars of its own heading.
        other_path, other_text = kept[dupe]
        if _rank(course, path, body) > _rank(course, other_path, body_of(other_text)):
            kept[dupe] = (path, text)
            dropped.append((os.path.basename(other_path),
                            f"near-duplicate, superseded by {name}"))
        else:
            dropped.append((name, "near-duplicate, superseded by "
                            f"{os.path.basename(other_path)}"))
    return groups, dropped


def render(course, category, items):
    """One bundle file: a contents list, then every source file in full."""
    titles = [title_of(t, os.path.basename(p)) for p, t in items]
    out = [
        f"# {course} — {category.replace('_', ' ')}",
        "",
        f"{len(items)} source document(s), bundled for GPT Knowledge. Each section "
        f"below is one document, reproduced in full with its own provenance header.",
        "",
        "## Contents",
        "",
    ]
    out += [f"{i}. {t}" for i, t in enumerate(titles, 1)]
    out += ["", "#" * 72, ""]
    for i, (path, text) in enumerate(items, 1):
        out += [f"### Document {i} of {len(items)}: {titles[i-1]}", "",
                text.rstrip(), "", "#" * 72, ""]
    return "\n".join(out).rstrip() + "\n"


def build(course, log=print):
    """Rebuild every bundle for one course. Returns [(path, changed_bool)]."""
    groups, dropped = collect(course)
    for name, why in dropped:
        log(f"{course}: folded out {name} — {why}")
    bdir = os.path.join(ROOT, course, "bundles")
    os.makedirs(bdir, exist_ok=True)

    written = []
    # Stable order so a bundle's identity does not depend on directory listing.
    for category, _ in CATEGORIES:
        items = groups.get(category)
        if not items:
            old_path = os.path.join(bdir, f"{course}_{category}.txt")
            if not os.path.isfile(old_path):
                continue
            items = []  # Replace formerly populated categories, don't retain stale Knowledge.
        items.sort(key=lambda pt: os.path.basename(pt[0]))
        body = render(course, category, items)
        path = os.path.join(bdir, f"{course}_{category}.txt")
        old = Path(path).read_text() if os.path.exists(path) else None
        changed = old != body
        if changed:
            with open(path, "w") as f:
                f.write(body)
        written.append((path, changed))
        log(f"{course}: {os.path.basename(path)} — {len(items)} doc(s), "
            f"{len(body):,} chars{'' if changed else ' (unchanged)'}")
    return written


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()[:16]


if __name__ == "__main__":
    import sys
    courses = sys.argv[1:] or sorted(
        d for d in os.listdir(ROOT)
        if os.path.isdir(os.path.join(ROOT, d, "text")))
    for c in courses:
        build(c)
