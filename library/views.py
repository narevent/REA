from rest_framework import viewsets, filters
from rest_framework.permissions import IsAuthenticatedOrReadOnly
from django_filters.rest_framework import DjangoFilterBackend

from .models import Exercise, Lesson, LessonGroup, LessonType, Category, Approach
from .serializers import (
    ExerciseSerializer,
    LessonSerializer,
    LessonListSerializer,
)


class ExerciseViewSet(viewsets.ModelViewSet):
    """
    ViewSet for viewing and editing exercises.
    """

    queryset = Exercise.objects.all()
    serializer_class = ExerciseSerializer
    permission_classes = [IsAuthenticatedOrReadOnly]

    def get_queryset(self):
        queryset = Exercise.objects.all()

        context = self.request.query_params.get("context")
        if context is not None:
            queryset = queryset.filter(context=context)

        category = self.request.query_params.get("category")
        if category is not None:
            queryset = queryset.filter(category=category)

        return queryset


class LessonViewSet(viewsets.ModelViewSet):
    """
    ViewSet for viewing and editing lessons.

    List endpoints return a compact representation; detail endpoints return
    the full nested form including exercises, group breadcrumb and lesson type.

    Filtering
    ---------
    ?category=tonal          – filter by top-level Category name
    ?approach=absolute       – filter by Approach name
    ?lesson_type=<id>        – filter by LessonType id
    ?group=<id>              – filter by direct LessonGroup id
    ?key=<id>                – filter by Key id (anywhere in group ancestry)
    ?search=<term>           – searches title and folder_name

    Ordering
    --------
    ?ordering=order,title,-created   (default: order, folder_name)
    """

    permission_classes = [IsAuthenticatedOrReadOnly]
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["title", "folder_name"]
    ordering_fields = ["order", "title", "folder_name", "created"]
    ordering = ["order", "folder_name"]

    def get_queryset(self):
        qs = (
            Lesson.objects.select_related(
                "group",
                "group__parent",
                "group__lesson_type",
                "group__lesson_type__approach",
                "group__lesson_type__approach__category",
                "group__key",
            )
            .prefetch_related("exercises")
            .order_by("order", "folder_name")
        )

        # --- direct FK filters ---
        group_id = self.request.query_params.get("group")
        if group_id:
            qs = qs.filter(group_id=group_id)

        lesson_type_id = self.request.query_params.get("lesson_type")
        if lesson_type_id:
            # Match lessons whose group chain includes this lesson_type
            qs = qs.filter(group__lesson_type_id=lesson_type_id)

        key_id = self.request.query_params.get("key")
        if key_id:
            qs = qs.filter(group__key_id=key_id)

        # --- name-based filters that walk the chain ---
        approach = self.request.query_params.get("approach")
        if approach:
            qs = qs.filter(
                group__lesson_type__approach__name__iexact=approach
            )

        category = self.request.query_params.get("category")
        if category:
            qs = qs.filter(
                group__lesson_type__approach__category__name__iexact=category
            )

        return qs

    def get_serializer_class(self):
        if self.action == "list":
            return LessonListSerializer
        return LessonSerializer