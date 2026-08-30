import { sing, SR } from "./synth.mjs";
const JS = "../../apps/rea_frontend/static/rea_frontend/js/";
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const pd = await import(JS + "pitchDetector.js");
const win = 2048, LOOK = ((win - 512) / SR) * 1000;

function fluxOf(notes) {
  const { signal, sampleRate, marks } = sing(notes, { sampleRate: SR });
  const hop = Math.round(16.7 * sampleRate / 1000);
  const mpm = new pd.Mpm(sampleRate, win, 60, 1600, 0.5, 0.85);
  const buf = new Float32Array(win);
  const bounds = marks.slice(1).map((m) => (m.startSample / sampleRate) * 1000);
  // Exclude the run-out: the last note fading into silence is a huge spectral
  // change, but it is the end of the take, not a note boundary.
  const endMs = notes.reduce((n, x) => n + x.ms + (x.gapMs || 0), 0) - 140;
  let nearMax = 0, farMax = 0;
  for (let start = 0, t = 0; start + win <= signal.length; start += hop, t += 16.7) {
    buf.set(signal.subarray(start, start + win));
    let sum = 0; for (let i = 0; i < win; i++) sum += buf[i] * buf[i];
    if (Math.sqrt(sum / win) < 0.004) { mpm.detect(buf); continue; }
    mpm.detect(buf);
    const audioT = t + LOOK;
    if (audioT < 220 || audioT > endMs) continue;     // skip the first attack and the run-out
    const near = bounds.some((b) => Math.abs(audioT - b) <= 70);
    if (near) nearMax = Math.max(nearMax, mpm.flux);
    else farMax = Math.max(farMax, mpm.flux);
  }
  return { nearMax, farMax };
}

const cases = {
  "repeat (hard)": [{ midi: 60, ms: 500, artic: "hard" }, { midi: 60, ms: 500, artic: "hard" }],
  "repeat (soft)": [{ midi: 60, ms: 500, artic: "soft" }, { midi: 60, ms: 500, artic: "soft" }],
  "vibrato sustain": [{ midi: 67, ms: 1400, artic: "hard", vibCents: 45 }],
  "wide vibrato": [{ midi: 67, ms: 1400, artic: "hard", vibCents: 80 }],
  "legato slide": [{ midi: 60, ms: 520, artic: "hard" }, { midi: 62, ms: 520, artic: "legato", slideFrom: 60 }],
  "scoop": [{ midi: 64, ms: 900, artic: "soft", scoopCents: 140 }],
  "quiet repeat": [{ midi: 60, ms: 500, artic: "hard", amp: 0.03 }, { midi: 60, ms: 500, artic: "hard", amp: 0.03 }],
};
console.log("case                  flux@boundary   flux elsewhere");
for (const [name, notes] of Object.entries(cases)) {
  const r = fluxOf(notes);
  console.log(name.padEnd(20), r.nearMax.toFixed(4).padStart(12), r.farMax.toFixed(4).padStart(16));
}
