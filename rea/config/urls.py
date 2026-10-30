from django.contrib import admin
from django.urls import path, include

urlpatterns = [
    path("admin/", admin.site.urls),
    # Scores written in the dictation editor.  Not `api/dictations/`: that is
    # the dictation *shelf* of the exercise library, which the practice app
    # already reads.
    path("api/dictation-scores/", include("rea.apps.dictation.urls")),
    path("api/", include("rea.apps.rea_api.urls")),
    path("api/accounts/", include("rea.apps.accounts.api_urls")),
    path("accounts/", include("rea.apps.accounts.urls")),
    path("", include("rea.apps.rea_frontend.urls")),
]