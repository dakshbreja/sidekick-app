import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ClubStore,clubStatus} from '../src/clubs-store.js';
import {clubsRoutes} from '../src/clubs-routes.js';
import {sqliteFoundation} from './sqlite-fixture.js';
import worker from '../src/worker.js';
import {clubsHtml} from '../src/clubs-page.js';
const sid='d7513bbd-e07d-4321-a531-dd2fb4897f1c';
const text='Speaker [0:00]: We built an internship tracker.\n'.repeat(20);
function fixture(t){const f=sqliteFoundation();t.after(()=>f.close());const s=new ClubStore(f.storage);Object.assign(f.stub,{clubOverview:async()=>s.overview(),clubPut:async(...a)=>s.put(...a),clubGet:async(...a)=>s.get(...a),clubSearch:async(...a)=>s.search(...a)});return {f,s,env:{BRIDGE_STATE:f.binding,API_KEY:'test-key'}};}
const payload={session_id:sid,title:'Joint workshop',clubs:['ai-society','openai-uga'],created_at:'2026-09-16T21:34:29Z',completed:true,transcript:text,expected_revision:0};
const req=(path,data)=>new Request('https://bridge.test'+path,{method:data?'POST':'GET',headers:{Authorization:'Bearer test-key','Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
test('joint recording retries preserve one record; stale revision cannot overwrite correction',async t=>{
 const {env,s}=fixture(t);for(let i=0;i<2;i++){const r=await clubsRoutes(req('/clubs/session',payload),env,'/clubs/session','bearer');assert.equal(r.status,200);}assert.equal(s.list().length,1);assert.equal(s.list()[0].revision,1);
 const changed={...payload,transcript:text+'Speaker [2:00]: Correction',expected_revision:1};assert.equal((await clubsRoutes(req('/clubs/session',changed),env,'/clubs/session','bearer')).status,200);
 assert.equal((await clubsRoutes(req('/clubs/session',payload),env,'/clubs/session','bearer')).status,409);assert.equal(s.get('session',sid).revision,2);
 assert.equal(s.overview().sessions[0].transcript,undefined);assert.equal(s.get('session',sid).transcript,changed.transcript);
});
test('search retrieves transcript concepts for either club; literal search prevents SQL wildcard expansion',async t=>{
 const {env,s}=fixture(t);await clubsRoutes(req('/clubs/session',payload),env,'/clubs/session','bearer');for(const c of payload.clubs){const r=s.search('internship tracker',c);assert.equal(r.total,1);assert.match(r.results[0].excerpts[0],/\[0:00\]/);}assert.equal(s.search('%',null).total,0);
});
test('private club routes require auth; browser writes cannot publish records; active/unknown sessions rejected',async t=>{
 const {env}=fixture(t);assert.equal((await worker.fetch(new Request('https://bridge.test/clubs'),env,{})).status,401);
 assert.equal((await clubsRoutes(req('/clubs/session',payload),env,'/clubs/session','session')).status,403);
 for(const p of [{...payload,completed:false},{...payload,clubs:['random']},{...payload,transcript:'generated summary'}])assert.equal((await clubsRoutes(req('/clubs/session',p),env,'/clubs/session','bearer')).status,400);
});
test('missing source coverage and changed bundle invalidate project health without transcripts in metadata',()=>{
 const checked='2026-09-16T23:00:00Z',hash='a'.repeat(64),raw={sessions:[],sync:{checked_at:checked,groupme_checked_at:checked,raw_coverage_complete:true,groupme_coverage_complete:true,bridge_verified_at:checked,bundle_sha256:hash,pending_session_ids:[]},project:{bundle_sha256:hash,retrieval:'verified'}};
 assert.equal(clubStatus(raw,Date.parse(checked)).state,'current');
 assert.equal(clubStatus({...raw,sync:{...raw.sync,newest_raw:{'ai-society':{session_id:sid,created_at:checked}}}},Date.parse(checked)).state,'stale');
 assert.equal(clubStatus({...raw,sessions:[{session_id:sid,clubs:['openai-uga'],created_at:checked}]},Date.parse(checked)).clubs[1].standalone_status,'active');
 assert.equal(clubStatus({...raw,project:{...raw.project,bundle_sha256:'b'.repeat(64)}},Date.parse(checked)).state,'stale');
 assert.equal(clubStatus(raw,Date.parse(checked)+37*3600e3).state,'stale');
 assert.equal(clubStatus({...raw,sync:{...raw.sync,raw_coverage_complete:false}},Date.parse(checked)).state,'stale');
 assert.equal(clubStatus({sessions:[],sync:null,project:null}).state,'unknown');
});
test('clubs dashboard treats provider content as text and exposes source coverage',()=>{const html=clubsHtml();assert.ok(html.includes('textContent'));assert.ok(!html.includes('innerHTML'));assert.ok(html.includes('/clubs/search'));assert.ok(html.includes('not_started'));});
