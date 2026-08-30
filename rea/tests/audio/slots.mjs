import { runSlots } from "./slots-lib.mjs";

let pass = 0, total = 0;
const T = (...a) => { total++; if (runSlots(...a)) pass++; };

// The repeat: reference 1-1-3-5 sung correctly.  Before onset detection the two
// Cs arrived as one note and everything after was scored against the wrong
// reference.
T("repeated note keeps the alignment", [60, 60, 64, 67],
  [{ midi: 60, ms: 450, artic: "hard" }, { midi: 60, ms: 450, artic: "hard" },
   { midi: 64, ms: 450, artic: "hard" }, { midi: 67, ms: 500, artic: "hard" }], 450);

// Sung a semitone flat throughout: every note should still land in its own
// slot — being wrong must not cost alignment as well as points.
T("wrong notes still land in their own slots", [60, 62, 64, 65],
  [{ midi: 59, ms: 400, artic: "hard" }, { midi: 61, ms: 400, artic: "hard" },
   { midi: 63, ms: 400, artic: "hard" }, { midi: 64, ms: 450, artic: "hard" }], 400);

// A held note with a big scoop must score where it landed, not where it began.
T("scooped note scores where it landed", [67],
  [{ midi: 67, ms: 900, artic: "soft", scoopCents: 150 }], 900);

// Legato descent, no articulation at all.
T("legato phrase", [72, 71, 69],
  [{ midi: 72, ms: 420, artic: "hard" },
   { midi: 71, ms: 420, artic: "legato", slideFrom: 72 },
   { midi: 69, ms: 480, artic: "legato", slideFrom: 71 }], 420);

// At tempo: eighth notes at 119bpm are 252 ms.
T("eighths at tempo 119", [60, 62, 64, 65, 67],
  [{ midi: 60, ms: 252, artic: "hard" }, { midi: 62, ms: 252, artic: "hard" },
   { midi: 64, ms: 252, artic: "hard" }, { midi: 65, ms: 252, artic: "hard" },
   { midi: 67, ms: 400, artic: "hard" }], 252);

console.log("\n" + pass + "/" + total + " slot cases pass");
