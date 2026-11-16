/** Human window onto the same read-only priority projection served to agents. */
export const NEXT_ACTIONS_VIEW_JS=String.raw`
function sourceStatusPanel(d){
  if(!d)return '';
  const b=d.daily_briefing||{},news=d.announcements||{},warnings=[];
  const add=value=>{const s=String(value||'').trim();if(s&&!warnings.includes(s))warnings.push(s);};
  if(STALE)add('Saved snapshot — not current. Refresh to check live status. Completion controls are paused.');
  for(const w of [...(news.warnings||[]),...(b.warnings||[])])add(w);
  let remaining=d.data_warning||'';for(const w of warnings)remaining=remaining.split(w).join('');add(remaining);
  const attention=(d.source_health||[]).filter(s=>!['healthy','ok'].includes(s.status));
  for(const s of attention)add((s.label||s.id)+' is '+(s.status||'unknown')+'; its source coverage is limited.');
  const count=attention.length,partial=(news.courses||[]).filter(c=>c.state!=='healthy').length;
  const summary=(STALE?'Saved source status':count?count+' source'+(count===1?'':'s')+' need attention':warnings.length?'Source coverage has limits':'Source checks available')+(partial?' · '+partial+' limited announcement checks':'');
  return '<details class="source-status"><summary>'+h(summary)+' <span>Details</span></summary>'+
    (warnings.length?'<ul>'+warnings.map(w=>'<li>'+h(w)+'</li>').join('')+'</ul>':'')+
    '<p><a href="/app/system">Source health and last successful checks</a></p>'+announcementChecksPanel(d,true)+'</details>';
}
function nextActionLink(url){
  return /^(?:https?:\/\/|\/status\?)/i.test(url||'')&&!/["<>\u0000-\u0020]/.test(url)?h(url):'';
}
function nextEvidence(row){return (row.source_evidence?.links||[]).map(link=>{const url=nextActionLink(link.url);return url?'<a href="'+url+'" target="_blank" rel="noopener noreferrer">'+h(link.kind==='bridge_calendar_projection'?'Calendar record (original not linked)':link.label)+'</a>':'';}).filter(Boolean).join(' · ');}
function hardCountdown(row,now=new Date()){
  if(row.countdown_basis==='confirmed_date_time_unknown'){
    const day=agendaDateKey(now),delta=Math.round((Date.parse(row.date_key+'T12:00:00Z')-Date.parse(day+'T12:00:00Z'))/86400000);
    return (delta>0?delta+' calendar day'+(delta===1?'':'s')+' away':delta===0?'Today':'Date passed')+' · time unconfirmed';
  }
  const ms=Date.parse(row.when_iso)-now;if(!Number.isFinite(ms))return 'Time unavailable';if(ms<=0)return 'Calendar deadline reached · refresh';
  const mins=Math.ceil(ms/60000),days=Math.floor(mins/1440),hours=Math.floor(mins%1440/60),minutes=mins%60;
  return (days?days+'d ':'')+(days||hours?hours+'h ':'')+minutes+'m remaining';
}
function hardDeadlinePanel(d){
  const row=d.next_actions?.next_hard_deadline;if(!row)return '';
  const related=row.related_open_items||[];
  return '<section class="panel hard-deadline"><div class="briefing-label">Next hard deadline</div><h3>'+h(row.course||row.course_code)+' · '+h(row.title)+'</h3><p class="hard-date">'+h(row.countdown_basis==='confirmed_date_time_unknown'?agendaDateLabel(row.date_key)+' · time unconfirmed':row.when)+'</p><p class="hard-countdown" id="hard-countdown" aria-live="off">'+h(hardCountdown(row))+'</p><p>'+nextEvidence(row)+'</p>'+
    (related.length?'<h4>Linked open preparation</h4><ul>'+related.map(item=>'<li><b>'+h(item.title)+'</b> · original deadline '+h(item.when)+'<br>'+nextEvidence(item)+'</li>').join('')+'</ul><p class="briefing-footnote">'+h(row.related_items_basis)+'</p>':'')+
    '<p class="briefing-footnote">From your calendar. The course site and your own submission receipt are the final word.</p></section>';
}
let hardCountdownTimer;
function tickHardCountdown(){
  if(TAB!=='today'||document.hidden||!DATA?.next_actions?.next_hard_deadline){if(hardCountdownTimer)clearTimeout(hardCountdownTimer);return;}
  clearTimeout(hardCountdownTimer);
  const el=$('#hard-countdown');if(el)el.textContent=hardCountdown(DATA.next_actions.next_hard_deadline);
  // A local text-only clock: no feed, model or API polling.
  hardCountdownTimer=setTimeout(tickHardCountdown,60000);
}
function unverifiedPanel(d){
  const rows=d.next_actions?.unverified||[];if(!rows.length)return '';
  return '<section class="panel unverified-items"><h2>Unverified source items <span class="panel-count">'+rows.length+'</span></h2><p>Retained for checking. These are excluded from the overdue count; nothing has been cleared or marked complete.</p>'+rows.map(row=>'<article><h3>'+h(row.title)+'</h3><p class="unverified-label">'+h(row.status_label)+'</p><p>'+h(row.when)+' · '+h(row.course||row.course_code)+'</p><p>'+nextEvidence(row)+'</p><p class="briefing-footnote">Last checked: '+h((v=>Number.isFinite(Date.parse(v))?new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(v)):'unknown')(row.uncertainty?.last_success_at))+'</p></article>').join('')+'</section>';
}
`;
export const nextActionsTheme=String.raw`
.source-status{border:1px solid var(--rule2);border-radius:7px;padding:10px 14px;background:var(--card);font-size:12px;color:var(--ink2)}
.source-status>summary{cursor:pointer;font-weight:600}.source-status>summary span{font-weight:400;text-decoration:underline;margin-left:10px}.source-status li{margin:5px 0}.source-status a{color:#25658a}.source-status .announcement-checks{margin-top:14px}
.hard-deadline{border:2px solid var(--accent);background:#fffaf0}.hard-deadline h3{font-size:23px;margin:8px 0}.hard-date{font-size:16px}.hard-countdown{font-size:26px;font-variant-numeric:tabular-nums;font-weight:650;margin:8px 0}.hard-deadline a,.unverified-items a{color:#25658a}.hard-deadline li{margin:10px 0}.hard-deadline h4{margin-bottom:0}
.unverified-items>p{font-size:12px;color:var(--ink2)}.unverified-items article{border-top:1px solid var(--rule);padding:12px 0}.unverified-items h3{font-size:14px;margin:0}.unverified-items p{font-size:12px;margin:6px 0}.unverified-label{color:var(--warn);font-weight:600}
`;
