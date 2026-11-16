import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {appHtml} from '../src/app.js';
import {AGENDA_VIEW_JS} from '../src/agenda-view.js';

const anchor='2026-10-10T15:00:00Z';
class FixedDate extends Date {constructor(...args){super(...(args.length?args:[anchor]));}static now(){return Date.parse(anchor);}}
const html=appHtml(),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
function harness(){
  const nodes=new Map(),document={querySelector(selector){if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',attributes:{},setAttribute(k,v){this.attributes[k]=v;}});return nodes.get(selector);}};
  const context=vm.createContext({document,Date:FixedDate});
  vm.runInContext(script.slice(0,script.indexOf('const CACHE='))+';this.ui={agendaDateKey,agendaShift,agendaHasDay,agendaTime,agendaBounds,agendaEvents,briefingCurrent,agendaRow,renderCalendar,draw(d,tab,stale=false){DATA=d;TAB=tab;STALE=stale;render();},setCalendar(state){CAL=Object.assign(CAL,state);}};',context);
  return {ui:context.ui,nodes};
}
function fixture(){
  const event=(id,title,kind='meeting',source='personal')=>({id,title,kind,source,start_iso:'2026-10-10T18:00:00Z',end_iso:'2026-10-10T19:00:00Z',date_key:'2026-10-10',end_date_key:'2026-10-10',all_day:false,course_code:kind==='deadline'?'BUSN5000':null,course:kind==='deadline'?'Business statistics':null,completed:false});
  const due={title:'Synthetic quiz',assignment_id:'due-1',term_id:'2026-fall',bucket:'due_today',course_code:'BUSN5000',course:'Business statistics',when_iso:'2026-10-10T23:00:00Z',when:'Oct 10, 7 PM',completed:false};
  const calendar={timezone:'America/New_York',generated_at:anchor,window:{start:'2026-09-30T04:00:00Z',end:'2026-11-25T05:00:00Z'},coverage:{feeds_status:'ok'},events:[event('meeting','Prepare club workshop'),{...event('due-1',due.title,'deadline','elc'),assignment_id:'due-1'},event('study','Review lecture','study')]};
  return {generated_at:anchor,timezone:'America/New_York',feed_health:[{source:'elc',ok:true},{source:'personal',ok:true}],actionable:{outstanding:[due],counts:{overdue:0,due_today:1,due_this_week:0,other_courses_this_week:0,upcoming:0,awaiting_verification:0},coverage:{feeds_status:'ok'}},progress_summary:{done:0},due_today:[due],overdue:[],classes_today:[],calendar,daily_briefing:{date:'2026-10-10',summary:'One required item needs attention.',priorities:[due],today:calendar.events,upcoming_exams:[],changes:[{type:'moved',title:'Synthetic case',from:'Monday',to:'Tuesday'}],recent_lectures:[{title:'Synthetic lecture',date:'2026-10-09',course_code:'BUSN5000'}],warnings:[],coverage:{feeds_status:'ok'}}};
}

test('calendar date calculations follow Eastern dates across UTC and daylight saving boundaries',()=>{
  const {ui}=harness();
  assert.equal(ui.agendaDateKey('2026-10-11T03:59:00Z'),'2026-10-10');
  assert.equal(ui.agendaDateKey('2026-11-02T04:59:00Z'),'2026-11-01');
  assert.equal(ui.agendaDateKey('2026-11-02T05:00:00Z'),'2026-11-02');
  assert.equal(ui.agendaShift('2026-11-01',1),'2026-11-02');
});
test('multi-day all-day events omit the exclusive end date',()=>{
  const {ui}=harness(),event={all_day:true,date_key:'2026-10-10',end_date_key:'2026-10-12'};
  assert.equal(ui.agendaHasDay(event,'2026-10-09'),false);
  assert.equal(ui.agendaHasDay(event,'2026-10-10'),true);
  assert.equal(ui.agendaHasDay(event,'2026-10-11'),true);
  assert.equal(ui.agendaHasDay(event,'2026-10-12'),false);
  assert.match(ui.agendaTime(event),/Oct 10–Oct 11/);
});
test('timed overnight events end exclusively at midnight and point events stay on their date',()=>{
  const {ui}=harness(),event={date_key:'2026-10-10',end_date_key:'2026-10-11',start_iso:'2026-10-11T02:00:00Z',end_iso:'2026-10-11T04:00:00Z',all_day:false};
  assert.equal(ui.agendaHasDay(event,'2026-10-10'),true);
  assert.equal(ui.agendaHasDay(event,'2026-10-11'),false);
  assert.equal(ui.agendaHasDay({...event,end_iso:'2026-10-11T04:30:00Z'},'2026-10-11'),true);
  assert.equal(ui.agendaHasDay({...event,end_iso:null},'2026-10-11'),false);
});
test('month navigation exposes the checked horizon and disables unchecked dates',()=>{
  const {ui,nodes}=harness(),d=fixture();ui.setCalendar({month:'2026-09',date:'2026-09-30'});ui.draw(d,'calendar');
  const body=nodes.get('#body').innerHTML;
  assert.match(nodes.get('#view-intro').innerHTML,/Calendar/);
  assert.match(body,/data-calendar-month="2026-08"[^>]*disabled/);
  assert.match(body,/data-calendar-day="2026-09-29"[^>]*disabled/);
  assert.match(body,/Dates outside this window are disabled/);
  assert.equal(ui.agendaBounds(d.calendar).end,'2026-11-24');
});
test('calendar filters change the displayed agenda by exact source, course and kind',()=>{
  const {ui,nodes}=harness(),d=fixture();ui.setCalendar({source:'personal',kind:'meeting'});ui.draw(d,'calendar');
  const body=nodes.get('#body').innerHTML;
  assert.match(body,/Prepare club workshop/);assert.doesNotMatch(body,/agenda-title">Synthetic quiz|agenda-title">Review lecture/);
  assert.equal(ui.agendaEvents(d.calendar,{course:'BUSN5000',source:'elc',kind:'deadline'}).length,1);
});
test('calendar and daily schedule are read-only and keep completion evidence distinct',()=>{
  const {ui,nodes}=harness(),d=fixture();d.calendar.events[1].completed=true;d.calendar.events[1].submission_verification='reported';
  ui.draw(d,'calendar');let body=nodes.get('#body').innerHTML;
  assert.match(body,/Reported done · unverified/);assert.doesNotMatch(body,/data-status=|Mark done/);
  d.calendar.events[1].submission_verification='verified';ui.draw(d,'calendar');body=nodes.get('#body').innerHTML;assert.match(body,/Verified submission/);
});
test('daily priorities join canonical outstanding identities and do not duplicate today rows',()=>{
  const {ui,nodes}=harness(),d=fixture();d.daily_briefing.priorities.push({title:'Fabricated priority',assignment_id:'unknown'});ui.draw(d,'today');
  const body=nodes.get('#body').innerHTML;
  assert.match(body,/Your daily briefing/);assert.match(body,/Start here/);assert.match(body,/Today’s schedule/);assert.match(body,/Recent lectures/);assert.match(body,/Recent deadline changes/);
  assert.doesNotMatch(body,/Fabricated priority/);
  assert.equal((body.match(/data-item="Synthetic quiz"/g)||[]).length,1,'the required item has one save control');
});
test('upcoming exam cards include the exam date rather than a bare time',()=>{
  const {ui,nodes}=harness(),d=fixture();d.daily_briefing.upcoming_exams=[{...d.calendar.events[1],title:'Synthetic Exam 2',date_key:'2026-10-16',start_iso:'2026-10-16T18:00:00Z',end_iso:'2026-10-16T19:00:00Z',end_date_key:'2026-10-16'}];ui.draw(d,'today');
  const body=nodes.get('#body').innerHTML;assert.match(body,/Synthetic Exam 2/);assert.match(body,/Fri, Oct 16/);
});
test('a reviewed date-only exam shows the confirmed day without inventing a clock time and links its evidence',()=>{
  const {ui}=harness(),event={...fixture().calendar.events[1],title:'Test Two Administered',all_day:true,date_key:'2026-10-19',end_date_key:'2026-10-20',start_iso:'2026-10-19T04:00:00Z',end_iso:'2026-10-20T04:00:00Z',date_reconciliation:{state:'applied',date:'2026-10-19',source_when_iso:'2026-10-14T17:15:00Z',time_verification:'unconfirmed',authority:{url:'https://uga.view.usg.edu/d2l/le/news/3963225/7098040/view?ou=3963225',observed_at:'2026-10-11T00:04:18Z'}}};
  const row=ui.agendaRow(event,'America/New_York',true);
  assert.match(row,/Mon, Oct 19/);assert.match(row,/Date confirmed · time unconfirmed/);
  assert.match(row,/Source calendar: Wed, Oct 14/);assert.match(row,/Instructor announcement/);
  assert.match(row,/Announcement checked Oct 10/);
  assert.doesNotMatch(row,/All day|12:00 AM|1:15/);
  event.date_reconciliation.authority.url='javascript:alert(1)';
  assert.doesNotMatch(ui.agendaRow(event,'America/New_York'),/href=/);
});
test('the daily focus is bounded while remaining required work stays visible with one control each',()=>{
  const {ui,nodes}=harness(),d=fixture(),base=d.actionable.outstanding[0];
  const all=Array.from({length:8},(_,i)=>({...base,title:'Synthetic deadline '+i,assignment_id:'synthetic-'+i}));
  d.actionable.outstanding=all;d.actionable.counts.due_today=8;d.due_today=all;d.daily_briefing.priorities=all;ui.draw(d,'today');
  const body=nodes.get('#body').innerHTML;assert.match(body,/Start here <span class="panel-count">6/);assert.match(body,/Showing 6 of 8 tracked priorities/);assert.match(body,/Due today <span class="panel-count">2/);
  assert.equal((body.match(/data-item="Synthetic deadline/g)||[]).length,8);
  for(let i=0;i<8;i++)assert.equal((body.match(new RegExp('data-id="synthetic-'+i+'"','g'))||[]).length,1);
});
test('yesterday’s briefing and a saved calendar cannot appear current or enable writes',()=>{
  const {ui,nodes}=harness(),d=fixture();d.daily_briefing.date='2026-10-09';ui.draw(d,'today');
  assert.match(nodes.get('#body').innerHTML,/Saved daily briefing/);assert.match(nodes.get('#notice').innerHTML,/Saved snapshot/);assert.match(nodes.get('#body').innerHTML,/data-status="done" disabled/);
  ui.draw(fixture(),'calendar',true);assert.match(nodes.get('#body').innerHTML,/Saved calendar · refresh/);
});
test('partially expanded recurrence cannot show a healthy live badge or two healthy feeds',()=>{
  const {ui,nodes}=harness(),d=fixture();
  d.feed_health[0].coverage_complete=false;d.actionable.coverage.feeds_status='degraded';d.data_warning='Some recurrence rules could not be expanded completely.';
  ui.draw(d,'today');
  assert.match(nodes.get('#live').innerHTML,/Feed coverage incomplete/);assert.match(nodes.get('#live').innerHTML,/dot bad/);
  assert.match(nodes.get('#overview').innerHTML,/1\/2/);assert.doesNotMatch(nodes.get('#overview').innerHTML,/2\/2/);
  assert.match(nodes.get('#body').innerHTML,/data-status="done" disabled/);assert.match(nodes.get('#notice').innerHTML,/recurrence/);
});
test('an empty checked calendar still reports successfully read sources',()=>{
  const {ui,nodes}=harness(),d=fixture();d.calendar.events=[];
  d.calendar.coverage.feeds=[{source:'elc',ok:true,coverage_complete:true},{source:'personal',ok:true,coverage_complete:true}];
  ui.draw(d,'calendar');
  assert.match(nodes.get('#kpis').innerHTML,/Sources[\s\S]*?2[\s\S]*?feeds read successfully/);
});
test('provider titles, locations and descriptions are escaped as text',()=>{
  const {ui}=harness(),event=fixture().calendar.events[0];event.title='<img src=x onerror=alert(1)>';event.description='<script>alert(1)</script>';event.location='" autofocus onfocus="alert(1)';
  const row=ui.agendaRow(event,'America/New_York');
  assert.doesNotMatch(row,/<img|<script/);assert.match(row,/&lt;img/);assert.match(row,/&lt;script/);assert.match(row,/&quot; autofocus/);
});
test('served page requests dashboard additions and includes accessible calendar controls without polling',()=>{
  new vm.Script(script);new vm.Script(AGENDA_VIEW_JS);
  assert.match(script,/api\('\/status\?view=dashboard'\)/);assert.match(html,/id="tab-calendar" role="tab"/);assert.match(script,/aria-label="Previous month"/);assert.match(script,/type="date"/);
  assert.doesNotMatch(script,/setInterval|iframe/);
});
test('Calendar and Today show announcement check time, partial coverage and original review links',()=>{
  const {ui,nodes}=harness(),d=fixture();
  d.announcements={status:'degraded',last_attempt_at:'2026-10-10T14:55:00Z',
    courses:[{course_code:'MGMT5560',state:'partial',checked_at:'2026-10-10T14:55:00Z',last_complete_success_at:'2026-10-10T13:00:00Z'}],
    warnings:['MGMT5560: recent feed checked; older edits are not confirmed.'],
    reviews:[{course_code:'MGMT5560',reason:'ambiguous_assignment_occurrence',text:'Private grade 93%',
      authority:{url:'https://uga.view.usg.edu/d2l/le/news/3963225/7098040/view?ou=3963225'}}]};
  for(const tab of ['calendar','today']) {
    ui.draw(d,tab);const body=nodes.get('#notice').innerHTML;
    assert.match(body,/Announcement checks/);assert.match(body,/0\/1 full listings · 1 recent feeds/);
    assert.match(body,/Last check: Oct 10, 10:55 AM/);assert.match(body,/Recent feed only/);
    assert.match(body,/Date changes need review/);assert.match(body,/More than one tracked deadline matches/);
    assert.match(body,/href="https:\/\/uga\.view\.usg\.edu\/d2l\/le\/news\/3963225\/7098040\/view\?ou=3963225"/);
    assert.doesNotMatch(body,/Private grade|93%|Other exam dates follow calendar entries/);
  }
});
test('announcement review links accept only canonical source addresses and saved checks stay labelled',()=>{
  const {ui,nodes}=harness(),d=fixture();
  d.announcements={last_attempt_at:anchor,courses:[],warnings:[],reviews:[
    {course_code:'MGMT5560',authority:{url:'javascript:alert(1)'}},
    {course_code:'MGMT5560',authority:{url:'https://uga.view.usg.edu/d2l/le/news/3963225/7098040/view?ou=3963225&token=private-token'}},
    {course_code:'MGMT5560',authority:{url:'https://uga.view.usg.edu/d2l/le/news/3963225/7098040/view?ou=4001788'}}]};
  ui.draw(d,'calendar',true);const body=nodes.get('#notice').innerHTML;
  assert.match(body,/Saved announcement checks/);assert.match(body,/No course source checks available/);
  assert.doesNotMatch(body,/javascript:|private-token|Check instructor announcement<\/a>/);
});
test('missing announcement receipt stays unknown even when both calendar feeds pass',()=>{
  const {ui,nodes}=harness(),d=fixture();ui.draw(d,'calendar');
  assert.match(nodes.get('#notice').innerHTML,/No automatic announcement receipt is available yet/);
  assert.match(nodes.get('#notice').innerHTML,/Calendar feeds alone cannot confirm instructor date changes/);
});
