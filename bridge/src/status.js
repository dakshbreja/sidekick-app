// Turns raw calendar events into the briefing a GPT reads on open.

import { parseICS } from './ics.js';
import { eventIdentity, sourceNamespace, TERM_ID, sameAssignment } from './identity.js';
import { calendarText, feedError, FEED_TIMEOUT_MS } from './feed-reader.js';
import { COURSES, courseForEvent, TERM } from './courses.js';
import { optionalFor } from './optional.js';
import { describeChange } from './changes.js';
import { reconciliationWindow, reconcileDates, describeReconciliation } from './date-reconciliation.js';
import { reviewedDateCorrections } from './reviewed-date-corrections.js';
import { reviewedModuleContainer } from './reviewed-module-relations.js';
import { readAnnouncementRecord, announcementContext, scopedAnnouncementSummary } from './announcement-context.js';

export const TZ = 'America/New_York';

// D2L emits up to three events per graded item: when it opens, when availability
// ends, and when it is due. Only the last two are deadlines.
const D2L_SUFFIX = /\s*[-–—]\s*(Available|Availability Starts|Availability Ends|Due|Ends)\s*$/i;

// Marker written into the description of every calendar event this project creates.
export const AUTO_TAG = '[auto:gpt-status-bridge]';

function classifyD2L(summary) {
  const m = D2L_SUFFIX.exec(summary);
  if (!m) return { baseTitle: summary.trim(), kind: 'event' };
  const kind = m[1].toLowerCase();
  const baseTitle = summary.slice(0, m.index).trim();
  if (kind === 'available' || kind === 'availability starts') return { baseTitle, kind: 'opens' };
  if (kind === 'due') return { baseTitle, kind: 'due' };
  return { baseTitle, kind: 'closes' };
}

// Formatter configuration is immutable and contains no user/request data.
// Constructing ICU formatters for every shaped deadline exhausted the CPU budget.
const formatters = new Map();
function fmt(date, opts) {
  const key = JSON.stringify(opts);
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts });
    formatters.set(key, formatter);
  }
  return formatter.format(date);
}

function formatWhen(ev) {
  if (ev.allDay) return fmt(ev.start, { weekday: 'short', month: 'short', day: 'numeric' });
  return fmt(ev.start, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Calendar day key in the user's timezone, for same-day comparisons. */
function dayKey(date) {
  return fmt(date, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function addDays(date, n) {
  return new Date(date.getTime() + n * 86400000);
}

function daysBetween(a, b) {
  // Whole calendar days apart, in local time — not raw 24h blocks.
  const parse = (d) => {
    const p = fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' }).split('/');
    return Date.UTC(Number(p[2]), Number(p[0]) - 1, Number(p[1]));
  };
  return Math.round((parse(b) - parse(a)) / 86400000);
}

/**
 * Fetch and parse every configured feed. A failing feed is reported rather than
 * silently dropped — an empty schedule and a broken feed must never look alike.
 */
export async function loadEvents(feeds, { windowStart, windowEnd, fetchImpl = fetch, dateCorrections = reviewedDateCorrections, env = null, now = new Date() } = {}) {
  const events = [];
  const health = [];
  const announcementRecord = await readAnnouncementRecord(env);

  // Google throttles rapid repeat fetches of the same iCal URL, so a single
  // transient failure is common. One retry turns most of those into a clean
  // briefing instead of a "could not load" warning the user has to interpret.
  const attempt = async (feed) => {
    const signal = AbortSignal.timeout(FEED_TIMEOUT_MS);
    const res = await fetchImpl(feed.url, { signal, headers: { 'User-Agent': 'gpt-status-bridge/1.0' } });
    let parseWindow = reconciliationWindow(feed.name, windowStart, windowEnd, dateCorrections);
    // Bind news to the original term occurrence even when the moved date enters
    // the visible window after its source date has left it. This remains a live
    // provider read; only bounded original-source observations are stored.
    if (announcementRecord?.snapshot && sourceNamespace(feed.name) === 'elc') parseWindow = {
      windowStart:new Date(Math.min(+parseWindow.windowStart, Date.parse(TERM.start+'T00:00:00Z')-14*86400000)),
      windowEnd:new Date(Math.max(+parseWindow.windowEnd, Date.parse(TERM.end+'T00:00:00Z')+32*86400000)),
    };
    const parsed = parseICS(await calendarText(res, signal), { ...parseWindow, source: feed.name });
    return { events:parsed, warnings:parsed.warnings||[] };
  };

  await Promise.all(
    feeds.map(async (feed) => {
      let lastError;
      for (let tries = 0; tries < 2; tries++) {
        try {
          const parsed = await attempt(feed);
          events.push(...parsed.events);
          health.push({ source: feed.name, ok: true, events: parsed.events.length, retried: tries > 0,
            coverage_complete: !parsed.warnings.length, warnings: parsed.warnings });
          return;
        } catch (err) {
          lastError = err;
          if (tries === 0) await new Promise((r) => setTimeout(r, 400));
        }
      }
      health.push({
        source: feed.name,
        ok: false,
        error: feedError(lastError),
        events: 0,
      });
    })
  );

  const context = announcementContext(announcementRecord,events,now,dateCorrections,{windowStart,windowEnd}), corrected=[];
  for (const feed of feeds) {
    const result=reconcileDates(events.filter(event=>event.source===feed.name),{source:feed.name,windowStart,windowEnd,corrections:context.corrections});
    corrected.push(...result.events);
    const entry=health.find(row=>row.source===feed.name);
    if(entry?.ok) {
      entry.events=result.events.length;
      entry.coverage_complete=entry.coverage_complete&&!result.conflicts.length;
      if(result.notes.length)entry.date_reconciliations=result.notes;
      if(result.conflicts.length)entry.date_conflicts=result.conflicts;
    }
    if(entry&&sourceNamespace(feed.name)==='elc'&&context.summary) {
      entry.announcements=context.summary;entry.announcement_change_safe=context.summary.change_safe;
    }
  }
  corrected.sort((a,b)=>a.start-b.start);
  return {events:corrected,health};
}

/**
 * Split events into class meetings and deadlines, drop D2L "opens" noise, and
 * collapse the duplicate "Due"/"Availability Ends" pair D2L emits per item.
 */
export function normalizeEvents(events) {
  const deadlines = [];
  const meetings = [];
  const commitments = [];

  for (const ev of events) {
    const course = courseForEvent(ev);
    const { baseTitle, kind } = classifyD2L(ev.summary);

    if (kind === 'opens') continue;

    // An explicitly reviewed content container is material timing. Its child
    // assessment keeps its own due date and exact completion identity.
    if (reviewedModuleContainer(ev, course)) continue;

    // Skip the optional-work events this project writes onto the calendar.
    // They come back through the Google feed, but they are already served from
    // the catalog under optional_this_week — counting them again would list
    // optional reading as if it were a deadline.
    if (ev.description.includes(AUTO_TAG) || ev.summary.startsWith('◦ ')) continue;

    // The personal calendar also contains club events and ordinary appointments.
    // An appointment time is not a due date, and must not acquire a completion
    // control simply because it is a one-off Google event. Preserve explicit
    // deadlines and existing course requirements; meetings belong on the agenda.
    if (/^\s*\[CANCELLED\]/i.test(ev.summary)) continue;
    const personal = sourceNamespace(ev.source) === 'google';
    const explicitStudy = /\bstudy(?:ing)?\b|review\s+block|\b(?:exam|test|midterm)\s+prep\b|\bpractice\s+(?:exam|test)\b/i.test(ev.summary);
    const explicitDeadline = !explicitStudy && (/\b(?:due|deadline)\b|last\s+day|drop\s*\/\s*add|withdrawal/i.test(ev.summary)
      || Boolean(course) && /\b(?:exam|midterm|final(?:\s+exam)?|test)\b/i.test(ev.summary));
    const explicitMeeting = /\b(?:meeting|lecture|class|session|office\s+hours|guest\s+speaker|workshop|study|review\s+block)\b/i.test(ev.summary);
    if (personal && !explicitDeadline && (!course || explicitMeeting || explicitStudy)) {
      const row = { ...ev, course, title: ev.summary };
      if (course && (ev.recurring || explicitMeeting) && !explicitStudy) meetings.push(row);
      else commitments.push(row);
      continue;
    }

    // A recurring timed event on the personal calendar is a class meeting.
    if (ev.recurring && !ev.allDay && !explicitDeadline) {
      meetings.push({ ...ev, course, title: ev.summary });
      continue;
    }

    const assignment_id = eventIdentity({ ...ev, course });
    deadlines.push({ ...ev, course, title: baseTitle || ev.summary, kind, assignment_id,
      assignment_refs: assignment_id ? [assignment_id] : [], source_namespace: sourceNamespace(ev.source) });
  }

  // Preserve unrelated source records, even when titles and dates coincide.
  // D2L's due/close pair is the one known duplicate contract; retain both refs.
  const seen = new Map();
  for (const d of deadlines) {
    let key = `${d.course ? d.course.code : '?'}|${d.source_namespace}|${d.title.toLowerCase()}|${d.start.getTime()}`;
    const prior = seen.get(key);
    if (prior && prior.assignment_id !== d.assignment_id &&
        !(d.source_namespace === 'elc' && [prior.kind,d.kind].includes('due') && [prior.kind,d.kind].includes('closes'))) key += '|' + (d.assignment_id || d.uid);
    const match = seen.get(key);
    if (!match) seen.set(key,d);
    else {
      const chosen = match.kind !== 'due' && d.kind === 'due' ? d : match;
      chosen.assignment_refs = [...new Set([...match.assignment_refs,...d.assignment_refs])];
      seen.set(key,chosen);
    }
  }

  return { deadlines: [...seen.values()].sort((a, b) => a.start - b.start), meetings, commitments };
}

/** Strip a redundant leading course label: "MGMT 5560 — Get your code" -> "Get your code". */
function trimCourseLabel(title, course) {
  if (!course) return title;
  const re = new RegExp(`^\\s*${course.label.replace(/\s+/g, '\\s*')}\\s*[-–—:]\\s*`, 'i');
  return title.replace(re, '').trim() || title;
}

function shape(d, now) {
  return {
    assignment_id: d.assignment_id || null,
    assignment_refs: d.assignment_refs || [],
    source_namespace: d.source_namespace,
    term_id: TERM_ID,
    title: trimCourseLabel(d.title, d.course),
    course: d.course ? d.course.label : 'All courses',
    course_code: d.course ? d.course.code : null,
    when: formatWhen(d),
    when_iso: d.start.toISOString(),
    days_away: daysBetween(now, d.start),
    all_day: d.allDay,
    ...(d.date_reconciliation ? { date_reconciliation: d.date_reconciliation } : {}),
    detail: d.description ? d.description.split('\n').filter(Boolean).slice(0, 3).join(' | ').slice(0, 400) : '',
  };
}

/**
 * Assemble the payload the GPT Action returns.
 * `course` scopes the foreground; everything else still appears under
 * `other_courses_this_week` so the GPT can see competing load.
 */
/** Same normalisation the Worker uses, so reported items match calendar titles. */
function normItem(x) {
  return String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Tokens with numbers canonicalised, so "Quiz 01" and "quiz 1" agree. */
function itemTokens(x) {
  return normItem(x).split(' ').filter(Boolean)
    .map((t) => (/^\d+$/.test(t) ? String(parseInt(t, 10)) : t));
}

// ── Completion: identity matching vs submission evidence ─────────────────────
//
// Two questions get answered here and conflating them is the bug this section
// exists to prevent:
//
//   1. WHICH tracked deadline does a report refer to?  ->  match_method
//   2. Do we know the work was actually turned in?     ->  submission_verification
//
// An exact title match is strong evidence for (1) and no evidence at all for (2).
// The old single `confidence: 'confirmed'` read as though it settled both, and the
// live bridge was applying it to records whose own notes said "self-reported,
// unverified". `confidence` is kept — six GPT configs, the dashboard and the
// published Action schema read it — but it now means only how the title matched.

export const GENERAL_CODE = 'GENERAL';
export const VERIFICATION_VALUES = ['verified', 'reported', 'unknown', 'not_required'];
export const MATCH_METHODS = ['source_identity', 'exact', 'unique_alias', 'unresolved'];

/** Course bucket a progress report belongs to. Absent course means GENERAL, never "any". */
export function progressScope(p) {
  const raw = String((p && p.course) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw || GENERAL_CODE;
}

/**
 * The deadlines a report from `scope` is allowed to clear.
 *
 * A BUSN 5000 report must never touch MGMT 4280: both carry a "Quiz 1", and one
 * report of it used to clear both. GENERAL is the explicit rule that keeps
 * university-wide items (drop/add, advisor meetings) markable — those deadlines
 * belong to no course and carry course_code: null. A report with no course at all
 * lands in GENERAL rather than becoming a wildcard across the whole semester.
 */
function candidatesFor(deadlines, scope) {
  if (scope === GENERAL_CODE) return deadlines.filter((d) => !d.course_code);
  return deadlines.filter((d) => d.course_code === scope);
}

/**
 * What the bridge actually knows about the submission behind a report.
 *
 * Nothing here is inferred from how well the title matched. `verified` requires
 * an observed reference — a receipt, a submission page, a graded entry — and a
 * record that arrived without one is downgraded rather than trusted. Records
 * written before this field existed stay exactly as they were reported and are
 * labelled with their evidence limitation instead of being upgraded.
 */
export function submissionEvidence(p) {
  const stored = String((p && p.verification) || '').toLowerCase();
  const declared = VERIFICATION_VALUES.includes(stored) ? stored : null;
  const evidence = p && p.evidence ? String(p.evidence).slice(0, 200) : null;

  let verification = declared || (p && p.status === 'done' ? 'reported' : 'unknown');
  if (verification === 'verified' && !evidence) verification = 'reported';

  return {
    submission_verification: verification,
    evidence,
    submitted_by: (p && p.submitted_by) || null,
    reported_by: (p && p.reported_by) || null,
    record_id: p?.record_id || null,
    revision: p?.revision || null,
    reported_status: (p && p.status) || null,
    reported_at: (p && p.at) || null,
    reported_at_local: (p && p.at_local) || null,
    // What is missing is the structured evidence, which is not the same as knowing
    // no check happened. Records written before these fields existed may well
    // describe an observed portal receipt in their free-text note; that note is
    // preserved verbatim below and is not reinterpreted here either way.
    evidence_limitation:
      verification === 'verified'
        ? null
        : declared
          ? 'No structured submission evidence was recorded with this report.'
          : 'Stored before submission evidence was tracked separately, so no structured evidence is available. Read `reported_note` before assuming nothing was checked.',
    reported_note: (p && p.note) || null,
  };
}

/** Enough of a deadline to say which one an ambiguous report might have meant. */
function candidateRef(d) {
  return { title: d.title, course_code: d.course_code || null, when: d.when, when_iso: d.when_iso };
}

/**
 * Decide which deadlines a set of reported-done items actually clears.
 *
 * Resolve only previously bound term/course/source identities. Title matching is
 * confined to write-time candidate selection; a moving read window never binds
 * historical reports. Unlinked history stays visible for explicit review.
 */
export function resolveCompletions(allDeadlines, progress) {
  const decided = new Map();
  const ambiguous = [];
  const unmatched = [];

  for (const p of (progress || []).filter((x) => x && x.status === 'done')) {
    const scope = progressScope(p);
    const pool = candidatesFor(allDeadlines, scope);

    const record = (d, method) => decided.set(d, {
      confidence: p.identity_match_method === 'unique_alias' ? 'inferred' : 'confirmed',
      matched: p.item,
      match_method: method,
      matched_course: scope,
      ...submissionEvidence(p),
    });
    const unresolved = (reason, matches) => {
      const row = { reported: p.item, course: scope, record_id:p.record_id || null, revision:p.revision || null, match_method: 'unresolved', reason };
      if (matches) {
        row.matches = matches.map((d) => d.title);
        row.candidates = matches.map(candidateRef);
        ambiguous.push(row);
      } else {
        unmatched.push(row);
      }
    };

    if (!pool.length) { unresolved('no_tracked_deadline_in_course'); continue; }

    // Title-only historical reports are retained for review, not reinterpreted
    // against today's moving window. New reports are anchored at write time.
    if (p.identity_resolution !== 'linked' || !p.assignment_id || p.term_id !== TERM_ID) {
      unresolved(p.identity_reason || 'identity_review_required');
      continue;
    }
    const linked = pool.filter(d => sameAssignment(p,d));
    if (!linked.length) { unresolved('linked_assignment_not_in_window'); continue; }
    for (const d of linked) record(d, 'source_identity');
  }
  return { decided, ambiguous, unmatched };
}

export function applyCompletion(list, decided, progress) {
  return (list || []).map((d) => {
    const hit = decided.get(d);
    const prior=(progress || []).find(p=>sameAssignment(p,d));
    d={...d,progress_record:prior?{record_id:prior.record_id,revision:prior.revision,status:prior.status}:null};
    return hit
      ? { ...d, completed: true, outstanding: false, completion: hit }
      : { ...d, outstanding: true };
  });
}

// ── The one actionable view every client reads ───────────────────────────────
//
// The dashboard filtered completed items out of its counters, the briefing listed
// them as overdue and then told the model to ignore them, and the MCP projection
// saw a third thing again. Deriving all of it once means a client can no longer
// disagree about what is outstanding.
//
// Compact rows on purpose: the full deadline objects are still right there in
// overdue / due_today / due_this_week, and duplicating them wholesale is what
// pushes this payload towards the Worker CPU limit.

const BUCKET_ORDER = ['overdue', 'due_today', 'due_this_week', 'other_courses_this_week', 'upcoming'];
// The buckets that genuinely fall inside seven days for the scoped course.
const SEVEN_DAY_BUCKETS = ['overdue', 'due_today', 'due_this_week'];

function actionRow(d, bucket) {
  const row = {
    bucket,
    assignment_id: d.assignment_id || null,
    term_id: TERM_ID,
    progress_record: d.progress_record || null,
    title: d.title,
    course: d.course,
    course_code: d.course_code || null,
    when: d.when,
    when_iso: d.when_iso,
    days_away: d.days_away,
    ...(d.date_reconciliation ? { date_reconciliation: d.date_reconciliation } : {}),
  };
  if (d.days_late != null) row.days_late = d.days_late;
  return row;
}

function buildActionable({ scope, buckets, progress, ambiguous, unmatched, health, optional }) {
  const outstanding = [];
  const awaiting = [];
  const verified = [];
  const notRequired = [];
  const done = [];

  for (const bucket of BUCKET_ORDER) {
    for (const d of buckets[bucket] || []) {
      if (d.completed !== true) { outstanding.push(actionRow(d, bucket)); continue; }
      const c = d.completion || {};
      const row = {
        ...actionRow(d, bucket),
        match_method: c.match_method || null,
        submission_verification: c.submission_verification || 'unknown',
        reported_as: c.matched || null,
        reported_at_local: c.reported_at_local || null,
        evidence: c.evidence || null,
        evidence_limitation: c.evidence_limitation || null,
      };
      done.push(row);
      // Three outcomes, not two. `not_required` is work with nothing to submit —
      // a reading, a setup task — so it is neither waiting on a receipt nor
      // evidence that one was seen.
      if (row.submission_verification === 'verified') verified.push(row);
      else if (row.submission_verification === 'not_required') notRequired.push(row);
      else awaiting.push(row);
    }
  }

  const failed = (health || []).filter((h) => !h.ok || h.coverage_complete === false).map((h) => h.source);
  const blocked = (progress || []).filter((p) => p.status === 'blocked')
    .map((p) => ({ item: p.item, course: progressScope(p), note: p.note || null }));

  const thisWeek = outstanding.filter((d) => SEVEN_DAY_BUCKETS.includes(d.bucket));

  return {
    scope,
    // `outstanding` spans more than a week: overdue reaches 10 days back and
    // upcoming reaches 21 days forward. Naming one horizon for all of it was a
    // false claim, so each range is stated and the seven-day figure is derived
    // from the buckets that actually fall inside seven days, in this scope only.
    horizon: {
      overdue_lookback_days: 10,
      due_window_days: 7,
      upcoming_window_days: 21,
      other_courses_window_days: 7,
    },
    scoped_next_7_days: {
      outstanding: thisWeek.length,
      buckets: ['overdue', 'due_today', 'due_this_week'],
      note: 'This scope only. Excludes other_courses_this_week and upcoming.',
    },
    // Outstanding first, most overdue first inside that.
    outstanding: outstanding.sort(
      (a, b) => BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket) || a.days_away - b.days_away,
    ),
    awaiting_verification: awaiting,
    verified_submissions: verified,
    no_submission_required: notRequired,
    completed: done,
    blocked,
    ambiguous,
    unmatched_reports: unmatched,
    counts: {
      outstanding: outstanding.length,
      overdue: outstanding.filter((d) => d.bucket === 'overdue').length,
      due_today: outstanding.filter((d) => d.bucket === 'due_today').length,
      due_this_week: outstanding.filter((d) => d.bucket === 'due_this_week').length,
      other_courses_this_week: outstanding.filter((d) => d.bucket === 'other_courses_this_week').length,
      upcoming: outstanding.filter((d) => d.bucket === 'upcoming').length,
      completed: done.length,
      awaiting_verification: awaiting.length,
      verified: verified.length,
      no_submission_required: notRequired.length,
      blocked: blocked.length,
      ambiguous: ambiguous.length,
      unmatched_reports: unmatched.length,
    },
    // Everything a client needs to decide how far to trust the two lists above.
    // Milestone 2 turns this into an explicit "am I finished" verdict; until then
    // it is reported, not judged.
    // Absent health is not a passing health check. A caller that cannot see
    // whether the feeds were read must not be told the deadlines are complete.
    coverage: {
      feeds_ok: (health || []).filter((h) => h.ok && h.coverage_complete !== false).length,
      feeds_total: (health || []).length,
      feeds_failed: failed,
      feeds_status: !(health || []).length ? 'unknown' : failed.length ? 'degraded' : 'ok',
      calendars_read_live: true,
      submission_sources_checked: false,
      optional_not_tracked: (optional && optional.uncovered) || null,
      caveat: !(health || []).length
        ? 'No feed health was reported, so it is unknown whether the calendars were read. Do not say nothing is due without checking.'
        : failed.length
          ? 'A calendar could not be read completely, so outstanding work may be missing from this list.'
          : 'Deadlines are complete as far as the calendars know. Submission state is self-reported unless marked verified.',
    },
  };
}

export function buildStatus({ events, now, course = null, note = null, classNotes = [], progress = [], allProgress = null, changes = [], health = [] }) {
  // `progress` is what the caller echoes back (scoped); `allProgress` is what
  // completion matching runs over. A scoped /status still renders
  // other_courses_this_week, so matching it needs every course's reports —
  // otherwise a scoped view reminds him about work he has already reported done.
  const matchProgress = allProgress || progress;
  const { deadlines, meetings } = normalizeEvents(events);

  const todayKey = dayKey(now);
  const tomorrowKey = dayKey(addDays(now, 1));

  const mine = (d) => !course || (d.course && d.course.code === course.code);

  const overdue = [];
  const dueToday = [];
  const dueThisWeek = [];
  const upcoming = [];
  const otherThisWeek = [];

  for (const d of deadlines) {
    const delta = daysBetween(now, d.start);
    // DATE deadlines remain due throughout that local day. Midnight is their
    // date anchor, not evidence that an all-day requirement is already late.
    const isPast = d.allDay ? delta < 0 : d.start.getTime() < now.getTime();
    const rec = shape(d, now);

    if (!mine(d)) {
      if (!isPast && delta <= 7) otherThisWeek.push(rec);
      continue;
    }

    if (isPast && delta <= 0) {
      // Only surface recently missed items; older ones are noise.
      if (delta >= -10) overdue.push({ ...rec, days_late: Math.abs(delta) });
    } else if (dayKey(d.start) === todayKey) {
      dueToday.push(rec);
    } else if (delta <= 7) {
      dueThisWeek.push(rec);
    } else if (delta <= 21) {
      upcoming.push(rec);
    }
  }

  // When a course is in scope, "class today" means *that* course's class.
  const shapeMeeting = (m) => ({
    course: m.course ? m.course.label : m.title,
    title: trimCourseLabel(m.title, m.course),
    when: formatWhen(m),
    location: m.location,
  });
  const scopedMeetings = meetings.filter((m) => !course || (m.course && m.course.code === course.code));
  const classesToday = scopedMeetings.filter((m) => dayKey(m.start) === todayKey).map(shapeMeeting);
  const classesTomorrow = scopedMeetings.filter((m) => dayKey(m.start) === tomorrowKey).map(shapeMeeting);
  const allClassesToday = meetings.filter((m) => dayKey(m.start) === todayKey).map(shapeMeeting);

  const feedsBroken = health.filter((h) => !h.ok);
  const dateReconciliations = health.flatMap(h => [...(h.date_reconciliations || []), ...(h.date_conflicts || [])])
    .filter(record => !course || record.course_code === course.code);
  const announcements=scopedAnnouncementSummary(health.find(h=>h.announcements)?.announcements||null,course?.code);

  // Optional work lives in the syllabi, never in a calendar feed, so it comes
  // from the transcribed catalog rather than from `events`.
  const asKey = (d) => {
    const p = fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' }).split('/');
    return Number(`${p[2]}${p[0]}${p[1]}`);
  };
  const optional = optionalFor(course, asKey(now), asKey(addDays(now, 7)));

  const allDeadlines = [...overdue, ...dueToday, ...dueThisWeek, ...upcoming, ...otherThisWeek];
  const { decided, ambiguous: allAmbiguous, unmatched: allUnmatched } = resolveCompletions(allDeadlines, matchProgress);

  // Completions apply across courses — that is how a scoped view stops nagging about
  // other_courses_this_week. Questions do not: a LAND 2510E conversation should not
  // be asked which BUSN 5000 quiz he meant. GENERAL travels with every scope because
  // course-less deadlines appear in every course's view.
  const inScope = (r) => !course || r.course === course.code || r.course === GENERAL_CODE;
  const ambiguous = allAmbiguous.filter(inScope);
  const unmatched = allUnmatched.filter(inScope);
  const markedOverdue = applyCompletion(overdue, decided, matchProgress);
  const markedToday = applyCompletion(dueToday, decided, matchProgress);
  const markedWeek = applyCompletion(dueThisWeek, decided, matchProgress);
  const markedUpcoming = applyCompletion(upcoming, decided, matchProgress);
  const markedOther = applyCompletion(otherThisWeek, decided, matchProgress);

  const actionable = buildActionable({
    scope: course ? course.code : 'ALL',
    buckets: {
      overdue: markedOverdue,
      due_today: markedToday,
      due_this_week: markedWeek,
      other_courses_this_week: markedOther,
      upcoming: markedUpcoming,
    },
    progress,
    ambiguous,
    unmatched,
    health,
    optional,
  });

  return {
    generated_at: now.toISOString(),
    local_time: fmt(now, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
    timezone: TZ,
    term: TERM.name,
    term_id: TERM_ID,
    identity_review: progress.filter(p=>p.identity_resolution!=='linked' || !p.assignment_id || p.term_id!==TERM_ID),
    course: course
      ? { code: course.code, label: course.label, title: course.title, instructor: course.instructor, ai_policy: course.aiPolicy, ai_note: course.aiNote }
      : null,
    // The scoped list, not the cross-course match set: the briefing must count what
    // this payload actually shows, or a scoped GPT reads "2 reported done" beside a
    // progress array holding one.
    briefing: composeBriefing({ course, actionable, classesToday, classesTomorrow, optional, note, classNotes, progress, changes, feedsBroken, dateReconciliations, announcementWarnings:announcements?.warnings||[], now }),
    actionable,
    overdue: markedOverdue,
    due_today: markedToday,
    due_this_week: markedWeek,
    upcoming: markedUpcoming,
    classes_today: classesToday,
    classes_tomorrow: classesTomorrow,
    all_classes_today: allClassesToday,
    other_courses_this_week: markedOther,
    optional_this_week: optional.dated,
    optional_ongoing: optional.standing,
    optional_not_tracked: optional.uncovered,
    claude_note: note,
    class_notes: classNotes,
    progress,
    progress_summary: {
      done: progress.filter((p) => p.status === 'done').length,
      in_progress: progress.filter((p) => p.status === 'in_progress').length,
      blocked: progress.filter((p) => p.status === 'blocked').length,
      availability: progress.length ? 'reported' : 'nothing reported yet',
      // Reported and verified are not the same claim. Kept alongside the old
      // counters rather than replacing them, so existing readers keep working.
      matched_to_deadline: actionable.counts.completed,
      awaiting_verification: actionable.counts.awaiting_verification,
      verified: actionable.counts.verified,
      unmatched_reports: actionable.counts.unmatched_reports,
    },
    completion_ambiguous: ambiguous,
    completion_unmatched: unmatched,
    recent_changes: changes,
    feed_health: health,
    date_reconciliations: dateReconciliations,
    ...(announcements?{announcements}:{}),
    data_warning: [feedsBroken.length
      ? `${feedsBroken.length} of ${health.length} calendar feeds failed to load. This list may be incomplete — say so before relying on it.`
      : health.some(h=>h.date_conflicts?.length)
        ? 'A reviewed instructor date and the current calendar occurrence no longer reconcile. Check the original course source before relying on that date.'
      : health.some(h=>h.coverage_complete===false)
        ? 'Some calendar recurrence rules could not be expanded completely. Events and required work may be missing.' : null,
      ...(announcements?.warnings||[])].filter(Boolean).join(' ')||null,
  };
}

/**
 * A short human summary the GPT can lead with verbatim.
 *
 * It reads the same `actionable` view the dashboard counts and the MCP projection
 * use, so the three can no longer disagree. Completed work is absent from the
 * overdue and due prose rather than being listed and then retracted a paragraph
 * later — the application resolves that contradiction once, here, instead of
 * leaving it to the model.
 */
function composeBriefing({ course, actionable, classesToday, classesTomorrow, optional, note, classNotes = [], progress = [], changes = [], feedsBroken, dateReconciliations = [], announcementWarnings = [], now }) {
  const lines = [];
  const scope = course ? course.label : 'All courses';
  lines.push(`${scope} — ${fmt(now, { weekday: 'long', month: 'long', day: 'numeric' })}.`);

  if (feedsBroken.length) {
    lines.push(`Warning: ${feedsBroken.map((f) => f.source).join(', ')} did not load, so this may be incomplete.`);
  } else if (actionable.coverage.feeds_status === 'unknown') {
    // Unknown is not clear. This has to land before any "nothing is due" below it.
    lines.push('Warning: no calendar feed health was reported, so it is unknown whether the deadlines below were actually read. Do not tell him he is clear.');
  } else if (actionable.coverage.feeds_status === 'degraded' && !dateReconciliations.some(record => record.state === 'conflict')) {
    lines.push('Warning: some calendar recurrence rules could not be expanded completely. The schedule and deadlines may be incomplete.');
  }
  for (const record of dateReconciliations) lines.push(describeReconciliation(record));
  for (const warning of announcementWarnings) lines.push('Warning: '+warning);

  const inBucket = (b) => actionable.outstanding.filter((d) => d.bucket === b);
  const overdue = inBucket('overdue');
  const dueToday = inBucket('due_today');
  const dueThisWeek = inBucket('due_this_week');
  const otherThisWeek = inBucket('other_courses_this_week');
  const ambiguous = actionable.ambiguous || [];

  if (overdue.length) {
    lines.push(`Overdue: ${overdue.map((d) => `${d.title} (${d.days_late}d late)`).join('; ')}.`);
  }
  if (dueToday.length) {
    lines.push(`Due today: ${dueToday.map((d) => `${d.title} at ${d.when}`).join('; ')}.`);
  }
  if (dueThisWeek.length) {
    lines.push(`Next 7 days: ${dueThisWeek.map((d) => `${d.title} — ${d.when}`).join('; ')}.`);
  }
  if (!overdue.length && !dueToday.length && !dueThisWeek.length) {
    // Only what actually falls in this scope and this window. counts.completed
    // spans other courses and the 21-day upcoming list, so quoting it here
    // claimed credit for work outside the sentence it appears in.
    const settled = (actionable.completed || []).filter(
      (d) => SEVEN_DAY_BUCKETS.includes(d.bucket)).length;
    lines.push(
      settled
        ? `Nothing outstanding in this course in the next 7 days — ${settled} item${settled === 1 ? '' : 's'} in that window ${settled === 1 ? 'is' : 'are'} already reported done.`
        : 'Nothing due in this course in the next 7 days.');
  }

  // Reported is not verified. Say which one this is, every time, so neither the
  // model nor Daksh reads a self-report as a confirmed submission.
  const awaiting = actionable.awaiting_verification || [];
  if (awaiting.length) {
    const shown = awaiting.slice(0, 4).map((d) => d.title).join('; ');
    const more = awaiting.length > 4 ? ` +${awaiting.length - 4} more` : '';
    lines.push(
      `Reported done but NOT independently verified: ${shown}${more}. ` +
      'Treat these as finished for planning, but never tell him a submission is confirmed — the bridge has seen no receipt.');
  }
  const noSubmission = actionable.counts.no_submission_required;
  if (noSubmission) {
    lines.push(`${noSubmission} further completed item${noSubmission === 1 ? '' : 's'} needed no submission, so there is nothing to verify there.`);
  }

  if (classesToday.length) lines.push(`Class today: ${classesToday.map((c) => c.when).join('; ')}.`);
  else if (classesTomorrow.length) lines.push(`Class tomorrow: ${classesTomorrow.map((c) => c.when).join('; ')}.`);

  // Other courses are context, not the subject. Listing them all buries the
  // course he actually opened, so name only what is about to bite (<= 2 days)
  // and reduce the rest to a count he can ask about.
  if (otherThisWeek.length) {
    const urgent = otherThisWeek.filter((d) => d.days_away <= 2);
    if (urgent.length) {
      const shown = urgent.slice(0, 3).map((d) => `${d.course} ${d.title} (${d.when})`).join('; ');
      const more = urgent.length > 3 ? ` +${urgent.length - 3} more` : '';
      lines.push(`Heads-up, other courses, due within 48h: ${shown}${more}.`);
    }
    const rest = otherThisWeek.length - urgent.length;
    if (rest > 0) {
      lines.push(`${rest} further item${rest === 1 ? '' : 's'} in other courses later this week — do not list them unless he asks.`);
    }
  }

  // Optional work is the thing he most wants surfaced, because nothing else
  // reminds him it exists. Always end with an explicit offer.
  if (optional) {
    const KIND_LABEL = { reading: 'read', watch: 'watch', listen: 'listen', practice: 'practice', bonus: 'bonus points' };
    const items = [...optional.dated, ...optional.standing];
    if (items.length) {
      const shown = items.slice(0, 6).map((i) => `${KIND_LABEL[i.kind] || i.kind}: ${i.title}`).join('; ');
      const more = items.length > 6 ? ` +${items.length - 6} more` : '';
      const bonus = optional.dated.filter((i) => i.graded);
      lines.push(`Optional / not separately graded this week: ${shown}${more}.`);
      if (bonus.length) lines.push(`Note that ${bonus.map((b) => b.title).join(' and ')} carries actual points despite being optional.`);
      lines.push('Ask him directly whether he wants to do any of these, one at a time — do not assume he has seen them, and do not just list them and move on.');
    }
    if (optional.uncovered) lines.push(`Coverage gap: ${optional.uncovered}`);
  }

  // A moved deadline is the one thing he cannot find out by looking at today's list,
  // so it goes near the front rather than buried under optional reading.
  if (changes && changes.length) {
    const recent = changes.slice(-4).reverse();
    const when = (d) => fmt(d, { weekday: 'short', month: 'short', day: 'numeric' });
    lines.push(`CHANGED since the last check: ${recent.map((c) => describeChange(c, when)).join('; ')}. Tell him about these before anything else.`);
  }

  if (note && note.text) {
    lines.push(`Last note from Claude (${note.at_local || note.at}): ${note.text}`);
  }

  // Point at the accumulated record rather than inlining it - the briefing has to
  // stay short, and the full history is right there in `class_notes`.
  if (classNotes && classNotes.length) {
    const last = classNotes[classNotes.length - 1];
    lines.push(
      `Class notes on file: ${classNotes.length} session${classNotes.length === 1 ? '' : 's'}, most recent ${last.date}. ` +
      `Read class_notes for what was actually covered before answering about course content.`);
  }

  // The GPT is the only thing that talks to him daily, so it is the only place a
  // completion can be captured. Tell it to write back.
  const doneCount = progress.filter((p) => p.status === 'done').length;
  if (doneCount) {
    lines.push(`He has reported ${doneCount} item${doneCount === 1 ? '' : 's'} done. Only reports linked to a current assignment are excluded above; unmatched reports need identity review, not an assumption of submission.`);
  }
  lines.push('If he says he finished, submitted, or started something, call recordProgress with that item and status. Do not ask permission first; record it, and confirm only after a successful save acknowledgement. For ambiguity, use the returned course/date/assignment reference; never silently guess or claim an unsuccessful write was saved. Drafted-but-not-submitted is in_progress, not done.');

  // A report the bridge could not attach to any deadline is invisible otherwise:
  // it neither clears anything nor shows up as a question.
  const unmatched = actionable.unmatched_reports || [];
  if (unmatched.length) {
    const shown = unmatched.slice(0, 3).map((u) => `"${u.reported}" (${u.course})`).join('; ');
    lines.push(`Reported done but matching no tracked deadline: ${shown}. Those are recorded, but nothing on the calendar was cleared by them.`);
  }

  // A vague report clears nothing, so surface it rather than letting it vanish.
  if (ambiguous && ambiguous.length) {
    ambiguous.forEach((a) => {
      lines.push(`He reported "${a.reported}" done in ${a.course}, but that matches ${a.matches.length} items (${a.matches.slice(0, 3).join('; ')}). Nothing was marked complete - ask which one he meant, then call recordProgress with the exact title.`);
    });
  }

  if (course && course.aiPolicy === 'banned-on-assignments') {
    lines.push('AI policy: this course forbids AI-generated assignment work. Help him study and prepare; do not draft deliverables.');
  }

  return lines.join(' ');
}

export const ALL_COURSES = COURSES;
