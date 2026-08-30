import { NotationRenderer } from "../components/notationRenderer.js?v=76";
import { modeChordToVexKey } from "../notation.js?v=76";

let renderer = null;

function getRenderer() {
  if (!renderer) {
    renderer = new NotationRenderer(document.getElementById("notation"));
  }
  return renderer;
}

/** Reset the shared renderer (e.g. on view switch). */
export function resetRenderer() {
  if (renderer) renderer.clear();
}

/**
 * Render a Lesson into the stage.
 * @param {object} lesson  serialized Lesson with nested bars.events
 * @param {function} [onBarClick]  called with the bar index on bar click
 * @returns {NotationRenderer} the shared renderer (for highlighting)
 */
export function renderLesson(lesson, onBarClick) {
  const r = renderLessonNotation(lesson, onBarClick);
  const info = document.getElementById("info");
  const bars = (lesson.bars || []);
  const poly = lesson.texture === "poly";
  const title = poly
    ? (lesson.key_model_name || "Absolute") + " · " + (lesson.category || "")
    : (lesson.key_model_name || "") + " - " + (lesson.formula_name || "") + " " + (lesson.variant || "-");
  let meta = "";
  if (poly) {
    meta =
      "<span>Category</span><b>" + (lesson.category || "-") + "</b>" +
      (lesson.inversion ? "<span>Inversion</span><b>" + lesson.inversion + "</b>" : "") +
      (lesson.interval_name ? "<span>Interval</span><b>" + lesson.interval_name + "</b>" : "") +
      (lesson.interval_size ? "<span>Interval</span><b>" + lesson.interval_size + "</b>" : "") +
      (lesson.quality ? "<span>Quality</span><b>" + lesson.quality + "</b>" : "") +
      (lesson.part ? "<span>Part</span><b>" + lesson.part + "</b>" : "") +
      (lesson.phase ? "<span>Phase</span><b>" + lesson.phase + "</b>" : "");
  } else {
    meta =
      "<span>Formula</span><b>" + (lesson.formula_name || "-") + "</b>" +
      "<span>Variant</span><b>" + (lesson.variant || "-") + "</b>";
  }
  meta +=
    "<span>Tempo</span><b>" + lesson.tempo + "</b>" +
    "<span>Bars</span><b>" + bars.length + "</b>";
  info.innerHTML =
    "<h3>" + title + "</h3>" +
    '<div class="meta">' + meta + "</div>";
  return r;
}

/**
 * Render only the notation stave (no #info meta panel).  Used by the practice
 * controller, which owns the #info panel itself and must not have it
 * overwritten when re-rendering the score mid-session.
 * @returns {NotationRenderer} the shared renderer
 */
export function renderLessonNotation(lesson, onBarClick) {
  const r = getRenderer();
  const bars = (lesson.bars || []).map((b) => ({
    clef: b.music_clef,
    label: b.label || "",
    notes: (b.events || []).map((e) => ({
      name: e.note_name,
      alias: e.alias_degree,
      duration: e.duration,
      is_rest: e.is_rest,
      is_enharmonic: e.is_enharmonic,
      horizontal_offset_ms: e.horizontal_offset_ms,
    })),
  }));
  const bars0 = lesson.bars || [];
  const vexKey = modeChordToVexKey(bars0[0] && bars0[0].music_mode_chord);
  const title = (lesson.key_model_name || "") + " " +
    (lesson.formula_name || lesson.category || "");
  r.render(bars, { title, keySignature: vexKey, onBarClick });
  return r;
}