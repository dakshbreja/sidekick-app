#!/usr/bin/env python3
"""Accuracy report for a lecture transcript.

There is no human ground truth for these lectures, so this does not pretend to
compute a word error rate. It measures the things that actually decide whether a
transcript is usable as GPT Knowledge, each of which has an unambiguous answer:

  1. Proper-noun coverage — of the domain terms the slide deck says this lecture is
     about, how many does the transcript contain? This is the failure mode that
     matters: a transcript that says "Baber" and "Shalimar Bog" is fluent, plausible
     and useless for answering an exam question.
  2. Near-misses — terms that are absent but have a close variant present, which is
     what a proper-noun error looks like from the outside.
  3. Speech-rate plausibility — words per minute against the audio duration. Far
     below ~90 means whole passages were dropped; far above ~200 means invention.
  4. Repetition loops — whisper's signature failure on silence, where one line
     repeats for pages.

Usage: transcript_check.py COURSE TRANSCRIPT.txt [--slides FILE] [--duration MIN]
"""
import os
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcribe as T


def words(text):
    return re.findall(r"[A-Za-zÀ-ɏ'-]+", text)


def norm(w):
    return re.sub(r"[^a-z]", "", w.lower())


def edit1(a, b):
    """Cheap similarity: good enough to spot Babur/Baber, Asoka/Ashoka."""
    if abs(len(a) - len(b)) > 3:
        return 0.0
    same = sum(1 for x, y in zip(a, b) if x == y)
    return same / max(len(a), len(b), 1)


def check(course, transcript_path, slides_path=None, minutes=None):
    with open(transcript_path, errors="replace") as f:
        body = f.read()
    body = re.sub(r"^#.*$|^Source:.*$|^Machine transcript.*$|^Spoken content.*$|^=+$",
                  "", body, flags=re.M)
    toks = words(body)
    seen = {norm(w) for w in toks}

    title = os.path.basename(transcript_path)
    if slides_path is None:
        m = re.search(r"(?:^|_)(\d{2})[_ ]", title)
        slides_path = T.slide_text_for(course, m.group(1)) if m else None

    print(f"# Accuracy report — {title}")
    print()
    print(f"Words: {len(toks):,}")
    if minutes:
        print(f"Duration: {minutes:.1f} min → {len(toks)/minutes:.0f} words/min "
              f"({'plausible' if 90 <= len(toks)/minutes <= 200 else 'SUSPECT'})")

    # --- repetition loops
    lines = [l.strip() for l in body.splitlines() if l.strip()]
    loops, run, prev = [], 1, None
    for l in lines + [None]:
        if l == prev:
            run += 1
        else:
            if run >= 4 and prev:
                loops.append((run, prev[:70]))
            run, prev = 1, l
    print(f"Repetition loops (>=4 identical lines): {len(loops)}")
    for n, txt in loops[:5]:
        print(f"    {n}x  {txt}")

    # --- proper-noun coverage
    # Deliberately reuses transcribe.deck_proper_nouns so the report is scored
    # against exactly the glossary the transcriber used — a checker with its own
    # private notion of "important term" measures the checker, not the transcript.
    terms_map, _, src = T.deck_proper_nouns(course, os.path.basename(transcript_path))
    if slides_path:
        terms_map = {}
        with open(slides_path, errors="replace") as f:
            deck = f.read()
        cnt = Counter()
        for line in deck.splitlines():
            if T.CREDIT.search(line) or line.startswith(("#", "Source:", "=")):
                continue
            for w in re.findall(r"\b[A-Z][A-Za-zÀ-ɏ'-]{3,}\b", line):
                if w not in T.STOP and not w.isupper():
                    cnt[w] += 1
        terms_map = {w.lower(): w for w, n in cnt.items() if n >= 2}
        src = slides_path
    if not terms_map:
        print("\nNo matching slide deck — coverage check skipped.")
        return
    print(f"\nGlossary source: {os.path.basename(src) if src else '?'}")
    terms = sorted(terms_map.values())

    hit, miss, near = [], [], []
    for t in terms:
        n = norm(t)
        if n in seen:
            hit.append(t)
            continue
        best, score = None, 0.0
        for s2 in seen:
            v = edit1(n, s2)
            if v > score:
                best, score = s2, v
        if score >= 0.75:
            near.append((t, best))
        else:
            miss.append(t)

    total = len(terms)
    print(f"Slide-deck proper nouns (>=2 mentions, credits excluded): {total}")
    print(f"    exact in transcript : {len(hit):>3}  ({100*len(hit)/total:.0f}%)")
    print(f"    near-miss variant   : {len(near):>3}  ({100*len(near)/total:.0f}%)")
    print(f"    absent              : {len(miss):>3}  ({100*len(miss)/total:.0f}%)")
    print("\n  Near-misses are the real error signal — an absent term may simply")
    print("  never have been said aloud, but a near-miss was said and mangled.")
    if near:
        print("\n  Near-misses (slide term -> transcript form):")
        for t, b in near[:15]:
            print(f"    {t:<22} -> {b}")
    if miss:
        print("\n  Absent (may simply not be spoken aloud):")
        print("    " + ", ".join(miss[:25]))


if __name__ == "__main__":
    a = [x for x in sys.argv[1:] if not x.startswith("--")]
    if len(a) < 2:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        sys.exit(2)
    mins = None
    if "--duration" in sys.argv:
        mins = float(sys.argv[sys.argv.index("--duration") + 1])
    slides = None
    if "--slides" in sys.argv:
        slides = sys.argv[sys.argv.index("--slides") + 1]
    check(a[0], a[1], slides, mins)
