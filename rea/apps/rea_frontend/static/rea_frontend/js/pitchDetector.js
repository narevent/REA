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
 * what a pitch tracker wants.
 *
 * All values are relative to A4 = 440 Hz, matching audioPlayer.js.  The
 * per-frame callback shape is unchanged from earlier versions:
 *   { freq, midi, midiRound, cents, clarity, t }  (freq/midi null when unvoiced)
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
class Mpm {
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
    if (rms < 0.004) return null;               // silence
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
    this.buffer = null;
    this.mpm = null;
    this.running = false;
    this.rafId = null;
    this.onPitch = null; // (info) => void  — read every frame, may be swapped live
    this._resetSmoothing();
  }

  _resetSmoothing() {
    this._raw = [];       // recent raw (fractional) MIDI estimates, voiced only
    this._voiced = false;
    this._onCount = 0;
    this._offCount = 0;
    this._ema = null;     // smoothed MIDI
    this._last = null;    // last emitted voiced info (held through short dropouts)
  }

  /**
   * Start the microphone and the detection loop.
   * @param {function} onPitch  called with { freq, midi, midiRound, cents,
   *                            clarity, t } for every analysed frame (freq/midi
   *                            null when no pitch is being sung).
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
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = this.windowSize;      // time-domain window size
    this.analyser.smoothingTimeConstant = 0;
    this.buffer = new Float32Array(this.analyser.fftSize);
    this.source.connect(this.analyser);
    // analyser is deliberately NOT connected to destination (no mic feedback).

    this.mpm = new Mpm(
      this.ctx.sampleRate, this.windowSize, this.minHz, this.maxHz,
      this.clarityThreshold, this.peakThreshold,
    );
    this._resetSmoothing();

    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.analyser.getFloatTimeDomainData(this.buffer);
      const res = this.mpm.detect(this.buffer);
      this._process(res, performance.now());
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
    return true;
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.source) { try { this.source.disconnect(); } catch (e) {} this.source = null; }
    if (this.analyser) { try { this.analyser.disconnect(); } catch (e) {} this.analyser = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    this._resetSmoothing();
    // Do NOT close the shared ctx — the AudioPlayer may still use it.
  }

  get isRunning() { return this.running; }

  _emit(info) { if (this.onPitch) this.onPitch(info); }

  _emitUnvoiced(t) {
    this._emit({ freq: null, midi: null, midiRound: null, cents: 0, clarity: 0, t });
  }

  /** Turn a raw per-frame MPM result into a stable, de-jittered reading. */
  _process(res, t) {
    const clarity = res ? res.clarity : 0;

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
      this._emitUnvoiced(t);
      return;
    }
    if (!this._voiced) { this._emitUnvoiced(t); return; }

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

    if (this._last) this._emit(Object.assign({}, this._last, { t }));
    else this._emitUnvoiced(t);
  }
}
