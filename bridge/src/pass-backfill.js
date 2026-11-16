import {fields,text,ident} from './learner-store.js';
import {TERM_ID} from './identity.js';
export const APPROVED_BACKFILL_IDS=['111978e9-dcba-4381-9e38-fdf980715724','9012d77f-112b-4356-ac73-cef21902d182','26ae3f66-6357-4f46-99fb-6b6712eef984'];
export const BACKFILL_APPROVAL='daksh-20261103-busn5000-pass-backfill';
export const BACKFILL_AGENT='Claude (backfill from PASS, approved by Daksh 2026-11-03)';
export const TOPIC_TAGS=['omitted_variable_bias','measurement_error','r_squared','confidence_intervals','inference','randomization','log_models'];
const bad=s=>{throw Error('invalid_pass_backfill_'+s);};
export function validatePassBackfill(raw,receipts){
  fields(raw,['approval_id','idempotency_key','course','term_id','sandbox','items','grade']);
  if(raw.approval_id!==BACKFILL_APPROVAL||raw.course!=='BUSN5000'||raw.term_id!==TERM_ID||typeof raw.sandbox!=='boolean')bad('scope');
  ident(raw.idempotency_key);
  if(!Array.isArray(raw.items)||!raw.items.length||raw.items.length>60)bad('items');
  const sources=new Map(receipts.map(r=>[r.record_id,r]));
  if(sources.size!==3||APPROVED_BACKFILL_IDS.some(id=>!sources.has(id))||receipts.some(r=>r.course!=='BUSN5000'||r.term_id!==TERM_ID||r.revision!==1||r.session_id?.startsWith('pass:test:')||!Number.isFinite(Date.parse(r.at))))bad('source_revision');
  const items=raw.items.map(i=>{
    fields(i,['event_id','record_id','source_revision','source_anchor','source_line','question','answer_quotes','answer_summary','correctness','correctness_quote','correct_answer_as_recorded','help_level','help_quote','topic_tag','source_event_time']);
    const event_id=ident(i.event_id),r=sources.get(i.record_id);if(!r||i.source_revision!==1)bad('source');
    const anchor=text(i.source_anchor,2000),line=text(i.source_line,400),question=text(i.question,1000);
    if(!r.text.includes(anchor)||!anchor.startsWith('- [observed]')||!anchor.endsWith('\n  Source: '+line)||!r.text.includes(question))bad('anchor');
    if(!Array.isArray(i.answer_quotes)||i.answer_quotes.length>4)bad('quotes');
    const quotes=i.answer_quotes.map(q=>{text(q,700);if(!anchor.includes('"'+q+'"'))bad('quote');return q;});
    const summary=i.answer_summary==null?null:text(i.answer_summary,700);if(summary&&!anchor.includes(summary)||!quotes.length&&!summary)bad('response');
    if(!['correct','incorrect','unassessed'].includes(i.correctness))bad('correctness');
    const verdict=i.correctness_quote==null?null:text(i.correctness_quote,700);if(verdict&&!anchor.includes(verdict)||i.correctness!=='unassessed'&&!verdict)bad('verdict');
    const correctAnswer=i.correct_answer_as_recorded==null?null:text(i.correct_answer_as_recorded,300);if(correctAnswer&&!anchor.includes(correctAnswer))bad('answer_key');
    if(![null,'none','hint','worked_example','revealed'].includes(i.help_level))bad('help');
    const help=i.help_quote==null?null:text(i.help_quote,700);if(help&&!anchor.includes(help)||i.help_level!==null&&!help)bad('help_evidence');
    if(!TOPIC_TAGS.includes(i.topic_tag))bad('topic');
    const eventTime=i.source_event_time==null?null:text(i.source_event_time,100);if(eventTime&&!line.includes(eventTime))bad('event_time');
    return {...i,event_id,question,answer_quotes:quotes,answer_summary:summary,correctness_quote:verdict,correct_answer_as_recorded:correctAnswer,help_quote:help,source_event_time:eventTime};
  });
  if(new Set(items.map(i=>i.record_id+':'+i.event_id)).size!==items.length)bad('duplicate_event');
  const g=raw.grade;fields(g,['record_id','source_revision','source_anchor','source_line','student_quote','value_as_reported']);
  const r=sources.get(g.record_id);if(g.record_id!==APPROVED_BACKFILL_IDS[2]||g.source_revision!==1||!/^\d+(?:\.\d+)?%$/.test(g.value_as_reported)||Number(g.value_as_reported.slice(0,-1))>100||!r.text.includes(g.source_anchor)||!g.source_anchor.startsWith('- [user_report]')||!g.source_anchor.endsWith('\n  Source: '+g.source_line)||!g.source_anchor.includes('"'+g.student_quote+'"')||!g.student_quote.includes(g.value_as_reported))bad('grade_evidence');
  return {...raw,items};
}
export function importPassBackfill(store,raw,receipts,fingerprint,at){
  const b=validatePassBackfill(raw,receipts),s={course:'BUSN5000',term_id:TERM_ID,sandbox:b.sandbox},key=`${b.sandbox?'sandbox':'live'}:${TERM_ID}:BUSN5000`,sources=new Map(receipts.map(r=>[r.record_id,r]));
  return store.storage.transactionSync(()=>{
    const prior=store.rows('SELECT fingerprint,result FROM learner_receipts WHERE scope=? AND operation_id=?',key,b.idempotency_key)[0];
    if(prior)return prior.fingerprint===fingerprint?{...JSON.parse(prior.result),replayed:true}:{error:'idempotency_conflict',status:409};
    const ids=b.items.map(i=>'pass-backfill:'+i.record_id+':'+i.event_id),gradeId='pass-backfill:26ae3f66:exam1';
    if(ids.some(id=>store.one(s,'item',id))||store.one(s,'outcome',gradeId)||store.entities(s,'outcome').some(o=>o.assessment_id==='busn5000:exam1'))return {error:'backfill_identity_already_exists',status:409};
    if(store.entities(s,'item').length+ids.length>2000||store.entities(s,'outcome').length>=200)return {error:'learner_capacity_reached',status:409};
    const before=new Set(store.entities(s,'hypothesis').map(h=>h.hypothesis_id));
    for(let n=0;n<b.items.length;n++){
      const i=b.items[n],r=sources.get(i.record_id),source={material_id:'pass:'+r.record_id,revision:String(r.revision),url:'https://coursework.example-subdomain.workers.dev/app#pass?'+new URLSearchParams({course:'BUSN5000',record:r.record_id}),locator:i.source_line};
      const record={...s,item_id:ids[n],session_id:r.session_id,state:'answered',revision:1,response_format:'receipt_backfill',backfilled:true,imported_at:at,backfill_approval:BACKFILL_APPROVAL,recording_agent:BACKFILL_AGENT,question:i.question,options:null,student_answer_quotes:i.answer_quotes,answer_summary:i.answer_summary,chosen_answer:null,correct_answer:i.correct_answer_as_recorded,correct:i.correctness==='unassessed'?null:i.correctness==='correct',correctness:i.correctness,correctness_quote:i.correctness_quote,confidence:null,confidence_stated_at:null,confidence_received_at:null,calibration_excluded_reason:'confidence_not_stated',help_level:i.help_level,help_as_recorded:i.help_quote,topic_tag:i.topic_tag,answered_at:r.at,timestamp_basis:'source_receipt_saved_at; exact answer time not retained',practice_date:r.date,source,answer_source:source,source_receipt:{record_id:r.record_id,revision:1,saved_at:r.at,date:r.date,source_line:i.source_line,source_event_time:i.source_event_time,source_anchor:i.source_anchor},created_at:at,updated_at:at};
      store.save(s,'item',record.item_id,record,'approved_pass_backfill',at);
    }
    const g=b.grade,r=sources.get(g.record_id),grade={...s,outcome_id:gradeId,assessment_id:'busn5000:exam1',assessment:'Exam 1',assessed_at:r.at,assessment_date_basis:'Assessment date not retained; timestamp is source receipt saved time.',earned:Number(g.value_as_reported.slice(0,-1)),possible:100,value_as_reported:g.value_as_reported,hypothesis_ids:[],reported_by:'Daksh',verification:'reported',verification_basis:'Student report quoted in the approved PASS receipt; not verified against eLC.',reported_source:{record_id:g.record_id,revision:1,source_line:g.source_line,student_quote:g.student_quote,source_anchor:g.source_anchor},recording_agent:BACKFILL_AGENT,backfilled:true,revision:1,saved_at:at,updated_at:at,suggestions:[]};
    store.save(s,'outcome',gradeId,grade,'approved_pass_grade_backfill',at);
    store.derive(s,at);
    const hypotheses=store.entities(s,'hypothesis').filter(h=>!before.has(h.hypothesis_id));
    const result={ok:true,operation_id:b.idempotency_key,...s,item_count:ids.length,item_ids:ids,item_revision:1,grade_record_id:gradeId,grade_revision:1,hypotheses_generated:hypotheses.map(h=>({hypothesis_id:h.hypothesis_id,revision:h.revision,statement:h.statement,status:h.status,item_ids:h.item_ids})),receipt:{action:'approved_pass_backfill',at},readback_required:true};
    store.sql.exec('INSERT INTO learner_receipts VALUES (?,?,?,?)',key,b.idempotency_key,fingerprint,JSON.stringify(result));return result;
  });
}
