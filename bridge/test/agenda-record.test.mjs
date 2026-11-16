import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordRoutes } from '../src/record-routes.js';
import { agendaWindow } from '../src/agenda.js';
import { parseICS } from '../src/ics.js';
import { buildStatus } from '../src/status.js';
import { migrationSnapshot } from '../src/foundation.js';
import { sqliteFoundation } from './sqlite-fixture.js';

const NOW = new Date('2026-10-10T22:00:00Z');
const DUE = '2026-09-30T13:00:00.000Z'; // Oldest included day's morning in Eastern.
const VEVENT = 'BEGIN:VEVENT\nUID:oldest-day\nDTSTART:20260930T130000Z\nSUMMARY:BUSN 5000 — Quiz 1 - Due\nEND:VEVENT';
const UNSUPPORTED = 'BEGIN:VEVENT\nUID:unsupported\nDTSTART:20260101T150000Z\nRRULE:FREQ=HOURLY\nSUMMARY:Appointment\nEND:VEVENT';
const calendar = (...rows) => `BEGIN:VCALENDAR\nVERSION:2.0\n${rows.join('\n')}\nEND:VCALENDAR`;
const EMPTY = calendar();
function harness(t, { ready = true, legacy = new Map() } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const foundation = sqliteFoundation({ ready });
  const originalFetch = globalThis.fetch;
  let incomplete = false, reads = 0, unavailable = false;
  globalThis.fetch = async url => {
    reads++;
    if (unavailable) throw new Error('synthetic outage');
    return new Response(url === 'https://synthetic.test/elc'
      ? calendar(VEVENT, ...(incomplete ? [UNSUPPORTED] : [])) : EMPTY);
  };
  t.after(() => { globalThis.fetch = originalFetch; foundation.close(); });
  const env = { BRIDGE_STATE: foundation.binding, NOTES: { get: async key => legacy.get(key) || null },
    FEED_ELC: 'https://synthetic.test/elc', FEED_PERSONAL: 'https://synthetic.test/google' };
  const events = parseICS(calendar(VEVENT), { ...agendaWindow(NOW), source: 'eLC (D2L)' });
  const row = buildStatus({ events, now: NOW, health: [{ source: 'eLC (D2L)', ok: true }] }).actionable.outstanding[0];
  const progressBody = { course: 'BUSN5000', item: row.title, status: 'done', verification: 'reported',
    reported_by: 'synthetic-user', assignment_id: row.assignment_id, when_iso: row.when_iso,
    term_id: row.term_id, expected_revision: 0 };
  const call = (path, body, operation = null) => recordRoutes(new Request(`https://bridge.test${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Maintenance': 'foundation-v1',
      ...(operation ? { 'Idempotency-Key': operation } : {}) }, body: JSON.stringify(body),
  }), env, path, 'bearer');
  return { foundation, env, row, progressBody, call,
    incomplete: value => { incomplete = value; }, unavailable: value => { unavailable = value; }, reads: () => reads };
}

test('oldest local-day status identity can be saved through the matching progress window', async t => {
  const h = harness(t);
  assert.equal(h.row.bucket, 'overdue');
  assert.equal(h.row.days_away, -10);
  assert.equal(h.row.when_iso, DUE);
  const response = await h.call('/progress', h.progressBody, 'oldest-day-save');
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.ok, true);
  assert.equal(receipt.operation_id, 'oldest-day-save');
  assert.equal(receipt.recorded.assignment_id, h.row.assignment_id);
  assert.equal(receipt.recorded.identity_resolution, 'linked');
  assert.equal(receipt.recorded.verification, 'reported');
  assert.equal(h.foundation.store.list('progress', ['BUSN5000']).records.length, 1);
});

test('incomplete recurrence coverage saves nothing; the same operation retries and replays exactly once', async t => {
  const h = harness(t);
  h.incomplete(true);
  const blocked = await h.call('/progress', h.progressBody, 'coverage-retry');
  assert.equal(blocked.status, 503);
  const failure = await blocked.json();
  assert.equal(failure.error, 'assignment_sources_unavailable');
  assert.equal(failure.operation_id, 'coverage-retry');
  assert.match(failure.detail, /NOT saved/);
  assert.equal(h.foundation.store.list('progress', ['BUSN5000']).records.length, 0);
  assert.equal(h.foundation.store.rows('SELECT count(*) AS n FROM receipts')[0].n, 0);

  h.incomplete(false);
  const retried = await h.call('/progress', h.progressBody, 'coverage-retry');
  assert.equal(retried.status, 200);
  const saved = await retried.json();
  assert.equal(saved.ok, true);
  assert.equal(saved.operation_id, failure.operation_id);
  assert.equal(saved.revision, 1);
  const readCount = h.reads();
  h.unavailable(true);
  const replayed = await h.call('/progress', h.progressBody, 'coverage-retry');
  assert.equal(replayed.status, 200);
  const replay = await replayed.json();
  assert.equal(replay.replayed, true);
  assert.equal(replay.recorded.record_id, saved.recorded.record_id);
  assert.equal(replay.revision, 1);
  assert.equal(h.reads(), readCount, 'an existing receipt is returned before reading unavailable sources');
  assert.equal(h.foundation.store.list('progress', ['BUSN5000']).records.length, 1);
  assert.equal(h.foundation.store.history(saved.recorded.record_id).history.length, 1);
  assert.equal(h.foundation.store.rows('SELECT count(*) AS n FROM receipts')[0].n, 1);
});

async function migrationHarness(t) {
  const reported = { item: 'Quiz 1', status: 'done', at: '2026-09-30T14:00:00.000Z' };
  const legacy = new Map([['progress:BUSN5000', JSON.stringify([reported])]]);
  const h = harness(t, { ready: false, legacy });
  h.foundation.store.beginMigration(Date.now() - 120001);
  const snapshot = await migrationSnapshot(h.env);
  const body = { expected_digest: snapshot.digest, approved_links: [{ course: 'BUSN5000',
    current_title: h.row.title, when_iso: DUE, reported_item: reported.item, reported_at: reported.at }] };
  return { ...h, body };
}

test('migration link validation shares the oldest local-day deadline window', async t => {
  const h = await migrationHarness(t);
  const response = await h.call('/foundation/migration/initialize', h.body);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.linked, 1);
  const [record] = h.foundation.store.list('progress', ['BUSN5000']).records;
  assert.equal(record.assignment_id, h.row.assignment_id);
  assert.equal(record.identity_resolution, 'linked');
});

test('incomplete recurrence coverage cannot initialize a reviewed migration', async t => {
  const h = await migrationHarness(t);
  h.incomplete(true);
  const response = await h.call('/foundation/migration/initialize', h.body);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'assignment_sources_unavailable');
  assert.equal(h.foundation.store.meta('ready'), null);
  assert.equal(h.foundation.store.rows('SELECT count(*) AS n FROM records')[0].n, 0);
});
