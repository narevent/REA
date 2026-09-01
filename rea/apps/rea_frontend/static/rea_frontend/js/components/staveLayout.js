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

import { noteNameToVexflow, parseNoteToken } from "../notation.js?v=164";

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
 * How far a notehead reaches above and below its own baseline, in SVG units.
 *
 * Generous enough to cover the glyph and a ledger line through it, which is
 * what anything drawing a box around a note actually wants.
 */
export const NOTEHEAD_REACH = 11;

/**
 * The baselines of the noteheads inside a drawn note group.
 *
 * Anything that needs to know where a note sits vertically has to ask this
 * rather than the element's bounding box, and the reason is worth stating
 * once because it has now caused the same bug three times over.
 *
 * A VexFlow notehead is a glyph in the music font, and the browser reports a
 * `<text>` element's box as the font's *em* box — every note on the stave
 * measures the same ~161 units tall, starting far above the staff and ending
 * far below it.  It is a true statement about the font and says nothing
 * whatever about the note.  Code that believed it drew selection boxes
 * taller than the canvas, frames that clipped ledger lines, and annotation
 * lanes that never adapted at all.
 *
 * The `y` attribute, by contrast, is the glyph's baseline, which for a
 * notehead is its own vertical centre — the number these callers meant all
 * along.  Horizontal measurements are fine from the bounding box (a notehead
 * really is about 12 units wide); it is only the height that lies.
 *
 * @returns {number[]} one baseline per notehead, empty for a rest
 */
export function noteHeadYs(noteEl) {
  if (!noteEl || !noteEl.querySelectorAll) return [];
  const out = [];
  noteEl.querySelectorAll(".vf-notehead text").forEach((t) => {
    const y = parseFloat(t.getAttribute("y"));
    if (isFinite(y)) out.push(y);
  });
  return out;
}

/**
 * Move one note sideways: the note's *visual* offset.
 *
 * This is a different thing from `horizontal_offset_ms`, which moves when a
 * note sounds and changes nothing on the page.  This moves the picture and
 * changes nothing about the sound.  A teacher reaches for it when the
 * automatic spacing puts a note somewhere that reads badly — two noteheads
 * crowding each other, an accidental colliding with the note before it, a
 * phrase wanting a little air in the middle — and it is stored per note on the
 * exercise, so a student sees the picture the teacher approved.
 *
 * It moves the note's *tick context* between formatting and drawing, and
 * getting here took three tries, so the two that do not work are worth
 * recording:
 *
 *   - `setXShift` before formatting is an input to the formatter, which then
 *     renegotiates the whole bar around it — the nudged note lands somewhere
 *     else entirely and its neighbours move too.  That is spacing advice, not
 *     an offset.
 *   - `setXShift` after formatting does nothing at all in the vendored
 *     VexFlow 5 build: the drawn x is settled by then.
 *   - A transform on the drawn `<g class="vf-stavenote">` moves the notehead
 *     and, for an unbeamed note, its stem.  But a *beamed* note's stem is not
 *     in that group: VexFlow draws the stems of a beamed group inside the
 *     `<g class="vf-beam">` alongside the beam itself.  So a nudged eighth in
 *     a beamed pair had its notehead slide out from under a stem and beam
 *     that stayed put.
 *
 * The tick context is what the formatter assigns positions to and what every
 * later drawing step — stems, beams, accidentals — reads back, so moving it
 * moves all of them together, and only for this note.
 *
 * One consequence to know about: a tick context is shared by everything
 * sounding at the same moment.  These scores are a single voice with one note
 * per tick, so it is one note per context; if that ever stops being true,
 * nudging one note of a chord would nudge the chord.
 */
function applyVisualOffset(note, px) {
  const shift = Number(px) || 0;
  if (!shift || !note.getTickContext) return;
  const context = note.getTickContext();
  if (!context || !context.setX) return;
  context.setX(context.getX() + shift);
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

/** Extra room above the top row for a tuplet bracket and its number. */
const TUPLET_HEADROOM = 22;

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

  // Room above the first staff line for a tuplet's bracket and its number.
  //
  // VexFlow draws a tuplet on the far side of the stems, which for a phrase
  // lying high on the staff — most of this library — is above the beam and
  // therefore above the staff.  `STAVE_Y` leaves 26px of room up there, which
  // a beam over high notes uses most of, so the number was drawn at a
  // negative y and the SVG simply cut it off.  Only paid for when the score
  // actually holds a tuplet, so nothing else gains a band of white space.
  const hasTuplets = bars.some((bar) => (bar.notes || []).some(
    (n) => n.tuplet_num > 0 && n.tuplet_den > 0
  ));
  const topPad = hasTuplets ? TUPLET_HEADROOM : 0;

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
      placement[i] = { x, y: r * rowHeight + METRICS.STAVE_Y + topPad, row: r };
      x += barWidths[i] + METRICS.BAR_GAP;
    });
  });

  // --- Create the SVG sized for all rows -------------------------------
  const height = rows.length * rowHeight + 16 + topPad;
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
  const allTuplets = [];

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
      // Carried here and applied once the formatter has run — see
      // `applyVisualOffset` for why it has to happen exactly there.
      note.reaVisualOffset = Number(n.visual_offset_px) || 0;
      note.reaTuplet = (n.tuplet_num > 0 && n.tuplet_den > 0)
        ? { num: Number(n.tuplet_num), den: Number(n.tuplet_den) } : null;
      staveNotes.push(note);
      globalIndex += 1;
    });

    // Tuplets: runs of adjacent notes carrying the same ratio, cut into
    // groups of `num`.  Two triplets in a row are six marked notes and read
    // as 3 + 3 — see `MusicEvent.tuplet_num` for why the grouping is
    // positional rather than held by an id.
    let run = [];
    const closeRun = () => {
      if (!run.length) return;
      const { num, den } = run[0].reaTuplet;
      for (let i = 0; i + num <= run.length; i += num) {
        try {
          allTuplets.push(new VF.Tuplet(run.slice(i, i + num), {
            num_notes: num, notes_occupied: den,
          }));
        } catch (e) { /* a malformed group is not worth losing the score over */ }
      }
      run = [];
    };
    staveNotes.forEach((note) => {
      const t = note.reaTuplet;
      if (!t) { closeRun(); return; }
      if (run.length && (run[0].reaTuplet.num !== t.num || run[0].reaTuplet.den !== t.den)) closeRun();
      run.push(note);
    });
    closeRun();

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

  // The per-note visual offsets, applied after the formatter has settled the
  // spacing and before anything is drawn from it.  See `applyVisualOffset`.
  formatted.forEach(({ notes }) => notes.forEach((note) => {
    applyVisualOffset(note, note.reaVisualOffset);
  }));

  formatted.forEach(({ voice, stave }) => voice && voice.draw(context, stave));
  allBeams.forEach((b) => b.setContext(context).draw());
  // After the beams: a tuplet's bracket is placed against the stems, which
  // the beam may have moved.
  allTuplets.forEach((t) => {
    try { t.setContext(context).draw(); } catch (e) { /* decoration only */ }
  });

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
      noteEntries.push({
        barIndex, noteIndex, globalIndex: note.globalIndex, note,
        el: noteGroups[gi] || null,
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
