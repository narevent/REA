/**
 * Pitch-tracking and note-segmentation tests.
 *
 *   node rea/tests/audio/run.mjs
 *
 * These cover the singing exercises' audio path, which the Django suite cannot
 * reach: it is browser JavaScript, and it needs sound to exercise at all.
 * Rather than a microphone, the cases synthesise singing (synth.mjs) with the
 * things a real voice does that fool a naive tracker — a scooped attack,
 * vibrato, a legato slide, a re-articulated repeat, a breath — and run it
 * through the same Mpm, onset detector and segmenter the app uses.
 *
 * `cases.mjs` checks where notes begin and end.  `slots.mjs` checks the thing
 * the singer actually sees: which reference note each sung note was scored
 * against.  `measure.mjs` prints the flux figures the onset thresholds are set
 * from — run it if you change them.
 */
const mods = ["./cases.mjs", "./slots.mjs"];
let failed = false;
for (const m of mods) {
  const before = process.exitCode;
  const out = [];
  const log = console.log;
  console.log = (...a) => out.push(a.join(" "));
  await import(m);
  console.log = log;
  const text = out.join("\n");
  console.log(text);
  if (/FAIL/.test(text)) failed = true;
  process.exitCode = before;
}
console.log(failed ? "\nAUDIO TESTS FAILED" : "\nall audio tests pass");
process.exitCode = failed ? 1 : 0;
