#!/usr/bin/env python3
"""
rmp_to_midi.py — Convert .rmp music exercise files to MIDI.

When a folder is given, ALL .rmp files are found recursively and the
directory structure is mirrored inside a sibling 'midi_lessons/' folder.

Usage:
    python rmp_to_midi.py lessons/              → midi_lessons/ (mirrors tree)
    python rmp_to_midi.py input.rmp             → input.mid (next to source)
    python rmp_to_midi.py input.rmp -o out.mid  → custom output path
    python rmp_to_midi.py lessons/ --tempo 90   → override BPM for all files
"""

import sys
import os
import argparse
import xml.etree.ElementTree as ET
from midiutil import MIDIFile

# ---------------------------------------------------------------------------
# Note-name → MIDI pitch
# ---------------------------------------------------------------------------
# The .rmp format uses German/European note names:
#   c d e f g a h  (h = B in Anglo-American notation)
#   b suffix = flat (e.g. hb = Bb, e1b = Eb in octave 1)
#   # suffix = sharp (e.g. f# = F#, c1# = C# in octave 1)
#   No numeric suffix   → lowest register used in treble-clef exercises (~octave 4)
#   Suffix "1"          → one octave higher
#   Suffix "2"          → two octaves higher
#
# We anchor the bare names to MIDI octave 4 (middle-C = C4 = MIDI 60).

# Semitone offsets within an octave, starting from C
_BASE_SEMITONE = {
    "c":  0,
    "d":  2,
    "e":  4,
    "f":  5,
    "g":  7,
    "a":  9,
    "h": 11,   # B
}

def note_name_to_midi(name: str) -> int:
    """
    Convert an .rmp note name to a MIDI pitch number.

    Examples:
        "e"    → E4  = 64
        "f#"   → F#4 = 66
        "hb"   → Bb4 = 70
        "c1"   → C5  = 72
        "e1b"  → Eb5 = 75
        "g2"   → G6  = 91
    """
    name = name.strip().lower()

    # --- parse octave offset (trailing digit before any accidental suffix) ---
    # Possible patterns:  e  f#  hb  c1  c1#  e1b  g2
    octave_offset = 0
    # Find the first digit
    digit_pos = None
    for i, ch in enumerate(name):
        if ch.isdigit():
            digit_pos = i
            break

    if digit_pos is not None:
        octave_offset = int(name[digit_pos])
        # Remove the digit so we can parse letter + accidental cleanly
        name = name[:digit_pos] + name[digit_pos + 1:]

    # --- parse accidental ---
    accidental = 0
    if name.endswith("#"):
        accidental = 1
        name = name[:-1]
    elif name.endswith("b"):
        accidental = -1
        name = name[:-1]

    # --- base note ---
    if name not in _BASE_SEMITONE:
        raise ValueError(f"Unknown note letter: '{name}'")

    semitone = _BASE_SEMITONE[name] + accidental

    # Anchor: bare names (octave_offset=0) → MIDI octave 4
    # MIDI note for C4 = 60  →  octave 4 starts at 60
    midi = 60 + semitone + octave_offset * 12
    return midi


# ---------------------------------------------------------------------------
# Duration mapping
# ---------------------------------------------------------------------------
# DR is expressed as a fraction of a whole note.
# MIDIFile uses beats; we assume 4/4 with quarter-note = 1 beat.
# So DR 0.25 = quarter note = 1 beat, DR 0.125 = eighth note = 0.5 beats, etc.

def dr_to_beats(dr: float) -> float:
    """Convert DR (fraction of whole note) to quarter-note beats."""
    return dr * 4.0


# ---------------------------------------------------------------------------
# Clef → MIDI channel / program (optional, kept simple)
# ---------------------------------------------------------------------------
CLEF_PROGRAM = {
    "Violin": 40,   # GM: Violin
    "Bass":   43,   # GM: Contrabass
}


# ---------------------------------------------------------------------------
# Core conversion
# ---------------------------------------------------------------------------

def rmp_to_midi(rmp_path: str, midi_path: str, tempo_bpm: float = None):
    """Parse one .rmp file and write a .mid file."""

    tree = ET.parse(rmp_path)
    root = tree.getroot()

    # Global tempo (stored as a multiplier in the file; treat as BPM if ≥ 20,
    # otherwise scale to a sensible default)
    raw_tempo = root.findtext("Tempo")
    if tempo_bpm is None:
        if raw_tempo is not None:
            t = float(raw_tempo)
            # Very small values (like 4) seem to be multipliers, not BPM
            tempo_bpm = t if t >= 20 else 120
        else:
            tempo_bpm = 120

    midi = MIDIFile(1)          # single track
    track = 0
    channel = 0
    midi.addTempo(track, 0, tempo_bpm)

    # Determine program (instrument) from the first clef found
    first_clef = root.findtext(".//MC") or "Violin"
    program = CLEF_PROGRAM.get(first_clef, 40)
    midi.addProgramChange(track, channel, 0, program)

    current_time = 0.0  # in beats

    for seq in root.findall(".//Seq"):
        bundle = seq.find("MuE")
        if bundle is None:
            continue

        # --- pitch ---
        note_elem = bundle.find("MN/Name")
        if note_elem is None or not note_elem.text:
            continue
        try:
            pitch = note_name_to_midi(note_elem.text)
        except ValueError as exc:
            print(f"  Warning: skipping unrecognised note '{note_elem.text}': {exc}")
            continue

        # --- duration ---
        dr_text = bundle.findtext("DR")
        dr = float(dr_text) if dr_text else 0.25
        duration = dr_to_beats(dr)

        # --- velocity / dynamics ---
        vol_text = bundle.findtext("VOL")
        velocity = int(float(vol_text)) if vol_text else 80
        velocity = max(1, min(127, velocity))

        midi.addNote(track, channel, pitch, current_time, duration, velocity)
        current_time += duration

    with open(midi_path, "wb") as f:
        midi.writeFile(f)

    print(f"  {os.path.basename(rmp_path)} → {midi_path}  "
          f"({int(current_time * 4 / 4)} beats, tempo {tempo_bpm} BPM)")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def walk_rmp_files(root_dir: str):
    """
    Yield (rmp_path, relative_path) for every .rmp file found recursively
    under root_dir.  relative_path is relative to root_dir itself.
    """
    root_dir = os.path.normpath(root_dir)
    for dirpath, _dirnames, filenames in os.walk(root_dir):
        for fn in sorted(filenames):
            if fn.lower().endswith(".rmp"):
                full = os.path.join(dirpath, fn)
                rel  = os.path.relpath(full, root_dir)
                yield full, rel


def midi_output_path(rmp_path: str, source_root: str) -> str:
    """
    Given an .rmp file path and the source root directory, return the
    corresponding output path inside a sibling 'midi_lessons/' folder,
    mirroring the subfolder structure.

    Example:
        source_root  = /home/user/lessons
        rmp_path     = /home/user/lessons/unit2/ex03.rmp
        →  output    = /home/user/midi_lessons/unit2/ex03.mid
    """
    source_root = os.path.normpath(source_root)
    rel = os.path.relpath(rmp_path, source_root)          # e.g. unit2/ex03.rmp
    rel_mid = os.path.splitext(rel)[0] + ".mid"           # e.g. unit2/ex03.mid
    parent = os.path.dirname(source_root)                 # e.g. /home/user
    out_root = os.path.join(parent, "midi_lessons")       # e.g. /home/user/midi_lessons
    return os.path.join(out_root, rel_mid)


def main():
    parser = argparse.ArgumentParser(
        description="Convert .rmp music exercise files to MIDI.")
    parser.add_argument("inputs", nargs="+",
                        help=".rmp file(s) or a root directory to scan recursively")
    parser.add_argument("-o", "--output",
                        help="Output .mid path (only valid for a single input file)")
    parser.add_argument("--tempo", type=float, default=None,
                        help="Override tempo in BPM (default: read from file or 120)")
    args = parser.parse_args()

    # Build list of (rmp_path, midi_path) pairs
    jobs = []
    for inp in args.inputs:
        inp = os.path.normpath(inp)
        if os.path.isdir(inp):
            for rmp_path, rel in walk_rmp_files(inp):
                out = midi_output_path(rmp_path, inp)
                jobs.append((rmp_path, out))
        elif os.path.isfile(inp):
            if args.output:
                jobs.append((inp, args.output))
            else:
                jobs.append((inp, os.path.splitext(inp)[0] + ".mid"))
        else:
            print(f"Warning: '{inp}' not found, skipping.")

    if not jobs:
        print("No .rmp files found.")
        sys.exit(1)

    if args.output and len(jobs) > 1:
        print("Error: -o / --output can only be used with a single input file.")
        sys.exit(1)

    print(f"Converting {len(jobs)} file(s)…\n")
    errors = 0
    for rmp_path, midi_path in jobs:
        # Create output directory tree if needed
        os.makedirs(os.path.dirname(midi_path), exist_ok=True)
        try:
            rmp_to_midi(rmp_path, midi_path, tempo_bpm=args.tempo)
        except Exception as exc:
            print(f"  ERROR converting '{rmp_path}': {exc}")
            errors += 1

    print()
    if errors:
        print(f"Done with {errors} error(s).")
        sys.exit(1)
    else:
        print("All done.")


if __name__ == "__main__":
    main()