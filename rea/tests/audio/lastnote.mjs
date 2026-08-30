/**
 * The last note of a bar must get the same time as any other.
 *
 * The marker commits before a note finishes, by design — that is the lead.  On
 * the last reference there is no next marker to move to, so committing used to
 * end the bar outright: the exercise stopped underneath the singer partway
 * through their final note, and scored it from a partial reading.
 */
import { sing, analyse, SR } from "./synth.mjs";
const JS = "../../apps/rea_frontend/static/rea_frontend/js/";
import "./env.mjs";
const pd = await import(JS + "pitchDetector.js");
const pc = await import(JS + "practiceController.js");

let pass = 0, total = 0;

function T(name, notes, refs, writtenMs) {
  total++;
  const { signal, sampleRate, marks } = sing(notes, { sampleRate: SR });
  const frames = analyse(signal, sampleRate, pd.Mpm, pd.makeOnsetDetector);
  const ctrl = Object.create(pc.PracticeController.prototype);
  ctrl.running = true; ctrl.renderer = null;
  let t = 0, completeAt = null;
  const finalScore = [];
  const handler = ctrl._makeLiveCapture(0, refs, {
    noteMs: writtenMs,
    onNote: (i, n) => { finalScore[i] = n.midi; },
    onNoteDone: (i, n) => { finalScore[i] = n.midi; },
    onComplete: () => { if (completeAt == null) completeAt = t; },
  });
  for (const f of frames) { t = f.t; handler({ midi: f.midi, onsetStrength: f.onsetStrength, onsetAttack: f.onsetAttack, t: f.t }); }

  const LOOK = ((2048 - 512) / SR) * 1000;
  const lastIdx = notes.length - 1;
  const lastStart = (marks[lastIdx].startSample / sampleRate) * 1000 - LOOK;
  const lastEnd = lastStart + notes[lastIdx].ms;
  const heldFor = completeAt == null ? null : completeAt - lastStart;
  const sung = notes[lastIdx].midi;
  const scored = finalScore[refs.length - 1];

  const problems = [];
  if (completeAt == null) problems.push("the bar never completed");
  // The bar must not end before the singer has finished the last note.
  else if (completeAt < lastEnd - 60) problems.push(`bar ended ${Math.round(lastEnd - completeAt)}ms before the last note finished`);
  if (scored == null) problems.push("last note never scored");
  else if (Math.abs(scored - sung) * 100 > 40) problems.push(`last note scored ${((scored - sung) * 100).toFixed(0)} cents off`);

  console.log((problems.length ? "  FAIL  " : "  PASS  ") + name);
  console.log(`          last note sounds ${notes[lastIdx].ms}ms; bar ended ${heldFor == null ? "never" : Math.round(heldFor) + "ms"} in; scored ${scored == null ? "-" : scored.toFixed(2)} vs ${sung}`);
  problems.forEach((p) => console.log("          " + p));
  if (!problems.length) pass++;
}

const R = [60, 62, 64];
T("held last note", [
  { midi: 60, ms: 500, artic: "hard" }, { midi: 62, ms: 500, artic: "hard" },
  { midi: 64, ms: 1200, artic: "hard", vibCents: 40 }], R, 500);
T("last note the same length as the rest", [
  { midi: 60, ms: 600, artic: "hard" }, { midi: 62, ms: 600, artic: "hard" },
  { midi: 64, ms: 600, artic: "hard" }], R, 600);
T("staccato last note", [
  { midi: 60, ms: 200, artic: "hard", gapMs: 300 }, { midi: 62, ms: 200, artic: "hard", gapMs: 300 },
  { midi: 64, ms: 200, artic: "hard", gapMs: 300 }], R, 500);
// A fermata.  The marker acknowledging a note held far past its own length is
// deliberate — it beats sitting under it until the bar times out — but on the
// *last* reference acknowledging it used to end the bar, which took the marker
// off a note the singer was still holding and scored it from the part of it
// they had sung so far.  From their side: "the last note locks and then the
// highlight disappears."
T("a fermata on the last note does not end the bar", [
  { midi: 60, ms: 500, artic: "hard" }, { midi: 62, ms: 500, artic: "hard" },
  { midi: 64, ms: 2600, artic: "hard", vibCents: 40 }], R, 500);
T("last note with a scoop into it", [
  { midi: 60, ms: 500, artic: "hard" }, { midi: 62, ms: 500, artic: "hard" },
  { midi: 64, ms: 900, artic: "soft", scoopCents: 150 }], R, 500);

console.log("\n" + pass + "/" + total + " last-note cases pass");
