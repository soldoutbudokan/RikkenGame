// Policy duel: which in-rollout policy plays the CLAIRVOYANT game better?
//
//   DEALS=4000 SHARDS=4 node ai-bench/policyduel.mjs A.jsx B.jsx
//
// Why this exists. `mcPolicy` is the evaluation function underneath every
// number this AI computes — every card rollout and every bid rollout ends in
// a score that mcPolicy produced — and it is the one component no instrument
// in this directory can see:
//
//  - `truthprobe.mjs` scores a decision against "best against THIS rollout
//    policy with everything visible", so the yardstick moves with the change
//    (its own header says so).
//  - `pairscreen.mjs` needs the change to fire rarely; a policy change fires
//    on every trick of every deal, so the pairing cancels nothing and its
//    standard error collapses back to the unpaired one.
//  - `match.mjs` / `pscreen.mjs` have a standard error near 0.10 pts/hand.
//
// But the job mcPolicy is doing is well defined: inside a sampled world every
// hand is known, so the policy is trying to approximate double-dummy play, and
// "closer to double dummy" means "beats the other policy at a table where all
// four hands are face up". That is measurable directly, and almost free —
// a clairvoyant play-out costs 52 policy calls and no sampling at all.
//
// Design. Deal the benchmark's own realistic carry-over cycle, settle the
// contract with ONE auction (the same contract for both arms, so the auction's
// cost is paid once and no bid change contaminates a play comparison), then
// play the deal out twice: A at seats 0+2 against B at 1+3, then B at 0+2
// against A at 1+3. The statistic per deal is
//
//     (score of seats 0+2 in run 1  -  score of seats 0+2 in run 2) / 2
//
// which is A-minus-B on the same deal AND on the same seats, so deal luck and
// seat bias both cancel. Redeals and deals where the two runs coincide
// contribute an exact zero.
//
// Caveats, in the spirit of the rest of this directory:
//  - A policy that wins here is a better PLAYER of the clairvoyant game. That
//    is the right target for a rollout (the estimate it produces is meant to
//    approximate the double-dummy value), but it is a proxy, not points: a
//    policy can also win by exploiting the other one's specific mistakes.
//  - The contract is fixed by ONE file's auction, so this measures play only.
//    A policy change also feeds `mcBidRollout` and can move the auction —
//    check that separately with `bidtally.mjs`.
//  - mcPolicy is not in harness.mjs's EXPORTS (nothing else needs it), so this
//    file carries its own loader with a wider export list.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fork } from "child_process";

const dir = path.dirname(fileURLToPath(import.meta.url));
const EXPORTS = [
  "RULES", "makeDeck", "shuffle", "humanShuffle", "deal", "sortHand",
  "troelaSetup", "legalBids", "legalMoves", "trickWinner", "scoreHand",
  "checkEarlyEnd", "callableCards", "contractDef", "aiChooseBid", "mcPolicy",
];
function loadPolicy(p) {
  const raw = fs.readFileSync(p, "utf8");
  const marker = raw.indexOf("==== AI END ====");
  if (marker < 0) throw new Error(p + ": missing '==== AI END ====' marker");
  const src = raw.slice(0, marker).split("\n")
    .filter((l) => !/^\s*import\s/.test(l) && !/^\s*export\s/.test(l)).join("\n");
  const mod = new Function(src + "\nreturn {" + EXPORTS.join(",") + "};")();
  for (const k of EXPORTS)
    if (mod[k] === undefined) throw new Error(p + ": '" + k + "' not defined above the marker");
  return mod;
}

const DEALS = +(process.env.DEALS || 4000);
const SHARDS = +(process.env.SHARDS || 4);
const aPath = process.argv[2] || path.join(dir, "..", "Rikken.jsx");
const bPath = process.argv[3] || path.join(dir, "baseline.jsx");

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The auction, played by one module at all four seats. Returns the winning
// bid or null (redeal). Only used to give the play-out a realistic contract.
function auction(mod, ref, hands, dealer) {
  let high = null, passed = [false, false, false, false];
  let turn = (dealer + 1) % 4, active = 4;
  while (true) {
    if (!passed[turn]) {
      const bid = mod.aiChooseBid(hands[turn], high ? high.key : null);
      const legal = ref.legalBids(high ? high.key : null, hands[turn]);
      if (bid.key === "pass" || !legal.includes(bid.key)) { passed[turn] = true; active--; }
      else high = { ...bid, seat: turn };
    }
    if (active === 0) break;
    if (active === 1 && high && !passed[high.seat]) break;
    turn = (turn + 1) % 4;
  }
  return high;
}

// One face-up play-out. polOf(seat) picks the module whose mcPolicy plays it.
// Deliberately mirrors mcBidRollout's loop, which is the loop a rollout runs.
function playFaceUp(polOf, ref, hands0, dealer, high) {
  const def = ref.contractDef(high.key);
  const hands = hands0.map((h) => h.slice());
  let called = high.called || null, soloTroela = false;
  if (high.key === "troela") {
    const st = ref.troelaSetup(hands, high.seat);
    called = st.called; soloTroela = st.soloTroela;
  }
  const partner = called ? hands.findIndex((h) => h.some((x) => x.id === called.id)) : null;
  let trump = def.trump === "named" ? high.trump : def.trump === "fixed" ? def.fixedTrump : null;
  const c = { key: high.key, declarer: high.seat, trump, called, partner,
    revealed: !def.perTrick, soloTroela };
  const side = partner == null ? [high.seat] : [high.seat, partner];
  const tricks = [0, 0, 0, 0];
  let trick = [], turn = (dealer + 1) % 4, revealed = c.revealed, played = 0;
  while (played < 13) {
    const wc = { key: c.key, called, revealed, trump };
    const card = polOf(turn).mcPolicy(hands, turn, trick, trump, wc, side, c, tricks);
    if (trump == null && high.key === "troela") { trump = card.s; c.trump = card.s; }
    hands[turn] = hands[turn].filter((x) => x.id !== card.id);
    if (called && !revealed && card.id === called.id) revealed = true;
    trick.push({ seat: turn, card });
    if (trick.length === 4) {
      const w = ref.trickWinner(trick, trump);
      tricks[w]++; trick = []; turn = w; played++;
      if (ref.checkEarlyEnd(high.key, side.reduce((n, s) => n + tricks[s], 0), played)) break;
    } else turn = (turn + 1) % 4;
  }
  const res = ref.scoreHand(high.key, high.seat, partner, tricks, soloTroela);
  return res.deltas[0] + res.deltas[2];
}

function runShard(n, seed0) {
  const A = loadPolicy(aPath), B = loadPolicy(bPath);
  const deckRng = mulberry32(seed0 ^ 0x5eed);
  const realRandom = Math.random;
  let rng = mulberry32(seed0);
  Math.random = () => rng();
  const diffs = [];
  let dealer = 0, nextDeck = null, redeals = 0, fired = 0;
  const keys = {};
  for (let h = 0; h < n; h++) {
    const source = nextDeck && nextDeck.length === 52 ? nextDeck : A.makeDeck();
    const hands = A.deal(A.humanShuffle(source, deckRng), dealer).map(A.sortHand);
    rng = mulberry32((seed0 * 1000003 + h) | 0);
    const high = auction(A, A, hands, dealer);
    if (!high) { redeals++; diffs.push(0); nextDeck = hands.flat(); dealer = (dealer + 1) % 4; continue; }
    const s1 = playFaceUp((s) => (s % 2 === 0 ? A : B), A, hands, dealer, high);
    const s2 = playFaceUp((s) => (s % 2 === 0 ? B : A), A, hands, dealer, high);
    diffs.push((s1 - s2) / 2);
    if (s1 !== s2) fired++;
    const t = keys[high.key] = keys[high.key] || [0, 0];
    t[0]++; t[1] += (s1 - s2) / 2;
    // carry the cards over trick by trick, the way the real table does
    const nx = [];
    for (let i = 0; i < 13; i++) for (let s = 0; s < 4; s++) nx.push(hands[s][i]);
    nextDeck = nx;
    dealer = (dealer + 1) % 4;
  }
  Math.random = realRandom;
  return { diffs, redeals, fired, keys };
}

if (process.env.DUEL_WORKER) {
  process.send(runShard(+process.env.DUEL_N, +process.env.DUEL_SEED));
  process.exit(0);
} else {
  const per = Math.floor(DEALS / SHARDS);
  const results = [];
  let done = 0;
  for (let i = 0; i < SHARDS; i++) {
    const w = fork(fileURLToPath(import.meta.url), [aPath, bPath], {
      env: { ...process.env, DUEL_WORKER: "1", DUEL_N: String(per),
        DUEL_SEED: String(20260817 + i * 7919) },
    });
    w.on("message", (m) => results.push(m));
    w.on("exit", () => { if (++done === SHARDS) finish(); });
  }
  function finish() {
    const d = results.flatMap((r) => r.diffs);
    const n = d.length;
    const mean = d.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    const se = sd / Math.sqrt(n);
    const keys = {};
    for (const r of results)
      for (const [k, v] of Object.entries(r.keys)) {
        const e = keys[k] = keys[k] || [0, 0];
        e[0] += v[0]; e[1] += v[1];
      }
    console.log(JSON.stringify({
      a: path.basename(aPath), b: path.basename(bPath), deals: n,
      mean: +mean.toFixed(4), se: +se.toFixed(4),
      mean_minus_1se: +(mean - se).toFixed(4),
      mean_minus_2se: +(mean - 2 * se).toFixed(4),
      sd: +sd.toFixed(3),
      fired: results.reduce((a, r) => a + r.fired, 0),
      redeals: results.reduce((a, r) => a + r.redeals, 0),
    }));
    console.log("by contract: " + JSON.stringify(Object.fromEntries(
      Object.entries(keys).sort((x, y) => y[1][0] - x[1][0])
        .map(([k, v]) => [k, v[0] + " @ " + (v[1] / v[0]).toFixed(3)]))));
  }
}
