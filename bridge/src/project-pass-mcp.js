// Separate project credentials and transport; the working school grant and its
// tool list never acquire project access. Only saved handoffs are exposed here.
import {state,digest,readBody} from './foundation.js';
import {PROJECT_PASS_SCOPES} from './project-pass-store.js';
import {PROJECT_PASS_TOOLS,executeProjectPassTool} from './project-pass-tools.js';

export const PROJECT_GRANT_DAYS=30;
export const APPROVED_PROJECT_IDS=Object.freeze(['instinct','job-search-planning']);
export const PROJECT_CLIENT_TOOLS=PROJECT_PASS_TOOLS.filter(t=>t.name!=='register_pass_project').map(t=>({...t,
  annotations:{readOnlyHint:t.name!=='save_project_pass',destructiveHint:false,idempotentHint:true,openWorldHint:false},
  outputSchema:{type:'object',additionalProperties:true}}));
const byName=new Map(PROJECT_CLIENT_TOOLS.map(t=>[t.name,t]));
const VERSIONS=['2025-11-25','2025-06-18','2025-03-26'];
const INFO={name:'sidekick-project-pass',version:'1.0.0'};
const CAPABILITIES={tools:{listChanged:false}};
const INSTRUCTIONS='Private original Sidekick project handoffs only. First list_pass_projects, resolve the exact authorized project from the user request, get_project_pass_protocol, then resume/read matching real handoffs and their current head revision. If the project is ambiguous ask; do not pick another project. Missing history is unknown. Save only authorized sourced facts, actual questions/responses/help, work completed, unresolved items and agreed next steps. Keep interpretations separate. Exact retries retain their packet/key; conflicts require a fresh read and reconciliation. Confirm matching receipt/readback. Sandbox records are only explicitly authorized synthetic tests. No filesystem, repository, inbox, finance, account, password, school, submission, deletion or project-registration access is granted.';
const json=(body,status=200,headers={})=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const epoch=env=>digest('original-sidekick-project-pass-epoch-v1:'+env.API_KEY);
const rpcError=(id,code,message,status=200)=>json({jsonrpc:'2.0',id,error:{code,message}},status);

export async function authenticateProjectClient(request,env) {
  if(!env.API_KEY)return null;
  const token=/^Bearer (pp1_[a-f0-9]{64})$/.exec(request.headers.get('Authorization')||'')?.[1];
  if(!token)return null;
  const result=await state(env).projectGrant('check',{hash:await digest(token),epoch:await epoch(env)});
  return result.ok?{client:result.client,project_ids:result.project_ids,scopes:result.scopes,expires_at:result.expires_at}:null;
}

export async function projectConnectionRoutes(request,env,path,auth) {
  if(!['/pass/projects/connection/grant','/pass/projects/connection/status','/pass/projects/connection/list','/pass/projects/connection/revoke'].includes(path))return null;
  // The broad bearer in the old school GPTs cannot administer projects. The
  // existing private owner browser session and same-origin write check apply.
  if(auth!=='session')return json({error:'project_owner_session_required'},403);
  if(!env.API_KEY)return json({error:'project_connection_unavailable'},503);
  const context={epoch:await epoch(env)};
  if(path==='/pass/projects/connection/list') {
    if(request.method!=='GET')return json({error:'method_not_allowed'},405);
    return json(await state(env).projectGrant('list',context));
  }
  if(path==='/pass/projects/connection/status') {
    if(request.method!=='GET')return json({error:'method_not_allowed'},405);
    const hash=new URL(request.url).searchParams.get('grant_id');if(!/^[a-f0-9]{64}$/.test(hash||''))return json({error:'invalid_grant_id'},400);
    return json(await state(env).projectGrant('check',{...context,hash}));
  }
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  if(!(request.headers.get('Content-Type')||'').toLowerCase().startsWith('application/json'))return json({error:'json_required'},415);
  let body;try{body=await readBody(request,2000);}catch{return json({error:'invalid_project_connection_request'},400);}
  if(path==='/pass/projects/connection/revoke') {
    if(Object.keys(body).some(k=>k!=='grant_id')||!/^[a-f0-9]{64}$/.test(body.grant_id||''))return json({error:'invalid_grant_id'},400);
    return json(await state(env).projectGrant('revoke',{...context,hash:body.grant_id}));
  }
  if(Object.keys(body).some(k=>!['client','project_ids','request_id'].includes(k))||!['claude','chatgpt'].includes(body.client)||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(body.request_id||'')||
    !Array.isArray(body.project_ids)||body.project_ids.length<1||body.project_ids.length>2||
    new Set(body.project_ids).size!==body.project_ids.length||body.project_ids.some(id=>!APPROVED_PROJECT_IDS.includes(id)))
    return json({error:'unsupported_project_connection_scope'},400);
  const project_ids=[...body.project_ids].sort();
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.API_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signed=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('original-sidekick-project-pass-v1:'+body.client+':'+body.request_id));
  const access_token='pp1_'+Array.from(new Uint8Array(signed),n=>n.toString(16).padStart(2,'0')).join('');
  const receipt=await state(env).projectGrant('create',{...context,hash:await digest(access_token),client:body.client,
    project_ids,scopes:PROJECT_PASS_SCOPES,expires:Date.now()+PROJECT_GRANT_DAYS*86400000});
  if(!receipt.ok)return json(receipt,receipt.status||503);
  // The secret is returned only to the owner for immediate secure-field entry.
  // No secret, request body or response is logged or persisted by this service.
  return json({...receipt,access_token,token_type:'Bearer',endpoint:new URL('/mcp/projects',request.url).href});
}

export const PROJECT_OPENAPI={openapi:'3.1.0',info:{title:'Sidekick project factual handoffs',version:'1.0.0',description:INSTRUCTIONS},
  servers:[{url:'https://ijuh2yp6rf.example-subdomain.workers.dev'}],security:[{projectBearer:[]}],
  components:{securitySchemes:{projectBearer:{type:'http',scheme:'bearer'}}},
  paths:Object.fromEntries(PROJECT_CLIENT_TOOLS.map(tool=>{
    const [head,...tail]=tool.name.split('_'),operationId=head+tail.map(s=>s[0].toUpperCase()+s.slice(1)).join('');
    return ['/pass/projects/client/tools/'+tool.name,{post:{operationId,summary:tool.name.replaceAll('_',' '),description:tool.description,
      'x-openai-isConsequential':tool.name==='save_project_pass',
      requestBody:{required:true,content:{'application/json':{schema:tool.inputSchema}}},
      responses:{'200':{description:'Complete project handoff result; confirmed saves include exact readback.',content:{'application/json':{schema:{type:'object',additionalProperties:true}}}},
        '400':{description:'Invalid request.'},'401':{description:'Separate project credential required.'},'403':{description:'Project outside this grant.'},'409':{description:'Revision/head/key conflict; reread and reconcile.'},'503':{description:'Unavailable or unconfirmed; retain exact retry packet.'}}}}];
  }))};

export async function projectClientRoute(request,env) {
  const url=new URL(request.url),origin=request.headers.get('Origin');
  if(url.search)return json({error:'invalid_project_client_url'},400);
  if(origin&&![url.origin,'https://claude.ai','https://chatgpt.com'].includes(origin))return json({error:'origin_denied'},403);
  const access=await authenticateProjectClient(request,env);
  if(!access)return json({error:'scoped_project_token_required'},401,{'WWW-Authenticate':'Bearer realm="Sidekick project handoffs", scope="'+PROJECT_PASS_SCOPES.join(' ')+'"'});
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  if(!(request.headers.get('Content-Type')||'').toLowerCase().startsWith('application/json'))return json({error:'json_required'},415);
  let body;try{body=await readBody(request,40000);}catch{return json({error:'invalid_project_request'},400);}
  if(url.pathname.startsWith('/pass/projects/client/tools/')) {
    const name=url.pathname.slice('/pass/projects/client/tools/'.length);
    if(!byName.has(name))return json({error:'unknown_project_pass_tool'},404);
    const out=await executeProjectPassTool(name,body,env,access);return json(out,out.error?(out.status||400):200);
  }
  const hasId=Object.hasOwn(body,'id'),id=hasId?body.id:null,params=body.params||{};
  if(body.jsonrpc!=='2.0'||typeof body.method!=='string'||body.method.length>120||
    hasId&&!(typeof id==='string'&&id.length<=128||Number.isSafeInteger(id))||!object(params))return rpcError(null,-32600,'Invalid request',400);
  const version=request.headers.get('MCP-Protocol-Version');
  const meta=params._meta?.['io.modelcontextprotocol/protocolVersion'];
  if(version&&meta&&version!==meta)return rpcError(id,-32600,'Protocol header mismatch',400);
  if(body.method==='server/discover')return json({jsonrpc:'2.0',id,result:{resultType:'complete',supportedVersions:VERSIONS,capabilities:CAPABILITIES,
    _meta:{'io.modelcontextprotocol/serverInfo':INFO},instructions:INSTRUCTIONS,ttlMs:0,cacheScope:'private'}});
  if(body.method!=='initialize'&&version&&!VERSIONS.includes(version))return rpcError(id,-32022,'Unsupported protocol version',400);
  if(body.method==='initialize') {
    if(!hasId||typeof params.protocolVersion!=='string')return rpcError(id,-32602,'Invalid initialization parameters',400);
    return json({jsonrpc:'2.0',id,result:{protocolVersion:VERSIONS.includes(params.protocolVersion)?params.protocolVersion:VERSIONS[0],capabilities:CAPABILITIES,serverInfo:INFO,instructions:INSTRUCTIONS}});
  }
  if(!hasId)return ['notifications/initialized','notifications/cancelled'].includes(body.method)?new Response(null,{status:202}):rpcError(null,-32600,'Unsupported notification',400);
  if(body.method==='ping')return json({jsonrpc:'2.0',id,result:{}});
  if(body.method==='tools/list')return params.cursor===undefined?json({jsonrpc:'2.0',id,result:{tools:PROJECT_CLIENT_TOOLS}}):rpcError(id,-32602,'Unknown tools cursor');
  if(body.method!=='tools/call')return rpcError(id,-32601,'Method not found');
  if(!byName.has(params.name))return rpcError(id,-32602,'Unknown tool');
  const out=await executeProjectPassTool(params.name,params.arguments??{},env,access);
  return json({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(out)}],structuredContent:out,isError:Boolean(out.error)}});
}
