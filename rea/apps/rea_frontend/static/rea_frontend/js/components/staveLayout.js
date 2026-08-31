/**
 * staveLayout.js
 *
 * How a REA score is drawn — the one copy of it.
 *
 * Two places put these exercises on a stave: the practice view a student
 * reads, and the editor a teacher writes in.  They want different things
 * *around* the notes (playback highlighting and a sung-pitch marker on one
 * side, selection and property annotations on the other) but the notes
 * themselves have to look the same in both, down to the pixel — a teacher who
 * cannot trust the editor's picture is editing blind.  So the measuring, the
 * wrapping, the accidental rules and the drawing live here, and each caller
 * adds only its own interaction layer on top.
 *
 * What is drawn is deliberately spare: five lines, barlines, and noteheads.
 * No clef (the library is single-clef), no time signature (its bars are
 * phrases, not metrical measures), no key signature, and — through the CSS
 * that styles `svg.rea-score` — no stems, flags or beams.  These are
 * intonation exercises: the eye should be on where the note sits and nothing
 * else.  Rhythm still exists, in the playback and in the editor's inspector;
 * it is simply not drawn.
 *
 * Accidentals are therefore only ever the ones a note carries in its own
 * token.  With no key signature on the stave there is nothing to inherit
 * from, so a written `f` shows a plain notehead even in a sharp key — it
 * still *sounds* F# (the pitch is resolved from the key server-side), and the
 * editor's inspector names the sounding pitch for the teacher.
 */

import { noteNameToVexflow, parseNoteToken } from "../notation.js?v=131";

/** Fixed metrics.  Changing one changes both views, which is the point. */
export const METRICS = {
  PX_PER_WHOLE: 260,
  STAVE_PADDING: 26,
  MIN_BAR_WIDTH: 120,
  BAR_GAP: 22,       // whitespace between adjacent bars
  STAVE_Y: 26,       // y of the stave's first line within its row
  ROW_HEIGHT: 100,   // vertical pitch of each wrapped row
  MARGIN: 10,        // left margin inside the SVG
  NOTE_SLOT: 26,     // horizontal room reserved per notehead
};

const MOD_TO_ACC = { "#": "#", b: "b", x: "##", r: "n" };

/**
 * Move one drawn notehead sideways: the note's *visual* offset.
 *
 * This is a different thing from `horizontal_offset_ms`, which moves when a
 * note sounds and changes nothing on the page.  This moves the picture and
 * changes nothing about the sound.  A teacher reaches for it when the
 * automatic spacing puts a note somewhere that reads badly — two noteheads
 * crowding each other, an accidental colliding with the note before it, a
 * phrase wanting a little air in the middle — and it is stored per note on the
 * exercise, so a student sees the picture the teacher approved.
 *
 * It is a transform on the drawn group rather than VexFlow's `setXShift`, and
 * that is a deliberate choice between two things that sound alike:
 *
 *   - `setXShift` *before* formatting is an input to the formatter, which then
 *     renegotiates the whole bar — the nudged note ends up somewhere else
 *     entirely and its neighbours move too.  That is spacing advice, not an
 *     offset.
 *   - `setXShift` *after* formatting has no effect at all in the vendored
 *     VexFlow 5 build: the drawn x is fixed by then.
 *
 * The transform moves that note and only that note, by exactly the number of
 * pixels asked for, which is what a per-note offset has to mean.  It carries
 * the notehead, its stem, its flag and its accidental — everything inside the
 * group — and it moves the group's bounding box with them, which matters
 * beyond looks: both views hit-test clicks against those rectangles, so a
 * note drawn in one place and clickable in another would be worse than no
 * feature at all.
 *
 * The one thing it does not carry is a beam, which VexFlow draws as its own
 * group spanning several notes.  Beams are hidden on every REA stave (see the
 * `svg.rea-score` rule in main.css) and are shown only by the editor's Rhythm
 * toggle, so the cost is that a nudged note under that toggle has a beam that
 * does not follow it.  That is the diagnostic view, not the exercise.
 */
function applyVisualOffset(el, px) {
  const shift = Number(px) || 0;
  if (!el || !shift) return;
  const existing = el.getAttribute("transform");
  const move = `translate(${shift},0)`;
  el.setAttribute("transform", existing ? `${existing} ${move}` : move);
}

/**
 * VexFlow reserves four line-spaces above every stave for text and ornaments
 * it might add, and draws its first line that far below the y it is given.
 * This library draws none of that — no clef, no key or time signature, no
 * dynamics — so it was 40px of guaranteed blank per row, and a wrapped score
 * spent more height on nothing than on notes.
 *
 * The `space_above_staff_ln` option is not honoured by the vendored build, so
 * the reservation is cancelled by construction instead: a stave is created
 * 40px above where its lines should land.  `STAVE_Y` therefore means the y of
 * the stave's *first line* within its row, which is what the callers actually
 * reason about, and what a row needs below the staff — ledger lines and their
 * noteheads — is held by ROW_HEIGHT.
 */
const VF_SPACE_ABOVE_PX = 40;

/** VexFlow, however the vendored build exposed itself. */
export function resolveVexFlow() {
  const candidates = [window.VexFlow, window.Vex && window.Vex.Flow, window.Vex];
  for (const c of candidates) {
    if (c && c.Renderer && c.Stave && c.StaveNote) return c;
  }
  return null;
}

/** VexFlow duration type for a duration in whole notes. */
export function durationToType(duration) {
  if (duration >= 1) return "w";
  if (duration >= 0.5) return "h";
  if (duration >= 0.25) return "q";
  if (duration >= 0.125) return "8";
  if (duration >= 0.0625) return "16";
  return "8";
}

/** Semitone offset implied by a token's own accidental. */
export function accidentalValue(token) {
  if (!token.modifier || token.modifier === "r") return 0;
  if (token.modifier === "#") return 1;
  if (token.modifier === "b") return -1;
  if (token.modifier === "x") return 2;
  return 0;
}

/**
 * Draw a score into *container* and hand back everything needed to interact
 * with it.
 *
 * @param {HTMLElement} container
 * @param {Array} bars   [{ label, notes: [{ name, duration, is_rest }] }]
 * @param {object} options
 * @param {number} options.rowExtra      extra vertical room per row, for a
 *   caller that draws its own lanes under the stave.  0 keeps the rows
 *   exactly as the practice view spaces them.
 * @returns {{VF, context, svg, width, height, bars, notes}}
 *   `bars`  [{barIndex, stave, staveEl, x, y, width, row, noteStart, noteEnd}]
 *   `notes` [{barIndex, noteIndex, globalIndex, note, el}]
 */
export function drawScore(container, bars, { rowExtra = 0 } = {}) {
  const VF = resolveVexFlow();
  if (!VF) return null;

  const rowHeight = METRICS.ROW_HEIGHT + rowExtra;

  // --- Measure the available width inside the panel --------------------
  // Bars wrap into rows so a whole score is visible without scrolling
  // sideways, however many bars it has.  `clientWidth` includes the
  // element's padding, so subtract it: measuring without would draw an SVG
  // wider than its box.
  const style = window.getComputedStyle(container);
  const padding = parseFloat(style.paddingLeft || 0) + parseFloat(style.paddingRight || 0);
  const availWidth = Math.max(320, Math.floor(container.clientWidth - padding - 4));

  // --- Natural (preferred) bar widths from note content ----------------
  // A bar's preferred width is driven by its notes so they never collide.
  // Harmonic bars pack many short notes whose total duration is small but
  // which still need room, so reserve a minimum slot per notehead and take
  // whichever estimate is larger.  These are upper bounds; rows scale down.
  const prefWidths = bars.map((bar) => {
    const notes = bar.notes || [];
    const totalWhole = notes.reduce((sum, n) => sum + (n.duration || 0.125), 0);
    const durArea = Math.ceil(totalWhole * METRICS.PX_PER_WHOLE);
    const countArea = notes.length * METRICS.NOTE_SLOT;
    const noteArea = Math.max(durArea, countArea) + METRICS.STAVE_PADDING * 2;
    return Math.max(METRICS.MIN_BAR_WIDTH, noteArea);
  });

  // --- Flow-wrap bars into rows ----------------------------------------
  const rows = [];
  let cur = [];
  let curW = 0;
  bars.forEach((bar, i) => {
    const w = prefWidths[i] + (cur.length ? METRICS.BAR_GAP : 0);
    if (cur.length && curW + w > availWidth) {
      rows.push(cur);
      cur = [];
      curW = 0;
    }
    cur.push(i);
    curW += (cur.length > 1 ? METRICS.BAR_GAP : 0) + prefWidths[i];
  });
  if (cur.length) rows.push(cur);

  // Scale each row to fill the available width (never beyond preferred), and
  // lay its bars out left to right.
  const barWidths = new Array(bars.length);
  const placement = new Array(bars.length);
  rows.forEach((row, r) => {
    const pref = row.reduce((sum, i, k) => sum + prefWidths[i] + (k ? METRICS.BAR_GAP : 0), 0);
    const scale = pref > availWidth ? availWidth / pref : 1;
    let x = METRICS.MARGIN;
    row.forEach((i, k) => {
      barWidths[i] = Math.floor(prefWidths[i] * scale);
      placement[i] = { x, y: r * rowHeight + METRICS.STAVE_Y, row: r };
      x += barWidths[i] + METRICS.BAR_GAP;
    });
  });

  // --- Create the SVG sized for all rows -------------------------------
  const height = rows.length * rowHeight + 16;
  const renderer = new VF.Renderer(container, VF.Renderer.Backends.SVG);
  renderer.resize(availWidth, height);
  const context = renderer.getContext();
  context.setFont("Arial", 10);
  context.setBackgroundFillStyle("#ffffff");
  context.setFillStyle("#16171a");
  context.setStrokeStyle("#16171a");

  let globalIndex = 0;
  const formatted = [];
  const allBeams = [];

  bars.forEach((bar, i) => {
    const stave = new VF.Stave(placement[i].x, placement[i].y - VF_SPACE_ABOVE_PX, barWidths[i]);
    stave.setContext(context).draw();
    const noteStart = globalIndex;

    // Per-bar text label (a Roman-numeral harmonic function, a chord name)
    // drawn above the stave.  NB: deliberately not stave.setText() — in
    // VexFlow 5.0.0 adding a text modifier collapses stave.getWidth() to the
    // text's measured width, shrinking the staff to a sliver.  Drawing the
    // label through the context afterwards avoids that bug entirely.  The
    // label width is estimated (~8px per char) to centre it on the bar.
    if (bar.label) {
      try {
        const lx = stave.getX() + (stave.getWidth() / 2) - (bar.label.length * 4);
        const ly = placement[i].y - 6;
        context.setFont("Arial", 11);
        context.setFillStyle("#16171a");
        context.fillText(bar.label, lx, ly);
      } catch (e) { /* the label is decoration; never block the draw */ }
    }

    // Accidentals carry within a bar: an alteration is drawn where it first
    // appears and not restated on the same letter afterwards.  The state
    // starts empty every bar because no key signature is drawn.
    const barStart = {};
    const staveNotes = [];
    (bar.notes || []).forEach((n) => {
      const durType = durationToType(n.duration || 0.125);
      let note;
      if (n.is_rest || !n.name) {
        note = new VF.StaveNote({ keys: ["b/4"], duration: durType + "r", clef: "treble" });
      } else {
        const tok = parseNoteToken(n.name);
        note = new VF.StaveNote({
          keys: [noteNameToVexflow(tok)], duration: durType, clef: "treble", auto_stem: true,
        });
        const accVal = accidentalValue(tok);
        if (accVal !== (barStart[tok.letter] || 0)) {
          const accStr = MOD_TO_ACC[tok.modifier];
          if (accStr) note.addModifier(new VF.Accidental(accStr), 0);
          barStart[tok.letter] = accVal;
        }
      }
      note.globalIndex = globalIndex;
      // Carried here, applied to the drawn group after the draw — see
      // `applyVisualOffset` for why it cannot be done through VexFlow.
      note.reaVisualOffset = Number(n.visual_offset_px) || 0;
      staveNotes.push(note);
      globalIndex += 1;
    });

    // Beaming: eighths and shorter group into beats.
    const beamable = staveNotes.filter((n) => {
      const d = n.getDuration ? n.getDuration() : "";
      return d === "8" || d === "16";
    });
    if (beamable.length >= 2) {
      try {
        VF.Beam.generateBeams(beamable, { groups: [new VF.Fraction(2, 8)] })
          .forEach((b) => allBeams.push(b));
      } catch (e) { /* beaming is decoration; best effort */ }
    }

    // An empty bar has nothing to format — VexFlow throws on a voice with no
    // tickables, and the editor's brand-new bars are exactly that.
    if (staveNotes.length) {
      const voice = new VF.Voice({ num_beats: 4, beat_value: 4 }).setStrict(false);
      voice.addTickables(staveNotes);
      formatted.push({ voice, stave, notes: staveNotes, noteStart, barIndex: i });
    } else {
      formatted.push({ voice: null, stave, notes: [], noteStart, barIndex: i });
    }
  });

  formatted.forEach(({ voice, stave }) => {
    if (!voice) return;
    const noteAreaWidth = stave.getWidth()
      - (stave.getNoteStartX() - stave.getX()) - METRICS.STAVE_PADDING;
    new VF.Formatter().joinVoices([voice]).format([voice], Math.max(40, noteAreaWidth));
  });

  formatted.forEach(({ voice, stave }) => voice && voice.draw(context, stave));
  allBeams.forEach((b) => b.setContext(context).draw());

  // --- Tie the drawn SVG groups back to positions in the score ---------
  // VexFlow emits note groups in draw order, which is the order fed in.
  const svg = container.querySelector("svg");
  // The class every REA stave carries: what makes the stems, flags and beams
  // disappear, in both views, from one rule in main.css.
  if (svg) svg.classList.add("rea-score");
  const noteGroups = container.querySelectorAll("svg g.vf-stavenote");
  const staveGroups = container.querySelectorAll("svg g.vf-stave");

  const noteEntries = [];
  let gi = 0;
  formatted.forEach(({ notes, barIndex }) => {
    notes.forEach((note, noteIndex) => {
      const el = noteGroups[gi] || null;
      applyVisualOffset(el, note.reaVisualOffset);
      noteEntries.push({
        barIndex, noteIndex, globalIndex: note.globalIndex, note, el,
      });
      gi += 1;
    });
  });

  const barEntries = formatted.map((f, i) => ({
    barIndex: i,
    stave: f.stave,
    staveEl: staveGroups[i] || null,
    x: placement[i].x,
    y: placement[i].y,
    row: placement[i].row,
    width: barWidths[i],
    noteStart: f.noteStart,
    noteEnd: f.noteStart + f.notes.length - 1,
  }));

  return {
    VF, context, svg, width: availWidth, height,
    bars: barEntries, notes: noteEntries, rows: rows.length,
  };
}
