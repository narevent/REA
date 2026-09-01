from rest_framework import viewsets

from ...pagination import LargePageSizePagination
from .models import Bar, Lesson, KeyModel, MusicEvent, ScaleModel
from .serializers import (
    BarSerializer,
    LessonSerializer,
    LessonSummarySerializer,
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
    """Relative lessons.

    LIST uses :class:`LessonSummarySerializer` (no nested bars/events) so
    category fetches stay small and fast — the frontend only needs scalar
    fields to filter and pick a lesson id, then fetches the bars via the
    DETAIL endpoint for the one lesson it renders.  RETRIEVE uses the full
    :class:`LessonSerializer` with nested bars/events.  Pagination allows a
    client ``page_size`` (capped at 2000) for the combination-category fetch.
    """
    # Only what is filed in the curriculum.  Drafts are unfinished and
    # dictations belong to their own area, and neither may turn up inside
    # somebody's intonation lesson.  Stated as what is allowed rather than
    # as a list of exclusions, so a shelf added later is invisible to
    # students until somebody decides otherwise — and it is on the queryset
    # rather than on a filter parameter, so no query string can lift it.
    queryset = Lesson.objects.filter(shelf="").select_related("key_model").order_by(
        "key_model__name", "texture", "formula_name",
        "category", "inversion", "interval_name", "part", "variant",
    )
    pagination_class = LargePageSizePagination
    filterset_fields = {
        "key_model": ["exact"],
        "texture": ["exact"],
        "formula_name": ["exact", "icontains"],
        "category": ["exact"],
        "inversion": ["exact"],
        "interval_name": ["exact"],
        "part": ["exact"],
        "variant": ["exact", "icontains"],
    }

    def get_serializer_class(self):
        if self.action == "list":
            return LessonSummarySerializer
        return LessonSerializer


class BarViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Bar.objects.select_related("key_model", "lesson").order_by("bar_index")
    serializer_class = BarSerializer
    filterset_fields = {"key_model": ["exact"], "lesson": ["exact"]}


class MusicEventViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = MusicEvent.objects.select_related("bar").order_by("bar", "event_index")
    serializer_class = MusicEventSerializer