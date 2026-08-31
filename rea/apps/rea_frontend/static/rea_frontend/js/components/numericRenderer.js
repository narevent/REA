/**
 * numericRenderer.js
 *
 * The numeric display: the same exercise as the stave, read as scale degrees.
 *
 * A numeric category holds no separate lesson — it is the *same* lesson the
 * Notal branch plays, drawn a different way.  So this renderer answers to the
 * exact interface `NotationRenderer` does (bar clicks, per-note highlighting,
 * accuracy colouring, the live sung-pitch marker), and the practice
 * controller never learns which of the two it is driving.
 *
 * What it draws: one button per bar, holding that bar's notes as their
 * degree numbers.  Rests keep their slot (as a dash) so the note indices the
 * controller passes around line up with the ones the player schedules.
 */

/** Accuracy bands, thresholds shared with the stave and the feedback chips. */
const ACCURACY_CLASSES = ["acc-good", "acc-ok", "acc-weak", "acc-miss"];

/** Answer marks for `markBarResult` — the guessing chapters' counterpart to
 *  the accuracy colours, and the same three kinds the stave draws. */
const RESULT_CLASSES = ["res-picked", "res-correct", "res-wrong"];

function accuracyClass(score) {
  if (score == null) return "acc-miss";
  if (score >= 70) return "acc-good";
  if (score >= 40) return "acc-ok";
  return "acc-weak";
}

/** The nearest ancestor that actually scrolls — the score panel on a wide
 *  screen, the page on a phone.  Falls back to the document scroller. */
function scrollParentOf(node) {
  for (let p = node.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight + 1) return p;
  }
  const doc = document.scrollingElement;
  return doc && doc.scrollHeight > doc.clientHeight + 1 ? doc : null;
}

export class NumericRenderer {
  constructor(container) {
    this.container = container;
    this.notes = [];   // [{ globalIndex, barIndex, el, midi, isRest, degree }]
    this.bars = [];    // [{ barIndex, el, noteStart, noteEnd }]
    this.onBarClick = null;
    // Unused here — the layout is flow-based, so it reflows on its own and
    // never needs the redraw the stave does.  Kept so the controller can set
    // it on either renderer without asking which it has.
    this.onRelayout = null;
    this.root = null;

    // One delegated listener for the life of the renderer: bars are rebuilt on
    // every render, and per-element handlers would pile up with them.
    this.container.addEventListener("click", (e) => {
      const barEl = e.target && e.target.closest ? e.target.closest(".num-bar") : null;
      if (!barEl || !this.container.contains(barEl)) return;
      const idx = Number(barEl.dataset.bar);
      if (!isNaN(idx) && this.onBarClick) this.onBarClick(idx);
    });
  }

  clear() {
    this.container.innerHTML = "";
    this.notes = [];
    this.bars = [];
    this.root = null;
    this._revealed = null;
    this._sungEl = null;
    this._sungGlobal = null;
    this._currentTargetMidi = null;
  }

  /**
   * Render an array of bars.
   *   [{ label, notes: [{ name, alias, duration, is_rest, midi }] }]
   * `alias` is the scale degree — the number this view exists to show — and
   * `midi` is what the sung-pitch marker measures against.
   */
  render(bars, opts = {}) {
    const { onBarClick = null } = opts;
    this.clear();
    this.onBarClick = onBarClick;
    if (!bars || !bars.length) {
      this.container.innerHTML = '<div class="empty">No notes to display.</div>';
      return [];
    }

    const root = document.createElement("div");
    root.className = "num-score";

    let globalIndex = 0;
    bars.forEach((bar, barIndex) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "num-bar";
      btn.dataset.bar = String(barIndex);

      // The bar's own number, so a student can say which bar they mean, plus
      // the source's harmonic label (a Roman numeral) where it carries one.
      const head = document.createElement("span");
      head.className = "num-bar-no";
      head.textContent = String(barIndex + 1);
      if (bar.label) {
        const lab = document.createElement("span");
        lab.className = "num-bar-label";
        lab.textContent = bar.label;
        head.appendChild(lab);
      }
      btn.appendChild(head);

      const row = document.createElement("span");
      row.className = "num-row";
      const noteStart = globalIndex;
      const entries = [];

      (bar.notes || []).forEach((n) => {
        const chip = document.createElement("span");
        const isRest = !!n.is_rest || !n.name;
        chip.className = "num-note" + (isRest ? " is-rest" : "");
        chip.dataset.g = String(globalIndex);
        // A longer note reads wider, so the bar still shows its rhythm even
        // with the notation gone.  Eighths are the norm in these lessons.
        const dur = n.duration || 0.125;
        chip.style.setProperty("--num-w", Math.max(1, Math.min(3, dur / 0.125)));

        // The note's visual offset — where the teacher wants it drawn, as
        // against when it sounds.  The stave shifts the notehead itself; here
        // the degree slides the same way and by the same amount, so the two
        // views of one exercise agree about its shape.  A transform rather
        // than a margin, so a nudged degree cannot reflow the row it is in.
        const nudge = Number(n.visual_offset_px) || 0;
        if (nudge) chip.style.transform = `translateX(${nudge}px)`;

        const deg = document.createElement("span");
        deg.className = "num-deg";
        deg.textContent = isRest ? "–" : (n.alias || "?");
        chip.appendChild(deg);
        row.appendChild(chip);

        const entry = {
          globalIndex, barIndex, el: chip, isRest, visualOffset: nudge,
          midi: isRest ? null : (n.midi != null ? n.midi : null),
          degree: n.alias || "",
        };
        entries.push(entry);
        this.notes.push(entry);
        globalIndex += 1;
      });

      btn.appendChild(row);
      root.appendChild(btn);
      this.bars.push({
        barIndex, el: btn,
        noteStart,
        noteEnd: noteStart + entries.length - 1,
      });
    });

    this.container.appendChild(root);
    this.root = root;
    return this.notes;
  }

  // ---- bar highlighting ----------------------------------------------------

  /** Mark every note in a bar as the bar in play.
   *
   *  `opts.reveal === false` leaves the scroll position alone: see
   *  `_revealBar`, and the stave renderer's note on the same option. */
  highlightBar(barIndex, opts = {}) {
    this.notes.forEach((n) => {
      if (!n.el) return;
      n.el.classList.toggle("is-bar-active", n.barIndex === barIndex);
    });
    this.highlightBarBox(barIndex, opts);
  }

  /** Frame a bar (the one to sing, or the one just answered). */
  highlightBarBox(barIndex, opts = {}) {
    const { reveal = true } = opts;
    this.bars.forEach((b) => {
      if (b.el) b.el.classList.toggle("is-sing", b.barIndex === barIndex);
    });
    if (reveal) this._revealBar(barIndex);
  }

  /**
   * Mark a bar with the outcome of a guess: "picked" the moment it is
   * clicked, then "correct" / "wrong" once it has been judged.  Several bars
   * can carry a mark at once (a wrong pick and the right answer), so these
   * accumulate until `clearBarResults`.  The stave renderer's version of this
   * carries the full explanation.
   */
  markBarResult(barIndex, kind) {
    if (barIndex == null) return;
    const b = this.bars.find((x) => x.barIndex === barIndex);
    if (b && b.el) {
      RESULT_CLASSES.forEach((c) => b.el.classList.remove(c));
      b.el.classList.add("res-" + kind);
    }
    this.notes.forEach((n) => {
      if (n.barIndex !== barIndex || !n.el) return;
      RESULT_CLASSES.forEach((c) => n.el.classList.remove(c));
      n.el.classList.add("res-" + kind);
    });
  }

  /**
   * Scroll a bar into view on purpose.
   *
   * `_revealBar` follows the bar that is *sounding*; this is the deliberate
   * version, for the moment a guessing round gives its answer.  Following the
   * bar during the question would hand the answer over before the student had
   * guessed, so the guessing chapters keep the score still until here.
   */
  revealBar(barIndex) {
    this._revealed = null;   // the same bar twice running should still scroll
    this._revealBar(barIndex);
  }

  /** Drop every answer mark — the next question starts from a clean score. */
  clearBarResults() {
    this.bars.forEach((b) => b.el && RESULT_CLASSES.forEach((c) => b.el.classList.remove(c)));
    this.notes.forEach((n) => n.el && RESULT_CLASSES.forEach((c) => n.el.classList.remove(c)));
  }

  clearBarHighlight() {
    this.notes.forEach((n) => n.el && n.el.classList.remove("is-bar-active"));
    this.clearBarBox();
  }

  clearBarBox() {
    this.bars.forEach((b) => b.el && b.el.classList.remove("is-sing"));
  }

  /** Keep the bar in play inside the visible part of the panel — the numeric
   *  score wraps just as the stave does, and on a phone it is taller than the
   *  screen.  Instant, not smoothed: a bar is highlighted only while it
   *  sounds, and an animated scroll spends most of that still travelling. */
  _revealBar(barIndex) {
    if (barIndex == null || barIndex === this._revealed) return;
    const b = this.bars.find((x) => x.barIndex === barIndex);
    const el = b && b.el;
    if (!el) return;
    this._revealed = barIndex;

    const scroller = scrollParentOf(el);
    if (!scroller) return;
    const sr = scroller === document.scrollingElement
      ? { top: 0, bottom: window.innerHeight }
      : scroller.getBoundingClientRect();
    const er = el.getBoundingClientRect();

    // The transport is sticky over the bottom of the scroller on a phone, so
    // a bar can be inside the scroller and still be behind it.
    let bottomInset = 0;
    const foot = document.querySelector(".deck-foot");
    if (foot) {
      const fr = foot.getBoundingClientRect();
      if (fr.height && fr.top < sr.bottom) bottomInset = Math.max(0, sr.bottom - fr.top);
    }

    const pad = 12;
    const visTop = sr.top + pad;
    const visBottom = sr.bottom - bottomInset - pad;
    if (visBottom <= visTop) return;

    let delta = 0;
    if (er.bottom > visBottom) delta = er.bottom - visBottom;
    else if (er.top < visTop) delta = er.top - visTop;
    if (delta) scroller.scrollTop += delta;
  }

  // ---- note highlighting ---------------------------------------------------

  highlightNote(globalIndex, opts = {}) {
    // The numeric view never scrolls to a note (the bar it is in already did
    // that), so `opts.reveal` is accepted for interface parity and unused.
    void opts;
    this.notes.forEach((n) => {
      if (n.el) n.el.classList.toggle("is-playing", n.globalIndex === globalIndex);
    });
  }

  clearHighlight() {
    this.notes.forEach((n) => n.el && n.el.classList.remove("is-playing"));
  }

  /** Colour a degree by how accurately it was sung, and leave it that way —
   *  a finished run can be read back off the numbers. */
  setNoteAccuracy(globalIndex, score) {
    const entry = this.notes.find((n) => n.globalIndex === globalIndex);
    if (!entry || !entry.el) return;
    ACCURACY_CLASSES.forEach((c) => entry.el.classList.remove(c));
    entry.el.classList.add(accuracyClass(score));
  }

  clearNoteAccuracy() {
    this.notes.forEach((n) => {
      if (n.el) ACCURACY_CLASSES.forEach((c) => n.el.classList.remove(c));
    });
  }

  getBarNoteRange(barIndex) {
    const b = this.bars.find((x) => x.barIndex === barIndex);
    if (!b) return null;
    return { start: b.noteStart, end: b.noteEnd };
  }

  getBarCount() {
    return this.bars.length;
  }

  /** Pitched (non-rest) note entries in a bar, each with globalIndex + MIDI. */
  getPitchedNotesInBar(barIndex) {
    return this.notes
      .filter((n) => n.barIndex === barIndex && !n.isRest)
      .map((n) => ({ globalIndex: n.globalIndex, midi: n.midi }));
  }

  // ---- sung-pitch marker ---------------------------------------------------
  // The stave shows the sung pitch as a notehead floating at its own height.
  // There is no height here, so the same information is given as a reading:
  // a needle over the degree being sung, pointing sharp or flat, with the
  // deviation in cents and the same three-step colouring.

  showSungNote(globalIndex, midi, targetMidi) {
    const entry = this.notes.find((n) => n.globalIndex === globalIndex);
    if (!entry || !entry.el || midi == null) return;

    if (!this._sungEl) {
      this._sungEl = document.createElement("span");
      this._sungEl.className = "num-sung";
    }
    if (this._sungEl.parentNode !== entry.el) entry.el.appendChild(this._sungEl);

    const tgt = targetMidi != null ? targetMidi : this._currentTargetMidi;
    let cls = "num-sung-off";
    let text = "?";
    if (tgt != null) {
      const diff = midi - tgt;                     // semitones, fractional
      const semis = Math.abs(diff);
      cls = semis <= 0.3 ? "num-sung-good" : semis <= 1 ? "num-sung-ok" : "num-sung-off";
      const cents = Math.round(diff * 100);
      text = semis <= 0.1 ? "•" : (cents > 0 ? "▲ +" : "▼ ") + cents;
    }
    this._sungEl.className = "num-sung " + cls;
    this._sungEl.textContent = text;
  }

  /** Remember the note slot being sung and its target pitch, so the marker
   *  has a reference and `advanceSungNote` knows where it is. */
  setSungTarget(globalIndex, targetMidi) {
    this._sungGlobal = globalIndex;
    this._currentTargetMidi = targetMidi;
  }

  /** Move the marker to the next pitched note of the same bar, or clear it
   *  once the bar is done.  Returns the new {globalIndex, midi} or null. */
  advanceSungNote() {
    if (this._sungGlobal == null) return null;
    const cur = this.notes.find((n) => n.globalIndex === this._sungGlobal);
    if (!cur) return null;
    const next = this.notes.find((n) =>
      n.barIndex === cur.barIndex && n.globalIndex > this._sungGlobal && !n.isRest);
    if (!next) { this.clearSungNote(); return null; }
    this._sungGlobal = next.globalIndex;
    this._currentTargetMidi = next.midi != null ? next.midi : this._currentTargetMidi;
    return { globalIndex: next.globalIndex, midi: this._currentTargetMidi };
  }

  clearSungNote() {
    if (this._sungEl && this._sungEl.parentNode) this._sungEl.parentNode.removeChild(this._sungEl);
    this._sungEl = null;
    this._sungGlobal = null;
    this._currentTargetMidi = null;
  }
}
