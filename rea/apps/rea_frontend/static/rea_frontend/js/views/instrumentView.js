/**
 * instrumentView.js
 *
 * A lesson or key model drawn on an instrument instead of a stave.
 *
 * It mirrors `numericView` exactly — same lesson, same bars, same events,
 * same resolved pitches — and differs only in which renderer it hands them
 * to.  The pitch matters more here than in the other views: a key or a fret
 * *is* a pitch, so `midiFromEvent` has to have run before anything can be
 * drawn at all.
 */

import { InstrumentRenderer } from "../components/instrumentRenderer.js?v=167";
import { keySigMap, midiFromEvent } from "../practiceData.js?v=167";

let renderer = null;
let current = null;

function getRenderer(instrument) {
  const host = document.getElementById("notation");
  // A different instrument is a different picture, not a redraw of this one.
  if (!renderer || current !== instrument) {
    if (renderer) renderer.clear();
    renderer = new InstrumentRenderer(host, instrument);
    current = instrument;
  }
  return renderer;
}

/** Reset the shared renderer (e.g. on view switch). */
export function resetRenderer() {
  if (renderer) renderer.clear();
}

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

export function renderLessonInstrument(lesson, onBarClick, instrument) {
  const r = getRenderer(instrument);
  r.render(toBars(lesson), { onBarClick });
  return r;
}

export function renderScaleInstrument(keyModel, onBarClick, instrument) {
  const r = getRenderer(instrument);
  r.render(toBars(keyModel), { onBarClick });
  return r;
}
