import {driveConfigured, serviceAccountConfigured} from './drive.js';
import {serviceAccountToken} from './drive-service-account.js';
export const DRIVE_PROBE_VERSION = 3;

// A minimal read of Drive account metadata, not a file crawl or paid inference.
// Separate from the library's token cache so monitoring adds no credential writes.
// Provider bodies never enter telemetry, even on errors.
async function boundedJSON(response, limit = 16384) {
  if (!response.body) throw new Error('invalid_response');
  const reader = response.body.getReader();
  let size = 0, text = '';
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('response_too_large');
      text += decoder.decode(value, {stream: true});
    }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function probeDriveAccess(env, fetchImpl = fetch) {
  if (!driveConfigured(env)) return {outcome:'unknown', reason:'not_configured', detail:'Drive API credentials are not configured. No request was made.'};
  try {
    if (serviceAccountConfigured(env)) {
      const token = await serviceAccountToken(env.GDRIVE_SERVICE_ACCOUNT_JSON, (url, options) =>
        fetchImpl(url, {...options, redirect:'manual', signal:AbortSignal.timeout(10000)}));
      const response = await fetchImpl('https://www.googleapis.com/drive/v3/files/'
        + encodeURIComponent(env.GDRIVE_ROOT_ID) + '?fields=id,mimeType', {
        headers:{Authorization:'Bearer '+token.access_token}, redirect:'manual', signal:AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return {outcome:'failed',reason:'api',detail:'Drive course-folder read failed (HTTP '+response.status+').'};
      }
      const data = await boundedJSON(response);
      if (data.id !== env.GDRIVE_ROOT_ID || data.mimeType !== 'application/vnd.google-apps.folder') throw new Error('invalid_response');
      return {outcome:'healthy',reason:'ok',detail:'Read-only service-account authorization and course-folder metadata passed. No file contents were read; desktop sync is a separate check.'};
    }
    const tokenResponse = await fetchImpl('https://oauth2.googleapis.com/token', {
      method:'POST', redirect:'manual', signal:AbortSignal.timeout(10000),
      headers:{'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({client_id:env.GDRIVE_CLIENT_ID,client_secret:env.GDRIVE_CLIENT_SECRET,
        refresh_token:env.GDRIVE_REFRESH_TOKEN,grant_type:'refresh_token'}),
    });
    if (!tokenResponse.ok) {
      await tokenResponse.body?.cancel();
      return {outcome:'failed',reason:'authorization',detail:'Google rejected the Drive authorization check (HTTP '+tokenResponse.status+'). Review the existing Drive connection; no credentials were changed.'};
    }
    const token = await boundedJSON(tokenResponse);
    if (typeof token.access_token !== 'string' || !token.access_token || /[\r\n]/.test(token.access_token)) throw new Error('invalid_response');
    const response = await fetchImpl('https://www.googleapis.com/drive/v3/about?fields=kind', {
      headers:{Authorization:'Bearer '+token.access_token}, redirect:'manual', signal:AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {outcome:'failed',reason:'api',detail:'Drive metadata read failed (HTTP '+response.status+'). Local desktop sync is a separate check.'};
    }
    const data = await boundedJSON(response);
    if (data.kind !== 'drive#about') throw new Error('invalid_response');
    return {outcome:'healthy',reason:'ok',detail:'Drive authorization and a read-only API metadata request passed. No file contents were read; course-folder access and desktop sync are not tested here.'};
  } catch (error) {
    return {outcome:'failed',reason:'request',detail:error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? 'Drive connection check timed out.' : 'Drive connection check could not complete or returned an invalid response.'};
  }
}
