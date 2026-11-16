import pathlib, subprocess, tempfile, unittest
s=pathlib.Path('meetings/bin/daily.sh').read_text()
block=s[s.index('if [ "$stage_launch" = "ok" ]; then'):s.index('# Copy notes into Google Drive')]
class NotificationTests(unittest.TestCase):
 def run_case(self, rc, lines):
  with tempfile.TemporaryDirectory() as d:
   fixture=pathlib.Path(d)/'fixture';fixture.write_text(lines)
   code=block.replace('/opt/anaconda3/bin/python3 "$BIN/cluely_export.py"',f'(cat "{fixture}"; exit {rc})')
   code=code.replace('mktemp',f'mktemp "{d}/export.XXXXXX"')
   r=subprocess.run(['/bin/bash','-c',f'LOG="{d}/log"; stage_launch=ok; fail=""; note() {{ :; }}; '+code+'\nprintf "%s\n%s\n" "$stage_export" "$fail"'],capture_output=True,text=True,check=True)
   return r.stdout
 def test_partial_counts(self):
  out=self.run_case(1,'exported one\nexported two\nFAILED three\nROUTING REVIEW: 7 recording(s) require content review\n')
  self.assertIn('failed',out);self.assertIn('2 recordings refreshed; 1 recording errors; 7 awaiting review',out)
 def test_total_failure(self):
  self.assertIn('failed before a complete result',self.run_case(1,'Traceback unavailable\n'))
 def test_success(self):self.assertEqual(self.run_case(0,'exported one\n'),'ok\n\n')
 def test_review_deferred(self):self.assertEqual(self.run_case(3,'ROUTING REVIEW: 7 recording(s) require content review\n'),'deferred\n\n')
unittest.main()
