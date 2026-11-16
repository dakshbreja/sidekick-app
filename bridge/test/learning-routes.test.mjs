import {test} from 'node:test';
import assert from 'node:assert/strict';
import {learningRoutes} from '../src/learning-routes.js';
import {sqliteFoundation} from './sqlite-fixture.js';

const query='course=BUSN5000&term_id=fall-2026';
function body(extra={}) {return {action:'save_session',course:'BUSN5000',term_id:'fall-2026',expected_revision:0,idempotency_key:'connection-1',
  session:{session_id:'pilot-session',goal:'Explain a confidence interval',observations:[{topic_id:'confidence-intervals',label:'Confidence intervals',demonstration:'with_hints',evidence:'observed_response',outcome:'correct',
    practice_kind:'interpretation',misconception:'Confused the fixed parameter with repeated samples.',next_step:'Interpret a new interval without hints.',source_refs:[{doc_id:'drive-lecture',title:'Lecture 8'}]}],resume:{topic_id:'confidence-intervals',next_step:'Try a new interpretation.'}},...extra};}
const request=(method='GET',url='/learning?'+query,data=null,headers={})=>new Request('https://bridge.test'+url,{method,headers:{...(data?{'Content-Type':'application/json'}:{}),...headers},...(data?{body:JSON.stringify(data)}:{})});
function fixture(t) {const f=sqliteFoundation();t.after(()=>f.close());return {...f,env:{BRIDGE_STATE:f.binding}};}
const route=(r,env,auth='bearer')=>learningRoutes(r,env,new URL(r.url).pathname,auth);

test('non-learning routes are left for the existing Worker dispatcher',async()=>{
  assert.equal(await learningRoutes(request('GET','/status'),{},'/status','bearer'),null);
});
test('direct helper denies unauthorized calls without touching the durable state',async()=>{
  let touched=false;const env={BRIDGE_STATE:{getByName(){touched=true;throw new Error('must not read');}}};
  const r=await route(request(),env,null);assert.equal(r.status,401);assert.equal(touched,false);
});
test('authenticated reads require exact scope and advertise no-store',async t=>{
  const {env}=fixture(t),r=await route(request(),env);assert.equal(r.status,200);assert.equal(r.headers.get('Cache-Control'),'no-store');
  const out=await r.json();assert.equal(out.record.course,'BUSN5000');assert.equal(out.record.term_id,'fall-2026');assert.equal(out.record.revision,0);
});
test('missing course/term, unknown course/term and query ambiguity fail closed',async t=>{
  const {env}=fixture(t);
  for(const params of ['', 'course=BUSN5000', 'course=MGMT9999&term_id=fall-2026', 'course=BUSN5000&term_id=fall-2025',query+'&course=BUSN5000',query+'&sandbox=true&sandbox=false',query+'&grade=private',query+'&sandbox=1']) {
    const r=await route(request('GET','/learning?'+params),env);assert.equal(r.status,400,params);
  }
});
test('only the six enabled courses and exact term are readable and writable',async t=>{
  const {env,db}=fixture(t);
  for(const course of ['BUSN5000','MGMT4280','MGMT5560','MGMT5850','LAND2510','BUSN3040']) {
    const r=await route(request('GET','/learning?course='+course+'&term_id=fall-2026'),env);
    assert.equal(r.status,200);const out=await r.json();assert.equal(out.record.course,course);assert.equal(out.record.revision,0);
  }
  for(const course of ['MGMT9999','GENERAL','mgmt4280','MGMT 4280','LAND2510E','BUSN3040E']) {
    const get=await route(request('GET','/learning?course='+encodeURIComponent(course)+'&term_id=fall-2026'),env);
    assert.equal(get.status,400,course);assert.equal((await get.json()).error,'learning_course_unavailable');
    const post=await route(request('POST','/learning',body({course})),env);
    assert.equal(post.status,400,course);assert.equal((await post.json()).error,'learning_course_unavailable');
  }
  for(const term_id of ['fall-2025','spring-2027','FALL-2026']) {
    const post=await route(request('POST','/learning',body({course:'MGMT4280',term_id})),env);assert.equal(post.status,400,term_id);
    const get=await route(request('GET','/learning?course=MGMT4280&term_id='+term_id),env);assert.equal(get.status,400,term_id);
  }
  for(const table of ['learning_records','learning_history','learning_receipts'])assert.equal(db.prepare('SELECT count(*) AS count FROM '+table).get().count,0);
});
test('same topic, session and operation identities belong to the requested course only',async t=>{
  const {env}=fixture(t),packets=new Map(),records=new Map();
  for(const course of ['BUSN5000','MGMT4280','MGMT5560','MGMT5850','LAND2510','BUSN3040']) {
    const packet=body({course});packet.session.goal=course==='BUSN5000'?'Interpret uncertainty':'Explain a strategy choice';packets.set(course,packet);
    const response=await route(request('POST','/learning',packet),env);assert.equal(response.status,200);
    const receipt=await response.json();assert.equal(receipt.course,course);assert.equal(receipt.revision,1);assert.equal(receipt.record,undefined);
    const record=(await (await route(request('GET','/learning?course='+course+'&term_id=fall-2026'),env)).json()).record;
    assert.equal(record.course,course);assert.equal(record.recent_sessions[0].session_id,'pilot-session');assert.equal(record.recent_sessions[0].goal,packet.session.goal);records.set(course,record);
  }
  const preference={action:'update_preferences',course:'MGMT4280',term_id:'fall-2026',expected_revision:1,idempotency_key:'course-preference',preferences:{explanation_style:'examples_first'}};
  assert.equal((await route(request('POST','/learning',preference),env)).status,200);
  assert.deepEqual((await (await route(request(),env)).json()).record,records.get('BUSN5000'));
  const replay=await (await route(request('POST','/learning',packets.get('MGMT4280')),env)).json();assert.equal(replay.replayed,true);assert.equal(replay.revision,1);assert.equal(replay.course,'MGMT4280');
  const current=(await (await route(request('GET','/learning?course=MGMT4280&term_id=fall-2026'),env)).json()).record;
  assert.equal(current.revision,2);assert.deepEqual(current.preferences,{explanation_style:'examples_first'});assert.equal(current.topics[0].hinted_demonstrations,1);
  const changed=structuredClone(packets.get('MGMT4280'));changed.session.goal='Different strategy practice';
  const conflict=await route(request('POST','/learning',changed),env);assert.equal(conflict.status,409);assert.equal((await conflict.json()).error,'idempotency_conflict');
  assert.deepEqual((await (await route(request(),env)).json()).record,records.get('BUSN5000'));
});
test('authenticated POST confirms a metadata receipt then fresh GET confirms the exact saved record',async t=>{
  const {env}=fixture(t),r=await route(request('POST','/learning',body()),env);assert.equal(r.status,200);
  const saved=await r.json();assert.equal(saved.ok,true);assert.equal(saved.operation_id,'connection-1');assert.equal(saved.readback_required,true);assert.equal(saved.record,undefined);
  const read=await (await route(request(),env)).json();assert.equal(read.record.revision,saved.revision);assert.equal(read.record.topics[0].label,'Confidence intervals');assert.equal(read.record.resume.topic_id,'confidence-intervals');
  assert.equal(read.record.topics[0].outcome,'correct');assert.equal(read.record.topics[0].hinted_demonstrations,1);
});
test('old client outcome omission is safe and does not convert an observed attempt into successful understanding',async t=>{
  const {env}=fixture(t),raw=body();delete raw.session.observations[0].outcome;
  assert.equal((await route(request('POST','/learning',raw),env)).status,200);
  const read=await (await route(request(),env)).json();const topic=read.record.topics[0];
  assert.equal(topic.outcome,'unassessed');assert.equal(topic.hinted_attempts,1);assert.equal(topic.hinted_demonstrations,0);assert.equal(topic.independent_demonstrations,0);
  assert.equal(read.record.recent_sessions[0].topics[0].outcome,'unassessed');
});
test('unsupported outcomes and successful labels without observed learner responses fail before saving',async t=>{
  const {env}=fixture(t),invalid=body();invalid.session.observations[0].outcome='mastered';
  const bad=await route(request('POST','/learning',invalid),env);assert.equal(bad.status,400);assert.equal((await bad.json()).error,'invalid_outcome');
  const generated=body();Object.assign(generated.session.observations[0],{demonstration:'untested',evidence:'practice_generated',outcome:'correct'});
  const contradiction=await route(request('POST','/learning',generated),env);assert.equal(contradiction.status,400);assert.equal((await contradiction.json()).error,'invalid_outcome_evidence');
  assert.equal((await (await route(request(),env)).json()).record.revision,0);
});
test('bearer and session clients use the same private record after Worker authentication',async t=>{
  const {env}=fixture(t);assert.equal((await route(request('POST','/learning',body()),env,'session')).status,200);
  const read=await (await route(request(),env)).json();assert.equal(read.record.revision,1);
});
test('same body replay is idempotent and a changed packet with same key cannot overwrite',async t=>{
  const {env}=fixture(t),first=await (await route(request('POST','/learning',body()),env)).json();
  const replay=await (await route(request('POST','/learning',body()),env)).json();assert.equal(replay.replayed,true);assert.equal(replay.revision,first.revision);
  const changed=body();changed.session.goal='A different goal';const conflict=await route(request('POST','/learning',changed),env);assert.equal(conflict.status,409);assert.equal((await conflict.json()).error,'idempotency_conflict');
  assert.equal((await (await route(request(),env)).json()).record.revision,1);
});
test('expected revision is mandatory even on empty records and conflicts are explicit',async t=>{
  const {env}=fixture(t),missing=body();delete missing.expected_revision;
  assert.equal((await route(request('POST','/learning',missing),env)).status,400);await route(request('POST','/learning',body()),env);
  const stale=body({idempotency_key:'new-stale'});const r=await route(request('POST','/learning',stale),env);assert.equal(r.status,409);assert.equal((await r.json()).current_revision,1);
});
test('idempotency header can supply a required key but contradictions never save',async t=>{
  const {env}=fixture(t),raw=body();delete raw.idempotency_key;
  assert.equal((await route(request('POST','/learning',raw,{'Idempotency-Key':'header-operation'}),env)).status,200);
  const r=await route(request('POST','/learning',body(),{'Idempotency-Key':'different'}),env);assert.equal(r.status,400);assert.equal((await r.json()).error,'idempotency_key_mismatch');
});
test('a key is never generated silently and invalid operation identities are rejected',async t=>{
  const {env}=fixture(t),raw=body();delete raw.idempotency_key;
  assert.equal((await route(request('POST','/learning',raw),env)).status,400);
  for(const idempotency_key of ['', 'spaces are unsafe','../private', 'x'.repeat(161)])assert.equal((await route(request('POST','/learning',body({idempotency_key})),env)).status,400);
  assert.equal((await (await route(request(),env)).json()).record.revision,0);
});
test('unknown grade/answer/transcript fields and private prose are rejected instead of saved',async t=>{
  const {env}=fixture(t);
  for(const field of ['grade','raw_answer','transcript','client_secret'])assert.equal((await route(request('POST','/learning',body({[field]:'private'})),env)).status,400);
  for(const text of ['GPA 3.4','grade B+','I earned a B in BUSN 4000','Score: 98%','access_token secret']) {const raw=body();raw.session.goal=text;const r=await route(request('POST','/learning',raw),env);assert.equal(r.status,400);assert.equal((await r.json()).error,'restricted_learning_content');}
  assert.equal((await (await route(request(),env)).json()).record.revision,0);
});
test('malformed and oversized JSON bodies return bounded errors without internal data',async t=>{
  const {env}=fixture(t),malformed=new Request('https://bridge.test/learning',{method:'POST',body:'{'});
  assert.equal((await route(malformed,env)).status,400);
  const giant=new Request('https://bridge.test/learning',{method:'POST',body:JSON.stringify({private:'secret'.repeat(5000)})});
  const r=await route(giant,env);assert.equal(r.status,413);assert.deepEqual(await r.json(),{error:'body_too_large'});
});
test('unsupported methods return 405 rather than a fake successful read',async t=>{
  const {env}=fixture(t),r=await route(request('DELETE','/learning'),env);assert.equal(r.status,405);assert.equal((await r.json()).error,'method_not_allowed');
});
test('failed reads remain unavailable rather than an empty learning history',async()=>{
  const r=await route(request(),{BRIDGE_STATE:{getByName(){throw new Error('SQL contained private secret');}}});
  assert.equal(r.status,503);const out=await r.json();assert.equal(out.error,'learning_read_unavailable');assert.equal(out.record,undefined);assert.equal(JSON.stringify(out).includes('private secret'),false);
});
test('uncertain RPC failure retains the exact retry ID without exposing payload or internal errors',async()=>{
  const env={BRIDGE_STATE:{getByName(){return {learningPut:async()=>{throw new Error('SQL with raw student details');}};}}};
  const r=await route(request('POST','/learning',body()),env);assert.equal(r.status,503);const out=await r.json();
  assert.equal(out.error,'learning_write_not_confirmed');assert.equal(out.operation_id,'connection-1');assert.equal(JSON.stringify(out).includes('student details'),false);assert.equal(JSON.stringify(out).includes('confidence'),false);
});
test('sandbox is an isolated opt-in namespace and ordinary requests never read its fixture',async t=>{
  const {env}=fixture(t);await route(request('POST','/learning',body({sandbox:true})),env);
  const live=await (await route(request(),env)).json(),sandbox=await (await route(request('GET','/learning?'+query+'&sandbox=true'),env)).json();
  assert.equal(live.record.revision,0);assert.deepEqual(live.record.topics,[]);assert.equal(sandbox.record.revision,1);assert.equal(sandbox.record.sandbox,true);
});
test('recoverable reset and explicit restore require a fresh revision without affecting coursework',async t=>{
  const {env,store}=fixture(t),before=store.health();await route(request('POST','/learning',body()),env);
  const scope={course:'BUSN5000',term_id:'fall-2026'};
  await route(request('POST','/learning',{action:'reset',...scope,expected_revision:1,idempotency_key:'reset'}),env);
  const read=await (await route(request(),env)).json();assert.equal(read.record.revision,2);assert.deepEqual(read.record.topics,[]);assert.equal(read.record.action,undefined);assert.equal(read.recovery[0].action,'reset');
  const stale=await route(request('POST','/learning',{action:'restore_revision',...scope,expected_revision:1,idempotency_key:'restore-stale',restore_revision:1}),env);assert.equal(stale.status,409);
  const restore=await route(request('POST','/learning',{action:'restore_revision',...scope,expected_revision:2,idempotency_key:'restore',restore_revision:1}),env);assert.equal(restore.status,200);assert.deepEqual(store.health(),before);
});
