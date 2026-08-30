import { sing, analyse, SR } from "./synth.mjs";
const JS = "../../apps/rea_frontend/static/rea_frontend/js/";
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const pd = await import(JS + "pitchDetector.js");
const LOOK = ((2048 - 512) / SR) * 1000;

function strengthOf(notes) {
  const { signal, sampleRate, marks } = sing(notes, { sampleRate: SR });
  const frames = analyse(signal, sampleRate, pd.Mpm, pd.makeOnsetDetector);
  const bounds = marks.slice(1).map((m) => (m.startSample / sampleRate) * 1000);
  const endMs = notes.reduce((n, x) => n + x.ms + (x.gapMs || 0), 0) - 140;
  // The quantity the segmenter actually tests: strength summed over frames with
  // an exponential decay, so one attack smeared across frames counts once, in
  // full, whatever the frame boundaries did to it.
  const DECAY_MS = Number(process.env.DECAY || 90);
  let acc = 0, atBoundary = 0, elsewhere = 0, peakAcc = 0;
  for (const f of frames) {
    acc = acc * Math.exp(-16.7 / DECAY_MS) + f.onsetStrength;
    const a = f.t + LOOK;
    peakAcc = Math.max(peakAcc, acc);
    if (a < 240 || a > endMs) continue;
    if (bounds.some((b) => Math.abs(a - b) <= 110)) atBoundary = Math.max(atBoundary, acc);
    else elsewhere = Math.max(elsewhere, acc);
  }
  return { atBoundary, elsewhere };
}

const cases = {
  "repeat hard 500ms": [{ midi: 60, ms: 500, artic: "hard" }, { midi: 60, ms: 500, artic: "hard" }],
  "repeat hard 420ms": [{ midi: 62, ms: 420, artic: "hard" }, { midi: 62, ms: 420, artic: "hard" }],
  "repeat soft": [{ midi: 60, ms: 500, artic: "soft" }, { midi: 60, ms: 500, artic: "soft" }],
  "repeat, quiet voice": [{ midi: 60, ms: 500, artic: "hard", amp: 0.03 }, { midi: 60, ms: 500, artic: "hard", amp: 0.03 }],
  "repeat while wobbling": [{ midi: 65, ms: 600, artic: "hard", vibCents: 55 }, { midi: 65, ms: 600, artic: "hard", vibCents: 55 }],
  "repeat, slow (900ms)": [{ midi: 60, ms: 900, artic: "hard" }, { midi: 60, ms: 900, artic: "hard" }],
  "-- vibrato only": [{ midi: 67, ms: 1400, artic: "hard", vibCents: 45 }],
  "-- wide vibrato only": [{ midi: 67, ms: 1400, artic: "hard", vibCents: 80 }],
  "-- scoop only": [{ midi: 64, ms: 900, artic: "soft", scoopCents: 140 }],
  "-- legato slide": [{ midi: 60, ms: 520, artic: "hard" }, { midi: 62, ms: 520, artic: "legato", slideFrom: 60 }],
};
console.log("case                        strength@boundary   max elsewhere");
for (const [name, notes] of Object.entries(cases)) {
  const r = strengthOf(notes);
  console.log(name.padEnd(26), r.atBoundary.toFixed(2).padStart(12), r.elsewhere.toFixed(2).padStart(16));
}
