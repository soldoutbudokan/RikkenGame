// Mine playing lessons out of the Hardest AI and write ../BEST-PRACTICES.md.
//
//   HANDS=400 node ai-bench/insights.mjs
//
// Plays all-Hardest tables with every card decision instrumented: the full
// expected-value table over sampled worlds is recorded, Sharp's heuristic
// choice is computed on the identical state, and the two are compared.
// Tendencies (what the strongest AI actually does) and disagreements
// (where heuristic intuition leaves points on the table) become a
// data-backed strategy document.

import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { loadAI, playMatch } from "./harness.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const A = loadAI(path.join(dir, "..", "Rikken.jsx"));
const HANDS = +(process.env.HANDS || 400);
const SAMPLES = 20;

const RG = { 14: "A", 13: "K", 12: "Q", 11: "J" };
const SG = { S: "♠", H: "♥", C: "♣", D: "♦" };
const cardStr = (c) => (RG[c.r] || c.r) + SG[c.s];

// --- metric counters: [numerator, denominator] --------------------------
const frac = () => [0, 0];
const M = {
  decisions: 0,
  disagree: frac(), disagreeLead: frac(), disagreeFollow: frac(),
  evGapSum: 0, evGapN: 0,
  declTrumpLead: frac(),        // declaring side, trump contract: leads trump
  defTrumpLeadVsRik: frac(),    // defender vs rik-family: leads trump
  defProbeCalled: frac(),       // defender vs unrevealed rik: leads the called suit
  defLowLeadVsMisere: frac(),   // defender vs misère/piek: leads a low card (<=9)
  avoidLowestLead: frac(),      // misère-side declarer: leads their very lowest card
  fourthCheapest: frac(),       // 4th hand taking a trick: uses the cheapest winner
  earlyDuck: frac(),            // 2nd/3rd hand could win but declines
  ruff: frac(),                 // void, holds trump, enemy winning: trumps in
};
const hit = (f, cond) => { f[1]++; if (cond) f[0]++; };
const examples = []; // biggest-EV-gap disagreements

function evTable(seat, game) {
  const c = game.contract;
  const trump = game.trump != null ? game.trump : c.trump;
  const legal = A.legalMoves(game.hands[seat], game.trick, trump, c);
  const ordered = legal.slice().sort((a, b) => a.r - b.r);
  if (ordered.length === 1) return { ordered, ev: null };
  const totals = new Map(ordered.map((x) => [x.id, 0]));
  let n = 0;
  for (let k = 0; k < SAMPLES; k++) {
    const w = A.mcSampleWorld(seat, game, Math.random);
    if (!w) continue;
    n++;
    for (const card of ordered) totals.set(card.id, totals.get(card.id) + A.mcRollout(w, seat, card, game));
  }
  if (!n) return { ordered, ev: null };
  return { ordered, ev: new Map(ordered.map((x) => [x.id, totals.get(x.id) / n])) };
}

function chooseCard(mod, seat, game) {
  const { ordered, ev } = evTable(seat, game);
  if (!ev) return mod.aiChooseCard(seat, game); // trivial or unsampleable
  let pick = ordered[0];
  for (const x of ordered) if (ev.get(x.id) > ev.get(pick.id)) pick = x;

  const c = game.contract;
  const def = A.contractDef(c.key);
  const trump = game.trump != null ? game.trump : c.trump;
  const side = c.partner == null ? [c.declarer] : [c.declarer, c.partner]; // analysis is omniscient
  const declSide = side.includes(seat);
  const pos = game.trick.length;
  const avoidSide = declSide && def.exact && def.target <= 1;

  // --- tendencies -------------------------------------------------------
  M.decisions++;
  if (pos === 0) {
    if (trump && def.perTrick) {
      if (declSide) hit(M.declTrumpLead, pick.s === trump);
      else {
        hit(M.defTrumpLeadVsRik, pick.s === trump);
        if (c.called && !c.revealed) hit(M.defProbeCalled, pick.s === c.called.s);
      }
    }
    if (!declSide && def.exact && def.target <= 1) hit(M.defLowLeadVsMisere, pick.r <= 9);
    if (avoidSide) hit(M.avoidLowestLead, pick.id === ordered[0].id);
  } else {
    const winners = ordered.filter((x) => {
      return A.trickWinner([...game.trick, { seat, card: x }], trump) === seat;
    });
    const w = A.trickWinner(game.trick, trump);
    const enemyWinning = declSide ? !side.includes(w) : side.includes(w);
    const picksWin = winners.some((x) => x.id === pick.id);
    if (!avoidSide && enemyWinning && winners.length) {
      if (pos === 3) { if (picksWin) hit(M.fourthCheapest, pick.id === winners[0].id); }
      else hit(M.earlyDuck, !picksWin);
    }
    const led = game.trick[0].card.s;
    const isVoid = game.hands[seat].every((x) => x.s !== led);
    if (!avoidSide && isVoid && trump && led !== trump && enemyWinning &&
        game.hands[seat].some((x) => x.s === trump))
      hit(M.ruff, pick.s === trump);
  }

  // --- disagreement with the sharp heuristic ----------------------------
  const sharp = A.aiChooseCard(seat, { ...game, aiSkill: "sharp" });
  const dis = sharp.id !== pick.id;
  hit(M.disagree, dis);
  hit(pos === 0 ? M.disagreeLead : M.disagreeFollow, dis);
  if (dis && ev.has(sharp.id)) {
    const gap = ev.get(pick.id) - ev.get(sharp.id);
    M.evGapSum += gap; M.evGapN++;
    const role = seat === c.declarer ? "declaring" : declSide ? "as the hidden partner in" : "defending";
    examples.push({ gap, text:
      "Trick " + (game.tricksBySeat.reduce((a, b) => a + b, 0) + 1) + ", " + role + " " + def.label +
      (trump ? " in " + SG[trump] : "") + (pos === 0 ? ", on lead" : ", " + ["", "2nd", "3rd", "4th"][pos] + " to play") +
      ": the heuristic plays " + cardStr(sharp) + ", the Monte Carlo player prefers " + cardStr(pick) +
      " (worth +" + gap.toFixed(2) + " pts/hand in its own evaluation)." });
  }
  return pick;
}

console.error("mining " + HANDS + " all-hardest hands…");
const r = playMatch(A, A, HANDS, { chooseCard });
if (r.violations > 0) { console.error("VIOLATIONS: " + r.violations); process.exit(1); }

// --- render -------------------------------------------------------------
const pc = (f) => (f[1] ? (100 * f[0] / f[1]).toFixed(0) + "%" : "n/a");
const nOf = (f) => f[1];
examples.sort((a, b) => b.gap - a.gap);
const top = examples.slice(0, 6);
const today = new Date().toISOString().slice(0, 10);

const md = `# Rikken best practices — mined from the Hardest AI

_Auto-generated by \`node ai-bench/insights.mjs\` on ${today}: ${r.n} all-Hardest hands,
${M.decisions} instrumented decisions, ${SAMPLES} sampled worlds per decision. Do not edit by
hand — regenerate instead._

The Hardest AI has no written strategy: every choice is the best expected score across many
sampled worlds consistent with public information. That makes each decision explainable, and
in bulk its tendencies read as a data-backed strategy guide. Numbers below are how often the
strongest player in this repo actually does the thing.

## What the strongest player actually does

| Situation | Tendency | Rate | Sample |
|---|---|---|---|
| Declaring a rik-family contract, on lead | leads trump | ${pc(M.declTrumpLead)} | ${nOf(M.declTrumpLead)} |
| Defending a rik-family contract, on lead | leads trump | ${pc(M.defTrumpLeadVsRik)} | ${nOf(M.defTrumpLeadVsRik)} |
| Defending, partner ace still hidden, on lead | probes the called suit | ${pc(M.defProbeCalled)} | ${nOf(M.defProbeCalled)} |
| Defending a misère/piek, on lead | leads low (≤ 9) | ${pc(M.defLowLeadVsMisere)} | ${nOf(M.defLowLeadVsMisere)} |
| Playing a misère/piek as declarer, on lead | leads the very lowest card | ${pc(M.avoidLowestLead)} | ${nOf(M.avoidLowestLead)} |
| 4th to a trick it takes | wins with the cheapest card that does it | ${pc(M.fourthCheapest)} | ${nOf(M.fourthCheapest)} |
| 2nd/3rd hand, could win the trick | ducks anyway | ${pc(M.earlyDuck)} | ${nOf(M.earlyDuck)} |
| Void in the led suit, enemy winning, holds trump | trumps in | ${pc(M.ruff)} | ${nOf(M.ruff)} |

Read the duck rate carefully: it is the single clearest difference from casual play — winning
a trick you could win is often wrong (it spends a master early, or wins with the wrong hand).

## Where intuition goes wrong

Sharp — the deterministic heuristic player — was asked for its move at every one of the same
decisions. It disagreed with the Monte Carlo choice in **${pc(M.disagree)}** of decisions
(${pc(M.disagreeLead)} of leads, ${pc(M.disagreeFollow)} of follows). When they disagreed, the
heuristic's card cost an average of **${M.evGapN ? (M.evGapSum / M.evGapN).toFixed(2) : "n/a"}
points per hand** by the Monte Carlo player's own evaluation.

The costliest disagreements this run:

${top.map((x) => "- " + x.text).join("\n")}

## Caveats

- Lessons are "better than the heuristic", not ground truth: rollouts are heuristic and
  determinized search cannot value information-gathering or deceptive plays.
- EV gaps are scored by the Monte Carlo player's own evaluation — a fair referee for
  card-technical spots, biased wherever its own blind spots live.
- Rates come from AI-vs-AI tables; human opponents bid and defend differently.

Regenerate after any accepted AI change: \`HANDS=400 node ai-bench/insights.mjs\`.
`;

fs.writeFileSync(path.join(dir, "..", "BEST-PRACTICES.md"), md);
console.error("wrote BEST-PRACTICES.md (" + M.decisions + " decisions, " +
  M.disagree[0] + " disagreements)");
