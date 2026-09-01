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
    """An absolute-pitch exercise, from the ``lessons/mono`` and
    ``lessons/poly`` JSON files.

    Two textures exist:

    * **mono** (melodic): pitch-formula exercises under ``lessons/mono``,
      identified by ``category`` (Formula/FormulaInverse) + ``span`` +
      ``grades`` + ``part`` + ``exercise_number``.
    * **poly** (harmonic): interval/chord exercises under ``lessons/poly``,
      identified by ``category`` (Intervals/ChordsThirds/ChordsSevenths) +
      ``quality`` / ``interval_size`` + ``inversion`` + ``part`` + ``phase``
      + ``exercise_number``.  Each part runs in two pedagogical phases:
      phase 1 presents the material melodically (models, ex 1-5), phase 2
      harmonically (simultaneous sounding, ex 1-10).
    """

    class Texture(models.TextChoices):
        MONO = "mono", "Monophonic (melodic)"
        POLY = "poly", "Polyphonic (harmonic)"

    class Category(models.TextChoices):
        # mono
        FORMULA = "Formula", "Formula"
        FORMULA_INVERSE = "FormulaInverse", "Formula inverse"
        # poly
        INTERVALS = "Intervals", "Intervals"
        CHORDS_THIRDS = "ChordsThirds", "Triads"
        CHORDS_SEVENTHS = "ChordsSevenths", "Seventh chords"

    class Span(models.TextChoices):
        # The stored value stays "Quinta" — it is what the JSON library, the
        # API filters and every imported lesson already carry.  The label is
        # what a singer is taught to hear: the span from the tonic to the
        # dominant.  Changing a TextChoices label is not a schema change, so
        # this needs no migration.
        QUINTA = "Quinta", "Dominant (within a fifth)"
        OCTAVE = "Octave", "Octave"
        EXTENDED = "Extended", "Extended (beyond the octave)"

    base = models.ForeignKey(
        ChromaticBase, related_name="lessons", on_delete=models.PROTECT
    )
    texture = models.CharField(
        max_length=8, choices=Texture.choices, default=Texture.MONO, db_index=True
    )
    category = models.CharField(max_length=32, choices=Category.choices, db_index=True)
    span = models.CharField(
        max_length=32, choices=Span.choices, default="", blank=True, db_index=True,
        help_text="Mono pitch range. Empty for poly.",
    )
    grades = models.CharField(
        max_length=16, default="", blank=True, db_index=True,
        help_text="Mono Extended-span grade level: '2Grades', '3Grades' or ''.",
    )
    quality = models.CharField(
        max_length=32, default="", blank=True, db_index=True,
        help_text=(
            "Poly quality: chord quality ('DominantSeventh', ..., 'Major', "
            "'Diminished') or interval quality ('Major', 'Minor', 'Perfect', "
            "'Augmented'; empty for fifths/octaves)."
        ),
    )
    interval_size = models.CharField(
        max_length=16, default="", blank=True, db_index=True,
        help_text="Poly interval size: 'Seconds'..'Sevenths', 'Eights' (octaves).",
    )
    inversion = models.CharField(
        max_length=8, default="", blank=True, db_index=True,
        help_text="Figured-bass digits for poly chords: 53/63/64 (triads), 7/65/43/2 (sevenths).",
    )
    part = models.CharField(
        max_length=8, default="", blank=True, db_index=True,
        help_text="Progressive section: '1'..'4' or cumulative '1-2', '1-3', '1-4'; '' when the span has no parts.",
    )
    phase = models.PositiveSmallIntegerField(
        default=0, db_index=True,
        help_text="Poly pedagogical phase: 1 = melodic presentation, 2 = harmonic. 0 = n/a (mono).",
    )
    exercise_number = models.PositiveSmallIntegerField(
        db_index=True,
        help_text="The ex-N number from the source filename (1-12)."
    )
    exercise_type = models.CharField(
        max_length=64, db_index=True,
        help_text="e.g. 'listening_model', 'guessing_notes', 'guessing_chord'.",
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

    class Shelf(models.TextChoices):
        """Which collection a lesson lives in.

        One question with one answer, rather than a flag per collection: a
        lesson is filed in the curriculum, or it is a draft, or it is a
        dictation, and it cannot sensibly be two of those.

        CURRICULUM ("") is the ordinary case — the lesson has been given a
        place in the method, students meet it there, and its identity must be
        unique.  DRAFT is work in progress that has not been filed yet.
        DICTATION is a teacher's own dictation material: filed, but in its own
        collection rather than in the intonation curriculum, and reached by
        students through the Dictation area instead.

        Only CURRICULUM lessons are bound by the uniqueness rule below, and
        only CURRICULUM lessons are served by the intonation endpoints.
        """

        CURRICULUM = "", "In the curriculum"
        DRAFT = "draft", "Draft — not filed yet"
        DICTATION = "dictation", "Dictation"

    shelf = models.CharField(
        max_length=16, choices=Shelf.choices, default=Shelf.CURRICULUM,
        blank=True, db_index=True,
    )

    class Meta:
        app_label = "absolute"
        constraints = [
            # See the relative Lesson: uniqueness binds filed exercises only.
            models.UniqueConstraint(
                fields=[
                    "texture", "category", "span", "grades",
                    "quality", "interval_size", "inversion",
                    "part", "phase", "exercise_number",
                ],
                condition=models.Q(shelf=""),
                name="absolute_lesson_identity",
            ),
        ]
        ordering = (
            "texture", "category", "span", "grades",
            "quality", "interval_size", "inversion",
            "part", "phase", "exercise_number",
        )

    @property
    def display_name(self) -> str:
        if self.shelf != self.Shelf.CURRICULUM:
            # See the relative Lesson: off the curriculum shelf, the
            # exercise type doubles as the working title.
            return self.exercise_type.strip() or self.get_shelf_display()
        bits = [self.category]
        if self.span:
            bits.append(self.span)
        if self.grades:
            bits.append(self.grades)
        if self.quality:
            bits.append(self.quality)
        if self.interval_size:
            bits.append(self.interval_size)
        if self.inversion:
            bits.append("-".join(self.inversion))
        if self.part:
            bits.append(f"part {self.part}")
        if self.phase:
            bits.append(f"phase {self.phase}")
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
    label = models.CharField(
        max_length=32,
        default="",
        blank=True,
        help_text="Text label from the source (e.g. chord/interval name shown above the bar).",
    )

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
    # Where the notehead is *drawn*, in stave pixels, relative to where the
    # layout would otherwise put it.  Nothing to do with
    # `horizontal_offset_ms`, which moves when the note *sounds*: this moves
    # only the picture, and the note plays at exactly the same moment either
    # way.  The two are separate because they answer separate questions — an
    # anticipated note is a playback offset, and a notehead nudged clear of
    # its neighbour so a phrase can be read is a visual one — and a single
    # field could only ever do one of them without lying about the other.
    visual_offset_px = models.SmallIntegerField(default=0)
    duration = models.FloatField(default=0.125)
    # Tuplets: *num* notes played in the time of *den*.
    #
    # Both zero means an ordinary note, which is almost all of them.  A triplet
    # is 3 in the time of 2, so three eighths written here last as long as two
    # — the written `duration` still says "eighth", and the ratio says what an
    # eighth means inside this group.  Keeping the written value honest is the
    # point: the note is notated as an eighth, it is beamed as an eighth, and
    # only its sounding length is scaled.
    #
    # The grouping is positional.  Every note of a tuplet carries the same
    # pair, and a run of consecutive notes sharing it is cut into groups of
    # `num` — so two triplets in a row are six marked notes read as 3 + 3,
    # which needs no group id and cannot be left dangling by an edit that
    # deletes a note.
    tuplet_num = models.PositiveSmallIntegerField(default=0)
    tuplet_den = models.PositiveSmallIntegerField(default=0)
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
