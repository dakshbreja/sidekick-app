#!/usr/bin/env python3
"""Context check for Cluely session exports, run before anything reaches the bridge.

Cluely writes one transcript per *recording window*, not per meeting, and it mixes
two audio channels into it: the room mic (labelled with your name) and system audio
(labelled "Them"). Two failure modes follow from that, and both have already put
wrong material in front of the class GPTs:

  1. Foreign audio. Anything playing through the speakers while the recorder is
     running lands in the same transcript. On 2026-08-25 the first 15 minutes of
     the MGMT 5850 recording were a college-admissions podcast; Cluely summarised
     it as class content and generated "Action Items for Daksh" about extracurriculars.

  2. Ungrounded summary. Cluely's summariser can assert things the transcript does
     not contain. The 2026-08-24 MGMT 5560 summary claimed the class "Looked up
     'what is KV in Cloudflare'" and gave the instructor's email; neither string
     occurs anywhere in the transcript.

So the summary is never trusted on its own. Every claim pushed to the bridge has to
be traceable to the class portion of the transcript, and the class portion has to be
separated from whatever else the microphone picked up.

CLI:  verify.py <file.md> [...]        report on exported sessions
      verify.py --json <file.md>       machine-readable, for push_notes.py
"""
import json, os, re, sys

# A speaker channel has to hold this share of a window to be called dominant, and a
# foreign stretch has to run this long before it is worth reporting. Both are set to
# tolerate normal classroom back-and-forth: a professor playing a 90-second video
# clip is not contamination, fifteen minutes of unrelated conversation is.
FOREIGN_MIN_SECONDS = 180
DOMINANCE           = 0.60
WINDOW              = 60          # bucket size when scanning for channel handover

# A summary bullet is called ungrounded when this share of its distinctive words is
# absent from the transcript. Summaries legitimately paraphrase, so the bar is high
# and short bullets are exempt - the target is invented specifics, not rewording.
UNGROUNDED_RATIO = 0.70
UNGROUNDED_MIN_TOKENS = 4

STOP = set("""
the a an and or of to in on for with is are was were be been being it its this that these those as at by from into
class classes course courses if not no yes we you i he she they them our your his her their all any each more most
per via than then so such but also can could may might must shall should will would do does did done have has had
about after before during while over under between within without across up down out off again further once here
there when where why how what which who whom whose because until against among throughout despite towards upon
will can new use used using make made get got go going one two three four five six seven eight nine ten
""".split())

# Vocabulary that marks a transcript as genuinely belonging to its course. Drawn from
# the syllabi, not from any one lecture, so a single off-topic day does not fail.
COURSE_TERMS = {
    "BUSN5000": """data science r rstudio markdown knit csv dataset variable regression mean median
        distribution sample statistic cps labor force participation reproducib chunk plot histogram
        gradescope elc analysis code script""",
    "MGMT4280": """supply chain analytics logistics inventory forecast demand supplier procurement erp mrp
        warehouse shipping carrier lead time optimization decision model risk uncertainty kpi lab
        distribution sourcing""",
    "MGMT5560": """strategy strategic international global competitive advantage industry firm market entry
        multinational corporate diversification acquisition alliance resource capability positioning
        case analysis porter rivalry""",
    "MGMT5850": """compensation pay wage salary benefit incentive merit bonus performance appraisal reward
        employee hr human resource equity motivation retention turnover job evaluation raise flsa
        market survey grade structure""",
    "LAND2510": """architecture built environment building design landscape city urban historic style column
        temple facade plan classical medieval renaissance""",
    "BUSN3040": """r programming vector data frame function package tidyverse ggplot script variable loop
        dplyr analytics business""",
}

TURN_RE = re.compile(r"^(?P<sp>[^\n]{1,40}?)\n(?P<ts>\d{1,2}:\d{2}(?::\d{2})?)\n+(?P<tx>.*?)(?=\n[^\n]{1,40}?\n\d{1,2}:\d{2}(?::\d{2})?\n|\Z)", re.S | re.M)


def tokens(s):
    out = []
    for w in re.findall(r"[A-Za-z][A-Za-z'’\-]{2,}|\d{2,}", s.lower()):
        w = w.strip("'’-")
        if w and w not in STOP:
            out.append(w)
    return out


def seconds(ts):
    parts = [int(p) for p in ts.split(":")]
    return parts[0] * 60 + parts[1] if len(parts) == 2 else parts[0] * 3600 + parts[1] * 60 + parts[2]


def parse_turns(transcript):
    """[(speaker, seconds, text)] in order. Cluely emits SPEAKER / M:SS / text blocks."""
    # Native Copy Transcript uses "Speaker [M:SS]: text"; the desktop DOM
    # exporter uses separate lines. Both are the same recorded evidence.
    transcript = re.sub(r"^([^\n]{1,40}?) \[(\d{1,2}:\d{2}(?::\d{2})?)\]: ?",
                        r"\1\n\2\n", transcript, flags=re.M)
    turns = []
    for m in TURN_RE.finditer(transcript):
        sp = m.group("sp").strip()
        tx = m.group("tx").strip()
        if sp and tx:
            turns.append((sp, seconds(m.group("ts")), tx))
    return turns


def split_sections(summary):
    """[(heading, [bullets])] preserving order; ungrouped lead lines go under ''."""
    out, cur, buf = [], "", []
    for line in summary.splitlines():
        line = line.rstrip()
        if not line.strip() or line.strip() == "Resume Session":
            continue
        h = re.match(r"^#{1,4}\s+(.*)", line)
        bullet = re.match(r"^\s*[-*•]\s+|^\s*\d+\.\s+", line)
        # Cluely's own copy button emits headings as bare lines, not markdown.
        if h or (not bullet and len(line) < 60 and not line.rstrip().endswith((".", ";", ":", ","))):
            if cur or buf:
                out.append((cur, buf))
            cur, buf = (h.group(1).strip() if h else line.strip()), []
        else:
            buf.append(re.sub(r"^\s*(?:[-*•]|\d+\.)\s*", "", line).strip())
    if cur or buf:
        out.append((cur, buf))
    return [(h, b) for h, b in out if h or b]


# Words that get capitalised mid-sentence without being entities, plus the scaffolding
# Cluely's own summaries use. Anything here is never treated as an invented name.
ENTITY_ALLOW = set("""
i i'm i've monday tuesday wednesday thursday friday saturday sunday january february march april may june
july august september october november december action items announcements resources logistics summary
overview class course professor dr mr mrs ms university college department fall spring semester ai
""".split())

ENTITY_RE = re.compile(r"""
    (?P<email>[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})
  | (?P<url>https?://\S+|\b[a-z0-9-]+\.(?:com|org|edu|net|io)\b)
  | (?P<camel>\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b)          # PeerDoc, LockDown, Cloudflare-style compounds
  | (?P<title>\b[A-Z][a-z][A-Za-z'’-]{3,}\b)            # needs a lowercase tail: skips ACRONYMS
""", re.X)


def _dictionary():
    for p in ("/usr/share/dict/words", "/usr/dict/words"):
        if os.path.exists(p):
            try:
                with open(p, encoding="utf-8", errors="ignore") as f:
                    return {w.strip().lower() for w in f if w.strip()}
            except OSError:
                pass
    return set()


DICT = _dictionary()


def _is_ordinary_word(w):
    """True for plain English capitalised mid-sentence, e.g. Communicate, Fairness."""
    w = w.lower().rstrip("'’s").rstrip("'’")
    if w in DICT:
        return True
    for suffix, base in (("ies", "y"), ("es", ""), ("s", "")):
        if w.endswith(suffix) and (w[: -len(suffix)] + base) in DICT:
            return True
    return False


def find_invented_entities(sections, transcript_low, exclude_text=""):
    """Named things the summary asserts that appear nowhere in the class transcript.

    Ratio checks miss these: a bullet can be 60% ordinary vocabulary and still hang
    on one fabricated proper noun. "Looked up what is KV in Cloudflare" scored as
    grounded because only the word "Cloudflare" was invented - and that word was the
    entire claim. Names, emails and domains are checked individually and exactly.

    Only bullets are scanned. Cluely's section headings ("Business Discussion Topics")
    are title-cased by construction and assert nothing, so scanning them produced
    almost nothing but false positives.
    """
    exclude = exclude_text.lower()
    found = {}
    for _, bullets in sections:
        for b in bullets:
            # Sentence-initial capitals carry no signal, so skip the leading word of
            # each sentence; a word that only ever appears there is almost certainly
            # ordinary vocabulary that happened to start the line.
            for sent in re.split(r"(?<=[.;:!?])\s+", b):
                for m in ENTITY_RE.finditer(sent):
                    word, kind = m.group(0), m.lastgroup
                    if kind == "title" and (m.start() == 0 or _is_ordinary_word(word)):
                        continue
                    if word.lower() in ENTITY_ALLOW or word.lower() in exclude:
                        continue
                    if word.lower() in transcript_low:
                        continue
                    found.setdefault(word, b[:150])
    return [{"entity": w, "bullet": b} for w, b in found.items()]


def channel_timeline(turns):
    """Per-minute-bucket turn counts by speaker, for spotting a channel handover."""
    buckets = {}
    for sp, sec, _ in turns:
        buckets.setdefault(sec // WINDOW, {}).setdefault(sp, 0)
        buckets[sec // WINDOW][sp] += 1
    return buckets


def find_foreign_blocks(turns, class_channel):
    """Contiguous stretches dominated by a channel other than the class channel."""
    if not turns:
        return []
    buckets = channel_timeline(turns)
    if not buckets:
        return []
    flagged = []
    for b in range(min(buckets), max(buckets) + 1):
        counts = buckets.get(b, {})
        total = sum(counts.values())
        if not total:
            flagged.append(None)
            continue
        other = total - counts.get(class_channel, 0)
        flagged.append(b if other / total >= DOMINANCE else None)

    blocks, run = [], []
    for i, f in enumerate(flagged + [None]):
        if f is not None:
            run.append(f)
            continue
        if run:
            start, end = run[0] * WINDOW, (run[-1] + 1) * WINDOW
            if end - start >= FOREIGN_MIN_SECONDS:
                blocks.append((start, end))
            run = []
    return blocks


def pick_class_channel(turns):
    """The channel holding the most speaking turns overall.

    In an in-person lecture the room mic carries the professor, and Cluely labels
    that channel with the account holder's name - so the class channel is usually
    "Daksh" even though he is not the one talking. For an online class it would be
    the system-audio channel instead. Counting turns gets both right without
    hardcoding either.
    """
    counts = {}
    for sp, _, _ in turns:
        counts[sp] = counts.get(sp, 0) + 1
    return max(counts, key=counts.get) if counts else None


def check(course, title, summary, transcript):
    turns = parse_turns(transcript)
    low = transcript.lower()
    issues, notes = [], []
    foreign_headings = set()

    class_channel = pick_class_channel(turns)
    counts = {}
    for sp, _, _ in turns:
        counts[sp] = counts.get(sp, 0) + 1

    # --- 1. foreign audio -------------------------------------------------
    foreign = find_foreign_blocks(turns, class_channel)
    class_turns = turns
    if foreign:
        for start, end in foreign:
            sample = " ".join(t for _, s, t in turns if start <= s < end)[:180]
            issues.append({
                "kind": "foreign_audio",
                "detail": "%s-%s of the recording is dominated by a channel other than the class "
                          "channel (%r)" % (fmt(start), fmt(end), class_channel),
                "sample": sample,
            })
        class_turns = [t for t in turns
                       if not any(start <= t[1] < end for start, end in foreign)]

    class_text = " ".join(t for _, _, t in class_turns).lower()

    # --- 2. course fit ----------------------------------------------------
    terms = COURSE_TERMS.get((course or "").replace(" ", "").upper(), "").split()
    hits = sorted({t for t in terms if t in class_text})
    if terms:
        if len(hits) < 3:
            issues.append({
                "kind": "course_mismatch",
                "detail": "class portion matches only %d %s vocabulary terms (%s)"
                          % (len(hits), course, ", ".join(hits) or "none"),
            })
        else:
            notes.append("course fit: %d/%d terms present" % (len(hits), len(terms)))

    # --- 3. summary grounded in the class portion -------------------------
    sections = split_sections(summary)
    ungrounded = []
    for heading, bullets in sections:
        for b in bullets:
            tk = tokens(b)
            if len(tk) < UNGROUNDED_MIN_TOKENS:
                continue
            missing = [w for w in tk if w not in class_text]
            if len(missing) / len(tk) >= UNGROUNDED_RATIO:
                ungrounded.append({
                    "heading": heading, "bullet": b[:150],
                    "missing": sorted(set(missing))[:12],
                })
    if ungrounded:
        issues.append({
            "kind": "ungrounded_summary",
            "detail": "%d summary bullet(s) assert specifics absent from the class transcript"
                      % len(ungrounded),
            "bullets": ungrounded,
        })

    # --- 3b. bullets that belong to the foreign audio, not the class ------
    #
    # A ratio test alone is not enough here. "Identify one authentic extracurricular
    # you can commit to for the next year" is mostly ordinary words that do occur in
    # a compensation lecture, so it scored as grounded even though every specific in
    # it came from the podcast. Asking which side of the recording explains a bullet
    # better separates them cleanly.
    if foreign:
        foreign_text = " ".join(t for _, s, t in turns
                                if any(a <= s < b for a, b in foreign)).lower()
        def sides(text):
            tk = set(tokens(text))
            return (sum(1 for w in tk if w in foreign_text and w not in class_text),
                    sum(1 for w in tk if w in class_text and w not in foreign_text),
                    len(tk))

        stolen = []
        for heading, bullets in sections:
            # Score the heading with its own bullets folded in. A heading is short,
            # so on its own it rarely carries enough signal - but "College Admissions
            # Advice" over admissions bullets is unambiguous, and taking the whole
            # section out also removes the one generic bullet under it that would
            # otherwise survive on ordinary vocabulary alone.
            hf, hc, hn = sides(heading + " " + " ".join(bullets))
            if heading and hn >= UNGROUNDED_MIN_TOKENS and hf > hc:
                foreign_headings.add(heading)
                stolen.append({
                    "heading": heading, "bullet": "(whole section) %s" % heading[:120],
                    "missing": ["section explained by %d:%d foreign:class terms" % (hf, hc)],
                })
                continue
            for b in bullets:
                bf, bc, bn = sides(b)
                if bn < UNGROUNDED_MIN_TOKENS:
                    continue
                if bf > bc:
                    stolen.append({
                        "heading": heading, "bullet": b[:150],
                        "missing": ["explained by %d:%d foreign:class terms" % (bf, bc)],
                    })
        if stolen:
            issues.append({
                "kind": "foreign_topic",
                "detail": "%d summary item(s) describe the foreign audio rather than the class"
                          % len(stolen),
                "bullets": stolen,
            })

    invented = find_invented_entities(sections, class_text, "%s %s" % (title, course))
    if invented:
        issues.append({
            "kind": "invented_entity",
            "detail": "%d name(s)/address(es) in the summary occur nowhere in the class "
                      "transcript: %s" % (len(invented), ", ".join(i["entity"] for i in invented[:8])),
            "bullets": [{"bullet": "%s  <- %s" % (i["bullet"], i["entity"]), "missing": [i["entity"]]}
                        for i in invented],
        })

    # --- 4. speaker labels ------------------------------------------------
    if turns and class_channel and counts.get(class_channel, 0) / len(turns) > 0.95:
        notes.append("speaker labels collapsed: %.0f%% of turns tagged %r, so attribution "
                     "inside the transcript is unreliable"
                     % (100 * counts[class_channel] / len(turns), class_channel))

    return {
        "course": course, "title": title,
        "turns": len(turns), "class_turns": len(class_turns),
        "class_channel": class_channel, "channels": counts,
        "foreign_blocks": [[s, e] for s, e in foreign],
        "issues": issues, "notes": notes, "foreign_headings": sorted(foreign_headings),
        "ok": not issues,
        "blocking": [i["kind"] for i in issues if i["kind"] in ("course_mismatch",)],
    }


def fmt(sec):
    return "%d:%02d" % (sec // 60, sec % 60)


def clean_summary(course, title, summary, transcript):
    """Return (kept_sections, dropped, report) with unverifiable material removed.

    What survives is only what the class portion of the transcript supports, so this
    is what push_notes.py sends to the bridge. Dropping is deliberately one-way: a
    bullet that cannot be traced is discarded rather than softened, because the GPTs
    read these notes aloud as fact and a hedged fabrication is still a fabrication.
    """
    r = check(course, title, summary, transcript)
    turns = parse_turns(transcript)
    foreign = [(s, e) for s, e in r["foreign_blocks"]]
    class_turns = [t for t in turns if not any(s <= t[1] < e for s, e in foreign)]
    class_text = " ".join(t for _, _, t in class_turns).lower()

    bad_bullets = set()
    for i in r["issues"]:
        for b in i.get("bullets", []):
            bad_bullets.add(b["bullet"].split("  <- ")[0][:150])

    kept, dropped = [], []
    foreign_headings = set(r.get("foreign_headings", []))
    for heading, bullets in split_sections(summary):
        if heading and heading in foreign_headings:
            dropped.extend((heading, b) for b in bullets)
            continue
        keep = []
        for b in bullets:
            if b[:150] in bad_bullets:
                dropped.append((heading, b))
            else:
                keep.append(b)
        if keep:
            kept.append((heading, keep))

    # A section whose bullets all vanished takes its heading with it, and a summary
    # left with nothing usable is not worth pushing at all.
    return kept, dropped, r


def from_file(path):
    text = open(path).read()
    fm = dict(re.findall(r"^(\w+):\s*(.*)$", re.match(r"^---\n(.*?)\n---\n", text, re.S).group(1), re.M)) \
        if re.match(r"^---\n", text) else {}
    m = re.search(r"^## Summary\n(.*?)(?=^## Transcript)", text, re.S | re.M)
    summary = m.group(1).strip() if m else ""
    transcript = text.split("## Transcript", 1)[1] if "## Transcript" in text else ""
    return check(fm.get("course", ""), fm.get("title", "").strip('"'), summary, transcript)


def report(r, path=""):
    head = "%s  [%s]" % (os.path.basename(path) or r["title"], r["course"] or "no course")
    print("=" * 78); print(head); print("-" * 78)
    print("  turns %d (class portion %d)   channels: %s"
          % (r["turns"], r["class_turns"], ", ".join("%s=%d" % kv for kv in sorted(r["channels"].items(), key=lambda k: -k[1]))))
    for n in r["notes"]:
        print("  note   %s" % n)
    if not r["issues"]:
        print("  OK     no contamination detected")
    for i in r["issues"]:
        print("  ISSUE  [%s] %s" % (i["kind"], i["detail"]))
        if i.get("sample"):
            print("         sample: %s..." % i["sample"][:150])
        for b in i.get("bullets", [])[:6]:
            print("         - %s" % b["bullet"][:110])
            print("           missing from transcript: %s" % ", ".join(b["missing"][:8]))
        extra = len(i.get("bullets", [])) - 6
        if extra > 0:
            print("         ... and %d more" % extra)


def main():
    args = [a for a in sys.argv[1:] if a != "--json"]
    as_json = "--json" in sys.argv[1:]
    if not args:
        print(__doc__); return 2
    out = []
    for p in args:
        r = from_file(p)
        r["path"] = p
        out.append(r)
        if not as_json:
            report(r, p)
    if as_json:
        print(json.dumps(out, indent=1))
    return 1 if any(r["issues"] for r in out) else 0


if __name__ == "__main__":
    sys.exit(main())
