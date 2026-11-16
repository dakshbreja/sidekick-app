import { sqliteFoundation } from './sqlite-fixture.js';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/worker.js';
import { D2L_FEED, GOOGLE_FEED, shiftFeed, weeksSinceAnchor } from './fixtures.js';

const KEY = 'test-key-0123456789';

// These tests go through worker.fetch(), which reads the system clock and only
// loads events within LOOKBACK/LOOKAHEAD of it — so the fixtures have to be moved
// up to the present or the feeds arrive empty. Shift is recomputed on every run,
// in whole weeks, so this cannot rot again. See fixtures.js.
const SHIFT = weeksSinceAnchor();
const D2L_LIVE = shiftFeed(D2L_FEED, SHIFT);
const GOOGLE_LIVE = shiftFeed(GOOGLE_FEED, SHIFT);

/** In-memory stand-in for a Workers KV namespace. */
function makeKV() {
  const store = new Map();
  return {
    store,
    // Write count is the whole point of the idle-poll test below: KV's free tier
    // allows 1,000 writes a day but 100,000 reads, so writes are what run out.
    writes: 0,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { this.writes += 1; store.set(k, v); },
  };
}

async function sessionCookie() {
  const response=await worker.fetch(new Request('https://status.test/app/session',{method:'POST',headers:{Origin:'https://status.test','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({access_key:KEY,returnTo:'/app'})}),env);
  assert.equal(response.status,303);
  return response.headers.getSetCookie().find(v=>v.startsWith('__Host-bridge_session=')).split(';')[0];
}
let env, foundation;
afterEach(() => foundation?.close());

beforeEach(() => {
  foundation = sqliteFoundation();
  env = {
    API_KEY: KEY,
    BRIDGE_STATE: foundation.binding,
    FEED_ELC: 'https://d2l.test/feed.ics',
    FEED_PERSONAL: 'https://google.test/feed.ics',
    NOTES: makeKV(),
  };
  globalThis.fetch = async (url) => {
    const body = { 'https://d2l.test/feed.ics': D2L_LIVE, 'https://google.test/feed.ics': GOOGLE_LIVE }[url];
    if (!body) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
});

const req = (path, init = {}) =>
  new Request(`https://status.test${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, ...(init.headers || {}) },
  });

test('rejects a missing or wrong key', async () => {
  const anon = await worker.fetch(new Request('https://status.test/status'), env);
  assert.equal(anon.status, 401);

  const wrong = await worker.fetch(
    new Request('https://status.test/status', { headers: { Authorization: 'Bearer nope' } }), env);
  assert.equal(wrong.status, 401);
});

test('every route is gated, including /health', async () => {
  // The hostname is public, so the key is the only boundary. No exceptions.
  for (const path of ['/status', '/health', '/note']) {
    const res = await worker.fetch(new Request(`https://status.test${path}`), env);
    assert.equal(res.status, 401, `${path} must require the key`);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ['error'], `${path} must leak nothing beyond the error`);
  }
});

test('/health reports feed reachability once authenticated', async () => {
  const res = await worker.fetch(req('/health'), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.configured_feeds, 2);
});

test('/status returns a scoped live briefing', async () => {
  const res = await worker.fetch(req('/status?course=LAND2510'), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.course.code, 'LAND2510');
  assert.ok(body.briefing.length > 0);
  assert.ok(Array.isArray(body.due_this_week));
  assert.equal(res.headers.get('cache-control'), 'no-store', 'must never be cached — the whole point is freshness');
});

test('/status rejects an unknown course rather than silently returning everything', async () => {
  const res = await worker.fetch(req('/status?course=CHEM1211'), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'unknown_course');
});

test('a posted note comes back on the next status call', async () => {
  const post = await worker.fetch(req('/note', {
    method: 'POST',
    body: JSON.stringify({ course: 'BUSN5000', text: 'Set up RStudio; pre-Project exercise is next.' }),
  }), env);
  assert.equal(post.status, 200);

  const res = await worker.fetch(req('/status?course=BUSN5000'), env);
  const body = await res.json();
  assert.match(body.claude_note.text, /pre-Project/);
  assert.match(body.briefing, /Last note from Claude/);
});

test('raw watcher grade rows are rejected and old notes are redacted on read', async () => {
  const post = await worker.fetch(req('/note', {method:'POST',
    body:JSON.stringify({course:'MGMT5560',text:'GRADEBOOK: Company score || 98.76'})}),env);
  assert.equal(post.status,400);
  assert.equal((await post.json()).error,'grade_content_not_allowed');
  assert.equal(env.NOTES.store.has('note:MGMT5560'),false);
  env.NOTES.store.set('note:MGMT5560',JSON.stringify({text:'Update: GRADEBOOK: Company score || 98.76; NEW DATE: Year 9 tomorrow'}));
  const note = (await (await worker.fetch(req('/note?course=MGMT5560'),env)).json()).note;
  assert.doesNotMatch(note.text,/98\.76|GRADEBOOK:/);
  assert.match(note.text,/NEW DATE: Year 9 tomorrow/);
});

test('a global note reaches a course that has no note of its own', async () => {
  await worker.fetch(req('/note', { method: 'POST', body: JSON.stringify({ text: 'Weekly planning session done.' }) }), env);
  const body = await (await worker.fetch(req('/status?course=MGMT4280'), env)).json();
  assert.match(body.claude_note.text, /Weekly planning/);
});

test('a course-specific note wins over the global one', async () => {
  await worker.fetch(req('/note', { method: 'POST', body: JSON.stringify({ text: 'global' }) }), env);
  await worker.fetch(req('/note', { method: 'POST', body: JSON.stringify({ course: 'MGMT5560', text: 'specific' }) }), env);
  const body = await (await worker.fetch(req('/status?course=MGMT5560'), env)).json();
  assert.equal(body.claude_note.text, 'specific');
});

test('note validation', async () => {
  const empty = await worker.fetch(req('/note', { method: 'POST', body: JSON.stringify({ text: '  ' }) }), env);
  assert.equal((await empty.json()).error, 'missing_text');

  const long = await worker.fetch(req('/note', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(1501) }) }), env);
  assert.equal((await long.json()).error, 'text_too_long');

  const bad = await worker.fetch(req('/note', { method: 'POST', body: '{not json' }), env);
  assert.equal((await bad.json()).error, 'invalid_json');
});

test('a dead feed surfaces as a warning instead of an empty schedule', async () => {
  globalThis.fetch = async (url) =>
    url === 'https://google.test/feed.ics'
      ? { ok: true, status: 200, text: async () => GOOGLE_LIVE }
      : { ok: false, status: 500, text: async () => '' };

  const body = await (await worker.fetch(req('/status?course=LAND2510'), env)).json();
  assert.ok(body.data_warning, 'must warn when a feed is down');
  assert.equal(body.feed_health.find((h) => h.source === 'eLC (D2L)').ok, false);
});

test('unknown routes 404 with the route list', async () => {
  const res = await worker.fetch(req('/whatever'), env);
  assert.equal(res.status, 404);
  assert.deepEqual((await res.json()).routes, ['/status', '/note', '/classnote', '/progress', '/changes', '/health', '/lastcall', '/ask', '/commands', '/library', '/library/doc', '/app', '/openapi.json']);
});

test('/status records who called it, and /lastcall reads it back', async () => {
  const ctx = { waitUntil: (p) => p };
  await worker.fetch(
    new Request('https://status.test/status?course=LAND2510', {
      headers: { Authorization: `Bearer ${KEY}`, 'User-Agent': 'ChatGPT-User/1.0' },
    }), env, ctx);

  const body = await (await worker.fetch(req('/lastcall'), env, ctx)).json();
  assert.equal(body.seen, 1);
  assert.equal(body.calls.LAND2510.course, 'LAND2510');
  assert.match(body.calls.LAND2510.user_agent, /ChatGPT/, 'the caller must be identifiable');
});

test('the static OpenAPI document has a credential-free import URL', async () => {
  for (const config of [env, {}]) {
    const ok = await worker.fetch(new Request('https://status.test/openapi.json'), config);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.equal(ok.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(ok.headers.get('set-cookie'), null);
    const text = await ok.text();
    assert.ok(!text.includes(KEY));
    const doc = JSON.parse(text);
    assert.equal(doc.paths['/status'].get.operationId, 'getCourseStatus');
    assert.deepEqual(doc.security, [{bearerAuth:[]}]);
    assert.equal(doc.components.securitySchemes.bearerAuth.type, 'http');
    assert.equal(doc.components.securitySchemes.bearerAuth.scheme, 'bearer');
  }
  const head = await worker.fetch(new Request('https://status.test/openapi.json', {method:'HEAD'}), env);
  assert.equal(head.status, 200);assert.equal(await head.text(), '');
  for (const method of ['POST','PUT','PATCH','DELETE','OPTIONS']) {
    const bad = await worker.fetch(new Request('https://status.test/openapi.json', {method}), env);
    assert.equal(bad.status, 405);assert.equal(bad.headers.get('allow'), 'GET, HEAD');
  }
});

test('old schema URLs never validate or reflect a credential', async () => {
  const before = foundation.store.rows('SELECT * FROM sessions');
  for (const value of [KEY, 'wrong', '%zz', encodeURIComponent('slash/key')]) {
    for (const method of ['GET','HEAD','POST']) {
      const response = await worker.fetch(new Request('https://status.test/openapi/'+value+'.json', {method}), env);
      assert.equal(response.status, 410);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      if(method==='HEAD')assert.equal(await response.text(),'');
      else assert.deepEqual(await response.json(), {error:'credential_url_retired',schema_url:'/openapi.json'});
    }
  }
  assert.deepEqual(foundation.store.rows('SELECT * FROM sessions'), before);
  assert.equal((await worker.fetch(new Request('https://status.test/status?api_key='+KEY),env)).status,401);
});

// --- accumulated class notes -------------------------------------------------

const postClassNote = (body) =>
  worker.fetch(req('/classnote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env, null);

test('class notes accumulate rather than overwrite', async () => {
  await postClassNote({ course: 'MGMT4280', date: '2026-08-20', text: 'first lecture', session_id: 'a' });
  await postClassNote({ course: 'MGMT4280', date: '2026-08-25', text: 'second lecture', session_id: 'b' });

  const res = await worker.fetch(req('/classnote?course=MGMT4280'), env, null);
  const body = await res.json();
  assert.equal(body.notes.length, 2);
  assert.deepEqual(body.notes.map((n) => n.text), ['first lecture', 'second lecture']);
});

test('re-pushing the same session updates in place instead of duplicating', async () => {
  await postClassNote({ course: 'MGMT4280', date: '2026-08-20', text: 'draft', session_id: 'a' });
  await postClassNote({ course: 'MGMT4280', date: '2026-08-20', text: 'corrected', session_id: 'a' });

  const body = await (await worker.fetch(req('/classnote?course=MGMT4280'), env, null)).json();
  assert.equal(body.notes.length, 1);
  assert.equal(body.notes[0].text, 'corrected');
});

test('class notes are capped and drop the oldest first', async () => {
  for (let i = 1; i <= 20; i++) {
    await postClassNote({
      course: 'MGMT4280',
      date: `2026-09-${String(i).padStart(2, '0')}`,
      text: `lecture ${i}`,
      session_id: `s${i}`,
    });
  }
  const body = await (await worker.fetch(req('/classnote?course=MGMT4280'), env, null)).json();
  assert.equal(body.notes.length, 14);
  assert.equal(body.notes[0].text, 'lecture 7');
  assert.equal(body.notes[13].text, 'lecture 20');
});

test('class notes are scoped per course and surface in /status', async () => {
  await postClassNote({ course: 'MGMT4280', date: '2026-08-20', text: 'supply chain stuff', session_id: 'a' });

  const mine = await (await worker.fetch(req('/status?course=MGMT4280'), env, null)).json();
  assert.equal(mine.class_notes.length, 1);
  assert.match(mine.briefing, /Class notes on file: 1 session/);

  const other = await (await worker.fetch(req('/status?course=BUSN5000'), env, null)).json();
  assert.equal(other.class_notes.length, 0);
});

test('class note rejects an unknown course and empty text', async () => {
  assert.equal((await postClassNote({ course: 'NOPE999', text: 'x' })).status, 400);
  assert.equal((await postClassNote({ course: 'MGMT4280', text: '  ' })).status, 400);
});

// --- progress write-back -----------------------------------------------------

const postProgress = (body) =>
  worker.fetch(req('/progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env, null);

test('progress records an item and reads it back', async () => {
  const res = await postProgress({ course: 'LAND2510', item: 'Quiz 01 Origins', status: 'done' });
  assert.equal(res.status, 200);
  const body = await (await worker.fetch(req('/progress?course=LAND2510'), env, null)).json();
  assert.equal(body.progress.length, 1);
  assert.equal(body.progress[0].status, 'done');
});

test('re-reporting the same item updates it instead of duplicating', async () => {
  await postProgress({ course: 'LAND2510', item: 'Quiz 01', status: 'in_progress' });
  await postProgress({ course: 'LAND2510', item: 'quiz 01', status: 'done' });
  const body = await (await worker.fetch(req('/progress?course=LAND2510'), env, null)).json();
  assert.equal(body.progress.length, 1);
  assert.equal(body.progress[0].status, 'done');
});

test('progress defaults to done and rejects a bad status', async () => {
  assert.equal((await postProgress({ course: 'LAND2510', item: 'Reading 1' })).status, 200);
  const body = await (await worker.fetch(req('/progress?course=LAND2510'), env, null)).json();
  assert.equal(body.progress[0].status, 'done');
  assert.equal((await postProgress({ course: 'LAND2510', item: 'x', status: 'finished' })).status, 400);
  assert.equal((await postProgress({ course: 'LAND2510', item: '  ' })).status, 400);
});

test('progress is scoped per course', async () => {
  await postProgress({ course: 'LAND2510', item: 'Quiz 01', status: 'done' });
  const other = await (await worker.fetch(req('/progress?course=BUSN5000'), env, null)).json();
  assert.equal(other.progress.length, 0);
});

test('a done item marks the matching deadline completed in /status', async () => {
  const before = await (await worker.fetch(req('/status?course=LAND2510'), env, null)).json();
  const all = [...before.overdue, ...before.due_today, ...before.due_this_week];
  assert.ok(all.length > 0, 'fixture should provide at least one LAND deadline');
  const target = all[0].title;

  await postProgress({ course: 'LAND2510', item: target, status: 'done' });
  const after = await (await worker.fetch(req('/status?course=LAND2510'), env, null)).json();
  const hit = [...after.overdue, ...after.due_today, ...after.due_this_week]
    .find((d) => d.title === target);
  assert.equal(hit.completed, true);
  assert.equal(after.progress_summary.done, 1);
  assert.match(after.briefing, /reported 1 item done/);
});

// --- completion matching must not over-clear -----------------------------------

test('a vague report clears nothing and is surfaced as ambiguous', async () => {
  const before = await (await worker.fetch(req('/status?course=LAND2510'), env, null)).json();
  const quizzes = [...before.overdue, ...before.due_today, ...before.due_this_week, ...before.upcoming]
    .filter((d) => /quiz/i.test(d.title));
  assert.ok(quizzes.length > 1, 'fixture should have several LAND quizzes');

  const rejected=await postProgress({ course: 'LAND2510', item: 'quiz', status: 'done' });
  assert.equal(rejected.status,409);
  const problem=await rejected.json();
  assert.equal(problem.error,'ambiguous_assignment');
  assert.ok(problem.candidates.length>1);

  const after = await (await worker.fetch(req('/status?course=LAND2510'), env, null)).json();
  const cleared = [...after.overdue, ...after.due_today, ...after.due_this_week, ...after.upcoming]
    .filter((d) => d.completed);
  assert.equal(cleared.length, 0, 'a vague report must not clear anything');
  assert.equal(after.progress.length,0,'rejected write must not masquerade as saved');
});

test('a numbered report clears exactly the one deadline it names', async () => {
  const before = await (await worker.fetch(req('/status?course=LAND2510'), env, null)).json();
  const all = [...before.overdue, ...before.due_today, ...before.due_this_week, ...before.upcoming];
  const target = all.find((d) => /quiz\s*0?1\b/i.test(d.title));
  assert.ok(target, 'fixture should contain Quiz 01');

  // Deliberately loose wording: "quiz 1" vs the real title "Quiz 01 _Origins".
  await postProgress({ course: 'LAND2510', item: 'quiz 1', status: 'done' });

  const after = await (await worker.fetch(req('/status?course=LAND2510'), env, null)).json();
  const cleared = [...after.overdue, ...after.due_today, ...after.due_this_week, ...after.upcoming]
    .filter((d) => d.completed);
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].title, target.title);
  assert.equal(cleared[0].completion.confidence, 'inferred');
});

test('an exact title match is recorded as confirmed, not inferred', async () => {
  const before = await (await worker.fetch(req('/status?course=LAND2510'), env, null)).json();
  const all = [...before.overdue, ...before.due_today, ...before.due_this_week, ...before.upcoming];
  const target = all[0];

  await postProgress({ course: 'LAND2510', item: target.title, status: 'done' });

  const after = await (await worker.fetch(req('/status?course=LAND2510'), env, null)).json();
  const hit = [...after.overdue, ...after.due_today, ...after.due_this_week, ...after.upcoming]
    .find((d) => d.title === target.title);
  assert.equal(hit.completed, true);
  assert.equal(hit.completion.confidence, 'confirmed');
});

test('a completion filed under the wrong course clears nothing', async () => {
  const before = await (await worker.fetch(req('/status?course=LAND2510'), env, null)).json();
  const all = [...before.overdue, ...before.due_today, ...before.due_this_week, ...before.upcoming];
  const target = all.find((d) => /quiz/i.test(d.title));
  assert.ok(target, 'fixture should provide a LAND quiz');

  // Right title, wrong bucket. This used to clear the LAND deadline anyway,
  // because matching never looked at which course the report was filed under.
  await postProgress({ course: 'BUSN5000', item: target.title, status: 'done' });

  const after = await (await worker.fetch(req('/status?course=LAND2510'), env, null)).json();
  const hit = [...after.overdue, ...after.due_today, ...after.due_this_week, ...after.upcoming]
    .find((d) => d.title === target.title);
  assert.equal(hit.completed, undefined, 'a BUSN report must not clear a LAND deadline');
  assert.equal(hit.outstanding, true);
  // Visible where it was filed, and not as noise in the course it failed to reach.
  const busn = await (await worker.fetch(req('/status?course=BUSN5000'), env, null)).json();
  assert.ok(busn.completion_unmatched.some((u) => u.course === 'BUSN5000'),
    'the misfiled report must be visible, not silently dropped');
  assert.equal(after.completion_unmatched.some((u) => u.course === 'BUSN5000'), false,
    'a LAND conversation must not be asked about a BUSN report');
});

test('a scoped call sees other courses\' completions, so it stops re-reminding', async () => {
  // A scoped /status renders other_courses_this_week. Annotating it needs every
  // course's reports, not just this course's — otherwise the scoped view nags
  // about work already reported done elsewhere.
  const before = await (await worker.fetch(req('/status?course=BUSN5000'), env, null)).json();
  const other = before.other_courses_this_week[0];
  assert.ok(other, 'fixture should put at least one other-course item in this week');
  assert.equal(other.outstanding, true);

  await postProgress({ course: other.course_code || 'GENERAL', item: other.title, status: 'done' });

  const after = await (await worker.fetch(req('/status?course=BUSN5000'), env, null)).json();
  const same = after.other_courses_this_week.find((d) => d.title === other.title);
  assert.equal(same.completed, true, 'the scoped payload must reflect the other course\'s report');
  assert.equal(after.actionable.outstanding.some((d) => d.title === other.title), false);

  // The echoed progress list stays scoped — the payload does not grow to carry
  // every course's reports just because matching needed them. And the briefing
  // counts what this payload shows, not what matching happened to see.
  if (other.course_code && other.course_code !== 'BUSN5000') {
    assert.equal(after.progress.some((pr) => pr.course === other.course_code), false);
    assert.doesNotMatch(after.briefing, /reported \d+ items? done/,
      'a report in another course must not be counted in this course\'s briefing');
  }
});

test('/progress records submission provenance and refuses unevidenced "verified"', async () => {
  const bad = await postProgress({ course: 'LAND2510', item: 'Quiz 01', status: 'done', verification: 'verified' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'verification_requires_evidence');

  assert.equal((await postProgress({ course: 'LAND2510', item: 'Quiz 01', verification: 'sort-of' })).status, 400);
  assert.equal((await postProgress({ course: 'LAND2510', item: 'Quiz 01', submitted_by: 'the dog' })).status, 400);

  const ok = await postProgress({
    course: 'LAND2510', item: 'Quiz 01', status: 'done',
    verification: 'verified', evidence: 'eLC receipt 8831', submitted_by: 'group', reported_by: 'codex',
  });
  assert.equal(ok.status, 200);
  const rec = (await ok.json()).recorded;
  assert.equal(rec.verification, 'verified');
  assert.equal(rec.evidence, 'eLC receipt 8831');
  assert.equal(rec.submitted_by, 'group');
  assert.equal(rec.reported_by, 'codex');

  // A plain report defaults to reported, never to verified.
  await postProgress({ course: 'LAND2510', item: 'Quiz 02', status: 'done' });
  const back = await (await worker.fetch(req('/progress?course=LAND2510'), env, null)).json();
  assert.equal(back.progress.find((x) => x.item === 'Quiz 02').verification, 'reported');
});

test('a legacy re-report does not erase evidence already on file', async () => {
  await postProgress({
    course: 'LAND2510', item: 'Quiz 01', status: 'done',
    verification: 'verified', evidence: 'eLC receipt 8831', submitted_by: 'self', reported_by: 'daksh',
  });

  // Exactly what an un-updated client sends: same item, same status, no metadata.
  // Defaulting those fields before reading the stored row wiped the receipt.
  const again = await postProgress({ course: 'LAND2510', item: 'Quiz 01', status: 'done' });
  assert.equal(again.status, 200);
  const kept = (await again.json()).recorded;
  assert.equal(kept.verification, 'verified', 'a stored receipt survives a bare re-report');
  assert.equal(kept.evidence, 'eLC receipt 8831');
  assert.equal(kept.submitted_by, 'self');
  assert.equal(kept.reported_by, 'daksh');

  // A note-only update keeps it too.
  await postProgress({ course: 'LAND2510', item: 'Quiz 01', status: 'done', note: 'graded 19/20' });
  const read = await (await worker.fetch(req('/progress?course=LAND2510'), env, null)).json();
  const row = read.progress.find((x) => x.key === 'quiz 01');
  assert.equal(row.verification, 'verified');
  assert.equal(row.note, 'graded 19/20');

  // An explicit correction still wins.
  await postProgress({ course: 'LAND2510', item: 'Quiz 01', status: 'done', verification: 'reported' });
  const corrected = await (await worker.fetch(req('/progress?course=LAND2510'), env, null)).json();
  assert.equal(corrected.progress.find((x) => x.key === 'quiz 01').verification, 'reported');
});

test('changing the work status resets evidence rather than carrying it over', async () => {
  await postProgress({
    course: 'LAND2510', item: 'Quiz 01', status: 'done',
    verification: 'verified', evidence: 'eLC receipt 8831',
  });
  // Evidence that it was submitted is not evidence about work now back in progress.
  await postProgress({ course: 'LAND2510', item: 'Quiz 01', status: 'in_progress' });
  const read = await (await worker.fetch(req('/progress?course=LAND2510'), env, null)).json();
  const row = read.progress.find((x) => x.key === 'quiz 01');
  assert.equal(row.verification, 'unknown');
  assert.equal(row.evidence, null);
});

test('the shared actionable view travels in the payload the GPTs read', async () => {
  const body = await (await worker.fetch(req('/status?course=LAND2510'), env, null)).json();
  const a = body.actionable;
  assert.ok(a, 'every client reads the same actionable view');
  assert.equal(a.scope, 'LAND2510');
  assert.equal(a.counts.outstanding, a.outstanding.length);
  assert.equal(a.coverage.feeds_total, body.feed_health.length);
  assert.equal(a.coverage.submission_sources_checked, false);
});

// --- change detection through the Worker ---------------------------------------

/** Re-stub fetch with a D2L feed whose Quiz 01 due date has been pushed back. */
function feedWithMovedQuiz() {
  // Move both provider timestamps; a DTEND before its edited DTSTART is invalid.
  // Applied to the unshifted feed so the literal dates still match, then shifted
  // with everything else.
  return shiftFeed(D2L_FEED.replace(
    /(UID:d2l-land-q1-due[\s\S]*?)DTSTART:20260823T035959Z([\s\S]*?)DTEND:20260823T035959Z/,
    '$1DTSTART:20260828T035959Z$2DTEND:20260828T035959Z'
  ), SHIFT);
}

function stubFeeds(d2l) {
  globalThis.fetch = async (url) => {
    const body = { 'https://d2l.test/feed.ics': d2l, 'https://google.test/feed.ics': GOOGLE_LIVE }[url];
    if (!body) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
}

test('the first call sets a baseline and reports no changes', async () => {
  const body = await (await worker.fetch(req('/status?course=LAND2510'), env, null)).json();
  assert.deepEqual(body.recent_changes, []);
  assert.ok(env.NOTES.store.has('snapshot:deadlines'), 'baseline snapshot should be stored');
});

test('a deadline that moves between calls is detected and surfaced', async () => {
  await worker.fetch(req('/status?course=LAND2510'), env, null);   // baseline

  const before = D2L_LIVE;
  const after = feedWithMovedQuiz();
  assert.notEqual(before, after, 'fixture rewrite should actually change the feed');
  stubFeeds(after);

  const body = await (await worker.fetch(req('/status?course=LAND2510'), env, null)).json();
  const moved = body.recent_changes.filter((c) => c.type === 'moved');
  assert.equal(moved.length, 1);
  assert.match(moved[0].title, /Quiz 01/);
  assert.match(body.briefing, /CHANGED since the last check/);
  assert.match(body.briefing, /moved from/);
});

test('a broken feed does not log every deadline as deleted', async () => {
  await worker.fetch(req('/status?course=LAND2510'), env, null);   // baseline

  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => '' });
  const body = await (await worker.fetch(req('/status?course=LAND2510'), env, null)).json();

  assert.ok(body.data_warning, 'a dead feed should still warn');
  assert.equal(body.recent_changes.filter((c) => c.type === 'removed').length, 0,
    'an outage must never be recorded as the professor deleting everything');
});

test('/changes reads the log back and scopes it by course', async () => {
  await worker.fetch(req('/status'), env, null);
  stubFeeds(feedWithMovedQuiz());
  await worker.fetch(req('/status'), env, null);

  const all = await (await worker.fetch(req('/changes'), env, null)).json();
  assert.ok(all.changes.length > 0);

  const land = await (await worker.fetch(req('/changes?course=LAND2510'), env, null)).json();
  assert.ok(land.changes.every((c) => c.course === 'LAND2510'));

  const busn = await (await worker.fetch(req('/changes?course=BUSN5000'), env, null)).json();
  assert.equal(busn.changes.filter((c) => /Quiz 01/.test(c.title)).length, 0);
});


// --- dashboard + assistant -------------------------------------------------

test('POST sign-in opens the dashboard with an opaque session cookie', async () => {
  const cookie=await sessionCookie();
  assert.ok(!cookie.includes(KEY));
  const res=await worker.fetch(new Request('https://status.test/app',{headers:{Cookie:cookie}}),env);
  assert.equal(res.status,200);
  const html=await res.text();assert.match(html,/Sidekick/);assert.ok(!html.includes(KEY));
});

test('/app with a wrong key is indistinguishable from any other bad request', async () => {
  const res = await worker.fetch(new Request('https://status.test/app/not-the-key'), env);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(res.headers.get('location'), '/app/sign-in?returnTo=%2Fapp&reason=legacy_url');
});

test('the cookie authenticates /status, so the page needs no key in JS', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => GOOGLE_LIVE });
  const res = await worker.fetch(
    new Request('https://status.test/status', { headers: { Cookie: await sessionCookie() } }),
    env,
  );
  assert.equal(res.status, 200);
});

test('a forged cookie does not authenticate', async () => {
  const res = await worker.fetch(
    new Request('https://status.test/status', { headers: { Cookie: 'bridge_k=guess' } }),
    env,
  );
  assert.equal(res.status, 401);
});

test('/ask says so plainly when no Anthropic key is configured', async () => {
  const res = await worker.fetch(
    new Request('https://status.test/ask', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'what is due?' }),
    }),
    env,
  );
  assert.equal(res.status, 501);
  assert.equal((await res.json()).error, 'assistant_not_configured');
});

test('/ask rejects an empty question before spending a token', async () => {
  const res = await worker.fetch(
    new Request('https://status.test/ask', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ question: '   ' }),
    }),
    { ...env, ANTHROPIC_API_KEY: 'sk-test' },
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'question_required');
});

test('/ask grounds the model in the live payload and returns its text', async () => {
  let sent = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.anthropic.com')) {
      sent = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Quiz 01 is overdue.' }] }),
      };
    }
    return { ok: true, status: 200, text: async () => GOOGLE_LIVE };
  };

  const res = await worker.fetch(
    new Request('https://status.test/ask', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'anything overdue?' }),
    }),
    { ...env, ANTHROPIC_API_KEY: 'sk-test' },
  );

  assert.equal(res.status, 200);
  assert.equal((await res.json()).answer, 'Quiz 01 is overdue.');

  assert.equal(sent.model, 'claude-opus-5');
  assert.ok(sent.messages[0].content.includes('Live status payload'), 'must ground the answer in real data');
  // Removed on Opus 5 — sending any of them is a 400.
  for (const dead of ['temperature', 'top_p', 'top_k']) {
    assert.ok(!(dead in sent), `${dead} is rejected by this model`);
  }
});

test('/ask surfaces a refusal instead of reading empty content', async () => {
  globalThis.fetch = async (url) =>
    String(url).includes('api.anthropic.com')
      ? { ok: true, status: 200, json: async () => ({ stop_reason: 'refusal', content: [] }) }
      : { ok: true, status: 200, text: async () => GOOGLE_LIVE };

  const res = await worker.fetch(
    new Request('https://status.test/ask', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'x' }),
    }),
    { ...env, ANTHROPIC_API_KEY: 'sk-test' },
  );
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'assistant_declined');
});

test('progress reported on one course still shows up on an unscoped call', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => GOOGLE_LIVE });

  await worker.fetch(
    new Request('https://status.test/progress', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ course: 'LAND2510', item: 'Quiz 01 _Origins', status: 'done' }),
    }),
    env,
  );

  // Scoped works either way; the unscoped read is what the dashboard makes and
  // what used to come back empty, making every deadline look untouched.
  const scoped = await (await worker.fetch(req('/status?course=LAND2510'), env)).json();
  assert.equal(scoped.progress_summary.done, 1);

  const all = await (await worker.fetch(req('/status'), env)).json();
  assert.equal(all.progress_summary.done, 1, 'progress must survive a cross-course read');
  assert.equal(all.progress.find((p) => p.item === 'Quiz 01 _Origins').course, 'LAND2510');
});

test('bare /app works with a session and shows sign-in without one', async () => {
  const withCookie = await worker.fetch(
    new Request('https://status.test/app', { headers: { Cookie: await sessionCookie() } }),
    env,
  );
  assert.equal(withCookie.status, 200);
  assert.match(await withCookie.text(), /Sidekick/);

  const bare = await worker.fetch(new Request('https://status.test/app'), env);
  assert.equal(bare.status, 200);
  assert.match(await bare.text(),/access_key/);
});

test('the dashboard page ships parseable JavaScript', async () => {
  // The page's script lives inside a template literal, so an unescaped \n in
  // the source emits a raw newline mid-string and breaks the whole page at
  // parse time — silently, with a blank screen. Pin it.
  const { appHtml } = await import('../src/app.js');
  const html = appHtml('Fall 2026');
  const js = html.split('<script>')[1].split('</script>')[0];
  assert.doesNotThrow(() => new Function(js), 'dashboard JS must parse');

  const css = html.split('<style>')[1].split('</style>')[0];
  assert.ok(!/[^\\]\$\{/.test(css), 'no unresolved template placeholders in CSS');
  assert.ok(!/undefined|NaN/.test(html.split('<script>')[0]), 'no undefined/NaN leaked into visible HTML');
});

test('course-less items (drop/add, advisor meetings) can be marked done', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => GOOGLE_LIVE });

  // This is exactly what the dashboard posts for an item whose course_code is
  // null. It used to come back unknown_course, so the button just said "Failed".
  const res = await worker.fetch(
    new Request('https://status.test/progress', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ course: 'GENERAL', item: 'Meeting w/ Heather Roberts', status: 'done' }),
    }),
    env,
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).course, 'GENERAL');

  // An empty course means the same thing rather than being an error.
  const blank = await worker.fetch(
    new Request('https://status.test/progress', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ course: '', item: 'Some general task' }),
    }),
    env,
  );
  assert.equal(blank.status, 200);

  // And it comes back on an unscoped read.
  const all = await (await worker.fetch(req('/status'), env)).json();
  assert.ok(all.progress.some((p) => p.item === 'Meeting w/ Heather Roberts'));

  // A genuinely bogus course is still rejected.
  const bad = await worker.fetch(
    new Request('https://status.test/progress', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ course: 'PHYS9999', item: 'x' }),
    }),
    env,
  );
  assert.equal(bad.status, 400);
});

test('re-reporting the same item updates in place instead of duplicating', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => GOOGLE_LIVE });
  const post = (course, item) =>
    worker.fetch(
      new Request('https://status.test/progress', {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ course, item, status: 'done' }),
      }),
      env,
    );

  await post('GENERAL', 'Advisor meeting');
  await post('GENERAL', 'Advisor meeting');
  const all = await (await worker.fetch(req('/status'), env)).json();
  const hits = all.progress.filter((p) => p.item === 'Advisor meeting');
  assert.equal(hits.length, 1, 'a repeat report must update, not stack');

  // A course write must not absorb the general bucket's items.
  await post('LAND2510', 'Quiz 09');
  const land = await (await worker.fetch(req('/status?course=LAND2510'), env)).json();
  const bucket = land.progress.filter((p) => p.item === 'Advisor meeting');
  assert.equal(bucket.length, 1, 'general items appear once, from their own bucket');
  assert.equal(bucket[0].course, 'GENERAL', 'and are not copied into the course bucket');
});

// The dashboard's offline answers are real code with real branches, so they are
// run here rather than grepped for. The page script is a template string served to
// the browser; this lifts the pure answer helpers out of it and calls them.
async function dashboardLocalAnswer() {
  const { appHtml } = await import('../src/app.js');
  const js = appHtml('Fall 2026').split('<script>')[1].split('</script>')[0];
  const from = js.indexOf('function fmt(list){');
  const to = js.indexOf('function render(){');
  assert.ok(from > 0 && to > from, 'the answer helpers must still be liftable');
  return new Function('const STALE=false;'+js.slice(from, to) + '\nreturn localAnswer;')();
}

test('the dashboard names each progress state instead of calling it all done', async () => {
  const localAnswer = await dashboardLocalAnswer();
  const payload = {
    actionable: {
      outstanding: [], counts: { overdue: 0, due_today: 0, awaiting_verification: 1 },
      awaiting_verification: [{ title: 'Quiz 1', course: 'BUSN 5000' }],
      coverage: { feeds_status: 'ok' },
    },
    progress: [
      { item: 'Quiz 1', course: 'BUSN5000', status: 'done', verification: 'reported' },
      { item: 'Project draft', course: 'BUSN5000', status: 'in_progress' },
      { item: 'GLO-BUS code', course: 'MGMT5560', status: 'blocked' },
      { item: 'Syllabus read', course: 'BUSN5000', status: 'done', verification: 'not_required' },
    ],
    progress_summary: { done: 2 },
  };

  const answer = localAnswer('what have I finished?', payload);
  assert.match(answer, /Reported done \(2\)/);
  assert.match(answer, /In progress \(1\)/);
  assert.match(answer, /Blocked \(1\)/);
  // Unfinished work must not appear under the done heading.
  assert.ok(answer.indexOf('Project draft') > answer.indexOf('In progress'),
    'in-progress work is listed as in progress, not as done');
  assert.match(answer, /Syllabus read {2}\(BUSN5000, nothing to submit\)/);
  assert.match(answer, /self-reported with no receipt seen/);
});

test('the dashboard will not say nothing is due when coverage is unknown', async () => {
  const localAnswer = await dashboardLocalAnswer();
  const quiet = {
    actionable: { outstanding: [], counts: {}, awaiting_verification: [],
                  coverage: { feeds_status: 'unknown' } },
    progress: [], progress_summary: {},
  };

  for (const q of ['what is overdue?', 'what is due today?', 'what should I start on?']) {
    assert.match(localAnswer(q, quiet), /^⚠ Feed health unknown/,
      `"${q}" must lead with the coverage caveat`);
  }

  // A stated feed failure still wins over the unknown-health wording.
  const broken = { ...quiet, data_warning: '1 of 2 calendar feeds failed to load.' };
  assert.match(localAnswer('what is overdue?', broken), /^⚠ 1 of 2 calendar feeds failed/);

  // And a healthy read is not decorated with a warning it does not have.
  const healthy = { ...quiet, actionable: { ...quiet.actionable, coverage: { feeds_status: 'ok' } } };
  assert.doesNotMatch(localAnswer('what is overdue?', healthy), /⚠/);
});

test('the dashboard answers overdue from the shared outstanding list', async () => {
  const localAnswer = await dashboardLocalAnswer();
  const payload = {
    actionable: {
      outstanding: [{ bucket: 'overdue', title: 'Homework 2', course: 'BUSN 5000', when: 'Sun, Aug 16' }],
      counts: {}, awaiting_verification: [], coverage: { feeds_status: 'ok' },
    },
    // The raw list still carries a completed item; it must not be counted.
    overdue: [{ title: 'Homework 2' }, { title: 'Quiz 1', completed: true }],
    progress: [], progress_summary: {},
  };
  const answer = localAnswer('anything overdue?', payload);
  assert.match(answer, /Overdue \(1\)/);
  assert.doesNotMatch(answer, /Quiz 1/, 'reported-done work is not overdue');
});

test('the dashboard reads the shared view and never buries a data warning', async () => {
  const { appHtml } = await import('../src/app.js');
  const js = appHtml('Fall 2026').split('<script>')[1].split('</script>')[0];

  // Counters and local answers must come from the same actionable view the
  // briefing does, not from the page filtering the raw lists its own way.
  assert.ok(js.includes('d.actionable'), 'the page must read the shared actionable view');
  assert.ok(js.includes('function bucketOf'), 'outstanding work comes from one place');
  assert.ok(js.includes('awaiting_verification'), 'reported and verified must be distinguishable');
  assert.ok(js.includes("submission_verification==='verified'"), 'a row states its evidence state');

  // "Nothing is due" on top of a broken feed is the one wrong answer this page
  // can give, so the warning is prepended to the answer itself.
  assert.ok(js.includes('function caveat'), 'answers must carry the data warning');
  assert.ok(/return W\+/.test(js), 'local answers must be prefixed with the caveat');
});

test('the dashboard wires up detail expansion and the done/undo toggle', async () => {
  // Two edits to this file previously failed silently, shipping a chevron that
  // did nothing and an Undo button that re-marked things done. Pin both.
  const { appHtml } = await import('../src/app.js');
  const js = appHtml('Fall 2026').split('<script>')[1].split('</script>')[0];

  assert.ok(js.includes("closest('.item.has-detail')"), 'row click must expand detail');
  assert.ok(js.includes('m.dataset.status'), 'the button must send its own status');
  assert.ok(js.includes("'not_started'"), 'undo must be able to clear a completion');
  assert.ok(js.includes('has-detail'), 'items with notes must be marked expandable');
});


test('polling /status with nothing changed costs no KV writes', async () => {
  // The dashboard refreshes on a timer. Before this guard, every refresh re-put an
  // identical deadline snapshot and a fresh lastcall record - two writes a poll,
  // which exhausted the daily free-tier write allowance from a single open tab.
  await worker.fetch(req('/status', { headers: { 'X-Bridge-Client': 'dashboard' } }), env, null);
  const afterBaseline = env.NOTES.writes;
  assert.ok(afterBaseline > 0, 'the first call should still store a baseline snapshot');

  for (let i = 0; i < 5; i += 1) {
    await worker.fetch(req('/status', { headers: { 'X-Bridge-Client': 'dashboard' } }), env, null);
  }
  assert.equal(env.NOTES.writes, afterBaseline, 'idle polls must not write to KV');
});

test('a GPT Action still records that it called, unlike the dashboard', async () => {
  await worker.fetch(req('/status'), env, null);
  assert.ok(env.NOTES.store.has('lastcall:ALL'), 'a non-dashboard caller should be recorded');

  const fresh = await worker.fetch(req('/lastcall'), env, null);
  assert.equal((await fresh.json()).seen, 1);
});

test('the wiring marker is rewritten at most once an hour', async () => {
  // This write rate was set by how much studying he does: the GPTs are instructed
  // to call getCourseStatus at the start of every conversation, and each call used
  // to re-put the marker. The key only answers "are the GPTs really wired?", which
  // an hourly timestamp answers just as well - and the quota it was quietly
  // spending is the same one the class notes and eLC alerts need.
  await worker.fetch(req('/status'), env, null);
  const afterFirst = env.NOTES.writes;
  assert.ok(env.NOTES.store.has('lastcall:ALL'));

  for (let i = 0; i < 10; i += 1) {
    await worker.fetch(req('/status'), env, null);
  }
  assert.equal(env.NOTES.writes, afterFirst, 'repeat GPT calls must not each cost a write');

  // Age it past the hour: the marker must still be allowed to stay current.
  const marker = JSON.parse(env.NOTES.store.get('lastcall:ALL'));
  marker.at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  env.NOTES.store.set('lastcall:ALL', JSON.stringify(marker));

  await worker.fetch(req('/status'), env, null);
  assert.equal(env.NOTES.writes, afterFirst + 1, 'an hour on, it should record again');
});

test('an exhausted write quota answers 503 instead of crashing', async () => {
  // The real failure mode this reproduces: on 24 Aug the daily KV write cap was
  // spent, every POST came back as a bare "error code: 1101" 500, and both the
  // Cluely note push and the eLC sweep reported an opaque failure they could not
  // act on. The request is fine; the quota is not, and the reply should say so.
  env.NOTES.put = async () => { throw new Error('KV put() limit exceeded for the day.'); };

  const res = await worker.fetch(req('/note', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'a note written after the quota ran out' }),
  }), env, null);

  assert.equal(res.status, 503, 'a spent quota is not a server fault');
  assert.equal((await res.json()).error, 'kv_write_limit');
});

test('an exhausted write quota still lets the GPTs read', async () => {
  // Reads have a 100,000/day allowance, so a spent write quota must never stop a
  // GPT answering "what is due?". Background writes have to fail quietly here.
  env.NOTES.put = async () => { throw new Error('KV put() limit exceeded for the day.'); };

  const res = await worker.fetch(req('/status'), env, null);
  assert.equal(res.status, 200, 'reads must survive an exhausted write quota');
  const body = await res.json();
  assert.ok(body.briefing, 'the briefing the GPTs lead with must still be there');
  assert.ok(Array.isArray(body.due_this_week));
});


// --- the scheduled feed check ---------------------------------------------------

test('the cron run stores a baseline and then stops writing while nothing moves', async () => {
  await worker.scheduled({}, env, null);
  const afterFirst = env.NOTES.writes;
  assert.ok(env.NOTES.store.has('snapshot:deadlines'), 'first run should store a baseline');

  await worker.scheduled({}, env, null);
  await worker.scheduled({}, env, null);
  assert.equal(env.NOTES.writes, afterFirst, 'quiet cron runs must not write');
});

test('the cron run notices a moved deadline without any request', async () => {
  await worker.scheduled({}, env, null);

  stubFeeds(feedWithMovedQuiz());
  await worker.scheduled({}, env, null);

  // Read it back the way the GPTs would, to prove the change survived to the log.
  const body = await (await worker.fetch(req('/changes'), env, null)).json();
  const moved = body.changes.filter((c) => c.type === 'moved');
  assert.equal(moved.length, 1, 'the moved quiz should be in the change log');
  assert.match(moved[0].title, /Quiz 01/);
});

test('a cron run with a broken feed does not log every deadline as deleted', async () => {
  await worker.scheduled({}, env, null);
  const before = env.NOTES.writes;

  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => '' });
  await worker.scheduled({}, env, null);

  assert.equal(env.NOTES.writes, before, 'a failed fetch must not touch the snapshot');
  const body = await (await worker.fetch(req('/changes'), env, null)).json();
  assert.deepEqual(body.changes.filter((c) => c.type === 'removed'), []);
});

test('the dashboard ships no background timer', async () => {
  const page = await (await worker.fetch(req('/app'), env, null)).text();
  assert.ok(!/setInterval/.test(page), 'the page must not poll on a timer');
  assert.match(page, /visibilitychange/, 'it should still refresh when you return to the tab');
});


test('friendly hostname uses canonical feeds, authentication, bodies and cookies', async () => {
  const alias = { PRIMARY_BRIDGE: { fetch: (request) => worker.fetch(request, env) } };
  const status = await worker.fetch(req('/status?course=BUSN5000'), alias);
  const data = await status.json();
  assert.equal(data.course.code, 'BUSN5000');
  assert.equal(data.feed_health.length, 2);
  assert.equal(data.actionable.coverage.feeds_status, 'ok');
  const unauthorized = await worker.fetch(new Request('https://status.test/status'), alias);
  assert.equal(unauthorized.status, 401);
  const posted = await worker.fetch(req('/progress', {
    method: 'POST',
    body: JSON.stringify({course: 'BUSN5000', item: 'alias draft', status: 'in_progress', note: 'Local fixture, not submitted'}),
  }), alias);
  assert.equal(posted.status, 200);
  assert.match(JSON.stringify(foundation.store.list('progress',['BUSN5000'])), /alias draft/);
  const app = await worker.fetch(new Request(`https://status.test/app/${KEY}`), alias);
  assert.equal(app.status, 303);
  assert.equal(app.headers.get('set-cookie'), null);
  const login = await worker.fetch(new Request('https://status.test/app/session',{method:'POST',headers:{Origin:'https://status.test','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({access_key:KEY})}),alias);
  assert.equal(login.status,303);assert.match(login.headers.get('set-cookie'),/HttpOnly/);
  assert.equal((await worker.fetch(new Request('https://status.test/openapi.json'),alias)).status,200);
});

test('zero configured feeds is an unhealthy check, not a clear calendar', async () => {
  delete env.FEED_ELC;
  delete env.FEED_PERSONAL;
  const health = await (await worker.fetch(req('/health'), env)).json();
  assert.equal(health.configured_feeds, 0);
  assert.equal(health.ok, false);
});

test('zero feeds cannot erase a deadline snapshot during status or scheduled checks', async () => {
  await worker.fetch(req('/status'), env);
  const snapshot = env.NOTES.store.get('snapshot:deadlines');
  const changes = env.NOTES.store.get('changes:log');
  assert.ok(snapshot);
  delete env.FEED_ELC;
  delete env.FEED_PERSONAL;
  const data = await (await worker.fetch(req('/status'), env)).json();
  assert.equal(data.actionable.coverage.feeds_status, 'unknown');
  assert.equal(env.NOTES.store.get('snapshot:deadlines'), snapshot);
  assert.equal(env.NOTES.store.get('changes:log'), changes);
  const writes = env.NOTES.writes;
  await worker.scheduled({}, env, {});
  assert.equal(env.NOTES.writes, writes);
});

test('reviewed module corrections persist once without inventing source disappearance', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-12T06:00:00Z') });
  const calendar='BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:6637-21867308@uga.view.usg.edu\nSUMMARY:Mini Project 1 - Due\nDESCRIPTION:Modules: | Mini Project 1\nLOCATION:LAND 2510E\nDTSTART:20261011T035959Z\nEND:VEVENT\nEND:VCALENDAR';
  globalThis.fetch=async url=>({ok:true,status:200,text:async()=>url==='https://d2l.test/feed.ics'?calendar:'BEGIN:VCALENDAR\nEND:VCALENDAR'});
  await worker.fetch(req('/status?course=LAND2510'),env,null);
  const snapshot=JSON.parse(env.NOTES.store.get('snapshot:deadlines'));
  assert.equal(snapshot.reviewed_containers.length,1);
  const row=snapshot.reviewed_containers[0];
  const falseRemoval={type:'removed',key:row.key,course:row.course,title:row.title,from:row.due,at:'2026-10-12T05:30:00Z'};
  const genuine={...falseRemoval,key:'another-source',title:'Different requirement'};
  env.NOTES.store.set('changes:log',JSON.stringify([falseRemoval,genuine]));
  const body=await (await worker.fetch(req('/status?course=LAND2510&dashboard=1'),env,null)).json();
  assert.equal(body.recent_changes[0].type,'reclassified');
  const stored=JSON.parse(env.NOTES.store.get('changes:log'));
  assert.equal(stored[0].previous_type,'removed');
  assert.equal(stored[0].at,falseRemoval.at);
  assert.equal(stored[0].correction.source_uid,'6637-21867308@uga.view.usg.edu');
  assert.deepEqual(stored[1],genuine);
  const writes=env.NOTES.writes;
  await worker.fetch(req('/status?course=LAND2510'),env,null);
  assert.equal(env.NOTES.writes,writes,'unchanged proof must not rewrite correction on every poll');
  const history=await (await worker.fetch(req('/changes?course=LAND2510'),env,null)).json();
  assert.equal(history.changes[0].type,'reclassified');
});


test('dashboard keyword shortcuts cannot hijack live calendar or unrelated questions', async () => {
  const answer = await dashboardLocalAnswer();
  const payload={actionable:{outstanding:[],awaiting_verification:[],coverage:{feeds_status:'ok'}},optional_this_week:[{title:'Optional reading',course:'BUSN5000'}]};
  for(const q of ['What is on my calendar today?', 'Explain the latest material coverage', 'Can you describe the overall architecture?']) {
    assert.equal(answer(q,payload),null, q+' must use live context instead of a substring shortcut');
  }
  assert.match(answer('What should I read?',payload),/Optional this week/);
  assert.match(answer('What optional reading is there?',payload),/Optional this week/);
  assert.match(answer('Anything overdue?',payload),/Nothing overdue/);
});


test('dashboard answers live briefing date and feed health without paid inference', async () => {
  const answer=await dashboardLocalAnswer();
  const payload={daily_briefing:{date:'2026-10-12'}, calendar_expected_sources:['eLC (D2L)','Google Calendar'], feed_health:[{source:'eLC (D2L)',ok:true,coverage_complete:true},{source:'Google Calendar',ok:true,coverage_complete:true}], actionable:{coverage:{feeds_status:'ok'}}};
  const q='Read-only connection check: what date is this live briefing for, and are both calendar feeds available?';
  assert.equal(answer(q,payload),'This live briefing is dated 2026-10-12. Calendar feeds — eLC (D2L): available; Google Calendar: available.');
  payload.feed_health[1].ok=false;
  assert.match(answer(q,payload),/Google Calendar: unavailable/);
  payload.feed_health.pop();
  assert.match(answer(q,payload),/Google Calendar: not checked/);
  payload.feed_health[0].coverage_complete=false;
  assert.match(answer(q,payload),/coverage incomplete/);
});

test('dashboard change answers preserve module reclassification and unconfirmed exam time',async()=>{
  const answer=await dashboardLocalAnswer();
  const result=answer('What changed?',{actionable:{coverage:{feeds_status:'ok'}},recent_changes:[
    {type:'reclassified',title:'Reviewed module',from:'2026-10-10T23:59:00Z'},
    {type:'moved',title:'Exam',from:'2026-10-14T17:15:00Z',to:'2026-10-19T04:00:00Z',to_date:'2026-10-19',to_time_verification:'unconfirmed'}]});
  assert.match(result,/source calendar entry remains present/);
  assert.match(result,/2026-10-19 \(time unconfirmed\)/);
  assert.doesNotMatch(result,/disappeared|2026-10-19T04:00:00Z/);
});


test('dashboard distinguishes original receipts from reported completion in free answers', async () => {
  const answer=await dashboardLocalAnswer();
  const payload={actionable:{outstanding:[],coverage:{feeds_status:'ok'},verified_submissions:[{title:'Submitted project',course:'LAND2510'}],awaiting_verification:[{title:'Reported quiz',course:'BUSN5000'}]}};
  const text=answer('Which submissions are verified?',payload);
  assert.match(text,/Source-verified submissions \(1\)/);
  assert.match(text,/Submitted project/);
  assert.match(text,/1 item reported done, awaiting a source receipt/);
  assert.match(text,/Reported quiz/);
  assert.doesNotMatch(text,/does not check submission pages|Nothing is waiting/);
  assert.equal(answer('Anything overdue?',payload),'Nothing overdue in the current checked window.');
});
