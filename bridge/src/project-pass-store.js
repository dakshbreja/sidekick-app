// Project handoffs share the original SQLite Durable Object, but never a course
// bucket. No project, permission or current-state summary is created implicitly.
export const PROJECT_PASS_SCOPES=Object.freeze(['project.pass:read','project.pass:write']);
export const projectId=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(value);
export function projectAccess(access,id,write=false) {
  return projectId(id)&&(access?.owner===true||Array.isArray(access?.project_ids)&&access.project_ids.includes(id)&&
    access.scopes?.includes('project.pass:read')&&(!write||access.scopes.includes('project.pass:write')));
}
const denied=()=>({error:'project_access_denied',status:403});

export class ProjectPassStore {
  constructor(storage) {
    this.storage=storage;this.sql=storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS project_pass_grants (token_hash TEXT PRIMARY KEY,
        client TEXT NOT NULL, project_ids TEXT NOT NULL, scopes TEXT NOT NULL,
        expires INTEGER NOT NULL, epoch TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS pass_projects (project_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_pass_heads (project_id TEXT NOT NULL, sandbox INTEGER NOT NULL,
        revision INTEGER NOT NULL, PRIMARY KEY(project_id,sandbox));
      CREATE TABLE IF NOT EXISTS project_pass_records (record_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
        sandbox INTEGER NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL,
        head_revision INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(project_id,sandbox,session_id));
      CREATE TABLE IF NOT EXISTS project_pass_history (record_id TEXT NOT NULL, revision INTEGER NOT NULL,
        project_id TEXT NOT NULL, sandbox INTEGER NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY(record_id,revision));
      CREATE TABLE IF NOT EXISTS project_pass_receipts (project_id TEXT NOT NULL, sandbox INTEGER NOT NULL,
        operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(project_id,sandbox,operation_id));
    `);
  }
  rows(query,...args){return this.sql.exec(query,...args).toArray();}
  ready(){return this.rows("SELECT value FROM meta WHERE key='ready'")[0]?.value==='1';}
  head(id,sandbox){return this.rows('SELECT revision FROM project_pass_heads WHERE project_id=? AND sandbox=?',id,Number(sandbox))[0]?.revision||0;}
  registered(id){return this.rows('SELECT project_id,name,created_at FROM pass_projects WHERE project_id=?',id)[0]||null;}
  grant(action,data,now) {
    return this.storage.transactionSync(()=>{
      if(!this.ready())return {error:'records_initializing',status:503};
      const expose=row=>({grant_id:row.token_hash,client:row.client,project_ids:JSON.parse(row.project_ids),
        scopes:JSON.parse(row.scopes),expires_at:new Date(row.expires).toISOString(),
        active:!row.revoked&&row.expires>now&&row.epoch===data.epoch,revoked:!!row.revoked});
      if(action==='list')return {ok:true,grants:this.rows('SELECT * FROM project_pass_grants ORDER BY expires DESC LIMIT 50').map(expose)};
      const row=this.rows('SELECT * FROM project_pass_grants WHERE token_hash=?',data.hash)[0];
      const active=!!row&&!row.revoked&&row.expires>now&&row.epoch===data.epoch;
      if(action==='check')return active?{ok:true,...expose(row)}:{ok:false,active:false};
      if(action==='revoke') {
        if(row)this.sql.exec('UPDATE project_pass_grants SET revoked=1 WHERE token_hash=?',data.hash);
        return {ok:true,revoked:true,grant_id:data.hash};
      }
      if(action!=='create')return {error:'invalid_project_grant_action',status:400};
      if(row) {
        if(!active)return {error:'project_connection_request_retired',status:409};
        if(row.client!==data.client||row.project_ids!==JSON.stringify(data.project_ids)||row.scopes!==JSON.stringify(data.scopes))
          return {error:'project_connection_request_conflict',status:409};
        return {ok:true,...expose(row),replayed:true};
      }
      if(data.project_ids.some(id=>!this.registered(id)))return {error:'project_not_registered',status:404};
      this.sql.exec('INSERT INTO project_pass_grants VALUES (?,?,?,?,?,?,0)',data.hash,data.client,
        JSON.stringify(data.project_ids),JSON.stringify(data.scopes),data.expires,data.epoch);
      return {ok:true,...expose(this.rows('SELECT * FROM project_pass_grants WHERE token_hash=?',data.hash)[0]),replayed:false};
    });
  }
  call(action,args,access) {
    if(!this.ready())return {error:'records_initializing',status:503};
    if(action==='projects') {
      return {ok:true,projects:this.rows('SELECT project_id,name,created_at FROM pass_projects ORDER BY project_id').filter(p=>projectAccess(access,p.project_id))};
    }
    const id=args.project_id,sandbox=args.sandbox??false;
    if(!projectAccess(access,id,action==='save'))return denied();
    if(action==='register') {
      if(access?.owner!==true)return denied();
      return this.storage.transactionSync(()=>{
        const prior=this.registered(id);
        if(prior)return prior.name===args.name?{ok:true,project:prior,replayed:true}:{error:'project_already_registered',status:409};
        this.sql.exec('INSERT INTO pass_projects VALUES (?,?,?)',id,args.name,args.at);
        return {ok:true,project:this.registered(id),replayed:false};
      });
    }
    if(!this.registered(id))return {error:'project_not_registered',status:404};
    if(action==='save')return this.save(args);
    const scope=[id,Number(sandbox)],head_revision=this.head(id,sandbox);
    if(action==='read'||action==='history') {
      const found=this.rows('SELECT data FROM project_pass_records WHERE project_id=? AND sandbox=? AND record_id=?',...scope,args.record_id)[0];
      if(!found)return {error:'project_pass_not_found',status:404};
      if(action==='read')return {ok:true,record:JSON.parse(found.data),head_revision};
      return {ok:true,project_id:id,sandbox,head_revision,history:this.rows('SELECT data FROM project_pass_history WHERE project_id=? AND sandbox=? AND record_id=? ORDER BY revision',...scope,args.record_id).map(r=>JSON.parse(r.data))};
    }
    if(action!=='list')return {error:'unknown_project_pass_action',status:400};
    const limit=args.limit??10,where=args.cursor===undefined?'':' AND head_revision<?';
    const rows=this.rows('SELECT data FROM project_pass_records WHERE project_id=? AND sandbox=?'+where+' ORDER BY head_revision DESC LIMIT ?',
      ...scope,...(args.cursor===undefined?[]:[args.cursor]),limit+1);
    const records=rows.slice(0,limit).map(r=>JSON.parse(r.data));
    return {ok:true,project_id:id,sandbox,head_revision,records:records.map(({facts,interpretations,...metadata})=>metadata),
      next_cursor:rows.length>limit?records.at(-1).head_revision:null,
      content_authority:'Dated handoffs, not an automatically reconciled truth. Review sources and unresolved contradictions.'};
  }
  save(args) {
    return this.storage.transactionSync(()=>{
      const {project_id:id,sandbox,operation_id,fingerprint,packet,record_id:newId,at}=args,scope=[id,Number(sandbox)];
      const old=this.rows('SELECT fingerprint,result FROM project_pass_receipts WHERE project_id=? AND sandbox=? AND operation_id=?',...scope,operation_id)[0];
      if(old)return old.fingerprint===fingerprint?{...JSON.parse(old.result),replayed:true}:{error:'idempotency_conflict',status:409};
      const head=this.head(id,sandbox);
      if(packet.expected_head_revision!==head)return {error:'project_head_conflict',status:409,current_head_revision:head};
      const priorRow=this.rows('SELECT data FROM project_pass_records WHERE project_id=? AND sandbox=? AND session_id=?',...scope,packet.session_id)[0];
      const prior=priorRow?JSON.parse(priorRow.data):null;
      if(packet.record_id&&packet.record_id!==prior?.record_id)return {error:'project_pass_not_found',status:404};
      if(packet.expected_revision!==(prior?.revision||0))return {error:'revision_conflict',status:409,current_revision:prior?.revision||0};
      if(prior&&!packet.record_id)return {error:'project_update_requires_record_id',status:409};
      for(const ref of packet.prior_handoffs||[]) {
        if(!this.rows('SELECT revision FROM project_pass_history WHERE project_id=? AND sandbox=? AND record_id=? AND revision=?',...scope,ref.record_id,ref.revision).length)
          return {error:'referenced_handoff_not_found',status:409};
      }
      const {expected_revision,expected_head_revision,idempotency_key,...content}=packet;
      const record={...content,project_id:id,sandbox,record_id:prior?.record_id||newId,revision:expected_revision+1,
        base_revision:expected_revision,head_revision:head+1,base_head_revision:head,operation_id,at};
      this.sql.exec('INSERT INTO project_pass_records VALUES (?,?,?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET revision=excluded.revision,head_revision=excluded.head_revision,data=excluded.data',
        record.record_id,id,Number(sandbox),record.session_id,record.revision,record.head_revision,JSON.stringify(record));
      this.sql.exec('INSERT INTO project_pass_history VALUES (?,?,?,?,?,?)',record.record_id,record.revision,id,Number(sandbox),JSON.stringify({before:prior,after:record}),at);
      this.sql.exec('INSERT INTO project_pass_heads VALUES (?,?,?) ON CONFLICT(project_id,sandbox) DO UPDATE SET revision=excluded.revision',...scope,head+1);
      const result={ok:true,operation_id,revision:record.revision,head_revision:head+1,recorded:record};
      this.sql.exec('INSERT INTO project_pass_receipts VALUES (?,?,?,?,?)',...scope,operation_id,fingerprint,JSON.stringify(result));
      return result;
    });
  }
}
