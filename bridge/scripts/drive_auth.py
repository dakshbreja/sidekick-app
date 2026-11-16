#!/usr/bin/env python3
"""One-time consent for read-only Google Drive, for the bridge's /library route.

Run this once, click through the browser, and it stores a private grant. The
Worker normally reads through its folder-shared service account; this preserves
the existing independent read-only OAuth grant for explicit fallback recovery.
After publishing an external OAuth client, run it again to replace any old
Testing grant rather than waiting for the old seven-day token to expire.

Deliberately writes its OWN token file rather than touching
~/Claude/school-system-suite/collect/.gcal/token.json. That token holds only calendar.events, and
re-consenting it with a wider scope would mean the calendar sync starts carrying
Drive access it has no use for. Same OAuth client, separate grant.

    /opt/anaconda3/bin/python3 scripts/drive_auth.py
"""
import json
import os
import sys
import tempfile

CLIENT = os.path.expanduser("~/Claude/school-system-suite/collect/.gcal/client_secret.json")
TOKEN = os.path.expanduser("~/Claude/school-system-suite/bridge/.gdrive-token.json")
SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]


def save_grant(creds, path=TOKEN):
    if not creds.refresh_token:
        raise RuntimeError("Google returned no offline refresh grant; existing authorization was preserved")
    actual = getattr(creds, 'granted_scopes', None)
    if actual is None:
        actual = getattr(creds, 'scopes', None)
    if isinstance(actual, str):
        actual = actual.split()
    if not isinstance(actual, (list, tuple, set)) or set(actual) != set(SCOPES):
        raise RuntimeError("Google consent did not grant exactly the requested read-only Drive permission; existing authorization was preserved")
    fd, temporary = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".drive-auth-")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump({
                "client_id": creds.client_id,
                "client_secret": creds.client_secret,
                "refresh_token": creds.refresh_token,
                "scopes": list(actual),
            }, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    if not os.path.exists(CLIENT):
        sys.exit(f"missing OAuth client at {CLIENT}")

    from google_auth_oauthlib.flow import InstalledAppFlow

    flow = InstalledAppFlow.from_client_secrets_file(CLIENT, SCOPES)
    # access_type=offline + prompt=consent is what actually returns a refresh
    # token. Without prompt=consent Google reuses the existing grant for this
    # client and returns none, which fails later in the Worker rather than here.
    # --no-browser prints the URL instead of launching one, so the consent can be
    # completed in an already-signed-in Chrome rather than whatever the OS picks
    # as default.
    headless = "--no-browser" in sys.argv
    creds = flow.run_local_server(
        port=0, access_type="offline", prompt="consent",
        open_browser=not headless,
        authorization_prompt_message=(
            "OPEN THIS URL: {url}" if headless
            else "Opening a browser to authorise read-only Drive access..."),
        success_message="Drive access granted. You can close this tab.")

    try:
        save_grant(creds)
    except RuntimeError as exc:
        sys.exit(str(exc))

    print(f"\nwrote {TOKEN}\n")
    print("If explicitly switching the canonical Worker to OAuth, set its secrets")
    print("through the secure deployment path (each command prompts for a value):\n")
    print("  npx wrangler secret put GDRIVE_CLIENT_ID")
    print("  npx wrangler secret put GDRIVE_CLIENT_SECRET")
    print("  npx wrangler secret put GDRIVE_REFRESH_TOKEN")
    print("\nThe coursework alias forwards to the canonical Worker; no second grant is needed.")
    print("Existing service-account authorization is unchanged. No secret values were printed.")


if __name__ == "__main__":
    main()
