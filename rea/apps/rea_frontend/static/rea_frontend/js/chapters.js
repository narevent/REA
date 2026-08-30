/**
 * chapters.js
 *
 * The 10 practice chapters of REA, plus a localStorage-backed progress store.
 * The landing screen is the chapter map: every chapter is available — none is
 * locked — so the user can jump straight into any exercise. Progress (best
 * score, attempts, completion, XP) is tracked but never blocks access.
 *
 * Exercise names match the original practice-mode spec exactly:
 *
 *   1  Listening
 *   2  Singing with repetition
 *   3  Guessing
 *   4  Guessing (timed)
 *   5  Singing proposed
 *   6  Guessing notes
 *   7  Guessing notes (timed)
 *   8  Singing proposed notes
 *   9  Singing proposed notes (t)
 *  10  Guessing notes (multi)
 *
 * `glyph` is a key into a small set of inline SVG icons rendered in app.js, so
 * the UI stays text-light and emoji-free.
 */

// Chapters are ordered by their exercise number (id).  The on-screen
// chapter map and the session topbar both render them in this order, and
// `num` mirrors the position so labels like "Chapter 5" line up with the
// card's position in the grid.
export const CHAPTERS = [
  {
    id: 1, key: "listen", num: 1,
    title: "1. Listening",
    glyph: "wave",
    skill: "Listening",
    difficulty: 1,
    color: "#3d4edb",
    instruct: "Start and listen through every bar.",
    needsMic: false, timed: false,
    tags: [],
  },
  {
    id: 2, key: "sing_repeat", num: 2,
    title: "2. Singing with repetition",
    glyph: "mic",
    skill: "Singing",
    difficulty: 2,
    color: "#17754e",
    instruct: "Hear a bar, then sing it back.",
    needsMic: true, timed: false,
    tags: ["mic"],
  },
  {
    id: 3, key: "guess", num: 3,
    title: "3. Guessing",
    glyph: "ear",
    skill: "Guessing",
    difficulty: 2,
    color: "#6f5aa8",
    instruct: "Hear a hidden bar, click the one you heard.",
    needsMic: false, timed: false,
    tags: [],
  },
  {
    id: 4, key: "guess_timed", num: 4,
    title: "4. Guessing (timed)",
    glyph: "ear",
    skill: "Guessing",
    difficulty: 4,
    color: "#6f5aa8",
    instruct: "Hear a hidden bar, click before time runs out.",
    needsMic: false, timed: true,
    tags: ["timed"],
  },
  {
    id: 5, key: "sing_proposed", num: 5,
    title: "5. Singing proposed",
    glyph: "mic",
    skill: "Singing",
    difficulty: 3,
    color: "#17754e",
    instruct: "Sing the highlighted bar.",
    needsMic: true, timed: false,
    tags: ["mic"],
  },
  {
    id: 6, key: "guess_notes", num: 6,
    title: "6. Guessing notes",
    glyph: "note",
    skill: "Note guessing",
    difficulty: 3,
    color: "#6f5aa8",
    instruct: "Hear a note, click the bar of its scale degree.",
    needsMic: false, timed: false,
    tags: [],
  },
  {
    id: 7, key: "guess_notes_t", num: 7,
    title: "7. Guessing notes (timed)",
    glyph: "note",
    skill: "Note guessing",
    difficulty: 5,
    color: "#6f5aa8",
    instruct: "Hear a note, click its degree before time runs out.",
    needsMic: false, timed: true,
    tags: ["timed"],
  },
  {
    id: 8, key: "sing_notes", num: 8,
    title: "8. Singing proposed notes",
    glyph: "note",
    skill: "Singing notes",
    difficulty: 4,
    color: "#17754e",
    instruct: "Sing the highlighted note.",
    needsMic: true, timed: false,
    tags: ["mic"],
  },
  {
    id: 9, key: "sing_notes_t", num: 9,
    title: "9. Singing proposed notes (t)",
    glyph: "note",
    skill: "Singing notes",
    difficulty: 5,
    color: "#17754e",
    instruct: "Sing the highlighted note before time runs out.",
    needsMic: true, timed: true,
    tags: ["mic", "timed"],
  },
  {
    id: 10, key: "guess_multi", num: 10,
    title: "10. Guessing notes (multi)",
    glyph: "seq",
    skill: "Note guessing",
    difficulty: 5,
    color: "#a76a17",
    instruct: "Hear a sequence, click the matching bars in order.",
    needsMic: false, timed: false,
    tags: [],
  },
];

export const CHAPTER_BY_ID = {};
CHAPTERS.forEach((c) => { CHAPTER_BY_ID[c.id] = c; });

export const CHAPTER_BY_KEY = {};
CHAPTERS.forEach((c) => { CHAPTER_BY_KEY[c.key] = c; });

export function xpForScore(avg) { return Math.max(0, Math.round(avg)); }

export const PASS_THRESHOLD = 70;

// ---------------------------------------------------------------------------
// Progress store (localStorage) — tracked but never blocks access.
// ---------------------------------------------------------------------------

const STORE_KEY = "rea.progress.v2";

const DEFAULT_PROGRESS = { chapters: {}, xp: 0, streak: 0, lastPlayedChapter: null };

function clone(def) { return JSON.parse(JSON.stringify(def)); }

export function loadProgress() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return clone(DEFAULT_PROGRESS);
    const p = JSON.parse(raw);
    if (!p.chapters) p.chapters = {};
    return Object.assign(clone(DEFAULT_PROGRESS), p);
  } catch (e) {
    return clone(DEFAULT_PROGRESS);
  }
}

export function saveProgress(p) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ }
}

export function recordSession(progress, chapterId, avg) {
  const p = progress;
  const entry = p.chapters[chapterId] || { best: 0, attempts: 0, completed: false, lastScore: 0, lastAt: 0, xp: 0 };
  entry.xp = Math.max(entry.xp || 0, xpForScore(avg));
  entry.best = Math.max(entry.best, avg);
  entry.attempts = (entry.attempts || 0) + 1;
  entry.lastScore = avg;
  entry.lastAt = Date.now();
  if (avg >= PASS_THRESHOLD) entry.completed = true;
  p.chapters[chapterId] = entry;
  p.xp = Object.values(p.chapters).reduce((s, e) => s + (e.xp || 0), 0);
  p.streak = avg >= PASS_THRESHOLD ? (p.streak || 0) + 1 : 0;
  p.lastPlayedChapter = chapterId;
  saveProgress(p);
  return p;
}

/** Every chapter is always unlocked — nothing is gated. */
export function isUnlocked(progress, chapter) { return true; }

export function completedCount(progress) {
  return CHAPTERS.filter((c) => progress.chapters[c.id] && progress.chapters[c.id].completed).length;
}