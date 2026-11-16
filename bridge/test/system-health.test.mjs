import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { collectCloudHealth, systemHealth, localReport, stateOf, announcementHealth, CLOUD_KEY, LOCAL_KEY, PROBE_KEY, HEALTH_CRON } from '../src/system-health.js';
import { COURSES } from '../src/courses.js';
import { systemHtml, displayedState } from '../src/system-page.js';

const NOW = new Date('2026-09-05T03:00:00Z');
const at = NOW.toISOString();
function env() {
  const store = new Map();
  return { API_KEY:'test-secret',FEED_ELC:'https://elc.invalid/secret',FEED_PERSONAL:'https://gcal.invalid/private',
    NOTES: { store, writes:0, async get(k){return store.get(k)||null}, async put(k,v){this.writes++;store.set(k,v)} } };
}
const put = (e,k,v)=>e.NOTES.put(k,v);
const request = (path, method='GET', body) => new Request('https://bridge.test'+path, {method,headers:{Authorization:'Bearer test-secret'},...(body?{body:JSON.stringify(body)}:{})});
const feed = async()=>new Response('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR');
test('all system routes require authentication and disclose no topology', async()=>{
  for(const [p,m] of [['/system/health','GET'],['/system/health/report','POST'],['/system/health/probe','POST']]){
    const r=await worker.fetch(new Request('https://bridge.test'+p,{method:m}),env());
    assert.equal(r.status,401);assert.deepEqual(await r.json(),{error:'unauthorized'});
  }
});
test('page uses the dashboard cookie, no embedded API key, and compiles',async()=>{
  const r=await worker.fetch(new Request('https://bridge.test/app/system',{headers:{Authorization:'Bearer test-secret'}}),env());
  assert.equal(r.status,200);const html=await r.text();assert.ok(!html.includes('test-secret'));
  new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});
test('polling is read-only and does not hit feeds or alter client markers',async()=>{
  const e=env();e.NOTES.store.set('lastcall:BUSN5000',JSON.stringify({at,user_agent:'secret-user-agent'}));
  for(let i=0;i<3;i++){const view=await systemHealth(e,NOW);assert.equal(view.nodes.find(n=>n.id==='gpt-BUSN5000').status,'unknown');assert.ok(!JSON.stringify(view).includes('secret-user-agent'));}
  assert.equal(e.NOTES.writes,0);
});
test('empty or missing monitoring data is unknown, not healthy',async()=>{
  const v=await systemHealth(env(),NOW);
  for(const id of ['monitor','elc-feed','google-feed','local','write','codex','knowledge'])assert.equal(v.nodes.find(n=>n.id===id).status,'unknown');
});
test('success expires and the latest failed check preserves last success',async()=>{
  const e=env();await collectCloudHealth(e,put,NOW,feed);
  const failed=new Date(NOW.getTime()+60000);
  await collectCloudHealth(e,put,failed,async()=>{throw new Error('private https://foo.test/token?secret=leak')});
  const v=await systemHealth(e,failed);const n=v.nodes.find(n=>n.id==='elc-feed');assert.equal(n.status,'failed');assert.equal(n.last_success_at,at);assert.ok(!JSON.stringify(v).includes('leak'));
  assert.equal((await systemHealth(e,new Date(NOW.getTime()+40*60000))).nodes.find(n=>n.id==='elc-feed').status,'stale');
});
test('cron fetches complete calendar data and never treats a login HTML page as success',async()=>{
  const e=env();const result=await collectCloudHealth(e,put,NOW,async()=>new Response('<html>login</html>'));
  assert.equal(result.checks['elc-feed'].outcome,'failed');assert.match(result.checks['elc-feed'].detail,/iCalendar/);assert.equal(e.NOTES.writes,1);
});
test('partial recurrence coverage is degraded and does not advance the last successful Systems Bridge check',async()=>{
  const e=env();await collectCloudHealth(e,put,NOW,feed);
  const later=new Date(NOW.getTime()+60000);
  const partial=async()=>new Response('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:private-id\r\nSUMMARY:Private title\r\nDTSTART:20260101T150000Z\r\nRRULE:FREQ=HOURLY\r\nEND:VEVENT\r\nEND:VCALENDAR');
  const snapshot=await collectCloudHealth(e,put,later,partial);
  assert.equal(snapshot.checks['elc-feed'].outcome,'degraded');
  assert.equal(snapshot.checks['elc-feed'].last_success_at,at);
  assert.match(snapshot.checks['elc-feed'].detail,/recurrence coverage is incomplete/);
  assert.doesNotMatch(JSON.stringify(snapshot),/Private title|private-id|HOURLY/);
  assert.equal((await systemHealth(e,later)).nodes.find(n=>n.id==='google-feed').status,'degraded');
});
test('reviewed date disagreements are degraded, correctly labelled and retain last success without academic details',async()=>{
  const e=env(), checked=new Date('2026-10-13T20:00:00Z');
  await collectCloudHealth(e,put,checked,feed);
  const later=new Date(checked.getTime()+60000);
  const changed=async()=>new Response('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:6637-21909747@uga.view.usg.edu\r\nSUMMARY:Test Two Administered\r\nLOCATION:Classroom MGMT5560\r\nDTSTART:20261014T171500Z\r\nDTEND:20261014T190000Z\r\nEND:VEVENT\r\nEND:VCALENDAR');
  const snapshot=await collectCloudHealth(e,put,later,changed);
  const check=snapshot.checks['elc-feed'];
  assert.equal(check.outcome,'degraded');
  assert.equal(check.last_attempt_at,later.toISOString());
  assert.equal(check.last_success_at,checked.toISOString());
  assert.match(check.detail,/reviewed instructor date no longer matches/);
  assert.doesNotMatch(check.detail,/recurrence/);
  assert.doesNotMatch(JSON.stringify(snapshot),/21909747|Test Two|MGMT5560|news\//);
  const node=(await systemHealth(e,later)).nodes.find(n=>n.id==='elc-feed');
  assert.equal(node.status,'degraded');
  assert.equal(node.last_success_at,checked.toISOString());
});
test('health cron never modifies deadline snapshots, notes or progress',async()=>{
  const e=env();const oldFetch=globalThis.fetch;globalThis.fetch=feed;
  try{await worker.scheduled({cron:HEALTH_CRON},e);assert.deepEqual([...e.NOTES.store.keys()],[CLOUD_KEY]);}finally{globalThis.fetch=oldFetch;}
});
test('friendly proxy cannot run another cloud collector',async()=>{
  const e=env();e.PRIMARY_BRIDGE={fetch:()=>new Response('forwarded')};await worker.scheduled({cron:HEALTH_CRON},e);assert.equal(e.NOTES.writes,0);
  assert.equal(await (await worker.fetch(request('/app/system'),e)).text(),'forwarded');
});
test('local report timestamps stay old when reporter is fresh and free text is discarded',async()=>{
  const old='2026-09-01T00:00:00Z';const report=localReport({checks:[{id:'elc-daily-sweep',outcome:'healthy',reason:'ok',last_attempt_at:old,last_success_at:old,note:'private coursework',score:100}]},{},NOW);
  assert.equal(report.received_at,at);assert.equal(Date.parse(report.checks['elc-daily-sweep'].last_attempt_at),Date.parse(old));assert.ok(!JSON.stringify(report).includes('private'));assert.ok(!JSON.stringify(report).includes('score'));
  const e=env();e.NOTES.store.set(LOCAL_KEY,JSON.stringify(report));assert.equal((await systemHealth(e,NOW)).nodes.find(n=>n.id==='elc-daily-sweep').status,'stale');
});
test('missing publisher turns otherwise recent local checks stale',async()=>{
  const e=env();e.NOTES.store.set(LOCAL_KEY,JSON.stringify({received_at:'2026-09-04T22:00:00Z',checks:{'grade-check':{outcome:'healthy',last_attempt_at:'2026-09-04T21:00:00Z',last_success_at:'2026-09-04T21:00:00Z'}}}));
  const n=(await systemHealth(e,NOW)).nodes.find(n=>n.id==='grade-check');assert.equal(n.status,'stale');assert.equal(n.outcome,'healthy');
});
test('rejects unknown, duplicate, future and out-of-order local observations',()=>{
  const row={id:'grade-check',outcome:'healthy',reason:'ok',last_attempt_at:at,last_success_at:at};
  assert.throws(()=>localReport({checks:[{...row,id:'api-key'}]},{},NOW),/invalid_service/);
  assert.throws(()=>localReport({checks:[row,row]},{},NOW),/invalid_service/);
  assert.throws(()=>localReport({checks:[{...row,last_attempt_at:'2030-01-01'}]},{},NOW),/future/);
  assert.throws(()=>localReport({checks:[{...row,last_attempt_at:'2020-01-01'}]},{checks:{'grade-check':row}},NOW),/older/);
});
test('local failure preserves last successful observation without claiming a new success',()=>{
  const old='2026-09-04T00:00:00Z';const r=localReport({checks:[{id:'grade-check',outcome:'failed',reason:'failed',last_attempt_at:at,last_success_at:null}]},{checks:{'grade-check':{last_attempt_at:old,last_success_at:old}}},NOW);
  assert.equal(Date.parse(r.checks['grade-check'].last_success_at),Date.parse(old));
});
test('diagnostic write touches only its own key and quota failures are visible',async()=>{
  const e=env();const r=await worker.fetch(request('/system/health/probe','POST',{}),e);assert.equal(r.status,200);assert.deepEqual([...e.NOTES.store.keys()],[PROBE_KEY]);
  e.NOTES.put=async()=>{throw new Error('limit exceeded')};assert.equal((await worker.fetch(request('/system/health/probe','POST',{}),e)).status,503);
});
test('browser loses green immediately after polling failure and ages checks without a new payload',()=>{
  const n={kind:null,status:'healthy',last_attempt_at:at,stale_after_seconds:90};
  assert.equal(displayedState(n,NOW.getTime(),true),'stale');assert.equal(displayedState(n,NOW.getTime()+91000),'stale');assert.equal(displayedState({...n,kind:'unverified'},NOW.getTime(),true),'unknown');
  assert.equal(stateOf({last_attempt_at:'bad',outcome:'healthy'},60,NOW.getTime()),'unknown');
});
test('the view explains cadence and shared failure domain',()=>{
  const html=systemHtml();for(const phrase of ['every 15 minutes','hourly at :35','every 30 seconds','total outage','Quiet assistants are not monitored'])assert.ok(html.includes(phrase));
});


test('oversized reports are rejected before parsing or writes',async()=>{const e=env();const r=await worker.fetch(new Request('https://bridge.test/system/health/report',{method:'POST',headers:{Authorization:'Bearer test-secret'},body:'x'.repeat(12001)}),e);assert.equal(r.status,413);assert.equal(e.NOTES.writes,0);});
test('malformed service rows yield a typed validation error',()=>{assert.throws(()=>localReport({checks:[null]}),/invalid_service/);});

function announcementRecord(scope='full_listing') {
  return {ok:true,revision:3,snapshot:{attempted_at:at,last_success_at:at,last_complete_success_at:at,
    coverage:COURSES.map(course=>({course_code:course.code,status:'ok',scope,complete:scope==='full_listing',
      checked_at:at,last_success_at:at,last_complete_success_at:at})),
    announcements:[{title:'Private assignment title',text:'Private grade 99%',source_url:'https://private.test/?token=secret'}]}};
}
test('announcement health distinguishes full listings from bounded recent feeds without course content',()=>{
  const full=announcementHealth(announcementRecord(),NOW);
  assert.equal(full.outcome,'healthy');assert.equal(full.coverage.full_listing,COURSES.length);
  const partial=announcementHealth(announcementRecord('recent_feed'),NOW);
  assert.equal(partial.outcome,'degraded');assert.equal(partial.coverage.recent_feed,COURSES.length);
  assert.match(partial.detail,/cannot confirm older edits or removals/);
  assert.equal(partial.last_complete_success_at,at);
  assert.doesNotMatch(JSON.stringify(partial),/Private|99|secret|private\.test|announcement_id/);
});
test('announcement failure and per-course staleness retain earlier real success',()=>{
  const record=announcementRecord(),old='2026-09-04T00:00:00Z';
  record.snapshot.coverage[0]={...record.snapshot.coverage[0],status:'failed',last_success_at:old};
  record.snapshot.coverage[1]={...record.snapshot.coverage[1],last_success_at:old};
  record.snapshot.last_success_at=old;
  const check=announcementHealth(record,NOW);
  assert.equal(check.outcome,'degraded');assert.equal(check.coverage.failed,1);assert.equal(check.coverage.stale,1);
  assert.equal(Date.parse(check.last_success_at),Date.parse(old));
  assert.equal(announcementHealth(null,NOW),null);
  assert.equal(announcementHealth({ok:false},NOW).outcome,'failed');
  for(const row of record.snapshot.coverage)row.status='failed';
  assert.equal(announcementHealth(record,NOW).outcome,'failed');
});
test('Systems Bridge reads current announcement receipts directly without a health write',async()=>{
  const e=env();let reads=0;
  e.BRIDGE_STATE={getByName:()=>({health:async()=>({ready:true}),announcementGet:async()=>{reads++;return announcementRecord('recent_feed');},
    announcementEvidence:async()=>[],clubOverview:async()=>({}),retryList:async()=>[]})};
  const snapshot=await systemHealth(e,NOW),news=snapshot.nodes.find(row=>row.id==='instructor-announcements');
  assert.equal(reads,1);assert.equal(news.status,'degraded');assert.equal(news.last_attempt_at,at);
  assert.equal(news.coverage.recent_feed,COURSES.length);assert.equal(e.NOTES.writes,0);
  assert.doesNotMatch(JSON.stringify(snapshot),/Private assignment|Private grade|private\.test|secret/);
  assert.ok(snapshot.edges.some(edge=>edge.from==='instructor-announcements'&&edge.to==='bridge'));
});

// The Mac publisher already emits this reason when authorization or writes fail.
// Rejecting one valid row used to suppress the complete seven-service report.
test('calendar writer failure is accepted as degraded without suppressing other Mac health rows',async()=>{
  const e=env();
  const checks=['elc-daily-sweep','globus-watch','cluely-gpt-sync','grade-check','drive-sync-check','board-refresh','bridge-health'].map(id=>({
    id,outcome:id==='globus-watch'?'degraded':'healthy',reason:id==='globus-watch'?'calendar':'ok',
    last_attempt_at:at,last_success_at:id==='globus-watch'?null:at,
    raw_error:'private refresh_token=secret',grade_percentage:99,
  }));
  const response=await worker.fetch(request('/system/health/report','POST',{checks}),e);
  assert.equal(response.status,200);
  const stored=JSON.parse(e.NOTES.store.get(LOCAL_KEY));
  assert.equal(Object.keys(stored.checks).length,7);
  assert.equal(stored.checks['globus-watch'].outcome,'degraded');
  assert.equal(stored.checks['globus-watch'].reason,'calendar');
  assert.match(stored.checks['globus-watch'].detail,/calendar/i);
  assert.equal(stored.checks['bridge-health'].outcome,'healthy');
  assert.doesNotMatch(JSON.stringify(stored),/refresh_token|secret|grade_percentage|99/);
});
