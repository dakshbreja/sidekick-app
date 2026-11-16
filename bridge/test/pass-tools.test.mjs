import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {sqliteFoundation} from './sqlite-fixture.js';
import {executePassTool,executeMaterialTool,PASS_TOOLS} from '../src/pass-tools.js';
import {PASS_PROTOCOL_RECORD_ID} from '../src/record-store.js';
import {TERM_ID} from '../src/identity.js';
import {COURSES} from '../src/courses.js';
import worker from '../src/worker.js';
import openapi from '../src/openapi.js';
import {createHash} from 'node:crypto';
import {stableJSON} from '../src/foundation.js';

export function passFixture(t) {
  const f=sqliteFoundation();t.after(()=>f.close());
  const map=new Map(),env={API_KEY:'synthetic-owner-key',BRIDGE_STATE:f.binding,NOTES:{get:async k=>map.get(k)||null,put:async(k,v)=>map.set(k,v)}};
  return {...f,env};
}
export const passPacket=(extra={})=>({course:'BUSN5000',session_id:'fixture-session',date:'2026-10-31',title:'BUSN5000 synthetic file check',goal:'Check the file import.',
  recorded_by:'Synthetic fixture',facts:[{basis:'observed',text:'The synthetic import returned object not found.',source:'Synthetic fixture command output'}],
  next_step:'Check the filename.',expected_revision:0,idempotency_key:'synthetic-pass-operation',...extra});
const post=(tool,args,env)=>worker.fetch(new Request('https://bridge.test/pass/tools/'+tool,{method:'POST',headers:{Authorization:'Bearer '+env.API_KEY,'Content-Type':'application/json'},body:JSON.stringify(args)}),env);

test('adding PASS Actions preserves every old operation, authentication component and server identity',()=>{
  const hashes={
    'get /learning':'8d32c5b3e2364bd6fb99977d90d8582ff9d2e7bea8ea0fbd0c76101fcabfae2f',
    'post /learning':'9d7e532a3e93dc2f908148d8f244e6d5f935ba1f7a7bfb27d876f64f893525e9',
    'get /status':'7d9f5cdba833a63edea174ecac260234d942717aa1a0c0ae7c2c6d76f023db0d',
    'post /progress':'5d4afc17e4d2487895d1537cfc76148ea51d066e6b0747c467848939af34fc59',
    'get /library':'8c3fc81f5a59d291b0a9ea712cefd3c1c50b1fbd1f21a964df0212aec1a4a2f5',
    'get /library/doc':'2a81877793108e8cb1b1717fd3c1501035dc2748e4929f1026cfbf304e8568a6'};
  const hash=value=>createHash('sha256').update(stableJSON(value)).digest('hex');
  for(const [key,expected] of Object.entries(hashes)){const [method,path]=key.split(' ');assert.equal(hash(openapi.paths[path][method]),expected,key);}
  assert.equal(hash(openapi.components),'c421c922155a0a514624bc92e5f1f067b2a085294ea71285e2b1c781076b2ecc');
  assert.equal(hash(openapi.security),'8c620f3bf5554dfedae01f400f602c5370095c8b0bf5985ec48c69101d009f50');
  assert.deepEqual(openapi.servers,[{url:'https://ijuh2yp6rf.example-subdomain.workers.dev'}]);
  const ids=Object.values(openapi.paths).flatMap(methods=>Object.values(methods).map(op=>op.operationId));assert.equal(ids.length,20);assert.equal(Object.keys(openapi.paths).filter(p=>p.startsWith('/learner/tools/')).length,9);
  for(const tool of PASS_TOOLS){const action=openapi.paths['/pass/tools/'+tool.name].post;assert.deepEqual(action.requestBody.content['application/json'].schema,tool.inputSchema);assert.equal(action['x-openai-isConsequential'],tool.name==='save_pass');}
});

test('shared remote and Action input schemas exactly mirror the original stdio source',()=>{
  const raw=execFileSync('/opt/anaconda3/bin/python3',['-c',
    "import sys,json;sys.path.insert(0,'bridge/mcp');import school_bridge_mcp as m;print(json.dumps(m.PASS_TOOLS))"],{encoding:'utf8'});
  const original=JSON.parse(raw);
  assert.deepEqual(PASS_TOOLS.map(({annotations,outputSchema,...tool})=>tool),original);
});

test('HTTP PASS save renders the same normalized packet as the original stdio adapter',async t=>{
  const f=passFixture(t),args=passPacket(),catalog={ok:true,term_id:TERM_ID,timezone:'America/New_York',courses:COURSES.map(({code,label,title})=>({code,label,title}))};
  const code="import sys,json;sys.path.insert(0,'bridge/mcp');import school_bridge_mcp as m\nargs,catalog=json.load(sys.stdin)\nseen={}\ndef peer(path,payload=None,method='POST'):\n if path=='/pass/courses':return catalog\n if path=='/classnote':seen.update(payload);return {'error':'fixture_stop'}\n raise AssertionError(path)\nm.call_bridge=peer\nm.pass_tool('save_pass',args)\nprint(json.dumps(seen))";
  const expected=JSON.parse(execFileSync('/opt/anaconda3/bin/python3',['-c',code],{input:JSON.stringify([args,catalog]),encoding:'utf8'}));
  let observed;const mutate=f.stub.mutate;f.stub.mutate=async command=>{observed=command.body;return mutate(command);};
  const response=await post('save_pass',args,f.env),out=await response.json();
  assert.equal(response.status,200);assert.equal(out.save_confirmation,'confirmed');assert.deepEqual(observed,expected);
});

test('HTTP PASS operations preserve revision, retry, session and other school state',async t=>{
  const f=passFixture(t),args=passPacket({sandbox:true});
  const learning=f.learningStore.get('BUSN5000',TERM_ID,false),notes=f.store.list('classnote',['BUSN5000']);
  const first=await (await post('save_pass',args,f.env)).json(),again=await (await post('save_pass',args,f.env)).json();
  assert.equal(first.save_confirmation,'confirmed');assert.equal(again.replayed,true);assert.deepEqual(again.recorded,first.recorded);
  const update={...args,record_id:first.recorded.record_id,expected_revision:1,idempotency_key:'correction',next_step:'Check the working directory.'};
  const corrected=await (await post('save_pass',update,f.env)).json();assert.equal(corrected.revision,2);
  assert.equal((await post('save_pass',{...update,idempotency_key:'stale'},f.env)).status,409);
  assert.equal((await post('save_pass',{...args,next_step:'different'},f.env)).status,409);
  const resumed=await (await post('resume_pass',{course:'BUSN5000',sandbox:true},f.env)).json();assert.deepEqual(resumed.record,corrected.recorded);
  const normal=await (await post('list_passes',{},f.env)).json();assert.deepEqual(normal.records,[]);
  assert.deepEqual(f.learningStore.get('BUSN5000',TERM_ID,false),learning);assert.deepEqual(f.store.list('classnote',['BUSN5000']),notes);
  assert.deepEqual(f.store.list('progress',['BUSN5000']).records,[]);
});

test('HTTP PASS cannot overwrite an ordinary lecture or the operational protocol',async t=>{
  const f=passFixture(t);
  const make=(id)=>f.store.mutate({kind:'classnote',course:'BUSN5000',body:{session_id:'ordinary-'+id,title:'Original',date:'2026-10-31',text:'Original facts'},
    new_record_id:id,operation_id:'create-'+id,fingerprint:id,at:'2026-10-31T00:00:00.000Z',at_local:'Fixture'}).recorded;
  const lecture=make('lecture-record'),protocol=make(PASS_PROTOCOL_RECORD_ID);
  for(const row of [lecture,protocol]) {
    const response=await post('save_pass',passPacket({record_id:row.record_id,expected_revision:1}),f.env);
    assert.equal(response.status,404);assert.equal(f.store.history(row.record_id).history.length,1);
  }
});

test('HTTP PASS routing considers all facts and refuses conflicting primary class evidence',async t=>{
  const f=passFixture(t);
  const unknown=await (await post('save_pass',passPacket({title:'File check',facts:[{basis:'source',text:'The guide gives the filename.',source:'BUSN3040 guide'}]}),f.env)).json();
  assert.equal(unknown.error,'pass_course_conflict');
  const inferred=await (await post('save_pass',passPacket({course:undefined,title:'File check',facts:[{basis:'source',text:'The guide gives the filename.',source:'BUSN3040 guide'}]}),f.env)).json();
  assert.equal(inferred.recorded.course,'BUSN3040');
  const ambiguous=await (await post('save_pass',passPacket({course:undefined,context:'MGMT4280 session'}),f.env)).json();
  assert.equal(ambiguous.error,'pass_course_ambiguous');
});

test('HTTP PASS rejects unsupported, oversized, subjective and credential-bearing packets',async t=>{
  const f=passFixture(t);
  for(const args of [passPacket({date:'2026-02-30'}),passPacket({expected_revision:true}),passPacket({unknown:'field'}),
    passPacket({facts:[{basis:'inferred',text:'A guess',source:'guess'}]}),passPacket({facts:[{basis:'observed',text:'The learner mastered SQL.',source:'fixture'}]}),
    passPacket({facts:[{basis:'observed',text:'sp1_'+'1'.repeat(64),source:'fixture'}]}),
    passPacket({facts:Array.from({length:9},()=>({basis:'observed',text:'x'.repeat(590),source:'fixture'}))})]) {
    const response=await post('save_pass',args,f.env);assert.equal(response.status,400);assert.ok((await response.json()).error);
  }
  assert.equal(f.store.health().counts.some(c=>c.kind==='classnote'),false);
});

test('HTTP PASS failure and mismatch keep the exact retry packet and never falsely confirm',async t=>{
  const f=passFixture(t),read=f.stub.passRead;
  let failRead=true;f.stub.passRead=async args=>{if(args.record_id&&failRead){failRead=false;throw Error('fixture outage');}return read(args);};
  const first=await (await post('save_pass',passPacket(),f.env)).json();
  assert.equal(first.error,'pass_write_unconfirmed');assert.ok(first.retry_arguments);
  const again=await (await post('save_pass',first.retry_arguments,f.env)).json();assert.equal(again.replayed,true);assert.equal(again.save_confirmation,'confirmed');
  f.stub.passRead=async args=>{const value=await read(args);return value.record?{...value,record:{...value.record,text:'mismatch'}}:value;};
  const mismatch=await (await post('save_pass',passPacket(),f.env)).json();assert.equal(mismatch.error,'pass_readback_mismatch');
  assert.equal(f.store.history(again.recorded.record_id).history.length,1);
});

test('material tools issue only bounded original library GETs and enforce exact source course',async()=>{
  const calls=[];let folder='BUSN 5000/Slides';
  const reader=async path=>{calls.push(path);return Response.json(path.startsWith('/library?')?{course:'BUSN5000',documents:[{doc_id:'fixture',title:'Guide'}]}:
    {document:{doc_id:'fixture',folder,title:'Guide'},text:'x'.repeat(5000),truncated:false,source:'sweep_extraction',text_sha256:'fixture-hash'});};
  const list=await executeMaterialTool('search_school_materials',{course:'BUSN5000',q:'Guide'},reader);assert.equal(list.ok,true);
  const read=await executeMaterialTool('read_school_material',{course:'BUSN5000',doc_id:'fixture',start:2000,limit:1000},reader);
  assert.equal(read.ok,true);assert.equal(read.text.length,1000);assert.equal(read.next_start,3000);assert.equal(read.text_sha256,'fixture-hash');
  folder='MGMT 4280/Slides';const wrong=await executeMaterialTool('read_school_material',{course:'BUSN5000',doc_id:'fixture'},reader);assert.equal(wrong.error,'material_course_mismatch');assert.equal(wrong.text,undefined);
  assert.ok(calls.every(p=>p.startsWith('/library?')||p.startsWith('/library/doc?')));
  const before=calls.length;
  for(const [name,args] of [['fetch_url',{url:'https://example.invalid'}],['read_school_material',{course:'BUSN5000',doc_id:'fixture',start:120000}],['search_school_materials',{course:'GENERAL'}]])assert.ok((await executeMaterialTool(name,args,reader)).error);
  assert.equal(calls.length,before);
});

test('six PASS instruction additions preserve course policies and fit the native editor limit',()=>{
  for(const course of COURSES) {
    const source=readFileSync(new URL('../gpt-instructions-teaching-'+course.code.toLowerCase()+'-merged.md',import.meta.url),'utf8');
    assert.ok([...source].length<=8000,course.code);assert.match(source,/Open: getPassProtocol; resumePass/);assert.match(source,/no learning\/progress changes/);assert.match(source,/Hypotheses are never facts/);
    assert.match(source,/ASSESSMENT POLICY/);assert.match(source,/Never write another course's learning/);assert.match(source,/expected_revision/);
  }
});
