// Shape probe: do the worlds `mcSampleWorld` invents have the same suit shape
// as the hands the deal actually produces?
//
//   HANDS=60 WORLDS=4 node ai-bench/shapeprobe.mjs [candidatePath]
//
// RULES.shuffle is "realistic" on purpose: two sloppy riffles and a cut leave
// trick clumps alive, so dealt hands run longer in their best suit than a
// uniform shuffle gives (the RULES comment measures 5.2 vs 4.9, and 7+ card
// suits at 10% vs 4%). `mcSampleWorld` re-deals the unseen cards with
// `shuffle()` — the uniform Fisher-Yates — and hands each card to a uniformly
// chosen seat that still has room. If the residual hands are still clumped,
// every sampled world is systematically flatter than reality, and flat worlds
// under-price exactly the things that decide tricks: enemy voids and ruffs.
//
// This measures it directly. At each decision it takes the seats whose cards
// are unknown, and compares the true (suit, seat) count profile against the
// same profile in sampled worlds. Reported per group: the mean count (must
// match by construction — same cards, same hand sizes), the VARIANCE of the
// counts, the void rate, and the long-suit (5+) rate. Clumping shows up as
// higher variance, more voids and more long suits in truth than in sampling.
import { fileURLToPath } from "url";
import path from "path";
import { loadAI, playMatch } from "./harness.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const mod = loadAI(process.argv[2] || path.join(dir, "..", "Rikken.jsx"));
const HANDS = +(process.env.HANDS || 60);
const WORLDS = +(process.env.WORLDS || 4);
const [LO, HI] = (process.env.LEFT || "5,12").split(",").map(Number);
const SUITS = ["S", "H", "C", "D"];

const box = () => ({ n: 0, sum: 0, sq: 0, void0: 0, long5: 0 });
const add = (b, k) => { b.n++; b.sum += k; b.sq += k * k; if (k === 0) b.void0++; if (k >= 5) b.long5++; };
const groups = { trueDecl: box(), sampDecl: box(), trueDef: box(), sampDef: box() };
let nodes = 0;

playMatch(mod, mod, HANDS, {
  chooseCard: (m, seat, game) => {
    const left = game.hands[seat].length;
    if (left >= LO && left <= HI) {
      const c = game.contract;
      const unknown = [0, 1, 2, 3].filter((s) => s !== seat && s !== game.openHand);
      const count = (h, S) => h.filter((x) => x.s === S).length;
      nodes++;
      for (const p of unknown)
        for (const S of SUITS)
          add(p === c.declarer ? groups.trueDecl : groups.trueDef, count(game.hands[p], S));
      for (let k = 0; k < WORLDS; k++) {
        const w = mod.mcSampleWorld(seat, game, Math.random);
        if (!w) continue;
        for (const p of unknown)
          for (const S of SUITS)
            add(p === c.declarer ? groups.sampDecl : groups.sampDef, count(w[p], S));
      }
    }
    return m.aiChooseCard(seat, game);
  },
});

const line = (name, b) => {
  const mean = b.sum / b.n, varr = b.sq / b.n - mean * mean;
  return name.padEnd(12) + " n " + String(b.n).padStart(7) +
    "  mean " + mean.toFixed(3) + "  var " + varr.toFixed(3) +
    "  void " + (100 * b.void0 / b.n).toFixed(1) + "%" +
    "  5+ " + (100 * b.long5 / b.n).toFixed(2) + "%";
};
console.log(JSON.stringify({ hands: HANDS, nodes, worldsPerNode: WORLDS, cardsLeft: [LO, HI] }));
console.log(line("true decl", groups.trueDecl));
console.log(line("sampled decl", groups.sampDecl));
console.log(line("true def", groups.trueDef));
console.log(line("sampled def", groups.sampDef));
