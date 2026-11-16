import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COURSES, courseForEvent, resolveCourse } from '../src/courses.js';
import { normalizeEvents, buildStatus } from '../src/status.js';
import { eventIdentity, TERM_ID } from '../src/identity.js';
import worker from '../src/worker.js';
import { sqliteFoundation } from './sqlite-fixture.js';

const event = (summary, extra = {}) => ({ uid: 'synthetic-routing-id', source: 'Google Calendar', summary,
  location: '', description: '', start: new Date('2026-10-19T23:00:00Z'),
  end: new Date('2026-10-19T23:59:00Z'), allDay: false, recurring: false, ...extra });
const code = value => courseForEvent(value)?.code || null;

test('an explicit title course wins over cross-course crunch notes and locations', () => {
  const simulated = event('MGMT 5560 — GLO-BUS Decision 5 (Year 10)', {
    description: 'MGMT 5850 Exam 2 and MGMT 4280 Exam 2 both on October 22.', location: 'Near BUSN5000 classroom',
  });
  assert.equal(code(simulated), 'MGMT5560');
  assert.equal(code(event('MGMT 5850 — Exam 2', { description: 'Same morning as MGMT4280 Exam 2' })), 'MGMT5850');
  assert.equal(code(event('MGMT 5850 — Research Part 3 due', { description: 'Finish MGMT5560 work early' })), 'MGMT5850');
});

test('recognized prefixes accept label spacing, separators and the E suffix', () => {
  for (const title of ['BUSN 3040E — check the eLC shell', 'busn3040e: class', ' BUSN_3040E — class', 'BUSN-3040E class']) {
    assert.equal(code(event(title, { description: 'MGMT4280 calendar note' })), 'BUSN3040', title);
  }
  assert.equal(code(event('LAND 2510E — Quiz 2', { description: 'BUSN5000 schedule' })), 'LAND2510');
  for (const course of COURSES) assert.equal(code(event(course.label + ' — Deadline', {
    description: COURSES.filter(other => other !== course).map(other => other.code).join(' '),
  })), course.code);
});

test('numeric-prefix collisions and extra suffix letters do not acquire explicit-title precedence', () => {
  for (const title of ['MGMT55600 unrelated code', 'MGMT 5560ABC unrelated code', 'LAND2510EE unrelated code']) {
    assert.equal(code(event(title, { description: 'BUSN5000 verified course context' })), 'BUSN5000');
  }
});

test('unlabelled eLC titles retain their existing location and description routes', () => {
  assert.equal(code(event('Semester Start Quiz - Due', { source: 'eLC (D2L)', location: 'MGMT4280 Supply Chain Analytics' })), 'MGMT4280');
  assert.equal(code(event('Test Two Administered', { source: 'eLC (D2L)', location: 'Classroom MGMT5560' })), 'MGMT5560');
  assert.equal(code(event('Quiz 01 - Due', { source: 'eLC (D2L)', description: 'BUSN5000 Introduction to Data Science' })), 'BUSN5000');
  assert.equal(code(event('Advisor meeting')), null);
});

test('the corrected course scopes the stable source identity and preserves other completion evidence', () => {
  const raw = event('MGMT 5560 — GLO-BUS Decision 5 (Year 10)', { description: 'MGMT4280 competing exam' });
  const normalized = normalizeEvents([raw]).deadlines[0];
  const correctId = eventIdentity({ ...raw, course: resolveCourse('MGMT5560') });
  const priorWrongId = eventIdentity({ ...raw, course: resolveCourse('MGMT4280') });
  assert.equal(normalized.assignment_id, correctId);
  assert.notEqual(correctId, priorWrongId);
  const progress = [{ item: raw.summary, course: 'MGMT4280', term_id: TERM_ID, assignment_id: priorWrongId,
    assignment_refs: [priorWrongId], identity_resolution: 'linked', status: 'done', verification: 'verified', evidence: 'synthetic-wrong-course-receipt' }];
  const before = structuredClone(progress);
  const status = buildStatus({ events: [raw], now: new Date('2026-10-10T18:00:00Z'), progress,
    health: [{ source: 'Google Calendar', ok: true }] });
  assert.equal(status.upcoming[0].course_code, 'MGMT5560');
  assert.notEqual(status.upcoming[0].completed, true, 'a mis-scoped report must not silently clear another course');
  assert.equal(status.actionable.counts.outstanding, 1);
  assert.deepEqual(progress, before, 'classification never rewrites progress or verification evidence');
});

test('a source-course model correction establishes a baseline without false cancellation or addition notices', async () => {
  const foundation = sqliteFoundation(), store = new Map(), current = new Date();
  const start = new Date(+current + 2 * 86400000), end = new Date(+start + 3600000);
  const uid = 'synthetic-course-baseline';
  const priorId = eventIdentity({ uid, source: 'Google Calendar', course: resolveCourse('MGMT4280') });
  const correctedId = eventIdentity({ uid, source: 'Google Calendar', course: resolveCourse('MGMT5560') });
  store.set('snapshot:deadlines', JSON.stringify({ normalization_version: 2,
    window: { start: new Date(+current - 10 * 86400000).toISOString(), end: new Date(+current + 45 * 86400000).toISOString() },
    items: [{ key: 'assignment:' + priorId, title: 'MGMT 5560 — GLO-BUS Decision 5', course: 'MGMT4280', due: start.toISOString() }],
  }));
  const existingChanges = JSON.stringify([{ type: 'moved', key: 'historical-source', course: 'BUSN5000',
    title: 'A previously reported change', from: current.toISOString(), to: start.toISOString(), at: current.toISOString() }]);
  store.set('changes:log', existingChanges);
  const env = { API_KEY: 'synthetic-course-routing-key', BRIDGE_STATE: foundation.binding,
    NOTES: { get: async key => store.get(key) || null, put: async (key, value) => store.set(key, value) },
    FEED_ELC: 'https://synthetic.test/elc', FEED_PERSONAL: 'https://synthetic.test/google' };
  const stamp = date => date.toISOString().replaceAll('-', '').replaceAll(':', '').replace(/\.\d+Z$/, 'Z');
  const emptyFeed = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR';
  const googleFeed = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:' + uid +
    '\r\nSUMMARY:MGMT 5560 — GLO-BUS Decision 5\r\nDESCRIPTION:Competing MGMT4280 exam\r\nDTSTART:' + stamp(start) +
    '\r\nDTEND:' + stamp(end) + '\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => new Response(String(url).endsWith('/google') ? googleFeed : emptyFeed);
  try {
    const response = await worker.fetch(new Request('https://bridge.test/status', {
      headers: { Authorization: 'Bearer ' + env.API_KEY, 'X-Bridge-Client': 'dashboard' },
    }), env);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.due_this_week[0].course_code, 'MGMT5560');
    const next = JSON.parse(store.get('snapshot:deadlines'));
    assert.equal(next.normalization_version, 3);
    assert.equal(next.items[0].key, 'assignment:' + correctedId);
    assert.equal(store.get('changes:log'), existingChanges);
    assert.deepEqual(data.recent_changes.map(change => change.type), ['moved']);
    assert.equal((await foundation.stub.list('progress', COURSES.map(course => course.code))).records.length, 0);
  } finally { globalThis.fetch = originalFetch; foundation.close(); }
});
