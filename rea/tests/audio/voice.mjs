/**
 * A voice that is not sure of the note.
 *
 * Everything else here sings well.  The notes are steady, they are the length
 * they are written, and they arrive where they are aimed — and against singing
 * like that the exercise looked fine while being, on a recording of somebody
 * actually working through a bar, wrong about more than half of what they
 * sang.  This file is the singing that showed it up, put back in terms the
 * synthesiser can produce, so that none of it can quietly come back.
 *
 * What a learner's voice does, measured over nine bars of one:
 *
 *   the pitch wanders 100-330 cents *inside* one sung note — several times the
 *     tolerance a note is allowed — rising away and sagging back over the whole
 *     length of it;
 *   notes are detached by gaps of 50-100 ms, far under any silence threshold,
 *     and the only trace of the gap is the level;
 *   a note is let go before the next one starts, and the fast envelope falls
 *     6.5-15 dB under the slow one when it is;
 *   the voice crosses between notes at 3500 cents a second and more, an order
 *     of magnitude faster than it wanders within one;
 *   and every note lasts half again to twice what was written.
 *
 * The four cases below are the four ways the exercise broke on that, each of
 * which cost the singer whole references:
 *
 *   a wandering note read as three, spending three references on one note;
 *   detached notes at nearly the same pitch merged into one;
 *   a note credited from the middle of the slide into it;
 *   the pace estimate winding itself away from the written tempo.
 *
 *   node rea/tests/audio/voice.mjs
 */
import { sing, analyse, SR } from "./synth.mjs";
const JS = "../../apps/rea_frontend/static/rea_frontend/js/";
import "./env.mjs";
const pd = await import(JS + "pitchDetector.js");
const pc = await import(JS + "practiceController.js");

let pass = 0, total = 0;
const T = (name, ok, detail) => {
  total++; if (ok) pass++;
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "\n          " + detail : ""));
};

/** The notes the segmenter finds in a phrase. */
function segment(notes, paceMs) {
  const { signal, sampleRate } = sing(notes, { sampleRate: SR });
  const frames = analyse(signal, sampleRate, pd.Mpm, pd.makeOnsetDetector);
  const seg = pc.makeNoteSegmenter({ paceMs });
  const found = [];
  for (const f of frames) {
    const o = seg.feed({ midi: f.midi, onsetStrength: f.onsetStrength,
                         onsetAttack: f.onsetAttack, t: f.t, dt: 16.7 });
    if (o.ended) found.push(o.ended);
  }
  const tail = seg.feed({ midi: null, onsetStrength: 0, onsetAttack: 0,
                          t: frames[frames.length - 1].t + 300, dt: 300 });
  if (tail.ended) found.push(tail.ended);
  return { found, pace: seg.paceMs() };
}

/** What the exercise credits to each reference of a bar. */
function answers(refs, notes, paceMs) {
  const { signal, sampleRate } = sing(notes, { sampleRate: SR });
  const frames = analyse(signal, sampleRate, pd.Mpm, pd.makeOnsetDetector);
  const ctrl = Object.create(pc.PracticeController.prototype);
  ctrl.running = true; ctrl.renderer = null;
  const got = new Array(refs.length).fill(null);
  const h = ctrl._makeLiveCapture(0, refs, {
    noteMs: paceMs, onNote: () => {},
    onNoteDone: (i, n) => { got[i] = n.midi; },
    onComplete: () => {},
  });
  for (const f of frames) {
    h({ midi: f.midi, onsetStrength: f.onsetStrength, onsetAttack: f.onsetAttack, t: f.t });
  }
  return got;
}

const fmt = (a) => a.map((x) => (x == null ? "--" : x.toFixed(2))).join("  ");

// --- one note, wandering ----------------------------------------------------
// The single most damaging thing on the recording.  A note that drifts a
// semitone and a bit away from its own pitch and back is one note; read as
// three, it answered three references before the singer had sung a second
// note, and the whole bar was a note behind from there on.
//
// The limit is a wander of about 140 cents end to end, which covers what was
// measured on the recording note for note.  Past that the drift is wider than
// the interval it would have to be told apart from, and the exercise reads it
// as two notes — correctly, on the evidence available to it.

{
  const { found } = segment([{ midi: 60, ms: 700, artic: "hard", driftCents: 130 }], 450);
  T("a note the voice wanders 130 cents inside is one note",
    found.length === 1,
    "found " + found.length + ": " + fmt(found.map((f) => f.midi)));
}

{
  // Three of them, which is the shape of an actual bar: the wander must not
  // cost a reference at any point in the phrase, not merely at its start.
  const notes = [
    { midi: 60, ms: 650, artic: "hard", driftCents: 120, gapMs: 90 },
    { midi: 64, ms: 700, artic: "hard", driftCents: 130, gapMs: 80 },
    { midi: 67, ms: 700, artic: "hard", driftCents: 110 },
  ];
  const { found } = segment(notes, 400);
  T("a whole phrase of wandering notes is that many notes",
    found.length === 3,
    "found " + found.length + ": " + fmt(found.map((f) => f.midi)));

  const got = answers([60, 64, 67], notes, 400);
  const ok = got.every((g, i) => g != null && Math.abs(g - [60, 64, 67][i]) * 100 <= 70);
  T("...and each reference is answered by the note sung for it", ok, "answered " + fmt(got));
}

// --- notes detached by less than a silence ---------------------------------
// The gaps between this singer's notes are 50-100 ms, and the segmenter's
// silence threshold cannot safely be brought down that far — a breath is the
// same length.  What separates them is the release: the singer let the note
// go, and the level says so.

{
  const notes = [
    { midi: 62, ms: 500, artic: "hard", driftCents: 90, gapMs: 70 },
    { midi: 62, ms: 500, artic: "hard", driftCents: 90 },
  ];
  const { found } = segment(notes, 450);
  T("two notes at the same pitch, 70 ms apart, are two notes",
    found.length === 2,
    "found " + found.length + ": " + fmt(found.map((f) => f.midi)));
  T("...and both read as begun, not merely arrived at",
    found.length === 2 && found.every((f) => f.articulated),
    found.map((f) => (f.articulated ? "articulated" : "pitch-only")).join(", "));
}

{
  // The same, a semitone apart — which is what the singer actually did, and
  // where merging them silently loses the second reference rather than
  // obviously losing a note.
  const refs = [65, 64];
  const notes = [
    { midi: 65, ms: 550, artic: "hard", driftCents: 100, gapMs: 80 },
    { midi: 64, ms: 600, artic: "hard", driftCents: 95 },
  ];
  const got = answers(refs, notes, 450);
  const ok = got.every((g, i) => g != null && Math.abs(g - refs[i]) * 100 <= 70);
  T("a semitone step, detached, spends two references and not one", ok,
    "answered " + fmt(got));
}

// --- the slide into a note is not the note ----------------------------------
// A voice crossing between two notes is briefly steady in the middle of the
// crossing, at a pitch nobody sang.  Crediting that cost the recording a
// reference in one bar and the alignment of everything after it.

{
  const refs = [60, 67, 60];
  const notes = [
    { midi: 60, ms: 600, artic: "hard", driftCents: 70 },
    { midi: 67, ms: 600, artic: "legato", slideFrom: 60, driftCents: 70 },
    { midi: 60, ms: 700, artic: "legato", slideFrom: 67, driftCents: 70 },
  ];
  const got = answers(refs, notes, 450);
  const ok = got.every((g, i) => g != null && Math.abs(g - refs[i]) * 100 <= 90);
  T("a fifth slid into is answered where the voice landed, not mid-slide", ok,
    "answered " + fmt(got));
}

// --- the tempo estimate stays near the tempo -------------------------------
// Every threshold in the segmenter scales with the pace, and the pace is
// measured from the notes those thresholds found, so it is a loop that runs
// away in both directions.  Downwards it was measured doing so on the real
// recording: a written 310 ms wound down to 180 inside a single bar, and every
// note after that was cut shorter still.

{
  const notes = [
    { midi: 60, ms: 700, artic: "hard", driftCents: 120, gapMs: 90 },
    { midi: 62, ms: 750, artic: "hard", driftCents: 130, gapMs: 90 },
    { midi: 64, ms: 700, artic: "hard", driftCents: 120, gapMs: 90 },
    { midi: 60, ms: 800, artic: "hard", driftCents: 125 },
  ];
  // Written at 350; sung at about twice that, which is what this singer does.
  const { pace } = segment(notes, 350);
  T("a singer at half the written speed moves the estimate, but not past reason",
    pace >= 350 && pace <= 350 * 2.5,
    "written 350, estimate " + Math.round(pace));
}

{
  // ...and the other way: short, detached notes must not wind it down below
  // what the exercise asked for either.
  const notes = [];
  for (let i = 0; i < 6; i++) {
    notes.push({ midi: 60 + i, ms: 260, artic: "hard", driftCents: 70, gapMs: 70 });
  }
  const { pace } = segment(notes, 600);
  T("...and short notes do not wind it down out of all recognition",
    pace >= 600 * 0.5,
    "written 600, estimate " + Math.round(pace));
}

console.log("\n" + pass + "/" + total + " untrained-voice cases pass");
if (pass !== total) process.exitCode = 1;
