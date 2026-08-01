// Bid probe against the CLAIRVOYANT answer — the auction's counterpart to
// truthprobe.mjs.
//
//   HANDS=1200 SHARDS=4 node ai-bench/bidtruth.mjs candA.jsx candB.jsx
//
// `bidprobe.mjs` scores a bid decision against a 400-world reference built
// with the candidate's OWN sampler. That is the right instrument for a search
// BUDGET question (is 200 worlds enough?) and the wrong one for a SAMPLING
// question: change how bid worlds are drawn and the reference moves with the
// candidate, so a conditioned bidder beats a uniform reference by construction
// and a uniform bidder beats a conditioned one. Neither reading is evidence.
//
// The fix is the same one truthprobe.mjs applied to card play. In self-play
// the harness knows the real deal, so every option can be played out in the
// ACTUAL world — that is what a perfect sampler converges to, and it needs no
// reference search at all. Options are then compared exactly the way
// mcChooseBid compares them, on calibrated value with passing valued on the
// same family's pass line:
//
//   trueEV_i     = mean over the 4 possible leaders of mcBidRollout(hand, TRUE world, i)
//   value(bid i) = a_f + b_f * trueEV_i   (only if trueEV_i >= floor_f)
//   value(pass)  = c_f + d_f * trueEV_best
//   loss         = best value available - value of the choice actually made
//
// Leaders are averaged rather than taken from the dealer because the bidder is
// never told who leads — mcBidEVs draws the leader at random, so averaging is
// the quantity it actually optimises.
//
// One deal is a noisy referee, but it is an UNBIASED one, and the statistic
// that matters is paired on the decision: loss_i - loss_0 = got_0 - got_i, so
// the shared best-value term cancels exactly and only decisions where the two
// files disagree carry any variance at all.
//
// Cost: 4 rollouts per option per decision against bidprobe's 400, i.e. two
// orders of magnitude cheaper — 1200 hands runs in a few minutes on 4 cores.
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { fork } from "child_process";
import { playMatch } from "./harness.mjs";

const self = fileURLToPath(import.meta.url);
const dir = path.dirname(self);
const HANDS = +(process.env.HANDS || 1200);
const SHARDS = +(process.env.SHARDS || 4);
const files = process.argv.slice(2);
if (!files.length) files.push(path.join(dir, "..", "Rikken.jsx"));

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

// Exact EV of every option in the one world that is actually on the table,
// averaged over the four seats that could be on lead.
function trueEVs(mod, seat, options, truth) {
  const others = [1, 2, 3].map((k) => truth.hands[(seat + k) % 4]);
  const hand = truth.hands[seat];
  const totals = options.map(() => 0);
  for (let L = 0; L < 4; L++) {
    const world = { others, leader: L };
    options.forEach((o, i) => { totals[i] += mod.mcBidRollout(hand, world, o); });
  }
  return totals.map((t) => t / 4);
}

function runShard(n) {
  const mods = files.map(loadBidder);
  const drive = mods[0];
  const acc = files.map(() => ({ loss: 0, agree: 0, sameCall: 0 }));
  const diffs = files.map(() => []);
  let decisions = 0, disagree = 0;

  playMatch(drive, drive, n, {
    chooseBid: (m, seat, hand, high, truth) => {
      const legal = drive.legalBids(high, hand);
      const options = drive.mcBidOptions(hand, legal);
      // only selection decisions are informative: one option is no choice,
      // and the misere/troela/piek gates upstream never reach mcBidEVs
      if (options.length < 2 || hand.filter((c) => c.r === 14).length >= 3)
        return drive.aiChooseBid(hand, high);
      const ev = trueEVs(drive, seat, options, truth);
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
          // a bid the referee never scored (a shape gate reached elsewhere):
          // score it on its own family line at the best option's EV
          got = j >= 0 ? bidVal(j) : bidVal(bi);
        }
        const l = bestVal - (isFinite(got) ? got : bestVal - 1);
        acc[i].loss += l;
        if (l <= 1e-9) acc[i].agree++;
        if ((b.key === "pass") === (refBid === null)) acc[i].sameCall++;
        return l;
      });
      for (let i = 1; i < mods.length; i++) {
        diffs[i].push(losses[i] - losses[0]);
        if (Math.abs(losses[i] - losses[0]) > 1e-9) disagree++;
      }
      return chosen0;
    },
  });
  return { decisions, disagree, acc, diffs };
}

if (process.env.BIDTRUTH_WORKER) {
  process.send(runShard(+process.env.BIDTRUTH_N));
  process.exit(0);
} else {
  const per = Math.max(1, Math.floor(HANDS / SHARDS));
  const results = [];
  let done = 0;
  for (let i = 0; i < SHARDS; i++) {
    const w = fork(self, files, { env: { ...process.env, BIDTRUTH_WORKER: "1", BIDTRUTH_N: String(per) } });
    w.on("message", (m) => results.push(m));
    w.on("exit", () => { if (++done === SHARDS) finish(); });
  }
  function finish() {
    const decisions = results.reduce((a, r) => a + r.decisions, 0);
    const disagree = results.reduce((a, r) => a + r.disagree, 0);
    console.log(JSON.stringify({ hands: per * SHARDS, bidDecisions: decisions, pairsThatDiffer: disagree }));
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
        " true loss " + (loss / decisions).toFixed(4) +
        "  best-option rate " + (100 * agree / decisions).toFixed(1) + "%" +
        "  same call " + (100 * same / decisions).toFixed(1) + "%" + paired);
    });
  }
}
