import {LEARNER_TOOLS,LEARNER_STARTUP} from './learner-tools.js';
import {learnerRoutes} from './learner-routes.js';
import {readBody} from './foundation.js';
const json=(v,s=200)=>Response.json(v,{status:s,headers:{'Cache-Control':'no-store'}});
// Separate owner adapter. Existing scoped school/project MCPs remain unchanged.
// No enrollment, credential issuance or student decision tool lives here.
export async function learnerMcp(request,env,auth){
  if(auth!=='bearer')return json({error:'owner_bearer_required'},403);
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  let b;try{b=await readBody(request,22000);}catch{return json({error:'invalid_mcp_request'},400);}
  const error=(code,message)=>json({jsonrpc:'2.0',id:b.id??null,error:{code,message}});
  if(b.jsonrpc!=='2.0'||typeof b.method!=='string')return error(-32600,'Invalid request');
  if(!Object.hasOwn(b,'id'))return b.method==='notifications/initialized'?new Response(null,{status:202}):error(-32600,'Request ID required');
  let result;
  if(b.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{listChanged:false}},serverInfo:{name:'original-sidekick-learner-owner',version:'1.0.0'},instructions:LEARNER_STARTUP};
  else if(b.method==='ping')result={};
  else if(b.method==='tools/list')result={tools:LEARNER_TOOLS};
  else if(b.method==='tools/call'){
    const name=b.params?.name;if(!LEARNER_TOOLS.some(t=>t.name===name))return error(-32602,'Unknown learner tool');
    const response=await learnerRoutes(new Request(new URL('/learner/tools/'+name,request.url),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b.params?.arguments??{})}),env,'/learner/tools/'+name,'bearer');
    const value=await response.json();result={content:[{type:'text',text:JSON.stringify(value)}],isError:!response.ok,structuredContent:value};
  }else return error(-32601,'Method not found');
  return json({jsonrpc:'2.0',id:b.id,result});
}
