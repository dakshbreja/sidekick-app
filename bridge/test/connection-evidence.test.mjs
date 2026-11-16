import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {probeDriveAccess} from '../src/drive-health.js';
import {collectCloudHealth,systemHealth,CLOUD_KEY} from '../src/system-health.js';
import {displayedState,systemHtml} from '../src/system-page.js';
import {CONNECTION_EVIDENCE} from '../src/connection-evidence.js';

const now=new Date('2026-09-05T20:00:00Z');
const credentials={GDRIVE_CLIENT_ID:'private-client',GDRIVE_CLIENT_SECRET:'private-secret',GDRIVE_REFRESH_TOKEN:'private-refresh'};
const json=x=>new Response(JSON.stringify(x));
function environment(){const store=new Map();return {...credentials,NOTES:{store,writes:0,async get(k){return store.get(k)||null},async put(k,v){this.writes++;store.set(k,v)}}};}
const put=(e,k,v)=>e.NOTES.put(k,v);
const ok=async url=>json(url.includes('oauth2')?{access_token:'private-access'}:{kind:'drive#about'});
test('Drive probe reads minimal account metadata without files or credential storage',async()=>{
  const calls=[];
  const result=await probeDriveAccess(credentials,async(url,options)=>{calls.push({url,options});return ok(url);});
  assert.equal(result.outcome,'healthy');assert.equal(calls.length,2);
  assert.equal(calls[0].options.method,'POST');assert.equal(calls[1].options.method,undefined);
  assert.match(calls[1].url,/\/about\?fields=kind$/);assert.doesNotMatch(calls[1].url,/files/);
  for(const call of calls){assert.equal(call.options.redirect,'manual');assert.ok(call.options.signal instanceof AbortSignal);}
  assert.doesNotMatch(JSON.stringify(result),/private-/);assert.match(result.detail,/contents were read/);
});
test('missing credentials never make an outbound request or count as success',async()=>{
  const result=await probeDriveAccess({},async()=>{throw new Error('must not fetch')});
  assert.equal(result.outcome,'unknown');assert.equal(result.reason,'not_configured');
});
test('Drive authorization rejection is visible without leaking provider errors',async()=>{
  const result=await probeDriveAccess(credentials,async()=>new Response('private-refresh provider details',{status:400}));
  assert.equal(result.outcome,'failed');assert.match(result.detail,/HTTP 400/);assert.doesNotMatch(JSON.stringify(result),/private-refresh|provider details/);
});
test('Drive API rejection, invalid/oversized JSON and timeouts never turn green',async()=>{
  for(const response of [new Response('redirect',{status:302,headers:{location:'https://not-google.invalid'}}),new Response('private-error',{status:403}),json({kind:'not-drive'}),new Response('x'.repeat(17000)),new Response('not-json')]){
    const result=await probeDriveAccess(credentials,async url=>url.includes('oauth2')?json({access_token:'private-access'}):response);
    assert.equal(result.outcome,'failed');assert.doesNotMatch(JSON.stringify(result),/private-/);
  }
  const result=await probeDriveAccess(credentials,async()=>{throw new DOMException('private-timeout','TimeoutError')});
  assert.match(result.detail,/timed out/);assert.doesNotMatch(result.detail,/private/);
});
test('cloud probe is hourly, preserves failed-attempt throttling and last success, and adds no keys',async()=>{
  const e=environment();let calls=0;
  const fetch=async u=>{calls++;return ok(u)};
  await collectCloudHealth(e,put,now,fetch);assert.equal(calls,2);
  const later=new Date(now.getTime()+15*60000);
  await collectCloudHealth(e,put,later,fetch);assert.equal(calls,2);
  const failedAt=new Date(now.getTime()+3600000);
  const snapshot=await collectCloudHealth(e,put,failedAt,async()=>{calls++;return new Response('private',{status:401})});
  assert.equal(calls,3);assert.equal(snapshot.checks['drive-api'].outcome,'failed');
  assert.equal(snapshot.checks['drive-api'].last_success_at,now.toISOString());
  await collectCloudHealth(e,put,new Date(failedAt.getTime()+60000),fetch);assert.equal(calls,3);
  assert.deepEqual([...e.NOTES.store.keys()],[CLOUD_KEY]);assert.equal(e.NOTES.writes,4);
});
test('current Drive evidence expires and page reads never perform another probe',async()=>{
  const e=environment();await collectCloudHealth(e,put,now,ok);
  const writes=e.NOTES.writes;
  const v=await systemHealth(e,now);assert.equal(v.nodes.find(n=>n.id==='drive-api').status,'healthy');
  assert.equal((await systemHealth(e,new Date(now.getTime()+91*60000))).nodes.find(n=>n.id==='drive-api').status,'stale');
  assert.equal(e.NOTES.writes,writes);
});
test('historical checks never become live evidence or assistant heartbeat',async()=>{
  const v=await systemHealth(environment(),now);
  const gpts=v.nodes.filter(n=>n.id.startsWith('gpt-'));assert.equal(gpts.length,6);
  for(const n of [...gpts,v.nodes.find(n=>n.id==='codex'),v.nodes.find(n=>n.id==='knowledge')]){
    assert.equal(n.status,'unknown');assert.equal(n.last_attempt_at,null);assert.equal(n.last_success_at,null);
    assert.equal(n.kind,'unmonitored');assert.equal(n.manual_check.outcome,'passed');
    assert.equal(displayedState(n,now.getTime(),true),'unknown');
  }
  for(const n of gpts){assert.match(n.label,/ GPT$/);assert.match(n.scope,/not the eLC calendar/);}
  assert.equal(v.nodes.find(n=>n.id==='claude').manual_check,null);
  assert.equal(new Set(v.nodes.map(n=>n.id)).size,v.nodes.length,'every real service has one identity');
  const news=v.nodes.find(n=>n.id==='instructor-announcements');
  assert.ok(news);assert.equal(news.status,'unknown');assert.equal(news.last_attempt_at,null);
  assert.ok(v.edges.filter(e=>e.to.startsWith('gpt-')).every(e=>e.status==='unknown'));
});
test('labels distinguish historical, unmonitored, unconfigured, pending and measured checks',()=>{
  const html=systemHtml(),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const prefix=script.slice(0,script.indexOf('function select('));
  const context=vm.createContext({document:{getElementById:()=>null}});
  vm.runInContext(prefix+';this.label=statusLabel;',context);
  assert.match(context.label({manual_check:{outcome:'passed',tested_on:'2026-09-05'}},'unknown'),/Last tested/);
  assert.equal(context.label({kind:'unmonitored'},'unknown'),'Not monitored');
  assert.match(context.label({manual_check:{outcome:'failed',tested_on:'2026-09-05'}},'unknown'),/Test failed/);
  assert.equal(context.label({configured:false},'unknown'),'Not configured');
  assert.equal(context.label({},'unknown'),'Awaiting check');
  assert.equal(context.label({manual_check:{outcome:'passed',tested_on:'2026-09-05'}},'failed'),'Check failed');
  assert.match(html,/Connection checks, not submission verification/);
  assert.match(html,/NO LIVE RESULT/);assert.doesNotMatch(html,/>UNVERIFIED</);
  assert.doesNotMatch(script,/__name/);new vm.Script(script);
});

test('dated connection evidence preserves course versions and limited verification scope',async()=>{
  for(const course of ['BUSN5000','MGMT5560','MGMT5850','LAND2510','BUSN3040']) {
    const check=CONNECTION_EVIDENCE['gpt-'+course];
    assert.equal(check.tested_on,'2026-10-11');assert.match(check.detail,/1\.3\.0/);
    assert.match(check.detail,/not a heartbeat/);
  }
  assert.match(CONNECTION_EVIDENCE['gpt-MGMT4280'].detail,/1\.2\.2/);
  assert.equal(CONNECTION_EVIDENCE.codex.tested_at,'2026-10-12T04:45:59.194Z');
  assert.match(CONNECTION_EVIDENCE.codex.detail,/continuation token/);
  assert.match(CONNECTION_EVIDENCE.codex.detail,/oversize and trimmed/);
  assert.match(CONNECTION_EVIDENCE.knowledge.detail,/selected bundle only/);
  assert.match(CONNECTION_EVIDENCE.knowledge.detail,/not a current six-course inventory/);
  assert.equal(CONNECTION_EVIDENCE.chrome.tested_on,'2026-09-05');
  assert.equal(CONNECTION_EVIDENCE.assistant.tested_on,'2026-10-12');
  assert.equal(CONNECTION_EVIDENCE.assistant.outcome,'failed');
  assert.match(CONNECTION_EVIDENCE.assistant.detail,/insufficient Anthropic account credit/);
  assert.match(CONNECTION_EVIDENCE.assistant.detail,/configured credential does not establish/);
  const result=await systemHealth(environment(),new Date('2026-10-12T05:00:00Z'));
  for(const id of ['codex','knowledge',...['BUSN5000','MGMT4280','MGMT5560','MGMT5850','LAND2510','BUSN3040'].map(c=>'gpt-'+c)]) {
    const node=result.nodes.find(n=>n.id===id);
    assert.equal(node.status,'unknown');assert.equal(node.last_attempt_at,null);assert.equal(node.last_success_at,null);
  }
  const assistant=result.nodes.find(n=>n.id==='assistant');
  assert.equal(assistant.status,'unknown');assert.equal(assistant.manual_check.outcome,'failed');
  assert.equal(assistant.last_attempt_at,null);assert.equal(assistant.last_success_at,null);
});
