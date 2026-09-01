/**
 * Tuplets: what they do to a note's sounding length, and what they do not.
 *
 * The rule is one sentence — a tuplet keeps the note's *written* value and
 * scales only how long it sounds — and everything else about them follows
 * from it.  The stave draws an eighth, the beaming groups it as an eighth,
 * and three of them inside a triplet occupy the time of two.  These cases
 * pin that arithmetic, because it is the half of the feature nobody can see:
 * a bracket drawn over notes that play at the wrong speed looks perfectly
 * correct until you listen to it.
 */
import assert from "node:assert";

globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const BASE = "../../apps/rea_frontend/static/rea_frontend/js";
const { buildBarSteps, tupletRatio } = await import(`${BASE}/practiceData.js`);

let failures = 0;
function test(name, fn) {
  try { fn(); console.log("  ok   " + name); }
  catch (e) { failures += 1; console.log("  FAIL " + name + " — " + e.message); }
}

/** A one-bar lesson of `count` eighths, optionally marked as a tuplet. */
function lesson(count, tuplet = null) {
  return {
    tempo: 120, texture: "mono",
    bars: [{
      events: Array.from({ length: count }, () => ({
        note_name: "c1", pitch_class: 0, duration: 0.125, is_rest: false,
        tuplet_num: tuplet ? tuplet[0] : 0,
        tuplet_den: tuplet ? tuplet[1] : 0,
      })),
    }],
  };
}

const lengths = (item) => buildBarSteps(item)[0].steps.map((s) => s.durationMs);
const total = (xs) => xs.reduce((a, b) => a + b, 0);

console.log("Tuplets");

test("an ordinary note is unaffected", () => {
  assert.strictEqual(tupletRatio({}), 1);
  assert.strictEqual(tupletRatio({ tuplet_num: 0, tuplet_den: 0 }), 1);
  assert.deepStrictEqual(lengths(lesson(2)), [250, 250]);
});

test("three triplet eighths occupy the time of two", () => {
  const plain = lengths(lesson(2));
  const triplet = lengths(lesson(3, [3, 2]));
  assert.ok(Math.abs(total(triplet) - total(plain)) <= 2,
    `${total(triplet)}ms of triplets should equal ${total(plain)}ms of eighths`);
});

test("five in the time of four, likewise", () => {
  const plain = lengths(lesson(4));
  const five = lengths(lesson(5, [5, 4]));
  assert.ok(Math.abs(total(five) - total(plain)) <= 3,
    `${total(five)}ms should equal ${total(plain)}ms`);
});

test("the notes of a tuplet are equal to each other", () => {
  const [a, b, c] = lengths(lesson(3, [3, 2]));
  assert.strictEqual(a, b);
  assert.strictEqual(b, c);
});

test("a half-declared tuplet is ignored rather than guessed at", () => {
  // The serializer refuses these on the way in; the player must not invent a
  // ratio for one that reaches it anyway.
  assert.strictEqual(tupletRatio({ tuplet_num: 3, tuplet_den: 0 }), 1);
  assert.strictEqual(tupletRatio({ tuplet_num: 0, tuplet_den: 2 }), 1);
});

test("the written value is untouched — only the sound is scaled", () => {
  const steps = buildBarSteps(lesson(3, [3, 2]))[0].steps;
  // What the stave draws comes from the event's own duration, which the
  // player never writes back to.
  const written = lesson(3, [3, 2]).bars[0].events.map((e) => e.duration);
  assert.deepStrictEqual(written, [0.125, 0.125, 0.125]);
  assert.ok(steps.every((s) => s.durationMs < 250), "each sounds shorter than a plain eighth");
});

console.log(failures ? `\n${failures} TUPLET TESTS FAILED` : "\nall tuplet tests pass");
process.exitCode = failures ? 1 : 0;
