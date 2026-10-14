# Apex Sports Prediction Engine Expansion - Product Requirements Document

## Overview
- **Summary**: Extend the existing Apex prediction engine with (1) football shots markets (total/home/away over/under) and (2) an advanced basketball prediction pipeline (pace, efficiency, expected points, win probability, totals). Connect both to the existing recommendation, settlement, and performance-tracking systems.
- **Purpose**: Add statistically sound, distribution-based shot and basketball markets backed by verified historical data, probability calibration, and chronological backtesting — without duplicating or removing existing working markets.
- **Target Users**: Apex app users viewing recommended predictions, and operators reviewing performance/settlement.

## Goals
- Add football total shots, home-team shots, and away-team shots over/under markets with configurable half-line thresholds.
- Build a dedicated basketball prediction pipeline (pace, offensive/defensive efficiency, expected points, win probability, totals).
- Use verified provider statistics only; never fabricate or treat missing data as zero.
- Probabilities come from full predictive distributions (Poisson/Negative-Binomial for shots; score-distribution model for basketball), not from expected counts alone.
- Chronological backtesting with Brier/log-loss/MAE/RMSE and calibration bands for every new market.
- Extend settlement to shots and basketball markets using the exact same statistic definitions used for prediction.
- Surface new markets in the existing frontend with real model outputs.

## Non-Goals
- Do not rebuild the application from scratch or create duplicate prediction systems.
- Do not remove or regress existing football markets (goals, HT goals, corners, bookings, double chance, 1X2, BTTS).
- Do not invent player props or player-level basketball markets unless reliable player data is already available.
- Do not deploy unvalidated models automatically.
- Do not use future information in historical predictions.

## Background & Context
- Existing football engine ([footballHistoricalAnalysis.js](file:///c:/Users/prosp/Desktop/Apex/backend/services/footballHistoricalAnalysis.js)) implements Poisson + empirical-Bayesian models for goals, corners, and bookings with historical last-N analysis, H2H, and configurable lines. This is the model pattern to extend.
- Existing settlement ([settlementService.js](file:///c:/Users/prosp/Desktop/Apex/backend/services/settlementService.js)) supports goals, HT goals, team goals, corners, bookings, double chance, 1X2, BTTS.
- ESPN ([EspnProvider.js](file:///c:/Users/prosp/Desktop/Apex/backend/services/providers/EspnProvider.js)) is the primary provider for all sports. It exposes boxscore statistics via `summary?event=`. PitchAPI is football-only secondary.
- PitchAPI normalizer already extracts `homeShots`/`awayShots`/`homeXG`/`awayXG` from its stats endpoint. ESPN boxscore statistics need shot-stat extraction added.
- Basketball currently uses only a heuristic weighted-scoring approach in [server.js](file:///c:/Users/prosp/Desktop/Apex/backend/server.js) `analyzeMatchServer`; there is no pace/efficiency pipeline.
- Data is stored in Firestore `predictions` collection; historical stats are fetched live and cached in-memory (`sharedCache`). No persistent historical-stats collection exists yet.
- Tests use Jest + Supertest; live integration tests are gated behind `LIVE_SERVER=1`.

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

## Non-Functional Requirements
- **NFR-1**: Probabilities are always within [0,1]; expected counts are non-negative.
- **NFR-2**: Provider failures do not crash prediction generation; graceful degradation with explicit "insufficient data".
- **NFR-3**: Caching reduces redundant API requests; team histories reused across markets.
- **NFR-4**: Existing frontend routes and builds remain functional.
- **NFR-5**: Changes are compatible with the existing architecture (extend services, do not duplicate pipelines).

## Constraints
- **Technical**: Node.js/Express backend, Firestore, ESPN primary + PitchAPI football secondary, React Native/Expo frontend, Jest+Supertest tests.
- **Business**: ESPN is preferred for fixtures available from both sources; PitchAPI limited to soccer.
- **Dependencies**: ESPN boxscore must supply shot and basketball box-score stats; if a stat is absent it stays null.

## Assumptions
- ESPN boxscore `statistics[]` entries include shot-related stats for football (e.g. `totalShots`, `shotsOnTarget`) and standard box-score stats for basketball (FGM, FGA, 3PM, 3PA, FTM, FTA, ORB, DRB, AST, TOV, etc.). Actual stat names will be verified from live responses.
- PitchAPI stats endpoint supplies `shots`, `shots_on_target`, `expected_goals` for football.
- Negative-Binomial will be evaluated but Poisson may be selected if overdispersion is not material out-of-sample.

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

## Open Questions
- [ ] Confirm the exact ESPN boxscore stat names for football shots (total shots, shots on target) and basketball (FGM/FGA/etc.) from a live response before finalizing extraction keys.
- [ ] Confirm whether PitchAPI free tier supplies shots for the 77 configured leagues (coverage may be partial).
- [ ] Confirm whether a persistent Firestore collection for historical stats is desired (currently in-memory cache only) or if live-fetch + cache suffices.
