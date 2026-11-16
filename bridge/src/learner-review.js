import {state} from './foundation.js';
export async function addLearnerReviews(actions,env,course=null){
  try{const p=await state(env).learnerProfile({course,sandbox:false});if(p?.ok!==true)throw Error();
    const reviews=p.reviews.map(r=>({...r,source_evidence:{basis:'Recorded practice responses; hypotheses remain hypotheses.',links:r.evidence_links}}));
    return {...actions,reviews,review_status:'available',review_priority_order:reviews.map(r=>r.review_id),review_instruction:'Run retrieval practice before hints or re-explanation; capture stated confidence before the answer.'};
  }catch{return {...actions,reviews:[],review_status:'unavailable',review_warning:'Practice evidence could not be read; review priorities are unknown.'};}
}
