// Is mcSampleWorld's `aceCap` still true? The sampler encodes "nobody who
// passed on a rik or rik beter was sitting on three aces" as a HARD constraint
// on ~53% of contracts, which was a sound deduction while every three-ace hand
// bid troela. Since 2026-08-14 a flat three-ace hand passes, so the deduction
// is an approximation — and 2026-08-14 estimated the damage at ~2.9% of deals
// without measuring it.
//
//   DEALS=1200 node ai-bench/acepop.mjs [candidatePath]
//
// Deal, run the auction only (no card play, so this is minutes not hours), and
// for every rik / rik beter contract ask whether a NON-DECLARER really held
// three aces — and if so whether that hand was FLAT (no five-card suit, no
// four-card A K Q), the shape that passes whatever was standing. The number to
// read it against is `baseRateAnyTrio`: the unconditional rate at which some
// one of three hands holds three of the four aces. If the two agree, the pass
// proves nothing and the cap is not a deduction at all.
//
// Cards are carried over trick by trick (one card per seat), not as
// `hands.flat()` — the clumping bug the 2026-08-05 entry found in gateprobe.
import { fileURLToPath } from "url";
import path from "path";
import { loadAI } from "./harness.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const A = loadAI(process.argv[2] || path.join(dir, "..", "Rikken.jsx"));
const DEALS = +(process.env.DEALS || 1200);
let seed = +(process.env.SEED || 987654321) >>> 0;
const rng = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const SUITS = ["S", "H", "C", "D"];

function auction(mod, hands, dealer) {
  let high = null, passed = [false, false, false, false];
  let turn = (dealer + 1) % 4, active = 4;
  while (true) {
    if (!passed[turn]) {
      const bid = mod.aiChooseBid(hands[turn], high ? high.key : null);
      const legal = A.legalBids(high ? high.key : null, hands[turn]);
      if (bid.key === "pass" || !legal.includes(bid.key)) { passed[turn] = true; active--; }
      else high = { ...bid, seat: turn };
    }
    if (active === 0) break;
    if (active === 1 && high && !passed[high.seat]) break;
    turn = (turn + 1) % 4;
  }
  return high;
}
// mcBidOptions offers a trump contract to exactly these shapes, so a hand with
// none of them has only troela on the table — and a one-option list is a pass.
const flat = (h) => SUITS.every((s) => {
  const c = h.filter((x) => x.s === s);
  return c.length < 5 && !(c.length === 4 && c.filter((x) => x.r >= 12).length >= 3);
});

let contracts = 0, capFam = 0, bad = 0, badFlat = 0, badSeats = 0, tally = {};
let baseDeals = 0, baseHit = 0;
let nextDeck = null;
for (let d = 0; d < DEALS; d++) {
  const source = nextDeck && nextDeck.length === 52 ? nextDeck : A.makeDeck();
  const hands = A.deal(A.humanShuffle(source, rng), d % 4).map(A.sortHand);
  const high = auction(A, hands, d % 4);
  const nx = [];
  for (let i = 0; i < 13; i++) for (let s = 0; s < 4; s++) nx.push(hands[s][i]);
  nextDeck = nx;
  // unconditional base rate: some one of three hands (the way three unknown
  // seats look to the sampler) holding three of the four aces
  baseDeals++;
  if ([0, 1, 2].some((p) => hands[p].filter((c) => c.r === 14).length >= 3)) baseHit++;
  if (!high) continue;
  contracts++;
  tally[high.key] = (tally[high.key] || 0) + 1;
  if (!(high.key === "rik" || high.key === "rik_beter")) continue;
  capFam++;
  let hit = false, hitFlat = false;
  for (let p = 0; p < 4; p++) {
    if (p === high.seat) continue;
    if (hands[p].filter((c) => c.r === 14).length >= 3) {
      hit = true; badSeats++;
      if (flat(hands[p])) hitFlat = true;
    }
  }
  if (hit) { bad++; if (hitFlat) badFlat++; }
}
console.log(JSON.stringify({
  deals: DEALS, contracts, capFamily: capFam,
  nonDeclarerHasThreeAces: bad,
  rateOfCapFamily: +(bad / Math.max(1, capFam)).toFixed(4),
  rateOfAllDeals: +(bad / DEALS).toFixed(4),
  ofThoseFlat: badFlat, seats: badSeats,
  baseRateAnyTrio: +(baseHit / Math.max(1, baseDeals)).toFixed(4), tally,
}));
