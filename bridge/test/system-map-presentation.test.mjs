import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {systemHtml,displayedState} from '../src/system-page.js';
import {systemHealth} from '../src/system-health.js';

const html=systemHtml(),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
test('map is the default on both desktop and mobile; cards and inspector are available',()=>{
  new vm.Script(script);
  assert.match(script,/mode='map'/);
  assert.match(html,/id="listmode"[^>]*>Service cards/);
  assert.match(html,/id="inspector"[^>]* hidden/);
  assert.match(html,/id="close-inspector"/);
  assert.match(html,/id="locate"/);
  assert.match(script,/dataset\.service===n\.id\)return/); // Polling must not detach focused connection buttons.
  assert.match(html,/id="fit">Fit<\/button>[\s\S]*id="expand"/); // Cards retain an exit control.
  assert.match(html,/Flow shows connections, not live task activity/);
});
test('all real service IDs have map positions, icons and card descriptions',async()=>{
  const snapshot=await systemHealth({NOTES:{get:async()=>null}});
  const declarations=script.slice(0,script.indexOf('function select('));
  const context={document:{getElementById:()=>null}};
  vm.createContext(context);
  vm.runInContext(declarations+';globalThis.check={positions,nodeMeta};',context);
  for(const n of snapshot.nodes){
    assert.ok(context.check.positions[n.id],n.id);
    assert.ok(context.check.nodeMeta[n.id],n.id);
  }
  assert.deepEqual(new Set(snapshot.nodes.map(n=>n.id)),new Set(Object.keys(context.check.positions)));
  assert.ok(snapshot.nodes.some(n=>n.id==='instructor-announcements'));
  for(const n of snapshot.nodes){const [x,y]=context.check.positions[n.id];assert.ok(x+202<=1620&&y+123<=970,'map node and retry control fit '+n.id);}
});
test('interaction layer isolates retry requests from coursework writes and supports navigation',()=>{
  for(const phrase of ["pointerdown","pointermove","pointercancel","ArrowRight","zoomAround","closeInspector","$('group').addEventListener('change'"])assert.ok(script.includes(phrase),phrase);
  assert.doesNotMatch(script,/fetch\(['"]\/progress|fetch\(['"]\/system\/health\/(?:report|probe)/);
  assert.match(script,/fetch\('\/system\/retry'/);
});
test('visual refresh preserves unknown, stale and failure semantics',()=>{
  const at='2026-09-05T07:00:00Z',now=Date.parse(at);
  const n={status:'healthy',last_attempt_at:at,stale_after_seconds:90};
  assert.equal(displayedState(n,now),'healthy');
  assert.equal(displayedState(n,now,true),'stale');
  assert.equal(displayedState(n,now+91000),'stale');
  assert.equal(displayedState({...n,kind:'unverified'},now,true),'unknown');
  assert.equal(displayedState({...n,status:'failed'},now),'failed');
  assert.equal(displayedState({...n,retry_job:{state:'failed',updated_at:'2026-09-05T07:00:05Z'}},now+5000),'failed');
  assert.equal(displayedState({...n,last_attempt_at:'2026-09-05T07:00:10Z',retry_job:{state:'failed',updated_at:'2026-09-05T07:00:05Z'}},now+10000),'healthy');
});
