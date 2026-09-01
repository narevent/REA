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

import { AudioPlayer } from "../audioPlayer.js?v=164";
import { EditorAPI } from "./editorApi.js?v=164";
import { Inspector, TUPLET_CHOICES } from "./inspector.js?v=164";
import {
  Library, SHELF_DESTINATIONS, destinations, metaFromCtx,
} from "./library.js?v=164";
import { ScoreCanvas } from "./scoreCanvas.js?v=164";
import {
  DURATIONS, LETTERS, MAX_VISUAL_OFFSET_PX, MODIFIERS, MODIFIER_LABELS, ScoreDoc,
  buildToken, noteMidi, offsetMs, splitToken, transposeToken,
} from "./scoreDoc.js?v=164";
import { parseMidi, midiToBars, describeImport } from "./midiImport.js?v=164";
import { midiToToken } from "../notation.js?v=164";
import { tupletRatio } from "../practiceData.js?v=164";

/** The accidentals offered as buttons, in the order a musician reaches for
 *  them.  `null` is "whatever the key signature says", which is the state a
 *  note is in until somebody alters it; `r` is the explicit natural that
 *  cancels a key signature, which is a different statement and needs its own
 *  button. */
const ACCIDENTAL_BUTTONS = [
  ["#", "♯", "Sharp (#)"],
  ["b", "♭", "Flat (b)"],
  ["r", "♮", "Natural — cancels the key signature"],
  [null, "—", "As the key signature has it (n)"],
];

/** What each offered tuplet is called, keyed by its note count.  The ratios
 *  themselves live in `TUPLET_CHOICES` beside the inspector's select, so the
 *  buttons and the panel cannot disagree about what a "5" is. */
const TUPLET_NAMES = { 3: "Triplet", 5: "Quintuplet", 6: "Sextuplet", 7: "Septuplet" };

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
    // Where the next note goes, and what it will be.  An eighth is what most
    // of this library is written in.
    this.caret = null;
    this.writeDuration = 0.125;
    // An accidental armed for the next written note, spent when it is used.
    this.writeModifier = null;

    this.library = new Library(this.dom.library, {
      search: (params) => EditorAPI.browse(params),
      onOpen: (system, id) => this.open(system, id),
      onNew: (system) => this.createBlank(system),
    });
    this.canvas = new ScoreCanvas(this.dom.canvas, {
      onSelectNote: (position, event) => this.selectNote(position, event),
      onSelectBar: (barIndex, event) => this.selectBar(barIndex, event),
      onInsert: (where) => this.staffClick(where),
      onOffsetDrag: (position, delta) => this.nudgeOffset([position], delta),
      onDragBegin: (label) => this.beginDrag(label),
      onDragPitch: (position, steps) => this.dragPitch(position, steps),
      onDragVisual: (position, px) => this.dragVisual(position, px),
      onDragOrder: (from, to) => this.dragOrder(from, to),
      onDragEnd: (position) => this.endDrag(position),
      onNoteMenu: (position, event) => this.openNoteMenu(position, event),
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
    this.inspector.setOptions(this.options);
    // The tree draws itself from the curriculum, so it needs no fetch to
    // appear — only the branch a teacher opens costs a request.
    this.library.setOptions(this.options);
    await this.createBlank("relative", { silent: true });
    this.status("Ready. Open a branch on the left to find an exercise, or write one here.");
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
    // The caret belongs to the score being written, not to the editor: it
    // would otherwise survive into a different exercise, pointing at a bar
    // that no longer exists.
    this.resetCaret();
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

  /**
   * Send the score to the server.  Returns whether it got there — callers that
   * are about to navigate away depend on knowing.
   *
   * Saving an exercise that already exists *replaces* it, for everybody: there
   * are no versions and no drafts, and the students practising it get the new
   * one the next time they open it.  That is the right behaviour and it is
   * also the one thing about this editor that can quietly cost somebody else's
   * work, so it is said out loud — before, in what the button offers to do,
   * and after, in what the status line reports.
   */
  async save() {
    if (!this.doc) return false;
    // A score that has never been saved has nothing to replace, and it has
    // not been told where it belongs either — so Save on one is Save-as.
    if (this.doc.isNew) return this.saveAs();
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
      this.status(wasNew
        ? `Created “${saved.display_name}” — it is in the library, and students can practise it now.`
        : `Saved “${saved.display_name}” — this replaces what students practise.`, "good");
      return true;
    } catch (e) {
      this.status(`Not saved — ${e.message}`, "error");
      return false;
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
    const answer = await this.ask({
      title: `Delete “${name}”?`,
      body: "Students will no longer see it, and this cannot be undone.",
      actions: [
        { key: "delete", label: "Delete it", kind: "danger" },
        { key: null, label: "Keep it" },
      ],
    });
    if (answer !== "delete") return;
    try {
      await EditorAPI.remove(this.doc.system, this.doc.id);
      this.library.refresh();
      await this.createBlank(this.doc.system, { silent: true });
      this.status(`Deleted “${name}”.`, "good");
    } catch (e) {
      this.status(`Could not delete — ${e.message}`, "error");
    }
  }

  // -- MIDI import -------------------------------------------------------

  /**
   * Replace the notes of the open exercise with those of a MIDI file.
   *
   * The exercise's *identity* is untouched — its category, part, number and
   * key stay exactly as they are, and only the bars change.  That is the
   * useful shape: a teacher sets up where an exercise belongs once, and the
   * music arrives from wherever they already wrote it.
   *
   * Nothing is saved.  The import is an ordinary undoable edit sitting in the
   * document like any other, so it can be played, corrected, undone, or simply
   * abandoned by opening something else — and it reaches students only when
   * the teacher presses Save, which is the same bargain every other edit here
   * makes.
   */
  importMidi() {
    if (!this.doc) return;
    // The picker is built per use rather than living in the page: a file input
    // remembers its last file, and a second import of the same filename would
    // otherwise fire no change event at all.
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".mid,.midi,audio/midi,audio/x-midi";
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (file) this.applyMidiFile(file);
    });
    input.click();
  }

  async applyMidiFile(file) {
    this.status(`Reading ${file.name}…`);
    let parsed;
    let converted;
    try {
      parsed = parseMidi(await file.arrayBuffer());
      converted = midiToBars(parsed, {
        system: this.doc.system,
        keySignature: this.doc.keySignature,
        // The first bar of the open score is the template: an imported melody
        // should keep the clef, rhythm mode and key chord the exercise already
        // uses rather than reverting a carefully set-up score to the defaults.
        template: this.doc.bar(0),
      });
    } catch (e) {
      this.status(`Could not import ${file.name} — ${e.message}`, "error");
      return;
    }

    const summary = describeImport(converted.report);
    const existing = this.doc.noteCount();
    const warning = existing
      ? `\n\nThis replaces the ${existing} note${existing === 1 ? "" : "s"} currently in the score. Undo will bring them back, and nothing is saved until you press Save.`
      : "";
    if (!window.confirm(`Import ${file.name}?\n\n${summary}${warning}`)) {
      this.status("Import cancelled.");
      return;
    }

    // One undo step covers the notes and the tempo together — they came from
    // the same file, and taking back half an import would be a puzzle.
    this.doc.edit("import MIDI", (doc) => {
      doc.bars = JSON.parse(JSON.stringify(converted.bars));
      if (parsed.tempoBpm) doc.meta.tempo = parsed.tempoBpm;
    });
    this.selection = { notes: [], bars: [] };
    this.renderAll();
    this.status(`Imported ${file.name} — ${summary}. Not saved yet.`, "good");
  }

  /**
   * Ask a question with more than two answers.
   *
   * `window.confirm` only has OK and Cancel, and the question this editor most
   * needs to ask — "you have unsaved work and you are about to leave it" — has
   * three: save it, throw it away, or stay put.  Forced into two, the prompt
   * had to leave out the one a teacher actually wants, so the only way to keep
   * the work was to cancel, find Save, press it, and then start the navigation
   * again.
   *
   * @param {object} spec  {title, body, actions: [{key, label, kind}]}
   * @returns {Promise<string|null>}  the chosen action's key, or null
   */
  ask({ title, body, actions }) {
    return new Promise((resolve) => {
      const scrim = el("div", "ed-ask-scrim");
      const box = el("div", "ed-ask");
      box.appendChild(el("h2", "ed-ask-title", title));
      if (body) box.appendChild(el("p", "ed-ask-body", body));
      const row = el("div", "ed-ask-actions");

      let done = false;
      const close = (key) => {
        if (done) return;
        done = true;
        document.removeEventListener("keydown", onKey, true);
        scrim.remove();
        resolve(key);
      };
      // Escape is always the safe answer: it cancels, whatever the buttons say.
      const onKey = (e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        close(null);
      };

      actions.forEach((action) => {
        const button = el("button", `ed-btn${action.kind ? " ed-btn-" + action.kind : ""}`, action.label);
        button.type = "button";
        button.addEventListener("click", () => close(action.key));
        row.appendChild(button);
      });
      box.appendChild(row);
      scrim.appendChild(box);
      scrim.addEventListener("click", (e) => { if (e.target === scrim) close(null); });
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(scrim);
      const first = row.querySelector("button");
      if (first) first.focus();
    });
  }

  /**
   * Ask a question that needs an answer typed rather than chosen.
   *
   * Same dialog as `ask`, with fields.  It stays open when the caller says
   * the answer was refused — a name already taken is a thing to correct, not
   * a reason to lose the dialog and start again.
   *
   * @param {object} spec  {title, body, fields: [{key, label, value, type, hint}],
   *                        confirm, onSubmit(values) -> Promise<string|null>}
   *                       `onSubmit` resolves to an error message to show, or
   *                       null when it succeeded and the dialog should close.
   */
  askForm({ title, body, fields, confirm = "Save" }) {
    return new Promise((resolve) => {
      const scrim = el("div", "ed-ask-scrim");
      const box = el("div", "ed-ask");
      const form = document.createElement("form");
      form.className = "ed-ask-form";
      box.appendChild(el("h2", "ed-ask-title", title));
      if (body) box.appendChild(el("p", "ed-ask-body", body));

      const inputs = new Map();
      fields.forEach((field) => {
        const row = el("label", "ed-field");
        row.appendChild(el("span", "ed-field-lbl", field.label));
        let input;
        if (field.type === "destination") {
          // A hundred and fifty places in a dropdown is a scroll, not a
          // choice.  A filter box over a list of paths lets a teacher type
          // "octave alter" and see the three that match, with the whole path
          // of each one visible — which is the thing they are choosing.
          const wrap = el("div", "ed-picker");
          const filter = el("input", "ed-input ed-picker-filter");
          filter.type = "search";
          filter.placeholder = "Filter…";
          const list = el("div", "ed-picker-list");
          input = el("input");
          input.type = "hidden";
          input.value = field.value == null ? "" : String(field.value);
          const paint = () => {
            const q = filter.value.trim().toLowerCase();
            list.innerHTML = "";
            field.options
              .filter((o) => !q || o.label.toLowerCase().includes(q))
              .forEach((option) => {
                const item = el("button", "ed-picker-item", option.label);
                item.type = "button";
                item.classList.toggle("is-on", String(option.value) === input.value);
                item.addEventListener("click", () => {
                  input.value = String(option.value);
                  paint();
                });
                list.appendChild(item);
              });
            if (!list.children.length) list.appendChild(el("p", "ed-hint", "Nothing matches that."));
            const current = list.querySelector(".is-on");
            if (current) current.scrollIntoView({ block: "nearest" });
          };
          filter.addEventListener("input", paint);
          paint();
          wrap.appendChild(filter);
          wrap.appendChild(list);
          wrap.appendChild(input);
          row.appendChild(wrap);
          if (field.hint) row.appendChild(el("span", "ed-field-hint", field.hint));
          inputs.set(field.key, input);
          form.appendChild(row);
          return;
        }
        if (field.options) {
          input = el("select", "ed-input");
          field.options.forEach((option) => {
            const node = el("option", null, option.label);
            node.value = String(option.value);
            input.appendChild(node);
          });
        } else {
          input = el("input", "ed-input");
          input.type = field.type || "text";
        }
        input.value = field.value == null ? "" : String(field.value);
        row.appendChild(input);
        if (field.hint) row.appendChild(el("span", "ed-field-hint", field.hint));
        inputs.set(field.key, input);
        form.appendChild(row);
      });

      const error = el("p", "ed-ask-error");
      error.hidden = true;
      form.appendChild(error);

      const row = el("div", "ed-ask-actions");
      const submit = el("button", "ed-btn ed-btn-primary", confirm);
      submit.type = "submit";
      const cancel = el("button", "ed-btn", "Cancel");
      cancel.type = "button";
      row.appendChild(submit);
      row.appendChild(cancel);
      form.appendChild(row);
      box.appendChild(form);

      let done = false;
      const close = (value) => {
        if (done) return;
        done = true;
        document.removeEventListener("keydown", onKey, true);
        scrim.remove();
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        close(null);
      };
      cancel.addEventListener("click", () => close(null));
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const values = {};
        inputs.forEach((input, key) => { values[key] = input.value; });
        close({
          values,
          // Handed back so the caller can reject: it reopens nothing, it just
          // never closed.
          fail: (message) => {
            done = false;
            error.textContent = message;
            error.hidden = false;
            document.addEventListener("keydown", onKey, true);
            document.body.appendChild(scrim);
            const first = form.querySelector("input, select");
            if (first) { first.focus(); first.select && first.select(); }
          },
        });
      });

      scrim.appendChild(box);
      scrim.addEventListener("click", (e) => { if (e.target === scrim) close(null); });
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(scrim);
      const first = form.querySelector("input, select");
      if (first) { first.focus(); first.select && first.select(); }
    });
  }

  /**
   * Save what is on screen as a *new* exercise, leaving the one it came from
   * as it was.
   *
   * This is the editor's default save, and the reason is that most editing
   * here starts from an exercise that already exists and is already being
   * practised.  A teacher opens the C major octave formula to make the one
   * they actually want, and the dangerous thing to offer them at that moment
   * is a button that replaces it for every student.  Save-as makes the common
   * case — "like that one, but mine" — the safe one, and leaves Save for when
   * replacing really is the intention.
   *
   * All it asks for is what makes the new exercise distinguishable from its
   * siblings: the variant on the relative side, the exercise number on the
   * absolute one.  Everything else about where it belongs is carried over.
   */
  async saveAs() {
    if (!this.doc) return false;
    const system = this.doc.system;
    const meta = this.doc.doc.meta;
    const relative = system === "relative";
    const places = destinations().filter((d) => d.ctx.system === system);
    const keys = (this.options && this.options.keys) || [];

    const answer = await this.askForm({
      title: "Save as a new exercise",
      body: this.doc.isNew
        ? "Choose where it belongs, or leave it in the drafts until you know."
        : `“${this.doc.doc.display_name}” stays exactly as it is; this saves what is on screen beside it.`,
      fields: [
        {
          key: "where", label: "Where it goes", type: "destination",
          // The shelves first: they are the two answers that are not a place
          // in the method, and one of them is where a new exercise already is.
          options: SHELF_DESTINATIONS.map((shelf) => ({
            value: `shelf:${shelf.value}`, label: shelf.label,
          })).concat(places.map((d, i) => ({ value: String(i), label: d.label }))),
          value: meta.shelf ? `shelf:${meta.shelf}` : this._currentDestination(places, meta),
          hint: "Any category in the curriculum, the drafts, or the dictations.",
        },
        relative ? {
          key: "key_model", label: "Key",
          options: keys.map((k) => ({ value: k.id, label: k.name })),
          value: this.doc.doc.key_model,
        } : null,
        relative ? {
          key: "variant", label: "Variant", value: this._suggestVariant(meta.variant),
          hint: "What tells this exercise apart from the others in the same category.",
        } : {
          key: "exercise_number", label: "Exercise number", type: "number",
          value: (Number(meta.exercise_number) || 0) + 1,
        },
      ].filter(Boolean),
      confirm: "Save as new",
    });
    if (!answer) return false;

    const payload = this.doc.payload();
    const where = answer.values.where;
    if (where.startsWith("shelf:")) {
      // Onto a shelf: the exercise keeps whatever identity it happens to have
      // and simply lives somewhere other than the curriculum.
      payload.meta.shelf = where.slice("shelf:".length);
    } else {
      // Filing it into the method: the destination's own facets decide where
      // it lands, and they must be the same ones the tree filters that branch
      // by.
      Object.assign(payload.meta, metaFromCtx(places[Number(where)].ctx, system));
    }
    if (relative) {
      payload.key_model = Number(answer.values.key_model) || payload.key_model;
      // A draft's variant is its working title, so it is kept either way.
      payload.meta.variant = answer.values.variant.trim();
    } else {
      payload.meta.exercise_number = Number(answer.values.exercise_number);
    }

    this.status("Saving…");
    try {
      const saved = await EditorAPI.create(system, payload);
      this.doc.adopt(saved);
      this.library.setCurrent(saved.system, saved.id);
      this.library.refresh();
      this.renderAll();
      const shelf = saved.meta && saved.meta.shelf;
      this.status(
        shelf === "draft"
          ? `Saved “${saved.display_name}” to the drafts — students do not see it.`
          : shelf === "dictation"
            ? `Saved “${saved.display_name}” as a dictation — students find it under Dictation.`
            : `Created “${saved.display_name}” — it is in the library, and students can practise it now.`,
        "good");
      return true;
    } catch (e) {
      answer.fail(e.message);
      return false;
    }
  }

  /** The destination the open exercise is already filed under, so Save-as
   *  starts from where it came from rather than from the top of the list. */
  _currentDestination(places, meta) {
    const index = places.findIndex((d) => {
      const candidate = metaFromCtx(d.ctx, this.doc.system);
      return Object.entries(candidate).every(([field, value]) => (
        field === "shelf" || String(meta[field] ?? "") === String(value)
      ));
    });
    return index >= 0 ? String(index) : "";
  }

  /** A variant name that is probably free, as a starting suggestion.  The
   *  server has the last word on whether it really is. */
  _suggestVariant(current) {
    const base = (current || "").trim();
    if (!base) return "v2";
    const numbered = /^(.*?)-(\d+)$/.exec(base);
    if (numbered) return `${numbered[1]}-${Number(numbered[2]) + 1}`;
    return `${base}-2`;
  }

  /**
   * Ask before throwing away unsaved edits.  Returns whether to proceed.
   *
   * Saving from here counts as proceeding only if the save actually worked —
   * a server that refused the score is exactly the moment not to walk away
   * from it.
   */
  async confirmDiscard() {
    if (!this.doc || !this.doc.isDirty) return true;
    const isNew = this.doc.isNew;
    const answer = await this.ask({
      title: "You have unsaved changes",
      body: isNew
        ? "This exercise has never been saved. Leaving it now loses it."
        : `“${this.doc.doc.display_name}” has edits that are not saved yet.`,
      actions: [
        { key: "save", label: isNew ? "Create, then continue" : "Save, then continue", kind: "primary" },
        { key: "discard", label: "Discard the changes" },
        { key: null, label: "Stay here" },
      ],
    });
    if (answer === "discard") return true;
    if (answer !== "save") return false;
    return this.save();
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
    // The menu is showing the note that just changed, so it has to be redrawn
    // from the new document — otherwise its own controls would go on showing
    // what they said before the edit they made.
    if (this._menu) this.inspector.renderNoteMenu(this._menu, this.doc.doc, this.selection);
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

    // Two rows, and the split is the point.  The top row is what you do to
    // the *exercise* — save it, play it, add a bar, delete it — and is the
    // same whatever is selected.  The bottom row is what you write *into* it,
    // and every control on it answers the question "what will the next note
    // be, or what should these notes become".  They used to be one long line
    // in which "Delete exercise" sat between the note values and the tuplets.
    const rows = [el("div", "ed-toolbar-row"), el("div", "ed-toolbar-row ed-toolbar-write")];
    rows.forEach((row) => bar.appendChild(row));

    const group = (row, children, className = "") => {
      const node = el("div", `ed-tool-group ${className}`.trim());
      children.forEach((child) => child && node.appendChild(child));
      rows[row].appendChild(node);
      return node;
    };

    const button = (label, title, action, { primary = false, quiet = false, disabled = false } = {}) => {
      const node = el("button", `ed-btn${primary ? " ed-btn-primary" : ""}${quiet ? " ed-btn-quiet" : ""}`, label);
      node.type = "button";
      node.title = title;
      node.disabled = disabled;
      node.addEventListener("click", action);
      return node;
    };

    /** A palette: a caption and a row of choices, as one labelled block. */
    const palette = (caption, items) => {
      const node = el("div", "ed-palette");
      node.appendChild(el("span", "ed-palette-lbl", caption));
      const set = el("div", "ed-palette-set");
      items.forEach((item) => set.appendChild(item));
      node.appendChild(set);
      return node;
    };

    const choice = (label, title, on, disabled, action, extra = "") => {
      const node = el("button", `ed-dur ${extra}`.trim(), label);
      node.type = "button";
      node.title = title;
      node.disabled = disabled;
      node.classList.toggle("is-on", on);
      node.addEventListener("click", action);
      return node;
    };

    // ---- row 1: the exercise --------------------------------------------
    // Save-as leads and Save follows, because most editing here starts from
    // an exercise students are already practising: the safe answer should be
    // the one under the cursor.
    const isNew = this.doc && this.doc.isNew;
    group(0, [
      button("Save as…",
        "Save what is on screen as a new exercise — choose where it goes, or leave it in the drafts (⌘/Ctrl+Shift+S)",
        () => this.saveAs(), { primary: true, disabled: !doc }),
      button("Save", `Replace “${this.doc ? this.doc.doc.display_name : ""}” with what is on screen — students get it straight away (⌘/Ctrl+S)`,
        () => this.save(), { disabled: !doc || isNew }),
    ]);

    group(0, [
      button("Undo", "Undo (⌘/Ctrl+Z)", () => this.undo(), { disabled: !doc || !doc.canUndo }),
      button("Redo", "Redo (⌘/Ctrl+Shift+Z)", () => this.redo(), { disabled: !doc || !doc.canRedo }),
    ]);

    group(0, [
      button(this.playing ? "Stop" : "Play", "Play the whole exercise (Space)", () => this.togglePlay(), { disabled: !doc }),
      button("Play bar", "Play the selected bar (Shift+Space)", () => this.playBar(), { disabled: !doc }),
    ]);

    group(0, [
      button("Add bar", "Add a bar after the selection (Enter)", () => this.addBar(), { disabled: !doc }),
      button("Copy bar", "Duplicate the selected bar", () => this.duplicateBar(), { disabled: !doc }),
      button("Delete bar", "Delete the selected bar", () => this.deleteBar(), { disabled: !doc }),
    ]);

    // The three that act on the whole exercise, quiet and last: they are
    // reached rarely and two of them are hard to take back.
    group(0, [
      button("Import MIDI…", "Replace the notes with those from a MIDI file", () => this.importMidi(), { quiet: true, disabled: !doc }),
      button("Copy exercise", "Save a copy of this exercise and open it", () => this.duplicateExercise(), { quiet: true, disabled: !doc }),
      button("Delete exercise", "Delete this exercise", () => this.deleteExercise(), { quiet: true, disabled: !doc }),
    ], "ed-tool-rare");

    // ---- row 2: writing notes -------------------------------------------
    // Shortest first, the way MuseScore numbers them, so the palette and the
    // number keys agree about which is which.
    rows[1].appendChild(palette("Value", DURATIONS.slice().reverse().map((d) => {
      const key = Object.entries(Editor.DURATION_KEYS).find(([, v]) => v === d.value);
      return choice(d.short, key ? `${d.label} (${key[0]})` : d.label,
        this.writeDuration === d.value, !doc, () => {
          this.setWriteDuration(d.value);
          if (this.selection.notes.length) this.setDuration(this.selection.notes, d.value);
        });
    })));

    // With a note selected these change it; in note input they arm the next
    // one, which is how MuseScore's palette behaves — you say sharp and then
    // say which note.
    rows[1].appendChild(palette("Accidental", ACCIDENTAL_BUTTONS.map(([modifier, label, title]) => (
      // Only a real accidental lights up.  "—" is the one that *clears* an
      // accidental, and lighting it whenever nothing was armed made the row
      // look permanently set to something.
      choice(label, title, this.writeModifier != null && this.writeModifier === modifier,
        !doc, () => this.pickAccidental(modifier), "ed-acc")
    ))));

    // Tuplets act on a *selection* rather than arming the next note: a tuplet
    // is a statement about several notes together, and there is nothing to
    // say until they exist.
    const selected = this.selection.notes;
    rows[1].appendChild(palette("Tuplet", TUPLET_CHOICES.map(([num, den]) => (
      choice(String(num), `${TUPLET_NAMES[num] || num} — ${num} in the time of ${den}`,
        this._selectionIsTuplet(num, den), !doc || !selected.length,
        () => this.toggleTuplet(num, den), "ed-tup")
    ))));

    // What the stave shows.  Last on the row and visually apart: these change
    // the picture and never the exercise.
    const views = el("div", "ed-tool-group ed-tool-views");
    [
      ["degrees", "Degrees"],
      ["offsets", "Offsets"],
      ["volumes", "Volumes"],
      ["rhythm", "Rhythm"],
    ].forEach(([key, label]) => {
      const item = el("label", "ed-toggle");
      const input = el("input");
      input.type = "checkbox";
      input.checked = !!this.canvas.view[key];
      input.addEventListener("change", () => this.canvas.setView({ [key]: input.checked }));
      item.appendChild(input);
      item.appendChild(el("span", null, label));
      views.appendChild(item);
    });
    rows[1].appendChild(views);
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
    // Clicking a note selects it *and* moves the caret after it, because they
    // are the same cursor — see `resetCaret`.  Typing then carries on from
    // where you clicked, which is what clicking into text does.
    this.caret = { barIndex: position.barIndex, at: position.noteIndex + 1 };
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

  /**
   * The right-click menu: a note's properties, where the note is.
   *
   * The sidebar has had all of this from the beginning, and the sidebar is
   * across the screen.  Editing one note means looking at the stave, deciding
   * something about a notehead, and then moving eyes and mouse to the far
   * edge of the window to say it — for every note.  This is the same panel
   * brought to the cursor.
   *
   * It is literally the same panel: `renderNoteMenu` runs the Note tab's own
   * field declarations into this popup, so there is no second list of
   * properties to keep in step.  The compactness is styling — the hints are
   * dropped and the spacing tightened — because a menu at the cursor is read
   * by somebody who already knows what these fields are.
   */
  /**
   * A drag in progress: one entry in the history, redrawn on every step.
   *
   * The score is edited live so the notehead a teacher is dragging actually
   * moves — with its stem, its beam and its neighbours' spacing, because it
   * is the real score being redrawn rather than a ghost floating over a stale
   * one.  `beginDrag` remembers what the note was, so each step is measured
   * from where the drag started rather than compounding.
   */
  beginDrag(label) {
    const note = this.selection.notes[0];
    const event = note ? this.doc.event(note.barIndex, note.noteIndex) : null;
    this._dragFrom = event
      ? { note_name: event.note_name, visual_offset_px: event.visual_offset_px || 0 }
      : null;
    this.doc.beginLive(label);
  }

  dragPitch(position, steps) {
    if (!this._dragFrom) return;
    this.doc.live((doc) => {
      const bar = doc.bars[position.barIndex];
      const event = bar && bar.events[position.noteIndex];
      if (!event || event.is_rest) return;
      event.note_name = transposeToken(this._dragFrom.note_name, steps);
    });
  }

  dragVisual(position, px) {
    this.doc.live((doc) => {
      const bar = doc.bars[position.barIndex];
      const event = bar && bar.events[position.noteIndex];
      if (event) event.visual_offset_px = px;
    });
  }

  /** Sideways drag: the note changes places with its neighbours. */
  dragOrder(from, to) {
    this.doc.live((doc) => {
      const bar = doc.bars[from.barIndex];
      if (!bar || !bar.events[from.noteIndex]) return;
      const [event] = bar.events.splice(from.noteIndex, 1);
      let index = to.noteIndex;
      if (from.noteIndex < to.noteIndex) index -= 1;
      bar.events.splice(Math.max(0, Math.min(index, bar.events.length)), 0, event);
    });
  }

  endDrag(position) {
    this._dragFrom = null;
    this.doc.endLive();
    // The note has moved, so the selection and the caret follow it there.
    this.selection = { notes: [position], bars: [] };
    this.caret = { barIndex: position.barIndex, at: position.noteIndex + 1 };
    this.canvas.setCaret(this.caret);
    this.renderAll();
    this.previewNote(position);
  }

  /** A click on empty staff writes a note at that pitch, at the armed note
   *  value, and leaves the caret after it.  Clicking a *note* selects it
   *  instead — see `selectNote`. */
  staffClick(where) {
    const position = this.doc.insertNote(where.barIndex, where.noteIndex, {
      note_name: where.noteName,
      duration: this.writeDuration,
      is_rest: false,
    });
    if (!position) return;
    this.setCaret({ barIndex: where.barIndex, at: position.noteIndex + 1 });
    this.previewNote(position);
  }

  openNoteMenu(position, event) {
    this.closeNoteMenu();
    // Right-clicking a note that is not selected selects it: acting on
    // something other than what you pointed at is how menus lose people.
    const selected = this.selection.notes.some(
      (n) => n.barIndex === position.barIndex && n.noteIndex === position.noteIndex
    );
    if (!selected) {
      this.selection = { notes: [position], bars: [] };
      this.renderAll();
    }

    const menu = el("div", "ed-menu");
    this.inspector.renderNoteMenu(menu, this.doc.doc, this.selection);
    document.body.appendChild(menu);

    // Placed at the cursor, then pulled back inside the window — a menu that
    // opens half off-screen is worse than no menu.
    const pad = 8;
    const box = menu.getBoundingClientRect();
    const x = Math.min(event.clientX, window.innerWidth - box.width - pad);
    const y = Math.min(event.clientY, window.innerHeight - box.height - pad);
    menu.style.left = `${Math.max(pad, x)}px`;
    menu.style.top = `${Math.max(pad, y)}px`;

    this._menu = menu;
    // Anything that is not the menu closes it, including a scroll: the menu
    // is anchored to a point in the window, and the note moves out from under
    // it the moment the score scrolls.
    this._menuAway = (e) => { if (!menu.contains(e.target)) this.closeNoteMenu(); };
    this._menuKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); this.closeNoteMenu(); } };
    setTimeout(() => {
      document.addEventListener("mousedown", this._menuAway, true);
      document.addEventListener("keydown", this._menuKey, true);
      window.addEventListener("scroll", this._menuAway, true);
    }, 0);
  }

  closeNoteMenu() {
    if (!this._menu) return;
    document.removeEventListener("mousedown", this._menuAway, true);
    document.removeEventListener("keydown", this._menuKey, true);
    window.removeEventListener("scroll", this._menuAway, true);
    this._menu.remove();
    this._menu = null;
  }

  // -- note input --------------------------------------------------------

  /**
   * The caret: where the next note will go.
   *
   * There is no note-input *mode* any more.  There was one, briefly, because
   * MuseScore has one — but MuseScore needs it to tell "click to select" from
   * "click to write", and this editor exists to write exercises.  A mode
   * whose off state is "the editor does not do its job" is a switch nobody
   * wants to find turned off, and it cost a button, a keystroke and an
   * explanation for a distinction nobody here was asking for.
   *
   * So the caret is always live, and it is the same cursor as the selection:
   * the selected note is the one just before the caret.  Clicking a note
   * selects it and puts the caret after it; typing writes at the caret and
   * selects what was written; the arrow keys move both.  One position, said
   * two ways — the note you are looking at, and the gap you are about to
   * write into.
   */
  resetCaret() {
    const bars = this.doc ? this.doc.doc.bars : [];
    const barIndex = Math.max(0, bars.length - 1);
    const bar = bars[barIndex];
    this.caret = { barIndex, at: bar ? bar.events.length : 0 };
    if (this.canvas) this.canvas.setCaret(this.caret);
  }

  /** Move the caret, and select the note it now sits after — they are one
   *  cursor, so the panel always shows the note you last touched. */
  setCaret(caret, { select = true } = {}) {
    this.caret = caret;
    this.canvas.setCaret(caret);
    if (select) {
      const at = caret ? caret.at - 1 : -1;
      const event = caret ? this.doc.event(caret.barIndex, at) : null;
      this.selection = event
        ? { notes: [{ barIndex: caret.barIndex, noteIndex: at }], bars: [] }
        : { notes: [], bars: [] };
    }
    this.renderAll();
  }

  /**
   * The accidental button: change the selected notes, or arm the next one.
   *
   * Clicking it twice disarms it, so a sharp picked by mistake in note input
   * is undone by the same button rather than by finding the "natural" one —
   * which would not be the same thing, since a written natural cancels the
   * key signature and an unarmed accidental simply follows it.
   */
  pickAccidental(modifier) {
    if (this.selection.notes.length) {
      this.setAccidental(this.selection.notes, modifier);
      return;
    }
    this.writeModifier = this.writeModifier === modifier ? null : modifier;
    this.renderToolbar();
    if (this.writeModifier) {
      this.status(`The next note written will be ${MODIFIER_LABELS[this.writeModifier]}.`);
    }
  }

  /** Whether every selected note already carries this tuplet ratio. */
  _selectionIsTuplet(num, den) {
    const notes = this.selection.notes;
    if (!notes.length) return false;
    return notes.every((position) => {
      const event = this.doc.event(position.barIndex, position.noteIndex);
      return event && event.tuplet_num === num && event.tuplet_den === den;
    });
  }

  /** Make the selection a tuplet, or — if it already is one — an ordinary
   *  run of notes again. */
  toggleTuplet(num, den) {
    const notes = this.selection.notes;
    if (!notes.length) return;
    const already = this._selectionIsTuplet(num, den);
    if (!already && notes.length % num !== 0) {
      // The drawing cuts a marked run into groups of `num`, so a selection
      // that is not a whole number of groups would leave notes marked as
      // part of a tuplet that no bracket covers and no ratio explains.
      // Refused with the number needed, rather than half-applied.
      this.status(
        `A ${num}-note tuplet needs a multiple of ${num} notes — ${notes.length} selected.`,
        "error",
      );
      return;
    }
    this.doc.setTuplet(notes, already ? 0 : num, den);
    this.status(already
      ? "Tuplet removed."
      : `${notes.length} note${notes.length === 1 ? "" : "s"} as ${num} in the time of ${den}.`);
  }

  /** The note value the next written note will take. */
  setWriteDuration(duration) {
    this.writeDuration = duration;
    this.renderToolbar();
    this.status(`Letters now write ${this._durationLabel(duration)} notes.`);
  }

  _durationLabel(duration) {
    const found = DURATIONS.find((d) => d.value === duration);
    return found ? found.label.toLowerCase() : String(duration);
  }

  /** Where the caret currently is, clamped to a bar that still exists. */
  _caret() {
    const bars = this.doc.doc.bars;
    if (!this.caret || !bars[this.caret.barIndex]) {
      return { barIndex: Math.max(0, bars.length - 1), at: 0 };
    }
    const bar = bars[this.caret.barIndex];
    return { barIndex: this.caret.barIndex, at: Math.max(0, Math.min(this.caret.at, bar.events.length)) };
  }

  /** Write a note at the caret and step past it. */
  writeNote(letter) {
    const { barIndex, at } = this._caret();
    // The octave follows the note before, so a line stays in one register
    // unless it is told otherwise — the same rule the mouse path uses.
    const previous = this.doc.event(barIndex, at - 1) || this.doc.event(barIndex, at);
    const octave = previous && previous.note_name ? splitToken(previous.note_name).octave : 1;
    const position = this.doc.insertNote(barIndex, at, {
      note_name: buildToken({ letter, octave, modifier: this.writeModifier }),
      duration: this.writeDuration,
      is_rest: false,
    });
    if (!position) return;
    // An armed accidental applies to the note it was armed for and no further,
    // the way a written accidental applies to the note it is drawn against.
    this.writeModifier = null;
    this.setCaret({ barIndex, at: at + 1 });
    this.previewNote(position);
  }

  /** Write a rest at the caret and step past it. */
  writeRest() {
    const { barIndex, at } = this._caret();
    const position = this.doc.insertNote(barIndex, at, {
      is_rest: true, note_name: "", duration: this.writeDuration,
    });
    if (!position) return;
    this.setCaret({ barIndex, at: at + 1 });
  }

  /** Backspace in note input: remove what was just written. */
  backspaceInput() {
    const { barIndex, at } = this._caret();
    if (at <= 0) return;
    this.doc.deleteNotes([{ barIndex, noteIndex: at - 1 }]);
    this.setCaret({ barIndex, at: at - 1 });
  }

  /** Move the caret, stepping into the neighbouring bar at either end. */
  moveCaret(delta) {
    const bars = this.doc.doc.bars;
    let { barIndex, at } = this._caret();
    at += delta;
    if (at < 0) {
      if (barIndex === 0) { at = 0; }
      else { barIndex -= 1; at = bars[barIndex].events.length; }
    } else if (at > bars[barIndex].events.length) {
      if (barIndex >= bars.length - 1) { at = bars[barIndex].events.length; }
      else { barIndex += 1; at = 0; }
    }
    this.setCaret({ barIndex, at });
  }

  /** MuseScore's Shift+R: put another of the selected notes after them. */
  repeatSelection(positions) {
    const last = positions[positions.length - 1];
    const event = this.doc.event(last.barIndex, last.noteIndex);
    if (!event) return;
    const position = this.doc.insertNote(last.barIndex, last.noteIndex + 1, {
      note_name: event.note_name,
      duration: event.duration,
      is_rest: event.is_rest,
      volume: event.volume,
    });
    if (!position) return;
    this.selection = { notes: [position], bars: [] };
    this.renderAll();
    this.previewNote(position);
  }

  /**
   * Move notes by semitones, respelling each for the key.
   *
   * The diatonic `transpose` walks staff positions and keeps the accidental,
   * which is the right move inside a key.  This is the chromatic one: it
   * resolves the note to a pitch, moves it, and asks `midiToToken` how that
   * pitch is written here — so raising an F in G major gives F♯ rather than a
   * G that happens to sound right.
   */
  transposeSemitones(positions, semitones) {
    if (!positions.length || !semitones) return;
    const keySignature = this.doc.doc.key_signature;
    this.doc.updateNotes(positions, (event) => {
      if (event.is_rest) return {};
      const midi = noteMidi(event, keySignature);
      if (midi == null) return {};
      const token = midiToToken(midi + semitones, keySignature);
      return token ? { note_name: token.name } : {};
    }, semitones > 0 ? "raise note" : "lower note");
    if (positions.length === 1) this.previewNote(positions[0]);
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

  /**
   * Set the accidental outright, rather than cycling to it.
   *
   * Alt+↑/↓ walks a five-state ring, which is fine for exploring and poor for
   * doing: writing a sharp means knowing where in the ring you currently are
   * and how many steps away it is, and the note sounds on every step of the
   * way.  Wanting a sharp is by far the commonest thing a teacher wants here,
   * and it should cost one key.  `null` means "as the key signature has it".
   */
  setAccidental(positions, modifier) {
    this.doc.updateNotes(positions, (event) => {
      if (event.is_rest) return {};
      const parts = splitToken(event.note_name);
      return { note_name: buildToken(Object.assign(parts, { modifier })) };
    }, "accidental");
    if (positions.length === 1) this.previewNote(positions[0]);
  }


  /** Move where the selected noteheads are *drawn* — see `nudgeOffset` for
   *  the other one, which moves when they sound. */
  nudgeVisualOffset(positions, delta) {
    this.doc.updateNotes(positions, (event) => ({
      visual_offset_px: Math.max(-MAX_VISUAL_OFFSET_PX, Math.min(
        MAX_VISUAL_OFFSET_PX, (event.visual_offset_px || 0) + delta
      )),
    }), "visual offset");
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
        const offset = offsetMs(event);
        const start = Math.max(0, cursor + offset);
        let duration = event.duration || 0.125;
        if (!event.is_rest && duration < 0.0625) duration = 0.125;
        // Tuplets scale the sounding length and not the written one — the
        // same rule `practiceData.buildBarSteps` applies, so the teacher's
        // preview and the student's playback agree.
        const durationMs = Math.max(20, Math.round(duration * wholeMs * tupletRatio(event)));
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

      // MuseScore's pair: Ctrl+S saves, Ctrl+Shift+S saves as.  On a score
      // that has never been saved the two are the same act, so both create.
      if (modifier && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (e.shiftKey) this.saveAs(); else this.save();
        return;
      }
      if (typing) return;
      if (modifier && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) this.redo(); else this.undo();
        return;
      }
      // Ctrl/Cmd is the browser's and the OS's before it is ours, so it is
      // handed on by default — except for the few MuseScore bindings that use
      // it and that nothing else claims: an octave (Ctrl+↑/↓) and a bar
      // (Ctrl+←/→).
      const CLAIMED_WITH_MODIFIER = new Set([
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
      ]);
      if (modifier && !CLAIMED_WITH_MODIFIER.has(e.key)) return;
      if (!this.doc) return;

      const notes = this.selection.notes;
      const handled = this.handleKey(e, notes);
      if (handled) e.preventDefault();
    });
  }

  /**
   * MuseScore's duration keys.
   *
   * MuseScore numbers note values from the shortest up — 1 is a 64th, 4 an
   * eighth, 7 a whole — and anybody who writes music on a computer has that
   * in their fingers.  This editor previously numbered them the other way
   * round, from its own DURATIONS list, which is defensible and is not what
   * the hands expect.  1 is empty because this library has no 64ths: it is
   * left unbound rather than quietly remapped, so a finger landing there does
   * nothing instead of writing the wrong note value.
   */
  static DURATION_KEYS = {
    2: 0.03125, 3: 0.0625, 4: 0.125, 5: 0.25, 6: 0.5, 7: 1,
  };

  handleKey(e, notes) {
    const key = e.key;
    const modifier = e.metaKey || e.ctrlKey;

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

    // Durations.  In note input they set what the *next* note will be; with a
    // note selected they change it, which is the same key doing the same
    // thing to whatever the editor is currently pointing at.
    const duration = Editor.DURATION_KEYS[key];
    if (duration) {
      this.setWriteDuration(duration);
      if (notes.length) this.setDuration(notes, duration);
      return true;
    }

    if (key === "[" || key === "]" || ((key === "ArrowLeft" || key === "ArrowRight") && modifier)) {
      // Bar to bar.  Ctrl+←/→ is MuseScore's; the brackets were here first
      // and cost nothing to keep.  Tab is deliberately left alone: it is how
      // a keyboard user reaches the property panel, and taking it would trade
      // one convenience for the ability to use the editor at all.
      const bars = this.doc.doc.bars;
      const step = (key === "]" || key === "ArrowRight") ? 1 : -1;
      const next = (this.activeBar() + step + bars.length) % bars.length;
      this.setCaret({ barIndex: next, at: 0 }, { select: false });
      this.selectBar(next);
      return true;
    }
    // Backspace rubs out what was just written; Delete removes what is
    // selected.  The division a text editor draws, and with the caret and the
    // selection being one cursor it is the only one that stays unambiguous.
    if (key === "Backspace") {
      this.backspaceInput();
      return true;
    }
    if (key === "Delete") {
      this.deleteSelection();
      return true;
    }

    if (key === "ArrowLeft" || key === "ArrowRight") {
      const direction = key === "ArrowRight" ? 1 : -1;
      if (e.altKey) this.moveNoteBy(direction);
      else this.moveCaret(direction);
      return true;
    }

    if (key === "ArrowUp" || key === "ArrowDown") {
      if (!notes.length) return false;
      const direction = key === "ArrowUp" ? 1 : -1;
      // MuseScore's pitch keys: a bare arrow is a semitone and Ctrl is an
      // octave.  The diatonic step keeps a binding of its own because this
      // is a scale-degree curriculum and moving within the key is what most
      // of these edits are; MuseScore spells that Alt+Shift too.
      if (e.altKey && e.shiftKey) this.transpose(notes, direction);
      else if (e.altKey) this.cycleAccidental(notes, direction);
      else if (modifier) this.transposeSemitones(notes, direction * 12);
      else this.transposeSemitones(notes, direction);
      return true;
    }

    if (LETTER_KEYS.has(key.toLowerCase()) && !e.altKey) {
      const letter = key.toLowerCase();
      // A letter always writes.  Re-pitching an existing note is what the
      // Note buttons in the panel are for, and what the arrow keys do — a
      // letter key that sometimes wrote and sometimes overwrote, depending on
      // whether something happened to be selected, was the more surprising of
      // the two.
      this.writeNote(letter);
      return true;
    }

    // The accidental, said outright.  `b` is free as a shortcut because the
    // letter keys are the German ones (c d e f g a h) — and in German naming
    // `b` *is* the flat, so the key says what it does.
    if (key === "#") { this.pickAccidental("#"); return true; }
    if (key === "b") { this.pickAccidental("b"); return true; }
    if (key === "n") { this.pickAccidental(null); return true; }
    if (key === "0") {
      // MuseScore writes a rest with 0.  `r` still toggles one, which is the
      // question a teacher asks of a note that is already there.
      this.writeRest();
      return true;
    }
    if ((key === "r" || key === "R") && notes.length) {
      if (e.shiftKey) this.repeatSelection(notes);
      else this.toggleRest(notes);
      return true;
    }
    if ((key === "k" || key === "K") && notes.length) {
      this.toggleEnharmonic(notes);
      return true;
    }
    // `,` / `.` move the sound; Alt with them moves the picture.  Same pair of
    // keys because they are the same gesture — nudge this note left or right —
    // and the modifier says which of the two axes it acts on, the way Alt does
    // on the drag.
    if ((key === "," || key === "<") && notes.length) {
      if (e.altKey) this.nudgeVisualOffset(notes, e.shiftKey ? -8 : -2);
      else this.nudgeOffset(notes, e.shiftKey ? -5 : -1);
      return true;
    }
    if ((key === "." || key === ">") && notes.length) {
      if (e.altKey) this.nudgeVisualOffset(notes, e.shiftKey ? 8 : 2);
      else this.nudgeOffset(notes, e.shiftKey ? 5 : 1);
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
