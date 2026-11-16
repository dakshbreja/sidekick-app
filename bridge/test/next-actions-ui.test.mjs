import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {appHtml} from '../src/app.js';
import {buildNextActions} from '../src/next-actions.js';
const anchor='2026-11-03T12:00:00Z';
class FixedDate extends Date{constructor(...args){super(...(args.length?args:[anchor]));}static now(){return Date.parse(anchor);}}
function harness(){const nodes=new Map(),timers=[];const node=s=>{if(!nodes.has(s))nodes.set(s,{innerHTML:'',textContent:'',hidden:false,setAttribute(){}});return nodes.get(s);};const context=vm.createContext({document:{querySelector:node},Date:FixedDate,URL,URLSearchParams,setTimeout(fn,ms){timers.push(ms);return 1;},clearTimeout(){}});const script=appHtml().match(/<script>([\s\S]*?)<\/script>/)[1];vm.runInContext(script.slice(0,script.indexOf('const CACHE='))+';this.ui={hardCountdown,sourceStatusPanel,draw(d,stale=false){DATA=d;TAB="today";STALE=stale;render();}};',context);return {ui:context.ui,nodes,timers};}
function fixture(){const base={term_id:'fall-2026',course_code:'LAND2510',course:'LAND 2510E',when:'Wed, Nov 4, 11:59 PM',when_iso:'2026-11-05T04:59:59.000Z'};const exam={...base,assignment_id:'exam',title:'Exam #3',bucket:'due_this_week'};const quiz={...base,assignment_id:'22',title:'22_ British Isles',bucket:'overdue',when:'Oct 31, 11:59 PM',when_iso:'2026-11-01T03:59:59.000Z'};const glo={...quiz,assignment_id:'glo',course_code:'MGMT5560',title:'GLO-BUS Chapter quiz'};const d={generated_at:anchor,timezone:'America/New_York',term_id:'fall-2026',actionable:{scope:'ALL',outstanding:[exam,quiz,glo],counts:{overdue:2,due_this_week:1,due_today:0},coverage:{feeds_status:'ok'}},feed_health:[{source:'elc',ok:true}],source_health:[{id:'globus-watch',label:'GLO-BUS watcher',status:'stale',last_success_at:'2026-10-20T12:00:00Z'}],overdue:[quiz,glo],due_this_week:[exam],daily_briefing:{date:'2026-11-03',summary:'Fixture summary',priorities:[exam,quiz],warnings:['Limited announcement feed.','GLO-BUS watcher is stale; its source coverage is limited.'],today:[]},announcements:{warnings:['Limited announcement feed.'],courses:[],reviews:[]},data_warning:'Limited announcement feed.'};d.next_actions=buildNextActions(d,{now:new Date(anchor)});return d;}

test('one closed source-status line retains deduplicated details and removes repeated body warnings',()=>{
  const {ui,nodes}=harness(),d=fixture();ui.draw(d);const notice=nodes.get('#notice').innerHTML,body=nodes.get('#body').innerHTML;
  assert.equal((notice.match(/Limited announcement feed\./g)||[]).length,1);assert.match(notice,/<details class="source-status"><summary>/);assert.doesNotMatch(notice,/<details class="source-status"[^>]* open/);assert.match(notice,/GLO-BUS watcher is stale/);assert.match(notice,/Source health and last successful checks/);
  assert.doesNotMatch(body,/Limited announcement feed\.|GLO-BUS watcher is stale; its source coverage/);
});
test('Today pins the hard deadline before its briefing, links open preparation and retains unverified work outside the overdue count',()=>{
  const {ui,nodes,timers}=harness();ui.draw(fixture());const body=nodes.get('#body').innerHTML;
  assert.ok(body.indexOf('Next hard deadline')<body.indexOf('Your daily briefing'));assert.match(body,/Exam #3/);assert.match(body,/22_ British Isles/);assert.match(body,/original deadline Oct 31/);assert.match(body,/unverified — watcher stale/);assert.match(body,/nothing has been cleared/);
  const cards=nodes.get('#kpis').innerHTML;assert.match(cards,/Overdue<\/div><div class="v mono">1/);assert.match(cards,/Unverified/);assert.deepEqual(timers,[60000]);
});
test('countdown handles a passed deadline and an unconfirmed source time without inventing a clock',()=>{
  const {ui}=harness();assert.match(ui.hardCountdown({when_iso:'2026-11-03T11:00:00Z'}),/reached/);assert.equal(ui.hardCountdown({date_key:'2026-11-04',countdown_basis:'confirmed_date_time_unknown'}),'1 calendar day away · time unconfirmed');
});
test('source failures and stale snapshots stay visible inside the single status disclosure',()=>{
  const {ui,nodes}=harness();ui.draw(fixture(),true);assert.match(nodes.get('#notice').innerHTML,/Saved snapshot — not current/);assert.match(nodes.get('#notice').innerHTML,/Completion controls are paused/);assert.match(nodes.get('#body').innerHTML,/Saved daily briefing/);
});
test('priority titles, evidence attributes and warning strings are escaped in the human window',()=>{
  const {ui,nodes}=harness(),d=fixture();d.next_actions.next_hard_deadline.title='<img src=x onerror=boom>';d.next_actions.next_hard_deadline.source_evidence.links=[{url:'javascript:alert(1)',label:'Unsafe'}];d.daily_briefing.warnings=['<svg onload=boom>'];ui.draw(d);
  const html=nodes.get('#body').innerHTML+nodes.get('#notice').innerHTML;assert.doesNotMatch(html,/<img|<svg|href="javascript:/);assert.match(html,/&lt;img/);
});
