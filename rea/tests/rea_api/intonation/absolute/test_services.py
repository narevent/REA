"""Tests for the absolute domain's import services.

Chiefly: what happens the *second* time they run, which on a live server is
every time they run.  The chromatic base is the one row the whole absolute
library hangs off, with a PROTECT foreign key from every lesson, so replacing
it cannot work and must not be attempted.
"""

import json
from pathlib import Path

from django.test import TestCase

from rea.apps.rea_api.intonation.absolute.models import (
    Bar,
    ChromaticBase,
    Lesson,
    MusicEvent,
)
from rea.apps.rea_api.intonation.absolute.services.base_generation import (
    import_chromatic_base,
)
from rea.apps.rea_api.intonation.absolute.services.lesson_generation import import_lesson

DATA_DIR = Path(__file__).resolve().parents[5] / "absolute"
BASE_FILE = "key_models/Base/Ap_12.json"
LESSON_FILE = (
    "lessons/mono/Formula/Octave/1_AF-8_1_part/"
    "1_part_ex-1_listening_model_AF-formula_8.json"
)


def _load(rel: str) -> dict:
    return json.loads((DATA_DIR / rel).read_text(encoding="utf-8"))


class ChromaticBaseImportTests(TestCase):
    def setUp(self):
        self.data = _load(BASE_FILE)
        self.base = import_chromatic_base(self.data, BASE_FILE)

    def test_import_builds_the_twelve_chromatic_bars(self):
        self.assertEqual(self.base.name, "Ap_12")
        self.assertEqual(self.base.bars.count(), 12)
        self.assertEqual(MusicEvent.objects.filter(bar__base=self.base).count(), 12)

    def test_reimport_over_an_empty_library(self):
        again = import_chromatic_base(self.data, BASE_FILE)
        self.assertEqual(ChromaticBase.objects.count(), 1)
        self.assertEqual(again.pk, self.base.pk, "the base is updated, not replaced")
        self.assertEqual(again.bars.count(), 12, "its bars are replaced, not doubled")

    def test_reimport_over_a_library_that_has_lessons(self):
        """The one that failed on every redeploy.

        Deleting the base raises `ProtectedError` the moment a single lesson
        points at it, which on a live server is always — so the import step
        reported errors and the base was never refreshed.
        """
        lesson = import_lesson(_load(LESSON_FILE), LESSON_FILE)
        self.assertIsNotNone(lesson)
        again = import_chromatic_base(self.data, BASE_FILE)
        self.assertEqual(again.pk, self.base.pk)
        self.assertTrue(Lesson.objects.filter(pk=lesson.pk).exists())
        self.assertEqual(Bar.objects.filter(base=again).count(), 12)

    def test_reimport_updates_what_the_file_says(self):
        changed = dict(self.data, tempo=9)
        again = import_chromatic_base(changed, BASE_FILE)
        self.assertEqual(again.tempo, 9)


class AbsoluteLessonReimportTests(TestCase):
    def setUp(self):
        import_chromatic_base(_load(BASE_FILE), BASE_FILE)
        self.data = _load(LESSON_FILE)
        self.lesson = import_lesson(self.data, LESSON_FILE)

    def test_a_teachers_dictation_survives(self):
        dictation = Lesson.objects.create(
            base=ChromaticBase.objects.get(),
            texture=self.lesson.texture,
            category=self.lesson.category,
            span=self.lesson.span,
            grades=self.lesson.grades,
            quality=self.lesson.quality,
            interval_size=self.lesson.interval_size,
            inversion=self.lesson.inversion,
            part=self.lesson.part,
            phase=self.lesson.phase,
            exercise_number=self.lesson.exercise_number,
            shelf=Lesson.Shelf.DICTATION,
        )
        import_lesson(self.data, LESSON_FILE)
        self.assertTrue(Lesson.objects.filter(pk=dictation.pk).exists())

    def test_the_curriculum_copy_is_refreshed_rather_than_duplicated(self):
        import_lesson(self.data, LESSON_FILE)
        self.assertEqual(
            Lesson.objects.filter(shelf=Lesson.Shelf.CURRICULUM).count(), 1
        )
