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
  // Between hands the cards are gathered trick by trick and shuffled the way
  // real players do it: a couple of sloppy riffles (cards drop in little
  // packets, not one by one) and a cut — NOT a perfect shuffle. Tricks keep
  // suits clumped, so hands run richer: measured vs uniform, average longest
  // suit 5.2 vs 4.9 and 7+ card suits 10% vs 4%. mode "uniform" restores the
  // pure Fisher-Yates shuffle; more riffles / maxChunk 1 = cleaner shuffling.
  shuffle: { mode: "realistic", riffles: 2, maxChunk: 3 },
  // House rule: the first time the called card's suit is played, its holder
  // must play the called card — following to a lead of that suit, or leading
  // the suit themselves, the card must be the called one. (Discarding cards
  // of that suit on another lead stays free — simplest reading.) Applies to
  // the troela fourth ace too, since it works like a called card here.
  mustPlayCalledOnFirstLead: true,
  troela: {
    trumpFromFirstLead: true, // fourth ace: trump is the suit of the very first card led
  },
  // Contracts in ascending auction rank. 'pass' is implicit below all.
  // trump: 'named' (bidder names it) | 'fixed' (fixedTrump applies) |
  //        'lead' (suit of the first card led) | 'none'.
  // alone: plays without partner.
  // perTrick: rik-style scoring (1/trick above rikBase, undertricks on fail).
  // value: flat payment from each opponent. overtrick: bonus per trick > target.
  contracts: [
    { key: "rik",         label: "Rik",         alone: false, trump: "named", target: 8,  perTrick: true },
    // Rik beter: overcalls a plain rik by committing to hearts as trump.
    { key: "rik_beter",   label: "Rik beter",   alone: false, trump: "fixed", fixedTrump: "H", target: 8, perTrick: true },
    // Fourth ace (troela). House rule: an OPTIONAL bid, not a forced
    // announcement — only biddable holding three aces (four: play it alone).
    // The holder of the missing ace is the silent partner. The classic rule
    // is silent on its auction rank, so it slots just above rik beter: same
    // 8-trick target from a visibly stronger hand.
    { key: "troela",      label: "Fourth ace",  alone: false, trump: "lead",  target: 8,  perTrick: true },
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

// One sloppy human riffle: split near the middle, then alternate drops from
// each half — in little packets of 1..maxChunk cards, the way thumbs actually
// release them. Chunky drops are what keep same-suit trick clumps alive.
function riffle(deck, rng) {
  const cut = 20 + Math.floor(rng() * 13);
  const a = deck.slice(0, cut), b = deck.slice(cut);
  const out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    const left = a.length - i, right = b.length - j;
    const fromA = rng() * (left + right) < left;
    const chunk = 1 + Math.floor(rng() * RULES.shuffle.maxChunk);
    if (fromA) for (let k = 0; k < chunk && i < a.length; k++) out.push(a[i++]);
    else for (let k = 0; k < chunk && j < b.length; k++) out.push(b[j++]);
  }
  return out;
}

// A casual human shuffle: RULES.shuffle.riffles riffles and one cut. With a
// trick-clumped deck this leaves plenty of suit runs for the 4-4-5 deal.
function humanShuffle(deck, rng = Math.random) {
  let d = deck.slice();
  for (let k = 0; k < RULES.shuffle.riffles; k++) d = riffle(d, rng);
  const cut = 5 + Math.floor(rng() * (d.length - 10));
  return [...d.slice(cut), ...d.slice(0, cut)];
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

// A won Fourth-ace bid: partner and called card are forced by the deal —
// the holder of the missing ace partners the bidder (four aces in the
// bidder's own hand: alone against three).
function troelaSetup(hands, declarer) {
  if (hands[declarer].filter((c) => c.r === 14).length === 4)
    return { partner: null, called: null, soloTroela: true };
  const partner = hands.findIndex((h, s) => s !== declarer && h.some((c) => c.r === 14));
  return { partner, called: hands[partner].find((c) => c.r === 14), soloTroela: false };
}

const BID_ORDER = ["pass", ...RULES.contracts.map((c) => c.key)];
const bidRank = (key) => BID_ORDER.indexOf(key);
const contractDef = (key) => RULES.contracts.find((c) => c.key === key);

// Bids that outrank the current highest ('pass' is always available).
// Fourth ace (troela) additionally requires three aces in the bidder's hand.
function legalBids(currentHighKey, hand) {
  const min = currentHighKey ? bidRank(currentHighKey) : 0;
  const aces = hand ? hand.filter((c) => c.r === 14).length : 0;
  return BID_ORDER.filter((k) =>
    k === "pass" || (bidRank(k) > min && (k !== "troela" || aces >= 3)));
}

// Follow suit if you can; otherwise anything (RULES.mustTrump toggles
// compulsory trumping for variants — off in this ruleset). `contract` is
// optional and only used for the called-card house rule below.
function legalMoves(hand, trick, trump, contract) {
  let base;
  if (trick.length === 0) base = hand.slice();
  else {
    const led = trick[0].card.s;
    const follow = hand.filter((c) => c.s === led);
    if (follow.length) base = follow;
    else if (RULES.mustTrump && trump && hand.some((c) => c.s === trump))
      base = hand.filter((c) => c.s === trump);
    else base = hand.slice();
  }
  // House rule (RULES.mustPlayCalledOnFirstLead): the first time the called
  // suit is played, the holder must play the called card. No history needed:
  // while the partnership is unrevealed that suit cannot have been led in an
  // earlier trick — the obligation would already have extracted the card.
  if (RULES.mustPlayCalledOnFirstLead && contract && contract.called && !contract.revealed &&
      hand.some((c) => c.id === contract.called.id)) {
    const cs = contract.called.s, cid = contract.called.id;
    if (trick.length > 0 && trick[0].card.s === cs)
      return base.filter((c) => c.id === cid); // must follow with the called card
    if (trick.length === 0)
      return base.filter((c) => c.s !== cs || c.id === cid); // a lead of that suit must be it
  }
  return base;
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
  const legal = legalBids(currentHighKey, hand);
  const lens = SUITS.map((s) => ({ s, cards: suitCards(hand, s) }));
  const aces = hand.filter((c) => c.r === 14).length;
  // Fourth ace: with three aces the partner ace is guaranteed — take it
  // whenever it still outranks the auction (optional by house rule, but
  // there is no sounder use of such a hand at this level of play).
  if (aces >= 3 && legal.includes("troela")) return { key: "troela" };
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
  if (best.cards.length >= 5 && bestHonours >= 1 && strength >= 9 && callable.length > 0) {
    if (legal.includes("rik")) return { key: "rik", trump: best.s, called: callable[0] };
    // Someone already holds rik: with hearts as the long suit, overcall
    // rik beter (hearts trump is forced, so only a hearts hand qualifies).
    if (best.s === "H" && legal.includes("rik_beter"))
      return { key: "rik_beter", trump: "H", called: callableCards(hand, "H")[0] };
  }

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
  const legal = legalMoves(hands[seat], trick, trump, contract);
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

const AI_NAMES = ["Anouk", "Bram", "Sanne", "Daan", "Fleur", "Teun"];

// The table can hold 4-6 PLAYERS, but every hand is played by exactly 4
// (engine seats 0-3). Standard sit-outs: the dealer (5 players), plus the
// player opposite the dealer (6 players). `g.active[seat]` maps engine seat
// to player index; `g.dealer` is a player index.
function sittersFor(dealerP, nPlayers) {
  if (nPlayers === 5) return [dealerP];
  if (nPlayers === 6) return [dealerP, (dealerP + 3) % 6];
  return [];
}
const seatName = (g, seat) => g.names[g.active[seat]];
const seatIsHuman = (g, seat) => g.humans.includes(g.active[seat]);

function newGame({ mode, humanNames, aiSkill, nPlayers = 4 }) {
  const humans = humanNames.map((_, i) => i);
  const names = Array.from({ length: nPlayers }, (_, i) =>
    i < humanNames.length ? humanNames[i] : AI_NAMES[i % AI_NAMES.length] + " (AI)");
  return freshHand({
    screen: "game", mode, humans, names, aiSkill, nPlayers,
    scores: Array(nPlayers).fill(0), handNo: 1, dealer: 0,
    revealedSeat: null,
  });
}

function freshHand(g) {
  // Seat the active four. With 4 players seats ARE player indices and the
  // dealer sits at the table; with 5-6 the sitters skip the hand and the
  // active seats run clockwise from the dealer's left (dealer seat = 3).
  const nPlayers = g.nPlayers || 4;
  const sitters = sittersFor(g.dealer, nPlayers);
  let active, dealerSeat;
  if (nPlayers === 4) { active = [0, 1, 2, 3]; dealerSeat = g.dealer; }
  else {
    active = [];
    for (let k = 1; k <= nPlayers; k++) {
      const p = (g.dealer + k) % nPlayers;
      if (!sitters.includes(p)) active.push(p);
    }
    dealerSeat = 3; // virtual: active[0] is left of the dealer, so deal from 3
  }
  // Realistic mode reshuffles LAST hand's gathered deck (tricks + thrown-in
  // hands, still suit-clumped); the first hand riffles a fresh pack.
  const realistic = RULES.shuffle.mode === "realistic";
  const source = realistic && g.nextDeck && g.nextDeck.length === 52 ? g.nextDeck : makeDeck();
  const deck = realistic ? humanShuffle(source) : shuffle(makeDeck());
  const hands = deal(deck, dealerSeat).map(sortHand);
  const mySeat = g.mode === "solo" ? active.indexOf(g.humans[0]) : -1;
  const base = {
    ...g, nPlayers, active, sitters, dealerSeat, hands,
    trick: [], tricksBySeat: [0, 0, 0, 0], playedIds: new Set(),
    trickNo: 0, lastResult: null, openHand: null, high: null,
    wonTricks: [], nextDeck: null,
    passed: [false, false, false, false], bidLog: [],
    leader: (dealerSeat + 1) % 4, turn: (dealerSeat + 1) % 4,
    // Solo: sit at your seat (or spectate when sitting out). Hot seat: hide
    // the fan again until the next actor confirms the handoff.
    revealedSeat: g.mode === "solo" ? (mySeat >= 0 ? mySeat : null)
      : g.mode === "hotseat" ? null : g.revealedSeat,
  };
  return { ...base, phase: "bidding", contract: null, bidTurn: (dealerSeat + 1) % 4 };
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
    const g2 = { ...g, passed, high, bidLog, contract };
    if (high.key === "troela") {
      // Fourth ace: partner and called card come straight from the deal;
      // trump waits for the first card led. The missing-ace holder stays
      // silent until that ace hits the table (it works like a called card).
      const st = troelaSetup(g.hands, high.seat);
      return { ...g2, contract: { ...contract, ...st, revealed: st.soloTroela }, phase: "play0" };
    }
    if (def.trump === "named") return { ...g2, phase: "declareTrump" };
    if (def.trump === "fixed") return applyTrumpChoice(g2, def.fixedTrump); // rik beter: hearts
    return { ...g2, phase: "play0" };
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
    leader: (g.dealerSeat + 1) % 4, turn: (g.dealerSeat + 1) % 4 };
}

function playCard(g, seat, card) {
  if (g.phase !== "play" || g.turn !== seat) return g;
  if (!legalMoves(g.hands[seat], g.trick, g.contract.trump, g.contract).some((c) => c.id === card.id)) return g;
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
  const g2 = { ...g, tricksBySeat, trickNo, openHand, trick: [], leader: winner, turn: winner, phase: "play",
    wonTricks: [...g.wonTricks, g.trick.map((p) => p.card)] };
  const early = checkEarlyEnd(g.contract.key, declTricks, trickNo);
  if (early || trickNo === 13) return finishHand(g2, early);
  return g2;
}

function finishHand(g, early) {
  const c = g.contract;
  const res = scoreHand(c.key, c.declarer, c.partner, g.tricksBySeat, c.soloTroela);
  return { ...g, phase: "handEnd",
    scores: g.scores.map((s, p) => {
      const k = g.active.indexOf(p);
      return k < 0 ? s : s + res.deltas[k]; // sitters neither pay nor receive
    }),
    contract: { ...c, revealed: true },
    // Gather the deck as it sits on the table: completed tricks in the order
    // they were won, then any uncounted hands tossed in (early hand end).
    nextDeck: [...g.wonTricks.flat(), ...g.hands.flat()],
    lastResult: { ...res, early: !!early } };
}

function nextHand(g) {
  // After an all-pass redeal the four (suit-sorted!) hands go straight back
  // onto the pile — the classic reason a redeal produces wilder hands.
  const nextDeck = g.phase === "redeal" ? g.hands.flat() : g.nextDeck;
  return freshHand({ ...g, nextDeck, dealer: (g.dealer + 1) % g.nPlayers, handNo: g.handNo + 1 });
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
  if (actor == null || seatIsHuman(g, actor)) return g;
  if (g.phase === "bidding") {
    const bid = aiChooseBid(g.hands[actor], g.high ? g.high.key : null);
    return applyBid(g, actor, bid.key, bid);
  }
  if (g.phase === "declareTrump") return applyTrumpChoice(g, g.high.trump);
  if (g.phase === "declareCall") return applyCallChoice(g, g.high.called);
  if (g.phase === "play") return playCard(g, actor, aiChooseCard(actor, g));
  return g;
}
/* ---------------- Online play (issue #3) — pure parts ---------------- */

// What a guest at engine seat `seat` is allowed to know. Other hands become
// anonymous card backs (except an open-misère hand and everything at hand
// end); the hidden partner seat is stripped — the called card itself is
// public, exactly like at a real table.
function redactFor(g, seat) {
  const show = (s) => s === seat || g.openHand === s || g.phase === "handEnd";
  const contract = g.contract && g.contract.partner != null && !g.contract.revealed
    ? { ...g.contract, partner: null, partnerHidden: true }
    : g.contract;
  return { ...g,
    mode: "online-guest", humans: [g.active[seat]], revealedSeat: seat,
    hands: g.hands.map((h, s) => (show(s) ? h : h.map((c, i) => ({ s: "X", r: 0, id: "x" + s + "-" + i })))),
    contract,
    playedIds: [], wonTricks: [], nextDeck: null,
  };
}

// Host-side gate for guest messages: every action is re-validated against
// the authoritative state, so a hacked client still can't play out of turn
// or against the rules.
function applyRemoteAction(x, seat, msg) {
  if (!x || x.screen !== "game") return x;
  if (msg.kind === "bid" && x.phase === "bidding" && x.bidTurn === seat &&
      legalBids(x.high ? x.high.key : null, x.hands[seat]).includes(msg.key))
    return applyBid(x, seat, msg.key, null);
  if (msg.kind === "trump" && x.phase === "declareTrump" && x.contract.declarer === seat &&
      SUITS.includes(msg.suit))
    return applyTrumpChoice(x, msg.suit);
  if (msg.kind === "call" && x.phase === "declareCall" && x.contract.declarer === seat) {
    const card = callableCards(x.hands[seat], x.contract.trump).find((c) => c.id === msg.id);
    if (card) return applyCallChoice(x, card);
  }
  if (msg.kind === "card" && x.phase === "play" && x.turn === seat) {
    const card = x.hands[seat].find((c) => c.id === msg.id);
    if (card) return playCard(x, seat, card); // playCard re-checks legality
  }
  if (msg.kind === "next" && (x.phase === "handEnd" || x.phase === "redeal"))
    return nextHand(x);
  return x;
}
// ==== FLOW END ====

/* ---------------- Online play — WebRTC transport (no server) --------- */
// GitHub Pages is static, so signaling is manual: the host creates an invite
// code, the guest answers with a reply code, and from then on the game runs
// peer-to-peer over a WebRTC data channel. STUN only (no relay): most home
// networks work; symmetric-NAT pairs may not.

const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function waitIce(pc) {
  return new Promise((res) => {
    if (pc.iceGatheringState === "complete") return res();
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") res();
    });
    setTimeout(res, 3000); // good enough: host candidates are already in
  });
}
const encodeSignal = (desc) => btoa(JSON.stringify(desc));
const decodeSignal = (code) => JSON.parse(atob(code.trim()));

async function createInvite() {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const ch = pc.createDataChannel("rikken");
  await pc.setLocalDescription(await pc.createOffer());
  await waitIce(pc);
  return { pc, ch, code: encodeSignal(pc.localDescription) };
}
async function answerInvite(code) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const chP = new Promise((res) => { pc.ondatachannel = (e) => res(e.channel); });
  await pc.setRemoteDescription(decodeSignal(code));
  await pc.setLocalDescription(await pc.createAnswer());
  await waitIce(pc);
  return { pc, chP, code: encodeSignal(pc.localDescription) };
}

/* ========================== UI COMPONENTS =========================== */

const suitColor = (s) => (s === "H" || s === "D" ? "text-red-600" : "text-slate-900");

// Keyboard shortcuts (issue #7). Fixed per contract so keys never shift:
// digits 1-9 and 0 for the first ten bids, then the first free letter of
// the label (P is reserved for pass). Suits use 1-4 in display order.
const BID_KEYS = (() => {
  const map = { pass: "P" };
  const used = new Set(["P"]);
  RULES.contracts.forEach((c, i) => {
    let k = i < 9 ? String(i + 1) : i === 9 ? "0" : null;
    if (!k) for (const ch of c.label.toUpperCase()) if (/[A-Z]/.test(ch) && !used.has(ch)) { k = ch; break; }
    used.add(k);
    map[c.key] = k;
  });
  return map;
})();
const KEY_TO_BID = Object.fromEntries(Object.entries(BID_KEYS).map(([k, v]) => [v, k]));

function Kbd({ k, dark }) {
  return (
    <kbd className={"ml-1.5 hidden rounded border px-1 font-mono text-[10px] leading-4 align-middle sm:inline-block " +
      (dark ? "border-emerald-600 bg-emerald-950/60 text-emerald-200" : "border-emerald-950/30 bg-emerald-950/10 text-emerald-950/80")}>
      {k}
    </kbd>
  );
}

// Issue #8: one loud line across the top while the very first trick is on
// the table, so nobody misses who won the auction and what they play.
function announceText(g) {
  const c = g.contract;
  if (!c) return null;
  if (c.key === "troela" && c.trump == null)
    return seatName(g, c.declarer) + " plays Fourth ace — the first card led sets trump!";
  if ((g.phase === "play" || g.phase === "trickPause") && g.trickNo === 0) {
    const def = contractDef(c.key);
    let s = seatName(g, c.declarer) + " plays " + def.label;
    if (c.trump) s += " in " + SUIT_NAME[c.trump].toLowerCase();
    if (c.called) s += " — partner: whoever holds " + RANK_GLYPH[c.called.r] + SUIT_GLYPH[c.called.s];
    else if (def.alone || c.soloTroela) s += ", alone";
    return s;
  }
  return null;
}

function CardFace({ card, size = "md", onClick, dimmed, highlight, selected }) {
  const dims = size === "sm"
    ? "w-8 h-11 text-[10px] p-0.5 rounded"
    : "w-12 h-[4.4rem] sm:w-14 sm:h-20 text-xs sm:text-sm p-1 rounded-lg";
  return (
    <button
      type="button"
      data-card
      onClick={onClick}
      disabled={!onClick}
      className={
        "relative border border-slate-300/90 bg-gradient-to-br from-white via-white to-slate-200 " +
        "shadow-[0_1px_2px_rgba(0,0,0,.35),0_4px_10px_rgba(0,0,0,.18)] " +
        "flex flex-col justify-between select-none shrink-0 " +
        dims + " " + suitColor(card.s) +
        (dimmed ? " opacity-40" : "") +
        (highlight ? " ring-4 ring-amber-300" : "") +
        (selected ? " ring-4 ring-amber-300 -translate-y-2" : "") +
        (onClick ? " cursor-pointer hover:-translate-y-2 focus:-translate-y-2 active:-translate-y-2 transition-transform" : " cursor-default")
      }
    >
      <div className="leading-none font-bold text-left">
        {RANK_GLYPH[card.r]}
        <div>{SUIT_GLYPH[card.s]}</div>
      </div>
      <div className={"text-center leading-none drop-shadow-sm " + (size === "sm" ? "text-xs" : "text-xl sm:text-2xl")}>
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
      className="w-7 h-10 rounded-md border border-indigo-950 bg-gradient-to-br from-indigo-700 to-blue-950 shadow ring-1 ring-inset ring-white/25 shrink-0"
      style={{ backgroundImage: "repeating-linear-gradient(45deg, rgba(255,255,255,.16) 0 2px, transparent 2px 6px)" }}
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
      {g.active[seat] === g.dealer && <span title="Dealer" className="rounded-full bg-white text-emerald-900 font-bold px-1 leading-4">D</span>}
      <span className="whitespace-nowrap">{seatName(g, seat)}</span>
      {isDecl && <span title="Declarer">★</span>}
      {isPartner && <span title="Partner">☆</span>}
      <span className="opacity-80">· {g.tricksBySeat[seat]}</span>
    </div>
  );
}

function OpponentSeat({ g, seat, pos, mobile }) {
  const wrap = pos === "top"
    ? (announceText(g) ? "top-8 " : "top-2 ") + "left-1/2 -translate-x-1/2 items-center"
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
  const TILT = ["rotate-1", "-rotate-6", "-rotate-2", "rotate-6"]; // dealt, not placed
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      {/* the table itself: a soft felt oval under the trick */}
      <div className="absolute h-[62%] max-h-[20rem] w-[76%] max-w-[34rem] rounded-[50%] border border-white/10 bg-black/10 shadow-[inset_0_12px_45px_rgba(0,0,0,.35)]" />
      <div className="relative w-52 h-44 sm:w-60 sm:h-48">
        {g.trick.map((p) => {
          const rel = (p.seat - baseSeat + 4) % 4;
          return (
            <div key={p.card.id} className={"absolute " + POS[rel] + " " + TILT[rel]}>
              <CardFace card={p.card} highlight={winner === p.seat} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The player's fan. Overlap is measured, not fixed (issue #6): the cards
// squeeze exactly enough to fit the row's width, and only if even the
// maximum squeeze is not enough does the row scroll — it never spills.
function Fan({ g, seat, active, onPlay, mobile, selId }) {
  const wrapRef = React.useRef(null);
  const n = g.hands[seat].length;
  const [overlap, setOverlap] = useState(mobile ? 24 : 12);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof window === "undefined") return;
    const measure = () => {
      const card = el.querySelector("[data-card]");
      if (!card || n <= 1) return;
      const cw = card.getBoundingClientRect().width;
      const room = el.clientWidth - 20; // horizontal padding
      const needed = Math.ceil((n * cw - room) / (n - 1));
      const cozy = mobile ? 24 : 12;    // aesthetic overlap when there is room
      const max = cw - 18;              // always keep the corner index visible
      setOverlap(Math.min(max, Math.max(cozy, needed)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [n, mobile]);
  const legal = active ? legalMoves(g.hands[seat], g.trick, g.contract ? g.contract.trump : null, g.contract) : [];
  const legalIds = new Set(legal.map((c) => c.id));
  return (
    <div ref={wrapRef} className="overflow-x-auto overflow-y-visible">
      <div className="mx-auto flex w-max px-2.5 pb-2 pt-3">
        {g.hands[seat].map((c, i) => {
          const ok = active && legalIds.has(c.id);
          return (
            <div key={c.id} style={i ? { marginLeft: -overlap + "px" } : undefined}>
              <CardFace
                card={c}
                dimmed={active && !ok}
                selected={ok && selId === c.id}
                onClick={ok ? () => onPlay(c) : undefined}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BidPanel({ g, seat, onBid, mobile }) {
  const legal = new Set(legalBids(g.high ? g.high.key : null, g.hands[seat]));
  return (
    <div className="mx-auto mb-2 max-w-2xl rounded-xl bg-emerald-950/85 p-3 text-center shadow-lg ring-1 ring-emerald-700/50">
      <div className="mb-2 text-sm text-emerald-100">
        {seatName(g, seat)}, your bid{g.high ? " — to beat: " + contractDef(g.high.key).label +
          " (" + seatName(g, g.high.seat) + ")" : ""}
      </div>
      <div className="flex flex-wrap justify-center gap-1.5">
        <button type="button" onClick={() => onBid("pass")}
          className="rounded-lg bg-slate-500 hover:bg-slate-400 px-3 py-1.5 text-sm font-semibold shadow">
          Pass{!mobile && <Kbd k={BID_KEYS.pass} dark />}
        </button>
        {RULES.contracts.map((c) => (
          <button
            key={c.key}
            type="button"
            disabled={!legal.has(c.key)}
            onClick={() => onBid(c.key)}
            className="rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-semibold text-emerald-950 shadow
                       hover:bg-amber-400 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {c.label}{!mobile && <Kbd k={BID_KEYS[c.key]} />}
          </button>
        ))}
      </div>
    </div>
  );
}

function Modal({ children, wide }) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-[2px] p-4">
      <div className={"rounded-2xl bg-emerald-950 border border-emerald-700 p-5 text-emerald-50 shadow-2xl " +
        (wide ? "max-w-2xl w-full max-h-[85vh] overflow-y-auto" : "max-w-md w-full")}>
        {children}
      </div>
    </div>
  );
}

function TrumpPicker({ g, onPick, mobile }) {
  return (
    <Modal>
      <div className="mb-3 font-semibold">{seatName(g, g.contract.declarer)}: name your trump suit
        for {contractDef(g.contract.key).label}</div>
      <div className="flex justify-center gap-2">
        {SUITS.map((s, i) => (
          <div key={s} className="flex flex-col items-center gap-1">
            <button type="button" onClick={() => onPick(s)}
              className={"w-16 h-16 rounded-xl bg-white text-4xl shadow hover:ring-4 ring-amber-300 " +
                (s === "H" || s === "D" ? "text-red-600" : "text-slate-900")}>
              {SUIT_GLYPH[s]}
            </button>
            {!mobile && <kbd className="rounded border border-emerald-600 bg-emerald-950/60 px-1 font-mono text-[10px] text-emerald-200">{i + 1}</kbd>}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function CallPicker({ g, onPick, mobile }) {
  const opts = callableCards(g.hands[g.contract.declarer], g.contract.trump);
  return (
    <Modal>
      <div className="mb-1 font-semibold">Call a card — its holder becomes your secret partner</div>
      <div className="mb-3 text-sm text-emerald-200">
        {opts[0].r === 14 ? "An ace of a non-trump suit you do not hold."
          : "You hold every callable ace, so you call a " + RANK_GLYPH[opts[0].r] + " instead."}
      </div>
      <div className="flex justify-center gap-2">
        {opts.map((c, i) => (
          <div key={c.id} className="flex flex-col items-center gap-1">
            <CardFace card={c} onClick={() => onPick(c)} />
            {!mobile && <kbd className="rounded border border-emerald-600 bg-emerald-950/60 px-1 font-mono text-[10px] text-emerald-200">{i + 1}</kbd>}
          </div>
        ))}
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
  const showSides = c && (c.revealed || (c.partner == null && !c.partnerHidden));
  const side = c ? (c.partner == null ? [c.declarer] : [c.declarer, c.partner]) : [];
  const declTricks = side.reduce((n, s) => n + g.tricksBySeat[s], 0);
  return (
    <div className="z-20 flex shrink-0 items-center justify-between gap-2 border-b border-emerald-800 bg-emerald-950/95 px-2.5 py-1.5 text-xs">
      <div className="truncate">
        <span className="font-bold">Hand {g.handNo}</span>
        {c
          ? <span> · {def.label} ({seatName(g, c.declarer)}){c.trump ? " · Trump " + SUIT_GLYPH[c.trump] : def.trump === "none" ? " · no trump" : ""}{showSides ? " · " + declTricks + "/" + def.target : ""}</span>
          : <span> · bidding…</span>}
        {c && c.called && (
          <span className={"ml-1.5 rounded bg-white px-1 py-0.5 font-bold " + suitColor(c.called.s)}>
            {RANK_GLYPH[c.called.r]}{SUIT_GLYPH[c.called.s]}
          </span>
        )}
      </div>
      <button type="button" onClick={onPanel}
        className="shrink-0 rounded-lg bg-emerald-700 px-2.5 py-1 font-semibold hover:bg-emerald-600">
        Scores & rules
      </button>
    </div>
  );
}

// Issues #4 + #8: contract, trump, and partner readable at a glance —
// labelled ("Trump", not the contract name), big, with the auction winner.
function ContractChips({ g }) {
  const c = g.contract;
  if (!c || !["play", "trickPause", "declareCall"].includes(g.phase)) return null;
  const def = contractDef(c.key);
  const bannerUp = !!announceText(g); // stay below the announcement banner
  return (
    <div className={"absolute left-2 z-10 " + (bannerUp ? "top-9" : "top-2")}>
      <div className="rounded-xl border border-emerald-700/60 bg-emerald-950/90 px-3.5 py-2.5 shadow-lg">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">Contract</div>
        <div className="text-base font-bold leading-tight">
          {def.label} <span className="font-normal text-emerald-200">· {seatName(g, c.declarer)}</span>
        </div>
        <div className="mt-2 flex items-center gap-2.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">Trump</span>
          {def.trump === "none" ? (
            <span className="text-sm font-semibold text-emerald-100">none</span>
          ) : c.trump ? (
            <>
              <span className={"grid h-10 w-10 place-items-center rounded-lg bg-white text-3xl leading-none shadow " + suitColor(c.trump)}>
                {SUIT_GLYPH[c.trump]}
              </span>
              <span className="text-sm font-semibold">{SUIT_NAME[c.trump]}</span>
            </>
          ) : (
            <span className="text-sm font-bold text-amber-300">first card led</span>
          )}
        </div>
        {c.called && (
          <div className="mt-2 flex items-center gap-2.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">Partner</span>
            <span className={"rounded bg-white px-1.5 py-0.5 text-sm font-bold shadow " + suitColor(c.called.s)}>
              {RANK_GLYPH[c.called.r]}{SUIT_GLYPH[c.called.s]}
            </span>
            <span className="text-sm">{c.revealed && c.partner != null ? seatName(g, c.partner) : "hidden"}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function SidePanel({ g, onRules, onNewGame, onClose }) {
  const c = g.contract;
  const def = c && contractDef(c.key);
  const showSides = c && (c.revealed || (c.partner == null && !c.partnerHidden));
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
        <Row k="Contract" v={c ? def.label + " — " + seatName(g, c.declarer) : "bidding…"} />
        <Row k="Trump" v={c ? (def.trump === "none" ? "none" :
          c.trump ? SUIT_GLYPH[c.trump] + " " + SUIT_NAME[c.trump] : "first card led") : "—"} />
        <Row k="Target" v={c ? (def.exact ? "exactly " + def.target : def.target) + " tricks" : "—"} />
        {c && c.called && (
          <Row k="Partner" v={c.revealed && c.partner != null ? seatName(g, c.partner)
            : "holder of " + RANK_GLYPH[c.called.r] + SUIT_GLYPH[c.called.s] + " (hidden)"} />
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
          [0, 1, 2, 3].map((s) => <Row key={s} k={seatName(g, s)} v={g.tricksBySeat[s]} />)
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
            <Row key={i} k={seatName(g, b.seat)} v={b.key === "pass" ? "pass" : contractDef(b.key).label} />
          ))}
        </div>
      )}

      <div className="mt-auto flex flex-col gap-1.5">
        <button type="button" onClick={onRules} className="rounded-lg bg-emerald-700 hover:bg-emerald-600 py-1.5 font-semibold">Rules</button>
        <a href="about.html" className="rounded-lg bg-emerald-800 hover:bg-emerald-700 py-1.5 text-center no-underline text-emerald-50">
          How it works
        </a>
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
        {seatName(g, c.declarer)}{c.partner != null ? " & " + seatName(g, c.partner) : ""} took {r.declTricks}
        {" "}trick{r.declTricks === 1 ? "" : "s"} — needed {def.exact ? "exactly " : ""}{def.target}.
      </div>
      <table className="w-full text-sm mb-4">
        <tbody>
          {g.names.map((n, p) => {
            const k = g.active.indexOf(p);
            const d = k < 0 ? 0 : r.deltas[k];
            return (
              <tr key={p} className="border-t border-emerald-800">
                <td className="py-1">{n}{k < 0 ? " (sat out)" : ""}</td>
                <td className={"py-1 text-right font-mono " + (d > 0 ? "text-emerald-300" : d < 0 ? "text-red-300" : "")}>
                  {d > 0 ? "+" + d : d}
                </td>
                <td className="py-1 text-right font-mono text-emerald-100">{g.scores[p]}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button type="button" onClick={onNext} className="w-full rounded-lg bg-amber-500 text-emerald-950 font-bold py-2 hover:bg-amber-400">
        Deal next hand<Kbd k="Enter" />
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
        Between hands the tricks are gathered and given a few casual riffles and a cut — like a
        real table, not a perfect shuffle — so long suits and voids come up more often.
        <H>Bidding</H>
        Starts left of the dealer; each bid must outrank the last; passing puts you out of the
        auction. Three passes after a bid ends it; four passes means a redeal by the next dealer.
        Order: Rik, Rik beter, Fourth ace, Rik 9–12, Piek, Misère, Abondance, Open misère, Solo slim.
        <H>Fourth ace (troela)</H>
        Holding three aces you may — house rule: may, not must — bid Fourth ace. The holder of
        the missing ace is your silent partner; trump is the suit of the very first card led;
        the pair needs 8 tricks, scored like a rik. With all four aces you play it alone.
        <H>Contracts</H>
        Rik (8) / Rik 9–12: bidder names trump and calls a non-trump ace they don't hold — its
        holder is their secret partner (a king if they hold all three outside aces).
        Rik beter: rik with hearts as trump — the way to outbid a plain rik while still
        playing for 8 tricks; same partner call, same scoring.
        House rule: the first time the called card's suit is played, its holder must play
        the called card — whether following to that suit or leading it themselves.
        Piek: alone, no trump, exactly 1 trick. Misère: alone, no trump, 0 tricks.
        Abondance: alone, own trump, 9 tricks. Open misère: 0 tricks, hand faced after trick 1.
        Solo slim: alone, own trump, all 13.
        <H>Play</H>
        Left of dealer leads; trick winner leads next. Follow suit if you can; if void, play
        anything — trumping is never forced. Highest trump wins, else highest card of the led
        suit. Hands end early once the result can no longer change.
        <H>Scoring (zero-sum)</H>
        Rik & fourth ace: 1 point per trick above 7, each opponent paying each partner (partners
        pay when down). Piek 3, Misère 5, Abondance 4 (+1 per overtrick), Open misère 8, Solo
        slim 15 — each from every opponent, paid out when the contract fails.
        <H>Keyboard shortcuts</H>
        Bidding: <b>P</b> passes, and every bid button shows its key (1–9, 0, O, S). Trump and
        called-card choices: <b>1–4</b>. Playing: <b>←</b>/<b>→</b> pick a card, <b>Enter</b>
        plays it. <b>Enter</b> also confirms hand-end, redeal, and pass-the-device screens.
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
        I'm {name} — show my cards<Kbd k="Enter" />
      </button>
    </div>
  );
}

// Online lobby: host invites up to three guests slot by slot; empty slots
// are filled by AI when the game starts.
function OnlineLobby({ role, myName, aiSkill, onHostLaunch, onGuestJoined, onCancel }) {
  const [slots, setSlots] = useState([null, null, null]); // {status, code, pc, ch, name}
  const [joinCode, setJoinCode] = useState("");
  const [reply, setReply] = useState(null); // guest: {pc, code}
  const [err, setErr] = useState("");
  const patch = (i, s) => setSlots((xs) => xs.map((x, j) => (j === i ? { ...x, ...s } : x)));

  const invite = async (i) => {
    try {
      const { pc, ch, code } = await createInvite();
      setSlots((xs) => xs.map((x, j) => (j === i ? { status: "waiting", code, reply: "", pc, ch, name: null } : x)));
      ch.onopen = () => patch(i, { status: "connected" });
      ch.onmessage = (e) => {
        try { const m = JSON.parse(e.data); if (m.t === "hello") patch(i, { name: m.name }); } catch {}
      };
    } catch (e) { setErr("Could not create invite: " + e.message); }
  };
  const acceptReply = async (i, code) => {
    try { await slots[i].pc.setRemoteDescription(decodeSignal(code)); }
    catch (e) { setErr("Bad reply code: " + e.message); }
  };
  const join = async () => {
    try {
      setErr("");
      const { pc, chP, code } = await answerInvite(joinCode);
      setReply({ pc, code });
      const ch = await chP;
      ch.onopen = () => ch.send(JSON.stringify({ t: "hello", name: myName }));
      onGuestJoined(pc, ch);
    } catch (e) { setErr("Bad invite code: " + e.message); }
  };
  const connected = slots.filter((s) => s && s.status === "connected");

  return (
    <div className="w-full h-screen flex items-center justify-center bg-emerald-900 text-emerald-50 p-4 overflow-y-auto"
      style={{ height: "100dvh" }}>
      <div className="max-w-lg w-full rounded-2xl bg-emerald-950 border border-emerald-700 p-6 shadow-2xl">
        <div className="text-2xl font-bold mb-1">{role === "host" ? "Host an online table" : "Join an online table"}</div>
        <div className="text-emerald-300 text-sm mb-4">
          Peer-to-peer, no server: swap the codes below over any chat app. Empty seats get AI.
        </div>
        {err && <div className="mb-3 rounded-lg bg-red-900/60 px-3 py-2 text-sm">{err}</div>}

        {role === "host" ? (
          <>
            {slots.map((s, i) => (
              <div key={i} className="mb-3 rounded-xl bg-emerald-900/70 p-3 text-sm">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-semibold">Guest {i + 1}</span>
                  <span className="text-emerald-300">
                    {!s ? "empty (AI)" : s.status === "connected" ? "connected: " + (s.name || "…") : "waiting for reply"}
                  </span>
                </div>
                {!s && (
                  <button type="button" onClick={() => invite(i)}
                    className="rounded-lg bg-emerald-700 hover:bg-emerald-600 px-3 py-1.5 font-semibold">
                    Create invite
                  </button>
                )}
                {s && s.status === "waiting" && (
                  <>
                    <div className="mb-1 text-emerald-300">Send this invite code:</div>
                    <textarea readOnly value={s.code} data-t={"invite-" + i} rows={2}
                      onFocus={(e) => e.target.select()}
                      className="w-full mb-2 rounded bg-emerald-950 border border-emerald-700 p-1.5 text-[10px] font-mono" />
                    <div className="mb-1 text-emerald-300">Paste their reply code:</div>
                    <div className="flex gap-2">
                      <input value={s.reply} onChange={(e) => patch(i, { reply: e.target.value })} data-t={"reply-" + i}
                        className="flex-1 rounded bg-emerald-950 border border-emerald-700 px-2 py-1 text-[10px] font-mono" />
                      <button type="button" onClick={() => acceptReply(i, s.reply)}
                        className="rounded-lg bg-amber-500 text-emerald-950 px-3 py-1 font-semibold hover:bg-amber-400">
                        Connect
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
            <button type="button" disabled={connected.length === 0}
              onClick={() => onHostLaunch(connected.map((s) => ({ ch: s.ch, pc: s.pc, name: s.name || "Guest" })))}
              className="w-full rounded-xl bg-amber-500 text-emerald-950 font-bold py-2.5 hover:bg-amber-400 disabled:opacity-40">
              Start game ({connected.length} guest{connected.length === 1 ? "" : "s"} + {3 - connected.length} AI)
            </button>
          </>
        ) : (
          <>
            {!reply ? (
              <>
                <div className="mb-1 text-sm text-emerald-300">Paste the host's invite code:</div>
                <textarea value={joinCode} onChange={(e) => setJoinCode(e.target.value)} rows={3} data-t="join-code"
                  className="w-full mb-2 rounded bg-emerald-950 border border-emerald-700 p-1.5 text-[10px] font-mono" />
                <button type="button" onClick={join} disabled={!joinCode.trim()}
                  className="w-full rounded-xl bg-amber-500 text-emerald-950 font-bold py-2.5 hover:bg-amber-400 disabled:opacity-40">
                  Join
                </button>
              </>
            ) : (
              <>
                <div className="mb-1 text-sm text-emerald-300">Send this reply code to the host, then wait:</div>
                <textarea readOnly value={reply.code} data-t="reply-code" rows={3}
                  onFocus={(e) => e.target.select()}
                  className="w-full mb-2 rounded bg-emerald-950 border border-emerald-700 p-1.5 text-[10px] font-mono" />
                <div className="text-sm text-emerald-300 animate-pulse">Waiting for the host to start…</div>
              </>
            )}
          </>
        )}
        <button type="button"
          onClick={() => {
            for (const s of slots) if (s && s.pc) { try { s.pc.close(); } catch {} }
            if (reply) { try { reply.pc.close(); } catch {} }
            onCancel();
          }}
          className="mt-3 w-full rounded-lg bg-emerald-800 hover:bg-emerald-700 py-1.5 text-sm">
          Back
        </button>
      </div>
    </div>
  );
}

function StartScreen({ onStart, onOnline }) {
  const [mode, setMode] = useState("solo");
  const [size, setSize] = useState(4); // players at the table (4-6)
  const [count, setCount] = useState(2);
  const [names, setNames] = useState(["Player 1", "Player 2", "Player 3", "Player 4", "Player 5", "Player 6"]);
  const [aiSkill, setAiSkill] = useState("sharp");
  const humans = Math.min(count, size);
  const humanNames = mode === "solo" ? [names[0] || "You"] : names.slice(0, humans).map((n, i) => n || "Player " + (i + 1));
  return (
    <div className="w-full h-screen flex items-center justify-center bg-emerald-900 text-emerald-50 p-4 overflow-y-auto"
      style={{ height: "100dvh" }}>
      <div className="max-w-md w-full rounded-2xl bg-emerald-950 border border-emerald-700 p-6 shadow-2xl">
        <div className="flex items-baseline gap-2.5">
          <div className="text-3xl font-bold mb-1">Rikken</div>
          <div className="text-lg tracking-widest">
            <span className="text-emerald-100">♠</span><span className="text-red-400">♥</span>
            <span className="text-emerald-100">♣</span><span className="text-red-400">♦</span>
          </div>
        </div>
        <div className="text-emerald-300 mb-5 text-sm">Dutch trick-taking. Four seats, one deck, no mercy.</div>

        <div className="mb-4 flex gap-2">
          {[["solo", "Solo vs AI"], ["hotseat", "Hot seat"], ["online", "Online"]].map(([m, label]) => (
            <button key={m} type="button" onClick={() => setMode(m)}
              className={"flex-1 rounded-xl py-2.5 font-semibold border " +
                (mode === m ? "bg-amber-500 text-emerald-950 border-amber-500"
                            : "bg-emerald-900 border-emerald-700 hover:bg-emerald-800")}>
              {label}
            </button>
          ))}
        </div>

        {mode !== "online" && (
        <div className="mb-4">
          <div className="text-sm text-emerald-300 mb-1.5">Players at the table (5-6: dealer sits out each hand)</div>
          <div className="flex gap-2">
            {[4, 5, 6].map((n) => (
              <button key={n} type="button" onClick={() => setSize(n)}
                className={"flex-1 rounded-lg py-1.5 font-semibold border " +
                  (size === n ? "bg-amber-500 text-emerald-950 border-amber-500"
                              : "bg-emerald-900 border-emerald-700 hover:bg-emerald-800")}>
                {n}
              </button>
            ))}
          </div>
        </div>
        )}

        {mode === "hotseat" && (
          <div className="mb-4">
            <div className="text-sm text-emerald-300 mb-1.5">Humans at the table (AI fills the rest)</div>
            <div className="flex gap-2 mb-3">
              {[2, 3, 4, 5, 6].filter((n) => n <= size).map((n) => (
                <button key={n} type="button" onClick={() => setCount(n)}
                  className={"flex-1 rounded-lg py-1.5 font-semibold border " +
                    (count === n ? "bg-amber-500 text-emerald-950 border-amber-500"
                                 : "bg-emerald-900 border-emerald-700 hover:bg-emerald-800")}>
                  {n}
                </button>
              ))}
            </div>
            {Array.from({ length: humans }, (_, i) => (
              <input key={i} value={names[i]}
                onChange={(e) => setNames(names.map((n, j) => (j === i ? e.target.value : n)))}
                className="w-full mb-1.5 rounded-lg bg-emerald-900 border border-emerald-700 px-3 py-1.5 text-sm
                           focus:outline-none focus:border-amber-400"
                maxLength={16} placeholder={"Player " + (i + 1)} />
            ))}
          </div>
        )}
        {(mode === "solo" || mode === "online") && (
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

        <div className="mb-4 text-center text-sm">
          <a href="about.html" className="text-emerald-300 hover:text-emerald-100">
            How this game works — rules, the shuffle, the AI &rarr;
          </a>
        </div>

        {mode === "online" ? (
          <div className="flex gap-2">
            {[["host", "Host a table"], ["join", "Join a table"]].map(([r, label]) => (
              <button key={r} type="button"
                onClick={() => onOnline({ role: r, name: names[0] || (r === "host" ? "Host" : "Guest"), aiSkill })}
                className="flex-1 rounded-xl bg-amber-500 text-emerald-950 font-bold py-3 hover:bg-amber-400">
                {label}
              </button>
            ))}
          </div>
        ) : (
          <button type="button" onClick={() => onStart({ mode, humanNames, aiSkill, nPlayers: size })}
            className="w-full rounded-xl bg-amber-500 text-emerald-950 font-bold py-3 text-lg hover:bg-amber-400">
            Deal the cards
          </button>
        )}
      </div>
    </div>
  );
}

/* ============================ MAIN =================================== */

export default function Rikken() {
  const [g, setG] = useState(null);
  const [showRules, setShowRules] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [lobby, setLobby] = useState(null); // {role, name, aiSkill} while in the online lobby
  const [connLost, setConnLost] = useState(false);
  const [selId, setSelId] = useState(null); // keyboard-selected card in the fan
  const mobile = useIsMobile();
  const netRef = React.useRef({ role: null, guests: [], sendHost: null, pcs: [] });

  const isGuest = !!g && g.mode === "online-guest";
  const sendAct = (msg) => {
    try { if (netRef.current.sendHost) netRef.current.sendHost(JSON.stringify({ t: "action", ...msg })); } catch {}
  };
  // One handler per action, shared by clicks and the keyboard layer.
  const onPlay = (card) => (isGuest ? sendAct({ kind: "card", id: card.id })
    : setG((x) => playCard(x, actorSeat(x), card)));
  const doBid = (key) => (isGuest ? sendAct({ kind: "bid", key })
    : setG((x) => applyBid(x, actorSeat(x), key, null)));
  const doTrump = (s) => (isGuest ? sendAct({ kind: "trump", suit: s })
    : setG((x) => applyTrumpChoice(x, s)));
  const doCall = (c) => (isGuest ? sendAct({ kind: "call", id: c.id })
    : setG((x) => applyCallChoice(x, c)));
  const doNext = () => (isGuest ? sendAct({ kind: "next" }) : setG(nextHand));

  const teardownNet = () => {
    const n = netRef.current;
    for (const pc of n.pcs) { try { pc.close(); } catch {} }
    netRef.current = { role: null, guests: [], sendHost: null, pcs: [] };
  };
  const resetAll = () => { teardownNet(); setConnLost(false); setLobby(null); setG(null); };

  // Host: push a per-guest redacted state on every change.
  useEffect(() => {
    const n = netRef.current;
    if (!g || g.mode !== "online-host" || n.role !== "host") return;
    for (const gu of n.guests) {
      if (gu.ch.readyState === "open") {
        try { gu.ch.send(JSON.stringify({ t: "state", g: redactFor(g, gu.seat) })); } catch {}
      }
    }
  }, [g]);

  // Single driver: zero-length phase hops, AI turns, and the trick pause.
  useEffect(() => {
    if (!g || g.screen !== "game" || g.mode === "online-guest") return;
    if (g.phase === "play0") { setG(startPlay); return; }
    let t;
    if (g.phase === "trickPause") {
      t = setTimeout(() => setG((x) => (x.phase === "trickPause" ? sweepTrick(x) : x)),
        RULES.timings.trickSweepMs);
    } else {
      const actor = actorSeat(g);
      if (actor != null && !seatIsHuman(g, actor))
        t = setTimeout(() => setG(aiAct), RULES.timings.aiThinkMs);
    }
    return () => clearTimeout(t);
  }, [g]);

  // Keyboard play (issue #7), part 1: keep a card selected while it is a
  // human's turn, so arrows/Enter always have something to act on.
  useEffect(() => {
    if (!g || g.screen !== "game" || g.phase !== "play") { setSelId(null); return; }
    const a = actorSeat(g);
    const curtain = g.mode === "hotseat" && a != null && seatIsHuman(g, a) && g.revealedSeat !== a;
    if (curtain || a == null || !seatIsHuman(g, a) || a !== g.revealedSeat) { setSelId(null); return; }
    const legal = legalMoves(g.hands[a], g.trick, g.contract ? g.contract.trump : null, g.contract);
    setSelId((s) => (legal.some((c) => c.id === s) ? s : legal.length ? legal[0].id : null));
  }, [g]);

  // Keyboard play, part 2: one window-level dispatcher for every phase.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (!g || g.screen !== "game" || connLost) return;
      const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      const go = (fn) => { e.preventDefault(); fn(); };
      if (showRules) { if (key === "Escape") go(() => setShowRules(false)); return; }
      const a = actorSeat(g);
      const acting = a != null && seatIsHuman(g, a);
      const curtain = g.mode === "hotseat" && acting && g.revealedSeat !== a;
      if (curtain) {
        if (key === "Enter" || key === " ") go(() => setG((x) => ({ ...x, revealedSeat: actorSeat(x) })));
        return;
      }
      if (g.phase === "handEnd" || g.phase === "redeal") {
        if (key === "Enter" || key === " ") go(doNext);
        return;
      }
      if (!acting || a !== g.revealedSeat) return;
      if (g.phase === "bidding") {
        const bid = KEY_TO_BID[key];
        if (bid && legalBids(g.high ? g.high.key : null, g.hands[a]).includes(bid)) go(() => doBid(bid));
      } else if (g.phase === "declareTrump") {
        const i = "1234".indexOf(key);
        if (i >= 0) go(() => doTrump(SUITS[i]));
      } else if (g.phase === "declareCall") {
        const opts = callableCards(g.hands[a], g.contract.trump);
        const i = "123456789".indexOf(key);
        if (i >= 0 && i < opts.length) go(() => doCall(opts[i]));
      } else if (g.phase === "play") {
        const legal = legalMoves(g.hands[a], g.trick, g.contract ? g.contract.trump : null, g.contract);
        if (!legal.length) return;
        const idx = Math.max(0, legal.findIndex((c) => c.id === selId));
        if (key === "ArrowLeft") go(() => setSelId(legal[(idx + legal.length - 1) % legal.length].id));
        else if (key === "ArrowRight") go(() => setSelId(legal[(idx + 1) % legal.length].id));
        else if (key === "Enter" || key === " ") {
          const card = legal.find((c) => c.id === selId);
          if (card) go(() => onPlay(card));
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [g, showRules, connLost, selId]);

  if (!g) {
    if (lobby) {
      return (
        <OnlineLobby
          role={lobby.role}
          myName={lobby.name}
          aiSkill={lobby.aiSkill}
          onCancel={resetAll}
          onGuestJoined={(pc, ch) => {
            netRef.current = { role: "guest", guests: [], pcs: [pc], sendHost: (s) => ch.send(s) };
            ch.onmessage = (e) => {
              try {
                const m = JSON.parse(e.data);
                if (m.t === "state") {
                  m.g.playedIds = new Set(m.g.playedIds);
                  setLobby(null);
                  setG(m.g);
                }
              } catch {}
            };
            ch.onclose = () => setConnLost(true);
          }}
          onHostLaunch={(guests) => {
            // Guests take seats 1..k in slot order; AI fills the rest.
            const humanNames = [lobby.name, ...guests.map((gu) => gu.name)];
            const start = { ...newGame({ mode: "online-host", humanNames, aiSkill: lobby.aiSkill, nPlayers: 4 }),
              revealedSeat: 0 };
            netRef.current.role = "host";
            netRef.current.pcs = guests.map((gu) => gu.pc);
            netRef.current.guests = guests.map((gu, i) => ({ ch: gu.ch, seat: i + 1 }));
            for (const gu of netRef.current.guests) {
              gu.ch.onmessage = (e) => {
                try {
                  const m = JSON.parse(e.data);
                  if (m.t === "action") setG((x) => applyRemoteAction(x, gu.seat, m));
                } catch {}
              };
              gu.ch.onclose = () => // dropped guest: the AI takes the seat over
                setG((x) => (x && x.mode === "online-host"
                  ? { ...x, humans: x.humans.filter((p) => p !== gu.seat) } : x));
            }
            setLobby(null);
            setG(start);
          }}
        />
      );
    }
    return (
      <StartScreen
        onStart={(cfg) => setG(newGame(cfg))}
        onOnline={(cfg) => {
          teardownNet();
          netRef.current.pcs = [];
          setLobby(cfg);
        }}
      />
    );
  }

  const actor = actorSeat(g);
  const humanActing = actor != null && seatIsHuman(g, actor);
  // Hot seat: block the table until the right human confirms the handoff.
  const needCurtain = g.mode === "hotseat" && humanActing && g.revealedSeat !== actor;
  // Every mode keeps the viewer's engine seat in revealedSeat (solo included:
  // at 5-6 player tables the human's seat rotates, and is null sitting out).
  const viewSeat = g.revealedSeat;
  const baseSeat = viewSeat == null ? 0 : viewSeat;
  const myTurnToPlay = !needCurtain && humanActing && g.phase === "play" && actor === viewSeat;
  const relSeat = (rel) => (baseSeat + rel) % 4;

  return (
    // h-screen is the fallback; 100dvh tracks mobile browser chrome so the
    // fan is never hidden behind the URL bar.
    <div
      className={"relative w-full h-screen flex bg-emerald-900 text-emerald-50 font-sans overflow-hidden " +
        (mobile ? "flex-col" : "min-h-[600px]")}
      style={{
        height: "100dvh",
        backgroundImage: "radial-gradient(120% 90% at 50% 30%, #0a6e50 0%, #064e3b 55%, #032e23 100%)",
      }}
    >
      {mobile && <MobileTopBar g={g} onPanel={() => setPanelOpen(true)} />}
      <div className="relative flex-1 flex flex-col min-w-0">
        {announceText(g) && (
          <div className="absolute top-0 inset-x-0 z-10 bg-amber-400/95 text-emerald-950 text-center text-xs sm:text-sm font-semibold py-1 shadow">
            {announceText(g)}
          </div>
        )}

        {!mobile && <ContractChips g={g} />}
        {g.sitters.length > 0 && (
          <div className={"absolute z-10 rounded-full bg-emerald-950/70 px-2.5 py-1 text-xs text-emerald-200 " +
            (mobile ? "top-1 left-1" : "bottom-2 left-2")}>
            Sits out: {g.sitters.map((p) => g.names[p] + (p === g.dealer ? " (deals)" : "")).join(", ")}
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
            <BidPanel g={g} seat={actor} onBid={doBid} mobile={mobile} />
          )}
          <div className="flex items-center justify-center gap-3 mb-1">
            {viewSeat != null && <SeatBadge g={g} seat={viewSeat} />}
            {myTurnToPlay && !mobile && (
              <span className="text-[11px] text-emerald-300/90">← → pick a card · Enter plays it</span>
            )}
          </div>
          {viewSeat != null ? (
            <Fan g={g} seat={viewSeat} active={myTurnToPlay} onPlay={onPlay} mobile={mobile}
              selId={myTurnToPlay ? selId : null} />
          ) : (
            <div className="text-center pb-6 text-emerald-300 text-sm">
              {g.phase === "redeal" || g.phase === "handEnd" ? ""
                : g.mode === "solo" && g.sitters.includes(g.humans[0])
                  ? "You sit out this hand — the table plays without you."
                  : "AI players are acting…"}
            </div>
          )}
        </div>

        {/* modals over the table */}
        {needCurtain && (
          <Curtain name={seatName(g, actor)}
            onReady={() => setG((x) => ({ ...x, revealedSeat: actorSeat(x) }))} />
        )}
        {!needCurtain && humanActing && g.phase === "declareTrump" && (
          <TrumpPicker g={g} onPick={doTrump} mobile={mobile} />
        )}
        {!needCurtain && humanActing && g.phase === "declareCall" && (
          <CallPicker g={g} onPick={doCall} mobile={mobile} />
        )}
        {g.phase === "redeal" && (
          <Modal>
            <div className="text-lg font-bold mb-2">Everyone passed</div>
            <div className="text-sm text-emerald-200 mb-4">No contract — redeal, and the deal moves on.</div>
            <button type="button" onClick={doNext}
              className="w-full rounded-lg bg-amber-500 text-emerald-950 font-bold py-2 hover:bg-amber-400">
              Redeal<Kbd k="Enter" />
            </button>
          </Modal>
        )}
        {g.phase === "handEnd" && <HandEndModal g={g} onNext={doNext} />}
        {showRules && <RulesModal onClose={() => setShowRules(false)} />}
        {connLost && (
          <Modal>
            <div className="text-lg font-bold mb-2">Connection lost</div>
            <div className="text-sm text-emerald-200 mb-4">The link to the host dropped. You can start over.</div>
            <button type="button" onClick={resetAll}
              className="w-full rounded-lg bg-amber-500 text-emerald-950 font-bold py-2 hover:bg-amber-400">
              Back to start
            </button>
          </Modal>
        )}
      </div>

      {!mobile && (
        <SidePanel g={g} onRules={() => setShowRules(true)} onNewGame={resetAll} />
      )}
      {mobile && panelOpen && (
        <div className="absolute inset-0 z-[60] flex justify-end">
          <div className="absolute inset-0 bg-black/50" onClick={() => setPanelOpen(false)} />
          <div className="relative h-full">
            <SidePanel
              g={g}
              onRules={() => { setPanelOpen(false); setShowRules(true); }}
              onNewGame={() => { setPanelOpen(false); resetAll(); }}
              onClose={() => setPanelOpen(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
