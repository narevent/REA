/**
 * sampler.js — a recorded piano, for the players.
 *
 * Every other sound in REA is synthesised, and a synthesised piano is a
 * stack of sine waves pretending: fine to tune against, unmistakably not an
 * instrument.  This plays the Salamander Grand Piano instead — a real grand,
 * recorded note by note (see `vendor/salamander/README.md` for the recording
 * and its CC BY licence).
 *
 * Thirty samples, one every minor third from A0 to C8; any other note is the
 * nearest one retuned, never by more than a semitone, which is too little to
 * hear as anything but that note.  The samples are fetched and decoded once,
 * the first time an AudioContext exists, and until they are ready the caller
 * falls back to the synthesised piano — so the very first note of a session
 * is never silence while a file downloads.
 */

/** The sampled notes, by file name, from A0 (MIDI 21) up in minor thirds. */
const NAMES = [
  "A0", "C1", "Ds1", "Fs1", "A1", "C2", "Ds2", "Fs2", "A2", "C3", "Ds3", "Fs3",
  "A3", "C4", "Ds4", "Fs4", "A4", "C5", "Ds5", "Fs5", "A5", "C6", "Ds6", "Fs6",
  "A6", "C7", "Ds7", "Fs7", "A7", "C8",
];
const SAMPLES = NAMES.map((name, i) => ({ name, midi: 21 + i * 3 }));
const BASE = new URL("../vendor/salamander/", import.meta.url);

/** How long a key takes to fall silent once it is let go, in seconds. */
const RELEASE = 0.35;

const buffers = new Map();
let loading = null;
let failed = false;

/**
 * Start fetching and decoding the samples on `ctx` (once).  Resolves when all
 * of them are ready; a sample that cannot be fetched leaves its neighbours to
 * cover for it, and if none can, the synthesised piano simply stays on.
 */
export function loadPiano(ctx) {
  if (loading || !ctx) return loading;
  loading = Promise.all(SAMPLES.map(async (sample) => {
    try {
      const res = await fetch(new URL(`${sample.name}.mp3`, BASE));
      if (!res.ok) return;
      const data = await res.arrayBuffer();
      const buffer = await new Promise((resolve, reject) => {
        // The callback form, because older Safari has no promise version.
        const p = ctx.decodeAudioData(data, resolve, reject);
        if (p && p.then) p.then(resolve, reject);
      });
      buffers.set(sample.midi, buffer);
    } catch (e) { /* its neighbours will play this register */ }
  })).then(() => {
    if (!buffers.size) failed = true;
  });
  return loading;
}

/** Whether the recorded piano can play yet. */
export function pianoReady() {
  return buffers.size > 0 && !failed;
}

/** The loaded sample nearest `midi`. */
function nearest(midi) {
  let best = null;
  buffers.forEach((buffer, sampleMidi) => {
    if (!best || Math.abs(sampleMidi - midi) < Math.abs(best.midi - midi)) best = { midi: sampleMidi, buffer };
  });
  return best;
}

/**
 * One note on the recorded piano, in the shape `soundPresets.buildVoice`
 * returns: `{input, nodes, stop}`.  The sample carries its own attack and
 * decay, as a struck string does; the key is let go at the end of the note
 * (or after the note's own tail, the score's `attack_decay_time`).
 */
export function pianoVoice(ctx, freq, t, durSec, vol, { release = null, level = 1 } = {}) {
  const midi = 69 + 12 * Math.log2(freq / 440);
  const sample = nearest(Math.round(midi));
  const out = ctx.createGain();
  if (!sample) return { input: out, nodes: [], stop: () => {} };
  const source = ctx.createBufferSource();
  source.buffer = sample.buffer;
  source.playbackRate.setValueAtTime(Math.pow(2, (midi - sample.midi) / 12), t);
  const peak = Math.max(0.0001, Math.min(1, vol) * level);
  out.gain.setValueAtTime(peak, t);
  const letGo = t + durSec + (release > 0 ? release : 0);
  out.gain.setValueAtTime(peak, letGo);
  out.gain.exponentialRampToValueAtTime(0.0001, letGo + RELEASE);
  source.connect(out);
  source.start(t);
  source.stop(letGo + RELEASE + 0.05);

  const stop = (when) => {
    const w = Math.max(when, ctx.currentTime);
    try {
      out.gain.cancelScheduledValues(w);
      out.gain.setValueAtTime(Math.max(0.0001, out.gain.value), w);
      out.gain.exponentialRampToValueAtTime(0.0001, w + 0.03);
    } catch (e) { /* already stopped */ }
    try { source.stop(w + 0.05); } catch (e) { /* already stopped */ }
  };
  return { input: out, nodes: [{ osc: source, gain: out }], stop };
}
