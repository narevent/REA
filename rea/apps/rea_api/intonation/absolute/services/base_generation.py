"""
Chromatic-base generation service.

Turns the ``key_models/Base/Ap_12.json`` file into a :class:`ChromaticBase`
with one :class:`Bar` / :class:`MusicEvent` per chromatic pitch.  The source
file holds 12 bars (c1, c1#, d1, … h1), each with a single note whose
``alias`` labels the diatonic degree it belongs to.
"""

from __future__ import annotations

from ...relative.utils.note_parser import parse_note, resolve_pitch_class
from ..models import Bar, ChromaticBase, MusicEvent
from .json_import import parse_music_strain


def import_chromatic_base(data: dict, filename: str, *, clear: bool = True) -> ChromaticBase:
    """Import the chromatic base JSON blob into the database."""
    name = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    if name.endswith(".json"):
        name = name[:-5]

    strain = parse_music_strain(data)

    if clear:
        ChromaticBase.objects.filter(name=name).delete()

    base = ChromaticBase.objects.create(
        name=name,
        clef=strain.default_music_clef,
        default_rhythm=data.get("default_music_rhythm", "FreeStyle"),
        draw_only_note_heads=bool(data.get("draw_only_note_heads", True)),
        tempo=int(data.get("tempo", 4) or 4),
    )

    for bar_index, raw_bar in enumerate(strain.bars):
        bar = Bar.objects.create(
            base=base,
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
            alias = note.alias
            alias_label = "" if alias in (None, "", {}) else str(alias)
            MusicEvent.objects.create(
                bar=bar,
                event_index=ev_index,
                horizontal_offset_ms=ev.horizontal_offset_ms,
                duration=ev.duration,
                attack_decay_time=ev.attack_decay_time,
                volume=ev.volume,
                note_name=note.name,
                alias_degree=alias_label,
                is_rest=note.is_rest,
                is_enharmonic=note.is_enharmonic,
                event_type=ev.event_type,
                pitch_class=resolve_pitch_class(parse_note(note.name)),
            )

    return base
