import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { publicInfoResponse } from '../src/public-info.js';

const routes = ['/about', '/privacy', '/terms'];
const request = (path, method = 'GET') => new Request(`https://public-info.test${path}`, { method });

test('public informational GETs never access private credentials, sources or storage', async () => {
  const env = { PRIMARY_BRIDGE: null };
  for (const name of ['API_KEY', 'FEED_ELC', 'FEED_PERSONAL', 'NOTES', 'BRIDGE_STATE', 'GDRIVE_SERVICE_ACCOUNT_JSON']) {
    Object.defineProperty(env, name, { get() { throw new Error(`Public page touched ${name}`); } });
  }
  for (const path of routes) {
    const response = await worker.fetch(request(path), env);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Sidekick/);
    assert.equal(response.headers.get('set-cookie'), null);
  }
});

test('public pages contain only static text and relative navigation with restrictive headers', async () => {
  for (const path of routes) {
    const response = publicInfoResponse(request(path), path);
    const html = await response.text();
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /script-src 'none'/);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.doesNotMatch(html, /<script\b|<iframe\b|<img\b|<form\b|https?:\/\/|@[\w.-]+\.[a-z]{2,}|Daksh|BUSN\d|MGMT\d|workers\.dev/i);
    for (const link of routes) assert.ok(html.includes(`href="${link}"`));
  }
});

test('HEAD serves matching public headers without a document body', async () => {
  for (const path of routes) {
    const head = await worker.fetch(request(path, 'HEAD'), {});
    const get = publicInfoResponse(request(path), path);
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.deepEqual([...head.headers], [...get.headers]);
  }
});

test('query strings and request headers cannot enter public informational content', async () => {
  const normal = await worker.fetch(request('/privacy'), {});
  const injected = await worker.fetch(new Request('https://public-info.test/privacy?token=private-query&title=private-event', {
    headers: { 'X-Private-Note': 'private-header', Authorization: 'Bearer private-token' },
  }), {});
  assert.equal(await injected.text(), await normal.text());
});

test('only exact informational GET and HEAD routes bypass private authentication', async () => {
  const env = { API_KEY: 'unrelated-test-key' };
  for (const path of ['/about/', '/privacy-extra', '/privacy/document', '/ABOUT', '/%70rivacy', '/status', '/library', '/progress', '/note', '/classnote', '/system/health']) {
    const response = await worker.fetch(request(path), env);
    assert.equal(response.status, 401, path);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    for (const path of routes) {
      assert.equal(publicInfoResponse(request(path, method), path), null);
      const response = await worker.fetch(request(path, method), env);
      assert.equal(response.status, 401, `${method} ${path}`);
    }
  }
});

test('the friendly worker preserves its canonical forwarding boundary for public information', async () => {
  const original = request('/privacy');
  let forwarded;
  const canonical = new Response('canonical informational page');
  const env = { PRIMARY_BRIDGE: { fetch: async req => { forwarded = req; return canonical; } } };
  assert.equal(await worker.fetch(original, env), canonical);
  assert.equal(forwarded, original);
});
