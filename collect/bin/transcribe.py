#!/usr/bin/env python3
"""Turn a lecture video into a transcript the class GPT can actually read.

eLC serves lecture video as `<name>.mp4.zip` — a ~1GB archive holding one .mp4.
Nothing downstream can use that: Knowledge takes text, and even if it took video
it caps well below a gigabyte. So the video is only useful once it is words, and
until now that conversion was the missing link that left 04/05/06 in the GPT as
slides with no spoken content.

Accuracy is the whole point here, so two choices are deliberate:

  * **The slides prime the decoder.** Whisper is good at English and bad at proper
    nouns it has never seen — the existing lecture-01 transcript calls the
    instructor "Sam Nash Riggs" (she is Samantha Riggs), and a lecture on Mughal
    India is wall-to-wall names that a general model will cheerfully invent. Every
    lecture already has its slide deck extracted next door in text/, which is a
    near-perfect glossary for that exact lecture. We mine it for proper nouns and
    feed them as the initial prompt, carried across every window rather than just
    the first.

  * **Audio is extracted, not streamed.** ffmpeg cannot reliably read .mp4 from a
    pipe because the moov atom is usually at the end of the file, so the archive is
    unpacked to a temp dir and the video deleted the moment the 16kHz mono WAV
    exists. Peak extra disk is about one video.

Usage:
  transcribe.py COURSE VIDEO_OR_ZIP "Topic Title" ["Unit"]
  transcribe.py --check COURSE TRANSCRIPT   # accuracy report against the slides
"""
import difflib
from array import array
from collections import Counter
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
import wave
from datetime import datetime

ROOT = os.path.expanduser("~/Claude/school-system-suite/collect")
MODEL = os.path.join(ROOT, "models", "ggml-large-v3-turbo.bin")
VIDEO_EXT = (".mp4", ".mov", ".m4v", ".avi", ".mkv")
AUDIO_EXT = (".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg")
MEDIA_EXT = VIDEO_EXT + AUDIO_EXT
THREADS = "8"
PROMPT_WORDS = 60           # initial prompt caps at n_text_ctx/2 tokens; stay well under

# Capitalised words that carry no domain signal, so they never belong in the prompt.
STOP = set("""The This That These Those There Then They Them Their When Where What Which
While With Without Within And But For From Into Over Under After Before Between During
About Above Across Against Along Among Around Because Been Being Both Each Either Every
Here However Just More Most Much Must Never Not Now Only Other Our Out Same Should Since
Some Such Than Then Through Thus Very Was Were Will Would You Your Yes All Also Any Are
As At Be By Can Could Did Do Does Down Even First Second Third Get Had Has Have How If In
Is It Its Let Like Made Make May Might New No Off On One Or So Take Their Time To Too Two
Up Use Used Using We Well Went Were Will Slide Slides Page Pages Lecture Week Course Quiz
Exam Introduction Overview Summary Chapter Part Figure Image Source Note Notes Contents
Extracted Document History Built Environment Fall Spring Semester
Photo Photos Unsplash Wikimedia Commons Flickr Getty Pixabay Shutterstock Image Images
Credit Credits Author License Licence Creative Public Domain Copyright Attribution
Retrieved Available Https Http""".split())


def log(msg):
    print(msg, flush=True)


# ---------------------------------------------------------------- input handling
def locate_video(path, workdir):
    """Return a playable video path, unpacking a .zip into workdir if needed."""
    if path.lower().endswith(MEDIA_EXT):
        return path
    if not zipfile.is_zipfile(path):
        return None
    with zipfile.ZipFile(path) as z:
        names = [n for n in z.namelist()
                 if n.lower().endswith(MEDIA_EXT) and not n.startswith("__MACOSX")]
        if not names:
            return None
        name = max(names, key=lambda n: z.getinfo(n).file_size)
        log(f"    unpacking {os.path.basename(name)} "
            f"({z.getinfo(name).file_size / 1e9:.2f} GB)")
        z.extract(name, workdir)
        return os.path.join(workdir, name)


def to_wav(video, wav):
    """16kHz mono PCM — exactly what whisper wants, and ~1/100th the size."""
    subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", video,
         "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav],
        check=True)
    return wav


def duration(path):
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=60).stdout.strip()
        return float(out)
    except Exception:
        return 0.0


# ------------------------------------------------------------ vocabulary priming
def lecture_number(title):
    m = re.match(r"\s*(\d{1,2})", title)
    return m.group(1).zfill(2) if m else None


def slide_text_for(course, title):
    """Find the slide-deck text that belongs to this lecture, by leading number."""
    tdir = os.path.join(ROOT, course, "text")
    if not os.path.isdir(tdir):
        return None
    num = lecture_number(title)
    if not num:
        return None
    pat = re.compile(rf"(?:^|_){num}[_ ]")
    for f in sorted(os.listdir(tdir)):
        if f.endswith(".txt") and "transcript" not in f.lower() and pat.search(f):
            return os.path.join(tdir, f)
    # Topic-bound extraction filenames carry identity rather than a lecture
    # number. Read only their bounded source title, never transcript bodies.
    matches = []
    for f in sorted(os.listdir(tdir)):
        if not re.fullmatch(re.escape(course) + r"_ELC_\d+\.txt", f):
            continue
        path = os.path.join(tdir, f)
        try:
            with open(path) as source:
                header = source.readline(1200).strip()
        except (OSError, UnicodeError):
            continue
        prefix = f"# {course} — "
        if header.startswith(prefix) and lecture_number(header[len(prefix):]) == num:
            matches.append(path)
    if len(matches) == 1:
        return matches[0]
    return None


def course_vocab(course):
    """Optional per-course spellings, one term per line in <COURSE>/vocab.txt.

    Exists because the highest-value corrections are the ones the slides cannot
    supply. The instructor's own name is the standing example: lecture 01 came back
    as "Sam Nash Riggs" for Samantha Riggs, and no slide deck ever spells it out.
    """
    path = os.path.join(ROOT, course, "vocab.txt")
    if not os.path.isfile(path):
        return []
    with open(path, errors="replace") as f:
        return [ln.strip() for ln in f
                if ln.strip() and not ln.startswith("#")]


def build_prompt(course, title):
    """Mine the matching slide deck for proper nouns and rare terms.

    This is the single biggest accuracy lever available: the decoder is being told,
    up front, the exact spellings it is about to hear.
    """
    src = slide_text_for(course, title)
    if not src:
        manual = course_vocab(course)
        if not manual:
            return "", None
        return ("This is a university lecture on the history of the built "
                "environment. Proper nouns used: " + ", ".join(manual) + "."), None
    with open(src, errors="replace") as f:
        body = f.read()
    body = re.sub(r"^#.*$|^Source:.*$|^Extracted.*$|^Contents:.*$|^=+$", "",
                  body, flags=re.M)

    counts = {}
    for w in re.findall(r"\b[A-Z][A-Za-zÀ-ɏ'-]{3,}\b", body):
        if w in STOP or w.isupper():
            continue
        counts[w] = counts.get(w, 0) + 1
    manual = course_vocab(course)
    budget = PROMPT_WORDS - len(manual)
    ranked = sorted(counts, key=lambda w: (-counts[w], w))[:max(budget, 0)]
    terms = manual + [w for w in ranked if w not in manual]
    if not terms:
        return "", src
    prompt = ("This is a university lecture on the history of the built "
              "environment. Proper nouns used: " + ", ".join(terms) + ".")
    return prompt, src


FUNCTION_WORDS = set("""a an the and or but of in on at to for from by with as is are
was were be been being it its this that these those he she they we you i not no so
if then than there here when where which who whom whose how why what will would can
could may might must shall should do does did have has had into over under above
below out up down off about after before during through came come goes go went""".split())

CREDIT = re.compile(r"unsplash|flickr|wikimedia|getty|pixabay|creative commons"
                    r"|https?://|photo by|image by|courtesy of|\ball rights\b", re.I)


def deck_proper_nouns(course, title):
    """Return (correction targets, every word in the deck, source path).

    Two sets, not one, and the difference matters. Targets are terms frequent enough
    to be what the lecture is about (>=2 mentions) — those are what a mis-heard word
    gets snapped to. The second set is every word the deck contains at any
    frequency, and it exists purely to protect: if the transcript's spelling appears
    anywhere in the deck, it is defensible and must not be "corrected". That is what
    keeps Borobudur (7 mentions, alongside 2 of Barabudur) and Ashoka (1 mention,
    alongside 2 of Asoka) intact.

    Credit lines are excluded from targets — "Photo by Jane on Unsplash, Krong Siem
    Reap" would otherwise put photographers in the glossary.
    """
    src = slide_text_for(course, title)
    if not src:
        return {}, set(), None
    with open(src, errors="replace") as f:
        deck = f.read()
    counts, everything = {}, set()
    for line in deck.splitlines():
        for w in re.findall(r"\b[A-Za-z][A-Za-zÀ-ɏ'-]{2,}\b", line):
            everything.add(w.lower())
        if CREDIT.search(line) or line.startswith(("#", "Source:", "Extracted", "=")):
            continue
        for w in re.findall(r"\b[A-Z][A-Za-zÀ-ɏ'-]{3,}\b", line):
            if w in STOP or w.isupper():
                continue
            counts[w] = counts.get(w, 0) + 1
    return ({w.lower(): w for w, n in counts.items() if n >= 2}, everything, src)


def _english():
    try:
        with open("/usr/share/dict/words", errors="replace") as f:
            return {w.strip().lower() for w in f}
    except OSError:
        return set()


def _stem(w):
    """Crudest possible inflection strip. Only needs to catch English plurals and
    possessives, because those are the false positives this guards against."""
    for suf, repl in (("'s", ""), ("ies", "y"), ("es", ""), ("s", "")):
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            return w[:-len(suf)] + repl
    return w


def _split_word_fix(text, terms, english):
    """Rejoin a proper noun the decoder heard as two ordinary words.

    Single-token repair cannot reach these: lecture 04 rendered the Generalife —
    the summer palace beside the Alhambra, and a near-certain exam term — as "the
    General Life", and both halves are perfectly good English, so every guard in
    glossary_fix correctly declined to touch them. The giveaway is only visible one
    level up: concatenate the pair and it is a slide-deck term.

    Only long, non-English deck terms are candidates, which is what stops this from
    rewriting ordinary prose that happens to sit next to itself.
    """
    # A target with an internal capital is a PDF-extraction artifact where a space
    # was lost ("SurroundingDistricts", "TarragonaCathedral"). The transcript's
    # spaced version is the correct one, so those must never be targets.
    targets = {k: v for k, v in terms.items()
               if len(k) >= 7 and k not in english
               and not any(c.isupper() for c in v[1:])}
    if not targets:
        return text, []
    by_letter = {}
    for k in targets:
        by_letter.setdefault(k[0], []).append(k)

    toks = list(re.finditer(r"[A-Za-z][A-Za-z'-]*", text))
    out, fixes, last, i = [], [], 0, 0
    while i < len(toks) - 1:
        a, b = toks[i], toks[i + 1]
        if text[a.end():b.start()] in (" ", "-", " - "):
            joined = (a.group() + b.group()).lower()
            pool = by_letter.get(joined[0], [])
            # Swallowing a following function word is the failure mode here: without
            # this, "gardens of" collapsed to "Gardens" and the "of" was deleted
            # outright. A real split proper noun never has a preposition as its
            # second half.
            if (pool and joined not in english
                    and b.group().lower() not in FUNCTION_WORDS
                    and a.group().lower() not in targets):
                m = difflib.get_close_matches(joined, pool, n=1, cutoff=0.85)
                # Length must match almost exactly. "andalusiais" scores 0.95
                # against "andalusia" purely because it is a prefix.
                if m and abs(len(joined) - len(m[0])) <= 1:
                    out.append(text[last:a.start()])
                    out.append(targets[m[0]])
                    fixes.append((f"{a.group()} {b.group()}", targets[m[0]]))
                    last = b.end()
                    i += 2
                    continue
        i += 1
    out.append(text[last:])
    return "".join(out), fixes


def glossary_fix(text, course, title, *, apply=False):
    """Repair proper nouns the decoder mis-heard, using the slide deck as truth.

    Priming reduces these but does not eliminate them — lecture 06 still produced
    "muru" for Meru and "Asaka" for Asoka. The correction is deliberately timid,
    because a wrong fix is worse than a wrong transcript, and the first draft of this
    was not timid enough: it happily rewrote "Aryans" to "Aryan" and "India's" to
    "India", destroying grammar to match a glossary. A token is only touched when
    every one of these holds:

      * neither it nor its singular stem is an English word,
      * it does not appear anywhere in the slide deck,
      * it is not merely an inflected form of the deck term,
      * a deck term shares its first letter, sits within two characters of its
        length, and matches at >=0.75 similarity.

    Decoder priming is automatic. Fuzzy post-edits require explicit reviewed use:
    even a capitalized unknown word can be a different valid entity (Mongolia
    versus Mongols). The normal pipeline preserves the decoder's wording.
    Every applied substitution is returned so the run can print what it changed.
    """
    if not apply:
        return text, []
    terms, deck_all, _ = deck_proper_nouns(course, title)
    if not terms:
        return text, []
    english = _english()
    if not english:
        return text, []  # Without the ordinary-word guard, fuzzy repair is unsafe.
    mapping = {}
    for w in set(re.findall(r"\b[A-Za-z][A-Za-z'-]{3,}\b", text)):
        if not w[0].isupper():
            continue  # Do not turn ordinary lower-case prose into a deck's title words.
        lw = w.lower()
        stem = _stem(lw)
        ordinary_forms = {lw, stem}
        if lw.endswith("s"):
            ordinary_forms.add(lw[:-1])  # places/place; the legacy stem may choose -es.
        if lw.endswith("es"):
            ordinary_forms.add(lw[:-2])
        if lw.endswith("ies"):
            ordinary_forms.add(lw[:-3] + "y")
        if lw.endswith("ed"):
            ordinary_forms.update((lw[:-1], lw[:-2]))  # completed/complete, worked/work
        if lw.endswith("ing"):
            ordinary_forms.update((lw[:-3], lw[:-3] + "e"))
        if ordinary_forms & english or lw in deck_all or stem in deck_all:
            continue
        m = difflib.get_close_matches(lw, terms.keys(), n=1, cutoff=0.75)
        if not m:
            continue
        c = m[0]
        if c[0] != lw[0] or abs(len(c) - len(lw)) > 2:
            continue
        if stem == c or stem == _stem(c) or lw.startswith(c) or c.startswith(lw):
            continue                      # an inflection, not a mishearing
        mapping[w] = terms[c]
    if mapping:
        pat = re.compile(r"\b(" + "|".join(re.escape(k) for k in sorted(
            mapping, key=len, reverse=True)) + r")\b")
        text = pat.sub(lambda m: mapping[m.group(1)], text)
    text, split_fixes = _split_word_fix(text, terms, english)
    return text, sorted(mapping.items()) + sorted(set(split_fixes))


# --------------------------------------------------------------------- whisper
def run_whisper(wav, out_prefix, prompt):
    if not os.path.isfile(MODEL):
        raise RuntimeError(f"whisper model missing: {MODEL}")
    cmd = ["whisper-cli", "-m", MODEL, "-f", wav, "-l", "en",
           "-t", THREADS, "-otxt", "-ovtt", "-of", out_prefix,
           "-sns", "-np", "-pp"]
    if prompt:
        # Without --carry-initial-prompt the glossary only reaches the first
        # 30-second window, which is useless on an hour of audio.
        cmd += ["--prompt", prompt, "--carry-initial-prompt"]
    subprocess.run(cmd, check=True)
    return out_prefix + ".txt", out_prefix + ".vtt"


def collapse_loops(text, run_len=4):
    """Drop whisper's silence loops: the same line repeated many times over.

    Left in, they poison a Knowledge file — the GPT quotes the repetition back as
    if the instructor said it. Anything under `run_len` repeats is kept, because
    lecturers do legitimately repeat a short phrase.
    """
    out, prev, run = [], None, 0
    for line in text.splitlines():
        s = line.strip()
        if s and s == prev:
            run += 1
            if run >= run_len:
                continue
        else:
            run = 0
        out.append(line)
        if s:
            prev = s
    return "\n".join(out)


def silent_pcm(path):
    """Reject effectively silent 16-bit PCM before a decoder can invent speech.

    This checks the entire decoded source, without claiming to detect speech.
    A peak <=32/32768 (about -60dBFS) is unusable audio for transcription.
    """
    with wave.open(str(path), "rb") as source:
        if source.getsampwidth() != 2 or source.getcomptype() != "NONE":
            raise ValueError("unsupported_pcm")
        while chunk := source.readframes(65536):
            samples = array("h", chunk)
            if sys.byteorder != "little":
                samples.byteswap()
            if any(abs(sample) > 32 for sample in samples):
                return False
        return True


def assess_transcript(body, duration_seconds=0):
    """A conservative usability gate, not a promise of transcript accuracy."""
    words = re.findall(r"[\w']+", str(body).lower())
    lines = [re.sub(r"\W+", " ", line.lower()).strip()
             for line in str(body).splitlines() if line.strip()]
    lines = [line for line in lines if line]
    reason = None
    if not words:
        reason = "transcript_empty"
    elif len(lines) >= 4 and Counter(lines).most_common(1)[0][1] / len(lines) >= .75:
        reason = "transcript_repetitive"
    elif duration_seconds >= 60 and (len(words) < 20 or len(set(words)) < 8):
        reason = "transcript_low_content"
    return {"ok": reason is None, "reason": reason,
            "word_count": len(words), "unique_words": len(set(words))}


def validate_transcript_path(path):
    """Read only marked machine transcripts; other extraction types are separate."""
    from pathlib import Path
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    if not lines or "(lecture transcript)" not in lines[0]:
        return {"ok": True, "reason": None, "not_transcript": True}
    parts = re.split(r"^={10,}\s*$", text, maxsplit=1, flags=re.M)
    body = parts[1] if len(parts) == 2 else ""
    match = re.search(r"Machine transcript of ([\d.]+) minutes", parts[0])
    seconds = float(match.group(1)) * 60 if match else 0
    return assess_transcript(body, seconds)


# ----------------------------------------------------------------------- driver
def transcribe(course, raw_path, title, unit="", keep_wav=False):
    """Video -> transcripts/*.txt|vtt and a text/*_transcript.txt for GPT upload."""
    from elc_daily import slug          # one naming convention, defined once

    tdir = os.path.join(ROOT, course, "transcripts")
    kdir = os.path.join(ROOT, course, "text")
    os.makedirs(tdir, exist_ok=True)
    os.makedirs(kdir, exist_ok=True)
    stem = slug(title)
    work = tempfile.mkdtemp(prefix="elc-transcribe-")
    try:
        video = locate_video(raw_path, work)
        if not video:
            return None, "no video track inside archive"
        secs = duration(video)
        log(f"    {secs/60:.1f} min of video, extracting audio")
        wav = to_wav(video, os.path.join(work, "audio.wav"))
        if video.startswith(work):
            os.remove(video)            # reclaim the gigabyte immediately
        if silent_pcm(wav):
            return None, "transcript_silent_audio"

        prompt, src = build_prompt(course, title)
        if src:
            log(f"    primed from {os.path.basename(src)} "
                f"({len(prompt.split(', '))} terms)")
        else:
            log("    no matching slide deck — running unprimed")

        log("    transcribing")
        txt, vtt = run_whisper(wav, os.path.join(tdir, stem), prompt)
        with open(txt, errors="replace") as f:
            body = collapse_loops(f.read()).strip()
        quality = assess_transcript(body, secs)
        if not quality["ok"]:
            return None, quality["reason"]
        body, fixes = glossary_fix(body, course, title)
        for bad, good in fixes:
            log(f"    glossary: {bad} -> {good}")
        with open(txt, "w") as f:
            f.write(body + "\n")

        dest = os.path.join(kdir, f"{course}_{stem}_transcript.txt")
        header = [
            f"# {course} — {title} (lecture transcript)",
            "",
            f"Source: UGA eLC (D2L) > {unit} > {os.path.basename(raw_path)}",
            f"Machine transcript of {secs/60:.0f} minutes of lecture audio, produced "
            f"{datetime.now().strftime('%Y-%m-%d')} by whisper large-v3-turbo.",
            "Spoken content only — the slide text is a separate file. Proper nouns "
            "were primed from the slide deck but may still be imperfect; trust the "
            "slides over this file where they disagree.",
            "", "=" * 72, "",
        ]
        with open(dest, "w") as f:
            f.write("\n".join(header) + body + "\n")
        if keep_wav:
            shutil.copy(wav, os.path.join(tdir, stem + ".wav"))
        return dest, None
    except subprocess.CalledProcessError as e:
        return None, f"{os.path.basename(e.cmd[0])} failed (exit {e.returncode})"
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    a = [x for x in sys.argv[1:] if not x.startswith("--")]
    if len(a) < 3:
        print(__doc__.strip().splitlines()[-3], file=sys.stderr)
        sys.exit(2)
    course, path, title = a[0], a[1], a[2]
    unit = a[3] if len(a) > 3 else ""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    dest, note = transcribe(course, path, title, unit,
                            keep_wav="--keep-wav" in sys.argv)
    print(dest or f"FAILED: {note}")
    sys.exit(0 if dest else 1)
