// Truth probe: how much does a card decision give up against the clairvoyant
// answer, and does variant B give up less than variant A on the SAME decision?
//
//   HANDS=200 SHARDS=4 node ai-bench/truthprobe.mjs candA.jsx candB.jsx ...
//
// Why this exists. `refprobe.mjs` scores a search SCHEDULE against a deep
// reference built with the same sampler, so it can only see budget changes —
// a better `mcSampleWorld` moves the reference with the candidate and cancels
// out. And a 2500/4000-hand screen has a standard error near 0.10 pts/hand,
// which is larger than almost any single idea on this branch.
//
// The clairvoyant value fixes both problems. In a self-play hand the harness
// knows the real deal, so for every legal card we can play the ACTUAL world
// out with `mcRollout` and read the seat's exact score under the rollout
// policy. That is the answer a perfect sampler would converge to, and it needs
// no reference search at all: legal-many deterministic rollouts, cheaper than
// one extra batch of the ladder. Each variant then answers the same decision
// with its own `aiChooseCard`, and its loss is
//
//     max_c trueEV(c) - trueEV(variant's card)
//
// Paired on the decision, so per-position difficulty cancels — most decisions
// agree and contribute an exact zero, which is where the precision comes from.
//
// Caveats, in the same spirit as BEST-PRACTICES.md's: the clairvoyant answer
// is "best against this rollout policy with everything visible", so it cannot
// credit information-hiding or deception, and for a change to `mcPolicy` the
// yardstick itself moves (variant 0's policy always scores the truth, so a
// policy change is measured against the OLD policy's notion of best). It is a
// clean instrument for `mcSampleWorld` and for search-budget changes, and an
// indicative one for policy changes.
import { fileURLToPath } from "url";
import path from "path";
import { fork } from "child_process";
import { loadAI, playMatch } from "./harness.mjs";

const self = fileURLToPath(import.meta.url);
const dir = path.dirname(self);
const HANDS = +(process.env.HANDS || 120);
const SHARDS = +(process.env.SHARDS || 4);
const MINLEGAL = +(process.env.MINLEGAL || 2);
const [LO, HI] = (process.env.LEFT || "2,13").split(",").map(Number);
const files = process.argv.slice(2);
if (!files.length) files.push(path.join(dir, "..", "Rikken.jsx"));

function runShard(n) {
  const mods = files.map((f) => loadAI(f));
  const drive = mods[0]; // variant 0 also plays the hands: same states for all
  const acc = files.map(() => ({ loss: 0, agree: 0, ms: 0 }));
  const diffs = files.map(() => []); // per-decision loss minus variant 0's
  const byLeft = new Map();
  let decisions = 0;

  playMatch(drive, drive, n, {
    chooseCard: (m, seat, game) => {
      const c = game.contract;
      const trump = game.trump != null ? game.trump : c.trump;
      const legal = drive.legalMoves(game.hands[seat], game.trick, trump, c);
      const left = game.hands[seat].length;
      let played = null;
      if (legal.length >= MINLEGAL && left >= LO && left <= HI) {
        // clairvoyant value of every legal card in the REAL world
        const trueEV = new Map();
        let best = -Infinity;
        for (const x of legal) {
          const v = drive.mcRollout(game.hands, seat, x, game);
          trueEV.set(x.id, v);
          if (v > best) best = v;
        }
        decisions++;
        const losses = mods.map((mod, i) => {
          const t0 = process.hrtime.bigint();
          const pick = mod.aiChooseCard(seat, game);
          acc[i].ms += Number(process.hrtime.bigint() - t0) / 1e6;
          if (i === 0) played = pick;
          const l = best - (trueEV.has(pick.id) ? trueEV.get(pick.id) : best);
          acc[i].loss += l;
          if (l <= 0) acc[i].agree++;
          return l;
        });
        for (let i = 1; i < mods.length; i++) diffs[i].push(losses[i] - losses[0]);
        if (!byLeft.has(left)) byLeft.set(left, mods.map(() => 0));
        const row = byLeft.get(left);
        losses.forEach((l, i) => { row[i] += l; });
      }
      return played || drive.aiChooseCard(seat, game);
    },
  });
  return { decisions, acc, diffs, byLeft: [...byLeft.entries()] };
}

if (process.env.TRUTH_WORKER) {
  const r = runShard(+process.env.TRUTH_N);
  process.send(r);
  process.exit(0);
} else {
  const per = Math.max(1, Math.floor(HANDS / SHARDS));
  const results = [];
  let done = 0;
  for (let i = 0; i < SHARDS; i++) {
    const w = fork(self, files, {
      env: { ...process.env, TRUTH_WORKER: "1", TRUTH_N: String(per) },
    });
    w.on("message", (m) => results.push(m));
    w.on("exit", () => { if (++done === SHARDS) finish(); });
  }
  function finish() {
    const decisions = results.reduce((a, r) => a + r.decisions, 0);
    const acc = files.map((_, i) => ({
      loss: results.reduce((a, r) => a + r.acc[i].loss, 0),
      agree: results.reduce((a, r) => a + r.acc[i].agree, 0),
      ms: results.reduce((a, r) => a + r.acc[i].ms, 0),
    }));
    console.log(JSON.stringify({ hands: per * SHARDS, decisions,
      cardsLeft: [LO, HI], minLegal: MINLEGAL }));
    files.forEach((f, i) => {
      const a = acc[i];
      let paired = "";
      if (i > 0) {
        const d = results.flatMap((r) => r.diffs[i]);
        const n = d.length, m = d.reduce((x, y) => x + y, 0) / n;
        const se = Math.sqrt(d.reduce((x, y) => x + (y - m) ** 2, 0) / n) / Math.sqrt(n);
        paired = "  paired dLoss " + m.toFixed(4) + " +/- " + se.toFixed(4) +
          " (" + (m / (se || 1)).toFixed(2) + " s.e.)";
      }
      console.log(("[" + i + "] " + path.basename(f)).padEnd(30) +
        " clairvoyant loss " + (a.loss / decisions).toFixed(4) +
        "  best-card rate " + (100 * a.agree / decisions).toFixed(1) + "%" +
        "  mean ms " + (a.ms / decisions).toFixed(1) + paired);
    });
    // where the loss sits, by cards remaining
    const rows = new Map();
    for (const r of results)
      for (const [k, v] of r.byLeft) {
        if (!rows.has(k)) rows.set(k, files.map(() => 0));
        const row = rows.get(k);
        v.forEach((x, i) => { row[i] += x; });
      }
    console.log("cardsLeft loss totals: " + JSON.stringify(
      [...rows.entries()].sort((a, b) => b[0] - a[0])
        .map(([k, v]) => [k, ...v.map((x) => +x.toFixed(1))])));
  }
}
