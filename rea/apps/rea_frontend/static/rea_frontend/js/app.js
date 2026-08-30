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

import { API } from "./api.js?v=114";
import { renderLessonNotation } from "./views/lessonView.js?v=114";
import { renderScaleNotation } from "./views/scaleView.js?v=114";
import { renderLessonNumeric, renderScaleNumeric } from "./views/numericView.js?v=114";
import { SoundcheckView } from "./views/soundcheckView.js?v=114";
import { AudioPlayer } from "./audioPlayer.js?v=114";
import { PracticeController } from "./practiceController.js?v=114";
import { loadAccount, currentAccount, recordServerSession } from "./account.js?v=114";
import {
  CHAPTERS, loadProgress, saveProgress, recordSession,
  isUnlocked, completedCount, PASS_THRESHOLD,
} from "./chapters.js?v=114";
import {
  AREAS, AREA_BY_ID, contextFor, kindOf, isPractisable, defaultCategory,
  categoryByUid, firstCategory, pathOf, neighbourCategory,
} from "./curriculum.js?v=114";
import { createNav } from "./curriculumNav.js?v=114";
import {
  DIFFICULTIES, DIFFICULTY_LABELS, getDifficulty, setDifficulty,
  adoptAccountDifficulty,
} from "./difficulty.js?v=114";

const status = document.getElementById("status");
const footerHint = document.getElementById("footer-hint");
const viewSession = document.getElementById("view-session");
const viewSoundcheck = document.getElementById("view-soundcheck");
const sessionTopbar = document.getElementById("session-topbar");
const headerStats = document.getElementById("header-stats");
const appNav = document.getElementById("app-nav");
const brand = document.getElementById("brand");

// Top-level areas: each curriculum from curriculum.js, plus Soundcheck, which
// is a calibration screen rather than a curriculum.  A teacher-only area is
// offered only once /api/accounts/me/ says the signed-in user is one.
const SOUNDCHECK = { id: "soundcheck", label: "Soundcheck" };

function visibleApps() {
  const teacher = !!(currentAccount() || {}).is_teacher;
  return AREAS
    .filter((a) => !a.teacherOnly || teacher)
    .map((a) => ({ id: a.id, label: a.label }))
    .concat([SOUNDCHECK]);
}

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
  // Fetch the bars for every leaf with bounded concurrency (list items are
  // summary-only).  De-duplicate by id.
  const seen = new Set();
  const uniq = lessons.filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)));
  const withBars = await mapBounded(uniq, 6, (l) => API.getLesson(l.id));
  return mergeLessons(withBars);
}

/** Run async mappers over `items` with a bounded concurrency so we don't
 *  fire hundreds of simultaneous HTTP requests (the dev server is
 *  single-threaded; production shouldn't be flooded either). */
async function mapBounded(items, limit, mapper) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await mapper(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Fetch the single-subgroup lessons for an absolute-poly combination across
 *  every selected subgroup option + quality + phase, scoped to the selected
 *  part and (optionally) one exercise number.  When ``exerciseNumber`` is
 *  given, only the lesson matching that chapter is taken per
 *  subgroup×quality×phase — so a combination practice session holds one bar
 *  set per selected leaf instead of every exercise at once (which would be
 *  hundreds of bars).  The leaves are derived client-side from the cached
 *  category fetch; their bars are fetched with bounded concurrency via the
 *  detail endpoint and merged.  Returns the merged lesson object (or null). */
async function buildAbsComboLesson(cat, exerciseNumber) {
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
        let matched = all.filter((l) =>
          (l.category || "") === baseCat &&
          (l[cfg.field] || "") === sub &&
          (q === "" ? !l.quality : (l.quality || "") === q) &&
          (l.phase || 0) === ph &&
          (!part || (l.part || "") === part));
        // Scope to one exercise per leaf when a chapter is chosen, so the
        // merged lesson stays a single practice set (not every exercise).
        if (exerciseNumber != null) {
          const exact = matched.find((l) => l.exercise_number === exerciseNumber);
          matched = exact ? [exact] : [];
        }
        leaves.push(...matched);
      }
    }
  }
  if (!leaves.length) return null;
  // Fetch the bars for every selected leaf with bounded concurrency (the
  // list endpoint is summary-only; bars come from the detail endpoint).
  // De-duplicate by id so a leaf appearing twice is fetched once.
  const seen = new Set();
  const uniq = leaves.filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)));
  const withBars = await mapBounded(uniq, 6, (l) => API.getAbsoluteLesson(l.id));
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
  app: "intonation",      // "intonation" | "soundcheck" — top-level product area
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
  // Curriculum position: which category of the method is open, and which of
  // its ten exercises.  This pair replaces the old chapter-map + selectors.
  category: null,
  contextVariant: "",
};

/** True while the open category is one of the numeric-display leaves. */
function isNumericCategory() {
  return !!state.category && kindOf(state.category) === "numeric";
}

const practice = new PracticeController({
  stage: document.getElementById("notation"),
  legend: document.getElementById("legend"),
  info: document.getElementById("info"),
  player,
  // Which picture the exercise is read from.  A numeric category is not a
  // different lesson — it is the same one shown as scale degrees, so the
  // choice is made here, at the one place the score is drawn, and nothing
  // downstream has to know which of the two it is driving.
  renderNotation: (lesson, onBarClick) =>
    isNumericCategory()
      ? renderLessonNumeric(lesson, onBarClick)
      : renderLessonNotation(lesson, onBarClick),
  renderKeyModelNotation: (keyModel, onBarClick) =>
    isNumericCategory()
      ? renderScaleNumeric(keyModel, onBarClick)
      : renderScaleNotation(keyModel, onBarClick),
  getKeyModel: (id) => API.getKey(id),
  setStatus: (m) => setStatus(m),
  onSessionComplete: (chapter, avg) => onSessionComplete(chapter, avg),
});

const soundcheck = new SoundcheckView(viewSoundcheck, { player });

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
  // The curriculum's leaf level for relative mono is the lesson `variant`:
  // no variant is the plain diatonic formula, AL1 carries the alterations,
  // SKALA the scale form.  Fall back to the plain form if the chosen variant
  // has no lesson in this key.
  const want = state.contextVariant || "";
  state.contextLesson =
    state.lessons.find((l) => (l.variant || "") === want) ||
    state.lessons.find((l) => !l.variant) ||
    state.lessons[0];
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
  let merged;
  try {
    merged = await buildComboLesson(cat);
  } catch (e) {
    state.contextLesson = null;
    state.polyLessons = [];
    setStatus("Could not load combinations: " + e.message);
    return;
  }
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
  //    A large page_size keeps the category fetch to 1-2 round-trips.
  const cacheKey = cat;
  if (state._polyCatCacheKey !== cacheKey) {
    state.polyCategoryLessons = await API.listAbsolutePolyLessons({ category: cat, pageSize: 2000 });
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

  // Fetch the base category once for option/part derivation (cached).  A
  // large page_size keeps the fetch to 1-2 round-trips.
  const cacheKey = cat;
  if (state._absComboCatKey !== cacheKey) {
    state.polyCategoryLessons = await API.listAbsolutePolyLessons({ category: baseCat, pageSize: 2000 });
    state._absComboCatKey = cacheKey;
  }
  const all = state.polyCategoryLessons;

  // Available subgroup options (restricted to those present in the data).
  // Stored as plain values (like absComboQualities/absComboPhases) — the
  // selectors below and buildAbsComboLesson index absComboSelected by value.
  state.absComboSubgroups = computeAbsComboSubgroups(cat, all).map((o) => o.value);
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

  // Build the merged lesson across every selected subgroup × quality ×
  // phase, scoped to exercise 1 by default (the first chapter).  Opening a
  // chapter rebuilds with that chapter's exercise number.
  const chapterId = (state.activeChapter && state.activeChapter.id) || 1;
  let merged;
  try {
    merged = await buildAbsComboLesson(cat, chapterId);
  } catch (e) {
    state.contextLesson = null;
    state.polyLessons = [];
    setStatus("Could not load combinations: " + e.message);
    return;
  }
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

/** Quick actions for the Inversions dropdown (All / None). */
async function setAllComboInversions(on) {
  for (const v of state.comboInversions) state.comboSelected[v] = on;
  state.polyPart = null;
  await ensureRelPolyLesson();
}

/** Quick actions for the Tonality dropdown (All major / All minor / None). */
async function setComboKeysByMode(mode, on) {
  for (const k of state.comboKeys) if (k.mode === mode) state.comboSelected[k.id] = on;
  state.polyPart = null;
  await ensureRelPolyLesson();
}

async function setAllComboKeys(on) {
  for (const k of state.comboKeys) state.comboSelected[k.id] = on;
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

/** Quick actions (All / None) for the absolute-combo Subgroup / Qualities /
 *  Phase dropdowns. */
async function setAllAbsComboSubgroups(on) {
  for (const v of state.absComboSubgroups) state.absComboSelected[v] = on;
  state.polyPart = null;
  await ensureAbsComboLesson(state.polyCategory ? state.polyCategory.value : "");
}

async function setAllAbsComboQualities(on) {
  for (const v of state.absComboQualities) state.absComboSelected["q|" + v] = on;
  state.polyPart = null;
  await ensureAbsComboLesson(state.polyCategory ? state.polyCategory.value : "");
}

async function setAllAbsComboPhases(on) {
  for (const v of state.absComboPhases) state.absComboSelected["p|" + v] = on;
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
  // "n/10 chapters" counted the ten exercise types across the whole app, which
  // the curriculum made misleading: those ten repeat in every category, so
  // passing Listening once read as a tenth of the method done forever.  XP and
  // the streak went with it — the run's own gauge and the profile dashboard
  // are where progress is answered now, both of them per-session and honest.
  headerStats.innerHTML =
    p.streak >= 2
      ? '<div class="hstat streak"><span class="hstat-ico">' + glyph("flame", 16) +
        '</span><span class="hstat-num">' + p.streak + '</span><span class="hstat-lbl">streak</span></div>'
      : "";
}

// ---------------------------------------------------------------------------
// Curriculum navigation
// ---------------------------------------------------------------------------
// The method's outline (curriculum.js) is the app's only structure.  A
// *category* is one practisable leaf of it, and its ten exercises are the
// chapters.  Opening a category writes that leaf's facets into the context
// state above and runs the existing loaders — navigation owns the position,
// never the lesson data.

const POSITION_KEY = "rea.position.v1";

/** The ten exercises a category holds — none, for the document pages, which
 *  are a single view rather than a set to work through. */
function exerciseList() {
  // Only a real lesson runs the ten exercises; a placeholder is one view.
  // A numeric category is a real lesson — it is the Notal material read as
  // degrees, so it runs the same ten.
  if (state.category && !isPractisable(state.category)) return [];
  // `short` is what the collapsed path shows: "2. Singing with repetition" is
  // wider than a phone's path line on its own, and the number plus the skill
  // already says which of the ten this is.
  return CHAPTERS.map((c) => ({
    id: c.id,
    title: c.title,
    short: c.num + ". " + c.skill,
  }));
}

function exerciseIndex() {
  const id = state.activeChapter ? state.activeChapter.id : 1;
  const i = CHAPTERS.findIndex((c) => c.id === id);
  return i >= 0 ? i : 0;
}

/** The progressive parts of the open category, when it has any.  They come
 *  from the loaded lessons rather than the outline, because which parts exist
 *  differs per category (1, 1-2, 1-3, 4-5 …). */
function partOptions() {
  if (!state.category || !state.category.parts) return [];
  if (state.system === "absolute" && state.texture === "mono") return state.absParts || [];
  return state.polyParts || [];
}

function partValue() {
  if (state.system === "absolute" && state.texture === "mono") return state.absPart;
  return state.polyPart;
}

/** Tonalities offered for the open branch — relative lessons only, narrowed
 *  to the mode the branch is in (Major Formula offers the major keys). */
function keyOptions() {
  if (!state.category || state.system !== "relative") return [];
  const mode = contextFor(state.category).keyMode;
  if (!mode) return [];
  return state.keys
    .filter((k) => k.mode === mode)
    .sort((a, b) => keyOrderKey(a.name) - keyOrderKey(b.name))
    .map((k) => ({ value: String(k.id), label: k.name }));
}

function keyValue() { return state.contextKey ? String(state.contextKey.id) : ""; }

/**
 * Open a curriculum category: translate its facets into the loader context,
 * load the lesson, and start one of its exercises.
 *
 *   part      a progressive part value, or null to let the loader default
 *   exercise  0-based index, or -1 for "the last one" — which is what
 *             arriving backwards from the following category should land on
 */
async function applyCategory(node, part, exercise) {
  if (!node) return;
  const ctx = contextFor(node);
  state.category = node;
  // Jumping through the sheet, or restoring a position, can land in another
  // area; the switcher has to follow rather than keep highlighting the old one.
  if (node.area && state.app !== node.area.id) {
    state.app = node.area.id;
    renderNav();
  }

  if (!isPractisable(node)) {
    practice.stop();
    state.activeChapter = null;
    showPlaceholder(node);
    renderTopbar();
    return;
  }

  const wasSystem = state.system;
  const wasTexture = state.texture;
  if (ctx.system) state.system = ctx.system;
  if (ctx.texture) state.texture = ctx.texture;
  if (state.system !== wasSystem || state.texture !== wasTexture) {
    state._polyCatCacheKey = null;
    state._absComboCatKey = null;
  }

  // Tonality follows the branch's mode, but a key already chosen in that mode
  // is kept — walking the method shouldn't keep resetting the student's key.
  if (ctx.keyMode && (!state.contextKey || state.contextKey.mode !== ctx.keyMode)) {
    const pool = state.keys.filter((k) => k.mode === ctx.keyMode);
    const preferred = ctx.keyMode === "Major" ? DEFAULT_KEY_NAME : "A-mol";
    state.contextKey = pool.find((k) => k.name === preferred) || pool[0] || state.contextKey;
  }

  state.contextFormula = ctx.formula || state.contextFormula;
  state.contextVariant = ctx.variant || "";

  if (state.system === "absolute" && state.texture === "mono") {
    const fam = ABS_FAMILIES.find((f) => f.category === ctx.category && f.span === ctx.span);
    if (fam) state.absFamily = fam;
    state.absPart = part != null ? part : null;
  }

  if (state.texture === "poly") {
    const cats = state.system === "absolute" ? ABS_POLY_CATEGORIES : REL_POLY_CATEGORIES;
    const chosen = cats.find((c) => c.value === ctx.category);
    if (chosen) state.polyCategory = chosen;
    // The loaders validate these against the data and fall back when a value
    // isn't present, so passing the outline's values straight through is safe.
    state.polySubgroup = ctx.subgroup ? { value: ctx.subgroup, label: ctx.subgroup } : null;
    state.polyQuality = ctx.quality ? { value: ctx.quality, label: ctx.quality } : null;
    state.polyPhase = ctx.phase || null;
    state.polyPart = part != null ? part : null;
  }

  setStatus("Loading…");
  await ensureLesson();

  const list = exerciseList();
  let i = exercise == null ? exerciseIndex() : exercise;
  if (i < 0) i = list.length - 1;
  if (i >= list.length) i = 0;
  hidePlaceholder();
  await openChapter(list[i].id);
}

// --- placeholder views -----------------------------------------------------
// The document chapters keep their place in the method's order rather than
// being hidden, so the ordering stays honest and what is still unbuilt is
// visible.  Each is one render away from being the real thing.

function showPlaceholder(node) {
  showSession();
  const stage = document.querySelector(".session-stage");
  const info = document.getElementById("info");
  const ph = document.getElementById("placeholder");
  if (stage) stage.hidden = true;
  if (info) info.hidden = true;
  if (!ph) return;
  ph.hidden = false;
  const copy = {
    label: "Not built yet",
    text: "This part of the method has no exercises behind it yet. It keeps its place in the order so the path stays true to the method.",
  };
  ph.innerHTML =
    '<div class="ph-card">' +
      '<div class="ph-kind">' + copy.label + "</div>" +
      "<h2>" + node.name + "</h2>" +
      "<p>" + copy.text + "</p>" +
    "</div>";
  setStatus(node.name);
}

function hidePlaceholder() {
  const stage = document.querySelector(".session-stage");
  const info = document.getElementById("info");
  const ph = document.getElementById("placeholder");
  if (stage) stage.hidden = false;
  if (info) info.hidden = false;
  if (ph) ph.hidden = true;
}

// --- position memory -------------------------------------------------------

function savePosition() {
  if (!state.category) return;
  try {
    localStorage.setItem(POSITION_KEY + "." + state.category.area.id, JSON.stringify({
      uid: state.category.uid,
      part: partValue(),
      exercise: exerciseIndex(),
    }));
    localStorage.setItem(POSITION_KEY + ".area", state.category.area.id);
  } catch (e) { /* private browsing — position simply isn't remembered */ }
}

function loadPosition(areaId) {
  try {
    const id = areaId || localStorage.getItem(POSITION_KEY + ".area") || AREAS[0].id;
    const raw = localStorage.getItem(POSITION_KEY + "." + id);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

/** Which area to open: `?area=` when something linked straight to one (the
 *  teacher dashboard does, for its preparations), else the one last
 *  practised — in both cases only if this user may open it. */
function openingArea() {
  let asked = null;
  try { asked = new URLSearchParams(window.location.search).get("area"); } catch (e) { /* ignore */ }
  if (!asked) {
    try { asked = localStorage.getItem(POSITION_KEY + ".area"); } catch (e) { /* ignore */ }
  }
  const area = asked ? AREA_BY_ID[asked] : null;
  if (!area) return AREAS[0];
  return visibleApps().find((a) => a.id === area.id) ? area : AREAS[0];
}

// --- the navigation surface ------------------------------------------------

const nav = createNav({
  exercises: exerciseList,
  exerciseIndex,
  partOptions,
  partValue,
  keyOptions,
  keyValue,
  difficultyOptions: () => DIFFICULTIES.map((d) => ({ value: d, label: DIFFICULTY_LABELS[d] })),
  difficultyValue: () => getDifficulty(),
  goCategory: (node, part, exercise) => applyCategory(node, part, exercise),
  goPart: (value, exercise) => applyCategory(state.category, value, exercise),
  goExercise: async (i) => {
    const list = exerciseList();
    if (list[i]) await openChapter(list[i].id);
  },
  goKey: async (id) => {
    setStatus("Loading key…");
    await setKey(id);
    const list = exerciseList();
    await openChapter(list[exerciseIndex()].id);
  },
  // Changing how much room the exercises give does not reload anything — it
  // only changes how the next attempt is judged — so the run in progress is
  // left alone and the chip simply re-renders.
  goDifficulty: (value) => {
    setDifficulty(value);
    renderTopbar();
    setStatus("Difficulty: " + DIFFICULTY_LABELS[getDifficulty()]);
  },
});
/** Build one multi-select dropdown control: a compact pill trigger (label +
 *  selection count) and a popover panel of checkboxes, optionally split into
 *  labelled groups (used for Tonality's Major/Minor split).  `groups` is
 *  `[{label: string|null, items: [{value, label, checked}]}]`.  Checkbox ids
 *  are `prefix-dimId-value`, matching the wildcard change-listeners already
 *  wired in renderMap/renderTopbar, so no wiring code needs to change.
 *  `quickActions` is `[{key, label}]` rendered as pill buttons above the
 *  list (e.g. All/None, or All major/All minor/None for Tonality) — wire
 *  their behaviour separately via `wireComboDropdown`.  `prefix` is "map"
 *  (chapter map) or "ctx" (session topbar) so ids stay unique per location. */
function comboDropdownHTML(prefix, dimId, label, groups, quickActions) {
  const allItems = groups.flatMap((g) => g.items);
  const selectedCount = allItems.filter((i) => i.checked).length;
  const triggerLabel = !allItems.length ? label
    : selectedCount === allItems.length ? label + " · all"
    : selectedCount ? label + " · " + selectedCount
    : label;
  const key = prefix + "-" + dimId;
  const chk = (i) => '<label class="combo-pop-chk"><input type="checkbox" id="' + key +
    "-" + i.value + '"' + (i.checked ? " checked" : "") + '><span>' + i.label + "</span></label>";
  const groupsHtml = groups.map((g) =>
    '<div class="combo-pop-group">' +
      (g.label ? '<div class="combo-pop-group-lbl">' + g.label + "</div>" : "") +
      g.items.map(chk).join("") +
    "</div>"
  ).join("");
  const actionsHtml = (quickActions || []).map((a) =>
    '<button type="button" id="' + key + "-" + a.key + '" class="combo-pop-act">' + a.label + "</button>"
  ).join("");

  return '<div class="combo-col"><span class="ctx-lbl">' + label + "</span>" +
    '<div class="combo-pop">' +
      '<button type="button" id="' + key + '-trigger" class="combo-trigger">' + triggerLabel + "</button>" +
      '<div class="combo-pop-panel" id="' + key + '-panel" hidden>' +
        (actionsHtml ? '<div class="combo-pop-actions">' + actionsHtml + "</div>" : "") +
        '<div class="combo-pop-scroll">' + groupsHtml + "</div>" +
      "</div>" +
    "</div>" +
  "</div>";
}

/** Build the combination controls for a relative-poly combination category:
 *  Inversions and Tonality, each a dropdown (see `comboDropdownHTML`).
 *  `prefix` is "map" or "ctx". */
function comboSelectorsHTML(prefix) {
  const cat = state.polyCategory ? state.polyCategory.value : "";
  const invOpts = COMBO_INVERSIONS[cat] || [];
  const invItems = invOpts.map((o) => ({ value: o.value, label: o.label, checked: !!state.comboSelected[o.value] }));
  const invHtml = comboDropdownHTML(prefix, "combo-inv", "Inversions",
    [{ label: null, items: invItems }],
    [{ key: "all", label: "All" }, { key: "none", label: "None" }]);

  const majors = state.comboKeys.filter((k) => k.mode === "Major")
    .map((k) => ({ value: k.id, label: k.name, checked: !!state.comboSelected[k.id] }));
  const minors = state.comboKeys.filter((k) => k.mode === "Minor")
    .map((k) => ({ value: k.id, label: k.name, checked: !!state.comboSelected[k.id] }));
  const keyHtml = comboDropdownHTML(prefix, "combo-key", "Tonality",
    [{ label: "Major", items: majors }, { label: "Minor", items: minors }],
    [{ key: "all-major", label: "All major" }, { key: "all-minor", label: "All minor" }, { key: "none", label: "None" }]);

  return '<div class="combo-selectors">' + invHtml + keyHtml + "</div>";
}

/** Build the combination controls for an absolute-poly combination category:
 *  Subgroup (inversion / interval size), Qualities, and Phase, each a
 *  dropdown (see `comboDropdownHTML`).  `prefix` is "map" or "ctx". */
function absComboSelectorsHTML(prefix) {
  const cat = state.polyCategory ? state.polyCategory.value : "";
  const cfg = absComboSubgroupCfg(cat);
  if (!cfg) return "";
  const subOpts = computeAbsComboSubgroups(cat, state.polyCategoryLessons);
  const subItems = subOpts.map((o) => ({ value: o.value, label: o.label, checked: !!state.absComboSelected[o.value] }));
  const subHtml = comboDropdownHTML(prefix, "abscombo-sub", cfg.label || "Subgroup",
    [{ label: null, items: subItems }],
    [{ key: "all", label: "All" }, { key: "none", label: "None" }]);

  // Qualities — the union of every subgroup option's qualities, labelled.
  const qualCfg = ABS_POLY_QUALITIES[comboBaseCategory(cat)];
  const qualLabelMap = {};
  if (qualCfg) {
    if (qualCfg.options) for (const q of qualCfg.options) qualLabelMap[q.value] = q.label;
    else for (const k in qualCfg.bySubgroup) for (const q of qualCfg.bySubgroup[k]) qualLabelMap[q.value] = q.label;
  }
  const qualItems = state.absComboQualities
    .filter((v) => v !== "")  // single-quality leaves (Fifths/Octaves) have no checkbox
    .map((v) => ({ value: v, label: qualLabelMap[v] || v, checked: !!state.absComboSelected["q|" + v] }));
  const qualHtml = qualItems.length ? comboDropdownHTML(prefix, "abscombo-q", "Qualities",
    [{ label: null, items: qualItems }],
    [{ key: "all", label: "All" }, { key: "none", label: "None" }]) : "";

  const phaseItems = state.absComboPhases.map((v) => ({
    value: v, label: v === 1 ? "I (melodic)" : "II (harmonic)", checked: !!state.absComboSelected["p|" + v],
  }));
  const phaseHtml = phaseItems.length ? comboDropdownHTML(prefix, "abscombo-p", "Phase",
    [{ label: null, items: phaseItems }],
    [{ key: "all", label: "All" }, { key: "none", label: "None" }]) : "";

  return '<div class="combo-selectors">' + subHtml + qualHtml + phaseHtml + "</div>";
}

/** Wire one dropdown's trigger toggle (closing any other open dropdown in
 *  `root` first) and its quick-action buttons.  `actions` maps each quick
 *  action's `key` (as passed to `comboDropdownHTML`) to an async callback
 *  that updates state and reloads the lesson; the view is re-rendered and
 *  this panel re-opened afterwards so the user sees the change take
 *  effect.  `prefix`/`dimId` identify the panel (see `comboDropdownHTML`);
 *  `root` is the session topbar. */
function wireComboDropdown(prefix, dimId, root, actions) {
  const key = prefix + "-" + dimId;
  const trigger = root.querySelector("#" + key + "-trigger");
  const panel = root.querySelector("#" + key + "-panel");
  if (!trigger || !panel) return;
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = panel.hidden;
    root.querySelectorAll(".combo-pop-panel").forEach((p) => { if (p !== panel) p.hidden = true; });
    panel.hidden = !opening;
  });
  for (const actKey in actions) {
    const btn = root.querySelector("#" + key + "-" + actKey);
    if (!btn) continue;
    btn.addEventListener("click", async () => {
      await actions[actKey]();
      renderAfterCombo(root, key + "-panel");
    });
  }
}

/** Currently-open combo dropdown panel id within `root`, if any — captured
 *  before a re-render so the same panel can be reopened afterwards (a
 *  checkbox toggle inside one dropdown shouldn't close it, or pop open a
 *  different one, when the view re-renders from scratch). */
function openComboPanelId(root) {
  const p = root.querySelector(".combo-pop-panel:not([hidden])");
  return p ? p.id : null;
}

/** Re-open `panelId` (captured via `openComboPanelId` before a re-render), if
 *  any, so a combo dropdown stays open across the innerHTML rebuild. */
function keepPanelOpen(panelId) {
  if (!panelId) return;
  const p = document.getElementById(panelId);
  if (p) p.hidden = false;
}

/** Re-render after a combo change (checkbox toggle or quick action): refresh
 *  the session topbar and keep `panelId` open, if any, so the user sees the
 *  selection change without the dropdown closing. */
function renderAfterCombo(root, panelId) {
  renderTopbar();
  keepPanelOpen(panelId);
}

/** Close any open combo dropdown panel when the user clicks outside it and
 *  its trigger.  Registered once at module load (not inside a render
 *  function) since the app re-renders by replacing innerHTML wholesale —
 *  a listener added per-render would leak one stale entry on `document`
 *  every time. */
document.addEventListener("click", (e) => {
  document.querySelectorAll(".combo-pop-panel:not([hidden])").forEach((panel) => {
    if (panel.contains(e.target)) return;
    const trigger = panel.previousElementSibling;
    if (trigger && trigger.contains(e.target)) return;
    panel.hidden = true;
  });
}, true);


// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

async function openChapter(chapterId) {
  const chapter = CHAPTERS.find((c) => c.id === chapterId);
  if (!chapter) return;
  const absPolyCombo = state.texture === "poly" && state.system === "absolute" &&
    isComboCategory(state.polyCategory ? state.polyCategory.value : "");
  if (absPolyCombo) {
    // Rebuild the combination scoped to this chapter's exercise number so the
    // merged lesson holds one bar set per selected leaf for this exercise.
    state.activeChapter = chapter;
    const cat = state.polyCategory ? state.polyCategory.value : "";
    let merged;
    try {
      merged = await buildAbsComboLesson(cat, chapterId);
    } catch (e) {
      setStatus("Could not load combinations: " + e.message);
      return;
    }
    if (!merged) {
      setStatus("\"" + chapter.title + "\" isn't available for the selected combinations / " + polyPartLabel(state.polyPart) + ".");
      return;
    }
    merged.system = "absolute";
    state.contextLesson = merged;
  } else if (state.texture === "poly" && state.system === "absolute") {
    const found = await pickAbsPolyLesson(chapterId);
    if (!found) {
      setStatus("\"" + chapter.title + "\" isn't recorded here — showing the nearest exercise.");
    }
  } else if (state.system === "absolute") {
    const found = await pickAbsLesson(chapterId);
    if (!found) {
      setStatus("\"" + chapter.title + "\" isn't recorded here — showing the nearest exercise.");
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
  viewSoundcheck.hidden = true;
  viewSession.hidden = false;
  headerStats.hidden = false;
}

/** Render the top-level app nav (Intonation / Soundcheck / ...), highlighting
 *  the active one.  Called on boot and whenever `state.app` changes. */
function renderNav() {
  appNav.innerHTML = visibleApps().map((a) =>
    '<button type="button" class="app-nav-btn' + (state.app === a.id ? " active" : "") +
    '" data-app="' + a.id + '">' + a.label + "</button>"
  ).join("");
  appNav.querySelectorAll(".app-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => showApp(btn.dataset.app));
  });
}

/** Switch the top-level product area.  Soundcheck is a standalone calibration
 *  screen (not chapter/lesson-based), so entering it stops any Intonation
 *  session and hides the chapter-stats header; leaving it releases the mic. */
function showApp(appId) {
  if (!visibleApps().find((a) => a.id === appId) || state.app === appId) return;
  const area = AREA_BY_ID[appId];
  state.app = appId;
  renderNav();
  if (appId === "soundcheck") {
    practice.stop();
    viewSession.hidden = true;
    viewSoundcheck.hidden = false;
    headerStats.hidden = true;
    soundcheck.enter();
    setStatus("Soundcheck");
  } else {
    soundcheck.leave();
    viewSoundcheck.hidden = true;
    // Each area is its own curriculum, so switching areas opens that area's
    // remembered position, or its first playable category.
    const saved = loadPosition(appId);
    const start = (saved && categoryByUid(saved.uid)) || defaultCategory(area);
    const same = saved && start === categoryByUid(saved.uid);
    applyCategory(start, same ? saved.part : null, same ? saved.exercise : 0);
  }
}

/** The combination selectors, when the open category is a combinations one. */
function comboPanelHTML() {
  const cat = state.polyCategory ? state.polyCategory.value : "";
  if (state.system === "absolute") {
    return absComboSelectorsHTML("ctx") +
      '<label>Part<select id="ctx-poly-part">' + state.polyParts.map((o) =>
        '<option value="' + o.value + '"' + (o.value === state.polyPart ? " selected" : "") + ">" + o.label + "</option>"
      ).join("") + '</select></label>';
  }
  return comboSelectorsHTML("ctx");
}

function renderTopbar() {
  const comboOpen = state.category && kindOf(state.category) === "combo";
  sessionTopbar.innerHTML =
    '<nav class="path" id="path-bar" aria-label="Curriculum path"></nav>' +
    '<div class="path-key" id="path-key"></div>' +
    '<div class="path-key path-difficulty" id="path-difficulty"></div>' +
    // Combination categories keep their multi-select panel: they merge many
    // leaves into one lesson, so they are a selection, not a single path.
    (comboOpen ? '<div class="topbar-ctx combo-ctx">' + comboPanelHTML() + '</div>' : "");
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
  const ctxPolyPart = sessionTopbar.querySelector("#ctx-poly-part");
  if (ctxPolyPart) ctxPolyPart.addEventListener("change", () => {
    setPolyPart(ctxPolyPart.value);
    renderTopbar();
    reopen();
  });
  // Combinations: inversion + tonality dropdowns (relative poly).
  sessionTopbar.querySelectorAll('input[id^="ctx-combo-inv-"]').forEach((chk) => {
    chk.addEventListener("change", async () => {
      const openId = openComboPanelId(sessionTopbar);
      setComboInversion(chk.id.replace("ctx-combo-inv-", ""), chk.checked);
      renderTopbar();
      reopen();
      keepPanelOpen(openId);
    });
  });
  sessionTopbar.querySelectorAll('input[id^="ctx-combo-key-"]').forEach((chk) => {
    chk.addEventListener("change", async () => {
      const openId = openComboPanelId(sessionTopbar);
      setComboKey(chk.id.replace("ctx-combo-key-", ""), chk.checked);
      renderTopbar();
      reopen();
      keepPanelOpen(openId);
    });
  });
  // Absolute-poly combinations: subgroup + quality + phase dropdowns.
  sessionTopbar.querySelectorAll('input[id^="ctx-abscombo-sub-"]').forEach((chk) => {
    chk.addEventListener("change", async () => {
      const openId = openComboPanelId(sessionTopbar);
      await setAbsComboSubgroup(chk.id.replace("ctx-abscombo-sub-", ""), chk.checked);
      renderTopbar();
      reopen();
      keepPanelOpen(openId);
    });
  });
  sessionTopbar.querySelectorAll('input[id^="ctx-abscombo-q-"]').forEach((chk) => {
    chk.addEventListener("change", async () => {
      const openId = openComboPanelId(sessionTopbar);
      await setAbsComboQuality(chk.id.replace("ctx-abscombo-q-", ""), chk.checked);
      renderTopbar();
      reopen();
      keepPanelOpen(openId);
    });
  });
  sessionTopbar.querySelectorAll('input[id^="ctx-abscombo-p-"]').forEach((chk) => {
    chk.addEventListener("change", async () => {
      const openId = openComboPanelId(sessionTopbar);
      await setAbsComboPhase(chk.id.replace("ctx-abscombo-p-", ""), chk.checked);
      renderTopbar();
      reopen();
      keepPanelOpen(openId);
    });
  });
  wireComboDropdown("ctx", "combo-inv", sessionTopbar, {
    all: async () => { setAllComboInversions(true); },
    none: async () => { setAllComboInversions(false); },
  });
  wireComboDropdown("ctx", "combo-key", sessionTopbar, {
    "all-major": async () => { setComboKeysByMode("Major", true); },
    "all-minor": async () => { setComboKeysByMode("Minor", true); },
    none: async () => { setAllComboKeys(false); },
  });
  wireComboDropdown("ctx", "abscombo-sub", sessionTopbar, {
    all: async () => { await setAllAbsComboSubgroups(true); },
    none: async () => { await setAllAbsComboSubgroups(false); },
  });
  wireComboDropdown("ctx", "abscombo-q", sessionTopbar, {
    all: async () => { await setAllAbsComboQualities(true); },
    none: async () => { await setAllAbsComboQualities(false); },
  });
  wireComboDropdown("ctx", "abscombo-p", sessionTopbar, {
    all: async () => { await setAllAbsComboPhases(true); },
    none: async () => { await setAllAbsComboPhases(false); },
  });

  // The path line, the tonality chip and Previous/Next all render from the
  // curriculum position, which is also what gets remembered for next visit.
  if (state.category) {
    nav.render(state.category);
    placeTopbar();
    renderAppTitle();
    savePosition();
  }
}

// On a phone the path line lives inside the hamburger with the rest of the
// app's controls, so the only thing above the staff is one bar saying where
// you are.  The row is moved rather than duplicated: it is the same controls,
// with the same listeners, in a different place.
const NARROW_MQ = window.matchMedia("(max-width: 720px)");

function placeTopbar() {
  const panel = document.getElementById("app-menu-panel");
  if (!panel || !sessionTopbar) return;
  if (NARROW_MQ.matches) {
    if (sessionTopbar.parentElement !== panel) panel.insertBefore(sessionTopbar, panel.firstChild);
  } else if (sessionTopbar.parentElement === panel) {
    viewSession.insertBefore(sessionTopbar, viewSession.firstChild);
  }
}

/** The app bar's own line: where you are, for when the path is put away. */
function renderAppTitle() {
  const el = document.getElementById("app-title");
  if (!el) return;
  if (!state.category) { el.hidden = true; return; }
  const path = pathOf(state.category);
  const where = path.slice(-2).map((n) => n.name).join(" · ");
  const list = exerciseList();
  const now = list.length ? list[exerciseIndex()] : null;
  el.hidden = false;
  el.innerHTML =
    '<span class="at-where">' + where + "</span>" +
    (now ? '<span class="at-what">' + now.title + "</span>" : "");
}

NARROW_MQ.addEventListener("change", () => { placeTopbar(); renderAppTitle(); });

function onSessionComplete(chapter, avg) {
  // Local progress first: it is what the map and header read, and it must
  // update whether or not anyone is signed in.
  state.progress = recordSession(state.progress, chapter.id, avg);
  renderHeader();
  // Then, for a signed-in student, the durable record behind the profile
  // dashboard.  Fire-and-forget — a failed sync must never interrupt practice.
  recordServerSession({
    chapterId: chapter.id,
    chapterKey: chapter.key,
    chapterTitle: chapter.title,
    score: avg,
    rounds: (state.contextLesson && (state.contextLesson.bars || []).length) || 0,
    context: {
      system: state.system,
      texture: state.texture,
      keyName: state.contextKey ? (state.contextKey.name || "") : "",
      formula: lessonContextLabel(),
    },
  });
}

/** A short human label for what was being practised, stored with the session. */
function lessonContextLabel() {
  const l = state.contextLesson;
  if (!l) return "";
  return l.formula_name || l.name || "";
}

// ---------------------------------------------------------------------------
// Audio unlock
// ---------------------------------------------------------------------------

// 64 samples of silence.  Playing one HTMLMediaElement inside the unlocking
// gesture promotes iOS to its "playback" audio session; without it WebAudio
// is routed to the ringer channel, where the hardware silent switch mutes the
// app even though the AudioContext reports itself as running — the usual
// reason a phone shows the score playing but makes no sound.
const SILENT_WAV =
  "data:audio/wav;base64,UklGRmQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YUAAAACA" +
  "gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA";

function _primeAudioSession() {
  try {
    const a = new Audio(SILENT_WAV);
    a.setAttribute("playsinline", "");
    a.volume = 0.01;
    const p = a.play();
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* nothing to promote on this platform */ }
}

const _unlockAudio = () => {
  player._ensureCtx();
  _primeAudioSession();
  window.removeEventListener("pointerdown", _unlockAudio);
  window.removeEventListener("touchend", _unlockAudio);
  window.removeEventListener("keydown", _unlockAudio);
};
window.addEventListener("pointerdown", _unlockAudio);
// Older iOS delivers a usable gesture on touchend but not pointerdown.
window.addEventListener("touchend", _unlockAudio);
window.addEventListener("keydown", _unlockAudio);

// On a phone the app's own chrome — the area switcher, the editor link, who
// is signed in — lives behind one hamburger, so the top of the screen belongs
// to where you are in the method rather than to the app around it.
const menuBtn = document.getElementById("app-menu");
if (menuBtn) {
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = document.body.classList.toggle("menu-open");
    menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });
  const closeMenu = () => {
    if (!document.body.classList.contains("menu-open")) return;
    document.body.classList.remove("menu-open");
    menuBtn.setAttribute("aria-expanded", "false");
  };
  document.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  const panel = document.getElementById("app-menu-panel");
  // A tap inside the drawer that isn't on a control shouldn't dismiss it; one
  // that *is* should, since every control in there navigates somewhere.
  if (panel) panel.addEventListener("click", (e) => {
    if (e.target.closest("a, button")) closeMenu(); else e.stopPropagation();
  });
}

// There is no chapter map to go back to any more, so the brand opens the
// curriculum sheet — the one place the whole method is visible.
brand.addEventListener("click", () => {
  if (state.app !== "intonation") { showApp("intonation"); return; }
  nav.openSheet();
});

// Finishing an exercise advances within the category, then rolls into the
// next one — the same walk as the Next button.
viewSession.addEventListener("rea:next-chapter", (e) => {
  const fromId = e.detail && e.detail.from;
  const idx = CHAPTERS.findIndex((c) => c.id === fromId);
  if (idx >= 0 && idx < CHAPTERS.length - 1) { openChapter(CHAPTERS[idx + 1].id); return; }
  const next = state.category ? neighbourCategory(state.category, 1) : null;
  if (next) applyCategory(next, null, 0);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async () => {
  renderNav();
  renderHeader();
  setStatus("Loading…");
  // Who (if anyone) is signed in.  Practising does not depend on this, so it
  // is awaited only so the first completed session can be attributed.
  const me = await loadAccount();
  // A difficulty chosen on another device belongs to the person, not to the
  // browser they chose it in.
  if (me && me.difficulty) adoptAccountDifficulty(me.difficulty);
  footerHint.textContent = "Use headphones for the best intonation practice.";
  await loadKeys();

  // Straight into an exercise — where the student left off, or the method's
  // first playable one.  Position zero is the Introduction document, which
  // does not open as an exercise.
  // The switcher can only be drawn once we know whether this user is a
  // teacher, since one area is theirs alone.
  renderNav();
  const area = openingArea();
  state.app = area.id;
  renderNav();
  const saved = loadPosition(area.id);
  const start = (saved && categoryByUid(saved.uid)) || defaultCategory(area);
  const same = saved && start === categoryByUid(saved.uid);
  await applyCategory(start, same ? saved.part : null, same ? saved.exercise : 0);
  renderHeader();
  setStatus("Ready");
})().catch((e) => setStatus("Boot error: " + e.message));