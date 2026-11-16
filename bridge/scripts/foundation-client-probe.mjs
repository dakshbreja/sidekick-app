// Read-only checks. Starts its own stdio adapter; does not restart host clients.
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const canonical='/Users/Daksh/Claude/school-system-suite/bridge';
const config={};
for(const line of readFileSync(canonical+'/.env','utf8').split(/\r?\n/)){
  const m=/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);if(m)config[m[1]]=m[2].replace(/^['"]|['"]$/g,'');
}
const maintenance=process.argv.includes('--maintenance');
for(const host of ['ijuh2yp6rf','coursework']){
  const origin='https://'+host+'.example-subdomain.workers.dev';
  const r=await fetch(origin+'/status',{headers:{Authorization:'Bearer '+config.API_KEY,'X-Bridge-Client':'dashboard'},signal:AbortSignal.timeout(40000)});
  assert.equal(r.status,maintenance?503:200);
  if(maintenance)assert.equal((await r.json()).error,'records_initializing');
  const s=await fetch(origin+'/openapi.json',{signal:AbortSignal.timeout(15000)});
  assert.equal(s.status,200);const schema=await s.json();
  assert.equal(schema.openapi,'3.1.0');
  assert.deepEqual(schema.security,[{bearerAuth:[]}]);
  const write=schema.paths['/progress'].post.requestBody.content['application/json'].schema.properties;
  for(const field of ['assignment_id','term_id','record_id','expected_revision','relink','idempotency_key'])assert.ok(write[field],field);
  console.log('PASS '+host+': '+(maintenance?'explicit maintenance response':'live status')+' and new Action schema fields.');
}
if(!maintenance){
  const requests=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05'}},
    {jsonrpc:'2.0',id:2,method:'tools/list'},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_school_status',arguments:{}}}];
  const output=execFileSync('/opt/anaconda3/bin/python3',[canonical+'/mcp/school_bridge_mcp.py'],{input:requests.map(r=>JSON.stringify(r)).join('\n')+'\n',encoding:'utf8',timeout:45000,maxBuffer:1000000,stdio:['pipe','pipe','pipe']});
  const responses=output.trim().split('\n').map(line=>JSON.parse(line));
  const fields=responses.find(r=>r.id===2).result.tools.find(t=>t.name==='mark_progress').inputSchema.properties;
  for(const field of ['assignment_id','expected_revision','idempotency_key','relink'])assert.ok(fields[field],field);
  const response=responses.find(r=>r.id===3).result;assert.equal(response.isError,false);
  const status=JSON.parse(response.content[0].text);assert.equal(status.term_id,'fall-2026');
  assert.equal(status.actionable.counts.completed,11);assert.equal(status.identity_review.length,7);
  console.log('PASS fresh stdio MCP adapter: new write fields advertised and live status reads show 11 completions and 7 historical reviews. Existing host processes were not restarted.');
}
