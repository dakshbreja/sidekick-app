# Isolated engineering context

This checkout contains approved source only. Its canonical production counterpart
and task base commit are recorded in the sibling `manifest.json`. The live hub
remains routing authority and must be read by the operator before starting a task.
This offline checkout intentionally cannot read that private hub, credentials,
academic records, raw materials or browser sessions. Do not bypass the boundary.

Read `engineering/README.md`, root `AGENTS.md`, and the source relevant to the task.
Preserve exact assignment identities, atomic revisions, idempotency and readbacks;
drafts and access checks never prove submission. Keep grades out of the bridge.
Keep existing collector ownership, schedule definitions and live root paths.

Run only offline tests using `engineering/workspace.py run` from the canonical
project. The controlling chat retains its own permissions. Collectors, deployment,
publication, OAuth refresh and external writes belong to a separately reviewed
live operation. A test needing production access must fail; do not import secrets.

Review the diff and test results before applying an approved source patch back to
the canonical checkout. Keep failed changes for diagnosis. Never overwrite runtime
state or roll production records back as part of a source restore.
