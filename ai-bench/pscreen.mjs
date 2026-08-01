// Parallel sharded screener: pools K independent candidate-vs-baseline tables
// across worker processes for ~K x throughput. NOT the official gate — use
// match.mjs for the recorded accept decision — but statistically the same
// estimator (independent tables pooled), so it pre-screens ideas cheaply.
//
//   HANDS=2500 SHARDS=4 node ai-bench/pscreen.mjs [candidatePath]
//
// Each worker plays HANDS/SHARDS hands as its own table (independent RNG /
// shuffle carry-over) and prints its deltas as JSON; the parent pools them
// and reports mean, se, mean-1se, mean-2se, win rate, violations.
import { fileURLToPath } from "url";
import path from "path";
import { fork } from "child_process";
import { loadAI, playMatch } from "./harness.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const HANDS = +(process.env.HANDS || 2500);
const SHARDS = +(process.env.SHARDS || 4);
const candPath = process.argv[2] || path.join(dir, "..", "Rikken.jsx");
const basePath = path.join(dir, "baseline.jsx");

if (process.env.PSCREEN_WORKER) {
  const n = +process.env.PSCREEN_N;
  const cand = loadAI(candPath);
  const base = loadAI(basePath);
  const r = playMatch(cand, base, n);
  process.send({ deltas: r.deltas, wins: r.wins, ties: r.ties,
    violations: r.violations, declMade: r.declMade });
  process.exit(0);
} else {
  const per = Math.floor(HANDS / SHARDS);
  const workers = [];
  const results = [];
  let done = 0;
  for (let i = 0; i < SHARDS; i++) {
    const w = fork(fileURLToPath(import.meta.url), [candPath], {
      env: { ...process.env, PSCREEN_WORKER: "1", PSCREEN_N: String(per) },
    });
    w.on("message", (m) => results.push(m));
    w.on("exit", () => {
      if (++done === SHARDS) finish();
    });
    workers.push(w);
  }
  function finish() {
    const deltas = results.flatMap((r) => r.deltas);
    const wins = results.reduce((a, r) => a + r.wins, 0);
    const ties = results.reduce((a, r) => a + r.ties, 0);
    const violations = results.reduce((a, r) => a + r.violations, 0);
    const n = deltas.length;
    const mean = deltas.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    const se = sd / Math.sqrt(n);
    const winRate = wins / Math.max(1, n - ties);
    console.log(JSON.stringify({
      hands: n, mean: +mean.toFixed(3), se: +se.toFixed(3),
      mean_minus_1se: +(mean - se).toFixed(3),
      mean_minus_2se: +(mean - 2 * se).toFixed(3),
      winRate: +winRate.toFixed(3), violations,
    }));
  }
}
