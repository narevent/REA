"""Tests for the note-name parser utility (utils/note_parser.py)."""

from django.test import SimpleTestCase

from rea.apps.rea_api.intonation.relative.utils.note_parser import (
    LETTER_PC,
    note_name_to_vexflow,
    parse_note,
    resolve_pitch_class,
)


class ParseNoteTests(SimpleTestCase):
    def test_plain_letter(self):
        t = parse_note("c")
        self.assertEqual(t.letter, "c")
        self.assertIsNone(t.octave)
        self.assertIsNone(t.modifier)

    def test_letter_octave(self):
        t = parse_note("c1")
        self.assertEqual(t.letter, "c")
        self.assertEqual(t.octave, 1)
        self.assertIsNone(t.modifier)

    def test_sharp(self):
        t = parse_note("f2#")
        self.assertEqual(t.letter, "f")
        self.assertEqual(t.octave, 2)
        self.assertEqual(t.modifier, "#")
        self.assertEqual(t.modifier_offset, 1)

    def test_flat(self):
        t = parse_note("e2b")
        self.assertEqual(t.modifier, "b")
        self.assertEqual(t.modifier_offset, -1)

    def test_double_sharp(self):
        t = parse_note("f1x")
        self.assertEqual(t.modifier, "x")
        self.assertEqual(t.modifier_offset, 2)

    def test_raised_natural(self):
        t = parse_note("e1r")
        self.assertEqual(t.modifier, "r")
        self.assertTrue(t.is_raised)
        self.assertEqual(t.modifier_offset, 0)

    def test_german_h(self):
        t = parse_note("h1")
        self.assertEqual(t.letter, "h")
        self.assertIn("h", LETTER_PC)


class ResolvePitchClassTests(SimpleTestCase):
    def test_c_natural_no_signature(self):
        self.assertEqual(resolve_pitch_class(parse_note("c1")), 0)

    def test_f_inherits_sharp_from_key_signature(self):
        # G-dur: key signature has f# -> f1 should resolve to F# (pc 6).
        incdec = [{"name": "f2#"}]
        self.assertEqual(resolve_pitch_class(parse_note("f1"), incdec), 6)

    def test_explicit_flat_overrides_signature(self):
        incdec = [{"name": "f2#"}]
        # Explicit f1b -> F-flat = pc 4
        self.assertEqual(resolve_pitch_class(parse_note("f1b"), incdec), 4)

    def test_raised_cancels_flat_signature(self):
        # g-mol: key signature has e-flat, h-flat, a-flat...
        incdec = [{"name": "h1b"}, {"name": "e2b"}, {"name": "a1b"}]
        # e1 -> inherits Eb (pc 3)
        self.assertEqual(resolve_pitch_class(parse_note("e1"), incdec), 3)
        # e1r -> naturalised E (pc 4)
        self.assertEqual(resolve_pitch_class(parse_note("e1r"), incdec), 4)

    def test_double_sharp(self):
        # Ais-mol: f is already sharpened in key sig; f1x adds another.
        incdec = [{"name": "f2#"}]
        # f1x -> explicit double-sharp = F## = G (pc 7)
        self.assertEqual(resolve_pitch_class(parse_note("f1x"), incdec), 7)


class VexflowConversionTests(SimpleTestCase):
    def test_simple(self):
        self.assertEqual(note_name_to_vexflow(parse_note("c1")), "c/4")

    def test_german_h_to_b(self):
        self.assertEqual(note_name_to_vexflow(parse_note("h1")), "b/4")

    def test_sharp_and_octave(self):
        self.assertEqual(note_name_to_vexflow(parse_note("f2#")), "f#/5")

    def test_double_sharp(self):
        self.assertEqual(note_name_to_vexflow(parse_note("f1x")), "f##/4")

    def test_raised_no_accidental(self):
        self.assertEqual(note_name_to_vexflow(parse_note("e1r")), "e/4")