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
# the same deals, the same seeded AI, two near-identical files: the increment
# in POINTS, at 2-9x less noise than any screen. Measure keeps with this.
HANDS=4000 SHARDS=4 node ai-bench/pairscreen.mjs new.jsx old.jsx
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
# WHICH: lowHand veryLow jackHigh queenHigh piek piekWide piekTen piekTwo
#        piekOrphan orphanAll   (the last two ask mcBidOptions what the hand
#        could otherwise bid, so `orphanAll` IS the forced-pass population)
HANDS=400 SHARDS=4 node ai-bench/lenprobe.mjs   # what does a seat's PLAYED suit count say about what it holds?
HANDS=90 node ai-bench/shapeprobe.mjs   # are sampled worlds shaped like real hands?
HANDS=120 node ai-bench/beliefprobe.mjs # are trump beliefs calibrated, given what is public?
DEALS=4000 SHARDS=4 node ai-bench/policyduel.mjs A.jsx B.jsx  # whose mcPolicy plays the face-up game better?
DEALS=1200 node ai-bench/acepop.mjs     # is mcSampleWorld's aceCap still true of the auction?
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

## 2026-08-03: nobody had ever asked the bidder for more than 200 worlds

Three ideas. The one that landed is a constant in `mcBidEVs` that had been
sitting unquestioned since the day it was set; the two that did not are both
doors worth closing.

| # | idea | upstream | screen |
|---|---|---|---|
| 1 | read discards as length in `mcSampleWorld` | `truthprobe` **+0.0010 +/- 0.0061** (wrong sign) | none — REVERTED |
| 2 | `mcBidEVs` 200 -> 400 worlds | `bidprobe` **-0.0158 +/- 0.0029** (5.5 s.e., 4,063 decisions) | 2500 `match` **+0.155 +/- 0.126**, 4500 `pscreen` **-0.034 +/- 0.094** — KEPT |
| 3 | price the piek and open-misère gates | `gateprobe`: no floor exists / gate too rare | no code change |

### Attempt 1 — reading discards as length: null, and it is the fourth one

`mcSampleWorld` deals every unplaced card uniformly among the seats that have
room and are not shown void. The only per-seat public fact it reads is `voids`;
`game.playedCount[s][S]` is public for every seat and only the declarer's entry
was ever used (inside `mcApplyBidInference`). Since 2026-07-29 the standing
finding has been that information, not search, binds the card player, so this
looked like the last unread channel of it.

`lenprobe.mjs` (new) is the probe, and the obvious statistic is the wrong one.
E[rem | playedCount] is dominated by how often the suit has been LED — every
non-void seat must follow — and that is a global depletion the size of the
unseen pool already models exactly. What the sampler cannot model is the spread
between seats at the same moment, which is discards. Over 400 hands, against
the mean of the seats still eligible for the suit:

| delta = playedCount - peers' mean | n | E[rem] / peers' E[rem] |
|---|---|---|
| -2 | 168 | 0.426 |
| -1 | 3,106 | 0.840 |
| 0 | 58,131 | 0.992 |
| +1 | 6,537 | 1.152 |
| +2 | 689 | 1.140 |

So a seat that has played one more card of a suit than the table average holds
**1.16x** the peers' remaining count — *more*, not fewer, because discards come
from length — and the swing across the observed range is 1.4x on a third of the
seat/suit pairs in the second half of the hand. Uniform dealing implies 1.0
everywhere, so this is a real, unexploited 40% mis-weighting.

Weighting the seat draw by that fitted line measures **+0.0010 +/- 0.0061 on
`truthprobe`** over 16,343 paired decisions: wrong sign, 0.16 s.e. REVERTED.
The `cardsLeft` loss profile shows the ceiling was low even for a perfect fix —
clairvoyant loss concentrates in tricks 1-3 (cardsLeft 13/12/11 carry 3,029 of
6,708 loss units), and at trick 1 nothing has been played, so delta is 0 for
everyone. **This is the fourth correctly-signed, correctly-sized sampler
refinement in a row to measure null** (Polya clumping, need-proportional
dealing, void-conditioned trump placement, now discard-conditioned length).
Being right about the distribution is not the same as changing a decision, and
this instrument has now said so four times. Stop proposing sampler refinements.

### Attempt 2 — 200 -> 400 worlds in `mcBidEVs`: KEPT

2026-07-29 raised the bid estimator from 12 shared worlds to 200 and measured
-0.0452 +/- 0.0067 per decision for it. 2026-07-30 then tried four ways of
SPENDING 200 (keep 4 instead of 3, no prune, successive halving, stratified
leaders), found all four null, and the directory has read that since as "the
bid search is saturated". That is not what those runs tested. **Nobody had
asked for more than 200.**

Doubling to 400, paired on `bidprobe` against the same 400-world unpruned
reference:

| run | decisions | paired dLoss | best-option | same call |
|---|---|---|---|---|
| first | 1,260 | -0.0085 +/- 0.0051 (1.7 s.e.) | 69.3% vs 69.4% | 98.7% vs 98.8% |
| replication | 2,803 | **-0.0192 +/- 0.0035 (5.6 s.e.)** | 72.1% vs 68.2% | 98.5% vs 98.0% |
| pooled | 4,063 | **-0.0158 +/- 0.0029 (5.5 s.e.)** | | |

The first read was under this directory's 3 s.e. replication bar, so it was
replicated on fresh hands before it reached a commit message. A third variant
in the first run (400 worlds, prune moved to 100 worlds / keep 4) measured
-0.0084 +/- 0.0054, indistinguishable from the plain doubling, so the prune
stands at 60/3 and the simpler change is the one shipped.

Where the gain lands is the useful part: **same-call barely moves (98.0% ->
98.5%) while the best-option rate moves 68.2% -> 72.1%.** That is the RANKING
problem — which trump, which called ace — which 2026-08-01 identified as all
that was left once the bid/pass call reached 98.7%, and which 2026-07-29 wrote
off as noise-bound. It *is* noise-bound. Noise responds to worlds.

The mechanism explains why 200 was right when it was set and is not now: the
two width sessions (2026-07-31, 2026-08-01) roughly doubled the option set, and
the 60-world pre-pass ranks the whole field before pruning. More options on the
same 200 worlds is fewer worlds per option. **Generalise: a search budget is
not a constant, it is a budget per candidate. Re-ask it after anything that
widens the candidate list.**

Ecology, 1,500 shared deals on `bidtally`: declared 1,486 vs 1,488, family mix
moving by single digits (rik -9, rik9 +12, rik11 -6). Bid frequency untouched,
so `MC_BID_CALIB`'s population argument holds; by the 2026-07-29 `bidcalib`
result a quieter estimator moves the floors' coordinates by ~0.001 pts/hand,
which is not worth a re-derivation. Bid decisions cost mean 67.4 ms (from
34.3), p99 216 ms over 1,312 auctions on a loaded 4-core box — inside the
~150 ms budget on the mean that budget is actually a claim about, and cheaper
than the card player's trick-1 decisions either way.

**Read the two screens together, not selectively.** The 2500-hand `match.mjs`
returned +0.155 +/- 0.126 (win 52.4%, 0 violations, control +0.288 against a
3 s.e. band of 0.744) and cleared the keep rule at mean - 1 s.e. = +0.029. A
4500-hand `pscreen` of the *identical* code, run concurrently, returned -0.034
+/- 0.094. Pooled over the 9,000 hands: **+0.034 +/- 0.075**. That is the
honest branch number, it is consistent with the ~0.02 pts/hand the upstream
reading predicts, and it is equally consistent with zero. The change is on the
branch because it is verified at 5.5 s.e. where it can be seen, not because a
2500-hand screen said +0.155.

### Attempt 3 — the piek and open-misère gates: priced, neither actionable

2026-08-02 priced the misère gate and found it accepts hands worth -5.46 +/-
0.83 declarer points, fixable to +4.29 with a floor on the hand's own rollout
EV, and flagged piek and open misère as the same question, unpriced. Both are
priced now, and neither is worth an edit:

- **Piek**: -0.98 +/- 0.60 declarer points over 220 played gate hands, made
  44.5% (pooled with last session's -2.00 +/- 0.92 on n=90: ~-1.28 +/- 0.51).
  Mildly negative — but unlike misère, **the rollout EV does not separate the
  hands.** Realized points by 60-world EV bin run -0.84 (ev~0, n=75), -0.58
  (ev~2.5, n=77), -2.31 (ev~5, n=35), and every "keep the top X%" row sits
  inside its own error bar. There is no floor to set. Note also that piek EVs
  are mostly POSITIVE (+0 to +7.5) against realized play near -1, so that
  rollout is both optimistic and uninformative — worth knowing before anyone
  trusts a piek EV for anything else.
- **Open misère**: -4.47 +/- 1.96 over 145 gate hands, made 41%, and here the
  EV *does* separate, monotonically: keep top 50% -> +1.64, 40% -> +3.31,
  30% -> +4.36, 20% -> +7.45, 10% -> +14.40. The floor is real and it is
  worthless, because **the gate fires on 145 of 800,000 seat-hands (0.018%)**
  against misère's and piek's ~0.44%. Twenty-five times rarer, so even the full
  -4.47 -> +3.31 swing is worth ~0.003 pts/hand end to end.

So of `aiChooseBid`'s three surviving deterministic gates, exactly one — the
misère gate, priced last session — is worth replacing with an EV floor, and it
is still unapplied. That remains the cheapest known unclaimed edit here.

Also closed this session, on a hypothesis that turned out to be a non-problem:
the bidder is never asked to act while it is itself the standing high bidder,
so it cannot overcall itself and cannot mis-value passing for that reason.
`applyBid`'s comment asserts this for the game flow; the harness auction loop
reaches the same state through its `active === 1 && !passed[high.seat]` break.
Measured: 0 occurrences in 600 hands.

## 2026-08-04: pair on the deal, and the wall this directory keeps hitting falls over

Every entry above runs into the same wall from a different direction. A
2500-hand `match.mjs` has a standard error of ~0.126 pts/hand; almost every
real improvement left in this AI is worth 0.01-0.08; so the screen is a coin
flip, the keep rule discards upstream-verified work (2026-07-31 and 2026-08-02
each reverted a change measured at 3-9 s.e. by a paired probe), and the answer
this directory kept reaching for was a *different* upstream instrument —
`refprobe`, then `truthprobe`, then `bidprobe`, then `bidtruth`, then
`gateprobe`. Each of those measures something real. None of them measures
POINTS, which is what the gate is denominated in, so every one of them leaves
the same open question: does this convert?

This session built the instrument that answers that question, and then used it
to keep one change and kill another that every other instrument here liked.

### `pairscreen.mjs` — the variance was never in the change, it was in the deal

A hand where nothing the change touches ever happens still swings +/-6 points,
and an unpaired screen has to average that away. So: pair on the deal, and make
the two arms bit-identical wherever the change does not fire.

1. The deal is generated once (arm A's table drives the realistic carry-over
   shuffle, exactly as `playMatch` does) and both arms play it.
2. `Math.random` is replaced by a seeded generator, RESET to the same value at
   the start of each arm's play of each deal. Two files whose code paths do not
   diverge then consume the identical random stream and score identically, to
   the last point.

A deal the change never touches contributes an exact 0 to the difference
instead of noise. Validation is trivial and exact: two copies of the same file
over 24 deals give mean 0, sd 0, `fired` 0.

What it bought, on the misère floor (fires on 0.45% of deals):

| instrument, same change | reading | s.e. |
|---|---|---|
| 2500-hand `match.mjs` | -0.130 | 0.130 |
| 6000-hand `pscreen.mjs` | -0.171 | 0.083 |
| 6000-deal `pairscreen.mjs` | **+0.0143** | **0.0090** |

The paired sd is **0.701 against the unpaired 6.3** — a 9x smaller standard
error for the same number of hands, and enough to resolve a change worth a
seventh of the old MDE. Note what the first two rows are: not evidence against
the change, just two draws of the branch's whole margin, which the change moves
by 0.014. **A screen cannot see a 0.014-point change and never could.**

The reduction scales with how rarely the change fires, so quote `firedRate`
when you report a `pairscreen` number: 0.45% of deals gave 9x, 17% of deals
gave 1.8x, and a change that fires everywhere would give roughly the
deal-luck-cancelling factor alone. This is not the gate — `match.mjs` still is
— and it measures the INCREMENT of one file over another, not either one's
margin over the frozen baseline.

It also reports realized declarer points per contract key for free, which is
the 2026-08-02 misère-gate question asked of every contract at once. Over 6,000
deals: rik9 +4.02 (n=1813), rik +2.82 (1669), rik10 +2.72 (495), rik_beter
+1.94 (1046), rik11 +1.37 (321), troela +0.79 (313), **abondance +8.37 (139)**,
piek -1.21 (67), misère -8.08 (39). Declaring is profitable in every rik family
and hugely so in abondance — that is an average over an acceptance region, not
the marginal contract, so it is not by itself proof the floors are too high,
but abondance accepting only hands that realize +8.37 is worth a randomized
look the next time anyone runs `explore.mjs`.

### Attempt 1 — the misère gate becomes an EV floor: KEPT

2026-08-02 priced the gate (-5.46 +/- 0.83 declarer points over 280 played
hands, made 31.8%) and found a floor at rollout ev >= -1 turns it into +4.29
+/- 1.57. That edit was the "cheapest known unclaimed edit here" for two
sessions. It is now applied: shape is a pre-filter, `mcBidEVs` makes the call,
and a rejected hand falls through to `mcBidOptions` like any other. Live it
accepts 26.7% of gate hands and costs 19.2 ms on the 0.56% of seat-hands that
reach it — misère rollouts stop the moment the declarer wins a trick, so they
are the cheapest rollouts in the file.

`pairscreen`, 6,000 deals, 27 of them diverging: **+0.0143 +/- 0.0090
pts/hand**, +3.19 pair points per deal where the bid actually changed. That is
the gateprobe prediction arriving intact — 0.45% x 3.19 = 0.0143 — and it is
also the whole size of the thing, which is worth saying plainly: the cheapest
unclaimed edit in this directory was worth a seventh of the gate's MDE.

Also closed, and the reason attempt 1 is a floor rather than a wider gate:
**the misère gate is not too narrow.** 2026-08-02 noticed that jack-high hands
(1.21% of hands against the gate's 0.44%) have the same misère EV distribution
as the gate's own and asked whether widening behind the same floor would pay.
Played out — 300 jack-high hands, `gateprobe WHICH=jackHigh KEY=misere` — they
earn **-8.30 +/- 0.72 with 22.3% made**, and no floor rescues them: the best
decile by EV still realizes -4.00 +/- 2.64, and the by-EV bins are not even
monotonic. The misère rollout EV is informative INSIDE the gate population and
worthless outside it.

### Attempt 2 — the re-mined `MC_BID_SHAPE` tables: REVERTED, and this is the finding

The 2026-08-02 entry re-mined `MC_BID_SHAPE` over 4,246 declared contracts and
recorded the tables so nobody would pay the 40 minutes again. They are right
about the population: the old tables never gave a rik declarer 0 trump honours
(11.0% of them hold none now) or a 4-card trump suit, and `truthprobe` reads
**+0.0118 +/- 0.0037 per card decision over 47,148 paired decisions** — the
largest reading that instrument has ever recorded here, against the +/-0.006
nulls of every other sampler refinement.

End to end it is nothing. `pairscreen`, 3,999 deals, 690 of them (17.3%)
diverging: **-0.0365 +/- 0.0566 pts/hand**, wrong sign, and mean - 1 s.e. fails
the keep rule on the precise instrument as well as the noisy one (2500-hand
`match.mjs` -0.281 +/- 0.128, win rate 47.1%, REJECT). Reverted.

**This is the first time a large upstream reading has been checked end to end
by something that could see it, and it did not survive.** The lesson is not
that `truthprobe` is broken — it measures exactly what it claims, EV given up
against the clairvoyant answer, paired per decision. The lesson is that the
conversion from that to points is not a constant, and this directory has been
assuming it is since 2026-07-29. Concretely: 2026-08-02 chose to revert this
change on a screen it correctly described as unable to see it, and would have
been talked out of that by any of the arguments in the 2026-07-31 entry. It was
right anyway. **Before spending a session on an upstream-verified change, run
`pairscreen` on it. Per-decision EV is a proxy; points are the thing.**

### What that means for the keep rule

The rule this routine runs on — keep if a 2500-hand `match.mjs` shows
mean - 1 s.e. > 0 — is a filter with a standard error of 0.13 applied to
changes worth 0.01-0.08. It rejected a change worth +0.014 (attempt 1) and
rejected a change worth -0.037 (attempt 2), i.e. it was right once out of two
for reasons unrelated to either change. `pairscreen` applies the SAME rule to
the same quantity with 2-9x less noise, and it is the instrument the keep
decisions above were made on; the ceremonial `match.mjs` run is recorded beside
each of them. Anyone changing the routine's instructions should make that the
primary gate for per-attempt keeps and leave `match.mjs` for the promotion
decision, where the quantity being measured is the branch's whole margin and
the pairing has nothing to cancel.

Branch state after this session: `main` + the 2026-08-03 400-world bidder +
the misère floor. The 2500-hand screen of it reads -0.130 +/- 0.130 and the
6000-hand pooled screen -0.171 +/- 0.083, which pooled with the 2026-08-03
readings of the same branch minus the misère floor (+0.155 at 2500, -0.034 at
4500) puts the branch somewhere around **-0.07 +/- 0.05 pts/hand against the
frozen baseline** over 15,500 hands. No promotion was run and none was close.
That number is a live question for the next session, and `pairscreen` can
answer the part of it that matters: **is the 400-world bidder of 2026-08-03
actually negative?** It was kept on `bidprobe` (-0.0158 +/- 0.0029 per bid
decision, 5.5 s.e.) — which is precisely the kind of upstream reading attempt 2
just showed can fail to convert.

## 2026-08-05: the probe was dealing a different game

One instrument bug, and it had been quietly setting policy. `gateprobe.mjs`
carried the previous deal over to the next one as `hands.flat()` — the four
SORTED hands, i.e. thirteen same-suit runs of up to eight cards — where the
real table carries over the cards **trick by trick**, thirteen four-card
groups that mostly share a suit. `humanShuffle` is two sloppy riffles and a
cut, which is nowhere near enough to erase the difference, so the probe fed
its own clump straight back into the next deal.

Measured over 40,000 deals, dealing-only:

| carry-over | avg longest suit | 7+ card suits | voids/hand | misère gate rate |
|---|---|---|---|---|
| `hands.flat()` (what the probe did) | 5.256 | 11.14% | 0.140 | **0.440%** |
| trick-ordered (what the table does) | 5.146 | 8.51% | 0.099 | **0.268%** |

So every number `gateprobe` produced before this session describes a table
whose hands are 64% more likely to reach the misère gate than the benchmark's.
The fix is in: `trickOrder()` approximates a trick pile (pick a leader, pick a
led card, make the others follow when they can) rather than playing every deal
out, which would cost more than the probe does.

Re-priced on the corrected population — 600 played gate hands, four shards,
400-world EVs matching the live estimator:

| | old (clumped) population | corrected population |
|---|---|---|
| whole gate | -5.46 +/- 0.83, made 31.8% (n=280) | **-6.95 +/- 0.54, made 26.9% (n=600)** |
| keep top 10% by EV | — | +3.00 +/- 1.81 |
| keep top 20% | — | +2.00 +/- 1.34 |
| keep top 30% | +4.29 +/- 1.57 | **+0.34 +/- 1.11** |
| keep top 50% | — | -2.60 +/- 0.86 |
| keep top 75% | — | -4.98 +/- 0.67 |

The `-1` floor keeps the top 20-30%, so its band realizes somewhere between
+2.00 and +0.34 rather than the +4.29 the clumped run promised. The ordering
survives — the by-EV bins are still monotone — but the level does not, and
that reads at first like an argument for scrapping the contract. It is not:
see attempt 2.

### `pairscreen`'s contract table counts the WHOLE table, not your pair

The 2026-08-04 entry reports "misère -8.08 (n=39)" from that table and this
session opened by treating it as what the candidate's own misères earn. It is
not. `keysA` is accumulated from `ra.declDelta` for every declared contract on
the table, and two of the four seats are `baseline.jsx` — which is `main` as of
2026-08-01, i.e. the version with the raw shape gate and **no floor at all**.
The bad misères in that column are the baseline's.

Splitting them is easy once you know to: run an arm that never bids misère and
diff the two columns. Arm A (no misère) declared 30 at **-6.00**, all of them
the baseline's; arm B (the floor) declared 40 at **-3.75**. So the ten misères
the floored candidate bid in 6,000 deals realize **+3.00 declarer points**, and
the floor is doing exactly what 2026-08-04 claimed — just from a level the
clumped probe overstated. Read that column as a table average, never as a
candidate statistic.

### Attempt 1 — mcChooseBid threw away biddable runners-up: REVERTED

Ranking the bid options and deciding whether to bid at all are different
questions, and `mcChooseBid` answered the second one only for the winner of
the first. Each family has its own bid/pass line and its own data floor, and
they are not ordered the same way as calibrated value, so the top option can
fail its line while a runner-up from another family clears its own — and the
whole auction was passed. Two shapes where it happens: abondance (flat pass
line, needs ev > 2.669) outranking a rik that would bid down to -1.5, and a
rik 9+ overcall (floor -0.3) outranking a rik beter (floor -1.5) at the same
EV. The fix is three lines: walk the surviving field in value order, bid the
first option that clears its own family's test.

The hole is real and it is small. `bidtally`, 700 shared deals: 695 declared
contracts against 694, one redeal recovered. `pairscreen`, 4,000 deals:
**+0.0085 +/- 0.0140 pts/hand**, fired on 35 deals (0.88%), +1.06 pair points
on the deals where it fired — internally consistent (0.0088 x 1.06 = 0.0093)
and 0.6 s.e. from zero. It also costs clock, since the fallthrough can pay for
a second boundary refinement. Right sign, right mechanism, under the keep rule.
Reverted.

### Attempt 2 — stop bidding misère altogether: REVERTED, and it is the finding

Given a gate that averages -6.95 declarer points and a floor whose band is
statistically indistinguishable from zero, the obvious move is to drop the
contract and let the hand go to `mcBidOptions` like any other. Measured on
6,000 paired deals it is **-0.0127 +/- 0.0063 pts/hand** — 2 s.e. the wrong
way, fired on 16 deals (0.27%), **-5.07 pair points on every misère it
suppressed**. Reverted, and the 2026-08-04 floor is vindicated by the only
instrument that could see it.

The number worth carrying forward is that -5.07. Our misères are worth +3.00
declarer points, i.e. +2.00 to the pair; suppressing them therefore leaves the
pair at -3.07. **Passing with a hand of nothing but low cards costs about three
pair points.** A bid floor is not a comparison against zero, it is a comparison
against the fallback, and the fallback here is genuinely awful — which is also
why `MC_BID_CALIB` carries a fitted pass line per family rather than a constant.

That reframing also closes the gate in the other direction, on the corrected
gateprobe table. Converting declarer points to pair points (x 2/3) and pricing
each EV bin against a -3.07 fallback: ev ~ -2.5 realizes -2.73 (still better
than passing), ev ~ -5 realizes -3.77 (worse). The crossover sits near
**ev = -3**, against a live floor of -1, and the band between them is 7% of
gate hands worth ~0.3 pair points each — about 0.0001 pts/hand end to end.
**The misère gate is now tuned to within a rounding error in both directions.
Stop touching it.**

### Attempt 3 — is the 400-world bidder negative? No, and the branch is not either

The question 2026-08-04 left open. `pairscreen` cannot normally answer it: a
change to how many worlds `mcBidEVs` draws consumes a different length of
random stream, so the two arms diverge on the first auction and every deal
fires — the pairing buys nothing and you are back to a 0.08 standard error.

The way around it is to make the cheap arm draw the expensive arm's worlds and
then ignore them. The measurement variant runs the full 400 worlds, so the
stream is bit-identical, but returns the mean of the first 200 as its EVs. Its
decision is exactly the decision a 200-world estimator makes on those 200
worlds, and the two arms now diverge only where the extra 200 worlds change a
bid. Neither file is shippable — this is an instrument, and it lives in the
session scratch, not the repo.

6,000 paired deals: **+0.0130 +/- 0.0296 pts/hand** for deciding on 200
instead of 400, fired on 325 deals (5.42%), +0.26 pair points where it fired.
Fails the keep rule, so nothing changes — but read the fire rate, because it
is the real result. Doubling the bid budget moves the contract on **one deal
in eighteen**, and moves the score by a quarter of a point when it does. The
whole 2026-08-03 change is bounded at **-0.013 +/- 0.030**, which is nowhere
near the -0.08 the branch's screens were being read to imply.

Put that beside the other paired measurement of a branch component — the
misère floor at +0.0143 +/- 0.0090 — and the branch's entire content since
`main` sums to **+0.001 +/- 0.031 pts/hand**. It is not negative. It is not
positive either. The -0.130 and -0.171 that 2026-08-04 recorded, and the
"somewhere around -0.07 +/- 0.05" it concluded from them, are what a branch
worth zero looks like through an unpaired screen. **Both components of this
branch have now been measured by an instrument that can see them, and neither
is the problem; there is no accumulated edge here to promote, and no hidden
regression to hunt.**

No `match.mjs` was run this session. All three attempts were reverted, so the
branch's `Rikken.jsx` is byte-identical to the file 2026-08-04 screened at
-0.130 +/- 0.130, and the promotion trigger reads that screen. Re-rolling an
unchanged candidate through a 0.13-standard-error gate is the habit the
2026-07-30 entry warns about, and it would have cost 75 minutes to learn
nothing.

## 2026-08-06: ask which thresholds the bidder is still using, then push the last live one both ways

Three attempts, all reverted, and the useful output is a new one-minute
instrument plus a two-sided measurement that closes `MC_BID_CALIB`.

| # | change | `pairscreen`, 4,000 deals | fired | per fired deal |
|---|---|---|---|---|
| 1 | guard-aware discard in `mcLowDump` | **+0.013 +/- 0.0532** | 13.7% | +0.10 |
| 2 | rik9plus bid/pass crossover -0.317 -> **-1.2** | **-0.032 +/- 0.0288** | 3.5% | **-1.73** |
| 3 | rik9plus bid/pass crossover -0.317 -> **+0.5** | **-0.029 +/- 0.0308** | 3.7% | **-1.32** |

### `marginprobe.mjs` — which of the fitted thresholds is the AI still asking?

`MC_BID_CALIB` is four fitted lines and four floors, and every session that
wants to touch one is quoted hours of `explore.mjs`. Nobody had asked the
cheaper question first: *which of them still decides anything?* Auction only,
candidate in all four seats, replaying `mcChooseBid` and recording each
decision's distance to its family's boundary — 600 deals, 1,439 decisions,
50 seconds on four cores.

| family | decisions | bid | blocked by floor | by crossover | within 0.5 of the boundary |
|---|---|---|---|---|---|
| rik | 646 | 97.1% | 9 | 10 | 80 |
| rik_beter | 218 | 97.2% | 6 | 0 | 8 |
| rik9plus | 565 | 75.0% | 0 | 141 | 61 |
| abondance | 10 | 80.0% | 0 | 2 | 0 |

Read the first two rows before proposing any more work on the rik floors: at
97% bid they are very nearly inert, and the 2026-07-27 session's -0.5 -> -1.5
move is most of the reason. The fourth row kills a lead the 2026-08-04 entry
left open — "abondance accepting only hands that realize +8.37 is worth a
randomized look". It is not. Abondance is not under-bid, it is **rare**: it
is the argmax family on 10 of 1,439 decisions, and 8 of those 10 bid. Its
threshold could be anywhere and it would be worth ~nothing.

That leaves rik9plus, which is where a quarter of the family's decisions and
61 near-boundary decisions per 600 deals live — so that is what attempt 2
tested.

### Attempts 2 and 3 — the rik9plus line is where it belongs, measured from both sides

The prior for lowering it came from `pairscreen`'s realized-points column: a
rik9 declarer earns +4.15 while a rik declarer earns +2.68, so a rik defender
earns -2.68 and the seat that overcalls to rik9 looks ~6.8 points better off
than the seat that passes. Moving the crossover to -1.2 (by `c` alone; `a`/`b`
untouched so `mcBidValue`'s cross-family ranking does not move) leaves bid
FREQUENCY alone — 1,189 declared contracts against 1,188 over 1,200 shared
deals — and spends the change entirely on the ladder: rik9 -44, rik10 -19,
**rik11 +45, rik12 +17**.

Paired over 4,000 deals it measures **-0.032 +/- 0.0288 pts/hand**, firing on
3.5% of deals and costing **-1.73 pair points on each deal it moved**. So the
extra overcalls are not near-zero marginal decisions, they are bad ones, and
the boundary is not too low.

Attempt 3 is the mirror, and it is why this entry is worth reading rather
than a third null. If the band immediately below the fitted crossover is
worth -1.73 a deal, the natural reading is that a line fitted in the
2026-07-19 ecology now sits too LOW, and raising it should pay. Pushed the
other way — crossover to +0.5, again by `c` alone — the ecology moves in
exact mirror image (rik11 **-35**, rik12 -7, rik9 +23, rik +7, rik_beter +11;
1,189 declared against 1,187) and it measures **-0.029 +/- 0.0308**, firing
on 3.7% of deals and costing **-1.32 pair points on each one it moved**.

**Both directions lose, at about the same rate.** That is what an optimum
looks like from the outside, and it retires the last threshold in
`MC_BID_CALIB` the AI still asks in volume: rik and rik_beter are inert at
97% bid, abondance is too rare to matter, and rik9plus is now bracketed by two
paired measurements 0.8 of an ev unit apart on either side. **Do not spend
another session on `MC_BID_CALIB`'s coordinates, and in particular do not
spend `explore.mjs` hours re-deriving a line that has just been pushed both
ways for 95 minutes each.** Note what is NOT claimed: neither move is more
than 1.1 s.e. from zero on the mean, so this is "no evidence of a better
threshold in either direction", not "the crossover is provably -0.317".

Worth recording separately, because it is the surprising part: the flipped
decisions are not cheap. A threshold sitting at its optimum should flip
decisions worth ~0, and these are worth -1.3 to -1.7 pair points each. The
band near the boundary is high-variance rather than low-stakes — the
estimator is separating genuinely different hands there and the current rule
is calling them right — which is also why the whole effect stays under
0.04 pts/hand: 3.5% of deals is all it gets to work with.

**The transferable part is why the prior was wrong.** "Declarers of X earn
more than defenders of Y" is an average over two different acceptance regions,
and the seats that can overcall are the strong ones. That column is a
diagnostic for a family that is systematically NEGATIVE (which is how the
misère gate was found), not an argument that a threshold is misplaced. The
only thing that answers the threshold question is playing the marginal band
out, and `pairscreen`'s `meanOnNonzero` does exactly that: it IS the bid/pass
experiment `explore.mjs` runs, restricted to the band the change moves, for
95 minutes instead of a re-derivation. **Use it that way — one run gives the
sign and the size of a threshold move, and it costs less than the fit.**

### Attempt 1 — guard-aware discards: null, and cheap to have asked

`mcLowDump` chose among side non-masters by RANK alone, which is the wrong
question when we are void and choosing between suits: shedding the x from K-x
turns a trick into nothing, while a dead singleton elsewhere is free. The fix
counts `spare = ours - foes above our top` per suit (partner's high cards
deliberately not counted — a suit our own side controls needs no guard) and
sheds from a suit where it is already <= 0 first. It is exact enough in a known
world, it costs nothing on the clock (mean card decision 45.7 ms against the
head's ~47, because the same change made `lowDump` lazy and leads stopped
paying for it), and it changes the final card on 13.7% of deals.

It is worth **+0.10 pair points on those deals**, i.e. nothing. Recorded here
mostly as calibration on a first read: the same code screened **+0.62 +/-
0.257 over 200 deals** — a 2.4 s.e. positive that regressed to +0.013 at
4,000. `pairscreen` is 2-9x sharper than a screen but it is not free of the
same trap; 200 deals of a 13% firing change is 27 fired hands.

Branch state: unchanged. All three attempts were reverted, so `Rikken.jsx` is still
byte-identical to the file 2026-08-04 screened at -0.130 +/- 0.130 and
2026-08-05 measured componentwise at +0.001 +/- 0.031. No `match.mjs` was run
and no promotion was close, for the reason the 2026-08-05 entry gives.

## 2026-08-07: bracket the SHAPE gates the way 2026-08-06 bracketed the thresholds

The 2026-08-06 session pushed the one live threshold in `MC_BID_CALIB` both
ways and found the optimum by losing in both directions. This session did the
same thing to `mcBidOptions`'s shape gates — the other half of the bid/pass
decision, and the half four sessions of widening had only ever pushed one way.
Three attempts, all reverted, all measured on 4,000 paired deals against the
branch head.

| # | change | `pairscreen`, 4,000 deals | fired | per fired deal |
|---|---|---|---|---|
| 1 | rik trump gate `len>=4 && hon>=3` -> `len>=4 && hon>=2` (wider) | **+0.012 +/- 0.0257** | 5.4% | +0.39 |
| 2 | rik9plus gate `len>=5 && hon>=3` -> `len>=5 && hon>=2` (wider) | **-0.030 +/- 0.0438** | 12.6% | **-0.44** |
| 3 | rik9plus gate: drop the `len>=5 && hon>=3` rung (narrower) | **+0.014 +/- 0.0211** | 2.1% | **+1.14** |

### The forced-pass population is real, and it is worth about nothing

Dealt 40,000 seat-hands the way the table deals, **22.3% of hands reach
`mcBidOptions` with no option at all** — a pass the estimator is never asked
about, which is the exact shape of hole that paid on 2026-07-31 and
2026-08-01. 7.8% of all hands are in that group holding a four-card suit with
two of A/K/Q, i.e. one rank band below the `A K Q x` the gate already admits,
so attempt 1 is the last rung of that ladder. Widening to it cuts the
forced-pass rate to 14.4% and leaves the `.slice(0, 2)` cap on strong suits
still inert (three qualifying suits: 0.17% of hands).

Ecology is clean — `bidtally` over 1,500 shared deals gives 1,499 declared
contracts against 1,487, with redeals falling 13 -> 1 and the mix moving
inside families that all have fitted lines (rik -57, rik_beter +59, rik9 +11).
Bid FREQUENCY is untouched, so `MC_BID_CALIB`'s population argument holds and
no re-derivation was owed. And the answer is **+0.012 +/- 0.0257, +0.39 pair
points on each of the 5.4% of deals it moved**: right sign, half a standard
error, under the keep rule.

Read that number against what it cost to get. The hands are not rare, the gate
really was refusing them, and the estimator really does bid some of them — and
the whole thing is worth a twentieth of the gate's MDE. **The rik gate's
remaining width is not a source of points.** That is consistent with
`marginprobe`'s first row rather than with the width sessions: at 97% bid the
rik bid/pass test is nearly inert, and a gate that feeds an inert test more
hands mostly just moves which seat declares.

### Where the test is LIVE, a wider gate loses — and a narrower one pays

`marginprobe` puts rik9plus at 565 of 1,439 argmax decisions with 141 blocked
by its crossover: the one family whose bid/pass test still does real work. The
natural reading of attempt 1 is that widening should therefore pay MORE here,
because the estimator has a live veto over whatever the shape gate lets in.
It is exactly backwards.

Attempt 2 measures **-0.030 +/- 0.0438** and, more usefully, **-0.44 pair
points on every deal it moved**, firing on 12.6%. The contract table shows the
mechanism directly: rik9 gains 154 contracts (1,117 -> 1,271) while its
realized declarer points fall **4.04 -> 3.45**, and rik (-114) and rik_beter
(-141) are what it eats. The marginal overcall dilutes the family it joins.
That is 2026-08-06's crossover result reproduced through a different lever —
extra rik9+ overcalls cost -1.73 pair points a deal when you buy them by
lowering the threshold and -0.44 when you buy them by widening the shape gate.

So attempt 3 pushed the same rung the other way: withdraw `len >= 5 &&
honours >= 3`, added 2026-08-01 inside a batch that measured all three gates at
once on `bidprobe` and was screened only as a batch. Narrowing measures
**+0.014 +/- 0.0211**, firing on 2.1% of deals and worth **+1.14 pair points on
each one**. Under the keep rule at 0.66 s.e. it goes back, and it is recorded
here as a lead rather than a result — but note the two-sided shape of the
evidence, which is what makes it worth writing down: **widening this rung costs
0.44 a deal and narrowing it gains 1.14 a deal, both from the branch head.**
Unlike the 2026-08-06 bracket, the two directions do NOT lose symmetrically.
If a future session wants one cheap thing to replicate, it is attempt 3.

**The transferable part.** A shape gate and a calibrated floor are two filters
in series, and which one binds decides what widening the other is worth. Where
the floor is inert (rik, 97% bid) widening the gate is worth ~+0.01 — the
estimator rubber-stamps whatever arrives. Where the floor is live (rik9plus,
75% bid) widening the gate is worth **negative**, because the hands it lets
through are the ones the estimator is worst at ranking, and a live veto is not
the same as a correct one. **Read `marginprobe`'s bid% column before proposing
a gate change, and expect the sign to flip across it.**

Branch state: unchanged again. All three attempts were reverted, so
`Rikken.jsx` is still byte-identical to the file 2026-08-04 screened at
-0.130 +/- 0.130 and 2026-08-05 measured componentwise at +0.001 +/- 0.031.
No `match.mjs` was run: the branch's AI code did not change this session, the
promotion trigger reads that -0.130 screen, and re-rolling an unchanged
candidate through a 0.13-standard-error gate is the habit the 2026-07-30 entry
warns about.

## 2026-08-10: the last unread pocket in the option set, and the replication 08-07 asked for

Two attempts, one kept. The kept one is the replication the previous entry
pre-registered; the reverted one is a pocket of the bid option set that no
instrument in this directory has ever been able to see, and it is the fourth
independent measurement of the same underlying fact.

| # | change | `pairscreen` | fired | per fired deal | |
|---|---|---|---|---|---|
| 1 | flat 3-ace hands may name their own trump | **-0.021 +/- 0.0267** (4,000) | 4.75% | **-0.97** | REVERTED |
| 2 | drop the rik9plus `len>=5 && hon>=3` rung | **+0.011 +/- 0.0134** (8,000) | 1.95% | **+1.01** | KEPT |

### Attempt 1 — the one-option auction, and why nothing here could see it

`mcBidOptions` returns a list of length **one** — just troela — on 8.3% of
live auction decisions, and every instrument in this directory is blind to
them by construction. `bidprobe.mjs` filters out hands with three or more
aces; `bidtruth.mjs` inherits that; `explore.mjs` randomises a bid/pass cut,
which cannot ask what a one-option list is missing; `gateprobe.mjs` prices
NAMED gates in `aiChooseBid` and this is not one. So the 2026-08-01 stopping
rule — "read `same call` before proposing another widening" — was read off a
statistic computed on a population that excludes this pocket entirely, and
says nothing about it. That is the transferable half of this attempt: **a
filter in an instrument is a blind spot in every conclusion drawn from it,
and `bidprobe`'s 3-ace filter has been silently shaping this directory's
option-set policy for five sessions.**

The idea was troela's own argument applied one level down. Troela's trump is
the suit of the first card led, so an opponent picks it three times in four,
while a rik naming even a bare FOUR-card suit calls the identical missing ace
for the identical partner and the identical eight-trick target. With no
five-card suit the hand is 4-3-3-3 / 4-4-3-2 / 4-4-4-1, so a four-card suit
always exists. Scored against troela on 200 shared worlds over 700 deals (58
troela-only decisions): with rik still legal the four-bagger won **8 of 8 by a
mean +0.95 +/- 0.13** raw rollout points; over a standing bid — where the
alternative is an overcall, and 50 of the 58 cases live — **31 of 50 by a mean
+0.84 +/- 0.31**. `bidtally`, 800 shared deals: 793 declared contracts either
way, 7 redeals either way, troela 38 -> 4.

Paired on 4,000 deals it measures **-0.021 +/- 0.0267, -0.97 pair points on
each of the 4.75% of deals it moved**, and `pairscreen`'s contract table names
the mechanism without ambiguity: rik9 gains 63 contracts (1,140 -> 1,203)
while its realized declarer points fall **4.08 -> 3.91**. That is 2026-08-07's
attempt 2 exactly — the marginal overcall dilutes the family it joins —
arrived at from a third direction. Reverted.

Worth stating plainly because it is the second time: **a raw-rollout margin
between two options is not evidence the swap converts.** +0.84 +/- 0.31 on the
option comparison became -0.97 a deal in realized points, for the same reason
2026-08-04's `truthprobe` +0.0118 +/- 0.0037 became -0.0365 end to end. The
option the estimator prefers in this family is the one it ranks worst.

If anyone revisits it, the only sub-case not condemned is the 14% where rik
itself is still legal (8/8, +0.95) — the rik bid/pass test is inert at 97% bid
so the dilution mechanism does not apply there. It is ~0.7% of deals and worth
about +0.003 pts/hand, i.e. not worth the 90 minutes.

### Attempt 2 — the rik9plus five-card rung, withdrawn and replicated

2026-08-07 closed by naming one lead worth replicating: withdrawing the
`length >= 5 && honours >= 3` rung from the rik 9+ overcall gate, which
arrived on 2026-08-01 inside a three-gate batch and was never priced alone.
That session measured +0.014 +/- 0.0211 over 4,000 paired deals, +1.14 pair
points on each of the 2.1% of deals it moved. Replicated here on 8,000:
**+0.011 +/- 0.0134, fired 1.95%, +1.01 pair points per fired deal.**

Pooled over the 12,000 deals: **+0.0119 +/- 0.0113**, mean - 1 s.e. = +0.0006.
Read that honestly. The per-fired-deal effect is what replicates cleanly
(+1.14 then +1.01 on near-identical fire rates); the pooled mean clears the
keep rule by a hair and means "positive at about one standard error", not a
resolved number. **Today's 8,000-deal run on its own is -0.0024 at mean - 1
s.e. and would have failed.** The keep rests on pooling a replication the
previous session pre-registered — which is a legitimate thing to pool and a
post-hoc trawl is not.

Ecology from `pairscreen`'s own table, which is better than `bidtally` here
because it is the same 8,000 deals the estimate comes from: **7,916 declared
contracts either way, 84 redeals either way.** Bid frequency untouched, so
`MC_BID_CALIB`'s population argument holds. The mix moves inside families that
all have fitted lines — rik9 -51, rik10 -41, rik11 -11 against rik +46,
rik_beter +41, troela +16 — and rik9 holds 4.10 realized declarer points while
shedding its 51 marginal contracts, which is the dilution of attempt 1 running
backwards.

**Four paired measurements now bracket this family from both sides**, and no
other family in `MC_BID_CALIB` has anything like this weight of evidence:

| lever | direction | pair pts/deal |
|---|---|---|
| crossover -0.317 -> -1.2 (2026-08-06) | more overcalls | -1.73 |
| gate -> `len>=5 && hon>=2` (2026-08-07) | more overcalls | -0.44 |
| flat 3-ace four-baggers (2026-08-10) | more overcalls | -0.97 |
| drop `len>=5 && hon>=3` (2026-08-07, 2026-08-10) | fewer overcalls | +1.14 / +1.01 |

### Three ideas that were already settled, and how much they cost to re-find

This session opened by probing four ideas from a cold read of the code. Three
of them were already answered on this branch, and the answers were in
`ai-bench/README.md` the whole time:

- **The abondance line is too tight** (91% made, +10.9 realized). Killed by a
  paired counterfactual — force the declined abondance and replay the deal —
  at **-11.86 +/- 0.85** over 120 pairs, with the ev<1.0 bucket at -12.59.
  `marginprobe` had already killed it more cheaply: abondance is the argmax
  family on 10 of 1,439 decisions.
- **`mcChooseBid` throws away biddable runners-up.** 2026-08-05 attempt 1,
  measured +0.0085 +/- 0.0140 and reverted. On today's pre-rebase option sets
  it fired 0 times in 1,242 decisions.
- **The AI over-bids some family.** A paired force-a-pass probe over 259 deals
  says the opposite everywhere: passing instead of the winning bid is worth
  rik -2.82, rik9plus -3.23, rik_beter -0.18, abondance -13.40 pair points.
  Only troela came back positive (+2.50 +/- 1.48, n=4) — which is attempt 1's
  premise, and attempt 1 still lost.

The cost was about two hours of probe time, and the cause was mechanical:
`git fetch` output was truncated to three lines, `origin/ai-candidate` was
missed, and the branch was restarted from `origin/main` — which is also the
default the routine's own instructions offer. **Read this file before probing,
and check that `origin/ai-candidate` is what you rebased onto.**

Branch state: `main` + the 400-world bidder (2026-08-03) + the misère floor
(2026-08-04) + this session's rung withdrawal. Componentwise the first two sum
to +0.001 +/- 0.031 (2026-08-05) and this adds +0.0119 +/- 0.0113, so the
branch is **about +0.013 +/- 0.033 pts/hand against the frozen baseline** —
positive, and a long way from the 0.30 the promotion trigger wants.

The AI code did change this session, so the ceremonial screen was run:
**2500-hand `match.mjs`, -0.152 +/- 0.127** (2 s.e. = 0.254), win rate 47.7%
of 873 decided, 0 violations, control +0.026 against a 3 s.e. band of 0.804,
declarer success 68.6% of 1,216 against the baseline's 68.6% of 1,284 —
**REJECT**, and the promotion trigger is not close, so no 6000-hand
confirmation was spent and `main` is untouched. Put it beside 2026-08-04's
-0.130 +/- 0.130 on nearly the same file: two draws of a branch whose paired
componentwise estimate is +0.013 +/- 0.033. **The gate cannot see this branch
and has not been able to since 2026-08-02.** Everything on it is worth 0.01-0.02
pts/hand, the gate's standard error is 0.127, and the honest reading of a
-0.152 is "no information", not "the branch regressed". Anyone tempted to
revert the branch on this number should read the 2026-08-05 entry first.

## 2026-08-12: the piek gate priced from both sides, and where "fewer overcalls" stops being true

Two attempts, both reverted.

| # | change | `pairscreen` | fired | per fired deal |
|---|---|---|---|---|
| 1 | widen the piek shape gate on forced passes | **-0.005 +/- 0.0255** (6,000) | 4.90% | -0.10 |
| 2 | drop the rik9plus `length >= 7` rung | **-0.110 +/- 0.0299** (4,000) | 4.55% | **-4.19** |

Attempt 2 is the one to read first, because it is the first time the
direction this branch has been pushing for four sessions has lost, and it
loses hard.

### Attempt 2 — the "fewer overcalls" line has a floor, and the seven-baggers are under it

Four paired measurements (2026-08-06, -07, -10) agree that marginal rik 9+
overcalls cost 0.44-1.73 pair points a deal to buy and gain about 1.0 to
withdraw, and 2026-08-10 withdrew the `length >= 5 && honours >= 3` rung on
that basis. The obvious next item in the same direction is the other rung
nobody has priced alone: `length >= 7` with no honour requirement, added
2026-07-31 as "one more card buys the missing honour". It also had an argument
the earlier table could not see — **`MC_BID_SHAPE.rik9plus` draws declarer
trump honours from `[[2, .794], [3, 1]]`, so the sampler has never believed a
rik 9+ declarer could hold fewer than two A/K/Q.** The gate was making a bid
the AI's own world model calls impossible.

Dropping it — leaving the whole overcall gate as `length >= 6 && honours >= 2`
— measures **-0.110 +/- 0.0299 pts/hand over 4,000 paired deals, -4.19 pair
points on each of the 4.55% of deals it moved.** 3.7 s.e. the wrong way and by
far the largest per-fired-deal effect this instrument has recorded here. Zero
violations. Reverted.

`pairscreen`'s contract table names the mechanism, and it is not the dilution
story running backwards: the withdrawn overcalls do not come off rik9 (1,174 ->
1,142) so much as off the HIGH ones — rik10 293 -> 255, rik11 229 -> 197 — and
they land on rik (1,177 -> 1,216) and rik_beter (703 -> 754). A bare
seven-card trump suit is not a marginal nine-trick overcall, it is a sound
ten- or eleven-trick one, and forcing those hands to defend a plain rik
instead is worth -4 pair points a deal.

**Generalise, because the four-row table above invites exactly the wrong
reading.** "Marginal overcalls lose" was measured on rungs that add a FIFTH
trump to a nine-trick contract. It does not extend along the length axis: the
family's losing margin is at the short end, and the long end is where its
+4.13 realized points come from. Before withdrawing another rung, ask which
end of the shape it lives at — and note that the sampler's own honour table
is evidence about the population, not about whether a shape is biddable.

### Attempt 1 — the piek gate, priced from both sides

The useful output is a price for the last unpriced
deterministic gate in `aiChooseBid`, a kill on the largest unpriced population
in the auction, and — the part worth carrying forward — a **direct measurement
of what a forced pass is actually worth**, which several entries above have
been estimating from a constant borrowed out of the misère work.

| population (`gateprobe`, KEY=piek, 600 played hands each) | realized declarer pts | made | share of hands |
|---|---|---|---|
| the piek gate as it stands (one K/A, rest <= 9) | **-0.87 +/- 0.36** | 45.2% | 0.26% |
| one QUEEN OR JACK instead, rest <= 9 | **-1.74 +/- 0.36** | 40.3% | 0.27% |
| one card above a ten, rest <= TEN | **-2.61 +/- 0.35** | 35.5% | 2.26% |
| ... of those, the ones with no other bid | **-3.24 +/- 0.34** | 32.0% | 0.90% |
| **every forced pass, any shape** | **-7.06 +/- 0.22** | 10.8% | 26.6% |

### The piek gate is not too wide, and the 2026-08-02 reading of it was the clumped population

2026-08-02 priced the gate at -2.00 +/- 0.92 (n=90) and left it as a lead:
"same shape of problem as misère, about a third the size". On the carry-over
population `gateprobe` was corrected to on 2026-08-05 it reads **-0.87 +/-
0.36** over 600 hands. Piek pays a flat 3, so the declarer swings +/-9 and the
pair +/-6; against a fallback near -3 pair points that is a contract earning
its keep, and a floor on it would be the 2026-08-05 "stop bidding misère"
mistake again. Do not floor piek — and note the two rows either side of it in
the table, because **the gate's own EV bins barely order the hands** (realized
runs about `-2 + 0.1 x ev` across the whole range, and the four shards
disagree about the sign of the top decile). Shape is the filter here.

### Widening it: right in principle, worth nothing in practice

Both clauses of the gate — the single honour must be a KING OR ACE, and no
other card may reach a ten — are arbitrary, and every population outside them
still clears the break-even. So the widened rule was built ("exactly one card
above a ten, everything else a ten or lower"), restricted to hands
`mcBidOptions` offers nothing for so the fallback is unambiguous, with
`mcSampleWorld`'s `maxRank.piek` and its reserved high slot moved from 9/K to
10/J to match. `pairscreen`, 6,000 deals, 294 of them (4.90%) diverging:
**-0.005 +/- 0.0255 pts/hand, -0.10 pair points per fired deal.** Zero
violations. Reverted.

Two things went wrong, and both are worth knowing before anyone tries again.

**The population in the code was not the population in the probe.** The probe
asks `mcBidOptions(hand, legalBids(null, hand))` — the OPENING option set —
but live, over a standing rik, `legalBids` no longer contains `rik`, so a hand
with a good five-card suit has no option either and qualifies as a "forced
pass". It is not a weak hand; it is a hand that cannot overcall. The fire rate
says how much that mattered: 2.45% of seat-hands against the 0.90% the probe
priced, and `pairscreen`'s contract table prices the difference directly —
piek goes 68 -> 327 contracts and the candidate's new ones realize
**-4.14 declarer points**, against the -3.24 the probe promised for the narrow
version. **A "no options" test is not a hand-strength test once a bid is
standing.**

**And the headroom was never large enough to survive that.** Which is the
finding, because the same run measures the thing the estimate rested on.

### What a forced pass is actually worth: -2.66 pair points, not -3.07

Every entry since 2026-08-05 has priced a marginal bid against "passing with a
hand of nothing but low cards costs about three pair points", a number
obtained by suppressing misères. This session's `pairscreen` measures the same
quantity directly for a much larger population, because the arms differ by
exactly "bid piek instead of passing" on 294 deals: the new pieks realize
2/3 x (-4.14) = -2.76 pair points and the paired difference is -0.10, so the
fallback they replaced was worth **-2.66 pair points**. Close to the borrowed
constant, slightly better, and now measured on forced passes rather than
inferred from misères.

Re-run the arithmetic with it and the whole idea closes. Break-even for piek
moves from -4.6 to **-4.0 declarer points**, so the properly-restricted
population (-3.24) is worth 2/3 x (-3.24) + 2.66 = **+0.50 pair points on
0.90% of hands = +0.0045 pts/hand** — half of what the borrowed constant
predicted, a third of the misère floor, and about a thirtieth of this gate's
MDE. No fix to the population test is worth the 140 minutes it would cost to
fail to measure.

### Negative result: piek is not a home for the forced-pass population

The tempting generalisation, and the reason the wide `gateprobe` run was
worth its ten minutes: **26.6% of hands are a forced pass**, each worth about
-2.6 pair points, and piek only needs ONE trick. Break-even is a made rate of
about 24%. Played out, forced passes realize **-7.06 +/- 0.22 declarer points
as pieks and make 10.8%** — nowhere near it — and the estimator cannot find
the slice that does: floors keeping the top 10%/20%/30% by 60-world piek EV
realize -4.20 +/- 0.99, -5.10 +/- 0.67 and -5.31 +/- 0.53, all still under
the -4.0 line, and the four shards do not agree on the ordering. Against
that background the piek SHAPE rule is a far better filter than the estimator
is: it picks a slice making 32% out of a population making 10.8%.

New `gateprobe` populations for this: `piekWide`, `piekTen`, `piekTwo`,
`piekOrphan`, `orphanAll` (the last two call `mcBidOptions`, so the probe now
loads it and `legalBids` too).

Branch state: unchanged. Both attempts were reverted, so `Rikken.jsx` is
byte-identical to the file 2026-08-10 screened at -0.152 +/- 0.127 and
componentwise estimated at +0.013 +/- 0.033, and the promotion trigger reads
that screen — nowhere near the 0.30 it wants. No `match.mjs` was run, for the
reason the 2026-08-05 entry gives: re-rolling an unchanged candidate through a
0.127-standard-error gate costs 40 minutes and learns nothing.

## 2026-08-13: what the PASSERS proved, and the first information the sampler ever gained

One attempt, kept. It is the first change on this branch that touches
`mcSampleWorld`'s *information* rather than its shape moments, and the reason
it was worth a session is the diagnostic the 2026-07-29 entry ends on:
revealing one opponent's hand is worth **-0.139** per decision against
**-0.005** for quadrupling the search, so information is the binding
constraint by a factor of twenty — and that entry closed by declaring the
channel exhausted, because "the `game` object the AI is handed carries only
`voids` and `playedCount`, not the trick history a real counting player uses".

That is true about the PLAY. It is not true about the AUCTION. Nobody had
asked what the three seats who passed proved by passing.

| # | change | `truthprobe` (paired, per decision) | `pairscreen`, 9,999 deals | fired | per fired deal |
|---|---|---|---|---|---|
| 1 | passers' hands are capped by the overcall they declined | **-0.0060 +/- 0.0037** (41,025 decisions, 2 runs) | **+0.0330 +/- 0.0241** | 10.7% | +0.28 / +0.36 |

### The deduction

`mcBidOptions`'s shape gates are deterministic, and `marginprobe` (2026-08-06)
measured how often each family's bid/pass test then says yes. Put the two
together and a pass is public evidence about SHAPE. The awkward part is that
the AI cannot see WHEN a seat passed — the harness's `game` object carries no
`bidLog`, and the trick-1 leader (which would give the bidding order away) is
gone by trick 2. So only deductions that hold for an early passer *and* a late
one are usable, and there are exactly two:

- **Over a plain rik, no non-declarer held a strong heart suit.** Rik beter is
  hearts, eight tricks, overcall-only, offered by `mcBidOptions` to any hand
  whose hearts reach the trump gate — and `marginprobe` puts that family at
  97.2% bid. A seat that passed BEFORE the rik had the plain rik available on
  the same suit (97.1% bid). Either way it would have bid. So no non-declarer
  held five hearts, or four to the A K Q.
- **Over rik / rik beter / fourth ace, no non-declarer held a seven-card
  suit** (or a six-card suit with two of A/K/Q). That is the rik 9+ overcall
  gate, 75% bid; an early passer holding one of those shapes would have bid
  the plain rik, since a seven-bagger is also a five-bagger.

Both are caps on the ORIGINAL hand, and `playedCount` carries the part already
on the table, so the cap on what is LEFT is exact. Rik, rik beter and troela
are 3,145 of the 5,937 contracts in the 6,000-deal `pairscreen` table, so this
fires on roughly half of all card decisions.

### The sampler was dealing impossible worlds one time in four

Worth stating as a fact about the old sampler rather than as a claim about the
new one. Instrumented over 442 real rik-family decisions (8 sampled worlds
each, original shapes reconstructed with `playedCount`):

| | 5+ hearts, rik contract | 7+ card suit |
|---|---|---|
| the TRUE non-declarer hands | 0.00% (n=1,042) / 1.18% (n=1,101) | **0.00%** in both runs |
| worlds the old sampler drew | 6.87% / 6.94% | 2.35% / 2.93% |
| worlds the capped sampler draws | 4.45% -> **0.53%** | 1.48% -> **0.01%** |

Truth says the deduction is essentially exact. The old sampler put ~10% of
non-declarer seat-hands outside it, which is **~25% of three-hand worlds
impossible on the auction alone**.

**The first version only got a third of them, and measured nothing.** A cap
applied greedily while dealing — the `aceCap` idiom already in the file — reads
6.87% -> 4.45%, because the last cards of a deal have only one seat with room
left and `mcApplyBidInference` swaps cards back into the donor hands after the
deal. `truthprobe` on it: **-0.0008 +/- 0.0063**, a flat null. Adding a
rejection test on the FINISHED world (`mcAuctionOk`, ~one draw in four refused)
takes it to 0.53% / 0.01% and the same probe to **-0.0088 +/- 0.0060**.
Generalise: **when a sampler constraint measures null, check what fraction of
the violations it actually removes before believing the null.** Two-thirds
enforcement bought zero here; full enforcement bought the whole effect.

### It converts, which is the part that has usually failed

Replicated on 600 fresh hands the probe reads **-0.0042 +/- 0.0048**; pooled
over 41,025 decisions, **-0.0060 +/- 0.0037**, best-card rate 88.6% -> 88.8%
in both runs. That is 1.6 s.e. — under the 3 s.e. bar the 2026-07-30 entry
sets — and the 2026-08-04 entry is the standing warning that a much larger
upstream reading (`truthprobe` +0.0118 +/- 0.0037 for the re-mined
`MC_BID_SHAPE`) came back **-0.0365** end to end. So the decision rests on
`pairscreen`, twice:

| run | deals | mean | fired | per fired deal |
|---|---|---|---|---|
| first | 6,000 | +0.0293 +/- 0.0305 | 10.6% | +0.28 |
| replication (pre-registered before it ran) | 3,999 | +0.0390 +/- 0.0392 | 10.9% | +0.36 |
| **pooled** | **9,999** | **+0.0330 +/- 0.0241** | | |

mean - 1 s.e. = **+0.0089 > 0**, zero violations, and the fire rate and the
per-fired-deal effect replicate to two digits (0.107 x 0.31 = 0.033, which is
the internal consistency check the 2026-08-05 entry asks for). **KEPT.**

Ecology: nothing to check, and that is provable rather than measured —
`mcSampleWorld` is called from exactly one place, `aiChooseCardHardest`, so
the auction cannot move. `pairscreen`'s contract tables are identical to the
contract in both runs (rik9 1,748/1,748, rik 1,676/1,676, rik beter
1,118/1,118 over 6,000 deals); only the realized points move (rik 2.76 vs
2.73, troela 1.52 vs 1.63). `MC_BID_CALIB` is untouched. Cost: mean card
decision 49.6 -> 52.6 ms on `truthprobe`, and `timeprobe` reads mean 38.0 ms /
p99 155.7 ms over 624 decisions, inside the budget's terms.

### What is left in this channel, and what is not

- **The big deduction is unreachable.** An EARLY passer — one who passed
  before any bid — had the whole rik gate available and therefore held no
  five-card suit and no four-card A K Q at all. That is ~22% of hands against
  a 65% base rate, a 3x likelihood restriction, far stronger than anything
  above. It needs the bidding ORDER, which is derivable only on trick 1
  (`game.trick[0].seat` is the first bidder when fewer than four cards have
  been played) and is gone afterwards. Expected early passers is ~0.4 per deal
  and trick 1 is a thirteenth of decisions, so it is worth ~nothing at that
  restriction. **If the harness ever hands the AI a `bidLog`, this is the
  first thing to build; until then, do not spend a session on it.**
- **rik 9+ contracts were deliberately left out.** Over a standing rik9 the
  next rung has the same shape gate but a lower bid rate, and one of the three
  non-declarers is usually the original rik bidder rather than a pure passer.
  It is ~2,300 of 6,000 contracts, so it is the obvious next increment — but
  price the bid rate first, the way `marginprobe` priced rik9plus.
- The piek and misère gates are deterministic and would give hard deductions
  on any contract at all. They cover 0.26% and 0.44% of hands: ~nothing.

Branch state: `main` + the 400-world bidder (2026-08-03) + the misère floor
(2026-08-04) + the rik9plus rung withdrawal (2026-08-10) + this. Componentwise
the first three sum to **+0.013 +/- 0.033** (2026-08-05, 2026-08-10) and this
adds **+0.0330 +/- 0.0241**, so the branch is about **+0.046 +/- 0.041
pts/hand** against the frozen baseline — its largest single component to date,
and still an order of magnitude under the 0.30 the promotion trigger wants.

The AI code changed, so the ceremonial screen was run: **2500-hand
`match.mjs`, -0.007 +/- 0.130** (2 s.e. = 0.261), win rate 49.9% of 917
decided, 0 violations, control +0.163 against a 3 s.e. band of 0.735, declarer
success 71.5% of 1,230 against the baseline's 70.9% of 1,270 — **REJECT**, the
promotion trigger is not close, no 6,000-hand confirmation was spent and
`main` is untouched. Put it beside 2026-08-10's -0.152 and 2026-08-04's
-0.130 on nearly the same file: three draws of a branch worth about +0.05
through a 0.13-standard-error instrument. The gate still cannot see this
branch, and -0.007 is "no information", not "the branch regressed".

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

## 2026-08-14: the bidder's opponents were never shaped like real opponents — and it did not matter

Two attempts, and a third idea closed for free before it was coded. The
session's output is a price for two doors that looked open, one new
instrument, and no change to `Rikken.jsx`.

| # | change | instrument | result | |
|---|---|---|---|---|
| 1 | deal the bid estimator's worlds with the clumping the real deal has | `bidtruth`, 2 runs, 5,538 decisions | **+0.0131 +/- 0.0139** | REVERTED |
| 2 | a flat three-ace hand passes instead of bidding troela | `pairscreen`, 2 runs, 9,999 deals | **+0.0276 +/- 0.0126** | **KEPT** |
| 3 | offer a third qualifying trump suit (`strong.slice(0, 2)`) | counted, 16,000 hands | fires **0.00%** | not coded |

New instrument: **`bidrate.mjs`**. What a PASS actually proves, measured rather
than borrowed — deal hands, find the seat-hands matching each shape a sampler
cap would forbid, and ask `aiChooseBid` with each standing high bid in turn.
30 seconds for 200 deals on four cores, and it closed this session's
pre-registered lead before a line of AI code was written.

### The pre-registered rik 9+ cap extension is dead, and `bidrate` killed it in 30 seconds

2026-08-13 closed by naming the obvious next increment: extend the passers'
length cap in `mcSampleWorld` from rik / rik beter / troela contracts to the
~2,300 rik 9+ contracts in 6,000, "but price the bid rate first". Priced:

| shape a cap would forbid | nothing standing | over rik / rik beter / troela | over rik9 | over rik10 | over rik11 |
|---|---|---|---|---|---|
| 7-card suit, or 6 with two of A/K/Q | 100.0% | 98.9% | **76.1%** | 37.0% | 9.8% |
| 5 hearts, or 4 to the A K Q | 96.8% | 97.5% (over rik) | 12.7% | 8.9% | 1.9% |

Read the rik9 column against the rik column. Under a rik contract a passer
holding the overcall shape would have bid it 98.9% of the time, which is why
truth says the deduction is exact (0.00% of true non-declarer hands, n=2,143).
Under a rik9 contract at least one non-declarer's last decision was over the
standing rik9 — the original rik bidder has to pass over it for the auction to
end — and there the rate is 76.1%, so by Bayes a capped seat really does hold
the shape about 3% of the time against an 11.5% base rate. The old sampler
already draws that shape at roughly 2.4%. **The cap would move the sampler
from about-right to zero**: it is not a missing deduction, it is an
over-correction waiting to happen. The lead is closed, not deferred.

Generalise: the 2026-08-13 cap worked because its bid rate was 98.9%, not
because passes are informative in general. **Price the rate before assuming a
pass proves anything** — one 30-second `bidrate` run is worth a session.

### Attempt 1 — the bid estimator's opponents are the wrong SHAPE, and fixing it exactly is worth nothing

`mcBidEVs` has dealt its 39 unseen cards as a uniform permutation since the
day it was written. The table does not deal that way: it gathers the cards
trick by trick and gives the deck two sloppy riffles with a cut, so real hands
are clumped. Measured over 8,000 non-bidder hands of the benchmark's own deal
cycle against a uniform re-deal of the SAME 39 cards:

| | longest suit | 6+ | 7+ | 8+ | voids/hand | suit-len var |
|---|---|---|---|---|---|---|
| the real deal | 5.11 | 29.0% | 7.5% | 1.4% | 0.094 | 2.32 |
| uniform re-deal | 4.92 | 21.7% | 4.6% | 0.6% | 0.056 | 1.91 |

Half the long suits and half the voids — the two shapes that decide whether a
trump contract's side suits run or get ruffed — and much larger than the
mid-hand mismatch `shapeprobe` found in card play, because at bid time all 39
cards are unseen. A one-parameter Polya urn closes it exactly: deal the
shuffled pool card by card, weighting each hand by the room it has left (which
alone reproduces the uniform permutation) times `1 + ALPHA` per card of that
suit it already holds. ALPHA = 0.10 matched all six moments
(5.12 / 29.5% / 8.1% / 1.6% / 0.095 / 2.33).

The coordinate change was measured, not re-derived, per the 2026-07-29 rule —
929 real decisions, the chosen option re-valued at 400 worlds under each
sampler, paired: shift rik 0.157, rik9plus 0.139, rik_beter 0.195, slope 1 to
within noise in all three (r = 0.99). That makes it a pure TRANSLATION, so
`a -> a + b*d`, `c -> c + d_pass*d`, `floor -> floor - d` leaves every call and
every cross-family comparison exactly where it was. `bidtally` confirms it on
2,000 shared deals: **1,985 declared contracts against 1,984**, rik 497/497,
rik9 571/579, rik_beter 388/384, redeals 15/16. Bid cost 69.3 -> 74.6 ms mean,
p99 unchanged.

And then `bidtruth` — the only valid instrument for a sampler question, since
`bidprobe`'s reference moves with the candidate — says it is worth nothing:

| run | hands | decisions | paired dLoss |
|---|---|---|---|
| first | 1,200 | 2,540 | +0.0339 +/- 0.0203 (1.67 s.e.) |
| replication, fresh | 1,500 | 2,998 | **-0.0051 +/- 0.0190** |
| pooled | 2,700 | 5,538 | **+0.0131 +/- 0.0139** (0.94 s.e.) |

Same-call 88.9% vs 89.1% in both runs, confirming the translation kept the
bid/pass call intact and any effect had to come from the ranking. REVERTED —
and note that the first run alone would have been written up as a 1.67 s.e.
win. The 2026-07-30 replication rule earned its keep again.

**This is now the third independent measurement of the same fact**, and it is
worth stating as a standing result rather than re-discovering: the Polya urn
in card play measured null at two strengths (2026-07-29), matching
`shapeprobe`'s moments measured null, and matching the DEAL's moments exactly
at the point of maximum misspecification measures null too. **Shape realism in
this AI's samplers is not where the points are. Do not spend a fourth session
on it.**

### Attempt 2 — the three-ace reflex survived 2026-08-01 in everything but name

2026-08-01 is the entry everyone cites: `aiChooseBid`'s first line ended the
auction on three aces, nothing had ever measured it, and pricing troela against
a rik on the same hand had the rik winning 120 times out of 120. What that fix
could not reach is the hand with no trump suit to name. On 8.3% of live auction
decisions `mcBidOptions` returns a list of length ONE — just troela — and a
one-option list is not a choice: all that is left is the bid/pass test, and for
troela that test is inert. `mcBidFamily` rides troela on the rik line, rolled
troela EVs run +0 to +5, rik's crossover sits at -1.94 and its floor at -1.5.
**The estimator has never once refused a troela.**

The line it borrows is the mechanism. `MC_BID_CALIB.rik`'s PASS arm
(c -1.745, d 0.578) was fitted on hands that reach the rik gate — hands with a
five-card suit, which defend badly. A flat three-ace hand is the opposite: no
suit to name, three certain tricks against whatever anyone else declares.
Borrowing rik's pass arm prices its best alternative far too low, and
2026-08-10's force-a-pass probe had already pointed here (troela the only
family where passing came back positive, +2.50 +/- 1.48, on n=4).

So: `mcBidOptions` returns an empty list when troela is the only option.
`pairscreen`, twice, the second run pre-registered before it was launched:

| run | deals | mean | fired | per fired deal |
|---|---|---|---|---|
| first | 6,000 | +0.0273 +/- 0.0161 | 3.83% | +0.71 |
| replication (pre-registered) | 3,999 | +0.0280 +/- 0.0204 | 3.70% | +0.76 |
| **pooled** | **9,999** | **+0.0276 +/- 0.0126** | | |

mean - 1 s.e. = **+0.0150 > 0**, zero violations in both, and the mean, the
fire rate and the per-fired-deal effect all replicate to two digits — the
internal consistency check the 2026-08-05 entry asks for. **KEPT.**

Ecology, from `pairscreen`'s own contract table on the 6,000: troela
323 -> 148, and the freed auctions land on rik 1,708 -> 1,824 and rik beter
1,089 -> 1,177 (rik9 1,760 -> 1,716). This IS a bid-frequency change — 175 of
6,000 deals stop being declared by a three-ace hand — but every contract it
moves lands in a family with a fitted line, and the absorbing families do not
dilute: realized declarer points rik 2.65 -> 2.71, rik beter 1.78 -> 1.91.
`MC_BID_CALIB` stands.

**One invariant is now approximate, deliberately, and it is the next attempt.**
`mcSampleWorld`'s `aceCap` encodes "nobody who passed on a rik or rik beter was
sitting on three aces". After this change a flat three-ace hand passes, so that
is false on the ~2.9% of deals the change creates. The error runs the safe way
round (it refuses a possible world rather than drawing an impossible one) and
the +0.0276 was measured WITH the cap in place, so the reading is if anything
conservative. It was not repaired in the same commit on purpose: what a
three-ace pass proves depends on what was STANDING when the seat passed, and
the AI cannot see that. Over a plain rik a three-ace passer must be flat; over
a rik beter, or over a rik as a late passer, only troela was ever on offer, so
a five-card suit is perfectly possible. Pricing that properly is its own
attempt.

### The branch-level tension this session surfaced, which is the thing to read next

Ceremonial gate, this session's file: **2500-hand `match.mjs`, -0.113 +/- 0.132**
(2 s.e. = 0.264), win rate 48.4% of 924 decided, 0 violations, control +0.320
against a 3 s.e. band of 0.798, declarer success 68.6% of 1,151 against the
baseline's 69.0% of 1,349 — **REJECT**, and the promotion trigger is nowhere
near 0.30, so no 6,000-hand confirmation was spent and `main` is untouched.

Componentwise the branch is now the 400-world bidder + the misère floor + the
rik9plus rung withdrawal + the passers' cap + this, i.e. about
**+0.074 +/- 0.043 pts/hand**. But put the four ceremonial screens side by side:

| session | code state | 2500 `match.mjs` |
|---|---|---|
| 2026-08-04 | +400-world bidder, +misère floor | -0.130 +/- 0.130 |
| 2026-08-10 | + rung withdrawal | -0.152 +/- 0.127 |
| 2026-08-13 | + passers' cap | -0.007 +/- 0.130 |
| 2026-08-14 | + three-ace pass | -0.113 +/- 0.132 |

Four independent draws of four nested code states, pooling to
**-0.100 +/- 0.066**. Every previous entry has read a single one of these as
"no information", and each one alone is. Four of them are not: -0.100 +/- 0.066
sits **2.6 combined standard errors** below the +0.074 the paired instrument
says the branch is worth. That is no longer comfortably explained as noise, and
it is the most important open question on this branch.

Something is wrong with one of the two readings, and the candidates are worth
naming so the next session can test rather than guess. (1) `pairscreen` seeds
`Math.random` for both arms and resets it per deal, so neither arm ever sees
the production RNG — a change whose value is real under mulberry32 and absent
under the real one would look exactly like this. (2) `pairscreen` keeps redeals
in the denominator and `match.mjs` drops them, which dilutes toward zero but
cannot flip a sign. (3) The deal sequence is A-flavoured after the first
divergence. (4) The components genuinely do not add.

**Do not add another increment before resolving it.** The cheap resolution is
the one 2026-07-30 used: `HANDS=6000 SHARDS=4 node ai-bench/pscreen.mjs` on the
branch head — same estimator as the gate, unpaired, s.e. 0.081, 35 minutes on
four cores — which is powerful enough to distinguish +0.07 from -0.10 at about
2 s.e. If `pscreen` agrees with `match.mjs`, the paired componentwise sum is
the thing to distrust, and every "KEPT" decision since 2026-08-02 needs
re-reading. If it agrees with the paired sum, the four `match.mjs` draws were
an unlucky run and the branch is what it says it is.


## 2026-08-17: the branch has no edge, and the componentwise sum was never evidence

The 2026-08-14 entry ends by naming the most important open question on this
branch — the paired componentwise sum says **+0.074 +/- 0.043** while four
ceremonial `match.mjs` draws pool to **-0.100 +/- 0.066** — and pre-registers
the cheap resolution: a 6,000-hand `pscreen` of the branch head. Run:

    {"hands":6000,"mean":-0.010,"se":0.082,"winRate":0.504,"violations":0}

Pool that with the four `match.mjs` draws and this branch has **16,000 hands**
of unpaired measurement against the frozen baseline:

| session | code state | screen |
|---|---|---|
| 2026-08-04 | +400-world bidder, +misère floor | -0.130 +/- 0.130 |
| 2026-08-10 | + rung withdrawal | -0.152 +/- 0.127 |
| 2026-08-13 | + passers' cap | -0.007 +/- 0.130 |
| 2026-08-14 | + three-ace pass | -0.113 +/- 0.132 |
| 2026-08-17 | head, 6,000-hand `pscreen` | **-0.010 +/- 0.082** |
| **pooled** | | **-0.066 +/- 0.051** |

Against the paired sum's +0.074 +/- 0.043 that is a gap of **0.140 +/- 0.067,
2.1 s.e.** The branch is worth about zero, and the promotion trigger wants 0.30.

### The explanation needs no broken instrument: the sum is a sum of SELECTED estimates

2026-08-14 listed four candidates — the seeded RNG, redeals in the denominator,
the A-flavoured deal sequence, "the components genuinely do not add" — and all
four are about `pairscreen`. None of them is needed, and the real answer was
never a property of the instrument at all:

**The keep rule is `mean - 1 s.e. > 0`, so every kept increment's recorded mean
is at least one standard error above zero by construction, and every reverted
attempt contributes nothing to the sum.** Adding up the kept ones is therefore
guaranteed to produce a positive total no matter what the truth is. The five
components were kept at 1.0 to 1.6 s.e.; the winner's curse on a filter that
tight is most of the recorded value.

That is not an argument against `pairscreen`, which measures exactly what it
claims — the increment of one file over another, on the deal, with 2-9x less
noise than a screen. It is an argument against the arithmetic that has been
applied to its output since 2026-08-05. **Generalise: a componentwise sum over
kept-only changes is not an estimate of a branch's margin, it is an estimate of
the selection bias in the keep rule. Quote the unpaired screen for the branch
and the paired instrument for the change, and never add the second up.**

The practical consequence is the harder one. Six sessions of accumulation have
produced a branch that measures zero, so the accumulate-and-promote strategy is
not converging on the 0.30 the gate wants. Either something worth >= 0.1 turns
up, or the honest reading is that this AI sits at a local optimum its own
instruments cannot see past.

### policyduel.mjs — the component nothing here could measure

`mcPolicy` is the evaluation function under every number this AI computes:
every card rollout and every bid rollout ends in a score it produced. It is
also invisible to all three instruments. `truthprobe`'s yardstick is "best
against THIS rollout policy with everything visible", so it moves with the
change; `pairscreen` needs a change that fires rarely and a policy change fires
on every trick; `match`/`pscreen` have a standard error near 0.10.

But the job is well defined. Inside a sampled world every hand is known, so
mcPolicy is approximating double-dummy play, and "closer to double dummy" means
"beats the other policy with all four hands face up" — directly measurable, and
nearly free, since a face-up play-out is 52 policy calls and no sampling at all.
`policyduel.mjs` deals the benchmark's own carry-over cycle, settles the
contract with ONE auction (the same contract for both arms, so no bid change
contaminates a play comparison), then plays the deal out twice — A at seats 0+2
against B at 1+3, then B at 0+2 against A at 1+3 — and takes half the difference
of the seats 0+2 score, so deal luck and seat bias both cancel.

Validated the way `pairscreen` was: two copies of one file give mean 0, sd 0,
fired 0. Calibrated against a deliberately crippled `mcLowDump` (always shed the
globally lowest card, throwing side-suit masters): **+0.179 +/- 0.023 over
2,000 deals, 7.8 s.e., four minutes on four cores.** That number is the useful
scale — it is what a real policy defect costs in face-up play.

### Three attempts, none kept

| # | change | instrument | result | |
|---|---|---|---|---|
| 1 | mcSampleWorld's `aceCap`, repaired two ways | `truthprobe`, 16,365 decisions | +0.0022 / +0.0039 +/- 0.006 | REVERTED |
| 2 | draw trumps before cashing, in `mcPolicy` | `policyduel`, 16,000 deals | +0.0039 +/- 0.0029 | REVERTED |
| 3 | lead the HIGHEST trump, not the lowest | `policyduel` +0.0210 +/- 0.0061; `pairscreen` +0.038 +/- 0.030 | see below | REVERTED |

#### Attempt 1 — a deduction that silently became false, and cost nothing

`mcSampleWorld`'s `aceCap` encodes "nobody who passed on a rik or rik beter was
sitting on three aces". 2026-08-14 flagged it as an approximation after flat
three-ace hands started passing, estimated the damage at ~2.9% of deals, and
left the repair as the next attempt. Measured instead of estimated
(`acepop`, 1,200 deals of real auctions):

| | rate |
|---|---|
| non-declarer really holds three aces, under a rik / rik beter contract | **12.14% +/- 1.24%** (85 of 700) |
| unconditional base rate for any trio of three hands | **12.50%** (theory 13.1%) |

Read those two rows together: **the pass now proves nothing whatever about
aces.** A hard constraint the sampler applies on 53% of contracts is false at
the base rate — four times the damage 2026-08-14 estimated — and 53% of the
true cases are flat hands.

Two repairs were built: drop the cap for the family entirely (calibrated: the
sampler would draw 12.5% against a truth of 12.1%), and the sound-but-
conservative version that allows only FLAT three-ace passers, the shape that
passes whatever was standing, which is the "holds either way" convention
`mcAuctionOk` follows. Both were rejection tests on the finished world, the
enforcement lesson of 2026-08-13. `truthprobe` over 400 hands / 16,365 paired
decisions: **+0.0022 +/- 0.0062** and **+0.0039 +/- 0.0061** — null, and both
the wrong sign. REVERTED.

**Generalise, because this is the transferable half.** A hard constraint that is
true 88% of the time is worth about as much as an honest posterior, and being
demonstrably wrong on one deal in eight costs nothing this instrument can see.
The 2026-08-13 cap worked because it removed worlds that were impossible **one
time in four**; 12% is apparently below whatever threshold matters. Do not
repair a sampler deduction on the grounds that it is false — measure the rate
first, and expect nothing under about 20%.

#### Attempt 3 — real in face-up play, absent in points, and the replication caught it

`mcPolicy`, on lead, declaring side with the trump majority and no master at
all, leads its LOWEST trump to force the enemy masters out. Leading the highest
is the same forcing play made at the enemy's expense — they must spend the
master on our best trump instead of winning cheaply with a middling one — and
in a known world that is simply better technique. `policyduel` agrees, and
replicated when asked: **+0.0145 +/- 0.0119** on 4,000 deals, **+0.0233 +/-
0.0071** on 12,000 fresh ones, pooled **+0.0210 +/- 0.0061 (3.4 s.e.)** — 12%
of the crippled-discard span, so a real but modest piece of technique.

Ecology first, since a policy change feeds `mcBidRollout`: `bidtally` over 800
shared deals gives **793 declared contracts either way, 7 redeals either way**,
the mix moving only inside families with fitted lines (rik10 -6, rik beter -5,
abondance +4). `MC_BID_CALIB` stands.

Then the end to end, and this is the part worth reading:

| run | deals | mean | fired | per fired deal |
|---|---|---|---|---|
| first | 4,000 | **+0.0955 +/- 0.0462** | 12.68% | **+0.78** |
| replication (pre-registered, independent seeds) | 6,000 | **-0.0043 +/- 0.0396** | 12.95% | **-0.03** |
| pooled | 10,000 | +0.038 +/- 0.030 (1.26 s.e.) | | |

The fire rate replicates to two digits and the effect does not — the internal
consistency check of 2026-08-05, failed. The pooled mean - 1 s.e. is +0.008 and
would technically pass the keep rule; keeping on that, after spending this same
session proving that keeping on 1.3 s.e. readings is what produced a phantom
+0.074, would be indefensible. REVERTED.

This is now the **fourth** upstream reading on this branch that did not convert
(`truthprobe` +0.0118 for the re-mined shape tables, a raw-rollout +0.84 for
flat three-ace four-baggers, `bidtruth` +0.0339 for the clumped bid sampler,
and now a 3.4 s.e. `policyduel` win). The pattern is consistent enough to state
as a rule: **a component measured better is not points, and the only thing that
has ever predicted points here is a paired end-to-end reading that replicates.**

`pairscreen.mjs` gained a `SEED0` env override in the process — its shard seeds
were hardcoded, so a second run of the same two files replayed the same deals
and a "replication" was no such thing. The default is the old constant, so every
number recorded above it still reproduces.

### Free from the contract tables: the misère floor is not doing its job

Both `pairscreen` runs report realized declarer points per contract, and misère
comes back **-3.89 (n=27)** and **-10.14 (n=37)**: pooled **-7.50 over 64
contracts**, about **-7.5 +/- 1.9** at misère's +/-15 spread. The 2026-08-04
floor was supposed to turn the gate's -5.46 into **+4.29**, and live it is
realizing worse than the ungated population did. Small n and a wide spread, so
this is a lead rather than a finding — but it is the cheapest one on the table,
it needs only `gateprobe` and the existing `MISERE_FLOOR`, and it is the one
place a contract family is visibly losing several points a contract. **Start
the next session here.**

Branch state: `Rikken.jsx` is byte-identical to the file 2026-08-14 left. All
three attempts were reverted, so no ceremonial `match.mjs` was run — the
2026-08-12 precedent applies (re-rolling an unchanged candidate through a
0.127-standard-error gate costs 40 minutes and learns nothing) and this session
already has a strictly better 6,000-hand `pscreen` of that exact file. The
promotion trigger reads -0.010 against the 0.30 it wants, so `main` is untouched.

## 2026-08-18: the misère lead was the pooled table again, and the bid estimator does not care what it averages over

Two attempts, both reverted, plus one instrument repair that closes a trap
this directory has now fallen into twice.

| # | change | instrument | result | |
|---|---|---|---|---|
| 1 | condition the bid estimator's worlds on the passes the bid needs | `pairscreen`, 6,000 paired deals | **+0.0053 +/- 0.0204**, fired 3.42% | REVERTED |
| 2 | widen the misère shape gate one rank band, behind the existing floor | `gateprobe`, 800 played hands | increment population **-10.24 +/- 0.39** | REVERTED |

### The 2026-08-17 lead is dead, and the instrument is what needed fixing

That entry closes with "**Start the next session here**": both `pairscreen`
runs report misère at -3.89 (n=27) and -10.14 (n=37), pooled **-7.50 over 64
contracts**, against the +4.29 the 2026-08-04 floor was supposed to buy. It is
not a finding. `pairscreen` seats the frozen `baseline.jsx` at 1+3 and
accumulates `declDelta` for **every declared contract on the table**, and
`baseline.jsx` is `main` as of 2026-08-01 — which has no `MISERE_FLOOR` at all,
because the floor is a branch change. So the column pools the candidate's
floored misères with several times as many unfloored ones.

Split, from this session's own 6,000-deal run:

| | misère contracts | realized declarer pts |
|---|---|---|
| whole table (what 2026-08-17 read) | 29 | **-2.59** |
| the candidate's own declarers, seats 0+2 | 6 | **+10.00** |
| the frozen baseline's, by subtraction | 23 | **-5.87** |

The floor is doing exactly what 2026-08-04 claimed and 2026-08-05 confirmed by
a different route; nothing was wrong except the reading.

2026-08-05 wrote that trap up in full ("Read that column as a table average,
never as a candidate statistic") and it was re-sprung twelve days later, by a
session that had the entry in front of it. So the repair is in the instrument,
not in the next session's discipline: `pairscreen` now prints **two** contract
tables per arm — the whole table as before, and the arm's OWN declarers (seats
0+2), which is the only column that says anything about the arm's bidding.
**Generalise: when a diagnostic pools two different AIs, the fix is a column,
not a warning.**

The same table is worth reading for the rest of the branch, since it is now
the candidate alone (6,000 deals, its own 2,779 declared contracts):
rik 870 @ 2.76, rik9 822 @ 4.03, rik beter 577 @ 2.28, rik10 201 @ 2.58,
rik11 163 @ 2.10, abondance 83 @ 10.12, piek 34 @ -2.65, rik12 20 @ 0.30,
misère 6 @ +10.00, open misère 3 @ -8.00. **No family is losing money**
against the -2.66 pair-point fallback of 2026-08-12 — piek's -2.65 declarer
points is +0.89 pair points against a break-even of -3.99, and it is the worst
row with enough contracts to read. The misère-gate diagnostic of 2026-08-02 has
no successor: there is no second gate quietly bleeding points.

### Attempt 1 — the bid estimator has always priced a branch its own worlds contradict

`mcBidRollout` plays our contract out to the last trick, i.e. it prices the
branch in which the bid **stands** — and a bid stands only when the other three
seats pass over it. `mcBidEVs` has dealt the 39 unseen cards as a uniform
permutation since the day it was written, so it has always been averaging our
contract over opponents who, in the branch it is pricing, cannot exist. This is
the auction-side twin of 2026-08-13's passers' cap in `mcSampleWorld`, and it
reuses the same deduction, the same checker (`mcAuctionOk`) and the same
`bidrate` evidence: 98.9% over rik / rik beter / troela, 97.5% for the rik
beter shape over a rik. Option lists containing a rik 9+ overcall or an
abondance are left uncapped (76.1% / 37% — the over-correction `bidrate` killed
on 2026-08-14). The cap applies on **52.9%** of non-empty option lists.

**The misspecification is the largest anyone has measured in a sampler here.**
Only **43.8%** of uniform draws satisfy the cap, so 56% of the worlds the bid
estimator averaged over were worlds in which the bid could not have stood. For
scale, the card-play cap that produced this branch's largest kept component
refuses about one draw in four.

The coordinate change was measured rather than re-derived, by 2026-08-14's
method — the option each decision actually chose, re-valued at 400 worlds under
both samplers on the same seeded stream, paired over 287 real capped decisions:

    rik        +0.0977 +/- 0.0164  (n=217)
    rik_beter  +0.0435 +/- 0.0185  (n=70)
    slope 0.9928, r 0.9939 over all 287

A pure translation, so `a -> a - b*d`, `c -> c - d_pass*d`, `floor -> floor + d`
leaves every bid/pass call and the one cross-family comparison that mixes a
capped and an uncapped family (rik vs abondance) where the randomized
experiment put them. `bidtally` over 1,500 shared deals agrees: **1,486
declared contracts against 1,487**, redeals 14 vs 13, no family moving by more
than 5. Bid cost 44.8 ms mean / p99 155.5 against 44.3 / 162.3 — rejection
sampling is free here because rollouts dominate the clock.

Measured against a **stream-matched** control, the 2026-08-05 trick (the
control runs the identical rejection loop, consumes the identical random
stream, and keeps the first draw), so the arms diverge only where the
conditioning changes a bid: `pairscreen`, 6,000 paired deals,
**+0.0053 +/- 0.0204**, fired on **3.42%** of deals, +0.17 pair points on each,
0 violations. mean - 1 s.e. = -0.015. REVERTED.

**This is the transferable half, and it is stronger than the shape-realism
result it extends.** 2026-07-29 and 2026-08-14 concluded that matching the
sampler's *moments* to truth is worth nothing — three nulls. This replaces more
than half of the bid estimator's world population with a logically different
one, on half its decisions, and the auction moves on one deal in thirty and
gains nothing. So the standing result is no longer "shape realism is not where
the points are" but: **400 shared worlds plus a calibrated line make the bid
call and the option ranking robust to what the worlds are.** Before proposing
another change to how bid worlds are DRAWN, say what mechanism survives that
sentence — three sessions have now paid for the general answer.

### Attempt 2 — the misère gate is now bracketed on both sides

2026-08-02 left exactly one lead on this gate: "the gate is not obviously too
NARROW... widening is worth trying only behind the same floor, and it needs
`mcSampleWorld`'s `maxRank` raised with it." Built as specified: `lowHand`
`r <= 10` -> `r <= 11`, `maxRank.misere` 10 -> 11.

`gateprobe` on the increment population alone (`WHICH=jackHigh`, 800 played
hands, 400-world EVs, the corrected carry-over table of 2026-08-05):

| population | realized declarer pts | made |
|---|---|---|
| the gate's own (2026-08-05) | -6.95 +/- 0.54 | 26.9% |
| the band one rank higher | **-10.24 +/- 0.39** | **15.9%** |

and what the live floor keeps out of it:

| floor | n | realized | made |
|---|---|---|---|
| keep top 10% (ev >= -1.88, where MISERE_FLOOR sits) | 80 | **+0.38 +/- 1.68** | 51% |
| keep top 20% | 160 | -1.50 +/- 1.18 | 45% |
| keep top 30% | 240 | -3.25 +/- 0.95 | 39% |
| keep top 40% | 320 | -5.63 +/- 0.78 | 31% |

Against misère's break-even of **-3.99 declarer points** (2/3 x D > -2.66, the
forced-pass value measured on 2026-08-12) the floor's band clears by +4.4
points, so the sign is right and the mechanism is the one 2026-08-02 guessed.
The size is the problem. `bidtally`, 3,000 shared deals against the branch
head: misère **12 -> 29**, declared contracts 2,975 against 2,974 (bid
frequency untouched), the extra contracts coming off rik9 (-15) and the rik10 /
rik11 rungs. That is ~17 extra misères per 6,000 deals for one pair at
2/3 x 0.38 + 2.66 = **+2.91 pair points each = +0.008 pts/hand**, resting on
n=80 with a 1.68 standard error.

**No screen can decide that.** `pairscreen` on a change firing near 1.5% of
deals with a +/-10 swing has a standard error near 0.016 at 6,000 deals and
0.011 at 12,000, so mean - 1 s.e. is negative at any run length this directory
would pay for — the keep rule cannot be satisfied by a real effect of this
size, which is 2026-08-17's lesson pointed the other way. Decided upstream
instead, per the 2026-07-27 rule, and upstream says the increment population is
worse on every statistic that matters (-10.24 against -6.95, made 15.9% against
26.9%) and only its top decile is worth having. REVERTED, and recorded as
priced rather than refuted.

With this the gate is bracketed: **too wide** was killed on 2026-08-05
(suppressing misère entirely measured -0.0127 +/- 0.0063, -5.07 pair points on
every misère it removed) and **too narrow** is killed here. The 2026-08-05
verdict — "tuned to within a rounding error in both directions, stop touching
it" — now has evidence on the narrow side too.

### Branch state

`Rikken.jsx` is byte-identical to the file 2026-08-14 left, which 2026-08-17
screened at **-0.010 +/- 0.082** over 6,000 pooled hands. Both attempts were
reverted, so no ceremonial `match.mjs` was run: the 2026-08-12 and 2026-08-17
precedent applies (re-rolling an unchanged candidate through a
0.127-standard-error gate costs 40 minutes and learns nothing) and that
`pscreen` is strictly the better read of the same file. The promotion trigger
reads -0.010 against the 0.30 it wants, so `main` is untouched.

**What the next session should NOT do.** The 2026-08-17 "start here" lead is
retired — see the split table above. So is any further work on the misère gate,
on `MC_BID_CALIB`'s coordinates (2026-08-06 bracketed the last live threshold
from both sides), on `mcBidOptions`'s width (2026-08-01's same-call stopping
rule, 98.7%), and now on how the bid estimator DRAWS its worlds. The two
channels with no two-sided evidence against them are the rik 9+ shape rungs at
the LONG end (2026-08-12 found -4.19 pair points a deal for withdrawing the
seven-baggers, i.e. the family's value lives there and nobody has pushed that
end outward) and `mcPolicy`, where `policyduel.mjs` can measure a change at
0.023 on a 0.179 scale but 2026-08-17's attempt 3 showed a 3.4 s.e. win there
need not convert.

## 2026-08-19: the abondance door was shut, and it opens onto a very small room

Three attempts, none kept. Two of them are the first serious look at contracts
this AI *chooses between*, rather than at whether it bids at all, and both come
back the same way: right sign, correct mechanism, far too small to establish.

| # | change | upstream / paired | 2500 `match` | |
|---|---|---|---|---|
| 1 | abondance offered on the rik 9+ shape gate | `pairscreen` 6,000 **+0.0067 +/- 0.0075**, fired 0.23% | **+0.123 +/- 0.127** (mean - 1 s.e. = -0.004) | REVERTED |
| 2 | discard by what a card is DOING, not its rank | `policyduel` 4,000 **-0.018 +/- 0.0163** | none spent | REVERTED |
| 3 | four-card trump suits with TWO of A/K/Q | `pairscreen` 4,000 **+0.052 +/- 0.0279**, replication **-0.012 +/- 0.0252**, pooled **+0.020 +/- 0.019** | killed by a container restart | REVERTED |

### Attempt 1 — the one contract that pays 12 for nine tricks, and why so few hands can take it

`mcBidOptions` gated abondance a full card above the nine-trick OVERCALL it
sits next to: `length >= 8 || (length >= 7 && hon >= 2) || (length >= 6 &&
hon >= 3)` against the overcall's `length >= 7 || (length >= 6 && hon >= 2)`.
So a bare seven-bagger and a six-bagger with two honours were asked "can you
take nine tricks WITH a partner?" and never "can you take nine alone?" — the
same nine tricks, paid 12 instead of 4. Setting the two gates equal is the
whole change.

It is the right question, and the contract table says so. Ecology over 1,500
shared deals: declared contracts **1,486 against 1,487**, so bid frequency is
untouched and `MC_BID_CALIB`'s population argument holds; abondance goes
39 -> 48 and the extra contracts come one or two at a time off rik, rik9,
rik10, rik11 and rik12. Over 6,000 paired deals the ten extra abondances
realize about **+7.2 declarer points each** against the +2.3 to +4.1 of the
rungs they replace, and the paired difference is **+2.86 pair points on each
of the 14 deals that moved**.

**And that is the whole harvest, because the shape gate was not the binding
constraint.** Widening it one notch further (`length >= 6 || (length >= 5 &&
hon >= 3)`) adds **four** more abondances per 1,500 deals — and drags a mix
change with it (troela 0 -> 6, rik9 -10) that is worth more than the four.
The reason is in the calibrated line, not the shape: `abondance` is
`a -2.636 / b 1.250` against a FLAT pass arm (`c 0.700, d 0`), so its
crossover sits at a rolled-out EV of **+2.67** — a solo nine-trick make rate
around 60% before the estimator will touch it. Six-baggers do not clear that
however they are shaped.

So the abondance gate is now bracketed the way the misère gate was on
2026-08-18: **too narrow was worth +0.007 pts/hand, and one notch wider than
that is worth nothing at all.** Do not spend another session here. The general
form is worth carrying: *when a shape gate and a calibrated floor guard the
same family, widening the gate only pays while the gate is the tighter of the
two — measure which one is binding before proposing the widening.*

The 2500-hand `match.mjs` came back **+0.123 +/- 0.127**, win rate 53.0%, 0
violations, control +0.422 against a 3 s.e. band of 0.746. mean - 1 s.e. is
**-0.004** — the keep rule fails by four thousandths of a point, on a screen
whose standard error is nineteen times the effect the paired instrument
measured. Reverted, and recorded as priced rather than refuted.

### Attempt 2 — the discard rule was already better than the theory that replaced it

`mcLowDump` sheds the lowest side-suit non-master, which is blind to what a
card is doing: our side's fourth card of a suit the enemies hold three of is a
trick (their cards run out under it) and a singleton eight never wins anything,
yet the eight survives on rank alone. In a sampled world the difference is
exact, so each candidate was priced by what the side's suit trick count loses
when it goes — pair our cards against theirs highest-first, count the ones on
top, surplus length riding free — and only zero-cost cards were shed.

`policyduel`, 4,000 face-up deals: **-0.018 +/- 0.0163**, fired on 223 deals.
Wrong sign at 1.1 s.e., about a tenth of the crippled-discard span the
instrument is calibrated on. No screen was spent.

The diagnosis is in the metric's own assumption. Counting surplus length as
tricks makes the policy HOARD long-suit spot cards and pitch short-suit ones,
and in a trump contract that length does not run — it gets ruffed. The rule it
replaced pitches the globally lowest card, which is the same bet without the
theory, and it is better. **Generalise: a suit-by-suit trick count is a
no-trump idea, and mcPolicy spends most of its life in a trump contract.**

### Attempt 3 — the last shape the trump gate refused, and a fire rate that replicated when the effect did not

The trump gate is `length >= 5 || (length >= 4 && hon >= 3)`. Four to the
A K Q is in, five bare is in, and four to the A K — two certain trump tricks
plus the called ace, against a rik's eight-trick target across two hands — is
the one shape between them that was still a forced pass. Widening to
`hon >= 2` is the next notch on the substitution axis that produced every real
gain this branch has (2026-07-31, 2026-08-01).

Ecology, 1,500 shared deals: declared **1,499 against 1,487**, the difference
being redeals that no longer happen (**13 -> 1**), so bid frequency is again
untouched. What moves is WHICH contract stands, and it moves a lot: the shape
it feeds is the rik beter overcall in hearts (whole table 781 -> 892 over
4,000 deals), realizing 1.6 to 2.1 declarer points against a break-even of
-3.99.

`pairscreen`, 4,000 paired deals: **+0.052 +/- 0.0279**, fired 6.08%, +1.48
pair points per deal moved, 0 violations — the largest increment measured on
this branch in a month. Pre-registered replication on independent seeds
(`SEED0`), 4,000 fresh deals: **-0.012 +/- 0.0252**, fired **6.18%**, -0.35
pair points per deal moved. Pooled over 8,000: **+0.020 +/- 0.019**.

That is the 2026-08-05 internal-consistency check failing in the same shape as
2026-08-17's attempt 3: **the fire rate replicates to two digits and the effect
does not.** The ceremonial `match.mjs` was running on this code when the
container restarted and was lost; it was not re-run, because at a true effect
near 0.02 a 0.127-standard-error screen is a coin flip whose only possible
function is to license keeping something the better instrument declined to
confirm. REVERTED.

### Branch state

`Rikken.jsx` is byte-identical to the file 2026-08-14 left, which 2026-08-17
screened at **-0.010 +/- 0.082** over 6,000 pooled hands and 2026-08-18 also
left untouched. All three attempts were reverted, so no ceremonial `match.mjs`
of the branch head was run — the 2026-08-12 / -17 / -18 precedent applies. The
promotion trigger reads -0.010 against the 0.30 it wants, so `main` is
untouched.

**What the next session should know.** Two of this session's three attempts
were bid-OPTION questions and both landed in the same place, which is now a
pattern worth naming: every remaining widening of `mcBidOptions` is guarded by
a calibrated floor that is tighter than the shape gate, so the population it
can add is tiny (attempt 1) or the auction absorbs it without the score moving
(attempt 3). The channels 2026-08-18 named as having no two-sided evidence are
both closed by this session — the rik 9+ long end IS the abondance question
(attempt 1), and `mcPolicy` took its second null in three sessions (attempt 2).
An operational note, since it cost this session two hours: at the current
400-world bid estimator a 2500-hand `match.mjs` takes **over two hours** on
this box, not the 40 minutes the older entries assume, and a 6,000-deal
`pairscreen` on four shards takes about two. Budget accordingly, and run the
paired instrument FIRST.

## 2026-08-20: the rollout told every seat who the partner was, and the screen would not hear it

One idea, two forms, both measured on paired end-to-end deals and both
positive; the ceremonial 2500-hand screen came back **-0.211 +/- 0.126** and
the keep rule took the file back to where it started. The numbers and the exact
patch are recorded below because the paired evidence is the strongest this
branch has produced since 2026-08-01, and a future session should be able to
re-apply it in one step rather than re-derive it.

| # | change | `pairscreen`, paired end-to-end | fired | |
|---|---|---|---|---|
| 1 | no seat but the ace-holder knows the partnership, inside `mcRollout` | 4,000: **+0.0570 +/- 0.0552**; 6,000 fresh seeds: **+0.0627 +/- 0.0459**; **pooled 10,000: +0.0604 +/- 0.0353** | 16.4% / 16.8% | REVERTED on the screen |
| 2 | ...except the declarer, who keeps the world's answer | 3,000: **+0.0547 +/- 0.0603**; 3,000 fresh seeds: **+0.0920 +/- 0.0580**; **pooled 6,000: +0.0734 +/- 0.0418** | 15.9% / 15.4% | measured on top of #1, so it fell with it |

### The blind spot

`mcRollout` plays a sampled world in which every hand is known, and it passed
`mcPolicy` one `side` array for all four seats. In a rik that array is a fact
nobody at the table has yet: the declarer called an ace they do not hold and
cannot see who holds it, each defender knows only that the partner is one of
the two seats that are neither themselves nor the declarer, and only the holder
of the ace knows anything. The engine models this exactly — `contract.revealed`
is false until the called card is played, and `legalMoves`'s
`mustPlayCalledOnFirstLead` clause is written on the same fact — but the search
underneath the AI has always played the hand as if the ace were face up.

Two things that a rik turns on are therefore invisible to it: the partner's
reason to stay hidden, and everyone else's reason to smoke the ace out. Neither
can appear in an evaluation where the answer is free.

The patch gives each uninformed seat a BELIEF instead — one candidate holder
drawn per rollout and held until the ace is actually played, which is the
determinization convention the search already runs on, applied one level down:

    const views = [side, side, side, side];
    if (!revealed && partner != null) {
      for (let p = 0; p < 4; p++) {
        if (p === partner) continue;
        const cand = [0, 1, 2, 3].filter((q) => q !== p && q !== c.declarer);
        views[p] = [c.declarer, cand[(Math.random() * cand.length) | 0]];
      }
    }

with the one call site becoming
`mcPolicy(hands, turn, trick, trump, wc, revealed ? side : views[turn], c, tricks)`.
Attempt 2 is the same patch with `if (p === partner || p === c.declarer)`.

**`mcBidRollout` was deliberately left alone**, and that is what makes the
reading clean: the bid estimator is byte-identical, so `MC_BID_CALIB` cannot
have moved and the auction cannot have shifted. `pairscreen`'s contract tables
confirm it exactly — rik 1808 against 1808, rik9 1734 against 1734, every
family identical in both arms of both runs. Nothing here is an ecology effect;
the whole difference is card play.

### What replicated

Both attempts pass the internal-consistency check of 2026-08-05 that killed
2026-08-17's attempt 3 and 2026-08-19's attempt 3: **the fire rate replicates
to two digits AND the effect replicates**, on independent `SEED0` draws. That
is the pattern 2026-08-17 named as the only thing that has ever predicted
points here — "a paired end-to-end reading that replicates" — and it is why
this entry carries the patch instead of a paragraph of regret.

Timing, with attempt 1 in and the box under load from a concurrent `match.mjs`:
mean 33.1 ms per decision, p99 149.8 ms, trick-1 mean 84.2 ms. Inside budget.

### What the screen said, and what it was measuring

    {"verdict":"REJECT","mean":-0.211,"se2":0.253,"winRate":0.478,
     "hands":2500,"violations":0,"controlMean":-0.093,"controlSuspicious":false}

mean - 1 s.e. = **-0.337**, so the keep rule reverts, and it was reverted.

Read what that screen is a measurement OF, though, because it is not attempt 1.
It is the whole branch against the frozen baseline, and the branch was last read
at **-0.010 +/- 0.082** over 6,000 pooled hands (2026-08-17, unchanged since).
Back out the increment and this screen implies attempt 1 is worth
**-0.20 +/- 0.15**, against **+0.060 +/- 0.035** from 10,000 paired deals. The
two are 1.7 s.e. apart — not a contradiction, and precision-weighting them
leaves the best estimate of the change at about **+0.047**.

**The structural point, for whoever writes the next session's rules.** The keep
rule tests `branch vs baseline`, but what an attempt controls is
`branch+change vs branch`. With the branch sitting at zero and the screen's
standard error at 0.127, a change worth its predicted +0.06 clears
`mean - 1 s.e. > 0` about one run in three no matter how real it is — the filter
is mostly reading the branch's own noise, not the attempt's merit. That is the
2026-07-31 lesson ("treat a failed 2500-hand screen of an upstream-verified
change as a null result, not as evidence against it") arriving from the
arithmetic rather than from a war story. A rule that gated on the paired
instrument, and spent the screen only on the promotion decision, would keep the
same work and cost four hours less per session.

### For the next session

The decisive experiment is pre-registered and cheap relative to what was spent
here: re-apply the patch above (attempt 2's form, which pooled higher) and run
**`HANDS=6000 SHARDS=4 node ai-bench/pscreen.mjs`** against the frozen
baseline — same estimator as `match.mjs`, standard error 0.081 instead of
0.127, four cores instead of one, and it reads the branch rather than a
2,500-hand draw of it. The prediction on the table is `-0.010 + 0.073`, i.e.
about **+0.06 +/- 0.081**; the honest reading is that even that will not settle
a change of this size, and what it CAN do is rule out the -0.20 the ceremonial
screen suggested. If it does, the pair of patches is worth carrying.

Operationally, from this session: a 2500-hand `match.mjs` plus its control ran
**2h15m single-threaded** on this box, while a 6,000-deal `pairscreen` on four
shards took ~90 minutes and a 4,000-deal one ~55. `match.mjs` is single-process,
so three of four cores sit idle for its whole run — attempt 2 above was measured
in that dead time at no wall-clock cost, which is worth doing every session the
ceremony has to be paid.

### Branch state

`Rikken.jsx` is byte-identical to the file 2026-08-14 left, which 2026-08-17
screened at -0.010 +/- 0.082 over 6,000 pooled hands and which 2026-08-18 and
2026-08-19 also left untouched. Both attempts were reverted under the keep rule,
so the promotion trigger reads that same -0.010 against the 0.30 it wants and
`main` is untouched.
