/** Authenticated dashboard at /app. Live status, opaque browser sessions,
 * revision-aware writes and a device-local pending-save queue. */
import {DASHBOARD_VIEW_JS,dashboardTheme} from './dashboard-view.js';
import {AGENDA_VIEW_JS,agendaTheme} from './agenda-view.js';
import {PASS_VIEW_JS,passTheme} from './pass-view.js';
import {NEXT_ACTIONS_VIEW_JS,nextActionsTheme} from './next-actions-view.js';
import {LEARNER_VIEW_JS,learnerTheme} from './learner-view.js';
import {sidekickTheme} from './sidekick-theme.js';

const CSS = String.raw`
:root{
  --bg:#f4f2ee; --card:#fff; --sunk:#faf9f6;
  --ink:#191817; --ink2:#4b4640; --muted:#6f6961; --rule:#e3ded4; --rule2:#d2ccbf;
  --bar:#1f1e1c; --bar-ink:#f2efe8; --bar-muted:#9b948a;
  --c-BUSN5000:#c0392b; --c-MGMT4280:#0277bd; --c-MGMT5560:#0b8043;
  --c-MGMT5850:#b07d16; --c-LAND2510:#8e24aa; --c-BUSN3040:#00838f; --c-default:#6f6961;
  --ok:#0b8043; --warn:#b07d16; --crit:#c0392b;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#141312; --card:#1e1d1a; --sunk:#191816;
  --ink:#f2efe8; --ink2:#cec8bd; --muted:#9a9389; --rule:#2e2c27; --rule2:#3b3830;
  --bar:#0e0d0c; --bar-ink:#f2efe8; --bar-muted:#8c867d;
  --c-BUSN5000:#e8514c; --c-MGMT4280:#0e97d4; --c-MGMT5560:#189b57;
  --c-MGMT5850:#b08f22; --c-LAND2510:#a855c7; --c-BUSN3040:#12a0ab;
  --ok:#189b57; --warn:#b08f22; --crit:#e8514c;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-size:15px;line-height:1.5}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}

.topbar{background:var(--bar);color:var(--bar-ink);padding:13px 22px;display:flex;
  align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.topbar h1{font-size:15px;font-weight:640;margin:0;letter-spacing:-.01em}
.topbar .sub{font-size:12px;color:var(--bar-muted);margin-top:2px}
.tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.btn{background:transparent;color:var(--bar-ink);border:1px solid #4a4740;border-radius:5px;
  padding:6px 11px;font:inherit;font-size:12.5px;cursor:pointer}
.btn:hover{border-color:#6f6a61}
.btn:focus-visible{outline:2px solid var(--bar-ink);outline-offset:2px}
.live{font-size:11.5px;color:var(--bar-muted);display:flex;align-items:center;gap:6px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--ok);display:inline-block}
.dot.stale{background:var(--warn)} .dot.bad{background:var(--crit)}

.tabs{background:var(--bar);display:flex;gap:2px;padding:0 22px;overflow-x:auto}
.tab{padding:9px 14px;font-size:12.5px;color:var(--bar-muted);cursor:pointer;
  border:0;background:none;font-family:inherit;border-bottom:2px solid transparent;white-space:nowrap}
.tab[aria-selected="true"]{color:var(--bar-ink);border-bottom-color:var(--bar-ink)}
.tab:focus-visible{outline:2px solid var(--bar-ink);outline-offset:-4px}

.kpis{position:sticky;top:0;z-index:5;display:grid;
  grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:1px;
  background:var(--rule);border-bottom:1px solid var(--rule2)}
.kpi{background:var(--card);padding:13px 18px}
.kpi .k{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:650}
.kpi .v{font-size:26px;font-weight:640;letter-spacing:-.03em;line-height:1.1;margin-top:4px}
.kpi .s{font-size:11.5px;color:var(--muted);margin-top:2px}
.kpi.alarm{background:var(--sunk)} .kpi.alarm .v{color:var(--crit)}
.item .ev{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--warn);font-weight:650}
.item .ev.ok{color:var(--ok)}

.wrap{padding:20px 22px 90px;max-width:1180px}
.panel{background:var(--card);border:1px solid var(--rule);border-radius:7px;
  padding:15px 17px;margin-bottom:13px}
.panel h2{font-size:11.5px;letter-spacing:.11em;text-transform:uppercase;color:var(--muted);
  font-weight:650;margin:0 0 11px}
.empty{color:var(--muted);font-size:13.5px;padding:5px 0}

.item{display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--rule)}
.item:first-of-type{border-top:0}
.item .rail{width:3px;align-self:stretch;border-radius:2px;background:var(--sw);flex:none}
.item .body{flex:1;min-width:0}
.item .t{font-weight:560;font-size:14px}
.item .m{font-size:11.5px;color:var(--muted);margin-top:2px;display:flex;gap:9px;flex-wrap:wrap}
.item .body{cursor:default}
.item.has-detail .body{cursor:pointer}
.item.has-detail .t::after{content:" \25B8";color:var(--muted);font-size:11px;display:inline-block}
.item.has-detail.open .t::after{transform:rotate(90deg)}
.detail{display:none;margin-top:9px;padding:11px 13px;background:var(--sunk);
  border:1px solid var(--rule);border-radius:6px;font-size:12.5px;line-height:1.55;
  color:var(--ink2);white-space:pre-wrap;overflow-wrap:anywhere}
.item.open .detail{display:block}
.detail a{color:var(--sw);word-break:break-all}
.detail .none{color:var(--muted);font-style:italic}
.mark.undo{background:transparent;color:var(--muted)}
.item .course{color:var(--sw);font-weight:640}
.item.done .t{text-decoration:line-through;opacity:.5}
.item.od .t::after{content:" OVERDUE";color:var(--crit);font-size:10.5px;letter-spacing:.07em;font-weight:700}
.mark{border:1px solid var(--rule2);background:var(--sunk);color:var(--ink2);border-radius:5px;
  padding:5px 10px;font:inherit;font-size:12px;cursor:pointer;flex:none}
.mark:hover{border-color:var(--muted)}
.review-row{padding:14px 0;border-top:1px solid var(--rule);overflow-wrap:anywhere}
.review-choice{max-width:100%;font:inherit;font-size:16px;margin:6px 0;padding:8px}
.notice{margin:12px 22px;color:var(--crit);font-size:14px;overflow-wrap:anywhere}
.notice p:empty{display:none}
.notice a{color:inherit}
.mark:disabled{opacity:.45;cursor:default}
.mark:focus-visible{outline:2px solid var(--ink);outline-offset:2px}

.chg{font-size:13px;padding:7px 0;border-top:1px solid var(--rule);display:flex;gap:9px}
.chg:first-of-type{border-top:0}
.chg .kind{font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;font-weight:700;
  min-width:64px;color:var(--warn)}
.chg .kind.removed{color:var(--crit)} .chg .kind.added{color:var(--ok)}

/* assistant */
.fab{position:fixed;right:22px;bottom:22px;width:50px;height:50px;border-radius:50%;
  background:var(--bar);color:var(--bar-ink);border:0;font-size:21px;cursor:pointer;
  box-shadow:0 5px 18px rgba(0,0,0,.26);z-index:20}
.fab:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
.chat{position:fixed;right:22px;bottom:82px;width:min(390px,calc(100vw - 44px));
  max-height:min(560px,calc(100vh - 130px));background:var(--card);border:1px solid var(--rule2);
  border-radius:10px;box-shadow:0 14px 44px rgba(0,0,0,.24);display:none;flex-direction:column;z-index:20}
.chat.open{display:flex}
.chat header{padding:11px 14px;border-bottom:1px solid var(--rule);font-size:12.5px;
  font-weight:640;display:flex;justify-content:space-between;align-items:center}
.chat header .x{border:0;background:none;font-size:17px;cursor:pointer;color:var(--muted);
  font-family:inherit;line-height:1;padding:0 3px}
.log{flex:1;overflow-y:auto;padding:13px 14px;display:flex;flex-direction:column;gap:11px;min-height:110px}
.msg{font-size:13.5px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}
.msg.me{align-self:flex-end;background:var(--sunk);border:1px solid var(--rule);
  border-radius:9px;padding:7px 11px;max-width:85%}
.msg.err{color:var(--crit)}
.ask{display:flex;gap:8px;padding:11px 14px;border-top:1px solid var(--rule)}
.ask input{flex:1;border:1px solid var(--rule2);border-radius:6px;padding:8px 11px;
  font:inherit;font-size:13.5px;background:var(--bg);color:var(--ink);min-width:0}
.ask input:focus-visible{outline:2px solid var(--ink);outline-offset:-1px}
.hint{padding:0 14px 11px;font-size:11px;color:var(--muted)}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

const JS = String.raw`
const $=s=>document.querySelector(s), h=s=>String(s==null?'':s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
let DATA=null, TAB='today', STALE=true, NEED_AUTH=false, MESSAGE='', PENDING={};

async function api(path, opts){
  const o = Object.assign({credentials:'same-origin'}, opts||{});
  // Marks this as dashboard traffic, not a GPT Action, so the worker skips the
  // per-call KV write it makes to prove the GPTs are wired.
  o.headers = Object.assign({'X-Bridge-Client':'dashboard'}, o.headers||{});
  o.signal=AbortSignal.timeout(30000);
  const r = await fetch(path, o);
  if(!r.ok) {
    const detail=await r.json().catch(()=>({}));
    const err=new Error(detail.error || ('HTTP '+r.status));
    err.status=r.status;err.detail=detail;
    if(r.status===401) NEED_AUTH=true;
    throw err;
  }
  return r.json();
}

function courseVar(c){
  const known=['BUSN5000','MGMT4280','MGMT5560','MGMT5850','LAND2510','BUSN3040'];
  return 'var(--c-'+(known.includes(c)?c:'default')+')';
}

/** True only when the bridge actually observed the submission. */
function verified(it){
  return !!(it.completion && it.completion.submission_verification==='verified');
}

function itemRow(it, opts){
  const o=opts||{}, code=it.course_code||'', done=it.completed===true;
  const cls='item'+(done?' done':'')+((o.overdue||o.priorities&&it.bucket==='overdue')&&!done?' od':'');
  // Course-less items (drop/add, advisor meetings) go to the general bucket
  // rather than being unmarkable.
  const bucket = code || 'GENERAL';
  // "done" is a toggle, not a one-way door — you can be wrong about it.
  const btn = o.noMark ? '' :
    '<button class="mark'+(done?' undo':'')+'" data-course="'+h(bucket)+
    '" data-item="'+h(it.title)+'" data-id="'+h(it.assignment_id)+'" data-when="'+h(it.when_iso)+
    '" data-term="'+h(it.term_id)+'" data-record="'+h(it.progress_record&&it.progress_record.record_id)+
    '" data-revision="'+h(it.progress_record?it.progress_record.revision:0)+'" data-status="'+(done?'not_started':'done')+'"'+
    (STALE||NEED_AUTH||!it.assignment_id||!(DATA&&DATA.actionable&&DATA.actionable.coverage&&DATA.actionable.coverage.feeds_status==='ok')?' disabled':'')+'>'+
    (done?'Undo':'Mark done')+'</button>';
  const detail = (it.detail||'').trim();
  return '<div class="'+cls+(detail?' has-detail':'')+'" style="--sw:'+courseVar(code)+'">'+
    '<span class="rail"></span><div class="body"'+(detail?' role="button" tabindex="0" aria-expanded="false"':'')+'><div class="t">'+h(it.title)+'</div>'+
    '<div class="m">'+(['BUSN5000','MGMT4280','MGMT5560','MGMT5850','LAND2510','BUSN3040'].includes(code)?
      '<a class="course" href="'+h('#pass?course='+encodeURIComponent(code))+'" title="Open '+h(code)+' PASS history">'+h(it.course||code)+'</a>':
      '<span class="course">'+h(it.course||code)+'</span>')+
    '<span class="mono">'+h(it.when||'')+'</span>'+
    // Reported and verified are different claims, so the row says which one it is
    // rather than letting a tick read as a confirmed submission.
    (done?'<span class="ev'+(verified(it)?' ok':'')+'">'+
      (verified(it)?'verified':it.completion && it.completion.submission_verification==='not_required'?'nothing to submit':'reported, unverified')+'</span>':'')+
    (it.days_away!=null?'<span>'+(it.days_away===0?'today':it.days_away<0?Math.abs(it.days_away)+'d ago':'in '+it.days_away+'d')+'</span>':'')+
    '</div>'+(detail?'<div class="detail">'+detailHtml(detail)+'</div>':'')+
    '</div>'+btn+'</div>';
}

// Calendar descriptions pack several notes onto one line with "|" separators and
// bare URLs. Split them out and make the links clickable — this is the text he
// wrote for himself, so it should read the way he wrote it.
function detailHtml(raw){
  return h(raw).split(' | ').map(part=>part.trim()).filter(Boolean)
    .map(part=>part.split(' ').map(w=>/^https?:/.test(w)
      ? '<a href="'+w+'" target="_blank" rel="noopener noreferrer">'+w+'</a>'
      : w).join(' '))
    .join('\n\n');
}


function list(title, arr, opts){
  const rows=(arr||[]).map(x=>itemRow(x,opts)).join('');
  return '<section class="panel"><h2>'+h(title)+' <span class="panel-count">'+(arr||[]).length+'</span></h2>'+
    (rows||'<div class="empty">'+h(opts&&opts.empty||'No items in this section.')+'</div>')+'</section>';
}


// ---- answers that need no model -------------------------------------------
// The common questions are lookups against a payload the page already holds.
// Answering them here means the chat works with no API key and no cost; only
// genuinely open-ended questions fall through to /ask.
function fmt(list){
  return list.map(x=>'• '+x.title+'  ('+(x.course||x.course_code||'')+
    (x.when?', '+x.when:'')+')').join('\n');
}
function openItems(a){ return (a||[]).filter(x=>x.completed!==true); }
function changeWhen(v){
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)||!Number.isFinite(Date.parse(v)))return v;
  return new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(v));
}
function changeDetail(c){
  const title=c.title||c.key||'';
  if(c.type==='reclassified')return title+' is course module timing, not a separate deadline; its source calendar entry remains present.';
  const to=c.to_time_verification==='unconfirmed' && /^\d{4}-\d{2}-\d{2}$/.test(c.to_date||'')
    ? c.to_date+' (time unconfirmed)' : c.to;
  return title+(c.from?' · was '+changeWhen(c.from):'')+(to?' · now '+changeWhen(to):'');
}

// The page, the briefing, the GPT payload and the MCP projection all read the
// same actionable view, so a "nothing due" here cannot disagree with an
// "overdue" there. The openItems fallback covers a payload from an older Worker.
function bucketOf(d, name){
  const a=d.actionable;
  const unknown=new Set((d.next_actions?.unverified||[]).map(x=>x.assignment_id));
  return a && a.outstanding ? a.outstanding.filter(x=>x.bucket===name&&!unknown.has(x.assignment_id)) : openItems(d[name]);
}
function counts(d){
  const a=d.actionable;
  if(a && a.counts) return Object.assign({},a.counts,d.next_actions?.counts||{});
  return {overdue:openItems(d.overdue).length, due_today:openItems(d.due_today).length,
    due_this_week:openItems(d.due_this_week).length,
    other_courses_this_week:openItems(d.other_courses_this_week).length,
    awaiting_verification:0};
}
// A failed feed means the list may be short. Saying "nothing is due" on top of a
// broken feed is the one wrong answer this page can give, so the warning leads
// every reply rather than sitting in the status bar where it can be missed.
function caveat(d){
  if(STALE) return '⚠ This is a saved snapshot, not a current check. Refresh before relying on these counts.\n\n';
  if(d.data_warning) return '⚠ '+d.data_warning+'\n\n';
  // No health at all is unknown, not healthy. Saying "nothing is due" on top of
  // feeds that may never have been read is the same wrong answer as saying it on
  // top of a feed that failed.
  const cov=(d.actionable||{}).coverage||{};
  if(cov.feeds_status==='unknown')
    return '⚠ Feed health unknown — it is not confirmed the calendars were read.\n\n';
  return '';
}

function localAnswer(q, d){
  if(!d) return null;
  if(STALE) return caveat(d)+'I cannot confirm what is currently outstanding until a live refresh succeeds.';
  const t=q.toLowerCase(), W=caveat(d);
  const over=bucketOf(d,'overdue'), today=bucketOf(d,'due_today'),
        week=bucketOf(d,'due_this_week'), other=bucketOf(d,'other_courses_this_week'),
        soon=bucketOf(d,'upcoming');
  const awaiting=(d.actionable&&d.actionable.awaiting_verification)||[];
  const has=(...w)=>w.some(x=>new RegExp('(?:^|[^a-z])'+x+'(?:$|[^a-z])').test(t));
  // Basic readiness is already present in the live page and needs no paid AI.
  // Other calendar questions must not be hijacked by coursework keywords.
  if(has('calendar','calendars','feed','feeds','briefing')) {
    if(has('date','feed','feeds','availability','available','connected')) {
      const date=d.daily_briefing&&d.daily_briefing.date;
      const feeds=d.feed_health||[], expected=d.calendar_expected_sources||[];
      const lines=feeds.map(f=>f.source+': '+(f.ok===true
        ? f.coverage_complete===false?'available, coverage incomplete':'available'
        : 'unavailable'));
      for(const name of expected) if(!feeds.some(f=>f.source===name)) lines.push(name+': not checked');
      return W+(date?'This live briefing is dated '+date+'. ':'The briefing date is unavailable. ')+
        (lines.length?'Calendar feeds — '+lines.join('; ')+'.':'Calendar feed availability is unknown.');
    }
    return null;
  }

  if(has('verified','confirmed','receipt','submitted','proof')) {
    const verified=(d.actionable&&d.actionable.verified_submissions)||[];
    const confirmed=verified.length
      ? 'Source-verified submissions ('+verified.length+'):\n'+fmt(verified)
      : 'No source-verified submissions are shown in this view.';
    const reported=awaiting.length
      ? awaiting.length+' item'+(awaiting.length===1?'':'s')+' reported done, awaiting a source receipt:\n'+fmt(awaiting)
      : 'No reported completions are awaiting verification in this view.';
    return W+confirmed+'\n\n'+reported+'\n\nVerification covers the observed receipts only; portal coverage can still be partial.';
  }

  if(has('overdue','late','missed','behind'))
    return W+(over.length ? 'Overdue ('+over.length+'):\n'+fmt(over)
      : 'Nothing overdue in the current checked window.');

  if(has('today','tonight','right now'))
    return W+(today.length ? 'Due today:\n'+fmt(today) : 'Nothing outstanding today.');

  if(has('changed','change','moved','pushed'))
    return W+((d.recent_changes||[]).length
      ? 'Recent deadline changes:\n'+(d.recent_changes||[]).map(c=>
          '• '+c.type+' — '+changeDetail(c)).join('\n')
      : 'No deadline changes detected since the last check.');

  if(has('optional','reading','podcast','practice','should i read','what to read','what can i read'))
    return W+((d.optional_this_week||[]).length
      ? 'Optional this week:\n'+fmt(d.optional_this_week)
      : 'No optional work flagged for this week.'+
        (d.optional_not_tracked?' Not tracked for: '+d.optional_not_tracked:''));

  if(has('done','finished','completed','progress')){
    const p=d.progress||[];
    if(!p.length) return W+'Nothing reported yet.';
    // Every status used to be listed under "Reported done", so blocked and
    // in-progress work read as finished. Each state is now named as itself.
    const by=st=>p.filter(x=>x.status===st);
    const tag=x=>x.verification==='verified'?', verified'
      :x.verification==='not_required'?', nothing to submit':'';
    const block=(label,rows)=>rows.length
      ? label+' ('+rows.length+'):\n'+rows.map(x=>'• '+x.item+'  ('+(x.course||'')+tag(x)+')').join('\n')
      : '';
    const out=[block('Reported done',by('done')),block('In progress',by('in_progress')),
               block('Blocked',by('blocked'))].filter(Boolean).join('\n\n');
    return W+(out||'Nothing reported done, started or blocked.')+
      (awaiting.length?'\n\n'+awaiting.length+' completed item'+(awaiting.length===1?'':'s')+
        ' '+(awaiting.length===1?'is':'are')+' self-reported with no receipt seen.':'');
  }

  if(has('first','start','next','priority','prioritise','prioritize','should i do','what do i do')){
    const q1=[].concat(over,today,week,other).slice(0,4);
    if(!q1.length) return W+'Nothing outstanding right now'+(soon[0]
      ? ' — next up is '+soon[0].title+' ('+soon[0].when+').' : '.')+
      '\n\nThat covers tracked deadlines; submission verification is limited to the returned source receipts.';
    return W+'In order:\n'+q1.map((x,i)=>(i+1)+'. '+x.title+'  ('+(x.course||x.course_code||'')+
      (x.when?', '+x.when:'')+')').join('\n')+
      (over.length?'\n\nThe overdue ones first — those are already late.':'');
  }

  if(has('week','due','upcoming','coming up','what do i have')){
    const all=[].concat(week,other);
    let out = all.length ? 'Due this week:\n'+fmt(all) : 'Nothing outstanding this week.';
    if(soon.length) out += '\n\nAfter that:\n'+fmt(soon.slice(0,3));
    return W+out;
  }
  return null;
}

function renderNotice(){
  const pending=Object.entries(PENDING).map(([id,p])=>'<p>'+h(p.body.item)+': '+h(p.message||'Save not yet confirmed.')+
    ' <button class="mark retry-save" data-pending="'+h(id)+'">Retry same save</button>'+
    (p.notSaved?' <button class="mark dismiss-save" data-pending="'+h(id)+'">Dismiss unsaved attempt</button>':'')+'</p>').join('');
  // Calendar freshness does not describe the separately fetched saved handoffs.
  // Keep sign-in and pending-save recovery visible in both views.
  if(TAB==='pass'){
    $('#notice').innerHTML=(NEED_AUTH?'<p>Session expired. <a href="/app/sign-in?returnTo=%2Fapp">Sign in again</a>.</p>':'')+pending;
    return;
  }
  $('#notice').innerHTML=(NEED_AUTH?'<p>Session expired. <a href="/app/sign-in?returnTo=%2Fapp&reason=expired">Sign in again</a>. Pending saves stay here for retry.</p>':'')+
    (MESSAGE?'<p>'+h(MESSAGE)+'</p>':'')+pending+sourceStatusPanel(DATA);

}
function reviewPanel(d){
  const rows=d.identity_review||[];
  if(!rows.length)return '';
  const pool=[].concat(d.overdue||[],d.due_today||[],d.due_this_week||[],d.upcoming||[]);
  return '<details class="panel fold" id="link-reviews"><summary>Assignment links need review ('+rows.length+')</summary><div class="fold-content">'+
    '<p>These reports are preserved, but they do not clear an assignment until you identify the matching current item. Linking does not verify submission.</p>'+
    rows.map(p=>'<div class="review-row"><b>'+h(p.item)+'</b> · '+h(p.course)+' · '+h(p.status)+
      '<p>'+h(p.note||'')+'</p><label>Match to <select class="review-choice" data-record="'+h(p.record_id)+'"><option value="">Choose an assignment…</option>'+
      pool.filter(d=>d.assignment_id&&(d.course_code||'GENERAL')===p.course&&!d.progress_record).map(d=>'<option value="'+h(d.assignment_id)+'">'+h(d.title+' — '+d.when)+'</option>').join('')+
      '</select></label> <button class="mark relink" data-record="'+h(p.record_id)+'"'+(STALE||NEED_AUTH?' disabled':'')+'>Link report</button></div>').join('')+'</div></details>';
}

function metricCards(metrics){
  return metrics.map(([k,v,sub,cls])=>'<div class="kpi '+(cls||'')+'"><div class="k">'+h(k)+'</div>'+
    '<div class="v mono">'+h(v)+'</div><div class="s">'+h(sub)+'</div></div>').join('');
}
function datedGroups(items,d){
  const groups=new Map();
  for(const it of items){
    const date=new Date(it.when_iso), valid=Number.isFinite(date.getTime());
    const label=valid?new Intl.DateTimeFormat('en-US',{timeZone:d.timezone||'America/New_York',weekday:'long',month:'short',day:'numeric'}).format(date):(it.when||'Date not recorded');
    if(!groups.has(label))groups.set(label,[]);groups.get(label).push(it);
  }
  return [...groups].map(([label,rows])=>list(label,rows).replace('class="panel"','class="panel day-group"')).join('')||
    list('Required work',[],{empty:'No outstanding deadlines in this calendar window. Check source coverage before relying on this.'});
}
function completedFold(items){
  if(!items.length)return '';
  return '<details class="panel fold"><summary>Completed in this view ('+items.length+')</summary><div class="fold-content">'+
    '<p>Reported completion is not a verified submission. Each item keeps its evidence label and Undo control.</p>'+items.map(x=>itemRow(x)).join('')+'</div></details>';
}
function render(){
  if(TAB==='pass'){renderPass();return;}
  $('#overview').hidden=false;
  if(!DATA) return;
  const d=DATA, s=d.progress_summary||{}, c=counts(d), view=dashboardView(d,TAB);
  // A tab carried across midnight must not present yesterday's briefing as today's.
  if(!briefingCurrent(d))STALE=true;
  $('#dashboard-view').setAttribute('data-view',TAB);
  $('#body').setAttribute('aria-labelledby','tab-'+TAB);
  $('#view-intro').innerHTML='<div><div class="view-eyebrow">'+h(view.eyebrow)+'</div><h2 id="view-title">'+h(view.title)+
    '</h2><p class="view-description">'+h(view.description)+'</p></div>'+
    (view.reviews?'<button class="review-shortcut" data-show-reviews>'+view.reviews+' link reviews ↗</button>':'');
  $('#kpis').innerHTML=metricCards(view.metrics);
  for(const [name,count] of Object.entries(view.badges))$('#count-'+name).textContent=count;
  $('#overview').innerHTML='<summary>Bridge overview · '+h(s.done||0)+' reported done · '+h(c.awaiting_verification||0)+' unverified</summary><div class="kpis">'+metricCards([
    ['Overdue',c.overdue,'needs attention now',c.overdue?'alarm':''],
    ['Due today',c.due_today,'before midnight',''],
    ['This week',c.due_this_week+c.other_courses_this_week,'across all courses',''],
    ['Reported done',s.done||0,'recorded on the bridge',''],
    ['Unverified',c.awaiting_verification,'no receipt seen',''],
    ['Feeds',(d.feed_health||[]).filter(f=>f.ok&&f.coverage_complete!==false).length+'/'+(d.feed_health||[]).length,'sources healthy','']
  ])+'</div><p>Totals span the bridge, not just this tab. Reports are not submission receipts. Feed checks cover calendars only.</p>';

  renderNotice();
  const feedsOk=!STALE && (d.feed_health||[]).length>0 && d.feed_health.every(f=>f.ok&&f.coverage_complete!==false)
    && (!d.actionable?.coverage?.feeds_status||d.actionable.coverage.feeds_status==='ok')
    && (!d.calendar?.coverage?.feeds_status||d.calendar.coverage.feeds_status==='ok');
  $('#live').innerHTML='<span class="dot'+(feedsOk?'':' bad')+'"></span>'+
    (STALE?'Saved snapshot':feedsOk?'Calendars checked':'Feed coverage incomplete')+' · '+
    h(Number.isFinite(Date.parse(d.generated_at))?new Intl.DateTimeFormat('en-US',{timeZone:d.timezone||'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(d.generated_at)):d.local_time||'');

  let html='';
  if(TAB==='today'){
    html+=hardDeadlinePanel(d);
    html+=spacedReviewPanel(d);
    html+=briefingPanel(d);
    const priorityIds=new Set();
    if(d.daily_briefing){
      // Join by canonical identity. A presentation row cannot grant a completion
      // control for work absent from the shared outstanding view.
      const outstanding=(d.actionable||{}).outstanding||[];
      const seen=new Set();
      const available=(d.daily_briefing.priorities||[]).map(row=>outstanding.find(item=>item.assignment_id&&item.assignment_id===row.assignment_id))
        .filter(row=>row&&!seen.has(row.assignment_id)&&(seen.add(row.assignment_id),true));
      const priorities=available.slice(0,6);
      for(const row of priorities)priorityIds.add(row.assignment_id);
      if(priorities.length)html+=list('Start here',priorities,{priorities:true,empty:'No outstanding work in the checked sources.'});
      if(available.length>priorities.length)html+='<p class="optional-note">Showing '+priorities.length+' of '+available.length+
        ' tracked priorities. Remaining work appears below or in <a href="#week">This week</a> and <a href="#upcoming">Upcoming</a>.</p>';
    }
    const remaining=view.items.filter(x=>!priorityIds.has(x.assignment_id));
    if(remaining.some(x=>x.bucket==='overdue'))html+=list('Overdue',remaining.filter(x=>x.bucket==='overdue'),{overdue:true});
    if(remaining.some(x=>x.bucket==='due_today')||!priorityIds.size)html+=list('Due today',remaining.filter(x=>x.bucket==='due_today'),{empty:'No outstanding deadlines today in the current calendar data.'});
    if(d.daily_briefing)html+=briefingExtras(d);
    else if((d.classes_today||[]).length)html+=list('Classes today',d.classes_today.map(c=>({title:c.title||c,course:c.course,when:c.when})),{noMark:true});
  } else if(TAB==='calendar'){
    html+=renderCalendar(d);
  } else if(TAB==='week'){
    html+=datedGroups(view.items,d);
  } else if(TAB==='upcoming'){
    html+=datedGroups(view.items,d);
  } else if(TAB==='optional'){
    html+=list('Optional this week',d.optional_this_week,{noMark:true});
    html+=list('Ongoing',d.optional_ongoing,{noMark:true});
    if((d.optional_not_tracked||[]).length)
      html+='<section class="panel"><h2>Not tracked</h2><div class="empty">'+
        h((d.optional_not_tracked||[]).join(', '))+'</div></section>';
  } else if(TAB==='changes'){
    const ch=d.recent_changes||[];
    html+='<section class="panel"><h2>Deadline changes</h2>'+(ch.length?ch.map(c=>
      '<div class="chg"><span class="kind '+h(c.type)+'">'+h(c.type)+'</span>'+
      '<span>'+h(changeDetail(c))+'</span></div>').join(''):
      '<div class="empty">No changes detected.</div>')+'</section>';
    const p=d.progress||[];
    html+='<details class="panel fold"><summary>Reported progress ('+p.length+')</summary><div class="fold-content">'+(p.length?p.map(x=>
      '<div class="chg"><span class="kind added">'+h(x.status)+'</span><span>'+
      h(x.item)+' · '+h(x.at_local||'')+'</span></div>').join(''):
      '<div class="empty">Nothing reported yet.</div>')+'</div></details>';
    html+=reviewPanel(d);
  }
  if(TAB==='today')html+=unverifiedPanel(d);
  $('#body').innerHTML=html+completedFold(view.completed);
  tickHardCountdown();
}

const CACHE='bridge_last_status';
const OUTBOX='bridge_pending_saves_v1';
try{PENDING=JSON.parse(sessionStorage.getItem(OUTBOX)||'{}');}catch{PENDING={};}
function persistPending(){try{sessionStorage.setItem(OUTBOX,JSON.stringify(PENDING));}catch{
  MESSAGE='This browser cannot retain pending saves across a reload. Keep this tab open until the save is confirmed.';
}}
async function savePending(id){
  const p=PENDING[id];if(!p||p.saving)return;
  p.saving=true;p.message='Saving…';persistPending();renderNotice();
  try{
    const result=await api('/progress',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':p.operation_id},body:JSON.stringify(p.body)});
    if(result.ok!==true||!result.recorded)throw new Error('write_not_confirmed');
    delete PENDING[id];persistPending();
    MESSAGE=result.warning||'Saved '+p.body.item+'.';
    await load();
  }catch(e){
    p.saving=false;
    p.notSaved=(e.status>=400&&e.status<500)||['records_initializing','assignment_sources_unavailable'].includes(e.message);
    p.message=p.notSaved?'Not saved: '+(e.detail&&e.detail.detail||e.message)+'. Refresh and review before retrying.':
      'Could not confirm the save. Retry this same operation; do not assume it succeeded.';
    persistPending();renderNotice();
  }
}
function queueSave(body){
  const id=body.record_id||body.assignment_id;
  if(!PENDING[id])PENDING[id]={body,operation_id:crypto.randomUUID(),message:'Waiting for save confirmation.'};
  persistPending();return savePending(id);
}
for(const p of Object.values(PENDING))p.saving=false;

// /status fetches both iCal feeds live, so a cold load is several seconds. Paint
// the last known state immediately and let the fresh copy replace it — a blank
// page for five seconds reads as broken even when nothing is wrong.
function paintCached(){
  try{
    const raw=localStorage.getItem(CACHE);
    if(!raw) return false;
    DATA=JSON.parse(raw); STALE=true; render();
    $('#live').innerHTML='<span class="dot stale"></span>refreshing\u2026';
    return true;
  }catch(e){ return false; }
}

// When /status was last actually fetched, so that flicking between tabs cannot
// turn into a burst of identical requests.
let lastLoad = 0, freshnessTimer;
const FRESH_MS=300000;

async function load(){
  lastLoad = Date.now();
  try{
    DATA=await api('/status?view=dashboard'); STALE=false; NEED_AUTH=false;
    clearTimeout(freshnessTimer);
    // Age the display without polling the network. An idle tab cannot stay live forever.
    freshnessTimer=setTimeout(()=>{STALE=true;render();},FRESH_MS);
    try{ localStorage.setItem(CACHE, JSON.stringify(DATA)); }catch(e){}
    render();
  }catch(e){
    STALE=true;
    if(TAB==='pass'){renderPass();return;}
    if(DATA)render(); else renderNotice();
    $('#live').innerHTML='<span class="dot bad"></span>'+(NEED_AUTH?'Sign-in required':'Live update failed');
    if(!DATA) $('#body').innerHTML='<section class="panel"><h2>Cannot load</h2><div class="empty">'+
      h(e.message)+'</div></section>';
  }
}

const TAB_IDS=['today','calendar','week','upcoming','optional','changes','pass'];
const routeTab=()=>location.hash.slice(1).split('?')[0];
function switchTab(next,writeHistory=true){
  if(!TAB_IDS.includes(next))return;
  TAB=next;
  document.querySelectorAll('.tab').forEach(x=>{const active=x.dataset.tab===TAB;
    x.setAttribute('aria-selected',String(active));x.tabIndex=active?0:-1;});
  const hash=TAB==='pass'?passHash(PASS.course,PASS.sandbox,PASS.recordId):'#'+TAB;
  if(writeHistory&&location.hash!==hash)history.pushState(null,'',hash);
  if(TAB==='pass'){void loadPassRoute();}else{render();if(!DATA)void load();}
  const heading=TAB==='pass'?'PASS history':DATA?dashboardView(DATA,TAB).title:next;
  $('#view-feedback').textContent=heading+' section selected';
  if(!matchMedia('(prefers-reduced-motion: reduce)').matches&&$('#body').animate)
    $('#body').animate([{opacity:.5,transform:'translateY(5px)'},{opacity:1,transform:'translateY(0)'}],{duration:160,easing:'ease-out'});
  if(window.scrollY>0)window.scrollTo({top:Math.max(0,$('#dashboard-view').offsetTop-$('.tabs').offsetHeight-12),behavior:'instant'});
}
function toggleItem(row){const open=row.classList.toggle('open');row.querySelector('.body').setAttribute('aria-expanded',String(open));}
document.addEventListener('keydown',ev=>{
  const tab=ev.target.closest('.tab');
  if(tab&&['ArrowLeft','ArrowRight','Home','End'].includes(ev.key)){
    ev.preventDefault();const i=TAB_IDS.indexOf(tab.dataset.tab),next=ev.key==='Home'?0:ev.key==='End'?TAB_IDS.length-1:(i+(ev.key==='ArrowRight'?1:-1)+TAB_IDS.length)%TAB_IDS.length;
    switchTab(TAB_IDS[next]);$('#tab-'+TAB_IDS[next]).focus({preventScroll:true});return;
  }
  if(ev.target.matches('.item.has-detail .body')&&['Enter',' '].includes(ev.key)){ev.preventDefault();toggleItem(ev.target.closest('.item'));}
});
window.addEventListener('hashchange',()=>switchTab(TAB_IDS.includes(routeTab())?routeTab():'today',false));

document.addEventListener('click', async ev=>{
  const t=ev.target.closest('.tab');
  if(t){switchTab(t.dataset.tab);return;}
  if(ev.target.closest('[data-pass-refresh]')){await loadPassRoute(true);return;}
  if(ev.target.closest('[data-pass-older]')){await loadOlderPass();return;}
  if(ev.target.closest('[data-pass-detail-retry]')){await readPassDetail(PASS.recordId);return;}
  const day=ev.target.closest('[data-calendar-day]');
  if(day&&!day.disabled){CAL.date=day.dataset.calendarDay;render();$('[data-calendar-day="'+CAL.date+'"]').focus({preventScroll:true});const dayList=$('.agenda-list');if(dayList&&dayList.scrollIntoView)dayList.scrollIntoView({behavior:'smooth',block:'start'});return;}
  const month=ev.target.closest('[data-calendar-month]');
  if(month&&!month.disabled){CAL.month=month.dataset.calendarMonth;CAL.date=CAL.month+'-01';render();$('[data-calendar-day="'+CAL.date+'"]').focus({preventScroll:true});return;}
  if(ev.target.closest('[data-calendar-today]')){
    CAL.date=agendaDateKey(new Date(),(DATA.calendar||{}).timezone||DATA.timezone);CAL.month=CAL.date.slice(0,7);render();return;
  }
  if(ev.target.closest('[data-show-reviews]')){
    switchTab('changes');const reviews=$('#link-reviews');if(reviews){reviews.open=true;
      window.scrollTo({top:window.scrollY+reviews.getBoundingClientRect().top-$('.tabs').offsetHeight-12,behavior:'instant'});
      reviews.querySelector('summary').focus({preventScroll:true});}return;
  }
  // Clicking the row body opens its notes. Ignore clicks on the button or a link.
  const row=ev.target.closest('.item.has-detail');
  if(row && !ev.target.closest('.mark') && !ev.target.closest('a')){
    toggleItem(row); return; }

  const retry=ev.target.closest('.retry-save');
  if(retry){await savePending(retry.dataset.pending);return;}
  const dismiss=ev.target.closest('.dismiss-save');
  if(dismiss){delete PENDING[dismiss.dataset.pending];persistPending();renderNotice();return;}
  const relink=ev.target.closest('.relink');
  if(relink){
    if(STALE||NEED_AUTH)return;
    const p=(DATA.identity_review||[]).find(p=>p.record_id===relink.dataset.record);
    const select=relink.parentElement.querySelector('select'),id=select.value;
    if(!id){MESSAGE='Choose the matching assignment first.';renderNotice();return;}
    const d=[].concat(DATA.overdue,DATA.due_today,DATA.due_this_week,DATA.upcoming).find(d=>d.assignment_id===id);
    if(!p||!d||!confirm('Link "'+p.item+'" to "'+d.title+'" ('+d.when+')? This does not verify a submission.'))return;
    await queueSave({course:p.course,item:d.title,status:p.status,assignment_id:id,when_iso:d.when_iso,term_id:d.term_id,
      record_id:p.record_id,expected_revision:p.revision,relink:true,
      note:p.note||'Historical report explicitly linked from the dashboard.',reported_by:'daksh',verification:p.status==='done'?'reported':'unknown'});
    return;
  }
  const m=ev.target.closest('.mark');
  if(m){
    if(STALE||NEED_AUTH||!m.dataset.id)return;
    const st=m.dataset.status||'done';m.disabled=true;m.textContent='Saving…';
    await queueSave({course:m.dataset.course,item:m.dataset.item,status:st,assignment_id:m.dataset.id,
      when_iso:m.dataset.when,term_id:m.dataset.term,record_id:m.dataset.record||null,
      expected_revision:Number(m.dataset.revision),reported_by:'daksh',
      note:st==='done'?'Marked done from the dashboard; self-reported, not independently verified.':'Un-marked from the dashboard.'});
    return;
  }
  if(ev.target.closest('#fab')||ev.target.closest('.chat .x')) $('#chat').classList.toggle('open');
});

document.addEventListener('change',ev=>{
  if(['pass-course','pass-sandbox'].includes(ev.target.id)){location.hash=passHash($('#pass-course').value,$('#pass-sandbox').value==='true');return;}
  const filter=ev.target.closest('[data-calendar-filter]');
  if(filter){const name=filter.dataset.calendarFilter;CAL[name]=filter.value;render();$('[data-calendar-filter="'+name+'"]').focus({preventScroll:true});return;}
  if(ev.target.id==='calendar-date'&&/^\d{4}-\d{2}-\d{2}$/.test(ev.target.value)){
    CAL.date=ev.target.value;CAL.month=CAL.date.slice(0,7);render();$('#calendar-date').focus({preventScroll:true});
  }
});

$('#refresh').addEventListener('click', ()=>TAB==='pass'?loadPassRoute(true):load());

$('#askform').addEventListener('submit', async ev=>{
  ev.preventDefault();
  const input=$('#q'), q=input.value.trim(); if(!q) return;
  const log=$('#log');
  log.insertAdjacentHTML('beforeend','<div class="msg me">'+h(q)+'</div>');
  input.value=''; input.disabled=true;
  const pending=document.createElement('div');
  pending.className='msg'; pending.textContent='Thinking…'; log.appendChild(pending);
  log.scrollTop=log.scrollHeight;

  // Free path first. Only fall through to the model when it's genuinely needed.
  const quick=localAnswer(q, DATA);
  if(quick){
    pending.textContent=quick;
    input.disabled=false; input.focus(); log.scrollTop=log.scrollHeight;
    return;
  }

  try{
    const r=await api('/ask',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({question:q})});
    pending.textContent=r.answer;
  }catch(e){
    // Each of these has a different fix, so each gets its own sentence. A single
    // "something went wrong" would hide the one action that unblocks the page.
    const SAY={
      assistant_not_configured:'No Anthropic API key set. Add it in Cloudflare: Workers & Pages \u2192 ijuh2yp6rf \u2192 Settings \u2192 Variables and Secrets.',
      assistant_no_credit:'Your Anthropic account is out of credit. Add funds at console.anthropic.com \u2192 Plans & Billing, then ask again.',
      assistant_key_rejected:'Anthropic rejected the API key \u2014 it was probably revoked. Create a new one and update the ANTHROPIC_API_KEY secret.',
      assistant_declined:'Claude declined to answer that one. Try rephrasing.',
      assistant_unreachable:'Could not reach Anthropic just now. Try again in a moment.'
    };
    pending.className='msg err';
    pending.textContent = SAY[e.message] || ('Could not answer: '+e.message);
  }
  input.disabled=false; input.focus(); log.scrollTop=log.scrollHeight;
});

if(TAB_IDS.includes(routeTab()))switchTab(routeTab(),false);
if(TAB!=='pass'&&!paintCached()) $('#body').innerHTML='<section class="panel"><h2>Loading</h2><div class="empty">Reading eLC and Google Calendar\u2026</div></section>';
if(TAB!=='pass')load();

// No background timer at all, deliberately. The Worker now checks the feeds on its
// own schedule (see the scheduled handler in worker.js), so a tab sitting open has
// nothing useful to poll for - it would re-ask a question whose answer changes about
// twice a week, and each ask fans out across KV.
//
// Refreshing when you return to the tab covers the case that actually matters: what
// you are looking at is fresh as of the moment you looked at it. The Refresh button
// remains for when you want to force it.
const MIN_REFRESH_MS = 300000;
document.addEventListener('visibilitychange', ()=>{
  if(!document.hidden)tickHardCountdown();
  if(!document.hidden && Date.now() - (TAB==='pass'?PASS.checkedAt:lastLoad) >= MIN_REFRESH_MS){if(TAB==='pass')void loadPassRoute(true);else void load();}
});
`;

const TABS = [
  ['today', 'Today'],
  ['calendar', 'Calendar'],
  ['week', 'This week'],
  ['upcoming', 'Upcoming'],
  ['optional', 'Optional'],
  ['changes', 'Changes'],
  ['pass', 'PASS'],
];

/** The dashboard page. Static shell — every number comes from /status at runtime. */
export function appHtml(term = 'Fall 2026') {
  const tabs = TABS.map(
    ([id, label], i) =>
      `<button class="tab" id="tab-${id}" role="tab" data-tab="${id}" aria-controls="body" aria-selected="${i === 0}" tabindex="${i===0?0:-1}"><span>${label}</span><span class="tab-count" id="count-${id}"></span></button>`,
  ).join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Sidekick">
<meta name="theme-color" content="#1f1e1c">
<!-- An inline favicon so the tab is identifiable at a glance regardless of what
     the hostname says. Data URI keeps the page a single self-contained file. -->
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%231f1e1c'/%3E%3Crect x='7' y='9' width='18' height='2.6' rx='1.3' fill='%23e8514c'/%3E%3Crect x='7' y='14.7' width='18' height='2.6' rx='1.3' fill='%230e97d4'/%3E%3Crect x='7' y='20.4' width='11' height='2.6' rx='1.3' fill='%23189b57'/%3E%3C/svg%3E">
<title>Sidekick — ${term}</title>
<style>${CSS}\n${dashboardTheme}\n${agendaTheme}\n${passTheme}\n${nextActionsTheme}\n${learnerTheme}\n${sidekickTheme}</style>
</head><body>
<div class="topbar">
  <div><h1>Sidekick</h1><div class="sub">Your study companion · ${term}</div></div>
  <div class="tools">
    <a class="btn" href="/app/profile" style="text-decoration:none">Learner Profile ↗</a>
    <a class="btn" href="/agents" style="text-decoration:none">Agent interface ↗</a>
    <a class="btn" href="/app/system" style="text-decoration:none">System health ↗</a>
    <button class="btn" id="refresh">Refresh</button>
    <form method="post" action="/app/sign-out"><button class="btn">Sign out</button></form>
  </div>
</div>
<div class="syncbar"><span class="live" id="live"><span class="dot"></span>Checking calendars…</span></div>
<div class="tabs" role="tablist" aria-label="Coursework sections">${tabs}</div>
<div class="notice" id="notice" role="status" aria-live="polite"></div>
<main class="wrap" id="dashboard-view" data-view="today">
  <section class="view-intro" id="view-intro"><div><div class="view-eyebrow">Your daily focus</div><h2>Today</h2><p class="view-description">Reading your latest coursework…</p></div></section>
  <div class="kpis" id="kpis" aria-label="Selected section summary"></div>
  <section id="body" role="tabpanel" aria-labelledby="tab-today" tabindex="0"></section>
  <details class="overview" id="overview"></details>
</main>
<p class="view-feedback" id="view-feedback" role="status" aria-live="polite"></p>

<button class="fab" id="fab" aria-label="Ask about your coursework">&#128172;</button>
<div class="chat" id="chat" role="dialog" aria-label="Coursework assistant">
  <header><span>Ask about your coursework</span><button class="x" aria-label="Close">&times;</button></header>
  <div class="log" id="log"><div class="msg">Ask what's due, what's overdue, what changed, or what to start on — answered straight from your live feed.</div></div>
  <form class="ask" id="askform"><input id="q" placeholder="What should I do first this week?" autocomplete="off"><button class="btn" style="color:var(--ink);border-color:var(--rule2)">Ask</button></form>
  <div class="hint">Answers come from your live deadlines — not from memory.</div>
</div>
<script>${DASHBOARD_VIEW_JS}\n${AGENDA_VIEW_JS}\n${PASS_VIEW_JS}\n${NEXT_ACTIONS_VIEW_JS}\n${LEARNER_VIEW_JS}\n${JS}</script>
</body></html>`;
}
