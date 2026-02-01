# frontend/urls.py
from django.urls import path, include
from . import views

urlpatterns = [
    path('', views.home, name='home'),
    path('landing/', views.landing_page, name='landing_page'),
    path('signup/', views.signup_view, name='signup'),
    path('login/', views.login_view, name='login'),
    path('logout/', views.logout_view, name='logout'),
    path('dashboard/', views.dashboard, name='dashboard'),
    path('profile/<str:username>/', views.profile_view, name='profile'),
    path('add-instrument/', views.add_instrument_view, name='add_instrument'),
    path('exercises/', views.ExerciseViewSet.as_view({'get': 'dashboard'}), name='exercise-dashboard'),
    path('exercises/<int:pk>/', views.ExerciseViewSet.as_view({'get': 'detail_view'}), name='exercise-detail'),
    path('exercises/upload/', views.ExerciseViewSet.as_view({'get': 'upload_form', 'post': 'upload_form'}), name='exercise-upload'),
    path('exercises/create/', views.ExerciseViewSet.as_view({'get': 'create_form', 'post': 'create_form'}), name='exercise-create'),
    path('exercises/<int:pk>/update/', views.ExerciseViewSet.as_view({'get': 'update_form', 'post': 'update_form'}), name='exercise-update'),
    path('exercises/<int:pk>/delete/', views.ExerciseViewSet.as_view({'post': 'delete'}), name='exercise-delete'),
    path('exercises/<int:pk>/viewer/', views.ExerciseViewSet.as_view({'get': 'score_viewer'}), name='exercise-viewer'),
]