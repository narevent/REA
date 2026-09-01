"""
The score *document* — the one shape the editor reads and writes.

The practice API exposes lessons as they are stored: a lesson row, its bars,
and their events, each behind its own read-only endpoint.  That is the right
shape for playing an exercise and the wrong one for editing it.  Editing is
whole-score work — inserting a note renumbers its neighbours, deleting a bar
renumbers the bars after it — so the editor sends the entire score back and
the server rewrites the bars and events as one atomic replacement.  Anything
finer grained turns every edit into a diff negotiation between the browser and
the database for no benefit: a lesson is a few dozen notes, not a document
that two people edit at once.

Both intonation systems are handled here.  Their lesson tables differ (a
relative lesson hangs off a key, an absolute lesson off the chromatic base)
but their bars and events are identical field for field, so the document keeps
one shape and only the ``meta`` block changes between systems.
"""

from __future__ import annotations

from django.db import transaction

from ..intonation.absolute import models as absolute_models
from ..intonation.relative import models as relative_models
from ..intonation.relative.utils.note_parser import parse_note, resolve_pitch_class

SYSTEMS = ("relative", "absolute")

# Lesson fields the editor may set, per system.  Everything else on the row is
# either derived (``pitch_class``), structural (``bars``), or import-only
# (``raw``, which is kept untouched so a re-imported lesson keeps its origin).
# `shelf` travels with the identity because that is what it is about: which
# collection a lesson is filed in, and whether it has been filed at all.
RELATIVE_META_FIELDS = (
    "texture", "formula_name", "category", "inversion", "interval_name",
    "part", "variant", "source_file", "tempo", "draw_only_note_heads",
    "default_rhythm", "mid_bar_time", "shelf",
)
ABSOLUTE_META_FIELDS = (
    "texture", "category", "span", "grades", "quality", "interval_size",
    "inversion", "part", "phase", "exercise_number", "exercise_type",
    "timed", "chromatic", "source_file", "tempo", "draw_only_note_heads",
    "default_rhythm", "mid_bar_time", "shelf",
)

BAR_FIELDS = (
    "music_clef", "music_rhythm", "music_mode_chord",
    "is_incomplete_bar", "incomplete_bar_playback_count", "label",
)
# Relative bars additionally carry the scale degree they are built on.
RELATIVE_BAR_FIELDS = ("degree", "quality")

EVENT_FIELDS = (
    "horizontal_offset_ms", "visual_offset_px", "duration", "attack_decay_time",
    "volume", "note_name", "alias_degree", "is_rest", "is_enharmonic", "event_type",
    "tuplet_num", "tuplet_den",
)


def models_for(system):
    """The models module for a system name."""
    return relative_models if system == "relative" else absolute_models


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------

def event_document(event):
    return {
        "event_index": event.event_index,
        "note_name": event.note_name,
        "alias_degree": event.alias_degree,
        "duration": event.duration,
        "horizontal_offset_ms": event.horizontal_offset_ms,
        "visual_offset_px": event.visual_offset_px,
        "tuplet_num": event.tuplet_num,
        "tuplet_den": event.tuplet_den,
        "attack_decay_time": event.attack_decay_time,
        "volume": event.volume,
        "is_rest": event.is_rest,
        "is_enharmonic": event.is_enharmonic,
        "event_type": event.event_type,
        "pitch_class": event.pitch_class,
    }


def bar_document(bar, system):
    doc = {"bar_index": bar.bar_index}
    for field in BAR_FIELDS:
        doc[field] = getattr(bar, field)
    if system == "relative":
        for field in RELATIVE_BAR_FIELDS:
            doc[field] = getattr(bar, field)
    doc["events"] = [event_document(e) for e in bar.events.all()]
    return doc


def lesson_document(lesson, system):
    """The full editable document for one lesson."""
    meta_fields = RELATIVE_META_FIELDS if system == "relative" else ABSOLUTE_META_FIELDS
    meta = {f: getattr(lesson, f) for f in meta_fields}
    doc = {
        "system": system,
        "id": lesson.pk,
        "display_name": lesson.display_name,
        "meta": meta,
        "bars": [
            bar_document(bar, system)
            for bar in lesson.bars.prefetch_related("events").order_by("bar_index")
        ],
    }
    if system == "relative":
        doc["key_model"] = lesson.key_model_id
        doc["key_model_name"] = lesson.key_model.name
        doc["key_signature"] = lesson.key_model.key_signature
        doc["mode"] = lesson.key_model.mode
    else:
        doc["base"] = lesson.base_id
        doc["key_signature"] = []
    return doc


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------

def key_signature_for(lesson, system):
    """The key signature a note's pitch is resolved against.

    Absolute lessons have no key, so an absolute note means exactly what its
    own token says.
    """
    if system == "relative" and lesson.key_model_id:
        return lesson.key_model.key_signature or []
    return []


def resolve_event_pitch_class(note_name, is_rest, key_signature):
    """The absolute pitch class (0-11) a note sounds at, or -1 for a rest.

    Stored on the row rather than computed at playback time because that is
    what the practice frontend already reads (``practiceData.midiFromEvent``),
    and because it is the one value an editor can silently get wrong: an
    unaltered ``f`` in G major sounds F♯, and the note token alone does not
    say so.
    """
    if is_rest or not note_name:
        return -1
    return resolve_pitch_class(parse_note(note_name), key_signature)


@transaction.atomic
def write_bars(lesson, system, bars, key_signature=None):
    """Replace a lesson's bars and events with *bars* (already validated).

    Indices are assigned from list position, so the client never has to keep
    ``bar_index`` / ``event_index`` consistent while the teacher drags things
    around — order in the document *is* the order.
    """
    mods = models_for(system)
    if key_signature is None:
        key_signature = key_signature_for(lesson, system)

    lesson.bars.all().delete()
    for bar_index, bar_data in enumerate(bars):
        fields = {f: bar_data.get(f) for f in BAR_FIELDS if bar_data.get(f) is not None}
        if system == "relative":
            for f in RELATIVE_BAR_FIELDS:
                if bar_data.get(f) is not None:
                    fields[f] = bar_data[f]
        bar = mods.Bar.objects.create(lesson=lesson, bar_index=bar_index, **fields)

        events = []
        for event_index, event_data in enumerate(bar_data.get("events") or []):
            values = {f: event_data.get(f) for f in EVENT_FIELDS if f in event_data}
            values.setdefault("event_type", "MusicNoteBundle")
            is_rest = bool(values.get("is_rest"))
            if is_rest:
                values["note_name"] = values.get("note_name") or ""
            values["pitch_class"] = resolve_event_pitch_class(
                values.get("note_name"), is_rest, key_signature
            )
            events.append(mods.MusicEvent(bar=bar, event_index=event_index, **values))
        if events:
            mods.MusicEvent.objects.bulk_create(events)
    return lesson


# ---------------------------------------------------------------------------
# Defaults for a brand-new exercise
# ---------------------------------------------------------------------------

# German key names as used by the key models ("As-dur", "Fis-mol") map to the
# `music_mode_chord` the renderer reads for its key signature ("As_Major").
_MODE_SUFFIX = {"dur": "Major", "mol": "Minor"}


def mode_chord_for_key(key_model):
    """``music_mode_chord`` for a key model, e.g. 'As-dur' -> 'As_Major'."""
    name = key_model.name or ""
    if "-" in name:
        root, _, suffix = name.partition("-")
        mode = _MODE_SUFFIX.get(suffix.lower())
        if mode:
            return f"{root}_{mode}"
    return f"{name}_{key_model.mode}" if name else ""


def blank_bar(system, mode_chord=""):
    """A single empty bar, ready for the teacher's first note."""
    bar = {
        "bar_index": 0,
        "music_clef": "Violin",
        "music_rhythm": "FreeStyle",
        "music_mode_chord": mode_chord,
        "is_incomplete_bar": False,
        "incomplete_bar_playback_count": 0,
        "label": "",
        "events": [],
    }
    if system == "relative":
        bar["degree"] = ""
        bar["quality"] = "natural"
    return bar
