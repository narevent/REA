/**
 * The dictation editor's browser-side tests.
 *
 *   node rea/tests/dictation/run.mjs
 *
 * `score.mjs`     the score document and every edit made to it
 * `playback.mjs`  what is heard, and when
 * `musicxml.mjs`  scores in from other notation programs, and back out
 */
const mods = ["./score.mjs", "./playback.mjs", "./musicxml.mjs"];
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
console.log(failed ? "\nDICTATION TESTS FAILED" : "\nall dictation tests pass");
process.exitCode = failed ? 1 : 0;
