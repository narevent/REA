/**
 * Patience: the exercise must not run ahead of the singer.
 *
 * Every case here is a way the capture used to advance before the singer had
 * actually sung the next note — one held note filling several reference slots,
 * a moment of hesitation counted as a note, a scoop counted as the note below.
 */
import { runSlots } from "./slots-lib.mjs";

let pass = 0, total = 0;
const T = (...a) => { total++; if (runSlots(...a)) pass++; };

// One long note against four references must consume exactly one.  runSlots
// compares against what was sung, so the remaining three staying empty is the
// pass condition.
T("one held note consumes one slot, not four", [60, 62, 64, 65],
  [{ midi: 60, ms: 2000, artic: "hard", vibCents: 35 }], 500);

// Hesitation: the singer hunts for the note, then settles.  The hunt is not a
// note, and the note is scored where they settled.
T("hunting for the pitch is not a note", [64],
  [{ midi: 64, ms: 1200, artic: "soft", scoopCents: 200 }], 500);

// A breath in the middle of a long note does not make it two notes against two
// references — it is one note, sung in two halves, and the second half is the
// same note.  (The segmenter will report two; what matters is the singer is not
// pushed on to the *next* reference for continuing the same note.)
T("two notes, a long breath between", [60, 67],
  [{ midi: 60, ms: 700, artic: "hard", gapMs: 500 },
   { midi: 67, ms: 700, artic: "hard" }], 500);

// A singer who takes their time before starting must not have the first
// reference scored from silence.
T("late start", [69, 71],
  [{ midi: 69, ms: 600, artic: "hard", gapMs: 400 },
   { midi: 71, ms: 600, artic: "hard" }], 500);

// Expression must not read as articulation.  A singer swelling through a long
// note, or growing into it, changes level by several dB — which is precisely
// what the envelope half of onset detection watches for.
T("a note sung with a swell is still one note", [67, 69],
  [{ midi: 67, ms: 1400, artic: "hard", vibCents: 40, swellDb: 7 },
   { midi: 69, ms: 700, artic: "hard" }], 600);

T("a crescendo through a note is still one note", [64, 65],
  [{ midi: 64, ms: 1200, artic: "soft", crescDb: 9 },
   { midi: 65, ms: 700, artic: "hard" }], 600);

// Uneven singing must not wind the pace estimate down until the exercise races:
// every threshold scales with pace, so a fragment lowering it is a feedback
// loop.
T("uneven phrase does not wind up the pace", [60, 62, 64, 65, 67],
  [{ midi: 60, ms: 260, artic: "hard" }, { midi: 62, ms: 900, artic: "hard", vibCents: 40 },
   { midi: 64, ms: 300, artic: "hard" }, { midi: 65, ms: 850, artic: "hard" },
   { midi: 67, ms: 700, artic: "hard" }], 500);

console.log("\n" + pass + "/" + total + " patience cases pass");
