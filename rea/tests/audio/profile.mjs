/**
 * The voice profile measured by the soundcheck, and what it does for the flow.
 *
 * A singer with a wide vibrato and a singer with none should both be followed
 * well, and neither should inherit an allowance made for the other.  Without a
 * profile the exercise uses one middling default, which is too tight for the
 * first and too loose for the second — and the first note of a bar, before any
 * vibrato can be measured live, is exactly where that costs alignment.
 */
import { sing, analyse, SR } from "./synth.mjs";
const JS = "../../apps/rea_frontend/static/rea_frontend/js/";
import "./env.mjs";
const pd = await import(JS + "pitchDetector.js");
const pc = await import(JS + "practiceController.js");
const sc = await import(JS + "views/soundcheckView.js");

let pass = 0, total = 0;
const ok = (name, cond, detail) => {
  total++; if (cond) pass++;
  console.log((cond ? "  PASS  " : "  FAIL  ") + name);
  if (detail) console.log("          " + detail);
};

// --- the measurement itself ------------------------------------------------
function soundcheckRun(vibCents) {
  const { signal, sampleRate } = sing([{ midi: 60, ms: 2500, artic: "hard", vibCents }], { sampleRate: SR });
  const frames = analyse(signal, sampleRate, pd.Mpm, pd.makeOnsetDetector);
  const run = { singStartT: 0, pitchSeries: [], strengths: [] };
  for (const f of frames) {
    run.strengths.push({ t: f.t, v: f.onsetStrength });
    if (f.midi != null) run.pitchSeries.push({ t: f.t, midi: f.midi });
  }
  return sc.measureVoiceProfile(run);
}

const wide = soundcheckRun(80);
const none = soundcheckRun(0);
ok("a wide vibrato is measured as wide", wide.vibratoOk && wide.vibratoCents > 45,
   `measured ${wide.vibratoCents.toFixed(0)} cents (sung with 80)`);
ok("a steady voice is measured as steady", none.vibratoOk && none.vibratoCents < 20,
   `measured ${none.vibratoCents.toFixed(0)} cents (sung dead steady)`);
ok("an articulation floor is measured", wide.floorOk && wide.onsetFloor >= 0,
   `wide vibrato floor ${wide.onsetFloor.toFixed(2)}, steady floor ${none.onsetFloor.toFixed(2)}`);

// --- what it does for the exercise -----------------------------------------
// A wide-vibrato singer, on the FIRST note of a bar, before any live vibrato
// estimate exists.
function firstNoteSurvives(profileCents) {
  const { signal, sampleRate } = sing([
    { midi: 60, ms: 1100, artic: "hard", vibCents: 80 },
    { midi: 64, ms: 700, artic: "hard" },
  ], { sampleRate: SR });
  const frames = analyse(signal, sampleRate, pd.Mpm, pd.makeOnsetDetector);
  const seg = pc.makeNoteSegmenter({ paceMs: 600, vibratoCents: profileCents });
  const notes = [];
  for (const f of frames) {
    const r = seg.feed({ midi: f.midi, onsetStrength: f.onsetStrength, t: f.t, dt: 16.7 });
    if (r.ended) notes.push(Number(r.ended.midi.toFixed(2)));
  }
  const tail = seg.feed({ midi: null, onsetStrength: 0, t: frames[frames.length - 1].t + 400, dt: 400 });
  if (tail.ended) notes.push(Number(tail.ended.midi.toFixed(2)));
  return notes;
}
const withProfile = firstNoteSurvives(wide.vibratoCents);
ok("a wide-vibrato singer's first note stays one note", withProfile.length === 2,
   `detected ${JSON.stringify(withProfile)} (sang two notes)`);

console.log("\n" + pass + "/" + total + " voice-profile cases pass");
