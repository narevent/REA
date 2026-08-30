/**
 * inspector.js
 *
 * The property panels: exercise, bar, note.
 *
 * Every field an exercise, a bar or a note can carry is here, including the
 * ones with no notation — the timing nudge, the attack time, the loudness,
 * the scale-degree alias, the pickup-bar repeat count.  Those are exactly the
 * properties that distinguish the imported lessons from a plain melody, so an
 * editor that could only place noteheads would not be able to author them.
 *
 * Fields are declared, not hand-written, because they nearly all behave the
 * same way: read a value out of the document, write it back on change, and
 * apply to every selected item at once.  Where several notes are selected and
 * disagree, the control shows "—" and only overwrites the ones the teacher
 * actually edits.
 */

import { DURATIONS, MODIFIERS, MODIFIER_LABELS, describeNote, splitToken, buildToken } from "./scoreDoc.js?v=107";

const MIXED = "—"; // em dash: several selected items, several values

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** One labelled control, plus its hint. */
function fieldRow(spec, control) {
  const row = element("label", "ed-field");
  row.appendChild(element("span", "ed-field-lbl", spec.label));
  row.appendChild(control);
  if (spec.hint) row.appendChild(element("span", "ed-field-hint", spec.hint));
  return row;
}

function datalistFor(id, values) {
  const list = element("datalist");
  list.id = id;
  (values || []).forEach((value) => {
    const option = element("option");
    option.value = value;
    list.appendChild(option);
  });
  return list;
}

/**
 * Build the control for one field spec.
 *
 * @param {object} spec   {key, label, type, options, min, max, step, hint}
 * @param {*} value       the shared value, or the MIXED marker
 * @param {function} commit  called with the new value
 */
function buildControl(spec, value, commit) {
  const mixed = value === MIXED;

  if (spec.type === "checkbox") {
    const input = element("input");
    input.type = "checkbox";
    input.className = "ed-check";
    input.indeterminate = mixed;
    input.checked = !mixed && !!value;
    input.addEventListener("change", () => commit(input.checked));
    const row = element("label", "ed-field ed-field-check");
    row.appendChild(input);
    row.appendChild(element("span", "ed-field-lbl", spec.label));
    if (spec.hint) row.appendChild(element("span", "ed-field-hint", spec.hint));
    return { row, input };
  }

  if (spec.type === "select") {
    const select = element("select", "ed-input");
    if (mixed) {
      const option = element("option", null, MIXED);
      option.value = MIXED;
      select.appendChild(option);
    }
    (spec.options || []).forEach((option) => {
      const node = element("option", null, option.label);
      node.value = String(option.value);
      select.appendChild(node);
    });
    select.value = mixed ? MIXED : String(value ?? "");
    select.addEventListener("change", () => {
      if (select.value === MIXED) return;
      const chosen = (spec.options || []).find((o) => String(o.value) === select.value);
      commit(chosen ? chosen.value : select.value);
    });
    return { row: fieldRow(spec, select), input: select };
  }

  if (spec.type === "range") {
    const wrap = element("div", "ed-range");
    const slider = element("input");
    slider.type = "range";
    slider.min = spec.min;
    slider.max = spec.max;
    slider.step = spec.step || 1;
    slider.value = mixed ? (spec.min + spec.max) / 2 : value;
    const number = element("input");
    number.type = "number";
    number.className = "ed-input ed-input-num";
    number.min = spec.min;
    number.max = spec.max;
    number.step = spec.step || 1;
    number.value = mixed ? "" : value;
    number.placeholder = mixed ? MIXED : "";
    const push = (raw) => {
      const parsed = Number(raw);
      if (Number.isNaN(parsed)) return;
      const clamped = Math.max(spec.min, Math.min(spec.max, parsed));
      slider.value = clamped;
      number.value = clamped;
      commit(clamped);
    };
    slider.addEventListener("input", () => push(slider.value));
    number.addEventListener("change", () => push(number.value));
    wrap.appendChild(slider);
    wrap.appendChild(number);
    return { row: fieldRow(spec, wrap), input: number };
  }

  const input = element("input");
  input.className = "ed-input";
  input.type = spec.type === "number" ? "number" : "text";
  if (spec.min != null) input.min = spec.min;
  if (spec.max != null) input.max = spec.max;
  if (spec.step != null) input.step = spec.step;
  input.value = mixed || value == null ? "" : String(value);
  input.placeholder = mixed ? MIXED : (spec.placeholder || "");
  if (spec.suggestions && spec.suggestions.length) {
    const id = `ed-list-${spec.key}`;
    input.setAttribute("list", id);
    input.dataset.datalist = id;
  }
  input.addEventListener("change", () => {
    if (spec.type === "number") {
      if (input.value === "" && spec.nullable) return commit(null);
      const parsed = Number(input.value);
      if (Number.isNaN(parsed)) return;
      return commit(parsed);
    }
    return commit(input.value);
  });
  const row = fieldRow(spec, input);
  if (spec.suggestions && spec.suggestions.length) {
    row.appendChild(datalistFor(input.dataset.datalist, spec.suggestions));
  }
  return { row, input };
}

/** The value shared by every item, or MIXED when they disagree. */
function sharedValue(items, key) {
  if (!items.length) return null;
  const first = items[0][key];
  return items.every((item) => item[key] === first) ? first : MIXED;
}

/**
 * Render a group of fields into *parent*.
 *
 * @param {HTMLElement} parent
 * @param {string} title
 * @param {Array} specs
 * @param {Array} items      the objects being edited (1..n)
 * @param {function} onChange  (key, value) => void
 */
function renderGroup(parent, title, specs, items, onChange) {
  const group = element("div", "ed-group");
  if (title) group.appendChild(element("h3", "ed-group-title", title));
  specs.forEach((spec) => {
    const value = spec.get ? spec.get(items) : sharedValue(items, spec.key);
    const { row } = buildControl(spec, value, (next) => onChange(spec.key, next, spec));
    group.appendChild(row);
  });
  parent.appendChild(group);
}

export class Inspector {
  /**
   * @param {HTMLElement} root
   * @param {object} hooks  {onMeta, onKey, onBar, onNote}
   */
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.options = null;
    this.tab = "note";
  }

  setOptions(options) { this.options = options; }

  /** Redraw for the current document + selection. */
  render(doc, selection) {
    this.doc = doc;
    this.selection = selection;
    this.root.innerHTML = "";
    if (!doc) return;

    const tabs = element("div", "ed-tabs");
    [
      ["note", `Note${selection.notes.length > 1 ? ` (${selection.notes.length})` : ""}`],
      ["bar", `Bar${selection.bars.length > 1 ? ` (${selection.bars.length})` : ""}`],
      ["exercise", "Exercise"],
    ].forEach(([key, label]) => {
      const button = element("button", `ed-tab${this.tab === key ? " is-active" : ""}`, label);
      button.type = "button";
      button.addEventListener("click", () => { this.tab = key; this.render(doc, selection); });
      tabs.appendChild(button);
    });
    this.root.appendChild(tabs);

    const body = element("div", "ed-tab-body");
    this.root.appendChild(body);

    if (this.tab === "note") this._renderNotes(body);
    else if (this.tab === "bar") this._renderBars(body);
    else this._renderExercise(body);
  }

  // -- notes -------------------------------------------------------------

  _renderNotes(body) {
    const positions = this.selection.notes || [];
    const events = positions
      .map(({ barIndex, noteIndex }) => {
        const bar = this.doc.bars[barIndex];
        return bar ? bar.events[noteIndex] : null;
      })
      .filter(Boolean);

    if (!events.length) {
      body.appendChild(element(
        "p", "ed-hint",
        "Select a note to edit it — click one on the stave, or click empty staff to write a new one."
      ));
      return;
    }

    const commit = (key, value) => this.hooks.onNote(positions, { [key]: value });

    if (events.length === 1) {
      const summary = element("div", "ed-note-summary");
      summary.appendChild(element("span", "ed-note-pitch", describeNote(events[0], this.doc.key_signature)));
      summary.appendChild(element(
        "span", "ed-note-place",
        `bar ${positions[0].barIndex + 1}, note ${positions[0].noteIndex + 1}`
      ));
      body.appendChild(summary);
    }

    // Pitch, spelled the way the source spells it: letter, octave index and
    // an optional modifier, rather than a single opaque token.
    const token = events.length === 1 ? splitToken(events[0].note_name) : null;
    const pitchSpecs = [
      {
        key: "note_name", label: "Note name", type: "text",
        hint: "German letters — c d e f g a h. 'h' is B natural.",
      },
      {
        key: "__letter", label: "Letter", type: "select",
        options: ["c", "d", "e", "f", "g", "a", "h"].map((l) => ({ value: l, label: l })),
        get: () => (token ? token.letter : MIXED),
      },
      {
        key: "__octave", label: "Octave", type: "number", min: 0, max: 9,
        hint: "Source octave index: 0 is the low register, 1 is the middle-C octave.",
        get: () => (token ? token.octave : MIXED),
      },
      {
        key: "__modifier", label: "Accidental", type: "select",
        options: MODIFIERS.map((m) => ({ value: m === null ? "" : m, label: MODIFIER_LABELS[m === null ? "null" : m] })),
        get: () => (token ? (token.modifier || "") : MIXED),
      },
    ];

    renderGroup(body, "Pitch", pitchSpecs, events, (key, value) => {
      if (key === "note_name") return commit("note_name", value);
      // The three spelling controls edit one token, so each rebuilds it from
      // the note's own current parts — never from a stale cached token.
      return this.hooks.onNote(positions, (event) => {
        const parts = splitToken(event.note_name);
        if (key === "__letter") parts.letter = value;
        if (key === "__octave") parts.octave = Number(value);
        if (key === "__modifier") parts.modifier = value || null;
        return { note_name: buildToken(parts) };
      });
    });

    renderGroup(body, "Rhythm", [
      {
        key: "duration", label: "Duration", type: "select",
        options: DURATIONS.map((d) => ({ value: d.value, label: `${d.label} (${d.short})` })),
      },
      {
        key: "horizontal_offset_ms", label: "Timing offset", type: "range",
        min: -60, max: 60, step: 1,
        hint: "Nudges the note earlier (−) or later (+). Playback multiplies it by 12 ms.",
      },
    ], events, commit);

    renderGroup(body, "Sound", [
      { key: "volume", label: "Volume", type: "range", min: 0, max: 127, step: 1 },
      {
        key: "attack_decay_time", label: "Attack / decay", type: "number",
        min: 0, max: 5, step: 0.005, nullable: true,
        hint: "Seconds. Leave empty to use the exercise default.",
      },
    ], events, commit);

    renderGroup(body, "Role", [
      {
        key: "alias_degree", label: "Degree alias", type: "text",
        hint: "What the note is called in the exercise — a scale degree (1..8, 5', 5,) or a chromatic index.",
      },
      {
        key: "is_rest", label: "Rest", type: "checkbox",
        hint: "A silent slot: it still takes its duration.",
      },
      {
        key: "is_enharmonic", label: "Follows the key signature", type: "checkbox",
        hint: "The note takes its accidental from the key rather than from its own token.",
      },
      { key: "event_type", label: "Event type", type: "text" },
    ], events, commit);
  }

  // -- bars --------------------------------------------------------------

  _renderBars(body) {
    const indices = this.selection.bars.length
      ? this.selection.bars
      : Array.from(new Set((this.selection.notes || []).map((n) => n.barIndex)));
    const bars = indices.map((i) => this.doc.bars[i]).filter(Boolean);

    if (!bars.length) {
      body.appendChild(element("p", "ed-hint", "Select a bar — shift-click empty staff, or select a note in it."));
      return;
    }

    const commit = (key, value) => this.hooks.onBar(indices, { [key]: value });
    const options = this.options || {};

    const specs = [
      {
        key: "label", label: "Label", type: "text",
        hint: "Drawn above the bar — a Roman numeral for a harmonic function, or a chord name.",
      },
      {
        key: "music_mode_chord", label: "Key of this bar", type: "text",
        suggestions: options.mode_chords || [],
        hint: "German root + mode, e.g. As_Major. Sets the key signature the stave draws.",
      },
      {
        key: "music_clef", label: "Clef", type: "text",
        suggestions: options.clefs || [],
      },
      {
        key: "music_rhythm", label: "Rhythm", type: "text",
        suggestions: options.rhythms || [],
      },
      {
        key: "is_incomplete_bar", label: "Pickup bar", type: "checkbox",
        hint: "An upbeat: it is played but does not count as a full bar.",
      },
      {
        key: "incomplete_bar_playback_count", label: "Pickup repeats", type: "number",
        min: 0, max: 99,
      },
    ];

    if (this.doc.system === "relative") {
      specs.push(
        {
          key: "degree", label: "Scale degree", type: "text",
          hint: "The degree this bar is built on — e.g. 1, 5', 5, or a run like 3,2,1.",
        },
        {
          key: "quality", label: "Degree quality", type: "select",
          options: [
            { value: "natural", label: "Natural" },
            { value: "raised", label: "Raised" },
            { value: "lowered", label: "Lowered" },
          ],
        },
      );
    }

    renderGroup(body, bars.length > 1 ? `${bars.length} bars` : `Bar ${indices[0] + 1}`, specs, bars, commit);
  }

  // -- the exercise ------------------------------------------------------

  _renderExercise(body) {
    const meta = this.doc.meta;
    const options = this.options || {};
    const commit = (key, value) => this.hooks.onMeta({ [key]: value });
    const asOptions = (list) => (list || []).map((o) =>
      (typeof o === "object" ? { value: o.value, label: o.label } : { value: o, label: o })
    );

    if (this.doc.system === "relative") {
      const keys = options.keys || [];
      const keyRow = element("div", "ed-group");
      keyRow.appendChild(element("h3", "ed-group-title", "Key"));
      const select = element("select", "ed-input");
      keys.forEach((key) => {
        const option = element("option", null, `${key.name} (${key.mode})`);
        option.value = String(key.id);
        select.appendChild(option);
      });
      select.value = String(this.doc.key_model ?? "");
      select.addEventListener("change", () => {
        const key = keys.find((k) => String(k.id) === select.value);
        if (key) this.hooks.onKey(key);
      });
      keyRow.appendChild(fieldRow(
        { label: "Built on", hint: "Changing the key re-signs every bar; the written notes stay as they are." },
        select
      ));
      body.appendChild(keyRow);

      renderGroup(body, "Identity", [
        { key: "texture", label: "Texture", type: "select", options: asOptions((options.relative || {}).textures) },
        {
          key: "formula_name", label: "Formula", type: "text",
          suggestions: (options.relative || {}).formula_names,
          hint: "Melodic lessons only: Octave, Quinta, Extended.",
        },
        {
          key: "category", label: "Category", type: "select",
          options: [{ value: "", label: "— (melodic)" }].concat(asOptions((options.relative || {}).categories)),
        },
        { key: "inversion", label: "Inversion", type: "text", suggestions: (options.relative || {}).inversions, hint: "Figured bass: 53 63 64, or 7 65 43 2." },
        { key: "interval_name", label: "Interval", type: "text", suggestions: (options.relative || {}).interval_names },
        { key: "part", label: "Part", type: "text", suggestions: (options.relative || {}).parts },
        {
          key: "variant", label: "Variant", type: "text",
          suggestions: (options.relative || {}).variants,
          hint: "What makes this exercise different from its siblings — SKALA, ABC, v1_F …",
        },
      ], [meta], commit);
    } else {
      const absolute = options.absolute || {};
      renderGroup(body, "Identity", [
        { key: "texture", label: "Texture", type: "select", options: asOptions(absolute.textures) },
        { key: "category", label: "Category", type: "select", options: asOptions(absolute.categories) },
        { key: "span", label: "Span", type: "select", options: [{ value: "", label: "— (harmonic)" }].concat(asOptions(absolute.spans)) },
        { key: "grades", label: "Grades", type: "text", suggestions: absolute.grades },
        { key: "quality", label: "Quality", type: "text", suggestions: absolute.qualities },
        { key: "interval_size", label: "Interval size", type: "text", suggestions: absolute.interval_sizes },
        { key: "inversion", label: "Inversion", type: "text", suggestions: absolute.inversions },
        { key: "part", label: "Part", type: "text", suggestions: absolute.parts },
        {
          key: "phase", label: "Phase", type: "number", min: 0, max: 2,
          hint: "Harmonic lessons: 1 presents the material melodically, 2 harmonically. 0 for melodic lessons.",
        },
        { key: "exercise_number", label: "Exercise number", type: "number", min: 1, max: 99 },
        {
          key: "exercise_type", label: "Exercise type", type: "text",
          suggestions: absolute.exercise_types,
          hint: "What the student does: listening_model, singing_model, guessing_notes …",
        },
        { key: "timed", label: "Timed", type: "checkbox" },
        { key: "chromatic", label: "Chromatic", type: "checkbox" },
      ], [meta], commit);
    }

    renderGroup(body, "Playback", [
      {
        key: "tempo", label: "Tempo", type: "range", min: 20, max: 200, step: 1,
        hint: "Beats per minute. Harmonic lessons are played at half this tempo.",
      },
      {
        key: "mid_bar_time", label: "Gap between bars", type: "number",
        min: 0, max: 5, step: 0.01, hint: "Seconds of silence after each bar.",
      },
      { key: "default_rhythm", label: "Default rhythm", type: "text", suggestions: options.rhythms },
      {
        key: "draw_only_note_heads", label: "Draw note heads only", type: "checkbox",
        hint: "Hides stems and flags — used by the scale models.",
      },
      {
        key: "source_file", label: "Source file", type: "text",
        hint: "Where this exercise was imported from. Blank for one written here.",
      },
    ], [meta], commit);
  }
}
