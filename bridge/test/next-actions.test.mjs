import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildNextActions,sourceLinks,evidenceUrl} from '../src/next-actions.js';
import worker from '../src/worker.js';
import {sqliteFoundation} from './sqlite-fixture.js';
const now=new Date('2026-11-03T12:00:00Z');
const row=(id,title,extra={})=>({assignment_id:id,term_id:'fall-2026',course_code:'LAND2510',course:'LAND 2510E',bucket:'overdue',title,when:'Oct 31, 11:59 PM',when_iso:'2026-11-01T03:59:59.000Z',...extra});
function fixture(){const rows=[row('22','22_ British Isles'),row('23','23_ USA'),row('24','24 _ 1900–1945'),row('exam','Exam #3',{bucket:'due_this_week',when:'Wed Nov 4, 11:59 PM',when_iso:'2026-11-05T04:59:59.000Z'}),row('g1','GLO-BUS Decision 6',{course_code:'MGMT5560'}),row('g2','GLOBUS Scored Year 11',{course_code:'MGMT5560'}),row('film','Barbarians at the Gate Film',{course_code:'MGMT5560'})];return {generated_at:now.toISOString(),term_id:'fall-2026',source_health:[{id:'globus-watch',status:'stale',last_success_at:'2026-10-20T21:58:34Z'}],feed_health:[{source:'elc',ok:true}],actionable:{scope:'ALL',outstanding:rows},overdue:rows.filter(r=>r.bucket==='overdue'),due_this_week:rows.filter(r=>r.bucket==='due_this_week')};}

test('nearest hard deadline links only the requested open quiz preparation, preserving dates and input',()=>{
  const s=fixture(),before=JSON.stringify(s);const out=buildNextActions(s,{now});
  assert.equal(out.next_hard_deadline.assignment_id,'exam');assert.equal(out.next_hard_deadline.date_key,'2026-11-04');assert.ok(out.next_hard_deadline.seconds_until>0);
  assert.deepEqual(out.next_hard_deadline.related_open_items.map(r=>r.assignment_id),['22','23','24']);assert.ok(out.next_hard_deadline.related_open_items.every(r=>r.when_iso==='2026-11-01T03:59:59.000Z'));
  assert.deepEqual(out.priority_order.slice(0,4),['exam','22','23','24']);assert.equal(JSON.stringify(s),before);assert.equal(out.read_only,true);
});
test('stale GLO-BUS occurrences stay separate without clearing, grouping titles or changing real progress',()=>{
  const out=buildNextActions(fixture(),{now});assert.equal(out.counts.unverified,2);assert.equal(out.counts.overdue,4);assert.equal(out.counts.outstanding,7);
  assert.ok(out.unverified.every(r=>r.status_label==='unverified — watcher stale'));assert.ok(out.overdue.some(r=>r.assignment_id==='film'));assert.equal(out.priority_order.includes('g1'),false);
  assert.equal(out.unverified[0].source_evidence.submission_verified,false);
});
test('fresh, missing, failed and impossible-future watcher receipts remain distinct',()=>{
  for(const state of ['unknown','failed','degraded']){const s=fixture();s.source_health=[{id:'globus-watch',status:state}];assert.equal(buildNextActions(s,{now}).unverified.length,2);}
  const s=fixture();s.source_health=[{id:'globus-watch',status:'healthy',last_success_at:now.toISOString()}];assert.equal(buildNextActions(s,{now}).unverified.length,0);
  s.source_health[0].last_success_at='2026-12-03T12:00:00Z';assert.ok(buildNextActions(s,{now}).unverified.every(r=>r.status_label.includes('unknown')));
});
test('completed and other-course/term records cannot enter an exact course plan or linked work',()=>{
  const s=fixture();s.course={code:'LAND2510'};s.actionable.outstanding[1].completed=true;s.actionable.outstanding.push(row('old','23_ Old term',{term_id:'spring-2026'}));const out=buildNextActions(s,{now});
  assert.equal(out.scope,'LAND2510');assert.equal(out.unverified.length,0);assert.deepEqual(out.next_hard_deadline.related_open_items.map(r=>r.assignment_id),['22','24']);
  assert.throws(()=>buildNextActions({...s,term_id:'spring-2026'},{now}),/wrong_term/);
});
test('an exam-looking course module, personal test appointment or practice is not the hard deadline',()=>{
  const s=fixture();s.actionable.outstanding.unshift(row('module','Week 12 - Exam #3',{when_iso:'2026-11-04T10:00:00Z'}),row('practice','Practice exam',{when_iso:'2026-11-04T10:00:00Z'}));
  assert.equal(buildNextActions(s,{now}).next_hard_deadline.assignment_id,'exam');
});
test('unconfirmed source time cannot create a clock countdown, and a later exam cannot inherit the quiz association',()=>{
  const s=fixture();s.actionable.outstanding.find(r=>r.assignment_id==='exam').date_reconciliation={time_verification:'unconfirmed'};let d=buildNextActions(s,{now}).next_hard_deadline;assert.equal(d.seconds_until,null);assert.equal(d.countdown_basis,'confirmed_date_time_unknown');
  s.actionable.outstanding.find(r=>r.assignment_id==='exam').when_iso='2026-11-12T04:59:59.000Z';d=buildNextActions(s,{now}).next_hard_deadline;assert.deepEqual(d.related_open_items,[]);
});
test('source evidence keeps actual links, escapes no provenance into invented receipts and omits credential URLs',()=>{
  const links=sourceLinks({course_code:'LAND2510',detail:'Exam https://uga.view.usg.edu/d2l/lms/quizzing/quizzing.d2l?ou=1&amp;qi=2 | bad javascript:alert(1)'});
  assert.equal(links[0].url,'https://uga.view.usg.edu/d2l/lms/quizzing/quizzing.d2l?ou=1&qi=2');
  for(const url of ['javascript:alert(1)','https://user:secret@example.test/x','https://example.test/?access_token=hidden','https://example.test/calendar/ical/private-x/feed.ics','https://example.test/\nboom'])assert.equal(evidenceUrl(url),null);
  const fallback=sourceLinks({course_code:'LAND2510'});assert.match(fallback[0].label,/receipt unavailable/);assert.equal(fallback[0].kind,'bridge_calendar_projection');
});
test('partial/empty calendar evidence never means clear, and lists are chronological with stable identities',()=>{
  const s=fixture();s.feed_health=[];const out=buildNextActions(s,{now});assert.equal(out.availability,'partial_or_unknown');assert.ok(out.limitations.some(x=>/empty/.test(x)));
  assert.equal(new Set([...out.overdue,...out.due_this_week,...out.unverified].map(r=>r.assignment_id)).size,7);
});
test('priority GET is owner-authenticated, read-only and leaves SQLite and KV unchanged',async t=>{
  const f=sqliteFoundation();t.after(()=>f.close());let writes=0;const env={API_KEY:'owner-fixture-next-actions',BRIDGE_STATE:f.binding,NOTES:{get:async()=>null,put:async()=>{writes++;throw Error('write forbidden');}}};
  const before=f.store.health();const req=(path,method='GET')=>new Request('https://bridge.test'+path,{method,headers:{Authorization:'Bearer '+env.API_KEY}});
  const response=await worker.fetch(req('/next-actions'),env);assert.equal(response.status,200);const body=await response.json();assert.equal(body.version,'next-actions/1');assert.equal(body.read_only,true);assert.equal(body.availability,'partial_or_unknown');assert.equal(writes,0);assert.deepEqual(f.store.health(),before);
  assert.equal((await worker.fetch(req('/next-actions?course=busn%205000'),env)).status,200);
  assert.equal((await worker.fetch(req('/next-actions?course=wrong'),env)).status,400);assert.equal((await worker.fetch(req('/next-actions?term_id=spring'),env)).status,400);assert.equal((await worker.fetch(req('/next-actions','POST'),env)).status,405);
  assert.equal((await worker.fetch(new Request('https://bridge.test/next-actions'),env)).status,401);
  assert.equal((await worker.fetch(new Request('https://bridge.test/next-actions',{headers:{Authorization:'Bearer sp1_'+'0'.repeat(64)}}),env)).status,401);
});
test('storage failure is explicit unavailable, not empty successful priorities',async t=>{
  const f=sqliteFoundation();t.after(()=>f.close());f.stub.list=async()=>{throw Error('fixture unavailable');};
  const response=await worker.fetch(new Request('https://bridge.test/next-actions',{headers:{Authorization:'Bearer owner-fixture-next-actions'}}),{API_KEY:'owner-fixture-next-actions',BRIDGE_STATE:f.binding});assert.equal(response.status,503);assert.equal((await response.json()).error,'next_actions_unavailable');
});


test('stale completion coverage does not erase a future calendar deadline',()=>{
  const s=fixture();const future=row('future','GLO-BUS Decision 8',{course_code:'MGMT5560',bucket:'due_this_week',when_iso:'2026-11-08T12:00:00Z'});s.actionable.outstanding.push(future);s.due_this_week.push(future);const out=buildNextActions(s,{now});assert.ok(out.due_this_week.some(r=>r.assignment_id==='future'));assert.equal(out.unverified.some(r=>r.assignment_id==='future'),false);
});
