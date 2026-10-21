# Basketball Prediction Model Documentation

## Overview

The Apex basketball prediction engine uses a walk-forward rating system with bounded adjustments, calibration, and market selection to generate probabilistic predictions for NBA, WNBA, NCAA, and EuroLeague games.

## Data Sources

### Primary: ESPN API
- **Base URL**: `http://site.api.espn.com/apis/site/v2/sports/basketball/{league}`
- **Endpoints Used**:
  - `/{league}/scoreboard` - Fixtures and schedule
  - `/{league}/teams/{id}` - Team information
  - `/{league}/teams/{id}/schedule` - Team schedule
  - `/{league}/summary?event={id}` - Game summary (odds, injuries, box scores)
  - `/{league}/news?team={id}` - Team news

### Available Fields

| Data Type | Fields | Source | Notes |
|-----------|--------|--------|-------|
| **Fixtures** | game_id, date, status, teams, venue | ESPN scoreboard | |
| **Box Scores** | fgm, fga, tpm, tpa, ftm, fta, orb, drb, trb, ast, tov, stl, blk, pf | ESPN summary | Full box score for both teams |
| **Odds** | spread, total, moneyline, over/under odds, opening/closing lines | ESPN summary/pickcenter | When available |
| **Injuries** | player, status (out/doubtful/questionable/probable), injury type, location, return date | ESPN summary | |
| **Lineups/Starters** | Not available | ESPN | Missing from ESPN API |
| **Play-by-Play** | Sequence of plays, timestamps | ESPN core API | Not currently used |
| **Player On/Off** | Not available | ESPN | No RPM/basketball-on-off data |
| **Travel Distance** | Not available | ESPN | Requires external venue data |
| **Altitude** | Not available | ESPN | Requires external venue data |

### Missing Data Handling

When ESPN doesn't provide a field:
- The field is set to `null` (never fabricated)
- Adjustments requiring the field are skipped
- Data quality score is reduced to reflect missing information
- The model degrades gracefully but may have lower predictive power

## Model Architecture

### 1. Team Ratings (`ratings.js`)

**Recency-Weighted Ratings**
- Exponential decay with configurable half-life (default: 9 games)
- Formula: `weight = 0.5^(i / halfLife)` for game `i` (newest-first)
- Applies to: ORtg, DRtg, pace, net rating

**Empirical-Bayes Shrinkage**
- Small samples shrunk toward league mean
- Formula: `shrunk = value * (n / (n + m)) + prior * (m / (n + m))`
- Default shrinkage constant `m = 6` (pseudo-games)
- Home/away splits shrunk more aggressively (`m = 4`)

**Prior-Season Blending**
- Early season: blend prior-season ratings with current
- Current weight ramps from 0 at 0 games to 1 at 20 games
- Formula: `blended = current * (g / 20) + prior * (1 - g / 20)`

**Iterative Opponent Adjustment (SRS)**
- 12 iterations of opponent strength adjustment
- Ridge regression parameter: 0.15
- Produces schedule-adjusted ratings

**Elo Second Signal (Optional)**
- K-factor: 20
- Margin-of-victory cap: 20 points
- 28 Elo points ≈ 1 point of margin
- Blended with ratings: 25% Elo, 75% ratings

### 2. Game Projection (`projection.js`)

**Expected Possessions**
- Formula: `possessions = FGA - ORB + TOV + 0.44 * FTA`
- Blended pace: `pace = 0.55 * home_pace + 0.45 * away_pace` (configurable)

**Expected Points**
- Home PPP: `(home_ORtg + away_DRtg) / 2 / 100`
- Away PPP: `(away_ORtg + home_DRtg) / 2 / 100`
- Home points: `possessions * home_PPP + home_court/2`
- Away points: `possessions * away_PPP - home_court/2`

**Home Court Advantage**
- NBA: 2.7 points (learned from data)
- WNBA: 2.4 points
- NCAA: 3.2 points
- EuroLeague: 3.0 points

### 3. Bounded Adjustments (`adjustments.js`)

All adjustments are individually capped AND have an overall ceiling.

**Rest/Fatigue**
- Back-to-back: -2.5 margin, -1.0 total
- 3-in-4 nights: -1.5 margin, -0.5 total
- Caps: ±4 margin, ±2 total

**Travel/Altitude**
- Long travel (≥1500km): -1.5 margin, -0.5 total
- Altitude (≥1500m): ±1.0 margin, +0.5 total (home advantage)
- Caps: ±2 margin, ±1 total

**Motivation/Schedule**
- Situational spots: ±1.5 margin, ±0.5 total
- Caps: ±2 margin, ±1 total

**Pace Interaction**
- Two slow teams: -3.0 total
- Two fast teams: +3.0 total
- Cap: ±10 total overall

**Blowout Down-Weighting**
- Games decided by ≥20 points down-weighted 50%
- Only affects historical games (garbage time correction)

**Injuries**
- Per-player impact: ±1.5 margin, ±1.0 total (default)
- Full minutes share: 35% (rotation player threshold)
- Status probability mapping:
  - Out: 0%
  - Doubtful: 25%
  - Questionable: 50%
  - Probable: 90%
  - Day-to-day: 50%
- Caps: ±5 per player, ±8 combined, ±12 margin overall, ±10 total overall

### 4. Probability Model (`probability.js`)

**Distribution**
- Normal distribution (configurable to t-distribution)
- Sigma estimated from historical residuals
- League-specific base sigma (NBA: total=17.5, margin=11.5)

**Sigma Estimation**
- Base sigma from league config
- Adjusted for projected total: `+0.02 * |proj_total - league_mean|`
- Adjusted for pace: `+0.06 * |pace - league_pace|`
- Data quality penalty: +3.0 total, +2.0 margin
- Clamped: total [12, 26], margin [8, 18]

**Probability Calculation**
- Total Over: `P(Over) = 1 - Φ((line - proj_total) / sigma_total)`
- Spread Home: `P(Home covers) = 1 - Φ((-spread - proj_margin) / sigma_margin)`
- Half-point lines handled correctly (no push probability)

### 5. Calibration (`calibration.js`)

**Methods**
- Isotonic regression (default)
- Platt scaling (logistic regression alternative)

**Walk-Forward Training**
- Calibrator refitted every 25 predictions
- Minimum samples: 150 before trusted
- Only out-of-sample predictions used for training
- Separate calibrator per market and league

**Probability Clamping**
- Epsilon: 0.001 (never emit 0 or 1)

### 6. Pick Selection (`lineSelector.js`)

**Thresholds**
- Main lines: probability ≥ 60% (internal), ≥ 75% (API display)
- Alternate lines: probability ≥ 65% (internal), ≥ 75% (API display)
- Edge: ≥ 4%
- Data quality: ≥ 0.7 (≥ 0.75 for secondary markets)

**Ranking**
- Score: `0.7 * probability + 0.3 * edge_scaled_EV`
- Edge-scaled EV: `clamp(ev / 0.10, 0, 1)`
- Best pick per market returned

**Model-Generated Lines**
- When no bookmaker odds available
- Total: projected total + 0.5
- Spread: projected margin + 0.5
- Minimum probability: 65%
- Clearly labeled as "MODEL LINE"

**Consistency Check**
- Flags contradictory pairings (big spread with very low total)
- Big margin: ≥10 points
- Low total: ≤200, high total: ≥245

**Market Priority**
1. Total Points (primary)
2. Spread
3. Team Total
4. First Half Total
5. Quarter Total

**Confidence Tiers**
- High: data quality ≥ 0.85, confirmed lineups
- Medium: data quality ≥ 0.75
- Low: data quality ≥ 0.70

### 7. Auto-Downgrade Policy (`persistence.js`)

**Rolling Window**
- Last 100 predictions
- Minimum sample: 30 before verdict

**Tolerance**
- Allowed gap between predicted and actual: ±7%
- Downgrade gap: -7% (actual < predicted - 7%)
- Disable gap: -15% (actual < predicted - 15%)

**Status Levels**
- Active: within tolerance
- Downgraded: below -7% gap
- Disabled: below -15% gap

## Configuration

All tunable parameters are in `services/basketball/config.js`.

### Per-League Parameters (`leagues.js`)

```javascript
{
  key: 'nba',
  label: 'NBA',
  espnPath: 'basketball/nba',
  gameMinutes: 48,
  ftWeight: 0.44,
  homeCourtPoints: 2.7,
  leagueMean: { possessions: 99.5, ortg: 114.0, drtg: 114.0 },
  sigma: { total: 17.5, margin: 11.5 },
  scoreStd: 11,
  priorSeason: { ortg: 114.0, drtg: 114.0, pace: 99.5 },
  rotationSize: 9,
  enabled: true,
}
```

### Global Config (`config.js`)

**Ratings**
- `halfLifeGames`: 9
- `shrinkageM`: 6
- `splitShrinkageM`: 4
- `priorBlendFullWeightGames`: 20
- `srsIterations`: 12
- `srsRidge`: 0.15
- `elo.enabled`: true
- `elo.k`: 20
- `elo.movCap`: 20
- `elo.pointsPerElo`: 28
- `elo.blendWeight`: 0.25

**Projection**
- `paceBlendWeight`: 0.55

**Adjustments**
- All caps and magnitudes documented in file

**Sigma**
- `distribution`: 'normal'
- `minTotal`: 12, `maxTotal`: 26
- `minMargin`: 8, `maxMargin`: 18
- `totalSizeCoef`: 0.02
- `paceCoef`: 0.06
- `dqPenaltyTotal`: 3.0
- `dqPenaltyMargin`: 2.0

**Calibration**
- `enabled`: true
- `method`: 'isotonic'
- `minSamples`: 150
- `epsilon`: 0.001

**Selection**
- `mainMinProb`: 0.60
- `alternateMinProb`: 0.65
- `minEdge`: 0.04
- `minDataQuality`: 0.7
- `rankProbWeight`: 0.7
- `rankEvWeight`: 0.3
- `evScale`: 0.10

## Adding a New League

1. Add league config to `services/basketball/leagues.js`:
```javascript
newLeague: {
  key: 'newleague',
  label: 'New League',
  espnPath: 'basketball/newleague',
  gameMinutes: 40,  // or 48
  ftWeight: 0.44,
  homeCourtPoints: 2.5,  // Estimate or learn from data
  leagueMean: { possessions: 80, ortg: 105, drtg: 105 },  // League averages
  sigma: { total: 15, margin: 10 },  // Estimate from residuals
  scoreStd: 10,
  priorSeason: { ortg: 105, drtg: 105, pace: 80 },
  rotationSize: 8,
  enabled: true,
}
```

2. Add alias if needed to `ALIASES` object

3. Test with synthetic data first:
```bash
node scripts/run-basketball-backtest.js --synthetic=200 --league=newleague
```

4. Run backtest with real data to tune sigma and home court:
```bash
node scripts/run-basketball-backtest.js --league=newleague --with-odds
```

5. Update sigma and homeCourtPoints based on residual analysis

## Backtesting

### Running a Backtest

**Synthetic Data (smoke test):**
```bash
node scripts/run-basketball-backtest.js --synthetic=400
```

**Real Current Season Data:**
```bash
node scripts/run-basketball-backtest.js --league=nba --with-odds --max-games=300
```

**Historical Dataset:**
```bash
node scripts/run-basketball-backtest.js --dataset=data/nba-3y.json --tune --out=report.json
```

**Hyperparameter Tuning:**
```bash
node scripts/run-basketball-backtest.js --dataset=data/nba-3y.json --tune
```

### Backtest Metrics

**Per Pick:**
- Hit rate
- Brier score
- Log loss
- ROI (at historical odds)
- Calibration gap (actual - predicted)
- Closing-line value (CLV)

**Per Bucket:**
- Probability buckets: 55-60%, 60-65%, 65-70%, 70%+
- Predicted vs actual hit rate per bucket

**Baselines:**
- Model (calibrated)
- Model (uncalibrated)
- Bookmaker implied probabilities
- Naive league average
- Always-favourite

### Walk-Forward Guarantees

1. **No data leakage**: Team ratings computed only from games that tipped off strictly earlier
2. **No calibration leakage**: Calibrator refitted only from picks finished strictly earlier
3. **Closing lines not used as input**: Only used as benchmark for CLV

## Live Tracking

### Persistence

**Collection:** `basketball_predictions`

**Document Structure:**
```javascript
{
  gameId: string,
  game: string,
  league: string,
  leagueLabel: string,
  tipoff: ISO string,
  market: string,
  selection: string,
  line: number,
  side: 'a' | 'b',
  isMain: boolean,
  isModelLine: boolean,
  probability: number,
  odds: number,
  edge: number,
  ev: number,
  confidence: 'high' | 'medium' | 'low',
  reasoning: string,
  projection: { total, margin, sigma_total, sigma_margin },
  dataQuality: number,
  modelVersion: string,
  keyFactors: [],
  riskFlags: [],
  status: 'pending' | 'settled',
  closingLine: object,
  actual: { homeScore, awayScore, total, margin },
  outcome: 'won' | 'lost' | 'push',
  profit: number,
  createdAt: ISO string,
  settledAt: ISO string,
}
```

### Scheduled Jobs

**Morning Run (09:00):**
- Initial predictions for the day's games
- Full pipeline with all adjustments

**Pre-Tip Refresh (every 10 min):**
- Re-runs for games within 60-90 minutes of tip-off
- Final check 15 minutes before tip-off
- Updates injury reports and starters
- Only changed predictions written
- Picks that no longer clear thresholds are voided

**Settlement (every 20 min):**
- Grades stored picks against final scores
- Updates performance metrics
- Triggers auto-downgrade if needed

### Performance Dashboard

**Endpoint:** `GET /api/basketball/performance?league=nba&window=100`

**Response:**
```javascript
{
  overall: {
    sample: number,
    hits: number,
    hitRate: number,
    avgPredicted: number,
    calibrationGap: number,
    brier: number,
    logLoss: number,
    roi: number,
    byBucket: [...],
    verdict: 'active' | 'downgraded' | 'disabled',
  },
  byMarket: {
    'Total Points': { ... },
    'Spread': { ... },
  },
  byLeague: {
    'nba': { ... },
  },
  policy: {
    enabled: boolean,
    status: { 'Total Points': 'active', 'Spread': 'active' },
    reasons: { ... },
  },
}
```

## API Endpoints

### Get Predictions
```
GET /api/basketball/predictions?date=YYYY-MM-DD&league=nba&confidence=high&market=Total Points
```

**Response:**
```javascript
{
  date: string,
  league: string,
  count: number,
  predictions: [
    {
      game: string,
      gameId: string,
      tipoff: ISO string,
      league: string,
      leagueKey: string,
      homeTeam: { id, name },
      awayTeam: { id, name },
      projection: {
        total: number,
        margin: number,
        sigma_total: number,
        sigma_margin: number,
      },
      score: { home, away },
      picks: [
        {
          market: string,
          selection: string,
          probability: number,
          odds: number,
          edge: number,
          confidence: string,
          reasoning: string,
          line: number,
          side: string,
          isMain: boolean,
          isModelLine: boolean,
          ev: number,
        }
      ],
      key_factors: [...],
      risk_flags: [...],
      data_quality: number,
      modelVersion: string,
    }
  ],
  modelVersion: string,
  disclaimer: string,
}
```

### Get Single Game
```
GET /api/basketball/predictions/:gameId?league=nba
```

### Get Performance
```
GET /api/basketball/performance?league=nba&window=100
```

### List Leagues
```
GET /api/basketball/leagues
```

## Disclaimer

Predictions are statistical estimates, not betting advice. A 68% pick still loses about 1 in 3 times. The model does not guarantee profits and past performance does not guarantee future results.
