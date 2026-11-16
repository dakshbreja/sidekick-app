import { state, readBody, readRecords, digest, stableJSON, migrationSnapshot, COURSE_CODES } from './foundation.js';
import { approvedMigrationLinks } from './migration-links.js';
import { TERM_ID, resolveReportIdentity } from './identity.js';
import { resolveCourse, COURSES } from './courses.js';
import { loadEvents, buildStatus, TZ } from './status.js';
import { agendaWindow } from './agenda.js';
const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
const bucket=raw=>!raw || /^(general|all courses|none|n\/a)$/i.test(String(raw).trim())?'GENERAL':resolveCourse(String(raw))?.code;
const string=(body,key,max,required=false)=>{
  if(body[key]==null){if(required)throw new Error('missing_'+key);return undefined;}
  if(typeof body[key]!=='string' || body[key].length>max)throw new Error('invalid_'+key);
  const text=body[key].trim();if(required && !text)throw new Error('missing_'+key);return text;
};

export async function recordRoutes(request,env,path,auth) {
  const url=new URL(request.url);
  if(['/pass','/pass/courses','/pass/protocol'].includes(path)) {
    if(request.method!=='GET')return json({error:'method_not_allowed'},405);
    if(path==='/pass/courses')return json({ok:true,term_id:TERM_ID,timezone:TZ,courses:COURSES.map(({code,label,title})=>({code,label,title}))});
    if(path==='/pass/protocol') {
      const result=await state(env).passRead({protocol:true});return json(result,result.status||200);
    }
    const allowed=new Set(['course','record_id','session_id','limit','cursor','sandbox']);
    if([...url.searchParams.keys()].some(key=>!allowed.has(key)||url.searchParams.getAll(key).length!==1))return json({error:'invalid_pass_query'},400);
    const raw=url.searchParams.get('course'),course=raw?resolveCourse(raw)?.code:null;
    if(raw!==null&&!course)return json({error:'unknown_course',valid:COURSE_CODES.filter(c=>c!=='GENERAL')},400);
    const record_id=url.searchParams.get('record_id'),session_id=url.searchParams.get('session_id');
    const rawSandbox=url.searchParams.get('sandbox');
    if(rawSandbox!==null&&!['true','false'].includes(rawSandbox))return json({error:'invalid_pass_sandbox'},400);
    const sandbox=rawSandbox==='true';
    if((record_id!==null&&(!record_id||record_id.length>2200)) ||
      (session_id!==null&&!/^pass:[A-Za-z0-9_.:-]{1,123}$/.test(session_id)) || (record_id&&session_id))return json({error:'invalid_pass_identity'},400);
    const rawLimit=url.searchParams.get('limit'),limit=rawLimit===null?10:Number(rawLimit);
    if((rawLimit!==null&&!/^\d+$/.test(rawLimit))||!Number.isInteger(limit)||limit<1||limit>20)return json({error:'invalid_pass_limit'},400);
    let cursor=null;
    if(url.searchParams.has('cursor')) {
      try {
        const rawCursor=url.searchParams.get('cursor');if(rawCursor.length>2300)throw Error();
        cursor=JSON.parse(rawCursor);
        if(!Array.isArray(cursor)||cursor.length!==2||typeof cursor[0]!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(cursor[0])||
          !Number.isFinite(Date.parse(cursor[0]))||typeof cursor[1]!=='string'||!cursor[1]||cursor[1].length>2200||record_id)throw Error();
      } catch {return json({error:'invalid_pass_cursor'},400);}
    }
    const result=await state(env).passRead({course,record_id,session_id,limit,cursor,sandbox});return json(result,result.status||200);
  }
  if(path==='/foundation/health' && request.method==='GET')return json(await state(env).health());
  if(path.startsWith('/foundation/migration/')) {
    if(auth!=='bearer' || request.headers.get('X-Bridge-Maintenance')!=='foundation-v1')return json({error:'maintenance_auth_required'},403);
    if(path==='/foundation/migration/start' && request.method==='POST')return json(await state(env).beginMigration());
    if(path==='/foundation/migration/preview' && request.method==='GET') {
      const {snapshot,digest:hash}=await migrationSnapshot(env);
      return json({digest:hash,term_id:TERM_ID,counts:Object.fromEntries(['progress','classnote'].map(kind=>[kind,Object.fromEntries(Object.entries(snapshot[kind]).map(([c,rows])=>[c,rows.length]))])),health:await state(env).health()});
    }
    if(path==='/foundation/migration/initialize' && request.method==='POST') {
      const body=await readBody(request);const current=await migrationSnapshot(env);
      if(body.expected_digest!==current.digest)return json({error:'legacy_state_changed'},409);
      let links=[];
      if(body.approved_links!==undefined) {
        const now=new Date(), feeds=[];
        if(env.FEED_ELC)feeds.push({name:'eLC (D2L)',url:env.FEED_ELC});
        if(env.FEED_PERSONAL)feeds.push({name:'Google Calendar',url:env.FEED_PERSONAL});
        const {events,health}=await loadEvents(feeds,{...agendaWindow(now,10,45),env,now});
        if(!health.length || health.some(h=>!h.ok || h.coverage_complete===false))return json({error:'assignment_sources_unavailable'},503);
        const data=buildStatus({events,now,health});
        try {links=approvedMigrationLinks(current.snapshot,body.approved_links,[...data.overdue,...data.due_today,...data.due_this_week,...data.upcoming]);}
        catch(err){return json({error:err.message},409);}
      }
      const result=await state(env).initialize(current.snapshot,current.digest,links);return json(result,result.status || 200);
    }
    return json({error:'not_found'},404);
  }
  if(path==='/progress/history' && request.method==='GET') {
    const id=url.searchParams.get('record_id');if(!id || id.length>2200)return json({error:'invalid_record_id'},400);
    return json(await state(env).history(id));
  }
  if(!['/progress','/classnote'].includes(path) || request.method!=='POST')return null;
  const kind=path==='/progress'?'progress':'classnote';
  let body;
  try {body=await readBody(request);}catch(err){return json({error:err.message},err.message==='body_too_large'?413:400);}
  const course=bucket(body.course);if(!course)return json({error:'unknown_course',valid:COURSE_CODES},400);
  try {
    if(kind==='progress') {
      body.item=string(body,'item',200,true);
      body.status=String(body.status || 'done').trim().toLowerCase();
      if(!['done','in_progress','blocked','not_started'].includes(body.status))throw new Error('invalid_status');
      for(const [key,max] of [['note',500],['evidence',200],['reported_by',80],['assignment_id',2200],['record_id',2200],['when_iso',40],['term_id',50]]) {
        const value=string(body,key,max);if(value!==undefined)body[key]=value;
      }
      if(body.verification && !['verified','reported','unknown','not_required'].includes(body.verification))throw new Error('invalid_verification');
      if(body.submitted_by && !['self','group','instructor','unknown'].includes(body.submitted_by))throw new Error('invalid_submitted_by');
    } else {
      body.text=string(body,'text',4000,true);body.session_id=string(body,'session_id',128);
      body.title=string(body,'title',200) || '';body.date=string(body,'date',10) || '';
      if(body.date && !/^\d{4}-\d{2}-\d{2}$/.test(body.date))throw new Error('invalid_date');
    }
    if(body.expected_revision!=null && (!Number.isInteger(body.expected_revision) || body.expected_revision<0))throw new Error('invalid_revision');
    if(body.relink!=null && typeof body.relink!=='boolean')throw new Error('invalid_relink');
    if(body.relink && (!body.record_id || body.expected_revision==null))throw new Error('relink_requires_record_and_revision');
  } catch(err) {return json({error:err.message},400);}
  const operation_id=request.headers.get('Idempotency-Key') || body.idempotency_key || crypto.randomUUID();
  if(typeof operation_id!=='string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(operation_id))return json({error:'invalid_idempotency_key'},400);
  const fingerprint=await digest(stableJSON({kind,course,body}));
  try {
    const receipt=await state(env).receipt(operation_id,fingerprint);
    if(receipt)return json(receipt,receipt.status || 200);
    const prior=await readRecords(env,kind,[course]);
    let identity=null;
    if(kind==='progress') {
      const now=new Date();
      const feeds=[];if(env.FEED_ELC)feeds.push({name:'eLC (D2L)',url:env.FEED_ELC});if(env.FEED_PERSONAL)feeds.push({name:'Google Calendar',url:env.FEED_PERSONAL});
      const {events,health}=await loadEvents(feeds,{...agendaWindow(now,10,45),env,now});
      if(!health.length || health.some(h=>!h.ok || h.coverage_complete===false))return json({error:'assignment_sources_unavailable',detail:'The report was NOT saved. Refresh the sources, then retry with the same operation ID.',operation_id},503);
      const data=buildStatus({events,now,health});
      const deadlines=[...data.overdue,...data.due_today,...data.due_this_week,...data.upcoming];
      identity=resolveReportIdentity(body,deadlines,prior,course);
      if(identity.error)return json({...identity,operation_id},identity.status);
    }
    const now=new Date();
    const command={operation_id,fingerprint,kind,course,body,identity,new_record_id:crypto.randomUUID(),at:now.toISOString(),
      at_local:new Intl.DateTimeFormat('en-US',{timeZone:TZ,weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(now),
      via:(request.headers.get('User-Agent') || '').slice(0,80) || null};
    const result=await state(env).mutate(command);
    return json(result,result.status || 200);
  } catch(err) {
    const initializing=err?.message==='records_initializing';
    return json({error:initializing?'records_initializing':'write_not_confirmed',
      detail:initializing?'Progress updates are paused for a safe storage migration. Nothing was saved.':'The save could not be confirmed. Retry with the same operation ID; do not assume it succeeded.',operation_id},503);
  }
}
