"""
Lesson-import service for the absolute domain.

Unlike relative lessons, absolute lessons are not key-dependent recipes:
the note names in the source JSON *are* the exercise (absolute pitch is
the whole point), so there is no cross-key regeneration here.  Each file
is attached to the single :class:`ChromaticBase` reference and its
bars/events are stored verbatim.
"""

from __future__ import annotations

from typing import Optional

from ...relative.utils.note_parser import parse_note, resolve_pitch_class
from ..models import Bar, ChromaticBase, Lesson, MusicEvent
from .json_import import parse_lesson_path, parse_music_strain


def _normalize_alias(alias) -> str:
    if alias in (None, "", {}):
        return ""
    if isinstance(alias, (int, float)):
        return str(int(alias))
    return str(alias)


def import_lesson(data: dict, filename: str, *, clear: bool = True) -> Optional[Lesson]:
    """Import an absolute lesson JSON blob.

    Returns the created :class:`Lesson`, or ``None`` when the filename does
    not parse as an absolute lesson or no :class:`ChromaticBase` exists yet
    (import the base first).
    """
    meta = parse_lesson_path(filename)
    if meta is None:
        return None
    base = ChromaticBase.objects.first()
    if base is None:
        return None

    identity = dict(
        texture=meta.texture,
        category=meta.category,
        span=meta.span,
        grades=meta.grades,
        quality=meta.quality,
        interval_size=meta.interval_size,
        inversion=meta.inversion,
        part=meta.part,
        phase=meta.phase,
        exercise_number=meta.exercise_number,
    )
    if clear:
        Lesson.objects.filter(**identity).delete()

    lesson = Lesson.objects.create(
        base=base,
        **identity,
        exercise_type=meta.exercise_type,
        timed=meta.timed,
        chromatic=meta.chromatic,
        source_file=filename,
        tempo=int(data.get("tempo", 86) or 86),
        draw_only_note_heads=bool(data.get("draw_only_note_heads", False)),
        default_rhythm=data.get("default_music_rhythm", "FreeStyle"),
        mid_bar_time=float(data.get("mid_bar_time", 0.1) or 0.1),
        raw=data,
    )

    strain = parse_music_strain(data)
    for bar_index, raw_bar in enumerate(strain.bars):
        bar = Bar.objects.create(
            lesson=lesson,
            bar_index=bar_index,
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
            MusicEvent.objects.create(
                bar=bar,
                event_index=ev_index,
                horizontal_offset_ms=ev.horizontal_offset_ms,
                visual_offset_px=ev.visual_offset_px,
                duration=ev.duration,
                attack_decay_time=ev.attack_decay_time,
                volume=ev.volume,
                note_name=note.name,
                alias_degree=_normalize_alias(note.alias),
                is_rest=note.is_rest,
                is_enharmonic=note.is_enharmonic,
                event_type=ev.event_type,
                pitch_class=resolve_pitch_class(parse_note(note.name)),
            )
    return lesson
