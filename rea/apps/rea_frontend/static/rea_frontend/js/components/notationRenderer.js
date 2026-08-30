/**
 * notationRenderer.js
 *
 * Renders a sequence of bars (each with a list of notes) onto an SVG stave
 * using VexFlow 5, with:
 *  - a key signature drawn on the first stave,
 *  - accidentals that follow standard carry rules (only drawn on change),
 *  - variable bar widths sized so every note fits - including the first bar,
 *  - whitespace gaps between bars,
 *  - beaming of eighth/sixteenth notes into beat groups (flags -> beams),
 *  - per-bar SVG references + click handling + hover styling,
 *  - per-note SVG references so the UI can highlight notes during playback.
 */

import { modeChordToVexKey, noteNameToVexflow, parseNoteToken } from "../notation.js?v=76";

const PX_PER_WHOLE = 260;
const STAVE_PADDING = 26;
const MIN_BAR_WIDTH = 120;
const BAR_GAP = 22; // whitespace between adjacent bars
const STAVE_Y = 30; // y offset of the stave within its row
const ROW_HEIGHT = 132; // vertical pitch of each wrapped row
const MARGIN = 10; // left margin inside the SVG

const MOD_TO_ACC = { "#": "#", b: "b", x: "##", r: "n" };

/** Accuracy bands for `setNoteAccuracy`.  The thresholds match the per-note
 *  chips in the feedback row, so the stave and the report agree. */
const ACCURACY_CLASSES = ["vf-acc-good", "vf-acc-ok", "vf-acc-weak", "vf-acc-miss"];

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
  }

  clear() {
    this.container.innerHTML = "";
    this.notes = [];
    this.bars = [];
    this._outlineEl = null;
    this._sungEl = null;
    this._sungGlobal = null;
    this._currentTargetMidi = null;
  }

  _resolveVF() {
    if (this.VF) return this.VF;
    const candidates = [window.VexFlow, window.Vex && window.Vex.Flow, window.Vex];
    for (const c of candidates) {
      if (c && c.Renderer && c.Stave && c.StaveNote) return c;
    }
    return null;
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
   *   [{ clef, notes: [{ name, alias, duration, is_rest, is_enharmonic }] }]
   * `options.keySignature` is a VexFlow key name (e.g. "G", "Abm").
   * `options.onBarClick` is called with the bar index when a bar is clicked.
   */
  render(bars, { clef = "treble", keySignature = "", title = "", onBarClick = null } = {}) {
    this.clear();
    const VF = this._ensureVexflow();
    if (!VF) return [];
    if (!bars || bars.length === 0) {
      this.container.innerHTML = '<div class="empty">No notes to display.</div>';
      return [];
    }
    this.onBarClick = onBarClick;

    // --- Measure the available width inside the notation panel -----------
    // Bars wrap into multiple rows so the whole score is visible without
    // horizontal scrolling, regardless of how many bars a scale/lesson has.
    // clientWidth is the inner content width (CSS padding already excluded),
    // so we only keep a small safety margin for borders/sub-pixel rounding.
    const availWidth = Math.max(320, Math.floor(this.container.clientWidth - 4));

    // --- Pre-compute the clef/key-signature/time-signature width --------
    const probe = new VF.Stave(0, 0, 400);
    probe.addClef("treble");
    if (keySignature) probe.addKeySignature(keySignature);
    probe.addTimeSignature("4/4");
    const prefixWidth = Math.ceil(probe.getNoteStartX()) + 10;

    // --- Natural (preferred) bar widths from note content ----------------
    // Each bar's preferred width is driven by its note durations so notes
    // never collide.  These are upper bounds; rows scale down to fit.
    const prefWidths = bars.map((bar, i) => {
      const notes = bar.notes || [];
      const totalWhole = notes.reduce((s, n) => s + (n.duration || 0.125), 0);
      // Width must fit *both* the total duration and every notehead: poly
      // bars pack many short (sixteenth) notes whose total duration is small
      // but which need horizontal room so they don't collide.  Reserve a
      // minimum per-note slot and take the larger of the two estimates.
      const durArea = Math.ceil(totalWhole * PX_PER_WHOLE);
      const countArea = notes.length * 26; // ~26px per notehead + spacing
      const noteArea = Math.max(durArea, countArea) + STAVE_PADDING * 2;
      return Math.max(MIN_BAR_WIDTH, noteArea) + (i === 0 ? prefixWidth : 0);
    });

    // --- Flow-wrap bars into rows ---------------------------------------
    // A row holds bars until the next bar would exceed availWidth.  If a
    // single bar is wider than the row (long bars / first bar with clef), it
    // gets its own row and is scaled to fit the row.  We never exceed the
    // available width, so no horizontal scroll is ever needed.
    const rows = [];
    let cur = [];
    let curW = 0;
    bars.forEach((bar, i) => {
      const w = prefWidths[i] + (cur.length ? BAR_GAP : 0);
      if (cur.length && curW + w > availWidth) {
        rows.push(cur);
        cur = [];
        curW = 0;
      }
      cur.push(i);
      curW += (cur.length > 1 ? BAR_GAP : 0) + prefWidths[i];
    });
    if (cur.length) rows.push(cur);

    // Compute per-bar scaled width + placement (x, y) so each row exactly
    // fills availWidth.  Scale factor = availWidth / rowPrefWidth (clamped to
    // <=1 so we never grow beyond preferred; a single over-wide bar is shrunk
    // to fit).  Bars within a row are laid out left-to-right with BAR_GAP.
    const barWidths = new Array(bars.length);
    const placement = new Array(bars.length); // {x, y}
    rows.forEach((row, r) => {
      const pref = row.reduce((s, i, k) => s + prefWidths[i] + (k ? BAR_GAP : 0), 0);
      const scale = pref > availWidth ? availWidth / pref : 1;
      let x = MARGIN;
      row.forEach((i, k) => {
        barWidths[i] = Math.floor(prefWidths[i] * scale);
        placement[i] = { x, y: r * ROW_HEIGHT + STAVE_Y };
        x += barWidths[i] + BAR_GAP;
      });
    });

    // --- Create the SVG sized for all rows ------------------------------
    const totalHeight = rows.length * ROW_HEIGHT + 16;

    const renderer = new VF.Renderer(this.container, VF.Renderer.Backends.SVG);
    renderer.resize(availWidth, totalHeight);
    const context = renderer.getContext();
    context.setFont("Arial", 10);
    context.setBackgroundFillStyle("#ffffff");
    context.setFillStyle("#16171a");
    context.setStrokeStyle("#16171a");

    const effective = {};
    this._initKeySignatureState(effective, keySignature);

    let globalIndex = 0;
    const formatted = [];
    const allBeams = [];

    bars.forEach((bar, i) => {
      const bw = barWidths[i];
      const stave = new VF.Stave(placement[i].x, placement[i].y, bw);
      if (i === 0) {
        stave.addClef("treble");
        if (keySignature) stave.addKeySignature(keySignature);
        stave.addTimeSignature("4/4");
      }
      stave.setContext(context).draw();
      const noteStartX = stave.getNoteStartX();
      const noteStart = globalIndex; // first note index of this bar

      // Per-bar text label (e.g. Roman-numeral harmonic function "I", "IV"
      // on polyphonic lessons) drawn above the stave.  NB: we deliberately
      // do NOT use stave.setText() — in VexFlow 5.0.0 adding a text modifier
      // collapses stave.getWidth() to the text's measured width, shrinking
      // the staff to a sliver.  Drawing the label directly via the context
      // after the stave avoids that bug entirely.  We estimate the label
      // width (~8px per char at this font size) to center it on the bar.
      if (bar.label) {
        try {
          const lx = stave.getX() + (stave.getWidth() / 2) - (bar.label.length * 4);
          const ly = placement[i].y - 6;
          context.setFont("Arial", 11);
          context.setFillStyle("#16171a");
          context.fillText(bar.label, lx, ly);
        } catch (e) { /* label best-effort */ }
      }

      const barStart = Object.assign({}, effective);
      const notes = [];
      (bar.notes || []).forEach((n) => {
        const durType = this._durToType(n.duration || 0.125);
        let note;
        if (n.is_rest || !n.name) {
          note = new VF.StaveNote({ keys: ["b/4"], duration: durType + "r", clef: "treble" });
        } else {
          const tok = parseNoteToken(n.name);
          const key = noteNameToVexflow(tok);
          note = new VF.StaveNote({ keys: [key], duration: durType, clef: "treble", auto_stem: true });
          const accVal = this._accidentalValue(tok);
          const prev = barStart[tok.letter] || 0;
          if (accVal !== prev || (i === 0 && accVal !== 0 && accVal !== (effective[tok.letter] || 0))) {
            const accStr = MOD_TO_ACC[tok.modifier];
            if (accStr) note.addModifier(new VF.Accidental(accStr), 0);
            barStart[tok.letter] = accVal;
          }
        }
        note.globalIndex = globalIndex;
        notes.push(note);
        globalIndex += 1;
      });

      // Beaming
      const beamable = notes.filter((n) => {
        const d = n.getDuration ? n.getDuration() : "";
        return d === "8" || d === "16";
      });
      if (beamable.length >= 2) {
        try {
          const beams = VF.Beam.generateBeams(beamable, { groups: [new VF.Fraction(2, 8)] });
          beams.forEach((b) => allBeams.push(b));
        } catch (e) { /* best-effort */ }
      }

      const voice = new VF.Voice({ num_beats: 4, beat_value: 4 }).setStrict(false);
      voice.addTickables(notes);
      formatted.push({ voice, stave, notes, noteStartX, noteStart, barIndex: i });
    });

    // Format each voice into its note area
    formatted.forEach(({ voice, stave, noteStartX }) => {
      const noteAreaWidth = stave.getWidth() - (noteStartX - stave.getX()) - STAVE_PADDING;
      new VF.Formatter().joinVoices([voice]).format([voice], Math.max(40, noteAreaWidth));
    });

    // Draw voices + beams
    formatted.forEach(({ voice, stave }) => voice.draw(stave.getContext(), stave));
    allBeams.forEach((b) => b.setContext(context).draw());

    // --- Collect per-note SVG <g> for highlighting ---------------------
    const noteGroups = this.container.querySelectorAll("svg g.vf-stavenote");
    this.notes = [];
    let gi = 0;
    formatted.forEach(({ notes, barIndex }) => {
      notes.forEach((note) => {
        this.notes.push({ note, el: noteGroups[gi] || null, globalIndex: note.globalIndex, barIndex });
        gi += 1;
      });
    });

    // --- Collect per-bar stave SVG <g> + click/hover wiring ------------
    // VexFlow draws note groups (g.vf-stavenote) as *siblings* of, and on top
    // of, the stave group, so a click on a notehead/beam never reaches the
    // stave's own handler.  We attach a delegated listener to the notation
    // container and hit-test the click against each bar's screen rectangle
    // (getBoundingClientRect on the stave group - robust regardless of SVG
    // coordinate transforms or scrolling).  A nearest-bar fallback covers
    // noteheads/beams that sit above or below the staff box, so the whole bar
    // area is clickable, not just the staff lines.
    const staveGroups = this.container.querySelectorAll("svg g.vf-stave");
    const svgEl = this.container.querySelector("svg");
    this.bars = [];
    formatted.forEach((f, i) => {
      const staveEl = staveGroups[i];
      this.bars.push({
        staveEl, stave: f.stave, noteStart: f.noteStart, noteEnd: f.noteStart + f.notes.length - 1, barIndex: i,
        x: placement[i].x, y: placement[i].y, width: barWidths[i],
      });
      if (staveEl) staveEl.classList.add("vf-bar-interactive");
    });
    this.svgEl = svgEl;

    if (svgEl) {
      svgEl.style.cursor = "pointer";

      const barRects = () => {
        const rects = [];
        staveGroups.forEach((g, i) => {
          if (!g) { rects.push(null); return; }
          const r = g.getBoundingClientRect();
          rects.push({ x0: r.left, x1: r.right, y0: r.top, y1: r.bottom, barIndex: i });
        });
        return rects;
      };

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

  /** Visually frame a bar's stave box (e.g. the bar to sing). */
  highlightBarBox(barIndex) {
    this.bars.forEach((b) => {
      if (!b.staveEl) return;
      if (b.barIndex === barIndex) b.staveEl.classList.add("vf-bar-sing");
      else b.staveEl.classList.remove("vf-bar-sing");
    });
    this._drawBarOutline(barIndex);
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

  _initKeySignatureState(state, vexKey) {
    if (!vexKey) return;
    const sharpOrder = ["f", "c", "g", "d", "a", "e", "b"];
    const flatOrder = ["b", "e", "a", "d", "g", "c", "f"];
    const isMinor = vexKey.endsWith("m");
    const root = vexKey.replace("m", "");
    const sharpKeys = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, "F#": 6, "C#": 7 };
    const flatKeys = { C: 0, F: 1, Bb: 2, Eb: 3, Ab: 4, Db: 5, Gb: 6, Cb: 7 };
    const minorSharpRoots = { A: 0, E: 1, B: 2, "F#": 3, "C#": 4, "G#": 5, "D#": 6, "A#": 7 };
    const minorFlatRoots = { A: 0, D: 1, G: 2, C: 3, F: 4, Bb: 5, Eb: 6, Ab: 7 };
    let nSharps = 0, nFlats = 0;
    if (isMinor) {
      if (root in minorSharpRoots) nSharps = minorSharpRoots[root];
      else if (root in minorFlatRoots) nFlats = minorFlatRoots[root];
    } else {
      if (root in sharpKeys) nSharps = sharpKeys[root];
      else if (root in flatKeys) nFlats = flatKeys[root];
    }
    if (nSharps > 0) {
      for (let k = 0; k < Math.min(nSharps, 7); k++) state[sharpOrder[k]] = 1;
    } else if (nFlats > 0) {
      for (let k = 0; k < Math.min(nFlats, 7); k++) state[flatOrder[k]] = -1;
    }
  }

  _accidentalValue(tok) {
    if (!tok.modifier) return 0;
    if (tok.modifier === "r") return 0;
    if (tok.modifier === "#") return 1;
    if (tok.modifier === "b") return -1;
    if (tok.modifier === "x") return 2;
    return 0;
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
    if (d >= 1) return "w";
    if (d >= 0.5) return "h";
    if (d >= 0.25) return "q";
    if (d >= 0.125) return "8";
    if (d >= 0.0625) return "16";
    return "8";
  }
}