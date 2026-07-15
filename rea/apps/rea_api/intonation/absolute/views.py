from rest_framework import viewsets

from ...pagination import LargePageSizePagination
from .models import Bar, ChromaticBase, Lesson, MusicEvent
from .serializers import (
    BarSerializer,
    ChromaticBaseSerializer,
    LessonSerializer,
    LessonSummarySerializer,
    MusicEventSerializer,
)


class ChromaticBaseViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = ChromaticBase.objects.all().order_by("name")
    serializer_class = ChromaticBaseSerializer


class LessonViewSet(viewsets.ReadOnlyModelViewSet):
    """Absolute lessons.

    LIST uses :class:`LessonSummarySerializer` (no nested bars/events, no
    multi-KB ``raw`` blob) so category fetches stay small and fast — the
    frontend only needs scalar fields to filter and pick a lesson id, then
    fetches the bars via the DETAIL endpoint for the one lesson it renders.
    RETRIEVE uses the full :class:`LessonSerializer` with nested bars/events.
    Pagination allows a client ``page_size`` (capped at 2000) so the
    combination-category fetch can be done in few round-trips.
    """
    queryset = Lesson.objects.select_related("base").order_by(
        "texture", "category", "span", "grades",
        "quality", "interval_size", "inversion",
        "part", "phase", "exercise_number",
    )
    serializer_class = LessonSerializer
    pagination_class = LargePageSizePagination
    filterset_fields = {
        "texture": ["exact"],
        "category": ["exact"],
        "span": ["exact"],
        "grades": ["exact"],
        "quality": ["exact"],
        "interval_size": ["exact"],
        "inversion": ["exact"],
        "part": ["exact"],
        "phase": ["exact"],
        "exercise_number": ["exact"],
        "exercise_type": ["exact", "icontains"],
        "timed": ["exact"],
        "chromatic": ["exact"],
    }

    def get_serializer_class(self):
        if self.action == "list":
            return LessonSummarySerializer
        return LessonSerializer


class BarViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Bar.objects.select_related("base", "lesson").order_by("bar_index")
    serializer_class = BarSerializer
    filterset_fields = {"base": ["exact"], "lesson": ["exact"]}


class MusicEventViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = MusicEvent.objects.select_related("bar").order_by("bar", "event_index")
    serializer_class = MusicEventSerializer
