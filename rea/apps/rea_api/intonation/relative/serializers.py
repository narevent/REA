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
    bars = BarSerializer(many=True, read_only=True)
    key_model_name = serializers.CharField(source="key_model.name", read_only=True)

    class Meta:
        model = Lesson
        fields = "__all__"


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