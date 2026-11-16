import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { sqliteFoundation } from './sqlite-fixture.js';
import { D2L_FEED, GOOGLE_FEED, shiftFeed, weeksSinceAnchor } from './fixtures.js';
import { digest, stableJSON } from '../src/foundation.js';

const KEY='learning-test-key-0123456789';
const ORIGIN='https://learning.test';
const PATH='/learning?course=BUSN5000&term_id=fall-2026';
const coursePath=course=>'/learning?course='+course+'&term_id=fall-2026';
const RECORD_KEYS=['schema_version','course','term_id','sandbox','revision','updated_at','topics','recent_sessions','resume','preferences'].sort();
let foundation,env,originalFetch,networkCalls;
beforeEach(()=>{
  foundation=sqliteFoundation({snapshot:{term_id:'fall-2026',progress:{BUSN5000:[{item:'Existing submitted work',status:'done',verification:'reported',note:'Earlier report'}]},classnote:{}}});
  env={API_KEY:KEY,BRIDGE_STATE:foundation.binding,FEED_ELC:'https://d2l.test/feed.ics',FEED_PERSONAL:'https://google.test/feed.ics',
    NOTES:{values:new Map(),async get(key){return this.values.get(key)??null;},async put(key,value){this.values.set(key,value);}}};
  originalFetch=globalThis.fetch;networkCalls=0;
  const weeks=weeksSinceAnchor();
  const feeds={'https://d2l.test/feed.ics':shiftFeed(D2L_FEED,weeks),'https://google.test/feed.ics':shiftFeed(GOOGLE_FEED,weeks)};
  globalThis.fetch=async url=>{
    networkCalls++;
    if(!feeds[url])throw new Error('Offline learning test blocked an unexpected external request');
    return new Response(feeds[url],{status:200});
  };
});
afterEach(()=>{globalThis.fetch=originalFetch;foundation?.close();});
const request=(path,init={})=>new Request(ORIGIN+path,{...init,headers:{Authorization:'Bearer '+KEY,...init.headers}});
async function send(body,init={}) {
  const response=await worker.fetch(request('/learning',{method:'POST',body:JSON.stringify(body),...init}),env);
  return {response,data:await response.json()};
}
async function read(sandbox=false,course='BUSN5000') {
  const response=await worker.fetch(request(coursePath(course)+(sandbox?'&sandbox=true':'')),env);
  const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;
}
const command=(action,expected_revision,idempotency_key,extra={})=>({action,course:'BUSN5000',term_id:'fall-2026',expected_revision,idempotency_key,...extra});
function save(expected_revision=0,idempotency_key='session-save-one',extra={}) {
  return command('save_session',expected_revision,idempotency_key,{session:{session_id:'study-session-one',goal:'Practice joining tables from the course slides',
    observations:[{topic_id:'table-joins',label:'Joining tables',demonstration:'with_hints',evidence:'observed_response',outcome:'correct',practice_kind:'code',
      misconception:'Confuses matching keys with row position',next_step:'Join two small tables without a hint',source_refs:[{doc_id:'course-slides-join',title:'Data transformation slides',locator:'Slide 12'}]}],
    resume:{topic_id:'table-joins',next_step:'Explain which rows an inner join retains'}},...extra});
}
function assertNoLearningWrites() {
  for(const table of ['learning_records','learning_history','learning_receipts'])assert.equal(foundation.db.prepare('SELECT count(*) AS count FROM '+table).get().count,0);
}

test('learning reads and writes share the Worker authentication boundary without leaking content',async()=>{
  const attempts=['BUSN5000','MGMT4280'].flatMap(course=>[[coursePath(course),'GET'],['/learning','POST',save(0,'save-anon',{course})],['/learning','POST',command('reset',0,'reset-anon',{course})]]);
  for(const [path,method,body] of attempts) {
    for(const authorization of [undefined,'Bearer wrong-key']) {
      const response=await worker.fetch(new Request(ORIGIN+path,{method,headers:authorization?{Authorization:authorization}:{},...(body?{body:JSON.stringify(body)}:{})}),env);
      assert.equal(response.status,401);assert.deepEqual(await response.json(),{error:'unauthorized'});
    }
  }
  assertNoLearningWrites();assert.equal(networkCalls,0);
});

test('a fresh learning record is bounded, course scoped, and declares recoverable removal',async()=>{
  const data=await read();assert.equal(data.ok,true);assert.equal(data.record.revision,0);
  assert.deepEqual(Object.keys(data.record).sort(),RECORD_KEYS);assert.deepEqual(data.record.topics,[]);assert.deepEqual(data.record.recent_sessions,[]);
  assert.equal(data.record.resume,null);assert.equal(data.record.sandbox,false);assert.equal(data.retention.recovery_revisions,10);
  assert.equal(data.privacy.forget_behavior,'reversible_for_retained_recovery_revisions');
  assert.equal(data.privacy.grades_stored,false);assert.equal(data.privacy.raw_answers_stored,false);assert.equal(networkCalls,0);
});

test('course, term, query ambiguity and sandbox types fail closed rather than widening scope',async()=>{
  for(const path of ['/learning','/learning?course=MGMT9999&term_id=fall-2026','/learning?course=BUSN5000&term_id=spring-2027',
    PATH+'&course=BUSN5000',PATH+'&sandbox=1',PATH+'&topic=table-joins']) {
    const response=await worker.fetch(request(path),env);assert.equal(response.status,400,path);
  }
  for(const body of [save(0,'other-course',{course:'MGMT9999'}),save(0,'other-term',{term_id:'fall-2025'}),save(0,'other-sandbox',{sandbox:'true'})]) {
    const {response}=await send(body);assert.equal(response.status,400);
  }
  assertNoLearningWrites();assert.equal(networkCalls,0);
});

test('saving has a metadata receipt and independent readback; an exact replay counts practice once',async()=>{
  const body=save();const first=await send(body);
  assert.equal(first.response.status,200);assert.equal(first.data.ok,true);assert.equal(first.data.revision,1);assert.equal(first.data.readback_required,true);
  assert.equal(first.data.operation_id,body.idempotency_key);assert.equal(first.data.record,undefined);
  assert.doesNotMatch(JSON.stringify(first.data),/Confuses matching|Data transformation|inner join/);
  const after=(await read()).record;assert.equal(after.revision,1);assert.equal(after.topics[0].hinted_demonstrations,1);assert.equal(after.topics[0].independent_demonstrations,0);
  assert.equal(after.recent_sessions.length,1);assert.equal(after.resume.topic_id,'table-joins');
  const replay=await send(body);assert.equal(replay.response.status,200);assert.equal(replay.data.replayed,true);
  assert.deepEqual((await read()).record,after);assert.equal(networkCalls,0);
});

test('one operation cannot be rebound to different evidence and header/body disagreement writes nothing',async()=>{
  const body=save();assert.equal((await send(body)).response.status,200);
  const changed=structuredClone(body);changed.session.goal='A different learning goal';
  const conflict=await send(changed);assert.equal(conflict.response.status,409);assert.equal(conflict.data.error,'idempotency_conflict');
  const mismatch=await send(save(1,'different-key'),{headers:{'Idempotency-Key':'header-key'}});
  assert.equal(mismatch.response.status,400);assert.equal(mismatch.data.error,'idempotency_key_mismatch');assert.equal((await read()).record.revision,1);
});

test('two competing saves cannot silently overwrite each other',async()=>{
  const a=save(0,'competing-a');const b=save(0,'competing-b');b.session.session_id='study-session-two';b.session.goal='Competing session';
  const results=await Promise.all([send(a),send(b)]);assert.deepEqual(results.map(result=>result.response.status).sort(),[200,409]);
  assert.equal(results.find(result=>result.response.status===409).data.error,'revision_conflict');
  const record=(await read()).record;assert.equal(record.revision,1);assert.equal(record.recent_sessions.length,1);assert.equal(record.topics[0].hinted_demonstrations,1);
});

test('an interrupted response can retry the exact save without exposing internal errors or doubling evidence',async()=>{
  const put=foundation.stub.learningPut;let interrupt=true;
  foundation.stub.learningPut=async packet=>{const result=await put(packet);if(interrupt){interrupt=false;throw new Error('SQL internal learner detail secret');}return result;};
  const body=save();const uncertain=await send(body);
  assert.equal(uncertain.response.status,503);assert.equal(uncertain.data.operation_id,body.idempotency_key);
  assert.doesNotMatch(JSON.stringify(uncertain.data),/SQL internal|learner detail|secret/);
  const retry=await send(body);assert.equal(retry.response.status,200);assert.equal(retry.data.replayed,true);
  const record=(await read()).record;assert.equal(record.revision,1);assert.equal(record.topics[0].hinted_demonstrations,1);
});

test('browser session writes require the current site Origin',async()=>{
  const entry=await worker.fetch(new Request(ORIGIN+'/app/session',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({access_key:KEY,returnTo:'/app'})}),env);assert.equal(entry.status,303);
  const cookie=entry.headers.getSetCookie().find(value=>value.startsWith('__Host-bridge_session=')).split(';')[0];
  for(const origin of [undefined,'https://foreign.test']) {
    const response=await worker.fetch(new Request(ORIGIN+'/learning',{method:'POST',headers:{Cookie:cookie,...(origin?{Origin:origin}:{})},body:JSON.stringify(save())}),env);
    assert.equal(response.status,403);assert.equal((await response.json()).error,'origin_required');
  }
  assertNoLearningWrites();
  const good=await worker.fetch(new Request(ORIGIN+'/learning',{method:'POST',headers:{Cookie:cookie,Origin:ORIGIN},body:JSON.stringify(save())}),env);
  assert.equal(good.status,200);assert.equal((await read()).record.revision,1);
});

test('sandbox records and operation IDs are isolated from personal learning',async()=>{
  const sandbox=save(0,'shared-operation',{sandbox:true});assert.equal((await send(sandbox)).response.status,200);
  assert.equal((await read()).record.revision,0);const testRecord=(await read(true)).record;assert.equal(testRecord.revision,1);assert.equal(testRecord.sandbox,true);
  assert.equal((await send(save(0,'shared-operation'))).response.status,200);assert.equal((await read()).record.revision,1);
  assert.equal((await send(command('reset',1,'sandbox-reset',{sandbox:true}))).response.status,200);
  assert.equal((await read(true)).record.topics.length,0);assert.equal((await read()).record.topics.length,1);
});

test('enabled courses have independent revisions and simultaneous saves do not contend for one record',async()=>{
  for(const course of ['BUSN5000','MGMT4280']) {
    const empty=(await read(false,course)).record;assert.equal(empty.course,course);assert.equal(empty.revision,0);
  }
  const busn=save(0,'shared-course-operation'),mgmt=save(0,'shared-course-operation',{course:'MGMT4280'});
  mgmt.session.goal='Explain a competitive strategy tradeoff';mgmt.session.resume.next_step='Compare two strategic choices';
  mgmt.session.observations[0].source_refs=[{doc_id:'strategy-reading',title:'Competitive strategy reading',locator:'Section 2'}];
  const saves=await Promise.all([send(busn),send(mgmt)]);assert.deepEqual(saves.map(result=>result.response.status),[200,200]);
  assert.deepEqual(saves.map(result=>result.data.course),['BUSN5000','MGMT4280']);
  const beforeBusn=(await read()).record,beforeMgmt=(await read(false,'MGMT4280')).record;
  assert.equal(beforeBusn.revision,1);assert.equal(beforeMgmt.revision,1);assert.equal(beforeBusn.recent_sessions.length,1);assert.equal(beforeMgmt.recent_sessions.length,1);
  assert.equal(beforeBusn.resume.next_step,busn.session.resume.next_step);assert.equal(beforeMgmt.resume.next_step,mgmt.session.resume.next_step);
  assert.deepEqual(beforeMgmt.topics[0].source_refs,[{...mgmt.session.observations[0].source_refs[0]}]);assert.notDeepEqual(beforeMgmt.topics[0].source_refs,beforeBusn.topics[0].source_refs);
  const stale=await send(command('update_preferences',0,'mgmt-stale',{course:'MGMT4280',preferences:{time_budget_minutes:15}}));
  assert.equal(stale.response.status,409);assert.equal(stale.data.current_revision,1);assert.deepEqual((await read()).record,beforeBusn);assert.deepEqual((await read(false,'MGMT4280')).record,beforeMgmt);
  const changed=structuredClone(mgmt);changed.session.goal='A different strategy choice';
  const conflict=await send(changed);assert.equal(conflict.response.status,409);assert.equal(conflict.data.error,'idempotency_conflict');
  for(const body of [busn,mgmt]) {const replay=await send(body);assert.equal(replay.response.status,200);assert.equal(replay.data.replayed,true);assert.equal(replay.data.course,body.course);}
  assert.deepEqual((await read()).record,beforeBusn);assert.deepEqual((await read(false,'MGMT4280')).record,beforeMgmt);assert.equal(networkCalls,0);
});

test('identical topic, session and retry keys are isolated across both courses and both sandbox partitions',async()=>{
  const partitions=[];
  for(const course of ['BUSN5000','MGMT4280'])for(const sandbox of [false,true]) {
    const body=save(0,'same-four-partition-key',{course,sandbox});body.session.goal='Practice '+course+(sandbox?' sandbox':' personal')+' concepts';
    body.session.resume.next_step='Continue '+course+(sandbox?' sandbox':' personal')+' practice';
    const first=await send(body);assert.equal(first.response.status,200);assert.equal(first.data.course,course);assert.equal(first.data.sandbox,sandbox);
    const record=(await read(sandbox,course)).record;assert.equal(record.revision,1);assert.equal(record.recent_sessions[0].goal,body.session.goal);assert.deepEqual(record.resume,body.session.resume);
    partitions.push({course,sandbox,body,record});
  }
  assert.equal(foundation.db.prepare('SELECT count(*) AS count FROM learning_records').get().count,4);
  assert.equal(foundation.db.prepare('SELECT count(*) AS count FROM learning_receipts').get().count,4);
  assert.equal((await send(command('reset',1,'mgmt-sandbox-reset',{course:'MGMT4280',sandbox:true}))).response.status,200);
  for(const partition of partitions) {
    const replay=await send(partition.body);assert.equal(replay.response.status,200);assert.equal(replay.data.replayed,true);assert.equal(replay.data.course,partition.course);assert.equal(replay.data.sandbox,partition.sandbox);assert.equal(replay.data.record,undefined);
    const now=(await read(partition.sandbox,partition.course)).record;
    if(partition.course==='MGMT4280'&&partition.sandbox) {assert.equal(now.revision,2);assert.deepEqual(now.topics,[]);assert.equal(now.resume,null);}
    else assert.deepEqual(now,partition.record);
  }
  assert.equal(networkCalls,0);
});

test('preferences, recoverable removal and restoration cannot read or alter another course history',async()=>{
  const busn=save(),mgmt=save(0,'mgmt-session',{course:'MGMT4280'});mgmt.session.goal='Practice competitive positioning';
  assert.equal((await send(busn)).response.status,200);assert.equal((await send(mgmt)).response.status,200);
  assert.equal((await send(command('update_preferences',1,'shared-preference',{preferences:{explanation_style:'concise',time_budget_minutes:10}}))).response.status,200);
  const busnBefore=(await read()).record;
  const unavailable=await send(command('restore_revision',1,'mgmt-foreign-recovery',{course:'MGMT4280',restore_revision:1}));
  assert.equal(unavailable.response.status,404);assert.equal(unavailable.data.error,'recovery_revision_unavailable','BUSN revision 1 must not be used as an MGMT snapshot');
  assert.equal((await send(command('update_preferences',1,'shared-preference',{course:'MGMT4280',preferences:{explanation_style:'examples_first',time_budget_minutes:35}}))).response.status,200);
  const mgmtBefore=(await read(false,'MGMT4280')).record;assert.equal(mgmtBefore.revision,2);assert.deepEqual(mgmtBefore.preferences,{explanation_style:'examples_first',time_budget_minutes:35});
  assert.equal((await send(command('forget_topic',2,'mgmt-remove',{course:'MGMT4280',topic_id:'table-joins'}))).response.status,200);
  const removed=(await read(false,'MGMT4280')).record;assert.deepEqual(removed.topics,[]);assert.equal(removed.resume,null);
  const oldReplay=await send(mgmt);assert.equal(oldReplay.data.replayed,true);assert.equal(oldReplay.data.revision,1);assert.deepEqual((await read(false,'MGMT4280')).record,removed);
  assert.equal((await send(command('restore_revision',3,'mgmt-restore',{course:'MGMT4280',restore_revision:2}))).response.status,200);
  let current=(await read(false,'MGMT4280')).record;assert.equal(current.revision,4);assert.deepEqual(current.topics,mgmtBefore.topics);assert.deepEqual(current.preferences,mgmtBefore.preferences);assert.deepEqual(current.resume,mgmtBefore.resume);
  assert.equal((await send(command('reset',4,'mgmt-reset',{course:'MGMT4280'}))).response.status,200);
  current=(await read(false,'MGMT4280')).record;assert.equal(current.revision,5);assert.deepEqual(current.preferences,{});assert.deepEqual(current.topics,[]);
  assert.equal((await send(command('restore_revision',5,'mgmt-restore-again',{course:'MGMT4280',restore_revision:2}))).response.status,200);
  current=(await read(false,'MGMT4280')).record;assert.equal(current.revision,6);assert.deepEqual(current.topics,mgmtBefore.topics);assert.deepEqual(current.preferences,mgmtBefore.preferences);
  assert.deepEqual((await read()).record,busnBefore);assert.equal(networkCalls,0);
});

test('a handoff cannot resolve a topic existing only in the other course',async()=>{
  assert.equal((await send(save())).response.status,200);const busnBefore=(await read()).record;
  const body=save(0,'mgmt-foreign-resume',{course:'MGMT4280'});body.session.observations[0].topic_id='competitive-advantage';
  const result=await send(body);assert.equal(result.response.status,400);assert.equal(result.data.error,'resume_topic_unknown');
  assert.equal((await read(false,'MGMT4280')).record.revision,0);assert.deepEqual((await read()).record,busnBefore);
  assert.equal(foundation.db.prepare("SELECT count(*) AS count FROM learning_history WHERE scope='live:fall-2026:MGMT4280'").get().count,0);
  assert.equal(networkCalls,0);
});

test('an uncertain MGMT save retries its own receipt and cannot increment BUSN practice',async()=>{
  assert.equal((await send(save(0,'shared-uncertain-operation'))).response.status,200);const busnBefore=(await read()).record;
  const put=foundation.stub.learningPut;let interrupt=true;
  foundation.stub.learningPut=async packet=>{const result=await put(packet);if(packet.body.course==='MGMT4280'&&interrupt){interrupt=false;throw new Error('Internal private course payload');}return result;};
  const body=save(0,'shared-uncertain-operation',{course:'MGMT4280'});body.session.goal='Explain a strategy tradeoff';
  const uncertain=await send(body);assert.equal(uncertain.response.status,503);assert.equal(uncertain.data.operation_id,body.idempotency_key);assert.doesNotMatch(JSON.stringify(uncertain.data),/Internal|private|strategy/);
  const retry=await send(body);assert.equal(retry.response.status,200);assert.equal(retry.data.replayed,true);assert.equal(retry.data.course,'MGMT4280');assert.equal(retry.data.revision,1);assert.equal(retry.data.record,undefined);
  const mgmt=(await read(false,'MGMT4280')).record;assert.equal(mgmt.recent_sessions.length,1);assert.equal(mgmt.topics[0].hinted_attempts,1);assert.equal(mgmt.topics[0].hinted_demonstrations,1);
  assert.deepEqual((await read()).record,busnBefore);assert.equal(networkCalls,0);
});

test('the second course preserves privacy and unsuccessful-attempt semantics without changing coursework',async()=>{
  const recordsBefore=foundation.db.prepare('SELECT * FROM records ORDER BY record_id').all(),historyBefore=foundation.db.prepare('SELECT * FROM history ORDER BY seq').all();
  const statuses=new Map();for(const course of ['BUSN5000','MGMT4280'])statuses.set(course,await (await worker.fetch(request('/status?course='+course),env)).json());
  for(const goal of ['My grade: 92','Cumulative GPA 3.10','Authorization: Bearer private-token','Transcript: copied class discussion']) {
    const blocked=save(0,'mgmt-private',{course:'MGMT4280'});blocked.session.goal=goal;
    const reject=await send(blocked);assert.equal(reject.response.status,400);assert.equal(reject.data.error,'restricted_learning_content');assertNoLearningWrites();
  }
  const raw=save(0,'mgmt-raw',{course:'MGMT4280'});raw.session.observations[0].raw_answer='An entire answer';assert.equal((await send(raw)).response.status,400);assertNoLearningWrites();
  const incorrect=save(0,'mgmt-incorrect',{course:'MGMT4280'});Object.assign(incorrect.session.observations[0],{demonstration:'independent',outcome:'incorrect'});
  assert.equal((await send(incorrect)).response.status,200);
  const partial=save(1,'mgmt-partial',{course:'MGMT4280'});partial.session.session_id='mgmt-partial-session';Object.assign(partial.session.observations[0],{demonstration:'with_hints',outcome:'partial'});
  assert.equal((await send(partial)).response.status,200);const record=(await read(false,'MGMT4280')).record,topic=record.topics[0];
  assert.equal(topic.independent_attempts,1);assert.equal(topic.hinted_attempts,1);assert.equal(topic.independent_demonstrations,0);assert.equal(topic.hinted_demonstrations,0);assert.equal(topic.outcome,'partial');assert.deepEqual(record.resume,partial.session.resume);
  assert.equal((await read()).record.revision,0);assert.deepEqual(foundation.db.prepare('SELECT * FROM records ORDER BY record_id').all(),recordsBefore);assert.deepEqual(foundation.db.prepare('SELECT * FROM history ORDER BY seq').all(),historyBefore);
  for(const course of ['BUSN5000','MGMT4280']) {const after=await (await worker.fetch(request('/status?course='+course),env)).json();assert.deepEqual(after.actionable,statuses.get(course).actionable);assert.deepEqual(after.progress,statuses.get(course).progress);}
});

test('grades, credentials, transcript markers and hidden nested fields are rejected before storage',async()=>{
  const blockedGoals=['My grade: 92','My grade 92','Cumulative GPA 3.10','I earned a B in BUSN 4000','My score was 9/10',
    'Authorization: Bearer private-token','refresh_token=private-token','Transcript: copied class discussion','Speaker 1: copied response','[01:02] Raw recording'];
  let count=0;
  for(const goal of blockedGoals) {
    const body=save(0,'privacy-'+count++);body.session.goal=goal;
    const {response,data}=await send(body);assert.equal(response.status,400,goal);assert.equal(data.error,'restricted_learning_content',goal);
    assertNoLearningWrites();
  }
  const unexpected=save(0,'privacy-nested');unexpected.session.observations[0].raw_answer='An entire student answer';
  const nested=await send(unexpected);assert.equal(nested.response.status,400);assert.equal(nested.data.error,'unknown_learning_fields');assertNoLearningWrites();
  const percent=save(0,'statistical-percentage');percent.session.goal='Interpret a confidence interval and the meaning of a 95% interval';
  assert.equal((await send(percent)).response.status,200,'Statistical concepts remain legal teaching material');
});

test('learner reports and generated practice cannot be labeled independent demonstrated understanding',async()=>{
  for(const evidence of ['learner_report','practice_generated','discussion_only']) {
    const body=save(0,'unsupported-'+evidence);body.session.observations[0].demonstration='independent';body.session.observations[0].evidence=evidence;
    const {response,data}=await send(body);assert.equal(response.status,400);assert.equal(data.error,'demonstration_evidence_conflict');
  }
  assertNoLearningWrites();
});

test('unaided incomplete, incorrect and unattempted observations save and resume without claiming successful understanding',async()=>{
  const body=save();const base=body.session.observations[0];
  body.session.observations=[
    {...base,topic_id:'method-not-attempted',demonstration:'independent',outcome:'not_attempted',misconception:'A method was not selected',next_step:'Choose the appropriate method before applying it'},
    {...base,topic_id:'interpretation-partial',demonstration:'independent',outcome:'partial',misconception:'An essential qualification was omitted',next_step:'Give a complete qualified interpretation'},
    {...base,topic_id:'confounding-incorrect',demonstration:'independent',outcome:'incorrect',misconception:'The proposed reasoning did not address confounding',next_step:'Explain the role of omitted confounding'},
    {...base,topic_id:'design-partial',demonstration:'independent',outcome:'partial',misconception:'An essential design condition was omitted',next_step:'Explain the missing design condition'},
  ];
  body.session.resume={topic_id:'method-not-attempted',next_step:'Try a fresh method-selection task before receiving a repair'};
  const first=await send(body);assert.equal(first.response.status,200);const beforeReplay=(await read()).record;
  assert.equal(beforeReplay.schema_version,2);assert.equal(beforeReplay.topics.length,4);
  for(const topic of beforeReplay.topics){assert.equal(topic.independent_demonstrations,0);assert.equal(topic.hinted_demonstrations,0);}
  assert.deepEqual(beforeReplay.topics.map(topic=>topic.independent_attempts),[0,1,1,1]);
  assert.deepEqual(beforeReplay.topics.map(topic=>topic.outcome),['not_attempted','partial','incorrect','partial']);
  assert.deepEqual(beforeReplay.recent_sessions[0].topics.map(topic=>topic.outcome),['not_attempted','partial','incorrect','partial']);
  assert.deepEqual(beforeReplay.resume,body.session.resume);
  assert.equal((await send(body)).data.replayed,true);assert.deepEqual((await read()).record,beforeReplay);assert.equal(networkCalls,0);
});

test('correct hinted and independent work are distinct from prior incorrect attempts',async()=>{
  const incorrect=save();Object.assign(incorrect.session.observations[0],{demonstration:'independent',outcome:'incorrect'});
  assert.equal((await send(incorrect)).response.status,200);let topic=(await read()).record.topics[0];
  assert.equal(topic.independent_attempts,1);assert.equal(topic.independent_demonstrations,0);
  const hinted=save(1,'correct-hinted');hinted.session.session_id='correct-hinted-session';
  assert.equal((await send(hinted)).response.status,200);topic=(await read()).record.topics[0];
  assert.equal(topic.outcome,'correct');assert.equal(topic.independent_attempts,1);assert.equal(topic.hinted_attempts,1);
  assert.equal(topic.independent_demonstrations,0);assert.equal(topic.hinted_demonstrations,1);
  const independent=save(2,'correct-independent');independent.session.session_id='correct-independent-session';independent.session.observations[0].demonstration='independent';
  assert.equal((await send(independent)).response.status,200);topic=(await read()).record.topics[0];
  assert.equal(topic.independent_attempts,2);assert.equal(topic.hinted_attempts,1);assert.equal(topic.independent_demonstrations,1);assert.equal(topic.hinted_demonstrations,1);
  assert.equal(networkCalls,0);
});

test('missing old-client outcome remains unassessed and generated practice never becomes successful learner evidence',async()=>{
  const old=save();delete old.session.observations[0].outcome;assert.equal((await send(old)).response.status,200);
  const topic=(await read()).record.topics[0];assert.equal(topic.outcome,'unassessed');assert.equal(topic.hinted_attempts,1);assert.equal(topic.hinted_demonstrations,0);
  const generated=save(1,'generated-practice');generated.session.session_id='generated-practice-session';
  Object.assign(generated.session.observations[0],{demonstration:'untested',evidence:'practice_generated',outcome:'unassessed'});
  assert.equal((await send(generated)).response.status,200);const after=(await read()).record.topics[0];
  assert.equal(after.independent_attempts,0);assert.equal(after.hinted_attempts,1);assert.equal(after.independent_demonstrations,0);assert.equal(after.hinted_demonstrations,0);
  const unsupported=save(2,'generated-success');unsupported.session.session_id='generated-success-session';
  Object.assign(unsupported.session.observations[0],{demonstration:'untested',evidence:'practice_generated',outcome:'correct'});
  const reject=await send(unsupported);assert.equal(reject.response.status,400);assert.equal(reject.data.error,'invalid_outcome_evidence');assert.equal((await read()).record.revision,2);
});

test('a v1 receipt can replay after upgrade and legacy recovery never turns old attempt counts into successes',async()=>{
  const oldPacket=save(0,'legacy-v1-operation');delete oldPacket.session.observations[0].outcome;
  const oldCanonical={...oldPacket,sandbox:false};const fingerprint=await digest(stableJSON(oldCanonical));
  const at='2026-10-10T23:00:00.000Z',scope='live:fall-2026:BUSN5000';
  const legacyTopic={...oldPacket.session.observations[0],independent_demonstrations:3,hinted_demonstrations:2,last_session_id:'legacy-session',last_practiced_at:at};
  const legacy={schema_version:1,course:'BUSN5000',term_id:'fall-2026',sandbox:false,revision:3,updated_at:at,topics:[legacyTopic],
    recent_sessions:[{session_id:'legacy-session',goal:'Legacy course practice',at,topics:[{topic_id:'table-joins',demonstration:'with_hints',evidence:'observed_response'}]}],
    resume:oldPacket.session.resume,preferences:{}};
  const prior={...legacy,revision:1,topics:[{...legacyTopic,independent_demonstrations:1,hinted_demonstrations:1}]};
  const oldReceipt={ok:true,operation_id:oldPacket.idempotency_key,course:'BUSN5000',term_id:'fall-2026',sandbox:false,revision:3,receipt:{action:'save_session',at},readback_required:true};
  foundation.db.prepare('INSERT INTO learning_records VALUES (?,?,?,?)').run(scope,3,JSON.stringify(legacy),at);
  foundation.db.prepare('INSERT INTO learning_history VALUES (?,?,?,?,?)').run(scope,1,'save_session',JSON.stringify(prior),at);
  foundation.db.prepare('INSERT INTO learning_receipts VALUES (?,?,?,?,?)').run(scope,oldPacket.idempotency_key,fingerprint,JSON.stringify(oldReceipt),at);
  const rawBefore=foundation.db.prepare('SELECT data FROM learning_records WHERE scope=?').get(scope).data;
  let current=(await read()).record;assert.equal(current.schema_version,2);assert.equal(current.revision,3);
  let topic=current.topics[0];assert.equal(topic.outcome,'unassessed');assert.equal(topic.independent_attempts,3);assert.equal(topic.hinted_attempts,2);
  assert.equal(topic.independent_demonstrations,0);assert.equal(topic.hinted_demonstrations,0);assert.equal(current.recent_sessions[0].topics[0].outcome,'unassessed');
  const retry=await send(oldPacket);assert.equal(retry.response.status,200);assert.equal(retry.data.replayed,true);assert.equal(retry.data.revision,3);
  assert.equal(foundation.db.prepare('SELECT data FROM learning_records WHERE scope=?').get(scope).data,rawBefore,'GET and exact old retry do not silently migrate or rewrite the record');
  assert.equal((await send(command('update_preferences',3,'upgrade-preference',{preferences:{practice_focus:'code'}}))).response.status,200);
  current=(await read()).record;assert.equal(current.schema_version,2);assert.equal(current.revision,4);assert.equal(current.topics[0].independent_demonstrations,0);
  assert.equal((await send(command('restore_revision',4,'restore-v1-snapshot',{restore_revision:1}))).response.status,200);
  current=(await read()).record;topic=current.topics[0];assert.equal(current.schema_version,2);assert.equal(current.revision,5);assert.equal(topic.outcome,'unassessed');
  assert.equal(topic.independent_attempts,1);assert.equal(topic.hinted_attempts,1);assert.equal(topic.independent_demonstrations,0);assert.equal(topic.hinted_demonstrations,0);
});

test('an oversized packet cannot bypass the streaming bound by omitting a size header',async()=>{
  const response=await worker.fetch(request('/learning',{method:'POST',body:JSON.stringify({...save(),padding:'x'.repeat(25000)})}),env);
  assert.equal(response.status,413);assert.equal((await response.json()).error,'body_too_large');assertNoLearningWrites();
});

test('recoverable topic removal clears the current handoff and replay cannot resurrect it',async()=>{
  const body=save();assert.equal((await send(body)).response.status,200);
  const remove=await send(command('forget_topic',1,'forget-join',{topic_id:'table-joins'}));assert.equal(remove.response.status,200);assert.equal(remove.data.revision,2);
  const removed=await read();assert.equal(removed.record.topics.length,0);assert.equal(removed.record.recent_sessions.length,0);assert.equal(removed.record.resume,null);
  assert.doesNotMatch(JSON.stringify(removed),/Confuses matching|Data transformation|inner join/);
  assert.ok(removed.recovery.some(row=>row.revision===1));assert.equal(removed.privacy.forget_behavior,'reversible_for_retained_recovery_revisions');
  const replay=await send(body);assert.equal(replay.data.replayed,true);assert.equal(replay.data.revision,1);assert.equal(replay.data.record,undefined);
  assert.deepEqual((await read()).record,removed.record);
});

test('reset projects only record fields and restoration requires the current revision in the same partition',async()=>{
  assert.equal((await send(save())).response.status,200);
  assert.equal((await send(command('update_preferences',1,'preference-save',{preferences:{explanation_style:'examples_first',time_budget_minutes:25}}))).response.status,200);
  const reset=await send(command('reset',2,'reset-learning'));assert.equal(reset.response.status,200);assert.equal(reset.data.revision,3);
  const empty=(await read()).record;assert.deepEqual(Object.keys(empty).sort(),RECORD_KEYS);assert.deepEqual(empty.topics,[]);assert.deepEqual(empty.preferences,{});assert.equal(empty.resume,null);
  const stale=await send(command('restore_revision',2,'restore-stale',{restore_revision:1}));assert.equal(stale.response.status,409);assert.equal(stale.data.error,'revision_conflict');
  const isolated=await send(command('restore_revision',0,'restore-other-partition',{restore_revision:1,sandbox:true}));assert.equal(isolated.response.status,404);assert.equal(isolated.data.error,'recovery_revision_unavailable');
  const restore=await send(command('restore_revision',3,'restore-original',{restore_revision:1}));assert.equal(restore.response.status,200);
  const restored=(await read()).record;assert.equal(restored.revision,4);assert.equal(restored.topics[0].topic_id,'table-joins');assert.deepEqual(restored.preferences,{});
});

test('learning saves, corrections, removal, restore and reset leave coursework and actionable obligations unchanged',async()=>{
  const recordsBefore=foundation.db.prepare('SELECT * FROM records ORDER BY record_id').all();
  const historyBefore=foundation.db.prepare('SELECT * FROM history ORDER BY seq').all();
  const statusBefore=await (await worker.fetch(request('/status?course=BUSN5000'),env)).json();assert.ok(statusBefore.actionable.outstanding.length>0);
  for(const body of [save(),command('update_preferences',1,'no-progress-preferences',{preferences:{practice_focus:'code'}}),
    command('forget_topic',2,'no-progress-forget',{topic_id:'table-joins'}),command('restore_revision',3,'no-progress-restore',{restore_revision:1}),
    command('reset',4,'no-progress-reset')])assert.equal((await send(body)).response.status,200);
  assert.deepEqual(foundation.db.prepare('SELECT * FROM records ORDER BY record_id').all(),recordsBefore);
  assert.deepEqual(foundation.db.prepare('SELECT * FROM history ORDER BY seq').all(),historyBefore);
  const statusAfter=await (await worker.fetch(request('/status?course=BUSN5000'),env)).json();
  assert.deepEqual(statusAfter.actionable,statusBefore.actionable);assert.deepEqual(statusAfter.progress,statusBefore.progress);
});
