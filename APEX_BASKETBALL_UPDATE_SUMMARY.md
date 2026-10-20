# APEX Basketball Over/Under Update - Summary

## Overview
Updated the basketball prediction engine to prioritize Total Points Over/Under markets with a strict 75% confidence threshold per market. Removed straight-winner predictions and enhanced the prediction engine with head-to-head analysis and last-10-games scoring trends.

## Changes Made

### 1. Backend Configuration (`backend/services/basketball/config.js`)
- **Added market priority configuration**: Defined market priority order as:
  - Priority 1: Total Points (Full-Game Total Points Over/Under)
  - Priority 2: Team Total (Home/Away team total points Over/Under)
  - Priority 3: First Half Total (First-Half Total Points Over/Under)
  - Priority 4: Quarter Total (Quarter Total Points Over/Under)
- **Added secondary market data quality requirement**: `secondaryMarketMinDataQuality: 0.75`
- **Enforced 75% minimum confidence**: Both `mainMinProb` and `alternateMinProb` set to 0.75

### 2. Prediction Engine (`backend/services/basketball/index.js`)
- **Added head-to-head analysis**: Extracts H2H games from team logs and aggregates statistics
- **Enhanced reasoning**: Updated `buildReasoning()` to include:
  - Last 10 games scoring trends (average combined points)
  - Head-to-head average totals when available
  - Adjustments (injuries, rest, travel, etc.)
- **Updated normalizeGame call**: Passes H2H log data to game normalization

### 3. Game Normalization (`backend/services/basketball/normalize.js`)
- **Added H2H parameter**: `normalizeGame()` now accepts `h2hLog` parameter
- **Added H2H stats aggregation**: Computes aggregate statistics for head-to-head games
- **Enhanced game object**: Includes `h2hStats` field in normalized game object

### 4. Line Selector (`backend/services/basketball/lineSelector.js`)
- **Implemented market priority processing**: Processes markets according to configured priority order
- **Removed straight-winner fallback**: No fallback to moneyline or straight-winner predictions
- **Added documentation**: Clear comments explaining that no straight-winner fallback is allowed
- **Prepared for secondary markets**: Framework in place for Team Total, First-Half, and Quarter markets when data becomes available

### 5. API Routes (`backend/routes/basketball.js`)
- **Updated confidence threshold enforcement**: Changed from "at least one pick >= 75%" to "each individual pick must be >= 75%"
- **Per-market filtering**: Each pick is filtered independently based on its own probability
- **Updated error messages**: Clarified that thresholds apply per market, not per match

### 6. Frontend Component (`frontend/components/BasketballGameCard.js`)
- **Updated comment**: Clarified that Total Points is prioritized with 75%+ confidence requirement
- **Already displays required information**: Component already shows:
  - Match name
  - Scheduled start time and match status
  - Market: Total Points
  - Points line
  - Predicted selection (Over/Under)
  - Projected total
  - Confidence percentage
  - Short explanation (reasoning)

### 7. Tests (`backend/tests/basketball-engine.test.js`)
- **Added new test suite**: "APEX Basketball Over/Under Update"
- **Test: 75% confidence threshold per market**: Verifies that only picks with probability >= 75% are displayed
- **Test: Market priority**: Verifies Total Points is first in priority list
- **Test: No straight-winner predictions**: Verifies no moneyline/winner markets in priority list
- **Test: Head-to-head analysis**: Verifies H2H data is extracted and processed
- **Test: Last 10 games scoring trends**: Verifies last 10 games are analyzed and averages calculated

## Key Features

### 1. Market Priority
- Total Points is the primary market
- Secondary markets (Team Total, First-Half, Quarter) are configured but require period-level data
- No straight-winner or moneyline predictions are generated

### 2. 75% Confidence Threshold
- Applied per market (per pick), not per match
- Each individual pick must have probability >= 75% to be displayed
- Predictions below 75% are excluded without fallback

### 3. Enhanced Analysis
- **Last 10 games**: Analyzes recent form, scoring trends, and consistency
- **Head-to-head**: Extracts and aggregates H2H statistics when teams have played each other
- **Pace and possessions**: Already analyzed in existing ratings system
- **Injuries**: Already analyzed in existing adjustments system
- **Rest days and back-to-back**: Already analyzed in existing adjustments system
- **Home/away splits**: Already analyzed in existing ratings system

### 4. Improved Reasoning
- Includes team average combined points from last 10 games
- Includes head-to-head average totals when available
- Shows adjustment impacts (injuries, rest, travel, etc.)
- Shows edge percentage when available

## Files Modified

1. `backend/services/basketball/config.js` - Market priority and confidence configuration
2. `backend/services/basketball/index.js` - H2H analysis and enhanced reasoning
3. `backend/services/basketball/normalize.js` - H2H stats aggregation
4. `backend/services/basketball/lineSelector.js` - Market priority processing
5. `backend/routes/basketball.js` - Per-market confidence threshold enforcement
6. `frontend/components/BasketballGameCard.js` - Updated comments
7. `backend/tests/basketball-engine.test.js` - New test suite for APEX update

## Test Results

All 26 tests passed:
- AC-5: Possessions formula (3 tests)
- AC-6: Offensive/defensive ratings (4 tests)
- Shrinkage toward league mean (3 tests)
- AC-7: Win probability (2 tests)
- Basketball History Analysis (4 tests)
- Basketball Prediction (2 tests)
- Basketball Settlement (3 tests)
- APEX Basketball Over/Under Update (5 tests)

## Verification

- ✅ 75% confidence threshold enforced per market
- ✅ Total Points prioritized over other markets
- ✅ No straight-winner/moneyline fallback
- ✅ Head-to-head analysis included
- ✅ Last 10 games scoring trends included
- ✅ All tests passing
- ✅ Football predictions unchanged
- ✅ Existing basketball fixtures, match statuses, and result settlement preserved

## Notes

- Secondary markets (Team Total, First-Half, Quarter) are configured but require period-level data from ESPN or other providers to be fully implemented
- The existing basketball prediction pipeline already analyzed most required factors (pace, injuries, rest days, home/away splits); this update adds H2H analysis and ensures proper market prioritization
- Model-generated lines (when no bookmaker odds are available) are clearly labeled as "MODEL LINE" in the frontend
- Football prediction logic and the 90% confidence threshold remain unchanged
