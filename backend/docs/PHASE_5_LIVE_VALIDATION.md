# Phase 5 — Live model validation (the hard gate)

The live probability models (Phase 4) are only allowed to produce a *pick* if a
leakage-free replay of finished games shows they beat the **score-and-time**
baseline on held-out data. This document is the honest output of that replay. It
is generated, never hand-written: the numbers below come straight from
`services/live/backtester.js`.

## How to run it

```bash
cd backend

# 1. Offline smoke test — deterministic, signal-free data. Proves the plumbing
#    runs. NEVER quote its numbers as model quality.
node scripts/run-live-backtest.js --synthetic=200

# 2. Real ESPN history (finished games only), one request per day per league.
node scripts/run-live-backtest.js --sport=basketball --dates=20260301-20260321 --max-games=60
node scripts/run-live-backtest.js --sport=soccer     --dates=20260307-20260314 --max-games=25

# 3. The full two-season sweep (Phase 8). Cached on disk, so a re-run or a
#    resumed run costs no extra network traffic.
node scripts/run-live-backtest.js \
  --concurrency=12 --max-games=100000 \
  --out=data/live-report-phase8.json > data/live-report-phase8.txt

# 4. The Phase 9 reports: per-league basketball holdout, soccer `scoreTime`
#    absolute calibration, market coverage and latency. Same cached history.
node scripts/run-live-phase9-report.js --out=data/live-report-phase9.json

# 5. Fit and persist the live calibrator, record the forward-test benchmark, and
#    re-confirm the gate on the column production actually serves. `--dry-run`
#    reports without writing.
node scripts/fit-live-calibrator.js --dry-run
```

Unit tests: `npx jest tests/live-backtest.test.js` (replay extraction,
no-leakage cutoffs, the score-and-time baseline, the calibration gate, the ship
gate, the verdict wording) and `npx jest tests/live-dataset.test.js` (the sweep
planner and the ESPN cache/throttle).

## Method

- **Walk-forward windows.** Games are ordered by kickoff and split chronologically
  `train 0–0.6 / validation 0.6–0.8 / test 0.8–1.0` (`liveBacktest.windows`). The
  walk-forward calibrator is refitted every 25 games from **strictly earlier**
  games only.
- **Leakage-free checkpoints.** Every checkpoint is a state snapshot (score,
  clock, period) reconstructed from plays/events *at or before* that moment
  (`services/live/replay.js`). The snapshot never sees the game's own future, and
  the final-period buzzer is excluded because by then the game is decided.
  - basketball: `summary.plays[]` → `homeScore` / `awayScore` /
    `period.number` / `clock.displayValue`, marks at 6 and 3 minutes left in
    every period (plus each period end except the last).
  - soccer: `summary.keyEvents[]` → running score after each goal at minutes
    15 / 30 / 45 / 60 / 75.
- **The bookmaker line is NOT a comparison reference.** It is read from
  `summary.pickcenter[0]` and de-vigged (`removeVig`), but it is one price per
  game applied at every checkpoint, so an in-game model beats it by construction.
  It is reported **for information only** and labelled
  `pregameLine (info only, not comparable)`; it is dropped from every comparison
  claim. The live models never read it.
- **The reference baseline is `scoreTime`** (and `prior` for the pre-game-only
  view). Every column is scored on the identical set of graded checkpoints.

## Gates

**Calibration gate** (`liveBacktest.calibration`). A fitted calibrator is kept
only if, on the validation window, it improves **both** Brier and log loss by
≥ 0.002, stays monotone, and has ≥ 150 graded rows. Otherwise the identity is
kept — the shipped probability is the raw one.

**Ship gate** (`liveBacktest.shipGate`). The gate counts **GAMES, not checkpoint
rows**. A single game contributes ~11 (basketball) or ~5 (soccer) checkpoints,
and those checkpoints share one outcome, so counting rows would let ten games
masquerade as a hundred independent observations. A sport ships a live pick only
if, on the out-of-sample **test** window:

1. `games ≥ shipGate.minGames` (**500**), and
2. the shipped probability beats **`scoreTime`** on **both** Brier and log loss
   by ≥ 0.002, with the **bootstrap gain interval** (2000 resamples of *whole
   games*, percentile 2.5/97.5) strictly above zero for both metrics, and
3. the hit-rate 95 % interval lower bound is above break-even (0.524 at −110).

The pre-game-only baseline (`prior`) is reported but is **not** a gate clause.
Anything else reports **why** it failed.

**League sanity (sport-level gate).** A single league's sample is too small for
an independent gate, so the gate is evaluated at **sport level**, then each
league with ≥ `shipGate.minLeagueGames` (**100**) graded test games is checked as
a sanity test: a league is **BLOCKED** if its own Brier or log loss gain against
`scoreTime` is negative (it contradicts the sport-level result). Leagues below
100 games are reported **unjudged**.

## Results — full two-season sweep (ESPN, 2024-05-04 → 2026-05-31)

Dataset: **16,703 games**, **102,388 checkpoints**, 0 skipped, 11,499 without a
bookmaker line (still graded — the models never need a line). Sweep: **11,707**
scoreboard reads over **761** distinct days; disk cache 19,323 hits / 9,168
misses / 9,118 fetched / 339 errors.

Per-sport/season coverage (see [LIVE_COVERAGE.md](LIVE_COVERAGE.md) for the
per-league breakdown):

| Sport | Season | Date range used | Games |
|---|---|---|---|
| basketball | 2024 | 2024-05-04 → 2024-10-21 | 275 |
| basketball | 2025 | 2025-05-02 → 2025-10-01 | 323 |
| basketball | 2024-25 | 2024-10-22 → 2025-04-13 | 2,199 |
| basketball | 2025-26 | 2025-10-21 → 2026-04-13 | 2,388 |
| soccer | 2024-25 | 2024-08-02 → 2025-06-01 | 5,720 |
| soccer | 2025-26 | 2025-08-01 → 2026-05-31 | 5,798 |

Overall (all checkpoints): rows 102,388 · games 16,703 · hit rate 50.6 % ·
avg predicted 49.6 % · gap +1.0 pp · Brier 0.1677 · log loss 0.5059.

| Window | rows | games | hit | avg pred | gap | Brier | log loss |
|---|---|---|---|---|---|---|---|
| train | 61,500 | 10,022 | 49.7 % | 48.9 % | +0.8 pp | 0.1699 | 0.5166 |
| validation | 21,075 | 3,341 | 53.5 % | 52.1 % | +1.4 pp | 0.1637 | 0.4858 |
| test | 19,813 | 3,340 | 50.3 % | 49.0 % | +1.3 pp | 0.1653 | 0.4941 |

### Baselines (test window, same selections)

| Column | log loss | Brier | hit | n | games |
|---|---|---|---|---|---|
| **model (shipped)** | **0.4941** | **0.1653** | 75.5 % | 19,813 | 3,340 |
| model, uncalibrated | 0.5039 | 0.1655 | 75.5 % | 19,813 | 3,340 |
| walk-forward calibrated | 0.4932 | 0.1653 | 75.5 % | 19,813 | 3,340 |
| score-and-time baseline | 0.5029 | 0.1669 | 75.3 % | 19,813 | 3,340 |
| pre-game prior | 0.6878 | 0.2473 | 55.2 % | 19,813 | 3,340 |
| `pregameLine` (info only, not comparable) | 0.5791 | 0.1987 | 67.8 % | 19,734 | 3,322 |
| naive coin flip | 0.6931 | 0.2500 | 50.3 % | 19,813 | 3,340 |

### By time bucket (test window; late checkpoints are near-decided)

A checkpoint's bucket is the fraction of the game already played (`bucketEdges`
`[0.3333, 0.6667]` → early / mid / late). The `excludingLate` row is the
headline that late, near-decided checkpoints cannot inflate.

| Sport | Bucket | rows | games | hit | Brier | log loss | ref `scoreTime` log loss |
|---|---|---|---|---|---|---|---|
| basketball | early | 2,817 | 940 | 57.9 % | 0.1903 | 0.5584 | 0.5638 |
| basketball | mid | 2,907 | 936 | 57.0 % | 0.1319 | 0.4014 | 0.4238 |
| basketball | late | 2,089 | 529 | 55.9 % | 0.0922 | 0.2978 | 0.3106 |
| basketball | **excludingLate** | **5,724** | **940** | **57.4 %** | **0.1607** | **0.4786** | — |
| soccer | early | 2,400 | 2,400 | 46.0 % | 0.2322 | 0.6563 | 0.6570 |
| soccer | mid | 7,200 | 2,400 | 46.0 % | 0.1828 | 0.5421 | 0.5469 |
| soccer | late | 2,400 | 2,400 | 46.0 % | 0.1203 | 0.3958 | 0.4082 |
| soccer | **excludingLate** | **9,600** | **2,400** | **46.0 %** | **0.1951** | **0.5706** | — |

Note the headline gate hit rates (below) include late checkpoints and are
therefore higher than the `excludingLate` figures here — this table is why the
report never quotes the inflated number as the whole story.

### Calibration gate (train → validation)

| Sport | fitted | monotone | Brier gain | log-loss gain | kept | trained / validated |
|---|---|---|---|---|---|---|
| basketball | true | true | 0.0035 | 0.0273 | **true** | 25,485 / 11,500 |
| soccer | true | true | 0.0002 | 0.0004 | **false** | 36,015 / 9,575 |

Soccer's calibrator did not clear the ≥ 0.002 double-improvement bar, so the gate
kept the identity and soccer ships **raw** probabilities. This is the required
fallback: no calibrator ships that has not beaten the identity.

### Ship gate (out-of-sample test window; reference: `scoreTime`)

**basketball — PASS** · games 940/500 · rows 7,813 · hit 79.1 % (CI-low 77.2 %)
· Brier gain **0.0032** · log-loss gain **0.0137**
· Brier gain CI [0.0001, 0.0064] · log loss gain CI [0.0015, 0.0270]
(2,000 game-level resamples)

- `mens-college-basketball` — **ok** — 430 games · Brier gain 0.0050 · log-loss gain 0.0137
- `nba` — **ok** — 510 games · Brier gain 0.0025 · log-loss gain 0.0137

**soccer — FAIL** · games 2,400/500 · rows 12,000 · hit 73.2 % (CI-low 71.9 %)
· Brier gain **0.0005** · log-loss gain 0.0055
· Brier gain CI [−0.0003, 0.0014] · log loss gain CI [0.0021, 0.0092]

- **Reason: Brier gain 0.0005 < 0.002** (and the Brier gain interval crosses zero).
- League sanity (≥ 100 games judged):
  - **ok**: `bra.1` 170 · `eng.2` 202 · `esp.2` 205 · `ger.1` 129 · `ger.2` 130 ·
    `ita.2` 172 · `mex.1` 137 · `ned.1` 128 · `por.1` 132 · `usa.1` 218
  - **BLOCKED**: `eng.1` 146 (log loss −0.0008) · `esp.1` 167 (Brier −0.0015,
    log loss −0.0019) · `ita.1` 157 (Brier −0.0027, log loss −0.0059) ·
    `tur.1` 129 (Brier −0.0025, log loss −0.0029)
  - **unjudged** (< 100 games): `sco.1` 88 · `uefa.champions` 45 · `uefa.europa` 45

**Verdict.** The gate **PASSED for 1 sport** — **basketball** — where the shipped
live probability beats `scoreTime` on both Brier and log loss with the gain
interval above zero and a hit-rate lower bound above break-even. **Soccer FAILED**
on the Brier-gain clause. `CONFIG.live.picks` remains **empty for both sports**,
so **no live probability is currently shown**; see the recommendation below.

## Honest findings (including where the model is weak)

1. **Basketball clears the gate; soccer does not.** Basketball's edge over
   `scoreTime` is real and reproducible at this sample size (Brier +0.0032,
   log loss +0.0137, both intervals above zero, n = 940 games > 500). Soccer's
   Brier gain (0.0005) is below the 0.002 bar and its interval crosses zero: the
   Phase 4 soccer machinery is barely distinguishable from "the score is what it
   is and there is this much time left". **Recommendation: ship the simple
   `scoreTime` model for soccer** rather than the anchored model (see below).
2. **Do not read the headline hit rates as pick quality.** The 79.1 % / 73.2 %
   gate hit rates include late, near-decided checkpoints. On the `excludingLate`
   view basketball is 57.4 % and soccer is 46.0 %. The honest per-bucket numbers
   are in the table above.
3. **The calibrator earned its place for basketball and only for basketball.**
   Basketball's calibrator improved validation Brier by 0.0035 and log loss by
   0.0273 (kept); soccer's gained 0.0002 / 0.0004 (rejected → raw probabilities).
4. **The market line is a strong baseline, not a weak one.** The de-vigged
   `pregameLine` (log loss 0.5791, Brier 0.1987) is far better than the naive
   coin flip and better than the pre-game prior — it is a hard reference, which
   is exactly why it is reported for information and never used as the bar.
5. **Per-league soccer verdicts are unstable at 100–220 games,** which is why the
   gate is sport-level with the per-league sanity check. `eng.1`, `esp.1`,
   `ita.1` and `tur.1` each contradict the sport-level result on at least one
   metric and are BLOCKED; three competitions (both UEFA cups, `sco.1`) are below
   100 games and left unjudged rather than guessed at.

## Recommendation for soccer — ship `scoreTime`, not the anchored model

Per the standing fallback rule, if soccer does not beat `scoreTime` by a
meaningful margin the simple model should ship instead. Soccer's Brier gain
(0.0005, CI [−0.0003, 0.0014]) does **not** clear the margin. The proposed
changes (to be applied only on approval, and **not** loosening the gate):

1. Keep `CONFIG.live.picks.soccer` **empty** — soccer does not ship a probability
   today under either model.
2. When a soccer probability is eventually offered, source it from the
   `scoreTime` baseline (`liveBacktest.baselines.scoreTime.soccer`) and label it
   as a score-and-time estimate, not the anchored model.
3. Re-evaluate the anchored soccer model only after the blocked leagues are fixed
   or the sample per league grows; the sport-level gate stays as-is.

## Phase 9 — the calibrator in production, and the hold

### What changed since Phase 8

1. **The calibrator is now served.** Phase 8's gate scored `pShipped` — the
   walk-forward **calibrated** home-win column when the calibration gate kept the
   calibrator — but production served the **raw** model output (`pRaw`), because
   `services/live/liveModel` applied no calibrator. That was a real gap: for
   basketball the validated column was not the served column.
   `scripts/fit-live-calibrator.js` now fits the kept calibrator, persists it
   (`CONFIG.live.calibration.file` = `data/live-calibrator.json`, market
   `home_win`), and `services/live/liveCalibrator.apply` serves exactly that
   column in production. Soccer's calibrator was **not** kept, so nothing was
   written for it and production serves soccer **raw** — the required fallback.
2. **The gate is re-confirmed on the column production shows.** Three columns are
   scored on the same held-out test window:
   - `raw` — what production served before (no calibrator);
   - `shipped` — the walk-forward calibrated column Phase 8 scored;
   - `production` — the honest, **leakage-free** proxy: a calibrator fitted on
     **train + validation only** and applied to the test window, i.e. exactly
     what a deploy-time fit does on unseen games.

### Re-confirmed ship gate — basketball and soccer, three columns (test window, reference `scoreTime`)

| Sport | Column | games | hit | CI-low | Brier | log loss | Brier gain | log-loss gain | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| basketball | `raw` | 940/500 | 78.9 % | 77.0 % | 0.1430 | 0.4552 | 0.0026 | **−0.0112** | FAIL |
| basketball | `shipped` | 940/500 | 79.1 % | 77.2 % | 0.1424 | 0.4303 | 0.0032 | 0.0137 | PASS |
| basketball | **`production`** | 940/500 | 79.1 % | 77.2 % | 0.1425 | 0.4306 | 0.0031 | 0.0134 | **FAIL** |
| soccer | `raw` | 2,400/500 | 73.2 % | 71.9 % | 0.1802 | 0.5357 | 0.0005 | 0.0055 | FAIL |
| soccer | `shipped` | 2,400/500 | 73.2 % | 71.9 % | 0.1802 | 0.5357 | 0.0005 | 0.0055 | FAIL |
| soccer | `production` | 2,400/500 | 73.2 % | 71.9 % | 0.1804 | 0.5346 | 0.0003 | 0.0066 | FAIL |

Bootstrap intervals for the basketball `shipped` column (2,000 game-level
resamples): Brier-gain CI **[0.0001, 0.0064]**, log-loss-gain CI
**[0.0015, 0.0270]**, hit-rate CI-low **0.772**. The forward-test benchmark is
basketball's shipped test log loss, **0.4303**.

### The hold decision

**Basketball's `production` column fails exactly one gate clause, and it fails by
the smallest possible margin: its Brier-gain 95 % CI lower bound is `0` (it
rounds to `0.0000`) and the gate requires it to be strictly above zero.** Every
other clause passes — 940 games > 500, log-loss gain 0.0134 > 0.002, log-loss-gain
CI-lower 0.0015 > 0, hit-rate CI-lower 0.772 > 0.524. The `shipped` column clears
all clauses (CI-lower 0.0001), but `shipped` is the optimistic column; `production`
is the column a deploy-time fit reproduces, so the honest gate verdict on what a
user would actually see is a **marginal FAIL**.

Rather than ship a pick whose honest verdict is a fail-by-rounding, the decision
is to **HOLD in shadow**:

- Basketball sits in `CONFIG.live.shadow.sports`. Its live WINNER probability is
  **computed and logged** with its timestamp and data staleness, but **withheld
  from every client** — public and tester alike.
- `CONFIG.live.picks.basketball` and `CONFIG.live.rollout.sports` stay **empty**:
  no pick is previewed to testers either.
- Nothing is tuned to make the margin pass. The clause stands; evidence is
  gathered on live games instead.

### The shadow protocol

`services/live/forwardTest` records each withheld probability as a row
(`recordServed({ shadow: true })`) carrying `at`, `at_ms`, `game_id`, `sport`,
`league`, `market`, `p`, `p_raw`, `data_tier`, `staleness_seconds`, `is_stale`,
`clock`, `period`, and — once the game ends — the outcome `y` and `settled_at`.
Shadow rows are:

- **excluded from the served-pick auto-disable** — `evaluate()` skips
  `r.shadow === true`, so held evidence can never retire a pick nobody is being
  shown; and
- **summarised separately** by `shadowSummary(sport)`, surfaced at
  `GET /api/live/stats` under `forward_test.shadow.<sport>`: settled `games`,
  `logLoss`, `brier`, `hitRate`, the `benchmarkLogLoss` (0.4303), the `drift`,
  `withinTolerance`, and `ready` (`games ≥ minGames` (300) **and**
  `withinTolerance === true`).

The hold is released by adding the league to `live.picks` (public) or to
`live.rollout.sports` (tester preview) once `shadowSummary('basketball').ready` is
true — ≥ 300 settled live games within tolerance of 0.4303 — and the production
column's Brier-gain CI-lower is re-confirmed above zero on the enlarged evidence.
`shadowSports()` drops a sport from the shadow list automatically once it starts
shipping.

### Frozen release criteria (fixed before the first shadow row)

The thresholds that decide when basketball leaves shadow are frozen **before any
shadow row exists**, in `CONFIG.live.releaseCriteria` (see
`services/live/config.js`). They are recorded here so the rule cannot move after
evidence starts arriving. **No value below changes once the first shadow result
lands** — changing one would invalidate the run, because the collected evidence
would no longer answer the frozen question.

| Criterion | Value | Meaning |
|---|---|---|
| `benchmarkLogLoss` | **0.4303** | Basketball's shipped test-window log loss — the bar the live evidence must match. Sourced from the fit script, never re-derived. |
| `logLossTolerance` | **0.02** | Realised shadow log loss may exceed the benchmark by at most this. |
| `minSettledGames` | **300** | Minimum settled **GAMES** (not checkpoints) before the hold can release. |
| `confidence` | **0.95** | The reported log-loss interval's confidence level. |
| `bootstrap` | **2000 iterations, seed 11** | Whole-game percentile bootstrap (the same PRNG the ship gate uses). |
| `buckets.labels` | **early / mid / late** | Time buckets by elapsed fraction (`bucketEdges` `[0.3333, 0.6667]`). |
| `buckets.minGames` | **50** | A bucket with ≥ 50 settled games is judged. |
| `buckets.tolerance` | **0.05** | A judged bucket must be within 0.05 of the benchmark (one-sided — beating it is fine). |
| `perLeague.minGames` | **50** | A league with ≥ 50 settled games is judged. |
| `perLeague.tolerance` | **0.05** | A judged league must be within 0.05 of the benchmark on its own (the per-league sanity check). |
| `scoreTimeGain.minLogLossGainCiLower` | **0** | Amendment 1 (2026-11-08). The lower bound of the 95 % game-level interval for the log-loss gain over `scoreTime` must be ≥ 0 — i.e. the model must be *confidently* better than "score and time only". |

**The release condition (all five must hold).** Evaluated by
`forwardTest.shadowSummary('basketball')`:

1. **overall** — the realised log loss is **≤ 0.4303 + 0.02** on the last
   `forwardTest.window` (300) settled shadow games; **and**
2. **sample** — at least **300 settled games** have landed; **and**
3. **per time bucket** — every early/mid/late bucket with ≥ 50 games is within
   **0.05** of the benchmark; **and**
4. **per league** (sanity) — every league with ≥ 50 settled games is within
   **0.05** of the benchmark on its own; **and**
5. **vs `scoreTime`** (amendment 1) — the 95 % game-level interval for the
   log-loss **gain over `scoreTime`** (`vsScoreTime.logLossGain`) has a lower
   bound **≥ 0** (`scoreTimeGain.minLogLossGainCiLower`).

Anything else reports **why** it is not ready (`ready_reasons`).

**Freeze integrity — the criteria id.** The block hashes to a stable content id
(sha1 of the frozen numbers + `frozen_at` `2026-11-08`, truncated to 12 hex).
Every shadow row records the `criteria_id` in force when it was written, and
`forwardTest` snapshots it from the **first** shadow row and carries it forward.
`shadowSummary.criteria.moved` is `true` whenever the live config no longer
hashes to the frozen id — i.e. the goalposts moved — and a `moved` run must be
restarted rather than read.

The **active id is `7a32cb237260`** — amendment 1 (below) added the
`scoreTimeGain` clause to the hashed block, so the id advanced from the
pre-amendment `67d4708fea1d`. The clause is hashed on purpose: a future edit to
it is drift and must be detectable, exactly like the other four.

**Amendment 1 — 2026-11-08 (recorded before any shadow row settled).**
`logLossTolerance` is **0.02**, which is *larger* than the model's whole gain
over `scoreTime`. Passing the benchmark clause alone therefore does **not** show
the model beats "score and time only" — the tolerance could swallow the entire
gain. Amendment 1 closes that hole by requiring clause 5 (the log-loss-gain
interval lower bound must be ≥ 0). It is recorded as a **dated amendment**, not
a silent edit:

- `CONFIG.live.releaseCriteria.scoreTimeGain = { minLogLossGainCiLower: 0 }` —
  structural, and hashed into the id.
- `CONFIG.live.releaseCriteria.amendments[]` — the human record:
  `{ at: '2026-11-08', prior_criteria_id: '67d4708fea1d', change, note }`. This
  array is **deliberately NOT hashed**, so editing a note can never move the
  gate.
- **Both ids live on every row.** `recordServed` writes `criteria_id` (the id in
  force) **and** `criteria_id_prior` (the id amendment 1 superseded, from
  `priorCriteriaId()`), so evidence written after the amendment is traceable to
  both gates. `shadowSummary.criteria.prior_id` and the top-level
  `GET /api/live/stats` field `forward_test.criteria_id_prior` expose the same
  value.

No other value changed in amendment 1.

**The calibrator version is frozen too.** The calibrator the shadow rows were
produced with is identified by `liveCalibrator.id()`, a content hash of
`CONFIG.live.calibration.file` (`data/live-calibrator.json`). The id in force at
freeze is `shadow_calibrator_id = 7f5884cc989f`; it is captured from the first
shadow row and recorded on **every** row (`calibrator_id`).
`shadowSummary.calibrator.moved` is `true` if a re-fit would serve a different
column than the one the evidence was collected under.

Note the freeze lives in **config** (`CONFIG.live.releaseCriteria`) and is
reproduced here; both must agree. `GET /api/live/stats` reports the current
`criteria_id`, the frozen `shadow_criteria_id`, and the frozen
`shadow_calibrator_id` (all under `forward_test`), so the drift check is
observable without reading the source.

### Frozen live candidates — every id labelled (artifact `shadow-candidates-1.0.0`)

The models whose probability is logged on every shadow row are pinned in
`data/live-shadow-candidates.json`, version **`shadow-candidates-1.0.0`**, frozen
at **`2026-11-12T13:53:48Z`** (`frozen_at_ms` `1794491628000`). An id is
`sha1(JSON.stringify(block)).slice(0, 12)` of the model's own block, so a change
to a model's numbers moves its id; **metadata such as a label lives outside the
hashed block and never moves an id**. All four frozen ids are labelled:

| Key | Frozen id | Label |
|---|---|---|
| `basketball_logistic` | **`33f1a9025999`** | Basketball home-win logistic — `x = margin / sqrt(minutes remaining)`, per-league periods |
| `soccer_table` | **`019d7e0afab3`** | Soccer empirical table `P(home/draw/away | minute, capped diff, red)` (secondary) |
| `soccer_mnl` | **`11837341b3fd`** | Soccer regularised multinomial logistic (primary) |
| `soccer_score_time` | **`213f7dd0a1d8`** | Soccer score-and-time baseline (plain Poisson at global rates) — the release reference |

**Pre-registration.** The release decision reads the **primary** candidate only,
versus `scoreTime`, with game-level confidence intervals: basketball primary
`basketball_logistic`; soccer primary `soccer_mnl`, secondary `soccer_table`.
Selecting the best of the candidates on the confirmation data is forbidden.

**Confirmation dataset.** Only shadow rows logged **strictly after** the freeze
instant count as confirmation evidence, and each is evaluated **once**. With no
settled confirmation games yet, the `/api/live/stats` surface and the Phase 10
report expose **counts, rates and ETA only** (no-peeking) until a sport reaches
the 500-settled-game target.

**Item 3 (round E) — the model clock was already league-correct.** The
basketball time feature used by the logistic, the `scoreTime` baseline and the
production model reads each league's own regulation length (NBA 4×12 = 48,
WNBA 4×10 = 40, college 2×20 = 40; OT = 5), **not** the sport-wide 48/4. Only the
report's bucket/baseline *helpers* (`bucketFor`/`basketballElapsed`) had used the
sport-wide clock and were corrected; the frozen model is unchanged, so the
artifact stays at **`1.0.0`**.

### The shadow scheduler — evidence independent of user requests

Until Phase 9 the forward log was written **only** when a user resolved or polled
a game, so a held sport gathered evidence at whatever rate it happened to be
requested — and none at all if nobody asked. `services/live/shadowScheduler.js`
removes that dependency: on `CONFIG.live.shadow.scheduler.cron` (`*/5 * * * *`,
every five minutes) it sweeps the shadow leagues
(`CONFIG.live.shadow.sports` → basketball; the swept league list comes from
`matcher.sweep`, i.e. `nba`, `wnba`, `mens-college-basketball`), builds each live
game, computes the WINNER probability and writes a shadow row — with its
timestamp, the ESPN data age (`staleness_seconds`, `is_stale`) and, once the game
ends, its outcome (`y`, `settled_at`). The job is guarded (a failure never
crashes the server) and deduped on `(probability, clock, period)`, so the cadence
yields a checkpoint every five minutes **plus** one at each quarter boundary.

**Settled-game counts per league** are surfaced at `GET /api/live/stats` under
`forward_test.shadow.basketball.byLeague` (and `.byBucket`), each entry carrying
its settled `games` count — the same figures the per-league sanity check reads.

### shadowSummary counts GAMES, and reports 95 % whole-game intervals

`shadowSummary(sport)` counts settled **GAMES**, not checkpoints: checkpoints
inside one game share its outcome, so counting rows would report an interval
narrower than the evidence supports. The reported 95 % interval is a **game-level
percentile bootstrap** (the frozen 2000 iterations, seed 11 — the same code the
ship gate uses):

- `logLossCi` — the realised log loss interval;
- `vsBenchmark` — the same interval expressed as a drift versus **0.4303**
  (`lower`/`upper`); and
- `vsScoreTime` — the model's Brier and log-loss **gain over the `scoreTime`
  baseline** on the same shadow games, with its own interval. A lower bound below
  zero means the model is not clearly better than "score and time only" on the
  live evidence, and the hold does not release.

### A. Basketball per-league holdout (each league split on its own calendar)

Phase 8 split the whole dataset once, so the WNBA — whose season ends before the
basketball tail — had **no** games in the sport-level test window. Phase 9 re-splits
each league on its own calendar (train 60 / validate 20 / test 20) so every league
gets an out-of-sample window, making it possible to see whether the sport-level
pass was carried by one league.

| League | games | test games | hit | CI-low | Brier (model) | Brier (ref) | Brier gain | Brier-gain CI | log-loss gain | log-loss-gain CI | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `nba` | 2,466 | 493 | 78.6 % | 76.3 % | 0.1469 | 0.1489 | 0.0020 | [−0.0019, 0.0060] | 0.0124 | [−0.0036, 0.0306] | FAIL |
| `wnba` | 598 | 119 | 72.1 % | 66.7 % | 0.1740 | 0.1762 | 0.0022 | [−0.0041, 0.0085] | 0.0129 | [−0.0075, 0.0345] | FAIL |
| `mens-college-basketball` | 2,121 | 424 | 80.0 % | 77.3 % | 0.1344 | 0.1377 | 0.0033 | [−0.0031, 0.0095] | 0.0084 | [−0.0112, 0.0270] | FAIL |

Every league **fails at the league level** — each has fewer than 500 out-of-sample
games and a Brier-gain CI that crosses zero. That is expected and is exactly why
the gate is **sport-level**: one league's sample is too small to clear the bar
alone. The value of this table is that **no one league carries the pass** — all
three point the same way (a small positive Brier and log-loss gain), none is an
outlier propping up the sport result, and none contradicts it. The sport-level
gate remains the unit of decision; the per-league numbers are a sanity check.

### B. Soccer `scoreTime` — absolute calibration on the test window

Soccer does not ship, but the honest question is whether the **`scoreTime`
baseline itself** is well calibrated — it is the model that would ship if the
anchored model cannot beat it. Reported on the 2,400-game / 12,000-row soccer test
window; the three-way columns come from the same remaining-goals Poisson the
baseline already uses, extended to win / draw / loss. Intervals are 95 %,
game-level.

| Column | n | games | Brier | Brier CI | log loss | log-loss CI | hit | hit CI |
|---|---|---|---|---|---|---|---|---|
| home | 12,000 | 2,400 | 0.1807 | [0.1741, 0.1875] | 0.5412 | [0.5232, 0.5610] | 73.2 % | [71.9 %, 74.6 %] |
| draw | 12,000 | 2,400 | 0.1744 | [0.1667, 0.1819] | 0.5259 | [0.5061, 0.5452] | 75.3 % | [73.9 %, 76.8 %] |
| away | 12,000 | 2,400 | 0.1546 | [0.1468, 0.1620] | 0.4766 | [0.4544, 0.4977] | 78.4 % | [77.2 %, 79.8 %] |

Reliability — home column (predicted vs actual per bucket):

| Range | n | predicted | actual |
|---|---|---|---|
| 0.00–0.25 | 3,309 | 0.1019 | 0.1547 |
| 0.25–0.35 | 810 | 0.2931 | 0.3309 |
| 0.35–0.45 | 3,896 | 0.3963 | 0.4084 |
| 0.45–0.55 | 0 | — | — |
| 0.55–0.65 | 0 | — | — |
| 0.65–0.75 | 1,511 | 0.7187 | 0.7042 |
| 0.75–1.00 | 2,474 | 0.8912 | 0.8407 |

Reliability — draw column:

| Range | n | predicted | actual |
|---|---|---|---|
| 0.00–0.25 | 6,604 | 0.1469 | 0.1669 |
| 0.25–0.35 | 2,933 | 0.2960 | 0.2922 |
| 0.35–0.45 | 963 | 0.3813 | 0.3655 |
| 0.45–0.55 | 810 | 0.4826 | 0.4198 |
| 0.65–0.75 | 690 | 0.6613 | 0.5493 |

The home column is **systematically over-optimistic at the extremes** — it
predicts 0.10 where 0.15 is realised, and 0.89 where 0.84 is realised, the
signature of a baseline that knows nothing about which teams are playing. The draw
column is worse: 0.48 predicted where 0.42 is realised, 0.66 where 0.55 is
realised. So `scoreTime` is **not** a well-calibrated probability; it is a usable
*ordering* with a known bias and must be labelled "based on score and time only",
never presented as a probability.

By time bucket (home column) — late checkpoints are all-but-decided:

| Bucket | n | games | Brier | log loss | hit |
|---|---|---|---|---|---|
| early | 2,400 | 2,400 | 0.2321 | 0.6570 | 61.4 % |
| mid | 7,200 | 2,400 | 0.1834 | 0.5469 | 73.3 % |
| late | 2,400 | 2,400 | 0.1213 | 0.4082 | 85.0 % |
| excludingLate | 9,600 | 2,400 | 0.1955 | 0.5744 | 70.3 % |

By league (home column; ≥ 100 games judged, below that indicative only):

| League | n | games | Brier | log loss | hit |
|---|---|---|---|---|---|
| `bra.1` | 850 | 170 | 0.1940 | 0.5747 | 70.1 % |
| `eng.1` | 730 | 146 | 0.1661 | 0.4956 | 76.3 % |
| `eng.2` | 1,010 | 202 | 0.1681 | 0.5064 | 76.5 % |
| `esp.1` | 835 | 167 | 0.1761 | 0.5236 | 72.3 % |
| `esp.2` | 1,025 | 205 | 0.2006 | 0.6015 | 69.4 % |
| `ger.1` | 645 | 129 | 0.1768 | 0.5350 | 74.1 % |
| `ger.2` | 650 | 130 | 0.1820 | 0.5387 | 73.7 % |
| `ita.1` | 785 | 157 | 0.1476 | 0.4583 | 79.9 % |
| `ita.2` | 860 | 172 | 0.2048 | 0.6231 | 69.4 % |
| `mex.1` | 685 | 137 | 0.1807 | 0.5395 | 72.9 % |
| `ned.1` | 640 | 128 | 0.1804 | 0.5340 | 73.1 % |
| `por.1` | 660 | 132 | 0.1858 | 0.5453 | 73.2 % |
| `sco.1` | 440 | 88 | 0.2122 | 0.6426 | 67.7 % |
| `tur.1` | 645 | 129 | 0.1763 | 0.5291 | 72.9 % |
| `uefa.champions` | 225 | 45 | 0.1368 | 0.4232 | 80.4 % |
| `uefa.europa` | 225 | 45 | 0.1374 | 0.4078 | 78.2 % |
| `usa.1` | 1,090 | 218 | 0.1878 | 0.5557 | 72.6 % |

The variation is real and unsmoothed — `ita.2` (log loss 0.62) and `sco.1` (0.64)
sit far above `uefa.europa` (0.41), on small samples. `sco.1` and both UEFA cups
are below the 100-game sanity floor and are indicative only.

**Verdict: soccer does not ship.** `scoreTime` is not well calibrated, and the
anchored model does not beat it (Brier gain 0.0005, CI crossing zero).
`CONFIG.live.picks.soccer` stays empty and the anchored model stays in shadow. If a
soccer probability is ever offered it must be the labelled `scoreTime` estimate,
not the anchored model.

### B2. Basketball `scoreTime` — corrected absolute-calibration diagnosis (test window)

Phase 10's wording called the basketball `scoreTime` baseline **"under-confident"**.
That label was **wrong** and is corrected here. Reported on the 833-game / 6,486-row
basketball test window; intervals are 95 %, game-level.

| Column | n | games | Brier | Brier CI | log loss | log-loss CI | hit |
|---|---|---|---|---|---|---|---|
| `scoreTime` (home-win) | 6,486 | 833 | 0.1591 | [0.1470, 0.1708] | 0.4777 | [0.4436, 0.5111] | 75.8 % |

Calibration slope **0.7487**, intercept **+0.1640**. Reliability:

| Range | n | predicted | actual | deviation |
|---|---|---|---|---|
| 0.00–0.25 | 1,710 | 0.0860 | 0.1300 | +0.0436 |
| 0.25–0.35 | 482 | 0.2950 | 0.3710 | +0.0759 |
| 0.35–0.45 | 546 | 0.3950 | 0.4910 | +0.0955 |
| 0.45–0.55 | 646 | 0.4990 | 0.5650 | +0.0663 |
| 0.55–0.65 | 534 | 0.6070 | 0.6310 | +0.0238 |
| 0.65–0.75 | 532 | 0.7030 | 0.7090 | +0.0057 |
| 0.75–1.00 | 2,036 | 0.9150 | 0.8810 | −0.0339 |

A slope below 1 with the lowest bucket realised **above** its prediction
(0.086 → 0.130) and the highest bucket realised **below** it (0.915 → 0.881) is
**over-confidence at the extremes** — the baseline's probabilities are spread too
wide — **not** under-confidence. On top of that the intercept is **positive**
(+0.164): the home side is **under-estimated across the mid-range** (every bucket
from 0.25 to 0.55 is realised above its prediction).

**Verdict: basketball `scoreTime` FAILS absolute calibration** — its worst judged
bucket (0.35–0.45) is off by **0.0955**, far outside the 0.05 tolerance. This is
why the manual rough estimate stays blocked for basketball: the standing gate is
that the sport's own `scoreTime` must pass its absolute-calibration check.

### C. Market coverage — which markets the Phase 8 gate actually scored

- **Scored outcome: `home_win` only** — the winner / moneyline market, home side
  (`calibKey: 'home_win'`).
- The models **expose** `home_win` and `away_win` for basketball and
  `home_win` / `draw` / `away_win` for soccer, but **only the home-win column was
  scored and gated**.
- **Spread: not evaluated, not modelled** (`evaluated: false, available: false`).
  **Total points: not evaluated, not modelled.** No spread or total-points market
  has any gate behind it, so neither may ship — independently of the basketball
  winner hold.
- The gate was evaluated over **20 leagues**, **3 windows each**. The report
  counts **58 league × window combinations** (`leagueWindowCombos: 58`,
  `windowsPerLeague: 3`; 20 leagues × 3 windows is 60, so two combinations had no
  graded rows).

**Tuning disclosure — the test window was used for no tuning, selection or
threshold change.** The calibrator is fitted walk-forward (`refitEvery` 25 games,
strictly earlier games only); the calibration gate is judged on the **validation**
window; the ship gate on the **test** window; and the persisted calibrator here is
refit on **train + validation** only and merely **scored** on the test window. The
window fractions are fixed in `liveBacktest.windows` before any result is seen,
and no parameter or threshold was adjusted after inspecting test-window numbers.

### D. Latency — assumed freshness vs real live staleness

The replay's checkpoints assume the in-game state is **exact** (0 s old). A real
ESPN read is 30–90 s stale. This measures how far the `scoreTime` probability and
its Brier / log loss move when the clock is **advanced** by 30 / 60 / 90 s. Both
the model and the baseline consume the same delayed state, so the *comparison*
between them is unaffected — only the absolute numbers move.

| Sport | delay | games | Brier (on-time → delayed) | log loss (on-time → delayed) | mean \|ΔP\| | p95 \|ΔP\| |
|---|---|---|---|---|---|---|
| basketball | 0 s | 940 | 0.1456 → 0.1450 | 0.4440 → 0.4401 | 0.0140 | 0.0488 |
| basketball | 30 s | 940 | 0.1456 → 0.1450 | 0.4440 → 0.4405 | 0.0138 | 0.0472 |
| basketball | 60 s | 940 | 0.1456 → 0.1451 | 0.4440 → 0.4411 | 0.0137 | 0.0455 |
| basketball | 90 s | 940 | 0.1456 → 0.1452 | 0.4440 → 0.4418 | 0.0135 | 0.0438 |
| soccer | 0 s | 2,400 | 0.1807 → 0.1807 | 0.5412 → 0.5412 | 0.0000 | 0.0000 |
| soccer | 30 s | 2,400 | 0.1807 → 0.1808 | 0.5412 → 0.5434 | 0.0014 | 0.0045 |
| soccer | 60 s | 2,400 | 0.1807 → 0.1810 | 0.5412 → 0.5442 | 0.0029 | 0.0092 |
| soccer | 90 s | 2,400 | 0.1807 → 0.1811 | 0.5412 → 0.5450 | 0.0044 | 0.0140 |

The **mean absolute probability shift** is the honest headline: **0.013–0.014** for
basketball (p95 ≈ 0.044–0.049) and up to **0.004** for soccer (p95 ≤ 0.014). A
30–90 s stale feed moves a basketball home-win probability by roughly 1.4
percentage points on average and under 5 points at the 95th percentile; soccer
moves by under half a point on average. (The delayed basketball log loss is very
slightly *lower* than the on-time value — 0.4401–0.4418 vs 0.4440 — a second-order
artefact of advancing the clock at checkpoints whose true state was a moment
earlier, not an improvement the model achieves.) **The validation holds under
realistic staleness:** the shift is small relative to the gate margin, it is
symmetric for model and baseline (so the ship-gate comparison is unaffected), and
nothing in the shift flatters the model.

## Item 6 — manual entry "rough estimate" (PROPOSAL ONLY, not implemented)

**Status: not implemented.** Manual entry is unchanged: score / clock / context
as typed, the permanent *"User-entered, unverified"* badge, extra shrinkage,
excluded from every rate and from the backtest dataset, and never a pick.

**What is proposed (for approval, not yet built):** offer a **labelled**
`scoreTime` estimate for manual games, since `scoreTime` is a validated,
deterministic baseline that needs only the current score and the time remaining —
exactly what a user types.

- It would be shown as **"Rough estimate (score and time only)"**, never as a
  pick, and never with the anchored model.
- It would be a **fixed, published rule** (extrapolate the current score across
  the time remaining with the global constants in
  `liveBacktest.baselines.scoreTime`), so it carries no learned weight and cannot
  be tuned to look good.
- It would remain excluded from all hit-rate / calibration metrics and would
  never satisfy the ship gate (manual data is unverified).
- **Open question for the user:** the math can be shown for any sport, but is it
  honest to label it "validated" for soccer when the anchored soccer model does
  not beat `scoreTime`? The proposal is to offer it for **both** sports as a
  clearly-labelled crude estimate, not a probability to bet on.

**Phase 9 update — the calibration check this proposal was waiting on.** The rule
is to offer a rough estimate only for a sport whose `scoreTime` has passed its own
calibration check. Phase 9 measured soccer's `scoreTime` (section B above): it is
**not** well calibrated (systematically over-optimistic at the extremes, and the
draw column worse). Soccer therefore does **not** qualify, and neither sport has
cleared a `scoreTime` calibration check today, so the manual rough estimate
remains a later step. This is a proposal; **no code has been changed** for it.

## Coverage — which sports/leagues resolve through which source

See [LIVE_COVERAGE.md](LIVE_COVERAGE.md) for the full ESPN vs Pitch vs
manual-entry breakdown. In short:

- The replay sweep above resolved 5,185 basketball and 11,518 soccer games
  entirely through **ESPN**. Pitch was not needed and is never used as a
  live-state source (it carries no clock/period).
- **Pitch** is a soccer-only, identity-only last resort; **manual entry** catches
  everything else. `EuroLeague` (`eur`) and French competitions never come from
  ESPN and fall to manual entry.
- Any sport/league whose backtest does not pass the ship gate shows **score, time
  and context only** — no live pick. That is currently **both** sports, because
  `CONFIG.live.picks` is empty.

## Config reference (`services/live/config.js` → `liveBacktest`)

| Key | Meaning |
|---|---|
| `checkpoints.basketball.minutesRemaining` | in-period marks replayed (6, 3, 0) |
| `checkpoints.soccer.minutes` | cumulative match minutes replayed (15…75) |
| `windows` | chronological train/validation/test fractions |
| `refitEvery` | walk-forward calibrator refit cadence (games) |
| `calibration.method` | `isotonic` \| `platt` |
| `calibration.minSamples` | minimum graded holdout rows to judge a calibrator (150) |
| `calibration.minImprovementBrier` / `…LogLoss` | the ≥ 0.002 double-improvement bar |
| `shipGate.minGames` | 500 out-of-sample **games** (not rows) |
| `shipGate.minImprovementBrier` / `…LogLoss` | the ≥ 0.002 double-improvement bar vs `scoreTime` |
| `shipGate.breakEvenProbability` | 0.524 (break-even at −110) |
| `shipGate.minLeagueGames` | 100 graded test games before a single-league sanity verdict |
| `shipGate.bootstrap` | percentile bootstrap over whole games (2,000 iterations, seed 11) |
| `bucketEdges` / `bucketLabels` | early/mid/late split by elapsed fraction |
| `seasons` | per-sport ESPN scoreboard date ranges swept (`leagues` scopes a range) |
| `dataset.*` | cache dir, concurrency, throttle, retries, in-process cache flush |
| `curveEdges` | probability buckets for the reported calibration curve |
| `baselines.scoreTime.*` | the score-and-time baseline's global constants |

### Adding a league

1. Add the ESPN league segment to `matcher.sweep` (and, for the link parser, to
   `linkPatterns.js` if it is a new competition shape). If its season does not sit
   on the sport's default calendar, add a `leagues`-scoped range in
   `liveBacktest.seasons`.
2. Confirm ESPN returns `post`-state events and a `summary` payload for it
   (`scripts/_probe-espn-summary.js` is the probe used to verify field shapes).
3. Re-run the sweep. The league ships a live pick only when its **sport** clears
   the ship gate and the league's own sanity check is not BLOCKED; until then it
   shows score/time/context only.
