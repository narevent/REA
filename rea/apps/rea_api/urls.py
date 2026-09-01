from django.urls import include, path

from .intonation.views import (
    ChapterListView,
    DictationDetailView,
    DictationListView,
    ExerciseListView,
    FacetsView,
)

urlpatterns = [
    # Teacher-only writes live behind their own prefix: the intonation
    # endpoints below stay read-only for everyone, editor included.
    path("editor/", include("rea.apps.rea_api.editor.urls")),
    path("intonation/relative/", include("rea.apps.rea_api.intonation.relative.urls")),
    path("intonation/absolute/", include("rea.apps.rea_api.intonation.absolute.urls")),
    path("intonation/chapters/", ChapterListView.as_view(), name="intonation-chapters"),
    path("intonation/facets/", FacetsView.as_view(), name="intonation-facets"),
    path("intonation/exercises/", ExerciseListView.as_view(), name="intonation-exercises"),
    # Not under "intonation/": a dictation is its own collection, not a
    # facet of the intonation curriculum.
    path("dictations/", DictationListView.as_view(), name="dictations"),
    path("dictations/<int:pk>/", DictationDetailView.as_view(), name="dictation-detail"),
]
