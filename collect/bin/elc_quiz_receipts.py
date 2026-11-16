"""Bounded read-only student quiz-result fallback when the eLC API denies access.

Only the current course's own submissions links are followed. Quiz summary/start
links are never fetched. A result requires the authenticated owner, matching quiz
title, an attempt-results heading and an explicit Written start/end interval.
Everything else, including unavailable timestamps, stays unknown. Questions,
grades and answers remain in the ephemeral parsed page and are never returned.
"""
from datetime import datetime, timedelta, timezone
import json
import re
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

import chrome_bridge as cb
import elc_announcements as news

TZ = ZoneInfo('America/New_York')
LIST_PATH = '/d2l/lms/quizzing/user/quizzes_list.d2l'
SUBMISSIONS_PATH = '/d2l/lms/quizzing/user/quiz_submissions.d2l'
ATTEMPT_PATH = '/d2l/lms/quizzing/user/quiz_submissions_attempt.d2l'
MAX_QUIZZES = 12
MAX_ATTEMPTS = 5
PARAMETERS = {'qi', 'ai', 'ou', 'isprv', 'isInPopup', 'cfql', 'fromQB', 'fromSubmissionsList'}
ID = re.compile(r'[1-9]\d{0,11}\Z')
DATE_TEXT = r'([A-Za-z]{3,9})\s*(\d{1,2}),?\s*(20\d{2})\s*(\d{1,2}):(\d{2})\s*(AM|PM)'


def display_time(value):
    if not isinstance(value, str):
        return None
    match = re.fullmatch(DATE_TEXT, re.sub(r'\s+', ' ', value.strip()), flags=re.I)
    if not match:
        return None
    month, day, year, hour, minute, meridiem = match.groups()
    months = {datetime(2000, m, 1).strftime('%b').lower(): m for m in range(1, 13)}
    month = months.get(month[:3].lower())
    hour = int(hour)
    if not month or not 1 <= hour <= 12:
        return None
    try:
        value = datetime(int(year), month, int(day), hour % 12 + (12 if meridiem.upper() == 'PM' else 0), int(minute), tzinfo=TZ)
        # Ambiguous/folded or nonexistent DST clocks are not submission proof.
        if value.replace(fold=0).utcoffset() != value.replace(fold=1).utcoffset():
            return None
        return value.astimezone(timezone.utc).isoformat(timespec='seconds')
    except ValueError:
        return None


def receipt_url(value, org, *, path, quiz=None, attempt=None):
    if not isinstance(value, str):
        return None
    url = urlparse(value)
    if (url.scheme != 'https' or url.netloc != 'uga.view.usg.edu' or url.path != path
            or url.fragment or url.username or url.password):
        return None
    query = parse_qs(url.query, keep_blank_values=True)
    if set(query) - PARAMETERS or any(len(v) != 1 for v in query.values()):
        return None
    if query.get('ou') != [str(org)] or not ID.fullmatch(query.get('qi', [''])[0]):
        return None
    if quiz and query.get('qi') != [str(quiz)]:
        return None
    if path == ATTEMPT_PATH:
        if not ID.fullmatch(query.get('ai', [''])[0]) or (attempt and query.get('ai') != [str(attempt)]):
            return None
    elif 'ai' in query:
        return None
    return query


def title_key(value):
    return re.sub(r'[^a-z0-9]', '', str(value).casefold())


def normalize_receipt(course, org, row, observed_at, *, term_id='fall-2026'):
    if not isinstance(row, dict) or row.get('receipt_origin') != 'quiz_results':
        raise ValueError('response')
    quiz, attempt = str(row.get('item_id', '')), str(row.get('receipt_id', ''))
    if not receipt_url(row.get('source_url'), org, path=ATTEMPT_PATH, quiz=quiz, attempt=attempt):
        raise ValueError('identity')
    title, owner, actual_owner = row.get('title'), row.get('expected_owner'), row.get('result_owner')
    if not isinstance(title, str) or not title.strip() or len(title) > 240:
        raise ValueError('response')
    if news.SECRET.search(title) or news.SCORES.search(title):
        raise ValueError('privacy')
    if (not isinstance(owner, str) or not owner.strip()
            or re.sub(r'\s+', ' ', owner.strip()).casefold() != re.sub(r'\s+', ' ', str(actual_owner).strip()).casefold()):
        raise ValueError('identity')
    result_title = row.get('result_title', '')
    if not isinstance(result_title, str) or not re.search(r'\s*-\s*Results\s*\Z', result_title, re.I):
        raise ValueError('response')
    if title_key(re.sub(r'\s*-\s*Results\s*\Z', '', result_title, flags=re.I)) != title_key(title):
        raise ValueError('identity')
    if not re.fullmatch(r'Attempt\s+[1-9]\d*\s+of\s+[1-9]\d*', str(row.get('attempt_heading', '')).strip(), re.I):
        raise ValueError('response')
    interval = row.get('written', '')
    match = re.fullmatch(r'Written\s+(.+?)\s+-\s+(.+)', interval.strip()) if isinstance(interval, str) else None
    start, end = (display_time(match[1]), display_time(match[2])) if match else (None, None)
    observed = news.stamp(observed_at)
    due = news.stamp(row.get('due_at'))
    if not start or not end or not observed or not due:
        raise ValueError('response')
    begin, finish, checked, deadline = map(datetime.fromisoformat, (start, end, observed, due))
    term_start, term_end = datetime(2026, 8, 1, tzinfo=timezone.utc), datetime(2027, 1, 1, tzinfo=timezone.utc)
    if not term_start <= begin <= finish <= checked + timedelta(minutes=5) or finish >= term_end or not term_start <= deadline < term_end:
        raise ValueError('response')
    return {'provider': 'elc', 'course_code': course, 'term_id': term_id,
            'source_url': row['source_url'], 'provider_item_id': f'quiz:{quiz}:attempt:{attempt}',
            'kind': 'quiz', 'title': re.sub(r'\s+', ' ', title).strip(), 'status': 'submitted',
            'submitted_at': end, 'observed_at': observed, 'due_at': due,
            'source_evidence': f'eLC own quiz results receipt {attempt} shows a Written interval ending {end}.'}


REQUEST_JS = r"""
  async function request(path) {
    if(Date.now()>stop) return {error:'timeout'};
    var abort=new AbortController(), timer=setTimeout(function(){abort.abort();},8000);
    try {
      var r=await fetch(path,{method:'GET',credentials:'include',signal:abort.signal,cache:'no-store',redirect:'error'});
      if(!r.ok) return {error:r.status===401?'session':r.status===403?'permission':'http'};
      var txt=await r.text(); if(txt.length>2097152) return {error:'oversized'};
      return {document:new DOMParser().parseFromString(txt,'text/html')};
    } catch(e) {return {error:e&&e.name==='AbortError'?'timeout':'response'};}
    finally {clearTimeout(timer);}
  }
  function safeURL(href,path,org,quiz) {
    try {
      var u=new URL(href,'https://uga.view.usg.edu');
      if(u.origin!=='https://uga.view.usg.edu'||u.pathname!==path||u.hash||u.username||u.password||u.searchParams.get('ou')!==org) return null;
      var allowed=['qi','ai','ou','isprv','isInPopup','cfql','fromQB','fromSubmissionsList'];
      for(var k of u.searchParams.keys()) if(!allowed.includes(k)||u.searchParams.getAll(k).length!==1) return null;
      if(!/^[1-9]\d{0,11}$/.test(u.searchParams.get('qi')||'')||(quiz&&u.searchParams.get('qi')!==quiz)) return null;
      if(path.endsWith('quiz_submissions_attempt.d2l')&&!/^[1-9]\d{0,11}$/.test(u.searchParams.get('ai')||'')) return null;
      return u;
    } catch(e) {return null;}
  }
"""


def read_courses(win, tab, courses, owners, *, cfg=None, now=None):
    """Read only current-horizon result receipts from discovered own-user links."""
    cfg = cfg or news.source_config()
    now = now or datetime.now(timezone.utc)
    selected = {c: str(org) for c, org in courses.items() if str(cfg['courses'].get(c)) == str(org) and owners.get(c)}
    if not selected:
        return {}
    first = r"""
      window.__quizListing='pending';
      (async function(){
        var C=__COURSES__, out={}, stop=Date.now()+60000;
        if(window.location.origin!=='https://uga.view.usg.edu'){window.__quizListing={};return;}
        __REQUEST__
        for(var course of Object.keys(C)) {
          var org=C[course], got=await request(__LIST_PATH__+'?ou='+org), rows=[], seen=new Set();
          if(got.error){out[course]={error:got.error};continue;}
          var doc=got.document;
          for(var a of doc.querySelectorAll('a[href]')) {
            var u=safeURL(a.getAttribute('href'),'/d2l/lms/quizzing/user/quiz_submissions.d2l',org);
            if(!u||seen.has(u.searchParams.get('qi'))) continue;
            var tr=a.closest('tr');if(!tr) continue;
            var first=tr.querySelector('td'), title='';
            if(first) {
              var name=first.querySelector('a');
              title=(name?name.textContent:first.textContent.split(/\n|Due on/i)[0]).replace(/\s+/g,' ').trim();
            }
            var text=tr.textContent.replace(/\s+/g,' '), m=text.match(/\bDue on\s+([A-Za-z]{3,9}\s*\d{1,2},?\s*20\d{2}\s*\d{1,2}:\d{2}\s*(?:AM|PM))/i);
            if(!title||title.length>240||!m) continue;
            seen.add(u.searchParams.get('qi'));
            rows.push({title:title,item_id:u.searchParams.get('qi'),submissions_url:u.href,due_text:m[1]});
          }
          out[course]={rows:rows,scope:'current_horizon_results'};
        }
        window.__quizListing=out;
      })().catch(function(){window.__quizListing={};});'ok'
    """.replace('__COURSES__', json.dumps(selected)).replace('__REQUEST__', REQUEST_JS).replace('__LIST_PATH__', json.dumps(LIST_PATH))
    try:
        cb.run_js(win, tab, first)
        listing = cb.await_global(win, tab, '__quizListing', timeout=75)
    except cb.ChromeError:
        return {c: {'error': 'browser'} for c in selected}
    target, output = {}, {}
    for course, org in selected.items():
        bucket = listing.get(course, {}) if isinstance(listing, dict) else {}
        eligible = []
        rows = bucket.get('rows') if isinstance(bucket, dict) else None
        if not isinstance(rows, list) or len(rows) > 120:
            output[course] = {'error': bucket.get('error', 'response') if isinstance(bucket, dict) else 'response'}
            continue
        for row in rows:
            due = display_time(row.get('due_text')) if isinstance(row, dict) else None
            if not due or not receipt_url(row.get('submissions_url'), org, path=SUBMISSIONS_PATH, quiz=row.get('item_id')):
                continue
            if now.astimezone(TZ).date() - timedelta(days=10) <= datetime.fromisoformat(due).astimezone(TZ).date() <= now.astimezone(TZ).date() + timedelta(days=45):
                eligible.append({**row, 'due_at': due, 'expected_owner': owners[course]})
        target[course] = {'org': org, 'rows': eligible[:MAX_QUIZZES], 'bounded': len(eligible) > MAX_QUIZZES}
    if not target:
        return output
    second = r"""
      window.__quizResults='pending';
      (async function(){
        var C=__COURSES__, out={}, stop=Date.now()+90000;
        if(window.location.origin!=='https://uga.view.usg.edu'){window.__quizResults={};return;}
        __REQUEST__
        for(var course of Object.keys(C)) {
          var spec=C[course], receipts=[], failed=false, checked=0;
          for(var row of spec.rows) {
            var submissions=await request(new URL(row.submissions_url).pathname+new URL(row.submissions_url).search);
            if(submissions.error){failed=true;continue;}
            var links=[], seen=new Set();
            for(var a of submissions.document.querySelectorAll('a[href]')) {
              var u=safeURL(a.getAttribute('href'),'/d2l/lms/quizzing/user/quiz_submissions_attempt.d2l',spec.org,row.item_id);
              if(u&&!seen.has(u.searchParams.get('ai'))){seen.add(u.searchParams.get('ai'));links.push(u.href);}
            }
            if(links.length>5){failed=true;links=links.slice(0,5);}
            for(var href of links) {
              var u=new URL(href), got=await request(u.pathname+u.search);
              if(got.error){failed=true;continue;}
              var d=got.document, h1=d.querySelector('h1#d_page_title'), heads=Array.from(d.querySelectorAll('h2'));
              var title=heads.map(function(h){return h.textContent.trim();}).find(function(t){return /\s*-\s*Results$/i.test(t);});
              var attempt=heads.map(function(h){return h.textContent.trim();}).find(function(t){return /^Attempt\s+\d+\s+of\s+\d+$/i.test(t);});
              var labels=Array.from(d.querySelectorAll('label')).map(function(l){return l.textContent.replace(/\s+/g,' ').trim();}).filter(function(t){return /^Written\s/.test(t);});
              if(!h1||!title||!attempt||labels.length!==1){failed=true;continue;}
              receipts.push({receipt_origin:'quiz_results',kind:'quiz',item_id:row.item_id,receipt_id:u.searchParams.get('ai'),
                title:row.title,due_at:row.due_at,expected_owner:row.expected_owner,result_owner:h1.textContent.replace(/\s+/g,' ').trim(),
                result_title:title,attempt_heading:attempt,written:labels[0],source_url:href});
            }
            checked++;
          }
          out[course]={receipts:receipts,coverage:{status:'partial',scope:'current_horizon_results',checked:checked,
             error:failed?'response':spec.bounded?'oversized':null}};
        }
        window.__quizResults=out;
      })().catch(function(){window.__quizResults={};});'ok'
    """.replace('__COURSES__', json.dumps(target)).replace('__REQUEST__', REQUEST_JS)
    try:
        cb.run_js(win, tab, second)
        result = cb.await_global(win, tab, '__quizResults', timeout=105)
        output.update({c: result.get(c, {'error': 'response'}) if isinstance(result, dict) else {'error': 'response'} for c in target})
    except cb.ChromeError:
        output.update({c: {'error': 'browser'} for c in target})
    return output
