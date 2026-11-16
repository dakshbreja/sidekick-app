import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sqliteFoundation} from './sqlite-fixture.js';
import {eventIdentity,decodeIdentity,resolveReportIdentity,sameAssignment,TERM_ID} from '../src/identity.js';
import {buildStatus,loadEvents,normalizeEvents} from '../src/status.js';
import {calendarText,validateCalendar,MAX_FEED_BYTES} from '../src/feed-reader.js';
import {parseICS} from '../src/ics.js';
import {digest} from '../src/foundation.js';
import worker from '../src/worker.js';
import {PASS_PROTOCOL_RECORD_ID} from '../src/record-store.js';

const now=new Date('2026-09-05T12:00:00Z');
// Identity fixtures represent authoritative school deadlines; ordinary personal
// events now belong to the agenda rather than the required-work list.
const event=(over={})=>({uid:'one',summary:'Report',source:'elc',description:'',location:'',
  start:new Date('2026-09-06T12:00:00Z'),allDay:false,recurring:false,...over});
const status=(events,progress=[])=>buildStatus({events,progress,now,health:[{source:'elc',ok:true}]});
const deadlines=s=>[...s.overdue,...s.due_today,...s.due_this_week,...s.upcoming];
const identity=(ev=event(),previous=[],body={})=>resolveReportIdentity({item:'Report',...body},deadlines(status([ev])),previous,'GENERAL');
const command=(operation_id,body={},id=identity(),kind='progress')=>({
  operation_id,fingerprint:JSON.stringify(body),kind,course:'GENERAL',
  body:kind==='progress'?{item:'Report',status:'done',...body}:{text:'class fixture',title:'Class',date:'2026-09-05',...body},
  identity:id,new_record_id:'record-'+operation_id,at:now.toISOString(),at_local:'Sat, Sep 5',via:'test'
});
function fixture(t,options) {const f=sqliteFoundation(options);t.after(()=>f.close());return f;}

test('renaming and rescheduling the same source assignment preserves completion',()=>{
  const report={...identity(),item:'Report',status:'done',course:'GENERAL'};
  const s=status([event({summary:'Renamed deliverable',start:new Date('2026-09-08T12:00:00Z')})],[report]);
  assert.equal(s.actionable.counts.completed,1);
  assert.equal(s.actionable.completed[0].title,'Renamed deliverable');
  assert.equal(s.actionable.completed[0].submission_verification,'reported');
});
test('a new source identity reusing a title NEVER inherits its old completion',()=>{
  const report={...identity(),item:'Report',status:'done',course:'GENERAL'};
  const replacement=event({uid:'two'});
  assert.equal(status([replacement],[report]).actionable.counts.completed,0);
  assert.equal(identity(replacement,[report]).error,'reused_title_needs_reference');
  assert.equal(identity(replacement,[report],{when_iso:replacement.start.toISOString()}).identity_resolution,'linked');
});
test('identity isolates source, course, term and recurrence; title/date are not identity',()=>{
  const a=eventIdentity(event());
  assert.notEqual(a,eventIdentity(event({source:'personal'})));
  assert.notEqual(a,eventIdentity({...event(),course:{code:'BUSN5000'}}));
  assert.notEqual(a,eventIdentity(event({recurrence_anchor:'2026-09-06T12:00:00Z'})));
  assert.equal(a,eventIdentity(event({summary:'rename',start:new Date('2026-09-08')})));
  assert.equal(decodeIdentity(a).term,TERM_ID);
  assert.equal(sameAssignment({...identity(),term_id:'spring-2026'},identity()),false);
});
test('different source records with identical titles/dates remain ambiguous',()=>{
  const pool=deadlines(status([event(),event({uid:'two'})]));
  assert.equal(pool.length,2);
  const r=resolveReportIdentity({item:'Report'},pool,[],'GENERAL');
  assert.equal(r.error,'ambiguous_assignment');assert.equal(r.candidates.length,2);
});
test('missing UID and historical title-only reports never clear an assignment',()=>{
  assert.equal(identity(event({uid:''})).identity_reason,'source_has_no_stable_identity');
  const s=status([event()],[{item:'Report',status:'done',course:'GENERAL',note:'legacy fixture'}]);
  assert.equal(s.actionable.counts.completed,0);assert.equal(s.identity_review.length,1);
  assert.equal(s.progress[0].note,'legacy fixture');
});
test('old aliases work only when their original source identity remains current',()=>{
  const prior={...identity(),item:'Old title',title_aliases:['Original name']};
  assert.equal(identity(event({summary:'New title'}),[prior],{item:'Original name'}).identity_resolution,'linked');
  assert.equal(identity(event({uid:'new',summary:'New title'}),[prior],{item:'Original name'}).assignment_id,null);
});
test('a scoped explicit identity cannot be used in another course or term',()=>{
  const pool=deadlines(status([event()]));
  assert.equal(resolveReportIdentity({item:'Report',assignment_id:pool[0].assignment_id},pool,[],'BUSN5000').error,'assignment_scope_mismatch');
  assert.equal(resolveReportIdentity({item:'Report',term_id:'spring-2026'},pool,[],'GENERAL').error,'wrong_term');
});
test('recurrence overrides retain the original occurrence anchor when moved',()=>{
  const ics='BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:r\nDTSTART:20260906T120000Z\nRRULE:FREQ=DAILY;COUNT=2\nSUMMARY:R\nEND:VEVENT\nBEGIN:VEVENT\nUID:r\nRECURRENCE-ID:20260907T120000Z\nDTSTART:20260907T140000Z\nSUMMARY:R moved\nEND:VEVENT\nEND:VCALENDAR';
  const ev=parseICS(ics,{windowStart:new Date('2026-09-05'),windowEnd:new Date('2026-09-09'),source:'personal'});
  assert.equal(ev.find(e=>e.summary==='R moved').recurrence_anchor,'2026-09-07T12:00:00.000Z');
});
test('concurrent distinct progress writes preserve both records and both histories',async t=>{
  const f=fixture(t);
  const out=await Promise.all([f.stub.mutate(command('a')),f.stub.mutate(command('b',{item:'Second'},identity(event({uid:'two',summary:'Second'}),[],{item:'Second'})))]);
  assert.ok(out.every(r=>r.ok));assert.equal(f.store.list('progress',['GENERAL']).records.length,2);
  assert.equal(f.store.history(out[0].recorded.record_id).history.length,1);
  assert.equal(f.store.history(out[1].recorded.record_id).history.length,1);
});
test('concurrent class-note sessions are retained; upsert revisions prevent stale overwrites',async t=>{
  const f=fixture(t);
  await Promise.all(['a','b'].map(session_id=>f.stub.mutate(command(session_id,{session_id},null,'classnote'))));
  assert.equal(f.store.list('classnote',['GENERAL']).records.length,2);
  const first=f.store.mutate(command('a2',{session_id:'a',expected_revision:1,text:'updated'},null,'classnote'));
  assert.equal(first.revision,2);
  assert.equal(f.store.mutate(command('a3',{session_id:'a',expected_revision:1,text:'stale'},null,'classnote')).error,'revision_conflict');
  assert.equal(f.store.list('classnote',['GENERAL']).records.find(r=>r.session_id==='a').text,'updated');
});
test('idempotency receipts survive response loss; conflicting reuse is rejected',t=>{
  const f=fixture(t),cmd=command('a');
  const one=f.store.mutate(cmd),retry=f.store.mutate(cmd);
  assert.equal(retry.replayed,true);assert.equal(retry.recorded.record_id,one.recorded.record_id);
  assert.equal(f.store.history(one.recorded.record_id).history.length,1);
  assert.equal(f.store.mutate({...cmd,fingerprint:'different'}).error,'idempotency_conflict');
});
test('a failure writing the receipt rolls back record and history together',t=>{
  const f=fixture(t),real=f.storage.sql.exec;
  f.storage.sql.exec=(query,...args)=>{if(query.startsWith('INSERT INTO receipts'))throw Error('fixture fault');return real(query,...args);};
  assert.throws(()=>f.store.mutate(command('a')),/fixture fault/);
  f.storage.sql.exec=real;
  assert.equal(f.store.list('progress',['GENERAL']).records.length,0);
  assert.equal(f.store.history('record-a').history.length,0);
  assert.equal(f.store.receipt('a','{}'),null);
});
test('relinking requires explicit selection plus revision and never transfers evidence',t=>{
  const f=fixture(t);
  const first=f.store.mutate(command('a',{verification:'verified',evidence:'synthetic receipt'}));
  const body={record_id:first.recorded.record_id,expected_revision:1};
  const replacement=identity(event({uid:'two'}));
  assert.equal(f.store.mutate(command('b',body,replacement)).error,'explicit_relink_required');
  const moved=f.store.mutate(command('c',{...body,relink:true},replacement));
  assert.equal(moved.ok,true);assert.equal(moved.recorded.evidence,null);
  assert.equal(moved.recorded.verification,'reported');
  assert.equal(f.store.history(first.recorded.record_id).history[1].data.before.evidence,'synthetic receipt');
});
test('non-done records expose revisions to clients without clearing deadlines',t=>{
  const f=fixture(t),r=f.store.mutate(command('a',{status:'in_progress'}));
  const s=status([event()],[r.recorded]),d=deadlines(s)[0];
  assert.equal(d.progress_record.revision,1);assert.equal(d.outstanding,true);
  assert.equal(s.actionable.outstanding[0].progress_record.record_id,r.recorded.record_id);
});
test('migration blocks early writes, keeps all legacy data, and is idempotent',t=>{
  const f=fixture(t,{ready:false});
  assert.equal(f.store.mutate(command('early')).error,'records_initializing');
  const start=f.store.beginMigration(now.getTime());
  const snapshot={term_id:TERM_ID,progress:{GENERAL:[{item:'Report',status:'done',note:'original note'}]},classnote:{GENERAL:[{text:'original class note'}]}};
  assert.equal(f.store.initialize(snapshot,'hash',start.not_before-1).error,'migration_cooldown');
  assert.equal(f.store.initialize(snapshot,'hash',start.not_before).imported,2);
  const row=f.store.list('progress',['GENERAL']).records[0];
  assert.equal(row.assignment_id,null);assert.equal(row.note,'original note');
  assert.equal(f.store.history(row.record_id).history[0].data.original.note,'original note');
  assert.equal(f.store.initialize(snapshot,'second',start.not_before).already_initialized,true);
  assert.equal(f.store.list('progress',['GENERAL']).records.length,1);
});
test('class-note display cap does not delete older sessions',t=>{
  const f=fixture(t);
  for(let i=0;i<20;i++)f.store.mutate(command('c'+i,{session_id:'session'+i},null,'classnote'));
  assert.equal(f.store.list('classnote',['GENERAL']).records.length,14);
  assert.equal(f.store.health().counts.find(c=>c.kind==='classnote').count,20);
});
test('HTTP 200 HTML is a failed calendar, while a real empty calendar is valid',async()=>{
  assert.throws(()=>validateCalendar('<html>Sign in</html>'),/invalid_calendar/);
  assert.doesNotThrow(()=>validateCalendar('BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR'));
  const {events,health}=await loadEvents([{name:'private',url:'https://private.invalid/secret-token'}],{fetchImpl:async()=>new Response('<html>login</html>')});
  assert.equal(events.length,0);assert.equal(health[0].ok,false);assert.equal(health[0].error,'invalid_calendar');
  assert.ok(!JSON.stringify(health).includes('secret-token'));
});
test('truncated, nested and missing-date events do not become healthy empty calendars',async()=>{
  for(const text of ['BEGIN:VCALENDAR\nEND:VEVENT','BEGIN:VCALENDAR\nBEGIN:VCALENDAR\nEND:VCALENDAR\nEND:VCALENDAR'])
    assert.throws(()=>validateCalendar(text),/invalid_calendar/);
  const {health}=await loadEvents([{name:'test',url:'https://test.invalid'}],{fetchImpl:async()=>new Response('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nSUMMARY:Broken\nEND:VEVENT\nEND:VCALENDAR')});
  assert.equal(health[0].ok,false);
});
test('calendar body size and a stalled body are bounded',async()=>{
  await assert.rejects(calendarText(new Response('x'.repeat(MAX_FEED_BYTES+1))),/calendar_too_large/);
  let cancelled=false;
  const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('BEGIN:VCALENDAR\n'));},cancel(){cancelled=true;}});
  const controller=new AbortController();
  const pending=calendarText(new Response(stream),controller.signal);
  controller.abort();
  await assert.rejects(pending);assert.equal(cancelled,true);
});
function authEnv(t,opts) {
  const f=fixture(t,opts),kv=new Map();
  return {f,env:{API_KEY:'synthetic-test-key',BRIDGE_STATE:f.binding,NOTES:{get:async k=>kv.get(k)||null,put:async(k,v)=>kv.set(k,v)}}};
}
const passCommand=(key,over={})=>({...command(key,{session_id:'pass:'+key},null,'classnote'),course:'BUSN5000',...over});
const privateRequest=(path,options={})=>request(path,{...options,headers:{Authorization:'Bearer synthetic-test-key',...options.headers}});

test('PASS catalog and protocol use existing authentication and exact protocol identity',async t=>{
  const {f,env}=authEnv(t);
  for(const path of ['/pass','/pass/courses','/pass/protocol'])assert.equal((await worker.fetch(request(path),env)).status,401);
  const catalog=await (await worker.fetch(privateRequest('/pass/courses'),env)).json();
  assert.equal(catalog.term_id,TERM_ID);assert.equal(catalog.courses.length,6);
  assert.ok(catalog.courses.some(c=>c.code==='BUSN3040'&&c.title.includes('R Programming')));
  assert.equal((await worker.fetch(privateRequest('/pass/protocol'),env)).status,404);
  const protocol=f.store.mutate(passCommand('protocol',{new_record_id:PASS_PROTOCOL_RECORD_ID,body:{text:'Protocol for all classes',title:'PASS protocol',date:'2026-01-01'}})).recorded;
  for(let i=0;i<20;i++)f.store.mutate(passCommand('lecture'+i,{body:{text:'Lecture',date:'2026-10-31',title:'Class'}}));
  assert.ok(!f.store.list('classnote',['BUSN5000']).records.some(r=>r.record_id===protocol.record_id));
  const result=await (await worker.fetch(privateRequest('/pass/protocol'),env)).json();
  assert.deepEqual(result.record,protocol);assert.equal(result.scope,'all_classes');
  assert.deepEqual((await (await worker.fetch(privateRequest('/pass'),env)).json()).records,[]);
});

test('PASS discovery bypasses lecture previews and orders by save time with bounded metadata pages',async t=>{
  const {f,env}=authEnv(t),expected=[];
  for(let i=0;i<24;i++)expected.push(f.store.mutate(passCommand('p'+i,{at:new Date(now.getTime()+i*1000).toISOString(),body:{session_id:'pass:p'+i,date:'2020-01-01',title:'Session '+i,text:'Exact portable Markdown '+i}})).recorded);
  for(let i=0;i<20;i++)f.store.mutate(passCommand('lecture'+i,{body:{text:'unrelated lecture',date:'2026-10-31'}}));
  assert.equal(f.store.list('classnote',['BUSN5000']).records.some(r=>r.session_id?.startsWith('pass:')),false);
  const pages=[];let cursor=null;
  do {
    const query=new URLSearchParams({course:'BUSN5000',limit:'3'});if(cursor)query.set('cursor',cursor);
    const response=await worker.fetch(privateRequest('/pass?'+query),env);assert.equal(response.status,200);
    const out=await response.json();assert.ok(out.records.length<=3);assert.equal(out.courses_with_passes[0].count,24);
    assert.ok(out.records.every(r=>!Object.hasOwn(r,'text')));pages.push(...out.records);cursor=out.next_cursor;
  }while(cursor);
  assert.deepEqual(pages.map(r=>r.record_id),expected.reverse().map(r=>r.record_id));
  const exact=await (await worker.fetch(privateRequest('/pass?record_id='+expected.at(-1).record_id),env)).json();
  assert.deepEqual(exact.record,expected.at(-1));
});

test('PASS pagination tie breaker does not duplicate records when a newer save arrives',async t=>{
  const {f,env}=authEnv(t);
  for(const key of ['a','b','c','d'])f.store.mutate(passCommand(key));
  const one=await (await worker.fetch(privateRequest('/pass?limit=2'),env)).json();
  f.store.mutate(passCommand('new',{at:'2026-10-31T22:00:00.000Z'}));
  const two=await (await worker.fetch(privateRequest('/pass?limit=2&cursor='+encodeURIComponent(one.next_cursor)),env)).json();
  assert.equal(new Set([...one.records,...two.records].map(r=>r.record_id)).size,4);assert.equal(two.next_cursor,null);
});

test('PASS and synthetic tests preserve all thirteen existing lecture notes and isolate test discovery',async t=>{
  const {f,env}=authEnv(t);
  for(let i=0;i<13;i++)f.store.mutate(passCommand('lecture'+i,{body:{session_id:'lecture'+i,date:'2026-10-01',title:'Original '+i,text:'Existing note '+i}}));
  const before=f.store.list('classnote',['BUSN5000']).records;
  const real=f.store.mutate(passCommand('real')).recorded;
  const synthetic=f.store.mutate(passCommand('synthetic',{body:{session_id:'pass:test:synthetic',date:'2026-10-31',title:'Synthetic connection test',text:'No student work is asserted.'}})).recorded;
  f.store.mutate(passCommand('general',{course:'GENERAL'}));
  assert.deepEqual(f.store.list('classnote',['BUSN5000']).records,before);
  const normal=await (await worker.fetch(privateRequest('/pass'),env)).json();
  assert.deepEqual(normal.records.map(r=>r.record_id),[real.record_id]);
  const tests=await (await worker.fetch(privateRequest('/pass?sandbox=true'),env)).json();
  assert.deepEqual(tests.records.map(r=>r.record_id),[synthetic.record_id]);
  assert.equal((await worker.fetch(privateRequest('/pass?record_id='+synthetic.record_id),env)).status,404);
  const exact=await (await worker.fetch(privateRequest('/pass?sandbox=true&record_id='+synthetic.record_id),env)).json();
  assert.deepEqual(exact.record,synthetic);
  assert.equal((await worker.fetch(privateRequest('/pass?sandbox=1'),env)).status,400);
});

test('PASS lookups isolate course and term and never return lecture/protocol records as sessions',async t=>{
  const {f,env}=authEnv(t);
  const a=f.store.mutate(passCommand('a',{body:{session_id:'pass:shared',date:'2026-09-05',title:'First',text:'first class'}})).recorded;
  const b=f.store.mutate(passCommand('b',{course:'MGMT4280',body:{session_id:'pass:shared',date:'2026-09-05',title:'Second',text:'second class'}})).recorded;
  const lecture=f.store.mutate(passCommand('lecture',{body:{session_id:'lecture',text:'not a PASS'}})).recorded;
  const old=f.store.mutate(passCommand('old')).recorded;old.term_id='spring-2026';
  f.storage.sql.exec('UPDATE records SET data=? WHERE record_id=?',JSON.stringify(old),old.record_id);
  for(const path of ['/pass?course=MGMT4280&record_id='+a.record_id,'/pass?record_id='+lecture.record_id,'/pass?record_id='+old.record_id])
    assert.equal((await worker.fetch(privateRequest(path),env)).status,404);
  const shared=await (await worker.fetch(privateRequest('/pass?session_id=pass%3Ashared'),env)).json();
  assert.equal(shared.records.length,2);assert.equal(shared.courses_with_passes.length,2);
  const scoped=await (await worker.fetch(privateRequest('/pass?course=4280&session_id=pass%3Ashared'),env)).json();
  assert.deepEqual(scoped.records.map(r=>r.record_id),[b.record_id]);
});

test('PASS query validation rejects malformed and unbounded selections',async t=>{
  const {env}=authEnv(t);
  for(const query of ['limit=0','limit=21','limit=1.5','limit=','course=GENERAL','course=','course=BUSN5000&course=MGMT4280',
    'session_id=lecture','record_id=','record_id=a&session_id=pass%3Ab','cursor=%7B%7D','cursor=null','cursor=%5B%22bad%22%2C%22id%22%5D','unknown=x']) {
    const result=await worker.fetch(privateRequest('/pass?'+query),env);assert.equal(result.status,400,query);
  }
  for(const path of ['/pass','/pass/courses','/pass/protocol'])assert.equal((await worker.fetch(privateRequest(path,{method:'POST',body:'{}'}),env)).status,405);
});

test('PASS writes keep atomic retries and corrections and preserve other school state',async t=>{
  const {f,env}=authEnv(t);
  const other=f.store.mutate(command('ordinary',{note:'existing provenance',verification:'verified',evidence:'fixture receipt'})).recorded;
  const lecture=f.store.mutate(passCommand('lecture',{body:{session_id:'lecture',text:'existing lecture',date:'2026-10-01',title:'Original'}})).recorded;
  const learningBefore=f.learningStore.get('BUSN5000',TERM_ID,false);
  const payload={course:'BUSN5000',session_id:'pass:save',title:'PASS facts',date:'2026-10-31',text:'# PASS\nExact factual note',expected_revision:0,idempotency_key:'pass-save'};
  const save=async body=>worker.fetch(privateRequest('/classnote',{method:'POST',body:JSON.stringify(body)}),env);
  const first=await (await save(payload)).json(),retry=await (await save(payload)).json();
  assert.equal(first.ok,true);assert.equal(retry.replayed,true);assert.deepEqual(retry.recorded,first.recorded);
  assert.equal(f.store.history(first.recorded.record_id).history.length,1);
  assert.equal((await save({...payload,text:'different'})).status,409);
  const correction={...payload,record_id:first.recorded.record_id,expected_revision:1,idempotency_key:'pass-correct',text:'Corrected factual note'};
  const updated=await (await save(correction)).json();assert.equal(updated.revision,2);
  assert.equal((await save({...correction,idempotency_key:'stale'})).status,409);
  const read=await (await worker.fetch(privateRequest('/pass?record_id='+first.recorded.record_id),env)).json();
  assert.deepEqual(read.record,updated.recorded);assert.equal(read.record.session_id,payload.session_id);
  assert.deepEqual(f.store.list('progress',['GENERAL']).records,[other]);
  assert.deepEqual(f.store.list('classnote',['BUSN5000']).records.find(r=>r.record_id===lecture.record_id),lecture);
  assert.deepEqual(f.learningStore.get('BUSN5000',TERM_ID,false),learningBefore);
  assert.equal(f.store.history(first.recorded.record_id).history.length,2);
});

test('PASS unavailable storage is an explicit error, never empty successful history',async t=>{
  const {env}=authEnv(t,{ready:false});
  for(const path of ['/pass','/pass/protocol']) {
    const response=await worker.fetch(privateRequest(path),env);assert.equal(response.status,503);
    assert.equal((await response.json()).error,'records_initializing');
  }
});
const request=(path,options={})=>new Request('https://bridge.test'+path,options);
const form=(key='synthetic-test-key',extra={})=>request('/app/session',{method:'POST',headers:{Origin:'https://bridge.test','Content-Type':'application/x-www-form-urlencoded',...extra},body:new URLSearchParams({access_key:key,returnTo:'/app/system'})});
async function signIn(env) {
  const r=await worker.fetch(form(),env);assert.equal(r.status,303);
  return {r,cookie:r.headers.getSetCookie().find(v=>v.startsWith('__Host-bridge_session=')).split(';')[0]};
}
test('fresh browser gets a sign-in page; private APIs still require authentication',async t=>{
  const {env}=authEnv(t);
  for(const path of ['/app','/app/system','/app/sign-in']) {const r=await worker.fetch(request(path),env);assert.equal(r.status,200);assert.match(await r.text(),/access_key/);}
  assert.equal((await worker.fetch(request('/status'),env)).status,401);
});
test('browser cookie is opaque, hashed at rest, secure, and revocable',async t=>{
  const {f,env}=authEnv(t),{r,cookie}=await signIn(env);
  assert.match(r.headers.getSetCookie()[0],/HttpOnly; Secure; SameSite=Lax; Path=\//);
  assert.ok(!cookie.includes(env.API_KEY));assert.equal(r.headers.get('location'),'/app/system');
  const token=cookie.split('=')[1];
  assert.equal(f.store.rows('SELECT token_hash FROM sessions')[0].token_hash,await digest(token));
  assert.equal((await worker.fetch(request('/foundation/health',{headers:{Cookie:cookie}}),env)).status,200);
  const out=await worker.fetch(request('/app/sign-out',{method:'POST',headers:{Cookie:cookie,Origin:'https://bridge.test'}}),env);
  assert.equal(out.status,303);
  assert.equal((await worker.fetch(request('/foundation/health',{headers:{Cookie:cookie}}),env)).status,401);
});
test('expired cookies and credential rotation invalidate sessions',async t=>{
  const {f,env}=authEnv(t),{cookie}=await signIn(env);
  assert.equal((await worker.fetch(request('/foundation/health',{headers:{Cookie:cookie}}),{...env,API_KEY:'rotated-key'})).status,401);
  f.advance(31*86400000);
  assert.equal((await worker.fetch(request('/foundation/health',{headers:{Cookie:cookie}}),env)).status,401);
});
test('browser writes require exact Origin; bearer integrations retain their API contract',async t=>{
  const {env}=authEnv(t),{cookie}=await signIn(env);
  for(const origin of [undefined,'https://attacker.invalid']) {
    const headers={Cookie:cookie};if(origin)headers.Origin=origin;
    assert.equal((await worker.fetch(request('/note',{method:'POST',headers,body:'{}'}),env)).status,403);
  }
  assert.equal((await worker.fetch(request('/classnote',{method:'POST',headers:{Authorization:'Bearer '+env.API_KEY},body:JSON.stringify({course:'GENERAL',text:'test note'})}),env)).status,200);
});
test('malformed cookies do not crash; legacy cookies upgrade without a new URL credential',async t=>{
  const {env}=authEnv(t);
  assert.equal((await worker.fetch(request('/status',{headers:{Cookie:'bridge_k=%zz; __Host-bridge_session=%zz'}}),env)).status,401);
  const upgraded=await worker.fetch(request('/app',{headers:{Cookie:'bridge_k='+env.API_KEY}}),env);
  assert.equal(upgraded.status,303);assert.ok(!upgraded.headers.get('set-cookie').includes(env.API_KEY));
});
test('key-bearing bookmarks cannot create sessions or identify the correct key',async t=>{
  const {f,env}=authEnv(t);
  for(const key of [env.API_KEY,'wrong','%zz',encodeURIComponent('slash/key')]) {
    for(const method of ['GET','HEAD','POST']) {
      const r=await worker.fetch(request('/app/'+key,{method}),env);
      assert.equal(r.status,method==='POST'?410:303);
      assert.equal(r.headers.get('set-cookie'),null);
      assert.equal(r.headers.get('referrer-policy'),'no-referrer');
      assert.equal(r.headers.get('cache-control'),'no-store');
      assert.equal(await r.text(),'');
      if(method!=='POST')assert.equal(r.headers.get('location'),'/app/sign-in?returnTo=%2Fapp&reason=legacy_url');
    }
  }
  assert.equal(f.store.rows('SELECT * FROM sessions').length,0);
  const clean=await worker.fetch(request('/app/sign-in?returnTo=%2Fapp&reason=legacy_url'),env);
  assert.equal(clean.status,200);assert.match(await clean.text(),/Key-in-link sign-in has been retired/);
  const {cookie}=await signIn(env);
  const signedIn=await worker.fetch(request('/app/sign-in?reason=legacy_url',{headers:{Cookie:cookie}}),env);
  assert.equal(signedIn.status,303);assert.equal(signedIn.headers.get('location'),'/app');
  assert.equal(f.store.rows('SELECT * FROM sessions').length,1);
});
test('wrong credentials, excessive attempts, and foreign sign-in origins fail clearly',async t=>{
  const {env}=authEnv(t);
  assert.equal((await worker.fetch(form('synthetic-test-key',{Origin:'https://attacker.invalid'}),env)).status,403);
  for(let i=0;i<8;i++)assert.equal((await worker.fetch(form('wrong'),env)).status,401);
  const limited=await worker.fetch(form(),env);
  assert.equal(limited.status,429);assert.ok(Number(limited.headers.get('Retry-After'))>0);
});
test('missing record storage cannot yield a false empty success',async t=>{
  const {env}=authEnv(t,{ready:false});
  const r=await worker.fetch(request('/progress?course=GENERAL',{headers:{Authorization:'Bearer '+env.API_KEY}}),env);
  assert.equal(r.status,503);assert.equal((await r.json()).error,'records_initializing');
});
