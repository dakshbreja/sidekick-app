import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconciliationWindow, reconcileDates, describeReconciliation } from '../src/date-reconciliation.js';
import { reviewedDateCorrections } from '../src/reviewed-date-corrections.js';
import { loadEvents, normalizeEvents, buildStatus } from '../src/status.js';
import { buildAgenda } from '../src/agenda.js';
import { eventIdentity, TERM_ID } from '../src/identity.js';
import { courseForEvent } from '../src/courses.js';
import { snapshotOf, diffSnapshots } from '../src/changes.js';

const correction = reviewedDateCorrections[0];
const source = correction.source;
const windowStart = new Date('2026-10-01T04:00:00Z'), windowEnd = new Date('2026-11-01T04:00:00Z');
const now = new Date('2026-10-10T18:00:00Z');
const event = (extra = {}) => ({ uid: correction.uid, recurrence_anchor: '', summary: correction.title,
  location: 'Classroom (MGMT5560 International Strategic Mgmt Fall 2026 53168)', description: 'In class',
  start: new Date(correction.original.start_iso), end: new Date(correction.original.end_iso),
  allDay: false, recurring: false, source, ...extra });
const reconcile = (events, extra = {}) => reconcileDates(events, {
  source, windowStart, windowEnd, corrections: [correction], ...extra,
});
const healthOf = result => [{ source, ok: true, coverage_complete: !result.conflicts.length,
  date_reconciliations: result.notes, date_conflicts: result.conflicts }];

test('checked instructor date corrects only the exact source occurrence and retains raw provenance', () => {
  const original = event(), before = structuredClone(original);
  const result = reconcile([original]);
  assert.equal(result.events[0].start.toISOString(), '2026-10-19T04:00:00.000Z');
  assert.equal(result.events[0].end.toISOString(), '2026-10-20T04:00:00.000Z');
  assert.equal(result.events[0].allDay, true);
  assert.equal(result.events[0].date_reconciliation.source_when_iso, correction.original.start_iso);
  assert.equal(result.events[0].date_reconciliation.source_end_iso, correction.original.end_iso);
  assert.equal(result.events[0].date_reconciliation.time_verification, 'unconfirmed');
  assert.match(describeReconciliation(result.notes[0]), /2026-10-19.*2026-10-14/);
  assert.match(describeReconciliation(result.notes[0]), /time is not confirmed/);
  assert.deepEqual(original, before, 'reading status cannot mutate the raw source object');
});

test('same title from another UID, course, source or recurrence is never reconciled by guessing', () => {
  const other = [event({ uid: 'different-uid' }), event({ location: 'Classroom BUSN5000' }),
    event({ source: 'Google Calendar' }), event({ recurring: true, recurrence_anchor: correction.original.start_iso })];
  const result = reconcile(other);
  assert.ok(result.events.every(row => row.start.toISOString() === correction.original.start_iso));
  assert.ok(result.events.every(row => !row.date_reconciliation));
});

test('unverified evidence or another term cannot activate a correction', () => {
  for (const invalid of [{ ...correction, term_id: 'fall-2025' },
    { ...correction, authority: { ...correction.authority, verified: false } },
    { ...correction, authority: { ...correction.authority, url: 'https://unreviewed.test/date' } }]) {
    const result = reconcile([event()], { corrections: [invalid] });
    assert.equal(result.events[0].start.toISOString(), correction.original.start_iso);
    assert.equal(result.notes.length, 0);
  }
});

test('a provider that reaches the announced day resumes its live clock without forcing an all-day event', () => {
  const current = event({ start: new Date('2026-10-19T17:15:00Z'), end: new Date('2026-10-19T18:35:00Z') });
  const result = reconcile([current]);
  assert.equal(result.events[0].start, current.start);
  assert.equal(result.events[0].allDay, false);
  assert.equal(result.notes[0].state, 'source_aligned');
  assert.equal(result.notes[0].time_verification, 'calendar_only');
});

test('an unexpected later source edit is preserved and makes its reviewed date visibly uncertain', () => {
  for (const changed of [event({ start: new Date('2026-10-21T17:15:00Z'), end: new Date('2026-10-21T18:35:00Z') }),
    event({ end: new Date('2026-10-14T19:00:00Z') })]) {
    const result = reconcile([changed]);
    assert.equal(result.events[0], changed);
    assert.equal(result.conflicts[0].reason, 'source_occurrence_changed');
    const status = buildStatus({ events: result.events, now, health: healthOf(result) });
    const agenda = buildAgenda({ events: result.events, status, now, windowStart, windowEnd });
    assert.equal(status.actionable.coverage.feeds_status, 'degraded');
    assert.match(status.data_warning, /no longer reconcile/);
    assert.match(status.briefing, /Recheck the original course source/);
    assert.ok(agenda.daily_briefing.warnings.some(warning => /Recheck the original course source/.test(warning)));
    assert.ok(!agenda.daily_briefing.warnings.some(warning => /recurrence coverage/.test(warning)));
  }
});

test('conflicting reviewed corrections cannot silently select one date', () => {
  const result = reconcile([event()], { corrections: [correction, { ...correction, id: 'another-review' }] });
  assert.equal(result.events[0].start.toISOString(), correction.original.start_iso);
  assert.equal(result.conflicts[0].reason, 'multiple_reviewed_corrections');
});

test('an ambiguous source identity cannot reconcile multiple calendar occurrences', () => {
  const result = reconcile([event(), event({ start: new Date('2026-10-15T17:15:00Z'), end: new Date('2026-10-15T18:35:00Z') })]);
  assert.ok(result.events.every(row => !row.date_reconciliation));
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].reason, 'ambiguous_source_occurrence');
});

test('a missing calendar occurrence is explicit and is never recreated from a historical observation', () => {
  const result = reconcile([]);
  assert.equal(result.events.length, 0);
  assert.equal(result.notes[0].state, 'source_missing');
  assert.equal(result.notes[0].source_when_iso, null);
  assert.equal(result.notes[0].when_iso, null);
  assert.match(describeReconciliation(result.notes[0]), /not in the live calendar/);
});

test('the parser finds a corrected exam entering the requested window from its original date outside it', async () => {
  const start = new Date('2026-10-18T04:00:00Z'), end = new Date('2026-10-21T04:00:00Z');
  const parseWindow = reconciliationWindow(source, start, end, [correction]);
  assert.equal(parseWindow.windowStart.toISOString(), correction.original.start_iso);
  const feed = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:' + correction.uid +
    '\r\nSUMMARY:Test Two Administered\r\nLOCATION:Classroom MGMT5560\r\nDTSTART:20261014T171500Z\r\nDTEND:20261014T183500Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const result = await loadEvents([{ name: source, url: 'https://synthetic.test/feed' }], {
    windowStart: start, windowEnd: end, fetchImpl: async () => new Response(feed),
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].start.toISOString(), correction.effective.start_iso);
  assert.equal(result.health[0].coverage_complete, true);
  assert.equal(result.health[0].date_reconciliations[0].state, 'applied');
});

test('corrected exams leave their old window and do not claim dates outside checked bounds', () => {
  const result = reconcile([event()], { windowStart: new Date('2026-10-14T04:00:00Z'), windowEnd: new Date('2026-10-15T04:00:00Z') });
  assert.equal(result.events.length, 0);
  assert.equal(result.notes[0].state, 'applied');
});

test('status, actionable priorities and calendar share one corrected date with the same assignment identity', () => {
  const original = event(), result = reconcile([original]);
  const status = buildStatus({ events: result.events, now, health: healthOf(result) });
  const agenda = buildAgenda({ events: result.events, status, now, windowStart, windowEnd });
  const expectedId = eventIdentity({ ...original, course: courseForEvent(original) });
  const deadline = status.upcoming[0], priority = status.actionable.outstanding[0], calendar = agenda.calendar.events[0];
  assert.equal(deadline.when_iso, correction.effective.start_iso);
  assert.equal(priority.when_iso, deadline.when_iso);
  assert.equal(calendar.start_iso, deadline.when_iso);
  assert.equal(calendar.date_key, '2026-10-19');
  assert.equal(calendar.assignment_id, expectedId);
  assert.equal(priority.assignment_id, expectedId);
  assert.equal(deadline.date_reconciliation.precision, 'date');
  assert.equal(calendar.date_reconciliation.time_verification, 'unconfirmed');
  assert.match(status.briefing, /date corrected to 2026-10-19/);
  assert.ok(agenda.daily_briefing.warnings.some(warning => /exam time is not confirmed/.test(warning)));
});

test('a date-only exam stays due all day and never falsely becomes midnight-overdue', () => {
  const result = reconcile([event()]);
  const status = buildStatus({ events: result.events, now: new Date('2026-10-19T21:00:00Z'), health: healthOf(result) });
  assert.equal(status.due_today.length, 1);
  assert.equal(status.overdue.length, 0);
  assert.equal(status.due_today[0].when, 'Mon, Oct 19');
});

test('completion and stronger submission evidence survive the move through stable source identity', () => {
  const original = event(), result = reconcile([original]);
  const assignment_id = eventIdentity({ ...original, course: courseForEvent(original) });
  const progress = [{ course: 'MGMT5560', item: correction.title, status: 'done', term_id: TERM_ID,
    assignment_id, assignment_refs: [assignment_id], identity_resolution: 'linked',
    verification: 'verified', evidence: 'synthetic-portal-receipt', record_id: 'synthetic-record', revision: 4 }];
  const before = structuredClone(progress);
  const status = buildStatus({ events: result.events, now, health: healthOf(result), progress });
  assert.equal(status.upcoming[0].completed, true);
  assert.equal(status.upcoming[0].completion.submission_verification, 'verified');
  assert.equal(status.actionable.counts.outstanding, 0);
  assert.deepEqual(progress, before, 'date reconciliation only reads coursework records');
});

test('change history sees one moved occurrence, never a new exam plus a deleted exam', () => {
  const original = event(), result = reconcile([original]);
  const before = snapshotOf(normalizeEvents([original]).deadlines, windowStart, windowEnd);
  const after = snapshotOf(normalizeEvents(result.events).deadlines, windowStart, windowEnd);
  const changes = diffSnapshots(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'moved');
  assert.equal(changes[0].from, correction.original.start_iso);
  assert.equal(changes[0].to, correction.effective.start_iso);
});
