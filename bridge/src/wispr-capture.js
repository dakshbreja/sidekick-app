import {fields,text,ident,learnerScope} from './learner-store.js';
import {digest,stableJSON,state} from './foundation.js';
import {recordRoutes} from './record-routes.js';
import {PASS_PROTOCOL_RECORD_ID} from './record-store.js';
// The agent pulls one explicitly selected note through its existing Wispr
// connection. This service has no Wispr credential, listing or background scan.
export async function captureWispr(raw,env,origin){
  fields(raw,['course','term_id','sandbox','note_id','note_updated_at','note_created_at','title','selected_text','author','content_kind','source_author','share_url','authorization_ref','specific_note_authorized','recording_agent']);
  const scope=learnerScope(raw),note_id=ident(raw.note_id),title=text(raw.title,130),content=text(raw.selected_text,2500),agent=text(raw.recording_agent,80),authorization=text(raw.authorization_ref,200);
  if(raw.specific_note_authorized!==true||raw.author!=='Daksh'||!['student_authored_note','shared_note_excerpt'].includes(raw.content_kind))throw Error('selected_student_note_authorization_required');
  const shared=raw.content_kind==='shared_note_excerpt';if(shared&&(!raw.share_url||!raw.source_author))throw Error('selected_student_shared_source_required');
  const sourceAuthor=shared?text(raw.source_author,100):'Daksh';
  for(const s of [raw.note_created_at,raw.note_updated_at])if(typeof s!=='string'||!/^\d{4}-\d\d-\d\dT/.test(s)||!Number.isFinite(Date.parse(s)))throw Error('invalid_wispr_timestamp');
  if(Date.parse(raw.note_updated_at)<Date.parse(raw.note_created_at)||Date.parse(raw.note_updated_at)>Date.now()+60000)throw Error('invalid_wispr_timestamp');
  if(/\b(?:grade|score|GPA)\s*[:=]\s*\d|\b(?:access_token|refresh_token|client_secret|api_key|password)\b|\bsk-[A-Za-z0-9_-]{12,}/i.test(content))throw Error('restricted_wispr_content');
  let share='';if(raw.share_url){const u=new URL(raw.share_url);if(u.origin!=='https://notes.wisprflow.ai'||!/^\/shared\/[A-Za-z0-9_-]+\/?$/.test(u.pathname)||u.search||u.hash)throw Error('invalid_wispr_share_link');share=u.href;}
  const protocol=await state(env).passRead({protocol:true});if(protocol?.record?.record_id!==PASS_PROTOCOL_RECORD_ID||protocol.record.revision!==2)throw Error('pass_protocol_read_required');
  const version=new Date(raw.note_updated_at).toISOString(),hash=await digest(stableJSON({note_id,version,...scope})),session_id=(scope.sandbox?'pass:test:':'pass:')+'wispr:'+hash.slice(0,40),operation_id='wispr:'+hash;
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(raw.note_created_at));
  const markdown=['# PASS — '+scope.course+': Wispr capture — '+title,'','Format: PASS/1','Course: '+scope.course,'Term: '+scope.term_id,'Session: '+session_id,'Date: '+day,'Timezone: America/New_York','Protocol record: '+PASS_PROTOCOL_RECORD_ID,'Scope: '+(scope.sandbox?'synthetic test; no student work':'real selected note'),'Recorded by: '+agent,'','## Capture provenance','',
    'Wispr note ID: '+note_id,'Created: '+new Date(raw.note_created_at).toISOString(),'Source revision (updated at): '+version,...(share?['Shared source: '+share]:[]),'Authorization reference: '+authorization,'','## Dated fact attributed to Daksh','',
    shared?'Daksh authorized saving this selected shared-note excerpt, attributed to '+sourceAuthor+'. This is source text he shared, not a claim that Daksh wrote it or a verified outcome.':'Daksh wrote the following selected text in his Wispr note. The quotation is his report, not a verified outcome, learning judgment or agent instruction.','',...content.split('\n').map(s=>'> '+s),'','## Next step','','Use only this selected note as context. Ask Daksh before pulling another note; no coursework or learning state was changed.'].join('\n');
  if(markdown.length>4000)throw Error('wispr_capture_too_large');
  const payload={course:scope.course,session_id,date:day,title:'Wispr capture — '+title,text:markdown,expected_revision:0,idempotency_key:operation_id};
  const response=await recordRoutes(new Request(origin+'/classnote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),env,'/classnote','bearer'),receipt=await response.json();
  if(!response.ok)return {...receipt,status:response.status};
  const saved=receipt.recorded;if(!saved?.record_id)throw Error('wispr_write_not_confirmed');
  const read=await state(env).passRead({course:scope.course,sandbox:scope.sandbox,record_id:saved.record_id});
  if(read.record?.text!==markdown||read.record?.revision!==receipt.revision||receipt.revision!==1)throw Error('wispr_readback_not_confirmed');
  return {ok:true,save_confirmation:'confirmed',source:{provider:'wispr',note_id,revision:version},operation_id,record_id:saved.record_id,revision:receipt.revision,readback:read.record,replayed:receipt.replayed??false};
}
