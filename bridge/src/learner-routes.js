import {state,readBody,digest,stableJSON} from './foundation.js';
import {normalizeLearnerCommand,learnerScope,fields,ident} from './learner-store.js';
import {captureWispr} from './wispr-capture.js';
import {LEARNER_TOOLS} from './learner-tools.js';
import {learnerToolAllowed} from './school-learner-access.js';
const json=(b,s=200)=>Response.json(b,{status:s,headers:{'Cache-Control':'no-store'}});
const controls=['set_hypothesis_status','apply_outcome_suggestion','update_settings','import_elc_outcome'];
export async function learnerRead(env,args){
  fields(args,['course','term_id','sandbox','item_id','outcome_id','limit','offset']);const scope=learnerScope(args,true);
  if(args.item_id&&args.outcome_id||(args.item_id||args.outcome_id)&&!scope.course)throw Error('invalid_learner_exact_scope');
  if(args.item_id)return state(env).learnerItems({...scope,item_id:ident(args.item_id)});
  const p=await state(env).learnerProfile(scope);if(p?.ok!==true)throw Error('learner_read_unavailable');
  if(args.outcome_id){const outcome=p.outcomes.find(i=>i.outcome_id===ident(args.outcome_id));return outcome?{ok:true,outcome}:{error:'outcome_not_found',status:404};}
  const limit=args.limit??50,offset=args.offset??0;if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||offset>12000)throw Error('invalid_learner_page');
  const page=await state(env).learnerItems({...scope,limit,offset});if(page?.ok!==true)throw Error('learner_read_unavailable');
  return {...p,...page};
}
export async function learnerRoutes(request,env,path,auth,access=null){
  if(!path.startsWith('/learner/'))return null;
  if(!['session','bearer'].includes(auth)&&!(auth==='scoped_learner'&&path.startsWith('/learner/tools/')&&learnerToolAllowed(path.slice('/learner/tools/'.length),access?.learner_scopes||[])))return json({error:'unauthorized'},401);
  let operation_id;
  try{
    if(path==='/learner/backfill-pass'){
      if(auth!=='session')return json({error:'owner_browser_required'},403);
      if(request.method!=='POST')return json({error:'method_not_allowed'},405);
      const body=await readBody(request,100000);operation_id=body.idempotency_key;
      const out=await state(env).learnerBackfill(body);return json(out,out.status||200);
    }
    if(path==='/learner/profile'&&request.method==='GET'){
      const q=new URL(request.url).searchParams,allowed=['course','term_id','sandbox','item_id','outcome_id','limit','offset'];
      if([...q.keys()].some(k=>!allowed.includes(k)||q.getAll(k).length!==1)||q.has('sandbox')&&!['true','false'].includes(q.get('sandbox')))throw Error('invalid_learner_query');
      const args=Object.fromEntries(q);if(q.has('sandbox'))args.sandbox=q.get('sandbox')==='true';for(const k of ['limit','offset'])if(q.has(k)){if(!/^\d+$/.test(q.get(k)))throw Error('invalid_learner_page');args[k]=Number(q.get(k));}
      const out=await learnerRead(env,args);return json(out,out.status||200);
    }
    const toolPath=path.startsWith('/learner/tools/'),tool=toolPath?path.slice('/learner/tools/'.length):null;
    if(toolPath&&!LEARNER_TOOLS.some(t=>t.name===tool))return json({error:'unknown_learner_tool'},404);
    if(!toolPath&&path!=='/learner/control')return json({error:'not_found'},404);
    if(request.method!=='POST')return json({error:'method_not_allowed'},405);
    if(!(request.headers.get('Content-Type')||'').toLowerCase().startsWith('application/json'))return json({error:'json_required'},415);
    const raw=await readBody(request,18000);
    if(['read_learner_profile','read_practice_items','read_grade_outcomes','read_hypotheses','read_review_items'].includes(tool)){
      if(['read_hypotheses','read_review_items'].includes(tool))fields(raw,['course','term_id','sandbox']);
      const out=await learnerRead(env,raw);if(tool==='read_practice_items'){const {items,item_count,next_offset}=out;return json(out.error||out.item?out:{ok:true,items,item_count,next_offset},out.status||200);}
      if(tool==='read_hypotheses')return json({ok:true,hypotheses:out.hypotheses,authority:out.authority});
      if(tool==='read_review_items')return json({ok:true,reviews:out.reviews,scope:{course:out.course,term_id:out.term_id,sandbox:out.sandbox}});
      if(tool==='read_grade_outcomes')return json(out.error||out.outcome?out:{ok:true,outcomes:out.outcomes},out.status||200);return json(out,out.status||200);
    }
    if(tool==='capture_wispr_note'){const out=await captureWispr(raw,env,new URL(request.url).origin);return json(out,out.status||200);}
    if(toolPath){const action={start_practice_item:'start_item',answer_practice_item:'answer_item',save_grade_outcome:'save_outcome',set_hypothesis_status:'set_hypothesis_status'}[tool];if(!action)return json({error:'unknown_learner_tool'},404);if(raw.action!==undefined)throw Error('invalid_learner_fields');raw.action=action;}
    if(!toolPath&&(auth!=='session'||!controls.includes(raw.action)))return json({error:'student_control_required'},403);
    const body=normalizeLearnerCommand(raw);operation_id=body.idempotency_key;
    const header=request.headers.get('Idempotency-Key');if(header&&header!==operation_id)throw Error('invalid_learner_idempotency_key');
    if(tool==='set_hypothesis_status'&&!body.student_instruction)return json({error:'explicit_student_instruction_required'},403);
    const out=await state(env).learnerPut({body,fingerprint:await digest(stableJSON(body)),at:new Date().toISOString(),actor:tool==='set_hypothesis_status'?'student_authorized_agent':toolPath?'agent':'student'});
    return json(out,out.status||200);
  }catch(e){const m=e?.message||'';if(m==='body_too_large')return json({error:m},413);
    if(/^(invalid_|selected_student_|restricted_wispr_|wispr_capture_too_large)/.test(m))return json({error:m},400);
    return json({error:request.method==='GET'?'learner_read_unavailable':'learner_write_not_confirmed',...(operation_id?{operation_id}:{}),detail:'Inspect the exact record or retry the identical packet and operation ID. Do not assume a save succeeded.'},503);}
}
