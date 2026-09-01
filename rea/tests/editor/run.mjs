/**
 * The score editor's browser-side tests.
 *
 *   node rea/tests/editor/run.mjs
 *
 * `midi.mjs`     reading a Standard MIDI File into bars: the pitch spellings
 *                chosen for a key, and what becomes of chords, gaps,
 *                performed note lengths and barlines.
 * `tuplets.mjs`  what a tuplet does to a note's sounding length, and what it
 *                leaves alone.
 *
 * Everything the Django suite can reach is tested there instead; these two
 * are browser JavaScript with no server in them.
 */
const mods = ["./midi.mjs", "./tuplets.mjs"];
let failed = false;
for (const m of mods) {
  const out = [];
  const log = console.log;
  console.log = (...a) => out.push(a.join(" "));
  await import(m);
  console.log = log;
  const text = out.join("\n");
  console.log(text);
  if (/FAIL/.test(text)) failed = true;
}
console.log(failed ? "\nEDITOR TESTS FAILED" : "\nall editor tests pass");
process.exitCode = failed ? 1 : 0;
