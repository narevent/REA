/**
 * The browser globals the app modules expect, for tests running under node.
 *
 * `REA_DIFFICULTY` selects the difficulty setting the run uses, so the whole
 * suite can be run at each of the three:
 *
 *   node rea/tests/audio/run.mjs                      (easy — the default)
 *   REA_DIFFICULTY=medium node rea/tests/audio/run.mjs
 *   REA_DIFFICULTY=hard   node rea/tests/audio/run.mjs
 *
 * Segmentation must not depend on it — the difficulty settings move scoring
 * and patience, not where a note begins and ends — and running the suite at
 * all three is how that stays true.
 */
globalThis.localStorage = {
  getItem: (k) => (k === "rea.difficulty" ? (process.env.REA_DIFFICULTY || null) : null),
  setItem: () => {},
};
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.document = globalThis.document || { cookie: "" };
globalThis.fetch = globalThis.fetch || (() => Promise.resolve({ ok: true }));
