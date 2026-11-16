import {state,readBody,digest,stableJSON} from './foundation.js';
import {learningScope,normalizeLearningBody} from './learning-store.js';
const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
const knownError=message=>/^(?:unknown_learning_fields|invalid_|expected_revision_required|restricted_learning_content|demonstration_evidence_conflict|duplicate_|empty_learning_preferences|learning_course_unavailable)/.test(message);

// Worker owns bearer/session authentication and CSRF checks before dispatch.
// This helper still fails closed when called directly without that auth result.
export async function learningRoutes(request,env,path,auth) {
  if(path!=='/learning')return null;
  if(!['bearer','session'].includes(auth))return json({error:'unauthorized'},401);
  let operation_id;
  try {
    if(request.method==='GET') {
      const params=new URL(request.url).searchParams;
      if([...params.keys()].some(key=>!['course','term_id','sandbox'].includes(key))||['course','term_id','sandbox'].some(key=>params.getAll(key).length>1))return json({error:'invalid_learning_query'},400);
      const rawSandbox=params.get('sandbox');
      if(rawSandbox!==null&&!['true','false'].includes(rawSandbox))return json({error:'invalid_learning_sandbox'},400);
      const scope=learningScope(params.get('course'),params.get('term_id'),rawSandbox==='true');
      return json(await state(env).learningGet(scope.course,scope.term_id,scope.sandbox));
    }
    if(request.method!=='POST')return json({error:'method_not_allowed'},405);
    const raw=await readBody(request,24000);
    const header=request.headers.get('Idempotency-Key');
    if(header&&raw.idempotency_key&&header!==raw.idempotency_key)return json({error:'idempotency_key_mismatch'},400);
    if(header&&!raw.idempotency_key)raw.idempotency_key=header;
    const body=normalizeLearningBody(raw);operation_id=body.idempotency_key;
    const fingerprint=await digest(stableJSON(body));
    const result=await state(env).learningPut({body,operation_id,fingerprint,at:new Date().toISOString()});
    return json(result,result.status||200);
  } catch(err) {
    const message=String(err?.message||'');
    if(message==='body_too_large')return json({error:message},413);
    if(message==='invalid_json'||knownError(message))return json({error:message},400);
    // Returning internal SQL/RPC errors can disclose data. Preserve only the
    // operation ID needed for an exact retry after an uncertain response.
    return json(request.method==='GET'?{error:'learning_read_unavailable',detail:'The learning record could not be read. Resume information is unknown.'}:
      {error:'learning_write_not_confirmed',...(operation_id?{operation_id}:{}),detail:'The save was not confirmed. Retry the same packet and operation ID, then read the learning record.'},503);
  }
}
