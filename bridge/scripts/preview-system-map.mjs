// Local, synthetic UI fixtures only. No credentials, production requests or writes.
import {createServer} from 'node:http';
import {systemHtml} from '../src/system-page.js';
import {systemHealth,LOCAL_SERVICES,CLOUD_KEY,LOCAL_KEY,PROBE_KEY} from '../src/system-health.js';
let scenario='healthy';
const record=(at,outcome='healthy')=>({outcome,last_attempt_at:at,last_success_at:outcome==='healthy'?at:null,detail:'Synthetic local preview observation.'});
async function fixture(){
  const at=new Date().toISOString();
  const store=new Map([
    [CLOUD_KEY,{checked_at:at,checks:{'elc-feed':record(at),'google-feed':record(at),'drive-api':record(at)}}],
    [LOCAL_KEY,{received_at:at,checks:Object.fromEntries(Object.keys(LOCAL_SERVICES).map(id=>[id,record(at,id==='drive-sync-check'?'failed':id==='grade-check'?'degraded':'healthy')]))}],
    [PROBE_KEY,record(at)],
  ]);
  return systemHealth({BRIDGE_STATE:{getByName:()=>({health:async()=>({ready:true})})},NOTES:{get:async key=>store.has(key)?JSON.stringify(store.get(key)):null}});
}
const qa='<div style="padding:8px 20px;background:#3a264e;font:12px sans-serif;color:white">LOCAL PREVIEW · synthetic data only <button id="qa-offline">Simulate lost updates</button> <button id="qa-recover">Restore updates</button> <button id="qa-expired">Simulate expired sign-in</button></div>';
const control='<script>for(const [id,state] of [["qa-offline","offline"],["qa-recover","healthy"],["qa-expired","expired"]])document.getElementById(id).onclick=async()=>{await fetch("/__qa/"+state,{method:"POST"});document.getElementById("refresh").click();};</script>';
const server=createServer(async(req,res)=>{
  try{
    if(req.url.startsWith('/__qa/')&&req.method==='POST'){
      const next=req.url.slice(6);if(!['offline','healthy','expired'].includes(next)){res.writeHead(400);res.end();return;}
      scenario=next;res.writeHead(204);res.end();return;
    }
    if(req.url==='/system/health'){
      res.writeHead(scenario==='offline'?503:scenario==='expired'?401:200,{'content-type':'application/json','cache-control':'no-store'});
      res.end(JSON.stringify(scenario==='healthy'?await fixture():{error:scenario}));return;
    }
    if(req.url==='/app/system'||req.url==='/'){
      res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});
      res.end(systemHtml().replace('<body>','<body>'+qa).replace('</body>',control+'</body>'));return;
    }
    res.writeHead(404);res.end('Local preview only');
  }catch{res.writeHead(500);res.end('Preview fixture failed');}
});
server.listen(Number(process.env.PORT||8789),'127.0.0.1',()=>console.log('Synthetic map preview: http://127.0.0.1:'+server.address().port+'/app/system'));
