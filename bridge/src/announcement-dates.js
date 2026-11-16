// News is an additional original-course authority, not a second deadline store.
// Only a definite date-change sentence and one exact live course occurrence can
// authorize an overlay. Titles help locate that occurrence once; the resulting
// correction keeps the source UID/recurrence, so progress never follows a guess.
import { TERM, resolveCourse, courseForEvent } from './courses.js';
import { TERM_ID, eventIdentity, sourceNamespace } from './identity.js';

const ZONE = 'America/New_York';
const dateFormat = new Intl.DateTimeFormat('en-US', { timeZone: ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit' });
const wallFormat = new Intl.DateTimeFormat('en-US', { timeZone: ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const DAY = 86400000;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];
const NUMBER_WORDS = new Map(['zero', 'one', 'two', 'three', 'four', 'five',
  'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'].map((word, i) => [word, String(i)]));
const DATE_TOKEN = /\b(?:(\d{4})-(\d{1,2})-(\d{1,2})|(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?|(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?)\b/gi;
const WEEKDAY = /\b(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\s*,?\s*$/i;
const CHANGE = /\b(?:moved?|reschedul(?:e|ed)|postpon(?:e|ed)|extend(?:ed)?|changed?|pushed\s+back|(?:is|are|will\s+be)\s+now|will\s+now\s+(?:be|take\s+place|occur)|new\s+(?:due\s+)?date|instead\s+of|rather\s+than)\b/i;
const HYPOTHETICAL = /\b(?:might|may|could|tentative|propos(?:ed|al)|consider(?:ing)?|if|unless|not|never|sample|example|practice|pretend)\b|\b(?:do\s+not|don't|ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions)\b/i;
const oldLead = /\b(?:from|instead\s+of|rather\s+than|originally\s+(?:on|for|scheduled\s+for))\s+(?:the\s+)?(?:[a-z]+\s*,?\s*)?$/i;
const newLead = /\b(?:to|until|on|for|now(?:\s+due)?)\s+(?:the\s+)?(?:[a-z]+\s*,?\s*)?$/i;

function date(value) {
  if (!(value instanceof Date) && (typeof value !== 'string' || !value.trim())) return null;
  const result = value instanceof Date ? value : new Date(value);
  return value != null && Number.isFinite(+result) ? result : null;
}
function iso(value) { return date(value)?.toISOString() || null; }
function parts(format, value) {
  return Object.fromEntries(format.formatToParts(value).map(p => [p.type, p.value]));
}
function day(value) {
  const p = parts(dateFormat, date(value));
  return `${p.year}-${p.month}-${p.day}`;
}
function nextDay(key) { return new Date(Date.parse(key + 'T12:00:00Z') + DAY).toISOString().slice(0, 10); }
function midnight(key) {
  const target = Date.parse(key + 'T00:00:00Z');
  let instant = target;
  for (let i = 0; i < 4; i++) {
    const p = parts(wallFormat, new Date(instant));
    const observed = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    const delta = target - observed;
    instant += delta;
    if (!delta) break;
  }
  return new Date(instant).toISOString();
}
function plain(value, max = 200) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}
function canonical(value) {
  return plain(value, 12000).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').map(word => NUMBER_WORDS.get(word) || word).join(' ')
    .replace(/\b(?:exam|test|quiz) (i|ii|iii|iv|v)\b/g, (_, roman) =>
      `${_.split(' ')[0]} ${['i', 'ii', 'iii', 'iv', 'v'].indexOf(roman) + 1}`);
}
function titleOf(event) {
  // eLC availability starts are not deadlines. A due/close pair is handled as a
  // known pair below, but two arbitrary identical titles stay ambiguous.
  let title = plain(event.summary);
  title = title.replace(/^\s*(?:BUSN|MGMT|LAND)\s*[-_]?\s*\d{4}E?\s*[-:–—]?\s*/i, '');
  const suffix = /\s*[-–—]\s*(Available|Availability Starts|Availability Ends|Due|Ends)\s*$/i.exec(title);
  const kind = suffix ? /^(?:Available|Availability Starts)$/i.test(suffix[1]) ? 'opens'
    : /^Due$/i.test(suffix[1]) ? 'due' : 'closes' : 'event';
  if (suffix) title = title.slice(0, suffix.index);
  title = title.replace(/\s+(?:administered|due|deadline|submission)\s*$/i, '').trim();
  return { title, key: canonical(title), kind };
}
function sourceShape(event) {
  return { start_iso: iso(event.start), end_iso: iso(event.end), all_day: event.allDay === true };
}
function sameShape(a, b) {
  return a?.start_iso === b?.start_iso && (a?.end_iso || null) === (b?.end_iso || null) &&
    (a?.all_day === true) === (b?.all_day === true);
}
function recordKey(record) {
  return eventIdentity({ uid: record.uid, source: record.source,
    course: { code: record.course_code }, recurrence_anchor: record.recurrence_anchor || '' });
}
function acceptedUrl(item) {
  try {
    const url = new URL(item.url || item.source_url);
    // This is additional defense after the ingest's enrolled org/news identity
    // checks, not permission to discover or read any arbitrary URL.
    const path = /^\/d2l\/le\/news\/(\d+)\/(\d+)\/view\/?$/.exec(url.pathname);
    return url.protocol === 'https:' && url.hostname === 'uga.view.usg.edu' && !url.username && !url.password &&
      path && path[1] === String(item.org_unit_id) && path[2] === String(item.announcement_id) &&
      (!url.searchParams.has('ou') || url.searchParams.get('ou') === String(item.org_unit_id)) ? url.href : null;
  } catch { return null; }
}
function validItem(item, now) {
  return item?.verified === true && item.term_id === TERM_ID && resolveCourse(item.course_code)?.code === item.course_code &&
    /^\d+$/.test(String(item.announcement_id || '')) && /^\d+$/.test(String(item.org_unit_id || '')) &&
    /^[a-f0-9]{64}$/i.test(item.content_sha256 || '') && acceptedUrl(item) &&
    typeof item.text === 'string' && item.text.length <= 60000 && typeof item.title === 'string' && item.title.length <= 1000 &&
    date(item.observed_at) && date(item.observed_at) <= new Date(+now + 5 * 60000) &&
    (!item.published_at || date(item.published_at) && date(item.published_at) <= date(item.observed_at)) &&
    (!item.feed_published_at || date(item.feed_published_at) && date(item.feed_published_at) <= date(item.observed_at)) &&
    (!item.modified_at || date(item.modified_at) && (!item.published_at || date(item.modified_at) >= date(item.published_at)) &&
      date(item.modified_at) <= date(item.observed_at));
}
function authority(item) {
  return { kind: 'instructor_announcement', verified: true, precision: 'date',
    title: `${item.course_code} instructor date-change announcement`, url: acceptedUrl(item),
    published_at: iso(item.published_at), observed_at: iso(item.observed_at),
    modified_at: iso(item.modified_at), feed_published_at: iso(item.feed_published_at),
    announcement_id: String(item.announcement_id),
    org_unit_id: String(item.org_unit_id), content_sha256: item.content_sha256.toLowerCase(), automatic: true };
}
function review(item, reason, rows = [], dates = []) {
  return { state: 'review', reason, course_code: item.course_code,
    announcement_id: String(item.announcement_id), title: 'Instructor announcement needs date review',
    authority: authority(item), candidate_assignment_ids: [...new Set(rows.map(row => row.identity).filter(Boolean))],
    proposed_dates: [...new Set(dates)] };
}
function parseDates(statement, item) {
  const dates = [], invalid = [];
  const inferredYear = +TERM.start.slice(0, 4);
  DATE_TOKEN.lastIndex = 0;
  for (const match of statement.matchAll(DATE_TOKEN)) {
    let year, month, d, explicit;
    if (match[1]) { year = +match[1]; month = +match[2]; d = +match[3]; explicit = true; }
    else if (match[4]) {
      const label = match[4].toLowerCase();
      const matches = MONTHS.map((name, i) => name === label || label.length >= 3 && name.startsWith(label) ? i + 1 : null).filter(Boolean);
      if (matches.length !== 1) continue; // "Test 2" is not a month.
      month = matches[0]; d = +match[5]; year = match[6] ? +match[6] : inferredYear; explicit = Boolean(match[6]);
    } else { month = +match[7]; d = +match[8]; year = match[9] ? +match[9] : inferredYear; explicit = Boolean(match[9]); }
    const key = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const instant = new Date(Date.UTC(year, month - 1, d, 12));
    const before = statement.slice(0, match.index);
    const weekday = WEEKDAY.exec(before);
    const mismatchedWeekday = weekday && ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(weekday[1].slice(0, 3).toLowerCase()) !== instant.getUTCDay();
    const valid = year === inferredYear && month >= 1 && month <= 12 && d >= 1 && d <= 31 &&
      instant.toISOString().slice(0, 10) === key && !mismatchedWeekday &&
      (explicit || +iso(item.published_at || item.feed_published_at || item.observed_at).slice(0, 4) === inferredYear) &&
      +instant >= Date.parse(TERM.start + 'T12:00:00Z') - 14 * DAY &&
      +instant <= Date.parse(TERM.end + 'T12:00:00Z') + 31 * DAY;
    if (!valid) { invalid.push(mismatchedWeekday ? 'weekday_date_mismatch' : 'date_outside_current_term_or_invalid'); continue; }
    const prefix = before.slice(-100);
    dates.push({ key, index: match.index, old: oldLead.test(prefix), target: newLead.test(prefix) });
  }
  return { dates, invalid };
}
function selectDates(statement, item) {
  const { dates, invalid } = parseDates(statement, item);
  if (invalid.length) return { error: invalid[0], dates: dates.map(d => d.key) };
  if (!dates.length) return { error: 'date_not_explicit', dates: [] };
  const changeAt = CHANGE.exec(statement)?.index ?? 0;
  const contrast = /\b(?:instead\s+of|rather\s+than)\b/i.test(statement);
  let targets = dates.filter(d => d.target && !d.old && (contrast || d.index > changeAt));
  if (!targets.length && dates.length === 1 && !dates[0].old &&
      /\b(?:rescheduled|postponed|changed|extended)\s*:\s*$/i.test(statement.slice(0, dates[0].index))) targets = dates;
  const prior = dates.filter(d => d.old || !contrast && d.index < changeAt && d.target);
  const unclassified = dates.filter(d => !targets.includes(d) && !prior.includes(d));
  if (targets.length !== 1 || prior.length > 1 || unclassified.length) {
    return { error: 'ambiguous_date_statement', dates: dates.map(d => d.key) };
  }
  if (prior[0]?.key === targets[0].key) return { error: 'date_change_not_distinct', dates: dates.map(d => d.key) };
  return { target: targets[0].key, prior: prior[0]?.key || null, dates: dates.map(d => d.key) };
}
function sentences(text) {
  return text.replace(/\r/g, '').split(/\n+|;\s*|(?<=[!?])\s+|\.\s+(?=[A-Z])/)
    .map(s => s.trim()).filter(Boolean);
}
function containsTitle(text, key) {
  return key.split(' ').length >= 2 && (` ${canonical(text)} `).includes(` ${key} `);
}
function candidatesFor(statement, item, rows) {
  let matches = rows.filter(row => containsTitle(statement, row.key));
  // A news title can identify a short body such as "It has moved to Oct 19".
  // It may not erase a different explicit title in that body.
  if (!matches.length && !/\b(?:exam|test|quiz|assignment|homework|project|lab)\b/i.test(statement)) {
    matches = rows.filter(row => containsTitle(item.title, row.key));
  }
  return matches;
}
function safeGroup(rows) {
  if (rows.length === 1) return rows[0].event.recurring !== true || Boolean(rows[0].event.recurrence_anchor);
  return rows.length === 2 && rows[0].key === rows[1].key &&
    new Set(rows.map(row => row.kind)).size === 2 && rows.some(row => row.kind === 'due') && rows.some(row => row.kind === 'closes') &&
    sameShape(sourceShape(rows[0].event), sourceShape(rows[1].event)) && rows.every(row => row.event.recurring !== true);
}

/** Derive bounded corrections from trusted collected observations and raw events.
 * This function never fetches pages, writes coursework, or retains raw news prose.
 * The caller owns snapshot freshness, enrolled org identity and content-hash checks.
 */
export function buildAnnouncementDateCorrections({ announcements = [], events = [], previousCorrections = [], now = new Date() } = {}) {
  now = date(now) || new Date();
  const reviews = [], proposals = [], checks = [], observedAuthorities = [];
  const rows = events.flatMap(event => {
    const course = courseForEvent(event), title = titleOf(event);
    const identity = eventIdentity({ ...event, course });
    return sourceNamespace(event.source) === 'elc' && course && identity && date(event.start) &&
      (!event.end || date(event.end) && date(event.end) >= date(event.start)) && title.kind !== 'opens' &&
      !/\b(?:practice|prep|review|study|meeting|lecture)\b/i.test(title.title) ? [{ event, course, identity, ...title }] : [];
  });
  for (const item of [...announcements].sort((a, b) =>
    +(date(a?.modified_at || a?.published_at || a?.feed_published_at || a?.observed_at) || 0) -
    +(date(b?.modified_at || b?.published_at || b?.feed_published_at || b?.observed_at) || 0))) {
    if (!validItem(item, now)) { checks.push({ state: 'rejected', reason: 'invalid_announcement_authority' }); continue; }
    observedAuthorities.push({ course_code: item.course_code, announcement_id: String(item.announcement_id), content_sha256: item.content_sha256.toLowerCase() });
    const scoped = rows.filter(row => row.course.code === item.course_code);
    let found = 0;
    for (const statement of sentences(item.text)) {
      if (!CHANGE.test(statement)) continue;
      const all = candidatesFor(statement, item, scoped);
      if (!all.length) {
        if (/\b(?:exam|test|quiz|assignment|homework|project|lab|due\s+date|deadline)\b/i.test(`${item.title} ${statement}`)) {
          reviews.push(review(item, 'assignment_not_identified')); found++;
        }
        continue;
      }
      const explicitCourses = [...statement.matchAll(/\b(?:BUSN|MGMT|LAND)\s*[-_]?\s*\d{4}E?\b/gi)]
        .map(match => match[0].toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/E$/, ''));
      if (explicitCourses.some(course => course !== item.course_code)) {
        reviews.push(review(item, 'cross_course_reference', all)); found++; continue;
      }
      if (/\b(?:meeting|lecture|session|review|study|studying|prep|practice)\b|office\s+hours/i.test(statement)) {
        reviews.push(review(item, 'related_activity_not_assignment_date', all)); found++; continue;
      }
      if (HYPOTHETICAL.test(statement)) { reviews.push(review(item, 'conditional_or_nonoperative_statement', all)); found++; continue; }
      const parsed = selectDates(statement, item);
      if (parsed.error) { reviews.push(review(item, parsed.error, all, parsed.dates)); found++; continue; }
      const keys = new Set(all.map(row => row.key));
      if (keys.size !== 1) { reviews.push(review(item, 'multiple_assignment_titles', all, parsed.dates)); found++; continue; }
      // Explicit old dates can distinguish a reused title/recurrence, but never
      // choose the nearest event or transfer a correction to a fresh source UID.
      const withPrior = row => {
        if (!parsed.prior) return true;
        if (day(row.event.start) === parsed.prior || day(row.event.start) === parsed.target) return true;
        return previousCorrections.some(record => recordKey(record) === row.identity &&
          record.authority?.verified === true && record.term_id === TERM_ID &&
          sameShape(record.original, sourceShape(row.event)) && date(record.effective?.start_iso) &&
          day(record.effective.start_iso) === parsed.prior);
      };
      let selected = all.filter(withPrior);
      // An earlier announcement in this same complete observation can form an
      // explicit from/to chain while the provider retains its original date.
      if (!selected.length && parsed.prior) selected = all.filter(row => proposals.some(proposal =>
        proposal.rows.some(prior => prior.identity === row.identity) && proposal.target === parsed.prior));
      if (!safeGroup(selected) || selected.some(row => row.event.recurring && !parsed.prior)) {
        reviews.push(review(item, !selected.length ? 'announced_original_date_not_matched' : 'ambiguous_assignment_occurrence', all, parsed.dates)); found++; continue;
      }
      // Fresh instructor/provider agreement on this exact identity supersedes
      // an older overlay. A third, unrelated provider date still needs review.
      if (selected.some(row => previousCorrections.some(record => recordKey(record) === row.identity && record.term_id === TERM_ID &&
        record.authority?.verified === true && !sameShape(record.original, sourceShape(row.event)) &&
        date(record.effective?.start_iso) && day(row.event.start) !== day(record.effective.start_iso) &&
        day(row.event.start) !== parsed.target))) {
        reviews.push(review(item, 'source_occurrence_changed', selected, parsed.dates)); found++; continue;
      }
      proposals.push({ item, rows: selected, target: parsed.target, prior: parsed.prior,
        version: +date(item.modified_at || item.published_at || item.feed_published_at || item.observed_at) });
      found++;
    }
    checks.push({ state: found ? 'date_change_checked' : 'no_explicit_date_change',
      course_code: item.course_code, announcement_id: String(item.announcement_id) });
  }
  const grouped = new Map();
  for (const proposal of proposals) for (const row of proposal.rows) {
    if (!grouped.has(row.identity)) grouped.set(row.identity, []);
    grouped.get(row.identity).push({ ...proposal, row });
  }
  const corrections = [];
  for (const list of grouped.values()) {
    const sorted = list.toSorted((a, b) => a.version - b.version || String(a.item.announcement_id).localeCompare(String(b.item.announcement_id)));
    let chosen = sorted[0], conflict = false;
    for (const next of sorted.slice(1)) {
      if (next.target === chosen.target) { if (next.version >= chosen.version) chosen = next; continue; }
      if (next.version > chosen.version && (String(next.item.announcement_id) === String(chosen.item.announcement_id) || next.prior === chosen.target)) chosen = next;
      else conflict = true;
    }
    const blockingReview = reviews.some(item => item.course_code === chosen.item.course_code &&
      item.candidate_assignment_ids.includes(chosen.row.identity));
    if (conflict || blockingReview) {
      if (conflict) reviews.push(review(chosen.item, 'conflicting_announcement_dates', list.map(p => p.row), list.map(p => p.target)));
      continue;
    }
    corrections.push({ id: `announcement:${chosen.item.course_code}:${chosen.item.announcement_id}:${chosen.row.identity}`,
      term_id: TERM_ID, course_code: chosen.row.course.code, source: chosen.row.event.source,
      uid: chosen.row.event.uid, recurrence_anchor: chosen.row.event.recurrence_anchor || '',
      title: plain(chosen.row.event.summary), original: sourceShape(chosen.row.event),
      effective: { start_iso: midnight(chosen.target), end_iso: midnight(nextDay(chosen.target)), all_day: true },
      authority: authority(chosen.item) });
  }
  return { corrections, reviews, checks, observed_authorities: observedAuthorities };
}
