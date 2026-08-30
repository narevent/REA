/**
 * Did the singer *begin* a note, or did the tracker just find them elsewhere?
 *
 * This is the question `ONSET_ARTICULATION_DB` answers, and the one the onset
 * *strength* cannot: a pitch on the move sweeps every harmonic across the
 * spectrum and produces as much flux as a consonant does, so on spectral
 * evidence alone a legato slide and an articulation are the same event.  Level
 * is not fooled — a slide happens at a steady level, and a note being started
 * does not.
 *
 * The first half of this file prints the figures the threshold is set from.
 * The second half asserts the two properties that depend on it, so a change to
 * the envelope constants cannot quietly move them:
 *
 *   an articulation reads as one, and a slide does not;
 *   a dip in level shorter than a rest is not a new note.
 *
 *   node rea/tests/audio/articulation.mjs
 */
import { sing, analyse, SR } from "./synth.mjs";
const JS = "../../apps/rea_frontend/static/rea_frontend/js/";
import "./env.mjs";
const pd = await import(JS + "pitchDetector.js");

const LOOK = ((2048 - SR * 0.0107) / SR) * 1000;

/** The strongest level attack in the opening of each note, in dB. */
function attacks(notes) {
  const { signal, sampleRate, marks } = sing(notes, { sampleRate: SR });
  const frames = analyse(signal, sampleRate, pd.Mpm, pd.makeOnsetDetector);
  return marks.map((m) => {
    const start = (m.startSample / sampleRate) * 1000 - LOOK;
    const win = frames.filter((f) => f.t >= start - 40 && f.t <= start + 180);
    return Math.max(0, ...win.map((f) => f.onsetAttack || 0));
  });
}

const fmt = (a) => a.map((v) => v.toFixed(2)).join("  ");

// --- the figures -----------------------------------------------------------
// The first note of each phrase begins after silence, which is reported at
// full strength and is not the interesting case; read from the second on.

const articulated = attacks([
  { midi: 60, ms: 900, artic: "hard" }, { midi: 62, ms: 300, artic: "hard" },
  { midi: 64, ms: 280, artic: "hard" }, { midi: 60, ms: 1000, artic: "hard" },
]).slice(1);

const slid = attacks([
  { midi: 62, ms: 170, artic: "legato", slideFrom: 60 },
  { midi: 64, ms: 150, artic: "legato", slideFrom: 62 },
  { midi: 65, ms: 160, artic: "legato", slideFrom: 64 },
  { midi: 67, ms: 900, artic: "legato", slideFrom: 65 },
]).slice(1);

console.log("level attack in a note's opening, dB (fast envelope over slow)");
console.log("  re-articulated, no gap   " + fmt(articulated));
console.log("  slid into (legato)       " + fmt(slid));
console.log("  threshold                0.25");

let pass = 0, total = 0;
const T = (name, ok, detail) => {
  total++; if (ok) pass++;
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "\n          " + detail : ""));
};

T("an articulation clears the threshold", Math.min(...articulated) > 0.25,
  "weakest articulation " + Math.min(...articulated).toFixed(2) + " dB");
T("a slide does not", Math.max(...slid) < 0.25,
  "strongest slide " + Math.max(...slid).toFixed(2) + " dB");
T("and there is room between them", Math.min(...articulated) > 2 * Math.max(...slid),
  "ratio " + (Math.min(...articulated) / Math.max(...slid)).toFixed(1) + "x");

// --- a dip in level is not a rest ------------------------------------------
// The onset detector is driven directly here, on a frame stream rather than on
// audio, because the thing being tested is what it does with `sounding` going
// false — and how long it stays false is the whole question.

function dipRun(quietMs) {
  const det = pd.makeOnsetDetector();
  const dt = 16.7;
  let strongest = 0;
  for (let t = 0, i = 0; t < 1400; t += dt, i++) {
    // A steady note, a stretch of quiet, then the same steady note again.
    const quiet = t >= 600 && t < 600 + quietMs;
    const s = det.feed({ flux: quiet ? 0.002 : 0.006, db: quiet ? -70 : -20,
                         sounding: !quiet, t, dt: i ? dt : 0 });
    if (t > 600 + quietMs) strongest = Math.max(strongest, s);
  }
  return strongest;
}

T("a 100 ms dip in level does not start a note", dipRun(100) < 1,
  "strength after the dip " + dipRun(100).toFixed(2));
T("a 250 ms rest does", dipRun(250) >= 1,
  "strength after the rest " + dipRun(250).toFixed(2));

console.log("\n" + pass + "/" + total + " articulation cases pass");
