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
 * What differs is only what a "bar" looks like: a stave draws it as a group
 * of noteheads, this draws it as the key or the fret its first note sounds.
 *
 * The mapping is deliberately one note per bar.  These are degree exercises:
 * the bars of a key model are its scale degrees, one pitch each, and that is
 * exactly what a key or a fret can stand for.  A bar holding several notes is
 * shown by its first — the note the round plays — and its remaining notes
 * keep their indices so the controller's note numbering still lines up.
 */

/** Which pitch classes are the black keys of a piano octave. */
const BLACK = new Set([1, 3, 6, 8, 10]);

/** The strings of a guitar in standard tuning, low to high, as MIDI. */
const GUITAR_STRINGS = [40, 45, 50, 55, 59, 64];

/** How many frets the neck shows.  Twelve is one octave on every string,
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

    // One delegated pair of listeners for the life of the renderer: the keys
    // are rebuilt on every render and per-element handlers would pile up.
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
   * `midi` is what places a bar on the instrument, so the caller has to have
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

    // The bars, reduced to the one pitch each stands for, and their note
    // indices kept whole so the controller's numbering still lines up.
    let globalIndex = 0;
    const targets = [];
    bars.forEach((bar, barIndex) => {
      const noteStart = globalIndex;
      let midi = null;
      let degree = "";
      (bar.notes || []).forEach((n) => {
        const isRest = !!n.is_rest || !n.name;
        if (!isRest && midi == null && n.midi != null) {
          midi = n.midi;
          degree = n.alias || "";
        }
        this.notes.push({
          globalIndex, barIndex, el: null, isRest,
          midi: isRest ? null : n.midi, degree: n.alias || "",
        });
        globalIndex += 1;
      });
      this.bars.push({
        barIndex, el: null, midi, degree,
        noteStart, noteEnd: globalIndex - 1,
      });
      if (midi != null) targets.push({ barIndex, midi, degree });
    });

    const root = element("div", `inst inst-${this.instrument}`);
    if (this.instrument === "guitar") this._drawNeck(root, targets);
    else this._drawKeyboard(root, targets);
    this.container.appendChild(root);
    this.root = root;
    return this.notes;
  }

  /** Attach a drawn control to the bar it answers for. */
  _claim(node, barIndex) {
    node.dataset.bar = String(barIndex);
    const bar = this.bars.find((b) => b.barIndex === barIndex);
    if (bar && !bar.el) bar.el = node;
    this.notes.forEach((n) => { if (n.barIndex === barIndex && !n.el) n.el = node; });
  }

  // -- the keyboard ------------------------------------------------------

  /**
   * A piano, as wide as the exercise needs and no wider.
   *
   * The white keys are laid out in a row and the black ones floated over the
   * gaps between them, which is what makes a keyboard read as a keyboard
   * rather than as twelve equal buttons.  Keys the exercise does not use are
   * still drawn — a keyboard with holes in it is not a keyboard — but they
   * are dead: clicking one answers nothing, because nothing in this exercise
   * is that note.
   */
  _drawKeyboard(root, targets) {
    if (!targets.length) return;
    const lowest = Math.min(...targets.map((t) => t.midi));
    const highest = Math.max(...targets.map((t) => t.midi));
    // Whole octaves, starting at the C at or below the lowest note, so the
    // keyboard begins where a keyboard begins.
    const from = Math.floor(lowest / 12) * 12;
    const to = Math.ceil((highest + 1) / 12) * 12 - 1;

    const byMidi = new Map();
    targets.forEach((t) => { if (!byMidi.has(t.midi)) byMidi.set(t.midi, t); });

    const whites = element("div", "kb-whites");
    const blacks = element("div", "kb-blacks");
    let whiteCount = 0;
    for (let midi = from; midi <= to; midi += 1) {
      const target = byMidi.get(midi);
      const black = BLACK.has(((midi % 12) + 12) % 12);
      const key = element("button", black ? "kb-key kb-black" : "kb-key kb-white");
      key.type = "button";
      key.disabled = !target;
      if (target) {
        this._claim(key, target.barIndex);
        key.appendChild(element("span", "kb-deg", target.degree || String(target.barIndex + 1)));
        key.title = `Bar ${target.barIndex + 1}`;
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
    const board = element("div", "kb-board");
    board.style.setProperty("--kb-whites", String(whiteCount));
    board.appendChild(whites);
    board.appendChild(blacks);
    root.appendChild(board);
  }

  // -- the neck ----------------------------------------------------------

  /**
   * A guitar neck in standard tuning, twelve frets.
   *
   * Every pitch has several places on a neck, and a beginner wants one.  It
   * is taken on the lowest string that can reach it — the position a player
   * actually uses, and the one that lets a rising scale climb across the
   * strings instead of bunching into the first few frets of the top one,
   * which is what choosing the lowest *fret* did.  The other places are left
   * undrawn rather than drawn and unclickable: six copies of the same answer
   * is six chances to wonder which one is meant.
   */
  _drawNeck(root, targets) {
    const placed = new Map();   // "string:fret" -> target
    targets.forEach((target) => {
      let best = null;
      GUITAR_STRINGS.forEach((open, stringIndex) => {
        const fret = target.midi - open;
        if (fret < 0 || fret > FRETS || best) return;
        best = { stringIndex, fret };
      });
      if (best) placed.set(`${best.stringIndex}:${best.fret}`, target);
    });

    const neck = element("div", "gt-neck");
    neck.style.setProperty("--gt-frets", String(FRETS));
    // Drawn high string first, so the neck reads the way it looks to a player
    // holding it rather than the way the tuning is listed.
    for (let stringIndex = GUITAR_STRINGS.length - 1; stringIndex >= 0; stringIndex -= 1) {
      const row = element("div", "gt-string");
      for (let fret = 0; fret <= FRETS; fret += 1) {
        const target = placed.get(`${stringIndex}:${fret}`);
        const cell = element("button", `gt-fret${fret === 0 ? " gt-open" : ""}`);
        cell.type = "button";
        cell.disabled = !target;
        if (target) {
          this._claim(cell, target.barIndex);
          cell.appendChild(element("span", "gt-dot", target.degree || String(target.barIndex + 1)));
          cell.title = `Bar ${target.barIndex + 1}`;
        }
        row.appendChild(cell);
      }
      neck.appendChild(row);
    }
    const numbers = element("div", "gt-numbers");
    for (let fret = 0; fret <= FRETS; fret += 1) {
      numbers.appendChild(element("span", "gt-number", fret ? String(fret) : ""));
    }
    root.appendChild(neck);
    root.appendChild(numbers);
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

  clearHighlight() {
    this.bars.forEach((bar) => bar.el && bar.el.classList.remove("is-active"));
  }

  /** Accuracy colouring belongs to a run of notes, and one key stands for a
   *  whole bar, so the bar takes the colour of the note last scored in it. */
  setNoteAccuracy(globalIndex, score) {
    const note = this.notes.find((n) => n.globalIndex === globalIndex);
    if (!note || !note.el) return;
    note.el.classList.remove("acc-good", "acc-ok", "acc-weak", "acc-miss");
    note.el.classList.add(
      score == null ? "acc-miss" : score >= 70 ? "acc-good" : score >= 40 ? "acc-ok" : "acc-weak",
    );
  }

  clearNoteAccuracy() {
    this.bars.forEach((bar) => {
      if (!bar.el) return;
      bar.el.classList.remove("acc-good", "acc-ok", "acc-weak", "acc-miss");
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
    const bar = this.bars.find((b) => b.midi === rounded);
    if (bar && bar.el) bar.el.classList.add("is-sung");
  }

  setSungTarget() { /* the target is already shown as the active bar */ }

  advanceSungNote() { /* nothing to advance: one key per bar */ }

  clearSungNote() {
    this.container.querySelectorAll(".is-sung").forEach((el) => el.classList.remove("is-sung"));
  }
}
