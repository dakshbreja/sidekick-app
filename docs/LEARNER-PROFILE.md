# Learner profile — original private Sidekick

Implemented November 3, 2026. The existing PASS records, protocol revision 2,
seven-tool school MCP, project MCP, coursework and old `/learning` contract are
unchanged. This is a separate private, structured evidence layer on the existing
personal SQLite Durable Object. It is not multi-student isolation.

## Interface and access

The live schema and startup instructions are in public `/agents/contract` under
`learner`. The schemas contain no student data. Human view: `/app/profile`.
Existing owner authorization protects `GET /learner/profile`,
`POST /learner/tools/{tool_name}` and the separate `POST /mcp/learner` adapter.
Existing supported owner adapters can call these without issuing a credential.
Do not distribute the owner key to a new client. The original `sp1` school and
`pp1` project grants are not expanded and cannot access this layer. Activation in
an additional scoped client requires separately approved, secure provisioning;
no such credential is created by this release. No open signup or invitation
issuer is added. `/app/settings` currently opens the same profile/review settings,
not a complete account-management product.

Agent tools are `capture_wispr_note`, `start_practice_item`,
`answer_practice_item`, `read_practice_items`, `read_learner_profile`,
`save_grade_outcome`, and `read_grade_outcomes`. There are no agent hypothesis
decision, verified-grade, reset, delete or administration tools. Agent startup
instructions explicitly call hypotheses hypotheses, never facts or mastery.
The six class instruction source files preserve their prior teaching and PASS
requirements, adding the hypothesis warning within the 8,000-character limit.
External publication is a separate receipt, never implied by source changes.

Normal reads default to real records; `sandbox=true` selects only synthetic
records. Exact item/outcome reads require an exact course. Term is `fall-2026`.
List items use `limit` (1–100, default 50) and `offset`; follow `next_offset`.
The returned aggregates, hypotheses and review items use the whole selected
scope, not just the visible item page. Source IDs/revisions remain explicit.

## 1. Selected Wispr capture

The recording agent uses its existing authorized Wispr connection to pull the
specific scratchpad ID with `get_scratchpad_note`, paging its selected text if
needed; shared links use `resolve_share_link`. Do not scrape a shared-link page.
No server Wispr token, all-note search, background ingestion or schedule is added.
This release implements on-request capture. A future scheduled pull needs a
specific selection and schedule authorization, not implicit all-note permission.

The capture packet requires course, note ID, source creation/update timestamps,
title, selected text, author `Daksh`, content kind, an explicit authorization
reference, `specific_note_authorized=true` and recording agent. Maximum selected
text is 2,500 characters; the final PASS must fit 4,000. Oversize content fails;
it is never silently truncated. Use `student_authored_note` for his own note.
`shared_note_excerpt` additionally requires the original `source_author` and
exact `https://notes.wisprflow.ai/shared/...` URL. A shared excerpt records the
fact Daksh selected that source, without claiming he wrote it. Flow-generated
summaries and ambiguous authorship cannot be represented as his own notes.

The new dated PASS quotes the selected text as a report, not verified truth,
mastery or instructions to the agent. It retains note ID, revision timestamp,
source author/link, selection authorization and capture agent. Grades and secrets
are rejected here; grades belong only in outcomes. Capture reads the protected
protocol first, creates a new session via the established transactional record
route, then matches the receipt and exact readback. It never edits an existing
PASS or the protocol. Course + real/test + note ID + source update time define a
stable capture identity and idempotency key. Repeating it returns the original
receipt. Changed content with that same source revision conflicts; fetch the
actual updated note, never invent a revision. Deployment does not select a note.

## 2. Observations and computed aggregates

Two saves enforce ordering. First call `start_practice_item` with the actual
question, options and tags, source material ID/revision/HTTPS link, session ID,
student-stated confidence (0–100, or null if not stated), its timestamp and agent.
The server seals this packet and returns revision 1. Read it back before asking
for or accepting an answer. Then call `answer_practice_item` at revision 1 with
the actual chosen option, correct option from a separately referenced answer
source, help level (`none`, `hint`, `worked_example`, `answer_shown`), answer time
and recording agent. The answer cannot predate server receipt of confidence.
Completed items are immutable at revision 2; no retrospective answer/confidence
import or correction-by-overwrite is supported. Record null instead of guessing
confidence. Use a fresh item for a new attempt.

Only structured fields are accepted. No agent judgment or misconception prose
field exists in observations. Correctness is exact option-ID comparison, not a
claim of understanding or independent success. Assistance is retained separately;
aggregates currently include all help levels. Distractor tags describe options,
not a diagnosed student trait. Compute counts of misses by selected tag,
confidence-bin accuracy/mean stated confidence, unknown-confidence count, and
per-course daily attempted/correct counts from recorded answers. No inferred
mastery score or personality profile is stored.

## 3. Hypotheses and student decisions

Two matching observed misses or calibration events create a quantitative template
pattern: repeated selected distractor tags, incorrect responses with confidence
at least 75%, or correct responses with confidence below 25%. A hypothesis keeps
its exact immutable supporting item-ID snapshot, source-evidence date, confidence
tag, creation time, revision and status. Initial status is open/not yet set.
Evidence snapshots are frozen, so a student decision cannot silently transfer to
new evidence. At most one snapshot per course/scope/pattern is created in v1;
later responses still update aggregates. A provisional tag denotes a small
sample, never a psychological conclusion. No claim about a student follows from
two examples alone.

Only the signed-in student browser, with same-origin protection, can POST
`/learner/control` using `action=set_hypothesis_status`, exact course/scope,
`hypothesis_id`, status `open|confirmed|rejected|ignored`, current
`expected_revision` and stable `idempotency_key`. The Profile UI offers
Confirm/Reject/Ignore/Reopen. Neither a bearer agent nor MCP tool can do this.
Confirmed remains a student-approved hypothesis, not a fact or protocol change.

## 4. Spaced retrieval

Default interval is seven days per course; the student can set 1–90 days through
Profile. `GET /next-actions` and dashboard Today read the same `reviews` array.
An open hypothesis becomes due based on its latest supporting attempt date. A
session with at least two answers and at least half incorrect also provides a
dated quantitative review anchor when no open pattern already covers it. PASS
prose is not mined for weaknesses; no old learning record is rewritten. Review
entries link the exact practice receipts and explicitly instruct retrieval before
hints/re-explanation. Deadlines keep their existing `priority_order`; review IDs
are separately ordered in `review_priority_order` and appear beneath the pinned
hard deadline on Today. Reviews are not coursework deadlines or overdue counts.

A started review attempt can name its exact currently due `review_of` ID. A
completed answer restarts that target's interval without changing old evidence,
hypothesis status or coursework. Unavailable practice storage is explicitly
unknown, not proof that there is nothing to review. Sandbox reviews never enter
normal Today or agent priorities. `?preview=sample` on Profile and
`/app?preview=learner#today` demonstrate clearly labeled synthetic UI data in
memory, with no writes or claims of real student practice.

## 5. Grade outcomes

`save_grade_outcome` stores assessment ID/name/date, earned/possible values,
student reporter and exact same-course hypothesis IDs. It always labels them
reported. Verified is unavailable to agent tools. Keep outcomes out of ordinary
PASS, `/status`, `/next-actions`, telemetry and public docs; only private Profile
and explicitly authenticated outcome reads return grade values.

The owner-only original-source import is `POST /learner/control` with
`action=import_elc_outcome`, the same outcome fields, current revision/key and
`elc_read:{source,observed_at,recording_agent,receipt_id,assessment_id,earned,possible}`.
`source` is a versioned material reference with an original
`https://uga.view.usg.edu/d2l/...` link whose exact `ou` identifies the registered
course shell. Assessment and numeric values must exactly
match the original read packet. Only use this immediately after an actual
authorized original eLC read. This is provenance asserted by the trusted owner
source adapter, not an independent server login or cryptographic portal receipt.
No portal collector is run and no login/credential is created by this feature.
An existing reported outcome can be verified at its exact ID/revision; previous
reported data stays in private revision history. No grade is imported in release
verification. If the source needs a credential/approval, stop.

Linked results offer a coarse suggestion: below 60% suggests confirm, at least
80% suggests retire, otherwise insufficient signal. This is an explicit heuristic,
not a validity test of a pattern or assessment alignment. The student checks
the relationship and approves in Profile. Only `apply_outcome_suggestion` via
the protected student control route changes the exact linked hypothesis, with
CAS/idempotency and an outcome decision receipt. Retire maps to ignored while
retaining the decision and evidence. Nothing changes automatically.

## Persistence, limits and recovery

New `learner_entities`, `learner_events` and `learner_receipts` tables coexist
with all old tables. Save, revision history and receipt commit synchronously in
one transaction. One unchanged logical packet/key replays; changed packets
conflict. Capacity per course/term/real-test scope: 2,000 practice items,
100 hypothesis snapshots, 200 assessment outcomes and one review setting.
There is no deletion/reset API or automatic retention purge in v1. Tables and
history are private, with no external model call or raw-data logging. A failed
readback remains unconfirmed: inspect the exact ID/revision or repeat the exact
packet. Never replace private runtime data from a source checkout.

The optional multi-student/per-agent credential system remains unimplemented.
It must not be approximated by sharing existing owner tokens, repurposing a
Claude grant for another agent, or silently widening school/project grants.
