import React, { useEffect, useState } from "react";

/* =====================================================================
   RIKKEN — Dutch trick-taking card game. Single-file React component.
   Structure: RULES -> pure rules engine -> rule-based AI -> UI.
   Every tunable rule lives in RULES so a variant is a one-place edit.
   ===================================================================== */

const RULES = {
  seats: 4,
  dealPattern: [4, 4, 5], // packets, dealt clockwise starting left of dealer
  mustTrump: false,       // trumping when void is NOT compulsory
  rikBase: 7,             // rik/troela pay 1 point per trick above this
  troela: {
    target: 8,            // troela pair (or solo four-ace holder) needs 8 tricks
    trumpFromFirstLead: true, // trump is the suit of the very first card led
  },
  // Contracts in ascending auction rank. 'pass' is implicit below all.
  // trump: 'named' (bidder names it) | 'none'. alone: plays without partner.
  // perTrick: rik-style scoring (1/trick above rikBase, undertricks on fail).
  // value: flat payment from each opponent. overtrick: bonus per trick > target.
  contracts: [
    { key: "rik",         label: "Rik",         alone: false, trump: "named", target: 8,  perTrick: true },
    { key: "rik9",        label: "Rik 9",       alone: false, trump: "named", target: 9,  perTrick: true },
    { key: "rik10",       label: "Rik 10",      alone: false, trump: "named", target: 10, perTrick: true },
    { key: "rik11",       label: "Rik 11",      alone: false, trump: "named", target: 11, perTrick: true },
    { key: "rik12",       label: "Rik 12",      alone: false, trump: "named", target: 12, perTrick: true },
    { key: "piek",        label: "Piek",        alone: true,  trump: "none",  target: 1,  exact: true, value: 3 },
    { key: "misere",      label: "Misère",      alone: true,  trump: "none",  target: 0,  exact: true, value: 5 },
    { key: "abondance",   label: "Abondance",   alone: true,  trump: "named", target: 9,  value: 4, overtrick: 1 },
    { key: "open_misere", label: "Open misère", alone: true,  trump: "none",  target: 0,  exact: true, value: 8, openAfterTrick1: true },
    { key: "solo_slim",   label: "Solo slim",   alone: true,  trump: "named", target: 13, value: 15 },
  ],
  timings: { aiThinkMs: 700, trickSweepMs: 1300 },
};

/* ============================ ENGINE ================================ */

const SUITS = ["S", "H", "C", "D"]; // spades, hearts, clubs, diamonds
const SUIT_GLYPH = { S: "♠", H: "♥", C: "♣", D: "♦" };
const SUIT_NAME = { S: "Spades", H: "Hearts", C: "Clubs", D: "Diamonds" };
const RANKS = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]; // A high
const RANK_GLYPH = { 14: "A", 13: "K", 12: "Q", 11: "J", 10: "10", 9: "9", 8: "8", 7: "7", 6: "6", 5: "5", 4: "4", 3: "3", 2: "2" };

function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ s, r, id: s + r });
  return deck;
}

function shuffle(deck, rng = Math.random) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// Deal in packets (RULES.dealPattern), clockwise, starting left of dealer.
function deal(deck, dealer) {
  const hands = [[], [], [], []];
  let idx = 0;
  for (const packet of RULES.dealPattern) {
    for (let k = 0; k < RULES.seats; k++) {
      const seat = (dealer + 1 + k) % RULES.seats;
      hands[seat].push(...deck.slice(idx, idx + packet));
      idx += packet;
    }
  }
  return hands;
}

// Display/sort order: alternate colours, ranks descending within suit.
const SUIT_SORT = { S: 0, H: 1, C: 2, D: 3 };
function sortHand(hand) {
  return hand.slice().sort((a, b) => SUIT_SORT[a.s] - SUIT_SORT[b.s] || b.r - a.r);
}

// Troela: 3 aces => that player declares, 4th-ace holder is silent partner.
// 4 aces => plays alone against three. Returns null if no troela.
function detectTroela(hands) {
  for (let seat = 0; seat < RULES.seats; seat++) {
    const aces = hands[seat].filter((c) => c.r === 14).length;
    if (aces === 4) return { declarer: seat, partner: null, solo: true };
    if (aces === 3) {
      const partner = hands.findIndex((h) => h.some((c) => c.r === 14 && !hands[seat].some((x) => x.id === c.id)));
      return { declarer: seat, partner, solo: false };
    }
  }
  return null;
}

const BID_ORDER = ["pass", ...RULES.contracts.map((c) => c.key)];
const bidRank = (key) => BID_ORDER.indexOf(key);
const contractDef = (key) =>
  key === "troela"
    ? { key: "troela", label: "Troela", alone: false, trump: "lead", target: RULES.troela.target, perTrick: true }
    : RULES.contracts.find((c) => c.key === key);

// Bids that outrank the current highest ('pass' is always available).
function legalBids(currentHighKey) {
  const min = currentHighKey ? bidRank(currentHighKey) : 0;
  return BID_ORDER.filter((k) => k === "pass" || bidRank(k) > min);
}

// Follow suit if you can; otherwise anything (RULES.mustTrump toggles
// compulsory trumping for variants — off in this ruleset).
function legalMoves(hand, trick, trump) {
  if (trick.length === 0) return hand.slice();
  const led = trick[0].card.s;
  const follow = hand.filter((c) => c.s === led);
  if (follow.length) return follow;
  if (RULES.mustTrump && trump) {
    const trumps = hand.filter((c) => c.s === trump);
    if (trumps.length) return trumps;
  }
  return hand.slice();
}

// Highest trump wins; otherwise highest card of the suit led.
function trickWinner(trick, trump) {
  const led = trick[0].card.s;
  let best = trick[0];
  for (const play of trick.slice(1)) {
    const c = play.card, b = best.card;
    if (trump && c.s === trump && (b.s !== trump || c.r > b.r)) best = play;
    else if (c.s === b.s && c.r > b.r && (b.s !== trump || c.s === trump)) best = play;
  }
  return best.seat;
}

// Result + zero-sum point deltas for a finished (or early-ended) hand.
// tricksBySeat: array[4]. Returns { made, declTricks, deltas[4] }.
function scoreHand(contractKey, declarer, partner, tricksBySeat, soloTroela = false) {
  const def = contractDef(contractKey);
  const seats = [0, 1, 2, 3];
  const side = partner == null ? [declarer] : [declarer, partner];
  const declTricks = side.reduce((n, s) => n + tricksBySeat[s], 0);
  const made = def.exact ? declTricks === def.target : declTricks >= def.target;
  const deltas = [0, 0, 0, 0];

  if (def.perTrick) {
    // Rik / troela: 1 point per trick above rikBase (7). Each opponent pays
    // that to each partner; on failure the partners pay. Simplest reading for
    // the failure amount (rule is silent): 1 per trick short of the target.
    const amount = made ? declTricks - RULES.rikBase : def.target - declTricks;
    if (soloTroela) {
      // Four aces: alone vs three, same per-trick amount to/from each other.
      for (const s of seats) {
        if (s === declarer) deltas[s] += (made ? 3 : -3) * amount;
        else deltas[s] += (made ? -1 : 1) * amount;
      }
    } else {
      for (const p of side)
        for (const o of seats.filter((x) => !side.includes(x)))
          { deltas[p] += made ? amount : -amount; deltas[o] += made ? -amount : amount; }
    }
  } else {
    // Flat contracts. Overtricks only where defined (abondance, when made).
    // Simplest reading (rule is silent): failures pay the flat value only.
    let v = def.value;
    if (made && def.overtrick) v += def.overtrick * (declTricks - def.target);
    for (const s of seats) {
      if (s === declarer) deltas[s] += (made ? 3 : -3) * v;
      else deltas[s] += (made ? -1 : 1) * v;
    }
  }

  const sum = deltas.reduce((a, b) => a + b, 0);
  if (sum !== 0) throw new Error("Rikken scoring must be zero-sum, got " + sum);
  return { made, declTricks, deltas };
}

// Cut the hand short once the result is decided AND no remaining trick can
// change the score. Returns 'made' | 'failed' | null (keep playing).
function checkEarlyEnd(contractKey, declTricks, tricksPlayed) {
  const def = contractDef(contractKey);
  const remaining = 13 - tricksPlayed;
  if (def.exact && def.target === 0 && declTricks > 0) return "failed"; // misère types
  if (def.exact && def.target === 1 && declTricks >= 2) return "failed"; // piek
  if (contractKey === "solo_slim" && declTricks < tricksPlayed) return "failed";
  // Abondance failure pays a flat 4, so stop once 9 is unreachable; when it
  // is made we keep playing because overtricks still move the score.
  if (contractKey === "abondance" && declTricks + remaining < def.target) return "failed";
  // Rik/troela: over- and undertricks both change the score — never end early.
  return null;
}

// Cards the rik bidder may call: an ace of a non-trump suit they don't hold.
// Holding all three non-trump aces, they call a king instead; the rule is
// silent past that, so keep stepping down (Q, J, ...) — simplest reading.
function callableCards(hand, trump) {
  for (const rank of [14, 13, 12, 11, 10]) {
    const opts = SUITS.filter(
      (s) => s !== trump && !hand.some((c) => c.s === s && c.r === rank)
    );
    if (opts.length) return opts.map((s) => ({ s, r: rank, id: s + rank }));
  }
  return []; // unreachable with 13 cards
}
// ==== ENGINE END ====

/* ============================== AI ================================== */
// Rule-based, sound-not-brilliant. aiSkill: 'casual' adds randomness to
// discards; 'sharp' is deterministic.

function suitCards(hand, s) { return hand.filter((c) => c.s === s); }

// Pick the AI's bid. Returns { key, trump?, called? } — key 'pass' to pass.
function aiChooseBid(hand, currentHighKey) {
  const legal = legalBids(currentHighKey);
  const lens = SUITS.map((s) => ({ s, cards: suitCards(hand, s) }));
  const aces = hand.filter((c) => c.r === 14).length;
  const honours = hand.filter((c) => c.r >= 12).length; // A K Q
  const voids = lens.filter((l) => l.cards.length === 0).length;
  const best = lens.slice().sort((a, b) =>
    b.cards.length - a.cards.length ||
    b.cards.reduce((n, c) => n + c.r, 0) - a.cards.reduce((n, c) => n + c.r, 0))[0];
  const bestHonours = best.cards.filter((c) => c.r >= 12).length;

  // Misère family: only low cards, and no long suit missing its low spots.
  const lowHand = hand.every((c) => c.r <= 10) &&
    lens.every((l) => l.cards.length < 4 || l.cards.some((c) => c.r <= 4));
  const veryLow = lowHand && hand.every((c) => c.r <= 8);
  if (veryLow && legal.includes("open_misere")) return { key: "open_misere" };
  if (lowHand && legal.includes("misere")) return { key: "misere" };

  // Piek: exactly one likely winner, everything else low.
  const highs = hand.filter((c) => c.r >= 13);
  if (highs.length === 1 && hand.filter((c) => c.r >= 11).length === 1 &&
      lowHandish(hand, highs[0]) && legal.includes("piek")) return { key: "piek" };

  // Abondance: dominant long suit, near-solo strength.
  if (best.cards.length >= 7 && bestHonours >= 2 && honours >= 5 && legal.includes("abondance"))
    return { key: "abondance", trump: best.s };

  // Rik: strong long trump suit + a plausible outside ace to call + support.
  const strength = best.cards.length + honours + aces + voids;
  const callable = callableCards(hand, best.s);
  if (best.cards.length >= 5 && bestHonours >= 1 && strength >= 9 &&
      callable.length > 0 && legal.includes("rik"))
    return { key: "rik", trump: best.s, called: callable[0] };

  return { key: "pass" }; // pass by default
}
function lowHandish(hand, except) {
  return hand.every((c) => c.id === except.id || c.r <= 9);
}

// True if `card` is the highest still-unseen card of its suit.
function isMaster(card, playedIds) {
  for (let r = card.r + 1; r <= 14; r++) if (!playedIds.has(card.s + r)) return false;
  return true;
}

// What the AI in `seat` knows about friends. Partnerships in a rik stay
// hidden until the called ace appears — except to the partner themself,
// who sees the called card in their own hand. Troela's fourth-ace holder
// likewise "stays silent" until that ace is played (treated as called).
function knownFriends(seat, game) {
  const { contract } = game;
  const friends = new Set([seat]);
  if (!contract) return friends;
  const { declarer, partner, revealed } = contract;
  const isPublic = revealed;
  if (seat === declarer) {
    if (isPublic && partner != null) friends.add(partner);
  } else if (seat === partner) {
    friends.add(declarer); // the silent partner always knows
  } else if (isPublic) {
    // Defender who has seen the reveal: friends are the other defenders.
    for (let s = 0; s < 4; s++) if (s !== declarer && s !== partner) friends.add(s);
  } else {
    // Unrevealed rik: assume only the declarer is surely an enemy.
    for (let s = 0; s < 4; s++) if (s !== declarer && s !== seat) friends.add(s);
  }
  return friends;
}

function aiChooseCard(seat, game) {
  const { hands, trick, trump, contract, playedIds, aiSkill } = game;
  const legal = legalMoves(hands[seat], trick, trump);
  if (legal.length === 1) return legal[0];
  const rng = Math.random;
  if (aiSkill === "casual" && rng() < 0.15) // casual: occasional random card
    return legal[Math.floor(rng() * legal.length)];

  const def = contractDef(contract.key);
  const iAmDeclSide = seat === contract.declarer || seat === contract.partner;
  const avoidTricks = def.target === 0 || (def.exact && def.target === 1 && tricksOf(game, contract) >= 1);
  const wantAvoid = iAmDeclSide ? avoidTricks : false;
  const byRank = legal.slice().sort((a, b) => a.r - b.r);
  const friends = knownFriends(seat, game);

  // Ducking mode (misère declarer, piek declarer already on 1 trick).
  if (wantAvoid) {
    if (trick.length === 0) return byRank[0]; // lead lowest
    const under = byRank.filter((c) => !wouldWin(c, trick, trump, seat));
    return under.length ? under[under.length - 1] : byRank[byRank.length - 1];
  }

  // Piek declarer still hunting their single trick: cheapest winner.
  if (iAmDeclSide && def.exact && def.target === 1) {
    const winners = byRank.filter((c) => wouldWin(c, trick, trump, seat));
    if (trick.length === 3 && winners.length) return winners[0];
    if (trick.length === 0) {
      const masters = byRank.filter((c) => isMaster(c, playedIds));
      if (masters.length) return masters[0];
    }
    return byRank[0];
  }

  // Defending against misère/piek: dump dangerous high cards under the
  // trick when possible, otherwise lead low to force the declarer up.
  if (!iAmDeclSide && def.target <= 1) {
    if (trick.length === 0) return byRank[0];
    const declPlayed = trick.find((p) => p.seat === contract.declarer);
    if (declPlayed && trick[0].card.s === declPlayed.card.s) {
      const under = byRank.filter((c) => c.s !== trick[0].card.s || c.r < declPlayed.card.r);
      if (under.length) return under[under.length - 1]; // biggest safe dump
    }
    return byRank[0];
  }

  // Trump contracts (rik / troela / abondance / solo slim) and defence.
  const trumpsOut = trump
    ? 13 - hands[seat].filter((c) => c.s === trump).length -
      [...playedIds].filter((id) => id.startsWith(trump)).length
    : 0;

  if (trick.length === 0) {
    // Declaring side leads trump to draw while enemies may still hold them.
    if (iAmDeclSide && trump && trumpsOut > 0) {
      const myTrumps = byRank.filter((c) => c.s === trump);
      if (myTrumps.length) {
        const masters = myTrumps.filter((c) => isMaster(c, playedIds));
        return masters.length ? masters[masters.length - 1] : myTrumps[0];
      }
    }
    // Otherwise lead a master if we have one, else a low card.
    const masters = byRank.filter((c) => isMaster(c, playedIds) && c.s !== trump);
    if (masters.length) return masters[masters.length - 1];
    return byRank[0];
  }

  const winnerNow = trickWinner(trick, trump);
  const friendWinning = friends.has(winnerNow);
  const winners = byRank.filter((c) => wouldWin(c, trick, trump, seat));

  if (!friendWinning && winners.length) {
    // Worth taking: cheapest winner (prefer suit winners over trumps).
    const plain = winners.filter((c) => c.s !== trump);
    return plain.length ? plain[0] : winners[0];
  }
  // Duck / discard low. Casual AI randomises the discard choice.
  const canFollow = legal.some((c) => c.s === trick[0].card.s);
  if (!canFollow && aiSkill === "casual") {
    const lows = byRank.slice(0, Math.min(3, byRank.length));
    return lows[Math.floor(rng() * lows.length)];
  }
  const nonTrumpLow = byRank.filter((c) => c.s !== trump);
  return canFollow ? byRank[0] : (nonTrumpLow[0] || byRank[0]);
}

function wouldWin(card, trick, trump, seat) {
  return trickWinner([...trick, { seat, card }], trump) === seat;
}
function tricksOf(game, contract) {
  const side = contract.partner == null ? [contract.declarer] : [contract.declarer, contract.partner];
  return side.reduce((n, s) => n + game.tricksBySeat[s], 0);
}
// ==== AI END ====

/* ======================= GAME FLOW (state transitions) ============== */
// The whole game lives in one state object `g`; every transition below is
// a pure function g -> g so the UI layer only wires clicks and timers.

const AI_NAMES = ["Anouk", "Bram", "Sanne", "Daan"];

function newGame({ mode, humanNames, aiSkill }) {
  const humans = humanNames.map((_, i) => i);
  const names = [0, 1, 2, 3].map((i) =>
    i < humanNames.length ? humanNames[i] : AI_NAMES[i] + " (AI)");
  return freshHand({
    screen: "game", mode, humans, names, aiSkill,
    scores: [0, 0, 0, 0], handNo: 1, dealer: 0,
    revealedSeat: mode === "solo" ? 0 : null,
  });
}

function freshHand(g) {
  const hands = deal(shuffle(makeDeck()), g.dealer).map(sortHand);
  const troela = detectTroela(hands);
  const base = {
    ...g, hands, trick: [], tricksBySeat: [0, 0, 0, 0], playedIds: new Set(),
    trickNo: 0, lastResult: null, openHand: null, high: null,
    passed: [false, false, false, false], bidLog: [],
    leader: (g.dealer + 1) % 4, turn: (g.dealer + 1) % 4,
    // Hot seat: hide the fan again until the next actor confirms the handoff.
    revealedSeat: g.mode === "solo" ? 0 : null,
  };
  if (troela) {
    // Troela bypasses the auction. The fourth ace works like a called ace:
    // its holder stays silent until it hits the table.
    const fourthAce = troela.solo ? null : hands[troela.partner].find((c) => c.r === 14);
    return {
      ...base, phase: "play",
      contract: { key: "troela", declarer: troela.declarer, partner: troela.partner,
        trump: null, called: fourthAce, revealed: troela.solo, soloTroela: troela.solo },
    };
  }
  return { ...base, phase: "bidding", contract: null, bidTurn: (g.dealer + 1) % 4 };
}

function applyBid(g, seat, key, choice) {
  // Note: the turn can never come back around to an unchanged high bidder —
  // the three others must all act first, and three passes end the auction.
  const bidLog = [...g.bidLog, { seat, key }];
  const passed = g.passed.slice();
  let high = g.high;
  if (key === "pass") passed[seat] = true;
  else high = { key, seat, trump: choice?.trump || null, called: choice?.called || null };

  if (!high && passed.every(Boolean)) return { ...g, passed, bidLog, phase: "redeal" };
  if (high && passed.every((p, s) => s === high.seat || p)) {
    // Auction over: everyone else has passed.
    const def = contractDef(high.key);
    const contract = { key: high.key, declarer: high.seat, partner: null,
      trump: null, called: null, revealed: !def.perTrick, soloTroela: false };
    return { ...g, passed, high, bidLog, contract,
      phase: def.trump === "named" ? "declareTrump" : "play0" };
  }
  let t = (seat + 1) % 4;
  while (passed[t]) t = (t + 1) % 4;
  return { ...g, passed, high, bidLog, bidTurn: t };
}

function applyTrumpChoice(g, suit) {
  const contract = { ...g.contract, trump: suit };
  const def = contractDef(contract.key);
  if (def.perTrick) return { ...g, contract, phase: "declareCall" }; // rik: now call
  return { ...g, contract, phase: "play0" };
}

function applyCallChoice(g, card) {
  const partner = g.hands.findIndex((h) => h.some((c) => c.id === card.id));
  return { ...g, phase: "play0",
    contract: { ...g.contract, called: card, partner, revealed: false } };
}

// 'play0' is a zero-duration phase so declarations funnel through one spot.
function startPlay(g) {
  return { ...g, phase: "play", trick: [],
    leader: (g.dealer + 1) % 4, turn: (g.dealer + 1) % 4 };
}

function playCard(g, seat, card) {
  if (g.phase !== "play" || g.turn !== seat) return g;
  if (!legalMoves(g.hands[seat], g.trick, g.contract.trump).some((c) => c.id === card.id)) return g;
  const hands = g.hands.map((h, i) => (i === seat ? h.filter((c) => c.id !== card.id) : h));
  const trick = [...g.trick, { seat, card }];
  const playedIds = new Set(g.playedIds);
  playedIds.add(card.id);
  let contract = g.contract;
  if (contract.key === "troela" && contract.trump == null)
    contract = { ...contract, trump: card.s }; // very first card led sets trump
  if (contract.called && !contract.revealed && card.id === contract.called.id)
    contract = { ...contract, revealed: true }; // partnership now public
  const next = { ...g, hands, trick, playedIds, contract };
  if (trick.length === 4) return { ...next, phase: "trickPause" };
  return { ...next, turn: (seat + 1) % 4 };
}

function sweepTrick(g) {
  const winner = trickWinner(g.trick, g.contract.trump);
  const tricksBySeat = g.tricksBySeat.slice();
  tricksBySeat[winner]++;
  const trickNo = g.trickNo + 1;
  const openHand = contractDef(g.contract.key).openAfterTrick1 && trickNo >= 1
    ? g.contract.declarer : g.openHand;
  const side = g.contract.partner == null ? [g.contract.declarer] : [g.contract.declarer, g.contract.partner];
  const declTricks = side.reduce((n, s) => n + tricksBySeat[s], 0);
  const g2 = { ...g, tricksBySeat, trickNo, openHand, trick: [], leader: winner, turn: winner, phase: "play" };
  const early = checkEarlyEnd(g.contract.key, declTricks, trickNo);
  if (early || trickNo === 13) return finishHand(g2, early);
  return g2;
}

function finishHand(g, early) {
  const c = g.contract;
  const res = scoreHand(c.key, c.declarer, c.partner, g.tricksBySeat, c.soloTroela);
  return { ...g, phase: "handEnd",
    scores: g.scores.map((s, i) => s + res.deltas[i]),
    contract: { ...c, revealed: true },
    lastResult: { ...res, early: !!early } };
}

function nextHand(g) {
  return freshHand({ ...g, dealer: (g.dealer + 1) % 4, handNo: g.handNo + 1 });
}

// Whose input the game is waiting for (null while a trick pause runs etc.).
function actorSeat(g) {
  if (g.phase === "bidding") return g.bidTurn;
  if (g.phase === "declareTrump" || g.phase === "declareCall") return g.contract.declarer;
  if (g.phase === "play") return g.turn;
  return null;
}

// One AI step for whatever the current phase needs.
function aiAct(g) {
  const actor = actorSeat(g);
  if (actor == null || g.humans.includes(actor)) return g;
  if (g.phase === "bidding") {
    const bid = aiChooseBid(g.hands[actor], g.high ? g.high.key : null);
    return applyBid(g, actor, bid.key, bid);
  }
  if (g.phase === "declareTrump") return applyTrumpChoice(g, g.high.trump);
  if (g.phase === "declareCall") return applyCallChoice(g, g.high.called);
  if (g.phase === "play") return playCard(g, actor, aiChooseCard(actor, g));
  return g;
}
// ==== FLOW END ====

/* ========================== UI COMPONENTS =========================== */

const suitColor = (s) => (s === "H" || s === "D" ? "text-red-600" : "text-slate-900");

function CardFace({ card, size = "md", onClick, dimmed, highlight }) {
  const dims = size === "sm"
    ? "w-8 h-11 text-[10px] p-0.5 rounded"
    : "w-12 h-[4.4rem] sm:w-14 sm:h-20 text-xs sm:text-sm p-1 rounded-lg";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={
        "relative bg-white border border-slate-300 shadow-md flex flex-col justify-between select-none shrink-0 " +
        dims + " " + suitColor(card.s) +
        (dimmed ? " opacity-40" : "") +
        (highlight ? " ring-4 ring-amber-300" : "") +
        (onClick ? " cursor-pointer hover:-translate-y-2 focus:-translate-y-2 active:-translate-y-2 transition-transform" : " cursor-default")
      }
    >
      <div className="leading-none font-bold text-left">
        {RANK_GLYPH[card.r]}
        <div>{SUIT_GLYPH[card.s]}</div>
      </div>
      <div className={"text-center leading-none " + (size === "sm" ? "text-xs" : "text-xl sm:text-2xl")}>
        {SUIT_GLYPH[card.s]}
      </div>
      <div className="leading-none font-bold rotate-180">
        {RANK_GLYPH[card.r]}
        <div>{SUIT_GLYPH[card.s]}</div>
      </div>
    </button>
  );
}

function CardBack() {
  return (
    <div
      className="w-7 h-10 rounded border border-blue-950 bg-blue-800 shadow shrink-0"
      style={{ backgroundImage: "repeating-linear-gradient(45deg, rgba(255,255,255,.18) 0 3px, transparent 3px 7px)" }}
    />
  );
}

// Public info only: dealer, declarer, trick count, whose turn. The hidden
// partner gets NO marker until the called ace has been played.
function SeatBadge({ g, seat }) {
  const c = g.contract;
  const isDecl = c && seat === c.declarer;
  const isPartner = c && c.revealed && seat === c.partner;
  const onTurn = actorSeat(g) === seat;
  return (
    <div className={"flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs sm:text-sm " +
      (onTurn ? "bg-amber-300 text-emerald-950 font-semibold" : "bg-emerald-950/60 text-emerald-50")}>
      {seat === g.dealer && <span title="Dealer" className="rounded-full bg-white text-emerald-900 font-bold px-1 leading-4">D</span>}
      <span className="whitespace-nowrap">{g.names[seat]}</span>
      {isDecl && <span title="Declarer">★</span>}
      {isPartner && <span title="Partner">☆</span>}
      <span className="opacity-80">· {g.tricksBySeat[seat]}</span>
    </div>
  );
}

function OpponentSeat({ g, seat, pos, mobile }) {
  const wrap = pos === "top"
    ? "top-2 left-1/2 -translate-x-1/2 items-center"
    : pos === "left"
      ? (mobile ? "left-1 top-14 items-start" : "left-2 top-1/2 -translate-y-1/2 items-start")
      : (mobile ? "right-1 top-14 items-end" : "right-2 top-1/2 -translate-y-1/2 items-end");
  const n = g.hands[seat].length;
  return (
    <div className={"absolute flex flex-col gap-1.5 " + wrap}>
      <SeatBadge g={g} seat={seat} />
      {g.openHand === seat ? ( // open misère: declarer plays face up
        <div className={"flex flex-wrap gap-0.5 justify-center " + (mobile ? "max-w-[10rem]" : "max-w-[15rem]")}>
          {g.hands[seat].map((c) => <CardFace key={c.id} card={c} size="sm" />)}
        </div>
      ) : mobile ? (
        // Phones: a mini stack + count instead of a full row of card backs.
        <div className={"flex items-center gap-1 " + (pos === "right" ? "flex-row-reverse" : "")}>
          <div className="flex -space-x-5">
            {Array.from({ length: Math.min(3, n) }, (_, i) => <CardBack key={i} />)}
          </div>
          <span className="rounded-full bg-emerald-950/60 px-1.5 py-0.5 text-[10px] text-emerald-200">{n}</span>
        </div>
      ) : (
        <div className="flex -space-x-5">
          {g.hands[seat].map((c) => <CardBack key={c.id} />)}
        </div>
      )}
    </div>
  );
}

function TrickArea({ g, baseSeat }) {
  const winner = g.phase === "trickPause" && g.trick.length === 4
    ? trickWinner(g.trick, g.contract.trump) : null;
  const POS = [
    "left-1/2 -translate-x-1/2 bottom-0",
    "left-0 top-1/2 -translate-y-1/2",
    "left-1/2 -translate-x-1/2 top-0",
    "right-0 top-1/2 -translate-y-1/2",
  ];
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div className="relative w-52 h-44 sm:w-60 sm:h-48">
        {g.trick.map((p) => (
          <div key={p.card.id} className={"absolute " + POS[(p.seat - baseSeat + 4) % 4]}>
            <CardFace card={p.card} highlight={winner === p.seat} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Fan({ g, seat, active, onPlay, mobile }) {
  const legal = active ? legalMoves(g.hands[seat], g.trick, g.contract ? g.contract.trump : null) : [];
  const legalIds = new Set(legal.map((c) => c.id));
  const cards = g.hands[seat].map((c) => {
    const ok = active && legalIds.has(c.id);
    return (
      <CardFace
        key={c.id}
        card={c}
        dimmed={active && !ok}
        onClick={ok ? () => onPlay(c) : undefined}
      />
    );
  });
  if (mobile) {
    // Tighter overlap so 13 cards fit a phone; scrolls if the screen is
    // narrower still (min-w-max keeps the fan from being clipped left).
    return (
      <div className="overflow-x-auto">
        <div className="flex min-w-max mx-auto justify-center px-3 pb-2 pt-1 -space-x-6">{cards}</div>
      </div>
    );
  }
  return <div className="flex justify-center px-2 pb-2 -space-x-4 sm:-space-x-3">{cards}</div>;
}

function BidPanel({ g, seat, onBid }) {
  const legal = new Set(legalBids(g.high ? g.high.key : null));
  return (
    <div className="mx-auto mb-2 max-w-2xl rounded-xl bg-emerald-950/80 p-3 text-center">
      <div className="mb-2 text-sm text-emerald-100">
        {g.names[seat]}, your bid{g.high ? " — to beat: " + contractDef(g.high.key).label +
          " (" + g.names[g.high.seat] + ")" : ""}
      </div>
      <div className="flex flex-wrap justify-center gap-1.5">
        <button type="button" onClick={() => onBid("pass")}
          className="rounded-lg bg-slate-500 hover:bg-slate-400 px-3 py-1.5 text-sm font-semibold">
          Pass
        </button>
        {RULES.contracts.map((c) => (
          <button
            key={c.key}
            type="button"
            disabled={!legal.has(c.key)}
            onClick={() => onBid(c.key)}
            className="rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-semibold text-emerald-950
                       hover:bg-amber-400 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Modal({ children, wide }) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div className={"rounded-2xl bg-emerald-950 border border-emerald-700 p-5 text-emerald-50 shadow-2xl " +
        (wide ? "max-w-2xl w-full max-h-[85vh] overflow-y-auto" : "max-w-md w-full")}>
        {children}
      </div>
    </div>
  );
}

function TrumpPicker({ g, onPick }) {
  return (
    <Modal>
      <div className="mb-3 font-semibold">{g.names[g.contract.declarer]}: name your trump suit
        for {contractDef(g.contract.key).label}</div>
      <div className="flex justify-center gap-2">
        {SUITS.map((s) => (
          <button key={s} type="button" onClick={() => onPick(s)}
            className={"w-16 h-16 rounded-xl bg-white text-4xl hover:ring-4 ring-amber-300 " +
              (s === "H" || s === "D" ? "text-red-600" : "text-slate-900")}>
            {SUIT_GLYPH[s]}
          </button>
        ))}
      </div>
    </Modal>
  );
}

function CallPicker({ g, onPick }) {
  const opts = callableCards(g.hands[g.contract.declarer], g.contract.trump);
  return (
    <Modal>
      <div className="mb-1 font-semibold">Call a card — its holder becomes your secret partner</div>
      <div className="mb-3 text-sm text-emerald-200">
        {opts[0].r === 14 ? "An ace of a non-trump suit you do not hold."
          : "You hold every callable ace, so you call a " + RANK_GLYPH[opts[0].r] + " instead."}
      </div>
      <div className="flex justify-center gap-2">
        {opts.map((c) => <CardFace key={c.id} card={c} onClick={() => onPick(c)} />)}
      </div>
    </Modal>
  );
}

// Phone detection: small viewport, or a touch-first device up to tablet
// size. Live media query, so rotating or resizing re-optimizes on the fly.
const MOBILE_MQ = "(max-width: 700px), (pointer: coarse) and (max-width: 1024px)";
function useIsMobile() {
  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(MOBILE_MQ).matches
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(MOBILE_MQ);
    const onChange = (e) => setMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return mobile;
}

// Compact status strip for phones; the full panel lives in a drawer.
function MobileTopBar({ g, onPanel }) {
  const c = g.contract;
  const def = c && contractDef(c.key);
  // Same privacy rule as the side panel: no declaring-side total while the
  // called-ace partnership is still hidden.
  const showSides = c && (c.partner == null || c.revealed);
  const side = c ? (c.partner == null ? [c.declarer] : [c.declarer, c.partner]) : [];
  const declTricks = side.reduce((n, s) => n + g.tricksBySeat[s], 0);
  return (
    <div className="z-20 flex shrink-0 items-center justify-between gap-2 border-b border-emerald-800 bg-emerald-950/95 px-2.5 py-1.5 text-xs">
      <div className="truncate">
        <span className="font-bold">Hand {g.handNo}</span>
        {c
          ? <span> · {def.label}{c.trump ? " " + SUIT_GLYPH[c.trump] : ""}{showSides ? " · " + declTricks + "/" + def.target : ""}</span>
          : <span> · bidding…</span>}
      </div>
      <button type="button" onClick={onPanel}
        className="shrink-0 rounded-lg bg-emerald-700 px-2.5 py-1 font-semibold hover:bg-emerald-600">
        Scores & rules
      </button>
    </div>
  );
}

function SidePanel({ g, onRules, onNewGame, onClose }) {
  const c = g.contract;
  const def = c && contractDef(c.key);
  const showSides = c && (c.partner == null || c.revealed);
  const side = c ? (c.partner == null ? [c.declarer] : [c.declarer, c.partner]) : [];
  const declTricks = side.reduce((n, s) => n + g.tricksBySeat[s], 0);
  const defTricks = g.tricksBySeat.reduce((a, b) => a + b, 0) - declTricks;
  return (
    <div className="h-full w-56 sm:w-64 shrink-0 bg-emerald-950/90 border-l border-emerald-800 p-3 flex flex-col gap-3 text-sm overflow-y-auto">
      <div className="flex items-center justify-between">
        <div className="font-bold text-base">Rikken</div>
        <div className="flex items-center gap-2">
          <div className="text-emerald-300">Hand {g.handNo}</div>
          {onClose && (
            <button type="button" onClick={onClose} aria-label="Close panel"
              className="rounded-lg bg-emerald-800 px-2 py-0.5 font-bold hover:bg-emerald-700">✕</button>
          )}
        </div>
      </div>

      <div className="rounded-lg bg-emerald-900/70 p-2 space-y-1">
        <Row k="Contract" v={c ? def.label + " — " + g.names[c.declarer] : "bidding…"} />
        <Row k="Trump" v={c ? (def.trump === "none" ? "none" :
          c.trump ? SUIT_GLYPH[c.trump] + " " + SUIT_NAME[c.trump] : "first card led") : "—"} />
        <Row k="Target" v={c ? (def.exact ? "exactly " + def.target : def.target) + " tricks" : "—"} />
        {c && c.partner != null && (
          <Row k="Partner" v={c.revealed ? g.names[c.partner]
            : c.called ? "holder of " + RANK_GLYPH[c.called.r] + SUIT_GLYPH[c.called.s] + " (hidden)" : "hidden"} />
        )}
      </div>

      <div className="rounded-lg bg-emerald-900/70 p-2">
        <div className="mb-1 font-semibold text-emerald-200">Tricks</div>
        {showSides ? (
          <>
            <Row k="Declaring side" v={declTricks + " / " + def.target} />
            <Row k="Defenders" v={defTricks} />
          </>
        ) : (
          // Partnership still hidden: per-seat counts only, no side totals
          // (a side total would leak who the called-ace partner is).
          g.names.map((n, i) => <Row key={i} k={n} v={g.tricksBySeat[i]} />)
        )}
      </div>

      <div className="rounded-lg bg-emerald-900/70 p-2">
        <div className="mb-1 font-semibold text-emerald-200">Scores</div>
        {g.names.map((n, i) => <Row key={i} k={n} v={g.scores[i]} />)}
      </div>

      {g.phase === "bidding" && g.bidLog.length > 0 && (
        <div className="rounded-lg bg-emerald-900/70 p-2">
          <div className="mb-1 font-semibold text-emerald-200">Auction</div>
          {g.bidLog.slice(-6).map((b, i) => (
            <Row key={i} k={g.names[b.seat]} v={b.key === "pass" ? "pass" : contractDef(b.key).label} />
          ))}
        </div>
      )}

      <div className="mt-auto flex flex-col gap-1.5">
        <button type="button" onClick={onRules} className="rounded-lg bg-emerald-700 hover:bg-emerald-600 py-1.5 font-semibold">Rules</button>
        <button type="button" onClick={onNewGame} className="rounded-lg bg-emerald-800 hover:bg-emerald-700 py-1.5">New game</button>
      </div>
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-emerald-300">{k}</span>
      <span className="font-medium text-right">{v}</span>
    </div>
  );
}

function HandEndModal({ g, onNext }) {
  const c = g.contract, r = g.lastResult, def = contractDef(c.key);
  return (
    <Modal>
      <div className="text-lg font-bold mb-1">
        {def.label} {r.made ? "made" : "down"}
        {r.early ? " (hand cut short)" : ""}
      </div>
      <div className="text-sm text-emerald-200 mb-3">
        {g.names[c.declarer]}{c.partner != null ? " & " + g.names[c.partner] : ""} took {r.declTricks}
        {" "}trick{r.declTricks === 1 ? "" : "s"} — needed {def.exact ? "exactly " : ""}{def.target}.
      </div>
      <table className="w-full text-sm mb-4">
        <tbody>
          {g.names.map((n, i) => (
            <tr key={i} className="border-t border-emerald-800">
              <td className="py-1">{n}</td>
              <td className={"py-1 text-right font-mono " + (r.deltas[i] > 0 ? "text-emerald-300" : r.deltas[i] < 0 ? "text-red-300" : "")}>
                {r.deltas[i] > 0 ? "+" + r.deltas[i] : r.deltas[i]}
              </td>
              <td className="py-1 text-right font-mono text-emerald-100">{g.scores[i]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={onNext} className="w-full rounded-lg bg-amber-500 text-emerald-950 font-bold py-2 hover:bg-amber-400">
        Deal next hand
      </button>
    </Modal>
  );
}

function RulesModal({ onClose }) {
  const H = ({ children }) => <div className="mt-3 mb-1 font-bold text-amber-300">{children}</div>;
  return (
    <Modal wide>
      <div className="flex justify-between items-center">
        <div className="text-lg font-bold">Rikken — ruleset in play</div>
        <button type="button" onClick={onClose} className="rounded-lg bg-emerald-700 px-3 py-1 hover:bg-emerald-600">Close</button>
      </div>
      <div className="text-sm leading-relaxed">
        <H>Setup</H>
        52 cards, ace high. Four seats, play clockwise. 13 cards each, dealt 4-4-5. Dealer rotates.
        <H>Bidding</H>
        Starts left of the dealer; each bid must outrank the last; passing puts you out of the
        auction. Three passes after a bid ends it; four passes means a redeal by the next dealer.
        Order: Rik, Rik 9–12, Piek, Misère, Abondance, Open misère, Solo slim.
        <H>Troela</H>
        Three aces in one hand must be announced before bidding and overrides the auction. The
        fourth-ace holder is the silent partner; trump is the suit of the very first card led;
        the pair needs 8 tricks. All four aces: play alone against three, 8 tricks.
        <H>Contracts</H>
        Rik (8) / Rik 9–12: bidder names trump and calls a non-trump ace they don't hold — its
        holder is their secret partner (a king if they hold all three outside aces).
        Piek: alone, no trump, exactly 1 trick. Misère: alone, no trump, 0 tricks.
        Abondance: alone, own trump, 9 tricks. Open misère: 0 tricks, hand faced after trick 1.
        Solo slim: alone, own trump, all 13.
        <H>Play</H>
        Left of dealer leads; trick winner leads next. Follow suit if you can; if void, play
        anything — trumping is never forced. Highest trump wins, else highest card of the led
        suit. Hands end early once the result can no longer change.
        <H>Scoring (zero-sum)</H>
        Rik & troela: 1 point per trick above 7, each opponent paying each partner (partners pay
        when down). Piek 3, Misère 5, Abondance 4 (+1 per overtrick), Open misère 8, Solo slim 15
        — each from every opponent, paid out when the contract fails.
      </div>
    </Modal>
  );
}

function Curtain({ name, onReady }) {
  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-emerald-950">
      <div className="text-2xl font-bold">Pass the device to {name}</div>
      <div className="text-emerald-300">No peeking at other hands.</div>
      <button type="button" onClick={onReady}
        className="rounded-xl bg-amber-500 text-emerald-950 font-bold px-6 py-3 text-lg hover:bg-amber-400">
        I'm {name} — show my cards
      </button>
    </div>
  );
}

function StartScreen({ onStart }) {
  const [mode, setMode] = useState("solo");
  const [count, setCount] = useState(2);
  const [names, setNames] = useState(["Player 1", "Player 2", "Player 3", "Player 4"]);
  const [aiSkill, setAiSkill] = useState("sharp");
  const humanNames = mode === "solo" ? [names[0] || "You"] : names.slice(0, count).map((n, i) => n || "Player " + (i + 1));
  return (
    <div className="w-full h-screen flex items-center justify-center bg-emerald-900 text-emerald-50 p-4 overflow-y-auto"
      style={{ height: "100dvh" }}>
      <div className="max-w-md w-full rounded-2xl bg-emerald-950 border border-emerald-700 p-6 shadow-2xl">
        <div className="text-3xl font-bold mb-1">Rikken</div>
        <div className="text-emerald-300 mb-5 text-sm">Dutch trick-taking. Four seats, one deck, no mercy.</div>

        <div className="mb-4 flex gap-2">
          {[["solo", "Solo vs 3 AI"], ["hotseat", "Hot seat"]].map(([m, label]) => (
            <button key={m} type="button" onClick={() => setMode(m)}
              className={"flex-1 rounded-xl py-2.5 font-semibold border " +
                (mode === m ? "bg-amber-500 text-emerald-950 border-amber-500"
                            : "bg-emerald-900 border-emerald-700 hover:bg-emerald-800")}>
              {label}
            </button>
          ))}
        </div>

        {mode === "hotseat" && (
          <div className="mb-4">
            <div className="text-sm text-emerald-300 mb-1.5">Humans at the table (AI fills the rest)</div>
            <div className="flex gap-2 mb-3">
              {[2, 3, 4].map((n) => (
                <button key={n} type="button" onClick={() => setCount(n)}
                  className={"flex-1 rounded-lg py-1.5 font-semibold border " +
                    (count === n ? "bg-amber-500 text-emerald-950 border-amber-500"
                                 : "bg-emerald-900 border-emerald-700 hover:bg-emerald-800")}>
                  {n}
                </button>
              ))}
            </div>
            {Array.from({ length: count }, (_, i) => (
              <input key={i} value={names[i]}
                onChange={(e) => setNames(names.map((n, j) => (j === i ? e.target.value : n)))}
                className="w-full mb-1.5 rounded-lg bg-emerald-900 border border-emerald-700 px-3 py-1.5 text-sm
                           focus:outline-none focus:border-amber-400"
                maxLength={16} placeholder={"Player " + (i + 1)} />
            ))}
          </div>
        )}
        {mode === "solo" && (
          <input value={names[0]}
            onChange={(e) => setNames([e.target.value, ...names.slice(1)])}
            className="w-full mb-4 rounded-lg bg-emerald-900 border border-emerald-700 px-3 py-1.5 text-sm
                       focus:outline-none focus:border-amber-400"
            maxLength={16} placeholder="Your name" />
        )}

        <div className="mb-5">
          <div className="text-sm text-emerald-300 mb-1.5">AI skill</div>
          <div className="flex gap-2">
            {[["casual", "Casual"], ["sharp", "Sharp"]].map(([s, label]) => (
              <button key={s} type="button" onClick={() => setAiSkill(s)}
                className={"flex-1 rounded-lg py-1.5 font-semibold border " +
                  (aiSkill === s ? "bg-amber-500 text-emerald-950 border-amber-500"
                                 : "bg-emerald-900 border-emerald-700 hover:bg-emerald-800")}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <button type="button" onClick={() => onStart({ mode, humanNames, aiSkill })}
          className="w-full rounded-xl bg-amber-500 text-emerald-950 font-bold py-3 text-lg hover:bg-amber-400">
          Deal the cards
        </button>
      </div>
    </div>
  );
}

/* ============================ MAIN =================================== */

export default function Rikken() {
  const [g, setG] = useState(null);
  const [showRules, setShowRules] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const mobile = useIsMobile();

  // Single driver: zero-length phase hops, AI turns, and the trick pause.
  useEffect(() => {
    if (!g || g.screen !== "game") return;
    if (g.phase === "play0") { setG(startPlay); return; }
    let t;
    if (g.phase === "trickPause") {
      t = setTimeout(() => setG((x) => (x.phase === "trickPause" ? sweepTrick(x) : x)),
        RULES.timings.trickSweepMs);
    } else {
      const actor = actorSeat(g);
      if (actor != null && !g.humans.includes(actor))
        t = setTimeout(() => setG(aiAct), RULES.timings.aiThinkMs);
    }
    return () => clearTimeout(t);
  }, [g]);

  if (!g) {
    return (
      <>
        <StartScreen onStart={(cfg) => setG(newGame(cfg))} />
      </>
    );
  }

  const actor = actorSeat(g);
  const humanActing = actor != null && g.humans.includes(actor);
  // Hot seat: block the table until the right human confirms the handoff.
  const needCurtain = g.mode === "hotseat" && humanActing && g.revealedSeat !== actor;
  const viewSeat = g.mode === "solo" ? 0 : g.revealedSeat;
  const baseSeat = viewSeat == null ? 0 : viewSeat;
  const myTurnToPlay = !needCurtain && humanActing && g.phase === "play" && actor === viewSeat;
  const onPlay = (card) => setG((x) => playCard(x, actorSeat(x), card));

  const relSeat = (rel) => (baseSeat + rel) % 4;

  return (
    // h-screen is the fallback; 100dvh tracks mobile browser chrome so the
    // fan is never hidden behind the URL bar.
    <div
      className={"relative w-full h-screen flex bg-emerald-900 text-emerald-50 font-sans overflow-hidden " +
        (mobile ? "flex-col" : "min-h-[600px]")}
      style={{ height: "100dvh" }}
    >
      {mobile && <MobileTopBar g={g} onPanel={() => setPanelOpen(true)} />}
      <div className="relative flex-1 flex flex-col min-w-0">
        {g.contract && g.contract.key === "troela" && g.contract.trump == null && (
          <div className="absolute top-0 inset-x-0 z-10 bg-amber-500/90 text-emerald-950 text-center text-sm font-semibold py-1">
            {g.names[g.contract.declarer]} announced troela! The first card led sets trump.
          </div>
        )}

        {/* opponents (relative to the viewing seat) */}
        <OpponentSeat g={g} seat={relSeat(1)} pos="left" mobile={mobile} />
        <OpponentSeat g={g} seat={relSeat(2)} pos="top" mobile={mobile} />
        <OpponentSeat g={g} seat={relSeat(3)} pos="right" mobile={mobile} />
        <TrickArea g={g} baseSeat={baseSeat} />

        {/* bottom: the viewing player's own seat */}
        <div className="mt-auto relative z-10">
          {!needCurtain && humanActing && g.phase === "bidding" && actor === viewSeat && (
            <BidPanel g={g} seat={actor}
              onBid={(key) => setG((x) => applyBid(x, actorSeat(x), key, null))} />
          )}
          <div className="flex justify-center mb-1">
            {viewSeat != null && <SeatBadge g={g} seat={viewSeat} />}
          </div>
          {viewSeat != null ? (
            <Fan g={g} seat={viewSeat} active={myTurnToPlay} onPlay={onPlay} mobile={mobile} />
          ) : (
            <div className="text-center pb-6 text-emerald-300 text-sm">
              {g.phase === "redeal" || g.phase === "handEnd" ? "" : "AI players are acting…"}
            </div>
          )}
        </div>

        {/* modals over the table */}
        {needCurtain && (
          <Curtain name={g.names[actor]}
            onReady={() => setG((x) => ({ ...x, revealedSeat: actorSeat(x) }))} />
        )}
        {!needCurtain && humanActing && g.phase === "declareTrump" && (
          <TrumpPicker g={g} onPick={(s) => setG((x) => applyTrumpChoice(x, s))} />
        )}
        {!needCurtain && humanActing && g.phase === "declareCall" && (
          <CallPicker g={g} onPick={(c) => setG((x) => applyCallChoice(x, c))} />
        )}
        {g.phase === "redeal" && (
          <Modal>
            <div className="text-lg font-bold mb-2">Everyone passed</div>
            <div className="text-sm text-emerald-200 mb-4">No contract — redeal, and the deal moves on.</div>
            <button type="button" onClick={() => setG(nextHand)}
              className="w-full rounded-lg bg-amber-500 text-emerald-950 font-bold py-2 hover:bg-amber-400">
              Redeal
            </button>
          </Modal>
        )}
        {g.phase === "handEnd" && <HandEndModal g={g} onNext={() => setG(nextHand)} />}
        {showRules && <RulesModal onClose={() => setShowRules(false)} />}
      </div>

      {!mobile && (
        <SidePanel g={g} onRules={() => setShowRules(true)} onNewGame={() => setG(null)} />
      )}
      {mobile && panelOpen && (
        <div className="absolute inset-0 z-[60] flex justify-end">
          <div className="absolute inset-0 bg-black/50" onClick={() => setPanelOpen(false)} />
          <div className="relative h-full">
            <SidePanel
              g={g}
              onRules={() => { setPanelOpen(false); setShowRules(true); }}
              onNewGame={() => { setPanelOpen(false); setG(null); }}
              onClose={() => setPanelOpen(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
