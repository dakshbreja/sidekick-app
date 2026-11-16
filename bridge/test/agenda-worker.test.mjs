import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {normalizeEvents,buildStatus,loadEvents} from '../src/status.js';
import {sqliteFoundation} from './sqlite-fixture.js';
import {agendaWindow} from '../src/agenda.js';

const now=new Date('2026-10-10T16:00:00Z');
const event=(uid,summary,extra={})=>({uid,summary,description:'',location:'',start:new Date('2026-10-11T18:00:00Z'),end:new Date('2026-10-11T19:00:00Z'),allDay:false,recurring:false,source:'Google Calendar',...extra});

test('calendar checked bounds cover whole local days across DST',()=>{
  const bounds=agendaWindow(new Date('2026-11-01T18:00:00Z'),1,1);
  assert.equal(bounds.windowStart.toISOString(),'2026-10-31T04:00:00.000Z');
  assert.equal(bounds.windowEnd.toISOString(),'2026-11-03T05:00:00.000Z');
});

test('today’s all-day deadline stays due today rather than overdue at midnight',()=>{
  const events=[event('date-deadline','MGMT 5850 — Final exam',{start:new Date('2026-10-10T04:00:00Z'),allDay:true})];
  const d=buildStatus({events,now,health:[{source:'Google Calendar',ok:true}]});
  assert.equal(d.actionable.counts.overdue,0);assert.equal(d.actionable.counts.due_today,1);
});

test('personal meetings and study blocks cannot inflate required-work counts',()=>{
  const events=[event('club','AI Society workshop'),event('advisor','Advisor meeting'),event('birthday','Birthday',{allDay:true}),
    event('appointment','COVID test appointment'),event('interview','Final interview'),
    event('study','MGMT 5850 — Study for Exam 2'),event('prep','MGMT 5850 — Exam prep'),event('exam','MGMT 5850 — Exam 2'),
    event('globus','MGMT 5560 — GLO-BUS Round 8 decision'),event('drop','LAST DAY TO DROP/ADD')];
  const normalized=normalizeEvents(events);
  assert.deepEqual(normalized.deadlines.map(x=>x.uid),['exam','globus','drop']);
  assert.equal(normalized.commitments.length,7);
  const d=buildStatus({events,now,health:[{source:'Google Calendar',ok:true}]});
  assert.equal(d.actionable.counts.outstanding,3);
  assert.equal(d.actionable.outstanding.some(x=>/Study|workshop|Advisor|Birthday/.test(x.title)),false);
});

test('course meetings retain schedule context without deadline controls',()=>{
  const events=[event('oneoff','MGMT 5560 — guest speaker'),event('class','BUSN 5000 — Intro to Data Science',{recurring:true})];
  const normalized=normalizeEvents(events);
  assert.equal(normalized.meetings.length,2);assert.equal(normalized.deadlines.length,0);
});

test('canceled writer events and optional catalog copies cannot become required work',()=>{
  const events=[event('cancel','[CANCELLED] MGMT 5560 — GLO-BUS Round 8'),
    event('optional','BUSN 5000 — Read',{description:'[auto:gpt-status-bridge]'})];
  assert.equal(normalizeEvents(events).deadlines.length,0);
});

test('incomplete recurrence coverage is visible to every status consumer',async()=>{
  const {events,health}=await loadEvents([{name:'Google Calendar',url:'https://synthetic.test/feed'}],{
    windowStart:new Date('2026-10-01T00:00:00Z'),windowEnd:new Date('2026-11-01T00:00:00Z'),
    fetchImpl:async()=>new Response('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:unsupported\r\nSUMMARY:Appointment\r\nDTSTART:20260101T150000Z\r\nRRULE:FREQ=HOURLY\r\nEND:VEVENT\r\nEND:VCALENDAR'),
  });
  assert.equal(health[0].ok,true);assert.equal(health[0].coverage_complete,false);
  const d=buildStatus({events,health,now});assert.equal(d.actionable.coverage.feeds_status,'degraded');
  assert.match(d.data_warning,/recurrence/);assert.match(d.briefing,/incomplete/);
});

test('dashboard adds the calendar from the same private feed read; default GPT payload stays compact',async()=>{
  const foundation=sqliteFoundation(),store=new Map(),key='agenda-fixture-key';
  const env={API_KEY:key,BRIDGE_STATE:foundation.binding,NOTES:{get:async k=>store.get(k)||null,put:async(k,v)=>store.set(k,v)},
    FEED_ELC:'https://synthetic.test/elc',FEED_PERSONAL:'https://synthetic.test/google'};
  const original=globalThis.fetch;let reads=0;
  const current=new Date(),date=new Date(current.getTime()+3600000).toISOString().replaceAll('-','').replaceAll(':','').replace(/\.\d+Z$/,'Z');
  const feed='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:meeting\r\nSUMMARY:Advisor meeting\r\nDTSTART:'+date+'\r\nEND:VEVENT\r\nEND:VCALENDAR';
  globalThis.fetch=async()=>{reads++;return new Response(feed);};
  const req=path=>new Request('https://bridge.test'+path,{headers:{Authorization:'Bearer '+key,'X-Bridge-Client':'dashboard'}});
  try{
    const unauthorized=await worker.fetch(new Request('https://bridge.test/status?view=dashboard'),env);
    assert.equal(unauthorized.status,401);assert.equal(reads,0);
    const standard=await(await worker.fetch(req('/status'),env)).json();
    assert.equal('calendar' in standard,false);assert.equal('daily_briefing' in standard,false);assert.equal(reads,2);
    const dashboard=await(await worker.fetch(req('/status?view=dashboard'),env)).json();
    assert.equal(reads,4,'two feeds once per status, no extra calendar/network read');
    assert.ok(dashboard.calendar);assert.ok(dashboard.daily_briefing);
    assert.equal(dashboard.calendar.events.filter(x=>x.source==='Google Calendar').length,1);
    assert.equal(dashboard.source_health.some(x=>x.id==='grade-check'),false);
    assert.equal(store.has('lastcall:ALL'),false,'dashboard does not overwrite class-GPT call evidence');
    assert.equal((await foundation.stub.list('progress',['GENERAL'])).records.length,0);
  }finally{globalThis.fetch=original;foundation.close();}
});

test('incomplete recurrence cannot erase the existing deadline baseline in requests or scheduled checks',async()=>{
  const foundation=sqliteFoundation(),store=new Map(),key='agenda-coverage-key';
  const env={API_KEY:key,BRIDGE_STATE:foundation.binding,NOTES:{get:async k=>store.get(k)||null,put:async(k,v)=>store.set(k,v)},
    FEED_ELC:'https://synthetic.test/elc',FEED_PERSONAL:'https://synthetic.test/google'};
  const original=globalThis.fetch;
  const stamp=new Date(Date.now()+3600000).toISOString().replaceAll('-','').replaceAll(':','').replace(/\.\d+Z$/,'Z');
  let feed='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:quiz\r\nSUMMARY:BUSN 5000 Quiz Due\r\nDTSTART:'+stamp+'\r\nEND:VEVENT\r\nEND:VCALENDAR';
  globalThis.fetch=async()=>new Response(feed);
  const req=path=>new Request('https://bridge.test'+path,{headers:{Authorization:'Bearer '+key,'X-Bridge-Client':'dashboard'}});
  try{
    await worker.fetch(req('/status?view=dashboard'),env);
    const baseline=store.get('snapshot:deadlines');assert.ok(baseline);
    feed='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:unsupported\r\nSUMMARY:Appointment\r\nDTSTART:20260101T150000Z\r\nRRULE:FREQ=HOURLY\r\nEND:VEVENT\r\nEND:VCALENDAR';
    const health=await(await worker.fetch(req('/health'),env)).json();assert.equal(health.ok,false);
    const d=await(await worker.fetch(req('/status?view=dashboard'),env)).json();
    assert.equal(d.calendar.coverage.feeds_status,'degraded');
    assert.equal(store.get('snapshot:deadlines'),baseline);assert.equal(store.has('log:changes'),false);
    await worker.scheduled({cron:'0 11,17,23 * * *'},env,{});
    assert.equal(store.get('snapshot:deadlines'),baseline);assert.equal(store.has('log:changes'),false);
  }finally{globalThis.fetch=original;foundation.close();}
});
