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
// hidden until the called ace appears — except to the partner themself
// (they see the called card in their own hand) and via public troela.
function knownFriends(seat, game) {
  const { contract } = game;
  const friends = new Set([seat]);
  if (!contract) return friends;
  const { declarer, partner, revealed } = contract;
  const isPublic = contract.key === "troela" || revealed;
  if (seat === declarer) {
    if (isPublic && partner != null) friends.add(partner);
    if (contract.key === "troela" && partner != null) friends.add(partner);
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
