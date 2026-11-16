"""Exercise the actual tab reader against delayed UI states, without a browser."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import types
import unittest

sys.modules.setdefault('cdp', types.SimpleNamespace(find_page=None, evaluate=None))
SOURCE = Path(__file__).resolve().parents[1] / 'bin/cluely_export.py'
spec = importlib.util.spec_from_file_location('export_readiness', SOURCE)
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)

HARNESS = r"""
const vm = require('node:vm');
let input='';
process.stdin.on('data', s=>input+=s);
process.stdin.on('end', async()=>{
  const {script, scenario, want, marker} = JSON.parse(input);
  let tick=0, clicks=0;
  const location={hash:'#/dashboard/sessions/example'};
  const ready=()=>scenario==='never' ? false : scenario==='lost_click' ? clicks>=2 : tick>=8;
  const button=name=>({innerText:name, disabled:false, click(){clicks++;}});
  const document={
    querySelectorAll(){return [button(want), ...(ready() && scenario!=='empty' ? [button(marker)] : [])];},
    body:{get innerText(){
      if (scenario==='empty' && tick>=8) return 'Transcript\nNo transcript';
      if (!ready()) return 'Summary\nTranscript\nLoading...';
      if (scenario==='same_length_change' && tick<15) return marker+'\n'+(tick%2?'AAAA':'BBBB');
      return marker+'\ncomplete content';
    }}
  };
  const context={document,location,setTimeout(fn){
    tick++;
    if (scenario==='navigated' && tick===2) location.hash='#/another-session';
    fn();
  }};
  const value=JSON.parse(await vm.runInNewContext(script,context));
  process.stdout.write(JSON.stringify({value,tick,clicks}));
});
"""


@unittest.skipUnless(shutil.which('node'), 'Node required for isolated JavaScript readiness tests')
class ReadinessTests(unittest.TestCase):
    def run_reader(self, scenario, want='Summary'):
        marker='Copy '+want.lower()
        script=exporter.TAB_JS % tuple(map(json.dumps, ['/dashboard/sessions/example', want, marker]))
        result=subprocess.run(['node','-e',HARNESS],input=json.dumps({
            'script':script,'scenario':scenario,'want':want,'marker':marker}),
            text=True,capture_output=True,check=True,timeout=5)
        return json.loads(result.stdout)

    def test_unchanging_loading_screen_waits_for_copy_control(self):
        result=self.run_reader('delayed')
        self.assertEqual(result['value'],{'text':'Copy summary\ncomplete content'})
        self.assertGreaterEqual(result['tick'],11)

    def test_lost_tab_click_is_retried_before_export(self):
        result=self.run_reader('lost_click')
        self.assertEqual(result['value'],{'text':'Copy summary\ncomplete content'})
        self.assertGreaterEqual(result['clicks'],2)

    def test_same_length_content_changes_are_not_stable(self):
        result=self.run_reader('same_length_change')
        self.assertEqual(result['value'],{'text':'Copy summary\ncomplete content'})
        self.assertGreaterEqual(result['tick'],18)

    def test_missing_marker_expires_without_returning_page_as_content(self):
        result=self.run_reader('never')
        self.assertNotIn('text',result['value'])
        self.assertIn('expected Copy summary',result['value']['err'])
        self.assertNotIn('Loading',result['value']['err'])
        self.assertEqual(result['tick'],60)

    def test_navigation_to_another_session_aborts(self):
        result=self.run_reader('navigated')
        self.assertIn('session changed',result['value']['err'])
        self.assertNotIn('text',result['value'])

    def test_transcript_uses_its_own_copy_control(self):
        result=self.run_reader('delayed','Transcript')
        self.assertEqual(result['value'],{'text':'Copy transcript\ncomplete content'})

    def test_explicit_no_transcript_remains_available_for_routing_review(self):
        result=self.run_reader('empty','Transcript')
        self.assertEqual(result['value'],{'text':'Transcript\nNo transcript'})


LIST_HARNESS = r"""
const vm=require('node:vm');let input='';
process.stdin.on('data',s=>input+=s);process.stdin.on('end',async()=>{
 const {script,scenario}=JSON.parse(input);let tick=0,scrolled=0,count=20,top=0;
 const root={clientHeight:500,parentElement:null,
  get scrollHeight(){return count*50;},get scrollTop(){return top;},
  set scrollTop(n){scrolled++;top=Math.min(n,this.scrollHeight-this.clientHeight);},
  get innerText(){return scenario==='delayed' && scrolled>0 && tick<15 ? 'Loading...' : 'Sessions';}};
 const document={scrollingElement:root,documentElement:root,body:root,
  querySelectorAll(selector){return selector.startsWith('a[') ? Array.from({length:count},(_,i)=>({
   getAttribute(){return '/dashboard/sessions/'+i;},innerText:'Session',parentElement:root})) : [];}};
 const context={document,location:{hash:''},getComputedStyle(){return {overflowY:'visible'};},setTimeout(fn){
  tick++;if(scenario==='delayed' && tick===15 && scrolled)count=40;
  if(scenario==='cap' && scrolled && tick%3===0)count+=20;
  fn();}};
 const value=JSON.parse(await vm.runInNewContext(script,context));
 process.stdout.write(JSON.stringify({value,tick,scrolled}));
});
"""

@unittest.skipUnless(shutil.which('node'), 'Node required for isolated pagination tests')
class PaginationTests(unittest.TestCase):
    def read(self,scenario):
        r=subprocess.run(['node','-e',LIST_HARNESS],input=json.dumps({'script':exporter.LIST_JS,'scenario':scenario}),
                         text=True,capture_output=True,check=True,timeout=5)
        return json.loads(r.stdout)

    def test_visible_overflow_document_root_is_scrolled(self):
        r=self.read('root');self.assertGreater(r['scrolled'],0)
        self.assertTrue(r['value']['coverage_complete'])
        self.assertEqual(len(r['value']['sessions']),20)

    def test_delayed_loading_waits_for_next_page(self):
        r=self.read('delayed');self.assertTrue(r['value']['coverage_complete'])
        self.assertEqual(len(r['value']['sessions']),40)
        self.assertGreaterEqual(r['tick'],30)

    def test_pagination_cap_is_explicitly_incomplete(self):
        r=self.read('cap');self.assertFalse(r['value']['coverage_complete'])
        self.assertEqual(r['value']['coverage_reason'],'pagination_limit_or_loading')
        self.assertLessEqual(r['tick'],181)



class DeadlineTests(unittest.TestCase):
    def load_cdp(self):
        spec=importlib.util.spec_from_file_location('deadline_cdp',SOURCE.with_name('cdp.py'))
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module

    def test_discovery_has_explicit_timeout(self):
        from unittest.mock import patch, MagicMock
        cdp=self.load_cdp();response=MagicMock();response.__enter__.return_value.read.return_value='[]'
        with patch.object(cdp.urllib.request,'urlopen',return_value=response) as opened:
            self.assertEqual(cdp.targets(),[])
        self.assertEqual(opened.call_args.kwargs['timeout'],10)

    def test_unrelated_events_cannot_extend_total_operation(self):
        from unittest.mock import patch, MagicMock
        cdp=self.load_cdp();ws=MagicMock();ws.recv.return_value='{"method":"event"}'
        with patch.object(cdp.websocket,'create_connection',return_value=ws), patch.object(cdp.time,'monotonic',side_effect=[0,1,2,3,11]):
            with self.assertRaises(TimeoutError):cdp.evaluate('fixture','1',timeout=10)
        self.assertEqual(ws.recv.call_count,2)
        ws.close.assert_called_once_with(timeout=0)

    def test_success_still_closes_socket(self):
        from unittest.mock import patch, MagicMock
        cdp=self.load_cdp();ws=MagicMock();ws.recv.return_value='{"id":1,"result":{}}'
        with patch.object(cdp.websocket,'create_connection',return_value=ws):
            self.assertEqual(cdp.evaluate('fixture','1')['id'],1)
        ws.close.assert_called_once_with(timeout=0)

class DailyStageTests(unittest.TestCase):
    def test_zero_drive_work_is_not_fresh_delivery(self):
        import tempfile
        source=SOURCE.with_name('daily.sh').read_text()
        block=source[source.index('DRIVEOUT=$(mktemp)'):source.index('# Push whatever')]
        with tempfile.TemporaryDirectory() as folder:
            block='\n'.join(line for line in block.splitlines() if 'daily_stage.py' not in line)
            block=block.replace('run_stage drive 180 ', '').replace('mktemp',f'mktemp "{folder}/output.XXXXXX"').replace('python3 "$BIN/sync_drive.py"','printf "drive sync: 0 copied, 0 failed\\n"')
            script=f'LOG="{folder}/log"; fail=""; note() {{ :; }}; '+block+'\nprintf "%s:%s:%s" "$stage_drive" "$drive_outcome" "$drive_copied"'
            result=subprocess.run(['/bin/bash','-c',script],capture_output=True,text=True,check=True)
            self.assertEqual(result.stdout,'ok:no_work:0')

    def test_missing_drive_result_fails_closed(self):
        import tempfile
        source=SOURCE.with_name('daily.sh').read_text()
        block=source[source.index('DRIVEOUT=$(mktemp)'):source.index('# Push whatever')]
        with tempfile.TemporaryDirectory() as folder:
            block='\n'.join(line for line in block.splitlines() if 'daily_stage.py' not in line)
            block=block.replace('run_stage drive 180 ', '').replace('mktemp',f'mktemp "{folder}/output.XXXXXX"').replace('python3 "$BIN/sync_drive.py"','true')
            result=subprocess.run(['/bin/bash','-c',f'LOG="{folder}/log"; fail=""; note() {{ :; }}; '+block+'\nprintf "%s" "$stage_drive"'],capture_output=True,text=True,check=True)
            self.assertEqual(result.stdout,'failed')

if __name__=='__main__': unittest.main()
