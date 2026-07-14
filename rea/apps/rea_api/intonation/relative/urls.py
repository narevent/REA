from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter()
router.register(r"scale-models", views.ScaleModelViewSet, basename="scalemodel")
router.register(r"key-models", views.KeyModelViewSet, basename="keymodel")
router.register(r"lessons", views.LessonViewSet, basename="lesson")
router.register(r"bars", views.BarViewSet, basename="bar")
router.register(r"events", views.MusicEventViewSet, basename="musicevent")

urlpatterns = router.urls