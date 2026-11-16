import test from 'node:test';
import assert from 'node:assert/strict';
import { parseICS } from '../src/ics.js';

const calendar = (...events) => `BEGIN:VCALENDAR\n${events.map(event => `BEGIN:VEVENT\n${event}\nEND:VEVENT`).join('\n')}\nEND:VCALENDAR`;
const parse = (text, start = '2026-10-01T00:00:00Z', end = '2026-12-01T00:00:00Z', extra = {}) => parseICS(text, { windowStart: new Date(start), windowEnd: new Date(end), source: 'personal', ...extra });
const isoStarts = events => events.map(event => event.start.toISOString());

test('weekly classes preserve their New York wall time across November 1', () => {
  const events = parse(calendar('UID:dst\nDTSTART;TZID=America/New_York:20261025T090000\nDTEND;TZID=America/New_York:20261025T100000\nRRULE:FREQ=WEEKLY;COUNT=3\nSUMMARY:Class'));
  assert.deepEqual(isoStarts(events), ['2026-10-25T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-08T14:00:00.000Z']);
  assert.ok(events.every(event => event.end - event.start === 3600000));
});

test('the event timezone controls recurrence even when the calendar default differs', () => {
  const events = parse(calendar('UID:tokyo\nDTSTART;TZID=Asia/Tokyo:20261031T003000\nRRULE:FREQ=DAILY;COUNT=3\nSUMMARY:Call'));
  assert.deepEqual(isoStarts(events), ['2026-10-30T15:30:00.000Z', '2026-10-31T15:30:00.000Z', '2026-11-01T15:30:00.000Z']);
  assert.ok(events.every(event => event.end === null));
});

test('UTC recurrence retains UTC times through local DST', () => {
  const events = parse(calendar('UID:utc\nDTSTART:20261031T130000Z\nRRULE:FREQ=DAILY;COUNT=3'));
  assert.deepEqual(isoStarts(events), ['2026-10-31T13:00:00.000Z', '2026-11-01T13:00:00.000Z', '2026-11-02T13:00:00.000Z']);
});

test('a moved occurrence remains recurring, preserves its original identity, and honors EXDATE after DST', () => {
  const events = parse(calendar(
    'UID:class\nDTSTART;TZID=America/New_York:20261025T090000\nRRULE:FREQ=WEEKLY;COUNT=4\nEXDATE;TZID=America/New_York:20261108T090000\nSUMMARY:Original',
    'UID:class\nRECURRENCE-ID;TZID=America/New_York:20261101T090000\nDTSTART;TZID=America/New_York:20261102T110000\nSUMMARY:Moved',
  ));
  assert.equal(events.length, 3);
  const moved = events.find(event => event.summary === 'Moved');
  assert.equal(moved.recurring, true);
  assert.equal(moved.recurrence_anchor, '2026-11-01T14:00:00.000Z');
  assert.equal(moved.start.toISOString(), '2026-11-02T16:00:00.000Z');
  assert.equal(events.some(event => event.start.toISOString() === '2026-11-08T14:00:00.000Z'), false);
});

test('floating recurrence IDs use the parent timezone rather than the display timezone', () => {
  const events = parse(calendar(
    'UID:tokyo\nDTSTART;TZID=Asia/Tokyo:20261030T090000\nRRULE:FREQ=DAILY;COUNT=2',
    'UID:tokyo\nRECURRENCE-ID:20261031T090000\nDTSTART;TZID=Asia/Tokyo:20261031T110000',
  ));
  assert.equal(events.length, 2);
  assert.equal(events[1].recurrence_anchor, '2026-10-31T00:00:00.000Z');
});

test('cancelled overrides suppress the original without needing their own start', () => {
  const events = parse(calendar(
    'UID:cancel\nDTSTART;TZID=America/New_York:20261025T090000\nRRULE:FREQ=WEEKLY;COUNT=2',
    'UID:cancel\nRECURRENCE-ID;TZID=America/New_York:20261101T090000\nSTATUS:CANCELLED',
  ));
  assert.deepEqual(isoStarts(events), ['2026-10-25T13:00:00.000Z']);
});

test('all-day recurrence keeps exclusive local midnight ends across DST', () => {
  const events = parse(calendar('UID:all-day\nDTSTART;VALUE=DATE:20261031\nDTEND;VALUE=DATE:20261101\nRRULE:FREQ=DAILY;COUNT=3'));
  assert.deepEqual(events.map(event => [event.start.toISOString(), event.end.toISOString()]), [
    ['2026-10-31T04:00:00.000Z', '2026-11-01T04:00:00.000Z'],
    ['2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z'],
    ['2026-11-02T05:00:00.000Z', '2026-11-03T05:00:00.000Z'],
  ]);
});

test('an all-day event without DTEND occupies one local day; a timed event stays unspecified', () => {
  const events = parse(calendar('UID:date\nDTSTART;VALUE=DATE:20261101', 'UID:time\nDTSTART:20261101T120000Z'));
  assert.equal(events[0].end.toISOString(), '2026-11-02T05:00:00.000Z');
  assert.equal(events[1].end, null);
});

test('DURATION adds nominal days before exact hours across DST', () => {
  const events = parse(calendar('UID:duration\nDTSTART;TZID=America/New_York:20261031T090000\nDURATION:P1DT2H\nRRULE:FREQ=DAILY;COUNT=2'));
  assert.equal(events[0].end.toISOString(), '2026-11-01T16:00:00.000Z');
  assert.equal(events[1].end.toISOString(), '2026-11-02T16:00:00.000Z');
  assert.equal(events[0].end - events[0].start, 27 * 3600000);
});

test('events overlapping the window are included and exclusive end at its start is excluded', () => {
  const events = parse(calendar(
    'UID:ongoing\nDTSTART;VALUE=DATE:20261030\nDTEND;VALUE=DATE:20261103',
    'UID:ended\nDTSTART;VALUE=DATE:20261030\nDTEND;VALUE=DATE:20261101',
    'UID:series\nDTSTART;VALUE=DATE:20261029\nDTEND;VALUE=DATE:20261102\nRRULE:FREQ=WEEKLY;COUNT=1',
  ), '2026-11-01T04:00:00Z', '2026-11-01T20:00:00Z');
  assert.deepEqual(events.map(event => event.uid), ['series', 'ongoing']);
});

test('MONTHLY negative month days and ordinal weekdays respect actual month lengths', () => {
  const events = parse(calendar(
    'UID:last-day\nDTSTART;TZID=America/New_York:20260831T090000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=4',
    'UID:last-mon\nDTSTART;TZID=America/New_York:20260831T100000\nRRULE:FREQ=MONTHLY;BYDAY=-1MO;COUNT=4',
  ), '2026-08-01T00:00:00Z', '2026-12-01T00:00:00Z');
  assert.deepEqual(isoStarts(events.filter(event => event.uid === 'last-day')), ['2026-08-31T13:00:00.000Z', '2026-09-30T13:00:00.000Z', '2026-10-31T13:00:00.000Z', '2026-11-30T14:00:00.000Z']);
  assert.deepEqual(isoStarts(events.filter(event => event.uid === 'last-mon')), ['2026-08-31T14:00:00.000Z', '2026-09-28T14:00:00.000Z', '2026-10-26T14:00:00.000Z', '2026-11-30T15:00:00.000Z']);
});

test('yearly BYMONTH and ordinal BYDAY preserve holidays through the bounded view', () => {
  const events = parse(calendar('UID:holiday\nDTSTART;VALUE=DATE:20251127\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;COUNT=3'), '2026-01-01T00:00:00Z', '2028-01-01T00:00:00Z');
  assert.deepEqual(isoStarts(events), ['2026-11-26T05:00:00.000Z', '2027-11-25T05:00:00.000Z']);
});

test('weekly interval uses Monday by default and explicit WKST when supplied', () => {
  const body = 'UID:wkst\nDTSTART:20261025T090000Z\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;COUNT=4';
  assert.deepEqual(isoStarts(parse(calendar(body))), ['2026-10-25T09:00:00.000Z', '2026-11-02T09:00:00.000Z', '2026-11-08T09:00:00.000Z', '2026-11-16T09:00:00.000Z']);
  assert.deepEqual(isoStarts(parse(calendar(`${body};WKST=SU`))), ['2026-10-25T09:00:00.000Z', '2026-10-26T09:00:00.000Z', '2026-11-08T09:00:00.000Z', '2026-11-09T09:00:00.000Z']);
});

test('spring-gap occurrences are skipped without consuming COUNT, while repeated autumn time chooses first', () => {
  const spring = parse(calendar('UID:gap\nDTSTART;TZID=America/New_York:20260307T023000\nRRULE:FREQ=DAILY;COUNT=3'), '2026-03-01T00:00:00Z', '2026-03-20T00:00:00Z');
  assert.deepEqual(isoStarts(spring), ['2026-03-07T07:30:00.000Z', '2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z']);
  const autumn = parse(calendar('UID:overlap\nDTSTART;TZID=Europe/Berlin:20261025T023000'));
  assert.equal(autumn[0].start.toISOString(), '2026-10-25T00:30:00.000Z');
});

test('RDATE adds occurrences without duplicates and EXDATE still removes them', () => {
  const events = parse(calendar('UID:rdate\nDTSTART:20261031T130000Z\nRRULE:FREQ=DAILY;COUNT=2\nRDATE:20261101T130000Z,20261103T130000Z\nEXDATE:20261103T130000Z'));
  assert.deepEqual(isoStarts(events), ['2026-10-31T13:00:00.000Z', '2026-11-01T13:00:00.000Z']);
});

test('unsupported rules warn even when the base lies outside the view, without exposing source text', () => {
  const events = parse(calendar('UID:private-id\nSUMMARY:Private title\nDTSTART:20260101T130000Z\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'));
  assert.equal(events.length, 0);
  assert.deepEqual(events.warnings, [{ code: 'unsupported_recurrence:BYSETPOS', count: 1 }]);
  assert.doesNotMatch(JSON.stringify(events.warnings), /private-id|Private title/);
});

test('long-running series do not silently stop after the former 800-day bound', () => {
  const events = parse(calendar('UID:old\nDTSTART:20100104T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO'), '2026-11-01T00:00:00Z', '2026-11-15T00:00:00Z');
  assert.deepEqual(isoStarts(events), ['2026-11-02T09:00:00.000Z', '2026-11-09T09:00:00.000Z']);
  assert.deepEqual(events.warnings, []);
});

test('invalid civil dates, end values and duration cannot silently roll into another obligation', () => {
  for (const start of ['20260230T090000Z', '20260229T090000Z', '20261301T090000Z', '20261101T240000Z', '20261101T096000Z', '20260230']) {
    assert.throws(() => parse(calendar(`UID:bad\nDTSTART:${start}`)), /invalid_event_start/);
  }
  assert.throws(() => parse(calendar('UID:bad\nDTSTART:20261101T090000Z\nDTEND:20260230T090000Z')), /invalid_event_end/);
  assert.throws(() => parse(calendar('UID:bad\nDTSTART:20261101T090000Z\nDURATION:P1M')), /invalid_event_duration/);
});
