/**
 * pitchDetector.js
 *
 * Live microphone pitch tracking using WebAudio + autocorrelation.
 *
 * Exposes a single class `PitchDetector` that:
 *   - opens the microphone via getUserMedia,
 *   - runs an AnalyserNode at ~44.1k sample rate,
 *   - on every animation frame runs an autocorrelation (ACF) detector to
 *     estimate the fundamental frequency of the incoming audio,
 *   - converts that frequency to a MIDI note (float, so callers can see
 *     how flat/sharp the user is) and to a rounded MIDI integer + cents,
 *   - reports the result through a callback so the UI can show a
 *     note-by-note report and score the sung notes.
 *
 * The detector is tuned for monophonic singing in roughly 80-1600 Hz,
 * which covers from low male singing to high female/child singing.
 *
 * All values are returned relative to A4 = 440 Hz, matching audioPlayer.js.
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

/**
 * Autocorrelation fundamental-frequency estimator.
 *
 * Returns the detected frequency in Hz, or 0 if no clear pitch was found.
 * Based on the well-known ACF-with-normalised-square-difference approach
 * (a.k.a. the McLeod / NSDF family) which is robust for monophonic voice.
 *
 * @param {Float32Array} buf  time-domain samples
 * @param {number} sampleRate  sample rate in Hz
 * @param {number} minHz  minimum expected fundamental
 * @param {number} maxHz  maximum expected fundamental
 */
function detectPitchACF(buf, sampleRate, minHz, maxHz) {
  const SIZE = buf.length;
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(SIZE - 1, Math.floor(sampleRate / minHz));

  // Compute the normalised square difference function (NSDF).
  // nsdf[k] in [-1, 1]; 1 = perfect periodicity at lag k.
  const nsdf = new Float32Array(maxLag + 1);
  let rms = 0;
  for (let i = 0; i < SIZE; i++) {
    const s = buf[i];
    rms += s * s;
  }
  rms = Math.sqrt(rms / SIZE);
  // Silence guard - below this we just return "no pitch".
  if (rms < 0.008) return 0;

  for (let k = minLag; k <= maxLag; k++) {
    let num = 0;
    let den = 0;
    for (let i = 0; i < SIZE - k; i++) {
      num += buf[i] * buf[i + k];
      den += buf[i] * buf[i] + buf[i + k] * buf[i + k];
    }
    nsdf[k] = den > 0 ? (2 * num) / den : 0;
  }

  // Find the first peak after the first zero crossing that reaches >= 0.8 of
  // the global max - this skips sub-harmonic peaks near the true lag.
  let maxVal = 0;
  for (let k = minLag; k <= maxLag; k++) if (nsdf[k] > maxVal) maxVal = nsdf[k];
  if (maxVal < 0.4) return 0; // not tonal enough

  let bestLag = 0;
  let bestVal = 0;
  for (let k = minLag; k <= maxLag; k++) {
    if (nsdf[k] > bestVal && nsdf[k] >= maxVal * 0.8) {
      bestVal = nsdf[k];
      bestLag = k;
    }
  }
  if (bestLag <= 0) return 0;

  // Parabolic interpolation around the peak for sub-sample accuracy.
  if (bestLag > minLag && bestLag < maxLag) {
    const a = nsdf[bestLag - 1];
    const b = nsdf[bestLag];
    const c = nsdf[bestLag + 1];
    const denom = a + c - 2 * b;
    if (denom !== 0) {
      const shift = (a - c) / (2 * denom);
      bestLag = bestLag + Math.max(-1, Math.min(1, shift));
    }
  }
  return sampleRate / bestLag;
}

/**
 * Standard MIDI note name (Anglo-Saxon) for a MIDI number, e.g. 60 -> "C4".
 */
export function midiToName(midi) {
  if (midi == null || midi < 0 || midi > 127) return "-";
  const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return NAMES[pc] + oct;
}

export class PitchDetector {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.analyser = null;
    this.source = null;
    this.buffer = null;
    this.running = false;
    this.rafId = null;
    this.onPitch = null; // (info) => void
    this.minHz = 70;
    this.maxHz = 1600;
  }

  /**
   * Start the microphone and the detection loop.
   * @param {function} onPitch  called with { freq, midi, midiRound, cents,
   *                            clarity, t } for every analysed frame (freq
   *                            is null when no pitch was found).
   */
  async start(onPitch) {
    if (this.running) return true;
    this.onPitch = onPitch;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      throw new Error("Microphone access denied or unavailable: " + e.message);
    }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error("WebAudio not supported in this browser.");
    // Use the existing AudioContext if one was already unlocked by the
    // AudioPlayer, so mic + synth share the same clock.
    this.ctx = playerSharedCtx(Ctx);
    if (this.ctx.state === "suspended") {
      const p = this.ctx.resume();
      if (p && p.catch) p.catch(() => {});
    }
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    this.buffer = new Float32Array(this.analyser.fftSize);
    this.source.connect(this.analyser);
    // Note: analyser is NOT connected to destination - we never play the mic
    // back through the speakers (would cause feedback).

    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.analyser.getFloatTimeDomainData(this.buffer);
      const freq = detectPitchACF(this.buffer, this.ctx.sampleRate, this.minHz, this.maxHz);
      const now = performance.now();
      if (!freq) {
        this.onPitch({ freq: null, midi: null, midiRound: null, cents: 0, clarity: 0, t: now });
      } else {
        const midi = hzToMidi(freq);
        const midiRound = Math.round(midi);
        const cents = Math.round((midi - midiRound) * 100);
        this.onPitch({ freq, midi, midiRound, cents, clarity: 1, t: now });
      }
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
    // Do NOT close the shared ctx - the AudioPlayer may still use it.
  }

  get isRunning() {
    return this.running;
  }
}

/**
 * Return a shared AudioContext so the mic detector and the synth player use
 * the same context (avoids creating multiple contexts and lets a single
 * user gesture resume both).  We stash it on window so multiple modules
 * agree on one instance.
 */
function playerSharedCtx(Ctx) {
  if (!window.__reaAudioCtx) {
    window.__reaAudioCtx = new Ctx();
  }
  return window.__reaAudioCtx;
}