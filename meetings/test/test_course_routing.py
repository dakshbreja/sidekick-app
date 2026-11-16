import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
from urllib.parse import quote

BIN = Path(__file__).resolve().parents[1] / 'bin'
sys.path.insert(0, str(BIN))
from course_routing import route_transcript, title_course
from club_registry import classify as classify_club
sys.modules.setdefault('cdp', types.SimpleNamespace(find_page=None, evaluate=None))
spec = importlib.util.spec_from_file_location('routing_export', BIN/'cluely_export.py')
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)

class CourseRouting(unittest.TestCase):
    def test_course_hint_anywhere_case_insensitive(self):
        self.assertEqual(title_course('Test review — busn 5000 recitation'), 'BUSN5000')

    def test_generic_title_resolved_from_spoken_course(self):
        r = route_transcript('Econometrics Exam Review Lecture', 'In business 5000, our recitation covers sample means.')
        self.assertEqual(r['course'], 'BUSN5000')
        self.assertEqual(r['method'], 'transcript_course_code')

    def test_overlap_terms_do_not_route_personal_meeting(self):
        r = route_transcript('Meeting', 'Our firm strategy uses regression on salary and inventory data.')
        self.assertEqual(r['status'], 'needs_review')
        self.assertFalse(r['course'])

    def test_wrong_course_title_requires_review(self):
        self.assertEqual(route_transcript('BUSN5000 class', 'This is MGMT 4280.')['status'], 'needs_review')

    def test_multiple_courses_do_not_guess(self):
        self.assertEqual(route_transcript('Review', 'BUSN 5000 and BUSN 3040') ['status'], 'needs_review')

    def test_review_survives_title_change_not_transcript_change(self):
        transcript = 'Statistical recitation content.'
        reviewed = {'course':'BUSN5000', 'evidence':'Reviewed transcript',
                    'transcript_sha256':hashlib.sha256(transcript.encode()).hexdigest()}
        self.assertEqual(route_transcript('Misleading name',transcript,reviewed)['course'],'BUSN5000')
        self.assertEqual(route_transcript('BUSN5000',transcript+' More.',reviewed)['status'],'needs_review')

    def test_reviewed_empty_clip_can_be_excluded(self):
        reviewed = {'exclude':True,'evidence':'UI says No transcript',
                    'transcript_sha256':hashlib.sha256(b'').hexdigest()}
        self.assertEqual(route_transcript('Untitled','',reviewed)['status'],'excluded')
        self.assertEqual(route_transcript('Untitled','New resumed lecture.',reviewed)['status'],'needs_review')

    def run_export(self, transcript, dry=False, ongoing=False, title='Misleading Title', prior_review=False, course=None, club_review=None, inventory_complete=True):
        sid='11111111-1111-1111-1111-111111111111'
        href=f'/dashboard/sessions/{sid}?title={quote(title)}&createdAt=2026-09-18T17%3A00%3A00Z'
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
        root=Path(tmp.name)
        if prior_review:
            (root/'.routing-review.json').write_text(json.dumps({'sessions':{sid:{'status':'needs_review'}}}))
        if club_review:
            (root/'routing.json').write_text(json.dumps({'sessions':{sid:club_review}}))
        def ev(ws, expr, timeout=120):
            if expr == export.LIST_JS:
                return json.dumps({'sessions':[{'href':href,'ongoing':ongoing}], 'coverage_complete':inventory_complete, 'coverage_reason':'fixture_end'})
            if 'want = "Summary"' in expr:
                return json.dumps({'text':'Copy summary\nDo not use this for routing.'})
            return json.dumps({'text':'Copy transcript\n'+transcript})
        with patch.object(export,'ROOT',str(root)), patch.object(export,'STATE',str(root/'.state.json')), \
             patch.object(export,'CLASSES',str(root/'Classes')), patch.object(export,'ev',ev), \
             patch.object(export,'find_page',lambda _: {'webSocketDebuggerUrl':'fake'}), \
             patch.object(sys,'argv',['export']+(['--dry-run'] if dry else [])+(['--course',course] if course else [])):
            rc=export.main()
        return root,rc,sid

    def test_unknown_content_saved_locally_and_run_is_not_success(self):
        root,rc,sid=self.run_export('Unrelated planning conversation. '*30)
        self.assertEqual(rc,3)
        self.assertTrue((root/'Review'/f'{sid}.json').exists())
        self.assertFalse(list((root/'Classes').glob('*.md')))
        inv=json.loads((root/'.raw-inventory.json').read_text())
        self.assertEqual(len(inv['sessions']),1)

    def test_transcript_route_creates_course_export_with_original_title(self):
        root,rc,sid=self.run_export('Business 5000 recitation. '+'Sample means and estimators. '*30)
        self.assertEqual(rc,0)
        rec=json.loads((root/'.state.json').read_text())['exported'][sid]
        self.assertEqual(rec['course'],'BUSN 5000')
        self.assertEqual(rec['title'],'Misleading Title')

    def test_dry_run_does_not_write(self):
        root,rc,sid=self.run_export('Not read',dry=True)
        self.assertEqual(rc,0)
        self.assertEqual(list(root.iterdir()),[])

    def test_ongoing_recording_not_opened(self):
        root,rc,sid=self.run_export('Do not read active recording',ongoing=True)
        self.assertEqual(rc,0)
        self.assertFalse((root/'.state.json').exists())
        self.assertTrue(json.loads((root/'.raw-inventory.json').read_text())['sessions'][0]['ongoing'])

    def test_recovered_club_clears_previous_read_failure(self):
        root,rc,sid=self.run_export('Club workshop transcript. '*30,title='AI Society Workshop',prior_review=True)
        self.assertEqual(rc,0)
        self.assertTrue((root/'Clubs'/f'{sid}.json').exists())
        self.assertNotIn(sid,json.loads((root/'.routing-review.json').read_text())['sessions'])

    def test_course_scope_does_not_export_club(self):
        root,rc,sid=self.run_export('Club workshop transcript. '*30,title='AI Society Workshop',course='BUSN5000')
        self.assertEqual(rc,0)
        self.assertFalse((root/'Clubs'/f'{sid}.json').exists())

    def test_hash_bound_club_route(self):
        text=('AI Society speaker transcript. '*40).strip()
        decision={'clubs':['ai-society'],'evidence':'Reviewed source transcript',
                  'transcript_sha256':hashlib.sha256(text.encode()).hexdigest()}
        self.assertEqual(classify_club('Generic title','id',text,decision),['ai-society'])
        self.assertEqual(classify_club('AI Society','id',text+' changed',decision),[])
        root,rc,sid=self.run_export(text,club_review=decision)
        self.assertEqual(rc,0)
        raw=json.loads((root/'Clubs'/f'{sid}.json').read_text())
        self.assertEqual(raw['clubs'],['ai-society'])
        self.assertEqual(raw['title'],'Misleading Title')
        inv=json.loads((root/'.club-inventory.json').read_text())
        self.assertEqual(inv['sessions'][0]['session_id'],sid)

    def test_club_review_requires_valid_club_and_evidence(self):
        text='Some transcript'
        base={'clubs':['unknown-club'],'evidence':'Reviewed',
              'transcript_sha256':hashlib.sha256(text.encode()).hexdigest()}
        self.assertEqual(classify_club('AI Society','id',text,base),[])
        base.update(clubs=['ai-society'],evidence='')
        self.assertEqual(classify_club('AI Society','id',text,base),[])

    def test_incomplete_inventory_preserves_exports_but_defers(self):
        root,rc,sid=self.run_export('Business 5000 lesson. '*40,inventory_complete=False)
        self.assertEqual(rc,3)
        self.assertTrue(list((root/'Classes').glob('*.md')))
        self.assertFalse(json.loads((root/'.raw-inventory.json').read_text())['coverage_complete'])
        self.assertFalse(json.loads((root/'.club-inventory.json').read_text())['coverage_complete'])

if __name__=='__main__': unittest.main()
