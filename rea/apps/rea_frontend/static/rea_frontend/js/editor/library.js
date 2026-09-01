/**
 * library.js
 *
 * Finding the exercise to edit — as the method's own tree, not as a search.
 *
 * This used to be a flat list with four dropdowns over it.  The library holds
 * around twelve thousand lessons, so what a teacher actually saw was three
 * hundred rows reading "A-dur – Extended", "A-dur – Extended ABC", "A-dur –
 * Extended AL1", … : every key of every formula of every variant in one
 * column, ordered by a sort key rather than by anything musical, with the
 * facets that would narrow it hidden inside select menus that gave no hint of
 * what choosing one would leave.
 *
 * But these exercises are not an unordered pile that happens to need
 * filtering.  They are a curriculum, and it is already written down — in
 * `curriculum.js`, which is the same outline the practice app navigates and
 * the same one a teacher teaches from.  So the picker is that tree.  Walking
 * Relative → Monophony → Major Formula → Notal → Octave → Diatonic is the way
 * a teacher already thinks about where an exercise lives, every step of it is
 * visible rather than folded into a menu, and by the time the bottom is
 * reached the "filter" has been applied by the walking.
 *
 * Two levels are not in the curriculum outline and are generated from what is
 * actually in the library, because they are the dimensions the outline
 * deliberately leaves out: the *key* (the practice app offers it as a chip
 * beside the path, since one exercise exists in all twenty-four) and the
 * *part* of a progressive set.  They appear as the last levels above the
 * exercises themselves.
 *
 * Nothing here loads a lesson's notes; opening one does that.
 */

import { AREAS } from "../curriculum.js?v=164";
import { absPartKey, absPartLabel } from "../lessonNaming.js?v=164";

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/** The intonation curriculum — the only area with a lesson library behind it.
 *  Rhythm and dictation are outlines with nothing to edit yet. */
const CURRICULUM = (AREAS.find((a) => a.id === "intonation") || {}).tree || [];

/**
 * The shelves that are not the curriculum, as roots beside Relative and
 * Absolute.
 *
 * Everything else in this tree is a place in the *method*.  These two are
 * not.  **Drafts** is where work that has not been given a place lives — a
 * new exercise starts there and stays until a teacher decides where it
 * belongs.  **Dictation** is a collection of its own: material a teacher
 * writes for dictation rather than for the intonation curriculum, and which
 * students reach through the Dictation area instead of by walking the method.
 *
 * They sit at the same level as the two systems because that is what they are
 * alternatives to — not a category within a system, but the absence of one,
 * or a different collection entirely.  Each still splits by system, because
 * the notes are written either against a key or against a chromatic base and
 * that choice is made at the first note.
 */
function shelfRoot(name, shelf) {
  return {
    name,
    children: [
      { name: "Relative", ctx: { system: "relative", shelf } },
      { name: "Absolute", ctx: { system: "absolute", shelf } },
    ],
  };
}

const SHELVES = [shelfRoot("Dictation", "dictation"), shelfRoot("Drafts", "draft")];

const TREE = CURRICULUM.concat(SHELVES);

/** The filter value meaning "this facet is empty", matching `BLANK` in the
 *  editor's views.py.  A relative lesson with no variant is the plain
 *  diatonic formula, which is a different exercise from the AL1 beside it, so
 *  "no variant" has to be sayable and cannot be said by leaving it out. */
const BLANK = "__blank__";

/**
 * Curriculum context → browse filters.
 *
 * The tree's nodes already carry the facet values that identify them (see the
 * CTX KEYS note in curriculum.js); this is the one place that turns them into
 * the query the editor's browse endpoint understands.  `subgroup` is the
 * outline's name for whichever column a branch happens to divide on, so it
 * lands in a different field on each side.
 */
function filtersFor(ctx) {
  const out = { system: ctx.system || "relative" };
  // Off the curriculum shelf nothing else about the path applies: these
  // lessons are not filed by the method's facets at all.
  if (ctx.shelf) return Object.assign(out, { shelf: ctx.shelf });
  if (ctx.texture) out.texture = ctx.texture;
  if (ctx.category) out.category = ctx.category;
  if (out.system === "relative") {
    // Major/Minor is a property of the key, not of the lesson — the same
    // formula exists in every key — so the outline's `keyMode` narrows which
    // keys the branch reaches rather than which lessons it matches.
    if (ctx.keyMode) out.key_mode = ctx.keyMode;
    if (ctx.formula) out.formula_name = ctx.formula;
    if (ctx.variant !== undefined) out.variant = ctx.variant === "" ? BLANK : ctx.variant;
    if (ctx.subgroup) out.interval_name = ctx.subgroup;
  } else {
    if (ctx.span) out.span = ctx.span;
    if (ctx.quality) out.quality = ctx.quality;
    if (ctx.phase) out.phase = ctx.phase;
    if (ctx.subgroup) {
      // Absolute poly divides on interval size for intervals and on figured
      // bass for chords; the outline calls both "subgroup", and which one it
      // means is decided by the category it sits under.
      if (ctx.category === "Intervals") out.interval_size = ctx.subgroup;
      else out.inversion = ctx.subgroup;
    }
  }
  return out;
}

/** Nodes with nothing to edit behind them.
 *
 *  `numeric` is not skipped for being unbuilt but for being a *duplicate*:
 *  it is the same lesson the Notal branch holds, drawn as scale degrees.  A
 *  student picks the reading they want; a teacher editing it twice in two
 *  places would be editing one thing. */
const SKIP_KINDS = new Set(["todo", "doc", "numeric"]);

/** The shelves an exercise can be put on instead of into the curriculum. */
export const SHELF_DESTINATIONS = [
  { value: "draft", label: "Drafts — not filed yet" },
  { value: "dictation", label: "Dictation — students find it under Dictation" },
];

/**
 * Every place an exercise can be filed, as a flat list of the tree's leaves.
 *
 * The tree is for *finding* an exercise, where walking it a level at a time is
 * the point.  Choosing where to save one is a different question with a
 * different shape: you already know roughly where it goes and you want to see
 * the options side by side.  So the same outline is flattened, each leaf
 * carrying the whole path that identifies it, and a teacher picks one.
 *
 * @returns {Array<{path: string[], label: string, ctx: object}>}
 */
export function destinations() {
  const out = [];
  const walk = (node, parentPath, parentCtx) => {
    if (SKIP_KINDS.has(node.kind)) return;
    // The shelves are destinations, but not *curriculum* ones — the picker
    // offers them separately, from `SHELF_DESTINATIONS`.
    if (node.ctx && node.ctx.shelf) return;
    const ctx = Object.assign({}, parentCtx, node.ctx || {});
    const path = parentPath.concat(node.name);
    // A node with children is a branch, even when every one of them was
    // skipped: "Numeric" holds only numeric leaves, and offering it as a
    // destination would file an exercise under a half-built context that no
    // branch of the tree would ever look in.
    if (node.children && node.children.length) {
      node.children.forEach((child) => walk(child, path, ctx));
      return;
    }
    out.push({ path, label: path.join(" › "), ctx });
  };
  CURRICULUM.forEach((node) => walk(node, [], {}));
  return out;
}

/**
 * A destination's context as the lesson fields that put an exercise there.
 *
 * The inverse of `filtersFor`: that one asks "which lessons live here", this
 * one says "make this lesson live here".  They have to agree, or an exercise
 * saved into a category would not be found by the branch it was saved into.
 */
export function metaFromCtx(ctx, system) {
  const meta = { shelf: "", texture: ctx.texture || "mono" };
  if (system === "relative") {
    meta.formula_name = ctx.formula || "";
    meta.variant = ctx.variant || "";
    meta.category = ctx.category || "";
    meta.interval_name = ctx.subgroup || "";
  } else {
    meta.category = ctx.category || "";
    meta.span = ctx.span || "";
    meta.quality = ctx.quality || "";
    if (ctx.phase) meta.phase = ctx.phase;
    if (ctx.subgroup) {
      if (ctx.category === "Intervals") meta.interval_size = ctx.subgroup;
      else meta.inversion = ctx.subgroup;
    }
  }
  return meta;
}

export class Library {
  /**
   * @param {HTMLElement} root
   * @param {object} hooks  {onOpen(system, id), onNew(system, ctx), search(params)}
   */
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.options = null;
    this.currentId = null;
    this.currentSystem = "relative";
    this.expanded = new Set();
    this.loads = new Map();   // path -> {state: "loading"|"ok"|"error", rows, error}
    this.query = "";
  }

  setOptions(options) {
    this.options = options;
    this.render();
  }

  /** Mark which exercise is open, so the tree shows where you are. */
  setCurrent(system, id) {
    this.currentSystem = system || this.currentSystem;
    this.currentId = id;
    this.render();
  }

  /** Re-fetch every branch that is currently showing exercises.  Called after
   *  a save or a delete, so a new exercise appears where it belongs and a
   *  removed one stops being offered. */
  refresh() {
    const open = [...this.loads.keys()];
    this.loads.clear();
    this.render();
    open.forEach((path) => {
      if (this.expanded.has(path)) this._loadLeaf(path);
    });
  }

  // -- the tree ----------------------------------------------------------

  render() {
    if (!this.root) return;
    const scroll = this.root.querySelector(".ed-tree");
    const scrollTop = scroll ? scroll.scrollTop : 0;
    this.root.innerHTML = "";

    const head = el("div", "ed-lib-head");
    head.appendChild(el("h2", "ed-lib-title", "Exercises"));
    const newButton = el("button", "ed-btn ed-btn-primary", "New");
    newButton.type = "button";
    newButton.title = "Start an empty exercise";
    newButton.addEventListener("click", () => this.hooks.onNew(this.currentSystem, {}));
    head.appendChild(newButton);
    this.root.appendChild(head);

    // A filter over the tree rather than a search that replaces it: typing
    // hides the branches that cannot contain a match, so the path to what is
    // left stays visible and the shape of the method is never lost.
    const search = el("input", "ed-input ed-lib-search");
    search.type = "search";
    search.placeholder = "Filter the curriculum…";
    search.value = this.query;
    search.addEventListener("input", () => {
      this.query = search.value;
      this.render();
      const again = this.root.querySelector(".ed-lib-search");
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    });
    this.root.appendChild(search);

    const tree = el("div", "ed-tree");
    TREE.forEach((node) => this._paintNode(tree, node, "", {}, 0));
    if (!tree.children.length) {
      tree.appendChild(el("p", "ed-hint", "Nothing in the curriculum matches that."));
    }
    this.root.appendChild(tree);
    tree.scrollTop = scrollTop;
  }

  /** Does this branch contain anything matching the filter text? */
  _matches(node, ctx) {
    const q = this.query.trim().toLowerCase();
    if (!q) return true;
    if ((node.name || "").toLowerCase().includes(q)) return true;
    const merged = Object.assign({}, ctx, node.ctx || {});
    if (Object.values(merged).some((v) => String(v).toLowerCase().includes(q))) return true;
    return (node.children || []).some((child) => this._matches(child, merged));
  }

  _paintNode(host, node, parentPath, parentCtx, depth) {
    if (SKIP_KINDS.has(node.kind)) return;
    const ctx = Object.assign({}, parentCtx, node.ctx || {});
    if (!this._matches(node, parentCtx)) return;

    const path = parentPath ? `${parentPath}/${node.name}` : node.name;
    const children = node.children || [];
    const isBranch = children.length > 0;
    // A category leaf, or a `parts` node: both bottom out in real exercises,
    // which are fetched when the node is opened rather than up front.
    const isLeaf = !isBranch;
    const open = this.expanded.has(path);

    const row = el("button", `ed-tree-node${open ? " is-open" : ""}${isLeaf ? " is-leaf" : ""}`);
    row.type = "button";
    row.style.setProperty("--depth", depth);
    row.appendChild(el("span", "ed-tree-twist", isBranch || isLeaf ? (open ? "▾" : "▸") : ""));
    row.appendChild(el("span", "ed-tree-name", node.name));
    row.addEventListener("click", () => this._toggle(path, ctx, isLeaf));
    host.appendChild(row);

    if (!open) return;

    if (isBranch) {
      children.forEach((child) => this._paintNode(host, child, path, ctx, depth + 1));
      return;
    }
    this._paintExercises(host, path, ctx, depth + 1);
  }

  _toggle(path, ctx, isLeaf) {
    if (this.expanded.has(path)) this.expanded.delete(path);
    else {
      this.expanded.add(path);
      if (isLeaf && !this.loads.has(path)) this._loadLeaf(path, ctx);
    }
    this.render();
  }

  async _loadLeaf(path, ctx) {
    const filters = filtersFor(ctx || this._ctxFor(path));
    this.loads.set(path, { state: "loading" });
    this.render();
    try {
      const data = await this.hooks.search(filters);
      this.loads.set(path, { state: "ok", rows: data.results || [], count: data.count || 0, ctx });
    } catch (e) {
      this.loads.set(path, { state: "error", error: e.message });
    }
    this.render();
  }

  /** The ctx a path resolves to, for a reload that has lost it. */
  _ctxFor(path) {
    const names = path.split("/");
    let nodes = TREE;
    let ctx = {};
    names.forEach((name) => {
      const node = (nodes || []).find((n) => n.name === name);
      if (!node) return;
      ctx = Object.assign({}, ctx, node.ctx || {});
      nodes = node.children;
    });
    return ctx;
  }

  // -- the exercises under a leaf ---------------------------------------

  _paintExercises(host, path, ctx, depth) {
    const load = this.loads.get(path);
    if (!load || load.state === "loading") {
      host.appendChild(this._note("Loading…", depth));
      return;
    }
    if (load.state === "error") {
      host.appendChild(this._note(load.error, depth, "ed-error"));
      return;
    }
    if (!load.rows.length) {
      host.appendChild(this._note("No exercises here yet.", depth));
      return;
    }

    // The two dimensions the curriculum outline leaves out, innermost last.
    // Relative exercises exist once per key, so the key is the level a teacher
    // is really choosing at this point; a progressive set then divides into
    // its parts.  Absolute exercises have no key, so they go straight to parts.
    // Off the curriculum there is no key and no part to group by — just a
    // flat list of whatever a teacher has put there.
    const levels = ctx.shelf ? []
      : (ctx.system === "absolute")
      // Absolute lessons have no key.  Their progressive step lives in `part`
      // for most families and in `grades` for the Extended span, which is the
      // distinction `absPartKey` exists to hide — without it the two octave
      // ranges of an Extended formula collapsed into one list of exercises
      // with every number in it twice.
      ? [{ of: absPartKey, label: (v) => (v ? absPartLabel(v) : null) }]
      : [
          { of: (r) => r.key_name, label: (v) => v || "—" },
          { of: (r) => r.part, label: (v) => (v ? `Part ${v}` : null) },
        ];
    this._paintGroups(host, path, load.rows, levels, depth);
  }

  /**
   * Group rows into nested levels, skipping any level that would not divide
   * them.  A formula that exists in one part only should not make the teacher
   * open a "Part" node containing everything; a level earns its place by
   * telling two exercises apart.
   */
  _paintGroups(host, path, rows, levels, depth) {
    if (!levels.length) {
      rows.forEach((row) => host.appendChild(this._exerciseRow(row, depth)));
      return;
    }
    const [level, ...rest] = levels;
    const buckets = new Map();
    rows.forEach((row) => {
      const key = level.of(row) || "";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    });
    const label = (key) => level.label(key);
    if (buckets.size <= 1 || [...buckets.keys()].every((k) => label(k) == null)) {
      this._paintGroups(host, path, rows, rest, depth);
      return;
    }

    [...buckets.entries()].forEach(([key, group]) => {
      const text = label(key);
      if (text == null) {
        this._paintGroups(host, path, group, rest, depth);
        return;
      }
      // A group of one is not a group.  Most keys hold exactly one exercise
      // of a given formula, and making the teacher open "C-dur" to reveal a
      // single row called "Diatonic" is a click that tells them nothing they
      // could not already see.  Show the exercise itself, under the name of
      // the group it was the whole of.
      if (group.length === 1) {
        host.appendChild(this._exerciseRow(group[0], depth, text));
        return;
      }
      const groupPath = `${path}::${text}`;
      const open = this.expanded.has(groupPath) || group.some((r) => this._isCurrent(r));
      const row = el("button", `ed-tree-node ed-tree-group${open ? " is-open" : ""}`);
      row.type = "button";
      row.style.setProperty("--depth", depth);
      row.appendChild(el("span", "ed-tree-twist", open ? "▾" : "▸"));
      row.appendChild(el("span", "ed-tree-name", text));
      row.appendChild(el("span", "ed-tree-count", String(group.length)));
      row.addEventListener("click", () => {
        if (this.expanded.has(groupPath)) this.expanded.delete(groupPath);
        else this.expanded.add(groupPath);
        this.render();
      });
      host.appendChild(row);
      if (open) this._paintGroups(host, groupPath, group, rest, depth + 1);
    });
  }

  _isCurrent(row) {
    return this.currentId === row.id && this.currentSystem === row.system;
  }

  _exerciseRow(row, depth, name = null) {
    const item = el("button", `ed-tree-node ed-tree-item${this._isCurrent(row) ? " is-current" : ""}`);
    item.type = "button";
    item.style.setProperty("--depth", depth);
    item.appendChild(el("span", "ed-tree-twist", ""));
    // The row sits under everything that identifies it already, so it needs
    // only what is left: which of the siblings it is, and how big it is.
    item.appendChild(el("span", "ed-tree-name", name || this._shortName(row)));
    item.appendChild(el("span", "ed-tree-count", `${row.bars}`));
    item.title = `${row.name} — ${row.bars} bar${row.bars === 1 ? "" : "s"}`;
    item.addEventListener("click", () => this.hooks.onOpen(row.system, row.id));
    return item;
  }

  /** What distinguishes this exercise from its siblings in the same group. */
  _shortName(row) {
    // Off the curriculum an exercise is only ever named by its working title.
    if (row.shelf) return row.name;
    if (row.system === "absolute") {
      const bits = [`#${row.exercise_number}`];
      if (row.exercise_type) bits.push(row.exercise_type.replace(/_/g, " "));
      return bits.join(" · ");
    }
    return row.variant || "Diatonic";
  }

  _note(text, depth, cls = "ed-hint") {
    const node = el("p", `${cls} ed-tree-note`, text);
    node.style.setProperty("--depth", depth);
    return node;
  }
}
