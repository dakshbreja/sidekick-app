import { sqliteFoundation } from './sqlite-fixture.js';
// The slash-command directory and the call policy.
//
// These ship inside the /status payload rather than in each GPT's Instructions,
// because several GPTs sit within a few dozen characters of ChatGPT's 8,000-char
// instruction cap. That makes the payload the contract, so it is tested like one.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/worker.js';
import { COMMANDS } from '../src/commands.js';
import { D2L_FEED, GOOGLE_FEED } from './fixtures.js';

const KEY = 'test-key-0123456789';

function makeKV() {
  const store = new Map();
  return {
    store, writes: 0,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { this.writes += 1; store.set(k, v); },
  };
}

let env, foundation;
afterEach(() => foundation?.close());
beforeEach(() => {
  foundation = sqliteFoundation();
  env = { API_KEY: KEY,
    BRIDGE_STATE: foundation.binding, FEED_ELC: 'https://d2l.test/feed.ics',
          FEED_PERSONAL: 'https://google.test/feed.ics', NOTES: makeKV() };
  globalThis.fetch = async (url) => {
    const body = { 'https://d2l.test/feed.ics': D2L_FEED, 'https://google.test/feed.ics': GOOGLE_FEED }[url];
    if (!body) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
});

const req = (path) => new Request(`https://status.test${path}`, {
  headers: { Authorization: `Bearer ${KEY}` },
});

test('/commands is gated like everything else', async () => {
  const res = await worker.fetch(new Request('https://status.test/commands'), env);
  assert.equal(res.status, 401);
});

test('/commands lists the directory with the operation each maps to', async () => {
  const body = await (await worker.fetch(req('/commands'), env)).json();
  assert.ok(body.commands.length >= 10);
  const help = body.commands.find((c) => c.cmd === '/help');
  assert.ok(help, '/help must be listed, since it is the discovery path');
  const find = body.commands.find((c) => c.cmd.startsWith('/find'));
  assert.equal(find.op, 'searchLibrary');
});

test('every command maps to a real operation, or to none deliberately', async () => {
  const { default: openapi } = await import('../src/openapi.js');
  const ops = new Set();
  for (const methods of Object.values(openapi.paths)) {
    for (const op of Object.values(methods)) ops.add(op.operationId);
  }
  for (const c of COMMANDS) {
    if (c.op === null) continue;             // /help is answered from the list itself
    assert.ok(ops.has(c.op), `${c.cmd} maps to ${c.op}, which is not in the schema`);
  }
});

test('command names are unique and all start with a slash', async () => {
  const names = COMMANDS.map((c) => c.cmd.split(' ')[0]);
  assert.equal(new Set(names).size, names.length, 'duplicate command');
  for (const n of names) assert.match(n, /^\/[a-z]+$/, `${n} is not a plain slash command`);
});

test('/status carries the directory and the call policy', async () => {
  const body = await (await worker.fetch(req('/status?course=LAND2510'), env)).json();
  assert.ok(Array.isArray(body.commands) && body.commands.length >= 10);
  assert.match(body.call_policy, /ONCE per conversation/);
  assert.ok(body.command_help.includes('/'), 'command_help must explain the slash convention');
  // The briefing is what the GPT leads with; the guide must not have displaced it.
  assert.ok(body.briefing.length > 0);
});

test('the guide stays small — it ships on every status call', async () => {
  const body = await (await worker.fetch(req('/status?course=LAND2510'), env)).json();
  const guide = JSON.stringify({
    commands: body.commands, call_policy: body.call_policy, command_help: body.command_help,
  });
  assert.ok(guide.length < 2500, `guide is ${guide.length} bytes; keep it lean`);
});

test('command_help forbids inventing commands and pins /help output', async () => {
  // BUSN 5000 answered /help from its own persona and offered /quiz and /study,
  // neither of which exists. The wording has to be an instruction, not a hint.
  const body = await (await worker.fetch(req('/status?course=LAND2510'), env)).json();
  assert.match(body.command_help, /\/help/, 'must name /help explicitly');
  assert.match(body.command_help, /invent/i, 'must forbid inventing commands');
  assert.match(body.command_help, /commands` list|`commands`/, 'must point at the list');
});

test('the directory in /status omits the op field, which the GPT does not need', async () => {
  const body = await (await worker.fetch(req('/status?course=LAND2510'), env)).json();
  for (const c of body.commands) {
    assert.deepEqual(Object.keys(c).sort(), ['cmd', 'does']);
  }
});

// The dashboard assistant is grounded in the same payload the page renders, so its
// system prompt has to describe the same semantics the page and the briefing use.
test('the assistant is told to read the shared view, not re-derive it', async () => {
  const { SYSTEM } = await import('../src/ask.js');
  assert.ok(SYSTEM, 'the system prompt must be inspectable');

  assert.match(SYSTEM, /actionable/, 'it must point at the shared view');
  assert.match(SYSTEM, /Do not re-derive/i);
  // Matching is not submission evidence, and the prompt must say which is which.
  assert.match(SYSTEM, /submission_verification/);
  assert.match(SYSTEM, /"verified"/);
  assert.match(SYSTEM, /not_required/);
  assert.match(SYSTEM, /never\s+"it is confirmed submitted"/i);
  // Warnings outrank the answer, including unknown coverage.
  assert.match(SYSTEM, /data_warning/);
  assert.match(SYSTEM, /feeds_status/);
  assert.match(SYSTEM, /unknown/);
  assert.match(SYSTEM, /before saying nothing is due/i);
  assert.match(SYSTEM, /submission_sources_checked/);
});
