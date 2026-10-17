/**
 * The dictation score: the rules every edit keeps.
 *
 *   node rea/tests/dictation/score.mjs
 *
 * A measure's first voice always fills it exactly; a note longer than what is
 * left of a measure is tied into the next; accidentals are drawn the way an
 * engraver draws them; repeats and jumps play in the ordinary order.
 */
import assert from "node:assert";

const S = await import("../../apps/rea_frontend/static/rea_frontend/js/dictation/score.js");

let failures = 0;
function test(name, fn) {
  try { fn(); console.log("  ok   " + name); }
  catch (e) { failures += 1; console.log("  FAIL " + name + " — " + e.message); }
}

const C4 = { step: "C", octave: 4, alter: 0 };
const pitch = (step, octave, alter = 0) => ({ step, octave, alter });
const staffKey = (score) => S.staves(score)[0].key;
const voice1 = (score, mi) => score.measures[mi].staves[staffKey(score)].voices[0];
const shape = (events) => events.map((e) => (e.rest ? "r" : e.pitches.map((p) => p.step + p.octave).join("+")) + ":" + e.dur + ".".repeat(e.dots || 0));
const fills = (score) => score.measures.every((m, mi) => S.staves(score).every(({ key }) => {
  const voices = m.staves[key].voices;
  return voices.every((v, i) => (i > 0 && !v.length) || v.reduce((t, e) => t + S.eventTicks(e), 0) === S.measureTicks(score, mi));
}));

console.log("Dictation score");

test("durations, dots and tuplets in ticks", () => {
  assert.strictEqual(S.eventTicks({ dur: "q" }), 480);
  assert.strictEqual(S.eventTicks({ dur: "h", dots: 1 }), 1440);
  assert.strictEqual(S.eventTicks({ dur: "q", dots: 2 }), 840);
  assert.strictEqual(S.eventTicks({ dur: "8", tuplet: { num: 3, den: 2 } }), 160);
});

test("a gap is filled with as few rests as possible", () => {
  assert.deepStrictEqual(S.splitTicks(1440), [{ dur: "h", dots: 1 }]);
  assert.deepStrictEqual(S.splitTicks(1680), [{ dur: "h", dots: 2 }]);
  assert.deepStrictEqual(S.splitTicks(600), [{ dur: "q", dots: 0 }, { dur: "16", dots: 0 }]);
});

test("a new score's measures are full of rests", () => {
  const score = S.newScore({ instruments: ["treble"], time: [3, 4], measures: 2 });
  assert.deepStrictEqual(shape(voice1(score, 0)), ["r:h."]);
  assert.ok(fills(score));
});

test("writing a note takes its time from what it lands on", () => {
  const score = S.newScore({ instruments: ["treble"], measures: 2 });
  const key = staffKey(score);
  S.writeNote(score, { mi: 0, staffKey: key, voice: 0, tick: 0 }, { pitches: [C4], dur: "q" });
  S.writeNote(score, { mi: 0, staffKey: key, voice: 0, tick: 480 }, { pitches: [pitch("E", 4)], dur: "8" });
  assert.deepStrictEqual(shape(voice1(score, 0)), ["C4:q", "E4:8", "r:8", "r:h"]);
  assert.ok(fills(score));
});

test("writing over a long note keeps the part before it", () => {
  const score = S.newScore({ instruments: ["treble"], measures: 1 });
  const key = staffKey(score);
  S.writeNote(score, { mi: 0, staffKey: key, voice: 0, tick: 0 }, { pitches: [C4], dur: "w" });
  S.writeNote(score, { mi: 0, staffKey: key, voice: 0, tick: 960 }, { pitches: [pitch("G", 4)], dur: "q" });
  assert.deepStrictEqual(shape(voice1(score, 0)), ["C4:h", "G4:q", "r:q"]);
});

test("a note too long for the measure is tied into the next", () => {
  const score = S.newScore({ instruments: ["treble"], measures: 1 });
  const key = staffKey(score);
  S.writeNote(score, { mi: 0, staffKey: key, voice: 0, tick: 1440 }, { pitches: [C4], dur: "h" });
  assert.strictEqual(score.measures.length, 2, "a measure is added for the rest of the note");
  assert.deepStrictEqual(shape(voice1(score, 0)), ["r:h.", "C4:q"]);
  assert.deepStrictEqual(shape(voice1(score, 1)).slice(0, 1), ["C4:q"]);
  assert.strictEqual(voice1(score, 0)[1].pitches[0].tie, true);
  assert.strictEqual(voice1(score, 1)[0].pitches[0].tie, false);
  assert.ok(fills(score));
});

test("a second voice stays empty until written in, then fills its measure", () => {
  const score = S.newScore({ instruments: ["treble"], measures: 1 });
  const key = staffKey(score);
  assert.strictEqual(score.measures[0].staves[key].voices[1].length, 0);
  S.writeNote(score, { mi: 0, staffKey: key, voice: 1, tick: 480 }, { pitches: [pitch("A", 3)], dur: "q" });
  assert.deepStrictEqual(shape(score.measures[0].staves[key].voices[1]), ["r:q", "A3:q", "r:h"]);
  assert.ok(fills(score));
});

test("a chord is a note with more than one pitch, lowest first", () => {
  const score = S.newScore({ instruments: ["treble"], measures: 1 });
  const key = staffKey(score);
  const id = S.writeNote(score, { mi: 0, staffKey: key, voice: 0, tick: 0 }, { pitches: [pitch("G", 4)], dur: "h" });
  S.addPitch(score, id, C4);
  S.addPitch(score, id, pitch("E", 4));
  assert.deepStrictEqual(shape(voice1(score, 0))[0], "C4+E4+G4:h");
});

test("changing a note's value rewrites the measure around it", () => {
  const score = S.newScore({ instruments: ["treble"], measures: 1 });
  const key = staffKey(score);
  const id = S.writeNote(score, { mi: 0, staffKey: key, voice: 0, tick: 0 }, { pitches: [C4], dur: "q" });
  S.setDuration(score, id, "h", 1);
  assert.deepStrictEqual(shape(voice1(score, 0)), ["C4:h.", "r:q"]);
});

test("accidentals follow the key and carry through the measure", () => {
  const score = S.newScore({ instruments: ["treble"], key: 2, measures: 1 });   // D major
  const key = staffKey(score);
  const cursor = (tick) => ({ mi: 0, staffKey: key, voice: 0, tick });
  const fs = S.writeNote(score, cursor(0), { pitches: [pitch("F", 4, 1)], dur: "q" });
  const fn = S.writeNote(score, cursor(480), { pitches: [pitch("F", 4, 0)], dur: "q" });
  const fn2 = S.writeNote(score, cursor(960), { pitches: [pitch("F", 4, 0)], dur: "q" });
  const bb = S.writeNote(score, cursor(1440), { pitches: [pitch("B", 4, -1)], dur: "q" });
  const acc = S.accidentalsFor(score, 0, key);
  assert.deepStrictEqual([acc.get(fs), acc.get(fn), acc.get(fn2), acc.get(bb)], [[null], ["n"], [null], ["b"]]);
});

test("a tie writes the pitch over a rest and is not given an accidental twice", () => {
  const score = S.newScore({ instruments: ["treble"], measures: 2 });
  const key = staffKey(score);
  const id = S.writeNote(score, { mi: 0, staffKey: key, voice: 0, tick: 1440 }, { pitches: [pitch("F", 4, 1)], dur: "q" });
  S.toggleTie(score, [id]);
  const next = voice1(score, 1)[0];
  assert.strictEqual(next.rest, false);
  assert.deepStrictEqual(S.accidentalsFor(score, 1, key).get(next.id), [null]);
});

test("a quarter divided into a triplet is three triplet eighths", () => {
  const score = S.newScore({ instruments: ["treble"], measures: 1 });
  const key = staffKey(score);
  const id = S.writeNote(score, { mi: 0, staffKey: key, voice: 0, tick: 0 }, { pitches: [C4], dur: "q" });
  S.makeTuplet(score, id, 3, 2);
  const events = voice1(score, 0);
  assert.deepStrictEqual(events.slice(0, 3).map((e) => [e.dur, e.tuplet && e.tuplet.num]), [["8", 3], ["8", 3], ["8", 3]]);
  assert.ok(fills(score));
});

test("a shorter time signature cuts, a longer one pads", () => {
  const score = S.newScore({ instruments: ["treble"], measures: 1 });
  const key = staffKey(score);
  S.writeNote(score, { mi: 0, staffKey: key, voice: 0, tick: 0 }, { pitches: [C4], dur: "w" });
  S.setMeasureProps(score, 0, 0, { time: [3, 4] });
  assert.deepStrictEqual(shape(voice1(score, 0)), ["C4:h."]);
  S.setMeasureProps(score, 0, 0, { time: [5, 4] });
  assert.deepStrictEqual(shape(voice1(score, 0)), ["C4:h.", "r:q", "r:q"]);   // beats 4 and 5
});

test("repeats, endings and D.C. al Fine play in the ordinary order", () => {
  const score = S.newScore({ instruments: ["treble"], measures: 6 });
  const m = score.measures;
  m[1].repeatStart = true;
  m[3].repeatEnd = true;
  m[3].volta = [1];
  m[4].volta = [2];
  assert.deepStrictEqual(S.playOrder(score), [0, 1, 2, 3, 1, 2, 4, 5]);
  delete m[3].volta; delete m[4].volta;
  m[2].nav = "fine";
  m[5].nav = "dcalfine";
  assert.deepStrictEqual(S.playOrder(score), [0, 1, 2, 3, 1, 2, 3, 4, 5, 0, 1, 2]);
});

test("a phrase spans from its first note's start to its last note's end", () => {
  const score = S.newScore({ instruments: ["treble"], measures: 2 });
  const key = staffKey(score);
  const a = S.writeNote(score, { mi: 0, staffKey: key, voice: 0, tick: 480 }, { pitches: [C4], dur: "q" });
  const b = S.writeNote(score, { mi: 1, staffKey: key, voice: 0, tick: 0 }, { pitches: [C4], dur: "h" });
  assert.deepStrictEqual(S.phraseSpan(score, { start: a, end: b }), { from: 480, to: 1920 + 960, fromMeasure: 0, toMeasure: 1 });
});

test("copy and paste write the clip over the music at the cursor", () => {
  const score = S.newScore({ instruments: ["treble"], measures: 2 });
  const key = staffKey(score);
  const a = S.writeNote(score, { mi: 0, staffKey: key, voice: 0, tick: 0 }, { pitches: [C4], dur: "q" });
  const b = S.writeNote(score, { mi: 0, staffKey: key, voice: 0, tick: 480 }, { pitches: [pitch("D", 4)], dur: "q" });
  const clip = S.copyRange(score, a, b);
  S.pasteClip(score, { mi: 1, staffKey: key, voice: 0, tick: 0 }, clip);
  assert.deepStrictEqual(shape(voice1(score, 1)), ["C4:q", "D4:q", "r:h"]);
});

test("respelling a semitone up follows the key", () => {
  assert.deepStrictEqual(S.transposePitch(pitch("F", 4), 1, 2), { step: "F", alter: 1, octave: 4, tie: false });
  assert.deepStrictEqual(S.transposePitch(pitch("E", 4), 1, 2), { step: "F", alter: 0, octave: 4, tie: false });
  assert.deepStrictEqual(S.transposePitch(pitch("A", 4), 1, -2), { step: "B", alter: -1, octave: 4, tie: false });
  assert.deepStrictEqual(S.transposePitch(pitch("B", 4), 1, 0), { step: "C", alter: 0, octave: 5, tie: false });
});

console.log(failures ? `\n${failures} dictation score test(s) FAILED` : "\nall dictation score tests pass");
process.exitCode = failures ? 1 : 0;
