import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import worker from '../src/worker.js';
import {sqliteFoundation} from './sqlite-fixture.js';
import {ClubStore} from '../src/clubs-store.js';
import {RetryStore} from '../src/retry-store.js';
import {CLOUD_KEY,LOCAL_KEY,LOCAL_SERVICES} from '../src/system-health.js';
const require=createRequire(import.meta.url),{chromium}=require('/Users/Daksh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const f=sqliteFoundation(),clubs=new ClubStore(f.storage),retries=new RetryStore(f.storage);
Object.assign(f.stub,{clubOverview:async()=>clubs.overview(),clubGet:async(...a)=>clubs.get(...a),clubSearch:async(...a)=>clubs.search(...a),retryList:async()=>retries.list(),retryRequest:async(...a)=>retries.request(...a),retryClaim:async()=>retries.claim(),retryFinish:async(...a)=>retries.finish(...a)});
const at=new Date().toISOString(),hash='a'.repeat(64),sid='11111111-1111-4111-a111-111111111111';
for(let i=0;i<23;i++)clubs.put('session',i===0?sid:'22222222-2222-4222-a222-'+String(i).padStart(12,'0'),{session_id:i===0?sid:'22222222-2222-4222-a222-'+String(i).padStart(12,'0'),title:i===0?'Joint workshop':'AI workshop '+i,created_at:at,clubs:i===0?['ai-society','openai-uga']:['ai-society'],transcript:'Speaker [0:00]: We built an internship tracker.\n'.repeat(20)},hash,0,at);
clubs.put('meta','sync',{checked_at:at,groupme_checked_at:at,bridge_verified_at:at,bundle_generated_at:at,bundle_sha256:hash,raw_coverage_complete:true,groupme_coverage_complete:true,events:[{title:'Builder night',date:'2099-09-20',source_group:'106159597',source_message:'fixture',calendar_event_id:'fixture'},{title:'Past workshop',date:'2020-01-01',source_group:'117284689',source_message:'past'}]},hash,0,at);
const evidence=(outcome)=>({outcome,last_attempt_at:at,last_success_at:outcome==='healthy'?at:null,detail:'Synthetic preview result.'});
const kv=new Map([[CLOUD_KEY,JSON.stringify({checked_at:at,checks:{'elc-feed':evidence('healthy'),'google-feed':evidence('healthy'),'drive-api':evidence('healthy')}})],[LOCAL_KEY,JSON.stringify({received_at:at,checks:Object.fromEntries(Object.keys(LOCAL_SERVICES).map(id=>[id,evidence(id==='grade-check'?'failed':'healthy')]))})]]);
const env={API_KEY:'fixture-only',BRIDGE_STATE:f.binding,NOTES:{get:async k=>kv.get(k)||null,put:async(k,v)=>kv.set(k,v)}};
const ctx={waitUntil:p=>p.catch(()=>{})};
const server=createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const r=await worker.fetch(new Request('http://127.0.0.1'+req.url,{method:req.method,headers:req.headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})}),env,ctx);res.writeHead(r.status,Object.fromEntries(r.headers));res.end(await r.text());}catch(e){res.writeHead(500);res.end('fixture error');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const out=process.env.QA_OUTPUT||'/Users/Daksh/Documents/Codex/2026-09-17/can-x20-2/work/qa';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{
for(const [name,size] of [['desktop',{width:1512,height:1100}],['mobile',{width:390,height:844}]]){
 const c=await browser.newContext({viewport:size,extraHTTPHeaders:{Authorization:'Bearer fixture-only'},permissions:['clipboard-read','clipboard-write']});const p=await c.newPage();p.setDefaultTimeout(12000);const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto(origin+'/app/system');await p.locator('#node-bridge').waitFor();assert.equal(await p.locator('.map-retry').count(),28);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.equal(await p.locator('#node-grade-check').getAttribute('data-state'),'failed');
 await p.locator('#motion').click();assert.equal(await p.locator('body').evaluate(el=>el.classList.contains('motion-paused')),true);
 await p.locator('#listmode').click();if(name==='mobile')retries.sql.exec('DELETE FROM system_retries');await p.locator('.card-retry[data-retry="board-refresh"]').click();await p.waitForFunction(()=>document.querySelector('#retry-result').textContent.includes('Waiting for this Mac'));
 assert.equal(await p.locator('#retry-action').isDisabled(),true);await p.locator('#close-inspector').click();
 await p.locator('#search').fill('Codex');assert.equal(await p.locator('.service-entry:visible').count(),1);await p.locator('.card-retry[data-retry="codex"]').click();assert.match(await p.locator('#retry-description').textContent(),/no automatic retry/);await p.locator('#close-inspector').click();await p.locator('#search').fill('');
 await p.locator('#mapmode').click();await p.locator('#fit').click();await p.screenshot({path:out+'/map-'+name+'.png',fullPage:true});
 await p.goto(origin+'/app/clubs');await p.locator('.club-card').first().waitFor();assert.equal(await p.locator('.meeting').count(),23);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await p.locator('#query').fill('internship');await p.locator('#search-button').click();await p.locator('.result').first().waitFor();assert.equal(await p.locator('.result').count(),20);await p.locator('#more-results').click();await p.waitForFunction(()=>document.querySelectorAll('.result').length===23);
 await p.locator('#club-filter').selectOption('openai-uga');await p.waitForFunction(()=>document.querySelectorAll('.result').length===1);assert.equal(await p.locator('.meeting').count(),1);
 await p.locator('.result button').click();await p.waitForFunction(()=>document.querySelector('#reader-title').textContent==='Joint workshop');await p.locator('#copy-transcript').click();await p.waitForFunction(()=>document.querySelector('#reader-feedback').textContent);assert.equal(await p.locator('#reader-feedback').textContent(),'Copied.');const copied=await p.evaluate(()=>navigator.clipboard.readText());assert.match(copied,/Joint workshop\n/);
 const download=p.waitForEvent('download');await p.locator('#download-transcript').click();assert.equal((await download).suggestedFilename(),'Joint workshop.txt');
 await p.locator('#copy-link').click();await p.waitForFunction(async()=> (await navigator.clipboard.readText()).includes('#meeting='));assert.match(await p.evaluate(()=>navigator.clipboard.readText()),/#meeting=/);
 await p.locator('#close-reader').click();assert.equal(await p.locator('#reader').isVisible(),false);await p.locator('#clear-search').click();await p.locator('#club-filter').selectOption('');assert.equal(await p.locator('#events li').count(),1);await p.locator('#past-events').check();assert.equal(await p.locator('#events li').count(),2);
 await p.locator('#retry-sync').click();await p.waitForFunction(()=>document.querySelector('#retry-feedback').textContent.includes('Waiting for this Mac'));assert.equal(await p.locator('#retry-sync').isDisabled(),true);await p.screenshot({path:out+'/clubs-'+name+'.png',fullPage:true});assert.deepEqual(errors,[]);await c.close();console.log(name+': map retries, filters, motion, clubs search, pagination, reader, copy, download, events, queue passed');
}
 const c=await browser.newContext({viewport:{width:1200,height:900},reducedMotion:'reduce',extraHTTPHeaders:{Authorization:'Bearer fixture-only'}});const p=await c.newPage();await p.goto(origin+'/app/system');await p.locator('.wire.healthy').first().waitFor();assert.equal(await p.locator('.wire.healthy').first().evaluate(e=>getComputedStyle(e).animationName),'none');await c.close();console.log('Reduced motion passed');
}finally{await browser.close();server.close();f.close();}
