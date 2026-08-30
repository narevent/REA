/**
 * How soon does the marker move on — and how soon does the singer know they
 * have been heard?
 *
 * These used to be the same event, and conflating them is what made the
 * exercise feel like it was running away: the only way to tell a singer their
 * note had registered was to move the marker off it.  They are now separate,
 * and so are the two things measured here.
 *
 *   report   the first live reading of the note.  This is feedback, not
 *            progress: the marker has not moved, the singer is still on the
 *            note.  It should arrive *while they are singing it*.
 *   advance  the reference is answered and the marker moves to the next one.
 *            This must not happen before the singer has finished the note.
 */
import { sing, analyse, SR } from "./synth.mjs";
const JS = "../../apps/rea_frontend/static/rea_frontend/js/";
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.performance = globalThis.performance || { now: () => 0 };
const pd = await import(JS + "pitchDetector.js");
const pc = await import(JS + "practiceController.js");

export function pacingOf(notes, refs, writtenMs) {
  const { signal, sampleRate, marks } = sing(notes, { sampleRate: SR });
  const frames = analyse(signal, sampleRate, pd.Mpm, pd.makeOnsetDetector);
  const ctrl = Object.create(pc.PracticeController.prototype);
  ctrl.running = true; ctrl.renderer = null;
  const firstReport = [];
  const advanced = [];
  let t = 0;
  const handler = ctrl._makeLiveCapture(0, refs, {
    noteMs: writtenMs,
    onNote: (i) => { if (firstReport[i] == null) firstReport[i] = t; },
    onNoteDone: (i) => { if (advanced[i] == null) advanced[i] = t; },
    onComplete: () => {},
  });
  for (const f of frames) { t = f.t; handler({ midi: f.midi, onsetStrength: f.onsetStrength, onsetAttack: f.onsetAttack, t: f.t }); }

  // Where each note really began, in the same clock the frames use.
  const LOOK = ((2048 - 512) / SR) * 1000;
  const starts = marks.map((m) => (m.startSample / sampleRate) * 1000 - LOOK);
  // Reported in milliseconds from each note's start, alongside how long that
  // note actually sounded and the gap after it.  A percentage of the beat is
  // the wrong yardstick: a staccato note is over a third of the way through
  // its beat, and committing then is right, not early.
  return notes.map((n, i) => ({
    reportMs: firstReport[i] == null ? null : firstReport[i] - starts[i],
    advanceMs: advanced[i] == null ? null : advanced[i] - starts[i],
    soundingMs: n.ms,
    gapMs: n.gapMs || 0,
  }));
}

