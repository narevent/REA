/**
 * soundcheckView.js
 *
 * A standalone calibration screen: is the microphone picking up the user
 * clearly, and does REA's pitch tracker report back what the user actually
 * sang?  Unlike the practice chapters, this isn't scored and isn't tied to
 * a lesson - it directly drives PitchDetector + NotationRenderer (bypassing
 * PracticeController, which is chapter/scoring-oriented).
 *
 * Two calibrations live here, and both write app-wide settings the practice
 * chapters then use:
 *
 *   Input level  - a fixed input gain plus a room-derived noise gate.  See
 *                  `computeInputCalibration` for the reasoning; the short
 *                  version is that a *static* trim is what stable pitch
 *                  tracking wants, and the gate is what stops room noise from
 *                  being scored as singing.
 *   Voice profile - the octave offset, for singers whose comfortable octave
 *                  isn't the written one.
 *
 * Usage: `const sc = new SoundcheckView(container, { player });`
 *   sc.enter()  - build the DOM (once) and show it.
 *   sc.leave()  - release the microphone when navigating away.
 */

import { NotationRenderer } from "../components/notationRenderer.js?v=83";
import {
  PitchDetector, midiToName, hzToMidi, rmsToDb,
  getVoiceOctaveOffset, setVoiceOctaveOffset,
  getInputGain, setInputGain, setNoiseGate, getNoiseGate, hasCalibratedInput,
  setVoiceVibratoCents, setVoiceOnsetFloor,
  INPUT_GAIN_MIN, INPUT_GAIN_MAX,
} from "../pitchDetector.js?v=83";
import {
  SOUND_PRESETS, getCurrentSoundPreset, setSoundPresetById, soundPresetGroups,
} from "../soundPresets.js?v=83";

// ---------------------------------------------------------------------------
// The soundcheck run
// ---------------------------------------------------------------------------
//
// One button, one pass.  Both calibrations need the same thing — the user
// singing a known note — so asking for that twice (once for level, once for
// octave) was busywork.  The run enables the mic, measures the room, plays the
// reference, then listens once and derives *both* results from that single
// sung note: RMS gives the input level, pitch gives the octave.
//
// It ends as soon as the sung note is steady enough to be trusted, rather than
// running a fixed timer out — and if only one of the two could be determined,
// it still finishes and says which.
const SC_ROOM_MS = 900;        // "stay quiet" — measuring the noise floor
const SC_REF_MS = 1600;        // reference note plays (1400 ms) + a beat
const SC_SING_MAX_MS = 6000;   // give up listening after this
const SC_STEADY_MS = 1200;     // voiced time needed before a note counts as steady
const SC_STEADY_WINDOW = 24;   // recent pitch samples examined for steadiness
const SC_STEADY_SPREAD = 1.0;  // semitones; how tightly those must cluster
const CALIBRATE_MIN_SAMPLES = 12;

// ---------------------------------------------------------------------------
// Input-level calibration
// ---------------------------------------------------------------------------
//
// Target: where a comfortably-sung note should sit, as post-gain RMS.
// 0.08 is ≈ −22 dBFS RMS.  Voice has a crest factor around 12 dB, so peaks
// land near −10 dBFS — a healthy signal with real headroom, nowhere near
// clipping.  Aiming hotter buys nothing (the tracker is scale-invariant) and
// risks clipping, which *does* wreck pitch detection.
const TARGET_RMS = 0.08;
// Gate placement: this far above the room's own noise floor, so ordinary room
// tone stays shut out...
const GATE_MARGIN = 3.5;              // ≈ +11 dB over the measured noise floor
// ...but never so high that it swallows quiet singing.  A gate above this
// fraction of the target would start clipping the ends of real notes.
const GATE_MAX_FRACTION = 0.22;       // ≈ −13 dB relative to a comfortable note
const GATE_MIN = 0.002;
// Below this signal-to-noise ratio the room, not the gain, is the problem:
// no trim can separate voice from noise that is nearly as loud.
const MIN_USEFUL_SNR_DB = 12;

// Live meter range and the band we consider healthy.
const METER_MIN_DB = -60;
const METER_MAX_DB = 0;
const GOOD_MIN_DB = -32;
const GOOD_MAX_DB = -14;

// Auto-gain capture phases.
const GAIN_QUIET_MS = 1000;
const GAIN_SING_MS = 2800;
const GAIN_MIN_SAMPLES = 20;

/**
 * Work out the input gain and noise gate from two measurements taken at unity
 * gain: the room's noise floor, and the user's comfortable singing level.
 *
 * Kept pure (no DOM, no detector) so the decision can be reasoned about and
 * tested directly.
 *
 * @param {{noiseRms:number, voiceRms:number}} m  measured at gain = 1
 * @returns {{gain, gate, snrDb, targetDb, verdict, title, detail}}
 *   `verdict` is one of "ok" | "quiet" | "hot" | "noisy".
 */
export function computeInputCalibration({ noiseRms, voiceRms }) {
  const noise = Math.max(noiseRms || 0, 1e-6);
  const voice = Math.max(voiceRms || 0, 1e-6);
  const snrDb = rmsToDb(voice) - rmsToDb(noise);

  const wanted = TARGET_RMS / voice;
  const gain = Math.max(INPUT_GAIN_MIN, Math.min(INPUT_GAIN_MAX, wanted));

  // What the singing will actually land on once the (possibly clamped) gain is
  // applied — this is what decides whether the result is usable, and what the
  // gate has to stay clear of.
  const resultRms = voice * gain;
  const resultDb = rmsToDb(resultRms);

  // The gate lives in post-gain terms, because that is what the detector sees.
  // Its ceiling is a fraction of the level the voice *actually* reaches, not of
  // the target: when the gain hits its ceiling and the voice lands short, a cap
  // based on the target would sit only a few dB under the singing and start
  // clipping the ends of real notes.
  const postNoise = noise * gain;
  const gate = Math.max(GATE_MIN, Math.min(postNoise * GATE_MARGIN, resultRms * GATE_MAX_FRACTION));
  const gainDb = 20 * Math.log10(gain);
  const gainTxt = (gainDb >= 0 ? "+" : "") + gainDb.toFixed(1) + " dB";

  let verdict = "ok";
  let title = "Input level set";
  let detail = "Your voice now sits at " + resultDb.toFixed(0) + " dBFS with " +
    gainTxt + " of input gain — a strong, clean signal with headroom to spare.";

  // A signal that never gets loud enough is the more fundamental complaint, so
  // it is reported ahead of a poor signal-to-noise ratio (which a too-quiet
  // signal will usually also have).
  if (resultDb < GOOD_MIN_DB) {
    // Gain hit its ceiling and the signal is still weak.
    verdict = "quiet";
    title = "Input level set — signal is still quiet";
    detail = "Even at " + gainTxt + " your voice only reaches " + resultDb.toFixed(0) + " dBFS. " +
      "Move closer to the mic, or raise the input level in your system sound settings, then run this again.";
  } else if (snrDb < MIN_USEFUL_SNR_DB) {
    verdict = "noisy";
    title = "Input level set — but the room is noisy";
    detail = "Your voice is only " + snrDb.toFixed(0) + " dB above the background noise. " +
      "Gain is set to " + gainTxt + ", but moving closer to the mic (or quietening the room) " +
      "will make tracking noticeably steadier.";
  } else if (resultDb > GOOD_MAX_DB) {
    verdict = "hot";
    title = "Input level set — signal is hot";
    detail = "Your voice reaches " + resultDb.toFixed(0) + " dBFS even at " + gainTxt + ". " +
      "Turn the input level down in your system sound settings to leave more headroom, then run this again.";
  }

  return { gain, gate, snrDb, targetDb: resultDb, verdict, title, detail };
}

/** Human label for an octave offset value. */
// How much of the sung note to skip before measuring the *sustain*: the attack,
// the scoop into the note, and the moment or two it takes to settle.
const PROFILE_SETTLE_MS = 350;
const PROFILE_MIN_SAMPLES = 12;

/**
 * Measure this singer's vibrato width and their articulation floor from the
 * note the soundcheck already asks them to hold.
 *
 * Deliberately taken from that same note rather than from a step of its own:
 * the soundcheck is one button on purpose, and everything needed is already in
 * the recording.  Both measurements come from the sustain only — the attack is
 * skipped, since the question in each case is what the voice does once it has
 * arrived, not how it gets there.
 *
 * Exported for testing.
 */
export function measureVoiceProfile(run) {
  const from = (run.singStartT || 0) + PROFILE_SETTLE_MS;
  const held = (run.pitchSeries || []).filter((x) => x.t >= from);
  const quiet = (run.strengths || []).filter((x) => x.t >= from);

  let vibratoCents = 0, vibratoOk = false;
  if (held.length >= PROFILE_MIN_SAMPLES) {
    const midis = held.map((x) => x.midi).sort((a, b) => a - b);
    const med = midis[(midis.length - 1) >> 1];
    const devs = held.map((x) => (x.midi - med) * 100).sort((a, b) => a - b);
    const at = (q) => devs[Math.min(devs.length - 1, Math.max(0, Math.round(q * (devs.length - 1))))];
    // The 10th-to-90th spread, halved: robust to a single stray frame in a way
    // the full range is not, and it is a half-width the segmenter can use as a
    // tolerance directly.
    vibratoCents = Math.max(0, (at(0.9) - at(0.1)) / 2);
    vibratoOk = true;
  }

  let onsetFloor = 0, floorOk = false;
  if (quiet.length >= PROFILE_MIN_SAMPLES) {
    const vals = quiet.map((x) => x.v).sort((a, b) => a - b);
    // The 90th percentile, not the maximum: one throat-clear should not define
    // this voice's floor for good.
    onsetFloor = vals[Math.min(vals.length - 1, Math.round(0.9 * (vals.length - 1)))];
    floorOk = true;
  }
  return { vibratoCents, vibratoOk, onsetFloor, floorOk };
}

function offsetLabel(oct) {
  if (oct === 0) return "In pitch";
  return (oct > 0 ? "+" : "−") + Math.abs(oct) + " octave" + (Math.abs(oct) === 1 ? "" : "s");
}

/** Inline glyphs for the result cards (no emoji, matching the rest of the app). */
function resultGlyph(kind) {
  const common = 'width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';
  if (kind === "good") return "<svg " + common + '><path d="M5 12l5 5L20 7"/></svg>';
  if (kind === "warn") return "<svg " + common + '><path d="M12 8v5M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>';
  return "<svg " + common + '><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
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

/** Map a dBFS value onto the live meter's 0-100% width. */
function dbToPct(db) {
  const clamped = Math.max(METER_MIN_DB, Math.min(METER_MAX_DB, db));
  return ((clamped - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)) * 100;
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
    this._run = null;               // in-flight soundcheck capture
    this._runTimers = [];
    this._meterDb = METER_MIN_DB;   // smoothed level for the meter
  }

  /** Show the view: build the DOM on first entry, re-draw the reference
   *  staff (cheap) every time in case the container was resized while
   *  hidden (VexFlow measures `clientWidth`, which is 0 while `hidden`). */
  enter() {
    if (!this.built) this._build();
    this._renderReferenceStaff();
    this._renderGain();
  }

  /** Release the microphone when navigating away from Soundcheck. */
  leave() {
    this._cancelRun();
    this.stopMic();
  }

  _build() {
    this.built = true;
    this.container.innerHTML =
      '<div class="sc-wrap">' +
        '<div class="sc-hero sc-hero-compact">' +
          "<h2>Soundcheck</h2>" +
          "<p>Set your input level, match your voice profile, then sing the reference tone " +
          "and watch the note track live on the staff below.</p>" +
        "</div>" +
        // ---- Live reading (the point of this view) — prominent, first ----
        '<div class="sc-panel sc-live">' +
          '<div class="sc-panel-head">' +
            '<span class="sc-panel-lbl">Live reading</span>' +
            '<span class="sc-mic-status" id="sc-mic-status"><span class="sc-dot"></span><span>Not started</span></span>' +
          "</div>" +
          '<div class="sc-readout">' +
            '<div class="sc-note" id="sc-note">–</div>' +
            '<div class="sc-hz" id="sc-hz">– Hz</div>' +
            '<div class="sc-cents muted" id="sc-cents">enable the microphone and sing</div>' +
          "</div>" +
          // Input level meter: the post-gain signal, the healthy band, and
          // where the noise gate sits — so "is my mic set up right?" is a
          // glance rather than a guess.
          '<div class="sc-input">' +
            '<div class="sc-input-head">' +
              "<span>Input level</span>" +
              '<span class="sc-input-val" id="sc-input-val">–</span>' +
            "</div>" +
            '<div class="sc-input-track">' +
              '<div class="sc-input-good" id="sc-input-good"></div>' +
              '<div class="sc-input-gate" id="sc-input-gate"></div>' +
              '<div class="sc-input-fill" id="sc-input-fill"></div>' +
            "</div>" +
            '<div class="sc-input-scale"><span>quiet</span><span>good</span><span>loud</span></div>' +
          "</div>" +
          '<div class="sc-meter">' +
            '<div class="sc-meter-track">' +
              '<div class="sc-meter-zero"></div>' +
              '<div class="sc-meter-needle" id="sc-meter-needle"></div>' +
            "</div>" +
            '<div class="sc-meter-scale"><span>-50¢</span><span>in tune</span><span>+50¢</span></div>' +
          "</div>" +
          '<div id="soundcheck-notation" class="notation sc-notation"></div>' +
          '<div class="sc-live-actions">' +
            '<button type="button" id="sc-run" class="sc-btn primary">Start soundcheck</button>' +
            '<button type="button" id="sc-ref-play" class="sc-btn">Play ' + REFERENCE.label + "</button>" +
            '<button type="button" id="sc-mic-toggle" class="sc-btn">Enable microphone</button>' +
          "</div>" +
          '<div class="sc-result-slot" id="sc-run-result"></div>' +
        "</div>" +
        // ---- Compact setup card: input level + voice profile + playback sound ----
        '<div class="sc-panel sc-setup">' +
          // Input level row
          '<div class="sc-setup-row sc-setup-gain">' +
            '<div class="sc-setup-lbl">Input level' +
              '<span class="sc-setup-sub" id="sc-gain-cur">0.0 dB</span>' +
            "</div>" +
            '<div class="sc-setup-field">' +
              '<div class="sc-stepper" title="Input gain — sing a comfortable note and aim for the green band">' +
                '<button type="button" id="sc-gain-down" class="sc-step-btn" aria-label="Lower input gain">−</button>' +
                '<span class="sc-oct-val" id="sc-gain-val">0.0</span>' +
                '<button type="button" id="sc-gain-up" class="sc-step-btn" aria-label="Raise input gain">+</button>' +
              "</div>" +
              '<span class="sc-setup-hint">set by the soundcheck — nudge if you want</span>' +
            "</div>" +
          "</div>" +
          // Voice profile row
          '<div class="sc-setup-row sc-setup-voice">' +
            '<div class="sc-setup-lbl">Voice profile' +
              '<span class="sc-setup-sub" id="sc-profile-cur" title="Octave shift applied to the tracked pitch">In pitch</span>' +
            "</div>" +
            '<div class="sc-setup-field">' +
              '<div class="sc-stepper" title="Octave shift — nudge if your voice tracks an octave off (common for male voices)">' +
                '<button type="button" id="sc-oct-down" class="sc-step-btn" aria-label="Shift down an octave">−</button>' +
                '<span class="sc-oct-val" id="sc-oct-val">0</span>' +
                '<button type="button" id="sc-oct-up" class="sc-step-btn" aria-label="Shift up an octave">+</button>' +
              "</div>" +
              '<span class="sc-setup-hint">set by the soundcheck — nudge if you want</span>' +
            "</div>" +
          "</div>" +
          // Playback sound row — compact grouped <select> (22 presets would
          // otherwise take the whole screen as a pill grid).
          '<div class="sc-setup-row sc-setup-sound">' +
            '<div class="sc-setup-lbl">Playback sound' +
              '<span class="sc-setup-sub" id="sc-sound-cur">Soft Triangle</span>' +
            "</div>" +
            '<div class="sc-setup-field">' +
              '<select id="sc-sound-select" class="sc-sound-select" aria-label="Playback sound"></select>' +
              '<button type="button" id="sc-sound-preview" class="sc-btn">Preview</button>' +
            "</div>" +
          "</div>" +
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
      inputVal: this.container.querySelector("#sc-input-val"),
      inputFill: this.container.querySelector("#sc-input-fill"),
      inputGood: this.container.querySelector("#sc-input-good"),
      inputGate: this.container.querySelector("#sc-input-gate"),
      gainCur: this.container.querySelector("#sc-gain-cur"),
      gainVal: this.container.querySelector("#sc-gain-val"),
      gainDown: this.container.querySelector("#sc-gain-down"),
      gainUp: this.container.querySelector("#sc-gain-up"),
      runBtn: this.container.querySelector("#sc-run"),
      runResult: this.container.querySelector("#sc-run-result"),
      profileCur: this.container.querySelector("#sc-profile-cur"),
      octVal: this.container.querySelector("#sc-oct-val"),
      octDown: this.container.querySelector("#sc-oct-down"),
      octUp: this.container.querySelector("#sc-oct-up"),
      soundSelect: this.container.querySelector("#sc-sound-select"),
      soundCur: this.container.querySelector("#sc-sound-cur"),
      soundPreview: this.container.querySelector("#sc-sound-preview"),
    };
    this.renderer = new NotationRenderer(this.container.querySelector("#soundcheck-notation"));

    this.els.micToggle.addEventListener("click", () => this._toggleMic());
    this.els.refPlay.addEventListener("click", () => this._playReference());
    this.els.octDown.addEventListener("click", () => this._setOffset(getVoiceOctaveOffset() - 1));
    this.els.octUp.addEventListener("click", () => this._setOffset(getVoiceOctaveOffset() + 1));
    this.els.gainDown.addEventListener("click", () => this._nudgeGain(-1.5));
    this.els.gainUp.addEventListener("click", () => this._nudgeGain(1.5));
    this.els.runBtn.addEventListener("click", () => this._startSoundcheck());
    this.els.soundSelect.addEventListener("change", () => {
      setSoundPresetById(this.els.soundSelect.value);
      this._renderSoundPresets();
      this._playReference();
    });
    this.els.soundPreview.addEventListener("click", () => this._playReference());
    this._renderProfile();
    this._renderGain();
    this._renderSoundPresets();
    this._paintMeterZones();
  }

  // ---- voice profile -------------------------------------------------------

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

  // ---- input level ---------------------------------------------------------

  /** Reflect the current input gain across its controls. */
  _renderGain() {
    if (!this.els.gainCur) return;
    const db = 20 * Math.log10(getInputGain());
    const txt = (db >= 0 ? "+" : "") + db.toFixed(1) + " dB";
    this.els.gainCur.textContent = txt;
    this.els.gainVal.textContent = db.toFixed(1);
    if (!hasCalibratedInput() && !this._run) {
      this._setResult(this.els.runResult, "idle", "Not set up yet",
        "Press <b>Start soundcheck</b>. It enables the mic, plays a reference note, and sets " +
        "both your input level and your voice profile from one sung note.");
    }
    this._paintMeterZones();
  }

  /** Manual trim, in dB steps around the current gain. */
  _nudgeGain(deltaDb) {
    const db = 20 * Math.log10(getInputGain()) + deltaDb;
    const g = Math.pow(10, db / 20);
    setInputGain(Math.max(INPUT_GAIN_MIN, Math.min(INPUT_GAIN_MAX, g)));
    this._renderGain();
  }

  /** Draw the healthy band and the gate marker onto the input meter. */
  _paintMeterZones() {
    if (!this.els.inputGood) return;
    const lo = dbToPct(GOOD_MIN_DB);
    const hi = dbToPct(GOOD_MAX_DB);
    this.els.inputGood.style.left = lo + "%";
    this.els.inputGood.style.width = (hi - lo) + "%";
    this.els.inputGate.style.left = dbToPct(rmsToDb(getNoiseGate())) + "%";
  }

  /**
   * Run the whole soundcheck: enable the mic, measure the room, play the
   * reference, then listen once and derive both the input level and the voice
   * profile from that single sung note.
   *
   * The level calibration is deliberately one-shot rather than a running AGC:
   * continuous gain-riding pumps, and pumping smears the very level cues the
   * tracker's voicing gate depends on.  That is also why the browser's own
   * autoGainControl is switched off in PitchDetector.
   *
   * Measurement runs at unity gain so the readings describe the microphone
   * itself, not whatever trim happened to be set beforehand.
   */
  async _startSoundcheck() {
    if (this._run) return;
    if (!this.detector.isRunning) {
      this._setResult(this.els.runResult, "busy", "Starting…", "Allow microphone access to begin.");
      try {
        await this.detector.start((info) => this._onPitch(info));
        this._setMicStatus("on", "Listening");
        this.els.micToggle.textContent = "Stop microphone";
      } catch (e) {
        this._setMicStatus("error", e.message || "Microphone unavailable");
        this._setResult(this.els.runResult, "warn", "Microphone unavailable",
          e.message || "REA needs microphone access to run the soundcheck.");
        return;
      }
    }
    const previousGain = getInputGain();
    this._run = {
      phase: "room", noise: [], voice: [], pitches: [],
      pitchSeries: [], strengths: [], singStartT: null,
      voicedMs: 0, lastT: null, previousGain,
    };
    this.els.runBtn.disabled = true;
    setInputGain(1);
    this._renderGain();

    this._setResult(this.els.runResult, "busy", "Listening to the room…",
      "Stay quiet for a moment while we measure your background noise.");
    this._runTimers.push(setTimeout(() => {
      if (!this._run) return;
      // Play the reference.  Nothing is sampled during this phase — on
      // speakers the mic would otherwise hear the tone and calibrate against
      // REA's own playback instead of the user's voice.
      this._run.phase = "listen";
      this._playReference();
      this._setResult(this.els.runResult, "busy", "Listen…",
        "That's " + REFERENCE.label + ". Get ready to sing it back.");
      this._runTimers.push(setTimeout(() => {
        if (!this._run) return;
        this._run.phase = "sing";
        this._run.singStartT = performance.now();
        this._setResult(this.els.runResult, "busy", "Now sing it back…",
          "Hold a steady note at the volume you'd actually practise at — whatever octave is comfortable.");
        this._runTimers.push(setTimeout(() => this._finishSoundcheck(), SC_SING_MAX_MS));
      }, SC_REF_MS));
    }, SC_ROOM_MS));
  }

  /** True once the sung note has been voiced long enough *and* held steadily
   *  enough to trust — this is what lets the run end early instead of making
   *  the user wait out a fixed timer. */
  _singingIsSteady() {
    const run = this._run;
    if (!run || run.voicedMs < SC_STEADY_MS) return false;
    const p = run.pitches;
    if (p.length < SC_STEADY_WINDOW) return false;
    const recent = p.slice(-SC_STEADY_WINDOW);
    const sorted = recent.slice().sort((a, b) => a - b);
    const med = sorted[(sorted.length - 1) >> 1];
    return recent.every((m) => Math.abs(m - med) <= SC_STEADY_SPREAD);
  }

  _finishSoundcheck() {
    const run = this._run;
    if (!run) return;
    this._clearRunTimers();
    this._run = null;
    if (this.els.runBtn) {
      this.els.runBtn.disabled = false;
      this.els.runBtn.textContent = "Redo soundcheck";
    }

    // --- input level ---
    const noise = run.noise.slice().sort((a, b) => a - b);
    const noiseRms = noise.length ? noise[(noise.length - 1) >> 1] : 0;
    // Only frames clearly above the noise floor count as singing, so breaths
    // and the gaps either side don't drag the measurement down.  The median of
    // those is the "comfortable" level, robust to attack and release.
    const sung = run.voice.filter((r) => r > Math.max(noiseRms * 2, 1e-5)).sort((a, b) => a - b);
    const gainOk = noise.length >= GAIN_MIN_SAMPLES && sung.length >= GAIN_MIN_SAMPLES;
    let cal = null;
    if (gainOk) {
      cal = computeInputCalibration({ noiseRms, voiceRms: sung[(sung.length - 1) >> 1] });
      setInputGain(cal.gain);
      setNoiseGate(cal.gate);
    } else {
      setInputGain(run.previousGain);      // nothing learned — put it back
    }
    this._renderGain();

    // --- voice profile ---
    const pitches = run.pitches.slice().sort((a, b) => a - b);
    const octaveOk = pitches.length >= CALIBRATE_MIN_SAMPLES;
    let sungName = null;
    if (octaveOk) {
      const medianTrueMidi = pitches[(pitches.length - 1) >> 1];
      sungName = midiToName(medianTrueMidi);
      this._setOffset(Math.round((REFERENCE.midi - medianTrueMidi) / 12));
    }

    // --- vibrato width and articulation floor ---
    const profile = measureVoiceProfile(run);
    if (profile.vibratoOk) setVoiceVibratoCents(profile.vibratoCents);
    if (profile.floorOk) setVoiceOnsetFloor(profile.onsetFloor);

    this._reportSoundcheck({ gainOk, octaveOk, cal, sungName, profile });
  }

  /** Turn the run's outcome into one combined result card. */
  _reportSoundcheck({ gainOk, octaveOk, cal, sungName, profile }) {
    if (!gainOk && !octaveOk) {
      this._setResult(this.els.runResult, "warn", "Didn't hear enough singing",
        "Run the soundcheck again, and sing a steady note right through the " +
        "“Now sing it back” step.");
      return;
    }

    const applied = getVoiceOctaveOffset();
    const voiceLine = !octaveOk ? null
      : applied === 0
        ? "You sang around <b class=\"sc-note-name\">" + sungName + "</b> — the same octave as the reference, so no shift is needed."
        : "You sang around <b class=\"sc-note-name\">" + sungName + "</b>, " + Math.abs(applied) + " octave" +
          (Math.abs(applied) === 1 ? "" : "s") + (applied > 0 ? " below" : " above") +
          " the reference, so tracking is shifted " + offsetLabel(applied).toLowerCase() + ".";
    const levelLine = !gainOk ? null
      : "Input level set to " + ((20 * Math.log10(cal.gain) >= 0 ? "+" : "") +
        (20 * Math.log10(cal.gain)).toFixed(1)) + " dB, putting your voice at " +
        cal.targetDb.toFixed(0) + " dBFS.";

    // What was learned about the voice itself, said in terms of what it does
    // for the singer rather than in cents of vibrato.
    const vibLine = !(profile && profile.vibratoOk) ? null
      : profile.vibratoCents >= 20
        ? "Your voice moves about <b>" + Math.round(profile.vibratoCents) +
          " cents</b> on a held note, so the exercises will take that as one steady note rather than several."
        : "Your held notes are very steady, so the exercises can follow them closely.";

    // Everything found and nothing to warn about: the plain success case.
    if (gainOk && octaveOk && cal.verdict === "ok") {
      this._setResult(this.els.runResult, "good", "Soundcheck complete — you're set",
        [levelLine, voiceLine, vibLine].filter(Boolean).join(" "));
      return;
    }
    // Otherwise say exactly which half landed and what still needs attention.
    if (gainOk && octaveOk) {
      this._setResult(this.els.runResult, "warn", cal.title, cal.detail + " " + voiceLine);
      return;
    }
    if (gainOk) {
      this._setResult(this.els.runResult, "warn", "Input level set — octave not determined",
        levelLine + " We couldn't hear a steady enough pitch to match your octave — " +
        "run it again and hold one note while it listens.");
      return;
    }
    this._setResult(this.els.runResult, "warn", "Voice profile set — input level not measured",
      voiceLine + " We couldn't get a clean level reading — run it again, staying quiet " +
      "for the first step and then singing steadily.");
  }

  _cancelRun() {
    if (this._run) {
      // Interrupted mid-measurement: restore the trim we were asked to replace.
      setInputGain(this._run.previousGain);
      this._run = null;
      this._renderGain();
    }
    this._clearRunTimers();
    if (this.els.runBtn) this.els.runBtn.disabled = false;
  }

  _clearRunTimers() {
    this._runTimers.forEach((t) => clearTimeout(t));
    this._runTimers = [];
  }

  // ---- shared result card --------------------------------------------------

  /** Render a calibration outcome into one of the setup rows.  This is the
   *  "it matched, and you're done" signal — a headline plus what was actually
   *  measured, rather than a word of status text that is easy to miss. */
  _setResult(slot, kind, title, detail) {
    if (!slot) return;
    if (!kind) { slot.innerHTML = ""; return; }
    const ico = kind === "good" ? resultGlyph("good")
              : kind === "warn" ? resultGlyph("warn")
              : resultGlyph("busy");
    slot.innerHTML =
      '<div class="sc-result ' + kind + '">' +
        '<span class="sc-result-ico">' + ico + "</span>" +
        '<div class="sc-result-body">' +
          '<div class="sc-result-title">' + title + "</div>" +
          '<div class="sc-result-detail">' + detail + "</div>" +
        "</div>" +
      "</div>";
  }

  // ---- playback sound ------------------------------------------------------

  /** Build the playback-sound picker as a grouped <select> (optgroups by
   *  timbre family).  Selecting a preset persists it, applies it to all
   *  playback, and plays a preview.  The current label is shown beside the
   *  row label.  Uses a <select> rather than a pill grid because 22 presets
   *  would otherwise consume the whole screen and bury the staff. */
  _renderSoundPresets() {
    if (!this.els.soundSelect) return;
    const current = getCurrentSoundPreset();
    this.els.soundCur.textContent = current.label;
    const groups = soundPresetGroups();
    const html = groups.map((g) => {
      const opts = SOUND_PRESETS.filter((p) => p.group === g).map((p) => {
        const sel = p.id === current.id ? " selected" : "";
        return '<option value="' + p.id + '"' + sel + ">" + p.label + "</option>";
      }).join("");
      return '<optgroup label="' + g + '">' + opts + "</optgroup>";
    }).join("");
    this.els.soundSelect.innerHTML = html;
    this.els.soundSelect.value = current.id;
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

  // ---- mic -----------------------------------------------------------------

  async _toggleMic() {
    if (this.detector.isRunning) { this.stopMic(); return; }
    this._setMicStatus("connecting", "Requesting access…");
    try {
      await this.detector.start((info) => this._onPitch(info));
      this._setMicStatus("on", "Listening");
      this.els.micToggle.textContent = "Stop microphone";
      this._renderGain();
    } catch (e) {
      this._setMicStatus("error", e.message || "Microphone unavailable");
    }
  }

  stopMic() {
    this._cancelRun();
    this.detector.stop();
    this._setMicStatus("off", "Not started");
    if (this.els.micToggle) this.els.micToggle.textContent = "Enable microphone";
    this._meterDb = METER_MIN_DB;
    this._renderInputLevel(METER_MIN_DB, true);
  }

  _setMicStatus(kind, text) {
    if (!this.els.micStatus) return;
    this.els.micStatus.innerHTML = '<span class="sc-dot ' + kind + '"></span><span>' + text + "</span>";
  }

  // ---- live frame ----------------------------------------------------------

  /** Feed one frame into an in-flight soundcheck run.
   *
   * Level is sampled on every frame (voiced or not — silence is exactly what
   * the room phase is measuring), while pitch is sampled only when the tracker
   * reports one.  Pitch uses the *true* measured frequency rather than the
   * octave-compensated note, so the calibration can't be skewed by whatever
   * offset happens to be set going in. */
  _sampleRun(info) {
    const run = this._run;
    if (!run) return;
    const now = info.t != null ? info.t : performance.now();
    const dt = run.lastT == null ? 0 : now - run.lastT;
    run.lastT = now;

    if (run.phase === "room") { run.noise.push(info.rms || 0); return; }
    if (run.phase !== "sing") return;    // "listen": REA's own tone is playing

    run.voice.push(info.rms || 0);
    // Articulation-like activity while a note is merely being held.  Sampled
    // from the sustain only (the note's own attack is skipped below), because
    // the question is what this voice and room throw off when nothing is
    // happening.
    run.strengths.push({ t: now, v: info.onsetStrength || 0 });
    if (info.freq != null) {
      run.pitchSeries.push({ t: now, midi: hzToMidi(info.freq) });
      run.pitches.push(hzToMidi(info.freq));
      if (dt > 0 && dt < 500) run.voicedMs += dt;
      // Steady enough to trust — finish now rather than running the clock out.
      if (this._singingIsSteady()) this._finishSoundcheck();
    }
  }

  /** Update the input-level meter.  Fast attack / slow release so the bar
   *  tracks the voice without flickering on every frame. */
  _renderInputLevel(db, immediate) {
    if (!this.els.inputFill) return;
    if (immediate) this._meterDb = db;
    else this._meterDb = db > this._meterDb
      ? this._meterDb + (db - this._meterDb) * 0.5      // attack
      : this._meterDb + (db - this._meterDb) * 0.08;    // release
    const shown = this._meterDb;
    this.els.inputFill.style.width = dbToPct(shown) + "%";
    const cls = shown < GOOD_MIN_DB ? "low" : shown > GOOD_MAX_DB ? "hot" : "good";
    this.els.inputFill.className = "sc-input-fill " + cls;
    this.els.inputVal.textContent = shown <= METER_MIN_DB ? "–" : shown.toFixed(0) + " dBFS";
    this.els.inputVal.className = "sc-input-val " + cls;
  }

  _onPitch(info) {
    this._renderInputLevel(info.db != null ? info.db : METER_MIN_DB);
    this._sampleRun(info);
    if (info.freq == null) {
      this.silenceFrames += 1;
      if (this.silenceFrames >= SILENCE_FRAMES) {
        this.els.note.textContent = "–";
        this.els.hz.textContent = "– Hz";
        this.els.cents.textContent = info.gated
          ? "below the noise gate — sing a little louder"
          : "no signal — try singing louder";
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
