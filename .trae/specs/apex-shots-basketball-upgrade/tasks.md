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
