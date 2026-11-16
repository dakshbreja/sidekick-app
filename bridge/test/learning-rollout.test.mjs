import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {sqliteFoundation} from './sqlite-fixture.js';
import {LEARNING_COURSES} from '../src/learning-store.js';

const KEY='invented-rollout-test-key';
const packet=(course,sandbox,revision=0,outcome='incorrect')=>({action:'save_session',course,term_id:'fall-2026',sandbox,
  expected_revision:revision,idempotency_key:'same-operation-'+revision,session:{session_id:'same-session-'+revision,goal:'Synthetic course isolation',
    observations:[{topic_id:'same-topic',label:course+' isolated practice',demonstration:'independent',evidence:'observed_response',outcome,
      practice_kind:'mixed',misconception:'Reasoning needs a fresh check',next_step:'Try original practice',source_refs:[]}],
    resume:{topic_id:'same-topic',next_step:'Try original practice'}}});

test('all six course/live/sandbox partitions isolate identical IDs, retries, counters and recoveries',async t=>{
  const f=sqliteFoundation();t.after(()=>f.close());const env={API_KEY:KEY,BRIDGE_STATE:f.binding};
  const invoke=async(path,body,auth=KEY)=>{
    const r=await worker.fetch(new Request('https://rollout.test'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+auth},...(body?{body:JSON.stringify(body)}:{})}),env);
    return {status:r.status,data:await r.json()};
  };
  const read=async(c,s)=>(await invoke('/learning?course='+c+'&term_id=fall-2026&sandbox='+s)).data.record;
  const beforeProgress=JSON.stringify(f.store.list('progress',LEARNING_COURSES));
  const snapshots=new Map();
  for(const c of LEARNING_COURSES)for(const s of [false,true]) {
    assert.equal((await invoke('/learning',packet(c,s), 'wrong-key')).status,401);
    const first=await invoke('/learning',packet(c,s));assert.equal(first.status,200);assert.equal(first.data.course,c);assert.equal(first.data.sandbox,s);
    let rec=await read(c,s);assert.equal(rec.revision,1);assert.equal(rec.topics[0].independent_attempts,1);assert.equal(rec.topics[0].independent_demonstrations,0);
    const partial=await invoke('/learning',packet(c,s,1,'partial'));assert.equal(partial.status,200);
    const correct=await invoke('/learning',packet(c,s,2,'correct'));assert.equal(correct.status,200);
    rec=await read(c,s);assert.equal(rec.revision,3);assert.equal(rec.topics[0].independent_attempts,3);assert.equal(rec.topics[0].independent_demonstrations,1);
    const replay=await invoke('/learning',packet(c,s,2,'correct'));assert.equal(replay.data.replayed,true);assert.deepEqual(await read(c,s),rec);
    snapshots.set(c+':'+s,rec);
  }
  const target='MGMT5850',sandbox=false;
  const reset=await invoke('/learning',{action:'reset',course:target,term_id:'fall-2026',sandbox,expected_revision:3,idempotency_key:'reset-one'});
  assert.equal(reset.status,200);assert.equal((await read(target,sandbox)).topics.length,0);
  for(const c of LEARNING_COURSES)for(const s of [false,true])if(c!==target||s!==sandbox)assert.deepEqual(await read(c,s),snapshots.get(c+':'+s));
  const restored=await invoke('/learning',{action:'restore_revision',course:target,term_id:'fall-2026',sandbox,expected_revision:4,idempotency_key:'restore-one',restore_revision:3});
  assert.equal(restored.status,200);assert.deepEqual((await read(target,sandbox)).topics,snapshots.get(target+':'+sandbox).topics);
  assert.equal(JSON.stringify(f.store.list('progress',LEARNING_COURSES)),beforeProgress);
});

test('each newly enabled course rejects restricted/raw evidence without a learning or coursework write',async t=>{
  const f=sqliteFoundation();t.after(()=>f.close());const env={API_KEY:KEY,BRIDGE_STATE:f.binding};
  for(const course of LEARNING_COURSES)for(const kind of ['grade','raw-answer']) {
    const p=packet(course,false);if(kind==='grade')p.session.goal='Grade: 91%';else p.session.observations[0].raw_answer='Whole response';
    const r=await worker.fetch(new Request('https://rollout.test/learning',{method:'POST',headers:{Authorization:'Bearer '+KEY},body:JSON.stringify(p)}),env);
    assert.equal(r.status,400);
  }
  for(const table of ['learning_records','learning_history','learning_receipts','records'])assert.equal(f.db.prepare('SELECT count(*) AS count FROM '+table).get().count,0);
});
