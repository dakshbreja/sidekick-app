#!/usr/bin/env python3
"""Daily eLC sweep: detect new course material, download it, extract text, alert.

Runs from launchd. Every step is a no-op unless BrowserOS neo is running AND Daksh has a
live eLC session — this job never asks him to log in and never touches credentials.
When there is no session it logs one line and exits 0.

The GPT Knowledge upload used to be the one manual step, on the grounds that a file
input cannot be populated from a path by JavaScript. That is true but beside the
point: `DataTransfer` can set input.files from a File built in the page, and the
bytes can be handed over from here. bin/gpt_upload.py does that, so the sweep now
runs download -> extract -> upload end to end with nobody watching.

Anything that fails to upload stays in .pending-upload.json and is retried on the
next run. That file, not the report, is the source of truth — reports/latest.md is
overwritten every sweep, so a pending list that lived only there went silent the
moment the next run finished.

  --dry-run      report what would happen; touch no state, download nothing
  --force        run even if the last successful run was less than MIN_GAP ago
  --upload-only  skip the eLC sweep; just retry the pending upload queue
  --source-only  exact-file Neo capture and local extraction/queueing only;
                 no native Downloads, Drive, bridge, reconciliation or GPT upload
"""
import hashlib
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import time
import tempfile
import zipfile
from pathlib import Path
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bundle
import chrome_bridge as cb
import drive_sync
import elc_announcements
import elc_submission
import gpt_upload
import material_bridge
import material_delivery
import direct_material_capture
import material_revisions
import native_material_intake
import transcribe
from extract_text import extract

ROOT = os.path.expanduser("~/Claude/school-system-suite/collect")
BIN = os.path.join(ROOT, "bin")
MANIFEST = os.path.join(ROOT, ".manifest.json")
FETCHED = os.path.join(ROOT, ".fetched.json")
STATE = os.path.join(ROOT, ".daily-state.json")
PENDING = os.path.join(ROOT, ".pending-upload.json")
REPORTS = os.path.join(ROOT, "reports")
LOG = os.path.join(ROOT, "logs", "daily.log")
DOWNLOADS = os.path.expanduser("~/Downloads")
BRIDGE_NOTE = os.path.expanduser("~/Claude/school-system-suite/bridge/note.sh")

ELC = "https://uga.view.usg.edu"
HOME = ELC + "/d2l/home"
# After a good sweep, don't re-sweep for this long. Was 8h, which meant an
# afternoon run succeeding at ~4pm left the next one due around midnight — so
# material posted in the evening sat unnoticed overnight. That is exactly what
# happened to MGMT 5560's GLO-BUS registration codes on 24 Aug. The 8h figure was
# chosen when each sweep cost KV writes it could not afford; now that a sweep with
# nothing new costs zero writes, the only real cost is a background tab for a few
# seconds, so there is no reason to be this stingy.
MIN_GAP_SECONDS = 4 * 3600
PROBE_GAP_SECONDS = 3 * 3600        # backoff after an unconfirmed/dead session probe
DOWNLOAD_BATCH = 6                  # Chrome silently stops after ~8 rapid downloads
DOWNLOAD_GAP = 2.5
# Backstop against a bad course-detection dumping a whole past semester to disk.
# A normal delta is 0-3 files; anything near this is a bug, so it stops and says so.
MAX_DOWNLOADS_PER_RUN = 25
FILE_TYPES = ("File",)              # ContentService/Link topics are not downloadable
MAX_UPLOAD_ATTEMPTS = 5             # backoff growth bound, never an abandonment cap
MAX_TRANSCRIBE_PER_RUN = 3          # an hour of lecture is minutes of compute each


# --------------------------------------------------------------------------- io
def log(msg):
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    line = f"{datetime.now().isoformat(timespec='seconds')}  {msg}"
    with open(LOG, "a") as f:
        f.write(line + "\n")
    print(line)


def load_json(path, default):
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            raise ValueError("invalid_state_file:" + os.path.basename(path)) from None
    return default


def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=os.path.basename(path) + ".", dir=os.path.dirname(path))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def load_pending():
    pending = load_json(PENDING, {"files": []})
    if (not isinstance(pending, dict) or not isinstance(pending.get("files"), list)
            or any(not isinstance(e, dict) or not isinstance(e.get("course"), str)
                   or not isinstance(e.get("text"), str) or not isinstance(e.get("attempts", 0), int)
                   for e in pending["files"])):
        raise ValueError("invalid_pending_upload_state")
    return pending


def queue_upload(course, text_path, title, revision_id=None):
    """Record a file as owed to a GPT. Durable on purpose: the previous design kept
    this only in the run's report, so an upload that never happened disappeared from
    view as soon as the next sweep overwrote latest.md."""
    q = load_pending()
    digest = material_delivery.sha256_file(text_path)
    for e in q["files"]:
        if e["course"] == course and e["text"] == text_path:
            if e.get("text_sha256") != digest or e.get("revision_id") != revision_id:
                e.update(title=title, text_sha256=digest, revision_id=revision_id,
                         attempts=0, next_attempt=0, last_error=None)
                save_json(PENDING, q)
            return
    q["files"].append({
        "course": course, "text": text_path, "title": title,
        "queued_at": datetime.now(timezone.utc).isoformat(),
        "attempts": 0, "last_error": None,
        "next_attempt": 0, "text_sha256": digest, "revision_id": revision_id,
    })
    save_json(PENDING, q)


def flush_upload_queue(dry=False, only_courses=None):
    """Publish bounded pending work; a quiet retry never discards missing files."""
    q = load_pending()
    errors, uploaded, todo = [], [], []
    now = time.time()
    for e in q["files"]:
        if only_courses is not None and e["course"] not in only_courses:
            continue
        path = Path(e["text"]).resolve()
        allowed = (Path(ROOT) / e["course"] / "text").resolve()
        if not path.is_relative_to(allowed):
            errors.append(f"{e['course']}: queued text path is outside its course")
            continue
        if not path.is_file():
            errors.append(f"{e['course']}: queued extraction missing; delivery recovery pending")
            continue
        digest = material_delivery.sha256_file(path)
        if e.get("text_sha256") != digest:
            e.update(text_sha256=digest, attempts=0, next_attempt=0, last_error=None)
        if e.get("next_attempt", 0) <= now:
            todo.append(e)
    if dry:
        for course in sorted({e["course"] for e in todo}):
            groups, _ = bundle.collect(course)
            uploaded.extend(f"{course}: {course}_{category}.txt (planned only)" for category in groups)
        return uploaded, q["files"], errors
    if not todo:
        # No mutation is needed simply because a retry is cooling down.
        return uploaded, q["files"], errors
    save_json(PENDING, q)
    by_course, replace_names, frozen = {}, set(), {}
    receipt_path = os.path.join(ROOT, ".bundle-publication.json")
    receipts = load_json(receipt_path, {})
    if not isinstance(receipts, dict): raise ValueError("invalid_bundle_receipts")
    for course in sorted({e["course"] for e in todo}):
        built = bundle.build(course, log=log)
        if not built:
            errors.append(f"{course}: nothing to bundle; queued files remain owed")
            continue
        paths = [p for p, _ in built]
        by_course[course] = paths
        frozen[course] = {os.path.basename(p): bundle.digest(p) for p in paths}
        acknowledged = receipts.get(course, {}).get("digests", {})
        replace_names.update(name for name, digest in frozen[course].items()
                             if acknowledged.get(name) != digest)
    if not by_course: return uploaded, q["files"], errors
    try:
        results = gpt_upload.upload_many(by_course, log=log, replace=replace_names)
    except Exception:
        results = [{"course": c, "ok": False} for c in by_course]
    results_by_course = {r.get("course"): r for r in results if isinstance(r, dict)}
    current = load_pending()  # Do not clear a new revision queued during a long UI call.
    settled, failed = set(), set()
    expected = {(e["course"], e["text"]): (e.get("text_sha256"), e.get("revision_id")) for e in todo}
    for course, paths in by_course.items():
        result = results_by_course.get(course, {})
        unchanged = all(os.path.isfile(p) and bundle.digest(p) == frozen[course][os.path.basename(p)] for p in paths)
        source_unchanged = all(os.path.isfile(e["text"]) and material_delivery.sha256_file(e["text"]) == e["text_sha256"]
                               for e in todo if e["course"] == course)
        if result.get("ok") is True and unchanged and source_unchanged:
            receipts[course] = {"published_at": datetime.now(timezone.utc).isoformat(),
                "status": "publication_confirmed", "retrieval": "not_tested", "digests": frozen[course]}
            save_json(receipt_path, receipts)
            settled.add(course)
            uploaded.extend(f"{course}: {name}" for name in frozen[course])
        else:
            failed.add(course)
            errors.append(f"{course}: GPT publication unconfirmed; retained for retry")
    remaining = []
    for e in current["files"]:
        identity = (e["course"], e["text"])
        matches = expected.get(identity) == (e.get("text_sha256"), e.get("revision_id"))
        if matches and e["course"] in settled:
            continue
        if matches and e["course"] in failed:
            e["attempts"] = e.get("attempts", 0) + 1
            e["next_attempt"] = now + min(6 * 3600, 300 * 2 ** min(MAX_UPLOAD_ATTEMPTS, e["attempts"] - 1))
            e["last_error"] = "publication_unconfirmed"
        remaining.append(e)
    save_json(PENDING, {"files": remaining})
    return uploaded, remaining, errors


def md5(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def slug(title, maxlen=70):
    s = re.sub(r"[^\w\s.-]", "", title).strip()
    s = re.sub(r"[\s_]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("._-")
    return s[:maxlen] or "Untitled"


# ---------------------------------------------------------------------- browser
def js_json(win, tab, body, timeout=45):
    """Run a synchronous JS expression that returns a JSON string."""
    return cb.run_js_json(win, tab, body, timeout=timeout)


def discover_courses(win, tab):
    """Ask D2L which courses he is enrolled in THIS TERM, so a new shell (BUSN 3040E
    opens ~Oct 7) is picked up without editing this script.

    Filtering by term is essential, not cosmetic. `myenrollments` returns every shell
    he can still open — finished summer courses, an academic-honesty module, a library
    resources page. Without this filter the job happily swept 10 courses and started
    pulling a whole past semester of Python coursework.

    The discriminator is the term id at the end of OrgUnit.Code
    (`CO.180.MGMT5560.53168.20272` -> 20272). Summer 2026 is 20271 and ends Aug 26;
    Fall 2026 is 20272. We take the highest term among courses whose enrolment window
    contains today, which stays correct as terms roll over.
    """
    cb.run_js(win, tab, """
      window.__enr = 'pending';
      fetch('/d2l/api/lp/1.9/enrollments/myenrollments/?orgUnitTypeId=3',
            {credentials:'include'})
        .then(function(r){ return r.ok ? r.json() : Promise.reject('HTTP '+r.status); })
        .then(function(j){
          window.__enr = (j.Items||[]).map(function(it){
            var o = it.OrgUnit || {}, a = it.Access || {};
            return {id:o.Id, name:String(o.Name||''), code:String(o.Code||''),
                    active:!!a.IsActive, access:!!a.CanAccess,
                    start:a.StartDate||null, end:a.EndDate||null};
          });
        })
        .catch(function(e){ window.__enr = {error:String(e)}; });
      'ok'
    """)
    data = cb.await_global(win, tab, "__enr", timeout=60)
    if isinstance(data, dict) and data.get("error"):
        raise cb.ChromeError("enrollments: " + data["error"])

    def as_dt(s):
        if not s:
            return None
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None

    now_dt = datetime.now(timezone.utc)
    rows = []
    for row in data or []:
        if not (row.get("active") and row.get("access")):
            continue
        m_term = re.search(r"\.(\d{5})$", row.get("code") or "")
        if not m_term:
            continue                       # not a real course shell
        start, end = as_dt(row.get("start")), as_dt(row.get("end"))
        in_session = (start is None or start <= now_dt) and (end is None or now_dt <= end)
        rows.append((int(m_term.group(1)), in_session, row))

    if not rows:
        return {}
    live = [t for t, in_sess, _ in rows if in_sess]
    current = max(live) if live else max(t for t, _, _ in rows)
    # Announcements are pinned to the bridge's enrolled term/org identities;
    # the material collector may discover a later term without silently moving
    # the existing Fall 2026 announcement authority to that term.
    discover_courses.current_term = str(current)

    out = {}
    for term, in_session, row in rows:
        if term != current or not in_session:
            continue
        blob = ((row.get("code") or "") + " " + (row.get("name") or "")).upper()
        m = re.search(r"([A-Z]{3,4})\s*[-_ ]?\s*(\d{4})([A-Z]?)", blob)
        if not m:
            continue
        code = f"{m.group(1)}{m.group(2)}"
        # keep the E suffix only where the existing tree already uses it
        if m.group(3) == "E" and os.path.isdir(os.path.join(ROOT, code + "E")):
            code += "E"
        out[code] = row["id"]
    log(f"term {current}: {len(out)} course(s) of {len(rows)} enrolled shells")
    return out


def sweep(win, tab, courses):
    payload = json.dumps(courses)
    cb.run_js(win, tab, """
      window.__sw = 'pending';
      var C = %s, out = {};
      Promise.all(Object.keys(C).map(function(code){
        return fetch('/d2l/api/le/1.67/' + C[code] + '/content/toc', {credentials:'include'})
          .then(function(r){ return r.ok ? r.json() : Promise.reject('HTTP '+r.status); })
          .then(function(j){
            var items = [];
            (function walk(mods, path){
              (mods||[]).forEach(function(m){
                var p = path ? path + ' > ' + m.Title : m.Title;
                (m.Topics||[]).forEach(function(tp){
                  // Persist public resource identity, never a signed/session query.
                  var u = String(tp.Url||'').split(/[?#]/)[0];
                  var ext = (u.match(/\\.([a-z0-9]{1,5})$/i)||[,''])[1] || '';
                  items.push({id:tp.TopicId, title:String(tp.Title||'').slice(0,90),
                              ext:ext, type:tp.TypeIdentifier, unit:p.slice(0,60),
                              url_path:u, last_modified:tp.LastModifiedDate||null});
                });
                walk(m.Modules, p);
              });
            })(j.Modules, '');
            out[code] = items;
          })
          .catch(function(e){ out[code] = 'ERR ' + e; });
      })).then(function(){ window.__sw = out; });
      'ok'
    """ % payload)
    return cb.await_global(win, tab, "__sw", timeout=120)


def trigger_download(win, tab, org_unit, topic_id):
    js = ("(function(){var a=document.createElement('a');"
          "a.href='/d2l/le/content/%s/topics/files/download/%s/DirectFileTopicDownload';"
          "a.download='';document.body.appendChild(a);a.click();"
          "setTimeout(function(){a.remove();},1000);return 'clicked';})()"
          % (org_unit, topic_id))
    return cb.run_js(win, tab, js)


# --------------------------------------------------------------------- download
def snapshot_downloads():
    try:
        names = {f for f in os.listdir(DOWNLOADS)}
        # An earlier timed-out transfer may finish while a later topic is being
        # checked. Its final filename is already owned by that earlier transfer.
        return names | {f[:-len(".crdownload")] for f in names if f.endswith(".crdownload")}
    except FileNotFoundError:
        return set()


def _size(name):
    try:
        return os.path.getsize(os.path.join(DOWNLOADS, name))
    except OSError:
        return 0                       # renamed out from under us mid-poll


def settle_new_file(before, start_timeout=900, idle_timeout=180, hard_cap=5400, max_bytes=None):
    """Wait for a new, fully-written file to appear in ~/Downloads.

    Times out on lack of *progress*, not on elapsed time. The flat 60s deadline this
    replaces silently lost three LAND 2510E lecture videos on 24 Aug: each was
    ~800MB, took minutes, and landed after the sweep had already logged a timeout
    and moved on — so they were neither stashed nor marked fetched, and the next run
    would have pulled all 800MB again. While Chrome has a .crdownload that keeps
    growing, the download is healthy however long it takes.

    The two waits are deliberately different. D2L serves a video as `<name>.mp4.zip`
    and zips it server-side on request, so for a ~1GB lecture nothing at all reaches
    the disk for minutes — no .crdownload, no bytes, nothing to measure. One flat
    idle timeout reads that startup silence as a stall and gives up seconds before
    the transfer begins, which is precisely how 04_ Islam Spain failed twice. So:
    a long `start_timeout` until the first byte lands, then a tight `idle_timeout`
    on a transfer that started and then stopped moving.
    """
    start = last_progress = time.time()
    last_size = -1
    started = False
    while time.time() - start < hard_cap:
        added = {f for f in (snapshot_downloads() - before) if not f.startswith(".")}
        if max_bytes is not None and sum(_size(f) for f in added) > max_bytes:
            return None
        done = sorted(f for f in added
                      if not f.endswith((".crdownload", ".tmp", ".part"))
                      and os.path.isfile(os.path.join(DOWNLOADS, f)))
        if done:
            path = os.path.join(DOWNLOADS, done[0])
            s1 = _size(done[0])
            time.sleep(1.0)
            if _size(done[0]) == s1 and os.path.exists(path):
                return path
            last_progress = time.time()
            continue
        partial = [f for f in added if f.endswith((".crdownload", ".tmp", ".part"))]
        if partial:
            if not started:
                started, last_progress = True, time.time()
            size = sum(_size(f) for f in partial)
            if size != last_size:
                last_size, last_progress = size, time.time()
        if time.time() - last_progress > (idle_timeout if started else start_timeout):
            return None
        time.sleep(1.0)
    return None


def stash(course, src, topic_title):
    """Move a download into <COURSE>/raw/, deduping by content hash."""
    raw_dir = os.path.join(ROOT, course, "raw")
    os.makedirs(raw_dir, exist_ok=True)
    size = os.path.getsize(src)
    digest = md5(src)
    for existing in os.listdir(raw_dir):
        p = os.path.join(raw_dir, existing)
        # Unequal lengths cannot contain identical bytes. Check metadata before
        # hashing so each PDF does not read/hydrate unrelated multi-GB videos.
        if os.path.isfile(p) and os.path.getsize(p) == size and md5(p) == digest:
            os.remove(src)
            return p, True                     # already had it
    ext = os.path.splitext(src)[1]
    dest = os.path.join(raw_dir, slug(topic_title) + ext)
    n = 2
    while os.path.exists(dest):
        dest = os.path.join(raw_dir, f"{slug(topic_title)}_{n}{ext}")
        n += 1
    shutil.move(src, dest)
    return dest, False


def write_text(course, raw_path, topic_title, unit, topic_id=None):
    """Extract and write a self-describing knowledge file.

    Naming follows the standing convention: one file per item, name states what it
    is. Never an ordering prefix like 01_ — that reads as 'chapter 1'.
    """
    text, note = extract(raw_path)
    if text is None:
        return None, note
    if (course in ("BUSN3040", "BUSN3040E") and str(topic_id) in ("62542780", "62542781")
            and sum(phrase.casefold() in text.casefold() for phrase in
                    ("Dr. Insert Name", "lorem ipsum", "Example Textbook Here",
                     "Date Goes Here", "Description of What is Due")) >= 2):
        return None, "source_template"
    text_dir = os.path.join(ROOT, course, "text")
    os.makedirs(text_dir, exist_ok=True)
    name = f"{course}_ELC_{topic_id}.txt" if topic_id is not None else f"{course}_{slug(topic_title)}.txt"
    dest = os.path.join(text_dir, name)
    units = len(re.findall(r"^## (?:Slide|Page|Sheet)", text, re.M))
    header = [
        f"# {course} — {topic_title}",
        "",
        f"Source: UGA eLC (D2L) > {unit} > {os.path.basename(raw_path)}",
        f"Extracted {datetime.now().strftime('%Y-%m-%d')} by the daily eLC sweep.",
    ]
    if topic_id is not None: header.append(f"Source topic ID: {topic_id}")
    if units:
        header.append(f"Contents: {units} "
                      + ("slides" if "## Slide" in text else
                         "pages" if "## Page" in text else "sheets")
                      + ", extracted text in order; images may require the original.")
    header += ["", "=" * 72, ""]
    fd, tmp = tempfile.mkstemp(prefix=".extract-", dir=text_dir)
    try:
        with os.fdopen(fd, "w") as f:
            f.write("\n".join(header) + text.rstrip() + "\n")
            f.flush(); os.fsync(f.fileno())
        if topic_id is not None and os.path.isfile(dest) and material_delivery.sha256_file(dest) != material_delivery.sha256_file(tmp):
            archive = Path(ROOT) / course / "superseded-text"
            archive.mkdir(parents=True, exist_ok=True)
            old = archive / (Path(dest).stem + "." + material_delivery.sha256_file(dest)[:16] + ".txt")
            if not old.exists(): shutil.copy2(dest, old)
        os.replace(tmp, dest)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
    return dest, None


def maybe_transcribe(course, raw_path, title, unit):
    """Last resort for a file no extractor can read: if it is video, make it words.

    Lecture video is the one kind of new material that arrives useless — Knowledge
    takes text, and an 800MB .mp4.zip is not text. Before this, those items landed
    on disk and stopped there, so 04/05/06 sat in the GPT as slides with no spoken
    content. Returns (text_path, note) matching write_text's contract, or
    (None, None) when this was never a video in the first place.
    """
    if os.path.splitext(raw_path)[1].lower() not in (".zip",) + transcribe.MEDIA_EXT:
        return None, None
    # Deliberately no log line before the call: at this point we only know the file
    # is a container that *might* hold video, and announcing "transcribing" for every
    # PDF-filled .zip makes the log lie.
    dest, note = transcribe.transcribe(course, raw_path, title, unit)
    if dest:
        log(f"{course}: transcribed {title} -> {os.path.basename(dest)}")
    elif note and "no video" not in note:
        log(f"{course}: transcription failed for {title} - {note}")
    return dest, note


# ------------------------------------------------------------------------ alert
def notify(title, message):
    def esc(s):
        return s.replace("\\", "\\\\").replace('"', '\\"')
    try:
        subprocess.run(
            ["osascript", "-e",
             f'display notification "{esc(message)}" with title "{esc(title)}" sound name "Glass"'],
            capture_output=True, timeout=15)
    except Exception as e:
        log(f"notify failed: {e}")


def post_bridge_note(text):
    """Leave a note the class GPTs surface, so the alert reaches him wherever he is."""
    if not os.path.isfile(BRIDGE_NOTE):
        return
    try:
        r = subprocess.run(["bash", BRIDGE_NOTE, text],
                           capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            # Never swallowed: the Worker's KV store is on Cloudflare's free tier,
            # which caps writes at 1000/day. Past the cap a note POST is refused
            # while every read keeps working, so the GPTs go on answering happily
            # with an alert that was never stored. Silence is the worst possible
            # failure mode for a notification channel.
            out = (r.stderr or r.stdout).strip()
            if "kv_write_limit" in out:
                # A wait, not a fault. Say so, or the alert gets tuned out.
                log("bridge note DEFERRED: KV write quota spent, resets 00:00 UTC")
                notify("eLC sweep",
                       "New material is in your GPTs, but the alert note could not "
                       "be stored: bridge write quota spent until 8pm ET.")
            else:
                log(f"bridge note REJECTED: {out[:200]}")
                notify("eLC sweep", f"Bridge note rejected: {out[:100]}")
    except Exception as e:
        log(f"bridge note failed: {e}")


def delivery_queue():
    return material_delivery.DeliveryQueue(os.path.join(ROOT, ".material-delivery.json"), ROOT)


def recovery_scope(manifest, requested=None):
    """Existing current source inventory and configured class ownership only."""
    configured = load_json(os.path.join(ROOT, "gpts.json"), {})
    courses = set(manifest.get("courses", {})) & set(configured) & set(drive_sync.COURSE_DIR)
    if requested:
        aliases = {"BUSN3040E": "BUSN3040", "LAND2510": "LAND2510E"}
        requested = aliases.get(requested, requested)
        courses = {c for c in courses if aliases.get(c, c) == requested}
        if not courses: raise ValueError("requested_course_not_in_current_inventory")
    return courses


def _archive_prior_text(record, current):
    prior = record.get("previous_text_path")
    if not prior:
        old = load_json(FETCHED, {}).get(record["topic_id"], {})
        if old.get("course") == record["course"] and old.get("text"):
            prior = os.path.join(ROOT, record["course"], "text", old["text"])
    if not prior: return
    prior, current = Path(prior).resolve(), Path(current).resolve()
    allowed = (Path(ROOT) / record["course"] / "text").resolve()
    if prior == current or not prior.is_relative_to(allowed) or not prior.is_file(): return
    # Legacy names were title based and may be shared by distinct topics. Such a
    # file cannot be retired on evidence about only this source identity.
    fetched = load_json(FETCHED, {})
    if any(str(topic) != record["topic_id"] and old.get("course") == record["course"]
           and old.get("text") == prior.name for topic, old in fetched.items()): return
    archive = Path(ROOT) / record["course"] / "superseded-text"
    archive.mkdir(parents=True, exist_ok=True)
    target = archive / (prior.stem + "." + material_delivery.sha256_file(prior)[:16] + prior.suffix)
    if target.exists():
        if target.read_bytes() != prior.read_bytes(): raise ValueError("archive_collision")
        prior.unlink()
    else: os.replace(prior, target)
    pending = load_pending()
    # Retirement is identity/content proven here; unrelated missing queue files
    # are kept by flush_upload_queue rather than silently discarded.
    pending["files"] = [e for e in pending["files"]
                        if not (e["course"] == record["course"] and Path(e["text"]).resolve() == prior)]
    save_json(PENDING, pending)


def single_video_member(archive):
    """Use the same bounded member decision for transcription and Drive filing."""
    infos = archive.infolist()
    if len(infos) > 1000: return None, "unsafe_archive"
    videos = [info for info in infos if not info.is_dir()
              and not info.filename.startswith("__MACOSX/")
              and Path(info.filename).suffix.lower() in transcribe.VIDEO_EXT]
    if len(videos) != 1:
        return None, "multiple_video_members" if videos else "video_missing"
    info = videos[0]
    member = Path(info.filename)
    if (member.is_absolute() or ".." in member.parts or "\\" in info.filename
            or info.flag_bits & 1 or (info.external_attr >> 16) & 0o170000 == 0o120000
            or info.file_size <= 0 or info.file_size > 4 * 1024 ** 3
            or info.file_size / max(1, info.compress_size) > 200):
        return None, "unsafe_archive"
    return info, None


def write_stable_transcript(stable, text, course):
    """Publish complete transcript bytes atomically and retain the prior version."""
    stable.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".transcript-", dir=stable.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as out:
            out.write(text); out.flush(); os.fsync(out.fileno())
        if stable.is_file() and material_delivery.sha256_file(stable) != material_delivery.sha256_file(tmp):
            archive = Path(ROOT) / course / "superseded-text"
            archive.mkdir(parents=True, exist_ok=True)
            previous = archive / (stable.stem + "." + material_delivery.sha256_file(stable)[:16] + stable.suffix)
            if previous.exists():
                if previous.read_bytes() != stable.read_bytes(): raise ValueError("archive_collision")
            else: shutil.copy2(stable, previous)
        os.replace(tmp, stable)
        directory = os.open(stable.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def extract_material(record, transcription_budget=None):
    # A recorded source-content mismatch is different from a failed decoder.
    # Never teach from those exact known-bad bytes if restored or redownloaded.
    # A fresh original with a different hash remains eligible for extraction.
    old = load_json(FETCHED, {}).get(str(record["topic_id"]), {})
    quarantined = old.get("source_quarantine", {})
    blocked_hash = quarantined.get("raw_sha256") if isinstance(quarantined, dict) else None
    if (old.get("course") == record["course"] and blocked_hash
            and record.get("source_sha256") == blocked_hash
            and material_delivery.sha256_file(record["raw_path"]) == blocked_hash):
        return {"ok": False, "reason": "source_content_mismatch"}
    is_zip = Path(record["raw_path"]).suffix.lower() == ".zip"
    archive_video = False
    if is_zip:
        try:
            with zipfile.ZipFile(record["raw_path"]) as archive:
                info, reason = single_video_member(archive)
                archive_video = info is not None
                if reason not in (None, "video_missing"):
                    return {"ok": False, "reason": reason}
        except (OSError, ValueError, zipfile.BadZipFile, RuntimeError):
            return {"ok": False, "reason": "unsafe_archive"}
    # A README alongside an MKV is not the lecture. All verified video archives
    # take the transcript path, regardless of other extractable small members.
    path, note = (None, None) if archive_video else write_text(record["course"], record["raw_path"], record["title"],
                                                             record["unit"], record["topic_id"])
    if path is None and note != "source_template":
        if is_zip and not archive_video:
            return {"ok": False, "reason": "extraction_unavailable"}
        if Path(record["raw_path"]).suffix.lower() in (".zip",) + transcribe.MEDIA_EXT:
            if transcription_budget is not None:
                if transcription_budget[0] <= 0: return {"ok": False, "reason": "transcription_deferred"}
                transcription_budget[0] -= 1
        path, note = maybe_transcribe(record["course"], record["raw_path"], record["title"], record["unit"])
        if path:
            quality = transcribe.validate_transcript_path(path)
            if not quality["ok"]:
                quarantine_transcript(record, path, material_delivery.sha256_file(path))
                return {"ok": False, "reason": quality["reason"]}
            stable = Path(ROOT) / record["course"] / "text" / f"{record['course']}_ELC_{record['topic_id']}_transcript.txt"
            text = Path(path).read_text()
            if "Source topic ID:" not in text:
                text = text.replace("\n", f"\nSource topic ID: {record['topic_id']}\n", 1)
            write_stable_transcript(stable, text, record["course"])
            if Path(path).resolve() != stable.resolve():
                legacy = dict(record, previous_text_path=path)
                _archive_prior_text(legacy, stable)
            path = str(stable)
    if not path:
        allowed = {"source_template"} | material_delivery.QUALITY_FAILURE_REASONS
        return {"ok": False, "reason": note if note in allowed else "extraction_unavailable"}
    _archive_prior_text(record, path)
    return {"ok": True, "text_path": path}


def file_material_drive(record):
    raw = Path(record["raw_path"])
    if raw.suffix.lower() == ".zip" and raw.stat().st_size > 100_000_000:
        return file_archive_video(record)
    action, rel = drive_sync.file_item(record["course"], record["raw_path"], record["title"], record["unit"],
        preferred_rel=record.get("drive_rel") or record.get("previous_drive_rel"))
    if action == "skipped" or not rel: return {"ok": False}
    path = Path(drive_sync.DRIVE) / rel
    if material_delivery.sha256_file(path) != record["source_sha256"]: return {"ok": False}
    return {"ok": True, "drive_rel": rel, "source_sha256": record["source_sha256"]}


def file_archive_video(record):
    """File the original single video payload; retain its ZIP provenance."""
    raw = Path(record["raw_path"])
    if material_delivery.sha256_file(raw) != record["source_sha256"]:
        return {"ok": False, "reason": "source_changed"}
    try:
        with zipfile.ZipFile(raw) as archive:
            info, reason = single_video_member(archive)
            if reason: return {"ok": False, "reason": reason}
            member = Path(info.filename)
            with tempfile.TemporaryDirectory(prefix="elc-drive-video-") as folder:
                video = Path(folder) / ("source" + member.suffix.lower())
                hasher = hashlib.sha256()
                copied = 0
                with archive.open(info) as src, video.open("wb") as out:
                    for chunk in iter(lambda: src.read(1024 * 1024), b""):
                        copied += len(chunk)
                        if copied > info.file_size or copied > 4 * 1024 ** 3:
                            return {"ok": False, "reason": "unsafe_archive"}
                        hasher.update(chunk); out.write(chunk)
                if copied != info.file_size: return {"ok": False, "reason": "unsafe_archive"}
                action, rel = drive_sync.file_item(record["course"], str(video), record["title"], record["unit"],
                    preferred_rel=record.get("drive_rel") or record.get("previous_drive_rel"))
                digest = hasher.hexdigest()
                if (action == "skipped" or not rel or material_delivery.sha256_file(Path(drive_sync.DRIVE) / rel) != digest
                        or material_delivery.sha256_file(raw) != record["source_sha256"]):
                    return {"ok": False, "reason": "drive_unconfirmed"}
                return {"ok": True, "drive_rel": rel, "source_sha256": record["source_sha256"],
                        "drive_sha256": digest, "drive_representation": "archive_video", "archive_member": info.filename}
    except (OSError, ValueError, zipfile.BadZipFile, RuntimeError):
        return {"ok": False, "reason": "unsafe_archive"}


def clear_confirmed_capture():
    """Repair only a crash after a hash-bound successful capture was persisted."""
    state = load_json(STATE, {})
    hold = state.get("material_capture_hold")
    if not hold or hold.get("additional_unconfirmed"): return False
    fetched = load_json(FETCHED, {}).get(str(hold.get("topic_id")), {})
    if not hold.get("capture_id") or fetched.get("capture_id") != hold["capture_id"]:
        return False
    if fetched.get("course") != hold.get("course"): return False
    try:
        raw = Path(ROOT) / fetched["course"] / "raw" / fetched["raw"]
        digest = material_revisions.content_digest(raw)
        record = delivery_queue().entries(read_only=True)[fetched["course"] + ":" + str(hold["topic_id"])]
        if (digest != fetched["revisions"]["sha256"]
                or material_revisions.content_digest(record["raw_path"]) != digest): return False
    except (KeyError, ValueError, OSError):
        return False
    state.pop("material_capture_hold")
    save_json(STATE, state)
    return True


def queue_material_gpt(record):
    queue_upload(record["course"], record["text_path"], record["title"], record["revision_id"])
    present = any(e["course"] == record["course"] and e["text"] == record["text_path"]
                  and e.get("text_sha256") == record["text_sha256"]
                  and e.get("revision_id") == record["revision_id"] for e in load_pending()["files"])
    return {"ok": present}


def quarantine_transcript(record, path, expected_sha256):
    """Exclude rejected exact text bytes from bundles without deleting evidence."""
    path = Path(path).resolve()
    allowed = (Path(ROOT) / record["course"] / "text").resolve()
    if not path.is_relative_to(allowed) or not path.is_file(): return False
    if material_delivery.sha256_file(path) != expected_sha256: return False
    archive = Path(ROOT) / record["course"] / "superseded-text"
    archive.mkdir(parents=True, exist_ok=True)
    target = archive / (path.stem + ".unusable." + expected_sha256[:16] + path.suffix)
    if target.exists():
        if material_delivery.sha256_file(target) != expected_sha256: raise ValueError("archive_collision")
        path.unlink()
    else: os.replace(path, target)
    return True


def check_stored_transcript_quality(queue, courses, max_records=256):
    checked = reopened = 0
    records = [record for record in queue.entries(read_only=True).values()
               if record["course"] in courses and record.get("text_path")]
    for record in records[:max_records]:
        path = Path(record["text_path"]).resolve()
        allowed = (Path(ROOT) / record["course"] / "text").resolve()
        if not path.is_relative_to(allowed) or path == allowed:
            raise ValueError("invalid_material_path")
        if not path.is_file(): continue
        checked += 1
        quality = transcribe.validate_transcript_path(path)
        if quality["ok"]: continue
        expected = record.get("text_sha256")
        changed = queue.invalidate_quality(record["course"], record["topic_id"],
            record["revision_id"], expected, quality["reason"])
        prior = record.get("quality_invalidated", {})
        if changed or prior.get("text_sha256") == expected:
            quarantine_transcript(record, path, expected)
            reopened += int(changed)
    return {"checked": checked, "reopened": reopened, "deferred": max(0, len(records)-max_records)}


def native_download_status():
    """Read capture metadata without creating state or trusting a corrupt ledger."""
    try:
        return dict(native_material_intake.summary(ROOT), blocked=False)
    except (ValueError, OSError, TypeError):
        return {"pending": None, "complete": None, "blocked": True,
                "reason": "invalid_native_intake_state"}


def recover_materials(only_courses=None, seed=True):
    manifest = load_json(MANIFEST, {"courses": {}})
    fetched = load_json(FETCHED, {})
    courses = recovery_scope(manifest) if only_courses is None else only_courses
    queue = delivery_queue()
    native = dict(native_download_status(), accepted=0, waiting=0)
    if not native["blocked"] and native_material_intake.pending_topics(ROOT, courses):
        try:
            # No secret/browser access and no new collection: finish only the
            # exact registered native transfers before legacy seeding consumes
            # this same fetched ledger. Missing config cannot authorize intake.
            config = elc_announcements.source_config(os.path.join(ROOT, Path(elc_announcements.SOURCES).name))
            native.update(native_material_intake.recover(ROOT, DOWNLOADS, manifest, fetched,
                courses, config, queue, lambda updated: save_json(FETCHED, updated)))
        except (ValueError, OSError, TypeError):
            native.update(blocked=True, reason="native_intake_unavailable")
    seeded = {"seeded": 0, "skipped": 0, "invalid": 0}
    if seed and courses:
        seeded = queue.seed_legacy(fetched, manifest, courses, limit=3)
    quality = check_stored_transcript_quality(queue, courses)
    pending = load_pending()["files"]
    reopened = 0
    for record in queue.entries(read_only=True).values():
        if reopened >= 6: break
        if record["course"] not in courses or not record.get("text_path"): continue
        if any(e["course"] == record["course"] and e["text"] == record["text_path"]
               and e.get("revision_id") in (None, record["revision_id"]) for e in pending):
            if queue.invalidate_text(record["course"], record["topic_id"], record["revision_id"]):
                reopened += 1
    transcription_budget = [MAX_TRANSCRIBE_PER_RUN]
    result = queue.run(extract=lambda record: extract_material(record, transcription_budget), file_drive=file_material_drive,
        queue_gpt=queue_material_gpt, publish=material_bridge.publish, readback=material_bridge.readback,
        only_courses=courses, max_records=6, max_operations=24)
    result["legacy_seed"] = seeded
    result["transcript_quality"] = quality
    result["native_intake"] = native
    # The ledger owns stage truth; fetched retains compatibility for existing
    # reconciliation and source indexes, after its exact extraction is observed.
    changed = False
    for key, record in queue.entries(read_only=True).items():
        old = fetched.get(record["topic_id"])
        if not old or old.get("course") != record["course"] or record["course"] not in courses: continue
        if record.get("text_path") and record["stages"]["extraction"]["status"] == "done":
            name = Path(record["text_path"]).name
            if old.get("text") != name: old["text"] = name; changed = True
        if record.get("drive_rel") and old.get("drive_rel") != record["drive_rel"]:
            old["drive_rel"] = record["drive_rel"]; changed = True
    if changed: save_json(FETCHED, fetched)
    return result


def recover_local_materials(only_courses, seed=True):
    """Advance local evidence only, leaving destination receipts wholly pending.

    Do not enter recover_materials: it consumes native Downloads and contacts
    destinations before collection. No transport fallback or bridge retry belongs
    in this explicitly source-only operation. Media transcription is deferred.
    """
    manifest = load_json(MANIFEST, {"courses": {}})
    fetched = load_json(FETCHED, {})
    queue = delivery_queue()
    seeded = queue.seed_legacy(fetched, manifest, only_courses, limit=3) if seed else {}
    result = queue.run(extract=lambda record: extract_material(record, [0]),
        queue_gpt=queue_material_gpt, file_drive=None, publish=None, readback=None,
        stages={"extraction", "gpt_queue"}, only_courses=only_courses,
        max_records=6, max_operations=12)
    changed = False
    for record in queue.entries(read_only=True).values():
        old = fetched.get(record["topic_id"])
        if (record["course"] in only_courses and old and old.get("course") == record["course"]
                and record["stages"]["extraction"]["status"] == "done" and record.get("text_path")):
            name = Path(record["text_path"]).name
            if old.get("text") != name:
                old["text"] = name
                changed = True
    if changed: save_json(FETCHED, fetched)
    result.update(legacy_seed=seeded, publication="not_attempted", native_intake="not_attempted")
    return result


def material_health(reason=None, source_only=False):
    state = load_json(STATE, {})
    try:
        summary = delivery_queue().summary(read_only=True)
        pending = len(load_pending()["files"])
        deferred = int(state.get("material_revision_deferred", 0))
        manifest = load_json(MANIFEST, {"courses": {}})
        courses = recovery_scope(manifest)
        entries = delivery_queue().entries(read_only=True)
        fetched = load_json(FETCHED, {})
        legacy = sum(1 for topic, entry in fetched.items() if entry.get("course") in courses
                     and entry["course"] + ":" + str(topic) not in entries
                     and any(str(item.get("id")) == str(topic) for item in manifest["courses"][entry["course"]].get("items", [])))
        native = native_download_status()
        health = {"checked_at": datetime.now(timezone.utc).isoformat(), "delivery": summary,
                  "gpt_pending": pending, "revision_deferred": deferred,
                  "legacy_delivery_unseeded": legacy, "current_courses": len(courses),
                  "native_downloads": native,
                  "status": "blocked" if reason or not courses or native["blocked"] else "pending" if summary["pending"] or pending or deferred or legacy or native["pending"] else "ok"}
        if native["blocked"]: health["reason"] = native["reason"]
        if state.get("material_capture_hold"):
            health.update(status="blocked", reason="download_capture_unconfirmed")
        if reason: health["reason"] = reason
    except Exception:
        health = {"checked_at": datetime.now(timezone.utc).isoformat(), "status": "blocked", "reason": "state_unreadable"}
    if source_only:
        health.update(mode="source_only", publication="not_attempted")
        if health["status"] == "ok": health["status"] = "pending"
    state["material_health"] = health
    state["last_material_attempt_epoch"] = time.time()
    save_json(STATE, state)
    return health


def session_probe_cooling_down(state, *, now=None, force=False):
    """Back off failed/uncertain probes, not healthy Neo's per-process owned tabs.

    A prior tab-open timestamp is not failed-session evidence. New Neo attempts
    are latched before opening and cleared logically by a later whoami success;
    an interrupted attempt therefore remains bounded. Legacy known-dead sessions
    keep their existing backoff, while legacy successful runs need one fresh check.
    This metadata says nothing about material freshness or publication success.
    """
    if force:
        return False
    def epoch(value):
        return value if type(value) in (int, float) and 0 < value < float('inf') else 0
    probe = epoch(state.get('neo_session_probe_epoch'))
    confirmed = epoch(state.get('neo_session_success_epoch'))
    if not probe:
        if not epoch(state.get('session_dead_since')):
            return False
        probe = epoch(state.get('last_probe_epoch'))
    if not probe or confirmed >= probe:
        return False
    elapsed = (time.time() if now is None else now) - probe
    return 0 <= elapsed < PROBE_GAP_SECONDS


# ------------------------------------------------------------------------- main
def _main():
    dry = "--dry-run" in sys.argv
    source_only = "--source-only" in sys.argv
    if source_only and "--upload-only" in sys.argv:
        raise ValueError("source_only_incompatible_with_upload_only")
    force = "--force" in sys.argv
    requested = None
    if "--course" in sys.argv:
        position = sys.argv.index("--course") + 1
        if position >= len(sys.argv): raise ValueError("course_argument_required")
        requested = sys.argv[position].upper()
    manifest = load_json(MANIFEST, {"courses": {}})
    scope = recovery_scope(manifest, requested)
    if dry:
        # Preview is offline and read-only, including no bundle rebuild, lockfile,
        # browser probing, health timestamp, logs, or cloud requests.
        if source_only:
            planned, pending, errors = [], load_pending()["files"], []
        else:
            planned, pending, errors = flush_upload_queue(dry=True, only_courses=scope)
        print(json.dumps({"mode": "source_only_dry_run" if source_only else "dry_run", "courses": sorted(scope),
            "delivery": delivery_queue().summary(scope, read_only=True),
            "native_downloads": native_download_status(),
            "gpt_pending": len(pending), "bundle_plan": planned, "problems": errors}))
        return 0
    if source_only:
        if "--recovery-only" not in sys.argv:
            state = load_json(STATE, {})
            state["source_only_material_check"] = {"attempted_at": datetime.now(timezone.utc).isoformat(),
                "status": "not_completed", "publication": "not_attempted"}
            save_json(STATE, state)
        recover_local_materials(scope)
    else:
        recover_materials(scope)
        clear_confirmed_capture()
    if "--recovery-only" in sys.argv:
        print(json.dumps({"mode": "source_only_recovery" if source_only else "recovery_only", "courses": sorted(scope),
                          "delivery": delivery_queue().summary(scope, read_only=True),
                          "native_downloads": native_download_status()}))
        return 0

    if "--upload-only" in sys.argv:
        # Retry path. BrowserOS neo needs to be available for this too, but no eLC session is
        # required — the queue already points at files on disk.
        try:
            if not cb.is_running():
                log("skip: BrowserOS neo is unavailable")
                return 0
        except cb.ChromeError as e:
            log(f"skip: {e}")
            return 0
        up, rem, errs = flush_upload_queue(dry=dry, only_courses=scope)
        for u in up:
            log(f"uploaded {u}")
        for e in errs:
            log(f"upload problem: {e}")
        log(f"upload-only: {len(up)} uploaded, {len(rem)} still queued")
        return 0 if not errs else 1

    state = load_json(STATE, {})
    last = state.get("last_success_epoch", 0)
    materials_due = source_only or "--materials-only" in sys.argv or force or dry or time.time() - last >= MIN_GAP_SECONDS
    materials_only = source_only or "--materials-only" in sys.argv
    announcements_due = not materials_only and (force or dry or elc_announcements.due())
    submissions_due = not materials_only and (force or dry or elc_submission.due())
    announcement_recorded = False
    submission_recorded = False
    # A public-keyed private eLC RSS feed can expose recent news while BrowserOS neo is
    # unavailable. It is explicitly only a recent feed, never a full listing.
    rss_results = elc_announcements.read_rss_courses() if announcements_due else {}
    if not dry and not materials_only:
        elc_announcements.publish_pending(log=log)
    if not materials_due and not announcements_due and not submissions_due:
        # Sweeping is throttled to MIN_GAP_SECONDS; retrying a failed upload is not. A
        # file that missed its GPT would otherwise sit unowned until the next sweep
        # window opens. Flushing an empty queue costs nothing, so this stays cheap
        # on the ~23 hourly wake-ups a day that have nothing to do.
        if load_pending()["files"]:
            try:
                if cb.is_running():
                    up, rem, errs = flush_upload_queue()
                    for e in errs:
                        log(f"upload problem: {e}")
                    log(f"swept recently; queue flush: {len(up)} uploaded, "
                        f"{len(rem)} still queued")
                    return 0
            except cb.ChromeError as e:
                log(f"queue flush skipped: {e}")
        log("skip: swept recently")
        return 0

    try:
        if not cb.is_running():
            log("skip: BrowserOS neo is unavailable")
            if announcements_due:
                elc_announcements.blocked("browser", dry=dry, force=True,
                                          log=log, rss_results=rss_results)
            if submissions_due:
                elc_submission.blocked("browser", dry=dry, force=True, log=log)
            return 0
    except cb.ChromeError as e:
        log(f"skip: {e}")
        if announcements_due:
            elc_announcements.blocked("browser", dry=dry, force=True,
                                      log=log, rss_results=rss_results)
        if submissions_due:
            elc_submission.blocked("browser", dry=dry, force=True, log=log)
        return 0

    opened = False
    loc = cb.find_tab("uga.view.usg.edu")
    try:
        if loc is None:
            # Each Neo process deliberately owns a fresh background tab. Only a
            # failed/unconfirmed session probe should delay the next scheduled
            # source check; the absence of a reusable user tab is normal.
            if session_probe_cooling_down(state, force=force):
                log("skip: unconfirmed eLC session probe cooling down")
                if announcements_due:
                    elc_announcements.blocked("browser", dry=dry, force=True,
                                              log=log, rss_results=rss_results)
                if submissions_due:
                    elc_submission.blocked("browser", dry=dry, force=True, log=log)
                return 0
            state["last_probe_epoch"] = time.time()
            state["neo_session_probe_epoch"] = state["last_probe_epoch"]
            if not dry:
                save_json(STATE, state)
            loc = cb.open_tab(HOME)
            opened = True
            cb.wait_loaded(*loc, timeout=40)
        win, tab = loc

        who = js_json(win, tab, """
          (function(){ try {
            var x = new XMLHttpRequest();
            x.open('GET','/d2l/api/lp/1.9/users/whoami',false);
            x.withCredentials = true; x.send(null);
            return JSON.stringify({status:x.status, ok:x.status===200});
          } catch(e){ return JSON.stringify({status:0, ok:false}); } })()
        """)
        if not (isinstance(who, dict) and who.get("ok")):
            # Skipping is correct — this job never asks him to log in. What was
            # wrong is that it skipped SILENTLY: on 1 Sep the session was dead from
            # 03:30 to 13:22 and the sweep logged twelve identical skips while
            # routinectl showed "ok", because last_success_epoch only trips
            # staleness after 18 hours. Same shape as the Drive daemon dying
            # unnoticed. Stamping the first failure lets the status line say how
            # long it has actually been out.
            log(f"skip: no live eLC session ({who})")
            if announcements_due:
                elc_announcements.blocked("session", dry=dry, force=True,
                                          log=log, rss_results=rss_results)
            if submissions_due:
                elc_submission.blocked("session", dry=dry, force=True, log=log)
            if not dry:
                state.setdefault("session_dead_since", time.time())
                state["last_skip_reason"] = f"no live eLC session (HTTP {who.get('status')})"
                save_json(STATE, state)
            return 0

        # Confirm the session independently of course/material success. Future
        # hourly processes may open their own Neo tab without the failed-probe
        # cooldown. Source-only checks still cannot advance material freshness.
        if not dry and (opened or state.get("session_dead_since") is not None):
            state["neo_session_success_epoch"] = time.time()
            if state.pop("session_dead_since", None) is not None:
                state.pop("last_skip_reason", None)
            save_json(STATE, state)

        courses = discover_courses(win, tab)
        if not courses:
            log("skip: no courses discovered")
            if announcements_due:
                elc_announcements.blocked("course_missing", dry=dry, force=True,
                                          log=log, rss_results=rss_results)
            if submissions_due:
                elc_submission.blocked("course_missing", dry=dry, force=True, log=log)
            return 0
        log(f"session live | courses: {', '.join(sorted(courses))}")

        if announcements_due:
            elc_announcements.collect(win, tab, courses,
                term_code=getattr(discover_courses, "current_term", None),
                dry=dry, force=True, log=log, rss_results=rss_results)
            announcement_recorded = True
        if submissions_due:
            elc_submission.collect(win, tab, courses,
                term_code=getattr(discover_courses, "current_term", None),
                dry=dry, force=True, log=log)
            submission_recorded = True
        if not materials_due:
            # News success is separate from material/extraction/upload success.
            # Retain the existing pending-upload retry on quiet hourly wakeups.
            if load_pending()["files"]:
                up, rem, errs = flush_upload_queue(dry=dry)
                for error in errs:
                    log(f"upload problem: {error}")
                log(f"swept recently; queue flush: {len(up)} uploaded, {len(rem)} still queued")
            log("skip: materials swept recently; announcement/submission stages checked")
            return 0

        inv = sweep(win, tab, courses)
        if not isinstance(inv, dict):
            log(f"sweep failed: {inv}")
            return 1

        manifest = load_json(MANIFEST, {"synced_at": None, "courses": {}})
        fetched = load_json(FETCHED, {})
        now = datetime.now(timezone.utc).isoformat()

        report, new_files, errors = [], [], []
        drive_actions = []
        term = getattr(discover_courses, "current_term", None)
        if requested:
            inv = {c: items for c, items in inv.items() if c in scope}
        plan = material_revisions.select_candidates(inv, fetched, courses, term,
            max_count=MAX_DOWNLOADS_PER_RUN, max_rechecks=4,
            max_recheck_bytes=64 * 1024 * 1024, max_recheck_seconds=120,
            max_large_rechecks=0)
        native_status = native_download_status()
        native_topics = set() if native_status["blocked"] else native_material_intake.pending_topics(ROOT)
        held = [row for row in plan["selected"]
                if (row["course"], str(row["item"]["id"])) in native_topics]
        plan["selected"] = [row for row in plan["selected"] if row not in held]
        plan["deferred"].extend(dict(row, reason="native_download_pending") for row in held)
        fetched = material_revisions.observe_inventory(inv, fetched, courses, term)
        save_json(FETCHED, fetched)
        state["material_revision_deferred"] = len(plan["deferred"])
        selected = {}
        for candidate in plan["selected"]:
            selected.setdefault(candidate["course"], []).append(candidate)
        fallback_bytes, fallback_seconds, attempted, captured, capture_failed = 0, 0.0, 0, 0, 0
        # A crashed/timed-out browser transfer can remain server-side without a
        # .crdownload. Only an observed terminal source capture clears this latch;
        # elapsed time, --force, another browser tab or a new listing cannot do so.
        download_blocked = bool(state.get("material_capture_hold"))
        if download_blocked:
            errors.append("Download capture remains unconfirmed; native downloads remain held; supported exact-file checks can continue")
        if native_status["blocked"] or native_topics:
            # Native transfers share Downloads with the generic capture helper.
            # Their late completion could be mistaken for *another* topic, so
            # hold shared-folder captures until the registered transfers settle.
            # Exact-file transport never reads that folder or clears its receipts.
            download_blocked = True
            errors.append("Registered native downloads remain pending or unreadable; native source captures are deferred")
        queue = delivery_queue()
        for course in sorted(inv):
            items = inv[course]
            if not isinstance(items, list):
                errors.append(f"{course}: source listing unavailable")
                continue
            previous_items = manifest["courses"].get(course, {}).get("items", [])
            known = {str(i["id"]) for i in previous_items}
            present = {str(i["id"]) for i in items}
            added = [i for i in items if str(i["id"]) not in known]
            gone = [i for i in previous_items if str(i["id"]) not in present]
            wanted = selected.get(course, [])
            report.append(f"{course}: listing checked ({len(items)} items; {len(added)} added, {len(gone)} removed); "
                          f"{len(wanted)} source byte check(s) selected")
            for candidate in wanted:
                item = candidate["item"]
                topic_id = str(item["id"])
                previous = fetched.get(topic_id)
                fallback = candidate["reason"] in ("migration_unverified", "periodic_recheck")
                direct = direct_material_capture.eligible(item, courses[course])
                if (download_blocked or source_only) and not direct:
                    state["material_revision_deferred"] += 1
                    continue
                if fallback and (fallback_bytes >= 64 * 1024 * 1024 or fallback_seconds >= 120):
                    state["material_revision_deferred"] += 1
                    continue
                if attempted and attempted % DOWNLOAD_BATCH == 0: time.sleep(8)
                started = time.monotonic()
                capture_temp = None
                source_receipt = None
                attempted += 1
                try:
                    capture_id = hashlib.sha256(f"{course}:{topic_id}:{time.time_ns()}".encode()).hexdigest()
                    if direct:
                        capture_temp = tempfile.TemporaryDirectory(prefix="sidekick-material-")
                        got, source_receipt = direct_material_capture.capture(win, tab, courses[course],
                            item, capture_temp.name,
                            max_bytes=min(direct_material_capture.MAX_BYTES,
                                64 * 1024 * 1024 - fallback_bytes) if fallback else direct_material_capture.MAX_BYTES,
                            timeout=min(110, max(1, 120 - fallback_seconds)) if fallback else 110)
                    else:
                        before = snapshot_downloads()
                        state["material_capture_hold"] = {"capture_id": capture_id, "course": course,
                            "topic_id": topic_id, "started_at": datetime.now(timezone.utc).isoformat(),
                            "reason": "download_in_flight"}
                        save_json(STATE, state)  # intent survives a process death after the click
                        trigger_download(win, tab, courses[course], item["id"])
                        kwargs = ({"start_timeout": max(1, 120 - fallback_seconds),
                                   "idle_timeout": max(1, 120 - fallback_seconds),
                                   "hard_cap": max(1, 120 - fallback_seconds),
                                   "max_bytes": 64 * 1024 * 1024 - fallback_bytes} if fallback else {})
                        got = settle_new_file(before, **kwargs)
                    if not got: raise ValueError("download_unconfirmed")
                    size = os.path.getsize(got)
                    if not size or fallback and size + fallback_bytes > 64 * 1024 * 1024:
                        raise ValueError("download_budget_or_empty")
                    if fallback: fallback_bytes += size
                    raw_path, duplicate = stash(course, got, item["title"])
                    digest = material_revisions.content_digest(raw_path)
                    old_digest = (previous or {}).get("revisions", {}).get("sha256")
                    if old_digest is None and (previous or {}).get("raw"):
                        old_path = os.path.join(ROOT, course, "raw", previous["raw"])
                        if os.path.isfile(old_path): old_digest = material_revisions.content_digest(old_path)
                    old_meta = (previous or {}).get("revisions", {}).get("metadata", {})
                    changed = (digest != old_digest or (previous or {}).get("title") != item["title"]
                               or old_meta.get("unit", item.get("unit", "")) != item.get("unit", ""))
                    # The queue is durable before fetched advances: a crash after
                    # the download can never make extraction/upload work disappear.
                    if changed or course + ":" + topic_id not in queue.entries(read_only=True):
                        record = queue.enqueue(course, topic_id, raw_path, item["title"], item.get("unit", ""))
                    result = material_revisions.record_success(previous, item, course, courses[course], term,
                        digest, size, os.path.basename(raw_path))
                    result["capture_id"] = capture_id
                    if source_receipt:
                        result["direct_source_receipt"] = source_receipt
                    fetched[topic_id] = result
                    save_json(FETCHED, fetched)
                    if not direct:
                        state.pop("material_capture_hold", None)
                    save_json(STATE, state)
                    captured += 1
                    if changed:
                        new_files.append((course, item["title"], raw_path))
                        report.append(f"    UPDATED  {item['title']} (source bytes/provenance captured; delivery tracked)")
                    else: report.append(f"    VERIFIED {item['title']} (source payload unchanged)")
                except Exception as exc:
                    capture_failed += 1
                    # A delayed server-side ZIP can appear after a timeout with
                    # no earlier .crdownload. Do not assign it to a later topic.
                    if not direct:
                        download_blocked = True
                        state["material_capture_hold"]["reason"] = "download_or_capture_unconfirmed"
                        save_json(STATE, state)
                    failure = direct_material_capture.failure_reason(exc) if direct else "download_or_capture_unconfirmed"
                    fetched[topic_id] = material_revisions.record_failure(previous, item, course,
                        courses[course], term, failure, reason=candidate["reason"])
                    save_json(FETCHED, fetched)
                    errors.append(f"{course}: source byte check incomplete for topic {topic_id}")
                finally:
                    if capture_temp: capture_temp.cleanup()
                    if fallback: fallback_seconds += time.monotonic() - started
                time.sleep(DOWNLOAD_GAP)
            manifest["courses"][course] = {"items": items, "checked_at": now}
        manifest["synced_at"] = now
        save_json(MANIFEST, manifest)
        if source_only:
            state["source_only_material_check"] = {"checked_at": datetime.now(timezone.utc).isoformat(), "courses": sorted(inv),
                "status": "partial" if capture_failed or state["material_revision_deferred"]
                    or any(not isinstance(items, list) for items in inv.values()) else "captured",
                "attempted": attempted, "captured": captured, "failed": capture_failed,
                "deferred": state["material_revision_deferred"], "publication": "not_attempted"}
        elif not requested:
            state["last_success_epoch"] = time.time()
            state["last_success"] = now
        else:
            state.setdefault("scoped_material_checks", {})[requested] = now
        save_json(STATE, state)
        if source_only:
            recovery = recover_local_materials(set(inv), seed=False)
            print(json.dumps({"mode": "source_only", "source": state["source_only_material_check"],
                "delivery": recovery, "gpt_pending": len(load_pending()["files"]),
                "native_capture_hold_preserved": bool(state.get("material_capture_hold"))}))
            return 1 if capture_failed else 0
        recovery = recover_materials(set(inv), seed=False)
        if recovery["pending"]:
            errors.append(f"Material delivery: {recovery['pending']} source(s) still pending; stage retries are durable")
        if state["material_revision_deferred"]:
            report.append(f"{state['material_revision_deferred']} source recheck(s) deferred by bounded budgets/cooldown; "
                          "unchanged listing metadata is not verified unchanged bytes")

        # ---- upload everything owed, including leftovers from earlier runs
        uploaded, still_pending, upload_errors = [], load_pending()["files"], []
        if still_pending and not materials_only:
            uploaded, still_pending, upload_errors = flush_upload_queue(dry=dry)
        errors += upload_errors

        # ---- report
        os.makedirs(REPORTS, exist_ok=True)
        stamp = datetime.now().strftime("%Y-%m-%d_%H%M")
        lines = [f"# eLC sweep — {datetime.now().strftime('%A %d %B %Y, %-I:%M %p')}", ""]
        lines += report
        if drive_actions:
            lines += ["", "## FILED TO GOOGLE DRIVE", ""]
            for act, rel in drive_actions:
                lines.append("  - %s%s" % (rel, "   (superseded the previous version)"
                                           if act == "superseded" else ""))
        if uploaded:
            lines += ["", "## UPLOADED TO GPT KNOWLEDGE", ""]
            lines += [f"  - {u}" for u in uploaded]
        if still_pending:
            lines += ["", "## STILL QUEUED FOR UPLOAD",
                      "Tracked in .pending-upload.json and retried next run.", ""]
            lines += [f"  - {e['course']}: {os.path.basename(e['text'])}"
                      f" ({e.get('attempts', 0)} failed attempt(s))"
                      + (f" - {e['last_error']}" if e.get("last_error") else "")
                      for e in still_pending]
        if errors:
            lines += ["", "## PROBLEMS"] + [f"  - {e}" for e in errors]
        body = "\n".join(lines) + "\n"

        path = os.path.join(REPORTS, f"{stamp}-sweep.md")
        if not dry:
            with open(path, "w") as f:
                f.write(body)
            with open(os.path.join(REPORTS, "latest.md"), "w") as f:
                f.write(body)
        print(body)

        # ---- alert only when something actually changed
        if new_files:
            by_course = {}
            for c, t, _ in new_files:
                by_course.setdefault(c, []).append(t)
            summary = "; ".join(f"{c}: {len(v)} new" for c, v in by_course.items())
            log(f"NEW MATERIAL — {summary}")
            if not dry:
                notify("New eLC material", summary + " — staged, needs GPT upload")
                first = new_files[0]
                if uploaded and not still_pending and not recovery["pending"]:
                    tail = (f"All {len(uploaded)} extracted file(s) are already in "
                            f"GPT Knowledge — ask me about them directly.")
                elif uploaded:
                    tail = (f"{len(uploaded)} file(s) uploaded to GPT Knowledge, "
                            f"{len(still_pending)} still queued.")
                else:
                    tail = (f"Delivery still tracks {recovery['pending']} source(s), and "
                            f"{len(still_pending)} GPT publication(s) remain queued; the sweep will retry.")
                post_bridge_note(
                    f"New eLC material found {datetime.now().strftime('%b %-d')}: "
                    f"{summary}. Example: {first[1]}. {tail}")
        elif errors:
            log(f"sweep finished with {len(errors)} problem(s)")
            if not dry:
                notify("eLC sweep problems", errors[0][:120])
        else:
            log("sweep clean, nothing new")
        return 0

    except cb.ChromeJSDisabled as e:
        if announcements_due and not announcement_recorded:
            elc_announcements.blocked("browser", dry=dry, force=True,
                                      log=log, rss_results=rss_results)
        if submissions_due and not submission_recorded:
            elc_submission.blocked("browser", dry=dry, force=True, log=log)
        log(f"BLOCKED: {e}")
        if not source_only:
            notify("eLC sweep blocked",
                   "Open BrowserOS neo and check its connected collector session; no browser fallback")
        return 0
    except cb.ChromeError as e:
        if announcements_due and not announcement_recorded:
            elc_announcements.blocked("browser", dry=dry, force=True,
                                      log=log, rss_results=rss_results)
        if submissions_due and not submission_recorded:
            elc_submission.blocked("browser", dry=dry, force=True, log=log)
        log(f"Neo browser error: {e}")
        return 1
    finally:
        if opened and loc:
            cb.close_tab(*loc)


def main():
    if "--source-only" in sys.argv and "--upload-only" in sys.argv:
        print("--source-only cannot be combined with --upload-only")
        return 2
    if "--dry-run" in sys.argv:
        return _main()
    os.makedirs(ROOT, exist_ok=True)
    fd = os.open(os.path.join(ROOT, ".material-run.lock"), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("material collector already running; retained work will be retried")
            return 0
        failure = None
        try:
            return _main()
        except Exception:
            failure = "state_or_delivery_unconfirmed"
            print("material recovery blocked; persisted work retained for review")
            return 1
        finally:
            try: material_health(failure, source_only="--source-only" in sys.argv)
            except Exception: print("material health could not be saved; state retained")
    finally:
        os.close(fd)


if __name__ == "__main__":
    sys.exit(main())
