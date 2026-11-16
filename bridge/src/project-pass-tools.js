import {state,stableJSON,digest,readBody} from './foundation.js';
import {validateToolInput} from './pass-tools.js';
import {projectAccess} from './project-pass-store.js';

const str=max=>({type:'string',minLength:1,maxLength:max});
const integer={type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER};
const identity={project_id:{...str(64),description:'Exact registered project ID. Never a course, alias or arbitrary path.'},sandbox:{type:'boolean',default:false}};
const schema=(properties,required)=>({type:'object',additionalProperties:false,properties,required});
const definition=(name,description,inputSchema)=>({name,description,inputSchema});
const reference=schema({record_id:str(80),revision:{...integer,minimum:1}},['record_id','revision']);
const fact=schema({kind:{type:'string',enum:['observation','question','response','help','completed_action','unresolved','agreed_next_step']},
  basis:{type:'string',enum:['observed','user_report','source']},text:str(1000),source:str(400)},['kind','basis','text','source']);
export const PROJECT_PASS_TOOLS=[
  definition('list_pass_projects','List only projects this client may read.',schema({},[])),
  definition('register_pass_project','Owner-only exact project registration. Grants no assistant access.',schema({project_id:identity.project_id,name:str(120)},['project_id','name'])),
  definition('get_project_pass_protocol','Read project handoff and conflict rules for an authorized project.',schema(identity,['project_id'])),
  definition('list_project_passes','Read bounded dated handoff metadata and current project head revision. No automatic truth merge.',schema({...identity,limit:{type:'integer',minimum:1,maximum:20},cursor:{...integer,minimum:1}},['project_id'])),
  definition('read_project_pass','Read one exact handoff and the current head revision in its project/test scope.',schema({...identity,record_id:str(80)},['project_id','record_id'])),
  definition('resume_project_pass','Read the newest saved handoff for this exact project. Other handoffs may contain unresolved facts.',schema(identity,['project_id'])),
  definition('project_pass_history','Read revision history for one exact same-project handoff.',schema({...identity,record_id:str(80)},['project_id','record_id'])),
  definition('save_project_pass','Save an authorized factual checkpoint with provenance, record and project-head revisions, stable retry identity and independent readback. No repository, materials or school writes.',
    schema({...identity,session_id:str(100),record_id:str(80),date:str(10),title:str(160),goal:str(300),recorded_by:str(80),timezone:{...str(80),default:"UTC"},
      expected_revision:integer,expected_head_revision:integer,idempotency_key:str(160),
      facts:{type:'array',minItems:1,maxItems:16,items:fact},
      interpretations:{type:'array',maxItems:4,items:schema({text:str(600),source:str(400)},['text','source'])},
      prior_handoffs:{type:'array',maxItems:8,items:reference}},
    ['project_id','session_id','date','title','goal','recorded_by','expected_revision','expected_head_revision','idempotency_key','facts']))
];
const byName=new Map(PROJECT_PASS_TOOLS.map(t=>[t.name,t]));
export const PROJECT_PASS_PROTOCOL='Project PASS/1: resolve the exact registered project and explicit client permissions. Read protocol, current head revision and matching handoffs before continuation. Saved records cover only dated saved work. Facts need observed/user_report/source provenance; include actual questions/responses, assistance, completed actions, unresolved items and explicitly agreed next steps. Keep interpretations separate, never promote them to facts. Check current original sources; the newest save does not automatically win a contradiction. Save only authorized factual checkpoints; no mastery, submission, fabricated progress, secrets or automatic capture. New sessions use expected_revision=0; corrections retain record ID and current revision. Every save also requires the current same-project/test head revision, preventing two chats from silently replacing current state. On conflict reread and reconcile; no automatic merge. Exact retries retain the full packet and idempotency key. Confirm only with matching receipt and fresh record ID/revision/content readback. Test histories are excluded by default. School protocol, records and grants stay separate.';
const bad=(error,status=400)=>({error,status});
const restricted=/\bBearer\s+\S+|\b(access_token|refresh_token|client_secret|api_key|password)\s*[:=]|\bsk-[A-Za-z0-9_-]{12,}|\b(?:sp1|pp1)_[a-f0-9]{64}\b|https?:\/\/[^/\s]+:[^@\s]+@|\b(GPA|score|grade)\s*[:=]\s*\d/i;
function validateContent(args) {
  if(!/^[A-Za-z0-9_.:-]{1,100}$/.test(args.session_id)||!/^\d{4}-\d\d-\d\d$/.test(args.date)||
    !Number.isFinite(Date.parse(args.date))||new Date(args.date).toISOString().slice(0,10)!==args.date||
    !/^[A-Za-z0-9_.:-]{1,160}$/.test(args.idempotency_key))return bad('invalid_project_pass_identity');
  if(Boolean(args.record_id)!==(args.expected_revision>0))return bad('project_update_requires_record_and_revision');
  try {new Intl.DateTimeFormat('en',{timeZone:args.timezone??'UTC'});}catch{return bad('invalid_project_pass_timezone');}
  const all=JSON.stringify(args);
  if(all.length>14000)return bad('project_pass_too_large');
  if(restricted.test(all))return bad('restricted_project_pass_content');
  const strings=[args.title,args.goal,args.recorded_by,...args.facts.flatMap(f=>[f.text,f.source]),...(args.interpretations||[]).flatMap(f=>[f.text,f.source])];
  if(strings.some(s=>!s.trim()||[...s].some(c=>c.codePointAt(0)<32&&!['\n','\t'].includes(c)||c.codePointAt(0)>=0xD800&&c.codePointAt(0)<=0xDFFF)))return bad('invalid_project_pass_text');
  if(args.facts.some(f=>/\b(mastered|understands?|strong grasp|learned)\b/i.test(f.text)))return bad('subjective_project_fact');
  return null;
}
export async function executeProjectPassTool(name,args,env,access) {
  try {
    const tool=byName.get(name);if(!tool)return bad('unknown_project_pass_tool',404);
    validateToolInput(args,tool.inputSchema);
    if(name==='list_pass_projects')return await state(env).projectPass('projects',{},access);
    if(!projectAccess(access,args.project_id,name==='save_project_pass'))return bad('project_access_denied',403);
    const call=(action,packet=args)=>state(env).projectPass(action,packet,access);
    if(name==='register_pass_project') {
      if(access?.owner!==true)return bad('project_access_denied',403);
      if(!args.name.trim()||restricted.test(args.name))return bad('invalid_project_name');
      return await call('register',{...args,name:args.name.trim(),at:new Date().toISOString()});
    }
    if(name==='get_project_pass_protocol') {
      const exists=await call('list',{...args,limit:1});if(exists.error)return exists;
      return {ok:true,project_id:args.project_id,protocol_version:'Project PASS/1',markdown:PROJECT_PASS_PROTOCOL};
    }
    if(name==='list_project_passes')return await call('list');
    if(name==='read_project_pass')return await call('read');
    if(name==='project_pass_history')return await call('history');
    if(name==='resume_project_pass') {
      const found=await call('list',{...args,limit:1});
      if(found.error)return found;if(!found.records.length)return bad('project_pass_not_found',404);
      return await call('read',{...args,record_id:found.records[0].record_id});
    }
    const invalid=validateContent(args);if(invalid)return invalid;
    const packet={...args,sandbox:args.sandbox??false,timezone:args.timezone??'UTC'},operation_id=args.idempotency_key;
    const retry={retry_tool:name,retry_arguments:packet,operation_id};
    let result;
    try {
      result=await call('save',{project_id:args.project_id,sandbox:packet.sandbox,packet,operation_id,
        fingerprint:await digest(stableJSON(packet)),record_id:crypto.randomUUID(),at:new Date().toISOString()});
      if(result.error)return {...result,...retry,save_confirmation:'not_confirmed'};
      const fresh=await call('read',{...packet,record_id:result.recorded.record_id});
      if(fresh.error||stableJSON(fresh.record)!==stableJSON(result.recorded))return {...bad('project_pass_readback_changed',409),...retry,save_confirmation:'not_confirmed'};
      return {...result,save_confirmation:'confirmed',readback:fresh.record,current_head_revision:fresh.head_revision,
        head_advanced:fresh.head_revision!==result.head_revision};
    }catch{return {...bad('project_pass_write_unconfirmed',503),...retry,save_confirmation:'not_confirmed'};}
  } catch(error) {return error?.problem||bad('project_pass_unavailable',503);}
}

// Only the existing owner browser session reaches this administration route. The school MCP key
// cannot authenticate here; no project tools are added to its /mcp tool list.
// Future limited clients must supply separately approved exact project ACLs.
export async function projectPassRoutes(request,env,path,auth) {
  if(!path.startsWith('/pass/projects/tools/'))return null;
  const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
  if(auth!=='session')return json(bad('project_owner_session_required',403),403);
  if(request.method!=='POST')return json(bad('method_not_allowed',405),405);
  if(!(request.headers.get('Content-Type')||'').toLowerCase().startsWith('application/json'))return json(bad('json_required',415),415);
  let args;try{args=await readBody(request,20000);}catch{return json(bad('invalid_project_pass_request'),400);}
  const out=await executeProjectPassTool(path.slice('/pass/projects/tools/'.length),args,env,{owner:true});
  return json(out,out.error?(out.status||400):200);
}
