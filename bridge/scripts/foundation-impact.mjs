// Read-only migration impact assessment; never prints credentials or report text.
import {readFile} from 'node:fs/promises';
const raw=await readFile('/Users/Daksh/Claude/school-system-suite/bridge/.env','utf8');
const config={};
for(const line of raw.split(/\r?\n/)){
  const m=/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if(m)config[m[1]]=m[2].replace(/^['"]|['"]$/g,'');
}
const base=new URL(config.WORKER_URL);
if(!['ijuh2yp6rf.example-subdomain.workers.dev','coursework.example-subdomain.workers.dev'].includes(base.hostname)||base.protocol!=='https:')throw Error('Unexpected bridge origin');
const get=async path=>{
  const r=await fetch(new URL(path,base),{headers:{Authorization:'Bearer '+config.API_KEY,'X-Bridge-Client':'dashboard','User-Agent':'bridge-foundation-read-only'},signal:AbortSignal.timeout(35000)});
  if(!r.ok)throw Error('Bridge read returned HTTP '+r.status);
  return r.json();
};
try {
  const courses=['BUSN5000','MGMT4280','MGMT5560','MGMT5850','LAND2510','BUSN3040','GENERAL'];
  const current=await get('/status');
  const rows=courses.map(course=>({course,progress:(current.progress||[]).filter(p=>(p.course||'GENERAL')===course)}));
  console.log(JSON.stringify({
    read_at:new Date().toISOString(),coursework_records_changed:false,
    courses:rows.map(({course,progress})=>({course,reports:progress.length,done:progress.filter(p=>p.status==='done').length,
      identity_review_required:progress.filter(p=>!p.assignment_id||p.identity_resolution!=='linked').length})),
    current_links:process.argv.includes('--review')?[].concat(current.overdue||[],current.due_today||[],current.due_this_week||[],current.upcoming||[]).filter(d=>d.completed).map(d=>({
      course:d.course_code||'GENERAL',current_title:d.title,when_iso:d.when_iso,
      reported_item:d.completion?.matched||null,
      match_method:d.completion?.match_method||null,reported_at:d.completion?.reported_at||null,
      submission_verification:d.completion?.submission_verification||'unknown',
      decision:'Requires confirmation; old title match is not new identity evidence.'
    })):undefined,
    total_reports:rows.reduce((n,r)=>n+r.progress.length,0),
    completed_deadlines_currently_matched:current.actionable?.counts?.completed??null,
    feed_status:current.actionable?.coverage?.feeds_status??null,
    warning:'Title-only history is retained but will not clear assignments until explicitly linked. No link decisions made.'
  },null,2));
} catch(e) {console.error(/^Bridge read returned HTTP \d+$/.test(e.message)?e.message:'Assessment could not be completed; no migration was performed.');process.exitCode=1;}
