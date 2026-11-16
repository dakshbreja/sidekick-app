"""Publication safety regressions. Every browser operation is simulated."""
import copy
import json
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bin'))
import gpt_upload as gpt


class Browser:
    def __init__(self, names):
        self.state = dict(ready=True, names=list(names), config={'controls': ['instructions', 'model'], 'actions': ['bridge.example.com']},
                          instructions=500, pendingDraft=False, busy=False, updateEnabled=True,
                          updated=False, name='Course')
        self.reloads = self.clicks = 0
        self.missing_on_reload = {}
        self.wrong_upload = False
        self.busy_upload = False
        self.change_config = False
        self.wrong_remove = False
        self.attach_names = []
        self.omit_name = None
        self.omit_uploads = 0
        self.closed = False
        self.clock = 0
        self.redirect = False
        self.reopened = False
        self.destination = 'editor'
        self.reopen_error = False
        self.reopen_changes_config = False

    def time(self):
        self.clock += 1
        return self.clock

    def sleep(self, _):
        pass

    def position(self):
        return (1, 1)

    def reload(self):
        self.reloads += 1
        self.state['updated'] = False
        missing = self.missing_on_reload.get(self.reloads)
        if missing in self.state['names']:
            self.state['names'].remove(missing)

    def publication_destination(self):
        return self.destination

    def reopen_published_editor(self):
        if self.reopen_error: raise gpt.UploadError('editor reopen failed')
        self.reopened = True
        if self.reopen_changes_config: self.state['config']['controls'].append('changed')
        self.destination = 'editor'

    def close(self):
        self.closed = True

    def probe(self, *_):
        return copy.deepcopy(self.state)

    def attach(self, editor, paths):
        pending=[Path(p).name for p in paths]
        self.state['names'].extend(pending)
        if self.omit_uploads and self.omit_name in self.state['names']:
            self.state['names'].remove(self.omit_name)
            self.omit_uploads -= 1
        if self.wrong_upload: self.state['names'][-1] = 'wrong.txt'
        self.state['busy'] = self.busy_upload
        if self.change_config: self.state['config']['controls'].append('changed instructions')

    def run(self, _win, _tab, script, **_kw):
        if script == gpt.CLICK_UPDATE.replace('\n', ' '):
            self.clicks += 1
            self.state['updated'] = not self.redirect
            if self.redirect: self.destination = 'published'
            return 'clicked'
        raise AssertionError('unexpected JS')

    def remove(self, _win, _tab, script, **_kw):
        import re, json
        name = json.loads(re.search(r"var want = (.+?);", script)[1])
        self.state['names'].remove(self.state['names'][0] if self.wrong_remove else name)
        return {'ok': True}


class SafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.paths = []
        for name in ['Admin.txt', 'Transcripts.txt']:
            p = Path(self.tmp.name) / name
            p.write_text('course text')
            self.paths.append(str(p))

    def execute(self, browser, *, paths=None, replace={'Transcripts.txt'}):
        with patch.object(gpt, 'OwnedEditor', return_value=browser), \
             patch.object(gpt.cb, 'wait_loaded', return_value=True), \
             patch.object(gpt, 'probe', browser.probe), \
             patch.object(gpt, 'backup', return_value='fake-backup.json'), \
             patch.object(gpt, 'upload_files_neo', browser.attach), \
             patch.object(gpt, '_run_js', browser.run), \
             patch.object(gpt, '_run_js_json', browser.remove), \
             patch.object(gpt.time, 'time', browser.time), \
             patch.object(gpt.time, 'sleep', browser.sleep):
            return gpt.upload('COURSE', 'gpt-id', self.paths if paths is None else paths,
                              replace=replace, log=lambda _: None)

    def test_success_preserves_originals_and_all_bundles_after_three_reloads(self):
        b = Browser(['Original.pdf', 'Admin.txt', 'Transcripts.txt'])
        result = self.execute(b)
        self.assertTrue(result['ok'])
        self.assertEqual(result['verification'], 'post_publish_reload')
        self.assertEqual(result['verified_inventory'], ['Admin.txt', 'Original.pdf', 'Transcripts.txt'])
        self.assertEqual((b.reloads, b.clicks), (3, 1))
        self.assertTrue(b.closed)

    def test_missing_unchanged_bundle_is_uploaded_from_complete_required_paths(self):
        b = Browser(['Original.pdf', 'Transcripts.txt'])
        result = self.execute(b)
        self.assertEqual(set(result['uploaded']), {'Admin.txt', 'Transcripts.txt'})
        self.assertEqual(set(b.state['names']), {'Original.pdf', 'Admin.txt', 'Transcripts.txt'})

    def test_one_dropped_attachment_recovers_without_replacing_survivors(self):
        b = Browser(['Original.pdf'])
        b.omit_name, b.omit_uploads = 'Admin.txt', 1
        result = self.execute(b)
        self.assertTrue(result['ok'])
        self.assertEqual(set(b.state['names']), {'Original.pdf','Admin.txt','Transcripts.txt'})
        self.assertEqual((b.reloads,b.clicks),(4,1))

    def test_persistent_attachment_loss_has_only_one_repair_and_never_publishes(self):
        b = Browser(['Original.pdf'])
        b.omit_name, b.omit_uploads = 'Admin.txt', 10
        with self.assertRaises(gpt.UploadError):
            self.execute(b)
        self.assertEqual(b.omit_uploads,8)
        self.assertEqual(b.clicks,0)

    def test_loss_of_unrelated_original_is_not_repaired_or_published(self):
        b = Browser(['Original.pdf'])
        b.omit_name, b.omit_uploads = 'Original.pdf', 1
        with self.assertRaises(gpt.UploadError):
            self.execute(b)
        self.assertEqual((b.reloads,b.clicks),(1,0))

    def test_wrong_filenames_with_right_count_never_publish(self):
        b = Browser(['Original.pdf'])
        b.wrong_upload = True
        with self.assertRaises(gpt.UploadError):
            self.execute(b)
        self.assertEqual(b.clicks, 0)

    def test_upload_processing_chips_are_not_completion(self):
        b = Browser(['Original.pdf'])
        b.busy_upload = True
        with self.assertRaises(gpt.UploadError):
            self.execute(b)
        self.assertEqual(b.clicks, 0)

    def test_pre_publish_reload_missing_unchanged_file_blocks_update(self):
        b = Browser(['Original.pdf', 'Admin.txt', 'Transcripts.txt'])
        b.missing_on_reload[2] = 'Admin.txt'
        with self.assertRaises(gpt.UploadError):
            self.execute(b)
        self.assertEqual(b.clicks, 0)

    def test_modal_followed_by_reload_loss_is_not_success(self):
        b = Browser(['Original.pdf', 'Admin.txt', 'Transcripts.txt'])
        b.missing_on_reload[3] = 'Admin.txt'
        with self.assertRaises(gpt.UploadError):
            self.execute(b)
        self.assertEqual(b.clicks, 1)
        self.assertTrue(b.closed)

    def test_concurrent_settings_change_never_publishes(self):
        b = Browser(['Original.pdf'])
        b.change_config = True
        with self.assertRaisesRegex(gpt.UploadError, 'configuration changed'):
            self.execute(b)
        self.assertEqual(b.clicks, 0)

    def test_prefix_collision_does_not_skip_required_file(self):
        b = Browser(['Admin.txt.backup', 'Transcripts.txt'])
        result = self.execute(b, replace=False)
        self.assertEqual(result['uploaded'], ['Admin.txt'])
        self.assertIn('Admin.txt.backup', result['verified_inventory'])

    def test_noop_is_reloaded_and_duplicate_names_are_rejected(self):
        b = Browser(['Admin.txt', 'Transcripts.txt'])
        result = self.execute(b, replace=False)
        self.assertTrue(result['ok'])
        self.assertEqual((b.reloads, b.clicks), (1, 0))
        b = Browser(['Admin.txt', 'Admin.txt', 'Transcripts.txt'])
        with self.assertRaisesRegex(gpt.UploadError, 'duplicate'):
            self.execute(b)
        self.assertEqual(b.clicks, 0)

    def test_noop_with_unsaved_draft_cannot_claim_publication(self):
        b = Browser(['Admin.txt', 'Transcripts.txt'])
        b.state['pendingDraft'] = True
        with self.assertRaisesRegex(gpt.UploadError, 'draft'):
            self.execute(b, replace=False)

    def test_unrelated_file_removal_does_not_satisfy_targeted_removal(self):
        b = Browser(['Original.pdf', 'Admin.txt', 'Transcripts.txt'])
        b.wrong_remove = True
        with self.assertRaises(gpt.UploadError):
            self.execute(b)
        self.assertEqual(b.clicks, 0)
        self.assertEqual(b.attach_names, [])

    def test_missing_local_bundle_cannot_be_silently_omitted(self):
        b = Browser([])
        with self.assertRaisesRegex(gpt.UploadError, 'missing'):
            self.execute(b, paths=self.paths + [str(Path(self.tmp.name) / 'absent.txt')])
        self.assertEqual(b.reloads, 0)

    def test_published_route_requires_reopen_and_exact_reload(self):
        b = Browser(['Original.pdf', 'Admin.txt', 'Transcripts.txt'])
        b.redirect = True
        result = self.execute(b)
        self.assertTrue(result['ok'])
        self.assertTrue(b.reopened)
        self.assertEqual((b.reloads,b.clicks),(3,1))

    def test_published_route_reopen_failure_does_not_succeed(self):
        b = Browser(['Original.pdf', 'Admin.txt', 'Transcripts.txt'])
        b.redirect = b.reopen_error = True
        with self.assertRaisesRegex(gpt.UploadError, 'reopen failed'): self.execute(b)

    def test_published_route_with_missing_file_does_not_succeed(self):
        b = Browser(['Original.pdf', 'Admin.txt', 'Transcripts.txt'])
        b.redirect = True
        b.missing_on_reload[3] = 'Original.pdf'
        with self.assertRaises(gpt.UploadError): self.execute(b)

    def test_published_route_configuration_drift_does_not_succeed(self):
        b = Browser(['Original.pdf','Admin.txt','Transcripts.txt'])
        b.redirect = b.reopen_changes_config = True
        with self.assertRaisesRegex(gpt.UploadError,'configuration changed'): self.execute(b)

    def test_remove_controls_support_both_labels_and_fail_closed(self):
        def run(labels, disabled=False):
            fixture = "const labels=" + json.dumps(labels) + "; let clicks=0; const buttons=labels.map(l=>({getAttribute:()=>l[0],textContent:l[1],disabled:" + json.dumps(disabled) + ",click:()=>clicks++})); const document={querySelectorAll:()=>buttons}; "
            script = fixture + "const result=" + (gpt.REMOVE % json.dumps('Transcripts.txt')).strip() + ";console.log(JSON.stringify({result:JSON.parse(result),clicks}));"
            result = subprocess.run(['/opt/homebrew/bin/node','-e',script],capture_output=True,text=True,check=True)
            return json.loads(result.stdout)
        for labels in [[['Remove file: Transcripts.txt','']], [['Remove Transcripts.txt','']], [[None,'Remove Transcripts.txt']]]:
            self.assertEqual(run(labels),{'result':{'ok':True},'clicks':1})
        for labels in [[['Remove Transcripts.txt.bak','']], [['Remove Transcripts.txt',''],['Remove file: Transcripts.txt','']],
                       [['Delete Transcripts.txt','']], [['Remove file: Other.txt','']], [['Remove  Transcripts.txt','']]]:
            result=run(labels);self.assertFalse(result['result']['ok']);self.assertEqual(result['clicks'],0)
        self.assertEqual(run([['Remove Transcripts.txt','']],True)['clicks'],0)

    def test_published_destination_is_exact_and_fail_closed(self):
        gid = 'g-abc123'
        for suffix in ['', '-course-5000']:
            self.assertEqual(gpt.publication_destination('https://chatgpt.com/g/'+gid+suffix,gid),'published')
        self.assertEqual(gpt.publication_destination('https://chatgpt.com/gpts/editor/'+gid,gid),'editor')
        for url in ['http://chatgpt.com/g/g-abc123', 'https://evil.test/g/g-abc123',
                    'https://chatgpt.com.evil.test/g/g-abc123','https://chatgpt.com:443/g/g-abc123',
                    'https://chatgpt.com/g/g-other', 'https://chatgpt.com/g/g-abc1234',
                    'https://chatgpt.com/g/g-abc123/c/chat', 'https://chatgpt.com/g/g-abc123?x=1',
                    'https://chatgpt.com/g/g-abc123#x','https://chatgpt.com/gpts/editor/g-other']:
            with self.subTest(url=url), self.assertRaises(gpt.UploadError): gpt.publication_destination(url,gid)

    def test_visible_credentials_fail_closed_before_any_edit(self):
        b = Browser(['Original.pdf'])
        b.state['credentialDialog'] = True
        with self.assertRaisesRegex(gpt.UploadError, 'credential'):
            self.execute(b)
        self.assertEqual((b.reloads, b.clicks), (0, 0))
        self.assertIn("!credential(x)", gpt.PROBE)
        self.assertIn("'password','file'", gpt.PROBE)

    def test_owned_tab_resolves_new_position_and_guards_exact_editor_url(self):
        with patch.object(gpt.cb, 'open_owned_tab', return_value=99), \
             patch.object(gpt.cb, 'find_tab_id', return_value=(2, 4)), \
             patch.object(gpt.cb, 'run_js', return_value='ok') as run:
            editor = gpt.OwnedEditor('gpt-id')
            editor.run("window.__kb='';'ok'")
            args = run.call_args.args
            self.assertEqual(args[:2], (2, 4))
            self.assertIn('location.origin+location.pathname', args[2])
            self.assertIn('https://chatgpt.com/gpts/editor/gpt-id', args[2])
        with patch.object(gpt.cb, 'open_owned_tab', return_value=99), \
             patch.object(gpt.cb, 'find_tab_id', return_value=None), \
             patch.object(gpt.cb, 'run_js') as run:
            with self.assertRaises(gpt.UploadError):
                gpt.OwnedEditor('gpt-id').run("'ok'")
            run.assert_not_called()



class KnowledgeInputTests(unittest.TestCase):
    def test_scoped_input_layouts_and_ambiguity(self):
        fixture = r"""
function input(label='',disabled=false) { return {disabled,
 getAttribute:k=>k==='aria-label'?label:null,matches:s=>s==='input[type=file]'}; }
function button(nested=[],siblings=[],disabled=false) { return {disabled,textContent:'Upload files',
 getAttribute:()=>null,querySelectorAll:()=>nested,parentElement:{children:siblings}}; }
const good=input(), composer=input('Attach files'), other=input();
const cases=[
 ['sibling',[button([],[good])],good],
 ['nested',[button([good],[])],good],
 ['composer excluded',[button([],[composer])],null],
 ['two inputs',[button([],[good,other])],null],
 ['nested plus sibling',[button([good],[other])],null],
 ['two buttons',[button([],[good]),button([],[other])],null],
 ['disabled input',[button([],[input('',true)])],null],
 ['disabled button',[button([],[good],true)],null],
 ['no button',[],null],['no input',[button()],null]
];
let document={querySelectorAll:()=>[]};
"""
        script=fixture+gpt.KNOWLEDGE_INPUT_JS.replace("\n", " ")+r"""
for(const [name,buttons,expected] of cases){
 document.querySelectorAll=()=>buttons;
 const got=knowledgeUploadInput();
 if ((got?got.input:null)!==expected) throw Error(name);
}
console.log('10 layouts passed');
"""
        result=subprocess.run(['/opt/homebrew/bin/node','-e',script],capture_output=True,text=True,check=True)
        self.assertIn('10 layouts passed',result.stdout)
        self.assertIn(gpt.KNOWLEDGE_INPUT_JS,gpt.PROBE)
        self.assertIn(gpt.KNOWLEDGE_INPUT_JS,gpt.EXPOSE_KNOWLEDGE_INPUT)
        self.assertNotIn("b.querySelector('input[type=file]')",gpt.PROBE+gpt.EXPOSE_KNOWLEDGE_INPUT)



class NeoOfficialUploadTests(unittest.TestCase):
    def script(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'Bundle.txt';path.write_text('synthetic fixture')
            editor=object.__new__(gpt.OwnedEditor);editor.url='https://chatgpt.com/gpts/editor/g-test'
            with patch.object(editor,'position',return_value=(1,42)), patch.object(gpt.cb,'_run',return_value={'upload_invoked':True,'count':1}) as call:
                gpt.upload_files_neo(editor,[str(path)])
                self.assertEqual(call.call_args.kwargs['operation'],'knowledge_upload')
                return call.call_args.args[0]

    def test_official_upload_identity_and_finally_cleanup(self):
        script=self.script()
        for mode in ['success','duplicate','identity_drift','upload_error','restore_drift']:
            fixture=r"""
const mode=MODE;const window={},location={origin:'https://chatgpt.com',pathname:'/gpts/editor/g-test'};
let attrs={},styles={},uploads=0;
const input={disabled:false,isConnected:true,type:'file',
 getAttribute:k=>attrs[k]??null,setAttribute:(k,v)=>attrs[k]=v,removeAttribute:k=>delete attrs[k],
 matches:s=>s==='input[type=file]',style:{getPropertyValue:k=>styles[k]?.[0]||'',getPropertyPriority:k=>styles[k]?.[1]||'',setProperty:(k,v,p)=>styles[k]=[v,p],removeProperty:k=>delete styles[k]}};
const button={textContent:'Upload files',disabled:false,getAttribute:()=>null,querySelectorAll:()=>[],parentElement:{children:[input]}};
const document={querySelectorAll:()=>[button]};
const page={evaluate:async(fn,arg)=>({value:fn(arg)}),snapshot:async()=>{
 const refs=[{name:attrs['aria-label'],role:'button',ref:'e1'}];
 if(mode==='duplicate')refs.push({...refs[0]});
 if(mode==='identity_drift')input.isConnected=false;
 return {refs};},upload:async(ref,paths)=>{uploads++;if(ref!=='e1'||paths.length!==1)throw Error('wrong target');if(mode==='upload_error')throw Error('upload uncertain');if(mode==='restore_drift')attrs['aria-label']='external edit';}};
const browser={page:id=>{if(id!==42)throw Error('wrong page');return page;}};
""".replace('MODE',json.dumps(mode))
            js=fixture+'(async()=>{let error=false;try{await (async()=>{'+script+'})();}catch(e){error=true;}console.log(JSON.stringify({error,uploads,saved:!!window.__neoKnowledgeInput,aria:attrs["aria-label"]??null,display:styles.display??null}));})();'
            run=subprocess.run(['/opt/homebrew/bin/node','-e',js],capture_output=True,text=True,check=True)
            r=json.loads(run.stdout)
            self.assertEqual(r['error'],mode!='success',mode)
            self.assertEqual(r['uploads'],0 if mode in ('duplicate','identity_drift') else 1,mode)
            self.assertFalse(r['saved'])
            if mode not in ('identity_drift','restore_drift'):
                self.assertIsNone(r['aria']);self.assertIsNone(r['display'])

    def test_uncertain_result_never_becomes_success(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'Bundle.txt';path.write_text('fixture')
            editor=object.__new__(gpt.OwnedEditor);editor.url='https://chatgpt.com/gpts/editor/g-test'
            with patch.object(editor,'position',return_value=(1,42)),patch.object(gpt.cb,'_run',return_value=None):
                with self.assertRaisesRegex(gpt.UploadError,'uncertain'):gpt.upload_files_neo(editor,[str(path)])


class ReadinessTests(unittest.TestCase):
    def test_transient_incomplete_config_waits_but_never_confirms(self):
        complete=dict(ready=True,instructions=500,config={'controls':['safe'],'actions':[]},names=['a'],busy=False)
        incomplete={**complete,'instructions':0}
        with patch.object(gpt,'probe',side_effect=[incomplete,complete]),patch.object(gpt.time,'sleep'):
            self.assertEqual(gpt.wait_ready(None,None),complete)
        with patch.object(gpt,'probe',side_effect=[incomplete,complete,complete,complete]),patch.object(gpt.time,'sleep'):
            self.assertEqual(gpt.wait_inventory(None,None,gpt.Counter(['a']),complete['config']),complete)
        with patch.object(gpt,'probe',return_value=incomplete),patch.object(gpt.time,'sleep'),patch.object(gpt.time,'time',side_effect=range(100)):
            with self.assertRaises(gpt.UploadError):gpt.wait_inventory(None,None,gpt.Counter(['a']),complete['config'],timeout=5)

    def test_credentials_reject_even_in_incomplete_state(self):
        with self.assertRaisesRegex(gpt.UploadError,'credential'):
            gpt.configuration_ready({'instructions':0,'credentialDialog':True})


if __name__ == '__main__':
    unittest.main()
