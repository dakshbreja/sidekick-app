import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgenda } from '../src/agenda.js';
import { buildStatus, AUTO_TAG } from '../src/status.js';
import { parseICS } from '../src/ics.js';
import { courseForEvent } from '../src/courses.js';
import { eventIdentity, TERM_ID } from '../src/identity.js';

const NOW = new Date('2026-11-01T06:30:00Z'); // Second 1:30 a.m., after fall-back.
const WINDOW_START = new Date('2026-10-20T00:00:00Z');
const WINDOW_END = new Date('2026-11-20T00:00:00Z');
const HEALTH = [{ source: 'elc', ok: true, events: 0 }, { source: 'personal', ok: true, events: 0 }];
function event(overrides = {}) {
  return { uid: 'event-1', recurrence_anchor: '', source: 'personal', summary: 'Personal appointment',
    description: '', location: '', start: new Date('2026-11-01T16:00:00Z'),
    end: new Date('2026-11-01T17:00:00Z'), allDay: false, recurring: false,
    unsupportedRule: null, ...overrides };
}
function status(overrides = {}) {
  return { actionable: { scope: 'ALL', outstanding: [], completed: [], coverage: { submission_sources_checked: false } },
    feed_health: HEALTH, recent_changes: [], class_notes: [], ...overrides };
}
function agenda(events = [], snapshot = status(), now = NOW) {
  return buildAgenda({ events, status: snapshot, now, windowStart: WINDOW_START, windowEnd: WINDOW_END });
}
function assignmentId(ev) { return eventIdentity({ ...ev, course: courseForEvent(ev) }); }

test('Eastern today survives the repeated hour at the fall DST boundary', () => {
  const rows = [event(), event({ uid: 'previous-night', start: new Date('2026-11-01T03:30:00Z'), end: new Date('2026-11-01T04:00:00Z') }),
    event({ uid: 'late-today', start: new Date('2026-11-02T04:30:00Z'), end: new Date('2026-11-02T04:45:00Z') })];
  const result = agenda(rows);
  assert.equal(result.daily_briefing.date, '2026-11-01');
  assert.equal(result.daily_briefing.today.length, 2);
  assert.ok(result.daily_briefing.today.every(row => row.date_key === '2026-11-01'));
  assert.equal(result.calendar.events.find(row => row.title === 'Personal appointment' && row.date_key === '2026-10-31').date_key, '2026-10-31');
});

test('all-day DTEND stays exclusive across the 25-hour fall-back day', () => {
  const feed = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:all-day\nDTSTART;VALUE=DATE:20261101\nDTEND;VALUE=DATE:20261102\nSUMMARY:Conference\nEND:VEVENT\nEND:VCALENDAR';
  const rows = parseICS(feed, { windowStart: WINDOW_START, windowEnd: WINDOW_END, source: 'personal' });
  const result = agenda(rows);
  const row = result.calendar.events[0];
  assert.equal(row.date_key, '2026-11-01');
  assert.equal(row.end_date_key, '2026-11-02');
  assert.equal(Date.parse(row.end_iso) - Date.parse(row.start_iso), 25 * 3600000);
  assert.equal(agenda(rows, status(), new Date('2026-11-02T05:00:00Z')).daily_briefing.today.length, 0);
});

test('missing all-day DTEND defaults to next Eastern midnight, not 24 hours later', () => {
  const row = event({ allDay: true, start: new Date('2026-11-01T04:00:00Z'), end: null });
  const result = agenda([row]).calendar.events[0];
  assert.equal(result.end_iso, '2026-11-02T05:00:00.000Z');
  assert.equal(result.end_date_key, '2026-11-02');
});

test('multi-day events appear today while an exclusive midnight finish does not', () => {
  const rows = [event({ uid: 'ongoing', start: new Date('2026-10-31T18:00:00Z'), end: new Date('2026-11-02T05:00:00Z') }),
    event({ uid: 'finished', start: new Date('2026-10-31T18:00:00Z'), end: new Date('2026-11-01T04:00:00Z') })];
  assert.equal(agenda(rows).daily_briefing.today.length, 1);
});

test('identities survive a moved recurring occurrence and keep unrelated feeds distinct', () => {
  const base = event({ uid: 'class', recurring: true, recurrence_anchor: '2026-11-01T16:00:00Z', summary: 'BUSN 5000' });
  const moved = event({ ...base, start: new Date('2026-11-02T16:00:00Z'), end: new Date('2026-11-02T17:00:00Z') });
  assert.equal(agenda([base]).calendar.events[0].id, agenda([moved]).calendar.events[0].id);
  const result = agenda([base, { ...base }, { ...base, source: 'elc' },
    { ...base, source: 'Google second calendar' }, { ...base, recurrence_anchor: '2026-11-02T16:00:00Z' }]);
  assert.equal(result.calendar.events.length, 4);
  assert.equal(new Set(result.calendar.events.map(row => row.id)).size, 4);
});

test('completion uses exact status source identity, never a reused title', () => {
  const first = event({ uid: 'quiz-first', source: 'elc', summary: 'BUSN 5000 — Quiz 1 - Due' });
  const second = event({ ...first, uid: 'quiz-second', start: new Date('2026-11-03T16:00:00Z') });
  const progress = [{ course: 'BUSN5000', item: 'Quiz 1', status: 'done', assignment_id: assignmentId(first),
    assignment_refs: [assignmentId(first)], term_id: TERM_ID, identity_resolution: 'linked', verification: 'reported' }];
  const snapshot = buildStatus({ events: [first, second], now: NOW, health: HEALTH, progress });
  const result = agenda([first, second], snapshot);
  const done = result.calendar.events.find(row => row.completed);
  const open = result.calendar.events.find(row => !row.completed);
  assert.equal(done.assignment_id, assignmentId(first));
  assert.equal(done.submission_verification, 'reported');
  assert.equal(open.assignment_id, assignmentId(second));
  assert.equal(open.submission_verification, 'unknown');
  assert.equal(result.daily_briefing.priorities.length, 1);
  assert.equal(result.daily_briefing.priorities[0].assignment_id, assignmentId(second));
});

test('a title-only historical report cannot mark a calendar event complete', () => {
  const quiz = event({ source: 'elc', summary: 'BUSN 5000 — Quiz 1 - Due' });
  const snapshot = buildStatus({ events: [quiz], now: NOW, health: HEALTH,
    progress: [{ course: 'BUSN5000', item: 'Quiz 1', status: 'done' }] });
  const result = agenda([quiz], snapshot);
  assert.equal(result.calendar.events[0].completed, false);
  assert.equal(result.daily_briefing.priorities.length, 1);
});

test('known D2L due/close refs collapse while a same-title Google event remains', () => {
  const due = event({ uid: 'due', source: 'elc', summary: 'BUSN 5000 — Quiz 1 - Due' });
  const close = event({ ...due, uid: 'close', summary: 'BUSN 5000 — Quiz 1 - Availability Ends' });
  const google = event({ ...due, uid: 'unrelated', source: 'personal' });
  const snapshot = buildStatus({ events: [due, close, google], now: NOW, health: HEALTH });
  const result = agenda([close, due, google], snapshot);
  assert.equal(result.calendar.events.length, 2);
  assert.equal(result.calendar.events.find(row => row.source === 'elc').assignment_id, assignmentId(due));
});

test('calendar deadlines beyond 21 days reuse normalized refs and exact progress without adding priorities', () => {
  const due = event({ uid: 'later-due', source: 'elc', summary: 'BUSN 5000 — Quiz 9 - Due',
    start: new Date('2026-11-29T17:00:00Z'), end: null });
  const close = event({ ...due, uid: 'later-close', summary: 'BUSN 5000 — Quiz 9 - Availability Ends' });
  const exam = event({ uid: 'later-exam', summary: 'BUSN 5000 Exam 3', start: new Date('2026-12-01T17:00:00Z'), end: null });
  const progress = [{ course: 'BUSN5000', item: 'Quiz 9', status: 'done', assignment_id: assignmentId(due),
    assignment_refs: [assignmentId(due), assignmentId(close)], term_id: TERM_ID, identity_resolution: 'linked', verification: 'reported' }];
  const snapshot = buildStatus({ events: [due, close, exam], now: NOW, health: HEALTH, progress });
  assert.equal(snapshot.actionable.outstanding.length, 0);
  assert.equal(snapshot.upcoming.length, 0);
  const result = buildAgenda({ events: [close, due, exam], status: snapshot, now: NOW,
    windowStart: WINDOW_START, windowEnd: new Date('2026-12-16T00:00:00Z') });
  assert.equal(result.calendar.events.length, 2);
  const quiz = result.calendar.events.find(row => row.source === 'elc');
  assert.equal(quiz.kind, 'deadline');
  assert.equal(quiz.assignment_id, assignmentId(due));
  assert.equal(quiz.completed, true);
  assert.equal(quiz.submission_verification, 'reported');
  assert.equal(result.calendar.events.find(row => row.title === 'BUSN 5000 Exam 3').kind, 'deadline');
  assert.deepEqual(result.daily_briefing.priorities, []);
  assert.deepEqual(result.daily_briefing.upcoming_exams, []);
});

test('calendar history outside actionable lookback preserves source-linked verified completion', () => {
  const old = event({ uid: 'past-quiz', source: 'elc', summary: 'BUSN 5000 — Quiz 0 - Due',
    start: new Date('2026-10-20T17:00:00Z'), end: null });
  const progress = [{ course: 'BUSN5000', item: 'Quiz 0', status: 'done', assignment_id: assignmentId(old),
    term_id: TERM_ID, identity_resolution: 'linked', verification: 'verified', evidence: 'private original submission receipt' }];
  const snapshot = buildStatus({ events: [old], now: NOW, health: HEALTH, progress });
  const result = agenda([old], snapshot);
  assert.equal(result.calendar.events[0].completed, true);
  assert.equal(result.calendar.events[0].submission_verification, 'verified');
  assert.deepEqual(result.daily_briefing.priorities, []);
  assert.doesNotMatch(JSON.stringify(result), /private original submission receipt/);
});

test('a one-off course guest speaker follows the shared normalized class meeting', () => {
  const guest = event({ summary: 'MGMT 5560 — Guest speaker', recurring: false });
  const snapshot = buildStatus({ events: [guest], now: NOW, health: HEALTH });
  assert.deepEqual(snapshot.actionable.outstanding, []);
  assert.equal(agenda([guest], snapshot).calendar.events[0].kind, 'class');
});

test('commitments, optional work and cancelled entries do not create daily priorities', () => {
  const rows = [event(), event({ uid: 'club', summary: 'AI Society workshop', description: 'Source: GroupMe' }),
    event({ uid: 'class', summary: 'BUSN 5000', recurring: true }),
    event({ uid: 'study', summary: 'Study for BUSN 5000 exam' }),
    event({ uid: 'optional', summary: '◦ Optional reading', description: AUTO_TAG }),
    event({ uid: 'cancelled', summary: '[CANCELLED] Old meeting' }),
    event({ uid: 'opens', source: 'elc', summary: 'Homework - Available' })];
  const result = agenda(rows);
  assert.equal(result.calendar.events.length, 5);
  assert.deepEqual(result.calendar.events.map(row => row.kind).sort(), ['class', 'meeting', 'meeting', 'optional', 'study']);
  assert.deepEqual(result.daily_briefing.priorities, []);
});

test('exam preview respects local seven-day dates and excludes study, optional and final projects', () => {
  const rows = [event({ uid: 'exam', summary: 'BUSN 5000 Exam 2', start: new Date('2026-11-09T04:59:00Z'), end: null }),
    event({ uid: 'later', summary: 'Midterm', start: new Date('2026-11-09T05:01:00Z'), end: null }),
    event({ uid: 'study', summary: 'Study for Exam 2' }),
    event({ uid: 'optional', summary: 'Optional test practice', description: AUTO_TAG }),
    event({ uid: 'project', summary: 'Final project' })];
  const exams = agenda(rows).daily_briefing.upcoming_exams;
  assert.equal(exams.length, 1);
  assert.equal(exams[0].title, 'BUSN 5000 Exam 2');
  assert.equal(exams[0].days_away, 7);
  assert.equal('coverage' in exams[0], false);
  assert.equal('readiness' in exams[0], false);
});

test('an exam date lookup reminder remains required work without posing as an actual exam',()=>{
  const rows=[event({uid:'lookup',summary:'BUSN 5000 — look up your Part II (final) exam date & time'}),
    event({uid:'actual',summary:'BUSN 5000 — Part II final exam'})];
  const snapshot=buildStatus({events:rows,now:NOW,health:HEALTH});
  const result=agenda(rows,snapshot);
  assert.equal(result.calendar.events.length,2);
  assert.equal(result.daily_briefing.priorities.length,2);
  assert.deepEqual(result.daily_briefing.upcoming_exams.map(x=>x.title),['Part II final exam']);
});

test('medical tests and final interviews stay visible commitments, not exams or priorities', () => {
  const rows = [event({ uid: 'medical', summary: 'COVID test appointment' }),
    event({ uid: 'interview', summary: 'Final interview' }),
    event({ uid: 'practice', summary: 'BUSN 5000 Practice exam' }),
    event({ uid: 'prep', summary: 'MGMT 4280 Midterm prep' })];
  const snapshot = buildStatus({ events: rows, now: NOW, health: HEALTH });
  const result = agenda(rows, snapshot);
  assert.equal(result.calendar.events.length, 4);
  assert.deepEqual(result.daily_briefing.priorities, []);
  assert.deepEqual(result.daily_briefing.upcoming_exams, []);
  assert.equal(result.calendar.events.find(row => row.title === 'COVID test appointment').kind, 'meeting');
  assert.equal(result.calendar.events.find(row => row.title === 'Final interview').kind, 'event');
  assert.ok(result.calendar.events.filter(row => /practice|prep/i.test(row.title)).every(row => row.kind === 'study'));
});

test('empty, missing, failed and incompletely expanded feeds stay visibly limited', () => {
  const unknown = agenda([], status({ feed_health: [] }));
  assert.equal(unknown.calendar.coverage.feeds_status, 'unknown');
  assert.match(unknown.daily_briefing.warnings.join(' '), /unknown/);
  const missing = agenda([], status({ feed_health: [HEALTH[0]] }));
  assert.equal(missing.calendar.coverage.feeds_status, 'degraded');
  assert.deepEqual(missing.calendar.coverage.feeds_missing, ['Google Calendar']);
  const failed = agenda([], status({ feed_health: [{ source: 'elc', ok: false, error: 'https://secret-feed.test/token' }, HEALTH[1]] }));
  assert.equal(failed.calendar.coverage.feeds_status, 'degraded');
  assert.match(failed.daily_briefing.warnings.join(' '), /could not be read/);
  assert.doesNotMatch(JSON.stringify(failed), /secret-feed/);
  const partial = agenda([event({ unsupportedRule: 'FREQ=MONTHLY' })], status({ feed_health: [HEALTH[0], { ...HEALTH[1], coverage_complete: false }] }));
  assert.equal(partial.calendar.coverage.feeds_status, 'degraded');
  assert.match(partial.daily_briefing.warnings.join(' '), /recurr/);
  assert.match(partial.daily_briefing.warnings.join(' '), /submissions/);
});

test('collector metadata warns about declared failures without repeating raw error details', () => {
  const result = agenda([], status({ source_health: [{ id: 'lectures', label: 'Lecture delivery', status: 'failed',
    last_attempt_at: '2026-11-01T05:00:00Z', error: 'Bearer hidden-value; grade: 92%' }] }));
  assert.match(result.daily_briefing.warnings.join(' '), /Lecture delivery is failed/);
  assert.doesNotMatch(JSON.stringify(result), /hidden-value|92%/);
});

test('calendar text suppresses grade and transcript bodies, HTML and unsafe links', () => {
  const rows = [event({ uid: 'grade', description: 'GRADEBOOK: Private score 92%; details' }),
    event({ uid: 'transcript', description: 'Transcript:\n[00:01] secret lecture sentence' }),
    event({ uid: 'links', description: '<script>hidden script</script><b>Bring notebook</b> https://calendar.google.com/calendar/ical/private-token/basic.ics javascript:alert(1)', location: '<b>Room 101</b>' }),
    event({ uid: 'token', description: 'Bearer hidden-credential' })];
  const result = agenda(rows);
  assert.equal(result.calendar.events.find(row => row.id === agenda([rows[2]]).calendar.events[0].id).description, 'Bring notebook');
  assert.doesNotMatch(JSON.stringify(result), /92%|secret lecture sentence|private-token|javascript:|hidden script|hidden-credential|<b>/);
});

test('recent lectures project metadata only and never manufacture a title from text', () => {
  const result = agenda([], status({ class_notes: [
    { date: '2026-10-31', course: 'MGMT4280', session_id: 'lecture-1', title: 'Inventory planning', text: 'SECRET TRANSCRIPT BODY', summary: 'SECRET SUMMARY BODY' },
    { date: '2026-11-01', course: 'BUSN5000', session_id: 'lecture-2', text: 'UNNAMED SECRET' },
    { date: '2026-10-01', title: 'Old lecture', text: 'OLD SECRET' },
    { date: '2026-11-03', title: 'Future lecture' },
  ] }));
  assert.equal(result.daily_briefing.recent_lectures.length, 2);
  assert.equal(result.daily_briefing.recent_lectures[0].title, 'Lecture notes');
  assert.equal(result.daily_briefing.recent_lectures[1].course_code, 'MGMT4280');
  assert.doesNotMatch(JSON.stringify(result), /SECRET|Future lecture|Old lecture/);
});

test('changes are dated, bounded and safe, while priorities retain canonical order and identity', () => {
  const snapshot = status({ recent_changes: [
    { type: 'moved', title: 'Quiz', course: 'BUSN5000', at: '2026-10-31T20:00:00Z', from: '2026-11-02T17:00:00Z', to: '2026-11-03T17:00:00Z' },
    { type: 'added', title: 'Old change', at: '2026-10-01T20:00:00Z' },
    { type: 'added', title: 'Undated change' },
    { type: 'added', title: 'Future change', at: '2026-11-02T20:00:00Z' },
  ], actionable: { scope: 'ALL', outstanding: [
    { assignment_id: 'first', term_id: TERM_ID, title: 'Late quiz', bucket: 'overdue', days_away: -1,
      progress_record: { record_id: 'r1', revision: 3, status: 'in_progress', note: 'PRIVATE PROGRESS NOTE' } },
    { assignment_id: 'second', title: 'Today quiz', bucket: 'due_today', days_away: 0 },
  ] } });
  const result = agenda([], snapshot);
  assert.deepEqual(result.daily_briefing.priorities.map(row => row.assignment_id), ['first', 'second']);
  assert.equal(result.daily_briefing.priorities[0].progress_record.revision, 3);
  assert.equal(result.daily_briefing.changes.length, 1);
  assert.match(result.daily_briefing.changes[0].summary, /moved from/);
  assert.match(result.daily_briefing.summary, /1 overdue, 1 due today/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE PROGRESS NOTE|Old change|Undated change|Future change/);
});

test('projection is deterministic and does not mutate its live inputs', () => {
  const rows = [event()];
  const snapshot = status();
  const before = JSON.stringify({ rows, snapshot });
  assert.deepEqual(agenda(rows, snapshot), agenda(rows, snapshot));
  assert.equal(JSON.stringify({ rows, snapshot }), before);
  assert.throws(() => buildAgenda({ events: rows, status: snapshot, now: NOW, windowStart: WINDOW_END, windowEnd: WINDOW_START }), /valid_agenda_window/);
});
