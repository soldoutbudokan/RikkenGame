# ai-bench — proving the "hardest" AI got stronger

This directory exists so improvements to the Rikken AI are **measured, not
claimed**. It pits the AI currently in `../Rikken.jsx` (the *candidate*)
against a frozen snapshot of the last accepted version (`baseline.jsx`) at
the same table, and only a statistically clear win counts.

## Commands (run from the repo root)

```
node ai-bench/sanity.mjs            # invariants: legal plays, zero-sum, terminates
HANDS=2500 node ai-bench/match.mjs  # candidate (seats 0+2) vs baseline (seats 1+3)
HANDS=400 node ai-bench/insights.mjs  # regenerate ../BEST-PRACTICES.md from the candidate
node ai-bench/explore.mjs           # self-play data pipeline for tuning the bidder
```

`explore.mjs` replays the benchmark table with seat 0's bid/pass cut
randomized, logging every decision with its realized score — a randomized
experiment over bid thresholds (`explore`), plus declarer hand-shape
mining (`beliefs`) and a per-family regression fit (`fit`). One structural
warning from the 2026-07-19/20 tuning session: this gate's minimum
detectable effect at HANDS=2500/6000 is roughly +0.25 points/hand, so
several individually-real small improvements (measured ≈ +0.2 pooled) can
each fail it — batch small gains into one candidate, or raise HANDS,
before concluding an idea is worthless (see branch `ml-bid-calibration`).

`match.mjs` prints per-table stats plus a final JSON line and exits 0 only
on **ACCEPT**, which requires all of:

- candidate mean points/hand vs baseline **minus 2 standard errors > 0**;
- candidate wins **> 50%** of the hands that move money;
- **zero** rule violations (an illegal choice is auto-corrected but disqualifies);
- the candidate-vs-itself control table shows no bias (|mean| ≤ 3 s.e.).

## Accepting an improvement

1. `node ai-bench/sanity.mjs` passes.
2. `HANDS=2500 node ai-bench/match.mjs` says ACCEPT.
3. Copy the new AI over the baseline: `cp Rikken.jsx ai-bench/baseline.jsx`
4. Regenerate the strategy notes: `HANDS=400 node ai-bench/insights.mjs`
   (rewrites `../BEST-PRACTICES.md` from the newly accepted AI).
5. `npm ci && npm run build` still succeeds.
6. Commit the files with the measured margin in the message; push to main.

If the verdict is REJECT, revert `Rikken.jsx` and do **not** push —
`BEST-PRACTICES.md` included.

## Rules for AI changes

- Only the code **above the `==== AI END ====` marker** in `Rikken.jsx` may
  change strength (bid heuristics, card heuristics, the Monte Carlo player:
  `mcSampleWorld` / `mcPolicy` / `mcRollout` / `aiChooseCardHardest`).
- Do **not** change game rules, scoring, contracts, or the UI in the same
  change — the benchmark assumes both sides play the same game (the
  candidate's engine referees the table).
- Keep the function names listed in `harness.mjs` (`EXPORTS`) defined above
  the marker — the loader and any older baseline depend on them.
- The AI must never read hidden state: opponents' actual hands are off
  limits except through `mcSampleWorld`-style sampling of *public*
  information (own hand, played cards, shown voids, revealed partner, an
  open misère hand).
- Keep a single decision under ~150 ms so the UI stays responsive
  (`aiThinkMs` is 700 ms).
