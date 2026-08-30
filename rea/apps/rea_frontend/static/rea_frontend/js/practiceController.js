/**
 * practiceController.js
 *
 * The interactive session engine behind each of the 10 practice chapters.
 *
 * The controller owns:
 *   - the round loop (one round per bar/question, depending on the mode),
 *   - the mic capture (singing modes),
 *   - the countdown timers (timed modes),
 *   - the live session deck UI (round progress, score ring, animated
 *     per-round feedback, and a celebration summary),
 *
 * It reuses the existing AudioPlayer + NotationRenderer so playback and
 * highlighting are identical to the lesson view.
 *
 * Each chapter maps to one of these modes:
 *   1  listen            loop playback of the bars (no input)
 *   2  sing_repeat        play bar -> sing -> note report + score
 *   3  guess              play bar (hidden) -> click bar -> score
 *   4  guess_timed        as 3, with a per-bar countdown
 *   5  sing_proposed      highlight random bar -> sing -> score
 *   6  guess_notes        play a note (hidden) -> pick the bar/degree
 *   7  guess_notes_t      as 6, with a per-bar countdown
 *   8  sing_notes         highlight a single note -> sing -> score
 *   9  sing_notes_t       as 8, with a per-bar countdown
 *  10  guess_multi        as 6 but multiple notes with generation options
 */

import { AudioPlayer } from "./audioPlayer.js?v=114";
import {
  PitchDetector, midiToName, getVoiceVibratoCents, getVoiceOnsetFloor,
} from "./pitchDetector.js?v=114";
import { API } from "./api.js?v=114";
import {
  buildBarSteps, barsToFlat, barPitches, barDegrees, barDurationMs,
  vexKeyOf, shuffle, randInt,
} from "./practiceData.js?v=114";
import {
  centsToScore, scoreGuessBar, scoreLabel,
} from "./practiceScore.js?v=114";
import { tuning } from "./difficulty.js?v=114";

const TIMED_DEFAULT = 8;   // per-bar countdown (seconds)
// Above this many rounds the per-round pips stop being readable (a 39-bar
// combination wrapped to three rows of dots) — the bar and the counter carry
// progress on their own from there.
const PIP_LIMIT = 20;
const SING_TAIL_MS = 600;  // extra recording tail so the user can finish
// How long one reference note may hold the marker.
//
// PATIENCE is the promise that the exercise waits while the singer looks for
// the note.  It has to end somewhere — a voice that never settles would
// otherwise park the bar on its first reference forever — but it is measured
// in the singer's own note-lengths, so it is generous at any tempo, and in
// how many of them by the student's difficulty setting (`difficulty.js`):
// a beginner gets longer to find the note than someone who has chosen not to
// need it.
// Overhold is not a lead.  It exists for one case — a singer who has stopped
// doing the exercise and is sitting on a note — and for nothing else, because
// the marker moving off a note somebody is still singing is the whole
// complaint this work answers.  There is no longer any need for it to come
// early: the reading now appears on the note being sung and keeps refining
// while it is held, so a marker that stays put reads as "still listening"
// rather than as "stuck".  Generously long, with an absolute floor as well so
// a wound-down pace estimate cannot bring it into range.
const SLOT_OVERHOLD_PACES = 5;
const SLOT_OVERHOLD_MIN_MS = 3000;
// Silence ends the argument.  A short note is only a search if the singer went
// on to sing something better; if they stopped instead, it is what they sang
// and it answers its reference.
const SLOT_SILENCE_FLUSH_MS = 300;
// How much longer a real note is than a pause on the way to one.  A singer
// taking the phrase quickly sings notes of roughly equal length, so anything
// within this factor of the note that resolved it is a note in its own right;
// a plateau a fraction as long was the voice passing through.
const SLOT_SEARCH_RATIO = 2.2;
// Two readings this close together are the same note as far as any of this is
// concerned: a singer sagging off a note and coming back, or wavering inside
// one, moves further than a tuner would like and nowhere near a neighbouring
// degree.  Comfortably under a semitone, so two adjacent scale degrees are
// never confused for one.
const SLOT_SAME_NOTE_CENTS = 80;

// ---------------------------------------------------------------------------
// Live note capture (singing modes 2, 5, 8, 9)
// ---------------------------------------------------------------------------
//
// The exercise does NOT wait for the *correct* note.  As soon as the singer
// settles on **any** pitch, that pitch is committed as the attempt for the
// current reference note, scored against it, and the marker moves on.  Singing
// a wrong note therefore costs points but never stalls the exercise — which is
// the whole point of a sight-singing drill: you keep going.
//
// Where a note begins and ends is decided by `makeNoteSegmenter` below, from
// three cues — an articulation (an onset from the detector), a confirmed change
// of pitch, and a gap.  The constants live with it.
//
// There is deliberately no *level* requirement for scoring a note.  One was
// tried (a note had to sit some margin above the calibrated gate) and it can
// only ever cause the exercise to stall: soft singing that the detector tracks
// perfectly well would fail it, the note would never score, and the marker
// would sit there.  Level belongs in one place — the calibrated noise gate in
// pitchDetector, which decides what counts as sound at all.

// Pitch-lock constants.  These now serve one caller only —
// `_captureFirstStablePitch`, which the soundcheck uses to read a single sung
// note for calibration.  The exercise's own note capture does not use the lock;
// it segments notes with `makeNoteSegmenter` (below), which knows about
// articulation onsets and so can tell two notes at the same pitch apart.
// What one note is worth in the single-note chapters (8, 9).  There is no
// phrase to take a tempo from, so the segmenter is given a plain note-length
// and left to it; every threshold it uses scales from this.
const SINGLE_NOTE_PACE_MS = 600;

// The 10 modes, keyed by chapter key.  Each carries enough metadata to render
// the session deck.  The `key` must match the chapter keys in chapters.js.
// A small inline-SVG glyph helper (no emoji).  Keeps the deck UI visual.
function glyph(name, size) {
  const s = size || 18;
  const common = 'width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  switch (name) {
    // The chapter glyphs (shared with the map and the session topbar) — without
    // them a chapter's icon fell through to the default circle here, so the
    // same exercise wore two different marks on two screens.
    case "wave": return '<svg ' + common + '><path d="M4 12h2M8 7v10M12 4v16M16 7v10M20 12h-2"/></svg>';
    case "ear": return '<svg ' + common + '><path d="M6 10a6 6 0 0 1 12 0c0 3-2 4-3 6s-1 4-3 4-2-2-2-4"/><path d="M9 10a3 3 0 0 1 6 0"/></svg>';
    case "note": return '<svg ' + common + '><circle cx="7" cy="18" r="3"/><circle cx="17" cy="16" r="3"/><path d="M10 18V6l10-2v12"/></svg>';
    case "seq": return '<svg ' + common + '><circle cx="6" cy="18" r="2.2"/><circle cx="12" cy="16" r="2.2"/><circle cx="18" cy="14" r="2.2"/><path d="M8 18V8M14 16V6M20 14V4"/></svg>';
    case "mic": return '<svg ' + common + '><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/></svg>';
    case "clock": return '<svg ' + common + '><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>';
    case "info": return '<svg ' + common + '><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>';
    case "bars": return '<svg ' + common + '><path d="M4 12h2M8 7v10M12 4v16M16 7v10M20 12h-2"/></svg>';
    case "rounds": return '<svg ' + common + '><circle cx="6" cy="12" r="2.4"/><circle cx="12" cy="12" r="2.4"/><circle cx="18" cy="12" r="2.4"/></svg>';
    case "flame": return '<svg ' + common + '><path d="M12 3c4 4 5 7 3 11-1 2-3 3-3 3s-2-1-3-3c-2-4-1-7 3-11z"/><path d="M12 21c-3 0-5-2-5-5 0-1 1-2 2-2"/></svg>';
    case "play": return '<svg ' + common + ' fill="currentColor" stroke="none"><path d="M7 5l12 7-12 7z"/></svg>';
    case "stop": return '<svg ' + common + ' fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    case "replay": return '<svg ' + common + '><path d="M3 12a9 9 0 1 0 3-7M3 4v5h5"/></svg>';
    case "check": return '<svg ' + common + '><path d="M5 12l5 5L20 7"/></svg>';
    case "next": return '<svg ' + common + '><path d="M9 6l6 6-6 6"/></svg>';
    default: return '<svg ' + common + '><circle cx="12" cy="12" r="8"/></svg>';
  }
}

export const PRACTICE_MODES = {
  listen:        { id: 1,  key: "listen",        needsMic: false, timed: false },
  sing_repeat:   { id: 2,  key: "sing_repeat",   needsMic: true,  timed: false },
  guess:         { id: 3,  key: "guess",          needsMic: false, timed: false },
  guess_timed:   { id: 4,  key: "guess_timed",    needsMic: false, timed: true  },
  sing_proposed: { id: 5,  key: "sing_proposed", needsMic: true,  timed: false },
  guess_notes:   { id: 6,  key: "guess_notes",    needsMic: false, timed: false },
  guess_notes_t: { id: 7,  key: "guess_notes_t", needsMic: false, timed: true  },
  sing_notes:    { id: 8,  key: "sing_notes",     needsMic: true,  timed: false },
  sing_notes_t:  { id: 9,  key: "sing_notes_t",   needsMic: true,  timed: true  },
  guess_multi:   { id: 10, key: "guess_multi",    needsMic: false, timed: false },
};

export class PracticeController {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.stage   the #notation container
   * @param {HTMLElement} opts.legend
   * @param {HTMLElement} opts.info    session deck container
   * @param {AudioPlayer} opts.player
   * @param {function} opts.renderNotation  (lesson, onBarClick) => NotationRenderer
   * @param {function} opts.setStatus     (msg) => void
   * @param {function} [opts.onSessionComplete]  (chapter, avg) => void
   */
  constructor({ stage, legend, info, player, renderNotation, renderKeyModelNotation, getKeyModel, setStatus, onSessionComplete }) {
    this.stage = stage;
    this.legend = legend;
    this.info = info;
    this.player = player;
    this.renderNotation = renderNotation;
    this.renderKeyModelNotation = renderKeyModelNotation || renderNotation;
    this.getKeyModel = getKeyModel || (() => null);
    this.setStatus = setStatus || (() => {});
    this.onSessionComplete = onSessionComplete || (() => {});

    this.chapter = null;
    this.mode = null;
    this.lesson = null;
    this.keyModel = null;          // resolved key model for note-based modes
    this.barSteps = null;
    this.renderer = null;
    this.running = false;
    this.round = 0;
    this.order = [];
    this.scores = [];
    this.detector = null;

    this.multiOpts = {
      generation: "intervals", interval: "thirds",
      chord: "5/3", seventh: "7", noteCount: 3,
    };

    // Listening (chapter 1) playback options.
    this.listenOpts = { repeat: false, random: false };

    this._clickGuard = null;
    this._timer = null;
    this._loopTimer = null;
    this._roundToken = 0;
    this._countdownTimer = null;
  }

  // ---- lifecycle -----------------------------------------------------------

  /** Open a chapter against a lesson: render the deck + the score. */
  async openChapter(chapter, lesson) {
    this.stop();
    this.chapter = chapter;
    this.mode = PRACTICE_MODES[chapter.key] || null;
    this.lesson = lesson;
    this.keyModel = null;
    this.barSteps = null;
    this.round = 0;
    this.scores = [];
    this.order = [];
    this._playedBars = new Set();
    this.running = false;

    // Note-based chapters (6-10) practise the bare scale degrees of the key
    // model, not the formula lesson.  Resolve and use the key model for
    // those, so the stave shows the 7 scale degrees (one per bar) instead
    // of the multi-note lesson bars.
    if (this._usesKeyModel()) {
      this.keyModel = await this._resolveKeyModel(lesson);
    }
    this.barSteps = buildBarSteps(this._source());

    this._renderDeck();
    this._renderScoreVisual();
    this._showNotes();
    this._setLegend(this.chapter.instruct);
  }

  /** True when the chapter practises the key model's scale degrees. */
  _usesKeyModel() {
    const k = this.mode && this.mode.key;
    return k === "guess_notes" || k === "guess_notes_t" ||
           k === "sing_notes" || k === "sing_notes_t" ||
           k === "guess_multi";
  }

  /** The data source (key model for note modes, lesson otherwise). */
  _source() {
    return (this._usesKeyModel() && this.keyModel) ? this.keyModel : this.lesson;
  }

  async _resolveKeyModel(lesson) {
    if (!lesson || !lesson.key_model) return null;
    try {
      return await this.getKeyModel(lesson.key_model);
    } catch (e) {
      this.setStatus("Could not load key model: " + e.message);
      return null;
    }
  }

  stop() {
    this.running = false;
    this._singleRun = false;
    this._roundToken++;
    this.player.stop();
    this._clearTimers();
    this._stopMic();
    this._clickGuard = null;
    this._hideDoneButton();
    if (this.renderer && this.renderer.clearSungNote) this.renderer.clearSungNote();
    const bar = document.getElementById("countdown-bar");
    if (bar) bar.hidden = true;
  }

  _clearTimers() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._loopTimer) { clearTimeout(this._loopTimer); this._loopTimer = null; }
    if (this._countdownTimer) { cancelAnimationFrame(this._countdownTimer); this._countdownTimer = null; }
  }

  // ---- mic -----------------------------------------------------------------

  _stopMic() { if (this.detector) this.detector.stop(); }

  async _ensureMic() {
    // Browsers only expose the microphone to secure origins.  Over plain HTTP
    // — which is how a phone usually reaches a dev server on the LAN —
    // `navigator.mediaDevices` is not merely blocked but absent, so say that
    // plainly instead of failing on an undefined property.
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error(
        window.isSecureContext === false
          ? "The microphone needs a secure connection. Open this page over HTTPS (or on localhost) to sing."
          : "This browser does not offer microphone access."
      );
    }
    if (!this.detector) this.detector = new PitchDetector();
    if (!this.detector.isRunning) await this.detector.start(() => {});
  }

  // ---- deck UI -------------------------------------------------------------

  _renderDeck() {
    const c = this.chapter;
    const m = this.mode;
    const source = this._source();
    const bars = (source && source.bars || []).length;
    const total = this._sessionTotal();

    // The staff is the exercise, so it owns the middle of the screen and the
    // chrome is pushed to two thin bands: what you are doing and how far in
    // (above), how to drive it (below).  Everything that used to sit under
    // the staff in tall blocks — the icon banner, the 84px score ring, the
    // duplicated instruction line — is gone or folded into those bands.
    const pips = total <= PIP_LIMIT ? '<div class="dsp-pips" id="d-pips"></div>' : "";

    this.info.innerHTML =
      '<div class="deck">' +
        '<div class="deck-head">' +
          '<div class="dh-title">' +
            '<span class="dh-name">' + c.title + "</span>" +
            '<span class="dh-tags">' +
              (m && m.needsMic ? '<span class="tag mic">' + glyph("mic", 12) + " mic</span>" : "") +
              (m && m.timed ? '<span class="tag timed">' + glyph("clock", 12) + " " + TIMED_DEFAULT + "s</span>" : "") +
              '<span class="tag">' + glyph("bars", 12) + " " + bars + "</span>" +
            "</span>" +
          "</div>" +
          '<div class="dh-progress">' +
            '<div class="dhp-line">' +
              '<span>Round <b id="d-round">0</b>/<b id="d-total">' + total + "</b></span>" +
              '<span id="d-streak"></span>' +
            "</div>" +
            '<div class="dsp-track"><div class="dsp-fill" id="d-fill"></div></div>' +
            pips +
          "</div>" +
          '<div class="dh-avg"><b id="d-avg" class="empty">–</b><small>avg</small></div>' +
        "</div>" +

        // The staff itself is moved in below — it is a long-lived node the
        // renderer draws into, not markup we can rebuild here.
        '<div class="deck-stage" id="deck-stage"></div>' +

        '<div class="deck-foot">' +
          '<div class="deck-controls">' +
            '<button id="d-start" class="btn btn-primary">' + glyph("play", 14) + '<span>Start</span></button>' +
            '<button id="d-stop" class="btn" disabled>' + glyph("stop", 14) + '<span>Stop</span></button>' +
            '<button id="d-replay" class="btn" disabled>' + glyph("replay", 14) + '<span>Replay</span></button>' +
            this._controlsExtras() +
            '<button id="d-info" type="button" class="btn btn-info" aria-label="How this exercise works" aria-expanded="false">' +
              glyph("info", 14) + "</button>" +
          "</div>" +
          '<div id="d-report" class="deck-report">' +
            '<div class="fb-prompt is-hint" id="d-prompt">' + this._readyHint() + "</div>" +
          "</div>" +
          '<div id="d-config"></div>' +
        "</div>" +
      "</div>";

    // Re-home the staff between the two bands.  innerHTML above detached it,
    // but the node survives on `this.stage`, so the renderer's reference and
    // every listener on it stay valid.
    const slot = this.info.querySelector("#deck-stage");
    const stageWrap = this.stage.closest(".session-stage");
    if (slot && stageWrap) slot.appendChild(stageWrap);

    this.info.querySelector("#d-start").addEventListener("click", () => this.start());
    // On a narrow screen the idle instruction is folded behind this; on a wide
    // one there is room for the sentence itself and the button is not shown.
    const info = this.info.querySelector("#d-info");
    if (info) info.addEventListener("click", () => {
      const foot = this.info.querySelector(".deck-foot");
      if (!foot) return;
      const open = foot.classList.toggle("hint-open");
      info.setAttribute("aria-expanded", open ? "true" : "false");
    });
    this.info.querySelector("#d-stop").addEventListener("click", () => this.stopSession());
    const replay = this.info.querySelector("#d-replay");
    if (replay) replay.addEventListener("click", () => this._replayAnswer());
    this._wireControlsExtras();

    this._renderConfig();
    this._renderPips();
    this._renderScore();
    this._setControls(false);
  }

  _sessionTotal() {
    if (!this.mode || !this.barSteps) return 0;
    // A single-bar run (started by clicking a bar) is one round, whatever the
    // full session for this chapter would have been.
    if (this._singleRun) return 1;
    if (this.mode.key === "guess_multi") {
      // generated questions; compute lazily but cap for display
      return Math.max(1, Math.min(12, this.barSteps.length));
    }
    return this.barSteps.length;
  }

  _setControls(running) {
    const start = this.info.querySelector("#d-start");
    const stop = this.info.querySelector("#d-stop");
    const replay = this.info.querySelector("#d-replay");
    if (start) start.disabled = running;
    if (stop) stop.disabled = !running;
    if (replay) replay.disabled = !(this._lastAnswerBar != null && !running);
  }

  /** Inline controls-row extras (e.g. listen repeat/random toggles). */
  _controlsExtras() {
    if (!this.mode || this.mode.key !== "listen") return "";
    const o = this.listenOpts;
    return '<span class="ctrl-extras">' +
      '<button id="cfg-repeat" type="button" class="btn btn-toggle' + (o.repeat ? " on" : "") + '">' + glyph("replay", 14) + '<span>Repeat</span></button>' +
      '<button id="cfg-random" type="button" class="btn btn-toggle' + (o.random ? " on" : "") + '">' + glyph("rounds", 14) + '<span>Random</span></button>' +
    "</span>";
  }

  /** Wire controls-row extras after the deck is in the DOM. */
  _wireControlsExtras() {
    if (!this.mode || this.mode.key !== "listen") return;
    const rep = this.info.querySelector("#cfg-repeat");
    if (rep) rep.addEventListener("click", () => {
      this.listenOpts.repeat = rep.classList.toggle("on");
    });
    const rnd = this.info.querySelector("#cfg-random");
    if (rnd) rnd.addEventListener("click", () => {
      this.listenOpts.random = rnd.classList.toggle("on");
    });
  }

  _renderPips() {
    const el = this.info.querySelector("#d-pips");
    if (!el) return;
    const total = this._sessionTotal();
    const isListen = !!(this.mode && this.mode.key === "listen");
    let html = "";
    const playedCount = isListen ? (this._playedBars ? this._playedBars.size : 0) : 0;
    for (let i = 0; i < total; i++) {
      let cls;
      if (isListen) {
        // No scoring in listening mode — pips fill left-to-right as unique
        // bars are played (sequential or manual), one step per bar.
        cls = i < playedCount ? "good" : "pending";
      } else {
        const s = this.scores[i];
        cls = s == null ? "pending" : s >= 70 ? "good" : s >= 40 ? "ok" : "weak";
      }
      html += '<span class="pip ' + cls + '" title="Round ' + (i + 1) + '"></span>';
    }
    el.innerHTML = html;
  }

  _renderProgress() {
    const total = this._sessionTotal();
    const round = Math.min(this.round, total);
    const fill = this.info.querySelector("#d-fill");
    if (fill) fill.style.width = total ? (round / total * 100) + "%" : "0%";
    const re = this.info.querySelector("#d-round");
    if (re) re.textContent = round;
    const te = this.info.querySelector("#d-total");
    if (te) te.textContent = total;
    // streak
    let streak = 0;
    for (let i = this.scores.length - 1; i >= 0; i--) { if (this.scores[i] >= 70) streak++; else break; }
    const se = this.info.querySelector("#d-streak");
    if (se) se.textContent = streak >= 2 ? streak + " streak" : "";
    this._renderPips();
  }

  _renderScore() {
    const arc = this.info.querySelector("#d-gauge-arc");
    const avgEl = this.info.querySelector("#d-avg");
    const avg = this.scores.length ? Math.round(this.scores.reduce((a, b) => a + b, 0) / this.scores.length) : null;
    if (arc) {
      const circ = 2 * Math.PI * 52;
      arc.style.strokeDasharray = circ;
      arc.style.strokeDashoffset = circ * (1 - (avg || 0) / 100);
      arc.style.stroke = avg == null ? "var(--muted-2)" : avg >= 85 ? "var(--accent-2)" : avg >= 60 ? "var(--accent)" : avg >= 35 ? "var(--warn)" : "var(--bad)";
    }
    if (avgEl) {
      if (avg == null) { avgEl.textContent = "–"; avgEl.classList.add("empty"); }
      else { avgEl.textContent = avg; avgEl.classList.remove("empty"); }
    }
  }

  /** The idle prompt: both ways into an exercise (Start, or a single bar). */
  _readyHint() {
    const mic = this.mode && this.mode.needsMic;
    return "Press <b>Start</b> for the whole set, or <b>click a bar</b> to practise just that one" +
      (mic ? " (the mic is enabled for you)." : ".");
  }

  /** Write the round prompt.  `_feedback` replaces the whole report block, so
   *  the prompt element is routinely gone by the time the next round wants it
   *  — recreate it rather than silently writing nowhere (which is what left
   *  later rounds, and the timed modes' countdown readout, blank). */
  _prompt(html) {
    let el = this.info.querySelector("#d-prompt");
    if (!el) {
      const rep = this.info.querySelector("#d-report");
      if (!rep) return;
      rep.innerHTML = '<div class="fb-prompt" id="d-prompt"></div>';
      el = rep.querySelector("#d-prompt");
    }
    if (el) el.innerHTML = html;
  }

  _report(html) {
    const el = this.info.querySelector("#d-report");
    if (el) el.innerHTML = html;
  }

  _setLegend(text) { this.legend.textContent = text; }

  /** Mode-10 generation config.  (Listen options live in the controls row.) */
  _renderConfig() {
    const cfg = this.info.querySelector("#d-config");
    if (!cfg) return;
    if (!this.mode || this.mode.key === "guess_multi") {
      this._renderMultiConfig(cfg);
      return;
    }
    cfg.innerHTML = "";
  }

  _renderListenConfig(cfg) {
    cfg.innerHTML = "";
  }

  _renderMultiConfig(cfg) {
    if (!this.mode || this.mode.key !== "guess_multi") { cfg.innerHTML = ""; return; }
    const o = this.multiOpts;
    cfg.innerHTML =
      '<div class="cfg">' +
        '<div class="cfg-title">Generation</div>' +
        '<label>Style<select id="cfg-gen">' +
          '<option value="intervals">Intervals</option><option value="chords">Chords</option>' +
          '<option value="random_no_repeat">Random (no repeat)</option><option value="random_with_repeat">Random (with repeat)</option>' +
        "</select></label>" +
        '<label class="cfg-gen cfg-int">Interval<select id="cfg-interval">' +
          '<option value="seconds">Seconds</option><option value="thirds">Thirds</option><option value="fourths">Fourths</option>' +
          '<option value="fifths">Fifths</option><option value="sixths">Sixths</option><option value="sevenths">Sevenths</option><option value="octaves">Octaves</option>' +
        "</select></label>" +
        '<label class="cfg-gen cfg-chord">Chord<select id="cfg-chord"><option value="5/3">5/3</option><option value="6/3">6/3</option><option value="6/4">6/4</option></select></label>' +
        '<label class="cfg-gen cfg-chord">Seventh<select id="cfg-seventh"><option value="7">7</option><option value="6/5">6/5</option><option value="2">2</option><option value="4/3">4/3</option></select></label>' +
        '<label>Notes<input id="cfg-count" type="number" min="2" max="12" value="' + o.noteCount + '" /></label>' +
      "</div>";
    const setSel = (id, key) => {
      const el = cfg.querySelector(id);
      if (el) { el.value = o[key]; el.addEventListener("change", () => { o[key] = el.value; this._toggleGen(); }); }
    };
    setSel("#cfg-gen", "generation"); setSel("#cfg-interval", "interval");
    setSel("#cfg-chord", "chord"); setSel("#cfg-seventh", "seventh");
    const cnt = cfg.querySelector("#cfg-count");
    if (cnt) cnt.addEventListener("change", () => { o.noteCount = Math.max(2, Math.min(12, parseInt(cnt.value, 10) || 3)); });
    this._toggleGen();
  }

  _toggleGen() {
    const cfg = this.info.querySelector("#d-config");
    if (!cfg) return;
    const gen = this.multiOpts.generation;
    cfg.querySelectorAll(".cfg-gen").forEach((el) => el.style.display = "none");
    if (gen === "intervals") cfg.querySelectorAll(".cfg-int").forEach((el) => el.style.display = "");
    if (gen === "chords") cfg.querySelectorAll(".cfg-chord").forEach((el) => el.style.display = "");
  }

  // ---- notation helpers ----------------------------------------------------

  _renderScoreVisual() {
    const source = this._source();
    if (!source) return;
    if (this._usesKeyModel() && this.keyModel) {
      this.renderer = this.renderKeyModelNotation(this.keyModel, (idx) => this._onBarClick(idx));
    } else {
      this.renderer = this.renderNotation(source, (idx) => this._onBarClick(idx));
    }
    // A fresh run starts from a clean stave — accuracy colours accumulate
    // across the rounds of one session, not across sessions.
    if (this.renderer && this.renderer.clearNoteAccuracy) this.renderer.clearNoteAccuracy();
    // The renderer redraws itself when its panel changes width (rotation, a
    // resize, the first paint before layout has settled).  That rebuilds the
    // SVG, so the hidden-notes state has to be put back afterwards.
    if (this.renderer) {
      this.renderer.onRelayout = () => {
        if (this._notesHidden) this._hideNotes(); else this._showNotes();
      };
    }
    this._lastAnswerBar = null;
  }

  _showNotes() {
    this._notesHidden = false;
    if (this.stage) this.stage.classList.remove("hidden-notes");
  }

  _hideNotes() {
    this._notesHidden = true;
    if (this.stage) this.stage.classList.add("hidden-notes");
  }

  // ---- session -------------------------------------------------------------

  async start() {
    if (!this.mode) { this.setStatus("No mode."); return; }
    if (!this.barSteps || !this.barSteps.length) { this.setStatus("No bars to practice."); return; }
    this.stop();

    // Ask for the mic here, while we are still inside the Start click.
    // Requesting it later — lazily, from inside the first singing round — is
    // outside any user gesture, which browsers refuse: the round then got no
    // frames, scored zero and advanced, so a singing chapter played through
    // like a listening one without ever recording the student.
    if (this.mode.needsMic) {
      this.setStatus("Enabling microphone…");
      try { await this._ensureMic(); }
      catch (e) {
        this.setStatus("Microphone unavailable.");
        this._feedback({ score: 0, verdict: "—", head: "Mic unavailable", detail: e.message });
        return;
      }
    }

    this.running = true;
    this._singleRun = false;
    this.round = 0;
    this.scores = [];
    this._playedBars = new Set();
    this._renderScoreVisual();
    // Noteheads are always visible across every mode — the hidden-notes
    // toggle previously caused a first-playback flash in guessing modes.
    this._showNotes();
    this._setControls(true);
    this._renderProgress();
    this._renderScore();
    this._beginSession();
  }

  /**
   * Run a single bar as a one-off exercise.
   *
   * This is what clicking a bar does when no session is running: instead of
   * working through every bar the way Start does, the clicked bar becomes the
   * whole (one-round) exercise, in whatever mode the chapter is.  The click is
   * a user gesture, which is exactly what `getUserMedia` wants, so for the
   * singing chapters the mic is requested right here rather than a beat later
   * inside the round.
   */
  async startSingle(barIndex) {
    if (!this.mode) { this.setStatus("No mode."); return; }
    if (!this.barSteps || !this.barSteps[barIndex]) return;
    this.stop();

    // Ask for the mic while we are still inside the click handler.
    if (this.mode.needsMic) {
      this._setLegend("Enabling microphone…");
      this.setStatus("Enabling microphone…");
      try { await this._ensureMic(); }
      catch (e) {
        this._setLegend("Microphone unavailable.");
        this.setStatus("Microphone unavailable.");
        this._feedback({ score: 0, verdict: "—", head: "Mic unavailable", detail: e.message });
        return;
      }
    }

    this.running = true;
    this._singleRun = true;
    this.round = 0;
    this.scores = [];
    this._playedBars = new Set();
    this._renderScoreVisual();
    this._showNotes();
    this._setControls(true);
    this.order = this.mode.key === "guess_multi"
      ? [this._buildMultiQuestion(barIndex)].filter((q) => q && q.length)
      : [barIndex];
    if (!this.order.length) { this.running = false; this._setControls(false); return; }
    this._renderProgress();
    this._renderScore();
    this.setStatus("Bar " + (barIndex + 1));
    this._nextRound();
  }

  stopSession() {
    this.stop();
    if (this.renderer) { this.renderer.clearHighlight(); this.renderer.clearBarHighlight(); }
    this._showNotes();
    this._setControls(false);
    this._prompt("Session stopped. " + this._readyHint());
    this._setLegend("Stopped.");
    this.setStatus("Stopped.");
  }

  _beginSession() {
    if (this.mode.key === "listen") {
      const seq = this.barSteps.map((b, i) => i);
      this.order = this.listenOpts.random ? shuffle(seq) : seq;
    } else if (this.mode.key === "guess_multi") {
      this.order = this._generateMultiQuestions();
    } else if (this.mode.key === "sing_repeat") {
      this.order = this.barSteps.map((b, i) => i);
    } else {
      this.order = shuffle(this.barSteps.map((b, i) => i));
    }
    this._renderProgress();
    this._nextRound();
  }

  _nextRound() {
    if (!this.running) return;
    if (this.round >= this.order.length) { this._finishSession(); return; }
    this._renderProgress();
    this._runRound();
  }

  _finishSession() {
    // `_singleRun` deliberately stays set: the deck should keep reading 1/1
    // for the bar just practised rather than snapping back to the full
    // session's round count.  start()/startSingle()/stop() clear it.
    const single = this._singleRun;
    this.running = false;
    this._stopMic();
    this.round = this.order.length;
    this._renderProgress();
    this._renderScore();
    this._showNotes();
    this._setControls(false);

    // A single-bar run is a practice attempt, not a completed chapter: keep
    // the round's own feedback card on screen, don't show the chapter summary,
    // and don't record it against the chapter's progress.
    if (single) {
      const s = this.scores.length ? this.scores[this.scores.length - 1] : null;
      this._setLegend(s == null ? "Bar done." : "Bar score: " + s + " — click another bar, or press Start for the full set.");
      this.setStatus(s == null ? "Ready" : "Bar score: " + s);
      return;
    }

    // Listening (chapter 1) has no scoring — show a simple completion card.
    if (this.mode && this.mode.key === "listen") {
      this._setLegend("Listening complete.");
      this.setStatus("Complete");
      this._renderListenSummary();
      this.onSessionComplete(this.chapter, 0);
      return;
    }

    const avg = this.scores.length ? Math.round(this.scores.reduce((a, b) => a + b, 0) / this.scores.length) : 0;
    const passed = avg >= 70;
    const verdict = avg >= 95 ? "Flawless!" : avg >= 85 ? "Excellent" : avg >= 70 ? "Well done!" : avg >= 50 ? "Good effort" : "Keep practising";
    this._setLegend("Chapter complete — " + avg + "/100");
    this.setStatus("Complete: " + avg);
    this._renderSummary(avg, passed, verdict);
    this.onSessionComplete(this.chapter, avg);
  }

  _renderListenSummary() {
    this._report(
      '<div class="summary pass">' +
        '<div class="sum-verdict">Listening complete</div>' +
        '<div class="sum-sub">You heard all ' + this.order.length + ' bars.</div>' +
        '<div class="sum-actions">' +
          '<button class="btn btn-primary" id="sum-again">' + glyph("play", 14) + '<span>Listen again</span></button>' +
          '<button class="btn" id="sum-next">' + glyph("next", 14) + '<span>Next chapter</span></button>' +
        '</div>' +
      '</div>'
    );
    const again = this.info.querySelector("#sum-again");
    if (again) again.addEventListener("click", () => this.start());
    const next = this.info.querySelector("#sum-next");
    if (next) next.addEventListener("click", () => this._goNext());
  }

  _renderSummary(avg, passed, verdict) {
    const pips = this.scores.map((s, i) => {
      const cls = s >= 70 ? "good" : s >= 40 ? "ok" : "weak";
      return '<span class="pip ' + cls + '" title="Round ' + (i + 1) + ": " + s + '"></span>';
    }).join("");
    const ringColor = avg >= 85 ? "var(--accent-2)" : avg >= 60 ? "var(--accent)" : avg >= 35 ? "var(--warn)" : "var(--bad)";
    this._report(
      '<div class="summary ' + (passed ? "pass" : "try") + '">' +
        '<div class="sum-ring">' +
          '<svg viewBox="0 0 120 120">' +
            '<circle class="g-bg" cx="60" cy="60" r="52"></circle>' +
            '<circle cx="60" cy="60" r="52" fill="none" stroke-width="8" stroke-linecap="round" style="stroke:' + ringColor + ";stroke-dasharray:" + (2 * Math.PI * 52) + ";stroke-dashoffset:" + (2 * Math.PI * 52 * (1 - avg / 100)) + '"></circle>' +
          '</svg>' +
          '<div class="sum-score" style="color:' + ringColor + '">' + avg + '</div>' +
        '</div>' +
        '<div class="sum-verdict">' + verdict + '</div>' +
        '<div class="sum-sub">' + (passed ? "Completed" : "Score 70+ to complete") + '</div>' +
        '<div class="sum-pips">' + pips + '</div>' +
        '<div class="sum-actions">' +
          '<button class="btn btn-primary" id="sum-again">' + glyph("play", 14) + '<span>Try again</span></button>' +
          '<button class="btn" id="sum-next">' + glyph("next", 14) + '<span>Next chapter</span></button>' +
        '</div>' +
      '</div>'
    );
    const again = this.info.querySelector("#sum-again");
    if (again) again.addEventListener("click", () => this.start());
    const next = this.info.querySelector("#sum-next");
    if (next) next.addEventListener("click", () => this._goNext());
  }

  _goNext() {
    // ask the app to open the next chapter via a custom event
    this.info.dispatchEvent(new CustomEvent("rea:next-chapter", { bubbles: true, detail: { from: this.chapter.id } }));
  }

  // ---- round dispatch ------------------------------------------------------

  _runRound() {
    const key = this.mode.key;
    if (key === "listen") return this._roundListen();
    if (key === "sing_repeat") return this._roundSingRepeat();
    if (key === "sing_proposed") return this._roundSingProposed();
    if (key === "guess") return this._roundGuess(false);
    if (key === "guess_timed") return this._roundGuess(true);
    if (key === "guess_notes") return this._roundGuessNotes(false);
    if (key === "guess_notes_t") return this._roundGuessNotes(true);
    if (key === "sing_notes") return this._roundSingNotes(false);
    if (key === "sing_notes_t") return this._roundSingNotes(true);
    if (key === "guess_multi") return this._roundGuessMulti();
  }

  // ---- countdown (timed modes) -------------------------------------------
  // Drives both a textual "Ns" readout and a realtime decreasing progress bar
  // below the sheet music (#countdown-bar), so the user sees the time left
  // per question degrading smoothly.

  _startCountdown(onTimeout) {
    this._clearTimers();
    const bar = document.getElementById("countdown-bar");
    const fill = document.getElementById("cd-bar-fill");
    if (bar) bar.hidden = false;
    if (fill) { fill.style.width = "100%"; }
    const totalMs = TIMED_DEFAULT * 1000;
    const start = performance.now();
    this._renderCountdown(TIMED_DEFAULT);
    const tick = () => {
      if (!this._countdownTimer) return; // stopped
      const elapsed = performance.now() - start;
      const remainMs = Math.max(0, totalMs - elapsed);
      const remainSec = Math.ceil(remainMs / 1000);
      this._renderCountdown(remainSec);
      if (fill) fill.style.width = (remainMs / totalMs * 100) + "%";
      if (bar) bar.classList.toggle("urgent", remainSec <= 3);
      if (remainMs <= 0) {
        this._countdownTimer = null;
        if (bar) bar.hidden = true;
        onTimeout();
        return;
      }
      this._countdownTimer = requestAnimationFrame(tick);
    };
    this._countdownTimer = requestAnimationFrame(tick);
  }

  _renderCountdown(sec) {
    const el = this.info.querySelector("#d-countdown");
    if (el) { el.textContent = sec + "s"; el.classList.toggle("urgent", sec <= 3); }
  }

  _stopCountdown() {
    if (this._countdownTimer) {
      cancelAnimationFrame(this._countdownTimer);
      this._countdownTimer = null;
    }
    const el = this.info.querySelector("#d-countdown");
    if (el) el.textContent = "";
    const bar = document.getElementById("countdown-bar");
    if (bar) bar.hidden = true;
  }

  // ---- 1. Listening --------------------------------------------------------
  //
  // Start plays every bar once, in sequence (no per-bar repeat).  When the
  // "Repeat" option is on the whole sequence restarts after the last bar;
  // otherwise the session ends.  "Random order" shuffles the bars (applied
  // at session start).  Clicking a bar plays just that bar and, once it
  // finishes, resumes the sequence from the following bar.

  _roundListen() {
    if (!this.running) return;
    if (!this.mode || this.mode.key !== "listen") return;
    if (this.round >= this.order.length) {
      if (this.listenOpts.repeat) {
        this.round = 0;
        if (this.listenOpts.random) this.order = shuffle(this.order);
      } else { this._finishSession(); return; }
    }
    const barIndex = this.order[this.round];
    if (typeof barIndex !== "number" || !this.barSteps[barIndex]) return;
    if (!this._playedBars) this._playedBars = new Set();
    this._playedBars.add(barIndex);
    this._renderProgress();
    this._setLegend("Listening · bar " + (barIndex + 1) + "/" + this.barSteps.length +
      (this.listenOpts.repeat ? " (repeat)" : ""));
    this._prompt("Listening <b>" + (this.round + 1) + "/" + this.order.length + "</b>");
    this._playBar(barIndex, () => {
      if (!this.running) return;
      if (!this.mode || this.mode.key !== "listen") return;
      this.round += 1;
      this._renderProgress();
      this._loopTimer = setTimeout(() => this._roundListen(), 350);
    });
  }

  _playBar(barIndex, onDone) {
    if (barIndex == null || !this.barSteps[barIndex]) { if (onDone) onDone(); return; }
    if (!this.renderer) this._renderScoreVisual();
    // Cancel any pending sequence-advance so a manual bar click doesn't
    // collide with the running listen sequence.
    if (this._loopTimer) { clearTimeout(this._loopTimer); this._loopTimer = null; }
    this._roundToken++;
    this.player.stop();
    const token = this._roundToken;
    const { steps } = barsToFlat(this.barSteps, [barIndex], this.renderer);
    if (!steps.length) { if (onDone) onDone(); return; }
    this.renderer.highlightBar(barIndex);
    const ok = this.player.play(steps, {
      onStep: (i) => {
        if (i < 0) { if (token === this._roundToken && onDone) onDone(); return; }
        if (token !== this._roundToken) return;
        const s = steps[i];
        if (s) { this.renderer.highlightBar(s.barIndex); this.renderer.highlightNote(s.scoreGlobalIndex); }
      },
    });
    if (!ok) { this.setStatus("Audio unavailable."); if (onDone && token === this._roundToken) onDone(); }
  }

  // ---- 2. Singing with repetition -----------------------------------------

  async _roundSingRepeat() {
    const barIndex = this.order[this.round];
    this._setLegend("Sing bar " + (barIndex + 1) + " back after you hear it…");
    this._prompt("Listen, then sing it back. <b>" + (this.round + 1) + "/" + this.order.length + "</b>");
    this._playBar(barIndex, async () => {
      if (!this.running) return;
      await this._recordAndScoreBar(barIndex);
    });
  }

  // ---- 5. Singing proposed -------------------------------------------------

  async _roundSingProposed() {
    const barIndex = this.order[this.round];
    this.renderer.highlightBar(barIndex);
    this._setLegend("Sing the highlighted bar (bar " + (barIndex + 1) + ").");
    this._prompt("Sing the highlighted bar. <b>" + (this.round + 1) + "/" + this.order.length + "</b>");
    await this._recordAndScoreBar(barIndex);
  }

  // ---- 8/9. Singing proposed notes -----------------------------------------

  async _roundSingNotes(timed) {
    const barIndex = this.order[this.round];
    const pitches = barPitches(this.barSteps[barIndex]);
    const degrees = barDegrees(this.barSteps[barIndex]);
    if (!pitches.length) { this._advance(); return; }
    const noteIdx = randInt(pitches.length);
    const targetMidi = pitches[noteIdx];
    const targetDegree = degrees[noteIdx];

    this.renderer.clearBarHighlight();
    const range = this.renderer.getBarNoteRange(barIndex);
    if (range) { this.renderer.highlightBar(barIndex); this.renderer.highlightNote(range.start + noteIdx); }
    this._setLegend("Sing the highlighted note (" + midiToName(targetMidi) + ", degree " + targetDegree + ")." + (timed ? " Timed!" : ""));
    this._prompt("Sing the highlighted note. <b>" + (this.round + 1) + "/" + this.order.length + "</b>" +
      (timed ? ' <span class="cd" id="d-countdown">' + TIMED_DEFAULT + "s</span>" : ""));

    // Play the target note as a short preview so the user hears what to sing;
    // recording (and, for the timed variant, the countdown) only starts once
    // the preview has finished.
    const preview = [{ midi: targetMidi, isRest: false, startMs: 0, durationMs: 700, volume: 85, barIndex: -1, scoreGlobalIndex: -1 }];
    this._roundToken++;          // invalidate any stale onStep(-1) from the previous round
    this.player.stop();
    const token = this._roundToken;
    const ok = this.player.play(preview, {
      onStep: (i) => {
        if (i < 0 && token === this._roundToken && this.running) this._beginSingNotesRecord(barIndex, targetMidi, targetDegree, noteIdx, timed);
      },
    });
    if (!ok) { this.setStatus("Audio unavailable."); if (token === this._roundToken) this._beginSingNotesRecord(barIndex, targetMidi, targetDegree, noteIdx, timed); }
  }

  async _beginSingNotesRecord(barIndex, targetMidi, targetDegree, noteIdx, timed) {
    if (!this.running) return;
    const recMs = timed ? Math.min(TIMED_DEFAULT * 1000, 4000) : 4000;
    let done = false;
    const finish = (timedOut, sung) => {
      if (done) return; done = true;
      this._stopCountdown();
      this._stopRecording();
      this._finishSingNotes(barIndex, targetMidi, targetDegree, noteIdx, timedOut, sung);
    };
    // Live capture of the single target note.  Whatever pitch the singer
    // settles on is taken as the attempt — right or wrong — and the round ends
    // there instead of running the recorder out to its full length.
    const capture = this._makeSingleNoteCapture(barIndex, noteIdx, targetMidi, (note) => finish(false, note));
    // Countdown starts now — after the preview playback has ended.
    if (timed) this._startCountdown(() => { if (this.running) finish(true, null); });
    await this._recordNotes(recMs + SING_TAIL_MS, () => finish(false, capture.best()), capture.onPitch);
  }

  /**
   * Single-note variant of `_makeLiveCapture`: watch one note, and hand back
   * the pitch the singer *settles on* — right or wrong.
   *
   * It runs the same segmenter the bar capture does, and for the same reason.
   * The old version committed the first pitch held steadily for 240 ms, which
   * is not a decision: a singer working out an interval slides towards it and
   * pauses on the way, and a quarter of a second on the way past a note is
   * exactly what those pauses look like.  The round ended on the pause, scored
   * it, and moved on before they had sung the note they were reaching for.
   *
   * Settling is the same test as everywhere else: held long enough, and
   * steadily enough, to be an answer.  A search does not end the round — the
   * singer can hunt, and the round waits — but it is remembered, so an attempt
   * cut short by the countdown is scored where they actually were rather than
   * read as silence.
   */
  _makeSingleNoteCapture(barIndex, noteIdx, targetMidi, onNote) {
    const r = this.renderer;
    const pitched = (r && r.getPitchedNotesInBar) ? r.getPitchedNotesInBar(barIndex) : [];
    const slot = pitched[noteIdx] || pitched[0] || null;
    if (r && slot) {
      r.setSungTarget(slot.globalIndex, targetMidi);
      r.showSungNote(slot.globalIndex, targetMidi, targetMidi);
    }
    const seg = makeNoteSegmenter({
      // There is no phrase here to take a tempo from, so the segmenter is told
      // what one note is worth and left to it.
      paceMs: SINGLE_NOTE_PACE_MS,
      vibratoCents: getVoiceVibratoCents(),
      onsetFloor: getVoiceOnsetFloor(),
    });
    let bestNote = null, done = false;
    let smoothMidi = targetMidi, lastT = null, lastDraw = 0;

    /** Keep the strongest attempt so far: a settled note beats a search, and
     *  between two of a kind the one held longer was the more meant. */
    const keep = (midi, durMs, settled) => {
      if (midi == null) return;
      if (!bestNote || (settled && !bestNote.settled) ||
          (settled === bestNote.settled && durMs > bestNote.durMs)) {
        bestNote = { midi, durMs, settled };
      }
    };

    return {
      best: () => bestNote,
      onPitch: (info) => {
        if (!this.running || done) return;
        const now = (info && info.t != null) ? info.t : performance.now();
        const dt = lastT == null ? 0 : now - lastT;
        lastT = now;
        const usableDt = (dt > 0 && dt < 500) ? dt : 0;
        const midi = (info && info.midi != null) ? info.midi
                   : (info && info.midiRound != null) ? info.midiRound : null;

        if (midi != null) {
          if (usableDt) smoothMidi = smoothMidi + (midi - smoothMidi) * Math.min(1, usableDt / 90);
          else smoothMidi = midi;
          if (r && slot && now - lastDraw > 60) {
            r.showSungNote(slot.globalIndex, smoothMidi, targetMidi);
            lastDraw = now;
          }
        }

        const note = seg.feed({
          midi,
          onsetStrength: (info && info.onsetStrength) || 0,
          onsetAttack: (info && info.onsetAttack) || 0,
          t: now,
          dt: usableDt,
        });

        // A note that finished without ever settling is a search: worth
        // remembering in case it is all the singer manages, but not an answer.
        if (note.ended && note.ended.confident) {
          keep(note.ended.midi, note.ended.durMs, !!note.ended.settled);
          if (note.ended.settled) {
            done = true;
            if (onNote) onNote(bestNote);
            return;
          }
        }

        // Settled while still being sung: that is the answer, and there is no
        // reason to make them hold it any longer.
        if (note.settled && note.pitch != null) {
          keep(note.pitch, note.heldMs, true);
          done = true;
          if (onNote) onNote(bestNote);
          return;
        }
        if (note.rough != null) keep(note.rough, note.heldMs, false);
      },
    };
  }


  _finishSingNotes(barIndex, targetMidi, targetDegree, noteIdx, timedOut, sung) {
    if (!this.running) return;
    const sungMidi = sung == null ? null : (typeof sung === "number" ? sung : sung.midi);
    const cents = sungMidi != null ? (sungMidi - targetMidi) * 100 : null;
    const score = sungMidi != null ? noteScoreFor(sungMidi, targetMidi) : 0;
    this.scores.push(score);
    this._renderScore(); this._renderProgress();
    this._feedback({
      score, verdict: scoreLabel(score),
      head: (timedOut ? "Time up! " : "") + "Target " + midiToName(targetMidi) + " (deg " + targetDegree + ")",
      detail: "You sang " + (sungMidi != null ? midiToName(Math.round(sungMidi)) : "—") +
        (cents != null ? " · " + (cents > 0 ? "+" : "") + Math.round(cents) + "c" : ""),
      extra: '<div class="sn-row">' + noteCellHTML({ sung: sungMidi, ref: targetMidi, score }) + "</div>",
    });
    this._setLegend("Note score: " + score);
    const slots = (this.renderer && this.renderer.getPitchedNotesInBar)
      ? this.renderer.getPitchedNotesInBar(barIndex) : [];
    this._markNoteAccuracy(slots, noteIdx, sungMidi != null ? score : null);
    this._advanceAfter(1100);
  }

  // ---- 3/4. Guessing --------------------------------------------------------

  _roundGuess(timed) {
    const barIndex = this.order[this.round];
    this._lastAnswerBar = barIndex;
    this._setLegend("Listen, then click the bar you heard." + (timed ? " (" + TIMED_DEFAULT + "s)" : ""));
    this._prompt("Hear the hidden bar, click the one you heard. <b>" + (this.round + 1) + "/" + this.order.length + "</b>" +
      (timed ? ' <span class="cd" id="d-countdown">' + TIMED_DEFAULT + "s</span>" : ""));
    this._roundToken++;          // invalidate any stale onStep(-1) from the previous round
    this.player.stop();
    const token = this._roundToken;
    const { steps } = barsToFlat(this.barSteps, [barIndex], this.renderer);
    this.renderer.clearHighlight(); this.renderer.clearBarHighlight();
    const ok = this.player.play(steps, {
      onStep: (i) => { if (i < 0 && token === this._roundToken) this._awaitGuess(barIndex, timed); },
    });
    if (!ok) { this.setStatus("Audio unavailable."); if (token === this._roundToken) this._advance(); }
  }

  _awaitGuess(answerBar, timed) {
    if (!this.running) return;
    let resolved = false;
    this._clickGuard = (idx) => {
      if (resolved || !this.running) return;
      resolved = true;
      this._stopCountdown();
      this._showNotes();
      const score = scoreGuessBar(idx, answerBar, this.barSteps.length);
      this.scores.push(score);
      this._renderScore(); this._renderProgress();
      this._feedback({
        score, verdict: scoreLabel(score),
        head: "You picked bar " + (idx + 1) + " · correct was bar " + (answerBar + 1),
        detail: idx === answerBar ? "Spot on!" : Math.abs(idx - answerBar) === 1 ? "One bar off" : "Not quite",
      });
      this._setLegend("Guess: " + score + "/100 (correct bar " + (answerBar + 1) + ")");
      this._advanceAfter(1100);
    };
    if (timed) this._startCountdown(() => {
      if (resolved || !this.running) return;
      resolved = true;
      this._showNotes();
      this.scores.push(0);
      this._renderScore(); this._renderProgress();
      this._feedback({ score: 0, verdict: "Miss", head: "Time up! Correct was bar " + (answerBar + 1), detail: "" });
      this._setLegend("Time up");
      this._advanceAfter(900);
    });
  }

  // ---- 6/7. Guessing notes -------------------------------------------------

  _roundGuessNotes(timed) {
    const barIndex = this.order[this.round];
    const pitches = barPitches(this.barSteps[barIndex]);
    const degrees = barDegrees(this.barSteps[barIndex]);
    if (!pitches.length) { this._advance(); return; }
    const noteIdx = randInt(pitches.length);
    const targetMidi = pitches[noteIdx];
    const targetDegree = degrees[noteIdx];
    this._lastAnswerBar = barIndex;

    this._roundToken++;          // invalidate any stale onStep(-1) from the previous round
    this.player.stop();
    const token = this._roundToken;
    const { steps } = barsToFlat(this.barSteps, [barIndex], this.renderer);
    const single = steps.filter((s) => !s.isRest).slice(noteIdx, noteIdx + 1).map((s) => ({ ...s, startMs: 0 }));
    const sched = single.length ? single : steps.filter((s) => !s.isRest).slice(0, 1).map((s) => ({ ...s, startMs: 0 }));
    this.renderer.clearHighlight(); this.renderer.clearBarHighlight();
    this._setLegend("Hear the note, click the bar of its scale degree." + (timed ? " (" + TIMED_DEFAULT + "s)" : ""));
    this._prompt("Hear the note, click the bar of its degree. <b>" + (this.round + 1) + "/" + this.order.length + "</b>" +
      (timed ? ' <span class="cd" id="d-countdown">' + TIMED_DEFAULT + "s</span>" : ""));
    const ok = this.player.play(sched, {
      onStep: (i) => { if (i < 0 && token === this._roundToken) this._awaitNoteGuess(barIndex, targetDegree, timed); },
    });
    if (!ok) { this.setStatus("Audio unavailable."); if (token === this._roundToken) this._advance(); }
  }

  _awaitNoteGuess(answerBar, answerDegree, timed) {
    if (!this.running) return;
    let resolved = false;
    this._clickGuard = (idx) => {
      if (resolved || !this.running) return;
      resolved = true;
      this._stopCountdown();
      const guessedDegrees = barDegrees(this.barSteps[idx]);
      const guessedDegree = guessedDegrees.length ? guessedDegrees[0] : null;
      const hit = guessedDegrees.some((d) => String(d) === String(answerDegree));
      const score = hit ? 100 : 0;
      this.scores.push(score);
      this._renderScore(); this._renderProgress();
      this._feedback({
        score, verdict: hit ? "Perfect" : "Miss",
        head: "Note was degree " + answerDegree + " (bar " + (answerBar + 1) + ")",
        detail: "You clicked bar " + (idx + 1) + " (deg " + (guessedDegree || "?") + ")",
      });
      this._setLegend("Note guess: " + score + "/100");
      this._advanceAfter(1100);
    };
    if (timed) this._startCountdown(() => {
      if (resolved || !this.running) return;
      resolved = true;
      this.scores.push(0);
      this._renderScore(); this._renderProgress();
      this._feedback({ score: 0, verdict: "Miss", head: "Time up! Note was degree " + answerDegree + " (bar " + (answerBar + 1) + ")", detail: "" });
      this._setLegend("Time up");
      this._advanceAfter(900);
    });
  }

  // ---- 10. Guessing notes (multiple) ---------------------------------------

  /** Build one generated question rooted at `rootBar`. */
  _buildMultiQuestion(rootBar) {
    const o = this.multiOpts;
    const count = Math.max(2, Math.min(12, o.noteCount || 3));
    const allBars = this.barSteps.map((b, i) => i);
    const intervalSemitones = { seconds: 1, thirds: 3, fourths: 5, fifths: 7, sixths: 9, sevenths: 11, octaves: 12 };
    const chordDegrees = { "5/3": [0, 3, 5], "6/3": [0, 4, 7], "6/4": [0, 5, 7] };

    const rootPitches = barPitches(this.barSteps[rootBar]);
    if (!rootPitches.length) return null;
    const rootMidi = rootPitches[0];
    if (o.generation === "intervals") {
      const iv = intervalSemitones[o.interval] || 3;
      const arr = [];
      for (let k = 0; k < count; k++) arr.push({ midi: rootMidi + iv * k, degree: String(1 + k) });
      return arr;
    }
    if (o.generation === "chords") {
      const pattern = chordDegrees[o.chord] || chordDegrees["5/3"];
      const arr = [];
      for (let k = 0; k < count; k++) arr.push({ midi: rootMidi + pattern[k % pattern.length], degree: String(1 + pattern[k % pattern.length]) });
      return arr;
    }
    if (o.generation === "random_no_repeat") {
      const pool = allBars.slice(); const arr = [];
      for (let k = 0; k < count; k++) {
        if (!pool.length) break;
        const bi = pool.splice(randInt(pool.length), 1)[0];
        const pp = barPitches(this.barSteps[bi]);
        if (pp.length) arr.push({ midi: pp[0], degree: barDegrees(this.barSteps[bi])[0] });
      }
      return arr;
    }
    const arr = [];
    for (let k = 0; k < count; k++) {
      const bi = allBars[randInt(allBars.length)];
      const pp = barPitches(this.barSteps[bi]);
      if (pp.length) arr.push({ midi: pp[0], degree: barDegrees(this.barSteps[bi])[0] });
    }
    return arr;
  }

  _generateMultiQuestions() {
    const questions = [];
    const rounds = Math.max(1, Math.min(12, this.barSteps.length));
    for (let r = 0; r < rounds; r++) {
      const rootBar = this.barSteps.length ? r % this.barSteps.length : 0;
      const q = this._buildMultiQuestion(rootBar);
      if (q && q.length) questions.push(q);
    }
    return questions;
  }

  _roundGuessMulti() {
    const question = this.order[this.round];
    if (!question || !question.length) { this._advance(); return; }
    this._setLegend("Listen to the " + question.length + " notes, then click the bars in order.");
    this._prompt("Hear the sequence, click the matching bars in order. <b>" + (this.round + 1) + "/" + this.order.length + "</b>");
    const tempo = (this._source().tempo && this._source().tempo > 10) ? this._source().tempo : 80;
    const wholeMs = (4 * 60000) / tempo;
    const noteMs = Math.max(200, Math.round(0.25 * wholeMs));
    const sched = question.map((qn, i) => ({ midi: qn.midi, isRest: false, startMs: i * noteMs, durationMs: noteMs, volume: 85, barIndex: -1, scoreGlobalIndex: -1 }));
    this.player.stop();
    this.renderer.clearHighlight(); this.renderer.clearBarHighlight();
    const token = this._roundToken;
    const ok = this.player.play(sched, {
      onStep: (i) => { if (i < 0 && token === this._roundToken) this._awaitMultiGuess(question); },
    });
    if (!ok) { this.setStatus("Audio unavailable."); if (token === this._roundToken) this._advance(); }
  }

  _awaitMultiGuess(question) {
    if (!this.running) return;
    const guesses = [];
    let resolved = false;
    const answer = question.map((q) => q.degree);
    const renderProgress = () => {
      const cells = answer.map((a, i) => {
        const g = guesses[i];
        const ok = g != null && String(g) === String(a);
        return "<span class='mg-cell " + (g == null ? "pending" : ok ? "good" : "wrong") + "'>" + (i + 1) + ": " + (g != null ? g : "?") + "</span>";
      }).join("");
      this._prompt("Click bar for note <b>" + (guesses.length + 1) + "/" + answer.length + "</b>");
      const rep = this.info.querySelector("#d-prompt");
      if (rep) rep.innerHTML = "Click bar for note <b>" + (guesses.length + 1) + "/" + answer.length + "</b><div class='mg-row'>" + cells + "</div>";
    };
    renderProgress();
    this._clickGuard = (idx) => {
      if (resolved || !this.running) return;
      const degrees = barDegrees(this.barSteps[idx]);
      guesses.push(degrees.length ? degrees[0] : null);
      if (guesses.length >= answer.length) {
        resolved = true;
        let correct = 0;
        for (let i = 0; i < answer.length; i++) if (String(guesses[i]) === String(answer[i])) correct++;
        const score = Math.round((correct / answer.length) * 100);
        this.scores.push(score);
        this._renderScore(); this._renderProgress();
        const cells = answer.map((a, i) => {
          const g = guesses[i]; const ok = g != null && String(g) === String(a);
          return "<span class='mg-cell " + (ok ? "good" : "wrong") + "'>" + (i + 1) + ": " + (g != null ? g : "?") + " / " + a + "</span>";
        }).join("");
        this._feedback({
          score, verdict: scoreLabel(score),
          head: correct + "/" + answer.length + " notes correct",
          detail: "", extra: '<div class="mg-row">' + cells + "</div>",
        });
        this._setLegend("Multi: " + score + "/100");
        this._advanceAfter(1300);
      } else {
        renderProgress();
      }
    };
  }

  // ---- recording / singing helpers -----------------------------------------

  async _recordAndScoreBar(barIndex) {
    if (!this.running) return;
    try { await this._ensureMic(); }
    catch (e) { this._feedback({ score: 0, verdict: "—", head: "Mic unavailable", detail: e.message }); this._advance(); return; }
    const ref = barPitches(this.barSteps[barIndex]);
    const dur = barDurationMs(this.barSteps[barIndex]);
    // Non-timed singing: no fixed time limit.  The bar ends by itself the
    // moment the last reference note has been captured (see the capture's
    // onComplete below) — the "Done" button is only an escape hatch for a
    // singer who wants to give up on the remaining notes.
    const maxMs = Math.max(8000, dur * 3 + 4000);
    this._setLegend("Sing bar " + (barIndex + 1) + " — each note scores as soon as you hold it.");
    this._renderLiveStrip(ref, [], 0);

    // `captured[i]` is the sung attempt for reference note i (or null if the
    // singer stopped before reaching it).
    const captured = new Array(ref.length).fill(null);
    let finished = false;
    const finishNow = () => {
      if (finished) return;
      finished = true;
      // `_doneFinish` is installed by `_recordNotesUntilDone`; calling it
      // tears down the recorder and routes into onDone below.
      if (this._doneFinish) this._doneFinish();
    };

    // Stave slots for this bar's pitched notes, so a scored note can be
    // coloured in place on the score.
    const slots = (this.renderer && this.renderer.getPitchedNotesInBar)
      ? this.renderer.getPitchedNotesInBar(barIndex) : [];
    const onPitch = this._makeLiveCapture(barIndex, ref, {
      noteMs: medianNoteDurationMs(this.barSteps[barIndex]),
      onNote: (i, note) => {
        captured[i] = note;
        // The note being sung, not the one after it.  The strip used to point
        // at the next reference because the marker did; now that the marker
        // stays with the singer, so does this.
        this._renderLiveStrip(ref, captured, Math.min(i, ref.length - 1));
      },
      // The note is finished being sung: settle its colour on the stave.
      onNoteDone: (i, note) => this._markNoteAccuracy(slots, i, noteScoreFor(note.midi, ref[i])),
      // Every reference note has an attempt: end the bar immediately instead
      // of leaving the singer waiting on a timer with nothing left to sing.
      onComplete: () => finishNow(),
    });
    await this._recordNotesUntilDone(maxMs, () => this._scoreCapturedBar(barIndex, ref, captured), onPitch);
  }

  /**
   * Build the live capture callback for a bar.
   *
   * ------------------------------------------------------------------------
   * What this owes the singer
   * ------------------------------------------------------------------------
   *
   * A solfège teacher listening to a student does two things this code has to
   * do as well, and for a long time did not.
   *
   * They let you look for the note.  A student who does not yet hear the
   * interval slides towards it and pauses on the way — and none of those
   * pauses is their answer.  The teacher waits for the one they land on.  So
   * does this: only a *settled* note — one the singer held long enough for it
   * to be a decision — moves the marker on.  Everything shorter is a search.
   * It is still heard, and still scored if the search is all there ever is,
   * but it does not spend a reference note.  Hunt through five pitches on the
   * way to the sixth and the exercise is still on the first reference, waiting.
   *
   * And they stay with you while you sing.  The marker does not leave a note
   * the singer is still on.  It used to: the slot was committed at three
   * quarters of a note and the marker jumped ahead, which from the singer's
   * side is the exercise walking off mid-phrase.  The reading now appears on
   * the note being sung, and the marker moves when the singer does — the one
   * moment that is honestly the end of the note.
   *
   * ------------------------------------------------------------------------
   * The mechanics
   * ------------------------------------------------------------------------
   *
   * `makeNoteSegmenter` decides where each sung note begins and ends and
   * whether it settled.  This function decides what that means for the
   * reference the singer is on:
   *
   *   a settled note ends      the slot is answered with it; the marker moves
   *   a search fragment ends   it is kept as the best answer *so far* for this
   *                            slot; the marker stays
   *   the open note settles    its pitch is reported live, refining as it is
   *                            held, so the singer sees they have been heard
   *   nothing settles at all   after `patienceMs` the best fragment answers
   *                            the slot, so a voice that never holds still
   *                            cannot freeze the exercise
   *   a settled note is held
   *   far past its own length  it has told us everything it can; the slot is
   *                            answered and the marker moves rather than
   *                            waiting out a fermata
   *
   * Nothing here compares the sung pitch to the target in order to decide
   * whether to advance; the target is used only to colour the marker and,
   * later, to score.  Singing the wrong note costs points, never alignment —
   * and now, singing the wrong note *briefly* costs neither.
   *
   * @param {number} barIndex
   * @param {number[]} refPitches  ordered reference MIDI pitches (pitched notes)
   * @param {{onNote:(i:number, note:{midi:number,durMs:number})=>void, onComplete:()=>void}} hooks
   * @returns {(info)=>void}  pass to the recorder as onPitch
   */
  _makeLiveCapture(barIndex, refPitches, { noteMs, onNote, onNoteDone, onComplete } = {}) {
    const r = this.renderer;
    const targets = (refPitches || []).slice();
    if (!targets.length) return () => {};
    const pitched = (r && r.getPitchedNotesInBar) ? r.getPitchedNotesInBar(barIndex) : [];
    const slotOf = (i) => pitched[i] || pitched[pitched.length - 1] || null;

    let step = 0;
    const showTarget = (i, sung) => {
      if (i >= targets.length) return;
      const slot = slotOf(i);
      if (!r || !slot) return;
      r.setSungTarget(slot.globalIndex, targets[i]);
      r.showSungNote(slot.globalIndex, sung != null ? sung : targets[i], targets[i]);
    };
    showTarget(0);

    const seg = makeNoteSegmenter({
      paceMs: noteMs,
      vibratoCents: getVoiceVibratoCents(),
      onsetFloor: getVoiceOnsetFloor(),
    });

    // Notes the singer has sung that have not yet been ruled either an answer
    // or a search.  A note the segmenter opened on pitch alone and that was
    // never held could be either — a quick note, or a pause on the way to one
    // — and the thing that tells them apart has not happened yet.  So it
    // waits here until it can be judged against what the singer does next.
    let searching = [];          // [{ midi, durMs, articulated }]
    let slotOpenedAt = null;     // when the marker arrived at this reference
    let lastReport = 0;          // throttle for the live refinement
    let openAnswered = false;    // the open note has already answered a slot
    let openContinues = null;    // ...or it is an earlier one, still being sung
    let done = false;
    // The answer given to the reference before this one, and whether the
    // singer has been anywhere since.  Together they recognise a singer coming
    // back to the note they were on: see `continuationOf`.
    let lastAnswer = null;       // { index, midi }
    let excursion = false;
    // The bar's last reference has its answer, but the singer is still singing
    // it.  See `answer` — the bar waits for them rather than stopping
    // underneath them.
    let finishing = -1;          // the slot being finished, or -1

    /**
     * Answer the current reference with `note` and move the marker on.
     * Returns true when the caller should stop touching the capture.
     *
     * `stillSinging` says the singer is in the middle of a note as this is
     * decided — which happens whenever the answer comes from the open note
     * rather than from one that has ended.  On any reference but the last that
     * changes nothing.  On the last it changes everything: completing there
     * ends the bar, and ending the bar takes the marker off the note the
     * singer is still holding and scores it from a partial reading.  So the
     * bar waits, keeps refining, and finishes when they do.
     */
    const answer = (note, stillSinging) => {
      if (!note || done) return false;
      const i = step;
      step += 1;
      slotOpenedAt = null;
      lastAnswer = { index: i, midi: note.midi };
      excursion = false;
      if (onNote) onNote(i, { midi: note.midi, durMs: note.durMs });
      if (step >= targets.length) {
        if (stillSinging) { finishing = i; return true; }
        if (onNoteDone) onNoteDone(i, { midi: note.midi, durMs: note.durMs });
        done = true;
        if (onComplete) onComplete();
        return true;
      }
      if (onNoteDone) onNoteDone(i, { midi: note.midi, durMs: note.durMs });
      showTarget(step, smoothMidi);
      return false;
    };

    /** Settle the note the bar has been waiting on, and end the bar. */
    const finishBar = (midi, durMs) => {
      const i = finishing;
      finishing = -1;
      done = true;
      if (i >= 0) {
        if (onNote) onNote(i, { midi, durMs });
        if (onNoteDone) onNoteDone(i, { midi, durMs });
      }
      if (onComplete) onComplete();
    };

    /**
     * Judge the notes still waiting, now that a real one has arrived.
     *
     * A note the singer *meant* and a pause they passed through look identical
     * at the moment they end; what separates them is scale.  Against a note
     * held for the better part of a second, a tenth-of-a-second plateau was
     * the voice on its way somewhere.  Against a note of its own length, it
     * was a note — that is simply a singer taking the phrase quickly.
     *
     * So each waiting note is measured against the one that resolved it, and
     * anything within a factor of `SLOT_SEARCH_RATIO` is a note and answers
     * its own reference.  Anything far shorter was a search and is dropped —
     * dropped, not scored, because scoring it would spend a reference on a
     * pitch the singer never claimed, and every note after it would be judged
     * against the wrong one.
     *
     * Returns true if the bar ended while flushing.
     */
    const resolveSearches = (againstMs, stillSinging) => {
      const keep = searching;
      searching = [];
      for (const f of keep) {
        if (f.durMs * SLOT_SEARCH_RATIO < againstMs) continue;
        if (answer(f, stillSinging)) return true;
      }
      return false;
    };

    /** Add a note to the waiting list, merging it with the one before it when
     *  they are the same pitch.  A singer wavering on one note produces a
     *  string of short fragments that are not several attempts at several
     *  notes; they are one attempt, and their lengths add up to say so. */
    const pend = (cand) => {
      const prev = searching[searching.length - 1];
      if (prev && Math.abs(prev.midi - cand.midi) * 100 <= SLOT_SAME_NOTE_CENTS) {
        const total = prev.durMs + cand.durMs;
        prev.midi = (prev.midi * prev.durMs + cand.midi * cand.durMs) / total;
        prev.durMs = total;
      } else {
        searching.push(cand);
      }
      excursion = true;
    };

    /**
     * Is this the singer coming back to the note they were already on?
     *
     * A note cannot be repeated without being articulated — that is what makes
     * two of them two.  So a note at the pitch of the answer just given, with
     * nothing but a passing excursion in between, is not a second note: it is
     * the first one, after the singer sagged off it and came back, or hesitated
     * in the middle of it.  It refines the reference it belongs to rather than
     * taking the next one, which is the difference between "you sang 4, then 4
     * again" and "you sang 4".
     *
     * The excursion is what keeps a genuine repeat a repeat: sing the same note
     * twice in a row and there is nothing in between, so this does not fire.
     */
    const continuationOf = (midi) =>
      (lastAnswer && excursion &&
       Math.abs(midi - lastAnswer.midi) * 100 <= SLOT_SAME_NOTE_CENTS)
        ? lastAnswer.index : null;

    /** Re-answer an earlier reference: the singer is still on that note. */
    const refine = (index, midi, durMs, final) => {
      searching = [];
      excursion = false;
      if (lastAnswer && lastAnswer.index === index) lastAnswer.midi = midi;
      if (onNote) onNote(index, { midi, durMs });
      if (final && onNoteDone) onNoteDone(index, { midi, durMs });
    };

    let smoothMidi = targets[0];
    let lastT = null;
    let lastDraw = 0;
    let silentMs = 0;

    return (info) => {
      if (!this.running || done) return;

      const now = (info && info.t != null) ? info.t : performance.now();
      const dt = lastT == null ? 0 : now - lastT;
      lastT = now;
      const usableDt = (dt > 0 && dt < 500) ? dt : 0;

      const midi = (info && info.midi != null) ? info.midi
                 : (info && info.midiRound != null) ? info.midiRound : null;

      if (midi != null) {
        // Smooth the displayed pitch (time-constant ~90 ms) for a calm marker.
        if (usableDt) smoothMidi = smoothMidi + (midi - smoothMidi) * Math.min(1, usableDt / 90);
        else smoothMidi = midi;
        const slot = slotOf(step);
        if (r && slot && now - lastDraw > 60) {   // ~16fps DOM update cap
          r.showSungNote(slot.globalIndex, smoothMidi, targets[step]);
          lastDraw = now;
        }
        if (slotOpenedAt == null) slotOpenedAt = now;
      }

      const note = seg.feed({
        midi,
        onsetStrength: (info && info.onsetStrength) || 0,
        onsetAttack: (info && info.onsetAttack) || 0,
        t: now,
        dt: usableDt,
      });

      // How long the singer has been quiet, so a phrase that simply ends can
      // be settled up rather than leaving its last note waiting to be judged
      // against a note that is never going to come.
      if (midi == null) silentMs += usableDt; else silentMs = 0;

      // --- waiting for the singer to finish the last note --------------------
      // Its reference is already answered; what is left is to let them finish
      // it and to score it from the whole note rather than from the part of it
      // that had been sung when the answer was taken.
      if (finishing >= 0) {
        if (note.ended) { finishBar(note.ended.midi, note.ended.durMs); return; }
        if (!note.open && silentMs >= SLOT_SILENCE_FLUSH_MS) {
          finishBar(note.pitch != null ? note.pitch : note.rough, note.heldMs);
          return;
        }
        if (onNote && note.pitch != null && now - lastReport > 80) {
          lastReport = now;
          onNote(finishing, { midi: note.pitch, durMs: note.heldMs });
        }
        return;
      }

      // --- a sung note finished --------------------------------------------
      // `openAnswered` still belongs to the note that just ended: a note that
      // already answered a reference while it was being held must not answer
      // a second one on its way out.  The flags are reset below, after it has
      // been dealt with, for whatever note started in its place.
      const endedAlreadyAnswered = openAnswered;
      // Recognising the open note as an earlier one still being sung clears
      // the excursion that identified it, so the recognition has to be
      // remembered — otherwise the note answers a fresh reference on its way
      // out, having spent its whole length refining a different one.
      const endedContinues = openContinues;
      if (note.started) { openAnswered = false; openContinues = null; }
      if (note.ended && note.ended.confident && !endedAlreadyAnswered) {
        const cand = {
          midi: note.ended.midi,
          durMs: note.ended.durMs,
          articulated: !!note.ended.articulated,
        };
        const back = endedContinues != null ? endedContinues : continuationOf(cand.midi);
        if (back != null) {
          // The singer never left this note; they wavered inside it.
          refine(back, cand.midi, cand.durMs, true);
        } else if (!note.ended.settled && lastAnswer &&
                   Math.abs(cand.midi - lastAnswer.midi) * 100 <= SLOT_SAME_NOTE_CENTS) {
          // A short note at the pitch of the one just answered.  A note is not
          // repeated by accident — repeating it means articulating it *and*
          // holding it — so this is far more likely the singer wavering inside
          // the note they are on: sagging off it and catching it again,
          // hesitating in the middle of it, losing it for a moment.  It waits,
          // and if they come back it will be recognised as that note
          // continuing rather than as the next one.  A repeat they actually
          // mean is held, and a held note never reaches here.
          pend(cand);
          if (onNote) onNote(step, { midi: cand.midi, durMs: cand.durMs });
        } else if (note.ended.settled || cand.articulated) {
          // A note the singer meant: they held it, or they began it.  Being
          // *begun* is enough on its own, and has to be — a singer detaching
          // short notes means every one of them, and waiting to see what came
          // next before believing any of them would leave the marker a note
          // behind for the whole bar.
          if (resolveSearches(cand.durMs)) return;
          if (answer(cand)) return;
        } else {
          // Neither held nor begun: the voice was somewhere, briefly, and moved
          // on.  That is what a pause on the way to a note looks like, and also
          // what a quick note looks like, and the two are told apart by what
          // the singer does next — so it waits, rather than being spent or
          // thrown away.
          pend(cand);
          if (onNote) onNote(step, { midi: cand.midi, durMs: cand.durMs });
        }
      }

      // --- the note being sung right now ------------------------------------
      if (note.settled && note.pitch != null && !openAnswered) {
        const back = openContinues != null ? openContinues : continuationOf(note.pitch);
        if (back != null) {
          // Still the note before: keep its reference up to date and leave the
          // marker where it is.
          openContinues = back;
          if (now - lastReport > 80) {
            lastReport = now;
            refine(back, note.pitch, note.heldMs, false);
          }
          return;
        }
        // A note the singer is holding.  Anything still waiting that is a
        // fraction of its length was a pause on the way here, and dropping it
        // now — rather than at the end of the note — is what lets the marker
        // find the right reference while they are still singing.
        searching = searching.filter((f) => f.durMs * SLOT_SEARCH_RATIO >= note.heldMs);
        // Report it live so the singer can see they have been heard, and keep
        // refining as they hold.  The marker stays where it is: they are still
        // singing this note, and this is the reference it belongs to.
        if (onNote && now - lastReport > 80) {
          lastReport = now;
          onNote(step, { midi: note.pitch, durMs: note.heldMs });
        }
        // A note held far beyond its own length has nothing left to tell us,
        // and the singer is entitled to see the marker acknowledge it rather
        // than sitting under a fermata until the bar times out.
        if (note.heldMs >= Math.max(SLOT_OVERHOLD_MIN_MS, SLOT_OVERHOLD_PACES * seg.paceMs())) {
          openAnswered = true;
          if (answer({ midi: note.pitch, durMs: note.heldMs }, true)) return;
        }
        return;
      }

      // --- the singer has stopped -------------------------------------------
      if (silentMs >= SLOT_SILENCE_FLUSH_MS && searching.length) {
        // Nothing better is coming.  Everything waiting is a note the singer
        // sang, so it answers its reference — judged against nothing, which
        // keeps all of it.
        if (resolveSearches(0)) return;
      }

      // --- patience ---------------------------------------------------------
      // A voice that never holds still enough to settle must not freeze the
      // exercise.  After a few of this singer's own note-lengths on one
      // reference, the best thing we heard is taken as the answer and the
      // marker moves on: they are audibly singing, and scoring where they
      // actually are beats stopping the bar dead — a stall costs every later
      // note too.  Measured from when the marker arrived at this reference,
      // not from the start of the sound, so a slot that opened mid-phrase
      // still gets its full share of patience.
      if (slotOpenedAt != null && now - slotOpenedAt >= tuning().patiencePaces * seg.paceMs()) {
        if (searching.length) {
          const longest = searching.reduce((a, b) => (b.durMs > a.durMs ? b : a));
          searching = [];
          if (answer(longest)) return;
        } else if (note.rough != null && !openAnswered) {
          openAnswered = true;
          if (answer({ midi: note.rough, durMs: note.heldMs }, note.open)) return;
        }
      }
    };
  }


  /**
   * Score a bar from the notes captured live, one per reference note.
   *
   * Because each sung note was committed against a known reference slot there
   * is nothing left to align: the pairing is positional by construction, so
   * no DTW pass and no pruning of "seeking stabs" is needed (a stab never gets
   * committed in the first place — it does not survive the hold gate).
   * Reference notes the singer never reached (they pressed Done, or the safety
   * cap fired) score 0 and are shown as missing.
   */
  _scoreCapturedBar(barIndex, ref, captured) {
    if (!this.running) return;
    const perNote = ref.map((refMidi, i) => {
      const c = captured && captured[i];
      if (!c) return { sung: null, ref: refMidi, cents: null, score: 0, missing: true };
      const cents = (c.midi - refMidi) * 100;
      return { sung: c.midi, ref: refMidi, cents, score: noteScoreFor(c.midi, refMidi), missing: false };
    });
    const score = perNote.length
      ? Math.round(perNote.reduce((a, p) => a + p.score, 0) / perNote.length)
      : 0;
    // Final, authoritative pass over the stave: every reference note gets the
    // score it ended up with, including ones the singer never reached (which
    // the live colouring never sees, because they had no note to finish).
    const slots = (this.renderer && this.renderer.getPitchedNotesInBar)
      ? this.renderer.getPitchedNotesInBar(barIndex) : [];
    perNote.forEach((p, i) => this._markNoteAccuracy(slots, i, p.missing ? null : p.score));
    this.scores.push(score);
    this._renderScore(); this._renderProgress();
    this._feedback({
      score, verdict: scoreLabel(score),
      head: "Bar " + (barIndex + 1) + " singing",
      detail: score + "/100",
      extra: '<div class="sn-row">' + perNote.map(noteCellHTML).join("") + "</div>",
    });
    this._setLegend("Bar score: " + score);
    this._advanceAfter(1200);
  }

  /** Colour one reference note on the stave by its accuracy.  `slots` is the
   *  bar's pitched-note list from the renderer (reference index -> stave slot). */
  _markNoteAccuracy(slots, i, score) {
    const slot = slots && slots[i];
    if (!slot || !this.renderer || !this.renderer.setNoteAccuracy) return;
    this.renderer.setNoteAccuracy(slot.globalIndex, score);
  }

  /** Live per-note strip shown in the prompt while the bar is being sung, so
   *  the singer sees each note score land as they move through the bar. */
  _renderLiveStrip(ref, captured, activeIdx) {
    const cells = ref.map((refMidi, i) => {
      const c = captured && captured[i];
      if (!c) {
        const cls = i === activeIdx ? "sn-cell pending active" : "sn-cell pending";
        return "<span class='" + cls + "'>" + midiToName(refMidi) + "</span>";
      }
      return noteCellHTML({ sung: c.midi, ref: refMidi, score: noteScoreFor(c.midi, refMidi) });
    }).join("");
    this._prompt("Sing it — <b>" + (this.round + 1) + "/" + this.order.length +
      "</b> · each note scores as soon as you hold it" +
      "<div class='sn-row'>" + cells + "</div>");
    // The Done button lives inside the prompt, so a re-render drops it.
    if (this._doneFinish) this._showDoneButton(this._doneFinish);
  }

  /**
   * Detach the live recorder: stop feeding pitch frames to the round's
   * callbacks, drop the safety timer, and clear the sung-pitch marker.  Called
   * whenever a round ends — including when it ends *early* because the live
   * capture already collected every note it needed.
   */
  _stopRecording() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this.detector) this.detector.onPitch = () => {};
    this._hideDoneButton();
    if (this.renderer && this.renderer.clearSungNote) this.renderer.clearSungNote();
  }

  /** Record for a fixed window.  Every frame is forwarded to `onPitch`,
   *  unvoiced ones included — the live capture needs to see silence to know a
   *  note was released. */
  _recordNotes(ms, onDone, onPitch) {
    const token = this._roundToken;
    if (!this.detector || !this.detector.isRunning) {
      this._ensureMic().then(() => this._recordNotes(ms, onDone, onPitch)).catch((e) => {
        if (token !== this._roundToken) return;
        // Don't hand back an empty take: that scores zero and advances, which
        // walks the whole exercise without the student singing a note.
        this._feedback({ score: 0, verdict: "—", head: "Mic unavailable", detail: e.message });
        this.stopSession();
      });
      return;
    }
    const frames = [];
    const start = performance.now();
    this.detector.onPitch = (info) => {
      if (!this.running || token !== this._roundToken) return;
      if (onPitch) onPitch(info);
    };
    const finish = () => {
      this._timer = null;
      if (token !== this._roundToken) return;
      this._stopRecording();
      onDone();
    };
    this._timer = setTimeout(finish, ms);
  }

  /**
   * Record singing with no fixed time limit.  The round normally ends by
   * itself the moment the live capture has an attempt for every reference
   * note (it calls `_doneFinish`); the "Done" button is the escape hatch for a
   * singer who wants to stop early, and the safety cap keeps an abandoned
   * session bounded.  Used by the non-timed singing modes (2, 5).
   */
  _recordNotesUntilDone(maxMs, onDone, onPitch) {
    const token = this._roundToken;
    const start = performance.now();
    const begin = () => {
      this.detector.onPitch = (info) => {
        if (!this.running || token !== this._roundToken) return;
        if (onPitch) onPitch(info);
      };
      const finish = () => {
        if (token !== this._roundToken) return;
        this._stopRecording();
        onDone();
      };
      // Safety cap.
      this._timer = setTimeout(finish, maxMs);
      // Done button (escape hatch) — also the hook the live capture calls to
      // end the bar as soon as the last note has been sung.
      this._doneFinish = finish;
      this._showDoneButton(finish);
    };
    if (!this.detector || !this.detector.isRunning) {
      this._ensureMic().then(() => { this._recordNotesUntilDone(maxMs, onDone, onPitch); }).catch((e) => {
        if (token !== this._roundToken) return;
        this._feedback({ score: 0, verdict: "—", head: "Mic unavailable", detail: e.message });
        this.stopSession();
      });
      return;
    }
    begin();
  }

  _showDoneButton(onClick) {
    const rep = this.info.querySelector("#d-prompt");
    if (!rep) return;
    let btn = this.info.querySelector("#d-done");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "d-done";
      btn.className = "btn btn-primary";
      btn.innerHTML = glyph("check", 14) + "<span>Score now</span>";
      rep.appendChild(btn);
    }
    btn.disabled = false;
    btn.onclick = () => { btn.disabled = true; onClick(); };
  }

  _hideDoneButton() {
    const btn = this.info.querySelector("#d-done");
    if (btn) btn.remove();
    this._doneFinish = null;
  }

  // ---- feedback card ------------------------------------------------------

  _feedback({ score, verdict, head, detail, extra }) {
    const cls = score >= 70 ? "good" : score >= 40 ? "ok" : "weak";
    this._report(
      '<div class="fb fb-' + cls + '">' +
        '<div class="fb-score">' +
          '<div class="fb-ring ' + cls + '">' +
            '<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="17" class="fb-r-bg"></circle>' +
            '<circle cx="20" cy="20" r="17" class="fb-r-fg" style="stroke-dasharray:' + (2 * Math.PI * 17) + ";stroke-dashoffset:" + (2 * Math.PI * 17 * (1 - score / 100)) + '"></circle></svg>' +
            '<span class="fb-r-val">' + score + "</span>" +
          "</div>" +
          '<div class="fb-verdict ' + cls + '">' + verdict + "</div>" +
        "</div>" +
        '<div class="fb-body">' +
          '<div class="fb-head">' + head + "</div>" +
          (detail ? '<div class="fb-detail">' + detail + "</div>" : "") +
          (extra || "") +
        "</div>" +
      "</div>"
    );
  }

  // ---- replay (browse answers) -------------------------------------------

  _replayAnswer() {
    if (this._lastAnswerBar == null) return;
    this._playBar(this._lastAnswerBar);
  }

  // ---- round advancement ---------------------------------------------------

  _advanceAfter(ms) {
    if (!this.running) return;
    this._loopTimer = setTimeout(() => this._advance(), ms);
  }

  _advance() {
    if (!this.running) return;
    this.round += 1;
    this._nextRound();
  }

  _onBarClick(idx) {
    // A round is waiting for an answer (the guessing modes): the click is the
    // answer, not a request to start something.
    if (this._clickGuard) { this._clickGuard(idx); return; }
    if (!this.mode) return;
    // Listening: a bar click just plays that bar and moves the progress on.
    if (this.mode.key === "listen") { this._listenClick(idx); return; }
    // A round is mid-flight (playing back, or recording a sung bar): ignore
    // stray clicks rather than restarting underneath the user.
    if (this.running) return;
    // Otherwise the click starts that one bar as a one-round exercise.
    this.startSingle(idx);
  }

  /** Manual bar click in listening mode: play it and advance the round
   *  progress by one for every unique bar played (matching the sequential
   *  behaviour, where each bar moves the progress one step forward). */
  _listenClick(barIndex) {
    if (barIndex == null || !this.barSteps[barIndex]) return;
    if (!this._playedBars) this._playedBars = new Set();
    const wasNew = !this._playedBars.has(barIndex);
    this._playedBars.add(barIndex);
    if (wasNew) {
      const total = this._sessionTotal();
      this.round = Math.min(this._playedBars.size, total);
    }
    this._renderProgress();
    this._playBar(barIndex);
  }
}

// ---------------------------------------------------------------------------
// Note segmentation
// ---------------------------------------------------------------------------
//
// Turns a stream of pitch frames into sung notes.  Three ideas carry it:
//
// 1. EVIDENCE, NOT VERDICTS.  A note boundary is not one test passing.  The
//    detector reports how strongly the audio was articulated (a number, not a
//    yes), the pitch reports how far it has moved beyond what this note's own
//    vibrato explains, and the two accumulate.  A boundary happens when the
//    evidence adds up.  A single frame's opinion decides nothing, which is what
//    stops one loud consonant — or one wide vibrato peak — from cutting a note
//    in half.
//
// 2. A LOCK RESISTS.  The longer and more consistently a pitch has been held,
//    the more evidence it takes to end it.  This is the deliberate coupling
//    between locking, vibrato and onset strength: inside a firmly held note we
//    are entitled to be sceptical of a weak articulation, because we know what
//    we are listening to.  Inside an unsettled one we should believe it
//    quickly, because we do not.
//
// 3. A HELD NOTE IS AN ANSWER; A TOUCHED ONE IS A SEARCH.  Every note the
//    segmenter finds is reported, but it also says whether the singer *held*
//    it and whether they *began* it, because a student who cannot yet hear the
//    interval slides towards it and pauses on the way — and none of those
//    pauses is their answer.  What the exercise does with that is in
//    `_makeLiveCapture`; what belongs here is measuring it honestly.
//
// 4. THE SINGER SETS THE TEMPO, NOT THE SCORE.  Every duration here scales
//    with `pace` — a running median of the notes this singer has actually sung.
//    The written note length only seeds it.  Sight-singing is not a rhythm
//    test: singing the phrase half as fast must work exactly as well, and when
//    the thresholds came from the written tempo it did not.
const SEG_TOL_BASE_CENTS = 42;      // how far a steady note may wander and still be itself
const SEG_TOL_MAX_CENTS = 95;       // never as far as a semitone, or a wrong note reads as the right one
const SEG_TOL_VIB_MARGIN = 18;      // headroom above measured vibrato width
const SEG_FOLLOW_LIMIT_CENTS = 35;  // how far a locked pitch may track the voice
// How much extra evidence it takes to end a note, on top of the base 1.0.
// Both are measured, not guessed — rea/tests/audio/strength.mjs reports the
// accumulated evidence at real boundaries against the worst false peak:
//
//                       real boundary   worst false
//   steady voice ......... 1.49 - 2.19      0.86
//   voice in vibrato ..... 2.52             1.27
//
// So a steady note can be broken at 1.0 with room on both sides, while a voice
// in vibrato needs a higher bar — vibrato is a genuine spectral disturbance and
// it is the only thing that comes close to looking like an articulation.  This
// is the coupling that matters: the pitch tells us whether to believe the
// spectrum.
const SEG_LOCK_RESISTANCE = 0.2;    // ...per unit of lock confidence
const SEG_VIB_RESISTANCE = 0.35;    // ...while the voice is in vibrato
// ...and again once the note is *settled* — held long enough to be an answer
// rather than a place the voice passed through.  A settled note is the one
// thing in this whole file we are genuinely sure about, and breaking it on
// thin evidence is what "it drifts off the note" felt like.
const SEG_SETTLED_RESISTANCE = 0.1;
// Short, because an articulation is a burst and vibrato is a stream.  Summing
// over a longer window gathers more of the burst but proportionally more of the
// stream too, and past ~70 ms vibrato overtakes real onsets outright.
const SEG_ONSET_DECAY_MS = 55;      // an articulation's evidence fades over this
// How much of this singer's measured sustain activity to add to the bar, and
// how far that may ever raise it.  Capped, because a bad measurement must not
// be able to make the exercise unresponsive — the worst a wrong profile can do
// is ask for a little more evidence than necessary.
const SEG_PROFILE_FLOOR_WEIGHT = 0.8;
const SEG_PROFILE_FLOOR_MAX = 0.5;
const SEG_RELEASE_TRIM_MS = 60;     // drop the slide *out* of a note before scoring it
const SEG_VIB_WINDOW_MS = 450;      // window the vibrato estimate is made over
const SEG_VIB_MIN_HZ = 3.5;         // slower than this is drift, not vibrato
const SEG_VIB_MAX_HZ = 9;           // faster is jitter
const SEG_VIB_MIN_CENTS = 12;       // narrower than this needs no allowance
const SEG_VIB_MAX_CENTS = 130;      // wider than this is not vibrato, it is two notes
const SEG_VIB_DEADBAND_CENTS = 4;   // ignore crossings this small when counting rate
const SEG_NOTE_MIN_SPAN_MS = 55;    // steady pitch this long is a note, however short
// --- settling: the difference between an answer and a search ---------------
//
// A student who does not yet hear the note hunts for it: the voice slides, and
// on the way it pauses — a tenth of a second here, two on the way past there.
// Every one of those pauses is a steady pitch, and the old segmenter called
// each of them a note.  The exercise then spent a reference slot on each, so a
// singer working out the interval had used up half the bar before they sang
// anything they meant.  That is the whole of "it moves too fast over the notes
// and never gives me a chance to hit them".
//
// Settling is the test that separates the two.  A note is *settled* when the
// singer has held it — not merely touched it — for long enough that it reads
// as a decision.  Only a settled note is an answer.  Everything shorter is
// still a note as far as the segmenter is concerned (it is reported, it can be
// scored, a singer who only ever stabs is not left with nothing), but the
// exercise will not move on for it.
//
// The threshold is a fraction of this singer's own pace, because "held" only
// means anything relative to how they are singing: half a second is a hold in
// a slow exercise and a whole note in a fast one.  The floor is what stops a
// wound-down pace from making everything count again.
const SEG_SETTLE_FRACTION = 0.5;
const SEG_SETTLE_MIN_MS = 190;
const SEG_SETTLE_MAX_MS = 620;
// --- departure: leaving a note means arriving at another -------------------
//
// Distance from the note is not evidence of having left it.  A singer sliding
// between two notes is far from both for the whole of the slide; so is one
// wobbling with doubt, or scooping, or letting a vowel change pull the pitch.
// Counting that distance as departure ended the note in the middle of the
// glide and invented a note out of the journey.
//
// What actually says a note is over is *arrival*: the voice has stopped
// somewhere else.  So departure only accrues while the last breath of pitch is
// itself coherent — a short window whose own spread is inside the tolerance.
// Mid-slide the window is wide and nothing accrues; the moment the singer
// lands, it collapses and the boundary follows within a frame or two.
const SEG_ARRIVE_WINDOW_MS = 100;
const SEG_ARRIVE_MIN_FRAMES = 3;
// The level attack, in dB of fast envelope over slow, above which the singer
// began something — whatever the spectrum did.
//
// Small, and deliberately so.  This is a *difference* between a 25 ms envelope
// and a 180 ms one, which sits at zero through a sustained line however loud
// it is; it only departs from zero when the level actually changes shape.  The
// figures it separates (rea/tests/audio/articulation.mjs):
//
//   re-articulated note, no gap ..... 0.29 - 0.54 dB
//   note begun after silence ........ (reported at full strength)
//   legato slide to another pitch ... 0.06 - 0.10 dB
//   pause on the way to a note ...... 0.06 - 0.10 dB
//
// A factor of three or so between them, so the threshold sits in the middle
// rather than against either side.  A real voice articulates far more plainly
// than the synthesised singing these come from — a consonant, a breath, a
// glottal attack all move the level several dB — so the margin in practice is
// wider than the one it is set from, and the failure it can still make is the
// safe one: a note read as begun when it was only slid into is answered
// promptly, which is what the exercise did for every note before any of this.
const ONSET_ARTICULATION_DB = 0.25;
// How much of a note's opening counts as its attack.  Long enough for the
// level to catch up with the spectrum — the envelopes need a few tens of
// milliseconds — and short enough that a crescendo through the note is not
// mistaken for one.
const SEG_ARTICULATION_WINDOW_MS = 140;
const SEG_ATTACK_SKIP_FRACTION = 0.35;  // ...of the note so far, when that is less
const SEG_PACE_MIN_MS = 180;
const SEG_PACE_MAX_MS = 1600;

/** Median of an array of numbers (copies; the caller's order is preserved). */
function medianOf(values) {
  if (!values.length) return null;
  const v = values.slice().sort((a, b) => a - b);
  return v[(v.length - 1) >> 1];
}

/** Value at a percentile of an already-sorted array. */
function percentileOf(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

const segClamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Segment a stream of pitch frames into sung notes.
 *
 * Exported for testing: pure state over a frame stream, so it can be driven
 * from synthesised singing without a microphone (see rea/tests/audio).
 *
 * `feed({ midi, onsetStrength, t, dt })` returns what happened this frame:
 *   ended   — the note that just finished: { midi, durMs, startT }.  Its pitch
 *             is measured over the note's *body*, with the attack and the slide
 *             out trimmed off, so a singer is scored on the note they sang.
 *   started — a new note began on this frame.
 *   pitch   — the open note's locked pitch, or null before it locks.
 *   locked  — the pitch has been held long enough to be trusted.  Nothing
 *             should be scored before this.
 *   rough   — best estimate regardless of lock, for the caller's stall guard.
 */
export function makeNoteSegmenter(opts) {
  const o = opts || {};
  // Seeded from the written tempo, then overtaken by what the singer does.
  //
  // Pace is measured between note *starts*, not from how long notes sound.
  // Sounding length confuses articulation with tempo: sing the same phrase
  // staccato and every note is short while the tempo has not changed at all.
  // Taking durations for tempo made a detached phrase look twice as fast as it
  // was, which shrank every threshold that scales with pace and left short
  // notes failing the test for being notes at all.
  let pace = segClamp(o.paceMs || 450, SEG_PACE_MIN_MS, SEG_PACE_MAX_MS);
  // The singer's own measurements from the soundcheck, when there are any.
  // Both are advisory: absent, the defaults below apply and everything works.
  const profileVibratoCents = Math.max(0, o.vibratoCents || 0);
  const profileOnsetFloor = Math.max(0, o.onsetFloor || 0);
  const intervals = [];      // note-start to note-start
  const durations = [];      // fallback until two notes have been sung
  let lastNote = null;       // { startT, confident } of the note before this one

  let startT = null;
  let samples = [];          // { t, midi } after the attack window
  let centre = null;         // the locked pitch
  let locked = false;
  let lockedAt = 0;
  let settledAt = null;      // when the note became an answer rather than a search
  // Why the note now open began: "silence" is the singer starting to sing,
  // which is deliberate beyond argument, and "boundary" is everything else —
  // a boundary the evidence carried, which is as true of a new note as it is
  // of a pause on the way to one.  For those, the level decides (below).
  let openReason = "silence";
  // The strongest level attack in the opening of the note now being sung.
  //
  // Asked at the note's *start* this is always zero: the spectrum changes on
  // the transient itself while the level takes a few tens of milliseconds to
  // rise, so a boundary judged at the instant it fires sees no attack even
  // when the singer plainly made one.  Judged over the note's opening it sees
  // the whole gesture, which is the honest question — did this note begin, or
  // did the segmenter just find the voice somewhere else.
  let openAttackDb = 0;
  let onsetEvidence = 0;     // decaying sum of articulation strength
  let departureMs = 0;       // time spent beyond what vibrato explains
  let silentMs = 0;
  let lastVoicedT = null;
  let rough = null;          // best pitch estimate even before the note locks
  let vib = { present: false, halfWidth: 0, rateHz: 0 };

  // --- timings, all derived from the singer's own pace ---------------------
  const attackSkipMs = () => segClamp(0.12 * pace, 45, 120);
  /**
   * How much of the start of this note to ignore when measuring its pitch.
   *
   * Bounded by a fraction of the note *so far*, not just by the pace.  A fixed
   * 60 ms skip is nothing in a held note and most of a staccato one: at 140 ms
   * it left 67 ms of body, three milliseconds under the threshold for counting
   * as a note at all — so the first note of a detached phrase was silently
   * dropped and every slot after it was scored against the wrong reference.
   * A singer articulating a short note does not spend as long arriving at it.
   */
  const skipMs = (t) => Math.min(attackSkipMs(), SEG_ATTACK_SKIP_FRACTION * Math.max(0, t - startT));
  /** The note's samples, with its attack excluded. */
  const body = (t) => {
    const from = startT + skipMs(t);
    const b = samples.filter((x) => x.t >= from);
    return b.length >= 3 ? b : samples;
  };
  const settleWindowMs = () => segClamp(0.5 * pace, 180, 420);
  // Locking says the pitch estimate can be trusted.  It is not permission to
  // move the marker on: that waits for the note to end — see `settleMs`, and
  // the slot policy in `_makeLiveCapture`.
  const lockMs = () => segClamp(0.32 * pace, 110, 400);
  // Anti-double-trigger only — deliberately capped well below a note length.
  // Its job is to stop a cluster of onsets, or a glide's worth of them, from
  // splitting one note; it is the *evidence* requirement that decides whether a
  // boundary is real.  Scaling it up with pace made the exercise sluggish
  // exactly when a singer changed tempo: after one slow note, a boundary could
  // not even be considered for 450 ms, so two quick notes went by before the
  // marker noticed the first had ended.
  const minSegmentMs = () => segClamp(0.35 * pace, 150, 320);
  const confirmMs = () => segClamp(0.26 * pace, 100, 240);
  // How much silence ends a note.  Generous, because it is not the only way a
  // note can end: a re-articulated repeat is caught by its onset, so the gap
  // does not have to be tight enough to catch one on its own.  What it does
  // have to survive is the voice: an unvoiced consonant, a quick breath, a
  // frame or two the tracker loses on a vowel change.  At the old 110 ms floor
  // any of those cut the note in half, which the exercise then read as the
  // singer having moved on.  A breath is around a tenth of a second, and by
  // the time it has been through a 2048-sample window it looks like rather
  // more, so the floor has to sit well clear of it.
  const gapMs = () => segClamp(0.35 * pace, 240, 400);
  /** How long a note must be held before it counts as an answer. */
  const settleMs = () =>
    segClamp(SEG_SETTLE_FRACTION * pace, SEG_SETTLE_MIN_MS, SEG_SETTLE_MAX_MS);

  /** Vibrato over the tail of the open note: how wide, and how fast. */
  const estimateVibrato = (t) => {
    const win = body(t).filter((x) => x.t >= t - SEG_VIB_WINDOW_MS);
    if (win.length < 6) return { present: false, halfWidth: 0, rateHz: 0 };
    const spanMs = win[win.length - 1].t - win[0].t;
    if (spanMs < 120) return { present: false, halfWidth: 0, rateHz: 0 };
    const mid = medianOf(win.map((x) => x.midi));
    const devs = win.map((x) => (x.midi - mid) * 100);
    const sorted = devs.slice().sort((a, b) => a - b);
    const halfWidth = (percentileOf(sorted, 0.9) - percentileOf(sorted, 0.1)) / 2;
    // Rate from sign changes, with a deadband so noise around the centre does
    // not read as a very fast wobble.
    let crossings = 0, last = 0;
    for (const d of devs) {
      const sign = d > SEG_VIB_DEADBAND_CENTS ? 1 : d < -SEG_VIB_DEADBAND_CENTS ? -1 : 0;
      if (sign !== 0) { if (last !== 0 && sign !== last) crossings++; last = sign; }
    }
    const rateHz = (crossings / 2) / (spanMs / 1000);
    const present = rateHz >= SEG_VIB_MIN_HZ && rateHz <= SEG_VIB_MAX_HZ &&
                    halfWidth >= SEG_VIB_MIN_CENTS && halfWidth <= SEG_VIB_MAX_CENTS;
    return { present, halfWidth, rateHz };
  };

  /** How far the voice may sit from the locked pitch and still be this note. */
  const tolerance = () => {
    // The floor is this singer's measured vibrato, so the first note of a bar
    // is judged by their voice rather than by an average of everyone's.  The
    // live estimate needs the better part of a note before it means anything,
    // and the first note is exactly where too tight a tolerance does its
    // damage — one wobble reads as a move, and the bar starts out misaligned.
    const base = profileVibratoCents > 0
      ? Math.min(SEG_TOL_MAX_CENTS, Math.max(SEG_TOL_BASE_CENTS, profileVibratoCents * 1.35 + SEG_TOL_VIB_MARGIN))
      : SEG_TOL_BASE_CENTS;
    if (!vib.present) return base;
    return Math.min(SEG_TOL_MAX_CENTS, Math.max(base, vib.halfWidth * 1.35 + SEG_TOL_VIB_MARGIN));
  };

  /** 0..1 — how much this note has earned the benefit of the doubt. */
  const lockConfidence = (t) => {
    if (!locked) return 0;
    return segClamp((t - lockedAt) / (2 * lockMs()), 0, 1);
  };

  /**
   * The note's pitch: the median of the part where the voice was actually on
   * the note.
   *
   * Trimming a fixed number of milliseconds off each end is not enough — a
   * legato slide into a note can run 120 ms, and whatever of it survives the
   * trim drags the median toward the note before.  So once the note has a
   * locked centre, the body is the samples sitting within tolerance of it: the
   * slide in and the slide out exclude themselves, at whatever speed the singer
   * took them.  A singer is scored on the note they sang, not on the way into
   * or out of it.
   */
  const bodyPitch = () => {
    if (!samples.length) return centre;
    const all = body(lastVoicedT != null ? lastVoicedT : samples[samples.length - 1].t);
    const last = all[all.length - 1].t;
    let use = all.filter((x) => x.t <= last - SEG_RELEASE_TRIM_MS);
    if (use.length < 3) use = all;
    if (centre != null) {
      const tol = tolerance();
      const onNote = use.filter((x) => Math.abs(x.midi - centre) * 100 <= tol);
      if (onNote.length >= 3) use = onNote;
    }
    return medianOf(use.map((x) => x.midi));
  };

  /**
   * Was that a sung note, or a glance across a pitch on the way somewhere else?
   *
   * Steadiness, not length.  Tying this to a duration threshold rejected
   * staccato outright — a deliberate short note is every bit as much a note as
   * a held one, and a singer detaching their notes was left with nothing
   * scored at all.  A hunting stab is unsteady, which is the thing worth
   * testing, and it stays unsteady however long it lasts.
   */
  const wasSung = () => {
    if (locked) return true;
    const b = body(lastVoicedT != null ? lastVoicedT : 0);
    if (b.length < 3) return false;
    const span = b[b.length - 1].t - b[0].t;
    if (span < SEG_NOTE_MIN_SPAN_MS) return false;
    const med = medianOf(b.map((x) => x.midi));
    const spread = medianOf(b.map((x) => Math.abs(x.midi - med) * 100));
    return spread <= tolerance();
  };

  const close = (t) => {
    if (startT == null) return null;
    const wasLocked = locked;
    const wasSettled = settledAt != null;
    const confident = wasSung();
    const noteStart = startT;
    const midi = bodyPitch();
    const durMs = (lastVoicedT != null ? lastVoicedT : t) - startT;
    const reason = openReason;
    const attack = openAttackDb;
    startT = null; samples = []; centre = null; locked = false; rough = null;
    settledAt = null;
    onsetEvidence = 0; departureMs = 0;
    vib = { present: false, halfWidth: 0, rateHz: 0 };
    // A fragment that was never steady enough to be a note is not one: the
    // tail of a release, a click, half a frame of something.  Reporting it as
    // an ended note leaves every caller to re-derive whether to believe it.
    if (midi == null || !confident) return null;
    // Only a note the singer *meant* teaches us about their pace: one they
    // held, or one they began.  Every threshold here scales with pace, so
    // letting a fragment lower it is a feedback loop — shorter pace, shorter
    // thresholds, more fragments — and the exercise winds itself up until it
    // is racing.  A pause on the way to a note is the clearest case: it is
    // short by definition, and letting it set the tempo made the exercise
    // impatient with the very hunting it is supposed to wait through.
    if (confident && (wasSettled || reason === "silence" || attack >= ONSET_ARTICULATION_DB)) {
      lastNote = { startT: noteStart, confident: true };
      durations.push(durMs);
      if (durations.length > 4) durations.shift();
      // Until two notes have been sung there is no interval to measure, so the
      // first note's own length stands in — better than the written tempo, and
      // replaced by a real interval as soon as there is one.
      if (!intervals.length) {
        pace = segClamp(medianOf(durations), SEG_PACE_MIN_MS, SEG_PACE_MAX_MS);
      }
    }
    // `settled` is what the exercise reads: this was a note the singer held,
    // not one they passed through on the way to it.  Only a settled note moves
    // the marker on — see `_makeLiveCapture`.
    return {
      midi, durMs, startT: noteStart, locked: wasLocked, confident,
      settled: wasSettled,
      // Deliberate: the singer began this note, rather than the segmenter
      // finding them somewhere new.  Starting to sing is beyond argument; so
      // is a note whose opening carries a real rise in level.  A boundary with
      // no such rise behind it is the voice having moved, which is as true of
      // a pause on the way to a note as of a note.
      articulated: reason === "silence" || attack >= ONSET_ARTICULATION_DB,
    };
  };

  const open = (t, reason) => {
    openReason = reason || "pitch";
    // The interval since the previous note began: this is the tempo, and it is
    // known here — at the new note's start — rather than at its end, so the
    // note being opened is already judged at the right pace.
    if (lastNote && lastNote.confident) {
      const ioi = t - lastNote.startT;
      if (ioi > 0) {
        intervals.push(segClamp(ioi, SEG_PACE_MIN_MS, SEG_PACE_MAX_MS));
        if (intervals.length > 4) intervals.shift();
        pace = segClamp(medianOf(intervals), SEG_PACE_MIN_MS, SEG_PACE_MAX_MS);
      }
    }
    startT = t; samples = []; centre = null; locked = false; rough = null;
    settledAt = null;
    onsetEvidence = 0; departureMs = 0; openAttackDb = 0;
    vib = { present: false, halfWidth: 0, rateHz: 0 };
  };

  return {
    pitch: () => centre,
    paceMs: () => pace,
    settleMs,
    reset: () => {
      startT = null; samples = []; centre = null; locked = false; settledAt = null;
      onsetEvidence = 0; departureMs = 0; silentMs = 0; lastVoicedT = null;
      durations.length = 0;
    },

    feed(f) {
      const t = f.t;
      const dt = f.dt > 0 && f.dt < 500 ? f.dt : 0;
      const midi = f.midi;
      const strength = f.onsetStrength || 0;
      const out = {
        ended: null, started: false, pitch: centre, rough: null, open: startT != null,
        locked: false, settled: false, stable: false, heldMs: 0, vibrato: vib.present,
      };

      if (midi == null) {
        silentMs += dt;
        if (silentMs >= gapMs() && startT != null) out.ended = close(t);
        out.pitch = centre;
        out.open = startT != null;
        return out;
      }
      silentMs = 0;
      lastVoicedT = t;

      // --- accumulate the evidence for ending the open note ----------------
      // Sound after silence needs no argument: the singer has started.
      let begin = startT == null;
      let beginReason = "silence";
      if (!begin) {
        const age = t - startT;
        const tol = tolerance();

        // Has the voice arrived, or is it still travelling?
        //
        // A voice in transit is far from the note it left and far from the one
        // it is going to, and for the whole of that journey it is also
        // *incoherent* — spread across the ground it is covering.  Both halves
        // of the evidence below depend on knowing which of the two it is
        // doing, so it is asked once, first.
        const arrWin = samples.filter((x) => x.t >= t - SEG_ARRIVE_WINDOW_MS);
        let arrived = false;
        if (arrWin.length >= SEG_ARRIVE_MIN_FRAMES) {
          const am = medianOf(arrWin.map((x) => x.midi));
          const aspread = medianOf(arrWin.map((x) => Math.abs(x.midi - am) * 100));
          arrived = aspread <= tol;
        }

        // Articulation evidence decays, so a burst smeared across two or three
        // frames adds up to one onset while two unrelated flickers a beat apart
        // do not.
        //
        onsetEvidence *= Math.exp(-(dt || 0) / SEG_ONSET_DECAY_MS);
        if (age >= minSegmentMs()) onsetEvidence += strength;

        // Pitch evidence: distance beyond what this note's own vibrato explains.
        //
        // The reference falls back to the running median, not to this frame's
        // own pitch.  Comparing the pitch against itself can never register a
        // move, so a note that never locked — a fast one, where there is barely
        // time to — could be left open indefinitely while the singer moved on
        // through two more.
        const ref = centre != null ? centre : (rough != null ? rough : midi);
        const away = Math.abs(midi - ref) * 100 - tol;
        // Distance only counts once the voice has stopped travelling: the
        // moment a singer lands, the window collapses and the boundary follows
        // within a frame or two, while mid-slide nothing accrues at all.
        if (away > 0 && arrived) {
          // A bigger move is worth more per unit time than a marginal one.
          departureMs += (dt || 0) * segClamp(away / tol, 0.5, 2.5);
        } else if (away <= 0) {
          departureMs = Math.max(0, departureMs - (dt || 0) * 2);
        }

        const evidence = onsetEvidence + departureMs / confirmMs();
        // A firmly locked note demands more before it will be broken, and a
        // voice in vibrato more again.
        // ...plus whatever this voice and room throw off while merely holding a
        // note.  Measured in the soundcheck: a breathy voice or a live room
        // produces articulation-like evidence continuously, and asking for a
        // fixed amount above zero means asking too little of one singer and too
        // much of another.
        const needed = 1
          + SEG_LOCK_RESISTANCE * lockConfidence(t)
          + (settledAt != null ? SEG_SETTLED_RESISTANCE : 0)
          + (vib.present ? SEG_VIB_RESISTANCE : 0)
          + Math.min(SEG_PROFILE_FLOOR_MAX, profileOnsetFloor * SEG_PROFILE_FLOOR_WEIGHT);
        if (evidence >= needed && age >= minSegmentMs()) {
          begin = true;
          // Which cue carried it — because the exercise treats a note the
          // singer *began* differently from one the segmenter merely found
          // them at.  A legato slide sweeps every harmonic across the spectrum
          // and reads as strongly as a consonant does, so asking only whether
          // the articulation evidence cleared 1.0 called every slide
          // deliberate.  Comparing the two is the honest question.
          beginReason = "boundary";
        }
      }

      if (begin) {
        out.ended = close(t);
        open(t, beginReason);
        out.started = true;
      }

      // --- measure the open note -------------------------------------------
      // The opening of a note is where its articulation shows, so watch the
      // level for that long and no longer: a swell in the middle of a held
      // note is expression, not a new note beginning.
      if (t - startT <= SEG_ARTICULATION_WINDOW_MS) {
        const a = f.onsetAttack || 0;
        if (a > openAttackDb) openAttackDb = a;
      }
      samples.push({ t, midi });
      const winStart = t - settleWindowMs();
      const win = body(t).filter((x) => x.t >= winStart);
      if (win.length >= 3) {
        const span = win[win.length - 1].t - win[0].t;
        const med = medianOf(win.map((x) => x.midi));
        out.rough = med;
        rough = med;
        vib = estimateVibrato(t);
        const spread = medianOf(win.map((x) => Math.abs(x.midi - med) * 100));
        const tol = tolerance();
        if (span >= lockMs() && spread <= tol) {
          out.stable = true;
          if (!locked) { locked = true; lockedAt = t; centre = med; }
          else {
            // Bounded follow, and it tightens as the note establishes itself.
            // It has to follow at first — a scooped attack means the pitch at
            // the start of a note is not the note.  But a note the singer has
            // settled on is the one thing here we are sure of, and letting its
            // centre keep wandering blurs both the pitch it is finally scored
            // at and the question of whether the voice has left it.  So the
            // allowance shrinks to a quarter once the note is settled: enough
            // for drift, not enough to walk.
            const settledNow = settledAt != null;
            const lim = (SEG_FOLLOW_LIMIT_CENTS / 100) * (settledNow ? 0.25 : 1);
            const delta = segClamp(med - centre, -lim, lim);
            centre += delta * Math.min(1, (dt || 16) / (settledNow ? 420 : 260));
          }
          // Held, steadily, for long enough to be a decision rather than a
          // place the voice went past.  Both halves matter: the lock says the
          // pitch is steady, the elapsed time says it was held.  Measuring the
          // hold from the note's start rather than from the lock keeps this
          // reachable at speed — at a fast pace a note is barely longer than
          // the lock takes, and requiring a further hold on top of it would
          // mean nothing ever settled and the exercise never moved.
          if (settledAt == null && locked && t - startT >= settleMs()) settledAt = t;
        }
      }

      out.pitch = centre;
      out.open = startT != null;
      out.locked = locked;
      out.settled = settledAt != null;
      out.vibrato = vib.present;
      out.heldMs = t - startT;
      return out;
    },
  };
}

/** Median written duration of a bar's pitched notes, in ms — "how long is a
 *  note in this exercise", used to scale the capture's timing to the tempo.
 *  Median rather than mean so one long final note doesn't skew a bar of
 *  eighths. */
function medianNoteDurationMs(barSteps) {
  const d = ((barSteps && barSteps.steps) || [])
    .filter((s) => !s.isRest && s.midi != null)
    .map((s) => s.durationMs)
    .sort((a, b) => a - b);
  return d.length ? d[(d.length - 1) >> 1] : 0;
}

/**
 * Score one sung pitch against one reference pitch, on the shared 0-100 note
 * scale used everywhere in the app.
 *
 * `sungMidi` is the *fractional* tracked pitch, so the cents deviation is
 * real rather than quantised to a semitone.  An octave error is treated
 * leniently (it is the right pitch class in the wrong register), matching the
 * bar scorer in practiceScore.js — by how much is the student's difficulty
 * setting, as is the window the cents are judged in.
 */
function noteScoreFor(sungMidi, refMidi) {
  if (sungMidi == null || refMidi == null) return 0;
  const diff = sungMidi - refMidi;
  let score = centsToScore(diff * 100);
  if (Math.abs(diff) > 2) {
    // Fold to the nearest octave and score the residual, then discount it —
    // an exact octave lands on 70, the same as the bar scorer gives.
    const mod = Math.abs(diff) % 12;
    const folded = Math.min(mod, 12 - mod);
    const octave = tuning().octaveScore / 100;
    score = Math.max(score, Math.round(octave * centsToScore(folded * 100)));
  }
  return Math.max(0, Math.min(100, score));
}

/** One sung/reference chip for the per-note feedback rows. */
function noteCellHTML(p) {
  const cls = p.score >= 70 ? "good" : p.score >= 40 ? "ok" : "weak";
  const sung = p.sung != null ? midiToName(Math.round(p.sung)) : "—";
  const ref = p.ref != null ? midiToName(p.ref) : "—";
  return "<span class='sn-cell " + cls + "'>" + sung + "/" + ref + " <b>" + p.score + "</b></span>";
}

