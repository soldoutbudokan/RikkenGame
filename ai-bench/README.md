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
HANDS=4000 SHARDS=4 node ai-bench/pscreen.mjs   # parallel pooled screen (not the gate)
HANDS=2000 SHARDS=4 node ai-bench/pctrl.mjs Rikken.jsx Rikken.jsx   # control table
node ai-bench/refprobe.mjs          # decision quality vs a deep reference (paired)
DEALS=1500 node ai-bench/bidtally.mjs   # does a change move the auction?
HANDS=12 node ai-bench/timeprobe.mjs    # per-decision wall clock vs the ~150 ms budget
# paired against the CLAIRVOYANT answer — the default upstream instruments
HANDS=400 SHARDS=4 node ai-bench/truthprobe.mjs Rikken.jsx alt.jsx  # card decisions
HANDS=800 SHARDS=4 node ai-bench/bidprobe.mjs Rikken.jsx alt.jsx    # bid decisions
HANDS=600 SHARDS=4 node ai-bench/bidcalib.mjs   # did an estimator change move MC_BID_CALIB's scale?
HANDS=90 node ai-bench/shapeprobe.mjs   # are sampled worlds shaped like real hands?
HANDS=120 node ai-bench/beliefprobe.mjs # are trump beliefs calibrated, given what is public?
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

A second warning, from the 2026-07-26 session — **do not shrink the candidate
list in `aiChooseCardHardest` without re-tuning the escalation ladder in the
same change.** Collapsing strategically identical cards (same suit, every rank
between them already played or also in hand) is exact in theory and cuts the
mean decision time by ~15%, but measured against `origin/main`'s ladder it
came in at **-0.36 pts/hand** on its own and **-0.47** with candidate racing
added. The mechanism is the ladder itself: `top2gap()` normally sees a
near-zero gap because the top two candidates are two cards of the same run,
so the extra batches almost always fire and a real decision gets the full
depth. Remove the duplicates and the gap between genuinely different cards
clears the first threshold immediately, so most decisions silently drop to a
single batch. Cheaper per decision, much weaker overall.

Also tried and dropped that session: making the last-resort rollout lead in
`mcPolicy` prefer a side suit over the globally lowest card (so the policy
never volunteers a trump off-plan). Sound-looking, cost-free, and it does not
move the auction (bid tallies identical over 800 hands) — but the branch
carrying it screened **-0.130 +/- 0.255** on `match.mjs` at HANDS=2500 while a
4000-hand `pscreen` of the identical code read **+0.155 +/- 0.202**. Two draws
of one quantity ~1.8 s.e. apart: a useful reminder that at this branch's
effect size a single 2500-hand screen barely constrains anything, and the keep
rule is a coin-flip filter unless the idea is worth more than the MDE.

From the 2026-07-27 session, on `explore.mjs` itself: **`playHands` never
yields to the event loop**, so a shard's `fs.createWriteStream` is not even
opened until the run ends — every record sits in memory and the `.jsonl`
appears only at exit. Do not plan on fitting partial shard output, and do not
conclude a long shard is broken because its file is missing.

Same session, on the randomized window: `explore`'s bid/pass cut used to be
drawn from `[-1.2, 1.2)`, which spends most of its samples on EVs that bid
either way and leaves the region around the live floor thin. Aiming the window
at the boundary instead (now `[-2.4, 0]` for the non-abondance families) put
~4x more decisions on both arms in the bins that decide where the floor
belongs; 16,000 hands / 7,509 decisions was enough to re-derive it. The bid
line came back on top of the 2026-07-19 fit (rik: a -1.16 / b 0.867 vs
-1.170 / 0.874), so re-fitting coefficients was not the point — extending the
covered range was. Re-aim the window at whatever boundary is in question
before spending hours on a wide run.

That produced the branch's rik/rik_beter floor move (-0.5 -> -1.5); numbers
and reasoning live in the `MC_BID_CALIB` comment. Worth noting what it cost to
learn: the change is worth roughly +1.8 points on the ~4% of rik decisions it
touches, i.e. **~+0.04 pts/hand** end to end — a sixth of this gate's MDE. The
8000-hand `pscreen` of the branch carrying it read +0.089 +/- 0.070 against
+0.159 +/- 0.081 for the branch without it: a 0.65 s.e. move, which is what a
0.04-point change looks like through a 0.107-point measuring stick. The keep
decision rested on the randomized experiment, not on the screen. Generalise:
**when a change's predicted size is well under the MDE, decide it upstream in
the randomized data and use the screen only to rule out a large regression.**

The 2026-07-28 session built the card-play counterpart of that upstream
measurement, `refprobe.mjs`: take real self-play decisions, rank every legal
card on a 400-world reference, and score a candidate sampling SCHEDULE by how
much EV its answer gives up against that ranking — **paired on the same
decision**, which is what makes it powerful. 1,284 early decisions resolve a
0.0075-point-per-decision difference at 2.6 s.e.; the 4000-hand screen that
would have to detect the same change end to end has a 0.10-point s.e. and
cannot. Budget: about 12 minutes on 4 cores versus 40 for a screen.

Two other cheap instruments from the same session, both worth running before
any long benchmark. `bidtally.mjs` replays the auction only (no card play) over
shared deals for two AI files: a change to `mcPolicy` feeds `mcBidRollout`, so
it can silently invalidate `MC_BID_CALIB`, and 1500 deals of auction-only
self-play costs one minute against the hours a re-fit costs. `timeprobe.mjs`
reports the per-decision wall clock the ~150 ms budget is about — note that the
budget is already a *mean* claim, not a worst case: trick-1 decisions average
~100 ms and the p95 is over 200 ms.

Negative result from that session, both screened at 4000 hands on top of this
branch. (1) Preferring an unbeatable TRUMP lead over an equally unbeatable side
winner in `mcPolicy`, whenever our side holds the trump majority and the
enemies still hold trumps — textbook draw-trumps-before-cashing, and it fires
on 11% of unbeatable-lead nodes — screened **-0.011 +/- 0.099**. (2) Dealing
each unplaced card in `mcSampleWorld` in proportion to how many cards a hand
still needs, instead of one-seat-one-vote: strictly the better sampler on
paper, since a seat void in the suit being placed sits out those rounds and
must take a larger share of everything else. Screened **+0.020 +/- 0.099**.
Neither is evidence of harm — each is a coin-flip read at this precision — but
neither cleared the keep rule, so neither is on the branch. If you want to
revisit them, measure them upstream first: (1) is a `mcPolicy` change and
therefore needs `bidtally.mjs` (it came back clean: 1467 declared contracts
either way, rik family 1226 vs 1225), (2) is sampler-only and moves no bid.

## 2026-07-29: measure against the truth, not against yourself

`refprobe.mjs` scores a search schedule against a deep reference built with
the *same* sampler, so it can only ever see budget changes — improve
`mcSampleWorld` and the reference moves with the candidate. The 2026-07-29
session replaced it as the default instrument with `truthprobe.mjs`, which
scores against the CLAIRVOYANT answer instead. In self-play the harness knows
the real deal, so every legal card can be played out in the ACTUAL world with
`mcRollout`; that is what a perfect sampler converges to, it needs no
reference search at all (legal-many deterministic rollouts, cheaper than one
extra batch of the ladder), and each variant's loss is
`max_c trueEV(c) - trueEV(its card)`, paired on the decision. 400 hands gives
~16,000 paired decisions in 10 minutes at a standard error near **0.006
points per decision** — against 0.10 pts/hand for a 4000-hand screen that
takes 40. For scale, crippling the search to a single 8-world batch costs
+0.0986, so 0.006 resolves a twentieth of a catastrophe.

Two supporting probes: `shapeprobe.mjs` compares the suit-shape profile of
sampled worlds against the true hands, and `beliefprobe.mjs` does the same for
trump beliefs split by the public facts that should move them.

What that bought, in one session, is a map of where the card player's losses
are **not**:

- **The card search is saturated.** Quadrupling every rung of the ladder
  (184 ms per decision against 47) is worth **-0.0046 +/- 0.0086**. Scaling
  the budget by rollout cost, `13 / cardsRemaining`, so the cheap late-hand
  decisions get proportionally more worlds: **-0.0134 +/- 0.0103**. Stop
  spending on search width or depth; it is not where the points are.
- **The sampler's flatness does not cost points**, even though it is real.
  `shapeprobe` confirms the mismatch the realistic shuffle predicts: defender
  hands come out flatter than truth (variance 2.451 vs 2.261, voids 22.4% vs
  19.2%, 5+ suits 6.44% vs 5.80%; the declarer matches, because
  `mcApplyBidInference` already shapes it). A Polya-urn clumping term that
  closes the gap measures **+0.0064 +/- 0.0060** at strength 0.15 and
  **-0.0030 +/- 0.0054** at 0.40. Matching moments is not the same as making
  better decisions — do not accept a sampler change on `shapeprobe` alone.
- **"He showed out and didn't ruff" is a real but worthless signal.**
  `beliefprobe` finds the sampler's trump beliefs mis-calibrated exactly where
  theory says: a defender who has already failed to follow a side suit is out
  of trumps 60.5% of the time in truth but only 53.4% in sampling (n=2168),
  while a defender who has shown nothing is over-voided (18.4% vs 20.8%).
  Down-weighting trump placement for seats that have shown a void fixes the
  cell and measures **+0.0028 +/- 0.0063** / **+0.0059 +/- 0.0058**. Null.

And the diagnostic that explains all three, run by letting `mcSampleWorld`
peek (cheating variants, never committed): revealing ONE opponent's hand is
worth **-0.139 +/- 0.014** per decision, revealing all three **-0.342**.
Information is the binding constraint by a factor of twenty over search — but
the large remaining source of it is play-by-play inference, and the `game`
object the AI is handed carries only `voids` and `playedCount`, not the trick
history a real counting player uses. Everything the public state still allows
has now been tried and measured null. **Treat the card player as done until
the game state itself carries more.**

So the bidder is where the edge is, and `bidprobe.mjs` is the matching
instrument: it scores an auction decision against an unpruned 400-world
reference, comparing options the way `mcChooseBid` does (calibrated value,
passing valued on the same family's pass line), paired per decision. It found
the bidder was NOT saturated — the old 12-world pre-pass picked the
reference's best option only 65.9% of the time. The prune was innocent
(removing it: **-0.0034 +/- 0.0075**); estimator noise was guilty (200 worlds:
**-0.0452 +/- 0.0067**, 6.7 s.e., best-option rate 79.0%). Note the bid/pass
CALL was already right 98.5% of the time — what the noise was wrecking is
*which* contract, trump and called card get chosen.

`bidcalib.mjs` is the check that made shipping that safe without re-running
`explore`. A less noisy estimator moves the coordinates `MC_BID_CALIB`'s
floors are written in, and the reflex is a full re-derivation — hours. But the
randomized experiment already answered where the threshold belongs in TRUE-EV
space; all that was needed was the coordinate change. Regressing each
procedure's chosen-option EV on an 800-world reference over 1,078 real
decisions (so the winner's curse is absorbed, not just the noise) gives slope
**0.9826 +/- 0.0065** for the old schedule and **0.9915 +/- 0.0035** for the
new one. Both sit a hair under 1: there was almost no regression dilution to
undo, rik's -1.5 floor becomes -1.526 and rik9plus's -0.3 becomes -0.337, and
at the floor elasticity of the 2026-07-27 session that is ~0.001 pts/hand.
`bidtally` agrees — 2444 declared contracts against 2435 over 2500 shared
deals, the shift landing on the mix (rik -36, rik9 +17, rik_beter +22) rather
than on how often anyone bids. **Generalise: when a change moves an estimator
rather than a policy, measure the coordinate change before assuming the fit
died with it.**

Branch state after that session: the 200-world bidder was KEPT (2500-hand
`match.mjs`, branch vs frozen baseline, **+0.221 +/- 0.127** pts/hand, so
mean - 1 s.e. = +0.094 > 0; win rate 52.9%, 0 violations, control -0.134
against a 3 s.e. band of 0.732). It is not a promotion: mean - 2 s.e. =
-0.033, and 0.221 is under the 0.30 trigger for spending a 6000-hand
confirmation, so no confirmation was run and `main` is untouched. Note what
this screen cannot tell you — the upstream measurement says the bid change is
worth ~0.045 predicted points on ~1.4 selection decisions per hand, which is
well inside this screen's noise. The +0.221 is the whole branch's accumulated
margin read through a 0.127 standard error, not a measurement of this change.

## 2026-07-30: the branch had no edge, and one screen cannot tell you it does

Read this before trusting any number above it. The 2026-07-29 entry closes by
recording the branch at **+0.221 +/- 0.127** on a 2500-hand `match.mjs`. That
number is wrong — not miscomputed, just a lucky draw. Re-measured this session
on 6000 pooled hands (`HANDS=6000 SHARDS=4 node ai-bench/pscreen.mjs <file>`,
same estimator, same frozen baseline, 35 minutes on 4 cores):

| candidate | pooled 6000-hand screen | win rate |
|---|---|---|
| branch head before this session (`1e08756`) | **-0.095 +/- 0.081** | 48.8% |
| branch head after this session (`285aa5c`) | **-0.007 +/- 0.081** | 49.7% |

So everything accumulated on `ai-candidate` to date is worth about zero against
`baseline.jsx`, and the recorded +0.221 was a 2.5 s.e. excursion from that. The
practical consequences:

- **Do not promote off a single 2500-hand `match.mjs`.** Its s.e. is ~0.127; a
  branch whose true margin is 0 clears the 0.30 trigger roughly one run in ten,
  and a REJECT-then-retry habit turns that into a certainty. Spend the 35
  minutes on a 6000-hand `pscreen` first — same estimator, se 0.081, four cores
  instead of one — and let `match.mjs` be the ceremony, not the evidence.
- **The keep rule (mean - 1 s.e. > 0 at 2500) is a coin flip on this branch.**
  Three screens of near-identical code this session: +0.195, -0.090, -0.158.
  Nothing in the code changed by more than a predicted 0.08 pts/hand between
  them. Keeping and reverting on that basis is close to a random walk; the
  attempt below was kept because it passed, and it survives the pooled re-read
  (the +0.088 +/- 0.115 gap between the two rows above is the right sign and
  the right size), but that is luck confirming a decision, not the decision
  being sound.

### Three attempts at the bidder's OPTION SET, one kept

The 2026-07-29 session established that the card player is saturated and the
bidder is not, and that the bidder's own *budget* was the fixable part. What it
did not look at is the option set `mcBidOptions` hands to `mcBidEVs`. Three
holes in it, all measured with `bidprobe.mjs` driving from the WIDE file so the
400-world reference covers the wider set:

1. **Which ace the rik calls.** One called card per trump suit (two when only
   one suit qualified), picked by "call where we are short". Offering all of
   them and paying for the wider field with a staged cut (fields of 4+ pruned
   to 3 after 60 of the 200 shared worlds) measures **+0.0560 +/- 0.0080**
   (7.0 s.e.), best-option rate 69.3% vs 59.9%. `bidtally`: 2446 declared
   contracts vs 2448, so the ecology and `MC_BID_CALIB` are untouched.
   2500-hand screen +0.195 +/- 0.125 — **KEPT** (`285aa5c`).
2. **Which ace a rik 9+ overcall calls.** The overcall took
   `callableCards(hand, l.s)[0]` — first in SUITS order, i.e. an arbitrary
   partner — and only from the first strong suit, on 32% of declared contracts.
   Widening it the same way measures **+0.0473 +/- 0.0069** (6.9 s.e.) over
   attempt 1, with the ecology again flat (2446 vs 2447 declared). The 2500
   screen came back **-0.090 +/- 0.126**, win rate 48.4% — fails the keep rule,
   **REVERTED**.
3. **6-card trump suits with no A/K/Q.** The `length >= 5 && honours >= 1` gate
   left 5.2% of hands with no option at all despite holding six of a suit — a
   forced pass the estimator was never asked about. Widening to
   `length >= 6 || (length >= 5 && honours >= 1)` measures **+0.0396 +/-
   0.0081** (4.9 s.e.), and the mechanism is visible in the bid/pass CALL, not
   the ranking: same-call against the reference goes 96.0% -> 99.3%. Ecology
   moves more here (declared 2461 vs 2446, rik -60 / rik_beter +61, redeals 39
   vs 54) but the count barely shifts, so the mix argument of 2026-07-29
   applies. The 2500 screen came back **-0.158 +/- 0.130**, win rate 46.8% —
   **REVERTED**.

Attempts 2 and 3 are *not* shown to be harmful: each screen's s.e. is 0.126 and
each predicted effect is ~0.07-0.08, so both reads are consistent with the
predicted small gain. They were reverted because the keep rule says so. If you
want them back, the honest way is a 6000-hand `pscreen` of each on top of the
branch, not another 2500-hand roll.

**The open methodological question they raise.** `bidprobe`'s reference shares
the candidate's `MC_BID_CALIB` *and* takes a max over the option set on 400
noisy worlds. Widening the set therefore inflates `bestValueAvailable` by the
reference's own winner's curse, which shows up as "loss the narrow file is
giving up" whether or not the extra options are really better. The measured
0.04-0.056 effects are the same order as that bias plausibly is. Before
spending another session on option-set width, settle this: re-run one of the
widenings at REF=1200 and see whether the advantage shrinks. If it does, the
instrument needs a de-biased reference (split the worlds — select the best
option on one half, value it on the other).

### Negative result: the bid search schedule is saturated

Four schedules for spending the 200 shared worlds, all measured against the
same reference: cut to 4 instead of 3 after 60 worlds; no prune at all; a
successive-halving ladder (cut to 4 at 40, to 2 at 120); and stratifying the
rollout leader as `k % 4` instead of drawing it at random (free variance
reduction, no ecology change). The first pass over 838 decisions liked two of
them — KEEP=4 at **-0.0168 +/- 0.0068** (2.5 s.e.) and stratified leaders at
**-0.0122 +/- 0.0067** (1.8 s.e.). A replication on 1257 fresh decisions
returned **-0.0005 +/- 0.0045** and **+0.0085 +/- 0.0051**. Neither survives.

That is the whole lesson: taking the best of four ~2 s.e. readings and shipping
it is selection, not measurement. `bidprobe` is cheap — 15-20 minutes for 900
hands on 3 cores — so replicate anything under 3 s.e. before it reaches a
commit message. The prune (60 worlds, keep 3) stands as written.

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
