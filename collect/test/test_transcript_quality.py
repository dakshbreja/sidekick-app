"""Offline quality gates: silent media must never become invented lecture text."""
from array import array
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bin'))
import transcribe


class TranscriptQualityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def wav(self, samples):
        path = self.root / 'source.wav'
        with wave.open(str(path), 'wb') as out:
            out.setnchannels(1); out.setsampwidth(2); out.setframerate(16000)
            out.writeframes(array('h', samples).tobytes())
        return path

    def test_silence_and_near_silence_rejected_but_late_audio_retained(self):
        self.assertTrue(transcribe.silent_pcm(self.wav([0] * 150000)))
        self.assertTrue(transcribe.silent_pcm(self.wav([10, -10] * 80000)))
        self.assertFalse(transcribe.silent_pcm(self.wav([0] * 150000 + [3000])))

    def test_empty_sparse_and_repetition_are_not_understood_as_lecture(self):
        self.assertEqual(transcribe.assess_transcript('', 300)['reason'], 'transcript_empty')
        self.assertEqual(transcribe.assess_transcript('Thank you.\n' * 4, 300)['reason'], 'transcript_repetitive')
        self.assertEqual(transcribe.assess_transcript('Welcome to this lecture.', 300)['reason'], 'transcript_low_content')

    def test_concise_short_clip_and_ordinary_lecture_are_usable(self):
        self.assertTrue(transcribe.assess_transcript('Choose the customer account, then save the invoice.', 15)['ok'])
        body = ('An invoice records the customer, products, price and payment terms.\n'
                'Posting it updates accounts receivable and the general ledger.\n'
                'A payment settles the open balance through the bank reconciliation.\n')
        self.assertTrue(transcribe.assess_transcript(body, 300)['ok'])

    def test_header_cannot_make_bad_body_look_long(self):
        path = self.root / 'lecture.txt'
        path.write_text('# Course — Video (lecture transcript)\nMachine transcript of 5 minutes of lecture audio.\n'
                        + 'Long provenance header ' * 100 + '\n' + '=' * 72 + '\nThank you.\n' * 4)
        self.assertFalse(transcribe.validate_transcript_path(path)['ok'])
        path.write_text('# Course — silent video (visual source notes)\nSome source labels.')
        self.assertTrue(transcribe.validate_transcript_path(path)['not_transcript'])

    def test_silent_source_never_invokes_decoder_or_writes_knowledge(self):
        wav = self.wav([0] * 100)
        with patch.object(transcribe, 'ROOT', str(self.root)), \
             patch.object(transcribe, 'locate_video', return_value='/fake/source.mp4'), \
             patch.object(transcribe, 'duration', return_value=300), \
             patch.object(transcribe, 'to_wav', return_value=str(wav)), \
             patch.object(transcribe, 'run_whisper', side_effect=AssertionError('silent source must not decode')):
            path, reason = transcribe.transcribe('MGMT4280', '/fake/source.zip', 'ERP')
        self.assertIsNone(path); self.assertEqual(reason, 'transcript_silent_audio')
        self.assertEqual(list((self.root / 'MGMT4280' / 'text').glob('*.txt')), [])

    def test_repetition_never_writes_knowledge_or_overwrites_previous(self):
        wav = self.wav([3000] * 100)
        txt = self.root / 'decoder.txt'; txt.write_text('Thank you.\n' * 60)
        dest = self.root / 'MGMT4280/text/MGMT4280_ERP_transcript.txt'
        dest.parent.mkdir(parents=True); dest.write_text('previous material')
        with patch.object(transcribe, 'ROOT', str(self.root)), \
             patch.object(transcribe, 'locate_video', return_value='/fake/source.mp4'), \
             patch.object(transcribe, 'duration', return_value=300), \
             patch.object(transcribe, 'to_wav', return_value=str(wav)), \
             patch.object(transcribe, 'build_prompt', return_value=('', None)), \
             patch.object(transcribe, 'run_whisper', return_value=(str(txt), 'unused.vtt')):
            path, reason = transcribe.transcribe('MGMT4280', '/fake/source.zip', 'ERP')
        self.assertIsNone(path); self.assertEqual(reason, 'transcript_repetitive')
        self.assertEqual(dest.read_text(), 'previous material')

    def test_topic_filename_uses_source_title_for_matching_slide_deck(self):
        folder = self.root / 'LAND2510E/text'; folder.mkdir(parents=True)
        slide = folder / 'LAND2510E_ELC_63257053.txt'
        slide.write_text('# LAND2510E — 02_ Western Asia to the Muslim conquest Lecture\nSlides')
        (folder / 'LAND2510E_ELC_999_transcript.txt').write_text('# LAND2510E — 02_Western Asia\nAudio')
        with patch.object(transcribe, 'ROOT', str(self.root)):
            self.assertEqual(transcribe.slide_text_for('LAND2510E', '02_Western Asia'), str(slide))
            self.assertIsNone(transcribe.slide_text_for('LAND2510E', '03_Islam'))

    def test_ambiguous_topic_slide_titles_do_not_prime_from_arbitrary_file(self):
        folder = self.root / 'LAND2510E/text'; folder.mkdir(parents=True)
        for topic in ('100', '101'):
            (folder / f'LAND2510E_ELC_{topic}.txt').write_text('# LAND2510E — 02_Western Asia\nSlides')
        with patch.object(transcribe, 'ROOT', str(self.root)):
            self.assertIsNone(transcribe.slide_text_for('LAND2510E', '02_Western Asia'))

    def test_glossary_preserves_inflected_ordinary_words_and_requires_dictionary(self):
        deck = ({'complex': 'Complex', 'ramesses': 'Ramesses', 'palace': 'Palace'}, set(), '/fake/slides')
        with patch.object(transcribe, 'deck_proper_nouns', return_value=deck), \
             patch.object(transcribe, '_english', return_value={'complete', 'place'}):
            text, fixes = transcribe.glossary_fix('It was completed by Ramses in several places.', 'LAND2510E', '10_Egypt', apply=True)
            self.assertEqual(text, 'It was completed by Ramesses in several places.')
            self.assertNotIn(('completed', 'Complex'), fixes)
            self.assertNotIn(('places', 'Palace'), fixes)
        with patch.object(transcribe, 'deck_proper_nouns', return_value=deck), \
             patch.object(transcribe, '_english', return_value=set()):
            self.assertEqual(transcribe.glossary_fix('completed Ramses', 'LAND2510E', '10_Egypt', apply=True), ('completed Ramses', []))

    def test_normal_pipeline_never_fuzzy_rewrites_a_valid_entity(self):
        original = 'They are native to Mongolia, China. Ramses appears later.'
        with patch.object(transcribe, 'deck_proper_nouns', side_effect=AssertionError('no automatic fuzzy repair')):
            self.assertEqual(transcribe.glossary_fix(original, 'LAND2510E', '03_Islam'), (original, []))


if __name__ == '__main__': unittest.main()
