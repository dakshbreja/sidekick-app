# Local engineering workflow

Authorized October 14, 2026: keep existing live workflows working while adding
source recovery, isolated engineering and evidence-based reliability checks.

## Source baseline

The repository is local and has no remote. `source-policy.json` lists the exact
approved code/configuration files. The generated root `.gitignore` denies every
other file. Credentials, records, downloads, logs, raw transcripts, grade data,
the independent grades repository and operating state stay in place and untracked.
The routines registry has its own local repository and the same staged-byte guard.

Before a commit run `python3 engineering/git_guard.py --staged`. The installed
pre-commit hook does this too and blocks unsafe paths, linked files, binary/large
payloads and detected credentials. Hooks are local safeguards, not protection
against a user deliberately disabling Git hooks. Enroll a new source file only by
reviewing it, adding its exact path to source-policy.json, and adding an exact
negation plus parent-directory negations to `.gitignore`. Never use a broad
allow rule or `git add -f` to include private operational files.

## Isolated work

From the canonical school-system-suite directory:

```sh
python3 engineering/workspace.py create task-name
python3 engineering/verify.py .engineering-state/worktrees/task-name/school-system-suite
python3 engineering/workspace.py run .engineering-state/worktrees/task-name/school-system-suite -- /opt/homebrew/bin/node --test 'bridge/test/*.test.mjs'
python3 engineering/workspace.py run .engineering-state/worktrees/task-name/school-system-suite -- /opt/anaconda3/bin/python3 -m unittest discover -s collect/test
```

The helper creates both source-only Git worktrees under the named task and records
their base commits. No production state or credentials are copied. The command
runner uses macOS Seatbelt with deny-by-default file-content reads, writes only
to that checkout and its temporary directory, read-only runtime/sibling source
access, and network disabled. Shared `/tmp` writes and Apple Events are blocked.
Before each command, real negative probes check private reads, outside writes,
Git metadata, shared temporary space and network; a failed probe stops execution.
Filesystem metadata and the root directory itself can be inspected for runtime
startup; this does not grant file-content access outside the allowlist. HOME is
unchanged; secret environment variables and language injection variables are not
inherited. Live roots, browser state and unrelated home files cannot be read.

This runner isolates child commands and regression tests. The controlling Codex
chat and existing desktop/collector workflows retain their current permissions;
they are not inside this sandbox. No model credentials are copied, no global Codex
settings are changed, and no additional agent starts when a checkout is created.
Codex's installed command-sandbox profile allowed shared `/tmp` writes in the
October 14 probe, so this stricter command runner uses an explicit Seatbelt policy.

Review the diff and isolated test results before applying a source patch to the
canonical checkout. Do not deploy, publish, change schedules or run live collectors
from isolated tasks. Keep failed work for diagnosis. Use targeted source restores;
never restore a Git version over runtime records. Git worktrees alone are not a
security boundary—the command sandbox provides the enforced boundary.

## Reliability evidence

```sh
python3 engineering/reliability.py
python3 engineering/reliability.py --record
```

The check reuses the existing health reader for seven school routines, validates
source timestamps and freshness, and separately observes launchd registration.
It never runs collectors, publishes health, sends requests or modifies coursework.
Partial stages and missing evidence cannot become healthy through a zero exit code
or a recent file mtime. Code 0 means every scoped check is healthy and loaded with
unchanged scheduler hashes; 1 means attention/unknown/drift; 2 means the check itself
could not obtain valid evidence. Inspection succeeding does not make a collector
healthy. No grade values, raw errors, assignments, URLs or transcript content appear
in observations. `--record` writes only ignored local engineering metadata.

`--accept-configuration` explicitly establishes or updates the hash baseline after
an authorized schedule/configuration change. Do not use it to hide unexpected drift.
Existing school oversight owns repeated observations; no additional scheduler or
collector is installed. Separate samples do not prove continuous uptime. The retry
dispatcher and cloud/on-demand services retain their existing monitoring contracts;
the seven routine checks do not establish full-system coverage.

## Recovery

Private Git bundles and their source hash manifests are stored under the ignored
`.engineering-state/backups/` directory in each repository. Validate a bundle with
`git bundle verify PATH`; restore it into a new empty directory with
`git clone PATH DESTINATION`. Compare tracked source hashes before using a restore.
After cloning a bundle, restore the local commit hook with
`git config core.hooksPath engineering/hooks`, then run the staged audit.
The October 14 drill restores both baselines into separate directories and checks
every tracked byte plus `git fsck`. This establishes local source recovery only,
not remote backup, whole-machine recovery or production database restoration.

The live collectors keep their original directories, ownership and permissions.
Current engineering additions do not establish submission, material completeness,
learning mastery, uninterrupted uptime or successful future scheduled runs.
