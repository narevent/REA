"""The dictation API: who may read, write and change a dictation."""

import json

from django.contrib.auth.models import User
from django.test import TestCase

from rea.apps.accounts.models import Role
from rea.apps.dictation.models import Dictation

URL = "/api/dictation-scores/"


def make_user(username, role):
    user = User.objects.create_user(username=username, password="x")
    user.profile.role = role
    user.profile.save()
    return user


def score():
    return {"version": 1, "parts": [{"id": "p1", "name": "Piano", "staves": [{"clef": "treble"}]}],
            "measures": [{"time": [4, 4], "staves": {}}]}


class DictationApiTests(TestCase):
    def setUp(self):
        self.teacher = make_user("tess", Role.TEACHER)
        self.other = make_user("otto", Role.TEACHER)
        self.student = make_user("sam", Role.STUDENT)
        self.admin = make_user("ada", Role.ADMIN)

    def post(self, payload):
        return self.client.post(URL, data=json.dumps(payload), content_type="application/json")

    def put(self, pk, payload):
        return self.client.put(f"{URL}{pk}/", data=json.dumps(payload), content_type="application/json")

    def create(self, **extra):
        self.client.force_login(self.teacher)
        payload = {"title": "Bach chorale", "score": score(), "phrases": []}
        payload.update(extra)
        response = self.post(payload)
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()

    def test_a_teacher_writes_one_and_owns_it(self):
        created = self.create()
        self.assertEqual(Dictation.objects.get(pk=created["id"]).owner, self.teacher)
        self.assertEqual(created["score"]["parts"][0]["name"], "Piano")

    def test_a_student_cannot_write_one(self):
        self.client.force_login(self.student)
        self.assertEqual(self.post({"title": "x", "score": score()}).status_code, 403)

    def test_students_see_only_published_dictations(self):
        draft = self.create(title="Draft")
        published = self.create(title="Ready", published=True)
        self.client.force_login(self.student)
        titles = [d["title"] for d in self.client.get(URL).json()]
        self.assertEqual(titles, ["Ready"])
        self.assertEqual(self.client.get(f"{URL}{draft['id']}/").status_code, 404)
        self.assertEqual(self.client.get(f"{URL}{published['id']}/").status_code, 200)

    def test_another_teacher_may_read_published_but_not_change(self):
        published = self.create(published=True)
        self.client.force_login(self.other)
        self.assertEqual(self.client.get(f"{URL}{published['id']}/").status_code, 200)
        response = self.put(published["id"], {"title": "Mine now", "score": score(), "phrases": []})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.client.delete(f"{URL}{published['id']}/").status_code, 403)

    def test_an_admin_may_change_any(self):
        created = self.create()
        self.client.force_login(self.admin)
        response = self.put(created["id"], {"title": "Edited", "score": score(), "phrases": []})
        self.assertEqual(response.status_code, 200)

    def test_mine_lists_only_my_own(self):
        self.create(title="Mine")
        self.client.force_login(self.other)
        self.post({"title": "Theirs", "score": score(), "phrases": [], "published": True})
        self.client.force_login(self.teacher)
        self.assertEqual([d["title"] for d in self.client.get(URL + "?mine=1").json()], ["Mine"])

    def test_a_phrase_needs_a_start_and_an_end(self):
        self.client.force_login(self.teacher)
        response = self.post({"title": "x", "score": score(), "phrases": [{"name": "A", "start": "e1"}]})
        self.assertEqual(response.status_code, 400)

    def test_a_phrase_round_trips(self):
        phrases = [{"id": "ph1", "name": "Bars 1-4", "start": "e1", "end": "e9"}]
        created = self.create(phrases=phrases)
        self.assertEqual(self.client.get(f"{URL}{created['id']}/").json()["phrases"], phrases)

    def test_the_editor_page_is_for_teachers(self):
        self.client.force_login(self.student)
        self.assertEqual(self.client.get("/dictation-editor/").status_code, 403)
        self.client.force_login(self.teacher)
        self.assertEqual(self.client.get("/dictation-editor/").status_code, 200)
