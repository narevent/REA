/**
 * Synthesised singing, for testing the pitch/onset chain without a microphone.
 *
 * Produces a Float32 signal at a given sample rate from a script of notes, with
 * the things a real voice does that a naive tracker trips over: a scooped
 * attack, vibrato, a legato slide between notes, a re-articulation of the same
 * pitch, and a breath.
 */

export const SR = 48000;

const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * @param {Array} notes  [{ midi, ms, gapMs, scoopCents, vibCents, slideFrom,
 *                          amp, artic }]
 *   artic: "hard" (consonant-like broadband attack), "soft" (gentle swell),
 *          "legato" (no attack at all — ties to the previous note)
 */
export function sing(notes, opts = {}) {
  const sr = opts.sampleRate || SR;
  const total = notes.reduce((n, x) => n + Math.ceil(((x.ms || 0) + (x.gapMs || 0)) * sr / 1000), 0);
  const out = new Float32Array(total + Math.ceil(0.2 * sr));
  const marks = [];
  let phase = 0;
  let i = 0;

  for (const n of notes) {
    const len = Math.ceil((n.ms * sr) / 1000);
    const gap = Math.ceil(((n.gapMs || 0) * sr) / 1000);
    const amp = n.amp != null ? n.amp : 0.22;
    const scoop = (n.scoopCents || 0) / 100;
    const vib = (n.vibCents || 0) / 100;
    const from = n.slideFrom != null ? n.slideFrom : null;
    marks.push({ startSample: i, midi: n.midi, artic: n.artic || "hard" });

    for (let k = 0; k < len; k++, i++) {
      const u = k / len;                       // 0..1 through the note
      const tSec = k / sr;
      // Pitch: an optional slide in from the previous note, a scoop that
      // resolves over the first ~120 ms, and vibrato once the note settles.
      // A singer moving fast slides fast: portamento and scoop scale with the
      // note, rather than eating a fixed 120 ms of a note that may only last
      // 220 ms.  A fixed slide made fast legato unsingable in a way no voice is.
      const glideSec = Math.min(0.12, 0.45 * (n.ms / 1000));
      let midi = n.midi;
      if (from != null) {
        const slideU = Math.min(1, tSec / glideSec);
        midi = from + (n.midi - from) * slideU;
      }
      if (scoop) midi -= scoop * Math.max(0, 1 - tSec / glideSec);
      if (vib) midi += vib * Math.sin(2 * Math.PI * 5.5 * tSec) * Math.min(1, tSec / 0.25);

      // Amplitude envelope: attack shape depends on the articulation.
      let env;
      const artic = n.artic || "hard";
      if (artic === "legato") env = 1;
      else if (artic === "soft") env = Math.min(1, tSec / 0.09);
      else env = Math.min(1, tSec / 0.012);    // fast, consonant-like
      env *= Math.min(1, (1 - u) / 0.06 + 0.35);
      // Dynamics within the note.  A singer swelling into a long note changes
      // level by several dB, which is exactly what the envelope half of onset
      // detection is looking for — so it has to be modelled, or the tests are
      // quietly agreeing that nobody sings expressively.
      if (n.swellDb) env *= Math.pow(10, (n.swellDb * Math.sin(Math.PI * u)) / 20);
      if (n.crescDb) env *= Math.pow(10, (n.crescDb * u) / 20);
      env = Math.min(1, env);

      const f = midiToHz(midi);
      phase += (2 * Math.PI * f) / sr;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;

      // A voice is not a sine: harmonics, and for a hard attack a brief
      // broadband burst — that burst is what spectral flux is meant to see.
      let s = Math.sin(phase)
            + 0.5 * Math.sin(2 * phase)
            + 0.25 * Math.sin(3 * phase)
            + 0.12 * Math.sin(4 * phase);
      s /= 1.87;
      if (artic === "hard" && tSec < 0.02) s += (Math.random() * 2 - 1) * 0.6 * (1 - tSec / 0.02);
      out[i] = s * amp * env;
    }
    for (let k = 0; k < gap; k++, i++) out[i] = (Math.random() * 2 - 1) * 0.0004; // room tone
  }
  return { signal: out, sampleRate: sr, marks };
}

/** Run a signal through Mpm + the onset detector, frame by frame, as the live
 *  loop does (hop = one animation frame at 60 fps). */
export function analyse(signal, sampleRate, Mpm, makeOnsetDetector, opts = {}) {
  const win = opts.windowSize || 2048;
  const hopMs = opts.hopMs || 16.7;
  const hop = Math.round((hopMs * sampleRate) / 1000);
  const mpm = new Mpm(sampleRate, win, 60, 1600, 0.5, 0.85);
  const onset = makeOnsetDetector(opts.onsetOpts);
  const gate = opts.noiseGate != null ? opts.noiseGate : 0.0025;
  const frames = [];
  const buf = new Float32Array(win);

  for (let start = 0, t = 0; start + win <= signal.length; start += hop, t += hopMs) {
    buf.set(signal.subarray(start, start + win));
    let sum = 0;
    for (let i = 0; i < win; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / win);
    const res = mpm.detect(buf);
    const db = 20 * Math.log10(Math.max(rms, 1e-7));
    const strength = onset.feed({
      flux: mpm.flux, db, sounding: rms >= gate * 0.7, t,
      dt: frames.length ? hopMs : 0,
    });
    frames.push({
      t, rms, db, flux: mpm.flux, onsetStrength: strength, onset: strength >= 1,
      midi: res ? 69 + 12 * Math.log2(res.freq / 440) : null,
      clarity: res ? res.clarity : 0,
      sampleAt: start,
    });
  }
  return frames;
}
