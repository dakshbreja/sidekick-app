import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / 'bin/drive_sync.py'
spec = importlib.util.spec_from_file_location('drive_filing', source)
drive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drive)


class CourseFilingTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.drive_root = self.root / 'Drive'
        self.patch = patch.object(drive, 'DRIVE', str(self.drive_root))
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def raw(self, body, name='source.pdf'):
        raw = self.root / name
        raw.write_bytes(body)
        return str(raw)

    def current(self, rel, body):
        path = self.drive_root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        return path

    def test_collector_busn3040_identity_files_original_in_its_drive_course(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); raw = root / 'Syllabus.zip'; raw.write_bytes(b'original syllabus archive')
            with patch.object(drive, 'DRIVE', str(root / 'Drive')):
                action, rel = drive.file_item('BUSN3040', str(raw), 'Syllabus', '', index={})
                self.assertEqual(action, 'filed')
                self.assertEqual(rel, 'BUSN 3040E/01 - Syllabus & Course Info/Syllabus.zip')
                self.assertEqual((Path(drive.DRIVE) / rel).read_bytes(), raw.read_bytes())

    def test_direct_html_originals_are_filed_and_revised_without_conversion(self):
        for extension in ('.html', '.htm'):
            with self.subTest(extension=extension):
                raw = self.raw(b'<html><body>Original course guidance</body></html>', 'source' + extension)
                action, rel = drive.file_item('BUSN3040', raw, 'Guidance ' + extension, 'Syllabus', index={})
                self.assertEqual(action, 'filed')
                current = self.drive_root / rel
                self.assertEqual(current.read_bytes(), Path(raw).read_bytes())
                self.assertTrue(rel.endswith(extension))
                old_bytes = current.read_bytes()
                Path(raw).write_bytes(b'<html><body>Updated course guidance</body></html>')
                action, revised = drive.file_item('BUSN3040', raw, 'Updated guidance', 'Syllabus',
                                                 index={}, preferred_rel=rel)
                self.assertEqual((action, revised), ('superseded', rel))
                self.assertEqual(current.read_bytes(), Path(raw).read_bytes())
                self.assertIn(old_bytes, [p.read_bytes() for p in (current.parent / 'Superseded').iterdir()])

    def test_retained_audio_is_filed_with_original_bytes_and_extension(self):
        raw = self.raw(b'retained audio source', 'Egypt.mp3')
        action, rel = drive.file_item('LAND2510E', raw, '10_Egypt', 'Week 5 > Lecture 10_ Egypt', index={})
        self.assertEqual(action, 'filed')
        self.assertEqual(rel, 'LAND 2510E/03 - Lecture Videos/W05 - 10_Egypt.mp3')
        self.assertEqual((self.drive_root / rel).read_bytes(), Path(raw).read_bytes())
        action, same = drive.file_item('LAND2510E', raw, '10_Egypt', 'Week 5 > Lecture 10_ Egypt', index={})
        self.assertEqual((action, same), ('present', rel))

    def test_archived_bytes_cannot_satisfy_reverted_current_source(self):
        rel = 'MGMT 4280/02 - Slides/Lesson.pdf'
        current = self.current(rel, b'revision two')
        archived = self.current('MGMT 4280/02 - Slides/Superseded/Lesson old.pdf', b'revision one')
        raw = self.raw(b'revision one')
        index = {drive.sha(raw): [str(archived)]}
        action, result = drive.file_item('MGMT4280', raw, 'Lesson', '', index=index)
        self.assertEqual((action, result), ('superseded', rel))
        self.assertEqual(current.read_bytes(), b'revision one')
        self.assertEqual(archived.read_bytes(), b'revision one')
        archives = current.parent / 'Superseded'
        self.assertIn(b'revision two', [p.read_bytes() for p in archives.iterdir()])

    def test_index_does_not_include_superseded_subtree(self):
        current = self.current('MGMT 4280/02 - Slides/Lesson.pdf', b'current')
        archived = self.current('MGMT 4280/02 - Slides/Superseded/Lesson.pdf', b'past')
        index = drive._index('MGMT 4280', cache={})
        self.assertEqual(index, {drive.sha(str(current)): [str(current)]})
        self.assertNotIn(drive.sha(str(archived)), index)

    def test_same_day_revisions_all_survive(self):
        rel = 'MGMT 4280/02 - Slides/Lesson.pdf'
        current = self.current(rel, b'first')
        for body in (b'second', b'third'):
            action, _ = drive.file_item('MGMT4280', self.raw(body), 'Lesson', '', index={})
            self.assertEqual(action, 'superseded')
        self.assertEqual(current.read_bytes(), b'third')
        archives = list((current.parent / 'Superseded').iterdir())
        self.assertEqual(len(archives), 2)
        self.assertEqual({p.read_bytes() for p in archives}, {b'first', b'second'})

    def test_preferred_destination_preserves_renamed_topic_and_curated_name(self):
        rel = 'MGMT 4280/02 - Slides/Curated Lesson.pdf'
        current = self.current(rel, b'old')
        duplicate = self.current('MGMT 4280/06 - Readings & IRL/Other source.pdf', b'new')
        raw = self.raw(b'new')
        action, result = drive.file_item('MGMT4280', raw, 'Changed title', '',
                                        index={drive.sha(raw): [str(duplicate)]}, preferred_rel=rel)
        self.assertEqual((action, result), ('superseded', rel))
        self.assertEqual(current.read_bytes(), b'new')
        self.assertFalse((current.parent / 'Changed title.pdf').exists())

    def test_changed_format_archives_prior_current_name(self):
        old_rel = 'MGMT 4280/02 - Slides/Curated Lesson.pdf'
        old = self.current(old_rel, b'old pdf')
        action, result = drive.file_item('MGMT4280', self.raw(b'new docx', 'source.docx'),
                                        'Changed title', '', index={}, preferred_rel=old_rel)
        self.assertEqual((action, result), ('superseded', 'MGMT 4280/02 - Slides/Curated Lesson.docx'))
        self.assertFalse(old.exists())
        self.assertEqual((self.drive_root / result).read_bytes(), b'new docx')
        self.assertEqual([p.read_bytes() for p in (old.parent / 'Superseded').iterdir()], [b'old pdf'])

    def test_preferred_destination_rejects_outside_course_or_history(self):
        raw = self.raw(b'new')
        for rel in ('../outside.pdf', '/tmp/outside.pdf', 'BUSN 5000/Lesson.pdf',
                    'MGMT 4280/02 - Slides/Superseded/old.pdf'):
            with self.subTest(rel=rel), self.assertRaises(ValueError):
                drive.file_item('MGMT4280', raw, 'Lesson', '', index={}, preferred_rel=rel)
        self.assertFalse(self.drive_root.exists())

    def test_stale_index_bucket_cannot_match_replaced_path(self):
        raw = self.raw(b'wanted')
        wrong = self.current('MGMT 4280/02 - Slides/Other.pdf', b'changed')
        action, result = drive.file_item('MGMT4280', raw, 'Lesson', '',
                                        index={drive.sha(raw): [str(wrong)]})
        self.assertEqual(action, 'filed')
        self.assertEqual((self.drive_root / result).read_bytes(), b'wanted')

    def test_dry_run_does_not_move_or_write_current_or_archives(self):
        rel = 'MGMT 4280/02 - Slides/Lesson.pdf'
        self.current(rel, b'old')
        raw = self.raw(b'new')
        before = {str(p.relative_to(self.drive_root)): p.read_bytes()
                  for p in self.drive_root.rglob('*') if p.is_file()}
        action, result = drive.file_item('MGMT4280', raw, 'Renamed', '', dry=True,
                                        index={}, preferred_rel=rel)
        after = {str(p.relative_to(self.drive_root)): p.read_bytes()
                 for p in self.drive_root.rglob('*') if p.is_file()}
        self.assertEqual((action, result), ('superseded', rel))
        self.assertEqual(before, after)

    def test_failed_staging_preserves_current_file(self):
        rel = 'MGMT 4280/02 - Slides/Lesson.pdf'
        current = self.current(rel, b'old')
        raw = self.raw(b'new')
        with patch.object(drive.shutil, 'copy2', side_effect=OSError('interrupted copy')):
            with self.assertRaises(OSError):
                drive.file_item('MGMT4280', raw, 'Lesson', '', index={})
        self.assertEqual(current.read_bytes(), b'old')
        self.assertEqual(list(current.parent.iterdir()), [current])

    def test_subsecond_mtime_change_invalidates_hash_cache(self):
        raw = self.raw(b'first')
        cache = {}
        original = drive._cached_sha(raw, cache)
        stamp = os.stat(raw).st_mtime
        Path(raw).write_bytes(b'other')
        os.utime(raw, (stamp + 0.25, stamp + 0.25))
        self.assertNotEqual(drive._cached_sha(raw, cache), original)

    def test_dry_run_without_index_does_not_save_cache(self):
        raw = self.raw(b'new')
        with patch.object(drive, '_load_cache', return_value={}), patch.object(drive, '_save_cache') as save:
            action, _ = drive.file_item('MGMT4280', raw, 'Lesson', '', dry=True)
        self.assertEqual(action, 'filed')
        save.assert_not_called()
        self.assertFalse(self.drive_root.exists())

    def test_interrupted_hidden_stage_cannot_satisfy_delivery(self):
        raw = self.raw(b'new')
        staged = self.current('MGMT 4280/02 - Slides/.material-leftover', b'new')
        index = drive._index('MGMT 4280', cache={})
        self.assertEqual(index, {})
        action, result = drive.file_item('MGMT4280', raw, 'Lesson', '',
                                        index={drive.sha(raw): [str(staged)]})
        self.assertEqual(action, 'filed')
        self.assertEqual((self.drive_root / result).read_bytes(), b'new')


if __name__ == '__main__': unittest.main()
