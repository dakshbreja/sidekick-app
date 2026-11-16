import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {search, fileMeta, fileText} from '../src/drive.js';

const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; });
const env = {GDRIVE_SERVICE_ACCOUNT_JSON:'{}',GDRIVE_ROOT_ID:'root',NOTES:{get:async()=>
  JSON.stringify({token:'fixture',expires_at:new Date(Date.now()+3600000).toISOString()})}};
const response = data => new Response(JSON.stringify(data));

test('folder discovery and search traverse all pages', async () => {
  globalThis.fetch=async(url,options)=>{
    assert.ok(options.signal);
    const params=new URL(url).searchParams, query=params.get('q');
    if(query.includes("'root' in parents")) return params.has('pageToken')
      ? response({files:[{id:'course',name:'MGMT 5560 ',mimeType:'application/vnd.google-apps.folder'}]})
      : response({files:[],nextPageToken:'course-page'});
    if(query.includes('mimeType =')) return response({files:[]});
    return params.has('pageToken')
      ? response({files:[{id:'b',name:'second.txt',modifiedTime:'2026-10-10'}]})
      : response({files:[{id:'a',name:'first.txt',modifiedTime:'2026-10-09'}],nextPageToken:'files-page'});
  };
  assert.deepEqual((await search(env,{courseFolder:'MGMT 5560',limit:10})).map(f=>f.doc_id),['b','a']);
});

test('accessible documents outside the shared course root are refused', async () => {
  globalThis.fetch=async url=>new URL(url).pathname.endsWith('/doc')
    ? response({id:'doc',name:'private.txt',parents:['elsewhere']})
    : response({id:'elsewhere',name:'Other',mimeType:'application/vnd.google-apps.folder',parents:[]});
  await assert.rejects(fileMeta(env,'doc'),error=>error.status===403);
});

test('download is exact and oversized responses fail without returning a prefix', async () => {
  globalThis.fetch=async()=>new Response('current lecture\n');
  assert.deepEqual(await fileText(env,{id:'doc',mimeType:'text/plain'},1000),
    {text:'current lecture\n',truncated:false,source:'drive_download'});
  globalThis.fetch=async()=>new Response('x'.repeat(2*1024*1024+1));
  await assert.rejects(fileText(env,{id:'doc',mimeType:'text/plain'},1000),error=>error.status===413);
});
