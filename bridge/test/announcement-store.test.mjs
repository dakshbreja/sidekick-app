import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AnnouncementStore,ANNOUNCEMENT_COURSES,validateAnnouncementSnapshot} from '../src/announcement-store.js';
import {digest,stableJSON} from '../src/foundation.js';
import {sqliteFoundation} from './sqlite-fixture.js';

const at='2026-10-11T00:30:00.000Z',later='2026-10-11T01:30:00.000Z';
const codes=Object.keys(ANNOUNCEMENT_COURSES).sort();
function news(extra={}) {
  return {announcement_id:'7098040',course_code:'MGMT5560',term_id:'fall-2026',org_unit_id:'3963225',
    title:'Test 2 date change',text:'Test 2 has been moved to October 19 instead of October 14.',
    source_url:'https://uga.view.usg.edu/d2l/le/news/3963225/7098040/view?ou=3963225',
    published_at:'2026-10-05T18:29:00.000Z',modified_at:null,feed_published_at:null,observed_at:at,
    content_sha256:'a'.repeat(64),privacy_redacted:false,...extra};
}
function snapshot(extra={}) {
  return {schema_version:1,source:'eLC (D2L)',term_id:'fall-2026',attempted_at:at,last_success_at:at,last_complete_success_at:at,
    expected_courses:codes.slice(),coverage:codes.map(course_code=>({course_code,org_unit_id:ANNOUNCEMENT_COURSES[course_code],
      status:'ok',scope:'full_listing',checked_at:at,last_success_at:at,last_complete_success_at:at,complete:true,error:null})),announcements:[news()],...extra};
}
const validated=raw=>validateAnnouncementSnapshot(raw,null,new Date(later));
function fixture(t) {const f=sqliteFoundation();t.after(()=>f.close());return {f,s:new AnnouncementStore(f.storage)};}
async function command(raw,{previous=null,revision=0,operation='announcement-1',received=at}={}) {
  const data=validateAnnouncementSnapshot(raw,previous,new Date(received));
  return {snapshot:data,expected_revision:revision,operation_id:operation,fingerprint:await digest(stableJSON({raw,revision})),
    snapshot_digest:await digest(stableJSON(data)),at:received};
}

test('exact source identity is stored transactionally without changing coursework or sessions',async t=>{
  const {f,s}=fixture(t),before=f.store.health();
  assert.deepEqual(s.get(),{ok:true,revision:0,snapshot_digest:null,snapshot:null,received_at:null});
  const c=await command(snapshot()),out=s.put(c),read=s.get();
  assert.equal(out.ok,true);assert.equal(read.revision,1);assert.equal(read.snapshot_digest,c.snapshot_digest);
  assert.deepEqual(read.snapshot,c.snapshot);assert.deepEqual(f.store.health(),before);
});
test('uncertain save retries replay the original receipt before checking revision',async t=>{
  const {s}=fixture(t),c=await command(snapshot());
  const saved=s.put(c),replayed=s.put(c);
  assert.equal(replayed.replayed,true);assert.equal(replayed.revision,saved.revision);
  assert.equal(s.get().revision,1);
  assert.deepEqual(s.put({...c,fingerprint:'f'.repeat(64)}),{error:'idempotency_conflict',status:409});
});
test('an old uncertain operation remains resolvable after a newer observation was saved',async t=>{
  const {s}=fixture(t),first=await command(snapshot());s.put(first);const previous=s.get().snapshot;
  const newer=snapshot({attempted_at:later,last_success_at:later,last_complete_success_at:later,
    coverage:previous.coverage.map(r=>({...r,checked_at:later,last_success_at:later,last_complete_success_at:later})),announcements:[]});
  s.put(await command(newer,{previous,revision:1,operation:'newer',received:later}));
  assert.equal(s.get().revision,2);
  const receipt=s.receipt(first.operation_id,first.fingerprint);
  assert.equal(receipt.replayed,true);assert.equal(receipt.revision,1);
  assert.equal(s.put(first).revision,1);assert.equal(s.get().revision,2);
});
test('stale expected revision cannot replace a newer source snapshot',async t=>{
  const {s}=fixture(t),c=await command(snapshot());s.put(c);
  const stale=await command(snapshot({announcements:[]} ),{operation:'stale'});
  assert.deepEqual(s.put(stale),{error:'revision_conflict',status:409,current_revision:1});
  assert.equal(s.get().snapshot.announcements.length,1);
});
test('a blocked source retains its last complete evidence and last success but marks latest attempt blocked',async t=>{
  const {s}=fixture(t),first=await command(snapshot());s.put(first);
  const previous=s.get().snapshot,raw=snapshot({attempted_at:later,last_success_at:at,announcements:[],
    coverage:previous.coverage.map(r=>({...r,checked_at:later,last_success_at:r.course_code==='MGMT5560'?at:later,
      status:r.course_code==='MGMT5560'?'blocked':'ok',complete:r.course_code!=='MGMT5560',error:r.course_code==='MGMT5560'?'session':null}))});
  const second=await command(raw,{previous,revision:1,operation:'blocked',received:later});s.put(second);
  assert.deepEqual(s.get().snapshot.announcements,previous.announcements);
  const row=s.get().snapshot.coverage.find(r=>r.course_code==='MGMT5560');
  assert.equal(row.status,'blocked');assert.equal(row.checked_at,later);assert.equal(row.last_success_at,at);
  assert.equal(s.get().snapshot.last_success_at,at);
});
test('partial source observations cannot silently edit retained instructor evidence',()=>{
  const previous=validated(snapshot()),raw=snapshot({attempted_at:later,last_success_at:at,
    coverage:previous.coverage.map(r=>({...r,checked_at:later,status:r.course_code==='MGMT5560'?'incomplete':'ok',
      complete:r.course_code!=='MGMT5560',last_success_at:r.course_code==='MGMT5560'?at:later,error:r.course_code==='MGMT5560'?'response':null})),
    announcements:[news({text:'Test 2 has been moved to October 21.',content_sha256:'b'.repeat(64),observed_at:later})]});
  assert.throws(()=>validateAnnouncementSnapshot(raw,previous,new Date(later)),/unverified_announcement_replacement/);
});
test('a successful recent feed updates observed IDs while absent IDs keep their complete-listing evidence',async t=>{
  const {s}=fixture(t),extra=news({announcement_id:'7098041',source_url:news().source_url.replace(/7098040/,'7098041'),title:'Review date',text:'Test review is October 14.'});
  s.put(await command(snapshot({announcements:[news(),extra]})));const previous=s.get().snapshot;
  const raw=snapshot({attempted_at:later,last_success_at:later,last_complete_success_at:at,
    coverage:previous.coverage.map(r=>({...r,status:'ok',scope:'recent_feed',complete:false,checked_at:later,last_success_at:later})),
    announcements:[news({observed_at:later,modified_at:later,content_sha256:'b'.repeat(64),text:'Test 2 has been moved to October 21 instead of October 19.'})]});
  s.put(await command(raw,{previous,revision:1,operation:'feed-edit',received:later}));const read=s.get().snapshot;
  assert.equal(read.announcements.length,2);assert.equal(read.announcements.find(r=>r.announcement_id==='7098040').observed_at,later);
  assert.equal(read.announcements.find(r=>r.announcement_id==='7098041').observed_at,at);
  assert.equal(read.last_success_at,later);assert.equal(read.last_complete_success_at,at);
  assert.equal(read.coverage.find(r=>r.course_code==='MGMT5560').complete,false);
});
test('bounded feed reads cannot demote a source edit to an older provider revision',()=>{
  const previous=validated(snapshot({announcements:[news({modified_at:at})]}));
  const raw=snapshot({attempted_at:later,last_success_at:later,last_complete_success_at:at,
    coverage:previous.coverage.map(r=>({...r,scope:'recent_feed',complete:false,checked_at:later,last_success_at:later})),
    announcements:[news({observed_at:later,modified_at:'2026-10-05T20:00:00.000Z',content_sha256:'b'.repeat(64)})]});
  assert.throws(()=>validateAnnouncementSnapshot(raw,previous,new Date(later)),/older_announcement_observation/);
});
test('RSS publication is kept separate from original announcement publication and cannot falsely reject later full evidence',()=>{
  const previous=validated(snapshot({announcements:[news({published_at:null,feed_published_at:'2026-10-05T20:04:00.000Z'})]}));
  const raw=snapshot({attempted_at:later,last_success_at:later,last_complete_success_at:later,
    coverage:previous.coverage.map(r=>({...r,checked_at:later,last_success_at:later,last_complete_success_at:later})),
    announcements:[news({observed_at:later})]});
  const current=validateAnnouncementSnapshot(raw,previous,new Date(later));
  assert.equal(current.announcements[0].published_at,'2026-10-05T18:29:00.000Z');
  assert.equal(current.announcements[0].feed_published_at,null);
});
test('same-hash RSS refresh preserves actual creation/edit metadata while a changed hash leaves unknown source times unknown',()=>{
  const previous=validated(snapshot({announcements:[news({modified_at:at})]}));
  const raw=snapshot({attempted_at:later,last_success_at:later,last_complete_success_at:at,
    coverage:previous.coverage.map(r=>({...r,scope:'recent_feed',complete:false,checked_at:later,last_success_at:later})),
    announcements:[news({observed_at:later,published_at:null,modified_at:null,feed_published_at:'2026-10-05T20:04:00.000Z'})]});
  const unchanged=validateAnnouncementSnapshot(raw,previous,new Date(later)).announcements[0];
  assert.equal(unchanged.published_at,previous.announcements[0].published_at);
  assert.equal(unchanged.modified_at,at);assert.equal(unchanged.observed_at,later);
  raw.announcements[0].content_sha256='b'.repeat(64);
  raw.announcements[0].text='Test 2 has been moved to October 21 instead of October 19.';
  const changed=validateAnnouncementSnapshot(raw,previous,new Date(later)).announcements[0];
  assert.equal(changed.published_at,null);assert.equal(changed.modified_at,null);
  assert.equal(changed.feed_published_at,'2026-10-05T20:04:00.000Z');assert.equal(changed.observed_at,later);
});
test('a changed full API hash with unknown LastModifiedDate does not confuse creation with the prior edit time',()=>{
  const previous=validated(snapshot({announcements:[news({modified_at:at})]}));
  const raw=snapshot({attempted_at:later,last_success_at:later,last_complete_success_at:later,
    coverage:previous.coverage.map(r=>({...r,checked_at:later,last_success_at:later,last_complete_success_at:later})),
    announcements:[news({observed_at:later,modified_at:null,content_sha256:'b'.repeat(64),text:'Test 2 has been moved to October 21 instead of October 19.'})]});
  const changed=validateAnnouncementSnapshot(raw,previous,new Date(later)).announcements[0];
  assert.equal(changed.published_at,'2026-10-05T18:29:00.000Z');assert.equal(changed.modified_at,null);
  assert.equal(changed.observed_at,later);
});
test('a complete successful listing may remove a vanished announcement without recreating records',async t=>{
  const {s}=fixture(t);s.put(await command(snapshot()));const previous=s.get().snapshot;
  const raw=snapshot({attempted_at:later,last_success_at:later,announcements:[],coverage:previous.coverage.map(r=>({...r,checked_at:later,last_success_at:later}))});
  s.put(await command(raw,{previous,revision:1,operation:'removed',received:later}));
  assert.equal(s.get().snapshot.announcements.length,0);assert.equal(s.get().revision,2);
});
test('a fresh complete listing may update the same news ID hash and preserve audit revisions',async t=>{
  const {f,s}=fixture(t);s.put(await command(snapshot()));const previous=s.get().snapshot;
  const raw=snapshot({attempted_at:later,last_success_at:later,coverage:previous.coverage.map(r=>({...r,checked_at:later,last_success_at:later})),
    announcements:[news({text:'Test 2 has been moved to October 21 instead of October 19.',observed_at:later,modified_at:later,content_sha256:'b'.repeat(64)})]});
  s.put(await command(raw,{previous,revision:1,operation:'edited',received:later}));
  assert.match(s.get().snapshot.announcements[0].text,/October 21/);
  assert.equal(f.storage.sql.exec('SELECT count(*) AS n FROM announcement_history').toArray()[0].n,2);
  assert.equal(s.evidence().length,1);assert.equal(s.evidence()[0].content_sha256,'a'.repeat(64));
  assert.equal(s.evidence()[0].observed_at,at);
});
test('version evidence is bounded, keeps actual change observations, and excludes deleted or current IDs',async t=>{
  const {f,s}=fixture(t);s.put(await command(snapshot()));
  for(let i=1;i<=7;i++) {
    const stamp=new Date(Date.parse(at)+i*3600000).toISOString(),previous=s.get().snapshot;
    const raw=snapshot({attempted_at:stamp,last_success_at:stamp,last_complete_success_at:stamp,
      coverage:previous.coverage.map(r=>({...r,checked_at:stamp,last_success_at:stamp,last_complete_success_at:stamp})),
      announcements:[news({observed_at:stamp,modified_at:stamp,content_sha256:String(i).repeat(64),text:`Test 2 has been moved to October ${19+i}.`})]});
    s.put(await command(raw,{previous,revision:i,operation:'version-'+i,received:stamp}));
  }
  assert.equal(f.storage.sql.exec('SELECT count(*) AS n FROM announcement_versions').toArray()[0].n,5);
  assert.equal(s.evidence().length,4);assert.equal(s.evidence()[0].content_sha256,'6'.repeat(64));
  assert.equal(s.evidence()[0].observed_at,new Date(Date.parse(at)+6*3600000).toISOString());
  assert.ok(s.evidence().every(r=>r.content_sha256!=='7'.repeat(64)));
  const previous=s.get().snapshot,stamp=new Date(Date.parse(at)+8*3600000).toISOString();
  s.put(await command(snapshot({attempted_at:stamp,last_success_at:stamp,last_complete_success_at:stamp,
    coverage:previous.coverage.map(r=>({...r,checked_at:stamp,last_success_at:stamp,last_complete_success_at:stamp})),announcements:[]}),
    {previous,revision:8,operation:'delete-source',received:stamp}));
  assert.deepEqual(s.evidence(),[]);
});
test('future and out-of-order observations cannot replace recent evidence',()=>{
  assert.throws(()=>validateAnnouncementSnapshot(snapshot({attempted_at:'2026-10-12T00:00:00Z'}),null,new Date(later)),/future_announcement_observation/);
  const previous=validated(snapshot({attempted_at:later,last_success_at:later,coverage:snapshot().coverage.map(r=>({...r,checked_at:later,last_success_at:later}))}));
  assert.throws(()=>validateAnnouncementSnapshot(snapshot(),previous,new Date(later)),/older_announcement_observation/);
  assert.throws(()=>validated(snapshot({announcements:[news({observed_at:later})]})),/invalid_announcement_timestamp/);
});
test('term course-org identity and canonical announcement URL are mandatory',()=>{
  for(const row of [news({term_id:'fall-2025'}),news({course_code:'MGMT5850'}),news({org_unit_id:'4001788'}),news({source_url:'https://evil.test/news'}),news({source_url:news().source_url+'&token=private'})])
    assert.throws(()=>validated(snapshot({announcements:[row]})),/invalid_announcement_(?:identity|url)/);
  assert.throws(()=>validated(snapshot({expected_courses:codes.slice(1)})),/invalid_announcement_courses/);
  assert.throws(()=>validated(snapshot({coverage:snapshot().coverage.map(r=>r.course_code==='BUSN3040'?{...r,org_unit_id:'0'}:r)})),/invalid_announcement_course/);
});
test('numerical grade statements credentials markup and raw errors never enter the bridge',()=>{
  for(const value of ['Your score is 88%.','Your score is 88.','Earned 19/20 on the quiz.','Your grade is 15 points.','access_token: private'])
    assert.throws(()=>validated(snapshot({announcements:[news({text:value})]})),/restricted_announcement_content/);
  assert.throws(()=>validated(snapshot({announcements:[news({text:'<script>alert(1)</script>'})]})),/invalid_announcement_text/);
  assert.throws(()=>validated(snapshot({coverage:snapshot().coverage.map(r=>({...r,error:'https://private.test/?token=secret'}))})),/invalid_announcement_error/);
  assert.throws(()=>validated({...snapshot(),grades:[99]}),/invalid_announcement_snapshot/);
});
test('duplicate identities bounds and unsupported incomplete-success claims are rejected',()=>{
  assert.throws(()=>validated(snapshot({announcements:[news(),news()]})),/duplicate_announcement_identity/);
  assert.throws(()=>validated(snapshot({announcements:Array.from({length:121},(_,i)=>news({announcement_id:String(i+1),source_url:`https://uga.view.usg.edu/d2l/le/news/3963225/${i+1}/view?ou=3963225`}))})),/announcement_snapshot_too_large/);
  assert.throws(()=>validated(snapshot({coverage:snapshot().coverage.map(r=>({...r,complete:false}))})),/invalid_announcement_coverage/);
  assert.throws(()=>validated(snapshot({announcements:[news({text:'a'.repeat(4001)})]})),/invalid_announcement_text/);
});
test('identical snapshots remain unchanged and independent retry receipts are durable',async t=>{
  const {f,s}=fixture(t),c=await command(snapshot());s.put(c);
  const out=s.put({...c,expected_revision:1,operation_id:'same-new-operation',fingerprint:'b'.repeat(64)});
  assert.equal(out.unchanged,true);assert.equal(out.revision,1);
  assert.equal(f.storage.sql.exec('SELECT count(*) AS n FROM announcement_receipts').toArray()[0].n,2);
  assert.equal(s.receipt(c.operation_id,c.fingerprint).revision,1);
  assert.equal(s.receipt(c.operation_id,'f'.repeat(64)).error,'idempotency_conflict');
  assert.equal(s.receipt('missing',c.fingerprint),null);
});
test('a failed receipt write rolls back the snapshot and history in the same transaction',async t=>{
  const {f,s}=fixture(t),c=await command(snapshot()),exec=f.storage.sql.exec;
  f.storage.sql.exec=(query,...args)=>{if(query.startsWith('INSERT INTO announcement_receipts'))throw new Error('fixture_write_failure');return exec(query,...args);};
  assert.throws(()=>s.put(c),/fixture_write_failure/);
  assert.equal(s.get().revision,0);assert.equal(s.receipt(c.operation_id,c.fingerprint),null);
  assert.equal(exec('SELECT count(*) AS n FROM announcement_history').toArray()[0].n,0);
  assert.equal(exec('SELECT count(*) AS n FROM announcement_versions').toArray()[0].n,0);
});
