#!/usr/bin/env python3
"""Durable, bounded delivery of already collected eLC material.

A downloaded original is not a successful extraction or a readable Bridge
source. This ledger keeps those facts separate, including after a process dies
between an external write and its local acknowledgement. Adapters own I/O and
must be idempotent for operation_id; this module has no browser/network access.
The existing GPT publication queue owns publication. gpt_queue here only proves
that an exact extraction was durably handed to that queue.
"""
import copy
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
import zipfile

STAGES = ("extraction", "drive", "gpt_queue", "library")
RETRY_BASE = 300
RETRY_MAX = 6 * 3600
COURSE_RE = re.compile(r"^[A-Z]{2,10}[0-9]{3,6}[A-Z]?$")
ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,160}$")
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
VIDEO_EXTENSIONS = (".mp4", ".mov", ".m4v", ".avi", ".mkv")
MAX_VIDEO_MEMBER_BYTES = 4 * 1024 ** 3
QUALITY_FAILURE_REASONS = frozenset(("transcript_empty", "transcript_low_content",
    "transcript_repetitive", "transcript_silent_audio"))
SAFE_FAILURE_REASONS = frozenset((
    "extraction_unavailable", "source_template", "transcription_deferred",
    "unsafe_archive", "multiple_video_members", "video_missing", "source_changed", "source_content_mismatch",
    "drive_unconfirmed", "unsupported_video", "local_text_size", "local_text_changed",
    "local_text_unavailable", "connection_or_configuration", "response_size",
    "response_shape", "publication_unconfirmed", "readback_unconfirmed",
    "receipt_identity_pending", "drive_identity_pending", "document_identity_pending",
    "document_readback_pending", "http_400", "http_401", "http_403", "http_409",
    "http_413", "http_429", "http_500", "http_502", "http_503", "http_504")) | QUALITY_FAILURE_REASONS


def _safe_reason(receipt, fallback):
    reason = receipt.get("reason") if isinstance(receipt, dict) else None
    return reason if isinstance(reason, str) and reason in SAFE_FAILURE_REASONS else fallback


def _archive_video_sha256(raw_path, member):
    """Bind a filed video to the single safe video inside retained source bytes."""
    if not isinstance(member, str) or not member or len(member) > 2000:
        raise ValueError("invalid_archive_member")
    with zipfile.ZipFile(raw_path) as archive:
        infos = archive.infolist()
        if len(infos) > 1000:
            raise ValueError("unsafe_archive")
        videos = [info for info in infos if not info.is_dir()
                  and not info.filename.startswith("__MACOSX/")
                  and Path(info.filename).suffix.lower() in VIDEO_EXTENSIONS]
        if len(videos) != 1 or videos[0].filename != member:
            raise ValueError("archive_member_unconfirmed")
        info = videos[0]
        path = Path(member)
        if (path.is_absolute() or ".." in path.parts or "\\" in member
                or any(ord(c) < 32 for c in member) or info.flag_bits & 1
                or (info.external_attr >> 16) & 0o170000 == 0o120000
                or info.file_size <= 0 or info.file_size > MAX_VIDEO_MEMBER_BYTES
                or info.file_size / max(1, info.compress_size) > 200):
            raise ValueError("unsafe_archive")
        digest, size = hashlib.sha256(), 0
        with archive.open(info) as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                size += len(chunk)
                if size > info.file_size or size > MAX_VIDEO_MEMBER_BYTES:
                    raise ValueError("unsafe_archive")
                digest.update(chunk)
        if size != info.file_size:
            raise ValueError("unsafe_archive")
        return digest.hexdigest()


class DeliveryStateError(RuntimeError):
    """A corrupt ledger must not silently become a new, empty queue."""


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False,
                                     separators=(",", ":")).encode()).hexdigest()


def _stage():
    return {"status": "pending", "attempts": 0, "next_attempt": 0,
            "reason": None}


class DeliveryQueue:
    def __init__(self, queue_path, root):
        self.path = Path(queue_path).absolute()
        self.root = Path(root).resolve()

    @contextmanager
    def _locked(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(self.path) + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
        try:
            os.fchmod(fd, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def _load(self):
        if not self.path.exists():
            return {"version": 1, "entries": {}}
        try:
            with self.path.open() as f:
                state = json.load(f)
            if state.get("version") != 1 or not isinstance(state.get("entries"), dict):
                raise ValueError()
            for key, record in state["entries"].items():
                if (key != record["course"] + ":" + record["topic_id"]
                        or not HASH_RE.fullmatch(record["source_sha256"])
                        or not HASH_RE.fullmatch(record["revision_id"])
                        or set(record["stages"]) != set(STAGES)
                        or any(s["status"] not in ("pending", "running", "done")
                               for s in record["stages"].values())):
                    raise ValueError()
                representation = record.get("drive_representation", "original")
                if representation not in ("original", "archive_video"):
                    raise ValueError()
                if representation == "archive_video" and (
                        not HASH_RE.fullmatch(record.get("drive_sha256", ""))
                        or not isinstance(record.get("archive_member"), str)
                        or not record["archive_member"]):
                    raise ValueError()
            return state
        except Exception:
            raise DeliveryStateError("invalid_delivery_state") from None

    def _save(self, state):
        # Flush both the file and directory: rename atomicity alone is insufficient
        # for a sudden restart while acknowledging a completed external write.
        fd, tmp = tempfile.mkstemp(prefix=self.path.name + ".", dir=self.path.parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(state, f, indent=2, ensure_ascii=False)
                f.write("\n")
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
            dirfd = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(dirfd)
            finally:
                os.close(dirfd)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def _path(self, course, value, kind):
        path = Path(value)
        if not path.is_absolute():
            path = self.root / course / kind / path
        path = path.resolve()
        allowed = (self.root / course / kind).resolve()
        if not path.is_relative_to(allowed) or path == allowed:
            raise ValueError("invalid_material_path")
        return path

    @staticmethod
    def _identity(course, topic_id):
        if not isinstance(course, str) or not COURSE_RE.fullmatch(course):
            raise ValueError("invalid_course")
        topic_id = str(topic_id)
        if not ID_RE.fullmatch(topic_id):
            raise ValueError("invalid_topic_id")
        return course + ":" + topic_id

    def _enqueue(self, state, course, topic_id, raw_path, title, unit, text_path, now):
        key = self._identity(course, topic_id)
        raw = self._path(course, raw_path, "raw")
        if not raw.is_file() or not raw.stat().st_size:
            raise ValueError("raw_missing_or_empty")
        title = str(title).strip()
        unit = str(unit or "").strip()
        if (not title or len(title) > 1000 or len(unit) > 1000
                or any(ord(c) < 32 for c in title + unit)):
            raise ValueError("invalid_material_metadata")
        source_hash = sha256_file(raw)
        revision = _hash([course, str(topic_id), source_hash, title, unit])
        previous = state["entries"].get(key)
        if previous and previous["revision_id"] == revision:
            # A second local copy with identical bytes does not reset failures or
            # acknowledged stages. Refresh its locator if the old copy vanished.
            previous["raw_path"] = str(raw)
            return copy.deepcopy(previous), False
        record = {"course": course, "topic_id": str(topic_id), "title": title,
                  "unit": unit, "raw_path": str(raw), "source_sha256": source_hash,
                  "revision_id": revision, "created_at": now, "updated_at": now,
                  "stages": {name: _stage() for name in STAGES}, "status": "pending"}
        if previous:
            history = previous.get("superseded", [])[-7:]
            history.append({"revision_id": previous["revision_id"],
                            "source_sha256": previous["source_sha256"],
                            "raw_path": previous["raw_path"],
                            "superseded_at": now})
            record["superseded"] = history
            for field in ("drive_rel", "text_path"):
                prior = previous.get(field) or previous.get("previous_" + field)
                if prior:
                    record["previous_" + field] = prior
        if text_path:
            path = self._path(course, text_path, "text")
            if path.is_file() and path.stat().st_size:
                record["text_path"] = str(path)
                record["text_sha256"] = sha256_file(path)
                record["stages"]["extraction"].update(status="done", verified_at=now)
        state["entries"][key] = record
        return copy.deepcopy(record), True

    def enqueue(self, course, topic_id, raw_path, title, unit="", text_path=None, now=None):
        now = time.time() if now is None else now
        with self._locked():
            state = self._load()
            record, _ = self._enqueue(state, course, topic_id, raw_path, title,
                                      unit, text_path, now)
            self._save(state)
            return record

    def seed_legacy(self, fetched, manifest, only_courses, limit=3, now=None):
        """Import at most limit explicit-course legacy facts, without remote I/O.

        Existing fetched records never proved Bridge publication. Readback in run
        decides whether publishing is needed; completed entries remain in the
        ledger, so subsequent sweeps advance through legacy items instead of
        repeatedly reseeding the same first batch. No all-course default exists.
        """
        if not only_courses:
            raise ValueError("legacy_course_scope_required")
        now = time.time() if now is None else now
        summary = {"seeded": 0, "skipped": 0, "invalid": 0}
        with self._locked():
            state = self._load()
            # Missing text represents a proven delivery gap; recover those
            # before doing bounded verification of legacy publication-unknowns.
            ordered = sorted(fetched.items(), key=lambda pair: bool(pair[1].get("text")))
            for topic_id, item in ordered:
                course = item.get("course")
                if course not in only_courses:
                    continue
                if summary["seeded"] >= max(0, limit):
                    break
                try:
                    key = self._identity(course, topic_id)
                    if key in state["entries"]:
                        summary["skipped"] += 1
                        continue
                    source = next((x for x in manifest.get("courses", {}).get(course, {}).get("items", [])
                                   if str(x.get("id")) == str(topic_id)), None)
                    # Removed or unrelated legacy items are not an authorization
                    # to republish an old semester's materials.
                    if source is None or not item.get("raw"):
                        summary["skipped"] += 1
                        continue
                    self._enqueue(state, course, topic_id, item["raw"],
                                  source.get("title") or item.get("title"),
                                  source.get("unit", ""), item.get("text"), now)
                    rel = item.get("drive_rel")
                    if (isinstance(rel, str) and rel and len(rel) <= 2000
                            and not Path(rel).is_absolute() and ".." not in Path(rel).parts
                            and "://" not in rel and not any(ord(c) < 32 for c in rel)):
                        state["entries"][key]["previous_drive_rel"] = rel
                    summary["seeded"] += 1
                except (ValueError, OSError, TypeError):
                    summary["invalid"] += 1
            if summary["seeded"]:
                self._save(state)
        return summary

    def request_retry(self, course, topic_id, expected_revision_id, now=None):
        """Make pending stages eligible after an explicit operator retry request.

        This does not acknowledge delivery, reopen completed stages, replace an
        operation identity, or erase failure/attempt history. A changed revision
        and a running stage are left untouched. Normal scheduled backoff remains.
        """
        key = self._identity(course, topic_id)
        now = time.time() if now is None else now
        with self._locked():
            state = self._load()
            record = state["entries"].get(key)
            if not record or record["revision_id"] != expected_revision_id:
                return False
            changed = False
            for stage in record["stages"].values():
                if stage["status"] == "pending" and stage["next_attempt"] > now:
                    stage["next_attempt"] = now
                    changed = True
            if changed:
                self._save(state)
            return changed

    def invalidate_text(self, course, topic_id, expected_revision_id, now=None):
        """Reopen a lost/changed extraction only for an exact current revision.

        The GPT queue can still owe publication after this ledger acknowledged
        its handoff. Its owner calls this for bounded pending queue references;
        a missing local file must not remain stuck behind a completed handoff.
        Healthy bytes and a newer source revision are never reset by stale work.
        """
        key = self._identity(course, topic_id)
        now = time.time() if now is None else now
        with self._locked():
            state = self._load()
            record = state["entries"].get(key)
            if not record or record["revision_id"] != expected_revision_id:
                return False
            if record["stages"]["extraction"]["status"] != "done":
                return False
            try:
                path = self._path(course, record["text_path"], "text")
                if path.is_file() and sha256_file(path) == record["text_sha256"]:
                    return False
            except (OSError, ValueError, KeyError):
                pass
            for name in ("extraction", "gpt_queue", "library"):
                record["stages"][name] = _stage()
            record.pop("text_path", None)
            record.pop("text_sha256", None)
            record.update(status="pending", updated_at=now)
            self._save(state)
            return True

    def invalidate_quality(self, course, topic_id, expected_revision_id,
                           expected_text_sha256, reason, now=None):
        """Reopen exact stored bytes rejected by the caller's transcript gate.

        Preserve the source and Drive proof. Keep text identity until extraction
        replaces it so a restart can still quarantine the rejected local bytes.
        A stale quality observation cannot invalidate a corrected extraction.
        """
        if reason not in QUALITY_FAILURE_REASONS:
            raise ValueError("invalid_quality_reason")
        key = self._identity(course, topic_id)
        now = time.time() if now is None else now
        with self._locked():
            state = self._load()
            record = state["entries"].get(key)
            if (not record or record["revision_id"] != expected_revision_id
                    or record.get("text_sha256") != expected_text_sha256
                    or record["stages"]["extraction"]["status"] != "done"):
                return False
            try:
                path = self._path(course, record["text_path"], "text")
                if sha256_file(path) != expected_text_sha256:
                    return False
            except (OSError, ValueError, KeyError):
                return False
            for name in ("extraction", "gpt_queue", "library"):
                record["stages"][name] = _stage()
            record["stages"]["extraction"]["reason"] = reason
            record["quality_invalidated"] = {"text_path": str(path),
                "text_sha256": expected_text_sha256, "reason": reason, "at": now}
            record.update(status="pending", updated_at=now)
            self._save(state)
            return True

    def entries(self, read_only=False):
        if read_only:
            # Atomic replacement gives an intact snapshot without creating the
            # lock file, including during collector --dry-run.
            return copy.deepcopy(self._load()["entries"])
        with self._locked():
            return copy.deepcopy(self._load()["entries"])

    @staticmethod
    def _summary(state, only_courses=None):
        entries = [e for e in state["entries"].values()
                   if only_courses is None or e["course"] in only_courses]
        return {"records": len(entries),
                "complete": sum(e["status"] == "complete" for e in entries),
                "pending": sum(e["status"] != "complete" for e in entries),
                "stages_pending": {name: sum(e["stages"][name]["status"] != "done"
                                             for e in entries) for name in STAGES}}

    def summary(self, only_courses=None, read_only=False):
        if read_only:
            return self._summary(self._load(), only_courses)
        with self._locked():
            return self._summary(self._load(), only_courses)

    def run(self, *, extract, file_drive, queue_gpt, publish, readback,
            only_courses=None, max_records=6, max_operations=24, now=None,
            stages=None):
        """Retry eligible stages with strict, content-bound receipts.

        extract -> {ok: True, text_path}; file_drive -> {ok: True, drive_rel,
        source_sha256}; archive_video additionally requires drive_sha256 and the
        independently verified archive_member. queue_gpt -> {ok: True}; publish/readback -> {ok: True,
        text_sha256}. An absent/mismatched readback must explicitly use reason
        not_found/hash_mismatch; other failures do not authorize a write.
        An explicit stages allowlist retries only those stages; omitted stages
        retain their receipts, attempts and pending status. This separates local
        extraction/queueing from destination access without fabricating delivery.
        All other exception details and adapter outputs are discarded, preventing
        credential-bearing provider errors from entering a durable queue/report.
        """
        enabled = set(STAGES if stages is None else stages)
        if not enabled or not enabled <= set(STAGES):
            raise ValueError("invalid_delivery_stages")
        now = time.time() if now is None else now
        operations, selected = 0, 0
        adapters = {"extraction": extract, "drive": file_drive, "gpt_queue": queue_gpt}
        with self._locked():
            state = self._load()
            # A crash can occur after the final stage receipt but before the
            # redundant aggregate status write. Stage receipts own the truth.
            repaired = False
            for record in state["entries"].values():
                status = "complete" if all(s["status"] == "done" for s in record["stages"].values()) else "pending"
                if record["status"] != status:
                    record["status"] = status
                    repaired = True
            if repaired:
                self._save(state)

            def invoke(callback, record, stage):
                nonlocal operations
                if operations >= max(0, max_operations):
                    return None
                operations += 1
                packet = copy.deepcopy(record)
                packet["operation_id"] = _hash([record["revision_id"], stage,
                                                 record.get("text_sha256") if stage in ("library", "gpt_queue") else None])
                try:
                    response = callback(packet)
                    return response if isinstance(response, dict) else {"ok": False}
                except Exception:
                    return {"ok": False}

            def fail(record, name, reason):
                stage = record["stages"][name]
                stage.update(status="pending", reason=reason,
                             next_attempt=now + min(RETRY_MAX,
                                                    RETRY_BASE * 2 ** min(10, max(0, stage["attempts"] - 1))))
                record["updated_at"] = now
                self._save(state)

            # Oldest unfinished work first; backoff lets later work progress.
            ordered = sorted(state["entries"].values(), key=lambda e: (e["updated_at"], e["course"], e["topic_id"]))
            for record in ordered:
                if selected >= max(0, max_records) or operations >= max(0, max_operations):
                    break
                if (record["status"] == "complete"
                        or (only_courses is not None and record["course"] not in only_courses)):
                    continue
                if not any(s["status"] != "done" and s["next_attempt"] <= now
                           for name, s in record["stages"].items() if name in enabled):
                    continue
                selected += 1
                try:
                    raw = self._path(record["course"], record["raw_path"], "raw")
                    if sha256_file(raw) != record["source_sha256"]:
                        raise ValueError()
                except (OSError, ValueError):
                    for name in STAGES:
                        if name in enabled and record["stages"][name]["status"] != "done":
                            fail(record, name, "raw_unavailable_or_changed")
                    continue
                if record["stages"]["extraction"]["status"] == "done":
                    try:
                        text = self._path(record["course"], record["text_path"], "text")
                        if sha256_file(text) != record["text_sha256"]:
                            raise ValueError()
                    except (OSError, ValueError, KeyError):
                        # A replaced local extraction must not publish stale hash
                        # receipts or piggyback on a previous GPT acknowledgement.
                        for name in ("extraction", "gpt_queue", "library"):
                            record["stages"][name] = _stage()
                        record.pop("text_path", None)
                        record.pop("text_sha256", None)
                        self._save(state)
                for name in STAGES:
                    stage = record["stages"][name]
                    if (name not in enabled or operations >= max(0, max_operations) or stage["status"] == "done"
                            or stage["next_attempt"] > now):
                        continue
                    if name in ("gpt_queue", "library") and record["stages"]["extraction"]["status"] != "done":
                        continue
                    if name == "library" and record["stages"]["drive"]["status"] != "done":
                        continue
                    stage.update(status="running", attempts=stage["attempts"] + 1,
                                 reason=None, operation_id=_hash([record["revision_id"], name,
                                    record.get("text_sha256") if name in ("library", "gpt_queue") else None]))
                    record["updated_at"] = now
                    self._save(state)  # intent precedes every external effect
                    if name == "library":
                        receipt = invoke(readback, record, name)
                        valid = bool(receipt and receipt.get("ok") is True
                                     and receipt.get("text_sha256") == record["text_sha256"])
                        missing = bool(receipt and (receipt.get("reason") in ("not_found", "hash_mismatch")
                                                    or receipt.get("ok") is True and not valid))
                        if not valid and missing and not stage.get("published"):
                            result = invoke(publish, record, name)
                            if result is None:
                                fail(record, name, "operation_budget")
                                continue
                            if result.get("ok") is not True or result.get("text_sha256") != record["text_sha256"]:
                                fail(record, name, _safe_reason(result, "publish_unconfirmed"))
                                continue
                            stage.update(published=True, published_at=now)
                            self._save(state)
                            receipt = invoke(readback, record, name)
                            valid = bool(receipt and receipt.get("ok") is True
                                         and receipt.get("text_sha256") == record["text_sha256"])
                        if not valid:
                            fail(record, name, _safe_reason(receipt, "readback_pending" if stage.get("published") else "readback_unavailable"))
                            continue
                    else:
                        receipt = invoke(adapters[name], record, name)
                        if not receipt or receipt.get("ok") is not True:
                            fail(record, name, _safe_reason(receipt, name + "_unconfirmed"))
                            continue
                        try:
                            if name == "extraction":
                                path = self._path(record["course"], receipt.get("text_path", ""), "text")
                                if not path.is_file() or not path.stat().st_size:
                                    raise ValueError()
                                record["text_path"] = str(path)
                                record["text_sha256"] = sha256_file(path)
                            elif name == "drive":
                                rel = receipt.get("drive_rel")
                                if (not isinstance(rel, str) or not rel or len(rel) > 2000
                                        or Path(rel).is_absolute() or ".." in Path(rel).parts
                                        or "://" in rel or any(ord(c) < 32 for c in rel)
                                        or receipt.get("source_sha256") != record["source_sha256"]):
                                    raise ValueError()
                                representation = receipt.get("drive_representation", "original")
                                drive_hash = receipt.get("drive_sha256", record["source_sha256"])
                                if not isinstance(drive_hash, str) or not HASH_RE.fullmatch(drive_hash):
                                    raise ValueError()
                                if representation == "archive_video":
                                    member = receipt.get("archive_member")
                                    if _archive_video_sha256(record["raw_path"], member) != drive_hash:
                                        raise ValueError()
                                    if sha256_file(record["raw_path"]) != record["source_sha256"]:
                                        raise ValueError()
                                    record["archive_member"] = member
                                elif representation != "original" or drive_hash != record["source_sha256"]:
                                    raise ValueError()
                                record["drive_rel"] = rel
                                record["drive_sha256"] = drive_hash
                                record["drive_representation"] = representation
                        except (OSError, ValueError, TypeError, zipfile.BadZipFile, RuntimeError):
                            fail(record, name, name + "_receipt_invalid")
                            continue
                    stage.update(status="done", reason=None, next_attempt=0, verified_at=now)
                    self._save(state)
                record["status"] = "complete" if all(s["status"] == "done" for s in record["stages"].values()) else "pending"
                self._save(state)
            result = self._summary(state, only_courses)
            result.update(selected=selected, operations=operations)
            return result
