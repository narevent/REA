/**
 * scoreDoc.js
 *
 * The score being edited, and every way it can change.
 *
 * All edits go through this module, and each one takes a snapshot first, so
 * undo is a matter of restoring the previous document rather than of writing
 * an inverse for every operation.  A lesson is at most a few hundred notes,
 * which makes a snapshot cheaper than the bugs an operation log would buy.
 *
 * The document is exactly the shape the API sends and accepts (see the Python
 * `editor/score.py`), so nothing is translated on the way in or out — what the
 * teacher edits is what gets stored.
 */

import { LETTER_PC, keySignatureMap, noteNameToMidi, parseNoteToken } from "../notation.js?v=83";

/** Note letters in staff order.  German naming: `h` is B-natural. */
export const LETTERS = ["c", "d", "e", "f", "g", "a", "h"];

/** Accidental modifiers a note token may carry, in the order Alt+↑/↓ cycles. */
export const MODIFIERS = [null, "#", "b", "x", "r"];

export const MODIFIER_LABELS = {
  null: "natural (as written)",
  "#": "sharp",
  b: "flat",
  x: "double sharp",
  r: "naturalised (cancels the key signature)",
};

/** Durations, longest first — index+1 is the number key that picks them. */
export const DURATIONS = [
  { value: 1, label: "Whole", short: "1/1" },
  { value: 0.5, label: "Half", short: "1/2" },
  { value: 0.25, label: "Quarter", short: "1/4" },
  { value: 0.125, label: "Eighth", short: "1/8" },
  { value: 0.0625, label: "Sixteenth", short: "1/16" },
  { value: 0.03125, label: "Thirty-second", short: "1/32" },
];

/** The offset is stored in the source's own units; playback multiplies by 12. */
export const OFFSET_GAIN = 12;

const clone = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------
// Note tokens
// ---------------------------------------------------------------------------

/**
 * Build a note token from its parts.  A bare letter means octave index 0 —
 * the source's own convention, and the reason `a` sits below `c1`.
 */
export function buildToken({ letter, octave, modifier }) {
  const oct = octave == null || octave === 0 ? "" : String(octave);
  return `${letter}${oct}${modifier || ""}`;
}

/** Split a token into `{letter, octave, modifier}` with the octave defaulted. */
export function splitToken(name) {
  const tok = parseNoteToken(name || "c1");
  return {
    letter: LETTERS.includes(tok.letter) ? tok.letter : "c",
    octave: tok.octave ?? 0,
    modifier: tok.modifier || null,
  };
}

/**
 * The diatonic index of a token: staff position, ignoring accidentals.
 * `c` at octave index 0 is 0, and each letter step adds one.
 */
export function diatonicIndex(name) {
  const { letter, octave } = splitToken(name);
  return octave * 7 + LETTERS.indexOf(letter);
}

/** The token that sits `steps` diatonic steps away from *name*. */
export function transposeToken(name, steps) {
  const { modifier } = splitToken(name);
  const target = diatonicIndex(name) + steps;
  const octave = Math.floor(target / 7);
  const letter = LETTERS[((target % 7) + 7) % 7];
  if (octave < 0 || octave > 9) return name; // off the edge of the notation
  return buildToken({ letter, octave, modifier });
}

/** The MIDI pitch a note will sound, resolved the way the server resolves it. */
export function noteMidi(event, keySignature) {
  if (!event || event.is_rest || !event.note_name) return null;
  return noteNameToMidi(event.note_name, keySignatureMap(keySignature || []));
}

/** How a note reads to a musician, e.g. "f2# — F♯5". */
export function describeNote(event, keySignature) {
  if (!event) return "";
  if (event.is_rest) return "rest";
  const midi = noteMidi(event, keySignature);
  if (midi == null) return event.note_name;
  const names = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
  return `${event.note_name} — ${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

// ---------------------------------------------------------------------------
// Blank pieces
// ---------------------------------------------------------------------------

/** A new note, taking its voicing defaults from the note it follows.
 *
 * Copying duration, volume and articulation from the previous note is what
 * makes entering a line quick: a teacher writing eighth notes at volume 75
 * should not have to restate that on every note. */
export function blankEvent(previous = null, overrides = {}) {
  const base = {
    note_name: "c1",
    alias_degree: "",
    duration: previous ? previous.duration : 0.125,
    horizontal_offset_ms: 0,
    attack_decay_time: previous ? previous.attack_decay_time : null,
    volume: previous ? previous.volume : 80,
    is_rest: false,
    is_enharmonic: false,
    event_type: "MusicNoteBundle",
    pitch_class: -1,
  };
  return Object.assign(base, overrides);
}

/** A new bar, inheriting the clef/rhythm/key of the bar it follows. */
export function blankBar(system, previous = null) {
  const bar = {
    music_clef: previous ? previous.music_clef : "Violin",
    music_rhythm: previous ? previous.music_rhythm : "FreeStyle",
    music_mode_chord: previous ? previous.music_mode_chord : "",
    is_incomplete_bar: false,
    incomplete_bar_playback_count: 0,
    label: "",
    events: [],
  };
  if (system === "relative") {
    bar.degree = "";
    bar.quality = previous ? previous.quality : "natural";
  }
  return bar;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export class ScoreDoc extends EventTarget {
  constructor(document) {
    super();
    this.doc = document;
    this.undoStack = [];
    this.redoStack = [];
    this.savedSnapshot = JSON.stringify(document);
  }

  // -- identity ----------------------------------------------------------

  get system() { return this.doc.system; }
  get id() { return this.doc.id; }
  get meta() { return this.doc.meta; }
  get bars() { return this.doc.bars; }
  get keySignature() { return this.doc.key_signature || []; }
  get isNew() { return this.doc.id == null; }

  /** True when there are edits the server has not been told about. */
  get isDirty() { return JSON.stringify(this.doc) !== this.savedSnapshot; }

  /** Adopt a document the server has just confirmed (save, load, create). */
  adopt(document) {
    this.doc = document;
    this.undoStack = [];
    this.redoStack = [];
    this.savedSnapshot = JSON.stringify(document);
    this._emit("load");
  }

  /** The payload a save sends: meta, bars, and (relative) the key. */
  payload() {
    const body = { meta: clone(this.doc.meta), bars: clone(this.doc.bars) };
    if (this.system === "relative") body.key_model = this.doc.key_model;
    return body;
  }

  // -- history -----------------------------------------------------------

  /** Run *mutate* as one undoable edit. */
  edit(label, mutate) {
    const before = clone(this.doc);
    const result = mutate(this.doc);
    if (result === false) return false; // the mutation declined; no history
    this.undoStack.push({ label, doc: before });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this._emit("change", { label });
    return true;
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push({ label: entry.label, doc: clone(this.doc) });
    this.doc = entry.doc;
    this._emit("change", { label: `undo ${entry.label}` });
    return entry.label;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push({ label: entry.label, doc: clone(this.doc) });
    this.doc = entry.doc;
    this._emit("change", { label: `redo ${entry.label}` });
    return entry.label;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  _emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // -- reading -----------------------------------------------------------

  bar(barIndex) { return this.doc.bars[barIndex] || null; }

  event(barIndex, noteIndex) {
    const bar = this.bar(barIndex);
    return bar ? bar.events[noteIndex] || null : null;
  }

  /** Every note in the score as `{barIndex, noteIndex, event}`, in order. */
  flatNotes() {
    const out = [];
    this.doc.bars.forEach((bar, barIndex) => {
      bar.events.forEach((event, noteIndex) => out.push({ barIndex, noteIndex, event }));
    });
    return out;
  }

  noteCount() {
    return this.doc.bars.reduce((n, bar) => n + bar.events.length, 0);
  }

  // -- editing: notes ----------------------------------------------------

  insertNote(barIndex, at, overrides = {}) {
    let inserted = null;
    this.edit("insert note", (doc) => {
      const bar = doc.bars[barIndex];
      if (!bar) return false;
      const index = Math.max(0, Math.min(at, bar.events.length));
      const previous = bar.events[index - 1] || bar.events[index] || this._lastNoteBefore(doc, barIndex);
      const event = blankEvent(previous, overrides);
      bar.events.splice(index, 0, event);
      inserted = { barIndex, noteIndex: index };
    });
    return inserted;
  }

  _lastNoteBefore(doc, barIndex) {
    for (let i = barIndex - 1; i >= 0; i -= 1) {
      const bar = doc.bars[i];
      if (bar && bar.events.length) return bar.events[bar.events.length - 1];
    }
    return null;
  }

  deleteNotes(positions) {
    return this.edit("delete note", (doc) => {
      // Delete from the end so earlier indices stay valid as we go.
      const sorted = positions.slice().sort(
        (a, b) => b.barIndex - a.barIndex || b.noteIndex - a.noteIndex
      );
      let removed = 0;
      sorted.forEach(({ barIndex, noteIndex }) => {
        const bar = doc.bars[barIndex];
        if (bar && bar.events[noteIndex]) {
          bar.events.splice(noteIndex, 1);
          removed += 1;
        }
      });
      if (!removed) return false;
    });
  }

  /** Apply `changes` to every position given — the inspector's edit path. */
  updateNotes(positions, changes, label = "edit note") {
    return this.edit(label, (doc) => {
      let touched = 0;
      positions.forEach(({ barIndex, noteIndex }) => {
        const bar = doc.bars[barIndex];
        const event = bar && bar.events[noteIndex];
        if (!event) return;
        Object.assign(event, typeof changes === "function" ? changes(event) : changes);
        if (event.is_rest) {
          event.note_name = "";
          event.is_enharmonic = false;
        } else if (!event.note_name) {
          event.note_name = "c1";
        }
        touched += 1;
      });
      if (!touched) return false;
    });
  }

  /** Move a note to another slot — the drag-and-drop path. */
  moveNote(from, to) {
    return this.edit("move note", (doc) => {
      const source = doc.bars[from.barIndex];
      const target = doc.bars[to.barIndex];
      // Checked before anything is spliced: a mutation that declines halfway
      // would leave the document changed but unrecorded in the undo stack.
      if (!source || !target || !source.events[from.noteIndex]) return false;
      const [event] = source.events.splice(from.noteIndex, 1);
      let index = to.noteIndex;
      if (from.barIndex === to.barIndex && from.noteIndex < to.noteIndex) index -= 1;
      target.events.splice(Math.max(0, Math.min(index, target.events.length)), 0, event);
    });
  }

  // -- editing: bars -----------------------------------------------------

  insertBar(at) {
    let inserted = null;
    this.edit("insert bar", (doc) => {
      const index = Math.max(0, Math.min(at, doc.bars.length));
      const bar = blankBar(this.system, doc.bars[index - 1] || doc.bars[index] || null);
      doc.bars.splice(index, 0, bar);
      inserted = index;
    });
    return inserted;
  }

  deleteBar(barIndex) {
    return this.edit("delete bar", (doc) => {
      if (doc.bars.length <= 1) return false; // a score is never bar-less
      if (!doc.bars[barIndex]) return false;
      doc.bars.splice(barIndex, 1);
    });
  }

  duplicateBar(barIndex) {
    let inserted = null;
    this.edit("duplicate bar", (doc) => {
      const bar = doc.bars[barIndex];
      if (!bar) return false;
      doc.bars.splice(barIndex + 1, 0, clone(bar));
      inserted = barIndex + 1;
    });
    return inserted;
  }

  moveBar(barIndex, delta) {
    return this.edit("move bar", (doc) => {
      const target = barIndex + delta;
      if (target < 0 || target >= doc.bars.length) return false;
      const [bar] = doc.bars.splice(barIndex, 1);
      doc.bars.splice(target, 0, bar);
    });
  }

  updateBars(barIndices, changes, label = "edit bar") {
    return this.edit(label, (doc) => {
      let touched = 0;
      barIndices.forEach((barIndex) => {
        const bar = doc.bars[barIndex];
        if (!bar) return;
        Object.assign(bar, typeof changes === "function" ? changes(bar) : changes);
        touched += 1;
      });
      if (!touched) return false;
    });
  }

  // -- editing: the exercise --------------------------------------------

  updateMeta(changes, label = "edit exercise") {
    return this.edit(label, (doc) => {
      Object.assign(doc.meta, changes);
    });
  }

  /** Rebuild on another key: the notes stay, their key signature changes. */
  setKeyModel(key) {
    return this.edit("change key", (doc) => {
      doc.key_model = key.id;
      doc.key_model_name = key.name;
      doc.key_signature = key.key_signature;
      doc.mode = key.mode;
      // Every bar names its own key signature, so they all have to follow —
      // otherwise the stave would keep drawing the old one.
      doc.bars.forEach((bar) => { bar.music_mode_chord = key.mode_chord; });
    });
  }
}

/** Pitch classes, exported so the inspector can show what a token resolves to. */
export { LETTER_PC };
