from typing import List, Optional

from rest_framework import serializers
from .models import Exercise, Category, Approach, LessonType, Key, LessonGroup, Lesson


class ExerciseSerializer(serializers.ModelSerializer):
    class Meta:
        model = Exercise
        fields = [
            "id",
            "midi",
            "svg",
            "category",
            "polyphonic",
            "created",
            "modified",
        ]
        read_only_fields = ["created", "modified"]


# ---------------------------------------------------------------------------
# Lightweight nested read serializers (used inside LessonSerializer)
# ---------------------------------------------------------------------------

class CategorySerializer(serializers.ModelSerializer):
    class Meta:
        model = Category
        fields = ["id", "name", "label"]


class ApproachSerializer(serializers.ModelSerializer):
    category = CategorySerializer(read_only=True)

    class Meta:
        model = Approach
        fields = ["id", "name", "category"]


class LessonTypeSerializer(serializers.ModelSerializer):
    approach = ApproachSerializer(read_only=True)

    class Meta:
        model = LessonType
        fields = ["id", "name", "slug", "approach"]


class KeySerializer(serializers.ModelSerializer):
    class Meta:
        model = Key
        fields = ["id", "tonic", "mode", "folder_code"]


class LessonGroupSerializer(serializers.ModelSerializer):
    """
    Flat representation of a group node.
    Full ancestry is exposed via the read-only `breadcrumb` field so clients
    can reconstruct the path without recursive nesting.
    """

    key = KeySerializer(read_only=True)
    breadcrumb = serializers.SerializerMethodField()

    class Meta:
        model = LessonGroup
        fields = ["id", "name", "folder_name", "key", "depth", "breadcrumb"]

    def get_breadcrumb(self, obj) -> List[str]:
        """Return the chain of group names from root down to this node."""
        parts = []
        node = obj
        while node is not None:
            parts.append(node.name)
            node = node.parent
        return list(reversed(parts))


# ---------------------------------------------------------------------------
# Lesson serializers
# ---------------------------------------------------------------------------

class LessonSerializer(serializers.ModelSerializer):
    """
    Full read/write serializer for Lesson.

    On reads  – expands group, lesson_type (via group), key, and exercises.
    On writes – accepts group (FK id) and exercise ids via PrimaryKeyRelatedField.
    """

    # Read-only expanded fields
    group_detail = LessonGroupSerializer(source="group", read_only=True)
    lesson_type = serializers.SerializerMethodField(read_only=True)
    exercises_detail = ExerciseSerializer(source="exercises", many=True, read_only=True)

    # Write fields
    group = serializers.PrimaryKeyRelatedField(
        queryset=LessonGroup.objects.all(), write_only=True
    )
    exercise_ids = serializers.PrimaryKeyRelatedField(
        source="exercises",
        queryset=Exercise.objects.all(),
        many=True,
        write_only=True,
        required=False,
    )

    class Meta:
        model = Lesson
        fields = [
            "id",
            # write
            "group",
            "exercise_ids",
            # read-only expansions
            "group_detail",
            "lesson_type",
            "exercises_detail",
            # plain fields
            "folder_name",
            "title",
            "order",
            "created",
            "modified",
        ]
        read_only_fields = ["created", "modified"]

    def get_lesson_type(self, obj) -> Optional[dict]:
        """Walk up the group tree to find the owning LessonType."""
        node = obj.group
        while node is not None:
            if node.lesson_type_id is not None:
                return LessonTypeSerializer(node.lesson_type).data
            node = node.parent
        return None


class LessonListSerializer(serializers.ModelSerializer):
    """Compact serializer for list views — avoids heavy nesting."""

    group_name = serializers.CharField(source="group.name", read_only=True)
    key = serializers.SerializerMethodField(read_only=True)

    class Meta:
        model = Lesson
        fields = [
            "id",
            "title",
            "folder_name",
            "order",
            "group_name",
            "key",
            "created",
        ]

    def get_key(self, obj) -> Optional[str]:
        node = obj.group
        while node is not None:
            if node.key_id is not None:
                return str(node.key)
            node = node.parent
        return None