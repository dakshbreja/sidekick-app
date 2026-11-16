#!/usr/bin/env node
// Rewrites the four loaded GPT instruction sets for the live Action.
//
// Two changes per file:
//   1. Prepend a section 0 telling the GPT to call getCourseStatus before it answers.
//   2. Replace the hand-written cross-course COLLISIONS block with a one-line priority
//      rule. The Action now serves competing load live under other_courses_this_week,
//      so the static list was both redundant and guaranteed to go stale.
//
// Originals in loaded/ are never modified; output goes to loaded/v2/.
// ChatGPT caps instructions at 8,000 CHARACTERS (not bytes).

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', 'fall-2026-gpts', 'loaded');
const OUT = join(SRC, 'v2');
const LIMIT = 8000;
const MARGIN = 60;

const COURSE_BY_FILE = {
  '01-business-5000-instructions.txt': 'BUSN5000',
  '02-management-4280-instructions.txt': 'MGMT4280',
  '03-management-5560-instructions.txt': 'MGMT5560',
  '04-management-5850-instructions.txt': 'MGMT5850',
};

const directive = (code) =>
`0. FIRST ACTION — EVERY CONVERSATION

Call getCourseStatus (course=${code}) before answering anything. Lead with its briefing, then ask what he wants to work on. Never state a deadline from memory; if data_warning is set, say the list may be incomplete.

`;

// Explicit, reviewable compressions. Each one either restates something the Action
// now serves live, or tightens wording without dropping a fact.
const REPLACEMENTS = {
  '01-business-5000-instructions.txt': [
    [`HARD DATES — late submissions are not accepted, period
pre-Project exercise Wed Aug 26 (5% of Project) · Part I Exam Thu Sep 24 · Progress Check (optional, +5 bonus) Fri Oct 2 · Project final Fri Nov 13 · Part II Exam at the time UGA's final exam schedule assigns — he must look this up.`,
     `HARD DATES — late work is never accepted
pre-Project Aug 26 (5% of Project) · Part I Exam Sep 24 · Progress Check (optional, +5) Oct 2 · Project final Nov 13 · Part II Exam per UGA's final schedule, which he must look up.`],
    [`- The recommended texts. There are NO required texts beyond the slides packet; all of Healy, Békés–Kézdi, Angrist–Pischke, Cunningham and ISLR are optional. Don't let him buy or work through them this term.`,
     `- The recommended texts. No required texts beyond the slides packet — Healy, Békés–Kézdi, Angrist–Pischke, Cunningham and ISLR are all optional. Don't let him buy or work through them.`],
  ],
  '02-management-4280-instructions.txt': [
    // The syllabus states a policy the original instruction set never captured.
    [`WITHDRAWAL DEADLINE`,
     `WORKING MODE ON ASSIGNMENTS
Beil's syllabus permits and ENCOURAGES AI on assignments, projects and case studies — but never on quizzes or exams, which run under Respondus LockDown. So build the work with him here, then require he can reproduce it cold: the exams are 60% and he sits them unaided.

WITHDRAWAL DEADLINE`],
  ],
  '03-management-5560-instructions.txt': [
    [`Final Exam at the time UGA assigns — he must look it up. Scored years and chapter exercises fall on a near-weekly cadence in between; see the syllabus.`,
     `Final Exam per UGA's schedule, which he must look up. Scored years and chapter exercises run near-weekly in between; see the syllabus.`],
    [`Then follow his lead on how much to take over: an outline, one section, a full draft, or a rewrite. Produce whatever he asks for, without negotiating or re-opening the question each time.`,
     `Then follow his lead on how much to take over — outline, one section, full draft, rewrite — and produce it without re-opening the question.`],
    [`Based on teammates' feedback his individual grade on the team project can be adjusted DOWNWARD by as much as 70% from the team composite — the syllabus example turns a group 88 into a personal 61.6. For non-contribution the instructor can reduce it to ZERO, and teammates can unanimously recommend TERMINATION from the group. Failing to complete the peer reviews also counts against him.`,
     `Teammates' feedback can cut his individual grade on the team project by up to 70% from the team composite — the syllabus turns a group 88 into a personal 61.6. Non-contribution can be reduced to ZERO, and teammates can unanimously recommend TERMINATION. Failing to complete the peer reviews also counts against him.`],
  ],
  '04-management-5850-instructions.txt': [
    [`Guhde posts slide *outlines* only, bans photographing slides, and **will not share slides for a missed class, for any reason.** Former students report consistently that her exams don't track the posted outlines, because the testable content is the examples she delivers verbally. Her ratings are sharply split; the students who do well are the ones physically present and taking notes.`,
     `Guhde posts slide *outlines* only, bans photographing slides, and **will not share slides for a missed class, for any reason.** Her exams don't track the posted outlines — the testable content is the examples she delivers verbally. The students who do well are the ones present and taking notes.`],
    [`→ **His class notes are the primary source in this course, not the textbook and not the outlines.** After each session, prompt him to paste or dictate what he captured. Turn it into (a) a running exam-prep sheet organised by the chapter map, and (b) a gap list of anything thin he should get from a classmate before the next class. If he arrives at a session with nothing, treat that as a live risk to the next exam and say so — not a minor lapse.`,
     `→ **His class notes are the primary source here, not the textbook and not the outlines.** After each session, prompt him to paste or dictate what he captured, and turn it into (a) a running exam-prep sheet on the chapter map and (b) a gap list to get from a classmate before the next class. If he shows up with nothing, call it a live risk to the next exam.`],
    [`On the research parts, podcast and presentation, open by asking Daksh for his own take — his angle, what he finds interesting or wrong. Get that first; it's better raw material than anything generated cold and keeps the work recognisably his. Then follow his lead on how much to take over: outline, one section, full draft, or rewrite. Produce whatever he asks for, without re-opening the question each time.`,
     `On the research parts, podcast and presentation, open by asking Daksh for his own take — his angle, what he finds interesting or wrong. Get that first; it keeps the work recognisably his. Then follow his lead on how much to take over, and produce it without re-opening the question.`],
  ],
};

const PRIORITY_LINE =
`COLLISIONS
Competing load is live in the Action's other_courses_this_week — read it rather than guessing. Priority on any clash: BUSN 5000 > MGMT 4280 > MGMT 5560 > MGMT 5850 > LAND 2510E. BUSN 5000 gates his Analytics emphasis, so it is never the one that slips.`;

// Matches a COLLISIONS heading and everything up to the next blank-line-separated block.
const COLLISIONS_RE = /^(?:CROSS-COURSE )?COLLISIONS(?: TO MANAGE)?\n(?:.+\n?)+?(?=\n)/m;

mkdirSync(OUT, { recursive: true });

let anyOver = false;
const rows = [];

for (const file of readdirSync(SRC).filter((f) => f in COURSE_BY_FILE).sort()) {
  const code = COURSE_BY_FILE[file];
  const original = readFileSync(join(SRC, file), 'utf8');

  const match = COLLISIONS_RE.exec(original);
  if (!match) {
    console.error(`!! ${file}: no COLLISIONS block found — inspect before pushing.`);
  }

  let next = match ? original.replace(COLLISIONS_RE, `${PRIORITY_LINE}\n`) : original;

  for (const [from, to] of REPLACEMENTS[file] || []) {
    if (!next.includes(from)) {
      console.error(`!! ${file}: replacement text not found, skipping:\n   "${from.slice(0, 70)}..."`);
      continue;
    }
    next = next.replace(from, to);
  }

  next = directive(code) + next;

  const before = [...original].length;
  const after = [...next].length;
  const over = after > LIMIT - MARGIN;
  if (over) anyOver = true;

  writeFileSync(join(OUT, file), next, 'utf8');
  rows.push({ file, code, before, after, delta: after - before, headroom: LIMIT - after, over });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad('file', 38)}${pad('before', 8)}${pad('after', 8)}${pad('delta', 8)}headroom`);
for (const r of rows) {
  console.log(`${pad(r.file, 38)}${pad(r.before, 8)}${pad(r.after, 8)}${pad(r.delta >= 0 ? `+${r.delta}` : r.delta, 8)}${r.headroom}${r.over ? '   <-- TOO LONG' : ''}`);
}
console.log(`\nOutput: ${OUT}`);
process.exit(anyOver ? 1 : 0);
