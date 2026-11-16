import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewedModuleContainer } from '../src/reviewed-module-relations.js';
import { buildStatus, normalizeEvents } from '../src/status.js';
import { buildAgenda } from '../src/agenda.js';
import { resolveCourse } from '../src/courses.js';
import { eventIdentity, TERM_ID } from '../src/identity.js';

const course=resolveCourse('LAND2510'), now=new Date('2026-10-12T05:00:00Z');
const health=[{source:'elc',ok:true,events:4},{source:'personal',ok:true,events:0}];
const event=(overrides={})=>({uid:'6637-21867308@uga.view.usg.edu',source:'elc',
  summary:'Mini Project 1 - Due',description:'Modules: | Mini Project 1',location:'LAND 2510E',
  start:new Date('2026-10-11T03:59:59Z'),end:null,recurring:false,recurrence_anchor:'',allDay:false,...overrides});
const assignment=()=>event({uid:'6637-21867238@uga.view.usg.edu',summary:'Mini Project #1 - Due',
  description:'Assignments: Mini Project #1',start:new Date('2026-10-13T03:59:59Z')});
const examModule=()=>event({uid:'6637-21867320@uga.view.usg.edu',summary:'Week 9 - Exam # 2 - Due',
  description:'Modules: | Week 9 - Exam # 2',start:new Date('2026-10-08T03:59:59Z')});
const exam=()=>event({uid:'6637-22386433@uga.view.usg.edu',summary:'Exam # 2 - Due',
  description:'Quizzes: Exam # 2',start:new Date('2026-10-08T03:59:59Z')});

test('only exact reviewed term/source/course/UID/module role is classified',()=>{
  assert.equal(reviewedModuleContainer(event(),course).module_id,'63256997');
  for(const changed of [{uid:'new-unreviewed-id'},{source:'personal'},{description:'Assignments: Mini Project 1'},
    {summary:'Mini Project 2 - Due'},{recurring:true},{start:new Date('2027-10-11T03:59:59Z')}])
    assert.equal(reviewedModuleContainer(event(changed),course),null);
  assert.equal(reviewedModuleContainer(event(),resolveCourse('MGMT4280')),null);
  assert.equal(reviewedModuleContainer(event(),course,'fall-2027'),null);
});

test('module timing does not become a second overdue submission',()=>{
  const events=[event(),assignment(),examModule(),exam()];
  const ids=normalizeEvents(events).deadlines.map(row=>row.uid);
  assert.deepEqual(ids,['6637-22386433@uga.view.usg.edu','6637-21867238@uga.view.usg.edu']);
  const status=buildStatus({events,now,course,health});
  assert.deepEqual(status.overdue.map(row=>row.title),['Exam # 2']);
  assert.deepEqual(status.due_today.map(row=>row.title),['Mini Project #1']);
  assert.equal(status.overdue[0].outstanding,true,'Attempted label never proves submission');
});

test('verified assignment progress is preserved without copying it to a module',()=>{
  const actual=assignment(), id=eventIdentity({...actual,course});
  const progress=[{record_id:'fake-receipt',revision:7,course:'LAND2510',item:'Mini Project #1',
    status:'done',verification:'verified',evidence:'Synthetic source submission receipt',
    term_id:TERM_ID,assignment_id:id,assignment_refs:[id],identity_resolution:'linked'}];
  const before=structuredClone(progress), events=[event(),actual];
  const status=buildStatus({events,now,course,health,progress});
  assert.equal(status.actionable.outstanding.length,0);
  assert.equal(status.due_today[0].completed,true);
  assert.deepEqual(progress,before);
  const result=buildAgenda({events,status,now,windowStart:new Date('2026-10-01'),windowEnd:new Date('2026-11-01')});
  const module=result.calendar.events.find(row=>row.event_role==='course_module');
  assert.equal(result.calendar.events.length,2);
  assert.equal(module.start_iso,'2026-10-11T03:59:59.000Z');
  assert.equal(module.completed,false);
  assert.equal(module.assignment_id,null);
  assert.equal(module.submission_verification,'not_required');
  assert.match(module.description,/Course module timing/);
});

test('calendar preserves all original dates and does not count exam container twice',()=>{
  const current=new Date('2026-10-05T05:00:00Z'),events=[examModule(),exam()];
  const status=buildStatus({events,now:current,course,health});
  const result=buildAgenda({events,status,now:current,windowStart:new Date('2026-10-01'),windowEnd:new Date('2026-11-01')});
  assert.equal(result.calendar.events.length,2);
  assert.equal(result.calendar.events.filter(row=>row.kind==='deadline').length,1);
  assert.equal(result.daily_briefing.upcoming_exams.length,1);
});

test('a same-title unreviewed event remains an independent requirement',()=>{
  const unrelated=event({uid:'new-source-identity'});
  assert.equal(normalizeEvents([unrelated]).deadlines.length,1);
});
