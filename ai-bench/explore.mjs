// Self-play data pipeline for TUNING THE BIDDER — the tool behind the
// calibrated bid rule (MC_BID_CALIB) in Rikken.jsx.
//
//   node ai-bench/explore.mjs explore <hands> <out.jsonl>   # log randomized bid decisions
//   node ai-bench/explore.mjs beliefs <hands> <out.jsonl>   # log declarer hand shapes
//   node ai-bench/explore.mjs fit <files...>                # fit bid/pass lines per family
//
// `explore` replicates the benchmark table (candidate seats 0+2, baseline
// 1+3) with seat 0's bid/pass cut RANDOMIZED around the decision boundary,
// so realized outcomes are sampled on both arms at every EV — a
// randomized experiment, not observational data. `fit` turns the logs
// into per-family lines: realized ≈ a + b·mcEV (bid), ≈ c + d·mcEV
// (pass); their crossing is the profit-maximizing threshold, subject to
// only trusting the EV range the data actually covered (the `floor`).
//
// Run shards in parallel and concatenate:
//   for i in 1 2 3 4; do node ai-bench/explore.mjs explore 2200 /tmp/x$i.jsonl & done; wait
//   node ai-bench/explore.mjs fit /tmp/x*.jsonl
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const CAND_PATH = path.join(dir, "..", "Rikken.jsx");
const BASE_PATH = path.join(dir, "baseline.jsx");

const CORE = ["RULES", "makeDeck", "shuffle", "humanShuffle", "deal", "sortHand",
  "troelaSetup", "legalBids", "legalMoves", "trickWinner", "scoreHand",
  "checkEarlyEnd", "callableCards", "contractDef", "aiChooseBid", "aiChooseCard",
  "suitCards", "SUITS", "RANKS"];
const EXTRA = ["mcBidOptions", "mcBidEVs", "mcBidValue", "aiTroelaTrump"]; // absent on old baselines

function load(p) {
  const raw = fs.readFileSync(p, "utf8");
  const marker = raw.indexOf("==== AI END ====");
  if (marker < 0) throw new Error(p + ": missing AI END marker");
  const src = raw.slice(0, marker).split("\n")
    .filter((l) => !/^\s*import\s/.test(l) && !/^\s*export\s/.test(l)).join("\n");
  const names = [...CORE, ...EXTRA];
  const mod = new Function(src + "\nreturn {" +
    names.map((k) => k + ": (typeof " + k + " === 'undefined' ? undefined : " + k + ")").join(",") + "};")();
  for (const k of CORE) if (mod[k] === undefined) throw new Error(p + ": missing " + k);
  return mod;
}

// Troela trump pick for baselines that predate aiTroelaTrump, mirroring
// the game's heuristic: longest suit, ties broken by total rank strength.
function troelaTrump(hand) {
  let best = null;
  for (const s of ["S", "H", "C", "D"]) {
    const cards = hand.filter((c) => c.s === s);
    const sum = cards.reduce((n, c) => n + c.r, 0);
    if (!best || cards.length > best.len || (cards.length === best.len && sum > best.sum))
      best = { s, len: cards.length, sum };
  }
  return best.s;
}

// One table, harness-faithful (same shuffle carry-over and referee).
function playHands(A, nHands, { chooseBid, onHand, mods }) {
  const brainOf = (s) => (mods ? mods[s] : A);
  let dealer = 0, nextDeck = null, violations = 0, done = 0;
  while (done < nHands) {
    const realistic = A.RULES.shuffle.mode === "realistic";
    const source = realistic && nextDeck && nextDeck.length === 52 ? nextDeck : A.makeDeck();
    const deck = realistic ? A.humanShuffle(source) : A.shuffle(A.makeDeck());
    const hands = A.deal(deck, dealer).map(A.sortHand);
    const origHands = hands.map((h) => h.slice());
    let high = null, passed = [false, false, false, false];
    let turn = (dealer + 1) % 4, active = 4;
    while (true) {
      if (!passed[turn]) {
        const bid = (chooseBid || ((s, h, k) => brainOf(s).aiChooseBid(h, k)))(
          turn, hands[turn], high ? high.key : null);
        const legal = A.legalBids(high ? high.key : null, hands[turn]);
        if (bid.key === "pass") { passed[turn] = true; active--; }
        else if (legal.includes(bid.key)) high = { ...bid, seat: turn };
        else { violations++; passed[turn] = true; active--; }
      }
      if (active === 0) break;
      if (active === 1 && high && !passed[high.seat]) break;
      turn = (turn + 1) % 4;
    }
    if (!high) {
      if (onHand) onHand({ contract: null, deltas: [0, 0, 0, 0], origHands });
      nextDeck = hands.flat(); dealer = (dealer + 1) % 4; continue;
    }
    const def = A.contractDef(high.key);
    let contract = { key: high.key, declarer: high.seat, trump: high.trump || null,
      called: high.called || null, partner: null, revealed: !def.perTrick, soloTroela: false };
    if (high.key === "troela") {
      // Partnership public from the deal; the fourth-ace holder names
      // trump with their own brain (older baselines: shared heuristic).
      contract = { ...contract, ...A.troelaSetup(hands, high.seat) };
      contract.revealed = true;
      const chooser = contract.soloTroela ? high.seat : contract.partner;
      const M = brainOf(chooser);
      contract.trump = M.aiTroelaTrump
        ? M.aiTroelaTrump(hands[chooser],
            { declarer: high.seat, chooser, leader: (dealer + 1) % 4, called: contract.called })
        : troelaTrump(hands[chooser]);
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
        const legal = A.legalMoves(game.hands[seat], game.trick, game.trump, game.contract);
        let card = brainOf(seat).aiChooseCard(seat, game);
        if (!card || !legal.some((c) => c.id === card.id)) { violations++; card = legal[0]; }
        if (game.trick.length && card.s !== game.trick[0].card.s)
          game.voids[seat][game.trick[0].card.s] = true;
        game.playedCount[seat][card.s] = (game.playedCount[seat][card.s] || 0) + 1;
        game.hands[seat] = game.hands[seat].filter((c) => c.id !== card.id);
        game.trick.push({ seat, card });
        game.playedIds.add(card.id);
        if (contract.called && card.id === contract.called.id && !game.contract.revealed)
          game.contract = { ...game.contract, revealed: true };
        if (def.openAfterTrick1 && played >= 1) game.openHand = contract.declarer;
      }
      leader = A.trickWinner(game.trick, game.trump);
      game.tricksBySeat[leader]++;
      wonTricks.push(game.trick.map((p) => p.card));
      played++;
      const side = contract.partner == null ? [contract.declarer] : [contract.declarer, contract.partner];
      early = A.checkEarlyEnd(contract.key, side.reduce((n, s) => n + game.tricksBySeat[s], 0), played);
    }
    const res = A.scoreHand(contract.key, contract.declarer, contract.partner,
      game.tricksBySeat, !!contract.soloTroela);
    if (onHand) onHand({ contract: game.contract, deltas: res.deltas, origHands });
    nextDeck = [...wonTricks.flat(), ...game.hands.flat()];
    dealer = (dealer + 1) % 4;
    done++;
  }
  return { hands: done, violations };
}

const [cmd, arg1, arg2] = process.argv.slice(2);

if (cmd === "explore" || cmd === "beliefs") {
  const CAND = load(CAND_PATH);
  const HANDS = +(arg1 || 2200);
  const out = fs.createWriteStream(arg2 || cmd + ".jsonl");
  let n = 0;
  if (cmd === "explore") {
    const BASE = load(BASE_PATH);
    const mods = [CAND, BASE, CAND, BASE];
    const DETERMINISTIC = new Set(["troela", "misere", "open_misere", "piek"]);
    let pending = [];
    const chooseBid = (seat, hand, highKey) => {
      if (seat !== 0) return mods[seat].aiChooseBid(hand, highKey);
      const gate = CAND.aiChooseBid(hand, highKey);
      if (DETERMINISTIC.has(gate.key)) return gate;
      const options = CAND.mcBidOptions(hand, CAND.legalBids(highKey, hand));
      if (!options.length) return { key: "pass" };
      const { evs, alive } = CAND.mcBidEVs(hand, options, Math.random);
      let best = alive[0];
      for (const i of alive)
        if (CAND.mcBidValue(options[i].key, evs[i]) > CAND.mcBidValue(options[best].key, evs[best]))
          best = i;
      const ab = options[best].key === "abondance";
      const thr = ab ? 0.5 + Math.random() * 3.5 : -1.2 + Math.random() * 2.4;
      const action = evs[best] > thr ? "bid" : "pass";
      pending.push({ seat, high: highKey, thr: +thr.toFixed(3), action,
        chosen: action === "bid" ? options[best].key : null, bestEv: +evs[best].toFixed(3),
        options: options.map((o, i) => ({ key: o.key, trump: o.trump || null,
          ev: +evs[i].toFixed(3), alive: alive.includes(i) })) });
      return action === "bid" ? options[best] : { key: "pass" };
    };
    const r = playHands(CAND, HANDS, { chooseBid, mods,
      onHand: ({ contract, deltas }) => {
        for (const rec of pending) {
          rec.delta = deltas[rec.seat];
          rec.finalKey = contract ? contract.key : "redeal";
          out.write(JSON.stringify(rec) + "\n"); n++;
        }
        pending = [];
      } });
    console.log(JSON.stringify({ hands: r.hands, violations: r.violations, decisions: n }));
  } else {
    const r = playHands(CAND, HANDS, {
      onHand: ({ contract, origHands }) => {
        if (!contract || !contract.trump || contract.key === "troela") return;
        const dh = origHands[contract.declarer];
        const t = dh.filter((c) => c.s === contract.trump);
        out.write(JSON.stringify({ key: contract.key, trumpLen: t.length,
          trumpHon: t.filter((c) => c.r >= 12).length,
          calledLen: contract.called ? dh.filter((c) => c.s === contract.called.s).length : null,
        }) + "\n"); n++;
      } });
    console.log(JSON.stringify({ hands: r.hands, violations: r.violations, contracts: n }));
  }
  out.end();
} else if (cmd === "fit") {
  const rows = [];
  for (const f of process.argv.slice(3))
    for (const line of fs.readFileSync(f, "utf8").split("\n"))
      if (line.trim()) rows.push(JSON.parse(line));
  const famOf = (k) => k === "rik" ? "rik" : k === "rik_beter" ? "rik_beter"
    : k === "abondance" ? "abondance" : "rik9plus";
  const bestOpt = (r) => {
    let b = null;
    for (const o of r.options) if (o.alive && (!b || o.ev > b.ev)) b = o;
    return b;
  };
  const ols = (pts) => {
    const n = pts.length;
    if (n < 25) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    return { a: +((sy - b * sx) / n).toFixed(3), b: +b.toFixed(3), n };
  };
  const bin = (pts) => {
    const out = {};
    for (const [x, y] of pts) {
      const k = Math.max(-1, Math.min(5, Math.round(x)));
      (out[k] = out[k] || []).push(y);
    }
    return Object.fromEntries(Object.entries(out).sort((p, q) => +p[0] - +q[0]).map(([k, v]) =>
      [k, { n: v.length, mean: +(v.reduce((a, c) => a + c, 0) / v.length).toFixed(2) }]));
  };
  const fams = {};
  for (const r of rows) {
    const opt = r.action === "bid"
      ? r.options.find((o) => o.key === r.chosen && o.ev === r.bestEv) || bestOpt(r)
      : bestOpt(r);
    if (!opt) continue;
    const F = (fams[famOf(opt.key)] = fams[famOf(opt.key)] || { bid: [], pass: [] });
    F[r.action].push([r.bestEv, r.delta]);
  }
  for (const [fam, F] of Object.entries(fams)) {
    const B = ols(F.bid), P = ols(F.pass);
    const thr = B && P && B.b !== P.b ? +((P.a - B.a) / (B.b - P.b)).toFixed(3) : null;
    console.log(JSON.stringify({ family: fam, bid: B, pass: P, crossover: thr }));
    console.log("  bid  bins:", JSON.stringify(bin(F.bid)));
    console.log("  pass bins:", JSON.stringify(bin(F.pass)));
  }
} else {
  console.error("usage: node ai-bench/explore.mjs explore|beliefs <hands> <out.jsonl> | fit <files...>");
  process.exit(1);
}
