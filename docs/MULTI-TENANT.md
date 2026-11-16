# Per-student and per-agent PASS design

Design only — November 3, 2026. No new tenancy, grants, student accounts, schema
migration or access expansion is implemented by this document. The current
original Sidekick remains a private, single-owner service. Its real records and
protocol revision 2 remain intact.

PASS is the durable product: dated, sourced checkpoints and their immutable
history. `/app` is the person's review window; agent clients share the interface
rather than keeping competing copies of the student's state.

## Identity and permission boundary

Authenticate the student through a supported identity provider. Derive an opaque
student ID server-side; never trust a student/tenant ID supplied in a URL, tool
argument, request body or header as authorization. Every agent grant belongs to
exactly one student and one named agent/client, with an explicit audience, allowed
projects/courses, scopes, issue/expiry times and revocation state.

Proposed scopes:

- `read`: retained PASS/protocol/history and explicitly authorized planning
  metadata, including `/next-actions`; exclude grades, raw transcripts and secrets.
- `write-checkpoint`: read plus sourced checkpoint creation/correction, using
  current revisions and stable retry identity. No coursework completion, learning
  state, submission, protocol editing or deletion follows.
- `admin`: student-controlled client/grant management and explicit retention
  operations. Keep this out of assistant MCP tools and ordinary checkpoint tokens.

Do not retrofit these scopes onto existing tokens or hand agents the owner key.
The student approves a concrete client, data boundary, permission set and expiry
before secure provisioning. Store only token digests/verification material; deliver
secrets through supported secure credential fields. Preserve expiry/revocation on
retries, allow independent client revocation, and prohibit silent renewal or scope
expansion. Provider labels alone are not agent identity.

## Storage, concurrency and isolation

Every record, protocol reference, history event, revision head and idempotency
receipt must be keyed by the authenticated student plus its course/project and
real/test namespace. Enforce this at each storage operation, not just list/UI
filters. Retained IDs must not become cross-student read capabilities. A retry key
is scoped to student, client and operation; identical retries return the original
receipt, while changed packets or stale revisions conflict.

Keep actual responses, assistance and provenance distinct from interpretations.
Missing history remains unknown. A newer checkpoint cannot silently settle a
source contradiction or establish mastery. Resolve the student's class/project,
read the applicable protocol and current revisions, then save and verify a matching
fresh exact-ID/text readback. Sandbox records never enter normal continuation.

## Migration and acceptance

First define student ownership for every existing row without rewriting its
content or history. Back up and hash-compare the original single-owner records,
including the retained protocol; migrate only after separate explicit approval.
Preserve the existing transport's response contract through a compatibility layer.

Before rollout, test two students and two agents with adversarial IDs, pagination,
revocation, expiry, exact retries, concurrent corrections, protocol protection,
real/test separation and source failures. Verify zero cross-student enumeration or
reads, independent agent revocation, and no access through legacy owner routes.
The dashboard and all agent transports must show the same scoped source evidence
and uncertainty. Deployment, migration and new credentials require a later approved
implementation; none is implied by this design.
