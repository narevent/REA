/**
 * The singer who does not know the note yet.
 *
 * Every other case file here sings the exercise correctly and asks whether the
 * tracker keeps up.  This one sings it the way a student actually does, which
 * is the case the app exists for: hunting for an interval, stopping halfway,
 * wobbling, starting again, getting it wrong and fixing it.
 *
 * The rule these all test is one rule.  A reference note is answered by what
 * the singer *settles on* — a note they held, or one they deliberately began.
 * Pitches they merely passed through on the way are not answers, do not spend
 * a reference, and do not push the exercise on past the note they were still
 * looking for.  That is what a teacher does, and until it was written down the
 * exercise scored the search instead of the singing.
 *
 * Unlike `slots.mjs`, the expected answers are given explicitly: the whole
 * point is that what the singer sang and what the exercise should record are
 * deliberately not the same list.
 */
import { sing, analyse, SR } from "./synth.mjs";
const JS = "../../apps/rea_frontend/static/rea_frontend/js/";
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.performance = globalThis.performance || { now: () => 0 };
const pd = await import(JS + "pitchDetector.js");
const pc = await import(JS + "practiceController.js");

let pass = 0, total = 0;

/**
 * @param {number[]} refs      the bar's reference notes
 * @param {Array} notes        what the singer does (synth script)
 * @param {Array<number|null>} expect  what each reference should be answered with
 * @param {number} writtenMs   the written note length
 */
function T(name, refs, notes, expect, writtenMs) {
  total++;
  const { signal, sampleRate } = sing(notes, { sampleRate: SR });
  const frames = analyse(signal, sampleRate, pd.Mpm, pd.makeOnsetDetector);
  const ctrl = Object.create(pc.PracticeController.prototype);
  ctrl.running = true;
  ctrl.renderer = null;
  const answered = [];
  const handler = ctrl._makeLiveCapture(0, refs, {
    noteMs: writtenMs,
    onNote: () => {},
    // Only a finished reference counts: `onNote` is the live reading of the
    // note being sung, which by design lands on a reference the marker has not
    // left yet and may still be revised.
    onNoteDone: (i, n) => { answered[i] = n.midi; },
    onComplete: () => {},
  });
  for (const f of frames) handler({ midi: f.midi, onsetStrength: f.onsetStrength, onsetAttack: f.onsetAttack, t: f.t });
  handler({ midi: null, onsetStrength: 0, t: frames[frames.length - 1].t + 600 });

  const got = refs.map((_, i) => (answered[i] == null ? null : Number(answered[i].toFixed(2))));
  const ok = expect.every((e, i) => (e == null
    ? got[i] == null
    : got[i] != null && Math.abs(got[i] - e) * 100 <= 45));
  console.log((ok ? "  PASS  " : "  FAIL  ") + name);
  console.log("          reference: " + JSON.stringify(refs));
  console.log("          expected:  " + JSON.stringify(expect));
  console.log("          answered:  " + JSON.stringify(got));
  if (ok) pass++;
  return ok;
}

// --- looking for the note --------------------------------------------------

// The heart of it.  A student working out a fifth slides up and rests on the
// way — the third, the fourth — before landing.  Those rests are steady pitch,
// held long enough that the old segmenter called each of them a note, and the
// exercise spent a reference on every one.  By the time the student sang the
// note they were looking for, the marker was three notes past it.
T("hunting up to the note spends one reference, not four", [67],
  [{ midi: 62, ms: 170, artic: "legato", slideFrom: 60 },
   { midi: 64, ms: 150, artic: "legato", slideFrom: 62 },
   { midi: 65, ms: 160, artic: "legato", slideFrom: 64 },
   { midi: 67, ms: 900, artic: "legato", slideFrom: 65 }],
  [67], 600);

// The same search, but the singer is working *down* to the note.
T("hunting down to the note", [60],
  [{ midi: 65, ms: 180, artic: "legato", slideFrom: 67 },
   { midi: 62, ms: 150, artic: "legato", slideFrom: 65 },
   { midi: 60, ms: 1000, artic: "legato", slideFrom: 62 }],
  [60], 600);

// Hunting before the *second* note of a bar, so the first is already answered
// and the pace is known.  This is where a wrong tolerance is least visible and
// does the most damage: the bar is already under way.
T("hunting mid-bar does not push the marker on", [60, 67],
  [{ midi: 60, ms: 700, artic: "hard" },
   { midi: 63, ms: 150, artic: "legato", slideFrom: 60 },
   { midi: 65, ms: 140, artic: "legato", slideFrom: 63 },
   { midi: 67, ms: 800, artic: "legato", slideFrom: 65 }],
  [60, 67], 600);

// --- doubt -----------------------------------------------------------------

// A singer who is not sure wobbles: the pitch sags most of a semitone and comes
// back.  That is one note sung with doubt, not two notes and not a departure —
// and the note is scored where they were, not where they sagged to.
T("a note sung with doubt is still one note", [64, 65],
  [{ midi: 64, ms: 380, artic: "hard" },
   { midi: 63.3, ms: 200, artic: "legato", slideFrom: 64 },
   { midi: 64, ms: 600, artic: "legato", slideFrom: 63.3 },
   { midi: 65, ms: 700, artic: "hard" }],
  [64, 65], 600);

// --- false starts and corrections ------------------------------------------

// A stab, a stop, then the real attempt.  The stab is not the answer.
//
// The limit of this is worth being plain about, because it is a real one: an
// utterance long enough to be a note *is* a note, whatever the singer meant by
// it.  A 140 ms staccato note and a 140 ms false start are the same sound, and
// nothing in the audio separates them — so what is rejected here is what is
// too short to be a note at all, and a false start the singer actually gave a
// pitch to will cost them the reference.  A teacher has the same problem and
// solves it by asking; the exercise cannot.
T("a false start too short to be a note is discarded", [69],
  [{ midi: 65, ms: 70, artic: "hard", gapMs: 320 },
   { midi: 69, ms: 900, artic: "hard" }],
  [69], 600);

// The other side of the bargain, and the reason the rule is about *settling*
// rather than about being right: a wrong note the singer actually held is
// their answer.  A teacher would say "you sang F, it should be G" — they would
// not pretend it had not happened.  The correction that follows is the next
// note, and it is judged against the next reference.
T("a wrong note that was held is the answer", [67, 72],
  [{ midi: 65, ms: 800, artic: "hard" },
   { midi: 72, ms: 800, artic: "hard" }],
  [65, 72], 600);

// A singer who never holds anything must still be scored rather than freezing
// the bar: after a few of their own note-lengths the best thing heard answers
// the reference and the exercise moves on.
T("a voice that never settles still answers", [60, 62],
  [{ midi: 60, ms: 200, artic: "legato", slideFrom: 59 },
   { midi: 60.6, ms: 200, artic: "legato", slideFrom: 60 },
   { midi: 60, ms: 200, artic: "legato", slideFrom: 60.6 },
   { midi: 60.5, ms: 200, artic: "legato", slideFrom: 60 },
   { midi: 62, ms: 900, artic: "hard" }],
  [60, 62], 600);

// --- the learner's phrase ---------------------------------------------------

// Everything at once, at the pace a beginner actually sings: slow, uneven,
// searching for two of the five notes and holding the rest.
T("a beginner's phrase", [60, 64, 67, 65, 64],
  [{ midi: 60, ms: 900, artic: "hard" },
   { midi: 62, ms: 160, artic: "legato", slideFrom: 60 },
   { midi: 64, ms: 1000, artic: "legato", slideFrom: 62 },
   { midi: 67, ms: 800, artic: "hard" },
   { midi: 66, ms: 150, artic: "legato", slideFrom: 67 },
   { midi: 65, ms: 850, artic: "legato", slideFrom: 66 },
   { midi: 64, ms: 900, artic: "hard" }],
  [60, 64, 67, 65, 64], 500);

console.log("\n" + pass + "/" + total + " learner cases pass");
