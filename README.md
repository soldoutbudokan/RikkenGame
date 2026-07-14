# RikkenGame

A playable version of **Rikken**, the Dutch trick-taking card game, as a single
self-contained React component: [`Rikken.jsx`](Rikken.jsx).

## Play it

Deployed with GitHub Pages: https://soldoutbudokan.github.io/RikkenGame/

How it works — the ruleset, the realistic shuffle, the AI and its benchmark,
online privacy: https://soldoutbudokan.github.io/RikkenGame/about.html
(source: [`about.html`](about.html)).

Every push to `main` rebuilds and redeploys the site via
`.github/workflows/deploy-pages.yml` (`npm ci && npm run build` -> `dist/`).

## Running it

`Rikken.jsx` has a default export, takes no props, keeps all state in React
state, and styles itself with Tailwind — drop it into any React + Tailwind
project and render `<Rikken />`. No other setup, no external state libraries,
no storage.

## Modes

- **Solo** — you against rule-based AI opponents.
- **Hot seat** — 2-6 humans sharing one screen; AI fills empty seats. A
  "pass the device" curtain hides every hand between human turns.
- **Online** — host a table and invite up to three friends with copy-paste
  codes. Peer-to-peer over WebRTC, no server: the host runs the game and
  each guest only ever receives their own cards.

Tables hold 4-6 players; every hand is played by four, with the dealer
(and, with six, the player opposite) sitting out.

## Ruleset

The exact ruleset in play is shown by the in-game **Rules** button. Every
tunable rule (deal pattern, contract targets and values, forced trumping,
troela) lives in the `RULES` object at the top of `Rikken.jsx`, so a regional
variant is a one-place edit.

## Code layout (all in `Rikken.jsx`)

1. `RULES` — the tunables.
2. Rules engine — pure functions: deal, troela detection, auction ranking,
   legal moves, trick winner, scoring (asserted zero-sum), early hand ends.
3. AI — heuristic bidding and sound card play; `casual`, `sharp`, or
   `hardest` skill (hardest plays determinized Monte Carlo: it samples
   worlds consistent with public information and rolls every legal card
   out to the end of the hand).
4. Game flow — pure `state -> state` transitions.
5. UI — table, bidding panel, trump/called-ace pickers, side panel,
   hand-end summary.

## AI benchmark (`ai-bench/`)

`ai-bench/` pits the AI in the working tree against a frozen snapshot of
the last accepted AI (`ai-bench/baseline.jsx`) at the same table, and only
a statistically clear win counts — see `ai-bench/README.md`. Used to gate
every AI-strength change.
