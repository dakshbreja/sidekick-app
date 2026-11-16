import { TERM } from './courses.js';

export const TERM_ID = TERM.id || TERM.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
export const normalizeTitle = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = value => normalizeTitle(value).split(' ').filter(Boolean).map(v => /^\d+$/.test(v) ? String(Number(v)) : v);
export const sourceNamespace = value => /elc|d2l/i.test(value) ? 'elc' : /google|personal/i.test(value) ? 'google' : String(value || 'unknown').toLowerCase();

// Collision-free encoding of the complete identity, not a fuzzy title hash. The
// source namespace, course, term and recurrence anchor all matter in addition to UID.
export function eventIdentity(event) {
  if (!event.uid || String(event.uid).length > 1024) return null;
  const key = [TERM_ID, event.course?.code || 'GENERAL', sourceNamespace(event.source), String(event.uid), event.recurrence_anchor || ''];
  const bytes = new TextEncoder().encode(JSON.stringify(key));
  return 'a1_' + btoa(Array.from(bytes, b => String.fromCharCode(b)).join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeIdentity(id) {
  if (typeof id !== 'string' || id.length > 2200 || !/^a1_[A-Za-z0-9_-]+$/.test(id)) return null;
  try {
    const str = atob(id.slice(3).replaceAll('-', '+').replaceAll('_', '/'));
    const key = JSON.parse(new TextDecoder().decode(Uint8Array.from(str, c => c.charCodeAt(0))));
    if (!Array.isArray(key) || key.length !== 5 || key.some(v => typeof v !== 'string')) return null;
    return {term:key[0],course:key[1],source:key[2],uid:key[3],occurrence:key[4]};
  } catch { return null; }
}

export function sameAssignment(report, deadline) {
  if (report.identity_resolution !== 'linked' || report.term_id !== TERM_ID || !report.assignment_id) return false;
  const refs = new Set([report.assignment_id, ...(report.assignment_refs || [])]);
  return [deadline.assignment_id, ...(deadline.assignment_refs || [])].some(id => id && refs.has(id));
}

export function candidateSummary(d) {
  return {assignment_id:d.assignment_id, title:d.title, course_code:d.course_code || null,
    when_iso:d.when_iso, when:d.when, source:d.source_namespace};
}

export function resolveReportIdentity(body, deadlines, previous, course) {
  const term = body.term_id || TERM_ID;
  if (term !== TERM_ID) return {error:'wrong_term',status:409};
  let matchMethod = body.assignment_id || body.when_iso ? 'explicit_reference' : 'exact';
  let pool = deadlines.filter(d => (d.course_code || 'GENERAL') === course);
  const name = normalizeTitle(body.item);
  const isCurrent = p => pool.some(d => sameAssignment(p,d));
  if (body.assignment_id) {
    const id = decodeIdentity(body.assignment_id);
    if (!id || id.term !== TERM_ID || id.course !== course) return {error:'assignment_scope_mismatch',status:400};
    pool = pool.filter(d => [d.assignment_id,...(d.assignment_refs || [])].includes(body.assignment_id));
  } else {
    const aliases = previous.filter(p => isCurrent(p) && [p.item,...(p.title_aliases || [])].some(t => normalizeTitle(t) === name));
    const exact = pool.filter(d => normalizeTitle(d.title) === name || aliases.some(p => sameAssignment(p,d)));
    if (exact.length) pool = exact;
    else { matchMethod='unique_alias'; const wanted=tokens(body.item); pool=pool.filter(d => wanted.length && wanted.every(t => tokens(d.title).includes(t))); }
  }
  if (body.when_iso) {
    const instant = Date.parse(body.when_iso);
    if (!Number.isFinite(instant)) return {error:'invalid_when_iso',status:400};
    pool=pool.filter(d => Date.parse(d.when_iso) === instant);
  }
  const distinct = [...new Map(pool.map(d => [d.assignment_id || JSON.stringify(candidateSummary(d)),d])).values()];
  if (distinct.length > 1) return {error:'ambiguous_assignment',status:409,candidates:distinct.map(candidateSummary)};
  const found=distinct[0];
  if (body.assignment_id && !found) return {error:'assignment_not_in_current_feed',status:409};
  if (!found?.assignment_id) return {term_id:TERM_ID,assignment_id:null,assignment_refs:[],identity_resolution:'unresolved',
    identity_reason:found ? 'source_has_no_stable_identity' : 'no_current_assignment_match'};
  // An old title is an alias only while its source identity still matches. A new
  // source record with the same title needs the date or explicit current identity.
  const reused=previous.some(p => p.assignment_id && normalizeTitle(p.item) === name && !sameAssignment(p,found));
  if (reused && !body.assignment_id && !body.when_iso) return {error:'reused_title_needs_reference',status:409,candidates:[candidateSummary(found)]};
  return {term_id:TERM_ID,assignment_id:found.assignment_id,assignment_refs:found.assignment_refs || [found.assignment_id],
    identity_resolution:'linked',identity_reason:null,identity_match_method:matchMethod,reference:{title:found.title,when_iso:found.when_iso,source:found.source_namespace}};
}
