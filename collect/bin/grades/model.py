#!/usr/bin/env python3
"""One shape for a piece of graded work, whichever system it lives in.

Gradescope, the eLC gradebook and GLO-BUS each describe the same thing — a piece of
work and how far along it is — in three incompatible vocabularies. Normalising here
means the tracker, the diff and the report never learn which system an item came
from, and a fourth source later is one adapter rather than a rewrite.

SCORES STAY ON THIS MACHINE. Nothing in this package posts a percentage to the
bridge: the bridge is a public hostname behind one API key that also sits in six GPT
configs and in /openapi/<key>.json, and "what did I get on the midterm" is not
something to put behind that.
"""
from datetime import datetime, timezone

# Daksh's vocabulary, kept verbatim rather than translated into LMS jargon.
#
#   pending      released, nothing started
#   in_progress  started but not turned in — only ever self-reported, since no
#                LMS can see work that has not been submitted
#   completed    submitted, waiting on a mark
#   graded       carries a score
#
# Ordered: a later state never falls back to an earlier one on its own. A grader
# unsubmitting work is real but rare, and treating it as "your submission vanished"
# on every flaky scrape would be worse than being slightly slow to notice.
STATES = ["pending", "in_progress", "completed", "graded"]
RANK = {s: i for i, s in enumerate(STATES)}


def utcnow():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def key(course, item):
    """Stable identity for an item across runs, tolerant of retitling whitespace."""
    norm = " ".join(str(item).split()).lower()
    return f"{course}:{norm}"


def record(course, item, *, state, score=None, out_of=None, due=None,
           released=None, source=None, url=None, raw=None):
    """One normalised item. `score`/`out_of` never leave this machine."""
    if state not in RANK:
        raise ValueError(f"unknown state {state!r}; expected one of {STATES}")
    pct = None
    if score is not None and out_of:
        try:
            pct = round(100.0 * float(score) / float(out_of), 1)
        except (TypeError, ValueError, ZeroDivisionError):
            pct = None
    return {
        "key": key(course, item),
        "course": course,
        "item": " ".join(str(item).split()),
        "state": state,
        "score": score,
        "out_of": out_of,
        "percent": pct,
        "due": due,
        "released": released,
        "source": source,
        "url": url,
        "raw": raw,
        "seen_at": utcnow(),
    }


def is_overdue(rec, now=None):
    """Past its due date and not turned in.

    Deliberately derived rather than stored: "overdue" is a fact about the clock,
    not about the item, and a stored flag would be wrong the moment midnight passed.
    """
    if rec["state"] in ("completed", "graded") or not rec.get("due"):
        return False
    try:
        due = datetime.fromisoformat(rec["due"].replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return False
    if due.tzinfo is None:
        due = due.replace(tzinfo=timezone.utc)
    return due < (now or datetime.now(timezone.utc))


def merge(previous, incoming):
    """Fold a freshly scraped item over what we already knew.

    Two rules, both learned from what the sources can and cannot see:

    * A scrape never demotes. Gradescope reports "No Submission" for work that is
      genuinely in progress, because in_progress exists only in Daksh's head. If a
      scrape could pull an item backwards, every run would erase the fact that he
      had started something.
    * Self-reported in_progress yields to any scraped state above it. Once the LMS
      says the work is in, "I started it" is stale and the LMS is authoritative.
    """
    if previous is None:
        return incoming
    out = dict(previous)
    out.update({k: v for k, v in incoming.items() if v is not None or k not in out})
    if RANK[incoming["state"]] >= RANK[previous["state"]]:
        out["state"] = incoming["state"]
    else:
        out["state"] = previous["state"]
    out["seen_at"] = incoming["seen_at"]
    return out


def changed(previous, incoming):
    """What a human would call a change — not every field that moved.

    `seen_at` moves on every run and would make everything look new; the whole
    point of the diff is that a quiet run reports nothing.
    """
    if previous is None:
        return "new"
    if previous["state"] != incoming["state"]:
        return f"{previous['state']} -> {incoming['state']}"
    if previous.get("score") != incoming.get("score") and incoming.get("score") is not None:
        return "score changed"
    return None
