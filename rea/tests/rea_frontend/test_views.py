"""Tests for the frontend app (template view)."""

from django.test import TestCase
from django.urls import reverse


class IndexViewTests(TestCase):
    def test_index_renders(self):
        response = self.client.get(reverse("rea_frontend:index"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "REA")
        self.assertContains(response, "Relative Intonation")

    def test_index_references_static(self):
        response = self.client.get(reverse("rea_frontend:index"))
        self.assertContains(response, "main.css")
        self.assertContains(response, "app.js")