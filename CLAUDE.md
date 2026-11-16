# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A school companion for Daksh's own Fall 2026 coursework: what changed, what he
needs to do, whether he is finished, and what he needs to learn. The bridge is the
shared state service underneath it; the six ChatGPT class GPTs, the dashboard and
the Codex MCP adapter are all clients of the same answer.

**Product direction and milestones: `docs/PRODUCT.md`. Current implementation
state, and what each client still needs: `docs/STATUS.md`.** Read those before
starting new work — they say what is deliberately deferred and why.

One system that keeps Daksh's six ChatGPT class GPTs current on Fall 2026 coursework.
Six folders that were separate top-level projects until 2026-09-03; they share state,
credentials and a single failure surface, so treat a change in one as a change to all.

| Folder | Role |
|---|---|
| `bridge/` | Cloudflare Worker the GPTs call as an Action. Serves `/status`, owns KV, hosts the dashboard. |
| `collect/` | Reads eLC + GLO-BUS through BrowserOS neo. Downloads, extracts, transcribes, files to Drive, uploads to GPT Knowledge. |
| `collect/bin/grades/` | Grade adapters (eLC, Gradescope, GLO-BUS). Its own routine on its own clock. |
| `meetings/` | Cluely class recordings, the `verify.py` gate, the push to `/classnote`. |
| `grades-remote/` | Private git repo. The only path by which a phone reads grade state. |
| `board/` | Static semester wall-chart. Stale; see Known-broken. |
| `gpt-config/` | The six GPTs' instruction sets; `loaded/` holds what was actually pushed. |

Background jobs live in `~/Claude/routines/`, **outside this project**, because that
registry also owns rent-check and desktop-cleanup.

`bridge/README.md` is the long-form design doc and is deliberately kept current — it is
the document handed to other models for review. Read it before changing Worker behaviour.

## Commands

```bash
# Bridge (from bridge/)
npm test                                      # 158 tests, no deps, node --test
python3 mcp/test_school_bridge_mcp.py         # 25 MCP contract tests, offline, stdlib only
node --test test/status.test.mjs              # one file
node --test --test-name-pattern 'ambiguous' 'test/*.test.mjs'   # by name
npm run dev                                   # wrangler dev
npm run deploy:all                            # test, then deploy BOTH env names

# Routines — the registry is the source of truth, never hand-edit a plist
python3 ~/Claude/routines/routinectl status   # what ran, when, whether it worked
python3 ~/Claude/routines/routinectl run <id>
python3 ~/Claude/routines/routinectl logs <id>
python3 ~/Claude/routines/routinectl install  # rewrite + reload all launchd plists

# Collectors — every one of these has a --dry-run that touches no state
python3 collect/bin/elc_daily.py --dry-run    # also --force, --upload-only
python3 collect/bin/globus_watch.py --dry-run
python3 collect/bin/drive_sync.py --reconcile --dry-run
python3 meetings/bin/push_notes.py --dry-run
python3 meetings/bin/verify.py meetings/Classes/*.md

# Leave a note the GPTs read on open (global, or scoped to one course)
bridge/note.sh BUSN5000 "Set up RStudio; pre-Project exercise is next."
```

Collector scripts need `/opt/anaconda3/bin/python3` (pypdf, python-pptx, olefile) and
`/opt/homebrew/bin` on PATH (ffmpeg, whisper-cli). The `run_*.sh` wrappers pin both —
prefer them over calling the `.py` directly when reproducing a launchd failure.

## Architecture

```
COLLECT (this Mac, signed-in Neo)        SERVE (edge)              CONSUME
  collect/  sweep → extract → bundle → gpt_upload ─────────────────► GPT Knowledge
            transcribe (whisper, slide-primed)
            drive_sync ──► Google Drive
            globus_watch ──► calendar_sync ──► Google Calendar
  meetings/ export → verify (gate) → push_notes ──► /classnote ──┐
                                                                 ├─► Worker ──► 6 GPTs
  eLC iCal + Google Calendar iCal ──── read live per call ───────┘
  collect/bin/grades/ ──► model.py ──► grades-remote (git) ──► phone
                            ✗ never reaches the bridge
```

Invariants that span files — breaking one is a silent data-quality bug, not a crash:

- **Calendars are read live on every `/status` call; KV holds only what no calendar
  knows** (class notes, progress, Claude's last note, change snapshots). Never cache a
  deadline into KV — there is no sync lag today precisely because there is no copy.
- **Scores never reach the bridge.** The API key sits in six GPT authentication
  panels, never in a new URL. Static schema import uses `/openapi.json` once the
  November 11 credential-free entry patch is deployed. Grade percentages stay on
  this Mac and go to the private repo.
  Stated at the top of `collect/bin/grades/model.py`; don't relitigate it.
- **Never guess a completion.** A report only clears deadlines **in its own course**,
  and only when exactly one matches. Several matches — including several exact
  matches, which happens when a course reuses a title — clear nothing and come back
  in `completion_ambiguous`. Loose substring matching previously cleared Exam 1, 2
  and the final from one report of "exam"; course-blind matching cleared BUSN 5000
  and MGMT 4280 "Quiz 1" from one report. A report with no course means GENERAL,
  which reaches only course-less deadlines — it is never a wildcard.
- **Matching an assignment is not evidence it was submitted.** `match_method`
  (`exact` | `unique_alias` | `unresolved`) says which deadline a report refers to;
  `submission_verification` (`verified` | `reported` | `unknown` | `not_required`)
  says what the bridge actually observed. `verified` requires an `evidence`
  reference and is rejected without one. `completion.confidence` is the legacy name
  for the title match only — never read it as a confirmed submission, and never
  upgrade a historical `done` to verified.
- **One actionable view, or the clients disagree.** `actionable` is built once in
  `status.js` and consumed by the briefing, the dashboard counters, the embedded
  assistant, the GPT payload and the MCP projection. Completed work is absent from
  `actionable.outstanding` and from the overdue prose — do not re-derive counts in
  a client, and do not list something and then tell the model to ignore it.
- **The MCP adapter must not improve on the truth.** An upstream error is returned
  before any projection (filtering one first turned an offline bridge into an empty
  success), every response is whole valid JSON rather than a prefix of one, and
  anything dropped for size is named in `response_completeness` with a working
  continuation. Urgent work and warnings are never dropped silently.
- **Never trust a Cluely summary.** `meetings/bin/verify.py` gates every push: it splits
  by audio channel to find non-class audio and drops summary bullets the class portion
  of the transcript doesn't support. It has already caught a college-admissions podcast
  and a fabricated instructor email reaching the GPTs.
- **Titles cannot exclude current-term recordings.** `meetings/bin/cluely_export.py`
  inspects unclassified transcripts and reports unresolved routing as deferred.
  `meetings/ROUTING.md` and `meetings/routing.json` describe content review and
  hash-bound session decisions. Do not restore the old title-prefix-only filter.
- **Change detection must not cry wolf.** The fetch window slides (10 back, 45 forward),
  so every snapshot stores the window it was taken with, and an add/remove only counts
  inside both windows. The diff is skipped entirely when any feed failed — an outage is
  indistinguishable from every deadline being deleted. Snapshots always cover *all*
  courses even on a scoped request.
- **State files, not reports, are the source of truth.** `reports/latest.md` is
  overwritten every sweep; `.pending-upload.json`, `.manifest.json`, `.daily-state.json`
  survive it.
- **Scrapes never demote.** The grade lifecycle `pending → in_progress → completed →
  graded` only moves forward; Gradescope reports "No Submission" for work in progress.
- **The calendar writer never deletes.** `calendar_sync.py` only touches events whose
  title starts with `TITLE_GUARD`, and marks vanished deadlines `[CANCELLED]` rather
  than removing them.

## Hard external limits that shape the design

- **BrowserOS neo is the collection browser.** As of November 7, 2026, the existing
  `collect/bin/chrome_bridge.py` compatibility API uses Neo's already-configured
  official MCP endpoint at `http://127.0.0.1:9010/mcp`. eLC, Gradescope, GLO-BUS and
  GPT maintenance share this transport. Historical module/exception names do not
  mean Chrome is still used. There is no Chrome or Apple Events fallback, no
  credential/profile copying, and no new permission or schedule. Neo must be open,
  connected and signed in to each source in its Default profile. Collectors use
  owned background tabs with stable IDs, leave user tabs alone, reject unconfirmed
  navigation and fail closed without retrying uncertain operations. Large Neo
  results are read only from its exact private output files after identity/format
  checks. Source freshness, complete capture and GPT publication still require
  their original per-stage receipts; browser access alone does not prove success.
- **KV allows 1,000 writes/day** across three writers. `globus_watch.py` writes nothing
  when nothing changed, on purpose. Bursts of `/status` have separately tripped the
  Worker CPU limit (error 1102) — not the KV limit.
- **KV reads are eventually consistent (~60s), and `/classnote` read-modify-writes.**
  Two pushes to one course inside that window silently revert the first.
  `push_notes.py` spaces same-course pushes past `KV_CONSISTENCY`; that client-side
  guard is the only one there is.
- **GPT Knowledge caps at 20 files, not bytes.** `bundle.py` rebuilds four large
  bundles per course wholesale from `<course>/text/*.txt` — never append to a bundle.
- **ChatGPT caps GPT instructions at 8,000 characters** (characters, not bytes). Several
  GPTs sit within a few dozen of the cap, which is why the slash-command directory ships
  inside the `/status` payload (`bridge/src/commands.js`) rather than in each GPT.
- **The Worker has no npm dependencies by design.** `src/ask.js` calls the Messages API
  with `fetch`, not the SDK; `src/ics.js` is a hand-rolled iCal parser. Keep it that way.

## Generated files — do not hand-edit

- `bridge/src/openapi.js` ← `node scripts/build-openapi.mjs` from `gpt-action-schema.yaml`
- `gpt-config/loaded/v2/` ← `node scripts/build-instructions.mjs` (originals in `loaded/` are never modified)
- `~/Library/LaunchAgents/com.daksh.*.plist` ← `routinectl install` from `routines.json`
- `board/semester.html` ← `python3 board/build.py`

## Test fixtures and time

`test/fixtures.js` carries absolute dates modelled on the real feeds as of
`FIXTURE_ANCHOR` (2026-08-19). Two kinds of test consume them differently, and new
tests must pick one deliberately:

- `status.test.mjs` drives the pure functions (`buildStatus`, `parseICS`, `loadEvents`),
  all of which take an explicit `now` / window. It uses the fixtures as written and
  asserts real weekdays and dates.
- `worker.test.mjs` goes through `worker.fetch()`, which reads the system clock. It
  shifts the feeds forward with `shiftFeed(feed, weeksSinceAnchor())` so they land
  inside LOOKBACK/LOOKAHEAD of whenever the suite runs.

The shift is always a whole number of **weeks** — the Google block has
`RRULE;BYDAY=TU,TH` plus an `EXDATE` and a `RECURRENCE-ID`, and any other offset slides
events off the weekdays their recurrence rules name. Never hardcode a date into a
`worker.test.mjs` assertion; discover it from the payload, as the existing tests do.

## Known-broken

- **`board/` cannot refresh.** `build.py` hardcodes `TODAY` and renders a hand-pulled
  `data.json`. It is the only component with no routine. The `/app` dashboard
  covers the same ground with live data.

## Conventions

Prose in this codebase explains *why*, usually citing the incident that forced the
choice, and module docstrings carry the real design rationale. Match that when adding
code — a comment that only restates the line is worse than none. Dates in notes are
absolute, never relative.
