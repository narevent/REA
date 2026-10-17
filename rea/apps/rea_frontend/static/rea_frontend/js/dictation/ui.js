/**
 * ui.js — the dictation editor's palettes, toolbar, side panel and dialogs.
 *
 * Built afresh from the editor's state whenever it changes; nothing here
 * keeps state of its own except which palette sections are open.  Every
 * control calls one of the editor's commands — the same commands the
 * keyboard calls — so a palette button and its shortcut can never disagree.
 */

import * as S from "./score.js?v=177";
import { labelWithAccidental, labelWithDuration } from "../editor/glyphs.js?v=177";

const DURATION_FRACTION = { w: 1, h: 0.5, q: 0.25, 8: 0.125, 16: 0.0625, 32: 0.03125, 64: 0.015625 };
const DURATION_KEY = { 64: 1, 32: 2, 16: 3, 8: 4, q: 5, h: 6, w: 7 };

/** SMuFL code points, drawn in Bravura (which VexFlow has already loaded). */
const SMUFL = {
  dot: "", tie: "‿", staccato: "", accent: "", tenuto: "",
  marcato: "", fermata: "", segno: "", coda: "",
  treble: "", bass: "", alto: "", tenor: "", treble8vb: "",
  repeatStart: "", repeatEnd: "", final: "", double: "", single: "",
  restQ: "",
};

const openSections = new Set(["notes", "marks", "dynamics", "measures"]);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, title, action, { on = false, disabled = false, className = "", glyph = null } = {}) {
  const node = el("button", `dz-btn ${className}`.trim());
  node.type = "button";
  node.title = title;
  node.disabled = disabled;
  node.classList.toggle("is-on", !!on);
  if (glyph) {
    const g = el("span", "dz-smufl", glyph);
    node.appendChild(g);
    if (label) node.appendChild(el("span", "dz-btn-text", label));
  } else {
    node.textContent = label;
  }
  node.addEventListener("click", (e) => { e.preventDefault(); action(); });
  return node;
}

function section(host, id, title, build) {
  const wrap = el("section", "dz-section");
  const head = el("button", "dz-section-head", title);
  head.type = "button";
  head.setAttribute("aria-expanded", openSections.has(id) ? "true" : "false");
  head.addEventListener("click", () => {
    if (openSections.has(id)) openSections.delete(id); else openSections.add(id);
    wrap.classList.toggle("is-open", openSections.has(id));
    head.setAttribute("aria-expanded", openSections.has(id) ? "true" : "false");
  });
  wrap.appendChild(head);
  const body = el("div", "dz-section-body");
  build(body);
  wrap.appendChild(body);
  wrap.classList.toggle("is-open", openSections.has(id));
  host.appendChild(wrap);
}

function row(host, caption, items) {
  const r = el("div", "dz-row");
  if (caption) r.appendChild(el("span", "dz-row-lbl", caption));
  const set = el("div", "dz-row-set");
  items.forEach((item) => item && set.appendChild(item));
  r.appendChild(set);
  host.appendChild(r);
  return r;
}

/** What the selection says about one property, for lighting palette buttons. */
function selectedEvents(editor) {
  return editor.selectedEvents().map((w) => w.event);
}

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

export function buildPalette(host, editor) {
  const scroll = host.scrollTop;
  host.innerHTML = "";
  const events = selectedEvents(editor);
  const one = events[0] || null;
  const dur = editor.input.on || !one ? editor.input.dur : one.dur;
  const dots = editor.input.on || !one ? editor.input.dots : (one.dots || 0);

  section(host, "notes", "Notes", (body) => {
    row(body, "Value", S.DURATIONS.slice().reverse().map((d) => {
      const b = button(d.dur === "64" ? "64" : d.label, `${d.label} (${DURATION_KEY[d.dur]})`, () => editor.setDuration(d.dur), { on: dur === d.dur, className: "dz-dur" });
      // The drawn glyphs stop at the thirty-second; a sixty-fourth says so.
      return d.dur === "64" ? b : labelWithDuration(b, DURATION_FRACTION[d.dur], d.label);
    }).concat([
      button("", "Dot (.) — press again for a double dot", () => editor.toggleDot(), { on: dots > 0, glyph: dots > 1 ? SMUFL.dot + SMUFL.dot : SMUFL.dot }),
    ]));
    row(body, "Accidental", [
      [-2, "bb", "Double flat"], [-1, "b", "Flat"], [0, "r", "Natural"], [1, "#", "Sharp (#)"], [2, "x", "Double sharp"],
    ].map(([alter, mod, title]) => {
      const armed = editor.input.alter === alter;
      const b = button(title, title, () => editor.setAccidental(alter), { on: armed, className: "dz-acc" });
      return labelWithAccidental(b, mod, title);
    }));
    row(body, "", [
      button("Rest", "Rest (0)", () => (editor.input.on ? editor.writeAtCursor({ pitches: null }) : editor.erase()), { glyph: SMUFL.restQ }),
      button("Tie", "Tie (+)", () => editor.toggleTie(), { glyph: SMUFL.tie, on: one && !one.rest && one.pitches.every((p) => p.tie) }),
    ]);
    const voice = editor.input.on && editor.input.cursor ? editor.input.cursor.voice : editor.input.voice;
    row(body, "Voice", [0, 1, 2, 3].map((v) => button(String(v + 1), `Voice ${v + 1} (Ctrl+Alt+${v + 1})`, () => editor.setVoice(v), { on: voice === v, className: `dz-voice dz-voice-${v + 1}` })));
    row(body, "Tuplet", [[2, 3, "Duplet"], [3, 2, "Triplet"], [5, 4, "Quintuplet"], [6, 4, "Sextuplet"], [7, 4, "Septuplet"]].map(([num, den, name]) => (
      button(String(num), `${name}: divide the selected note into ${num} in the time of ${den}`, () => editor.tuplet(num, den))
    )));
    row(body, "Chord", [[3, "3rd"], [4, "4th"], [5, "5th"], [6, "6th"], [8, "8ve"]].map(([n, label]) => (
      button(label, `Add a ${label} above (Alt+${n}); Shift+letter adds that note`, () => editor.addToChord({ interval: n }))
    )));
  });

  section(host, "marks", "Articulations and lines", (body) => {
    row(body, "", S.ARTICULATIONS.map((name) => button("", name[0].toUpperCase() + name.slice(1), () => editor.articulation(name), {
      glyph: SMUFL[name], on: one && one.art && one.art.includes(name),
    })));
    row(body, "Lines", [
      button("Slur", "Slur from the first selected note to the last (S)", () => editor.span("slur"), { on: one && one.slur }),
      button("Cresc.", "Crescendo hairpin over the selection (<)", () => editor.span("<"), { on: one && one.hairpin === "<" }),
      button("Dim.", "Diminuendo hairpin over the selection (>)", () => editor.span(">"), { on: one && one.hairpin === ">" }),
    ]);
  });

  section(host, "dynamics", "Dynamics", (body) => {
    row(body, "", S.DYNAMICS.map((d) => button(d, `${d} under the selected note`, () => editor.dynamic(d), {
      on: one && one.dyn === d, className: "dz-dyn",
    })));
  });

  section(host, "measures", "Measures", (body) => {
    row(body, "", [
      button("Add 1", "Add a measure at the end (Ctrl+B)", () => editor.addMeasures(1)),
      button("Add 4", "Add four measures at the end", () => editor.addMeasures(4)),
      button("Insert", "Insert a measure before the selection (Insert)", () => editor.insertMeasure()),
      button("Delete", "Delete the selected measures (Ctrl+Delete)", () => editor.deleteMeasures(), { className: "dz-danger" }),
    ]);
  });

  section(host, "barlines", "Barlines and repeats", (body) => {
    const t = editor.targetMeasures();
    const m = editor.doc.score.measures[t.to] || {};
    const f = editor.doc.score.measures[t.from] || {};
    row(body, "", [
      button("", "Start repeat", () => editor.measureProps("start repeat", { repeatStart: !f.repeatStart }), { glyph: SMUFL.repeatStart, on: f.repeatStart }),
      button("", "End repeat", () => editor.measureProps("end repeat", { repeatEnd: !m.repeatEnd }), { glyph: SMUFL.repeatEnd, on: m.repeatEnd }),
      button("", "Double barline", () => editor.measureProps("barline", { barline: m.barline === "double" ? null : "double" }), { glyph: SMUFL.double, on: m.barline === "double" }),
      button("", "Final barline", () => editor.measureProps("barline", { barline: m.barline === "final" ? null : "final" }), { glyph: SMUFL.final, on: m.barline === "final" }),
    ]);
    row(body, "Ending", [
      button("1.", "First ending over the selected measures", () => editor.measureProps("ending", { volta: f.volta && f.volta.join() === "1" ? null : [1] }), { on: f.volta && f.volta.join() === "1" }),
      button("2.", "Second ending", () => editor.measureProps("ending", { volta: f.volta && f.volta.join() === "2" ? null : [2] }), { on: f.volta && f.volta.join() === "2" }),
      button("1.2.", "An ending played both times", () => editor.measureProps("ending", { volta: f.volta && f.volta.join() === "1,2" ? null : [1, 2] }), { on: f.volta && f.volta.join() === "1,2" }),
      button("3.", "Third ending", () => editor.measureProps("ending", { volta: f.volta && f.volta.join() === "3" ? null : [3] }), { on: f.volta && f.volta.join() === "3" }),
    ]);
    row(body, "Jumps", Object.entries(S.NAVIGATIONS).map(([nav, label]) => button(
      nav === "segno" || nav === "coda" ? "" : label,
      label,
      () => editor.measureProps("jump", { nav: f.nav === nav ? null : nav }),
      { on: f.nav === nav, glyph: nav === "segno" ? SMUFL.segno : nav === "coda" ? SMUFL.coda : null, className: "dz-nav" },
    )));
  });

  section(host, "clefs", "Clefs, keys and time", (body) => {
    const t = editor.targetMeasures();
    const clef = S.clefAt(editor.doc.score, t.staffKey || S.staves(editor.doc.score)[0].key, t.from);
    row(body, "Clef", S.CLEFS.map((c) => button("", `${c.label} clef`, () => editor.setClef(c.clef), {
      glyph: SMUFL[c.clef], on: clef === c.clef, className: "dz-clef",
    })));
    const keyNow = S.keyAt(editor.doc.score, t.from);
    const keySelect = el("select", "ed-input dz-select");
    for (let k = -7; k <= 7; k += 1) {
      const option = el("option", null, `${S.keyName(k)} (${k > 0 ? k + "♯" : k < 0 ? -k + "♭" : "no accidentals"})`);
      option.value = String(k);
      keySelect.appendChild(option);
    }
    keySelect.value = String(keyNow);
    keySelect.addEventListener("change", () => editor.setKey(Number(keySelect.value)));
    row(body, "Key", [keySelect]);
    const time = S.timeAt(editor.doc.score, t.from);
    row(body, "Time", ["2/4", "3/4", "4/4", "5/4", "6/8", "9/8", "12/8", "2/2", "3/8"].map((sig) => {
      const [n, d] = sig.split("/").map(Number);
      return button(sig, `${sig} from the selected measure`, () => editor.setTime([n, d]), { on: time[0] === n && time[1] === d, className: "dz-time" });
    }));
    const tempo = el("input", "ed-input dz-num");
    tempo.type = "number";
    tempo.min = 20;
    tempo.max = 300;
    tempo.value = String(S.tempoAt(editor.doc.score, t.from));
    tempo.addEventListener("change", () => editor.setTempo(Math.max(20, Math.min(300, Number(tempo.value) || 80))));
    row(body, "Tempo ♩=", [tempo]);
  });

  section(host, "instruments", "Instruments", (body) => {
    editor.doc.score.parts.forEach((part, i) => {
      const r = el("div", "dz-part");
      const name = el("input", "ed-input dz-part-name");
      name.value = part.name;
      name.addEventListener("change", () => editor.renamePart(part.id, name.value));
      r.appendChild(name);
      r.appendChild(button("↑", "Move up", () => editor.movePart(part.id, -1), { disabled: i === 0 }));
      r.appendChild(button("↓", "Move down", () => editor.movePart(part.id, 1), { disabled: i === editor.doc.score.parts.length - 1 }));
      r.appendChild(button("✕", "Remove this instrument and its music", () => editor.removePart(part.id), { className: "dz-danger", disabled: editor.doc.score.parts.length <= 1 }));
      body.appendChild(r);
    });
    const add = el("select", "ed-input dz-select");
    const none = el("option", null, "Add an instrument…");
    none.value = "";
    add.appendChild(none);
    Object.entries(S.INSTRUMENTS).forEach(([key, preset]) => {
      const option = el("option", null, preset.name);
      option.value = key;
      add.appendChild(option);
    });
    add.addEventListener("change", () => { if (add.value) editor.addPart(add.value); });
    body.appendChild(add);
  });
  host.scrollTop = scroll;
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

export function buildToolbar(host, editor) {
  host.innerHTML = "";
  const group = (items, className = "") => {
    const g = el("div", `ed-tool-group ${className}`.trim());
    items.forEach((i) => i && g.appendChild(i));
    host.appendChild(g);
  };
  const plain = (label, title, action, opts = {}) => {
    const b = el("button", `ed-btn${opts.primary ? " ed-btn-primary" : ""}${opts.quiet ? " ed-btn-quiet" : ""}${opts.on ? " is-on" : ""}`, label);
    b.type = "button";
    b.title = title;
    b.disabled = !!opts.disabled;
    b.addEventListener("click", action);
    return b;
  };
  group([
    plain("New…", "Start a new dictation", () => editor.chooseNew()),
    plain("Open…", "Open one of your dictations", () => editor.chooseToOpen()),
    plain("Save", "Save (Ctrl+S)", () => editor.save(), { primary: true }),
  ]);
  group([
    plain("Undo", "Undo (Ctrl+Z)", () => editor.undo(), { disabled: !editor.undoStack.length }),
    plain("Redo", "Redo (Ctrl+Shift+Z)", () => editor.redo(), { disabled: !editor.redoStack.length }),
  ]);
  group([
    plain(editor.input.on ? "Writing (N)" : "Write notes (N)", "Note input: letters write notes at the cursor", () => (editor.input.on ? editor.stopInput() : editor.startInput()), { on: editor.input.on }),
  ]);
  const tempo = el("label", "dz-tempo");
  tempo.appendChild(el("span", "ed-palette-lbl", "Speed"));
  const slider = el("input");
  slider.type = "range";
  slider.min = 40;
  slider.max = 150;
  slider.step = 5;
  slider.value = String(Math.round(editor.tempoScale * 100));
  const readout = el("span", "dz-tempo-val", `${slider.value}%`);
  slider.addEventListener("input", () => { editor.tempoScale = Number(slider.value) / 100; readout.textContent = `${slider.value}%`; });
  tempo.appendChild(slider);
  tempo.appendChild(readout);
  group([
    plain(editor.playing ? "Stop" : "Play", "Play from the selection (Space)", () => editor.play(), { on: editor.playing }),
    plain("From start", "Play from the beginning", () => editor.play({ fromMeasure: 0 })),
    tempo,
  ]);
  group([
    plain(editor.doc.published ? "Published" : "Draft", editor.doc.published
      ? "Students see this dictation. Click to take it back to a draft (then save)."
      : "Only you see this dictation. Click to publish it to students (then save).",
    () => { editor.doc.published = !editor.doc.published; editor.dirty = true; editor.renderAll(); },
    { on: editor.doc.published }),
    plain("Delete", "Delete this dictation", () => editor.remove(), { quiet: true }),
  ], "ed-tool-rare");
}

// ---------------------------------------------------------------------------
// The side panel
// ---------------------------------------------------------------------------

export function buildPanel(host, editor) {
  const scroll = host.scrollTop;
  host.innerHTML = "";
  const tabs = el("div", "ed-tabs");
  [["selection", "Selection"], ["phrases", `Phrases (${editor.doc.phrases.length})`], ["score", "Score"]].forEach(([id, label]) => {
    const t = el("button", `ed-tab${editor.panelTab === id ? " is-active" : ""}`, label);
    t.type = "button";
    t.addEventListener("click", () => { editor.panelTab = id; buildPanel(host, editor); });
    tabs.appendChild(t);
  });
  host.appendChild(tabs);
  const body = el("div", "ed-tab-body");
  host.appendChild(body);
  if (editor.panelTab === "phrases") phrasesPanel(body, editor);
  else if (editor.panelTab === "score") scorePanel(body, editor);
  else selectionPanel(body, editor);
  host.scrollTop = scroll;
}

function field(host, label, control, hint) {
  const r = el("label", "ed-field");
  r.appendChild(el("span", "ed-field-lbl", label));
  r.appendChild(control);
  if (hint) r.appendChild(el("span", "ed-field-hint", hint));
  host.appendChild(r);
  return r;
}

function describePitch(p) {
  const sign = { "-2": "𝄫", "-1": "♭", 0: "", 1: "♯", 2: "𝄪" }[String(p.alter || 0)];
  return `${p.step}${sign}${p.octave}`;
}

function selectionPanel(body, editor) {
  const events = editor.selectedEvents();
  if (events.length) {
    const first = events[0];
    const e = first.event;
    const head = el("div", "ed-note-summary");
    head.appendChild(el("span", "ed-note-pitch", e.rest ? "Rest" : e.pitches.map(describePitch).join(" · ")));
    const staff = S.staves(editor.doc.score).find((s) => s.key === first.staffKey);
    head.appendChild(el("span", "ed-note-place", `${events.length > 1 ? `${events.length} selected · ` : ""}measure ${first.mi + 1}, ${staff ? staff.part.name : ""}${staff && staff.part.staves.length > 1 ? ` (staff ${staff.staffIndex + 1})` : ""}, voice ${first.voice + 1}`));
    body.appendChild(head);
    const group = el("div", "ed-group");
    const value = S.DURATIONS.find((d) => d.dur === e.dur);
    group.appendChild(el("p", "ed-hint", `${value ? value.label : e.dur}${e.dots ? (e.dots === 2 ? ", double-dotted" : ", dotted") : ""}${e.tuplet ? `, ${e.tuplet.num} in the time of ${e.tuplet.den}` : ""}`));
    if (!e.rest && e.pitches.length > 1 && events.length === 1) {
      e.pitches.slice().reverse().forEach((p) => {
        const index = e.pitches.indexOf(p);
        const r = el("div", "dz-pitch-row");
        const pick = button(describePitch(p), "Select just this note of the chord", () => editor.select([e.id], { id: e.id, index }), {
          on: editor.selection.pitch && editor.selection.pitch.index === index,
        });
        r.appendChild(pick);
        r.appendChild(button("✕", "Remove this note from the chord", () => {
          editor.selection.pitch = { id: e.id, index };
          editor.erase();
        }, { className: "dz-danger" }));
        group.appendChild(r);
      });
    }
    const dyn = el("select", "ed-input");
    [["", "None"]].concat(S.DYNAMICS.map((d) => [d, d])).forEach(([v, l]) => {
      const o = el("option", null, l);
      o.value = v;
      dyn.appendChild(o);
    });
    dyn.value = e.dyn || "";
    dyn.addEventListener("change", () => editor.change("dynamic", (score) => S.setEventProps(score, [e.id], { dyn: dyn.value || null })));
    if (!e.rest) field(group, "Dynamic", dyn);
    body.appendChild(group);
    body.appendChild(el("p", "ed-hint", "Arrows change the pitch, 1–7 the value, Delete makes a rest. Shift+click another note to select a run — then New phrase under Phrases."));
    return;
  }
  const t = editor.targetMeasures();
  const measure = editor.doc.score.measures[t.from];
  if (editor.selection.measures && measure) {
    const group = el("div", "ed-group");
    group.appendChild(el("h3", "ed-group-title", t.from === t.to ? `Measure ${t.from + 1}` : `Measures ${t.from + 1}–${t.to + 1}`));
    const [num, den] = S.timeAt(editor.doc.score, t.from);
    group.appendChild(el("p", "ed-hint", `${num}/${den} · ${S.keyName(S.keyAt(editor.doc.score, t.from))} · ♩ = ${S.tempoAt(editor.doc.score, t.from)}`));
    const times = el("input", "ed-input dz-num");
    times.type = "number";
    times.min = 2;
    times.max = 9;
    times.value = String(editor.doc.score.measures[t.to].repeatTimes || 2);
    times.addEventListener("change", () => editor.measureProps("repeat count", { repeatTimes: Math.max(2, Math.min(9, Number(times.value) || 2)) }));
    if (editor.doc.score.measures[t.to].repeatEnd) field(group, "Played times", times, "How often the repeat ending here is played.");
    group.appendChild(el("p", "ed-hint", "The palettes on the left set its time, key, clef, barlines, endings and jumps. Press N to write notes from here."));
    body.appendChild(group);
    return;
  }
  body.appendChild(el("p", "ed-hint", "Click a note to select it, or an empty part of a measure to select the measure. Double-click a staff — or press N — to write notes."));
}

function phrasesPanel(body, editor) {
  const intro = el("p", "ed-hint", "A phrase is what students hear as one: everything sounding, in every part, from its first note to its last. Select the first note, Shift+click the last, then add it.");
  body.appendChild(intro);
  const actions = el("div", "dz-row-set dz-phrase-actions");
  actions.appendChild(button("New phrase from selection", "Make the selected notes a phrase", () => editor.newPhrase(), { className: "dz-primary" }));
  const every = el("select", "ed-input dz-select");
  [["", "Cut into phrases of…"], ["1", "1 measure"], ["2", "2 measures"], ["4", "4 measures"], ["8", "8 measures"]].forEach(([v, l]) => {
    const o = el("option", null, l);
    o.value = v;
    every.appendChild(o);
  });
  every.addEventListener("change", () => { if (every.value) editor.phrasesEvery(Number(every.value)); });
  actions.appendChild(every);
  body.appendChild(actions);

  const list = el("ol", "dz-phrases");
  editor.doc.phrases.forEach((phrase, i) => {
    const span = S.phraseSpan(editor.doc.score, phrase);
    const item = el("li", `dz-phrase-item${phrase.id === editor.selectedPhrase ? " is-selected" : ""}${span ? "" : " is-broken"}`);
    const name = el("input", "ed-input dz-phrase-name");
    name.value = phrase.name || `Phrase ${i + 1}`;
    name.addEventListener("change", () => editor.updatePhrase(phrase.id, { name: name.value }, "rename phrase"));
    item.appendChild(name);
    item.appendChild(el("span", "dz-phrase-where", span ? `m. ${span.fromMeasure + 1}–${span.toMeasure + 1}` : "a note is missing"));
    const tools = el("div", "dz-row-set");
    tools.appendChild(button("Play", "Play this phrase", () => editor.playPhrase(phrase.id), { disabled: !span }));
    tools.appendChild(button("Show", "Select its first and last notes", () => editor.selectPhrase(phrase.id), { disabled: !span }));
    tools.appendChild(button("✕", "Delete this phrase (the music stays)", () => editor.deletePhrase(phrase.id), { className: "dz-danger" }));
    item.appendChild(tools);
    list.appendChild(item);
  });
  body.appendChild(list);
  if (!editor.doc.phrases.length) body.appendChild(el("p", "ed-hint", "No phrases yet."));
}

function scorePanel(body, editor) {
  const group = el("div", "ed-group");
  const description = el("textarea", "ed-input dz-description");
  description.rows = 4;
  description.value = editor.doc.description || "";
  description.addEventListener("input", () => { editor.doc.description = description.value; editor.dirty = true; });
  field(group, "Notes for students", description, "Shown with the dictation: where it is from, what to listen for.");
  const tempo = el("input", "ed-input dz-num");
  tempo.type = "number";
  tempo.min = 20;
  tempo.max = 300;
  tempo.value = String(editor.doc.score.tempo || 80);
  tempo.addEventListener("change", () => editor.change("tempo", (score) => { score.tempo = Math.max(20, Math.min(300, Number(tempo.value) || 80)); }));
  field(group, "Tempo (quarter notes a minute)", tempo);
  const published = el("input");
  published.type = "checkbox";
  published.checked = !!editor.doc.published;
  published.addEventListener("change", () => { editor.doc.published = published.checked; editor.dirty = true; editor.renderAll(); });
  const r = el("label", "ed-field ed-field-check");
  r.appendChild(published);
  r.appendChild(el("span", "ed-field-lbl", "Published to students"));
  r.appendChild(el("span", "ed-field-hint", "Offered in the Dictation area once saved."));
  group.appendChild(r);
  body.appendChild(group);
  const counts = el("p", "ed-hint", `${editor.doc.score.parts.length} instrument${editor.doc.score.parts.length === 1 ? "" : "s"}, ${editor.doc.score.measures.length} measures, ${editor.doc.phrases.length} phrase${editor.doc.phrases.length === 1 ? "" : "s"}.`);
  body.appendChild(counts);
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

/**
 * A modal: a question with buttons, a list to pick from, or a small form.
 * Resolves to the chosen value — the form's values for "submit" — or null.
 */
export function openDialog({ title, body = "", actions = [], list = null, form = null }) {
  return new Promise((resolve) => {
    const scrim = el("div", "ed-ask-scrim");
    const box = el("div", "ed-ask");
    box.setAttribute("role", "dialog");
    box.appendChild(el("h2", "ed-ask-title", title));
    if (body) box.appendChild(el("p", "ed-ask-body", body));
    const done = (value) => { scrim.remove(); document.removeEventListener("keydown", onKey, true); resolve(value); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(null); } };
    document.addEventListener("keydown", onKey, true);
    if (list) {
      const ul = el("div", "ed-picker-list dz-pick");
      list.forEach((item) => {
        const b = el("button", "ed-picker-item");
        b.type = "button";
        b.appendChild(el("span", null, item.label));
        if (item.detail) b.appendChild(el("span", "dz-pick-detail", item.detail));
        b.addEventListener("click", () => done(item.value));
        ul.appendChild(b);
      });
      box.appendChild(ul);
    }
    const inputs = {};
    if (form) {
      const f = el("div", "ed-ask-form");
      form.forEach((spec) => {
        let control;
        if (spec.type === "select") {
          control = el("select", "ed-input");
          spec.options.forEach((o) => {
            const option = el("option", null, o.label);
            option.value = o.value;
            control.appendChild(option);
          });
        } else {
          control = el("input", "ed-input");
          control.type = spec.type || "text";
        }
        control.value = spec.value || "";
        inputs[spec.key] = control;
        field(f, spec.label, control);
      });
      box.appendChild(f);
    }
    const bar = el("div", "ed-ask-actions");
    actions.forEach((a) => {
      const b = el("button", `ed-btn${a.danger ? " ed-btn-danger" : ""}${a.value === "submit" || a.value === true ? " ed-btn-primary" : ""}`, a.label);
      b.type = "button";
      b.addEventListener("click", () => {
        if (a.value === "submit") {
          const values = {};
          Object.entries(inputs).forEach(([k, c]) => { values[k] = c.value; });
          done(values);
        } else done(a.value);
      });
      bar.appendChild(b);
    });
    box.appendChild(bar);
    scrim.appendChild(box);
    scrim.addEventListener("mousedown", (e) => { if (e.target === scrim) done(null); });
    document.body.appendChild(scrim);
    const focusable = box.querySelector("input, select, button");
    if (focusable) focusable.focus();
  });
}
