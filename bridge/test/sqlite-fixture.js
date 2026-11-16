import { DatabaseSync } from 'node:sqlite';
import { RecordStore } from '../src/record-store.js';
import { ProjectPassStore } from '../src/project-pass-store.js';
import { TERM_ID } from '../src/identity.js';
import { LearningStore } from '../src/learning-store.js';
import {LearnerStore} from '../src/learner-store.js';

export function sqliteFoundation({ready=true,snapshot=null}={}) {
  const db=new DatabaseSync(':memory:');
  const storage={
    sql:{exec(query,...args){
      if(!args.length && /CREATE TABLE/.test(query)){db.exec(query);return {toArray:()=>[]};}
      const rows=db.prepare(query).all(...args);return {toArray:()=>rows};
    }},
    transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(err){db.exec('ROLLBACK');throw err;}},
  };
  const store=new RecordStore(storage);
  const learningStore=new LearningStore(storage);
  const learnerStore=new LearnerStore(storage);
  const projectPassStore=new ProjectPassStore(storage);
  let now=Date.now();
  if(ready){store.beginMigration(now-120001);store.initialize(snapshot || {term_id:TERM_ID,progress:{},classnote:{}},'fixture',now);}
  const stub={health:async()=>store.health(),beginMigration:async()=>store.beginMigration(now),
    initialize:async(s,d,l)=>store.initialize(s,d,now,l),list:async(k,c)=>store.list(k,c),
    projectGrant:async(a,d)=>projectPassStore.grant(a,d,now),
    projectPass:async(a,d,access)=>projectPassStore.call(a,d,access),
    passRead:async(options)=>store.passRead(options),
    mutate:async(c)=>store.mutate(c),receipt:async(i,f)=>store.receipt(i,f),history:async(i)=>store.history(i),
    session:async(a,d)=>store.session(a,d,now),loginAttempt:async(b,c)=>store.loginAttempt(b,now,c),
    passGrant:async(a,d)=>store.passGrant(a,d,now),
    learningGet:async(c,t,s)=>learningStore.get(c,t,s),learningPut:async(c)=>learningStore.put(c),
    learnerProfile:async(s)=>learnerStore.profile(s,new Date().toISOString(),true),learnerItems:async(s)=>learnerStore.itemsRead(s),learnerPut:async(c)=>learnerStore.put(c)};
  return {store,learningStore,learnerStore,projectPassStore,storage,db,stub,binding:{getByName:()=>stub},advance:ms=>{now+=ms;},close:()=>db.close()};
}
