/**
 * numericView.js
 *
 * The numeric display of a lesson or a key model: the same material the
 * Notal branch practises, drawn as scale degrees instead of a staff.
 *
 * It mirrors `lessonView` / `scaleView` exactly — same lesson, same bars,
 * same events — and differs only in which renderer it hands them to, so the
 * practice controller drives one as readily as the other.
 */

import { NumericRenderer } from "../components/numericRenderer.js?v=114";
import { keySigMap, midiFromEvent } from "../practiceData.js?v=114";

let renderer = null;

function getRenderer() {
  if (!renderer) {
    renderer = new NumericRenderer(document.getElementById("notation"));
  }
  return renderer;
}

/** Reset the shared renderer (e.g. on view switch). */
export function resetRenderer() {
  if (renderer) renderer.clear();
}

/**
 * Map a lesson / key model onto the bar list the numeric renderer draws.
 * The MIDI carried on each note is resolved the same way the player resolves
 * it, so the sung-pitch reading measures against the pitch actually sounded.
 */
function toBars(item) {
  const ks = keySigMap(item);
  return (item.bars || []).map((b) => ({
    label: b.label || "",
    notes: (b.events || []).map((e) => ({
      name: e.note_name,
      alias: e.alias_degree,
      duration: e.duration,
      is_rest: e.is_rest,
      midi: e.is_rest ? null : midiFromEvent(e, ks),
    })),
  }));
}

/**
 * Render a Lesson numerically (no #info meta panel — the practice controller
 * owns that).
 * @returns {NumericRenderer} the shared renderer (for highlighting)
 */
export function renderLessonNumeric(lesson, onBarClick) {
  const r = getRenderer();
  r.render(toBars(lesson), { onBarClick });
  return r;
}

/**
 * Render a KeyModel (scale) numerically — the note-based chapters (6-10)
 * practise the bare degrees of the key model rather than a formula lesson.
 * @returns {NumericRenderer} the shared renderer
 */
export function renderScaleNumeric(keyModel, onBarClick) {
  const r = getRenderer();
  r.render(toBars(keyModel), { onBarClick });
  return r;
}
