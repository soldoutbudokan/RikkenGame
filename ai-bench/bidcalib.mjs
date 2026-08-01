// Bid-scale probe: what does a change to the bid ESTIMATOR do to the scale
// MC_BID_CALIB's thresholds are written in?
//
//   HANDS=800 SHARDS=4 node ai-bench/bidcalib.mjs [candidatePath]
//
// MC_BID_CALIB's lines and floors were fitted by `explore.mjs` on decisions
// taken with a specific estimator: 12 shared worlds over every option, prune
// to the top 2, 36 more worlds on those. A threshold like rik's floor of -1.5
// is therefore a statement in OBSERVED-EV coordinates, and observed EV is true
// EV plus estimator noise. Make the estimator less noisy and the same number
// means a different hand — the fitted apparatus silently shifts.
//
// The usual fix is to re-run the whole randomized experiment (16,000 hands,
// hours) and re-fit. That is the right tool when the QUESTION is where the
// profit-maximizing threshold lies. It is the wrong tool here: the realized
// outcomes already answered that, in true-EV space, and all that is needed is
// the coordinate change. So measure the coordinate change directly.
//
// For each real bid decision, three disjoint blocks of shared worlds:
//   A  48 worlds, replaying the OLD 12/prune-2/36 procedure  -> x48
//   B  NEW worlds, the candidate procedure                   -> xNew
//   C  REF worlds, treated as ground truth                   -> y
// Each block picks its own best option by calibrated value, and y is that
// option's reference EV — so the regression y ~ x absorbs the winner's curse
// of each procedure, not just its noise. Fitting
//
//   y = aOld + bOld * x48        y = aNew + bNew * xNew
//
// gives the map that puts a new-estimator EV back on the scale the thresholds
// were written in:  equiv = (aNew - aOld + bNew * ev) / bOld.
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { fork } from "child_process";
import { playMatch } from "./harness.mjs";

const self = fileURLToPath(import.meta.url);
const dir = path.dirname(self);
const HANDS = +(process.env.HANDS || 800);
const SHARDS = +(process.env.SHARDS || 4);
const NEW = +(process.env.NEW || 200);
const REF = +(process.env.REF || 800);
const candPath = process.argv[2] || path.join(dir, "..", "Rikken.jsx");

const NEEDED = ["RULES", "legalBids", "contractDef", "callableCards", "aiChooseBid",
  "mcBidOptions", "mcBidRollout", "mcBidValue", "mcBidFamily", "MC_BID_CALIB",
  "shuffle", "makeDeck", "humanShuffle", "deal", "sortHand", "troelaSetup",
  "legalMoves", "trickWinner", "scoreHand", "checkEarlyEnd", "aiChooseCard",
  "mcSampleWorld", "mcRollout"];
function load(p) {
  const raw = fs.readFileSync(p, "utf8");
  const src = raw.slice(0, raw.indexOf("==== AI END ===="))
    .split("\n").filter((l) => !/^\s*import\s/.test(l) && !/^\s*export\s/.test(l)).join("\n");
  return new Function(src + "\nreturn {" + NEEDED.join(",") + "};")();
}
const SUITS = ["S", "H", "C", "D"];
const RANKS = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];

function runShard(n) {
  const mod = load(candPath);
  const rows = [];
  playMatch(mod, mod, n, {
    chooseBid: (m, seat, hand, high) => {
      const legal = mod.legalBids(high, hand);
      const options = mod.mcBidOptions(hand, legal);
      if (!options.length || hand.filter((c) => c.r === 14).length >= 3)
        return mod.aiChooseBid(hand, high);
      const rng = Math.random;
      const seen = new Set(hand.map((c) => c.id));
      const pool = [];
      for (const s of SUITS) for (const r of RANKS) if (!seen.has(s + r)) pool.push({ s, r, id: s + r });
      const total = 48 + NEW + REF;
      const sums = options.map(() => new Float64Array(3)); // [A, B, C]
      for (let k = 0; k < total; k++) {
        const p = mod.shuffle(pool, rng);
        const world = { others: [p.slice(0, 13), p.slice(13, 26), p.slice(26, 39)],
          leader: Math.floor(rng() * 4) };
        const blk = k < 48 ? 0 : k < 48 + NEW ? 1 : 2;
        // the old procedure prunes after its first 12 worlds; replay that by
        // scoring every option for 12, then only the survivors
        const preDone = k >= 12 && blk === 0;
        let live = options.map((o, i) => i);
        if (preDone) live = aliveOld(sums, options, mod);
        for (const i of live) sums[i][blk] += mod.mcBidRollout(hand, world, options[i]);
      }
      const evA = options.map((o, i) => sums[i][0] / (aliveOld(sums, options, mod).includes(i) ? 48 : 12));
      const evB = options.map((o, i) => sums[i][1] / NEW);
      const evC = options.map((o, i) => sums[i][2] / REF);
      const pickBy = (ev, pool2) => pool2.reduce((a, b) =>
        mod.mcBidValue(options[b].key, ev[b]) > mod.mcBidValue(options[a].key, ev[a]) ? b : a);
      const iA = pickBy(evA, aliveOld(sums, options, mod));
      const iB = pickBy(evB, options.map((o, i) => i));
      rows.push({ famA: mod.mcBidFamily(options[iA].key), xA: evA[iA], yA: evC[iA],
        famB: mod.mcBidFamily(options[iB].key), xB: evB[iB], yB: evC[iB] });
      return mod.aiChooseBid(hand, high);
    },
  });
  return rows;
}
// the two options the old procedure keeps after its 12-world pre-pass
function aliveOld(sums, options, mod) {
  return options.map((o, i) => i)
    .sort((a, b) => mod.mcBidValue(options[b].key, sums[b][0] / 12) -
                    mod.mcBidValue(options[a].key, sums[a][0] / 12)).slice(0, 2);
}

if (process.env.CALIB_WORKER) {
  process.send(runShard(+process.env.CALIB_N));
  process.exit(0);
} else {
  const per = Math.max(1, Math.floor(HANDS / SHARDS));
  const all = [];
  let done = 0;
  for (let i = 0; i < SHARDS; i++) {
    const w = fork(self, [candPath], { env: { ...process.env, CALIB_WORKER: "1", CALIB_N: String(per) } });
    w.on("message", (m) => all.push(...m));
    w.on("exit", () => { if (++done === SHARDS) finish(); });
  }
  const ols = (pts) => {
    const n = pts.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const a = (sy - b * sx) / n;
    let sr = 0;
    for (const [x, y] of pts) sr += (y - a - b * x) ** 2;
    const seb = Math.sqrt(sr / (n - 2) / (sxx - sx * sx / n));
    return { a: +a.toFixed(4), b: +b.toFixed(4), seb: +seb.toFixed(4), n };
  };
  function finish() {
    const fams = ["rik", "rik_beter", "rik9plus", "abondance"];
    const old = ols(all.map((r) => [r.xA, r.yA]));
    const neu = ols(all.map((r) => [r.xB, r.yB]));
    console.log(JSON.stringify({ hands: per * SHARDS, decisions: all.length, newWorlds: NEW, ref: REF }));
    console.log("old estimator (12/prune2/36): " + JSON.stringify(old));
    console.log("new estimator (" + NEW + ", no prune): " + JSON.stringify(neu));
    const equiv = (ev) => (neu.a - old.a + neu.b * ev) / old.b;
    console.log("equiv(ev) = (" + neu.a.toFixed(4) + " - " + old.a.toFixed(4) + " + " +
      neu.b.toFixed(4) + " * ev) / " + old.b.toFixed(4));
    console.log("threshold in NEW coordinates that reproduces the fitted one:");
    for (const f of fams) {
      // solve equiv(x) = oldThreshold
      const solve = (t) => +(((t * old.b) - neu.a + old.a) / neu.b).toFixed(3);
      console.log("  " + f.padEnd(10) + " floor " + String(FLOORS[f]).padStart(6) +
        "  ->  " + solve(FLOORS[f]).toFixed(3));
    }
    for (const f of fams) {
      const A = all.filter((r) => r.famA === f).map((r) => [r.xA, r.yA]);
      const B = all.filter((r) => r.famB === f).map((r) => [r.xB, r.yB]);
      if (A.length > 40 && B.length > 40)
        console.log("  [" + f + "] old " + JSON.stringify(ols(A)) + " new " + JSON.stringify(ols(B)));
    }
  }
  var FLOORS = { rik: -1.5, rik_beter: -1.5, rik9plus: -0.3, abondance: 1.0 };
}
