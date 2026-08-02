// Gate probe: what do the DETERMINISTIC bid gates in aiChooseBid actually earn?
//
//   N=200000 PLAY=280 KEY=misere WHICH=lowHand WORLDS=60 node ai-bench/gateprobe.mjs [file.jsx]
//
// Why this exists. `aiChooseBid` opens with hand-shape rules that return a
// contract before `mcBidOptions` is ever built — the misère, open-misère and
// piek gates. Every other instrument in this directory is blind to them by
// construction: `explore.mjs` lists them in DETERMINISTIC and returns the gate
// unpriced, `bidprobe.mjs` and `bidtruth.mjs` drive through `mcBidEVs`, and
// `insights.mjs` reports card play. A screen sees them on ~1% of hands, which
// is far inside its noise. The 2026-08-01 session made the same point about
// the three-ace troela reflex and generalised it: *a deterministic shortcut
// placed upstream of an estimator is invisible to every probe that drives
// through the estimator.* This is the probe that is not.
//
// How. Dealing is nearly free next to playing, so deal the way the table deals
// (realistic shuffle with carry-over), keep only the hands a named gate fires
// on, and play THAT contract out with the real `hardest` AI in all four seats.
// The declarer's score is the answer — no auction, no reference search, no
// calibration. Cost is one played hand per gate hit, and misère-family hands
// end early the moment the declarer wins a trick, so they are cheap ones.
//
// With WORLDS set it also rolls each gate hand out through `mcBidRollout` and
// reports realized points binned by that EV, plus what a "bid only above a
// threshold" rule would have earned. That is how a gate becomes a floor.
//
// WHICH selects the population: lowHand (the misère gate), piek (the piek
// gate), jackHigh / queenHigh (hands just OUTSIDE the misère gate, for asking
// whether it is too narrow rather than too wide). KEY is the contract to play,
// and is independent of WHICH on purpose.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const dir = path.dirname(fileURLToPath(import.meta.url));
// harness.mjs exports only the benchmark surface; this needs mcBidRollout too.
const NAMES = ["RULES", "makeDeck", "shuffle", "humanShuffle", "deal", "sortHand",
  "legalMoves", "trickWinner", "scoreHand", "checkEarlyEnd", "contractDef",
  "aiChooseCard", "mcBidRollout"];
function loadRaw(p) {
  const raw = fs.readFileSync(p, "utf8");
  const marker = raw.indexOf("==== AI END ====");
  if (marker < 0) throw new Error(p + ": missing AI END marker");
  const src = raw.slice(0, marker).split("\n")
    .filter((l) => !/^\s*import\s/.test(l) && !/^\s*export\s/.test(l)).join("\n");
  return new Function(src + "\nreturn {" + NAMES.join(",") + "};")();
}
const A = loadRaw(process.argv[2] || path.join(dir, "..", "Rikken.jsx"));
const N = +(process.env.N || 200000);
const PLAY = +(process.env.PLAY || 150);
const KEY = process.env.KEY || "misere";
const WORLDS = +(process.env.WORLDS || 0);
const WHICH = (process.env.WHICH || "lowHand").split(",");
const SUITS = ["S", "H", "C", "D"];
const RANKS = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
const sc = (h, s) => h.filter((c) => c.s === s);

// The gate predicates, mirroring aiChooseBid. jackHigh / queenHigh are the
// near-misses: same shape rule, one rank band higher.
function gate(hand) {
  const shapeOk = SUITS.every((s) => {
    const cs = sc(hand, s);
    return cs.length < 4 || cs.some((c) => c.r <= 4);
  });
  const lowHand = hand.every((c) => c.r <= 10) && shapeOk;
  const highs = hand.filter((c) => c.r >= 13);
  return {
    lowHand,
    veryLow: lowHand && hand.every((c) => c.r <= 8),
    jackHigh: hand.every((c) => c.r <= 11) && !lowHand && shapeOk,
    queenHigh: hand.every((c) => c.r <= 12) && !hand.every((c) => c.r <= 11) && shapeOk,
    piek: highs.length === 1 && hand.filter((c) => c.r >= 11).length === 1 &&
      hand.every((c) => c.id === highs[0].id || c.r <= 9),
  };
}

// Play `key`, declared by `declarer`, out with the real AI in every seat.
function playContract(hands0, key, declarer, leader) {
  const def = A.contractDef(key);
  const contract = { key, declarer, trump: def.trump === "fixed" ? def.fixedTrump : null,
    called: null, partner: null, revealed: true, soloTroela: false };
  const game = { hands: hands0.map((x) => x.slice()), trick: [], trump: contract.trump,
    contract, playedIds: new Set(), aiSkill: "hardest", tricksBySeat: [0, 0, 0, 0],
    voids: [{}, {}, {}, {}], playedCount: [{}, {}, {}, {}], openHand: null };
  let played = 0, early = null, lead = leader, violations = 0;
  while (played < 13 && !early) {
    game.trick = [];
    for (let k = 0; k < 4; k++) {
      const seat = (lead + k) % 4;
      const legal = A.legalMoves(game.hands[seat], game.trick, game.trump, game.contract);
      let card = A.aiChooseCard(seat, game);
      if (!card || !legal.some((c) => c.id === card.id)) { violations++; card = legal[0]; }
      if (game.trick.length && card.s !== game.trick[0].card.s)
        game.voids[seat][game.trick[0].card.s] = true;
      game.playedCount[seat][card.s] = (game.playedCount[seat][card.s] || 0) + 1;
      game.hands[seat] = game.hands[seat].filter((c) => c.id !== card.id);
      game.trick.push({ seat, card });
      game.playedIds.add(card.id);
      if (def.openAfterTrick1 && played >= 1) game.openHand = declarer;
    }
    lead = A.trickWinner(game.trick, game.trump);
    game.tricksBySeat[lead]++;
    played++;
    early = A.checkEarlyEnd(key, game.tricksBySeat[declarer], played);
  }
  const res = A.scoreHand(key, declarer, null, game.tricksBySeat, false);
  return { delta: res.deltas[declarer], made: res.made, violations };
}

// Mean rollout score for `key` on this hand, unseen 39 cards dealt uniformly —
// the same world construction mcBidEVs uses.
function rollEV(hand, key, n) {
  const seen = new Set(hand.map((c) => c.id));
  const pool = [];
  for (const s of SUITS) for (const r of RANKS) if (!seen.has(s + r)) pool.push({ s, r, id: s + r });
  let tot = 0;
  for (let k = 0; k < n; k++) {
    const p = A.shuffle(pool, Math.random);
    tot += A.mcBidRollout(hand, { others: [p.slice(0, 13), p.slice(13, 26), p.slice(26, 39)],
      leader: Math.floor(Math.random() * 4) }, { key });
  }
  return tot / n;
}

const buckets = {}, rows = [];
let dealer = 0, next = null, dealt = 0, plays = 0;
while (dealt < N && plays < PLAY) {
  const source = next && next.length === 52 ? next : A.makeDeck();
  const hands = A.deal(A.humanShuffle(source), dealer).map(A.sortHand);
  next = hands.flat();
  const leader = (dealer + 1) % 4;
  dealer = (dealer + 1) % 4;
  for (let seat = 0; seat < 4; seat++) {
    dealt++;
    const g = gate(hands[seat]);
    for (const w of WHICH) {
      if (!g[w]) continue;
      const r = playContract(hands, KEY, seat, leader);
      const B = (buckets[w] = buckets[w] || { n: 0, sum: 0, sq: 0, made: 0, viol: 0 });
      B.n++; B.sum += r.delta; B.sq += r.delta * r.delta;
      if (r.made) B.made++;
      B.viol += r.violations;
      if (WORLDS) rows.push({ w, ev: rollEV(hands[seat], KEY, WORLDS), delta: r.delta, made: r.made });
      plays++;
    }
  }
}

console.log(JSON.stringify({ key: KEY, which: WHICH, handsDealt: dealt, plays, worlds: WORLDS }));
for (const [k, B] of Object.entries(buckets)) {
  const mean = B.sum / B.n, sd = Math.sqrt(Math.max(0, B.sq / B.n - mean * mean));
  console.log(k.padEnd(10) + " n " + String(B.n).padStart(4) +
    "  declarer pts " + mean.toFixed(2) + " +/- " + (sd / Math.sqrt(B.n)).toFixed(2) +
    "  made " + (100 * B.made / B.n).toFixed(1) + "%" +
    (B.viol ? "  VIOLATIONS " + B.viol : ""));
}
if (rows.length) {
  const bins = {};
  for (const r of rows) {
    const k = Math.round(r.ev / 2.5) * 2.5;
    (bins[k] = bins[k] || []).push(r);
  }
  console.log("-- realized declarer points by rollout EV bin --");
  for (const k of Object.keys(bins).map(Number).sort((a, b) => a - b)) {
    const v = bins[k];
    console.log("  ev~" + String(k).padStart(6) + "  n " + String(v.length).padStart(4) +
      "  pts " + (v.reduce((a, c) => a + c.delta, 0) / v.length).toFixed(2) +
      "  made " + (100 * v.filter((x) => x.made).length / v.length).toFixed(0) + "%");
  }
  console.log("-- what a floor on that EV would have earned --");
  const byEv = rows.slice().sort((a, b) => b.ev - a.ev);
  for (const frac of [0.1, 0.2, 0.3, 0.4, 0.5, 0.75, 1]) {
    const k = Math.max(1, Math.round(frac * byEv.length));
    const v = byEv.slice(0, k);
    const m = v.reduce((a, c) => a + c.delta, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, c) => a + (c.delta - m) ** 2, 0) / v.length);
    console.log("  keep top " + String(Math.round(100 * frac)).padStart(3) + "% (ev >= " +
      v[v.length - 1].ev.toFixed(2).padStart(6) + ")  n " + String(k).padStart(4) +
      "  pts " + m.toFixed(2) + " +/- " + (sd / Math.sqrt(k)).toFixed(2) +
      "  made " + (100 * v.filter((x) => x.made).length / v.length).toFixed(0) + "%");
  }
}
