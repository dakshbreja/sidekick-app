// Real workerd/SQLite retry verification. No external sources or local collectors.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),deps='/Users/Daksh/.npm/_npx/32026684e21afda6/node_modules';
const {build}=require(deps+'/esbuild'),{Miniflare,convertV4MiniflareOptions}=require(deps+'/miniflare');
const bundle=await build({entryPoints:['src/entry.js'],bundle:true,write:false,format:'esm',platform:'neutral',external:['cloudflare:workers']});
let fail=false,fetches=0;
const mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,cf:false,workers:[{name:'retry-fixture',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-19',bindings:{API_KEY:'fixture-only',FEED_ELC:'https://fixture.invalid/elc',FEED_PERSONAL:'https://fixture.invalid/personal'},kvNamespaces:{NOTES:'fixture-notes'},durableObjects:{BRIDGE_STATE:{className:'BridgeState',useSQLite:true}},outboundService:async req=>{assert.equal(new URL(req.url).hostname,'fixture.invalid');fetches++;return fail?new Response('unavailable',{status:503}):new Response('BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR');}}]}));
try{
const origin=(await mf.ready).origin;
const api=async(path,body,auth=true)=>{const r=await mf.dispatchFetch(origin+path,{method:body===undefined?'GET':'POST',headers:{...(auth?{Authorization:'Bearer fixture-only'}:{}),'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
assert.equal((await api('/system/retry',{node:'bridge',request_id:crypto.randomUUID()},false)).status,401);
const request_id=crypto.randomUUID(),r=await api('/system/retry',{node:'elc-feed',request_id});assert.equal(r.status,202);
let j;for(let i=0;i<50;i++){j=(await api('/system/retry')).data.jobs.find(j=>j.id===request_id);if(j?.state!=='running')break;await new Promise(r=>setTimeout(r,50));}
assert.equal(j.observations['elc-feed'].outcome,'healthy');assert.equal(fetches,2);
assert.equal((await api('/system/retry',{node:'elc-feed',request_id})).data.created,false);assert.equal(fetches,2);
const key=crypto.randomUUID();await api('/system/retry',{node:'board-refresh',request_id:key});const claimed=await Promise.all([api('/system/retry/claim',{}),api('/system/retry/claim',{})]);assert.equal(claimed.filter(r=>r.data.job).length,1);
assert.equal((await api('/system/retry/finish',{id:key,state:'succeeded'})).data.job.state,'succeeded');
const snapshot=(await api('/system/health')).data;assert.equal(snapshot.nodes.find(n=>n.id==='elc-feed').outcome,'healthy');assert.equal(snapshot.nodes.find(n=>n.id==='board-refresh').retry_job.state,'succeeded');
const writeKey=crypto.randomUUID();await api('/system/retry',{node:'write',request_id:writeKey});for(let i=0;i<50;i++){j=(await api('/system/retry')).data.jobs.find(j=>j.id===writeKey);if(j?.state!=='running')break;await new Promise(r=>setTimeout(r,50));}assert.equal(j.state,'succeeded');
console.log('Real workerd + SQLite: authentication, cloud execution, durable deduplication, atomic Mac claims, receipts, health overlay and diagnostic write passed.');
}finally{await mf.dispose();}
