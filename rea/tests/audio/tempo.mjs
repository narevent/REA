/**
 * Tempo independence.
 *
 * Sight-singing is not a rhythm test.  The same phrase, sung far slower or far
 * faster than the tempo it is written at, must segment and score identically —
 * the written note length is only a seed for the singer's pace, and everything
 * that matters adapts to what they actually sing.
 */
import { runSlots } from "./slots-lib.mjs";

let pass = 0, total = 0;
const T = (...a) => { total++; if (runSlots(...a)) pass++; };

const phrase = (ms, artic) => [
  { midi: 60, ms, artic }, { midi: 62, ms, artic },
  { midi: 64, ms, artic }, { midi: 60, ms, artic },
];
const refs = [60, 62, 64, 60];

// Written as quarter notes at 500 ms.  The singer is told nothing about tempo.
const WRITTEN = 500;
T("sung at the written tempo (500ms)", refs, phrase(500, "hard"), WRITTEN);
T("sung at half speed (1000ms notes)", refs, phrase(1000, "hard"), WRITTEN);
T("sung at double speed (250ms notes)", refs, phrase(250, "hard"), WRITTEN);
T("sung very slowly (1500ms notes)", refs, phrase(1500, "hard"), WRITTEN);
T("sung fast and legato (220ms)", refs, [
  { midi: 60, ms: 220, artic: "hard" },
  { midi: 62, ms: 220, artic: "legato", slideFrom: 60 },
  { midi: 64, ms: 220, artic: "legato", slideFrom: 62 },
  { midi: 60, ms: 300, artic: "legato", slideFrom: 64 },
], WRITTEN);
T("slow, with vibrato on every note", refs, [
  { midi: 60, ms: 1100, artic: "hard", vibCents: 50 },
  { midi: 62, ms: 1100, artic: "hard", vibCents: 50 },
  { midi: 64, ms: 1100, artic: "hard", vibCents: 50 },
  { midi: 60, ms: 1100, artic: "hard", vibCents: 50 },
], WRITTEN);
T("rubato: slow, fast, slow", refs, [
  { midi: 60, ms: 900, artic: "hard" },
  { midi: 62, ms: 300, artic: "hard" },
  { midi: 64, ms: 280, artic: "hard" },
  { midi: 60, ms: 1000, artic: "hard" },
], WRITTEN);
T("repeated pitch, sung slowly", [60, 60, 67], [
  { midi: 60, ms: 950, artic: "hard" },
  { midi: 60, ms: 950, artic: "hard" },
  { midi: 67, ms: 950, artic: "hard" },
], WRITTEN);

console.log("\n" + pass + "/" + total + " tempo cases pass");
