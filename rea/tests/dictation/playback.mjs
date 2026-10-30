/**
 * Dictation playback: what is heard, and when.
 *
 *   node rea/tests/dictation/playback.mjs
 */
import assert from "node:assert";

const S = await import("../../apps/rea_frontend/static/rea_frontend/js/dictation/score.js");
const P = await import("../../apps/rea_frontend/static/rea_frontend/js/dictation/playback.js");

let failures = 0;
function test(name, fn) {
  try { fn(); console.log("  ok   " + name); }
  catch (e) { failures += 1; console.log("  FAIL " + name + " — " + e.message); }
}
const C4 = { step: "C", octave: 4, alter: 0 };
const at = (score, mi, tick, voice = 0) => ({ mi, staffKey: S.staves(score)[0].key, voice, tick });

console.log("Dictation playback");

test("a quarter at 60 lasts a second, and the measure four", () => {
  const score = S.newScore({ instruments: ["treble"], measures: 1, tempo: 60 });
  S.writeNote(score, at(score, 0, 0), { pitches: [C4], dur: "q" });
  const { steps, durationMs } = P.schedule(score);
  assert.strictEqual(steps.length, 1);
  assert.ok(Math.abs(steps[0].durationMs - 950) < 1, `${steps[0].durationMs}`);
  assert.strictEqual(durationMs, 4000);
});

test("a note tied over the barline sounds once, for its whole length", () => {
  const score = S.newScore({ instruments: ["treble"], measures: 2, tempo: 60 });
  S.writeNote(score, at(score, 0, 1440), { pitches: [C4], dur: "h" });
  const { steps } = P.schedule(score);
  assert.strictEqual(steps.length, 1);
  assert.strictEqual(steps[0].startMs, 3000);
  assert.strictEqual(steps[0].durationMs, 2000);
});

test("a chord sounds all its notes together", () => {
  const score = S.newScore({ instruments: ["treble"], measures: 1 });
  const id = S.writeNote(score, at(score, 0, 0), { pitches: [C4], dur: "q" });
  S.addPitch(score, id, { step: "E", octave: 4, alter: 0 });
  const { steps } = P.schedule(score);
  assert.deepStrictEqual(steps.map((s) => [s.midi, s.startMs]), [[60, 0], [64, 0]]);
});

test("a repeat plays its measures twice", () => {
  const score = S.newScore({ instruments: ["treble"], measures: 2, tempo: 60 });
  S.writeNote(score, at(score, 0, 0), { pitches: [C4], dur: "w" });
  score.measures[0].repeatEnd = true;
  const { steps, durationMs } = P.schedule(score);
  assert.deepStrictEqual(steps.map((s) => s.startMs), [0, 4000]);
  assert.strictEqual(durationMs, 12000);
});

test("a phrase plays only its own notes, from its first", () => {
  const score = S.newScore({ instruments: ["piano"], measures: 2, tempo: 60 });
  const a = S.writeNote(score, at(score, 0, 480), { pitches: [C4], dur: "q" });
  const b = S.writeNote(score, at(score, 0, 960), { pitches: [{ step: "D", octave: 4, alter: 0 }], dur: "q" });
  S.writeNote(score, at(score, 1, 0), { pitches: [{ step: "E", octave: 4, alter: 0 }], dur: "q" });
  const bassKey = S.staves(score)[1].key;
  S.writeNote(score, { mi: 0, staffKey: bassKey, voice: 0, tick: 480 }, { pitches: [{ step: "C", octave: 3, alter: 0 }], dur: "h" });
  const span = S.phraseSpan(score, { start: a, end: b });
  const { steps, durationMs } = P.schedule(score, { span });
  assert.deepStrictEqual(steps.map((s) => [s.midi, s.startMs]).sort(), [[48, 0], [60, 0], [62, 1000]].sort());
  assert.strictEqual(durationMs, 2000);
});

test("a crescendo ramps up to the dynamic after it", () => {
  const score = S.newScore({ instruments: ["treble"], measures: 1 });
  const ids = [0, 480, 960, 1440].map((t) => S.writeNote(score, at(score, 0, t), { pitches: [C4], dur: "q" }));
  S.setEventProps(score, [ids[0]], { dyn: "p", hairpin: "<" });
  S.setEventProps(score, [ids[2]], { hairpinEnd: true });
  S.setEventProps(score, [ids[3]], { dyn: "f" });
  const levels = P.eventLevels(score);
  const v = ids.map((id) => levels.get(id));
  assert.ok(v[0] < v[1] && v[1] < v[2] && v[2] <= v[3], v.join(","));
});

test("staccato is short and an accent is louder", () => {
  const score = S.newScore({ instruments: ["treble"], measures: 1, tempo: 60 });
  const a = S.writeNote(score, at(score, 0, 0), { pitches: [C4], dur: "q" });
  const b = S.writeNote(score, at(score, 0, 480), { pitches: [C4], dur: "q" });
  S.toggleArticulation(score, [a], "staccato");
  S.toggleArticulation(score, [b], "accent");
  const { steps } = P.schedule(score);
  assert.ok(steps[0].durationMs < 500);
  assert.ok(steps[1].volume > steps[0].volume);
});

console.log(failures ? `\n${failures} dictation playback test(s) FAILED` : "\nall dictation playback tests pass");
process.exitCode = failures ? 1 : 0;
