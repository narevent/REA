import { runCase } from "./chain.mjs";
let pass = 0, total = 0;
const T = (name, notes) => { total++; if (runCase(name, notes)) pass++; };

T("same pitch twice, no silence between (the repeat case)", [
  { midi: 60, ms: 500, artic: "hard" },
  { midi: 60, ms: 500, artic: "hard" },
]);
T("three of the same pitch", [
  { midi: 62, ms: 420, artic: "hard" },
  { midi: 62, ms: 420, artic: "hard" },
  { midi: 62, ms: 420, artic: "hard" },
]);
T("legato step up, no articulation", [
  { midi: 60, ms: 520, artic: "hard" },
  { midi: 62, ms: 520, artic: "legato", slideFrom: 60 },
]);
T("one long note with vibrato stays one note", [
  { midi: 67, ms: 1400, artic: "hard", vibCents: 45 },
]);
T("scooped attack scores where it landed", [
  { midi: 64, ms: 700, artic: "soft", scoopCents: 140 },
]);
T("breath between notes", [
  { midi: 60, ms: 400, artic: "hard", gapMs: 260 },
  { midi: 65, ms: 400, artic: "hard" },
]);
T("a phrase at tempo (eighths ~250ms)", [
  { midi: 60, ms: 250, artic: "hard" },
  { midi: 62, ms: 250, artic: "hard" },
  { midi: 64, ms: 250, artic: "hard" },
  { midi: 65, ms: 250, artic: "hard" },
  { midi: 67, ms: 500, artic: "hard" },
]);
T("wide vibrato is still one note", [
  { midi: 67, ms: 1400, artic: "hard", vibCents: 80 },
]);
T("re-articulation while the voice is wobbling", [
  { midi: 65, ms: 600, artic: "hard", vibCents: 55 },
  { midi: 65, ms: 600, artic: "hard", vibCents: 55 },
]);
T("descending phrase, mixed articulation", [
  { midi: 72, ms: 380, artic: "hard" },
  { midi: 71, ms: 380, artic: "legato", slideFrom: 72 },
  { midi: 69, ms: 380, artic: "soft" },
  { midi: 67, ms: 600, artic: "hard", vibCents: 40 },
]);
console.log("\n" + pass + "/" + total + " cases pass");
