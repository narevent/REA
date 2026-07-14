from django.urls import include, path

from .intonation.views import ExerciseListView

urlpatterns = [
    path("intonation/relative/", include("rea.apps.rea_api.intonation.relative.urls")),
    path("intonation/absolute/", include("rea.apps.rea_api.intonation.absolute.urls")),
    path("intonation/exercises/", ExerciseListView.as_view(), name="intonation-exercises"),
]
