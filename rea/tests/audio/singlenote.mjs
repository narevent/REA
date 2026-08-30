/**
 * The single-note chapters (8 and 9): sing one proposed note.
 *
 * These had no coverage at all, and it showed — the capture called a helper
 * that no longer existed, so every round of both chapters threw the moment the
 * microphone opened.  A test that merely runs the thing would have caught it.
 *
 * What is asserted beyond that is the same promise the bar capture makes, and
 * the reason the old helper is not simply restored: the round ends on the note
 * the singer *settles* on, not on the first pitch they hold for a moment.  A
 * student working out an interval slides towards it and pauses on the way, and
 * the round used to end on the pause — scoring it, and moving on before they
 * had sung the note they were reaching for.
 */
import { sing, analyse, SR } from "./synth.mjs";
const JS = "../../apps/rea_frontend/static/rea_frontend/js/";
import "./env.mjs";
const pd = await import(JS + "pitchDetector.js");
const pc = await import(JS + "practiceController.js");

let pass = 0, total = 0;

/**
 * @param {number} target  the note the singer was asked for
 * @param {Array}  notes   what they actually do
 * @param {number} expect  the pitch the round should commit
 */
function T(name, target, notes, expect) {
  total++;
  const { signal, sampleRate } = sing(notes, { sampleRate: SR });
  const frames = analyse(signal, sampleRate, pd.Mpm, pd.makeOnsetDetector);
  const ctrl = Object.create(pc.PracticeController.prototype);
  ctrl.running = true;
  ctrl.renderer = null;

  let committed = null;
  let threw = null;
  try {
    const cap = ctrl._makeSingleNoteCapture(0, 0, target, (n) => {
      if (committed == null && n) committed = n.midi;
    });
    for (const f of frames) {
      cap.onPitch({ midi: f.midi, onsetStrength: f.onsetStrength, onsetAttack: f.onsetAttack, t: f.t });
    }
    // Whatever happens, an attempt cut short by the countdown must still be
    // scorable rather than reading as silence.
    if (committed == null && cap.best()) committed = cap.best().midi;
  } catch (e) {
    threw = e;
  }

  const got = committed == null ? null : Number(committed.toFixed(2));
  const ok = !threw && got != null && Math.abs(got - expect) * 100 <= 45;
  console.log((ok ? "  PASS  " : "  FAIL  ") + name);
  if (threw) console.log("          threw: " + threw.message);
  else console.log("          asked for " + target + ", committed " + got + ", expected " + expect);
  if (ok) pass++;
}

T("a note sung straight is committed", 67,
  [{ midi: 67, ms: 900, artic: "hard" }], 67);

// The case the chapter exists for and the one it used to get wrong.
T("hunting for the note commits where the singer lands", 67,
  [{ midi: 62, ms: 170, artic: "legato", slideFrom: 60 },
   { midi: 64, ms: 150, artic: "legato", slideFrom: 62 },
   { midi: 65, ms: 160, artic: "legato", slideFrom: 64 },
   { midi: 67, ms: 900, artic: "legato", slideFrom: 65 }], 67);

// A wrong note held is still the answer — the round is not waiting for the
// singer to be right, it is waiting for them to commit.
T("a wrong note held is committed as sung", 67,
  [{ midi: 65, ms: 900, artic: "hard" }], 65);

// A scoop into the note is not the note.
T("a scooped attack commits where it landed", 64,
  [{ midi: 64, ms: 900, artic: "soft", scoopCents: 150 }], 64);

// Nothing settles: the best of what was heard is still scorable, so a round
// that runs out of time does not read as silence.
T("an unsettled attempt is still scorable", 60,
  [{ midi: 60, ms: 200, artic: "legato", slideFrom: 59 },
   { midi: 60.4, ms: 200, artic: "legato", slideFrom: 60 }], 60);

console.log("\n" + pass + "/" + total + " single-note cases pass");
