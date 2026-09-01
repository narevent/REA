/**
 * lessonNaming.js — how a lesson's own facets are written for a person.
 *
 * Small, and shared on purpose: the practice app and the score editor both
 * have to turn the same stored facet values into the same words, and when
 * they each did it themselves they drifted.  Anything here is about naming
 * only — nothing in this file decides which lessons are fetched.
 */

/**
 * The progressive step a lesson belongs to.
 *
 * The absolute library uses two different columns for the same idea: most
 * families number their steps in `part`, while the Extended span divides into
 * octave ranges held in `grades`.  A lesson has one or the other, never both,
 * so one key covers them.
 */
export function absPartKey(lesson) {
  return lesson.part || lesson.grades || "";
}

/** That step, written out. */
export function absPartLabel(key) {
  if (key === "") return "All";
  // "2Grades" / "3Grades" says nothing to a singer: these are the Extended
  // span's octave ranges, and the lesson files themselves are named
  // `..._2_oct` and `..._3_oct`.  Read them as what they are.
  const octaves = /^(\d)Grades$/.exec(key);
  if (octaves) return `${octaves[1]} octaves`;
  return `Part ${key}`;
}
