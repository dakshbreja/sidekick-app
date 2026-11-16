#!/usr/bin/env python3
"""Apply queued GLO-BUS date changes to Google Calendar.

The watcher can detect that a deadline moved but not act on it: a launchd job has no
Google credentials. This closes that last gap, so a date that slips in the lobby ends
up corrected on the calendar without anybody noticing it needed doing.

Scope is deliberately `calendar.events` and not `calendar` — this never needs to
create, delete or share a calendar, only to edit events on one.

Two rules keep an automated writer from doing damage to a calendar it does not own:

  * It will only ever touch events whose title starts with TITLE_GUARD. Every event
    this system created carries that prefix, so a bug in the matcher cannot reach a
    lecture, a birthday or anything else he put there himself.
  * It never deletes. A deadline that disappears from GLO-BUS gets its event marked
    [CANCELLED], greyed out and freed from blocking time — visible, reversible, and
    obviously wrong if the removal itself was wrong. Deleting would be tidier and
    unrecoverable, which is the wrong trade for a script running unattended.

  --authorize   one-time browser consent; writes token.json
  --dry-run     show what would change, touch nothing
"""
import json
import hashlib
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from functools import partial
from zoneinfo import ZoneInfo

ROOT = os.path.expanduser("~/Claude/school-system-suite/collect")
GCAL = os.path.join(ROOT, ".gcal")
CLIENT_SECRET = os.path.join(GCAL, "client_secret.json")
TOKEN = os.path.join(GCAL, "token.json")
QUEUE = os.path.join(ROOT, ".globus-calendar-sync.json")

SCOPES = ["https://www.googleapis.com/auth/calendar.events"]
CALENDAR_ID = "owner@example.com"
TZ = "America/New_York"
TITLE_GUARD = "MGMT 5560 — GLO-BUS"
MAX_ATTEMPTS = 4
API_TIMEOUT = 30
API_RETRIES = 3

# Colour and reminder policy, mirroring how the events were originally created:
# only the unrecoverable things shout.
DECISION_COLOR, MILESTONE_COLOR, CHAPTER_COLOR, INFO_COLOR = "11", "10", "2", "8"


def log(msg):
    print(f"{datetime.now().isoformat(timespec='seconds')}  {msg}", flush=True)


def load_json(path, default):
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            pass
    return default


def save_json(path, obj):
    # A refresh interrupted by sleep or process termination must not replace the
    # only working grant with half a JSON document. The temporary file is private
    # from creation, including during the write, and concurrent readers see one
    # whole version of the queue/token.
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".calendar-")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


class NeedsReauth(RuntimeError):
    """The refresh token is dead and only a human at a browser can fix it.

    Google expires this events-scope grant after seven days while the external
    app is in Testing. Publishing removes that timer for a freshly authorized
    grant, but revocation still requires explicit consent; a failed refresh is
    never a reason for an unattended job to open an authorization page.
    """


def safe_error(exc):
    """Only operational categories leave the credential/API boundary.

    Google errors may contain the request URL, response body or token data. A
    bounded raw exception string still leaks those values into health and logs.
    """
    text = str(exc).lower()
    if isinstance(exc, NeedsReauth) or "invalid_grant" in text or "expired or revoked" in text:
        return "Google authorization expired or was revoked; run calendar_sync.py --authorize"
    if "invalid_client" in text or "unauthorized_client" in text:
        return "Google OAuth client configuration needs attention"
    status = getattr(getattr(exc, "resp", None), "status", None)
    if not status:
        status = getattr(getattr(exc, "response", None), "status_code", None)
    if status:
        return f"Google Calendar API returned HTTP {int(status)}"
    name = type(exc).__name__
    if "timeout" in name.lower():
        return "Google Calendar request timed out; retained for automatic retry"
    if name in ("ConnectionError", "TransportError", "ServerNotFoundError"):
        return "Google Calendar network request failed; retained for automatic retry"
    return f"Google Calendar request failed ({name})"


def configured():
    return os.path.isfile(CLIENT_SECRET) and os.path.isfile(TOKEN)


def validate_consent(creds):
    actual = getattr(creds, 'granted_scopes', None)
    if actual is None:
        actual = getattr(creds, 'scopes', None)
    if isinstance(actual, str):
        actual = actual.split()
    if not isinstance(actual, (list, tuple, set)) or set(actual) != set(SCOPES):
        raise NeedsReauth("Google consent did not grant exactly the requested Calendar events permission; existing authorization was preserved")


def notify(title, message):
    def esc(x):
        return x.replace("\\", "\\\\").replace('"', '\\"')
    try:
        subprocess.run(["osascript", "-e",
                        f'display notification "{esc(message)}" with title "{esc(title)}"'],
                       capture_output=True, timeout=15)
    except Exception:
        pass


def healthy():
    """Cheap liveness probe: can we still refresh and reach the API?

    Called by the watcher on every run so an expired token is discovered on a quiet
    Tuesday, not at the moment a deadline actually moves.
    """
    if not configured():
        return False, "not authorised yet"
    try:
        svc = service()
        svc.events().list(calendarId=CALENDAR_ID, maxResults=1,
                          fields="items(id)").execute(num_retries=API_RETRIES)
        return True, "ok"
    except NeedsReauth as e:
        return False, safe_error(e)
    except Exception as e:
        return False, safe_error(e)


def service(interactive=False):
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build
    from google_auth_httplib2 import AuthorizedHttp
    import httplib2

    def consent():
        if not os.path.isfile(CLIENT_SECRET):
            raise SystemExit(f"missing {CLIENT_SECRET} — see the setup notes")
        flow = InstalledAppFlow.from_client_secrets_file(CLIENT_SECRET, SCOPES)
        # GCAL_NO_BROWSER prints the consent URL instead of launching a browser,
        # so the approval can be driven in a known tab rather than whichever
        # window the OS decides to open.
        return flow.run_local_server(
            port=0, access_type="offline", prompt="consent",
            open_browser=not os.environ.get("GCAL_NO_BROWSER"))

    creds = None
    changed = False
    if interactive:
        # --authorize is deliberate recovery, especially after publishing a
        # Testing client. Reusing a still-valid old access token would silently
        # keep the old seven-day grant instead of issuing a permanent one.
        creds = consent()
        if not creds.refresh_token:
            raise NeedsReauth("Google did not issue an offline refresh grant")
        validate_consent(creds)
        changed = True
    elif os.path.isfile(TOKEN):
        try:
            creds = Credentials.from_authorized_user_file(TOKEN, SCOPES)
        except Exception:
            raise NeedsReauth("Stored Google authorization is unreadable; run --authorize") from None
    if not creds or not creds.valid:
        if creds and creds.refresh_token:
            try:
                creds.refresh(partial(Request(), timeout=API_TIMEOUT))
                changed = True
            except Exception as e:
                if "invalid_grant" not in str(e) and "expired or revoked" not in str(e):
                    raise RuntimeError(safe_error(e)) from None
                raise NeedsReauth(safe_error(e)) from None
        else:
            raise NeedsReauth("No usable Google credentials; run --authorize once")
    if changed:
        stored = json.loads(creds.to_json())
        stored['scopes'] = list(SCOPES)
        save_json(TOKEN, stored)
    return build("calendar", "v3", http=AuthorizedHttp(
        creds, http=httplib2.Http(timeout=API_TIMEOUT)), cache_discovery=False)


# ------------------------------------------------------------------ event shapes
def classify(title):
    t = title.lower()
    if "decision" in t:
        return DECISION_COLOR, [1440, 120]
    if "data reset" in t:
        return INFO_COLOR, []
    if any(k in t for k in ("chapter", "exercise")):
        return CHAPTER_COLOR, [1440]
    return MILESTONE_COLOR, [1440]


def parse_glo_date(when):
    """'5-Oct-2026, 11:59 PM' -> date. The clock part is discarded on purpose: every
    GLO-BUS deadline is 11:59 PM and the events are pinned to a 23:00-23:59 block."""
    return datetime.strptime(when.split(",")[0].strip(), "%d-%b-%Y").date()


def times_for(day):
    return ({"dateTime": f"{day.isoformat()}T23:00:00", "timeZone": TZ},
            {"dateTime": f"{day.isoformat()}T23:59:00", "timeZone": TZ})


def existing_events(svc):
    """Every GLO-BUS event we own, keyed by title. One read, then many writes."""
    out, token = {}, None
    now = datetime.now(timezone.utc) - timedelta(days=30)
    while True:
        resp = svc.events().list(
            calendarId=CALENDAR_ID, q="GLO-BUS", singleEvents=True,
            timeMin=now.isoformat(), maxResults=250, pageToken=token).execute(num_retries=API_RETRIES)
        for ev in resp.get("items", []):
            s = ev.get("summary", "")
            if s.startswith(TITLE_GUARD):
                if s in out and out[s].get('id') != ev.get('id'):
                    raise RuntimeError('Multiple owned Calendar events have the same GLO-BUS title; retained for review')
                out[s] = ev
        token = resp.get("nextPageToken")
        if not token:
            break
    return out


def owned_event(ev, title):
    return isinstance(ev, dict) and ev.get('summary') == title and isinstance(ev.get('id'), str) and bool(ev['id'])


def event_at_expected_times(ev, day):
    if ev.get('recurrence') or ev.get('recurringEventId') or ev.get('status') == 'cancelled':
        return False
    def instant(part):
        try:
            value = datetime.fromisoformat(part['dateTime'].replace('Z', '+00:00'))
            if value.tzinfo is None:
                value = value.replace(tzinfo=ZoneInfo(part['timeZone']))
            return value.astimezone(ZoneInfo(TZ))
        except (KeyError, TypeError, ValueError):
            return None
    expected_start = datetime.combine(day, datetime.min.time()).replace(hour=23, tzinfo=ZoneInfo(TZ))
    return instant(ev.get('start', {})) == expected_start and instant(ev.get('end', {})) == expected_start.replace(minute=59)


def reconcile_event(svc, ev, title, day, start, end, patch, index, dry=False):
    if not owned_event(ev, title):
        return False, 'refusing to update an event without matching owned identity'
    if ev.get('recurrence') or ev.get('recurringEventId'):
        return False, 'refusing to change an ambiguous recurring GLO-BUS event'
    if event_at_expected_times(ev, day):
        return True, f'already correct: {title} on {day}'
    if dry:
        return True, f'would move {title} -> {day}'
    note = (ev.get('description', '') or '').split('\n[moved ')[0]
    note += (f"\n[moved {datetime.now():%Y-%m-%d}: GLO-BUS confirmed "
             f"{patch['to']}]")
    body = {'start': start, 'end': end, 'description': note}
    response = svc.events().patch(calendarId=CALENDAR_ID, eventId=ev['id'], body=body).execute(num_retries=API_RETRIES)
    index[title] = dict(ev, **body)
    if isinstance(response, dict):
        index[title].update(response)
    return True, f'moved {title} -> {day}'


def apply_patch(svc, patch, index, dry=False):
    title = patch["calendar_title"]
    if not title.startswith(TITLE_GUARD):
        return False, f"refusing to touch a non-GLO-BUS event: {title!r}"

    kind = patch["kind"]
    if kind in ("move", "add"):
        day = parse_glo_date(patch["to"])
        start, end = times_for(day)

    if kind in ("move", "add"):
        ev = index.get(title)
        if ev:
            # An insert can succeed while its reply is lost. On the next queue
            # run, reuse that owned event instead of creating a second deadline.
            return reconcile_event(svc, ev, title, day, start, end, patch, index, dry)
        kind = 'add'

    if kind == "add":
        if dry:
            return True, f"would create {title} on {day}"
        color, mins = classify(title)
        body = {
            # Google permits client-provided base32hex IDs. A stable title ID
            # makes a lost insert reply safe even before list results catch up.
            'id': 'glo' + hashlib.sha256(title.encode('utf-8')).hexdigest(),
            "summary": title, "start": start, "end": end, "colorId": color,
            "description": f"Added {datetime.now():%Y-%m-%d} by the GLO-BUS watcher "
                           f"after it appeared in the lobby schedule.",
            "reminders": {"useDefault": False,
                          "overrides": [{"method": "popup", "minutes": m}
                                        for m in mins]},
        }
        try:
            response = svc.events().insert(calendarId=CALENDAR_ID, body=body).execute(num_retries=API_RETRIES)
        except Exception as exc:
            if getattr(getattr(exc, 'resp', None), 'status', None) != 409:
                raise
            # A conflict only proves that this ID exists, not that the event is
            # ours. Check the exact title before acknowledging or repairing it.
            existing = svc.events().get(calendarId=CALENDAR_ID, eventId=body['id']).execute(num_retries=API_RETRIES)
            if not isinstance(existing, dict) or existing.get('id') != body['id']:
                return False, 'Calendar retry readback did not match the expected event identity'
            return reconcile_event(svc, existing, title, day, start, end, patch, index, dry)
        if not isinstance(response, dict) or response.get('id') != body['id']:
            raise RuntimeError('Calendar insert did not return the expected owned event identity; retained for retry')
        index[title] = dict(body)
        if isinstance(response, dict):
            index[title].update(response)
        return True, f"created {title} on {day}"

    if kind == "remove":
        ev = index.get(title)
        if not ev:
            return True, f"already gone: {title}"
        if ev.get("summary", "").startswith("[CANCELLED]"):
            return True, f"already cancelled: {title}"
        if dry:
            return True, f"would mark cancelled: {title}"
        svc.events().patch(calendarId=CALENDAR_ID, eventId=ev["id"], body={
            "summary": "[CANCELLED] " + ev["summary"],
            "colorId": INFO_COLOR,
            "transparency": "transparent",
            "reminders": {"useDefault": False, "overrides": []},
            "description": (ev.get("description", "") or "")
            + f"\n[{datetime.now():%Y-%m-%d}: no longer in the GLO-BUS schedule. "
              f"Left here rather than deleted, in case that is wrong.]",
        }).execute(num_retries=API_RETRIES)
        return True, f"marked cancelled: {title}"

    return False, f"unknown patch kind {kind!r}"


def apply_queue(dry=False):
    q = load_json(QUEUE, {"pending": []})
    pending = q.get("pending", [])
    if not pending:
        return 0, 0
    if not configured():
        log(f"{len(pending)} calendar change(s) queued but Google is not authorised "
            f"yet — run: bin/calendar_sync.py --authorize")
        return 0, len(pending)

    try:
        svc = service()
    except NeedsReauth as e:
        log(f"NEEDS REAUTH: {e}")
        notify("Calendar sync needs re-authorising",
               f"{len(pending)} date change(s) waiting. Run calendar_sync.py "
               f"--authorize")
        return 0, len(pending)
    index = existing_events(svc)
    done, keep = 0, []
    for patch in pending:
        try:
            ok, msg = apply_patch(svc, patch, index, dry=dry)
        except Exception as e:
            ok, msg = False, safe_error(e)
        log(("  " if ok else "  FAILED ") + msg)
        if ok and not dry:
            done += 1
        else:
            patch["attempts"] = patch.get("attempts", 0) + (0 if dry else 1)
            patch["last_error"] = None if ok else msg[:300]
            if patch["attempts"] < MAX_ATTEMPTS or dry:
                keep.append(patch)
            else:
                log(f"  retaining for retry after {patch['attempts']} attempts: "
                    f"{patch['calendar_title']}")
                keep.append(patch)
    if not dry:
        save_json(QUEUE, {"pending": keep})
    return done, len(keep)


if __name__ == "__main__":
    if "--authorize" in sys.argv:
        service(interactive=True)
        print(f"authorised — token written to {TOKEN}")
        sys.exit(0)
    if "--check" in sys.argv:
        ok, why = healthy()
        log(f"calendar sync health: {'OK' if ok else 'NEEDS ATTENTION'} — {why}")
        sys.exit(0 if ok else 1)
    d, left = apply_queue(dry="--dry-run" in sys.argv)
    log(f"calendar sync: {d} applied, {left} still queued")
