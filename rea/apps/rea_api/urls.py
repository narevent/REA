from django.urls import include, path

from .intonation.views import ChapterListView, ExerciseListView, FacetsView

urlpatterns = [
    path("intonation/relative/", include("rea.apps.rea_api.intonation.relative.urls")),
    path("intonation/absolute/", include("rea.apps.rea_api.intonation.absolute.urls")),
    path("intonation/chapters/", ChapterListView.as_view(), name="intonation-chapters"),
    path("intonation/facets/", FacetsView.as_view(), name="intonation-facets"),
    path("intonation/exercises/", ExerciseListView.as_view(), name="intonation-exercises"),
]
