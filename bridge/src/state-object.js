import { DurableObject } from 'cloudflare:workers';
import { RetryStore } from './retry-store.js';
import { ClubStore } from './clubs-store.js';
import { RecordStore } from './record-store.js';
import { ProjectPassStore } from './project-pass-store.js';
import { AnnouncementStore } from './announcement-store.js';
import { LearningStore } from './learning-store.js';
import {LearnerStore} from './learner-store.js';
import {importPassBackfill,APPROVED_BACKFILL_IDS} from './pass-backfill.js';
import {digest,stableJSON} from './foundation.js';

// One coordination object for this personal bridge, not a shared multi-user DO.
export class BridgeState extends DurableObject {
  constructor(ctx, env) { super(ctx,env); this.records=new RecordStore(ctx.storage); this.projectPasses=new ProjectPassStore(ctx.storage); this.clubs=new ClubStore(ctx.storage); this.retries=new RetryStore(ctx.storage); this.announcements=new AnnouncementStore(ctx.storage); this.learning=new LearningStore(ctx.storage); this.learner=new LearnerStore(ctx.storage); }
  learnerProfile(scope) {return this.learner.profile(scope,new Date().toISOString(),true);}
  learnerItems(scope) {return this.learner.itemsRead(scope);}
  learnerPut(command) {return this.learner.put(command);}
  async learnerBackfill(body){
    const receipts=APPROVED_BACKFILL_IDS.map(record_id=>this.records.passRead({record_id,course:'BUSN5000',sandbox:false}).record);
    if(receipts.some(r=>!r))return {error:'backfill_source_unavailable',status:409};
    const fingerprint=await digest(stableJSON(body));
    // Re-read after the async digest; no await separates this source check and
    // the atomic learner-only import. Neither original records nor protocol move.
    if(receipts.some(r=>stableJSON(this.records.passRead({record_id:r.record_id,course:'BUSN5000',sandbox:false}).record)!==stableJSON(r)))return {error:'backfill_source_changed',status:409};
    return importPassBackfill(this.learner,body,receipts,fingerprint,new Date().toISOString());
  }
  learningGet(course,term,sandbox=false) { return this.learning.get(course,term,sandbox); }
  learningPut(command) { return this.learning.put(command); }
  announcementGet() { return this.announcements.get(); }
  announcementPut(command) { return this.announcements.put(command); }
  announcementReceipt(operation_id,fingerprint) { return this.announcements.receipt(operation_id,fingerprint); }
  announcementEvidence() { return this.announcements.evidence(); }
  retryList() { return this.retries.list(); }
  retryRequest(...args) { return this.retries.request(...args); }
  retryClaim() { return this.retries.claim(); }
  retryFinish(...args) { return this.retries.finish(...args); }
  clubOverview() { return this.clubs.overview(); }
  clubGet(kind,id) { return this.clubs.get(kind,id); }
  clubPut(...args) { return this.clubs.put(...args); }
  clubSearch(...args) { return this.clubs.search(...args); }
  health() { return this.records.health(); }
  beginMigration() { return this.records.beginMigration(Date.now()); }
  initialize(snapshot,digest,links=[]) { return this.records.initialize(snapshot,digest,Date.now(),links); }
  list(kind,courses) { return this.records.list(kind,courses); }
  projectGrant(action,data) { return this.projectPasses.grant(action,data,Date.now()); }
  projectPass(action,args,access) { return this.projectPasses.call(action,args,access); }
  passRead(options) { return this.records.passRead(options); }
  receipt(id,fingerprint) { return this.records.receipt(id,fingerprint); }
  mutate(command) { return this.records.mutate(command); }
  history(record_id) { return this.records.history(record_id); }
  session(action,data) { return this.records.session(action,data,Date.now()); }
  passGrant(action,data) { return this.records.passGrant(action,data,Date.now()); }
  loginAttempt(bucket,clear=false) { return this.records.loginAttempt(bucket,Date.now(),clear); }
}
