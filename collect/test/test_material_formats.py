import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'bin'))
import extract_text
import bundle

class MaterialFormats(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
    def archive(self, members):
        p=self.root/'download.zip'
        with zipfile.ZipFile(p,'w') as z:
            for name,body in members: z.writestr(name,body)
        return p
    def test_actual_html_in_d2l_zip_is_extracted_without_script_or_styles(self):
        p=self.archive([('course/syllabus.html','<h1>Course syllabus</h1><style>private-css</style><p>Exam moved to October 19.</p><script>private-js</script>'),('course/logo.png',b'fake image')])
        text,note=extract_text.extract(str(p));self.assertIsNone(note)
        self.assertIn('Exam moved to October 19.',text)
        self.assertNotIn('private-js',text);self.assertNotIn('private-css',text)
    def test_replaced_archive_under_same_path_has_new_contents(self):
        p=self.archive([('syllabus.html','<p>Template</p>')])
        a,_=extract_text.extract(str(p))
        p=self.archive([('syllabus.html','<p>Actual lesson</p>')])
        b,_=extract_text.extract(str(p));self.assertNotEqual(a,b);self.assertIn('Actual lesson',b)
    def test_unsafe_or_incomplete_archive_remains_unextracted(self):
        for names in [[('../outside.txt','bad')],[('good.txt','text'),('broken.pdf',b'not pdf')],[('notes.txt','text'),('lecture.mp4',b'video')]]:
            with self.subTest(names=[n for n,_ in names]):
                text,note=extract_text.extract(str(self.archive(names)))
                self.assertIsNone(text);self.assertTrue(note)
        self.assertFalse((self.root.parent/'outside.txt').exists())
    def text(self,name,topic,title,body):
        d=self.root/'BUSN3040'/'text';d.mkdir(parents=True,exist_ok=True)
        p=d/name;p.write_text(f'# {title}\nSource topic ID: {topic}\n'+ '='*72+'\n'+body)
        return p
    def test_distinct_source_ids_are_not_folded_for_similar_text(self):
        self.text('BUSN3040_ELC_1.txt','1','R lesson one','A'*200+' lesson one')
        self.text('BUSN3040_ELC_2.txt','2','R lesson two','A'*200+' lesson two')
        with patch.object(bundle,'ROOT',str(self.root)):
            groups,dropped=bundle.collect('BUSN3040')
        self.assertEqual(sum(len(g) for g in groups.values()),2);self.assertEqual(dropped,[])
    def test_category_move_replaces_prior_bundle_with_explicit_empty_contents(self):
        p=self.text('BUSN3040_ELC_1.txt','1','Course syllabus','Original rules')
        with patch.object(bundle,'ROOT',str(self.root)):
            first=bundle.build('BUSN3040',log=lambda _:None)
            self.assertEqual(len(first),1)
            p.write_text('# R programming exercises\nSource topic ID: 1\n'+'='*72+'\nCurrent exercises')
            built=bundle.build('BUSN3040',log=lambda _:None)
        admin=(self.root/'BUSN3040/bundles/BUSN3040_Syllabus_and_Admin.txt').read_text()
        self.assertIn('0 source document(s)',admin);self.assertNotIn('Original rules',admin)
        self.assertEqual(len(built),2)

if __name__=='__main__':unittest.main()
