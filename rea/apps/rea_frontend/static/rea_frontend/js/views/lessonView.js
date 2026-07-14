import { NotationRenderer } from "../components/notationRenderer.js?v=41";
import { modeChordToVexKey } from "../notation.js?v=41";

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
  const variant = lesson.variant || "-";
  const html =
    "<h3>" + lesson.key_model_name + " - " + lesson.formula_name + " " + variant + "</h3>" +
    '<div class="meta">' +
    "<span>Formula</span><b>" + lesson.formula_name + "</b>" +
    "<span>Variant</span><b>" + variant + "</b>" +
    "<span>Tempo</span><b>" + lesson.tempo + "</b>" +
    "<span>Bars</span><b>" + bars.length + "</b>" +
    "<span>Note heads only</span><b>" + lesson.draw_only_note_heads + "</b>" +
    "</div>";
  info.innerHTML = html;
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
  r.render(bars, { title: lesson.key_model_name + " " + lesson.formula_name, keySignature: vexKey, onBarClick });
  return r;
}