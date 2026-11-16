import {test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedMigrationLinks} from '../src/migration-links.js';
import {sqliteFoundation} from './sqlite-fixture.js';
import {TERM_ID,eventIdentity} from '../src/identity.js';
const at='2026-08-22T10:00:00.000Z',when='2026-09-06T12:00:00.000Z';
const original={item:'Quiz 04',status:'done',at,note:'Reported by user; not independently verified',verification:'reported',evidence:null};
const snapshot={term_id:TERM_ID,progress:{GENERAL:[original,{item:'Older',status:'done',at}]},classnote:{GENERAL:[{text:'Keep all notes'}]}};
const id=eventIdentity({uid:'approved-one',source:'personal'});
const deadline={course_code:null,title:'Quiz 04: History',when_iso:when,assignment_id:id,assignment_refs:[id],source_namespace:'google'};
const approved={course:'GENERAL',current_title:deadline.title,when_iso:when,reported_item:original.item,reported_at:at};
test('reviewed migration links preserve original fields and become ready atomically',t=>{
  const f=sqliteFoundation({ready:false});t.after(()=>f.close());
  const links=approvedMigrationLinks(snapshot,[approved],[deadline]);
  const start=f.store.beginMigration(Date.now());
  assert.equal(f.store.list('progress',['GENERAL']).status,503);
  const result=f.store.initialize(snapshot,'digest',start.not_before,links);
  assert.equal(result.imported,3);assert.equal(result.linked,1);assert.equal(f.store.health().ready,true);
  const linked=f.store.list('progress',['GENERAL']).records.find(r=>r.assignment_id);
  for(const [k,v] of Object.entries(original))assert.deepEqual(linked[k],v);
  assert.equal(linked.revision,1);assert.equal(linked.identity_match_method,'explicit_reference');
  assert.deepEqual(f.store.history(linked.record_id).history[0].data.original,original);
  assert.equal(f.store.list('progress',['GENERAL']).records.filter(r=>!r.assignment_id).length,1);
  assert.equal(f.store.initialize(snapshot,'digest',start.not_before,links).already_initialized,true);
});
test('changed, duplicate, ambiguous, or missing approval anchors abort before import',()=>{
  for(const change of [{reported_at:'changed'},{reported_item:'changed'},{current_title:'Changed'},{when_iso:'changed'}])
    assert.throws(()=>approvedMigrationLinks(snapshot,[{...approved,...change}],[deadline]),/approved_reference_changed/);
  assert.throws(()=>approvedMigrationLinks(snapshot,[approved,approved],[deadline]),/duplicate_approved_link/);
  assert.throws(()=>approvedMigrationLinks(snapshot,[approved],[deadline,{...deadline,assignment_id:id+'x'}]),/approved_reference_changed/);
  assert.throws(()=>approvedMigrationLinks(snapshot,{},[deadline]),/invalid_approved_links/);
});
test('failed reviewed import rolls back rows, history, and readiness together',t=>{
  const f=sqliteFoundation({ready:false});t.after(()=>f.close());
  const links=approvedMigrationLinks(snapshot,[approved],[deadline]),start=f.store.beginMigration(Date.now());
  assert.throws(()=>f.store.initialize(snapshot,'digest',start.not_before,[...links,{...links[0],record_id:'missing'}]),/approved_record_missing/);
  assert.equal(f.store.health().ready,false);assert.deepEqual(f.store.health().counts,[]);
  assert.equal(f.store.history(links[0].record_id).history.length,0);
  assert.equal(f.store.initialize(snapshot,'digest',start.not_before,links).linked,1);
});
