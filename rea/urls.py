from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from rest_framework.routers import DefaultRouter
from users.views import UserViewSet, InstrumentViewSet, UserInstrumentViewSet
from library.views import ExerciseViewSet

router = DefaultRouter()
router.register(r'users', UserViewSet)
router.register(r'instruments', InstrumentViewSet)
router.register(r'user-instruments', UserInstrumentViewSet)
router.register(r'exercises', ExerciseViewSet)

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/api-auth/', include('rest_framework.urls', namespace='rest_framework')),
    path('api/', include(router.urls)),
    path('', include('frontend.urls')),
]

urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)