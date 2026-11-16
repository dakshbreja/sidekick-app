// Synchronous transactional core shared by the Durable Object and SQLite tests.
// Every mutation records its receipt and history in the SAME transaction.
import { TERM_ID, normalizeTitle, sameAssignment } from './identity.js';
import { COURSES } from './courses.js';

export const PASS_PROTOCOL_RECORD_ID='e2e2536a-83b9-460f-991b-3f86fd87542a';

export class RecordStore {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (record_id TEXT PRIMARY KEY, kind TEXT NOT NULL,
        course TEXT NOT NULL, assignment_id TEXT, revision INTEGER NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS progress_identity ON records(course, assignment_id)
        WHERE kind='progress' AND assignment_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS history (seq INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT NOT NULL, operation_id TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
        result TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, epoch TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS school_learner_access (token_hash TEXT PRIMARY KEY, epoch TEXT NOT NULL, approval_id TEXT NOT NULL, scopes TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, resets INTEGER NOT NULL);
    `);
  }
  rows(query, ...args) { return this.sql.exec(query, ...args).toArray(); }
  meta(key) { return this.rows('SELECT value FROM meta WHERE key=?',key)[0]?.value ?? null; }
  health() {
    return {schema_version:1, ready:this.meta('ready') === '1', term_id:this.meta('term_id'),
      migration_not_before:Number(this.meta('migration_not_before') || 0),
      counts:this.rows('SELECT kind, count(*) AS count FROM records GROUP BY kind')};
  }
  beginMigration(now) {
    if (this.meta('ready') === '1') return {ok:true,already_initialized:true};
    if (!this.meta('migration_not_before')) this.sql.exec('INSERT INTO meta(key,value) VALUES (?,?)','migration_not_before',String(now+120000));
    return {ok:true,not_before:Number(this.meta('migration_not_before'))};
  }
  initialize(snapshot, digest, now, links=[]) {
    return this.storage.transactionSync(() => {
      if (this.meta('ready') === '1') return {ok:true,already_initialized:true,digest:this.meta('migration_digest')};
      const after=Number(this.meta('migration_not_before') || 0);
      if (!after || now<after) return {error:'migration_cooldown',status:409,not_before:after};
      if (snapshot.term_id !== TERM_ID) return {error:'wrong_term',status:409};
      const reviewed=new Map(links.map(link=>[link.record_id,link.identity]));
      if(reviewed.size!==links.length)throw new Error('duplicate_approved_link');
      let imported=0,linked=0;
      for (const kind of ['progress','classnote']) for (const [course, entries] of Object.entries(snapshot[kind] || {})) {
        for (let i=0;i<entries.length;i++) {
          const original=entries[i];
          const record_id=`legacy:${TERM_ID}:${kind}:${course}:${i}`;
          const row={...original,record_id,course,term_id:TERM_ID,revision:1};
          if (kind==='progress') Object.assign(row,{assignment_id:null,assignment_refs:[],identity_resolution:'unresolved',identity_reason:'legacy_identity_review_required'});
          if(reviewed.has(record_id)) {
            const identity=reviewed.get(record_id);
            if(kind!=='progress' || original.status!=='done' || identity?.identity_resolution!=='linked' || identity.term_id!==TERM_ID || !identity.assignment_id)
              throw new Error('invalid_approved_link');
            Object.assign(row,identity,{title_aliases:[...new Set([...(original.title_aliases || []),original.item,identity.reference?.title].filter(Boolean))]});
            linked++;
          }
          this.sql.exec('INSERT INTO records VALUES (?,?,?,?,?,?,?)',record_id,kind,course,row.assignment_id || null,1,JSON.stringify(row),row.at || new Date(now).toISOString());
          this.sql.exec('INSERT INTO history(record_id,operation_id,data,at) VALUES (?,?,?,?)',record_id,'migration:'+digest,JSON.stringify({original,migrated:row}),new Date(now).toISOString());
          imported++;
        }
      }
      if(linked!==reviewed.size)throw new Error('approved_record_missing');
      for (const [key,value] of [['ready','1'],['term_id',TERM_ID],['migration_digest',digest],['migration_at',new Date(now).toISOString()]])
        this.sql.exec('INSERT INTO meta(key,value) VALUES (?,?)',key,value);
      return {ok:true,imported,linked,digest,legacy_identity_review:true};
    });
  }
  list(kind, courses) {
    if (this.meta('ready') !== '1') return {error:'records_initializing',status:503};
    const all=[];
    for (const course of courses) {
      const rows=this.rows('SELECT data FROM records WHERE kind=? AND course=? ORDER BY updated_at, record_id',kind,course).map(r=>JSON.parse(r.data));
      if (kind==='classnote') {
        const lectures=rows.filter(row=>row.record_id===PASS_PROTOCOL_RECORD_ID||!String(row.session_id||'').startsWith('pass:'));
        lectures.sort((a,b)=>String(a.date||'').localeCompare(String(b.date||'')));
        let kept=lectures.slice(-14);
        while (kept.length>1 && JSON.stringify(kept).length>18000) kept=kept.slice(1);
        all.push(...kept);
      } else all.push(...rows);
    }
    return {ok:true,records:all};
  }
  receipt(operation_id,fingerprint) {
    const row=this.rows('SELECT fingerprint,result FROM receipts WHERE operation_id=?',operation_id)[0];
    return !row ? null : row.fingerprint===fingerprint ? {...JSON.parse(row.result),replayed:true} : {error:'idempotency_conflict',status:409};
  }
  passRead({course=null,record_id=null,session_id=null,limit=10,cursor=null,protocol=false,sandbox=false}={}) {
    if(this.meta('ready')!=='1')return {error:'records_initializing',status:503};
    if(protocol) {
      const found=this.rows("SELECT data FROM records WHERE kind='classnote' AND record_id=?",PASS_PROTOCOL_RECORD_ID)[0];
      return found?{ok:true,record:JSON.parse(found.data),scope:'all_classes'}:{error:'pass_protocol_not_found',status:404};
    }
    // The lecture-note preview caps at 14 and sorts by lecture date. PASS needs
    // every retained session, ordered by its actual latest save, without changing
    // that preview or copying records into a second store.
    const where=["kind='classnote'","json_extract(data,'$.term_id')=?",
      "json_extract(data,'$.session_id') GLOB 'pass:*'",'record_id<>?'];
    const args=[TERM_ID,PASS_PROTOCOL_RECORD_ID];
    where.push('course IN ('+COURSES.map(()=>'?').join(',')+')');args.push(...COURSES.map(c=>c.code));
    where.push("json_extract(data,'$.session_id') "+(sandbox?'GLOB':'NOT GLOB')+" 'pass:test:*'");
    for(const [column,value] of [['course',course],['record_id',record_id],["json_extract(data,'$.session_id')",session_id]])
      if(value){where.push(column+'=?');args.push(value);}
    const scope=where.join(' AND ');
    if(record_id) {
      const found=this.rows('SELECT data FROM records WHERE '+scope,...args)[0];
      return found?{ok:true,record:JSON.parse(found.data)}:{error:'pass_not_found',status:404};
    }
    const courses_with_passes=this.rows('SELECT course,count(*) AS count FROM records WHERE '+scope+' GROUP BY course ORDER BY course',...args);
    if(cursor){where.push('(updated_at,record_id)<(?,?)');args.push(...cursor);}
    const rows=this.rows("SELECT json_remove(data,'$.text') AS data,updated_at,record_id FROM records WHERE "+where.join(' AND ')+
      ' ORDER BY updated_at DESC,record_id DESC LIMIT ?',...args,limit+1);
    const has_more=rows.length>limit,kept=rows.slice(0,limit),last=kept.at(-1);
    return {ok:true,term_id:TERM_ID,records:kept.map(row=>JSON.parse(row.data)),courses_with_passes,
      next_cursor:has_more?JSON.stringify([last.updated_at,last.record_id]):null,limit};
  }
  mutate(command) {
    return this.storage.transactionSync(() => {
      if (this.meta('ready') !== '1') return {error:'records_initializing',status:503};
      const {operation_id,fingerprint,kind,course,body,identity,at}=command;
      const receipt=this.rows('SELECT fingerprint,result FROM receipts WHERE operation_id=?',operation_id)[0];
      if (receipt) return receipt.fingerprint===fingerprint ? {...JSON.parse(receipt.result),replayed:true} : {error:'idempotency_conflict',status:409};
      const existing=this.rows('SELECT data FROM records WHERE kind=? AND course=?',kind,course).map(r=>JSON.parse(r.data));
      let prior;
      if (body.record_id) {
        prior=existing.find(r=>r.record_id===body.record_id);
        if (!prior) return {error:'record_not_found',status:404};
      } else if (kind==='progress') {
        prior=identity.assignment_id ? existing.find(r=>sameAssignment(r,identity)) : existing.find(r=>!r.assignment_id && normalizeTitle(r.item)===normalizeTitle(body.item));
      } else prior=existing.find(r=>r.session_id && r.session_id===body.session_id);
      if (body.expected_revision != null && Number(body.expected_revision)!==(prior?.revision || 0))
        return {error:'revision_conflict',status:409,current_revision:prior?.revision || 0,record_id:prior?.record_id || null};
      if (kind==='progress' && prior && identity.assignment_id && !sameAssignment(prior,identity)) {
        if (!body.relink || body.expected_revision==null) return {error:'explicit_relink_required',status:409,record_id:prior.record_id,current_revision:prior.revision};
        const collision=existing.find(r=>r.record_id!==prior.record_id && sameAssignment(r,identity));
        if (collision) return {error:'assignment_already_linked',status:409,record_id:collision.record_id};
      }
      const record_id=prior?.record_id || command.new_record_id;
      const revision=(prior?.revision || 0)+1;
      let row;
      if (kind==='progress') {
        const carries=prior?.status===body.status && (prior?.assignment_id ? sameAssignment(prior,identity) : !identity.assignment_id);
        const inherit=field=>carries ? prior?.[field] ?? null : null;
        const sent=field=>body[field]!==undefined && body[field]!==null && String(body[field]).trim()!=='';
        const verification=sent('verification') ? body.verification : inherit('verification') || (body.status==='done'?'reported':'unknown');
        const evidence=sent('evidence') ? body.evidence : inherit('evidence');
        if (verification==='verified' && !evidence) return {error:'verification_requires_evidence',status:400};
        row={item:body.item,key:normalizeTitle(body.item),status:body.status,verification,evidence,
          submitted_by:sent('submitted_by')?body.submitted_by:inherit('submitted_by'),
          reported_by:sent('reported_by')?body.reported_by:inherit('reported_by'),
          note:sent('note')?body.note:inherit('note'),via:command.via,
          ...identity,title_aliases:[...new Set([...(prior?.title_aliases || []),prior?.item,body.item,identity.reference?.title].filter(Boolean))].slice(-20)};
      } else row={session_id:body.session_id || null,date:body.date,title:body.title,text:body.text,term_id:TERM_ID};
      row={...row,record_id,course,revision,at,at_local:command.at_local};
      this.sql.exec('INSERT INTO records VALUES (?,?,?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET assignment_id=excluded.assignment_id,revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at',
        record_id,kind,course,row.assignment_id || null,revision,JSON.stringify(row),at);
      this.sql.exec('INSERT INTO history(record_id,operation_id,data,at) VALUES (?,?,?,?)',record_id,operation_id,JSON.stringify({before:prior || null,after:row}),at);
      const result={ok:true,course,recorded:row,operation_id,revision,
        tracked:existing.length+(prior?0:1),
        stored:kind==='classnote'?this.list(kind,[course]).records.length:existing.length+(prior?0:1),
        total_retained:existing.length+(prior?0:1),dropped:0,
        warning:kind==='progress' && !row.assignment_id ? 'Report saved, but no assignment was cleared. Identity review is required.' : null};
      this.sql.exec('INSERT INTO receipts VALUES (?,?,?,?)',operation_id,fingerprint,JSON.stringify(result),at);
      return result;
    });
  }
  history(record_id) { return {ok:true,history:this.rows('SELECT operation_id,data,at FROM history WHERE record_id=? ORDER BY seq',record_id).map(r=>({...r,data:JSON.parse(r.data)}))}; }
  session(action, data, now) {
    if (action==='create') {
      this.sql.exec('DELETE FROM sessions WHERE expires<=?',now);
      this.sql.exec('INSERT INTO sessions VALUES (?,?,?)',data.hash,data.expires,data.epoch);
      return {ok:true};
    }
    if (action==='delete') { this.sql.exec('DELETE FROM sessions WHERE token_hash=?',data.hash); return {ok:true}; }
    const row=this.rows('SELECT expires,epoch FROM sessions WHERE token_hash=?',data.hash)[0];
    return {ok:!!row && row.expires>now && row.epoch===data.epoch};
  }
  passGrant(action,data,now) {
    return this.storage.transactionSync(()=>{
      const row=this.rows('SELECT expires,epoch FROM sessions WHERE token_hash=?',data.hash)[0];
      const active=!!row&&row.expires>now&&row.epoch===data.epoch;
      const extension=active?this.rows('SELECT epoch,scopes FROM school_learner_access WHERE token_hash=?',data.hash)[0]:null;
      const learner_scopes=extension?.epoch===data.epoch?JSON.parse(extension.scopes):[];
      if(action==='check')return {ok:active,expires:active?row.expires:null,...(learner_scopes.length?{learner_scopes}:{})};
      if(action==='enable_learner'){
        if(data.hash!==EXISTING_CLAUDE_SCHOOL_GRANT||data.approval_id!==LEARNER_APPROVAL)return {error:'unsupported_existing_school_connection',status:403};
        if(!active)return {error:'existing_school_connection_inactive',status:409};
        if(extension)return extension.epoch===data.epoch?{ok:true,replayed:true,expires:row.expires,learner_scopes}:{error:'school_extension_conflict',status:409};
        this.sql.exec('INSERT INTO school_learner_access VALUES (?,?,?,?,?)',data.hash,data.epoch,data.approval_id,JSON.stringify(SCHOOL_LEARNER_SCOPES),new Date(now).toISOString());
        return {ok:true,replayed:false,expires:row.expires,learner_scopes:SCHOOL_LEARNER_SCOPES};
      }
      if(action==='create') {
        // A retry returns the same credential and original expiry; it must never
        // renew an expired/revoked request or silently create another grant.
        if(row)return active?{ok:true,replayed:true,expires:row.expires}:{error:'connection_request_retired',status:409};
        this.sql.exec('INSERT INTO sessions VALUES (?,?,?)',data.hash,data.expires,data.epoch);
        return {ok:true,replayed:false,expires:data.expires};
      }
      if(action==='revoke') {
        if(row&&row.epoch===data.epoch)this.sql.exec('UPDATE sessions SET epoch=?,expires=? WHERE token_hash=?','revoked:'+data.epoch,Number.MAX_SAFE_INTEGER,data.hash);
        return {ok:true,revoked:true};
      }
      return {error:'invalid_connection_action',status:400};
    });
  }
  loginAttempt(bucket, now, clear=false) {
    return this.storage.transactionSync(() => {
      if (clear) { this.sql.exec('DELETE FROM attempts WHERE bucket=?',bucket); return {ok:true}; }
      this.sql.exec('DELETE FROM attempts WHERE resets<=?',now);
      const old=this.rows('SELECT count,resets FROM attempts WHERE bucket=?',bucket)[0];
      if (old?.count>=8) return {ok:false,retry_after:Math.ceil((old.resets-now)/1000)};
      this.sql.exec('INSERT INTO attempts VALUES (?,?,?) ON CONFLICT(bucket) DO UPDATE SET count=excluded.count',bucket,(old?.count||0)+1,old?.resets || now+900000);
      return {ok:true};
    });
  }
}
import {EXISTING_CLAUDE_SCHOOL_GRANT,LEARNER_APPROVAL,SCHOOL_LEARNER_SCOPES} from './school-learner-access.js';
