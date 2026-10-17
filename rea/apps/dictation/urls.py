from django.urls import path

from .api import DictationDetail, DictationList

urlpatterns = [
    path("", DictationList.as_view(), name="dictation-score-list"),
    path("<int:pk>/", DictationDetail.as_view(), name="dictation-score-detail"),
]
