// Course news is a dated source observation, never a submission record. Keep it
// in the existing transactional store so a failed listing cannot erase evidence
// or race a later instructor edit through eventually consistent KV.
import { TERM_ID } from './identity.js';
import { stableJSON } from './foundation.js';

export const ANNOUNCEMENT_COURSES = Object.freeze({
  BUSN5000:'4048786', MGMT4280:'4001788', MGMT5560:'3963225',
  MGMT5850:'3948871', LAND2510:'3962245', BUSN3040:'3955142',
});
const codes=Object.keys(ANNOUNCEMENT_COURSES).sort();
const errors=new Set(['session','browser','course_identity','course_missing','http','timeout','response',
  'oversized','duplicate_identity','privacy','publication','version','source_unavailable']);
const fail=code=>{throw new Error(code);};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
function keys(value,allowed) {
  if(!object(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail('invalid_announcement_snapshot');
}
function timestamp(value,now,optional=false) {
  if(optional&&value==null)return null;
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value))fail('invalid_announcement_timestamp');
  const at=Date.parse(value);
  if(!Number.isFinite(at))fail('invalid_announcement_timestamp');
  if(at>now+60000)fail('future_announcement_observation');
  return new Date(at).toISOString();
}
function text(value,max,{empty=true,multiline=false}={}) {
  if(typeof value!=='string'||value.length>max||(!empty&&!value.trim())||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)||
    !multiline&&/[\r\n]/.test(value)||/<\/?[a-z][^>]*>/i.test(value))fail('invalid_announcement_text');
  // Only scheduling excerpts enter the bridge. Treat numerical grade/score
  // statements and credentials as a publisher error, not as health telemetry.
  if(/\b(?:grade|score)\s*(?:(?:is|was|of)\s*)?[:=]?\s*\d+(?:\.\d+)?\b/i.test(value)||
    /\b(?:grade|score|earned|received|points)\b[^.!?\n]{0,60}(?:\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*\/\s*\d+|\b\d+(?:\.\d+)?\s*(?:points|pts)\b)/i.test(value)||
    /(?:\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*\/\s*\d+)[^.!?\n]{0,40}\b(?:grade|score)\b/i.test(value)||
    /\b(?:access_token|refresh_token|client_secret|authorization:\s*bearer)\b/i.test(value))fail('restricted_announcement_content');
  return value;
}
function coverageRow(row,now,attempted,previous) {
  keys(row,['course_code','org_unit_id','status','checked_at','last_success_at','last_complete_success_at','scope','complete','error']);
  if(!codes.includes(row.course_code)||row.org_unit_id!==ANNOUNCEMENT_COURSES[row.course_code])fail('invalid_announcement_course');
  const scope=row.scope||'full_listing',successful=row.status==='ok';
  if(!['ok','blocked','failed','incomplete'].includes(row.status)||!['full_listing','recent_feed'].includes(scope)||typeof row.complete!=='boolean'||
    row.complete&&(!successful||scope!=='full_listing')||successful&&scope==='full_listing'&&!row.complete)fail('invalid_announcement_coverage');
  const checked_at=timestamp(row.checked_at,now),success=timestamp(row.last_success_at,now,true),completeSuccess=timestamp(row.last_complete_success_at,now,true);
  if(Date.parse(checked_at)>attempted+10*60000||success&&Date.parse(success)>Date.parse(checked_at)+60000)fail('invalid_announcement_timestamp');
  if(previous&&Date.parse(checked_at)<Date.parse(previous.checked_at))fail('older_announcement_observation');
  const error=row.error==null?null:row.error;
  if(error!==null&&(typeof error!=='string'||!errors.has(error)))fail('invalid_announcement_error');
  if(successful&&(!success||error!==null))fail('invalid_announcement_coverage');
  if(!successful&&success&&success!==previous?.last_success_at)fail('unverified_announcement_success');
  const oldComplete=previous?.last_complete_success_at||null;
  if(!row.complete&&completeSuccess&&completeSuccess!==oldComplete)fail('unverified_announcement_success');
  if(completeSuccess&&Date.parse(completeSuccess)>Date.parse(checked_at)+60000)fail('invalid_announcement_timestamp');
  return {course_code:row.course_code,org_unit_id:row.org_unit_id,status:row.status,scope,checked_at,
    last_success_at:successful?success:previous?.last_success_at||null,
    last_complete_success_at:row.complete?(completeSuccess||success):oldComplete,complete:row.complete,error};
}
function announcementRow(row,now,coverage) {
  keys(row,['announcement_id','course_code','term_id','org_unit_id','title','text','source_url',
    'published_at','modified_at','feed_published_at','observed_at','content_sha256','privacy_redacted']);
  if(row.term_id!==TERM_ID||!codes.includes(row.course_code)||row.org_unit_id!==ANNOUNCEMENT_COURSES[row.course_code]||
    typeof row.announcement_id!=='string'||!/^\d{1,20}$/.test(row.announcement_id))fail('invalid_announcement_identity');
  const url=`https://uga.view.usg.edu/d2l/le/news/${row.org_unit_id}/${row.announcement_id}/view?ou=${row.org_unit_id}`;
  if(row.source_url!==url)fail('invalid_announcement_url');
  if(typeof row.content_sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.content_sha256)||typeof row.privacy_redacted!=='boolean')fail('invalid_announcement_digest');
  const observed_at=timestamp(row.observed_at,now),published_at=timestamp(row.published_at,now,true),modified_at=timestamp(row.modified_at,now,true),feed_published_at=timestamp(row.feed_published_at,now,true);
  if(Date.parse(observed_at)>Date.parse(coverage.checked_at)+60000||[published_at,modified_at,feed_published_at].some(at=>at&&Date.parse(at)>Date.parse(observed_at)+60000))fail('invalid_announcement_timestamp');
  return {announcement_id:row.announcement_id,course_code:row.course_code,term_id:TERM_ID,org_unit_id:row.org_unit_id,
    title:text(row.title,240,{empty:false}),text:text(row.text,4000,{multiline:true}),source_url:url,
    published_at,modified_at,feed_published_at,observed_at,content_sha256:row.content_sha256,privacy_redacted:row.privacy_redacted};
}

/** Validate and merge without inventing a successful read for a blocked source. */
export function validateAnnouncementSnapshot(raw,previous=null,now=new Date()) {
  keys(raw,['schema_version','source','term_id','attempted_at','last_success_at','last_complete_success_at','expected_courses','coverage','announcements']);
  if(raw.schema_version!==1||raw.source!=='eLC (D2L)'||raw.term_id!==TERM_ID)fail('invalid_announcement_snapshot');
  const nowMs=+now;
  if(!Number.isFinite(nowMs))fail('invalid_announcement_timestamp');
  const attempted_at=timestamp(raw.attempted_at,nowMs),attempted=Date.parse(attempted_at);
  if(previous&&attempted<Date.parse(previous.attempted_at))fail('older_announcement_observation');
  if(!Array.isArray(raw.expected_courses)||stableJSON([...raw.expected_courses].sort())!==stableJSON(codes))fail('invalid_announcement_courses');
  if(!Array.isArray(raw.coverage)||raw.coverage.length!==codes.length)fail('invalid_announcement_coverage');
  const priorCoverage=new Map((previous?.coverage||[]).map(r=>[r.course_code,r]));
  const coverage=raw.coverage.map(row=>coverageRow(row,nowMs,attempted,priorCoverage.get(row?.course_code)))
    .sort((a,b)=>a.course_code.localeCompare(b.course_code));
  if(new Set(coverage.map(row=>row.course_code)).size!==codes.length)fail('invalid_announcement_coverage');
  const byCourse=new Map(coverage.map(row=>[row.course_code,row]));
  if(!Array.isArray(raw.announcements)||raw.announcements.length>720)fail('announcement_snapshot_too_large');
  const rows=raw.announcements.map(row=>announcementRow(row,nowMs,byCourse.get(row?.course_code)));
  const priorNews=new Map((previous?.announcements||[]).map(row=>[row.course_code+':'+row.announcement_id,row]));
  const seen=new Set();
  for(const row of rows) {
    const key=row.course_code+':'+row.announcement_id;
    if(seen.has(key))fail('duplicate_announcement_identity');seen.add(key);
    const prior=priorNews.get(key);
    // Creation and modification are different provider facts. A full API read
    // with an unknown LastModifiedDate must not compare its older creation date
    // against a previous known edit date and falsely reject a real new edit.
    if(prior&&(Date.parse(row.observed_at)<Date.parse(prior.observed_at)||
      ['published_at','modified_at'].some(field=>prior[field]&&row[field]&&Date.parse(row[field])<Date.parse(prior[field]))))fail('older_announcement_observation');
    // RSS has a feed publication timestamp, not the course source's original
    // creation/edit times. An identical content hash can retain actual API/UI
    // metadata; a changed hash must keep unavailable source timestamps unknown.
    if(prior?.content_sha256===row.content_sha256&&byCourse.get(row.course_code).scope==='recent_feed') {
      row.published_at??=prior.published_at;
      row.modified_at??=prior.modified_at;
    }
  }
  const announcements=[];
  for(const row of coverage) {
    const current=rows.filter(a=>a.course_code===row.course_code),prior=(previous?.announcements||[]).filter(a=>a.course_code===row.course_code);
    if(current.length>120)fail('announcement_snapshot_too_large');
    if(row.status!=='ok'&&current.length&&stableJSON(current.slice().sort(order))!==stableJSON(prior.slice().sort(order)))fail('unverified_announcement_replacement');
    // A limited feed can prove an edit to a visible ID, but cannot prove that an
    // absent ID was deleted. Preserve each absent observation's real timestamp.
    const merged=row.status==='ok'&&!row.complete?new Map(prior.map(a=>[a.announcement_id,a])):null;
    if(merged)for(const a of current)merged.set(a.announcement_id,a);
    const effective=row.complete?current:merged?[...merged.values()]:prior;
    if(effective.length>120)fail('announcement_snapshot_too_large');
    announcements.push(...effective);
  }
  announcements.sort(order);
  const declared=timestamp(raw.last_success_at,nowMs,true),declaredComplete=timestamp(raw.last_complete_success_at,nowMs,true),
    complete=coverage.every(r=>r.complete),successful=coverage.every(r=>r.status==='ok');
  if(successful&&!declared||[declared,declaredComplete].some(d=>d&&Date.parse(d)>attempted+10*60000))fail('invalid_announcement_timestamp');
  if(!successful&&declared&&declared!==previous?.last_success_at||!complete&&declaredComplete&&declaredComplete!==previous?.last_complete_success_at)fail('unverified_announcement_success');
  const snapshot={schema_version:1,source:'eLC (D2L)',term_id:TERM_ID,attempted_at,
    last_success_at:successful?declared:previous?.last_success_at||null,
    last_complete_success_at:complete?(declaredComplete||declared):previous?.last_complete_success_at||null,
    expected_courses:codes.slice(),coverage,announcements};
  if(new TextEncoder().encode(stableJSON(snapshot)).byteLength>750000)fail('announcement_snapshot_too_large');
  return snapshot;
}
const order=(a,b)=>a.course_code.localeCompare(b.course_code)||a.announcement_id.localeCompare(b.announcement_id);

export class AnnouncementStore {
  constructor(storage) {
    this.storage=storage;this.sql=storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS announcement_snapshot (id INTEGER PRIMARY KEY CHECK(id=1),
      revision INTEGER NOT NULL,digest TEXT NOT NULL,data TEXT NOT NULL,received_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS announcement_receipts (operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS announcement_history (revision INTEGER PRIMARY KEY,digest TEXT NOT NULL,data TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS announcement_versions (course_code TEXT NOT NULL,announcement_id TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,data TEXT NOT NULL,observed_at TEXT NOT NULL,revision INTEGER NOT NULL,
        PRIMARY KEY(course_code,announcement_id,content_sha256));`);
  }
  get() {
    const row=this.sql.exec('SELECT * FROM announcement_snapshot WHERE id=1').toArray()[0];
    return {ok:true,revision:row?.revision||0,snapshot_digest:row?.digest||null,
      snapshot:row?JSON.parse(row.data):null,received_at:row?.received_at||null};
  }
  receipt(operation_id,fingerprint) {
    const row=this.sql.exec('SELECT fingerprint,result FROM announcement_receipts WHERE operation_id=?',operation_id).toArray()[0];
    return !row?null:row.fingerprint===fingerprint?{...JSON.parse(row.result),replayed:true}:{error:'idempotency_conflict',status:409};
  }
  evidence() {
    // Only historical versions of a currently present ID can explain a later
    // explicit from/to move. Deleted news cannot acquire authority from history.
    return this.sql.exec(`SELECT v.data FROM announcement_versions v
      JOIN announcement_snapshot s ON s.id=1
      JOIN json_each(s.data,'$.announcements') a
        ON v.course_code=json_extract(a.value,'$.course_code')
        AND v.announcement_id=json_extract(a.value,'$.announcement_id')
      WHERE v.content_sha256<>json_extract(a.value,'$.content_sha256')
      ORDER BY v.observed_at DESC,v.revision DESC,v.course_code,v.announcement_id LIMIT 200`)
      .toArray().map(row=>JSON.parse(row.data));
  }
  put(command) {
    return this.storage.transactionSync(()=>{
      const {operation_id,fingerprint,expected_revision,snapshot_digest,at}=command;
      if(typeof operation_id!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(operation_id)||
        !/^[a-f0-9]{64}$/.test(fingerprint||'')||!/^[a-f0-9]{64}$/.test(snapshot_digest||'')||
        !Number.isInteger(expected_revision)||expected_revision<0)fail('invalid_announcement_command');
      const receipt=this.receipt(operation_id,fingerprint);
      if(receipt)return receipt;
      const previous=this.get();
      if(previous.revision!==expected_revision)return {error:'revision_conflict',status:409,current_revision:previous.revision};
      const snapshot=validateAnnouncementSnapshot(command.snapshot,previous.snapshot,new Date(at));
      if(stableJSON(snapshot)!==stableJSON(command.snapshot))fail('announcement_merge_required');
      const unchanged=previous.snapshot_digest===snapshot_digest,revision=previous.revision+(unchanged?0:1);
      const result={ok:true,revision,snapshot_digest,received_at:unchanged?previous.received_at:at,operation_id,unchanged};
      if(!unchanged) {
        const data=JSON.stringify(snapshot);
        this.sql.exec('INSERT INTO announcement_snapshot VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,data=excluded.data,received_at=excluded.received_at',revision,snapshot_digest,data,at);
        this.sql.exec('INSERT INTO announcement_history VALUES (?,?,?,?)',revision,snapshot_digest,data,at);
        const oldNews=new Map((previous.snapshot?.announcements||[]).map(row=>[row.course_code+':'+row.announcement_id,row]));
        for(const row of snapshot.announcements) {
          if(oldNews.get(row.course_code+':'+row.announcement_id)?.content_sha256===row.content_sha256)continue;
          this.sql.exec(`INSERT INTO announcement_versions VALUES (?,?,?,?,?,?)
            ON CONFLICT(course_code,announcement_id,content_sha256) DO UPDATE SET data=excluded.data,observed_at=excluded.observed_at,revision=excluded.revision`,
            row.course_code,row.announcement_id,row.content_sha256,JSON.stringify(row),row.observed_at,revision);
          this.sql.exec(`DELETE FROM announcement_versions WHERE course_code=? AND announcement_id=?
            AND content_sha256 NOT IN (SELECT content_sha256 FROM announcement_versions WHERE course_code=? AND announcement_id=?
              ORDER BY observed_at DESC,revision DESC LIMIT 5)`,row.course_code,row.announcement_id,row.course_code,row.announcement_id);
        }
        // Keep recent audit evidence bounded; receipts remain available to resolve
        // uncertain retries even when an older source snapshot ages out.
        this.sql.exec('DELETE FROM announcement_history WHERE revision <= ?',revision-100);
      }
      this.sql.exec('INSERT INTO announcement_receipts VALUES (?,?,?,?)',operation_id,fingerprint,JSON.stringify(result),at);
      return result;
    });
  }
}
