"""
Database models for the REA "relative" intonation domain.

The domain models three layers, mirroring the source JSON:

1. **Scale templates** – mode-agnostic recipes (`ScaleModel` +
   `ScaleModelTiming` + `ScaleModelPitch`).  These describe *how* a scale is
   built (degrees, qualities, intervals, rhythm) in a reference key.
2. **Keys** – concrete instantiations of a scale template rooted on a given
   pitch (`KeyModel` → `Bar` → `MusicEvent`).  The imported ``key_models``
   JSON files populate this layer.
3. **Lessons** – formula sequences built on top of a key (`Lesson` →
   `Bar` → `MusicEvent`).  The ``lessons`` JSON files populate this layer.

A `Bar` is owned by *either* a `KeyModel` (scale-template bars) *or* a
`Lesson` (formula bars) – exactly one of the two foreign keys is set.
"""

from django.db import models


class ScaleModel(models.Model):
    """A generic scale recipe (e.g. Major, HarmonicMinor)."""

    class Mode(models.TextChoices):
        MAJOR = "Major", "Major"
        MINOR = "Minor", "Natural minor"
        HARMONIC_MINOR = "HarmonicMinor", "Harmonic minor"
        MELODIC_MINOR = "MelodicMinor", "Melodic minor"

    mode = models.CharField(max_length=32, choices=Mode.choices)
    clef = models.CharField(max_length=32, default="Violin")
    default_rhythm = models.CharField(max_length=32, default="FreeStyle")
    draw_only_note_heads = models.BooleanField(default=True)
    reference_key = models.CharField(
        max_length=64,
        help_text="The key used to define this template, e.g. 'C_Major'.",
    )

    class Meta:
        unique_together = ("mode", "reference_key")
        app_label = "relative"

    def __str__(self) -> str:
        return f"{self.mode} ({self.reference_key})"


class ScaleModelTiming(models.Model):
    """Rhythmic template: per-degree timing within the scale."""

    class Quality(models.TextChoices):
        NATURAL = "natural", "Natural"
        RAISED = "raised", "Raised"
        LOWERED = "lowered", "Lowered"

    scale_model = models.ForeignKey(
        ScaleModel, related_name="timings", on_delete=models.CASCADE
    )
    degree = models.PositiveSmallIntegerField()
    quality = models.CharField(
        max_length=16, choices=Quality.choices, default=Quality.NATURAL
    )
    sequence_index = models.PositiveSmallIntegerField()
    offset_ms = models.IntegerField(default=0)
    duration = models.FloatField(default=0.125)

    class Meta:
        app_label = "relative"
        unique_together = ("scale_model", "sequence_index", "quality")
        ordering = ("sequence_index",)

    def __str__(self) -> str:
        return f"{self.scale_model} deg {self.degree} {self.quality}"


class ScaleModelPitch(models.Model):
    """Pitch template: per-degree interval from the tonic (reference key)."""

    class Quality(models.TextChoices):
        NATURAL = "natural", "Natural"
        RAISED = "raised", "Raised"
        LOWERED = "lowered", "Lowered"

    scale_model = models.ForeignKey(
        ScaleModel, related_name="pitches", on_delete=models.CASCADE
    )
    degree = models.PositiveSmallIntegerField()
    quality = models.CharField(
        max_length=16, choices=Quality.choices, default=Quality.NATURAL
    )
    interval_semitones = models.SmallIntegerField()
    reference_note_name = models.CharField(max_length=16)

    class Meta:
        app_label = "relative"
        unique_together = ("scale_model", "degree", "quality")
        ordering = ("degree", "quality")

    def __str__(self) -> str:
        return f"{self.scale_model} deg {self.degree} {self.quality} = +{self.interval_semitones}"


class KeyModel(models.Model):
    """A concrete key: a scale template rooted on a specific pitch.

    Populated from the ``key_models`` JSON files (e.g. ``C-dur_8.json``).
    """

    scale_model = models.ForeignKey(
        ScaleModel, related_name="keys", on_delete=models.PROTECT
    )
    name = models.CharField(max_length=64, unique=True, help_text="e.g. 'C-dur', 'A-mol'.")
    mode = models.CharField(max_length=32, choices=ScaleModel.Mode.choices)
    root_pitch_class = models.SmallIntegerField(help_text="0-11, C=0.")
    root_octave = models.PositiveSmallIntegerField(default=1)
    key_signature = models.JSONField(
        default=list,
        help_text="Normalized incdec list: [{'name':'f2#','letter':'f','offset':1}, ...].",
    )
    tonic_offset_override_ms = models.IntegerField(
        null=True, blank=True,
        help_text="Optional override for the A/D/G tonic-offset anomaly.",
    )
    # Top-level metadata copied from the JSON for fidelity.
    default_rhythm = models.CharField(max_length=32, default="FreeStyle")
    draw_only_note_heads = models.BooleanField(default=True)
    tempo = models.PositiveIntegerField(default=4)

    class Meta:
        app_label = "relative"

    def __str__(self) -> str:
        return self.name


class Lesson(models.Model):
    """A lesson built on top of a key.

    Populated from the ``lessons`` JSON files.  Two textures exist:

    * **mono** (melodic): single-voice formula lessons under ``lessons/mono``,
      identified by ``formula_name`` + ``variant``.
    * **poly** (harmonic): multi-voice lessons under ``lessons/poly`` —
      diatonic triads / seventh chords (with figured-bass inversions),
      intervals within the key, and the tonal-trichord formula.  Identified
      by ``category`` (+ ``inversion`` / ``interval_name``) + ``part`` +
      ``variant``.
    """

    class Texture(models.TextChoices):
        MONO = "mono", "Monophonic (melodic)"
        POLY = "poly", "Polyphonic (harmonic)"

    class PolyCategory(models.TextChoices):
        FORMULA = "Formula", "Tonal-trichord formula"
        CHORDS_THIRDS = "ChordsThirds", "Triads"
        CHORDS_SEVENTHS = "ChordsSevenths", "Seventh chords"
        INTERVALS = "Intervals", "Intervals"

    key_model = models.ForeignKey(
        KeyModel, related_name="lessons", on_delete=models.CASCADE
    )
    texture = models.CharField(
        max_length=8, choices=Texture.choices, default=Texture.MONO, db_index=True
    )
    formula_name = models.CharField(
        max_length=255, default="", blank=True, db_index=True,
        help_text="Mono formula family: 'Octave', 'Quinta', 'Extended'. Empty for poly.",
    )
    category = models.CharField(
        max_length=32, choices=PolyCategory.choices, default="", blank=True, db_index=True,
        help_text="Poly lesson category. Empty for mono.",
    )
    inversion = models.CharField(
        max_length=8, default="", blank=True, db_index=True,
        help_text="Figured-bass digits for poly chords: 53/63/64 (triads), 7/65/43/2 (sevenths).",
    )
    interval_name = models.CharField(
        max_length=16, default="", blank=True, db_index=True,
        help_text="Poly interval family: 'Thirds', 'Fourths', 'Fifths', 'Sixths', 'Sevenths'.",
    )
    part = models.CharField(
        max_length=8, default="", blank=True, db_index=True,
        help_text="Poly progressive section: '1', '2', '1-2', '3', '1-3'. Empty for mono.",
    )
    variant = models.CharField(
        max_length=255, default="", db_index=True,
        help_text=(
            "Mono: 'SKALA', 'ABC', 'KROM', '' (plain), ... "
            "Poly: 'v<N>_<F|ABC>[+T]' — v1 = guided model (chord walk-up / "
            "interval with tonic), v2 = plain tones, v3 = letter names."
        ),
    )
    source_file = models.CharField(max_length=512, default="")
    tempo = models.PositiveIntegerField(default=86)
    # Performance / layout metadata copied from the JSON.
    draw_only_note_heads = models.BooleanField(default=False)
    default_rhythm = models.CharField(max_length=32, default="FreeStyle")
    mid_bar_time = models.FloatField(default=0.1)
    raw = models.JSONField(default=dict, blank=True)

    class Meta:
        app_label = "relative"
        unique_together = (
            "key_model", "texture", "formula_name",
            "category", "inversion", "interval_name", "part", "variant",
        )

    @property
    def display_name(self) -> str:
        if self.texture == self.Texture.POLY:
            bits = [self.get_category_display() or self.category]
            if self.inversion:
                bits.append("-".join(self.inversion))
            if self.interval_name:
                bits.append(self.interval_name)
            if self.part:
                bits.append(f"part {self.part}")
            return f"{self.key_model.name} – " + " ".join(bits) + f" ({self.variant})"
        return f"{self.key_model.name} – {self.formula_name} {self.variant}".strip()

    def __str__(self) -> str:
        return self.display_name


class Bar(models.Model):
    """A bar within a key-model scale or a lesson.

    Exactly one of ``key_model`` / ``lesson`` is set.
    """

    key_model = models.ForeignKey(
        KeyModel, related_name="bars", on_delete=models.CASCADE, null=True, blank=True
    )
    lesson = models.ForeignKey(
        Lesson, related_name="bars", on_delete=models.CASCADE, null=True, blank=True
    )
    bar_index = models.PositiveSmallIntegerField()
    degree = models.CharField(
        max_length=16, help_text="Scale-degree label, e.g. '1', '5\\'', '5,'."
    )
    quality = models.CharField(
        max_length=16, choices=ScaleModelTiming.Quality.choices, default=ScaleModelTiming.Quality.NATURAL
    )
    music_clef = models.CharField(max_length=32, default="Violin")
    music_rhythm = models.CharField(max_length=32, default="FreeStyle")
    music_mode_chord = models.CharField(max_length=64, default="")
    is_incomplete_bar = models.BooleanField(default=False)
    incomplete_bar_playback_count = models.PositiveSmallIntegerField(default=0)
    label = models.CharField(
        max_length=32,
        default="",
        blank=True,
        help_text="Harmonic-function label from the source (e.g. Roman numeral 'I', 'IV').",
    )

    class Meta:
        app_label = "relative"
        ordering = ("bar_index",)

    def __str__(self) -> str:
        owner = self.key_model or self.lesson
        return f"{owner} bar {self.bar_index} (deg {self.degree})"


class MusicEvent(models.Model):
    """A single note/rest within a bar."""

    bar = models.ForeignKey(Bar, related_name="events", on_delete=models.CASCADE)
    event_index = models.PositiveSmallIntegerField()
    horizontal_offset_ms = models.IntegerField(default=0)
    duration = models.FloatField(default=0.125)
    attack_decay_time = models.FloatField(null=True, blank=True)
    volume = models.PositiveSmallIntegerField(default=80)
    note_name = models.CharField(max_length=16, help_text="Raw token, e.g. 'c1', 'f2#', 'e1r'.")
    alias_degree = models.CharField(
        max_length=16, default="", help_text="The scale-degree label from the source alias."
    )
    is_rest = models.BooleanField(default=False)
    is_enharmonic = models.BooleanField(
        default=False,
        help_text="True = note inherits alteration from the key signature.",
    )
    event_type = models.CharField(max_length=64, default="MusicNoteBundle")
    # Convenience: absolute pitch class resolved at import time (0-11, or -1 for rests).
    pitch_class = models.SmallIntegerField(default=-1)

    class Meta:
        app_label = "relative"
        ordering = ("event_index",)

    def __str__(self) -> str:
        return f"{self.bar} evt {self.event_index}: {self.note_name}"