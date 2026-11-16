#!/usr/bin/env python3
"""Incremental export of Cluely sessions -> ~/Claude/school-system-suite/meetings.

Uses session identity and transcript hashes; refreshes recent records and skips active recordings.
Requires the Cluely desktop app running with --remote-debugging-port=9222
(use bin/launch-cluely.sh).
"""
import argparse, hashlib, json, os, re, sys, time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from club_registry import classify as club_classify
from course_routing import title_course, route_transcript
from cdp import find_page, evaluate

ROOT     = os.path.expanduser("~/Claude/school-system-suite/meetings")
CLASSES  = os.path.join(ROOT, "Classes")
OTHER    = os.path.join(ROOT, "Other")
STATE    = os.path.join(ROOT, ".state.json")
COURSE_RE = re.compile(r"^([A-Z]{2,4})\s*(\d{4})")
MIN_TRANSCRIPT = 500          # below this a session is treated as a junk recording

def ev(ws, expr, timeout=120):
    r = evaluate(ws, expr, timeout=timeout).get("result", {})
    if "exceptionDetails" in r:
        raise RuntimeError(json.dumps(r["exceptionDetails"])[:400])
    return r.get("result", {}).get("value")

LIST_JS = r"""
(async () => {
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  const deadline = Date.now()+75000;
  location.hash = '#/dashboard';
  await sleep(3000);
  const seen = new Map();
  let stable=0, complete=false, pass=0;
  for(;pass<180 && Date.now()<deadline;pass++) {
    const before=seen.size;
    const links=[...document.querySelectorAll('a[href*="/dashboard/sessions/"]')];
    for(const a of links)
      seen.set(a.getAttribute('href'), {href:a.getAttribute('href'), ongoing:/\bOngoing\b/i.test(a.innerText)});
    // A document scroller commonly has overflow:visible. Restrict other targets
    // to ancestors of session links, so the sidebar is not the pagination target.
    const roots=new Set([document.scrollingElement || document.documentElement || document.body]);
    const candidates=new Set(roots);
    for(const a of links) for(let el=a.parentElement;el;el=el.parentElement) candidates.add(el);
    const scrollers=[...candidates].filter(el=>el && el.scrollHeight>el.clientHeight+1 &&
      (roots.has(el)||['auto','scroll','overlay'].includes(getComputedStyle(el).overflowY)));
    for(const el of scrollers) el.scrollTop=el.scrollHeight;
    const atBottom=scrollers.every(el=>el.scrollTop+el.clientHeight>=el.scrollHeight-2);
    const loading=[...document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')]
      .some(el=>el.getClientRects().length) ||
      document.body.innerText.split('\n').some(line=>/^loading(?:\s+(?:more|sessions))?[. …]*$/i.test(line.trim()));
    stable=seen.size>0 && before===seen.size && atBottom && !loading ? stable+1 : 0;
    // Eight quiet seconds at the bottom, not three unchanged subsecond reads.
    if(stable>=16) { complete=true; break; }
    await sleep(500);
  }
  return JSON.stringify({sessions:[...seen.values()],coverage_complete:complete,
    coverage_reason:complete?'stable_bottom_no_loading_8s':'pagination_limit_or_loading',passes:pass+1});
})()
"""

TAB_JS = r"""
(async () => {
  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  const href = %s, want = %s, marker = %s;
  const buttons = () => [...document.querySelectorAll('button,[role=tab]')];
  const named = name => buttons().find(b=>b.innerText.trim()===name && !b.disabled);
  if (location.hash.slice(1) !== href) { location.hash = href; await sleep(1200); }
  let tab = null;
  for (let i=0;i<40;i++) {
    if (location.hash.slice(1) !== href) return JSON.stringify({err:'session changed while opening '+want});
    tab = named(want);
    if (tab) break;
    await sleep(500);
  }
  if (!tab) return JSON.stringify({err:'tab not found: '+want});
  tab.click();
  // A loading screen can have unchanged text long before the copy control
  // exists. Sept 18 rejected three sessions with missing copy controls.
  // Require the requested control AND stable contents; do not export the shell.
  let prev=null, stable=0, txt='';
  for (let i=0;i<60;i++) {
    await sleep(500);
    if (location.hash.slice(1) !== href) return JSON.stringify({err:'session changed while reading '+want});
    txt = document.body.innerText;
    const empty = want==='Transcript' && txt.split('\n').some(line=>line.trim()==='No transcript');
    const ready = (named(marker) && txt.includes(marker)) || empty;
    if (ready) {
      if (txt === prev) { if (++stable >= 3) return JSON.stringify({text:txt}); }
      else { stable=0; prev=txt; }
    } else {
      stable=0; prev=null;
      // Navigation can replace the first tab element before its click lands.
      // Reacquire only this view tab, never recording or summary-generation controls.
      if ([10,30,50].includes(i)) { const retry=named(want); if (retry) retry.click(); }
    }
  }
  const observed = ['Summary','Transcript','Usage','Copy summary','Copy transcript'].filter(name=>named(name));
  return JSON.stringify({err:'export view not ready: '+want+'; expected '+marker+'; controls='+observed.join(',')});
})()
"""

def clean(text, marker):
    if not text:
        return ""
    i = text.find(marker)
    return (text[i + len(marker):] if i != -1 else text).strip()

def slug(s):
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"[^\w\s-]", "", s)
    return re.sub(r"\s+", "-", s)[:60].strip("-") or "untitled"

def load_state():
    if os.path.exists(STATE):
        with open(STATE) as f:
            return json.load(f)
    return {"exported": {}, "skipped": {}}

def save_state(state):
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE)


def session_route(href):
    """Accept both old hash links and v2's /#/ links without nesting hashes.

    Keep query escaping intact: decoding the whole route corrupts titles and
    dates before parse_qs gets its turn. Only the installed renderer is allowed.
    """
    parts = urlsplit(href)
    if parts.netloc and (parts.scheme != 'https' or parts.netloc != 'renderer.v2.cluely.com'):
        raise ValueError('Unexpected recording link origin')
    route = parts.fragment if parts.fragment else parts.path + ('?' + parts.query if parts.query else '')
    if not re.fullmatch(r'/dashboard/sessions/[a-f0-9-]{36}\?[^#]+', route):
        raise ValueError('Unexpected recording link format')
    return route


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--course")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--session-id", action="append", help="Only refresh these exact recording identities")
    parser.add_argument("--unclassified", action="store_true", help="Review recordings without a recognized course/club title")
    parser.add_argument("--budget-seconds", type=float, default=900, help="total export wall-time budget (default 15 minutes)")
    args = parser.parse_args()
    if args.budget_seconds <= 0: parser.error("budget must be positive")
    deadline = time.monotonic() + args.budget_seconds
    state = load_state()
    routing_path = os.path.join(ROOT, 'routing.json')
    routing = json.load(open(routing_path)) if os.path.exists(routing_path) else {}
    review_start = routing.get('review_from', '2026-08-17')
    review_end = routing.get('review_through', '2026-12-31')
    review_path = os.path.join(ROOT, '.routing-review.json')
    review = json.load(open(review_path)) if os.path.exists(review_path) else {'sessions':{}}
    def bounded_ev(ws, expression):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('export run deadline reached')
        return ev(ws, expression, timeout=min(120, remaining))
    try:
        ws = find_page("dashboard")["webSocketDebuggerUrl"]
        listing = json.loads(bounded_ev(ws, LIST_JS))
    except Exception:
        # Keep prior observation timestamps historical, never stamp them fresh.
        if not args.dry_run:
            for filename in ('.raw-inventory.json', '.club-inventory.json'):
                path = os.path.join(ROOT, filename)
                prior = json.load(open(path)) if os.path.exists(path) else {}
                prior['last_attempt_at'] = datetime.now(timezone.utc).isoformat()
                prior['coverage_complete'] = False
                prior['source_automation'] = {'status':'blocked', 'reason':'dashboard inventory unavailable'}
                with open(path+'.tmp','w') as f: json.dump(prior,f,indent=2)
                os.replace(path+'.tmp',path)
        raise
    # Older/partial readers cannot silently establish complete inventory coverage.
    links = listing.get('sessions',[]) if isinstance(listing,dict) else listing
    coverage_complete = isinstance(listing,dict) and listing.get('coverage_complete') is True
    coverage_reason = listing.get('coverage_reason','unknown') if isinstance(listing,dict) else 'legacy_unverified_inventory'
    inventory_health = {'coverage_complete':coverage_complete,'coverage_reason':coverage_reason}
    inventory, todo = [], []
    now = datetime.now(timezone.utc)
    for link in links:
        try:
            href = session_route(link["href"])
        except (ValueError, KeyError):
            continue
        match = re.search(r"/sessions/([0-9a-f-]+)\?(.*)$", href)
        if not match:
            continue
        sid = match.group(1)
        q = parse_qs(match.group(2))
        title = q.get("title", ["Untitled Meeting"])[0]
        code = title_course(title)
        clubs = club_classify(title,sid,reviewed=routing.get('sessions',{}).get(sid))
        created = q.get("createdAt", [""])[0]
        if not created:
            continue
        stamp = datetime.fromisoformat(created.replace("Z", "+00:00"))
        date = stamp.astimezone(ZoneInfo("America/New_York")).date().isoformat()
        # Inspect every current-term recording, even when the title looks unrelated.
        # Earlier personal/career recordings remain outside this school review.
        if not code and not clubs and not (review_start <= date <= review_end):
            continue
        rec = {"sid":sid,"href":href,"title":title,"created":created,
               "course":code,"clubs":clubs,"ongoing":link.get("ongoing",False),
               "date":date}
        inventory.append(rec)
        if rec["ongoing"] or (args.course and code and args.course.replace(" ","") != code):
            continue
        if args.course and clubs and not code:
            continue
        if args.session_id and sid not in args.session_id:
            continue
        if args.unclassified and (code or clubs):
            continue
        if (sid not in state["exported"] or args.refresh or (now-stamp).days <= 14
                or state['exported'][sid].get('title') != title
                or review.get('sessions', {}).get(sid, {}).get('status') == 'needs_review'):
            todo.append(rec)
    if not inventory:
        raise RuntimeError("No class-session links found; source freshness not established")
    if args.dry_run:
        print(json.dumps({"sessions":inventory,"would_refresh":len(todo),**inventory_health},indent=2))
        return 0
    for d in (CLASSES,os.path.join(ROOT,"Clubs")):
        os.makedirs(d,exist_ok=True)
    inv_path = os.path.join(ROOT,".raw-inventory.json")
    with open(inv_path + ".tmp", "w") as f:
        json.dump({"observed_at":now.isoformat(),"source":"Cluely desktop dashboard",
                   "coverage":"dashboard session links after bounded pagination",**inventory_health,
                   "sessions":inventory},f,indent=2)
    os.replace(inv_path + ".tmp",inv_path)
    if not args.course:
        club_inventory={"observed_at":now.isoformat(),**inventory_health,
            "sessions":[{"session_id":r["sid"],"created_at":r["created"],"clubs":r["clubs"],"ongoing":r["ongoing"]} for r in inventory if r.get("clubs")]}
        with open(os.path.join(ROOT,".club-inventory.json.tmp"),"w") as f: json.dump(club_inventory,f,indent=2)
        os.replace(os.path.join(ROOT,".club-inventory.json.tmp"),os.path.join(ROOT,".club-inventory.json"))
    failures = 0
    def save_review():
        review['observed_at'] = now.isoformat()
        with open(review_path + '.tmp', 'w') as f: json.dump(review, f, indent=2)
        os.replace(review_path + '.tmp', review_path)
    attempted = []
    for rec in sorted(todo,key=lambda r:r["created"]):
        if time.monotonic() >= deadline:
            failures += 1
            inventory_health['content_complete'] = False
            print('FAILED export run deadline reached; remaining sessions retained for next run')
            break
        attempted.append(rec['sid'])
        sid=rec["sid"]
        try:
            def fetch_tab(tab,marker):
                value=json.loads(bounded_ev(ws,TAB_JS % (json.dumps(rec["href"]),json.dumps(tab),json.dumps(marker))))
                if value.get("err"):
                    raise RuntimeError(value["err"])
                body=value.get("text","")
                if marker not in body:
                    if tab == 'Transcript' and 'No transcript' in body:
                        return ''
                    raise RuntimeError("missing export marker: "+marker)
                return clean(body,marker)
            summary=fetch_tab("Summary","Copy summary")
            transcript=fetch_tab("Transcript","Copy transcript")
            transcript=re.sub(r'^(.* Recording  •.*|Stop session|Session ended due to inactivity|Dismiss)$',
                              '',transcript,flags=re.M).strip()
            # Never commit empty/loading/active-session UI as a finished export.
            reviewed = routing.get('sessions',{}).get(sid)
            reviewed_decision = route_transcript(rec['title'],transcript,reviewed) if reviewed else None
            if reviewed_decision and reviewed_decision['status'] == 'excluded':
                review['sessions'][sid] = {**reviewed_decision,
                    'title':rec['title'],'date':rec['date'],'checked_at':now.isoformat()}
                save_review()
                print('REVIEW',rec['date'],sid,'excluded after content review')
                continue
            if len(transcript)<MIN_TRANSCRIPT or "Finish to see notes" in transcript:
                local_review = os.path.join(ROOT, 'Review')
                os.makedirs(local_review, exist_ok=True)
                with open(os.path.join(local_review,sid+'.json'),'w') as f:
                    json.dump({**rec,'summary':summary,'transcript':transcript},f,indent=2)
                raise RuntimeError("transcript unavailable, incomplete, or too short")
            rec['clubs'] = club_classify(rec['title'],sid,transcript=transcript,
                reviewed=routing.get('sessions',{}).get(sid,{}))
            if rec.get("clubs") and not rec.get("course"):
                path=os.path.join(ROOT,"Clubs",sid+".json")
                raw={"session_id":sid,"title":rec["title"],"created_at":rec["created"],
                    "clubs":rec["clubs"],"transcript":transcript,"completed":True}
                with open(path+".tmp","w") as f: json.dump(raw,f,indent=2)
                os.replace(path+".tmp",path)
                state["exported"][sid]={"title":rec["title"],"date":rec["date"],"created":rec["created"],
                    "path":os.path.relpath(path,ROOT),"course":None,"clubs":rec["clubs"],
                    "source_checked_at":now.isoformat()}
                save_state(state)
                review['sessions'].pop(sid, None)
                save_review()
                print("exported club",rec["date"],sid,len(transcript))
                continue
            decision = route_transcript(rec['title'], transcript, routing.get('sessions',{}).get(sid))
            review['sessions'][sid] = {**decision, 'title':rec['title'], 'date':rec['date'],
                'transcript_sha256':hashlib.sha256(transcript.encode()).hexdigest(), 'checked_at':now.isoformat()}
            if decision['status'] != 'routed':
                local_review = os.path.join(ROOT, 'Review')
                os.makedirs(local_review, exist_ok=True)
                path = os.path.join(local_review, sid + '.json')
                with open(path, 'w') as f: json.dump({**rec,'summary':summary,'transcript':transcript},f,indent=2)
                review['sessions'][sid]['path'] = os.path.relpath(path,ROOT)
                save_review()
                print('REVIEW',rec['date'],sid,decision['status'])
                continue
            rec['course'] = decision['course']
            if args.course and args.course.replace(' ','') != rec['course']:
                save_review()
                continue
            course = re.fullmatch(r'([A-Z]+)(\d+)',rec['course'])
            old=state["exported"].get(sid,{})
            path=os.path.join(ROOT,old["path"]) if old.get("path") else os.path.join(
                CLASSES, "%s_%s_%s.md" % (rec["date"],slug(rec["title"]),sid))
            body=("---\ntitle: %s\ndate: %s\nsession_id: %s\ncourse: %s %s\nsource: cluely\n---\n\n"
                  "# %s\n\n## Summary\n\n%s\n\n## Transcript\n\n%s\n") % (
                json.dumps(rec["title"]),rec["created"],sid,course[1],course[2],rec["title"],summary,transcript)
            if not os.path.exists(path) or open(path).read()!=body:
                with open(path+".tmp","w") as f: f.write(body)
                os.replace(path+".tmp",path)
            state["exported"][sid]={"title":rec["title"],"date":rec["date"],"created":rec["created"],
                "path":os.path.relpath(path,ROOT),"course":"%s %s"%(course[1],course[2]),
                "chars":len(transcript),"sha256":hashlib.sha256(body.encode()).hexdigest(),
                "source_checked_at":now.isoformat()}
            state['exported'][sid]['routing'] = decision
            save_state(state)
            save_review()
            print("exported",rec["date"],sid,len(transcript))
        except Exception as exc:
            failures+=1
            review['sessions'][sid] = {'status':'needs_review','title':rec['title'],'date':rec['date'],
                'method':'content_unavailable','error':str(exc),'checked_at':now.isoformat()}
            save_review()
            print("FAILED",rec["date"],sid,str(exc))
    write_index(state)
    # Rewrite inventory after transcript classification, retaining unclassified rows.
    with open(inv_path + '.tmp', 'w') as f:
        json.dump({'observed_at':now.isoformat(),'source':'Cluely desktop dashboard',
            'coverage':'Dashboard metadata for recognized and current-term recordings; content checks have their own timestamps',**inventory_health,
            'content_attempted_session_ids':attempted,
            'content_scope':{'session_ids':args.session_id,'course':args.course,'unclassified_only':args.unclassified},
            'sessions':inventory},f,indent=2)
    os.replace(inv_path + '.tmp', inv_path)
    # Transcript-reviewed club routes are discovered after the initial metadata
    # snapshot. Persist them without claiming a fresh content check for other rows.
    if not args.course:
        club_inventory={"observed_at":now.isoformat(),**inventory_health,
            "sessions":[{"session_id":r["sid"],"created_at":r["created"],"clubs":r["clubs"],"ongoing":r["ongoing"]}
                        for r in inventory if r.get("clubs")]}
        with open(os.path.join(ROOT,".club-inventory.json.tmp"),"w") as f: json.dump(club_inventory,f,indent=2)
        os.replace(os.path.join(ROOT,".club-inventory.json.tmp"),os.path.join(ROOT,".club-inventory.json"))
    pending = [r for r in review['sessions'].values() if r['status']=='needs_review']
    if pending: print('ROUTING REVIEW:',len(pending),'recording(s) require content review; see .routing-review.json')
    if not coverage_complete: print('INVENTORY DEFERRED:',coverage_reason)
    return 1 if failures else 3 if pending or not coverage_complete else 0


def write_index(state):
    rows = sorted(state["exported"].values(), key=lambda r: r["date"], reverse=True)
    with open(os.path.join(ROOT, "README.md"), "w") as f:
        f.write("# Cluely Meeting Archive\n\n")
        f.write("Auto-exported from the Cluely desktop app by `bin/cluely_export.py`.\n")
        f.write("Refreshes recent recordings and reviews unclassified current-term content.\n")
        f.write("See [routing rules and review queue](ROUTING.md); titles are hints, not an inclusion gate.\n\n")
        f.write("## Trust the transcript, not the summary\n\n")
        f.write("Cluely records one file per *recording window*, not per meeting, and mixes the\n")
        f.write("room mic with system audio. Anything playing through the speakers while it runs\n")
        f.write("lands in the same transcript, and its summariser will then describe that as if\n")
        f.write("it were class. Separately, the summariser sometimes asserts things the\n")
        f.write("transcript does not contain at all.\n\n")
        f.write("`bin/verify.py` checks a session against its own transcript and is run\n")
        f.write("automatically by `bin/push_notes.py`, so only material the class portion of the\n")
        f.write("transcript supports reaches the GPT bridge:\n\n")
        f.write("```\npython3 bin/verify.py Classes/*.md        # report\n")
        f.write("python3 bin/push_notes.py --dry-run        # what would be pushed, no KV writes\n```\n\n")
        f.write("Two caveats it cannot fix. Speaker labels are unreliable - in an in-person\n")
        f.write("lecture nearly every turn is tagged with your name even when the professor is\n")
        f.write("talking, so never read attribution off a transcript. And the ASR garbles proper\n")
        f.write("nouns badly; names and numbers want checking against eLC before you rely on them.\n\n")
        f.write("## Class sessions\n\n| Date | Course | Meeting | File |\n|---|---|---|---|\n")
        for r in rows:
            if r["course"]:
                f.write("| %s | %s | %s | [%s](%s) |\n" % (r["date"], r["course"],
                        r["title"].replace("|", "\\|")[:60], os.path.basename(r["path"]), r["path"]))
        f.write("\n## Other sessions\n\n| Date | Meeting | File |\n|---|---|---|\n")
        for r in rows:
            if not r["course"]:
                f.write("| %s | %s | [%s](%s) |\n" % (r["date"],
                        r["title"].replace("|", "\\|")[:60], os.path.basename(r["path"]), r["path"]))

if __name__ == "__main__":
    sys.exit(main())
