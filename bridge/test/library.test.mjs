// The /library routes: the GPT's secondary source, the originals in Drive.
//
// Google is stubbed at fetch, so these assert the Worker's own behaviour — auth,
// scoping, the PDF text fallback, and that a missing credential is reported as
// configuration rather than breakage.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/worker.js';

const KEY = 'test-key-0123456789';

function makeKV() {
  const store = new Map();
  return {
    store,
    writes: 0,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { this.writes += 1; store.set(k, v); },
  };
}

// Modelled on the real Drive, including its two traps: the "College" at the root
// of My Drive is a SHORTCUT (Drive Desktop shows shortcuts as plain folders, which
// is why the on-disk path looks ordinary), and every course folder carries a
// trailing space in its name.
const SHORTCUT = 'application/vnd.google-apps.shortcut';
const FOLDERS = {
  root: [
    { id: 'docs', name: 'Documents Personal Google Drive' },
    { id: 'college-link', name: 'College', mimeType: SHORTCUT,
      shortcutDetails: { targetId: 'college' } },
  ],
  docs: [{ id: 'college', name: 'College' }],
  college: [{ id: 'uga', name: 'UGA' }],
  uga: [{ id: 'yr4', name: 'Year 4 - 2026-27' }],
  yr4: [{ id: 'classes', name: 'Classes' }],
  classes: [{ id: 'fall', name: 'Fall 2026' }],
  fall: [{ id: 'mgmt4280', name: 'MGMT 4280 ' }, { id: 'busn5000', name: 'BUSN 5000 ' }],
  mgmt4280: [{ id: 'slides', name: '02 - Slides' }],
};

const FILES = {
  slides: [{
    id: 'file-erp', name: 'W03 - Class 3 - ERP, Data Export & MRP.pdf',
    mimeType: 'application/pdf', modifiedTime: '2026-08-26T12:00:00Z',
    size: '840000', webViewLink: 'https://drive.google.com/file/d/file-erp/view',
    parents: ['slides'],
  }],
  busn5000: [{
    id: 'file-syl', name: 'Syllabus.gdoc',
    mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-08-21T12:00:00Z',
    webViewLink: 'https://drive.google.com/file/d/file-syl/view', parents: ['busn5000'],
  }],
};

let env;
let calls;

beforeEach(() => {
  calls = [];
  env = {
    API_KEY: KEY,
    NOTES: makeKV(),
    GDRIVE_CLIENT_ID: 'cid',
    GDRIVE_CLIENT_SECRET: 'csec',
    GDRIVE_REFRESH_TOKEN: 'rtok',
  };

  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }));
    }
    if (u.includes('/export?')) {
      return new Response('BUSN 5000 syllabus body text');
    }
    const q = decodeURIComponent(new URL(u).searchParams.get('q') || '');
    const isFolderQuery = q.includes("mimeType = 'application/vnd.google-apps.folder'");
    const parent = (q.match(/'([^']+)' in parents/) || [])[1];

    if (isFolderQuery) {
      // Drive's own `name =` is exact; the walk deliberately no longer uses it,
      // so the stub returns every child and lets the code do the matching.
      const kids = (FOLDERS[parent] || []).map((k) => ({
        mimeType: k.mimeType || 'application/vnd.google-apps.folder', ...k,
      }));
      return new Response(JSON.stringify({ files: kids }));
    }
    if (q) {                                    // file search across parents
      const parents = [...q.matchAll(/'([^']+)' in parents/g)].map((m) => m[1]);
      let files = parents.flatMap((p) => FILES[p] || []);
      const contains = (q.match(/name contains '([^']+)'/) || [])[1];
      if (contains) files = files.filter((f) => f.name.toLowerCase().includes(contains.toLowerCase()));
      return new Response(JSON.stringify({ files }));
    }
    // metadata by id
    const id = u.split('/files/')[1].split('?')[0];
    const folder = Object.entries(FOLDERS).flatMap(([parent, children]) =>
      children.map((f) => ({mimeType: 'application/vnd.google-apps.folder', ...f, parents: [parent]})))
      .find((f) => f.id === id);
    const file = Object.values(FILES).flat().find((f) => f.id === id) || folder;
    return new Response(JSON.stringify(file));
  };
});

const req = (path, init = {}) =>
  new Request(`https://status.test${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, ...(init.headers || {}) },
  });

test('library requires the API key like everything else', async () => {
  const res = await worker.fetch(new Request('https://status.test/library'), env);
  assert.equal(res.status, 401);
});

test('says so plainly when Drive is not configured', async () => {
  delete env.GDRIVE_REFRESH_TOKEN;
  const res = await worker.fetch(req('/library'), env);
  assert.equal(res.status, 501);
  assert.equal((await res.json()).error, 'drive_not_configured');
});

test('scopes a search to one course folder', async () => {
  const res = await worker.fetch(req('/library?course=MGMT4280'), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.course, 'MGMT4280');
  assert.equal(body.count, 1);
  assert.equal(body.documents[0].title, 'W03 - Class 3 - ERP, Data Export & MRP.pdf');
  assert.equal(body.documents[0].folder, 'MGMT 4280/02 - Slides');
  assert.equal(body.documents[0].type, 'PDF');
  assert.equal(body.documents[0].link, 'https://drive.google.com/file/d/file-erp/view');
});

test('an unknown course is rejected, not silently searched globally', async () => {
  const res = await worker.fetch(req('/library?course=NOPE9999'), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'unknown_course');
});

test('exports text for a Google-native document', async () => {
  const res = await worker.fetch(req('/library/doc?id=file-syl'), env);
  const body = await res.json();
  assert.equal(body.source, 'drive_export');
  assert.match(body.text, /syllabus body text/);
  assert.equal(body.truncated, false);
});

test('a PDF falls back to the sweep extraction, and says that is what it did', async () => {
  // The sweep pushes text under the name the file has IN DRIVE.
  const push = await worker.fetch(req('/library/text', {
    method: 'POST',
    body: JSON.stringify({
      course: 'MGMT4280',
      filename: 'W03 - Class 3 - ERP, Data Export & MRP.pdf',
      title: 'Class 3 - ERP, Data Export & MRP',
      pages: 37,
      text: 'MRP explodes the bill of materials into timed orders.',
    }),
  }), env);
  assert.equal(push.status, 200);

  const res = await worker.fetch(req('/library/doc?id=file-erp'), env);
  const body = await res.json();
  assert.equal(body.source, 'sweep_extraction');
  assert.equal(body.pages, 37);
  assert.match(body.text, /bill of materials/);
  assert.equal(body.document.type, 'PDF');
});

test('a PDF with no pushed extraction reports why, rather than inventing text', async () => {
  const res = await worker.fetch(req('/library/doc?id=file-erp'), env);
  const body = await res.json();
  assert.equal(body.text, null);
  assert.match(body.reason, /cannot extract text/i);
  // The link still comes back — it is the useful thing when text is impossible.
  assert.equal(body.document.link, 'https://drive.google.com/file/d/file-erp/view');
});

test('getDocument needs an id', async () => {
  const res = await worker.fetch(req('/library/doc'), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'missing_id');
});

test('the access token is cached rather than re-minted per call', async () => {
  await worker.fetch(req('/library?course=MGMT4280'), env);
  const first = calls.filter((c) => c.includes('oauth2.googleapis.com')).length;
  await worker.fetch(req('/library?course=MGMT4280'), env);
  const total = calls.filter((c) => c.includes('oauth2.googleapis.com')).length;
  assert.equal(first, 1);
  assert.equal(total, 1, 'second request should reuse the cached token');
});

test('the folder id walk is cached too', async () => {
  await worker.fetch(req('/library?course=MGMT4280'), env);
  assert.equal(env.NOTES.store.get('drive:rootid'), 'fall');
});

test('a course folder whose name has a trailing space still scopes', async () => {
  // The real folders are "MGMT 4280 ". An exact comparison scoped to nothing and
  // returned an empty library rather than an error, which is the worst shape of
  // wrong: it looks like the course simply has no material.
  const res = await worker.fetch(req('/library?course=MGMT4280'), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.count, 1);
  assert.equal(body.documents[0].folder, 'MGMT 4280/02 - Slides',
    'the folder path shown should be trimmed');
});

test('scoping to one course excludes the others', async () => {
  const res = await worker.fetch(req('/library?course=BUSN5000'), env);
  const body = await res.json();
  assert.equal(body.count, 1);
  assert.equal(body.documents[0].title, 'Syllabus.gdoc');
});

test('a search filters by filename', async () => {
  const hit = await (await worker.fetch(req('/library?course=MGMT4280&q=ERP'), env)).json();
  assert.equal(hit.count, 1);
  const miss = await (await worker.fetch(req('/library?course=MGMT4280&q=zzzz'), env)).json();
  assert.equal(miss.count, 0);
});

test('library uses the shared service-account root and does not walk personal My Drive', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const privateKey = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  env.GDRIVE_SERVICE_ACCOUNT_JSON = JSON.stringify({ type: 'service_account',
    client_email: 'course-reader@example.iam.gserviceaccount.com',
    private_key: `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----` });
  env.GDRIVE_ROOT_ID = 'fall';
  const response = await worker.fetch(req('/library?course=BUSN5000'), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).documents[0].title, 'Syllabus.gdoc');
  assert.equal(env.NOTES.store.has('drive:rootid'), false);
  assert.equal(env.NOTES.store.has('drive:service-token'), true);
  assert.equal(env.NOTES.store.has('drive:token'), false);
  assert.equal(calls.some((url) => decodeURIComponent(url).includes("'root' in parents")), false);
});


test('course search does not enumerate unrelated course subtrees', async () => {
  env.NOTES.store.set('drive:rootid', 'fall');
  const res = await worker.fetch(req('/library?course=MGMT4280'), env);
  assert.equal(res.status, 200);
  const queries = calls.map((u) => new URL(u).searchParams.get('q') || '');
  assert.equal(queries.some((q) => q.includes("'busn5000' in parents")), false);
  assert.equal((await res.json()).documents[0].folder, 'MGMT 4280/02 - Slides');
});

test('document metadata follows only its ancestors and still returns the course path', async () => {
  env.NOTES.store.set('drive:rootid', 'fall');
  const body = await (await worker.fetch(req('/library/doc?id=file-erp'), env)).json();
  assert.equal(body.document.folder, 'MGMT 4280/02 - Slides');
  assert.equal(calls.some((u) => new URL(u).searchParams.has('q')), false);
  assert.equal(calls.filter((u) => u.includes('/drive/v3/files/')).length, 3);
});

test('cyclic parent metadata cannot hang document readback or invent a library path', async () => {
  env.NOTES.store.set('drive:rootid', 'fall');
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).includes('/files/slides?')
    ? new Response(JSON.stringify({id: 'slides', name: 'Loop', mimeType: 'application/vnd.google-apps.folder', parents: ['slides']}))
    : previous(url, init);
  const response = await worker.fetch(req('/library/doc?id=file-erp'), env);
  assert.equal(response.status,403);
  assert.equal((await response.json()).error,'drive_error');
});

test('collector receipts read full text hashes, isolate identical filenames, and replay without another write', async()=>{
  const payload={course:'MGMT4280',filename:'Syllabus.pdf',text:'Course A current revision'};
  const post=body=>worker.fetch(req('/library/text',{method:'POST',body:JSON.stringify(body)}),env);
  const first=await (await post(payload)).json();
  assert.match(first.text_sha256,/^[a-f0-9]{64}$/); assert.equal(first.truncated,false);
  const writes=env.NOTES.writes;
  const replay=await (await post(payload)).json();
  assert.equal(replay.replayed,true); assert.equal(env.NOTES.writes,writes);
  await post({...payload,course:'BUSN5000',text:'Course B different revision'});
  const a=await (await worker.fetch(req('/library/text?course=MGMT4280&filename=Syllabus.pdf'),env)).json();
  const b=await (await worker.fetch(req('/library/text?course=BUSN5000&filename=Syllabus.pdf'),env)).json();
  assert.equal(a.text_sha256,first.text_sha256);assert.notEqual(a.text_sha256,b.text_sha256);
  assert.equal(a.text,undefined);assert.equal(a.course,'MGMT4280');
  assert.equal((await worker.fetch(new Request('https://status.test/library/text?course=MGMT4280&filename=Syllabus.pdf'),env)).status,401);
});
test('oversized text fails before storage rather than acknowledging a truncated copy',async()=>{
  const r=await worker.fetch(req('/library/text',{method:'POST',body:JSON.stringify({course:'MGMT4280',filename:'large.pdf',text:'a'.repeat(2000001)})}),env);
  assert.equal(r.status,413); assert.equal(env.NOTES.writes,0);
});
test('long course packets retain their complete hash and replay without another write',async()=>{
  const text='Long source packet\n'.repeat(15000);
  const payload={course:'BUSN5000',filename:'course-packet.pdf',text};
  const post=()=>worker.fetch(req('/library/text',{method:'POST',body:JSON.stringify(payload)}),env);
  const response=await post(); assert.equal(response.status,200);
  const receipt=await response.json(); assert.equal(receipt.chars,text.length);assert.equal(receipt.truncated,false);
  const writes=env.NOTES.writes;
  const replay=await (await post()).json();assert.equal(replay.text_sha256,receipt.text_sha256);assert.equal(replay.replayed,true);assert.equal(env.NOTES.writes,writes);
  const readback=await (await worker.fetch(req('/library/text?course=BUSN5000&filename=course-packet.pdf'),env)).json();
  assert.equal(readback.text_sha256,receipt.text_sha256);assert.equal(readback.chars,text.length);assert.equal(readback.text,undefined);
});
test('oversized library request bytes are rejected before parsing or writes',async()=>{
  const response=await worker.fetch(req('/library/text',{method:'POST',body:' '.repeat(12100001)}),env);
  assert.equal(response.status,413);assert.equal(env.NOTES.writes,0);
});
test('legacy filename collision never leaks another course extraction',async()=>{
  const filename=FILES.slides[0].name;
  const key='doctext:w03 class 3 erp data export mrp';
  env.NOTES.store.set(key,JSON.stringify({filename,course:'BUSN5000',text:'Wrong course private text'}));
  const r=await (await worker.fetch(req('/library/doc?id=file-erp'),env)).json();
  assert.equal(r.text,null);
  const receipt=await worker.fetch(req('/library/text?course=MGMT4280&filename='+encodeURIComponent(filename)),env);
  assert.equal(receipt.status,404);
});
test('collector E aliases share only their exact canonical material receipts',async()=>{
  for(const [input,canonical] of [['LAND2510E','LAND2510'],['BUSN 3040E','BUSN3040']]) {
    const post=await worker.fetch(req('/library/text',{method:'POST',body:JSON.stringify({course:input,filename:'Syllabus.zip',text:canonical+' text'})}),env);
    assert.equal(post.status,200);const receipt=await post.json();assert.equal(receipt.course,canonical);
    const get=await (await worker.fetch(req('/library/text?course='+encodeURIComponent(input)+'&filename=Syllabus.zip'),env)).json();assert.equal(get.text_sha256,receipt.text_sha256);
  }
});
test('legacy E-course receipt canonicalizes identity without changing stored content',async()=>{
  env.NOTES.store.set('doctext:syllabus',JSON.stringify({filename:'Syllabus.zip',course:'LAND2510E',text:'Legacy course text'}));
  const reply=await (await worker.fetch(req('/library/text?course=LAND2510&filename=Syllabus.zip'),env)).json();
  assert.equal(reply.ok,true);assert.equal(reply.course,'LAND2510');assert.match(reply.text_sha256,/^[a-f0-9]{64}$/);assert.equal(env.NOTES.writes,0);
});
test('Drive folders carrying E course labels retain their legacy PDF fallback',async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=async(url,init)=>String(url).includes('/files/mgmt4280?')
    ?new Response(JSON.stringify({id:'mgmt4280',name:'LAND 2510E ',mimeType:'application/vnd.google-apps.folder',parents:['fall']}))
    :previous(url,init);
  const filename=FILES.slides[0].name;
  env.NOTES.store.set('doctext:w03 class 3 erp data export mrp',JSON.stringify({
    filename,course:'LAND2510E',text:'Legacy LAND source extraction',truncated:false
  }));
  const response=await worker.fetch(req('/library/doc?id=file-erp'),env);
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.document.folder,'LAND 2510E/02 - Slides');
  assert.equal(body.source,'sweep_extraction');
  assert.equal(body.text,'Legacy LAND source extraction');
  assert.match(body.text_sha256,/^[a-f0-9]{64}$/);
});


test('same filename extractions coexist while compatibility reads retain last-published semantics', async()=>{
  const filename=FILES.busn5000[0].name;
  const post=text=>worker.fetch(req('/library/text',{method:'POST',body:JSON.stringify({course:'BUSN5000',filename,text})}),env);
  const a=await (await post('Topic A exact source')).json();
  const b=await (await post('Topic B exact source')).json();
  assert.notEqual(a.text_sha256,b.text_sha256);
  const writes=env.NOTES.writes;
  assert.equal((await post('Topic A exact source')).status,200);
  assert.equal(env.NOTES.writes,writes+1);
  assert.equal((await (await post('Topic A exact source')).json()).replayed,true);
  assert.equal(env.NOTES.writes,writes+1);
  const latest=await (await worker.fetch(req('/library/text?course=BUSN5000&filename='+encodeURIComponent(filename)),env)).json();
  assert.equal(latest.text_sha256,a.text_sha256);
  for(const [receipt,text] of [[a,'Topic A exact source'],[b,'Topic B exact source']]) {
    const exact=await (await worker.fetch(req('/library/text?course=BUSN5000&filename='+encodeURIComponent(filename)+'&text_sha256='+receipt.text_sha256),env)).json();
    assert.equal(exact.text_sha256,receipt.text_sha256);
    const doc=await (await worker.fetch(req('/library/doc?id=file-syl&text_sha256='+receipt.text_sha256),env)).json();
    assert.equal(doc.source,'sweep_extraction');assert.equal(doc.text,text);assert.equal(doc.next_offset,null);
  }
});

test('million-character packet roundtrips every page without splitting Unicode', async()=>{
  const text='a'.repeat(119999)+'😀'+'Z'.repeat(812532);
  const filename=FILES.slides[0].name;
  const push=await worker.fetch(req('/library/text',{method:'POST',body:JSON.stringify({course:'MGMT4280',filename,text})}),env);
  assert.equal(push.status,200);const receipt=await push.json();
  let offset=0,assembled='',pages=0;
  do {
    const response=await worker.fetch(req('/library/doc?id=file-erp&text_sha256='+receipt.text_sha256+'&offset='+offset+'&max_chars=120000'),env);
    assert.equal(response.status,200);const body=await response.json();
    assert.equal(body.offset,offset);assert.equal(body.total_chars,text.length);
    assert.equal(body.text_sha256,receipt.text_sha256);assert.ok(body.text.length<=120000);
    assert.equal(body.text.isWellFormed(),true);assembled+=body.text;pages++;
    offset=body.next_offset;
  } while(offset!==null);
  assert.equal(pages,8);assert.equal(assembled,text);
  const bad=await worker.fetch(req('/library/doc?id=file-erp&text_sha256='+receipt.text_sha256+'&offset=120000'),env);
  assert.equal(bad.status,400);
});

test('exact extraction selectors reject invalid, absent and cross-course identities',async()=>{
  for(const path of ['/library/doc?id=file-erp&text_sha256=nope','/library/doc?id=file-erp&offset=1',
    '/library/text?course=MGMT4280&filename=x.pdf&text_sha256=nope']) {
    assert.equal((await worker.fetch(req(path),env)).status,400);
  }
  const filename=FILES.slides[0].name;
  const receipt=await (await worker.fetch(req('/library/text',{method:'POST',body:JSON.stringify({course:'BUSN5000',filename,text:'Wrong course private bytes'})}),env)).json();
  assert.equal((await worker.fetch(req('/library/doc?id=file-erp&text_sha256='+receipt.text_sha256),env)).status,404);
});

test('replay repairs missing compatibility pointer after an interrupted dual write',async()=>{
  const payload={course:'MGMT4280',filename:'repair.pdf',text:'Exact retained content'};
  const post=()=>worker.fetch(req('/library/text',{method:'POST',body:JSON.stringify(payload)}),env);
  const first=await (await post()).json();
  const key=[...env.NOTES.store.keys()].find(k=>k.startsWith('doctext:v2:'));
  env.NOTES.store.delete(key);const writes=env.NOTES.writes;
  assert.equal((await post()).status,200);assert.equal(env.NOTES.writes,writes+1);
  const latest=await (await worker.fetch(req('/library/text?course=MGMT4280&filename=repair.pdf'),env)).json();
  assert.equal(latest.text_sha256,first.text_sha256);
});

test('exact replay repairs a stale compatibility pointer without losing either version',async()=>{
  const filename='interrupted.pdf';
  const post=text=>worker.fetch(req('/library/text',{method:'POST',body:JSON.stringify({course:'MGMT4280',filename,text})}),env);
  await post('old bytes');const key=[...env.NOTES.store.keys()].find(k=>k.startsWith('doctext:v2:'));
  const old=env.NOTES.store.get(key);const newer=await (await post('new bytes')).json();
  env.NOTES.store.set(key,old);const writes=env.NOTES.writes;
  assert.equal((await post('new bytes')).status,200);assert.equal(env.NOTES.writes,writes+1);
  const latest=await (await worker.fetch(req('/library/text?course=MGMT4280&filename='+filename),env)).json();
  assert.equal(latest.text_sha256,newer.text_sha256);
  assert.equal([...env.NOTES.store.keys()].filter(k=>k.startsWith('doctext:v3:')).length,2);
});

test('mutable legacy latest cannot masquerade as a retained exact variant',async()=>{
  const filename=FILES.slides[0].name;
  const first=await (await worker.fetch(req('/library/text',{method:'POST',body:JSON.stringify({course:'MGMT4280',filename,text:'Legacy only bytes'})}),env)).json();
  const exact=[...env.NOTES.store.keys()].find(k=>k.startsWith('doctext:v3:'));env.NOTES.store.delete(exact);
  assert.equal((await worker.fetch(req('/library/text?course=MGMT4280&filename='+encodeURIComponent(filename)),env)).status,200);
  assert.equal((await worker.fetch(req('/library/text?course=MGMT4280&filename='+encodeURIComponent(filename)+'&text_sha256='+first.text_sha256),env)).status,404);
  assert.equal((await worker.fetch(req('/library/doc?id=file-erp&text_sha256='+first.text_sha256),env)).status,404);
});

test('A to B to A and identical replay preserve all published exact variants after every write',async()=>{
  const filename=FILES.busn5000[0].name;const known=new Map();
  for(const text of ['Topic A preserved bytes','Topic B preserved bytes','Topic A preserved bytes','Topic A preserved bytes']) {
    const response=await worker.fetch(req('/library/text',{method:'POST',body:JSON.stringify({course:'BUSN5000',filename,text})}),env);
    assert.equal(response.status,200);const receipt=await response.json();known.set(receipt.text_sha256,text);
    const latest=await (await worker.fetch(req('/library/text?course=BUSN5000&filename='+encodeURIComponent(filename)),env)).json();
    assert.equal(latest.text_sha256,receipt.text_sha256);
    for(const [hash,expected] of known) {
      const exact=await worker.fetch(req('/library/doc?id=file-syl&text_sha256='+hash),env);
      assert.equal(exact.status,200);const body=await exact.json();
      assert.equal(body.text,expected);assert.equal(body.text_sha256,hash);assert.equal(body.truncated,false);assert.equal(body.next_offset,null);
    }
  }
});
