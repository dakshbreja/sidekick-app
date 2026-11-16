// Actual Workers runtime, synthetic outbound services only. No browser automation,
// credentials, production state or external network calls.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const deps=process.env.BRIDGE_TEST_DEPS||'/Users/Daksh/.npm/_npx/32026684e21afda6/node_modules';
const {build}=require(deps+'/esbuild');
const {Miniflare,convertV4MiniflareOptions}=require(deps+'/miniflare');
const bundle=await build({stdin:{contents:`import {probeDriveAccess} from './src/drive-health.js';
export default {async fetch(request,env){return Response.json(await probeDriveAccess(env));}};`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'neutral'});
let failure=false,redirect=false,calls=0;
const mf=new Miniflare(convertV4MiniflareOptions({cf:false,workers:[{name:'connection-check',modules:true,
  script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-19',
  bindings:{GDRIVE_CLIENT_ID:'fixture',GDRIVE_CLIENT_SECRET:'fixture',GDRIVE_REFRESH_TOKEN:'fixture'},
  outboundService:async request=>{
    const url=new URL(request.url);calls++;
    assert.ok(['oauth2.googleapis.com','www.googleapis.com'].includes(url.hostname),'No other destination allowed');
    if(failure)return new Response('private fixture error',{status:400});
    if(redirect)return new Response(null,{status:302,headers:{Location:'https://must-not-follow.invalid'}});
    if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'fixture-access'});
    assert.equal(url.pathname+url.search,'/drive/v3/about?fields=kind');
    return Response.json({kind:'drive#about'});
  }
}]}));
try{
  const call=async()=>await(await mf.dispatchFetch('http://local.test')).json();
  assert.equal((await call()).outcome,'healthy');assert.equal(calls,2);
  failure=true;const failed=await call();assert.equal(failed.outcome,'failed');assert.doesNotMatch(JSON.stringify(failed),/private fixture/);
  failure=false;redirect=true;const before=calls;assert.equal((await call()).outcome,'failed');assert.equal(calls,before+1);
  console.log('3 workerd connection checks passed: success, sanitized failure, redirect refusal.');
}finally{await mf.dispose();}
