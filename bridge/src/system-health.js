import {retryAction} from './system-retry.js';
import {clubStatus} from './clubs-store.js';
import {state} from './foundation.js';
// Operational evidence only. Never put deadlines, notes, scores, file names,
// credentials, raw provider errors or raw user agents into these records.
import { loadEvents } from './status.js';
import { COURSES } from './courses.js';
import { CONNECTION_EVIDENCE } from './connection-evidence.js';
import { probeDriveAccess, DRIVE_PROBE_VERSION } from './drive-health.js';
import { driveConfigured } from './drive.js';
import { readAnnouncementRecord, ANNOUNCEMENT_TTL_SECONDS } from './announcement-context.js';

export const CLOUD_KEY = 'system:cloud';
export const LOCAL_KEY = 'system:local';
export const PROBE_KEY = 'system:write-probe';
export const HEALTH_CRON = '*/15 * * * *';
const CLOUD_TTL = 35 * 60;
const DRIVE_TTL = 90 * 60;
const LOCAL_TTL = 150 * 60;
const day = 86400;

export const LOCAL_SERVICES = {
  'elc-daily-sweep': ['eLC content sweep', 'collect', 'Content collection on the Mac; does not verify submission receipts.', 18 * 3600],
  'globus-watch': ['GLO-BUS watcher', 'collect', 'Last recorded schedule read; skipped attempts may not be recorded.', 5 * day],
  'cluely-gpt-sync': ['Lecture pipeline', 'collect', 'Export → verification gate → Drive → bridge. Job result, not a transcript-quality guarantee.', 36 * 3600],
  'grade-check': ['Grade collectors', 'collect', 'Job outcome only. Scores and grade records stay off this bridge.', 5 * day],
  'drive-sync-check': ['Drive desktop sync', 'storage', 'Local-versus-cloud sync check, separate from the bridge Drive API.', day],
  'board-refresh': ['Semester board', 'clients', 'Last board build. The board itself is a daily snapshot.', 2 * day],
  'bridge-health': ['Mac bridge checks', 'core', 'External check from this Mac, hourly at :35; requires the Mac to be awake.', 150 * 60],
};

const messages = {
  ok: 'Check completed successfully.', failed: 'The latest check failed. Inspect this routine’s local log.',
  partial: 'The run reported a partial failure. Some stages or sources did not complete.',
  deferred: 'The job deferred work; completion is not confirmed.',
  session: 'The collector recorded an unavailable eLC browser session.',
  report_problem: 'The latest collection report contains problems; inspect the local report.',
  not_loaded: 'The routine is not loaded in launchd.', missing: 'No readable result is available.',
  unreadable: 'The local result file could not be read.',
  mount: 'The Drive check found the local mount empty while files exist in the cloud.',
  calendar: 'The existing Google Calendar authorization or pending calendar writes need attention; schedule delivery is not confirmed.',
};
export function iso(value) {
  const n = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}
export function stateOf(record, ttl, now = Date.now()) {
  if (!record || !iso(record.last_attempt_at)) return 'unknown';
  const age = now - Date.parse(record.last_attempt_at);
  if (age < -60000 || age > ttl * 1000) return 'stale';
  return ['healthy', 'failed', 'degraded', 'unknown'].includes(record.outcome) ? record.outcome : 'unknown';
}
async function read(env, key) {
  if (!env.NOTES) throw new Error('storage_unbound');
  const raw = await env.NOTES.get(key);
  if (!raw) return null;
  return JSON.parse(raw);
}
function evidence(previous, outcome, at, detail, extra = {}) {
  return { outcome, last_attempt_at: at,
    last_success_at: outcome === 'healthy' ? at : (iso(previous?.last_success_at) || null),
    detail, ...extra };
}
function safeFeedError(value) {
  const http = /HTTP (\d{3})/.exec(String(value));
  if (http) return `Calendar endpoint returned HTTP ${http[1]}.`;
  if (/timeout|abort/i.test(String(value))) return 'Calendar request timed out.';
  if (/invalid_calendar/.test(String(value))) return 'Endpoint did not return a complete iCalendar document.';
  if (/too_large/.test(String(value))) return 'Calendar exceeded the bounded health-check size.';
  return 'Calendar could not be fetched or parsed.';
}

// Source receipt metadata only. Never send announcement titles, excerpts, IDs,
// private feed URLs or correction details into the Systems Bridge topology.
export function announcementHealth(record, now = new Date()) {
  if (record === null) return null;
  const snapshot = record?.snapshot;
  if (!snapshot) return record?.ok === false ? evidence(null,'failed',now.toISOString(),
    'Announcement source receipts could not be read. The source check times are unknown.') : null;
  const known = new Set(COURSES.map(course=>course.code));
  const seen = new Set();
  const coverage = (Array.isArray(snapshot.coverage)?snapshot.coverage:[]).filter(row=>
    known.has(row?.course_code)&&!seen.has(row.course_code)&&seen.add(row.course_code));
  const counts={expected_courses:known.size,full_listing:0,recent_feed:0,failed:0,stale:0,unknown:0};
  for(const row of coverage) {
    const success=iso(row.last_success_at),age=now.getTime()-Date.parse(success);
    if(row.status!=='ok')counts.failed++;
    else if(!success)counts.unknown++;
    else if(age < -60000 || age>ANNOUNCEMENT_TTL_SECONDS*1000)counts.stale++;
    else if(row.complete&&row.scope==='full_listing')counts.full_listing++;
    else counts.recent_feed++;
  }
  counts.unknown+=Math.max(0,counts.expected_courses-coverage.length);
  const healthy=counts.full_listing===counts.expected_courses;
  const detail=healthy ? `Complete instructor announcement listings are current for all ${counts.expected_courses} courses.`
    : `${counts.full_listing}/${counts.expected_courses} complete course listings; ${counts.recent_feed} recent feeds; ${counts.failed} failed, ${counts.stale} stale, ${counts.unknown} unknown. Recent feeds can reveal visible changes, but cannot confirm older edits or removals.`;
  return {outcome:healthy?'healthy':counts.failed===counts.expected_courses?'failed':coverage.length?'degraded':'unknown',
    last_attempt_at:iso(snapshot.attempted_at),last_success_at:iso(snapshot.last_success_at),
    last_complete_success_at:iso(snapshot.last_complete_success_at),detail,coverage:counts};
}

// Each cron writes ONE small snapshot. Page polling only reads it, keeping the
// health page from consuming the write budget or hammering private calendar URLs.
export async function collectCloudHealth(env, put, now = new Date(), fetchImpl = fetch, options = {}) {
  let previous;
  try { previous = await read(env, CLOUD_KEY); } catch { previous = null; }
  const at = now.toISOString();
  const expected = [ ['elc-feed', 'eLC (D2L)', env.FEED_ELC], ['google-feed', 'Google Calendar', env.FEED_PERSONAL] ];
  const { health } = await loadEvents(expected.filter(x => x[2]).map(x => ({ name: x[1], url: x[2] })), {
    windowStart: new Date(now.getTime() - day * 1000), windowEnd: new Date(now.getTime() + day * 1000), fetchImpl,env,now,
  });
  const checks = {};
  for (const [id, name, url] of expected) {
    const h = health.find(x => x.source === name);
    const incomplete = h?.ok && h.coverage_complete === false;
    const dateConflict = h?.date_conflicts?.length > 0;
    checks[id] = evidence(previous?.checks?.[id], !url ? 'unknown' : incomplete ? 'degraded' : h?.ok ? 'healthy' : 'failed', at,
      !url ? 'This calendar feed is not configured.' : dateConflict ? 'A reviewed instructor date no longer matches the source calendar; check the original course source.' : incomplete ? 'Calendar recurrence coverage is incomplete; check the original calendar.' : h?.ok ? 'Calendar fetched and parsed successfully.' : safeFeedError(h?.error),
      { events: h?.ok ? h.events : null });
  }
  // Use the existing schedule/snapshot, at most once an hour. Page refreshes
  // never run probes. Failed attempts are throttled too; deployment is not a test.
  const oldDrive = previous?.checks?.['drive-api'];
  const driveAge = now.getTime() - Date.parse(oldDrive?.last_attempt_at);
  const configured = driveConfigured(env);
  if (!options.forceDrive && Number.isFinite(driveAge) && driveAge >= 0 && driveAge < 3600000 && oldDrive.configured === configured && oldDrive.probe_version === DRIVE_PROBE_VERSION) {
    checks['drive-api'] = oldDrive;
  } else {
    const result = await probeDriveAccess(env, fetchImpl);
    checks['drive-api'] = evidence(oldDrive, result.outcome, at, result.detail, {reason:result.reason, configured, probe_version:DRIVE_PROBE_VERSION});
  }
  const snapshot = { checked_at: at, checks };
  await put(env, CLOUD_KEY, JSON.stringify(snapshot), 'system-health-cron');
  return snapshot;
}

// Reject everything outside the metadata contract. Free text from local logs is
// intentionally not accepted: it often contains student records or private URLs.
export function localReport(body, previous = {}, now = new Date()) {
  if (!body || !Array.isArray(body.checks) || body.checks.length > 7) throw new Error('invalid_report');
  const checks = {};
  for (const c of body.checks) {
    if (!c || typeof c !== 'object' || !LOCAL_SERVICES[c.id] || checks[c.id]) throw new Error('invalid_service');
    if (!['healthy', 'failed', 'degraded', 'unknown'].includes(c.outcome) || !messages[c.reason]) throw new Error('invalid_result');
    const at = iso(c.last_attempt_at), success = iso(c.last_success_at);
    if ([at, success].some(t => t && Date.parse(t) > now.getTime() + 60000)) throw new Error('future_observation');
    const old = previous?.checks?.[c.id];
    if (old?.last_attempt_at && at && Date.parse(at) < Date.parse(old.last_attempt_at)) throw new Error('older_observation');
    const latestSuccess = [success, iso(old?.last_success_at)].filter(Boolean).sort().at(-1) || null;
    checks[c.id] = { outcome: c.outcome, last_attempt_at: at, last_success_at: latestSuccess,
      detail: messages[c.reason], reason: c.reason, loaded: typeof c.loaded === 'boolean' ? c.loaded : null };
  }
  return { received_at: now.toISOString(), checks };
}
export async function storeLocalHealth(env, body, put, now = new Date()) {
  const previous = await read(env, LOCAL_KEY);
  const report = localReport(body, previous, now);
  await put(env, LOCAL_KEY, JSON.stringify(report), 'system-health-local');
  return report;
}

export async function systemHealth(env, now = new Date()) {
  const at = now.toISOString();
  const results = await Promise.allSettled([CLOUD_KEY, LOCAL_KEY, PROBE_KEY, ...COURSES.map(c => `lastcall:${c.code}`), 'lastcall:ALL'].map(k => read(env, k)));
  const values = results.map(r => r.status === 'fulfilled' ? r.value : null);
  const [cloud, local, probe] = values;
  const storageOK = results.every(r => r.status === 'fulfilled');
  const announcementCheck=announcementHealth(await readAnnouncementRecord(env),now);
  let foundationCheck;
  try {
    const recordHealth=await state(env).health();
    foundationCheck=evidence(null,recordHealth.ready?'healthy':'degraded',at,
      recordHealth.ready?'Transactional record storage responded; migration is initialized.':'Record storage is waiting for a safe migration. Progress reads and writes are paused.');
  } catch {
    foundationCheck=evidence(null,'failed',at,'Transactional record storage could not be reached. Progress save success is not confirmed.');
  }
  const localFresh = stateOf({ last_attempt_at: local?.received_at, outcome: 'healthy' }, LOCAL_TTL, now.getTime());
  const node = (id, label, group, record, ttl, scope, next_step, extra = {}) => ({
    id, label, group, status: stateOf(record, ttl, now.getTime()),
    outcome: record?.outcome || 'unknown', last_attempt_at: record?.last_attempt_at || null,
    last_success_at: record?.last_success_at || null, stale_after_seconds: ttl,
    detail: record?.detail || 'No observation has been recorded.', scope, next_step, ...extra,
  });
  const nodes = [
    node('records','Progress & sessions','storage',foundationCheck,90,
      'Read-only storage readiness check. Does not perform a coursework write or prove every client reports its work.',
      'Check the BRIDGE_STATE binding and migration readiness. Retry pending saves with the same operation key.'),
    node('bridge', 'Bridge API', 'core', evidence(null, 'healthy', at, 'This authenticated health request reached the canonical Worker.'), 90,
      'Current health request only; does not test every bridge route.', 'If live updates fail, check your connection and reopen the authenticated dashboard.'),
    node('kv', 'Cloudflare KV', 'storage', evidence(null, storageOK ? 'healthy' : 'failed', at,
      storageOK ? 'Monitoring records were read successfully.' : 'One or more monitoring records could not be read.'), 90,
      'Read path only. See Storage write check for the most recent write acknowledgement.', 'Inspect Worker logs and KV binding/quota if failures persist.'),
    node('write', 'Storage write check', 'storage', probe, LOCAL_TTL,
      'An acknowledged write to a dedicated diagnostic key; no coursework is changed.', 'The Mac health routine checks this hourly.'),
    node('monitor', 'Cloud monitor', 'core', cloud ? evidence(null, 'healthy', cloud.checked_at, 'Scheduled collection saved a monitoring snapshot.') : null, CLOUD_TTL,
      'Runs every 15 minutes in the canonical Worker, even with browsers closed.', 'A stale result means collection or persistence stopped; inspect the canonical cron and KV quota.'),
    node('local', 'Mac reporter', 'core', local ? evidence(null, 'healthy', local.received_at, 'Received a metadata-only snapshot from the Mac.') : null, LOCAL_TTL,
      'Publishes during the existing hourly bridge-health routine. Mac sleep or loss of network delays it.', 'Wake the Mac and inspect bridge-health in routinectl if the report is stale.'),
  ];
  for (const [id, label] of [['elc-feed', 'eLC calendar'], ['google-feed', 'Google Calendar']]) {
    nodes.push(node(id, label, 'feeds', cloud?.checks?.[id], CLOUD_TTL,
      id === 'elc-feed' ? 'iCalendar subscription only. It does not test portal login, announcements, grades, or submissions.' : 'Private iCalendar read only. Does not test calendar write access.',
      'Inspect feed configuration or provider availability if this check fails.', { events: cloud?.checks?.[id]?.events ?? null }));
  }
  nodes.push(node('instructor-announcements','Instructor announcements','feeds',announcementCheck,ANNOUNCEMENT_TTL_SECONDS,
    'Dated announcement source receipts from the existing hourly Mac collection. Complete listings and limited recent feeds have separate coverage. Calendar availability does not verify this source.',
    'If checks are stale, make sure the Mac is available. For incomplete older-news coverage, check eLC login and the course announcement listing.',
    {monitoring:'hourly',coverage:announcementCheck?.coverage||null,
      last_complete_success_at:announcementCheck?.last_complete_success_at||null}));
  for (const [id, [label, group, scope, ttl]] of Object.entries(LOCAL_SERVICES)) {
    const n = node(id, label, group, local?.checks?.[id], ttl, scope, `Inspect “${id}” with routinectl on the Mac.`);
    if (localFresh !== 'healthy' && n.status !== 'unknown') { n.status = 'stale'; n.detail += ' The Mac reporter is overdue; this is historical evidence.'; }
    n.reporter_received_at = local?.received_at || null;
    nodes.push(n);
  }
  // Course-scoped traffic is not a client heartbeat. UA and request content never
  // leave KV, and silence must not be called an outage for an on-demand assistant.
  COURSES.forEach((c, i) => nodes.push(node(`gpt-${c.code}`, c.code + ' GPT', 'clients', null, 0,
    'Your class GPT connection, not the eLC calendar or a submission status. Setup tests are historical; this on-demand assistant has no continuous heartbeat.',
    'Use the class GPT status Action to test it again when needed. Being idle is not an outage.',
    { last_activity_at: iso(values[3 + i]?.at), detail: values[3 + i]?.at ? 'A request for this course was recorded; it does not identify which assistant made it.' : 'No course request marker is available.', kind: 'unmonitored', manual_check:CONNECTION_EVIDENCE['gpt-'+c.code] })));
  nodes.push(node('drive-api','Drive library API','storage',cloud?.checks?.['drive-api'],DRIVE_TTL,
    'Hourly read-only authorization and Drive API metadata check. Does not verify library-folder contents, local sync or GPT Knowledge.',
    'If authorization fails, review the existing Drive connection. For missing local files, inspect Drive desktop sync instead.',
    {configured:driveConfigured(env),monitoring:'hourly'}));
  for (const [id, label, scope] of [
    ['codex', 'Codex MCP', 'On-demand client; no authenticated per-client heartbeat is collected.'],
    ['claude', 'Claude Code', 'On-demand client; note activity does not prove a current session.'],
    ['chrome', 'Chrome sessions', 'Shared dependency of local collectors. No automatic per-portal login probe runs; any dated manual check below covers only the named portal.'],
    ['assistant', 'Dashboard assistant', 'API credential configured: ' + (Boolean(env.ANTHROPIC_API_KEY) ? 'yes' : 'no') + '. Paid inference is not used as a health probe.'],
    ['knowledge', 'GPT Knowledge', 'No automatic check of bundle presence, freshness or processing runs. Dated manual checks are shown separately and cover only their stated files and observations.'],
  ]) nodes.push(node(id, label, id === 'chrome' ? 'collect' : 'clients', null, 0, scope,
    id === 'knowledge' ? 'Review the GPT file inventory when course bundles change; file presence alone does not prove content freshness.'
    : id === 'chrome' ? 'Open the relevant portal and check its login when a collector reports a session failure. Do not infer login from an open Chrome window.'
    : 'No continuous check is expected for this on-demand client. Test it when used; silence alone is not a failure.',
    { kind:'unmonitored', manual_check:CONNECTION_EVIDENCE[id] || null }));
  let clubCheck=null;
  try {
    const c=clubStatus(await state(env).clubOverview(),now.getTime());
    clubCheck=c.sync?evidence(null,c.state==='current'?'healthy':'degraded',c.sync.checked_at,
      c.state==='current'?'Club transcript retrieval and project publication are verified.':'Club sources or project delivery need attention. Open Clubs for the scoped receipt.') : null;
  } catch { clubCheck=evidence(null,'failed',at,'Club record storage could not be read.'); }
  nodes.push(node('clubs','Clubs','storage',clubCheck,36*3600,
    'Club transcript imports, GroupMe review freshness, and ChatGPT project retrieval. No coursework completion or attendance is inferred.',
    'Open Clubs to inspect missing recordings, source freshness and pending project uploads.'));
  let retries=[];
  try { retries=await state(env).retryList(); } catch { /* Health remains readable if retry coordination is unavailable. */ }
  for(const n of nodes) {
    n.retry=retryAction(n.id);
    n.retry_job=retries.find(j=>j.target===n.retry.target)||null;
    const fresh=retries.find(j=>j.observations?.[n.id])?.observations?.[n.id];
    if(fresh&&(!n.last_attempt_at||Date.parse(fresh.last_attempt_at)>Date.parse(n.last_attempt_at))) {
      Object.assign(n,fresh);n.status=stateOf(fresh,n.stale_after_seconds,now.getTime());
    }
  }
  const edges = [
    ['elc-feed','bridge','Calendar read'], ['google-feed','bridge','Calendar read'], ['monitor','elc-feed','Checks'], ['monitor','google-feed','Checks'],
    ['elc-daily-sweep','instructor-announcements','Source checks'], ['instructor-announcements','records','Source receipts'], ['instructor-announcements','bridge','Reviewed date changes'],
    ['bridge','records','Transactional records'], ['bridge','kv','Read'], ['write','kv','Diagnostic write'], ['local','bridge','Health report'], ['bridge-health','bridge','External probe'],
    ['chrome','elc-daily-sweep','Session dependency'], ['chrome','globus-watch','Session dependency'], ['chrome','grade-check','Session dependency'],
    ['elc-daily-sweep','drive-sync-check','Files to mount'], ['elc-daily-sweep','knowledge','Extracted bundles'], ['globus-watch','google-feed','Schedule pipeline'],
    ['cluely-gpt-sync','clubs','Club transcripts'], ['bridge','clubs','Club records'], ['clubs','codex','Club workspace'],
    ['cluely-gpt-sync','bridge','Verified note pipeline'], ['drive-api','bridge','Original material'], ['bridge','assistant','Status context'],
    ['bridge','codex','MCP requests'], ['bridge','claude','API requests'], ['bridge','board-refresh','Daily status'],
    ...COURSES.map(c => ['bridge',`gpt-${c.code}`,'Course status']),
  ].map(([from,to,label]) => ({ from,to,label, status: (nodes.find(n=>n.id===from)?.status === 'unknown' || nodes.find(n=>n.id===to)?.status === 'unknown') ? 'unknown' : [from,to].map(id=>nodes.find(n=>n.id===id).status).find(s=>s==='failed'||s==='stale'||s==='degraded') || 'healthy' }));
  return { schema_version: 1, generated_at: at, refresh_seconds: 30, nodes, edges,
    collection: { cloud_interval_seconds: 900, cloud_checked_at: cloud?.checked_at || null, local_received_at: local?.received_at || null },
    limitations: ['The map and API share the same Worker. An already-open page detects missed updates, but a total Worker outage can prevent this page loading. This is not an independent uptime monitor.',
      'Connections describe the known data flow. Node checks cover only the scope shown in the inspector; edges are not separate end-to-end probes.',
      'No submission receipts, scores, coursework content, credentials, raw logs, uptime percentages, or invented history are included.'] };
}
