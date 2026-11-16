# Sidekick

**The new way to do school.** One place for every course portal, and an AI agent that remembers how you learn.

Sidekick is a student's school companion built around agents. A college semester lives in a dozen places: the learning management system, Gradescope, a simulation game, polling apps, three calendars. Sidekick reads them into one record, shows that record as a dashboard, and lets an AI agent work from the same record inside ChatGPT.

![Learner profile](docs/img/learner-profile.png)

*The learner profile, shown with synthetic data.*

## What it does

- **One dashboard.** Today, Calendar, This week, Upcoming, Optional and Changes, built from live course calendars and source checks. Every deadline shows where it came from.
- **An agent that picks up where you left off.** Sidekick runs as a plugin inside ChatGPT. Ask "what's on my plate today?" and it answers from the same record the dashboard shows.
- **PASS: Progress And Session Summary.** Every study session ends in a saved, factual handoff: what was asked, what was answered, what help was given, what is still open. The next agent session resumes from it instead of starting over.
- **A learner profile you control.** Practice questions are recorded with how sure you said you were before answering. Sidekick shows what you missed in plain words, how your confidence compared with your results, and what is ready to retry. Patterns are offered as hypotheses; only the student confirms or rejects them.
- **A live system map.** Every source, collector and agent connection, with its last successful check.

## How it works

```
course portals, calendars ──► collectors ──► Bridge (Cloudflare Worker) ──► dashboard
                                                   │
                                                   └──► MCP tools ──► ChatGPT plugin and other agents
```

- `bridge/` is the core: a Cloudflare Worker that serves the dashboard, stores PASS records and learner evidence, and exposes the agent interface (remote MCP tools such as `get_pass_protocol`, `list_passes`, `resume_pass`, `save_pass` and the learner tools).
- `collect/` reads course sites and files course material.
- `meetings/` handles class recordings and notes.
- `docs/` holds the design notes: [agent interface](docs/AGENT-INTERFACE.md), [learner profile](docs/LEARNER-PROFILE.md), [product notes](docs/PRODUCT.md) and the original [system overview](docs/SYSTEM-OVERVIEW.md).

Design rules the code enforces: facts need a source, a saved handoff is confirmed by reading it back, an agent never infers mastery or submission, and grades stay separate from PASS.

## Running the tests

```
cd bridge
node --test 'test/*.test.mjs'
```

Needs Node 22 or newer and no install step. 659 of the 662 tests pass in this copy; the other three depend on files left out of it (a local Python adapter and the per-course GPT instructions).

## About this copy

This is a scrubbed export of a working personal project, published for a student showcase. Credentials, course downloads, recordings, grade data and personal logs are left out, and account identifiers are replaced with placeholders, so it will not deploy as-is. See [docs/ABOUT-THIS-EXPORT.md](docs/ABOUT-THIS-EXPORT.md).

Built by Daksh ([github.com/dakshbreja](https://github.com/dakshbreja)), University of Georgia.
