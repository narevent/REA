from django.urls import path

from .api import MeView, SessionCreateView

urlpatterns = [
    path("me/", MeView.as_view(), name="accounts-me"),
    path("sessions/", SessionCreateView.as_view(), name="accounts-sessions"),
]
