/**
 * editor.js — the dictation editor: a score editor, MuseScore's way.
 *
 * The teacher writes a piece of music — any number of parts, chords, up to
 * four voices on a staff, ties and slurs, dynamics, repeats — and cuts it into
 * phrases, the units the dictation is played to students in.
 *
 * How it works, in one paragraph: the document is `score.js`'s, and every
 * edit is a function of `score.js` run inside `change()`, which keeps the
 * undo history and redraws.  The drawing is `layout.js`'s, and what the mouse
 * points at is answered from the layout it returns.  Note input — the mode
 * in which letters write notes — is a cursor (measure, staff, voice, tick)
 * that writing moves along, exactly as in MuseScore; outside it, letters and
 * arrows change what is selected.  The palettes, the toolbar and the side
 * panel are built in `ui.js` from the state kept here.
 */

import { AudioPlayer } from "../audioPlayer.js?v=177";
import * as S from "./score.js?v=177";
import {
  eventAt, measureAt, paintState, renderScore, stepAt, tickX,
} from "./layout.js?v=177";
import { schedule } from "./playback.js?v=177";
import { buildPalette, buildPanel, buildToolbar, openDialog } from "./ui.js?v=177";

const API = "/api/dictation-scores/";
const DURATION_KEYS = { 1: "64", 2: "32", 3: "16", 4: "8", 5: "q", 6: "h", 7: "w" };
const LETTERS = { a: "A", b: "B", c: "C", d: "D", e: "E", f: "F", g: "G", h: "B" };
/** The middle of each clef's range — where the first note's octave is guessed from. */
// (`score.pitchStep` units: octave * 7 + letter; B4 is 4 * 7 + 6.)
const CLEF_MIDDLE = { treble: 4 * 7 + 6, bass: 3 * 7 + 1, alto: 4 * 7, tenor: 3 * 7 + 5, treble8vb: 3 * 7 + 6 };

function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-CSRFToken": csrfToken(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail || Object.entries(data).map(([k, v]) => `${k}: ${[].concat(v).join(" ")}`).join("; ");
    throw new Error(detail || `The server said ${res.status}.`);
  }
  return data;
}

export class DictationEditor {
  constructor() {
    this.dom = {
      palette: document.getElementById("dz-palette"),
      toolbar: document.getElementById("dz-toolbar"),
      canvas: document.getElementById("dz-canvas"),
      panel: document.getElementById("dz-panel"),
      status: document.getElementById("dz-status"),
      title: document.getElementById("dz-title"),
      composer: document.getElementById("dz-composer"),
      saved: document.getElementById("dz-saved"),
      help: document.getElementById("dz-help"),
      helpToggle: document.getElementById("dz-help-toggle"),
    };
    this.player = new AudioPlayer();
    this.playing = false;
    this.playingId = null;
    this.tempoScale = 1;
    this.layout = null;
    this.clipboard = null;
    this.panelTab = "selection";
    this.undoStack = [];
    this.redoStack = [];
    this.selection = { ids: [], pitch: null, measures: null };
    this.input = { on: false, cursor: null, dur: "q", dots: 0, alter: null, voice: 0 };
    this.lastWritten = null;
    this.newDocument();
    this.bind();
  }

  // ---- the document -------------------------------------------------------

  newDocument(setup = {}) {
    this.doc = {
      id: null, title: "", composer: "", description: "", published: false,
      score: S.newScore(Object.assign({ instruments: ["piano"], measures: 8 }, setup)),
      phrases: [],
    };
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.selection = { ids: [], pitch: null, measures: null };
    this.input = Object.assign(this.input, { on: false, cursor: null, alter: null, voice: 0 });
    this.lastWritten = null;
  }

  async boot() {
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) {
      try { await this.open(id, { quiet: true }); }
      catch (e) { this.status(`Could not open that dictation — ${e.message}`, "bad"); }
    }
    this.renderAll();
    if (!id) this.status("A new dictation for piano. Press N to write notes, or choose instruments under Score.");
    new ResizeObserver(() => this.renderScoreView()).observe(this.dom.canvas);
    window.addEventListener("beforeunload", (e) => {
      if (!this.dirty) return;
      e.preventDefault();
      e.returnValue = "";
    });
  }

  async open(id, { quiet = false } = {}) {
    if (!quiet && !(await this.confirmDiscard())) return;
    const data = await request("GET", `${API}${id}/`);
    this.newDocument();
    this.doc = {
      id: data.id, title: data.title, composer: data.composer || "", description: data.description || "",
      published: !!data.published,
      score: S.normalise(data.score && data.score.measures ? data.score : S.newScore()),
      phrases: data.phrases || [],
    };
    this.dirty = false;
    window.history.replaceState(null, "", `?id=${data.id}`);
    this.renderAll();
    this.status(`Opened “${data.title}”.`);
  }

  payload() {
    return {
      title: (this.doc.title || "").trim() || "Untitled dictation",
      composer: this.doc.composer || "",
      description: this.doc.description || "",
      published: !!this.doc.published,
      score: this.doc.score,
      phrases: this.doc.phrases,
    };
  }

  async save() {
    try {
      const body = this.payload();
      const data = this.doc.id
        ? await request("PUT", `${API}${this.doc.id}/`, body)
        : await request("POST", API, body);
      this.doc.id = data.id;
      this.doc.title = data.title;
      this.dirty = false;
      window.history.replaceState(null, "", `?id=${data.id}`);
      this.renderAll();
      this.status(this.doc.published ? "Saved — students see the new version." : "Saved.", "good");
    } catch (e) {
      this.status(`Not saved — ${e.message}`, "bad");
    }
  }

  async remove() {
    if (!this.doc.id) { this.newDocument(); this.renderAll(); return; }
    const ok = await openDialog({
      title: "Delete this dictation?",
      body: "It is gone for good, for you and for any student practising it.",
      actions: [{ label: "Delete", value: true, danger: true }, { label: "Keep it", value: false }],
    });
    if (!ok) return;
    try {
      await request("DELETE", `${API}${this.doc.id}/`);
      this.newDocument();
      window.history.replaceState(null, "", window.location.pathname);
      this.renderAll();
      this.status("Deleted.");
    } catch (e) {
      this.status(`Not deleted — ${e.message}`, "bad");
    }
  }

  async confirmDiscard() {
    if (!this.dirty) return true;
    return openDialog({
      title: "Leave without saving?",
      body: "This dictation has changes that are not saved.",
      actions: [{ label: "Discard changes", value: true, danger: true }, { label: "Keep editing", value: false }],
    });
  }

  async chooseToOpen() {
    let list = [];
    try { list = await request("GET", `${API}?mine=1`); }
    catch (e) { this.status(`Could not list dictations — ${e.message}`, "bad"); return; }
    const id = await openDialog({
      title: "Open a dictation",
      body: list.length ? "" : "You have not written any dictations yet.",
      list: list.map((d) => ({
        value: d.id,
        label: d.title,
        detail: [d.composer, d.published ? "published" : "draft", `${d.phrase_count} phrase${d.phrase_count === 1 ? "" : "s"}`].filter(Boolean).join(" · "),
      })),
      actions: [{ label: "Cancel", value: null }],
    });
    if (id) await this.open(id);
  }

  async chooseNew() {
    if (!(await this.confirmDiscard())) return;
    const setup = await openDialog({
      title: "A new dictation",
      form: [
        {
          key: "instruments", label: "Instruments", type: "select", value: "piano",
          options: [
            { value: "piano", label: "Piano" },
            { value: "soprano,alto,tenor,bass", label: "Choir (SATB)" },
            { value: "violin,viola,cello", label: "String trio" },
            { value: "violin,cello", label: "Violin and cello" },
            { value: "soprano,piano", label: "Voice and piano" },
            { value: "treble", label: "Single treble staff" },
            { value: "bassStaff", label: "Single bass staff" },
          ],
        },
        { key: "time", label: "Time signature", type: "select", value: "4/4",
          options: ["2/4", "3/4", "4/4", "5/4", "6/8", "9/8", "12/8", "2/2", "3/8"].map((t) => ({ value: t, label: t })) },
        { key: "key", label: "Key", type: "select", value: "0",
          options: Array.from({ length: 15 }, (_, i) => i - 7).map((k) => ({ value: String(k), label: S.keyName(k) })) },
        { key: "measures", label: "Measures", type: "number", value: "8" },
        { key: "tempo", label: "Tempo (quarter = )", type: "number", value: "80" },
      ],
      actions: [{ label: "Create", value: "submit" }, { label: "Cancel", value: null }],
    });
    if (!setup) return;
    const [num, den] = setup.time.split("/").map(Number);
    this.newDocument({
      instruments: setup.instruments.split(","),
      time: [num, den],
      key: Number(setup.key),
      measures: Math.max(1, Math.min(400, Number(setup.measures) || 8)),
      tempo: Math.max(20, Math.min(300, Number(setup.tempo) || 80)),
    });
    window.history.replaceState(null, "", window.location.pathname);
    this.renderAll();
    this.status("A new dictation. Press N to write notes.");
  }

  // ---- history --------------------------------------------------------------

  snapshot() {
    return JSON.stringify({ score: this.doc.score, phrases: this.doc.phrases });
  }

  /** Make an edit: one step of history, a normalised score, a redraw. */
  change(label, fn) {
    const before = this.snapshot();
    const result = fn(this.doc.score);
    if (result === false) return false;
    S.normalise(this.doc.score);
    if (this.snapshot() === before) return false;
    this.undoStack.push({ label, state: before });
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    this.dirty = true;
    this.pruneSelection();
    this.renderAll();
    return true;
  }

  restore(state) {
    const parsed = JSON.parse(state);
    this.doc.score = parsed.score;
    this.doc.phrases = parsed.phrases;
    this.dirty = true;
    this.pruneSelection();
    this.renderAll();
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.redoStack.push({ label: entry.label, state: this.snapshot() });
    this.restore(entry.state);
    this.status(`Undid ${entry.label}.`);
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.undoStack.push({ label: entry.label, state: this.snapshot() });
    this.restore(entry.state);
    this.status(`Redid ${entry.label}.`);
  }

  // ---- selection ------------------------------------------------------------

  pruneSelection() {
    const score = this.doc.score;
    this.selection.ids = this.selection.ids.filter((id) => S.locate(score, id));
    if (this.selection.pitch && !S.locate(score, this.selection.pitch.id)) this.selection.pitch = null;
    if (this.selection.measures) {
      const last = score.measures.length - 1;
      this.selection.measures.from = Math.min(this.selection.measures.from, last);
      this.selection.measures.to = Math.min(this.selection.measures.to, last);
    }
    if (this.input.cursor && this.input.cursor.mi >= score.measures.length) {
      this.input.cursor = { mi: score.measures.length - 1, staffKey: this.input.cursor.staffKey, voice: this.input.cursor.voice, tick: 0 };
    }
  }

  /** The selected events, located, in the order they sound. */
  selectedEvents() {
    const score = this.doc.score;
    const starts = S.measureStarts(score);
    const order = S.staves(score).map((s) => s.key);
    return this.selection.ids
      .map((id) => S.locate(score, id))
      .filter(Boolean)
      .map((w) => Object.assign(w, { abs: starts[w.mi] + w.start, absEnd: starts[w.mi] + w.start + S.eventTicks(w.event) }))
      .sort((a, b) => a.abs - b.abs || order.indexOf(a.staffKey) - order.indexOf(b.staffKey) || a.voice - b.voice);
  }

  select(ids, pitch = null) {
    this.selection = { ids: ids.slice(), pitch, measures: null };
    this.panelTab = this.panelTab === "phrases" || this.panelTab === "score" ? this.panelTab : "selection";
    this.renderSelection();
  }

  selectMeasures(from, to, staffKey = null) {
    this.selection = { ids: [], pitch: null, measures: { from: Math.min(from, to), to: Math.max(from, to), staffKey } };
    this.renderSelection();
  }

  /** The measures an edit to measures applies to. */
  targetMeasures() {
    if (this.selection.measures) return { from: this.selection.measures.from, to: this.selection.measures.to, staffKey: this.selection.measures.staffKey };
    const events = this.selectedEvents();
    if (events.length) return { from: events[0].mi, to: events[events.length - 1].mi, staffKey: events[0].staffKey };
    if (this.input.cursor) return { from: this.input.cursor.mi, to: this.input.cursor.mi, staffKey: this.input.cursor.staffKey };
    return { from: 0, to: 0, staffKey: S.staves(this.doc.score)[0].key };
  }

  /** The ids an edit to notes applies to: the selection, or what was just written. */
  targetIds() {
    if (this.selection.ids.length) return this.selection.ids.slice();
    if (this.lastWritten && S.locate(this.doc.score, this.lastWritten)) return [this.lastWritten];
    return [];
  }

  /** Extend a selection to everything between it and `id` in one voice. */
  extendTo(id) {
    const anchor = this.selection.ids[0];
    const a = anchor && S.locate(this.doc.score, anchor);
    const b = S.locate(this.doc.score, id);
    if (!a || !b) { this.select([id]); return; }
    if (a.staffKey === b.staffKey && a.voice === b.voice) {
      const clip = S.copyRange(this.doc.score, anchor, id) || [];
      const ids = clip.map((e) => e.id);
      // The anchor stays first, so a second Shift+click extends from it.
      this.select([anchor].concat(ids.filter((x) => x !== anchor)));
    } else {
      this.select([anchor, id]);
    }
  }

  // ---- note input -----------------------------------------------------------

  startInput() {
    const score = this.doc.score;
    let cursor = null;
    const first = this.selectedEvents()[0];
    if (first) cursor = { mi: first.mi, staffKey: first.staffKey, voice: first.voice, tick: first.start };
    else if (this.selection.measures) {
      cursor = { mi: this.selection.measures.from, staffKey: this.selection.measures.staffKey || S.staves(score)[0].key, voice: this.input.voice, tick: 0 };
    } else cursor = this.input.cursor || { mi: 0, staffKey: S.staves(score)[0].key, voice: this.input.voice, tick: 0 };
    this.input.on = true;
    this.input.cursor = cursor;
    this.input.voice = cursor.voice;
    this.renderAll();
    this.status("Note input: type A–G to write, 1–7 for the value, N or Esc to stop.");
  }

  stopInput() {
    this.input.on = false;
    this.renderAll();
    this.status("Note input off.");
  }

  /** The cursor moved on by `ticks`, into the next measure (made if needed). */
  advance(ticks) {
    const score = this.doc.score;
    const c = this.input.cursor;
    let { mi, tick } = c;
    tick += ticks;
    while (tick >= S.measureTicks(score, mi)) {
      tick -= S.measureTicks(score, mi);
      mi += 1;
      if (mi >= score.measures.length) {
        // Writing off the end of the score adds a measure, as MuseScore does.
        score.measures.push({ staves: {} });
        S.normalise(score);
      }
    }
    this.input.cursor = { mi, staffKey: c.staffKey, voice: c.voice, tick };
  }

  /** The pitch before the cursor in its voice, to pick the next octave from. */
  previousPitch(cursor) {
    const score = this.doc.score;
    for (let mi = cursor.mi; mi >= 0; mi -= 1) {
      const staff = score.measures[mi].staves[cursor.staffKey];
      const events = (staff && staff.voices[cursor.voice]) || [];
      const timed = S.timed(events).filter((t) => mi < cursor.mi || t.start < cursor.tick);
      for (let i = timed.length - 1; i >= 0; i -= 1) {
        const e = timed[i].event;
        if (!e.rest) return e.pitches[e.pitches.length - 1];
      }
    }
    return null;
  }

  /** `step` in the octave nearest `near` (a pitch), or the clef's middle. */
  nearestPitch(step, near, staffKey, mi) {
    const score = this.doc.score;
    const target = near ? S.pitchStep(near) : (CLEF_MIDDLE[S.clefAt(score, staffKey, mi)] || CLEF_MIDDLE.treble);
    const index = S.STEPS.indexOf(step);
    let best = null;
    for (let octave = 0; octave <= 9; octave += 1) {
      const candidate = octave * 7 + index;
      if (!best || Math.abs(candidate - target) < Math.abs(best - target)) best = candidate;
    }
    const pitch = S.pitchFromStep(best);
    const alter = S.keyAlterations(S.keyAt(score, mi))[step] || 0;
    return { step: pitch.step, octave: pitch.octave, alter, tie: false };
  }

  writeLetter(step) {
    const c = this.input.cursor;
    if (!c) return;
    const pitch = this.nearestPitch(step, this.previousPitch(c), c.staffKey, c.mi);
    if (this.input.alter != null) pitch.alter = this.input.alter;
    this.writeAtCursor({ pitches: [pitch] });
    this.input.alter = null;
  }

  writeAtCursor({ pitches = null } = {}) {
    const c = Object.assign({}, this.input.cursor);
    let written = null;
    this.change(pitches ? "write note" : "write rest", (score) => {
      written = S.writeNote(score, c, { pitches, dur: this.input.dur, dots: this.input.dots });
      this.input.cursor = c;
      this.advance(S.eventTicks({ dur: this.input.dur, dots: this.input.dots }));
    });
    this.lastWritten = written;
    this.selection = { ids: written ? [written] : [], pitch: null, measures: null };
    this.renderSelection();
    if (pitches) this.preview(pitches);
  }

  /** In note input, '+': a note tied from the last one, at the current value. */
  tiedNote() {
    const last = this.lastWritten && S.locate(this.doc.score, this.lastWritten);
    if (!last || last.event.rest) { this.status("Write a note first, then + ties a note to it.", "warn"); return; }
    const pitches = last.event.pitches.map((p) => Object.assign({}, p, { tie: false }));
    this.change("tie", (score) => {
      S.locate(score, this.lastWritten).event.pitches.forEach((p) => { p.tie = true; });
    });
    this.writeAtCursor({ pitches });
  }

  backspace() {
    const last = this.lastWritten && S.locate(this.doc.score, this.lastWritten);
    if (!last) return;
    this.change("rub out", (score) => S.eraseEvent(score, last.event.id));
    this.input.cursor = { mi: last.mi, staffKey: last.staffKey, voice: last.voice, tick: last.start };
    this.lastWritten = null;
    this.renderAll();
  }

  moveCursor(direction, byMeasure = false) {
    const score = this.doc.score;
    const c = this.input.cursor;
    if (!c) return;
    if (byMeasure) {
      const mi = Math.max(0, Math.min(score.measures.length - 1, c.mi + direction));
      this.input.cursor = Object.assign({}, c, { mi, tick: 0 });
    } else {
      const events = S.timed(S.voicesOf(score, c.mi, c.staffKey)[c.voice] || []);
      const here = events.findIndex((t) => t.start >= c.tick);
      if (direction > 0) {
        const t = events.find((x) => x.start > c.tick);
        if (t) this.input.cursor = Object.assign({}, c, { tick: t.start });
        else if (c.mi + 1 < score.measures.length) this.input.cursor = Object.assign({}, c, { mi: c.mi + 1, tick: 0 });
      } else {
        const before = events.filter((x) => x.start < c.tick).pop();
        if (before) this.input.cursor = Object.assign({}, c, { tick: before.start });
        else if (c.mi > 0) {
          const prev = S.timed(S.voicesOf(score, c.mi - 1, c.staffKey)[c.voice] || []);
          this.input.cursor = Object.assign({}, c, { mi: c.mi - 1, tick: prev.length ? prev[prev.length - 1].start : 0 });
        }
      }
      void here;
    }
    this.renderScoreView();
  }

  // ---- commands on notes ------------------------------------------------------

  setDuration(dur) {
    this.input.dur = dur;
    this.input.dots = 0;
    const ids = this.selection.ids;
    if (ids.length && !this.input.on) {
      const ordered = this.selectedEvents();
      let first = null;
      this.change("note value", (score) => {
        ordered.forEach((w) => {
          if (!S.locate(score, w.event.id)) return;
          const id = S.setDuration(score, w.event.id, dur, 0);
          if (!first) first = id;
        });
      });
      if (first) this.select([first]);
    }
    this.renderAll();
  }

  toggleDot() {
    this.input.dots = (this.input.dots + 1) % 3;
    if (this.selection.ids.length && !this.input.on) {
      const ordered = this.selectedEvents();
      let first = null;
      this.change("dot", (score) => {
        ordered.forEach((w) => {
          const where = S.locate(score, w.event.id);
          if (!where) return;
          const id = S.setDuration(score, w.event.id, where.event.dur, ((where.event.dots || 0) + 1) % 3);
          if (!first) first = id;
        });
      });
      if (first) this.select([first]);
    }
    this.renderAll();
  }

  /** An accidental: on the selection, or armed for the next note written. */
  setAccidental(alter) {
    const ids = this.targetIds();
    if (this.input.on && !this.selection.ids.length) {
      this.input.alter = this.input.alter === alter ? null : alter;
      this.renderAll();
      return;
    }
    if (!ids.length) { this.input.alter = alter; this.renderAll(); return; }
    const pitch = this.selection.pitch;
    this.change("accidental", (score) => {
      ids.forEach((id) => {
        const where = S.locate(score, id);
        if (!where || where.event.rest) return;
        where.event.pitches.forEach((p, i) => {
          if (pitch && pitch.id === id && pitch.index !== i) return;
          p.alter = alter;
        });
      });
    });
  }

  transpose(semitones) {
    const ids = this.targetIds();
    if (!ids.length) return;
    const pitch = this.selection.pitch;
    this.change("transpose", (score) => {
      ids.forEach((id) => {
        const where = S.locate(score, id);
        if (!where || where.event.rest) return;
        const fifths = S.keyAt(score, where.mi);
        where.event.pitches = S.sortPitches(where.event.pitches.map((p, i) => (
          (pitch && pitch.id === id && pitch.index !== i) ? p
            : Object.assign(S.transposePitch(p, semitones, fifths), { tie: p.tie })
        )));
      });
    });
    const first = S.locate(this.doc.score, ids[0]);
    if (first && !first.event.rest) this.preview(first.event.pitches);
  }

  diatonic(steps) {
    const ids = this.targetIds();
    if (!ids.length) return;
    this.change("move a step", (score) => {
      ids.forEach((id) => {
        const where = S.locate(score, id);
        if (!where || where.event.rest) return;
        const key = S.keyAlterations(S.keyAt(score, where.mi));
        where.event.pitches = S.sortPitches(where.event.pitches.map((p) => {
          const next = S.pitchFromStep(S.pitchStep(p) + steps);
          return Object.assign(next, { alter: key[next.step] || 0, tie: p.tie });
        }));
      });
    });
  }

  /** A letter outside note input re-pitches the selected note. */
  repitch(step) {
    const ids = this.selection.ids;
    if (ids.length !== 1) return;
    const where = S.locate(this.doc.score, ids[0]);
    if (!where) return;
    this.change("re-pitch", (score) => {
      const w = S.locate(score, ids[0]);
      const near = w.event.rest ? this.previousPitch({ mi: w.mi, staffKey: w.staffKey, voice: w.voice, tick: w.start }) : w.event.pitches[w.event.pitches.length - 1];
      const pitch = this.nearestPitch(step, near, w.staffKey, w.mi);
      w.event.rest = false;
      w.event.pitches = [pitch];
    });
    const after = S.locate(this.doc.score, ids[0]);
    if (after) this.preview(after.event.pitches);
  }

  /** Add a note to the chord: a letter above the top, or an interval. */
  addToChord({ step = null, interval = null }) {
    const id = this.targetIds()[0];
    const where = id && S.locate(this.doc.score, id);
    if (!where) { this.status("Select a note (or write one) to build the chord on.", "warn"); return; }
    if (where.event.rest) { this.status("A rest cannot carry a chord.", "warn"); return; }
    const top = where.event.pitches[where.event.pitches.length - 1];
    const key = S.keyAlterations(S.keyAt(this.doc.score, where.mi));
    let index;
    if (interval) index = S.pitchStep(top) + interval - 1;
    else {
      index = Math.floor(S.pitchStep(top) / 7) * 7 + S.STEPS.indexOf(step);
      if (index <= S.pitchStep(top)) index += 7;
    }
    const pitch = S.pitchFromStep(index, 0);
    pitch.alter = (step && this.input.alter != null) ? this.input.alter : (key[pitch.step] || 0);
    this.change("add to chord", (score) => S.addPitch(score, id, pitch));
    this.input.alter = null;
    const after = S.locate(this.doc.score, id);
    if (after) this.preview(after.event.pitches);
  }

  erase() {
    const pitch = this.selection.pitch;
    if (pitch) {
      const where = S.locate(this.doc.score, pitch.id);
      if (where && where.event.pitches.length > 1) {
        this.change("remove note from chord", (score) => S.removePitch(score, pitch.id, pitch.index));
        this.selection.pitch = null;
        this.renderSelection();
        return;
      }
    }
    const ids = this.selection.ids.slice();
    if (!ids.length) return;
    this.change("delete", (score) => ids.forEach((id) => S.eraseEvent(score, id)));
  }

  toggleTie() {
    const ids = this.targetIds();
    if (!ids.length) return;
    this.change("tie", (score) => S.toggleTie(score, ids));
  }

  setVoice(voice) {
    this.input.voice = voice;
    if (this.input.on && this.input.cursor) {
      this.input.cursor = Object.assign({}, this.input.cursor, { voice });
      this.renderAll();
      this.status(`Writing in voice ${voice + 1}.`);
      return;
    }
    const ordered = this.selectedEvents().filter((w) => !w.event.rest);
    if (!ordered.length) { this.renderAll(); return; }
    // Moving notes to another voice is writing them there and leaving rests
    // behind, which is what MuseScore does too.
    const ids = [];
    this.change(`voice ${voice + 1}`, (score) => {
      ordered.forEach((w) => {
        if (w.voice === voice) return;
        const event = S.clone(w.event);
        S.eraseEvent(score, w.event.id);
        event.id = S.newId();
        ids.push(S.writeEvent(score, { mi: w.mi, staffKey: w.staffKey, voice, tick: w.start }, event));
      });
    });
    if (ids.length) this.select(ids);
  }

  tuplet(num, den) {
    const id = this.targetIds()[0];
    if (!id) { this.status("Select the note to divide into a tuplet.", "warn"); return; }
    const ok = this.change(`${num}-tuplet`, (score) => S.makeTuplet(score, id, num, den));
    if (ok === false) this.status("That note is too short to divide that way.", "warn");
  }

  articulation(name) {
    const ids = this.targetIds();
    if (!ids.length) return;
    this.change(name, (score) => S.toggleArticulation(score, ids, name));
  }

  dynamic(dyn) {
    const first = this.selectedEvents()[0] || (this.lastWritten && S.locate(this.doc.score, this.lastWritten));
    if (!first) { this.status("Select the note the dynamic belongs under.", "warn"); return; }
    const on = first.event.dyn === dyn ? null : dyn;
    this.change("dynamic", (score) => S.setEventProps(score, [first.event.id], { dyn: on }));
  }

  /** Hairpin or slur over the selection, from its first note to its last. */
  span(kind) {
    const events = this.selectedEvents().filter((w) => kind === "slur" ? !w.event.rest : true);
    if (events.length < 2) { this.status("Select the first and the last note it spans (Shift+click).", "warn"); return; }
    const first = events[0];
    const last = events[events.length - 1];
    this.change(kind === "slur" ? "slur" : "hairpin", (score) => {
      if (kind === "slur") {
        const on = !(first.event.slur && last.event.slurEnd);
        S.setEventProps(score, [first.event.id], { slur: on });
        S.setEventProps(score, [last.event.id], { slurEnd: on });
      } else {
        const on = first.event.hairpin !== kind;
        S.setEventProps(score, [first.event.id], { hairpin: on ? kind : null });
        S.setEventProps(score, [last.event.id], { hairpinEnd: on });
      }
    });
  }

  copy() {
    const events = this.selectedEvents();
    if (!events.length) return;
    const clip = S.copyRange(this.doc.score, events[0].event.id, events[events.length - 1].event.id);
    if (!clip) { this.status("Copy a run of notes in one voice of one staff.", "warn"); return; }
    this.clipboard = clip;
    this.status(`Copied ${clip.length} note${clip.length === 1 ? "" : "s"}.`);
  }

  paste() {
    if (!this.clipboard) return;
    const first = this.selectedEvents()[0];
    const cursor = first
      ? { mi: first.mi, staffKey: first.staffKey, voice: first.voice, tick: first.start }
      : this.input.cursor;
    if (!cursor) { this.status("Select where to paste.", "warn"); return; }
    let id = null;
    this.change("paste", (score) => { id = S.pasteClip(score, cursor, this.clipboard); });
    if (id) this.select([id]);
  }

  // ---- commands on measures and parts ------------------------------------------

  measureProps(label, props) {
    const { from, to } = this.targetMeasures();
    this.change(label, (score) => S.setMeasureProps(score, from, to, props));
  }

  setClef(clef) {
    const { from, staffKey } = this.targetMeasures();
    const key = staffKey || S.staves(this.doc.score)[0].key;
    this.change("clef", (score) => {
      if (from === 0) {
        const [partId, index] = key.split(":");
        const part = score.parts.find((p) => p.id === partId);
        if (part) part.staves[Number(index)].clef = clef;
        if (score.measures[0].staves[key]) delete score.measures[0].staves[key].clef;
      } else {
        S.voicesOf(score, from, key);
        score.measures[from].staves[key].clef = clef;
      }
    });
  }

  setKey(fifths) {
    const { from } = this.targetMeasures();
    this.change("key signature", (score) => { score.measures[from].key = fifths; });
  }

  setTime(time) {
    const { from } = this.targetMeasures();
    this.change("time signature", (score) => { score.measures[from].time = time; });
  }

  setTempo(bpm) {
    const { from } = this.targetMeasures();
    this.change("tempo", (score) => {
      if (from === 0) { score.tempo = bpm; delete score.measures[0].tempo; }
      else if (bpm) score.measures[from].tempo = bpm;
      else delete score.measures[from].tempo;
    });
  }

  addMeasures(count = 1) {
    this.change("add measures", (score) => S.insertMeasures(score, score.measures.length, count));
    this.status(`Added ${count} measure${count === 1 ? "" : "s"}.`);
  }

  insertMeasure() {
    const { from } = this.targetMeasures();
    this.change("insert measure", (score) => S.insertMeasures(score, from, 1));
  }

  deleteMeasures() {
    const { from, to } = this.targetMeasures();
    const ok = this.change("delete measures", (score) => S.deleteMeasures(score, from, to));
    if (ok === false) this.status("A score keeps at least one measure.", "warn");
    else this.selection = { ids: [], pitch: null, measures: null };
    this.renderAll();
  }

  addPart(instrument) {
    this.change("add instrument", (score) => S.addPart(score, instrument));
  }

  removePart(partId) {
    const ok = this.change("remove instrument", (score) => S.removePart(score, partId));
    if (ok === false) this.status("A score keeps at least one instrument.", "warn");
  }

  movePart(partId, delta) {
    this.change("move instrument", (score) => S.movePart(score, partId, delta));
  }

  renamePart(partId, name) {
    this.change("rename instrument", (score) => {
      const part = score.parts.find((p) => p.id === partId);
      if (part) part.name = name;
    });
  }

  // ---- phrases ------------------------------------------------------------------

  newPhrase() {
    const events = this.selectedEvents();
    if (!events.length) {
      this.status("Select the first and the last note of the phrase (click, then Shift+click).", "warn");
      return;
    }
    const first = events[0];
    const last = events.reduce((a, b) => (b.absEnd > a.absEnd ? b : a), events[0]);
    const number = this.doc.phrases.length + 1;
    const phrase = { id: S.newId("ph"), name: `Phrase ${number}`, start: first.event.id, end: last.event.id };
    const before = this.snapshot();
    this.doc.phrases.push(phrase);
    this.sortPhrases();
    this.undoStack.push({ label: "new phrase", state: before });
    this.redoStack = [];
    this.dirty = true;
    this.panelTab = "phrases";
    this.selectedPhrase = phrase.id;
    this.renderAll();
    this.status(`${phrase.name}: measures ${first.mi + 1}–${last.mi + 1}.`, "good");
  }

  /** Phrases in the order they come in the score. */
  sortPhrases() {
    const score = this.doc.score;
    this.doc.phrases.sort((a, b) => {
      const sa = S.phraseSpan(score, a);
      const sb = S.phraseSpan(score, b);
      return (sa ? sa.from : Infinity) - (sb ? sb.from : Infinity);
    });
  }

  updatePhrase(id, props, label = "edit phrase") {
    const phrase = this.doc.phrases.find((p) => p.id === id);
    if (!phrase) return;
    const before = this.snapshot();
    Object.assign(phrase, props);
    this.undoStack.push({ label, state: before });
    this.redoStack = [];
    this.dirty = true;
    this.renderAll();
  }

  deletePhrase(id) {
    const before = this.snapshot();
    this.doc.phrases = this.doc.phrases.filter((p) => p.id !== id);
    this.undoStack.push({ label: "delete phrase", state: before });
    this.redoStack = [];
    this.dirty = true;
    this.renderAll();
  }

  /** Cut the score into phrases of `size` measures each (replacing none). */
  phrasesEvery(size) {
    const score = this.doc.score;
    const firstKey = S.staves(score)[0].key;
    const before = this.snapshot();
    let added = 0;
    for (let from = 0; from < score.measures.length; from += size) {
      const to = Math.min(score.measures.length - 1, from + size - 1);
      const a = score.measures[from].staves[firstKey].voices[0][0];
      const lastEvents = score.measures[to].staves[firstKey].voices[0];
      const b = lastEvents[lastEvents.length - 1];
      if (!a || !b) continue;
      this.doc.phrases.push({ id: S.newId("ph"), name: `Measures ${from + 1}–${to + 1}`, start: a.id, end: b.id });
      added += 1;
    }
    this.sortPhrases();
    this.undoStack.push({ label: "phrases", state: before });
    this.redoStack = [];
    this.dirty = true;
    this.renderAll();
    this.status(`Added ${added} phrase${added === 1 ? "" : "s"}.`, "good");
  }

  selectPhrase(id) {
    const phrase = this.doc.phrases.find((p) => p.id === id);
    if (!phrase) return;
    this.selectedPhrase = id;
    const ids = [phrase.start, phrase.end].filter((x) => S.locate(this.doc.score, x));
    this.selection = { ids, pitch: null, measures: null };
    this.renderAll();
  }

  playPhrase(id) {
    const phrase = this.doc.phrases.find((p) => p.id === id);
    const span = phrase && S.phraseSpan(this.doc.score, phrase);
    if (!span) { this.status("That phrase's first or last note has been deleted.", "warn"); return; }
    this.selectedPhrase = id;
    this.play({ span });
  }

  // ---- playback -------------------------------------------------------------------

  play({ span = null, fromMeasure = null } = {}) {
    if (this.playing) { this.stop(); return; }
    const start = fromMeasure != null ? fromMeasure
      : (this.selectedEvents()[0] ? this.selectedEvents()[0].mi : (this.selection.measures ? this.selection.measures.from : 0));
    const { steps } = schedule(this.doc.score, { span, tempoScale: this.tempoScale, fromMeasure: span ? 0 : start });
    if (!steps.length) { this.status("Nothing to play — there are no notes there yet.", "warn"); return; }
    const ok = this.player.play(steps, {
      onStep: (i) => {
        if (i < 0) {
          this.playing = false;
          this.playingId = null;
          paintState(this.layout, this.stateForPaint());
          this.renderToolbar();
          return;
        }
        this.playingId = steps[i] && steps[i].eventId;
        paintState(this.layout, this.stateForPaint());
      },
    });
    if (!ok) { this.status("Audio is not available in this browser.", "bad"); return; }
    this.playing = true;
    this.renderToolbar();
  }

  stop() {
    this.player.stop();
    this.playing = false;
    this.playingId = null;
    this.renderToolbar();
    paintState(this.layout, this.stateForPaint());
  }

  /** The pitches of a note, sounded briefly — the feedback for writing one. */
  preview(pitches) {
    if (this.playing || !pitches || !pitches.length) return;
    const steps = pitches.map((p) => ({ midi: S.pitchMidi(p), startMs: 0, durationMs: 420, volume: 80, isRest: false }));
    this.player.play(steps);
  }

  // ---- drawing --------------------------------------------------------------------

  stateForPaint() {
    return {
      selected: new Set(this.selection.ids),
      playing: this.playingId,
      selectedPitch: this.selection.pitch,
    };
  }

  renderAll() {
    this.dom.title.value = this.doc.title || "";
    this.dom.composer.value = this.doc.composer || "";
    this.dom.saved.textContent = this.dirty ? "Unsaved changes" : (this.doc.id ? "Saved" : "Not saved yet");
    this.dom.saved.classList.toggle("is-dirty", this.dirty);
    this.renderScoreView();
    this.renderToolbar();
    buildPalette(this.dom.palette, this);
    buildPanel(this.dom.panel, this);
  }

  /** A selection changed: repaint and rebuild the panels, no relayout. */
  renderSelection() {
    paintState(this.layout, this.stateForPaint());
    this.drawOverlays();
    this.renderToolbar();
    buildPalette(this.dom.palette, this);
    buildPanel(this.dom.panel, this);
  }

  renderToolbar() {
    buildToolbar(this.dom.toolbar, this);
  }

  renderScoreView() {
    const width = Math.max(480, this.dom.canvas.clientWidth - 8);
    const phrases = this.doc.phrases.map((p, i) => Object.assign({ number: i + 1, selected: p.id === this.selectedPhrase }, p));
    this.layout = renderScore(this.dom.canvas, this.doc.score, Object.assign({ width, phrases }, this.stateForPaint()));
    this.drawOverlays();
  }

  /** The note-input cursor and the selected measures, over the drawing. */
  drawOverlays() {
    const layout = this.layout;
    if (!layout) return;
    layout.svg.querySelectorAll(".dz-cursor, .dz-measure-sel").forEach((n) => n.remove());
    const ns = "http://www.w3.org/2000/svg";
    const sel = this.selection.measures;
    if (sel) {
      layout.measures.forEach((m) => {
        if (m.mi < sel.from || m.mi > sel.to) return;
        if (sel.staffKey && m.staffKey !== sel.staffKey) return;
        const rect = document.createElementNS(ns, "rect");
        rect.setAttribute("x", m.x + 1);
        rect.setAttribute("y", m.top - 6);
        rect.setAttribute("width", m.width - 2);
        rect.setAttribute("height", m.bottom - m.top + 12);
        rect.setAttribute("rx", 4);
        rect.setAttribute("class", "dz-measure-sel");
        layout.svg.insertBefore(rect, layout.svg.firstChild);
      });
    }
    if (this.input.on && this.input.cursor) {
      const c = this.input.cursor;
      const info = layout.measures.find((m) => m.mi === c.mi && m.staffKey === c.staffKey);
      const x = tickX(layout, this.doc.score, c);
      if (info && x != null) {
        const rect = document.createElementNS(ns, "rect");
        rect.setAttribute("x", x - 3);
        rect.setAttribute("y", info.top - 12);
        rect.setAttribute("width", 18);
        rect.setAttribute("height", info.bottom - info.top + 24);
        rect.setAttribute("rx", 3);
        rect.setAttribute("class", `dz-cursor dz-cursor-v${c.voice + 1}`);
        layout.svg.appendChild(rect);
      }
    }
  }

  status(message, tone = "") {
    this.dom.status.textContent = message;
    this.dom.status.dataset.tone = tone;
  }

  // ---- mouse and keyboard -------------------------------------------------------------

  svgPoint(e) {
    const svg = this.layout && this.layout.svg;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  bind() {
    const canvas = this.dom.canvas;
    canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const p = this.svgPoint(e);
      if (!p) return;
      canvas.focus({ preventScroll: true });
      const phraseEl = e.target.closest && e.target.closest("[data-phrase]");
      if (phraseEl) { this.panelTab = "phrases"; this.selectPhrase(phraseEl.dataset.phrase); return; }
      const hit = eventAt(this.layout, p.x, p.y);
      const measure = measureAt(this.layout, p.x, p.y);
      if (this.input.on && measure) {
        // In note input a click on the staff writes there, at the pitch
        // under the pointer, at the nearest written position.
        if (!hit || hit.entry.event.rest) {
          const tick = this.nearestTick(measure, p.x);
          this.input.cursor = { mi: measure.mi, staffKey: measure.staffKey, voice: this.input.voice, tick };
          const step = stepAt(measure, p.y);
          const pitch = S.pitchFromStep(step);
          pitch.alter = this.input.alter != null ? this.input.alter : (S.keyAlterations(S.keyAt(this.doc.score, measure.mi))[pitch.step] || 0);
          pitch.tie = false;
          this.writeAtCursor({ pitches: [pitch] });
          this.input.alter = null;
          return;
        }
      }
      if (hit) {
        if (e.shiftKey && this.selection.ids.length) this.extendTo(hit.id);
        else if (e.metaKey || e.ctrlKey) {
          const ids = this.selection.ids.includes(hit.id)
            ? this.selection.ids.filter((x) => x !== hit.id)
            : this.selection.ids.concat([hit.id]);
          this.select(ids);
        } else {
          this.select([hit.id], hit.pitchIndex != null && hit.entry.event.pitches.length > 1 ? { id: hit.id, index: hit.pitchIndex } : null);
          if (!hit.entry.event.rest) this.preview(hit.pitchIndex != null && hit.entry.event.pitches.length > 1
            ? [hit.entry.event.pitches[hit.pitchIndex]] : hit.entry.event.pitches);
        }
        if (this.input.on) {
          const w = S.locate(this.doc.score, hit.id);
          if (w) this.input.cursor = { mi: w.mi, staffKey: w.staffKey, voice: w.voice, tick: w.start };
          this.drawOverlays();
        }
        return;
      }
      if (measure) {
        if (e.shiftKey && this.selection.measures) this.selectMeasures(this.selection.measures.from, measure.mi, null);
        else this.selectMeasures(measure.mi, measure.mi, measure.staffKey);
        return;
      }
      this.select([]);
    });
    canvas.addEventListener("dblclick", (e) => {
      const p = this.svgPoint(e);
      const measure = p && measureAt(this.layout, p.x, p.y);
      if (!measure || this.input.on) return;
      this.input.cursor = { mi: measure.mi, staffKey: measure.staffKey, voice: this.input.voice, tick: this.nearestTick(measure, p.x) };
      this.input.on = true;
      this.renderAll();
      this.status("Note input: type A–G, or click on the staff to write.");
    });

    this.dom.title.addEventListener("input", () => { this.doc.title = this.dom.title.value; this.dirty = true; this.dom.saved.textContent = "Unsaved changes"; });
    this.dom.composer.addEventListener("input", () => { this.doc.composer = this.dom.composer.value; this.dirty = true; this.dom.saved.textContent = "Unsaved changes"; });
    this.dom.helpToggle.addEventListener("click", () => { this.dom.help.hidden = !this.dom.help.hidden; });

    document.addEventListener("keydown", (e) => this.onKey(e));
  }

  /** The written position in a measure nearest an x, in the input voice. */
  nearestTick(measure, x) {
    const score = this.doc.score;
    const voice = this.input.voice;
    let events = S.voicesOf(score, measure.mi, measure.staffKey)[voice];
    if (!events.length) events = S.voicesOf(score, measure.mi, measure.staffKey)[0];
    let best = 0;
    let bestDistance = Infinity;
    S.timed(events).forEach((t) => {
      const entry = this.layout.events.get(t.event.id);
      if (!entry) return;
      const d = Math.abs(entry.x - x);
      if (d < bestDistance) { bestDistance = d; best = t.start; }
    });
    return best;
  }

  onKey(e) {
    const target = e.target;
    const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key;
    if (mod && key.toLowerCase() === "s") { e.preventDefault(); this.save(); return; }
    if (typing) return;
    if (document.querySelector(".ed-ask-scrim")) return;

    const handled = this.handleKey(e, key, mod);
    if (handled) e.preventDefault();
  }

  handleKey(e, key, mod) {
    const digit = /^Digit([0-9])$/.exec(e.code || "");
    if (mod && key.toLowerCase() === "z") { if (e.shiftKey) this.redo(); else this.undo(); return true; }
    if (mod && key.toLowerCase() === "y") { this.redo(); return true; }
    if (mod && key.toLowerCase() === "c") { this.copy(); return true; }
    if (mod && key.toLowerCase() === "v") { this.paste(); return true; }
    if (mod && key.toLowerCase() === "b") { this.addMeasures(1); return true; }
    if (mod && e.altKey && digit && Number(digit[1]) >= 1 && Number(digit[1]) <= 4) { this.setVoice(Number(digit[1]) - 1); return true; }
    if (mod && (key === "Delete" || key === "Backspace")) { this.deleteMeasures(); return true; }
    if (mod && (key === "ArrowUp" || key === "ArrowDown")) { this.transpose(key === "ArrowUp" ? 12 : -12); return true; }
    if (mod && (key === "ArrowLeft" || key === "ArrowRight")) {
      const dir = key === "ArrowRight" ? 1 : -1;
      if (this.input.on) this.moveCursor(dir, true);
      else this.selectNeighbour(dir, true);
      return true;
    }
    if (mod) return false;

    if (key === "?") { this.dom.help.hidden = !this.dom.help.hidden; return true; }
    if (key === " ") { this.play(); return true; }
    if (key === "Escape") {
      if (this.input.on) this.stopInput();
      else { this.selection = { ids: [], pitch: null, measures: null }; this.renderSelection(); }
      return true;
    }
    if (key === "n" || key === "N") { if (this.input.on) this.stopInput(); else this.startInput(); return true; }
    if (key === "Insert") { this.insertMeasure(); return true; }
    if (digit && e.altKey && !e.shiftKey && Number(digit[1]) >= 2) { this.addToChord({ interval: Number(digit[1]) }); return true; }
    if (DURATION_KEYS[key] && !e.altKey) { this.setDuration(DURATION_KEYS[key]); return true; }
    if (key === ".") { this.toggleDot(); return true; }
    if (key === "0") {
      if (this.input.on) this.writeAtCursor({ pitches: null });
      else this.erase();
      return true;
    }
    if (key === "+") {
      if (this.input.on) this.tiedNote(); else this.toggleTie();
      return true;
    }
    if (key === "Delete") { this.erase(); return true; }
    if (key === "Backspace") { if (this.input.on) this.backspace(); else this.erase(); return true; }
    if (key === "ArrowUp" || key === "ArrowDown") {
      const dir = key === "ArrowUp" ? 1 : -1;
      if (e.altKey && e.shiftKey) this.diatonic(dir);
      else this.transpose(dir);
      return true;
    }
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const dir = key === "ArrowRight" ? 1 : -1;
      if (this.input.on) this.moveCursor(dir);
      else this.selectNeighbour(dir);
      return true;
    }
    if (key === "<") { this.span("<"); return true; }
    if (key === ">") { this.span(">"); return true; }
    const lower = key.toLowerCase();
    if ((lower === "s") && !e.shiftKey && !this.input.on) { this.span("slur"); return true; }
    if (LETTERS[lower] && !e.altKey) {
      const step = LETTERS[lower];
      if (e.shiftKey) { this.addToChord({ step }); return true; }
      if (this.input.on) this.writeLetter(step);
      else if (this.selection.ids.length === 1) this.repitch(step);
      else { this.startInput(); this.writeLetter(step); }
      return true;
    }
    if (key === "#") { this.setAccidental(1); return true; }
    return false;
  }

  /** Select the next or previous event in the selected note's voice. */
  selectNeighbour(direction, byMeasure = false) {
    const score = this.doc.score;
    const current = this.selectedEvents()[direction > 0 ? this.selection.ids.length - 1 : 0];
    if (!current) {
      const first = score.measures[0].staves[S.staves(score)[0].key].voices[0][0];
      if (first) this.select([first.id]);
      return;
    }
    let mi = current.mi;
    let index = current.index;
    const voices = (m) => score.measures[m].staves[current.staffKey].voices[current.voice] || [];
    if (byMeasure) {
      mi = Math.max(0, Math.min(score.measures.length - 1, mi + direction));
      index = 0;
    } else {
      index += direction;
      if (index < 0) { if (mi === 0) return; mi -= 1; index = voices(mi).length - 1; }
      else if (index >= voices(mi).length) { if (mi === score.measures.length - 1) return; mi += 1; index = 0; }
    }
    const event = voices(mi)[index];
    if (event) {
      this.select([event.id]);
      if (!event.rest) this.preview(event.pitches);
    }
  }
}

const editor = new DictationEditor();
editor.boot();
// For the browser console, and for checking the editor from outside it.
window.__dictationEditor = editor;
