"""URLs for the score editor's API.

``<system>`` is part of the path rather than a query parameter because it
decides which table is written; keeping it in the URL means a mistyped payload
can never redirect a save into the other intonation system.
"""

from django.urls import path

from .views import (
    BlankScoreView,
    BrowseView,
    OptionsView,
    PreviewPitchView,
    ScoreCreateView,
    ScoreDetailView,
    ScoreDuplicateView,
)

urlpatterns = [
    path("options/", OptionsView.as_view(), name="editor-options"),
    path("browse/", BrowseView.as_view(), name="editor-browse"),
    path("<str:system>/blank/", BlankScoreView.as_view(), name="editor-blank"),
    path("<str:system>/pitch/", PreviewPitchView.as_view(), name="editor-pitch"),
    path("<str:system>/scores/", ScoreCreateView.as_view(), name="editor-create"),
    path("<str:system>/scores/<int:pk>/", ScoreDetailView.as_view(), name="editor-detail"),
    path(
        "<str:system>/scores/<int:pk>/duplicate/",
        ScoreDuplicateView.as_view(),
        name="editor-duplicate",
    ),
]
