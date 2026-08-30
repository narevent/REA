"""Tests for the teacher-only score editing API.

These endpoints are the first writers the lesson tables have ever had, so the
tests care most about the two things a bad write would quietly break: who is
allowed through, and whether a saved score still says what it sounded like.
"""

import json

from django.contrib.auth.models import User
from django.test import TestCase
from django.urls import reverse

from rea.apps.accounts.models import Role
from rea.apps.rea_api.intonation.absolute.models import ChromaticBase, Lesson as AbsoluteLesson
from rea.apps.rea_api.intonation.relative.models import (
    KeyModel,
    Lesson as RelativeLesson,
    ScaleModel,
)


def make_user(username, role=Role.STUDENT, **kwargs):
    user = User.objects.create_user(username=username, password="practice-pass-123", **kwargs)
    user.profile.role = role
    user.profile.save()
    return user


G_MAJOR_SIGNATURE = [{"name": "f2#", "letter": "f", "offset": 1}]


class EditorTestCase(TestCase):
    """A key, a chromatic base and a teacher — the minimum to author anything."""

    def setUp(self):
        self.scale = ScaleModel.objects.create(mode="Major", reference_key="C_Major")
        self.key = KeyModel.objects.create(
            scale_model=self.scale, name="G-dur", mode="Major",
            root_pitch_class=7, key_signature=G_MAJOR_SIGNATURE,
        )
        self.other_key = KeyModel.objects.create(
            scale_model=self.scale, name="C-dur", mode="Major",
            root_pitch_class=0, key_signature=[],
        )
        self.base = ChromaticBase.objects.create(name="Ap_12")
        self.teacher = make_user("kovacs", Role.TEACHER)
        self.student = make_user("sam", Role.STUDENT)

    def sign_in(self, user):
        self.client.force_login(user)

    def post(self, url, payload):
        return self.client.post(url, data=json.dumps(payload), content_type="application/json")

    def put(self, url, payload):
        return self.client.put(url, data=json.dumps(payload), content_type="application/json")

    def relative_payload(self, **overrides):
        meta = {
            "texture": "mono", "formula_name": "Octave", "category": "",
            "inversion": "", "interval_name": "", "part": "", "variant": "TEST",
            "source_file": "", "tempo": 86, "draw_only_note_heads": False,
            "default_rhythm": "FreeStyle", "mid_bar_time": 0.1,
        }
        meta.update(overrides.pop("meta", {}))
        payload = {
            "key_model": self.key.pk,
            "meta": meta,
            "bars": [{
                "music_clef": "Violin", "music_rhythm": "FreeStyle",
                "music_mode_chord": "G_Major", "label": "I",
                "degree": "1", "quality": "natural",
                "events": [
                    {"note_name": "g1", "alias_degree": "1", "duration": 0.125, "volume": 80},
                    {"note_name": "f2", "alias_degree": "7", "duration": 0.125, "volume": 75,
                     "horizontal_offset_ms": -4, "is_enharmonic": True},
                ],
            }],
        }
        payload.update(overrides)
        return payload


class PermissionTests(EditorTestCase):
    def test_anonymous_cannot_read_the_editor_api(self):
        response = self.client.get(reverse("editor-options"))
        self.assertIn(response.status_code, (401, 403))

    def test_student_cannot_reach_the_editor_api(self):
        self.sign_in(self.student)
        self.assertEqual(self.client.get(reverse("editor-options")).status_code, 403)

    def test_student_cannot_create_an_exercise(self):
        self.sign_in(self.student)
        response = self.post(
            reverse("editor-create", args=["relative"]), self.relative_payload()
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(RelativeLesson.objects.count(), 0)

    def test_teacher_can(self):
        self.sign_in(self.teacher)
        self.assertEqual(self.client.get(reverse("editor-options")).status_code, 200)

    def test_staff_count_as_teachers(self):
        admin = make_user("admin", Role.STUDENT, is_staff=True)
        self.sign_in(admin)
        self.assertEqual(self.client.get(reverse("editor-options")).status_code, 200)

    def test_editor_page_is_refused_to_students(self):
        self.sign_in(self.student)
        self.assertEqual(self.client.get(reverse("rea_frontend:editor")).status_code, 403)

    def test_editor_page_opens_for_teachers(self):
        self.sign_in(self.teacher)
        response = self.client.get(reverse("rea_frontend:editor"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "ed-canvas")


class BlankScoreTests(EditorTestCase):
    def setUp(self):
        super().setUp()
        self.sign_in(self.teacher)

    def test_relative_blank_carries_the_key_and_one_empty_bar(self):
        response = self.client.get(
            reverse("editor-blank", args=["relative"]), {"key_model": self.key.pk}
        )
        self.assertEqual(response.status_code, 200)
        document = response.json()
        self.assertEqual(document["key_model"], self.key.pk)
        self.assertEqual(document["key_signature"], G_MAJOR_SIGNATURE)
        self.assertEqual(len(document["bars"]), 1)
        self.assertEqual(document["bars"][0]["events"], [])
        self.assertEqual(
            document["bars"][0]["music_mode_chord"], "G_Major",
            "a new bar has to name its key, or the stave draws no key signature",
        )

    def test_absolute_blank_has_no_key(self):
        document = self.client.get(reverse("editor-blank", args=["absolute"])).json()
        self.assertEqual(document["key_signature"], [])
        self.assertEqual(document["meta"]["exercise_type"], "listening_model")

    def test_unknown_system_is_refused(self):
        self.assertEqual(
            self.client.get(reverse("editor-blank", args=["sideways"])).status_code, 400
        )


class CreateAndSaveTests(EditorTestCase):
    def setUp(self):
        super().setUp()
        self.sign_in(self.teacher)

    def test_create_stores_bars_and_events(self):
        response = self.post(reverse("editor-create", args=["relative"]), self.relative_payload())
        self.assertEqual(response.status_code, 201, response.content)
        lesson = RelativeLesson.objects.get()
        self.assertEqual(lesson.variant, "TEST")
        self.assertEqual(lesson.bars.count(), 1)
        self.assertEqual(lesson.bars.get().events.count(), 2)

    def test_pitch_class_is_resolved_against_the_key(self):
        self.post(reverse("editor-create", args=["relative"]), self.relative_payload())
        events = list(RelativeLesson.objects.get().bars.get().events.all())
        self.assertEqual(events[0].pitch_class, 7, "g is G")
        self.assertEqual(
            events[1].pitch_class, 6,
            "an unaltered f in G major sounds F#, whichever way the client stored it",
        )

    def test_indices_come_from_document_order(self):
        payload = self.relative_payload()
        payload["bars"].append({
            "music_clef": "Violin", "music_rhythm": "FreeStyle",
            "music_mode_chord": "G_Major",
            "events": [{"note_name": "d1", "duration": 0.25}],
        })
        self.post(reverse("editor-create", args=["relative"]), payload)
        lesson = RelativeLesson.objects.get()
        self.assertEqual([b.bar_index for b in lesson.bars.all()], [0, 1])
        self.assertEqual([e.event_index for e in lesson.bars.first().events.all()], [0, 1])

    def test_save_replaces_the_score(self):
        created = self.post(
            reverse("editor-create", args=["relative"]), self.relative_payload()
        ).json()
        payload = self.relative_payload()
        payload["bars"][0]["events"] = [{"note_name": "a1", "duration": 0.25, "volume": 90}]
        response = self.put(
            reverse("editor-detail", args=["relative", created["id"]]), payload
        )
        self.assertEqual(response.status_code, 200, response.content)
        lesson = RelativeLesson.objects.get(pk=created["id"])
        self.assertEqual(lesson.bars.get().events.count(), 1)
        self.assertEqual(lesson.bars.get().events.get().note_name, "a1")

    def test_round_trip_keeps_every_note_property(self):
        created = self.post(
            reverse("editor-create", args=["relative"]), self.relative_payload()
        ).json()
        loaded = self.client.get(
            reverse("editor-detail", args=["relative", created["id"]])
        ).json()
        note = loaded["bars"][0]["events"][1]
        self.assertEqual(note["horizontal_offset_ms"], -4)
        self.assertTrue(note["is_enharmonic"])
        self.assertEqual(note["alias_degree"], "7")
        self.assertEqual(note["volume"], 75)

    def test_rest_loses_its_pitch(self):
        payload = self.relative_payload()
        payload["bars"][0]["events"] = [
            {"note_name": "g1", "duration": 0.125, "is_rest": True},
        ]
        self.post(reverse("editor-create", args=["relative"]), payload)
        event = RelativeLesson.objects.get().bars.get().events.get()
        self.assertTrue(event.is_rest)
        self.assertEqual(event.note_name, "")
        self.assertEqual(event.pitch_class, -1)

    def test_duplicate_identity_is_refused_with_an_explanation(self):
        self.post(reverse("editor-create", args=["relative"]), self.relative_payload())
        response = self.post(reverse("editor-create", args=["relative"]), self.relative_payload())
        self.assertEqual(response.status_code, 409)
        self.assertIn("variant", response.json()["detail"])

    def test_absolute_exercise_needs_no_key(self):
        payload = {
            "meta": {
                "texture": "mono", "category": "Formula", "span": "Quinta",
                "grades": "", "quality": "", "interval_size": "", "inversion": "",
                "part": "1", "phase": 0, "exercise_number": 1,
                "exercise_type": "listening_model", "timed": False,
                "chromatic": False, "source_file": "", "tempo": 86,
                "draw_only_note_heads": False, "default_rhythm": "FreeStyle",
                "mid_bar_time": 0.1,
            },
            "bars": [{"events": [{"note_name": "f1", "duration": 0.125}]}],
        }
        response = self.post(reverse("editor-create", args=["absolute"]), payload)
        self.assertEqual(response.status_code, 201, response.content)
        event = AbsoluteLesson.objects.get().bars.get().events.get()
        self.assertEqual(event.pitch_class, 5, "absolute notes have no key to inherit from")


class ValidationTests(EditorTestCase):
    def setUp(self):
        super().setUp()
        self.sign_in(self.teacher)

    def test_unreadable_note_is_refused(self):
        payload = self.relative_payload()
        payload["bars"][0]["events"] = [{"note_name": "q9", "duration": 0.125}]
        response = self.post(reverse("editor-create", args=["relative"]), payload)
        self.assertEqual(response.status_code, 400)
        self.assertIn("German letter", json.dumps(response.json()))
        self.assertEqual(RelativeLesson.objects.count(), 0)

    def test_undrawable_duration_is_refused(self):
        payload = self.relative_payload()
        payload["bars"][0]["events"] = [{"note_name": "c1", "duration": 0.3}]
        self.assertEqual(
            self.post(reverse("editor-create", args=["relative"]), payload).status_code, 400
        )

    def test_a_score_needs_a_bar(self):
        payload = self.relative_payload()
        payload["bars"] = []
        self.assertEqual(
            self.post(reverse("editor-create", args=["relative"]), payload).status_code, 400
        )

    def test_offset_beyond_the_useful_range_is_refused(self):
        payload = self.relative_payload()
        payload["bars"][0]["events"][0]["horizontal_offset_ms"] = 5000
        self.assertEqual(
            self.post(reverse("editor-create", args=["relative"]), payload).status_code, 400
        )

    def test_a_failed_save_leaves_the_stored_score_alone(self):
        created = self.post(
            reverse("editor-create", args=["relative"]), self.relative_payload()
        ).json()
        broken = self.relative_payload()
        broken["bars"][0]["events"] = [{"note_name": "zz", "duration": 0.125}]
        self.put(reverse("editor-detail", args=["relative", created["id"]]), broken)
        lesson = RelativeLesson.objects.get(pk=created["id"])
        self.assertEqual(lesson.bars.get().events.count(), 2, "the old notes survive a refused save")


class BrowseAndCopyTests(EditorTestCase):
    def setUp(self):
        super().setUp()
        self.sign_in(self.teacher)
        self.created = self.post(
            reverse("editor-create", args=["relative"]), self.relative_payload()
        ).json()

    def test_browse_lists_the_exercise_with_its_bar_count(self):
        data = self.client.get(reverse("editor-browse"), {"system": "relative"}).json()
        self.assertEqual(data["count"], 1)
        self.assertEqual(data["results"][0]["bars"], 1)

    def test_browse_narrows_by_search(self):
        data = self.client.get(
            reverse("editor-browse"), {"system": "relative", "search": "nothing-like-this"}
        ).json()
        self.assertEqual(data["count"], 0)

    def test_duplicate_copies_the_notes_under_a_free_variant(self):
        response = self.post(
            reverse("editor-duplicate", args=["relative", self.created["id"]]), {}
        )
        self.assertEqual(response.status_code, 201, response.content)
        copy = response.json()
        self.assertNotEqual(copy["id"], self.created["id"])
        self.assertNotEqual(copy["meta"]["variant"], "TEST")
        self.assertEqual(len(copy["bars"][0]["events"]), 2)
        self.assertEqual(RelativeLesson.objects.count(), 2)

    def test_delete_removes_the_exercise_and_its_notes(self):
        response = self.client.delete(
            reverse("editor-detail", args=["relative", self.created["id"]])
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(RelativeLesson.objects.count(), 0)

    def test_changing_the_key_is_saved(self):
        payload = self.relative_payload()
        payload["key_model"] = self.other_key.pk
        payload["bars"][0]["music_mode_chord"] = "C_Major"
        self.put(reverse("editor-detail", args=["relative", self.created["id"]]), payload)
        lesson = RelativeLesson.objects.get(pk=self.created["id"])
        self.assertEqual(lesson.key_model, self.other_key)
        self.assertEqual(
            lesson.bars.get().events.all()[1].pitch_class, 5,
            "the same written f is F natural once the exercise is in C major",
        )
