"""
Key-generation service.

Turns a parsed ``key_models`` JSON file into :class:`ScaleModel`,
:class:`KeyModel`, :class:`Bar` and :class:`MusicEvent` rows.

A key-model file is the *reference* template for a key: its 7 (or 9 for
minor keys, where the harmonic/melodic variants are appended) bars each
hold one ``music_event`` describing the diatonic scale degree.  The bars
also carry the ``incdec`` key-signature accidentals.

From a key model we derive:

* a :class:`ScaleModel` (mode + reference key) with a single
  :class:`ScaleModelTiming` / :class:`ScaleModelPitch` per degree;
* a :class:`KeyModel` with the normalised ``key_signature``;
* one :class:`Bar` per sequence entry, with its :class:`MusicEvent`.
"""

from __future__ import annotations

from typing import Iterable, Optional

from ..models import (
    Bar,
    KeyModel,
    MusicEvent,
    ScaleModel,
    ScaleModelPitch,
    ScaleModelTiming,
)
from ..utils.note_parser import LETTER_PC, parse_note, resolve_pitch_class
from .json_import import KeyName, RawBar, RawMusicStrain, parse_key_name, parse_music_strain

# Mode -> ordered interval stack (semitones from the tonic) for the natural
# degrees 1..7.  Harmonic/melodic minor raise the 6th/7th degrees; those
# *extra* degrees are captured by the source's extra bars rather than by
# this stack (used only to label the natural template).
_MODE_INTERVALS = {
    "Major": [0, 2, 4, 5, 7, 9, 11],
    "Minor": [0, 2, 3, 5, 7, 8, 10],
}


def _normalise_key_signature(incdec_items: Iterable) -> list[dict]:
    """Turn raw IncDec objects into a JSON-serialisable key-signature list."""
    out: list[dict] = []
    for item in incdec_items:
        tok = parse_note(item.name)
        offset = tok.modifier_offset
        if tok.modifier == "r":
            offset = 0
        out.append({"name": item.name, "letter": tok.letter, "offset": offset})
    # Deduplicate by letter (key signatures shouldn't repeat a letter).
    seen: dict[str, dict] = {}
    for entry in out:
        seen[entry["letter"]] = entry
    return list(seen.values())


def _quality_for(bar_index: int, degree: int, is_enharmonic: bool) -> str:
    """Heuristic quality label for an extra (raised) degree."""
    if not is_enharmonic:
        return ScaleModelTiming.Quality.RAISED
    return ScaleModelTiming.Quality.NATURAL


def import_key_model(data: dict, filename: str, *, clear: bool = True) -> KeyModel:
    """Import a single ``key_models`` JSON blob into the database.

    Returns the created/updated :class:`KeyModel`.
    """
    key_name: KeyName = parse_key_name(filename)
    strain: RawMusicStrain = parse_music_strain(data)

    scale_model, _ = ScaleModel.objects.get_or_create(
        mode=key_name.mode,
        reference_key=key_name.music_mode_chord,
        defaults={
            "clef": strain.default_music_clef,
            "default_rhythm": data.get("default_music_rhythm", "FreeStyle"),
            "draw_only_note_heads": data.get("draw_only_note_heads", True),
        },
    )

    if clear:
        # Remove previous bars/events for an idempotent re-import.
        KeyModel.objects.filter(name=key_name.display).delete()

    # Take the key signature from the first bar that has one.
    incdec_items: list = []
    for b in strain.bars:
        if b.incdec:
            incdec_items = b.incdec
            break
    key_signature = _normalise_key_signature(incdec_items)

    key_model = KeyModel.objects.create(
        scale_model=scale_model,
        name=key_name.display,
        mode=key_name.mode,
        root_pitch_class=key_name.root_pitch_class,
        root_octave=1,
        key_signature=key_signature,
        default_rhythm=data.get("default_music_rhythm", "FreeStyle"),
        draw_only_note_heads=data.get("draw_only_note_heads", True),
        tempo=int(data.get("tempo", 4) or 4),
    )

    intervals = _MODE_INTERVALS.get(key_name.mode, _MODE_INTERVALS["Major"])
    seen_degrees: set[tuple[int, str]] = set()

    for bar_index, raw_bar in enumerate(strain.bars):
        ev = raw_bar.events[0] if raw_bar.events else None
        if ev is None or ev.note is None:
            continue

        alias = ev.note.alias
        # alias is the scale-degree label (1..7, possibly repeated for
        # harmonic/melmonic variants).
        try:
            degree_int = int(alias)
        except (TypeError, ValueError):
            degree_int = (bar_index % 7) + 1

        is_enharmonic = ev.note.is_enharmonic
        # Determine quality: the *first* occurrence of a degree is "natural",
        # a *later* (enharmonic=False) occurrence of the same degree is a
        # raised/lowered variant.
        key = (degree_int, "")
        quality = ScaleModelTiming.Quality.NATURAL
        if (degree_int, is_enharmonic) in seen_degrees or not is_enharmonic:
            quality = (
                ScaleModelTiming.Quality.RAISED
                if not is_enharmonic
                else ScaleModelTiming.Quality.NATURAL
            )
        # Mark raised variants by appending the bar index so they stay unique.
        if not is_enharmonic and (degree_int, True) in seen_degrees:
            quality = ScaleModelTiming.Quality.RAISED
        seen_degrees.add((degree_int, is_enharmonic))

        # --- ScaleModel templates (idempotent) -----------------------------
        if not ScaleModelTiming.objects.filter(
            scale_model=scale_model, sequence_index=bar_index, quality=quality
        ).exists():
            ScaleModelTiming.objects.create(
                scale_model=scale_model,
                degree=degree_int,
                quality=quality,
                sequence_index=bar_index,
                offset_ms=ev.horizontal_offset_ms,
                duration=ev.duration,
            )
        # Pitch template (one per degree+quality).
        interval = (
            intervals[(degree_int - 1) % len(intervals)]
            if degree_int - 1 < len(intervals)
            else 0
        )
        if not ScaleModelPitch.objects.filter(
            scale_model=scale_model, degree=degree_int, quality=quality
        ).exists():
            ScaleModelPitch.objects.create(
                scale_model=scale_model,
                degree=degree_int,
                quality=quality,
                interval_semitones=interval,
                reference_note_name=ev.note.name,
            )

        # --- Key bar + event ----------------------------------------------
        bar = Bar.objects.create(
            key_model=key_model,
            bar_index=bar_index,
            degree=str(alias),
            quality=quality,
            music_clef=raw_bar.music_clef,
            music_rhythm=raw_bar.music_rhythm,
            music_mode_chord=raw_bar.music_mode_chord,
            is_incomplete_bar=raw_bar.is_incomplete_bar,
            incomplete_bar_playback_count=raw_bar.incomplete_bar_playback_count,
        )
        pc = resolve_pitch_class(parse_note(ev.note.name), incdec_items)
        MusicEvent.objects.create(
            bar=bar,
            event_index=0,
            horizontal_offset_ms=ev.horizontal_offset_ms,
            visual_offset_px=ev.visual_offset_px,
            duration=ev.duration,
            attack_decay_time=ev.attack_decay_time,
            volume=ev.volume,
            note_name=ev.note.name,
            alias_degree=str(alias),
            is_rest=ev.note.is_rest,
            is_enharmonic=is_enharmonic,
            event_type=ev.event_type,
            pitch_class=pc,
        )

    return key_model