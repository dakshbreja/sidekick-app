/** Read-only PASS presentation. All records stay in the original /pass store.
 * Browser source is literal so bundling cannot inject private helper names. */
export const PASS_VIEW_JS=String.raw`
const PASS={catalog:null,course:'',sandbox:false,records:[],next:null,record:null,recordId:'',
  loading:false,detailLoading:false,error:'',detailError:'',request:0,detailRequest:0,scope:'',checkedAt:0};
const passEscape=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
function passHref(value){
  if(!/^https?:\/\//i.test(value)||/[\s\u0000-\u001f\u007f\\]/.test(value))return null;
  try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}
}
// Only generated tags enter innerHTML. Raw HTML and images remain inert text;
// links must pass a protocol allowlist before their attributes are escaped.
function passInline(raw,depth=0){
  if(depth>5)return passEscape(raw);
  let out='',s=String(raw);
  while(s){
    let m;
    if((m=/^\x60+/.exec(s))){const end=s.indexOf(m[0],m[0].length);
      if(end>=0){out+='<code>'+passEscape(s.slice(m[0].length,end))+'</code>';s=s.slice(end+m[0].length);continue;}}
    if((m=/^!?\[([^\]\n]*)\]\(([^\s)]*)\)/.exec(s))){const href=passHref(m[2]);
      out+=s[0]==='!'?passEscape(m[1]):href?'<a href="'+passEscape(href)+'" target="_blank" rel="noopener noreferrer">'+passInline(m[1],depth+1)+'</a>':passEscape(m[1]+' ('+m[2]+')');
      s=s.slice(m[0].length);continue;}
    if((m=/^(\*\*|__)(?=\S)([\s\S]+?\S|\S)\1/.exec(s))){out+='<strong>'+passInline(m[2],depth+1)+'</strong>';s=s.slice(m[0].length);continue;}
    if((m=/^(\*|_)(?=\S)([^\n]+?\S|\S)\1/.exec(s))){out+='<em>'+passInline(m[2],depth+1)+'</em>';s=s.slice(m[0].length);continue;}
    out+=passEscape(s[0]);s=s.slice(1);
  }
  return out;
}
function passMarkdown(raw,depth=0){
  if(depth>8)return '<p>'+passEscape(raw)+'</p>';
  const lines=String(raw??'').replace(/\r\n?/g,'\n').split('\n');let out='',i=0;
  const special=s=>/^\s*$|^ {0,3}(#{1,6}\s|\x60{3,}|~{3,}|>|[-*+]\s|\d+[.)]\s|(?:[-*_]\s*){3,}$)/.test(s);
  const cells=s=>s.trim().replace(/^\||\|$/g,'').split('|').map(x=>x.trim());
  while(i<lines.length){const line=lines[i];let m;
    if(!line.trim()){i++;continue;}
    if((m=/^ {0,3}(\x60{3,}|~{3,})/.exec(line))){const fence=m[1];const code=[];i++;
      while(i<lines.length&&!new RegExp('^ {0,3}'+fence[0]+'{'+fence.length+',}\\s*$').test(lines[i]))code.push(lines[i++]);
      if(i<lines.length)i++;out+='<pre><code>'+passEscape(code.join('\n'))+'</code></pre>';continue;}
    if((m=/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line))){const n=m[1].length;out+='<h'+n+'>'+passInline(m[2])+'</h'+n+'>';i++;continue;}
    if(/^ {0,3}(?:[-*_]\s*){3,}$/.test(line)){out+='<hr>';i++;continue;}
    if(/^ {0,3}>/.test(line)){const quote=[];while(i<lines.length&&/^ {0,3}>/.test(lines[i]))quote.push(lines[i++].replace(/^ {0,3}>\s?/,''));out+='<blockquote>'+passMarkdown(quote.join('\n'),depth+1)+'</blockquote>';continue;}
    if((m=/^\s*([-*+]|\d+[.)])\s+(.+)/.exec(line))){const ordered=/\d/.test(m[1]),tag=ordered?'ol':'ul';out+='<'+tag+'>';while(i<lines.length&&(m=/^\s*([-*+]|\d+[.)])\s+(.+)/.exec(lines[i]))&&/\d/.test(m[1])===ordered){out+='<li>'+passInline(m[2])+'</li>';i++;}out+='</'+tag+'>';continue;}
    if(i+1<lines.length&&line.includes('|')&&/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i+1])){
      out+='<div class="pass-table"><table><thead><tr>'+cells(line).map(c=>'<th>'+passInline(c)+'</th>').join('')+'</tr></thead><tbody>';i+=2;
      while(i<lines.length&&lines[i].includes('|')&&lines[i].trim()){out+='<tr>'+cells(lines[i++]).map(c=>'<td>'+passInline(c)+'</td>').join('')+'</tr>';}
      out+='</tbody></table></div>';continue;}
    const para=[line];i++;while(i<lines.length&&!special(lines[i])){if(i+1<lines.length&&lines[i].includes('|')&&/^\s*\|?\s*:?-{3,}/.test(lines[i+1]))break;para.push(lines[i++]);}
    out+='<p>'+para.map(x=>passInline(x)).join('<br>')+'</p>';
  }
  return out;
}
function passHash(course='',sandbox=false,record=''){
  const q=new URLSearchParams();if(course)q.set('course',course);if(sandbox)q.set('sandbox','true');if(record)q.set('record',record);
  return '#pass'+(q.size?'?'+String(q):'');
}
function passRoute(){
  const q=new URLSearchParams(location.hash.slice(1).split('?').slice(1).join('?'));
  if([...q.keys()].some(k=>!['course','sandbox','record'].includes(k)||q.getAll(k).length!==1)||q.has('sandbox')&&!['false','true'].includes(q.get('sandbox')))throw Error('Invalid PASS view link. Choose PASS to start again.');
  return {course:q.get('course')||'',sandbox:q.get('sandbox')==='true',record:q.get('record')||''};
}
function passCourse(raw){
  if(!raw)return '';
  const n=raw.toUpperCase().replace(/[^A-Z0-9]/g,'');
  const exact=PASS.catalog.courses.find(c=>c.code===n);if(exact)return exact.code;
  const numeric=PASS.catalog.courses.filter(c=>c.code.endsWith(n));
  if(n&&numeric.length===1)return numeric[0].code;
  throw Error('Unknown course. Choose a course from the PASS filter.');
}
function passLabel(code){return PASS.catalog?.courses.find(c=>c.code===code)?.label||code||'All courses';}
function passSaved(at){
  if(!Number.isFinite(Date.parse(at)))return 'Saved time unavailable';
  return new Intl.DateTimeFormat('en-US',{timeZone:PASS.catalog?.timezone||'America/New_York',year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(new Date(at));
}
function passMeta(r){return '<dl class="pass-meta"><div><dt>Course</dt><dd>'+passEscape(passLabel(r.course))+'</dd></div><div><dt>Date</dt><dd>'+passEscape(r.date||'Not recorded')+
  '</dd></div><div><dt>Saved</dt><dd><time datetime="'+passEscape(r.at)+'">'+passEscape(passSaved(r.at))+
  '</time></dd></div></dl><details class="pass-ids"><summary>IDs</summary><dl class="pass-meta"><div><dt>Revision</dt><dd>'+passEscape(r.revision)+'</dd></div><div><dt>Session ID</dt><dd><code>'+passEscape(r.session_id)+'</code></dd></div><div><dt>Record ID</dt><dd><code>'+passEscape(r.record_id)+'</code></dd></div></dl></details>';}
function passValid(r){
  return r&&typeof r.record_id==='string'&&typeof r.session_id==='string'&&r.session_id.startsWith('pass:')&&
    r.record_id!=='e2e2536a-83b9-460f-991b-3f86fd87542a'&&r.term_id===PASS.catalog.term_id&&
    PASS.catalog.courses.some(c=>c.code===r.course)&&(!PASS.course||r.course===PASS.course)&&
    r.session_id.startsWith('pass:test:')===PASS.sandbox;
}
function passListQuery(cursor){
  const q=new URLSearchParams({sandbox:String(PASS.sandbox),limit:'20'});if(PASS.course)q.set('course',PASS.course);if(cursor)q.set('cursor',cursor);return '/pass?'+q;
}
async function loadPassRoute(force=false){
  const request=++PASS.request;++PASS.detailRequest;PASS.checkedAt=Date.now();
  let route;
  try{route=passRoute();}catch(e){PASS.error=e.message;PASS.loading=false;renderPass();return;}
  PASS.loading=true;PASS.error='';PASS.record=null;PASS.recordId=route.record;PASS.detailError='';PASS.detailLoading=!!route.record;renderPass();
  try{
    if(!PASS.catalog)PASS.catalog=await api('/pass/courses');
    if(request!==PASS.request)return;
    const course=passCourse(route.course),scope=course+'|'+route.sandbox;
    if(force||PASS.scope!==scope){PASS.records=[];PASS.next=null;PASS.scope=scope;}
    PASS.course=course;PASS.sandbox=route.sandbox;renderPass();
    const page=await api(passListQuery());
    if(request!==PASS.request)return;
    if(page.term_id!==PASS.catalog.term_id||!Array.isArray(page.records)||!page.records.every(passValid))throw Error('PASS history did not match the selected course, term or test scope.');
    PASS.records=page.records;PASS.next=page.next_cursor;PASS.loading=false;renderPass();
    if(route.record)await readPassDetail(route.record,request);
  }catch(e){if(request!==PASS.request)return;PASS.loading=false;PASS.detailLoading=false;PASS.error=passError(e);renderPass();}
}
function passError(e){return e.status===401?'Sign-in required. Your saved PASS records have not been changed.':e.message==='records_initializing'?'PASS history is temporarily unavailable while storage starts. Retry shortly.':e.message||'PASS history could not be loaded.';}
async function loadOlderPass(){
  if(PASS.loading||!PASS.next)return;
  const request=PASS.request,cursor=PASS.next;PASS.loading=true;PASS.error='';renderPass();
  try{const page=await api(passListQuery(cursor));if(request!==PASS.request)return;
    if(page.term_id!==PASS.catalog.term_id||!Array.isArray(page.records)||!page.records.every(passValid)||page.next_cursor===cursor)throw Error('PASS history returned an invalid page.');
    const ids=new Set(PASS.records.map(r=>r.record_id));PASS.records.push(...page.records.filter(r=>!ids.has(r.record_id)));PASS.next=page.next_cursor;
  }catch(e){if(request===PASS.request)PASS.error=passError(e);}finally{if(request===PASS.request){PASS.loading=false;renderPass();}}
}
async function readPassDetail(id,request=PASS.request){
  const detail=++PASS.detailRequest;PASS.record=null;PASS.recordId=id;PASS.detailLoading=true;PASS.detailError='';renderPass();
  try{const q=new URLSearchParams({record_id:id,sandbox:String(PASS.sandbox)});if(PASS.course)q.set('course',PASS.course);
    const data=await api('/pass?'+q);if(request!==PASS.request||detail!==PASS.detailRequest)return;
    if(!passValid(data.record)||data.record.record_id!==id||typeof data.record.text!=='string')throw Error('The PASS readback did not match this view.');
    PASS.record=data.record;
  }catch(e){if(request===PASS.request&&detail===PASS.detailRequest)PASS.detailError=passError(e);}
  finally{if(request===PASS.request&&detail===PASS.detailRequest){PASS.detailLoading=false;renderPass();if(TAB==='pass'&&PASS.record){const title=$('#pass-record-title');title?.focus?.({preventScroll:true});title?.scrollIntoView?.({block:'start'});}}}
}
function renderPass(){
  if(TAB!=='pass')return;
  renderNotice();
  $('#live').innerHTML='<span class="dot'+(PASS.error?' bad':'')+'"></span>PASS history · '+(PASS.loading?'loading saved records':PASS.error?'refresh needed':'read only');
  $('#dashboard-view').setAttribute('data-view','pass');$('#body').setAttribute('aria-labelledby','tab-pass');$('#overview').hidden=true;$('#kpis').innerHTML='';
  $('#view-intro').innerHTML='<div><div class="view-eyebrow">Saved session handoffs</div><h2 id="view-title">PASS history</h2><p class="view-description">Read saved sessions for a course or across all courses. No coursework or records are changed here.</p></div>';
  const p=passEscape;
  let html='<section class="panel pass-filters"><label>Course <select id="pass-course"><option value="">All courses</option>'+(PASS.catalog?.courses||[]).map(c=>'<option value="'+p(c.code)+'"'+(PASS.course===c.code?' selected':'')+'>'+p(c.label)+'</option>').join('')+'</select></label>'+
    '<label>Records <select id="pass-sandbox"><option value="false"'+(!PASS.sandbox?' selected':'')+'>Real sessions</option><option value="true"'+(PASS.sandbox?' selected':'')+'>Sandbox / tests only</option></select></label>'+
    '<button class="mark" data-pass-refresh'+(PASS.loading?' disabled':'')+'>Refresh PASS</button><p>'+p(PASS.catalog?.term_id||'Current semester')+' · newest saved first · '+(PASS.sandbox?'SYNTHETIC TEST RECORDS':'tests hidden')+'</p></section>';
  if(PASS.error)html+='<div class="panel pass-error" role="alert">'+p(PASS.error)+(NEED_AUTH?' <a href="/app/sign-in?returnTo=%2Fapp">Sign in again</a>.':'')+' <button class="mark" data-pass-refresh>Retry</button></div>';
  html+='<section class="panel" aria-busy="'+PASS.loading+'"><h2>'+p(passLabel(PASS.course))+' <span class="panel-count">'+PASS.records.length+(PASS.next?'+':'')+'</span></h2>';
  if(PASS.loading&&!PASS.records.length)html+='<p role="status">Loading saved PASS history…</p>';
  else if(!PASS.records.length&&!PASS.error)html+='<p class="empty">No saved '+(PASS.sandbox?'test':'real')+' PASS records for this view. Unsaved work is unknown.</p>';
  html+=PASS.records.map(r=>'<article class="pass-row"><h3><a href="'+p(passHash(PASS.course,PASS.sandbox,r.record_id))+'">'+p(r.title||'Untitled PASS')+'</a>'+(PASS.sandbox?' <span class="pass-test">Sandbox / test</span>':'')+'</h3>'+passMeta(r)+'</article>').join('');
  if(PASS.next)html+='<button class="mark" data-pass-older'+(PASS.loading?' disabled':'')+'>'+(PASS.loading?'Loading…':'Load older PASS records')+'</button>';
  html+='</section>';
  if(PASS.recordId){html+='<section class="panel pass-detail" aria-busy="'+PASS.detailLoading+'"><a href="'+p(passHash(PASS.course,PASS.sandbox))+'">← Back to PASS list</a>';
    if(PASS.detailLoading)html+='<p role="status">Opening saved PASS…</p>';
    else if(PASS.detailError)html+='<p role="alert">'+p(PASS.detailError)+'</p><button class="mark" data-pass-detail-retry>Retry opening</button>';
    else if(PASS.record)html+='<h2 id="pass-record-title" tabindex="-1">'+p(PASS.record.title||'Untitled PASS')+'</h2>'+(PASS.sandbox?'<p class="pass-test">Sandbox / test — no real coursework</p>':'')+passMeta(PASS.record)+'<div class="pass-markdown">'+passMarkdown(PASS.record.text)+'</div>';
    html+='</section>';}
  $('#body').innerHTML=html;
}
`;

export const passTheme=String.raw`
.pass-filters{display:flex;flex-wrap:wrap;align-items:end;gap:14px}.pass-filters label{display:grid;gap:5px;font-size:12px}
.pass-filters select{font:inherit;padding:8px;border:1px solid var(--rule2);border-radius:5px;background:var(--card);color:var(--ink)}
.pass-filters p{flex-basis:100%;font-size:12px;color:var(--muted);margin:0}.pass-row{padding:16px 0;border-top:1px solid var(--rule)}
.pass-row h3{font-size:15px;margin:0 0 10px}.pass-row a,.pass-detail a{color:#25658a}.pass-meta{font-size:12px;display:flex;flex-wrap:wrap;gap:8px 22px;margin:8px 0 16px}
.pass-meta>div{min-width:100px;max-width:100%}.pass-meta dt{color:var(--muted);font-size:10px}.pass-meta dd{margin:2px 0;overflow-wrap:anywhere}
.pass-meta code{font-size:11px}.pass-test{font-size:11px;background:#fff0c9;color:#754900;padding:3px 5px;border-radius:4px}.pass-error{color:var(--crit)}
#pass-record-title{scroll-margin-top:75px}
.pass-markdown{line-height:1.65;overflow-wrap:anywhere;border-top:1px solid var(--rule);padding-top:16px}.pass-markdown h1{font-size:24px}.pass-markdown h2{font-size:20px;letter-spacing:0;text-transform:none;display:block}.pass-markdown h3{font-size:17px}
.pass-markdown pre{overflow:auto;white-space:pre;padding:14px;background:var(--sunk);border:1px solid var(--rule);border-radius:6px}.pass-markdown code{background:var(--sunk);padding:1px 3px}
.pass-markdown blockquote{border-left:3px solid var(--rule2);padding-left:14px;margin-left:0;color:var(--ink2)}.pass-markdown a{color:#25658a}.pass-table{overflow:auto}.pass-table th,.pass-table td{border:1px solid var(--rule);padding:8px}.pass-table table{border-collapse:collapse}
@media(max-width:650px){.tabs .tab{flex:0 0 auto;padding:10px 9px}.pass-filters label{max-width:100%}.pass-filters select{max-width:100%}}
`;
