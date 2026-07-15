from rest_framework import serializers

from .models import Bar, ChromaticBase, Lesson, MusicEvent


class MusicEventSerializer(serializers.ModelSerializer):
    class Meta:
        model = MusicEvent
        fields = "__all__"


class BarSerializer(serializers.ModelSerializer):
    events = MusicEventSerializer(many=True, read_only=True)

    class Meta:
        model = Bar
        fields = "__all__"


class LessonSerializer(serializers.ModelSerializer):
    """Full lesson serializer, including nested bars/events and the raw JSON
    blob.  Used for the *detail* (retrieve) endpoint so the frontend can render
    a single lesson.  List endpoints use :class:`LessonSummarySerializer`
    instead — embedding every lesson's complete note data + the multi-KB raw
    field made category fetches huge (≈20 KB/lesson × thousands of lessons)."""
    bars = BarSerializer(many=True, read_only=True)
    display_name = serializers.CharField(read_only=True)
    # Shape-compat aliases so the frontend can treat relative and absolute
    # lessons uniformly in the exercise list / practice views.
    formula_name = serializers.SerializerMethodField()
    variant = serializers.SerializerMethodField()
    key_model = serializers.SerializerMethodField()
    key_model_name = serializers.SerializerMethodField()

    class Meta:
        model = Lesson
        fields = "__all__"

    def get_formula_name(self, obj) -> str:
        if obj.texture == "poly":
            bits = [obj.category]
            if obj.quality:
                bits.append(obj.quality)
            if obj.interval_size:
                bits.append(obj.interval_size)
            if obj.inversion:
                bits.append("-".join(obj.inversion))
            return "-".join(bits)
        name = f"{obj.category}-{obj.span}"
        return f"{name}-{obj.grades}" if obj.grades else name

    def get_variant(self, obj) -> str:
        bits = []
        if obj.part:
            bits.append(f"part {obj.part}")
        if obj.phase:
            bits.append(f"phase {obj.phase}")
        bits.append(f"ex-{obj.exercise_number}")
        return " ".join(bits)

    def get_key_model(self, obj):
        return None

    def get_key_model_name(self, obj) -> str:
        return "Absolute"


class LessonSummarySerializer(serializers.ModelSerializer):
    """Lightweight lesson serializer for LIST responses.

    Drops the nested ``bars``/``events`` and the multi-KB ``raw`` blob — the
    frontend only needs scalar fields (category, quality, interval_size,
    inversion, part, phase, exercise_number, …) to filter and pick a lesson
    by id; it then fetches the bars via the *detail* endpoint for the one
    lesson it actually renders.  This keeps list responses small and fast.
    """
    display_name = serializers.CharField(read_only=True)
    formula_name = serializers.SerializerMethodField()
    variant = serializers.SerializerMethodField()
    key_model = serializers.SerializerMethodField()
    key_model_name = serializers.SerializerMethodField()

    class Meta:
        model = Lesson
        fields = (
            "id", "base", "texture", "category", "span", "grades",
            "quality", "interval_size", "inversion", "part", "phase",
            "exercise_number", "exercise_type", "timed", "chromatic",
            "source_file", "tempo", "draw_only_note_heads",
            "default_rhythm", "mid_bar_time",
            "display_name", "formula_name", "variant",
            "key_model", "key_model_name",
        )
        read_only_fields = fields

    # Reuse the same derived-field logic as the full serializer.
    get_formula_name = LessonSerializer.get_formula_name
    get_variant = LessonSerializer.get_variant
    get_key_model = LessonSerializer.get_key_model
    get_key_model_name = LessonSerializer.get_key_model_name


class ChromaticBaseSerializer(serializers.ModelSerializer):
    bars = BarSerializer(many=True, read_only=True)

    class Meta:
        model = ChromaticBase
        fields = "__all__"
