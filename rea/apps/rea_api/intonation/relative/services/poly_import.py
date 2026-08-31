"""
Polyphonic (harmonic) lesson import for the relative domain.

Poly lessons live under ``relative/lessons/poly`` and train harmonic hearing
*within a key*: diatonic triads and seventh chords in all figured-bass
inversions, diatonic intervals, and the tonal-trichord formula.  The tree is::

    poly/ChordsThirds/<Mode>/<53|63|64>/<KeyFolder>/Diatonic/<file>.json
    poly/ChordsSevenths/<Mode>/<7|65|43|2>/<KeyFolder>/Diatonic/<file>.json
    poly/Intervals/<Thirds..Sevenths>/<Mode>/<KeyFolder>/Diatonic/<file>.json
    poly/Formula/<Mode>/<KeyFolder>/Diatonic/<file>.json

Filenames encode ``<order>_<sub>_T..._<Key>_<part>_part_<F|ABC>.json`` where
*sub* selects the presentation variant:

    1  guided model — chord walk-up through scale steps / interval with tonic
    2  plain chord/interval tones
    3  letter-name (ABC) notation

Only files inside a ``Diatonic`` folder are imported (a few stray duplicates
exist directly in key folders), and ``_``-prefixed files are template/backup
copies whose content names a different key — both are skipped.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

from ..models import Bar, KeyModel, Lesson, MusicEvent
from ..utils.note_parser import parse_note, resolve_pitch_class
from .json_import import key_name_from_folder, parse_music_strain

_CHORD_CATEGORIES = {"ChordsThirds", "ChordsSevenths"}
_INTERVAL_NAMES = {"Thirds", "Fourths", "Fifths", "Sixths", "Sevenths"}
_PART_RE = re.compile(r"(\d+(?:-\d+)?)_part")
_ORDER_SUB_RE = re.compile(r"^(\d+)_(\d+)_")


@dataclass
class PolyMeta:
    category: str  # Formula / ChordsThirds / ChordsSevenths / Intervals
    inversion: str  # 53/63/64/7/65/43/2 or ""
    interval_name: str  # Thirds..Sevenths or ""
    part: str  # 1, 2, 1-2, 3, 1-3
    variant: str  # v<sub>_<F|ABC>[+T]


def parse_poly_path(path: str) -> Optional[PolyMeta]:
    """Derive :class:`PolyMeta` from a relative poly lesson path.

    Returns ``None`` when the path is not a valid poly lesson (template
    files, stray duplicates outside ``Diatonic``, unknown layout).
    """
    parts = [p for p in path.replace("\\", "/").split("/") if p]
    if "poly" not in parts:
        return None
    fname = parts[-1]
    if fname.startswith("_"):
        return None  # template/backup copy — content names a different key
    if len(parts) < 3 or parts[-2] != "Diatonic":
        return None  # stray duplicates live directly in key folders

    i = parts.index("poly")
    try:
        category = parts[i + 1]
    except IndexError:
        return None

    inversion = ""
    interval_name = ""
    if category in _CHORD_CATEGORIES:
        # poly/<category>/<Mode>/<inversion>/<Key>/Diatonic/<file>
        if len(parts) < i + 6:
            return None
        inversion = parts[i + 3]
        if not inversion.isdigit():
            return None
    elif category == "Intervals":
        # poly/Intervals/<IntervalName>/<Mode>/<Key>/Diatonic/<file>
        if len(parts) < i + 6:
            return None
        interval_name = parts[i + 2]
        if interval_name not in _INTERVAL_NAMES:
            return None
    elif category == "Formula":
        # poly/Formula/<Mode>/<Key>/Diatonic/<file>
        pass
    else:
        return None

    stem = fname[:-5] if fname.endswith(".json") else fname
    m_sub = _ORDER_SUB_RE.match(stem)
    m_part = _PART_RE.search(stem)
    if not m_sub or not m_part:
        return None
    sub = m_sub.group(2)
    notation = "ABC" if stem.endswith("ABC") else "F"
    plus_t = "+T" in stem
    variant = f"v{sub}_{notation}" + ("+T" if plus_t else "")

    return PolyMeta(
        category=category,
        inversion=inversion,
        interval_name=interval_name,
        part=m_part.group(1),
        variant=variant,
    )


def import_poly_lesson(data: dict, filename: str, *, clear: bool = True) -> Optional[Lesson]:
    """Import a relative poly lesson JSON blob.

    Returns the created :class:`Lesson`, or ``None`` when the path does not
    parse or the referenced key model does not exist yet.
    """
    meta = parse_poly_path(filename)
    if meta is None:
        return None
    key_name = key_name_from_folder(filename)
    if key_name is None:
        return None
    try:
        key_model = KeyModel.objects.get(name=key_name.display)
    except KeyModel.DoesNotExist:
        return None

    identity = dict(
        key_model=key_model,
        texture=Lesson.Texture.POLY,
        formula_name="",
        category=meta.category,
        inversion=meta.inversion,
        interval_name=meta.interval_name,
        part=meta.part,
        variant=meta.variant,
    )
    if clear:
        Lesson.objects.filter(**identity).delete()

    lesson = Lesson.objects.create(
        **identity,
        source_file=filename,
        tempo=int(data.get("tempo", 86) or 86),
        draw_only_note_heads=bool(data.get("draw_only_note_heads", False)),
        default_rhythm=data.get("default_music_rhythm", "FreeStyle"),
        mid_bar_time=float(data.get("mid_bar_time", 0.1) or 0.1),
        raw=data,
    )

    strain = parse_music_strain(data)
    incdec_blob = _first_incdec(strain) or key_model.key_signature

    for bar_index, raw_bar in enumerate(strain.bars):
        bar = Bar.objects.create(
            lesson=lesson,
            bar_index=bar_index,
            degree="",
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
            alias = note.alias
            alias_label = "" if alias in (None, "", {}) else str(alias)
            MusicEvent.objects.create(
                bar=bar,
                event_index=ev_index,
                horizontal_offset_ms=ev.horizontal_offset_ms,
                visual_offset_px=ev.visual_offset_px,
                duration=ev.duration,
                attack_decay_time=ev.attack_decay_time,
                volume=ev.volume,
                note_name=note.name,
                alias_degree=alias_label,
                is_rest=note.is_rest,
                is_enharmonic=note.is_enharmonic,
                event_type=ev.event_type,
                pitch_class=resolve_pitch_class(parse_note(note.name), incdec_blob),
            )
    return lesson


def _first_incdec(strain):
    for b in strain.bars:
        if b.incdec:
            return b.incdec
    return None
