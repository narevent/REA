"""
Lesson-generation service.

Lessons ("formulas") are sequencing recipes built on top of a
:class:`KeyModel`.  The source ``lessons`` JSON files already contain the
fully-resolved note names for *one* concrete key, but the recipe itself is
expressed purely in terms of **scale-degree aliases** (the ``alias`` field on
each ``music_note``).  That makes a formula key-independent.

This module does two things:

1. :func:`import_lesson` – import a single lesson JSON file into the
   database, attaching it to the matching :class:`KeyModel` and storing its
   bars/events (with the degree recipe) for later regeneration.
2. :func:`generate_lesson_for_key` – regenerate a stored lesson in a
   *different* key by replaying its degree recipe against the target key's
   scale degrees.  This is the "later add them automatically" capability
   referenced in the project brief.
"""

from __future__ import annotations

from typing import Optional

from ..models import Bar, Lesson, KeyModel, MusicEvent
from ..utils.note_parser import parse_note, resolve_pitch_class
from .json_import import (
    key_name_from_folder,
    key_name_from_mode_chord,
    parse_key_name,
    parse_music_strain,
)
from .key_generation import import_key_model  # noqa: F401  (re-export convenience)


# ---------------------------------------------------------------------------
# Degree-recipe extraction
# ---------------------------------------------------------------------------

def _normalize_degree_label(alias) -> str:
    """Normalise a source ``alias`` into a stable degree label string.

    The source uses plain ints (``1``, ``5``), but also string decorations
    such as ``5'`` (fifth above) and ``5,`` (fifth below).  We keep those
    verbatim as labels – they carry octave-direction information that the
    regenerator needs.
    """
    if alias is None or alias == "":
        return ""
    if isinstance(alias, (int, float)):
        return str(int(alias))
    return str(alias)


def _degree_to_int(label: str) -> Optional[int]:
    """Return the integer degree part of a label (e.g. ``5'`` -> 5)."""
    if not label:
        return None
    digits = "".join(ch for ch in label if ch.isdigit())
    return int(digits) if digits else None


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

def _detect_formula_variant(path: str) -> tuple[str, str]:
    """Derive (formula_name, variant) from a lesson file path.

    Convention in the source tree::

        lessons/<Mode>/<FormulaFamily>/<KeyFolder>/<lesson-folder>/<file>.json

    *Formula family* is the ``Octave`` / ``Quinta`` / ``Extended`` folder.
    *Variants* come from two places and are combined so every lesson is
    uniquely identified:

    1. The *lesson folder* name may contain an ``AL 1`` (or ``Al 1``)
       marker – an alternative lesson version distinct from the base.
    2. The *file* name may contain ``SKALA`` / ``ABC`` / ``KROM`` /
       ``svi modeli`` – the notation/coverage variant.

    Examples::

        .../1_ C-dur formula 8/1_1_1_C-dur_formula_8.json          -> ("Octave", "")
        .../1_ C-dur formula 8/1_1_3_ C-dur formula SKALA 8.json    -> ("Octave", "SKALA")
        .../1_2_ C-dur AL 1 formula 8/BR_1_2_1_..._8.json          -> ("Octave", "AL1")
        .../1_2_ C-dur AL 1 formula 8/BR_1_2_2_..._ABC 8.json     -> ("Octave", "AL1-ABC")
        .../3_2_ C-dur AL 1 formula PR/BR_3_2_4_..._svi modeli ABC PR.json
                                                                   -> ("Extended", "AL1-svi_modeli_ABC")
    """
    import re

    parts = [p for p in path.replace("\\", "/").split("/") if p]
    formula = "Formula"
    for p in parts:
        if p.lower() in {"octave", "quinta", "extended"}:
            formula = p.capitalize()
            break

    # The lesson folder is the second-to-last path component (parent dir).
    folder = parts[-2] if len(parts) >= 2 else ""
    al_marker = ""
    al_match = re.search(r"\bAL\b\s*1", folder, re.IGNORECASE) or re.search(
        r"\bAl\b\s*1", folder, re.IGNORECASE
    )
    if al_match:
        al_marker = "AL1"

    # File-level notation variant.  Normalize whitespace so the double-space
    # in some source names ("svi  modeli") is handled.
    fname = parts[-1] if parts else ""
    fname_norm = re.sub(r"\s+", " ", fname).lower()
    file_variant = ""
    if "svi modeli" in fname_norm:
        file_variant = "svi_modeli_ABC" if "abc" in fname_norm else "svi_modeli"
    elif "krom" in fname_norm and "skala" in fname_norm:
        file_variant = "KROM_SKALA"
    elif "skala" in fname_norm:
        file_variant = "SKALA"
    elif "abc" in fname_norm:
        file_variant = "ABC"

    variant = "-".join([m for m in (al_marker, file_variant) if m])
    return formula, variant


def import_lesson(data: dict, filename: str, *, clear: bool = True) -> Optional[Lesson]:
    """Import a lesson JSON blob, attaching it to the matching KeyModel.

    Returns the created :class:`Lesson`, or ``None`` if the referenced key
    does not exist yet (import key models first).
    """
    # Derive the key name.  The lesson *folder* (e.g. ``AsMajor``) is the
    # authoritative owner — some folders also contain ``__``-prefixed template
    # files whose JSON content names a different key, so the folder wins.
    strain = parse_music_strain(data)
    key_name = key_name_from_folder(filename)
    if key_name is None:
        mode_chord = strain.bars[0].music_mode_chord if strain.bars else ""
        key_name = key_name_from_mode_chord(mode_chord) if mode_chord else parse_key_name(filename)
    try:
        key_model = KeyModel.objects.get(name=key_name.display)
    except KeyModel.DoesNotExist:
        return None

    formula, variant = _detect_formula_variant(filename)

    if clear:
        Lesson.objects.filter(
            key_model=key_model, formula_name=formula, variant=variant
        ).delete()

    lesson = Lesson.objects.create(
        key_model=key_model,
        formula_name=formula,
        variant=variant,
        source_file=filename,
        tempo=int(data.get("tempo", 86) or 86),
        draw_only_note_heads=bool(data.get("draw_only_note_heads", False)),
        default_rhythm=data.get("default_music_rhythm", "FreeStyle"),
        mid_bar_time=float(data.get("mid_bar_time", 0.1) or 0.1),
        raw=data,
    )

    strain = parse_music_strain(data)
    # Reuse the key's key signature for pitch resolution.
    incdec_blob = _incdec_blob_from_raw(strain) or key_model.key_signature

    for bar_index, raw_bar in enumerate(strain.bars):
        bar = Bar.objects.create(
            lesson=lesson,
            bar_index=bar_index,
            degree=",".join(_normalize_degree_label(ev.note.alias) for ev in raw_bar.events if ev.note),
            quality="natural",
            music_clef=raw_bar.music_clef,
            music_rhythm=raw_bar.music_rhythm,
            music_mode_chord=raw_bar.music_mode_chord,
            is_incomplete_bar=raw_bar.is_incomplete_bar,
            incomplete_bar_playback_count=raw_bar.incomplete_bar_playback_count,
            label=raw_bar.label,
        )
        for ev_index, ev in enumerate(raw_bar.events):
            note = ev.note
            if note is None:
                continue
            pc = resolve_pitch_class(parse_note(note.name), incdec_blob)
            MusicEvent.objects.create(
                bar=bar,
                event_index=ev_index,
                horizontal_offset_ms=ev.horizontal_offset_ms,
                visual_offset_px=ev.visual_offset_px,
                duration=ev.duration,
                attack_decay_time=ev.attack_decay_time,
                volume=ev.volume,
                note_name=note.name,
                alias_degree=_normalize_degree_label(note.alias),
                is_rest=note.is_rest,
                is_enharmonic=note.is_enharmonic,
                event_type=ev.event_type,
                pitch_class=pc,
            )
    return lesson


def _incdec_blob_from_raw(strain):
    for b in strain.bars:
        if b.incdec:
            return b.incdec
    return None


# ---------------------------------------------------------------------------
# Cross-key regeneration
# ---------------------------------------------------------------------------

def _degree_notes_for_key(key_model: KeyModel) -> dict[str, str]:
    """Map each stored degree label of *key_model* -> its note_name token.

    Uses the key-model's own bars (the scale template) as the lookup, so the
    labels (including ``5'`` / ``5,`` decorations map to the tonic when
    unknown).
    """
    out: dict[str, str] = {}
    for bar in key_model.bars.all():
        for ev in bar.events.all():
            out[bar.degree] = ev.note_name
            out[ev.alias_degree] = ev.note_name
    return out


def generate_lesson_for_key(
    source_lesson: Lesson, target_key: KeyModel, *, clear: bool = True
) -> Lesson:
    """Regenerate *source_lesson* in *target_key*.

    The recipe (alias degrees, rhythms, offsets, volumes) is copied from the
    source lesson; only the note names are re-resolved against the target
    key's scale degrees.
    """
    if clear:
        Lesson.objects.filter(
            key_model=target_key,
            formula_name=source_lesson.formula_name,
            variant=source_lesson.variant,
        ).delete()

    new_ex = Lesson.objects.create(
        key_model=target_key,
        formula_name=source_lesson.formula_name,
        variant=source_lesson.variant,
        source_file=source_lesson.source_file,
        tempo=source_lesson.tempo,
        draw_only_note_heads=source_lesson.draw_only_note_heads,
        default_rhythm=source_lesson.default_rhythm,
        mid_bar_time=source_lesson.mid_bar_time,
        raw={"generated_for": target_key.name, "source": source_lesson.pk},
    )

    degree_map = _degree_notes_for_key(target_key)
    incdec_blob = target_key.key_signature

    for src_bar in source_lesson.bars.all().order_by("bar_index"):
        new_bar = Bar.objects.create(
            lesson=new_ex,
            bar_index=src_bar.bar_index,
            degree=src_bar.degree,
            quality=src_bar.quality,
            music_clef=src_bar.music_clef,
            music_rhythm=src_bar.music_rhythm,
            music_mode_chord=target_key.bars.first().music_mode_chord if target_key.bars.exists() else src_bar.music_mode_chord,
            is_incomplete_bar=src_bar.is_incomplete_bar,
            incomplete_bar_playback_count=src_bar.incomplete_bar_playback_count,
        )
        for src_ev in src_bar.events.all().order_by("event_index"):
            label = src_ev.alias_degree
            base_note = degree_map.get(label) or degree_map.get(str(_degree_to_int(label))) or src_ev.note_name
            pc = resolve_pitch_class(parse_note(base_note), incdec_blob)
            MusicEvent.objects.create(
                bar=new_bar,
                event_index=src_ev.event_index,
                horizontal_offset_ms=src_ev.horizontal_offset_ms,
                visual_offset_px=src_ev.visual_offset_px,
                duration=src_ev.duration,
                attack_decay_time=src_ev.attack_decay_time,
                volume=src_ev.volume,
                note_name=base_note,
                alias_degree=label,
                is_rest=src_ev.is_rest,
                is_enharmonic=src_ev.is_enharmonic,
                event_type=src_ev.event_type,
                pitch_class=pc,
            )
    return new_ex