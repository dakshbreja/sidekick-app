# School companion — product direction and milestones

Written 2026-09-04, from the Codex handoff at
`~/Documents/Codex/2026-09-04/t/outputs/claude-school-companion-brief.md`.
This file holds the intent and the roadmap. Current implementation state lives in
[STATUS.md](STATUS.md); the engineering rules that must not be broken live in the
root `CLAUDE.md`.

## What is being built

A school companion that answers four questions about Daksh's own coursework:

1. **What changed?** — a deadline moved, an assignment appeared, a feed went dark.
2. **What do I need to do?** — what is genuinely outstanding, in priority order.
3. **Am I finished?** — a bounded answer, with the scope and the horizon named.
4. **What do I need to learn?** — taught from his actual course material.

The bridge is the shared state service underneath all four. Its first success
condition is that every client — the six class GPTs, the `/app` dashboard, its
embedded assistant, and the Codex MCP adapter — gives the same answer to (1)–(3).

School logistics and learning are the scope. Subscriptions, other universities and
student onboarding are later, and only after this personal system is demonstrably
reliable for one user.

October 10 personal increment: the existing Google Calendar/eLC month and day view
and in-app daily briefing are deployed. UGA work remains deferred; the personal learning pilot below is now activated.
The reviewed MGMT5560 exam date now follows the instructor's October 19 announcement,
with its clock time explicitly unconfirmed. The existing Google project is in
Production with a renewed grant and verified automatic refresh and delivery.
Automatic hourly announcement checks now collect full source listings, with bounded recent-feed fallback and explicit ambiguous/stale coverage. Mac/browser availability and sustained operation still limit unattended reliability. Production is not Google verification or UGA
launch readiness. See the current section in STATUS.md.

October 10 completion increment: original submitted/completed receipts now feed
the existing exact-identity progress contract from the owned collectors. Four
LAND2510 source receipts were saved and verified. Partial or unsupported source
coverage stays unknown, and the new unattended receipt stages still need their
first observed scheduled cycle. Calendar module mirrors cannot be cleared merely
because a similarly named quiz is complete.

The October 10–11 learning increments activate all six existing class GPTs as private Fall 2026 tutors. Current status/materials, diagnostics, explanations, original practice and separate qualitative learning handoffs are shared framework components, while course teaching style and original assessment rules remain scoped. Assistance and correctness are separate; wrong/partial work cannot count as successful understanding. Personalization uses observed practice, selected preferences and saved next steps, not automatic access to other conversations.

BUSN5000's earlier real save/resume remains verified. The October 11 remaining-five rollout passed 70 bounded isolated native response cases, with first saves, exact replay, empty-preview Action resume and failure recovery. Exact prompts/schemas were privately published and production native read access checked. Existing records/coursework were preserved; newly enabled course records remain empty. BUSN3040 now has verified opening/setup guidance, while its actual syllabus and lessons remain templates; source scope and AI permission stay explicit. Fake connection sessions establish no learner evidence or retention. The current /ask status chat remains unchanged. Further real learning measurement, front-end plugin migration and community tenancy remain separate work. See [current six-course rollout](teaching-rollout.md), [BUSN5000 historical pilot](teaching-pilot.md) and [MGMT4280 receipts](teaching-mgmt4280.md).

## Milestones

### 1. Reliable status across clients — DEPLOYED, client activation noted below, 2026-09-04

The bounded slice: make the shared state trustworthy and identical everywhere.

- Course-scoped completion matching, with same-course ambiguity handled.
- Assignment matching separated from submission verification, with provenance.
- One `actionable` view consumed by briefing, dashboard, assistant, GPT payload
  and MCP.
- An MCP response contract that cannot turn an outage into an empty success or
  cut JSON mid-token.

See [STATUS.md](STATUS.md) for exactly what landed and what still needs activating
in each client.

### 2. Make "Am I done?" answerable — NEXT

Return a bounded verdict rather than a list: `action_needed`, `clear_for_scope` or
`cannot_confirm`, each with a time horizon, a course scope, the source coverage
behind it, the reasons, and next steps. A model may explain the verdict; it must
not invent it.

"Clear" requires **both** no outstanding required work in the horizon **and**
sufficiently recent checks of the sources that claim depends on. A 200 from the
Worker proves the Worker is up. It does not prove the Chrome collection jobs ran,
or that announcements, submission pages and lecture material were looked at.
Missing health information counts as unknown, never as clear.

Work involved:

- Bring collector health in from `~/Claude/routines` (`routinectl` is the registry;
  inspect the existing scheduled handlers before adding any job). Record
  `last_attempt_at`, `last_success_at`, outcome, which courses and data types were
  covered, and the reason for any gap. Keep the last successful observation when a
  run is skipped or fails.
- A morning briefing naming classes, required work, meaningful changes and
  collection gaps. If notifications are added, agree the destination first and do
  not repeat an unchanged state.

Target behaviour:

> Two classes today. One required assignment remains. Your team reports that SQL is
> submitted; I have not verified the group receipt. GLO-BUS could not be checked
> because its browser session expired.

### 3. Durable assignment identity and reliable writes — DESIGN FIRST

Deliberately not merged into milestone 1.

- Give assignments identities scoped to course and term, keeping source IDs and
  aliases, so matching stops depending on title text.
- Resolve conflicting deadlines by source authority and observation history — not
  by title similarity and not by an unexplained confidence percentage. The live
  payload carries GLO-BUS entries at different times; keep the disagreement until
  the source itself resolves it. A conservative reminder time is fine; overwriting
  a conflicting deadline as though it were verified is not.
- `POST /progress` read-modify-writes a whole per-course list
  (`bridge/src/worker.js`), and `/classnote` has the same shape. KV is eventually
  consistent (~60s) with no atomic transactions, so two writers inside that window
  can silently revert each other. A batch endpoint does not serialize independent
  writers. Evaluate a small authoritative transactional store, or a serialized
  writer, with idempotency keys and explicit corrections, before promising reliable
  simultaneous updates from several assistants.
- Acknowledge and retry failed writes; reconcile against the source later. A
  reporting instruction in a prompt does not survive a missed report.

Reference: https://developers.cloudflare.com/kv/concepts/how-kv-works/

### 4. Learning companion — AFTER STATUS IS DEPENDABLE

Connect "teach me what I learned today" to the retrieval that already exists:
`/library` and `/library/doc`, the verified lecture notes, slides and readings.
Answers identify the course material behind them and separate what the instructor
emphasised from the assistant's own inference. Practice results are tracked apart
from submission status — turning something in is not evidence of mastery.

### 5. Observation period, then a small student pilot — LAST

Before anyone else uses this, run a defined observation period with independent
source spot-checks, recording missed obligations, false overdue reminders, hidden
collection failures, and any place two clients disagreed. Only then: onboarding,
isolated accounts, a second university.

## Boundaries that hold across every milestone

These are not stylistic. Each one is a decision with a reason behind it, and
changing one needs a concrete cause and a migration plan, not a refactor.

- Calendar feeds are read live on every call. No deadline is cached into KV.
- Scores never enter the bridge. Grades stay local and go to the private repo.
- The Cluely verification gate (`meetings/bin/verify.py`) stays in front of every
  class-note push.
- Schedules change in `routines.json` via `routinectl`, never by editing a plist.
- Credentials stay out of generated documents and logs.
- Matching an assignment is not evidence that it was submitted.
