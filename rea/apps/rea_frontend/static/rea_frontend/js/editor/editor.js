/**
 * editor.js
 *
 * The score editor a teacher actually drives: library on the left, stave in
 * the middle, properties on the right, and a keyboard that can do all of it
 * without the mouse.
 *
 * Two decisions shape everything here.
 *
 * *Sound is part of editing.*  These are intonation exercises, so a note that
 * has been written but not heard has not really been checked.  Every insert,
 * pitch change and selection plays the note, and the transport plays the bar
 * or the whole exercise with the same synth and the same timing rules the
 * practice app uses — including the offsets, which are the whole point of the
 * data model and are inaudible in any other editor.
 *
 * *Nothing is saved until the teacher says so.*  Edits live in the document
 * (with undo) and go to the server as one whole score.  The page warns before
 * leaving or opening something else with edits outstanding, because an
 * exercise half-written is worse than one not written at all.
 */

import { AudioPlayer } from "../audioPlayer.js?v=83";
import { EditorAPI } from "./editorApi.js?v=83";
import { Inspector } from "./inspector.js?v=83";
import { Library } from "./library.js?v=83";
import { ScoreCanvas } from "./scoreCanvas.js?v=83";
import {
  DURATIONS, LETTERS, MODIFIERS, OFFSET_GAIN, ScoreDoc,
  buildToken, noteMidi, splitToken, transposeToken,
} from "./scoreDoc.js?v=83";

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/** Letter keys write notes; the top-row digits pick durations. */
const LETTER_KEYS = new Set(LETTERS);

class Editor {
  constructor() {
    this.dom = {
      library: document.getElementById("ed-library"),
      toolbar: document.getElementById("ed-toolbar"),
      canvas: document.getElementById("ed-canvas"),
      inspector: document.getElementById("ed-inspector"),
      status: document.getElementById("ed-status"),
      title: document.getElementById("ed-title"),
      subtitle: document.getElementById("ed-subtitle"),
      help: document.getElementById("ed-help"),
    };
    this.selection = { notes: [], bars: [] };
    this.player = new AudioPlayer();
    this.preview = new AudioPlayer();
    this.doc = null;
    this.playing = false;

    this.library = new Library(this.dom.library, {
      search: (params) => EditorAPI.browse(params),
      onOpen: (system, id) => this.open(system, id),
      onNew: (system) => this.createBlank(system),
    });
    this.canvas = new ScoreCanvas(this.dom.canvas, {
      onSelectNote: (position, event) => this.selectNote(position, event),
      onSelectBar: (barIndex, event) => this.selectBar(barIndex, event),
      onInsert: (where) => this.insertAt(where),
      onPitchDrag: (position, steps) => this.transpose([position], steps),
      onOffsetDrag: (position, delta) => this.nudgeOffset([position], delta),
    });
    this.inspector = new Inspector(this.dom.inspector, {
      onNote: (positions, changes) => this.updateNotes(positions, changes),
      onBar: (indices, changes) => this.updateBars(indices, changes),
      onMeta: (changes) => this.updateMeta(changes),
      onKey: (key) => this.setKey(key),
    });
  }

  async boot() {
    this.renderToolbar();
    this.canvas.watchResize();
    this.bindKeyboard();
    this.bindGuards();
    try {
      this.options = await EditorAPI.options();
    } catch (e) {
      this.status(`Could not load the editor's options — ${e.message}`, "error");
      this.options = {};
    }
    this.library.setOptions(this.options);
    this.inspector.setOptions(this.options);
    this.library.render();
    this.library.refresh();
    await this.createBlank("relative", { silent: true });
    this.status("Ready. Click empty staff to write a note, or open an exercise from the list.");
  }

  // -- document lifecycle ------------------------------------------------

  /** Adopt a server document as the score being edited. */
  setDocument(document) {
    if (!this.doc) {
      this.doc = new ScoreDoc(document);
      this.doc.addEventListener("change", () => this.afterChange());
    } else {
      this.doc.adopt(document);
    }
    this.selection = { notes: [], bars: [] };
    this.library.setCurrent(document.system, document.id);
    this.renderAll();
  }

  async open(system, id) {
    if (!(await this.confirmDiscard())) return;
    try {
      const document = await EditorAPI.load(system, id);
      this.setDocument(document);
      this.status(`Opened ${document.display_name}.`);
    } catch (e) {
      this.status(`Could not open that exercise — ${e.message}`, "error");
    }
  }

  async createBlank(system, { silent = false } = {}) {
    if (!silent && !(await this.confirmDiscard())) return;
    try {
      const document = await EditorAPI.blank(system);
      this.setDocument(document);
      if (!silent) this.status("New exercise — set its identity under Exercise, then write the notes.");
    } catch (e) {
      this.status(`Could not start a new exercise — ${e.message}`, "error");
    }
  }

  async save() {
    if (!this.doc) return;
    const payload = this.doc.payload();
    const wasNew = this.doc.isNew;
    this.status("Saving…");
    try {
      const saved = wasNew
        ? await EditorAPI.create(this.doc.system, payload)
        : await EditorAPI.save(this.doc.system, this.doc.id, payload);
      this.doc.adopt(saved);
      this.library.setCurrent(saved.system, saved.id);
      this.library.refresh();
      this.renderAll();
      this.status(wasNew ? `Created “${saved.display_name}”.` : `Saved “${saved.display_name}”.`, "good");
    } catch (e) {
      this.status(e.message, "error");
    }
  }

  async duplicateExercise() {
    if (!this.doc || this.doc.isNew) {
      this.status("Save this exercise before copying it.", "error");
      return;
    }
    if (!(await this.confirmDiscard())) return;
    try {
      const copy = await EditorAPI.duplicate(this.doc.system, this.doc.id);
      this.setDocument(copy);
      this.library.refresh();
      this.status(`Copied to “${copy.display_name}” — it is open now.`, "good");
    } catch (e) {
      this.status(`Could not copy — ${e.message}`, "error");
    }
  }

  async deleteExercise() {
    if (!this.doc || this.doc.isNew) {
      this.status("This exercise has never been saved — there is nothing to delete.", "error");
      return;
    }
    const name = this.doc.doc.display_name;
    if (!window.confirm(`Delete “${name}”? Students will no longer see it. This cannot be undone.`)) return;
    try {
      await EditorAPI.remove(this.doc.system, this.doc.id);
      this.library.refresh();
      await this.createBlank(this.doc.system, { silent: true });
      this.status(`Deleted “${name}”.`, "good");
    } catch (e) {
      this.status(`Could not delete — ${e.message}`, "error");
    }
  }

  /** Ask before throwing away unsaved edits.  Returns whether to proceed. */
  confirmDiscard() {
    if (!this.doc || !this.doc.isDirty) return Promise.resolve(true);
    return Promise.resolve(window.confirm(
      "This exercise has unsaved changes. Discard them?"
    ));
  }

  bindGuards() {
    window.addEventListener("beforeunload", (e) => {
      if (this.doc && this.doc.isDirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  // -- rendering ---------------------------------------------------------

  renderAll() {
    if (!this.doc) return;
    this.canvas.render(this.doc.doc, this.selection);
    this.inspector.render(this.doc.doc, this.selection);
    this.renderHeader();
    this.renderToolbar();
  }

  afterChange() {
    this.clampSelection();
    this.renderAll();
  }

  renderHeader() {
    const doc = this.doc.doc;
    this.dom.title.textContent = doc.display_name || "New exercise";
    const bits = [
      doc.system === "relative" ? `Relative · ${doc.key_model_name || ""}` : "Absolute",
      `${doc.bars.length} bar${doc.bars.length === 1 ? "" : "s"}`,
      `${this.doc.noteCount()} note${this.doc.noteCount() === 1 ? "" : "s"}`,
      `${doc.meta.tempo} bpm`,
    ];
    this.dom.subtitle.textContent = bits.filter(Boolean).join(" · ");
    this.dom.title.classList.toggle("is-dirty", this.doc.isDirty);
  }

  renderToolbar() {
    const bar = this.dom.toolbar;
    bar.innerHTML = "";
    const doc = this.doc;

    const group = (children) => {
      const node = el("div", "ed-tool-group");
      children.forEach((child) => child && node.appendChild(child));
      bar.appendChild(node);
    };

    const button = (label, title, action, { primary = false, disabled = false } = {}) => {
      const node = el("button", `ed-btn${primary ? " ed-btn-primary" : ""}`, label);
      node.type = "button";
      node.title = title;
      node.disabled = disabled;
      node.addEventListener("click", action);
      return node;
    };

    group([
      button(this.doc && this.doc.isNew ? "Create" : "Save", "Save the exercise (⌘/Ctrl+S)", () => this.save(),
        { primary: true, disabled: !doc }),
      button("Undo", "Undo (⌘/Ctrl+Z)", () => this.undo(), { disabled: !doc || !doc.canUndo }),
      button("Redo", "Redo (⌘/Ctrl+Shift+Z)", () => this.redo(), { disabled: !doc || !doc.canRedo }),
    ]);

    group([
      button(this.playing ? "Stop" : "Play", "Play the whole exercise (Space)", () => this.togglePlay(), { disabled: !doc }),
      button("Play bar", "Play the selected bar (Shift+Space)", () => this.playBar(), { disabled: !doc }),
    ]);

    group([
      button("Add bar", "Add a bar after the selection (Enter)", () => this.addBar(), { disabled: !doc }),
      button("Copy bar", "Duplicate the selected bar", () => this.duplicateBar(), { disabled: !doc }),
      button("Delete bar", "Delete the selected bar", () => this.deleteBar(), { disabled: !doc }),
    ]);

    group([
      button("Copy exercise", "Save a copy of this exercise and open it", () => this.duplicateExercise(), { disabled: !doc }),
      button("Delete exercise", "Delete this exercise", () => this.deleteExercise(), { disabled: !doc }),
    ]);

    const views = el("div", "ed-tool-group ed-tool-views");
    [
      ["degrees", "Degrees"],
      ["offsets", "Offsets"],
      ["volumes", "Volumes"],
    ].forEach(([key, label]) => {
      const toggle = el("label", "ed-toggle");
      const input = el("input");
      input.type = "checkbox";
      input.checked = !!this.canvas.view[key];
      input.addEventListener("change", () => this.canvas.setView({ [key]: input.checked }));
      toggle.appendChild(input);
      toggle.appendChild(el("span", null, label));
      views.appendChild(toggle);
    });
    bar.appendChild(views);
  }

  status(message, tone = "") {
    this.dom.status.textContent = message;
    this.dom.status.className = `ed-status ${tone}`;
  }

  // -- selection ---------------------------------------------------------

  clampSelection() {
    const bars = this.doc.doc.bars;
    this.selection.notes = this.selection.notes.filter(({ barIndex, noteIndex }) => {
      const bar = bars[barIndex];
      return bar && bar.events[noteIndex];
    });
    this.selection.bars = this.selection.bars.filter((i) => bars[i]);
  }

  selectNote(position, event = {}) {
    const already = this.selection.notes.findIndex(
      (n) => n.barIndex === position.barIndex && n.noteIndex === position.noteIndex
    );
    if (event.metaKey || event.ctrlKey) {
      if (already >= 0) this.selection.notes.splice(already, 1);
      else this.selection.notes.push(position);
    } else if (event.shiftKey && this.selection.notes.length) {
      // Extend from the anchor across the score in reading order, which is
      // what a teacher means by "these notes" when they shift-click.
      const flat = this.doc.flatNotes();
      const indexOf = (p) => flat.findIndex(
        (n) => n.barIndex === p.barIndex && n.noteIndex === p.noteIndex
      );
      const from = indexOf(this.selection.notes[0]);
      const to = indexOf(position);
      const [lo, hi] = from < to ? [from, to] : [to, from];
      const anchor = this.selection.notes[0];
      const span = flat.slice(lo, hi + 1)
        .map(({ barIndex, noteIndex }) => ({ barIndex, noteIndex }));
      // The anchor stays first, so a further shift-click still extends from
      // where the selection began rather than from its top-left corner.
      this.selection.notes = [anchor].concat(span.filter(
        (n) => !(n.barIndex === anchor.barIndex && n.noteIndex === anchor.noteIndex)
      ));
    } else {
      this.selection.notes = [position];
      this.previewNote(position);
    }
    this.selection.bars = [];
    if (this.inspector.tab === "bar" || this.inspector.tab === "exercise") this.inspector.tab = "note";
    this.renderAll();
  }

  selectBar(barIndex, event = {}) {
    if (event.metaKey || event.ctrlKey) {
      const at = this.selection.bars.indexOf(barIndex);
      if (at >= 0) this.selection.bars.splice(at, 1);
      else this.selection.bars.push(barIndex);
    } else {
      this.selection.bars = [barIndex];
    }
    this.selection.notes = [];
    this.inspector.tab = "bar";
    this.renderAll();
  }

  /** The bar edits apply to: the selected bar, or the selected note's bar. */
  activeBar() {
    if (this.selection.bars.length) return this.selection.bars[0];
    if (this.selection.notes.length) return this.selection.notes[0].barIndex;
    return this.doc.doc.bars.length - 1;
  }

  moveSelection(delta) {
    const flat = this.doc.flatNotes();
    if (!flat.length) return;
    let index = 0;
    if (this.selection.notes.length) {
      const current = this.selection.notes[0];
      index = flat.findIndex((n) => n.barIndex === current.barIndex && n.noteIndex === current.noteIndex);
      index = Math.max(0, Math.min(flat.length - 1, index + delta));
    } else if (delta < 0) {
      index = flat.length - 1;
    }
    const next = flat[index];
    this.selectNote({ barIndex: next.barIndex, noteIndex: next.noteIndex });
    this.canvas.revealNote(next);
  }

  // -- edits -------------------------------------------------------------

  insertAt({ barIndex, noteIndex, noteName }) {
    const position = this.doc.insertNote(barIndex, noteIndex, { note_name: noteName });
    if (!position) return;
    this.selection = { notes: [position], bars: [] };
    this.inspector.tab = "note";
    this.renderAll();
    this.previewNote(position);
  }

  updateNotes(positions, changes) {
    this.doc.updateNotes(positions, changes);
    if (positions.length === 1) this.previewNote(positions[0]);
  }

  updateBars(indices, changes) {
    this.doc.updateBars(indices, changes);
  }

  updateMeta(changes) {
    this.doc.updateMeta(changes);
  }

  setKey(key) {
    this.doc.setKeyModel(key);
    this.status(`Key is now ${key.name}. The written notes are unchanged — check the ones that follow the key signature.`);
  }

  transpose(positions, steps) {
    if (!positions.length || !steps) return;
    this.doc.updateNotes(positions, (event) => (
      event.is_rest ? {} : { note_name: transposeToken(event.note_name, steps) }
    ), steps > 0 ? "raise note" : "lower note");
    if (positions.length === 1) this.previewNote(positions[0]);
  }

  /** Change the accidental of every selected note by cycling the modifier. */
  cycleAccidental(positions, direction) {
    this.doc.updateNotes(positions, (event) => {
      if (event.is_rest) return {};
      const parts = splitToken(event.note_name);
      const at = MODIFIERS.indexOf(parts.modifier);
      const next = MODIFIERS[(at + direction + MODIFIERS.length) % MODIFIERS.length];
      return { note_name: buildToken(Object.assign(parts, { modifier: next })) };
    }, "accidental");
    if (positions.length === 1) this.previewNote(positions[0]);
  }

  setLetter(positions, letter) {
    this.doc.updateNotes(positions, (event) => {
      const parts = splitToken(event.note_name);
      parts.letter = letter;
      return { note_name: buildToken(parts), is_rest: false };
    }, "set pitch");
    if (positions.length === 1) this.previewNote(positions[0]);
  }

  nudgeOffset(positions, delta) {
    this.doc.updateNotes(positions, (event) => ({
      horizontal_offset_ms: Math.max(-60, Math.min(60, (event.horizontal_offset_ms || 0) + delta)),
    }), "timing offset");
  }

  nudgeVolume(positions, delta) {
    this.doc.updateNotes(positions, (event) => ({
      volume: Math.max(0, Math.min(127, (event.volume || 80) + delta)),
    }), "volume");
  }

  setDuration(positions, duration) {
    this.doc.updateNotes(positions, { duration }, "duration");
  }

  toggleRest(positions) {
    this.doc.updateNotes(positions, (event) => ({
      is_rest: !event.is_rest,
      note_name: event.is_rest ? (event.note_name || "c1") : "",
    }), "rest");
  }

  toggleEnharmonic(positions) {
    this.doc.updateNotes(positions, (event) => ({ is_enharmonic: !event.is_enharmonic }), "key-signature note");
  }

  deleteSelection() {
    if (this.selection.notes.length) {
      const first = this.selection.notes[0];
      this.doc.deleteNotes(this.selection.notes);
      const bar = this.doc.doc.bars[first.barIndex];
      const noteIndex = Math.min(first.noteIndex, (bar ? bar.events.length : 1) - 1);
      this.selection.notes = noteIndex >= 0 ? [{ barIndex: first.barIndex, noteIndex }] : [];
      this.renderAll();
    } else if (this.selection.bars.length) {
      this.deleteBar();
    }
  }

  addBar() {
    const index = this.doc.insertBar(this.activeBar() + 1);
    if (index == null) return;
    this.selection = { notes: [], bars: [index] };
    this.inspector.tab = "bar";
    this.renderAll();
    this.status(`Bar ${index + 1} added.`);
  }

  duplicateBar() {
    const index = this.doc.duplicateBar(this.activeBar());
    if (index == null) return;
    this.selection = { notes: [], bars: [index] };
    this.renderAll();
  }

  deleteBar() {
    const index = this.activeBar();
    if (!this.doc.deleteBar(index)) {
      this.status("An exercise needs at least one bar.", "error");
      return;
    }
    this.selection = { notes: [], bars: [Math.max(0, index - 1)] };
    this.renderAll();
  }

  /** Move the selected note one slot, crossing into the next bar at the edge. */
  moveNoteBy(delta) {
    const position = this.selection.notes[0];
    if (!position) return;
    const bars = this.doc.doc.bars;
    let barIndex = position.barIndex;
    let target = position.noteIndex + delta;

    if (target < 0) {
      if (barIndex === 0) return;
      barIndex -= 1;
      target = bars[barIndex].events.length; // append to the end of that bar
    } else if (target > bars[position.barIndex].events.length - 1) {
      if (barIndex >= bars.length - 1) return;
      barIndex += 1;
      target = 0;
    }

    if (!this.doc.moveNote(position, { barIndex, noteIndex: target })) return;
    const settled = Math.min(target, bars[barIndex].events.length - 1);
    this.selection = { notes: [{ barIndex, noteIndex: Math.max(0, settled) }], bars: [] };
    this.renderAll();
  }

  undo() {
    const label = this.doc.undo();
    this.status(label ? `Undid ${label}.` : "Nothing to undo.");
  }

  redo() {
    const label = this.doc.redo();
    this.status(label ? `Redid ${label}.` : "Nothing to redo.");
  }

  // -- playback ----------------------------------------------------------

  /**
   * The exercise as the synth will hear it.
   *
   * This mirrors the practice app's `buildBarSteps`: offsets are scaled by the
   * same gain, the gap between bars comes from the exercise's own
   * `mid_bar_time`, and harmonic lessons play at half tempo — so what a
   * teacher previews is what a student will get, not an approximation of it.
   */
  steps(barIndices) {
    const doc = this.doc.doc;
    const tempo = (doc.meta.tempo > 10 ? doc.meta.tempo : 80) / (doc.meta.texture === "poly" ? 2 : 1);
    const wholeMs = (4 * 60000) / tempo;
    const gapMs = Math.round((doc.meta.mid_bar_time || 0) * 1000);
    const steps = [];
    let barStart = 0;
    barIndices.forEach((barIndex) => {
      const bar = doc.bars[barIndex];
      if (!bar) return;
      let cursor = 0;
      (bar.events || []).forEach((event, noteIndex) => {
        const offset = (event.horizontal_offset_ms || 0) * OFFSET_GAIN;
        const start = Math.max(0, cursor + offset);
        let duration = event.duration || 0.125;
        if (!event.is_rest && duration < 0.0625) duration = 0.125;
        const durationMs = Math.max(20, Math.round(duration * wholeMs));
        steps.push({
          midi: noteMidi(event, doc.key_signature),
          isRest: !!event.is_rest,
          startMs: barStart + start,
          durationMs,
          volume: event.volume || 80,
          barIndex,
          noteIndex,
        });
        cursor = start + durationMs;
      });
      barStart += cursor + gapMs;
    });
    return steps;
  }

  togglePlay() {
    if (this.playing) return this.stop();
    const order = this.doc.doc.bars.map((_, i) => i);
    return this.play(order);
  }

  playBar() {
    const barIndex = this.activeBar();
    this.play([barIndex]);
  }

  play(barIndices) {
    this.stop();
    const steps = this.steps(barIndices);
    if (!steps.length) {
      this.status("Nothing to play yet — write a note first.");
      return;
    }
    this.playing = true;
    this.renderToolbar();
    const started = this.player.play(steps, {
      onStep: (index) => {
        if (index < 0) {
          this.playing = false;
          this.canvas.setPlayhead(null);
          this.renderToolbar();
          return;
        }
        const step = steps[index];
        this.canvas.setPlayhead({ barIndex: step.barIndex, noteIndex: step.noteIndex });
      },
    });
    if (!started) {
      this.playing = false;
      this.status("Audio could not start — click the page once and try again.", "error");
      this.renderToolbar();
    }
  }

  stop() {
    this.player.stop();
    this.playing = false;
    this.canvas.setPlayhead(null);
    this.renderToolbar();
  }

  /** Sound one note, so writing and hearing stay the same action. */
  previewNote(position) {
    const bar = this.doc.doc.bars[position.barIndex];
    const event = bar && bar.events[position.noteIndex];
    if (!event || event.is_rest) return;
    const midi = noteMidi(event, this.doc.doc.key_signature);
    if (midi == null) return;
    this.preview.play([{
      midi, isRest: false, startMs: 0, durationMs: 420, volume: event.volume || 80,
    }]);
  }

  // -- keyboard ----------------------------------------------------------

  bindKeyboard() {
    document.addEventListener("keydown", (e) => {
      const target = e.target;
      const typing = target && (
        target.tagName === "INPUT" || target.tagName === "TEXTAREA"
        || target.tagName === "SELECT" || target.isContentEditable
      );
      const modifier = e.metaKey || e.ctrlKey;

      if (modifier && e.key.toLowerCase() === "s") {
        e.preventDefault();
        this.save();
        return;
      }
      if (typing) return;
      if (modifier && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) this.redo(); else this.undo();
        return;
      }
      if (modifier) return;
      if (!this.doc) return;

      const notes = this.selection.notes;
      const handled = this.handleKey(e, notes);
      if (handled) e.preventDefault();
    });
  }

  handleKey(e, notes) {
    const key = e.key;

    if (key === " ") {
      if (e.shiftKey) this.playBar(); else this.togglePlay();
      return true;
    }
    if (key === "Escape") {
      this.stop();
      this.selection = { notes: [], bars: [] };
      this.renderAll();
      return true;
    }
    if (key === "Enter") {
      this.addBar();
      return true;
    }
    if (key === "[" || key === "]") {
      // Bar-to-bar navigation.  Tab is deliberately left alone: it is how a
      // keyboard user reaches the property panel, and taking it would trade
      // one convenience for the ability to use the editor at all.
      const bars = this.doc.doc.bars;
      const step = key === "]" ? 1 : -1;
      this.selectBar((this.activeBar() + step + bars.length) % bars.length);
      return true;
    }
    if (key === "Delete" || key === "Backspace") {
      this.deleteSelection();
      return true;
    }

    if (key === "ArrowLeft" || key === "ArrowRight") {
      const direction = key === "ArrowRight" ? 1 : -1;
      if (e.altKey) this.moveNoteBy(direction);
      else this.moveSelection(direction);
      return true;
    }

    if (key === "ArrowUp" || key === "ArrowDown") {
      if (!notes.length) return false;
      const direction = key === "ArrowUp" ? 1 : -1;
      if (e.altKey) this.cycleAccidental(notes, direction);
      else this.transpose(notes, direction * (e.shiftKey ? 7 : 1));
      return true;
    }

    if (LETTER_KEYS.has(key.toLowerCase()) && !e.altKey) {
      const letter = key.toLowerCase();
      if (e.shiftKey) {
        // Shift writes a *new* note after the selection, so a melody can be
        // typed straight in without reaching for the mouse between notes.
        const at = notes.length
          ? { barIndex: notes[0].barIndex, noteIndex: notes[0].noteIndex + 1 }
          : { barIndex: this.activeBar(), noteIndex: Number.MAX_SAFE_INTEGER };
        const previous = notes.length
          ? this.doc.event(notes[0].barIndex, notes[0].noteIndex) : null;
        const octave = previous ? splitToken(previous.note_name).octave : 1;
        this.insertAt({
          barIndex: at.barIndex,
          noteIndex: at.noteIndex,
          noteName: buildToken({ letter, octave, modifier: null }),
        });
      } else if (notes.length) {
        this.setLetter(notes, letter);
      } else {
        this.insertAt({
          barIndex: this.activeBar(),
          noteIndex: Number.MAX_SAFE_INTEGER,
          noteName: buildToken({ letter, octave: 1, modifier: null }),
        });
      }
      return true;
    }

    if (/^[1-6]$/.test(key) && notes.length) {
      this.setDuration(notes, DURATIONS[Number(key) - 1].value);
      return true;
    }
    if ((key === "r" || key === "R") && notes.length) {
      this.toggleRest(notes);
      return true;
    }
    if ((key === "k" || key === "K") && notes.length) {
      this.toggleEnharmonic(notes);
      return true;
    }
    if ((key === "," || key === "<") && notes.length) {
      this.nudgeOffset(notes, e.shiftKey ? -5 : -1);
      return true;
    }
    if ((key === "." || key === ">") && notes.length) {
      this.nudgeOffset(notes, e.shiftKey ? 5 : 1);
      return true;
    }
    if ((key === "-" || key === "_") && notes.length) {
      this.nudgeVolume(notes, -5);
      return true;
    }
    if ((key === "=" || key === "+") && notes.length) {
      this.nudgeVolume(notes, 5);
      return true;
    }
    if (key === "?") {
      this.dom.help.hidden = !this.dom.help.hidden;
      return true;
    }
    return false;
  }
}

const editor = new Editor();
editor.boot();
