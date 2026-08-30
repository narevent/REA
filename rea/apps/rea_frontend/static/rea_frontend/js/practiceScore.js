/**
 * practiceScore.js
 *
 * Pure helpers for scoring practice attempts.
 *
 * The scoring model is intentionally simple and transparent so the user can
 * see exactly why they got the score they did:
 *
 *  - Bar-singing modes (2, 5): compare the sequence of sung MIDI notes
 *    against the bar's reference notes (the pitched events).  The alignment
 *    is done with a *duration-weighted Dynamic Time Warping* (DTW) pass:
 *    extra/missing sung notes are absorbed as gaps (a moderate, fixed
 *    penalty) instead of cascading positional mismatches that zero out every
 *    subsequent note.  Each matched pair is scored by the absolute cents
 *    deviation from the nearest reference note, mapped to a 0-100 note
 *    score, and weighted by how long the sung note lasted — a long, in-tune
 *    held note dominates the score; a brief "seeking" blip that happened to
 *    lock for a few frames barely moves it.  Octave errors are penalised
 *    less harshly than other near-misses (a whole-octave sing is still the
 *    right pitch class).
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

import { tuning } from "./difficulty.js?v=114";

/** Gap cost used by the DTW alignment when a sung note has no reference
 *  counterpart (insertion) or a reference note has no sung counterpart
 *  (deletion).  Expressed on the same 0-100 note-score scale so it is
 *  comparable to the per-pair match cost.  Deliberately *moderate*: a single
 *  extra sung note (a brief "seeking" pitch that locked) or a single missed
 *  reference note should hurt, but must not cascade into a string of zeros
 *  the way a strict positional alignment does. */
const DTW_GAP_COST = 35;

/**
 * Map a cents deviation (absolute) to a 0-100 note score.
 *
 * The window is the student's own — see `difficulty.js`, which holds the three
 * settings and the reasoning.  It used to be fixed at twenty cents for full
 * marks, which is a fifth of a semitone on every note of every bar: good
 * singing scored in the seventies and a high score was not something a student
 * could work towards.
 */
export function centsToScore(absCents) {
  const t = tuning();
  const c = Math.abs(absCents);
  if (c <= t.perfectCents) return 100;
  if (c >= t.zeroCents) return 0;
  // Linear falloff between the two.
  return Math.round(100 * (1 - (c - t.perfectCents) / (t.zeroCents - t.perfectCents)));
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
 * Cost (0-100 scale, lower is better) of matching a sung note to a reference
 * note.  Combines cents accuracy with an octave tolerance: a whole-octave
 * error (same pitch class) is the right note in the wrong register, so it is
 * scored far more leniently than an unrelated semitone miss.
 */
function matchCost(sungMidi, refMidi) {
  if (sungMidi == null || refMidi == null) return DTW_GAP_COST;
  const diff = sungMidi - refMidi;
  // Octave equivalence: same pitch class is treated as "near".
  if (Math.abs(diff) > 2 && diff % 12 === 0) {
    // Right pitch class, wrong octave.  Give it a solid-but-not-perfect score
    // so an octave-down sing still reads as mostly correct.
    return 100 - tuning().octaveScore;
  }
  const cents = Math.abs(diff) * 100;
  return 100 - centsToScore(cents);
}

/**
 * Score a sung bar against reference notes using duration-weighted DTW.
 *
 * @param {Array<number|{midi:number,durMs:number}>} sung
 *   ordered sung notes.  Each entry is either a plain MIDI number (treated
 *   as weight 1) or a `{ midi, durMs }` object so longer-held notes weigh more.
 * @param {number[]} reference  ordered reference MIDI notes (pitched events)
 * @returns {{ score, perNote: [{ sung, ref, cents, score }] }}
 *   `perNote` describes each *reference* note's matched sung note (or null
 *   for an unmatched/missing one), in reference order — stable and easy to
 *   render in the feedback row.
 */
export function scoreSungBar(sung, reference) {
  const ref = (reference || []).filter((m) => m != null);
  if (!ref.length) return { score: 0, perNote: [] };

  // Normalise sung into { midi, durMs } with a minimum weight so even
  // unweighted callers don't get division-by-zero in the weighting.
  const S = (sung || []).map((s) => {
    if (s == null) return null;
    if (typeof s === "number") return { midi: s, durMs: 1 };
    return { midi: s.midi, durMs: s.durMs != null && s.durMs > 0 ? s.durMs : 1 };
  }).filter((s) => s != null);

  if (!S.length) {
    // Nothing sung: every reference note is a miss.
    return {
      score: 0,
      perNote: ref.map((r) => ({ sung: null, ref: r, cents: null, score: 0, missing: false, extra: false })),
    };
  }

  const n = S.length;
  const m = ref.length;

  // When the sung count matches the reference count (the normal case after
  // the controller prunes seeking stabs), score by a clean 1:1 positional
  // pairing: sung[i] <-> ref[i].  This guarantees exactly one chip per
  // reference note and never emits the "extra" / "missing" gap pairs that
  // DTW can introduce (one extra + one missing chip) even when the counts
  // are equal — those phantom chips disrupt the feedback flow and drag the
  // score with a gap penalty for no good reason.  DTW (with its gap
  // absorption) is only used when the counts genuinely differ, i.e. the user
  // sang fewer or more notes than the exercise and we must decide which
  // reference notes were missed.
  if (n === m) {
    const pairs = [];
    let totalW = 0, sumScore = 0;
    for (let k = 0; k < m; k++) {
      const s = S[k];
      const r = ref[k];
      const diff = s.midi - r;
      let cents = diff * 100;
      let noteScore;
      if (Math.abs(diff) > 2 && diff % 12 === 0) {
        noteScore = tuning().octaveScore;   // right class, wrong register
      } else {
        noteScore = centsToScore(cents);
      }
      const weight = s.durMs;
      totalW += weight;
      sumScore += noteScore * weight;
      pairs.push({ sung: s.midi, ref: r, cents, score: noteScore, missing: false, extra: false });
    }
    const score = totalW > 0 ? Math.round(sumScore / totalW) : 0;
    return { score, perNote: pairs };
  }

  // DTW cost matrix.  dp[i][j] = minimal accumulated cost to align the first
  // i sung notes with the first j reference notes.  Moves:
  //   (i-1,j-1): match sung[i-1] with ref[j-1]
  //   (i-1,  j ): sung[i-1] is an extra (insertion, no ref consumed)
  //   (  i ,j-1): ref[j-1] is missing (deletion, no sung consumed)
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = 1; i <= n; i++) dp[i][0] = dp[i - 1][0] + DTW_GAP_COST;
  for (let j = 1; j <= m; j++) dp[0][j] = dp[0][j - 1] + DTW_GAP_COST;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const match = dp[i - 1][j - 1] + matchCost(S[i - 1].midi, ref[j - 1]);
      const ins = dp[i - 1][j] + DTW_GAP_COST;
      const del = dp[i][j - 1] + DTW_GAP_COST;
      dp[i][j] = Math.min(match, ins, del);
    }
  }

  // Backtrack to recover the alignment, then weight each matched pair by the
  // sung note's duration (longer notes matter more).  Gaps carry a fixed
  // penalty weighted at 1.0 so they neither vanish nor dominate.
  const pairs = []; // { sungMidi, refMidi, score, weight }  (refMidi null => extra; sungMidi null => missing)
  let i = n, j = m;
  while (i > 0 && j > 0) {
    const match = dp[i - 1][j - 1] + matchCost(S[i - 1].midi, ref[j - 1]);
    const ins = dp[i - 1][j] + DTW_GAP_COST;
    const del = dp[i][j - 1] + DTW_GAP_COST;
    const best = Math.min(match, ins, del);
    if (best === match) {
      const s = S[i - 1];
      const r = ref[j - 1];
      const diff = s.midi - r;
      let cents = diff * 100;
      let noteScore;
      if (Math.abs(diff) > 2 && diff % 12 === 0) {
        noteScore = tuning().octaveScore;
      } else {
        noteScore = centsToScore(cents);
      }
      pairs.push({ sungMidi: s.midi, refMidi: r, cents, score: noteScore, weight: s.durMs });
      i -= 1; j -= 1;
    } else if (best === ins) {
      // Extra sung note (no reference).  Penalise lightly and don't let it
      // blow up the average — weight it at 0.5 so a brief seeking blip barely
      // counts but a long wrong note still hurts.
      pairs.push({ sungMidi: S[i - 1].midi, refMidi: null, cents: null, score: 0, extra: true, weight: Math.min(S[i - 1].durMs, 1) * 0.5 });
      i -= 1;
    } else {
      // Missing reference note (not sung).
      pairs.push({ sungMidi: null, refMidi: ref[j - 1], cents: null, score: 0, missing: true, weight: 1 });
      j -= 1;
    }
  }
  while (i > 0) {
    pairs.push({ sungMidi: S[i - 1].midi, refMidi: null, cents: null, score: 0, extra: true, weight: Math.min(S[i - 1].durMs, 1) * 0.5 });
    i -= 1;
  }
  while (j > 0) {
    pairs.push({ sungMidi: null, refMidi: ref[j - 1], cents: null, score: 0, missing: true, weight: 1 });
    j -= 1;
  }

  // Weighted average of per-pair scores (0-100).  This is the bar score.
  let totalW = 0, sumScore = 0;
  for (const p of pairs) {
    totalW += p.weight;
    sumScore += p.score * p.weight;
  }
  const score = totalW > 0 ? Math.round(sumScore / totalW) : 0;

  // Build perNote in *reference* order (stable for the feedback UI): one
  // entry per reference note, plus trailing entries for extra sung notes.
  pairs.reverse();
  const perNote = [];
  for (const p of pairs) {
    perNote.push({
      sung: p.sungMidi,
      ref: p.refMidi,
      cents: p.cents,
      score: p.score,
      missing: !!p.missing,
      extra: !!p.extra,
    });
  }

  return { score, perNote };
}

/**
 * Score a guessed bar against the reference bar.
 *
 * Exact match scores 100; a neighbour earns partial credit, because hearing
 * that a phrase was *nearly* the one you picked is most of the skill and
 * scoring it as nothing tells the student less than it could.  How much
 * partial credit is the student's setting — see `difficulty.js`.
 */
export function scoreGuessBar(guessedIndex, referenceIndex, totalBars) {
  if (guessedIndex == null || referenceIndex == null) return 0;
  if (guessedIndex === referenceIndex) return 100;
  const t = tuning();
  const dist = Math.abs(guessedIndex - referenceIndex);
  if (dist === 1) return t.nearBar;
  if (dist === 2) return t.farBar;
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