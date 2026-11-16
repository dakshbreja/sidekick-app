import { COURSES } from './courses.js';
import { TERM_ID } from './identity.js';

export const COURSE_CODES=COURSES.map(c=>c.code).concat('GENERAL');
export function state(env) {
  if (!env.BRIDGE_STATE) throw new Error('records_storage_unavailable');
  return env.BRIDGE_STATE.getByName('personal-bridge-v1');
}
export async function digest(value) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
export const stableJSON=value=>value && typeof value==='object' ? Array.isArray(value) ? '['+value.map(stableJSON).join(',')+']' : '{'+Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>JSON.stringify(k)+':'+stableJSON(value[k])).join(',')+'}' : JSON.stringify(value);

export async function readRecords(env,kind,courses) {
  const result=await state(env).list(kind,courses);
  if (!result.ok) throw new Error(result.error);
  return result.records;
}
export async function migrationSnapshot(env) {
  if (!env.NOTES) throw new Error('legacy_storage_unavailable');
  const snapshot={term_id:TERM_ID,progress:{},classnote:{}};
  for (const kind of ['progress','classnote']) for (const course of COURSE_CODES) {
    const raw=await env.NOTES.get((kind==='progress'?'progress:':'classnotes:')+course);
    const rows=raw===null ? [] : JSON.parse(raw);
    if (!Array.isArray(rows) || rows.some(r=>!r || typeof r!=='object' || Array.isArray(r))) throw new Error('legacy_snapshot_invalid');
    snapshot[kind][course]=rows;
  }
  return {snapshot,digest:await digest(stableJSON(snapshot))};
}
export async function readBody(request,maxBytes=16000) {
  const reader=request.body?.getReader();
  if (!reader) throw new Error('invalid_json');
  const chunks=[]; let size=0;
  try {
    while (true) { const {done,value}=await reader.read(); if(done)break; size+=value.byteLength;
      if(size>maxBytes)throw new Error('body_too_large'); chunks.push(value); }
    const parsed=JSON.parse(await new Blob(chunks).text());
    if (!parsed || typeof parsed!=='object' || Array.isArray(parsed)) throw new Error('invalid_json');
    return parsed;
  } catch(err) { await reader.cancel().catch(()=>{}); if(err.message==='body_too_large')throw err; throw new Error('invalid_json'); }
  finally { reader.releaseLock(); }
}
