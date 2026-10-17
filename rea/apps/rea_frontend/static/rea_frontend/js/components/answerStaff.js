/**
 * answerStaff.js
 *
 * An empty staff the student writes their answer on.
 *
 * The note-guessing chapters used to be answered by clicking one of the
 * exercise's bars, which turns "what did you hear" into "which of these
 * seven did you hear" — a recognition test with the answers printed on it.
 * Writing the note is the real skill: the student hovers over the staff, a
 * notehead follows the pointer from line to space, and a click puts it down.
 *
 * Positions are diatonic steps in the document's own units (`octave * 7 +
 * letter`, octave index 1 being middle C's — see `CLEF_TOP_LINE`), so an
 * answer compares directly against the line or space the played note sits on.
 *
 * In a key (relative exercises) the staff carries the key signature and the
 * answer is a position: the key says how it is altered.  Without one
 * (absolute exercises) the answer may carry its own accidental, chosen by
 * where across the staff the pointer is — left flattens, right sharpens.
 */

import { CLEF_TOP_LINE, resolveVexFlow, vexClef } from "./staveLayout.js?v=173";
import { keyAccidentalCount } from "../notation.js?v=173";

const WIDTH = 240;
const HEIGHT = 150;
const STAVE_X = 6;
const STAVE_Y = 8;          // VexFlow puts the top line 40px under this
const STEP_PX = 5;          // half a line space
const LEDGER_STEPS = 7;     // how far past the staff a note may be written
const SVG_NS = "http://www.w3.org/2000/svg";
const LETTERS = "CDEFGAB";
const SIGNS = { "-1": "\u266d", 1: "\u266f" };

/** A diatonic step as a student reads it: "E4". */
export function stepName(step) {
  if (step == null) return "?";
  const letter = LETTERS[((step % 7) + 7) % 7];
  return letter + (Math.floor(step / 7) + 3);
}

/**
 * A sounded note named on the line or space it is written on: MIDI 58
 * written on the B line is "B♭3", not "A#3".  The answer is judged by
 * position, so the feedback should name the note by its position too.
 */
export function writtenName(step, midi) {
  if (step == null) return "?";
  const alteration = midi == null ? 0 : midi - naturalMidi(step);
  const sign = { "-2": "\uD834\uDD2B", "-1": "\u266d", 1: "\u266f", 2: "\uD834\uDD2A" }[alteration] || "";
  const name = stepName(step);
  return name.slice(0, 1) + sign + name.slice(1);
}

/** The MIDI note of a line or space with no accidental on it. */
export function naturalMidi(step) {
  return (Math.floor(step / 7) + 4) * 12 + [0, 2, 4, 5, 7, 9, 11][((step % 7) + 7) % 7];
}

/** The diatonic step a note token sits on, or null for a rest/unparsed note. */
export function tokenStep(tok) {
  if (!tok || !tok.letter) return null;
  const letter = tok.letter === "h" ? "b" : tok.letter;
  const index = "cdefgab".indexOf(letter);
  if (index < 0) return null;
  return (tok.octave ?? 0) * 7 + index;
}

export class AnswerStaff {
  /**
   * @param {HTMLElement} host
   * @param {object} opts
   * @param {function({step: number, alteration: number})} opts.onAnswer
   *   called with the note written
   */
  constructor(host, { onAnswer } = {}) {
    this.host = host;
    this.onAnswer = onAnswer || null;
    this.armed = false;
    this.chromatic = false;
    this.clef = "treble";
    this.key = "";
    this._hover = null;
    this._wired = false;
  }

  /**
   * Draw the empty staff in `clef` (a source clef name or VexFlow's) and,
   * when given, the key signature of `key` (a VexFlow key such as "D").
   * A staff with a key signature takes no accidentals on its answers.
   */
  draw(clef, key = "") {
    const VF = resolveVexFlow();
    if (!VF || !this.host) return;
    this.clef = vexClef(clef);
    this.key = key || "";
    this.chromatic = !this.key;
    this.host.innerHTML = "";
    const renderer = new VF.Renderer(this.host, VF.Renderer.Backends.SVG);
    renderer.resize(WIDTH, HEIGHT);
    const context = renderer.getContext();
    context.setFillStyle("#16171a");
    context.setStrokeStyle("#16171a");
    const stave = new VF.Stave(STAVE_X, STAVE_Y, WIDTH - STAVE_X * 2);
    try { stave.addClef(this.clef); } catch (e) { stave.addClef("treble"); }
    if (this.key && keyAccidentalCount(this.key)) {
      try { stave.addKeySignature(this.key); } catch (e) { /* the staff still takes answers */ }
    }
    stave.setContext(context).draw();

    this.svg = this.host.querySelector("svg");
    this.svg.setAttribute("viewBox", "0 0 " + WIDTH + " " + HEIGHT);
    // VexFlow sizes the SVG inline; the stylesheet scales it to its box.
    this.svg.style.width = "";
    this.svg.style.height = "";
    this.topY = stave.getYForLine(0);
    this.topStep = CLEF_TOP_LINE[this.clef] ?? CLEF_TOP_LINE.treble;
    this.bottomStep = this.topStep - 8;
    this.startX = stave.getNoteStartX();
    this.endX = stave.getX() + stave.getWidth();
    this.noteX = (this.startX + this.endX) / 2;
    this._drawZones();
    this.layer = document.createElementNS(SVG_NS, "g");
    this.layer.setAttribute("class", "as-layer");
    this.svg.appendChild(this.layer);
    this._wire();
    this._sync();
  }

  /** Take an answer: the next click on the staff is it. */
  arm() {
    this.armed = true;
    this._clearLayer();
    this._hover = null;
    this._sync();
  }

  /** Stop taking answers, keeping whatever result is drawn. */
  disarm() {
    this.armed = false;
    this._hover = null;
    this._removeGhost();
    this._sync();
  }

  /** Empty the staff and stop taking answers. */
  reset() {
    this.disarm();
    this._clearLayer();
  }

  /**
   * Show how the answer went: the note written, in green or red, and when it
   * was wrong the note that was played beside it in green.  Both are
   * `{step, alteration}`; `picked` is null when time ran out.
   */
  showResult(picked, answer, correct) {
    this.disarm();
    this._clearLayer();
    if (!picked) {
      this._drawNote(answer, this.noteX, "as-note is-correct");
    } else if (correct) {
      this._drawNote(picked, this.noteX, "as-note is-correct");
    } else {
      this._drawNote(picked, this.noteX - 26, "as-note is-wrong");
      this._drawNote(answer, this.noteX + 26, "as-note is-correct");
    }
  }

  // ---- internals -----------------------------------------------------------

  _sync() {
    if (!this.host) return;
    this.host.classList.toggle("is-armed", this.armed);
    this.host.classList.toggle("is-chromatic", this.chromatic);
    if (this.svg) this.svg.setAttribute("tabindex", this.armed ? "0" : "-1");
  }

  /** The three accidental zones, labelled under the staff: ♭ · ♮ · ♯. */
  _drawZones() {
    if (!this.chromatic) return;
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "as-zones");
    const third = (this.endX - this.startX) / 3;
    [[-1, "♭"], [0, "♮"], [1, "♯"]].forEach(([value, glyph], i) => {
      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("x", this.startX + third * (i + 0.5));
      label.setAttribute("y", HEIGHT - 6);
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("class", "as-zone");
      label.dataset.alteration = String(value);
      label.textContent = glyph;
      g.appendChild(label);
    });
    this.svg.appendChild(g);
  }

  _markZone(alteration) {
    if (!this.svg) return;
    this.svg.querySelectorAll(".as-zone").forEach((label) => {
      label.classList.toggle("is-on", alteration != null && label.dataset.alteration === String(alteration));
    });
  }

  _yFor(step) {
    return this.topY + (this.topStep - step) * STEP_PX;
  }

  _toSvg(clientX, clientY) {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (WIDTH / rect.width),
      y: (clientY - rect.top) * (HEIGHT / rect.height),
    };
  }

  /** The note under the pointer: its height picks the step, and on a staff
   *  without a key, its third of the width picks the accidental. */
  _noteAt(clientX, clientY) {
    const { x, y } = this._toSvg(clientX, clientY);
    const raw = this.topStep + Math.round((this.topY - y) / STEP_PX);
    const step = Math.max(this.bottomStep - LEDGER_STEPS, Math.min(this.topStep + LEDGER_STEPS, raw));
    let alteration = 0;
    if (this.chromatic) {
      const third = (this.endX - this.startX) / 3;
      alteration = x < this.startX + third ? -1 : x > this.endX - third ? 1 : 0;
    }
    return { step, alteration };
  }

  _wire() {
    if (this._wired) return;
    this._wired = true;
    // On the host, not the SVG: `draw` replaces the SVG, the host stays.
    const follow = (e) => {
      if (!this.armed || !this.svg) return;
      this._setHover(this._noteAt(e.clientX, e.clientY));
    };
    this.host.addEventListener("pointermove", follow);
    this.host.addEventListener("pointerdown", follow);
    this.host.addEventListener("pointerleave", () => {
      if (!this.armed) return;
      this._hover = null;
      this._removeGhost();
    });
    this.host.addEventListener("click", (e) => {
      if (!this.armed || !this.svg) return;
      e.stopPropagation();
      this._commit(this._noteAt(e.clientX, e.clientY));
    });
    // The keyboard can write a note too: up and down move it, left and right
    // choose its accidental, Enter puts it down.
    this.host.addEventListener("keydown", (e) => {
      if (!this.armed) return;
      const cur = this._hover || { step: this.topStep - 4, alteration: 0 };
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        this._setHover({ ...cur, step: cur.step + (e.key === "ArrowUp" ? 1 : -1) });
      } else if (this.chromatic && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        const next = Math.max(-1, Math.min(1, cur.alteration + (e.key === "ArrowRight" ? 1 : -1)));
        this._setHover({ ...cur, alteration: next });
      } else if ((e.key === "Enter" || e.key === " ") && this._hover) {
        e.preventDefault();
        this._commit(this._hover);
      }
    });
  }

  _commit(note) {
    if (!this.armed) return;
    this.disarm();
    this._clearLayer();
    this._drawNote(note, this.noteX, "as-note is-picked");
    if (this.onAnswer) this.onAnswer(note);
  }

  _setHover(note) {
    const h = this._hover;
    if (h && h.step === note.step && h.alteration === note.alteration) return;
    this._hover = note;
    this._removeGhost();
    this._ghost = this._drawNote(note, this.noteX, "as-note is-ghost");
    this._markZone(note.alteration);
  }

  _removeGhost() {
    if (this._ghost && this._ghost.parentNode) this._ghost.parentNode.removeChild(this._ghost);
    this._ghost = null;
    this._markZone(null);
  }

  _clearLayer() {
    this._ghost = null;
    if (this.layer) this.layer.innerHTML = "";
  }

  /** A notehead, its accidental and the ledger lines it needs. */
  _drawNote(note, x, cls) {
    if (!note || note.step == null || !this.layer) return null;
    const { step } = note;
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", cls);
    const ledger = (s) => {
      const line = document.createElementNS(SVG_NS, "line");
      const y = this._yFor(s);
      line.setAttribute("x1", x - 11); line.setAttribute("x2", x + 11);
      line.setAttribute("y1", y); line.setAttribute("y2", y);
      line.setAttribute("class", "as-ledger");
      g.appendChild(line);
    };
    for (let s = this.topStep + 2; s <= step; s += 2) ledger(s);
    for (let s = this.bottomStep - 2; s >= step; s -= 2) ledger(s);
    const y = this._yFor(step);
    const sign = SIGNS[note.alteration];
    if (sign) {
      const acc = document.createElementNS(SVG_NS, "text");
      acc.setAttribute("x", x - 11);
      acc.setAttribute("y", y + 5);
      acc.setAttribute("text-anchor", "end");
      acc.setAttribute("class", "as-acc");
      acc.textContent = sign;
      g.appendChild(acc);
    }
    const head = document.createElementNS(SVG_NS, "ellipse");
    head.setAttribute("cx", x); head.setAttribute("cy", y);
    head.setAttribute("rx", 6.2); head.setAttribute("ry", 4.4);
    head.setAttribute("transform", "rotate(-20 " + x + " " + y + ")");
    head.setAttribute("class", "as-head");
    g.appendChild(head);
    this.layer.appendChild(g);
    return g;
  }
}
