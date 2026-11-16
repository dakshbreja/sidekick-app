// Synthetic localhost-only preview. Never reads credentials or calls production.
import {createServer} from 'node:http';
import {appHtml} from '../src/app.js';
import {sectionFixture} from '../test/dashboard-fixtures.mjs';
let scenario='healthy',reads=0,rejectedWrites=0;
const qa='<div style="background:#e6d49a;color:#252218;padding:6px 12px;font:11px sans-serif">LOCAL QA · synthetic data <select id="qa-scenario" aria-label="Preview scenario"><option>healthy</option><option>degraded</option><option>offline</option><option>expired</option><option>empty</option></select></div>';
const control='<script>document.getElementById("qa-scenario").onchange=async e=>{await fetch("/__qa/"+e.target.value,{method:"POST"});document.getElementById("refresh").click();};</script>';
const server=createServer((req,res)=>{
  const json=(code,value)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  if(req.url.startsWith('/__qa/')&&req.method==='POST'){
    const next=req.url.slice(6);if(!['healthy','degraded','offline','expired','empty'].includes(next))return json(400,{error:'invalid scenario'});
    scenario=next;return json(200,{ok:true});
  }
  if(req.url==='/__qa-stats')return json(200,{reads,rejectedWrites});
  if(req.url==='/status'){
    reads++;
    if(scenario==='offline'||scenario==='expired')return json(scenario==='expired'?401:503,{error:scenario==='expired'?'unauthorized':'Preview connection unavailable'});
    const d=sectionFixture();
    if(scenario==='degraded'){d.feed_health[0].ok=false;d.actionable.coverage.feeds_status='degraded';d.data_warning='One calendar failed. This list may be incomplete.';}
    if(scenario==='empty'){
      for(const key of ['overdue','due_today','due_this_week','other_courses_this_week','upcoming','classes_today','optional_this_week','optional_ongoing','recent_changes','progress','identity_review'])d[key]=[];
      d.progress_summary={done:0};d.actionable.outstanding=[];d.actionable.awaiting_verification=[];
      for(const key of Object.keys(d.actionable.counts))d.actionable.counts[key]=0;
    }
    return json(200,d);
  }
  if(req.method==='POST'){rejectedWrites++;return json(405,{error:'Preview never saves coursework'});}
  if(req.url==='/app'||req.url==='/'){
    res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});
    res.end(appHtml().replace('<body>','<body>'+qa).replace('</body>',control+'</body>'));return;
  }
  res.writeHead(404);res.end('Local preview only');
});
server.listen(8790,'127.0.0.1',()=>console.log('Synthetic dashboard preview: http://127.0.0.1:8790/app'));
