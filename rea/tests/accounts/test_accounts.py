"""Tests for user accounts: roles, auth pages, progress tracking and permissions."""

from django.contrib.auth.models import User
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from rea.apps.accounts import progress as progress_calc
from rea.apps.accounts.models import PracticeSession, Profile, Role
from rea.apps.accounts.permissions import is_student, is_teacher


def make_user(username="sam", role=Role.STUDENT, **kwargs):
    user = User.objects.create_user(username=username, password="practice-pass-123", **kwargs)
    user.profile.role = role
    user.profile.save()
    return user


class ProfileTests(TestCase):
    def test_profile_created_for_every_user(self):
        user = User.objects.create_user(username="new", password="x")
        self.assertIsInstance(user.profile, Profile)
        self.assertEqual(user.profile.role, Role.STUDENT, "students are the default role")

    def test_profile_survives_repeated_saves(self):
        user = User.objects.create_user(username="new", password="x")
        user.save()
        self.assertEqual(Profile.objects.filter(user=user).count(), 1)

    def test_name_prefers_display_name(self):
        user = make_user()
        self.assertEqual(user.profile.name, "sam")
        user.profile.display_name = "Sam Rivers"
        self.assertEqual(user.profile.name, "Sam Rivers")


class SignupTests(TestCase):
    def test_signup_creates_student_and_signs_in(self):
        response = self.client.post(reverse("accounts:signup"), {
            "username": "student1",
            "password1": "practice-pass-123",
            "password2": "practice-pass-123",
            "role": Role.STUDENT,
        })
        self.assertRedirects(response, reverse("accounts:dashboard"))
        user = User.objects.get(username="student1")
        self.assertEqual(user.profile.role, Role.STUDENT)
        self.assertEqual(int(self.client.session["_auth_user_id"]), user.pk)

    def test_signup_can_choose_teacher(self):
        self.client.post(reverse("accounts:signup"), {
            "username": "teacher1",
            "password1": "practice-pass-123",
            "password2": "practice-pass-123",
            "role": Role.TEACHER,
            "display_name": "Ms Kovacs",
        })
        profile = User.objects.get(username="teacher1").profile
        self.assertEqual(profile.role, Role.TEACHER)
        self.assertEqual(profile.display_name, "Ms Kovacs")

    @override_settings(REA_ALLOW_TEACHER_SELF_SIGNUP=False)
    def test_teacher_role_cannot_be_forced_when_self_signup_is_off(self):
        """A hidden field is a suggestion; the server decides."""
        self.client.post(reverse("accounts:signup"), {
            "username": "sneaky",
            "password1": "practice-pass-123",
            "password2": "practice-pass-123",
            "role": Role.TEACHER,
        })
        self.assertEqual(User.objects.get(username="sneaky").profile.role, Role.STUDENT)

    def test_signup_rejects_mismatched_passwords(self):
        response = self.client.post(reverse("accounts:signup"), {
            "username": "nope",
            "password1": "practice-pass-123",
            "password2": "different-pass-123",
            "role": Role.STUDENT,
        })
        self.assertEqual(response.status_code, 200)
        self.assertFalse(User.objects.filter(username="nope").exists())


class AuthPageTests(TestCase):
    def test_login_page_renders(self):
        response = self.client.get(reverse("accounts:login"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Sign in")

    def test_login_signs_user_in(self):
        make_user(username="sam")
        response = self.client.post(reverse("accounts:login"), {
            "username": "sam", "password": "practice-pass-123",
        })
        self.assertRedirects(response, reverse("accounts:dashboard"))

    def test_logout_requires_post(self):
        make_user()
        self.client.login(username="sam", password="practice-pass-123")
        self.assertEqual(self.client.get(reverse("accounts:logout")).status_code, 405)
        self.client.post(reverse("accounts:logout"))
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_dashboard_requires_login(self):
        response = self.client.get(reverse("accounts:dashboard"))
        self.assertEqual(response.status_code, 302)
        self.assertIn(reverse("accounts:login"), response["Location"])


class DashboardTests(TestCase):
    def test_student_dashboard_shows_progress(self):
        user = make_user()
        PracticeSession.objects.create(
            user=user, chapter_id=2, chapter_key="sing_repeat",
            chapter_title="Singing with repetition", score=88,
        )
        self.client.login(username="sam", password="practice-pass-123")
        response = self.client.get(reverse("accounts:dashboard"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Singing with repetition")
        self.assertContains(response, "88")
        self.assertEqual(response.context["overview"]["total_sessions"], 1)

    def test_student_dashboard_empty_state(self):
        make_user()
        self.client.login(username="sam", password="practice-pass-123")
        response = self.client.get(reverse("accounts:dashboard"))
        self.assertContains(response, "No sessions recorded yet")

    def test_teacher_dashboard_shows_editor_placeholder_not_progress(self):
        make_user(username="tess", role=Role.TEACHER)
        self.client.login(username="tess", password="practice-pass-123")
        response = self.client.get(reverse("accounts:dashboard"))
        self.assertTrue(response.context["is_teacher"])
        self.assertNotIn("overview", response.context)
        self.assertContains(response, "score editor isn't built yet")

    def test_display_name_can_be_updated(self):
        make_user()
        self.client.login(username="sam", password="practice-pass-123")
        self.client.post(reverse("accounts:profile-update"), {"display_name": "Sam R"})
        self.assertEqual(User.objects.get(username="sam").profile.display_name, "Sam R")


class SessionApiTests(TestCase):
    def test_anonymous_cannot_record(self):
        response = self.client.post(
            reverse("accounts-sessions"),
            {"chapter_id": 2, "chapter_key": "sing_repeat", "score": 70},
            content_type="application/json",
        )
        self.assertIn(response.status_code, (401, 403))
        self.assertEqual(PracticeSession.objects.count(), 0)

    def test_signed_in_user_can_record(self):
        make_user()
        self.client.login(username="sam", password="practice-pass-123")
        response = self.client.post(
            reverse("accounts-sessions"),
            {
                "chapter_id": 2, "chapter_key": "sing_repeat",
                "chapter_title": "Singing with repetition", "score": 91,
                "rounds": 9, "system": "relative", "texture": "mono",
                "key_name": "C-dur", "formula": "Octave",
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 201)
        session = PracticeSession.objects.get()
        self.assertEqual(session.user.username, "sam")
        self.assertEqual(session.score, 91)
        self.assertEqual(session.key_name, "C-dur")

    def test_session_is_attributed_to_the_signed_in_user_not_the_payload(self):
        make_user(username="sam")
        victim = make_user(username="victim")
        self.client.login(username="sam", password="practice-pass-123")
        self.client.post(
            reverse("accounts-sessions"),
            {"chapter_id": 1, "chapter_key": "listen", "score": 50, "user": victim.pk},
            content_type="application/json",
        )
        self.assertEqual(PracticeSession.objects.get().user.username, "sam")

    def test_out_of_range_values_are_rejected(self):
        make_user()
        self.client.login(username="sam", password="practice-pass-123")
        for payload in (
            {"chapter_id": 2, "chapter_key": "x", "score": 101},
            {"chapter_id": 99, "chapter_key": "x", "score": 50},
        ):
            response = self.client.post(
                reverse("accounts-sessions"), payload, content_type="application/json",
            )
            self.assertEqual(response.status_code, 400, payload)
        self.assertEqual(PracticeSession.objects.count(), 0)

    def test_me_reports_anonymous_without_erroring(self):
        response = self.client.get(reverse("accounts-me"))
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["authenticated"])

    def test_me_reports_role_and_progress(self):
        user = make_user()
        PracticeSession.objects.create(user=user, chapter_id=3, chapter_key="guess", score=80)
        self.client.login(username="sam", password="practice-pass-123")
        data = self.client.get(reverse("accounts-me")).json()
        self.assertTrue(data["authenticated"])
        self.assertEqual(data["role"], Role.STUDENT)
        self.assertFalse(data["is_teacher"])
        self.assertEqual(data["progress"]["total_sessions"], 1)

    def test_me_omits_progress_for_teachers(self):
        make_user(username="tess", role=Role.TEACHER)
        self.client.login(username="tess", password="practice-pass-123")
        data = self.client.get(reverse("accounts-me")).json()
        self.assertTrue(data["is_teacher"])
        self.assertNotIn("progress", data)


class ProgressCalcTests(TestCase):
    def setUp(self):
        self.user = make_user()

    def record(self, score, chapter_id=2, days_ago=0):
        session = PracticeSession.objects.create(
            user=self.user, chapter_id=chapter_id, chapter_key="sing_repeat", score=score,
        )
        if days_ago:
            PracticeSession.objects.filter(pk=session.pk).update(
                created_at=timezone.now() - timezone.timedelta(days=days_ago)
            )
        return session

    def test_overview_aggregates(self):
        self.record(60)
        self.record(90)
        overview = progress_calc.overview(self.user)
        self.assertEqual(overview["total_sessions"], 2)
        self.assertEqual(overview["average_score"], 75)
        self.assertEqual(overview["best_score"], 90)
        self.assertEqual(overview["chapters_completed"], 1, "best of 90 passes chapter 2")

    def test_chapter_breakdown_lists_every_chapter(self):
        self.record(80, chapter_id=1)
        chapters = progress_calc.chapter_breakdown(self.user)
        self.assertEqual(len(chapters), 10)
        self.assertEqual(chapters[0]["attempts"], 1)
        self.assertTrue(chapters[0]["completed"])
        self.assertEqual(chapters[1]["attempts"], 0)
        self.assertIsNone(chapters[1]["best"])

    def test_trend_includes_days_without_practice_as_gaps(self):
        self.record(80, days_ago=2)
        trend = progress_calc.daily_trend(self.user, days=5)
        self.assertEqual(len(trend), 5)
        self.assertEqual([d["score"] for d in trend], [None, None, 80, None, None])

    def test_streak_counts_consecutive_days(self):
        self.record(80, days_ago=0)
        self.record(80, days_ago=1)
        self.record(80, days_ago=2)
        self.record(80, days_ago=9)
        self.assertEqual(progress_calc.practice_streak_days(self.user), 3)

    def test_streak_is_zero_without_practice(self):
        self.assertEqual(progress_calc.practice_streak_days(self.user), 0)

    def test_trend_polyline_needs_two_points(self):
        self.record(80)
        trend = progress_calc.daily_trend(self.user, days=5)
        self.assertEqual(progress_calc.trend_polyline(trend), "")
        self.record(60, days_ago=1)
        trend = progress_calc.daily_trend(self.user, days=5)
        self.assertNotEqual(progress_calc.trend_polyline(trend), "")

    def test_sessions_are_scoped_per_user(self):
        other = make_user(username="other")
        PracticeSession.objects.create(user=other, chapter_id=2, chapter_key="x", score=100)
        self.record(50)
        self.assertEqual(progress_calc.overview(self.user)["total_sessions"], 1)
        self.assertEqual(progress_calc.overview(self.user)["best_score"], 50)


class PermissionTests(TestCase):
    def test_role_helpers(self):
        student = make_user(username="stu")
        teacher = make_user(username="tea", role=Role.TEACHER)
        self.assertTrue(is_student(student))
        self.assertFalse(is_teacher(student))
        self.assertTrue(is_teacher(teacher))

    def test_staff_count_as_teachers(self):
        admin = make_user(username="admin", is_staff=True)
        self.assertTrue(is_teacher(admin), "an admin should never be locked out of authoring")

    def test_anonymous_is_neither(self):
        from django.contrib.auth.models import AnonymousUser
        self.assertFalse(is_teacher(AnonymousUser()))
        self.assertFalse(is_student(AnonymousUser()))
