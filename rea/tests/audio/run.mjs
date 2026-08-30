/**
 * Pitch-tracking and note-segmentation tests.
 *
 *   node rea/tests/audio/run.mjs
 *
 * These cover the singing exercises' audio path, which the Django suite cannot
 * reach: it is browser JavaScript, and it needs sound to exercise at all.
 * Rather than a microphone, the cases synthesise singing (synth.mjs) with the
 * things a real voice does that fool a naive tracker — a scooped attack,
 * vibrato, a legato slide, a re-articulated repeat, a breath — and run it
 * through the same Mpm, onset detector and segmenter the app uses.
 *
 * `cases.mjs`    where notes begin and end.
 * `slots.mjs`    which reference note each sung note is scored against — the
 *                thing the singer actually sees.
 * `tempo.mjs`    the same phrase sung far slower and faster than it is written.
 *                Sight-singing is not a rhythm test, and nothing here may
 *                depend on the singer matching the playback.
 * `patience.mjs` the ways the capture used to run ahead of the singer.
 * `pacing.mjs`   *when* the marker moves on: the two promises to the singer,
 *                that a note always gets a minimum time before the marker
 *                leaves it and that the marker follows promptly once the note
 *                is over.  This is what "it feels too fast" means in numbers,
 *                and it is asserted because it has regressed once already.
 * `lastnote.mjs` the last note of a bar gets the same time as any other.
 * `profile.mjs`  the voice profile the soundcheck measures — vibrato width and
 *                articulation floor — and what having one does for a singer
 *                whose voice is nothing like the default.
 * `learner.mjs`  the singer who does not know the note yet: hunting for an
 *                interval, hesitating, wobbling, getting it wrong.  Every
 *                other file here sings the exercise correctly; this is the
 *                case the app exists for, and the one it used to score worst.
 * `articulation.mjs`  whether the singer *began* a note or the tracker merely
 *                found them elsewhere — the level cue that tells a slide from
 *                an attack, with the figures its threshold is set from.
 * `singlenote.mjs`  chapters 8 and 9, which had no coverage at all until the
 *                capture they run on called a helper that no longer existed.
 * `scoring.mjs`  what a sung note is worth at each difficulty — the table is
 *                printed, so what the settings actually promise can be read
 *                rather than inferred from the constants.
 *
 * `REA_DIFFICULTY=medium node rea/tests/audio/run.mjs` runs the whole suite at
 * another setting.  Segmentation must not depend on it — difficulty moves
 * scoring and patience, not where a note begins and ends — and running all
 * three is how that stays true.
 *
 * `measure.mjs` and `strength.mjs` print the figures the onset thresholds are
 * set from — run them if you change those constants.  `inspect.mjs` is a
 * diagnostic: it prints the notes the segmenter finds in a phrase, with why
 * each one began and whether it settled, which is the first thing to look at
 * when a learner case fails.
 */
const mods = ["./cases.mjs", "./slots.mjs", "./tempo.mjs", "./patience.mjs", "./pacing.mjs", "./lastnote.mjs", "./profile.mjs", "./learner.mjs", "./articulation.mjs", "./singlenote.mjs", "./scoring.mjs"];
let failed = false;
for (const m of mods) {
  const before = process.exitCode;
  const out = [];
  const log = console.log;
  console.log = (...a) => out.push(a.join(" "));
  await import(m);
  console.log = log;
  const text = out.join("\n");
  console.log(text);
  if (/FAIL/.test(text)) failed = true;
  process.exitCode = before;
}
console.log(failed ? "\nAUDIO TESTS FAILED" : "\nall audio tests pass");
process.exitCode = failed ? 1 : 0;
