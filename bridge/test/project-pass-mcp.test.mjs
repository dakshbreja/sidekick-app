import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sqliteFoundation} from './sqlite-fixture.js';
import {digest} from '../src/foundation.js';
import {executeProjectPassTool} from '../src/project-pass-tools.js';
import {PROJECT_CLIENT_TOOLS,PROJECT_OPENAPI,APPROVED_PROJECT_IDS,authenticateProjectClient} from '../src/project-pass-mcp.js';
import worker from '../src/worker.js';

const ORIGIN='https://bridge.test';
const nonce=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
async function fixture(t) {
  const f=sqliteFoundation();t.after(()=>f.close());const env={API_KEY:'synthetic-owner-key',BRIDGE_STATE:f.binding};
  for(const id of [...APPROVED_PROJECT_IDS,'other-project'])await executeProjectPassTool('register_pass_project',{project_id:id,name:'Synthetic '+id},env,{owner:true});
  const cookie='a'.repeat(64);await f.stub.session('create',{hash:await digest(cookie),expires:Date.now()+60*86400000,epoch:await digest('session-epoch:'+env.API_KEY)});
  const owner=async(path,body,method=body===undefined?'GET':'POST')=>worker.fetch(new Request(ORIGIN+path,{method,
    headers:{Cookie:'__Host-bridge_session='+cookie,Origin:ORIGIN,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),env);
  const grant=async(client='claude',request_id=nonce(1),project_ids=[...APPROVED_PROJECT_IDS])=>{
    const response=await owner('/pass/projects/connection/grant',{client,request_id,project_ids});return {status:response.status,...await response.json()};};
  return {...f,env,cookie,owner,grant};
}
const action=(env,key,name,args)=>worker.fetch(new Request(ORIGIN+'/pass/projects/client/tools/'+name,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(args)}),env);
const rpc=(env,key,method,params={})=>worker.fetch(new Request(ORIGIN+'/mcp/projects',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),env);
const packet=(project_id,extra={})=>({project_id,sandbox:true,session_id:'synthetic-chat',date:'2026-11-02',title:'Synthetic project connection test',
  goal:'Verify shared factual handoff transport; no actual project work.',recorded_by:'Synthetic ChatGPT',expected_revision:0,expected_head_revision:0,idempotency_key:'synthetic-chat',
  facts:[{kind:'observation',basis:'observed',text:'This is a synthetic connection test only; no real work occurred.',source:'Explicit isolated fixture'}],...extra});

test('project grants require the owner browser session and only the exact approved projects/clients for 30 days',async t=>{
  const f=await fixture(t);
  const unauth=await worker.fetch(new Request(ORIGIN+'/pass/projects/connection/list'),f.env);assert.equal(unauth.status,401);
  const broad=await worker.fetch(new Request(ORIGIN+'/pass/projects/connection/list',{headers:{Authorization:'Bearer '+f.env.API_KEY}}),f.env);assert.equal(broad.status,403);
  const body={client:'claude',request_id:nonce(1),project_ids:[...APPROVED_PROJECT_IDS]};
  for(const invalid of [{...body,project_ids:['other-project']},{...body,project_ids:['*']},{...body,project_ids:['instinct','instinct']},
    {...body,scopes:['school.materials:read']},{...body,expires:Date.now()+1e15},{...body,client:'unknown'}])assert.equal((await f.owner('/pass/projects/connection/grant',invalid)).status,400);
  const before=Date.now(),grant=await f.grant();assert.equal(grant.status,200);assert.equal(grant.active,true);
  assert.deepEqual(grant.project_ids,['instinct','job-search-planning']);assert.deepEqual(grant.scopes,['project.pass:read','project.pass:write']);
  assert.ok(Date.parse(grant.expires_at)>=before+30*86400000&&Date.parse(grant.expires_at)<=Date.now()+30*86400000);
  assert.match(grant.access_token,/^pp1_[a-f0-9]{64}$/);assert.equal(grant.grant_id,await digest(grant.access_token));
  const persisted=f.db.prepare('SELECT * FROM project_pass_grants').all();assert.equal(persisted.length,1);assert.equal(JSON.stringify(persisted).includes(grant.access_token),false);
});

test('a scoped project client cannot access school, owner/grant/project administration, arbitrary projects or generic tools',async t=>{
  const f=await fixture(t),grant=await f.grant('claude',nonce(2),['instinct']),key=grant.access_token;
  for(const path of ['/status','/learning?course=BUSN5000&term_id=fall-2026','/pass/protocol','/pass/projects/connection/list'])
    assert.equal((await worker.fetch(new Request(ORIGIN+path,{headers:{Authorization:'Bearer '+key}}),f.env)).status,401,path);
  for(const path of ['/pass/connection/grant','/pass/projects/tools/register_pass_project','/pass/projects/connection/grant'])
    assert.equal((await worker.fetch(new Request(ORIGIN+path,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:'{}'}),f.env)).status,401,path);
  const projects=await (await action(f.env,key,'list_pass_projects',{})).json();assert.deepEqual(projects.projects.map(p=>p.project_id),['instinct']);
  assert.equal((await action(f.env,key,'resume_project_pass',{project_id:'job-search-planning'})).status,403);
  assert.equal((await action(f.env,key,'read_project_pass',{project_id:'other-project',record_id:'unknown'})).status,403);
  assert.equal((await action(f.env,key,'register_pass_project',{project_id:'instinct',name:'Other'})).status,404);
  assert.ok((await (await rpc(f.env,key,'tools/call',{name:'fetch_url',arguments:{url:'https://example.invalid'}})).json()).error);
  assert.ok((await (await rpc(f.env,key,'tools/call',{name:'register_pass_project',arguments:{project_id:'instinct',name:'Other'}})).json()).error);
});

test('existing legitimate school grant and broad owner key cannot become project clients; project key is not a browser session',async t=>{
  const f=await fixture(t),grant=await f.grant();
  const schoolResponse=await worker.fetch(new Request(ORIGIN+'/pass/connection/grant',{method:'POST',headers:{Authorization:'Bearer '+f.env.API_KEY,'Content-Type':'application/json'},body:JSON.stringify({client:'claude',request_id:nonce(10)})}),f.env);
  const school=await schoolResponse.json();assert.equal(school.ok,true);
  for(const key of [school.access_token,f.env.API_KEY])assert.equal((await rpc(f.env,key,'tools/list')).status,401);
  assert.equal((await worker.fetch(new Request(ORIGIN+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+grant.access_token,'Content-Type':'application/json'},body:'{}'}),f.env)).status,401);
  assert.equal((await worker.fetch(new Request(ORIGIN+'/pass/projects/connection/list',{headers:{Cookie:'__Host-bridge_session='+grant.access_token}}),f.env)).status,401);
  const status=await worker.fetch(new Request(ORIGIN+'/pass/connection/status?grant_id='+school.grant_id,{headers:{Authorization:'Bearer '+f.env.API_KEY}}),f.env);
  assert.equal((await status.json()).active,true);
});

test('native project MCP and Action schema expose only seven bounded handoff tools',async t=>{
  const f=await fixture(t),grant=await f.grant();
  const init=await (await rpc(f.env,grant.access_token,'initialize',{protocolVersion:'2025-11-25'})).json();assert.equal(init.result.serverInfo.name,'sidekick-project-pass');
  const future=await (await rpc(f.env,grant.access_token,'initialize',{protocolVersion:'2026-01-01'})).json();assert.equal(future.result.protocolVersion,'2025-11-25');
  const list=await (await rpc(f.env,grant.access_token,'tools/list')).json();assert.equal(list.result.tools.length,7);
  assert.deepEqual(list.result.tools.map(t=>t.name),PROJECT_CLIENT_TOOLS.map(t=>t.name));assert.equal(list.result.tools.some(t=>t.name==='register_pass_project'),false);
  const schema=await (await worker.fetch(new Request(ORIGIN+'/pass/projects/openapi'),f.env)).json();assert.deepEqual(schema,PROJECT_OPENAPI);
  assert.equal(Object.keys(schema.paths).length,7);assert.equal(schema.paths['/pass/projects/client/tools/save_project_pass'].post['x-openai-isConsequential'],true);
  assert.deepEqual(schema.security,[{projectBearer:[]}]);
});

test('ChatGPT Actions to Claude MCP and reverse save/readback works independently in both approved projects',async t=>{
  const f=await fixture(t),chat=await f.grant('chatgpt',nonce(20)),claude=await f.grant('claude',nonce(21)),before=f.store.health();
  for(const id of APPROVED_PROJECT_IDS) {
    const first=await (await action(f.env,chat.access_token,'save_project_pass',packet(id))).json();assert.equal(first.save_confirmation,'confirmed');
    const read=await (await rpc(f.env,claude.access_token,'tools/call',{name:'read_project_pass',arguments:{project_id:id,sandbox:true,record_id:first.recorded.record_id}})).json();
    assert.deepEqual(read.result.structuredContent.record,first.recorded);
    const args=packet(id,{session_id:'synthetic-claude',idempotency_key:'synthetic-claude',recorded_by:'Synthetic Claude',expected_head_revision:1,prior_handoffs:[{record_id:first.recorded.record_id,revision:1}]});
    const reverse=await (await rpc(f.env,claude.access_token,'tools/call',{name:'save_project_pass',arguments:args})).json();assert.equal(reverse.result.structuredContent.save_confirmation,'confirmed');
    const record=reverse.result.structuredContent.recorded;
    const chatRead=await (await action(f.env,chat.access_token,'read_project_pass',{project_id:id,sandbox:true,record_id:record.record_id})).json();assert.deepEqual(chatRead.record,record);
    const replay=await (await action(f.env,chat.access_token,'save_project_pass',packet(id))).json();assert.equal(replay.replayed,true);
    const history=await (await action(f.env,chat.access_token,'project_pass_history',{project_id:id,sandbox:true,record_id:first.recorded.record_id})).json();assert.equal(history.history.length,1);
    assert.equal((await (await action(f.env,chat.access_token,'list_project_passes',{project_id:id})).json()).records.length,0);
  }
  assert.deepEqual(f.store.health(),before);assert.deepEqual(f.store.passRead().records,[]);
});

test('project grant retries preserve key/expiry; changed, expired, revoked and rotated requests cannot silently expand or renew',async t=>{
  const f=await fixture(t),initial=await f.grant('claude',nonce(30));f.advance(3600000);
  const retry=await f.grant('claude',nonce(30));assert.equal(retry.replayed,true);assert.equal(retry.access_token,initial.access_token);assert.equal(retry.expires_at,initial.expires_at);
  assert.equal((await f.grant('claude',nonce(30),['instinct'])).error,'project_connection_request_conflict');
  assert.equal((await f.owner('/pass/projects/connection/revoke',{grant_id:initial.grant_id})).status,200);
  assert.equal((await action(f.env,initial.access_token,'list_pass_projects',{})).status,401);
  assert.equal((await f.grant('claude',nonce(30))).error,'project_connection_request_retired');
  const expiring=await f.grant('chatgpt',nonce(31));f.advance(31*86400000);assert.equal((await action(f.env,expiring.access_token,'list_pass_projects',{})).status,401);
  assert.equal((await f.grant('chatgpt',nonce(31))).error,'project_connection_request_retired');
  const metadata=await (await f.owner('/pass/projects/connection/list')).json();assert.equal(metadata.grants.length,2);assert.ok(metadata.grants.every(g=>!g.active));
  const check=await authenticateProjectClient(new Request(ORIGIN,{headers:{Authorization:'Bearer '+expiring.access_token}}),{...f.env,API_KEY:'rotated-synthetic-owner'});assert.equal(check,null);
});

test('project transport and administration reject foreign origins, malformed packets, protocol mismatches and secrets',async t=>{
  const f=await fixture(t),grant=await f.grant();
  const foreign=await worker.fetch(new Request(ORIGIN+'/mcp/projects',{method:'POST',headers:{Authorization:'Bearer '+grant.access_token,Origin:'https://foreign.invalid','Content-Type':'application/json'},body:'{}'}),f.env);assert.equal(foreign.status,403);
  const missingOrigin=await worker.fetch(new Request(ORIGIN+'/pass/projects/connection/grant',{method:'POST',headers:{Cookie:'__Host-bridge_session='+f.cookie,'Content-Type':'application/json'},body:'{}'}),f.env);assert.equal(missingOrigin.status,403);
  for(const params of [{jsonrpc:'1',id:1,method:'tools/list'},{jsonrpc:'2.0',id:1,method:'initialize',params:{}},
    {jsonrpc:'2.0',id:1,method:'tools/list',params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2025-03-26'}}}]) {
    const r=await worker.fetch(new Request(ORIGIN+'/mcp/projects',{method:'POST',headers:{Authorization:'Bearer '+grant.access_token,'Content-Type':'application/json','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify(params)}),f.env);assert.equal(r.status,400);
  }
  const args=packet('instinct',{facts:[{kind:'observation',basis:'observed',text:'pp1_'+'1'.repeat(64),source:'Synthetic rejected fixture'}]});
  assert.equal((await (await action(f.env,grant.access_token,'save_project_pass',args)).json()).error,'restricted_project_pass_content');
});
