// Club sessions live beside, never inside, coursework progress. Synchronous
// transactions keep a retried joint recording from duplicating or losing edits.
export const CLUBS = [
  {id:'ai-society',name:'AI Society at Terry',groupme_id:'106159597',standalone_status:'active'},
  {id:'openai-uga',name:'OpenAI Student Collective UGA',groupme_id:'117284689',standalone_status:'not_started',status_source:'User, September 16, 2026; joint workshop has occurred.'},
];
export class ClubStore {
  constructor(storage) {
    this.storage=storage; this.sql=storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS club_records (kind TEXT NOT NULL,id TEXT NOT NULL,
      revision INTEGER NOT NULL,hash TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS club_history (seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,at TEXT NOT NULL);`);
  }
  get(kind,id) {
    const r=this.sql.exec('SELECT * FROM club_records WHERE kind=? AND id=?',kind,id).toArray()[0];
    return r?{...JSON.parse(r.data),revision:r.revision,hash:r.hash,updated_at:r.updated_at}:null;
  }
  put(kind,id,data,hash,revision,at) {
    return this.storage.transactionSync(()=>{
      const prior=this.get(kind,id);
      if(prior?.hash===hash)return {ok:true,unchanged:true,revision:prior.revision,hash};
      if((prior?.revision||0)!==revision)return {error:'revision_conflict',status:409,current_revision:prior?.revision||0};
      const next=revision+1,raw=JSON.stringify(data);
      this.sql.exec('INSERT INTO club_records VALUES (?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,hash=excluded.hash,data=excluded.data,updated_at=excluded.updated_at',kind,id,next,hash,raw,at);
      this.sql.exec('INSERT INTO club_history(kind,id,revision,data,at) VALUES (?,?,?,?,?)',kind,id,next,raw,at);
      return {ok:true,revision:next,hash};
    });
  }
  list() {
    // Select metadata in SQLite so the health map never loads raw transcripts.
    return this.sql.exec(`SELECT id AS session_id,revision,hash,updated_at,
      json_extract(data,'$.title') AS title,json_extract(data,'$.created_at') AS created_at,
      json_extract(data,'$.clubs') AS clubs,json_extract(data,'$.transcript_sha256') AS transcript_sha256
      FROM club_records WHERE kind='session' ORDER BY json_extract(data,'$.created_at') DESC`).toArray().map(r=>({...r,clubs:JSON.parse(r.clubs)}));
  }
  search(query,club,offset=0) {
    const clause=club?' AND EXISTS (SELECT 1 FROM json_each(club_records.data,\'$.clubs\') WHERE value=?)':'';
    const args=[query.toLowerCase(),...(club?[club]:[])];
    const where="kind='session' AND instr(lower(json_extract(data,'$.transcript')),?)>0"+clause;
    const total=this.sql.exec('SELECT count(*) AS n FROM club_records WHERE '+where,...args).toArray()[0].n;
    const rows=this.sql.exec('SELECT data FROM club_records WHERE '+where+' ORDER BY updated_at DESC LIMIT 20 OFFSET ?',...args,offset).toArray();
    return {query,total,offset,next_offset:offset+rows.length<total?offset+rows.length:null,results:rows.map(({data})=>{
      const r=JSON.parse(data),lines=r.transcript.split('\n'),hits=[];
      for(let i=0;i<lines.length && hits.length<5;i++)if(lines[i].toLowerCase().includes(query.toLowerCase()))hits.push(lines.slice(Math.max(0,i-1),i+2).join('\n').slice(0,1800));
      return {session_id:r.session_id,title:r.title,created_at:r.created_at,clubs:r.clubs,excerpts:hits};
    })};
  }
  overview() {return {sessions:this.list(),sync:this.get('meta','sync'),project:this.get('meta','project')};}
}
export function clubStatus(raw,now=Date.now()) {
  const sync=raw.sync,project=raw.project;
  const projectCurrent=Boolean(sync?.bundle_sha256 && project?.bundle_sha256===sync.bundle_sha256 && project?.retrieval==='verified');
  const errors=[];
  if(!sync)errors.push('No club sync receipt');
  else {
    if(!sync.raw_coverage_complete)errors.push('Cluely club history coverage is incomplete');
    if(!sync.groupme_coverage_complete)errors.push('GroupMe source review is incomplete');
    if(!sync.bridge_verified_at)errors.push('Bridge transcript retrieval is unverified');
    if(now-Date.parse(sync.checked_at)>36*3600e3)errors.push('Transcript sync check is stale');
    if(!sync.groupme_checked_at || now-Date.parse(sync.groupme_checked_at)>8*86400e3)errors.push('GroupMe check is stale');
    if(Object.values(sync.newest_raw||{}).some(r=>!raw.sessions.some(s=>s.session_id===r.session_id)))errors.push('Newest club recording is not imported yet');
    if(sync.pending_session_ids?.length)errors.push('Some recordings are awaiting import');
  }
  if(!projectCurrent)errors.push('ChatGPT project publication or retrieval is pending');
  return {schema_version:1,clubs:CLUBS.map(c=>({...c,standalone_status:raw.sessions.some(s=>s.clubs.length===1&&s.clubs[0]===c.id)?'active':c.standalone_status,
    newest_imported:raw.sessions.find(s=>s.clubs.includes(c.id))||null,
    newest_raw:sync?.newest_raw?.[c.id]||null})),...raw,project_current:projectCurrent,
    state:!sync?'unknown':errors.length?'stale':'current',errors};
}
