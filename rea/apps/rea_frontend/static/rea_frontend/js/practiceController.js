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

import { AudioPlayer } from "./audioPlayer.js?v=39";
import { PitchDetector, midiToName } from "./pitchDetector.js?v=39";
import { API } from "./api.js?v=39";
import {
  buildBarSteps, barsToFlat, barPitches, barDegrees, barDurationMs,
  vexKeyOf, shuffle, randInt,
} from "./practiceData.js?v=39";
import {
  scoreSungBar, scoreGuessBar, scoreGuessNote, scoreLabel,
} from "./practiceScore.js?v=39";

const TIMED_DEFAULT = 8;   // per-bar countdown (seconds)
const SING_TAIL_MS = 600;  // extra recording tail so the user can finish
const NOTE_MIN_MS = 130;   // min stable-pitch duration to count as a note
const NOTE_GAP_MS = 90;   // silence gap that splits two sung notes

// The 10 modes, keyed by chapter key.  Each carries enough metadata to render
// the session deck.  The `key` must match the chapter keys in chapters.js.
// A small inline-SVG glyph helper (no emoji).  Keeps the deck UI visual.
function glyph(name, size) {
  const s = size || 18;
  const common = 'width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  switch (name) {
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
          '<div class="fb-prompt" id="d-prompt">Press <b>Start</b> when you are ready.</div>' +
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

  _prompt(html) {
    const el = this.info.querySelector("#d-prompt");
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

  stopSession() {
    this.stop();
    if (this.renderer) { this.renderer.clearHighlight(); this.renderer.clearBarHighlight(); }
    this._showNotes();
    this._setControls(false);
    this._prompt("Session stopped.");
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
    this.running = false;
    this._stopMic();
    this.round = this.order.length;
    this._renderProgress();
    this._renderScore();
    this._showNotes();
    this._setControls(false);

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
      this._finishSingNotes(barIndex, targetMidi, targetDegree, noteIdx, timedOut, sung || []);
    };
    // Live sung-pitch preview for the single target note.
    const r = this.renderer;
    let onPitch = null;
    if (r && r.getPitchedNotesInBar) {
      const pitched = r.getPitchedNotesInBar(barIndex);
      const slot = pitched[noteIdx] || pitched[0];
      if (slot) {
        r.setSungTarget(slot.globalIndex, targetMidi);
        r.showSungNote(slot.globalIndex, targetMidi, targetMidi);
        let lastDraw = 0;
        onPitch = (info) => {
          if (!this.running) return;
          const now = performance.now();
          if (now - lastDraw > 60) {
            r.showSungNote(slot.globalIndex, info.midi != null ? info.midi : info.midiRound, targetMidi);
            lastDraw = now;
          }
        };
      }
    }
    // Countdown starts now — after the preview playback has ended.
    if (timed) this._startCountdown(() => { if (this.running) finish(true, []); });
    await this._recordNotes(recMs + SING_TAIL_MS, (sung) => finish(false, sung), onPitch);
  }

  _finishSingNotes(barIndex, targetMidi, targetDegree, noteIdx, timedOut, sung) {
    if (!this.running) return;
    sung = sung || [];
    const sungMidi = sung.length ? sung[0] : null;
    let score = 0, cents = null;
    if (sungMidi != null) {
      cents = (sungMidi - targetMidi) * 100;
      score = Math.max(0, Math.round(100 - Math.abs(cents) / 1.5));
      if (Math.abs(cents) > 600 && ((sungMidi - targetMidi) % 12 === 0)) score = Math.max(score, 70);
      score = Math.max(0, Math.min(100, score));
    }
    this.scores.push(score);
    this._renderScore(); this._renderProgress();
    this._feedback({
      score, verdict: scoreLabel(score),
      head: (timedOut ? "Time up! " : "") + "Target " + midiToName(targetMidi) + " (deg " + targetDegree + ")",
      detail: "You sang " + (sungMidi != null ? midiToName(sungMidi) : "—") +
        (cents != null ? " · " + (cents > 0 ? "+" : "") + cents + "c" : ""),
      extra: noteBadge(targetMidi, sungMidi),
    });
    this._setLegend("Note score: " + score);
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

  _generateMultiQuestions() {
    const o = this.multiOpts;
    const count = Math.max(2, Math.min(12, o.noteCount || 3));
    const allBars = this.barSteps.map((b, i) => i);
    const questions = [];
    const intervalSemitones = { seconds: 1, thirds: 3, fourths: 5, fifths: 7, sixths: 9, sevenths: 11, octaves: 12 };
    const chordDegrees = { "5/3": [0, 3, 5], "6/3": [0, 4, 7], "6/4": [0, 5, 7] };

    const buildQ = (rootBar) => {
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
    };

    const rounds = Math.max(1, Math.min(12, this.barSteps.length));
    for (let r = 0; r < rounds; r++) {
      const rootBar = this.barSteps.length ? r % this.barSteps.length : 0;
      const q = buildQ(rootBar);
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
    // Non-timed singing: no fixed time limit.  The user sings and presses
    // "Done singing" when ready; a generous safety cap keeps it bounded.
    const maxMs = Math.max(8000, dur * 3 + 4000);
    this._setLegend("Singing… sing bar " + (barIndex + 1) + " now, then press Done.");
    this._prompt("Singing <b>" + (this.round + 1) + "/" + this.order.length + "</b>");
    const onPitch = this._makeSungPreview(barIndex, ref);
    await this._recordNotesUntilDone(maxMs, (sung) => this._scoreSungBar(barIndex, ref, sung), onPitch);
  }

  /**
   * Build a live sung-pitch preview callback for a bar.  The marker starts at
   * the bar's first reference note; when the sung pitch stably matches the
   * current target it advances to the next reference note.  The marker is
   * throttled and low-pass smoothed (in the renderer) to avoid jitter.
   * @param {number} barIndex
   * @param {number[]} refPitches  ordered reference MIDI pitches (pitched notes)
   * @returns {(info)=>void}  pass to the recorder as onPitch
   */
  _makeSungPreview(barIndex, refPitches) {
    const r = this.renderer;
    if (!r || !r.getPitchedNotesInBar) return () => {};
    const pitched = r.getPitchedNotesInBar(barIndex);
    if (!pitched.length) return () => {};
    let step = 0;
    r.setSungTarget(pitched[0].globalIndex, pitched[0].midi);
    r.showSungNote(pitched[0].globalIndex, pitched[0].midi);
    const targets = refPitches.slice();
    // Throttle DOM updates + require a stable match before advancing.
    let lastDraw = 0;
    let stableCount = 0;
    return (info) => {
      if (!this.running) return;
      const midiRound = info.midiRound;
      const midi = info.midi != null ? info.midi : midiRound;
      const target = targets[step];
      if (target == null) return;
      const now = performance.now();
      if (now - lastDraw > 60) {            // ~16fps DOM update cap
        r.showSungNote(pitched[step].globalIndex, midi, target);
        lastDraw = now;
      }
      // Advance only after the pitch holds within a semitone for a few frames.
      // Octave-agnostic match: same pitch class (mod 12) counts as a hit.
      const pcOff = Math.min((((midiRound - target) % 12) + 12) % 12, 12 - ((((midiRound - target) % 12) + 12) % 12));
      if (pcOff <= 1) {
        stableCount += 1;
        if (stableCount >= 3) {
          stableCount = 0;
          step += 1;
          if (step < pitched.length) {
            r.setSungTarget(pitched[step].globalIndex, pitched[step].midi);
            r.showSungNote(pitched[step].globalIndex, midi, pitched[step].midi);
          }
        }
      } else {
        stableCount = 0;
      }
    };
  }

  _scoreSungBar(barIndex, ref, sung) {
    if (!this.running) return;
    sung = sung || [];
    const { score, perNote } = scoreSungBar(sung, ref);
    this.scores.push(score);
    this._renderScore(); this._renderProgress();
    const noteCells = perNote.map((p) => {
      const cls = p.score >= 70 ? "good" : p.score >= 40 ? "ok" : "weak";
      return "<span class='sn-cell " + cls + "'>" + (p.sung != null ? midiToName(p.sung) : "—") + "/" + (p.ref != null ? midiToName(p.ref) : "—") + " <b>" + p.score + "</b></span>";
    }).join("");
    this._feedback({
      score, verdict: scoreLabel(score),
      head: "Bar " + (barIndex + 1) + " singing",
      detail: score + "/100",
      extra: '<div class="sn-row">' + noteCells + "</div>",
    });
    this._setLegend("Bar score: " + score);
    this._advanceAfter(1200);
  }

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
      if (info.midi != null) {
        frames.push({ t: info.t, midi: info.midiRound, cents: info.cents });
        if (onPitch) onPitch({ midiRound: info.midiRound, midi: info.midi, cents: info.cents });
      }
    };
    const finish = () => {
      this._timer = null;
      if (token !== this._roundToken) return;
      this.detector.onPitch = () => {};
      if (this.renderer && this.renderer.clearSungNote) this.renderer.clearSungNote();
      onDone(segmentNotes(frames, start));
    };
    this._timer = setTimeout(finish, ms);
  }

  /**
   * Record singing with no fixed time limit: the user finishes by clicking a
   * "Done" button (rendered into the prompt).  A generous safety cap prevents
   * an abandoned session from recording forever.  Used by the non-timed
   * singing modes (2, 5, 8) so no question is time-limited.
   */
  _recordNotesUntilDone(maxMs, onDone, onPitch) {
    const token = this._roundToken;
    const start = (this.detector && performance.now()) || performance.now();
    const begin = () => {
      const frames = [];
      this.detector.onPitch = (info) => {
        if (!this.running || token !== this._roundToken) return;
        if (info.midi != null) {
          frames.push({ t: info.t, midi: info.midiRound, cents: info.cents });
          if (onPitch) onPitch({ midiRound: info.midiRound, midi: info.midi, cents: info.cents });
        }
      };
      const finish = () => {
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        if (token !== this._roundToken) return;
        this.detector.onPitch = () => {};
        this._hideDoneButton();
        if (this.renderer && this.renderer.clearSungNote) this.renderer.clearSungNote();
        onDone(segmentNotes(frames, start));
      };
      // Safety cap.
      this._timer = setTimeout(finish, maxMs);
      // Done button.
      this._showDoneButton(() => finish());
      this._doneFinish = finish;
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
      btn.innerHTML = glyph("check", 14) + "<span>Done singing</span>";
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
    if (this._clickGuard) { this._clickGuard(idx); return; }
    // No active input guard: in listening mode a bar click plays just that
    // bar and advances the round progress to that bar's position.
    if (this.mode && this.mode.key === "listen") {
      this._listenClick(idx);
    }
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

/** Small badge comparing target vs sung note. */
function noteBadge(target, sung) {
  if (sung == null) return '<div class="sn-row"><span class="sn-cell weak">— / ' + midiToName(target) + "</span></div>";
  const cls = Math.abs(sung - target) <= 0 ? "good" : Math.abs((sung - target) * 100) <= 50 ? "ok" : "weak";
  return '<div class="sn-row"><span class="sn-cell ' + cls + '">' + midiToName(sung) + " / " + midiToName(target) + "</span></div>";
}

/**
 * Segment pitch frames into stable MIDI notes.
 */
function segmentNotes(frames, startTime) {
  if (!frames.length) return [];
  const groups = [];
  let cur = { midi: frames[0].midi, start: frames[0].t, end: frames[0].t };
  for (let i = 1; i < frames.length; i++) {
    const f = frames[i];
    if (f.midi === cur.midi && (f.t - cur.end) < NOTE_GAP_MS) cur.end = f.t;
    else { groups.push(cur); cur = { midi: f.midi, start: f.t, end: f.t }; }
  }
  groups.push(cur);
  return groups.filter((g) => (g.end - g.start) >= NOTE_MIN_MS).map((g) => g.midi);
}