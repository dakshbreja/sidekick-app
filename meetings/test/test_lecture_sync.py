import ast
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

SOURCE=Path(__file__).resolve().parents[2]
TMP=tempfile.TemporaryDirectory(prefix='lecture-sync-test-')
ROOT=Path(TMP.name)
for part in ['meetings/bin','meetings/Classes','collect/bin']:
    (ROOT/part).mkdir(parents=True,exist_ok=True)
for name in ['verify.py','push_notes.py','lecture_sync.py']:
    shutil.copy2(SOURCE/'meetings/bin'/name,ROOT/'meetings/bin'/name)
shutil.copy2(SOURCE/'collect/bin/bundle.py',ROOT/'collect/bin/bundle.py')
os.environ['SCHOOL_SUITE_ROOT']=str(ROOT)
sys.path.insert(0,str(ROOT/'meetings/bin'))
import lecture_sync as ls
import bundle

SID='94668f7a-aa5e-4fe3-8155-2cfedafbc89f'
REC={'course':'MGMT 5560','title':'MGMT 5560 — International Strategic Management (Hill)','date':'2026-09-09','path':'Classes/test.md'}
def raw(sid=SID,extra=''):
    return f'---\nsession_id: {sid}\ndate: 2026-09-09T18:53:38Z\n---\n## Summary\nMade-up administration.\n## Transcript\nDaksh [0:01]: Strategy industry rivalry and competitive advantage in the craft beer market. {extra}\n'

class RepairTests(unittest.TestCase):
    def setUp(self):
        for p in [ROOT/'collect/MGMT5560',ROOT/'meetings/.lecture-sync.json',ROOT/'collect/.pending-upload.json',ROOT/'collect/.bundle-publication.json']:
            if p.is_dir(): shutil.rmtree(p)
            elif p.exists(): p.unlink()
        ls.atomic(ROOT/'meetings/Classes/test.md',raw())
        ls.atomic(ROOT/'meetings/.state.json',json.dumps({'exported':{SID:REC}}))
        ls.atomic(ROOT/'meetings/.raw-inventory.json',json.dumps({'observed_at':ls.now(),'sessions':[
            {'sid':SID,'created':'2026-09-09T18:53:38Z','course':'MGMT5560','ongoing':False},
            {'sid':'active','created':'2026-09-16T18:53:38Z','course':'MGMT5560','ongoing':True}]}))

    def test_native_transcript_supported_by_existing_verifier(self):
        self.assertEqual(len(ls.verify.parse_turns(raw().split("## Transcript")[1])),1)

    def test_transient_file_provider_reads_retry_exact_bytes(self):
        import errno
        with patch.object(Path,'read_text',side_effect=[OSError(errno.EDEADLK,'hydrating'),
                OSError(errno.EAGAIN,'busy'),'exact transcript']) as read, patch.object(ls.time,'sleep') as sleep:
            self.assertEqual(ls.read_text(Path('test.txt')),'exact transcript')
            self.assertEqual(read.call_count,3)
            self.assertEqual([c.args[0] for c in sleep.call_args_list],[1,2])

    def test_persistent_or_nontransient_file_errors_remain_failures(self):
        import errno
        for code,count in [(errno.EDEADLK,4),(errno.EACCES,1)]:
            with patch.object(Path,'read_text',side_effect=OSError(code,'unreadable')) as read, \
                    patch.object(ls.time,'sleep'), self.assertRaises(OSError):
                ls.read_text(Path('test.txt'))
            self.assertEqual(read.call_count,count)

    def test_provider_circuit_bounds_many_failed_reads(self):
        import errno
        budget=ls.ReadBudget()
        with patch.object(Path,'read_text',side_effect=OSError(errno.EDEADLK,'hydrating')) as read, patch.object(ls.time,'sleep'):
            for _ in range(64):
                with self.assertRaises(OSError):ls.read_text(Path('provider/file'),budget)
        self.assertEqual(read.call_count,4)
        self.assertTrue(budget.open)

    def test_short_budget_and_recovered_probe_are_visible(self):
        import errno
        budget=ls.ReadBudget(seconds=1)
        with patch.object(Path,'read_text',side_effect=[OSError(errno.EAGAIN,'busy'),'bytes']), patch.object(ls.time,'sleep'):
            self.assertEqual(ls.read_text(Path('provider/file'),budget),'bytes')
        self.assertEqual(budget.recovered,1)
        self.assertLess(budget.remaining,0.01)

    def test_unreadable_drive_preserved_and_independent_readback_runs(self):
        import errno
        drive=ROOT/'fake-drive';drive.mkdir(exist_ok=True)
        name=f'MGMT5560_Cluely_{REC["date"]}_{SID}_transcript.txt'
        target=drive/'MGMT 5560/07 - Dailies & Class Notes'/name
        ls.atomic(target,'existing bytes')
        original=ls.read_text
        def read(path,budget=None):
            if path==target:raise OSError(errno.EDEADLK,'provider unavailable')
            return original(path,budget)
        with patch.object(ls,'DRIVE',drive), patch.object(ls,'read_text',side_effect=read), patch.object(ls,'load_env',return_value={}), patch.object(ls,'verify_library',return_value={'status':'verified','sha256':'fixture'}) as verify:
            self.assertEqual(ls.sync(['MGMT5560'],publish=True,check_library=True),1)
        verify.assert_called_once()
        self.assertEqual(target.read_text(),'existing bytes')
        record=ls.read(ls.MANIFEST,{})['sessions'][SID]
        self.assertEqual(record['stages']['drive_copy']['status'],'failed')
        self.assertEqual(record['stages']['remote_readback']['status'],'verified')
        self.assertTrue(record['imported_at'])

    def test_remote_budget_is_shared_and_later_sessions_deferred(self):
        sid2='655aa3d5-44f7-422b-8da7-dea364295a52'
        second={**REC,'date':'2026-09-10','path':'Classes/test2.md'}
        ls.atomic(ROOT/'meetings/Classes/test2.md',raw(sid2))
        ls.atomic(ROOT/'meetings/.state.json',json.dumps({'exported':{SID:REC,sid2:second}}))
        clock=[0]
        def verify(*args,**kwargs):
            self.assertEqual(kwargs['deadline'],60)
            clock[0]=61
            raise TimeoutError('fixture deadline')
        with patch.object(ls,'load_env',return_value={}), patch.object(ls.time,'monotonic',side_effect=lambda:clock[0]), patch.object(ls,'verify_library',side_effect=verify) as get:
            self.assertEqual(ls.sync(['MGMT5560'],check_library=True),1)
        self.assertEqual(get.call_count,1)
        manifest=ls.read(ls.MANIFEST,{})
        self.assertEqual(manifest['sessions'][sid2]['stages']['remote_readback']['status'],'deferred')
        self.assertTrue(manifest['read_probes']['remote_budget_exhausted'])

    def test_repeated_exhausted_runs_eventually_attempt_every_session(self):
        ids=[SID,'655aa3d5-44f7-422b-8da7-dea364295a52','855aa3d5-44f7-422b-8da7-dea364295a53']
        records={}
        for i,sid in enumerate(ids):
            records[sid]={**REC,'date':f'2026-09-{9+i:02d}','path':f'Classes/rotation{i}.md'}
            ls.atomic(ROOT/'meetings'/records[sid]['path'],raw(sid))
        ls.atomic(ROOT/'meetings/.state.json',json.dumps({'exported':records}))
        clock=[0];attempts=[]
        def verify(cfg,code,name,text,**kwargs):
            attempts.append(name)
            clock[0]+=61
            raise TimeoutError('fixture exhausts shared budget')
        with patch.object(ls,'load_env',return_value={}), patch.object(ls.time,'monotonic',side_effect=lambda:clock[0]), patch.object(ls,'verify_library',side_effect=verify):
            for _ in range(3):self.assertEqual(ls.sync(['MGMT5560'],check_library=True),1)
        self.assertEqual(len(attempts),3)
        self.assertEqual(len(set(attempts)),3)
        self.assertTrue(all(any(sid in name for name in attempts) for sid in ids))

    def test_pending_precedes_verified_then_oldest_verification(self):
        ids=[SID,'655aa3d5-44f7-422b-8da7-dea364295a52','855aa3d5-44f7-422b-8da7-dea364295a53']
        records={};sessions={}
        for i,sid in enumerate(ids):
            records[sid]={**REC,'date':f'2026-09-{9+i:02d}','path':f'Classes/priority{i}.md'}
            ls.atomic(ROOT/'meetings'/records[sid]['path'],raw(sid))
            sessions[sid]={'publication':{'status':'verified','verified_at':f'2026-10-{20-i:02d}T00:00:00Z'}}
        sessions[ids[0]]['publication']={'status':'pending'}
        ls.atomic(ROOT/'meetings/.state.json',json.dumps({'exported':records}))
        ls.atomic(ls.MANIFEST,json.dumps({'sessions':sessions,'courses':{}}))
        attempts=[]
        def verify(cfg,code,name,text,**kwargs):
            attempts.append(next(sid for sid in ids if sid in name))
            return {'status':'verified','verified_at':ls.now()}
        with patch.object(ls,'load_env',return_value={}), patch.object(ls,'verify_library',side_effect=verify):
            self.assertEqual(ls.sync(['MGMT5560'],check_library=True),0)
        self.assertEqual(attempts,[ids[0],ids[2],ids[1]])

    def test_expired_supplied_deadline_never_fetches(self):
        with patch.object(ls.time,'monotonic',return_value=10), patch.object(ls,'bridge_get') as get, self.assertRaises(TimeoutError):
            ls.verify_library({},'MGMT5560','lecture.txt','right',deadline=9)
        get.assert_not_called()

    def test_old_verified_receipt_is_historical_without_new_readback(self):
        ls.sync(['MGMT5560'])
        manifest=ls.read(ls.MANIFEST,{})
        receipt={'status':'verified','verified_at':'old','doc_id':'old-id'}
        manifest['sessions'][SID]['publication']=receipt
        ls.atomic(ls.MANIFEST,json.dumps(manifest))
        ls.sync(['MGMT5560'])
        record=ls.read(ls.MANIFEST,{})['sessions'][SID]
        self.assertEqual(record['previous_verified_publication'],receipt)
        self.assertEqual(record['publication']['status'],'pending')

    def test_cli_defers_without_running_when_collector_owns_lock(self):
        import fcntl
        with (ROOT/'collect/.material-run.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(sys,'argv',['lecture_sync.py','--publish']), patch.object(ls,'sync') as sync:
                self.assertEqual(ls.main(),2)
                sync.assert_not_called()

    def test_cli_dry_run_does_not_open_lock(self):
        with patch.object(sys,'argv',['lecture_sync.py','--dry-run']), \
                patch.object(Path,'open',side_effect=AssertionError('dry run opened lock')), \
                patch.object(ls,'sync',return_value=0) as sync:
            self.assertEqual(ls.main(),0)
            self.assertTrue(sync.call_args.args[1])

    def test_copy_format_and_no_generated_summary(self):
        text,report=ls.render(REC,SID,raw())
        self.assertIn('[0:01] Strategy',text)
        self.assertNotIn('Made-up administration',text)
        self.assertEqual(report['turns'],1)

    def test_identity_and_course_gate(self):
        with self.assertRaises(ValueError):ls.render(REC,SID,raw('wrong'))
        with self.assertRaises(ValueError):ls.render(REC,SID,raw().replace('Strategy industry rivalry and competitive advantage in the craft beer market.','Hello there.'))

    def test_idempotence_and_changed_session(self):
        self.assertEqual(ls.sync(['MGMT5560']),0)
        p=next((ROOT/'collect/MGMT5560/text').glob('*.txt')); old=p.stat().st_mtime_ns
        self.assertEqual(ls.sync(['MGMT5560']),0)
        self.assertEqual(old,p.stat().st_mtime_ns)
        self.assertEqual(len(ls.read(ROOT/'collect/.pending-upload.json',{})['files']),1)
        self.assertEqual(len(list(p.parent.glob('*.txt'))),1)
        ls.atomic(ROOT/'meetings/Classes/test.md',raw(extra='A corrected resource capability discussion.'))
        ls.sync(['MGMT5560'])
        self.assertIn('corrected resource',p.read_text())
        self.assertEqual(len(list(p.parent.glob('*.txt'))),1)
        m=ls.read(ls.MANIFEST,{})
        self.assertEqual(len(m['courses']),6)
        self.assertIn('newest recording in progress',m['courses']['MGMT5560']['errors'])
        self.assertEqual(m['courses']['MGMT5560']['publication']['file_library'],'pending')

    def test_dry_run_no_writes(self):
        ls.sync(['MGMT5560'],dry=True)
        self.assertFalse(ls.MANIFEST.exists())
        self.assertFalse((ROOT/'collect/.pending-upload.json').exists())

    def test_partial_knowledge_retrieval_remains_visible_after_publication(self):
        ls.sync(['MGMT5560'])
        p=ROOT/'collect/MGMT5560/bundles/MGMT5560_Transcripts.txt'
        ls.atomic(ROOT/'collect/.bundle-publication.json',json.dumps({'MGMT5560':{
            'status':'publication_confirmed','retrieval':'partial','digests':{p.name:bundle.digest(str(p))}}}))
        ls.sync(['MGMT5560'])
        course=ls.read(ls.MANIFEST,{})['courses']['MGMT5560']
        self.assertTrue(any('partially verified' in e for e in course['errors']))

    def test_old_publication_receipt_does_not_confirm_changed_bundle(self):
        ls.sync(['MGMT5560'])
        p=ROOT/'collect/MGMT5560/bundles/MGMT5560_Transcripts.txt'
        receipt={'status':'publication_confirmed','published_at':'2026-09-01T00:00:00Z',
                 'digests':{p.name:'old-digest'}}
        publication=ROOT/'collect/.bundle-publication.json'
        ls.atomic(publication,json.dumps({'MGMT5560':receipt}))
        before=publication.read_bytes()
        ls.sync(['MGMT5560'])
        course=ls.read(ls.MANIFEST,{})['courses']['MGMT5560']
        self.assertEqual(course['publication']['gpt_knowledge'],'pending')
        self.assertEqual(course['gpt_knowledge'],receipt)
        self.assertEqual(publication.read_bytes(),before)
        self.assertIn('GPT Knowledge transcript bundle publication unconfirmed',course['errors'])

    def test_matching_bundle_digest_confirms_publication(self):
        ls.sync(['MGMT5560'])
        p=ROOT/'collect/MGMT5560/bundles/MGMT5560_Transcripts.txt'
        receipt={'status':'publication_confirmed','digests':{p.name:bundle.digest(str(p))}}
        ls.atomic(ROOT/'collect/.bundle-publication.json',json.dumps({'MGMT5560':receipt}))
        ls.sync(['MGMT5560'])
        course=ls.read(ls.MANIFEST,{})['courses']['MGMT5560']
        self.assertEqual(course['publication']['gpt_knowledge'],'publication_confirmed')
        self.assertEqual(course['gpt_knowledge'],receipt)

    def test_absent_bundle_does_not_inherit_old_confirmation(self):
        receipt={'status':'publication_confirmed','digests':{'BUSN5000_Transcripts.txt':'old-digest'}}
        ls.atomic(ROOT/'collect/.bundle-publication.json',json.dumps({'BUSN5000':receipt}))
        ls.sync(['MGMT5560'])
        course=ls.read(ls.MANIFEST,{})['courses']['BUSN5000']
        self.assertEqual(course['publication']['gpt_knowledge'],'unknown')
        self.assertEqual(course['gpt_knowledge'],receipt)

    def test_similar_distinct_lectures_preserved(self):
        d=ROOT/'collect/MGMT5560/text'; d.mkdir(parents=True)
        for sid in [SID,'655aa3d5-44f7-422b-8da7-dea364295a52']:
            text,_=ls.render(REC,sid,raw(sid))
            (d/(sid+'_transcript.txt')).write_text(text)
        groups,dropped=bundle.collect('MGMT5560')
        self.assertEqual(len(groups['Transcripts']),2)
        self.assertFalse(dropped)

    def test_remote_readback_required(self):
        original=ls.bridge_get
        ls.bridge_get=lambda cfg,path,params,**kw: {'documents':[{'doc_id':'d','title':'lecture.txt'}]} if path=='/library' else {'text':'wrong','truncated':False}
        try:
            with patch.object(ls.time,'sleep'), self.assertRaises(ValueError):ls.verify_library({},'MGMT5560','lecture.txt','right')
            ls.bridge_get=lambda cfg,path,params,**kw: {'documents':[{'doc_id':'d','title':'lecture.txt'}]} if path=='/library' else {'text':'right','truncated':False}
            self.assertEqual(ls.verify_library({},'MGMT5560','lecture.txt','right')['status'],'verified')
        finally:ls.bridge_get=original

    def test_known_id_still_requires_current_title_and_exact_bytes(self):
        with patch.object(ls,'bridge_get',return_value={'document':{'title':'lecture.txt'},'text':'right','truncated':False}) as get:
            self.assertEqual(ls.verify_library({},'MGMT5560','lecture.txt','right',doc_id='known')['status'],'verified')
        self.assertEqual(get.call_count,1)
        self.assertEqual(get.call_args.args[1],'/library/doc')
        responses=[{'document':{'title':'other.txt'},'text':'right'},
            {'documents':[{'doc_id':'new','title':'lecture.txt'}]}, {'text':'right','truncated':False}]
        with patch.object(ls,'bridge_get',side_effect=responses):
            self.assertEqual(ls.verify_library({},'MGMT5560','lecture.txt','right',doc_id='known')['doc_id'],'new')

    def test_deleted_id_falls_back_to_discovery(self):
        responses=[HTTPError('url',404,'missing',{},None),
            {'documents':[{'doc_id':'new','title':'lecture.txt'}]}, {'text':'right','truncated':False}]
        with patch.object(ls,'bridge_get',side_effect=responses), patch.object(ls.time,'sleep'):
            self.assertEqual(ls.verify_library({},'MGMT5560','lecture.txt','right',doc_id='deleted')['doc_id'],'new')

    def test_eventual_exact_readback_after_missing_stale_and_timeout(self):
        listing={'documents':[{'doc_id':'d','title':'lecture.txt'}]}
        responses=[{'documents':[]}, listing, {'text':'old'}, TimeoutError(), listing, {'text':'right','truncated':False}]
        with patch.object(ls,'bridge_get',side_effect=responses) as get, patch.object(ls.time,'sleep') as sleep:
            self.assertEqual(ls.verify_library({},'MGMT5560','lecture.txt','right')['sha256'],ls.digest('right'))
            self.assertEqual(sleep.call_count,3)
            self.assertTrue(all(0<c.kwargs['timeout']<=20 for c in get.call_args_list))

    def test_truncated_exact_text_never_verifies(self):
        def get(cfg,path,params,**kw):
            return {'documents':[{'doc_id':'d','title':'lecture.txt'}]} if path=='/library' else {'text':'right','truncated':True}
        with patch.object(ls,'bridge_get',side_effect=get) as fetch, patch.object(ls.time,'sleep'), self.assertRaises(ValueError):
            ls.verify_library({},'MGMT5560','lecture.txt','right')
        self.assertEqual(fetch.call_count,12)

    def test_auth_failure_not_retried(self):
        with patch.object(ls,'bridge_get',side_effect=HTTPError('url',401,'unauthorized',{},None)), patch.object(ls.time,'sleep') as sleep, self.assertRaises(HTTPError):
            ls.verify_library({},'MGMT5560','lecture.txt','right')
        sleep.assert_not_called()

    def test_verification_deadline_limits_network_attempts(self):
        with patch.object(ls.time,'monotonic',side_effect=[0,0,61]), patch.object(ls,'bridge_get',return_value={'documents':[]}) as get, patch.object(ls.time,'sleep') as sleep, self.assertRaises(ValueError):
            ls.verify_library({},'MGMT5560','lecture.txt','right')
        self.assertEqual(get.call_count,1)
        sleep.assert_not_called()

    def test_failed_upload_retry_still_replaces(self):
        ls.sync(['MGMT5560'])
        tree=ast.parse((SOURCE/'collect/bin/elc_daily.py').read_text())
        keep={'load_json','save_json','load_pending','flush_upload_queue'}
        selected=ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in keep],type_ignores=[])
        from datetime import datetime,timezone
        calls=[]
        class Uploader:
            @staticmethod
            def upload_many(by_course,log,replace):
                calls.append(replace)
                return [{'course':'MGMT5560','ok':len(calls)>1,'error':'simulated failure','uploaded':['MGMT5560_Transcripts.txt']}]
        from types import SimpleNamespace
        spec=importlib.util.spec_from_file_location('lecture_test_delivery',SOURCE/'collect/bin/material_delivery.py')
        delivery=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(delivery)
        clock=SimpleNamespace(now=1000)
        clock.time=lambda:clock.now
        ns=dict(os=os,json=json,Path=Path,tempfile=tempfile,time=clock,material_delivery=delivery,
            ROOT=str(ROOT/'collect'),PENDING=str(ROOT/'collect/.pending-upload.json'),
            MAX_UPLOAD_ATTEMPTS=5,bundle=bundle,gpt_upload=Uploader,log=lambda s:None,
            datetime=datetime,timezone=timezone)
        exec(compile(selected,'elc_daily.py','exec'),ns)
        ns['flush_upload_queue'](only_courses=['MGMT5560'])
        self.assertFalse((ROOT/'collect/.bundle-publication.json').exists())
        ns['flush_upload_queue'](only_courses=['MGMT5560'])
        self.assertEqual(len(calls),1)  # Backoff retains work without another UI attempt.
        self.assertTrue(ls.read(ROOT/'collect/.pending-upload.json',{})['files'])
        clock.now+=301
        ns['flush_upload_queue'](only_courses=['MGMT5560'])
        self.assertIn('MGMT5560_Transcripts.txt',calls[0])
        self.assertIn('MGMT5560_Transcripts.txt',calls[1])
        self.assertEqual(ls.read(ROOT/'collect/.pending-upload.json',{})['files'],[])

if __name__=='__main__': unittest.main()
