/**
 * pitchDetector.js
 *
 * Real-time monophonic (voice) pitch tracking, built for solfège practice:
 * the user sings back a note and we must report *which* note, in the right
 * octave, stably enough to score - across bass, tenor, alto and soprano
 * ranges.
 *
 * Algorithm: the McLeod Pitch Method (MPM) - a normalised-square-difference
 * (NSDF) autocorrelation method that is the de-facto standard for robust
 * monophonic pitch and is specifically designed to avoid the octave errors
 * that plague naive autocorrelation.  The NSDF is computed via FFT
 * (O(N log N)) so we can afford a large analysis window (good low-voice
 * reliability) without dropping frames.  Octave robustness comes from
 * picking the *first* NSDF key-maximum that clears a threshold relative to
 * the tallest key-maximum (not simply the tallest peak, which is what causes
 * sub-harmonic / octave-down jumps).
 *
 * Two things then turn a good per-frame estimate into a *stable* readout:
 *   1. A voiced/unvoiced state machine with hysteresis + a short hold, so the
 *      note doesn't flicker at onsets/sustains or during brief consonant-like
 *      dropouts.
 *   2. A median filter over recent frames (rejects the occasional single-frame
 *      octave outlier that survives step 1) followed by a light one-pole
 *      smoother (cents-level glide, no frame-to-frame jitter).
 *
 * The microphone is opened with echo-cancellation / noise-suppression /
 * auto-gain *disabled*: those are tuned for speech intelligibility and
 * actively distort pitch (AGC pumping, NS warble), which is the opposite of
 * what a pitch tracker wants.  In their place sits a *fixed* input trim plus a
 * level gate, both calibrated once in Soundcheck — see the "Input gain + noise
 * gate" section below for why static beats adaptive here.
 *
 * All values are relative to A4 = 440 Hz, matching audioPlayer.js.  The
 * per-frame callback shape is:
 *   { freq, midi, midiRound, cents, clarity, t, rms, db, gated }
 *   (freq/midi null when unvoiced; rms/db are the post-gain input level, so
 *    callers can meter the mic even while nothing is being sung)
 */

const A4_HZ = 440;
const A4_MIDI = 69;

/** Convert a frequency in Hz to a (fractional) MIDI note number. */
export function hzToMidi(freq) {
  if (!freq || freq <= 0) return null;
  return A4_MIDI + 12 * Math.log2(freq / A4_HZ);
}

/** Convert a MIDI note number to a frequency in Hz. */
export function midiToHz(midi) {
  return A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12);
}

/** Standard MIDI note name (Anglo-Saxon) for a MIDI number, e.g. 60 -> "C4". */
export function midiToName(midi) {
  if (midi == null || midi < 0 || midi > 127) return "-";
  const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const pc = ((Math.round(midi) % 12) + 12) % 12;
  const oct = Math.floor(Math.round(midi) / 12) - 1;
  return NAMES[pc] + oct;
}

// ---------------------------------------------------------------------------
// Voice-profile octave compensation.
//
// A very common (and physically real) situation: a male singer matching a
// piano/reference note sings the correct pitch class an octave lower than the
// note is written — his comfortable chest-voice octave.  The detector then
// *correctly* reports that lower octave, but it reads as "an octave off" from
// the note the user intended.  This offset transposes the reported note by a
// whole number of octaves so the notation and scoring line up with what the
// singer means.  It is a single app-wide setting (every PitchDetector
// instance honours it) and is persisted so a user calibrates once.  It only
// shifts the *note* representation (midi / note name) — the reported `freq`
// stays the true measured frequency.
// ---------------------------------------------------------------------------
const OCTAVE_OFFSET_KEY = "rea.voiceOctaveOffset";
let _voiceOctaveOffset = 0;
try {
  const v = parseInt(localStorage.getItem(OCTAVE_OFFSET_KEY), 10);
  if (!Number.isNaN(v)) _voiceOctaveOffset = Math.max(-3, Math.min(3, v));
} catch (e) { /* localStorage unavailable */ }

/** Current app-wide voice-profile octave offset (whole octaves). */
export function getVoiceOctaveOffset() { return _voiceOctaveOffset; }

/** Set the app-wide voice-profile octave offset (clamped to ±3 octaves).
 *  Applies immediately to every running detector and persists across reloads. */
export function setVoiceOctaveOffset(oct) {
  _voiceOctaveOffset = Math.max(-3, Math.min(3, Math.round(oct) || 0));
  try { localStorage.setItem(OCTAVE_OFFSET_KEY, String(_voiceOctaveOffset)); } catch (e) {}
  return _voiceOctaveOffset;
}

// ---------------------------------------------------------------------------
// Input gain + noise gate (mic calibration).
//
// The browser's own auto-gain is deliberately off (see `start`): AGC pumps,
// and pumping distorts pitch.  What a pitch tracker wants instead is a *fixed*
// gain, calibrated once, that puts the singer's comfortable voice at a healthy
// level and keeps it there — loud enough to sit well above the room's noise
// floor, quiet enough never to clip.
//
// The noise gate is the other half of the same calibration, and it matters
// more than it looks.  NSDF clarity is scale-invariant: room tone, a fan, a
// desk bump — anything with a bit of periodicity — can clear the clarity
// threshold at a whisper of a level and be reported as a real, confidently
// tracked note.  In the singing exercises that reads as the user having sung
// something, so notes get banked they never sang and the exercise appears to
// rush past them.  Gating on level below `_noiseGate` is what stops that: it
// is measured from the user's actual room during calibration, so it sits just
// above their noise floor and well below their singing.
//
// Both are single app-wide settings (every PitchDetector honours them),
// persisted so the user calibrates once, and applied live to running
// detectors so Soundcheck can hear its own adjustments immediately.
// ---------------------------------------------------------------------------
const INPUT_GAIN_KEY = "rea.inputGain";
const NOISE_GATE_KEY = "rea.noiseGate";

/** Gain bounds.  Below 0.2 or above 16 the problem is the system input level
 *  or mic placement, not something a software trim should paper over. */
export const INPUT_GAIN_MIN = 0.2;
export const INPUT_GAIN_MAX = 16;

/** Default gate, in post-gain RMS.  ≈ −52 dBFS: under any real singing voice,
 *  over digital silence.  Calibration replaces it with a room-derived value. */
const DEFAULT_NOISE_GATE = 0.0025;

/** Gate hysteresis: once open, it stays open down to this fraction of the
 *  threshold, so a note whose sustain decays near the gate doesn't stutter. */
const GATE_RELEASE_RATIO = 0.7;

let _inputGain = 1;
let _noiseGate = DEFAULT_NOISE_GATE;
try {
  const g = parseFloat(localStorage.getItem(INPUT_GAIN_KEY));
  if (!Number.isNaN(g) && g > 0) _inputGain = Math.max(INPUT_GAIN_MIN, Math.min(INPUT_GAIN_MAX, g));
  const n = parseFloat(localStorage.getItem(NOISE_GATE_KEY));
  if (!Number.isNaN(n) && n >= 0) _noiseGate = Math.max(0, Math.min(0.2, n));
} catch (e) { /* localStorage unavailable */ }

// Every running detector, so a gain change takes effect while the user listens.
// ---------------------------------------------------------------------------
// Onset detection
// ---------------------------------------------------------------------------
//
// Why this exists: without it the only way to know a new note has begun is a
// pitch change or a silence.  Neither covers the case that matters most in a
// sight-singing drill — the same pitch sung twice ("1 1 3 5").  Re-articulating
// a note rarely drops the level below the noise gate for long enough to read as
// silence, so two notes arrived as one long one, the exercise advanced a single
// slot, and every note after it was scored against the wrong reference.
//
// Two independent cues, because a singer can start a note in two different ways
// and each cue is blind to one of them:
//
//   FLUX  Rectified spectral flux (see Mpm._updateFlux): spectral *shape*
//         change.  Fires on a consonant, a new vowel, a glottal re-attack — the
//         things that make a new note audible without changing the pitch.  It
//         is normalised, so its threshold is adaptive: a running median plus a
//         multiple of the median absolute deviation, which tracks how noisy
//         this particular voice and room actually are rather than assuming.
//
//   ENV   A fast envelope crossing above a slow one, in dB.  This is the pure
//         level attack — the re-articulation flux is blind to, because a second
//         note on the same vowel and pitch has nearly the same spectral shape.
//
// A refractory period follows every onset.  Both cues can fire on the same
// attack, and a single attack must produce exactly one note.
const FLUX_BAND_LO_HZ = 100;    // below this is rumble and handling noise
const FLUX_BAND_HI_HZ = 5000;   // above this is mostly hiss for a sung voice
const FLUX_BANDS = 24;          // log-spaced bands across that range
const FLUX_FFT_SIZE = 1024;     // ~21 ms at 48 kHz: resolves an attack in time
const ONSET_REFRACTORY_MS = 80; // one attack, one onset
// Absolute floor for the flux test, set from measurement rather than taste
// (rea/tests/audio measures these on synthesised singing):
//
//   re-articulated note ............ 0.14 - 0.29   (varies: a 20 ms transient
//                                                   may straddle two frames)
//   legato slide to another pitch .. 0.19
//   wide vibrato (80 cents) ........ 0.13  sustained, not a burst
//   ordinary vibrato (45 cents) .... 0.07  sustained
//   steady sustain ................. 0.005
//
// The floor cannot be set above vibrato, because a badly-aligned articulation
// reaches only 0.14.  So the floor is set just clear of a *steady* sustain, and
// vibrato is left to the adaptive half of the threshold: while a voice is
// wobbling, its own running median and MAD rise with it, and the bar rises too.
// A burst stands out against its own recent past; a wobble is its own past.
const ONSET_FLUX_FLOOR = 0.06;
const ONSET_FLUX_K = 3.2;       // MAD multiples above the running median
// ...and it must also be a *jump*: at least this many times the largest flux of
// the last few frames.  A median-plus-MAD test looks backwards over ~400 ms, so
// a flux that climbs gradually — vibrato developing over the first beat of a
// held note — stays under the bar for a while and then quietly walks through
// it, splitting one note into three.  An articulation does not climb; it
// arrives.  Measuring the jump against the immediate past separates a burst
// from a swell without needing any lookahead, so it costs no latency.
const ONSET_FLUX_JUMP = 1.8;
const ONSET_JUMP_FRAMES = 4;   // ~65 ms of immediate past
const ONSET_ENV_ATTACK_DB = 3.5;// fast-over-slow envelope rise that counts as an attack
// Note for anyone tempted to require a simultaneous rise in level here: an
// articulation's flux spike lands on the *dip* — the consonant or glottal
// closure — not on the rise that follows it a frame or two later.  Gating flux
// on a rising envelope was tried and it suppressed every re-articulation while
// letting vibrato through.  The two cues are independent on purpose; they are
// combined by OR, not by AND.
const ONSET_ENV_FAST_MS = 25;
const ONSET_ENV_SLOW_MS = 180;
const ONSET_HISTORY = 24;       // ~400 ms of flux at 60 fps

function median(sorted) { return sorted[(sorted.length - 1) >> 1]; }

/**
 * Decide, frame by frame, when a new note has been articulated.
 *
 * Exported for testing: it is pure state over a stream of frames, so it can be
 * driven from synthesised audio without a microphone.
 *
 * @returns {{feed: function, reset: function}} `feed` returns true on the frame
 *   an onset is detected.
 */
export function makeOnsetDetector(opts) {
  const o = opts || {};
  const fluxFloor = o.fluxFloor != null ? o.fluxFloor : ONSET_FLUX_FLOOR;
  const fluxK = o.fluxK != null ? o.fluxK : ONSET_FLUX_K;
  const envAttackDb = o.envAttackDb != null ? o.envAttackDb : ONSET_ENV_ATTACK_DB;
  const refractoryMs = o.refractoryMs != null ? o.refractoryMs : ONSET_REFRACTORY_MS;

  let hist = [];
  let prevFlux = 0;
  let prevAttack = 0;
  let envFast = null, envSlow = null;
  let lastOnsetT = -1e9;
  let wasSounding = false;

  const reset = () => {
    hist = []; prevFlux = 0; prevAttack = 0;
    envFast = null; envSlow = null; wasSounding = false;
    lastOnsetT = -1e9;
  };

  return {
    reset,
    /**
     * @param {object} f  { flux, db, sounding, t, dt }
     *   `sounding` is the gate/voicing verdict: no onset is reported while the
     *   input is below the noise gate, or the room itself would articulate.
     */
    feed(f) {
      const t = f.t, dt = f.dt > 0 && f.dt < 500 ? f.dt : 0;

      if (!f.sounding) {
        // Silence resets the envelopes; the next sound starts a note on its own
        // account (below), so nothing is lost by forgetting the old levels.
        wasSounding = false;
        envFast = null; envSlow = null; prevAttack = 0; prevFlux = 0;
        return false;
      }

      // Sound after silence is always a note start, whatever the spectrum says.
      if (!wasSounding) {
        wasSounding = true;
        envFast = f.db; envSlow = f.db; prevAttack = 0; prevFlux = f.flux || 0;
        lastOnsetT = t;
        return true;
      }

      const db = f.db;
      if (envFast == null) { envFast = db; envSlow = db; }
      else if (dt) {
        envFast += (db - envFast) * Math.min(1, dt / ONSET_ENV_FAST_MS);
        envSlow += (db - envSlow) * Math.min(1, dt / ONSET_ENV_SLOW_MS);
      }
      const attack = envFast - envSlow;

      const flux = f.flux || 0;
      // Threshold from the recent past of this voice in this room.  MAD rather
      // than standard deviation: one loud onset already in the window must not
      // raise the bar enough to hide the next one.
      let thresh = fluxFloor;
      if (hist.length >= 8) {
        const sorted = hist.slice().sort((a, b) => a - b);
        const med = median(sorted);
        const devs = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
        thresh = Math.max(fluxFloor, med + fluxK * median(devs));
      }

      // Rising edge on both cues: an onset is the *start* of a change, and
      // testing the edge keeps the whole sustain that follows from re-firing.
      let recentMax = 0;
      for (let i = Math.max(0, hist.length - ONSET_JUMP_FRAMES); i < hist.length; i++) {
        if (hist[i] > recentMax) recentMax = hist[i];
      }
      const jumped = flux >= ONSET_FLUX_JUMP * recentMax;
      const fluxOnset = flux >= thresh && flux > prevFlux && jumped;
      const envOnset = attack >= envAttackDb && attack > prevAttack;

      hist.push(flux);
      if (hist.length > ONSET_HISTORY) hist.shift();
      prevFlux = flux;
      prevAttack = attack;

      if (t - lastOnsetT < refractoryMs) return false;
      if (fluxOnset || envOnset) { lastOnsetT = t; return true; }
      return false;
    },
  };
}

const _liveDetectors = new Set();

/** Current app-wide input gain (linear multiplier). */
export function getInputGain() { return _inputGain; }

/** Set the app-wide input gain; applies to running detectors and persists. */
export function setInputGain(g) {
  const v = Number(g);
  _inputGain = Math.max(INPUT_GAIN_MIN, Math.min(INPUT_GAIN_MAX, Number.isFinite(v) && v > 0 ? v : 1));
  try { localStorage.setItem(INPUT_GAIN_KEY, String(_inputGain)); } catch (e) {}
  _liveDetectors.forEach((d) => d._applyInputGain());
  return _inputGain;
}

/** Current app-wide noise gate, as a post-gain RMS level. */
export function getNoiseGate() { return _noiseGate; }

/** Set the app-wide noise gate (post-gain RMS) and persist it. */
export function setNoiseGate(rms) {
  const v = Number(rms);
  _noiseGate = Math.max(0, Math.min(0.2, Number.isFinite(v) && v >= 0 ? v : DEFAULT_NOISE_GATE));
  try { localStorage.setItem(NOISE_GATE_KEY, String(_noiseGate)); } catch (e) {}
  return _noiseGate;
}

/** True once the user has actually run a full input calibration, so the UI can
 *  prompt for one.  Keyed on the noise gate rather than the gain, because only
 *  a real calibration measures the room and writes a gate — nudging the gain
 *  by hand is a preference, not a calibration, and should not silence the
 *  prompt. */
export function hasCalibratedInput() {
  try { return localStorage.getItem(NOISE_GATE_KEY) != null; } catch (e) { return false; }
}

/** Linear amplitude -> dBFS, floored so a silent buffer doesn't return -Infinity. */
export function rmsToDb(rms) {
  if (!rms || rms <= 0) return -100;
  return Math.max(-100, 20 * Math.log10(rms));
}

/** RMS of a time-domain buffer. */
function bufferRms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

// ---------------------------------------------------------------------------
// FFT (iterative radix-2 Cooley-Tukey, in place).  Operates on parallel
// real/imag Float64Arrays whose length is a power of two.  `inverse` scales
// the result by 1/n so a forward-then-inverse round-trip is the identity.
// ---------------------------------------------------------------------------
function fft(re, im, inverse) {
  const n = re.length;
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + half];
        const bIm = im[i + k + half];
        const tRe = bRe * curRe - bIm * curIm;
        const tIm = bRe * curIm + bIm * curRe;
        re[i + k] = aRe + tRe;
        im[i + k] = aIm + tIm;
        re[i + k + half] = aRe - tRe;
        im[i + k + half] = aIm - tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

// ---------------------------------------------------------------------------
// MPM core (pure DSP, no audio).  Reused buffers keep the per-frame path
// allocation-free.  `detect(buf)` returns { freq, clarity } or null.
// ---------------------------------------------------------------------------
/* Exported for tests: the analysis is pure computation over a sample buffer,
   so it can be driven from synthesised singing without a microphone. */
export class Mpm {
  constructor(sampleRate, windowSize, minHz, maxHz, clarityThreshold, peakThreshold) {
    this.sampleRate = sampleRate;
    this.W = windowSize;
    this.clarityThreshold = clarityThreshold;
    this.peakThreshold = peakThreshold;
    this.minLag = Math.max(2, Math.floor(sampleRate / maxHz));
    this.maxLag = Math.min(windowSize - 2, Math.floor(sampleRate / minHz));
    this.minHz = minHz;
    this.maxHz = maxHz;
    this.N = nextPow2(windowSize * 2);       // zero-pad for linear autocorrelation
    this.re = new Float64Array(this.N);
    this.im = new Float64Array(this.N);
    this.nsdf = new Float64Array(windowSize);
    this.prefix = new Float64Array(windowSize + 1); // prefix sums of squares

    // Onset feature: rectified spectral flux over a voice band, taken from the
    // forward FFT this class already computes for the autocorrelation, so it
    // costs one pass over ~400 bins rather than a second transform.
    // The onset feature gets its own short, Hann-windowed transform rather
    // than riding on the autocorrelation's.  Two reasons, both decisive:
    // that window is deliberately un-windowed (windowing biases the NSDF), so
    // its per-bin magnitudes swing frame to frame purely from where the
    // waveform's phase lands — leakage far larger than an onset; and a shorter
    // window resolves an attack in time, which is exactly what an onset is.
    this.fluxN = FLUX_FFT_SIZE;
    this.fre = new Float64Array(this.fluxN);
    this.fim = new Float64Array(this.fluxN);
    this.hann = new Float64Array(this.fluxN);
    for (let i = 0; i < this.fluxN; i++) {
      this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.fluxN - 1));
    }
    // Log-spaced bands: a spectral change is a band-shaped thing, and summing
    // bins into bands averages out what leakage remains.
    this.fluxEdges = [];
    {
      const lo = FLUX_BAND_LO_HZ, hi = FLUX_BAND_HI_HZ;
      const nyqBin = (this.fluxN >> 1) - 1;
      for (let b = 0; b <= FLUX_BANDS; b++) {
        const hz = lo * Math.pow(hi / lo, b / FLUX_BANDS);
        const bin = Math.min(nyqBin, Math.max(1, Math.round((hz * this.fluxN) / sampleRate)));
        if (!this.fluxEdges.length || bin > this.fluxEdges[this.fluxEdges.length - 1]) {
          this.fluxEdges.push(bin);
        }
      }
    }
    const bands = Math.max(1, this.fluxEdges.length - 1);
    this.prevBand = new Float64Array(bands);
    this.curBand = new Float64Array(bands);
    this.hasPrevMag = false;
    this.flux = 0;
  }

  /**
   * Rectified spectral flux over the voice band, from the current spectrum.
   *
   * Both frames are normalised to unit sum before differencing, so this
   * measures a change in spectral *shape* — a re-articulation, a consonant, a
   * new vowel — and is deliberately blind to a pure change in level.  That
   * blindness is the point: it lets one threshold hold for a whisper and a
   * belt alike, and it leaves loudness to the envelope test, which is a
   * different question with a different answer.
   */
  /**
   * Rectified, band-wise spectral flux over the most recent FLUX_FFT_SIZE
   * samples — the onset feature.
   *
   * Both frames are normalised to unit sum before differencing, so this
   * measures a change in spectral *shape*: a consonant, a new vowel, a glottal
   * re-attack — the things that make a new note audible without changing the
   * pitch.  It is deliberately blind to a pure change in level, which keeps one
   * threshold honest for a whisper and a belt alike and leaves loudness to the
   * envelope test, a different question with a different answer.
   */
  _updateFlux(buf) {
    const n = this.fluxN, re = this.fre, im = this.fim, w = this.hann;
    const off = Math.max(0, this.W - n);       // the most recent n samples
    let mean = 0;
    for (let i = 0; i < n; i++) mean += buf[off + i];
    mean /= n;
    for (let i = 0; i < n; i++) { re[i] = (buf[off + i] - mean) * w[i]; im[i] = 0; }
    fft(re, im, false);

    const edges = this.fluxEdges, prev = this.prevBand, cur = this.curBand;
    const bands = cur.length;
    let sum = 0;
    for (let b = 0; b < bands; b++) {
      let e = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) e += re[k] * re[k] + im[k] * im[k];
      // Amplitude, not power: power is dominated by the fundamental, while an
      // onset's evidence is spread thinly across the upper bands.
      const a = Math.sqrt(e);
      cur[b] = a;
      sum += a;
    }
    if (!(sum > 0)) { this.flux = 0; this.hasPrevMag = false; return; }
    const inv = 1 / sum;
    let flux = 0;
    for (let b = 0; b < bands; b++) {
      const v = cur[b] * inv;
      cur[b] = v;
      if (this.hasPrevMag) { const d = v - prev[b]; if (d > 0) flux += d; }
    }
    this.flux = this.hasPrevMag ? flux : 0;
    prev.set(cur);
    this.hasPrevMag = true;
  }

  detect(buf) {
    const W = this.W, N = this.N, re = this.re, im = this.im;

    // Remove DC offset (mic bias skews autocorrelation) and measure level.
    let mean = 0;
    for (let i = 0; i < W; i++) mean += buf[i];
    mean /= W;
    let rms = 0;
    for (let i = 0; i < W; i++) {
      const s = buf[i] - mean;
      re[i] = s;
      im[i] = 0;
      rms += s * s;
    }
    rms = Math.sqrt(rms / W);
    if (rms < 0.004) {                          // silence
      // Drop the reference spectrum too: the first frame after a silence would
      // otherwise be differenced against whatever was being sung before it,
      // reporting a large flux for a note that has not started yet.
      this.flux = 0; this.hasPrevMag = false;
      return null;
    }
    // Onset feature first, and unconditionally: it must still be measured on a
    // frame whose pitch this method goes on to reject, because a consonant
    // carries no pitch at all and is precisely the cue we are after.
    this._updateFlux(buf);
    for (let i = W; i < N; i++) { re[i] = 0; im[i] = 0; }

    // Prefix sums of squares (for the NSDF normalisation term m(τ)).
    const prefix = this.prefix;
    prefix[0] = 0;
    for (let i = 0; i < W; i++) prefix[i + 1] = prefix[i] + re[i] * re[i];
    const energy = prefix[W];
    if (energy <= 0) return null;

    // Autocorrelation r(τ) via FFT: r = IFFT(|FFT(x)|²).
    fft(re, im, false);
    for (let i = 0; i < N; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
    fft(re, im, true);                          // re[τ] now holds r(τ)

    // NSDF: n(τ) = 2·r(τ) / m(τ),  m(τ) = Σx[j]² + Σx[j+τ]² over the overlap.
    const nsdf = this.nsdf, maxLag = this.maxLag;
    for (let tau = 0; tau <= maxLag; tau++) {
      const m = prefix[W - tau] + (energy - prefix[tau]);
      nsdf[tau] = m > 0 ? (2 * re[tau]) / m : 0;
    }

    // Key-maximum peak picking (this is the octave-robust part).  We collect
    // the local maxima that sit between a positive-going and the following
    // negative-going zero crossing, then choose the *first* whose height
    // clears peakThreshold × (tallest key max).  The first (shortest-lag)
    // qualifying peak is the true fundamental; later peaks are its sub-octaves.
    let pos = 0;
    while (pos < maxLag && nsdf[pos] > 0) pos++;   // skip the τ≈0 lobe
    while (pos < maxLag && nsdf[pos] <= 0) pos++;  // skip to first positive region

    let chosen = -1;
    let highest = 0;
    let curMax = 0;
    let curMaxPos = 0;
    const positions = [];
    while (pos < maxLag) {
      if (nsdf[pos] > nsdf[pos - 1] && nsdf[pos] >= nsdf[pos + 1]) {
        if (curMaxPos === 0 || nsdf[pos] > curMax) { curMax = nsdf[pos]; curMaxPos = pos; }
      }
      pos++;
      if (pos < maxLag && nsdf[pos] <= 0) {
        if (curMaxPos > 0) {
          positions.push(curMaxPos);
          if (nsdf[curMaxPos] > highest) highest = nsdf[curMaxPos];
          curMaxPos = 0;
          curMax = 0;
        }
        while (pos < maxLag && nsdf[pos] <= 0) pos++;
      }
    }
    if (curMaxPos > 0) {
      positions.push(curMaxPos);
      if (nsdf[curMaxPos] > highest) highest = nsdf[curMaxPos];
    }
    if (!positions.length || highest <= 0) return null;

    const threshold = this.peakThreshold * highest;
    for (let i = 0; i < positions.length; i++) {
      if (nsdf[positions[i]] >= threshold) { chosen = positions[i]; break; }
    }
    if (chosen < 0) return null;

    // Parabolic interpolation around the chosen peak for sub-sample accuracy.
    let tau = chosen;
    let clarity = nsdf[chosen];
    if (chosen > 0 && chosen < maxLag) {
      const a = nsdf[chosen - 1];
      const b = nsdf[chosen];
      const c = nsdf[chosen + 1];
      const denom = a - 2 * b + c;
      if (denom !== 0) {
        const shift = (0.5 * (a - c)) / denom;
        if (shift > -1 && shift < 1) {
          tau = chosen + shift;
          clarity = b - 0.25 * (a - c) * shift;
        }
      }
    }

    if (clarity < this.clarityThreshold) return null;
    if (tau < this.minLag || tau > this.maxLag) return null;
    const freq = this.sampleRate / tau;
    if (freq < this.minHz || freq > this.maxHz) return null;
    return { freq, clarity: Math.max(0, Math.min(1, clarity)) };
  }
}

export class PitchDetector {
  /**
   * @param {object} [opts]
   *   windowSize        analysis window in samples (power of two). Larger =
   *                     more reliable low-voice tracking, more latency.
   *   minHz/maxHz       vocal range to search (defaults span low bass to
   *                     high soprano so every voice type is covered).
   *   clarityThreshold  min NSDF peak height to accept a frame's pitch.
   *   peakThreshold     MPM key-max cutoff (fraction of the tallest key max).
   *   onThreshold/offThreshold + onFrames/offFrames  voicing hysteresis.
   *   medianWindow      frames of median filtering (octave-outlier rejection).
   *   emaAlpha          one-pole smoothing factor for the reported pitch.
   */
  constructor(opts = {}) {
    this.windowSize = opts.windowSize || 4096;
    this.minHz = opts.minHz != null ? opts.minHz : 60;   // ~B1, below low bass
    this.maxHz = opts.maxHz != null ? opts.maxHz : 1600;  // ~G6, above high soprano
    this.clarityThreshold = opts.clarityThreshold != null ? opts.clarityThreshold : 0.5;
    this.peakThreshold = opts.peakThreshold != null ? opts.peakThreshold : 0.85;
    this.onThreshold = opts.onThreshold != null ? opts.onThreshold : 0.6;
    this.offThreshold = opts.offThreshold != null ? opts.offThreshold : 0.4;
    this.onFrames = opts.onFrames != null ? opts.onFrames : 2;
    this.offFrames = opts.offFrames != null ? opts.offFrames : 4;
    this.medianWindow = opts.medianWindow || 5;
    this.emaAlpha = opts.emaAlpha != null ? opts.emaAlpha : 0.4;

    this.ctx = null;
    this.stream = null;
    this.analyser = null;
    this.source = null;
    this.gainNode = null;
    this.buffer = null;
    this.mpm = null;
    this.running = false;
    this.rafId = null;
    this.onPitch = null; // (info) => void  — read every frame, may be swapped live
    this._resetSmoothing();
  }

  _resetSmoothing() {
    if (!this._onset) this._onset = makeOnsetDetector();
    this._onset.reset();
    this._lastOnset = false;
    this._raw = [];       // recent raw (fractional) MIDI estimates, voiced only
    this._voiced = false;
    this._onCount = 0;
    this._offCount = 0;
    this._belowCount = 0; // consecutive frames under the noise gate
    this._gateOpen = false;
    this._ema = null;     // smoothed MIDI
    this._last = null;    // last emitted voiced info (held through short dropouts)
  }

  /** Push the app-wide input gain onto this detector's gain node (if running). */
  _applyInputGain() {
    if (!this.gainNode || !this.ctx) return;
    // A short ramp rather than a step: an instantaneous gain change is a click,
    // and a click is broadband — exactly the kind of transient that makes the
    // tracker report a spurious pitch for a frame or two.
    const g = getInputGain();
    try {
      this.gainNode.gain.setTargetAtTime(g, this.ctx.currentTime, 0.01);
    } catch (e) {
      this.gainNode.gain.value = g;
    }
  }

  /**
   * Start the microphone and the detection loop.
   * @param {function} onPitch  called with { freq, midi, midiRound, cents,
   *                            clarity, t, rms, db, gated } for every analysed
   *                            frame (freq/midi null when no pitch is being
   *                            sung; rms/db are always present).
   */
  async start(onPitch) {
    if (this.running) return true;
    this.onPitch = onPitch;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Disable speech-oriented processing — it distorts pitch.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (e) {
      throw new Error("Microphone access denied or unavailable: " + e.message);
    }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error("WebAudio not supported in this browser.");
    // Share the AudioContext already unlocked by the AudioPlayer so mic + synth
    // run on one clock and a single user gesture resumes both.
    this.ctx = window.__reaAudioCtx || (window.__reaAudioCtx = new Ctx());
    if (this.ctx.state === "suspended") {
      const p = this.ctx.resume();
      if (p && p.catch) p.catch(() => {});
    }
    this.source = this.ctx.createMediaStreamSource(this.stream);
    // Calibrated input trim, ahead of the analyser so every level the tracker
    // (and the meters) sees is the post-gain one.
    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = getInputGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = this.windowSize;      // time-domain window size
    this.analyser.smoothingTimeConstant = 0;
    this.buffer = new Float32Array(this.analyser.fftSize);
    this.source.connect(this.gainNode);
    this.gainNode.connect(this.analyser);
    // analyser is deliberately NOT connected to destination (no mic feedback).

    this.mpm = new Mpm(
      this.ctx.sampleRate, this.windowSize, this.minHz, this.maxHz,
      this.clarityThreshold, this.peakThreshold,
    );
    this._resetSmoothing();

    this.running = true;
    _liveDetectors.add(this);
    const loop = () => {
      if (!this.running) return;
      this.analyser.getFloatTimeDomainData(this.buffer);
      const rms = bufferRms(this.buffer);
      const res = this.mpm.detect(this.buffer);
      this._process(res, performance.now(), rms);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
    return true;
  }

  stop() {
    this.running = false;
    _liveDetectors.delete(this);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.source) { try { this.source.disconnect(); } catch (e) {} this.source = null; }
    if (this.gainNode) { try { this.gainNode.disconnect(); } catch (e) {} this.gainNode = null; }
    if (this.analyser) { try { this.analyser.disconnect(); } catch (e) {} this.analyser = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    this._resetSmoothing();
    // Do NOT close the shared ctx — the AudioPlayer may still use it.
  }

  get isRunning() { return this.running; }

  _emit(info) { if (this.onPitch) this.onPitch(info); }

  _emitUnvoiced(t, rms) {
    this._emit({
      freq: null, midi: null, midiRound: null, cents: 0, clarity: 0, t,
      rms: rms || 0, db: rmsToDb(rms), gated: !this._gateOpen,
      onset: this._lastOnset, flux: this._flux || 0,
    });
  }

  /** Turn a raw per-frame MPM result into a stable, de-jittered reading. */
  _process(res, t, rms) {
    const clarity = res ? res.clarity : 0;
    rms = rms || 0;
    this._flux = this.mpm ? this.mpm.flux : 0;

    // Onset runs on every frame, ahead of the voicing machine and independent
    // of whether this frame yielded a pitch.  A consonant carries no pitch at
    // all, and it is exactly the cue that a new note has begun.
    const dt = this._lastT == null ? 0 : t - this._lastT;
    this._lastT = t;
    this._lastOnset = this._onset.feed({
      flux: this._flux,
      db: rmsToDb(rms),
      sounding: rms >= getNoiseGate() * GATE_RELEASE_RATIO,
      t, dt,
    });

    // Level gate, ahead of everything else.  NSDF clarity says nothing about
    // loudness, so without this a quiet periodic hum reads as a confidently
    // tracked note.  Hysteresis (release at 70% of the gate) plus an
    // `offFrames` hold keeps a note from chattering when a sustain dips near
    // the threshold.
    const open = this._gateOpen
      ? rms >= getNoiseGate() * GATE_RELEASE_RATIO
      : rms >= getNoiseGate();
    this._gateOpen = open;
    this._belowCount = open ? 0 : this._belowCount + 1;
    // A below-gate frame may never *start* a note — otherwise clear-but-quiet
    // room tone gets a couple of frames through before the hold expires, and
    // those frames show up as a real note in the readout.  The `offFrames`
    // hold applies only to *ending* one, so a sustain dipping near the gate
    // doesn't stutter.
    if (!open && (!this._voiced || this._belowCount >= this.offFrames)) {
      if (this._voiced) {
        this._voiced = false;
        this._raw.length = 0;
        this._ema = null;
        this._last = null;
      }
      this._onCount = 0;
      this._offCount = this.offFrames;
      this._emitUnvoiced(t, rms);
      return;
    }

    // Voicing state machine with hysteresis (separate on/off thresholds).
    if (clarity >= this.onThreshold) { this._onCount++; this._offCount = 0; }
    else if (clarity < this.offThreshold) { this._offCount++; this._onCount = 0; }
    else { this._onCount = 0; }   // ambiguous middle band: don't confirm onset

    if (!this._voiced && this._onCount >= this.onFrames) {
      this._voiced = true;
      this._offCount = 0;
    }
    if (this._voiced && this._offCount >= this.offFrames) {
      this._voiced = false;
      this._raw.length = 0;
      this._ema = null;
      this._last = null;
      this._emitUnvoiced(t, rms);
      return;
    }
    if (!this._voiced) { this._emitUnvoiced(t, rms); return; }

    // Voiced.  Update the smoothed estimate on frames that carry a usable
    // pitch; otherwise hold the last reading (bridges brief dropouts so the
    // note name doesn't flicker mid-sustain).
    if (res && res.freq && clarity >= this.offThreshold) {
      const midi = hzToMidi(res.freq);
      this._raw.push(midi);
      if (this._raw.length > this.medianWindow) this._raw.shift();
      // Median rejects a stray single-frame octave outlier without lagging
      // the way a mean would.
      const sorted = this._raw.slice().sort((a, b) => a - b);
      const med = sorted[(sorted.length - 1) >> 1];
      // One-pole smoother for cents-level glide.
      this._ema = this._ema == null ? med : this._ema + (med - this._ema) * this.emaAlpha;
      const out = this._ema;
      // Voice-profile octave compensation applies to the *note* only; `freq`
      // stays the true measured frequency.  `cents` is octave-invariant.
      const shown = out + 12 * _voiceOctaveOffset;
      const round = Math.round(shown);
      this._last = {
        freq: midiToHz(out),
        midi: shown,
        midiRound: round,
        cents: Math.round((shown - round) * 100),
        clarity,
      };
    }

    if (this._last) {
      this._emit(Object.assign({}, this._last, {
        t, rms, db: rmsToDb(rms), gated: false,
        onset: this._lastOnset, flux: this._flux,
      }));
    }
    else this._emitUnvoiced(t, rms);
  }
}
