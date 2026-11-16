import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadEvents, buildStatus } from '../src/status.js';
import { resolveCourse } from '../src/courses.js';
import { OPTIONAL_ITEMS, optionalFor, UNCOVERED } from '../src/optional.js';
import { D2L_FEED, GOOGLE_FEED, makeFetchStub } from './fixtures.js';

const NOW = new Date('2026-08-19T22:40:00Z'); // Wed Aug 19, 6:40 PM Eastern
const stub = makeFetchStub({ a: D2L_FEED, b: GOOGLE_FEED });

async function statusFor(code, now = NOW) {
  const { events, health } = await loadEvents(
    [{ name: 'elc', url: 'a' }, { name: 'personal', url: 'b' }],
    { windowStart: new Date('2026-08-09'), windowEnd: new Date('2026-12-15'), fetchImpl: stub }
  );
  return buildStatus({ events, now, course: resolveCourse(code), health });
}

test('the catalog is internally well-formed', () => {
  const kinds = new Set(['reading', 'watch', 'listen', 'practice', 'bonus']);
  for (const it of OPTIONAL_ITEMS) {
    assert.ok(kinds.has(it.kind), `unknown kind "${it.kind}" on "${it.title}"`);
    assert.match(it.from, /^\d{4}-\d{2}-\d{2}$/, `bad from date on "${it.title}"`);
    assert.match(it.to, /^\d{4}-\d{2}-\d{2}$/, `bad to date on "${it.title}"`);
    assert.ok(it.from <= it.to, `inverted window on "${it.title}"`);
    assert.ok(resolveCourse(it.course), `unknown course "${it.course}"`);
  }
});

test('window overlap includes items spanning today, not just starting today', () => {
  // Aug 19 sits inside the Weeks 6-7 style multi-week blocks and inside Week 0.
  const { dated } = optionalFor(resolveCourse('BUSN5000'), 20260819, 20260826);
  const titles = dated.map((d) => d.title).join(' | ');
  assert.match(titles, /Healy ch\. 2/, 'Week 0 block spans Aug 17-21 and must still surface on Aug 19');
  assert.match(titles, /Békés–Kézdi chs\. 2-3/, 'Week 1 starts Aug 24, inside the 7-day window');
});

test('BUSN 5000 surfaces readings, a podcast and ungraded homework', async () => {
  const s = await statusFor('BUSN5000');
  const kinds = new Set(s.optional_this_week.map((i) => i.kind));
  assert.ok(kinds.has('reading') && kinds.has('listen') && kinds.has('practice'));
  assert.match(s.briefing, /Ask him directly whether he wants to do any of these/);
});

test('the 3Blue1Brown Bayes video surfaces in exam week', async () => {
  const s = await statusFor('BUSN5000', new Date('2026-09-22T14:00:00Z'));
  const video = s.optional_this_week.find((i) => i.kind === 'watch');
  assert.ok(video, 'a video should be listed');
  assert.match(video.title, /3Blue1Brown/);
});

test('optional-but-graded items are flagged as carrying points', async () => {
  const s = await statusFor('BUSN5000', new Date('2026-09-29T14:00:00Z'));
  const bonus = s.optional_this_week.find((i) => i.graded);
  assert.ok(bonus, 'the Progress Check should appear');
  assert.match(bonus.title, /Progress Check/);
  assert.match(s.briefing, /carries actual points despite being optional/);
});

test('standing items appear for courses that have them', async () => {
  const s = await statusFor('MGMT5560');
  const titles = s.optional_ongoing.map((i) => i.title).join(' | ');
  assert.match(titles, /before every class/);
  assert.match(titles, /End-of-chapter quizzes/, 'the extra-credit quizzes are easy to forget and must be surfaced');
  assert.ok(s.optional_ongoing.some((i) => i.kind === 'bonus'));
});

test('MGMT 5850 chapter readings track the syllabus week', async () => {
  const s = await statusFor('MGMT5850', new Date('2026-10-14T14:00:00Z'));
  assert.match(s.optional_this_week.map((i) => i.title).join(' | '), /ch\. 9/);
});

test('untranscribed courses report a coverage gap instead of looking empty', async () => {
  const s = await statusFor('LAND2510');
  assert.equal(s.optional_this_week.length, 0);
  assert.ok(s.optional_not_tracked, 'must not silently imply there is no reading');
  assert.match(s.briefing, /Coverage gap/);
  assert.equal(s.optional_not_tracked, UNCOVERED.LAND2510);
});

test('scoping holds: one course never sees another course\'s optional work', async () => {
  const s = await statusFor('MGMT5850');
  assert.ok(s.optional_this_week.every((i) => i.course === 'MGMT5850'));
});

test('MGMT 4280 AI policy matches the syllabus', () => {
  assert.equal(resolveCourse('MGMT4280').aiPolicy, 'encouraged');
});

test('self-generated optional calendar events are not re-counted as deadlines', async () => {
  // These events exist on the real Google Calendar; reading them back must not
  // turn optional reading into a fake deadline.
  const { parseICS } = await import('../src/ics.js');
  const { normalizeEvents } = await import('../src/status.js');
  const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:auto-1
SUMMARY:◦ BUSN 5000 optional — Wk1: BK chs.2-3 + HW2
DESCRIPTION:[auto:gpt-status-bridge] OPTIONAL. Some reading.
DTSTART;VALUE=DATE:20260824
DTEND;VALUE=DATE:20260829
END:VEVENT
BEGIN:VEVENT
UID:real-1
SUMMARY:BUSN 5000 — pre-Project exercise DUE (hard deadline)
DTSTART;VALUE=DATE:20260826
DTEND;VALUE=DATE:20260827
END:VEVENT
END:VCALENDAR`;
  const events = parseICS(ics, { windowStart: new Date('2026-08-01'), windowEnd: new Date('2026-09-30'), source: 'personal' });
  const { deadlines } = normalizeEvents(events);
  assert.equal(deadlines.length, 1, 'only the real deadline survives');
  assert.match(deadlines[0].title, /pre-Project/);
});
