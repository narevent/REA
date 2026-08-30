"""Tests for the frontend app (template view)."""

from django.contrib.auth.models import User
from django.test import TestCase
from django.urls import reverse


class IndexViewTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user("student", password="pw-for-tests-1")

    def test_index_requires_login(self):
        response = self.client.get(reverse("rea_frontend:index"))
        self.assertRedirects(
            response,
            f"{reverse('accounts:login')}?next={reverse('rea_frontend:index')}",
        )

    def test_index_renders(self):
        self.client.force_login(self.user)
        response = self.client.get(reverse("rea_frontend:index"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "REA")
        self.assertContains(response, "REA — Intonation")

    def test_index_references_static(self):
        self.client.force_login(self.user)
        response = self.client.get(reverse("rea_frontend:index"))
        self.assertContains(response, "main.css")
        self.assertContains(response, "app.js")
