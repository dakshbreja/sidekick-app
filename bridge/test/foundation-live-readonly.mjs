// Live native-browser authentication/read verification. Never creates coursework.
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require('/Users/Daksh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const config={};
for(const line of readFileSync('/Users/Daksh/Claude/school-system-suite/bridge/.env','utf8').split(/\r?\n/)){
  const m=/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);if(m)config[m[1]]=m[2].replace(/^['"]|['"]$/g,'');
}
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{
  for(const host of ['ijuh2yp6rf','coursework']){
    const origin='https://'+host+'.example-subdomain.workers.dev';
    const ctx=await browser.newContext({viewport:{width:390,height:844}});
    const page=await ctx.newPage();page.setDefaultTimeout(20000);
    const errors=[];page.on('pageerror',e=>errors.push(e.name));
    await page.goto(origin+'/app');
    await page.locator('input[name="access_key"]').fill(config.API_KEY);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(origin+'/app');
    await page.locator('#kpis .kpi').first().waitFor();
    assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const cookie=(await ctx.cookies()).find(c=>c.name==='__Host-bridge_session');
    assert.ok(cookie?.httpOnly && cookie?.secure && cookie.sameSite==='Lax');
    assert.notEqual(cookie.value,config.API_KEY);
    const status=await page.evaluate(async()=>{const r=await fetch('/status');return {status:r.status,data:await r.json()};});
    assert.equal(status.status,200);assert.equal(status.data.term_id,'fall-2026');
    assert.equal(status.data.actionable.counts.completed,11);
    assert.equal(status.data.actionable.coverage.feeds_status,'ok');
    await page.screenshot({path:'/private/tmp/bridge-foundation-pass.zPrwVa/'+host+'-dashboard.png',fullPage:true});
    await page.goto(origin+'/app/system');
    await page.locator('#node-records').waitFor({state:'attached'});
    assert.equal(await page.locator('#node-records').getAttribute('data-state'),'healthy');
    assert.equal(await page.locator('.node').count(),27);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:'/private/tmp/bridge-foundation-pass.zPrwVa/'+host+'-system.png',fullPage:true});
    await page.locator('form[action="/app/sign-out"] button').click();
    await page.waitForURL(url=>url.pathname==='/app/sign-in');
    const revoked=await fetch(origin+'/foundation/health',{headers:{Cookie:cookie.name+'='+cookie.value},signal:AbortSignal.timeout(15000)});
    assert.equal(revoked.status,401);
    assert.deepEqual(errors,[]);
    console.log('PASS '+host+': mobile native sign-in, fresh shared status, 11 reported completions, 27-node map, no overflow, server-revoked sign-out.');
    await ctx.close();
  }
}finally{await browser.close();}
