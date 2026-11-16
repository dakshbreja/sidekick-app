// Change detection.
//
// The calendars tell you what is due *now*. They never tell you that it used to be
// something else — so a professor moving a deadline is invisible. This keeps a
// snapshot of the deadline set from the last fetch, diffs the new one against it,
// and appends anything that moved, appeared or vanished to a rolling log.
//
// The hard part is not the diff, it is not crying wolf. The fetch window slides
// forward every day (10 days back, 45 forward), so items fall out of the back and
// appear over the front constantly. Those are not changes. Every snapshot therefore
// carries the window it was taken with, and an add/remove only counts when the item
// sits inside *both* windows and so genuinely should have been visible in both.

import { eventIdentity } from './identity.js';
import { courseForEvent } from './courses.js';
import { reviewedModuleContainer } from './reviewed-module-relations.js';

export const CHANGE_LOG_KEEP = 40;
export const CHANGE_LOG_MAX_AGE_DAYS = 21;

/** Stable identity for a deadline across fetches. */
export function identityKey(d) {
  // A series UID identifies every occurrence. Keying only by it made an
  // unchanged weekly deadline look moved whenever the visible window advanced.
  // Normalization already supplies source/course/term/original-anchor identity;
  // detached overrides retain that identity when their actual date changes.
  if (d.assignment_id) return `assignment:${d.assignment_id}`;
  if (d.uid && d.recurrence_anchor) return `assignment:${eventIdentity(d)}`;
  if (d.uid) return `uid:${d.uid}`;
  const code = d.course ? d.course.code : '?';
  const title = String(d.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `tc:${code}|${title}`;
}

export function snapshotOf(deadlines, windowStart, windowEnd, sourceEvents = []) {
  return {
    window: { start: windowStart.toISOString(), end: windowEnd.toISOString() },
    // Sorted by key, and that is load-bearing rather than tidiness. The caller
    // decides whether to spend a KV write by string-comparing this array against
    // the stored one, so any run-to-run instability in feed ordering would read as
    // "the deadlines moved" and burn a write on every single request. diffSnapshots
    // keys everything by `key` and never looks at order, so imposing one is free.
    items: deadlines
      .map((d) => ({
        key: identityKey(d),
        title: d.title,
        course: d.course ? d.course.code : null,
        due: d.start.toISOString(),
        ...(d.date_reconciliation?.time_verification === 'unconfirmed' ? {
          date: d.date_reconciliation.date, time_verification: 'unconfirmed',
        } : {}),
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    // Keep proof that an item left the deadline model while remaining in the
    // source. Only exact reviewed source identities qualify, never a title match.
    reviewed_containers: sourceEvents.flatMap(event => {
      const course = courseForEvent(event);
      const relation = reviewedModuleContainer(event, course);
      if (!relation) return [];
      return [{ key: `assignment:${eventIdentity({ ...event, course })}`,
        title: relation.module_title, course: course.code, due: event.start.toISOString(),
        source_uid: event.uid, module_id: relation.module_id, term_id: relation.term_id,
        reviewed_at: relation.reviewed_at }];
    }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  };
}

function inWindow(iso, win) {
  if (!win) return true;
  const t = Date.parse(iso);
  return t >= Date.parse(win.start) && t <= Date.parse(win.end);
}

/**
 * Diff two snapshots. Returns change records, newest-relevant first is not
 * guaranteed — the caller stamps and orders them.
 */
export function diffSnapshots(prev, next) {
  if (!prev || !Array.isArray(prev.items)) return [];

  const prevMap = new Map(prev.items.map((i) => [i.key, i]));
  const nextMap = new Map(next.items.map((i) => [i.key, i]));
  const priorContainers = new Set((prev.reviewed_containers || []).map(i => i.key));
  const currentContainers = new Set((next.reviewed_containers || []).map(i => i.key));
  const out = [];

  for (const [key, cur] of nextMap) {
    const old = prevMap.get(key);
    if (!old) {
      // New to us. Only a real addition if it should already have been visible
      // last time — otherwise the window simply slid over it.
      if (!priorContainers.has(key) && inWindow(cur.due, prev.window)) {
        out.push({ type: 'added', key, course: cur.course, title: cur.title, to: cur.due });
      }
      continue;
    }
    if (old.due !== cur.due) {
      out.push({ type: 'moved', key, course: cur.course, title: cur.title, from: old.due, to: cur.due });
    }
    if (old.title !== cur.title) {
      out.push({ type: 'renamed', key, course: cur.course, title: cur.title, from: old.title, to: cur.title });
    }
  }

  for (const [key, old] of prevMap) {
    if (nextMap.has(key) || currentContainers.has(key)) continue;
    // Only a real removal if it would still be inside the current window.
    if (inWindow(old.due, next.window)) {
      out.push({ type: 'removed', key, course: old.course, title: old.title, from: old.due });
    }
  }

  return out;
}

/** Correct model-transition notices only with current exact source proof.
 * Keep the original timestamp, type, value and source identity in the record;
 * unrelated and genuinely historical removals remain untouched.
 */
export function reconcileChangeLog(log, snapshot, nowISO) {
  const containers = new Map((snapshot.reviewed_containers || []).map(i => [i.key, i]));
  const deadlines = new Map((snapshot.items || []).map(i => [i.key, i]));
  return (log || []).map(change => {
    const current = containers.get(change.key);
    if (change.type === 'removed' && current && change.course === current.course
        && change.title === current.title && change.from === current.due
        && Date.parse(change.at) >= Date.parse(current.reviewed_at)) {
      return { ...change, type: 'reclassified', previous_type: 'removed',
        classification: 'course_module', correction: {
          reason: 'reviewed_module_projection', observed_at: nowISO,
          source_uid: current.source_uid, module_id: current.module_id,
          term_id: current.term_id, key: current.key, reviewed_at: current.reviewed_at,
        } };
    }
    const deadline = deadlines.get(change.key);
    if (['moved', 'added'].includes(change.type) && deadline?.time_verification === 'unconfirmed'
        && change.course === deadline.course && change.to === deadline.due) {
      return { ...change, to_date: deadline.date, to_time_verification: 'unconfirmed' };
    }
    return change;
  });
}

/** Append new changes to the log, skipping ones already recorded, and trim it. */
export function mergeChangeLog(log, changes, nowISO) {
  const existing = new Set(
    (log || []).map((c) => `${c.type}|${c.key}|${c.from || ''}|${c.to || ''}`)
  );
  const merged = [...(log || [])];
  for (const c of changes) {
    const sig = `${c.type}|${c.key}|${c.from || ''}|${c.to || ''}`;
    if (existing.has(sig)) continue;
    existing.add(sig);
    merged.push({ ...c, at: nowISO });
  }

  const cutoff = Date.parse(nowISO) - CHANGE_LOG_MAX_AGE_DAYS * 86400000;
  return merged
    .filter((c) => Date.parse(c.at) >= cutoff)
    .slice(-CHANGE_LOG_KEEP);
}

/** Human phrasing for the briefing. */
export function describeChange(c, fmtDate) {
  const when = (iso) => (fmtDate ? fmtDate(new Date(iso)) : iso);
  const label = c.course ? `${c.course} ` : '';
  const dateOnly = c.to_time_verification === 'unconfirmed' && /^\d{4}-\d{2}-\d{2}$/.test(c.to_date || '');
  const to = () => dateOnly ? `${c.to_date} (time unconfirmed)` : when(c.to);
  if (c.type === 'moved') return `${label}"${c.title}" moved from ${when(c.from)} to ${to()}`;
  if (c.type === 'added') return `${label}"${c.title}" was added, due ${to()}`;
  if (c.type === 'removed') return `${label}"${c.title}" disappeared from the calendar (was ${when(c.from)})`;
  if (c.type === 'reclassified') return `${label}"${c.title}" is course module timing, not a separate deadline; its source calendar entry remains present`;
  if (c.type === 'renamed') return `${label}"${c.from}" was renamed to "${c.to}"`;
  return `${label}${c.title} changed`;
}
