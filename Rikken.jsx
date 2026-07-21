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
  // of that suit on another lead stays free — simplest reading.) Troela is
  // exempt: its partnership is public from the deal, so nothing is hidden.
  mustPlayCalledOnFirstLead: true,
  // Contracts in ascending auction rank. 'pass' is implicit below all.
  // trump: 'named' (bidder names it) | 'fixed' (fixedTrump applies) |
  //        'partner' (troela: the fourth-ace holder names it) | 'none'.
  // alone: plays without partner.
  // perTrick: rik-style scoring (1/trick above rikBase, undertricks on fail).
  // value: flat payment from each opponent. overtrick: bonus per trick > target.
  contracts: [
    { key: "rik",         label: "Rik",         alone: false, trump: "named", target: 8,  perTrick: true },
    // Rik beter: overcalls a plain rik by committing to hearts as trump.
    // House rule (overcallOnly): it is strictly an overcall — you may not
    // open the auction with it; some bid must already be standing.
    { key: "rik_beter",   label: "Rik beter",   alone: false, trump: "fixed", fixedTrump: "H", target: 8, perTrick: true, overcallOnly: true },
    // Fourth ace (troela). Dealt exactly three aces you MUST declare it
    // (forcedWithAces; classic rule — issue #11). The holder of the fourth
    // ace becomes the bidder's partner, openly from the start, and THEY
    // name trump from their own hand. Four aces: play it alone and name
    // trump yourself (house rule). The classic rule is silent on auction
    // rank, so it slots just above rik beter: same 8-trick target.
    { key: "troela",      label: "Fourth ace",  alone: false, trump: "partner", target: 8, perTrick: true, needsAces: 3, forcedWithAces: 3 },
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
// the holder of the fourth ace partners the bidder and names trump (four
// aces in the bidder's own hand: alone against three, naming trump).
function troelaSetup(hands, declarer) {
  if (hands[declarer].filter((c) => c.r === 14).length === 4)
    return { partner: null, called: null, soloTroela: true };
  const partner = hands.findIndex((h, s) => s !== declarer && h.some((c) => c.r === 14));
  return { partner, called: hands[partner].find((c) => c.r === 14), soloTroela: false };
}

const BID_ORDER = ["pass", ...RULES.contracts.map((c) => c.key)];
const bidRank = (key) => BID_ORDER.indexOf(key);
const contractDef = (key) => RULES.contracts.find((c) => c.key === key);

// Bids that outrank the current highest ('pass' is normally available).
// Per-contract gates: needsAces (fourth ace wants 3+ in hand) and
// overcallOnly (rik beter cannot open — a bid must already be standing).
// Forced declaration: dealt exactly forcedWithAces aces (troela: 3), that
// bid is COMPULSORY while it still outranks the auction — no pass, no
// other bid. Once overcalled past it, normal bidding resumes.
function legalBids(currentHighKey, hand) {
  const min = currentHighKey ? bidRank(currentHighKey) : 0;
  const aces = hand ? hand.filter((c) => c.r === 14).length : 0;
  const legal = BID_ORDER.filter((k) => {
    if (k === "pass") return true;
    if (bidRank(k) <= min) return false;
    const def = contractDef(k);
    if (def.overcallOnly && !currentHighKey) return false;
    if (def.needsAces && aces < def.needsAces) return false;
    return true;
  });
  const forced = legal.find((k) => k !== "pass" && contractDef(k).forcedWithAces === aces);
  return forced ? [forced] : legal;
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
// The misère family keeps deterministic hand-shape gates (the world
// sampler's rank caps depend on them) and fourth ace is always taken.
// Rik-family and abondance decisions — which trump, which card to call,
// bid or pass — are settled by Monte Carlo: every shape-plausible option
// is rolled out to the end of the hand across sampled deals of the unseen
// 39 cards, and the best option bids only if its EV clears a threshold.
function aiChooseBid(hand, currentHighKey) {
  const legal = legalBids(currentHighKey, hand);
  const lens = SUITS.map((s) => ({ s, cards: suitCards(hand, s) }));
  const aces = hand.filter((c) => c.r === 14).length;
  // Fourth ace: with exactly three aces the declaration is compulsory
  // (legalBids already forces it); with all four it is optional but there
  // is no sounder use of such a hand at this level of play.
  if (aces >= 3 && legal.includes("troela")) return { key: "troela" };

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

  const options = mcBidOptions(hand, legal);
  if (!options.length) return { key: "pass" };
  return mcChooseBid(hand, options, Math.random) || { key: "pass" };
}

// Trump for a won Fourth ace: the fourth-ace holder (or the four-ace solo
// declarer) names it from their own hand. The heuristic — longest suit,
// ties broken by total rank strength — serves the casual/sharp levels and
// is the fallback when no seating context is supplied.
function aiTroelaTrumpHeuristic(hand) {
  let best = SUITS[0], bestLen = -1, bestSum = -1;
  for (const s of SUITS) {
    const cards = suitCards(hand, s);
    const sum = cards.reduce((n, c) => n + c.r, 0);
    if (cards.length > bestLen || (cards.length === bestLen && sum > bestSum)) {
      best = s; bestLen = cards.length; bestSum = sum;
    }
  }
  return best;
}

// The hardest level settles the choice by Monte Carlo instead. The chooser
// legitimately knows more than their own 13 cards: a troela declarer holds
// exactly the three aces the chooser lacks, so those are placed with the
// declarer and only the remaining 36 cards are sampled. Every candidate
// suit is played to the end of the hand in each sampled world (common
// random deals across suits, like mcBidEVs) and the best expected score
// wins; ties keep the heuristic's pick. ctx: { declarer, chooser, leader }
// engine seats plus the called fourth ace (null when the declarer holds
// all four and plays alone).
function aiTroelaTrump(hand, ctx, samples = 24) {
  const fallback = aiTroelaTrumpHeuristic(hand);
  if (!ctx) return fallback;
  const { declarer, chooser, leader } = ctx;
  const solo = declarer === chooser;
  const called = ctx.called || null;
  const rng = Math.random;
  const seen = new Set(hand.map((c) => c.id));
  const declAces = solo ? [] : SUITS.filter((s) => !seen.has(s + 14))
    .map((s) => ({ s, r: 14, id: s + 14 }));
  const pool = [];
  for (const s of SUITS) for (const r of RANKS)
    if (!seen.has(s + r) && !(r === 14 && !solo)) pool.push({ s, r, id: s + r });
  const partner = solo ? null : chooser;
  const side = solo ? [declarer] : [declarer, chooser];
  const others = [0, 1, 2, 3].filter((s) => s !== chooser);
  const totals = { S: 0, H: 0, C: 0, D: 0 };
  for (let k = 0; k < samples; k++) {
    const p = shuffle(pool, rng);
    const world = [];
    world[chooser] = hand;
    let at = 0;
    for (const s of others) {
      const n = s === declarer ? 13 - declAces.length : 13;
      world[s] = (s === declarer ? declAces : []).concat(p.slice(at, at + n));
      at += n;
    }
    for (const t of SUITS) {
      const hands = world.map((h) => h.slice());
      const c = { key: "troela", declarer, trump: t, called, partner, revealed: true, soloTroela: solo };
      const wc = { key: c.key, called, revealed: true, trump: t };
      const tricks = [0, 0, 0, 0];
      let trick = [], turn = leader, played = 0;
      while (played < 13) {
        const card = mcPolicy(hands, turn, trick, t, wc, side, c, tricks);
        hands[turn] = hands[turn].filter((x) => x.id !== card.id);
        trick.push({ seat: turn, card });
        if (trick.length === 4) {
          const w = trickWinner(trick, t);
          tricks[w]++; trick = []; turn = w; played++;
        } else turn = (turn + 1) % 4;
      }
      totals[t] += scoreHand("troela", declarer, partner, tricks, solo).deltas[chooser];
    }
  }
  let best = fallback;
  for (const t of SUITS) if (totals[t] > totals[best]) best = t;
  return best;
}

// Trump-contract options worth evaluating. Shape gates mirror what the
// world sampler assumes a bidder promised (rik: 5+ trumps with an honour;
// abondance: 7+ with two; overcalls to rik 9+ want 6+), Monte Carlo does
// the rest.
function mcBidOptions(hand, legal) {
  const lens = SUITS.map((s) => ({ s, cards: suitCards(hand, s) }));
  const options = [];
  const hon = (l) => l.cards.filter((c) => c.r >= 12).length;
  const strong = lens.filter((l) => l.cards.length >= 5 && hon(l) >= 1)
    .sort((a, b) => b.cards.length - a.cards.length ||
      b.cards.reduce((n, c) => n + c.r, 0) - a.cards.reduce((n, c) => n + c.r, 0))
    .slice(0, 2);
  for (const l of strong) {
    const calls = callableCards(hand, l.s)
      .sort((a, b) => suitCards(hand, a.s).length - suitCards(hand, b.s).length)
      .slice(0, strong.length === 1 ? 2 : 1); // prefer calling where we are short
    for (const called of calls) {
      if (legal.includes("rik")) options.push({ key: "rik", trump: l.s, called });
      else if (l.s === "H" && legal.includes("rik_beter"))
        options.push({ key: "rik_beter", trump: "H", called });
    }
    if (l.cards.length >= 6 && hon(l) >= 2 && !legal.includes("rik")) {
      const over = ["rik9", "rik10", "rik11", "rik12"].find((k) => legal.includes(k));
      if (over && options.every((o) => o.key !== over))
        options.push({ key: over, trump: l.s, called: callableCards(hand, l.s)[0] });
    }
    if (l.cards.length >= 7 && hon(l) >= 2 && legal.includes("abondance"))
      options.push({ key: "abondance", trump: l.s });
  }
  return options;
}

// Roll one bid option out to the end of the hand in one sampled world
// (seat 0 = the bidder) and return the bidder's score.
function mcBidRollout(hand, world, option) {
  const def = contractDef(option.key);
  const hands = [hand.slice(), world.others[0].slice(), world.others[1].slice(), world.others[2].slice()];
  const called = option.called || null;
  const partner = called ? hands.findIndex((h) => h.some((x) => x.id === called.id)) : null;
  const trump = def.trump === "named" ? option.trump : def.trump === "fixed" ? def.fixedTrump : null;
  const c = { key: option.key, declarer: 0, trump, called, partner, revealed: !def.perTrick, soloTroela: false };
  const side = partner == null ? [0] : [0, partner];
  const tricks = [0, 0, 0, 0];
  let trick = [], turn = world.leader, revealed = c.revealed, played = 0;
  while (played < 13) {
    const wc = { key: c.key, called, revealed, trump };
    const card = mcPolicy(hands, turn, trick, trump, wc, side, c, tricks);
    hands[turn] = hands[turn].filter((x) => x.id !== card.id);
    if (called && !revealed && card.id === called.id) revealed = true;
    trick.push({ seat: turn, card });
    if (trick.length === 4) {
      const w = trickWinner(trick, trump);
      tricks[w]++; trick = []; turn = w; played++;
      if (checkEarlyEnd(option.key, side.reduce((n, s) => n + tricks[s], 0), played)) break;
    } else turn = (turn + 1) % 4;
  }
  return scoreHand(option.key, 0, partner, tricks, false).deltas[0];
}

// Expected score per bid option over shared sampled worlds (common random
// deals kill most of the option-vs-option noise). A cheap first pass over
// all options prunes to the two most promising before the deeper pass;
// pruned options keep their first-pass average, `alive` marks the deep ones.
function mcBidEVs(hand, options, rng) {
  const seen = new Set(hand.map((c) => c.id));
  const pool = [];
  for (const s of SUITS) for (const r of RANKS) if (!seen.has(s + r)) pool.push({ s, r, id: s + r });
  const nPre = 12, nMain = 36;
  const worlds = [];
  for (let k = 0; k < nPre + nMain; k++) {
    const p = shuffle(pool, rng);
    worlds.push({ others: [p.slice(0, 13), p.slice(13, 26), p.slice(26, 39)],
      leader: Math.floor(rng() * 4) });
  }
  const totals = options.map(() => 0);
  for (let w = 0; w < nPre; w++)
    options.forEach((o, i) => { totals[i] += mcBidRollout(hand, worlds[w], o); });
  const alive = options.map((o, i) => i)
    .sort((a, b) => mcBidValue(options[b].key, totals[b] / nPre) -
                    mcBidValue(options[a].key, totals[a] / nPre)).slice(0, 2);
  for (let w = nPre; w < nPre + nMain; w++)
    for (const i of alive) totals[i] += mcBidRollout(hand, worlds[w], options[i]);
  return { evs: totals.map((t, i) => t / (alive.includes(i) ? nPre + nMain : nPre)), alive };
}

// Rollout EV is a biased estimator of what a bid actually earns (the
// rollout's clairvoyant play flatters thin contracts, and passing is far
// from free — someone else usually declares against you). Both mappings
// were fitted by regression on 19,305 logged self-play bid decisions made
// with RANDOMIZED thresholds (2026-07-19, ecology of the then-current
// baseline), so each family's realized score is measured on both arms:
//   bidding realizes  ≈ a + b · mcEV      passing realizes ≈ c + d · mcEV
// Bid when the first beats the second; compare options on calibrated
// value, which also settles rik-vs-abondance across families honestly.
// `floor` is the lowest mcEV the exploration data directly covered with
// bid-arm samples: below it the fitted lines are extrapolation, so the AI
// does not bid there no matter what the lines say.
const MC_BID_CALIB = {
  rik:       { a: -1.170, b: 0.874, c: -1.745, d: 0.578, floor: -0.5 },
  rik_beter: { a: -1.011, b: 0.828, c: -2.428, d: 0.798, floor: -0.5 },
  rik9plus:  { a: -0.290, b: 0.802, c: -0.481, d: 0.200, floor: -0.3 },
  abondance: { a: -2.636, b: 1.250, c:  0.700, d: 0.000, floor:  1.0 },
};
function mcBidFamily(key) {
  if (key === "rik") return "rik";
  if (key === "rik_beter") return "rik_beter";
  if (key === "abondance") return "abondance";
  return "rik9plus"; // rik9..rik12 overcalls
}
function mcBidValue(key, ev) {
  const f = MC_BID_CALIB[mcBidFamily(key)];
  return f.a + f.b * ev;
}

function mcChooseBid(hand, options, rng) {
  const { evs, alive } = mcBidEVs(hand, options, rng);
  let best = alive[0];
  for (const i of alive)
    if (mcBidValue(options[i].key, evs[i]) > mcBidValue(options[best].key, evs[best])) best = i;
  const f = MC_BID_CALIB[mcBidFamily(options[best].key)];
  let ev = evs[best];
  // Close to the bid/pass boundary or the data floor, the 40-world EV is
  // noisy enough (~±0.7) to flip the call: double the evidence first.
  if (Math.min(Math.abs(f.a + f.b * ev - (f.c + f.d * ev)), Math.abs(ev - f.floor)) < 0.6)
    ev = (ev + mcBidEVs(hand, [options[best]], rng).evs[0]) / 2;
  return f.a + f.b * ev > f.c + f.d * ev && ev >= f.floor ? options[best] : null;
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
// who sees the called card in their own hand. Troela's partnership is
// public from the start: the fourth-ace holder names trump openly.
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
  const { hands, trick, contract, playedIds, aiSkill } = game;
  // Trump lives on the contract in the game flow; some test harnesses pass
  // it at the top level instead — accept either.
  const trump = game.trump != null ? game.trump : contract.trump;
  const legal = legalMoves(hands[seat], trick, trump, contract);
  if (legal.length === 1) return legal[0];
  const rng = Math.random;
  if (aiSkill === "hardest") { // Monte Carlo play; heuristics as fallback
    const mc = aiChooseCardHardest(seat, game);
    if (mc) return mc;
  }
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

/* ---- 'hardest' skill: determinized Monte Carlo card play ------------ */
// Instead of one heuristic line of reasoning, the hardest AI samples many
// complete deals consistent with everything it can LEGITIMATELY see — its
// own cards, every card played, who showed void in which suit, an open
// misère hand, the partner once revealed — plays each legal card to the
// end of the hand in every sampled world with a fast sound policy, and
// picks the card with the best expected points. It never peeks: unknown
// cards are re-dealt randomly for every sample.

// All cards whose location this seat cannot know.
function mcUnseen(game, knownSeats) {
  const seen = new Set(game.playedIds);
  for (const s of knownSeats) for (const c of game.hands[s]) seen.add(c.id);
  const pool = [];
  for (const s of SUITS) for (const r of RANKS)
    if (!seen.has(s + r)) pool.push({ s, r, id: s + r });
  return pool;
}

// One random full deal consistent with public information. Returns hands
// (array[4]) or null if the void constraints could not be satisfied.
//
// Beyond voids and hand sizes, the deal honours what the auction proved:
// - the called card is an ace the declarer does NOT hold (callableCards),
//   so while the partnership is hidden it may sit anywhere but with the
//   declarer; once revealed it must sit with the partner;
// - a fourth-ace declarer held the three other aces, so any of them still
//   unseen are theirs and nobody else's;
// - a rik / rik beter auction never rose past fourth ace, and a hand with
//   three aces must declare it, so no unknown hand holds three aces;
// - misère-family declarers bid on provably low hands: their unseen cards
//   are capped in rank (piek keeps room for its single high card).
function mcSampleWorld(seat, game, rng) {
  const voids = game.voids || [{}, {}, {}, {}];
  const c = game.contract;
  const knownSeats = [seat];
  if (game.openHand != null && game.openHand !== seat) knownSeats.push(game.openHand);
  const pool = mcUnseen(game, knownSeats);
  const d = c.declarer;
  const dUnknown = !knownSeats.includes(d);
  const calledPending = c.called && pool.some((x) => x.id === c.called.id);
  const forcedSeat = calledPending && c.revealed ? c.partner : null;
  const isTroela = c.key === "troela" && !c.soloTroela && dUnknown;
  const aceCap = c.key === "rik" || c.key === "rik_beter" ? 2 : null;
  const maxRank = { misere: 10, open_misere: 8, piek: 9 }[c.key] || null;
  const need = [0, 1, 2, 3].map((s) => (knownSeats.includes(s) ? 0 : game.hands[s].length));
  for (let attempt = 0; attempt < 40; attempt++) {
    const left = need.slice();
    const hands = [[], [], [], []];
    const aces = [0, 0, 0, 0];
    const taken = new Set();
    let ok = true;
    const give = (s, card) => {
      hands[s].push(card); left[s]--; taken.add(card.id);
      if (card.r === 14) aces[s]++;
    };
    let cards = shuffle(pool, rng);
    // forced placements first, while the owner still has room
    if (forcedSeat != null) give(forcedSeat, c.called);
    if (isTroela)
      for (const a of cards)
        if (a.r === 14 && (!c.called || a.id !== c.called.id)) {
          if (left[d] <= 0) { ok = false; break; }
          give(d, a);
        }
    if (ok && maxRank != null && dUnknown && left[d] > 0) {
      // fill the misère declarer's hand from the low cards (piek: leave one
      // slot for the single high honour their bid promised)
      const lows = cards.filter((x) => x.r <= maxRank && !voids[d][x.s] && !taken.has(x.id));
      let slots = left[d];
      if (c.key === "piek") {
        const high = cards.find((x) => x.r >= 13 && !voids[d][x.s] && !taken.has(x.id));
        if (high && slots > 1) { give(d, high); slots--; }
      }
      for (let i = 0; i < slots && i < lows.length; i++) give(d, lows[i]);
    }
    if (!ok) continue;
    for (const card of cards) {
      if (taken.has(card.id)) continue;
      let opts = [0, 1, 2, 3].filter((s) => left[s] > 0 && !voids[s][card.s]);
      if (calledPending && card.id === c.called.id) opts = opts.filter((s) => s !== d);
      if (aceCap != null && card.r === 14) opts = opts.filter((s) => aces[s] < aceCap);
      if (!opts.length) { ok = false; break; }
      const pick = opts[Math.floor(rng() * opts.length)];
      give(pick, card);
    }
    if (!ok) continue;
    for (const s of knownSeats) hands[s] = game.hands[s].slice();
    mcApplyBidInference(seat, game, hands, voids, rng);
    return hands;
  }
  return null;
}

// Bids are public information too — and more than a bare minimum: what a
// bidder's original hand actually looks like was mined from 6,909 declared
// contracts of clean all-hardest self-play (2026-07-19, played under THIS
// file's calibrated bidder so the modelled population matches the bids it
// actually makes). Cumulative distributions of original trump length,
// trump honours (A/K/Q) and length in the called suit, per contract
// family; each sampled world draws fresh targets from them, replacing the
// old hard "at least N trumps" floor. solo_slim keeps a floor (this AI
// never bids it, humans in the UI can).
const MC_BID_SHAPE = {
  rik:       { len: [[5, .606], [6, .895], [7, .986], [8, .999], [9, 1]],
               hon: [[1, .538], [2, .928], [3, 1]],
               call: [[0, .050], [1, .319], [2, .686], [3, .928], [4, .997], [5, 1]] },
  rik_beter: { len: [[5, .645], [6, .919], [7, .987], [8, .999], [9, 1]],
               hon: [[1, .587], [2, .942], [3, 1]],
               call: [[0, .060], [1, .359], [2, .726], [3, .938], [4, .997], [5, 1]] },
  rik9plus:  { len: [[6, .610], [7, .912], [8, .994], [9, 1]],
               hon: [[2, .794], [3, 1]],
               call: [[0, .087], [1, .372], [2, .686], [3, .888], [4, .973], [5, .997], [6, 1]] },
  abondance: { len: [[7, .248], [8, .712], [9, .944], [10, 1]],
               hon: [[2, .376], [3, 1]] },
};
const MC_MIN_TRUMPS = { solo_slim: 8 };
function mcDraw(cum, rng) {
  const x = rng();
  for (const [v, p] of cum) if (x <= p) return v;
  return cum[cum.length - 1][0];
}

// Bring the declarer's count of suit S to exactly `want` by swapping cards
// with donor hands, voids permitting. Cards of freezeSuit never move in
// either direction (so a later adjustment cannot undo an earlier one) and
// excludeId (the called card) never enters the declarer's hand.
function mcAdjustSuitCount(hands, d, S, want, donors, voids, rng, freezeSuit, excludeId) {
  let have = hands[d].filter((x) => x.s === S).length;
  while (have < want) {
    let done = false;
    for (const s of shuffle(donors, rng)) {
      const t = hands[s].find((x) => x.s === S && x.id !== excludeId);
      if (!t) continue;
      const give = hands[d].find((x) => x.s !== S && x.s !== freezeSuit && !voids[s][x.s]);
      if (!give) continue;
      hands[s] = hands[s].map((x) => (x.id === t.id ? give : x));
      hands[d] = hands[d].map((x) => (x.id === give.id ? t : x));
      done = true;
      break;
    }
    if (!done) return;
    have++;
  }
  while (have > want) {
    let done = false;
    for (const s of shuffle(donors, rng)) {
      if (voids[s][S]) continue;
      const take = hands[s].find((x) => x.s !== S && x.s !== freezeSuit &&
        !voids[d][x.s] && x.id !== excludeId);
      if (!take) continue;
      const sCards = hands[d].filter((x) => x.s === S);
      const t = sCards[Math.floor(rng() * sCards.length)]; // random, not lowest:
      // always exporting the low card would leave a top-heavy suit behind
      hands[s] = hands[s].map((x) => (x.id === take.id ? t : x));
      hands[d] = hands[d].map((x) => (x.id === t.id ? take : x));
      done = true;
      break;
    }
    if (!done) return;
    have--;
  }
}

function mcApplyBidInference(seat, game, hands, voids, rng) {
  const c = game.contract;
  const d = c.declarer;
  if (!c.trump || d === seat || d === game.openHand || !game.playedCount) return;
  if (voids[d][c.trump]) return; // shown void: no trumps left to model
  const shape = c.key === "rik" ? MC_BID_SHAPE.rik
    : c.key === "rik_beter" ? MC_BID_SHAPE.rik_beter
    : c.key === "abondance" ? MC_BID_SHAPE.abondance
    : /^rik(9|1[0-2])$/.test(c.key) ? MC_BID_SHAPE.rik9plus : null;
  const floorT = MC_MIN_TRUMPS[c.key];
  if (!shape && !floorT) return; // troela, misère family: nothing promised
  const donors = [0, 1, 2, 3].filter((s) => s !== d && s !== seat && s !== game.openHand);
  const exclude = c.called ? c.called.id : null;

  // original trump length -> remaining trumps in the declarer's hand
  const alreadyT = game.playedCount[d][c.trump] || 0;
  let wantT;
  if (shape) {
    const target = Math.min(mcDraw(shape.len, rng), alreadyT + hands[d].length);
    wantT = Math.max(0, target - alreadyT);
  } else {
    wantT = Math.max(hands[d].filter((x) => x.s === c.trump).length,
      Math.min(floorT - alreadyT, hands[d].length)); // floor: only swap in
  }
  mcAdjustSuitCount(hands, d, c.trump, wantT, donors, voids, rng, null, exclude);

  // trump honours: provably intact while the declarer has played no trump
  if (alreadyT === 0) {
    const wantHon = Math.min(shape ? mcDraw(shape.hon, rng) : 1, wantT);
    let hon = hands[d].filter((x) => x.s === c.trump && x.r >= 12).length;
    while (hon !== wantHon) {
      const up = hon < wantHon;
      let done = false;
      for (const s of shuffle(donors, rng)) {
        const t = hands[s].find((x) => x.s === c.trump && (up ? x.r >= 12 : x.r < 12));
        if (!t) continue;
        const back = hands[d].filter((x) => x.s === c.trump && (up ? x.r < 12 : x.r >= 12))
          .sort((a, b) => (up ? a.r - b.r : b.r - a.r))[0];
        if (!back) break;
        hands[s] = hands[s].map((x) => (x.id === t.id ? back : x));
        hands[d] = hands[d].map((x) => (x.id === back.id ? t : x));
        done = true;
        break;
      }
      if (!done) break;
      hon += up ? 1 : -1;
    }
  }

  // length in the called suit: the declarer called where they are short
  if (shape && shape.call && c.called && !voids[d][c.called.s]) {
    const cs = c.called.s;
    const alreadyC = game.playedCount[d][cs] || 0;
    const room = hands[d].length - wantT;
    const wantC = Math.max(0, Math.min(mcDraw(shape.call, rng) - alreadyC, room));
    mcAdjustSuitCount(hands, d, cs, wantC, donors, voids, rng, c.trump, exclude);
  }
}

// In-rollout policy. Inside a sampled world every hand is known, so the
// rollout plays near-double-dummy (the classic determinization approach):
// the uncertainty lives entirely in the sampling.

// Can this (full, known) hand legally beat `best`, given the suit led?
function mcCanBeat(hand, best, ledSuit, trump) {
  const follow = hand.filter((x) => x.s === ledSuit);
  if (follow.length) {
    if (trump && best.s === trump && ledSuit !== trump) return false;
    return best.s === ledSuit && follow.some((x) => x.r > best.r);
  }
  if (!trump || !hand.some((x) => x.s === trump)) return false;
  if (best.s !== trump) return true;
  return hand.some((x) => x.s === trump && x.r > best.r);
}

// In a sampled world every hand is visible, so "master" is exact: no card
// of the same suit and higher rank survives in any hand.
function mcWorldMaster(card, hands) {
  for (const h of hands)
    for (const x of h) if (x.s === card.s && x.r > card.r) return false;
  return true;
}

// Cheapest safe discard: lowest non-trump that is not a live master (never
// throw a sure winner away); failing that, lowest non-trump, else lowest.
function mcLowDump(byRank, hands, trump) {
  const nonTrump = byRank.filter((x) => x.s !== trump);
  return nonTrump.find((x) => !mcWorldMaster(x, hands)) || nonTrump[0] || byRank[0];
}

function mcPolicy(hands, s, trick, trump, wc, side, c, tricks) {
  const legal = legalMoves(hands[s], trick, trump, wc);
  if (legal.length === 1) return legal[0];
  const byRank = legal.slice().sort((a, b) => a.r - b.r);
  const def = contractDef(c.key);
  const declSide = side.includes(s);
  const dt = side.reduce((n, x) => n + tricks[x], 0);
  const avoid = declSide && (def.target === 0 || (def.exact && def.target === 1 && dt >= 1));
  const isFoe = (p) => (declSide ? !side.includes(p) : side.includes(p));
  const lowDump = mcLowDump(byRank, hands, trump);

  if (avoid) {
    if (trick.length === 0) {
      // Lead the biggest card some enemy hand is forced to overtake; the
      // lowest card of the hand is only a guess at that, the world knows.
      const foes = [0, 1, 2, 3].filter((p) => p !== s && isFoe(p));
      let safe = null;
      for (const x of legal) {
        const covered = foes.some((p) => {
          const inSuit = hands[p].filter((y) => y.s === x.s);
          return inSuit.length > 0 && inSuit.every((y) => y.r > x.r);
        });
        if (covered && (!safe || x.r > safe.r)) safe = x;
      }
      return safe || byRank[0];
    }
    const under = byRank.filter((x) => !wouldWin(x, trick, trump, s));
    // ducking: shed the biggest card that stays under; forced to win: shed
    // the most dangerous card while we are stuck with the trick anyway
    return under.length ? under[under.length - 1] : byRank[byRank.length - 1];
  }

  // Defending a misère-family contract in a known world: the whole game is
  // forcing the declarer to win a trick. Keep the trick under the declarer's
  // forced minimum while they still have to play; once they are safe from
  // this trick, shed the biggest danger card. A piek declarer sitting on
  // their one trick is in the same spot: force them over the top.
  if (!declSide && (def.target === 0 || (def.exact && def.target === 1 && dt >= 1))) {
    const decl = c.declarer;
    const dh = hands[decl];
    if (trick.length === 0) {
      let force = null;
      for (const x of legal) {
        const inSuit = dh.filter((y) => y.s === x.s);
        if (inSuit.length && inSuit.every((y) => y.r > x.r) && (!force || x.r > force.r))
          force = x;
      }
      if (force) return force;
      // no forcing lead: drain a suit the declarer can still duck in
      const drain = byRank.find((x) => dh.some((y) => y.s === x.s));
      return drain || byRank[byRank.length - 1];
    }
    const ledSuit = trick[0].card.s;
    const w = trickWinner(trick, trump);
    const best = trick.find((p) => p.seat === w).card;
    const following = byRank[0].s === ledSuit;
    const declToCome = !trick.some((p) => p.seat === decl);
    const dSuit = dh.filter((y) => y.s === ledSuit);
    if (following && declToCome && dSuit.length) {
      const dLow = Math.min(...dSuit.map((y) => y.r));
      if (best.r < dLow) {
        // any card under the declarer's minimum keeps them forced — shed
        // the biggest one; with none, the force is lost anyway
        const u = byRank.filter((x) => x.r < dLow);
        if (u.length) return u[u.length - 1];
      }
      return byRank[byRank.length - 1];
    }
    if (following && !declToCome && w === decl) {
      // declarer is winning the trick: stay under them at all costs
      const u = byRank.filter((x) => x.s === ledSuit && x.r < best.r);
      if (u.length) return u[u.length - 1];
    }
    return byRank[byRank.length - 1]; // declarer safe from this trick: dump
  }

  if (trick.length === 0) {
    // Lead the biggest card nobody at the table can legally beat.
    const foes = [0, 1, 2, 3].filter((p) => p !== s && isFoe(p));
    for (let i = byRank.length - 1; i >= 0; i--) {
      const x = byRank[i];
      if (foes.every((p) => !mcCanBeat(hands[p], x, x.s, trump))) return x;
    }
    // Declaring side with the trump majority but not the master: lead a low
    // trump to force the enemy masters out and promote the rest.
    if (declSide && trump) {
      const myT = byRank.filter((x) => x.s === trump);
      const foeT = foes.reduce((n, p) => n + hands[p].filter((x) => x.s === trump).length, 0);
      const sideT = [0, 1, 2, 3].filter((p) => !isFoe(p))
        .reduce((n, p) => n + hands[p].filter((x) => x.s === trump).length, 0);
      if (myT.length && foeT > 0 && sideT > foeT) return myT[0];
    }
    return byRank[0];
  }

  const ledSuit = trick[0].card.s;
  const enemiesToCome = [];
  for (let i = 1; i <= 3 - trick.length; i++) {
    const p = (s + i) % 4;
    if (isFoe(p)) enemiesToCome.push(p);
  }
  const w = trickWinner(trick, trump);
  const best = trick.find((p) => p.seat === w).card;
  const friendWinning = w === s || !isFoe(w);
  if (friendWinning && enemiesToCome.every((p) => !mcCanBeat(hands[p], best, ledSuit, trump)))
    return lowDump; // the trick is already ours — keep everything
  // Cheapest card that wins now AND survives everyone still to play.
  const winners = byRank.filter((x) => wouldWin(x, trick, trump, s));
  const sure = winners.filter((x) => enemiesToCome.every((p) => !mcCanBeat(hands[p], x, ledSuit, trump)));
  if (sure.length) return sure[0];
  return lowDump; // can't secure it: spend nothing
}

// Play `myCard` in the sampled world and roll the hand out to the last
// trick; returns this seat's point delta from scoreHand.
function mcRollout(world, seat, myCard, game) {
  const c = game.contract;
  const hands = world.map((h) => h.slice());
  const tricks = game.tricksBySeat.slice();
  let trick = game.trick.slice();
  let trump = game.trump != null ? game.trump : c.trump;
  let revealed = c.revealed;
  // The partner in THIS world: public if revealed, else the sampled holder
  // of the called card (nobody at the table knows more than that).
  let partner = c.partner;
  if (c.called && !revealed) {
    const holder = hands.findIndex((h) => h.some((x) => x.id === c.called.id));
    if (holder >= 0) partner = holder;
  }
  const side = partner == null ? [c.declarer] : [c.declarer, partner];
  const playOne = (s, card) => {
    hands[s] = hands[s].filter((x) => x.id !== card.id);
    if (c.called && !revealed && card.id === c.called.id) revealed = true;
    trick.push({ seat: s, card });
  };
  playOne(seat, myCard);
  let turn = (seat + 1) % 4;
  while (true) {
    if (trick.length === 4) {
      const w = trickWinner(trick, trump);
      tricks[w]++;
      trick = [];
      turn = w;
      if (tricks.reduce((a, b) => a + b, 0) === 13) break;
      continue;
    }
    const wc = { key: c.key, called: c.called, revealed, trump };
    playOne(turn, mcPolicy(hands, turn, trick, trump, wc, side, c, tricks));
    turn = (turn + 1) % 4;
  }
  return scoreHand(c.key, c.declarer, partner, tricks, !!c.soloTroela).deltas[seat];
}

function aiChooseCardHardest(seat, game, samples = 24) {
  const c = game.contract;
  const trump = game.trump != null ? game.trump : c.trump;
  const legal = legalMoves(game.hands[seat], game.trick, trump, c);
  if (legal.length === 1) return legal[0];
  const rng = Math.random;
  const ordered = legal.slice().sort((a, b) => a.r - b.r); // ties -> cheapest
  const totals = new Map(ordered.map((x) => [x.id, 0]));
  let sampled = 0;
  const batch = (n) => {
    for (let k = 0; k < n; k++) {
      const world = mcSampleWorld(seat, game, rng);
      if (!world) continue;
      sampled++;
      for (const card of ordered)
        totals.set(card.id, totals.get(card.id) + mcRollout(world, seat, card, game));
    }
  };
  const top2gap = () => {
    const v = ordered.map((x) => totals.get(x.id)).sort((a, b) => b - a);
    return (v[0] - (v[1] === undefined ? v[0] : v[1])) / Math.max(1, sampled);
  };
  batch(samples);
  if (sampled && top2gap() < 1.5) batch(samples); // close call: look harder
  if (sampled && top2gap() < 0.75) batch(samples); // still close: harder yet
  if (sampled && top2gap() < 0.4) batch(samples); // genuinely contested
  if (!sampled) return null; // caller falls back to the sharp heuristic
  let best = ordered[0];
  for (const card of ordered) if (totals.get(card.id) > totals.get(best.id)) best = card;
  return best;
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
    voids: [{}, {}, {}, {}], // public knowledge: seat showed void in suit
    playedCount: [{}, {}, {}, {}], // public: cards of each suit a seat has shown
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
      // Fourth ace: partner and called card come straight from the deal,
      // and the partnership is public immediately — the fourth-ace holder
      // (the solo declarer with all four) now names trump from their hand.
      const st = troelaSetup(g.hands, high.seat);
      return { ...g2, contract: { ...contract, ...st, revealed: true }, phase: "declareTrump" };
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
  if (def.perTrick && contract.key !== "troela") // rik: now call (troela's
    return { ...g, contract, phase: "declareCall" }; // partner is set by the deal)
  return { ...g, contract, phase: "play0" };
}

// Who names trump in the declareTrump phase: the declarer, except for a
// fourth ace with a partner — there the fourth-ace holder names it.
function trumpChooser(g) {
  const c = g.contract;
  return c.key === "troela" && c.partner != null ? c.partner : c.declarer;
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
  // Not following suit is public information — everyone saw the void.
  const voids = g.trick.length > 0 && card.s !== g.trick[0].card.s
    ? (g.voids || [{}, {}, {}, {}]).map((v, s) => (s === seat ? { ...v, [g.trick[0].card.s]: true } : v))
    : g.voids;
  // So is how many cards of each suit every seat has shown.
  const playedCount = (g.playedCount || [{}, {}, {}, {}]).map((m, s) =>
    s === seat ? { ...m, [card.s]: (m[card.s] || 0) + 1 } : m);
  let contract = g.contract;
  if (contract.called && !contract.revealed && card.id === contract.called.id)
    contract = { ...contract, revealed: true }; // partnership now public
  const next = { ...g, hands, trick, playedIds, voids, playedCount, contract };
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
  if (g.phase === "declareTrump") return trumpChooser(g);
  if (g.phase === "declareCall") return g.contract.declarer;
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
  if (g.phase === "declareTrump")
    return applyTrumpChoice(g, g.contract.key === "troela"
      ? aiTroelaTrump(g.hands[actor], g.aiSkill === "hardest"
          ? { declarer: g.contract.declarer, chooser: actor,
              leader: (g.dealerSeat + 1) % 4, called: g.contract.called }
          : null)
      : g.high.trump);
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
  if (msg.kind === "trump" && x.phase === "declareTrump" && trumpChooser(x) === seat &&
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
    return c.soloTroela
      ? seatName(g, c.declarer) + " plays Fourth ace alone with all four aces — and names trump!"
      : seatName(g, c.declarer) + " plays Fourth ace — " + seatName(g, c.partner) +
        " holds the fourth ace, partners them and names trump!";
  if ((g.phase === "play" || g.phase === "trickPause") && g.trickNo === 0) {
    const def = contractDef(c.key);
    let s = seatName(g, c.declarer) + " plays " + def.label;
    if (c.trump) s += " in " + SUIT_NAME[c.trump].toLowerCase();
    if (c.called && !c.revealed) s += " — partner: whoever holds " + RANK_GLYPH[c.called.r] + SUIT_GLYPH[c.called.s];
    else if (c.partner != null) s += " — partner: " + seatName(g, c.partner);
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
        "relative overflow-hidden border border-slate-300/90 bg-gradient-to-br from-white via-white to-slate-200 " +
        "shadow-[0_1px_2px_rgba(0,0,0,.35),0_4px_10px_rgba(0,0,0,.18)] " +
        "flex flex-col select-none shrink-0 " +
        dims + " " + suitColor(card.s) +
        (dimmed ? " opacity-40" : "") +
        (highlight ? " ring-4 ring-amber-300" : "") +
        (selected ? " ring-4 ring-amber-300 -translate-y-2" : "") +
        (onClick ? " cursor-pointer hover:-translate-y-2 focus:-translate-y-2 active:-translate-y-2 transition-transform" : " cursor-default")
      }
    >
      {/* No bottom (rotated) corner index: it can overflow the card face
          at some font/zoom combinations, so the card keeps only the top
          index and the centre pip. */}
      <div className="leading-none font-bold text-left">
        {RANK_GLYPH[card.r]}
        <div>{SUIT_GLYPH[card.s]}</div>
      </div>
      <div className={"flex-1 grid place-items-center leading-none drop-shadow-sm " + (size === "sm" ? "text-xs" : "text-xl sm:text-2xl")}>
        {SUIT_GLYPH[card.s]}
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
  // Issue-#8 follow-up: while the hand is being played, the auction winner
  // keeps a glowing amber ring, and the partner gets a sky one the moment
  // the called ace reveals them — the contract side stays visible at a glance.
  const flagPhase = ["declareTrump", "declareCall", "play", "trickPause", "handEnd"].includes(g.phase);
  const declFlag = isDecl && flagPhase;
  const partnerFlag = isPartner && flagPhase;
  return (
    <div className={"flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs sm:text-sm " +
      (onTurn ? "bg-amber-300 text-emerald-950 font-semibold" : "bg-emerald-950/60 text-emerald-50") +
      (declFlag ? " ring-[3px] ring-amber-400 ring-offset-1 ring-offset-emerald-950 shadow-[0_0_16px_rgba(251,191,36,.7)]"
        : partnerFlag ? " ring-[3px] ring-sky-300 ring-offset-1 ring-offset-emerald-950 shadow-[0_0_16px_rgba(125,211,252,.65)]" : "")}>
      {g.active[seat] === g.dealer && <span title="Dealer" className="rounded-full bg-white text-emerald-900 font-bold px-1 leading-4">D</span>}
      <span className="whitespace-nowrap">{seatName(g, seat)}</span>
      {isDecl && <span title="Declarer" className={onTurn ? "" : "text-amber-300"}>★</span>}
      {isPartner && <span title="Partner" className={onTurn ? "" : "text-sky-300"}>☆</span>}
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
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      {/* the table itself: a soft felt oval under the trick */}
      <div className="absolute h-[62%] max-h-[20rem] w-[76%] max-w-[34rem] rounded-[50%] border border-white/10 bg-black/10 shadow-[inset_0_12px_45px_rgba(0,0,0,.35)]" />
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
        <button type="button" onClick={() => onBid("pass")} disabled={!legal.has("pass")}
          title={legal.has("pass") ? undefined : "Three aces: you must declare Fourth ace"}
          className="rounded-lg bg-slate-500 hover:bg-slate-400 px-3 py-1.5 text-sm font-semibold shadow
                     disabled:opacity-30 disabled:cursor-not-allowed">
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
  const c = g.contract;
  const chooser = trumpChooser(g);
  return (
    <Modal>
      <div className="mb-3 font-semibold">
        {c.key === "troela" && !c.soloTroela
          ? seatName(g, chooser) + ": you hold the fourth ace — name trump for " +
            seatName(g, c.declarer) + "'s Fourth ace"
          : seatName(g, chooser) + ": name your trump suit for " + contractDef(c.key).label}
      </div>
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
          ) : null}
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
        Dealt exactly three aces you must declare Fourth ace (it can still be overcalled by a
        higher bid). The holder of the fourth ace becomes your partner — openly, from the
        start — and names trump from their own hand; the pair needs 8 tricks, scored like a
        rik. With all four aces you play it alone and name trump yourself.
        <H>Contracts</H>
        Rik (8) / Rik 9–12: bidder names trump and calls a non-trump ace they don't hold — its
        holder is their secret partner (a king if they hold all three outside aces).
        Rik beter: rik with hearts as trump — the way to outbid a plain rik while still
        playing for 8 tricks; same partner call, same scoring. House rule: strictly an
        overcall — you cannot open the auction with it.
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
            {[["casual", "Casual"], ["sharp", "Sharp"], ["hardest", "Hardest"]].map(([s, label]) => (
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
