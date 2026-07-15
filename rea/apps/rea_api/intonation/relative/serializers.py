from rest_framework import serializers

from .models import (
    Bar,
    Lesson,
    KeyModel,
    MusicEvent,
    ScaleModel,
    ScaleModelPitch,
    ScaleModelTiming,
)


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
    """Full lesson serializer, including nested bars/events.  Used for the
    *detail* (retrieve) endpoint.  List endpoints use
    :class:`LessonSummarySerializer` to avoid embedding every lesson's note
    data in category fetches."""
    bars = BarSerializer(many=True, read_only=True)
    key_model_name = serializers.CharField(source="key_model.name", read_only=True)
    display_name = serializers.CharField(read_only=True)
    # The key signature lives on the related KeyModel; expose it here so the
    # frontend can resolve enharmonic note pitches (e.g. f1 in G-dur -> F#).
    key_signature = serializers.SerializerMethodField()

    class Meta:
        model = Lesson
        fields = "__all__"

    def get_key_signature(self, obj):
        km = obj.key_model
        return km.key_signature if km else []


class LessonSummarySerializer(serializers.ModelSerializer):
    """Lightweight lesson serializer for LIST responses.

    Drops the nested ``bars``/``events`` — the frontend only needs scalar
    fields (category, inversion, interval_name, part, variant, key…) to
    filter and pick a lesson id; it then fetches the bars via the *detail*
    endpoint for the one lesson it renders.  Keeps list responses small.
    """
    key_model_name = serializers.CharField(source="key_model.name", read_only=True)
    display_name = serializers.CharField(read_only=True)
    key_signature = serializers.SerializerMethodField()

    class Meta:
        model = Lesson
        fields = (
            "id", "key_model", "key_model_name", "texture", "formula_name",
            "category", "inversion", "interval_name", "part", "variant",
            "source_file", "tempo", "draw_only_note_heads",
            "default_rhythm", "mid_bar_time",
            "display_name", "key_signature",
        )
        read_only_fields = fields

    get_key_signature = LessonSerializer.get_key_signature


class KeyModelSerializer(serializers.ModelSerializer):
    bars = BarSerializer(many=True, read_only=True)
    scale_model_mode = serializers.CharField(source="scale_model.mode", read_only=True)

    class Meta:
        model = KeyModel
        fields = "__all__"


class ScaleModelTimingSerializer(serializers.ModelSerializer):
    class Meta:
        model = ScaleModelTiming
        fields = "__all__"


class ScaleModelPitchSerializer(serializers.ModelSerializer):
    class Meta:
        model = ScaleModelPitch
        fields = "__all__"


class ScaleModelSerializer(serializers.ModelSerializer):
    timings = ScaleModelTimingSerializer(many=True, read_only=True)
    pitches = ScaleModelPitchSerializer(many=True, read_only=True)

    class Meta:
        model = ScaleModel
        fields = "__all__"