/** Presentation projection only. Required-work lists and counts use the shared
 * actionable view; this must never infer completion or change an assignment. */
// Keep browser code as literal source. Serializing a bundled function can leak
// esbuild's private __name helper into the page, where that helper does not exist.
export const DASHBOARD_VIEW_JS=String.raw`
function dashboardView(d, tab) {
  const a=d.actionable||{}, c=Object.assign({},a.counts||{},d.next_actions?.counts||{}),unknown=new Set((d.next_actions?.unverified||[]).map(x=>x.assignment_id));
  const open=name=>Array.isArray(a.outstanding)
    ? a.outstanding.filter(x=>x.bucket===name&&!unknown.has(x.assignment_id)).map(row=>{
      // The compact actionable projection omits calendar notes. Join ONLY the
      // description by its exact source identity; never re-match completion.
      const matches=row.assignment_id?(d[name]||[]).filter(x=>x.assignment_id===row.assignment_id):[];
      return {...row,detail:matches.length===1?matches[0].detail||row.detail:row.detail};
    })
    : (d[name]||[]).filter(x=>x.completed!==true).map(x=>({...x,bucket:name}));
  const count=name=>c[name]??open(name).length;
  const names=tab==='today'?['overdue','due_today']:tab==='week'
    ?['due_this_week','other_courses_this_week']:tab==='upcoming'?['upcoming']:[];
  const items=names.flatMap(open);
  const completed=names.flatMap(name=>(d[name]||[]).filter(x=>x.completed===true));
  const optional=(d.optional_this_week||[]).length+(d.optional_ongoing||[]).length;
  const changes=(d.recent_changes||[]).length, reviews=(d.identity_review||[]).length;
  const calendar=(d.calendar||{}).events||[];
  const calendarSources=d.calendar?.coverage?.feeds
    ? new Set(d.calendar.coverage.feeds.filter(f=>f.ok&&f.coverage_complete!==false).map(f=>f.source)).size
    : new Set(calendar.map(x=>x.source).filter(Boolean)).size;
  const badges={today:count('overdue')+count('due_today')+(c.unverified||0),calendar:calendar.length,week:count('due_this_week')+count('other_courses_this_week'),
    upcoming:count('upcoming'),optional,changes};
  const views={
    today:{title:'Today',eyebrow:'Your daily focus',description:d.daily_briefing?'Your priorities, schedule and recent course updates, from the same live school record.':'Overdue items and work due today. Calendar deadlines, not submission verification.',
      metrics:[['Overdue',count('overdue'),'still outstanding','alarm'],['Due today',count('due_today'),'still outstanding',''],[c.unverified?'Unverified':d.daily_briefing?'Schedule':'Classes',c.unverified||(d.daily_briefing?(d.daily_briefing.today||[]).length:(d.classes_today||[]).length),c.unverified?'watcher needs a source check':'on today’s schedule','']]},
    calendar:{title:'Calendar',eyebrow:'See your time together',description:'Your existing Google Calendar and eLC feeds in one view. Select a day to see its commitments and deadline evidence.',
      metrics:[['Events',calendar.length,'in the checked window',''],['Sources',calendarSources,'feeds read successfully',''],['Deadlines',calendar.filter(x=>x.kind==='deadline').length,'completed and outstanding','']]},
    week:{title:'This week',eyebrow:'Plan your week',description:'Tomorrow through the next 7 days, across your courses. Today stays in Today.',
      metrics:[['To do',badges.week,'tracked items',''],['Days with work',new Set(items.filter(x=>Number.isFinite(Date.parse(x.when_iso))).map(x=>new Intl.DateTimeFormat('en-US',{timeZone:d.timezone||'America/New_York',year:'numeric',month:'numeric',day:'numeric'}).format(new Date(x.when_iso)))).size,'in this window',''],['Reported done',completed.length,'in this window','']]},
    upcoming:{title:'Upcoming',eyebrow:'A little further ahead',description:'8–21 days ahead. See the next deadlines and make room for bigger work.',
      metrics:[['To do',badges.upcoming,'tracked items',''],['Courses',new Set(items.map(x=>x.course_code).filter(code=>code&&code!=='GENERAL')).size,'with tracked items',''],['Reported done',completed.length,'in this window','']]},
    optional:{title:'Optional',eyebrow:'Room to explore',description:'Readings, practice and ongoing extras. Separate from your main deadline counts.',
      metrics:[['This week',(d.optional_this_week||[]).length,'dated extras',''],['Ongoing',(d.optional_ongoing||[]).length,'standing suggestions',''],['Not tracked',(d.optional_not_tracked||[]).length,'courses without a feed','']]},
    changes:{title:'Changes',eyebrow:'What’s different',description:'Detected deadline changes, your report history, and assignment links that need review.',
      metrics:[['Deadlines',changes,'changes detected',''],['Reports',(d.progress||[]).length,'recorded on the bridge',''],['Link reviews',reviews,'need your selection','']]},
  };
  return {...(views[tab]||views.today),items,completed,badges,reviews};
}
`;

export const dashboardTheme=String.raw`
[hidden]{display:none!important}
.topbar{padding:14px 24px;gap:12px}.topbar .tools{gap:8px}.topbar .sub{font-size:11px}
.syncbar{display:flex;align-items:center;gap:10px;background:var(--bar);padding:0 24px 12px}
.live{font-size:11px}.live time{color:var(--bar-muted)}
.tabs{position:sticky;top:0;z-index:10;padding:0 24px;gap:6px;scrollbar-width:none}
.tab{display:flex;align-items:center;gap:7px;padding:12px 14px;min-height:48px;transition:color .15s,background .15s}
.tab[aria-selected=true]{background:#ffffff0b;border-bottom:3px solid #e5bd79}
.tab[data-tab=week][aria-selected=true]{border-bottom-color:#63acd0}.tab[data-tab=upcoming][aria-selected=true]{border-bottom-color:#b794e0}
.tab[data-tab=optional][aria-selected=true]{border-bottom-color:#7bbb96}.tab[data-tab=changes][aria-selected=true]{border-bottom-color:#db9786}
.tab-count{display:inline-grid;place-items:center;min-width:19px;padding:1px 5px;border-radius:5px;background:#ffffff12;font-size:10px;font-variant-numeric:tabular-nums}
.tab-count:empty{display:none}
.wrap{max-width:1180px;margin:auto;padding:22px 24px 100px;--accent:#95621b}
.wrap[data-view=week]{--accent:#26789f}.wrap[data-view=upcoming]{--accent:#855ab4}
.wrap[data-view=optional]{--accent:#327954}.wrap[data-view=changes]{--accent:#b55844}
.view-intro{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:16px;border-left:3px solid var(--accent);padding-left:15px}
.view-eyebrow{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);font-weight:650}
.view-intro h2{font-size:29px;line-height:1.2;letter-spacing:-.025em;margin:4px 0 5px;color:var(--ink)}
.view-description{font-size:12px;color:var(--muted);margin:0;max-width:650px}
.review-shortcut{background:var(--card);color:var(--ink2);border:1px solid var(--rule2);border-radius:8px;padding:8px 12px;font:inherit;font-size:11px;white-space:nowrap;cursor:pointer}
.review-shortcut:hover{border-color:var(--accent)}
.kpis{position:static;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;background:none;border:0;margin:0 0 18px}
.kpi{border:1px solid var(--rule);border-radius:10px;padding:14px 16px;min-width:0}
.kpi .v{font-size:29px;margin-top:7px}.kpi .s{font-size:11px}.kpi .k{font-size:10px;letter-spacing:.08em}
.panel{border-radius:10px;padding:16px 18px}.panel h2{letter-spacing:.06em;display:flex;gap:8px;align-items:center}
.panel-count{font-size:10px;border-radius:4px;padding:1px 6px;background:var(--sunk);color:var(--ink2)}
.item{padding:13px 0}.item .t{line-height:1.45}.item .m{row-gap:3px}
.item .body[role=button]:focus-visible{outline:2px solid var(--accent);outline-offset:4px;border-radius:3px}
.item .mark{min-height:34px}.item.done .t{opacity:.75}
.fold{padding:0}.fold>summary{padding:15px 18px;cursor:pointer;font-size:12px;font-weight:600;color:var(--ink2)}
.fold[open]>summary{border-bottom:1px solid var(--rule)}.fold-content{padding:4px 18px 15px}
.fold-content>p{font-size:12px;color:var(--muted)}.fold-content>.panel{border:0;margin:0;padding:12px 0}
.day-group{border-left:3px solid var(--accent)}.day-group h2{color:var(--accent)}
.optional-note{font-size:12px;color:var(--muted);padding:0 4px 12px}
.overview{margin-top:20px;border-top:1px solid var(--rule);color:var(--muted);font-size:11px;padding-top:14px}
.overview>summary{cursor:pointer;padding:6px 0}.overview .kpis{margin-top:12px;grid-template-columns:repeat(3,minmax(0,1fr))}
.overview .kpi .v{font-size:21px}.notice:empty{display:none}.notice{max-width:1132px;margin:12px auto;padding:0 14px}
.empty{line-height:1.65}.view-feedback{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.chg{padding:12px 0}.chg .kind{font-size:10px}.review-row p{font-size:12px;line-height:1.6}
.review-shortcut:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
@media(max-width:650px){
 .topbar{padding:13px 14px 9px;gap:10px}.topbar h1{font-size:15px}.topbar .sub{font-size:10px}
 .topbar .tools{width:100%;justify-content:flex-start;gap:7px}.topbar .btn{font-size:11px;padding:5px 9px;min-height:31px}
 .topbar .tools>a{margin-right:auto}.syncbar{padding:0 14px 9px}.live{font-size:10px;flex-wrap:wrap;row-gap:2px}
 .tabs{padding:0 8px;gap:0}.tab{flex:1;justify-content:center;gap:4px;padding:10px 3px;font-size:11px;min-height:44px;min-width:0}
 .tab-count{font-size:9px;min-width:15px;padding:1px 3px}
 .wrap{padding:18px 12px 95px}.view-intro{gap:9px;align-items:flex-start;padding-left:11px;margin-bottom:13px}
 .view-intro h2{font-size:26px}.view-eyebrow{font-size:9px}.view-description{font-size:11px;line-height:1.5}
 .review-shortcut{font-size:10px;padding:6px 7px}.kpis{gap:6px;margin-bottom:14px}
 .kpi{padding:10px 9px}.kpi .k{font-size:9px;letter-spacing:.03em}.kpi .v{font-size:25px;margin-top:5px}.kpi .s{font-size:9px;line-height:1.35}
 .panel{padding:13px}.panel h2{font-size:10px;margin-bottom:7px}.item{gap:8px;padding:12px 0}.item .t{font-size:13px}.item .m{font-size:10px;gap:5px}
 .item .mark{font-size:10px;padding:5px 7px}.fold{padding:0}.fold>summary{padding:13px}.fold-content{padding:0 13px 12px}
 .overview .kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.fab{right:14px;bottom:max(14px,env(safe-area-inset-bottom))}
 .chat{right:12px;width:calc(100vw - 24px)}
}
@media(prefers-reduced-motion:reduce){*{animation:none!important;scroll-behavior:auto!important}}
`;
