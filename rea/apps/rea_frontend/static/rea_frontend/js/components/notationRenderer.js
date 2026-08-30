/**
 * notationRenderer.js
 *
 * The practice view's stave: a score to be *read*, with
 *  - per-bar SVG references + click handling + hover styling,
 *  - per-note SVG references so the UI can highlight notes during playback,
 *  - accuracy colouring that stays on the notes after a run,
 *  - a live sung-pitch marker driven by the microphone.
 *
 * The drawing underneath — measuring, wrapping, accidentals, beaming — lives
 * in `staveLayout.js`, which the score editor draws with too.
 */

import { drawScore, durationToType, resolveVexFlow } from "./staveLayout.js?v=112";

/** Accuracy bands for `setNoteAccuracy`.  The thresholds match the per-note
 *  chips in the feedback row, so the stave and the report agree. */
const ACCURACY_CLASSES = ["vf-acc-good", "vf-acc-ok", "vf-acc-weak", "vf-acc-miss"];

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

function accuracyClass(score) {
  if (score == null) return "vf-acc-miss";
  if (score >= 70) return "vf-acc-good";
  if (score >= 40) return "vf-acc-ok";
  return "vf-acc-weak";
}

export class NotationRenderer {
  constructor(container, { width = 900 } = {}) {
    this.container = container;
    this.width = width;
    this.VF = (window.VexFlow && (window.VexFlow.Renderer || window.VexFlow.default))
      ? window.VexFlow
      : (window.Vex && (window.Vex.Flow || window.Vex))
      ? window.Vex
      : null;
    this.notes = [];
    this.bars = []; // [{ staveEl, noteStart, noteEnd, barIndex }]
    this.onBarClick = null;

    // A score is laid out against the width it is drawn into, so it has to be
    // redrawn whenever that width changes — on rotation, on a resize, and on
    // the very first paint, where the container can still measure 0 and the
    // layout falls back to its 320px floor (which drew a phone-width score in
    // a 1000px panel).  Called back through `onRelayout` so the owner can
    // re-apply whatever it had highlighted.
    this.onRelayout = null;
    this._lastDraw = null;
    this._drawnFor = 0;
    this._relayouts = 0;
    if (typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => this._maybeRelayout());
      this._ro.observe(this.container);
    }
  }

  /** Redraw if the panel's width has moved away from what we drew for.  The
   *  8px deadband and the attempt cap stop a redraw that adds or removes a
   *  scrollbar from oscillating with the one that follows it. */
  _maybeRelayout() {
    if (!this._lastDraw || this._relayoutQueued) return;
    const avail = this.container.clientWidth;
    if (!avail || Math.abs(avail - this._drawnFor) <= 8) return;
    if (this._relayouts >= 3) return;
    this._relayoutQueued = true;
    requestAnimationFrame(() => {
      this._relayoutQueued = false;
      if (!this._lastDraw) return;
      this._relayouts += 1;
      const { bars, opts } = this._lastDraw;
      this.render(bars, opts, true);
      if (this.onRelayout) this.onRelayout();
    });
  }

  clear() {
    this.container.innerHTML = "";
    this.notes = [];
    this.bars = [];
    this._revealed = null;
    this._outlineEl = null;
    this._sungEl = null;
    this._sungGlobal = null;
    this._currentTargetMidi = null;
  }

  _resolveVF() {
    return this.VF || resolveVexFlow();
  }

  _ensureVexflow() {
    const VF = this._resolveVF();
    if (!VF) {
      this.container.innerHTML =
        '<div class="empty">VexFlow not loaded. Drop the real build into ' +
        "vendor/vexflow/vexflow.min.js and reload.</div>";
      return null;
    }
    return VF;
  }

  /**
   * Render an array of bars.
   *   [{ clef, label, notes: [{ name, alias, duration, is_rest, is_enharmonic }] }]
   * `options.onBarClick` is called with the bar index when a bar is clicked.
   *
   * The drawing itself belongs to `staveLayout`, shared with the score
   * editor so a teacher's picture of an exercise and a student's are the
   * same picture.  What stays here is what only a *reading* view needs: bars
   * that answer to a click, and the highlighting the practice session drives.
   */
  render(bars, opts = {}, isRelayout = false) {
    const { clef = "treble", title = "", onBarClick = null } = opts;
    this.clear();
    if (!isRelayout) this._relayouts = 0;
    this._lastDraw = { bars, opts };
    if (!this._ensureVexflow()) return [];
    if (!bars || bars.length === 0) {
      this.container.innerHTML = '<div class="empty">No notes to display.</div>';
      return [];
    }
    this.onBarClick = onBarClick;

    const drawn = drawScore(this.container, bars);
    if (!drawn) return [];
    this._drawnFor = this.container.clientWidth;

    this.notes = drawn.notes.map((entry) => ({
      note: entry.note, el: entry.el, globalIndex: entry.globalIndex, barIndex: entry.barIndex,
    }));
    this.bars = drawn.bars.map((bar) => ({
      staveEl: bar.staveEl, stave: bar.stave, noteStart: bar.noteStart, noteEnd: bar.noteEnd,
      barIndex: bar.barIndex, x: bar.x, y: bar.y, width: bar.width,
    }));
    this.bars.forEach((bar) => bar.staveEl && bar.staveEl.classList.add("vf-bar-interactive"));

    const svgEl = drawn.svg;
    this.svgEl = svgEl;
    const staveGroups = this.bars.map((b) => b.staveEl);

    // --- Per-bar click/hover wiring -------------------------------------
    // VexFlow draws note groups (g.vf-stavenote) as *siblings* of, and on top
    // of, the stave group, so a click on a notehead/beam never reaches the
    // stave's own handler.  We attach a delegated listener to the notation
    // container and hit-test the click against each bar's screen rectangle
    // (getBoundingClientRect on the stave group - robust regardless of SVG
    // coordinate transforms or scrolling).  A nearest-bar fallback covers
    // noteheads/beams that sit above or below the staff box, so the whole bar
    // area is clickable, not just the staff lines.
    if (svgEl) {
      svgEl.style.cursor = "pointer";

      const barRects = () => staveGroups.map((g, i) => {
        if (!g) return null;
        const r = g.getBoundingClientRect();
        return { x0: r.left, x1: r.right, y0: r.top, y1: r.bottom, barIndex: i };
      });

      const hitTest = (clientX, clientY) => {
        const rects = barRects();
        // 1) direct hit inside a bar's rect
        for (const r of rects) {
          if (!r) continue;
          if (clientX >= r.x0 && clientX <= r.x1 && clientY >= r.y0 && clientY <= r.y1) return r.barIndex;
        }
        // 2) nearest bar by vertical distance among bars overlapping clientX
        let best = null, bestDist = Infinity;
        for (const r of rects) {
          if (!r) continue;
          if (clientX < r.x0 || clientX > r.x1) continue;
          const dist = (clientY < r.y0) ? (r.y0 - clientY)
                     : (clientY > r.y1) ? (clientY - r.y1) : 0;
          if (dist < bestDist) { bestDist = dist; best = r.barIndex; }
        }
        return best;
      };

      this.container.addEventListener("click", (e) => {
        const idx = hitTest(e.clientX, e.clientY);
        if (idx != null && this.onBarClick) this.onBarClick(idx);
      });

      this.container.addEventListener("mousemove", (e) => {
        const idx = hitTest(e.clientX, e.clientY);
        staveGroups.forEach((g) => g && g.classList.remove("vf-bar-hover"));
        if (idx != null && staveGroups[idx]) staveGroups[idx].classList.add("vf-bar-hover");
      });

      this.container.addEventListener("mouseleave", () => {
        staveGroups.forEach((g) => g && g.classList.remove("vf-bar-hover"));
      });
    }

    return this.notes;
  }

  /** Highlight all notes in a bar (e.g. when it's the active bar). */
  highlightBar(barIndex) {
    this.notes.forEach((entry) => {
      if (!entry.el) return;
      if (entry.barIndex === barIndex) entry.el.classList.add("vf-bar-active");
      else entry.el.classList.remove("vf-bar-active");
    });
    this.highlightBarBox(barIndex);
  }

  /**
   * Keep the bar in play inside the visible part of the score.
   *
   * A wrapped score is taller than the panel it sits in — on a phone by
   * several screens — so without this the highlight walks off the bottom and
   * the student is left watching a stave that isn't the one sounding.
   * `block: "nearest"` scrolls only when the bar is actually out of view, so
   * a score that already fits never twitches, and it walks whichever ancestor
   * is the scroller: the score panel on a wide screen, the page on a phone.
   */
  _revealBar(barIndex) {
    if (barIndex == null || barIndex === this._revealed) return;
    const b = this.bars.find((x) => x.barIndex === barIndex);
    const el = b && b.staveEl;
    if (!el || !el.scrollIntoView) return;
    this._revealed = barIndex;

    const scroller = scrollParentOf(el);
    if (!scroller) return;
    const sr = scroller === document.scrollingElement
      ? { top: 0, bottom: window.innerHeight }
      : scroller.getBoundingClientRect();
    const er = el.getBoundingClientRect();

    // The transport is sticky over the bottom of the scroller on a phone, so
    // a bar can be inside the scroller and still be behind it.  Inset by
    // however much the two actually overlap — on a wide screen the transport
    // sits below the score panel and the overlap is zero.
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
    if (!delta) return;

    // Instant, not smoothed.  A bar is highlighted for as long as it sounds,
    // and an animated scroll spends much of that time still travelling — the
    // eye arrives after the note has gone.  It also degrades badly: a smooth
    // scroll that the browser declines to animate simply never happens.
    scroller.scrollTop += delta;
  }

  /** Visually frame a bar's stave box (e.g. the bar to sing). */
  highlightBarBox(barIndex) {
    this.bars.forEach((b) => {
      if (!b.staveEl) return;
      if (b.barIndex === barIndex) b.staveEl.classList.add("vf-bar-sing");
      else b.staveEl.classList.remove("vf-bar-sing");
    });
    this._drawBarOutline(barIndex);
    this._revealBar(barIndex);
  }

  /**
   * Draw a prominent rectangle outline (SVG overlay) around a bar so the user
   * instantly sees which bar to sing.  The outline wraps the whole bar area
   * (staff + noteheads/ledger lines) and is vertically centred on the staff,
   * sitting on top of the notation.  Position is derived from the stave
   * group's real screen rectangle (converted into SVG user space) so it stays
   * correct regardless of wrapping/scrolling.
   */
  _drawBarOutline(barIndex) {
    if (this._outlineEl) { this._outlineEl.remove(); this._outlineEl = null; }
    const svg = this.svgEl || this.container.querySelector("svg");
    if (!svg) return;
    const b = this.bars.find((x) => x.barIndex === barIndex);
    if (!b) return;

    // Resolve the bar's vertical extent from the stave group's bounding rect,
    // mapped back into SVG user units (the SVG renders 1:1, so we just
    // subtract the SVG origin).  The staff box itself is short; expand it
    // vertically so the outline also encloses the noteheads & ledger lines,
    // and centre the outline on the staff's vertical midpoint.
    let y, h;
    const staveEl = b.staveEl;
    if (staveEl && svg.getBoundingClientRect) {
      const sr = staveEl.getBoundingClientRect();
      const vr = svg.getBoundingClientRect();
      const top = sr.top - vr.top;
      const bottom = sr.bottom - vr.top;
      const staffMid = (top + bottom) / 2;
      h = (bottom - top) + 48;          // envelope noteheads + ledger lines
      y = staffMid - h / 2;             // vertically centred on the staff
    } else {
      const pad = 6;
      y = b.y - pad - 14;
      h = 84;
    }

    const xpad = 6;
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", b.x - xpad);
    rect.setAttribute("y", y);
    rect.setAttribute("width", b.width + xpad * 2);
    rect.setAttribute("height", h);
    rect.setAttribute("rx", 8);
    rect.setAttribute("ry", 8);
    rect.setAttribute("class", "vf-bar-outline");
    svg.appendChild(rect);
    this._outlineEl = rect;
  }

  clearBarHighlight() {
    this.notes.forEach((entry) => entry.el && entry.el.classList.remove("vf-bar-active"));
    this.clearBarBox();
  }

  clearBarBox() {
    this.bars.forEach((b) => b.staveEl && b.staveEl.classList.remove("vf-bar-sing"));
    if (this._outlineEl) { this._outlineEl.remove(); this._outlineEl = null; }
  }

  /**
   * Colour a notehead by how accurately it was sung, and leave it that way.
   *
   * Unlike `highlightNote` (a transient playback cursor) this is a *result*:
   * it stays on the stave for the rest of the session, so once a run is over
   * the score itself shows which notes were off and which were clean.
   *
   * @param {number} globalIndex  note slot on the stave
   * @param {number|null} score   0-100, or null for a note that was never sung
   */
  setNoteAccuracy(globalIndex, score) {
    const entry = this.notes.find((n) => n.globalIndex === globalIndex);
    if (!entry || !entry.el) return;
    ACCURACY_CLASSES.forEach((c) => entry.el.classList.remove(c));
    entry.el.classList.add(accuracyClass(score));
  }

  /** Drop every accuracy colour (a fresh run starts from a clean stave). */
  clearNoteAccuracy() {
    this.notes.forEach((n) => {
      if (n.el) ACCURACY_CLASSES.forEach((c) => n.el.classList.remove(c));
    });
  }

  /** Return the global note-index range for a bar. */
  getBarNoteRange(barIndex) {
    const b = this.bars.find((x) => x.barIndex === barIndex);
    if (!b) return null;
    return { start: b.noteStart, end: b.noteEnd };
  }

  getBarCount() {
    return this.bars.length;
  }



  highlightNote(globalIndex) {
    this.notes.forEach((entry) => {
      if (!entry.el) return;
      if (entry.globalIndex === globalIndex) entry.el.classList.add("vf-note-active");
      else entry.el.classList.remove("vf-note-active");
    });
    const active = this.notes.find((n) => n.globalIndex === globalIndex);
    if (active && active.el && active.el.scrollIntoView) {
      active.el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }

  clearHighlight() {
    this.notes.forEach((entry) => {
      if (entry.el) entry.el.classList.remove("vf-note-active");
    });
  }

  // ---- sung-pitch preview overlay ---------------------------------------
  // During singing exercises a live "preview" notehead is drawn over the
  // staff at the pitch the microphone hears, positioned at the x of the
  // reference note currently being sung.  Its colour reflects accuracy
  // (green ≈ in tune, amber ≈ off).  When the sung pitch matches the target
  // note the controller calls advanceSungNote() to move the marker to the
  // next reference note in the bar.

  /** Continuous VexFlow staff-line index for a (possibly fractional) MIDI
   *  pitch on a treble clef.  VexFlow counts lines from the TOP: line 0 = F5
   *  (top line), line 4 = E4 (bottom line).
   *
   *  A natural note lands exactly on its own line/space (so singing the exact
   *  target pitch parks the marker right on the notehead), and the position
   *  moves *continuously* with pitch: each semitone advances the marker, with
   *  accidentals sitting half a diatonic step between their neighbours.  This
   *  matters for a live pitch marker — mapping accidentals onto the natural
   *  letter's line (as ordinary notation does) would freeze the marker for a
   *  whole tone at a time and read as stepped, glitchy motion during a glide. */
  _midiToLineIndex(midi) {
    // Diatonic sub-position of each pitch class within its octave: naturals on
    // whole steps (C=0, D=1, ... B=6), accidentals halfway between.
    const CHROMA_TO_DIATONIC = [0, 0.5, 1, 1.5, 2, 3, 3.5, 4, 4.5, 5, 5.5, 6];
    const f5 = 3 + 7 * 5;                        // F5 diatonic index (top line)
    const octave = Math.floor(midi / 12) - 1;    // MIDI octave (C4 -> 4)
    const pc = midi - Math.floor(midi / 12) * 12; // fractional pitch class [0,12)
    const lo = Math.floor(pc);
    const frac = pc - lo;
    const a = CHROMA_TO_DIATONIC[lo];
    const b = lo === 11 ? 7 : CHROMA_TO_DIATONIC[lo + 1]; // B -> next-octave C
    const di = (a + (b - a) * frac) + 7 * octave; // absolute diatonic index
    return (f5 - di) * 0.5;                       // 0.5 line per diatonic step
  }

  /** Screen-x centre (in SVG user units) of the note at a global index. */
  _noteCentreXByGlobal(globalIndex) {
    const svg = this.svgEl || this.container.querySelector("svg");
    const entry = this.notes.find((n) => n.globalIndex === globalIndex);
    if (!entry || !entry.el || !svg) return null;
    const nr = entry.el.getBoundingClientRect();
    const vr = svg.getBoundingClientRect();
    return nr.left + nr.width / 2 - vr.left;
  }

  /** Draw or update the sung-pitch notehead over the given global note slot.
   *  The marker is placed at the *actual* tracked pitch — no octave folding,
   *  no extra position smoothing.  The pitch detector already delivers a
   *  stable, correctly-octaved, fractional MIDI value, so the marker's only
   *  job is to render it faithfully: apply the renderer's own logic and it
   *  ends up lagging and octave-shifted relative to what was actually sung.
   *  `_midiToLineIndex` interpolates the staff position fractionally, so a
   *  smooth incoming pitch already yields smooth vertical motion. */
  showSungNote(globalIndex, midi, targetMidi) {
    const svg = this.svgEl || this.container.querySelector("svg");
    if (!svg) return;
    const entry = this.notes.find((n) => n.globalIndex === globalIndex);
    if (!entry) return;
    const b = this.bars.find((x) => x.barIndex === entry.barIndex);
    if (!b || !b.stave) return;
    const x = this._noteCentreXByGlobal(globalIndex);
    if (x == null) return;

    const y = b.stave.getYForLine(this._midiToLineIndex(midi));
    if (!isFinite(y)) return;

    if (!this._sungEl) {
      this._sungEl = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
      this._sungEl.setAttribute("rx", 7);
      this._sungEl.setAttribute("ry", 5.5);
      svg.appendChild(this._sungEl);
    }
    this._sungEl.setAttribute("cx", x);
    this._sungEl.setAttribute("cy", y);
    // Colour by how close the sung pitch is to the target — octave-aware, so
    // the colour matches the marker's true position on the staff (an octave
    // off reads as off, not in tune).  Uses the fractional pitch so it's
    // cents-sensitive.
    const tgt = targetMidi != null ? targetMidi : this._currentTargetMidi;
    let cls = "vf-sung-off";
    if (tgt != null) {
      const semis = Math.abs(midi - tgt);
      cls = semis <= 0.3 ? "vf-sung-good" : semis <= 1 ? "vf-sung-ok" : "vf-sung-off";
    }
    this._sungEl.setAttribute("class", "vf-sung-note " + cls);
  }

  /** Remember the current target note slot + pitch so the controller can ask
   *  to advance to the next pitched note in the bar (and so the marker colour
   *  has a reference when `showSungNote` is called without an explicit one). */
  setSungTarget(globalIndex, targetMidi) {
    this._sungGlobal = globalIndex;
    this._currentTargetMidi = targetMidi;
  }

  /** Advance the sung marker to the next pitched note after the current one.
   *  Returns the new {globalIndex, midi} or null if past the last note. */
  advanceSungNote() {
    if (this._sungGlobal == null) return null;
    const entry = this.notes.find((n) => n.globalIndex === this._sungGlobal);
    if (!entry) return null;
    const barIndex = entry.barIndex;
    // next pitched note (skip rests) after the current global index
    const next = this.notes.find((n) => n.barIndex === barIndex && n.globalIndex > this._sungGlobal && this._isPitched(n));
    if (!next) { this.clearSungNote(); return null; }
    const midi = this._noteEntryMidi(next);
    this._sungGlobal = next.globalIndex;
    this._currentTargetMidi = midi;
    return { globalIndex: next.globalIndex, midi };
  }

  _isPitched(entry) {
    // rests are StaveNote with duration ending in 'r'
    try { return !/r$/.test(entry.note.getDuration ? entry.note.getDuration() : ""); } catch (e) { return true; }
  }

  /** Best-effort MIDI for a rendered note entry (from its note_name). */
  _noteEntryMidi(entry) {
    // The renderer stores the original note objects without MIDI; recompute
    // via the note's keys if available, else leave target unchanged.
    try {
      const keys = entry.note.keys || [];
      if (!keys.length) return this._currentTargetMidi;
      return this._vexKeyToMidi(keys[0]);
    } catch (e) { return this._currentTargetMidi; }
  }

  _vexKeyToMidi(key) {
    // e.g. "c/4", "f#/5" -> MIDI
    const m = key.match(/^([a-g])([#b]*)(?:\/(\d+))?$/);
    if (!m) return null;
    const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1]];
    let pc = base;
    if (m[2]) for (const c of m[2]) pc += c === "#" ? 1 : c === "b" ? -1 : 0;
    const oct = m[3] ? parseInt(m[3], 10) : 4;
    return 12 * (oct + 1) + pc;
  }

  /** Pitched (non-rest) note entries in a bar, each with globalIndex + MIDI. */
  getPitchedNotesInBar(barIndex) {
    const out = [];
    this.notes.forEach((entry) => {
      if (entry.barIndex !== barIndex) return;
      if (!this._isPitched(entry)) return;
      const midi = this._noteEntryMidi(entry);
      out.push({ globalIndex: entry.globalIndex, midi });
    });
    return out;
  }

  clearSungNote() {
    if (this._sungEl) { this._sungEl.remove(); this._sungEl = null; }
    this._sungGlobal = null;
    this._currentTargetMidi = null;
  }

  _durToType(d) {
    return durationToType(d);
  }
}