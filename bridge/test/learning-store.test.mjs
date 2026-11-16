import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LearningStore,LEARNING_COURSE,LEARNING_COURSES,LEARNING_LIMITS,learningScope,normalizeLearningBody} from '../src/learning-store.js';
import {digest,stableJSON} from '../src/foundation.js';
import {sqliteFoundation} from './sqlite-fixture.js';

const at='2026-10-11T02:00:00.000Z';
const scope={course:'BUSN5000',term_id:'fall-2026'};
const obs=(extra={})=>({topic_id:'sampling-distributions',label:'Sampling distributions',demonstration:'independent',evidence:'observed_response',
  outcome:'correct',practice_kind:'interpretation',misconception:'',next_step:'Apply the idea to a new sample size.',source_refs:[{doc_id:'drive-doc-1',title:'Lecture 7',locator:'slide 12'}],...extra});
function body(extra={}) {return {action:'save_session',...scope,expected_revision:0,idempotency_key:'learning-1',
  session:{session_id:'session-1',goal:'Review sampling distributions',observations:[obs()],resume:{topic_id:'sampling-distributions',next_step:'Interpret a new scenario.'}},...extra};}
async function command(raw=body(),time=at) {const normalized=normalizeLearningBody(raw);return {body:normalized,operation_id:normalized.idempotency_key,fingerprint:await digest(stableJSON(normalized)),at:time};}
function fixture(t) {const f=sqliteFoundation();t.after(()=>f.close());return {...f,s:f.learningStore};}

test('empty learning has explicit private scope and no inferred student history',t=>{
  const {s}=fixture(t),out=s.get(scope.course,scope.term_id);
  assert.equal(out.record.revision,0);assert.deepEqual(out.record.topics,[]);assert.equal(out.record.resume,null);
  assert.equal(out.record.sandbox,false);assert.equal(out.privacy.raw_answers_stored,false);assert.equal(out.privacy.grades_stored,false);
  assert.equal(out.privacy.forget_behavior,'reversible_for_retained_recovery_revisions');
});
test('saved observed practice survives a new store instance and does not alter coursework',async t=>{
  const {s,storage,store}=fixture(t),before=store.health(),out=s.put(await command());
  assert.equal(out.ok,true);assert.equal(out.revision,1);assert.equal(out.readback_required,true);assert.equal(out.record,undefined);
  const read=new LearningStore(storage).get(scope.course,scope.term_id);
  assert.equal(read.record.topics[0].independent_demonstrations,1);assert.equal(read.record.topics[0].hinted_demonstrations,0);
  assert.equal(read.record.resume.topic_id,'sampling-distributions');assert.deepEqual(store.health(),before);
  assert.deepEqual(store.list('progress',[scope.course]).records,[]);assert.deepEqual(store.list('classnote',[scope.course]).records,[]);
});
test('same packet retries return original metadata receipt and cannot double-count practice',async t=>{
  const {s}=fixture(t),c=await command(),first=s.put(c),again=s.put(c);
  assert.deepEqual(again,{...first,replayed:true});assert.equal(s.get(scope.course,scope.term_id).record.topics[0].independent_demonstrations,1);
  assert.deepEqual(s.put({...c,fingerprint:'f'.repeat(64)}),{error:'idempotency_conflict',status:409});
});
test('lost old response can resolve after a new learning edit without returning old personal content',async t=>{
  const {s}=fixture(t),first=await command();s.put(first);
  s.put(await command({action:'update_preferences',...scope,expected_revision:1,idempotency_key:'preferences',preferences:{explanation_style:'step_by_step'}}));
  const replay=s.put(first);assert.equal(replay.revision,1);assert.equal(replay.replayed,true);
  assert.equal(replay.record,undefined);assert.equal(JSON.stringify(replay).includes('sampling'),false);
  assert.equal(s.get(scope.course,scope.term_id).record.revision,2);
});
test('stale revision leaves newer record and recovery history unchanged',async t=>{
  const {s}=fixture(t);s.put(await command());const before=s.get(scope.course,scope.term_id);
  const out=s.put(await command(body({idempotency_key:'stale'})));
  assert.deepEqual(out,{error:'revision_conflict',status:409,current_revision:1});assert.deepEqual(s.get(scope.course,scope.term_id),before);
});
test('generated practice remains untested and does not increase observed demonstration counts',async t=>{
  const {s}=fixture(t),raw=body();raw.session.observations=[obs({demonstration:'untested',evidence:'practice_generated',outcome:'unassessed'})];
  s.put(await command(raw));const topic=s.get(scope.course,scope.term_id).record.topics[0];
  assert.equal(topic.independent_demonstrations,0);assert.equal(topic.hinted_demonstrations,0);assert.equal(topic.evidence,'practice_generated');
});
test('hinted and independent responses are recorded separately without grades or mastery percentages',async t=>{
  const {s}=fixture(t);s.put(await command());const raw=body({expected_revision:1,idempotency_key:'second'});raw.session.session_id='session-2';
  raw.session.observations=[obs({demonstration:'with_hints'})];s.put(await command(raw));
  const topic=s.get(scope.course,scope.term_id).record.topics[0];assert.equal(topic.independent_demonstrations,1);assert.equal(topic.hinted_demonstrations,1);
  assert.equal(topic.demonstration,'with_hints');assert.equal(topic.mastery,undefined);assert.equal(topic.score,undefined);
});
test('self-reported understanding cannot be promoted to independent observed practice',()=>{
  const raw=body();raw.session.observations=[obs({evidence:'learner_report'})];
  assert.throws(()=>normalizeLearningBody(raw),/demonstration_evidence_conflict/);
});
test('explanation-only summaries require discussion evidence',()=>{
  const raw=body();raw.session.observations=[obs({demonstration:'explanation_only',evidence:'discussion_only',outcome:'unassessed'})];
  assert.equal(normalizeLearningBody(raw).session.observations[0].demonstration,'explanation_only');
  raw.session.observations[0].evidence='practice_generated';assert.throws(()=>normalizeLearningBody(raw),/demonstration_evidence_conflict/);
});
test('unknown raw answers, transcript, grades and hidden extra fields are rejected at every level',()=>{
  for(const field of ['raw_answer','transcript','grade','credential'])assert.throws(()=>normalizeLearningBody(body({[field]:'private'})),/unknown_learning_fields/);
  const nested=body();nested.session.answer='raw answer';assert.throws(()=>normalizeLearningBody(nested),/unknown_learning_fields/);
  const source=body();source.session.observations[0].source_refs[0].url='https://drive.google.com/private';assert.throws(()=>normalizeLearningBody(source),/unknown_learning_fields/);
});
test('restricted prose never enters learning tables while statistical quantities remain valid',()=>{
  for(const value of ['my grade 92','Score: 8/10','Cumulative GPA 3.10','GPA 3.4','grade B+','I earned a B in BUSN 4000','Transcript: private words','Speaker 1: secret','[00:10] private','access_token secret','my password is secret','Bearer abcdef','sk-privatekey123456789']) {
    const raw=body();raw.session.goal=value;assert.throws(()=>normalizeLearningBody(raw),/restricted_learning_content/,value);
  }
  const safe=body();safe.session.goal='Interpret a 95% confidence interval.';assert.equal(normalizeLearningBody(safe).session.goal,safe.session.goal);
  safe.session.goal='Explain a gradient.';assert.equal(normalizeLearningBody(safe).session.goal,safe.session.goal);
});
test('HTML, multiline transcripts and external links are not valid summary text',()=>{
  for(const value of ['<script>alert(1)</script>','first\nsecond','https://example.com/?token=private']) {
    const raw=body();raw.session.goal=value;assert.throws(()=>normalizeLearningBody(raw),/invalid_learning_text/);
  }
});
test('course, term and sandbox are strict rather than aliases or inferred defaults',()=>{
  for(const changes of [{course:'MGMT9999'},{course:'BUSN 5000'},{term_id:'fall-2025'},{term_id:null},{sandbox:'true'}])assert.throws(()=>normalizeLearningBody(body(changes)),/learning_course_unavailable|invalid_learning_term|invalid_learning_sandbox/);
});
test('session, observations, source references and identifiers are bounded',()=>{
  const many=body();many.session.observations=Array.from({length:9},(_,i)=>obs({topic_id:'topic-'+i}));assert.throws(()=>normalizeLearningBody(many),/invalid_learning_observations/);
  const refs=body();refs.session.observations[0].source_refs=Array.from({length:5},(_,i)=>({doc_id:'doc-'+i,title:'Title'}));assert.throws(()=>normalizeLearningBody(refs),/invalid_source_refs/);
  const long=body();long.session.goal='x'.repeat(241);assert.throws(()=>normalizeLearningBody(long),/invalid_learning_text/);
  const unsafe=body();unsafe.session.observations[0].topic_id='../../other';assert.throws(()=>normalizeLearningBody(unsafe),/invalid_topic_id/);
});
test('duplicate topics, duplicate source refs and nonexistent resume targets cannot save',async t=>{
  const {s}=fixture(t),raw=body();raw.session.observations.push(obs());assert.throws(()=>normalizeLearningBody(raw),/duplicate_learning_topic/);
  const refs=body();refs.session.observations[0].source_refs.push(refs.session.observations[0].source_refs[0]);assert.throws(()=>normalizeLearningBody(refs),/duplicate_source_ref/);
  const unknown=body();unknown.session.resume.topic_id='unknown';assert.deepEqual(s.put(await command(unknown)),{error:'resume_topic_unknown',status:400});
  assert.equal(s.get(scope.course,scope.term_id).record.revision,0);
});
test('same session ID cannot be written again under a different operation even after summaries age out',async t=>{
  const {s}=fixture(t);s.put(await command());
  for(let i=1;i<=13;i++){const raw=body({expected_revision:i,idempotency_key:'op-'+i});raw.session.session_id='session-'+(i+1);s.put(await command(raw));}
  const read=s.get(scope.course,scope.term_id);assert.equal(read.record.recent_sessions.length,12);
  assert.equal(read.record.recent_sessions.some(row=>row.session_id==='session-1'),false);
  assert.equal(s.put(await command(body({expected_revision:14,idempotency_key:'duplicate-session'}))).error,'learning_session_already_saved');
});
test('preferences merge independently of coursework and learning evidence',async t=>{
  const {s}=fixture(t);s.put(await command());
  s.put(await command({action:'update_preferences',...scope,expected_revision:1,idempotency_key:'pref-1',preferences:{explanation_style:'concise',time_budget_minutes:20}}));
  s.put(await command({action:'update_preferences',...scope,expected_revision:2,idempotency_key:'pref-2',preferences:{practice_focus:'code'}}));
  const read=s.get(scope.course,scope.term_id).record;assert.deepEqual(read.preferences,{explanation_style:'concise',time_budget_minutes:20,practice_focus:'code'});assert.equal(read.topics[0].independent_demonstrations,1);
});
test('forget removes current topic, resume and recent summary references; recovery is explicit',async t=>{
  const {s}=fixture(t),first=await command();s.put(first);
  const out=s.put(await command({action:'forget_topic',...scope,expected_revision:1,idempotency_key:'forget',topic_id:'sampling-distributions'}));
  assert.equal(out.ok,true);const read=s.get(scope.course,scope.term_id);assert.deepEqual(read.record.topics,[]);assert.equal(read.record.resume,null);assert.deepEqual(read.record.recent_sessions,[]);
  assert.equal(JSON.stringify(read).includes('Sampling distributions'),false);assert.equal(s.put(first).record,undefined);
  assert.equal(read.recovery.some(row=>row.revision===1&&row.action==='forget_topic'),true);
  const restored=s.put(await command({action:'restore_revision',...scope,expected_revision:2,idempotency_key:'restore',restore_revision:1}));
  assert.equal(restored.revision,3);assert.equal(s.get(scope.course,scope.term_id).record.topics[0].label,'Sampling distributions');
});
test('forget clears potentially related free-form session goals even when other topics remain',async t=>{
  const {s}=fixture(t),raw=body();raw.session.observations.push(obs({topic_id:'confidence',label:'Confidence intervals'}));s.put(await command(raw));
  s.put(await command({action:'forget_topic',...scope,expected_revision:1,idempotency_key:'forget-one',topic_id:'sampling-distributions'}));
  const read=s.get(scope.course,scope.term_id).record;assert.equal(read.recent_sessions.length,1);assert.equal(read.recent_sessions[0].goal,'Study session');assert.deepEqual(read.recent_sessions[0].topics.map(row=>row.topic_id),['confidence']);
});
test('recoverable reset uses a new revision with only schema fields and can undo explicitly',async t=>{
  const {s}=fixture(t);s.put(await command());
  s.put(await command({action:'reset',...scope,expected_revision:1,idempotency_key:'reset'}));const read=s.get(scope.course,scope.term_id).record;
  assert.equal(read.revision,2);assert.deepEqual(read.topics,[]);assert.equal(read.action,undefined);assert.equal(read.idempotency_key,undefined);assert.equal(read.expected_revision,undefined);
  s.put(await command({action:'restore_revision',...scope,expected_revision:2,idempotency_key:'undo-reset',restore_revision:1}));assert.equal(s.get(scope.course,scope.term_id).record.revision,3);
});
test('missing topic or pruned recovery snapshot fails without mutating revision',async t=>{
  const {s}=fixture(t);assert.equal(s.put(await command({action:'forget_topic',...scope,expected_revision:0,idempotency_key:'missing',topic_id:'missing'})).error,'learning_topic_not_found');
  for(let i=0;i<12;i++)s.put(await command({action:'update_preferences',...scope,expected_revision:i,idempotency_key:'preferences-'+i,preferences:{time_budget_minutes:10+i}}));
  const read=s.get(scope.course,scope.term_id);assert.equal(read.recovery.length,LEARNING_LIMITS.recovery_revisions);assert.equal(read.recovery.some(row=>row.revision===0),false);
  assert.equal(s.put(await command({action:'restore_revision',...scope,expected_revision:12,idempotency_key:'old-restore',restore_revision:0})).error,'recovery_revision_unavailable');assert.equal(s.get(scope.course,scope.term_id).record.revision,12);
});
test('sandbox learning and all its receipts/recovery remain isolated from live student record',async t=>{
  const {s}=fixture(t),sandbox=await command(body({sandbox:true}));s.put(sandbox);
  assert.equal(s.get(scope.course,scope.term_id).record.revision,0);assert.deepEqual(s.get(scope.course,scope.term_id).recovery,[]);
  assert.equal(s.get(scope.course,scope.term_id,true).record.revision,1);
  const live=s.put(await command());assert.equal(live.ok,true);assert.equal(live.replayed,undefined);assert.equal(live.sandbox,false);
  assert.equal(s.put(sandbox).sandbox,true);assert.equal(s.get(scope.course,scope.term_id).record.revision,1);
});
test('receipt and learning changes roll back together when SQL write fails',async t=>{
  const {s,storage}=fixture(t),exec=storage.sql.exec.bind(storage.sql);storage.sql.exec=(query,...args)=>{if(query.startsWith('INSERT INTO learning_receipts'))throw new Error('simulated disk failure');return exec(query,...args);};
  const c=await command();assert.throws(()=>s.put(c),/simulated disk failure/);const read=s.get(scope.course,scope.term_id);
  assert.equal(read.record.revision,0);assert.deepEqual(read.recovery,[]);assert.deepEqual(read.record.topics,[]);
  storage.sql.exec=exec;assert.equal(s.put(c).ok,true);
});
test('receipt retention keeps newest revisions even when timestamps tie and old retries cannot resurrect data',async t=>{
  const {s}=fixture(t),first=await command();s.put(first);
  for(let i=1;i<=129;i++)s.put(await command({action:'update_preferences',...scope,expected_revision:i,idempotency_key:'preferences-'+i,preferences:{time_budget_minutes:10+i%20}}));
  assert.equal(s.rows('SELECT count(*) AS n FROM learning_receipts')[0].n,LEARNING_LIMITS.receipts);
  assert.equal(s.get(scope.course,scope.term_id).record.revision,130);
  const expired=s.put(first);assert.equal(expired.error,'revision_conflict');assert.equal(s.get(scope.course,scope.term_id).record.revision,130);
});
test('learning record capacity preserves all prior topics instead of silently evicting learning evidence',async t=>{
  const {s}=fixture(t);let revision=0;
  for(let batch=0;batch<10;batch++) {
    const raw=body({expected_revision:revision,idempotency_key:'batch-'+batch});raw.session.session_id='batch-session-'+batch;
    raw.session.observations=Array.from({length:8},(_,i)=>obs({topic_id:'topic-'+(batch*8+i),source_refs:[]}));raw.session.resume=null;
    const out=s.put(await command(raw));assert.equal(out.ok,true);revision=out.revision;
  }
  const before=s.get(scope.course,scope.term_id).record;assert.equal(before.topics.length,80);
  const raw=body({expected_revision:revision,idempotency_key:'overflow'});raw.session.session_id='overflow';raw.session.resume=null;
  assert.equal(s.put(await command(raw)).error,'learning_capacity_reached');assert.deepEqual(s.get(scope.course,scope.term_id).record,before);
});
test('safe session ID deduplication metadata has a fixed bound with no old learning prose',async t=>{
  const {s}=fixture(t);
  for(let i=0;i<=512;i++) {
    const raw=body({expected_revision:i,idempotency_key:'metadata-'+i});raw.session.session_id='metadata-session-'+i;raw.session.resume=null;
    assert.equal(s.put(await command(raw)).ok,true);
  }
  const rows=s.rows('SELECT * FROM learning_session_ids');assert.equal(rows.length,LEARNING_LIMITS.session_ids);
  assert.equal(rows.some(row=>row.session_id==='metadata-session-0'),false);assert.equal(rows.every(row=>Object.keys(row).sort().join(',')==='revision,scope,session_id'),true);
});
test('correctness is separate from assistance across every observed outcome',async t=>{
  const {s}=fixture(t);let revision=0;
  for(const demonstration of ['independent','with_hints'])for(const outcome of ['correct','partial','incorrect','not_attempted','unassessed']) {
    const topic_id=demonstration+'-'+outcome,raw=body({expected_revision:revision,idempotency_key:'outcome-'+topic_id});
    raw.session.session_id='outcome-session-'+topic_id;raw.session.observations=[obs({topic_id,demonstration,outcome})];raw.session.resume=null;
    const result=s.put(await command(raw));assert.equal(result.ok,true);revision=result.revision;
    const topic=s.get(scope.course,scope.term_id).record.topics.find(row=>row.topic_id===topic_id),independent=demonstration==='independent';
    assert.equal(topic.outcome,outcome);assert.equal(topic.independent_demonstrations,independent&&outcome==='correct'?1:0);
    assert.equal(topic.hinted_demonstrations,!independent&&outcome==='correct'?1:0);
    assert.equal(topic.independent_attempts,independent&&outcome!=='not_attempted'?1:0);
    assert.equal(topic.hinted_attempts,!independent&&outcome!=='not_attempted'?1:0);
  }
  assert.equal(s.get(scope.course,scope.term_id).record.schema_version,2);
});
test('unobserved practice and discussion cannot claim assessed outcomes',()=>{
  for(const [demonstration,evidence] of [['untested','practice_generated'],['untested','learner_report'],['explanation_only','discussion_only']]) {
    for(const outcome of ['correct','partial','incorrect','not_attempted']) {
      const raw=body();raw.session.observations=[obs({demonstration,evidence,outcome})];assert.throws(()=>normalizeLearningBody(raw),/invalid_outcome_evidence/);
    }
    const raw=body();raw.session.observations=[obs({demonstration,evidence,outcome:'unassessed'})];assert.equal(normalizeLearningBody(raw).session.observations[0].outcome,'unassessed');
  }
  for(const outcome of [null,'passed','mastered',1]) {const raw=body();raw.session.observations=[obs({outcome})];assert.throws(()=>normalizeLearningBody(raw),/invalid_outcome/);}
});
test('old requests without correctness remain retry-compatible but cannot infer understanding',async t=>{
  const {s}=fixture(t),raw=body();delete raw.session.observations[0].outcome;
  const normalized=normalizeLearningBody(raw);assert.equal(Object.hasOwn(normalized.session.observations[0],'outcome'),false);
  const canonicalV1={action:'save_session',...scope,sandbox:false,expected_revision:0,idempotency_key:'learning-1',
    session:{session_id:'session-1',goal:'Review sampling distributions',observations:[{topic_id:'sampling-distributions',label:'Sampling distributions',demonstration:'independent',evidence:'observed_response',
      practice_kind:'interpretation',misconception:'',next_step:'Apply the idea to a new sample size.',source_refs:[{doc_id:'drive-doc-1',title:'Lecture 7',locator:'slide 12'}]}],resume:{topic_id:'sampling-distributions',next_step:'Interpret a new scenario.'}}};
  assert.equal(await digest(stableJSON(normalized)),await digest(stableJSON(canonicalV1)));
  const c=await command(raw);s.put(c);const read=s.get(scope.course,scope.term_id).record;
  assert.equal(read.topics[0].outcome,'unassessed');assert.equal(read.topics[0].independent_attempts,1);assert.equal(read.topics[0].independent_demonstrations,0);
  assert.equal(read.recent_sessions[0].topics[0].outcome,'unassessed');assert.equal(s.put(c).replayed,true);assert.deepEqual(s.get(scope.course,scope.term_id).record,read);
});
function legacyRecord(revision=7) {
  const topic=obs();delete topic.outcome;
  return {schema_version:1,...scope,sandbox:false,revision,updated_at:at,topics:[{...topic,independent_demonstrations:3,hinted_demonstrations:2,last_session_id:'legacy-session',last_practiced_at:at}],
    recent_sessions:[{session_id:'legacy-session',goal:'Review a concept',at,topics:[{topic_id:topic.topic_id,demonstration:'independent',evidence:'observed_response',outcome:'correct'}]}],
    resume:{topic_id:topic.topic_id,next_step:'Check understanding with a new scenario.'},preferences:{explanation_style:'concise'}};
}
function seedLegacy(s,record=legacyRecord()) {
  s.sql.exec('INSERT INTO learning_records VALUES (?,?,?,?)',`${record.sandbox?'sandbox':'live'}:${record.term_id}:${record.course}`,record.revision,JSON.stringify(record),at);
  return record;
}
test('legacy GET conservatively projects attempts with zero successes and never writes storage',t=>{
  const {s}=fixture(t),old=seedLegacy(s),stored=s.rows('SELECT * FROM learning_records');
  const read=s.get(scope.course,scope.term_id).record,again=s.get(scope.course,scope.term_id).record;
  assert.equal(read.schema_version,2);assert.equal(read.revision,old.revision);assert.equal(read.updated_at,old.updated_at);
  assert.equal(read.topics[0].outcome,'unassessed');assert.equal(read.topics[0].independent_attempts,3);assert.equal(read.topics[0].hinted_attempts,2);
  assert.equal(read.topics[0].independent_demonstrations,0);assert.equal(read.topics[0].hinted_demonstrations,0);
  assert.equal(read.recent_sessions[0].topics[0].outcome,'unassessed');assert.deepEqual(read.resume,old.resume);assert.deepEqual(read.preferences,old.preferences);
  assert.deepEqual(again,read);assert.deepEqual(s.rows('SELECT * FROM learning_records'),stored);
  assert.deepEqual(s.rows('SELECT * FROM learning_history'),[]);assert.deepEqual(s.rows('SELECT * FROM learning_receipts'),[]);
});
test('legacy receipts remain exact replays without converting old counters or reapplying packets',async t=>{
  const {s}=fixture(t),legacy=seedLegacy(s),raw=body();delete raw.session.observations[0].outcome;
  const c=await command(raw),receipt={ok:true,operation_id:c.operation_id,...scope,sandbox:false,revision:legacy.revision,receipt:{action:'save_session',at},readback_required:true};
  s.sql.exec('INSERT INTO learning_receipts VALUES (?,?,?,?,?)','live:fall-2026:BUSN5000',c.operation_id,c.fingerprint,JSON.stringify(receipt),at);
  const stored=s.rows('SELECT * FROM learning_records');assert.deepEqual(s.put(c),{...receipt,replayed:true});assert.deepEqual(s.rows('SELECT * FROM learning_records'),stored);
  assert.equal(s.get(scope.course,scope.term_id).record.topics[0].independent_demonstrations,0);
});
test('legacy edits commit v2 once and conservative restoration cannot resurrect success counters',async t=>{
  const {s}=fixture(t),legacy=seedLegacy(s),historic=legacyRecord(6);historic.topics[0].independent_demonstrations=4;historic.topics[0].hinted_demonstrations=6;
  s.sql.exec('INSERT INTO learning_history VALUES (?,?,?,?,?)','live:fall-2026:BUSN5000',6,'save_session',JSON.stringify(historic),at);
  const edit=await command({action:'update_preferences',...scope,expected_revision:7,idempotency_key:'legacy-edit',preferences:{time_budget_minutes:15}});s.put(edit);
  const written=JSON.parse(s.rows('SELECT data FROM learning_records')[0].data);assert.equal(written.schema_version,2);assert.equal(written.topics[0].independent_attempts,3);assert.equal(written.topics[0].independent_demonstrations,0);
  const restore=await command({action:'restore_revision',...scope,expected_revision:8,idempotency_key:'legacy-restore',restore_revision:6});s.put(restore);
  const restored=s.get(scope.course,scope.term_id).record;assert.equal(restored.revision,9);assert.equal(restored.schema_version,2);assert.equal(restored.topics[0].independent_attempts,4);assert.equal(restored.topics[0].hinted_attempts,6);
  assert.equal(restored.topics[0].independent_demonstrations,0);assert.equal(restored.topics[0].hinted_demonstrations,0);assert.equal(restored.topics[0].outcome,'unassessed');
  assert.equal(s.put(restore).replayed,true);assert.equal(s.put(edit).replayed,true);assert.deepEqual(s.get(scope.course,scope.term_id).record,restored);assert.equal(legacy.revision,7);
});
test('new correct observations add one success after migration and v2 restore never double-migrates attempts',async t=>{
  const {s}=fixture(t);seedLegacy(s);const saved=await command(body({expected_revision:7,idempotency_key:'correct-after-legacy'}));s.put(saved);
  const first=s.get(scope.course,scope.term_id).record;assert.equal(first.topics[0].independent_attempts,4);assert.equal(first.topics[0].independent_demonstrations,1);assert.equal(first.topics[0].hinted_attempts,2);assert.equal(first.topics[0].hinted_demonstrations,0);
  s.put(await command({action:'reset',...scope,expected_revision:8,idempotency_key:'reset-migrated'}));
  const restore=await command({action:'restore_revision',...scope,expected_revision:9,idempotency_key:'restore-migrated',restore_revision:8});s.put(restore);
  const restored=s.get(scope.course,scope.term_id).record;assert.equal(restored.topics[0].independent_attempts,4);assert.equal(restored.topics[0].independent_demonstrations,1);assert.equal(restored.topics[0].hinted_attempts,2);
  assert.equal(s.put(restore).replayed,true);assert.equal(s.put(saved).replayed,true);assert.deepEqual(s.get(scope.course,scope.term_id).record,restored);
});
test('the teaching rollout allows only the six explicitly selected current-term courses',()=>{
  assert.equal(LEARNING_COURSE,'BUSN5000');assert.deepEqual(LEARNING_COURSES,['BUSN5000','MGMT4280','MGMT5560','MGMT5850','LAND2510','BUSN3040']);assert.equal(Object.isFrozen(LEARNING_COURSES),true);
  for(const course of LEARNING_COURSES) {
    assert.deepEqual(learningScope(course,'fall-2026'),{course,term_id:'fall-2026',sandbox:false});
    for(const term of ['fall-2025','spring-2027','Fall2026','',null])assert.throws(()=>learningScope(course,term),/invalid_learning_term/);
  }
  for(const course of ['MGMT9999','GENERAL','all','mgmt4280','MGMT 4280','BUSN5000E','LAND2510E','BUSN3040E',''])assert.throws(()=>learningScope(course,'fall-2026'),/learning_course_unavailable/);
});
function scopedRows(s,course='BUSN5000') {
  const key='live:fall-2026:'+course;
  return Object.fromEntries(['learning_records','learning_history','learning_receipts','learning_session_ids'].map(table=>[table,s.rows(`SELECT * FROM ${table} WHERE scope=? ORDER BY rowid`,key)]));
}
test('matching topic/session/operation identifiers belong to their own course records and receipts',async t=>{
  const {s,store}=fixture(t),progressBefore=store.health(),busn=await command(),mgmtRaw=body({course:'MGMT4280'});
  mgmtRaw.session.goal='Practice SQL joins';mgmtRaw.session.observations=[obs({label:'SQL joins',practice_kind:'code',outcome:'partial',next_step:'Explain join cardinality.'})];
  const mgmt=await command(mgmtRaw);assert.notEqual(busn.fingerprint,mgmt.fingerprint);
  assert.equal(s.put(busn).revision,1);const busnBefore=scopedRows(s);assert.equal(s.get('MGMT4280','fall-2026').record.revision,0);
  const mgmtSaved=s.put(mgmt);assert.equal(mgmtSaved.replayed,undefined);assert.equal(mgmtSaved.course,'MGMT4280');assert.equal(mgmtSaved.revision,1);
  assert.equal(s.get('MGMT4280','fall-2026').record.topics[0].label,'SQL joins');assert.equal(s.get('MGMT4280','fall-2026').record.topics[0].independent_demonstrations,0);
  assert.equal(s.get('BUSN5000','fall-2026').record.topics[0].label,'Sampling distributions');assert.equal(s.get('BUSN5000','fall-2026').record.topics[0].independent_demonstrations,1);
  assert.equal(s.put(busn).course,'BUSN5000');assert.equal(s.put(mgmt).course,'MGMT4280');assert.equal(s.put(mgmt).replayed,true);
  assert.deepEqual(scopedRows(s),busnBefore);assert.deepEqual(store.health(),progressBefore);assert.deepEqual(store.list('progress',['BUSN5000','MGMT4280']).records,[]);
});
test('course revisions and idempotency conflicts do not borrow another course revision or receipt',async t=>{
  const {s}=fixture(t);s.put(await command());s.put(await command({action:'update_preferences',...scope,expected_revision:1,idempotency_key:'shared-preferences',preferences:{time_budget_minutes:20}}));
  const mgmtFirst=s.put(await command(body({course:'MGMT4280'})));assert.equal(mgmtFirst.revision,1);
  const mgmtPrefs=await command({action:'update_preferences',course:'MGMT4280',term_id:'fall-2026',expected_revision:1,idempotency_key:'shared-preferences',preferences:{time_budget_minutes:45}});
  assert.equal(s.put(mgmtPrefs).revision,2);assert.equal(s.get('MGMT4280','fall-2026').record.preferences.time_budget_minutes,45);assert.equal(s.get('BUSN5000','fall-2026').record.preferences.time_budget_minutes,20);
  assert.deepEqual(s.put(await command({action:'reset',course:'MGMT4280',term_id:'fall-2026',expected_revision:0,idempotency_key:'stale-mgmt'})),{error:'revision_conflict',status:409,current_revision:2});
  const changed=await command({...mgmtPrefs.body,preferences:{time_budget_minutes:30}});assert.equal(s.put(changed).error,'idempotency_conflict');
  assert.equal(s.put(mgmtPrefs).replayed,true);assert.equal(s.get('BUSN5000','fall-2026').record.revision,2);
});
test('MGMT reset and recovery access only MGMT snapshots while every BUSN row remains untouched',async t=>{
  const {s}=fixture(t);s.put(await command());
  for(let i=1;i<=2;i++)s.put(await command({action:'update_preferences',...scope,expected_revision:i,idempotency_key:'busn-pref-'+i,preferences:{time_budget_minutes:20+i}}));
  const busnBefore=scopedRows(s),raw=body({course:'MGMT4280'});raw.session.goal='Review SQL joins';raw.session.observations=[obs({label:'SQL joins',demonstration:'with_hints',practice_kind:'code'})];
  s.put(await command(raw));const mgmtBefore=s.get('MGMT4280','fall-2026').record;
  s.put(await command({action:'reset',course:'MGMT4280',term_id:'fall-2026',expected_revision:1,idempotency_key:'reset-mgmt'}));
  assert.deepEqual(s.get('MGMT4280','fall-2026').record.topics,[]);
  assert.equal(s.put(await command({action:'restore_revision',course:'MGMT4280',term_id:'fall-2026',expected_revision:2,idempotency_key:'wrong-course-recovery',restore_revision:2})).error,'recovery_revision_unavailable');
  assert.equal(s.put(await command({action:'restore_revision',course:'MGMT4280',term_id:'fall-2026',expected_revision:2,idempotency_key:'restore-mgmt',restore_revision:1})).revision,3);
  const restored=s.get('MGMT4280','fall-2026').record;assert.equal(restored.topics[0].label,'SQL joins');assert.deepEqual(restored.topics,mgmtBefore.topics);assert.equal(restored.topics[0].hinted_demonstrations,1);
  assert.deepEqual(scopedRows(s),busnBefore);
});
test('forgetting a repeated topic in MGMT clears only MGMT handoffs and summaries',async t=>{
  const {s}=fixture(t);s.put(await command());const before=scopedRows(s);s.put(await command(body({course:'MGMT4280'})));
  s.put(await command({action:'forget_topic',course:'MGMT4280',term_id:'fall-2026',expected_revision:1,idempotency_key:'mgmt-forget',topic_id:'sampling-distributions'}));
  const mgmt=s.get('MGMT4280','fall-2026').record;assert.deepEqual(mgmt.topics,[]);assert.deepEqual(mgmt.recent_sessions,[]);assert.equal(mgmt.resume,null);
  assert.deepEqual(scopedRows(s),before);assert.equal(s.get('BUSN5000','fall-2026').record.resume.topic_id,'sampling-distributions');
});
test('both courses and their sandbox partitions isolate identical learning operations four ways',async t=>{
  const {s}=fixture(t);
  for(const course of LEARNING_COURSES)for(const sandbox of [false,true]) {
    const raw=body({course,sandbox});raw.session.observations[0].label=course+(sandbox?' sandbox':' live');assert.equal(s.put(await command(raw)).revision,1);
  }
  const before=Object.fromEntries(LEARNING_COURSES.flatMap(course=>[false,true].map(sandbox=>[course+':'+sandbox,s.get(course,'fall-2026',sandbox).record])));
  s.put(await command({action:'reset',course:'MGMT4280',term_id:'fall-2026',sandbox:true,expected_revision:1,idempotency_key:'sandbox-only-reset'}));
  for(const course of LEARNING_COURSES)for(const sandbox of [false,true]) {
    const read=s.get(course,'fall-2026',sandbox).record;
    if(course==='MGMT4280'&&sandbox) {assert.equal(read.revision,2);assert.deepEqual(read.topics,[]);}
    else assert.deepEqual(read,before[course+':'+sandbox]);
  }
});
test('MGMT retention pruning cannot prune BUSN receipts, recovery, or deduplication evidence',async t=>{
  const {s}=fixture(t),busn=await command();s.put(busn);const before=scopedRows(s);
  for(let i=0;i<=129;i++)s.put(await command({action:'update_preferences',course:'MGMT4280',term_id:'fall-2026',expected_revision:i,idempotency_key:'mgmt-preferences-'+i,preferences:{time_budget_minutes:15+i%30}}));
  assert.deepEqual(scopedRows(s),before);assert.equal(s.put(busn).replayed,true);
  assert.equal(s.get('BUSN5000','fall-2026').record.revision,1);assert.equal(s.get('MGMT4280','fall-2026').record.revision,130);
  assert.equal(s.rows('SELECT count(*) AS n FROM learning_receipts WHERE scope=?','live:fall-2026:MGMT4280')[0].n,LEARNING_LIMITS.receipts);
  assert.equal(s.get('MGMT4280','fall-2026').recovery.length,LEARNING_LIMITS.recovery_revisions);
});
test('MGMT legacy projection and restore remain conservative without migrating BUSN storage',async t=>{
  const {s}=fixture(t);s.put(await command());const before=scopedRows(s),old={...legacyRecord(),course:'MGMT4280'};seedLegacy(s,old);
  const stored=s.rows('SELECT * FROM learning_records WHERE scope=?','live:fall-2026:MGMT4280'),read=s.get('MGMT4280','fall-2026').record;
  assert.equal(read.schema_version,2);assert.equal(read.topics[0].independent_attempts,3);assert.equal(read.topics[0].independent_demonstrations,0);assert.equal(read.topics[0].outcome,'unassessed');
  assert.deepEqual(s.rows('SELECT * FROM learning_records WHERE scope=?','live:fall-2026:MGMT4280'),stored);
  s.put(await command({action:'reset',course:'MGMT4280',term_id:'fall-2026',expected_revision:7,idempotency_key:'legacy-mgmt-reset'}));
  const restored=s.put(await command({action:'restore_revision',course:'MGMT4280',term_id:'fall-2026',expected_revision:8,idempotency_key:'legacy-mgmt-restore',restore_revision:7}));
  assert.equal(restored.revision,9);assert.equal(s.get('MGMT4280','fall-2026').record.topics[0].independent_demonstrations,0);assert.deepEqual(scopedRows(s),before);
});
