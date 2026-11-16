// Private structured evidence. Never writes PASS, progress or legacy learning.
import {TERM_ID} from './identity.js';
import {LEARNING_COURSES} from './learning-store.js';
import {ANNOUNCEMENT_COURSES} from './announcement-store.js';
export const DISTRACTORS=['concept_confusion','calculation','sign','units','reading','unspecified'];
const fail=s=>{throw Error(s);};
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v);
export function fields(v,allowed){if(!obj(v)||Object.keys(v).some(k=>!allowed.includes(k)))fail('invalid_learner_fields');}
export function text(v,max=200){if(typeof v!=='string'||!v.trim()||v.length>max||/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v)||/\bBearer\s+\S+|\b(?:sp1|pp1)_[a-f0-9]{64}\b|\b(?:api_key|access_token|password)\s*[:=]/i.test(v))fail('invalid_learner_text');return v.trim();}
export const ident=v=>/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(text(v,160))?v:fail('invalid_learner_id');
const pick=(v,list)=>list.includes(v)?v:fail('invalid_learner_choice');
const stamp=v=>{if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v)||!Number.isFinite(Date.parse(v)))fail('invalid_learner_timestamp');return new Date(v).toISOString();};
export function source(raw){fields(raw,['material_id','revision','url','locator']);const url=text(raw.url,1000);let u;try{u=new URL(url);}catch{fail('invalid_learner_source');}if(u.protocol!=='https:'||u.username||u.password||/[\u0000-\u0020]/.test(url)||[...u.searchParams.keys()].some(k=>/token|secret|password|key|auth/i.test(k)))fail('invalid_learner_source');return {material_id:ident(raw.material_id),revision:text(raw.revision,100),url:u.href,...(raw.locator?{locator:text(raw.locator,200)}:{})};}
export function learnerScope(raw,all=false){const course=raw.course??(all?null:undefined);if(course!==null&&!LEARNING_COURSES.includes(course))fail('invalid_learner_course');if(raw.term_id!==undefined&&raw.term_id!==TERM_ID)fail('invalid_learner_term');if(raw.sandbox!==undefined&&typeof raw.sandbox!=='boolean')fail('invalid_learner_sandbox');return {course,term_id:TERM_ID,sandbox:raw.sandbox??false};}
const scopeKey=s=>`${s.sandbox?'sandbox':'live'}:${s.term_id}:${s.course}`;
const lists=v=>JSON.parse(v);
export function normalizeLearnerCommand(raw){
  const action=pick(raw?.action,['start_item','answer_item','set_hypothesis_status','save_outcome','import_elc_outcome','apply_outcome_suggestion','update_settings']);
  const extra={start_item:['item'],answer_item:['answer'],set_hypothesis_status:['hypothesis_id','status','student_instruction'],save_outcome:['outcome'],import_elc_outcome:['outcome','elc_read'],apply_outcome_suggestion:['outcome_id','hypothesis_id','decision'],update_settings:['review_days']}[action];
  fields(raw,['action','course','term_id','sandbox','expected_revision','idempotency_key',...extra]);
  const scope=learnerScope(raw);if(!Number.isSafeInteger(raw.expected_revision)||raw.expected_revision<0)fail('invalid_learner_revision');
  const b={action,...scope,expected_revision:raw.expected_revision,idempotency_key:ident(raw.idempotency_key)};
  if(action==='start_item'){
    const i=raw.item;fields(i,['item_id','session_id','source','question','options','confidence','confidence_stated_at','recording_agent','review_of']);
    if(!Array.isArray(i.options)||i.options.length<2||i.options.length>8)fail('invalid_learner_options');
    const options=i.options.map(o=>{fields(o,['id','text','distractor_type']);return {id:ident(o.id),text:text(o.text,600),distractor_type:pick(o.distractor_type??'unspecified',DISTRACTORS)};});
    if(new Set(options.map(o=>o.id)).size!==options.length)fail('invalid_learner_options');
    if(i.confidence!==null&&(!Number.isInteger(i.confidence)||i.confidence<0||i.confidence>100))fail('invalid_learner_confidence');
    b.item={item_id:ident(i.item_id),session_id:ident(i.session_id),source:source(i.source),question:text(i.question,2000),options,confidence:i.confidence,confidence_stated_at:stamp(i.confidence_stated_at),recording_agent:text(i.recording_agent,80),...(i.review_of?{review_of:ident(i.review_of)}:{})};
  }
  if(action==='answer_item'){
    const a=raw.answer;fields(a,['item_id','chosen_answer','correct_answer','answer_source','help_level','answered_at','recording_agent']);
    b.answer={item_id:ident(a.item_id),chosen_answer:ident(a.chosen_answer),correct_answer:ident(a.correct_answer),answer_source:source(a.answer_source),help_level:pick(a.help_level,['none','hint','worked_example','answer_shown']),answered_at:stamp(a.answered_at),recording_agent:text(a.recording_agent,80)};
  }
  if(action==='set_hypothesis_status'){b.hypothesis_id=ident(raw.hypothesis_id);b.status=pick(raw.status,['open','confirmed','rejected','ignored']);if(raw.student_instruction){fields(raw.student_instruction,['text','source','recording_agent']);b.student_instruction={text:text(raw.student_instruction.text,600),source:text(raw.student_instruction.source,300),recording_agent:text(raw.student_instruction.recording_agent,80)};}}
  if(['save_outcome','import_elc_outcome'].includes(action)){
    const o=raw.outcome;fields(o,['outcome_id','assessment_id','assessment','assessed_at','earned','possible','hypothesis_ids','reported_by']);
    if(!Number.isFinite(o.earned)||!Number.isFinite(o.possible)||o.possible<=0||o.earned<0||o.earned>o.possible)fail('invalid_learner_grade');
    if(!Array.isArray(o.hypothesis_ids)||o.hypothesis_ids.length>20||new Set(o.hypothesis_ids).size!==o.hypothesis_ids.length)fail('invalid_learner_hypotheses');
    b.outcome={outcome_id:ident(o.outcome_id),assessment_id:ident(o.assessment_id),assessment:text(o.assessment,200),assessed_at:stamp(o.assessed_at),earned:o.earned,possible:o.possible,hypothesis_ids:o.hypothesis_ids.map(ident),reported_by:text(o.reported_by,80)};
    if(action==='import_elc_outcome'){
      const e=raw.elc_read;fields(e,['source','observed_at','recording_agent','receipt_id','assessment_id','earned','possible']);const s=source(e.source),u=new URL(s.url);
      if(u.hostname!=='uga.view.usg.edu'||!u.pathname.startsWith('/d2l/')||u.searchParams.getAll('ou').length!==1||u.searchParams.get('ou')!==ANNOUNCEMENT_COURSES[scope.course]||e.assessment_id!==o.assessment_id||e.earned!==o.earned||e.possible!==o.possible)fail('invalid_elc_read_evidence');
      b.elc_read={source:s,observed_at:stamp(e.observed_at),recording_agent:text(e.recording_agent,80),receipt_id:ident(e.receipt_id),assessment_id:e.assessment_id,earned:e.earned,possible:e.possible};
    }
  }
  if(action==='apply_outcome_suggestion'){b.outcome_id=ident(raw.outcome_id);b.hypothesis_id=ident(raw.hypothesis_id);b.decision=pick(raw.decision,['confirm','retire']);}
  if(action==='update_settings'){if(!Number.isInteger(raw.review_days)||raw.review_days<1||raw.review_days>90)fail('invalid_review_days');b.review_days=raw.review_days;}
  return b;
}
export function aggregateItems(items){
  const done=items.filter(i=>i.state==='answered'),buckets=[{range:'0–24',min:0,max:24},{range:'25–49',min:25,max:49},{range:'50–74',min:50,max:74},{range:'75–100',min:75,max:100}];
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}),trends=new Map();
  for(const i of done){const day=i.backfilled&&/^\d{4}-\d\d-\d\d$/.test(i.practice_date||'')?i.practice_date:formatter.format(new Date(i.answered_at));if(!trends.has(i.course))trends.set(i.course,new Map());const days=trends.get(i.course),row=days.get(day)||{day,attempted:0,correct:0};row.attempted++;row.correct+=i.correct?1:0;days.set(day,row);}
  return {attempted:done.length,assessed:done.filter(i=>typeof i.correct==='boolean').length,unassessed:done.filter(i=>typeof i.correct!=='boolean').length,backfilled:done.filter(i=>i.backfilled).length,correct:done.filter(i=>i.correct===true).length,misses_by_distractor_type:Object.fromEntries(DISTRACTORS.map(t=>[t,done.filter(i=>i.correct===false&&i.options?.find(o=>o.id===i.chosen_answer)?.distractor_type===t).length])),
    calibration:buckets.map(b=>{const rows=done.filter(i=>i.confidence!==null&&typeof i.correct==='boolean'&&i.confidence>=b.min&&i.confidence<=b.max);return {range:b.range,count:rows.length,mean_stated_confidence:rows.length?rows.reduce((n,i)=>n+i.confidence,0)/rows.length:null,accuracy:rows.length?rows.filter(i=>i.correct).length/rows.length:null};}),
    unknown_confidence:done.filter(i=>i.confidence===null).length,
    course_trends:LEARNING_COURSES.filter(c=>trends.has(c)).map(course=>({course,timezone:'America/New_York',by_day:[...trends.get(course).values()].sort((a,b)=>a.day.localeCompare(b.day))}))};
}
export function reviewItems(items,hypotheses,reviewDays,now=new Date()){
  const cutoff=now.getTime()-reviewDays*86400000,rows=[];
  const lastReview=id=>Math.max(0,...items.filter(i=>i.review_of===id&&i.state==='answered').map(i=>Date.parse(i.answered_at)));
  const add=(id,course,title,evidenceAt,itemIds,kind)=>{const last=Math.max(Date.parse(evidenceAt),lastReview(id));if(last<=cutoff)rows.push({review_id:id,course_code:course,title,kind,evidence_at:evidenceAt,last_practiced_at:new Date(last).toISOString(),due_since:new Date(last+reviewDays*86400000).toISOString(),review_days:reviewDays,instruction:'Ask a retrieval-practice question before giving hints or re-explanation. Record stated confidence first.',item_ids:itemIds,evidence_links:itemIds.map(i=>({url:'/app/profile?'+new URLSearchParams({course,item_id:i,sandbox:String(items.find(row=>row.item_id===i&&row.course===course)?.sandbox??false)}),label:'Practice item '+i})),url:'/app/profile?'+new URLSearchParams({course,review_id:id,sandbox:String(items.find(row=>row.course===course)?.sandbox??false)})});};
  for(const h of hypotheses.filter(h=>h.status==='open'))add(h.hypothesis_id,h.course,'Review hypothesis: '+h.statement,h.evidence_at,h.item_ids,'hypothesis');
  const sessions=new Map();for(const i of items.filter(i=>i.state==='answered')){const k=i.course+':'+i.session_id;if(!sessions.has(k))sessions.set(k,[]);sessions.get(k).push(i);}
  for(const group of sessions.values()){const assessed=group.filter(i=>typeof i.correct==='boolean'),misses=assessed.filter(i=>i.correct===false);if(assessed.length>=2&&misses.length/assessed.length>=0.5){const id='session:'+group[0].course+':'+group[0].session_id;if(hypotheses.some(h=>h.status==='open'&&h.item_ids.some(i=>group.some(r=>r.item_id===i))))continue;add(id,group[0].course,`Retrieval review: ${misses.length} of ${assessed.length}${assessed.length<group.length?' assessed':''} responses incorrect`,group.map(i=>i.answered_at).sort().at(-1),assessed.map(i=>i.item_id),'practice_session');}}
  return rows.sort((a,b)=>a.due_since.localeCompare(b.due_since)||a.review_id.localeCompare(b.review_id));
}
export class LearnerStore{
  constructor(storage){this.storage=storage;this.sql=storage.sql;this.sql.exec(`CREATE TABLE IF NOT EXISTS learner_entities(scope TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(scope,kind,id));
    CREATE TABLE IF NOT EXISTS learner_events(scope TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,action TEXT NOT NULL,at TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scope,kind,id,revision));
    CREATE TABLE IF NOT EXISTS learner_receipts(scope TEXT NOT NULL,operation_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,operation_id));`);}
  rows(q,...args){return this.sql.exec(q,...args).toArray();}
  entities(s,kind){return this.rows('SELECT data FROM learner_entities WHERE scope=? AND kind=? ORDER BY at DESC,id DESC',scopeKey(s),kind).map(r=>lists(r.data));}
  one(s,kind,id){const row=this.rows('SELECT data FROM learner_entities WHERE scope=? AND kind=? AND id=?',scopeKey(s),kind,id)[0];return row?lists(row.data):undefined;}
  save(s,kind,id,record,action,at){const key=scopeKey(s);this.sql.exec('INSERT INTO learner_entities VALUES (?,?,?,?,?,?) ON CONFLICT(scope,kind,id) DO UPDATE SET revision=excluded.revision,data=excluded.data,at=excluded.at',key,kind,id,record.revision,JSON.stringify(record),at);this.sql.exec('INSERT INTO learner_events VALUES (?,?,?,?,?,?,?)',key,kind,id,record.revision,action,at,JSON.stringify(record));}
  itemsRead(raw={}){
    const s=learnerScope(raw,true),scopes=(s.course?[s.course]:LEARNING_COURSES).map(course=>scopeKey({...s,course}));
    const limit=raw.limit??50,offset=raw.offset??0;if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||offset>12000)fail('invalid_learner_page');
    const where="kind='item' AND scope IN ("+scopes.map(()=>'?').join(',')+')';
    if(raw.item_id){if(!s.course)fail('invalid_learner_exact_scope');const item=this.one(s,'item',ident(raw.item_id));return item?{ok:true,item}:{error:'item_not_found',status:404};}
    const count=this.rows('SELECT count(*) AS n FROM learner_entities WHERE '+where,...scopes)[0].n;
    return {ok:true,items:this.rows('SELECT data FROM learner_entities WHERE '+where+' ORDER BY at DESC,id DESC LIMIT ? OFFSET ?',...scopes,limit,offset).map(r=>lists(r.data)),item_count:count,next_offset:offset+limit<count?offset+limit:null};
  }
  profile(raw={},at=new Date().toISOString(),summary=false){
    const s=learnerScope(raw,true),courses=s.course?[s.course]:LEARNING_COURSES,all=kind=>courses.flatMap(course=>this.entities({...s,course},kind));
    // Full question/option text is read only in the bounded item page. Fold one
    // course at a time so an all-course aggregate never materializes every body.
    const items=summary?courses.flatMap(course=>this.entities({...s,course},'item').map(i=>({item_id:i.item_id,course:i.course,sandbox:i.sandbox,state:i.state,session_id:i.session_id,correct:i.correct,confidence:i.confidence,answered_at:i.answered_at,review_of:i.review_of,backfilled:i.backfilled,practice_date:i.practice_date,topic_tag:i.topic_tag,chosen_answer:i.chosen_answer,options:i.chosen_answer&&i.options?[{id:i.chosen_answer,distractor_type:i.options.find(o=>o.id===i.chosen_answer).distractor_type}]:[]}))):all('item');
    const hypotheses=all('hypothesis'),outcomes=all('outcome'),settings=courses.map(course=>({course,review_days:this.one({...s,course},'settings','settings')?.review_days??7,revision:this.one({...s,course},'settings','settings')?.revision??0}));
    const reviews=courses.flatMap(course=>reviewItems(items.filter(i=>i.course===course),hypotheses.filter(h=>h.course===course),settings.find(s=>s.course===course).review_days,new Date(at)));
    return {ok:true,version:'learner-profile/1',...s,generated_at:at,items,hypotheses,outcomes,settings,aggregates:aggregateItems(items),reviews,
      authority:'Observations are recorded responses, not mastery. Hypotheses are evidence-backed patterns, never facts about the student. Outcome suggestions require student approval.',privacy:{private:true,pass_mutated:false,legacy_learning_mutated:false,school_learner_access_requires_explicit_approval:true}};
  }
  derive(s,at){
    const items=this.entities(s,'item').filter(i=>i.state==='answered'),existing=this.entities(s,'hypothesis'),candidates=[];
    for(const type of DISTRACTORS){const rows=items.filter(i=>i.correct===false&&i.options?.find(o=>o.id===i.chosen_answer)?.distractor_type===type);if(rows.length>=2)candidates.push({pattern:'distractor:'+type,rows,statement:`${rows.length} recorded misses selected options tagged ${type.replaceAll('_',' ')}.`});}
    // Free-response backfills have no invented choices/distractor labels. The
    // same engine can count explicit source-recorded errors by question topic.
    for(const tag of [...new Set(items.map(i=>i.topic_tag).filter(Boolean))]){const rows=items.filter(i=>i.topic_tag===tag&&i.correct===false);if(rows.length>=2)candidates.push({pattern:'topic:'+tag,rows,statement:`${rows.length} recorded incorrect responses are tagged ${tag.replaceAll('_',' ')}.`});}
    const high=items.filter(i=>i.correct===false&&i.confidence!==null&&i.confidence>=75),low=items.filter(i=>i.correct===true&&i.confidence!==null&&i.confidence<25);
    if(high.length>=2)candidates.push({pattern:'calibration:high',rows:high,statement:`${high.length} incorrect responses had stated confidence of at least 75%.`});
    if(low.length>=2)candidates.push({pattern:'calibration:low',rows:low,statement:`${low.length} correct responses had stated confidence below 25%.`});
    for(const c of candidates){if(existing.some(h=>h.pattern===c.pattern))continue;const id='hyp:'+crypto.randomUUID(),record={...s,hypothesis_id:id,revision:1,pattern:c.pattern,statement:c.statement,confidence_tag:c.rows.length>=5?'moderate':'provisional',item_ids:c.rows.map(i=>i.item_id).sort(),evidence_at:c.rows.map(i=>i.answered_at).sort().at(-1),created_at:at,status:'open',status_set_by:'not_yet_set',status_at:null};this.save(s,'hypothesis',id,record,'derive_from_items',at);}
  }
  put({body:raw,fingerprint,at,actor='agent'}){
    const b=normalizeLearnerCommand(raw),s=learnerScope(b),key=scopeKey(s);stamp(at);if(!/^[a-f0-9]{64}$/.test(fingerprint))fail('invalid_learner_fingerprint');
    if(['set_hypothesis_status','apply_outcome_suggestion','update_settings','import_elc_outcome'].includes(b.action)&&actor!=='student'&&!(b.action==='set_hypothesis_status'&&actor==='student_authorized_agent'&&b.student_instruction))return {error:'student_control_required',status:403};
    return this.storage.transactionSync(()=>{
      const previous=this.rows('SELECT fingerprint,result FROM learner_receipts WHERE scope=? AND operation_id=?',key,b.idempotency_key)[0];if(previous)return previous.fingerprint===fingerprint?{...lists(previous.result),replayed:true}:{error:'idempotency_conflict',status:409};
      let kind,id,record;
      if(b.action==='start_item'){
        kind='item';id=b.item.item_id;if(this.one(s,kind,id))return {error:'item_already_exists',status:409};if(Date.parse(b.item.confidence_stated_at)>Date.parse(at)+60000)return {error:'confidence_time_in_future',status:400};
        if(b.item.review_of&&!this.profile(s,at).reviews.some(r=>r.review_id===b.item.review_of))return {error:'review_target_unavailable',status:409};
        record={...s,...b.item,state:'started',revision:0,created_at:at,confidence_received_at:at,chosen_answer:null,correct_answer:null,correct:null};
      }else if(b.action==='answer_item'){
        kind='item';id=b.answer.item_id;record=this.one(s,kind,id);if(!record)return {error:'item_not_found',status:404};if(record.state!=='started')return {error:'item_already_answered',status:409};
        if(Date.parse(b.answer.answered_at)<Date.parse(record.confidence_received_at)||Date.parse(b.answer.answered_at)>Date.parse(at)+60000)return {error:'confidence_must_precede_answer',status:400};
        if(![b.answer.chosen_answer,b.answer.correct_answer].every(a=>record.options.some(o=>o.id===a)))return {error:'answer_option_unknown',status:400};
        record={...record,...b.answer,answering_agent:b.answer.recording_agent,recording_agent:record.recording_agent,state:'answered',correct:b.answer.chosen_answer===b.answer.correct_answer};
      }else if(b.action==='set_hypothesis_status'){
        kind='hypothesis';id=b.hypothesis_id;record=this.one(s,kind,id);if(!record)return {error:'hypothesis_not_found',status:404};record={...record,status:b.status,status_set_by:actor==='student_authorized_agent'?'student_via_agent':'student',status_at:at,...(b.student_instruction?{status_instruction:b.student_instruction}:{})};
      }else if(['save_outcome','import_elc_outcome'].includes(b.action)){
        kind='outcome';id=b.outcome.outcome_id;record=this.one(s,kind,id);if(record&&(!b.elc_read||record.verification!=='reported'||record.assessment_id!==b.outcome.assessment_id))return {error:'outcome_already_exists',status:409};
        if(this.entities(s,kind).some(o=>o.outcome_id!==id&&o.assessment_id===b.outcome.assessment_id))return {error:'assessment_already_recorded',status:409};
        if(b.outcome.hypothesis_ids.some(id=>!this.one(s,'hypothesis',id)))return {error:'hypothesis_not_found',status:404};
        if(Date.parse(b.outcome.assessed_at)>Date.parse(at)+60000)return {error:'invalid_outcome_date',status:400};
        if(b.elc_read&&Date.parse(b.elc_read.observed_at)>Date.parse(at)+60000)return {error:'invalid_elc_read_evidence',status:400};
        const ratio=b.outcome.earned/b.outcome.possible;
        record={...s,...b.outcome,revision:record?.revision??0,verification:b.elc_read?'verified':'reported',verification_basis:b.elc_read?'Original eLC read receipt supplied by owner; not an independent server login.':'Student-reported; no portal verification.',...(b.elc_read?{elc_read:b.elc_read}:{}),saved_at:at,
          suggestions:b.outcome.hypothesis_ids.map(hypothesis_id=>({hypothesis_id,suggestion:ratio>=0.8?'retire':ratio<0.6?'confirm':'insufficient_signal',basis:'Assessment result only; assessment alignment and pattern validity require student review.',status:'pending'}))};
      }else if(b.action==='apply_outcome_suggestion'){
        kind='hypothesis';id=b.hypothesis_id;record=this.one(s,kind,id);const outcome=this.one(s,'outcome',b.outcome_id),suggestion=outcome?.suggestions.find(x=>x.hypothesis_id===id);
        if(!record||!suggestion)return {error:'outcome_link_not_found',status:404};if(suggestion.suggestion!==b.decision)return {error:'outcome_suggestion_mismatch',status:409};
        record={...record,status:b.decision==='confirm'?'confirmed':'ignored',status_set_by:'student',status_at:at,outcome_decision:{outcome_id:b.outcome_id,decision:b.decision}};
      }else{kind='settings';id='settings';record=this.one(s,kind,id)||{...s,id,revision:0};record={...record,review_days:b.review_days};}
      if(record.revision!==b.expected_revision)return {error:'revision_conflict',status:409,current_revision:record.revision};
      if(!record.revision&&this.entities(s,kind).length>=({item:2000,hypothesis:100,outcome:200,settings:1}[kind]))return {error:'learner_capacity_reached',status:409};
      record={...record,revision:record.revision+1,updated_at:at};this.save(s,kind,id,record,b.action,at);if(b.action==='answer_item')this.derive(s,at);
      const result={ok:true,operation_id:b.idempotency_key,kind,id,revision:record.revision,...s,receipt:{action:b.action,at},readback_required:true};
      this.sql.exec('INSERT INTO learner_receipts VALUES (?,?,?,?)',key,b.idempotency_key,fingerprint,JSON.stringify(result));return result;
    });
  }
}
