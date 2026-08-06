// Where do the bidder's MARGINAL decisions live? Auction-only, candidate in
// all four seats, replaying `mcChooseBid` decision by decision and recording
// the calibrated bid value, the pass value, the distance to the boundary, and
// which constraint (crossover or data floor) actually bound it.
//
//   DEALS=150 SHARDS=4 node ai-bench/marginprobe.mjs [file.jsx]
//
// Why this exists. `MC_BID_CALIB` carries four fitted lines and four floors,
// and re-deriving any of them with `explore.mjs` costs hours — so it is worth
// one minute of auction-only self-play to know which of them the AI is
// actually still ASKING. The answer as of 2026-08-06 is that the rik and
// rik_beter thresholds are nearly inert (97% of the decisions they see end in
// a bid) while a quarter of every rik9plus decision turns on its line, and
// that abondance is rare rather than under-bid. Cost: auction only, no card
// play, ~50 s for 600 deals on four cores.
//
// The output is a per-family table: how many decisions the family saw, how
// many bid, whether the crossover or the data floor did the blocking, the
// spread of decisions by distance to the boundary, and the ev quantiles of
// the bids made and refused. `rescue` counts decisions the top option failed
// but a runner-up from another family would have cleared (the 2026-08-05
// hole), so a session can see at a glance whether it is worth chasing.
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { fork } from "child_process";

const dir = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(dir, "..");
const NAMES = ["RULES", "makeDeck", "shuffle", "humanShuffle", "deal", "sortHand",
  "legalBids", "contractDef", "mcBidOptions", "mcBidEVs", "mcBidValue",
  "mcBidFamily", "MC_BID_CALIB", "suitCards"];
function loadRaw(p) {
  const raw = fs.readFileSync(p, "utf8");
  const marker = raw.indexOf("==== AI END ====");
  const src = raw.slice(0, marker).split("\n")
    .filter((l) => !/^\s*import\s/.test(l) && !/^\s*export\s/.test(l)).join("\n");
  return new Function(src + "\nreturn {" + NAMES.join(",") + "};")();
}
const FILE = process.argv[2] || path.join(REPO, "Rikken.jsx");
const A = loadRaw(FILE);
const DEALS = +(process.env.DEALS || 200);
const SHARDS = +(process.env.SHARDS || 4);

// trick-ordered carry-over (the 2026-08-05 fix), so the population matches the table
function trickOrder(hands) {
  const h = hands.map((x) => x.slice());
  const out = [];
  for (let t = 0; t < 13; t++) {
    const from = h.findIndex((x) => x.length);
    if (from < 0) break;
    const start = Math.floor(Math.random() * 4);
    const ledSeat = h[start].length ? start : from;
    const led = h[ledSeat][Math.floor(Math.random() * h[ledSeat].length)];
    out.push(led);
    h[ledSeat] = h[ledSeat].filter((c) => c.id !== led.id);
    for (let k = 1; k < 4; k++) {
      const s = (ledSeat + k) % 4;
      if (!h[s].length) continue;
      const follow = h[s].filter((c) => c.s === led.s);
      const from2 = follow.length ? follow : h[s];
      const pick = from2[Math.floor(Math.random() * from2.length)];
      out.push(pick);
      h[s] = h[s].filter((c) => c.id !== pick.id);
    }
  }
  return out;
}

const rows = [];
// A copy of mcChooseBid that records what it saw.
function chooseBid(hand, highKey) {
  const legal = A.legalBids(highKey, hand);
  const options = A.mcBidOptions(hand, legal);
  if (!options.length) return null;
  const { evs, alive } = A.mcBidEVs(hand, options, Math.random);
  let best = alive[0];
  for (const i of alive)
    if (A.mcBidValue(options[i].key, evs[i]) > A.mcBidValue(options[best].key, evs[best])) best = i;
  const fam = A.mcBidFamily(options[best].key);
  const f = A.MC_BID_CALIB[fam];
  let ev = evs[best];
  if (Math.min(Math.abs(f.a + f.b * ev - (f.c + f.d * ev)), Math.abs(ev - f.floor)) < 0.6)
    ev = (ev + A.mcBidEVs(hand, [options[best]], Math.random).evs[0]) / 2;
  const bidV = f.a + f.b * ev, passV = f.c + f.d * ev;
  const crossOk = bidV > passV, floorOk = ev >= f.floor;
  // runners-up: best option of every OTHER family, and whether it would clear
  const others = {};
  for (const i of alive) {
    const fm = A.mcBidFamily(options[i].key);
    if (fm === fam) continue;
    const g = A.MC_BID_CALIB[fm];
    const v = g.a + g.b * evs[i];
    if (!others[fm] || v > others[fm].v)
      others[fm] = { v, ok: v > g.c + g.d * evs[i] && evs[i] >= g.floor };
  }
  rows.push({ fam, key: options[best].key, ev: +ev.toFixed(3), bidV: +bidV.toFixed(3),
    passV: +passV.toFixed(3), margin: +(bidV - passV).toFixed(3),
    floorGap: +(ev - f.floor).toFixed(3), crossOk, floorOk, nOpt: options.length,
    rescue: !(crossOk && floorOk) && Object.values(others).some((o) => o.ok) });
  return crossOk && floorOk ? options[best] : null;
}

function auction(hands, dealer) {
  let high = null, passed = [false, false, false, false], turn = (dealer + 1) % 4, active = 4;
  while (true) {
    if (!passed[turn]) {
      const bid = chooseBid(hands[turn], high ? high.key : null);
      if (!bid) { passed[turn] = true; active--; }
      else high = { ...bid, seat: turn };
    }
    if (active === 0) break;
    if (active === 1 && high && !passed[high.seat]) break;
    turn = (turn + 1) % 4;
  }
  return high ? high.key : "redeal";
}

if (process.env.MP_WORKER) {
  let next = null;
  const tally = {};
  for (let d = 0; d < DEALS; d++) {
    const source = next && next.length === 52 ? next : A.makeDeck();
    const hands = A.deal(A.humanShuffle(source), d % 4).map(A.sortHand);
    next = trickOrder(hands);
    const k = auction(hands, d % 4);
    tally[k] = (tally[k] || 0) + 1;
  }
  process.send({ rows, tally });
  process.exit(0);
} else {
  const all = [], tally = {};
  let done = 0;
  for (let i = 0; i < SHARDS; i++) {
    const w = fork(fileURLToPath(import.meta.url), [FILE],
      { env: { ...process.env, MP_WORKER: "1" } });
    w.on("message", (m) => { all.push(...m.rows); for (const [k, v] of Object.entries(m.tally)) tally[k] = (tally[k] || 0) + v; });
    w.on("exit", () => { if (++done === SHARDS) finish(all, tally); });
  }
}

function finish(rows, tally) {
  console.log("decisions with an option set: " + rows.length + "   contracts: " + JSON.stringify(tally));
  const fams = [...new Set(rows.map((r) => r.fam))];
  for (const fam of fams) {
    const R = rows.filter((r) => r.fam === fam);
    const bid = R.filter((r) => r.crossOk && r.floorOk);
    const blockedFloor = R.filter((r) => r.crossOk && !r.floorOk);
    const blockedCross = R.filter((r) => !r.crossOk);
    console.log("\n== " + fam + "  n=" + R.length + "  bid " + bid.length +
      " (" + (100 * bid.length / R.length).toFixed(1) + "%)  blocked-by-floor " +
      blockedFloor.length + "  blocked-by-crossover " + blockedCross.length);
    // how thin is the decision?
    const near = (r) => Math.min(Math.abs(r.margin), Math.abs(r.floorGap));
    for (const [lo, hi] of [[0, 0.25], [0.25, 0.5], [0.5, 1], [1, 2], [2, 1e9]]) {
      const v = R.filter((r) => near(r) >= lo && near(r) < hi);
      if (v.length) console.log("   |dist to boundary| [" + lo + "," + hi + "): n " + v.length +
        "  bid " + v.filter((r) => r.crossOk && r.floorOk).length);
    }
    // EV distribution of the bids we DO make, vs the crossover
    const evs = bid.map((r) => r.ev).sort((a, b) => a - b);
    if (evs.length) {
      const q = (p) => evs[Math.min(evs.length - 1, Math.floor(p * evs.length))];
      console.log("   bid ev quantiles: p05 " + q(0.05).toFixed(2) + "  p25 " + q(0.25).toFixed(2) +
        "  p50 " + q(0.5).toFixed(2) + "  p75 " + q(0.75).toFixed(2) + "  p95 " + q(0.95).toFixed(2));
    }
    const bevs = R.filter((r) => !(r.crossOk && r.floorOk)).map((r) => r.ev).sort((a, b) => a - b);
    if (bevs.length) {
      const q = (p) => bevs[Math.min(bevs.length - 1, Math.floor(p * bevs.length))];
      console.log("   passed ev quantiles: p50 " + q(0.5).toFixed(2) + "  p75 " + q(0.75).toFixed(2) +
        "  p95 " + q(0.95).toFixed(2) + "  max " + bevs[bevs.length - 1].toFixed(2));
    }
    console.log("   rescuable by a runner-up from another family: " + R.filter((r) => r.rescue).length);
  }
}
