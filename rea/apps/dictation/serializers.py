import json

from rest_framework import serializers

from .models import Dictation

#: A score is a few thousand notes at most.  Anything far past that is a
#: mistake or an attack, and either way not something to store.
MAX_SCORE_BYTES = 2_000_000
MAX_PHRASES = 200


class DictationSummarySerializer(serializers.ModelSerializer):
    owner_name = serializers.SerializerMethodField()
    phrase_count = serializers.SerializerMethodField()

    class Meta:
        model = Dictation
        fields = (
            "id", "title", "composer", "published", "owner_name", "phrase_count",
            "updated_at",
        )

    def get_owner_name(self, obj):
        if not obj.owner:
            return ""
        profile = getattr(obj.owner, "profile", None)
        return (profile.name if profile else "") or obj.owner.get_username()

    def get_phrase_count(self, obj):
        return len(obj.phrases or [])


class DictationSerializer(DictationSummarySerializer):
    class Meta(DictationSummarySerializer.Meta):
        fields = DictationSummarySerializer.Meta.fields + (
            "description", "score", "phrases", "created_at",
        )
        read_only_fields = ("created_at", "updated_at")

    def validate_score(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError("A score is a JSON object.")
        if len(json.dumps(value)) > MAX_SCORE_BYTES:
            raise serializers.ValidationError("This score is too large to save.")
        if not isinstance(value.get("parts", []), list) or not isinstance(value.get("measures", []), list):
            raise serializers.ValidationError("A score needs a list of parts and a list of measures.")
        return value

    def validate_phrases(self, value):
        if not isinstance(value, list):
            raise serializers.ValidationError("Phrases are a list.")
        if len(value) > MAX_PHRASES:
            raise serializers.ValidationError(f"At most {MAX_PHRASES} phrases.")
        for index, phrase in enumerate(value, start=1):
            if not isinstance(phrase, dict) or not phrase.get("start") or not phrase.get("end"):
                raise serializers.ValidationError(
                    f"Phrase {index} needs a start note and an end note."
                )
            if not isinstance(phrase.get("name", ""), str) or len(phrase.get("name", "")) > 80:
                raise serializers.ValidationError(f"Phrase {index} has a name that is too long.")
        return value
