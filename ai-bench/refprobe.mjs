// Reference probe: how often does a sampling SCHEDULE pick the card a much
// deeper search would pick, and what does the miss cost?
//
//   HANDS=40 REF=400 LEFT=3,8 node ai-bench/refprobe.mjs [candidatePath]
//
// Why this exists: at this branch's effect sizes a 4000-hand match screen has
// a standard error near 0.10 pts/hand, so it cannot resolve a search-budget
// change. Decision quality can be measured directly and far more cheaply —
// take real self-play decisions, compute a REF-world reference ranking over
// every legal card, and ask which schedule's answer agrees with it. Same
// method the aiChooseCardHardest comment cites for its 32-vs-48 first pass.
//
// The reference draws its OWN worlds, so a schedule cannot score well merely
// by sharing the reference's sampling noise.
import { fileURLToPath } from "url";
import path from "path";
import { loadAI, playMatch } from "./harness.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const candPath = process.argv[2] || path.join(dir, "..", "Rikken.jsx");
const mod = loadAI(candPath);
const HANDS = +(process.env.HANDS || 40);
const REF = +(process.env.REF || 400);
const [LO, HI] = (process.env.LEFT || "3,8").split(",").map(Number);
const MINLEGAL = +(process.env.MINLEGAL || 3);

// Schedules under test. A schedule is a comma-separated list of stages
// `keep:worlds@gap`: enter the stage only while the top-two gap per world is
// still under `gap`, cut the field to the best `keep` cards, then sample
// `worlds` more shared worlds. Stage one keeps everything. The live ladder is
//   all:48,5:64@1.5,3:160@0.75
const SCHEDULES = (process.env.SCHEDULES ||
  "all:48,5:64@1.5,3:160@0.75").split("|").map((spec) => ({
    label: spec,
    stages: spec.split(",").map((st) => {
      const [head, gap] = st.split("@");
      const [keep, worlds] = head.split(":");
      return { keep: keep === "all" ? Infinity : +keep, worlds: +worlds,
        gap: gap === undefined ? Infinity : +gap };
    }),
  }));

function sampleTotals(seat, game, cards, n, totals, rng) {
  let got = 0;
  for (let k = 0; k < n; k++) {
    const w = mod.mcSampleWorld(seat, game, rng);
    if (!w) continue;
    got++;
    for (const card of cards)
      totals.set(card.id, totals.get(card.id) + mod.mcRollout(w, seat, card, game));
  }
  return got;
}

function runLadder(seat, game, legal, sched) {
  const rng = Math.random;
  const ordered = legal.slice().sort((a, b) => a.r - b.r);
  const totals = new Map(ordered.map((x) => [x.id, 0]));
  let sampled = 0;
  const rank = (cs) => cs.slice().sort((a, b) => totals.get(b.id) - totals.get(a.id) || a.r - b.r);
  const gap = (cs) => {
    const r = rank(cs);
    return r.length < 2 ? Infinity : (totals.get(r[0].id) - totals.get(r[1].id)) / Math.max(1, sampled);
  };
  let live = ordered;
  for (let i = 0; i < sched.stages.length; i++) {
    const st = sched.stages[i];
    if (i > 0) {
      if (!(gap(live) < st.gap)) break;
      live = rank(live).slice(0, st.keep);
    }
    sampled += sampleTotals(seat, game, live, st.worlds, totals, rng);
    if (!sampled) return null;
  }
  return rank(live)[0];
}

const stats = SCHEDULES.map(() => ({ agree: 0, loss: 0, ms: 0, d: [] }));
let decisions = 0;

playMatch(mod, mod, HANDS, {
  chooseCard: (m, seat, game) => {
    const c = game.contract;
    const trump = game.trump != null ? game.trump : c.trump;
    const legal = m.legalMoves(game.hands[seat], game.trick, trump, c);
    const left = game.hands[seat].length;
    if (legal.length >= MINLEGAL && left >= LO && left <= HI) {
      const rng = Math.random;
      const refT = new Map(legal.map((x) => [x.id, 0]));
      const got = sampleTotals(seat, game, legal, REF, refT, rng);
      if (got) {
        const ev = (x) => refT.get(x.id) / got;
        const best = legal.reduce((a, b) => (ev(b) > ev(a) ? b : a));
        decisions++;
        const losses = SCHEDULES.map((sched, i) => {
          const t0 = process.hrtime.bigint();
          const pick = runLadder(seat, game, legal, sched);
          stats[i].ms += Number(process.hrtime.bigint() - t0) / 1e6;
          if (!pick) return 0;
          if (pick.id === best.id) stats[i].agree++;
          const l = ev(best) - ev(pick);
          stats[i].loss += l;
          return l;
        });
        // paired against schedule 0: the same decision, so per-decision
        // difficulty cancels and the comparison needs far fewer samples
        for (let i = 1; i < SCHEDULES.length; i++) stats[i].d.push(losses[i] - losses[0]);
      }
    }
    return m.aiChooseCard(seat, game);
  },
});

console.log(JSON.stringify({ hands: HANDS, ref: REF, cardsLeft: [LO, HI], decisions }));
SCHEDULES.forEach((sched, i) => {
  const s = stats[i];
  let paired = "";
  if (i > 0 && s.d.length) {
    const n = s.d.length, m = s.d.reduce((a, b) => a + b, 0) / n;
    const se = Math.sqrt(s.d.reduce((a, b) => a + (b - m) ** 2, 0) / n) / Math.sqrt(n);
    paired = "  paired dLoss " + m.toFixed(4) + " +/- " + se.toFixed(4);
  }
  console.log(sched.label.padEnd(34) +
    " agree " + (100 * s.agree / decisions).toFixed(1) + "%" +
    "  mean EV loss " + (s.loss / decisions).toFixed(4) +
    "  mean ms " + (s.ms / decisions).toFixed(1) + paired);
});
