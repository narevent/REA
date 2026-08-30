/**
 * How soon does the marker move on?
 *
 * "Too fast" is not a matter of taste that can only be argued about — it is
 * measurable: the fraction of a note that has been sung when its slot is
 * committed and the marker moves to the next reference.  Commit at 25% of the
 * note and the exercise is running ahead of the singer, which reads as being
 * rushed and makes the singer chase it.  Commit at 100% and the marker follows
 * instead of leading, and every note drags.
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
  const firstCommit = [];
  let t = 0;
  const handler = ctrl._makeLiveCapture(0, refs, {
    noteMs: writtenMs,
    onNote: (i) => { if (firstCommit[i] == null) firstCommit[i] = t; },
    onNoteDone: () => {},
    onComplete: () => {},
  });
  for (const f of frames) { t = f.t; handler({ midi: f.midi, onsetStrength: f.onsetStrength, t: f.t }); }

  // Where each note really began, in the same clock the frames use.
  const LOOK = ((2048 - 512) / SR) * 1000;
  const starts = marks.map((m) => (m.startSample / sampleRate) * 1000 - LOOK);
  // Reported in milliseconds from each note's start, alongside how long that
  // note actually sounded and the gap after it.  A percentage of the beat is
  // the wrong yardstick: a staccato note is over a third of the way through
  // its beat, and committing then is right, not early.
  return notes.map((n, i) => ({
    commitMs: firstCommit[i] == null ? null : firstCommit[i] - starts[i],
    soundingMs: n.ms,
    gapMs: n.gapMs || 0,
  }));
}

