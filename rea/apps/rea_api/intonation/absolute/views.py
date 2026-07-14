from rest_framework import viewsets

from .models import Bar, ChromaticBase, Lesson, MusicEvent
from .serializers import (
    BarSerializer,
    ChromaticBaseSerializer,
    LessonSerializer,
    MusicEventSerializer,
)


class ChromaticBaseViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = ChromaticBase.objects.all().order_by("name")
    serializer_class = ChromaticBaseSerializer


class LessonViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Lesson.objects.select_related("base").order_by(
        "category", "span", "grades", "part", "exercise_number"
    )
    serializer_class = LessonSerializer
    filterset_fields = {
        "category": ["exact"],
        "span": ["exact"],
        "grades": ["exact"],
        "part": ["exact"],
        "exercise_number": ["exact"],
        "exercise_type": ["exact", "icontains"],
        "timed": ["exact"],
        "chromatic": ["exact"],
    }


class BarViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Bar.objects.select_related("base", "lesson").order_by("bar_index")
    serializer_class = BarSerializer
    filterset_fields = {"base": ["exact"], "lesson": ["exact"]}


class MusicEventViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = MusicEvent.objects.select_related("bar").order_by("bar", "event_index")
    serializer_class = MusicEventSerializer
