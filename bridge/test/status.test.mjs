import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseICS } from '../src/ics.js';
import { loadEvents, normalizeEvents, buildStatus, TZ } from '../src/status.js';
import { resolveCourse } from '../src/courses.js';
import { D2L_FEED, GOOGLE_FEED, makeFetchStub } from './fixtures.js';

// Wednesday, Aug 19 2026, 6:40 PM Eastern.
const NOW = new Date('2026-08-19T22:40:00Z');
const WINDOW_START = new Date('2026-08-09T00:00:00Z');
const WINDOW_END = new Date('2026-10-09T00:00:00Z');

const FEEDS = [
  { name: 'elc', url: 'https://d2l.test/feed.ics' },
  { name: 'personal', url: 'https://google.test/feed.ics' },
];

const stub = makeFetchStub({
  'https://d2l.test/feed.ics': D2L_FEED,
  'https://google.test/feed.ics': GOOGLE_FEED,
});

async function load(fetchImpl = stub) {
  return loadEvents(FEEDS, { windowStart: WINDOW_START, windowEnd: WINDOW_END, fetchImpl });
}

test('parses UTC deadlines into the correct local instant', () => {
  const events = parseICS(D2L_FEED, { windowStart: WINDOW_START, windowEnd: WINDOW_END, source: 'elc' });
  const q1 = events.find((e) => e.summary.startsWith('Quiz 01') && e.summary.endsWith('Due'));
  assert.ok(q1, 'Quiz 01 due event should parse');
  // 2026-08-23T03:59:59Z is 11:59:59 PM Eastern on Saturday Aug 22.
  const local = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric' }).format(q1.start);
  assert.match(local, /Sat/, 'should land on Saturday in Eastern time, not Sunday');
});

test('expands weekly recurring classes with TZID', () => {
  const events = parseICS(GOOGLE_FEED, { windowStart: WINDOW_START, windowEnd: WINDOW_END, source: 'personal' });
  const busn = events.filter((e) => e.uid === 'class-busn5000');
  assert.ok(busn.length > 5, 'should expand many occurrences');
  const days = new Set(busn.map((e) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(e.start)));
  assert.deepEqual([...days].sort(), ['Thu', 'Tue'], 'BUSN 5000 meets only Tuesday and Thursday');
});

test('honours EXDATE cancellations', () => {
  const events = parseICS(GOOGLE_FEED, { windowStart: WINDOW_START, windowEnd: WINDOW_END, source: 'personal' });
  const sep1 = events.filter(
    (e) => e.uid === 'class-mgmt5850' &&
      new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: '2-digit', day: '2-digit' }).format(e.start) === '09/01'
  );
  assert.equal(sep1.length, 0, 'the Sep 1 MGMT 5850 meeting was excluded via EXDATE');
});

test('RECURRENCE-ID override replaces the base occurrence', () => {
  const events = parseICS(GOOGLE_FEED, { windowStart: WINDOW_START, windowEnd: WINDOW_END, source: 'personal' });
  const aug24 = events.filter(
    (e) => e.uid === 'class-mgmt5560' &&
      new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: '2-digit', day: '2-digit' }).format(e.start) === '08/24'
  );
  assert.equal(aug24.length, 1, 'exactly one event on Aug 24, not the base plus the override');
  assert.match(aug24[0].summary, /GUEST SPEAKER/, 'the override wins');
});

test('skips CANCELLED events', () => {
  const events = parseICS(GOOGLE_FEED, { windowStart: WINDOW_START, windowEnd: WINDOW_END, source: 'personal' });
  assert.equal(events.filter((e) => e.uid === 'cancelled-thing').length, 0);
});

test('drops D2L "Available" noise and collapses Due/Availability Ends pairs', async () => {
  const { events } = await load();
  const { deadlines } = normalizeEvents(events);

  const land = deadlines.filter((d) => d.course && d.course.code === 'LAND2510');
  assert.equal(land.length, 3, 'three LAND quizzes, not nine rows');
  assert.ok(land.every((d) => d.kind === 'due'), 'the "Due" variant should win over "Availability Ends"');

  const hwNoise = deadlines.filter((d) => d.title.startsWith('HW1'));
  assert.equal(hwNoise.length, 0, '"HW1 - Available" is an open date, not a deadline');
});

test('assigns events to courses from summary or location', async () => {
  const { events } = await load();
  const { deadlines } = normalizeEvents(events);
  const byCode = (c) => deadlines.filter((d) => d.course && d.course.code === c);

  assert.equal(byCode('MGMT4280').length, 1, 'the Semester Start Quiz matches via its D2L location string');
  assert.ok(byCode('BUSN5000').length >= 1, 'pre-Project exercise matches via its summary');
});

test('builds a scoped LAND 2510E briefing with the quizzes due Saturday', async () => {
  const { events, health } = await load();
  const status = buildStatus({ events, now: NOW, course: resolveCourse('LAND2510'), health });

  assert.equal(status.due_this_week.length, 3);
  assert.ok(status.due_this_week.every((d) => d.days_away === 3), 'Wed -> Sat is three days out');
  assert.match(status.briefing, /Quiz 01/);
  assert.equal(status.data_warning, null);
  assert.ok(status.other_courses_this_week.length > 0, 'competing load from other courses should be visible');
});

test('BUSN 5000 briefing surfaces the hard pre-Project deadline and tomorrow\'s class', async () => {
  const { events, health } = await load();
  const status = buildStatus({ events, now: NOW, course: resolveCourse('busn 5000'), health });

  const pre = status.due_this_week.find((d) => /pre-Project/.test(d.title));
  assert.ok(pre, 'pre-Project exercise should be inside the 7-day window');
  assert.equal(pre.days_away, 7);

  assert.ok(status.classes_tomorrow.some((c) => /BUSN 5000/.test(c.course)), 'Thursday Aug 20 is a class day');
  assert.equal(status.course.ai_policy, 'encouraged');
});

test('courses that ban AI carry the restriction into the briefing text', async () => {
  const { events, health } = await load();
  const status = buildStatus({ events, now: NOW, course: resolveCourse('MGMT5850'), health });
  assert.match(status.briefing, /do not draft deliverables/i);
  assert.equal(status.course.ai_policy, 'banned-on-assignments');
});

test('an unscoped request covers every course', async () => {
  const { events, health } = await load();
  const status = buildStatus({ events, now: NOW, course: null, health });
  const codes = new Set([...status.due_this_week, ...status.due_today].map((d) => d.course_code));
  assert.ok(codes.has('LAND2510') && codes.has('MGMT4280'), 'all courses present when unscoped');
  assert.equal(status.other_courses_this_week.length, 0, 'nothing is "other" when nothing is scoped');
});

test('a failing feed degrades loudly rather than looking like an empty schedule', async () => {
  const brokenStub = makeFetchStub({ 'https://google.test/feed.ics': GOOGLE_FEED });
  const { events, health } = await load(brokenStub);
  const status = buildStatus({ events, now: NOW, course: resolveCourse('LAND2510'), health });

  assert.ok(status.data_warning, 'a warning must be present');
  assert.match(status.briefing, /did not load/i);
  assert.equal(health.find((h) => h.source === 'elc').ok, false);
});

test('a Claude note is carried through to the briefing', async () => {
  const { events, health } = await load();
  const note = { text: 'We mapped out the week and you were about to take the LAND quizzes.', at: '2026-08-19T22:00:00Z', at_local: 'Wed 6:00 PM' };
  const status = buildStatus({ events, now: NOW, course: resolveCourse('LAND2510'), note, health });
  assert.match(status.briefing, /Last note from Claude/);
  assert.match(status.briefing, /LAND quizzes/);
});

test('resolveCourse accepts loose input', () => {
  assert.equal(resolveCourse('busn5000').code, 'BUSN5000');
  assert.equal(resolveCourse('BUSN 5000').code, 'BUSN5000');
  assert.equal(resolveCourse('MGMT 5850').code, 'MGMT5850');
  assert.equal(resolveCourse('land2510e'), null, 'the E suffix is not part of the code');
  assert.equal(resolveCourse('nonsense'), null);
});

test('a transient feed failure is retried before being reported as broken', async () => {
  let calls = 0;
  const flaky = async (url) => {
    if (url === 'https://d2l.test/feed.ics') {
      calls++;
      if (calls === 1) return { ok: false, status: 429, text: async () => '' };  // throttled once
      return { ok: true, status: 200, text: async () => D2L_FEED };
    }
    return { ok: true, status: 200, text: async () => GOOGLE_FEED };
  };
  const { health } = await load(flaky);
  const elc = health.find((h) => h.source === 'elc');
  assert.equal(elc.ok, true, 'the retry should succeed');
  assert.equal(elc.retried, true, 'and it should record that a retry was needed');
  assert.equal(calls, 2);
});

test('a feed that is down for both attempts is still reported broken', async () => {
  const dead = async (url) =>
    url === 'https://google.test/feed.ics'
      ? { ok: true, status: 200, text: async () => GOOGLE_FEED }
      : { ok: false, status: 500, text: async () => '' };
  const { health } = await load(dead);
  assert.equal(health.find((h) => h.source === 'elc').ok, false);
});

test('other courses stay quiet unless something is due within 48 hours', async () => {
  const { events, health } = await load();
  // Wed Aug 19: LAND quizzes are 3 days out, so nothing in another course is urgent.
  const calm = buildStatus({ events, now: NOW, course: resolveCourse('BUSN5000'), health });
  assert.doesNotMatch(calm.briefing, /Quiz 01/, 'a non-urgent other-course item must not be named');
  assert.match(calm.briefing, /do not list them unless he asks/);
  assert.ok(calm.other_courses_this_week.length > 0, 'but the data is still available on request');

  // Fri Aug 21: the same quizzes are now one day out and worth interrupting for.
  const urgent = buildStatus({
    events, now: new Date('2026-08-21T14:00:00Z'), course: resolveCourse('BUSN5000'), health,
  });
  assert.match(urgent.briefing, /due within 48h/);
  assert.match(urgent.briefing, /Quiz 01/);
});

// --- daylight saving boundary -------------------------------------------------
// US DST ends Sunday Nov 1 2026, mid-semester. An 11:59 PM Eastern deadline before
// that date is UTC-4; after it, UTC-5. A fixed offset would silently move late-
// semester deadlines onto the wrong day.

const DST_FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:dst-before',
  'DTSTART;TZID=America/New_York:20261025T235900',
  'DTEND;TZID=America/New_York:20261025T235900',
  'SUMMARY:LAND 2510E Quiz Before DST Due',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:dst-after',
  'DTSTART;TZID=America/New_York:20261108T235900',
  'DTEND;TZID=America/New_York:20261108T235900',
  'SUMMARY:LAND 2510E Quiz After DST Due',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const fmtLocal = (d) => new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(d);

test('an 11:59 PM Eastern deadline stays on its own day across the DST change', () => {
  const events = parseICS(DST_FEED, {
    windowStart: new Date('2026-10-01T00:00:00Z'),
    windowEnd: new Date('2026-12-01T00:00:00Z'),
    source: 'elc',
  });

  const before = events.find((e) => e.uid === 'dst-before');
  const after = events.find((e) => e.uid === 'dst-after');
  assert.ok(before && after, 'both DST-boundary events should parse');

  // Neither should slip to the following day.
  assert.equal(fmtLocal(before.start), '10/25, 23:59');
  assert.equal(fmtLocal(after.start), '11/08, 23:59');

  // And the underlying instants must use different UTC offsets: EDT then EST.
  assert.equal(before.start.toISOString(), '2026-10-26T03:59:00.000Z', 'EDT is UTC-4');
  assert.equal(after.start.toISOString(), '2026-11-09T04:59:00.000Z', 'EST is UTC-5');
});
