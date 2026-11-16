import {eventIdentity,TERM_ID} from '../src/identity.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {appHtml} from '../src/app.js';
import openapi from '../src/openapi.js';
import {buildStatus} from '../src/status.js';

function pageFunctions() {
  const elements=new Map();
  const document={querySelector(selector) {
    if(!elements.has(selector)) elements.set(selector,{innerHTML:'',textContent:'',setAttribute(){}});
    return elements.get(selector);
  }};
  const js=appHtml().match(/<script>([\s\S]*?)<\/script>/)[1];
  const api=vm.runInNewContext(js.slice(0,js.indexOf("const CACHE="))+
    '\n({itemRow, renderStatus(s){ DATA=s; render(); }});',{document});
  return {api,elements};
}

test('a no-submission task has an accurate dashboard row badge',()=>{
  const {api}=pageFunctions();
  const html=api.itemRow({title:'Setup',completed:true,completion:{submission_verification:'not_required'}});
  assert.match(html,/nothing to submit/);
  assert.doesNotMatch(html,/reported, unverified/);
});

test('missing feed health never renders a healthy dashboard indicator',()=>{
  const {api,elements}=pageFunctions();
  api.renderStatus({feed_health:[],progress_summary:{done:0},overdue:[],due_today:[],classes_today:[],
    actionable:{counts:{overdue:0,due_today:0,due_this_week:0,other_courses_this_week:0,awaiting_verification:0}}});
  assert.match(elements.get('#live').innerHTML,/dot bad/);
});

test('new response schemas accept the null evidence values the bridge returns',()=>{
  const start=new Date('2026-09-06T01:00:00Z');
  const s=buildStatus({now:new Date('2026-09-05T02:00:00Z'),
    events:[{uid:'contract',summary:'Setup',description:'fixture',location:'',start,
      end:new Date(start.getTime()+3600000),allDay:false,recurring:false,source:'elc'}],
    health:[{source:'elc',ok:true}],progress:[{course:'GENERAL',item:'Setup',status:'done',term_id:TERM_ID,identity_resolution:'linked',assignment_id:eventIdentity({uid:'contract',source:'elc'})}]});
  const completion=s.due_this_week[0].completion;
  const schemas=openapi.components.schemas;
  for(const field of ['evidence','reported_note','submitted_by','reported_by']) {
    assert.equal(completion[field],null,field);
    const types=[schemas.Deadline.properties.completion.properties[field].type].flat();
    assert.ok(types.includes('null'),field+' must allow the returned null');
  }
  const row=s.actionable.completed[0];
  assert.equal(row.course_code,null);
  assert.ok([schemas.ActionItem.properties.course_code.type].flat().includes('null'));
  assert.ok([schemas.Deadline.properties.completion.properties.evidence_limitation.type].flat().includes('null'));
  assert.ok([schemas.ActionItem.properties.evidence_limitation.type].flat().includes('null'));
});
