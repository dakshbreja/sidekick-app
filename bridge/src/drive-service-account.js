// A service account signs a short-lived assertion locally and exchanges it for
// a one-hour, read-only Drive token. It has no seven-day OAuth refresh grant.
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

const base64url = (bytes) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

function privateKeyBytes(pem) {
  if (typeof pem !== 'string') throw new Error('invalid_service_account_key');
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(body)) throw new Error('invalid_service_account_key');
  return Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
}

export async function serviceAccountAssertion(credentials, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000);
  const header = {alg: 'RS256', typ: 'JWT'};
  const claims = {
    iss: credentials.client_email, scope: SCOPE, aud: TOKEN_URL,
    iat: issuedAt, exp: issuedAt + 3600,
  };
  const encoder = new TextEncoder();
  const encoded = (value) => base64url(encoder.encode(JSON.stringify(value)));
  const signingInput = `${encoded(header)}.${encoded(claims)}`;
  const key = await crypto.subtle.importKey('pkcs8', privateKeyBytes(credentials.private_key),
    {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

export async function serviceAccountToken(json, fetchImpl = fetch) {
  let credentials;
  try {
    credentials = JSON.parse(json);
    if (credentials.type !== 'service_account' || !credentials.client_email || !credentials.private_key) {
      throw new Error('invalid_service_account_key');
    }
    const assertion = await serviceAccountAssertion(credentials);
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion}),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`service_account_token_http_${response.status}`);
    }
    const result = await response.json();
    if (typeof result.access_token !== 'string' || !result.access_token || /[\r\n]/.test(result.access_token)) {
      throw new Error('invalid_service_account_response');
    }
    return {access_token: result.access_token, expires_in: result.expires_in || 3600};
  } catch (error) {
    // The credential, JWT, and provider body must never reach API clients or logs.
    throw new Error(/^service_account_token_http_\d+$/.test(error.message)
      ? error.message : 'service_account_authorization_failed');
  }
}
