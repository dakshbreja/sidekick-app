"""Transcript-first fallback for recordings with unhelpful titles.

Titles are hints. Unknown current-term recordings must be inspected locally;
ambiguous content stays in a visible review queue and is never sent to a GPT.
Reviewed session IDs survive renames. Generated summaries are not evidence.
"""
import hashlib
import re

COURSES = ('BUSN5000', 'MGMT4280', 'MGMT5560', 'MGMT5850', 'LAND2510', 'BUSN3040')
CODE = re.compile(r'\b(BUSN|MGMT|LAND)\s*[- ]?\s*(\d{4})E?\b', re.I)
SPOKEN_CODE = re.compile(r'\b(business|management|landscape architecture)\s+(\d{4})\b', re.I)

def title_course(title):
    codes = {a.upper()+b for a,b in CODE.findall(title)} & set(COURSES)
    return next(iter(codes)) if len(codes) == 1 else ''

def route_transcript(title, transcript, reviewed=None):
    """Return an auditable route, or request review instead of guessing a course."""
    if reviewed:
        if reviewed.get('transcript_sha256') != hashlib.sha256(transcript.encode()).hexdigest():
            return {'course':'','status':'needs_review','method':'reviewed_content_changed',
                    'evidence':'Transcript changed since content review; recheck before routing.'}
        if reviewed.get('course') in COURSES and reviewed.get('evidence'):
            return {'course':reviewed['course'], 'method':'reviewed_session',
                    'evidence':reviewed['evidence'], 'status':'routed'}
        if reviewed.get('exclude') and reviewed.get('evidence'):
            return {'course':'', 'method':'reviewed_session',
                    'evidence':reviewed['evidence'], 'status':'excluded'}
    title_hint = title_course(title)
    codes = {a.upper()+b for a,b in CODE.findall(transcript)} & set(COURSES)
    spoken = {'business':'BUSN','management':'MGMT','landscape architecture':'LAND'}
    codes |= {spoken[a.lower()]+b for a,b in SPOKEN_CODE.findall(transcript)} & set(COURSES)
    if len(codes) > 1 or (codes and title_hint and title_hint not in codes):
        return {'course':'', 'status':'needs_review', 'method':'conflicting_content',
                'title_hint':title_hint, 'content_candidates':sorted(codes)}
    if len(codes) == 1:
        code = next(iter(codes))
        return {'course':code, 'status':'routed', 'method':'transcript_course_code',
                'evidence':'Explicit course code in transcript; downstream content gate still required.'}
    if title_hint:
        return {'course':title_hint, 'status':'routed', 'method':'title_hint_content_gate',
                'evidence':'Title hint only; downstream transcript verification required.'}
    # Broad topic words (regression, strategy, pay, etc.) overlap with other
    # classes and personal/work meetings. They cannot authorize publication.
    return {'course':'', 'status':'needs_review', 'method':'unclassified_content',
            'evidence':'Transcript inspected; no unambiguous course identity. Review local transcript.'}
