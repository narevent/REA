/**
 * A diagnostic, not a test: print the notes the segmenter finds in a synthesised
 * phrase, with why each one began and whether it settled.
 *
 *   node rea/tests/audio/inspect.mjs
 *
 * Run this when a learner case fails and it is not obvious whether the fault is
 * in the segmentation (the wrong notes were found) or in the slot policy (the
 * right notes were put in the wrong places).
 */
import { sing, analyse, SR } from "./synth.mjs";
const JS = "../../apps/rea_frontend/static/rea_frontend/js/";
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.performance = globalThis.performance || { now: () => 0 };
const pd = await import(JS + "pitchDetector.js");
const pc = await import(JS + "practiceController.js");

export function inspect(name, notes, writtenMs) {
  const { signal, sampleRate } = sing(notes, { sampleRate: SR });
  const frames = analyse(signal, sampleRate, pd.Mpm, pd.makeOnsetDetector);
  const seg = pc.makeNoteSegmenter({ paceMs: writtenMs });
  const found = [];
  let last = 0;
  for (const f of frames) {
    const dt = f.t - last; last = f.t;
    const o = seg.feed({ midi: f.midi, onsetStrength: f.onsetStrength, onsetAttack: f.onsetAttack, t: f.t, dt });
    if (o.ended) found.push(o.ended);
  }
  console.log("\n" + name + "   (sang " + notes.map((n) => n.midi + "/" + n.ms + "ms").join("  ") + ")");
  found.forEach((n) => console.log(
    "   " + n.midi.toFixed(2).padStart(7) +
    "  " + String(Math.round(n.durMs)).padStart(5) + "ms" +
    "  " + (n.articulated ? "articulated" : "pitch-only ") +
    "  " + (n.settled ? "settled" : "search ") +
    "  " + (n.confident ? "" : "(not a note)")));
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  inspect("hunting up to the note", [
    { midi: 62, ms: 170, artic: "legato", slideFrom: 60 },
    { midi: 64, ms: 150, artic: "legato", slideFrom: 62 },
    { midi: 65, ms: 160, artic: "legato", slideFrom: 64 },
    { midi: 67, ms: 900, artic: "legato", slideFrom: 65 }], 600);

  inspect("a note sung with doubt", [
    { midi: 64, ms: 380, artic: "hard" },
    { midi: 63.3, ms: 200, artic: "legato", slideFrom: 64 },
    { midi: 64, ms: 600, artic: "legato", slideFrom: 63.3 },
    { midi: 65, ms: 700, artic: "hard" }], 600);

  inspect("a 70ms dropout mid-note", [
    { midi: 62, ms: 500, artic: "hard", gapMs: 70 },
    { midi: 62, ms: 500, artic: "legato" },
    { midi: 67, ms: 700, artic: "hard" }], 600);

  inspect("a 130ms breath mid-note", [
    { midi: 62, ms: 500, artic: "hard", gapMs: 130 },
    { midi: 62, ms: 500, artic: "legato" },
    { midi: 67, ms: 700, artic: "hard" }], 600);

  inspect("a false start", [
    { midi: 65, ms: 70, artic: "hard", gapMs: 320 },
    { midi: 69, ms: 900, artic: "hard" }], 600);

  inspect("rubato: slow, fast, slow", [
    { midi: 60, ms: 900, artic: "hard" },
    { midi: 62, ms: 300, artic: "hard" },
    { midi: 64, ms: 280, artic: "hard" },
    { midi: 60, ms: 1000, artic: "hard" }], 500);

  inspect("hunting mid-bar", [
    { midi: 60, ms: 700, artic: "hard" },
    { midi: 63, ms: 150, artic: "legato", slideFrom: 60 },
    { midi: 65, ms: 140, artic: "legato", slideFrom: 63 },
    { midi: 67, ms: 800, artic: "legato", slideFrom: 65 }], 600);

  inspect("a voice that never settles", [
    { midi: 60, ms: 200, artic: "legato", slideFrom: 59 },
    { midi: 60.6, ms: 200, artic: "legato", slideFrom: 60 },
    { midi: 60, ms: 200, artic: "legato", slideFrom: 60.6 },
    { midi: 60.5, ms: 200, artic: "legato", slideFrom: 60 },
    { midi: 62, ms: 900, artic: "hard" }], 600);
}
