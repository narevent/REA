/**
 * soundcheckView.js
 *
 * A standalone calibration screen: is the microphone picking up the user
 * clearly, and does REA's pitch tracker report back what the user actually
 * sang?  Unlike the practice chapters, this isn't scored and isn't tied to
 * a lesson - it directly drives PitchDetector + NotationRenderer (bypassing
 * PracticeController, which is chapter/scoring-oriented).
 *
 * Usage: `const sc = new SoundcheckView(container, { player });`
 *   sc.enter()  - build the DOM (once) and show it.
 *   sc.leave()  - release the microphone when navigating away.
 */

import { NotationRenderer } from "../components/notationRenderer.js?v=56";
import {
  PitchDetector, midiToName, hzToMidi,
  getVoiceOctaveOffset, setVoiceOctaveOffset,
} from "../pitchDetector.js?v=56";

// Auto-detect: how long to listen while the user sings the reference, and the
// minimum number of voiced frames needed before we trust the measurement.
const CALIBRATE_MS = 2200;
const CALIBRATE_MIN_SAMPLES = 12;

/** Human label for an octave offset value. */
function offsetLabel(oct) {
  if (oct === 0) return "In pitch";
  return (oct > 0 ? "+" : "−") + Math.abs(oct) + " octave" + (Math.abs(oct) === 1 ? "" : "s");
}

// A single fixed reference tone (concert pitch A4 = 440 Hz) — enough for
// calibrating the mic and voice profile; no need for a full note picker.
// `token` is the source note-name format NotationRenderer/notation.js expects
// (see notation.js parseNoteToken).
const REFERENCE = { label: "A4 · 440 Hz", token: "a1", midi: 69 };

// Frames of silence (no clear pitch) before the readout blanks itself, at
// ~60fps (requestAnimationFrame) this is roughly half a second.
const SILENCE_FRAMES = 30;

function centsClass(cents) {
  const mag = Math.abs(cents);
  return mag <= 10 ? "good" : mag <= 25 ? "ok" : "off";
}

export class SoundcheckView {
  constructor(container, { player } = {}) {
    this.container = container;
    this.player = player;
    this.detector = new PitchDetector();
    this.renderer = null;
    this.silenceFrames = SILENCE_FRAMES;
    this.built = false;
    this.els = {};
    this._calibrating = false;      // auto-detect capture in progress
    this._calibSamples = null;      // true (uncompensated) sung MIDI samples
    this._calibTimer = null;
  }

  /** Show the view: build the DOM on first entry, re-draw the reference
   *  staff (cheap) every time in case the container was resized while
   *  hidden (VexFlow measures `clientWidth`, which is 0 while `hidden`). */
  enter() {
    if (!this.built) this._build();
    this._renderReferenceStaff();
  }

  /** Release the microphone when navigating away from Soundcheck. */
  leave() {
    this._cancelAutoDetect();
    this.stopMic();
  }

  _build() {
    this.built = true;
    this.container.innerHTML =
      '<div class="sc-wrap">' +
        '<div class="sc-hero">' +
          "<h2>Soundcheck</h2>" +
          "<p>Confirm your microphone and REA's pitch tracker agree with what you're " +
          "actually singing. Play a reference tone, sing it back, and check that the " +
          "note name, frequency and staff marker all line up.</p>" +
        "</div>" +
        '<div class="sc-panel">' +
          '<div class="sc-panel-head">' +
            '<span class="sc-panel-lbl">Microphone</span>' +
            '<span class="sc-mic-status" id="sc-mic-status"><span class="sc-dot"></span><span>Not started</span></span>' +
          "</div>" +
          '<button type="button" id="sc-mic-toggle" class="sc-btn primary">Enable microphone</button>' +
        "</div>" +
        '<div class="sc-panel">' +
          '<div class="sc-panel-head">' +
            '<span class="sc-panel-lbl">Voice profile</span>' +
            '<span class="sc-profile-cur" id="sc-profile-cur" title="Octave shift applied to the tracked pitch">In pitch</span>' +
          "</div>" +
          '<div class="sc-profile-controls">' +
            '<button type="button" id="sc-ref-play" class="sc-btn">Play ' + REFERENCE.label + "</button>" +
            '<div class="sc-stepper" title="Octave shift — nudge if your voice tracks an octave off (common for male voices)">' +
              '<button type="button" id="sc-oct-down" class="sc-step-btn" aria-label="Shift down an octave">−</button>' +
              '<span class="sc-oct-val" id="sc-oct-val">0</span>' +
              '<button type="button" id="sc-oct-up" class="sc-step-btn" aria-label="Shift up an octave">+</button>' +
            "</div>" +
            '<button type="button" id="sc-autodetect" class="sc-btn">Auto-detect</button>' +
            '<span class="sc-autodetect-status" id="sc-autodetect-status"></span>' +
          "</div>" +
        "</div>" +
        '<div class="sc-panel sc-live">' +
          '<div class="sc-panel-head"><span class="sc-panel-lbl">Live reading</span></div>' +
          '<div class="sc-readout">' +
            '<div class="sc-note" id="sc-note">–</div>' +
            '<div class="sc-hz" id="sc-hz">– Hz</div>' +
          "</div>" +
          '<div class="sc-meter">' +
            '<div class="sc-meter-track">' +
              '<div class="sc-meter-zero"></div>' +
              '<div class="sc-meter-needle" id="sc-meter-needle"></div>' +
            "</div>" +
            '<div class="sc-meter-scale"><span>-50¢</span><span>in tune</span><span>+50¢</span></div>' +
          "</div>" +
          '<div class="sc-cents muted" id="sc-cents">no signal yet</div>' +
          '<div id="soundcheck-notation" class="notation sc-notation"></div>' +
        "</div>" +
      "</div>";

    this.els = {
      micToggle: this.container.querySelector("#sc-mic-toggle"),
      micStatus: this.container.querySelector("#sc-mic-status"),
      refPlay: this.container.querySelector("#sc-ref-play"),
      note: this.container.querySelector("#sc-note"),
      hz: this.container.querySelector("#sc-hz"),
      needle: this.container.querySelector("#sc-meter-needle"),
      cents: this.container.querySelector("#sc-cents"),
      profileCur: this.container.querySelector("#sc-profile-cur"),
      octVal: this.container.querySelector("#sc-oct-val"),
      octDown: this.container.querySelector("#sc-oct-down"),
      octUp: this.container.querySelector("#sc-oct-up"),
      autoDetect: this.container.querySelector("#sc-autodetect"),
      autoStatus: this.container.querySelector("#sc-autodetect-status"),
    };
    this.renderer = new NotationRenderer(this.container.querySelector("#soundcheck-notation"));

    this.els.micToggle.addEventListener("click", () => this._toggleMic());
    this.els.refPlay.addEventListener("click", () => this._playReference());
    this.els.octDown.addEventListener("click", () => this._setOffset(getVoiceOctaveOffset() - 1));
    this.els.octUp.addEventListener("click", () => this._setOffset(getVoiceOctaveOffset() + 1));
    this.els.autoDetect.addEventListener("click", () => this._startAutoDetect());
    this._renderProfile();
  }

  /** Reflect the current voice-profile offset across its controls. */
  _renderProfile() {
    const off = getVoiceOctaveOffset();
    this.els.profileCur.textContent = offsetLabel(off);
    this.els.octVal.textContent = (off > 0 ? "+" : "") + off;
  }

  /** Apply a new octave offset (app-wide + persisted) and refresh the UI. */
  _setOffset(oct) {
    setVoiceOctaveOffset(oct);
    this._renderProfile();
  }

  _renderReferenceStaff() {
    this.renderer.render([{ notes: [{ name: REFERENCE.token, duration: 1 }] }]);
    // The marker renders the true tracked pitch (see showSungNote), so the
    // user sees the exact octave they sang — which is the whole point of a
    // calibration check.  The target is only used for the marker's colour.
    this.renderer.setSungTarget(0, REFERENCE.midi);
  }

  _playReference() {
    if (!this.player) return;
    this.player.play([{ midi: REFERENCE.midi, startMs: 0, durationMs: 1400, volume: 90 }]);
  }

  async _toggleMic() {
    if (this.detector.isRunning) { this.stopMic(); return; }
    this._setMicStatus("connecting", "Requesting access…");
    try {
      await this.detector.start((info) => this._onPitch(info));
      this._setMicStatus("on", "Listening");
      this.els.micToggle.textContent = "Stop microphone";
    } catch (e) {
      this._setMicStatus("error", e.message || "Microphone unavailable");
    }
  }

  stopMic() {
    this._cancelAutoDetect();
    this.detector.stop();
    this._setMicStatus("off", "Not started");
    if (this.els.micToggle) this.els.micToggle.textContent = "Enable microphone";
  }

  _setMicStatus(kind, text) {
    if (!this.els.micStatus) return;
    this.els.micStatus.innerHTML = '<span class="sc-dot ' + kind + '"></span><span>' + text + "</span>";
  }

  /** Listen to the user singing the selected reference and set the octave
   *  offset so their octave lines up with it — the "just sing and we'll match
   *  you" path, which is the most reliable way to get the octave right. */
  _startAutoDetect() {
    if (this._calibrating) return;
    if (!this.detector.isRunning) {
      this._setAutoStatus("Enable the microphone first.", "warn");
      return;
    }
    this._calibrating = true;
    this._calibSamples = [];
    this.els.autoDetect.disabled = true;
    this._setAutoStatus("Listening — sing A4…", "busy");
    this._calibTimer = setTimeout(() => this._finishAutoDetect(), CALIBRATE_MS);
  }

  _finishAutoDetect() {
    const samples = this._calibSamples || [];
    this._cancelAutoDetect();
    if (samples.length < CALIBRATE_MIN_SAMPLES) {
      this._setAutoStatus("Didn't hear enough singing — try again.", "warn");
      return;
    }
    samples.sort((a, b) => a - b);
    const medianTrueMidi = samples[(samples.length - 1) >> 1];
    // Octaves needed to bring the sung octave onto the reference's octave.
    const oct = Math.round((REFERENCE.midi - medianTrueMidi) / 12);
    this._setOffset(oct);
    this._setAutoStatus("Matched: " + offsetLabel(getVoiceOctaveOffset()) + ".", "good");
  }

  _cancelAutoDetect() {
    if (this._calibTimer) { clearTimeout(this._calibTimer); this._calibTimer = null; }
    this._calibrating = false;
    this._calibSamples = null;
    if (this.els.autoDetect) this.els.autoDetect.disabled = false;
  }

  _setAutoStatus(text, kind) {
    if (!this.els.autoStatus) return;
    this.els.autoStatus.textContent = text;
    this.els.autoStatus.className = "sc-autodetect-status" + (kind ? " " + kind : "");
  }

  _onPitch(info) {
    // Auto-detect sampling uses the *true* measured frequency (offset-free) so
    // the calibration itself is unaffected by whatever offset is set.
    if (this._calibrating && info.freq != null) {
      this._calibSamples.push(hzToMidi(info.freq));
    }
    if (info.freq == null) {
      this.silenceFrames += 1;
      if (this.silenceFrames >= SILENCE_FRAMES) {
        this.els.note.textContent = "–";
        this.els.hz.textContent = "– Hz";
        this.els.cents.textContent = "no signal — try singing louder";
        this.els.cents.className = "sc-cents muted";
        this.els.needle.style.left = "50%";
        this.els.needle.className = "sc-meter-needle";
      }
      return;
    }
    this.silenceFrames = 0;
    const cls = centsClass(info.cents);
    this.els.note.textContent = midiToName(info.midiRound);
    this.els.hz.textContent = info.freq.toFixed(1) + " Hz";
    this.els.cents.textContent = (info.cents > 0 ? "+" : "") + info.cents + " cents";
    this.els.cents.className = "sc-cents " + cls;
    const pct = 50 + Math.max(-50, Math.min(50, info.cents));
    this.els.needle.style.left = pct + "%";
    this.els.needle.className = "sc-meter-needle " + cls;
    this.renderer.showSungNote(0, info.midi, REFERENCE.midi);
  }
}
