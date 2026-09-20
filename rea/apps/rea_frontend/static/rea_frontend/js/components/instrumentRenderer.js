/**
 * instrumentRenderer.js
 *
 * The exercise drawn as an instrument: a piano keyboard, or a guitar neck.
 *
 * A guessing round asks "which of these did you hear", and until now the only
 * way to answer was to point at a stave.  That suits a student who reads
 * music and is a second exercise for one who does not — a guitarist who can
 * hear the interval perfectly well may still be translating it into a
 * notehead position before they can say so.  Drawn on a keyboard or a neck,
 * the same question is answered in the picture they already think in.
 *
 * It answers to the same interface `NotationRenderer` and `NumericRenderer`
 * do — bar clicks, bar marks, per-note highlighting, the sung-pitch marker —
 * so the practice controller never learns which of the three it is driving.
 *
 * **One diagram per bar, showing that bar's notes.**  A bar of this library
 * is a phrase — "1 5 5 8" is four notes, not a single degree — and drawing
 * the whole exercise as one keyboard with one key standing for each bar threw
 * all of that away: it showed the bar *numbers* laid out on a keyboard, which
 * is a picture of the answer sheet rather than of the music.  So each bar
 * gets its own small keyboard or neck with its own notes marked on it, and
 * the bar stays the thing a click answers with.
 *
 * Every diagram covers the *whole exercise's* range, not its own bar's, so
 * the same pitch is in the same place in every bar and two bars can be
 * compared by looking at them.  On the neck a note is placed once, globally,
 * for the same reason.
 */

/** Which pitch classes are the black keys of a piano octave. */
const BLACK = new Set([1, 3, 6, 8, 10]);

/** The strings of a guitar in standard tuning, low to high, as MIDI. */
const GUITAR_STRINGS = [40, 45, 50, 55, 59, 64];

/** How many frets the neck reaches.  Twelve is one octave on every string,
 *  which is as much as any of this library's exercises can need. */
const FRETS = 12;

const RESULT_CLASSES = ["res-picked", "res-correct", "res-wrong"];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export class InstrumentRenderer {
  /**
   * @param {HTMLElement} container
   * @param {string} instrument  "keyboard" or "guitar"
   */
  constructor(container, instrument = "keyboard") {
    this.container = container;
    this.instrument = instrument;
    this.notes = [];
    this.bars = [];
    this.onBarClick = null;
    this.onBarContext = null;
    // The layout is flow-based and reflows on its own, so it never needs the
    // redraw the stave does.  Kept so the controller can set it either way.
    this.onRelayout = null;

    // One delegated pair of listeners for the life of the renderer: the
    // diagrams are rebuilt on every render and per-element handlers would
    // pile up with them.
    this.container.addEventListener("click", (e) => {
      const target = e.target && e.target.closest ? e.target.closest("[data-bar]") : null;
      if (!target || !this.container.contains(target)) return;
      const index = Number(target.dataset.bar);
      if (!Number.isNaN(index) && this.onBarClick) this.onBarClick(index);
    });
    this.container.addEventListener("contextmenu", (e) => {
      const target = e.target && e.target.closest ? e.target.closest("[data-bar]") : null;
      if (!target || !this.container.contains(target) || !this.onBarContext) return;
      e.preventDefault();
      const index = Number(target.dataset.bar);
      if (!Number.isNaN(index)) this.onBarContext(index, e);
    });
  }

  clear() {
    this.container.innerHTML = "";
    this.notes = [];
    this.bars = [];
    this.root = null;
  }

  /**
   * Render an array of bars.
   *   [{ label, notes: [{ name, alias, duration, is_rest, midi }] }]
   *
   * `midi` is what places a note on the instrument, so the caller has to have
   * resolved it — the same `midiFromEvent` the numeric view uses.
   */
  render(bars, opts = {}) {
    const { onBarClick = null, onBarContext = null } = opts;
    this.clear();
    this.onBarClick = onBarClick;
    if (onBarContext) this.onBarContext = onBarContext;
    if (!bars || !bars.length) {
      this.container.innerHTML = '<div class="empty">No notes to display.</div>';
      return [];
    }

    // Every pitch in the exercise, so each bar's diagram can be drawn to the
    // same range: a keyboard whose keys moved from bar to bar would be a
    // different instrument in every picture.
    const pitches = [];
    bars.forEach((bar) => (bar.notes || []).forEach((n) => {
      if (!n.is_rest && n.name && n.midi != null) pitches.push(n.midi);
    }));
    if (!pitches.length) {
      this.container.innerHTML = '<div class="empty">No notes to display.</div>';
      return [];
    }
    const range = { low: Math.min(...pitches), high: Math.max(...pitches) };
    const places = this.instrument === "guitar" ? fretPositions(pitches) : null;

    const root = element("div", `inst inst-${this.instrument}`);
    let globalIndex = 0;

    bars.forEach((bar, barIndex) => {
      const card = element("button", "inst-bar");
      card.type = "button";
      card.dataset.bar = String(barIndex);

      const head = element("span", "inst-bar-no", String(barIndex + 1));
      if (bar.label) head.appendChild(element("span", "inst-bar-label", bar.label));
      card.appendChild(head);

      // This bar's own notes, in order, kept as entries so the controller's
      // note numbering still lines up — rests included, and silent.
      const noteStart = globalIndex;
      const entries = [];
      (bar.notes || []).forEach((n) => {
        const isRest = !!n.is_rest || !n.name;
        const entry = {
          globalIndex, barIndex, el: null, isRest,
          midi: isRest ? null : n.midi,
          degree: n.alias || "",
          order: entries.length + 1,
        };
        entries.push(entry);
        this.notes.push(entry);
        globalIndex += 1;
      });

      const figure = this.instrument === "guitar"
        ? this._neckFor(entries, places)
        : this._keyboardFor(entries, range);
      card.appendChild(figure);

      root.appendChild(card);
      this.bars.push({
        barIndex, el: card, noteStart, noteEnd: globalIndex - 1,
        midi: (entries.find((e) => !e.isRest) || {}).midi ?? null,
      });
    });

    this.container.appendChild(root);
    this.root = root;
    return this.notes;
  }

  /** What is written on a note's key: its degree, or its place in the bar
   *  when the exercise gives no degrees. */
  _mark(entry) {
    return entry.degree !== "" && entry.degree != null
      ? String(entry.degree) : String(entry.order);
  }

  /**
   * The label for a key several notes of the bar land on.
   *
   * Repeats are the common case — "1 5 5 8" plays the fifth twice — and the
   * same pitch has the same degree both times, so the label is said once.
   * Two different labels on one key can only happen where a lesson names the
   * same pitch two ways, and then both are worth seeing.
   */
  _marksFor(entries) {
    const seen = [];
    entries.forEach((entry) => {
      const mark = this._mark(entry);
      if (!seen.includes(mark)) seen.push(mark);
    });
    return seen.join("\u00b7");
  }

  // -- the keyboard ------------------------------------------------------

  /**
   * One bar, on a piano.
   *
   * The white keys are laid out in a row and the black ones floated over the
   * gaps between them, which is what makes a keyboard read as a keyboard
   * rather than as twelve equal buttons.  Keys this bar does not use are
   * still drawn: a keyboard with holes in it is not a keyboard, and the empty
   * keys are what make the used ones read as an interval.
   */
  _keyboardFor(entries, range) {
    // Whole octaves, starting at the C at or below the lowest note of the
    // exercise, so the keyboard begins where a keyboard begins.
    const from = Math.floor(range.low / 12) * 12;
    const to = Math.ceil((range.high + 1) / 12) * 12 - 1;

    // Several notes of a bar can land on one key — "1 5 5 8" plays the fifth
    // twice — and they share it rather than the second one going undrawn.
    const byMidi = new Map();
    entries.forEach((entry) => {
      if (entry.isRest || entry.midi == null) return;
      if (!byMidi.has(entry.midi)) byMidi.set(entry.midi, []);
      byMidi.get(entry.midi).push(entry);
    });

    const board = element("span", "kb-board");
    const whites = element("span", "kb-whites");
    const blacks = element("span", "kb-blacks");
    let whiteCount = 0;
    for (let midi = from; midi <= to; midi += 1) {
      const on = byMidi.get(midi);
      const black = BLACK.has(((midi % 12) + 12) % 12);
      const key = element("span", black ? "kb-key kb-black" : "kb-key kb-white");
      if (on) {
        key.classList.add("is-on");
        key.appendChild(element("span", "kb-deg", this._marksFor(on)));
        on.forEach((entry) => { entry.el = key; });
      }
      if (black) {
        // Floated over the seam between the two white keys it sits between.
        key.style.setProperty("--kb-at", String(whiteCount));
        blacks.appendChild(key);
      } else {
        whiteCount += 1;
        whites.appendChild(key);
      }
    }
    board.style.setProperty("--kb-whites", String(whiteCount));
    board.appendChild(whites);
    board.appendChild(blacks);
    return board;
  }

  // -- the neck ----------------------------------------------------------

  /**
   * One bar, on a guitar neck.
   *
   * Only the strings and frets the exercise actually reaches are drawn — a
   * full neck per bar would be mostly empty wood — and the window is the same
   * in every bar, so a note keeps its place across the whole exercise.
   */
  _neckFor(entries, places) {
    const neck = element("span", "gt-neck");
    const { strings, minFret, maxFret } = places.window;
    neck.style.setProperty("--gt-frets", String(maxFret - minFret + 1));

    const here = new Map();
    entries.forEach((entry) => {
      if (entry.isRest || entry.midi == null) return;
      const at = places.byMidi.get(entry.midi);
      if (!at) return;
      const key = `${at.stringIndex}:${at.fret}`;
      if (!here.has(key)) here.set(key, []);
      here.get(key).push(entry);
    });

    // High string first, so the neck reads the way it looks to a player
    // holding it rather than the way the tuning is listed.
    strings.slice().reverse().forEach((stringIndex) => {
      const row = element("span", "gt-string");
      for (let fret = minFret; fret <= maxFret; fret += 1) {
        const cell = element("span", `gt-fret${fret === 0 ? " gt-open" : ""}`);
        const on = here.get(`${stringIndex}:${fret}`);
        if (on) {
          const dot = element("span", "gt-dot", this._marksFor(on));
          cell.appendChild(dot);
          cell.classList.add("is-on");
          on.forEach((entry) => { entry.el = cell; });
        }
        row.appendChild(cell);
      }
      neck.appendChild(row);
    });

    const numbers = element("span", "gt-numbers");
    for (let fret = minFret; fret <= maxFret; fret += 1) {
      numbers.appendChild(element("span", "gt-number", String(fret)));
    }
    neck.appendChild(numbers);
    return neck;
  }

  // -- the interface the controller drives -------------------------------

  _barEl(barIndex) {
    const bar = this.bars.find((b) => b.barIndex === barIndex);
    return bar ? bar.el : null;
  }

  highlightBar(barIndex, opts = {}) {
    this.bars.forEach((bar) => {
      if (bar.el) bar.el.classList.toggle("is-bar-active", bar.barIndex === barIndex);
    });
    if (opts.reveal !== false) this.revealBar(barIndex);
  }

  highlightBarBox(barIndex, opts = {}) { this.highlightBar(barIndex, opts); }

  markBarResult(barIndex, kind) {
    const el = this._barEl(barIndex);
    if (!el) return;
    RESULT_CLASSES.forEach((cls) => el.classList.remove(cls));
    if (kind) el.classList.add(`res-${kind}`);
  }

  clearBarResults() {
    this.bars.forEach((bar) => {
      if (!bar.el) return;
      RESULT_CLASSES.forEach((cls) => bar.el.classList.remove(cls));
    });
  }

  markFocus(barIndexes) {
    const wanted = new Set(barIndexes || []);
    this.bars.forEach((bar) => {
      if (bar.el) bar.el.classList.toggle("is-focus", wanted.has(bar.barIndex));
    });
  }

  revealBar(barIndex) {
    const el = this._barEl(barIndex);
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }
  }

  clearBarHighlight() {
    this.bars.forEach((bar) => bar.el && bar.el.classList.remove("is-bar-active"));
  }

  clearBarBox() { this.clearBarHighlight(); }

  highlightNote(globalIndex) {
    const note = this.notes.find((n) => n.globalIndex === globalIndex);
    this.clearHighlight();
    if (note && note.el) note.el.classList.add("is-active");
  }

  /** The note marks live on the keys and frets inside a bar's diagram, not on
   *  the bar itself, so they are cleared where they were put. */
  clearHighlight() {
    this.notes.forEach((note) => note.el && note.el.classList.remove("is-active"));
  }

  /** How close the singer got, on the key they were aiming at. */
  setNoteAccuracy(globalIndex, score) {
    const note = this.notes.find((n) => n.globalIndex === globalIndex);
    if (!note || !note.el) return;
    note.el.classList.remove("acc-good", "acc-ok", "acc-weak", "acc-miss");
    note.el.classList.add(
      score == null ? "acc-miss" : score >= 70 ? "acc-good" : score >= 40 ? "acc-ok" : "acc-weak",
    );
  }

  clearNoteAccuracy() {
    this.notes.forEach((note) => {
      if (!note.el) return;
      note.el.classList.remove("acc-good", "acc-ok", "acc-weak", "acc-miss");
    });
  }

  getBarNoteRange(barIndex) {
    const bar = this.bars.find((b) => b.barIndex === barIndex);
    return bar ? { start: bar.noteStart, end: bar.noteEnd } : null;
  }

  getBarCount() { return this.bars.length; }

  getPitchedNotesInBar(barIndex) {
    return this.notes.filter((n) => n.barIndex === barIndex && !n.isRest);
  }

  /**
   * The live sung pitch.
   *
   * A keyboard has nowhere to put a floating marker between two notes the way
   * a stave has, so what it shows instead is the nearest key lighting up —
   * which is the same information in the language of the picture: "you are
   * singing this note, and this is the one you want".
   */
  showSungNote(globalIndex, midi) {
    this.container.querySelectorAll(".is-sung").forEach((el) => el.classList.remove("is-sung"));
    if (midi == null) return;
    const rounded = Math.round(midi);
    // The key or fret the singer is on, wherever it appears — the same
    // information a stave gives with a floating marker, said in the language
    // of this picture.
    const sung = this.notes.find((n) => n.midi === rounded && n.el);
    if (sung) sung.el.classList.add("is-sung");
  }

  setSungTarget() { /* the target is already shown as the active bar */ }

  advanceSungNote() { /* nothing to advance: one key per bar */ }

  clearSungNote() {
    this.container.querySelectorAll(".is-sung").forEach((el) => el.classList.remove("is-sung"));
  }
}

/**
 * Where each pitch of the exercise is played, and the window that holds them.
 *
 * Worked out once for the whole exercise rather than per bar: a note has
 * several places on a neck, and it has to be the *same* place every time it
 * appears or the picture teaches nothing.  Each is taken on the lowest string
 * that reaches it, which is the position a player actually uses and lets a
 * rising scale climb across the strings instead of bunching into the first
 * frets of the top one.
 */
function fretPositions(pitches) {
  const byMidi = new Map();
  const used = new Set();
  let minFret = Infinity;
  let maxFret = -Infinity;
  pitches.forEach((midi) => {
    if (byMidi.has(midi)) return;
    let at = null;
    GUITAR_STRINGS.forEach((open, stringIndex) => {
      const fret = midi - open;
      if (fret < 0 || fret > FRETS || at) return;
      at = { stringIndex, fret };
    });
    if (!at) return;
    byMidi.set(midi, at);
    used.add(at.stringIndex);
    minFret = Math.min(minFret, at.fret);
    maxFret = Math.max(maxFret, at.fret);
  });
  if (!byMidi.size) {
    return { byMidi, window: { strings: [0], minFret: 0, maxFret: 4 } };
  }
  // A fret of air either side, so the notes are not pressed against the edge
  // of the picture, and never off the end of the neck.
  minFret = Math.max(0, minFret - 1);
  maxFret = Math.min(FRETS, maxFret + 1);
  const strings = Array.from(used).sort((a, b) => a - b);
  return { byMidi, window: { strings, minFret, maxFret } };
}
