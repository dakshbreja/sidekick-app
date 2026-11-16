// A read-only calendar projection and daily briefing from the same live inputs
// as /status. No calendar writes, inferred submissions, or separate deadline store.
import { courseForEvent, resolveCourse } from './courses.js';
import { eventIdentity, sourceNamespace } from './identity.js';
import { AUTO_TAG, TZ, normalizeEvents, resolveCompletions, applyCompletion } from './status.js';
import { describeReconciliation } from './date-reconciliation.js';
import { reviewedModuleContainer } from './reviewed-module-relations.js';

const DAY_MS = 86400000;
const dateFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
const wallFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const titleFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric',
});
const changeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

function parts(formatter, date) {
  return Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
}
function dateKey(date) {
  const p = parts(dateFormat, date);
  return `${p.year}-${p.month}-${p.day}`;
}
function dayNumber(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}
function shiftKey(key, days) {
  return new Date((dayNumber(key) + days) * DAY_MS).toISOString().slice(0, 10);
}
function easternMidnight(key) {
  const [y, m, d] = key.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d);
  let instant = target;
  // A calendar day can have 23 or 25 hours. Resolve the next local midnight
  // instead of adding 24 hours to an all-day event at a DST transition.
  for (let i = 0; i < 3; i++) {
    const p = parts(wallFormat, new Date(instant));
    const observed = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    const correction = target - observed;
    instant += correction;
    if (!correction) break;
  }
  return new Date(instant);
}
function validDate(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

// Calendar descriptions are not a safe place to relay raw grades, credentials,
// or lecture transcripts. Links are left to the authenticated original clients;
// this model only emits bounded plain text, including for titles and locations.
function plain(value, max = 400) {
  let text = String(value || '');
  if (/GRADEBOOK\s*:|\b(?:grades?|scores?|marks?)\s*(?:[:=]|is\b|of\b)\s*(?:\d|[A-F][+-]?\b)|\b(?:gradebook|grades?|scores?)[^\n]{0,60}\d[^\n]{0,10}(?:%|\/\s*\d)/i.test(text) ||
      /\b(?:transcript|speaker\s*\d+)\s*:|(?:^|\n)\s*\[\d{1,2}:\d{2}(?::\d{2})?\]/i.test(text) ||
      /\bBearer\s+\S+|\b(?:access_token|refresh_token|client_secret|api_key)\s*[:=]/i.test(text)) {
    return 'Private detail omitted.';
  }
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\b(?:https?|webcal|javascript|data):[^\s<>]+/gi, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ').trim();
  return text.slice(0, max);
}
function sourceName(value) {
  return plain(value, 80) || 'unknown';
}
function encodedId(prefix, key) {
  const bytes = new TextEncoder().encode(JSON.stringify(key));
  return prefix + btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function calendarIdentity(event) {
  // Keep separate configured feeds separate even if both are Google calendars.
  // Assignment linking below deliberately uses the existing status contract.
  const source = sourceName(event.source);
  if (event.uid && String(event.uid).length <= 1024) {
    return encodedId('c1_', [source, String(event.uid), event.recurrence_anchor || '']);
  }
  // Missing UIDs remain unlinked to coursework. The fallback permits display
  // but never upgrades a title/date coincidence into assignment identity.
  return encodedId('c0_', [source, plain(event.summary, 200), event.start.toISOString()]);
}
function courseOf(value) {
  if (value && typeof value === 'object') return resolveCourse(value.code || value.label);
  return resolveCourse(value);
}
function deadlineIndex(status, events) {
  const map = new Map();
  const { deadlines, meetings } = normalizeEvents(events);
  // /status intentionally limits actionable work to its bounded horizon. The
  // calendar is wider; use the same normalization and exact completion matcher
  // for its remaining dates rather than guessing from titles or discarding state.
  const fullWindow = deadlines.map(row => ({ ...row,
    course_code: row.course?.code || null, course: row.course?.label || 'All courses',
    when_iso: row.start.toISOString(),
  }));
  const { decided } = resolveCompletions(fullWindow, status.progress || []);
  for (const row of applyCompletion(fullWindow, decided, status.progress || [])) {
    for (const id of [row.assignment_id, ...(row.assignment_refs || [])]) if (id) map.set(id, row);
  }
  // Full status rows carry the Due/Availability Ends reference set; the compact
  // actionable view supplies identical completion state when only it is present.
  const lists = ['overdue', 'due_today', 'due_this_week', 'upcoming', 'other_courses_this_week'];
  for (const list of lists) for (const row of status[list] || []) {
    for (const id of [row.assignment_id, ...(row.assignment_refs || [])]) if (id) map.set(id, row);
  }
  for (const [list, completed] of [['outstanding', false], ['completed', true]]) {
    for (const row of status.actionable?.[list] || []) {
      for (const id of [row.assignment_id, ...(row.assignment_refs || [])]) if (id && !map.has(id)) map.set(id, { ...row, completed });
    }
  }
  return { map, meetingIds: new Set(meetings.map(row => eventIdentity(row)).filter(Boolean)) };
}
function kindOf(event, matched, course, normalizedMeeting) {
  if (reviewedModuleContainer(event, course)) return 'event';
  if (String(event.description || '').includes(AUTO_TAG) || /^◦\s/.test(event.summary || '')) return 'optional';
  if (matched) return 'deadline';
  const text = `${event.summary || ''} ${event.description || ''}`;
  if (/groupme|\b(?:club|society|collective)\b/i.test(text)) return 'meeting';
  if (/\bstudy(?:ing)?\b|\brevision\b|review\s+block|\b(?:exam|test|midterm) prep\b|\bpractice\s+(?:exam|test|midterm)\b/i.test(event.summary || '')) return 'study';
  if (course && (normalizedMeeting || event.recurring && !event.allDay)) return 'class';
  if (/\b(?:meeting|workshop|appointment|office hours)\b/i.test(event.summary || '') || event.recurring && !event.allDay) return 'meeting';
  // Only explicit due/close semantics create an unlinked deadline; an ordinary
  // personal calendar commitment is never promoted to required schoolwork.
  if (/\s[-–—]\s(?:Due|Availability Ends|Ends)\s*$/i.test(event.summary || '') ||
      /\b(?:deadline|due date)\b/i.test(event.summary || '')) return 'deadline';
  return 'event';
}
function shapeEvent(event, match, normalizedMeeting) {
  const course = courseForEvent(event);
  const module = reviewedModuleContainer(event, course);
  if (module) match = null;
  const start = event.start;
  const date = dateKey(start);
  let end = validDate(event.end);
  if (end && end <= start) end = null;
  if (!end && event.allDay) end = easternMidnight(shiftKey(date, 1));
  const verification = match?.completion?.submission_verification || match?.submission_verification || 'unknown';
  return {
    id: calendarIdentity(event), start_iso: start.toISOString(), end_iso: end?.toISOString() || null,
    date_key: date, end_date_key: end ? dateKey(end) : null, all_day: event.allDay === true,
    kind: kindOf(event, match, course, normalizedMeeting), title: plain(match?.title || event.summary, 200) || 'Untitled event',
    course_code: course?.code || null, course: course?.label || null,
    source: sourceName(event.source), location: plain(event.location, 200),
    description: module ? 'Course module timing; the assessment inside has its own deadline. ' + plain(event.description, 300) : plain(event.description),
    completed: match?.completed === true,
    submission_verification: module ? 'not_required' : ['verified', 'reported', 'unknown', 'not_required'].includes(verification) ? verification : 'unknown',
    assignment_id: match?.assignment_id || null,
    ...(module ? {event_role:'course_module',module_relation:module} : {}),
    ...(event.date_reconciliation ? { date_reconciliation: event.date_reconciliation } : {}),
  };
}
function coverageOf(status) {
  const feeds = (status.feed_health || []).map(feed => ({
    source: sourceName(feed.source), ok: feed.ok === true,
    events: Number.isFinite(feed.events) ? feed.events : 0, retried: feed.retried === true,
    coverage_complete: feed.coverage_complete !== false,
    date_conflicts: feed.date_conflicts?.length || 0,
    recurrence_incomplete: (feed.warnings || []).some(warning => warning.code?.startsWith('unsupported_recurrence:')),
  }));
  const failed = feeds.filter(feed => !feed.ok).map(feed => feed.source);
  const incomplete = feeds.filter(feed => feed.ok && !feed.coverage_complete).map(feed => feed.source);
  const expected = status.calendar_expected_sources || ['eLC (D2L)', 'Google Calendar'];
  const present = new Set(feeds.map(feed => sourceNamespace(feed.source)));
  const missing = expected.filter(source => !present.has(sourceNamespace(source))).map(sourceName);
  const sourceHealth = (status.source_health || []).map(source => ({
    source: sourceName(source.source || source.id || source.routine),
    label: plain(source.label || source.name || source.source || source.id || source.routine, 120),
    state: plain(source.state || source.status || (source.ok === true ? 'ok' : source.ok === false ? 'failed' : 'unknown'), 40),
    last_success_at: validDate(source.last_success_at)?.toISOString() || null,
    last_attempt_at: validDate(source.last_attempt_at)?.toISOString() || null,
    scope: Array.isArray(source.scope) ? source.scope.map(value => plain(value, 80)).slice(0, 20)
      : plain(source.scope, 120) || null,
  }));
  return {
    scope: status.actionable?.scope || status.course?.code || 'ALL',
    feeds_status: !feeds.length ? 'unknown' : failed.length || incomplete.length || missing.length ? 'degraded' : 'ok',
    feeds_ok: feeds.filter(feed => feed.ok && feed.coverage_complete).length, feeds_total: feeds.length, feeds_failed: failed,
    feeds_incomplete: incomplete, feeds_missing: missing,
    calendars_read_live: feeds.length > 0,
    submission_sources_checked: status.actionable?.coverage?.submission_sources_checked === true,
    feeds, source_health: sourceHealth,
  };
}
function safePriority(row) {
  const reference = row.progress_record;
  return {
    assignment_id: row.assignment_id || null, term_id: plain(row.term_id, 80) || null,
    bucket: plain(row.bucket, 40), title: plain(row.title, 200),
    course: plain(row.course, 80) || null, course_code: plain(row.course_code, 40) || null,
    when: plain(row.when, 100), when_iso: validDate(row.when_iso)?.toISOString() || null,
    days_away: Number.isFinite(row.days_away) ? row.days_away : null,
    progress_record: reference ? {
      record_id: plain(reference.record_id, 128) || null,
      revision: Number.isInteger(reference.revision) ? reference.revision : null,
      status: plain(reference.status, 40),
    } : null,
    completed: false, submission_verification: 'unknown',
    ...(row.date_reconciliation ? { date_reconciliation: row.date_reconciliation } : {}),
  };
}
function changeText(change) {
  const when = value => validDate(value) ? changeFormat.format(validDate(value)) : plain(value, 200);
  const title = plain(change.title, 200);
  const to = change.to_time_verification === 'unconfirmed' && /^\d{4}-\d{2}-\d{2}$/.test(change.to_date || '')
    ? `${change.to_date} (time unconfirmed)` : when(change.to);
  if (change.type === 'moved') return `${title} moved from ${when(change.from)} to ${to}.`;
  if (change.type === 'added') return `${title} was added for ${to}.`;
  if (change.type === 'removed') return `${title} disappeared from the source calendar; review the original source.`;
  if (change.type === 'reclassified') return `${title} is course module timing, not a separate deadline; its source calendar entry remains present.`;
  if (change.type === 'renamed') return `${plain(change.from, 200)} was renamed to ${plain(change.to, 200)}.`;
  return `${title} changed.`;
}
function changesOf(status, now) {
  return (status.recent_changes || []).filter(change => {
    const at = validDate(change.at);
    return at && at <= now && now - at <= 7 * DAY_MS;
  }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 8).map(change => {
    const course = courseOf(change.course_code || change.course);
    const safeValue = value => validDate(value)?.toISOString() || plain(value, 200) || null;
    return { type: plain(change.type, 40), title: plain(change.title, 200),
      course_code: course?.code || null, course: course?.label || null,
      at: validDate(change.at).toISOString(), from: safeValue(change.from), to: safeValue(change.to),
      ...(change.type === 'reclassified' ? { previous_type: plain(change.previous_type, 40), classification: 'course_module' } : {}),
      ...(change.to_time_verification === 'unconfirmed' ? { to_date: plain(change.to_date, 10), to_time_verification: 'unconfirmed' } : {}),
      summary: changeText(change) };
  });
}
function lecturesOf(status, today) {
  return (status.class_notes || []).map(note => {
    const recorded = validDate(note.created_at || note.at);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(note.date || '') ? note.date : recorded ? dateKey(recorded) : null;
    const course = courseOf(note.course_code || note.course);
    // Deliberately never derive a lecture title from note.text or summary.
    return { title: plain(note.title, 200) || 'Lecture notes', date,
      course_code: course?.code || null, course: course?.label || null,
      session_id: plain(note.session_id, 128) || null, recorded_at: recorded?.toISOString() || null };
  }).filter(note => note.date && note.date <= today && dayNumber(today) - dayNumber(note.date) <= 7)
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.recorded_at || '').localeCompare(String(a.recorded_at || '')))
    .slice(0, 8);
}

/** Whole local days: a date shown as checked must not omit its morning or evening. */
export function agendaWindow(now, lookbackDays=10, lookaheadDays=45) {
  const today=dateKey(validDate(now));
  return {windowStart:easternMidnight(shiftKey(today,-lookbackDays)),
    windowEnd:easternMidnight(shiftKey(today,lookaheadDays+1))};
}

/** Build once from live feeds + the shared status; clients only render the result. */
export function buildAgenda({ events = [], status = {}, now, windowStart, windowEnd }) {
  now = validDate(now);
  windowStart = validDate(windowStart);
  windowEnd = validDate(windowEnd);
  if (!now || !windowStart || !windowEnd || windowEnd <= windowStart) throw new TypeError('valid_agenda_window_required');
  const today = dateKey(now);
  const todayStart = easternMidnight(today);
  const tomorrowStart = easternMidnight(shiftKey(today, 1));
  const { map: index, meetingIds } = deadlineIndex(status, events);
  const unique = new Map();
  const matchedPairs = new Map();
  const unsupported = new Set();
  for (const original of events) {
    const start = validDate(original.start);
    if (!start) continue;
    const event = { ...original, start };
    const end = validDate(event.end);
    if (start >= windowEnd || (end ? end <= windowStart : start < windowStart)) continue;
    if (/^\s*\[CANCELLED\]/i.test(event.summary || '') || /\s[-–—]\s(?:Available|Availability Starts)\s*$/i.test(event.summary || '')) continue;
    if (event.unsupportedRule) unsupported.add(sourceName(event.source));
    const course = courseForEvent(event);
    const assignmentIdentity = eventIdentity({ ...event, course });
    const match = index.get(assignmentIdentity);
    const row = shapeEvent(event, match, meetingIds.has(assignmentIdentity));
    // D2L's known due/close pair was already reconciled by status and exposes
    // both source identities in assignment_refs. No title-based cross-feed dedup.
    if (match?.assignment_id && sourceNamespace(event.source) === 'elc' && match.assignment_refs?.length > 1) {
      const prior = matchedPairs.get(match.assignment_id);
      if (prior) {
        if (/\s[-–—]\sDue\s*$/i.test(event.summary || '')) {
          unique.delete(prior.id); unique.set(row.id, row); matchedPairs.set(match.assignment_id, row);
        }
        continue;
      }
      matchedPairs.set(match.assignment_id, row);
    }
    if (!unique.has(row.id)) unique.set(row.id, row);
  }
  const calendarEvents = [...unique.values()].sort((a, b) => a.start_iso.localeCompare(b.start_iso) || a.id.localeCompare(b.id));
  const coverage = coverageOf(status);
  const warnings = [];
  if (coverage.feeds_status === 'unknown') warnings.push('Calendar coverage is unknown. An empty view does not establish that nothing is scheduled or due.');
  if (coverage.feeds_failed.length) warnings.push(`${coverage.feeds_failed.join(', ')} calendar feed${coverage.feeds_failed.length === 1 ? '' : 's'} could not be read. Events and required work may be missing.`);
  if (coverage.feeds_missing.length) warnings.push(`${coverage.feeds_missing.join(', ')} calendar feed${coverage.feeds_missing.length === 1 ? ' is' : 's are'} not configured or not observed. Calendar coverage is incomplete.`);
  const recurrenceIncomplete = coverage.feeds.filter(feed => feed.recurrence_incomplete || !feed.coverage_complete && !feed.date_conflicts).map(feed => feed.source);
  if (recurrenceIncomplete.length) warnings.push(`${recurrenceIncomplete.join(', ')} calendar recurrence coverage is incomplete. Check the original calendar.`);
  if (unsupported.size) warnings.push(`Some recurring events from ${[...unsupported].join(', ')} could not be fully expanded. Check the original calendar.`);
  if (!coverage.submission_sources_checked) warnings.push('Calendar and progress records do not verify all submissions. Reported completion remains separate from verified submission.');
  for (const record of status.date_reconciliations || []) warnings.push(describeReconciliation(record));
  warnings.push(...(status.announcements?.warnings||[]));
  for (const source of coverage.source_health) {
    if (['failed', 'degraded', 'stale', 'blocked', 'unknown', 'skipped'].includes(source.state)) {
      warnings.push(`${source.label || source.source} is ${source.state}; its source coverage is limited.`);
    }
  }
  const uncertain=new Set((status.next_actions?.unverified||[]).map(r=>r.assignment_id));
  const order=new Map((status.next_actions?.priority_order||[]).map((id,i)=>[id,i]));
  const priorities = (status.actionable?.outstanding || []).filter(r=>!uncertain.has(r.assignment_id)).map(safePriority).sort((a,b)=>(order.get(a.assignment_id)??999)-(order.get(b.assignment_id)??999));
  const todayEvents = calendarEvents.filter(event => {
    const start = Date.parse(event.start_iso);
    const end = event.end_iso ? Date.parse(event.end_iso) : start;
    return start < tomorrowStart.getTime() && (event.end_iso ? end > todayStart.getTime() : start >= todayStart.getTime());
  });
  const upcomingExams = calendarEvents.filter(event => {
    const delta = dayNumber(event.date_key) - dayNumber(today);
    const explicitExam = /\b(?:exam|midterm|test)\b/i.test(event.title) || /\bfinal\b(?!\s+(?:project|paper|draft|presentation|report|submission|assignment))/i.test(event.title);
    const examAdmin = /\b(?:look\s*up|find|check|confirm|verify|register|registration|sign\s*up)\b[^.]*\b(?:exam|midterm|test)\b|\b(?:exam|midterm|test)\b[^.]*\b(?:registration|date\s+(?:lookup|check))\b/i.test(event.title);
    const academicSource = event.course_code || sourceNamespace(event.source) === 'elc';
    return delta >= 0 && delta <= 7 && academicSource && event.event_role !== 'course_module' && !['study', 'optional'].includes(event.kind) && explicitExam && !examAdmin;
  }).map(event => ({ ...event, days_away: dayNumber(event.date_key) - dayNumber(today) }));
  const overdue = priorities.filter(row => row.bucket === 'overdue').length;
  const dueToday = priorities.filter(row => row.bucket === 'due_today').length;
  const dueSoon = priorities.filter(row => ['due_this_week', 'other_courses_this_week'].includes(row.bucket)).length;
  const summary = `${todayEvents.length} calendar commitment${todayEvents.length === 1 ? '' : 's'} today. ` +
    `${overdue} overdue, ${dueToday} due today, and ${dueSoon} more required item${dueSoon === 1 ? '' : 's'} in the next seven days.` +
    (uncertain.size?' '+uncertain.size+' source items remain unverified; excluded from overdue counts.':'')+
    (coverage.feeds_status !== 'ok' ? ' Calendar coverage is incomplete or unknown.' : '');
  return {
    calendar: { timezone: TZ, generated_at: now.toISOString(), window: { start: windowStart.toISOString(), end: windowEnd.toISOString() }, coverage, events: calendarEvents },
    daily_briefing: { date: today, title: titleFormat.format(now), summary, priorities, today: todayEvents,
      upcoming_exams: upcomingExams, changes: changesOf(status, now), recent_lectures: lecturesOf(status, today), warnings, coverage },
  };
}
