/**
 * practiceScore.js
 *
 * Pure helpers for scoring practice attempts.
 *
 * The scoring model is intentionally simple and transparent so the user can
 * see exactly why they got the score they did:
 *
 *  - Bar-singing modes (2, 5): compare the sequence of sung MIDI notes
 *    against the bar's reference notes (the pitched events).  Each note is
 *    scored by the absolute cents deviation from the nearest reference note,
 *    mapped to a 0-100 note score.  The bar score is the average note score
 *    (minus penalties for missing/extra notes), capped to 0-100.
 *
 *  - Bar-guessing modes (3, 4): exact-match scoring - did the user click the
 *    bar that was actually played?  100 for a correct bar, partial credit for
 *    being one bar off (proximity), 0 otherwise.
 *
 *  - Note-guessing modes (6, 7, 10): compare the guessed scale degree (from
 *    the bar the user selected) against the reference degree.  100 for an
 *    exact degree match, scaled-down credit for the right pitch class even if
 *    the wrong octave, 0 otherwise.
 */

/** Map a cents deviation (absolute) to a 0-100 note score. */
export function centsToScore(absCents) {
  const c = Math.abs(absCents);
  if (c <= 12) return 100;             // within a quarter tone -> perfect
  if (c >= 150) return 0;              // more than 1.5 semitones off -> 0
  // Linear falloff between 12c (100) and 150c (0).
  return Math.round(100 * (1 - (c - 12) / (150 - 12)));
}

/** Map a 0-100 note score to a short label. */
export function scoreLabel(score) {
  if (score >= 95) return "Perfect";
  if (score >= 85) return "Great";
  if (score >= 70) return "Good";
  if (score >= 50) return "OK";
  if (score >= 30) return "Weak";
  return "Miss";
}

/**
 * Score a sung bar against reference notes.
 *
 * @param {number[]} sung       ordered MIDI (rounded) notes the user sang
 * @param {number[]} reference  ordered reference MIDI notes (pitched events)
 * @returns {{ score, perNote: [{ sung, ref, cents, score }] }}
 */
export function scoreSungBar(sung, reference) {
  const ref = (reference || []).filter((m) => m != null);
  if (!ref.length) return { score: 0, perNote: [] };
  const n = Math.max(sung.length, ref.length);
  const perNote = [];
  let sum = 0;
  let counted = 0;
  for (let i = 0; i < n; i++) {
    const s = sung[i] != null ? sung[i] : null;
    const r = ref[i] != null ? ref[i] : null;
    if (s == null || r == null) {
      // Missing or extra note -> heavy penalty, but keep it finite.
      perNote.push({ sung: s, ref: r, cents: null, score: 0, missing: s == null, extra: r == null });
      sum += 0;
      counted += 1;
      continue;
    }
    const cents = (s - r) * 100;
    const noteScore = centsToScore(cents);
    perNote.push({ sung: s, ref: r, cents, score: noteScore });
    sum += noteScore;
    counted += 1;
  }
  const score = counted ? Math.round(sum / counted) : 0;
  return { score, perNote };
}

/**
 * Score a guessed bar against the reference bar.
 *
 * Exact match -> 100; one bar off (proximity) -> 40; otherwise 0.
 */
export function scoreGuessBar(guessedIndex, referenceIndex, totalBars) {
  if (guessedIndex == null || referenceIndex == null) return 0;
  if (guessedIndex === referenceIndex) return 100;
  const dist = Math.abs(guessedIndex - referenceIndex);
  if (dist === 1) return 40;
  if (dist === 2) return 15;
  return 0;
}

/**
 * Score a guessed note / scale-degree attempt.
 *
 * @param {number} guessedDegree  the degree the user picked
 * @param {number} referenceDegree the degree that was played
 * @returns {number} 0-100
 */
export function scoreGuessNote(guessedDegree, referenceDegree) {
  if (guessedDegree == null || referenceDegree == null) return 0;
  if (Number(guessedDegree) === Number(referenceDegree)) return 100;
  return 0;
}