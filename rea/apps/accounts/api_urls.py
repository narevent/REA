from django.urls import path

from .api import MeView, NoteOctaveView, SessionCreateView

urlpatterns = [
    path("me/", MeView.as_view(), name="accounts-me"),
    path("sessions/", SessionCreateView.as_view(), name="accounts-sessions"),
    path("octaves/", NoteOctaveView.as_view(), name="accounts-octaves"),
]
