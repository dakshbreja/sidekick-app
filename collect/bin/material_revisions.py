"""Plan bounded rechecks of eLC material, without treating a topic ID as a version.

D2L's ToC.Topic contract has a nullable LastModifiedDate and Url, but does not
promise a file checksum (https://docs.valence.desire2learn.com/res/content.html).
Metadata changes therefore prompt a read; periodically reading older documents
also catches an instructor replacing bytes while keeping the topic unchanged.

These helpers perform no network or state writes. The caller commits a returned
record to the existing topic-ID keyed .fetched.json only after the bytes and their
delivery work are durable. A listing, plan, failed download or dry run can never
advance checked_at. The legacy fields remain available to existing consumers.

The fallback budget is deliberately small. Large videos have a seven-day due
interval and remain explicitly deferred by default; a caller may opt into one
large check with a separate byte budget and a bounded download implementation.
Unchanged metadata is not a claim that those deferred bytes were checked.
"""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import time
from urllib.parse import urlsplit
import zipfile

DAY = 24 * 60 * 60
MIB = 1024 * 1024
MEDIA_EXTENSIONS = {"mp4", "mov", "m4v", "webm", "mkv", "mp3", "wav", "m4a"}


def _epoch(value):
    if isinstance(value, (float, int)) and not isinstance(value, bool):
        return float(value) if math.isfinite(value) and value >= 0 else 0.0
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is not None:
                return max(0.0, parsed.timestamp())
        except ValueError:
            pass
    return 0.0


def _now(value):
    return time.time() if value is None else _epoch(value)


def _iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def _course(value):
    value = re.sub(r"\s+", "", str(value or "").upper())
    return re.sub(r"(?<=\d)E$", "", value)


def _scalar(item, *names):
    for name in names:
        value = item.get(name)
        if isinstance(value, (str, int, float)) and not isinstance(value, bool):
            if str(value).strip():
                return str(value).strip()[:1000]
    return None


def source_path(value):
    """Persist only a URL path, never query strings, fragments or credentials."""
    if not isinstance(value, str):
        return None
    try:
        parsed = urlsplit(value.strip())
    except ValueError:
        return None
    if parsed.scheme not in ("", "http", "https"):
        return None
    return parsed.path[:2000] or None


def metadata(item):
    """Allowlist source identity/version hints; omit learner and grade fields."""
    return {
        "title": _scalar(item, "title", "Title"),
        "type": _scalar(item, "type", "TypeIdentifier"),
        "ext": (_scalar(item, "ext") or "").lower().lstrip("."),
        "unit": _scalar(item, "unit"),
        "url_path": source_path(_scalar(item, "url", "Url", "url_path")),
        "last_modified": _scalar(item, "last_modified", "LastModifiedDate"),
        # Only consume these if a source actually supplied them. They are not
        # required by the D2L ToC contract and must never be fabricated.
        "version": _scalar(item, "version", "Version"),
        "etag": _scalar(item, "etag", "ETag"),
        "http_last_modified": _scalar(item, "http_last_modified"),
    }


def metadata_fingerprint(item):
    return hashlib.sha256(json.dumps(metadata(item), sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def content_digest(path):
    """Hash source bytes, ignoring regenerated ZIP timestamps/compression.

    D2L may wrap an unchanged document in a newly created ZIP. Comparing archive
    bytes would publish a new revision every day. Members are streamed without
    extracting paths; names and payload digests determine the semantic checksum.
    Corrupt/encrypted ZIP members raise rather than falsely confirm freshness.
    """
    path = Path(path)
    if zipfile.is_zipfile(path):
        members = []
        with zipfile.ZipFile(path) as archive:
            for member in archive.infolist():
                if member.is_dir():
                    continue
                digest = hashlib.sha256()
                with archive.open(member) as source:
                    for chunk in iter(lambda: source.read(MIB), b""):
                        digest.update(chunk)
                members.append([member.filename, member.file_size, digest.hexdigest()])
        payload = json.dumps(sorted(members), separators=(",", ":")).encode()
        return hashlib.sha256(b"zip-content-v1\0" + payload).hexdigest()
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(MIB), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _revision(previous):
    value = (previous or {}).get("revisions", {})
    return value if isinstance(value, dict) else {}


def _same_scope(previous, course, org_unit, term_id):
    revision = _revision(previous)
    values = ((previous or {}).get("course"), revision.get("course"))
    if any(value and _course(value) != _course(course) for value in values):
        return False
    return all(not revision.get(key) or str(revision[key]) == str(value)
               for key, value in (("org_unit", org_unit), ("term_id", term_id)))


def _size(item, previous):
    for value in (item.get("size_bytes"), item.get("Size"),
                  _revision(previous).get("size_bytes"), (previous or {}).get("size_bytes")):
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return value
    ext = metadata(item)["ext"]
    return 256 * MIB if ext in MEDIA_EXTENSIONS else 8 * MIB


def check_reason(item, previous, course, org_unit, term_id, now=None,
                 recheck_seconds=DAY, large_recheck_seconds=7 * DAY):
    """Return why actual bytes are needed, or None for a not-yet-due check."""
    now = _now(now)
    revision = _revision(previous)
    if previous is None:
        return "new"
    if not _same_scope(previous, course, org_unit, term_id):
        return "scope_changed"
    if not revision.get("sha256") or not revision.get("fingerprint"):
        # An imported old fetched ID is unknown, not proof the source changed.
        observed = revision.get("observed", {})
        if revision.get("pending_metadata_change"):
            return "metadata_changed"
        if (observed.get("fingerprint") and _course(observed.get("course")) == _course(course)
                and observed.get("org_unit") == str(org_unit) and observed.get("term_id") == str(term_id)
                and observed["fingerprint"] != metadata_fingerprint(item)):
            return "metadata_changed"
        return "new" if revision.get("initial_reason") == "new" else "migration_unverified"
    if revision["fingerprint"] != metadata_fingerprint(item):
        return "metadata_changed"
    large = metadata(item)["ext"] in MEDIA_EXTENSIONS or _size(item, previous) > 64 * MIB
    interval = large_recheck_seconds if large else recheck_seconds
    if now - _epoch(revision.get("checked_at_epoch")) >= interval:
        return "periodic_recheck"
    return None


def observe_inventory(inventory, fetched, courses, term_id, now=None):
    """Remember listing hints for existing entries, without claiming fresh bytes.

    Call select_candidates BEFORE this helper, then persist the returned copy.
    Large legacy files may not fit a periodic body budget. Keeping the first
    observed metadata separately allows their next same-ID edit to be detected
    without downloading the whole old video just to establish a baseline.
    New IDs are deliberately not inserted into the legacy fetched ledger.
    """
    if not str(term_id or "").strip():
        raise ValueError("current term_id is required")
    now = _now(now)
    result = deepcopy(fetched)
    for course, items in inventory.items():
        if course not in courses or not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict) or item.get("type") != "File":
                continue
            existing = result.get(str(item.get("id")))
            if not isinstance(existing, dict):
                continue
            revision = deepcopy(_revision(existing))
            old_observed = revision.get("observed", {})
            if (not revision.get("sha256") and old_observed.get("fingerprint")
                    and _course(old_observed.get("course")) == _course(course)
                    and old_observed.get("org_unit") == str(courses[course])
                    and old_observed.get("term_id") == str(term_id)
                    and old_observed["fingerprint"] != metadata_fingerprint(item)):
                # The observation must not acknowledge its own outstanding body
                # read. Keep it due through count budgets, failures and restarts.
                revision["pending_metadata_change"] = True
            revision["observed"] = {"course": course, "org_unit": str(courses[course]),
                                    "term_id": str(term_id), "observed_at": _iso(now),
                                    "metadata": metadata(item), "fingerprint": metadata_fingerprint(item)}
            existing["revisions"] = revision
    return result


def _fair_order(candidates):
    """Oldest eligible checks first; interleave courses with equal timestamps."""
    buckets = {}
    for candidate in candidates:
        buckets.setdefault(candidate["course"], []).append(candidate)
    for bucket in buckets.values():
        bucket.sort(key=lambda c: (c["last_check_or_attempt"], str(c["item"]["id"])))
    ordered = []
    while buckets:
        for course in sorted(buckets, key=lambda c: (buckets[c][0]["last_check_or_attempt"], c)):
            ordered.append(buckets[course].pop(0))
            if not buckets[course]:
                del buckets[course]
    return ordered


def select_candidates(inventory, fetched, courses, term_id, now=None, max_count=25,
                      max_rechecks=4, max_recheck_bytes=64 * MIB,
                      max_recheck_seconds=120, recheck_seconds=DAY,
                      large_recheck_seconds=7 * DAY, retry_seconds=3600,
                      max_large_rechecks=0, max_large_bytes=1024 * MIB):
    """Pure plan for current discovered course/org/term, including visible backlog.

    New/changed metadata has first priority under max_count. Migration and periodic
    checks also fit count, estimated bytes and estimated time budgets. The caller
    must enforce actual transfer size/time: planning cannot bound an unknown body.
    Deferred entries retain their original check reason and get deferred_reason;
    they are owed work, not a successful freshness observation.
    """
    if not str(term_id or "").strip():
        raise ValueError("current term_id is required")
    now = _now(now)
    urgent, fallback, deferred, unchanged = [], [], [], 0
    seen = set()
    for course in sorted(inventory):
        items = inventory[course]
        if course not in courses or not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict) or item.get("type") != "File" or item.get("id") is None:
                continue
            identity = (str(courses[course]), str(item["id"]))
            if identity in seen:
                continue
            seen.add(identity)
            previous = fetched.get(str(item["id"]))
            reason = check_reason(item, previous, course, courses[course], term_id, now,
                                  recheck_seconds, large_recheck_seconds)
            if reason is None:
                unchanged += 1
                continue
            revision = _revision(previous)
            size = _size(item, previous)
            candidate = {"course": course, "org_unit": str(courses[course]),
                         "term_id": str(term_id), "item": deepcopy(item), "reason": reason,
                         "estimated_bytes": size,
                         "estimated_seconds": max(5.0, size / (4 * MIB)),
                         "last_check_or_attempt": max(_epoch(revision.get("checked_at_epoch")),
                                                      _epoch(revision.get("last_attempt_at_epoch")))}
            if (_same_scope(previous, course, courses[course], term_id)
                    and revision.get("last_error")
                    and now < _epoch(revision.get("last_attempt_at_epoch")) + retry_seconds):
                deferred.append(dict(candidate, deferred_reason="retry_cooldown"))
            elif reason in ("new", "scope_changed", "metadata_changed"):
                urgent.append(candidate)
            else:
                fallback.append(candidate)
    selected, rechecks, used_bytes, seconds, large_count, large_bytes = [], 0, 0, 0.0, 0, 0
    for candidate in _fair_order(urgent) + _fair_order(fallback):
        reason = None
        if len(selected) >= max_count:
            reason = "run_count_budget"
        elif candidate["reason"] in ("migration_unverified", "periodic_recheck"):
            size = candidate["estimated_bytes"]
            large = metadata(candidate["item"])["ext"] in MEDIA_EXTENSIONS or size > 64 * MIB
            if large:
                if large_count >= max_large_rechecks or large_bytes + size > max_large_bytes:
                    reason = "large_recheck_deferred"
                else:
                    large_count += 1
                    large_bytes += size
            elif rechecks >= max_rechecks:
                reason = "recheck_count_budget"
            elif used_bytes + size > max_recheck_bytes:
                reason = "recheck_byte_budget"
            elif seconds + candidate["estimated_seconds"] > max_recheck_seconds:
                reason = "recheck_time_budget"
            else:
                rechecks += 1
                used_bytes += size
                seconds += candidate["estimated_seconds"]
        if reason:
            deferred.append(dict(candidate, deferred_reason=reason))
        else:
            selected.append(candidate)
    return {"selected": selected, "deferred": deferred, "unchanged": unchanged,
            "recheck_bytes_estimate": used_bytes, "recheck_seconds_estimate": seconds,
            "large_recheck_bytes_estimate": large_bytes}


def record_success(previous, item, course, org_unit, term_id, sha256, size_bytes,
                   raw, now=None):
    """Return a new fetched entry only after actual bytes and delivery are durable."""
    if not re.fullmatch(r"[0-9a-f]{64}", str(sha256)):
        raise ValueError("an actual SHA-256 content digest is required")
    if not isinstance(size_bytes, int) or isinstance(size_bytes, bool) or size_bytes < 0:
        raise ValueError("actual size_bytes is required")
    if not str(term_id or "").strip() or not str(org_unit or "").strip():
        raise ValueError("current term and org unit are required")
    now = _now(now)
    result = deepcopy(previous or {})
    old = _revision(result)
    history = deepcopy(old.get("history", []))
    same = old.get("sha256") == sha256 and _same_scope(previous, course, org_unit, term_id)
    if previous and not same:
        history.append({key: deepcopy(value) for key, value in {
            "course": old.get("course", previous.get("course")),
            "org_unit": old.get("org_unit"), "term_id": old.get("term_id"),
            "sha256": old.get("sha256"), "size_bytes": old.get("size_bytes"),
            "raw": old.get("raw", previous.get("raw")),
            "text": previous.get("text"), "title": previous.get("title"),
            "metadata": old.get("metadata"), "fingerprint": old.get("fingerprint"),
            "checked_at": old.get("checked_at"), "legacy_at": previous.get("at"),
            "verified": bool(old.get("sha256")),
        }.items() if value is not None})
    result.update({"course": course, "title": item.get("title", ""), "raw": str(raw),
                   "at": _iso(now)})
    result["revisions"] = {
        "schema_version": 1, "course": course, "org_unit": str(org_unit),
        "term_id": str(term_id), "metadata": metadata(item),
        "fingerprint": metadata_fingerprint(item), "sha256": sha256,
        "size_bytes": size_bytes, "raw": str(raw), "checked_at": _iso(now),
        "checked_at_epoch": now, "last_attempt_at_epoch": now,
        "last_error": None, "failures": 0,
        "generation": int(old.get("generation", 0)) + (0 if same else 1),
        "history": history,
    }
    return result


def record_failure(previous, item, course, org_unit, term_id, error, now=None,
                   reason=None):
    """Keep old successful bytes/check timestamp; only a failed attempt advances."""
    result = deepcopy(previous or {})
    revision = deepcopy(_revision(previous))
    now = _now(now)
    if not revision:
        revision = {"schema_version": 1, "course": course, "org_unit": str(org_unit),
                    "term_id": str(term_id), "initial_reason": reason or (
                        "new" if previous is None else "migration_unverified")}
    revision.update({"last_attempt_at_epoch": now, "last_error": str(error)[:300],
                     "failures": int(revision.get("failures", 0)) + 1})
    result["revisions"] = revision
    result.setdefault("course", course)
    result.setdefault("title", item.get("title", ""))
    return result
