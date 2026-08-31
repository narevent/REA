"""
Helpers for parsing a ``music_strain`` JSON blob uniformly across key models
and lessons.

The source JSON is identical in shape for both kinds of files; only the
presence of ``attack_decay_time`` and a real ``tempo`` distinguish a
lesson from a key-model file.  These helpers normalise the few quirks
(``incdec`` may be ``None`` / dict / list; ``alias`` may be int or str; the
``type`` key uses a long XSI namespace) into clean Python structures.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class IncDec:
    name: str
    alias: Any = field(default_factory=dict)
    is_rest: bool = False
    is_enharmonic: bool = False

    @property
    def letter(self) -> str:
        return self.name[0] if self.name else ""


@dataclass
class NoteBundle:
    name: str
    alias: Any
    is_rest: bool
    is_enharmonic: bool


@dataclass
class RawEvent:
    horizontal_offset_ms: int = 0
    # Where the notehead is drawn, as against when it sounds.  The source
    # library predates the field and never carries it, so it reads as 0 and
    # every imported lesson draws exactly as it always did; it is read here so
    # that a score exported from REA's own editor round-trips.
    visual_offset_px: int = 0
    duration: float = 0.125
    attack_decay_time: Optional[float] = None
    volume: int = 80
    note: Optional[NoteBundle] = None
    event_type: str = "MusicNoteBundle"


@dataclass
class RawBar:
    music_clef: str = "Violin"
    music_rhythm: str = "FreeStyle"
    music_mode_chord: str = ""
    is_incomplete_bar: bool = False
    incomplete_bar_playback_count: int = 0
    label: str = ""  # text_utility harmonic-function label (e.g. 'I', 'IV')
    incdec: list[IncDec] = field(default_factory=list)
    events: list[RawEvent] = field(default_factory=list)


@dataclass
class RawMusicStrain:
    default_music_clef: str = "Violin"
    bars: list[RawBar] = field(default_factory=list)


def _normalise_incdec(incdec) -> list[IncDec]:
    """``incdec`` may be None, a single dict, or a list of dicts."""
    if not incdec:
        return []
    items = incdec if isinstance(incdec, list) else [incdec]
    out: list[IncDec] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        out.append(
            IncDec(
                name=item.get("name", ""),
                alias=item.get("alias", {}) if item.get("alias") is not None else {},
                is_rest=bool(item.get("is_rest", False)),
                is_enharmonic=bool(item.get("is_enharmonic", False)),
            )
        )
    return out


def parse_music_strain(data: dict) -> RawMusicStrain:
    """Parse the ``music_strain`` section of a key-model/lesson JSON."""
    ms = data.get("music_strain", {}) or {}
    strain = RawMusicStrain(
        default_music_clef=ms.get("default_music_clef", "Violin"),
    )
    for bar in ms.get("sequence", []) or []:
        text_utility = bar.get("text_utility") or {}
        raw_bar = RawBar(
            music_clef=bar.get("music_clef", strain.default_music_clef),
            music_rhythm=bar.get("music_rhythm", "FreeStyle"),
            music_mode_chord=bar.get("music_mode_chord", ""),
            is_incomplete_bar=bool(bar.get("is_incomplete_bar", False)),
            incomplete_bar_playback_count=int(bar.get("incomplete_bar_playback_count", 0)),
            label=str(text_utility.get("text", "") or "") if isinstance(text_utility, dict) else "",
            incdec=_normalise_incdec(bar.get("incdec")),
        )
        for ev in bar.get("music_event", []) or []:
            mn = ev.get("music_note") or {}
            note = NoteBundle(
                name=mn.get("name", ""),
                alias=mn.get("alias", ""),
                is_rest=bool(mn.get("is_rest", False)),
                is_enharmonic=bool(mn.get("is_enharmonic", False)),
            )
            # The XSI type key is namespace-prefixed; normalise it.
            etype = ev.get(
                "//www.w3.org/2001/XMLSchema-instance}type", "MusicNoteBundle"
            )
            raw_bar.events.append(
                RawEvent(
                    horizontal_offset_ms=int(ev.get("horizontal_offset_ms", 0) or 0),
                    visual_offset_px=int(ev.get("visual_offset_px", 0) or 0),
                    duration=float(ev.get("duration", 0.125) or 0.125),
                    attack_decay_time=(
                        float(ev["attack_decay_time"])
                        if ev.get("attack_decay_time") is not None
                        else None
                    ),
                    volume=int(ev.get("volume", 80) or 80),
                    note=note,
                    event_type=etype,
                )
            )
        strain.bars.append(raw_bar)
    return strain


# ---------------------------------------------------------------------------
# Filename / key-name parsing
# ---------------------------------------------------------------------------

_DUR_TO_MODE = {"dur": "Major", "mol": "Minor"}

# German letter -> pitch class (C = 0).  Covers every spelling used in the
# source filenames (natural, -is = sharp, -es/-s = flat, Ces = C-flat, etc.).
# Note: in German notation "B" == B-flat (pc 10) and "H" == B-natural (pc 11).
_GERMAN_ROOT_PC = {
    "c": 0, "cis": 1, "ces": 11,
    "d": 2, "dis": 3, "des": 1,
    "e": 4, "eis": 5, "es": 3,
    "f": 5, "fis": 6, "fes": 4,
    "g": 7, "gis": 8, "ges": 6,
    "a": 9, "ais": 10, "as": 8,
    "h": 11, "his": 0,
    "b": 10,  # German B == B-flat
}


@dataclass
class KeyName:
    raw: str
    root_letter: str
    mode: str  # "Major" / "Minor"
    display: str  # e.g. "C-dur", "A-mol"

    @property
    def root_pitch_class(self) -> int:
        return _GERMAN_ROOT_PC[self.root_letter.lower()]

    @property
    def music_mode_chord(self) -> str:
        return f"{self.root_letter.capitalize()}_{'Major' if self.mode == 'Major' else 'Minor'}"


def parse_key_name(filename: str) -> KeyName:
    """Parse a key name from a key-model filename like ``C-dur_8.json``.

    For *lesson* files the filename also contains the key token (e.g.
    ``1_1_1_C-dur_formula_8.json``) but it is embedded among other words, so
    prefer :func:`key_name_from_mode_chord` using the JSON's
    ``music_mode_chord`` field when importing lessons.
    """
    import re

    stem = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    stem = stem.replace(".json", "")
    # Strip a trailing "_8" (or "_<digits>") octave/voices suffix.
    stem = re.sub(r"_\d+$", "", stem)
    # Find the "<root>-dur"/"<root>-mol" token anywhere in the stem.
    m = re.search(r"([A-Za-z]+)-(dur|mol)", stem)
    if not m:
        # Fall back to the simple "X-dur" split.
        root, mode_key = stem.split("-", 1)
    else:
        root, mode_key = m.group(1), m.group(2)
    root_letter = root
    mode = _DUR_TO_MODE[mode_key.lower()]
    return KeyName(
        raw=stem,
        root_letter=root_letter,
        mode=mode,
        display=f"{root}-{mode_key}",
    )


# Reverse maps for music_mode_chord -> KeyName.
_MODE_CHORD_TO_MODE = {"Major": "Major", "Minor": "Minor"}


def key_name_from_mode_chord(mode_chord: str) -> KeyName:
    """Build a :class:`KeyName` from a JSON ``music_mode_chord`` value.

    These look like ``C_Major``, ``As_Major``, ``A_Minor``.  The root letter
    is converted back to the German display form (e.g. ``As`` -> ``As``,
    ``Ais`` -> ``Ais``; here the chord uses the flat/sharp spelling present
    in the source, which we preserve).
    """
    if not mode_chord:
        raise ValueError("empty music_mode_chord")
    root_part, mode_part = mode_chord.split("_", 1)
    mode = _MODE_CHORD_TO_MODE.get(mode_part, "Major")
    mode_key = "dur" if mode == "Major" else "mol"
    return KeyName(
        raw=mode_chord,
        root_letter=root_part,
        mode=mode,
        display=f"{root_part}-{mode_key}",
    )


# Mapping from the lesson *folder* name (e.g. ``AsMajor``, ``AisMinor``)
# to the corresponding German key-model display name.  The folder name is the
# authoritative indicator of which key a lesson belongs to — some folders
# also contain ``__``-prefixed template files whose JSON content names a
# different key, so the folder beats the content.
_MODE_SUFFIX = {"Major": "dur", "Minor": "mol"}


def key_name_from_folder(path: str) -> Optional[KeyName]:
    """Build a :class:`KeyName` from a lesson file's *folder* location.

    The lesson tree is::

        lessons/<Mode>/<FormulaFamily>/<KeyFolder>/<lesson-folder>/<file>.json

    ``<KeyFolder>`` is e.g. ``AsMajor`` / ``AisMinor`` and maps directly to a
    key-model name (``As-dur`` / ``Ais-mol``).  Returns ``None`` if no
    ``<KeyFolder>`` matching the ``<Root>(Major|Minor)`` pattern is found.
    """
    import re

    parts = [p for p in path.replace("\\", "/").split("/") if p]
    for p in parts:
        m = re.match(r"^([A-Za-z]+?)(Major|Minor)$", p)
        if m:
            root, mode_part = m.group(1), m.group(2)
            mode = _MODE_CHORD_TO_MODE[mode_part]
            mode_key = _MODE_SUFFIX[mode_part]
            return KeyName(
                raw=p,
                root_letter=root,
                mode=mode,
                display=f"{root}-{mode_key}",
            )
    return None