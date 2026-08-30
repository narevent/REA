/**
 * End-to-end: synthesised singing -> Mpm + onset detector -> note segmenter.
 * Reports the notes the app would have scored, against the notes that were sung.
 */
import { sing, analyse, SR } from "./synth.mjs";
const JS = "../../apps/rea_frontend/static/rea_frontend/js/";
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const pd = await import(JS + "pitchDetector.js");
const pc = await import(JS + "practiceController.js");

// The flux window sits at the END of the analysis buffer, so a frame stamped
// `t` is looking at audio around t + (W - fluxN/2)/sr.  Report that, or every
// onset looks early by a window.
const LOOKAHEAD_MS = ((2048 - 512) / SR) * 1000;

export function runCase(name, notes, expect) {
  const { signal, sampleRate, marks } = sing(notes, { sampleRate: SR });
  const frames = analyse(signal, sampleRate, pd.Mpm, pd.makeOnsetDetector);
  const seg = pc.makeNoteSegmenter();
  const got = [];
  for (const f of frames) {
    const r = seg.feed({ midi: f.midi, onsetStrength: f.onsetStrength, t: f.t, dt: 16.7 });
    if (r.ended) got.push({ midi: r.ended.midi, durMs: r.ended.durMs, at: r.ended.startT });
  }
  const tail = seg.feed({ midi: null, onsetStrength: 0, t: frames[frames.length - 1].t + 200, dt: 200 });
  if (tail.ended) got.push({ midi: tail.ended.midi, durMs: tail.ended.durMs, at: tail.ended.startT });

  const sungMidis = marks.map((m) => m.midi);
  const gotMidis = got.map((g) => Number(g.midi.toFixed(2)));
  const countOk = got.length === sungMidis.length;
  const pitchOk = countOk && got.every((g, i) => Math.abs(g.midi - sungMidis[i]) * 100 <= 35);
  const ok = countOk && pitchOk;
  console.log((ok ? "  PASS  " : "  FAIL  ") + name);
  console.log("          sung:     " + JSON.stringify(sungMidis));
  console.log("          detected: " + JSON.stringify(gotMidis));
  if (!ok) {
    console.log("          starts(ms): " + JSON.stringify(got.map((g) => Math.round(g.at + LOOKAHEAD_MS))));
    console.log("          onsets(ms): " + JSON.stringify(
      frames.filter((f) => f.onset).map((f) => Math.round(f.t + LOOKAHEAD_MS))));
  }
  return ok;
}
