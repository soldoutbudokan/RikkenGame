// Bid probe: when the auction offers this hand several playable contracts,
// does the cheap selector inside `mcBidEVs` pick the one a deep evaluation
// would pick — and does it make the same bid/pass call?
//
//   HANDS=400 SHARDS=4 REF=400 node ai-bench/bidprobe.mjs candA.jsx candB.jsx
//
// `truthprobe.mjs` established that the card player is saturated: 4x the
// search budget and every inference the public game state still allows are
// each worth ~0.00 +/- 0.006 points per decision. The bidder had no such
// instrument, and it has the same structural risk the card ladder was fixed
// for in 2026-07-28 — a FIRST CUT taken on very little evidence. `mcBidEVs`
// ranks every option on 12 shared worlds, keeps the top 2, and spends the
// remaining 36 worlds only on those. If 12 worlds mis-rank the field, the
// right contract is gone before the deep pass starts.
//
// The reference here is the same estimator with the pruning removed and far
// more worlds: every option scored on REF shared worlds. Options are then
// compared the way `mcChooseBid` compares them — on calibrated value, with
// passing valued by the same family's pass line — so the loss is in the
// units the bidder actually optimises, predicted points per bid decision:
//
//   value(bid i) = a_f + b_f * refEV_i   (only if refEV_i >= floor_f)
//   value(pass)  = c_f + d_f * refEV_best
//   loss         = best value available - value of the choice actually made
//
// Paired on the decision across candidate files, like the other probes.
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { fork } from "child_process";
import { playMatch } from "./harness.mjs";

const self = fileURLToPath(import.meta.url);
const dir = path.dirname(self);
const HANDS = +(process.env.HANDS || 400);
const SHARDS = +(process.env.SHARDS || 4);
const REF = +(process.env.REF || 400);
const files = process.argv.slice(2);
if (!files.length) files.push(path.join(dir, "..", "Rikken.jsx"));

// The bidder's internals are not in harness.mjs's EXPORTS (that list is a
// contract for the AI author, and this probe should not widen it), so load
// the same way with a probe-local export list.
const NEEDED = ["RULES", "legalBids", "contractDef", "callableCards", "aiChooseBid",
  "mcBidOptions", "mcBidRollout", "mcBidValue", "mcBidFamily", "MC_BID_CALIB",
  "shuffle", "makeDeck", "humanShuffle", "deal", "sortHand", "troelaSetup",
  "legalMoves", "trickWinner", "scoreHand", "checkEarlyEnd", "aiChooseCard",
  "mcSampleWorld", "mcRollout"];
function loadBidder(p) {
  const raw = fs.readFileSync(p, "utf8");
  const src = raw.slice(0, raw.indexOf("==== AI END ===="))
    .split("\n").filter((l) => !/^\s*import\s/.test(l) && !/^\s*export\s/.test(l)).join("\n");
  return new Function(src + "\nreturn {" + NEEDED.join(",") + "};")();
}

const SUITS = ["S", "H", "C", "D"];
const RANKS = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];

// Deep, unpruned EV for every option on REF shared worlds.
function refEVs(mod, hand, options, rng) {
  const seen = new Set(hand.map((c) => c.id));
  const pool = [];
  for (const s of SUITS) for (const r of RANKS) if (!seen.has(s + r)) pool.push({ s, r, id: s + r });
  const totals = options.map(() => 0);
  for (let k = 0; k < REF; k++) {
    const p = mod.shuffle(pool, rng);
    const world = { others: [p.slice(0, 13), p.slice(13, 26), p.slice(26, 39)],
      leader: Math.floor(rng() * 4) };
    options.forEach((o, i) => { totals[i] += mod.mcBidRollout(hand, world, o); });
  }
  return totals.map((t) => t / REF);
}

function runShard(n) {
  const mods = files.map(loadBidder);
  const drive = mods[0];
  const acc = files.map(() => ({ loss: 0, agree: 0, sameCall: 0 }));
  const diffs = files.map(() => []);
  let decisions = 0;

  playMatch(drive, drive, n, {
    chooseBid: (m, seat, hand, high) => {
      const legal = drive.legalBids(high, hand);
      const options = drive.mcBidOptions(hand, legal);
      // only selection decisions are informative: one option is no choice,
      // and the misere/troela/piek gates upstream never reach mcBidEVs
      if (options.length < 2 || hand.filter((c) => c.r === 14).length >= 3)
        return drive.aiChooseBid(hand, high);
      const rng = Math.random;
      const ev = refEVs(drive, hand, options, rng);
      const fam = options.map((o) => drive.MC_BID_CALIB[drive.mcBidFamily(o.key)]);
      let bi = 0;
      for (let i = 1; i < options.length; i++)
        if (drive.mcBidValue(options[i].key, ev[i]) > drive.mcBidValue(options[bi].key, ev[bi])) bi = i;
      const passVal = fam[bi].c + fam[bi].d * ev[bi];
      const bidVal = (i) => (ev[i] >= fam[i].floor ? fam[i].a + fam[i].b * ev[i] : -Infinity);
      let bestVal = passVal, refBid = null;
      for (let i = 0; i < options.length; i++)
        if (bidVal(i) > bestVal) { bestVal = bidVal(i); refBid = i; }

      decisions++;
      let chosen0 = null;
      const losses = mods.map((mod, i) => {
        const b = mod.aiChooseBid(hand, high);
        if (i === 0) chosen0 = b;
        let got;
        if (b.key === "pass") got = passVal;
        else {
          const j = options.findIndex((o) => o.key === b.key && (o.trump || null) === (b.trump || null) &&
            ((o.called && o.called.id) || null) === ((b.called && b.called.id) || null));
          // a bid the reference never scored (shape gate reached elsewhere):
          // score it on its own family line at the best option's EV
          got = j >= 0 ? bidVal(j) : bidVal(bi);
        }
        const l = bestVal - (isFinite(got) ? got : bestVal - 1);
        acc[i].loss += l;
        if (l <= 1e-9) acc[i].agree++;
        if ((b.key === "pass") === (refBid === null)) acc[i].sameCall++;
        return l;
      });
      for (let i = 1; i < mods.length; i++) diffs[i].push(losses[i] - losses[0]);
      return chosen0;
    },
  });
  return { decisions, acc, diffs };
}

if (process.env.BID_WORKER) {
  process.send(runShard(+process.env.BID_N));
  process.exit(0);
} else {
  const per = Math.max(1, Math.floor(HANDS / SHARDS));
  const results = [];
  let done = 0;
  for (let i = 0; i < SHARDS; i++) {
    const w = fork(self, files, { env: { ...process.env, BID_WORKER: "1", BID_N: String(per) } });
    w.on("message", (m) => results.push(m));
    w.on("exit", () => { if (++done === SHARDS) finish(); });
  }
  function finish() {
    const decisions = results.reduce((a, r) => a + r.decisions, 0);
    console.log(JSON.stringify({ hands: per * SHARDS, ref: REF, bidDecisions: decisions }));
    files.forEach((f, i) => {
      const loss = results.reduce((a, r) => a + r.acc[i].loss, 0);
      const agree = results.reduce((a, r) => a + r.acc[i].agree, 0);
      const same = results.reduce((a, r) => a + r.acc[i].sameCall, 0);
      let paired = "";
      if (i > 0) {
        const d = results.flatMap((r) => r.diffs[i]);
        const n = d.length, m = d.reduce((x, y) => x + y, 0) / n;
        const se = Math.sqrt(d.reduce((x, y) => x + (y - m) ** 2, 0) / n) / Math.sqrt(n);
        paired = "  paired dLoss " + m.toFixed(4) + " +/- " + se.toFixed(4) +
          " (" + (m / (se || 1)).toFixed(2) + " s.e.)";
      }
      console.log(("[" + i + "] " + path.basename(f)).padEnd(30) +
        " ref loss " + (loss / decisions).toFixed(4) +
        "  best-option rate " + (100 * agree / decisions).toFixed(1) + "%" +
        "  same call " + (100 * same / decisions).toFixed(1) + "%" + paired);
    });
  }
}
