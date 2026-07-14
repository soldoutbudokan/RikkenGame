// Candidate-vs-baseline match: is the AI in ../Rikken.jsx measurably
// stronger than the last accepted one (./baseline.jsx)?
//
//   HANDS=2500 node ai-bench/match.mjs
//
// Seats 0+2 play the candidate, 1+3 the baseline (alternating seats kills
// position bias); a control table (candidate on all four seats, expected
// ~0) sanity-checks the harness. Verdict: ACCEPT only if the candidate's
// mean points/hand minus 2 standard errors is positive AND it wins more
// than half of the hands that move money. Exit code 0 = ACCEPT, 1 = REJECT.

import { fileURLToPath } from "url";
import path from "path";
import { loadAI, playMatch, report } from "./harness.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const cand = loadAI(path.join(dir, "..", "Rikken.jsx"));
const base = loadAI(path.join(dir, "baseline.jsx"));

const HANDS = +(process.env.HANDS || 2500);
const main = playMatch(cand, base, HANDS);
report("candidate (A, seats 0+2) vs baseline (B, seats 1+3)", main);
const ctrl = playMatch(cand, cand, Math.max(200, Math.floor(HANDS / 4)));
report("control: candidate vs itself (expect ~0)", ctrl);

const ctrlSuspicious = Math.abs(ctrl.mean) > 3 * ctrl.se;
const accept = main.mean - 2 * main.se > 0 && main.winRate > 0.5 &&
  main.violations === 0 && !ctrlSuspicious;
console.log(JSON.stringify({
  verdict: accept ? "ACCEPT" : "REJECT",
  mean: +main.mean.toFixed(3), se2: +(2 * main.se).toFixed(3),
  winRate: +main.winRate.toFixed(3), hands: main.n,
  violations: main.violations, controlMean: +ctrl.mean.toFixed(3),
  controlSuspicious: ctrlSuspicious,
}));
process.exit(accept ? 0 : 1);
