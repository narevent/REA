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

_CATEGORIES = {"formula": "Formula", "formulainverse": "FormulaInverse"}
_SPANS = {"octave": "Octave", "quinta": "Quinta", "extended": "Extended"}
_GRADES = {"2grades": "2Grades", "3grades": "3Grades"}

_PART_RE = re.compile(r"(\d+(?:-\d+)?)_part")
_EX_RE = re.compile(r"ex-(\d+)")
# Everything between "ex-N_" and the trailing "_AF"/"_A-inv" marker holds the
# exercise-type words plus optional flag tokens (timed / CHROMATIC / SCALE).
_TYPE_RE = re.compile(r"ex-\d+_(.+?)_(?:AF|A-inv)")

_FLAG_TOKENS = {"timed", "chromatic", "scale"}


@dataclass
class LessonMeta:
    category: str  # "Formula" / "FormulaInverse"
    span: str  # "Octave" / "Quinta" / "Extended"
    grades: str  # "2Grades" / "3Grades" / ""
    part: str  # "1".."4", "1-2", "1-3", "1-4" or ""
    exercise_number: int
    exercise_type: str  # e.g. "guessing_notes"
    timed: bool
    chromatic: bool


def parse_lesson_path(path: str) -> Optional[LessonMeta]:
    """Derive :class:`LessonMeta` from an absolute lesson file path.

    Returns ``None`` when the path does not look like an absolute lesson
    file (no ``ex-N`` marker or no recognised category/span folders).
    """
    parts = [p for p in path.replace("\\", "/").split("/") if p]
    fname = parts[-1] if parts else ""
    stem = fname[:-5] if fname.endswith(".json") else fname

    category = ""
    span = ""
    grades = ""
    for p in parts[:-1]:
        low = p.lower()
        if low in _CATEGORIES:
            category = _CATEGORIES[low]
        elif low in _SPANS:
            span = _SPANS[low]
        elif low in _GRADES:
            grades = _GRADES[low]

    ex_match = _EX_RE.search(stem)
    if not category or not span or not ex_match:
        return None
    exercise_number = int(ex_match.group(1))

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
        category=category,
        span=span,
        grades=grades,
        part=part,
        exercise_number=exercise_number,
        exercise_type=exercise_type,
        timed=timed,
        chromatic=chromatic,
    )
