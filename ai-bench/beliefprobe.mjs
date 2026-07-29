// Belief probe: is the sampler's TRUMP belief calibrated, split by the two
// public facts that should move it?
//
//   HANDS=90 WORLDS=6 node ai-bench/beliefprobe.mjs [candidatePath]
//
// `truthprobe.mjs` says knowing one opponent's hand exactly is worth about
// 0.14 points per decision, so information — not search budget, not world
// shape — is what the card player is short of. The AI may not look at hidden
// state, but two public facts are already in `game` and go unused for anybody
// except the declarer:
//
//   voids[p][S]        p failed to follow suit S at some point
//   playedCount[p][T]  how many trumps p has actually played
//
// A seat that has already been unable to follow a side suit had the chance to
// ruff that trick and did not take it. Under this AI's own rollout policy a
// ruff is taken whenever it wins and survives, so declining one is evidence of
// having no trump — the ordinary "he showed out and didn't ruff, he's out of
// trumps" count that every strong player keeps and this sampler does not.
//
// This measures the gap: for every unknown seat, the true number of trumps it
// holds versus the number the sampler gives it, split by whether the seat has
// shown a void and whether it has played a trump. A calibrated sampler matches
// truth in every cell; a gap in the "shown a void, no trump played" cell is
// exactly the unused signal.
import { fileURLToPath } from "url";
import path from "path";
import { loadAI, playMatch } from "./harness.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const mod = loadAI(process.argv[2] || path.join(dir, "..", "Rikken.jsx"));
const HANDS = +(process.env.HANDS || 90);
const WORLDS = +(process.env.WORLDS || 6);
const [LO, HI] = (process.env.LEFT || "3,11").split(",").map(Number);
const SUITS = ["S", "H", "C", "D"];

// cells keyed by `${shownVoid}|${playedTrump}` -> tallies
const cells = new Map();
const cell = (k) => {
  if (!cells.has(k)) cells.set(k, { n: 0, tSum: 0, tVoid: 0, sN: 0, sSum: 0, sVoid: 0 });
  return cells.get(k);
};

playMatch(mod, mod, HANDS, {
  chooseCard: (m, seat, game) => {
    const left = game.hands[seat].length;
    const c = game.contract;
    const trump = game.trump != null ? game.trump : c.trump;
    if (trump && left >= LO && left <= HI) {
      const unknown = [0, 1, 2, 3].filter((s) => s !== seat && s !== game.openHand);
      const key = (p) => {
        const sv = SUITS.some((S) => S !== trump && game.voids[p][S]) ? "void" : "novoid";
        const pt = (game.playedCount[p][trump] || 0) > 0 ? "playedT" : "noT";
        return sv + "|" + pt + "|" + (p === c.declarer ? "decl" : "def");
      };
      const nT = (h) => h.filter((x) => x.s === trump).length;
      for (const p of unknown) {
        const b = cell(key(p));
        b.n++; b.tSum += nT(game.hands[p]); if (!nT(game.hands[p])) b.tVoid++;
      }
      for (let k = 0; k < WORLDS; k++) {
        const w = mod.mcSampleWorld(seat, game, Math.random);
        if (!w) continue;
        for (const p of unknown) {
          const b = cell(key(p));
          b.sN++; b.sSum += nT(w[p]); if (!nT(w[p])) b.sVoid++;
        }
      }
    }
    return m.aiChooseCard(seat, game);
  },
});

console.log(JSON.stringify({ hands: HANDS, worldsPerNode: WORLDS, cardsLeft: [LO, HI] }));
console.log("cell".padEnd(24) + "   n     true trumps  sampled   |  true void%  sampled");
for (const [k, b] of [...cells.entries()].sort()) {
  if (!b.n || !b.sN) continue;
  console.log(k.padEnd(24) + String(b.n).padStart(6) +
    "   " + (b.tSum / b.n).toFixed(3).padStart(6) +
    "  " + (b.sSum / b.sN).toFixed(3).padStart(7) +
    "   |  " + (100 * b.tVoid / b.n).toFixed(1).padStart(5) + "%" +
    "  " + (100 * b.sVoid / b.sN).toFixed(1).padStart(6) + "%");
}
