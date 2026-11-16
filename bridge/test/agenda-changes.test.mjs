import test from 'node:test';
import assert from 'node:assert/strict';
import { parseICS } from '../src/ics.js';
import { normalizeEvents } from '../src/status.js';
import { snapshotOf, diffSnapshots, identityKey, reconcileChangeLog, describeChange } from '../src/changes.js';
import { buildAgenda } from '../src/agenda.js';
import { buildStatus } from '../src/status.js';
import { resolveCourse } from '../src/courses.js';
import { eventIdentity } from '../src/identity.js';

const master = 'BEGIN:VEVENT\nUID:weekly-quiz\nSUMMARY:BUSN 5000 Quiz Due\nDTSTART;TZID=America/New_York:20261101T100000\nRRULE:FREQ=WEEKLY\nEND:VEVENT';
const calendar = (override = '') => `BEGIN:VCALENDAR\n${master}\n${override}\nEND:VCALENDAR`;
const bounds = (start, end) => [new Date(start), new Date(end)];
const snapshot = (text, window) => snapshotOf(normalizeEvents(parseICS(text, { windowStart: window[0], windowEnd: window[1], source: 'personal' })).deadlines, ...window);

test('an unchanged recurring deadline does not move when the visible window advances', () => {
  const first = bounds('2026-11-01T00:00:00Z', '2026-11-15T23:59:59Z');
  const second = bounds('2026-11-08T00:00:00Z', '2026-11-22T23:59:59Z');
  const prev = snapshot(calendar(), first), next = snapshot(calendar(), second);
  assert.equal(new Set(prev.items.map(item => item.key)).size, prev.items.length);
  assert.deepEqual(diffSnapshots(prev, next), []);
});

test('a detached moved deadline changes exactly its original occurrence without add/remove notices', () => {
  const window = bounds('2026-11-01T00:00:00Z', '2026-11-22T23:59:59Z');
  const override = 'BEGIN:VEVENT\nUID:weekly-quiz\nRECURRENCE-ID;TZID=America/New_York:20261108T100000\nSUMMARY:BUSN 5000 Quiz Due\nDTSTART;TZID=America/New_York:20261109T130000\nEND:VEVENT';
  const changes = diffSnapshots(snapshot(calendar(), window), snapshot(calendar(override), window));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'moved');
  assert.equal(changes[0].from, '2026-11-08T15:00:00.000Z');
  assert.equal(changes[0].to, '2026-11-09T18:00:00.000Z');
});

test('recurrence fallback retains source/course scope and the original occurrence anchor', () => {
  const event = { uid: 'same-uid', course: { code: 'BUSN5000' }, source: 'personal', recurrence_anchor: '2026-11-08T15:00:00.000Z', start: new Date('2026-11-08T15:00:00Z') };
  assert.equal(identityKey(event), `assignment:${eventIdentity(event)}`);
  assert.equal(identityKey(event), identityKey({ ...event, start: new Date('2026-11-09T18:00:00Z') }));
  assert.notEqual(identityKey(event), identityKey({ ...event, recurrence_anchor: '2026-11-15T15:00:00.000Z' }));
  assert.notEqual(identityKey(event), identityKey({ ...event, source: 'elc' }));
  assert.notEqual(identityKey(event), identityKey({ ...event, course: { code: 'MGMT4280' } }));
});

const moduleEvent = () => ({ uid:'6637-21867308@uga.view.usg.edu', source:'elc',
  summary:'Mini Project 1 - Due', description:'Modules: | Mini Project 1', location:'LAND 2510E',
  start:new Date('2026-10-11T03:59:59Z'), allDay:false, recurring:false, recurrence_anchor:'' });
const moduleBounds = bounds('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z');
const moduleSnapshot = (events=[moduleEvent()]) => snapshotOf(normalizeEvents(events).deadlines, ...moduleBounds, events);

test('reviewed module classification is not logged as source removal or reappearance', () => {
  const event=moduleEvent(), course=resolveCourse('LAND2510');
  const legacy=snapshotOf([{...event,course,title:'Mini Project 1',assignment_id:eventIdentity({...event,course})}],...moduleBounds);
  const current=moduleSnapshot();
  assert.equal(current.items.length,0);
  assert.equal(current.reviewed_containers.length,1);
  assert.deepEqual(diffSnapshots(legacy,current),[]);
  assert.deepEqual(diffSnapshots(current,legacy),[]);
  assert.deepEqual(moduleSnapshot([event]),current,'source projection is deterministic');
  const unreviewed={...event,uid:'another-event'};
  assert.equal(moduleSnapshot([unreviewed]).items.length,1);
  assert.equal(moduleSnapshot([unreviewed]).reviewed_containers.length,0);
});

test('only current exact post-review false removals are corrected, with history retained', () => {
  const next=moduleSnapshot(), row=next.reviewed_containers[0], at='2026-10-12T05:30:00Z';
  const removed={type:'removed',key:row.key,course:row.course,title:row.title,from:row.due,at};
  const controls=[{...removed,key:'unrelated'}, {...removed,course:'BUSN5000'},
    {...removed,from:'2026-10-10T03:59:59.000Z'}, {...removed,at:'2026-10-11T00:00:00Z'},
    {...removed,type:'moved',to:row.due}];
  const input=[removed,...controls], copy=structuredClone(input);
  const corrected=reconcileChangeLog(input,next,'2026-10-12T06:00:00Z');
  assert.deepEqual(input,copy,'does not mutate history in place');
  assert.equal(corrected[0].type,'reclassified');
  assert.equal(corrected[0].previous_type,'removed');
  assert.equal(corrected[0].at,at);
  assert.equal(corrected[0].from,row.due);
  assert.equal(corrected[0].correction.source_uid,moduleEvent().uid);
  assert.equal(corrected[0].correction.module_id,'63256997');
  assert.deepEqual(corrected.slice(1),controls);
  assert.deepEqual(reconcileChangeLog(corrected,next,'2026-10-12T07:00:00Z'),corrected,'no correction write per poll');
  assert.deepEqual(reconcileChangeLog(input,moduleSnapshot([]),'2026-10-12T06:00:00Z'),input,'missing source cannot authorize correction');
  assert.match(describeChange(corrected[0]),/source calendar entry remains present/);
  const now=new Date('2026-10-12T06:00:00Z');
  const status=buildStatus({events:[moduleEvent()],now,changes:[corrected[0]],health:[]});
  const agenda=buildAgenda({events:[moduleEvent()],status,now,windowStart:moduleBounds[0],windowEnd:moduleBounds[1]});
  assert.equal(agenda.daily_briefing.changes[0].type,'reclassified');
  assert.match(agenda.daily_briefing.changes[0].summary,/source calendar entry remains present/);
  assert.doesNotMatch(agenda.daily_briefing.changes[0].summary,/disappeared/);
});

test('date-only reviewed movement never presents its synthetic time as confirmed', () => {
  const event={...moduleEvent(),uid:'actual-exam',summary:'Exam 2 - Due',description:'Quizzes: Exam 2',
    start:new Date('2026-10-19T04:00:00Z'),date_reconciliation:{date:'2026-10-19',time_verification:'unconfirmed'}};
  const next=moduleSnapshot([event]), item=next.items[0];
  const prior={type:'moved',key:item.key,course:item.course,title:item.title,
    from:'2026-10-17T04:00:00.000Z',to:item.due,at:'2026-10-12T05:30:00Z'};
  const [corrected]=reconcileChangeLog([prior],next,'2026-10-12T06:00:00Z');
  assert.equal(corrected.to,prior.to,'raw date value retained for provenance');
  assert.equal(corrected.to_date,'2026-10-19');
  assert.match(describeChange(corrected),/to 2026-10-19 \(time unconfirmed\)/);
  const now=new Date('2026-10-12T06:00:00Z');
  const status=buildStatus({events:[event],now,changes:[corrected],health:[]});
  const agenda=buildAgenda({events:[event],status,now,windowStart:moduleBounds[0],windowEnd:moduleBounds[1]});
  assert.match(agenda.daily_briefing.changes[0].summary,/to 2026-10-19 \(time unconfirmed\)/);
  const mismatched={...prior,to:'2026-10-20T04:00:00.000Z'};
  assert.deepEqual(reconcileChangeLog([mismatched],next,'2026-10-12T06:00:00Z'),[mismatched]);
});
