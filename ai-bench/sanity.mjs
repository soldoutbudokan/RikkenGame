// Fast invariant check on the CANDIDATE AI in ../Rikken.jsx before any
// benchmarking: every play legal (the harness counts violations), scoring
// zero-sum (scoreHand throws otherwise), a full match loop that terminates.
//
//   node ai-bench/sanity.mjs        (exit 0 = OK)

import { fileURLToPath } from "url";
import path from "path";
import { loadAI, playMatch } from "./harness.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const cand = loadAI(path.join(dir, "..", "Rikken.jsx"));

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error("FAIL:", m); } };

for (const skill of ["casual", "sharp", "hardest"]) {
  const r = playMatch(cand, cand, skill === "hardest" ? 60 : 150, { skill });
  ok(r.violations === 0, skill + ": no illegal bids or plays, got " + r.violations);
  ok(r.n > 0, skill + ": hands completed");
  ok(r.deltas.every((d) => Number.isFinite(d)), skill + ": finite scores");
}

console.log(fails === 0 ? "SANITY OK" : fails + " SANITY FAILURES");
process.exit(fails === 0 ? 0 : 1);
