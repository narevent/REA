/**
 * Drives the real capture path end-to-end: synthesised singing -> Mpm + onset
 * detector -> the frame handler built by PracticeController._singCapture.
 *
 * This is the test that matters, because it checks the thing the singer sees:
 * which reference note each sung note was scored against.
 */
import { sing, analyse, SR } from "./synth.mjs";
const JS = "../../apps/rea_frontend/static/rea_frontend/js/";
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.performance = globalThis.performance || { now: () => 0 };
const pd = await import(JS + "pitchDetector.js");
const pc = await import(JS + "practiceController.js");

export function runSlots(name, refs, notes, noteMs) {
  const { signal, sampleRate } = sing(notes, { sampleRate: SR });
  const frames = analyse(signal, sampleRate, pd.Mpm, pd.makeOnsetDetector);

  // A minimal stand-in for the controller: _singCapture only needs `running`,
  // and the callbacks it reports through.
  const ctrl = Object.create(pc.PracticeController.prototype);
  ctrl.running = true;
  ctrl.renderer = null;
  const scored = [];
  const handler = ctrl._makeLiveCapture(0, refs, {
    noteMs,
    onNote: (i, n) => { scored[i] = n.midi; },
    onNoteDone: (i, n) => { scored[i] = n.midi; },
    onComplete: () => {},
  });

  for (const f of frames) handler({ midi: f.midi, onsetStrength: f.onsetStrength, onsetAttack: f.onsetAttack, t: f.t });
  handler({ midi: null, onsetStrength: 0, t: frames[frames.length - 1].t + 300 });

  const got = refs.map((_, i) => (scored[i] == null ? null : Number(scored[i].toFixed(2))));
  const sung = notes.map((n) => n.midi);
  // Every note sung must land in its own slot, in order, within 40 cents — and
  // any reference the singer never reached must stay empty rather than being
  // filled by a neighbour running over.
  const ok = sung.every((m, i) => got[i] != null && Math.abs(got[i] - m) * 100 <= 40) &&
    got.slice(sung.length).every((g) => g == null);
  console.log((ok ? "  PASS  " : "  FAIL  ") + name);
  console.log("          reference: " + JSON.stringify(refs));
  console.log("          sung:      " + JSON.stringify(sung));
  console.log("          scored as: " + JSON.stringify(got));
  return ok;
}

