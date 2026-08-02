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
HANDS=1200 SHARDS=4 node ai-bench/bidtruth.mjs Rikken.jsx alt.jsx    # bid decisions vs the TRUE deal
# the deterministic bid gates, which no estimator-driven probe can see
PLAY=280 KEY=misere WHICH=lowHand WORLDS=60 node ai-bench/gateprobe.mjs
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

## 2026-07-31: the option-set widenings were real; the 2500-hand screen was not

The 2026-07-30 session measured two widenings of `mcBidOptions` upstream at 4.9
and 6.9 s.e., screened each at 2500 hands, got **-0.090** and **-0.158**, and
reverted both under the keep rule. This session put them back, and the reason
is worth stating plainly: **at this branch's effect size the 2500-hand screen
decides almost nothing, and reverting on it discards real work.**

Replicated on 900 hands / 1,607 decisions, the two widenings as ONE change
against the branch head measure **+0.0819 +/- 0.0085 (9.6 s.e.)** on
`bidprobe`, best-option rate 66.2% vs 58.2%, same-call 98.8% vs 95.8% — very
close to the sum of last session's two separate readings (0.047 + 0.040). Then
extending the same principle to the two shape gates nobody had touched (below)
measures a further **+0.0792 +/- 0.0121 (6.6 s.e.)**. The screens of the same
code, in order taken:

| screen | code | result |
|---|---|---|
| 2500 `match.mjs` | first widening pair | **-0.060 +/- 0.124** (failed keep) |
| 6000 `pscreen.mjs` | full batch | **+0.170 +/- 0.082** |
| 2500 `match.mjs` | full batch | **+0.212 +/- 0.129** (kept) |

Read those three rows together. The first row failed the keep rule and the code
was reverted, exactly as the rule says; the second and third rows say the same
code is worth roughly +0.17 to +0.21. Nothing was learned between rows 1 and 3
that the upstream instrument had not already said at 9.6 s.e. **Spend the 30
minutes on a 6000-hand `pscreen` BEFORE the ceremonial `match.mjs`, and treat a
failed 2500-hand screen of an upstream-verified change as a null result, not as
evidence against it.** Note also the honest caveat on row 3: it re-screens code
that row 1 rejected, inside a larger change. Two overlapping screens of nested
changes is not two independent confirmations.

### What was widened

The principle is one line: **an extra card of length substitutes for a missing
honour.** `mcBidOptions` applied it nowhere; it now applies it in all three
shape gates.

- trump suit: `length >= 5 && honours >= 1` -> `length >= 6 || (length >= 5 && honours >= 1)`
- rik 9+ overcall: `length >= 6 && honours >= 2` -> `length >= 7 || (length >= 6 && honours >= 2)`
- abondance: `length >= 7 && honours >= 2` -> `length >= 8 || (length >= 7 && honours >= 2)`

plus every callable ace offered for a rik 9+ overcall and from every strong
suit, instead of `callableCards(hand, l.s)[0]` from the first suit only. In
both `bidprobe` runs the gain shows up in the bid/pass CALL rather than the
ranking (same-call 95.8% -> 98.8%, then 94.9% -> 99.0%): these were forced
passes the estimator was never asked about, not mis-rankings.

Ecology, 2500 shared deals against the branch head: declared contracts 2461 vs
2447, so bid FREQUENCY is unchanged and `MC_BID_CALIB`'s population argument
still holds. The MIX moves a lot — rik -133, rik9 +98, rik10 +66, rik11 +82,
rik_beter -55, troela -56 (troela is a deterministic gate; it drops because the
extra overcalls now outbid it). **Anyone re-deriving `MC_BID_CALIB` should know
that the rik9plus family's internal mix is no longer dominated by rik9.**
Bid decisions cost mean 22.1 ms / p99 79.3 ms over 3,076 auctions (branch head:
15.2 ms), well inside the ~150 ms budget.

### The open question from 2026-07-30, closed on paper

That session ended asking whether `bidprobe` flatters a WIDER option set,
because the reference takes a max over the set on 400 noisy worlds and its own
winner's curse inflates `bestValueAvailable`. It does inflate it — and it does
not matter, because the reported statistic is PAIRED:

    loss_i - loss_0 = (bestVal - got_i) - (bestVal - got_0) = got_0 - got_i

`bestVal` cancels exactly. Each file's `got` is the reference's value of the
option that file chose, and a file chooses on its own 200 worlds, drawn
independently of the reference's 400 — so there is no shared noise to exploit.
The one place reference noise does leak in is `passVal = c + d * ev[bi]`, which
uses the inflated argmax EV: a file that PASSES therefore looks slightly better
than it is. That runs the safe way here, since the narrow file is the one being
forced to pass. No REF=1200 run is needed; the absolute "ref loss" column is
biased upward for wide sets, the paired column is not.

### bidtruth.mjs — the clairvoyant referee for bids, and its limit

`bidprobe`'s reference is built with the candidate's OWN sampler, so it can
only ever answer budget questions: change how bid worlds are DRAWN and the
reference moves with the candidate. `bidtruth.mjs` is the auction's version of
`truthprobe.mjs` — in self-play the harness knows the real deal, so every
option is played out in the ACTUAL world (all four leaders averaged, since the
bidder is never told who leads) and compared on the same calibrated lines.
`playMatch`'s `chooseBid` hook now receives a fifth `{hands, dealer}` argument
for this; it is for clairvoyant referees only.

Validated against the widening, where `bidprobe` says +0.0819 +/- 0.0085:
`bidtruth` agrees in sign on every statistic (true loss 0.9151 vs 0.9508,
best-option 50.1% vs 47.5%, same-call 90.3% vs 87.3%) but reports
**+0.0357 +/- 0.0351**, one s.e. **Its precision is ~4x worse per decision**,
because one deal is a very noisy referee and an auction gives only ~1.9
decisions per hand against card play's ~40. 900 hands buys s.e. 0.035; matching
`bidprobe`'s 0.0085 would take ~15,000. So: **use `bidprobe` for budget and
option-set questions, and reach for `bidtruth` only for sampler questions,
where it is the only valid instrument — and size the run for 0.03, not 0.006.**

### Negative result: conditioning bid worlds on the standing high bid

46% of the auctions this AI actually thinks about happen over a live high bid,
and `mcBidEVs` dealt the unseen 39 cards uniformly regardless. Two versions
were built and neither is on the branch.

Rejection sampling on the shape gate the bid implies is **nearly a no-op**, and
the fill rates say why — the share of uniform worlds already satisfying "at
least one of the three unseen hands could have bid this" on the first draw:
rik 90.3%, rik_beter 44.3%, rik9+ 26.9%, abondance 6.6%, troela 13.0%, misère
0.8%, piek 0.8%. For the dominant case the predicate is simply not a
restriction: a 5-card suit with an honour is not rare across three hands.

So the constructive version was measured instead — pick one of the three unseen
hands at random (the bidder is never told which seat bid) and give it a trump
length and honour count drawn from `MC_BID_SHAPE`, the same mined
distributions `mcApplyBidInference` uses in card play, swapping only against
the other two unseen hands. It shapes correctly (max-suit-length over the three
hands moves 5:0.46/6:0.37 -> 5:0.38/6:0.43 for rik, honour-void 8.3% -> 2.7%,
no card ever duplicated) and it measures **-0.0277 +/- 0.0210 on `bidtruth`
over 1,800 hands / 3,149 decisions** — wrong sign at 1.3 s.e., best-option rate
50.0% vs 49.7%, same-call identical. No screen was spent on it. The lesson is
the fill table: what a bid PROVES about an opponent is much weaker than it
feels, because the gate is a weak predicate over three hands at once.

## 2026-08-01: the width argument runs out, and what was behind the door nobody opened

Three attempts, all kept, all in `mcBidOptions`. Two of them finish an
argument the 2026-07-31 session started; the third is worth more than the
other two put together and had been sitting untouched the whole time.

| # | change | `bidprobe` (paired) | branch after, 6000 `pscreen` | branch after, 2500 `match` |
|---|---|---|---|---|
| 1 | honours substitute for length: `length >= 4 && honours >= 3` in all three shape gates | +0.0312 +/- 0.0072 (4.3 s.e.) | +0.138 +/- 0.083 | +0.358 (ACCEPT) |
| 2 | drop the honour requirement on five-card suits entirely | +0.0332 +/- 0.0064 (5.2 s.e.) | +0.293 +/- 0.081 | +0.219 (REJECT) |
| 3 | price the fourth ace instead of taking it on reflex | not measurable by `bidprobe` | **+0.406 +/- 0.082** | +0.338 (ACCEPT) |

Branch total against the frozen baseline: **+0.406 +/- 0.082 pts/hand**
pooled over 6000 hands, win rate 54.9%, 0 violations — from +0.170 at the
start of the session.

### The width argument is finished, and `bidprobe` says so in one number

Attempts 1 and 2 are the mirror of 2026-07-31's "an extra card of length
substitutes for a missing honour": A/K/Q of a suit is three trump tricks and
control of it whatever the length, so `length >= 4 && honours >= 3` belongs in
every gate, and once both substitutions are in, the surviving `length >= 5 &&
honours >= 1` clause defends exactly one shape (a jack-high five-bagger)
against a hearing its neighbours on both sides get. The whole trump gate is now
`length >= 5 || (length >= 4 && honours >= 3)`.

Both gains land where the previous session's did — on the bid/pass CALL, not on
the ranking. Same-call against the 400-world reference went 96.1% -> 99.0%
(attempt 1) and 93.9% -> 98.7% (attempt 2). **That statistic is also the
stopping rule.** Same-call is the fraction of decisions where the file agrees
with the reference about whether to bid at all, and at 98.7% there is at most
1.3% of decisions left for any further widening to win — an eighth of what
attempt 1 had to work with. The best-option rate has meanwhile crawled 66.7% ->
67.8%, and that is the ranking problem, which 2026-07-29 showed is noise-bound
and does not respond to budget. **Do not spend another session on option-set
width. Read `same call` before proposing one.**

### `aiChooseBid`'s first line was never measured by anything

    if (aces >= 3 && legal.includes("troela")) return { key: "troela" };

Three aces ended the auction. 9% of declared contracts, no estimate of the hand
under any other contract, and `bidprobe.mjs` skips those decisions by
construction (`hand.filter(c => c.r === 14).length >= 3`) — so every instrument
in this directory was blind to it, and had been since the Monte Carlo bidder
was written.

Troela is not free: `RULES.troela.trumpFromFirstLead` means its trump is the
suit of the very first card led, so three times in four an opponent picks it. A
plain rik on the same hand names its own trump and calls the same missing ace —
identical partner, identical eight-trick per-trick target — so it dominates
troela by exactly the trump choice. Offered side by side on 200 shared worlds
over 120 three-ace hands with a qualifying suit, **the rik won 120 times, mean
margin +3.07 points.** Both contracts sit on the same calibrated family line,
so that number is raw rollout score and involves no calibration at all. The
rolled-out troela EVs are +0 to +5 — the bid is sound, it is simply beaten.

Shipping it needed three coupled pieces plus one invariant repair:
`mcBidOptions` offers `{key:"troela"}`; `mcBidRollout` learned the contract
(`troelaSetup` fixes partner/called/solo from the sampled deal, trump comes
from the first card led, `soloTroela` reaches `scoreHand`); `mcBidFamily` maps
troela onto the rik line. And `mcSampleWorld`'s `aceCap` encoded "a three-ace
hand would have bid troela" — now false for the seat that bid, still true for
the seats that passed, so the cap is exempted for the declarer only.

Ecology: declared contracts 2,483 vs 2,485 over 2,500 shared deals — bid
FREQUENCY is untouched, because a three-ace hand bids either way — and every
contract troela loses (226 -> 125) lands in a family that already has a fitted
line. `MC_BID_CALIB` needed no re-derivation.

**Generalise, because this is the transferable part.** The three-ace reflex
survived four sessions of increasingly careful measurement not because anyone
judged it sound but because *the instruments were built around it*. `bidprobe`
skips 3-ace hands; `explore.mjs` randomises a bid/pass cut that line returns
before reaching; `insights.mjs` reports card play. A deterministic shortcut
placed upstream of an estimator is invisible to every probe that drives through
the estimator. Before the next session tunes anything, **go read the early
returns of `aiChooseBid` and ask what evidence exists for each one** — the
misère, open-misère and piek gates are still hand-shape rules nobody has ever
priced, on ~3.5% of declared contracts between them. They are smaller than
troela was, and `mcBidRollout` already handles `trump: "none"` correctly, so
the mechanical work is done; what is missing is a calibrated line for the
misère family, which needs `explore.mjs`.

## 2026-08-02: the misère gate loses money, and the sampler's tables had gone stale

Two changes were built and measured this session, both against the freshly
promoted `main`. Both are verified upstream. Neither cleared the keep rule on a
screen, so **`Rikken.jsx` was reverted and `ai-candidate` carries no AI change**
— what it carries is `gateprobe.mjs` and this entry, which is where the work is.

| instrument | reading |
|---|---|
| `gateprobe` — misère gate as it stands, 280 played hands | **-5.46 +/- 0.83** declarer pts, made 31.8% |
| `gateprobe` — same hands, keeping only ev >= -1 | **+4.29 +/- 1.57**, made 64% |
| `truthprobe` — re-mined `MC_BID_SHAPE`, 400 hands | +0.0092 +/- 0.0060 (1.5 s.e.) |
| `truthprobe` — replication, 750 hands | +0.0134 +/- 0.0047 (2.8 s.e.) |
| `truthprobe` — pooled, 47,148 paired decisions | **+0.0118 +/- 0.0037 (3.2 s.e.)** |
| `bidtally`, 2500 shared deals | declared 2484 vs 2484, misère 10 vs 47 |
| 2500 `match.mjs` (both changes) | +0.025 +/- 0.124, win 50.5%, REJECT |
| 6000 `pscreen.mjs` (both changes) | +0.022 +/- 0.084, win 49.8% |
| the two screens pooled, 8,500 hands | **+0.023 +/- 0.070** |

### `gateprobe.mjs` — pricing a bid gate that no estimator ever sees

The 2026-08-01 entry ends by asking what evidence exists for `aiChooseBid`'s
early returns. The answer was none, and it could not have been otherwise:
`explore.mjs` lists the misère family in `DETERMINISTIC` and returns the gate
unpriced, `bidprobe`/`bidtruth` drive through `mcBidEVs`, and a screen sees
these gates on ~1% of hands. So this session built the probe that does not
drive through the estimator. Deal the way the table deals, keep the hands a
named gate fires on, force that contract, and play it out with the real AI in
all four seats. Dealing is nearly free and misère hands end the moment the
declarer wins a trick, so 280 priced gate hands cost about twenty minutes.

**The misère gate loses money.** Over 280 hands it accepts, the declarer
averages **-5.46 +/- 0.83 points** and makes the contract **31.8%** of the
time. Misère pays 5, so declarer and benchmark partner swing +/-10 together:
the gate was worth roughly -0.03 pts/hand on its own, against a fallback
(passing) worth about -1 to the pair.

**And the estimator, asked, separates them cleanly.** Binning the same hands by
their 60-world `mcBidRollout` misère EV, realized declarer points run -14.1
(ev ~ -15, n=33), -9.4 (ev ~ -12.5, n=64), -1.2 (ev ~ 0, n=26), +8.7 (ev ~ +5,
n=43), with the made rate climbing 3% -> 79% across the same range. A floor at
ev >= -1 keeps 30% of them and turns -5.46 into +4.29 +/- 1.57. The optimum is
flat between keeping 20% and 40% — most of the gain is simply not making the
bad bids — and no family line is needed, because misère is a flat +/-15 to the
declarer and the rollout is in those same raw points.

Live, `mcBidEVs(hand, [{key:"misere"}], rng).evs[0] >= -1.0` accepts 24.2% of
gate hands (200 worlds is quieter than the 60 the fit used, so slightly fewer
marginal hands sneak through), costs 55 ms mean on the 0.44% of hands that
reach it, and — the part worth noticing — sends another 24.2% of them on to bid
*something else*. A bare five-card suit is a trump suit under the current
`mcBidOptions`, and those hands were being swallowed by the gate before the
estimator ever saw them. Ecology is untouched: 2484 declared contracts either
way, 16 redeals either way, and the 37 suppressed misères redistribute across
families that all have fitted lines (rik +12, rik9 +8, troela +6, rik_beter +4).

Two leads the same probe turned up and did not chase:

- **Piek**: -2.00 +/- 0.92 declarer points, made 38.9% (n=90). Same shape of
  problem, about a third the size, and only 2 s.e. from zero.
- **The gate is not obviously too NARROW.** Hands one rank band outside it
  (jack-high, 1.21% of hands against the gate's 0.44%) have essentially the
  same misère rollout EV as the gate's own: mean -9.25 against -9.82, share
  above zero 9.9% against 9.7%. Widening is worth trying only behind the same
  floor, and it needs `mcSampleWorld`'s `maxRank` raised with it.

### `MC_BID_SHAPE` described a bidder that no longer exists

The tables were mined 2026-07-19. Two sessions of widening `mcBidOptions` and
one of pricing the fourth ace changed the population they are distributions
*of*, and they had gone wrong in the direction that matters — they made the
declarer's hand better than it is. Re-mined over 4,246 declared contracts
(`explore.mjs beliefs`, four shards, ~40 minutes):

- **Trump honours.** The old rik table started at 1 (.538) and rik9plus at 2
  (.794), so every sampled world handed the declarer at least that many A/K/Q.
  In the current population **11.0% of rik declarers and 13.5% of rik beter
  declarers hold no trump honour at all**, and 13.9% of rik 9+ declarers hold
  at most one. A defender who believes an honour is always out there ducks
  where it should rise.
- **Trump length.** `length >= 4 && honours >= 3` put 4-card trump suits in
  play (1.5% of riks, 2.0% of rik beters) and the bare-five gate put 5-card
  suits into rik 9+ (7.3%). None of those lengths existed in the old tables, so
  `mcAdjustSuitCount` was swapping cards in to reach a length nobody promised.
- **Called-suit length.** Mined when the call was a shape heuristic ("call
  where we are short"); `mcChooseBid` now picks which ace to call by rollout,
  and short calls have roughly halved — "at most one card in the called suit"
  runs 18.1% against the old 31.9% for rik.

The re-mined tables, recorded here so nobody pays the 40 minutes again (tail
buckets under 8 observations folded into their lower neighbour):

```
  rik:       { len: [[4,.015],[5,.637],[6,.929],[7,.988],[8,1]],
               hon: [[0,.110],[1,.579],[2,.922],[3,1]],
               call: [[0,.009],[1,.181],[2,.550],[3,.844],[4,.973],[5,1]] },
  rik_beter: { len: [[4,.020],[5,.703],[6,.976],[7,1]],
               hon: [[0,.135],[1,.630],[2,.942],[3,1]],
               call: [[0,.016],[1,.205],[2,.570],[3,.818],[4,.953],[5,1]] },
  rik9plus:  { len: [[5,.073],[6,.569],[7,.904],[8,.994],[9,1]],
               hon: [[0,.012],[1,.139],[2,.752],[3,1]],
               call: [[0,.021],[1,.209],[2,.556],[3,.847],[4,.958],[5,1]] },
  abondance: { len: [[6,.047],[7,.387],[8,.679],[9,1]],
               hon: [[1,.038],[2,.377],[3,1]] },
```

`truthprobe` is the valid instrument here — a sampler change moves `bidprobe`'s
and `refprobe`'s references with the candidate, but not the clairvoyant answer.
It read +0.0092 +/- 0.0060 on 400 hands, which is under the 3 s.e. replication
bar this directory adopted on 2026-07-30, so it was replicated on a fresh 750:
+0.0134 +/- 0.0047. Pooled, **+0.0118 +/- 0.0037 (3.2 s.e.)** over 47,148
paired decisions — the largest card-play reading this instrument has recorded
on any change here, against the +/-0.006 nulls of the 2026-07-29 session.

### Why they were reverted, and the one hypothesis worth testing next

Both screens are the right sign and both are small: +0.025 +/- 0.124 at 2500,
+0.022 +/- 0.084 at 6000, **+0.023 +/- 0.070 pooled over 8,500 hands**. Zero
violations, control clean (0.064 against a 3 s.e. band of 0.768). The keep rule
(mean - 1 s.e. > 0) fails on both, so the file was reverted.

Note honestly what that pooled number does and does not say. It is consistent
with the ~+0.03 the misère fix was predicted to be worth end to end; it is also
consistent with zero. What it is NOT consistent with is the sum of the two
predictions, and there is a specific reason to suspect why:

**Suppressing a bad misère only pays if the fallback is a pass.** 24.2% of
rejected gate hands go on to bid a rik on a bare five-card suit headed by a
ten. Those clear the rik floor of -1.5, but they are exactly the marginal
contracts the floor was set to *barely* admit, and they may be handing back
most of what killing the misère won. The cheap test is a `gateprobe` run with
`WHICH=lowHand KEY=rik` — price what those hands are actually worth as riks —
before assuming the misère floor is the whole story. Do that before re-applying
either change; both are one edit each and the numbers above are the hard part.

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
