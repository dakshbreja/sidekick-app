// A reviewed original-course announcement can correct a stale calendar date.
// The exact source occurrence remains the assignment: neither title similarity
// nor a copied deadline is an authority, and a later unexpected source edit
// invalidates the correction instead of being overwritten on every read.
import { TERM_ID, eventIdentity } from './identity.js';
import { courseForEvent } from './courses.js';

const zone = 'America/New_York';
const dayFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
});
const validDate = value => {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(+date) ? date : null;
};
const iso = value => validDate(value)?.toISOString() || null;
function day(date) {
  const parts = Object.fromEntries(dayFormat.formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function intersects(start, end, windowStart, windowEnd) {
  return start < windowEnd && (end && end > start ? end > windowStart : start >= windowStart);
}
function identity(record) {
  return eventIdentity({ uid: record.uid, source: record.source,
    course: { code: record.course_code }, recurrence_anchor: record.recurrence_anchor || '' });
}
function reviewed(record) {
  const original = record?.original || {}, effective = record?.effective || {};
  return record?.term_id === TERM_ID && record.id && record.uid && record.course_code && record.source &&
    validDate(original.start_iso) && validDate(effective.start_iso) &&
    (!original.end_iso || validDate(original.end_iso) >= validDate(original.start_iso)) &&
    (!effective.end_iso || validDate(effective.end_iso) >= validDate(effective.start_iso)) &&
    record.authority?.kind === 'instructor_announcement' && record.authority?.verified === true &&
    /^https:\/\/uga\.view\.usg\.edu\//.test(record.authority?.url || '') &&
    validDate(record.authority?.observed_at) && ['date', 'date_and_time'].includes(record.authority?.precision);
}
function relevant(record, windowStart, windowEnd) {
  return intersects(validDate(record.original.start_iso), validDate(record.original.end_iso), windowStart, windowEnd) ||
    intersects(validDate(record.effective.start_iso), validDate(record.effective.end_iso), windowStart, windowEnd);
}
function metadata(record, event, state) {
  return {
    id: record.id, state, assignment_id: identity(record), course_code: record.course_code,
    title: record.title, source: record.source, source_when_iso: iso(event?.start),
    original_when_iso: record.original.start_iso, original_end_iso: record.original.end_iso || null,
    source_end_iso: iso(event?.end), source_all_day: event?.allDay === true,
    when_iso: state === 'applied' ? record.effective.start_iso : iso(event?.start),
    date: day(validDate(record.effective.start_iso)),
    precision: record.authority.precision,
    time_verification: state === 'applied' && record.authority.precision === 'date' ? 'unconfirmed' :
      record.authority.precision === 'date_and_time' ? 'announcement_confirmed' : 'calendar_only',
    authority: { kind: record.authority.kind, title: record.authority.title,
      url: record.authority.url, published_at: record.authority.published_at || null,
      observed_at: record.authority.observed_at,
      ...(record.authority.automatic===true?{automatic:true,announcement_id:record.authority.announcement_id,
        content_sha256:record.authority.content_sha256,modified_at:record.authority.modified_at||null,
        feed_published_at:record.authority.feed_published_at||null}:{}) },
  };
}

/** Include the original occurrence if its corrected date enters this window. */
export function reconciliationWindow(source, windowStart, windowEnd, corrections = []) {
  let start = windowStart, end = windowEnd;
  for (const record of corrections.filter(reviewed)) {
    if (record.source !== source || !relevant(record, windowStart, windowEnd)) continue;
    const originalStart = validDate(record.original.start_iso), originalEnd = validDate(record.original.end_iso) || originalStart;
    if (originalStart < start) start = originalStart;
    if (originalEnd >= end) end = new Date(+originalEnd + 1);
  }
  return { windowStart: start, windowEnd: end };
}

/** Correct only a reviewed exact occurrence, then restore the requested bounds. */
export function reconcileDates(events, { source, windowStart, windowEnd, corrections = [] }) {
  const candidates = corrections.filter(record => reviewed(record) && record.source === source && relevant(record, windowStart, windowEnd));
  const registry = new Map(), notes = [], conflicts = [];
  for (const record of candidates) {
    const key = identity(record);
    if (!registry.has(key)) registry.set(key, []);
    registry.get(key).push(record);
  }
  const matched = new Set();
  const sourceCounts = new Map();
  for (const event of events) {
    const key = eventIdentity({ ...event, course: courseForEvent(event) });
    sourceCounts.set(key, (sourceCounts.get(key) || 0) + 1);
  }
  const reconciled = events.map(event => {
    const key = eventIdentity({ ...event, course: courseForEvent(event) });
    const records = registry.get(key);
    if (!records?.length) return event;
    const record = records[0];
    if (sourceCounts.get(key) > 1) {
      if (!matched.has(key)) conflicts.push({ ...metadata(record, event, 'conflict'), reason: 'ambiguous_source_occurrence' });
      matched.add(key); return event;
    }
    matched.add(key);
    if (records.length > 1) {
      conflicts.push({ ...metadata(record, event, 'conflict'), reason: 'multiple_reviewed_corrections' });
      return event;
    }
    // Once the provider agrees on the reviewed date, its own clock is live again.
    // A date-only announcement never claims that the exam starts at midnight.
    const aligned = record.authority.precision === 'date'
      ? day(event.start) === day(validDate(record.effective.start_iso))
      : iso(event.start) === record.effective.start_iso && iso(event.end) === (record.effective.end_iso || null);
    if (aligned) {
      const note = metadata(record, event, 'source_aligned'); notes.push(note);
      return { ...event, date_reconciliation: note };
    }
    const original = record.original;
    if (iso(event.start) !== original.start_iso || iso(event.end) !== (original.end_iso || null) ||
        (event.allDay === true) !== (original.all_day === true)) {
      conflicts.push({ ...metadata(record, event, 'conflict'), reason: 'source_occurrence_changed' });
      return event;
    }
    const note = metadata(record, event, 'applied'); notes.push(note);
    return { ...event, start: validDate(record.effective.start_iso), end: validDate(record.effective.end_iso),
      allDay: record.effective.all_day === true, date_reconciliation: note };
  });
  for (const [key, records] of registry) {
    if (matched.has(key)) continue;
    // Absence can be a legitimate removal or a filtered feed; it does not prove
    // that the parser lost coverage. Warn without recreating a calendar event
    // or preventing independent assignments from being tracked.
    notes.push({ ...metadata(records[0], null, 'source_missing'), reason: 'source_occurrence_missing' });
  }
  return {
    events: reconciled.filter(event => intersects(event.start, event.end, windowStart, windowEnd)),
    notes, conflicts,
  };
}

export function describeReconciliation(record) {
  const title = `${record.course_code} ${record.title}`;
  if (record.state === 'source_missing') return `${title}: the checked instructor announcement says ${record.date}, but this source occurrence is not in the live calendar. The bridge has not recreated it; recheck the original course source.`;
  if (record.state === 'conflict') return `${title}: the source occurrence changed or disappeared after the reviewed announcement. Recheck the original course source before relying on the date.`;
  if (record.state === 'source_aligned') return `${title}: the live calendar now agrees with the checked instructor announcement on ${record.date}.`;
  return `${title}: date corrected to ${record.date} from the checked instructor announcement. The source calendar still says ${day(validDate(record.source_when_iso))}.` +
    (record.time_verification === 'unconfirmed' ? ' The announcement confirms the date; the exam time is not confirmed.' : '');
}
