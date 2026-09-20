"""Tests for the key-generation & lesson-generation services."""

import json
from pathlib import Path

from django.test import TestCase

from rea.apps.rea_api.intonation.relative.models import (
    Bar,
    Lesson,
    KeyModel,
    MusicEvent,
    ScaleModel,
)
from rea.apps.rea_api.intonation.relative.services.lesson_generation import (
    generate_lesson_for_key,
    import_lesson,
)
from rea.apps.rea_api.intonation.relative.services.key_generation import import_key_model

DATA_DIR = Path(__file__).resolve().parents[5] / "relative"


def _load(rel: str) -> dict:
    return json.loads((DATA_DIR / rel).read_text(encoding="utf-8"))


class KeyModelImportTests(TestCase):
    def test_import_c_dur(self):
        data = _load("key_models/Major/C-dur_8.json")
        km = import_key_model(data, "C-dur_8.json")
        self.assertEqual(km.name, "C-dur")
        self.assertEqual(km.mode, "Major")
        self.assertEqual(km.root_pitch_class, 0)
        self.assertEqual(km.bars.count(), 7)
        # Each bar has exactly one event (scale template).
        self.assertEqual(MusicEvent.objects.filter(bar__key_model=km).count(), 7)
        # First note is c1 (degree 1) -> pitch class 0.
        first = MusicEvent.objects.filter(bar__key_model=km).order_by("bar__bar_index")[0]
        self.assertEqual(first.note_name, "c1")
        self.assertEqual(first.alias_degree, "1")
        self.assertEqual(first.pitch_class, 0)

    def test_import_g_dur_inherits_key_signature(self):
        data = _load("key_models/Major/G-dur_8.json")
        km = import_key_model(data, "G-dur_8.json")
        # Key signature normalised to one f# entry.
        self.assertTrue(any(k["letter"] == "f" and k["offset"] == 1 for k in km.key_signature))
        # The f1 note (enharmonic) should resolve to F# = pc 6.
        f_ev = MusicEvent.objects.get(bar__key_model=km, note_name="f1")
        self.assertEqual(f_ev.pitch_class, 6)

    def test_minor_has_raised_variants(self):
        data = _load("key_models/Minor/A-mol_8.json")
        km = import_key_model(data, "A-mol_8.json")
        # A-mol has 9 bars: 7 natural + raised 6 (f1#) + raised 7 (g1#).
        self.assertEqual(km.bars.count(), 9)
        raised = MusicEvent.objects.filter(bar__key_model=km, is_enharmonic=False)
        self.assertGreaterEqual(raised.count(), 2)

    def test_idempotent_reimport(self):
        data = _load("key_models/Major/C-dur_8.json")
        import_key_model(data, "C-dur_8.json")
        import_key_model(data, "C-dur_8.json")  # clear=True by default
        self.assertEqual(KeyModel.objects.filter(name="C-dur").count(), 1)
        self.assertEqual(Bar.objects.filter(key_model__name="C-dur").count(), 7)


class LessonImportTests(TestCase):
    def setUp(self):
        # Lessons require the key model to exist.
        import_key_model(_load("key_models/Major/C-dur_8.json"), "C-dur_8.json")
        import_key_model(_load("key_models/Major/G-dur_8.json"), "G-dur_8.json")

    def test_import_octave_lesson(self):
        rel = "lessons/mono/Major/Octave/CMajor/1_ C-dur formula 8/1_1_1_C-dur_formula_8.json"
        data = _load(rel)
        ex = import_lesson(data, rel)
        self.assertIsNotNone(ex)
        self.assertEqual(ex.formula_name, "Octave")
        self.assertEqual(ex.key_model.name, "C-dur")
        self.assertGreater(ex.bars.count(), 0)
        # Events carry degree aliases.
        self.assertTrue(
            MusicEvent.objects.filter(bar__lesson=ex).exclude(alias_degree="").exists()
        )

    def test_import_skala_variant(self):
        rel = "lessons/mono/Major/Octave/CMajor/1_ C-dur formula 8/1_1_3_ C-dur formula SKALA 8.json"
        data = _load(rel)
        ex = import_lesson(data, rel)
        self.assertEqual(ex.variant, "SKALA")

    def test_lesson_without_key_returns_none(self):
        rel = "lessons/mono/Major/Octave/CMajor/1_ C-dur formula 8/1_1_1_C-dur_formula_8.json"
        KeyModel.objects.filter(name="C-dur").delete()
        data = _load(rel)
        self.assertIsNone(import_lesson(data, rel))


class LessonRegenerationTests(TestCase):
    def setUp(self):
        import_key_model(_load("key_models/Major/C-dur_8.json"), "C-dur_8.json")
        import_key_model(_load("key_models/Major/G-dur_8.json"), "G-dur_8.json")
        rel = "lessons/mono/Major/Octave/CMajor/1_ C-dur formula 8/1_1_1_C-dur_formula_8.json"
        self.source = import_lesson(_load(rel), rel)

    def test_regenerate_to_other_key(self):
        g = KeyModel.objects.get(name="G-dur")
        new_ex = generate_lesson_for_key(self.source, g)
        self.assertEqual(new_ex.key_model.name, "G-dur")
        self.assertEqual(new_ex.formula_name, self.source.formula_name)
        self.assertEqual(new_ex.bars.count(), self.source.bars.count())
        # Total event count preserved.
        self.assertEqual(
            MusicEvent.objects.filter(bar__lesson=new_ex).count(),
            MusicEvent.objects.filter(bar__lesson=self.source).count(),
        )
        # The regenerated lesson for G-dur should not be identical note-for-note
        # to the C-dur source (it was transposed).
        src_names = list(
            MusicEvent.objects.filter(bar__lesson=self.source)
            .order_by("bar__bar_index", "event_index")
            .values_list("note_name", flat=True)
        )
        new_names = list(
            MusicEvent.objects.filter(bar__lesson=new_ex)
            .order_by("bar__bar_index", "event_index")
            .values_list("note_name", flat=True)
        )
        self.assertNotEqual(src_names, new_names)

class ReimportTests(TestCase):
    """What a second import must not destroy.

    Every deploy re-imports the whole library over the live database, so
    "import" is really "import again" — and until the editor existed, the only
    thing in these tables was the shipped JSON, so rebuilding them from
    scratch was harmless.  It is not harmless now: a teacher's drafts, their
    dictations and their edits live in the same tables and exist in no file.
    """

    def setUp(self):
        self.key_data = _load("key_models/Major/C-dur_8.json")
        import_key_model(self.key_data, "C-dur_8.json")
        self.lesson_path = (
            "lessons/mono/Major/Octave/CMajor/1_ C-dur formula 8/"
            "1_1_1_C-dur_formula_8.json"
        )
        self.lesson_data = _load(self.lesson_path)
        self.lesson = import_lesson(self.lesson_data, self.lesson_path)

    def test_reimporting_a_key_keeps_the_lessons_built_on_it(self):
        """The key used to be deleted and recreated, and every lesson on it
        cascaded away with it — the first step of every deploy, emptying the
        relative library."""
        before = Lesson.objects.count()
        self.assertGreater(before, 0)
        import_key_model(self.key_data, "C-dur_8.json")
        self.assertEqual(Lesson.objects.count(), before)
        self.assertTrue(Lesson.objects.filter(pk=self.lesson.pk).exists())

    def test_reimporting_a_key_replaces_only_its_own_bars(self):
        import_key_model(self.key_data, "C-dur_8.json")
        key = KeyModel.objects.get(name="C-dur")
        self.assertEqual(KeyModel.objects.filter(name="C-dur").count(), 1)
        self.assertEqual(key.bars.count(), 7)

    def test_a_teachers_draft_survives_the_reimport(self):
        draft = Lesson.objects.create(
            key_model=KeyModel.objects.get(name="C-dur"),
            formula_name=self.lesson.formula_name,
            variant=self.lesson.variant,
            shelf=Lesson.Shelf.DRAFT,
        )
        dictation = Lesson.objects.create(
            key_model=KeyModel.objects.get(name="C-dur"),
            formula_name=self.lesson.formula_name,
            variant=self.lesson.variant,
            shelf=Lesson.Shelf.DICTATION,
        )
        import_key_model(self.key_data, "C-dur_8.json")
        import_lesson(self.lesson_data, self.lesson_path)
        self.assertTrue(Lesson.objects.filter(pk=draft.pk).exists())
        self.assertTrue(Lesson.objects.filter(pk=dictation.pk).exists())

    def test_the_curriculum_copy_is_still_replaced(self):
        """The shipped exercise is what a re-import owns, and it is refreshed
        rather than duplicated."""
        import_lesson(self.lesson_data, self.lesson_path)
        self.assertEqual(
            Lesson.objects.filter(
                formula_name=self.lesson.formula_name,
                variant=self.lesson.variant,
                shelf=Lesson.Shelf.CURRICULUM,
            ).count(),
            1,
        )
