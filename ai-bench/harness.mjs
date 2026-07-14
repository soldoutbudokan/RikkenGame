// Shared harness for benchmarking the Rikken AI.
//
// It loads the engine+AI section of a Rikken.jsx-shaped file (everything up
// to the `==== AI END ====` marker) WITHOUT importing React, by evaluating
// that section in a function scope. Two different versions can therefore
// play at the same table.
//
// CONTRACT for AI authors: the section above the marker must keep defining
// (at least) RULES, makeDeck, shuffle, humanShuffle, deal, sortHand,
// troelaSetup, legalBids, legalMoves, trickWinner, scoreHand, checkEarlyEnd,
// callableCards, contractDef, aiChooseBid, aiChooseCard. Rename or remove
// any of these and the harness (and this file's loader) breaks.

import fs from "fs";

const EXPORTS = [
  "RULES", "makeDeck", "shuffle", "humanShuffle", "deal", "sortHand",
  "troelaSetup", "legalBids", "legalMoves", "trickWinner", "scoreHand",
  "checkEarlyEnd", "callableCards", "contractDef", "aiChooseBid", "aiChooseCard",
];

export function loadAI(path) {
  const raw = fs.readFileSync(path, "utf8");
  const marker = raw.indexOf("==== AI END ====");
  if (marker < 0) throw new Error(path + ": missing '==== AI END ====' marker");
  const src = raw.slice(0, marker)
    .split("\n")
    .filter((l) => !/^\s*import\s/.test(l) && !/^\s*export\s/.test(l))
    .join("\n");
  const body = src + "\nreturn {" + EXPORTS.join(",") + "};";
  const mod = new Function(body)();
  for (const k of EXPORTS)
    if (mod[k] === undefined) throw new Error(path + ": '" + k + "' not defined above the AI END marker");
  return mod;
}

// Play `nHands` full hands. Seats 0+2 use `A`, seats 1+3 use `B` (pass the
// same module twice for a control table). The CANDIDATE module `A` is the
// rules arbiter: its legality/scoring functions referee the table, and any
// illegal play by either side is a hard error. Returns match stats.
export function playMatch(A, B, nHands, { skill = "hardest", onHand } = {}) {
  const modOf = (seat) => (seat % 2 === 0 ? A : B);
  const stats = { hands: 0, redeals: 0, deltas: [], wins: 0, ties: 0,
    declMade: { A: [0, 0], B: [0, 0] }, violations: 0 };
  let dealer = 0;
  let nextDeck = null;

  for (let h = 0; stats.hands < nHands; h++) {
    // deal (realistic shuffle cycle, like the game)
    const realistic = A.RULES.shuffle.mode === "realistic";
    const source = realistic && nextDeck && nextDeck.length === 52 ? nextDeck : A.makeDeck();
    const deck = realistic ? A.humanShuffle(source) : A.shuffle(A.makeDeck());
    const hands = A.deal(deck, dealer).map(A.sortHand);

    // auction — each seat bids with its own brain, candidate rules referee
    let high = null, passed = [false, false, false, false];
    let turn = (dealer + 1) % 4, active = 4;
    while (true) {
      if (!passed[turn]) {
        const bid = modOf(turn).aiChooseBid(hands[turn], high ? high.key : null);
        const legal = A.legalBids(high ? high.key : null, hands[turn]);
        if (bid.key === "pass") { passed[turn] = true; active--; }
        else if (legal.includes(bid.key)) high = { ...bid, seat: turn };
        else { stats.violations++; passed[turn] = true; active--; }
      }
      if (active === 0) break;
      if (active === 1 && high && !passed[high.seat]) break;
      turn = (turn + 1) % 4;
    }
    if (!high) {
      stats.redeals++;
      nextDeck = hands.flat();
      dealer = (dealer + 1) % 4;
      continue;
    }

    // contract
    const def = A.contractDef(high.key);
    let contract = { key: high.key, declarer: high.seat, trump: high.trump || null,
      called: high.called || null, partner: null, revealed: !def.perTrick, soloTroela: false };
    if (high.key === "troela") {
      contract = { ...contract, ...A.troelaSetup(hands, high.seat) };
      contract.revealed = contract.soloTroela;
      contract.trump = null;
    } else if (def.trump === "fixed") contract.trump = def.fixedTrump;
    if (def.perTrick && high.key !== "troela") {
      contract.partner = hands.findIndex((hh) => hh.some((c) => c.id === contract.called.id));
      contract.revealed = false;
    }

    // play
    const game = { hands: hands.map((x) => x.slice()), trick: [], trump: contract.trump,
      contract, playedIds: new Set(), aiSkill: skill, tricksBySeat: [0, 0, 0, 0],
      voids: [{}, {}, {}, {}], openHand: null };
    const wonTricks = [];
    let leader = (dealer + 1) % 4, played = 0, early = null;
    while (played < 13 && !early) {
      game.trick = [];
      for (let k = 0; k < 4; k++) {
        const seat = (leader + k) % 4;
        const legal = A.legalMoves(game.hands[seat], game.trick, game.trump, game.contract);
        let card = modOf(seat).aiChooseCard(seat, game);
        if (!card || !legal.some((c) => c.id === card.id)) { stats.violations++; card = legal[0]; }
        if (game.trick.length && card.s !== game.trick[0].card.s)
          game.voids[seat][game.trick[0].card.s] = true;
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
      leader = A.trickWinner(game.trick, game.trump);
      game.tricksBySeat[leader]++;
      wonTricks.push(game.trick.map((p) => p.card));
      played++;
      const side = contract.partner == null ? [contract.declarer] : [contract.declarer, contract.partner];
      const dt = side.reduce((n, s) => n + game.tricksBySeat[s], 0);
      early = A.checkEarlyEnd(contract.key, dt, played);
    }

    const res = A.scoreHand(contract.key, contract.declarer, contract.partner,
      game.tricksBySeat, !!contract.soloTroela);
    const who = contract.declarer % 2 === 0 ? "A" : "B";
    stats.declMade[who][1]++;
    if (res.made) stats.declMade[who][0]++;
    const aDelta = res.deltas[0] + res.deltas[2];
    stats.deltas.push(aDelta);
    if (aDelta > 0) stats.wins++;
    else if (aDelta === 0) stats.ties++;
    stats.hands++;
    nextDeck = [...wonTricks.flat(), ...game.hands.flat()];
    dealer = (dealer + 1) % 4;
    if (onHand) onHand(stats.hands);
  }

  const n = stats.deltas.length;
  const mean = stats.deltas.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(stats.deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { ...stats, n, mean, se: sd / Math.sqrt(n),
    winRate: stats.wins / Math.max(1, n - stats.ties) };
}

export function report(label, r) {
  console.log("== " + label + " ==");
  console.log("hands: " + r.n + " (+" + r.redeals + " redeals, " + r.violations + " violations)");
  console.log("A points/hand: " + r.mean.toFixed(3) + " ± " + r.se.toFixed(3) +
    " (2 s.e. = " + (2 * r.se).toFixed(3) + ")");
  console.log("hand win rate (A ahead, of decided): " + (100 * r.winRate).toFixed(1) +
    "% of " + (r.n - r.ties) + " (" + r.ties + " ties)");
  const pct = (x) => (x[1] ? (100 * x[0] / x[1]).toFixed(1) + "% of " + x[1] : "n/a");
  console.log("declarer success — A: " + pct(r.declMade.A) + ", B: " + pct(r.declMade.B));
  console.log("");
}
