"""
Note-name parsing utilities for the REA "relative" domain.

The source JSON uses German note letters and a compact token format::

    <letter><octave?><modifier?>

``letter``   one of ``c d e f g a h``  (``h`` is the German B-natural;
             ``b`` is not used as a letter here – flats are written ``b`` as a
             *modifier*, e.g. ``e2b`` = E-flat in octave 2).
``octave``   optional single digit (0-9).  When absent the note is treated as
             belonging to the reference octave of its key (octave "1").
``modifier`` optional, one of:

             ============  =================================================
             ``#``         sharp        (+1 semitone)
             ``b``         flat         (−1 semitone)
             ``x``         double-sharp (+2 semitones, used in sharp minor
                            keys where the diatonic note is already sharpened
                            by the key signature, e.g. ``f1x`` in Ais-mol)
             ``r``         "raised" / naturalised – removes a key-signature
                            flat so the note sounds natural (used in flat
                            minor keys, e.g. ``e1r`` in g-mol = E-natural)
             ============  =================================================

When ``is_enharmonic`` is true on a music note, the note inherits its
alteration from the key signature (``incdec``) rather than from its own
modifier – the token then carries *no* modifier (e.g. ``f1`` in G-dur is
actually F♯ because the key signature contains ``f2#``).

The helpers below turn those tokens into structured :class:`NoteToken`
values and resolve absolute pitch classes given a key signature.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Mapping, Optional

# German letter -> base pitch class (C = 0).
LETTER_PC: Mapping[str, int] = {
    "c": 0,
    "d": 2,
    "e": 4,
    "f": 5,
    "g": 7,
    "a": 9,
    "h": 11,  # German B-natural
}

# Modifier -> semitone offset.
MODIFIER_OFFSET: Mapping[str, int] = {
    "#": 1,
    "b": -1,
    "x": 2,
    "r": 0,  # naturalised – offset is 0 *relative to the natural letter*
}

_TOKEN_RE = re.compile(r"^([cdefgah])(\d)?(#|b|x|r)?$")


@dataclass(frozen=True)
class NoteToken:
    """A parsed note token."""

    letter: str
    octave: Optional[int]
    modifier: Optional[str]

    @property
    def modifier_offset(self) -> int:
        """Semitone offset implied by the modifier alone (0 if natural/none)."""
        if self.modifier is None:
            return 0
        return MODIFIER_OFFSET[self.modifier]

    @property
    def is_raised(self) -> bool:
        """True for the ``r`` (naturalised) modifier."""
        return self.modifier == "r"

    def midi_note(self, base_octave: int = 4) -> Optional[int]:
        """Return a MIDI note number, or None for rests / unpitched tokens.

        Octave numbering follows the source convention where the digit in the
        token is an *absolute octave index* and a bare letter (no digit) means
        octave index 0 (the lowest register used by the source).  Index 0 maps
        to ``base_octave - 1`` and index N maps to ``base_octave - 1 + N``, so
        that e.g. an A-dur scale ``a, h, c1, d1, e1, f1, g1, a1`` ascends
        monotonically (a = octave below c1).  ``c1`` -> C in ``base_octave``.
        """
        if self.letter not in LETTER_PC:
            return None
        oct_index = self.octave if self.octave is not None else 0
        # MIDI: C-1 = 0, so C4 (middle C) = 60.  Source octave index 0 maps
        # to base_octave - 1; index N maps to base_octave - 1 + N.
        return 12 * (base_octave - 1 + oct_index) + LETTER_PC[self.letter]


def parse_note(token: str) -> NoteToken:
    """Parse a note-name token into a :class:`NoteToken`.

    Rests are encoded as ``"rest"`` in some pipelines; here we accept any
    string and return a token whose letter is the first character – callers
    should check ``letter in LETTER_PC`` before treating it as pitched.
    """
    if not token:
        raise ValueError("empty note token")
    match = _TOKEN_RE.match(token.strip())
    if not match:
        # Graceful fallback: keep the raw letter, ignore the rest.
        letter = token[0]
        return NoteToken(letter=letter, octave=None, modifier=None)
    letter, octave, modifier = match.groups()
    return NoteToken(
        letter=letter,
        octave=int(octave) if octave is not None else None,
        modifier=modifier,
    )


def _key_signature_map(incdec) -> Mapping[str, int]:
    """Collapse a key-signature ``incdec`` blob into {letter: offset}.

    ``incdec`` in the source may be ``None``, a single dict, or a list of
    dicts.  Each dict carries ``name`` (e.g. ``f2#``) and we only need the
    letter + modifier.
    """
    if not incdec:
        return {}
    items = incdec if isinstance(incdec, list) else [incdec]
    out: dict[str, int] = {}
    for item in items:
        if isinstance(item, str):
            continue
        # Accept both raw dicts and objects exposing a `name` attribute
        # (e.g. the IncDec dataclass from services.json_import).
        name = item.get("name") if isinstance(item, dict) else getattr(item, "name", None)
        if not name:
            continue
        tok = parse_note(name)
        # Key-signature accidentals are always #, b or x.
        out[tok.letter] = tok.modifier_offset
    return out


def resolve_pitch_class(token: NoteToken, incdec=None) -> int:
    """Return the absolute pitch class (0-11) for *token* in a key.

    If the token carries an explicit modifier (``#``, ``b``, ``x``, ``r``)
    it is applied directly.  Otherwise the key-signature alteration from
    ``incdec`` is inherited (the "enharmonic" case).  ``r`` (naturalised)
    explicitly *cancels* any key-signature flat for that letter.
    """
    if token.letter not in LETTER_PC:
        return -1
    base = LETTER_PC[token.letter]
    if token.modifier is not None:
        if token.modifier == "r":
            # Naturalised: ignore the key signature, sound the plain letter.
            return base % 12
        return (base + token.modifier_offset) % 12
    # Enharmonic / no explicit modifier -> inherit from key signature.
    ks = _key_signature_map(incdec)
    return (base + ks.get(token.letter, 0)) % 12


def note_name_to_vexflow(token: NoteToken) -> str:
    """Convert a token to a VexFlow note key (e.g. ``c/4``, ``f#/5``).

    VexFlow uses Anglo-Saxon letters (B = b).  ``h`` therefore maps to ``b``.
    Octave indexes follow the source convention: a bare letter is octave
    index 0, digit N is octave index N.  Index 1 maps to VexFlow octave 4
    (middle-C octave), index 0 to octave 3, index 2 to octave 5, etc.
    """
    letter = "b" if token.letter == "h" else token.letter
    oct_index = token.octave if token.octave is not None else 0
    # Map source octave index to VexFlow octave (source 1 -> VF 4).
    vex_oct = 3 + oct_index
    acc = ""
    if token.modifier == "#":
        acc = "#"
    elif token.modifier == "b":
        acc = "b"
    elif token.modifier == "x":
        acc = "##"
    # 'r' (naturalised) -> no accidental in VexFlow.
    return f"{letter}{acc}/{vex_oct}"


def is_rest_token(token: str) -> bool:
    """True if *token* represents a rest."""
    return bool(token) and token.strip().lower() in {"r", "rest"}