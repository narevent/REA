/**
 * soundPresets.js
 *
 * A collection of expressive synthesised "presets" for the AudioPlayer.
 * Instead of the single hard-coded test tone, each preset builds a voice for
 * one note from several oscillators (per-voice type, ratio to the
 * fundamental, gain, detune) routed through an optional shared biquad filter
 * and an optional tremolo (amplitude modulation) LFO, shaped by an ADSR
 * envelope.  This is additive/subtractive + FM-ish synthesis in its simplest
 * sample-free form, tuned by ear to give characterful, musical timbres that
 * read well for monophonic solfège playback — bells, plucks, pads, keys,
 * glass, air, and analog-style lead tones — well beyond a generic
 * General-MIDI sine/triangle.
 *
 * A preset is a plain object:
 *
 *   {
 *     id, label, group,                 stable id + human name + UI grouping
 *     detune: cents (optional),          global fine detune for richness
 *     voices: [                          one entry per oscillator
 *       { type, ratio, gain, detune,     ratio: multiple of the fundamental
 *         decay, sustain }               optional per-voice decay (see below)
 *     ],
 *     filter: { type, freq, q } (optional), shared biquad filter
 *     tremolo: { rate, depth } (optional), AM LFO (rate Hz, depth 0..1)
 *     attack, decay, sustain, release,   ADSR in seconds (release is a cap)
 *     releasePct (optional),             fraction of note length for release
 *     level,                             master output gain (0..1)
 *   }
 *
 * `ratio` 1 = fundamental, 2 = octave, 3 = octave+fifth, 4.2 = a slightly
 * inharmonic octave (the off-integer ratios are what give bells/marimbas
 * their character).  `gain` is per-voice peak gain *before* the master
 * `level`, so presets stay at a comparable loudness.
 *
 * `decay` / `sustain` on a *voice* give that partial an envelope of its own,
 * decaying to `sustain` x its peak over `decay` seconds.  Without it every
 * partial holds its level for as long as the note does, which is what an
 * organ pipe does and what a struck string emphatically does not: on a real
 * piano the bright upper partials are gone within a fraction of a second and
 * the fundamental rings on underneath.  A single shared envelope cannot do
 * that, and it is the whole difference between a tone that sounds like an
 * instrument and one that sounds like a test signal.
 *
 * buildVoice() wires the voices through the (optional) filter + tremolo into
 * the returned input gain, and returns the { input, nodes, stop } the player
 * needs to start/release everything.
 */

/** The preset collection, in display order, grouped for the UI.  Each preset
 *  is tuned for monophonic pitch playback: clear fundamental, musical
 *  envelope, and a timbre that reads well at the short-to-medium note lengths
 *  the exercises use. */
export const SOUND_PRESETS = [
  // ---- Acoustic ------------------------------------------------------------
  // The plain instruments, first and default.  Everything below them is a
  // characterful synth voice, which is fine to practise against and wrong to
  // meet first: an ear-training exercise should sound like music being played,
  // not like a machine being tested.  These two carry that between them — one
  // struck and decaying, one sustained and steady — and both put a strong,
  // unambiguous fundamental in front of the singer, which is the thing they
  // are actually being asked to match.
  {
    id: "grand_piano",
    label: "Grand Piano",
    group: "Acoustic",
    // A struck string: a stack of partials, each quieter and shorter-lived
    // than the last, over a fundamental that rings on.  The ratios are
    // stretched very slightly sharp the way real string inharmonicity
    // stretches them, which is what stops the stack from fusing into an
    // organ-like buzz.
    voices: [
      { type: "sine", ratio: 1, gain: 0.55, decay: 1.8, sustain: 0.3 },
      { type: "sine", ratio: 2.002, gain: 0.24, decay: 1.1, sustain: 0.16 },
      { type: "sine", ratio: 3.008, gain: 0.12, decay: 0.7, sustain: 0.08 },
      { type: "sine", ratio: 4.02, gain: 0.065, decay: 0.45, sustain: 0.05 },
      { type: "sine", ratio: 5.04, gain: 0.04, decay: 0.3, sustain: 0.03 },
      { type: "sine", ratio: 6.07, gain: 0.022, decay: 0.22, sustain: 0.02 },
      { type: "triangle", ratio: 8.13, gain: 0.013, decay: 0.14, sustain: 0.01 },
    ],
    // Takes the top off the hammer strike so the attack reads as felt on wire
    // rather than as a click.
    filter: { type: "lowpass", freq: 4200, q: 0.7 },
    attack: 0.004, decay: 1.0, sustain: 0.34, release: 0.28, releasePct: 0.35,
    level: 0.9,
  },
  {
    id: "chamber_organ",
    label: "Chamber Organ",
    group: "Acoustic",
    // Principal stops: octaves and fifths, no decay, no wobble.  A tone that
    // holds absolutely still is the easiest thing there is to tune a voice
    // against, which is exactly what the singing chapters want.
    voices: [
      { type: "sine", ratio: 1, gain: 0.5 },
      { type: "sine", ratio: 2, gain: 0.22 },
      { type: "sine", ratio: 3, gain: 0.1, detune: 2 },
      { type: "sine", ratio: 4, gain: 0.07 },
      { type: "triangle", ratio: 6, gain: 0.025 },
      { type: "triangle", ratio: 8, gain: 0.018 },
    ],
    filter: { type: "lowpass", freq: 5200, q: 0.6 },
    attack: 0.03, decay: 0.06, sustain: 0.94, release: 0.12, releasePct: 0.3,
    level: 0.74,
  },

  // ---- Keys / mallets ------------------------------------------------------
  {
    id: "soft_triangle",
    label: "Soft Triangle",
    group: "Keys",
    voices: [
      { type: "triangle", ratio: 1, gain: 0.85 },
      { type: "sine", ratio: 2, gain: 0.12, detune: 3 },
    ],
    attack: 0.008, decay: 0.08, sustain: 0.82, release: 0.14, releasePct: 0.45,
    level: 0.88,
  },
  {
    id: "electric_piano",
    label: "Electric Piano",
    group: "Keys",
    voices: [
      { type: "sine", ratio: 1, gain: 0.62 },
      { type: "sine", ratio: 2, gain: 0.28, detune: 4 },
      { type: "triangle", ratio: 3.01, gain: 0.09 },
      { type: "sine", ratio: 14, gain: 0.015 }, // tine sparkle
    ],
    tremolo: { rate: 5.6, depth: 0.1 },
    attack: 0.004, decay: 0.28, sustain: 0.28, release: 0.3, releasePct: 0.6,
    level: 0.82,
  },
  {
    id: "celesta",
    label: "Celesta",
    group: "Keys",
    voices: [
      { type: "sine", ratio: 1, gain: 0.5 },
      { type: "sine", ratio: 3, gain: 0.22 },
      { type: "sine", ratio: 5, gain: 0.09 },
      { type: "sine", ratio: 7.1, gain: 0.04 },
    ],
    attack: 0.003, decay: 0.45, sustain: 0.16, release: 0.55, releasePct: 0.72,
    level: 0.8,
  },
  {
    id: "music_box",
    label: "Music Box",
    group: "Keys",
    voices: [
      { type: "sine", ratio: 1, gain: 0.55 },
      { type: "sine", ratio: 4, gain: 0.18 },
      { type: "sine", ratio: 6, gain: 0.06 },
      { type: "sine", ratio: 9.3, gain: 0.03 },
    ],
    attack: 0.003, decay: 0.28, sustain: 0.06, release: 0.5, releasePct: 0.72,
    level: 0.78,
  },
  {
    id: "marimba",
    label: "Marimba",
    group: "Keys",
    voices: [
      { type: "sine", ratio: 1, gain: 0.58 },
      { type: "sine", ratio: 4.2, gain: 0.16 }, // inharmonic 4th partial = woody body
      { type: "sine", ratio: 1, gain: 0.3, detune: -1200 }, // sub for resonance
    ],
    attack: 0.002, decay: 0.2, sustain: 0.16, release: 0.22, releasePct: 0.65,
    level: 0.84,
  },
  {
    id: "vibraphone",
    label: "Vibraphone",
    group: "Keys",
    voices: [
      { type: "sine", ratio: 1, gain: 0.54 },
      { type: "sine", ratio: 2, gain: 0.18 },
      { type: "sine", ratio: 3.01, gain: 0.06 },
    ],
    tremolo: { rate: 5.8, depth: 0.35 },
    attack: 0.004, decay: 0.7, sustain: 0.42, release: 0.75, releasePct: 0.65,
    level: 0.8,
  },
  {
    id: "harp_pluck",
    label: "Harp Pluck",
    group: "Keys",
    voices: [
      { type: "triangle", ratio: 1, gain: 0.58 },
      { type: "sine", ratio: 2, gain: 0.16 },
      { type: "sine", ratio: 3, gain: 0.07 },
      { type: "sine", ratio: 5, gain: 0.025 }, // string overtone
    ],
    attack: 0.0015, decay: 0.35, sustain: 0.05, release: 0.45, releasePct: 0.82,
    level: 0.8,
  },
  {
    id: "clavinet",
    label: "Clavinet",
    group: "Keys",
    voices: [
      { type: "sawtooth", ratio: 1, gain: 0.44 },
      { type: "square", ratio: 2, gain: 0.12 },
      { type: "sine", ratio: 1, gain: 0.1, detune: -3 }, // slight body
    ],
    filter: { type: "lowpass", freq: 2400, q: 1.2 },
    attack: 0.002, decay: 0.14, sustain: 0.28, release: 0.12, releasePct: 0.45,
    level: 0.68,
  },

  // ---- Bells / glass -------------------------------------------------------
  {
    id: "crystal_bells",
    label: "Crystal Bells",
    group: "Bells",
    voices: [
      { type: "sine", ratio: 1, gain: 0.58 },
      { type: "sine", ratio: 2, gain: 0.3 },
      { type: "sine", ratio: 3, gain: 0.18 },
      { type: "sine", ratio: 4.2, gain: 0.08 },
      { type: "sine", ratio: 5.4, gain: 0.04 },
    ],
    attack: 0.004, decay: 0.55, sustain: 0.22, release: 0.65, releasePct: 0.62,
    level: 0.82,
  },
  {
    id: "glass_organ",
    label: "Glass Organ",
    group: "Bells",
    voices: [
      { type: "sine", ratio: 1, gain: 0.58 },
      { type: "sine", ratio: 2, gain: 0.3 },
      { type: "sine", ratio: 3, gain: 0.12 },
      { type: "sine", ratio: 4.01, gain: 0.05 },
    ],
    attack: 0.05, decay: 0.05, sustain: 0.95, release: 0.2, releasePct: 0.35,
    level: 0.78,
  },
  {
    id: "tubular_bell",
    label: "Tubular Bell",
    group: "Bells",
    voices: [
      { type: "sine", ratio: 1, gain: 0.5 },
      { type: "sine", ratio: 2.76, gain: 0.22 },
      { type: "sine", ratio: 5.4, gain: 0.1 },
      { type: "sine", ratio: 8.9, gain: 0.04 },
    ],
    attack: 0.006, decay: 1.0, sustain: 0.28, release: 1.0, releasePct: 0.72,
    level: 0.78,
  },
  {
    id: "kalimba",
    label: "Kalimba",
    group: "Bells",
    voices: [
      { type: "sine", ratio: 1, gain: 0.55 },
      { type: "sine", ratio: 2.01, gain: 0.14 },
      { type: "triangle", ratio: 3.2, gain: 0.05 },
      { type: "sine", ratio: 1, gain: 0.18, detune: -1200 }, // resonant body
    ],
    attack: 0.001, decay: 0.24, sustain: 0.1, release: 0.32, releasePct: 0.72,
    level: 0.8,
  },
  {
    id: "wind_chime",
    label: "Wind Chime",
    group: "Bells",
    voices: [
      { type: "sine", ratio: 1, gain: 0.48 },
      { type: "sine", ratio: 2.4, gain: 0.18 },
      { type: "sine", ratio: 4.1, gain: 0.08 },
    ],
    tremolo: { rate: 1.1, depth: 0.3 },
    attack: 0.01, decay: 0.75, sustain: 0.1, release: 0.85, releasePct: 0.82,
    level: 0.76,
  },

  // ---- Pads / air ----------------------------------------------------------
  {
    id: "warm_pad",
    label: "Warm Pad",
    group: "Pads",
    detune: 6,
    voices: [
      { type: "sawtooth", ratio: 1, gain: 0.48, detune: -7 },
      { type: "sawtooth", ratio: 1, gain: 0.48, detune: 7 },
      { type: "triangle", ratio: 0.5, gain: 0.24 },
      { type: "sine", ratio: 2, gain: 0.06 },
    ],
    filter: { type: "lowpass", freq: 1700, q: 0.7 },
    attack: 0.12, decay: 0.2, sustain: 0.82, release: 0.28, releasePct: 0.42,
    level: 0.58,
  },
  {
    id: "ambient_pad",
    label: "Ambient Pad",
    group: "Pads",
    detune: 9,
    voices: [
      { type: "sawtooth", ratio: 1, gain: 0.38, detune: -10 },
      { type: "sawtooth", ratio: 1, gain: 0.38, detune: 10 },
      { type: "sine", ratio: 0.5, gain: 0.28 },
      { type: "sine", ratio: 2, gain: 0.07 },
    ],
    filter: { type: "lowpass", freq: 1200, q: 0.5 },
    tremolo: { rate: 0.55, depth: 0.2 },
    attack: 0.4, decay: 0.3, sustain: 0.85, release: 0.45, releasePct: 0.4,
    level: 0.52,
  },
  {
    id: "breathy_flute",
    label: "Breathy Flute",
    group: "Pads",
    voices: [
      { type: "sine", ratio: 1, gain: 0.58 },
      { type: "triangle", ratio: 2, gain: 0.05 },
      { type: "sawtooth", ratio: 8, gain: 0.02 }, // breath noise
      { type: "sine", ratio: 0.5, gain: 0.1 },
    ],
    filter: { type: "bandpass", freq: 0, q: 0.6 },
    tremolo: { rate: 11, depth: 0.07 },
    attack: 0.06, decay: 0.08, sustain: 0.9, release: 0.16, releasePct: 0.35,
    level: 0.68,
  },
  {
    id: "string_ensemble",
    label: "String Ensemble",
    group: "Pads",
    detune: 6,
    voices: [
      { type: "sawtooth", ratio: 1, gain: 0.38, detune: -6 },
      { type: "sawtooth", ratio: 1, gain: 0.38, detune: 6 },
      { type: "sawtooth", ratio: 1, gain: 0.28, detune: -2 },
      { type: "sine", ratio: 0.5, gain: 0.1 },
    ],
    filter: { type: "lowpass", freq: 2500, q: 0.6 },
    attack: 0.09, decay: 0.12, sustain: 0.84, release: 0.24, releasePct: 0.42,
    level: 0.48,
  },
  {
    id: "choir_aah",
    label: "Choir Ahh",
    group: "Pads",
    detune: 10,
    voices: [
      { type: "sawtooth", ratio: 1, gain: 0.3, detune: -8 },
      { type: "sawtooth", ratio: 1, gain: 0.3, detune: 8 },
      { type: "triangle", ratio: 1, gain: 0.17 },
      { type: "sine", ratio: 0.5, gain: 0.15 },
    ],
    filter: { type: "lowpass", freq: 1900, q: 0.8 },
    tremolo: { rate: 4.5, depth: 0.1 },
    attack: 0.18, decay: 0.2, sustain: 0.82, release: 0.32, releasePct: 0.42,
    level: 0.48,
  },

  // ---- Leads ---------------------------------------------------------------
  {
    id: "analog_lead",
    label: "Analog Lead",
    group: "Leads",
    voices: [
      { type: "sawtooth", ratio: 1, gain: 0.48, detune: -4 },
      { type: "sawtooth", ratio: 1, gain: 0.48, detune: 4 },
      { type: "square", ratio: 2, gain: 0.08 },
    ],
    filter: { type: "lowpass", freq: 2900, q: 1.2 },
    attack: 0.01, decay: 0.1, sustain: 0.76, release: 0.16, releasePct: 0.42,
    level: 0.54,
  },
  {
    id: "warm_sine_lead",
    label: "Warm Sine Lead",
    group: "Leads",
    voices: [
      { type: "sine", ratio: 1, gain: 0.58 },
      { type: "sine", ratio: 2, gain: 0.16, detune: 3 },
      { type: "triangle", ratio: 1, gain: 0.22, detune: -6 },
    ],
    tremolo: { rate: 4.2, depth: 0.08 },
    attack: 0.02, decay: 0.08, sustain: 0.86, release: 0.2, releasePct: 0.42,
    level: 0.7,
  },
  {
    id: "pulse_lead",
    label: "Pulse Lead",
    group: "Leads",
    voices: [
      { type: "square", ratio: 1, gain: 0.4 },
      { type: "square", ratio: 2, gain: 0.14 },
      { type: "sawtooth", ratio: 1, gain: 0.16, detune: 6 },
    ],
    filter: { type: "lowpass", freq: 3300, q: 0.9 },
    attack: 0.006, decay: 0.09, sustain: 0.78, release: 0.15, releasePct: 0.42,
    level: 0.48,
  },
  {
    id: "oboe_reed",
    label: "Oboe Reed",
    group: "Leads",
    voices: [
      { type: "sawtooth", ratio: 1, gain: 0.5 },
      { type: "sine", ratio: 2, gain: 0.14 },
      { type: "triangle", ratio: 3, gain: 0.06 },
      { type: "sawtooth", ratio: 1, gain: 0.12, detune: 8 }, // reed buzz
    ],
    filter: { type: "bandpass", freq: 0, q: 1.6 },
    attack: 0.03, decay: 0.06, sustain: 0.86, release: 0.15, releasePct: 0.35,
    level: 0.58,
  },
];

const DEFAULT_PRESET_ID = "grand_piano";
const STORAGE_KEY = "rea.soundPreset";

/** The default preset, by id — not by position, so reordering the list above
 *  can never silently change what a new student hears. */
function defaultPreset() {
  return SOUND_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID) || SOUND_PRESETS[0];
}

let _current = defaultPreset();
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    const found = SOUND_PRESETS.find((p) => p.id === saved);
    if (found) _current = found;
  }
} catch (e) { /* localStorage unavailable */ }

/** Current playback preset. */
export function getCurrentSoundPreset() { return _current; }

/** Select a preset by id (persists).  Falls back to the default. */
export function setSoundPresetById(id) {
  const p = SOUND_PRESETS.find((x) => x.id === id) || defaultPreset();
  _current = p;
  try { localStorage.setItem(STORAGE_KEY, p.id); } catch (e) {}
  return p;
}

/** Find a preset by id (or null). */
export function getSoundPresetById(id) {
  return SOUND_PRESETS.find((p) => p.id === id) || null;
}

/** Ordered unique group names (for the UI). */
export function soundPresetGroups() {
  const out = [];
  for (const p of SOUND_PRESETS) if (!out.includes(p.group)) out.push(p.group);
  return out;
}

/**
 * Build the WebAudio voice for a single note at `freq`, scheduled at time `t`
 * for `durSec`, on `ctx`, scaled by `vol` (0..1).  Returns
 * { input, nodes, stop(t) } where `input` is the gain feeding the destination
 * (so the caller can also route it elsewhere) and `nodes` lists everything
 * that must be started/stopped.  `stop(t)` cleanly releases the voice.
 *
 * The envelope is an ADSR applied to the master output gain; attack/decay are
 * clamped so short notes never produce a non-monotonic automation (which
 * WebAudio resolves unpredictably and clicks).  All ramps are scheduled on
 * the AudioContext clock for sample-accurate, click-free transitions.  An
 * optional tremolo LFO modulates the master gain for vibrato/shimmer; an
 * optional shared filter shapes the combined voices (bandpass filters with
 * `freq: 0` track the note's fundamental so reed/flute tones sit on pitch).
 */
export function buildVoice(ctx, freq, t, durSec, vol, preset) {
  const p = preset || _current;
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, t);

  // Optional shared filter before the master gain.  A bandpass with freq 0 is
  // a marker meaning "track the note frequency" — set it to the fundamental
  // so the tone keeps its pitch character across the register.
  let filter = null;
  if (p.filter) {
    filter = ctx.createBiquadFilter();
    filter.type = p.filter.type;
    const fFreq = (p.filter.type === "bandpass" && !p.filter.freq) ? freq : (p.filter.freq || freq);
    filter.frequency.setValueAtTime(fFreq, t);
    filter.Q.setValueAtTime(p.filter.q != null ? p.filter.q : 1, t);
    filter.connect(out);
  }
  const voiceDest = filter || out;

  // Optional tremolo: an LFO whose output scales a dedicated gain node between
  // the voices and the filter, modulated around unity (1 - depth/2 .. 1 +
  // depth/2).  This gives vibrato-like amplitude shimmer without affecting
  // the ADSR shape.
  let tremGain = null;
  if (p.tremolo && p.tremolo.depth > 0) {
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.setValueAtTime(p.tremolo.rate, t);
    const lfoGain = ctx.createGain();
    const depth = Math.max(0, Math.min(1, p.tremolo.depth));
    lfoGain.gain.setValueAtTime(depth * 0.5, t);
    tremGain = ctx.createGain();
    tremGain.gain.setValueAtTime(1 - depth * 0.5, t); // centre around unity
    lfo.connect(lfoGain).connect(tremGain.gain);
    lfo.start(t);
    // Tremolo LFO runs for the whole note (it has no envelope of its own).
    lfo.stop(t + durSec + 0.05);
    tremGain.connect(voiceDest);
  }
  const finalVoiceDest = tremGain || voiceDest;

  const nodes = [];
  const peak = Math.max(0.0001, vol * (p.level != null ? p.level : 0.9));
  const attackClamp = Math.min(p.attack != null ? p.attack : 0.008, durSec * 0.5);
  for (const v of p.voices) {
    const osc = ctx.createOscillator();
    osc.type = v.type;
    osc.frequency.setValueAtTime(freq * (v.ratio || 1), t);
    // Per-voice + global detune (cents).
    const detune = (v.detune || 0) + (p.detune || 0);
    if (detune) osc.detune.setValueAtTime(detune, t);

    // Per-voice gain shapes that voice's contribution, and — where the preset
    // asks for one — that voice's own decay on top of the shared envelope.
    // Clamped inside the note the same way the master ADSR is, so a short note
    // can never schedule a partial's decay past its own end.
    const vg = ctx.createGain();
    const vPeak = Math.max(0.0001, peak * (v.gain != null ? v.gain : 1));
    vg.gain.setValueAtTime(0.0001, t);
    vg.gain.exponentialRampToValueAtTime(vPeak, t + attackClamp);
    if (v.decay > 0) {
      const vSus = Math.max(0.0001, vPeak * (v.sustain != null ? v.sustain : 0));
      const vEnd = Math.min(t + attackClamp + v.decay, t + durSec);
      if (vEnd > t + attackClamp + 0.001) vg.gain.exponentialRampToValueAtTime(vSus, vEnd);
    }

    osc.connect(vg).connect(finalVoiceDest);
    osc.start(t);
    nodes.push({ osc, gain: vg });
  }

  // ADSR on the master output gain (after the filter).  Sustain is a fraction
  // of peak; release ramps back to silence.  Decay is clamped so the sustain
  // plateau / release never start before the attack/decay ramps finish —
  // otherwise a long-attack preset on a short note schedules ramps past each
  // other (non-monotonic, click-prone).  For very short notes the attack is
  // clamped to the note length and the decay is skipped entirely.
  const attack = Math.min(p.attack != null ? p.attack : 0.008, durSec * 0.5);
  const decay = p.decay != null ? p.decay : 0.05;
  const sustain = p.sustain != null ? p.sustain : 0.8;
  const susLevel = Math.max(0.0001, peak * sustain);
  const releaseRaw = Math.max(0.01, p.release != null ? p.release : 0.1);
  const releasePct = p.releasePct != null ? p.releasePct : 0.4;

  const release = Math.min(releaseRaw, Math.max(0.01, durSec * releasePct));
  const relStart = t + Math.max(attack + 0.005, durSec - release);
  const decayEnd = Math.min(t + attack + decay, relStart - 0.002);

  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(peak, t + attack);
  if (decayEnd > t + attack + 0.001) {
    out.gain.exponentialRampToValueAtTime(susLevel, decayEnd);
  }
  out.gain.setValueAtTime(Math.min(susLevel, peak), relStart);
  out.gain.exponentialRampToValueAtTime(0.0001, t + durSec);

  const stop = (when) => {
    const w = Math.max(when, t + 0.005);
    try {
      out.gain.cancelScheduledValues(w);
      out.gain.setValueAtTime(Math.max(0.0001, out.gain.value), w);
      out.gain.exponentialRampToValueAtTime(0.0001, w + 0.03);
    } catch (e) { /* already stopped */ }
    for (const n of nodes) {
      try { n.osc.stop(w + 0.05); } catch (e) { /* already stopped */ }
    }
  };

  return { input: out, nodes, stop };
}