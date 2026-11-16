import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
const script = readFileSync(new URL('../bin/direct_material_capture.js', import.meta.url), 'utf8');
async function capture({topic = {}, path = '/content/enforced4/123-test/lesson.txt',
  origin = 'https://uga.view.usg.edu', bytes = new TextEncoder().encode('FICTIONAL source'),
  maxBytes = 1000, contentLength = null, redirected = false, hidden = false, fetchError = false} = {}) {
  const calls = [], timers = new Set(), window = {};
  let streamReads = 0;
  const request = {key: 'synthetic', org: '123', topic: '7', path, maxBytes, timeoutMs: 300};
  const context = {window, location: {origin, pathname: '/d2l/home/123'},
    document: {querySelector: () => null}, URL, AbortController, Uint8Array,
    crypto: webcrypto,
    setTimeout: (f, n) => { const t = setTimeout(f, n); timers.add(t); return t; },
    clearTimeout: t => { clearTimeout(t); timers.delete(t); },
    fetch: async (url, options) => {
      calls.push({url, options});
      if(fetchError) throw new Error('unavailable');
      const isToc = url.endsWith('/toc');
      return {ok: true, redirected: !isToc && redirected, url: origin + url,
        headers: {get: () => contentLength},
        json: async () => ({Modules: [{IsHidden: hidden, Topics: [{TopicId: 7,
          TypeIdentifier: 'File', Url: path, ...topic}]}]}),
        body: {getReader() {streamReads++; return new ReadableStream({start(c) {c.enqueue(bytes); c.close();}}).getReader();}}};
    }};
  try {
    assert.equal(vm.runInNewContext(script.replace('__REQUEST__', JSON.stringify(request)), context), 'started');
    while(window.synthetic.result === 'pending') await new Promise(r => setTimeout(r, 1));
    const result = JSON.parse(JSON.stringify(window.synthetic.result));
    window.synthetic.dispose();
    assert.equal(window.synthetic, undefined);
    return {result, calls, streamReads};
  } finally {for(const t of timers) clearTimeout(t);}
}
test('exact topic capture hashes bytes; credentials confined to origin', async () => {
  const {result,calls} = await capture();
  assert.equal(result.ok, true); assert.equal(result.sha256.length, 64);
  assert.equal(calls.length, 2);
  for(const c of calls) {assert.equal(c.options.credentials,'same-origin'); assert.equal(c.options.redirect,'error');}
});
for(const [name, options] of Object.entries({
  'wrong origin': {origin:'https://elsewhere.test'},
  'topic changed': {topic:{Url:'/content/enforced4/123-test/changed.txt'}},
  'course mismatch': {path:'/content/enforced4/456-test/lesson.txt'},
  'hidden module': {hidden:true},
  'locked topic': {topic:{IsLocked:true}},
  'oversize stream': {maxBytes:2},
  'redirect': {redirected:true},
  'network failure': {fetchError:true},
})) test(name + ' fails closed', async () => {
  const {result} = await capture(options); assert.equal(result.ok,false);
});


test('bounded document above old ceiling is hashed exactly', async () => {
  const bytes = new Uint8Array(36 * 1024 * 1024 + 7).fill(70);
  const {result} = await capture({bytes, maxBytes: 48 * 1024 * 1024});
  assert.equal(result.ok, true);
  assert.equal(result.size, bytes.length);
  const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
  assert.equal(result.sha256, hash);
});
test('oversize declared document is rejected before reading its stream', async () => {
  const {result, streamReads} = await capture({maxBytes: 48 * 1024 * 1024,
    contentLength: String(48 * 1024 * 1024 + 1)});
  assert.deepEqual(result, {ok: false, reason: 'source_too_large'});
  assert.equal(streamReads, 0);
});
test('oversize stream without length retains its specific reason', async () => {
  const {result} = await capture({maxBytes: 2});
  assert.deepEqual(result, {ok: false, reason: 'source_too_large'});
});

test('live sweep inventory recognizes one-letter R files', async () => {
  const source = readFileSync(new URL('../bin/elc_daily.py', import.meta.url), 'utf8');
  const portion = source.slice(source.indexOf('def sweep('));
  const start = portion.indexOf('"""') + 3;
  const body = portion.slice(start, portion.indexOf('""" % payload', start)).replace('%s', '{"SYN101":123}');
  // Decode the single Python string escape used by the embedded regexp.
  const js = body.replaceAll('\\\\', '\\');
  const window = {};
  vm.runInNewContext(js, {window, fetch: async () => ({ok:true, json:async () => ({Modules:[{
    Title:'Fictional module', Topics:[{TopicId:7,Title:'Fictional R lesson',TypeIdentifier:'File',
      Url:'/content/enforced4/123-test/example.R'}]}]})})});
  while(window.__sw === 'pending') await new Promise(r => setTimeout(r,1));
  assert.equal(window.__sw.SYN101[0].ext.toLowerCase(),'r');
});
