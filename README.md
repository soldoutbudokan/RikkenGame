# RikkenGame

A playable version of **Rikken**, the Dutch trick-taking card game, as a single
self-contained React component: [`Rikken.jsx`](Rikken.jsx).

## Running it

`Rikken.jsx` has a default export, takes no props, keeps all state in React
state, and styles itself with Tailwind — drop it into any React + Tailwind
project and render `<Rikken />`. No other setup, no external state libraries,
no storage.

## Modes

- **Solo** — you against three rule-based AI opponents.
- **Hot seat** — 2–4 humans sharing one screen; AI fills empty seats. A
  "pass the device" curtain hides every hand between human turns.

## Ruleset

The exact ruleset in play is shown by the in-game **Rules** button. Every
tunable rule (deal pattern, contract targets and values, forced trumping,
troela) lives in the `RULES` object at the top of `Rikken.jsx`, so a regional
variant is a one-place edit.

## Code layout (all in `Rikken.jsx`)

1. `RULES` — the tunables.
2. Rules engine — pure functions: deal, troela detection, auction ranking,
   legal moves, trick winner, scoring (asserted zero-sum), early hand ends.
3. AI — heuristic bidding and sound card play; `casual` or `sharp` skill.
4. Game flow — pure `state -> state` transitions.
5. UI — table, bidding panel, trump/called-ace pickers, side panel,
   hand-end summary.
