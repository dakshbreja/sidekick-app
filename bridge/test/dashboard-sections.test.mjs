import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {DASHBOARD_VIEW_JS} from '../src/dashboard-view.js';
import {appHtml} from '../src/app.js';
const dashboardView=vm.runInNewContext(DASHBOARD_VIEW_JS+';dashboardView;');

import {sectionFixture} from './dashboard-fixtures.mjs';

const html=appHtml(),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
function renderer(data){
  const nodes=new Map(),document={querySelector(selector){if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',attributes:{},setAttribute(k,v){this.attributes[k]=v;}});return nodes.get(selector);}};
  const context=vm.createContext({document});
  vm.runInContext(script.slice(0,script.indexOf('const CACHE='))+';this.draw=(d,t,stale=false)=>{DATA=d;TAB=t;STALE=stale;render();};',context);
  return {nodes,draw:(tab,stale=false)=>context.draw(data,tab,stale)};
}
test('each dashboard section changes heading, counters and visible content',()=>{
  const d=sectionFixture(),r=renderer(d),headings=new Set(),metrics=new Set(),bodies=new Set();
  for(const tab of ['today','week','upcoming','optional','changes']){r.draw(tab);headings.add(r.nodes.get('#view-intro').innerHTML);metrics.add(r.nodes.get('#kpis').innerHTML);bodies.add(r.nodes.get('#body').innerHTML);assert.equal(r.nodes.get('#body').attributes['aria-labelledby'],'tab-'+tab);}
  assert.equal(headings.size,5);assert.equal(metrics.size,5);assert.equal(bodies.size,5);
});
test('outstanding counts and rows agree; completed work is preserved in a fold',()=>{
  const d=sectionFixture(),v=dashboardView(d,'today');
  assert.equal(v.items.length,2);assert.equal(v.badges.today,2);assert.equal(v.completed.length,1);
  const r=renderer(d);r.draw('today');const body=r.nodes.get('#body').innerHTML;
  assert.ok(body.indexOf('Follow up on project team')<body.indexOf('<details'));
  assert.ok(body.indexOf('Earlier quiz already reported')>body.indexOf('<details'));
  assert.match(body,/reported, unverified/);assert.match(body,/data-status="not_started"/);
});
test('historical link review does not precede or repeat in daily section bodies',()=>{
  const r=renderer(sectionFixture());
  for(const tab of ['today','week','upcoming','optional']){r.draw(tab);assert.doesNotMatch(r.nodes.get('#body').innerHTML,/Archived report|Link report/);assert.match(r.nodes.get('#view-intro').innerHTML,/7 link reviews/);}
  r.draw('changes');const body=r.nodes.get('#body').innerHTML;
  assert.match(body,/<details[^>]+id="link-reviews">/);assert.ok(body.indexOf('Deadline changes')<body.indexOf('Archived report'));assert.match(body,/Linking does not verify submission/);
});
test('tab projections use canonical counts and do not count completed items as outstanding',()=>{
  const d=sectionFixture();d.overdue.push({...d.overdue[0],title:'Old raw duplicate'});
  assert.equal(dashboardView(d,'today').badges.today,2);assert.equal(dashboardView(d,'today').items.length,2);
  assert.equal(dashboardView(d,'week').badges.week,2);assert.equal(dashboardView(d,'upcoming').badges.upcoming,1);
  const courseCount=dashboardView(d,'upcoming').metrics[1][1];
  d.actionable.outstanding.push({bucket:'upcoming',course_code:'GENERAL'});
  assert.equal(dashboardView(d,'upcoming').metrics[1][1],courseCount,'general calendar items are not a course');
  assert.equal(dashboardView(d,'upcoming').metrics[0][2],'tracked items');
});
test('stale or failed source coverage stays prominent and disables completion writes',()=>{
  const d=sectionFixture(),r=renderer(d);r.draw('today',true);
  assert.match(r.nodes.get('#notice').innerHTML,/Saved snapshot/);assert.match(r.nodes.get('#body').innerHTML,/disabled/);
  d.data_warning='A calendar failed; the list may be incomplete.';d.feed_health[0].ok=false;d.actionable.coverage.feeds_status='degraded';r.draw('week');
  assert.match(r.nodes.get('#notice').innerHTML,/calendar failed/);assert.match(r.nodes.get('#body').innerHTML,/disabled/);
});
test('week day counts use the calendar timezone, not UTC date boundaries',()=>{
  const d=sectionFixture();d.actionable.outstanding=d.actionable.outstanding.filter(x=>x.bucket!=='due_this_week');
  for(const iso of ['2026-09-09T17:00:00Z','2026-09-10T03:59:00Z'])d.actionable.outstanding.push({bucket:'due_this_week',when_iso:iso});
  assert.equal(dashboardView(d,'week').metrics[1][1],1);
});
test('calendar descriptions survive the compact actionable projection without title matching',()=>{
  const d=sectionFixture();d.actionable.outstanding=d.actionable.outstanding.map(({detail,...row})=>row);
  assert.match(dashboardView(d,'today').items[1].detail,/Synthetic preview notes/);
  d.due_today[0]={...d.due_today[0],assignment_id:'different-source'};
  assert.equal(dashboardView(d,'today').items[1].detail,undefined);
});
test('tab navigation supports deep links, keyboard selection and reduced motion without polling',()=>{
  new vm.Script(script);
  assert.match(script,/history\.pushState/);assert.match(script,/hashchange/);assert.match(script,/ArrowRight/);assert.match(script,/prefers-reduced-motion/);
  assert.doesNotMatch(script,/setInterval/);assert.match(html,/role="tabpanel"/);assert.match(html,/\.kpis\{position:static/);
  assert.doesNotMatch(script,/__name|\.toString\(\)/);
});
