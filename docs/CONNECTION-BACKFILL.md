# Approved school learner access and BUSN5000 PASS backfill

Daksh explicitly authorized these two changes on November 3, 2026. The existing
school credentials remain in place. No new key, renewed expiry, project/Wispr
permission, owner administration, grade verification or coursework permission is
granted. Existing PASS save/read responses and protocol revision 2 are preserved.

## Existing connections

The single original Claude school grant can opt into the fixed learner scope
bundle through owner-only `POST /pass/connection/enable-learner`, with its existing
nonsecret grant digest and the exact recorded approval ID. This writes capability
metadata beside the existing session, never a token, session or expiry. An inactive,
expired, revoked, differently scoped or different grant fails closed. An identical
enablement replays; revoking the original grant revokes its learner access too.
Other existing/future grants retain their original seven-tool school surface.

The approved extension exposes practice save/read, hypothesis reads, explicit
student-instructed status relays, retrieval-review reads and reported grade
save/read. It does not expose Wispr intake, historical imports, original-eLC grade
verification, review settings, outcome-suggestion approval, project data or
credential administration. Scope checks occur at discovery and execution.

`set_hypothesis_status` requires exact course/ID/status/revision/key plus the
student's actual instruction, source/message reference and recording agent. It is
consequential and requires per-call approval. It records `student_via_agent` and
the instruction, not an inferred decision. Access approval is never permission to
confirm a particular hypothesis; backfilled hypotheses remain open for Daksh.

Nine additive learner Actions and stdio schemas use the existing ChatGPT school
authentication. Every old Action operation, server, security component and schema
remains semantically unchanged. The generator retains importer description limits.
The six existing school GPT Actions were updated and privately published in place;
their authentication/keys were neither read nor replaced. Each additive learner
operation requires that GPT's own course. Independent reloads preserve the original
eleven-operation hashes, servers, security and components. Fresh read-only tests
passed in all six GPTs and the original Claude school Project. Those client
readbacks are separate receipts, not inferred from a deploy or config save.

## BUSN5000-only historical import

The owner-browser-only import accepts exactly the three user-selected revision-1
PASS records, in fall-2026. It checks source anchors and source lines against
their actual saved text, and requires each verbatim student quotation, retained
answer summary, correctness marker and help marker to occur in the source.
The original records are checked again after asynchronous hashing and remain
read-only. There is no general arbitrary history import tool for agents.

One stable receipt/event identity yields one backfilled observation. Separate
attempts are separate records only when the source distinguishes them. An answer
that changes within one assisted reply remains one reply with multiple quotations.
Source-only worked explanations without an observed student response are not
student attempts. Ambiguous/missing response attribution is explicitly reported
as a gap, not fabricated. Missing options and correct answers stay null; missing
verbatim answers use a labeled retained summary. Missing correctness stays
unassessed; missing help stays not retained. No regrading from subject knowledge.

Every imported observation has `backfilled=true`, the user's required recording
agent, the source PASS ID/revision, its own source line/anchor, receipt saved time
and original event-time range where retained. No exact answer timestamp is invented.
`answered_at` is explicitly labeled as the source receipt's saved timestamp;
practice-day trends use the receipt's stated session date. Live confidence-before-
answer safeguards are unchanged; the separate import never pretends to have a
live pre-answer confidence receipt. Confidence is always null/not stated, so all
backfilled observations are excluded from confidence/correctness calibration.

Unassessed answers never count as misses. The ordinary engine adds quantitative
repeat-error patterns for structured question-topic tags, alongside its existing
distractor/calibration patterns. It uses only explicitly recorded incorrect items,
not answers merely followed by an explanation. All engine-generated patterns
start open and retain exact evidence IDs. No handwritten hypothesis enters the
import. There is no inferred mastery or free-text student judgment.

The separately stored Exam 1 outcome is a student report, with the retained
percentage quotation and exact user-report source line. Percentages are represented
on a 100-unit percentage scale, not fabricated exam point totals. The assessment
date is unknown; the timestamp is explicitly the source receipt saved time.
It is not verified, and it is not automatically linked to hypotheses from later
practice without evidence of assessment alignment.

Items, the reported outcome, engine results, revision history and operation receipt
commit in one transaction. An exact retry replays; changed data under the same key
conflicts. Import rollback leaves no partial items/grade/hypotheses. The Profile UI
labels every backfilled row, source gaps, confidence exclusion and reported grade.
The private operator packet and real source text stay outside the source-only
engineering checkout and source allowlist. Actual student grade values and answer
payloads are not embedded in implementation source.

Deployment, existing-grant enablement, the real import and fresh reads from Claude
and the six ChatGPT clients each require their own verified outcome. Refer to the
task's `connection-backfill-result.json` for those receipts and exact counts.
