# PitchAPI Integration Guide — Apex Sports Data

This document describes the integration of **PitchAPI** ([https://pitchapi.dev/](https://pitchapi.dev/)) into the Apex platform as a free secondary football data provider.

---

## 1. Overview & Architecture

Apex uses a multi-tiered provider architecture to maximize fixture and league coverage while keeping operating costs strictly at zero:

1. **ESPN (Primary Provider — Priority 1)**:
   - Covers major top-tier football leagues, NBA/WNBA basketball, and ATP/WTA tennis.
   - Every request checks ESPN first. If ESPN provides data, secondary providers are **never queried**.
2. **PitchAPI (Secondary Provider — Priority 2 — Football Only)**:
   - Fills missing coverage for lower divisions, regional tiers, and cup competitions across 77 supported leagues.
   - Queried only when ESPN does not cover the league or fixture.

> **Note on other sports**: Basketball and tennis requests are exclusively handled by ESPN and are **never** routed to PitchAPI.

---

## 2. Environment Variables & Secure Configuration

The following variables configure PitchAPI in `.env` (refer to `.env.example`):

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `PITCHAPI_KEY` | `string` | `""` | PitchAPI API key (`pk_live_...` or `pk_test_...`). |
| `PITCHAPI_ENABLED` | `boolean` | `true` | Feature flag to enable or disable PitchAPI dynamically. |

### Security Measures
- Secrets are read via `dotenv` in `services/providers/config.js`.
- Never exposed in frontend client bundles.
- Automatically scrubbed from all diagnostic and application log messages.
- Both root `.gitignore` and `backend/.gitignore` ensure `.env` and credentials are never committed.

---

## 3. Verified PitchAPI Specifications & Endpoints

Based on official PitchAPI documentation at `https://pitchapi.dev/`:

- **API Base URL**: `https://api.pitchapi.dev`
- **Authentication**: Custom HTTP header `X-API-KEY: <PITCHAPI_KEY>`
- **Pricing & Limits**:
  - 100% Free tier, unlimited total requests.
  - Fair-use burst guard: returns `429 Too Many Requests` with a `Retry-After` header when triggered.
- **Coverage**: 77 domestic leagues, second/third divisions, and cup competitions across Europe, the Americas, Asia, and international tournaments.
- **Implemented Endpoints**:
  - `GET /v1/leagues` — League catalogue.
  - `GET /v1/leagues/{id}` — Individual league metadata.
  - `GET /v1/leagues/{id}/matches` — Matches for a competition (`?status=all|scheduled|finished&season=YYYY`).
  - `GET /v1/matches/{id}` — Match fixture details.
  - `GET /v1/matches/{id}/stats` — Team match statistics (xG, shots, corners).
  - `GET /v1/matches/{id}/h2h` — Historical head-to-head records.
  - `GET /v1/teams/{id}` — Team details.
  - `GET /v1/date/{date}` — Matches on a specific date (`YYYY-MM-DD`).

### Unverified / Unsupported Features
- **Standings**: PitchAPI **does not** provide a standalone league standings table endpoint. `getStandings()` gracefully returns `null` rather than fabricating data.

---

## 4. Normalization & Deduplication

All data entering Apex is normalized into a uniform internal schema:

- **ID Prefixing**: PitchAPI IDs (e.g. `m_B8x2K9`, `t_9aB2xQ`) are prefixed with `pa-` (e.g. `pa-m_B8x2K9`, `pa-t_9aB2xQ`).
- **Validation**: `isValidId()` in `server.js` supports `pa-` prefixed IDs.
- **Deduplication**: `buildDedupKey()` and `fixturesMatch()` prevent duplicate fixtures when ESPN and PitchAPI overlap, strictly preferring ESPN's record.
- **Prediction Engine Integrity**: Missing statistics are retained as `null` and never fabricated or coerced to 0, ensuring prediction models (Poisson, Elo, LSTM) receive honest inputs.

---

## 5. Caching & Rate Limiting

- **TTL Caching (`services/providers/cache.js`)**:
  - Leagues & Teams: 24 hours.
  - Finished Matches: 24 hours.
  - Scheduled Fixtures: 15 minutes.
  - Match Stats & H2H: 1 hour.
- **In-flight Deduplication**: Prevents duplicate concurrent HTTP requests for identical resources.
- **Exponential Backoff & Rate Limit Handling**:
  - On `429`: Respects `Retry-After` header and temporarily blocks subsequent requests without infinite loops.
  - On `401/403`: Enforces 5-minute backoff, disabling provider after 3 consecutive failures.

---

## 6. Testing

Run automated tests covering scenarios A through I:

```bash
cd backend
npx jest tests/pitchapi.test.js --verbose
```

Run full suite:
```bash
npm test
```
