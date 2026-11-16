import { state, readBody, digest, stableJSON } from './foundation.js';
import { validateAnnouncementSnapshot } from './announcement-store.js';
import { buildAnnouncementDateCorrections } from './announcement-dates.js';
import { reviewedDateCorrections } from './reviewed-date-corrections.js';
import { eventIdentity } from './identity.js';

export const ANNOUNCEMENT_TTL_SECONDS = 3 * 3600;
const identity = record => eventIdentity({uid:record.uid,source:record.source,
  course:{code:record.course_code},recurrence_anchor:record.recurrence_anchor||''});
const newsId = record => record.authority?.announcement_id || /\/news\/\d+\/(\d+)\/view/.exec(record.authority?.url||'')?.[1];
const key = row => `${row.course_code}:${row.announcement_id}`;
const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});

export async function announcementRoutes(request,env,path,auth) {
  if(!['/announcements','/announcements/report'].includes(path))return null;
  if(path==='/announcements'&&request.method==='GET') {
    try{return json(await state(env).announcementGet());}catch{return json({error:'announcements_unavailable'},503);}
  }
  if(path!=='/announcements/report'||request.method!=='POST')return json({error:'method_not_allowed'},405);
  if(auth!=='bearer')return json({error:'collector_auth_required'},403);
  let body;
  try{body=await readBody(request,800000);}catch(err){return json({error:err.message},err.message==='body_too_large'?413:400);}
  if(Object.keys(body).some(k=>!['snapshot','expected_revision','idempotency_key'].includes(k))||
    !Number.isInteger(body.expected_revision)||body.expected_revision<0)return json({error:'invalid_announcement_command'},400);
  const operation_id=request.headers.get('Idempotency-Key')||body.idempotency_key;
  if(typeof operation_id!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(operation_id))return json({error:'invalid_idempotency_key'},400);
  try {
    const store=state(env),fingerprint=await digest(stableJSON({snapshot:body.snapshot,expected_revision:body.expected_revision}));
    const receipt=await store.announcementReceipt(operation_id,fingerprint);
    if(receipt)return json(receipt,receipt.status||200);
    const previous=await store.announcementGet();
    if(previous.revision!==body.expected_revision)return json({error:'revision_conflict',current_revision:previous.revision},409);
    const now=new Date(),snapshot=validateAnnouncementSnapshot(body.snapshot,previous.snapshot,now);
    const result=await store.announcementPut({snapshot,expected_revision:body.expected_revision,operation_id,fingerprint,
      snapshot_digest:await digest(stableJSON(snapshot)),at:now.toISOString()});
    return json(result,result.status||200);
  } catch(err) {
    const known=/^(invalid_|restricted_|future_|older_|unverified_|duplicate_|announcement_snapshot_too_large|announcement_merge_required)/.test(err.message||'');
    return json({error:known?err.message:'announcement_save_not_confirmed',operation_id},known?400:503);
  }
}

export async function readAnnouncementRecord(env) {
  if(!env?.BRIDGE_STATE)return null;
  try {
    const store=state(env);
    // The fallback supports older offline fixture stubs; deployed storage must
    // implement the real methods and a failed RPC is an explicit source gap.
    if(typeof store.announcementGet!=='function')return null;
    const [record,evidence]=await Promise.all([store.announcementGet(),store.announcementEvidence()]);
    return {...record,evidence:Array.isArray(evidence)?evidence:evidence?.announcements||[]};
  } catch {return {ok:false,snapshot:null,error:'announcements_unavailable'};}
}

export function announcementContext(record,events,now=new Date(),defaults=reviewedDateCorrections,{windowStart,windowEnd}={}) {
  if(record===null)return {corrections:defaults,summary:null};
  const snapshot=record.snapshot;
  if(!snapshot)return {corrections:defaults,summary:{status:'unknown',revision:record.revision||0,
    last_attempt_at:null,last_success_at:null,last_complete_success_at:null,courses:[],reviews:[],
    warnings:['Instructor announcement checks have no readable source receipt. Calendar feeds alone cannot confirm news-only date changes.'],change_safe:false}};
  const courses=snapshot.coverage.map(row=>({...row,
    state:row.status!=='ok'?'failed':!row.last_success_at||+now-Date.parse(row.last_success_at)>ANNOUNCEMENT_TTL_SECONDS*1000?'stale':row.complete?'healthy':'partial'}));
  const warnings=[];
  for(const row of courses) {
    if(row.state==='failed')warnings.push(`${row.course_code}: instructor announcements could not be checked; earlier evidence is retained.`);
    else if(row.state==='stale')warnings.push(`${row.course_code}: instructor announcement checks are overdue; news-only date changes may be missing.`);
    else if(row.state==='partial')warnings.push(`${row.course_code}: recent announcement feed checked; older announcement edits and removals are not confirmed by this limited feed.`);
  }
  const items=snapshot.announcements.map(item=>({...item,verified:true}));
  // Replay changed observations into exact prior identities before examining the
  // current version. This resolves a second edit's explicit from-date without
  // turning historical wording into the latest source authority.
  let prior=defaults.slice();
  const current=new Map(items.map(item=>[key(item),item]));
  const evidence=(record.evidence||[]).filter(item=>current.has(key(item)))
    .toSorted((a,b)=>Date.parse(a.observed_at)-Date.parse(b.observed_at));
  for(const item of evidence) {
    const derived=buildAnnouncementDateCorrections({announcements:[{...item,verified:true}],events,previousCorrections:prior,now});
    const next=new Map(prior.map(row=>[identity(row),row]));
    for(const row of derived.corrections)next.set(identity(row),row);
    prior=[...next.values()];
  }
  const derived=buildAnnouncementDateCorrections({announcements:items,events,previousCorrections:prior,now});
  const reviews=derived.reviews.slice();
  const corrections=new Map();
  for(const seed of defaults) {
    const id=newsId(seed),item=current.get(`${seed.course_code}:${id}`),coverage=courses.find(row=>row.course_code===seed.course_code);
    const replacement=derived.corrections.some(row=>identity(row)===identity(seed));
    const blocked=reviews.some(row=>row.candidate_assignment_ids?.includes(identity(seed)));
    if(item||coverage?.complete) {
      if(!replacement&&!blocked)reviews.push({state:'review',reason:item?'announcement_authority_changed':'announcement_authority_missing',
        course_code:seed.course_code,announcement_id:id,title:'Previously reviewed instructor date needs recheck',
        authority:{...seed.authority,announcement_id:id},candidate_assignment_ids:[identity(seed)],proposed_dates:[]});
      continue;
    }
    if(!replacement&&!blocked)corrections.set(identity(seed),seed);
  }
  for(const row of derived.corrections) {
    // Only the presently observed hash can authorize the current projection.
    const item=current.get(`${row.course_code}:${newsId(row)}`);
    if(item?.content_sha256===row.authority.content_sha256)corrections.set(identity(row),row);
  }
  const start=windowStart?+windowStart:+now-10*86400000,end=windowEnd?+windowEnd:Infinity;
  const inWindow=stamp=>Number.isFinite(stamp)&&stamp>=start-86400000&&stamp<end;
  const relevantReviews=reviews.filter(row=>row.candidate_assignment_ids?.some(id=>events.some(event=>
    eventIdentity({...event,course:{code:row.course_code}})===id&&inWindow(+event.start)))||
    row.proposed_dates?.some(d=>inWindow(Date.parse(d+'T12:00:00Z')))||
    (!row.candidate_assignment_ids?.length&&!row.proposed_dates?.length&&(()=>{
      const item=current.get(`${row.course_code}:${row.announcement_id}`);
      return item&&Date.parse(item.modified_at||item.published_at||item.feed_published_at||item.observed_at)>=+now-14*86400000;
    })()));
  for(const row of relevantReviews)warnings.push(`${row.course_code}: an instructor announcement needs date review (${row.reason.replaceAll('_',' ')}). Check the linked original course source.`);
  return {corrections:[...corrections.values()],summary:{status:courses.every(row=>row.state==='healthy')&&!relevantReviews.length?'healthy':'degraded',
    revision:record.revision,last_attempt_at:snapshot.attempted_at,last_success_at:snapshot.last_success_at,
    last_complete_success_at:snapshot.last_complete_success_at,courses,reviews:relevantReviews,
    // A successful bounded feed may authorize an observed change. Missing feed
    // IDs are retained by the store, so they cannot manufacture deletion/reversal
    // diffs. Older-post coverage stays explicit in the warnings.
    warnings,change_safe:courses.every(row=>['healthy','partial'].includes(row.state))&&!relevantReviews.length}};
}

export function scopedAnnouncementSummary(summary,course=null) {
  if(!summary||!course)return summary;
  const courses=summary.courses.filter(row=>row.course_code===course),reviews=summary.reviews.filter(row=>row.course_code===course);
  const warnings=summary.warnings.filter(text=>text.startsWith(course+':')||!summary.courses.length);
  return {...summary,courses,reviews,warnings,status:courses.length&&courses.every(row=>row.state==='healthy')&&!reviews.length?'healthy':'degraded'};
}
