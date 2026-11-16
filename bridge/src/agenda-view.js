/** Read-only calendar presentation. The live feed window remains the boundary;
 * month navigation never turns an unchecked date into an empty schedule. */
export const AGENDA_VIEW_JS=String.raw`
let CAL={month:'',date:'',course:'',source:'',kind:''};
function agendaDateKey(value,timezone='America/New_York'){
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const part=name=>parts.find(x=>x.type===name).value;
  return part('year')+'-'+part('month')+'-'+part('day');
}
function agendaShift(key,days){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(key||''))return '';
  const date=new Date(key+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10);
}
function agendaDateLabel(key,options){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(key||''))return 'Date unavailable';
  return new Intl.DateTimeFormat('en-US',Object.assign({timeZone:'UTC',weekday:'long',month:'long',day:'numeric'},options||{})).format(new Date(key+'T12:00:00Z'));
}
function agendaBounds(calendar){
  const timezone=calendar.timezone||'America/New_York',window=calendar.window||{};
  const start=agendaDateKey(window.start,timezone),last=agendaDateKey(window.end,timezone);
  if(!start||!last)return null;
  const endDate=new Date(window.end),endTime=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(endDate);
  return {start,end:endTime==='00:00:00'?agendaShift(last,-1):last};
}
function agendaHasDay(event,key,timezone='America/New_York'){
  const start=event.date_key||agendaDateKey(event.start_iso,timezone);if(!start||key<start)return false;
  if(event.all_day)return key<(event.end_date_key||agendaShift(start,1));
  if(!event.end_iso||Date.parse(event.end_iso)<=Date.parse(event.start_iso))return key===start;
  const end=event.end_date_key||agendaDateKey(event.end_iso,timezone);if(key>end)return false;
  if(key<end)return true;
  // A lecture ending exactly at midnight belongs to the previous day only.
  const endTime=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(event.end_iso));
  return endTime!=='00:00:00';
}
function agendaEvents(calendar,filters=CAL){
  return (calendar.events||[]).filter(row=>(!filters.course||row.course_code===filters.course)&&
    (!filters.source||row.source===filters.source)&&(!filters.kind||row.kind===filters.kind));
}
function agendaTime(event,timezone='America/New_York'){
  if(event.date_reconciliation?.state==='applied'&&event.date_reconciliation?.time_verification==='unconfirmed')return 'Date confirmed · time unconfirmed';
  if(event.all_day){
    const last=agendaShift(event.end_date_key||agendaShift(event.date_key,1),-1);
    return last>event.date_key?'All day · '+agendaDateLabel(event.date_key,{weekday:undefined,month:'short'})+'–'+agendaDateLabel(last,{weekday:undefined,month:'short'}):'All day';
  }
  const start=new Date(event.start_iso);if(!Number.isFinite(start.getTime()))return 'Time unavailable';
  const format=date=>new Intl.DateTimeFormat('en-US',{timeZone:timezone,hour:'numeric',minute:'2-digit'}).format(date);
  let text=format(start);const end=new Date(event.end_iso);
  if(event.end_iso&&Number.isFinite(end.getTime())&&end>start){
    const endDay=agendaDateKey(end,timezone),startDay=event.date_key||agendaDateKey(start,timezone);
    text+='–'+(endDay!==startDay?agendaDateLabel(endDay,{weekday:undefined,month:'short'})+' ':'')+format(end);
  }
  return text;
}
function agendaKind(kind){return ({deadline:'Deadline',class:'Class',meeting:'Meeting',study:'Study time',optional:'Optional',event:'Event'})[kind]||'Event';}
function agendaSource(source){return ({elc:'eLC',personal:'Google Calendar',google:'Google Calendar'})[source]||source||'Source not recorded';}
function agendaEvidence(event){
  if(event.kind!=='deadline')return '';
  if(!event.completed)return 'Outstanding';
  return ({verified:'Verified submission',reported:'Reported done · unverified',not_required:'Completed · nothing to submit'})[event.submission_verification]||'Reported done · evidence unknown';
}
function agendaRow(event,timezone,showDate=false){
  const evidence=agendaEvidence(event),detail=event.description||event.location;
  const title='<span class="agenda-title">'+h(event.title)+'</span>';
  const meta='<div class="agenda-meta">'+(showDate?'<span>'+h(agendaDateLabel(event.date_key||agendaDateKey(event.start_iso,timezone),{weekday:'short',month:'short',day:'numeric'}))+'</span>':'')+'<span class="mono">'+h(agendaTime(event,timezone))+'</span><span>'+h(agendaKind(event.kind))+'</span>'+
    (event.course||event.course_code?'<span class="course">'+h(event.course||event.course_code)+'</span>':'')+
    '<span>'+h(agendaSource(event.source))+'</span>'+(evidence?'<span class="agenda-evidence">'+h(evidence)+'</span>':'')+'</div>';
  const content=detail?'<details><summary>'+title+meta+'</summary><div class="agenda-description">'+
    (event.location?'<p><b>Location</b> '+h(event.location)+'</p>':'')+(event.description?'<p>'+h(event.description)+'</p>':'')+'</div></details>':title+meta;
  const correction=event.date_reconciliation;
  let provenance='';
  if(correction&&['applied','source_aligned'].includes(correction.state)){
    const text=correction.state==='applied'?'Instructor date: '+agendaDateLabel(correction.date,{weekday:'short',month:'short',day:'numeric'})+'. Source calendar: '+agendaDateLabel(agendaDateKey(correction.source_when_iso,timezone),{weekday:'short',month:'short',day:'numeric'})+'.':'Calendar date agrees with the checked instructor announcement.';
    const url=correction.authority?.url||'';
    const checked=agendaDateKey(correction.authority?.observed_at,timezone);
    provenance='<p class="agenda-reconciliation">'+h(text)+(checked?' Announcement checked '+h(agendaDateLabel(checked,{weekday:undefined,month:'short',day:'numeric'}))+'.':'')+(/^https:\/\/uga\.view\.usg\.edu\//.test(url)?' <a href="'+h(url)+'" target="_blank" rel="noopener noreferrer">Instructor announcement</a>':'')+'</p>';
  }
  return '<article class="agenda-event'+(event.completed?' agenda-completed':'')+'" style="--sw:'+courseVar(event.course_code)+'">'+content+provenance+'</article>';
}
function agendaList(title,events,timezone,empty,showDates=false){
  return '<section class="panel agenda-list"><h2>'+h(title)+' <span class="panel-count">'+events.length+'</span></h2>'+
    (events.length?events.map(row=>agendaRow(row,timezone,showDates)).join(''):'<p class="empty">'+h(empty||'No events in the checked calendar data.')+'</p>')+'</section>';
}
function agendaFilter(name,label,options,current){
  return '<label>'+h(label)+'<select data-calendar-filter="'+name+'"><option value="">All '+h(label.toLowerCase())+'</option>'+
    options.map(([value,text])=>'<option value="'+h(value)+'"'+(value===current?' selected':'')+'>'+h(text)+'</option>').join('')+'</select></label>';
}
function announcementCheckTime(value,timezone){
  const date=new Date(value);if(!value||!Number.isFinite(date.getTime()))return 'Not recorded';
  return new Intl.DateTimeFormat('en-US',{timeZone:timezone,month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(date);
}
function announcementSourceLink(url){
  return /^https:\/\/uga\.view\.usg\.edu\/d2l\/le\/news\/(\d+)\/(\d+)\/view\?ou=\1$/.test(url||'')?'<a href="'+h(url)+'" target="_blank" rel="noopener noreferrer">Check instructor announcement</a>':'';
}
function announcementChecksPanel(d,compact=false){
  const news=d.announcements,timezone=d.timezone||'America/New_York';
  if(!news)return '<section class="panel announcement-checks"><h2>Announcement checks</h2><p class="empty">No automatic announcement receipt is available yet. Calendar feeds alone cannot confirm instructor date changes.</p></section>';
  const courses=news.courses||[],reviews=news.reviews||[],warnings=news.warnings||[];
  const full=courses.filter(row=>row.state==='healthy').length,recent=courses.filter(row=>row.state==='partial').length;
  const labels={healthy:'Full listing checked',partial:'Recent feed only',stale:'Check overdue',failed:'Check failed'};
  const reason={ambiguous_assignment_occurrence:'More than one tracked deadline matches.',announced_original_date_not_matched:'The stated earlier date does not match a tracked deadline.',conflicting_announcement_dates:'Announcements give conflicting dates.',announcement_authority_missing:'The earlier instructor source is missing from a complete listing.',announcement_authority_changed:'The earlier instructor source has changed.',source_occurrence_changed:'The calendar occurrence changed and needs a source check.'};
  return '<section class="panel announcement-checks"><h2>'+(STALE?'Saved announcement checks':'Announcement checks')+'</h2><p class="announcement-summary">'+
    h(courses.length?full+'/'+courses.length+' full listings · '+recent+' recent feeds':'No course source checks available')+'. Last check: '+h(announcementCheckTime(news.last_attempt_at,timezone))+'.</p>'+
    (courses.length?'<details class="announcement-coverage"><summary>Course coverage and check times</summary><ul>'+courses.map(row=>'<li><b>'+h(row.course_code)+'</b> · '+h(labels[row.state]||'Coverage unknown')+' · '+h(announcementCheckTime(row.checked_at,timezone))+
      (row.last_complete_success_at?' · last complete listing '+h(announcementCheckTime(row.last_complete_success_at,timezone)):'')+'</li>').join('')+'</ul></details>':'')+
    (!compact&&warnings.length?'<ul class="briefing-warnings">'+warnings.map(text=>'<li>'+h(text)+'</li>').join(''):'')+
    (reviews.length?'<div class="announcement-reviews"><h3>Date changes need review <span class="panel-count">'+reviews.length+'</span></h3>'+reviews.map(row=>'<p><b>'+h(row.course_code||'Course')+'</b> · '+h(reason[row.reason]||'The announced date needs a source check.')+' '+announcementSourceLink(row.authority?.url)+'</p>').join('')+'</div>':'')+
    '<p class="briefing-footnote">Exact, definite instructor changes update the tracked date and keep the source evidence. Recent feeds cover visible posts; older edits and removals need a complete listing. Ambiguous changes stay flagged for review.</p></section>';
}
function renderCalendar(d){
  const calendar=d.calendar,timezone=calendar&&calendar.timezone||d.timezone||'America/New_York';
  if(!calendar)return '<section class="panel"><h2>Calendar unavailable</h2><p class="empty">Refresh to load your connected calendars. No schedule has been confirmed.</p></section>';
  const bounds=agendaBounds(calendar);if(!bounds)return '<section class="panel"><h2>Calendar window unavailable</h2><p class="empty">The checked dates could not be determined. Refresh before relying on this calendar.</p></section>';
  const today=agendaDateKey(new Date(),timezone),clamp=key=>key<bounds.start?bounds.start:key>bounds.end?bounds.end:key;
  CAL.date=clamp(CAL.date||today);CAL.month=CAL.month||CAL.date.slice(0,7);
  if(CAL.month<bounds.start.slice(0,7)||CAL.month>bounds.end.slice(0,7))CAL.month=CAL.date.slice(0,7);
  const rows=agendaEvents(calendar),all=calendar.events||[],first=CAL.month+'-01',firstDate=new Date(first+'T12:00:00Z');
  const gridStart=agendaShift(first,-firstDate.getUTCDay()),monthEnd=new Date(firstDate);monthEnd.setUTCMonth(monthEnd.getUTCMonth()+1);monthEnd.setUTCDate(0);
  const cells=Math.ceil((firstDate.getUTCDay()+monthEnd.getUTCDate())/7)*7;
  const previous=new Date(firstDate);previous.setUTCMonth(previous.getUTCMonth()-1);const previousMonth=previous.toISOString().slice(0,7);
  const next=new Date(firstDate);next.setUTCMonth(next.getUTCMonth()+1);const nextMonth=next.toISOString().slice(0,7);
  const courses=[...new Set(all.map(row=>row.course_code).filter(Boolean))].sort().map(code=>[code,(all.find(row=>row.course_code===code)||{}).course||code]);
  const sources=[...new Set(all.map(row=>row.source).filter(Boolean))].sort().map(source=>[source,agendaSource(source)]);
  const kinds=[...new Set(all.map(row=>row.kind).filter(Boolean))].sort().map(kind=>[kind,agendaKind(kind)]);
  let grid='';for(let i=0;i<cells;i++){
    const key=agendaShift(gridStart,i),outside=key<bounds.start||key>bounds.end,dayRows=outside?[]:rows.filter(row=>agendaHasDay(row,key,timezone));
    grid+='<button type="button" class="calendar-day'+(key.slice(0,7)!==CAL.month?' other-month':'')+(key===today?' is-today':'')+'" data-calendar-day="'+key+'" aria-pressed="'+(key===CAL.date)+'" aria-label="'+h(agendaDateLabel(key))+(outside?' · outside checked dates':' · '+dayRows.length+' events')+'"'+(outside?' disabled':'')+'><span class="day-number">'+Number(key.slice(-2))+'</span>'+
      (dayRows.length?'<span class="day-count">'+dayRows.length+' '+(dayRows.length===1?'event':'events')+'</span><span class="day-preview">'+dayRows.slice(0,2).map(row=>'<span style="--sw:'+courseVar(row.course_code)+'">'+h(row.title)+'</span>').join('')+(dayRows.length>2?'<span>+'+(dayRows.length-2)+' more</span>':'')+'</span>':'')+'</button>';
  }
  const selected=rows.filter(row=>agendaHasDay(row,CAL.date,timezone));
  const warning=STALE?'Saved calendar · refresh for a current check.':(calendar.coverage||{}).feeds_status==='ok'?'Live calendars checked.':'Calendar coverage is incomplete or unknown; events may be missing.';
  return '<section class="panel calendar-panel"><div class="calendar-toolbar"><div><div class="calendar-month" aria-live="polite">'+h(agendaDateLabel(first,{weekday:undefined,day:undefined,month:'long',year:'numeric'}))+'</div><p class="calendar-timezone">'+h(timezone)+' · existing Google Calendar + eLC</p></div><div class="calendar-navigation"><button class="calendar-control" data-calendar-month="'+previousMonth+'" aria-label="Previous month"'+(previousMonth<bounds.start.slice(0,7)?' disabled':'')+'>‹</button><button class="calendar-control" data-calendar-today'+(today<bounds.start||today>bounds.end?' disabled':'')+'>Today</button><button class="calendar-control" data-calendar-month="'+nextMonth+'" aria-label="Next month"'+(nextMonth>bounds.end.slice(0,7)?' disabled':'')+'>›</button></div></div>'+
    '<div class="calendar-filters"><label>Date<input type="date" id="calendar-date" value="'+CAL.date+'" min="'+bounds.start+'" max="'+bounds.end+'"></label>'+agendaFilter('course','Courses',courses,CAL.course)+agendaFilter('source','Sources',sources,CAL.source)+agendaFilter('kind','Types',kinds,CAL.kind)+'</div>'+
    '<p class="calendar-coverage">'+h(warning)+' Checked dates: '+h(agendaDateLabel(bounds.start,{weekday:undefined,month:'short'}))+'–'+h(agendaDateLabel(bounds.end,{weekday:undefined,month:'short',year:'numeric'}))+'. Dates outside this window are disabled.</p>'+
    '<div class="calendar-weekdays" aria-hidden="true">'+['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day=>'<span>'+day+'</span>').join('')+'</div><div class="calendar-grid" role="group" aria-label="Month dates">'+grid+'</div></section>'+
    agendaList(agendaDateLabel(CAL.date),selected,timezone,STALE?'No events in this saved snapshot for the selected date. Refresh to confirm.':(calendar.coverage||{}).feeds_status==='ok'?'No events in the checked feeds for this date.':'No events returned for this date; coverage is incomplete or unknown.');
}
function briefingCurrent(d,now=new Date()){
  const briefing=d.daily_briefing;return !briefing||briefing.date===agendaDateKey(now,d.timezone||'America/New_York');
}
function briefingPanel(d){
  const b=d.daily_briefing;if(!b)return '';
  const saved=STALE||!briefingCurrent(d),warnings=b.warnings||[];
  return '<section class="panel daily-briefing'+(saved?' briefing-saved':'')+'"><div class="briefing-label">'+(saved?'Saved daily briefing':'Your daily briefing')+'</div><h3>'+h(agendaDateLabel(b.date,{weekday:'long',month:'long',day:'numeric'}))+'</h3>'+
    '<p class="briefing-summary">'+h(saved?'This briefing is from a saved check. Refresh before relying on today’s priorities.':b.summary||'Your latest calendar and coursework, together.')+'</p>'+
    '<p class="briefing-footnote">Based on connected calendars and bridge records. Submission receipts and full portal coverage remain separate.</p></section>';
}
function briefingExtras(d){
  const b=d.daily_briefing;if(!b)return '';
  const timezone=d.timezone||'America/New_York',today=b.today||[],exams=b.upcoming_exams||[],lectures=b.recent_lectures||[],changes=b.changes||[];
  let out='<div class="briefing-columns">'+agendaList('Today’s schedule',today,timezone,STALE?'No commitments in this saved check. Refresh to confirm.':(b.coverage||{}).feeds_status==='ok'?'No commitments in today’s checked feeds.':'No commitments returned; calendar coverage is incomplete or unknown.')+
    agendaList('Calendar exam dates',exams,timezone,'No exam-titled events in the checked calendar window. Exam coverage is not inferred from this list.',true)+'</div>'+
    '<p class="optional-note">Exam dates include definite instructor changes from checked announcements. A date-only announcement does not confirm the clock time; source gaps and ambiguous changes remain visible above.</p>';
  if(lectures.length)out+='<section class="panel"><h2>Recent lectures <span class="panel-count">'+lectures.length+'</span></h2>'+lectures.map(row=>'<div class="briefing-lecture"><b>'+h(row.title)+'</b><div>'+h(row.course||row.course_code)+' · '+h(row.date)+'</div></div>').join('')+'</section>';
  if(changes.length)out+='<section class="panel"><h2>Recent deadline changes <span class="panel-count">'+changes.length+'</span></h2>'+changes.map(row=>'<div class="chg"><span class="kind">'+h(row.type)+'</span><span>'+h(row.summary||row.title||'')+'</span></div>').join('')+'</section>';
  return out;
}
`;

export const agendaTheme=String.raw`
.tab[data-tab=calendar][aria-selected=true]{border-bottom-color:#83c8b9}.wrap[data-view=calendar]{--accent:#237a69}
.daily-briefing{border-top:3px solid var(--accent);padding:19px 20px}.briefing-label{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);font-weight:650}
.daily-briefing h3{font-size:21px;margin:5px 0 8px;letter-spacing:-.02em}.briefing-summary{font-size:15px;margin:0 0 12px;max-width:800px}
.briefing-footnote,.briefing-warnings{font-size:11px;color:var(--muted);margin:8px 0 0}.briefing-warnings{color:var(--warn);padding-left:18px}.briefing-saved{border-top-color:var(--warn)}
.briefing-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px}.briefing-lecture{font-size:13px;padding:10px 0;border-top:1px solid var(--rule)}.briefing-lecture:first-of-type{border:0}.briefing-lecture div{font-size:11px;color:var(--muted);margin-top:3px}
.calendar-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px}.calendar-month{font-size:23px;font-weight:640;letter-spacing:-.02em}.calendar-timezone{font-size:11px;color:var(--muted);margin:3px 0 0}
.agenda-reconciliation{font-size:11px;line-height:1.5;color:var(--warn);margin:8px 0 0}.agenda-reconciliation a{color:inherit;text-decoration:underline}
.announcement-checks{border-top:2px solid var(--accent)}.announcement-summary,.announcement-coverage{font-size:12px;color:var(--muted)}.announcement-coverage summary{cursor:pointer}.announcement-coverage ul{padding-left:18px;line-height:1.7}.announcement-reviews{font-size:12px;color:var(--warn);margin-top:12px}.announcement-reviews h3{font-size:13px;margin:0}.announcement-reviews p{margin:7px 0}.announcement-reviews a{color:inherit;text-decoration:underline}
.calendar-navigation{display:flex;gap:6px;align-items:center}.calendar-control{border:1px solid var(--rule2);border-radius:7px;padding:8px 13px;background:var(--sunk);color:var(--ink2);font:inherit;cursor:pointer;min-height:38px;font-size:13px}.calendar-control:disabled{opacity:.4;cursor:default}
.calendar-control:focus-visible,.calendar-day:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.calendar-filters{display:flex;gap:10px;flex-wrap:wrap;margin-top:17px}.calendar-filters label{display:flex;flex-direction:column;gap:4px;font-size:10px;color:var(--muted);min-width:125px;flex:1}.calendar-filters select,.calendar-filters input{font:inherit;font-size:13px;padding:7px 8px;border-radius:6px;border:1px solid var(--rule2);background:var(--card);color:var(--ink2);min-height:36px;min-width:0;max-width:100%}
.calendar-coverage{font-size:11px;color:var(--muted);line-height:1.55;margin:13px 0}.calendar-weekdays,.calendar-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr))}.calendar-weekdays{font-size:10px;font-weight:650;color:var(--muted);padding:5px 0}.calendar-weekdays span{padding:0 8px}
.calendar-grid{gap:1px;background:var(--rule);border:1px solid var(--rule);border-radius:8px;overflow:hidden}.calendar-day{background:var(--card);color:var(--ink);font:inherit;border:0;min-width:0;text-align:left;padding:8px;min-height:104px;display:flex;flex-direction:column;gap:4px;cursor:pointer;position:relative}.calendar-day[aria-pressed=true]{box-shadow:inset 0 0 0 2px var(--accent);background:var(--sunk)}.calendar-day.other-month{background:var(--sunk);color:var(--muted)}.calendar-day:disabled{background:var(--bg);color:var(--muted);opacity:.5;cursor:default}.day-number{font-size:12px;width:23px;height:23px;display:grid;place-items:center;border-radius:50%}.is-today .day-number{background:var(--accent);color:white;font-weight:700}.day-count{font-size:9px;color:var(--muted)}.day-preview{display:flex;flex-direction:column;gap:3px;font-size:10px;line-height:1.35;min-width:0}.day-preview span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-left:2px solid var(--sw,var(--rule2));padding-left:4px}
.agenda-event{padding:12px 0 12px 11px;border-top:1px solid var(--rule);border-left:3px solid var(--sw);margin:8px 0}.agenda-event:first-of-type{margin-top:0}.agenda-title{font-size:14px;font-weight:560;overflow-wrap:anywhere}.agenda-meta{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11px;color:var(--muted);margin-top:4px}.agenda-meta .course{color:var(--sw);font-weight:640}.agenda-evidence{font-size:10px;color:var(--warn)}.agenda-completed .agenda-title{color:var(--muted)}.agenda-event summary{cursor:pointer;list-style-position:outside}.agenda-event summary::marker{color:var(--muted);font-size:11px}.agenda-description{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink2);background:var(--sunk);padding:1px 11px;margin-top:9px;border:1px solid var(--rule);border-radius:6px}.agenda-event summary:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
@media(max-width:650px){.tabs .tab{flex:none;min-width:72px;padding:10px 9px}.daily-briefing{padding:15px}.daily-briefing h3{font-size:19px}.briefing-summary{font-size:13px}.briefing-columns{grid-template-columns:1fr;gap:0}.calendar-panel{padding:12px}.calendar-month{font-size:19px}.calendar-timezone{font-size:10px;max-width:180px}.calendar-navigation{gap:4px}.calendar-control{padding:7px 10px;font-size:12px}.calendar-filters{gap:7px;margin-top:13px}.calendar-filters label{min-width:calc(50% - 7px)}.calendar-filters input,.calendar-filters select{font-size:16px;padding:5px}.calendar-day{min-height:65px;padding:5px;gap:2px}.day-number{font-size:11px;width:22px;height:22px}.day-preview{display:none}.day-count{font-size:8px}.calendar-weekdays span{padding:0 4px}.calendar-coverage{font-size:10px}.agenda-title{font-size:13px}.agenda-meta{font-size:10px}}
`;
