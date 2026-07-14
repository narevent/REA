from django.contrib import admin
from django.urls import path, include

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include("rea.apps.rea_api.urls")),
    path("", include("rea.apps.rea_frontend.urls")),
]