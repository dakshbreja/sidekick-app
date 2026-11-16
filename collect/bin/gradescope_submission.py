#!/usr/bin/env python3
"""Reconcile explicit Gradescope receipt links separately from private scores.

Only the pinned current-term student course can authorize completion. A grade
number alone never does. The existing student assignment list exposes a stable
own-submission link only once work has been submitted; use that receipt identity
without copying scores or feedback. The dashboard does not expose submission
time, so it remains unknown rather than borrowed from a release/due timestamp.

Provider contract:
https://guides.gradescope.com/hc/en-us/articles/21856421392525-Understand-Your-Submission-Feedback-and-Grades
"""
from datetime import datetime, timezone
import re

import elc_announcements as news

SOURCES = news.ROOT / 'submission-sources.json'
STATE = news.ROOT / '.gradescope-submission-state.json'
ID = re.compile(r'[1-9]\d{0,11}\Z')
RECEIPT = re.compile(r'https://www\.gradescope\.com/courses/([1-9]\d{0,11})/assignments/([1-9]\d{0,11})/submissions/([1-9]\d{0,11})/?\Z')


def due_time(value):
    """Read the due element's explicit year/time/offset; never infer a year."""
    if not isinstance(value, str) or not value:
        return None
    parsed = news.stamp(value)
    if not parsed and re.fullmatch(r'2026-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4}', value):
        try:
            parsed = news.stamp(datetime.strptime(value, '%Y-%m-%d %H:%M:%S %z').isoformat())
        except ValueError:
            return None
    if not parsed:
        return None
    date = datetime.fromisoformat(parsed)
    return parsed if datetime(2026, 8, 1, tzinfo=timezone.utc) <= date < datetime(2027, 1, 1, tzinfo=timezone.utc) else None


def source_config(path=SOURCES):
    cfg = news.load_json(path, {})
    courses = cfg.get('gradescope_courses')
    if (cfg.get('schema_version') != 1 or cfg.get('term_id') != 'fall-2026'
            or not isinstance(courses, dict) or set(courses) != {'BUSN5000'}
            or not all(ID.fullmatch(str(value)) for value in courses.values())):
        return None
    return cfg


def normalized_observations(course, course_id, rows, *, cfg=None, observed_at=None):
    cfg = cfg or source_config()
    if (not cfg or cfg.get('schema_version') != 1 or cfg.get('term_id') != 'fall-2026'
            or not isinstance(cfg.get('gradescope_courses'), dict)
            or set(cfg['gradescope_courses']) != {'BUSN5000'}
            or str(cfg['gradescope_courses'].get(course)) != str(course_id)):
        raise ValueError('course_identity')
    if not isinstance(rows, list) or len(rows) > 120:
        raise ValueError('response')
    at = news.stamp(observed_at) or news.stamp()
    out, seen, unresolved = [], set(), 0
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('response')
        title = row.get('name')
        if not isinstance(title, str) or not title.strip() or len(title) > 240:
            raise ValueError('response')
        title = re.sub(r'\s+', ' ', title).strip()
        if news.SECRET.search(title) or news.SCORES.search(title):
            raise ValueError('privacy')
        href = row.get('submission_href') or row.get('href')
        match = RECEIPT.fullmatch(href) if isinstance(href, str) else None
        status = str(row.get('status') or '').strip().lower()
        # A submitted word without a stable receipt can be reviewed later; a
        # clickable assignment URL is also used to START work, so it is no proof.
        if not match:
            if status == 'submitted':
                unresolved += 1
            continue
        if match.group(1) != str(course_id):
            raise ValueError('course_identity')
        if status in ('no submission', 'not submitted', 'unsubmitted', 'in progress'):
            unresolved += 1
            continue
        identity = 'assignment:' + match.group(2) + ':submission:' + match.group(3)
        if identity in seen:
            raise ValueError('identity')
        seen.add(identity)
        observation = {'provider': 'gradescope', 'course_code': course,
                    'term_id': cfg['term_id'], 'source_url': href,
                    'provider_item_id': identity, 'kind': 'assignment',
                    'title': title, 'observed_at': at, 'status': 'submitted',
                    'source_evidence': 'Gradescope current student assignment list exposes own submission receipt ' + match.group(3) + '.'}
        due = due_time(row.get('due_at'))
        if due:
            observation['due_at'] = due
        out.append(observation)
    return out, unresolved


def record(course, course_id, rows, *, cfg=None, observed_at=None, dry=False, state_path=STATE, log=None):
    log = log or (lambda message: None)
    at = news.stamp(observed_at) or news.stamp()
    previous = news.load_json(state_path, {})
    error, observations, unresolved = None, [], 0
    try:
        observations, unresolved = normalized_observations(course, course_id, rows, cfg=cfg, observed_at=at)
    except ValueError as exc:
        error = str(exc)
    result = {'schema_version': 1, 'provider': 'gradescope', 'course_code': course,
              'term_id': 'fall-2026', 'scope': 'visible_own_receipts', 'attempted_at': at,
              'status': 'unknown' if error else 'partial' if unresolved else 'ok',
              'error': error, 'unresolved': unresolved, 'observations': observations,
              'last_success_at': at if not error and not unresolved else previous.get('last_success_at')}
    retained = {r.get('provider_item_id'): r for r in previous.get('last_receipts', []) if isinstance(r, dict)}
    retained.update({r['provider_item_id']: r for r in observations})
    result['last_receipts'] = sorted(retained.values(), key=lambda r: r.get('observed_at', ''), reverse=True)[:120]
    if not dry:
        news.save_json(state_path, result)
        if observations:
            try:
                from submission_reconcile import reconcile
                reconcile(observations, log=log, dry=False)
            except Exception:
                log('submissions: Gradescope bridge reconciliation unavailable; source receipts retained')
    log(f"submissions: Gradescope {result['status']}, {len(observations)} explicit receipt(s)" + (' (dry run)' if dry else ''))
    return result


def blocked(reason='session', *, state_path=STATE, log=None):
    at = news.stamp()
    previous = news.load_json(state_path, {})
    result = {'schema_version': 1, 'provider': 'gradescope', 'course_code': 'BUSN5000',
              'term_id': 'fall-2026', 'scope': 'visible_own_receipts', 'attempted_at': at,
              'status': 'unknown', 'error': reason if reason in ('session', 'browser', 'course_identity') else 'response',
              'observations': [], 'last_success_at': previous.get('last_success_at'),
              'last_receipts': previous.get('last_receipts', [])}
    news.save_json(state_path, result)
    if log:
        log('submissions: Gradescope source check unknown')
    return result
