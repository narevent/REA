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
        name = f"{obj.category}-{obj.span}"
        return f"{name}-{obj.grades}" if obj.grades else name

    def get_variant(self, obj) -> str:
        bits = []
        if obj.part:
            bits.append(f"part {obj.part}")
        bits.append(f"ex-{obj.exercise_number}")
        return " ".join(bits)

    def get_key_model(self, obj):
        return None

    def get_key_model_name(self, obj) -> str:
        return "Absolute"


class ChromaticBaseSerializer(serializers.ModelSerializer):
    bars = BarSerializer(many=True, read_only=True)

    class Meta:
        model = ChromaticBase
        fields = "__all__"
