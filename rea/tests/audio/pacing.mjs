import { pacingOf } from "./pacing-lib.mjs";

/**
 * When does the marker move on, and when does the singer know they were heard?
 *
 * Three promises, and they are asserted rather than admired because this
 * regressed once already — the marker was tied to the moment the pitch locked,
 * which is a third of the way into a held note, and the whole exercise felt
 * like it was running away.
 *
 *   PATIENCE      The marker does not leave a note the singer is still on.
 *                 Not "leaves it late", not "leaves it at 75%": while the note
 *                 is being sung, the marker stays.  There is a floor as well,
 *                 for the case where the singer stops almost at once.
 *
 *   RESPONSIVENESS  Once a note is over, the marker follows within LAG_MS (or
 *                 half the gap, whichever is more forgiving).  Longer than that
 *                 and the exercise feels like it is lagging behind the voice.
 *
 *   FEEDBACK      The reading of the note arrives *while it is being sung*, not
 *                 when it ends.  This is what the marker moving used to be
 *                 doing — telling the singer they had been heard — and it is
 *                 the reason the marker had to move early.  Now it does not:
 *                 the note being sung is scored where it is.
 */
const FLOOR_MS = 400;
const LAG_MS = 220;
// A note the singer stops singing is a different case, and pretending
// otherwise would only hide what is really going on.  A note ended by another
// note — an articulation, or the voice arriving somewhere else — is knowable
// the moment it happens.  A note ended by the singer stopping is knowable only
// once silence has gone on long enough to be silence rather than a breath, and
// how long that is *is* the dropout tolerance: the whole defence against a
// breath or a consonant cutting a note in half.  So ending a phrase costs what
// that tolerance costs, and the number belongs here in the open rather than
// hidden in a fraction of the gap.  The singer is not singing while it elapses.
const SILENCE_LAG_MS = 450;

let pass = 0, total = 0;
function T(name, notes, refs, writtenMs) {
  total++;
  const rows = pacingOf(notes, refs, writtenMs);
  const problems = [];
  rows.forEach((r, i) => {
    if (r.advanceMs == null) { problems.push(`note ${i + 1} never answered`); return; }
    // The marker may not move before the note is over — with a floor, because
    // a note the singer abandons after 80 ms should not hold the bar up, and a
    // small tolerance for where the tracker thinks the note ended.
    const floor = Math.min(r.soundingMs, FLOOR_MS);
    // What the marker is allowed to be waiting for.
    //
    // A note ended by another note is knowable at once.  A note ended by the
    // singer stopping is knowable only once the silence has lasted long enough
    // to be silence — the dropout tolerance, above.  And a note too short to
    // have been *held* is knowable only from what the singer sings next: it
    // could be a quick note or a pause on the way to one, and the difference
    // between them is which of the two the next note turns out to be.  That is
    // the price of not spending a reference on a search, it is bounded — one
    // note, not open-ended — and it is stated here rather than hidden.
    const next = rows[i + 1];
    const tooShortToHold = r.soundingMs < FLOOR_MS;
    const bySilence = r.gapMs > 0 || i === rows.length - 1;
    const ceiling = r.soundingMs + (
      bySilence ? SILENCE_LAG_MS
      : tooShortToHold && next ? r.gapMs + next.soundingMs + LAG_MS
      : LAG_MS);
    if (r.advanceMs < floor - 20) problems.push(`note ${i + 1} rushed (marker left after ${Math.round(r.advanceMs)}ms of a ${r.soundingMs}ms note)`);
    if (r.advanceMs > ceiling) problems.push(`note ${i + 1} late (marker left ${Math.round(r.advanceMs)}ms in, note ended at ${r.soundingMs}ms)`);
    // ...and the singer should have seen the reading by then at the latest.
    // A note long enough to hold has a stronger claim: the reading must arrive
    // while it is still being sung, because that is the whole point of the
    // reading — it is what the marker moving used to be doing.  A note shorter
    // than that is over before anything could be said about it, so all that can
    // be asked is that the reading is not later than the answer.
    if (r.reportMs == null) problems.push(`note ${i + 1} never reported`);
    else if (r.reportMs > ceiling) problems.push(`note ${i + 1} reported after the marker moved (${Math.round(r.reportMs)}ms)`);
    else if (r.soundingMs > FLOOR_MS && r.reportMs > r.soundingMs) problems.push(`note ${i + 1} reported late (${Math.round(r.reportMs)}ms into a ${r.soundingMs}ms note)`);
  });
  console.log((problems.length ? "  FAIL  " : "  PASS  ") + name);
  console.log("          heard at:  " + rows.map((r) => (r.reportMs == null ? "never" : Math.round(r.reportMs) + "ms")).join("  "));
  console.log("          marker at: " + rows.map((r) => (r.advanceMs == null ? "never" : Math.round(r.advanceMs) + "ms/" + r.soundingMs + "ms")).join("  "));
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
