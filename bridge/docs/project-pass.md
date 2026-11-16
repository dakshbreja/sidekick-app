# Project PASS in the original Sidekick

Current activation checkpoint — November 2, 2026: the additive backend and separate
scoped transport are deployed in the original service. Only Instinct and job-search
planning are registered. Claude is connected with the approved separate 30-day
read/save grant, seven tools and reloaded startup instructions. Fresh discovery,
synthetic saves and independent exact readbacks passed for both project namespaces;
real histories remain empty. ChatGPT's private Sidekick Project PASS plugin exists,
but its secure desktop API-key connection remains pending. No ChatGPT key has
been issued and live cross-client project roundtrips have not been verified.
See `../../docs/STATUS.md` and the recorded activation state for exact receipts.

School PASS retains its existing class-note records, protocol ID, five tools,
term routing, seven-tool remote MCP and the exact existing three-scope key.
Neither `GENERAL` nor a fictional course is used for project handoffs.

## Storage and continuation

`ProjectPassStore` adds an exact project registry and separate project handoff,
head, history and receipt tables in the original database. Project and real/test
scope are checked on reads, writes, history and predecessor references. A client
with project A cannot enumerate or read B. A project registry entry grants no
client access. Existing school and learning records are not migrated or changed.

`/pass/projects/tools/<name>` is an owner-authenticated JSON POST route. Its tools
register/list projects, get the project protocol, list/read/resume handoffs,
inspect history and save checkpoints. The existing same-origin browser-session
write rule also applies. School scoped tokens fail owner authentication, and
these tools are deliberately absent from the existing `/mcp` tool list.

Handoffs retain date/timezone, author/client, explicit goal, sourced facts, actual
questions/responses/help, observed completed actions, unresolved items and agreed
next steps. Interpretations occupy a separate field. Previous handoff references
must identify a retained revision in the same project and test scope. Text filters
reject some restricted or subjective content; they cannot prove arbitrary prose
factual. The assistant must preserve attribution and uncertainty.

There is no automatically overwritten current-state summary. List/read returns
dated evidence and the current project head revision. A fresh session should
retrieve the protocol and matching handoffs, check current original sources,
expose contradictions and continue only from supported facts. The newest save
does not establish which source is authoritative. Empty history means no saved
handoff, not no work. Real discovery excludes sandbox records.

## Safe concurrent saves

Each save requires `expected_revision` (zero for a new session) and the fresh
same-project/test `expected_head_revision`. An atomic transaction writes the
record, immutable before/after history, incremented head and idempotency receipt.
Two chats saving from one head cannot silently replace current state: one gets
`project_head_conflict` and must reread/reconcile before creating a new operation.
Separate sessions are retained after explicit reconciliation. Corrections also
need their exact record ID and current revision.

An unchanged retry key/packet returns the same receipt. A changed packet with
that key conflicts. Confirmed saves require a fresh exact-ID/revision/content
readback. Failed readbacks remain unconfirmed with the exact retry packet. An old
receipt does not resurrect a newer revision. Project-head advancement by another
session is disclosed. A failed transaction rolls back all four writes.

## Scoped clients and remaining activation

The user approved only `instinct` and `job-search-planning`, saved factual handoffs,
ChatGPT and Claude, read/save for 30 days. No inbox, finance, password, account,
repository, filesystem, school, submission, deletion or arbitrary-project access
follows. Do not widen or renew this scope silently.

Separate `pp1` credentials are checked before `/mcp/projects` and
`/pass/projects/client/tools/<name>`. They cannot authenticate school, owner or
browser-session routes. The existing school key cannot use project tools. The
seven external tools exclude project registration and grant administration.
Only the existing same-origin owner browser session can issue/list/check/revoke
project grants under `/pass/projects/connection/`. A stable client/request UUID
replays the original credential and expiry; changed scope conflicts and expired
or revoked identities do not renew. Secrets are transferred only to supported
secure client fields and never stored in package files, URLs, logs or notes.

Claude connector `00000000-0000-0000-0000-000000000000` has a separate grant,
active at verification, expiring 2026-12-02T06:40:38.704Z. Its six read tools are
allowed; save retains per-call approval. The account bootstrap routes the two
named projects separately and was verified after reload. Fresh sessions retrieved
Project PASS/1, empty real histories and the synthetic fixtures. Exact packet and
one-event history checks passed through an independent owner read.

The private ChatGPT plugin is
`https://chatgpt.com/plugins/plugins_6ae82c2e16148191ba84f85b5e88548d`.
Its web UI exposes Open in desktop app, with no secure API-key field. Native app
automation was denied in the earlier diagnostic and is not retried. Its secure
desktop connection therefore needs a supported user-accessible entry step before
its separate grant can be issued/transferred. Do not use a package header literal,
no-auth transport, another provider or the school credential as a workaround.
ChatGPT/fresh cross-client tests remain pending, rather than being inferred from
successful backend or Claude tests.

On every configured session: resolve exact project → read protocol → list/read
matching real handoffs and fresh head → continue attributed facts → save an
authorized checkpoint → match receipt and fresh exact readback. Empty records mean
unsaved work remains unknown. Facts and interpretations stay separate; no inferred
mastery or automatic contradiction resolution. Sandbox tests never enter normal
real discovery. A chat without the configured instructions/tools cannot be
claimed to inherit live continuity.

Rollback is a source rollback only. Preserve all project and school tables and
history; do not delete records or reset the original protocol.
