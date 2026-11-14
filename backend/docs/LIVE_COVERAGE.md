# Live Game Analysis — coverage report (ESPN vs Pitch vs manual entry)

Which source supplies a live game, what it can and cannot provide, and what the
screen therefore shows. This is the source-of-truth for the coverage question;
the validation numbers live in [PHASE_5_LIVE_VALIDATION.md](PHASE_5_LIVE_VALIDATION.md).

## The three sources

| Source | Supplies | Live state it can provide | Data tier | May ship a live probability |
|---|---|---|---|---|
| **ESPN** (primary) | identity + live state | score, clock, period | `full_live` when score **and** clock (and, for basketball, a period ≥ 1) are present; otherwise `score_time_only` | only if that sport/league cleared the Phase 5 ship gate |
| **Pitch API** (soccer only, last resort) | identity (+ static score) | **none** — the normalizer hard-codes `clock: null, period: 0` | `score_time_only` at best | never (no clock → the model is `prior_only`, and the gate is the same) |
| **Manual entry** (user-typed) | whatever the user types | score, clock, period as typed | `user_entered` | **never** — `mayShipPick({ manual: true })` refuses first |

The link itself is only ever used to **identify** the game. It is never fetched
and never scraped for odds or stats; only the bookmaker hostname is counted
(non-personal stats).

## ESPN coverage (the two-season sweep, Phase 8)

`CONFIG.matcher.sweep` — most-likely leagues first. The Phase 8 sweep covers the
full 2025-26 **and** 2024-25 seasons for every basketball and soccer league, plus
dedicated May–Sep windows for the WNBA (whose season does not sit on the NBA/CBB
Oct–Apr calendar). Verified against live ESPN pulls by the Phase 5 replay over
**16,703 finished games** (11,707 scoreboard reads over 761 distinct days).

Basketball — 5,185 games:

| League | Season | Date range used | Games |
|---|---|---|---|
| `wnba` | 2024 | 2024-05-04 → 2024-10-21 | 275 |
| `wnba` | 2025 | 2025-05-02 → 2025-10-01 | 323 |
| `mens-college-basketball` | 2024-25 | 2024-10-22 → 2025-04-13 | 968 |
| `nba` | 2024-25 | 2024-10-22 → 2025-04-13 | 1,231 |
| `mens-college-basketball` | 2025-26 | 2025-10-21 → 2026-04-13 | 1,153 |
| `nba` | 2025-26 | 2025-10-21 → 2026-04-13 | 1,235 |

Soccer — 11,518 games (2024-25: 2024-08-02 → 2025-06-01; 2025-26: 2025-08-01 → 2026-05-31):

| League | 2024-25 | 2025-26 |
|---|---|---|
| `bra.1` | 293 | 402 |
| `eng.1` | 380 | 380 |
| `eng.2` | 557 | 557 |
| `esp.1` | 380 | 380 |
| `esp.2` | 454 | 462 |
| `ger.1` | 306 | 306 |
| `ger.2` | 306 | 306 |
| `ita.1` | 380 | 380 |
| `ita.2` | 387 | 390 |
| `mex.1` | 304 | 311 |
| `ned.1` | 309 | 309 |
| `por.1` | 306 | 306 |
| `sco.1` | 228 | 228 |
| `tur.1` | 340 | 306 |
| `uefa.champions` | 189 | 189 |
| `uefa.europa` | 189 | 189 |
| `usa.1` | 412 | 397 |

**Deliberately excluded:**
- **EuroLeague (`eur`)** — ESPN returns zero events for it.
- **French competitions** — excluded in `providers/normalizer` for product
  reasons, so sweeping them would only waste a request.

Both fall to manual entry.

## What each source can refresh

- **ESPN** is re-read on the `/analysis` poll via `matcher.refreshCandidate`
  (exact provider event id, 45 s TTL). This is why live data is fresh.
- **Pitch** has no refresh path — `refreshCandidate` is ESPN-only, and Pitch
  carries no clock/period anyway. A Pitch-identified game keeps its **last known
  state**, and the `freshness` block reports how old it is (a game is stale after
  120 s). Honest, not silently frozen.
- **Manual** games are never refreshed: they carry no provider id.

## Data tiers and trust

`CONFIG.liveModel.tierWeight` is how far the live estimate is trusted against the
pre-game prior (a lower tier is pulled back toward the prior rather than taken at
face value):

| Tier | Weight | Where it comes from |
|---|---|---|
| `full_live` | 1.0 | ESPN with score + clock (+ period for basketball) |
| `score_time_only` | 0.5 | Pitch; or ESPN missing a clock/period |
| `user_entered` | 0.35 | manual entry, **further** shrunk by `liveModel.manual.extraShrink` (×0.5) |

## What the screen shows, by source

- **ESPN `full_live`** — score, clock, context. A live probability is added **only**
  if the sport/league cleared the ship gate. The Phase 8 gate **passed for
  basketball** and **failed for soccer**, but `CONFIG.live.picks` is still empty
  for both sports, so **nothing ships a live probability yet** — both show
  score/time/context only. Phase 9 holds **basketball** in `CONFIG.live.shadow`:
  its live WINNER probability is computed and logged as evidence (timestamp,
  staleness, outcome) but withheld from every client — public and tester alike —
  because the leakage-free production column fails the ship gate's Brier-gain
  95 % CI clause by a rounding margin (its lower bound is `0`). Nothing is
  previewed to testers either. See the validation report.
- **Pitch / `score_time_only`** — score and context, labelled "Score and time
  only". No live-state model (no clock to read).
- **Manual** — score/clock/context as typed, always with the permanent
  *"User-entered, unverified"* badge, extra shrinkage, wider uncertainty, and
  excluded from every rate and from the backtest dataset.

## How to reproduce

```bash
cd backend

# Full two-season ESPN replay sweep (cached on disk, resumable)
node scripts/run-live-backtest.js \
  --concurrency=12 --max-games=100000 \
  --out=data/live-report-phase8.json > data/live-report-phase8.txt

# Unit evidence for tiers / sources / manual exclusions, plus the sweep planner
npx jest tests/live-game.test.js tests/live-matcher.test.js tests/live-backtest.test.js tests/live-dataset.test.js
```
