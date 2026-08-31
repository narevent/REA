/**
 * The MIDI importer: reading a Standard MIDI File into bars of a score.
 *
 *   node rea/tests/editor/midi.mjs
 *
 * Two things are worth asserting here and nothing else really is.
 *
 * The first is the *round trip*.  A pitch spelled by the importer has to
 * resolve, through the app's own `noteNameToMidi`, back to the pitch that came
 * out of the file — in a flat key, in a sharp key, and with no key signature
 * at all, because the spelling rule differs in each and a note written a
 * semitone from where it sounds is the one import bug a teacher would not
 * think to look for.  It is checked across the whole singable range rather
 * than on examples: the mapping is arithmetic, so exhaustive is cheap.
 *
 * The second is the *reduction*.  The importer is deliberately lossy — chords
 * become their top note, gaps become rests, performed lengths snap to written
 * ones, notes are cut at barlines — and every one of those is a decision a
 * teacher is told about in the import summary.  A fixture built here note by
 * note pins what each of them does.
 */
import assert from "node:assert";
import { parseMidi, midiToBars, midiToToken } from
  "../../apps/rea_frontend/static/rea_frontend/js/editor/midiImport.js";
import { noteNameToMidi, keySignatureMap } from
  "../../apps/rea_frontend/static/rea_frontend/js/notation.js";

let failures = 0;
function test(name, fn) {
  try { fn(); console.log("  ok   " + name); }
  catch (e) { failures += 1; console.log("  FAIL " + name + " — " + e.message); }
}

// ---------------------------------------------------------------------------
// A MIDI file, written by hand
// ---------------------------------------------------------------------------

const TPQ = 480;

function vlq(n) {
  const out = [n & 0x7f];
  n >>= 7;
  while (n) { out.push((n & 0x7f) | 0x80); n >>= 7; }
  return out.reverse();
}

function chunk(id, bytes) {
  const len = bytes.length;
  return [...id].map((c) => c.charCodeAt(0))
    .concat([(len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff])
    .concat(bytes);
}

/** `events` are `{ delta, bytes }`; the end-of-track meta is added here. */
function track(events) {
  const body = events.flatMap((e) => vlq(e.delta).concat(e.bytes));
  return chunk("MTrk", body.concat(vlq(0), [0xff, 0x2f, 0x00]));
}

function buildFile({ bpm = 100, numerator = 3, denominator = 4, notes }) {
  const usPerQuarter = Math.round(60000000 / bpm);
  const meta = track([
    { delta: 0, bytes: [0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff] },
    { delta: 0, bytes: [0xff, 0x58, 0x04, numerator, Math.log2(denominator), 24, 8] },
  ]);
  // `notes` are `{ at, midi, length, velocity }` in ticks; turned into
  // note-on/note-off pairs on one track, in the order given.
  const events = [];
  let now = 0;
  const pending = [];
  notes.forEach((n) => { pending.push({ t: n.at, on: true, n }, { t: n.at + n.length, on: false, n }); });
  pending.sort((a, b) => a.t - b.t || (a.on ? 1 : -1));
  pending.forEach((p) => {
    events.push({ delta: p.t - now, bytes: [0x90, p.n.midi, p.on ? (p.n.velocity || 100) : 0] });
    now = p.t;
  });
  // format 1, two tracks, `TPQ` ticks per quarter.  `chunk` writes the length.
  const header = chunk("MThd", [0, 1, 0, 2, (TPQ >> 8) & 0xff, TPQ & 0xff]);
  const bytes = Uint8Array.from(header.concat(meta).concat(track(events)));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// ---------------------------------------------------------------------------

console.log("MIDI import");

const A_MAJOR = [{ letter: "f", offset: 1 }, { letter: "c", offset: 1 }, { letter: "g", offset: 1 }];
const E_FLAT = [{ letter: "h", offset: -1 }, { letter: "e", offset: -1 }, { letter: "a", offset: -1 }];

for (const [name, key] of [["no key signature", []], ["A major", A_MAJOR], ["E-flat major", E_FLAT]]) {
  test(`every pitch round-trips — ${name}`, () => {
    const map = keySignatureMap(key);
    // MIDI 48 (C3) is the lowest pitch the source's note tokens can name: the
    // octave digit is an index where 0 means the C3 octave, and there is no
    // way to write one below it.
    for (let midi = 48; midi <= 96; midi += 1) {
      const token = midiToToken(midi, key);
      assert.ok(token, `no spelling for MIDI ${midi}`);
      assert.strictEqual(noteNameToMidi(token.name, map), midi,
        `MIDI ${midi} spelled "${token.name}" reads back as ${noteNameToMidi(token.name, map)}`);
    }
  });
}

test("a note the key already alters needs no accidental", () => {
  // C-sharp in A major is written `c1`: the key signature supplies the sharp.
  assert.strictEqual(midiToToken(61, A_MAJOR).name, "c1");
  // ...and the same pitch in a key without it has to say so.
  assert.strictEqual(midiToToken(61, []).name, "c1#");
});

test("a note the key alters but the melody does not is naturalised", () => {
  // F-natural in A major, whose signature sharpens every F.
  assert.strictEqual(midiToToken(65, A_MAJOR).name, "f1r");
});

test("spelling follows the key: flats in a flat key, sharps otherwise", () => {
  assert.strictEqual(midiToToken(63, E_FLAT).name, "e1");    // E-flat, from the signature
  assert.strictEqual(midiToToken(63, []).name, "d1#");
  assert.strictEqual(midiToToken(66, E_FLAT).name, "g1b");
});

test("bars are cut at the file's time signature", () => {
  // Nine quarter notes in 3/4 is three bars of three.
  const notes = [];
  for (let i = 0; i < 9; i += 1) notes.push({ at: i * TPQ, midi: 60 + i, length: TPQ });
  const parsed = parseMidi(buildFile({ notes }));
  assert.strictEqual(parsed.ticksPerQuarter, TPQ);
  assert.strictEqual(parsed.tempoBpm, 100);
  assert.deepStrictEqual(parsed.timeSignature, { numerator: 3, denominator: 4 });
  const { bars, report } = midiToBars(parsed, { system: "absolute", keySignature: [] });
  assert.strictEqual(bars.length, 3);
  bars.forEach((bar) => assert.strictEqual(bar.events.length, 3));
  assert.strictEqual(report.notes, 9);
});

test("notes sounding together become their top note", () => {
  const parsed = parseMidi(buildFile({
    notes: [
      { at: 0, midi: 60, length: TPQ },
      { at: 0, midi: 64, length: TPQ },
      { at: 0, midi: 67, length: TPQ },
      { at: TPQ, midi: 62, length: TPQ },
    ],
  }));
  const { bars, report } = midiToBars(parsed, { system: "absolute", keySignature: [] });
  assert.strictEqual(report.notes, 2);
  assert.strictEqual(report.chords, 2);
  assert.strictEqual(bars[0].events[0].note_name, "g1");   // the top of C-E-G
  assert.strictEqual(bars[0].events[1].note_name, "d1");
});

test("a gap long enough to write becomes a rest, a shorter one does not", () => {
  const parsed = parseMidi(buildFile({
    notes: [
      { at: 0, midi: 60, length: TPQ },
      { at: TPQ * 2, midi: 62, length: TPQ },        // a quarter's silence
    ],
  }));
  const { bars, report } = midiToBars(parsed, { system: "absolute", keySignature: [] });
  assert.strictEqual(report.rests, 1);
  assert.strictEqual(bars[0].events[1].is_rest, true);

  // Detached playing — a note released a hair early — is articulation, and
  // writing a rest for it would make every staccato phrase unreadable.
  const staccato = parseMidi(buildFile({
    notes: [
      { at: 0, midi: 60, length: TPQ - 20 },
      { at: TPQ, midi: 62, length: TPQ - 20 },
    ],
  }));
  assert.strictEqual(midiToBars(staccato, { system: "absolute", keySignature: [] }).report.rests, 0);
});

test("a performed length snaps to a written note value", () => {
  // A quarter note played 6% long is still a quarter note.
  const parsed = parseMidi(buildFile({ notes: [{ at: 0, midi: 60, length: Math.round(TPQ * 1.06) }] }));
  const { bars } = midiToBars(parsed, { system: "absolute", keySignature: [] });
  assert.strictEqual(bars[0].events[0].duration, 0.25);
});

test("a note is clipped at the barline it would cross", () => {
  // A whole note starting on beat 3 of a 3/4 bar has one beat of room.
  const parsed = parseMidi(buildFile({ notes: [{ at: TPQ * 2, midi: 60, length: TPQ * 4 }] }));
  const { bars, report } = midiToBars(parsed, { system: "absolute", keySignature: [] });
  assert.strictEqual(report.clipped, 1);
  assert.strictEqual(bars[0].events[0].duration, 0.25);
});

test("velocity carries across as the score's volume", () => {
  // Both are on MIDI's 0-127 scale, so the number is the same number.
  const parsed = parseMidi(buildFile({ notes: [
    { at: 0, midi: 60, length: TPQ, velocity: 127 },
    { at: TPQ, midi: 62, length: TPQ, velocity: 64 },
  ] }));
  const { bars } = midiToBars(parsed, { system: "absolute", keySignature: [] });
  assert.strictEqual(bars[0].events[0].volume, 127);
  assert.strictEqual(bars[0].events[1].volume, 64);
});

test("an imported bar inherits the open score's clef and key chord", () => {
  const parsed = parseMidi(buildFile({ notes: [{ at: 0, midi: 60, length: TPQ }] }));
  const template = { music_clef: "Bass", music_rhythm: "FreeStyle", music_mode_chord: "A_Major" };
  const { bars } = midiToBars(parsed, { system: "relative", keySignature: [], template });
  assert.strictEqual(bars[0].music_clef, "Bass");
  assert.strictEqual(bars[0].music_mode_chord, "A_Major");
});

test("a pitch below what a token can name is dropped, and counted", () => {
  assert.strictEqual(midiToToken(47, []), null);
  const parsed = parseMidi(buildFile({
    notes: [{ at: 0, midi: 36, length: TPQ }, { at: TPQ, midi: 60, length: TPQ }],
  }));
  const { report } = midiToBars(parsed, { system: "absolute", keySignature: [] });
  assert.strictEqual(report.skipped, 1);
  assert.strictEqual(report.notes, 1);
});

test("a file with nothing importable in it says so", () => {
  assert.throws(() => parseMidi(new Uint8Array([1, 2, 3]).buffer), /MIDI file/);
  assert.throws(() => parseMidi(buildFile({ notes: [] })), /no notes/);
});

console.log(failures ? `\n${failures} MIDI IMPORT TESTS FAILED` : "\nall MIDI import tests pass");
process.exitCode = failures ? 1 : 0;
