"""
Filename/path parsing for the REA "absolute" intonation domain.

The ``music_strain`` JSON blob has the same shape as in the relative
domain, so the generic parser is re-used from
:mod:`..relative.services.json_import`.  What differs is the *directory
hierarchy* and the exercise metadata encoded in each filename::

    absolute/key_models/Base/Ap_12.json
    absolute/lessons/mono/<Category>/<Span>[/<Grades>][/<part-folder>]/<file>.json

Examples::

    lessons/mono/Formula/Octave/1_AF-8_1_part/1_part_ex-1_listening_model_AF-formula_8.json
    lessons/mono/Formula/Octave/7_AF-8_1-4_part/1-4_part_ex-10_(CHROMATIC_SCALE)_guessing_notes_multiple_AF-formula_8.json
    lessons/mono/Formula/Extended/2Grades/3_ex-6_guessing_notes_CHROMATIC_AF-formula_2_oct.json
    lessons/mono/FormulaInverse/Extended/1_ex-3_guessing_model_A-inv_formula_PR.json
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

# Re-export the shared music_strain parser so absolute services import from
# one place.
from ...relative.services.json_import import parse_music_strain  # noqa: F401

_CATEGORIES = {
    "formula": "Formula",
    "formulainverse": "FormulaInverse",
    "intervals": "Intervals",
    "chordsthirds": "ChordsThirds",
    "chordssevenths": "ChordsSevenths",
}
_MONO_CATEGORIES = {"Formula", "FormulaInverse"}
_SPANS = {"octave": "Octave", "quinta": "Quinta", "extended": "Extended"}
_GRADES = {"2grades": "2Grades", "3grades": "3Grades"}
_INTERVAL_SIZES = {
    "Seconds", "Thirds", "Fourths", "Fifths", "Sixths", "Sevenths", "Eights",
}
_INTERVAL_QUALITIES = {"Major", "Minor", "Perfect", "Augmented"}
_TRIAD_QUALITIES = {"Major", "Minor", "Augmented", "Diminished"}

_PART_RE = re.compile(r"(\d+(?:-\d+)?)_part")
_EX_RE = re.compile(r"ex-(\d+)")
_PHASE_RE = re.compile(r"(\d)-phase")
_SEVENTH_QUALITY_RE = re.compile(r"^\d+_(\w+Seventh)$")
_INVERSION_DIRS = {"2", "7", "43", "53", "63", "64", "65"}
# Everything between "ex-N_" and the trailing "_AF"/"_A-inv" marker holds the
# exercise-type words plus optional flag tokens (timed / CHROMATIC / SCALE).
_TYPE_RE = re.compile(r"ex-\d+_(.+?)_(?:AF|A-inv)")

_FLAG_TOKENS = {"timed", "chromatic", "scale"}


@dataclass
class LessonMeta:
    texture: str  # "mono" / "poly"
    category: str  # Formula / FormulaInverse / Intervals / ChordsThirds / ChordsSevenths
    span: str  # mono: "Octave" / "Quinta" / "Extended"; "" for poly
    grades: str  # mono: "2Grades" / "3Grades" / ""
    quality: str  # poly: chord/interval quality or ""
    interval_size: str  # poly Intervals: "Seconds".."Eights"
    inversion: str  # poly chords: figured-bass digits
    part: str  # "1".."4", "1-2", "1-3", "1-4" or ""
    phase: int  # poly: 1 or 2; 0 for mono
    exercise_number: int
    exercise_type: str  # e.g. "guessing_notes", "guessing_chord"
    timed: bool
    chromatic: bool


def parse_lesson_path(path: str) -> Optional[LessonMeta]:
    """Derive :class:`LessonMeta` from an absolute lesson file path.

    Handles both the mono tree (``lessons/mono/<Category>/<Span>/...``) and
    the poly tree (``lessons/poly/<Category>/<Quality|Size>/...``).  Returns
    ``None`` when the path does not look like an absolute lesson file.
    """
    parts = [p for p in path.replace("\\", "/").split("/") if p]
    fname = parts[-1] if parts else ""
    if fname.startswith("_"):
        return None  # helper/template copies
    stem = fname[:-5] if fname.endswith(".json") else fname

    texture = "poly" if "poly" in parts else "mono"
    category = ""
    span = ""
    grades = ""
    cat_index = -1
    for idx, p in enumerate(parts[:-1]):
        low = p.lower()
        if low in _CATEGORIES and not category:
            category = _CATEGORIES[low]
            cat_index = idx
        elif low in _SPANS:
            span = _SPANS[low]
        elif low in _GRADES:
            grades = _GRADES[low]

    ex_match = _EX_RE.search(stem)
    if not category or not ex_match:
        return None
    exercise_number = int(ex_match.group(1))

    quality = ""
    interval_size = ""
    inversion = ""
    phase = 0
    if texture == "poly":
        if category in _MONO_CATEGORIES:
            return None  # poly tree only holds interval/chord categories
        sub_dirs = parts[cat_index + 1:-1]
        if category == "ChordsSevenths":
            for d in sub_dirs:
                m = _SEVENTH_QUALITY_RE.match(d)
                if m:
                    quality = m.group(1)
                elif d in _INVERSION_DIRS:
                    inversion = d
        elif category == "ChordsThirds":
            for d in sub_dirs:
                if d in _TRIAD_QUALITIES:
                    quality = d
                elif d in _INVERSION_DIRS:
                    inversion = d
        elif category == "Intervals":
            for d in sub_dirs:
                if d in _INTERVAL_SIZES:
                    interval_size = d
                elif d in _INTERVAL_QUALITIES:
                    quality = d
        phase_match = _PHASE_RE.search(stem)
        phase = int(phase_match.group(1)) if phase_match else 0
        span = ""
        grades = ""
    elif not span:
        return None  # mono lessons always live under a span folder

    # Part: prefer the filename prefix ("1-3_part_..."), fall back to the
    # parent folder ("5_AF-8_1-3_part").
    part = ""
    m = _PART_RE.search(stem)
    if not m and len(parts) >= 2:
        m = _PART_RE.search(parts[-2])
    if m:
        part = m.group(1)

    # Exercise type + flags.
    timed = False
    chromatic = False
    exercise_type = ""
    tm = _TYPE_RE.search(stem)
    if tm:
        raw_tokens = tm.group(1).replace("(", "").replace(")", "").split("_")
        kept: list[str] = []
        for tok in raw_tokens:
            low = tok.lower()
            if low == "timed":
                timed = True
            elif low == "chromatic":
                chromatic = True
            elif low in _FLAG_TOKENS:
                continue  # e.g. the "SCALE" half of "(CHROMATIC_SCALE)"
            else:
                kept.append(low)
        exercise_type = "_".join(kept)
    # "timed"/"CHROMATIC" may also appear outside the captured span
    # (e.g. "..._guessing_notes_CHROMATIC_timed_A-inv...").
    if "_timed" in stem.lower():
        timed = True
    if "chromatic" in stem.lower():
        chromatic = True

    return LessonMeta(
        texture=texture,
        category=category,
        span=span,
        grades=grades,
        quality=quality,
        interval_size=interval_size,
        inversion=inversion,
        part=part,
        phase=phase,
        exercise_number=exercise_number,
        exercise_type=exercise_type,
        timed=timed,
        chromatic=chromatic,
    )
