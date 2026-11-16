// Shared browser controller. An uncertain POST keeps its request ID for safe retry.
export const retryClient = String.raw`
function retryCooldown(job){return job&&!['queued','running'].includes(job.state)?Math.max(0,Math.ceil((Date.parse(job.requested_at)+60000-Date.now())/1000)):0;}
const retryPending=new Set(),retryKeys=new Map(),retryMessages=new Map();
async function requestRetry(node){
 if(retryPending.has(node))return;
 retryPending.add(node);retryMessages.set(node,'Sending retry request…');onRetryChange();
 const key=retryKeys.get(node)||crypto.randomUUID();retryKeys.set(node,key);
 try{
  const r=await fetch('/system/retry',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({node,request_id:key}),signal:AbortSignal.timeout(15000)});
  const d=await r.json();if(!r.ok)throw Error(r.status===401?'Sign in again to retry.':d.error==='manual_check_required'?'This service needs a manual connection check.':'Could not start the retry. Try again.');
  retryKeys.delete(node);retryMessages.set(node,d.job.message);await onRetryResult(node,d.job);
 }catch(e){retryMessages.set(node,e.name==='TimeoutError'?'Response timed out. The retry may have started; try again safely to check.':e.message);}
 finally{retryPending.delete(node);onRetryChange();}
}
`;
