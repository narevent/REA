/**
 * curriculum.js — the REA method as one ordered tree.
 *
 * This module is the *outline*: it says what the method contains and in what
 * order, mirroring STRUCTURE.md.  It says nothing about how lessons are
 * fetched — every leaf simply carries the facet values that identify it, and
 * app.js writes those into its context state and runs its existing loaders.
 *
 * Shape of a node:
 *
 *   { name, ctx?, children?, kind?, parts? }
 *
 *   ctx      facet fragment, merged down the path (see CTX KEYS below)
 *   children static child nodes
 *   parts    true → this node's children are the progressive parts of its
 *            lesson set, generated at runtime (they differ per category, so
 *            they are read from the loaded lessons rather than hard-coded)
 *   kind     "doc"     → an HTML document page, no exercises
 *            "numeric" → the same lesson drawn as scale degrees, not a staff
 *            "combo"   → a combinations panel, not a single lesson
 *            omitted   → an ordinary score category
 *
 * A node with no `children` and no `parts` is a CATEGORY: the leaf a student
 * actually practises, holding the ten exercises of chapters.js.
 *
 * CTX KEYS — every one maps onto state in app.js:
 *   system     "relative" | "absolute"
 *   texture    "mono" | "poly"
 *   keyMode    "Major" | "Minor"   (which tonalities the key chip offers)
 *   formula    relative mono formula_name  (Octave / Quinta / Extended)
 *   variant    relative mono variant       ("" / AL1 / SKALA / …)
 *   category   poly category, or the absolute mono category
 *   span       absolute mono span          (Octave / Quinta / Extended)
 *   subgroup   interval_name | interval_size | inversion
 *   quality    absolute poly quality
 *   phase      absolute poly phase (1 = melodic, 2 = harmonic)
 */

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------

/** A category leaf: the thing a student practises. */
function leaf(name, ctx, kind) {
  return kind ? { name, ctx, kind } : { name, ctx };
}

/** A node whose children are the progressive parts of its lesson set. */
function parted(name, ctx) {
  return { name, ctx, parts: true };
}

// ---------------------------------------------------------------------------
// 4.1  Relative — Monophony
// ---------------------------------------------------------------------------

// The relative mono library stores the "exercise list" level as `variant`:
// no variant is the plain diatonic formula, AL1 carries the alterations, and
// SKALA is the scale form.  Formula (Octave / Quinta / Extended) is the span.
const REL_MONO_VARIANTS = {
  diatonic: "",
  alterations: "AL1",
  scale: "SKALA",
  scaleAlt: "AL1-SKALA",
};

function relMonoFormula(name, keyMode) {
  return {
    name,
    ctx: { keyMode },
    children: [
      {
        // Numeric shows the same lessons the Notal branch does, drawn as
        // scale degrees rather than on a staff — a different view of the
        // material, not a different lesson set.
        name: "Numeric",
        children: [
          leaf("Octave", { formula: "Octave", variant: REL_MONO_VARIANTS.diatonic }, "numeric"),
          leaf("Quinta", { formula: "Quinta", variant: REL_MONO_VARIANTS.diatonic }, "numeric"),
        ],
      },
      {
        name: "Notal",
        children: [
          {
            name: "Octave",
            children: [
              leaf("Diatonic", { formula: "Octave", variant: REL_MONO_VARIANTS.diatonic }),
              leaf("Alterations", { formula: "Octave", variant: REL_MONO_VARIANTS.alterations }),
            ],
          },
          {
            name: "Quinta",
            children: [
              leaf("Diatonic", { formula: "Quinta", variant: REL_MONO_VARIANTS.diatonic }),
              leaf("Alterations", { formula: "Quinta", variant: REL_MONO_VARIANTS.alterations }),
            ],
          },
          {
            name: "Scale",
            children: [
              leaf("Octave", { formula: "Octave", variant: REL_MONO_VARIANTS.scale }),
              leaf("Quinta", { formula: "Quinta", variant: REL_MONO_VARIANTS.scale }),
            ],
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 4.2  Relative — Polyphony (the tonal-trichord formula)
// ---------------------------------------------------------------------------

const REL_INTERVALS = ["Thirds", "Fourths", "Fifths", "Sixths", "Sevenths"];
const TRIAD_INVERSIONS = [["53", "5/3"], ["63", "6/3"], ["64", "6/4"]];
const SEVENTH_INVERSIONS = [["7", "7"], ["65", "6/5"], ["43", "4/3"], ["2", "2"]];

function relTTFormula(name, keyMode) {
  return {
    name,
    ctx: { keyMode },
    children: [
      {
        name: "Trichords",
        children: [parted("Formula", { category: "Formula" })],
      },
      {
        name: "Intervals",
        ctx: { category: "Intervals" },
        children: REL_INTERVALS.map((iv) => parted(iv, { subgroup: iv })),
      },
      {
        name: "Triads",
        ctx: { category: "ChordsThirds" },
        children: TRIAD_INVERSIONS.map(([v, l]) =>
          parted("Triads " + l, { subgroup: v })
        ).concat([leaf("Combinations", { category: "ComboTriads" }, "combo")]),
      },
      {
        name: "Sevenths",
        ctx: { category: "ChordsSevenths" },
        children: SEVENTH_INVERSIONS.map(([v, l]) =>
          parted("Sevenths " + l, { subgroup: v })
        ).concat([leaf("Combinations", { category: "ComboSevenths" }, "combo")]),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 4.3  Absolute — Monophony
// ---------------------------------------------------------------------------

function absMonoFormula(name, category) {
  return {
    name,
    ctx: { category },
    children: [
      parted("Octave", { span: "Octave" }),
      parted("Quinta", { span: "Quinta" }),
      // Extended's "parts" are its grade levels (2Grades / 3Grades) — the
      // loader already keys parts off `part || grades`, so one level covers it.
      parted("Extended", { span: "Extended" }),
    ],
  };
}

// ---------------------------------------------------------------------------
// 4.4  Absolute — Polyphony
// ---------------------------------------------------------------------------

// Each absolute-poly leaf runs in two pedagogical phases: I presents the
// material melodically, II harmonically.  STRUCTURE.md writes them as the
// "… I" / "… II" pair at the bottom of each branch.
function phases(ctx) {
  return [
    parted("I", Object.assign({ phase: 1 }, ctx)),
    parted("II", Object.assign({ phase: 2 }, ctx)),
  ];
}

const ABS_INTERVALS = [
  ["Seconds", "Second", ["Minor", "Major"]],
  ["Thirds", "Third", ["Minor", "Major"]],
  ["Fourths", "Fourth", ["Perfect", "Augmented"]],
  ["Fifths", "Fifth", []],
  ["Sixths", "Sixth", ["Minor", "Major"]],
  ["Sevenths", "Seventh", ["Minor", "Major"]],
  ["Eights", "Octave", []],
];

const TRIAD_QUALITIES = ["Major", "Minor", "Diminished", "Augmented"];
const SEVENTH_QUALITIES = [
  ["DominantSeventh", "Dominant"],
  ["MajorSeventh", "Major"],
  ["MinorSeventh", "Minor"],
  ["MinorMajorSeventh", "Minor major"],
  ["HalfDiminishedSeventh", "Half diminished"],
  ["DiminishedSeventh", "Diminished"],
  ["AugmentedSeventh", "Augmented"],
];

function absIntervalsNode() {
  return {
    name: "Absolute intervals",
    ctx: { category: "Intervals" },
    children: ABS_INTERVALS.map(([value, label, quals]) => ({
      name: label,
      ctx: { subgroup: value },
      // A size with a single quality (fifths, octaves) skips the quality
      // level entirely rather than showing a one-option menu.
      children: quals.length
        ? quals.map((q) => ({ name: q, ctx: { quality: q }, children: phases({}) }))
        : phases({}),
    })).concat([leaf("Combinations", { category: "ComboIntervals" }, "combo")]),
  };
}

function absChordsNode(name, category, qualities, inversions, comboCategory) {
  return {
    name,
    ctx: { category },
    children: qualities.map(([qv, ql]) => ({
      name: ql,
      ctx: { quality: qv },
      children: inversions.map(([iv, il]) => ({
        name: il,
        ctx: { subgroup: iv },
        children: phases({}),
      })),
    })).concat([leaf("Combinations", { category: comboCategory }, "combo")]),
  };
}

// ---------------------------------------------------------------------------
// The method
// ---------------------------------------------------------------------------

/** Rhythm and the dictation chapters have no lesson library behind them yet,
 *  so their leaves are typed `todo`: they hold a real place in the method's
 *  order and say plainly that they are not built, rather than being hidden
 *  and quietly changing what "next" means once they arrive. */
function soon(name) { return { name, kind: "todo" }; }

const INTONATION = [
  {
    name: "Relative",
    ctx: { system: "relative" },
    children: [
      {
        name: "Monophony",
        ctx: { texture: "mono" },
        children: [
          relMonoFormula("Major Formula", "Major"),
          relMonoFormula("Minor Formula", "Minor"),
        ],
      },
      {
        name: "Polyphony",
        ctx: { texture: "poly" },
        children: [
          relTTFormula("Major TT Formula", "Major"),
          relTTFormula("Minor TT Formula", "Minor"),
        ],
      },
    ],
  },
  {
    name: "Absolute",
    ctx: { system: "absolute" },
    children: [
      {
        name: "Monophony",
        ctx: { texture: "mono" },
        children: [
          absMonoFormula("Basic Formula", "Formula"),
          absMonoFormula("Inverse Formula", "FormulaInverse"),
        ],
      },
      {
        name: "Polyphony",
        ctx: { texture: "poly" },
        children: [
          absIntervalsNode(),
          absChordsNode(
            "Absolute triads", "ChordsThirds",
            TRIAD_QUALITIES.map((q) => [q, q]), TRIAD_INVERSIONS, "ComboTriads"
          ),
          absChordsNode(
            "Absolute sevenths", "ChordsSevenths",
            SEVENTH_QUALITIES, SEVENTH_INVERSIONS, "ComboSevenths"
          ),
        ],
      },
    ],
  },
];

const RHYTHM = [soon("Exercises")];

const DICTATES = [
  {
    name: "From literature",
    children: [
      { name: "Diatonic", children: [soon("Dur"), soon("Mol")] },
      { name: "Alterations", children: [soon("Dur"), soon("Mol")] },
      { name: "Modulations", children: [soon("Dur"), soon("Mol")] },
      soon("Modes"),
      soon("Contemporary music"),
    ],
  },
  {
    name: "Exercises and etudes",
    children: [
      {
        name: "Melodic",
        children: [
          soon("Intervals"),
          soon("Fifth chords and turns"),
          soon("Seventh chords and turns"),
        ],
      },
      {
        name: "Rhythmic",
        children: [
          soon("Binary measures"),
          soon("Ternary measures"),
          soon("Complex measures"),
        ],
      },
    ],
  },
];

const PREPARATIONS = [soon("Exercises")];

/**
 * The practice areas.  Each is a curriculum of its own — its own tree, its own
 * ordering, its own Previous/Next — so walking to the end of Intonation does
 * not spill into Rhythm.
 *
 * `teacherOnly` areas are never offered to a student; the app filters them out
 * of the area switcher and refuses to open them.
 */
export const AREAS = [
  { id: "intonation", label: "Intonation", tree: INTONATION },
  { id: "rhythm", label: "Rhythm", tree: RHYTHM },
  { id: "dictates", label: "Dictates", tree: DICTATES },
  { id: "preparations", label: "Dictate preparations", tree: PREPARATIONS, teacherOnly: true },
];

export const AREA_BY_ID = {};
AREAS.forEach((a) => { AREA_BY_ID[a.id] = a; });

// ---------------------------------------------------------------------------
// Linking — parent pointers, ids, and the ordered list of categories
// ---------------------------------------------------------------------------

/**
 * Link each area's tree independently: parent pointers, unique ids, and that
 * area's own ordered list of categories.  Ordering is per area, so Next at the
 * end of Intonation stops there rather than spilling into Rhythm.
 */
let _uid = 0;
AREAS.forEach((area) => {
  area.categories = [];
  (function link(nodes, parent) {
    nodes.forEach((node) => {
      node.parent = parent;
      node.siblings = nodes;
      node.area = area;
      node.uid = "c" + _uid++;
      if (node.children && node.children.length) link(node.children, node);
      else {
        node.pos = area.categories.length;
        area.categories.push(node);
      }
    });
  })(area.tree, null);
});

/** Root → node, inclusive. */
export function pathOf(node) {
  const out = [];
  for (let n = node; n; n = n.parent) out.unshift(n);
  return out;
}

/** The first practisable category at or below `node`. */
export function firstCategory(node) {
  let n = node;
  while (n.children && n.children.length) n = n.children[0];
  return n;
}

/**
 * The merged facet context for a category — every `ctx` fragment along its
 * path, root first, so a deeper node overrides a shallower one.
 */
export function contextFor(node) {
  const ctx = {};
  for (const n of pathOf(node)) if (n.ctx) Object.assign(ctx, n.ctx);
  return ctx;
}

/** "todo" | "numeric" | "combo" | "score" — which view a category renders. */
export function kindOf(node) {
  if (node.kind) return node.kind;
  for (const n of pathOf(node)) if (n.kind) return n.kind;
  return "score";
}

/** Which categories run the ten exercises.  A numeric category counts: it is
 *  the same lesson as its Notal twin, read as scale degrees rather than as a
 *  staff, so it practises exactly the same way.  Only the document pages are
 *  a single view. */
export function isPractisable(node) {
  const k = kindOf(node);
  return k === "score" || k === "combo" || k === "numeric";
}

/** Where an area opens: its first category that actually plays, else its
 *  first category at all (an area that is all placeholders opens on one). */
export function defaultCategory(area) {
  const list = (area && area.categories) || AREAS[0].categories;
  return list.find((c) => kindOf(c) === "score") || list[0];
}

/** Look a category up by its uid, across every area (used to restore the
 *  last position, which may have been in a different area). */
export function categoryByUid(uid) {
  for (const area of AREAS) {
    const found = area.categories.find((c) => c.uid === uid);
    if (found) return found;
  }
  return null;
}

/** The category `dir` steps away within the same area, or null at its edge. */
export function neighbourCategory(node, dir) {
  return node.area.categories[node.pos + dir] || null;
}

/** A short label for a category: its own name, prefixed by its parent when
 *  the name alone would be ambiguous ("Part 1", "I", "Diatonic"). */
export function labelFor(node) {
  const p = pathOf(node);
  return p.length > 1 ? p[p.length - 2].name + " · " + node.name : node.name;
}
