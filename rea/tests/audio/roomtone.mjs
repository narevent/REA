/**
 * Silence, in a room that is not silent.
 *
 * Every other file here drives `Mpm` and the onset detector directly, which
 * skips the whole of `PitchDetector._process` — the gate, the voicing machine,
 * the median, the smoother.  That is where the worst bug in the singing
 * exercises was living, and nothing could have caught it.
 *
 * A recording of somebody actually singing an exercise showed the room's own
 * floor at about −48 dBFS, comfortably *above* the gate the app uses when
 * nobody has run the calibration.  The tracker found a periodicity in the
 * rumble at around 65 Hz and reported it, frame after frame, steadily enough
 * that the segmenter called it a held note — so the pause while the student
 * worked out the interval became a note at B1, and it answered the reference
 * they had not sung yet.  On four of that recording's nine bars the first
 * reference was answered before the singer opened their mouth, one of them
 * eighteen semitones out.  From their side: the highlight moves on its own.
 *
 * So these run the real detector, over singing with a real room under it.
 *
 *   node rea/tests/audio/roomtone.mjs
 */
import { sing, SR } from "./synth.mjs";
import "./env.mjs";
const JS = "../../apps/rea_frontend/static/rea_frontend/js/";
const pd = await import(JS + "pitchDetector.js");
const pc = await import(JS + "practiceController.js");

const HOP_MS = 16.7;

/** Drive the whole detector over a signal, as the live loop does. */
function detect(signal) {
  const det = new pd.PitchDetector();
  det.mpm = new pd.Mpm(SR, det.windowSize, det.minHz, det.maxHz,
                       det.clarityThreshold, det.peakThreshold);
  det._resetSmoothing();
  const frames = [];
  det.onPitch = (info) => frames.push(info);
  const buf = new Float32Array(det.windowSize);
  const hop = Math.round((HOP_MS * SR) / 1000);
  for (let start = 0, t = 0; start + det.windowSize <= signal.length; start += hop, t += HOP_MS) {
    buf.set(signal.subarray(start, start + det.windowSize));
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    det._process(det.mpm.detect(buf), t, Math.sqrt(sum / buf.length));
  }
  return frames;
}

/** Frames well inside a silent stretch — not the ones on its edges, where the
 *  analysis window still holds part of a note and the level is neither one
 *  thing nor the other.
 *
 *  The margin has to clear the analysis window (4096 samples, 93 ms) *and* the
 *  release: a singer takes about a tenth of a second to let a note go, so a
 *  frame a hundred milliseconds after the last loud one is still looking at
 *  mostly note.  Judging it as room asks the gate to reject the singer. */
const EDGE_FRAMES = 9;
function wellInsideGaps(frames, loud) {
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].rms >= loud) continue;
    const near = frames.slice(Math.max(0, i - EDGE_FRAMES), i + EDGE_FRAMES + 1)
      .some((f) => f.rms >= loud);
    if (!near) out.push(frames[i]);
  }
  return out;
}

let pass = 0, total = 0;
const T = (name, ok, detail) => {
  total++; if (ok) pass++;
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "\n          " + detail : ""));
};

// The levels are the ones measured on the real recording: a room at about
// 0.004 rms under singing at about 0.12.
const ROOM = 0.004;

// --- a room, and nothing else ----------------------------------------------

{
  // Two seconds of nobody singing.  Not one frame of it is a note.
  const { signal } = sing([{ midi: 60, ms: 10, amp: 0.0001 }], { roomTone: ROOM });
  const bed = new Float32Array(SR * 2);
  for (let i = 0; i < bed.length; i++) bed[i] = signal[i % signal.length];
  const frames = detect(bed);
  const voiced = frames.filter((f) => f.midi != null).length;
  T("an empty room is not a note", voiced === 0,
    voiced + "/" + frames.length + " frames tracked a pitch");
}

// --- a room with somebody singing in it -------------------------------------

{
  const { signal } = sing([
    { midi: 60, ms: 900, artic: "hard", gapMs: 900 },
    { midi: 64, ms: 900, artic: "hard", gapMs: 900 },
    { midi: 67, ms: 900, artic: "hard", gapMs: 900 },
  ], { roomTone: ROOM });
  const frames = detect(signal);
  const loud = frames.filter((f) => f.rms > 0.02);
  const quiet = wellInsideGaps(frames, 0.02);
  const sungTracked = loud.filter((f) => f.midi != null).length;
  const quietTracked = quiet.filter((f) => f.midi != null).length;
  T("the singing is tracked", sungTracked > loud.length * 0.8,
    sungTracked + "/" + loud.length + " frames of singing tracked");
  T("the room between the notes is not", quietTracked === 0,
    quietTracked + "/" + quiet.length + " frames of room tracked");

  // And the thing that actually goes wrong when it is: the exercise answers
  // its first reference before the singer has sung anything.
  const ctrl = Object.create(pc.PracticeController.prototype);
  ctrl.running = true; ctrl.renderer = null;
  const answered = [];
  const handler = ctrl._makeLiveCapture(0, [60, 64, 67], {
    noteMs: 900,
    onNote: () => {},
    onNoteDone: (i, n) => { answered[i] = n.midi; },
    onComplete: () => {},
  });
  for (const f of frames) {
    handler({ midi: f.midi, onsetStrength: f.onsetStrength, onsetAttack: f.onsetAttack, t: f.t });
  }
  const got = [60, 64, 67].map((_, i) => (answered[i] == null ? null : answered[i]));
  const ok = got.every((g, i) => g != null && Math.abs(g - [60, 64, 67][i]) * 100 <= 60);
  T("every reference is answered by the singing, not by the room", ok,
    "answered " + got.map((g) => (g == null ? "--" : g.toFixed(2))).join("  "));
}

// --- a singer who waits before starting -------------------------------------

{
  // The case from the recording: the bar has been played, the exercise is
  // listening, and the student spends a second working out the interval before
  // they sing.  That second must cost them nothing.
  const { signal } = sing([
    { midi: 62, ms: 20, amp: 0.0001, gapMs: 1200 },
    { midi: 62, ms: 900, artic: "hard" },
  ], { roomTone: ROOM });
  const frames = detect(signal);
  const ctrl = Object.create(pc.PracticeController.prototype);
  ctrl.running = true; ctrl.renderer = null;
  let first = null;
  const handler = ctrl._makeLiveCapture(0, [62], {
    noteMs: 600,
    onNote: () => {},
    onNoteDone: (i, n) => { if (first == null) first = n.midi; },
    onComplete: () => {},
  });
  for (const f of frames) {
    handler({ midi: f.midi, onsetStrength: f.onsetStrength, onsetAttack: f.onsetAttack, t: f.t });
  }
  T("thinking time is not an answer", first != null && Math.abs(first - 62) * 100 <= 60,
    "answered with " + (first == null ? "nothing" : first.toFixed(2)));
}

// --- a louder room ----------------------------------------------------------

{
  // Four times the noise.  A fixed gate cannot follow this; the point of
  // measuring the room is that it does.
  const { signal } = sing([
    { midi: 65, ms: 900, artic: "hard", gapMs: 900 },
    { midi: 69, ms: 900, artic: "hard", gapMs: 900 },
  ], { roomTone: ROOM * 4 });
  const frames = detect(signal);
  const quiet = wellInsideGaps(frames, 0.05);
  const quietTracked = quiet.filter((f) => f.midi != null).length;
  T("a noisier room is followed, not fought", quietTracked === 0,
    quietTracked + "/" + quiet.length + " frames of room tracked");
}

console.log("\n" + pass + "/" + total + " room-tone cases pass");
