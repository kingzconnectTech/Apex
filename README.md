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

## Live Game Analysis (from a pasted link)

Paste a bookmaker link to identify a game that is already in play. The link is used **only to find the match** — it is never fetched, never scraped for odds, and never stored. Only the bookmaker's hostname is counted for non-personal stats.

What the screen shows depends on a **ship gate**, not on optimism:

- **Score, clock and context** are always shown (once a game is resolved).
- **A live probability is shown only for sports/leagues whose backtest passed** the Phase 5 gate. Other games degrade to facts only, with a reason.
- Until a league passes, `probabilities`, `projection` and `uncertainty` are returned as `null` — they are **withheld, never zeroed**.

### Ship gate

The allowlist lives in `CONFIG.live.picks` (see [config.js](file:///c:/Users/prosp/Desktop/Apex/backend/services/live/config.js)). It is currently **empty for both sports**, so every game shows score, time and context only. A pick may ship only when the Phase 5 backtest, out-of-sample:

- beats de-vigged lines on **both** Brier and log loss by **≥ 0.002**, and
- has **n ≥ 500**, and
- holds a 95% CI lower bound on hit rate above break-even.

The decision is enforced in exactly one place — `buildAnalysis` in [analysis.js](file:///c:/Users/prosp/Desktop/Apex/backend/services/live/analysis.js) — so a probability can neither leak nor be withheld anywhere else. `policy.featureState()` reports `shipping_sports` honestly so the UI can label itself.

### API Endpoints

- `GET  /api/live/capabilities` — is the surface on, which sports may ship, refresh policy, disclaimer
- `POST /api/live/resolve` — `{ link }` → `matched` | `candidates` | `none` (rate-limited)
- `GET  /api/live/analysis/:gameId` — poll the analysis for a resolved game (rate-limited)
- `POST /api/live/manual` — type the values when nothing matched; labelled *user-entered* (separate, stricter rate limit)
- `GET  /api/live/stats` — non-personal counters; secret-gated by `LIVE_STATS_SECRET` (falls back to `SETTLEMENT_CRON_SECRET`)

Error codes: `INVALID_LINK` (400), `FEATURE_DISABLED` (503), `NOT_CONFIGURED` (503), `GAME_NOT_RESOLVED` (404), `INVALID_MANUAL_ENTRY` (400), `MANUAL_ENTRY_DISABLED` (503), `LIVE_ERROR` (500).

### Manual entry

When a link cannot be matched, the user can type the values instead. Hand-typed games sit **behind the same ship gate** — they never ship a probability, and they are handled defensively at every layer:

- **Strict validation**, per sport: score ranges, period limits, a recognised clock, and score/time consistency (e.g. basketball needs a period while live; a clock cannot exceed a period or a match). Impossible inputs are rejected outright with every problem listed at once — never silently coerced.
- **Only what was typed**: no provider context or stats-based factors are used for a hand-typed game.
- **Extra caution**: the tier weight is shrunk a further `liveModel.manual.extraShrink` (0.5) toward the pre-game prior, and uncertainty bands are widened by `liveModel.manual.uncertaintyWiden` (1.6).
- **A permanent badge** — *"User-entered, unverified"* — is stamped into the payload (`manual_badge` / `manual_badge_detail`) and shown on the card **and in any share or export text**.
- **Excluded from every rate**: a hand-typed game is a raw tally only (`manual_entries`); it never moves `match_success_rate`, `candidates_rate`, `manual_entry_rate` or `parse_failure_rate`, and is excluded from calibration/coverage.
- **Its own switch**: `live.manualEntry` is independent of `live.enabled` / `live.sports`, and it has its own stricter per-IP/per-user budget (`liveApi.manualRateLimit`).

### Safety & posture

- **Feature flags**: `live.enabled` / `live.sports` decide whether the surface is on; `live.picks` decides whether a probability may ship; `live.manualEntry` decides whether hand-typed games are accepted. These are deliberately separate.
- **Rate limiting**: no external dependency — a fixed-window counter over an in-process `Map`, per-IP plus an optional per-user bucket. `429` responses carry `Retry-After`. Manual entry uses its own, tighter budget.
- **Stats are non-personal**: bookmaker hostname, sport, league, outcome. No user id, no IP, no full URL (a URL can carry a session token).
- **Shared cache**: a resolved game lives for `gameTtlMs` (4h) and its analysis for `analysisTtlMs` (30s), so many users watching one game cost one upstream read.
- **No market line, no pick**: server-side; without a real line the app shows a projection only.
- Live estimates are statistical model outputs, not betting advice.

### Verifying it

```bash
# backend: live unit + API + backtest suites, with coverage
cd backend
npx jest tests/live- --coverage --collectCoverageFrom="services/live/**/*.js" --collectCoverageFrom="routes/live.js"

# run the Phase 5 backtest that feeds the gate
node scripts/run-live-backtest.js --synthetic=200

# frontend: pure view logic (asserts WITHHELD renders no probability)
cd ../frontend
npm test
```

The Phase 5 validation evidence is in [backend/docs/PHASE_5_LIVE_VALIDATION.md](file:///c:/Users/prosp/Desktop/Apex/backend/docs/PHASE_5_LIVE_VALIDATION.md).

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
