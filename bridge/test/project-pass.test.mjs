import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sqliteFoundation} from './sqlite-fixture.js';
import {executeProjectPassTool,projectPassRoutes} from '../src/project-pass-tools.js';
import {MCP_SCOPES} from '../src/pass-mcp.js';
import worker from '../src/worker.js';

const owner={owner:true};
const acl=(ids,write=true)=>({project_ids:ids,scopes:['project.pass:read',...(write?['project.pass:write']:[])]});
const packet=(extra={})=>({project_id:'sandbox-a',session_id:'synthetic-session',sandbox:true,date:'2026-11-02',title:'Synthetic connection checkpoint',
  goal:'Verify isolated handoff continuity.',recorded_by:'Synthetic fixture',expected_revision:0,expected_head_revision:0,idempotency_key:'test-save',
  facts:[{kind:'observation',basis:'observed',text:'This is a synthetic test only; no project work occurred.',source:'Explicit isolated fixture'}],...extra});
async function fixture(t) {
  const f=sqliteFoundation();t.after(()=>f.close());
  const env={API_KEY:'synthetic-owner-key',BRIDGE_STATE:f.binding};
  const call=(name,args={},access=owner)=>executeProjectPassTool(name,args,env,access);
  for(const project_id of ['sandbox-a','sandbox-b'])assert.equal((await call('register_pass_project',{project_id,name:'Synthetic '+project_id})).ok,true);
  return {...f,env,call};
}

test('project registry starts empty; exact owner registration grants no limited client access',async t=>{
  const f=sqliteFoundation();t.after(()=>f.close());const env={BRIDGE_STATE:f.binding};
  const call=(name,args,access)=>executeProjectPassTool(name,args,env,access);
  assert.deepEqual((await call('list_pass_projects',{},owner)).projects,[]);
  assert.equal((await call('register_pass_project',{project_id:'sandbox-a',name:'Fixture'},acl(['sandbox-a']))).error,'project_access_denied');
  assert.equal((await call('register_pass_project',{project_id:'sandbox-a',name:'Fixture'},owner)).ok,true);
  assert.equal((await call('register_pass_project',{project_id:'sandbox-a',name:'Fixture'},owner)).replayed,true);
  assert.equal((await call('register_pass_project',{project_id:'sandbox-a',name:'Different'},owner)).error,'project_already_registered');
  for(const id of ['GENERAL','BUSN5000','../sandbox-a','all','*']) {
    const r=await call('get_project_pass_protocol',{project_id:id},acl(['sandbox-a']));assert.equal(r.error,'project_access_denied');
  }
  assert.deepEqual((await call('list_pass_projects',{},acl(['sandbox-b']))).projects,[]);
});

test('project saves have matching receipt/readback, stable replay, revision history and separate interpretations',async t=>{
  const {call}=await fixture(t),args=packet({interpretations:[{text:'A proposed explanation, not an observed result.',source:'Synthetic assistant interpretation'}]});
  const first=await call('save_project_pass',args,acl(['sandbox-a']));
  assert.equal(first.save_confirmation,'confirmed');assert.deepEqual(first.readback,first.recorded);
  const retry=await call('save_project_pass',args,acl(['sandbox-a']));assert.equal(retry.replayed,true);assert.equal(retry.recorded.record_id,first.recorded.record_id);
  assert.equal((await call('save_project_pass',{...args,title:'Changed'},acl(['sandbox-a']))).error,'idempotency_conflict');
  const next={...args,record_id:first.recorded.record_id,expected_revision:1,expected_head_revision:1,idempotency_key:'correction',title:'Synthetic correction'};
  const second=await call('save_project_pass',next);assert.equal(second.revision,2);assert.equal(second.recorded.base_revision,1);
  const history=await call('project_pass_history',{project_id:'sandbox-a',sandbox:true,record_id:first.recorded.record_id});
  assert.equal(history.history.length,2);assert.equal(history.history[1].before.title,args.title);
  assert.equal(history.history[1].after.interpretations[0].text,args.interpretations[0].text);
  assert.equal((await call('save_project_pass',args)).error,'project_pass_readback_changed');
  assert.equal((await call('project_pass_history',{project_id:'sandbox-a',sandbox:true,record_id:first.recorded.record_id})).history.length,2);
});

test('every exact-ID read, write, resume, protocol and history enforces project ACL and sandbox scope',async t=>{
  const {call}=await fixture(t),first=await call('save_project_pass',packet());
  for(const name of ['read_project_pass','project_pass_history']) {
    const args={project_id:'sandbox-a',sandbox:true,record_id:first.recorded.record_id};
    assert.equal((await call(name,args,acl(['sandbox-b']))).error,'project_access_denied');
    assert.equal((await call(name,{...args,project_id:'sandbox-b'},acl(['sandbox-b']))).error,'project_pass_not_found');
    assert.equal((await call(name,{...args,sandbox:false})).error,'project_pass_not_found');
  }
  for(const name of ['resume_project_pass','list_project_passes','get_project_pass_protocol'])
    assert.equal((await call(name,{project_id:'sandbox-a'},acl(['sandbox-b']))).error,'project_access_denied');
  assert.equal((await call('save_project_pass',packet(),acl(['sandbox-a'],false))).error,'project_access_denied');
  assert.deepEqual((await call('list_pass_projects',{},acl(['sandbox-b']))).projects.map(p=>p.project_id),['sandbox-b']);
  assert.equal((await call('resume_project_pass',{project_id:'sandbox-a'})).error,'project_pass_not_found');
  assert.equal((await call('resume_project_pass',{project_id:'sandbox-a',sandbox:true})).record.record_id,first.recorded.record_id);
});

test('project head prevents silent concurrent current-state loss across distinct sessions; explicit reconciliation preserves both',async t=>{
  const {call}=await fixture(t);
  const results=await Promise.all(['one','two'].map(id=>call('save_project_pass',packet({session_id:id,idempotency_key:id}))));
  const good=results.find(r=>r.ok),conflict=results.find(r=>r.error);
  assert.ok(good);assert.equal(conflict.error,'project_head_conflict');assert.equal(conflict.current_head_revision,1);
  const fresh=await call('list_project_passes',{project_id:'sandbox-a',sandbox:true});assert.equal(fresh.head_revision,1);
  const reconciled=await call('save_project_pass',{...conflict.retry_arguments,expected_head_revision:fresh.head_revision,idempotency_key:'reconciled',prior_handoffs:[{record_id:good.recorded.record_id,revision:1}]});
  assert.equal(reconciled.save_confirmation,'confirmed');assert.equal(reconciled.head_revision,2);
  assert.equal((await call('list_project_passes',{project_id:'sandbox-a',sandbox:true})).records.length,2);
});

test('project receipt keys, heads and sessions are isolated by project and test scope; bounded pagination retains old handoffs',async t=>{
  const {call}=await fixture(t);
  for(const args of [packet(),packet({project_id:'sandbox-b'}),packet({sandbox:false})])assert.equal((await call('save_project_pass',args)).save_confirmation,'confirmed');
  for(let n=1;n<=21;n++)assert.equal((await call('save_project_pass',packet({session_id:'session-'+n,idempotency_key:'save-'+n,expected_head_revision:n}))).ok,true);
  const first=await call('list_project_passes',{project_id:'sandbox-a',sandbox:true,limit:20});assert.equal(first.records.length,20);assert.ok(first.next_cursor);
  const rest=await call('list_project_passes',{project_id:'sandbox-a',sandbox:true,cursor:first.next_cursor,limit:20});assert.equal(rest.records.length,2);assert.equal(rest.next_cursor,null);
  const ids=[...first.records,...rest.records].map(r=>r.record_id);assert.equal(new Set(ids).size,22);
  assert.equal((await call('list_project_passes',{project_id:'sandbox-a'})).records.length,1);
});

test('project writes reject invalid/subjective/restricted facts and cross-project or unobserved predecessor references',async t=>{
  const {call}=await fixture(t),b=await call('save_project_pass',packet({project_id:'sandbox-b'}));
  assert.equal((await call('save_project_pass',packet({prior_handoffs:[{record_id:b.recorded.record_id,revision:1}]}))).error,'referenced_handoff_not_found');
  for(const extra of [{date:'2026-02-30'},{course:'BUSN5000'},{project_id:'../secret'},{expected_revision:1},{facts:[]},
    {facts:[{kind:'observation',basis:'inferred',text:'Guess',source:'Fixture'}]},
    {facts:[{kind:'observation',basis:'observed',text:'The learner mastered this.',source:'Fixture'}]},
    {facts:[{kind:'observation',basis:'observed',text:'Bearer synthetic-private-value',source:'Fixture'}]}])
    assert.ok((await call('save_project_pass',packet(extra))).error);
  assert.deepEqual((await call('list_project_passes',{project_id:'sandbox-a',sandbox:true})).records,[]);
});

test('transaction failure rolls back record, history, head and receipt; uncertain readback retries never duplicate',async t=>{
  const f=await fixture(t),exec=f.storage.sql.exec;
  f.storage.sql.exec=(query,...args)=>{if(query.startsWith('INSERT INTO project_pass_history'))throw Error('Synthetic history failure');return exec(query,...args);};
  assert.equal((await f.call('save_project_pass',packet())).error,'project_pass_write_unconfirmed');f.storage.sql.exec=exec;
  assert.equal(f.projectPassStore.head('sandbox-a',true),0);assert.deepEqual((await f.call('list_project_passes',{project_id:'sandbox-a',sandbox:true})).records,[]);
  const original=f.stub.projectPass;let once=true;
  f.stub.projectPass=async(action,args,access)=>{if(action==='read'&&once){once=false;throw Error('Synthetic read failure');}return original(action,args,access);};
  const unconfirmed=await f.call('save_project_pass',packet());assert.equal(unconfirmed.error,'project_pass_write_unconfirmed');
  const recovered=await f.call('save_project_pass',unconfirmed.retry_arguments);assert.equal(recovered.replayed,true);assert.equal(recovered.save_confirmation,'confirmed');
  assert.equal((await f.call('project_pass_history',{project_id:'sandbox-a',sandbox:true,record_id:recovered.recorded.record_id})).history.length,1);
});

test('project namespace preserves original school storage, protocol and MCP tools; school key cannot authenticate project HTTP',async t=>{
  const f=await fixture(t),before=f.store.health(),learning=f.learningStore.get('BUSN5000','fall-2026',false);
  await f.call('save_project_pass',packet());assert.deepEqual(f.store.health(),before);
  assert.deepEqual(f.learningStore.get('BUSN5000','fall-2026',false),learning);assert.deepEqual(f.store.passRead().records,[]);
  assert.deepEqual(MCP_SCOPES,['school.materials:read','pass:read','pass:write']);
  const req=new Request('https://bridge.test/pass/projects/tools/list_pass_projects',{method:'POST',headers:{Authorization:'Bearer sp1_'+'1'.repeat(64),'Content-Type':'application/json'},body:'{}'});
  assert.equal((await worker.fetch(req,f.env)).status,401);
  const ownerReq=new Request(req.url,{method:'POST',headers:{Authorization:'Bearer '+f.env.API_KEY,'Content-Type':'application/json'},body:'{}'});
  assert.equal((await worker.fetch(ownerReq,f.env)).status,403);
  assert.equal((await projectPassRoutes(ownerReq,f.env,'/pass/projects/tools/list_pass_projects','scoped_school')).status,403);
});
