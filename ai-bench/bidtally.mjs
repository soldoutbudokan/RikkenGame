// Auction-ecology check: does a change move WHICH contracts get bid?
// Runs the auction only (no card play) over the same deals for two AI files
// and prints each one's contract tally.
//
//   DEALS=800 node ai-bench/bidtally.mjs [candidatePath] [otherPath]
//
// Cheap next to match.mjs — the point is to know whether MC_BID_CALIB still
// describes the population of bids the AI actually makes.
import { fileURLToPath } from "url";
import path from "path";
import { loadAI } from "./harness.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const aPath = process.argv[2] || path.join(dir, "..", "Rikken.jsx");
const bPath = process.argv[3] || path.join(dir, "baseline.jsx");
const DEALS = +(process.env.DEALS || 800);
const A = loadAI(aPath), B = loadAI(bPath);

// deterministic deals, shared by both arms
let seed = +(process.env.SEED || 12345) >>> 0;
const rng = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

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
  return high ? high.key : "redeal";
}

const tally = { a: {}, b: {} };
let nextDeck = null;
for (let d = 0; d < DEALS; d++) {
  const source = nextDeck && nextDeck.length === 52 ? nextDeck : A.makeDeck();
  const deck = A.humanShuffle(source, rng);
  const hands = A.deal(deck, d % 4).map(A.sortHand);
  const ka = auction(A, hands, d % 4), kb = auction(B, hands, d % 4);
  tally.a[ka] = (tally.a[ka] || 0) + 1;
  tally.b[kb] = (tally.b[kb] || 0) + 1;
  nextDeck = hands.flat();
}
const keys = [...new Set([...Object.keys(tally.a), ...Object.keys(tally.b)])].sort();
console.log("deals: " + DEALS);
console.log("contract".padEnd(14) + "A".padStart(6) + "B".padStart(6) + "  diff");
for (const k of keys)
  console.log(k.padEnd(14) + String(tally.a[k] || 0).padStart(6) +
    String(tally.b[k] || 0).padStart(6) + "  " +
    ((tally.a[k] || 0) - (tally.b[k] || 0)));
const decl = (t) => DEALS - (t.redeal || 0);
console.log("declared: A " + decl(tally.a) + "  B " + decl(tally.b));
