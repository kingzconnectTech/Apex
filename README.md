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
- `GET  /api/live/stats` — non-personal counters and the shadow/health block; requires the secret in the **`Authorization: Bearer <secret>`** header
- `POST /api/live/sweep` — run the shadow sweep now (the **primary** evidence trigger; **`Authorization: Bearer <secret>`** required, rate-limited; node-cron is only a backup). `?dry_run=true` runs the matching and grid gating, reports what it *would* write and **writes nothing**

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

### Shadow evidence storage & the sweep trigger

Held (shadow) sports collect evidence toward their release gate. That evidence must survive a host that sleeps, so this round moved it behind **one storage adapter** with two backends, chosen by config:

- **`file`** (default) — backend-local JSON files. Tests and local dev. Does **not** survive an ephemeral host disk.
- **`firestore`** — the existing Firebase admin setup. Production. Set `LIVE_STORE_KIND=firestore`.

Both backends implement the same interface for rows, settle outcomes, the health state and the evaluation ledger, so nothing else changes when the backend does. The Firestore layout is one collection (`live_shadow`) holding the `meta`, `health` and `ledger` documents plus the row documents in a `rows` **subcollection**. Firestore cannot hang a subcollection off a collection (a `CollectionReference` has no `.collection()`), so the rows live under a fixed, un-written parent document: `live_shadow/container/rows/<rowId>` (`live.store.firestore.rowsParentDoc`). The parent `container` document holds no data and never shows up in a listing of `live_shadow`; it exists only to own the subcollection, which `live_shadow/{document=**}` already denies to clients.

**Idempotent writes.** A row's storage key is `sport|league|game_id|grid_checkpoint` (and, in Firestore, is the document id). A retry or a double sweep **overwrites** the same document — it can never append a second row. And a row is written **only** when its elapsed fraction lands within `gridTolerance` (0.03) of a **replay grid** mark (`1/8, 3/16, 1/4, …` of regulation); any other checkpoint is skipped, so what is stored is exactly the schedule the replay scores.

**The sweep trigger is `POST /api/live/sweep`.** The in-process `node-cron` (`*/5 * * * *`) is a **backup only** — it stops the moment the host sleeps (a free-tier host sleeps after inactivity). Point an **external 5-minute free scheduler** at the endpoint so evidence keeps flowing without a permanently-awake process. The endpoint is guarded:

- **Secret from the `Authorization` header only.** Send `Authorization: Bearer <secret>`. The secret is **never** read from a query string or a request body (both leak into logs, proxies and referrers) and is **never logged**. The compare is **constant time** (`timingSafeEqual` over SHA-256 digests), so a wrong secret cannot be found byte-by-byte by timing.
- **Fail closed.** If the env secret is **absent** or **shorter than 24 characters** (`live.store.secret.minLength`) the route returns `401` for everyone — an endpoint that writes evidence never runs open, and a weak secret is refused outright.
- **Per-IP rate limited** (`live.store.sweep.rateLimit`, 6/min), **safe under concurrency** (a sweep already running returns `skipped: true` instead of stacking a second run) and **bounded per call** (`maxGamesPerCall`, default 12) so it always returns inside the host's request timeout — `truncated: true` means the next call continues from where it stopped.
- **`?dry_run=true`** runs the matching and grid gating and reports `would_log` / `would_settle` **without writing anything** (not even a health record). Use it to prove a deployment can see games before enabling the real trigger.

**Interruption safety.** A sweep interrupted mid-way (a caller timeout, a host restart, a provider error) flushes the rows it already logged before returning, and every write is **idempotent** (keyed by the storage key), so the next sweep re-logs the same checkpoints without creating duplicates. A request that arrives after the host wakes simply runs the sweep — nothing needs to be replayed by hand.

**`live_shadow` is server-only.** The evidence collection is accessed **only** by the backend through the Firebase Admin SDK, which bypasses security rules. [firestore.rules](file:///c:/Users/prosp/Desktop/Apex/firestore.rules) explicitly denies **all** client read and write to `live_shadow/{document=**}`; no app can read the evidence directly.

#### Set up the external 5-minute trigger (free)

Pick either provider. Both need the secret token you also use for `/api/live/stats`.

Set the secret first (Render → your service → **Environment**), if not already set for settlement:

- **`LIVE_STATS_SECRET`** — a long random string (`openssl rand -base64 32`). It must be **at least 24 characters** or every sweep/stats request is refused `401` (fail closed).
  - `/api/live/sweep` also accepts `SETTLEMENT_CRON_SECRET`, so an existing deployment needs nothing new.

**UptimeRobot** (free tier allows 5-minute monitors):

1. Sign up at <https://uptimerobot.com/> and add a monitor.
2. **Monitor Type:** `HTTP(s)`.
3. **Friendly Name:** `Apex shadow sweep`.
4. **URL:** `https://<your-service>.onrender.com/api/live/sweep`
   - UptimeRobot's HTTP monitor sends **GET**, which is not the route. Use the "Cron Job" feature instead (see below), or a monitor type that supports a POST body. UptimeRobot's classic HTTP monitor cannot set a custom POST header, so **prefer cron-job.org** for the sweep (below) and keep UptimeRobot's HTTP monitor on `/health` for keep-alive.
5. **Monitoring Interval:** `5 minutes`.

**cron-job.org** (free, supports method + headers):

1. Sign up at <https://cron-job.org/> and **Create cronjob**.
2. **Title:** `Apex shadow sweep`.
3. **URL:** `https://<your-service>.onrender.com/api/live/sweep`
4. **Schedule:** every `5` minutes.
5. **Advanced → Request method:** `POST`.
6. **Advanced → Headers:** add `Authorization: Bearer <your LIVE_STATS_SECRET value>`.
7. Save. The first run returns `{"traceId":"…","live_games":N,"logged":M,"settled":K,"truncated":false}`; a `401` means the header is missing, wrong, or the env secret is unset/too short.

Verify it is working:

```bash
curl -X POST -H "Authorization: Bearer <your secret>" https://<your-service>.onrender.com/api/live/sweep
# then confirm the durable health block advanced:
curl -H "Authorization: Bearer <your secret>" https://<your-service>.onrender.com/api/live/stats
```

The `health` block in `/api/live/stats` is read from **durable storage** (not memory), so it is correct even after a cold start; it reports the active `storage` backend, whether the sweep is ticking, and raises one of `never_ran` / `scheduler_stale` / `no_rows_while_live` / `counter_drift`.

**The daily reconcile is `POST /api/live/reconcile`.** The counters in `live_shadow/meta` are a **cache**; the rows are the truth. Once a day this endpoint recounts the rows (`count()` aggregation on Firestore, grouped by sport and league) and compares the result to the counters, recording any **counter-vs-recount drift** in the durable `health` document. `/api/live/stats` surfaces that drift (`health.scheduler.reconcile`) and raises a `counter_drift` alert on **any non-zero delta** — a counter that has silently drifted is caught by the pipeline rather than trusted. It is secret-gated exactly like the sweep (the `Authorization` header, constant-time compared, per-IP rate limited) and NEVER throws into the request: a reconcile that cannot complete is recorded as a reconcile error and retried. An in-process cron (`0 3 * * *`) runs it as a **backup**; drive it from the **same external scheduler** on a daily schedule (see below), because a free-tier host sleeps and the in-process cron stops with it.

#### Write volume vs the Firestore free tier

The Spark (free) plan allows **20,000 document writes/day**. At current coverage (soccer 17 leagues, basketball NBA/WNBA/CBB) a 5-minute cadence is **288 sweeps/day**, and each sweep costs roughly **(rows changed that tick) + 1 `meta` + 1 `health`**:

| Source | Per day (typical) | Per day (peak slate) |
|---|---|---|
| Shadow rows (≈ 6–9 grid rows per live game) | ~900 | ~3,200 |
| Per-sweep `meta` + `health` (288 × 2) | ~576 | ~576 |
| **Total writes/day** | **~1,500** | **~3,800** |
| **Share of the 20,000/day free tier** | **~7%** | **~19%** |

Order-of-magnitude estimates from the observed cadence and league coverage, not measured — but even a full peak slate sits at roughly a fifth of the free-tier write budget, so the free tier is ample. Anything the adapter cannot write is retried on the next sweep, and the writes are idempotent, so a retry never double-counts.

#### Read volume vs the Firestore free tier

The Spark (free) plan allows **50,000 document reads/day**. The startup path reads **only the `meta` document** — which now carries the aggregate counters (rows per day, settled games per sport and league, first/last row time) — so it costs **1 read** and is **independent of the collection size**. The whole `rows` subcollection is loaded **only for the one-off confirmation evaluation**, never on a request or startup path:

| Source | Cost | When |
|---|---|---|
| `meta` document (rows/day, settled games per sport+league, first/last row time) | **1 read** | once per **cold start** (startup) |
| Health document (`health` doc) | **1 read** | once per **cache miss** |
| Ledger document (`ledger` doc) | **1 read** | once per **cache miss** |
| One game's rows (grid-bounded, **≤ 11**) | **≤ 11 reads** | per settled game whose rows are not in memory (a restart) |
| Full `rows` load (the whole subcollection) | **R + 1 reads** (R = rows stored) | **once, by hand** — the one-off evaluation (`loadRows: true`) |

The stats response is cached for `live.store.stats.cacheTtlMs` (default **5000 ms**), so the health/ledger reads are bounded by the **cache-miss rate**, not the request rate. The counters are mirrored in memory after startup, so `/api/live/stats` adds **no** per-request storage reads.

Worked example at **30k and 90k stored rows** — a 5-minute stats poll (288 misses/day), 3 cold starts/day, and ~40 games settling per day while the process is cold:

```
health + ledger   = 288 × 2      = 576
meta on startup   =   3 × 1      =   3
settlement rows   =  40 × ≤11    = ≤440
--------------------------------------------
total reads/day   ≈ ≤ 1,020   →  ~2% of the 50,000/day free tier

  30k rows stored  →  same ≈ 1,020 reads/day
  90k rows stored  →  same ≈ 1,020 reads/day
```

The daily total is **flat in R**: neither the startup path nor the stats path ever touches the `rows` subcollection, so tripling the stored rows changes nothing. For contrast, the previous full-subcollection startup read cost **3 × (R + 1)** per day, which the free tier cannot absorb:

```
R = 30,000  →  3 × 30,001 =  90,003 reads/day  →  ~180% of the free tier (over)
R = 90,000  →  3 × 90,001 = 270,003 reads/day  →  ~540% of the free tier (over)
```

That is exactly why the counters exist. The one-off evaluation is the only O(R) read; run it by hand when the confirmation gate is reached, not on a schedule.

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

**Test isolation.** Under `NODE_ENV=test` **every** live store is forced to a temp directory no matter what a test configures: [fileStore.js](file:///c:/Users/prosp/Desktop/Apex/backend/services/live/store/fileStore.js) routes all four paths (rows, health, ledger, evidence) under `<tmp>/apex-live-test-<pid>/`, and `store.describe()` reports `test_isolated: true`. On top of that, Jest `globalSetup`/`globalTeardown` ([tests/global-setup.js](file:///c:/Users/prosp/Desktop/Apex/backend/tests/global-setup.js), [tests/global-teardown.js](file:///c:/Users/prosp/Desktop/Apex/backend/tests/global-teardown.js)) fingerprint every file under `backend/data/` before the suite and **fail the run** if any of them changed — so a test can never silently overwrite committed evidence like `live-ledger.json`.

## Deployment checklist

Short version: run the emulator suites in step 0, set four env vars, point an external 5-minute POST at `/api/live/sweep` (and a daily POST at `/api/live/reconcile`), and after 24h read the `health` block from `/api/live/stats`.

### 0. Pre-flight — everything must be green BEFORE deploying

Round J is proven against the Firestore emulator before it ships. Start the emulator with the **deployed rules**, run the three gated suites, then the default suites:

```bash
# 1. Firestore emulator, Native mode, with the rules that will be deployed
java -jar ~/.cache/firebase/emulators/cloud-firestore-emulator-v1.19.8.jar \
  --host 127.0.0.1 --port 8080 --project_id demo-apex \
  --rules ./firestore.rules --single_project_mode true

# 2. the emulator-gated suites (each SKIPS unless FIRESTORE_EMULATOR_HOST is set)
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-apex
npx jest tests/firestore-rules.test.js               # item 2 — rules
npx jest tests/live-shadow-counters-emulator.test.js # items 1-3,5 — counters, one-write, keys, reconcile
npx jest tests/live-shadow-e2e-emulator.test.js      # item 3 — real routes end to end

# 3. the default (file-backend) suites, incl. item 6
cd backend && npm test
```

- **Item 1 — startup guard.** Booting with `NODE_ENV=production` **and** `FIRESTORE_EMULATOR_HOST` set logs `[LIVE] REFUSING TO START …` and exits `1` (fail closed). Otherwise the boot logs the active backend: `[LIVE] store backend active {"backend":"firestore"|"file",…}`. **Never set `FIRESTORE_EMULATOR_HOST` in the deployed environment.**
- **Item 2 — rules.** `tests/firestore-rules.test.js` proves an unauthenticated **and** an authenticated client are denied read/write on `live_shadow/container/rows/*`, `live_shadow/meta`, `live_shadow/health` and `live_shadow/ledger` (and cannot smuggle a write through a batch), and that the existing `users` cases still pass. Requires `@firebase/rules-unit-testing`.
- **Item 3 — end to end.** `tests/live-shadow-e2e-emulator.test.js` drives the **real routes** on the emulator: `POST /api/live/sweep` (bearer secret) logs rows for live games; the games finish; a later sweep settles them; the process is restarted; `/api/live/stats` and the confirmation progress then report the right counts with **no duplicates** (`rows = counters = recount`).
- **Item 4 — SDK / platform.** Signed off against the versions in `backend/package.json`:

  | Component | Version | Why it matters |
  |---|---|---|
  | `firebase-admin` | `^13.6.0` (installed `13.6.0`) | Firebase Admin SDK (bypasses the security rules) |
  | `@google-cloud/firestore` | `7.11.6` (via firebase-admin) | `Query.count()` aggregation is present (`Query.prototype.count` is a function) — `reconcile()` relies on it |
  | `@firebase/rules-unit-testing` | `^6.0.0` (installed `6.0.0`, peer `firebase@13.3.0`) | The item-2 rules test |
  | Firestore emulator | `cloud-firestore-emulator-v1.19.8.jar` | Native mode (`--single_project_mode true`); `count()` works here |
  | `firebase-tools` | `14.12.0` | `firebase deploy --only firestore:rules` |
  | Node / npm | `v24.15.0` / `11.17.0` | Runtime |
  | Express | `5.2.1` | HTTP surface |

  The production database must be **Firestore Native mode** (not Datastore mode) and the service account must hold **Cloud Datastore User** (`roles/datastore.user`), which grants read/write to Firestore data — the least privilege that supports the Admin-SDK writes.
- **Item 5 — reconcile.** `POST /api/live/reconcile` (secret-gated like the sweep) recounts the rows and compares them to the counters, recording the result in the durable `health` document; `/api/live/stats` surfaces it and raises a `counter_drift` alert on any non-zero delta. A daily in-process cron (`0 3 * * *`) is a **backup only** — drive it from the external scheduler (step 2).
- **Item 6 — league labels.** `league_labels` is only written when a game is logged, so `labelFor` falls back to the **configured** league list (`CONFIG.matcher.sweep`); a sanitised key such as `soccer::uefa_champions` still displays as the exact code `soccer/uefa.champions` (covered in `tests/live-shadow-store.test.js`).

### 1. Environment variables (host → Environment)

| Variable | Value | Notes |
|---|---|---|
| `LIVE_STORE_KIND` | `firestore` | Selects the durable production backend. Anything else (or unset) = `file`, which does **not** survive an ephemeral disk. |
| `LIVE_STATS_SECRET` | a long random string, **≥ 24 characters** (`openssl rand -base64 32`) | The sweep/stats/reconcile key. Shorter than 24 → every request is refused `401` (fail closed). Never logged. `SETTLEMENT_CRON_SECRET` is accepted as a fallback. |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | the service-account JSON (one line) | Or place `./serviceAccountKey.json`. The Admin SDK bypasses the `live_shadow` security rule. The account needs **Cloud Datastore User**. |
| `NODE_ENV` | `production` | Anything else enables the test-isolation guard. Do **not** also set `FIRESTORE_EMULATOR_HOST` — the startup guard refuses to boot. |

Deploy the Firestore rules too (they deny all client access to `live_shadow`): `firebase deploy --only firestore:rules` with [firestore.rules](file:///c:/Users/prosp/Desktop/Apex/firestore.rules).

### 2. Trigger configuration

Create two external schedulers (cron-job.org or UptimeRobot "Cron Job") — see [Set up the external 5-minute trigger](#set-up-the-external-5-minute-trigger-free). Both use the same `Authorization: Bearer <LIVE_STATS_SECRET>` header:

- **Sweep** (every 5 minutes): `POST https://<your-service>.onrender.com/api/live/sweep`
- **Reconcile** (daily): `POST https://<your-service>.onrender.com/api/live/reconcile`

Smoke-test both once by hand before enabling the schedules:

```bash
# 1. can the deployment SEE games? (writes nothing)
curl -X POST -H "Authorization: Bearer <secret>" \
  "https://<your-service>.onrender.com/api/live/sweep?dry_run=true"
# expect {"dry_run":true,"would_log":N,...} with logged:0
# 2. real sweep
curl -X POST -H "Authorization: Bearer <secret>" \
  https://<your-service>.onrender.com/api/live/sweep
# expect {"live_games":N,"logged":M,"settled":K,"truncated":false}
# 3. reconcile — counters vs a recount of the rows
curl -X POST -H "Authorization: Bearer <secret>" \
  https://<your-service>.onrender.com/api/live/reconcile
# expect {"ok":true,"drift_detected":false,"total_rows":{"counters":R,"recount":R,...},...}
# a 401 means the header is missing/wrong, or the env secret is unset or < 24 chars.
```

### 3. Verify after 24 hours

```bash
curl -H "Authorization: Bearer <secret>" https://<your-service>.onrender.com/api/live/stats
```

Read the `health` block (all counts; no probability is exposed):

- **`health.storage`** — must report the `firestore` backend (confirms `LIVE_STORE_KIND` took effect).
- **`health.rows_last_24h`** — must be **> 0**. `0` means nothing was logged in the last day: check the trigger.
- **`health.daily_since_freeze`** — one line per UTC day (`{date, rows, games, settled_rows}`) since the candidate freeze. Non-empty and growing is the pipeline working.
- **`health.first_post_freeze_row`** — the exact instant the first post-freeze shadow row landed (`null` = logging has not started). Rows before it do not exist; nothing is backfilled.
- **`health.scheduler.alert`** — must be `{active: false, kind: null}`. An active alert is one of:
  - `counter_drift` — the durable counters disagree with a recount of the rows (a correctness fault; outranks the rest). Re-run `/api/live/reconcile` and inspect `health.scheduler.reconcile.drift`;
  - `never_ran` — the sweep has never completed;
  - `scheduler_stale` — the last sweep is older than `staleAfterMs` (default 15 min): the trigger is not firing;
  - `no_rows_while_live` — live games were seen but no shadow row has been logged for the alert window (default 6h).
- **`health.scheduler.reconcile`** — `{last_at, drift_detected, drift, source, last_error}`: the last reconcile's instant, whether it found drift, the drift itself (counts only) and any reconcile error. `last_at` should advance daily once the external reconcile is scheduled.

`health.cache_ttl_ms` reports how long those durable counts are reused (default 5000 ms); `health.scheduler.running` is the boolean "is the sweep ticking".


**If `rows_last_24h` is 0 but the trigger fires:** the store is probably still `file` (the ephemeral disk reset on the cold start) — set `LIVE_STORE_KIND=firestore`. A sweep interrupted by a caller timeout is safe to just re-run: its writes are idempotent, so the next sweep resumes without duplicates.

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
