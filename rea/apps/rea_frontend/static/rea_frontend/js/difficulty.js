/**
 * difficulty.js — how much room the exercises give the singer.
 *
 * Intonation is a skill being learned, not a tuner reading.  A student who
 * sings a phrase recognisably in tune is doing the thing the exercise teaches;
 * scoring that at 60 because they averaged forty cents sharp teaches them
 * nothing except that the app is impossible.  And the window was tight: a note
 * had to land within twenty cents — a fifth of a semitone — to score full
 * marks, on every note of every bar, which almost nobody does and nobody does
 * consistently.  So a high score was not a goal a student could work towards;
 * it was a thing that did not happen.
 *
 * Three settings, and the app starts on the widest.  A student can tighten it
 * when the wide one stops being interesting, which is the right direction to
 * travel: the exercise gets harder because they got better, not because it
 * always was.
 *
 * What each setting moves:
 *
 *   perfectCents  inside this, a note is simply right.  This is the number
 *                 that decides whether good singing scores well.
 *   zeroCents     beyond this, it is a different note and scores nothing.
 *                 Between the two the score falls off linearly.
 *   octaveScore   what an octave error is worth.  It is the right pitch class
 *                 in the wrong register — a real mistake, but not a wrong note.
 *   patiencePaces  how long the exercise waits on one reference, in the
 *                 singer's own note-lengths, before taking the best it heard
 *                 and moving on.  This is the one tracker-side setting here,
 *                 and it is about time rather than pitch on purpose: how far
 *                 the voice may wander before the tracker calls it a different
 *                 note is not a difficulty knob but a correctness one, because
 *                 two scale degrees are only a hundred cents apart and a
 *                 tolerance approaching half of that merges the notes of a
 *                 stepwise phrase into one.  Waiting longer costs nothing and
 *                 is exactly what a beginner needs.
 *   nearBar/farBar  partial credit in the bar-guessing chapters for picking a
 *                 neighbour of the right bar.
 *
 * The numbers live here, next to nothing else, so the three settings can be
 * read against each other in one screenful.  Which one is chosen is stored on
 * the user's profile when they are signed in (so it follows them between
 * devices) and in localStorage either way (so the app works signed out).
 */

const KEY = "rea.difficulty";

export const DIFFICULTIES = ["easy", "medium", "hard"];

export const DIFFICULTY_LABELS = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

/** One line each, for the chooser — what the student is actually picking. */
export const DIFFICULTY_BLURBS = {
  easy: "Generous with pitch. Sing the shape and you will score well.",
  medium: "A quarter-tone is close enough. The usual ear-training standard.",
  hard: "Tuner-tight. Only for when easy and medium have stopped teaching you anything.",
};

const TUNING = {
  easy: {
    perfectCents: 60,     // half a semitone: sing the note and it is the note
    // Wide, but not so wide that a wrong note passes for a near miss.  The far
    // end has a job too: at 350 a whole tone out — singing 2 where the exercise
    // asked for 1 — still scored half marks, and an exercise that cannot tell
    // a student they sang the wrong note is not teaching them anything.  Here
    // a semitone out is 80 and a whole tone is 30.
    zeroCents: 260,
    octaveScore: 85,
    patiencePaces: 4.5,
    nearBar: 60,
    farBar: 30,
  },
  medium: {
    perfectCents: 35,
    zeroCents: 220,
    octaveScore: 75,
    patiencePaces: 3,
    nearBar: 40,
    farBar: 15,
  },
  hard: {
    perfectCents: 15,
    zeroCents: 140,
    octaveScore: 60,
    patiencePaces: 2.2,
    nearBar: 25,
    farBar: 0,
  },
};

function normalise(v) {
  return DIFFICULTIES.indexOf(v) >= 0 ? v : "easy";
}

let _difficulty = "easy";
try {
  _difficulty = normalise(localStorage.getItem(KEY));
} catch (e) { /* private browsing — the default stands */ }

/** The current setting: "easy" | "medium" | "hard". */
export function getDifficulty() { return _difficulty; }

/** The numbers for the current setting. */
export function tuning() { return TUNING[_difficulty]; }

/** The numbers for a named setting, for a chooser that wants to show them. */
export function tuningFor(name) { return TUNING[normalise(name)]; }

/**
 * Change the setting.  Persists locally always, and to the signed-in user's
 * profile when there is one — the save is best-effort, because being unable to
 * reach the server is not a reason to refuse a student an easier exercise.
 */
export function setDifficulty(value) {
  _difficulty = normalise(value);
  try { localStorage.setItem(KEY, _difficulty); } catch (e) { /* ignore */ }
  save(_difficulty);
  return _difficulty;
}

/** Adopt the setting stored on the account, if it has one.  Called once the
 *  account has loaded, so a student arriving on a second device gets what they
 *  chose on the first rather than the default. */
export function adoptAccountDifficulty(value) {
  if (DIFFICULTIES.indexOf(value) < 0) return _difficulty;
  _difficulty = value;
  try { localStorage.setItem(KEY, _difficulty); } catch (e) { /* ignore */ }
  return _difficulty;
}

function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function save(value) {
  try {
    fetch("/api/accounts/me/", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-CSRFToken": csrfToken(),
      },
      body: JSON.stringify({ difficulty: value }),
    }).catch(() => {});
  } catch (e) { /* signed out, offline — the local copy is enough */ }
}
