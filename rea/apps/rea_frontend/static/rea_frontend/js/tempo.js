/**
 * tempo.js — how fast the exercises play, as the singer wants them.
 *
 * Every lesson carries a written tempo, and that tempo is a property of the
 * material: it is what the exercise is notated at and what its rhythm means.
 * It is not, however, a property of the person practising it.  A beginner
 * meeting a five-note formula for the first time needs it slower than it is
 * written; somebody drilling a phrase they already know wants it quicker than
 * they can comfortably sing it, because that is the point of the drill.
 * Neither of them should have to accept one fixed speed, and neither of them
 * should have to edit the lesson to get another.
 *
 * So this is a *scale*, not a BPM.  The lesson keeps its written tempo and the
 * singer keeps a multiplier, which means the setting travels with the person
 * across every exercise they open rather than being forgotten each time the
 * material changes.  It is applied in one place — `tempoOf` in
 * practiceData.js, which everything that schedules a note goes through — so
 * the notes, the gaps between them and the pace the singing tracker expects
 * all move together.  Nothing else has to know about it.
 *
 * Stored locally only.  Unlike difficulty (which changes what a score means,
 * and so belongs to the person on whatever device they sign in from) this is
 * closer to a volume knob: it is about the room and the moment, and defaulting
 * a fresh device back to the written tempo is the right thing to do.
 */

const KEY = "rea.tempoScale";

/** The offered speeds, as multiples of the lesson's written tempo.  Spaced
 *  so each step is an audible change rather than a nudge, and asymmetric on
 *  purpose: there is much further to usefully go below the written tempo
 *  (learning a phrase) than above it (pushing one you know). */
export const TEMPO_SCALES = [0.5, 0.65, 0.8, 1, 1.2, 1.4];

export const DEFAULT_TEMPO_SCALE = 1;

/** The chip has to say what the number means — "80%" on its own, next to a
 *  key and a difficulty, could be almost anything. */
export function tempoLabel(scale) {
  return "Tempo " + Math.round(scale * 100) + "%";
}

function normalise(v) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!isFinite(n)) return DEFAULT_TEMPO_SCALE;
  // Snap to an offered value: a stored setting from an older list of speeds
  // should land on the nearest one still offered, not on the default.
  let best = DEFAULT_TEMPO_SCALE;
  let bestGap = Infinity;
  for (const s of TEMPO_SCALES) {
    const gap = Math.abs(s - n);
    if (gap < bestGap) { bestGap = gap; best = s; }
  }
  return best;
}

let _scale = DEFAULT_TEMPO_SCALE;
try {
  const saved = localStorage.getItem(KEY);
  if (saved != null) _scale = normalise(saved);
} catch (e) { /* private browsing — the written tempo stands */ }

/** The current multiplier on every lesson's written tempo. */
export function getTempoScale() { return _scale; }

/** Change it.  Returns what was actually set (an unoffered value snaps). */
export function setTempoScale(value) {
  _scale = normalise(value);
  try { localStorage.setItem(KEY, String(_scale)); } catch (e) { /* ignore */ }
  return _scale;
}
