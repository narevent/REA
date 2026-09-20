"""
How an exercise is *laid out and paced* — as opposed to what its notes are.

Two systems, one set of answers.  A relative lesson and an absolute one are
different tables with different identities, but "how far apart do the bars
sit", "is there a comma between these two notes", "are the stems drawn" are
the same questions in both, with the same answers, and a teacher moving
between them should not meet two dialects of the same settings.  So the fields
are declared once, as abstract models each concrete table inherits.

Nearly all of them come from the source JSON the library was imported from —
``mid_bar_space``, ``separator_time``, ``are_all_notes_same_duration`` and the
rest were in every file and were dropped on the way in, because nothing drew
them.  They keep their original names here, so a file re-imported later lands
in the field it came from rather than in a renamed approximation of it.

A *style* (see ``ScoreStyle`` in ``rea_api.models``) is a named bundle of
exactly these values.  Applying one copies them onto the exercise: an exercise
therefore always carries its own complete appearance and never depends on a
row somebody else may edit or delete, and a teacher can change one exercise
without changing every exercise that shares its look.
"""

from __future__ import annotations

from django.db import models


class Separator(models.TextChoices):
    """What is drawn between two notes, and what it does to the playback.

    ``APOSTROPHE`` is the one the imported library uses — a breath mark,
    thousands of them, dropped by the importer because the schema had nowhere
    to put it.  The others are the marks a teacher asked for beside it: a
    phrase end that is not a bar end, a dashed hint, a tick over a note worth
    pointing at.
    """

    NONE = "", "None"
    APOSTROPHE = "apostrophe", "Apostrophe (breath)"
    THIN = "thin", "Thin barline"
    THICK = "thick", "Thick barline"
    DOUBLE = "double", "Double barline"
    DASHED = "dashed", "Dashed barline"
    MARKER = "marker", "Marker"


class Notehead(models.TextChoices):
    """The shape of one notehead.  Empty is the ordinary oval."""

    NORMAL = "", "Normal"
    CROSS = "cross", "Cross"
    DIAMOND = "diamond", "Diamond"
    TRIANGLE = "triangle", "Triangle"
    SQUARE = "square", "Square"
    SLASH = "slash", "Slash"


class NoteLabel(models.TextChoices):
    """What is written under each notehead, if anything.

    The degree is what this curriculum is about and is what the source stores
    per note (``alias``).  The letters are for the chapters that teach naming,
    and the Roman numerals for the harmonic ones, where a bar is a function
    rather than a pitch.
    """

    NONE = "", "Nothing"
    DEGREE = "degree", "Scale degrees"
    LETTER = "letter", "Note names"
    LETTER_OCTAVE = "letter_octave", "Note names with octave"
    ROMAN = "roman", "Roman numerals"


class BarNumber(models.TextChoices):
    NONE = "none", "None"
    ALL = "all", "Every bar"
    ROW = "row", "First bar of each line"


class StyledScore(models.Model):
    """The layout and pacing fields every exercise and every style carries."""

    class Meta:
        abstract = True

    # -- on the page -------------------------------------------------------
    mid_bar_space = models.PositiveSmallIntegerField(
        default=22,
        help_text="Whitespace between two bars on the page, in pixels.",
    )
    bars_per_row = models.PositiveSmallIntegerField(
        default=0,
        help_text="Bars on each line; 0 fits as many as the width allows.",
    )
    align_to_center = models.BooleanField(
        default=False,
        help_text="Centre each line rather than starting it at the left margin.",
    )
    auto_align = models.BooleanField(
        default=False,
        help_text="Stretch each line to the full width. Off leaves bars at their natural width.",
    )
    draw_only_note_heads = models.BooleanField(
        default=False,
        help_text="Hide stems, flags and beams — the eye stays on where the note sits.",
    )
    are_all_notes_same_duration = models.BooleanField(
        default=False,
        help_text="Draw every note as the same value. What is played is unchanged.",
    )
    separator_space = models.PositiveSmallIntegerField(
        default=14,
        help_text="Whitespace around a separator on the page, in pixels.",
    )
    note_label_type = models.CharField(
        max_length=16, choices=NoteLabel.choices, default=NoteLabel.NONE, blank=True,
    )
    bar_number_type = models.CharField(
        max_length=8, choices=BarNumber.choices, default=BarNumber.NONE,
    )

    # -- in the ear --------------------------------------------------------
    mid_bar_time = models.FloatField(
        default=0.1,
        help_text="Silence after each bar, in seconds.",
    )
    mute_last_played_notes_after_bar_finishes = models.BooleanField(
        default=False,
        help_text=(
            "Cut the last note of a bar at the barline. Off lets it ring into "
            "the gap, which is what makes a phrase carry across the bar."
        ),
    )
    separator_time = models.FloatField(
        default=0.0,
        help_text="Silence at a separator, in seconds.",
    )
    separator_cancel_previous_note = models.BooleanField(
        default=False,
        help_text="Cut the note before a separator rather than letting it ring through it.",
    )


class SeparatedEvent(models.Model):
    """The two things a note can say about how it is *drawn*, as opposed to
    what it sounds: the mark that follows it, and the shape of its head."""

    class Meta:
        abstract = True

    separator = models.CharField(
        max_length=16, choices=Separator.choices, default=Separator.NONE, blank=True,
        help_text="A mark drawn after this note — a breath, a phrase line, a tick.",
    )
    notehead = models.CharField(
        max_length=16, choices=Notehead.choices, default=Notehead.NORMAL, blank=True,
    )


#: Every field a style carries, in the order a panel should show them.  Used by
#: the editor API and by ``ScoreStyle.apply_to`` so the list lives once.
STYLE_FIELDS = (
    "mid_bar_space", "bars_per_row", "align_to_center", "auto_align",
    "draw_only_note_heads", "are_all_notes_same_duration",
    "separator_space", "note_label_type", "bar_number_type",
    "mid_bar_time", "mute_last_played_notes_after_bar_finishes",
    "separator_time", "separator_cancel_previous_note",
)


#: The source measures the gap between bars in its own unit, and writes 3 for
#: every file in the library.  The renderer has always drawn that gap as 22
#: pixels, so one source unit is a little over seven of them — which is how a
#: re-imported lesson keeps the spacing it has always been drawn with.
SOURCE_SPACE_PX = 22 / 3


def style_from_source(data: dict) -> dict:
    """The style settings a source JSON file carries, as model kwargs.

    Every one of these was in the files from the beginning and none of them
    survived the import: the bars were drawn with the renderer's own spacing,
    the separators were dropped, and a lesson written to hold its last note
    across the barline played it short like any other.  Read here so that a
    re-import brings a lesson's appearance with its notes.
    """
    return {
        "mid_bar_space": int(round(float(data.get("mid_bar_space", 3) or 3) * SOURCE_SPACE_PX)),
        "align_to_center": bool(data.get("align_to_center", False)),
        "auto_align": bool(data.get("auto_align", False)),
        "draw_only_note_heads": bool(data.get("draw_only_note_heads", False)),
        "are_all_notes_same_duration": bool(data.get("are_all_notes_same_duration", False)),
        "bar_number_type": str(data.get("bar_number_type", "none") or "none"),
        "mid_bar_time": float(data.get("mid_bar_time", 0.1) or 0.1),
        "mute_last_played_notes_after_bar_finishes": bool(
            data.get("mute_last_played_notes_after_bar_finishes", False)
        ),
        "separator_time": float(data.get("separator_time", 0.0) or 0.0),
        "separator_cancel_previous_note": bool(
            data.get("separator_cancel_previous_note", False)
        ),
    }
