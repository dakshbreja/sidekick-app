import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sqliteFoundation} from './sqlite-fixture.js';
import {digest} from '../src/foundation.js';
import {MCP_SCOPES,MCP_GRANT_DAYS} from '../src/pass-mcp.js';
import {PASS_PROTOCOL_RECORD_ID} from '../src/record-store.js';
import worker from '../src/worker.js';

function fixture(t) {const f=sqliteFoundation();t.after(()=>f.close());return {...f,env:{API_KEY:'synthetic-owner-key',BRIDGE_STATE:f.binding}};}
const ownerRequest=(path,env,{method='POST',body,headers={}}={})=>new Request('https://bridge.test'+path,{method,headers:{Authorization:'Bearer '+env.API_KEY,'Content-Type':'application/json',...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
async function grant(env,request_id=crypto.randomUUID()) {
  const response=await worker.fetch(ownerRequest('/pass/connection/grant',env,{body:{client:'claude',request_id}}),env);
  assert.equal(response.status,200);return response.json();
}
function request(message,token,extra={}) {
  return new Request('https://bridge.test/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(extra.headers||{})},body:JSON.stringify(message),...extra});
}
const message=(method,params={})=>({jsonrpc:'2.0',id:1,method,params});
const tool=(name,args={})=>message('tools/call',{name,arguments:args});
async function invoke(env,token,name,args={}) {const response=await worker.fetch(request(tool(name,args),token),env);assert.equal(response.status,200);const out=await response.json();return out.result;}
const packet=(extra={})=>({course:'BUSN5000',session_id:'remote-fixture',date:'2026-10-31',title:'BUSN5000 remote fixture',goal:'Verify the original PASS connection.',recorded_by:'Synthetic remote fixture',
  facts:[{basis:'observed',text:'This is synthetic connection evidence; no student work is asserted.',source:'Remote MCP test fixture'}],next_step:'Read the exact saved record.',expected_revision:0,idempotency_key:'remote-fixture-operation',sandbox:true,...extra});

test('remote MCP requires its scoped grant and rejects the broad owner key and anonymous access',async t=>{
  const f=fixture(t);
  for(const token of ['',f.env.API_KEY,'sp1_'+'0'.repeat(64)]) {
    const response=await worker.fetch(request(message('tools/list'),token),f.env);assert.equal(response.status,401);
    assert.match(response.headers.get('www-authenticate'),/Original Sidekick PASS/);
  }
  assert.deepEqual(f.store.health().counts,[]);
});

test('owner-issued Claude grant stores only its digest and uses existing revocable session storage',async t=>{
  const f=fixture(t),before=Date.now(),g=await grant(f.env);
  assert.match(g.access_token,/^sp1_[a-f0-9]{64}$/);assert.notEqual(g.access_token,f.env.API_KEY);
  assert.deepEqual(g.scopes,MCP_SCOPES);assert.equal(g.client,'claude');assert.equal(g.endpoint,'https://bridge.test/mcp');
  assert.ok(Date.parse(g.expires_at)>=before+MCP_GRANT_DAYS*86400000);
  const rows=f.storage.sql.exec('SELECT * FROM sessions').toArray();assert.equal(rows.length,1);
  assert.equal(rows[0].token_hash,await digest(g.access_token));assert.ok(!JSON.stringify(rows).includes(g.access_token));
  assert.ok(!JSON.stringify(rows).includes(f.env.API_KEY));assert.deepEqual(f.store.health().counts,[]);
  const status=await (await worker.fetch(ownerRequest('/pass/connection/status?grant_id='+g.grant_id,f.env,{method:'GET'}),f.env)).json();assert.equal(status.active,true);
});

test('scoped token cannot call owner APIs, broaden scopes, create grants or write other school records',async t=>{
  const f=fixture(t),g=await grant(f.env);
  for(const path of ['/pass/connection/grant','/pass/connection/revoke','/progress','/learning','/library/text','/classnote','/note','/foundation/migration/start']) {
    const response=await worker.fetch(new Request('https://bridge.test'+path,{method:'POST',headers:{Authorization:'Bearer '+g.access_token,'Content-Type':'application/json'},body:'{}'}),f.env);
    assert.equal(response.status,401,path);
  }
  for(const body of [{client:'gemini'},{client:'claude',scopes:['owner']},{client:'claude',days:365}]) {
    const response=await worker.fetch(ownerRequest('/pass/connection/grant',f.env,{body}),f.env);assert.equal(response.status,400);
  }
  assert.equal(f.storage.sql.exec('SELECT count(*) AS n FROM sessions').toArray()[0].n,1);
  assert.deepEqual(f.store.health().counts,[]);
});

test('scoped token cannot be reused as a browser session and owner session does not authorize MCP',async t=>{
  const f=fixture(t),g=await grant(f.env);
  const cookie='__Host-bridge_session='+g.access_token;
  const response=await worker.fetch(new Request('https://bridge.test/pass',{headers:{Cookie:cookie}}),f.env);assert.equal(response.status,401);
  const browserToken='a'.repeat(64);
  await f.stub.session('create',{hash:await digest(browserToken),expires:Date.now()+100000,epoch:await digest('session-epoch:'+f.env.API_KEY)});
  const mcp=await worker.fetch(new Request('https://bridge.test/mcp',{method:'POST',headers:{Cookie:'__Host-bridge_session='+browserToken,'Content-Type':'application/json'},body:JSON.stringify(message('tools/list'))}),f.env);
  assert.equal(mcp.status,401);
});

test('remote initialization and discovery identify original Sidekick and expose exactly bounded tools',async t=>{
  const f=fixture(t),g=await grant(f.env);
  const initialized=await (await worker.fetch(request(message('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'Synthetic client',version:'1'}}),g.access_token),f.env)).json();
  assert.equal(initialized.result.serverInfo.name,'sidekick-original-pass');assert.equal(initialized.result.protocolVersion,'2025-11-25');
  const discovery=await (await worker.fetch(request(message('server/discover'),g.access_token),f.env)).json();assert.ok(discovery.result.supportedVersions.includes('2025-11-25'));
  const listed=await (await worker.fetch(request(message('tools/list'),g.access_token),f.env)).json();
  assert.deepEqual(listed.result.tools.map(t=>t.name),['get_pass_protocol','list_passes','read_pass','resume_pass','save_pass','search_school_materials','read_school_material']);
  assert.equal(listed.result.tools.filter(t=>t.annotations.readOnlyHint===false).length,1);
  assert.ok(listed.result.tools.every(t=>t.annotations.destructiveHint===false));
  for(const name of ['mark_progress','recordProgress','updateLearningRecord','delete','share','submit_assignment']) {
    const result=await (await worker.fetch(request(tool(name),g.access_token),f.env)).json();assert.equal(result.error.code,-32602);
  }
});

test('remote read/save/replay/fresh resume preserve original study and lecture state',async t=>{
  const f=fixture(t),g=await grant(f.env),learning=f.learningStore.get('BUSN5000','fall-2026',false);
  const first=await invoke(f.env,g.access_token,'save_pass',packet());assert.equal(first.isError,false);assert.equal(first.structuredContent.save_confirmation,'confirmed');
  const row=first.structuredContent.recorded;
  const replay=await invoke(f.env,g.access_token,'save_pass',packet());assert.equal(replay.structuredContent.replayed,true);
  const resumed=await invoke(f.env,g.access_token,'resume_pass',{course:'BUSN5000',sandbox:true});assert.deepEqual(resumed.structuredContent.record,row);
  const exact=await invoke(f.env,g.access_token,'read_pass',{course:'BUSN5000',sandbox:true,record_id:row.record_id});assert.deepEqual(exact.structuredContent.record,row);
  const normal=await invoke(f.env,g.access_token,'list_passes');assert.deepEqual(normal.structuredContent.records,[]);
  assert.equal(f.store.history(row.record_id).history.length,1);assert.deepEqual(f.store.list('classnote',['BUSN5000']).records,[]);
  assert.deepEqual(f.store.list('progress',['BUSN5000']).records,[]);assert.deepEqual(f.learningStore.get('BUSN5000','fall-2026',false),learning);
  assert.deepEqual(JSON.parse(first.content[0].text),first.structuredContent);
});

test('remote correction requires the exact session revision and unchanged operation packets',async t=>{
  const f=fixture(t),g=await grant(f.env),first=await invoke(f.env,g.access_token,'save_pass',packet()),row=first.structuredContent.recorded;
  const changed=await invoke(f.env,g.access_token,'save_pass',packet({next_step:'Different action.'}));assert.equal(changed.structuredContent.error,'idempotency_conflict');
  const args=packet({record_id:row.record_id,expected_revision:1,idempotency_key:'remote-correction',next_step:'Check the exact record ID.'});
  const corrected=await invoke(f.env,g.access_token,'save_pass',args);assert.equal(corrected.structuredContent.revision,2);
  const stale=await invoke(f.env,g.access_token,'save_pass',{...args,idempotency_key:'stale'});assert.equal(stale.structuredContent.error,'revision_conflict');
  const replay=await invoke(f.env,g.access_token,'save_pass',args);assert.equal(replay.structuredContent.replayed,true);assert.equal(f.store.history(row.record_id).history.length,2);
});

test('remote PASS cannot overwrite the protocol or ordinary source lecture',async t=>{
  const f=fixture(t),g=await grant(f.env);
  for(const id of ['ordinary',PASS_PROTOCOL_RECORD_ID]) {
    f.store.mutate({kind:'classnote',course:'BUSN5000',body:{session_id:'source-'+id,title:'Original',date:'2026-10-31',text:'Original source'},new_record_id:id,operation_id:'create-'+id,fingerprint:id,at:'2026-10-31T00:00:00.000Z',at_local:'Fixture'});
    const out=await invoke(f.env,g.access_token,'save_pass',packet({record_id:id,expected_revision:1}));assert.equal(out.isError,true);assert.equal(out.structuredContent.error,'pass_not_found');
    assert.equal(f.store.history(id).history.length,1);
  }
  const protocol=await invoke(f.env,g.access_token,'get_pass_protocol');assert.equal(protocol.isError,false);assert.equal(protocol.structuredContent.record.record_id,PASS_PROTOCOL_RECORD_ID);
});

test('remote grant expires, revokes and becomes invalid after owner credential rotation',async t=>{
  const f=fixture(t),g=await grant(f.env);
  const revoked=await worker.fetch(ownerRequest('/pass/connection/revoke',f.env,{body:{grant_id:g.grant_id}}),f.env);assert.equal(revoked.status,200);
  assert.equal((await worker.fetch(request(message('tools/list'),g.access_token),f.env)).status,401);
  const second=await grant(f.env);f.advance((MCP_GRANT_DAYS+1)*86400000);
  assert.equal((await worker.fetch(request(message('tools/list'),second.access_token),f.env)).status,401);
  const fresh=fixture(t),third=await grant(fresh.env);fresh.env.API_KEY='rotated-synthetic-owner-key';
  assert.equal((await worker.fetch(request(message('tools/list'),third.access_token),fresh.env)).status,401);
});

test('grant retries preserve token/expiry and a revoked request cannot be reactivated by replay or browser logout',async t=>{
  const f=fixture(t),id=crypto.randomUUID(),first=await grant(f.env,id);f.advance(1000);
  const again=await grant(f.env,id);assert.equal(again.replayed,true);assert.equal(again.access_token,first.access_token);assert.equal(again.expires_at,first.expires_at);
  await worker.fetch(ownerRequest('/pass/connection/revoke',f.env,{body:{grant_id:first.grant_id}}),f.env);
  const signout=await worker.fetch(new Request('https://bridge.test/app/sign-out',{method:'POST',headers:{Origin:'https://bridge.test',Cookie:'__Host-bridge_session='+first.access_token}}),f.env);assert.equal(signout.status,303);
  await f.stub.session('create',{hash:'synthetic-browser-hash',expires:Date.now()+100000,epoch:'synthetic-browser-epoch'});
  const retired=await worker.fetch(ownerRequest('/pass/connection/grant',f.env,{body:{client:'claude',request_id:id}}),f.env);assert.equal(retired.status,409);
  assert.equal((await retired.json()).error,'connection_request_retired');
  assert.equal((await worker.fetch(request(message('tools/list'),first.access_token),f.env)).status,401);
});

test('remote transport rejects foreign origins, malformed packets and unbounded bodies',async t=>{
  const f=fixture(t),g=await grant(f.env);
  const foreign=await worker.fetch(request(message('tools/list'),g.access_token,{headers:{Authorization:'Bearer '+g.access_token,'Content-Type':'application/json',Origin:'https://foreign.invalid'}}),f.env);assert.equal(foreign.status,403);
  const bad=await worker.fetch(new Request('https://bridge.test/mcp',{method:'POST',headers:{Authorization:'Bearer '+g.access_token,'Content-Type':'application/json'},body:' '.repeat(40001)}),f.env);assert.equal(bad.status,413);
  for(const value of [{id:1,method:'tools/list'},message('tools/list',[]),{...message('tools/list'),id:null}]) {
    const response=await worker.fetch(request(value,g.access_token),f.env);assert.equal(response.status,400);
  }
  const wrongVersion=await worker.fetch(request(message('tools/list'),g.access_token,{headers:{Authorization:'Bearer '+g.access_token,'Content-Type':'application/json','MCP-Protocol-Version':'2026-07-28'}}),f.env);
  assert.equal(wrongVersion.status,400);assert.equal((await wrongVersion.json()).error.code,-32022);
  assert.equal((await worker.fetch(new Request('https://bridge.test/mcp',{headers:{Authorization:'Bearer '+g.access_token}}),f.env)).status,405);
  const notification=await worker.fetch(request({jsonrpc:'2.0',method:'notifications/initialized'},g.access_token),f.env);assert.equal(notification.status,202);assert.equal(await notification.text(),'');
});

test('remote source errors and lost readback remain errors rather than empty successful memory',async t=>{
  const f=fixture(t),g=await grant(f.env);f.stub.passRead=async()=>{throw Error('synthetic unavailable');};
  const read=await invoke(f.env,g.access_token,'list_passes');assert.equal(read.isError,true);assert.equal(read.structuredContent.error,'pass_unavailable');
  const material=await invoke(f.env,g.access_token,'search_school_materials',{course:'BUSN5000'});assert.equal(material.isError,true);assert.equal(material.structuredContent.error,'school_materials_unavailable');
});
