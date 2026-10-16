# Apex Shots & Basketball Expansion - Implementation Plan

## Task 1: Verify provider shot & basketball stat extraction from ESPN + verify ESPN boxscore
- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - Inspect live ESPN boxscore responses for football (shots, shotsOnTarget) and basketball (FGM, FGA, 3PM, 3PA, FTM, FTA, OREB, DREB, AST, TOV, STL, BLK, PF) stat key names.
  - Add extraction helpers in EspnProvider: `extractFootballShotStats` and `extractBasketballBoxScore` returning `null` for missing stats (never 0).
  - Extend `processScheduleForTeam` to attach `shots`, `shotsOnTarget`, `shotsConceded` for football; attach box-score stats for basketball.
  - Add equivalent basketball box-score extraction for PitchAPI already returns home/away normalized stats.
- **Acceptance Criteria Addressed**: AC-1, AC-2
- **Test Requirements**:
  - `rule` TR-1.1: A mocked ESPN summary with football shot stats yields home/away total shots and shots-on-target as separate fields; missing values stay null.
  - `rule` TR-1.2: A mocked ESPN basketball boxscore yields FGM/FGA/3PM/3PA/FTM/FTA/ORB/DRB/AST/TOV with null for absent stats.
  - `rule` TR-1.3: Shots-on-target are never aliased to total shots.

## Task 2: Football shots historical analysis engine
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 1
- **Description**:
  - Create `backend/services/footballShotsAnalysis.js`.
  - Implement `analyzeShotsHistory(matches, {isHomeContext, lines})` computing last-10 (and last-5) mean/median/std/variance/min/max of shots taken & conceded, home/away splits, line over/under frequencies, data-quality score.
  - Implement `analyzeH2HShotsHistory(h2hMatches, lines)` with recency weighting.
  - Implement `calculateShotsDistribution(lambda_home, lambda_away, line)` using Poisson (and Negative-Binomial option) CDF for P(Over)/P(Under).
  - Add `BASELINE_SHOT_PRIORS` and `DEFAULT_SHOT_LINES` (total [19.5,21.5,23.5,25.5,27.5]; home/away [8.5,10.5,12.5]).
  - Keep missing shots as null throughout.
- **Acceptance Criteria Addressed**: AC-1, AC-2, AC-3
- **Test Requirements**:
  - `rule` TR-2.1: analyzeShotsHistory returns null for avgShots when no valid shot data; returns correct mean/median/std when data present.
  - `rule` TR-2.2: calculateShotsDistribution with λ_h=12, λ_a=10, line=21.5 returns P(Over) ≠ (22>21.5) and is in [0,1].
  - `rule` TR-2.3: Missing shot values in input are preserved as null and excluded from averages (not zeroed).

## Task 3: Football shots prediction + recommendation integration
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2
- **Description**:
  - Implement `calculateShotsPrediction({homeAnalysis, awayAnalysis, h2hAnalysis, lines})` blending empirical Bayesian smoothed rates + Poisson CDF + H2H (discount-weighted), per the existing corners/bookings pattern.
  - Estimate λ_home from home attack + away defence; λ_away from away attack + home defence; λ_total accounts for tempo correlation.
  - Output per-line probabilities for total/home/away shots markets.
  - Add shot markets to `FOOTBALL_MARKET_PRIORITY` in [footballRanking.js](file:///c:/Users/prosp/Desktop/Apex/backend/services/footballRanking.js) and to the prediction-generation flow in [server.js](file:///c:/Users/prosp/Desktop/Apex/backend/server.js).
- **Acceptance Criteria Addressed**: AC-2, AC-3, AC-7
- **Test Requirements**:
  - `rule` TR-3.1: Prediction returns expectedHomeShots, expectedAwayShots, expectedTotalShots, and per-line probabilities all numeric and bounded.
  - `rule` TR-3.2: Prediction returns null ("insufficient data") when both teams lack shot data.
  - `rule` TR-3.3: Home/away λ estimates use the correct attack+defence blend, not just the team's own shots alone.

## Task 4: Basketball prediction pipeline (pace, efficiency, expected points, win prob)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 1
- **Description**:
  - Create `backend/services/basketballEngine.js`.
  - `estimatePossessions(boxScore)`: FGA - ORB + TO + 0.44*FTA.
  - `calcRatings(points, oppPoints, possessions, oppPossessions)`: ORtg, DRtg, NetRtg per 100.
  - `analyzeBasketballHistory(matches, {isHomeContext})`: last-10 pace, ORtg/DRtg, home/away splits, rest days, back-to-back.
  - `calculateBasketballPrediction({homeAnalysis, awayAnalysis, h2h, lines})`: expected home/away/total points; win probability via score-difference distribution; over/under total lines probabilities.
  - Shrink small-sample ratings toward league mean; account for home-court and rest adjustments.
- **Acceptance Criteria Addressed**: AC-5, AC-6, AC-7
- **Test Requirements**:
  - `rule` TR-4.1: estimatePossessions(FGA=80,ORB=10,TO=12,FTA=20) === 90.8.
  - `rule` TR-4.2: ORtg = points/possessions*100 exactly; expected points = possessions*(ORtg/100).
  - `rule` TR-4.3: Two teams with equal expected points but different variance yield different win probabilities.
  - `rule` TR-4.4: Missing box-score stats stay null; no fabricated player adjustments when player data absent.

## Task 5: Settlement extension for shots + basketball markets
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 3, Task 4
- **Description**:
  - Extend `settleMarket` in [settlementService.js](file:///c:/Users/prosp/Desktop/Apex/backend/services/settlementService.js) with cases: `total_shots_over_X_Y`, `home_shots_over_X_Y`, `away_shots_over_X_Y` (and under variants) using `extra.totalShots`, `extra.homeShots`, `extra.awayShots`, `extra.line`.
  - Add basketball cases: `basketball_match_winner`, `basketball_home_points_over/under`, `basketball_away_points_over/under`, `basketball_total_points_over/under` using `extra.homePoints`, `extra.awayPoints`, `extra.line`.
  - Extend `autoSettleFinishedMatches` to extract shots and basketball points from the boxscore summary.
  - Wire `corners/bookings extraction pattern for shots: extract home/away/total shots; for basketball extract final scores.
- **Acceptance Criteria Addressed**: AC-4, AC-8
- **Test Requirements**:
  - `rule` TR-5.1: total_shots_over_21_5 with home=12,away=8 => lost; with home=14,away=10 => won.
  - `rule` TR-5.2: home_shots_over_10_5 uses only home shots; away uses only away.
  - `rule` TR-5.3: basketball_total_points_over_215_5 with home=110,away=108 => won; match_winner home with home>away => home wins.
  - `rule` TR-5.4: Settlement is idempotent (second call with same score returns null).

## Task 6: Frontend integration — shots + basketball cards
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 3, Task 4
- **Description**:
  - Update [TipsScreen.js](file:///c:/Users/prosp/Desktop/Apex/frontend/screens/TipsScreen.js) (and [MarketScreen.js](file:///c:/Users/prosp/Desktop/Apex/frontend/screens/MarketScreen.js) / [MatchDetailsScreen.js](file:///c:/Users/prosp/Desktop/Apex/frontend/screens/MatchDetailsScreen.js)) to render shots and basketball prediction cards from the API response.
  - Shots card: fixture, competition, kickoff, market+line, expected shots, probability, data-quality, sample size, supporting stats.
  - Basketball card: expected home/away/total points, win probability, market+line, probability, pace/efficiency, data quality.
  - No hardcoded sample values; all figures from API.
- **Acceptance Criteria Addressed**: AC-10
- **Test Requirements**:
  - `rubric` TR-6.1: Frontend integration fidelity; scale 1-5; anchors 1=hardcoded, 3=partial, 5=all API-driven; threshold >=4; evidence from rendered cards populated from API with no placeholder literals.

## Task 7: Backtesting + calibration harness
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 2, Task 4
- **Description**:
  - Create `backend/services/backtestEngine.js` with chronological train/val/test splitter (no future leakage).
  - For shots: evaluate total/home/away shots per line — hit rate, Brier, log-loss, calibration bands, MAE/RMSE on expected shots.
  - For basketball: winner, home/away/total points per line — same metrics.
  - Output metrics by competition and line.
  - Add a runnable script `backend/scripts/run-backtest.js.
- **Acceptance Criteria Addressed**: AC-11
- **Test Requirements**:
  - `rule` TR-7.1: A test asserts no match with date > train cutoff appears in the training fold.
  - `rule` TR-7.2: Backtest outputs Brier, log-loss, MAE, RMSE, calibration bands with non-empty sample sizes.

## Task 8: Tests + build verification
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 1–7
- **Description**:
  - Add Jest tests: `tests/shots-engine.test.js`, `tests/basketball-engine.test.js`, `tests/settlement-shots-basketball.test.js`, `tests/backtest.test.js`.
  - Verify existing tests (`settlement.test.js`, `providers.test.js`, `football-ranking.test.js`, `predictability.test.js`) still pass.
  - Run `npm test` and fix regressions; run backend `npm test`; verify no regressions.
- **Acceptance Criteria Addressed**: AC-9, AC-12
- **Test Requirements**:
  - `rule` TR-8.1: Full `npm test` exits 0 with all new and existing tests passing.
  - `rule` TR-8.2: Provider-failure mock returns "insufficient data" without throwing; all emitted probabilities in [0,1].

## Task 9: Persistence + caching wiring
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 2, Task 4
- **Description**:
  - Ensure shot and basketball predictions include model version, data-source, sample sizes, data-quality in the saved Firestore prediction doc (extend `savePrediction` already stores predictions array; include these fields per market).
  - Reuse `sharedCache` for team histories across markets (already in-memory); ensure shot/basketball analysis uses the same cached schedules.
- **Acceptance Criteria Addressed**: AC-12 (caching), FR-19/FR-20
- **Test Requirements**:
  - `rule` TR-9.1: Saved prediction doc includes market line, expected statistic, probability, model version, data source, sample sizes per market.
  - `rule` TR-9.2: Team schedule fetch is cached so repeated market calls do not re-request the same schedule.

---

## Calibrated Basketball Engine (Totals & Spread)

> Extends Task 4's `basketballEngine.js` base pipeline. Task 4 stays as the base possessions/ratings/win-prob layer; the tasks below add per-league config, odds/injuries, σ modelling, calibration, spread market, selector, API, scheduler, UI and backtesting. Nothing in Tasks 1–9 is removed.

## Task 10: Basketball module scaffolding + per-league config
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 4
- **Description**:
  - Create `backend/services/basketball/` with `index.js`, `config.js`, `leagues.js`, `normalize.js`, `ratings.js`, `projection.js`, `adjustments.js`, `probability.js`, `calibration.js`, `lineSelector.js`, `persistence.js`, `backtester.js`.
  - Create `backend/services/basketball/config.js` holding every tunable: decay half-life, shrinkage strength, home-court term per league, adjustment caps, σ model params, selection thresholds, confidence-tier rules.
  - Create `backend/services/basketball/leagues.js` with per-league params for NBA/WNBA/NCAA/EuroLeague: game length (minutes), possessions constants, home-court term, prior-season rating priors, rotation size, enable/disable flag.
  - Move the hardcoded `LEAGUE_MEAN`/`scoreStd = 11` out of `basketballEngine.js` into per-league config; keep backward-compatible exports.
- **Acceptance Criteria Addressed**: FR-33, NFR-7, NFR-9, AC-13
- **Test Requirements**:
  - `rule` TR-10.1: Projecting identical inputs under two league configs yields outputs consistent with each config's game length and home-court term.
  - `rule` TR-10.2: A missing league config throws a clear error rather than silently using NBA defaults.

## Task 11: Basketball data normalisation + odds/injuries extraction
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 10
- **Description**:
  - Add `extractBasketballOdds(summary)` and `extractBasketballInjuries(summary)` to [EspnProvider.js](file:///c:/Users/prosp/Desktop/Apex/backend/services/providers/EspnProvider.js) using the verified `odds`/`pickcenter` and `injury[]` fields; return `null` for missing values (never 0).
  - Add a basketball schedule processor (`processBasketballScheduleForTeam`) reusing the existing `_request` retry/backoff and TTLCache; attach `boxScore`, `isHome`, `scores`, `result`, `restDays`, `backToBack`, `threeInFour`, `roadTripLength`.
  - Extend `backend/services/providers/normalizer.js` with `Odds`, `Injury` and basketball `BoxScore`/`TeamForm` normalisers into the shared Apex shape.
  - Add `backend/services/basketball/normalize.js` producing `Game`, `Team`, `BoxScore`, `TeamForm`, `Lineup`, `Injury`, `Odds`; missing fields stay `null` and lower the data-quality score.
- **Acceptance Criteria Addressed**: FR-27, FR-28, FR-29, FR-30, FR-31, FR-32
- **Test Requirements**:
  - `rule` TR-11.1: A mocked summary with `pickcenter` yields spread/total and open/close/live odds; a summary without odds yields `null` odds and no crash.
  - `rule` TR-11.2: A mocked `injury[]` yields mapped statuses (out/doubtful/questionable/probable/day-to-day); absent injuries yield an empty list.
  - `rule` TR-11.3: Rest-days/B2B/3-in-4 flags are computed correctly from a fixed game log.

## Task 12: Team ratings (recency, shrinkage, opponent adjustment, prior blend, Elo)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 11
- **Description**:
  - Implement exponential-decay recency weighting with configurable half-life (default 8–10 games).
  - Keep home/away splits but shrink small splits toward the overall rating (empirical-Bayes).
  - Implement opponent adjustment via iterative-SRS/ridge regression.
  - Implement prior-season blend: prior weight at 0 games → full current weight at ~20 games; adjust for roster turnover where data exists.
  - Implement optional Elo (margin-of-victory adjusted, league home-court term) and a blend function with the ratings-based margin.
- **Acceptance Criteria Addressed**: FR-34, FR-35, FR-36, FR-37, FR-38
- **Test Requirements**:
  - `rule` TR-12.1: Recency weights decay monotonically with age; a 3-game split is shrunk closer to overall than an 80-game split.
  - `rule` TR-12.2: Opponent adjustment reverses the ordering of two teams with equal raw scoring but different schedule strength.
  - `rule` TR-12.3: Prior blend weight is highest at 0 games and reaches 1.0 current weight at ≥20 games.
  - `rule` TR-12.4: Elo is margin-of-victory adjusted and includes a home-court term.

## Task 13: Game projection engine
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 12
- **Description**:
  - `expected_possessions` = blended pace weighted toward the stronger pace identity, calibrated by a configurable weight.
  - `home_pts = expected_possessions × (home_ORtg adj for away_DRtg) / 100`; away analog.
  - `proj_total = home_pts + away_pts`; `proj_margin = home_pts − away_pts + home_court_adj` (league-specific).
  - Blend the Elo margin signal with the ratings-based margin per config.
- **Acceptance Criteria Addressed**: FR-39
- **Test Requirements**:
  - `rule` TR-13.1: Projection math reproduces the documented formulas for fixed inputs.
  - `rule` TR-13.2: The pace blend is configurable and not a plain average (a weight ≠ 0.5 changes the result).

## Task 14: Bounded adjustments + data-quality scoring
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 13
- **Description**:
  - Implement all adjustments in `adjustments.js`, each capped in config: rest/fatigue (B2B, 3-in-4, long travel, altitude) applied mainly to margin with a smaller total effect; injuries; questionable/doubtful probability-weighting; blowout/garbage-time down-weighting; pace interaction; motivation/schedule spots.
  - Injury caps: ±5 margin / ±4 total per player, ±8 combined; availability is probability-weighted and lowers data-quality.
  - Implement a data-quality score (0–1) from missing-field coverage, sample size and line/lineup confirmation status.
- **Acceptance Criteria Addressed**: FR-40, FR-41
- **Test Requirements**:
  - `rule` TR-14.1: A single player's injury adjustment never exceeds ±5 margin / ±4 total, and the combined adjustment never exceeds ±8.
  - `rule` TR-14.2: A `questionable` player applies a probability-weighted (≈half) adjustment and lowers data-quality.
  - `rule` TR-14.3: Data-quality decreases as fields go missing and when lineups are unconfirmed.

## Task 15: Probability model + σ estimation + push handling
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 14
- **Description**:
  - Implement `P(Over L) = 1 − Φ((L − proj_total)/σ_total)` and `P(Home covers S) = 1 − Φ((−S − proj_margin)/σ_margin)`; reuse/extend the existing `normalCdf`.
  - Replace the hardcoded `scoreStd = 11` with per-league σ estimated from historical residuals; let σ vary with pace, total size and data quality.
  - Evaluate a heavier-tailed/skewed fit against the normal on residuals and adopt it if it fits better out-of-sample.
  - Handle push probability on whole-number lines; half-point lines return push = 0.
- **Acceptance Criteria Addressed**: FR-42, FR-43, FR-44
- **Test Requirements**:
  - `rule` TR-15.1: Probabilities match the reference normal CDF for fixed inputs.
  - `rule` TR-15.2: Integer lines return a non-zero push probability; half-point lines return push = 0.
  - `rule` TR-15.3: σ is positive, per-league, and varies with the configured pace/total/data-quality inputs.

## Task 16: Probability calibration (isotonic / Platt, per market + league)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 15
- **Description**:
  - Implement isotonic regression and Platt scaling in `calibration.js`; fit on walk-forward out-of-sample predictions only.
  - Store and apply a **separate calibrator per market (Total, Spread) and per league**.
  - Guard against non-monotonic/underfit calibration; fall back to identity (uncalibrated) if the calibrator fails out-of-sample validation.
- **Acceptance Criteria Addressed**: FR-45, NFR-8
- **Test Requirements**:
  - `rule` TR-16.1: Separate calibrators are produced per market and league.
  - `rule` TR-16.2: Calibrated probabilities are monotonic non-decreasing in the raw probability and within (0,1).
  - `rule` TR-16.3: A failing calibrator falls back to identity rather than producing out-of-range values.

## Task 17: Line selector (vig removal, edge, EV, thresholds, consistency flags)
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 16
- **Description**:
  - Implement proper no-vig fair implied probability (not `1/odds`).
  - For every main + alternate line compute model probability (post-calibration), fair implied probability, `edge`, and EV.
  - Apply thresholds from config (prob ≥ 60% main / ≥ 68% alternate, edge ≥ 4%, data-quality ≥ 0.7); rank by `0.5 × prob + 0.5 × edge-scaled EV`; return at most one pick per market.
  - Implement the consistency check and emit `risk_flags` for contradictory margin/total pairings; return "No confident pick" when nothing qualifies; assign High/Medium/Low confidence tiers.
- **Acceptance Criteria Addressed**: FR-46, FR-47, FR-48, FR-49
- **Test Requirements**:
  - `rule` TR-17.1: No-vig implied probabilities from −110/−110 sum to 1.0 within tolerance and are each below the naive value.
  - `rule` TR-17.2: Below-threshold candidate sets return "No confident pick"; above-threshold sets return the single highest-ranked pick per market.
  - `rule` TR-17.3: A contradicting margin/total pairing is flagged, not silently returned.
  - `rule` TR-17.4: Confidence tiers follow the data-quality/lineup rules.

## Task 18: Basketball API endpoints
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 17
- **Description**:
  - Create `backend/routes/basketball.js` and mount it in [server.js](file:///c:/Users/prosp/Desktop/Apex/backend/server.js).
  - `GET /basketball/predictions?date=&league=` — list of games with the documented JSON shape.
  - `GET /basketball/predictions/:gameId` — single game; returns 404 with a clear body when unknown.
  - `GET /basketball/performance` — rolling accuracy/calibration by market and league.
- **Acceptance Criteria Addressed**: FR-50, FR-51
- **Test Requirements**:
  - `rule` TR-18.1: Supertest returns the documented JSON keys for a mocked game.
  - `rule` TR-18.2: An unknown gameId returns 404 without throwing.
  - `rule` TR-18.3: `date`/`league` filters narrow the result set correctly.

## Task 19: Basketball scheduler (morning + pre-tip refreshes)
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 18
- **Description**:
  - Add a scheduler (node-cron pattern already used in `server.js`, guarded by `IS_ENTRY_POINT`) that runs an initial prediction pass the morning of the game, a refresh 60–90 minutes before tip-off, and a final refresh at ~15 minutes when a star's status changes.
  - On a key-player status change, recompute and downgrade or remove the affected pick.
- **Acceptance Criteria Addressed**: FR-52
- **Test Requirements**:
  - `rule` TR-19.1: A simulated star-status change triggers recompute and downgrades/removes the pick.
  - `rule` TR-19.2: Scheduler registration is skipped when not the entry point (no duplicate crons in tests).

## Task 20: Basketball UI components
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 18
- **Description**:
  - Build `frontend/components/` pieces: `BasketballGameCard`, `ProbabilityBar`, `ConfidenceBadge`, `ValueTag`, `WhyThisPick` (expandable adjustments), `LineMovedIndicator`.
  - Wire into [TipsScreen.js](file:///c:/Users/prosp/Desktop/Apex/frontend/screens/TipsScreen.js): both picks, probability bar, confidence badge, value tag, projected score, expandable "Why this pick" (adjustments applied), filters for league/date/confidence/market, and the "line moved" indicator.
  - GPU-composited animations only (opacity/transform); respect `prefers-reduced-motion`; no placeholder values.
- **Acceptance Criteria Addressed**: FR-53, AC-10
- **Test Requirements**:
  - `rubric` TR-20.1: Rendered card shows both picks, projected score and "why this pick"; scale 1-5; threshold ≥ 4; evidence from rendered API-driven card (no hardcoded sample values).

## Task 21: Basketball backtester (walk-forward, baselines, CLV, ROI)
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 16, Task 17
- **Description**:
  - Extend [backtestingService.js](file:///c:/Users/prosp/Desktop/Apex/backend/services/backtestingService.js) (or `basketball/backtester.js`) with a walk-forward loop over ≥3 seasons: for each game, train + calibrate only on prior data; use closing lines only as a benchmark, never as an input.
  - Report per market + league: hit rate, Brier, log loss, calibration curve, ROI at historical odds, CLV, and performance by probability bucket (55–60/60–65/65–70/70+).
  - Add baselines: always-favourite, bookmaker implied, naive league-average; emit an explicit beat/lose-vs-bookmaker statement.
  - Tune hyperparameters on a validation window, freeze for test; add runnable `backend/scripts/run-basketball-backtest.js`.
- **Acceptance Criteria Addressed**: FR-54, FR-55, FR-56, FR-57, AC-22
- **Test Requirements**:
  - `rule` TR-21.1: No game with tip-off after the training cutoff enters the training fold.
  - `rule` TR-21.2: Output includes all metrics per market/league and the explicit beat/lose statement.
  - `rule` TR-21.3: Bucket metrics (55–60 … 70+) are computed with non-empty sample sizes when data allows.

## Task 22: Live tracking + performance dashboard + auto-downgrade
- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 21
- **Description**:
  - Store every pre-tip prediction and its result using the existing Firestore `predictions` schema (market, line, selection, probability, odds, edge, model version, data-quality).
  - Expose rolling accuracy and calibration by market/league via `GET /basketball/performance`.
  - Auto-downgrade or disable a market if its last-100 performance falls outside the expected range.
- **Acceptance Criteria Addressed**: FR-58
- **Test Requirements**:
  - `rule` TR-22.1: A predicted record is stored with its confidence and result and appears in the performance payload.
  - `rule` TR-22.2: A market whose last-100 hit rate falls below the expected band is auto-downgraded/disabled.

## Task 23: Calibrated basketball tests + build verification
- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 10–22
- **Description**:
  - Add Jest tests: `tests/basketball/config.test.js`, `tests/basketball-ratings.test.js`, `tests/basketball-probability.test.js`, `tests/basketball-odds.test.js`, `tests/basketball-calibration.test.js`, `tests/basketball-selector.test.js`, `tests/basketball-api.test.js`, `tests/basketball-backtest.test.js`.
  - Verify existing tests (`basketball-engine.test.js`, `settlement.test.js`, `football-ranking.test.js`, `providers.test.js`) still pass.
  - Run `npm test`; fix regressions.
- **Acceptance Criteria Addressed**: AC-13–AC-22, NFR-6, NFR-8
- **Test Requirements**:
  - `rule` TR-23.1: Full `npm test` exits 0 with all new and existing tests passing.
  - `rule` TR-23.2: Unit tests cover the possession formula, projection math, probability conversion (incl. push), vig removal and the selector logic.
