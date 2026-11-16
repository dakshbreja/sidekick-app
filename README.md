# School

Everything that watches Daksh's Fall 2026 coursework and feeds his six ChatGPT class
GPTs. Six folders that used to be six projects; they were always one system, and the
data flows through all of them in one direction.

Consolidated from separate top-level folders on **2026-09-03**. Nothing was rewritten
in the move except path prefixes — each folder keeps the internal structure and the
README it already had.

## Current entrypoint — October 12, 2026

Start with [the latest implementation status](docs/STATUS.md) and [the repair report](/Users/Daksh/Documents/Codex/2026-10-10/do-me-a-favor-and-check-2/outputs/school-bridge-final-repairs.md). The October 12 repair run closed with **810 passing checks** (529 JavaScript plus 281 isolated Python/MCP) and 25 inventoried source hashes. Both Bridge addresses contain the verified calendar/module-change, dashboard and service fixes; local recovery includes exact native intake, source-quality boundaries and strict GPT publication verification. Native MGMT4280/BUSN5000/LAND source-grounding checks passed; all 13 coursework/learning partitions were unchanged after final retrieval. Of 153 materials, 147 have verified delivery, four cloud readbacks remain pending and two BUSN3040 pages remain templates; GPT/native queues are empty. GLO-BUS login, Anthropic funding, Cmd-Q/reopen for MCP, partial source coverage and the unperformed December 11 GPT migration remain explicit. No UGA or all-green readiness claim.

The original consolidation overview below is retained as history. Its KV-only and missing-board-routine claims are superseded by `docs/STATUS.md`, the deployed transactional implementation, and the canonical hub ownership rules. Codex is primary; do not restore retired Claude school schedules.

## Layout

| Folder | Was | What it does |
|---|---|---|
| `bridge/` | `gpt-status-bridge` | The Cloudflare Worker the GPTs call. Serves `/status`, holds KV, hosts the dashboard. |
| `collect/` | `eLC-Content` | Reads eLC and GLO-BUS through Chrome. Downloads, extracts, transcribes, files to Drive, uploads to GPT Knowledge. |
| `collect/bin/grades/` | — | The grade adapters (eLC, Gradescope, GLO-BUS). Separate routine, separate clock. |
| `meetings/` | `Cluely-Meetings` | Class recordings, the `verify.py` gate, and the push to `/classnote`. |
| `grades-remote/` | `grades-remote` | Private git repo. The only way a phone can read grade state. |
| `board/` | `semester-board` | Static semester wall-chart. **Stale — see Known issues.** |
| `gpt-config/` | `fall-2026-gpts` | The six GPTs' instruction sets, and `loaded/` copies of what was actually pushed. |

Background jobs are **not** here. They live in `~/Claude/routines/`, because that
registry also governs rent-check and desktop-cleanup, which have nothing to do with
school. See "Operating it" below.

## How it fits together

```
   COLLECT (this Mac, logged-in Chrome)      SERVE (Cloudflare edge)        CONSUME

   collect/
     sweep.js ──► elc_diff ──► extract_text ──┐
     transcribe.py (whisper + slide priming) ─┼─► bundle.py ──► gpt_upload ──► GPT Knowledge
     drive_sync.py ──────────────────────────►│                                (20-file cap)
     globus_watch.py ──► calendar_sync.py ────┤
                                              │
   meetings/                                  │    bridge/
     cluely_export (CDP :9222)                │      Worker ◄── iCal: eLC + GCal (live, every call)
       └► verify.py ──► push_notes ───────────┼───►  KV: classnote / progress / note / snapshot
          (gate)                              │      /status ─────────────────► 6 ChatGPT GPTs
                                              │      /app/<key> ──► dashboard + /ask (Opus 5)
   collect/bin/grades/                        │
     elc | gradescope | globus ──► model.py ──┴──► grades-remote ──► phone
                                    ✗ never touches the bridge
```

Two invariants worth not breaking:

* **Calendars are read live on every `/status` call.** KV holds only what no calendar
  knows — what was said in class, what's finished, what Claude last did. There is no
  sync lag because there is no copy.
* **Scores never reach the bridge.** That API key sits in six GPT configs and in
  `/openapi/<key>.json`. Grade percentages stay on this Mac and go to the private
  repo instead. `collect/bin/grades/model.py` says so at the top; leave it there.

## Operating it

```
python3 ~/Claude/routines/routinectl status      what ran, when, whether it worked
python3 ~/Claude/routines/routinectl install     rewrite + reload the launchd plists
```

`routines.json` is the single source of truth for all eight jobs. Change a schedule
there and run `install`; never hand-edit a plist in `~/Library/LaunchAgents/`.

Everything runs locally because all of it touches the filesystem, Chrome, or the
Google Drive mount. None of it can run in the cloud.

## Known issues

1. **`board/` is stale and structurally can't refresh.** `build.py` hardcodes
   `TODAY = 2026-08-23` and renders from a hand-pulled `data.json` snapshot. It is
   the only school component with no routine. Either point it at `/status` the way
   `bridge/src/app.js` does, or retire it — the `/app/<key>` dashboard now covers the
   same ground with live data.

2. **Chrome is the whole collection tier's single point of failure.** The eLC sweep,
   all three grade adapters, and the GLO-BUS watcher go through
   `collect/bin/chrome_bridge.py`. One toggle — Chrome ▸ View ▸ Developer ▸ *Allow
   JavaScript from Apple Events* — silently disables five of eight routines, and
   `routinectl status` reports that as five unrelated failures. A single "is the
   Chrome bridge alive" probe in the health check would collapse them into one.

3. **`/classnote` has a read-modify-write race, guarded only client-side.**
   `meetings/bin/push_notes.py` spaces same-course pushes past the 65s KV cache
   window, which holds only while that script is the sole writer. Accepting a batch
   of entries in one POST closes it server-side and is far smaller than moving the
   list to a Durable Object.

## Product direction

`docs/PRODUCT.md` is what this is being built into and in what order.
`docs/STATUS.md` is where the implementation actually stands, including what each
client still needs before a change reaches it. Milestone 1 — one dependable,
identical status across every client — is deployed to both bridge addresses.
The current Codex MCP process still needs a reconnect; optional GPT evidence-write
fields still require schema re-import. See the exact client state in `docs/STATUS.md`.

## Where the per-project detail lives

`bridge/README.md` is the long one — it is the document handed to other models when
asking them to review the system, and it is kept current on purpose. `meetings/README.md`
covers why a Cluely summary is never trusted. `grades-remote/README.md` covers grade
source coverage per course.
