import { pacingOf } from "./pacing-lib.mjs";

/**
 * When does the marker move on?
 *
 * Two promises to the singer, and they are asserted rather than admired
 * because this regressed once already — the marker was tied to the moment the
 * pitch locked, which is a third of the way into a held note, and the whole
 * exercise felt like it was running away.
 *
 *   PATIENCE      You get at least FLOOR_MS on a note before the marker leaves
 *                 it — unless you stop singing it first, in which case the note
 *                 is over and there is nothing to be patient about.  This is an
 *                 absolute guarantee in milliseconds, not a fraction of
 *                 anything: it holds whatever the tempo, however the pace has
 *                 been estimated, and whether or not the estimate is any good.
 *
 *   RESPONSIVENESS  Once a note is over, the marker follows within LAG_MS (or
 *                 half the gap, whichever is more forgiving).  Longer than that
 *                 and the exercise feels like it is lagging behind the voice.
 */
const FLOOR_MS = 400;
const LAG_MS = 220;

let pass = 0, total = 0;
function T(name, notes, refs, writtenMs) {
  total++;
  const rows = pacingOf(notes, refs, writtenMs);
  const problems = [];
  rows.forEach((r, i) => {
    if (r.commitMs == null) { problems.push(`note ${i + 1} never scored`); return; }
    const floor = Math.min(r.soundingMs, FLOOR_MS);
    const ceiling = r.soundingMs + Math.max(LAG_MS, 0.6 * r.gapMs);
    if (r.commitMs < floor - 20) problems.push(`note ${i + 1} rushed (${Math.round(r.commitMs)}ms of a ${r.soundingMs}ms note)`);
    if (r.commitMs > ceiling) problems.push(`note ${i + 1} late (${Math.round(r.commitMs)}ms, note ended at ${r.soundingMs}ms)`);
  });
  console.log((problems.length ? "  FAIL  " : "  PASS  ") + name);
  console.log("          commit at: " + rows.map((r) => (r.commitMs == null ? "never" : Math.round(r.commitMs) + "ms/" + r.soundingMs + "ms")).join("  "));
  problems.forEach((p) => console.log("          " + p));
  if (!problems.length) pass++;
}

const four = (ms, extra = {}) => [60, 62, 64, 65].map((midi) => ({ midi, ms, artic: "hard", ...extra }));
const refs4 = [60, 62, 64, 65];

T("quarter notes at the written tempo", four(500), refs4, 500);
T("sung at half speed", four(1000), refs4, 500);
T("sung at double speed", four(250), refs4, 500);
T("sung very slowly", four(1500), refs4, 500);
T("held notes with vibrato", four(900, { vibCents: 45 }), refs4, 500);
T("staccato — short notes, same tempo", four(200, { gapMs: 400 }), refs4, 500);
T("very short staccato", four(140, { gapMs: 360 }), refs4, 500);
T("rubato", [
  { midi: 60, ms: 900, artic: "hard" }, { midi: 62, ms: 350, artic: "hard" },
  { midi: 64, ms: 320, artic: "hard" }, { midi: 65, ms: 1000, artic: "hard" },
], refs4, 500);

console.log("\n" + pass + "/" + total + " pacing cases pass");
