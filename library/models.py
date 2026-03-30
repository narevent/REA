from django.db import models

class Module(models.Model):
    context = models.CharField(max_length=3, choices=(('rel', 'Relative',), ('abs', 'Absolute')), default='rel')


class Exercise(models.Model):
    midi = models.FileField(upload_to='midi', blank=True, null=True)
    svg = models.FileField(upload_to='svg', blank=True, null=True)
    category = models.CharField(max_length=6, choices=(('pitch', 'Intonation',), ('rhythm', 'Rhythm')), default='pitch')
    polyphonic = models.BooleanField(default=False)

    created = models.DateTimeField(auto_now_add=True)
    modified = models.DateTimeField(auto_now=True)

from django.db import models


class Module(models.Model):
    context = models.CharField(
        max_length=3,
        choices=(("rel", "Relative"), ("abs", "Absolute")),
        default="rel",
    )


class Exercise(models.Model):
    midi = models.FileField(upload_to="midi", blank=True, null=True)
    svg = models.FileField(upload_to="svg", blank=True, null=True)
    category = models.CharField(
        max_length=6,
        choices=(("pitch", "Intonation"), ("rhythm", "Rhythm")),
        default="pitch",
    )
    polyphonic = models.BooleanField(default=False)
    created = models.DateTimeField(auto_now_add=True)
    modified = models.DateTimeField(auto_now=True)


# ---------------------------------------------------------------------------
# Lesson hierarchy
#
# The folder structure has three fixed top-level categories (Tonal, Rhythm,
# Dictates), then branches into Absolute / Relative approaches, and then into
# a variable-depth tree of groups before reaching individual lesson leaves.
#
# We model this with:
#
#   Category        – top-level bucket  (Tonal / Rhythm / Dictates)
#   Approach        – Absolute / Relative  (only meaningful under Tonal)
#   LessonType      – named curriculum strand within an Approach
#                     e.g. "Absolute formula", "Tonal triads", "Relative formula"
#   Key             – musical key / tonality  (C Major, A Minor …)
#                     NULL for Absolute branches that are key-independent
#   LessonGroup     – self-referential tree for all intermediate folder levels
#                     (inversion, interval quality, chord type, diatonic set …)
#   Lesson          – leaf node; owns one or more Exercises
# ---------------------------------------------------------------------------


class Category(models.Model):
    """Top-level curriculum category."""

    TONAL = "tonal"
    RHYTHM = "rhythm"
    DICTATES = "dictates"

    CATEGORY_CHOICES = [
        (TONAL, "Tonal"),
        (RHYTHM, "Rhythm"),
        (DICTATES, "Dictates"),
    ]

    name = models.CharField(max_length=20, choices=CATEGORY_CHOICES, unique=True)
    label = models.CharField(max_length=60, blank=True)  # human-readable override

    class Meta:
        verbose_name_plural = "categories"
        ordering = ["name"]

    def __str__(self):
        return self.get_name_display()


class Approach(models.Model):
    """
    Absolute vs. Relative — the primary split inside the Tonal category.
    Other categories (Rhythm, Dictates) may have a single default approach.
    """

    ABSOLUTE = "absolute"
    RELATIVE = "relative"

    APPROACH_CHOICES = [
        (ABSOLUTE, "Absolute"),
        (RELATIVE, "Relative"),
    ]

    category = models.ForeignKey(
        Category, on_delete=models.CASCADE, related_name="approaches"
    )
    name = models.CharField(max_length=20, choices=APPROACH_CHOICES)

    class Meta:
        unique_together = ("category", "name")
        ordering = ["category", "name"]

    def __str__(self):
        return f"{self.category} › {self.get_name_display()}"


class LessonType(models.Model):
    """
    Named curriculum strand within an Approach.

    Examples (from the JSON):
        Absolute formula, Absolute formula inverse, Absolute intervals,
        Absolute chords - thirds, Absolute chords - sevenths, Absolute base,
        Relative formula, Tonality base, Tonal triads
    """

    approach = models.ForeignKey(
        Approach, on_delete=models.CASCADE, related_name="lesson_types"
    )
    name = models.CharField(max_length=100)
    slug = models.SlugField(max_length=120)
    order = models.PositiveSmallIntegerField(default=0)

    class Meta:
        unique_together = ("approach", "slug")
        ordering = ["approach", "order", "name"]

    def __str__(self):
        return f"{self.approach} › {self.name}"


class Key(models.Model):
    """
    Musical key / tonality used in Relative exercises.
    Absolute exercises are key-independent and leave this NULL.

    Examples: C Major, A Minor, F# Major, B♭ Minor
    """

    MAJOR = "major"
    MINOR = "minor"

    MODE_CHOICES = [
        (MAJOR, "Major"),
        (MINOR, "Minor"),
    ]

    # Tonic note name in English notation (C, D, E♭, F#, G, A♭, B …)
    tonic = models.CharField(max_length=4)
    mode = models.CharField(max_length=5, choices=MODE_CHOICES)
    # Shorthand used in folder names: "CMajor", "AMinor", "FisMajor" …
    folder_code = models.CharField(max_length=20, unique=True)

    class Meta:
        unique_together = ("tonic", "mode")
        ordering = ["tonic", "mode"]

    def __str__(self):
        return f"{self.tonic} {self.get_mode_display()}"


class LessonGroup(models.Model):
    """
    Self-referential tree node representing any intermediate folder level
    between a LessonType (or Key) and the individual Lesson leaves.

    Covers everything the JSON nests inside a LessonType, e.g.:
        Octave / Quinta / Extended          (formula range)
        Notal / Numeric                     (notation style)
        Lessons / <key folder>              (per-key grouping)
        Major / Minor / Povecani / Smanjeni (chord quality)
        53 / 63 / 64 / 2 / 43 / 65 / 7     (chord inversion)
        Mala / Velika / Cista / Povecana    (interval quality)
        Seconds / Thirds / Fourths … Eights (interval type)
        Dijatonika                          (diatonic set)
        Full / Primary                      (completeness)
        1_AF-8_1_dio … leaf-level groups    (individual exercise sets)

    Attach a Key when the group is key-specific (Relative branch).
    """

    lesson_type = models.ForeignKey(
        LessonType,
        on_delete=models.CASCADE,
        related_name="root_groups",
        null=True,
        blank=True,
        help_text="Set only on root-level groups (direct children of a LessonType).",
    )
    parent = models.ForeignKey(
        "self",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="children",
    )
    key = models.ForeignKey(
        Key,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="groups",
        help_text="Populated for groups that belong to a specific tonality.",
    )
    name = models.CharField(max_length=120)
    # Preserves the original folder name for round-trip fidelity
    folder_name = models.CharField(max_length=200, blank=True)
    order = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ["order", "name"]

    def __str__(self):
        if self.parent:
            return f"{self.parent} › {self.name}"
        if self.lesson_type:
            return f"{self.lesson_type} › {self.name}"
        return self.name

    @property
    def depth(self):
        """Distance from the root (0 = direct child of a LessonType)."""
        d = 0
        node = self
        while node.parent is not None:
            d += 1
            node = node.parent
        return d


class Lesson(models.Model):
    """
    A single lesson leaf — the lowest level of the curriculum tree.

    Corresponds to one leaf folder in the JSON (value = {}).
    Each lesson belongs to exactly one LessonGroup and is linked to
    zero or more Exercises.
    """

    group = models.ForeignKey(
        LessonGroup, on_delete=models.CASCADE, related_name="lessons"
    )
    # Original folder / file name kept for matching with converted MIDI files
    folder_name = models.CharField(max_length=200)
    # Human-readable title derived from folder_name (populated by import script)
    title = models.CharField(max_length=200, blank=True)
    order = models.PositiveSmallIntegerField(default=0)

    exercises = models.ManyToManyField(
        Exercise,
        blank=True,
        related_name="lessons",
    )

    created = models.DateTimeField(auto_now_add=True)
    modified = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["order", "folder_name"]
        unique_together = ("group", "folder_name")

    def __str__(self):
        return f"{self.group} › {self.title or self.folder_name}"