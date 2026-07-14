from django.urls import include, path

urlpatterns = [
    path("intonation/relative/", include("rea.apps.rea_api.intonation.relative.urls")),
]