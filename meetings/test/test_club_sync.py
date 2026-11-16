import sys
from pathlib import Path
import unittest
import errno
from unittest.mock import Mock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'bin'))
import club_sync

class ClubTranscriptTests(unittest.TestCase):
    def record(self, text):
        return dict(session_id='38baf3a3-097e-420e-b28f-b422e9709a73',title='AI Society meeting',
                    clubs=['ai-society'],completed=True,created_at='2026-09-09T16:00:00Z',transcript=text)

    def test_both_formats_preserve_words_and_raw_input(self):
        words='This is recorded meeting evidence, with punctuation and line breaks.\nMore recorded words. '*3
        dom='\n'.join(f'Them\n0:0{i}\n{words}' for i in range(3))
        canonical='\n'.join(f'Them [0:0{i}]: {words}' for i in range(3))
        raw=self.record(dom)
        self.assertEqual(club_sync.validate(raw)['transcript'],canonical)
        self.assertEqual(raw['transcript'],dom)
        self.assertEqual(club_sync.validate(self.record(canonical))['transcript'],canonical)

    def test_active_or_incomplete_recording_rejected(self):
        text='\n'.join(f'Them [0:0{i}]: '+('recorded words '*20) for i in range(3))
        active=self.record(text);active['completed']=False
        with self.assertRaisesRegex(ValueError,'active'):club_sync.validate(active)
        with self.assertRaisesRegex(ValueError,'incomplete'):club_sync.validate(self.record('recorded words '*50))
        with self.assertRaisesRegex(ValueError,'incomplete'):club_sync.validate(self.record('Them [0:01]: '+('words '*120)))

class ClubReadRetryTests(unittest.TestCase):
    def test_transient_hydration_retries_then_reads(self):
        p=Mock();p.read_text.side_effect=[OSError(errno.EDEADLK,'hydrating'), OSError(errno.EAGAIN,'hydrating'), '{"ok":true}']
        with patch.object(club_sync.time,'sleep') as sleep:
            self.assertEqual(club_sync.read(p,{}),{'ok':True})
        self.assertEqual(p.read_text.call_count,3)
        self.assertEqual([x.args[0] for x in sleep.call_args_list],[1,2])

    def test_persistent_hydration_error_remains_visible(self):
        p=Mock();p.read_text.side_effect=OSError(errno.EDEADLK,'hydrating')
        with patch.object(club_sync.time,'sleep') as sleep:
            with self.assertRaises(OSError):club_sync.read(p,{})
        self.assertEqual(p.read_text.call_count,4)
        self.assertEqual(sleep.call_count,3)

    def test_permission_error_is_not_retried(self):
        p=Mock();p.read_text.side_effect=PermissionError(errno.EACCES,'denied')
        with patch.object(club_sync.time,'sleep') as sleep:
            with self.assertRaises(PermissionError):club_sync.read(p,{})
        self.assertEqual(p.read_text.call_count,1)
        sleep.assert_not_called()

    def test_failed_provider_circuit_avoids_repeated_reads(self):
        p=Mock();p.read_text.side_effect=OSError(errno.EAGAIN,'unavailable')
        budget=club_sync.ReadBudget()
        with patch.object(club_sync.time,'sleep'):
            for _ in range(20):
                with self.assertRaises(OSError):club_sync.read_text(p,budget)
        self.assertEqual(p.read_text.call_count,4)
        self.assertTrue(budget.open)

    def test_unreadable_existing_output_retains_bytes_and_writes_local_manifest(self):
        import tempfile,json
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);home=root/'home';cal=root/'cal'
            (root/'Clubs').mkdir();cal.mkdir()
            text='\n'.join(f'Them [0:0{i}]: '+('recorded words '*20) for i in range(3))
            raw=ClubTranscriptTests().record(text)
            (root/'Clubs'/f'{raw["session_id"]}.json').write_text(json.dumps(raw))
            target=home/'Meetings'/f'2026-09-09_{raw["session_id"]}.txt'
            target.parent.mkdir(parents=True);target.write_text('retained')
            original=club_sync.read_text
            def read(p,budget=None):
                if p==target:raise OSError(errno.EDEADLK,'unavailable')
                return original(p,budget)
            with patch.multiple(club_sync,ROOT=root,HOME=home,CAL=cal,MANIFEST=root/'manifest.json'), patch.object(club_sync,'read_text',side_effect=read):
                self.assertEqual(club_sync.sync(),1)
            manifest=json.loads((root/'manifest.json').read_text())
            self.assertEqual(target.read_text(),'retained')
            self.assertEqual(manifest['sessions'][raw['session_id']]['local_copy']['status'],'failed')
            self.assertEqual(manifest['sessions'][raw['session_id']]['publication'],'pending')

    def test_initial_remote_outage_saves_manifest_without_writes(self):
        import tempfile,json
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);home=root/'home';cal=root/'cal'
            (root/'Clubs').mkdir();cal.mkdir()
            text='\n'.join(f'Them [0:0{i}]: '+('recorded words '*20) for i in range(3))
            raw=ClubTranscriptTests().record(text)
            (root/'Clubs'/f'{raw["session_id"]}.json').write_text(json.dumps(raw))
            with patch.multiple(club_sync,ROOT=root,HOME=home,CAL=cal,MANIFEST=root/'manifest.json'), patch.object(club_sync,'load_env',return_value={}), patch.object(club_sync,'request',side_effect=TimeoutError('offline')) as request:
                self.assertEqual(club_sync.sync(publish=True),1)
            request.assert_called_once_with({},'/clubs')
            manifest=json.loads((root/'manifest.json').read_text())
            self.assertEqual(manifest['sessions'][raw['session_id']]['publication'],'pending')
            self.assertEqual(manifest['errors'][0]['stage'],'remote_discovery')
            self.assertIsNone(manifest['bridge_verified_at'])

    def test_final_remote_failures_preserve_local_receipt(self):
        import tempfile,json
        for fail_on in ('sync','readback'):
            with self.subTest(fail_on=fail_on), tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);home=root/'home';cal=root/'cal'
                root.joinpath('Clubs').mkdir();cal.mkdir()
                calls=[]
                def request(cfg,path,data=None):
                    calls.append((path,data))
                    if path=='/clubs/sync' and fail_on=='sync':raise TimeoutError('sync failed')
                    if path=='/clubs' and len(calls)>1:raise TimeoutError('readback failed')
                    return {'project_current':True,'state':'current'}
                with patch.multiple(club_sync,ROOT=root,HOME=home,CAL=cal,MANIFEST=root/'manifest.json'), patch.object(club_sync,'load_env',return_value={}), patch.object(club_sync,'request',side_effect=request):
                    self.assertEqual(club_sync.sync(publish=True),1)
                manifest=json.loads((root/'manifest.json').read_text())
                self.assertEqual(manifest['errors'][0]['stage'],'remote_sync_readback')
                self.assertEqual(manifest['project_publication'],'pending')
                self.assertIsNone(manifest['bridge_verified_at'])
                self.assertEqual(len(calls),2 if fail_on=='sync' else 3)

    def test_raw_transcript_is_passed_to_route_verification(self):
        text='\n'.join(f'Them [0:0{i}]: '+('recorded words '*20) for i in range(3))
        raw=ClubTranscriptTests().record(text)
        with patch.object(club_sync,'classify',return_value=['ai-society']) as classify:
            club_sync.validate(raw)
        classify.assert_called_once_with(raw['title'],raw['session_id'],transcript=text)

if __name__=='__main__':unittest.main()
