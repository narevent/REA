import { NotationRenderer } from "../components/notationRenderer.js?v=67";
import { modeChordToVexKey } from "../notation.js?v=67";

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
 * Render a KeyModel (scale) into the stage.
 * @param {object} keyModel  serialized KeyModel with nested bars.events
 * @param {function} [onBarClick]  called with the bar index on bar click
 * @returns {NotationRenderer} the shared renderer (for highlighting)
 */
export function renderScale(keyModel, onBarClick) {
  const r = renderScaleNotation(keyModel, onBarClick);
  const info = document.getElementById("info");
  const bars0 = keyModel.bars || [];
  const clef = (bars0[0] && bars0[0].music_clef) || "Violin";
  const sig = (keyModel.key_signature || []).map((k) => k.name).join(", ") || "-";
  const html =
    "<h3>" + keyModel.name + "</h3>" +
    '<div class="meta">' +
    "<span>Mode</span><b>" + keyModel.mode + "</b>" +
    "<span>Root PC</span><b>" + keyModel.root_pitch_class + "</b>" +
    "<span>Clef</span><b>" + clef + "</b>" +
    "<span>Bars</span><b>" + bars0.length + "</b>" +
    "<span>Key signature</span><b>" + sig + "</b>" +
    "</div>";
  info.innerHTML = html;
  return r;
}

/**
 * Render only the notation stave of a KeyModel (scale) into the stage, without
 * touching the #info panel.  Used by the practice controller for the
 * note-based chapters (6-10), which practise the bare scale degrees of the
 * key model rather than a formula lesson.
 * @returns {NotationRenderer} the shared renderer
 */
export function renderScaleNotation(keyModel, onBarClick) {
  const r = getRenderer();
  const bars = (keyModel.bars || []).map((b) => ({
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
  const bars0 = keyModel.bars || [];
  const vexKey = modeChordToVexKey(bars0[0] && bars0[0].music_mode_chord);
  r.render(bars, { title: keyModel.name || "", keySignature: vexKey, onBarClick });
  return r;
}