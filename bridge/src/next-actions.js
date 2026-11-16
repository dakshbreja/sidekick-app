/** Read-only planning projection. Calendar dates are evidence of deadlines,
 * never submission receipts. Nothing here writes progress, learning or PASS. */
import {TERM_ID} from './identity.js';
import {TZ} from './status.js';
const LISTS=['overdue','due_today','due_this_week','other_courses_this_week','upcoming'];
const text=(value,max=200)=>/\b(?:grades?|scores?|marks?)\s*(?:[:=]|is\b|of\b)\s*\d|\b(?:Bearer\s+\S+|access_token\s*=)/i.test(String(value))?'Private detail omitted.':String(value??'').replace(/<[^>]*>/g,'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);
const dateKey=value=>new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
export function evidenceUrl(value){
  try{if(!/^https?:\/\//i.test(value)||/[\u0000-\u0020\u007f\\]/.test(value))return null;const u=new URL(value);
    if(!['https:','http:'].includes(u.protocol)||u.username||u.password||/\/calendar\/ical\//i.test(u.pathname)||[...u.searchParams.keys()].some(k=>/^(?:access_token|refresh_token|token|secret|password|api_key|key|code|state)$/i.test(k)))return null;
    return u.href;
  }catch{return null;}
}
export function sourceLinks(row){
  const links=[];const seen=new Set();
  for(const raw of [row.url,row.source_url,...String(row.detail||'').matchAll(/https?:\/\/[^\s<>"|]+/gi)].map(x=>Array.isArray(x)?x[0]:x)){
    if(!raw)continue;const url=evidenceUrl(String(raw).replace(/&amp;/g,'&').replace(/[).,;]+$/,''));
    if(url&&!seen.has(url)){seen.add(url);links.push({url,label:/uga\.view\.usg\.edu/.test(url)?'Original eLC source':'Original calendar link',kind:'original_source_link'});}
    if(links.length===4)break;
  }
  if(!links.length)links.push({url:'/status?course='+encodeURIComponent(row.course_code||''),label:'Bridge calendar evidence (JSON; original receipt unavailable)',kind:'bridge_calendar_projection'});
  return links;
}
export function isGlobus(row){return row.course_code==='MGMT5560'&&/\bglo[\s-]*bus\b/i.test(row.title||'');}
export function buildNextActions(status,{now=new Date()}={}){
  if(status.term_id&&status.term_id!==TERM_ID)throw Error('wrong_term');
  const scope=status.course?.code||status.actionable?.scope||'ALL';
  const full=new Map();for(const list of LISTS)for(const row of status[list]||[])if(row.assignment_id)full.set(row.assignment_id,row);
  const watcher=(status.source_health||[]).find(n=>n.id==='globus-watch');
  const last=Date.parse(watcher?.last_success_at),age=now-last;
  const watcherFresh=watcher?.status==='healthy'&&Number.isFinite(last)&&age>=-60000&&age<=432000000;
  const watcherState=watcher?.status==='stale'||Number.isFinite(last)&&age>432000000?'stale':watcher?.status==='healthy'&&(!Number.isFinite(last)||age < -60000)?'unknown':watcher?.status||'unknown';
  const rows=(status.actionable?.outstanding||[]).filter(row=>row.assignment_id&&row.completed!==true&&(!row.term_id||row.term_id===TERM_ID)&&(scope==='ALL'||row.course_code===scope)).map(base=>{
    const original=full.get(base.assignment_id)||base;const uncertain=isGlobus(base)&&base.bucket==='overdue'&&!watcherFresh;
    return {assignment_id:base.assignment_id,term_id:TERM_ID,course_code:base.course_code||null,course:text(base.course,80),title:text(base.title),
      when:text(base.when,120),when_iso:base.when_iso,bucket:base.bucket,completed:false,
      status:uncertain?'unverified':base.bucket,verification:uncertain?'unverified': 'calendar_deadline_only',
      ...(uncertain?{status_label:'unverified — watcher '+watcherState,uncertainty:{source:'globus-watch',state:watcherState,last_success_at:watcher?.last_success_at||null,reason:'No current original-source completion receipt is established by this calendar occurrence.'}}:{}),
      source_evidence:{basis:'calendar_deadline',checked_at:status.generated_at||now.toISOString(),links:sourceLinks(original),submission_verified:false},
      ...(base.date_reconciliation?{date_reconciliation:base.date_reconciliation}:{})};
  });
  const byDate=(a,b)=>String(a.when_iso).localeCompare(String(b.when_iso))||a.assignment_id.localeCompare(b.assignment_id);
  const unverified=rows.filter(r=>r.status==='unverified').sort(byDate),known=rows.filter(r=>r.status!=='unverified');
  const overdue=known.filter(r=>r.bucket==='overdue').sort(byDate),today=known.filter(r=>r.bucket==='due_today').sort(byDate),week=known.filter(r=>['due_this_week','other_courses_this_week'].includes(r.bucket)).sort(byDate);
  const candidates=known.filter(r=>Date.parse(r.when_iso)>now&&/\b(exam|midterm|final|project|research assignment)\b/i.test(r.title)&&!/^week\s*\d|\b(?:prep|practice|study|review block)\b/i.test(r.title)).sort(byDate);
  let hard=candidates[0]||null;
  if(hard){const unconfirmed=hard.date_reconciliation?.time_verification==='unconfirmed';
    hard={...hard,seconds_until:unconfirmed?null:Math.max(0,Math.floor((Date.parse(hard.when_iso)-now)/1000)),date_key:dateKey(hard.when_iso),countdown_basis:unconfirmed?'confirmed_date_time_unknown':'calendar_deadline',related_open_items:[]};
    // A user-requested planning association, not an inferred prerequisite or a
    // changed due date. Bind term/course/exam occurrence so it cannot leak later.
    if(TERM_ID==='fall-2026'&&hard.course_code==='LAND2510'&&/^Exam\s*#?\s*3$/i.test(hard.title)&&hard.date_key==='2026-11-04'){
      hard.related_open_items=known.filter(r=>r.course_code==='LAND2510'&&/^(?:22|23|24)\s*_/.test(r.title)).sort((a,b)=>a.title.localeCompare(b.title));
      hard.related_items_basis='User requested exam preparation links on 2026-11-03. Original quiz deadlines remain unchanged; no eligibility or mastery is inferred.';
    }
  }
  const order=[],seen=new Set();const add=row=>{if(row&&!seen.has(row.assignment_id)){seen.add(row.assignment_id);order.push(row.assignment_id);}};
  if(hard&&Date.parse(hard.when_iso)-now<=3*86400000){add(hard);hard.related_open_items.forEach(add);}
  today.forEach(add);overdue.forEach(add);week.forEach(add);add(hard);
  const feeds=status.feed_health||[];const complete=feeds.length>0&&feeds.every(f=>f.ok&&f.coverage_complete!==false);
  return {ok:true,version:'next-actions/1',read_only:true,generated_at:now.toISOString(),timezone:TZ,term_id:TERM_ID,scope,
    availability:complete?'calendar_sources_available':'partial_or_unknown',
    horizon:status.actionable?.horizon||{overdue_lookback_days:10,due_window_days:7,upcoming_window_days:21},
    next_hard_deadline:hard,overdue,due_today:today,due_this_week:week,unverified,priority_order:order,
    counts:{overdue:overdue.length,due_today:today.length,due_this_week:week.filter(r=>r.bucket==='due_this_week').length,other_courses_this_week:week.filter(r=>r.bucket==='other_courses_this_week').length,unverified:unverified.length,outstanding:rows.length},
    source_health:{calendar_feeds:feeds.map(f=>({source:text(f.source,80),ok:f.ok===true,coverage_complete:f.coverage_complete!==false})),globus_watcher:{state:watcherState,last_success_at:watcher?.last_success_at||null,last_attempt_at:watcher?.last_attempt_at||null}},
    limitations:['Calendar dates do not prove submission, completion or mastery.','An empty or partial view does not establish that nothing is due.','Stale or unavailable GLO-BUS completion coverage is retained separately, never silently cleared.'],
    priority_policy:'Hard deadline within 72 hours and its explicitly linked open preparation first; then due today, overdue, and due this week. Review unverified items separately.'};
}
