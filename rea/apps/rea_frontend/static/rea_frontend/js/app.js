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

import { API } from "./api.js?v=41";
import { renderLessonNotation } from "./views/lessonView.js?v=41";
import { renderScaleNotation } from "./views/scaleView.js?v=41";
import { AudioPlayer } from "./audioPlayer.js?v=41";
import { PracticeController } from "./practiceController.js?v=41";
import {
  CHAPTERS, loadProgress, saveProgress, recordSession,
  isUnlocked, completedCount, PASS_THRESHOLD,
} from "./chapters.js?v=41";

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
  if (state.system === "absolute") return ensureAbsoluteLesson();
  if (!state.contextKey) return;
  setStatus("Loading lesson…");
  const formula = state.contextFormula || DEFAULT_FORMULA;
  const data = await API.listLessons({ keyModel: state.contextKey.id, formula });
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
  pickAbsLesson(chapterId);
  setStatus("Ready");
}

/**
 * Select the absolute lesson matching the current family/part and the given
 * chapter (exercise number). Falls back to any lesson in the current part
 * when that exact chapter isn't available for this family (e.g. Extended
 * families only cover chapters 3-10). Returns true iff an exact match for
 * `chapterId` was found.
 */
function pickAbsLesson(chapterId) {
  const inPart = state.absLessons.filter((l) => absPartKey(l) === state.absPart);
  const exact = inPart.find((l) => l.exercise_number === chapterId);
  state.contextLesson = exact || inPart[0] || state.absLessons[0] || null;
  if (state.contextLesson) state.contextLesson.system = "absolute";
  return !!exact;
}

async function setSystem(systemId) {
  if (!systemId || systemId === state.system) return;
  state.system = systemId;
  state.contextLesson = null;
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
  pickAbsLesson(chapterId);
}

async function setKey(keyId) {
  const k = state.keys.find((x) => String(x.id) === String(keyId));
  if (!k) return;
  state.contextKey = k;
  await ensureLesson();
}

async function setFormula(formula) {
  if (!formula) return;
  state.contextFormula = formula;
  await ensureLesson();
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
        '<label class="ctx-select"><span class="ctx-lbl">System</span>' +
          '<select id="map-system">' + SYSTEMS.map((s) =>
            '<option value="' + s.id + '"' + (state.system === s.id ? " selected" : "") + ">" + s.label + "</option>"
          ).join("") + '</select>' +
        '</label>' +
        (state.system === "relative"
          ? '<label class="ctx-select"><span class="ctx-lbl">Key</span>' +
              '<select id="map-key">' + state.keys.map((k) =>
                '<option value="' + k.id + '"' + (state.contextKey && k.id === state.contextKey.id ? " selected" : "") + ">" + k.name + " (" + k.mode + ")</option>"
              ).join("") + '</select>' +
            '</label>' +
            '<label class="ctx-select"><span class="ctx-lbl">Formula</span>' +
              '<select id="map-formula">' + FORMULAS.map((f) =>
                '<option value="' + f + '"' + (state.contextLesson && state.contextLesson.formula_name === f ? " selected" : "") + ">" + f + "</option>"
              ).join("") + '</select>' +
            '</label>'
          : '<label class="ctx-select"><span class="ctx-lbl">Family</span>' +
              '<select id="map-family">' + ABS_FAMILIES.map((f, i) =>
                '<option value="' + i + '"' + (state.absFamily === f ? " selected" : "") + ">" + f.label + "</option>"
              ).join("") + '</select>' +
            '</label>' +
            '<label class="ctx-select"><span class="ctx-lbl">Part</span>' +
              '<select id="map-part">' + state.absParts.map((p) =>
                '<option value="' + p.value + '"' + (state.absPart === p.value ? " selected" : "") + ">" + p.label + "</option>"
              ).join("") + '</select>' +
            '</label>') +
        '<button id="reset-progress" class="link-btn">reset progress</button>' +
      '</div>' +
    '</div>';

  viewMap.querySelectorAll(".chapter-card").forEach((card) => {
    card.addEventListener("click", () => openChapter(parseInt(card.dataset.chapter, 10)));
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

function openChapter(chapterId) {
  const chapter = CHAPTERS.find((c) => c.id === chapterId);
  if (!chapter) return;
  if (state.system === "absolute") {
    const found = pickAbsLesson(chapterId);
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

function renderTopbar() {
  const c = state.activeChapter;
  if (!c) return;
  let ctx;
  if (state.system === "absolute") {
    ctx =
      '<label>Family<select id="ctx-family">' + ABS_FAMILIES.map((f, i) =>
        '<option value="' + i + '"' + (state.absFamily === f ? " selected" : "") + ">" + f.label + "</option>"
      ).join("") + '</select></label>' +
      '<label>Part<select id="ctx-part">' + state.absParts.map((p) =>
        '<option value="' + p.value + '"' + (state.absPart === p.value ? " selected" : "") + ">" + p.label + "</option>"
      ).join("") + '</select></label>';
  } else {
    const keys = state.keys.map((k) =>
      '<option value="' + k.id + '"' + (state.contextKey && k.id === state.contextKey.id ? " selected" : "") + ">" + k.name + " (" + k.mode + ")</option>"
    ).join("");
    ctx =
      '<label>Key<select id="ctx-key">' + keys + '</select></label>' +
      '<label>Formula<select id="ctx-formula">' + FORMULAS.map((f) =>
        '<option value="' + f + '"' + (state.contextFormula === f ? " selected" : "") + ">" + f + "</option>"
      ).join("") + '</select></label>';
  }
  sessionTopbar.innerHTML =
    '<button id="back-map" class="back-btn">' + glyph("back", 16) + '<span>Chapters</span></button>' +
    '<div class="topbar-chapter" style="--cc:' + c.color + '">' +
      '<span class="tc-ico">' + glyph(c.glyph, 20) + '</span>' +
      '<div class="tc-text"><span class="tc-num">Chapter ' + c.num + '</span><span class="tc-title">' + c.title + '</span></div>' +
    '</div>' +
    '<div class="topbar-spacer"></div>' +
    '<div class="topbar-ctx">' +
      '<label>System<select id="ctx-system">' + SYSTEMS.map((s) =>
        '<option value="' + s.id + '"' + (state.system === s.id ? " selected" : "") + ">" + s.label + "</option>"
      ).join("") + '</select></label>' +
      ctx +
    '</div>';
  const back = sessionTopbar.querySelector("#back-map");
  if (back) back.addEventListener("click", showMap);
  const reopen = () => {
    if (state.system === "absolute" && state.activeChapter) {
      const found = pickAbsLesson(state.activeChapter.id);
      if (!found) {
        setStatus("\"" + state.activeChapter.title + "\" isn't available for " + state.absFamily.label + " / " + absPartLabel(state.absPart) + ".");
        return false;
      }
    }
    if (state.activeChapter && state.contextLesson) practice.openChapter(state.activeChapter, state.contextLesson);
    setStatus("Ready");
    return true;
  };
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