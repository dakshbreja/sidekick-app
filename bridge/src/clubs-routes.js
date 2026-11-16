import {state,readBody,digest,stableJSON} from './foundation.js';
import {CLUBS,clubStatus} from './clubs-store.js';
const json=(v,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});
const ids=CLUBS.map(c=>c.id);
const fail=msg=>{throw new Error(msg);};
const str=(v,n)=>typeof v==='string'&&v.length<=n?v:fail('invalid_text');
const stamp=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&Date.parse(v)<=Date.now()+60000?v:fail('invalid_timestamp');
const sha=v=>/^[a-f0-9]{64}$/.test(v||'')?v:fail('invalid_digest');
export async function clubsRoutes(request,env,path,auth) {
  if(!path.startsWith('/clubs'))return null;
  const db=state(env),url=new URL(request.url);
  if(request.method==='GET') {
    if(path==='/clubs')return json(clubStatus(await db.clubOverview()));
    if(path==='/clubs/session'){
      const id=url.searchParams.get('id')||'';
      if(!/^[a-f0-9-]{36}$/.test(id))return json({error:'invalid_session_id'},400);
      const record=await db.clubGet('session',id);return record?json(record):json({error:'not_found'},404);
    }
    if(path==='/clubs/search'){
      const q=(url.searchParams.get('q')||'').trim(),club=url.searchParams.get('club')||null;
      const offset=Number(url.searchParams.get('offset')||0);
      if(q.length<2||q.length>200||(club&&!ids.includes(club))||!Number.isInteger(offset)||offset<0)return json({error:'invalid_search'},400);
      return json(await db.clubSearch(q,club,offset));
    }
  }
  if(request.method!=='POST'||!['/clubs/session','/clubs/sync','/clubs/project'].includes(path))return json({error:'not_found'},404);
  if(auth!=='bearer')return json({error:'publisher_auth_required'},403);
  try {
    const b=await readBody(request,1100000);
    if(!Number.isInteger(b.expected_revision)||b.expected_revision<0)fail('expected_revision_required');
    let data,kind='meta',id;
    if(path==='/clubs/session'){
      if(!/^[a-f0-9-]{36}$/.test(b.session_id||''))fail('invalid_session_id');
      if(b.completed!==true)fail('recording_not_complete');
      if(!Array.isArray(b.clubs)||!b.clubs.length||b.clubs.some(c=>!ids.includes(c)))fail('invalid_clubs');
      const transcript=str(b.transcript,1000000);
      if(transcript.length<500||!(transcript.match(/\[\d+:\d{2}(?::\d{2})?\]/g)||[]).length)fail('timestamped_transcript_required');
      data={session_id:b.session_id,title:str(b.title,240),created_at:stamp(b.created_at),clubs:[...new Set(b.clubs)].sort(),
        transcript,transcript_sha256:await digest(transcript),completed:true,source:'Cluely'};
      kind='session';id=b.session_id;
    } else if(path==='/clubs/sync') {
      const newest_raw={};
      for(const c of ids)if(b.newest_raw?.[c])newest_raw[c]={session_id:str(b.newest_raw[c].session_id,36),created_at:stamp(b.newest_raw[c].created_at)};
      if(!Array.isArray(b.events)||b.events.length>100)fail('invalid_events');
      const events=b.events.map(e=>{
        if(!CLUBS.some(c=>c.groupme_id===e.source_group))fail('invalid_group');
        return {title:str(e.title,240),date:str(e.date,10),source_group:e.source_group,source_message:str(e.source_message,80),calendar_event_id:str(e.calendar_event_id,120)};
      });
      if(!Array.isArray(b.pending_session_ids)||b.pending_session_ids.length>500)fail('invalid_pending');
      data={checked_at:stamp(b.checked_at),raw_coverage_complete:b.raw_coverage_complete===true,
        groupme_coverage_complete:b.groupme_coverage_complete===true,groupme_checked_at:b.groupme_checked_at?stamp(b.groupme_checked_at):null,
        bridge_verified_at:b.bridge_verified_at?stamp(b.bridge_verified_at):null,
        pending_session_ids:b.pending_session_ids.map(v=>str(v,36)),newest_raw,events,
        bundle_sha256:sha(b.bundle_sha256),bundle_generated_at:stamp(b.bundle_generated_at)};id='sync';
    } else {
      if(!['verified','failed','pending'].includes(b.retrieval))fail('invalid_retrieval');
      if(b.retrieval==='verified'&&!/^https:\/\/chatgpt\.com\/.+/.test(b.evidence_url||''))fail('retrieval_evidence_required');
      data={bundle_sha256:sha(b.bundle_sha256),retrieval:b.retrieval,checked_at:stamp(b.checked_at),evidence_url:str(b.evidence_url||'',500)};id='project';
    }
    const out=await db.clubPut(kind,id,data,await digest(stableJSON(data)),b.expected_revision,new Date().toISOString());
    return json(out,out.status||200);
  }catch(e){return json({error:e.message==='body_too_large'?'body_too_large':['invalid_json','expected_revision_required','invalid_session_id','recording_not_complete','invalid_clubs','timestamped_transcript_required','invalid_text','invalid_timestamp','invalid_digest','invalid_events','invalid_group','invalid_pending','invalid_retrieval','retrieval_evidence_required'].includes(e.message)?e.message:'club_write_not_confirmed'},e.message==='body_too_large'?413:e.message.startsWith('invalid')||e.message.endsWith('required')||e.message==='recording_not_complete'?400:503);}
}
