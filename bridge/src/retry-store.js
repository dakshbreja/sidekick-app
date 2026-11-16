// Retry requests are separate from academic records. One active request per
// underlying job prevents two tabs (or two nodes) from starting duplicate work.
export class RetryStore {
  constructor(storage) {
    this.storage=storage;this.sql=storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS system_retries (
      id TEXT PRIMARY KEY, target TEXT NOT NULL, data TEXT NOT NULL, requested INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS system_retries_target ON system_retries(target,requested);`);
  }
  rows() {return this.sql.exec('SELECT data FROM system_retries ORDER BY requested DESC LIMIT 200').toArray().map(r=>JSON.parse(r.data));}
  save(job) {this.sql.exec('INSERT INTO system_retries VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',job.id,job.target,JSON.stringify(job),Date.parse(job.requested_at));return job;}
  expire(now) {
    for(const j of this.rows())if(['queued','running'].includes(j.state)&&now-Date.parse(j.updated_at)>(j.state==='queued'?15*60000:40*60000))
      this.save({...j,state:'blocked',message:j.state==='queued'?'The Mac did not pick up this request. Wake it, then try again.':'No completion receipt arrived. Check the running job before retrying.',updated_at:new Date(now).toISOString()});
  }
  list(now=Date.now()) {this.expire(now);return this.rows();}
  request(id,node,target,mode,now=Date.now()) {
    return this.storage.transactionSync(()=>{
      this.expire(now);
      const rows=this.rows(),same=rows.find(j=>j.id===id);
      if(same)return {job:same,created:false};
      const active=rows.find(j=>j.target===target&&(['queued','running'].includes(j.state)||now-Date.parse(j.requested_at)<60000));
      if(active)return {job:active,created:false};
      const at=new Date(now).toISOString();
      const job=this.save({id,node,target,mode,state:mode==='local'?'queued':'running',requested_at:at,updated_at:at,message:mode==='local'?'Waiting for this Mac. Requests are picked up within a minute while it is awake.':'Checking now…'});
      this.sql.exec('DELETE FROM system_retries WHERE requested < ?',now-7*86400000);
      return {job,created:true};
    });
  }
  claim(now=Date.now()) {
    return this.storage.transactionSync(()=>{
      this.expire(now);const rows=this.rows();
      if(rows.some(j=>j.mode==='local'&&j.state==='running'))return null;
      const j=rows.filter(j=>j.mode==='local'&&j.state==='queued').at(-1);
      return j?this.save({...j,state:'running',updated_at:new Date(now).toISOString(),message:'The Mac picked up this retry. Running the existing job…'}):null;
    });
  }
  finish(id,result,now=Date.now()) {
    return this.storage.transactionSync(()=>{
      const j=this.rows().find(j=>j.id===id);
      if(!j)return {error:'retry_not_found'};
      if(!['running','queued'].includes(j.state))return j;
      return this.save({...j,...result,updated_at:new Date(now).toISOString()});
    });
  }
}
