import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import worker from '../src/worker.js';
import { systemHealth, LOCAL_SERVICES, CLOUD_KEY, LOCAL_KEY, PROBE_KEY } from '../src/system-health.js';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || '/Users/Daksh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const live=process.argv.find(x=>x.startsWith('--live='))?.slice(7);
const out=process.env.QA_OUTPUT || '/private/tmp/bridge-system-health.bYwbmL/qa';
mkdirSync(out,{recursive:true});
let origin, server, auth='Bearer fixture-only';
if(live){
  const allowed=['https://ijuh2yp6rf.example-subdomain.workers.dev','https://coursework.example-subdomain.workers.dev'];
  assert.ok(allowed.includes(live));
  const config=readFileSync('/Users/Daksh/Claude/school-system-suite/bridge/.env','utf8');
  const key=config.split('\n').find(x=>/^API_KEY=/.test(x)).slice(8).trim().replace(/^['"]|['"]$/g,'');
  auth='Bearer '+key;origin=live;
}else{
  const at=new Date().toISOString();
  const record=(outcome='healthy')=>({outcome,last_attempt_at:at,last_success_at:outcome==='healthy'?at:null,detail:'Local QA fixture'});
  const store=new Map([[CLOUD_KEY,JSON.stringify({checked_at:at,checks:{'elc-feed':record(),'google-feed':record()}})],[PROBE_KEY,JSON.stringify(record())],[LOCAL_KEY,JSON.stringify({received_at:at,checks:Object.fromEntries(Object.keys(LOCAL_SERVICES).map(id=>[id,record(id==='grade-check'?'degraded':id==='drive-sync-check'?'failed':'healthy')]))})]]);
  const env={API_KEY:'fixture-only',NOTES:{get:async k=>store.get(k)||null}};
  server=createServer(async(req,res)=>{try{const r=await worker.fetch(new Request('http://127.0.0.1'+req.url,{headers:req.headers}),env);res.writeHead(r.status,Object.fromEntries(r.headers));res.end(await r.text());}catch{res.writeHead(500);res.end('QA server failure');}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
}
const browser=await chromium.launch({headless:true,channel:'chrome'});
try {
  for(const [label,size] of [['desktop',{width:1512,height:1100}],['mobile',{width:390,height:844}]]){
    const context=await browser.newContext({viewport:size,extraHTTPHeaders:{Authorization:auth}});
    const page=await context.newPage();const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const response=await page.goto(origin+'/app/system');assert.equal(response.status(),200);
    await page.waitForSelector('#node-bridge',{state:'attached'});
    assert.equal(await page.locator('.node').count(),26);
    assert.equal(await page.locator('#notice').isVisible(),false);
    assert.equal(await page.locator('#node-codex').getAttribute('data-state'),'unknown');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'horizontal document overflow');
    await page.screenshot({path:out+'/'+(live?'live-':'local-')+label+'.png',fullPage:true});
    if(label==='desktop'){
      await page.locator('#node-grade-check').click();assert.equal(await page.locator('#detail-title').textContent(),'Grade collectors');
      const before=await page.locator('#zoomlabel').textContent();await page.locator('#zoomin').click();assert.notEqual(await page.locator('#zoomlabel').textContent(),before);
    }else{
      assert.equal(await page.locator('#list').isVisible(),true);
      await page.locator('#list [data-id="drive-sync-check"]').click();
      assert.equal(await page.locator('#detail-title').textContent(),'Drive desktop sync');
    }
    await page.locator('#search').fill('Codex');assert.equal(await page.locator('.node:visible').count(),label==='desktop'?1:0);
    assert.equal(await page.locator('#list button:not([hidden])').count(),1);
    await page.locator('#search').fill('');
    await page.route('**/system/health',route=>route.abort('internetdisconnected'));
    await page.locator('#refresh').click();await page.waitForSelector('#notice:not([hidden])');
    assert.equal(await page.locator('#node-bridge').getAttribute('data-state'),'stale');
    assert.equal(await page.locator('#node-codex').getAttribute('data-state'),'unknown');
    await page.screenshot({path:out+'/'+(live?'live-':'local-')+label+'-offline.png',fullPage:true});
    await page.unroute('**/system/health');await page.locator('#refresh').click();
    await page.waitForFunction(()=>document.querySelector('#notice').hidden);
    assert.equal(await page.locator('#node-bridge').getAttribute('data-state'),'healthy');
    await page.locator('#listmode').focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator('#list').isVisible(),true);
    assert.deepEqual(errors,[]);
    console.log(label+': auth, 26 nodes, responsive fit, selection, search, zoom/keyboard, outage and recovery passed');
    await context.close();
  }
}finally{await browser.close();if(server)await new Promise(r=>server.close(r));}



