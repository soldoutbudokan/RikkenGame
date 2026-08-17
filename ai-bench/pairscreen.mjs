// Paired-deal screener: the SAME deals, the SAME seeded AI randomness, two
// nearly-identical candidates — so every hand the change does not touch
// cancels to exactly zero and the only noise left is the hands it does.
//
//   HANDS=4000 SHARDS=4 node ai-bench/pairscreen.mjs A.jsx B.jsx
//
// Both arms sit at seats 0+2 against ./baseline.jsx at seats 1+3, exactly as
// `match.mjs` and `pscreen.mjs` do, and the statistic is the per-deal
// difference of the A-pair's score:
//
//     mean over deals of  ( score(A vs baseline) - score(B vs baseline) )
//
// which is on the same scale as `match.mjs`'s mean — points per hand — but
// measures the INCREMENT from A over B rather than either one's margin.
//
// Why this exists. Every entry in this README since 2026-07-19 runs into the
// same wall: a 2500-hand `match.mjs` has a standard error of ~0.126 pts/hand
// and almost every real improvement left in this AI is worth 0.02-0.08, so
// the screen is a coin flip and the keep rule discards verified work (see the
// 2026-07-31 and 2026-08-02 entries, both of which reverted changes that were
// 5-9 s.e. upstream). The variance is not in the change, it is in the DEAL —
// a hand where nothing the change touches ever happens still swings +/-6
// points, and an unpaired screen has to average that away.
//
// So pair on the deal and make the two arms bit-identical wherever the change
// does not fire. Two mechanisms do that:
//
//  1. The deal is generated once (arm A's table drives the realistic
//     carry-over shuffle, exactly as `playMatch` does) and both arms play it.
//  2. `Math.random` is replaced by a seeded generator that is RESET to the
//     same value at the start of each arm's play of each deal. Two files with
//     identical code paths then consume the identical random stream and score
//     identically, to the last point — a hand where the change never fires
//     contributes an exact 0 to the difference, not noise.
//
// The residual sd is therefore sqrt(fireRate) x (sd on a fired hand) instead
// of the full 6.3 pts/hand, which for a gate firing on ~1% of deals is a 5-10x
// reduction in standard error for the same wall clock. `fired` in the output
// is the count of deals where the two arms diverged at all: if it is 0 the
// files are behaviourally identical, and if it is close to the deal count the
// pairing bought nothing and you should be using `pscreen.mjs`.
//
// Caveats, in the spirit of the rest of this directory:
//  - This is NOT the gate. `match.mjs` is. It measures a DIFFERENCE between
//    two candidates, not either one's margin over the frozen baseline.
//  - The deal sequence is generated under arm A's play, so it is "A-flavoured"
//    after the first divergence. Both arms see the same deals, so the paired
//    difference stays unbiased; only the population the difference is averaged
//    over is (very slightly) A's.
//  - Seeding Math.random means neither arm sees the production RNG. That is
//    the point, but it also means a change whose value depends on unseeded
//    randomness cannot be measured here.
//  - Redeals score 0 for both arms and stay in the denominator (they are ~0.6%
//    of deals and move no money); `match.mjs` drops them instead, so this
//    mean is diluted by that fraction relative to a screen.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fork } from "child_process";
import { loadAI } from "./harness.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const HANDS = +(process.env.HANDS || 4000);
const SHARDS = +(process.env.SHARDS || 4);
const aPath = process.argv[2] || path.join(dir, "..", "Rikken.jsx");
const bPath = process.argv[3] || path.join(dir, "baseline.jsx");
const basePath = path.join(dir, "baseline.jsx");

// mulberry32 — small, fast, and it is the AI's whole source of randomness
// while this runs.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One hand of the benchmark table, played by `pair` at seats 0+2 and `base`
// at 1+3 from an already-dealt deal. Returns the 0+2 score and the deck the
// table would carry into the next hand. A deliberate copy of playMatch's hand
// loop rather than a call into it: this needs to replay one fixed deal, and
// harness.mjs must stay the thing every other instrument in here agrees on.
function playDeal(pair, base, ref, hands0, dealer) {
  const modOf = (seat) => (seat % 2 === 0 ? pair : base);
  const hands = hands0.map((h) => h.slice());
  let high = null, passed = [false, false, false, false];
  let turn = (dealer + 1) % 4, active = 4, violations = 0;
  while (true) {
    if (!passed[turn]) {
      const bid = modOf(turn).aiChooseBid(hands[turn], high ? high.key : null);
      const legal = ref.legalBids(high ? high.key : null, hands[turn]);
      if (bid.key === "pass") { passed[turn] = true; active--; }
      else if (legal.includes(bid.key)) high = { ...bid, seat: turn };
      else { violations++; passed[turn] = true; active--; }
    }
    if (active === 0) break;
    if (active === 1 && high && !passed[high.seat]) break;
    turn = (turn + 1) % 4;
  }
  if (!high) return { delta: 0, redeal: true, violations, next: hands.flat() };

  const def = ref.contractDef(high.key);
  let contract = { key: high.key, declarer: high.seat, trump: high.trump || null,
    called: high.called || null, partner: null, revealed: !def.perTrick, soloTroela: false };
  if (high.key === "troela") {
    contract = { ...contract, ...ref.troelaSetup(hands, high.seat) };
    contract.revealed = contract.soloTroela;
    contract.trump = null;
  } else if (def.trump === "fixed") contract.trump = def.fixedTrump;
  if (def.perTrick && high.key !== "troela") {
    contract.partner = hands.findIndex((hh) => hh.some((c) => c.id === contract.called.id));
    contract.revealed = false;
  }

  const game = { hands: hands.map((x) => x.slice()), trick: [], trump: contract.trump,
    contract, playedIds: new Set(), aiSkill: "hardest", tricksBySeat: [0, 0, 0, 0],
    voids: [{}, {}, {}, {}], playedCount: [{}, {}, {}, {}], openHand: null };
  const wonTricks = [];
  let leader = (dealer + 1) % 4, played = 0, early = null;
  while (played < 13 && !early) {
    game.trick = [];
    for (let k = 0; k < 4; k++) {
      const seat = (leader + k) % 4;
      const legal = ref.legalMoves(game.hands[seat], game.trick, game.trump, game.contract);
      let card = modOf(seat).aiChooseCard(seat, game);
      if (!card || !legal.some((c) => c.id === card.id)) { violations++; card = legal[0]; }
      if (game.trick.length && card.s !== game.trick[0].card.s)
        game.voids[seat][game.trick[0].card.s] = true;
      game.playedCount[seat][card.s] = (game.playedCount[seat][card.s] || 0) + 1;
      game.hands[seat] = game.hands[seat].filter((c) => c.id !== card.id);
      game.trick.push({ seat, card });
      game.playedIds.add(card.id);
      if (played === 0 && k === 0 && contract.key === "troela") {
        game.trump = card.s;
        game.contract = { ...game.contract, trump: card.s };
      }
      if (contract.called && card.id === contract.called.id && !game.contract.revealed)
        game.contract = { ...game.contract, revealed: true };
      if (def.openAfterTrick1 && played >= 1) game.openHand = contract.declarer;
    }
    leader = ref.trickWinner(game.trick, game.trump);
    game.tricksBySeat[leader]++;
    wonTricks.push(game.trick.map((p) => p.card));
    played++;
    const side = contract.partner == null ? [contract.declarer] : [contract.declarer, contract.partner];
    early = ref.checkEarlyEnd(contract.key,
      side.reduce((n, s) => n + game.tricksBySeat[s], 0), played);
  }
  const res = ref.scoreHand(contract.key, contract.declarer, contract.partner,
    game.tricksBySeat, !!contract.soloTroela);
  return { delta: res.deltas[0] + res.deltas[2], redeal: false, violations,
    next: [...wonTricks.flat(), ...game.hands.flat()], key: contract.key,
    declDelta: res.deltas[contract.declarer] };
}

function runShard(n, seed0) {
  const A = loadAI(aPath), B = loadAI(bPath), base = loadAI(basePath);
  const deckRng = mulberry32(seed0 ^ 0x5eed);
  const realRandom = Math.random;
  let rng = mulberry32(seed0);
  Math.random = () => rng();
  const diffs = [];
  const keysA = {}, keysB = {};
  let dealer = 0, nextDeck = null, fired = 0, redeals = 0, violations = 0;
  for (let h = 0; h < n; h++) {
    const source = nextDeck && nextDeck.length === 52 ? nextDeck : A.makeDeck();
    const hands = A.deal(A.humanShuffle(source, deckRng), dealer).map(A.sortHand);
    const seed = (seed0 * 1000003 + h) | 0;
    rng = mulberry32(seed);
    const ra = playDeal(A, base, A, hands, dealer);
    rng = mulberry32(seed);
    const rb = playDeal(B, base, A, hands, dealer);
    diffs.push(ra.delta - rb.delta);
    if (ra.delta !== rb.delta || ra.key !== rb.key) fired++;
    if (ra.redeal) redeals++;
    violations += ra.violations + rb.violations;
    // Free diagnostic: what the declarer actually earns, by contract. A family
    // that is systematically negative is a family whose bid floor is too low —
    // this is the misère-gate question of 2026-08-02 asked of every contract.
    if (ra.key) { const t = keysA[ra.key] = keysA[ra.key] || [0, 0]; t[0]++; t[1] += ra.declDelta; }
    if (rb.key) { const t = keysB[rb.key] = keysB[rb.key] || [0, 0]; t[0]++; t[1] += rb.declDelta; }
    nextDeck = ra.next;
    dealer = (dealer + 1) % 4;
  }
  Math.random = realRandom;
  return { diffs, fired, redeals, violations, keysA, keysB };
}

if (process.env.PAIR_WORKER) {
  const r = runShard(+process.env.PAIR_N, +process.env.PAIR_SEED);
  process.send(r);
  process.exit(0);
} else {
  const per = Math.floor(HANDS / SHARDS);
  const results = [];
  let done = 0;
  for (let i = 0; i < SHARDS; i++) {
    const w = fork(fileURLToPath(import.meta.url), [aPath, bPath], {
      env: { ...process.env, PAIR_WORKER: "1", PAIR_N: String(per),
        PAIR_SEED: String(+(process.env.SEED0 || 1234567) + i * 7919) },
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
    const fired = results.reduce((a, r) => a + r.fired, 0);
    const fd = d.filter((x) => x !== 0);
    const fm = fd.length ? fd.reduce((a, b) => a + b, 0) / fd.length : 0;
    const keys = (which) => {
      const t = {};
      for (const r of results)
        for (const [k, v] of Object.entries(r[which])) {
          const e = t[k] = t[k] || [0, 0];
          e[0] += v[0]; e[1] += v[1];
        }
      return Object.fromEntries(Object.entries(t)
        .sort((x, y) => y[1][0] - x[1][0])
        .map(([k, v]) => [k, v[0] + " @ " + (v[1] / v[0]).toFixed(2)]));
    };
    console.log(JSON.stringify({
      a: path.basename(aPath), b: path.basename(bPath), deals: n,
      mean: +mean.toFixed(4), se: +se.toFixed(4),
      mean_minus_1se: +(mean - se).toFixed(4),
      mean_minus_2se: +(mean - 2 * se).toFixed(4),
      sd: +sd.toFixed(3), fired, firedRate: +(fired / n).toFixed(4),
      nonzero: fd.length, meanOnNonzero: +fm.toFixed(2),
      redeals: results.reduce((a, r) => a + r.redeals, 0),
      violations: results.reduce((a, r) => a + r.violations, 0),
    }));
    console.log("contracts A: " + JSON.stringify(keys("keysA")));
    console.log("contracts B: " + JSON.stringify(keys("keysB")));
  }
}
