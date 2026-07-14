from rest_framework import viewsets

from .models import Bar, Lesson, KeyModel, MusicEvent, ScaleModel
from .serializers import (
    BarSerializer,
    LessonSerializer,
    KeyModelSerializer,
    MusicEventSerializer,
    ScaleModelSerializer,
)


class ScaleModelViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = ScaleModel.objects.all().order_by("mode", "reference_key")
    serializer_class = ScaleModelSerializer


class KeyModelViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = KeyModel.objects.select_related("scale_model").order_by("name")
    serializer_class = KeyModelSerializer
    filterset_fields = {"name": ["exact", "icontains"], "mode": ["exact"]}


class LessonViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Lesson.objects.select_related("key_model").order_by(
        "key_model__name", "formula_name", "variant"
    )
    serializer_class = LessonSerializer
    filterset_fields = {
        "key_model": ["exact"],
        "formula_name": ["exact", "icontains"],
        "variant": ["exact", "icontains"],
    }


class BarViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Bar.objects.select_related("key_model", "lesson").order_by("bar_index")
    serializer_class = BarSerializer
    filterset_fields = {"key_model": ["exact"], "lesson": ["exact"]}


class MusicEventViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = MusicEvent.objects.select_related("bar").order_by("bar", "event_index")
    serializer_class = MusicEventSerializer