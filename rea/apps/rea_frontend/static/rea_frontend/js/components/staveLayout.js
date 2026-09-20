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
 * What is drawn is deliberately spare: five lines, barlines, noteheads, and
 * the two things a musician needs before they can read a single one of them —
 * the clef, and the key signature the bar is in.  No time signature (these
 * bars are phrases, not metrical measures) and — through the CSS that styles
 * `svg.rea-score` — no stems, flags or beams.  These are intonation
 * exercises: the eye should be on where the note sits and nothing else.
 * Rhythm still exists, in the playback and in the editor's inspector; it is
 * simply not drawn.
 *
 * The key signature comes from the bar's own `music_mode_chord`, which is why
 * it needs no separate switch per system: a relative exercise is in a real key
 * and gets its sharps or flats, while every absolute one is in C and gets
 * none.  Accidentals are then read against it the way a musician reads them —
 * an `f` in G major is the F♯ the signature already promised and is drawn
 * plain, an `fr` cancels it and is drawn with a natural.  Before the signature
 * was there, that natural had nothing to contradict and so was never drawn at
 * all: the note sounded natural and looked sharp.
 */

import {
  keyAccidentalCount, keyAccidentals, modeChordToVexKey, noteNameToVexflow, parseNoteToken,
} from "../notation.js?v=165";

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
  CLEF_WIDTH: 32,    // room a drawn clef takes before the first note
  KEY_ACC_WIDTH: 10, // room each key-signature accidental takes
};

/** The accidental glyph for a sounded alteration, in semitones. */
const ALTERATION_TO_ACC = { "-2": "bb", "-1": "b", 0: "n", 1: "#", 2: "##" };

/**
 * Source clef names, as the library spells them, to VexFlow's own.
 *
 * The imported library is written entirely in `Violin`, so for years the clef
 * was a constant and the stave drew none.  It is a field on every bar all the
 * same, and an exercise that sits two octaves under the staff is a bass-clef
 * exercise whatever the import happened to say — so the name is honoured,
 * and an unknown one reads as a treble rather than as nothing.
 */
export const CLEF_MAP = {
  Violin: "treble", Treble: "treble", G: "treble",
  Bass: "bass", F: "bass",
  Alto: "alto", Viola: "alto",
  Tenor: "tenor",
  Soprano: "soprano",
  MezzoSoprano: "mezzo-soprano",
  Baritone: "baritone-f",
};

/**
 * A score's *style*: how it is laid out, as opposed to what is in it.
 *
 * The fields arrive from the server under their stored names (see
 * `intonation/style.py`) and are translated once, here, into the shorter ones
 * the drawing reads — so every caller can hand this an exercise's `meta`, a
 * lesson, or nothing at all, and get a complete style either way.
 */
export const STYLE_DEFAULTS = {
  barGap: 22,           // mid_bar_space: whitespace between bars, in pixels
  barsPerRow: 0,        // 0 = as many as the width allows
  centre: false,        // align_to_center
  stretch: false,       // auto_align: fill the line, or leave natural widths
  headsOnly: true,      // draw_only_note_heads
  sameDuration: false,  // are_all_notes_same_duration
  separatorSpace: 14,   // whitespace a separator opens up
  noteLabel: "",        // "", degree, letter, letter_octave, roman
  barNumber: "none",    // none, all, row
};

export function scoreStyle(source) {
  const s = source || {};
  const pick = (key, fallback) => (s[key] == null ? fallback : s[key]);
  return {
    barGap: Number(pick("mid_bar_space", STYLE_DEFAULTS.barGap)),
    barsPerRow: Number(pick("bars_per_row", STYLE_DEFAULTS.barsPerRow)) || 0,
    centre: !!pick("align_to_center", STYLE_DEFAULTS.centre),
    stretch: !!pick("auto_align", STYLE_DEFAULTS.stretch),
    headsOnly: !!pick("draw_only_note_heads", STYLE_DEFAULTS.headsOnly),
    sameDuration: !!pick("are_all_notes_same_duration", STYLE_DEFAULTS.sameDuration),
    separatorSpace: Number(pick("separator_space", STYLE_DEFAULTS.separatorSpace)),
    noteLabel: String(pick("note_label_type", STYLE_DEFAULTS.noteLabel) || ""),
    barNumber: String(pick("bar_number_type", STYLE_DEFAULTS.barNumber) || "none"),
  };
}

/** VexFlow's notehead codes, by the name the score stores. */
const NOTEHEAD_CODES = {
  cross: "x2", diamond: "d", triangle: "tu", square: "sq", slash: "s",
};

/**
 * The pitch on each clef's top line, as a diatonic index in the document's
 * own units: `octave * 7 + letter`, where octave index 1 is middle C's.
 *
 * It is what turns a click at a height into a note, so it has to be stated
 * per clef rather than assumed: the same y that means F5 in a treble bar
 * means A3 in a bass one, and an editor that writes the treble answer into a
 * bass bar is off by two octaves and a third.
 */
export const CLEF_TOP_LINE = {
  treble: 2 * 7 + 3,   // F5
  bass: 0 * 7 + 5,     // A3
  alto: 1 * 7 + 4,     // G4
  tenor: 1 * 7 + 2,    // E4
  soprano: 2 * 7 + 1,  // D5
  "mezzo-soprano": 1 * 7 + 6,  // B4
  "baritone-f": 1 * 7 + 0,     // C4
};

/** The clef a bar is drawn in, as VexFlow names it. */
export function vexClef(name) {
  if (!name) return "treble";
  return CLEF_MAP[name] || (Object.values(CLEF_MAP).includes(name) ? name : "treble");
}

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
  if (token.modifier === "bb") return -2;
  if (token.modifier === "x") return 2;
  return 0;
}

/**
 * The alteration a note actually sounds, in semitones from its bare letter.
 *
 * A token with a modifier says so itself.  A token without one inherits the
 * key signature — that is what "enharmonic" means in this library — so in E
 * major a written `f` sounds F♯ and must be read against a stave that already
 * says F♯, not against a bare F.
 */
export function soundedAlteration(token, keyMap) {
  if (token.modifier) return accidentalValue(token);
  return (keyMap && keyMap[token.letter]) || 0;
}

/**
 * The note value most of the score is written in.
 *
 * What "all notes the same duration" draws them *as*.  Taking the commonest
 * rather than the first means an exercise with a long final note still reads
 * as the run of eighths it mostly is, and an exercise with a pickup does not
 * take its look from the pickup.
 */
function commonDuration(bars) {
  const counts = new Map();
  (bars || []).forEach((bar) => (bar.notes || []).forEach((n) => {
    const d = n.duration || 0.125;
    counts.set(d, (counts.get(d) || 0) + 1);
  }));
  let best = 0.125;
  let most = 0;
  counts.forEach((count, duration) => {
    if (count > most) { most = count; best = duration; }
  });
  return best;
}

/**
 * The marks between notes: a breath, a phrase end, a tick.
 *
 * Drawn after the notes and in the same pass as them, because a separator
 * belongs to the gap the spacing above has just opened — it is placed halfway
 * across that gap rather than at a fixed distance from either neighbour, so
 * it stays put when the row is rescaled.
 *
 * The apostrophe and the marker sit above the staff where they do not collide
 * with a notehead; the barlines go through it, because that is what they
 * mean.
 */
function drawSeparators(context, stave, notes, look) {
  const top = stave.getYForLine(0);
  const bottom = stave.getYForLine(4);
  notes.forEach((note, index) => {
    const kind = note.reaSeparator;
    if (!kind) return;
    let x;
    try {
      const here = note.getAbsoluteX() + (note.getWidth ? note.getWidth() : 12);
      const next = notes[index + 1];
      x = next ? (here + next.getAbsoluteX()) / 2 : here + look.separatorSpace / 2;
    } catch (e) {
      return; // no geometry, no mark — never at the cost of the score
    }
    context.save();
    context.setStrokeStyle("#16171a");
    context.setFillStyle("#16171a");
    const line = (dx, dashed = false) => {
      context.beginPath();
      if (dashed && context.setLineDash) context.setLineDash([4, 3]);
      context.moveTo(x + dx, top);
      context.lineTo(x + dx, bottom);
      context.stroke();
      if (dashed && context.setLineDash) context.setLineDash([]);
    };
    if (kind === "apostrophe") {
      // A comma above the top line — the breath mark a singer reads.
      context.setFont("Arial", 17);
      context.fillText("\u2019", x - 3, top - 4);
    } else if (kind === "marker") {
      context.beginPath();
      context.moveTo(x - 4, top - 10);
      context.lineTo(x + 4, top - 10);
      context.lineTo(x, top - 3);
      context.closePath();
      context.fill();
    } else if (kind === "dashed") {
      context.setLineWidth(1.2);
      line(0, true);
    } else if (kind === "thick") {
      context.setLineWidth(3.2);
      line(0);
    } else if (kind === "double") {
      context.setLineWidth(1.2);
      line(-2);
      line(2);
    } else {
      context.setLineWidth(1.2);
      line(0);
    }
    context.restore();
  });
}

/** Roman numerals, for the degree labels that ask for them. */
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII"];

/**
 * What is written under one notehead, for a given label style.
 *
 * The degree is the exercise's own `alias`; the letters are read off the
 * written token, so what is printed is what is written rather than a
 * re-spelling of the pitch it sounds.
 */
export function noteLabelText(note, kind, keyMap) {
  if (!note || note.is_rest) return "";
  const degree = note.alias != null && note.alias !== "" ? String(note.alias) : "";
  if (kind === "degree") return degree;
  if (kind === "roman") {
    const number = parseInt(degree, 10);
    if (!Number.isFinite(number)) return degree;
    // A degree can be written an octave up or down — 5' and 5, — and the
    // numeral is the same function either way, so the marks are kept.
    return (ROMAN[number] || degree) + degree.replace(/^\d+/, "");
  }
  if (kind !== "letter" && kind !== "letter_octave") return "";
  const tok = parseNoteToken(note.name || "");
  if (!tok.letter) return "";
  // Named for what it sounds, not for the letter it is spelled with: in A
  // major a written `f` is the F♯ the key signature already said, and a label
  // reading "F" under it would teach the wrong name — which is the one thing
  // a naming label must not do.
  const sign = { "-2": "\u266d\u266d", "-1": "\u266d", 0: "", 1: "\u266f", 2: "\u00d7" };
  const letter = (tok.letter === "h" ? "B" : tok.letter.toUpperCase())
    + (sign[String(soundedAlteration(tok, keyMap))] || "");
  if (kind === "letter") return letter;
  // The octave as a musician names it: index 1 is the middle-C octave.
  return letter + String((tok.octave ?? 0) + 3);
}

/** Write the style's label under each note in a bar. */
function drawNoteLabels(context, stave, notes, look, keyMap) {
  if (!look.noteLabel) return;
  let floor = stave.getYForLine(4);
  notes.forEach((note) => {
    try {
      (note.getYs() || []).forEach((y) => { floor = Math.max(floor, y); });
    } catch (e) { /* a note with no geometry cannot push the lane down */ }
  });
  const y = floor + 20;
  context.save();
  context.setFont("Instrument Sans, sans-serif", 10);
  context.setFillStyle("#6b6f76");
  notes.forEach((note) => {
    const text = noteLabelText(note.reaLabel, look.noteLabel, keyMap);
    if (!text) return;
    try {
      context.fillText(text, note.getAbsoluteX() - text.length * 2.6, y);
    } catch (e) { /* decoration only */ }
  });
  context.restore();
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
export function drawScore(container, bars, { rowExtra = 0, style = null } = {}) {
  const VF = resolveVexFlow();
  if (!VF) return null;

  const look = scoreStyle(style);
  const rowHeight = METRICS.ROW_HEIGHT + rowExtra;

  // Every note drawn as the same value, when the exercise asks for it: these
  // are intonation exercises, and one written in sixteenths for the sake of
  // the playback reads better as a row of equal noteheads.  What is *played*
  // is untouched — the durations are still there, this is only the picture.
  const drawnDuration = (note) => (
    look.sameDuration ? uniformDuration : (note.duration || 0.125)
  );
  const uniformDuration = look.sameDuration ? commonDuration(bars) : 0.125;

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
  const box = window.getComputedStyle(container);
  const padding = parseFloat(box.paddingLeft || 0) + parseFloat(box.paddingRight || 0);
  const availWidth = Math.max(320, Math.floor(container.clientWidth - padding - 4));

  // --- Natural (preferred) bar widths from note content ----------------
  // A bar's preferred width is driven by its notes so they never collide.
  // Harmonic bars pack many short notes whose total duration is small but
  // which still need room, so reserve a minimum slot per notehead and take
  // whichever estimate is larger.  These are upper bounds; rows scale down.
  // What each bar is written in.  Resolved once, up front, because the
  // wrapping needs to know which bars will carry a clef and a key signature
  // before it can decide how wide they are.
  const heads = bars.map((bar) => ({
    clef: vexClef(bar.clef),
    key: modeChordToVexKey(bar.modeChord || ""),
  }));

  const prefWidths = bars.map((bar, i) => {
    const notes = bar.notes || [];
    const totalWhole = notes.reduce((sum, n) => sum + (n.duration || 0.125), 0);
    const durArea = Math.ceil(totalWhole * METRICS.PX_PER_WHOLE);
    const countArea = notes.length * METRICS.NOTE_SLOT;
    const separators = notes.filter((n) => n.separator).length;
    const noteArea = Math.max(durArea, countArea)
      + separators * look.separatorSpace + METRICS.STAVE_PADDING * 2;
    // The clef and key signature are added below, to the bars that actually
    // draw them — which is not known until the bars have been wrapped.
    return Math.max(METRICS.MIN_BAR_WIDTH, noteArea);
  });

  /** The room a bar's clef and key signature need before its first note. */
  const headWidth = (i) => (
    METRICS.CLEF_WIDTH + keyAccidentalCount(heads[i].key) * METRICS.KEY_ACC_WIDTH
  );

  // Which bars restate what they are written in.  A musician needs the clef
  // and the key at the start of every line and whenever either changes, and
  // nowhere else: restating them on every bar of a phrase is noise, and a
  // wrapped row that begins without them cannot be read at all.  The changes
  // are known now; the line beginnings are known once the bars are wrapped.
  const showHead = bars.map((_, i) => (
    i === 0 || heads[i].clef !== heads[i - 1].clef || heads[i].key !== heads[i - 1].key
  ));
  bars.forEach((_, i) => { if (showHead[i]) prefWidths[i] += headWidth(i); });

  // --- Flow-wrap bars into rows ----------------------------------------
  const rows = [];
  let cur = [];
  let curW = 0;
  bars.forEach((bar, i) => {
    const w = prefWidths[i] + (cur.length ? look.barGap : 0);
    // A fixed number of bars per line when the exercise asks for one — four
    // bars to a line is a shape a student learns to read, and letting the
    // window width decide it means the same exercise looks different on
    // every screen.  Otherwise, as many as fit.
    const full = look.barsPerRow
      ? cur.length >= look.barsPerRow
      : cur.length && curW + w > availWidth;
    if (full) {
      rows.push(cur);
      cur = [];
      curW = 0;
    }
    cur.push(i);
    curW += (cur.length > 1 ? look.barGap : 0) + prefWidths[i];
  });
  if (cur.length) rows.push(cur);

  // Scale each row to fill the available width (never beyond preferred), and
  // lay its bars out left to right.
  const barWidths = new Array(bars.length);
  const placement = new Array(bars.length);
  // The first bar of every row says what it is written in, whether or not
  // anything changed — a row is a line of music, and a line of music starts
  // with a clef.  Its room is taken out of the row it is on, so the row stays
  // the width it was and its bars give up a few pixels each.
  rows.forEach((row) => {
    const first = row[0];
    if (showHead[first]) return;
    showHead[first] = true;
    prefWidths[first] += headWidth(first);
  });

  rows.forEach((row, r) => {
    const pref = row.reduce((sum, i, k) => sum + prefWidths[i] + (k ? look.barGap : 0), 0);
    // Stretched to the line, or left at its natural width.  Stretching is the
    // right default for a score that is read at a distance; a teacher setting
    // out a worksheet wants the bars the size they wrote them, and then
    // wants the short last line centred rather than adrift on the left.
    const scale = (look.stretch || pref > availWidth) ? availWidth / pref : 1;
    const width = row.reduce(
      (sum, i, k) => sum + Math.floor(prefWidths[i] * scale) + (k ? look.barGap : 0), 0,
    );
    let x = METRICS.MARGIN;
    if (look.centre && width < availWidth) x += Math.floor((availWidth - width) / 2);
    row.forEach((i, k) => {
      barWidths[i] = Math.floor(prefWidths[i] * scale);
      placement[i] = { x, y: r * rowHeight + METRICS.STAVE_Y + topPad, row: r };
      x += barWidths[i] + look.barGap;
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
    if (showHead[i]) {
      try {
        stave.addClef(heads[i].clef);
        if (heads[i].key) stave.addKeySignature(heads[i].key);
      } catch (e) { /* an unknown clef or key is not worth losing the score over */ }
    }
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
    // starts at whatever the key signature has already said, so a note that
    // agrees with the key is drawn plain and one that departs from it — a
    // natural cancelling a sharp, most often — is drawn with the accidental
    // that says so.
    const keyMap = keyAccidentals(heads[i].key);
    const barStart = Object.assign({}, keyMap);
    const staveNotes = [];
    (bar.notes || []).forEach((n) => {
      const durType = durationToType(drawnDuration(n));
      let note;
      if (n.is_rest || !n.name) {
        note = new VF.StaveNote({ keys: ["b/4"], duration: durType + "r", clef: heads[i].clef });
      } else {
        const tok = parseNoteToken(n.name);
        // A notehead shape is part of the key in VexFlow: `c/4/x2` is a
        // cross.  Asked for in a try, because a build that does not know a
        // shape should cost the note its decoration and not the score.
        const head = NOTEHEAD_CODES[n.notehead];
        const key = noteNameToVexflow(tok);
        try {
          note = new VF.StaveNote({
            keys: [head ? `${key}/${head}` : key],
            duration: durType, clef: heads[i].clef, auto_stem: true,
          });
        } catch (e) {
          note = new VF.StaveNote({
            keys: [key], duration: durType, clef: heads[i].clef, auto_stem: true,
          });
        }
        // Drawn from what the note *sounds* against what the stave has said
        // so far, rather than from the token's own modifier.  The two differ
        // in exactly the case that was silently wrong: `fr` in G major sounds
        // F natural, carries the modifier `r`, and needs a ♮ that the old
        // rule — which read `r` as "no alteration", the same as a plain `f` —
        // never drew.
        // Against the *key*, never against the running state: a plain `f`
        // after an `f#` earlier in the bar still means "as the key has it",
        // which is how this library spells an enharmonic note and why such a
        // note needs a natural drawn to cancel the sharp before it.
        const accVal = soundedAlteration(tok, keyMap);
        if (accVal !== (barStart[tok.letter] || 0)) {
          const accStr = ALTERATION_TO_ACC[String(accVal)];
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
      note.reaSeparator = n.separator || "";
      note.reaLabel = n;
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

  // A separator opens a hole in the bar: every note after it moves along by
  // the style's separator space.  Done the same way a visual offset is done —
  // by moving the tick context, so the stems, beams and accidentals move with
  // the notehead — and before the offsets, because the two are additive and a
  // teacher's own nudge should land on top of the spacing rather than under
  // it.  See `applyVisualOffset` for why this cannot be a transform.
  formatted.forEach(({ notes }) => {
    let shift = 0;
    notes.forEach((note) => {
      if (shift) applyVisualOffset(note, shift);
      if (note.reaSeparator) shift += look.separatorSpace;
    });
  });
  formatted.forEach(({ notes }) => notes.forEach((note) => {
    applyVisualOffset(note, note.reaVisualOffset);
  }));

  formatted.forEach(({ voice, stave }) => voice && voice.draw(context, stave));
  formatted.forEach(({ notes, stave }) => drawSeparators(context, stave, notes, look));
  formatted.forEach(({ notes, stave, barIndex }) => drawNoteLabels(
    context, stave, notes, look, keyAccidentals(heads[barIndex].key),
  ));

  // Bar numbers, where the style asks for them: on every bar, or once at the
  // start of each line — which is how a score is numbered when the numbers
  // are there to find a place in a rehearsal rather than to count bars.
  if (look.barNumber !== "none") {
    context.save();
    context.setFont("Instrument Sans, sans-serif", 10);
    context.setFillStyle("#6b6f76");
    formatted.forEach(({ stave, barIndex }) => {
      const first = rows[placement[barIndex].row][0] === barIndex;
      if (look.barNumber === "row" && !first) return;
      context.fillText(String(barIndex + 1), stave.getX() + 2, placement[barIndex].y - 10);
    });
    context.restore();
  }
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
  if (svg) {
    svg.classList.add("rea-score");
    // Whether the stems are drawn is the exercise's own decision now, rather
    // than a rule that applied to every REA stave — see `main.css`.
    svg.classList.toggle("heads-only", look.headsOnly);
  }
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
