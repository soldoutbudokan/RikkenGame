// Length probe: how much does what a seat has ALREADY PLAYED tell you about
// what it still holds?
//
//   HANDS=400 SHARDS=4 node ai-bench/lenprobe.mjs [file.jsx]
//
// Why this exists. `mcSampleWorld` deals every unplaced card uniformly among
// the seats that have room and are not shown void. The only per-seat public
// facts it uses are `voids` — a hard constraint — and, for the declarer only,
// `playedCount` inside `mcApplyBidInference`. But `game.playedCount[s][S]` is
// public for EVERY seat and it is not noise. The 2026-07-29 session showed
// that information, not search, binds the card player; this is a channel of it
// that nothing reads.
//
// What to condition on, and why the obvious answer is wrong. The marginal
// E[rem | playedCount] is dominated by how often the suit has been LED: every
// non-void seat must follow, so a suit led four times gives all of them
// playedCount >= 4 and leaves all of them short. That is a GLOBAL depletion
// the sampler already models exactly, through the size of the unseen pool.
// What the sampler cannot see is the part that differs BETWEEN seats at the
// same moment — the discards. So the statistic that matters is
//
//     delta_s = playedCount[s][S] - mean over the non-void seats
//     ratio   = E[rem_s | delta] / E[rem over the same seats]
//
// which is exactly the relative weight a sampler should give seat s when it
// places a card of suit S, since uniform-over-eligible implies ratio == 1 for
// every delta. Both tables are printed; the second is the one to fit.
import { fileURLToPath } from "url";
import path from "path";
import { fork } from "child_process";
import { loadAI, playMatch } from "./harness.mjs";

const self = fileURLToPath(import.meta.url);
const dir = path.dirname(self);
const HANDS = +(process.env.HANDS || 300);
const SHARDS = +(process.env.SHARDS || 4);
const file = process.argv[2] || path.join(dir, "..", "Rikken.jsx");
const SUITS = ["S", "H", "C", "D"];
const BK = (d) => Math.max(-4, Math.min(4, Math.round(d)));

function runShard(n) {
  const mod = loadAI(file);
  const marg = {};   // key nPlayed|p -> {n,sum}
  const rel = {};    // key bucket(delta) -> {n, sum, base}
  const relLate = {}; // same, only when 6+ cards already played
  playMatch(mod, mod, n, {
    chooseCard: (m, seat, game) => {
      if (game.trick.length === 0) {
        const nPlayed = 13 - game.hands[0].length;
        for (const S of SUITS) {
          const grp = [];
          for (let s = 0; s < 4; s++) {
            if (game.voids[s] && game.voids[s][S]) continue;
            if (!game.hands[s].length) continue;
            grp.push({ s, p: game.playedCount[s][S] || 0,
              rem: game.hands[s].filter((c) => c.s === S).length });
          }
          for (const g of grp) {
            const k = (13 - game.hands[g.s].length) + "|" + g.p;
            const cell = (marg[k] = marg[k] || { n: 0, sum: 0 });
            cell.n++; cell.sum += g.rem;
          }
          if (grp.length < 2) continue;
          const pbar = grp.reduce((a, g) => a + g.p, 0) / grp.length;
          const rbar = grp.reduce((a, g) => a + g.rem, 0) / grp.length;
          if (rbar === 0) continue;
          for (const g of grp) {
            const k = BK(g.p - pbar);
            const c = (rel[k] = rel[k] || { n: 0, sum: 0, base: 0 });
            c.n++; c.sum += g.rem; c.base += rbar;
            if (nPlayed >= 6) {
              const c2 = (relLate[k] = relLate[k] || { n: 0, sum: 0, base: 0 });
              c2.n++; c2.sum += g.rem; c2.base += rbar;
            }
          }
        }
      }
      return m.aiChooseCard(seat, game);
    },
  });
  return { marg, rel, relLate };
}

function mergeInto(a, b, keys) {
  for (const k of Object.keys(b)) {
    const c = (a[k] = a[k] || Object.fromEntries(keys.map((x) => [x, 0])));
    for (const x of keys) c[x] += b[k][x];
  }
  return a;
}

if (process.env.SHARD) {
  process.send(runShard(+process.env.SHARD));
} else if (SHARDS > 1) {
  const per = Math.ceil(HANDS / SHARDS);
  let done = 0;
  const all = { marg: {}, rel: {}, relLate: {} };
  for (let i = 0; i < SHARDS; i++) {
    const ch = fork(self, [file], { env: { ...process.env, SHARD: String(per), SEEDX: String(i) } });
    ch.on("message", (m) => {
      mergeInto(all.marg, m.marg, ["n", "sum"]);
      mergeInto(all.rel, m.rel, ["n", "sum", "base"]);
      mergeInto(all.relLate, m.relLate, ["n", "sum", "base"]);
      if (++done === SHARDS) { report(all); process.exit(0); }
    });
  }
} else {
  report(runShard(HANDS));
}

function report(all) {
  console.log("-- marginal: E[rem | nPlayed, playedCount] (confounded by how often the suit was led) --");
  const keys = Object.keys(all.marg).map((k) => k.split("|").map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [np, p] of keys) {
    const c = all.marg[np + "|" + p];
    if (c.n < 200) continue;
    console.log("  nPlayed " + String(np).padStart(2) + "  p " + String(p).padStart(2) +
      "  n " + String(c.n).padStart(7) + "  E[rem] " + (c.sum / c.n).toFixed(3) +
      "  base " + ((13 - np) / 4).toFixed(2));
  }
  for (const [name, tbl] of [["all tricks", all.rel], ["nPlayed >= 6", all.relLate]]) {
    console.log("\n-- relative: E[rem | delta] / E[rem of the same seats], " + name + " --");
    for (const k of Object.keys(tbl).map(Number).sort((a, b) => a - b)) {
      const c = tbl[k];
      if (c.n < 100) continue;
      console.log("  delta " + String(k).padStart(2) + "  n " + String(c.n).padStart(7) +
        "  E[rem] " + (c.sum / c.n).toFixed(3) + "  peers " + (c.base / c.n).toFixed(3) +
        "  ratio " + (c.sum / c.base).toFixed(4));
    }
  }
}
