// Cloudflare Worker: serves live course status to Daksh's ChatGPT custom GPTs.
//
//   GET  /status?course=BUSN5000   -> live briefing, fetched fresh from the calendar feeds
//   POST /note                     -> Claude leaves a "here's what we just worked on" note
//   GET  /note?course=BUSN5000     -> read the current note back
//   GET  /health                   -> feed reachability
//
// Private APIs require the integration bearer token or a revocable browser session.
// Unauthenticated HTML entry renders only a public sign-in shell; APIs remain private.

import { loadEvents, buildStatus, normalizeEvents, TZ } from './status.js';
import { announcementRoutes } from './announcement-context.js';
import { buildAgenda, agendaWindow } from './agenda.js';
import { authenticate, authRoutes, safeEqual, cookieValue, issueSession } from './auth.js';
import { signInResponse } from './sign-in.js';
import { publicInfoResponse } from './public-info.js';
import {agentsResponse} from './agents-page.js';
import {buildNextActions} from './next-actions.js';
import {learnerRoutes} from './learner-routes.js';
import {profileHtml} from './profile-page.js';
import {addLearnerReviews} from './learner-review.js';
import {learnerMcp} from './learner-mcp.js';
import { readRecords, digest, readBody } from './foundation.js';
import { recordRoutes } from './record-routes.js';
import {PASS_TOOLS,executePassTool} from './pass-tools.js';
import {passMcpRoute,passConnectionRoutes} from './pass-mcp.js';
import {projectPassRoutes} from './project-pass-tools.js';
import {projectClientRoute,projectConnectionRoutes,PROJECT_OPENAPI} from './project-pass-mcp.js';
import { learningRoutes } from './learning-routes.js';
import { snapshotOf, diffSnapshots, mergeChangeLog, reconcileChangeLog } from './changes.js';
import { resolveCourse, COURSES, TERM } from './courses.js';
import openapi from './openapi.js';
import { appHtml } from './app.js';
import { clubsRoutes } from './clubs-routes.js';
import { clubsHtml } from './clubs-page.js';
import { retryRoutes } from './system-retry.js';
import { systemHtml } from './system-page.js';
import { systemHealth, collectCloudHealth, storeLocalHealth, PROBE_KEY, HEALTH_CRON } from './system-health.js';
import { askClaude } from './ask.js';
import {
  driveConfigured,
  DriveError,
  search as driveSearch,
  fileMeta as driveFileMeta,
  fileText as driveFileText,
} from './drive.js';
import { agentGuide, COMMANDS, CALL_POLICY, COMMAND_HELP } from './commands.js';

const LOOKBACK_DAYS = 10;
const LOOKAHEAD_DAYS = 45;
const NOTE_TTL_SECONDS = 60 * 60 * 24 * 21; // notes older than three weeks are stale
const LASTCALL_MIN_INTERVAL_MS = 60 * 60 * 1000; // rewrite the wiring marker hourly at most

// Not every deadline belongs to a course. The advisor meeting, drop/add, the
// withdrawal date — university-wide items carry course_code: null, and until
// now POST /progress rejected them outright, so they could never be ticked off.
// They live in their own bucket; completion matching keys on title, not course,
// so they still tag the right deadline.
const GENERAL = 'GENERAL';
function progressBucket(raw) {
  const v = (raw == null ? '' : String(raw)).trim();
  if (!v || /^(general|all courses|none|n\/a)$/i.test(v)) return { code: GENERAL };
  return resolveCourse(v);
}


function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function feedsFrom(env) {
  const feeds = [];
  if (env.FEED_ELC) feeds.push({ name: 'eLC (D2L)', url: env.FEED_ELC });
  if (env.FEED_PERSONAL) feeds.push({ name: 'Google Calendar', url: env.FEED_PERSONAL });
  return feeds;
}


// ---- Accumulated class notes -------------------------------------------------
// Unlike `note:` (one note per course, newest overwrites), these ACCUMULATE: each
// class session appends an entry so the GPT sees the arc of the semester, not just
// the last lecture. No TTL - they should survive the whole term. Two caps keep the
// /status payload sane; the oldest entries fall off first.
const CLASS_NOTES_KEEP = 14;
const CLASS_NOTES_MAX_CHARS = 18000;


// ---- Progress (write-back from the GPTs) ------------------------------------
// The GPTs are the only thing that talks to Daksh daily, so they are the only
// place "I finished that" can realistically be captured. Deadlines come from
// calendars; completion can only come from him. No TTL - a semester's record.
const PROGRESS_KEEP = 80;

const SNAPSHOT_KEY = 'snapshot:deadlines';
const CHANGE_LOG_KEY = 'changes:log';

// ---- Library (the original documents in Drive) -------------------------------
// A Worker cannot read a PDF, so the sweep — which already extracts every PDF it
// downloads — pushes that text here to stand in. Keyed by the filename as it is
// FILED IN DRIVE, because that is the only string both sides can agree on: the
// sweep renames on the way in (W03 prefixes and so on), so the eLC name and the
// Drive name are routinely different.
// Preserve complete long course packets while keeping ingestion finite.
// Interactive document reads retain their separate 120,000-character limit.
const DOC_TEXT_MAX_CHARS = 2000000;
const DOC_TEXT_MAX_BODY_BYTES = 12100000; // Worst-case JSON escaping plus metadata.

function docTextKey(filename) {
  const norm = String(filename)
    .replace(/\.[a-z0-9]{1,5}$/i, '')       // extension carries no meaning here
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `doctext:${norm}`;
}

// New publisher receipts are scoped by course and exact Drive filename. Keep
// legacy text readable only when its stored provenance matches both identities.
function materialCourse(raw) {
  if(typeof raw!=='string') return null;
  const normalized=raw.toUpperCase().replace(/[^A-Z0-9]/g,'');
  return COURSES.find(c=>c.code===normalized || c.label.toUpperCase().replace(/[^A-Z0-9]/g,'')===normalized) || null;
}
async function readDocText(env, course, filename, expectedHash = null) {
  if (!course || !env.NOTES) return null;
  const key = `doctext:v2:${course.code}:${await digest(filename)}`;
  if (expectedHash) {
    const exact = await readJSON(env, `doctext:v3:${course.code}:${await digest(filename)}:${expectedHash}`, null);
    // A mutable legacy latest pointer cannot prove a retained exact variant:
    // another same-name topic may replace it immediately after this read.
    return exact && await digest(exact.text) === expectedHash ? exact : null;
  }
  const current = await readJSON(env, key, null);
  if (current) return current;
  const legacy = await readJSON(env, docTextKey(filename), null);
  return legacy && materialCourse(legacy.course)?.code === course.code && legacy.filename === filename ? legacy : null;
}
async function textReceipt(record) {
  return {ok:true, stored:record.filename, course:materialCourse(record.course)?.code,
    chars:record.text.length, text_sha256:await digest(record.text), truncated:record.truncated === true};
}

function driveNotConfigured() {
  return json({
    error: 'drive_not_configured',
    detail: 'The bridge has no Google Drive credentials. Configure a read-only service account '
      + 'with GDRIVE_SERVICE_ACCOUNT_JSON and GDRIVE_ROOT_ID, or use scripts/drive_auth.py '
      + 'with GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET / GDRIVE_REFRESH_TOKEN.',
  }, 501);
}

function driveError(err) {
  if (err instanceof DriveError) {
    return json({ error: 'drive_error', detail: err.message }, err.status);
  }
  throw err;
}

async function readJSON(env, key, fallback) {
  if (!env.NOTES) return fallback;
  const raw = await env.NOTES.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

/**
 * Snapshot the full deadline set, diff it against last time, and log anything that
 * moved. Deliberately uses every course even on a scoped request — diffing only the
 * requested course would read every other course as deleted.
 */
/** Thrown when Cloudflare refuses a write because the daily KV quota is spent. */
class KvWriteLimit extends Error {}

/**
 * Every KV write in this Worker goes through here, for two reasons.
 *
 * The first is visibility. On 24 Aug the free tier's 1,000 writes/day cap was hit
 * and there was no way to tell what had spent it — the Worker recorded nothing
 * about its own writes, so diagnosing it meant guessing at suspects. Each write now
 * logs its key and the reason it happened, which `wrangler tail` and the
 * observability panel will show.
 *
 * The second is that hitting the cap should not look like a crash. An uncaught
 * put() rejection surfaces as a bare "error code: 1101" 500, which told the Cluely
 * push and the eLC sweep nothing useful. Callers get a typed error instead so they
 * can answer 503 "come back tomorrow" rather than "something exploded".
 */
async function kvPut(env, key, value, reason, options) {
  try {
    await env.NOTES.put(key, value, options);
    console.log(`KV_PUT ok key=${key} reason=${reason} bytes=${value.length}`);
  } catch (err) {
    const msg = String((err && err.message) || err);
    console.log(`KV_PUT FAILED key=${key} reason=${reason} err=${msg}`);
    if (/limit exceeded/i.test(msg)) {
      throw new KvWriteLimit(msg);
    }
    throw err;
  }
}

/** 503 rather than 500: the request was fine, the quota was not. */
function kvLimitResponse() {
  return json({
    error: 'kv_write_limit',
    detail: "Cloudflare's daily KV write quota is exhausted; nothing was stored.",
    retry_after: 'resets at 00:00 UTC',
  }, 503);
}

async function detectChanges(env, ctx, events, windowStart, windowEnd, nowISO) {
  if (!env.NOTES) return [];
  const all = normalizeEvents(events).deadlines;
  const next = snapshotOf(all, windowStart, windowEnd, events);
  next.normalization_version = 3;
  const prev = await readJSON(env, SNAPSHOT_KEY, null);

  // Appointment separation and explicit course-label precedence correct the
  // model, not instructor requirements. Establish a new baseline without false
  // cancellations/additions; retain the change log and all coursework records.
  const found = prev?.normalization_version === next.normalization_version ? diffSnapshots(prev, next) : [];
  const log = await readJSON(env, CHANGE_LOG_KEY, []);
  const merged = reconcileChangeLog(found.length ? mergeChangeLog(log, found, nowISO) : log, next, nowISO);
  const logChanged = JSON.stringify(log) !== JSON.stringify(merged);

  // Only rewrite the snapshot when the deadlines themselves moved. Writing on every
  // /status is what pushed KV past its 1,000 writes/day free cap: the dashboard polls
  // on a timer, and the deadline set changes maybe twice a week.
  //
  // Compare `items` only, never the whole snapshot — `window` is derived from
  // Date.now(), so a byte comparison of the full object is different on every single
  // request and would never skip a write. Leaving `window` pinned to the last real
  // change is also the more honest value: diffSnapshots asks "should this have been
  // visible when we last looked?", and that is exactly when this snapshot was taken.
  const snapshotMoved =
    prev === null || prev.normalization_version !== next.normalization_version || JSON.stringify(prev.items) !== JSON.stringify(next.items)
      || JSON.stringify(prev.reviewed_containers || []) !== JSON.stringify(next.reviewed_containers);

  const writes = Promise.all([
    snapshotMoved
      ? kvPut(env, SNAPSHOT_KEY, JSON.stringify(next), 'deadlines-moved')
      : Promise.resolve(),
    logChanged
      ? kvPut(env, CHANGE_LOG_KEY, JSON.stringify(merged), 'change-log')
      : Promise.resolve(),
    // A background write must never take the request down with it.
  ]).catch((err) => {
    if (!(err instanceof KvWriteLimit)) throw err;
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(writes); else await writes;

  return merged;
}

function progressKey(code) {
  return `progress:${code}`;
}

/** Normalised form used to match a reported item against a calendar deadline. */
export function normItem(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function readProgressFor(env, code) {
  return readRecords(env,'progress',[code]);
}

/**
 * Progress is stored per course. A scoped call wants one course's list; an
 * unscoped call — the dashboard, which is inherently cross-course — wants all
 * of them merged, with each item tagged so the course survives the merge.
 * Returning [] for the unscoped case made every deadline look untouched.
 */
async function readProgress(env, course) {
  const codes = COURSES.map(c=>c.code).concat(GENERAL);
  return readRecords(env,'progress',[...new Set(course?[course.code,GENERAL]:codes)]);
}

function classNotesKey(code) {
  return `classnotes:${code}`;
}

/** Same per-course fan-out as readProgress, for the same reason. */
async function readClassNotes(env, course) {
  return readRecords(env,'classnote',course?[course.code]:COURSES.map(c=>c.code).concat(GENERAL));
}

async function readClassNotesFor(env, code) {
  return readRecords(env,'classnote',[code]);
}

function noteKey(courseCode) {
  return courseCode ? `note:${courseCode}` : 'note:GLOBAL';
}

/** A course-specific note wins; otherwise fall back to the global one. */
async function readNote(env, course) {
  if (!env.NOTES) return null;
  const keys = course ? [noteKey(course.code), noteKey(null)] : [noteKey(null)];
  for (const k of keys) {
    const raw = await env.NOTES.get(k);
    if (raw) {
      try {
        const record = JSON.parse(raw);
        // Older watcher notes included raw gradebook rows. Protect readers even
        // while KV propagates the corrected note across locations.
        if (typeof record.text === 'string') {
          record.text = record.text.replace(/GRADEBOOK:\s*[^;]*(?:;\s*)?/gi,
            'Gradebook changed; review the private grades dashboard; ');
        }
        return record;
      } catch { /* corrupt entry: fall through */ }
    }
  }
  return null;
}

/**
 * Record that something successfully called /status, so "is the bridge actually
 * working?" is answerable after the fact instead of needing a live log tail.
 * Written via waitUntil so it never adds latency to the GPT's request.
 */
function recordCall(env, ctx, course, request) {
  if (!env.NOTES) return;
  // The dashboard polls /status on a timer, so recording every poll rewrote this
  // key hundreds of times a day. The marker only answers "are the GPTs really
  // wired?", and the dashboard is not a GPT — its traffic is noise here.
  if (request.headers.get('X-Bridge-Client') === 'dashboard') return;
  const record = {
    at: new Date().toISOString(),
    at_local: new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(new Date()),
    course: course ? course.code : 'ALL',
    // ChatGPT identifies itself here; a browser or curl looks different.
    user_agent: (request.headers.get('User-Agent') || '').slice(0, 200),
  };
  const write = recordCallWrite(env, record);
  if (ctx && ctx.waitUntil) ctx.waitUntil(write); else return write;
  return undefined;
}

/**
 * Rewrite the marker at most once an hour per course.
 *
 * This key exists to answer one question — "are the GPTs actually wired up?" — and
 * a timestamp to the hour answers it just as well as one to the second. Writing on
 * every call put an unbounded write rate behind traffic we do not control: the GPT
 * instructions say to call getCourseStatus at the start of every conversation, so a
 * busy afternoon of studying was silently spending the same daily quota the class
 * notes and eLC alerts need. Reads are effectively free by comparison, so paying one
 * read to skip a write is a good trade at any traffic level.
 */
async function recordCallWrite(env, record) {
  const key = `lastcall:${record.course}`;
  try {
    const prev = await env.NOTES.get(key);
    if (prev) {
      const at = Date.parse(JSON.parse(prev).at);
      if (Number.isFinite(at) && Date.now() - at < LASTCALL_MIN_INTERVAL_MS) return;
    }
  } catch {
    // An unreadable marker is not a reason to skip recording this call.
  }
  try {
    await kvPut(env, key, JSON.stringify(record), 'lastcall', {
      expirationTtl: 60 * 60 * 24 * 60,
    });
  } catch (err) {
    if (!(err instanceof KvWriteLimit)) throw err;
  }
}

async function handleRequest(request, env, ctx) {
    // The friendly hostname delegates to the canonical bridge. Sharing KV alone
    // does not share calendar/API secrets, and previously produced an empty view.
    // Forward the original request so authentication, cookies and bodies survive.
    if (env.PRIMARY_BRIDGE) return env.PRIMARY_BRIDGE.fetch(request);
    const url = new URL(request.url);
    const agents=agentsResponse(request,url.pathname);if(agents)return agents;
    const publicInfo = publicInfoResponse(request, url.pathname);
    if (publicInfo) return publicInfo;
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if(path==='/pass/projects/openapi'&&request.method==='GET')return json(PROJECT_OPENAPI);
    if(path==='/mcp/projects'||path.startsWith('/pass/projects/client/tools/'))return projectClientRoute(request,env);
    if(path==='/mcp')return passMcpRoute(request,env,libraryPath=>handleRequest(new Request(url.origin+libraryPath,
      {headers:{Authorization:'Bearer '+env.API_KEY}}),env,ctx));

    // Importers cannot send a bearer header. The static contract contains no
    // credentials or stored records, so it has its own credential-free URL.
    // Never validate a key in a URL: history and access logs can retain it.
    if (path === '/openapi.json') {
      const headers = { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff' };
      if (!['GET','HEAD'].includes(request.method)) return new Response(null,
        {status:405,headers:{...headers,Allow:'GET, HEAD'}});
      return new Response(request.method === 'HEAD' ? null : JSON.stringify(openapi, null, 2), {headers});
    }
    if (/^\/openapi\/[^/]+\.json$/.test(path)) {
      return new Response(request.method === 'HEAD' ? null : JSON.stringify({error:'credential_url_retired',schema_url:'/openapi.json'}),
        {status:410,headers:{'content-type':'application/json; charset=utf-8',
          'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'}});
    }

    const entry = await authRoutes(request,env,path);
    if (entry) return entry;
    const auth = await authenticate(request,env);
    if (!auth) {
      if (request.method==='GET' && ['/app','/app/profile','/app/settings','/app/system','/app/clubs'].includes(path)) {
        if (await safeEqual(cookieValue(request,'bridge_k'),env.API_KEY)) return issueSession(env,path);
        return signInResponse(path);
      }
      return json({error:'unauthorized'},401);
    }
    if (!['GET','HEAD','OPTIONS'].includes(request.method) && auth!=='bearer' && request.headers.get('Origin')!==url.origin) return json({error:'origin_required'},403);
    if(path==='/mcp/learner')return learnerMcp(request,env,auth);
    const learnerResponse=await learnerRoutes(request,env,path,auth);
    if(learnerResponse)return learnerResponse;
    const connectionResponse=await passConnectionRoutes(request,env,path);
    if(connectionResponse)return connectionResponse;
    if(path.startsWith('/pass/tools/')) {
      if(request.method!=='POST')return json({error:'method_not_allowed'},405);
      const name=path.slice('/pass/tools/'.length);if(!PASS_TOOLS.some(t=>t.name===name))return json({error:'unknown_pass_tool'},404);
      if(!(request.headers.get('Content-Type')||'').toLowerCase().startsWith('application/json'))return json({error:'json_required'},415);
      let args;try{args=await readBody(request,24000);}catch{return json({error:'invalid_pass_request'},400);}
      const out=await executePassTool(name,args,env,url.origin);return json(out,out.error?(out.status||400):200);
    }
    const projectConnection=await projectConnectionRoutes(request,env,path,auth);
    if(projectConnection)return projectConnection;
    const projectResponse=await projectPassRoutes(request,env,path,auth);
    if(projectResponse)return projectResponse;
    const learningResponse=await learningRoutes(request,env,path,auth);
    if(learningResponse)return learningResponse;
    const recordResponse=await recordRoutes(request,env,path,auth);
    if(recordResponse)return recordResponse;
    const announcementResponse=await announcementRoutes(request,env,path,auth);
    if(announcementResponse)return announcementResponse;

    const clubResponse=await clubsRoutes(request,env,path,auth);
    if(clubResponse)return clubResponse;
    if (['/app/system','/app/clubs'].includes(path) && request.method === 'GET') {
      return new Response(path==='/app/clubs'?clubsHtml():systemHtml(), { headers: {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'same-origin',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      } });
    }
    const retryResponse=await retryRoutes(request,env,path,auth,ctx,kvPut);
    if(retryResponse)return retryResponse;
    if (path === '/system/health' && request.method === 'GET') return json(await systemHealth(env));
    if (path === '/system/health/report' && request.method === 'POST') {
      // Bound the stream before parsing; a claimed Content-Length is not enough.
      const reader = request.body?.getReader();
      const chunks = []; let size = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 12000) {
            await reader.cancel();
            return json({ error: 'report_too_large' }, 413);
          }
          chunks.push(value);
        }
      }
      const raw = await new Blob(chunks).text();
      let body;
      try { body = JSON.parse(raw); } catch { return json({ error: 'invalid_json' }, 400); }
      try {
        const report = await storeLocalHealth(env, body, kvPut);
        return json({ ok: true, received_at: report.received_at });
      } catch (err) {
        if (err instanceof KvWriteLimit) return kvLimitResponse();
        if (['invalid_report', 'invalid_service', 'invalid_result', 'future_observation', 'older_observation'].includes(err.message)) return json({ error: err.message }, 400);
        return json({ error: 'health_report_unavailable' }, 503);
      }
    }
    if (path === '/system/health/probe' && request.method === 'POST') {
      const at = new Date().toISOString();
      try {
        await kvPut(env, PROBE_KEY, JSON.stringify({ outcome: 'healthy', last_attempt_at: at,
          last_success_at: at, detail: 'The Mac diagnostic write was acknowledged by KV.' }), 'system-health-write-probe');
        return json({ ok: true, at });
      } catch (err) {
        if (err instanceof KvWriteLimit) return kvLimitResponse();
        return json({ error: 'diagnostic_write_failed' }, 503);
      }
    }

    // Once /app/<KEY> has planted the cookie, the bare /app is enough. This is
    // the URL to bookmark — it keeps the key out of history and the address bar.
    if (['/app','/app/profile','/app/settings'].includes(path) && request.method === 'GET') {
      return new Response(path==='/app'?appHtml(TERM.name):profileHtml(), {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex, nofollow',
          'referrer-policy': 'same-origin',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        },
      });
    }

    if (path === '/health') {
      const feeds = feedsFrom(env);
      const now = new Date();
      const { health } = await loadEvents(feeds, {
        env, now,
        windowStart: new Date(now.getTime() - 86400000),
        windowEnd: new Date(now.getTime() + 86400000),
      });
      return json({ ok: health.length > 0 && health.every((h) => h.ok && h.coverage_complete !== false), configured_feeds: feeds.length, feeds: health });
    }

    if(path==='/next-actions'){
      if(request.method!=='GET')return json({error:'method_not_allowed'},405);
      if([...url.searchParams.keys()].some(k=>k!=='course'||url.searchParams.getAll(k).length!==1))return json({error:'invalid_next_actions_query'},400);
      const requested=url.searchParams.get('course'),course=requested?resolveCourse(requested):null;
      if(requested&&!course)return json({error:'unknown_course',valid:COURSES.map(c=>c.code)},400);
      try{
        const now=new Date(),{windowStart,windowEnd}=agendaWindow(now,LOOKBACK_DAYS,LOOKAHEAD_DAYS);
        const {events,health}=await loadEvents(feedsFrom(env),{windowStart,windowEnd,env,now});
        const allProgress=await readProgress(env,null),progress=course?allProgress.filter(p=>p.course===course.code||p.course===GENERAL):allProgress;
        const status=buildStatus({events,now,course,progress,allProgress,health});
        try{const report=await systemHealth(env,now);status.source_health=report.nodes.map(n=>({id:n.id,status:n.status,last_success_at:n.last_success_at,last_attempt_at:n.last_attempt_at}));}
        catch{status.source_health=[];}
        // Unlike /status, this read does not record a call or update change snapshots.
        return json(await addLearnerReviews(buildNextActions(status,{now}),env,course?.code||null));
      }catch{return json({error:'next_actions_unavailable',detail:'Priorities could not be read; no records were changed.'},503);}
    }

    if (path === '/status' && request.method === 'GET') {
      const requested = url.searchParams.get('course');
      const course = requested ? resolveCourse(requested) : null;
      if (requested && !course) {
        return json({ error: 'unknown_course', valid: COURSES.map((c) => c.code) }, 400);
      }

      const now = new Date();
      const dashboard = url.searchParams.get('view') === 'dashboard';
      const {windowStart,windowEnd} = agendaWindow(now,LOOKBACK_DAYS,LOOKAHEAD_DAYS);
      const { events, health } = await loadEvents(feedsFrom(env), { windowStart, windowEnd, env, now });

      const note = await readNote(env, course);
      const classNotes = await readClassNotes(env, course);
      // Read every bucket even on a scoped call. `other_courses_this_week` is part
      // of a scoped payload, and annotating it needs the other courses' reports —
      // without them a scoped view reminds him about work he already reported done.
      // What gets echoed back stays scoped, so the payload does not grow.
      const allProgress = await readProgress(env, null);
      const progress = course
        ? allProgress.filter((p) => p.course === course.code || p.course === GENERAL)
        : allProgress;

      // Only diff when the feeds actually loaded. A broken feed looks like every
      // deadline was deleted, and logging that would be worse than saying nothing.
      const feedsOk = health.length > 0 && health.every((h) => h.ok && h.coverage_complete !== false && h.announcement_change_safe !== false);
      const changeLog = feedsOk
        ? await detectChanges(env, ctx, events, windowStart, windowEnd, now.toISOString())
        : await readJSON(env, CHANGE_LOG_KEY, []);
      const changes = course ? changeLog.filter((c) => c.course === course.code) : changeLog;

      await recordCall(env, ctx, course, request);
      // The slash-command directory and the call policy travel with the payload
      // rather than living in each GPT's Instructions, which are effectively full.
      // See src/commands.js.
      const status = buildStatus({ events, now, course, note, classNotes, progress, allProgress, changes, health });
      // The calendar includes personal commitments. Keep this opt-in dashboard
      // projection out of the default class-GPT/MCP payload and reuse the same
      // live feed read rather than maintaining a second calendar or deadline copy.
      let agenda = {};
      if (dashboard) {
        status.calendar_expected_sources = ['eLC (D2L)', 'Google Calendar'];
        try {
          const report = await systemHealth(env, now);
          const selected = new Set(['instructor-announcements','elc-daily-sweep','globus-watch','cluely-gpt-sync','drive-api','drive-sync-check','clubs']);
          status.source_health = report.nodes.filter(n=>selected.has(n.id)).map(n=>({
            id:n.id,label:n.label,status:n.status,last_attempt_at:n.last_attempt_at,
            last_success_at:n.last_success_at,scope:n.scope,
          }));
        } catch {
          status.source_health = [{id:'collection',label:'Material collection',status:'unknown',
            last_attempt_at:null,last_success_at:null,scope:'Collection health could not be read.'}];
        }
        status.next_actions=await addLearnerReviews(buildNextActions(status,{now}),env,course?.code||null);
        agenda = buildAgenda({events,status,now,windowStart,windowEnd});
      }
      return json({
        ...status, ...agenda,
        ...agentGuide(),
      });
    }

    // Who called /status, and when. Used to confirm the GPTs are really wired.
    if (path === '/lastcall' && request.method === 'GET') {
      if (!env.NOTES) return json({ error: 'kv_not_bound' }, 500);
      const calls = {};
      for (const c of [...COURSES.map((x) => x.code), 'ALL']) {
        const raw = await env.NOTES.get(`lastcall:${c}`);
        if (raw) {
          try { calls[c] = JSON.parse(raw); } catch { /* ignore corrupt entry */ }
        }
      }
      return json({ calls, seen: Object.keys(calls).length });
    }

    if (path === '/note' && request.method === 'GET') {
      const course = resolveCourse(url.searchParams.get('course'));
      return json({ note: await readNote(env, course) });
    }

    if (path === '/note' && request.method === 'POST') {
      if (!env.NOTES) return json({ error: 'kv_not_bound' }, 500);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }

      const text = (body.text || '').toString().trim();
      if (!text) return json({ error: 'missing_text' }, 400);
      if (text.length > 1500) return json({ error: 'text_too_long', max: 1500 }, 400);
      if (/GRADEBOOK:/i.test(text)) return json({ error: 'grade_content_not_allowed' }, 400);

      const course = body.course ? resolveCourse(body.course) : null;
      if (body.course && !course) {
        return json({ error: 'unknown_course', valid: COURSES.map((c) => c.code) }, 400);
      }

      const now = new Date();
      const record = {
        text,
        at: now.toISOString(),
        at_local: new Intl.DateTimeFormat('en-US', {
          timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        }).format(now),
        course: course ? course.code : null,
      };

      try {
        await kvPut(env, noteKey(course ? course.code : null), JSON.stringify(record),
                    'note', { expirationTtl: NOTE_TTL_SECONDS });
      } catch (err) {
        if (err instanceof KvWriteLimit) return kvLimitResponse();
        throw err;
      }
      return json({ ok: true, stored: record });
    }

    if (path === '/classnote' && request.method === 'GET') {
      const course = progressBucket(url.searchParams.get('course'));
      if (!course) return json({ error: 'unknown_course', valid: COURSES.map((c) => c.code) }, 400);
      return json({ course: course.code, notes: await readClassNotes(env, course) });
    }

    if (path === '/progress' && request.method === 'GET') {
      const course = progressBucket(url.searchParams.get('course'));
      if (!course) return json({ error: 'unknown_course', valid: COURSES.map((c) => c.code) }, 400);
      return json({ course: course.code, progress: await readProgressFor(env, course.code) });
    }

    if (path === '/changes' && request.method === 'GET') {
      const requested = url.searchParams.get('course');
      const course = requested ? resolveCourse(requested) : null;
      if (requested && !course) return json({ error: 'unknown_course', valid: COURSES.map((c) => c.code) }, 400);
      const log = await readJSON(env, CHANGE_LOG_KEY, []);
      return json({ course: course ? course.code : 'ALL', changes: course ? log.filter((c) => c.course === course.code) : log });
    }

    // The dashboard's assistant. Grounds every answer in the same live payload
    // the page renders, so it can't answer from a stale idea of the semester.
    // Needs ANTHROPIC_API_KEY as a Worker secret; without it the route says so
    // plainly rather than failing in a way the UI has to guess at.
    if (path === '/ask' && request.method === 'POST') {
      if (!env.ANTHROPIC_API_KEY) return json({ error: 'assistant_not_configured' }, 501);

      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
      const question = typeof body?.question === 'string' ? body.question.trim() : '';
      if (!question) return json({ error: 'question_required' }, 400);
      if (question.length > 2000) return json({ error: 'question_too_long' }, 400);

      // Build exactly the payload /status would return, so the assistant and
      // the page it sits on can never disagree about what is due.
      const now = new Date();
      const {windowStart,windowEnd} = agendaWindow(now,LOOKBACK_DAYS,LOOKAHEAD_DAYS);
      const { events, health } = await loadEvents(feedsFrom(env), { windowStart, windowEnd, env, now });

      const askProgress = await readProgress(env, null);
      const status = buildStatus({
        events,
        now,
        course: null,
        note: await readNote(env, null),
        classNotes: await readClassNotes(env, null),
        progress: askProgress,
        allProgress: askProgress,
        changes: await readJSON(env, CHANGE_LOG_KEY, []),
        health,
      });

      const answer = await askClaude(env, question, status);
      if (answer.ok) return json({ answer: answer.text });
      return json({ error: answer.error, status: answer.status, detail: answer.detail }, 502);
    }

    // The command directory on its own, for a GPT that wants it without the whole
    // status payload — and so `/help` is answerable even if /status is failing.
    if (path === '/commands' && request.method === 'GET') {
      return json({ commands: COMMANDS, call_policy: CALL_POLICY, command_help: COMMAND_HELP });
    }

    // ---- The library: the original documents, in Drive --------------------
    // Secondary on purpose. A GPT answers from its Knowledge bundles, which are
    // instant and cost nothing; it comes here when the bundle looks wrong, stale,
    // or silent on something — then cites the original and hands over the link.

    if (path === '/library' && request.method === 'GET') {
      if (!driveConfigured(env)) return driveNotConfigured();
      const requested = url.searchParams.get('course');
      const course = requested ? resolveCourse(requested) : null;
      if (requested && !course) {
        return json({ error: 'unknown_course', valid: COURSES.map((c) => c.code) }, 400);
      }
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 25));
      try {
        const files = await driveSearch(env, {
          courseFolder: course ? course.label : null,
          query: url.searchParams.get('q') || '',
          limit,
        });
        return json({
          course: course ? course.code : 'ALL',
          query: url.searchParams.get('q') || null,
          count: files.length,
          documents: files,
          note: 'Originals as filed in Drive. Use getDocument with a doc_id for the text.',
        });
      } catch (err) {
        return driveError(err);
      }
    }

    if (path === '/library/doc' && request.method === 'GET') {
      if (!driveConfigured(env)) return driveNotConfigured();
      const id = (url.searchParams.get('id') || '').trim();
      if (!id) return json({ error: 'missing_id', detail: 'Pass the doc_id from /library.' }, 400);
      const maxChars = Math.min(120000, Math.max(1000, Number(url.searchParams.get('max_chars')) || 60000));
      const expectedHash = url.searchParams.get('text_sha256');
      const offset = Number(url.searchParams.get('offset') || 0);
      if ((expectedHash !== null && !/^[a-f0-9]{64}$/.test(expectedHash)) || !Number.isSafeInteger(offset) || offset < 0 || (!expectedHash && offset !== 0)) return json({error:'invalid_text_selector'},400);
      try {
        const { file, shaped } = await driveFileMeta(env, id);
        // An explicit content hash selects a retained exact extraction, even for
        // directly readable CSV files shared by more than one source topic.
        if (expectedHash) {
          const course = materialCourse(shaped.folder?.split('/')[0]);
          const stored = await readDocText(env, course, file.name, expectedHash);
          if (!stored) return json({error:'not_found'},404);
          if (offset > stored.text.length) return json({error:'invalid_text_offset'},400);
          if (offset && /[\uDC00-\uDFFF]/.test(stored.text[offset] || '') && /[\uD800-\uDBFF]/.test(stored.text[offset-1])) return json({error:'invalid_text_offset'},400);
          let end = Math.min(stored.text.length, offset + maxChars);
          if (end < stored.text.length && /[\uD800-\uDBFF]/.test(stored.text[end-1])) end -= 1;
          return json({document:shaped, source:'sweep_extraction', text:stored.text.slice(offset,end),
            text_sha256:expectedHash, extracted_at:stored.at || null, pages:stored.pages || null,
            offset, next_offset:end < stored.text.length ? end : null,
            total_chars:stored.text.length, truncated:end < stored.text.length});
        }
        let body = await driveFileText(env, file, maxChars);

        // Drive has no PDF text extractor and neither does a Worker. The daily
        // sweep already extracts every PDF it downloads, so that text is pushed
        // here and stands in — flagged as such, because it is a derived copy and
        // an answer that leans on it should be able to say so.
        if (body.text === null && env.NOTES) {
          const sourceCourse = materialCourse(shaped.folder?.split('/')[0]);
          const stored = await readDocText(env, sourceCourse, file.name);
          if (stored && stored.text) {
            body = {
              text: stored.text.slice(0, maxChars),
              truncated: stored.text.length > maxChars,
              source: 'sweep_extraction',
              extracted_at: stored.at || null,
              pages: stored.pages || null,
              text_sha256: await digest(stored.text),
            };
          }
        }
        return json({ document: shaped, ...body });
      } catch (err) {
        return driveError(err);
      }
    }

    // Collector-only receipt lookup confirms durable text without echoing it.
    if (path === '/library/text' && request.method === 'GET') {
      if(auth !== 'bearer') return json({error:'bearer_required'},403);
      const course=materialCourse(url.searchParams.get('course')); 
      const filename=(url.searchParams.get('filename') || '').trim();
      if(!course || !filename || filename.length>240) return json({error:'invalid_document_identity'},400);
      const expectedHash=url.searchParams.get('text_sha256');
      if(expectedHash !== null && !/^[a-f0-9]{64}$/.test(expectedHash)) return json({error:'invalid_text_selector'},400);
      const record=await readDocText(env,course,filename,expectedHash);
      return record?.text ? json(await textReceipt(record)) : json({error:'not_found'},404);
    }
    if (path === '/library/text' && request.method === 'POST') {
      if(auth !== 'bearer') return json({error:'bearer_required'},403);
      if (!env.NOTES) return json({ error: 'kv_not_bound' }, 500);
      // Bound a UTF-8 body before parsing, including Unicode and escaped text.
      const reader=request.body?.getReader(); let size=0; const chunks=[];
      if(reader) while(true) {
        const {done,value}=await reader.read(); if(done) break;
        size+=value.length;
        if(size>DOC_TEXT_MAX_BODY_BYTES) {await reader.cancel();return json({error:'text_too_large'},413);}
        chunks.push(value);
      }
      let body;
      try { body = JSON.parse(await new Blob(chunks).text()); } catch { return json({ error: 'invalid_json' }, 400); }
      if(!body || typeof body!=='object' || Array.isArray(body)) return json({error:'invalid_json'},400);
      const course=materialCourse(body.course);
      const filename=typeof body.filename==='string'?body.filename.trim():'';
      const text=typeof body.text==='string'?body.text:'';
      if(!course) return json({error:'unknown_course'},400);
      if(!filename || filename.length>240 || /[\x00-\x1f\/\\]/.test(filename)) return json({error:'invalid_filename'},400);
      if(!text.trim()) return json({error:'missing_text'},400);
      // An incomplete extraction must stay pending rather than become success.
      if(text.length>DOC_TEXT_MAX_CHARS) return json({error:'text_too_large'},413);
      const record={filename,title:typeof body.title==='string'?body.title.slice(0,200):filename,
        course:course.code,pages:Number(body.pages)||null,text,truncated:false,at:new Date().toISOString()};
      const textHash=await digest(text);
      const exactKey=`doctext:v3:${course.code}:${await digest(filename)}:${textHash}`;
      const exact=await readJSON(env,exactKey,null);
      const prior=await readDocText(env,course,filename);
      const replay=exact?.text===text && exact.course===course.code;
      if(replay && prior?.text===text && prior.course===course.code) return json({...await textReceipt(exact),replayed:true});
      try {
        // Retain both same-name extractions. The compatibility pointer keeps its
        // existing last-published semantics; exact reads never republish a peer.
        if(!replay) await kvPut(env,exactKey,JSON.stringify(record),'library-text');
        if(prior?.text!==text || prior.course!==course.code)
          await kvPut(env,`doctext:v2:${course.code}:${await digest(filename)}`,JSON.stringify(record),'library-text');
      } catch (err) {
        if (err instanceof KvWriteLimit) return kvLimitResponse();
        throw err;
      }
      return json(await textReceipt(record));
    }

    return json({ error: 'not_found', routes: ['/status', '/note', '/classnote', '/progress', '/changes', '/health', '/lastcall', '/ask', '/commands', '/library', '/library/doc', '/app', '/openapi.json'] }, 404);
}

export default {
  async fetch(request,env,ctx) {
    try { return await handleRequest(request,env,ctx); }
    catch (err) {
      if(err instanceof URIError)return json({error:'unauthorized'},401);
      const initializing=err?.message==='records_initializing';
      return json({error:initializing?'records_initializing':'service_unavailable',
        detail:initializing?'Records are temporarily unavailable during a safe storage migration. This is not an empty coursework list.':'The current state could not be confirmed. Please retry; no empty success is being returned.'},503);
    }
  },

  /**
   * Scheduled feed check. See `[triggers]` in wrangler.toml for the times.
   *
   * Change detection used to be a side effect of someone calling /status, which
   * meant it ran hundreds of times a day when a browser tab was open and not at
   * all when none was. Neither is what we want: eLC changes a few times a week,
   * and a moved deadline should be noticed whether or not anyone is looking.
   *
   * Running it here makes the rate a property of the schedule rather than of how
   * many tabs happen to be open, so it cannot be multiplied by devices.
   */
  async scheduled(event, env, ctx) {
    if (env.PRIMARY_BRIDGE) return;
    if (event.cron === HEALTH_CRON) {
      await collectCloudHealth(env, kvPut);
      return;
    }
    const now = new Date();
    const {windowStart,windowEnd} = agendaWindow(now,LOOKBACK_DAYS,LOOKAHEAD_DAYS);

    const { events, health } = await loadEvents(feedsFrom(env), { windowStart, windowEnd, env, now });

    // Same guard the request path uses: a feed that failed to load looks exactly
    // like every deadline in it was deleted, and writing that to the change log
    // would be worse than skipping this run. The next one will pick it up.
    if (!health.length || !health.every((h) => h.ok && h.coverage_complete !== false && h.announcement_change_safe !== false)) return;

    // ctx is deliberately not forwarded: detectChanges would hand the writes to
    // waitUntil, and a scheduled run should finish its own work before returning.
    await detectChanges(env, null, events, windowStart, windowEnd, now.toISOString());
  },
};
