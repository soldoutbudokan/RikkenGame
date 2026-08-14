// What does a PASS actually prove? For each standing high bid, how often does
// the AI bid when it holds the shape a cap would forbid.
//
//   DEALS=400 SHARDS=4 node ai-bench/bidrate.mjs [file.jsx]
//
// The sampler's auction cap (mcSampleWorld's `lenCap`) is only as good as the
// bid rate behind it: "no non-declarer held a seven-card suit" is a lie in
// exactly the fraction of the time a seat holding one passes anyway. The
// 2026-08-13 cap was justified with rates borrowed from `marginprobe` (rik
// 97.1%, rik9plus 75%), which are the rates for the family's WHOLE population
// rather than for the gate shape at a given standing bid — and the extension
// to rik 9+ contracts needs the rate at rik9/rik10/rik11 standing, which no
// instrument reports. This measures it directly: deal, find seat-hands
// matching each cap shape, and ask `aiChooseBid` with each standing bid.
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { fork } from "child_process";
import { loadAI } from "./harness.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(dir, "..");
const FILE = process.argv[2] || path.join(REPO, "Rikken.jsx");
const DEALS = +(process.env.DEALS || 200);
const SHARDS = +(process.env.SHARDS || 4);

const STANDING = [null, "rik", "rik_beter", "troela", "rik9", "rik10", "rik11"];
// shapes a cap would forbid
const SHAPES = {
  // rik9+ overcall gate: 7 cards, or 6 with two of A/K/Q
  over: (hand, S, suitCards) => {
    const cs = suitCards(hand, S);
    return cs.length >= 7 || (cs.length >= 6 && cs.filter((c) => c.r >= 12).length >= 2);
  },
  // trump gate (rik / rik beter), HEARTS only: 5 cards, or 4 with A K Q
  hearts: (hand, S, suitCards) => {
    if (S !== "H") return false;
    const cs = suitCards(hand, S);
    return cs.length >= 5 || (cs.length >= 4 && cs.filter((c) => c.r >= 12).length >= 3);
  },
};

function runShard(n, seed) {
  const A = loadAI(FILE);
  const { RULES, makeDeck, humanShuffle, shuffle, deal, sortHand, legalBids, aiChooseBid } = A;
  const suitCards = (hand, s) => hand.filter((c) => c.s === s);
  const SUITS = ["S", "H", "C", "D"];
  const tally = {};
  for (const key of Object.keys(SHAPES))
    for (const st of STANDING) tally[key + "|" + st] = { n: 0, bid: 0, self: 0 };
  let nextDeck = null;
  for (let d = 0; d < n; d++) {
    const realistic = RULES.shuffle.mode === "realistic";
    const source = realistic && nextDeck && nextDeck.length === 52 ? nextDeck : makeDeck();
    const deck = realistic ? humanShuffle(source) : shuffle(makeDeck());
    const hands = deal(deck, 0).map(sortHand);
    nextDeck = deck;
    for (const hand of hands) {
      for (const key of Object.keys(SHAPES)) {
        const hit = SUITS.some((S) => SHAPES[key](hand, S, suitCards));
        if (!hit) continue;
        for (const st of STANDING) {
          const legal = legalBids(st, hand);
          // only ask where an overcall of some kind is still available
          if (legal.filter((k) => k !== "pass").length === 0) continue;
          const t = tally[key + "|" + st];
          t.n++;
          const b = aiChooseBid(hand, st);
          if (b.key !== "pass") t.bid++;
        }
      }
    }
  }
  return tally;
}

if (process.env.SHARD_N) {
  const t = runShard(+process.env.SHARD_N);
  process.send(t);
  process.exit(0);
}

const per = Math.ceil(DEALS / SHARDS);
const jobs = [];
for (let i = 0; i < SHARDS; i++) {
  jobs.push(new Promise((res) => {
    const c = fork(fileURLToPath(import.meta.url), [FILE], {
      env: { ...process.env, SHARD_N: String(per) } });
    c.on("message", res);
  }));
}
const all = await Promise.all(jobs);
const tally = {};
for (const t of all) for (const k of Object.keys(t)) {
  tally[k] = tally[k] || { n: 0, bid: 0 };
  tally[k].n += t[k].n; tally[k].bid += t[k].bid;
}
console.log("file:", path.relative(REPO, FILE), " deals:", per * SHARDS);
console.log("shape        standing      n     bid     rate");
for (const k of Object.keys(tally)) {
  const [key, st] = k.split("|");
  const t = tally[k];
  if (!t.n) continue;
  console.log(key.padEnd(12), String(st).padEnd(12),
    String(t.n).padStart(5), String(t.bid).padStart(6),
    ("  " + (100 * t.bid / t.n).toFixed(1) + "%").padStart(9));
}
