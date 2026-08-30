import { pacingOf } from "./pacing-lib.mjs";

/**
 * The marker must lead the singer, and only just.
 *
 * Too early and the exercise runs ahead: the singer spends every note chasing
 * a marker that has already gone, which is what "it skips" feels like from the
 * inside.  Too late and it follows, and every note drags.  The window below is
 * the whole claim, and it is asserted rather than admired because it regressed
 * once already: locking the pitch was mistaken for having sung the note, and
 * the marker set off a quarter of the way in.
 *
 * Fast notes commit slightly *after* they end — over 100% — because at speed a
 * note is over before anyone could have led it.  That is the honest moment, and
 * the ceiling stops it drifting further than a little into the next note.
 */
const MIN_FRACTION = 0.35;   // never before a third of the note has been sung
const MAX_FRACTION = 1.35;   // never more than a third of a note late

let pass = 0, total = 0;
function T(name, notes, refs, writtenMs) {
  total++;
  const fracs = pacingOf(notes, refs, writtenMs);
  const bad = fracs.some((f) => f == null || f < MIN_FRACTION || f > MAX_FRACTION);
  console.log((bad ? "  FAIL  " : "  PASS  ") + name);
  console.log("          commit point per note: " +
    fracs.map((x) => (x == null ? "never" : (x * 100).toFixed(0) + "%")).join("  "));
  if (!bad) pass++;
}

const four = (ms, extra = {}) => [60, 62, 64, 65].map((midi) => ({ midi, ms, artic: "hard", ...extra }));
const refs4 = [60, 62, 64, 65];

T("quarter notes at the written tempo", four(500), refs4, 500);
T("sung at half speed", four(1000), refs4, 500);
T("sung at double speed", four(250), refs4, 500);
T("sung very slowly", four(1500), refs4, 500);
T("held notes with vibrato", four(900, { vibCents: 45 }), refs4, 500);
T("rubato", [
  { midi: 60, ms: 900, artic: "hard" }, { midi: 62, ms: 350, artic: "hard" },
  { midi: 64, ms: 320, artic: "hard" }, { midi: 65, ms: 1000, artic: "hard" },
], refs4, 500);

console.log("\n" + pass + "/" + total + " pacing cases pass");
