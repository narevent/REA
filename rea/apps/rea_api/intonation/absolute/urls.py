from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter()
router.register(r"chromatic-bases", views.ChromaticBaseViewSet, basename="chromaticbase")
router.register(r"lessons", views.LessonViewSet, basename="absolute-lesson")
router.register(r"bars", views.BarViewSet, basename="absolute-bar")
router.register(r"events", views.MusicEventViewSet, basename="absolute-musicevent")

urlpatterns = router.urls
