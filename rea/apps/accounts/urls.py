from django.urls import path

from .views import DashboardView, ProfileUpdateView, ReaLoginView, ReaLogoutView, SignupView

app_name = "accounts"

urlpatterns = [
    path("login/", ReaLoginView.as_view(), name="login"),
    path("logout/", ReaLogoutView.as_view(), name="logout"),
    path("signup/", SignupView.as_view(), name="signup"),
    path("profile/", DashboardView.as_view(), name="dashboard"),
    path("profile/update/", ProfileUpdateView.as_view(), name="profile-update"),
]
