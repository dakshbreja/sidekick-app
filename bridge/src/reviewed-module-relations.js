// Exact native eLC parent/child navigation reviewed 2026-10-12, with the
// corresponding calendar UIDs. Evidence: docs/reviewed-module-relations.json.
// These are course containers, not additional submissions. Dates and original
// events remain intact. This table never links or modifies a progress record.
import { TERM_ID, sourceNamespace } from './identity.js';

const RELATIONS = [
  { term_id:'fall-2026', course_code:'LAND2510', org_unit_id:'3962245',
    event_uid:'6637-21867308@uga.view.usg.edu', module_id:'63256997',
    module_title:'Mini Project 1', child_topic_id:'63257041', child_title:'Mini Project #1',
    reviewed_at:'2026-10-12T04:52:16.349165+00:00' },
  { term_id:'fall-2026', course_code:'LAND2510', org_unit_id:'3962245',
    event_uid:'6637-21867320@uga.view.usg.edu', module_id:'63256992',
    module_title:'Week 9 - Exam # 2', child_topic_id:'63257035', child_title:'Exam # 2',
    reviewed_at:'2026-10-12T04:52:16.349165+00:00' },
];

export function reviewedModuleContainer(event, course, termId=TERM_ID) {
  if (sourceNamespace(event.source)!=='elc' || event.recurring || event.recurrence_anchor
      || !/\bModules\s*:/i.test(String(event.description || ''))) return null;
  const title = String(event.summary || '').replace(/\s*[-–—]\s*(?:Available|Availability Starts|Availability Ends|Due|Ends)\s*$/i, '').trim();
  const row = RELATIONS.find(relation => relation.term_id===termId
    && relation.course_code===course?.code && relation.event_uid===event.uid
    && relation.module_title===title);
  if (!row) return null;
  const date = new Date(event.start);
  if (!Number.isFinite(+date) || date < new Date('2026-08-01T00:00:00Z')
      || date >= new Date('2027-01-01T00:00:00Z')) return null;
  return { ...row, role:'course_module', relationship:'contains_assessment',
    completion_inference:false };
}
