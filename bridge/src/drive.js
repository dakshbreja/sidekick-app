// Read-only Google Drive access, so a GPT can reach the ORIGINAL document when the
// text in its Knowledge bundles looks wrong, stale, or incomplete.
//
// This is deliberately the secondary source. Knowledge answers first because it is
// free and instant; Drive is for "the bundle says the exam is Oct 2 but that reads
// like last term's syllabus — go look at the actual PDF." So every response here
// carries the provenance a GPT needs to say which one it trusted and why.
//
// A service account can read the one shared course root without a weekly OAuth
// refresh grant. The existing installed-app grant remains a migration fallback.
// Scope is drive.readonly and nothing here ever writes to Drive.

import {serviceAccountToken} from './drive-service-account.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FILES = 'https://www.googleapis.com/drive/v3/files';

// Where the course material lives. Resolved by walking names once and then cached,
// so a rename shows up as a clear error rather than silently searching all of Drive.
//
// This is the TRUE path, not the one Drive Desktop shows. On disk the folder looks
// like My Drive/College/..., because the "College" at the root of My Drive is a
// shortcut and the local client presents shortcuts as ordinary folders. The real
// parent chain runs through "Documents Personal Google Drive", and a folder-only
// query at the root finds nothing named College at all.
export const LIBRARY_PATH = [
  'Documents Personal Google Drive', 'College', 'UGA', 'Year 4 - 2026-27', 'Classes', 'Fall 2026',
];

const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

// Folder names in Drive carry whatever whitespace they were created with — the
// course folders here are all "MGMT 4280 " with a trailing space. Comparing raw
// would silently scope a search to nothing, so every name comparison is trimmed.
const norm = (s) => String(s || '').trim().toLowerCase();

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ROOT_CACHE_KEY = 'drive:rootid';
const TOKEN_CACHE_KEY = 'drive:token';
const SERVICE_TOKEN_CACHE_KEY = 'drive:service-token';
// Google's access tokens last an hour. Stopping 5 minutes short means a token is
// never handed out so close to expiry that the Drive call outlives it.
const TOKEN_SKEW_MS = 5 * 60 * 1000;

export class DriveError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export function driveConfigured(env) {
  return serviceAccountConfigured(env) || Boolean(env.GDRIVE_CLIENT_ID && env.GDRIVE_CLIENT_SECRET && env.GDRIVE_REFRESH_TOKEN);
}

export function serviceAccountConfigured(env) {
  return Boolean(env.GDRIVE_SERVICE_ACCOUNT_JSON && env.GDRIVE_ROOT_ID);
}

/**
 * An access token, cached in KV until shortly before it expires.
 *
 * Caching matters more than it looks: without it every /library call spends a
 * round trip to Google before it can even start searching, and the GPT's request
 * budget is not generous. One write an hour is well inside the KV budget that the
 * class notes and change log also draw on.
 */
async function accessToken(env) {
  const serviceAccount = serviceAccountConfigured(env);
  const cacheKey = serviceAccount ? SERVICE_TOKEN_CACHE_KEY : TOKEN_CACHE_KEY;
  if (env.NOTES) {
    const raw = await env.NOTES.get(cacheKey);
    if (raw) {
      try {
        const cached = JSON.parse(raw);
        if (cached.token && Date.parse(cached.expires_at) - Date.now() > TOKEN_SKEW_MS) {
          return cached.token;
        }
      } catch { /* a corrupt cache entry just means we mint a fresh token */ }
    }
  }

  if (serviceAccount) {
    let result;
    try { result = await serviceAccountToken(env.GDRIVE_SERVICE_ACCOUNT_JSON); }
    catch { throw new DriveError('Drive service-account authorization failed', 503); }
    if (env.NOTES) {
      const expires = new Date(Date.now() + result.expires_in * 1000).toISOString();
      await env.NOTES.put(cacheKey, JSON.stringify({token: result.access_token, expires_at: expires}), {
        expirationTtl: Math.max(120, result.expires_in - 120),
      }).catch(() => {});
    }
    return result.access_token;
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GDRIVE_CLIENT_ID,
      client_secret: env.GDRIVE_CLIENT_SECRET,
      refresh_token: env.GDRIVE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    // invalid_grant means the refresh token was revoked or expired — re-running
    // scripts/drive_auth.py is the fix, and saying so beats a bare 502.
    if (/invalid_grant/.test(detail)) {
      throw new DriveError('Drive authorisation expired — re-run scripts/drive_auth.py', 503);
    }
    throw new DriveError(`Drive token refresh failed (${res.status}): ${detail}`);
  }
  const body = await res.json();
  const token = body.access_token;
  if (!token) throw new DriveError('Drive token refresh returned no access_token');

  if (env.NOTES) {
    const expires = new Date(Date.now() + (body.expires_in || 3600) * 1000).toISOString();
    // Not via kvPut: this module must not depend on the Worker's write accounting,
    // and a failed cache write should never fail the request that needed the token.
    await env.NOTES.put(cacheKey, JSON.stringify({ token, expires_at: expires }), {
      expirationTtl: Math.max(120, (body.expires_in || 3600) - 120),
    }).catch(() => {});
  }
  return token;
}

async function driveGet(env, url) {
  const token = await accessToken(env);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new DriveError(`Drive API ${res.status}`, res.status === 404 ? 404 : 502);
  }
  return res;
}

async function driveText(env, url) {
  const response = await driveGet(env, url);
  const reader = response.body?.getReader();
  if (!reader) throw new DriveError('Drive returned no body');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new DriveError('Drive response exceeds read limit', 413);
      chunks.push(value);
    }
    return await new Blob(chunks).text();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

async function driveJSON(env, url) {
  return JSON.parse(await driveText(env, url));
}

async function listFiles(env, query, fields, orderBy = null) {
  const files = [], seen = new Set(); let page = null;
  do {
    const params = new URLSearchParams({q:query,fields:`nextPageToken,files(${fields})`,pageSize:'200'});
    if (orderBy) params.set('orderBy', orderBy);
    if (page) params.set('pageToken', page);
    const body = await driveJSON(env, `${FILES}?${params}`);
    files.push(...(body.files || []));
    page = body.nextPageToken;
    if (page && seen.has(page)) throw new DriveError('Drive returned repeated pagination');
    if (page) seen.add(page);
  } while (page);
  return files;
}

const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * One step of the path walk.
 *
 * Lists the children and matches on the trimmed name rather than asking Drive for
 * `name = '...'`: Drive's equality is exact, so it misses the trailing space the
 * course folders actually carry. Shortcuts are followed to their target, so a path
 * that runs through one still resolves.
 */
async function childFolder(env, parentId, name) {
  const query = `'${q(parentId)}' in parents and trashed = false and ` +
    `(mimeType = '${FOLDER_MIME}' or mimeType = '${SHORTCUT_MIME}')`;
  const files = await listFiles(env, query, 'id,name,mimeType,shortcutDetails(targetId,targetMimeType)');
  const hit = files.find((f) => norm(f.name) === norm(name));
  if (!hit) throw new DriveError(`Drive folder not found: ${name}`, 404);
  if (hit.mimeType === SHORTCUT_MIME) {
    const target = hit.shortcutDetails && hit.shortcutDetails.targetId;
    if (!target) throw new DriveError(`Drive shortcut has no target: ${name}`, 404);
    return target;
  }
  return hit.id;
}

/** The id of .../Fall 2026, walked once and cached — Drive ids are permanent. */
export async function libraryRootId(env) {
  if (serviceAccountConfigured(env)) return env.GDRIVE_ROOT_ID;
  if (env.NOTES) {
    const cached = await env.NOTES.get(ROOT_CACHE_KEY);
    if (cached) return cached;
  }
  let id = 'root';
  for (const name of LIBRARY_PATH) id = await childFolder(env, id, name);
  if (env.NOTES) {
    await env.NOTES.put(ROOT_CACHE_KEY, id, { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => {});
  }
  return id;
}

/**
 * Every descendant folder of the library root, as {id -> "MGMT 4280/02 - Slides"}.
 *
 * Drive has no "search this subtree" operator, so the subtree is enumerated and
 * the search is scoped to the folder ids it produced. Doing it this way also gives
 * every result a readable folder path, which is the part Daksh actually needs to
 * find the file himself.
 */
export async function folderMap(env, rootId, rootPath = '', maxDepth = 5) {
  const paths = new Map([[rootId, rootPath]]);
  let frontier = [rootId];
  // Depth guard: course/section/Superseded is three, so five is slack, and it
  // stops a folder cycle (Drive allows multi-parenting) turning into a hang.
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const next = [];
    for (let start = 0; start < frontier.length; start += 4) {
      const group = frontier.slice(start, start + 4);
      const children = await Promise.all(group.map(async parent => {
      const query = `'${q(parent)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`;
      return listFiles(env, query, 'id,name');
      }));
      for (let index = 0; index < group.length; index++) for (const f of children[index]) {
        const parent = group[index];
        if (paths.has(f.id)) continue;
        const prefix = paths.get(parent);
        // Trimmed: the stored path is what gets matched against and shown to
        // Daksh, and "MGMT 4280 /02 - Slides" helps nobody.
        const label = String(f.name).trim();
        paths.set(f.id, prefix ? `${prefix}/${label}` : label);
        next.push(f.id);
      }
    }
    frontier = next;
  }
  return paths;
}

/** Drive's own id, but URL-safe and short enough to pass around as a doc_id. */
export function docId(file) {
  return file.id;
}

function shape(file, folder) {
  return {
    doc_id: docId(file),
    title: file.name,
    folder: folder || '(course root)',
    type: PRETTY[file.mimeType] || file.mimeType,
    modified: (file.modifiedTime || '').slice(0, 10),
    size_kb: file.size ? Math.round(Number(file.size) / 1024) : null,
    link: file.webViewLink || null,
  };
}

const PRETTY = {
  'application/pdf': 'PDF',
  'application/vnd.google-apps.document': 'Google Doc',
  'application/vnd.google-apps.spreadsheet': 'Google Sheet',
  'application/vnd.google-apps.presentation': 'Google Slides',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
  'text/plain': 'Text',
  'video/mp4': 'Video',
  'application/zip': 'Zip',
};

/**
 * Search the library. `courseFolder` scopes to one course when given; `query`
 * matches filenames and Drive-indexed contents, so lecture concepts are discoverable.
 */
export async function search(env, { courseFolder = null, query = '', limit = 25 } = {}) {
  const rootId = await libraryRootId(env);
  // A per-course lookup must not walk every other course first. Repeated full
  // walks made lecture verification exceed its 45-second request deadline.
  const courseRoot = courseFolder ? await childFolder(env, rootId, courseFolder) : null;
  const folders = courseRoot
    ? await folderMap(env, courseRoot, String(courseFolder).trim(), 4)
    : await folderMap(env, rootId);
  const scope = [...folders.keys()];

  // Drive caps a query's length, and 'x' in parents is one clause per folder, so
  // the scope is chunked rather than sent as one enormous disjunction.
  const results = [];
  for (let i = 0; i < scope.length && results.length < limit * 3; i += 20) {
    const chunk = scope.slice(i, i + 20);
    const parents = chunk.map((id) => `'${q(id)}' in parents`).join(' or ');
    let clause = `(${parents}) and mimeType != '${FOLDER_MIME}' and trashed = false`;
    if (query.trim()) {
      const needle = query.trim();
      // Drive fullText requires quoted phrases for multiword concepts. Preserve
      // filename lookup as well (session IDs and exact filenames still work).
      const phrase = `"${needle.replace(/"/g, '')}"`;
      clause += ` and (name contains '${q(needle)}' or fullText contains '${q(phrase)}')`;
    }
    const files = await listFiles(env, clause, 'id,name,mimeType,modifiedTime,size,webViewLink,parents', 'modifiedTime desc');
    for (const f of files) {
      results.push(shape(f, folders.get((f.parents || [])[0])));
    }
  }
  results.sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
  return results.slice(0, limit);
}

/** Metadata for one file, including where it sits, so an answer can cite it. */
export async function fileMeta(env, id) {
  const url = `${FILES}/${encodeURIComponent(id)}` +
    '?fields=id,name,mimeType,modifiedTime,size,webViewLink,parents';
  const file = await driveJSON(env, url);
  let folder = '';
  try {
    const rootId = await libraryRootId(env);
    // Follow this file's ancestry, not the entire library tree. No cached path:
    // a rename or move is reflected on the next readback.
    let parent = (file.parents || [])[0];
    const labels = [], seen = new Set();
    for (let depth = 0; parent && parent !== rootId && depth < 5; depth++) {
      if (seen.has(parent)) break;
      seen.add(parent);
      const ancestor = await driveJSON(env, `${FILES}/${encodeURIComponent(parent)}?fields=id,name,mimeType,parents`);
      if (!ancestor || ancestor.mimeType !== FOLDER_MIME) break;
      labels.unshift(String(ancestor.name).trim());
      parent = (ancestor.parents || [])[0];
    }
    if (parent !== rootId) throw new DriveError('Document is outside the course library', 403);
    folder = labels.join('/');
  } catch (error) { throw error; }
  return { file, shaped: shape(file, folder) };
}

const EXPORTABLE = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};

/**
 * The text of one document, when Drive itself can produce it.
 *
 * Google-native files export cleanly and plain text downloads as-is. A PDF cannot
 * be turned into text here — a Worker has no PDF parser, and pretending otherwise
 * would mean returning something plausible and wrong. Those come back with
 * text: null and a reason, and the caller falls back to the sweep's own extraction.
 */
export async function fileText(env, file, maxChars) {
  const mime = file.mimeType;
  if (EXPORTABLE[mime]) {
    const url = `${FILES}/${encodeURIComponent(file.id)}/export` +
      `?mimeType=${encodeURIComponent(EXPORTABLE[mime])}`;
    const text = await driveText(env, url);
    return { text: text.slice(0, maxChars), truncated: text.length > maxChars, source: 'drive_export' };
  }
  if (mime === 'text/plain' || mime === 'text/csv' || mime === 'text/markdown') {
    const url = `${FILES}/${encodeURIComponent(file.id)}?alt=media`;
    const text = await driveText(env, url);
    return { text: text.slice(0, maxChars), truncated: text.length > maxChars, source: 'drive_download' };
  }
  return {
    text: null,
    truncated: false,
    source: null,
    reason: `Drive cannot extract text from ${PRETTY[mime] || mime}`,
  };
}
