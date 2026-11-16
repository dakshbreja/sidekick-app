import { test } from 'node:test';
import assert from 'node:assert/strict';

import { identityKey, snapshotOf, diffSnapshots, mergeChangeLog, describeChange } from '../src/changes.js';

const course = (code) => ({ code, label: code });
const d = (uid, title, code, iso) => ({ uid, title, course: course(code), start: new Date(iso) });

const W_START = new Date('2026-08-10T00:00:00Z');
const W_END = new Date('2026-09-25T00:00:00Z');
const snap = (items, s = W_START, e = W_END) => snapshotOf(items, s, e);

test('identity prefers the iCal UID and falls back to course+title', () => {
  assert.equal(identityKey(d('abc', 'Quiz 01', 'LAND2510', '2026-08-22T03:59:00Z')), 'uid:abc');
  const noUid = { title: 'Quiz 01', course: course('LAND2510'), start: new Date() };
  assert.equal(identityKey(noUid), 'tc:LAND2510|quiz 01');
});

test('a moved deadline is detected', () => {
  const prev = snap([d('q1', 'Quiz 01', 'LAND2510', '2026-08-22T03:59:00Z')]);
  const next = snap([d('q1', 'Quiz 01', 'LAND2510', '2026-08-27T03:59:00Z')]);
  const changes = diffSnapshots(prev, next);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'moved');
  assert.equal(changes[0].from, '2026-08-22T03:59:00.000Z');
  assert.equal(changes[0].to, '2026-08-27T03:59:00.000Z');
});

test('a genuinely new deadline inside the old window is reported as added', () => {
  const prev = snap([]);
  const next = snap([d('new1', 'Surprise Quiz', 'MGMT4280', '2026-09-01T03:59:00Z')]);
  const changes = diffSnapshots(prev, next);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'added');
});

test('an item the window merely slid over is NOT reported as added', () => {
  // Previous window ended Sep 25; this item is due Oct 5, so last time we simply
  // could not have seen it. That is the window moving, not the professor.
  const prev = snap([]);
  const next = snap(
    [d('far', 'Later Exam', 'MGMT4280', '2026-10-05T03:59:00Z')],
    new Date('2026-08-20T00:00:00Z'),
    new Date('2026-10-06T00:00:00Z')
  );
  assert.deepEqual(diffSnapshots(prev, next), []);
});

test('a deadline that disappears while still in range is reported as removed', () => {
  const prev = snap([d('gone', 'Cancelled Quiz', 'LAND2510', '2026-09-01T03:59:00Z')]);
  const next = snap([]);
  const changes = diffSnapshots(prev, next);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'removed');
  assert.equal(changes[0].title, 'Cancelled Quiz');
});

test('an item that merely aged out of the back of the window is NOT reported as removed', () => {
  const prev = snap([d('old', 'Old Quiz', 'LAND2510', '2026-08-11T03:59:00Z')]);
  // Window has moved on; Aug 11 is now before it starts.
  const next = snap([], new Date('2026-08-20T00:00:00Z'), new Date('2026-10-06T00:00:00Z'));
  assert.deepEqual(diffSnapshots(prev, next), []);
});

test('a renamed deadline is detected without being reported as add plus remove', () => {
  const prev = snap([d('r1', 'Quiz 1', 'LAND2510', '2026-09-01T03:59:00Z')]);
  const next = snap([d('r1', 'Quiz 01 _Origins', 'LAND2510', '2026-09-01T03:59:00Z')]);
  const changes = diffSnapshots(prev, next);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'renamed');
});

test('the very first run has no baseline and reports nothing', () => {
  assert.deepEqual(diffSnapshots(null, snap([d('a', 'x', 'LAND2510', '2026-09-01T00:00:00Z')])), []);
});

test('the same change is not logged twice', () => {
  const c = { type: 'moved', key: 'uid:q1', course: 'LAND2510', title: 'Quiz 01', from: 'A', to: 'B' };
  const once = mergeChangeLog([], [c], '2026-08-21T00:00:00Z');
  const twice = mergeChangeLog(once, [c], '2026-08-21T01:00:00Z');
  assert.equal(once.length, 1);
  assert.equal(twice.length, 1);
});

test('the change log drops entries older than the retention window', () => {
  const old = { type: 'moved', key: 'uid:old', title: 'Ancient', from: 'A', to: 'B', at: '2026-06-01T00:00:00Z' };
  const merged = mergeChangeLog([old], [], '2026-08-21T00:00:00Z');
  assert.equal(merged.length, 0);
});

test('changes are described in plain language', () => {
  const when = (dt) => dt.toISOString().slice(0, 10);
  assert.match(
    describeChange({ type: 'moved', course: 'LAND2510', title: 'Quiz 01', from: '2026-08-22T00:00:00Z', to: '2026-08-27T00:00:00Z' }, when),
    /LAND2510 "Quiz 01" moved from 2026-08-22 to 2026-08-27/
  );
  assert.match(
    describeChange({ type: 'removed', course: 'MGMT4280', title: 'Lab 1', from: '2026-09-01T00:00:00Z' }, when),
    /disappeared from the calendar/
  );
});
