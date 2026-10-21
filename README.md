# Apex Sports Prediction Platform

Apex is a multi-sport prediction and analytics application covering football, basketball, and tennis.

## Architecture & Data Providers

Apex employs a tiered data provider architecture designed for high availability and zero operating costs:

1. **ESPN (Primary Provider)**:
   - Primary data provider for all sports: football (top tiers), basketball (NBA, WNBA), and tennis (ATP, WTA).
2. **PitchAPI (Secondary Provider — Football)**:
   - Secondary provider filling missing lower divisions, regional tiers, and cup competitions across 77 football leagues.
   - 100% free with fair-use burst protection.

For full details on PitchAPI configuration, endpoints, rate limiting, and normalizers, see [backend/PITCHAPI_INTEGRATION.md](file:///c:/Users/prosp/Desktop/Apex/backend/PITCHAPI_INTEGRATION.md).

## Basketball Prediction Model

Apex includes a comprehensive basketball prediction engine with:

- **Advanced Team Ratings**: Recency-weighted ratings with empirical-Bayes shrinkage, opponent adjustment (SRS), and optional Elo blending
- **Game Projection**: Possessions-based scoring with home-court advantage and pace interaction
- **Bounded Adjustments**: Rest/fatigue, travel, altitude, injuries, and schedule spots (all capped)
- **Probability Modeling**: Normal distribution with walk-forward isotonic calibration
- **Pick Selection**: Configurable thresholds with market priority and consistency checks
- **Live Tracking**: Automatic settlement, rolling performance metrics, and auto-downgrade policy

### Supported Leagues
- NBA (primary)
- WNBA
- NCAA Men's
- EuroLeague

### API Endpoints
- `GET /api/basketball/predictions?date=&league=&confidence=&market=`
- `GET /api/basketball/predictions/:gameId?league=`
- `GET /api/basketball/performance?league=&window=`
- `GET /api/basketball/leagues`

For complete model documentation, see [backend/docs/BASKETBALL_MODEL.md](file:///c:/Users/prosp/Desktop/Apex/backend/docs/BASKETBALL_MODEL.md).

### Backtesting
The system includes a walk-forward backtester with no data leakage guarantees:
```bash
cd backend
node scripts/run-basketball-backtest.js --synthetic=400
node scripts/run-basketball-backtest.js --league=nba --with-odds --max-games=300
```

For the full backtesting summary, see [backend/docs/PHASE_6_BACKTESTING_SUMMARY.md](file:///c:/Users/prosp/Desktop/Apex/backend/docs/PHASE_6_BACKTESTING_SUMMARY.md).

## Running the Application

### Backend
```bash
cd backend
npm install
npm test
npm start
```

### Frontend
```bash
cd frontend
npm install
npx expo start
```
