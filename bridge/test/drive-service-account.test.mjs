import {test} from 'node:test';
import assert from 'node:assert/strict';
import {serviceAccountAssertion, serviceAccountToken} from '../src/drive-service-account.js';
import {driveConfigured, libraryRootId} from '../src/drive.js';
import {probeDriveAccess} from '../src/drive-health.js';

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString());

async function credentials() {
  const keys = await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,
    publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.toString('base64')}\n-----END PRIVATE KEY-----`;
  return {keys, data:{type:'service_account',client_email:'course-reader@example.iam.gserviceaccount.com',private_key:pem}};
}

test('service-account assertion has only the read-only scope and a valid one-hour signature', async () => {
  const {keys,data} = await credentials();
  const jwt = await serviceAccountAssertion(data, Date.parse('2026-09-15T12:00:00Z'));
  const [head,claims,signature] = jwt.split('.');
  assert.deepEqual(decode(head),{alg:'RS256',typ:'JWT'});
  const body = decode(claims);
  assert.equal(body.iss,data.client_email);
  assert.equal(body.scope,'https://www.googleapis.com/auth/drive.readonly');
  assert.equal(body.aud,'https://oauth2.googleapis.com/token');
  assert.equal(body.exp-body.iat,3600);
  assert.equal(body.sub,undefined);
  assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5',keys.publicKey,
    Buffer.from(signature,'base64url'),new TextEncoder().encode(`${head}.${claims}`)),true);
});

test('service-account root bypasses the personal Drive path and probe checks the shared folder', async () => {
  const {data} = await credentials();
  const env={GDRIVE_SERVICE_ACCOUNT_JSON:JSON.stringify(data),GDRIVE_ROOT_ID:'fall-course-root'};
  assert.equal(driveConfigured(env),true);
  assert.equal(await libraryRootId(env),'fall-course-root');
  const calls=[];
  const result=await probeDriveAccess(env,async(url,options)=>{
    calls.push({url,options});
    if(url.includes('oauth2.googleapis.com')) {
      const body=new URLSearchParams(options.body);
      assert.equal(body.get('grant_type'),'urn:ietf:params:oauth:grant-type:jwt-bearer');
      assert.equal(decode(body.get('assertion').split('.')[1]).scope,'https://www.googleapis.com/auth/drive.readonly');
      return new Response(JSON.stringify({access_token:'fixture-token',expires_in:3600}));
    }
    return new Response(JSON.stringify({id:'fall-course-root',mimeType:'application/vnd.google-apps.folder'}));
  });
  assert.equal(result.outcome,'healthy');
  assert.equal(calls.length,2);
  assert.match(calls[1].url,/files\/fall-course-root\?fields=id,mimeType$/);
  assert.equal(calls[1].options.headers.Authorization,'Bearer fixture-token');
  assert.doesNotMatch(JSON.stringify(result),/fixture-token|PRIVATE KEY/);
});

test('a denied shared folder cannot become a healthy connection', async () => {
  const {data}=await credentials();
  const env={GDRIVE_SERVICE_ACCOUNT_JSON:JSON.stringify(data),GDRIVE_ROOT_ID:'fall-course-root'};
  const result=await probeDriveAccess(env,async url=>url.includes('oauth2.googleapis.com')
    ? new Response(JSON.stringify({access_token:'fixture-token'}))
    : new Response('private-provider-detail',{status:403}));
  assert.equal(result.outcome,'failed');
  assert.equal(result.reason,'api');
  assert.doesNotMatch(JSON.stringify(result),/private-provider-detail|fixture-token|PRIVATE KEY/);
  await assert.rejects(serviceAccountToken('{}',async()=>{throw new Error('must not fetch')}),
    /service_account_authorization_failed/);
});
