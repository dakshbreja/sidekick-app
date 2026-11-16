#!/usr/bin/env python3
"""Read course announcements on the existing eLC wakeup, independently of files.

The material sweep's four-hour cooldown once hid news-only date changes. This
stage has its own hourly receipt, reads the same authenticated Chrome session,
and never downloads files, opens grades, changes progress, or sets the material
sweep's success marker. Each complete course listing replaces only that course;
blocked or partial reads preserve the last complete rows and their observation
times. The bridge receives bounded scheduling excerpts, not arbitrary news HTML.

News API and version discovery contracts:
https://docs.valence.desire2learn.com/res/news.html
https://docs.valence.desire2learn.com/res/apiprop.html
"""
import copy
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import parse_qs, urlparse
import uuid
import xml.etree.ElementTree as ET

import chrome_bridge as cb

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / "announcement-sources.json"
STATE = ROOT / ".announcement-state.json"
OUTBOX = ROOT / ".announcement-outbox.json"
BRIDGE_CONFIG = ROOT.parent / "bridge/.env"
RSS_CONFIG = ROOT / ".announcement-rss.json"
MIN_GAP_SECONDS = 55 * 60
MAX_PER_COURSE = 120
MAX_TITLE = 240
MAX_EXCERPTS = 4000
MAX_BODY = 24000
MAX_SNAPSHOT_BYTES = 750 * 1024
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
API_TIMEOUT = 25
ERRORS = {"session", "browser", "course_identity", "course_missing", "http",
          "timeout", "response", "oversized", "duplicate_identity", "privacy",
          "publication", "version", "source_unavailable"}
_UNSET = object()


def stamp(value=_UNSET):
    if value is _UNSET:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")
    if value is None:
        return None
    try:
        d = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if d.tzinfo is None:
            return None
        return d.astimezone(timezone.utc).isoformat(timespec="seconds")
    except (ValueError, TypeError):
        return None


def load_json(path, default):
    try:
        path = Path(path)
        if path.stat().st_size > MAX_RESPONSE_BYTES:
            return copy.deepcopy(default)
        result = json.loads(path.read_text())
        return result if isinstance(result, type(default)) else copy.deepcopy(default)
    except (OSError, ValueError):
        return copy.deepcopy(default)


def save_json(path, obj):
    """The local receipt/outbox contains private course evidence, never world read."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as f:
            os.fchmod(f.fileno(), 0o600)
            json.dump(obj, f, ensure_ascii=False, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def source_config(path=SOURCES):
    cfg = load_json(path, {})
    if (cfg.get("schema_version") != 1 or cfg.get("term_id") != "fall-2026"
            or cfg.get("elc_term_code") != "20272"
            or not isinstance(cfg.get("courses"), dict)
            or set(cfg["courses"]) != {"BUSN5000", "BUSN3040", "MGMT4280",
                                       "MGMT5560", "MGMT5850", "LAND2510"}
            or not all(re.fullmatch(r"[1-9]\d{0,11}", str(v)) for v in cfg["courses"].values())):
        raise ValueError("announcement source configuration invalid")
    return cfg


def course_code(value):
    text = str(value).upper()
    return text[:-1] if text in ("LAND2510E", "BUSN3040E") else text


class PlainText(HTMLParser):
    """Extract text without running scripts, loading images, or retaining links."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.hidden = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "iframe", "object"):
            self.hidden += 1
        if tag in ("p", "div", "br", "li", "h1", "h2", "h3", "tr"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "iframe", "object") and self.hidden:
            self.hidden -= 1
        if tag in ("p", "div", "li", "tr"):
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def body_text(body):
    if not isinstance(body, dict):
        raise ValueError("response")
    html = body.get("Html")
    if isinstance(html, str) and html:
        if len(html) > MAX_BODY * 4:
            raise ValueError("oversized")
        parser = PlainText()
        parser.feed(html)
        result = "".join(parser.parts)
    else:
        result = body.get("Text", "")
        if not isinstance(result, str):
            raise ValueError("response")
    result = re.sub(r"[\t \u00a0]+", " ", result)
    result = re.sub(r"\n\s*\n+", "\n", result).strip()
    if len(result) > MAX_BODY:
        raise ValueError("oversized")
    return result


SECRET = re.compile(r"(?i)(?:access[_ -]?token|refresh[_ -]?token|api[_ -]?key|client[_ -]?secret|password|passcode|token|authorization|bearer)\s*[:=]\s*\S+|\b(?:password|passcode)\s+(?:is\s+)?\S+")
SCORES = re.compile(r"(?i)\b(?:grade|score|points?\s+(?:earned|received))\b[^.!?\n]{0,60}\b\d+(?:\.\d+)?(?:\s*/\s*\d+)?|\b\d+(?:\.\d+)?\s*(?:%|percent\b)")
DATE = re.compile(r"(?i)\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\b|\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b|\b20\d{2}-\d\d-\d\d\b")
SCHEDULE = re.compile(r"(?i)\b(?:exam|test|quiz|assignment|project|paper|homework|deadline|due|presentation|class|lecture|meeting|lab|discussion|review|submit|submission|office hours)\b")
CHANGE = re.compile(r"(?i)\b(?:mov(?:e|ed|ing)|reschedul\w*|postpon\w*|cancel\w*|extend\w*|chang\w*|instead|now|will|held|administered|due|deadline|schedule\w*)\b")


def scheduling_excerpts(text, title):
    """Select source sentences; extraction does not decide which date is true."""
    parts = [s.strip() for s in re.split(r"[\r\n]+|(?<=[.!?])\s+(?=[A-Z])", text) if s.strip()]
    selected, redacted = [], False
    for part in parts:
        if SECRET.search(part) or SCORES.search(part):
            redacted = True
            continue
        has_date = bool(DATE.search(part))
        cancellation = bool(re.search(r"(?i)\bcancel\w*\b", part))
        if (has_date or cancellation) and (SCHEDULE.search(part) or SCHEDULE.search(title)) and CHANGE.search(part):
            selected.append(part)
    excerpt = "\n".join(selected)
    if len(excerpt) > MAX_EXCERPTS:
        raise ValueError("oversized")
    return excerpt, redacted


def normalize_items(course, org, items, observed_at, term_id="fall-2026"):
    if not isinstance(items, list):
        raise ValueError("response")
    if len(items) > MAX_PER_COURSE:
        raise ValueError("oversized")
    result, seen = [], set()
    for raw in items:
        if not isinstance(raw, dict):
            raise ValueError("response")
        identifier = str(raw.get("Id", ""))
        if not re.fullmatch(r"[1-9]\d{0,11}", identifier) or identifier in seen:
            raise ValueError("duplicate_identity" if identifier in seen else "response")
        seen.add(identifier)
        # A student-visible published listing is the authority. Hidden/draft
        # items are not teaching evidence even if a provider returns them.
        if raw.get("IsPublished") is not True or raw.get("IsHidden") is True:
            continue
        title = raw.get("Title")
        if not isinstance(title, str) or not title.strip() or len(title) > MAX_TITLE:
            raise ValueError("response")
        title = re.sub(r"\s+", " ", title).strip()
        if SECRET.search(title) or SCORES.search(title):
            raise ValueError("privacy")
        text = body_text(raw.get("Body"))
        excerpts, redacted = scheduling_excerpts(text, title)
        # The digest detects edits without copying unrelated announcement text.
        digest = hashlib.sha256(json.dumps([course, org, identifier, title, text],
            ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        published = stamp(raw.get("StartDate")) if raw.get("StartDate") else None
        published = published or (stamp(raw.get("CreatedDate")) if raw.get("CreatedDate") else None)
        modified = stamp(raw.get("LastModifiedDate")) if raw.get("LastModifiedDate") else None
        result.append({"announcement_id": identifier, "course_code": course,
            "term_id": term_id, "org_unit_id": str(org), "title": title,
            "text": excerpts, "source_url": "https://uga.view.usg.edu/d2l/le/news/"
                + str(org) + "/" + identifier + "/view?ou=" + str(org),
            "published_at": published, "modified_at": modified,
            "feed_published_at": stamp(raw.get("FeedPublishedDate")) if raw.get("FeedPublishedDate") else None,
            "observed_at": observed_at, "content_sha256": digest,
            "privacy_redacted": redacted})
    return sorted(result, key=lambda row: row["announcement_id"])


def snapshot(results, previous=None, *, cfg=None, observed_at=None):
    """Per-course failed reads cannot erase or freshen earlier good evidence."""
    cfg = cfg or source_config()
    at = stamp(observed_at) or stamp()
    previous = previous or {}
    prior_coverage = {r.get("course_code"): r for r in previous.get("coverage", []) if isinstance(r, dict)}
    prior_items = previous.get("announcements", []) if previous.get("term_id") == cfg["term_id"] else []
    coverage, announcements = [], []
    for course, org in sorted(cfg["courses"].items()):
        result = results.get(course) if isinstance(results, dict) else None
        old = prior_coverage.get(course, {})
        err, rows = None, None
        scope = "recent_feed" if isinstance(result, dict) and result.get("scope") == "recent_feed" else "full_listing"
        if isinstance(result, dict) and result.get("ok") is True and str(result.get("org_unit_id")) == str(org):
            try:
                rows = normalize_items(course, org, result.get("items"), at, cfg["term_id"])
            except ValueError as e:
                err = str(e) if str(e) in ERRORS else "response"
        else:
            err = result.get("error") if isinstance(result, dict) else "source_unavailable"
            err = err if err in ERRORS else "response"
        okay = rows is not None
        if not okay:
            rows = [copy.deepcopy(r) for r in prior_items if r.get("course_code") == course and str(r.get("org_unit_id")) == str(org)]
        elif scope == "recent_feed":
            # RSS currently exposes only the newest three posts. Absence from
            # that bounded feed cannot delete a retained announcement or prove
            # that an older post has not been edited.
            merged = {r["announcement_id"]: copy.deepcopy(r) for r in prior_items
                      if r.get("course_code") == course and str(r.get("org_unit_id")) == str(org)}
            for row in rows:
                prior = merged.get(row["announcement_id"])
                if prior and prior.get("content_sha256") == row["content_sha256"]:
                    # The RSS provider lacks original creation/edit fields. An
                    # unchanged source body need not erase already known dates.
                    row["published_at"] = row.get("published_at") or prior.get("published_at")
                    row["modified_at"] = row.get("modified_at") or prior.get("modified_at")
                merged[row["announcement_id"]] = row
            if len(merged) > MAX_PER_COURSE:
                okay, err = False, "oversized"
                rows = [copy.deepcopy(r) for r in prior_items if r.get("course_code") == course and str(r.get("org_unit_id")) == str(org)]
            else:
                rows = sorted(merged.values(), key=lambda r: r["announcement_id"])
        announcements.extend(rows)
        coverage.append({"course_code": course, "org_unit_id": str(org),
            "status": "ok" if okay else ("blocked" if err in ("session", "browser", "course_missing", "course_identity") else "incomplete" if err in ("oversized", "duplicate_identity", "privacy", "response") else "failed"),
            "checked_at": at, "last_success_at": at if okay else old.get("last_success_at"),
            "last_complete_success_at": at if okay and scope == "full_listing" else old.get("last_complete_success_at"),
            "scope": scope, "complete": okay and scope == "full_listing", "error": None if okay else err})
    complete = all(r["complete"] for r in coverage)
    successful = all(r["status"] == "ok" for r in coverage)
    out = {"schema_version": 1, "source": "eLC (D2L)", "term_id": cfg["term_id"],
        "attempted_at": at, "last_success_at": at if successful else previous.get("last_success_at"),
        "last_complete_success_at": at if complete else previous.get("last_complete_success_at"),
        "expected_courses": sorted(cfg["courses"]), "coverage": coverage,
        "announcements": sorted(announcements, key=lambda r: (r["course_code"], r["announcement_id"]))}
    if len(json.dumps(out, ensure_ascii=False).encode()) > MAX_SNAPSHOT_BYTES:
        return snapshot({c: {"error": "oversized"} for c in cfg["courses"]}, previous, cfg=cfg, observed_at=at)
    return out


def parse_rss(raw, course, org):
    if len(raw) > MAX_RESPONSE_BYTES or b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
        raise ValueError("oversized")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        raise ValueError("response") from None
    if root.tag != "rss" or root.find("channel") is None:
        raise ValueError("response")
    items, seen = [], set()
    nodes = root.findall("./channel/item")
    if len(nodes) > MAX_PER_COURSE:
        raise ValueError("oversized")
    for item in nodes:
        guid = item.findtext("guid", "")
        match = re.fullmatch(r"([1-9]\d{0,11})-([1-9]\d{0,11})", guid)
        link = urlparse(item.findtext("link", ""))
        if (not match or match[2] != str(org) or match[1] in seen
                or link.scheme != "https" or link.hostname != "uga.view.usg.edu"
                or parse_qs(link.query).get("ou") != [str(org)]):
            raise ValueError("duplicate_identity" if match and match[1] in seen else "course_identity")
        seen.add(match[1])
        try:
            when = parsedate_to_datetime(item.findtext("pubDate", ""))
            published = when.astimezone(timezone.utc).isoformat(timespec="seconds") if when.tzinfo else None
        except (ValueError, TypeError):
            published = None
        items.append({"Id": match[1], "Title": item.findtext("title", ""),
            "Body": {"Html": item.findtext("description", "")},
            "IsPublished": True, "IsHidden": False, "StartDate": None,
            "FeedPublishedDate": published,
            "LastModifiedDate": None})
    return {"ok": True, "org_unit_id": str(org), "items": items, "scope": "recent_feed"}


def read_rss_courses(*, cfg=None, config_path=RSS_CONFIG):
    """Private feed tokens remain solely in the existing owner's local reader."""
    cfg = cfg or source_config()
    feeds = load_json(config_path, {})
    if feeds.get("schema_version") != 1 or feeds.get("term_id") != cfg["term_id"]:
        return {}
    configured = feeds.get("feeds")
    if not isinstance(configured, dict):
        return {}
    results = {}
    for course, org in sorted(cfg["courses"].items()):
        url = configured.get(course)
        if not isinstance(url, str):
            continue
        parsed = urlparse(url)
        if (parsed.scheme != "https" or parsed.netloc != "uga.view.usg.edu"
                or parsed.path != "/d2l/le/news/rss/" + str(org) + "/course"
                or parse_qs(parsed.query).get("ou") != [str(org)]
                or not parse_qs(parsed.query).get("token")):
            results[course] = {"error": "course_identity"}
            continue
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "school-announcements/1.0"})
            # urllib redirects could send a private token to a different host.
            opener = urllib.request.build_opener(NoRedirect())
            with opener.open(req, timeout=API_TIMEOUT) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
            results[course] = parse_rss(raw, course, org)
        except ValueError as error:
            results[course] = {"error": str(error) if str(error) in ERRORS else "response"}
        except urllib.error.HTTPError as error:
            results[course] = {"error": "session" if error.code in (401, 403) else "http"}
        except (urllib.error.URLError, OSError):
            results[course] = {"error": "source_unavailable"}
    return results


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read_courses(win, tab, discovered, *, cfg=None, term_code=None):
    """News is fetched with explicit source identity and bounded response sizes."""
    cfg = cfg or source_config()
    found = {course_code(c): str(org) for c, org in (discovered or {}).items()}
    results, selected = {}, {}
    for course, org in cfg["courses"].items():
        if term_code != cfg["elc_term_code"] or found.get(course) != str(org):
            results[course] = {"error": "course_missing" if course not in found else "course_identity"}
        else:
            selected[course] = str(org)
    if not selected:
        return results
    js = r"""
      window.__announcementRead = 'pending';
      (async function(){
        var C = __COURSES__, out = {}, versions = ['1.82'];
        async function request(path) {
          var abort = new AbortController(), timer = setTimeout(function(){abort.abort();},25000);
          try {
            var r = await fetch(path,{credentials:'include',signal:abort.signal,cache:'no-store'});
            if (!r.ok) return {error:(r.status===401||r.status===403)?'session':'http'};
            var txt = await r.text();
            if (txt.length > 2097152) return {error:'oversized'};
            try { return {json:JSON.parse(txt)}; } catch(e) { return {error:'response'}; }
          } catch(e) { return {error:e && e.name==='AbortError'?'timeout':'response'}; }
          finally {clearTimeout(timer);}
        }
        var v = await request('/d2l/api/le/versions/');
        if (v.json && Array.isArray(v.json.SupportedVersions)) {
          var supported = v.json.SupportedVersions.filter(function(x){return /^1\.\d+$/.test(x) && Number(x.split('.')[1])>=82;});
          supported.sort(function(a,b){return Number(a.split('.')[1])-Number(b.split('.')[1]);});
          if(supported.length) versions=[supported[0],supported[supported.length-1]].filter(function(x,i,a){return a.indexOf(x)===i;});
        }
        for(var code of Object.keys(C).sort()) {
          var got;
          for(var version of versions) {
            got = await request('/d2l/api/le/'+version+'/'+C[code]+'/news/');
            if(!got.error || got.error==='session' || got.error==='timeout') break;
          }
          out[code] = got.json && Array.isArray(got.json) ? {ok:true,org_unit_id:C[code],items:got.json} : {error:got.error||'response'};
        }
        window.__announcementRead = out;
      })().catch(function(){window.__announcementRead={error:'response'};});
      'ok'
    """.replace("__COURSES__", json.dumps(selected))
    try:
        cb.run_js(win, tab, js)
        fetched = cb.await_global(win, tab, "__announcementRead", timeout=60 + len(selected) * 55)
        if isinstance(fetched, dict):
            results.update({c: fetched.get(c, {"error": "response"}) for c in selected})
        else:
            results.update({c: {"error": "response"} for c in selected})
    except cb.ChromeError:
        results.update({c: {"error": "browser"} for c in selected})
    return results


def bridge_config(path=BRIDGE_CONFIG):
    values = {}
    try:
        for line in Path(path).read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        return None
    return values if values.get("WORKER_URL") and values.get("API_KEY") else None


def bridge_request(config, method, path, data=None):
    req = urllib.request.Request(config["WORKER_URL"].rstrip("/") + path,
        data=json.dumps(data, ensure_ascii=False).encode() if data is not None else None,
        method=method, headers={"Authorization": "Bearer " + config["API_KEY"],
            "Content-Type": "application/json", "User-Agent": "school-announcements/1.0",
            "X-Bridge-Client": "collector"})
    with urllib.request.urlopen(req, timeout=API_TIMEOUT) as response:
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("response")
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError("response")
        return result


def merge_after_conflict(pending, stored):
    """A conclusive CAS rejection may rebase, never overwrite fresher evidence."""
    out = copy.deepcopy(pending)
    rows = {r["course_code"]: r for r in out.get("coverage", [])}
    newer = {r["course_code"]: r for r in stored.get("coverage", [])}
    items = out.get("announcements", [])
    for course, old in newer.items():
        incoming = rows.get(course, {})
        if (stamp(old.get("checked_at")) or "") > (stamp(incoming.get("checked_at")) or ""):
            rows[course] = copy.deepcopy(old)
            items = [r for r in items if r.get("course_code") != course]
            items += [copy.deepcopy(r) for r in stored.get("announcements", []) if r.get("course_code") == course]
    out["coverage"] = sorted(rows.values(), key=lambda r: r["course_code"])
    out["announcements"] = sorted(items, key=lambda r: (r["course_code"], r["announcement_id"]))
    for field in ("attempted_at", "last_success_at", "last_complete_success_at"):
        values = [stamp(v) for v in (out.get(field), stored.get(field)) if v]
        out[field] = max(values) if values else None
    return out


def own_rows_saved(sent, stored):
    """Receipt digest/readback must also contain the fresh source rows we sent."""
    if not isinstance(stored, dict):
        return False
    read = {(r.get("course_code"), r.get("announcement_id")): r for r in stored.get("announcements", [])}
    coverage = {r.get("course_code"): r for r in sent.get("coverage", [])}
    for row in sent.get("announcements", []):
        c = coverage.get(row.get("course_code"), {})
        if c.get("status") != "ok" or stamp(row.get("observed_at")) != stamp(c.get("checked_at")):
            continue
        found = read.get((row["course_code"], row["announcement_id"]), {})
        if (found.get("content_sha256") != row.get("content_sha256")
                or stamp(found.get("observed_at")) != stamp(row.get("observed_at"))
                or found.get("text") != row.get("text")
                or found.get("source_url") != row.get("source_url")):
            return False
    return True


def publish_pending(*, state_path=STATE, outbox_path=OUTBOX, config=None, log=None):
    """A POST acknowledgement alone is not a saved receipt; read it back."""
    log = log or (lambda message: None)
    config = config or bridge_config()
    box = load_json(outbox_path, {})
    if not box:
        return True
    if not config:
        log("announcements: publication unavailable (configuration)")
        return False
    try:
        if box.get("expected_revision") is None:
            existing = bridge_request(config, "GET", "/announcements")
            box["expected_revision"] = existing.get("revision", 0)
            save_json(outbox_path, box)
        try:
            response = bridge_request(config, "POST", "/announcements/report", box)
        except urllib.error.HTTPError as error:
            # A revision conflict definitively rejected this logical write; it
            # has no receipt. Unknown responses keep the exact original key.
            if error.code != 409:
                raise
            try:
                rejection = json.loads(error.read(4096))
            except (ValueError, OSError):
                raise ValueError("publication") from None
            if rejection.get("error") != "revision_conflict":
                raise ValueError("publication")
            latest = bridge_request(config, "GET", "/announcements")
            box["snapshot"] = merge_after_conflict(box["snapshot"], latest.get("snapshot") or {})
            box["expected_revision"] = latest["revision"]
            box["idempotency_key"] = str(uuid.uuid4())
            save_json(outbox_path, box)
            response = bridge_request(config, "POST", "/announcements/report", box)
        if (response.get("ok") is not True or not isinstance(response.get("snapshot_digest"), str)
                or not isinstance(response.get("revision"), int)
                or response.get("operation_id", box["idempotency_key"]) != box["idempotency_key"]):
            raise ValueError("publication")
        reread = bridge_request(config, "GET", "/announcements")
        superseded = (isinstance(reread.get("revision"), int)
            and reread["revision"] > response["revision"]
            and isinstance(reread.get("snapshot_digest"), str)
            and isinstance(reread.get("snapshot"), dict)
            and reread.get("ok") is not False)
        if superseded:
            # Receipt replay proves the earlier logical write committed. A
            # later source read may already have replaced it; do not repeatedly
            # retry or overwrite that newer state to make the old digest match.
            state = load_json(state_path, {})
            state["publication"] = {"ok": True, "state": "superseded",
                "revision": response["revision"], "snapshot_digest": response["snapshot_digest"],
                "received_at": response.get("received_at"),
                "current_revision": reread["revision"], "current_snapshot_digest": reread["snapshot_digest"]}
            state["snapshot"] = reread["snapshot"]
            save_json(state_path, state)
            Path(outbox_path).unlink(missing_ok=True)
            log("announcements: earlier publication committed; a newer source receipt is current")
            return True
        if (reread.get("snapshot_digest") != response["snapshot_digest"]
                or reread.get("revision") != response.get("revision")
                or not own_rows_saved(box["snapshot"], reread.get("snapshot"))):
            raise ValueError("publication")
        state = load_json(state_path, {})
        state["publication"] = {"ok": True, "revision": response["revision"],
            "snapshot_digest": response["snapshot_digest"], "received_at": response.get("received_at")}
        state["snapshot"] = reread["snapshot"]
        save_json(state_path, state)
        Path(outbox_path).unlink(missing_ok=True)
        log("announcements: publication saved and read back")
        return True
    except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError):
        # Raw provider response/error strings can contain a request, key or body.
        log("announcements: publication pending; will retry the same receipt")
        return False


def record(results, *, cfg=None, observed_at=None, dry=False, state_path=STATE,
           outbox_path=OUTBOX, log=None):
    log = log or (lambda message: None)
    previous = load_json(state_path, {})
    data = snapshot(results, previous.get("snapshot"), cfg=cfg, observed_at=observed_at)
    count = sum(row["complete"] for row in data["coverage"])
    log("announcements: %d/%d complete course checks; %d bounded source records" %
        (count, len(data["coverage"]), len(data["announcements"])))
    if dry:
        return data
    # Do not replace an uncertain logical save with a new idempotency key.
    if Path(outbox_path).exists():
        log("announcements: prior publication still pending; retained its receipt")
        return data
    previous.update(snapshot=data, last_attempt_epoch=time.time())
    save_json(state_path, previous)
    save_json(outbox_path, {"snapshot": data, "idempotency_key": str(uuid.uuid4()),
                           "expected_revision": None})
    publish_pending(state_path=state_path, outbox_path=outbox_path, log=log)
    return data


def due(*, state_path=STATE, now_epoch=None):
    state = load_json(state_path, {})
    return (now_epoch if now_epoch is not None else time.time()) - state.get("last_attempt_epoch", 0) >= MIN_GAP_SECONDS


def collect(win, tab, discovered, *, term_code=None, dry=False, force=False, log=None,
            rss_results=None):
    if not dry:
        publish_pending(log=log)
    if not force and not dry and not due():
        return None
    cfg = source_config()
    results = read_courses(win, tab, discovered, cfg=cfg, term_code=term_code)
    for course, item in (rss_results or {}).items():
        if item.get("ok") is True and results.get(course, {}).get("ok") is not True:
            results[course] = item
    return record(results, cfg=cfg, dry=dry, log=log)


def blocked(reason, *, dry=False, force=False, log=None, rss_results=None):
    if not dry:
        publish_pending(log=log)
    if not force and not dry and not due():
        return None
    cfg = source_config()
    results = {c: {"error": reason if reason in ERRORS else "source_unavailable"}
               for c in cfg["courses"]}
    results.update({c: row for c, row in (rss_results or {}).items() if row.get("ok") is True})
    return record(results, cfg=cfg, dry=dry, log=log)
