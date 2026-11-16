import {TERM_ID, resolveReportIdentity} from './identity.js';

// This is an explicit, reviewed migration manifest, never a fuzzy bulk matcher.
// Both the original report and the current calendar reference must still match.
export function approvedMigrationLinks(snapshot, approved, deadlines) {
  if (!Array.isArray(approved) || approved.length>100) throw new Error('invalid_approved_links');
  const records=new Set(), refs=new Set();
  return approved.map(link=>{
    if (!link || ['course','current_title','when_iso','reported_item','reported_at'].some(k=>typeof link[k]!=='string' || !link[k]))
      throw new Error('invalid_approved_link');
    const rows=snapshot.progress[link.course] || [];
    const matches=rows.map((row,index)=>({row,index})).filter(({row})=>row.item===link.reported_item && row.at===link.reported_at && row.status==='done');
    const candidates=deadlines.filter(d=>(d.course_code || 'GENERAL')===link.course && d.title===link.current_title && d.when_iso===link.when_iso);
    if(matches.length!==1 || candidates.length!==1 || !candidates[0].assignment_id)throw new Error('approved_reference_changed');
    const identity=resolveReportIdentity({assignment_id:candidates[0].assignment_id,item:link.current_title,when_iso:link.when_iso,term_id:TERM_ID},candidates,[],link.course);
    if(identity.error || identity.identity_resolution!=='linked')throw new Error('approved_reference_changed');
    const record_id=`legacy:${TERM_ID}:progress:${link.course}:${matches[0].index}`;
    if(records.has(record_id) || identity.assignment_refs.some(ref=>refs.has(ref)))throw new Error('duplicate_approved_link');
    records.add(record_id);identity.assignment_refs.forEach(ref=>refs.add(ref));
    return {record_id,identity};
  });
}
