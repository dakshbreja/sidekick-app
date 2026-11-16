import {test} from 'node:test';
import assert from 'node:assert/strict';
import {search} from '../src/drive.js';

for (const query of ['craft beer', 'value chain', "Porter's rivalry"] ) {
  test(`concept search retains course boundary and safe query escaping: ${query}`, async () => {
    const saved=globalThis.fetch;
    const env={GDRIVE_SERVICE_ACCOUNT_JSON:'unused-cached-credential',GDRIVE_ROOT_ID:'fall',
      NOTES:{get:async()=>JSON.stringify({token:'test-token',expires_at:new Date(Date.now()+3600000).toISOString()})}};
    const queries=[];
    globalThis.fetch=async url=>{
      const q=new URL(url).searchParams.get('q'); queries.push(q);
      if(q.includes("mimeType =")) {
        const files=q.startsWith("'fall'") ? [{id:'mgmt',name:'MGMT 5560 '},{id:'other',name:'BUSN 5000'}] : [];
        return new Response(JSON.stringify({files}));
      }
      assert.match(q,/\('mgmt' in parents\)/);
      assert.doesNotMatch(q,/'other' in parents/);
      assert.match(q,/ and trashed = false and \(name contains /);
      const escaped=query.replaceAll("'","\\'");
      assert.ok(q.includes(`or fullText contains '"${escaped}"'`));
      return new Response(JSON.stringify({files:[{id:'sep9',name:'MGMT5560_Cluely_2026-09-09.txt',parents:['mgmt']}]}));
    };
    try {
      const result=await search(env,{courseFolder:'MGMT 5560',query});
      assert.equal(result[0].doc_id,'sep9');
      assert.equal(result[0].folder,'MGMT 5560');
    } finally {globalThis.fetch=saved;}
  });
}
