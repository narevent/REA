/**
 * MusicXML in and out: a score from another notation program arrives intact,
 * and one written here survives the trip out and back.
 *
 *   node rea/tests/dictation/musicxml.mjs
 */
import assert from "node:assert";

const S = await import("../../apps/rea_frontend/static/rea_frontend/js/dictation/score.js");
const X = await import("../../apps/rea_frontend/static/rea_frontend/js/dictation/musicxml.js");

let failures = 0;
function test(name, fn) {
  try { fn(); console.log("  ok   " + name); }
  catch (e) { failures += 1; console.log("  FAIL " + name + " — " + e.message); }
}
const shape = (events) => events.map((e) => (e.rest ? "r" : e.pitches.map((p) => p.step + (p.alter > 0 ? "#" : p.alter < 0 ? "b" : "") + p.octave).join("+")) + ":" + e.dur + ".".repeat(e.dots || 0) + (e.pitches.some((p) => p.tie) ? "~" : ""));

// Roughly what MuseScore writes: a piano part on two staves, voice 2 on the
// upper staff after a <backup>, a chord, a tie over the barline, a dynamic,
// a crescendo, a repeat with first and second endings.
const MUSESCORE = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <work><work-title>Little Piece &amp; Co</work-title></work>
  <identification><creator type="composer">Anon.</creator></identification>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <barline location="left"><repeat direction="forward"/></barline>
      <attributes><divisions>2</divisions><key><fifths>1</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time>
        <staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>
      <direction placement="below"><direction-type><dynamics><mf/></dynamics></direction-type><staff>1</staff></direction>
      <direction placement="below"><direction-type><wedge type="crescendo"/></direction-type><staff>1</staff></direction>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><chord/><pitch><step>B</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type><staff>1</staff><notations><slur type="start"/></notations></note>
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type><staff>1</staff><notations><slur type="stop"/><articulations><staccato/></articulations></notations></note>
      <direction><direction-type><wedge type="stop"/></direction-type><staff>1</staff></direction>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><tie type="start"/><voice>1</voice><type>quarter</type><staff>1</staff><notations><tied type="start"/></notations></note>
      <backup><duration>6</duration></backup>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>6</duration><voice>2</voice><type>half</type><dot/><staff>1</staff></note>
      <backup><duration>6</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>6</duration><voice>5</voice><type>half</type><dot/><staff>2</staff></note>
    </measure>
    <measure number="2">
      <barline location="left"><ending number="1" type="start"/></barline>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><tie type="stop"/><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><rest/><duration>4</duration><voice>1</voice><type>half</type><staff>1</staff></note>
      <backup><duration>6</duration></backup>
      <note><rest measure="yes"/><duration>6</duration><voice>5</voice><staff>2</staff></note>
      <barline location="right"><bar-style>light-heavy</bar-style><ending number="1" type="stop"/><repeat direction="backward"/></barline>
    </measure>
    <measure number="3">
      <barline location="left"><ending number="2" type="start"/></barline>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>6</duration><voice>1</voice><type>half</type><dot/><staff>1</staff><notations><fermata/></notations></note>
      <backup><duration>6</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>6</duration><voice>5</voice><type>half</type><dot/><staff>2</staff></note>
      <barline location="right"><bar-style>light-heavy</bar-style><ending number="2" type="discontinue"/></barline>
    </measure>
  </part>
</score-partwise>`;

console.log("MusicXML");

test("a MuseScore file comes in with its title, parts and attributes", () => {
  const { title, composer, score } = X.readMusicXml(MUSESCORE);
  assert.strictEqual(title, "Little Piece & Co");
  assert.strictEqual(composer, "Anon.");
  assert.strictEqual(score.parts.length, 1);
  assert.deepStrictEqual(score.parts[0].staves.map((s) => s.clef), ["treble", "bass"]);
  assert.deepStrictEqual(score.measures[0].time, [3, 4]);
  assert.strictEqual(score.measures[0].key, 1);
});

test("notes, chords, voices and staves land where they were", () => {
  const { score } = X.readMusicXml(MUSESCORE);
  const [upper, lower] = S.staves(score).map((s) => s.key);
  assert.deepStrictEqual(shape(score.measures[0].staves[upper].voices[0]), ["G4+B4:q", "A4:8", "F#4:8", "D5:q~"]);
  assert.deepStrictEqual(shape(score.measures[0].staves[upper].voices[1]), ["D4:h."]);
  assert.deepStrictEqual(shape(score.measures[0].staves[lower].voices[0]), ["G2:h."]);
  assert.deepStrictEqual(shape(score.measures[1].staves[upper].voices[0]), ["D5:q", "r:h"]);
});

test("marks, ties and barlines come with them", () => {
  const { score } = X.readMusicXml(MUSESCORE);
  const upper = S.staves(score)[0].key;
  const m1 = score.measures[0].staves[upper].voices[0];
  assert.strictEqual(m1[0].dyn, "mf");
  assert.strictEqual(m1[0].hairpin, "<");
  assert.strictEqual(m1[1].slur, true);
  assert.strictEqual(m1[2].slurEnd, true);
  assert.deepStrictEqual(m1[2].art, ["staccato"]);
  assert.strictEqual(m1[3].pitches[0].tie, true);
  assert.strictEqual(score.measures[0].repeatStart, true);
  assert.strictEqual(score.measures[1].repeatEnd, true);
  assert.deepStrictEqual(score.measures[1].volta, [1]);
  assert.deepStrictEqual(score.measures[2].volta, [2]);
  assert.deepStrictEqual(score.measures[2].staves[upper].voices[0][0].art, ["fermata"]);
  assert.deepStrictEqual(S.playOrder(score), [0, 1, 0, 2]);
});

test("a score written here survives the trip out and back", () => {
  const score = S.newScore({ instruments: ["piano", "violin"], time: [6, 8], key: -3, measures: 2, tempo: 72 });
  const [upper, lower, violin] = S.staves(score).map((s) => s.key);
  const at = (staffKey, tick, voice = 0) => ({ mi: 0, staffKey, voice, tick });
  const a = S.writeNote(score, at(upper, 0), { pitches: [{ step: "E", alter: -1, octave: 5 }], dur: "q", dots: 1 });
  S.addPitch(score, a, { step: "G", alter: 0, octave: 5 });
  S.writeNote(score, at(upper, 720), { pitches: [{ step: "C", alter: 0, octave: 5 }], dur: "q", dots: 1 });
  S.writeNote(score, at(lower, 0), { pitches: [{ step: "E", alter: -1, octave: 3 }], dur: "h", dots: 1 });
  S.writeNote(score, at(violin, 0), { pitches: [{ step: "B", alter: -1, octave: 4 }], dur: "8" });
  S.setEventProps(score, [a], { dyn: "p" });
  score.measures[1].repeatEnd = true;
  score.measures[1].nav = "dcalfine";
  const xml = X.writeMusicXml({ title: "Round trip", composer: "Me", score });
  const back = X.readMusicXml(xml);
  assert.strictEqual(back.title, "Round trip");
  assert.strictEqual(back.score.tempo, 72);
  assert.deepStrictEqual(back.score.measures[0].time, [6, 8]);
  assert.strictEqual(back.score.measures[0].key, -3);
  const keys = S.staves(back.score).map((s) => s.key);
  assert.deepStrictEqual(shape(back.score.measures[0].staves[keys[0]].voices[0]), shape(score.measures[0].staves[upper].voices[0]));
  assert.deepStrictEqual(shape(back.score.measures[0].staves[keys[1]].voices[0]), shape(score.measures[0].staves[lower].voices[0]));
  assert.deepStrictEqual(shape(back.score.measures[0].staves[keys[2]].voices[0]), shape(score.measures[0].staves[violin].voices[0]));
  assert.strictEqual(back.score.measures[0].staves[keys[0]].voices[0][0].dyn, "p");
  assert.strictEqual(back.score.measures[1].repeatEnd, true);
  assert.strictEqual(back.score.measures[1].nav, "dcalfine");
});

test("something that is not a score is refused with a reason", () => {
  assert.throws(() => X.readMusicXml("<html><body/></html>"), /not a MusicXML score/);
});

console.log(failures ? `\n${failures} MusicXML test(s) FAILED` : "\nall MusicXML tests pass");
process.exitCode = failures ? 1 : 0;
