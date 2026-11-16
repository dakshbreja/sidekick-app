#!/usr/bin/env python3
"""Observe eLC's own submitted receipts on the existing hourly sweep.

This stage never submits work. It reads only current pinned courses and the
authenticated user's own quiz attempts/assignment submissions. Dates, views,
manual completion flags and grade values do not constitute submitted evidence.
Unsupported student permissions remain unknown, never an empty healthy result.
Scores, feedback, files and answers are stripped before data leaves the page.

Current D2L contracts (LE 1.82+):
https://docs.valence.desire2learn.com/res/dropbox.html
https://docs.valence.desire2learn.com/res/quiz.html
https://docs.valence.desire2learn.com/res/apiprop.html
"""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import time

import chrome_bridge as cb
import elc_announcements as news
import elc_quiz_receipts

STATE = news.ROOT / ".elc-submission-state.json"
MIN_GAP_SECONDS = 55 * 60
MAX_ITEMS = 120
MAX_RECEIPTS = 240
ERRORS = {"browser", "session", "permission", "course_identity", "course_missing",
          "http", "timeout", "response", "oversized", "identity", "privacy"}
ID = re.compile(r"[1-9]\d{0,11}\Z")
KINDS = ("quiz", "assignment")


def due(*, state_path=STATE, now=None):
    state = news.load_json(state_path, {})
    last = state.get("last_attempt_epoch", 0)
    return not isinstance(last, (int, float)) or (time.time() if now is None else now) - last >= MIN_GAP_SECONDS


def valid_time(value, observed_at):
    parsed = news.stamp(value)
    if not parsed:
        return None
    date = datetime.fromisoformat(parsed)
    observed = datetime.fromisoformat(observed_at)
    # A current Fall 2026 receipt cannot identify past/future term work.
    if (date < datetime(2026, 8, 1, tzinfo=timezone.utc)
            or date > min(datetime(2027, 1, 1, tzinfo=timezone.utc), observed + timedelta(minutes=5))):
        return None
    return parsed


def normalized_observations(course, org, bucket, observed_at, term_id="fall-2026"):
    """Project only explicit receipts; a malformed read cannot authorize saves."""
    if not isinstance(bucket, dict) or str(bucket.get("org_unit_id")) != str(org):
        raise ValueError("identity")
    rows = bucket.get("receipts")
    if not isinstance(rows, list) or len(rows) > MAX_RECEIPTS:
        raise ValueError("oversized" if isinstance(rows, list) else "response")
    out, seen = [], set()
    for row in rows:
        if not isinstance(row, dict) or row.get("kind") not in KINDS:
            raise ValueError("response")
        kind = row["kind"]
        if row.get("receipt_origin") == "quiz_results":
            observation = elc_quiz_receipts.normalize_receipt(course, org, row, observed_at, term_id=term_id)
            key = (kind, str(row.get('item_id')), str(row.get('receipt_id')))
            if key in seen:
                raise ValueError("identity")
            seen.add(key)
            out.append(observation)
            continue
        version = row.get("api_version", bucket.get("version", ""))
        if not re.fullmatch(r"1\.\d{2,3}", str(version)) or int(version.split(".")[1]) < 82:
            raise ValueError("response")
        item_id, receipt_id = str(row.get("item_id", "")), str(row.get("receipt_id", ""))
        if not ID.fullmatch(item_id) or not ID.fullmatch(receipt_id):
            raise ValueError("identity")
        key = (kind, item_id, receipt_id)
        if key in seen:
            raise ValueError("identity")
        seen.add(key)
        title = row.get("title")
        if not isinstance(title, str) or not title.strip() or len(title) > 240:
            raise ValueError("response")
        title = re.sub(r"\s+", " ", title).strip()
        if news.SECRET.search(title) or news.SCORES.search(title):
            raise ValueError("privacy")
        submitted = valid_time(row.get("submitted_at"), observed_at)
        # Explicit proof is required even if a provider supplies a score or flag.
        if not submitted or row.get("own_user_receipt") is not True:
            continue
        prefix = "https://uga.view.usg.edu/d2l/api/le/" + version + "/" + str(org)
        if kind == "quiz":
            if row.get("receipt_status") != "completed":
                continue
            user_id = str(row.get("own_user_id", ""))
            if not ID.fullmatch(user_id) or str(row.get("receipt_user_id", "")) != user_id:
                raise ValueError("identity")
            source_url = prefix + "/quizzes/" + item_id + "/attempts/?userId=" + user_id
            proof = "eLC own-user quiz attempt " + receipt_id + " has an explicit Completed timestamp."
            provider_item_id = "quiz:" + item_id + ":attempt:" + receipt_id
        else:
            if row.get("receipt_status") != "submitted" or str(row.get("submission_type")) not in ("0", "1", "4"):
                continue
            source_url = prefix + "/dropbox/folders/" + item_id + "/submissions/mysubmissions/"
            proof = "eLC own-submissions receipt " + receipt_id + " has an explicit SubmissionDate."
            provider_item_id = "assignment:" + item_id + ":submission:" + receipt_id
        # The source reference must be the read endpoint, not user text or a URL
        # discovered inside submission content. No files/content are requested.
        if row.get("source_url") != source_url:
            raise ValueError("identity")
        result = {"provider": "elc", "course_code": course, "term_id": term_id,
                  "source_url": source_url, "provider_item_id": provider_item_id,
                  "kind": kind, "title": title, "submitted_at": submitted,
                  "observed_at": observed_at, "status": "submitted",
                  "source_evidence": proof}
        if row.get("due_at"):
            value = news.stamp(row["due_at"])
            if value and "2026-08" <= value[:7] <= "2026-12":
                result["due_at"] = value
        out.append(result)
    return out


def read_courses(win, tab, discovered, *, cfg=None, term_code=None):
    cfg = cfg or news.source_config()
    found = {news.course_code(c): str(org) for c, org in (discovered or {}).items()}
    selected, out = {}, {}
    for course, org in cfg["courses"].items():
        if term_code != cfg["elc_term_code"] or found.get(course) != str(org):
            out[course] = {"error": "course_missing" if course not in found else "course_identity"}
        else:
            selected[course] = str(org)
    if not selected:
        return out
    # Only GET requests. API JSON remains ephemeral in the page; whitelist the
    # observation fields before returning anything to the local collector.
    js = r"""
      window.__submissionRead = 'pending';
      (async function(){
        var C=__COURSES__, out={}, stop=Date.now()+120000, id=/^[1-9]\d{0,11}$/;
        if(window.location.origin!=='https://uga.view.usg.edu') {
          for(var code of Object.keys(C)) out[code]={error:'identity'};
          window.__submissionRead=out; return;
        }
        async function request(path) {
          if(Date.now()>stop) return {error:'timeout'};
          var abort=new AbortController(), timer=setTimeout(function(){abort.abort();},8000);
          try {
            var r=await fetch(path,{method:'GET',credentials:'include',signal:abort.signal,cache:'no-store',redirect:'error'});
            if(!r.ok) return {error:r.status===401?'session':r.status===403?'permission':'http'};
            var txt=await r.text(); if(txt.length>2097152) return {error:'oversized'};
            try {return {json:JSON.parse(txt)};} catch(e) {return {error:'response'};}
          } catch(e) {return {error:e&&e.name==='AbortError'?'timeout':'response'};}
          finally {clearTimeout(timer);}
        }
        function rows(j) {
          if(Array.isArray(j)) return {items:j,complete:true};
          if(j&&Array.isArray(j.Objects)&&Object.prototype.hasOwnProperty.call(j,'Next'))
            return {items:j.Objects,complete:!j.Next};
          return {error:'response'};
        }
        var versions=['1.82'], v=await request('/d2l/api/le/versions/');
        if(v.json&&Array.isArray(v.json.SupportedVersions)) {
          var vs=v.json.SupportedVersions.filter(function(x){return /^1\.\d{2,3}$/.test(x)&&Number(x.split('.')[1])>=82;});
          vs.sort(function(a,b){return Number(a.split('.')[1])-Number(b.split('.')[1]);});
          if(vs.length) versions=[vs[0],vs[vs.length-1]].filter(function(x,i,a){return a.indexOf(x)===i;});
        }
        var who=await request('/d2l/api/lp/1.9/users/whoami'), user=who.json&&String(who.json.Identifier||'');
        var owner=who.json&&[who.json.FirstName,who.json.LastName].filter(Boolean).join(' ').trim();
        var domOwners=Array.from(document.querySelectorAll('[aria-label],[title]')).map(function(n){
          return (n.getAttribute('aria-label')||n.getAttribute('title')||'').match(/^(.+),\s*avatar$/i);
        }).filter(Boolean).map(function(m){return m[1].trim();});
        domOwners=Array.from(new Set(domOwners));
        if(!owner&&domOwners.length===1) owner=domOwners[0];
        if(owner&&domOwners.length===1&&owner.replace(/\s+/g,' ').toLowerCase()!==domOwners[0].replace(/\s+/g,' ').toLowerCase()) owner='';
        if(!id.test(user||'')) {
          for(var code of Object.keys(C)) out[code]={error:who.error||'identity'};
          window.__submissionRead=out; return;
        }
        async function readCourse(code) {
          var org=C[code], bucket={org_unit_id:org,version:versions[0],owner_name:owner||null,receipts:[],coverage:{}}, end=Date.now()+55000;
          for(var kind of ['quiz','assignment']) {
            var list, version;
            for(var ver of versions) {
              version=ver;
              list=await request('/d2l/api/le/'+ver+'/'+org+(kind==='quiz'?'/quizzes/':'/dropbox/folders/'));
              if(!list.error||list.error==='permission'||list.error==='session'||list.error==='timeout') break;
            }
            var page=rows(list.json), cov={status:'unknown',error:list.error||page.error||null,checked:0,total:null};
            bucket.coverage[kind]=cov;
            if(cov.error) continue;
            if(page.items.length>120) {cov.error='oversized';continue;}
            cov.status=page.complete?'ok':'partial';cov.total=page.items.length;
            bucket.version=version;
            for(var item of page.items) {
              if(Date.now()>end||Date.now()>stop) {cov.status='partial';cov.error='timeout';break;}
              var itemId=String(kind==='quiz'?item.QuizId:item.Id);
              if(!id.test(itemId)||typeof item.Name!=='string') {cov.status='partial';cov.error='identity';continue;}
              var path='/d2l/api/le/'+version+'/'+org+(kind==='quiz'?'/quizzes/'+itemId+'/attempts/?userId='+user:'/dropbox/folders/'+itemId+'/submissions/mysubmissions/');
              var got=await request(path), receiptPage=rows(got.json);
              if(got.error||receiptPage.error) {cov.status='partial';cov.error=got.error||receiptPage.error;continue;}
              if(receiptPage.items.length>240) {cov.status='partial';cov.error='oversized';continue;}
              cov.checked++;
              if(!receiptPage.complete) {cov.status='partial';cov.error='response';}
              if(kind==='quiz') {
                for(var a of receiptPage.items) {
                  if(String(a.UserId)!==user||String(a.QuizId)!==itemId) {cov.status='partial';cov.error='identity';continue;}
                  if(!a.Completed) continue;
                  bucket.receipts.push({kind:kind,item_id:itemId,receipt_id:String(a.AttemptId),title:item.Name,
                    api_version:version,
                    submitted_at:a.Completed,own_user_receipt:true,own_user_id:user,receipt_user_id:String(a.UserId),
                    receipt_status:'completed',due_at:item.DueDate||null,source_url:'https://uga.view.usg.edu'+path});
                }
              } else if([0,1,4].includes(Number(item.SubmissionType))) {
                for(var entity of receiptPage.items) {
                  var type=entity.Entity&&entity.Entity.EntityType, entityId=entity.Entity&&String(entity.Entity.EntityId);
                  if((type==='User'&&entityId!==user)||(type!=='User'&&type!=='Group')) {cov.status='partial';cov.error='identity';continue;}
                  for(var s of (Array.isArray(entity.Submissions)?entity.Submissions:[])) {
                  if(!s.SubmissionDate) continue;
                  bucket.receipts.push({kind:kind,item_id:itemId,receipt_id:String(s.Id),title:item.Name,
                    api_version:version,
                    submitted_at:s.SubmissionDate,own_user_receipt:true,receipt_status:'submitted',
                    submission_type:String(item.SubmissionType),due_at:item.DueDate||null,source_url:'https://uga.view.usg.edu'+path});
                  }
                }
              }
              if(bucket.receipts.length>240) {bucket.receipts=[];cov.status='unknown';cov.error='oversized';break;}
            }
          }
          out[code]=bucket;
        }
        var queue=Object.keys(C).sort();
        async function worker(){while(queue.length){var code=queue.shift();await readCourse(code);}}
        await Promise.all([worker(),worker(),worker()]);
        window.__submissionRead=out;
      })().catch(function(){window.__submissionRead={error:'response'};});
      'ok'
    """.replace("__COURSES__", json.dumps(selected))
    try:
        cb.run_js(win, tab, js)
        fetched = cb.await_global(win, tab, "__submissionRead", timeout=150)
        if isinstance(fetched, dict):
            out.update({c: fetched.get(c, {"error": "response"}) for c in selected})
        else:
            out.update({c: {"error": "response"} for c in selected})
    except cb.ChromeError:
        out.update({c: {"error": "browser"} for c in selected})
    fallback_courses, owners = {}, {}
    for course in selected:
        bucket = out.get(course, {})
        if (isinstance(bucket, dict) and bucket.get('owner_name')
                and isinstance(bucket.get('coverage'), dict)
                and bucket['coverage'].get('quiz', {}).get('status') != 'ok'):
            fallback_courses[course] = selected[course]
            owners[course] = bucket['owner_name']
    if fallback_courses:
        fallback = elc_quiz_receipts.read_courses(win, tab, fallback_courses, owners, cfg=cfg)
        for course, result in fallback.items():
            if not isinstance(result, dict) or not isinstance(result.get('receipts'), list):
                continue
            bucket = out[course]
            already = {(r.get('kind'), r.get('item_id'), r.get('receipt_id')) for r in bucket['receipts']}
            bucket['receipts'].extend(r for r in result['receipts'] if (r.get('kind'), r.get('item_id'), r.get('receipt_id')) not in already)
            bucket['coverage']['quiz'] = result.get('coverage', {'status': 'partial', 'error': 'response'})
    return out


def record(results, *, cfg=None, observed_at=None, dry=False, state_path=STATE, log=None):
    cfg = cfg or news.source_config()
    log = log or (lambda message: None)
    at = news.stamp(observed_at) or news.stamp()
    previous = news.load_json(state_path, {})
    prior_coverage = {(r.get("course_code"), r.get("kind")): r for r in previous.get("coverage", []) if isinstance(r, dict)}
    coverage, observations = [], []
    for course, org in sorted(cfg["courses"].items()):
        bucket = results.get(course, {}) if isinstance(results, dict) else {}
        try:
            current = normalized_observations(course, org, bucket, at, cfg["term_id"])
            observations.extend(current)
            err = None
        except ValueError as error:
            err = bucket.get("error") if isinstance(bucket, dict) else str(error)
            err = err if err in ERRORS else str(error) if str(error) in ERRORS else "response"
        for kind in KINDS:
            source_coverage = bucket.get("coverage") if isinstance(bucket, dict) else None
            cov = source_coverage.get(kind) if isinstance(source_coverage, dict) else None
            cov = cov if isinstance(cov, dict) else {}
            status = cov.get("status") if cov.get("status") in ("ok", "partial", "unknown") and not err else "unknown"
            error = err or cov.get("error") or ("response" if not cov else None)
            old = prior_coverage.get((course, kind), {})
            coverage.append({"course_code": course, "kind": kind, "status": status,
                "scope": cov.get('scope', 'visible_own_receipts'),
                "checked_at": at, "last_success_at": at if status == "ok" else old.get("last_success_at"),
                "error": error if error in ERRORS else None,
                "receipts": len([r for r in observations if r["course_code"] == course and r["kind"] == kind])})
    result = {"schema_version": 1, "provider": "elc", "term_id": cfg["term_id"],
              "attempted_at": at, "last_attempt_epoch": datetime.fromisoformat(at).timestamp(),
              "coverage": coverage, "observations": observations}
    retained = {r.get("provider_item_id"): r for r in previous.get("last_receipts", []) if isinstance(r, dict)}
    retained.update({r["provider_item_id"]: r for r in observations})
    result["last_receipts"] = sorted(retained.values(), key=lambda r: r.get("observed_at", ""), reverse=True)[:720]
    if not dry:
        # Receipt observations remain local; the shared reconciler owns exact
        # occurrence matching, revisions, uncertain retries and bridge readback.
        news.save_json(state_path, result)
        if observations:
            try:
                from submission_reconcile import reconcile
                reconcile(observations, log=log, dry=False)
            except Exception:
                log("submissions: bridge reconciliation unavailable; source receipts retained")
    complete = sum(r["status"] == "ok" for r in coverage)
    log(f"submissions: eLC {complete}/12 checks complete, {len(observations)} explicit receipt(s)" + (" (dry run)" if dry else ""))
    return result


def collect(win, tab, discovered, *, term_code=None, dry=False, force=False, cfg=None, state_path=STATE, log=None):
    if not (force or dry or due(state_path=state_path)):
        return None
    return record(read_courses(win, tab, discovered, cfg=cfg, term_code=term_code),
                  cfg=cfg, dry=dry, state_path=state_path, log=log)


def blocked(reason, *, dry=False, force=False, cfg=None, state_path=STATE, log=None):
    if not (force or dry or due(state_path=state_path)):
        return None
    cfg = cfg or news.source_config()
    return record({c: {"error": reason} for c in cfg["courses"]},
                  cfg=cfg, dry=dry, state_path=state_path, log=log)
