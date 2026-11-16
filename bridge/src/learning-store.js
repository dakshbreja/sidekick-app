// This is a private learning handoff, not coursework progress or a gradebook.
// Keep summaries small and receipts transactional so opening a new class chat
// can resume from observed practice without inventing historical chat access.
import { TERM_ID } from './identity.js';

export const LEARNING_COURSE='BUSN5000';
// Roll out explicitly selected personal classes; a course in the wider school
// registry is not automatically permission to expose its learning record.
export const LEARNING_COURSES=Object.freeze([LEARNING_COURSE,'MGMT4280','MGMT5560','MGMT5850','LAND2510','BUSN3040']);
export const LEARNING_LIMITS=Object.freeze({topics:80,recent_sessions:12,recovery_revisions:10,receipts:128,session_ids:512,record_bytes:60000});
const fail=code=>{throw new Error(code);};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
function keys(value,allowed) {
  if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail('unknown_learning_fields');
}
function text(value,max,required=false) {
  if(typeof value!=='string'||value.length>max||required&&!value.trim()||/[\u0000-\u001f\u007f]/.test(value)||/<\/?[a-z][^>]*>/i.test(value))fail('invalid_learning_text');
  // Apply the same grade/credential/transcript boundary as agenda/news. The
  // learning API rejects the packet rather than silently saving a redaction.
  if(/GRADEBOOK\s*:|\b(?:grades?|scores?|marks?)\s*(?:[:=]|is\b|of\b|was\b)\s*(?:\d|[A-F][+-]?\b)|\b(?:grade|score)\s*(?:(?:is|was|of)\s*)?[:=]?\s*\d+(?:\.\d+)?\b|\b(?:grade|score|earned|received|points)\b[^.!?]{0,60}(?:\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*\/\s*\d+|\b\d+(?:\.\d+)?\s*(?:points|pts)\b)/i.test(value)||
    /\b(?:GPA|grade[- ]point average)\s*(?:[:=]|is\b|was\b|of\b)?\s*\d+(?:\.\d+)?|\b(?:grades?|marks?)\s*[:=]?\s*[A-F][+-]?(?=\s|[.!?]|$)|\b(?:earned|received|got)\s+(?:an?\s+)?[A-F][+-]?(?=\s+(?:in|on|for)\b|[.!?]|$)|\b(?:transcript|speaker\s*\d+)\s*:|\[\d{1,2}:\d{2}(?::\d{2})?\]|\bBearer\s+\S+|\b(?:access_token|refresh_token|client_secret|api_key)\b|\b(?:password|authorization)\s*(?:[:=]|is\b)|\bsk-[A-Za-z0-9_-]{12,}/i.test(value))fail('restricted_learning_content');
  if(/(?:https?|javascript|data|webcal):\/\//i.test(value))fail('invalid_learning_text');
  return value.trim();
}
const id=(v,name,max=100)=>typeof v==='string'&&v.length<=max&&/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(v)?text(v,max,true):fail('invalid_'+name);
const choice=(v,allowed,name)=>allowed.includes(v)?v:fail('invalid_'+name);
const optionalText=(v,max)=>v==null?'':text(v,max);
const clone=value=>JSON.parse(JSON.stringify(value));
export function learningScope(course,term,sandbox=false) {
  if(!LEARNING_COURSES.includes(course))fail('learning_course_unavailable');
  if(term!==TERM_ID)fail('invalid_learning_term');
  if(typeof sandbox!=='boolean')fail('invalid_learning_sandbox');
  return {course,term_id:term,sandbox};
}
function sourceRef(raw) {
  keys(raw,['doc_id','title','locator']);
  return {doc_id:id(raw.doc_id,'source_ref',180),title:text(raw.title,160,true),locator:optionalText(raw.locator,120)};
}
function observation(raw) {
  keys(raw,['topic_id','label','demonstration','evidence','outcome','practice_kind','misconception','next_step','source_refs']);
  const demonstration=choice(raw.demonstration,['independent','with_hints','explanation_only','untested'],'demonstration');
  const evidence=choice(raw.evidence,['observed_response','learner_report','discussion_only','practice_generated'],'learning_evidence');
  if(['independent','with_hints'].includes(demonstration)&&evidence!=='observed_response'||demonstration==='explanation_only'&&evidence!=='discussion_only'||
    demonstration==='untested'&&evidence==='observed_response')fail('demonstration_evidence_conflict');
  const outcome=raw.outcome===undefined?'unassessed':choice(raw.outcome,['correct','partial','incorrect','not_attempted','unassessed'],'outcome');
  if(outcome!=='unassessed'&&(evidence!=='observed_response'||!['independent','with_hints'].includes(demonstration)))fail('invalid_outcome_evidence');
  const refs=raw.source_refs??[];
  if(!Array.isArray(refs)||refs.length>4)fail('invalid_source_refs');
  const source_refs=refs.map(sourceRef);
  if(new Set(source_refs.map(ref=>ref.doc_id+':'+ref.locator)).size!==source_refs.length)fail('duplicate_source_ref');
  // Omitted outcomes stay omitted in the canonical request so an exact retry
  // still matches a receipt fingerprint created by the v1 normalizer. Storage
  // always projects that omission to unassessed; omission cannot imply success.
  return {topic_id:id(raw.topic_id,'topic_id'),label:text(raw.label,120,true),demonstration,evidence,...(raw.outcome===undefined?{}:{outcome}),
    practice_kind:choice(raw.practice_kind,['conceptual','code','interpretation','mixed'],'practice_kind'),
    misconception:optionalText(raw.misconception,200),next_step:text(raw.next_step,240,true),source_refs};
}
function resume(raw) {
  if(raw==null)return null;
  keys(raw,['topic_id','next_step']);
  return {topic_id:id(raw.topic_id,'topic_id'),next_step:text(raw.next_step,240,true)};
}
function session(raw) {
  keys(raw,['session_id','goal','observations','resume']);
  if(!Array.isArray(raw.observations)||!raw.observations.length||raw.observations.length>8)fail('invalid_learning_observations');
  const observations=raw.observations.map(observation);
  if(new Set(observations.map(row=>row.topic_id)).size!==observations.length)fail('duplicate_learning_topic');
  const handoff=resume(raw.resume);
  return {session_id:id(raw.session_id,'learning_session_id',128),goal:text(raw.goal,240,true),observations,resume:handoff};
}
function preferences(raw) {
  keys(raw,['explanation_style','time_budget_minutes','practice_focus']);
  if(!Object.keys(raw).length)fail('empty_learning_preferences');
  const out={};
  if(raw.explanation_style!==undefined)out.explanation_style=choice(raw.explanation_style,['concise','step_by_step','examples_first'],'explanation_style');
  if(raw.practice_focus!==undefined)out.practice_focus=choice(raw.practice_focus,['conceptual','code','interpretation','mixed'],'practice_focus');
  if(raw.time_budget_minutes!==undefined) {
    if(!Number.isInteger(raw.time_budget_minutes)||raw.time_budget_minutes<5||raw.time_budget_minutes>180)fail('invalid_time_budget');
    out.time_budget_minutes=raw.time_budget_minutes;
  }
  return out;
}
export function normalizeLearningBody(raw) {
  if(!object(raw))fail('invalid_learning_command');
  const action=choice(raw.action,['save_session','update_preferences','forget_topic','reset','restore_revision'],'learning_action');
  const specific={save_session:['session'],update_preferences:['preferences'],forget_topic:['topic_id'],reset:[],restore_revision:['restore_revision']}[action];
  keys(raw,['action','course','term_id','sandbox','expected_revision','idempotency_key',...specific]);
  const scope=learningScope(raw.course,raw.term_id,raw.sandbox??false);
  if(!Number.isInteger(raw.expected_revision)||raw.expected_revision<0||!Number.isSafeInteger(raw.expected_revision))fail('expected_revision_required');
  const out={action,...scope,expected_revision:raw.expected_revision,idempotency_key:id(raw.idempotency_key,'idempotency_key',160)};
  if(action==='save_session')out.session=session(raw.session);
  if(action==='update_preferences')out.preferences=preferences(raw.preferences);
  if(action==='forget_topic')out.topic_id=id(raw.topic_id,'topic_id');
  if(action==='restore_revision') {
    if(!Number.isInteger(raw.restore_revision)||raw.restore_revision<0||!Number.isSafeInteger(raw.restore_revision))fail('invalid_restore_revision');
    out.restore_revision=raw.restore_revision;
  }
  return out;
}
const empty=scope=>({schema_version:2,course:scope.course,term_id:scope.term_id,sandbox:scope.sandbox,revision:0,updated_at:null,topics:[],recent_sessions:[],resume:null,preferences:{}});
const scopeKey=scope=>`${scope.sandbox?'sandbox':'live'}:${scope.term_id}:${scope.course}`;
const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
function projectRecord(raw) {
  const record=clone(raw),legacy=record.schema_version!==2;
  record.schema_version=2;
  record.topics=record.topics.map(topic=>({...topic,outcome:legacy?'unassessed':topic.outcome??'unassessed',
    // V1 recorded assistance, not correctness. Retain those observations only
    // as attempts; neither old summaries nor restores may invent successes.
    independent_attempts:legacy?Math.max(count(topic.independent_attempts),count(topic.independent_demonstrations)):count(topic.independent_attempts),
    hinted_attempts:legacy?Math.max(count(topic.hinted_attempts),count(topic.hinted_demonstrations)):count(topic.hinted_attempts),
    independent_demonstrations:legacy?0:count(topic.independent_demonstrations),
    hinted_demonstrations:legacy?0:count(topic.hinted_demonstrations)}));
  record.recent_sessions=record.recent_sessions.map(session=>({...session,
    topics:session.topics.map(topic=>({...topic,outcome:legacy?'unassessed':topic.outcome??'unassessed'}))}));
  return record;
}

export class LearningStore {
  constructor(storage) {
    this.storage=storage;this.sql=storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS learning_records (scope TEXT PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS learning_history (scope TEXT NOT NULL,revision INTEGER NOT NULL,action TEXT NOT NULL,data TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(scope,revision));
      CREATE TABLE IF NOT EXISTS learning_receipts (scope TEXT NOT NULL,operation_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(scope,operation_id));
      CREATE TABLE IF NOT EXISTS learning_session_ids (scope TEXT NOT NULL,session_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(scope,session_id));`);
  }
  rows(query,...args) {return this.sql.exec(query,...args).toArray();}
  get(course,term,sandbox=false) {
    const scope=learningScope(course,term,sandbox),key=scopeKey(scope);
    const found=this.rows('SELECT data FROM learning_records WHERE scope=?',key)[0];
    return {ok:true,record:found?projectRecord(JSON.parse(found.data)):empty(scope),
      recovery:this.rows('SELECT revision,action,at FROM learning_history WHERE scope=? ORDER BY revision DESC',key),
      retention:{...LEARNING_LIMITS},privacy:{raw_answers_stored:false,transcripts_stored:false,grades_stored:false,
        forget_behavior:'reversible_for_retained_recovery_revisions',sandbox_is_student_evidence:false}};
  }
  put(command) {
    keys(command,['body','operation_id','fingerprint','at']);
    const body=normalizeLearningBody(command.body);
    if(command.operation_id!==body.idempotency_key||typeof command.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(command.fingerprint)||
      typeof command.at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(command.at)||!Number.isFinite(Date.parse(command.at)))fail('invalid_learning_command');
    return this.storage.transactionSync(()=>{
      const key=scopeKey(body),{operation_id,fingerprint,at}=command;
      const priorReceipt=this.rows('SELECT fingerprint,result FROM learning_receipts WHERE scope=? AND operation_id=?',key,operation_id)[0];
      if(priorReceipt)return priorReceipt.fingerprint===fingerprint?{...JSON.parse(priorReceipt.result),replayed:true}:{error:'idempotency_conflict',status:409};
      const prior=this.get(body.course,body.term_id,body.sandbox).record;
      if(prior.revision!==body.expected_revision)return {error:'revision_conflict',status:409,current_revision:prior.revision};
      let next=clone(prior);
      if(body.action==='save_session') {
        const saved=this.rows('SELECT revision FROM learning_session_ids WHERE scope=? AND session_id=?',key,body.session.session_id)[0];
        if(saved)return {error:'learning_session_already_saved',status:409,current_revision:prior.revision};
        for(const observation of body.session.observations) {
          const priorTopic=next.topics.find(row=>row.topic_id===observation.topic_id);
          const outcome=observation.outcome??'unassessed',attempted=outcome!=='not_attempted',correct=outcome==='correct';
          const independent=observation.evidence==='observed_response'&&observation.demonstration==='independent';
          const hinted=observation.evidence==='observed_response'&&observation.demonstration==='with_hints';
          const topic={topic_id:observation.topic_id,label:observation.label,demonstration:observation.demonstration,evidence:observation.evidence,outcome,
            practice_kind:observation.practice_kind,misconception:observation.misconception,next_step:observation.next_step,source_refs:observation.source_refs,
            independent_attempts:count(priorTopic?.independent_attempts)+(independent&&attempted?1:0),
            hinted_attempts:count(priorTopic?.hinted_attempts)+(hinted&&attempted?1:0),
            independent_demonstrations:count(priorTopic?.independent_demonstrations)+(independent&&correct?1:0),
            hinted_demonstrations:count(priorTopic?.hinted_demonstrations)+(hinted&&correct?1:0),
            last_session_id:body.session.session_id,last_practiced_at:at};
          next.topics=next.topics.filter(row=>row.topic_id!==topic.topic_id);next.topics.push(topic);
        }
        if(body.session.resume&&!next.topics.some(row=>row.topic_id===body.session.resume.topic_id))return {error:'resume_topic_unknown',status:400};
        next.resume=body.session.resume;
        next.recent_sessions.push({session_id:body.session.session_id,goal:body.session.goal,at,
          topics:body.session.observations.map(row=>({topic_id:row.topic_id,demonstration:row.demonstration,evidence:row.evidence,outcome:row.outcome??'unassessed'}))});
        next.recent_sessions=next.recent_sessions.slice(-LEARNING_LIMITS.recent_sessions);
      } else if(body.action==='update_preferences')next.preferences={...next.preferences,...body.preferences};
      else if(body.action==='forget_topic') {
        if(!next.topics.some(row=>row.topic_id===body.topic_id))return {error:'learning_topic_not_found',status:404};
        next.topics=next.topics.filter(row=>row.topic_id!==body.topic_id);
        next.recent_sessions=next.recent_sessions.map(row=>({...row,topics:row.topics.filter(topic=>topic.topic_id!==body.topic_id)})).filter(row=>row.topics.length);
        // Session goals may mention the topic; clear them after any explicit
        // forgetting instead of trying to infer which free text is connected.
        next.recent_sessions=next.recent_sessions.map(row=>({...row,goal:'Study session'}));
        if(next.resume?.topic_id===body.topic_id)next.resume=null;
      } else if(body.action==='reset')next=empty(body);
      else {
        const old=this.rows('SELECT data FROM learning_history WHERE scope=? AND revision=?',key,body.restore_revision)[0];
        if(!old)return {error:'recovery_revision_unavailable',status:404};
        next=projectRecord(JSON.parse(old.data));
      }
      const revision=prior.revision+1;
      next={...next,course:body.course,term_id:body.term_id,sandbox:body.sandbox,revision,updated_at:at};
      const raw=JSON.stringify(next);
      if(next.topics.length>LEARNING_LIMITS.topics||new TextEncoder().encode(raw).byteLength>LEARNING_LIMITS.record_bytes)return {error:'learning_capacity_reached',status:409,current_revision:prior.revision};
      this.sql.exec('INSERT INTO learning_history VALUES (?,?,?,?,?)',key,prior.revision,body.action,JSON.stringify(prior),at);
      this.sql.exec('INSERT INTO learning_records VALUES (?,?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at',key,revision,raw,at);
      if(body.action==='save_session')this.sql.exec('INSERT INTO learning_session_ids VALUES (?,?,?)',key,body.session.session_id,revision);
      // Metadata-only receipts can confirm a lost response without retaining or
      // re-exposing a historical learner summary after an explicit forget/reset.
      const result={ok:true,operation_id,course:body.course,term_id:body.term_id,sandbox:body.sandbox,revision,
        receipt:{action:body.action,at},readback_required:true};
      this.sql.exec('INSERT INTO learning_receipts VALUES (?,?,?,?,?)',key,operation_id,fingerprint,JSON.stringify(result),at);
      this.sql.exec('DELETE FROM learning_history WHERE scope=? AND revision NOT IN (SELECT revision FROM learning_history WHERE scope=? ORDER BY revision DESC LIMIT ?)',key,key,LEARNING_LIMITS.recovery_revisions);
      this.sql.exec("DELETE FROM learning_receipts WHERE scope=? AND operation_id NOT IN (SELECT operation_id FROM learning_receipts WHERE scope=? ORDER BY CAST(json_extract(result,'$.revision') AS INTEGER) DESC LIMIT ?)",key,key,LEARNING_LIMITS.receipts);
      this.sql.exec('DELETE FROM learning_session_ids WHERE scope=? AND session_id NOT IN (SELECT session_id FROM learning_session_ids WHERE scope=? ORDER BY revision DESC LIMIT ?)',key,key,LEARNING_LIMITS.session_ids);
      return result;
    });
  }
}
