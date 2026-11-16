// Scoped, auditable cutover helper. No keys, private feed URLs, or report notes are logged.
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,mkdtempSync,existsSync} from 'node:fs';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {stableJSON} from '../src/foundation.js';
const run=promisify(execFile);
const canonical='/Users/Daksh/Claude/school-system-suite/bridge';
const stage='/private/tmp/bridge-foundation-pass.zPrwVa/bridge';
const wrangler='/Users/Daksh/.npm/_npx/32026684e21afda6/node_modules/wrangler/bin/wrangler.js';
const namespace='e007bdd3976240868781d046e9f88622';
const courses=['BUSN5000','MGMT4280','MGMT5560','MGMT5850','LAND2510','BUSN3040','GENERAL'];
const approved=JSON.parse(readFileSync(stage+'/docs/foundation-approved-links.json','utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const save=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
const config={};
for(const line of readFileSync(canonical+'/.env','utf8').split(/\r?\n/)){
  const m=/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);if(m)config[m[1]]=m[2].replace(/^['"]|['"]$/g,'');
}
const origin='https://ijuh2yp6rf.example-subdomain.workers.dev';
assert.equal(new URL(config.WORKER_URL).hostname,'ijuh2yp6rf.example-subdomain.workers.dev');
async function api(path,body,base=origin){
  const r=await fetch(base+path,{method:body===undefined?'GET':'POST',redirect:'error',
    headers:{Authorization:'Bearer '+config.API_KEY,'X-Bridge-Client':'dashboard','X-Bridge-Maintenance':'foundation-v1','Content-Type':'application/json','User-Agent':'bridge-foundation-cutover'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(45000)});
  let data;try{data=await r.json();}catch{throw Error('Non-JSON bridge response: '+r.status);}
  if(!r.ok)throw Error('Bridge HTTP '+r.status+': '+String(data.error||'unknown'));
  return data;
}
const targets=[
  'gpt-action-schema.yaml','mcp/school_bridge_mcp.py','mcp/test_school_bridge_mcp.py',
  'src/app.js','src/ics.js','src/openapi.js','src/status.js','src/system-health.js','src/system-page.js','src/worker.js',
  'test/client-contract.test.mjs','test/commands.test.mjs','test/completion.test.mjs','test/system-health.test.mjs','test/worker.test.mjs','wrangler.toml',
  'src/auth.js','src/entry.js','src/feed-reader.js','src/foundation.js','src/identity.js','src/record-routes.js','src/record-store.js','src/sign-in.js','src/state-object.js','src/migration-links.js',
  'test/foundation-live-readonly.mjs','test/foundation-runtime.mjs','test/foundation.test.mjs','test/runtime-entry.js','test/sqlite-fixture.js','test/migration-links.test.mjs',
  'scripts/foundation-impact.mjs','scripts/foundation-cutover.mjs','docs/foundation-pass.md','docs/foundation-legacy-review.md','docs/foundation-approved-links.json','FOUNDATION-CHECKPOINT.md'
];
function completionRows(data){return [...data.overdue,...data.due_today,...data.due_this_week,...data.upcoming].filter(d=>d.completed);}
function checkApproved(data){
  assert.equal(data.actionable.coverage.feeds_status,'ok','live sources must be healthy');
  const completed=completionRows(data);
  assert.equal(completed.length,11,'unexpected completion count');
  for(const link of approved){
    const found=completed.filter(d=>(d.course_code||'GENERAL')===link.course && d.title===link.current_title && d.when_iso===link.when_iso);
    assert.equal(found.length,1,'approved calendar reference changed');
    assert.equal(found[0].completion.matched,link.reported_item,'approved report changed');
    assert.equal(found[0].completion.reported_at,link.reported_at,'approved report timestamp changed');
    assert.equal(found[0].completion.submission_verification,'reported','verification changed');
  }
  assert.equal(data.progress.length,18,'progress count changed');
}
async function backupLegacy(dir,label){
  const raw={},snapshot={term_id:'fall-2026',progress:{},classnote:{}};
  for(const kind of ['progress','classnote'])for(const course of courses){
    const key=(kind==='progress'?'progress:':'classnotes:')+course;
    let value;
    try{
      const result=await run(process.execPath,[wrangler,'kv','key','get',key,'--namespace-id',namespace,'--remote','--env',''],{cwd:stage,maxBuffer:4*1024*1024});
      value=result.stdout;
      if(value.trim()==='Value not found')value=null;
    }catch(err){
      // Wrangler reports missing keys using a known explicit message, never treat other failures as empty.
      if(String(err.stderr||'').includes('/values/'+encodeURIComponent(key)+' - 404: Not Found'))value=null;
      else throw Error('KV backup failed for '+key+' (exit '+err.code+')');
    }
    const rows=value===null?[]:JSON.parse(value);
    assert.ok(Array.isArray(rows),'legacy value must be an array');
    raw[key]=value;snapshot[kind][course]=rows;
  }
  const digest=hash(stableJSON(snapshot)),file=dir+'/'+label+'-legacy.json';
  save(file,{exported_at:new Date().toISOString(),raw,snapshot,digest});
  console.log(JSON.stringify({backup:file,digest,counts:Object.fromEntries(['progress','classnote'].map(k=>[k,Object.values(snapshot[k]).reduce((n,rows)=>n+rows.length,0)]))}));
  return {snapshot,digest};
}
async function main(){
  const action=process.argv[2],dir=process.argv[3];
  if(action==='prepare'){
    const current=await api('/status');checkApproved(current);
    // Stop on overlaps before making any source changes.
    const manifest=targets.map(path=>{
      let baseline=null;try{baseline=execFileSync('git',['show','773c76a:bridge/'+path],{cwd:stage,stdio:['ignore','pipe','ignore']});}catch{}
      const target=canonical+'/'+path;
      assert.equal(existsSync(target),!!baseline,'canonical target presence changed: '+path);
      if(baseline)assert.equal(hash(readFileSync(target)),hash(baseline),'canonical changed: '+path);
      return {path,before:baseline?hash(baseline):null,after:hash(readFileSync(stage+'/'+path))};
    });
    mkdirSync(canonical+'/.backups',{recursive:true,mode:0o700});
    const backup=mkdtempSync(canonical+'/.backups/foundation-2026-09-05-');
    mkdirSync(backup+'/source',{mode:0o700});
    for(const row of manifest)if(row.before){const target=backup+'/source/'+row.path;mkdirSync(target.slice(0,target.lastIndexOf('/')),{recursive:true,mode:0o700});copyFileSync(canonical+'/'+row.path,target);}
    save(backup+'/source-manifest.json',manifest);save(backup+'/approved-links.json',approved);save(backup+'/preflight-status.json',current);
    writeFileSync(backup+'/tracked-source.patch',execFileSync('git',['diff','--binary','--','bridge'],{cwd:stage}),{mode:0o600,flag:'wx'});
    await backupLegacy(backup,'predeploy');
    console.log('PREPARED_BACKUP='+backup);
  }else{
    assert.ok(dir?.startsWith(canonical+'/.backups/foundation-2026-09-05-') && !dir.includes('..'),'exact backup directory required');
    if(action==='install'){
      const manifest=JSON.parse(readFileSync(dir+'/source-manifest.json','utf8'));
      for(const row of manifest){
        const target=canonical+'/'+row.path;
        assert.equal(existsSync(target),row.before!==null,'canonical target changed: '+row.path);
        if(row.before)assert.equal(hash(readFileSync(target)),row.before,'canonical source changed: '+row.path);
        assert.equal(hash(readFileSync(stage+'/'+row.path)),row.after,'staging changed: '+row.path);
      }
      for(const row of manifest){const target=canonical+'/'+row.path;mkdirSync(target.slice(0,target.lastIndexOf('/')),{recursive:true});copyFileSync(stage+'/'+row.path,target);assert.equal(hash(readFileSync(target)),row.after);}
      save(dir+'/installed.json',{at:new Date().toISOString(),files:manifest.length});console.log('Installed '+manifest.length+' explicitly reviewed files.');
    }else if(action==='start'){
      const result=await api('/foundation/migration/start',{});save(dir+'/migration-start.json',result);console.log(JSON.stringify(result));
    }else if(action==='snapshot'){
      const prior=JSON.parse(readFileSync(dir+'/predeploy-legacy.json','utf8'));
      const snapshot=await backupLegacy(dir,'quiescent');
      assert.equal(snapshot.digest,prior.digest,'legacy records changed since preflight; review before migration');
      const preview=await api('/foundation/migration/preview');assert.equal(preview.digest,snapshot.digest,'KV export and Worker preview differ');
      assert.equal(preview.health.ready,false);save(dir+'/preview.json',preview);console.log('Quiescent snapshot matches the original backup and Worker preview.');
    }else if(action==='initialize'){
      const backup=JSON.parse(readFileSync(dir+'/quiescent-legacy.json','utf8'));
      const preview=await api('/foundation/migration/preview');
      assert.equal(preview.digest,backup.digest,'legacy digest changed');assert.ok(Date.now()>=preview.health.migration_not_before,'cooldown incomplete');
      const result=await api('/foundation/migration/initialize',{expected_digest:backup.digest,approved_links:approved});
      save(dir+'/initialized.json',result);console.log(JSON.stringify(result));
    }else if(action==='verify'){
      const backup=JSON.parse(readFileSync(dir+'/quiescent-legacy.json','utf8'));
      const data=await api('/status');checkApproved(data);assert.equal(data.term_id,'fall-2026');
      const h=await api('/foundation/health');assert.equal(h.ready,true);
      let histories=0;
      for(const kind of ['progress','classnote'])for(const course of courses)for(const [i,original] of backup.snapshot[kind][course].entries()){
        const record_id='legacy:fall-2026:'+kind+':'+course+':'+i;
        const history=await api('/progress/history?record_id='+encodeURIComponent(record_id));
        assert.deepEqual(history.history[0].data.original,original,'archived original differs');
        const migrated=history.history[0].data.migrated;
        for(const [key,value] of Object.entries(original))assert.deepEqual(migrated[key],value,'original field changed: '+key);
        histories++;
      }
      assert.equal(data.progress.filter(p=>p.identity_resolution==='linked').length,11);
      assert.equal(data.progress.filter(p=>p.identity_resolution!=='linked').length,7);
      const friendly=await api('/status',undefined,'https://coursework.example-subdomain.workers.dev');checkApproved(friendly);
      assert.deepEqual(friendly.progress,data.progress);
      const result={at:new Date().toISOString(),progress:data.progress.length,linked:11,unresolved:7,histories_checked:histories,health:h,both_frontdoors:true,all_reviewed_completions_reported:true};
      save(dir+'/live-verification.json',result);save(dir+'/postmigration-status.json',data);console.log(JSON.stringify(result));
    }else throw Error('Unknown cutover action');
  }
}
main().catch(err=>{console.error('STOP: '+String(err.message).split('\n')[0]);process.exitCode=1;});
