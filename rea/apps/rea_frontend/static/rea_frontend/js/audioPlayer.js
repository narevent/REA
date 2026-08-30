/**
 * audioPlayer.js
 *
 * A tiny WebAudio synthesiser that plays a sequence of music events as a
 * melodic line.  No samples needed - each note is synthesised with an
 * oscillator + gain envelope, scheduled precisely via the AudioContext clock.
 *
 * The player accepts a flat list of "steps", each carrying an absolute
 * `startMs` (accumulated offset + durations) and a `durationMs`:
 *   { midi, startMs, durationMs, volume, isRest }
 *
 * `onStep(stepIndex)` is called as each step becomes current so the UI can
 * highlight the sounding note.  Pass -1 to clear (on stop).
 */

import { buildVoice, getCurrentSoundPreset } from "./soundPresets.js?v=80";

const A4_HZ = 440;
const A4_MIDI = 69;

function midiToFreq(midi) {
  return A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12);
}

export class AudioPlayer {
  constructor() {
    this.ctx = null;
    this.scheduled = []; // {osc, gain, stepIndex}
    this.stepTimers = []; // setTimeout ids for onStep callbacks
    this.endTimer = null;
    this.onStep = null;
    this.isPlaying = false;
    this.startTime = 0; // performance.now() reference for the cursor
  }

  _ensureCtx() {
    if (!this.ctx) {
      // Share a single AudioContext across the app (synth + mic detector) so
      // one user gesture unlocks audio for every module and they share a clock.
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      if (window.__reaAudioCtx) this.ctx = window.__reaAudioCtx;
      else this.ctx = window.__reaAudioCtx = new Ctx();
    }
    // A WebAudio context may start 'suspended' until a user gesture occurs;
    // resume() is a no-op if already running.  We call it on every play so the
    // first click/Play reliably unlocks sound.
    if (this.ctx.state === "suspended") {
      const p = this.ctx.resume();
      if (p && p.catch) p.catch(() => {});
    }
    return true;
  }

  /**
   * Play a list of steps.  Each step's `startMs` is its absolute start time
   * measured from the beginning of the piece (accumulated offsets + durations).
   */
  play(steps, { onStep = null } = {}) {
    this.stop();
    if (!this._ensureCtx() || !steps || !steps.length) return false;
    this.onStep = onStep;
    this.isPlaying = true;

    const ctx = this.ctx;
    const startAt = ctx.currentTime + 0.1;
    const perfStart = performance.now();
    this.startTime = perfStart + 100; // match the 0.1s audio lead-in

    let endMs = 0;
    steps.forEach((step, i) => {
      const startMs = step.startMs || 0;
      const durSec = Math.max(0.02, (step.durationMs || 100) / 1000);
      const t = startAt + startMs / 1000;
      endMs = Math.max(endMs, startMs + (step.durationMs || 100));

      if (!step.isRest && step.midi != null) {
        const freq = midiToFreq(step.midi);
        const vol = (step.volume || 80) / 127;
        const preset = getCurrentSoundPreset();
        const voice = buildVoice(ctx, freq, t, durSec, vol, preset);
        voice.input.connect(ctx.destination);
        // Start scheduling is done inside buildVoice; track for stop().
        const oscs = voice.nodes.map((n) => n.osc);
        this.scheduled.push({ oscs, gain: voice.input, voice, stepIndex: i });
      }

      // Schedule the visual cursor callback for this step.
      const delay = startMs + 60;
      const id = setTimeout(() => {
        if (this.isPlaying && this.onStep) this.onStep(i);
      }, delay);
      this.stepTimers.push(id);
    });

    this.endTimer = setTimeout(() => this.stop(), endMs + 250);
    return true;
  }

  stop() {
    if (this.endTimer) { clearTimeout(this.endTimer); this.endTimer = null; }
    this.stepTimers.forEach((id) => clearTimeout(id));
    this.stepTimers = [];
    const now = this.ctx ? this.ctx.currentTime : 0;
    this.scheduled.forEach(({ oscs, gain, voice }) => {
      try {
        if (voice && voice.stop) { voice.stop(now); return; }
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(0.0001, now);
        (oscs || []).forEach((osc) => { try { osc.stop(now + 0.02); } catch (e) {} });
      } catch (e) { /* already stopped */ }
    });
    this.scheduled = [];
    this.isPlaying = false;
    if (this.onStep) this.onStep(-1);
  }
}