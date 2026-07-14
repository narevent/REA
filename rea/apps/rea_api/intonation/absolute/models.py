"""
Database models for the REA "absolute" intonation domain.

The absolute domain trains *absolute pitch* rather than scale-degree
relationships, so its hierarchy differs from the relative domain:

1. **Chromatic base** – there are no keys.  The single reference model
   (``key_models/Base/Ap_12.json``) enumerates the 12 chromatic pitches
   (`ChromaticBase` → `Bar` → `MusicEvent`).
2. **Lessons** – exercise files organised by *category* (Formula /
   FormulaInverse), *span* (the pitch range trained: Quinta = within a
   fifth, Octave = within an octave, Extended = beyond one octave),
   *part* (progressive subsections 1..4 and their cumulative unions
   1-2, 1-3, 1-4) and *exercise number/type* (listening, singing,
   guessing – optionally timed, chromatic or multiple-answer).

A `Bar` is owned by *either* a `ChromaticBase` *or* a `Lesson` – exactly
one of the two foreign keys is set (mirroring the relative app).
"""

from django.db import models


class ChromaticBase(models.Model):
    """The chromatic pitch reference (12 semitones), from ``Ap_12.json``."""

    name = models.CharField(max_length=64, unique=True, help_text="e.g. 'Ap_12'.")
    clef = models.CharField(max_length=32, default="Violin")
    default_rhythm = models.CharField(max_length=32, default="FreeStyle")
    draw_only_note_heads = models.BooleanField(default=True)
    tempo = models.PositiveIntegerField(default=4)

    class Meta:
        app_label = "absolute"

    def __str__(self) -> str:
        return self.name


class Lesson(models.Model):
    """An absolute-pitch exercise, from the ``lessons/mono`` JSON files."""

    class Category(models.TextChoices):
        FORMULA = "Formula", "Formula"
        FORMULA_INVERSE = "FormulaInverse", "Formula inverse"

    class Span(models.TextChoices):
        QUINTA = "Quinta", "Quinta (within a fifth)"
        OCTAVE = "Octave", "Octave"
        EXTENDED = "Extended", "Extended (beyond the octave)"

    base = models.ForeignKey(
        ChromaticBase, related_name="lessons", on_delete=models.PROTECT
    )
    category = models.CharField(max_length=32, choices=Category.choices)
    span = models.CharField(max_length=32, choices=Span.choices)
    grades = models.CharField(
        max_length=16,
        default="",
        blank=True,
        help_text="Extended-span grade level: '2Grades', '3Grades' or ''.",
    )
    part = models.CharField(
        max_length=8,
        default="",
        blank=True,
        help_text="Progressive section: '1'..'4' or cumulative '1-2', '1-3', '1-4'; '' when the span has no parts.",
    )
    exercise_number = models.PositiveSmallIntegerField(
        help_text="The ex-N number from the source filename (1-12)."
    )
    exercise_type = models.CharField(
        max_length=64,
        help_text="e.g. 'listening_model', 'guessing_notes', 'singing_given_model'.",
    )
    timed = models.BooleanField(default=False)
    chromatic = models.BooleanField(
        default=False, help_text="True when the exercise covers the chromatic scale."
    )
    source_file = models.CharField(max_length=512, default="")
    tempo = models.PositiveIntegerField(default=86)
    # Performance / layout metadata copied from the JSON.
    draw_only_note_heads = models.BooleanField(default=False)
    default_rhythm = models.CharField(max_length=32, default="FreeStyle")
    mid_bar_time = models.FloatField(default=0.1)
    raw = models.JSONField(default=dict, blank=True)

    class Meta:
        app_label = "absolute"
        unique_together = ("category", "span", "grades", "part", "exercise_number")
        ordering = ("category", "span", "grades", "part", "exercise_number")

    @property
    def display_name(self) -> str:
        bits = [self.category, self.span]
        if self.grades:
            bits.append(self.grades)
        if self.part:
            bits.append(f"part {self.part}")
        label = f"ex-{self.exercise_number} {self.exercise_type.replace('_', ' ')}"
        if self.timed:
            label += " (timed)"
        return " / ".join(bits) + f" – {label}"

    def __str__(self) -> str:
        return self.display_name


class Bar(models.Model):
    """A bar within the chromatic base or a lesson.

    Exactly one of ``base`` / ``lesson`` is set.
    """

    base = models.ForeignKey(
        ChromaticBase, related_name="bars", on_delete=models.CASCADE, null=True, blank=True
    )
    lesson = models.ForeignKey(
        Lesson, related_name="bars", on_delete=models.CASCADE, null=True, blank=True
    )
    bar_index = models.PositiveSmallIntegerField()
    music_clef = models.CharField(max_length=32, default="Violin")
    music_rhythm = models.CharField(max_length=32, default="FreeStyle")
    music_mode_chord = models.CharField(max_length=64, default="")
    is_incomplete_bar = models.BooleanField(default=False)
    incomplete_bar_playback_count = models.PositiveSmallIntegerField(default=0)

    class Meta:
        app_label = "absolute"
        ordering = ("bar_index",)

    def __str__(self) -> str:
        owner = self.base or self.lesson
        return f"{owner} bar {self.bar_index}"


class MusicEvent(models.Model):
    """A single note/rest within a bar."""

    bar = models.ForeignKey(Bar, related_name="events", on_delete=models.CASCADE)
    event_index = models.PositiveSmallIntegerField()
    horizontal_offset_ms = models.IntegerField(default=0)
    duration = models.FloatField(default=0.125)
    attack_decay_time = models.FloatField(null=True, blank=True)
    volume = models.PositiveSmallIntegerField(default=80)
    note_name = models.CharField(max_length=16, help_text="Raw token, e.g. 'c1', 'c1#', 'hb'.")
    alias_degree = models.CharField(
        max_length=16, default="", help_text="The label from the source alias (chromatic index in the base)."
    )
    is_rest = models.BooleanField(default=False)
    is_enharmonic = models.BooleanField(default=False)
    event_type = models.CharField(max_length=64, default="MusicNoteBundle")
    # Convenience: absolute pitch class resolved at import time (0-11, or -1 for rests).
    pitch_class = models.SmallIntegerField(default=-1)

    class Meta:
        app_label = "absolute"
        ordering = ("event_index",)

    def __str__(self) -> str:
        return f"{self.bar} evt {self.event_index}: {self.note_name}"
