#!/usr/bin/env python3
"""Reconcile explicit original-source receipts through the existing Bridge API.

Collectors observe; this writer resolves exact current identities and verifies
atomic save receipts. Unknown saves retain the same packet and operation ID.
No browser, grades, answers, or coursework submission is performed here.
"""
from datetime import datetime, timezone, timedelta
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import urllib.error
import urllib.request
from urllib.parse import urlparse, parse_qs, urlencode
from zoneinfo import ZoneInfo
import fcntl

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / ".submission-reconcile-state.json"
CONFIG = ROOT.parent / "bridge/.env"
COURSES = {"BUSN5000", "MGMT4280", "MGMT5560", "MGMT5850", "LAND2510", "BUSN3040"}
TERM = "fall-2026"
TZ = ZoneInfo("America/New_York")
MAX_BYTES = 2_000_000


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("timestamp")
    try:
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("timestamp") from None
    if date.tzinfo is None:
        raise ValueError("timestamp")
    return date.astimezone(timezone.utc)


def normalized_title(value):
    text = re.sub(r"^(?:BUSN|MGMT|LAND)\s*\d{4}(?:E)?\b\s*[-–—:]?\s*", "", str(value), flags=re.I)
    text = re.sub(r"\s*[-–—:]?\s+(?:due|closes)\s*$", "", text, flags=re.I)
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def chapter_identity(title):
    text = normalized_title(title)
    match = re.fullmatch(r"(?:glo bus |globus )?chapter\s+(\d{1,2})\s+(exercises?|quiz)", text)
    if match:
        return (int(match[1]), "chapter_quiz" if match[2] == "quiz" else "chapter_exercise")
    match = re.fullmatch(r"(?:glo bus |globus )?chapter\s+(exercises?|quiz)\s+(\d{1,2})", text)
    return (int(match[2]), "chapter_quiz" if match[1] == "quiz" else "chapter_exercise") if match else None


def normalize_observation(row):
    if not isinstance(row, dict) or row.get("provider") not in {"elc", "globus", "gradescope"}:
        raise ValueError("provider")
    if row.get("course_code") not in COURSES or row.get("term_id") != TERM:
        raise ValueError("scope")
    if row.get("status") not in {"submitted", "completed"}:
        raise ValueError("explicit_receipt_required")
    title = row.get("title")
    item_id = row.get("provider_item_id")
    if not isinstance(title, str) or not title.strip() or len(title) > 240:
        raise ValueError("title")
    if not isinstance(item_id, str) or not re.fullmatch(r"[A-Za-z0-9:_./-]{1,180}", item_id):
        raise ValueError("source_identity")
    url = row.get("source_url", "")
    source = urlparse(url)
    hosts = {"elc": {"uga.view.usg.edu"}, "globus": {"www.glo-bus.com", "glo-bus.com"}, "gradescope": {"www.gradescope.com", "gradescope.com"}}
    if (source.scheme != "https" or source.netloc not in hosts[row["provider"]]
            or source.username or source.password or source.fragment
            or any(k.lower() in {"token", "key", "password", "access_token", "auth"} for k in parse_qs(source.query, keep_blank_values=True))):
        raise ValueError("source_url")
    observed = timestamp(row.get("observed_at"))
    now = datetime.now(timezone.utc)
    if not datetime(2026, 8, 1, tzinfo=timezone.utc) <= observed <= now + timedelta(minutes=5):
        raise ValueError("timestamp")
    submitted = timestamp(row["submitted_at"]) if row.get("submitted_at") else None
    if submitted and not datetime(2026, 8, 1, tzinfo=timezone.utc) <= submitted <= observed + timedelta(minutes=5):
        raise ValueError("timestamp")
    kind = row.get("kind")
    if row["provider"] == "globus":
        if row["course_code"] != "MGMT5560" or kind not in {"chapter_exercise", "chapter_quiz"}:
            raise ValueError("kind")
        if chapter_identity(title) != (row.get("chapter"), kind):
            raise ValueError("source_identity")
    if row["provider"] == "gradescope":
        identity = re.fullmatch(r"assignment:([1-9]\d*):submission:([1-9]\d*)", item_id)
        wanted = f"/courses/1353639/assignments/{identity[1]}/submissions/{identity[2]}" if identity else None
        if row["course_code"] != "BUSN5000" or kind != "assignment" or source.path.rstrip("/") != wanted or source.query:
            raise ValueError("source_identity")
    elif row["provider"] == "elc" and kind not in {"quiz", "assignment"}:
        raise ValueError("kind")
    if row["provider"] == "elc" and not submitted:
        raise ValueError("explicit_receipt_required")
    if row["provider"] == "elc":
        orgs = {"BUSN5000": "4048786", "MGMT4280": "4001788", "MGMT5560": "3963225",
                "MGMT5850": "3948871", "LAND2510": "3962245", "BUSN3040": "3955142"}
        identity = re.fullmatch(r"(quiz|assignment):([1-9]\d*):(attempt|submission):([1-9]\d*)", item_id)
        endpoint = re.fullmatch(r"/d2l/api/le/1\.(\d{2,3})/([1-9]\d*)/(.+)", source.path)
        if not identity or identity[1] != kind or identity[3] != ("attempt" if kind == "quiz" else "submission"):
            raise ValueError("source_identity")
        query = parse_qs(source.query, keep_blank_values=True)
        if any(len(values) != 1 for values in query.values()):
            raise ValueError("source_identity")
        if source.path == "/d2l/lms/quizzing/user/quiz_submissions_attempt.d2l" and kind == "quiz":
            allowed = {"qi", "ai", "ou", "isprv", "isInPopup", "cfql", "fromQB", "fromSubmissionsList"}
            if (not set(query) <= allowed or query.get("ou") != [orgs[row["course_code"]]]
                    or query.get("qi") != [identity[2]] or query.get("ai") != [identity[4]]):
                raise ValueError("source_identity")
        else:
            if not endpoint or int(endpoint[1]) < 82 or endpoint[2] != orgs[row["course_code"]]:
                raise ValueError("source_identity")
            wanted = "quizzes/" + identity[2] + "/attempts/" if kind == "quiz" else "dropbox/folders/" + identity[2] + "/submissions/mysubmissions/"
            if endpoint[3] != wanted or (kind == "quiz" and (set(query) != {"userId"} or not re.fullmatch(r"[1-9]\d*", query["userId"][0]))) or (kind == "assignment" and query):
                raise ValueError("source_identity")
    if row["provider"] == "globus":
        if item_id != f"chapter:{row['chapter']}:{'quiz' if kind == 'chapter_quiz' else 'exercise'}":
            raise ValueError("source_identity")
        if source.path not in {"/users/lobby/assignments/student-grades", "/users/lobby/schedule",
                               "/quest/chQuiz", "/quest/chQuiz/", f"/textbook/chex/review/{row['chapter']}"}:
            raise ValueError("source_identity")
    # Whitelist projection: raw scores/answers/feedback can never reach state/API.
    result = {key: row[key] for key in ("provider", "course_code", "term_id", "provider_item_id", "kind", "status")}
    result.update(title=title.strip(), source_url=url, observed_at=observed.isoformat(),
                  submitted_at=submitted.isoformat() if submitted else None)
    if row["provider"] == "globus":
        result["chapter"] = row["chapter"]
    if row.get("due_at"):
        result["due_at"] = timestamp(row["due_at"]).isoformat()
    if row.get("source_assignment_id"):
        result["source_assignment_id"] = str(row["source_assignment_id"])
    return result


def day(value):
    return timestamp(value).astimezone(TZ).date()


def match_deadlines(obs, rows, progress):
    if obs["provider"] != "globus" and not obs.get("due_at") and not obs.get("source_assignment_id"):
        return [], "source_due_or_assignment_reference_required"
    pool = [r for r in rows if r.get("course_code") == obs["course_code"]
            and r.get("term_id") == obs["term_id"] and r.get("assignment_id") and r.get("when_iso")]
    if obs.get("source_assignment_id"):
        pool = [r for r in pool if obs["source_assignment_id"] in [r["assignment_id"], *r.get("assignment_refs", [])]]
    elif obs["provider"] == "globus":
        pool = [r for r in pool if chapter_identity(r.get("title")) == (obs["chapter"], obs["kind"])]
    else:
        pool = [r for r in pool if normalized_title(r.get("title")) == normalized_title(obs["title"])]
    if obs.get("due_at"):
        pool = [r for r in pool if day(r["when_iso"]) == day(obs["due_at"])]
    pool = list({r["assignment_id"]: r for r in pool}.values())
    if not pool:
        return [], "no_current_assignment_match"
    if len({day(r["when_iso"]) for r in pool}) > 1:
        return [], "ambiguous_due_occurrence"
    # One occurrence per feed may be a mirror; two identities within a feed
    # are ambiguous. Each mirror keeps its own exact identity and save receipt.
    sources = [r.get("source_namespace") for r in pool]
    if len(sources) != len(set(sources)):
        return [], "ambiguous_assignment"
    current_ids = {r["assignment_id"] for r in pool}
    if not obs.get("due_at") and not obs.get("source_assignment_id"):
        for prior in progress:
            same_title = (chapter_identity(prior.get("item")) == (obs.get("chapter"), obs["kind"])) if obs["provider"] == "globus" else normalized_title(prior.get("item")) == normalized_title(obs["title"])
            if same_title and prior.get("assignment_id") and prior["assignment_id"] not in current_ids:
                return [], "reused_title_needs_reference"
    return pool, None


def read_config():
    values = {}
    try:
        for line in CONFIG.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        return None
    return values if values.get("WORKER_URL") and values.get("API_KEY") else None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def transport(config):
    base = urlparse(config["WORKER_URL"])
    if base.scheme != "https" or base.netloc not in {"ijuh2yp6rf.example-subdomain.workers.dev", "coursework.example-subdomain.workers.dev"} or base.username or base.password or base.query or base.fragment:
        raise ValueError("bridge_destination")
    def request(method, path, payload=None, operation_id=None):
        headers = {"Authorization": "Bearer " + config["API_KEY"], "Content-Type": "application/json",
                   "User-Agent": "school-submission-reconciliation/1.0", "X-Bridge-Client": "collector"}
        if operation_id:
            headers["Idempotency-Key"] = operation_id
        req = urllib.request.Request(config["WORKER_URL"].rstrip("/") + path,
            data=json.dumps(payload).encode() if payload is not None else None, method=method, headers=headers)
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=30) as response:
            raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise ValueError("oversized")
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError("response")
            return data
    return request


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=".submission-")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(state, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def linked_record(progress, deadline):
    refs = {deadline["assignment_id"], *deadline.get("assignment_refs", [])}
    return next((r for r in progress if r.get("identity_resolution") == "linked"
                 and r.get("term_id") == TERM and refs.intersection({r.get("assignment_id"), *r.get("assignment_refs", [])})), None)


def packet(obs, deadline, prior):
    provider = {"elc": "eLC", "globus": "GLO-BUS", "gradescope": "Gradescope"}[obs["provider"]]
    proof = f"{provider} {obs['status']} receipt {obs['provider_item_id']}; checked {obs['observed_at']}"
    body = {"course": obs["course_code"], "item": deadline["title"], "status": "done",
            "assignment_id": deadline["assignment_id"], "when_iso": deadline["when_iso"], "term_id": TERM,
            "expected_revision": prior.get("revision", 0) if prior else 0,
            "verification": "verified", "reported_by": "codex_source_reconciliation", "evidence": proof[:200],
            "note": f"Codex assisted with automatic status reconciliation. Original {provider} source explicitly shows this requirement {obs['status']}; source checked {obs['observed_at']}. Codex recorded the source receipt and did not do the coursework. Source: {obs['source_url']}"[:500]}
    if prior:
        body["record_id"] = prior["record_id"]
    fingerprint = json.dumps({"body": body, "provider_item_id": obs["provider_item_id"]}, sort_keys=True)
    operation = "submission-" + hashlib.sha256(fingerprint.encode()).hexdigest()[:48]
    return {"body": body, "operation_id": operation}


def receipt_matches(result, body, operation_id):
    row = result.get("recorded", {})
    return (result.get("ok") is True and result.get("operation_id") == operation_id
            and result.get("revision") == row.get("revision") and row.get("record_id")
            and type(row.get("revision")) is int and row["revision"] > 0
            and row.get("assignment_id") == body["assignment_id"] and row.get("term_id") == TERM
            and row.get("course") == body["course"] and row.get("item") == body["item"]
            and timestamp(row.get("when_iso") or row.get("reference", {}).get("when_iso")) == timestamp(body["when_iso"])
            and row.get("status") == "done" and row.get("verification") == "verified"
            and row.get("evidence") == body["evidence"] and row.get("identity_resolution") == "linked")


def confirmed(result, body, operation_id, progress):
    if not receipt_matches(result, body, operation_id):
        return False
    row = result["recorded"]
    current = next((r for r in progress if r.get("record_id") == row["record_id"]), {})
    return (timestamp(current.get("when_iso") or current.get("reference", {}).get("when_iso")) == timestamp(body["when_iso"])
            and all(current.get(key) == row.get(key) for key in
               ("record_id", "revision", "assignment_id", "term_id", "course", "item", "status", "verification", "evidence", "identity_resolution", "reference")))


def superseded_verified(result, body, operation_id, progress):
    """A valid replay receipt can be superseded by stronger verified evidence.

    The old operation has committed, so CAS cannot advance it. Preserve the newer
    exact record and retire the retry without rewriting its evidence or revision.
    """
    if not receipt_matches(result, body, operation_id):
        return None
    row = result["recorded"]
    current = next((r for r in progress if r.get("record_id") == row["record_id"]), {})
    evidence = current.get("evidence")
    if (type(current.get("revision")) is int and current["revision"] > row["revision"]
            and all(current.get(key) == body[key] for key in ("assignment_id", "term_id", "course", "item"))
            and current.get("status") == "done" and current.get("verification") == "verified"
            and current.get("identity_resolution") == "linked"
            and isinstance(evidence, str) and evidence.strip()
            and timestamp(current.get("when_iso") or current.get("reference", {}).get("when_iso")) == timestamp(body["when_iso"])):
        return current
    return None


def reconcile(observations, *, log=None, dry=False, config=None, state_path=None, request=None):
    summary = {"saved": 0, "already_verified": 0, "pending": 0, "unmatched": 0, "invalid": 0, "reasons": []}
    path = Path(state_path or STATE)
    normalized = []
    for row in observations:
        try:
            normalized.append(normalize_observation(row))
        except (ValueError, TypeError, KeyError):
            summary["invalid"] += 1
    config = config or read_config()
    if request is None:
        if not config:
            summary.update(pending=len(normalized), reasons=["bridge_configuration"])
            return summary
        request = transport(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Serialize the two existing collectors without sharing credentials or
    # permitting either process to overwrite an uncertain operation packet.
    lock_path = path.with_suffix(".lock")
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600) if not dry else None
    try:
        if fd is not None:
            fcntl.flock(fd, fcntl.LOCK_EX)
        if path.exists() and path.stat().st_size > MAX_BYTES:
            raise ValueError("state_oversized")
        state = json.loads(path.read_text()) if path.exists() else {"pending": {}, "receipts": {}}
        if not isinstance(state, dict) or not isinstance(state.get("pending"), dict):
            raise ValueError("state")
        state.setdefault("receipts", {})
        if path.exists() and not dry:
            os.chmod(path, 0o600)
        def flush():
            if not dry:
                save_state(path, state)
        def attempt(entry):
            body, op = entry["body"], entry["operation_id"]
            try:
                result = request("POST", "/progress", body, op)
                progress = request("GET", "/progress?" + urlencode({"course": body["course"]})).get("progress", [])
                if not confirmed(result, body, op, progress):
                    newer = superseded_verified(result, body, op, progress)
                    if newer is None:
                        return "save_not_confirmed"
                    state["pending"].pop(op, None)
                    state["receipts"][op] = {"record_id": result["recorded"]["record_id"], "revision": result["revision"],
                                             "assignment_id": body["assignment_id"], "superseded_revision": newer["revision"]}
                    summary["already_verified"] += 1
                    flush()
                    return None
                state["pending"].pop(op, None)
                state["receipts"][op] = {"record_id": result["recorded"]["record_id"], "revision": result["revision"], "assignment_id": body["assignment_id"]}
                summary["saved"] += 1
                flush()
                return None
            except urllib.error.HTTPError as error:
                if error.code == 409:
                    try:
                        detail = json.loads(error.read(MAX_BYTES)).get("error")
                    except (ValueError, OSError):
                        detail = None
                    if detail == "revision_conflict":
                        return "revision_conflict"
                return "bridge_rejected"
            except Exception:
                return "save_not_confirmed"
        def rebase(entry):
            body, old_op = entry["body"], entry["operation_id"]
            try:
                status = request("GET", "/status?" + urlencode({"course": body["course"]}))
                if status.get("error") or status.get("response_completeness", {}).get("complete") is False:
                    return "source_or_bridge_unavailable"
                rows = [r for key in ("overdue", "due_today", "due_this_week", "upcoming") for r in status.get(key, [])]
                deadline = next((r for r in rows if r.get("assignment_id") == body["assignment_id"]
                                 and r.get("course_code") == body["course"] and r.get("term_id") == body["term_id"]
                                 and timestamp(r["when_iso"]) == timestamp(body["when_iso"])), None)
                if not deadline:
                    return "assignment_not_current"
                progress = request("GET", "/progress?" + urlencode({"course": body["course"]})).get("progress", [])
                prior = linked_record(progress, deadline)
                if prior and prior.get("status") == "done" and prior.get("verification") == "verified":
                    state["pending"].pop(old_op, None)
                    summary["already_verified"] += 1
                    flush()
                    return None
                body = dict(body)
                body.pop("record_id", None)
                body["expected_revision"] = prior.get("revision", 0) if prior else 0
                if prior:
                    body["record_id"] = prior["record_id"]
                op = "submission-rebase-" + hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:48]
                if op == old_op:
                    return "revision_conflict"
                replacement = {"body": body, "operation_id": op}
                state["pending"].pop(old_op, None)
                state["pending"][op] = replacement
                flush()
                return attempt(replacement)
            except Exception:
                return "source_or_bridge_unavailable"
        for entry in list(state["pending"].values()):
            if not dry:
                reason = attempt(entry)
                if reason == "revision_conflict":
                    reason = rebase(entry)
                if reason:
                    summary["reasons"].append(reason)
        cache = {}
        for obs in normalized:
            course = obs["course_code"]
            try:
                if course not in cache:
                    status = request("GET", "/status?" + urlencode({"course": course}))
                    if status.get("error") or status.get("response_completeness", {}).get("complete") is False:
                        raise ValueError("status_incomplete")
                    rows = [r for key in ("overdue", "due_today", "due_this_week", "upcoming") for r in status.get(key, [])]
                    progress = request("GET", "/progress?" + urlencode({"course": course})).get("progress")
                    if not isinstance(progress, list):
                        raise ValueError("progress")
                    cache[course] = (rows, progress)
                rows, progress = cache[course]
                matches, reason = match_deadlines(obs, rows, progress)
                if reason:
                    summary["unmatched"] += 1
                    summary["reasons"].append(reason)
                    continue
                for deadline in matches:
                    prior = linked_record(progress, deadline)
                    if prior and prior.get("status") == "done" and prior.get("verification") == "verified":
                        summary["already_verified"] += 1
                        continue
                    entry = packet(obs, deadline, prior)
                    op = entry["operation_id"]
                    # An unknown save for this exact assignment must replay its
                    # original packet, never mutate it under the same key.
                    if any(e["body"]["assignment_id"] == deadline["assignment_id"] for e in state["pending"].values()):
                        continue
                    if dry:
                        continue
                    state["pending"][op] = entry
                    flush()
                    reason = attempt(entry)
                    if reason == "revision_conflict":
                        reason = rebase(entry)
                    if reason:
                        summary["reasons"].append(reason)
                    else:
                        progress = request("GET", "/progress?" + urlencode({"course": course})).get("progress", [])
                        cache[course] = (rows, progress)
            except Exception:
                summary["reasons"].append("source_or_bridge_unavailable")
                summary["unmatched"] += 1
        summary["pending"] = len(state["pending"])
        summary["reasons"] = sorted(set(summary["reasons"]))
        if log and (summary["saved"] or summary["pending"] or summary["invalid"] or summary["unmatched"]):
            log("Submission reconciliation: " + json.dumps(summary, sort_keys=True))
        return summary
    finally:
        if fd is not None:
            os.close(fd)
