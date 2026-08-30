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

import { AudioPlayer } from "./audioPlayer.js?v=78";
import { PitchDetector, midiToName } from "./pitchDetector.js?v=78";
import { API } from "./api.js?v=78";
import {
  buildBarSteps, barsToFlat, barPitches, barDegrees, barDurationMs,
  vexKeyOf, shuffle, randInt,
} from "./practiceData.js?v=78";
import {
  centsToScore, scoreGuessBar, scoreLabel,
} from "./practiceScore.js?v=78";

const TIMED_DEFAULT = 8;   // per-bar countdown (seconds)
const SING_TAIL_MS = 600;  // extra recording tail so the user can finish
// A sung note has to be *held*, not merely touched.  The old 130 ms minimum
// let brief "seeking" stabs — the few frames a singer lingers on a
// neighbouring semitone while sliding toward the right pitch — register as
// real notes, which then poisoned the note-by-note scoring alignment.
// 220 ms is short enough that a genuinely intended short note still counts,
// but long enough that a passing glide almost never does.
const NOTE_MIN_MS = 220;   // min stable-pitch duration to count as a note
const NOTE_GAP_MS = 90;   // silence gap that splits two sung notes
// Dominance gate: within a segmented note, the locked pitch must account for
// at least this fraction of the note's frames.  A "seeking" segment that
// only briefly settles on a pitch (the rest of it being a glide) fails this
// and is dropped, instead of being scored as a wrong note.  0.55 is lenient
// enough for natural vibrato yet strict enough to reject slides.
const NOTE_DOMINANCE = 0.55;
// A singer holding a note rarely sits dead-still on it - natural vibrato and
// small pitch wobble routinely cross a semitone's rounding boundary for a
// few frames.  Without margin, `segmentNotes` below would read every such
// wobble as a brand new note, fragmenting one sustained note into several
// (each too short to count) or inserting spurious extra notes that throw off
// the note-by-note scoring alignment.  These two constants give the segmenter
// a "lock-in": once on a note, the pitch has to move meaningfully past the
// boundary (NOTE_LOCK_HYSTERESIS_CENTS) *and* hold there for a bit
// (NOTE_CONFIRM_MS) before it's accepted as an actual note change.  Both are
// deliberately generous - the goal is a note the user has clearly, stably
// landed on, not the first frame that happens to round differently.
const NOTE_LOCK_HYSTERESIS_CENTS = 75; // deadband past the strict 50c boundary before a change is even considered
const NOTE_CONFIRM_MS = 100;           // how long a new pitch must persist before the switch is committed

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
const CAPTURE_HOLD_MS = 240;     // stable hold required before a pitch is taken
const CAPTURE_HYST_CENTS = 60;   // deadband around the lock's running centre
const CAPTURE_DRIFT_CENTS = 90;  // how far the pitch may wander from where the lock started
const CAPTURE_CONFIRM_MS = 100;  // how long a pitch outside the lock must persist
const CAPTURE_GAP_MS = 120;      // unvoiced time that releases the note

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
    // All practice exercises focus on intonation: show noteheads only
    // (stems/beams/flags hidden), while playback keeps the real rhythm.
    this._setNoteheadsOnly(true);
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

    this.info.innerHTML =
      '<div class="deck">' +
        // intro / status banner
        '<div class="deck-intro" style="--cc:' + c.color + '">' +
          '<div class="di-ico">' + glyph(c.glyph, 26) + "</div>" +
          '<div class="di-body">' +
            '<div class="di-title">' + c.title + "</div>" +
            '<div class="di-desc">' + c.instruct + "</div>" +
            '<div class="di-meta">' +
              (m && m.needsMic ? '<span class="tag mic">' + glyph("mic", 12) + " mic</span>" : "") +
              (m && m.timed ? '<span class="tag timed">' + glyph("clock", 12) + " " + TIMED_DEFAULT + "s</span>" : "") +
              '<span class="tag">' + glyph("bars", 12) + " " + bars + "</span>" +
              '<span class="tag">' + glyph("rounds", 12) + " " + total + "</span>" +
            "</div>" +
          "</div>" +
        "</div>" +
        // progress + score
        '<div class="deck-stats">' +
          '<div class="ds-progress">' +
            '<div class="dsp-top"><span>Round <b id="d-round">0</b> / <b id="d-total">' + total + '</b></span><span id="d-streak"></span></div>' +
            '<div class="dsp-track"><div class="dsp-fill" id="d-fill"></div></div>' +
            '<div class="dsp-pips" id="d-pips"></div>' +
          "</div>" +
          '<div class="ds-gauge">' +
            '<div class="gauge" id="d-gauge">' +
              '<svg viewBox="0 0 120 120">' +
                '<circle class="g-bg" cx="60" cy="60" r="52"></circle>' +
                '<circle class="g-fg" cx="60" cy="60" r="52" id="d-gauge-arc"></circle>' +
              "</svg>" +
              '<div class="g-text"><span id="d-avg" class="empty">–</span><small>avg</small></div>' +
            "</div>" +
          "</div>" +
        "</div>" +
        // controls
        '<div class="deck-controls">' +
          '<button id="d-start" class="btn btn-primary">' + glyph("play", 14) + '<span>Start</span></button>' +
          '<button id="d-stop" class="btn" disabled>' + glyph("stop", 14) + '<span>Stop</span></button>' +
          '<button id="d-replay" class="btn" disabled>' + glyph("replay", 14) + '<span>Replay</span></button>' +
          this._controlsExtras() +
        "</div>" +
        // live feedback
        '<div id="d-report" class="deck-report">' +
          '<div class="fb-prompt" id="d-prompt">' + this._readyHint() + "</div>" +
        "</div>" +
        // mode-10 config
        '<div id="d-config"></div>' +
      "</div>";

    this.info.querySelector("#d-start").addEventListener("click", () => this.start());
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
    this._lastAnswerBar = null;
  }

  _showNotes() { if (this.stage) this.stage.classList.remove("hidden-notes"); }
  _hideNotes() { if (this.stage) this.stage.classList.add("hidden-notes"); }

  /** Show only noteheads (hide stems/beams/flags) — intonation focus.
   *  Playback rhythm is unaffected. */
  _setNoteheadsOnly(on) {
    if (!this.stage) return;
    this.stage.classList.toggle("noteheads-only", !!on);
  }

  // ---- session -------------------------------------------------------------

  start() {
    if (!this.mode) { this.setStatus("No mode."); return; }
    if (!this.barSteps || !this.barSteps.length) { this.setStatus("No bars to practice."); return; }
    this.stop();
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
   * Single-note variant of `_makeLiveCapture`: watch one slot, commit the
   * first pitch the singer holds steadily (correct or not), and hand it back.
   * `best()` returns the held pitch even if it never reached the full hold
   * time, so a short attempt that ran into the timer still gets scored rather
   * than counting as silence.
   */
  _makeSingleNoteCapture(barIndex, noteIdx, targetMidi, onNote) {
    const r = this.renderer;
    const pitched = (r && r.getPitchedNotesInBar) ? r.getPitchedNotesInBar(barIndex) : [];
    const slot = pitched[noteIdx] || pitched[0] || null;
    if (r && slot) {
      r.setSungTarget(slot.globalIndex, targetMidi);
      r.showSungNote(slot.globalIndex, targetMidi, targetMidi);
    }
    const lock = makePitchLock();
    let bestNote = null, done = false;
    let smoothMidi = targetMidi, lastT = null, lastDraw = 0;
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

        lock.feed(midi, usableDt, now);
        const centre = lock.centre();
        // Keep the best-so-far even before the hold gate passes, so an attempt
        // cut short by the countdown is still scored rather than read as silence.
        if (centre != null && lock.held() >= (bestNote ? bestNote.durMs : 0)) {
          bestNote = { midi: centre, durMs: lock.held() };
        }
        if (lock.held() >= CAPTURE_HOLD_MS) {
          done = true;
          if (onNote) onNote(bestNote);
        }
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
        this._renderLiveStrip(ref, captured, Math.min(i + 1, ref.length - 1));
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
   * The marker starts on the bar's first reference note.  `makeNoteSegmenter`
   * decides where each sung note begins and ends; every note it reports is
   * committed as the attempt for the current reference note — *any* pitch,
   * right or wrong — and the marker moves to the next one.  Nothing here
   * compares the sung pitch to the target in order to decide whether to
   * advance; the target is used only to colour the marker and, later, to
   * score.  Singing the wrong note costs points, never alignment.
   *
   * A note is scored twice: provisionally the moment it settles, so the marker
   * leads rather than follows, and again when the singer leaves it, from the
   * note's body with the attack and the slide out trimmed off.  The second
   * measurement is the one that stands, which is why a scooped attack is
   * scored where the singer landed rather than where they came in.
   *
   * The marker's vertical position is a light one-pole smoothing of the
   * incoming fractional pitch, so vibrato reads as a gentle wobble rather
   * than frame-to-frame jitter.
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

    const seg = makeNoteSegmenter({ paceMs: noteMs });
    // Which reference slot the note currently being sung was scored into, so a
    // sustained note fills one slot rather than every remaining one, and so the
    // slot can be refined and then settled when the singer moves on.
    let scoredIndex = -1;
    let scoredAt = 0;
    let lastRefine = 0;

    let smoothMidi = targets[0];
    let lastT = null;
    let lastDraw = 0;

    /** Score `step` and move the marker on.  Returns true when that was the
     *  bar's last note (the caller should stop touching the capture).
     *
     *  `final` says the note is finished as well as scored — true for one
     *  banked retroactively (the singer has already left it) and for the
     *  bar's last note (the bar ends there).  A note banked while it is still
     *  being sung is not final: it keeps refining until the singer moves on,
     *  and only then is its accuracy settled. */
    const bank = (noteMidi, heldMs, final) => {
      if (noteMidi == null) return false;
      const i = step;
      step += 1;
      showTarget(step, smoothMidi);
      if (onNote) onNote(i, { midi: noteMidi, durMs: heldMs });
      const last = step >= targets.length;
      if (final || last) {
        if (onNoteDone) onNoteDone(i, { midi: noteMidi, durMs: heldMs });
      }
      if (last) {
        // The bar is done the moment its last note has a score — waiting for
        // the singer to release it would just be dead air.
        if (onComplete) onComplete();
        return true;
      }
      return false;
    };

    return (info) => {
      if (!this.running || step >= targets.length) return;

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
      }

      const note = seg.feed({
        midi,
        onsetStrength: (info && info.onsetStrength) || 0,
        t: now,
        dt: usableDt,
      });

      // --- a note finished -------------------------------------------------
      if (note.ended) {
        if (scoredIndex >= 0) {
          // Settle the slot it was scored into.  Its pitch is measured over the
          // note's body — the attack and the slide out are both trimmed — so a
          // singer is scored on the note they sang, not on the way into it.
          if (onNote) onNote(scoredIndex, { midi: note.ended.midi, durMs: note.ended.durMs });
          if (onNoteDone) onNoteDone(scoredIndex, { midi: note.ended.midi, durMs: note.ended.durMs });
          scoredIndex = -1;
        } else if (note.ended.durMs >= seg.minNoteMs()) {
          // A real note that ended before it ever settled — which is the normal
          // case when singing at the exercise's own tempo.  Score it now rather
          // than lose it: losing it would leave the marker behind, and every
          // note after it would be matched against the wrong reference, which
          // is what "it gets stuck" looks like from the outside.
          if (bank(note.ended.midi, note.ended.durMs, true)) return;
        }
      }

      // --- the open note has locked: score it and let the marker lead -------
      // Locked, not merely stable: a hundred milliseconds of steadiness is a
      // singer arriving at a note, not a singer having sung one, and scoring
      // there is what made the marker run ahead of the voice.
      if (scoredIndex < 0 && note.locked && note.pitch != null) {
        scoredIndex = step;
        scoredAt = now - note.heldMs;
        lastRefine = now;
        if (bank(note.pitch, note.heldMs, false)) return;
        return;
      }

      // --- still on the note we scored: keep refining it ---------------------
      if (scoredIndex >= 0 && note.pitch != null && now - lastRefine > 80) {
        lastRefine = now;
        if (onNote) onNote(scoredIndex, { midi: note.pitch, durMs: now - scoredAt });
        return;
      }

      // --- stall guard -------------------------------------------------------
      // A voice that never holds still enough to lock must not freeze the
      // exercise.  After a couple of the singer's own note-lengths of unbroken
      // sound, the best estimate we have is scored and the marker moves on:
      // they are audibly on something, and scoring where they actually are
      // beats stopping the bar dead — a stall costs every later note too.
      // Measured on the *open note*, not on continuous voicing: a legato phrase
      // never goes quiet, so a voicing timer would keep counting across notes
      // and fire in the middle of a perfectly good one.
      if (scoredIndex < 0 && note.rough != null && note.heldMs >= 2.4 * seg.paceMs()) {
        scoredIndex = step;
        scoredAt = now - note.heldMs;
        lastRefine = now;
        if (bank(note.rough, note.heldMs, false)) return;
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
        this._feedback({ score: 0, verdict: "—", head: "Mic unavailable", detail: e.message });
        onDone([]);
      });
      return;
    }
    const frames = [];
    const start = performance.now();
    this.detector.onPitch = (info) => {
      if (!this.running || token !== this._roundToken) return;
      if (info.midi != null) frames.push({ t: info.t, midi: info.midi });
      if (onPitch) onPitch(info);
    };
    const finish = () => {
      this._timer = null;
      if (token !== this._roundToken) return;
      this._stopRecording();
      onDone(segmentNotes(frames, start));
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
      const frames = [];
      this.detector.onPitch = (info) => {
        if (!this.running || token !== this._roundToken) return;
        if (info.midi != null) frames.push({ t: info.t, midi: info.midi });
        if (onPitch) onPitch(info);
      };
      const finish = () => {
        if (token !== this._roundToken) return;
        this._stopRecording();
        onDone(segmentNotes(frames, start));
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
        onDone([]);
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

/**
 * A "pitch lock": the note the singer is sitting on right now, as a running
 * centre plus how long it has been held.
 *
 * The lock exists so the live capture can answer one question — *has the
 * singer settled on a note?* — without ever asking whether it is the right
 * note.  Two gates keep it honest:
 *
 *   - a CAPTURE_HYST_CENTS deadband around the running centre, so the same
 *     note keeps accumulating hold time while pitch wanders inside it;
 *   - a CAPTURE_DRIFT_CENTS bound on how far it may get from where the lock
 *     started, so a steady slide cannot creep along inside the moving band and
 *     pass itself off as a held note;
 *   - a CAPTURE_CONFIRM_MS gate on anything outside those, so a vibrato peak
 *     that crosses the boundary and comes straight back does not read as a new
 *     note, while a genuine move to another pitch does.
 *
 * Unvoiced frames accumulate towards CAPTURE_GAP_MS; once that is reached the
 * note is released, which is what lets a repeated pitch be re-articulated as
 * two separate notes.
 */
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
// 3. THE SINGER SETS THE TEMPO, NOT THE SCORE.  Every duration here scales
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
//   steady voice ......... 1.32 - 2.09      0.49
//   voice in vibrato ..... 2.26             0.92
//
// So a steady note can be broken at 1.0 with room on both sides, while a voice
// in vibrato needs a higher bar — vibrato is a genuine spectral disturbance and
// it is the only thing that comes close to looking like an articulation.  This
// is the coupling that matters: the pitch tells us whether to believe the
// spectrum.
const SEG_LOCK_RESISTANCE = 0.2;    // ...per unit of lock confidence
const SEG_VIB_RESISTANCE = 0.35;    // ...while the voice is in vibrato
// Short, because an articulation is a burst and vibrato is a stream.  Summing
// over a longer window gathers more of the burst but proportionally more of the
// stream too, and past ~70 ms vibrato overtakes real onsets outright.
const SEG_ONSET_DECAY_MS = 55;      // an articulation's evidence fades over this
const SEG_RELEASE_TRIM_MS = 60;     // drop the slide *out* of a note before scoring it
const SEG_VIB_WINDOW_MS = 450;      // window the vibrato estimate is made over
const SEG_VIB_MIN_HZ = 3.5;         // slower than this is drift, not vibrato
const SEG_VIB_MAX_HZ = 9;           // faster is jitter
const SEG_VIB_MIN_CENTS = 12;       // narrower than this needs no allowance
const SEG_VIB_MAX_CENTS = 130;      // wider than this is not vibrato, it is two notes
const SEG_VIB_DEADBAND_CENTS = 4;   // ignore crossings this small when counting rate
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
  let pace = segClamp(o.paceMs || 450, SEG_PACE_MIN_MS, SEG_PACE_MAX_MS);
  const durations = [];

  let startT = null;
  let samples = [];          // { t, midi } after the attack window
  let centre = null;         // the locked pitch
  let locked = false;
  let lockedAt = 0;
  let onsetEvidence = 0;     // decaying sum of articulation strength
  let departureMs = 0;       // time spent beyond what vibrato explains
  let silentMs = 0;
  let lastVoicedT = null;
  let rough = null;          // best pitch estimate even before the note locks
  let vib = { present: false, halfWidth: 0, rateHz: 0 };

  // --- timings, all derived from the singer's own pace ---------------------
  const attackSkipMs = () => segClamp(0.12 * pace, 45, 120);
  const settleWindowMs = () => segClamp(0.5 * pace, 180, 420);
  const lockMs = () => segClamp(0.30 * pace, 90, 320);
  const minSegmentMs = () => segClamp(0.42 * pace, 130, 600);
  const confirmMs = () => segClamp(0.22 * pace, 80, 220);
  const gapMs = () => segClamp(0.25 * pace, 90, 220);
  const minNoteMs = () => segClamp(0.40 * pace, 120, 500);

  /** Vibrato over the tail of the open note: how wide, and how fast. */
  const estimateVibrato = (t) => {
    const win = samples.filter((x) => x.t >= t - SEG_VIB_WINDOW_MS);
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
    const base = SEG_TOL_BASE_CENTS;
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
    const last = samples[samples.length - 1].t;
    let use = samples.filter((x) => x.t <= last - SEG_RELEASE_TRIM_MS);
    if (use.length < 3) use = samples;
    if (centre != null) {
      const tol = tolerance();
      const onNote = use.filter((x) => Math.abs(x.midi - centre) * 100 <= tol);
      if (onNote.length >= 3) use = onNote;
    }
    return medianOf(use.map((x) => x.midi));
  };

  const close = (t) => {
    if (startT == null) return null;
    const midi = bodyPitch();
    const durMs = (lastVoicedT != null ? lastVoicedT : t) - startT;
    startT = null; samples = []; centre = null; locked = false; rough = null;
    onsetEvidence = 0; departureMs = 0;
    vib = { present: false, halfWidth: 0, rateHz: 0 };
    if (midi == null) return null;
    // Only a note long enough to be a note teaches us about the singer's pace;
    // a clipped fragment would drag the estimate down and make everything after
    // it more trigger-happy.
    if (durMs >= minNoteMs()) {
      durations.push(durMs);
      if (durations.length > 5) durations.shift();
      if (durations.length >= 2) {
        pace = segClamp(medianOf(durations), SEG_PACE_MIN_MS, SEG_PACE_MAX_MS);
      }
    }
    return { midi, durMs, startT: t - durMs };
  };

  const open = (t) => {
    startT = t; samples = []; centre = null; locked = false; rough = null;
    onsetEvidence = 0; departureMs = 0;
    vib = { present: false, halfWidth: 0, rateHz: 0 };
  };

  return {
    pitch: () => centre,
    paceMs: () => pace,
    minNoteMs,
    reset: () => {
      startT = null; samples = []; centre = null; locked = false;
      onsetEvidence = 0; departureMs = 0; silentMs = 0; lastVoicedT = null;
      durations.length = 0;
    },

    feed(f) {
      const t = f.t;
      const dt = f.dt > 0 && f.dt < 500 ? f.dt : 0;
      const midi = f.midi;
      const strength = f.onsetStrength || 0;
      const out = {
        ended: null, started: false, pitch: centre, rough: null,
        locked: false, stable: false, heldMs: 0, vibrato: vib.present,
      };

      if (midi == null) {
        silentMs += dt;
        if (silentMs >= gapMs() && startT != null) out.ended = close(t);
        out.pitch = centre;
        return out;
      }
      silentMs = 0;
      lastVoicedT = t;

      // --- accumulate the evidence for ending the open note ----------------
      let begin = startT == null;
      if (!begin) {
        const age = t - startT;
        // Articulation evidence decays, so a burst smeared across two or three
        // frames adds up to one onset while two unrelated flickers a beat apart
        // do not.
        onsetEvidence *= Math.exp(-(dt || 0) / SEG_ONSET_DECAY_MS);
        if (age >= minSegmentMs()) onsetEvidence += strength;

        // Pitch evidence: distance beyond what this note's own vibrato explains.
        //
        // The reference falls back to the running median, not to this frame's
        // own pitch.  Comparing the pitch against itself can never register a
        // move, so a note that never locked — a fast one, where there is barely
        // time to — could be left open indefinitely while the singer moved on
        // through two more.
        const tol = tolerance();
        const ref = centre != null ? centre : (rough != null ? rough : midi);
        const away = Math.abs(midi - ref) * 100 - tol;
        if (away > 0) {
          // A bigger move is worth more per unit time than a marginal one.
          departureMs += (dt || 0) * segClamp(away / tol, 0.5, 2.5);
        } else {
          departureMs = Math.max(0, departureMs - (dt || 0) * 2);
        }

        const evidence = onsetEvidence + departureMs / confirmMs();
        // A firmly locked note demands more before it will be broken, and a
        // voice in vibrato more again.
        const needed = 1
          + SEG_LOCK_RESISTANCE * lockConfidence(t)
          + (vib.present ? SEG_VIB_RESISTANCE : 0);
        if (evidence >= needed && age >= minSegmentMs()) begin = true;
      }

      if (begin) {
        out.ended = close(t);
        open(t);
        out.started = true;
      }

      // --- measure the open note -------------------------------------------
      if (t - startT >= attackSkipMs()) samples.push({ t, midi });
      const winStart = t - settleWindowMs();
      const win = samples.filter((x) => x.t >= winStart);
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
            // Bounded follow.  It has to follow a little — a scooped attack
            // means the pitch at the start of a note is not the note — but an
            // unbounded follow tracks a slow glide all the way to the next
            // note, so "have they moved on" never becomes true and the marker
            // sits still while the singer sings on.
            const lim = SEG_FOLLOW_LIMIT_CENTS / 100;
            const delta = segClamp(med - centre, -lim, lim);
            centre += delta * Math.min(1, (dt || 16) / 260);
          }
        }
      }

      out.pitch = centre;
      out.locked = locked;
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
 * bar scorer in practiceScore.js.
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
    score = Math.max(score, Math.round(0.7 * centsToScore(folded * 100)));
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

/**
 * Segment pitch frames into stable MIDI notes.
 *
 * `frames` are `{ t, midi }` with `midi` the *fractional* tracked pitch (not
 * rounded) so this can apply cents-level hysteresis rather than reacting to
 * every frame that rounds to a different semitone.  A note stays "locked" as
 * long as incoming pitch sits within `NOTE_LOCK_HYSTERESIS_CENTS` of it; a
 * pitch further away only becomes a candidate for a new note, and that
 * candidate must hold for `NOTE_CONFIRM_MS` before the switch is committed.
 * This is what gives the user "margin to lock into a note" - vibrato and
 * momentary detector noise around a note's edges no longer read as separate
 * (usually too-short-to-count) notes, which previously fragmented one
 * sustained note into several and/or inserted spurious extra notes that threw
 * off the note-by-note scoring alignment.
 *
 * In addition to the lock-in, each candidate note is checked for *dominance*:
 * the locked pitch must account for at least `NOTE_DOMINANCE` of the note's
 * frames.  A "seeking" segment that mostly glides and only briefly settles on
 * a semitone fails this and is dropped rather than scored as a wrong note —
 * this is the key defence against the "tracks too many reference notes in
 * the wrong order" failure mode, where brief seeking stabs used to register
 * as real notes and derail the alignment.
 *
 * Returns detailed note objects `{ midi, start, end, durMs }` so the scorer
 * can weight each note by how long it was actually held.
 */
function segmentNotes(frames, startTime) {
  if (!frames.length) return [];
  const groups = [];
  let locked = Math.round(frames[0].midi);
  let start = frames[0].t;
  let end = frames[0].t;
  let candidate = null; // { midi, since }
  // Per-note frame bookkeeping for the dominance check: how many frames
  // inside the current note sit within the locked pitch's deadband.
  let onPitchFrames = 1;
  let totalFrames = 1;

  const close = () => {
    const durMs = end - start;
    const dominant = totalFrames > 0 && (onPitchFrames / totalFrames) >= NOTE_DOMINANCE;
    if (durMs >= NOTE_MIN_MS && dominant) {
      groups.push({ midi: locked, start, end, durMs });
    }
  };

  for (let i = 1; i < frames.length; i++) {
    const f = frames[i];

    if (f.t - end >= NOTE_GAP_MS) {
      // Silence gap: close out the current note regardless of pitch (this is
      // also how a repeated note - same pitch sung twice with a pause - stays
      // two separate notes instead of merging into one).
      close();
      locked = Math.round(f.midi);
      start = f.t; end = f.t;
      candidate = null;
      onPitchFrames = 1; totalFrames = 1;
      continue;
    }

    totalFrames += 1;
    const centsFromLocked = Math.abs(f.midi - locked) * 100;
    if (centsFromLocked <= NOTE_LOCK_HYSTERESIS_CENTS) {
      // Still within the locked note's deadband - extend it, and drop any
      // pending candidate (the wobble didn't sustain).
      end = f.t;
      onPitchFrames += 1;
      candidate = null;
      continue;
    }

    // Outside the deadband: track how long *this* candidate pitch persists.
    const candidateMidi = Math.round(f.midi);
    if (!candidate || candidate.midi !== candidateMidi) candidate = { midi: candidateMidi, since: f.t };
    if (f.t - candidate.since >= NOTE_CONFIRM_MS) {
      // Sustained long enough - commit the switch to a genuinely new note.
      close();
      locked = candidate.midi;
      start = candidate.since;
      end = f.t;
      candidate = null;
      onPitchFrames = 1; totalFrames = 1;
    } else {
      // Not yet confirmed - keep extending the locked note while we wait;
      // if the candidate never sustains, this frame simply ends up folded
      // into the note it interrupted.
      end = f.t;
    }
  }
  close();
  return groups;
}
