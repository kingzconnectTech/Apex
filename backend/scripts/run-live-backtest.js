#!/usr/bin/env node
/**
 * scripts/run-live-backtest.js
 *
 * Phase 5/8 — loads replay data and runs the live walk-forward backtest, then
 * prints the honest report produced by services/live/backtester.
 *
 * Data sources (in priority order):
 *   1. --dataset=<path.json>  A persisted replay dataset
 *      ({ "games": [ ... ] }, see services/live/replay.buildGameRecord).
 *   2. --synthetic[=N]        A deterministic, OFFLINE dataset for smoke-testing
 *      the harness end to end. It carries no learnable signal on purpose, so its
 *      verdict means only "the plumbing runs". Never quote its numbers as model
 *      quality — use ESPN history or a persisted dataset for that.
 *   3. default                On-the-fly load from ESPN history (finished games
 *      only), sweeping the full seasons in services/live/config.liveBacktest.seasons
 *      across the leagues in services/live/config.matcher.sweep.
 *
 * The sweep is polite and resumable: every scoreboard/summary response is cached
 * on disk (services/live/espnCache) and the outbound rate is throttled with
 * backoff, so an interrupted or repeated run does not re-download a completed
 * season. The cache directory is never committed (see .gitignore).
 *
 * ESPN replay inputs (verified against live pulls — see services/live/replay.js):
 *   - basketball summary.plays[]      homeScore, awayScore, period.number, clock.displayValue
 *   - soccer     summary.keyEvents[]  scoringPlay, team.id, clock.value, type.text, text
 * The pre-tip bookmaker line comes from summary.pickcenter[0] and is used ONLY
 * as an information-only benchmark; the live models never read it.
 *
 * Usage:
 *   node scripts/run-live-backtest.js --synthetic=200
 *   node scripts/run-live-backtest.js --sport=basketball --league=nba --dates=20260401-20260410 --max-games=40
 *   node scripts/run-live-backtest.js --sport=basketball --seasons=2025-26 --leagues=nba,wnba
 *   node scripts/run-live-backtest.js --dataset=data/live-replay.json --out=report.json
 *
 * NOTE ON SAMPLE SIZE: the ship gate counts GAMES (not checkpoint rows) and wants
 * >= 500 graded out-of-sample games, so the default is the full two-season sweep
 * below rather than a single day. Each finished basketball game yields ~11
 * checkpoints and each soccer game ~5, but those checkpoints share one outcome —
 * they do not buy extra evidence.
 */

const fs = require('fs');
const path = require('path');

const { runLiveBacktest, formatReport } = require('../services/live/backtester');
const { buildGameRecord, recordFromSummary } = require('../services/live/replay');
const { createCachedFetch } = require('../services/live/espnCache');
const LIVE_CONFIG = require('../services/live/config');

const { SportsDataService } = require('../services/SportsDataService');
const { EspnProvider } = require('../services/providers/EspnProvider');
const { sharedCache } = require('../services/providers/cache');
const { mapLimit } = require('../services/basketball/ingestion');

const BT = LIVE_CONFIG.liveBacktest;
const DATASET = BT.dataset;
// Cache dirs are configured relative to the backend directory.
const BACKEND_DIR = path.join(__dirname, '..');

/** Split a "a,b,c" CLI value into trimmed, non-empty tokens. */
function parseList(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Bound the provider's in-process response cache over a long sweep.
 *
 * `services/providers/cache.sharedCache` is unbounded: it keeps every upstream
 * body until its TTL lapses, which is right for a server but fatal for a
 * two-season replay (tens of thousands of large payloads -> heap exhaustion).
 * The sweep's own disk cache already makes a repeat read free, so flushing the
 * in-process layer costs no extra network traffic. Returns the (reset) counter.
 */
function makeCacheFlusher(every = DATASET.cacheFlushEvery) {
  let since = 0;
  return function noteRead() {
    if (!(every > 0)) return;
    if (++since >= every) { sharedCache.clear(); since = 0; }
  };
}

// --------------------------------------------------------------------------
// Date helpers
// --------------------------------------------------------------------------

function yyyymmdd(date) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** ESPN scoreboard date range covering the last `days` days (inclusive). */
function defaultDateRange(days = 3) {
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  return `${yyyymmdd(start)}-${yyyymmdd(end)}`;
}

// --------------------------------------------------------------------------
// Deterministic synthetic dataset (offline smoke test ONLY)
// --------------------------------------------------------------------------

/** mulberry32 — tiny deterministic PRNG. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A benchmark moneyline whose favourite is the side that actually won by more. */
function synthLine(edge, soccer) {
  const m = Math.min(320, Math.abs(edge) * 8);
  let home;
  let away;
  if (edge > 0) { home = -(100 + m); away = 100 + m; }
  else if (edge < 0) { home = 100 + m; away = -(100 + m); }
  else { home = -110; away = -110; }
  return {
    moneyline: soccer ? { home, away, draw: 230 } : { home, away },
    overUnder: soccer ? 2.5 : 220,
    overOdds: -110,
    underOdds: -110,
    spread: soccer ? null : -(edge),
    provider: 'synthetic',
  };
}

function synthBasketball(rand, i, kickoff) {
  const finalHome = 100 + Math.round(rand() * 35);
  const finalAway = 100 + Math.round(rand() * 35);
  const periods = 4;
  const periodMinutes = 12;
  const marks = BT.checkpoints.basketball.minutesRemaining;
  const checkpoints = [];
  for (let p = 1; p <= periods; p++) {
    marks.forEach(remaining => {
      if (remaining === 0 && p === periods) return; // final buzzer == the outcome
      const elapsed = (p - 1) * periodMinutes + (periodMinutes - remaining);
      const frac = elapsed / (periods * periodMinutes);
      checkpoints.push({
        label: remaining === 0 ? `p${p}_end` : `p${p}_${remaining}min_left`,
        period: p,
        clock: `${remaining}:00`,
        home_score: Math.floor(finalHome * frac),
        away_score: Math.floor(finalAway * frac),
      });
    });
  }
  return buildGameRecord({
    gameId: `SYN-B${i}`,
    sport: 'basketball',
    league: 'nba',
    kickoff,
    venue: 'Synthetic Arena',
    home: { teamId: `HB${i}`, name: `Home B${i}` },
    away: { teamId: `AB${i}`, name: `Away B${i}` },
    final: { home: finalHome, away: finalAway },
    line: synthLine(finalHome - finalAway, false),
    checkpoints,
  });
}

function synthSoccer(rand, i, kickoff) {
  const finalHome = Math.floor(rand() * 4);
  const finalAway = Math.floor(rand() * 4);
  const minutes = BT.checkpoints.soccer.minutes;
  const checkpoints = minutes.map(m => {
    const frac = m / 90;
    return {
      label: `m${m}`,
      period: m <= 45 ? 1 : 2,
      clock: `${m}'`,
      home_score: Math.floor(finalHome * frac),
      away_score: Math.floor(finalAway * frac),
    };
  });
  return buildGameRecord({
    gameId: `SYN-S${i}`,
    sport: 'soccer',
    league: 'eng.1',
    kickoff,
    venue: 'Synthetic Park',
    home: { teamId: `HS${i}`, name: `Home S${i}` },
    away: { teamId: `AS${i}`, name: `Away S${i}` },
    final: { home: finalHome, away: finalAway },
    line: synthLine(finalHome - finalAway, true),
    checkpoints,
  });
}

/**
 * Build a deterministic synthetic replay dataset. Offline: no network. The data
 * is deliberately signal-free, so it exercises the harness and nothing else.
 *
 * @param {Object} [opts]
 * @param {number} [opts.games=200]
 * @param {number} [opts.seed=17]
 */
function synthesizeDataset({ games = 200, seed = 17 } = {}) {
  const rand = mulberry32(seed);
  const base = Date.UTC(2024, 0, 1, 19, 0, 0);
  const out = [];
  for (let i = 0; i < games; i++) {
    const kickoff = new Date(base + i * 3600000).toISOString();
    out.push(i % 2 === 0 ? synthBasketball(rand, i, kickoff) : synthSoccer(rand, i, kickoff));
  }
  out.sort((a, b) => new Date(a.kickoff || 0) - new Date(b.kickoff || 0));
  return { games: out };
}

// --------------------------------------------------------------------------
// On-the-fly ESPN history loader
// --------------------------------------------------------------------------

/**
 * Expand a `--dates` value into individual YYYYMMDD days.
 *
 * ESPN's scoreboard takes ONE date, not a range: `?dates=20260401-20260412`
 * returns zero events (verified against the live endpoint). So a range is
 * expanded here and fetched one request per day.
 *
 * @param {string} dates   YYYYMMDD or YYYYMMDD-YYYYMMDD
 * @param {number} maxDays safety cap on how many days one range may expand to
 */
function expandDates(dates, maxDays = 45) {
  const s = String(dates || '').trim();
  const range = /^(\d{4})(\d{2})(\d{2})\s*-\s*(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!range) {
    const single = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    return single ? [s] : [];
  }
  const start = Date.UTC(Number(range[1]), Number(range[2]) - 1, Number(range[3]));
  const end = Date.UTC(Number(range[4]), Number(range[5]) - 1, Number(range[6]));
  if (!(start <= end)) return [];
  const out = [];
  for (let t = start; t <= end && out.length < maxDays; t += 86400000) {
    out.push(yyyymmdd(new Date(t)));
  }
  return out;
}

/**
 * Build the (sport, league, season, day) sweep plan.
 *
 * One entry per scoreboard read. `season` labels the range the day came from so
 * every record can be stamped with its provenance for the coverage report.
 * Days are de-duplicated: two overlapping seasons never fetch the same board
 * twice.
 *
 * @param {Object} args
 * @param {string[]} args.sports
 * @param {Object} args.sweep        { sport: [leagueCode, ...] }
 * @param {Object} [args.seasons]    { sport: [{ label, from, to }, ...] }
 * @param {string} [args.dates]      an explicit YYYYMMDD[-YYYYMMDD] override
 * @param {number} [args.maxDays]
 * @returns {Array<{sport,league,season,seasonFrom,seasonTo,day}>}
 */
function buildSweepTasks({ sports = [], sweep = {}, seasons = null, dates = null, maxDays = 400 } = {}) {
  const seasonList = seasons || BT.seasons || {};
  const out = [];
  const seen = new Set();

  (sports || []).forEach(sport => {
    const leagues = (sweep && sweep[sport]) || [];
    leagues.forEach(league => {
      const ranges = dates
        ? [{ label: 'custom', from: dates, to: dates }]
        : (seasonList[sport] || []);
      ranges.forEach(range => {
        // A range may be scoped to specific leagues (e.g. the WNBA's May–Sep
        // calendar, which the NBA/CBB window does not cover).
        if (Array.isArray(range.leagues) && !range.leagues.includes(league)) return;
        // `custom` already carries the exact ESPN date value the user typed
        // (a bare day OR a range); a configured season is always from-to.
        const source = range.label === 'custom'
          ? String(range.from)
          : `${range.from}-${range.to}`;
        expandDates(source, maxDays).forEach(day => {
          const key = `${sport}|${league}|${day}`;
          if (seen.has(key)) return;
          seen.add(key);
          out.push({
            sport, league, season: range.label, seasonFrom: range.from, seasonTo: range.to, day,
          });
        });
      });
    });
  });

  return out;
}

/** A scoreboard event whose competition has finished. */
function isFinished(ev) {
  const comp = ev && ev.competitions && ev.competitions[0];
  const state = comp && comp.status && comp.status.type && comp.status.type.state;
  return state === 'post';
}

/**
 * Finished events for one league on one day.
 *
 * Returns `null` when the scoreboard READ failed (the provider already retried)
 * and `[]` when the day genuinely had no games. The loader counts the nulls, so
 * a failed day is reported rather than silently looking like an empty one.
 */
async function fetchFinishedEvents(data, sport, league, date) {
  const board = await data.espn.getScoreboard(sport, league, { dates: date, limit: 200 });
  if (!board || board.error) return null;
  return ((board.events) || []).filter(isFinished);
}

/**
 * Load finished ESPN games into replay records, season by season.
 *
 * The sweep is cached and throttled (see services/live/espnCache): every
 * scoreboard/summary body is written to disk keyed by URL, so a second run — or
 * a run resumed after an interruption — costs nothing upstream. Pass
 * `cacheDir: null` to fetch directly (used by tests).
 *
 * @param {Object} [opts]
 * @param {string} [opts.dates]              YYYYMMDD or YYYYMMDD-YYYYMMDD (overrides seasons)
 * @param {Object} [opts.seasons]            { sport: [{ label, from, to }] }; defaults to config
 * @param {string[]} [opts.sports]           sports to sweep
 * @param {Object} [opts.sweep]              { sport: [leagueCode, ...] }; defaults to config
 * @param {number} [opts.maxEventsPerLeague] cap on games kept per (league, season)
 * @param {number} [opts.concurrency]        parallel scoreboard/summary fetches
 * @param {number} [opts.maxDays]            safety cap on one season's day expansion
 * @param {string|null} [opts.cacheDir]      on-disk cache dir; null disables caching
 * @param {Object} [opts.cache]              throttle/backoff overrides for the cache
 * @param {number} [opts.progressEvery]      emit a progress line every N boards
 * @param {Object} [opts.logger]
 * @returns {Promise<{games: Array, byLeague: Array, bySeason: Array, tasks: number, days: number, cache: Object|null}>}
 */
async function loadDatasetFromEspn({
  dates = null,
  seasons = null,
  sports = ['basketball', 'soccer'],
  sweep = LIVE_CONFIG.matcher.sweep,
  maxEventsPerLeague = DATASET.maxEventsPerLeague,
  concurrency = DATASET.concurrency,
  maxDays = 400,
  cacheDir = null,
  cache = null,
  progressEvery = 250,
  logger = null,
} = {}) {
  const tasks = buildSweepTasks({ sports, sweep, seasons, dates, maxDays });
  if (!tasks.length) {
    throw new Error(
      dates
        ? `unrecognised --dates "${dates}" (expected YYYYMMDD or YYYYMMDD-YYYYMMDD)`
        : 'no sweep tasks: check --sport/--league/--seasons against services/live/config.js',
    );
  }

  // A fetch that caches to disk and throttles the outbound rate. It is injected
  // into EspnProvider as its `fetchFn`, so the provider itself is unchanged.
  const fetchFn = cacheDir
    ? createCachedFetch({ cacheDir, logger, ...(cache || {}) })
    : null;
  const espnProvider = new EspnProvider({ logger, ...(fetchFn ? { fetchFn } : {}) });
  const data = new SportsDataService({ logger, espnProvider });

  // One scoreboard read per (league, day). ESPN caps a board at a single date.
  const noteProviderRead = makeCacheFlusher();
  let completed = 0;
  let boardsFailed = 0;
  const boardFailureSamples = [];
  const boards = await mapLimit(tasks, concurrency, t => (
    fetchFinishedEvents(data, t.sport, t.league, t.day)
      .catch(err => {
        if (boardFailureSamples.length < 10) {
          boardFailureSamples.push(`${t.sport}/${t.league} ${t.day}: ${(err && err.message) || 'read failed'}`);
        }
        return null;
      })
      .then(events => {
        noteProviderRead();
        // `null` is a failed read, `[]` a genuinely empty day. Count the former
        // so the report never quietly treats a missing day as "no games".
        if (events === null) boardsFailed++;
        completed++;
        if (progressEvery > 0 && completed % progressEvery === 0) {
          process.stderr.write(`[live-backtest] boards ${completed}/${tasks.length} (${boardsFailed} failed)\n`);
        }
        return events || [];
      })
  ));

  // Group finished events by (sport, league, season), de-duplicated by event id.
  const grouped = new Map();
  boards.forEach((events, i) => {
    if (!events || !events.length) return;
    const t = tasks[i];
    const key = `${t.sport}|${t.league}|${t.season}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        sport: t.sport,
        league: t.league,
        season: t.season,
        seasonFrom: t.seasonFrom,
        seasonTo: t.seasonTo,
        seen: new Set(),
        events: [],
      });
    }
    const g = grouped.get(key);
    events.forEach(ev => {
      const id = ev && ev.id != null ? String(ev.id) : null;
      if (!id || g.seen.has(id)) return;
      g.seen.add(id);
      g.events.push(ev);
    });
    // The board's events are now referenced by the group; release the raw slot
    // so a two-season sweep does not hold two copies of every fixture.
    boards[i] = null;
  });
  boards.length = 0;

  const games = [];
  const byLeague = [];
  const bySeason = new Map();
  let errored = 0;

  // Sequential across groups so a single league's progress line stays readable,
  // parallel within a group.
  for (const g of grouped.values()) {
    const picked = maxEventsPerLeague > 0 ? g.events.slice(0, maxEventsPerLeague) : g.events;
    const finished = g.events.length;
    const records = await mapLimit(picked, concurrency, async (ev) => {
      const summary = await data.espn.getMatchSummary(g.sport, g.league, ev.id);
      noteProviderRead();
      return recordFromSummary({
        sport: g.sport,
        league: g.league,
        event: ev,
        summary,
        meta: { season: g.season, seasonFrom: g.seasonFrom, seasonTo: g.seasonTo },
      });
    });
    const kept = records.filter(r => r && !r.error);
    errored += records.filter(r => r && r.error).length;
    if (kept.length) games.push(...kept);
    byLeague.push({
      sport: g.sport,
      league: g.league,
      season: g.season,
      finished,
      used: picked.length,
      records: kept.length,
    });
    const sKey = `${g.sport}|${g.season}`;
    bySeason.set(sKey, (bySeason.get(sKey) || 0) + kept.length);
    process.stderr.write(`[live-backtest] ${g.sport}/${g.league} ${g.season}: ${kept.length} replayable from ${picked.length} finished (of ${finished})\n`);
    // This group is done; drop its fixtures so the next league starts clean.
    g.events = [];
    g.seen.clear();
  }

  games.sort((a, b) => new Date(a.kickoff || 0) - new Date(b.kickoff || 0));
  return {
    games,
    byLeague,
    bySeason: [...bySeason.entries()].map(([key, count]) => {
      const [sport, season] = key.split('|');
      return { sport, season, games: count };
    }).sort((a, b) => (a.sport.localeCompare(b.sport) || String(a.season).localeCompare(String(b.season)))),
    tasks: tasks.length,
    days: new Set(tasks.map(t => t.day)).size,
    boardsFailed,
    boardFailures: boardFailureSamples,
    errored,
    cache: fetchFn ? fetchFn.stats : null,
  };
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  argv.forEach(a => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) { args._.push(a); return; }
    args[m[1]] = m[2] === undefined ? true : m[2];
  });
  return args;
}

/** Human-readable summary of what the sweep actually loaded. */
function summariseLoad(loaded) {
  const lines = [];
  lines.push(`sweep: ${loaded.tasks} scoreboard reads over ${loaded.days} distinct days`);
  const bySeason = [...(loaded.bySeason || [])].sort((a, b) => a.sport.localeCompare(b.sport));
  bySeason.forEach(s => lines.push(`  ${s.sport.padEnd(11)} ${String(s.season).padEnd(9)} ${String(s.games).padStart(5)} games`));
  const byLeague = [...(loaded.byLeague || [])].sort((a, b) => (
    a.sport.localeCompare(b.sport) || String(a.season).localeCompare(String(b.season)) || String(a.league).localeCompare(String(b.league))
  ));
  byLeague.forEach(l => lines.push(`  ${l.sport.padEnd(11)} ${String(l.season).padEnd(9)} ${String(l.league).padEnd(22)} ${String(l.records).padStart(5)} games`));
  if (loaded.boardsFailed) {
    lines.push(`  ${loaded.boardsFailed} scoreboard read(s) failed and were treated as empty days`);
    (loaded.boardFailures || []).slice(0, 3).forEach(s => lines.push(`      e.g. ${s}`));
  }
  if (loaded.errored) lines.push(`  ${loaded.errored} summary record(s) failed and were skipped`);
  if (loaded.cache) {
    const c = loaded.cache;
    lines.push(`cache: ${c.hits} hits, ${c.misses} misses, ${c.fetches} fetched, ${c.errors} errors`);
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let dataset;
  let source;
  let loadSummary = null;

  if (args.dataset) {
    dataset = JSON.parse(fs.readFileSync(path.resolve(String(args.dataset)), 'utf8'));
    source = `persisted dataset ${args.dataset}`;
  } else if (args.synthetic) {
    const n = args.synthetic === true ? 200 : parseInt(args.synthetic, 10) || 200;
    dataset = synthesizeDataset({ games: n });
    source = `synthetic (${n} games) — plumbing smoke test, NOT evidence`;
  } else {
    const sports = args.sport ? parseList(args.sport) : ['basketball', 'soccer'];
    const seasonFilter = args.seasons ? parseList(args.seasons) : null;

    const sweep = {};
    sports.forEach(s => {
      const all = LIVE_CONFIG.matcher.sweep[s] || [];
      sweep[s] = args.league ? parseList(args.league) : all;
    });

    // Default to the full configured seasons; --seasons= filters by label.
    const seasons = {};
    sports.forEach(s => {
      const list = BT.seasons[s] || [];
      seasons[s] = seasonFilter ? list.filter(x => seasonFilter.includes(x.label)) : list;
    });

    const cacheDir = args.cache === 'off' ? null : path.join(BACKEND_DIR, DATASET.cacheDir);
    const loaded = await loadDatasetFromEspn({
      dates: args.dates ? String(args.dates) : null,
      seasons,
      sports,
      sweep,
      maxEventsPerLeague: parseInt(args['max-games'], 10) || DATASET.maxEventsPerLeague,
      concurrency: parseInt(args.concurrency, 10) || DATASET.concurrency,
      maxDays: parseInt(args['max-days'], 10) || 400,
      cacheDir,
      cache: {
        minIntervalMs: parseInt(args['min-interval'], 10) || DATASET.minIntervalMs,
        retries: DATASET.retries,
        backoffMs: DATASET.backoffMs,
        timeoutMs: DATASET.requestTimeoutMs,
      },
    });
    dataset = { games: loaded.games };
    loadSummary = summariseLoad(loaded);
    source = args.dates
      ? `ESPN history ${args.dates}`
      : `ESPN history, seasons ${Object.values(seasons).flat().map(s => s.label).join(', ') || 'default'}`;
  }

  if (!dataset || !Array.isArray(dataset.games) || !dataset.games.length) {
    console.error('No games to backtest. Use --synthetic[=N], --dataset=<file>, or the ESPN sweep (see --help notes in the header).');
    process.exit(1);
  }

  const report = runLiveBacktest(dataset, {});
  console.log(`Source: ${source}\n`);
  if (loadSummary) console.log(`${loadSummary}\n`);
  console.log(formatReport(report));

  if (args.out) {
    fs.writeFileSync(path.resolve(String(args.out)), JSON.stringify(report, null, 2));
    console.log(`\nWrote JSON report to ${args.out}`);
  }
}

module.exports = {
  yyyymmdd,
  defaultDateRange,
  parseList,
  makeCacheFlusher,
  mulberry32,
  synthesizeDataset,
  expandDates,
  buildSweepTasks,
  isFinished,
  fetchFinishedEvents,
  loadDatasetFromEspn,
  summariseLoad,
  parseArgs,
};

if (require.main === module) {
  main().catch(err => {
    console.error('Live backtest failed:', (err && err.stack) || (err && err.message) || err);
    process.exit(1);
  });
}
