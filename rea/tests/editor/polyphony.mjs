/**
 * Polyphony: when the notes of a chord and of a second voice sound.
 *
 * A chord's stacked notes start and stop with the note they are stacked on;
 * a second voice keeps its own time from the start of the bar; and the bar is
 * as long as its longest voice.  The melody a singer is asked for is the
 * first voice without the stacked notes.
 */
import assert from "node:assert";

globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const BASE = "../../apps/rea_frontend/static/rea_frontend/js";
const { buildBarSteps, barDurationMs, barPitches } = await import(`${BASE}/practiceData.js`);

let failures = 0;
function test(name, fn) {
  try { fn(); console.log("  ok   " + name); }
  catch (e) { failures += 1; console.log("  FAIL " + name + " — " + e.message); }
}

const note = (name, pc, duration, extra = {}) => Object.assign(
  { note_name: name, pitch_class: pc, duration, is_rest: false }, extra,
);
const bar = (events) => buildBarSteps({ tempo: 120, texture: "mono", bars: [{ events }] })[0];

console.log("Polyphony");

test("a chord's notes start and end together", () => {
  const b = bar([
    note("c1", 0, 0.25), note("e1", 4, 0.25, { stacked: true }), note("g1", 7, 0.25, { stacked: true }),
    note("d1", 2, 0.25),
  ]);
  const [c, e, g, d] = b.steps;
  assert.deepStrictEqual([e.startMs, g.startMs], [c.startMs, c.startMs]);
  assert.deepStrictEqual([e.durationMs, g.durationMs], [c.durationMs, c.durationMs]);
  assert.strictEqual(d.startMs, c.startMs + c.durationMs, "the next note follows the chord, not its last note");
});

test("a second voice keeps its own time from the start of the bar", () => {
  const b = bar([
    note("c1", 0, 0.25), note("d1", 2, 0.25),
    note("c", 0, 0.5, { voice: 2 }),
  ]);
  assert.strictEqual(b.steps[2].startMs, 0);
  assert.strictEqual(b.steps[1].startMs, b.steps[0].durationMs);
});

test("the bar is as long as its longest voice", () => {
  const b = bar([note("c1", 0, 0.25), note("c", 0, 1, { voice: 2 })]);
  assert.strictEqual(barDurationMs(b), b.steps[1].durationMs);
});

test("legato holds a note to the next note of its own voice only", () => {
  const b = bar([
    note("c1", 0, 0.125, { horizontal_offset_ms: 0 }), note("d1", 2, 0.125),
    note("c", 0, 0.125, { voice: 2 }), note("g", 7, 0.125, { voice: 2, horizontal_offset_ms: 10 }),
  ]);
  // Voice 2's second note is late; its first note is held to it, and voice
  // 1's notes are left alone by it.
  assert.strictEqual(b.steps[2].startMs + b.steps[2].durationMs, b.steps[3].startMs);
  assert.strictEqual(b.steps[0].durationMs, b.steps[1].startMs - b.steps[0].startMs);
});

test("the melody is the first voice without its chord notes", () => {
  const b = bar([
    note("c1", 0, 0.25), note("e1", 4, 0.25, { stacked: true }),
    note("d1", 2, 0.25), note("c", 0, 0.5, { voice: 2 }),
  ]);
  assert.deepStrictEqual(barPitches(b), [60, 62]);
});

test("a single line plays exactly as it did before voices existed", () => {
  const b = bar([note("c1", 0, 0.125), note("d1", 2, 0.125), note("e1", 4, 0.25)]);
  assert.deepStrictEqual(b.steps.map((s) => s.startMs), [0, 250, 500]);
  assert.strictEqual(barDurationMs(b), 1000);
});

console.log(failures ? `\n${failures} polyphony test(s) FAILED` : "\nall polyphony tests pass");
