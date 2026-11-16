# GPT Status Bridge

## Credential-free entry URLs — November 11, 2026 (local source, not deployed)

The reviewed source uses `GET /openapi.json` for static Action-schema import.
Import still requires API Key → Bearer in the separate authentication panel;
serving the contract publicly does not grant access to any private API. Existing
GPT schema snapshots, bearer credentials, scoped grants and saved records stay
unchanged. The retired `/openapi/<key>.json` format returns 410 for every value.

Browser entry uses `/app` or `/app/sign-in`. Key-bearing `/app/<key>` bookmarks
redirect to a clean sign-in page without inspecting the key or issuing a session.
The existing same-origin POST form, opaque sessions, revocation, login-attempt
limits and legacy-cookie upgrade remain supported. Both the redirects and sign-in
page use `no-store` and `no-referrer`. The read-only foundation probe now uses the
credential-free schema URL and has not been run against production by this patch.

These changes do not erase keys already retained in browser history, copied links
or upstream logs. The shared integration bearer remains broad and unchanged.
Review any past exposure and coordinate a separately approved credential rotation
if needed; do not silently invalidate the six GPTs or other existing clients.
Deployment and live read-only verification remain separate approved steps.

## Material delivery repair — November 7, 2026

The canonical Worker version `40cfd714-f91c-4fee-bc1c-78379ab8825b` retains exact
course/filename/content-hash extraction variants alongside the compatible latest
filename view. Optional `text_sha256` selectors on `/library/text` receipts and
`/library/doc` choose exact retained bytes. Selected document reads support
`offset`, `next_offset` and `total_chars`, with 120,000-character pages and safe
Unicode boundaries. The collector assembles every page and hashes the complete
bytes before acknowledging delivery. Default document reads are unchanged.

Ingestion remains finite: 2,000,000 UTF-16 units, with a 12,100,000-byte JSON-body
bound; the local publisher independently caps UTF-8 text at 2,000,000 bytes.
Same-name source topics no longer overwrite each other's only extraction.
Existing authentication, bindings, schedules, source originals, PASS/coursework
and learning records are unchanged by this source patch. 660 JavaScript, 373
collector and 63 MCP isolated tests passed. Final post-publication reads reassembled and hash-verified Slides (eight pages)
and both same-name CSV extractions (four pages each). Material delivery improved
from 209/218 to 216/218 complete; two original source-template entries remain
pending, not inferred complete or superseded. This does not establish a fresh
eLC sweep or GPT Knowledge publication.


November 3 agent-first release: PASS is the durable product; `/app` is the human
review window. `/agents` and `/agents/contract` document the actual unchanged PASS
transport, exact schemas, provenance/revision/idempotency rules and current secure
onboarding limits. Owner-authenticated `GET /next-actions` supplies read-only source
priorities without dashboard scraping. Today pins the next hard deadline and
explicitly linked preparation, and folds source warnings into one disclosure.
Stale GLO-BUS backlog is retained as unverified, outside the overdue count; future
calendar deadlines are retained. No PASS/protocol, coursework, learning, grants,
schedules or source-watcher state are written by this release. Generic per-agent
scopes and multiple students are [design only](../docs/MULTI-TENANT.md).


November 3, 2026 PASS display repair: the original authenticated dashboard has a
**PASS** tab, an All courses view and six course filters. Open
`/app#pass?course=BUSN5000` for BUSN5000 or `/app#pass` for all courses. Rows list all
retained sessions through Load older pagination, newest save first, with exact IDs,
revision, date and saved time. Open a row for safely rendered stored Markdown.
Tests are excluded by default and explicitly labelled in the test-only view.
This is GET-only presentation over existing `/pass` reads; records, protocol,
connector behavior, grants and storage are unchanged. See the current
[implementation status](../docs/STATUS.md) and its live verification receipt.


Personal product name, October 19, 2026: **Sidekick**. “My Sidekick” refers to Daksh’s existing personal school bridge/account. The separate Sidekick product/deployment project is a distinct system; existing technical endpoint and source identifiers stay in place.

Current PASS status — November 2, 2026: the original Claude connector and scoped
school grant are live. All six GPT startup instruction updates are published and
reloaded. The first real BUSN5000 Catch-Up handoff is record
`111978e9-dcba-4381-9e38-fdf980715724`, revision 1: Claude saved it once, full-text
readback matched the reviewed source packet, and a fresh native BUSN5000 ChatGPT
session independently resumed it. Protocol revision 2 and original history remain.
A separate project namespace is implemented and tested locally only, with no
project deployment, registrations or expanded client access yet. Read
[the current verification](../docs/STATUS.md) and [project contract](docs/project-pass.md).
The older rollout descriptions below remain dated history.

PASS backend support was deployed October 31, 2026: the existing local MCP
adapter can save factual, attributed handoffs through
`/classnote`, discover all retained `pass:` sessions through bounded private
`/pass` reads, and resume by canonical class/session. The existing protocol record
is read through `/pass/protocol` and remains class-neutral. No new tracker or data
migration is introduced. A synthetic save/replay/fresh-process resume passed with
normal sessions, lecture previews, progress and learning preserved. Codex GUI-host
refresh and web-client exposure remain separate: the existing GPT Action schemas
have no PASS operations, and Claude currently has no original Sidekick connector.
See [the contract and remaining rollout](mcp/README.md#pass-progress-and-session-summary).

Gives your six ChatGPT class GPTs a live view of your coursework. When you open one,
it calls this endpoint before it says anything and leads with what's actually due —
read fresh from eLC and Google Calendar at that moment, not from a stale copy.

It also carries what happened in class, and lets a GPT record what you've finished.

**Status: deployed and live** at `https://ijuh2yp6rf.example-subdomain.workers.dev`.
All six GPTs retain their existing bearer integrations. **529 JavaScript and 37 MCP tests pass; 810 checks pass across the full selected repair suite.**

**October 12 repair close, 05:47 UTC:** exact native intake, source-quality boundaries, honest health, reviewed LAND module/change correction and urgent MCP continuation are verified. Native MGMT4280/BUSN5000/LAND source checks passed; final LAND reload verified all eight files after restoring three missing unchanged bundles. The automated uploader now requires exact full inventory/configuration across reloads (14 offline cases; no live helper execution). All 13 coursework/learning partitions remained unchanged at 05:43:14.807 UTC. Material outcomes: 147/153 delivery-verified, four cloud readbacks pending, two source templates; GPT/native queues empty. Login, credits, MCP restart and source-coverage limits remain in [current status](../docs/STATUS.md). December 11 native GPT migration is recorded but unperformed.

Material recovery now uses a durable collector ledger, bounded same-ID source rechecks, independent stage retries and course-scoped text receipts. Collector-only `GET /library/text?course=…&filename=…` confirms full text hashes; `POST /library/text` rejects oversized text instead of truncating and supports identical replay. Library delivery also requires matching Drive document/readback evidence. GPT queue handoff and actual publication remain separate. Systems Bridge reports pending work; historical material verification and Mac/browser/Drive dependencies remain. See [the recovery operating contract](../docs/material-recovery.md) and [current results](../docs/STATUS.md).

The personal teaching framework covers BUSN5000, MGMT4280, MGMT5560, MGMT5850, LAND2510 and BUSN3040 for Fall 2026 only. Separate SQLite records retain bounded qualitative outcomes/help, preferences and recoverable history; no grades, raw answers or transcripts. Shown reasoning is required for method credit. Only correct observed responses count as successful demonstrations; wrong/partial work, guesses, agreement and tutor explanations cannot establish mastery. Exact revision/receipt/readback/retry rules preserve saves and fresh-chat handoffs.

All six tutors are private. On October 11 the remaining five were published with exact reloaded 1.3.0 class-scoped Action schemas and prompts; MGMT4280's existing 7,995-character hardened prompt was not changed. Their files, settings and API Key authentication remain. Seventy isolated native synthetic responses passed bounded review and endpoint audits, covering understanding, first saves, duplicate-free retries, empty-preview native resume and connection/source/policy failures. Separate actual production native GETs returned 200 for the five integrations. Final `2026-10-11T22:25:10.715Z` comparisons preserved existing learning/coursework; new course records remain empty at revision 0. Disposable state/service was removed and test drafts disconnected.

BUSN3040 now has one verified instructor opening/setup announcement bundle. Its authentic eLC shell is accessible, but the syllabus/schedule and all 15 visible modules remain templates; actual lessons, assessment scope and AI policy are unknown. Its updated 7,928-character prompt preserves that boundary. See [BUSN3040 material verification](../docs/busn3040-materials.md). Collected instructor restrictions prevail, including assignment-answer bans where applicable. Current deployment: canonical `a6a28249-c0df-496a-a0e0-3a223b6fccbd`, forwarding alias `1384642d-a714-4e7b-868b-eca53b5f897c`. See [six-course teaching contract and verification](../docs/teaching-rollout.md), [historical BUSN5000 real save/resume](../docs/teaching-pilot.md) and [MGMT4280 receipts](../docs/teaching-mgmt4280.md). Bounded simulations do not establish real retention, arbitrary-answer grading or sustained uptime. Shared personal credentials do not provide student tenancy; UGA deployment and front-end plugin migration remain later work.

The October 10 exam and Google reliability pass reconciles the exact MGMT5560 Test Two occurrence to the instructor's October 19 announcement, preserving its old calendar date and marking the clock time unconfirmed. Recognized course prefixes control labels. The existing Google project is in Production with a fresh Calendar grant; automatic refresh and real delivery passed. Automatic hourly announcement checks are now deployed: a real unattended run checked all six full listings and saved 55 records. Definite news-only date changes are shared across clients, while ambiguous/stale/partial evidence remains visible. Full listing checks require an awake, online Mac with eLC login; RSS fallback covers recent posts only. Sustained operation remains a limit. See the current [implementation status](../docs/STATUS.md).

The [coursework dashboard](https://coursework.example-subdomain.workers.dev/app) now gives each tab its own visible heading, counts and content. Today prioritizes outstanding items; This week and Upcoming group them by date; Optional and Changes have their own summaries. Completed work, report history and assignment-link reviews remain accessible in expandable sections. See [dashboard verification](docs/dashboard-sections.md).

The [system map](https://coursework.example-subdomain.workers.dev/app/system) distinguishes dated setup tests from current monitoring, names class GPT connections explicitly, and checks Drive API access hourly without reading file contents. “No live result” is a monitoring boundary, not a judgment that course sources are unreliable. See [connection evidence](docs/map-connection-evidence.md). The [Drive service-account recovery](docs/drive-service-account.md) now provides live, folder-scoped access to the Fall 2026 library through both bridge hostnames.

> The foundation cutover of **2026-09-05 is live** on both frontdoors. One SQLite Durable Object stores progress, class notes, revisions, history, retry receipts and browser sessions. All 18 reports and 19 class notes were backed up and preserved; eleven user-approved links were imported atomically as reported completions. Seven older reports remain unresolved history. See [live verification](docs/foundation-live-verification.md) and [foundation design](docs/foundation-pass.md). The registered MCP connection and all six GPT Action schemas have since been activated and verified; see [MCP verification](docs/foundation-mcp-host-verification.json) and [GPT activation](docs/foundation-gpt-activation.md).

> **Keep this file current.** It is the document handed to other models when asking
> them to review the system. A stale README produces stale advice, which then gets
> acted on. Last updated **2026-10-12**.

The September 17 [map retry and Clubs pass](docs/map-retries-and-clubs.md) adds real per-service retries, explicit Mac dispatch receipts, animated connections and error outlines, plus working club filters, transcript search/copy/download, source links and sync controls. Existing collector schedules remain intact.

The September 17 [lecture readback repair](docs/lecture-readback-recovery.md) narrows Drive searches to the requested course and reads individual file ancestry without walking the whole library. Exact transcript readback remains required.

## How it fits together

```
                        ┌──▶ eLC iCal feed (deadlines, live)
ChatGPT GPT ──Action──▶ │
   getCourseStatus      ├──▶ Google Calendar iCal feed (live)
   recordProgress       │
        ▲               ├──▶ DO: class notes      (what was said in class)
        │               ├──▶ DO: progress         (what you've finished)
        │               └──▶ KV: note from Claude (what you two last worked on)
        │                         ▲
        └─── reads it all ────────┘
                                  │
Mac (6 PM launchd) ── Cluely export ──▶ POST /classnote
```

Calendars are read **live on every call** — never copied into a database, so there is
no sync lag. The Durable Object stores reported progress and class notes; KV retains Claude's latest note, monitoring metadata and change-detection snapshots. Legacy progress/classnotes KV keys remain unchanged as an archive, not the active record store.

## Routes

The personal dashboard requests `GET /status?view=dashboard`, adding a read-only
`calendar` and `daily_briefing` from the same feed read and progress records.
The default GPT/MCP payload does not include personal agenda additions.
`/app#calendar` opens the month/day view; `/app#today` opens the daily briefing.
Calendar bounds cover whole Eastern days, ten days back through forty-five ahead.
Required-work bounds remain ten back through twenty-one ahead. Calendar dates do
not verify submissions. Exact date corrections follow observed instructor announcements while preserving source dates and evidence; they do not invent a clock time. The existing hourly eLC job checks news before its material cooldown, using complete authenticated listings and bounded private RSS fallback. Edited-source history and coverage receipts live in separate DO tables. Calendar/Today and Systems Bridge show full versus recent coverage, source review and check times. RSS absence never deletes retained source evidence. No separate calendar writer or notification schedule was added.

| Route | Purpose |
|---|---|
| `GET /learning?course=X&term_id=fall-2026` | Private version-2 practice observations, separate assistance/outcome and attempt/success counts, preferences, resume step and recoverable revision metadata. The six explicit course codes are enabled for Fall 2026. |
| `POST /learning` | Revision-safe learning save, preference edit, recoverable topic removal/reset or restore. Never changes assignment progress. |
| `GET /announcements` | Private source snapshot, revision and coverage receipt. |
| `POST /announcements/report` | Existing bearer collector publishes bounded scheduling excerpts with revision/idempotency protection. |
| `GET /status?course=X` | Everything a GPT needs. The main one. |
| `POST /progress` | A GPT records that you finished / started / are blocked. |
| `GET /progress?course=X` | Read completion state back. |
| `GET /changes?course=X` | What moved, appeared or vanished since the last check. |
| `POST /classnote` | Claude pushes a class summary (accumulates). |
| `GET /classnote?course=X` | Read the accumulated class record. |
| `POST /note` / `GET /note` | Single "last note from Claude" (newest wins). |
| `GET /health` | Feed reachability. ±24h window, so `0 events` is normal. |
| `GET /lastcall` | Who last called `/status`, and their User-Agent. |

Private API routes require bearer authentication or a valid browser session. Clean /app and /app/system addresses show a public sign-in shell without private data. Browser sessions use opaque Secure/HttpOnly cookies, exact-origin write checks and revocable sign-out. /foundation/health reports store readiness; /progress/history?record_id=... preserves audit history. Migration endpoints require bearer authentication plus the maintenance header described in the foundation guide.

Exact GET/HEAD `/about`, `/privacy` and `/terms` routes are public static OAuth information pages. They expose no coursework, agenda, notes, account credentials or progress records and execute no scripts or external requests.

## What each GPT gets back

`briefing` (a line it can read to you verbatim), plus `overdue`, `due_today`,
`due_this_week`, `upcoming`, `classes_today`, `other_courses_this_week`,
`optional_this_week`, `optional_ongoing`, `claude_note`, `ai_policy`,
`class_notes`, `progress`, `progress_summary`, `completion_ambiguous`, and `recent_changes`.

## Completion tracking

Calendars know what is **due**. Nothing else knows what is **done** — so the GPTs,
the only thing that talks to you daily, write it back.

```
POST /progress {course, item, status, note}
status: done | in_progress | blocked | not_started   (defaults to done)
```

```
POST /progress {course, item, status, note,
                verification, evidence, submitted_by, reported_by,
                assignment_id, term_id, when_iso, record_id, expected_revision,
                idempotency_key}
```

### Two questions, two answers

Conflating these was the bug. **Which deadline does a report refer to** and **do we
know the work was turned in** are different questions, and an exact title match
answers only the first.

`completion.match_method: source_identity` means a linked report overlaps the current deadline's term/course/source UID and recurrence reference. Initial write resolution records exact wording, a unique alias, or an explicit reference separately. Renames/reschedules preserving source identity retain completion; a new UID reusing the title does not inherit it. Missing or ambiguous identity never clears a deadline. Legacy reports were linked only through the approved migration manifest.

`completion.submission_verification` — what the bridge actually observed:

- **`verified`** — an original submission or full-completion receipt was actually seen; grades alone are not proof. Requires
  `evidence`; `POST /progress` returns 400 without it.
- **`reported`** — a saved completion claim without structured verification evidence. This does not prove nothing was checked; preserve the original note. It is the default for a new `done` item.
- **`not_required`** — there is nothing to hand in (a reading, a setup task). It is
  neither awaiting a receipt nor evidence that one was seen, and it is counted apart
  from both. `verified + awaiting_verification + no_submission_required` partitions
  `completed` exactly.
- **`unknown`** — anything not yet reported done.

`evidence_limitation` states that no *structured* evidence exists. On a pre-2026-09-04
record that is all it can honestly say: the original note may well describe a portal
receipt that was actually looked at. The note is preserved verbatim as
`completion.reported_note` and is never reinterpreted, in either direction. A
historical `done` is never upgraded to verified.

**Omitted fields are inherited only while both the assignment identity and work status are unchanged.** A client that
knows nothing about verification can re-report a `done` item, or edit its note,
without erasing a receipt already on file. Changing the status resets them — evidence
that something was submitted is not evidence about work now back in progress. An
explicit value always wins, so corrections still work.

The compatibility field `completion.confidence` describes identity matching (`inferred` for an initial unique alias, otherwise `confirmed`). It is kept because six GPT configs and the published
Action schema read it. It says nothing about whether anything was submitted.

Work finished but not turned in is **`in_progress`**, not `done`.

### Matching is scoped to the course

A report only clears deadlines in the course it was filed under. Both BUSN 5000 and
MGMT 4280 carry a "Quiz 1", and reporting one used to clear both. A report with no
course lands in **GENERAL**, which reaches only deadlines that belong to no course
(drop/add, advisor meetings) — it is never a wildcard.

**A report matching several deadlines clears nothing**, including several *exact*
matches: a course that reuses a title has two assignments, not one. A write returns 409 with candidate references and saves nothing; the caller must ask which one was meant.
The first version used loose substring matching, so reporting "exam" silently
cleared Exam 1, Exam 2 *and* the final. Never guess a completion.

Re-reporting the same identity updates one persistent record. Send expected_revision (zero for a new record) to reject stale edits and an idempotency_key to retry an uncertain save safely. Record, history and receipt commit together. Older callers without revisions retain serialized last-write-wins for the same record, with history. The old 80-item KV cap no longer deletes active progress history.

## The actionable view

`actionable` is built once, in `status.js`, and is what every client counts from:
the briefing prose, the dashboard KPIs, the dashboard's local answers, the embedded
assistant, the GPT payload and the MCP projection.

```
actionable: {
  scope,
  horizon{},                 // overdue_lookback_days 10, due_window_days 7, upcoming 21
  scoped_next_7_days{},      // the ONLY true seven-day figure for this course
  outstanding[],             // what is genuinely left, urgent first, each tagged with its bucket
  awaiting_verification[],   // reported done, no receipt seen
  verified_submissions[], no_submission_required[],
  completed[], blocked[], ambiguous[], unmatched_reports[],
  counts{}, coverage{}
}
```

`outstanding` spans overdue (10 days back) through upcoming (21 days forward) and,
in a scoped call, other courses too. There is no single horizon over it, so there is
no `horizon_days` — a seven-day claim comes from `scoped_next_7_days`, which counts
only `overdue`, `due_today` and `due_this_week` in the requested course.

The raw `overdue` / `due_today` / `due_this_week` / `upcoming` /
`other_courses_this_week` lists still carry every deadline, completed ones
included, so history stays available. They are the record; `actionable` is the
answer. Before this existed the dashboard filtered completed items out of its
counters while the briefing listed them as overdue and then told the model to
ignore them — three clients, three accounts of the same day.

`coverage.feeds_status` is `ok`, `degraded` or **`unknown`**. Unknown means no feed
health was reported at all, so it is not confirmed the calendars were read — that is
not a clear week, and the briefing, the dashboard and the assistant all say so before
answering. Missing information counts as unknown, never as a passing check.

`coverage.submission_sources_checked` is `false` and stays false until collector
freshness and per-source scope are projected into status (milestone 2,
`../docs/PRODUCT.md`). The Worker reads calendars; the existing Mac collectors
now observe bounded original submission receipts and write individual verified
progress through the same revision/idempotency/readback contract. Four LAND2510
receipts passed live verification on October 10. Their evidence does not establish
full coverage of other requirements or courses.

## Change detection

Calendars show today's deadlines but never say what they used to be, so a professor
moving a date is otherwise invisible. Every `/status` call snapshots the full deadline
set, diffs it against the previous snapshot, and logs anything that **moved**, was
**added**, **removed** or **renamed**. The briefing leads with it:

> CHANGED since the last check: LAND2510 "Quiz 01 _Origins" moved from Sat, Aug 22 to
> Thu, Aug 27. Tell him about these before anything else.

Identity comes from the iCal UID, falling back to course + normalised title.

**Not crying wolf is the hard part.** The fetch window slides forward daily (10 days
back, 45 forward), so items constantly fall off the back and appear over the front.
Those are not changes. Every snapshot stores the window it was taken with, and an
add/remove only counts when the item sits inside *both* windows and so genuinely
should have been visible in both.

Two more guards: the diff is skipped entirely when any feed failed, because an outage
looks identical to every deadline being deleted; and the log deduplicates, so the same
move is never reported twice. Kept 21 days, capped at 40 entries.

The snapshot always covers **all** courses even on a scoped request — diffing only the
requested course would read every other course as deleted.

## Class notes

`POST /classnote` **accumulates** — unlike `/note`, which overwrites — so the GPTs
carry the arc of the semester rather than only the last lecture. Per-course rolling
display, capped at 14 entries / 18,000 chars. Older sessions remain retained. Re-pushing the same `session_id` updates in place; revisions and retry keys are supported.

Fed automatically by `~/Claude/school-system-suite/meetings/bin/daily.sh` at 6 PM, which exports
new Cluely lecture recordings, files them to Google Drive, and pushes a condensed
~1,100-char summary per class here.

### Nothing reaches a GPT unverified

Cluely's summary is not evidence. It records one file per *recording window* rather
than per meeting and mixes the room mic with system audio, so whatever is playing
through the speakers is transcribed as part of the class; and its summariser will
assert things the transcript never contained. Both have already put false material
in front of the GPTs:

- **25 Aug, MGMT 5850.** The first 15 minutes of the recording were a college-admissions
  podcast. Cluely summarised it as class content and produced "Action Items for Daksh"
  telling him to pick an extracurricular for his college applications.
- **24 Aug, MGMT 5560.** The summary reported that the class "looked up *what is KV in
  Cloudflare*" and gave the instructor's email address. Neither string occurs anywhere
  in the transcript — that was the KV debugging session bleeding into the summary.

`~/Claude/school-system-suite/meetings/bin/verify.py` now gates every push. It splits the recording
by audio channel to find stretches that are not the class, then discards any summary
bullet that the class portion of the transcript does not support — by word coverage,
by named entities (an email or product name appearing nowhere in the transcript), and
by whether a bullet is better explained by the foreign audio than by the lecture. A
transcript that does not look like its course at all is **held**, not pushed, because
that is a filing error no trimming can fix. `daily.sh` reports what was trimmed rather
than cleaning silently.

Two things it cannot fix, so treat them as known-bad inputs: speaker labels are
useless (in an in-person lecture ~NN% of turns are tagged with Daksh's name even when
the professor is the one talking), and the ASR mangles proper nouns.

### Concurrent class-note writes

The prior KV read-modify-write race was fixed in the 2026-09-05 foundation cutover. Each write now commits in the shared SQLite Durable Object with history and an idempotency receipt. Distinct concurrent sessions survive. The existing collector's client-side spacing remains unchanged, but correctness no longer depends on it.

## Optional and ungraded work

Instructors only put *graded* deadlines in eLC, so readings, videos, podcasts and
ungraded practice sets appear in no calendar anywhere. They live in `src/optional.js`,
transcribed from the syllabi, and the GPT is told to raise them unprompted and ask you
one at a time whether you want to do them.

Some optional items still carry points — the BUSN 5000 Progress Check is worth +5, and
MGMT 5560's end-of-chapter quizzes in the GLO-BUS e-text are extra credit. Those come
back with `graded: true` and the briefing calls them out separately.

| Course | Optional work tracked |
|---|---|
| BUSN 5000 | Full — every week's reading, IRL link and ungraded homework, plus the Progress Check |
| MGMT 5850 | Full — Gerhart chapter per week from the syllabus table |
| MGMT 4280 | Per-topic eLC overview articles, anchored to the assignment weeks |
| MGMT 5560 | Standing rules only. Hill posts the reading schedule on eLC and in GLO-BUS, not in the syllabus |
| LAND 2510E | **Not tracked in `optional.js`** — though the syllabus and all lecture material are now in that GPT's Knowledge |
| BUSN 3040E | **Not tracked** — shell opens ~Oct 5 |

The last two return `optional_not_tracked`, so the GPT says readings aren't tracked
rather than implying there are none.

## AI policy

MGMT 5850 and MGMT 5560 forbid AI-generated assignment work, so their payload carries
`banned-on-assignments` and the briefing tells the GPT to help you study rather than
draft the deliverable. BUSN 5000 and MGMT 4280 permit it.

If a calendar feed is unreachable, `data_warning` is set and the GPT is told to say the
list may be incomplete — a broken feed must never look like a clear week.

## Routines

Every background job on this machine is declared in `routines/routines.json` and
controlled from here, because they are one system: the eLC sweep feeds Drive and the
GPT knowledge bases, the Cluely sync feeds `/classnote`, and the health check watches
the endpoint the other two write to. They used to be six hand-written plists with
their schedules buried inside them and their logs in six places.

```
routines/routinectl status          what ran, when, and whether it worked
routines/routinectl list            schedules and what each job is for
routines/routinectl run <id>        run one now, in the foreground
routines/routinectl install [<id>]  (re)write and load the launchd plists
routines/routinectl logs <id>       tail that job's log
```

`install` generates the launchd plists from the registry, so a schedule is edited in
one file and nowhere else. The plists that existed before this are kept under
`routines/plist-backup-*/`.

| Routine | When | What |
|---|---|---|
| `elc-daily-sweep` | hourly | New/changed eLC material → originals to Drive, text to the GPTs |
| `bridge-health` | hourly at :35 | Is the bridge answering, and does it still accept writes |
| `cluely-gpt-sync` | 18:00 | Class recordings → Drive + context-checked notes → `/classnote` |
| `globus-watch` | hourly | MGMT 5560 GLO-BUS decision rounds and deadlines |
| `desktopcleanup` | Mon 04:07 | Files loose Desktop clutter |
| `rentcheck` | 1st & 4th 09:07 | Verifies rent posted; self-retires July 2027 |

All of it runs locally under launchd. None of it can move to a cloud routine — every
job needs the filesystem, Chrome with a live eLC session, or the Drive mount.

The eLC sweep and the GLO-BUS watch fire hourly but do nothing unless Chrome is up
with a live eLC session, so a multi-hour gap overnight is normal. Their staleness
threshold in the registry reflects that; the others use six hours.

### `/status` trips Cloudflare's resource limit under bursts

The first request after the isolate is evicted, and any request arriving a few seconds
after another, can come back as a bare `error code: 1102` — Cloudflare's Worker CPU
limit, not the KV limit (`1101`) described below. Isolated calls are reliable; four
probes back to back reliably failed two of them. Normal use is one `/status` when a GPT
opens, so this is mostly invisible — but opening several GPTs in quick succession can
hit it, and it is why `health_check.sh` spaces its probes 15 seconds apart and checks
one course per run on rotation rather than all six. A health check that induces the
failure it reports is worse than none.

## The KV write budget

Cloudflare's free tier allows **1,000 KV writes a day and 100,000 reads**, counted
per account and reset at **00:00 UTC (8pm ET)**. Writes are the scarce resource, and
on 24 Aug 2026 they ran out: from mid-afternoon every POST failed while every read
kept working, so the GPTs went on answering normally, the eLC sweep reported "new
material found" for a note that was never stored, and the 6pm Cluely push of that
day's MGMT 5560 class notes was refused. All of it surfaced as a bare
`error code: 1101`, which named nothing.

Note the reset time: the Cloudflare "day" starts at 8pm ET, so an evening of
development spends the quota that the *next* afternoon's alerts need.

Four things now stand between that and a repeat:

1. **Every remaining KV write goes through `kvPut()`**, which logs `KV_PUT ok key=… reason=…`.
   There was previously no way to tell what had spent the quota. To watch it live:
   `npx wrangler tail --format pretty | grep KV_PUT`
2. **A spent quota answers `503 kv_write_limit`**, not a 500. Callers can tell
   "come back after 00:00 UTC" apart from "this is broken" — `push_notes.py` exits
   2 for it, and `daily.sh` reports *deferred* rather than *failed*.
3. **`lastcall:*` is rewritten at most hourly.** It used to be written on every
   `/status` call, and the GPT instructions say to call `getCourseStatus` at the
   start of every conversation — so the write rate was set by how much studying he
   did that day. Worst case is now ~170 writes/day across all courses.
4. **The deadline snapshot is sorted by key** before it is compared. The comparison
   decides whether to spend a write, so any instability in feed ordering would have
   read as "the deadlines moved" on every request. `diffSnapshots` keys everything
   by id and ignores order, so the sort costs nothing.

Reads are deliberately never guarded: a spent write quota must never stop a GPT
answering "what is due?". There are tests for that.

## Known limits

These are real and worth remembering before designing around them:

- **GPT Actions do not run in ChatGPT voice mode.** Neither do image generation or data
  analysis. In a voice conversation the GPT cannot reach this bridge at all and will
  fall back on guessing. Knowledge files *do* work in voice — so anything that must
  survive voice belongs in Knowledge, not behind the Action.
- **eLC content beyond the calendar needs a login.** The iCal feed is unattended, but
  files, announcements, grades and submission status sit behind UGA MyID + Duo. No
  architecture fixes MFA; those sweeps need Daksh signed in.
- **Submission coverage is bounded.** Since October 10, the owned eLC, GLO-BUS
  and Gradescope collectors can reconcile explicit original receipts into verified
  progress. eLC's own quiz-results fallback is partial; GLO-BUS exercise review
  routes are limited to audited sources, and absent terminal proof stays unknown.
  Scores, view/review icons and deadline expiry cannot clear coursework. Records
  reported by Daksh remain reported unless stronger original proof is observed.
  Differently named module mirrors require their own mapping or evidence. The
  new receipt stages still need their first observed scheduled cycle, and global
  `actionable.coverage.submission_sources_checked` remains false while detailed
  collector freshness is not projected into that field.

## Development

```bash
npm test              # 224 tests, no network required
npm run test:mcp      # 27 MCP contract tests, offline, stdlib only
npm run test:all      # both
npx wrangler dev      # run the Worker locally
node scripts/build-openapi.mjs        # regenerate src/openapi.js from the YAML
node scripts/build-instructions.mjs   # regenerate loaded/v2 from loaded/
```

`build-openapi.mjs` shells out to `python3 -c 'import yaml'` and the system python3
has no PyYAML. Run it as `PATH=/opt/anaconda3/bin:$PATH node scripts/build-openapi.mjs`
— the same interpreter the collectors need.

Test coverage includes UTC and `TZID` parsing, weekly recurrence, `EXDATE`,
`RECURRENCE-ID` overrides, `CANCELLED` events, D2L's Available/Due triples, feed
retry and hard failure, auth on every route, note/classnote/progress semantics, and
the **daylight-saving boundary** (US DST ends Nov 1 2026, mid-semester — an 11:59 PM
Eastern deadline is UTC-4 before it and UTC-5 after).

Change detection has its own suite: UID identity, moved/added/removed/renamed, the two
window-slide false-positive cases, outage suppression, log dedupe and retention.

Completion has its own suite too — `test/completion.test.mjs`, on a fixture built for
it (`DUP_TITLE_FEED`): one title shared across two courses, one title reused twice
inside a course, and one deadline belonging to no course. It covers the course
boundary, same-course ambiguity, GENERAL, match-method vs submission evidence, legacy
records, and the agreement between the actionable counts and the actionable lists.

`mcp/test_school_bridge_mcp.py` covers the adapter contract with in-memory fixtures
and no network: upstream errors staying errors, an empty-but-valid response staying a
success, warnings and coverage surviving the projection, and an oversized payload
remaining parseable with a continuation that actually returns the missing records.

Malformed calendar framing/start dates, bounded stalled/oversized feeds and sanitized private-URL errors now have regression coverage. Still limited: the same assignment appearing in both feed namespaces and adversarially similar course codes. Note that
change detection assumes a professor's edit preserves the iCal UID; if D2L reissues UIDs
on edit, a move would show up as a remove plus an add rather than a move.

## Gotchas that have cost real time

- **`src/openapi.js` is GENERATED.** Edit `gpt-action-schema.yaml` and rebuild. Editing
  the JS directly is how the served schema drifts from the repo.
- **ChatGPT caps an operation `description` at 300 characters.** Over that it rejects
  the whole document and the action silently never appears. `redocly lint` does *not*
  catch this — check description lengths after editing the YAML.
- **A GPT's Action schema is a frozen snapshot**, pasted at import time. ChatGPT never
  re-fetches the imported schema URL, so deploying a new Worker version does nothing for
  GPTs that are already wired. They must each be updated.
- **The editor's Update button often no-ops** right after an upload, while Knowledge
  files finish processing server-side. Wait, click again, and verify "Updates pending"
  actually clears — do not assume the first click worked.
- **Cloudflare returns error 1010** to `Python-urllib`'s default User-Agent. Any script
  calling this Worker must set its own `User-Agent`.
- **`/lastcall` stores only the most recent call per course**, so testing with `curl`
  overwrites the evidence of whether a GPT really called in. Don't probe `/status`
  casually.

## Maintenance

- **New semester**: plan a reviewed term rollover for the active record store as well as editing `src/courses.js` and schema enums. Changing the term constant alone is not a storage migration.
- **Course codes** are matched loosely against each event's summary, location and
  description, so `GP_BUSN5000` and `BUSN 5000` both resolve. An event matching nothing
  shows up under "All courses" rather than being dropped.
- **Rotating the key**: `wrangler secret put API_KEY`, then update `.env` and the
  Authentication panel in all six GPTs.

## Setup reference

Historical initial setup, kept for reference. A fresh store also requires reviewed foundation initialization; do not replay initialization against existing records.

```bash
npx wrangler login
npx wrangler kv namespace create NOTES     # id goes in wrangler.toml
npx wrangler secret put API_KEY            # long random string
npx wrangler secret put FEED_ELC           # eLC → Calendar → Subscribe → iCal URL
npx wrangler secret put FEED_PERSONAL      # Google Calendar → Integrate → secret iCal
npm run deploy
cp .env.example .env                       # WORKER_URL + API_KEY, chmod 600
```

Both feed URLs contain a private token — they go in as secrets, never into a file.
The eLC feed is read directly rather than through Google's copy, because Google only
polls subscribed calendars every few hours and that lag would stack on top.

Wiring a GPT: Configure → Actions → **Import from URL** using
`/openapi.json` (after the credential-free entry patch is deployed). Never put an
access key in the URL. Never paste into the Schema textarea — that has failed
repeatedly. Authentication is a separate panel: API Key → **Bearer**.

## Clubs extension — September 16, 2026

The authenticated [Clubs page](https://coursework.example-subdomain.workers.dev/app/clubs) and system-map Clubs node cover AI Society at Terry and OpenAI Student Collective UGA. GET /clubs returns source/publication receipts and session metadata; GET /clubs/session?id=... returns raw timestamped transcript text; GET /clubs/search?q=... searches concepts with excerpts and pagination. Bearer-only POST /clubs/session, /clubs/sync, and /clubs/project require expected_revision. Stable session IDs, content hashes, and synchronous transactions make retries idempotent and reject stale corrections. Joint sessions have two tags and one record. Separate club tables reuse the existing Durable Object; course progress/classnote tables are unchanged.

The existing exporter recognizes explicit club title aliases. meetings/bin/club_sync.py builds the local project source, publishes and exactly reads back each transcript, tests concept search, and writes a manifest. The existing daily job calls it; existing Codex oversight/weekend GroupMe routines handle native export/project publication when needed. No schedule or credential was added. GroupMe's calendar ledger supplies event references, not raw group chats. ChatGPT sources are snapshots: matching bundle hash plus observed project retrieval is required to clear publication status. System-map telemetry contains no transcript content.

Local project folder: /Users/Daksh/Documents/Codex/Projects/UGA clubs. Native Codex project registration remains a user UI step because computer-use cannot control its own app. The project runbook preserves this limitation.
# Private learner profile

`/app/profile` shows separate question observations, quantitative aggregates,
evidence-linked hypotheses with student controls, spaced retrieval reviews and
private reported/owner-eLC-verified outcomes. Selected Wispr intake creates a new
dated sourced PASS; deployment never selects notes. Owner REST/MCP tools and
their exact schemas are documented in `/agents/contract` and
[LEARNER-PROFILE.md](../docs/LEARNER-PROFILE.md). Existing school/project scoped
grants are unchanged and do not authorize this new layer. No credentials, real
practice, grades or PASS records are created by deployment.
