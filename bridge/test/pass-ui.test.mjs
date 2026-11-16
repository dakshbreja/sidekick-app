import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {appHtml} from '../src/app.js';
import {PASS_VIEW_JS} from '../src/pass-view.js';
import {COURSES,resolveCourse} from '../src/courses.js';

const catalog={ok:true,term_id:'fall-2026',timezone:'America/New_York',courses:COURSES.map(({code,label,title})=>({code,label,title}))};
const fixture=(id,extra={})=>({record_id:id,revision:1,course:'BUSN5000',term_id:'fall-2026',session_id:'pass:fixture-'+id,date:'2026-11-02',title:'Fixture '+id,at:'2026-11-03T05:00:00.000Z',...extra});
const plain=x=>JSON.parse(JSON.stringify(x));
function harness(respond=()=>({ok:true,term_id:'fall-2026',records:[],next_cursor:null})){
  const nodes=new Map(),calls=[],location={hash:'#pass'},document={querySelector(s){if(!nodes.has(s))nodes.set(s,{innerHTML:'',textContent:'',hidden:false,setAttribute(){},focus(){},scrollIntoView(){}});return nodes.get(s);}};
  const context=vm.createContext({URL,URLSearchParams,Date,Intl,document,location,TAB:'pass',NEED_AUTH:false,renderNotice(){},$:s=>document.querySelector(s),
    api:async path=>{calls.push(path);return plain(path==='/pass/courses'?catalog:await respond(path));}});
  vm.runInContext(PASS_VIEW_JS+';this.ui={PASS,passHref,passInline,passMarkdown,passHash,passRoute,passCourse,passValid,renderPass,loadPassRoute,loadOlderPass,readPassDetail};',context);
  context.ui.PASS.catalog=plain(catalog);
  return {ui:context.ui,nodes,calls,location,context};
}

test('PASS is discoverable in the authenticated dashboard and independent of calendar loading',()=>{
  const html=appHtml();assert.match(html,/id="tab-pass"[^>]*role="tab"/);assert.match(html,/data-tab="pass"/);
  assert.match(html,/if\(TAB==='pass'\)\{renderPass\(\);return;/);
  assert.match(html,/if\(TAB!=='pass'\)load\(\)/);
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];new vm.Script(script);
  assert.doesNotMatch(PASS_VIEW_JS,/method:\s*['"]POST|save_pass|\/classnote|\/progress/);
});
test('the UI uses the same course aliases and explicit semester as the read API',async()=>{
  const {ui,location,calls,nodes}=harness();
  for(const input of ['BUSN5000','busn 5000','5000','MGMT 4280','3040'])assert.equal(ui.passCourse(input),resolveCourse(input).code);
  assert.throws(()=>ui.passCourse('not-a-course'),/Unknown course/);
  location.hash='#pass?course=busn%205000';await ui.loadPassRoute();assert.equal(ui.PASS.course,'BUSN5000');
  assert.match(calls[0],/course=BUSN5000/);assert.match(nodes.get('#body').innerHTML,/fall-2026/);
  assert.match(nodes.get('#body').innerHTML,/All courses/);assert.match(nodes.get('#body').innerHTML,/BUSN 5000/);
});
test('all-courses view has no implicit course filter; tests are hidden by default',async()=>{
  const {ui,calls,nodes}=harness();await ui.loadPassRoute();
  const q=new URL('https://fixture.test'+calls[0]);assert.equal(q.searchParams.has('course'),false);assert.equal(q.searchParams.get('sandbox'),'false');assert.equal(q.searchParams.get('limit'),'20');
  assert.match(nodes.get('#body').innerHTML,/Real sessions|tests hidden/);assert.match(nodes.get('#body').innerHTML,/No saved real PASS/);
});
test('newest-first pages retain every entry and stable record IDs without a preview cap',async()=>{
  const rows=Array.from({length:23},(_,i)=>fixture('r'+i,{at:new Date(Date.UTC(2026,10,3,5,0,23-i)).toISOString()}));
  const cursor=JSON.stringify([rows[19].at,rows[19].record_id]);
  const {ui,calls,nodes}=harness(path=>new URL('https://fixture.test'+path).searchParams.has('cursor')
    ?{ok:true,term_id:'fall-2026',records:rows.slice(20),next_cursor:null}:{ok:true,term_id:'fall-2026',records:rows.slice(0,20),next_cursor:cursor});
  await ui.loadPassRoute();assert.equal(ui.PASS.records.length,20);assert.match(nodes.get('#body').innerHTML,/Load older PASS/);
  await ui.loadOlderPass();assert.deepEqual(plain(ui.PASS.records).map(r=>r.record_id),rows.map(r=>r.record_id));
  assert.equal(new URL('https://fixture.test'+calls[1]).searchParams.get('cursor'),cursor);
  const html=nodes.get('#body').innerHTML;assert.ok(html.indexOf('Fixture r0')<html.indexOf('Fixture r22'));assert.doesNotMatch(html,/data-pass-older/);
  for(const label of ['Date','Session ID','Record ID','Revision','Saved'])assert.match(html,new RegExp('<dt>'+label+'</dt>'));
  assert.match(html,/EST/);assert.match(html,/<time datetime=/);
});
test('clickable history links read exact content without a raw-JSON navigation',async()=>{
  const r=fixture('chosen',{text:'# Saved handoff\n\n**Actual response**\n\n- source fact\n\n[Original](https://example.test/source)'});
  const {ui,location,nodes,calls}=harness(path=>path.includes('record_id=')?{ok:true,record:r}:{ok:true,term_id:'fall-2026',records:[r],next_cursor:null});
  location.hash=ui.passHash('BUSN5000',false,'chosen');await ui.loadPassRoute();
  assert.ok(calls.some(p=>p.includes('record_id=chosen')&&p.includes('course=BUSN5000')));assert.equal(ui.PASS.record.text,r.text);
  const html=nodes.get('#body').innerHTML;assert.match(html,/<h1>Saved handoff<\/h1>/);assert.match(html,/<strong>Actual response<\/strong>/);assert.match(html,/<li>source fact<\/li>/);assert.match(html,/Back to PASS list/);
  assert.match(html,/id="pass-record-title" tabindex="-1"/);assert.doesNotMatch(html,/href="\/progress\/history|href="\/pass\?/);
});
test('real/test, course, semester and protocol mismatches never render another scope',async()=>{
  for(const row of [fixture('test',{session_id:'pass:test:fixture'}),fixture('term',{term_id:'spring-2026'}),fixture('course',{course:'MGMT4280'}),fixture('e2e2536a-83b9-460f-991b-3f86fd87542a')]){
    const {ui,location,nodes}=harness(()=>({ok:true,term_id:'fall-2026',records:[row],next_cursor:null}));location.hash='#pass?course=BUSN5000';await ui.loadPassRoute();
    assert.match(ui.PASS.error,/did not match/);assert.doesNotMatch(nodes.get('#body').innerHTML,/No saved real PASS|class="pass-row"/);
  }
});
test('sandbox mode is explicit, labelled and separate from the real list',async()=>{
  const r=fixture('test',{session_id:'pass:test:fixture'});const {ui,location,nodes,calls}=harness(()=>({ok:true,term_id:'fall-2026',records:[r],next_cursor:null}));
  location.hash='#pass?course=BUSN5000&sandbox=true';await ui.loadPassRoute();assert.match(calls[0],/sandbox=true/);assert.match(nodes.get('#body').innerHTML,/SYNTHETIC TEST RECORDS|Sandbox \/ test/);assert.equal(ui.PASS.sandbox,true);
});
test('loading, outage, signed-out, empty and unavailable record states stay distinct',async()=>{
  let release;const {ui,nodes}=harness(()=>new Promise(resolve=>{release=resolve;}));const running=ui.loadPassRoute();assert.match(nodes.get('#body').innerHTML,/Loading saved PASS/);release({term_id:'fall-2026',records:[],next_cursor:null});await running;assert.match(nodes.get('#body').innerHTML,/Unsaved work is unknown/);
  for(const status of [401,503]){const f=harness(()=>{throw Object.assign(Error('unavailable'),{status});});await f.ui.loadPassRoute();assert.ok(f.ui.PASS.error);assert.doesNotMatch(f.nodes.get('#body').innerHTML,/No saved real PASS/);}
  const f=harness(path=>{if(path.includes('record_id'))throw Object.assign(Error('pass_not_found'),{status:404});return {term_id:'fall-2026',records:[],next_cursor:null};});f.location.hash='#pass?record=missing';await f.ui.loadPassRoute();assert.equal(f.ui.PASS.record,null);assert.match(f.nodes.get('#body').innerHTML,/Retry opening/);
});
test('late responses cannot leak an old course or selected record after navigation',async()=>{
  let resolveOld;const f=harness(path=>new URL('https://fixture.test'+path).searchParams.get('course')==='BUSN5000'?new Promise(resolve=>{resolveOld=resolve;}):{term_id:'fall-2026',records:[fixture('mgmt',{course:'MGMT4280'})],next_cursor:null});
  f.location.hash='#pass?course=BUSN5000';const old=f.ui.loadPassRoute();f.location.hash='#pass?course=MGMT4280';await f.ui.loadPassRoute();resolveOld({term_id:'fall-2026',records:[fixture('old')],next_cursor:null});await old;
  assert.equal(f.ui.PASS.course,'MGMT4280');assert.deepEqual(plain(f.ui.PASS.records).map(r=>r.record_id),['mgmt']);assert.doesNotMatch(f.nodes.get('#body').innerHTML,/Fixture old/);
});
test('invalid route values fail visibly instead of silently choosing another scope',async()=>{
  for(const hash of ['#pass?sandbox=yes','#pass?sandbox=true&sandbox=false','#pass?course=BUSN5000&course=MGMT4280','#pass?term=spring']){const f=harness();f.location.hash=hash;await f.ui.loadPassRoute();assert.match(f.ui.PASS.error,/Invalid PASS/);assert.equal(f.calls.length,0);}
});
test('Markdown supports headings, emphasis, lists, quotes, tables and fenced code as inert content',()=>{
  const {ui}=harness(),md='# Heading\n\n**Bold** and *italic* and `code`\n\n1. one\n2. two\n\n> quoted\n\n| A | B |\n| --- | --- |\n| one | two |\n\n```html\n<script>alert(1)</script>\n```';
  const html=ui.passMarkdown(md);for(const tag of ['h1','strong','em','code','ol','li','blockquote','table','th','td','pre'])assert.match(html,new RegExp('<'+tag+'[ >]'));
  assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);assert.doesNotThrow(()=>ui.passMarkdown('>'.repeat(4000)+' nested'));
});
test('XSS payloads, unsafe links, images, attributes and metadata remain inert',()=>{
  const {ui,nodes}=harness();
  const attacks=['<script>alert(1)</script>','<img src=x onerror=alert(1)>','<svg/onload=alert(1)>','[x](javascript:alert(1))','[x](data:text/html,boom)','[x](jav&#x61;script:boom)','[x](https://example.test/\"onmouseover=boom)','![x](https://tracker.test/image)','<a href="javascript:alert(1)">x</a>','[x](//example.test/x)','[x](https:\\example.test/x)'];
  for(const text of attacks){const html=ui.passMarkdown(text);assert.doesNotMatch(html,/<(?:script|img|svg|iframe)\b|<[^>]+\son(?:error|load|mouseover)\s*=/i);assert.doesNotMatch(html,/href="(?:javascript|data|\/\/)/i);}
  assert.equal(ui.passHref('https://example.test/\njavascript:boom'),null);assert.equal(ui.passHref('https://user:secret@example.test/'),null);
  const html=ui.passMarkdown('[safe](https://example.test/?q=%22)');assert.match(html,/rel="noopener noreferrer"/);assert.match(html,/href="https:\/\/example.test/);
  ui.PASS.records=[fixture('unsafe',{title:'<img src=x onerror=boom>',session_id:'pass:<svg/onload=boom>'})];ui.renderPass();assert.doesNotMatch(nodes.get('#body').innerHTML,/<img|<svg/);assert.match(nodes.get('#body').innerHTML,/&lt;img/);
});

function appHarness(hash,respond){
  const nodes=new Map(),events=new Map(),requests=[],location={hash},storage={getItem(){return null;},setItem(){}};
  const node=s=>{if(!nodes.has(s))nodes.set(s,{innerHTML:'',textContent:'',value:'',hidden:false,offsetHeight:40,offsetTop:0,setAttribute(){},addEventListener(name,fn){events.set(s+':'+name,fn);},focus(){},scrollIntoView(){}});return nodes.get(s);};
  const document={querySelector:node,querySelectorAll(){return [];},addEventListener(name,fn){events.set('document:'+name,fn);}};
  const context=vm.createContext({document,location,URL,URLSearchParams,Intl,Date,AbortSignal,crypto:{randomUUID:()=> 'offline-fixture'},sessionStorage:storage,localStorage:storage,
    setTimeout(){return 1;},clearTimeout(){},matchMedia:()=>({matches:true}),history:{pushState(_a,_b,url){location.hash=url;}},
    window:{scrollY:0,addEventListener(name,fn){events.set('window:'+name,fn);}},
    fetch:async path=>{requests.push(path);const body=path==='/pass/courses'?catalog:await respond(path);return new Response(JSON.stringify(body));}});
  const script=appHtml().match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script+';this.ui={PASS,switchTab,render,itemRow,loadPassRoute};',context);
  return {context,ui:context.ui,nodes,events,requests,location};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('full dashboard startup, course filter, all-courses, selected record and Back use GETs only',async()=>{
  const real=fixture('actual',{text:'# Readable fixture\n\nActual saved facts.'});
  const f=appHarness('#pass?course=BUSN%205000',path=>path.includes('record_id=')?{ok:true,record:real}:{ok:true,term_id:'fall-2026',records:[real],next_cursor:null});
  await settle();assert.equal(f.ui.PASS.course,'BUSN5000');assert.match(f.nodes.get('#body').innerHTML,/Fixture actual/);assert.equal(f.requests.some(p=>p.startsWith('/status')),false);
  f.context.document.querySelector('#pass-course').value='';f.context.document.querySelector('#pass-sandbox').value='false';f.events.get('document:change')({target:{id:'pass-course'}});assert.equal(f.location.hash,'#pass');f.events.get('window:hashchange')();await settle();assert.equal(f.ui.PASS.course,'');
  f.location.hash='#pass?record=actual';f.events.get('window:hashchange')();await settle();assert.match(f.nodes.get('#body').innerHTML,/<h1>Readable fixture<\/h1>/);
  f.location.hash='#pass';f.events.get('window:hashchange')();await settle();assert.equal(f.ui.PASS.record,null);assert.doesNotMatch(f.nodes.get('#body').innerHTML,/pass-markdown/);
  assert.match(f.ui.itemRow({course_code:'BUSN5000',course:'BUSN 5000',title:'Fixture deadline'},{noMark:true}),/href="#pass\?course=BUSN5000"/);
  assert.ok(f.requests.every(p=>p.startsWith('/pass')));
});
test('a late failed calendar request cannot replace an open PASS view',async()=>{
  let rejectStatus;
  const r=fixture('survives');const f=appHarness('',path=>path.startsWith('/status')?new Promise((_resolve,reject)=>{rejectStatus=reject;}):{term_id:'fall-2026',records:[r],next_cursor:null});
  f.ui.switchTab('pass');await settle();rejectStatus(Error('calendar unavailable'));await settle();
  assert.match(f.nodes.get('#body').innerHTML,/Fixture survives/);assert.doesNotMatch(f.nodes.get('#body').innerHTML,/Cannot load/);
});


test('PASS hides unrelated calendar staleness while preserving sign-in and pending-save recovery',async()=>{
  const f=appHarness('#pass',()=>({term_id:'fall-2026',records:[],next_cursor:null}));await settle();
  vm.runInContext('STALE=true;MESSAGE="Calendar unavailable";DATA={data_warning:"Calendar source warning"};PENDING={fixture:{body:{item:"Unsaved coursework report"},message:"Not yet saved"}};render();',f.context);
  const notice=f.nodes.get('#notice').innerHTML;assert.match(notice,/Unsaved coursework report|Retry same save/);assert.doesNotMatch(notice,/Saved snapshot|Calendar unavailable|Calendar source warning/);
  vm.runInContext('NEED_AUTH=true;render();',f.context);assert.match(f.nodes.get('#notice').innerHTML,/Sign in again/);
});
