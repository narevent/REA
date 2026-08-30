/**
 * What a sung note is worth, at each difficulty.
 *
 *   node rea/tests/audio/scoring.mjs
 *   REA_DIFFICULTY=hard node rea/tests/audio/scoring.mjs
 *
 * The complaint this answers was that a high score was not something a student
 * could work towards: full marks needed every note of every bar inside twenty
 * cents — a fifth of a semitone — which almost nobody sings and nobody sings
 * consistently.  Recognisably good singing scored in the seventies, so the
 * number stopped meaning "you sang it well" and started meaning "you did not
 * sing it perfectly", which is not a thing worth telling a beginner.
 *
 * The table below is the honest statement of what each setting is: run it and
 * read what forty cents sharp is worth.  The assertions are the shape the
 * three must keep — easy strictly more generous than medium, medium than hard,
 * and every one of them still able to tell an in-tune note from a wrong one.
 */
import "./env.mjs";
const JS = "../../apps/rea_frontend/static/rea_frontend/js/";
const diff = await import(JS + "difficulty.js");
const score = await import(JS + "practiceScore.js");

const here = diff.getDifficulty();
const CENTS = [0, 15, 25, 40, 60, 90, 120, 200, 300];

console.log("difficulty: " + here);
console.log("  cents off   " + CENTS.map((c) => String(c).padStart(5)).join(""));
console.log("  score       " +
  CENTS.map((c) => String(score.centsToScore(c)).padStart(5)).join(""));

let pass = 0, total = 0;
const T = (name, ok, detail) => {
  total++; if (ok) pass++;
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? " — " + detail : ""));
};

// --- what the setting promises ---------------------------------------------

const t = diff.tuning();
T("an exactly-sung note is full marks", score.centsToScore(0) === 100);
// The far end matters as much as the near one, at every setting: an exercise
// that cannot tell a student they sang the wrong degree is not teaching them.
T("a whole tone out is clearly wrong", score.centsToScore(200) <= 35,
  score.centsToScore(200) + "/100 at 200 cents");

if (here === "easy") {
  // The point of the default setting: sing it recognisably and the number
  // agrees with you.  Forty cents is a normal amount for a good singer to be
  // out on a note, and it used to cost twenty points.
  T("forty cents off still scores full marks", score.centsToScore(40) === 100);
  T("half a semitone off still scores full marks", score.centsToScore(50) === 100);
  T("a semitone off still scores over half", score.centsToScore(100) > 50,
    score.centsToScore(100) + "/100");
}

// --- the three keep their order ---------------------------------------------

const order = ["easy", "medium", "hard"];
const wide = order.map((d) => diff.tuningFor(d));
T("each setting is tighter than the one before it",
  wide[0].perfectCents > wide[1].perfectCents &&
  wide[1].perfectCents > wide[2].perfectCents &&
  wide[0].zeroCents > wide[1].zeroCents &&
  wide[1].zeroCents > wide[2].zeroCents,
  wide.map((w, i) => order[i] + " " + w.perfectCents + "/" + w.zeroCents).join(", "));

T("even the hardest gives a quarter-tone something", diff.tuningFor("hard").zeroCents > 50);
T("even the easiest scores a wrong degree below full marks",
  diff.tuningFor("easy").perfectCents < 100);
T("an octave out is a register mistake, not a wrong note",
  t.octaveScore >= 60 && t.octaveScore < 100, t.octaveScore + "/100");

// --- the guessing chapters ---------------------------------------------------

T("the right bar is full marks", score.scoreGuessBar(2, 2, 5) === 100);
T("a neighbouring bar earns something", score.scoreGuessBar(2, 3, 5) === t.nearBar,
  t.nearBar + "/100");
T("a bar nowhere near earns nothing", score.scoreGuessBar(0, 4, 5) === 0);

console.log("\n" + pass + "/" + total + " scoring cases pass (" + here + ")");
