from django.urls import path
from django.http import HttpResponse

from .views import IndexView

app_name = "rea_frontend"


def favicon(request):
    # Empty 1x1 SVG favicon to avoid 404 noise in the console.
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
        '<rect width="16" height="16" fill="#0f1115"/>'
        '<text x="8" y="12" font-size="11" text-anchor="middle" fill="#6aa9ff">R</text>'
        "</svg>"
    )
    return HttpResponse(svg, content_type="image/svg+xml")


urlpatterns = [
    path("", IndexView.as_view(), name="index"),
    path("favicon.ico", favicon, name="favicon"),
]