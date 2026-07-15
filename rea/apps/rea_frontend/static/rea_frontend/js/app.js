/**
 * app.js — REA frontend bootstrap.
 *
 * The whole app is about practice. The landing screen is the **chapter map**:
 * every one of the 10 practice chapters is available (none is locked). Each
 * chapter runs against the user's chosen key + lesson. The session screen is
 * the interactive practice deck.
 *
 * UI is deliberately visual-first and emoji-free: small inline SVG glyphs mark
 * each chapter type, progress is shown as rings/pips, and explanatory text is
 * kept to a minimum.
 */

import { API } from "./api.js?v=46";
import { renderLessonNotation } from "./views/lessonView.js?v=46";
import { renderScaleNotation } from "./views/scaleView.js?v=46";
import { AudioPlayer } from "./audioPlayer.js?v=46";
import { PracticeController } from "./practiceController.js?v=46";
import {
  CHAPTERS, loadProgress, saveProgress, recordSession,
  isUnlocked, completedCount, PASS_THRESHOLD,
} from "./chapters.js?v=46";

const status = document.getElementById("status");
const footerHint = document.getElementById("footer-hint");
const viewMap = document.getElementById("view-map");
const viewSession = document.getElementById("view-session");
const sessionTopbar = document.getElementById("session-topbar");
const headerStats = document.getElementById("header-stats");
const brand = document.getElementById("brand");

const DEFAULT_KEY_NAME = "C-dur";
const DEFAULT_FORMULA = "Octave";

// Formula families selectable from the chapter map.  These match the
// formula_name values stored on imported lessons (Octave / Quinta / Extended).
const FORMULAS = ["Octave", "Quinta", "Extended"];

// Intonation systems: relative (solfege, key-based) or absolute (pitch-based).
const SYSTEMS = [
  { id: "relative", label: "Relative" },
  { id: "absolute", label: "Absolute" },
];

// Absolute lesson families: category (Formula / FormulaInverse) x span.
const ABS_FAMILIES = [
  { label: "Formula · Quinta", category: "Formula", span: "Quinta" },
  { label: "Formula · Octave", category: "Formula", span: "Octave" },
  { label: "Formula · Extended", category: "Formula", span: "Extended" },
  { label: "Inverse · Quinta", category: "FormulaInverse", span: "Quinta" },
  { label: "Inverse · Octave", category: "FormulaInverse", span: "Octave" },
  { label: "Inverse · Extended", category: "FormulaInverse", span: "Extended" },
];

// Texture: monophony (melodic) vs polyphony (harmonic).  The top-level
// functional split of the app — selecting poly changes the context selectors
// and the lesson source.
const TEXTURES = [
  { id: "mono", label: "Monophony" },
  { id: "poly", label: "Polyphony" },
];

// Relative poly categories (the second context selector for relative+poly).
const REL_POLY_CATEGORIES = [
  { value: "Formula", label: "Tonal formula" },
  { value: "Intervals", label: "Intervals" },
  { value: "ChordsThirds", label: "Triads" },
  { value: "ChordsSevenths", label: "Seventh chords" },
  { value: "ComboTriads", label: "Triads · Combinations" },
  { value: "ComboSevenths", label: "Sevenths · Combinations" },
];

// Absolute poly categories (the first context selector for absolute+poly).
// The three "Combinations" categories are synthetic: they merge the bars of
// every selected subgroup option (inversion / interval+quality) across every
// selected tonality into one practice lesson — mirroring the relative-poly
// combinations.  They have no single-lesson source of their own.
const ABS_POLY_CATEGORIES = [
  { value: "Intervals", label: "Absolute intervals" },
  { value: "ChordsThirds", label: "Absolute triads" },
  { value: "ChordsSevenths", label: "Absolute sevenths" },
  { value: "ComboIntervals", label: "Intervals · Combinations" },
  { value: "ComboTriads", label: "Triads · Combinations" },
  { value: "ComboSevenths", label: "Sevenths · Combinations" },
];

/** True for any synthetic combination category (relative or absolute). */
function isComboCategory(value) {
  return value === "ComboTriads" || value === "ComboSevenths" ||
         value === "ComboIntervals";
}

/** The single-subgroup source category a combination category is built from. */
function comboBaseCategory(value) {
  if (value === "ComboTriads") return "ChordsThirds";
  if (value === "ComboSevenths") return "ChordsSevenths";
  if (value === "ComboIntervals") return "Intervals";
  return null;
}

// Poly progressive parts, ordered pedagogically (individual → cumulative).
const POLY_PART_ORDER = ["1", "2", "1-2", "3", "1-3", "4", "1-4", "4-5", "1-5"];

function polyPartLabel(key) {
  if (key === "") return "All";
  return "Part " + key;
}

function polyPartOrder(key) {
  const i = POLY_PART_ORDER.indexOf(key);
  return i >= 0 ? i : 999;
}

function computePolyParts(lessons) {
  const keys = Array.from(new Set(lessons.map((l) => l.part || "")));
  keys.sort((a, b) => polyPartOrder(a) - polyPartOrder(b));
  return keys.map((k) => ({ value: k, label: polyPartLabel(k) }));
}

// Relative poly subgroups: a second filter dimension under Category, sitting
// between Category and Part.  Intervals split by interval name; triads and
// seventh chords split by figured-bass inversion.  The tonal-formula category
// has no subgroup, so no selector is rendered for it.  The `field` names the
// serialized Lesson attribute to filter on; `options` lists the static set
// (only those actually present in the loaded lessons are offered).
const REL_POLY_SUBGROUPS = {
  Intervals: {
    field: "interval_name",
    label: "Interval",
    options: [
      { value: "Thirds", label: "Thirds" },
      { value: "Fourths", label: "Fourths" },
      { value: "Fifths", label: "Fifths" },
      { value: "Sixths", label: "Sixths" },
      { value: "Sevenths", label: "Sevenths" },
    ],
  },
  ChordsThirds: {
    field: "inversion",
    label: "Inversion",
    options: [
      { value: "53", label: "5/3" },
      { value: "63", label: "6/3" },
      { value: "64", label: "6/4" },
    ],
  },
  ChordsSevenths: {
    field: "inversion",
    label: "Inversion",
    options: [
      { value: "7", label: "7" },
      { value: "65", label: "6/5" },
      { value: "43", label: "4/3" },
      { value: "2", label: "2" },
    ],
  },
};

/** The subgroup config for a relative poly category, or null when none. */
function relPolySubgroupCfg(category) {
  return REL_POLY_SUBGROUPS[category] || null;
}

// Absolute poly subgroups: the second filter dimension under Category, sitting
// between Category and Phase.  Intervals split by interval size (Seconds ..
// Eights); triads and seventh chords split by figured-bass inversion (53/63/64
// for triads, 7/65/43/2 for sevenths).  The `field` names the serialized
// absolute Lesson attribute to filter on; `options` lists the static set
// (only those actually present in the loaded lessons are offered).
const ABS_POLY_SUBGROUPS = {
  Intervals: {
    field: "interval_size",
    label: "Interval",
    options: [
      { value: "Seconds", label: "Seconds" },
      { value: "Thirds", label: "Thirds" },
      { value: "Fourths", label: "Fourths" },
      { value: "Fifths", label: "Fifths" },
      { value: "Sixths", label: "Sixths" },
      { value: "Sevenths", label: "Sevenths" },
      { value: "Eights", label: "Octaves" },
    ],
  },
  ChordsThirds: {
    field: "inversion",
    label: "Inversion",
    options: [
      { value: "53", label: "5/3" },
      { value: "63", label: "6/3" },
      { value: "64", label: "6/4" },
    ],
  },
  ChordsSevenths: {
    field: "inversion",
    label: "Inversion",
    options: [
      { value: "7", label: "7" },
      { value: "65", label: "6/5" },
      { value: "43", label: "4/3" },
      { value: "2", label: "2" },
    ],
  },
};

/** The subgroup config for an absolute poly category, or null when none. */
function absPolySubgroupCfg(category) {
  return ABS_POLY_SUBGROUPS[category] || null;
}

// Absolute poly qualities: the per-subgroup extra dimension (interval quality
// / chord quality) sitting between Subgroup and Phase.  Intervals pick their
// qualities per interval size (Minor/Major for 2/3/6/7, Perfect/Augmented for
// 4ths; Fifths & Octaves have a single quality so no selector is rendered);
// triads and sevenths share one quality list per category.
const ABS_POLY_QUALITIES = {
  Intervals: {
    field: "quality",
    label: "Quality",
    bySubgroup: {
      Seconds: [{ value: "Minor", label: "Minor" }, { value: "Major", label: "Major" }],
      Thirds: [{ value: "Minor", label: "Minor" }, { value: "Major", label: "Major" }],
      Sixths: [{ value: "Minor", label: "Minor" }, { value: "Major", label: "Major" }],
      Sevenths: [{ value: "Minor", label: "Minor" }, { value: "Major", label: "Major" }],
      Fourths: [{ value: "Perfect", label: "Perfect" }, { value: "Augmented", label: "Augmented" }],
    },
  },
  ChordsThirds: {
    field: "quality",
    label: "Quality",
    options: [
      { value: "Major", label: "Major" },
      { value: "Minor", label: "Minor" },
      { value: "Diminished", label: "Diminished" },
      { value: "Augmented", label: "Augmented" },
    ],
  },
  ChordsSevenths: {
    field: "quality",
    label: "Quality",
    options: [
      { value: "DominantSeventh", label: "Dominant" },
      { value: "MajorSeventh", label: "Major" },
      { value: "MinorSeventh", label: "Minor" },
      { value: "MinorMajorSeventh", label: "Minor major" },
      { value: "HalfDiminishedSeventh", label: "Half diminished" },
      { value: "DiminishedSeventh", label: "Diminished" },
      { value: "AugmentedSeventh", label: "Augmented" },
    ],
  },
};

/** The quality options for an absolute poly (category, subgroup) pair,
 *  restricted to those present in the loaded lessons. */
function computeAbsPolyQualities(category, subgroup, lessons) {
  const cfg = ABS_POLY_QUALITIES[category];
  if (!cfg) return [];
  let opts;
  if (cfg.bySubgroup) opts = cfg.bySubgroup[subgroup] || [];
  else opts = cfg.options || [];
  if (!opts.length) return [];
  const present = new Set((lessons || []).map((l) => l[cfg.field] || ""));
  return opts.filter((o) => present.has(o.value));
}

/** Available subgroup options for a category, restricted to those present in
 *  the loaded lessons (so the selector never offers an empty choice).
 *  Works for both relative and absolute poly via the subgroup configs. */
function computePolySubgroups(category, lessons) {
  const cfg = relPolySubgroupCfg(category) || absPolySubgroupCfg(category);
  if (!cfg) return [];
  const present = new Set((lessons || []).map((l) => l[cfg.field] || ""));
  return cfg.options.filter((o) => present.has(o.value));
}

// ---------------------------------------------------------------------------
// Relative poly "Combinations" — multi-inversion + multi-tonality practice.
// ---------------------------------------------------------------------------

// The figured-bass inversions selectable inside each combination category,
// matching the single-inversion categories above.  The source lessons store
// one inversion per lesson; a combination merges the bars of every selected
// inversion across every selected tonality (key) into one practice lesson.
const COMBO_INVERSIONS = {
  ComboTriads: [
    { value: "53", label: "5/3" },
    { value: "63", label: "6/3" },
    { value: "64", label: "6/4" },
  ],
  ComboSevenths: [
    { value: "7", label: "7" },
    { value: "65", label: "6/5" },
    { value: "43", label: "4/3" },
    { value: "2", label: "2" },
  ],
};

// Absolute-poly combination subgroup options — the multi-select dimension
// shown instead of the single Subgroup dropdown.  Each combination selects a
// subgroup (inversion / interval size) plus a phase (I/II) plus the relevant
// qualities (interval quality / chord quality), then merges the bars of every
// selected option into one practice lesson.
const ABS_COMBO_SUBGROUPS = {
  ComboIntervals: {
    field: "interval_size",
    label: "Intervals",
    options: [
      { value: "Seconds", label: "Minor seconds", qualities: [{ value: "Minor", label: "Minor" }, { value: "Major", label: "Major" }] },
      { value: "Thirds", label: "Minor thirds", qualities: [{ value: "Minor", label: "Minor" }, { value: "Major", label: "Major" }] },
      { value: "Fourths", label: "Perfect fourths", qualities: [{ value: "Perfect", label: "Perfect" }, { value: "Augmented", label: "Augmented" }] },
      { value: "Fifths", label: "Perfect fifths", qualities: [{ value: "", label: "Perfect" }] },
      { value: "Sixths", label: "Minor sixths", qualities: [{ value: "Minor", label: "Minor" }, { value: "Major", label: "Major" }] },
      { value: "Sevenths", label: "Minor sevenths", qualities: [{ value: "Minor", label: "Minor" }, { value: "Major", label: "Major" }] },
      { value: "Eights", label: "Perfect octaves", qualities: [{ value: "", label: "Perfect" }] },
    ],
  },
  ComboTriads: {
    field: "inversion",
    label: "Inversions",
    options: [
      { value: "53", label: "major 5/3", qualities: [{ value: "Major", label: "Major" }, { value: "Minor", label: "Minor" }, { value: "Diminished", label: "Diminished" }, { value: "Augmented", label: "Augmented" }] },
      { value: "63", label: "major 6/3", qualities: [{ value: "Major", label: "Major" }, { value: "Minor", label: "Minor" }, { value: "Diminished", label: "Diminished" }, { value: "Augmented", label: "Augmented" }] },
      { value: "64", label: "major 6/4", qualities: [{ value: "Major", label: "Major" }, { value: "Minor", label: "Minor" }, { value: "Diminished", label: "Diminished" }, { value: "Augmented", label: "Augmented" }] },
    ],
  },
  ComboSevenths: {
    field: "inversion",
    label: "Inversions",
    options: [
      { value: "7", label: "dominant 7", qualities: [{ value: "DominantSeventh", label: "Dominant" }, { value: "MajorSeventh", label: "Major" }, { value: "MinorSeventh", label: "Minor" }, { value: "MinorMajorSeventh", label: "Minor major" }, { value: "HalfDiminishedSeventh", label: "Half dim." }, { value: "DiminishedSeventh", label: "Diminished" }, { value: "AugmentedSeventh", label: "Augmented" }] },
      { value: "65", label: "dominant 6/5", qualities: [{ value: "DominantSeventh", label: "Dominant" }, { value: "MajorSeventh", label: "Major" }, { value: "MinorSeventh", label: "Minor" }, { value: "MinorMajorSeventh", label: "Minor major" }, { value: "HalfDiminishedSeventh", label: "Half dim." }, { value: "DiminishedSeventh", label: "Diminished" }, { value: "AugmentedSeventh", label: "Augmented" }] },
      { value: "43", label: "dominant 4/3", qualities: [{ value: "DominantSeventh", label: "Dominant" }, { value: "MajorSeventh", label: "Major" }, { value: "MinorSeventh", label: "Minor" }, { value: "MinorMajorSeventh", label: "Minor major" }, { value: "HalfDiminishedSeventh", label: "Half dim." }, { value: "DiminishedSeventh", label: "Diminished" }, { value: "AugmentedSeventh", label: "Augmented" }] },
      { value: "2", label: "dominant 2", qualities: [{ value: "DominantSeventh", label: "Dominant" }, { value: "MajorSeventh", label: "Major" }, { value: "MinorSeventh", label: "Minor" }, { value: "MinorMajorSeventh", label: "Minor major" }, { value: "HalfDiminishedSeventh", label: "Half dim." }, { value: "DiminishedSeventh", label: "Diminished" }, { value: "AugmentedSeventh", label: "Augmented" }] },
    ],
  },
};

/** The combination subgroup config for an absolute poly combo category. */
function absComboSubgroupCfg(cat) {
  return ABS_COMBO_SUBGROUPS[cat] || null;
}

/** The flat list of selectable subgroup options for an absolute combination,
 *  restricted to those present in the loaded lessons. */
function computeAbsComboSubgroups(cat, lessons) {
  const cfg = absComboSubgroupCfg(cat);
  if (!cfg) return [];
  const present = new Set((lessons || []).map((l) => l[cfg.field] || ""));
  return cfg.options.filter((o) => present.has(o.value));
}

// Pedagogical key ordering — the circle-of-fifths-ish order shown in the
// outline (sharp side → natural → flat side).  Keys whose name isn't listed
// keep their fallback id ordering.
const KEY_ORDER = [
  "Cis-dur", "Fis-dur", "H-dur", "E-dur", "A-dur", "D-dur", "G-dur",
  "C-dur", "F-dur", "B-dur", "Es-dur", "As-dur", "Des-dur", "Ges-dur", "Ces-dur",
  "Ais-mol", "Dis-mol", "Gis-mol", "Cis-mol", "Fis-mol", "H-mol", "E-mol",
  "A-mol", "D-mol", "G-mol", "C-mol", "F-mol", "B-mol", "Es-mol", "As-mol",
];

function keyOrderKey(name) {
  const i = KEY_ORDER.indexOf(name);
  return i >= 0 ? i : 999;
}

/** Merge the bars of several lessons into one combined lesson object, in the
 *  shape the practice controller / renderer expect.  Bars are concatenated in
 *  the order lessons are given; `music_mode_chord`/`key_signature` come from
 *  the first lesson so the staff draws a key signature.  `tempo` follows the
 *  first lesson (tempoOf halves poly tempo, so playback stays comfortable).
 *  `bar_index` is renumbered to stay unique. */
/** Merge the bars of several lessons into one combined lesson object, in the
 *  shape the practice controller / renderer expect.  Bars are concatenated in
 *  the order lessons are given; `music_mode_chord`/`key_signature` come from
 *  the first lesson so the staff draws a key signature.  `tempo` follows the
 *  first lesson (tempoOf halves poly tempo, so playback stays comfortable).
 *  `bar_index` is renumbered to stay unique.  Works for both relative and
 *  absolute lessons — the absolute-specific fields (quality, interval_size,
 *  phase, exercise_*) are carried through so the info panel can label the
 *  merged lesson. */
function mergeLessons(lessons) {
  if (!lessons || !lessons.length) return null;
  const base = lessons[0];
  let idx = 0;
  const bars = [];
  for (const l of lessons) {
    for (const b of (l.bars || [])) {
      bars.push(Object.assign({}, b, { bar_index: idx++ }));
    }
  }
  return {
    id: base.id,
    key_model: base.key_model,
    key_model_name: base.key_model_name,
    key_signature: base.key_signature || [],
    texture: "poly",
    formula_name: "",
    category: base.category,
    inversion: "",
    interval_name: "",
    interval_size: base.interval_size || "",
    quality: base.quality || "",
    part: "",
    phase: base.phase || 0,
    exercise_number: base.exercise_number || 0,
    exercise_type: base.exercise_type || "",
    variant: "combinations",
    tempo: base.tempo,
    bars,
  };
}

/** Fetch all single-subgroup lessons for a relative-poly combination across
 *  every selected tonality, scoped to the selected inversions and part.  The
 *  list endpoint is summary-only (no bars), so the chosen leaves' bars are
 *  fetched in parallel via the detail endpoint and merged.  Returns the
 *  merged lesson object (or null). */
async function buildComboLesson(cat) {
  const baseCat = comboBaseCategory(cat);
  const invs = state.comboInversions.filter((v) => state.comboSelected[v]);
  const part = state.polyPart;
  const selectedKeys = state.comboKeys.filter((k) => state.comboSelected[k.id]);

  // Gather summary leaves across every selected key (parallel list fetches).
  const perKey = await Promise.all(selectedKeys.map((k) =>
    API.listPolyLessons({ keyModel: k.id, category: baseCat })));
  let lessons = [];
  perKey.forEach((got) => {
    const scoped = got.filter((l) =>
      invs.includes(l.inversion || "") && (!part || (l.part || "") === part));
    lessons = lessons.concat(scoped);
  });
  if (!lessons.length) return null;
  // Fetch the bars for every leaf in parallel (list items are summary-only).
  const seen = new Set();
  const uniq = lessons.filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)));
  const withBars = await Promise.all(uniq.map((l) => API.getLesson(l.id)));
  return mergeLessons(withBars);
}

/** Fetch the single-subgroup lessons for an absolute-poly combination across
 *  every selected subgroup option + quality + phase, scoped to the selected
 *  part.  The leaves are derived client-side from the already-cached category
 *  fetch (no per-leaf list round-trips), then their bars are fetched in
 *  parallel via the detail endpoint and merged into one practice lesson.
 *  Returns the merged lesson object (or null). */
async function buildAbsComboLesson(cat) {
  const baseCat = comboBaseCategory(cat);
  const cfg = absComboSubgroupCfg(cat);
  if (!cfg) return null;
  const part = state.polyPart;
  const selSubs = state.absComboSubgroups.filter((v) => state.absComboSelected[v]);
  const selQuals = state.absComboQualities.filter((v) => state.absComboSelected["q|" + v]);
  const selPhases = state.absComboPhases.filter((v) => state.absComboSelected["p|" + v]);

  // Filter the cached category list client-side — every selected leaf is a
  // scalar combination, so no extra list round-trips are needed.
  const all = state.polyCategoryLessons || [];
  const leaves = [];
  for (const sub of selSubs) {
    const opt = cfg.options.find((o) => o.value === sub);
    const qualsForSub = opt ? opt.qualities.map((q) => q.value) : [];
    const quals = selQuals.filter((q) => qualsForSub.includes(q));
    const useQuals = quals.length ? quals : qualsForSub;
    for (const q of useQuals) {
      for (const ph of selPhases) {
        const matched = all.filter((l) =>
          (l.category || "") === baseCat &&
          (l[cfg.field] || "") === sub &&
          (q === "" ? !l.quality : (l.quality || "") === q) &&
          (l.phase || 0) === ph &&
          (!part || (l.part || "") === part));
        leaves.push(...matched);
      }
    }
  }
  if (!leaves.length) return null;
  // Fetch the bars for every selected leaf in parallel (the list endpoint
  // is summary-only; bars come from the detail endpoint).  De-duplicate by id
  // so a leaf appearing twice (e.g. single-quality intervals) is fetched once.
  const seen = new Set();
  const uniq = leaves.filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)));
  const withBars = await Promise.all(uniq.map((l) => API.getAbsoluteLesson(l.id)));
  return mergeLessons(withBars);
}

// The chapter cards (1-10) already select the exercise type/number — the
// only extra dimension absolute lessons need is *which part* of the
// progressive sequence to practice (individual parts interleaved with their
// cumulative unions), or the Extended grade level. This mirrors the "Key"
// selector on the relative side; it must never duplicate the chapter choice.
const PART_ORDER = ["1", "2", "1-2", "3", "1-3", "4", "1-4"];
const GRADE_ORDER = ["2Grades", "3Grades"];

function absPartKey(l) { return l.part || l.grades || ""; }

function absPartLabel(key) {
  if (key === "") return "All";
  if (/^\dGrades$/.test(key)) return key.replace("Grades", " grades");
  return "Part " + key;
}

function absPartOrder(key) {
  let i = PART_ORDER.indexOf(key);
  if (i >= 0) return i;
  i = GRADE_ORDER.indexOf(key);
  if (i >= 0) return 100 + i;
  return 200;
}

function computeAbsParts(lessons) {
  const keys = Array.from(new Set(lessons.map(absPartKey)));
  keys.sort((a, b) => absPartOrder(a) - absPartOrder(b));
  return keys.map((k) => ({ value: k, label: absPartLabel(k) }));
}

const player = new AudioPlayer();

let state = {
  view: "map",
  progress: loadProgress(),
  texture: "mono",        // "mono" | "poly" — the top-level functional split
  system: "relative",
  keys: [],
  lessons: [],
  contextKey: null,
  contextFormula: DEFAULT_FORMULA,
  contextLesson: null,
  absFamily: ABS_FAMILIES[1], // Formula · Octave
  absLessons: [],
  absParts: [],
  absPart: null,
  // poly context
  polyCategory: REL_POLY_CATEGORIES[2], // Triads (relative default)
  polySubgroup: null,  // { value, label } for the relative/absolute poly subgroup (interval/inversion)
  polyQuality: null,   // { value, label } for the absolute poly quality (interval/chord quality)
  polyPhase: null,     // 1 | 2 for absolute poly (I = melodic, II = harmonic)
  polyPart: null,
  polyLessons: [],
  polyCategoryLessons: [],  // full category fetch (unscoped) for subgroup/quality options
  polyParts: [],
  _polyCatCacheKey: null,   // cache guard for the poly category fetch
  // Combinations: multi-inversion + multi-tonality selection (relative poly).
  comboInversions: [],      // inversion values available for the combo category
  comboKeys: [],            // key models available for the combo, ordered
  comboSelected: {},        // { [id|inv]: true/false } checkbox state
  // Absolute-poly combinations: multi-subgroup + multi-quality + multi-phase
  // selection.  `absComboSubgroups/Qualities/Phases` list the selectable leaf
  // values; `absComboSelected` holds the checkbox state keyed by value (subgroup
  // id), "q|<quality>" (quality), and "p|<phase>" (phase).
  absComboSubgroups: [],
  absComboQualities: [],
  absComboPhases: [],
  absComboSelected: {},
  _absComboCatKey: null,    // cache guard for the abs combo category fetch
  activeChapter: null,
};

const practice = new PracticeController({
  stage: document.getElementById("notation"),
  legend: document.getElementById("legend"),
  info: document.getElementById("info"),
  player,
  renderNotation: renderLessonNotation,
  renderKeyModelNotation: renderScaleNotation,
  getKeyModel: (id) => API.getKey(id),
  setStatus: (m) => setStatus(m),
  onSessionComplete: (chapter, avg) => onSessionComplete(chapter, avg),
});

function setStatus(msg) { status.textContent = msg; }

// ---------------------------------------------------------------------------
// Inline SVG glyphs (no emoji).  stroke=currentColor so they tint per chapter.
// ---------------------------------------------------------------------------

function glyph(name, size) {
  const s = size || 22;
  const common = 'width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  switch (name) {
    case "wave": // listening — sound wave bars
      return '<svg ' + common + '><path d="M4 12h2M8 7v10M12 4v16M16 7v10M20 12h-2"/></svg>';
    case "mic": // singing — microphone
      return '<svg ' + common + '><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/></svg>';
    case "ear": // guessing — ear
      return '<svg ' + common + '><path d="M6 10a6 6 0 0 1 12 0c0 3-2 4-3 6s-1 4-3 4-2-2-2-4"/><path d="M9 10a3 3 0 0 1 6 0"/></svg>';
    case "note": // note guessing / single note
      return '<svg ' + common + '><circle cx="7" cy="18" r="3"/><circle cx="17" cy="16" r="3"/><path d="M10 18V6l10-2v12"/></svg>';
    case "seq": // sequence — stacked notes
      return '<svg ' + common + '><circle cx="6" cy="18" r="2.2"/><circle cx="12" cy="16" r="2.2"/><circle cx="18" cy="14" r="2.2"/><path d="M8 18V8M14 16V6M20 14V4"/></svg>';
    case "check":
      return '<svg ' + common + '><path d="M5 12l5 5L20 7"/></svg>';
    case "dot":
      return '<svg ' + common + '><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/></svg>';
    case "play":
      return '<svg ' + common + ' fill="currentColor" stroke="none"><path d="M7 5l12 7-12 7z"/></svg>';
    case "stop":
      return '<svg ' + common + ' fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    case "back":
      return '<svg ' + common + '><path d="M15 6l-6 6 6 6"/></svg>';
    case "flame":
      return '<svg ' + common + '><path d="M12 3c4 4 5 7 3 11-1 2-3 3-3 3s-2-1-3-3c-2-4-1-7 3-11z"/><path d="M12 21c-3 0-5-2-5-5 0-1 1-2 2-2"/></svg>';
    default:
      return '<svg ' + common + '><circle cx="12" cy="12" r="8"/></svg>';
  }
}

// ---------------------------------------------------------------------------
// Keys + lessons
// ---------------------------------------------------------------------------

async function loadKeys() {
  setStatus("Loading keys…");
  const data = await API.listKeys();
  state.keys = data.results || data;
  const dk = state.keys.find((k) => k.name === DEFAULT_KEY_NAME) || state.keys[0];
  if (dk) state.contextKey = dk;
  setStatus("Ready");
}

async function ensureLesson() {
  if (state.texture === "poly") return ensurePolyLesson();
  if (state.system === "absolute") return ensureAbsoluteLesson();
  if (!state.contextKey) return;
  setStatus("Loading lesson…");
  const formula = state.contextFormula || DEFAULT_FORMULA;
  const data = await API.listLessons({ keyModel: state.contextKey.id, formula, texture: "mono" });
  state.lessons = data.results || data;
  if (!state.lessons.length) {
    // The chosen formula has no lesson for this key; keep the previous lesson
    // if any so the app stays usable, and warn the user.
    if (!state.contextLesson) setStatus("No lessons for " + formula + " in " + state.contextKey.name + ".");
    else setStatus("No lessons for " + formula + " in " + state.contextKey.name + " — showing " + state.contextLesson.formula_name + ".");
    return;
  }
  state.contextLesson = state.lessons.find((l) => !l.variant) || state.lessons[0];
  state.contextLesson = await API.getLesson(state.contextLesson.id);
  state.contextLesson.system = "relative";
  setStatus("Ready");
}

/**
 * Load a polyphonic lesson for the current context.
 *
 *   relative poly  → key + category + part
 *   absolute poly  → category + part
 *
 * The chapter cards (1-10) select the exercise type/number on the absolute
 * side; for relative poly every lesson in the selection is equivalent across
 * chapters, so we just pick the first.
 */
async function ensurePolyLesson() {
  if (state.system === "relative") return ensureRelPolyLesson();
  return ensureAbsPolyLesson();
}

async function ensureRelPolyLesson() {
  const cat = state.polyCategory ? state.polyCategory.value : "";
  if (isComboCategory(cat)) return ensureComboLesson(cat);
  if (!state.contextKey) return;
  setStatus("Loading poly lesson…");
  const cfg = relPolySubgroupCfg(cat);

  // 1. Fetch the whole category for this key (paginated-safe) so we can
  //    offer a complete subgroup list.  Cache it so switching subgroup or
  //    part doesn't re-fetch the category each time.
  const cacheKey = state.contextKey.id + "|" + cat;
  if (state._polyCatCacheKey !== cacheKey) {
    state.polyCategoryLessons = await API.listPolyLessons({ keyModel: state.contextKey.id, category: cat });
    state._polyCatCacheKey = cacheKey;
  }
  const all = state.polyCategoryLessons;

  // 2. Resolve / validate the subgroup from the full category set.
  const subgroups = computePolySubgroups(cat, all);
  if (cfg) {
    if (!subgroups.find((s) => s.value === (state.polySubgroup && state.polySubgroup.value))) {
      state.polySubgroup = subgroups[0] || null;
    }
  } else {
    state.polySubgroup = null;
  }

  // 3. Scope the lesson set to the chosen subgroup.  Client-side filtering is
  //    safe here because `all` already holds every lesson for the category.
  let lessons = all;
  if (cfg && state.polySubgroup) {
    const sv = state.polySubgroup.value;
    lessons = all.filter((l) => (l[cfg.field] || "") === sv);
  }

  state.polyLessons = lessons;
  state.polyParts = computePolyParts(lessons);
  if (!state.polyParts.find((p) => p.value === state.polyPart)) {
    state.polyPart = state.polyParts[0] ? state.polyParts[0].value : null;
  }
  const inPart = state.polyLessons.filter((l) => (l.part || "") === state.polyPart);
  const pool = inPart.length ? inPart : state.polyLessons;
  if (!pool.length) {
    state.contextLesson = null;
    setStatus("No poly lessons for " + cat + " in " + state.contextKey.name + ".");
    return;
  }
  state.contextLesson = await API.getLesson(pool[0].id);
  state.contextLesson.system = "relative";
  setStatus("Ready");
}

/**
 * Build + load a relative-poly combination lesson.
 *
 * Combinations merge the bars of every selected inversion across every
 * selected tonality (key), scoped to the selected part, into one practice
 * lesson.  The inversion/tonality selectors are multi-select (checkboxes);
 * a sensible default (all inversions + the current key) is chosen on first
 * entry.  Parts are derived from the base category so the Part selector
 * keeps working.
 */
async function ensureComboLesson(cat) {
  setStatus("Loading combinations…");
  const baseCat = comboBaseCategory(cat);
  if (!state.comboInversions.length) state.comboInversions = (COMBO_INVERSIONS[cat] || []).map((o) => o.value);

  // Initialise the available tonalities once, in pedagogical order.
  if (!state.comboKeys.length) {
    state.comboKeys = state.keys.slice().sort((a, b) => keyOrderKey(a.name) - keyOrderKey(b.name));
  }

  // Defaults: all inversions selected, the current key selected the first
  // time we enter (the user adds more tonalities via the checkboxes).
  if (!Object.keys(state.comboSelected).length) {
    for (const inv of state.comboInversions) state.comboSelected[inv] = true;
    const cur = state.contextKey;
    if (cur) state.comboSelected[cur.id] = true;
    else if (state.comboKeys[0]) state.comboSelected[state.comboKeys[0].id] = true;
  }

  // Derive the part list from a single representative key+inversion so the
  // Part selector stays meaningful (parts are uniform across inversions/keys).
  const invs = state.comboInversions.filter((v) => state.comboSelected[v]);
  let repKey = state.comboKeys.find((k) => state.comboSelected[k.id]) || state.contextKey || state.comboKeys[0] || null;
  state.polyParts = [];
  if (repKey && invs.length) {
    const rep = await API.listPolyLessons({ keyModel: repKey.id, category: baseCat });
    const scoped = rep.filter((l) => invs.includes(l.inversion || ""));
    state.polyParts = computePolyParts(scoped);
  }
  if (!state.polyParts.find((p) => p.value === state.polyPart)) {
    state.polyPart = state.polyParts[0] ? state.polyParts[0].value : null;
  }

  // Build the merged lesson across every selected key + inversion.
  const merged = await buildComboLesson(cat);
  if (!merged) {
    state.contextLesson = null;
    state.polyLessons = [];
    setStatus("No combinations for the selected inversions / tonalities.");
    return;
  }
  merged.system = "relative";
  state.contextLesson = merged;
  state.polyLessons = [];  // combinations aren't a single-lesson list
  setStatus("Ready");
}

async function ensureAbsPolyLesson() {
  const cat = state.polyCategory ? state.polyCategory.value : "";
  if (isComboCategory(cat)) return ensureAbsComboLesson(cat);
  setStatus("Loading poly exercises…");
  const cfg = absPolySubgroupCfg(cat);

  // 1. Fetch the whole category once (paginated-safe) so we can offer
  //    complete subgroup + quality option lists.  Cache it per category.
  const cacheKey = cat;
  if (state._polyCatCacheKey !== cacheKey) {
    state.polyCategoryLessons = await API.listAbsolutePolyLessons({ category: cat });
    state._polyCatCacheKey = cacheKey;
  }
  const all = state.polyCategoryLessons;
  if (!all.length) {
    state.polyParts = [];
    state.polyPart = null;
    state.contextLesson = null;
    setStatus("No poly exercises for " + cat + ".");
    return;
  }

  // 2. Resolve / validate the subgroup from the full category set.
  const subgroups = computePolySubgroups(cat, all);
  if (cfg) {
    if (!subgroups.find((s) => s.value === (state.polySubgroup && state.polySubgroup.value))) {
      state.polySubgroup = subgroups[0] || null;
    }
  } else {
    state.polySubgroup = null;
  }

  // 3. Scope to the chosen subgroup (client-side; `all` holds the category).
  let lessons = all;
  if (cfg && state.polySubgroup) {
    const sv = state.polySubgroup.value;
    lessons = all.filter((l) => (l[cfg.field] || "") === sv);
  }

  // 4. Resolve / validate the quality (interval/chord quality) within the
  //    subgroup.  Categories with a single quality (Fifths, Octaves) yield
  //    no options → no selector is rendered and quality stays null.
  const sgVal = state.polySubgroup ? state.polySubgroup.value : "";
  const qualities = computeAbsPolyQualities(cat, sgVal, lessons);
  if (qualities.length) {
    if (!qualities.find((q) => q.value === (state.polyQuality && state.polyQuality.value))) {
      state.polyQuality = qualities[0] || null;
    }
  } else {
    state.polyQuality = null;
  }
  if (state.polyQuality) {
    const qv = state.polyQuality.value;
    lessons = lessons.filter((l) => (l.quality || "") === qv);
  }

  // 5. Resolve / validate the phase (I = melodic / phase 1, II = harmonic /
  //    phase 2).  Default to phase 1 (I) on first entry.
  const phases = Array.from(new Set(lessons.map((l) => l.phase || 0))).filter((p) => p).sort();
  if (phases.length && !phases.includes(state.polyPhase)) {
    state.polyPhase = phases[0];
  }
  if (state.polyPhase) {
    lessons = lessons.filter((l) => (l.phase || 0) === state.polyPhase);
  }

  state.polyLessons = lessons;
  state.polyParts = computePolyParts(lessons);
  if (!state.polyParts.find((p) => p.value === state.polyPart)) {
    state.polyPart = state.polyParts[0] ? state.polyParts[0].value : null;
  }
  const chapterId = (state.activeChapter && state.activeChapter.id) || 1;
  await pickAbsPolyLesson(chapterId);
  setStatus("Ready");
}

/** Pick the absolute poly lesson matching the current subgroup/quality/phase/
 *  part + chapter (exercise number).  Falls back to the first lesson in the
 *  current part when the exact chapter isn't available.  The list endpoint is
 *  summary-only (no bars), so the chosen lesson is fetched in full from the
 *  detail endpoint.  Returns true iff an exact match for `chapterId` was
 *  found. */
async function pickAbsPolyLesson(chapterId) {
  const inPart = state.polyLessons.filter((l) => (l.part || "") === state.polyPart);
  const chosen = inPart.find((l) => l.exercise_number === chapterId) ||
    inPart[0] || state.polyLessons[0] || null;
  if (!chosen) {
    state.contextLesson = null;
    return false;
  }
  // Fetch the full lesson (with bars) — list items are summary-only.
  state.contextLesson = await API.getAbsoluteLesson(chosen.id);
  state.contextLesson.system = "absolute";
  return chosen.exercise_number === chapterId;
}

/**
 * Build + load an absolute-poly combination lesson.
 *
 * Absolute combinations merge the bars of every selected subgroup option
 * (inversion / interval size) × quality × phase, scoped to the selected part,
 * into one practice lesson.  The subgroup/quality/phase selectors are
 * multi-select (checkboxes); sensible defaults (all subgroups, all qualities,
 * phase I) are chosen on first entry.  Parts are derived from the base
 * category so the Part selector keeps working.
 */
async function ensureAbsComboLesson(cat) {
  setStatus("Loading combinations…");
  const baseCat = comboBaseCategory(cat);
  const cfg = absComboSubgroupCfg(cat);
  if (!cfg) { state.contextLesson = null; return; }

  // Fetch the base category once for option/part derivation (cached).
  const cacheKey = cat;
  if (state._absComboCatKey !== cacheKey) {
    state.polyCategoryLessons = await API.listAbsolutePolyLessons({ category: baseCat });
    state._absComboCatKey = cacheKey;
  }
  const all = state.polyCategoryLessons;

  // Available subgroup options (restricted to those present in the data).
  state.absComboSubgroups = computeAbsComboSubgroups(cat, all);
  // Available qualities = union of every subgroup option's qualities.
  const qualSet = new Set();
  for (const o of cfg.options) for (const q of o.qualities) qualSet.add(q.value);
  state.absComboQualities = Array.from(qualSet);
  // Available phases (I / II).
  state.absComboPhases = Array.from(new Set(all.map((l) => l.phase || 0))).filter((p) => p).sort();

  // Defaults on first entry: all subgroups, all qualities, phase I only.
  if (!Object.keys(state.absComboSelected).length) {
    for (const v of state.absComboSubgroups) state.absComboSelected[v] = true;
    for (const q of state.absComboQualities) state.absComboSelected["q|" + q] = true;
    for (const p of state.absComboPhases) state.absComboSelected["p|" + p] = (p === 1);
  }

  // Derive the part list from the base category so the Part selector stays
  // meaningful (parts are uniform across subgroup/quality/phase).
  state.polyParts = computePolyParts(all);
  if (!state.polyParts.find((p) => p.value === state.polyPart)) {
    state.polyPart = state.polyParts[0] ? state.polyParts[0].value : null;
  }

  // Build the merged lesson across every selected subgroup × quality × phase.
  const merged = await buildAbsComboLesson(cat);
  if (!merged) {
    state.contextLesson = null;
    state.polyLessons = [];
    setStatus("No combinations for the selected subgroups / qualities / phases.");
    return;
  }
  merged.system = "absolute";
  state.contextLesson = merged;
  state.polyLessons = [];  // combinations aren't a single-lesson list
  setStatus("Ready");
}

async function ensureAbsoluteLesson() {
  setStatus("Loading exercises…");
  const fam = state.absFamily;
  state.absLessons = await API.listAbsoluteLessons({ category: fam.category, span: fam.span });
  if (!state.absLessons.length) {
    state.absParts = [];
    state.absPart = null;
    state.contextLesson = null;
    setStatus("No absolute exercises for " + fam.label + ".");
    return;
  }
  state.absParts = computeAbsParts(state.absLessons);
  if (!state.absParts.find((p) => p.value === state.absPart)) {
    state.absPart = state.absParts[0].value;
  }
  const chapterId = (state.activeChapter && state.activeChapter.id) || 1;
  await pickAbsLesson(chapterId);
  setStatus("Ready");
}

/**
 * Select the absolute lesson matching the current family/part and the given
 * chapter (exercise number). Falls back to any lesson in the current part
 * when that exact chapter isn't available for this family (e.g. Extended
 * families only cover chapters 3-10). Returns true iff an exact match for
 * `chapterId` was found.
 */
async function pickAbsLesson(chapterId) {
  const inPart = state.absLessons.filter((l) => absPartKey(l) === state.absPart);
  const chosen = inPart.find((l) => l.exercise_number === chapterId) ||
    inPart[0] || state.absLessons[0] || null;
  if (!chosen) { state.contextLesson = null; return false; }
  // Fetch the full lesson (with bars) — list items are summary-only.
  state.contextLesson = await API.getAbsoluteLesson(chosen.id);
  state.contextLesson.system = "absolute";
  return chosen.exercise_number === chapterId;
}

async function setSystem(systemId) {
  if (!systemId || systemId === state.system) return;
  state.system = systemId;
  state.contextLesson = null;
  // The poly category list differs per system; reset to that system's default.
  if (state.texture === "poly") {
    state.polyCategory = (systemId === "absolute" ? ABS_POLY_CATEGORIES[0] : REL_POLY_CATEGORIES[2]);
    state.polySubgroup = null;
    state.polyQuality = null;
    state.polyPhase = null;
    state.polyPart = null;
    state._polyCatCacheKey = null;
    resetComboSelection();
    resetAbsComboSelection();
  }
  await ensureLesson();
}

async function setAbsFamily(index) {
  const fam = ABS_FAMILIES[index];
  if (!fam) return;
  state.absFamily = fam;
  state.absPart = null;
  await ensureLesson();
}

function setAbsPart(value) {
  if (!value && value !== "") return;
  state.absPart = value;
  const chapterId = (state.activeChapter && state.activeChapter.id) || 1;
  pickAbsLesson(chapterId);  // async; renders on next interaction
}

async function setKey(keyId) {
  const k = state.keys.find((x) => String(x.id) === String(keyId));
  if (!k) return;
  state.contextKey = k;
  state._polyCatCacheKey = null;  // relative category fetch is per-key; invalidate
  await ensureLesson();
}

async function setFormula(formula) {
  if (!formula) return;
  state.contextFormula = formula;
  await ensureLesson();
}

async function setTexture(textureId) {
  if (!textureId || textureId === state.texture) return;
  state.texture = textureId;
  state.contextLesson = null;
  // Pick a sensible default poly category per system when entering poly.
  if (textureId === "poly") {
    state.polyCategory = (state.system === "absolute" ? ABS_POLY_CATEGORIES[0] : REL_POLY_CATEGORIES[2]);
    state.polySubgroup = null;
    state.polyQuality = null;
    state.polyPhase = null;
    state.polyPart = null;
    state._polyCatCacheKey = null;
    resetComboSelection();
    resetAbsComboSelection();
  }
  await ensureLesson();
}

async function setPolyCategory(value) {
  const list = state.system === "absolute" ? ABS_POLY_CATEGORIES : REL_POLY_CATEGORIES;
  const cat = list.find((c) => c.value === value);
  if (!cat) return;
  state.polyCategory = cat;
  state.polySubgroup = null;
  state.polyQuality = null;
  state.polyPhase = null;
  state.polyPart = null;
  state._polyCatCacheKey = null;  // force a fresh category fetch
  // Entering / leaving a combination resets its selections.
  if (isComboCategory(value)) {
    resetComboSelection();
    resetAbsComboSelection();
  }
  await ensureLesson();
}

async function setComboInversion(value, checked) {
  state.comboSelected[value] = !!checked;
  state.polyPart = null;
  await ensureRelPolyLesson();
}

async function setComboKey(keyId, checked) {
  state.comboSelected[keyId] = !!checked;
  state.polyPart = null;
  await ensureRelPolyLesson();
}

/** Clear all relative-combination selection state (category/texture/system change). */
function resetComboSelection() {
  state.comboInversions = [];
  state.comboKeys = [];
  state.comboSelected = {};
}

/** Clear all absolute-combination selection state (category/texture/system change). */
function resetAbsComboSelection() {
  state.absComboSubgroups = [];
  state.absComboQualities = [];
  state.absComboPhases = [];
  state.absComboSelected = {};
  state._absComboCatKey = null;
}

async function setPolySubgroup(value) {
  if (state.texture !== "poly") return;
  const cat = state.polyCategory ? state.polyCategory.value : "";
  const subgroups = computePolySubgroups(cat, state.polyCategoryLessons);
  const sg = subgroups.find((s) => s.value === value);
  if (!sg) return;
  state.polySubgroup = sg;
  // A subgroup change invalidates the quality (interval/chord quality) and
  // the part; phase persists within a category.
  state.polyQuality = null;
  state.polyPart = null;
  if (state.system === "absolute") await ensureAbsPolyLesson();
  else await ensureRelPolyLesson();
}

async function setPolyQuality(value) {
  // Only absolute poly has a quality selector.
  if (state.system !== "absolute" || state.texture !== "poly") return;
  const cat = state.polyCategory ? state.polyCategory.value : "";
  const sgVal = state.polySubgroup ? state.polySubgroup.value : "";
  const qualities = computeAbsPolyQualities(cat, sgVal, state.polyCategoryLessons);
  const q = qualities.find((x) => x.value === value);
  if (!q) return;
  state.polyQuality = q;
  state.polyPart = null;
  await ensureAbsPolyLesson();
}

async function setPolyPhase(value) {
  // Only absolute poly has a phase selector.
  if (state.system !== "absolute" || state.texture !== "poly") return;
  const ph = parseInt(value, 10);
  if (!ph) return;
  state.polyPhase = ph;
  await ensureAbsPolyLesson();
}

async function setAbsComboSubgroup(value, checked) {
  state.absComboSelected[value] = !!checked;
  state.polyPart = null;
  await ensureAbsComboLesson(state.polyCategory ? state.polyCategory.value : "");
}

async function setAbsComboQuality(value, checked) {
  state.absComboSelected["q|" + value] = !!checked;
  state.polyPart = null;
  await ensureAbsComboLesson(state.polyCategory ? state.polyCategory.value : "");
}

async function setAbsComboPhase(value, checked) {
  state.absComboSelected["p|" + value] = !!checked;
  state.polyPart = null;
  await ensureAbsComboLesson(state.polyCategory ? state.polyCategory.value : "");
}

function setPolyPart(value) {
  if (!value && value !== "") return;
  state.polyPart = value;
  if (state.texture === "poly" && state.system === "absolute") {
    const cat = state.polyCategory ? state.polyCategory.value : "";
    if (isComboCategory(cat)) {
      ensureAbsComboLesson(cat);
    } else {
      const chapterId = (state.activeChapter && state.activeChapter.id) || 1;
      pickAbsPolyLesson(chapterId);  // async; renders on next interaction
    }
  } else if (state.texture === "poly") {
    // Relative poly (single or combo) — ensureRelPolyLesson delegates to
    // ensureComboLesson for combination categories.
    ensureRelPolyLesson();
  }
}

// ---------------------------------------------------------------------------
// Header stats
// ---------------------------------------------------------------------------

function renderHeader() {
  const p = state.progress;
  const done = completedCount(p);
  headerStats.innerHTML =
    '<div class="hstat"><span class="hstat-num">' + done + "/" + CHAPTERS.length + '</span><span class="hstat-lbl">chapters</span></div>' +
    '<div class="hstat"><span class="hstat-num">' + p.xp + '</span><span class="hstat-lbl">XP</span></div>' +
    (p.streak >= 2 ? '<div class="hstat streak"><span class="hstat-ico">' + glyph("flame", 16) + '</span><span class="hstat-num">' + p.streak + '</span><span class="hstat-lbl">streak</span></div>' : "");
}

// ---------------------------------------------------------------------------
// Chapter map (landing) — visual, emoji-free, nothing locked
// ---------------------------------------------------------------------------

function renderMap() {
  const p = state.progress;
  const done = completedCount(p);
  const pct = Math.round((done / CHAPTERS.length) * 100);

  const cards = CHAPTERS.map((c) => {
    const entry = p.chapters[c.id];
    const best = entry ? entry.best : null;
    const completed = entry && entry.completed;
    const attempts = entry ? entry.attempts : 0;

    const scoreRing = best == null ? '<div class="card-score empty">' + glyph("dot", 18) + '</div>' :
      '<div class="card-score">' +
        '<div class="ring">' +
          '<svg viewBox="0 0 36 36"><circle class="ring-bg" cx="18" cy="18" r="15.5"></circle>' +
          '<circle class="ring-fg" cx="18" cy="18" r="15.5" style="stroke-dashoffset:' + ringOffset(best) + '"></circle></svg>' +
          '<span class="ring-val">' + best + '</span>' +
        '</div>' +
      '</div>';

    const badge = completed
      ? '<span class="card-badge done">' + glyph("check", 14) + '</span>'
      : attempts
        ? '<span class="card-badge try"></span>'
        : "";

    return '<button class="chapter-card' + (completed ? " completed" : "") + '" ' +
      'style="--cc:' + c.color + '" data-chapter="' + c.id + '">' +
      badge +
      '<div class="card-head">' +
        '<span class="card-ico">' + glyph(c.glyph, 24) + '</span>' +
        scoreRing +
      '</div>' +
      '<div class="card-title">' + c.title + '</div>' +
      '<div class="card-foot">' +
        '<div class="card-dots">' + dots(c.difficulty) + '</div>' +
        (c.tags.includes("mic") ? '<span class="card-tag mic">mic</span>' : '') +
        (c.tags.includes("timed") ? '<span class="card-tag timed">timed</span>' : '') +
      '</div>' +
      '</button>';
  }).join("");

  viewMap.innerHTML =
    '<div class="map-wrap">' +
      '<div class="map-hero">' +
        '<div class="hero-left">' +
          '<h2>Solfege practice</h2>' +
          '<p>Ten chapters. Train ear and voice for relative intonation.</p>' +
        '</div>' +
        '<div class="hero-progress">' +
          '<div class="hero-ring">' +
            '<svg viewBox="0 0 120 120">' +
              '<circle class="hr-bg" cx="60" cy="60" r="52"></circle>' +
              '<circle class="hr-fg" cx="60" cy="60" r="52" style="stroke-dashoffset:' + ringOffset(pct, 52) + '"></circle>' +
            '</svg>' +
            '<div class="hr-text"><b>' + done + '</b><span>/' + CHAPTERS.length + '</span></div>' +
          '</div>' +
          '<div class="hero-meta"><span>' + pct + '%</span><span>' + state.progress.xp + ' XP</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="chapter-grid">' + cards + '</div>' +
      '<div class="map-foot">' +
        '<label class="ctx-select"><span class="ctx-lbl">Texture</span>' +
          '<select id="map-texture">' + TEXTURES.map((t) =>
            '<option value="' + t.id + '"' + (state.texture === t.id ? " selected" : "") + ">" + t.label + "</option>"
          ).join("") + '</select>' +
        '</label>' +
        '<label class="ctx-select"><span class="ctx-lbl">System</span>' +
          '<select id="map-system">' + SYSTEMS.map((s) =>
            '<option value="' + s.id + '"' + (state.system === s.id ? " selected" : "") + ">" + s.label + "</option>"
          ).join("") + '</select>' +
        '</label>' +
        contextSelectorsHTML() +
        '<button id="reset-progress" class="link-btn">reset progress</button>' +
      '</div>' +
    '</div>';

  viewMap.querySelectorAll(".chapter-card").forEach((card) => {
    card.addEventListener("click", () => openChapter(parseInt(card.dataset.chapter, 10)));
  });
  const textureSel = viewMap.querySelector("#map-texture");
  if (textureSel) textureSel.addEventListener("change", async () => {
    await setTexture(textureSel.value);
    renderHeader();
    renderMap();
  });
  const systemSel = viewMap.querySelector("#map-system");
  if (systemSel) systemSel.addEventListener("change", async () => {
    await setSystem(systemSel.value);
    renderHeader();
    renderMap();
  });
  const keySel = viewMap.querySelector("#map-key");
  if (keySel) keySel.addEventListener("change", async () => {
    await setKey(keySel.value);
    renderHeader();
    renderMap();
  });
  const formulaSel = viewMap.querySelector("#map-formula");
  if (formulaSel) formulaSel.addEventListener("change", async () => {
    await setFormula(formulaSel.value);
    renderHeader();
    renderMap();
  });
  const familySel = viewMap.querySelector("#map-family");
  if (familySel) familySel.addEventListener("change", async () => {
    await setAbsFamily(parseInt(familySel.value, 10));
    renderHeader();
    renderMap();
  });
  const partSel = viewMap.querySelector("#map-part");
  if (partSel) partSel.addEventListener("change", () => {
    setAbsPart(partSel.value);
    renderHeader();
    renderMap();
  });
  const polyCatSel = viewMap.querySelector("#map-poly-category");
  if (polyCatSel) polyCatSel.addEventListener("change", async () => {
    await setPolyCategory(polyCatSel.value);
    renderHeader();
    renderMap();
  });
  const polySubSel = viewMap.querySelector("#map-poly-subgroup");
  if (polySubSel) polySubSel.addEventListener("change", async () => {
    await setPolySubgroup(polySubSel.value);
    renderHeader();
    renderMap();
  });
  const polyQualSel = viewMap.querySelector("#map-poly-quality");
  if (polyQualSel) polyQualSel.addEventListener("change", async () => {
    await setPolyQuality(polyQualSel.value);
    renderHeader();
    renderMap();
  });
  const polyPhaseSel = viewMap.querySelector("#map-poly-phase");
  if (polyPhaseSel) polyPhaseSel.addEventListener("change", async () => {
    await setPolyPhase(polyPhaseSel.value);
    renderHeader();
    renderMap();
  });
  const polyPartSel = viewMap.querySelector("#map-poly-part");
  if (polyPartSel) polyPartSel.addEventListener("change", () => {
    setPolyPart(polyPartSel.value);
    renderHeader();
    renderMap();
  });
  // Combinations: inversion + tonality checkboxes (relative poly).
  viewMap.querySelectorAll('input[id^="map-combo-inv-"]').forEach((chk) => {
    chk.addEventListener("change", async () => {
      setComboInversion(chk.id.replace("map-combo-inv-", ""), chk.checked);
      renderHeader();
      renderMap();
      reopenComboPanel("map");
    });
  });
  viewMap.querySelectorAll('input[id^="map-combo-key-"]').forEach((chk) => {
    chk.addEventListener("change", async () => {
      setComboKey(chk.id.replace("map-combo-key-", ""), chk.checked);
      renderHeader();
      renderMap();
      reopenComboPanel("map");
    });
  });
  // Absolute-poly combinations: subgroup + quality + phase checkboxes.
  viewMap.querySelectorAll('input[id^="map-abscombo-sub-"]').forEach((chk) => {
    chk.addEventListener("change", async () => {
      await setAbsComboSubgroup(chk.id.replace("map-abscombo-sub-", ""), chk.checked);
      renderHeader();
      renderMap();
      reopenComboPanel("map");
    });
  });
  viewMap.querySelectorAll('input[id^="map-abscombo-q-"]').forEach((chk) => {
    chk.addEventListener("change", async () => {
      await setAbsComboQuality(chk.id.replace("map-abscombo-q-", ""), chk.checked);
      renderHeader();
      renderMap();
      reopenComboPanel("map");
    });
  });
  viewMap.querySelectorAll('input[id^="map-abscombo-p-"]').forEach((chk) => {
    chk.addEventListener("change", async () => {
      await setAbsComboPhase(chk.id.replace("map-abscombo-p-", ""), chk.checked);
      renderHeader();
      renderMap();
      reopenComboPanel("map");
    });
  });
  wireComboPopover("map", viewMap);
  const reset = viewMap.querySelector("#reset-progress");
  if (reset) reset.addEventListener("click", () => {
    if (confirm("Reset all chapter progress?")) {
      state.progress = { chapters: {}, xp: 0, streak: 0, lastPlayedChapter: null };
      saveProgress(state.progress);
      renderHeader();
      renderMap();
    }
  });
}

/**
 * Build the context-selector HTML for the current (texture, system):
 *   mono + relative  → Key + Formula
 *   mono + absolute  → Family + Part
 *   poly + relative  → Key + Category + Part
 *   poly + absolute  → Category + Part
 */
/** Build the multi-select inversion + tonality checkboxes for a combination
 *  category.  `prefix` is "map" (chapter map) or "ctx" (session topbar) so the
 *  checkbox ids are unique per location. */
/** Build the combination controls for a combination category.
 *
 *  Inversions (3–4) render as compact inline pill checkboxes — they fit the
 *  existing context-selector row.  Tonalities (30 keys) are too many for an
 *  inline list, so they live behind a compact "Tonality" trigger button that
 *  opens a small popover panel (grouped Major/Minor + All/None quick actions,
 *  click-outside to close).  `prefix` is "map" (chapter map) or "ctx" (session
 *  topbar) so element ids stay unique per location.
 */

/** Build the combination controls for an absolute-poly combination category.
 *
 *  Absolute combinations expose three multi-select dimensions: subgroup
 *  (inversion / interval size), quality (interval/chord quality), and phase
 *  (I/II).  Each renders as compact inline pill checkboxes reusing the same
 *  combo styles as the relative combinations.  `prefix` is "map" or "ctx".
 */
function absComboSelectorsHTML(prefix) {
  const cat = state.polyCategory ? state.polyCategory.value : "";
  const cfg = absComboSubgroupCfg(cat);
  if (!cfg) return "";
  const subOpts = computeAbsComboSubgroups(cat, state.polyCategoryLessons);
  const subHtml = subOpts.map((o) => {
    const checked = state.absComboSelected[o.value] ? " checked" : "";
    return '<label class="combo-chk"><input type="checkbox" id="' + prefix +
      '-abscombo-sub-' + o.value + '"' + checked + '><span>' + o.label + "</span></label>";
  }).join("");

  // Qualities — the union of every subgroup option's qualities, labelled.
  const qualCfg = ABS_POLY_QUALITIES[comboBaseCategory(cat)];
  const qualLabelMap = {};
  if (qualCfg) {
    if (qualCfg.options) for (const q of qualCfg.options) qualLabelMap[q.value] = q.label;
    else for (const k in qualCfg.bySubgroup) for (const q of qualCfg.bySubgroup[k]) qualLabelMap[q.value] = q.label;
  }
  const qualHtml = state.absComboQualities.map((v) => {
    if (v === "") return "";  // single-quality leaves (Fifths/Octaves) have no checkbox
    const checked = state.absComboSelected["q|" + v] ? " checked" : "";
    return '<label class="combo-chk"><input type="checkbox" id="' + prefix +
      '-abscombo-q-' + v + '"' + checked + '><span>' + (qualLabelMap[v] || v) + "</span></label>";
  }).join("");

  const phaseHtml = state.absComboPhases.map((v) => {
    const checked = state.absComboSelected["p|" + v] ? " checked" : "";
    const lbl = v === 1 ? "I (melodic)" : "II (harmonic)";
    return '<label class="combo-chk"><input type="checkbox" id="' + prefix +
      '-abscombo-p-' + v + '"' + checked + '><span>' + lbl + "</span></label>";
  }).join("");

  return '<div class="combo-selectors">' +
    '<div class="combo-col"><span class="ctx-lbl">' + (cfg.label || "Subgroup") + '</span><div class="combo-chks">' + subHtml + "</div></div>" +
    (qualHtml ? '<div class="combo-col"><span class="ctx-lbl">Qualities</span><div class="combo-chks">' + qualHtml + "</div></div>" : "") +
    (phaseHtml ? '<div class="combo-col"><span class="ctx-lbl">Phase</span><div class="combo-chks">' + phaseHtml + "</div></div>" : "") +
    "</div>";
}

function comboSelectorsHTML(prefix) {
  const cat = state.polyCategory ? state.polyCategory.value : "";
  const invOpts = COMBO_INVERSIONS[cat] || [];
  const invHtml = invOpts.map((o) => {
    const checked = state.comboSelected[o.value] ? " checked" : "";
    return '<label class="combo-chk"><input type="checkbox" id="' + prefix +
      '-combo-inv-' + o.value + '"' + checked + '><span>' + o.label + "</span></label>";
  }).join("");

  const selectedKeys = state.comboKeys.filter((k) => state.comboSelected[k.id]);
  const majors = state.comboKeys.filter((k) => k.mode === "Major");
  const minors = state.comboKeys.filter((k) => k.mode === "Minor");
  const keyChk = (k) => {
    const checked = state.comboSelected[k.id] ? " checked" : "";
    return '<label class="combo-pop-chk"><input type="checkbox" id="' + prefix +
      '-combo-key-' + k.id + '"' + checked + '><span>' + k.name + "</span></label>";
  };
  const triggerLabel = selectedKeys.length
    ? "Tonality · " + selectedKeys.length + " selected"
    : "Tonality";

  return '<div class="combo-selectors">' +
    '<div class="combo-col"><span class="ctx-lbl">Inversions</span><div class="combo-chks">' + invHtml + "</div></div>" +
    '<div class="combo-col"><span class="ctx-lbl">Tonality</span>' +
      '<div class="combo-pop">' +
        '<button type="button" id="' + prefix + '-combo-trigger" class="combo-trigger">' + triggerLabel + "</button>" +
        '<div class="combo-pop-panel" id="' + prefix + '-combo-panel" hidden>' +
          '<div class="combo-pop-actions">' +
            '<button type="button" id="' + prefix + '-combo-all-major" class="combo-pop-act">All major</button>' +
            '<button type="button" id="' + prefix + '-combo-all-minor" class="combo-pop-act">All minor</button>' +
            '<button type="button" id="' + prefix + '-combo-none" class="combo-pop-act">None</button>' +
          "</div>" +
          '<div class="combo-pop-scroll">' +
            '<div class="combo-pop-group"><div class="combo-pop-group-lbl">Major</div>' + majors.map(keyChk).join("") + "</div>" +
            '<div class="combo-pop-group"><div class="combo-pop-group-lbl">Minor</div>' + minors.map(keyChk).join("") + "</div>" +
          "</div>" +
        "</div>" +
      "</div>" +
    "</div>" +
    "</div>";
}

/** Wire the tonality popover: trigger toggle, click-outside-to-close, and
 *  All-major / All-minor / None quick actions.  `prefix` is "map" or "ctx";
 *  `root` is the element the controls were rendered into (viewMap /
 *  sessionTopbar) so the outside-click handler scopes correctly. */
function wireComboPopover(prefix, root) {
  const trigger = root.querySelector("#" + prefix + "-combo-trigger");
  const panel = root.querySelector("#" + prefix + "-combo-panel");
  if (!trigger || !panel) return;
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
  });
  const onAway = (e) => {
    if (panel.hidden) return;
    if (panel.contains(e.target) || trigger.contains(e.target)) return;
    panel.hidden = true;
    document.removeEventListener("click", onAway, true);
  };
  const obs = new MutationObserver(() => {
    if (!panel.hidden) document.addEventListener("click", onAway, true);
    else document.removeEventListener("click", onAway, true);
  });
  obs.observe(panel, { attributes: true, attributeFilter: ["hidden"] });

  const setMode = (mode, on) => {
    for (const k of state.comboKeys) if (k.mode === mode) state.comboSelected[k.id] = on;
    state.polyPart = null;
    ensureRelPolyLesson();
  };
  const allMajor = root.querySelector("#" + prefix + "-combo-all-major");
  if (allMajor) allMajor.addEventListener("click", () => { setMode("Major", true); renderAfterCombo(root, prefix); });
  const allMinor = root.querySelector("#" + prefix + "-combo-all-minor");
  if (allMinor) allMinor.addEventListener("click", () => { setMode("Minor", true); renderAfterCombo(root, prefix); });
  const noneBtn = root.querySelector("#" + prefix + "-combo-none");
  if (noneBtn) noneBtn.addEventListener("click", () => {
    for (const k of state.comboKeys) state.comboSelected[k.id] = false;
    state.polyPart = null;
    ensureRelPolyLesson();
    renderAfterCombo(root, prefix);
  });
}

/** Re-open the tonality popover after a re-render, by id prefix. */
function reopenComboPanel(prefix) {
  const p = document.getElementById(prefix + "-combo-panel");
  if (p) p.hidden = false;
}

/** Re-render after a quick-action: keep the popover open so the user sees the
 *  selection change, and refresh the parent view. */
function renderAfterCombo(root, prefix) {
  if (root === viewMap) { renderHeader(); renderMap(); }
  else { renderTopbar(); }
  reopenComboPanel(prefix);
}

function contextSelectorsHTML() {
  const sel = (id, label, options, current) =>
    '<label class="ctx-select"><span class="ctx-lbl">' + label + '</span>' +
      '<select id="' + id + '">' + options.map((o) =>
        '<option value="' + o.value + '"' + (o.value === current ? " selected" : "") + ">" + o.label + "</option>"
      ).join("") + '</select>' +
    '</label>';

  if (state.texture === "poly") {
    const cats = state.system === "absolute" ? ABS_POLY_CATEGORIES : REL_POLY_CATEGORIES;
    const catCur = state.polyCategory ? state.polyCategory.value : "";
    let html = sel("map-poly-category", "Category", cats, catCur);

    // Relative combinations: multi-select inversion + tonality checkboxes
    // instead of the single Key / subgroup / Part selectors.
    if (state.system === "relative" && isComboCategory(catCur)) {
      html += comboSelectorsHTML("map");
      return html;  // parts are implied; no Part dropdown for combinations
    }

    // Absolute combinations: multi-select subgroup + quality + phase.
    if (state.system === "absolute" && isComboCategory(catCur)) {
      html += absComboSelectorsHTML("map");
      html += sel("map-poly-part", "Part", state.polyParts, state.polyPart || "");
      return html;
    }

    if (state.system === "relative") {
      const keys = state.keys.map((k) => ({ value: String(k.id), label: k.name + " (" + k.mode + ")" }));
      const keyCur = state.contextKey ? String(state.contextKey.id) : "";
      html = sel("map-key", "Key", keys, keyCur) + html;
      // Subgroup (interval name / inversion) — only for categories that have one.
      const sgOpts = computePolySubgroups(catCur, state.polyCategoryLessons);
      if (sgOpts.length) {
        const sgCur = state.polySubgroup ? state.polySubgroup.value : "";
        html += sel("map-poly-subgroup",
          (relPolySubgroupCfg(catCur) || {}).label || "Subgroup", sgOpts, sgCur);
      }
    } else {
      // Absolute poly: subgroup (inversion / interval size).
      const aCfg = absPolySubgroupCfg(catCur);
      const sgOpts = computePolySubgroups(catCur, state.polyCategoryLessons);
      if (sgOpts.length) {
        const sgCur = state.polySubgroup ? state.polySubgroup.value : "";
        html += sel("map-poly-subgroup",
          (aCfg || {}).label || "Subgroup", sgOpts, sgCur);
        // Quality (interval/chord quality) — per (category, subgroup).
        const sgVal = state.polySubgroup ? state.polySubgroup.value : "";
        const qOpts = computeAbsPolyQualities(catCur, sgVal, state.polyCategoryLessons);
        if (qOpts.length) {
          const qCur = state.polyQuality ? state.polyQuality.value : "";
          html += sel("map-poly-quality",
            (ABS_POLY_QUALITIES[catCur] || {}).label || "Quality", qOpts, qCur);
        }
        // Phase (I = melodic / II = harmonic) — distinct phases within the
        // chosen subgroup (and quality, when set).
        let phaseSrc = state.polyCategoryLessons.filter((l) => (l[aCfg.field] || "") === sgVal);
        if (state.polyQuality) phaseSrc = phaseSrc.filter((l) => (l.quality || "") === state.polyQuality.value);
        const phases = Array.from(new Set(phaseSrc.map((l) => l.phase || 0)))
          .filter((p) => p).sort()
          .map((p) => ({ value: String(p), label: p === 1 ? "I (melodic)" : "II (harmonic)" }));
        if (phases.length) {
          html += sel("map-poly-phase", "Phase", phases, String(state.polyPhase || ""));
        }
      }
    }
    html += sel("map-poly-part", "Part", state.polyParts, state.polyPart || "");
    return html;
  }
  // mono
  if (state.system === "relative") {
    const keys = state.keys.map((k) => ({ value: String(k.id), label: k.name + " (" + k.mode + ")" }));
    const keyCur = state.contextKey ? String(state.contextKey.id) : "";
    const formulas = FORMULAS.map((f) => ({ value: f, label: f }));
    return sel("map-key", "Key", keys, keyCur) + sel("map-formula", "Formula", formulas, state.contextFormula);
  }
  const families = ABS_FAMILIES.map((f, i) => ({ value: String(i), label: f.label }));
  const famCur = ABS_FAMILIES.indexOf(state.absFamily);
  return sel("map-family", "Family", families, String(famCur)) + sel("map-part", "Part", state.absParts, state.absPart || "");
}

function dots(diff) {
  let s = "";
  for (let i = 0; i < 5; i++) s += '<span class="dot ' + (i < diff ? "on" : "") + '"></span>';
  return s;
}

function ringOffset(pct, r) {
  const radius = r || 15.5;
  return 2 * Math.PI * radius * (1 - (pct || 0) / 100);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

async function openChapter(chapterId) {
  const chapter = CHAPTERS.find((c) => c.id === chapterId);
  if (!chapter) return;
  const absPolyCombo = state.texture === "poly" && state.system === "absolute" &&
    isComboCategory(state.polyCategory ? state.polyCategory.value : "");
  if (state.texture === "poly" && state.system === "absolute" && !absPolyCombo) {
    const found = await pickAbsPolyLesson(chapterId);
    if (!found) {
      setStatus("\"" + chapter.title + "\" isn't available for " + (state.polyCategory ? state.polyCategory.label : "") + " / " + polyPartLabel(state.polyPart) + ".");
      return;
    }
  } else if (state.system === "absolute" && !absPolyCombo) {
    const found = await pickAbsLesson(chapterId);
    if (!found) {
      setStatus("\"" + chapter.title + "\" isn't available for " + state.absFamily.label + " / " + absPartLabel(state.absPart) + ".");
      return;
    }
  }
  if (!state.contextLesson) { setStatus("No lesson loaded."); return; }
  state.activeChapter = chapter;
  showSession();
  renderTopbar();
  practice.openChapter(chapter, state.contextLesson);
  setStatus("Chapter " + chapter.num + " - " + chapter.title);
}

function showSession() {
  state.view = "session";
  viewMap.hidden = true;
  viewSession.hidden = false;
}

function showMap() {
  state.view = "map";
  practice.stop();
  viewSession.hidden = true;
  viewMap.hidden = false;
  renderHeader();
  renderMap();
  setStatus("Ready");
}

function topbarContextHTML() {
  const sel = (id, label, options, current) =>
    '<label>' + label + '<select id="' + id + '">' + options.map((o) =>
      '<option value="' + o.value + '"' + (o.value === current ? " selected" : "") + ">" + o.label + "</option>"
    ).join("") + '</select></label>';

  if (state.texture === "poly") {
    const cats = state.system === "absolute" ? ABS_POLY_CATEGORIES : REL_POLY_CATEGORIES;
    const catCur = state.polyCategory ? state.polyCategory.value : "";
    let html = sel("ctx-poly-category", "Category", cats, catCur);
    if (state.system === "relative" && isComboCategory(catCur)) {
      html += comboSelectorsHTML("ctx");
      return html;
    }
    if (state.system === "absolute" && isComboCategory(catCur)) {
      html += absComboSelectorsHTML("ctx");
      html += sel("ctx-poly-part", "Part", state.polyParts, state.polyPart || "");
      return html;
    }
    if (state.system === "relative") {
      const keys = state.keys.map((k) => ({ value: String(k.id), label: k.name + " (" + k.mode + ")" }));
      const keyCur = state.contextKey ? String(state.contextKey.id) : "";
      html = sel("ctx-key", "Key", keys, keyCur) + html;
      const sgOpts = computePolySubgroups(catCur, state.polyCategoryLessons);
      if (sgOpts.length) {
        const sgCur = state.polySubgroup ? state.polySubgroup.value : "";
        html += sel("ctx-poly-subgroup",
          (relPolySubgroupCfg(catCur) || {}).label || "Subgroup", sgOpts, sgCur);
      }
    } else {
      // Absolute poly: subgroup + quality + phase.
      const aCfg = absPolySubgroupCfg(catCur);
      const sgOpts = computePolySubgroups(catCur, state.polyCategoryLessons);
      if (sgOpts.length) {
        const sgCur = state.polySubgroup ? state.polySubgroup.value : "";
        html += sel("ctx-poly-subgroup",
          (aCfg || {}).label || "Subgroup", sgOpts, sgCur);
        const sgVal = state.polySubgroup ? state.polySubgroup.value : "";
        const qOpts = computeAbsPolyQualities(catCur, sgVal, state.polyCategoryLessons);
        if (qOpts.length) {
          const qCur = state.polyQuality ? state.polyQuality.value : "";
          html += sel("ctx-poly-quality",
            (ABS_POLY_QUALITIES[catCur] || {}).label || "Quality", qOpts, qCur);
        }
        let phaseSrc = state.polyCategoryLessons.filter((l) => (l[aCfg.field] || "") === sgVal);
        if (state.polyQuality) phaseSrc = phaseSrc.filter((l) => (l.quality || "") === state.polyQuality.value);
        const phases = Array.from(new Set(phaseSrc.map((l) => l.phase || 0)))
          .filter((p) => p).sort()
          .map((p) => ({ value: String(p), label: p === 1 ? "I (melodic)" : "II (harmonic)" }));
        if (phases.length) {
          html += sel("ctx-poly-phase", "Phase", phases, String(state.polyPhase || ""));
        }
      }
    }
    html += sel("ctx-poly-part", "Part", state.polyParts, state.polyPart || "");
    return html;
  }
  if (state.system === "absolute") {
    const families = ABS_FAMILIES.map((f, i) => ({ value: String(i), label: f.label }));
    const famCur = ABS_FAMILIES.indexOf(state.absFamily);
    return sel("ctx-family", "Family", families, String(famCur)) + sel("ctx-part", "Part", state.absParts, state.absPart || "");
  }
  const keys = state.keys.map((k) => ({ value: String(k.id), label: k.name + " (" + k.mode + ")" }));
  const keyCur = state.contextKey ? String(state.contextKey.id) : "";
  const formulas = FORMULAS.map((f) => ({ value: f, label: f }));
  return sel("ctx-key", "Key", keys, keyCur) + sel("ctx-formula", "Formula", formulas, state.contextFormula);
}

function renderTopbar() {
  const c = state.activeChapter;
  if (!c) return;
  sessionTopbar.innerHTML =
    '<button id="back-map" class="back-btn">' + glyph("back", 16) + '<span>Chapters</span></button>' +
    '<div class="topbar-chapter" style="--cc:' + c.color + '">' +
      '<span class="tc-ico">' + glyph(c.glyph, 20) + '</span>' +
      '<div class="tc-text"><span class="tc-num">Chapter ' + c.num + '</span><span class="tc-title">' + c.title + '</span></div>' +
    '</div>' +
    '<div class="topbar-spacer"></div>' +
    '<div class="topbar-ctx">' +
      '<label>Texture<select id="ctx-texture">' + TEXTURES.map((t) =>
        '<option value="' + t.id + '"' + (state.texture === t.id ? " selected" : "") + ">" + t.label + "</option>"
      ).join("") + '</select></label>' +
      '<label>System<select id="ctx-system">' + SYSTEMS.map((s) =>
        '<option value="' + s.id + '"' + (state.system === s.id ? " selected" : "") + ">" + s.label + "</option>"
      ).join("") + '</select></label>' +
      topbarContextHTML() +
    '</div>';
  const back = sessionTopbar.querySelector("#back-map");
  if (back) back.addEventListener("click", showMap);
  const reopen = () => {
    const absPolyCombo = state.texture === "poly" && state.system === "absolute" &&
      isComboCategory(state.polyCategory ? state.polyCategory.value : "");
    if (state.texture === "poly" && state.system === "absolute" && state.activeChapter && !absPolyCombo) {
      // ensureAbsPolyLesson already loaded the (full) contextLesson; just
      // check availability against the summary list without a re-fetch.
      const inPart = state.polyLessons.filter((l) => (l.part || "") === state.polyPart);
      const found = inPart.some((l) => l.exercise_number === state.activeChapter.id) ||
        !!inPart.length;
      if (!found) {
        setStatus("\"" + state.activeChapter.title + "\" isn't available for " + (state.polyCategory ? state.polyCategory.label : "") + " / " + polyPartLabel(state.polyPart) + ".");
        return false;
      }
    } else if (state.system === "absolute" && state.activeChapter && !absPolyCombo) {
      // ensureAbsoluteLesson already loaded the (full) contextLesson; just
      // check availability against the summary list without a re-fetch.
      const inPart = state.absLessons.filter((l) => absPartKey(l) === state.absPart);
      const found = inPart.some((l) => l.exercise_number === state.activeChapter.id) ||
        !!inPart.length;
      if (!found) {
        setStatus("\"" + state.activeChapter.title + "\" isn't available for " + state.absFamily.label + " / " + absPartLabel(state.absPart) + ".");
        return false;
      }
    }
    if (state.activeChapter && state.contextLesson) practice.openChapter(state.activeChapter, state.contextLesson);
    setStatus("Ready");
    return true;
  };
  const ctxTexture = sessionTopbar.querySelector("#ctx-texture");
  if (ctxTexture) ctxTexture.addEventListener("change", async () => {
    setStatus("Loading…");
    await setTexture(ctxTexture.value);
    renderTopbar();
    reopen();
  });
  const ctxSystem = sessionTopbar.querySelector("#ctx-system");
  if (ctxSystem) ctxSystem.addEventListener("change", async () => {
    setStatus("Loading system…");
    await setSystem(ctxSystem.value);
    renderTopbar();
    reopen();
  });
  const ctxKey = sessionTopbar.querySelector("#ctx-key");
  if (ctxKey) ctxKey.addEventListener("change", async () => {
    setStatus("Loading key…");
    await setKey(ctxKey.value);
    renderTopbar();
    reopen();
  });
  const ctxFormula = sessionTopbar.querySelector("#ctx-formula");
  if (ctxFormula) ctxFormula.addEventListener("change", async () => {
    setStatus("Loading formula…");
    await setFormula(ctxFormula.value);
    renderTopbar();
    reopen();
  });
  const ctxFamily = sessionTopbar.querySelector("#ctx-family");
  if (ctxFamily) ctxFamily.addEventListener("change", async () => {
    setStatus("Loading family…");
    await setAbsFamily(parseInt(ctxFamily.value, 10));
    renderTopbar();
    reopen();
  });
  const ctxPart = sessionTopbar.querySelector("#ctx-part");
  if (ctxPart) ctxPart.addEventListener("change", () => {
    setAbsPart(ctxPart.value);
    renderTopbar();
    reopen();
  });
  const ctxPolyCat = sessionTopbar.querySelector("#ctx-poly-category");
  if (ctxPolyCat) ctxPolyCat.addEventListener("change", async () => {
    setStatus("Loading category…");
    await setPolyCategory(ctxPolyCat.value);
    renderTopbar();
    reopen();
  });
  const ctxPolySub = sessionTopbar.querySelector("#ctx-poly-subgroup");
  if (ctxPolySub) ctxPolySub.addEventListener("change", async () => {
    await setPolySubgroup(ctxPolySub.value);
    renderTopbar();
    reopen();
  });
  const ctxPolyQual = sessionTopbar.querySelector("#ctx-poly-quality");
  if (ctxPolyQual) ctxPolyQual.addEventListener("change", async () => {
    await setPolyQuality(ctxPolyQual.value);
    renderTopbar();
    reopen();
  });
  const ctxPolyPhase = sessionTopbar.querySelector("#ctx-poly-phase");
  if (ctxPolyPhase) ctxPolyPhase.addEventListener("change", async () => {
    await setPolyPhase(ctxPolyPhase.value);
    renderTopbar();
    reopen();
  });
  const ctxPolyPart = sessionTopbar.querySelector("#ctx-poly-part");
  if (ctxPolyPart) ctxPolyPart.addEventListener("change", () => {
    setPolyPart(ctxPolyPart.value);
    renderTopbar();
    reopen();
  });
  // Combinations: inversion + tonality checkboxes (relative poly).
  sessionTopbar.querySelectorAll('input[id^="ctx-combo-inv-"]').forEach((chk) => {
    chk.addEventListener("change", async () => {
      setComboInversion(chk.id.replace("ctx-combo-inv-", ""), chk.checked);
      renderTopbar();
      reopen();
      reopenComboPanel("ctx");
    });
  });
  sessionTopbar.querySelectorAll('input[id^="ctx-combo-key-"]').forEach((chk) => {
    chk.addEventListener("change", async () => {
      setComboKey(chk.id.replace("ctx-combo-key-", ""), chk.checked);
      renderTopbar();
      reopen();
      reopenComboPanel("ctx");
    });
  });
  // Absolute-poly combinations: subgroup + quality + phase checkboxes.
  sessionTopbar.querySelectorAll('input[id^="ctx-abscombo-sub-"]').forEach((chk) => {
    chk.addEventListener("change", async () => {
      await setAbsComboSubgroup(chk.id.replace("ctx-abscombo-sub-", ""), chk.checked);
      renderTopbar();
      reopen();
      reopenComboPanel("ctx");
    });
  });
  sessionTopbar.querySelectorAll('input[id^="ctx-abscombo-q-"]').forEach((chk) => {
    chk.addEventListener("change", async () => {
      await setAbsComboQuality(chk.id.replace("ctx-abscombo-q-", ""), chk.checked);
      renderTopbar();
      reopen();
      reopenComboPanel("ctx");
    });
  });
  sessionTopbar.querySelectorAll('input[id^="ctx-abscombo-p-"]').forEach((chk) => {
    chk.addEventListener("change", async () => {
      await setAbsComboPhase(chk.id.replace("ctx-abscombo-p-", ""), chk.checked);
      renderTopbar();
      reopen();
      reopenComboPanel("ctx");
    });
  });
  wireComboPopover("ctx", sessionTopbar);
}

function onSessionComplete(chapter, avg) {
  state.progress = recordSession(state.progress, chapter.id, avg);
  renderHeader();
}

// ---------------------------------------------------------------------------
// Audio unlock
// ---------------------------------------------------------------------------

const _unlockAudio = () => {
  player._ensureCtx();
  window.removeEventListener("pointerdown", _unlockAudio);
  window.removeEventListener("keydown", _unlockAudio);
};
window.addEventListener("pointerdown", _unlockAudio);
window.addEventListener("keydown", _unlockAudio);

brand.addEventListener("click", () => { if (state.view !== "map") showMap(); });

viewSession.addEventListener("rea:next-chapter", (e) => {
  const fromId = e.detail && e.detail.from;
  const idx = CHAPTERS.findIndex((c) => c.id === fromId);
  const next = idx >= 0 && idx < CHAPTERS.length - 1 ? CHAPTERS[idx + 1] : null;
  if (next && isUnlocked(state.progress, next)) openChapter(next.id);
  else showMap();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async () => {
  renderHeader();
  renderMap();
  setStatus("Loading…");
  footerHint.textContent = "Use headphones for the best intonation practice.";
  await loadKeys();
  await ensureLesson();
  renderHeader();
  renderMap();
  setStatus("Ready");
})().catch((e) => setStatus("Boot error: " + e.message));