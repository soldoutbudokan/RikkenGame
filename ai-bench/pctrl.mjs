// Parallel control: candidate vs an identical copy of itself, pooled. Checks
// harness/seat bias (expect |mean| <= 3*se). ARGS: <candA> <candB>
import { fileURLToPath } from "url";
import { fork } from "child_process";
import { loadAI, playMatch } from "./harness.mjs";
const HANDS = +(process.env.HANDS || 2000);
const SHARDS = +(process.env.SHARDS || 4);
const A = process.argv[2], B = process.argv[3];
if (process.env.PC_WORKER) {
  const r = playMatch(loadAI(A), loadAI(B), +process.env.PC_N);
  process.send({ deltas: r.deltas, violations: r.violations });
  process.exit(0);
} else {
  const per = Math.floor(HANDS / SHARDS); const results = []; let done = 0;
  for (let i = 0; i < SHARDS; i++) {
    const w = fork(fileURLToPath(import.meta.url), [A, B],
      { env: { ...process.env, PC_WORKER: "1", PC_N: String(per) } });
    w.on("message", (m) => results.push(m));
    w.on("exit", () => { if (++done === SHARDS) fin(); });
  }
  function fin() {
    const d = results.flatMap((r) => r.deltas);
    const v = results.reduce((a, r) => a + r.violations, 0);
    const n = d.length, mean = d.reduce((a, b) => a + b, 0) / n;
    const se = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / n) / Math.sqrt(n);
    console.log(JSON.stringify({ hands: n, mean: +mean.toFixed(3), se: +se.toFixed(3),
      suspicious: Math.abs(mean) > 3 * se, violations: v }));
  }
}
