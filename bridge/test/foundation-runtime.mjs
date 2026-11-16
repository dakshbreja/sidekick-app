// Actual workerd + SQLite + native browser round trips, entirely synthetic/local.
// Run with node test/foundation-runtime.mjs. Never imports real .env or feeds.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const deps=process.env.BRIDGE_TEST_DEPS || '/Users/Daksh/.npm/_npx/32026684e21afda6/node_modules';
const {build}=require(deps+'/esbuild');
const {Miniflare,convertV4MiniflareOptions}=require(deps+'/miniflare');
const {chromium}=require('/Users/Daksh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const bundle=await build({entryPoints:['test/runtime-entry.js'],bundle:true,write:false,format:'esm',platform:'neutral',external:['cloudflare:workers']});
const date=new Date(Date.now()+86400000).toISOString().replace(/[-:]/g,'').replace(/\.\d+Z/,'Z');
let title='Runtime assignment',uid='runtime-one',htmlFeed=false;
const ics=()=> 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:'+uid+'\nDTSTART:'+date+'\nSUMMARY:'+title+'\nEND:VEVENT\nEND:VCALENDAR';
const mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,cf:false,workers:[{name:'foundation-fixture',modules:true,script:bundle.outputFiles[0].text,
  compatibilityDate:'2026-08-19',
  bindings:{API_KEY:'runtime-fixture-key',FEED_PERSONAL:'https://fixture.invalid/calendar'},
  kvNamespaces:{NOTES:'fixture-notes'},durableObjects:{BRIDGE_STATE:{className:'FixtureBridgeState',useSQLite:true}},
  outboundService:async request=> {
    assert.equal(new URL(request.url).hostname,'fixture.invalid','No external network access allowed');
    return new Response(htmlFeed?'<html>Login</html>':ics());
  }
}]}));
let browser;
try {
  const origin=(await mf.ready).origin;
  const api=async(path,body,headers={})=>{
    const r=await mf.dispatchFetch(origin+path,{method:body===undefined?'GET':'POST',
      headers:{Authorization:'Bearer runtime-fixture-key','Content-Type':'application/json',...headers},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await r.json();return {status:r.status,data};
  };
  assert.equal((await api('/progress?course=GENERAL')).status,503);
  await api('/__test/prepare');
  const maintenance={'X-Bridge-Maintenance':'foundation-v1'};
  const preview=await api('/foundation/migration/preview',undefined,maintenance);
  assert.equal((await api('/foundation/migration/initialize',{expected_digest:'wrong'},maintenance)).status,409);
  const approved_links=[{course:'GENERAL',current_title:title,when_iso:new Date(Date.UTC(Number(date.slice(0,4)),Number(date.slice(4,6))-1,Number(date.slice(6,8)),Number(date.slice(9,11)),Number(date.slice(11,13)),Number(date.slice(13,15)))).toISOString(),reported_item:title,reported_at:'2026-08-22T10:00:00.000Z'}];
  const invalid=await api('/foundation/migration/initialize',{expected_digest:preview.data.digest,approved_links:[{...approved_links[0],reported_at:'changed'}]},maintenance);
  assert.equal(invalid.status,409);assert.equal((await api('/foundation/health')).data.ready,false);
  const initialized=await api('/foundation/migration/initialize',{expected_digest:preview.data.digest,approved_links},maintenance);
  assert.equal(initialized.data.linked,1);
  const d=(await api('/status')).data.actionable.completed[0];
  assert.equal(d.submission_verification,'reported');
  const legacy=(await api('/progress?course=GENERAL')).data.progress[0];
  assert.equal(legacy.at,'2026-08-22T10:00:00.000Z');assert.equal(legacy.note,'Synthetic legacy fixture');
  const body={course:'GENERAL',item:d.title,status:'done',assignment_id:d.assignment_id,expected_revision:1};
  const write=await api('/progress',body,{'Idempotency-Key':'runtime-progress'});
  assert.equal(write.status,200);
  const retry=await api('/progress',body,{'Idempotency-Key':'runtime-progress'});
  assert.equal(retry.data.replayed,true);
  const notes=await Promise.all(['a','b'].map(session_id=>api('/classnote',{course:'GENERAL',session_id,text:'synthetic class note'})));
  assert.ok(notes.every(r=>r.status===200));
  assert.equal((await api('/classnote?course=GENERAL')).data.error,undefined);
  title='Runtime renamed';
  assert.equal((await api('/status')).data.actionable.counts.completed,1);
  uid='runtime-two';
  assert.equal((await api('/status')).data.actionable.counts.completed,0);
  htmlFeed=true;
  const broken=(await api('/status')).data;
  assert.equal(broken.actionable.coverage.feeds_status,'degraded');
  htmlFeed=false;
  browser=await chromium.launch({headless:true,channel:'chrome'});
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();page.setDefaultTimeout(10000);
  page.on('request',r=>{if(new URL(r.url()).pathname==='/app/session')console.log('Form Origin:',r.headers().origin||'missing');});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/app');
  await page.locator('input[name="access_key"]').fill('wrong');
  await page.locator('button[type="submit"]').click();
  await page.locator('input[name="access_key"]').waitFor();
  assert.match(await page.locator('body').innerText(),/key|sign in/i);
  await page.locator('input[name="access_key"]').fill('runtime-fixture-key');
  await page.locator('button[type="submit"]').click();
  if(page.url()!==origin+'/app')console.log('Sign-in result:',new URL(page.url()).pathname,await page.locator('.message').allTextContents());
  await page.waitForURL(origin+'/app',{timeout:10000});
  await page.locator('#kpis .kpi').first().waitFor();
  assert.ok((await context.cookies()).some(c=>c.name==='__Host-bridge_session' && c.httpOnly && c.secure));
  assert.ok(!await page.evaluate(()=>document.cookie.includes('runtime-fixture-key')));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  assert.deepEqual(errors,[]);
  await page.locator('[data-tab="week"]').click();
  let lost=false;
  await page.route('**/progress',async route=>{
    if(!lost){lost=true;await route.fetch();await route.abort('failed');}
    else await route.continue();
  });
  await page.locator('#body .mark').first().click();
  await page.getByText('Could not confirm the save.',{exact:false}).waitFor();
  assert.equal((await api('/status')).data.actionable.counts.completed,1);
  const pending=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('bridge_pending_saves_v1')));
  const op=Object.values(pending)[0].operation_id;
  await page.locator('.retry-save').click();
  await page.getByText('Saved Runtime renamed.',{exact:true}).waitFor();
  const records=(await api('/progress?course=GENERAL')).data.progress;
  const saved=records.find(r=>r.assignment_id===Object.values(pending)[0].body.assignment_id);
  const history=(await api('/progress/history?record_id='+saved.record_id)).data.history;
  assert.equal(history.length,1,'lost acknowledgement retry cannot create a second mutation');
  assert.equal(history[0].operation_id,op);
  // Completed history is collapsed in the current dashboard. Expand it as a user would.
  const historySection=page.locator('#body details').filter({has:page.locator('.mark.undo')}).first();
  if(await historySection.count() && !(await historySection.getAttribute('open')))await historySection.locator('summary').first().click();
  await page.locator('#body .mark.undo').first().click();
  await page.locator('#body .mark:not(.undo)').first().waitFor();
  assert.equal((await api('/status')).data.actionable.counts.completed,0);
  await page.route('**/status',route=>route.abort('failed'));
  await page.locator('#refresh').click();
  await page.getByText('Saved snapshot — not current.',{exact:false}).waitFor();
  assert.equal(await page.locator('#body .mark:enabled').count(),0);
  await page.locator('#fab').click();
  await page.locator('#q').fill('what is overdue');
  await page.locator('#askform button').click();
  await page.getByText('I cannot confirm what is currently outstanding',{exact:false}).waitFor();
  await page.unroute('**/status');
  await page.locator('#refresh').click();
  await page.getByText('Saved snapshot — not current.',{exact:false}).waitFor({state:'detached'});

  await page.goto(origin+'/app/system');
  await page.locator('#node-records').waitFor({state:'attached'});
  assert.equal(await page.locator('#node-records').getAttribute('data-state'),'healthy');
  assert.equal(await page.locator('.node').count(),28);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  assert.deepEqual(errors,[]);
  // Real form POST supplies the Origin header; sign-out must revoke server state.
  const cookie=(await context.cookies()).find(c=>c.name==='__Host-bridge_session');
  await page.locator('form[action="/app/sign-out"] button').click();
  await page.waitForURL(url=>url.pathname==='/app/sign-in');
  assert.equal((await mf.dispatchFetch(origin+'/foundation/health',{headers:{Cookie:cookie.name+'='+cookie.value}})).status,401);
  console.log('PASS: workerd SQL/RPC, migration gate, idempotent/concurrent saves, rename/reuse identity, bad-feed warnings, mobile native sign-in and revocation.');
  await context.close();
} finally {
  if(browser)await browser.close();
  await mf.dispose();
}
