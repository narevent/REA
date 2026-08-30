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

function runSlots(name, refs, notes, noteMs) {
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

  for (const f of frames) handler({ midi: f.midi, onset: f.onset, t: f.t });
  handler({ midi: null, onset: false, t: frames[frames.length - 1].t + 300 });

  const got = refs.map((_, i) => (scored[i] == null ? null : Number(scored[i].toFixed(2))));
  const sung = notes.map((n) => n.midi);
  const ok = got.length === sung.length &&
    got.every((g, i) => g != null && Math.abs(g - sung[i]) * 100 <= 40);
  console.log((ok ? "  PASS  " : "  FAIL  ") + name);
  console.log("          reference: " + JSON.stringify(refs));
  console.log("          sung:      " + JSON.stringify(sung));
  console.log("          scored as: " + JSON.stringify(got));
  return ok;
}

let pass = 0, total = 0;
const T = (...a) => { total++; if (runSlots(...a)) pass++; };

// The repeat: reference 1-1-3-5 sung correctly.  Before onset detection the two
// Cs arrived as one note and everything after was scored against the wrong
// reference.
T("repeated note keeps the alignment", [60, 60, 64, 67],
  [{ midi: 60, ms: 450, artic: "hard" }, { midi: 60, ms: 450, artic: "hard" },
   { midi: 64, ms: 450, artic: "hard" }, { midi: 67, ms: 500, artic: "hard" }], 450);

// Sung a semitone flat throughout: every note should still land in its own
// slot — being wrong must not cost alignment as well as points.
T("wrong notes still land in their own slots", [60, 62, 64, 65],
  [{ midi: 59, ms: 400, artic: "hard" }, { midi: 61, ms: 400, artic: "hard" },
   { midi: 63, ms: 400, artic: "hard" }, { midi: 64, ms: 450, artic: "hard" }], 400);

// A held note with a big scoop must score where it landed, not where it began.
T("scooped note scores where it landed", [67],
  [{ midi: 67, ms: 900, artic: "soft", scoopCents: 150 }], 900);

// Legato descent, no articulation at all.
T("legato phrase", [72, 71, 69],
  [{ midi: 72, ms: 420, artic: "hard" },
   { midi: 71, ms: 420, artic: "legato", slideFrom: 72 },
   { midi: 69, ms: 480, artic: "legato", slideFrom: 71 }], 420);

// At tempo: eighth notes at 119bpm are 252 ms.
T("eighths at tempo 119", [60, 62, 64, 65, 67],
  [{ midi: 60, ms: 252, artic: "hard" }, { midi: 62, ms: 252, artic: "hard" },
   { midi: 64, ms: 252, artic: "hard" }, { midi: 65, ms: 252, artic: "hard" },
   { midi: 67, ms: 400, artic: "hard" }], 252);

console.log("\n" + pass + "/" + total + " slot cases pass");
