/**
 * scoreCanvas.js
 *
 * The stave the teacher edits.
 *
 * The notes are drawn by `staveLayout`, the same module the practice view
 * uses, so an exercise looks the same here as it does in front of a student —
 * same bar widths, same wrapping, same accidental rules, same beams.  What
 * this file adds is everything editing needs and reading does not: which note
 * is under the pointer, what pitch a staff position means, where a click
 * would insert, and how a selection is drawn.
 *
 * Properties that have no notation of their own are drawn as annotations
 * under the stave: a note's timing nudge, its loudness, its scale-degree
 * alias.  They are what makes these exercises what they are, and a teacher
 * cannot balance them if the only way to see them is to click each note.
 * They are also the only thing that changes the score's geometry — the rows
 * gain room for the lanes — so switching all three off leaves the stave
 * pixel-identical to the practice view.
 */

import { METRICS, drawScore, resolveVexFlow } from "../components/staveLayout.js?v=107";
import { LETTERS, buildToken, splitToken } from "./scoreDoc.js?v=107";

/** Vertical room added to each row when annotation lanes are showing. */
const LANE_SPACE = 58;

/** F5 — VexFlow's top stave line — in the document's own diatonic units. */
const TOP_LINE_DIATONIC = 2 * 7 + LETTERS.indexOf("f");

const SVG_NS = "http://www.w3.org/2000/svg";

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
  return node;
}

export class ScoreCanvas {
  /**
   * @param {HTMLElement} container
   * @param {object} handlers  callbacks into the editor controller
   */
  constructor(container, handlers = {}) {
    this.container = container;
    this.handlers = handlers;
    this.notes = [];   // [{barIndex, noteIndex, el, stave}]
    this.barBoxes = []; // [{barIndex, stave, x, y, width, staveEl}]
    this.doc = null;
    this.view = { degrees: true, offsets: true, volumes: false };
    this.selection = { notes: [], bars: [] };
    this.playing = null;
    this.rowExtra = 0;
    this._bindPointer();
  }

  /** VexFlow, however the vendored build exposed itself. */
  _vf() {
    return resolveVexFlow();
  }

  /** Extra row height for the annotation lanes — none when they are all off. */
  _rowExtra() {
    const { degrees, offsets, volumes } = this.view;
    return (degrees || offsets || volumes) ? LANE_SPACE : 0;
  }

  setView(view) {
    Object.assign(this.view, view);
    this.render();
  }

  /** Draw *doc* with *selection* highlighted. */
  render(doc = this.doc, selection = this.selection) {
    this.doc = doc;
    this.selection = selection || { notes: [], bars: [] };
    if (!doc) return;
    if (!this._vf()) {
      this.container.innerHTML =
        '<div class="ed-empty">VexFlow did not load — the stave cannot be drawn.</div>';
      return;
    }

    this.container.innerHTML = "";
    this.notes = [];
    this.barBoxes = [];

    // The document's own shape, translated into what the shared renderer
    // takes.  Nothing about the drawing is decided here.
    const bars = (doc.bars || []).map((bar) => ({
      label: bar.label || "",
      notes: (bar.events || []).map((event) => ({
        name: event.note_name,
        duration: event.duration,
        is_rest: event.is_rest,
      })),
    }));

    this.rowExtra = this._rowExtra();
    const drawn = drawScore(this.container, bars, { rowExtra: this.rowExtra });
    if (!drawn) return;

    this.svg = drawn.svg;
    if (this.svg) this.svg.classList.add("ed-svg");
    this.notes = drawn.notes.map((entry) => ({
      barIndex: entry.barIndex, noteIndex: entry.noteIndex, el: entry.el,
    }));
    this.barBoxes = drawn.bars.map((bar) => ({
      barIndex: bar.barIndex, stave: bar.stave, staveEl: bar.staveEl,
      x: bar.x, y: bar.y, width: bar.width, row: bar.row,
    }));

    this._decorateBars(this.svg, doc.bars || []);
    this._decorateNotes(this.svg, doc.bars || []);
    this._paintSelection();
    if (this.playing) this._paintPlayhead();
  }

  /** Redraw when the canvas changes size, so a resized window re-wraps the
   *  bars instead of leaving the score cut off or floating in a wide gap. */
  watchResize() {
    if (typeof ResizeObserver === "undefined" || this._resizeObserver) return;
    let width = this.container.clientWidth;
    this._resizeObserver = new ResizeObserver(() => {
      const next = this.container.clientWidth;
      if (Math.abs(next - width) < 12) return;
      width = next;
      this.render();
    });
    this._resizeObserver.observe(this.container);
  }

  // -- annotations -------------------------------------------------------

  /** A bar's vertical extent in SVG coordinates, read from the stave itself.
   *
   *  Everything the editor draws around a bar — its hit area, its number, its
   *  selection frame — hangs off the staff lines rather than off the layout
   *  constants, so the chrome follows the shared renderer wherever it puts
   *  the stave.  `reach` is the room allowed above and below for ledger
   *  lines: this library spends much of its time an octave under the staff,
   *  and a click down there has to be able to write a note. */
  _barSpan(box, reach = 34) {
    const top = box.stave ? box.stave.getYForLine(0) : box.y;
    const bottom = box.stave ? box.stave.getYForLine(4) : box.y + 40;
    return { top: top - reach, bottom: bottom + reach, line0: top, line4: bottom };
  }

  _decorateBars(svg, bars) {
    if (!svg) return;
    this.barBoxes.forEach((box) => {
      const bar = bars[box.barIndex];
      if (!bar) return;

      const span = this._barSpan(box);

      // A hit area covering the whole bar, drawn first so it sits under the
      // notes: clicks on empty staff land here and become insertions.
      const hit = el("rect", {
        x: box.x, y: span.top, width: box.width, height: span.bottom - span.top,
        class: "ed-bar-hit", "data-bar": box.barIndex,
      });
      svg.insertBefore(hit, svg.firstChild);

      // The bar's own label is drawn by the shared renderer, exactly as the
      // practice view draws it; these two are the editor's additions.
      const number = el("text", {
        x: box.x + 3, y: span.line0 - 18, class: "ed-bar-number",
      });
      number.textContent = String(box.barIndex + 1);
      svg.appendChild(number);

      if (bar.is_incomplete_bar) {
        const flag = el("text", {
          x: box.x + box.width - 6, y: span.line0 - 18,
          class: "ed-bar-flag", "text-anchor": "end",
        });
        flag.textContent = `pickup ×${bar.incomplete_bar_playback_count || 0}`;
        svg.appendChild(flag);
      }
      if (!(bar.events || []).length) {
        const noteStart = box.stave ? box.stave.getNoteStartX() : box.x;
        const hint = el("text", {
          x: (noteStart + box.x + box.width) / 2, y: span.line4 + 22,
          class: "ed-bar-empty", "text-anchor": "middle",
        });
        hint.textContent = "click to add a note";
        svg.appendChild(hint);
      }
    });
  }

  _decorateNotes(svg, bars) {
    if (!svg) return;
    const svgRect = svg.getBoundingClientRect();

    // The annotation lanes start below the lowest thing drawn in the bar.  A
    // fixed offset under the stave works until a phrase sits low in the
    // register — exactly where these exercises spend much of their time — and
    // then the degrees are written over the noteheads they belong to.
    const lanes = new Map();
    this.barBoxes.forEach((box) => {
      const span = this._barSpan(box, 0);
      let bottom = span.line4;
      this.notes.forEach((entry) => {
        if (entry.barIndex !== box.barIndex || !entry.el) return;
        const rect = entry.el.getBoundingClientRect();
        bottom = Math.max(bottom, rect.bottom - svgRect.top);
      });
      const floor = box.y + METRICS.ROW_HEIGHT + (this.rowExtra || 0) - 26;
      lanes.set(box.barIndex, Math.min(bottom + 14, floor));
    });

    this.notes.forEach((entry) => {
      const bar = bars[entry.barIndex];
      const event = bar && bar.events[entry.noteIndex];
      if (!event || !entry.el) return;
      entry.el.classList.add("ed-note");
      entry.el.dataset.bar = entry.barIndex;
      entry.el.dataset.note = entry.noteIndex;

      const rect = entry.el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2 - svgRect.left;
      const baseY = lanes.get(entry.barIndex) || 0;

      if (this.view.degrees && event.alias_degree) {
        const text = el("text", { x: cx, y: baseY, class: "ed-ann ed-ann-degree", "text-anchor": "middle" });
        text.textContent = event.alias_degree;
        svg.appendChild(text);
      }
      if (this.view.offsets && event.horizontal_offset_ms) {
        const value = event.horizontal_offset_ms;
        const text = el("text", {
          x: cx, y: baseY + 16, class: `ed-ann ed-ann-offset ${value < 0 ? "early" : "late"}`,
          "text-anchor": "middle",
        });
        text.textContent = `${value > 0 ? "+" : ""}${value}`;
        svg.appendChild(text);
        // A tick showing which way the note is nudged, so a line of offsets
        // reads as a shape rather than as a column of numbers.
        svg.appendChild(el("line", {
          x1: cx, y1: baseY + 21, x2: cx + Math.max(-14, Math.min(14, value * 1.6)), y2: baseY + 21,
          class: `ed-ann-offset-tick ${value < 0 ? "early" : "late"}`,
        }));
      }
      if (this.view.volumes) {
        const height = Math.round(((event.volume || 80) / 127) * 22);
        svg.appendChild(el("rect", {
          x: cx - 3, y: baseY + 34 - height, width: 6, height,
          class: "ed-ann-volume", rx: 1,
        }));
      }
      if (event.is_enharmonic) {
        const box = this.barBoxes.find((b) => b.barIndex === entry.barIndex);
        const y = box ? this._barSpan(box, 0).line0 - 6 : baseY;
        const mark = el("text", { x: cx + 9, y, class: "ed-ann-enh" });
        mark.textContent = "e";
        svg.appendChild(mark);
      }
    });
  }

  _paintSelection() {
    if (!this.svg) return;
    this.svg.querySelectorAll(".ed-sel-box, .ed-bar-sel").forEach((n) => n.remove());
    const svgRect = this.svg.getBoundingClientRect();

    (this.selection.bars || []).forEach((barIndex) => {
      const box = this.barBoxes.find((b) => b.barIndex === barIndex);
      if (!box) return;
      const span = this._barSpan(box, 26);
      this.svg.insertBefore(el("rect", {
        x: box.x - 4, y: span.top, width: box.width + 8, height: span.bottom - span.top,
        rx: 8, class: "ed-bar-sel",
      }), this.svg.firstChild);
    });

    (this.selection.notes || []).forEach((pos, i) => {
      const entry = this.notes.find(
        (n) => n.barIndex === pos.barIndex && n.noteIndex === pos.noteIndex
      );
      if (!entry || !entry.el) return;
      entry.el.classList.add("is-selected");
      const rect = entry.el.getBoundingClientRect();
      this.svg.appendChild(el("rect", {
        x: rect.left - svgRect.left - 6, y: rect.top - svgRect.top - 5,
        width: rect.width + 12, height: rect.height + 10,
        rx: 5, class: `ed-sel-box${i === 0 ? " is-anchor" : ""}`,
      }));
    });
  }

  /** Mark the note currently sounding, or clear with `null`. */
  setPlayhead(position) {
    this.playing = position;
    if (!this.svg) return;
    this.notes.forEach((n) => n.el && n.el.classList.remove("is-playing"));
    this._paintPlayhead();
  }

  _paintPlayhead() {
    if (!this.playing) return;
    const entry = this.notes.find(
      (n) => n.barIndex === this.playing.barIndex && n.noteIndex === this.playing.noteIndex
    );
    if (entry && entry.el) entry.el.classList.add("is-playing");
  }

  // -- pointer -----------------------------------------------------------

  /** The note under a client point, if any. */
  _noteAt(clientX, clientY) {
    let best = null;
    let bestDistance = Infinity;
    this.notes.forEach((entry) => {
      if (!entry.el) return;
      const r = entry.el.getBoundingClientRect();
      const inside = clientX >= r.left - 6 && clientX <= r.right + 6
        && clientY >= r.top - 6 && clientY <= r.bottom + 6;
      if (!inside) return;
      const dx = clientX - (r.left + r.width / 2);
      const dy = clientY - (r.top + r.height / 2);
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) { bestDistance = distance; best = entry; }
    });
    return best;
  }

  /** The bar under a client point, if any. */
  _barAt(clientX, clientY) {
    if (!this.svg) return null;
    const svgRect = this.svg.getBoundingClientRect();
    const x = clientX - svgRect.left;
    const y = clientY - svgRect.top;
    let fallback = null;
    for (const box of this.barBoxes) {
      const withinX = x >= box.x - METRICS.BAR_GAP / 2
        && x <= box.x + box.width + METRICS.BAR_GAP / 2;
      if (!withinX) continue;
      const span = this._barSpan(box);
      if (y >= span.top && y <= span.bottom) return box;
      // A generous second pass, so a click just past the ledger lines still
      // finds the bar it obviously belongs to rather than nothing at all.
      const reach = this._barSpan(box, 60);
      if (!fallback && y >= reach.top && y <= reach.bottom) fallback = box;
    }
    return fallback;
  }

  /**
   * The note token a staff position means.
   *
   * Rounds to the nearest line *or* space, so a click lands on a pitch a
   * musician would recognise rather than between two.
   */
  pitchAt(box, clientY) {
    if (!box || !box.stave) return "c1";
    const svgRect = this.svg.getBoundingClientRect();
    const y = clientY - svgRect.top;
    const top = box.stave.getYForLine(0);
    const lineHeight = box.stave.getYForLine(1) - top;
    if (!lineHeight) return "c1";
    const steps = Math.round(((y - top) / lineHeight) * 2);   // half-lines below F5
    const diatonic = TOP_LINE_DIATONIC - steps;
    const octave = Math.floor(diatonic / 7);
    if (octave < 0 || octave > 9) return "c1";
    return buildToken({ letter: LETTERS[((diatonic % 7) + 7) % 7], octave, modifier: null });
  }

  /** Where in a bar a click at *clientX* would insert. */
  insertIndexAt(barIndex, clientX) {
    const inBar = this.notes.filter((n) => n.barIndex === barIndex && n.el);
    for (let i = 0; i < inBar.length; i += 1) {
      const r = inBar[i].el.getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return inBar[i].noteIndex;
    }
    return inBar.length ? inBar[inBar.length - 1].noteIndex + 1 : 0;
  }

  _bindPointer() {
    const container = this.container;

    container.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const note = this._noteAt(e.clientX, e.clientY);
      if (note) {
        e.preventDefault();
        this._beginDrag(e, note);
        return;
      }
      const box = this._barAt(e.clientX, e.clientY);
      if (!box) return;
      e.preventDefault();
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        // Modifier-click on empty staff means "select this bar", never
        // "insert here" — an accidental note is the one edit that is
        // annoying to undo while reading a score.
        this.handlers.onSelectBar && this.handlers.onSelectBar(box.barIndex, e);
        return;
      }
      this.handlers.onInsert && this.handlers.onInsert({
        barIndex: box.barIndex,
        noteIndex: this.insertIndexAt(box.barIndex, e.clientX),
        noteName: this.pitchAt(box, e.clientY),
      });
    });

    container.addEventListener("dblclick", (e) => {
      const note = this._noteAt(e.clientX, e.clientY);
      if (note) return;
      const box = this._barAt(e.clientX, e.clientY);
      if (box) this.handlers.onSelectBar && this.handlers.onSelectBar(box.barIndex, e);
    });

    container.addEventListener("mousemove", (e) => {
      if (this._drag) return;
      const note = this._noteAt(e.clientX, e.clientY);
      container.classList.toggle("is-over-note", !!note);
      this.notes.forEach((n) => n.el && n.el.classList.toggle("is-hover", n === note));
    });

    container.addEventListener("mouseleave", () => {
      this.notes.forEach((n) => n.el && n.el.classList.remove("is-hover"));
    });
  }

  /**
   * Dragging a note.
   *
   * The drag shows a ghost and commits once, on release: a pitch dragged
   * across five lines should be one undo step, not five, and the document
   * should never see the pitches the pointer merely passed over.
   */
  _beginDrag(event, note) {
    const position = { barIndex: note.barIndex, noteIndex: note.noteIndex };
    this.handlers.onSelectNote && this.handlers.onSelectNote(position, event);

    const start = { x: event.clientX, y: event.clientY };
    const bar = this.doc.bars[note.barIndex];
    const source = bar && bar.events[note.noteIndex];
    if (!source) return;
    const offsetDrag = event.altKey;
    const box = this.barBoxes.find((b) => b.barIndex === note.barIndex);
    const lineHeight = box && box.stave
      ? (box.stave.getYForLine(1) - box.stave.getYForLine(0)) : 10;

    this._drag = { position, start, moved: false, offsetDrag, delta: 0 };

    const onMove = (e) => {
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!this._drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      this._drag.moved = true;
      if (offsetDrag) {
        this._drag.delta = Math.round(dx / 6);
        this._showDragHint(`offset ${this._drag.delta >= 0 ? "+" : ""}${
          Math.max(-60, Math.min(60, (source.horizontal_offset_ms || 0) + this._drag.delta))}`, e);
      } else {
        this._drag.delta = -Math.round((dy / lineHeight) * 2);
        this._showDragGhost(note, this._drag.delta, e);
      }
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      this._clearDragChrome();
      const drag = this._drag;
      this._drag = null;
      if (!drag || !drag.moved || !drag.delta) return;
      if (drag.offsetDrag) {
        this.handlers.onOffsetDrag && this.handlers.onOffsetDrag(drag.position, drag.delta);
      } else {
        this.handlers.onPitchDrag && this.handlers.onPitchDrag(drag.position, drag.delta);
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  _showDragGhost(note, steps, event) {
    if (!this.svg || !note.el) return;
    const box = this.barBoxes.find((b) => b.barIndex === note.barIndex);
    if (!box || !box.stave) return;
    const svgRect = this.svg.getBoundingClientRect();
    const rect = note.el.getBoundingClientRect();
    const lineHeight = box.stave.getYForLine(1) - box.stave.getYForLine(0);
    const cx = rect.left + rect.width / 2 - svgRect.left;
    const cy = rect.top + rect.height / 2 - svgRect.top - (steps * lineHeight) / 2;
    if (!this._ghost) {
      this._ghost = el("ellipse", { rx: 7, ry: 5.5, class: "ed-drag-ghost" });
      this.svg.appendChild(this._ghost);
    }
    this._ghost.setAttribute("cx", cx);
    this._ghost.setAttribute("cy", cy);
    const bar = this.doc.bars[note.barIndex];
    const source = bar && bar.events[note.noteIndex];
    if (source) {
      const { letter, octave } = splitToken(source.note_name);
      const target = octave * 7 + LETTERS.indexOf(letter) + steps;
      this._showDragHint(
        buildToken({
          letter: LETTERS[((target % 7) + 7) % 7],
          octave: Math.floor(target / 7),
          modifier: splitToken(source.note_name).modifier,
        }),
        event
      );
    }
  }

  _showDragHint(text, event) {
    if (!this._hint) {
      this._hint = document.createElement("div");
      this._hint.className = "ed-drag-hint";
      document.body.appendChild(this._hint);
    }
    this._hint.textContent = text;
    this._hint.style.left = `${event.clientX + 14}px`;
    this._hint.style.top = `${event.clientY - 26}px`;
  }

  _clearDragChrome() {
    if (this._ghost) { this._ghost.remove(); this._ghost = null; }
    if (this._hint) { this._hint.remove(); this._hint = null; }
  }

  /** Scroll a note into view — used when the keyboard moves the selection. */
  revealNote(position) {
    const entry = this.notes.find(
      (n) => n.barIndex === position.barIndex && n.noteIndex === position.noteIndex
    );
    if (entry && entry.el && entry.el.scrollIntoView) {
      entry.el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }
  }
}
