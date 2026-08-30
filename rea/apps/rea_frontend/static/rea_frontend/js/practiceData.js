/**
 * practiceData.js
 *
 * Helpers that turn a serialized lesson (or key-model) into the data the
 * practice modes need: per-bar pitch lists (MIDI), per-bar degree lists, the
 * key signature map (for resolving enharmonic notes), the tempo, and a
 * bar-step builder for the AudioPlayer.
 *
 * These mirror the logic already living in app.js (buildBarSteps / barsToFlat
 * / keySigMap) but are factored out so the practice controller can reuse them
 * without depending on the main app state.
 */

import { noteNameToMidi, keySignatureMap, modeChordToVexKey } from "./notation.js?v=67";

const DEFAULT_TEMPO = 80;
const OFFSET_GAIN = 12;
const A4_MIDI = 69;

export function keySigMap(item) {
  // Lessons carry no key_signature of their own - only KeyModels do.
  // The lesson's notes were already enharmonic-resolved server-side (their
  // pitch_class is correct), and the renderer derives the key signature from
  // the bar's `music_mode_chord`, so for practice we don't need the key-sig
  // map for resolving MIDI - we can rely on noteNameToMidi with an empty map
  // plus the explicit modifiers on each token.  Return an empty map when the
  // item has no usable key_signature.
  const ks = item && item.key_signature;
  if (Array.isArray(ks)) return keySignatureMap(ks);
  return {};
}

/** Tempo, with a sane floor.
 *
 * Polyphonic (harmonic) lessons notate their material in sixteenths
 * (duration 0.0625) rather than the eighths (0.125) used by the monophonic
 * (melodic) lessons, and they carry a higher tempo — so the same
 * `wholeMs = 4·60000 / tempo` mapping makes each poly note sound at roughly
 * half the millisecond length of a mono note, i.e. they play back far too
 * fast.  The mono exercises feel right, so to give the poly exercises the
 * same comfortable pace we halve the effective tempo for poly-texture items
 * (a sixteenth at half-tempo lands on the same wall-clock duration as an
 * eighth at full tempo).  Mono and key-model items are unaffected. */
export function tempoOf(item) {
  const raw = item.tempo || DEFAULT_TEMPO;
  const t = raw > 10 ? raw : DEFAULT_TEMPO;
  return item.texture === "poly" ? t / 2 : t;
}

/** VexFlow key name for the lesson/key (from the first bar's mode chord). */
export function vexKeyOf(item) {
  const bars = item.bars || [];
  return modeChordToVexKey(bars[0] && bars[0].music_mode_chord);
}

/**
 * Build per-bar playback steps (absolute startMs within the bar), so each bar
 * can be played independently or concatenated.  Mirrors app.buildBarSteps.
 */
export function buildBarSteps(item) {
  const bars = item.bars || [];
  const ks = keySigMap(item);
  const tempo = tempoOf(item);
  const wholeMs = (4 * 60000) / tempo;
  const allBars = [];
  bars.forEach((bar, barIndex) => {
    const steps = [];
    let cursorMs = 0;
    (bar.events || []).forEach((ev) => {
      const offMs = (ev.horizontal_offset_ms || 0) * OFFSET_GAIN;
      const startMs = Math.max(0, cursorMs + offMs);
      // A few lesson bars (notably the last note of the 5th bar) carry a 1/32
      // note (0.03125) that is too short to sound and is perceived as cut off.
      // Lift any note shorter than a 1/16 up to a full eighth (0.125) so it
      // plays at normal length.  Legit 1/16 (0.0625) notes are left untouched.
      let dur = ev.duration || 0.125;
      if (!ev.is_rest && dur < 0.0625) dur = 0.125;
      const durMs = Math.max(20, Math.round(dur * wholeMs));
      // Prefer the server-resolved pitch_class (correct for enharmonics in
      // lessons) combined with the octave parsed from the note_name; fall
      // back to noteNameToMidi with the key-sig map for key models.
      let midi = null;
      if (!ev.is_rest) {
        midi = midiFromEvent(ev, ks);
      }
      steps.push({
        midi, isRest: !!ev.is_rest, startMs, durationMs: durMs,
        volume: ev.volume || 80, eventIndex: ev.event_index,
        aliasDegree: ev.alias_degree,
      });
      cursorMs = startMs + durMs;
    });
    allBars.push({ barIndex, steps });
  });
  return allBars;
}

/**
 * Resolve a single event to a MIDI note number.
 *
 * Uses the server-resolved `pitch_class` (0-11) when present (lessons already
 * account for key-signature accidentals), combined with the octave parsed
 * from `note_name`.  Falls back to full noteNameToMidi resolution (used for
 * key models, which carry a key_signature but no per-event pitch_class in the
 * rendered UI - though the API does include it).  Returns null for rests.
 */
function midiFromEvent(ev, ks) {
  const pc = ev.pitch_class;
  if (pc != null && pc >= 0 && pc <= 11) {
    // octave from the note token (bare letter => octave index 0 -> MIDI 48/C3).
    const tok = parseNoteTokenLite(ev.note_name);
    if (tok) {
      const octIndex = tok.octave ?? 0;
      // Index 1 -> MIDI octave 4 (C4=60); matches the VexFlow stave rendering.
      return 12 * (4 + octIndex) + pc;
    }
  }
  return noteNameToMidi(ev.note_name, ks);
}

// Minimal octave extractor (avoids importing parseNoteToken which lives in
// notation.js and is already pulled in above for other helpers).
function parseNoteTokenLite(name) {
  if (!name) return null;
  const m = name.trim().match(/^([cdefgah])(\d)?/);
  if (!m) return null;
  return { letter: m[1], octave: m[2] ? parseInt(m[2], 10) : null };
}

/** Total duration in ms of a single bar's step list. */
export function barDurationMs(barSteps) {
  if (!barSteps || !barSteps.steps.length) return 0;
  const last = barSteps.steps[barSteps.steps.length - 1];
  return last.startMs + last.durationMs;
}

/** Convert a sequence of bar indices into a flat schedule the player can play. */
export function barsToFlat(barSteps, order, renderer) {
  const steps = [];
  let cursorMs = 0;
  let noteCount = 0;
  order.forEach((barIndex) => {
    const bar = barSteps[barIndex];
    const range = renderer ? renderer.getBarNoteRange(barIndex) : null;
    const scoreBase = range ? range.start : noteCount;
    bar.steps.forEach((s, localIdx) => {
      steps.push({
        midi: s.midi, isRest: s.isRest,
        startMs: cursorMs + s.startMs,
        durationMs: s.durationMs,
        volume: s.volume,
        barIndex,
        aliasDegree: s.aliasDegree,
        scoreGlobalIndex: scoreBase + localIdx,
      });
      noteCount += 1;
    });
    cursorMs += barDurationMs(bar);
  });
  return { steps };
}

/** The list of pitched MIDI notes in a bar (rests excluded), in order. */
export function barPitches(barSteps) {
  return (barSteps.steps || []).filter((s) => !s.isRest && s.midi != null).map((s) => s.midi);
}

/** The scale degrees (alias_degree) of the pitched notes in a bar. */
export function barDegrees(barSteps) {
  return (barSteps.steps || []).filter((s) => !s.isRest && s.midi != null).map((s) => s.aliasDegree);
}

/** Shuffle a copy of an array (Fisher-Yates). */
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Pick a random integer in [0, n). */
export function randInt(n) {
  return Math.floor(Math.random() * n);
}

/** The unique set of scale degrees available across the whole lesson. */
export function lessonDegrees(item, barStepsList) {
  const set = new Set();
  (barStepsList || buildBarSteps(item)).forEach((b) => {
    b.steps.forEach((s) => {
      if (!s.isRest && s.aliasDegree != null && s.aliasDegree !== "") set.add(s.aliasDegree);
    });
  });
  return Array.from(set);
}