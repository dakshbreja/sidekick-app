#!/usr/bin/env python3
"""Compare the local Drive folder against what is actually in Google Drive.

This exists because of a silent eleven-day failure. The Google Drive daemon died
around 20 Aug and did not restart. Its Finder and FileProvider extensions kept
running, so the folder stayed browsable and every file the eLC sweep wrote landed
on disk exactly as expected — drive_sync went on reporting "filed" for each one.
Nothing was uploaded. By 31 Aug only 27 of 133 course files existed in the cloud,
including zero of MGMT 4280's lecture slides.

Nothing noticed, because nothing was comparing the two sides. Writing a file to a
synced folder tells you the write succeeded, not that the sync did.

Writes .drive-sync.json for routinectl (status_kind: json).

    /opt/anaconda3/bin/python3 scripts/drive_sync_check.py [--verbose]
"""
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN = os.path.join(ROOT, ".gdrive-token.json")
SERVICE_ACCOUNT = os.path.join(ROOT, ".gdrive-service-account.json")
OUT = os.path.join(ROOT, ".drive-sync.json")
LOCAL = os.path.expanduser(
    "~/Library/CloudStorage/owner@example.com/My Drive/"
    "College/UGA/Year 4 - 2026-27/Classes/Fall 2026")
FOLDER = "application/vnd.google-apps.folder"
API = "https://www.googleapis.com/drive/v3/files"

# The library root, resolved once and cached here. Not walked by name: the
# "College" folder at the root of My Drive is a shortcut, so a folder-only query
# never finds it. See src/drive.js for the full story.
FALL_2026 = "1f0gLSTYzLcsHfSIMTn2BwdZWsMzBdYq6"

# A handful of files in flight is normal — uploads are not instant and the ERP
# zips are 30-50 MB each. A persistent gap is not.
TOLERATE_BEHIND = 3


def write(overall, message, problems, extra=None):
    blob = {
        "ran_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "overall": overall,
        "message": message,
        "problems": problems,
    }
    if extra:
        blob.update(extra)
    with open(OUT, "w") as f:
        json.dump(blob, f, indent=2)
    print(json.dumps(blob, indent=2))
    return 0 if overall == "ok" else 1


def daemon_running():
    """The extensions run without it, so check for the main process by name."""
    try:
        out = subprocess.run(["pgrep", "-f", "Google Drive.app/Contents/MacOS/Google Drive"],
                             capture_output=True, text=True, timeout=15)
        return bool(out.stdout.strip())
    except Exception:
        return None            # cannot tell; do not claim either way


def recover_daemon():
    """Restart only the already installed client; no force quit or account changes.

    Use the existing hourly check rather than a second overlapping sync job.
    A running process is only recovery of the process, not upload verification.
    """
    if daemon_running() is not False:
        return False
    try:
        result = subprocess.run(['/usr/bin/open', '-gj', '-a', 'Google Drive'],
                                capture_output=True, timeout=20)
        if result.returncode != 0:
            return False
        time.sleep(2)
        return daemon_running() is True
    except Exception:
        return False


def token():
    # Reuse the bridge's existing folder-shared, read-only identity. Never
    # silently fall back after a configured service-account failure.
    if os.path.exists(SERVICE_ACCOUNT):
        try:
            from google.oauth2 import service_account
            from google.auth.transport.requests import Request
            credentials = service_account.Credentials.from_service_account_file(
                SERVICE_ACCOUNT, scopes=['https://www.googleapis.com/auth/drive.readonly'])
            credentials.refresh(Request())
            return credentials.token
        except Exception:
            raise RuntimeError('Drive service-account authorization failed') from None
    t = json.load(open(TOKEN))
    body = urllib.parse.urlencode({
        "client_id": t["client_id"], "client_secret": t["client_secret"],
        "refresh_token": t["refresh_token"], "grant_type": "refresh_token"}).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=body)
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.loads(r.read())["access_token"]


def query(at, q):
    files, page, seen = [], None, set()
    while True:
        params = dict(q=q,fields='nextPageToken,files(id,name,mimeType)',pageSize=200)
        if page: params['pageToken'] = page
        req = urllib.request.Request(API+'?'+urllib.parse.urlencode(params),
                                     headers={"Authorization": "Bearer " + at})
        with urllib.request.urlopen(req, timeout=60) as r:
            result = json.load(r)
        files.extend(result.get('files', []))
        page = result.get('nextPageToken')
        if not page: return files
        if page in seen: raise RuntimeError('Drive returned a repeated page token')
        seen.add(page)


def cloud_count(at, fid):
    n = 0
    for c in query(at, f"'{fid}' in parents and trashed=false"):
        n += cloud_count(at, c["id"]) if c["mimeType"] == FOLDER else 1
    return n


def local_count(path):
    if not os.path.isdir(path):
        return 0
    return sum(1 for r, _d, fs in os.walk(path) for f in fs if not f.startswith("."))


def main():
    verbose = "--verbose" in sys.argv
    if not os.path.exists(SERVICE_ACCOUNT) and not os.path.exists(TOKEN):
        return write("problem", "no Drive token; run scripts/drive_auth.py",
                     ["missing .gdrive-token.json"])
    recovered = recover_daemon() if '--recover' in sys.argv else False
    if not os.path.isdir(LOCAL):
        return write("problem", "local Drive folder is not mounted", [LOCAL])

    running = daemon_running()
    try:
        at = token()
        courses = query(at, f"'{FALL_2026}' in parents and trashed=false "
                            f"and mimeType='{FOLDER}'")
    except Exception as e:
        return write("problem", f"Drive API unreachable: {str(e)[:120]}", [str(e)[:200]])

    rows, problems, cloud_total, local_total = [], [], 0, 0
    for c in sorted(courses, key=lambda f: f["name"]):
        cloud = cloud_count(at, c["id"])
        local = local_count(os.path.join(LOCAL, c["name"]))
        cloud_total += cloud
        local_total += local
        rows.append({"course": c["name"].strip(), "cloud": cloud, "local": local})
        if local - cloud > TOLERATE_BEHIND:
            problems.append(f"{c['name'].strip()}: {local - cloud} file(s) on disk "
                            f"are not in Drive ({cloud}/{local})")
        if verbose:
            print("%-12s cloud %3d / local %3d" % (c["name"].strip(), cloud, local))

    behind = local_total - cloud_total
    extra = {"cloud_files": cloud_total, "local_files": local_total,
             "behind": behind, "daemon_running": running, "daemon_recovered": recovered, "courses": rows}

    # A File Provider mount can answer "the directory exists" while still
    # returning nothing inside it — Drive populates lazily after boot or wake. The
    # first version treated that as behind <= 0 and reported a cheerful
    # "all 0 course file(s) are in Drive", which is precisely the false green this
    # routine was written to stop. Cloud holding files while local sees none is
    # never a healthy state.
    if cloud_total > 0 and local_total == 0:
        return write("problem",
                     f"local Drive folder reads as empty while {cloud_total} file(s) "
                     f"are in the cloud — Drive is probably still mounting",
                     ["local tree returned 0 files; mount not ready"], extra)

    if running is False and behind > 0:
        # The exact shape of the original failure, named so it is unmistakable.
        return write("problem",
                     f"Google Drive is not running and {behind} file(s) are unsynced "
                     f"— start Google Drive.app",
                     [f"daemon not running; {behind} file(s) local-only"] + problems, extra)
    if problems:
        return write("problem",
                     f"{behind} of {local_total} course file(s) are on disk but not in Drive",
                     problems, extra)
    if behind > 0:
        return write("ok", f"{behind} file(s) uploading, {cloud_total}/{local_total} in Drive",
                     [], extra)
    return write("ok", f"all {local_total} course file(s) are in Drive", [], extra)


if __name__ == "__main__":
    sys.exit(main())
