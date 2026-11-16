export function sectionFixture(){
  const now=new Date(),after=days=>new Date(now.getTime()+days*86400000).toISOString();
  const item=(title,bucket,days,code='BUSN5000')=>({title,bucket,course:code,course_code:code,assignment_id:'fixture-'+title,term_id:'2026-fall',when_iso:after(days),when:new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(after(days))),days_away:days,detail:'Synthetic preview notes. No real coursework is submitted.',completed:false});
  const overdue=item('Follow up on project team','overdue',-1);
  const today=item('Finish the landscape quiz','due_today',0,'LAND2510');
  const week=item('Prepare the strategy decision','due_this_week',3,'MGMT5560');
  const week2=item('Review the supply chain case','due_this_week',5,'MGMT4280');
  const soon=item('Prepare for the business exam','upcoming',12);
  const done={...item('Earlier quiz already reported','due_today',0),completed:true,completion:{submission_verification:'reported'}};
  const review=Array.from({length:7},(_,i)=>({record_id:'archive-'+i,revision:1,course:'BUSN5000',status:'done',item:'Archived report '+(i+1),note:'Synthetic historical report. No current assignment is linked.'}));
  return {generated_at:now.toISOString(),timezone:'America/New_York',local_time:now.toISOString(),feed_health:[{source:'elc',ok:true},{source:'personal',ok:true}],
    overdue:[overdue],due_today:[today,done],due_this_week:[week,week2],other_courses_this_week:[],upcoming:[soon],
    classes_today:[{title:'Data science seminar',course:'BUSN5000',when:'Today, 3 PM'}],
    optional_this_week:[item('Optional practice problems','optional',2)],optional_ongoing:[item('Read the weekly business briefing','optional',0)],optional_not_tracked:['LAND2510'],
    recent_changes:[{type:'moved',title:week.title,from:'Tuesday',to:'Wednesday'}],
    progress:[{item:done.title,course:'BUSN5000',status:'done',verification:'reported',at_local:'Today'}],progress_summary:{done:1},identity_review:review,
    actionable:{outstanding:[overdue,today,week,week2,soon],counts:{overdue:1,due_today:1,due_this_week:2,other_courses_this_week:0,upcoming:1,awaiting_verification:1},coverage:{feeds_status:'ok'},awaiting_verification:[done]}};
}

