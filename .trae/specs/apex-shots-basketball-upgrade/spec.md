# Apex Sports Prediction Engine Expansion - Product Requirements Document

## Overview
- **Summary**: Extend the existing Apex prediction engine with (1) football shots markets (total/home/away over/under) and (2) a **calibrated basketball prediction engine** (pace, efficiency, expected points, win probability, **total points and point-spread/handicap**) with alternate-line selection, probability calibration and walk-forward backtesting. Connect both to the existing recommendation, settlement, performance-tracking, API, scheduler and UI systems.
- **Purpose**: Add statistically sound, distribution-based shot and basketball markets backed by verified historical data, probability calibration, and chronological backtesting — without duplicating or removing existing working markets. Prioritise calibration and honest probabilities over bold claims: main-line hit rates near 55–58% are realistic; higher hit rates come only from alternate lines at shorter odds, and this trade-off must be explicit.
- **Target Users**: Apex app users viewing recommended predictions, and operators reviewing performance/settlement.

## Goals
- Add football total shots, home-team shots, and away-team shots over/under markets with configurable half-line thresholds.
- Build a dedicated basketball prediction pipeline (pace, offensive/defensive efficiency, expected points, win probability, totals).
- Use verified provider statistics only; never fabricate or treat missing data as zero.
- Probabilities come from full predictive distributions (Poisson/Negative-Binomial for shots; score-distribution model for basketball), not from expected counts alone.
- Chronological backtesting with Brier/log-loss/MAE/RMSE and calibration bands for every new market.
- Extend settlement to shots and basketball markets using the exact same statistic definitions used for prediction.
- Surface new markets in the existing frontend with real model outputs.
- Produce **calibrated** basketball probabilities for two headline markets — **TOTAL POINTS (Over/Under)** and **POINT SPREAD (Handicap)** — with best-line selection, a confidence tier and short reasoning per pick.
- Estimate σ (residual standard deviation) for total and margin from historical residuals per league; never hardcode a single league-wide constant.
- Calibrate final probabilities (isotonic regression or Platt scaling) on walk-forward out-of-sample predictions with separate calibrators per market and per league, so a stated 65% wins ~65% of the time.
- Make the main-line vs alternate-line trade-off explicit: main lines realistically hit 55–58%; higher hit rates come only from alternates paid for with shorter odds.
- Report backtest results honestly, including where the model **loses** to the bookmaker's implied probabilities on log loss.
- Support multiple leagues (NBA, WNBA, NCAA, EuroLeague, …) through per-league parameters; never hardcode NBA constants.

## Non-Goals
- Do not rebuild the application from scratch or create duplicate prediction systems.
- Do not remove or regress existing football markets (goals, HT goals, corners, bookings, double chance, 1X2, BTTS).
- Do not invent player props or player-level basketball markets unless reliable player data is already available.
- Do not deploy unvalidated models automatically.
- Do not use future information in historical predictions.
- Do not present certainties: no "sure win", "banker" or accumulator language, and no probability of exactly 0 or 1.
- Do not rebuild the ESPN/Pitch data layer; extend the existing providers, normalizer and cache.
- Do not add bookmaker data beyond what ESPN already embeds (no third-party odds feed).
- Do not introduce player-level basketball markets (props) or on/off player data; the stack has no such source.
- Do not force a pick: if no line clears its thresholds, return "No confident pick".

## Background & Context
- Existing football engine ([footballHistoricalAnalysis.js](file:///c:/Users/prosp/Desktop/Apex/backend/services/footballHistoricalAnalysis.js)) implements Poisson + empirical-Bayesian models for goals, corners, and bookings with historical last-N analysis, H2H, and configurable lines. This is the model pattern to extend.
- Existing settlement ([settlementService.js](file:///c:/Users/prosp/Desktop/Apex/backend/services/settlementService.js)) supports goals, HT goals, team goals, corners, bookings, double chance, 1X2, BTTS.
- ESPN ([EspnProvider.js](file:///c:/Users/prosp/Desktop/Apex/backend/services/providers/EspnProvider.js)) is the primary provider for all sports. It exposes boxscore statistics via `summary?event=`. PitchAPI is football-only secondary.
- PitchAPI normalizer already extracts `homeShots`/`awayShots`/`homeXG`/`awayXG` from its stats endpoint. ESPN boxscore statistics need shot-stat extraction added.
- Basketball currently uses only a heuristic weighted-scoring approach in [server.js](file:///c:/Users/prosp/Desktop/Apex/backend/server.js) `analyzeMatchServer`; there is no pace/efficiency pipeline.
- Data is stored in Firestore `predictions` collection; historical stats are fetched live and cached in-memory (`sharedCache`). No persistent historical-stats collection exists yet.
- Tests use Jest + Supertest; live integration tests are gated behind `LIVE_SERVER=1`.

### Verified provider findings (Task 0 live probes)
- ESPN **scoreboard** (`/basketball/{league}/scoreboard`) contains **no odds** on `competitions[0]` and no injuries; it does expose `playByPlayAvailable`.
- ESPN **summary** (`/basketball/{league}/summary?event={id}`) contains everything the calibrated engine needs:
  - Odds: top-level `odds` and `pickcenter[0]` with `details` ("NY -3.5"), `overUnder` (228.5), `spread`, `overOdds`, `underOdds`, plus `awayTeamOdds`/`homeTeamOdds` (`moneyLine`, `spreadOdds`, `favorite`, `underdog`) and `pointSpread`/`total`/`moneyline` blocks each carrying `open`/`close`/`live` prices → enables veg removal, edge, EV and CLV.
  - Injuries: `injury[]` → `{ team:{id,displayName}, injuries:[{ status:"Day-To-Day", type:{abbreviation}, athlete:{id,fullName,position}, details:{type,location,detail,side,returnDate} }] }`.
- The summary payload has **no `rosters`** array on this feed → projected starters and on/off net rating are not available; injury impact must therefore be a bounded heuristic, not a computed on/off figure.
- Provider IDs: ESPN numeric. PitchAPI is football-only (`pa-` prefixed IDs) and exposes no basketball path, no odds, no play-by-play and no on/off data.
- Because closing lines are needed for CLV/backtest and there is no persistent historical collection, historical games and closing lines are reconstructed **on the fly from ESPN** (per user decision).

## Functional Requirements

### Football Shots
- **FR-1**: Collect, for each team in an upcoming fixture, its last 10 completed matches with verified shot statistics (total shots, shots on target, where available).
- **FR-2**: Calculate per-team last-10 metrics: mean, median, std-dev, variance, min, max of shots taken and conceded; home-only and away-only splits; last-5 vs last-10 recency; frequency above/below each configured line; data-quality score.
- **FR-3**: For the upcoming fixture, combine home team's home-attack with away team's away-defence (and vice-versa) to estimate expected home shots and expected away shots.
- **FR-4**: Estimate expected total shots accounting for correlation between home and away shot counts (tempo/game-state). Use a joint/correlated count model or validated simulation; do not blindly assume independence.
- **FR-5**: Use an appropriate count distribution (Poisson evaluated against Negative-Binomial for overdispersion). Probability of over/under a line L comes from the full predictive CDF, not the expected count.
- **FR-6**: Support configurable lines: total shots (e.g. 19.5, 21.5, 23.5, 25.5, 27.5), home shots (e.g. 8.5, 10.5, 12.5), away shots (e.g. 8.5, 10.5, 12.5). Lines may vary by competition.
- **FR-7**: H2H shot analysis with recency weighting; supporting evidence only, never the primary predictor.
- **FR-8**: Distinguish total shots from shots-on-target; never sum mutually-exclusive sub-categories unless provider definitions guarantee they sum to total.
- **FR-9**: Rank shot market candidates by calibrated probability, data quality, uncertainty, and historical out-of-sample performance. Return "Insufficient data" / "No recommended market" when evidence is weak.

### Basketball
- **FR-10**: Collect last-10 completed games per team with verified box-score stats (points, FGA, FGM, 3PA/3PM, FTA/FTM, ORB, DRB, TRB, AST, TOV, STL, BLK, PF, opponent stats, home/away, rest days, back-to-back indicator).
- **FR-11**: Estimate possessions per game using the standard formula `Possessions ≈ FGA - ORB + TO + 0.44 × FTA` and league-specific adjustments.
- **FR-12**: Calculate offensive rating, defensive rating, net rating per 100 possessions, with opponent-strength adjustment and shrinkage toward league mean for small samples.
- **FR-13**: Estimate expected home and away points via `Expected Points ≈ Expected Possessions × Expected Points Per Possession`, adjusted for home-court effect, competition environment, rest, opponent strength, and recent form.
- **FR-14**: Model total-point and win-probability distributions accounting for score correlation; do not derive win probability solely from expected-score comparison.
- **FR-15**: Support existing basketball markets (match winner, home/away team totals, total points over/under) with configurable lines.
- **FR-16**: Player availability is used only when reliably available; otherwise reflected in data quality, never invented.

### Settlement & Storage
- **FR-17**: Extend settlement to total shots, home shots, away shots, basketball match winner, team points, and total points. Match result must use the exact statistic the prediction used.
- **FR-18**: Settlement is idempotent, waits for provider-confirmed final stats, handles postponed/abandoned/void matches, and preserves the original prediction.
- **FR-19**: Persist prediction metadata (fixture ID, sport, competition, market, line, selection, expected statistic, estimated probability, model version, data-source, sample sizes, data-quality, actual statistic, settlement status/timestamp) in the existing Firestore predictions schema.
- **FR-20**: Reuse cached team histories across markets; avoid redundant API calls.

### Backtesting & Calibration
- **FR-21**: Chronological train/validation/test split for every new market; no leakage of future outcomes.
- **FR-22**: Report hit rate, Brier score, log loss, calibration by probability band for binary markets; MAE/RMSE for count/score markets.
- **FR-23**: Model selection prefers the simplest model with reliable out-of-sample performance; ensemble weights are evidence-based, not blind averages.

### Frontend
- **FR-24**: Football shots cards show fixture, competition, kickoff, market (total/home/away shots), line, expected shot count, estimated probability, data-quality indicator, sample size, and a short supporting-statistics explanation.
- **FR-25**: Basketball cards show fixture, competition, expected home/away/total points, win probability, selected market/line, estimated probability, pace/efficiency indicators, data-quality status, and a concise explanation.
- **FR-26**: All displayed figures come from the actual model pipeline; no illustrative sample values. Fixtures without a qualifying recommendation remain visible in the fixtures section.

### Basketball — Calibrated Totals & Spread Engine

#### Data & normalisation
- **FR-27**: Normalise basketball data into one internal schema: `Game`, `Team`, `Player`, `BoxScore`, `TeamForm`, `Lineup`, `Injury`, `Odds`. Reuse the existing EspnProvider `_request` (retry/backoff/inflight dedup) and TTLCache; do not add a second HTTP client.
- **FR-28**: Per team collect, for the last 5, last 10 and full season and split home/away: points for/against, FGA, FTA, OREB, DREB, TOV, 3PA, 3P%, FT%, eFG%, pace, offensive rating and defensive rating. Compute ratings when the provider does not supply them.
- **FR-29**: Collect schedule context: rest days, back-to-backs, 3-games-in-4-nights, and road-trip length. Travel distance and altitude are used only when known; otherwise they are omitted (never fabricated) and lower the data-quality score.
- **FR-30**: Collect the ESPN summary injury report with mapped status (`out`/`doubtful`/`questionable`/`probable`/`day-to-day`). Projected starters and player minutes/usage are used only when present; on-court/off-court net rating is unavailable and must not be assumed.
- **FR-31**: Collect bookmaker lines and odds from ESPN-embedded odds only (`odds`/`pickcenter`, including `open`/`close`/`live`), normalised to the internal `Odds` schema. No third-party odds feed.
- **FR-32**: Cache all provider responses and respect the existing rate limits; retry with backoff (already in `_request`). Missing fields never crash the pipeline: fall back to league averages and lower the data-quality score.
- **FR-33**: Support multiple leagues with per-league parameters (`basketball/leagues.js`): possession formula constants, game length, home-court term, σ priors, prior-season ratings, rotation size. No NBA constants in shared code paths.

#### Team ratings
- **FR-34**: `Possessions = FGA − OREB + TOV + 0.44 × FTA`; `Pace = possessions per game-length` (48 min, or the league's length). `ORtg = points per 100 possessions`; `DRtg = points allowed per 100 possessions`.
- **FR-35**: Recency weight with exponential decay and a configurable half-life (default 8–10 games). Keep home/away splits but shrink small splits toward the overall rating (empirical-Bayes).
- **FR-36**: Opponent-adjust ratings by iterating (iterative-SRS or ridge regression) so ratings reflect schedule strength.
- **FR-37**: Early season, blend prior-season ratings with current ratings, shifting weight to current as games played grows (full current weight at ~20 games); adjust priors for roster turnover where data exists.
- **FR-38**: Optionally maintain an Elo-style rating (margin-of-victory adjusted, with a league home-court term) and blend it with the ratings-based projection for the margin.

#### Projection & bounded adjustments
- **FR-39**: `expected_possessions` = blended pace of both teams, weighted toward the stronger pace identity and **calibrated from backtests** (not a plain average). `home_pts = expected_possessions × (home_ORtg adj for away_DRtg) / 100`; away analog. `proj_total = home_pts + away_pts`; `proj_margin = home_pts − away_pts + home_court_adj` (league-specific, learned, ~2–3 in the NBA).
- **FR-40**: Apply bounded adjustments, all defined in a config file and each capped: rest/fatigue (B2B, 3-in-4, long travel, altitude) applied mainly to margin with a smaller total effect; injuries; questionable/doubtful probability-weighted; blowout/garbage-time down-weighting; pace interaction; motivation/schedule spots (small and bounded).
- **FR-41**: Injury adjustments use a replacement-level assumption with a cap of ±5 points on margin and ±4 on total per player, and ±8 combined; questionable/doubtful availability is probability-weighted (e.g. 50% availability ⇒ half impact) and lowers the data-quality score. No fabricated on/off figures.

#### Probability & calibration
- **FR-42**: Model the final total and margin as distributions around the projection. Start normal: `P(Over L) = 1 − Φ((L − proj_total)/σ_total)`; `P(Home covers S) = 1 − Φ((−S − proj_margin)/σ_margin)`.
- **FR-43**: Estimate `σ_total` and `σ_margin` per league from historical residuals (actual − projected), varying with pace, total size and data quality. Test heavier-tailed/skewed fits and adopt them if they fit better out-of-sample.
- **FR-44**: Handle pushes on whole-number lines and half-point lines correctly (push ⇒ stake returned / excluded from win-rate denominators).
- **FR-45**: Calibrate final probabilities with isotonic regression or Platt scaling trained on walk-forward out-of-sample predictions; keep **separate calibrators per market and per league**.

#### Line & pick selection
- **FR-46**: Pull the main line and all available alternate lines for both markets. For each line compute the model probability, the vig-removed fair implied probability, `edge = model prob − fair implied prob`, and expected value. Vig removal must be proper (no-vig method), not a naive `1/odds` inversion.
- **FR-47**: Keep only picks passing configurable thresholds: probability ≥ 60% for main lines (≥ 68% for alternates), edge ≥ 4%, data-quality ≥ 0.7. Rank by `0.5 × probability + 0.5 × edge-scaled EV`; return the best pick per market.
- **FR-48**: Consistency check: reject (and flag, not silently drop) pairings that contradict the projection — e.g. a large favourite spread paired with a very low total implies a game that cannot be both a blowout and slow unless pace explains it.
- **FR-49**: If nothing clears thresholds, return "No confident pick". Never force a selection. Confidence tiers: **High** (thresholds cleared, data-quality ≥ 0.85, lineups confirmed), **Medium** (thresholds cleared with minor data gaps), **Low** (borderline or lineups unconfirmed).

#### Output, API, scheduler, UI
- **FR-50**: Emit the documented JSON shape per game: `game`, `tipoff`, `league`, `projection{total,margin,sigma_total,sigma_margin}`, `picks[{market,selection,probability,odds,edge,confidence,reasoning}]`, `key_factors`, `risk_flags`, `data_quality`.
- **FR-51**: Endpoints: `GET /basketball/predictions?date=&league=`, `GET /basketball/predictions/:gameId`, `GET /basketball/performance`.
- **FR-52**: Scheduler: initial run the morning of the game; refresh 60–90 minutes before tip-off when the injury report and starters are confirmed; one more at ~15 minutes if a star's status changes. Recompute and downgrade or remove the pick when a key player's status changes.
- **FR-53**: UI game card with both picks, probability bar, confidence badge, value tag, projected score and an expandable "Why this pick" showing the adjustments applied; filters for league, date, confidence and market; a "line moved" indicator when the line differs from the line at prediction time.

#### Backtesting, validation & live tracking
- **FR-54**: Walk-forward validation across ≥ 3 seasons: for each game, train and calibrate only on data available before tip-off. No leakage. Closing lines are not inputs unless the model has them at prediction time.
- **FR-55**: Report per market and per league: hit rate, Brier score, log loss, calibration curve, ROI at historical odds, closing-line value, and performance by probability bucket (55–60, 60–65, 65–70, 70+).
- **FR-56**: Compare against baselines — always-pick-the-favourite, the bookmaker's own implied probabilities, and a naive league-average model. If the model does not beat the bookmaker's implied probabilities in log loss, state so clearly in the report.
- **FR-57**: Tune hyperparameters (decay half-life, shrinkage strength, home-court term, adjustment caps, σ model) on a separate validation window, then freeze for the test window.
- **FR-58**: Live tracking: store every pre-tip prediction and its result; expose rolling accuracy and calibration by market and league; auto-downgrade or disable a market if its last-100 performance falls outside the expected range.

#### Responsible design & testing
- **FR-59**: Show probabilities, never certainties (a 68% pick loses ~1 in 3); include a disclaimer that predictions are statistical estimates, not betting advice; no "sure win" or accumulator language.
- **FR-60**: Unit tests for the possession formula, projection math, probability conversion (including push handling), vig removal and the selector logic.

## Non-Functional Requirements
- **NFR-1**: Probabilities are always within [0,1]; expected counts are non-negative.
- **NFR-2**: Provider failures do not crash prediction generation; graceful degradation with explicit "insufficient data".
- **NFR-3**: Caching reduces redundant API requests; team histories reused across markets.
- **NFR-4**: Existing frontend routes and builds remain functional.
- **NFR-5**: Changes are compatible with the existing architecture (extend services, do not duplicate pipelines).
- **NFR-6**: Every calibrated basketball probability is in (0,1) and finite; σ values are positive and per-league.
- **NFR-7**: All thresholds, caps, half-lives and σ priors live in a config file, not scattered through code.
- **NFR-8**: Calibration is measured, not asserted: a stated 65% must win ≈65% on walk-forward out-of-sample data or the calibrator is rejected.
- **NFR-9**: No NBA constants in shared code paths; every league-specific value is a per-league parameter.

## Constraints
- **Technical**: Node.js/Express backend, Firestore, ESPN primary + PitchAPI football secondary, React Native/Expo frontend, Jest+Supertest tests.
- **Business**: ESPN is preferred for fixtures available from both sources; PitchAPI limited to soccer.
- **Dependencies**: ESPN boxscore must supply shot and basketball box-score stats; if a stat is absent it stays null.
- **Odds**: Bookmaker lines and odds come only from ESPN-embedded odds in `summary?event=` (`odds`/`pickcenter`). If a game has no embedded odds, edge/EV/CLV cannot be computed and the pick is withheld.
- **Player data**: No rosters/on-off feed is available; injuries are the only player-level signal and are applied as bounded heuristics.

## Assumptions
- ESPN boxscore `statistics[]` entries include shot-related stats for football (e.g. `totalShots`, `shotsOnTarget`) and standard box-score stats for basketball (FGM, FGA, 3PM, 3PA, FTM, FTA, ORB, DRB, AST, TOV, etc.). Actual stat names will be verified from live responses.
- PitchAPI stats endpoint supplies `shots`, `shots_on_target`, `expected_goals` for football.
- Negative-Binomial will be evaluated but Poisson may be selected if overdispersion is not material out-of-sample.
- Basketball odds and injuries are only available from the ESPN **summary** endpoint, so one extra `summary?event=` call per game is required on top of the scoreboard.
- The residual distribution of total and margin is assumed roughly symmetric; heavier-tailed/skewed fits will be tested and adopted only if they improve out-of-sample fit.
- ESPN box-score stats give assists but not player minutes/usage; player minutes/usage are used only when the summary exposes them. Rotations are assumed league-typical when absent.
- σ priors are seeded from literature/league averages and then re-estimated per league from walk-forward residuals (never hardcoded as the final value).

## Acceptance Criteria

### AC-1: Football shots historical data is collected without fabrication
- **Type**: `rule`
- **Given**: an upcoming football fixture and two teams with available schedules
- **When**: the shots engine collects each team's last 10 completed matches
- **Then**: only completed matches before kickoff are included; missing shot values remain `null` (not 0); postponed/abandoned matches are excluded
- **Pass Condition**: A unit test with a mixed valid/invalid schedule returns only completed pre-kickoff matches with null preserved for missing shots
- **Evidence**: Jest test in `tests/shots-engine.test.js`

### AC-2: Total shots uses the correct provider definition
- **Type**: `rule`
- **Given**: a completed match with home and away total shots
- **When**: total shots is computed for settlement/prediction
- **Then**: total shots = home shots + away shots (using the provider's total-shots field, not shots-on-target)
- **Pass Condition**: Unit test asserts total shots equals home+away total shots and that shots-on-target are not used as total shots
- **Evidence**: Jest test asserting stat identity

### AC-3: Configurable shot lines with distribution-based probabilities
- **Type**: `rule`
- **Given**: expected home shots λ_h and away shots λ_a and a configured line L
- **When**: P(Over L) and P(Under L) are calculated
- **Then**: probabilities are derived from the predictive count-distribution CDF (sum of PMF), clamped to [0,1], and not equal to a simple threshold comparison of expected total
- **Pass Condition**: Unit test shows P(Over L) != (λ_h+λ_a > L) and is in [0,1]
- **Evidence**: Jest test with fixed lambdas and line

### AC-4: Home-shot markets use home shots only; away-shot markets use away shots only
- **Type**: `rule`
- **Given**: a settled match with home=12, away=8 total shots
- **When**: settling home_over_10_5 and away_over_10_5
- **Then**: home market settles from 12, away market from 8; home wins, away loses
- **Pass Condition**: Settlement unit test with fixed values
- **Evidence**: Jest settlement test

### AC-5: Basketball possessions formula uses correct units
- **Type**: `rule`
- **Given**: box scores FGA=80, ORB=10, TO=12, FTA=20
- **When**: possessions are estimated
- **Then**: possessions = 80 - 10 + 12 + 0.44*20 = 90.8
- **Pass Condition**: Unit test asserts exact value
- **Evidence**: Jest test in `tests/basketball-engine.test.js`

### AC-6: Offensive/defensive ratings are per-100-possessions and consistent
- **Type**: `rule`
- **Given**: points scored, points allowed, and possessions
- **When**: offensive and defensive ratings are computed
- **Then**: ORtg = points/possessions*100, DRtg = points_allowed/opp_possessions*100, and expected points = possessions * (ORtg/100)
- **Pass Condition**: Unit test with fixed inputs asserts units and the points identity
- **Evidence**: Jest test

### AC-7: Basketball win probability is not derived solely from expected scores
- **Type**: `rule`
- **Given**: expected home/away points and their predictive distributions
- **When**: win probability is computed
- **Then**: win probability integrates over the score-difference distribution (or equivalent validated method), and is not simply `exp_home > exp_away`
- **Pass Condition**: Unit test with identical expected scores but different variances yields different win probabilities
- **Evidence**: Jest test

### AC-8: Settlement definitions match prediction definitions
- **Type**: `rule`
- **Given**: a prediction for `total_shots_over_21_5` and a final match with home+away shots
- **When**: settlement runs
- **Then**: the same total-shots statistic and line L=21.5 are used; outcome is won/lost based on total > 21.5
- **Pass Condition**: Settlement test uses the prediction's stored line and the total-shots stat
- **Evidence**: Jest settlement test

### AC-9: No existing football markets regress
- **Type**: `rule`
- **Given**: the existing test suite for goals/corners/bookings
- **When**: all tests run after the expansion
- **Then**: existing football market tests continue to pass
- **Pass Condition**: `npm test` passes for existing test files
- **Evidence**: Test run output

### AC-10: Frontend displays real model outputs for new markets
- **Type**: `rubric`
- **Dimension**: Frontend integration fidelity for shots and basketball markets
- **Scale**: 1-5
- **Anchors**: 1 = hardcoded/placeholder values; 3 = values present but not wired to API; 5 = all figures (expected count, probability, data quality, sample size) come from the backend model response and render correctly
- **Pass Threshold**: >= 4
- **Evidence**: Screenshot/inspection of TipsScreen showing shots/basketball cards populated from API; no hardcoded sample values

### AC-11: Backtesting reports calibrated metrics without leakage
- **Type**: `rule`
- **Given**: a chronological historical dataset
- **When**: backtesting runs for shots and basketball markets
- **Then**: train/validation/test are time-ordered; no future match appears in training; Brier/log-loss/MAE/RMSE and calibration bands are reported with sample sizes
- **Pass Condition**: Backtest script outputs metrics and a test asserts no future-date match is in the training fold
- **Evidence**: Backtest script output + unit test on time-split integrity

### AC-12: Probabilities remain within valid bounds and provider failures degrade gracefully
- **Type**: `rule`
- **Given**: a provider returns an error or missing stats for a fixture
- **When**: prediction generation runs
- **Then**: no crash; an "insufficient data" result is returned; any emitted probability is in [0,1]
- **Pass Condition**: Unit test mocks provider failure and asserts graceful return with bounded probabilities
- **Evidence**: Jest test with mocked provider

### AC-13: Per-league parameters — no hardcoded NBA constants
- **Type**: `rule`
- **Given**: two leagues configured with different game lengths, home-court terms and σ priors
- **When**: the engine projects a game in each league
- **Then**: the projections use each league's parameters; no NBA-specific value is applied outside NBA config
- **Pass Condition**: Unit test projects the same inputs under two league configs and asserts different outputs consistent with the config
- **Evidence**: Jest test in `tests/basketball/config.test.js`

### AC-14: Recency decay and split shrinkage behave correctly
- **Type**: `rule`
- **Given**: a team's game log with a configurable half-life
- **When**: the recency-weighted rating is computed
- **Then**: recent games weigh more than older games by the configured decay, and a small home/away split is shrunk toward the overall rating
- **Pass Condition**: Unit test asserts monotonic decay and that a 3-game split is shrunk closer to overall than an 80-game split
- **Evidence**: Jest test in `tests/basketball-ratings.test.js`

### AC-15: Opponent adjustment changes ratings vs raw averages
- **Type**: `rule`
- **Given**: two teams with identical raw scoring but very different opponent strength
- **When**: opponent-adjusted ratings are computed
- **Then**: the team that faced stronger opponents receives a higher adjusted rating than the team that faced weaker opponents
- **Pass Condition**: Unit test with constructed schedules asserts adjusted ordering differs from raw ordering
- **Evidence**: Jest test in `tests/basketball-ratings.test.js`

### AC-16: Early-season prior blend converges to current form
- **Type**: `rule`
- **Given**: a prior-season rating and a current-season record
- **When**: the blended rating is computed at 0, 10 and ≥20 games played
- **Then**: prior weight is highest at 0 games and current weight reaches full at ~20 games
- **Pass Condition**: Unit test asserts weight monotonically shifts to current and equals 1.0 at ≥20 games
- **Evidence**: Jest test in `tests/basketball-ratings.test.js`

### AC-17: Probability conversion matches the normal model and handles pushes
- **Type**: `rule`
- **Given**: a projection, a σ and a line
- **When**: P(Over L) and P(Home covers S) are computed
- **Then**: they equal `1 − Φ((L − proj_total)/σ_total)` and `1 − Φ((−S − proj_margin)/σ_margin)` respectively; a whole-number line returns a non-zero push probability, and a half-point line returns push = 0
- **Pass Condition**: Unit test asserts exact CDF values against a reference Φ and correct push handling for integer vs half lines
- **Evidence**: Jest test in `tests/basketball-probability.test.js`

### AC-18: Vig removal is proper, not naive inversion
- **Type**: `rule`
- **Given**: a two-way market with prices implying >100% total probability (e.g. −110/−110)
- **When**: fair implied probabilities are computed
- **Then**: they sum to 1.0 (no-vig method) and are each less than the naive `1/odds` value
- **Pass Condition**: Unit test asserts the fair implied probabilities sum to 1.0 within tolerance
- **Evidence**: Jest test in `tests/basketball-odds.test.js`

### AC-19: Calibration is trained out-of-sample and per market/league
- **Type**: `rule`
- **Given**: walk-forward out-of-sample predictions split by market and league
- **When**: calibrators are trained
- **Then**: a separate calibrator is produced per market and per league; probabilities are monotonic in predicted probability and within (0,1)
- **Pass Condition**: Unit test asserts separate calibrators exist and are monotonic non-decreasing
- **Evidence**: Jest test in `tests/basketball-calibration.test.js`

### AC-20: Line selector honours thresholds and never forces a pick
- **Type**: `rule`
- **Given**: candidate lines with model probabilities, fair implied probabilities and a data-quality score
- **When**: the selector runs
- **Then**: it keeps only lines with prob ≥ 60% (main) / ≥ 68% (alternate), edge ≥ 4% and data-quality ≥ 0.7; it ranks by `0.5 × prob + 0.5 × edge-scaled EV`; it returns at most one pick per market; and it returns "No confident pick" when nothing qualifies
- **Pass Condition**: Unit test with a below-threshold set returns no pick, and an above-threshold set returns the single highest-ranked pick per market
- **Evidence**: Jest test in `tests/basketball-selector.test.js`

### AC-21: Contradictory projections are flagged, not silently dropped
- **Type**: `rule`
- **Given**: a projection with a large favourite margin paired with a very low total and normal pace
- **When**: the consistency check runs
- **Then**: the pairing is flagged in `risk_flags` and not returned as a silent confident pick
- **Pass Condition**: Unit test asserts a flag is emitted for the contradictory pairing
- **Evidence**: Jest test in `tests/basketball-selector.test.js`

### AC-22: Backtest reports honest metrics and beats/does-not-beat the bookmaker explicitly
- **Type**: `rule`
- **Given**: a ≥3-season walk-forward run with no leakage
- **When**: the backtest completes
- **Then**: it reports per market/league hit rate, Brier, log loss, calibration curve, ROI, CLV and probability buckets, and compares against always-favourite, bookmaker implied and league-average baselines, explicitly stating whether the model beats the bookmaker's implied probabilities in log loss
- **Pass Condition**: Backtest output contains all metrics per market/league and an explicit beat/lose statement; a unit test asserts no post-tipoff game enters the training fold
- **Evidence**: Backtest script output + leakage unit test

## Open Questions
- [x] ESPN boxscore stat names verified via live probe. Basketball extraction keys are known; the summary (`boxscore`, `pickcenter`/`odds`, `injury`, `plays`, `winprobability`) is the source for stats, odds and injuries. Remaining nuance: exact per-league summary coverage.
- [ ] Confirm whether PitchAPI free tier supplies shots for the 77 configured leagues (coverage may be partial). **Not blocking** — basketball uses ESPN only; PitchAPI has no basketball path.
- [x] Resolved: no persistent Firestore collection for historical stats — historical games and closing lines are reconstructed **on the fly from ESPN** for backtesting (per user decision), with in-memory TTLCache for hot data.
- [ ] Confirm the initial set of basketball leagues to enable (NBA only, or NBA + WNBA + NCAA + EuroLeague) and each league's game length and observation window.
- [ ] Confirm whether ESPN embedded odds are present for all target leagues, or only NBA — if absent for a league, edge/EV/CLV are withheld there.
- [ ] Confirm the acceptable minimum history for showing a pick (e.g. require ≥5 games per team and ≥1 full prior season for the prior blend).
