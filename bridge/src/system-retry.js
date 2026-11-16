import {state,readBody} from './foundation.js';
import {LOCAL_SERVICES,collectCloudHealth,systemHealth,PROBE_KEY} from './system-health.js';
export function retryAction(id) {
  if(LOCAL_SERVICES[id])return {mode:'local',target:id,label:'Try again',description:'Run the existing Mac job now. The Mac must be awake; existing login and source requirements still apply.'};
  if(id==='local')return {mode:'local',target:'bridge-health',label:'Try again',description:'Ask this Mac to rerun its bridge checks and publish current routine results.'};
  if(id==='clubs')return {mode:'local',target:'cluely-gpt-sync',label:'Retry sync',description:'Run the existing recording and club publication pipeline. GroupMe review and ChatGPT project retrieval remain separate checks.'};
  if(['monitor','elc-feed','google-feed','drive-api'].includes(id))return {mode:'cloud',target:'cloud-checks',label:'Try again',description:'Run fresh calendar and Drive connection checks now.'};
  if(['bridge','records','kv','write'].includes(id))return {mode:'cloud',target:id,label:'Try again',description:id==='write'?'Write a diagnostic receipt; coursework records are untouched.':'Recheck this service now.'};
  return {mode:'manual',label:'Check options',description:'This service has no automatic retry endpoint. Open its connection details for the next step.'};
}
const json=(v,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});
async function execute(job,env,put) {
  try {
    let observations;
    if(job.target==='cloud-checks') {
      const c=await collectCloudHealth(env,put,new Date(),fetch,{forceDrive:true});
      observations={...c.checks,monitor:{outcome:'healthy',last_attempt_at:c.checked_at,last_success_at:c.checked_at,detail:'On-demand cloud checks saved a monitoring snapshot.'}};
    } else if(job.target==='write') {
      const at=new Date().toISOString(),r={outcome:'healthy',last_attempt_at:at,last_success_at:at,detail:'The on-demand diagnostic write was acknowledged.'};
      await put(env,PROBE_KEY,JSON.stringify(r),'system-retry-write');observations={write:r};
    } else {
      const n=(await systemHealth(env)).nodes.find(n=>n.id===job.node);observations={[n.id]:{outcome:n.outcome,last_attempt_at:n.last_attempt_at,last_success_at:n.last_success_at,detail:n.detail}};
    }
    const ok=Object.values(observations).every(o=>o.outcome==='healthy');
    await state(env).retryFinish(job.id,{state:ok?'succeeded':'attention',message:ok?'Fresh check passed.':'The retry completed, but this service still needs attention.',observations});
  }catch {await state(env).retryFinish(job.id,{state:'failed',message:'The check could not finish. Previous evidence is preserved. Try again after the service recovers.'});}
}
export async function retryRoutes(request,env,path,auth,ctx,put) {
  if(!path.startsWith('/system/retry'))return null;
  try {
    const db=state(env);
    if(path==='/system/retry'&&request.method==='GET')return json({jobs:await db.retryList()});
    if(request.method!=='POST')return json({error:'not_found'},404);
    const b=await readBody(request,2000);
    if(path==='/system/retry/claim'||path==='/system/retry/finish') {
      if(auth!=='bearer')return json({error:'publisher_auth_required'},403);
      if(path.endsWith('/claim'))return json({job:await db.retryClaim()});
      if(!/^[a-f0-9-]{36}$/.test(b.id||'')||!['succeeded','attention','failed','blocked'].includes(b.state))return json({error:'invalid_result'},400);
      const jobs=await db.retryList(),job=jobs.find(j=>j.id===b.id);
      if(!job||job.mode!=='local')return json({error:'retry_not_found'},404);
      const messages={succeeded:'The Mac job finished and published a fresh passing result.',attention:'The Mac job finished, but some stages still need attention. Open service details.',failed:'The Mac job failed. Its local log has details; previous evidence is preserved.',blocked:'The job could not produce a fresh result. Check Mac availability, login, or a run already in progress.'};
      return json({job:await db.retryFinish(b.id,{state:b.state,message:messages[b.state]})});
    }
    if(path!=='/system/retry')return json({error:'not_found'},404);
    if(typeof b.node!=='string'||!/^[a-zA-Z0-9-]{1,50}$/.test(b.node)||!/^[a-f0-9-]{36}$/.test(b.request_id||''))return json({error:'invalid_retry'},400);
    const action=retryAction(b.node);
    if(action.mode==='manual')return json({error:'manual_check_required',action},409);
    const result=await db.retryRequest(b.request_id,b.node,action.target,action.mode);
    if(result.created&&action.mode==='cloud')ctx.waitUntil(execute(result.job,env,put));
    return json({...result,action},202);
  }catch(e){return json({error:['invalid_json','body_too_large'].includes(e.message)?e.message:'retry_unavailable'},['invalid_json','body_too_large'].includes(e.message)?400:503);}
}
