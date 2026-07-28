// Decision-time probe: plays N all-candidate hands and reports the
// distribution of aiChooseCard wall-clock times (the ~150 ms UI budget).
//   HANDS=25 node ai-bench/timeprobe.mjs [candidatePath]
import { fileURLToPath } from "url";
import path from "path";
import { loadAI, playMatch } from "./harness.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const candPath = process.argv[2] || path.join(dir, "..", "Rikken.jsx");
const HANDS = +(process.env.HANDS || 25);
const mod = loadAI(candPath);
const times = [];
const byLeft = new Map();
playMatch(mod, mod, HANDS, {
  chooseCard: (m, seat, game) => {
    const left = game.hands[seat].length;
    const t0 = process.hrtime.bigint();
    const c = m.aiChooseCard(seat, game);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    times.push(ms);
    if (!byLeft.has(left)) byLeft.set(left, []);
    byLeft.get(left).push(ms);
    return c;
  },
});
times.sort((a, b) => a - b);
const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
console.log(JSON.stringify({
  decisions: times.length,
  mean: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2),
  p50: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2),
  p99: +q(0.99).toFixed(2), max: +times[times.length - 1].toFixed(2),
}));
const rows = [...byLeft.entries()].sort((a, b) => b[0] - a[0]).map(([k, v]) => {
  v.sort((a, b) => a - b);
  return { cardsLeft: k, n: v.length,
    mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2),
    p95: +v[Math.min(v.length - 1, Math.floor(0.95 * v.length))].toFixed(2) };
});
console.log(JSON.stringify(rows));
