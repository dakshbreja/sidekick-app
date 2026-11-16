// Local workerd harness only. NEVER use this as a deployment entry.
import worker from '../src/worker.js';
import {BridgeState} from '../src/state-object.js';
export class FixtureBridgeState extends BridgeState {
  fixturePrepare() {return this.records.beginMigration(Date.now()-120001);}
}
export default {
  async fetch(request,env,ctx) {
    if(new URL(request.url).pathname==='/__test/prepare' && request.headers.get('Authorization')==='Bearer runtime-fixture-key') {
      await env.NOTES.put('progress:GENERAL',JSON.stringify([{item:'Runtime assignment',status:'done',at:'2026-08-22T10:00:00.000Z',verification:'reported',note:'Synthetic legacy fixture'}]));
      return Response.json(await env.BRIDGE_STATE.getByName('personal-bridge-v1').fixturePrepare());
    }
    return worker.fetch(request,env,ctx);
  }
};
