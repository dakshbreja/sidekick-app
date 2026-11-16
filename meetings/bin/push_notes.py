#!/usr/bin/env python3
"""Push the most recent class-session summary for each course to the GPT status
bridge, where the class GPTs read it as `claude_note`.

Notes are capped at 1500 chars by the Worker, so the summary is condensed:
action items and announcements first, then topics, then hard truncation.
Idempotent - a session is only pushed once (tracked in .state.json).
"""
import json, os, re, sys, time, urllib.request, urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import verify

ROOT  = os.path.expanduser("~/Claude/school-system-suite/meetings")
STATE = os.path.join(ROOT, ".state.json")
ENV   = os.path.expanduser("~/Claude/school-system-suite/bridge/.env")
MAX   = 1100   # per-entry budget; 14 of these fit the Worker's 18000-char cap
KV_CONSISTENCY = 65   # seconds; Cloudflare KV edge reads cache for up to 60s

# Headings worth keeping, most actionable first.
PRIORITY = ["action item", "announcement", "logistics", "resource", "reminder"]

def load_env():
    cfg = {}
    with open(ENV) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip().strip('"').strip("'")
    return cfg

def frontmatter(text):
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m:
        return {}
    fm = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            fm[k.strip()] = v.strip().strip('"')
    return fm

def summary_of(text):
    m = re.search(r"^## Summary\n(.*?)(?=^## Transcript)", text, re.S | re.M)
    return m.group(1).strip() if m else ""

def sections(summary):
    """Split a summary into (heading, [lines]) preserving order."""
    out, cur, buf = [], None, []
    for line in summary.splitlines():
        h = re.match(r"^#{1,4}\s+(.*)", line)
        if h:
            if cur is not None:
                out.append((cur, buf))
            cur, buf = h.group(1).strip(), []
        elif line.strip():
            buf.append(re.sub(r"^[-*]\s*", "", line.strip()))
    if cur is not None:
        out.append((cur, buf))
    return out

def condense(title, date, summary, secs=None):
    head = "%s - class on %s. " % (title, date)
    if secs is None:
        secs = sections(summary)
    if not secs:
        body = re.sub(r"\s+", " ", summary)
        return (head + body)[:MAX]

    def rank(s):
        name = s[0].lower()
        for i, p in enumerate(PRIORITY):
            if p in name:
                return i
        return len(PRIORITY)

    parts, used = [], len(head)
    for name, lines in sorted(secs, key=rank):
        if not lines:
            continue
        chunk = "%s: %s." % (name, "; ".join(lines))
        chunk = re.sub(r"\*\*|\s+", lambda m: "" if m.group(0).startswith("*") else " ", chunk).strip()
        if used + len(chunk) + 1 > MAX - 20:
            break
        parts.append(chunk)
        used += len(chunk) + 1
    text = head + " ".join(parts)
    return text[:MAX].rstrip()

def post_note(cfg, course, payload):
    req = urllib.request.Request(
        cfg["WORKER_URL"].rstrip("/") + "/classnote",
        data=json.dumps(dict(payload, course=course)).encode(),
        headers={"Authorization": "Bearer " + cfg["API_KEY"],
                 "Content-Type": "application/json",
                 "User-Agent": "cluely-notes-bridge/1.0"},
        method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)

def main():
    # KV writes are the scarce resource on the Worker's free tier, so the check can
    # be rehearsed without spending any.
    dry = "--dry-run" in sys.argv[1:]
    # /classnote keys on session_id and updates in place, so re-pushing a session
    # replaces its note rather than duplicating it. That is how a note that was
    # already delivered with contaminated content gets repaired.
    force = "--force" in sys.argv[1:]
    only = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--only=")), None)
    cfg = load_env()
    state = json.load(open(STATE)) if os.path.exists(STATE) else {"exported": {}}
    state.setdefault("pushed", {})

    # Oldest first, so the accumulated list on the Worker reads in order.
    sessions = sorted(
        ((sid, rec) for sid, rec in state["exported"].items() if rec.get("course")),
        key=lambda kv: kv[1]["date"])

    if not sessions:
        print("no class sessions to push"); return 0

    failures = pushed = quota = 0
    last_push_at = {}
    for sid, rec in sessions:
        code = rec["course"].replace(" ", "")
        if only and sid != only:
            continue
        if state["pushed"].get(sid) and not force:
            continue
        path = os.path.join(ROOT, rec["path"])
        if not os.path.exists(path):
            print("%-10s MISSING FILE %s" % (code, rec["path"])); failures += 1; continue
        text = open(path).read()

        # Nothing reaches the bridge unchecked. Cluely merges every audio source it
        # can hear into one session and its summariser will assert things the
        # transcript never contained, so both have already put material in front of
        # the class GPTs that did not happen in that class. Anything the class
        # portion of the transcript cannot support is dropped here.
        transcript = text.split("## Transcript", 1)[1] if "## Transcript" in text else ""
        kept, dropped, rep = verify.clean_summary(
            rec["course"], rec["title"], summary_of(text), transcript)

        if rep["issues"]:
            for i in rep["issues"]:
                print("%-10s CHECK  %s" % (code, i["detail"]))
        if dropped:
            print("%-10s CHECK  dropped %d unverifiable bullet(s) before pushing"
                  % (code, len(dropped)))

        # A course the transcript does not look like at all is a filing error, not a
        # summary problem - trimming cannot fix it, so it needs a human.
        if any(i["kind"] == "course_mismatch" for i in rep["issues"]):
            print("%-10s HELD   transcript does not match %s; not pushed" % (code, code))
            failures += 1
            continue

        note = condense(rec["title"], rec["date"], "", kept)
        if len(note) < 40 or not kept:
            print("%-10s skipped - nothing verifiable to push" % code); continue
        if dry:
            print("%-10s DRY    would push %s (%d chars)" % (code, rec["date"], len(note)))
            print("           %s" % note[:220])
            continue

        # /classnote accumulates by reading the course's list, appending, and writing
        # it back. KV reads are eventually consistent, so two pushes to the *same*
        # course in quick succession make the second one read a stale list and write
        # it back - silently reverting the first. That is not hypothetical: pushing
        # the 20 Aug and 25 Aug MGMT 5850 notes together reverted 20 Aug to the
        # version it had before the context check cleaned it. Consecutive pushes to
        # one course are spaced past KV's cache window.
        wait = KV_CONSISTENCY - (time.time() - last_push_at.get(code, 0))
        if wait > 0:
            print("%-10s waiting %ds so /classnote does not read a stale list"
                  % (code, round(wait)))
            time.sleep(wait)

        try:
            post_note(cfg, code, {
                "text": note, "date": rec["date"],
                "title": rec["title"][:200], "session_id": sid,
            })
            last_push_at[code] = time.time()
            state["pushed"][sid] = code
            print("%-10s pushed %s (%d chars)" % (code, rec["date"], len(note)))
            pushed += 1
        except urllib.error.HTTPError as e:
            body = e.read()[:300]
            # A spent daily KV quota is not a breakage, and conflating the two cost
            # a whole evening: on 24 Aug this printed a bare 500 and the run just
            # said "failed", so the notes sat undelivered with nothing saying they
            # would be fine tomorrow. The Worker now names this case explicitly.
            if e.code == 503 and b"kv_write_limit" in body:
                print("%-10s QUOTA  daily KV write limit spent; not yet delivered"
                      % code)
                quota += 1
            else:
                print("%-10s FAILED %s %s" % (code, e.code, body[:120]))
                failures += 1
        except Exception as e:
            print("%-10s FAILED %s" % (code, str(e)[:120])); failures += 1

    if not pushed and not failures and not quota:
        print("all class sessions already pushed")

    json.dump(state, open(STATE, "w"), indent=2)
    if failures:
        return 1
    # Exit 2 means "nothing is wrong, come back after 00:00 UTC". Nothing was
    # marked pushed, so the next run re-sends it untouched.
    return 2 if quota else 0

if __name__ == "__main__":
    sys.exit(main())
