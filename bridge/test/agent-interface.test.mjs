import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {AGENT_CONTRACT} from '../src/agents-page.js';
import {PASS_TOOLS} from '../src/pass-tools.js';
import {MCP_SCOPES} from '../src/pass-mcp.js';
import {readFileSync} from 'node:fs';

test('public agent documentation never reads owner credentials or student storage',async()=>{
  const env={};for(const key of ['API_KEY','NOTES','BRIDGE_STATE','FEED_ELC','FEED_PERSONAL'])Object.defineProperty(env,key,{get(){throw Error('private read');}});
  for(const path of ['/agents','/agents/contract']){const r=await worker.fetch(new Request('https://bridge.test'+path),env);assert.equal(r.status,200);assert.equal(r.headers.get('set-cookie'),null);assert.equal(r.headers.get('cache-control'),'no-store');}
});
test('documented PASS schemas, scope bundle and current onboarding limits are the actual unchanged contract',()=>{
  assert.deepEqual(AGENT_CONTRACT.tools,PASS_TOOLS);assert.deepEqual(AGENT_CONTRACT.onboarding.scopes,MCP_SCOPES);assert.equal(AGENT_CONTRACT.onboarding.grant_days,30);assert.equal(AGENT_CONTRACT.onboarding.supported_school_grant_client,'claude');
  assert.match(AGENT_CONTRACT.onboarding.current_limit,/design only/);assert.match(AGENT_CONTRACT.onboarding.priorities_auth,/insufficient/);
});
test('agent guide covers revision, uncertain retries, protocol protection and provenance without real handoffs',async()=>{
  const r=await worker.fetch(new Request('https://bridge.test/agents?token=should-not-reflect'),{});const html=await r.text();
  for(const pattern of [/PASS is the product/,/idempotency_key/,/expected_revision/,/fresh exact-ID/,/no student records/,/\/next-actions/])assert.match(html,pattern);
  assert.doesNotMatch(html,/should-not-reflect|111978e9-dcba|9012d77f-112b|<script\b|<img\b|<form\b/);assert.match(r.headers.get('content-security-policy'),/default-src 'none'/);
});
test('documentation HEAD and read-only methods do not trigger credential provisioning',async()=>{
  const head=await worker.fetch(new Request('https://bridge.test/agents',{method:'HEAD'}),{});assert.equal(head.status,200);assert.equal(await head.text(),'');
  const post=await worker.fetch(new Request('https://bridge.test/agents/contract',{method:'POST'}),{});assert.equal(post.status,405);
});
test('multi-student document is explicitly design only with isolation, least privilege and no migration claim',()=>{
  const d=readFileSync(new URL('../../docs/MULTI-TENANT.md',import.meta.url),'utf8');for(const pattern of [/Design only/,/write-checkpoint/,/revocation/,/cross-student/,/No new tenancy[\s\S]*implemented/,/revision 2/])assert.match(d,pattern);
});
