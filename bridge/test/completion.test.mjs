import {resolveReportIdentity} from '../src/identity.js';
// Completion matching, and the shared actionable view built on top of it.
//
// Every test here fails against the behaviour that shipped before 2026-09-04:
// matching ignored the course, several exact title matches all cleared, a report
// with no course matched anything anywhere, `confidence: 'confirmed'` was handed
// out for a title match with no submission evidence behind it, and the briefing
// listed completed work as overdue before telling the model to ignore it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadEvents, buildStatus, submissionEvidence } from '../src/status.js';
import { resolveCourse } from '../src/courses.js';
import { DUP_TITLE_FEED, BROKEN_FEED_URL, makeFetchStub } from './fixtures.js';

// Wednesday, Aug 19 2026, 6:40 PM Eastern — the same anchor status.test.mjs pins.
const NOW = new Date('2026-08-19T22:40:00Z');
const WINDOW = { windowStart: new Date('2026-08-09T00:00:00Z'), windowEnd: new Date('2026-10-09T00:00:00Z') };

const FEEDS = [{ name: 'elc', url: 'https://d2l.test/dup.ics' }];
const stub = makeFetchStub({ 'https://d2l.test/dup.ics': DUP_TITLE_FEED });

/** Build a payload the way the Worker does, including the cross-course match set. */
async function status({ course = null, progress = [], feeds = FEEDS, fetchImpl = stub } = {}) {
  const { events, health } = await loadEvents(feeds, { ...WINDOW, fetchImpl });
  // Fresh report fixtures exercise write-time identity resolution. Historical
  // rows deliberately bypass it and remain unlinked, just like migration.
  const pool=every(buildStatus({events,now:NOW,health}));
  progress=progress.map(p=>{
    if(!p._fresh) return p;
    const id=resolveReportIdentity(p,pool,[],p.course||'GENERAL');
    return {...p,...(id.error?{identity_resolution:'unresolved',identity_reason:id.error}:id)};
  });
  return buildStatus({
    events,
    now: NOW,
    course: course ? resolveCourse(course) : null,
    progress,
    allProgress: progress,
    health,
  });
}

const every = (s) => [...s.overdue, ...s.due_today, ...s.due_this_week, ...s.upcoming, ...s.other_courses_this_week];
const find = (s, title) => every(s).find((d) => d.title === title);
const cleared = (s) => every(s).filter((d) => d.completed === true);

const done = (course, item, extra = {}) => ({
  _fresh:true, course, item, status: 'done', at: '2026-08-19T20:00:00Z', at_local: 'Wed, Aug 19, 4:00 PM', ...extra,
});

// --- the course boundary -----------------------------------------------------

test('completing BUSN 5000 Quiz 1 leaves the MGMT 4280 Quiz 1 outstanding', async () => {
  const all = await status({ progress: [done('BUSN5000', 'Quiz 1')] });

  const hits = cleared(all);
  assert.equal(hits.length, 1, 'exactly one Quiz 1 may clear');
  assert.equal(hits[0].course_code, 'BUSN5000');

  const busn = await status({ course: 'BUSN5000', progress: [done('BUSN5000', 'Quiz 1')] });
  assert.equal(find(busn, 'Quiz 1').completed, true);

  const mgmt = await status({ course: 'MGMT4280', progress: [done('BUSN5000', 'Quiz 1')] });
  assert.equal(find(mgmt, 'Quiz 1').completed, undefined, 'another course must not be cleared');
  assert.equal(find(mgmt, 'Quiz 1').outstanding, true);
  assert.equal(mgmt.actionable.counts.due_this_week, 1, 'MGMT 4280 still owes its own Quiz 1');
});

test('a report filed against a course with no such deadline clears nothing anywhere', async () => {
  const s = await status({ progress: [done('MGMT5560', 'Homework 3')] });
  assert.equal(cleared(s).length, 0);
  assert.equal(s.completion_unmatched.length, 1);
  assert.equal(s.completion_unmatched[0].reason, 'no_tracked_deadline_in_course');
  assert.equal(s.completion_unmatched[0].match_method, 'unresolved');
});

// --- ambiguity inside one course ---------------------------------------------

test('one course reusing a title is ambiguous, not two completions', async () => {
  const s = await status({ course: 'BUSN5000', progress: [done('BUSN5000', 'Weekly Log')] });

  assert.equal(cleared(s).length, 0, 'two identical titles are not evidence of one assignment');
  assert.equal(s.completion_unmatched[0].reason,'ambiguous_assignment');
  assert.equal(s.identity_review.length,1);
});

test('a vague report still clears nothing, and now says which course it was filed under', async () => {
  const s = await status({ course: 'BUSN5000', progress: [done('BUSN5000', 'homework')] });
  assert.equal(cleared(s).length, 0);
  assert.equal(s.completion_unmatched[0].reason,'ambiguous_assignment');
  assert.equal(s.identity_review[0].course,'BUSN5000');
});

// --- GENERAL, explicitly rather than by accident ------------------------------

test('a course-less deadline is cleared by a GENERAL report and nothing else', async () => {
  const viaGeneral = await status({ progress: [done('GENERAL', 'Advisor meeting')] });
  assert.equal(cleared(viaGeneral).length, 1);
  assert.equal(cleared(viaGeneral)[0].title, 'Advisor meeting');

  // A report that arrives with no course at all lands in GENERAL. It must not
  // become a wildcard that matches every course's deadlines.
  const noCourse = await status({ progress: [done(undefined, 'Quiz 1')] });
  assert.equal(cleared(noCourse).length, 0);
  assert.equal(noCourse.completion_unmatched[0].course, 'GENERAL');

  // And a GENERAL report cannot reach into a course.
  const reaching = await status({ progress: [done('GENERAL', 'Homework 3')] });
  assert.equal(cleared(reaching).length, 0);
});

// --- matching is not submission evidence --------------------------------------

test('an exact title match creates no submission evidence', async () => {
  const s = await status({ course: 'BUSN5000', progress: [done('BUSN5000', 'Quiz 1')] });
  const c = find(s, 'Quiz 1').completion;

  assert.equal(c.match_method, 'source_identity');
  assert.equal(c.confidence, 'confirmed', 'the legacy field still describes the title match');
  assert.equal(c.submission_verification, 'reported');
  assert.equal(c.evidence, null);
  assert.ok(c.evidence_limitation, 'the limitation must be stated, not implied');
  assert.equal(s.actionable.counts.verified, 0);
  assert.equal(s.actionable.counts.awaiting_verification, 1);
  assert.match(s.briefing, /NOT independently verified/);
});

test('a token match is unique_alias, and still carries no evidence', async () => {
  // Deliberately loose wording: "Homework 03" against the real title "Homework 3".
  const s = await status({ course: 'BUSN5000', progress: [done('BUSN5000', 'Homework 03')] });
  const c = find(s, 'Homework 3').completion;
  assert.equal(c.match_method, 'source_identity');
  assert.equal(c.confidence, 'inferred');
  assert.equal(c.submission_verification, 'reported');
});

test('a legacy record keeps its own report and is never upgraded to verified', async () => {
  // Exactly the shape stored before verification existed: no verification key.
  const legacy = { course: 'BUSN5000', item: 'Quiz 1', status: 'done', at: '2026-08-18T12:00:00Z', note: 'self-reported' };
  const s = await status({ course: 'BUSN5000', progress: [legacy] });
  assert.equal(find(s, 'Quiz 1').completed,undefined);
  const c = submissionEvidence(legacy);

  assert.equal(c.submission_verification, 'reported');
  assert.match(c.evidence_limitation, /no structured evidence is available/);
  assert.doesNotMatch(c.evidence_limitation, /never independently checked/,
    'absent structured fields do not prove nothing was checked');
  assert.equal(c.reported_note, 'self-reported', 'the original note is preserved verbatim');
  assert.equal(c.reported_status, 'done', 'the original report survives');
  assert.equal(c.reported_at, '2026-08-18T12:00:00Z');
});

test('verified requires an observed reference; without one it stays reported', async () => {
  const bare = await status({ course: 'BUSN5000', progress: [done('BUSN5000', 'Quiz 1', { verification: 'verified' })] });
  assert.equal(find(bare, 'Quiz 1').completion.submission_verification, 'reported');

  const withEvidence = await status({
    course: 'BUSN5000',
    progress: [done('BUSN5000', 'Quiz 1', { verification: 'verified', evidence: 'eLC submission receipt 8831', submitted_by: 'self' })],
  });
  const c = find(withEvidence, 'Quiz 1').completion;
  assert.equal(c.submission_verification, 'verified');
  assert.equal(c.evidence, 'eLC submission receipt 8831');
  assert.equal(c.evidence_limitation, null);
  assert.equal(withEvidence.actionable.counts.verified, 1);
  assert.equal(withEvidence.actionable.counts.awaiting_verification, 0);
  assert.doesNotMatch(withEvidence.briefing, /NOT independently verified/);
});

test('a group submission someone else reported stays reported, not verified', async () => {
  const s = await status({
    course: 'BUSN5000',
    progress: [done('BUSN5000', 'Quiz 1', { submitted_by: 'group', reported_by: 'teammate', note: 'teammate says he submitted it' })],
  });
  const c = find(s, 'Quiz 1').completion;
  assert.equal(c.submission_verification, 'reported');
  assert.equal(c.submitted_by, 'group');
  assert.equal(c.reported_by, 'teammate');
});

test('drafted-but-not-submitted work is in_progress and clears no deadline', async () => {
  const s = await status({
    course: 'BUSN5000',
    progress: [{ course: 'BUSN5000', item: 'Homework 3', status: 'in_progress', note: 'finished the draft' }],
  });
  assert.equal(cleared(s).length, 0);
  assert.equal(find(s, 'Homework 3').outstanding, true);
  assert.equal(s.actionable.counts.outstanding, every(s).length);
});

// --- one actionable view, consumed everywhere ---------------------------------

test('completed work leaves the outstanding counts and the overdue prose', async () => {
  const before = await status({ course: 'BUSN5000' });
  assert.equal(before.actionable.counts.overdue, 1);
  assert.match(before.briefing, /Overdue: Homework 2/);

  const after = await status({ course: 'BUSN5000', progress: [done('BUSN5000', 'Homework 2')] });
  assert.equal(after.actionable.counts.overdue, 0);
  assert.doesNotMatch(after.briefing, /Overdue:/);
  assert.equal(after.actionable.outstanding.filter((d) => d.bucket === 'overdue').length, 0);

  // The historical record is kept — it is only no longer counted as outstanding.
  const hist = after.overdue.find((d) => d.title === 'Homework 2');
  assert.equal(hist.completed, true);
  assert.equal(hist.days_late, 3);
  assert.equal(after.actionable.completed.some((d) => d.title === 'Homework 2'), true);
});

test('a scoped view does not re-remind about other courses already reported done', async () => {
  const busn = await status({ course: 'BUSN5000', progress: [done('MGMT4280', 'Quiz 1')] });

  const other = busn.other_courses_this_week.find((d) => d.course_code === 'MGMT4280');
  assert.equal(other.completed, true, 'the scoped payload must see other courses\' reports');
  const stillNagging = busn.actionable.outstanding.filter((d) => d.course_code === 'MGMT4280');
  assert.deepEqual(stillNagging, [], 'a reported-done item in another course is not a reminder');
  assert.doesNotMatch(busn.briefing, /due within 48h/);
});

test('the actionable counts and the actionable lists cannot disagree', async () => {
  const s = await status({ progress: [done('BUSN5000', 'Homework 2'), done('GENERAL', 'Advisor meeting')] });
  const a = s.actionable;
  assert.equal(a.counts.outstanding, a.outstanding.length);
  assert.equal(a.counts.completed, a.completed.length);
  assert.equal(a.counts.awaiting_verification, a.awaiting_verification.length);
  assert.equal(a.counts.verified + a.counts.awaiting_verification, a.counts.completed);
  assert.equal(a.scope, 'ALL');

  // Nothing counted as outstanding is also reported done, and vice versa.
  const outstanding = new Set(a.outstanding.map((d) => `${d.course_code}|${d.title}`));
  for (const d of a.completed) assert.equal(outstanding.has(`${d.course_code}|${d.title}`), false);
});

test('blocked work is surfaced as its own state, not as silence', async () => {
  const s = await status({
    course: 'BUSN5000',
    progress: [{ course: 'BUSN5000', item: 'Homework 3', status: 'blocked', note: 'no RStudio licence' }],
  });
  assert.equal(s.actionable.counts.blocked, 1);
  assert.equal(s.actionable.blocked[0].note, 'no RStudio licence');
});

// --- coverage travels with the answer -----------------------------------------

test('a failed feed is reported in coverage, not just in the warning string', async () => {
  const feeds = [...FEEDS, { name: 'personal', url: BROKEN_FEED_URL }];
  const s = await status({ feeds });

  assert.deepEqual(s.actionable.coverage.feeds_failed, ['personal']);
  assert.equal(s.actionable.coverage.feeds_ok, 1);
  assert.equal(s.actionable.coverage.feeds_total, 2);
  assert.match(s.actionable.coverage.caveat, /may be missing/);
  assert.ok(s.data_warning, 'the existing warning string must survive');
});

test('a healthy read still says what it has not checked', async () => {
  const s = await status();
  assert.equal(s.actionable.coverage.calendars_read_live, true);
  // Milestone 1 does not check submission pages, and must not imply it does.
  assert.equal(s.actionable.coverage.submission_sources_checked, false);
  assert.match(s.actionable.coverage.caveat, /self-reported unless marked verified/i);
});

// --- review follow-up, 2026-09-04 ---------------------------------------------

test('work that needs no submission is neither awaiting a receipt nor a verified one', async () => {
  const s = await status({
    course: 'BUSN5000',
    progress: [done('BUSN5000', 'Quiz 1', { verification: 'not_required', note: 'in-class setup task' })],
  });
  const a = s.actionable;

  assert.equal(a.counts.completed, 1);
  assert.equal(a.counts.awaiting_verification, 0, 'there is no receipt to wait for');
  assert.equal(a.counts.verified, 0, 'and none was ever observed');
  assert.equal(a.counts.no_submission_required, 1);
  assert.equal(a.awaiting_verification.length, 0);
  assert.equal(a.no_submission_required[0].title, 'Quiz 1');
  assert.doesNotMatch(s.briefing, /NOT independently verified/);
  assert.match(s.briefing, /needed no submission/);

  // The three states must partition the completed set exactly.
  assert.equal(a.counts.verified + a.counts.awaiting_verification + a.counts.no_submission_required,
    a.counts.completed);
});

test('a legacy record states what is missing without asserting nothing was checked', async () => {
  const legacy = { course: 'BUSN5000', item: 'Quiz 1', status: 'done',
                   note: 'Checked the eLC submission page; receipt shown 8:02pm.' };
  assert.equal(find(await status({ course: 'BUSN5000', progress: [legacy] }), 'Quiz 1').completed,undefined);
  const c = submissionEvidence(legacy);

  assert.doesNotMatch(c.evidence_limitation, /never independently checked/);
  assert.match(c.evidence_limitation, /no structured evidence is available/);
  assert.equal(c.reported_note, legacy.note, 'the original note must survive verbatim');
  assert.equal(c.submission_verification, 'reported', 'and it is still not upgraded');
});

test('missing feed health is unknown, never a passing check', async () => {
  const { events } = await loadEvents(FEEDS, { ...WINDOW, fetchImpl: stub });
  const blind = buildStatus({ events, now: NOW, course: resolveCourse('MGMT4280'), progress: [], health: [] });

  assert.equal(blind.actionable.coverage.feeds_status, 'unknown');
  assert.match(blind.actionable.coverage.caveat, /unknown whether the calendars were read/);
  assert.match(blind.briefing, /no calendar feed health was reported/i);

  const healthy = await status({ course: 'MGMT4280' });
  assert.equal(healthy.actionable.coverage.feeds_status, 'ok');
  assert.doesNotMatch(healthy.briefing, /feed health was reported/i);

  const broken = await status({ feeds: [...FEEDS, { name: 'personal', url: BROKEN_FEED_URL }] });
  assert.equal(broken.actionable.coverage.feeds_status, 'degraded');
});

test('the horizon metadata describes what the lists actually span', async () => {
  const s = await status({ course: 'BUSN5000' });
  const a = s.actionable;

  assert.equal(a.horizon.due_window_days, 7);
  assert.equal(a.horizon.overdue_lookback_days, 10);
  assert.equal(a.horizon.upcoming_window_days, 21);
  assert.equal(a.horizon_days, undefined, 'the single false horizon is gone');

  // The seven-day figure counts only the buckets inside seven days, in this scope.
  const inWindow = a.outstanding.filter(
    (d) => ['overdue', 'due_today', 'due_this_week'].includes(d.bucket));
  assert.equal(a.scoped_next_7_days.outstanding, inWindow.length);
  assert.ok(a.counts.outstanding > inWindow.length, 'outstanding spans more than the week');
});

test('the "nothing outstanding" line counts only this scope and this week', async () => {
  // MGMT 4280 owns exactly one deadline in the fixture. Clear it, and clear two
  // BUSN items that reach this payload only as other_courses / upcoming context.
  const s = await status({
    course: 'MGMT4280',
    progress: [done('MGMT4280', 'Quiz 1'), done('BUSN5000', 'Homework 3'), done('BUSN5000', 'Homework 2')],
  });

  assert.equal(s.actionable.scoped_next_7_days.outstanding, 0);
  // Two of the three reach this payload — a past BUSN deadline is dropped from a
  // MGMT view entirely — and counts.completed spans both buckets.
  assert.equal(s.actionable.counts.completed, 2);
  assert.deepEqual(s.actionable.completed.map((d) => d.bucket).sort(),
    ['due_this_week', 'other_courses_this_week']);
  // Only the one inside this scope and this window may be claimed in that sentence.
  assert.match(s.briefing, /Nothing outstanding in this course in the next 7 days — 1 item in that window is already reported done/);
  assert.doesNotMatch(s.briefing, /2 items in that window/);
});
