import { state, digest } from './foundation.js';
import { signInResponse, readSignInForm, returnPath } from './sign-in.js';
export const SESSION_COOKIE='__Host-bridge_session';
const MAX_AGE=30*86400;
export function cookieValue(request,name) {
  for(const part of (request.headers.get('Cookie') || '').split(';')) {
    const [key,...value]=part.trim().split('=');
    if(key===name) { try{return decodeURIComponent(value.join('='));}catch{return '';} }
  }
  return '';
}
export async function safeEqual(a,b) {
  if(typeof a!=='string' || typeof b!=='string' || !b || a.length>4096)return false;
  const hashes=await Promise.all([a,b].map(v=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(v))));
  if(crypto.subtle.timingSafeEqual)return crypto.subtle.timingSafeEqual(...hashes);
  const x=new Uint8Array(hashes[0]),y=new Uint8Array(hashes[1]); let diff=0;
  for(let i=0;i<x.length;i++)diff|=x[i]^y[i];
  return diff===0;
}
export async function authenticate(request,env) {
  if(!env.API_KEY)return null;
  const header=request.headers.get('Authorization') || '';
  if(header.startsWith('Bearer ') && await safeEqual(header.slice(7).trim(),env.API_KEY))return 'bearer';
  const token=cookieValue(request,SESSION_COOKIE);
  if(!/^[a-f0-9]{64}$/.test(token))return null;
  const check=await state(env).session('check',{hash:await digest(token),epoch:await digest('session-epoch:'+env.API_KEY)});
  return check.ok?'session':null;
}
function redirect(next,cookies=[]) {
  const headers=new Headers({'Location':returnPath(next),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
  for(const cookie of cookies)headers.append('Set-Cookie',cookie);
  return new Response(null,{status:303,headers});
}
export async function issueSession(env,next) {
  const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
  await state(env).session('create',{hash:await digest(token),expires:Date.now()+MAX_AGE*1000,epoch:await digest('session-epoch:'+env.API_KEY)});
  return redirect(next,[`${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`,
    'bridge_k=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0']);
}
export async function authRoutes(request,env,path) {
  const url=new URL(request.url);
  // Retired key-bearing bookmarks get a clean sign-in URL, regardless of their
  // value. Do not compare/decode the path or create a session from a URL secret.
  if(/^\/app\/[^/]+$/.test(path) && !['/app/profile','/app/settings','/app/clubs','/app/system','/app/sign-in','/app/session','/app/sign-out'].includes(path)) {
    const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer'};
    if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:410,headers});
    return new Response(null,{status:303,headers:{...headers,Location:'/app/sign-in?returnTo=%2Fapp&reason=legacy_url'}});
  }
  if(path==='/app/session' && request.method==='POST') {
    if(request.headers.get('Origin')!==url.origin)return signInResponse('/app','origin',403);
    if(!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/x-www-form-urlencoded'))return signInResponse('/app','format',415);
    let form;
    try{form=await readSignInForm(request);}catch{return signInResponse('/app','large',413);}
    const next=returnPath(form.get('returnTo'));
    const bucket=await digest('login:'+env.API_KEY+':'+(request.headers.get('CF-Connecting-IP') || 'unknown'));
    try {
      const attempt=await state(env).loginAttempt(bucket);
      if(!attempt.ok){const r=signInResponse(next,'limited',429);r.headers.set('Retry-After',String(attempt.retry_after));return r;}
      if(!await safeEqual((form.get('access_key') || '').trim(),env.API_KEY))return signInResponse(next,'invalid',401);
      await state(env).loginAttempt(bucket,true);
      return await issueSession(env,next);
    }catch{return signInResponse(next,'unavailable',503);}
  }
  if(path==='/app/sign-in' && request.method==='GET') {
    const next=returnPath(url.searchParams.get('returnTo'));
    try {
      if(await authenticate(request,env))return redirect(next);
      // Upgrade an existing legacy browser once. New sessions never store API_KEY.
      if(await safeEqual(cookieValue(request,'bridge_k'),env.API_KEY))return await issueSession(env,next);
    }catch{return signInResponse(next,'unavailable',503);}
    return signInResponse(next,['expired','legacy_url'].includes(url.searchParams.get('reason'))?url.searchParams.get('reason'):'');
  }
  if(path==='/app/sign-out' && request.method==='POST') {
    if(request.headers.get('Origin')!==url.origin)return new Response('Forbidden',{status:403});
    const token=cookieValue(request,SESSION_COOKIE);
    try {
      if(/^[a-f0-9]{64}$/.test(token)) {
        const hash=await digest(token),epoch=await digest('session-epoch:'+env.API_KEY);
        if((await state(env).session('check',{hash,epoch})).ok)await state(env).session('delete',{hash});
      }
    }
    catch{return new Response('Sign-out could not be confirmed. Please retry.',{status:503,headers:{'Cache-Control':'no-store'}});}
    const r=redirect('/app',[`${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
      'bridge_k=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0']);
    r.headers.set('Location','/app/sign-in?returnTo=%2Fapp');return r;
  }
  return null;
}
