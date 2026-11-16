import {test} from 'node:test';
import assert from 'node:assert/strict';
import {announcementContext,announcementRoutes,readAnnouncementRecord,scopedAnnouncementSummary} from '../src/announcement-context.js';
import {AnnouncementStore,ANNOUNCEMENT_COURSES,validateAnnouncementSnapshot} from '../src/announcement-store.js';
import {loadEvents,buildStatus,normalizeEvents} from '../src/status.js';
import {buildAgenda} from '../src/agenda.js';
import {eventIdentity,TERM_ID} from '../src/identity.js';
import {courseForEvent} from '../src/courses.js';
import {digest,stableJSON} from '../src/foundation.js';
import {reviewedDateCorrections} from '../src/reviewed-date-corrections.js';
import {sqliteFoundation} from './sqlite-fixture.js';
import worker from '../src/worker.js';

const at='2026-10-11T00:20:00.000Z',now=new Date('2026-10-11T00:30:00.000Z');
const windowStart=new Date('2026-10-01T04:00:00Z'),windowEnd=new Date('2026-11-01T04:00:00Z');
const source='eLC (D2L)',seed=reviewedDateCorrections[0],codes=Object.keys(ANNOUNCEMENT_COURSES).sort();
function news(extra={}) {
  return {announcement_id:'7098040',course_code:'MGMT5560',term_id:TERM_ID,org_unit_id:'3963225',
    title:'Test 2 date change',text:'Test 2 has been moved from October 14 to October 19.',
    source_url:seed.authority.url,published_at:'2026-10-05T18:29:00.000Z',modified_at:null,
    feed_published_at:null,observed_at:at,content_sha256:'a'.repeat(64),privacy_redacted:false,...extra};
}
function snapshot(extra={}) {
  return {schema_version:1,source,term_id:TERM_ID,attempted_at:at,last_success_at:at,last_complete_success_at:at,
    expected_courses:codes,coverage:codes.map(course_code=>({course_code,org_unit_id:ANNOUNCEMENT_COURSES[course_code],
      status:'ok',scope:'full_listing',complete:true,error:null,checked_at:at,last_success_at:at,last_complete_success_at:at})),
    announcements:[news()],...extra};
}
function event(extra={}) {return {uid:seed.uid,summary:seed.title,source,recurrence_anchor:'',
  location:'Classroom MGMT5560',description:'In class',recurring:false,allDay:false,
  start:new Date(seed.original.start_iso),end:new Date(seed.original.end_iso),...extra};}
const record=(raw=snapshot(),evidence=[])=>({ok:true,revision:1,snapshot:validateAnnouncementSnapshot(raw,null,now),evidence});
function fixture(t) {
  const f=sqliteFoundation();t.after(()=>f.close());const s=new AnnouncementStore(f.storage);
  Object.assign(f.stub,{announcementGet:async()=>s.get(),announcementPut:async c=>s.put(c),
    announcementReceipt:async(i,h)=>s.receipt(i,h),announcementEvidence:async()=>s.evidence()});
  return {f,s,env:{BRIDGE_STATE:f.binding,API_KEY:'test-key'}};
}
async function save(s,raw,operation='test-source-read') {
  const previous=s.get(),received=new Date(raw.attempted_at),data=validateAnnouncementSnapshot(raw,previous.snapshot,received);
  return s.put({snapshot:data,expected_revision:previous.revision,operation_id:operation,
    fingerprint:await digest(stableJSON(raw)),snapshot_digest:await digest(stableJSON(data)),at:received.toISOString()});
}
function feed(day='14',uid=seed.uid) {return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:Test Two Administered\r\nLOCATION:Classroom MGMT5560\r\nDTSTART:202610${day}T171500Z\r\nDTEND:202610${day}T183500Z\r\nEND:VEVENT\r\nEND:VCALENDAR`;}
const feeds=[{name:source,url:'https://fixture.test/calendar'}];
const request=(path,body)=>new Request('https://bridge.test'+path,{method:body?'POST':'GET',
  headers:{Authorization:'Bearer test-key','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});

test('automatic source observation corrects October 14 to October 19 with its own exact hash and evidence',()=>{
  const original=event(),before=structuredClone(original),context=announcementContext(record(),[original],now);
  assert.equal(context.corrections.length,1);assert.equal(context.corrections[0].effective.start_iso,'2026-10-19T04:00:00.000Z');
  assert.equal(context.corrections[0].authority.automatic,true);assert.equal(context.corrections[0].authority.content_sha256,'a'.repeat(64));
  assert.equal(context.corrections[0].uid,seed.uid);assert.equal(context.summary.status,'healthy');assert.equal(context.summary.change_safe,true);
  assert.deepEqual(original,before);assert.equal(JSON.stringify(context.summary).includes(news().text),false);
});
test('same-ID observed edits replay the exact 19 to 21 to 23 chain while current evidence alone controls the final date',()=>{
  const first=news({observed_at:'2026-10-11T00:10:00Z'}),second=news({text:'Test 2 has been moved from October 19 to October 21.',
    observed_at:'2026-10-11T00:15:00Z',content_sha256:'b'.repeat(64)}),third=news({text:'Test 2 has been moved from October 21 to October 23.',content_sha256:'c'.repeat(64)});
  const current=record(snapshot({announcements:[third]}),[second,first]),context=announcementContext(current,[event()],now);
  assert.equal(context.corrections.length,1);assert.equal(context.corrections[0].effective.start_iso,'2026-10-23T04:00:00.000Z');
  assert.equal(context.corrections[0].authority.content_sha256,third.content_sha256);
  assert.equal(context.corrections[0].authority.observed_at,at);assert.equal(context.summary.reviews.length,0);
  assert.ok(!JSON.stringify(context.summary).includes(second.text));
});
test('edited empty wording suppresses the old static correction and creates a current source review',()=>{
  const context=announcementContext(record(snapshot({announcements:[news({text:'',content_sha256:'b'.repeat(64)})]})),[event()],now);
  assert.equal(context.corrections.length,0);assert.equal(context.summary.change_safe,false);
  assert.ok(context.summary.reviews.some(row=>row.reason==='announcement_authority_changed'));
  assert.ok(context.summary.warnings.some(value=>/announcement authority changed/.test(value)));
});
test('complete source removal suppresses static evidence and cannot revive deleted historical versions',()=>{
  const context=announcementContext(record(snapshot({announcements:[]}),[news()]),[event()],now);
  assert.equal(context.corrections.length,0);assert.equal(context.summary.change_safe,false);
  assert.ok(context.summary.reviews.some(row=>row.reason==='announcement_authority_missing'));
});
test('a successful limited feed retains absent prior evidence with honest source timestamp and coverage warning',()=>{
  const previous=record().snapshot,later='2026-10-11T00:25:00.000Z',raw=snapshot({attempted_at:later,last_success_at:later,
    coverage:previous.coverage.map(row=>({...row,scope:'recent_feed',complete:false,checked_at:later,last_success_at:later})),announcements:[]});
  const merged=validateAnnouncementSnapshot(raw,previous,now),context=announcementContext({ok:true,revision:2,snapshot:merged,evidence:[]},[event()],now);
  assert.equal(context.corrections[0].authority.observed_at,at);assert.equal(merged.announcements.length,1);
  assert.ok(context.summary.warnings.some(value=>/older announcement edits and removals/.test(value)));
  assert.equal(context.summary.status,'degraded');assert.equal(context.summary.change_safe,true,'fresh partial observations preserve absent IDs rather than deleting them');
});
test('stale source reads and broken record access cannot claim current successful announcement monitoring',async()=>{
  const stale=announcementContext(record(),[event()],new Date(+now+4*3600000));
  assert.equal(stale.summary.change_safe,false);assert.ok(stale.summary.courses.every(row=>row.state==='stale'));
  assert.ok(stale.summary.warnings.some(value=>/overdue/.test(value)));
  const broken=await readAnnouncementRecord({BRIDGE_STATE:{getByName:()=>({announcementGet:async()=>{throw Error('private provider body');},announcementEvidence:async()=>[]})}});
  assert.equal(broken.ok,false);const context=announcementContext(broken,[event()],now);
  assert.equal(context.summary.status,'unknown');assert.equal(context.summary.change_safe,false);
  assert.ok(!JSON.stringify(context).includes('private provider body'));
});
test('a failed current read retains prior news without converting failure or upload receipt into success',()=>{
  const previous=record().snapshot,later='2026-10-11T00:25:00.000Z';
  const merged=validateAnnouncementSnapshot(snapshot({attempted_at:later,coverage:previous.coverage.map(row=>({...row,
    checked_at:later,status:'blocked',complete:false,error:'session'})),announcements:[]}),previous,now);
  const context=announcementContext({ok:true,revision:2,snapshot:merged,evidence:[]},[event()],now);
  assert.ok(context.summary.courses.every(row=>row.state==='failed'));assert.equal(context.summary.last_success_at,at);
  assert.equal(context.corrections[0].effective.start_iso,'2026-10-19T04:00:00.000Z');assert.equal(context.summary.change_safe,false);
});
test('default class scope removes other course warnings while preserving selected source limitations',()=>{
  const raw=snapshot({last_complete_success_at:null,coverage:snapshot().coverage.map(row=>row.course_code==='MGMT5560'?{...row,scope:'recent_feed',complete:false,last_complete_success_at:null}:row)});
  const context=announcementContext(record(raw),[event()],now),selected=scopedAnnouncementSummary(context.summary,'BUSN5000');
  assert.equal(selected.courses.length,1);assert.equal(selected.courses[0].course_code,'BUSN5000');assert.deepEqual(selected.warnings,[]);
  assert.equal(selected.status,'healthy');assert.ok(scopedAnnouncementSummary(context.summary,'MGMT5560').warnings.length);
});
test('a provider aligned to the newest chained date resumes its current clock through loadEvents',async t=>{
  const {s,env}=fixture(t),first=snapshot();await save(s,first,'chain-first');
  const secondAt='2026-10-11T00:22:00.000Z',thirdAt='2026-10-11T00:24:00.000Z';
  for(const [stamp,text,hash,operation] of [[secondAt,'Test 2 has been moved from October 19 to October 21.','b','chain-second'],
    [thirdAt,'Test 2 has been moved from October 21 to October 23.','c','chain-third']]) {
    await save(s,snapshot({attempted_at:stamp,last_success_at:stamp,last_complete_success_at:stamp,
      coverage:snapshot().coverage.map(row=>({...row,checked_at:stamp,last_success_at:stamp,last_complete_success_at:stamp})),
      announcements:[news({text,content_sha256:hash.repeat(64),observed_at:stamp})]}),operation);
  }
  const loaded=await loadEvents(feeds,{windowStart,windowEnd,now,env,fetchImpl:async()=>new Response(feed('23'))});
  assert.equal(loaded.events[0].start.toISOString(),'2026-10-23T17:15:00.000Z');assert.equal(loaded.events[0].allDay,false);
  assert.equal(loaded.events[0].date_reconciliation.state,'source_aligned');
  assert.equal(loaded.events[0].date_reconciliation.time_verification,'calendar_only');
});
test('loadEvents uses stored announcements consistently for status calendar and stronger existing completion evidence',async t=>{
  const {s,env}=fixture(t);await save(s,snapshot());
  const rawEvent=event(),id=eventIdentity({...rawEvent,course:courseForEvent(rawEvent)}),progress=[{course:'MGMT5560',item:seed.title,status:'done',
    term_id:TERM_ID,assignment_id:id,assignment_refs:[id],identity_resolution:'linked',verification:'verified',
    evidence:'fixture-submission-receipt',record_id:'existing-progress',revision:7}],before=structuredClone(progress);
  const loaded=await loadEvents(feeds,{windowStart,windowEnd,now,env,fetchImpl:async()=>new Response(feed())});
  assert.equal(loaded.events[0].start.toISOString(),'2026-10-19T04:00:00.000Z');
  const status=buildStatus({...loaded,now,progress}),agenda=buildAgenda({...loaded,status,now,windowStart,windowEnd});
  assert.equal(status.upcoming[0].assignment_id,id);assert.equal(agenda.calendar.events[0].assignment_id,id);
  assert.equal(status.upcoming[0].completion.submission_verification,'verified');assert.equal(status.actionable.counts.outstanding,0);
  assert.equal(agenda.calendar.events[0].date_reconciliation.time_verification,'unconfirmed');assert.deepEqual(progress,before);
  assert.match(status.briefing,/2026-10-19/);assert.equal(status.announcements.status,'healthy');
});
test('moved dates entering a later window remain bound to their original live source UID',async t=>{
  const {s,env}=fixture(t);await save(s,snapshot({announcements:[news({text:'Test 2 has been moved from October 14 to October 23.'})]}));
  const loaded=await loadEvents(feeds,{windowStart:new Date('2026-10-22T04:00:00Z'),windowEnd:new Date('2026-10-24T04:00:00Z'),now,env,fetchImpl:async()=>new Response(feed())});
  assert.equal(loaded.events.length,1);assert.equal(loaded.events[0].uid,seed.uid);
  assert.equal(loaded.events[0].start.toISOString(),'2026-10-23T04:00:00.000Z');
});
test('a replacement calendar UID is not assigned historical coursework or silently selected by the static override',async t=>{
  const {s,env}=fixture(t);await save(s,snapshot());const loaded=await loadEvents(feeds,{windowStart,windowEnd,now,env,
    fetchImpl:async()=>new Response(feed('14','replacement-exam-uid'))});
  assert.equal(loaded.events[0].uid,'replacement-exam-uid');
  assert.notEqual(eventIdentity({...loaded.events[0],course:courseForEvent(loaded.events[0])}),eventIdentity({...event(),course:courseForEvent(event())}));
  assert.equal(normalizeEvents(loaded.events).deadlines.length,1);
});
test('private announcement reads reject anonymous requests and browser sessions cannot publish source evidence',async t=>{
  const {env}=fixture(t);
  assert.equal((await worker.fetch(new Request('https://bridge.test/announcements'),env,{})).status,401);
  const denied=await announcementRoutes(request('/announcements/report',{snapshot:snapshot(),expected_revision:0,idempotency_key:'browser-write'}),env,'/announcements/report','session');
  assert.equal(denied.status,403);assert.equal((await denied.json()).error,'collector_auth_required');
});
test('publisher route preserves matching receipts and latest readback through revision conflicts and uncertain old retries',async t=>{
  const {s,env}=fixture(t),stamp=new Date(Date.now()-60000).toISOString();
  const raw=snapshot({attempted_at:stamp,last_success_at:stamp,last_complete_success_at:stamp,
    coverage:snapshot().coverage.map(row=>({...row,checked_at:stamp,last_success_at:stamp,last_complete_success_at:stamp})),
    announcements:[news({published_at:null,observed_at:stamp})]});
  const body={snapshot:raw,expected_revision:0,idempotency_key:'publisher-first'},post=()=>announcementRoutes(request('/announcements/report',body),env,'/announcements/report','bearer');
  const first=await (await post()).json();assert.equal(first.ok,true);assert.equal(first.revision,1);
  const read=await (await announcementRoutes(request('/announcements'),env,'/announcements','bearer')).json();
  assert.equal(read.snapshot_digest,first.snapshot_digest);assert.equal(read.revision,first.revision);
  const replay=await (await post()).json();assert.equal(replay.replayed,true);assert.equal(replay.revision,1);
  const changed={...body,idempotency_key:'stale-other',snapshot:{...raw,announcements:[]}};
  const conflict=await announcementRoutes(request('/announcements/report',changed),env,'/announcements/report','bearer');
  assert.equal(conflict.status,409);assert.equal((await conflict.json()).current_revision,1);assert.equal(s.get().snapshot.announcements.length,1);
  changed.expected_revision=1;const committed=await (await announcementRoutes(request('/announcements/report',changed),env,'/announcements/report','bearer')).json();
  assert.equal(committed.revision,2);assert.equal(s.get().snapshot.announcements.length,0);
  const oldReceipt=await (await post()).json();assert.equal(oldReceipt.replayed,true);assert.equal(oldReceipt.revision,1);
  assert.equal(s.get().revision,2);assert.notEqual(s.get().snapshot_digest,oldReceipt.snapshot_digest,'an old receipt does not pretend to be the latest readback');
  body.snapshot.announcements=[];assert.equal((await post()).status,409,'same key cannot name another payload');
});
test('publisher validation rejects wrong course source and score content before recording any receipt',async t=>{
  const {s,env}=fixture(t),stamp=new Date(Date.now()-60000).toISOString();
  for(const [i,item] of [news({org_unit_id:'4001788'}),news({text:'Your score is 88%.'})].entries()) {
    const raw=snapshot({attempted_at:stamp,last_success_at:stamp,last_complete_success_at:stamp,
      coverage:snapshot().coverage.map(row=>({...row,checked_at:stamp,last_success_at:stamp,last_complete_success_at:stamp})),
      announcements:[{...item,published_at:null,observed_at:stamp}]});
    const answer=await announcementRoutes(request('/announcements/report',{snapshot:raw,expected_revision:0,idempotency_key:'invalid-'+i}),env,'/announcements/report','bearer');
    assert.equal(answer.status,400);assert.equal(s.get().revision,0);
  }
});
test('unknown publisher fields missing operation identity and oversized request streams cannot save evidence',async t=>{
  const {s,env}=fixture(t);
  for(const body of [{snapshot:snapshot(),expected_revision:0},{snapshot:snapshot(),expected_revision:0,idempotency_key:'extra-field',grades:[88]}]) {
    const answer=await announcementRoutes(request('/announcements/report',body),env,'/announcements/report','bearer');assert.equal(answer.status,400);
  }
  const oversized=new Request('https://bridge.test/announcements/report',{method:'POST',body:'a'.repeat(800001)});
  assert.equal((await announcementRoutes(oversized,env,'/announcements/report','bearer')).status,413);
  assert.equal(s.get().revision,0);
});
