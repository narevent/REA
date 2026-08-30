"""
Validation for everything the score editor sends back.

The editor is a teacher-facing tool, not a public endpoint, but it is still
the only writer the lesson tables have ever had: every row in them arrived
through the JSON importers, which trusted their input because it came from
files the project shipped.  So the rules the importers took for granted —
note tokens are German letter + octave + modifier, durations are fractions of
a whole note, a bar belongs to exactly one lesson — are spelled out here, and
a save that breaks one of them is refused with a message the editor can show
next to the note that caused it.
"""

from __future__ import annotations

from django.db import models
from rest_framework import serializers

from ..intonation.absolute.models import Lesson as AbsoluteLesson
from ..intonation.relative.models import Lesson as RelativeLesson
from ..intonation.relative.utils.note_parser import LETTER_PC
from . import score

# Note tokens the parser understands: a German letter, an optional octave
# digit, an optional modifier.  Mirrors `_TOKEN_RE` in the note parser — kept
# as a validation message rather than a regex import so the error can say what
# a good token looks like.
NOTE_TOKEN_HELP = (
    "a note is a German letter (c d e f g a h), an optional octave digit, "
    "and an optional modifier (# b x r) — e.g. 'c1', 'f2#', 'e1r'"
)

# Durations the notation renderer can draw.  Anything else would sound but
# could not be shown, and a score you cannot read is not an exercise.
DURATIONS = (1.0, 0.5, 0.25, 0.125, 0.0625, 0.03125)

# The offset is a nudge, not a rhythm: the player multiplies it by 12 before
# using it (`practiceData.OFFSET_GAIN`), so ±60 already covers ±720 ms, well
# past anything in the imported library (which spans -13..+7).
MAX_OFFSET_MS = 60


def validate_note_token(value):
    """A note name the parser and the renderer will both accept."""
    token = (value or "").strip()
    if not token:
        raise serializers.ValidationError(f"Empty note name — {NOTE_TOKEN_HELP}.")
    letter, rest = token[0], token[1:]
    if letter not in LETTER_PC:
        raise serializers.ValidationError(f"'{token}' is not a note — {NOTE_TOKEN_HELP}.")
    if rest and rest[0].isdigit():
        rest = rest[1:]
    if rest and rest not in ("#", "b", "x", "r"):
        raise serializers.ValidationError(f"'{token}' is not a note — {NOTE_TOKEN_HELP}.")
    return token


class EventSerializer(serializers.Serializer):
    """One note or rest."""

    note_name = serializers.CharField(max_length=16, required=False, allow_blank=True)
    alias_degree = serializers.CharField(max_length=16, required=False, allow_blank=True, default="")
    duration = serializers.FloatField(default=0.125)
    horizontal_offset_ms = serializers.IntegerField(
        default=0, min_value=-MAX_OFFSET_MS, max_value=MAX_OFFSET_MS
    )
    attack_decay_time = serializers.FloatField(
        required=False, allow_null=True, default=None, min_value=0, max_value=5
    )
    volume = serializers.IntegerField(default=80, min_value=0, max_value=127)
    is_rest = serializers.BooleanField(default=False)
    is_enharmonic = serializers.BooleanField(default=False)
    event_type = serializers.CharField(max_length=64, default="MusicNoteBundle")

    def validate_duration(self, value):
        if value not in DURATIONS:
            allowed = ", ".join(str(d) for d in DURATIONS)
            raise serializers.ValidationError(
                f"Duration {value} cannot be notated — use one of {allowed}."
            )
        return value

    def validate(self, attrs):
        if attrs.get("is_rest"):
            # A rest sounds nothing, so its name is noise; drop it rather than
            # validate it, and clear the accidental flags that go with a pitch.
            attrs["note_name"] = ""
            attrs["is_enharmonic"] = False
            return attrs
        attrs["note_name"] = validate_note_token(attrs.get("note_name"))
        return attrs


class BarSerializer(serializers.Serializer):
    """One bar, with the notes it holds."""

    music_clef = serializers.CharField(max_length=32, default="Violin")
    music_rhythm = serializers.CharField(max_length=32, default="FreeStyle")
    music_mode_chord = serializers.CharField(max_length=64, required=False, allow_blank=True, default="")
    is_incomplete_bar = serializers.BooleanField(default=False)
    incomplete_bar_playback_count = serializers.IntegerField(default=0, min_value=0, max_value=99)
    label = serializers.CharField(max_length=32, required=False, allow_blank=True, default="")
    # Relative bars only; ignored when saving an absolute lesson.
    degree = serializers.CharField(max_length=16, required=False, allow_blank=True, default="")
    quality = serializers.ChoiceField(
        choices=["natural", "raised", "lowered"], required=False, default="natural"
    )
    events = EventSerializer(many=True, default=list)


def _meta_kwargs(model, field_names):
    """Let the lesson's own defaults stand in for anything left out.

    Most identity fields on a lesson are optional by design — a melodic lesson
    has no inversion, a harmonic one has no span — and the model records that
    as ``default=""``.  DRF's ModelSerializer does not read a default as
    permission to omit or blank a field, so it would reject exactly the
    exercises the library is full of.  This restores the model's intent.
    """
    kwargs = {}
    for name in field_names:
        field = model._meta.get_field(name)
        options = {}
        if field.has_default():
            options["required"] = False
        if isinstance(field, (models.CharField, models.TextField)):
            options["allow_blank"] = True
        if options:
            kwargs[name] = options
    return kwargs


class RelativeMetaSerializer(serializers.ModelSerializer):
    class Meta:
        model = RelativeLesson
        fields = score.RELATIVE_META_FIELDS
        extra_kwargs = _meta_kwargs(RelativeLesson, score.RELATIVE_META_FIELDS)


class AbsoluteMetaSerializer(serializers.ModelSerializer):
    class Meta:
        model = AbsoluteLesson
        fields = score.ABSOLUTE_META_FIELDS
        extra_kwargs = _meta_kwargs(AbsoluteLesson, score.ABSOLUTE_META_FIELDS)


class ScoreDocumentSerializer(serializers.Serializer):
    """A whole exercise: which lesson it is, and every bar in it.

    ``system`` decides which lesson table is being written and therefore which
    meta block applies; it is set by the URL, not by the payload, so a teacher
    cannot save a relative document over an absolute lesson by mistake.
    """

    bars = BarSerializer(many=True)

    def __init__(self, *args, system="relative", **kwargs):
        super().__init__(*args, **kwargs)
        self.system = system
        meta_cls = RelativeMetaSerializer if system == "relative" else AbsoluteMetaSerializer
        self.fields["meta"] = meta_cls()
        if system == "relative":
            self.fields["key_model"] = serializers.PrimaryKeyRelatedField(
                queryset=RelativeLesson._meta.get_field("key_model").related_model.objects.all(),
                required=False,
            )

    def validate_bars(self, value):
        if not value:
            raise serializers.ValidationError("An exercise needs at least one bar.")
        return value
