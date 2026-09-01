/**
 * notation.js - note-name parsing on the client side, mirroring the Python
 * `utils/note_parser.py`.  Exposes helpers used by the renderer and player.
 */

// German letter -> base pitch class (C = 0).
export const LETTER_PC = {
  c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, h: 11,
};

const TOKEN_RE = /^([cdefgah])(\d)?(#|b|x|r)?$/;

export function parseNoteToken(token) {
  if (!token) return { letter: "", octave: null, modifier: null };
  const m = token.trim().match(TOKEN_RE);
  if (!m) return { letter: token[0], octave: null, modifier: null };
  return {
    letter: m[1],
    octave: m[2] ? parseInt(m[2], 10) : null,
    modifier: m[3] || null,
  };
}

// Modifier -> semitone offset.
const MOD_OFFSET = { "#": 1, b: -1, x: 2, r: 0 };

/**
 * Convert a token to a VexFlow note key, e.g. `c/4`, `f#/5`.
 * `h` (German B-natural) maps to `b`. Source octave index 1 -> VexFlow octave
 * 4 (middle-C octave); a bare letter (no digit) is octave index 0 -> VF 3.
 */
export function noteNameToVexflow(tok) {
  const letter = tok.letter === "h" ? "b" : tok.letter;
  const octIndex = tok.octave ?? 0;
  const vexOct = 3 + octIndex;
  let acc = "";
  if (tok.modifier === "#") acc = "#";
  else if (tok.modifier === "b") acc = "b";
  else if (tok.modifier === "x") acc = "##";
  // 'r' (naturalised) -> no accidental in VexFlow key (handled via key sig).
  return letter + acc + "/" + vexOct;
}

/**
 * Convert a parsed token to a MIDI note number.
 * Source octave convention: the digit is an absolute octave index and a bare
 * letter (no digit) is index 0.  Index 1 maps to MIDI octave 4 (C4 = 60);
 * index 0 maps to octave 3 (C3 = 48); index 2 -> octave 5, etc.  This keeps
 * every key model scale ascending (e.g. A-dur `a, h, c1, ...` where the bare
 * `a` sits one octave below `c1`).
 * When `keySignature` ({letter: offset}) is supplied and the token carries no
 * explicit modifier, the alteration is inherited from the key signature
 * (the "enharmonic" case).
 * Returns null for non-pitched tokens.
 */
export function noteTokenToMidi(tok, keySignature) {
  if (!(tok.letter in LETTER_PC)) return null;
  const octIndex = tok.octave ?? 0;
  const base = LETTER_PC[tok.letter];
  let pc;
  if (tok.modifier != null) {
    if (tok.modifier === "r") pc = base % 12; // naturalised
    else pc = (base + MOD_OFFSET[tok.modifier]) % 12;
  } else if (keySignature) {
    pc = (base + (keySignature[tok.letter] || 0)) % 12;
  } else {
    pc = base % 12;
  }
  // Index 1 -> octave 4 (C4=60); index 0 -> octave 3 (C3=48); index 2 -> C5.
  // This matches the VexFlow rendering (vexOct = 3 + octIndex, VF C4 = MIDI 60),
  // so the pitch you hear equals the note you see on the stave.
  return 12 * (4 + octIndex) + pc;
}

/** Convenience: parse a name token then convert to MIDI. */
export function noteNameToMidi(name, keySignature) {
  return noteTokenToMidi(parseNoteToken(name), keySignature);
}


// Two spellings of every chromatic pitch class.  Which one is used depends on
// the key: a flat key should read e-flat, a sharp key d-sharp, and writing the
// wrong one gives a stave full of accidentals that fight the key signature.
const SHARP_SPELLING = ["c", "c", "d", "d", "e", "f", "f", "g", "g", "a", "a", "h"];
const FLAT_SPELLING = ["c", "d", "d", "e", "e", "f", "g", "g", "a", "a", "h", "h"];

/**
 * The note token for a MIDI pitch, spelled for this key signature.
 *
 * The octave convention is the source's own and is not the MIDI one: the digit
 * is an octave index where 1 means the middle-C octave, so a bare letter sits
 * an octave below `c1` (see `noteTokenToMidi` just above — this is its
 * inverse, and the two must stay in step).
 *
 * The modifier is then chosen against the key signature rather than against
 * the bare letter, so a note the key already alters needs no accidental, and a
 * note the key alters but this melody does not gets the naturalising `r`.
 */
export function midiToToken(midi, keySignature) {
  const map = keySignatureMap(keySignature || []);
  const flatKey = Object.values(map).some((offset) => offset < 0);
  const pc = ((midi % 12) + 12) % 12;
  const letter = (flatKey ? FLAT_SPELLING : SHARP_SPELLING)[pc];
  const base = LETTER_PC[letter];

  // The octave index, straight out of the pitch.  It needs no correction for
  // how the note is spelled, because the source's own formula resolves a token
  // to `12 * (4 + octave) + pitchClass` — the octave digit indexes the pitch,
  // not the letter.  (One consequence, inherited rather than introduced here:
  // `h1#` and `c1` name the same sound in this format.  None of the spellings
  // below reach across an octave, so it never comes up.)
  const octave = Math.floor(midi / 12) - 4;

  const inKey = (base + (map[letter] || 0) + 12) % 12;
  let modifier = null;
  if (inKey !== pc) {
    const diff = (pc - base + 12) % 12;
    modifier = diff === 0 ? "r" : diff === 1 ? "#" : diff === 11 ? "b" : diff === 2 ? "x" : null;
  }
  if (octave < 0 || octave > 9) return null;   // off the edge of the notation
  return { letter, octave, modifier, name: letter + (octave === 0 ? "" : String(octave)) + (modifier || "") };
}


// ---------------------------------------------------------------------------
// Key-signature helpers
// ---------------------------------------------------------------------------

/**
 * Build a {letter: offset} map from a serialized key_signature list
 * (each entry: {name, letter, offset}).
 */
export function keySignatureMap(keySignature) {
  const out = {};
  (keySignature || []).forEach((k) => {
    if (k.letter) out[k.letter] = k.offset;
  });
  return out;
}

// Map a source `music_mode_chord` (e.g. "G_Major", "As_Minor", "Cis_Major")
// to a VexFlow key-signature string (e.g. "G", "Abm", "C#").
// VexFlow uses Anglo-Saxon letters; German `h`->`b`, `as`->`Ab`, `ais`->`A#`,
// `es`->`Eb`, `ces`->`Cb`, `cis`->`C#`, `ges`->`Gb`, `gis`->`G#`, etc.
const GERMAN_TO_VEX_ROOT = {
  c: "C", cis: "C#", ces: "Cb",
  d: "D", dis: "D#", des: "Db",
  e: "E", eis: "E#", es: "Eb",
  f: "F", fis: "F#", fes: "Fb",
  g: "G", gis: "G#", ges: "Gb",
  a: "A", ais: "A#", as: "Ab",
  h: "B", his: "B#", b: "Bb",
};

/**
 * Convert a `music_mode_chord` ("G_Major" / "As_Minor") to a VexFlow key name.
 * Returns "" if the chord is empty/unknown.
 */
export function modeChordToVexKey(modeChord) {
  if (!modeChord || typeof modeChord !== "string") return "";
  const parts = modeChord.split("_");
  if (parts.length < 2) return "";
  const root = parts[0].toLowerCase();
  const mode = parts[1];
  const vexRoot = GERMAN_TO_VEX_ROOT[root];
  if (!vexRoot) return "";
  return mode === "Minor" ? vexRoot + "m" : vexRoot;
}