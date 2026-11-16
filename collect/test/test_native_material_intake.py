"""Native-download recovery uses fake local files; never a browser or network."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bin'))
import native_material_intake as intake
from material_delivery import DeliveryQueue

class NativeIntakeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.downloads = self.root / 'Downloads'; self.downloads.mkdir()
        self.partial = self.downloads / 'Unconfirmed1.crdownload'; self.partial.write_bytes(b'fake original bytes')
        stat = self.partial.stat()
        self.row = {'capture_id':'native-one','course':'LAND2510E','topic_id':'1','org_unit':'3962245','term':'20272',
            'partial_name':self.partial.name,'final_name':'lecture.mp4','device':stat.st_dev,'inode':stat.st_ino,
            'minimum_bytes':4,'source_path':'/content/enforced4/3962245-course.20272/lecture.mp4',
            'expected_duration_seconds':60,'registered_at':100,'status':'pending'}
        self.state = {'version':1,'captures':[self.row]}; intake.save_state(self.root,self.state)
        self.manifest = {'courses':{'LAND2510E':{'items':[{'id':1,'type':'File','title':'Lecture','unit':'Week1','ext':'mp4'}]}}}
        self.cfg={'courses':{'LAND2510':'3962245'},'elc_term_code':'20272'}
        self.fetched={}; self.queue=DeliveryQueue(self.root / ".material-delivery.json", self.root); self.saved=[]

    def save(self, state): self.saved.append(copy.deepcopy(state))
    def recover(self, save=None, media=None):
        return intake.recover(self.root,self.downloads,self.manifest,self.fetched,{'LAND2510E'},self.cfg,
            self.queue,save or self.save,inspect_media=media or (lambda _:60))
    def finish(self): self.partial.rename(self.downloads/self.row['final_name'])
    def reason(self): return intake._load(self.root)['captures'][0].get('reason')

    def test_partial_never_reads_media_or_enqueues_and_is_visible(self):
        media=Mock(side_effect=AssertionError('must not read partial'))
        self.assertEqual(self.recover(media=media)['pending'],1);media.assert_not_called()
        self.assertEqual(self.queue.entries(read_only=True),{});self.assertEqual(self.saved,[])
        self.assertEqual(intake.pending_topics(self.root),{('LAND2510E','1')})
        self.assertEqual(intake.summary(self.root)['reasons'],['native_download_in_progress'])

    def test_browser_final_rename_binds_exact_bytes_once_and_restart_is_idempotent(self):
        self.finish();result=self.recover();self.assertEqual(result['accepted'],1)
        records=self.queue.entries(read_only=True);self.assertEqual(len(records),1)
        record=records['LAND2510E:1'];self.assertEqual(Path(record['raw_path']).read_bytes(),b'fake original bytes')
        self.assertEqual(self.saved[-1]['1']['native_source_receipt']['capture_id'],'native-one')
        self.assertEqual(self.recover()['accepted'],0);self.assertEqual(self.queue.entries(read_only=True),records)
        self.assertEqual(intake.pending_topics(self.root),set())

    def test_same_filename_with_different_inode_is_not_the_observed_download(self):
        self.partial.unlink();(self.downloads/'lecture.mp4').write_bytes(b'unrelated bytes')
        # Retain an impossible registered identity even on filesystems that reuse inodes.
        self.state['captures'][0]['inode']+=100000;intake.save_state(self.root,self.state)
        self.assertEqual(self.recover()['accepted'],0);self.assertEqual(self.reason(),'native_file_identity_mismatch')
        self.assertFalse(self.saved)

    def test_current_scope_and_known_topic_source_changes_block_old_receipt(self):
        self.finish();self.cfg['elc_term_code']='later';self.recover();self.assertEqual(self.reason(),'native_scope_changed')
        self.cfg['elc_term_code']='20272';self.manifest['courses']['LAND2510E']['items'][0]['Url']='/changed/lecture.mp4'
        self.recover();self.assertEqual(self.reason(),'native_source_identity_mismatch');self.assertFalse(self.saved)

    def test_duration_or_small_final_file_never_advances_freshness(self):
        self.finish();self.recover(media=lambda _:10);self.assertEqual(self.reason(),'native_duration_mismatch')
        (self.downloads/'lecture.mp4').write_bytes(b'x');self.recover();self.assertEqual(self.reason(),'native_size_mismatch')
        self.assertEqual(self.fetched,{})

    def test_failed_fetched_save_retains_pending_but_durable_enqueue_recovers(self):
        self.finish();failed=Mock(side_effect=OSError('simulated disk failure'))
        self.assertEqual(self.recover(save=failed)['accepted'],0);self.assertEqual(self.reason(),'native_intake_failed')
        first=self.queue.entries(read_only=True)['LAND2510E:1']['revision_id'];self.fetched={}
        self.assertEqual(self.recover()['accepted'],1)
        self.assertEqual(self.queue.entries(read_only=True)['LAND2510E:1']['revision_id'],first)

    def test_corrupt_state_fails_closed_without_overwriting_original(self):
        path=self.root/intake.STATE_NAME;path.write_text('{broken');before=path.read_bytes()
        for callback in (lambda:intake.pending_topics(self.root),lambda:intake.summary(self.root),self.recover):
            with self.assertRaisesRegex(ValueError,'invalid_native_intake_state'):callback()
        self.assertEqual(path.read_bytes(),before)

    def test_symlink_and_unsafe_registered_paths_cannot_escape_downloads(self):
        self.partial.unlink();other=self.root/'elsewhere.mp4';other.write_bytes(b'fake original bytes')
        (self.downloads/'lecture.mp4').symlink_to(other);self.recover();self.assertEqual(self.reason(),'native_file_identity_mismatch')
        self.state['captures'][0]['final_name']='../elsewhere.mp4';intake.save_state(self.root,self.state)
        with self.assertRaises(ValueError):self.recover()
        self.state['captures'][0]['final_name']='..%2felsewhere.mp4';intake.save_state(self.root,self.state)
        with self.assertRaises(ValueError):self.recover()

    def test_original_changed_during_copy_never_receives_freshness_receipt(self):
        self.finish()
        def changing_copy(source, target):
            Path(target).write_bytes(b'changed concurrent download')
        with patch.object(intake.shutil,'copyfile',side_effect=changing_copy):
            self.assertEqual(self.recover()['accepted'],0)
        self.assertEqual(self.reason(),'native_source_changed');self.assertEqual(self.fetched,{})
        self.assertEqual(self.queue.entries(read_only=True),{})

    def test_each_pass_bounds_actual_accepted_files(self):
        captures=[]
        for n in range(3):
            topic=str(n+1);name=f'lecture{topic}.mp4';p=self.downloads/name;p.write_bytes(b'fake original bytes');stat=p.stat()
            row=dict(self.row,capture_id=f'native-{topic}',topic_id=topic,final_name=name,partial_name=f'partial{topic}.crdownload',device=stat.st_dev,inode=stat.st_ino,source_path=f'/content/enforced4/3962245-course.20272/{name}')
            captures.append(row)
        self.state['captures']=captures;intake.save_state(self.root,self.state)
        self.manifest['courses']['LAND2510E']['items']=[{'id':n+1,'type':'File','title':f'Lecture{n+1}','ext':'mp4'} for n in range(3)]
        self.assertEqual(self.recover()['accepted'],2);self.assertEqual(intake.summary(self.root)['pending'],1)
        self.assertEqual(self.recover()['accepted'],1)

if __name__=='__main__':unittest.main()
