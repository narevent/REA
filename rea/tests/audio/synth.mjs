/**
 * Synthesised singing, for testing the pitch/onset chain without a microphone.
 *
 * Produces a Float32 signal at a given sample rate from a script of notes, with
 * the things a real voice does that a naive tracker trips over: a scooped
 * attack, vibrato, a legato slide between notes, a re-articulation of the same
 * pitch, and a breath.
 */

export const SR = 48000;

// A seeded generator, so a case that passes today passes tomorrow.  The attack
// transients and the room tone are noise, and with Math.random() a borderline
// case flipped between runs — which makes a failure impossible to tell from a
// fluctuation, and that is worse than no test.
let _seed = 1;
export function reseed(n) { _seed = n >>> 0 || 1; }
function rnd() {
  // xorshift32
  _seed ^= _seed << 13; _seed >>>= 0;
  _seed ^= _seed >> 17;
  _seed ^= _seed << 5;  _seed >>>= 0;
  return _seed / 4294967296;
}

const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
// How long a singer takes to let a note go: measured off the recording, where
// the level falls some twenty dB over about a tenth of a second.
const RELEASE_SEC = 0.09;
// How fast a voice crosses between two notes: measured off the recording, at
// 98-215 cents in 67-117 ms and 553-747 cents in 150-300 ms.
const SLIDE_CENTS_PER_SEC = 3500;
// ...and how long a scoop into a note takes, which is a different gesture and
// a much slower one.
const SCOOP_SEC = 0.12;

/**
 * @param {Array} notes  [{ midi, ms, gapMs, scoopCents, vibCents, slideFrom,
 *                          amp, artic }]
 *   artic: "hard" (consonant-like broadband attack), "soft" (gentle swell),
 *          "legato" (no attack at all — ties to the previous note)
 *   driftCents: how far, end to end, the pitch wanders over the note — an
 *          unsure voice drifting inside its own note, one slow cycle long
 * @param {object} opts
 *   roomTone  rms of a room bed mixed under everything — low-frequency rumble
 *             plus hiss, which is what a real room sounds like to a
 *             microphone.  Rooms are not silent, and the rumble is the part
 *             that matters: it is periodic enough for a pitch tracker to
 *             report a confident note in it (measured at around 65 Hz on a
 *             real recording), so a gate that does not exclude it turns every
 *             silence in the exercise into a held note at B1.
 */
export function sing(notes, opts = {}) {
  reseed(opts.seed || 12345);
  const sr = opts.sampleRate || SR;
  const total = notes.reduce((n, x) => n + Math.ceil(((x.ms || 0) + (x.gapMs || 0)) * sr / 1000), 0);
  // Half a second of silence after the last note.  A singer's release plus the
  // recorder's own tail is at least that, and the exercise is entitled to use
  // silence to know a phrase has ended — at 0.2 s the tail was shorter than
  // the gap a held note is allowed before it counts as over, so the last note
  // of a case never closed and the bar never ended.
  const out = new Float32Array(total + Math.ceil(0.5 * sr));
  const marks = [];
  let phase = 0;
  let i = 0;

  for (let ni = 0; ni < notes.length; ni++) {
    const n = notes[ni];
    // Does the singer let this note go, or is the next one tied to it?
    //
    // A release used to be baked into every note's own tail, as the last six
    // per cent of it, falling to about a third of full level.  Both halves of
    // that are wrong, and the recording says how.  A real singer detaching two
    // notes lets the first fall about twenty dB over roughly a tenth of a
    // second — a *duration*, and the same one whether the note was long or
    // short, because it is the voice stopping rather than a shape drawn over
    // the note.  Six per cent of a 280 ms note is seventeen milliseconds, which
    // a 25 ms envelope cannot even follow: it read as a dip of one dB where the
    // real thing is eight to fifteen, so no test here could tell a note that
    // had been re-articulated from one that had not.  And a note slid into
    // legato has no release at all — that is what legato *is* — so whether
    // this note releases is a question about the next one.
    const next = notes[ni + 1];
    const tied = next && (next.artic || "hard") === "legato" && !next.gapMs;
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
      // A slide takes as long as the distance it covers, not as long as the
      // note it lands on.  This used to scale with the note — 0.45 of it, to a
      // tenth of a second — which made every step in a quick phrase a
      // portamento through nearly half its own note, and every leap in a slow
      // one as brief as a step.  The recording says otherwise, and plainly: a
      // hundred cents is crossed in 67 ms and seven hundred in 200, whatever
      // the tempo.  The voice travels at a roughly constant speed, and it is
      // the interval that decides how long that takes.
      const leap = from != null ? Math.abs(n.midi - from) * 100 : 0;
      const glideSec = Math.min(0.5 * (n.ms / 1000),
                                Math.max(0.03, leap / SLIDE_CENTS_PER_SEC));
      let midi = n.midi;
      if (from != null) {
        const slideU = Math.min(1, tSec / glideSec);
        midi = from + (n.midi - from) * slideU;
      }
      // A scoop is not a slide: it is a gesture inside the note, and a slow
      // one — the recording's are around 130 cents over 230 ms, a fifth of the
      // speed the voice changes note at.
      if (scoop) midi -= scoop * Math.max(0, 1 - tSec / SCOOP_SEC);
      if (vib) midi += vib * Math.sin(2 * Math.PI * 5.5 * tSec) * Math.min(1, tSec / 0.25);
      // A slow wander through the note, which is not vibrato and is not a
      // scoop: it is what an untrained voice does inside a note it is not sure
      // of, rising away from the pitch and sagging back over the note's whole
      // length.  On the recording it runs 100-330 cents — several times the
      // tolerance a note is allowed — at around a fifth of the speed the voice
      // changes note at.  Nothing here could express it, which is why every
      // test agreed that a note stays where it started.
      // One slow cycle over the note — up, back through the pitch, under, and
      // home — so the note's own pitch is still the one that was asked for.
      // A single hump would leave the whole note sharp, which is a different
      // fault and not the one being modelled.  At one cycle per note this sits
      // well under the vibrato band, which is the point: it is drift, and the
      // vibrato allowance must not be what rescues it.
      if (n.driftCents) midi += (n.driftCents / 200) * Math.sin(2 * Math.PI * u);

      // Amplitude envelope: attack shape depends on the articulation.
      let env;
      const artic = n.artic || "hard";
      if (artic === "legato") env = 1;
      else if (artic === "soft") env = Math.min(1, tSec / 0.09);
      else env = Math.min(1, tSec / 0.012);    // fast, consonant-like
      if (!tied) {
        const leftSec = (len - k) / sr;
        env *= Math.min(1, leftSec / RELEASE_SEC);
      }
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
      if (artic === "hard" && tSec < 0.02) s += (rnd() * 2 - 1) * 0.6 * (1 - tSec / 0.02);
      out[i] = s * amp * env;
    }
    for (let k = 0; k < gap; k++, i++) out[i] = (rnd() * 2 - 1) * 0.0004; // room tone
  }

  // The room, under all of it.  A slow rumble with a little hiss on top — the
  // rumble is deliberately periodic, because that is what makes a real room
  // dangerous to a pitch tracker rather than merely quiet.
  if (opts.roomTone) {
    const lvl = opts.roomTone;
    let lp = 0;
    for (let k = 0; k < out.length; k++) {
      const tSec = k / sr;
      const rumble = Math.sin(2 * Math.PI * 63 * tSec) + 0.4 * Math.sin(2 * Math.PI * 126 * tSec);
      lp += ((rnd() * 2 - 1) - lp) * 0.2;
      out[k] += lvl * (rumble * 1.2 + lp * 0.5);
    }
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
      onsetAttack: onset.attackDb(),
      midi: res ? 69 + 12 * Math.log2(res.freq / 440) : null,
      clarity: res ? res.clarity : 0,
      sampleAt: start,
    });
  }
  return frames;
}
