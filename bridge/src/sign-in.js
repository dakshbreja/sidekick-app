// Public sign-in shell only: no account topology, telemetry, or credential value.
export const returnPath = value => ['/app/system','/app/clubs','/app/profile','/app/settings'].includes(value) ? value : '/app';
export function signInResponse(next = '/app/system', reason = '', status = 200) {
  next = returnPath(next);
  const label = next === '/app' ? 'dashboard' : ['/app/profile','/app/settings'].includes(next)?'learner profile':'system map';
  const messages = {
    legacy_url: 'Key-in-link sign-in has been retired. Use this form, then bookmark the clean /app address.',
    invalid: 'That access key was not accepted. Check it and try again.',
    expired: 'Your session is missing or expired. Sign in to return to your page.',
    origin: 'This sign-in could not be verified. Reload this page and try again.',
    large: 'That entry was too long. Paste only your Sidekick access key.',
    format: 'Please use the sign-in form below.',
    limited: 'Too many sign-in attempts. Please wait 15 minutes before trying again.',
    unavailable: 'Sign-in is temporarily unavailable. Nothing was changed. Please try again.',
  };
  const message = messages[reason] || '';
  return new Response(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#090e14">
<title>Sign in · Sidekick</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#090e14;color:#edf3f7;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100svh;display:grid;place-items:center;padding:24px}
main{width:min(100%,460px)}.brand{font-size:12px;letter-spacing:.1em;font-weight:650;color:#91abbc;margin-bottom:26px}.card{padding:30px;border:1px solid #30404f;border-radius:16px;background:#111b27;box-shadow:0 20px 70px #0003}.lock{color:#73dec0;font-size:12px;letter-spacing:.1em;text-transform:uppercase}h1{font-size:30px;line-height:1.15;letter-spacing:-.04em;margin:10px 0 14px}p{color:#abbccb;margin:0 0 20px;font-size:14px}label{display:block;font-size:14px;font-weight:600;margin-bottom:8px}input{width:100%;background:#080f18;border:1px solid #45576a;color:#f0f5f9;border-radius:8px;padding:13px;font-family:inherit;font-size:16px;min-height:50px}input:focus{outline:2px solid #72debe;outline-offset:2px}button,.secondary{width:100%;display:block;border-radius:8px;padding:13px;text-align:center;font:600 15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:48px;cursor:pointer}button{margin-top:18px;border:1px solid #8ee3c9;background:#7fe1c4;color:#08231c}.secondary{margin-top:12px;background:transparent;border:1px solid #405163;color:#d9e9ed;text-decoration:none}a:focus-visible,button:focus-visible{outline:2px solid #8ad8ff;outline-offset:3px}.hint{font-size:12px;margin:9px 0 0;color:#9fb0bf}.message{border:1px solid #895159;background:#34212b;color:#ffd0d4;padding:12px 14px;border-radius:8px;font-size:14px;margin:0 0 22px}.help{margin:23px 0 0;font-size:13px}.help strong{color:#dce9f0}.footer{font-size:12px;color:#8498aa;text-align:center;margin:22px 0 0}@media(max-width:440px){body{padding:18px}.card{padding:24px}h1{font-size:28px}}
</style></head><body><main>
<div class="brand">SIDEKICK</div><section class="card">
<div class="lock">Private access</div><h1>Open your ${label}.</h1>
<p>This browser needs a Sidekick sign-in before it can show your private data.</p>
${message ? '<div class="message" role="alert">'+message+'</div>' : ''}
<form method="post" action="/app/session" autocomplete="on">
<input type="hidden" name="returnTo" value="${next}">
<label for="access_key">Sidekick access key</label>
<input id="access_key" name="access_key" type="password" autocomplete="current-password" required maxlength="1024" autocapitalize="none" autocorrect="off" spellcheck="false" aria-describedby="key-help">
<p class="hint" id="key-help">Use your existing Sidekick key — not your Google or UGA password.</p>
<button type="submit">Open ${label}</button></form>
<a class="secondary" href="${next}">Check saved sign-in</a>
<p class="help"><strong>Already use Sidekick in Safari?</strong><br>Open this same link in Safari, then check your saved sign-in. In-app browsers may use a separate session.</p>
<p class="help"><strong>Need your key?</strong><br>Use the existing key from your Sidekick setup or password manager. If you do not have it on this device, use your already-signed-in browser first. There is no new account to create.</p>
</section><p class="footer">Your key is sent over HTTPS, never in the page URL.<br>This browser gets its own revocable session, lasting up to 30 days.</p>
</main></body></html>`, {status,headers:{
    'content-type':'text/html; charset=utf-8','cache-control':'no-store',
    'x-robots-tag':'noindex, nofollow','referrer-policy':'no-referrer','x-content-type-options':'nosniff',
    'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  }});
}
export async function readSignInForm(request) {
  const reader=request.body?.getReader(); const chunks=[];let size=0;
  if(reader)while(true){
    const {done,value}=await reader.read();if(done)break;
    size+=value.length;if(size>4096){await reader.cancel();throw new Error('large');}
    chunks.push(value);
  }
  return new URLSearchParams(await new Blob(chunks).text());
}
