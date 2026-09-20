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

import { noteNameToMidi, keySignatureMap, modeChordToVexKey } from "./notation.js?v=167";
import { getTempoScale } from "./tempo.js?v=167";

const DEFAULT_TEMPO = 80;
// The event's stored offset is a *playback* offset — it moves when a note
// sounds, never where it is written — and one stored unit is twelve
// milliseconds of it.  The editor's `scoreDoc.js` says the same thing at
// greater length, and the two constants have to agree: a teacher previewing an
// exercise and a student practising it must hear the same timing.
const OFFSET_GAIN = 12;
const A4_MIDI = 69;

/** How much of its written length a note in a tuplet actually sounds.
 *  1 for every ordinary note, which is nearly all of them. */
export function tupletRatio(event) {
  const num = event && event.tuplet_num;
  const den = event && event.tuplet_den;
  return (num > 0 && den > 0) ? den / num : 1;
}

/** The silence after each bar, in milliseconds — the exercise's own
 *  `mid_bar_time`, which is stored in seconds. */
export function barGapMs(item) {
  const seconds = item && item.mid_bar_time;
  return Math.max(0, Math.round((Number(seconds) || 0) * 1000));
}

/**
 * Close the holes a delayed note leaves behind it.
 *
 * A positive playback offset says "sound this note late".  It moves the
 * note's start and nothing else, so the note before it stops at its written
 * length and the line breaks in two — which is not what a delay is for.  What
 * a teacher writes a delay for is a note that leans late while the line goes
 * on sounding underneath it, and that is what this does: any note whose
 * neighbour starts after it has finished is held open until the neighbour
 * arrives.
 *
 * It never shortens anything and it never reaches across a rest: a rest is a
 * silence somebody asked for, and holding a note through it would be the
 * editor overruling the score.  A negative offset — an anticipation — already
 * overlaps its neighbour and is left exactly as it is.
 */
export function applyLegato(steps, { cutAtSeparator = false } = {}) {
  for (let i = 0; i < steps.length - 1; i += 1) {
    const step = steps[i];
    const next = steps[i + 1];
    if (step.isRest || next.isRest) continue;
    // A separator is a silence somebody drew, so it is the one gap whose
    // treatment is a decision rather than a repair: the exercise says whether
    // the note before a breath is cut at it or rings through it.
    if (step.separator && cutAtSeparator) continue;
    const gap = next.startMs - (step.startMs + step.durationMs);
    if (gap > 0) step.durationMs += gap;
  }
  return steps;
}

/** The silence a separator opens in the playback, in milliseconds. */
export function separatorGapMs(item) {
  return Math.max(0, Math.round((Number(item && item.separator_time) || 0) * 1000));
}

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
 * eighth at full tempo).  Mono and key-model items are unaffected.
 *
 * The singer's own speed setting (`tempo.js`) is applied last, on top of all
 * of that.  This is the one place it is applied, and everything that
 * schedules or times a note comes through here — playback, the gaps between
 * notes, and the pace the singing tracker expects of the voice — so they can
 * never disagree about how fast the exercise is going. */
export function tempoOf(item) {
  const raw = item.tempo || DEFAULT_TEMPO;
  const t = raw > 10 ? raw : DEFAULT_TEMPO;
  const written = item.texture === "poly" ? t / 2 : t;
  return written * getTempoScale();
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
  const gapMs = barGapMs(item);
  const separatorMs = separatorGapMs(item);
  const cutAtSeparator = !!(item && item.separator_cancel_previous_note);
  // Whether the last note of a bar stops at the barline or rings into the
  // gap after it.  The source has carried the answer per exercise since the
  // beginning (`mute_last_played_notes_after_bar_finishes`) and nothing has
  // ever read it, so every phrase stopped dead at every barline.
  const holdAcrossBars = !(item && item.mute_last_played_notes_after_bar_finishes);
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
      // A tuplet keeps its written note value and sounds a fraction of it:
      // three eighths in the time of two are each two-thirds of an eighth.
      // The written value is what the stave draws and what the beaming
      // groups by; this is the only place the ratio touches the sound.
      const durMs = Math.max(20, Math.round(dur * wholeMs * tupletRatio(ev)));
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
        // The note's own decay, in seconds, or null to let the sound preset
        // decide.  Carried through to the synth rather than resolved here:
        // what a decay *sounds* like is the player's business.
        decaySec: ev.attack_decay_time != null ? Number(ev.attack_decay_time) : null,
        separator: ev.separator || "",
      });
      // A separator holds the next note off by the exercise's separator time —
      // the breath a singer takes between two phrases of a formula.
      cursorMs = startMs + durMs + (ev.separator ? separatorMs : 0);
    });
    applyLegato(steps, { cutAtSeparator });
    allBars.push({ barIndex, steps, gapAfterMs: gapMs, holdAcrossBars });
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
 *
 * Exported because the numeric view needs the same answer for its own note
 * chips: the pitch a degree stands for has to be the pitch the player sounds.
 */
export function midiFromEvent(ev, ks) {
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
  order.forEach((barIndex, place) => {
    const bar = barSteps[barIndex];
    const range = renderer ? renderer.getBarNoteRange(barIndex) : null;
    const scoreBase = range ? range.start : noteCount;
    bar.steps.forEach((s, localIdx) => {
      steps.push({
        midi: s.midi, isRest: s.isRest,
        startMs: cursorMs + s.startMs,
        durationMs: s.durationMs,
        volume: s.volume,
        decaySec: s.decaySec,
        separator: s.separator,
        barIndex,
        aliasDegree: s.aliasDegree,
        scoreGlobalIndex: scoreBase + localIdx,
      });
      noteCount += 1;
    });
    // The exercise's own silence after each bar.  It is what `mid_bar_time`
    // has always meant and the one place a student could not hear it: the
    // editor's preview spaced the bars and this — the playback a student
    // actually practises against — ran them together.
    const last = place === order.length - 1;
    cursorMs += barDurationMs(bar) + (last ? 0 : bar.gapAfterMs || 0);
  });
  // The note that ends a bar rings into the gap after it, unless the exercise
  // says to cut it there.  Done on the flattened schedule because it is the
  // only place both bars exist at once.
  for (let i = 0; i < steps.length - 1; i += 1) {
    const step = steps[i];
    const next = steps[i + 1];
    if (step.barIndex === next.barIndex) continue;
    const bar = barSteps[step.barIndex];
    if (!bar || !bar.holdAcrossBars || step.isRest || next.isRest) continue;
    const gap = next.startMs - (step.startMs + step.durationMs);
    if (gap > 0) step.durationMs += gap;
  }
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