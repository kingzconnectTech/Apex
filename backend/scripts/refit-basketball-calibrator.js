#!/usr/bin/env node
/**
 * scripts/refit-basketball-calibrator.js
 *
 * Refits the basketball probability calibrators from PRIOR-SEASON box scores and
 * reports whether they are worth applying.
 *
 * Data pipeline (all verified against ESPN by live probe — no field is assumed):
 *   - game list   : site API `teams/{id}/schedule?season=YYYY` (ENDING-year
 *                   labelling: 2026 => the 2025-26 season). Schedule events carry
 *                   scores but NO statistics.
 *   - box scores  : site API `summary?event={id}` -> `boxscore.teams[].statistics`
 *                   (compound names such as `fieldGoalsMade-fieldGoalsAttempted`).
 *                   The scoreboard's per-team stats are NOT sufficient: they omit
 *                   offensiveRebounds / turnovers / steals / blocks / fouls, which
 *                   possessions (and therefore every rating) depends on.
 *   - lines       : `summary.pickcenter[0]`, the only line ESPN exposes for a
 *                   completed game. It is the CLOSING snapshot (`open` is null for
 *                   finished games), so it is a proxy for, not identical to, the
 *                   pre-game line we publish against. `--no-odds` refits on
 *                   model-generated lines instead, which uses no market data at all.
 *
 * No leakage: the engine is driven through the walk-forward harness, so each game
 * is projected from games that tipped off strictly earlier.
 *
 * Validation gate: the calibrator is fitted on the earlier part of the data and
 * only saved when it beats the identity (raw probability) on the most recent
 * holdout in BOTH Brier score and log loss. Otherwise the script writes nothing
 * and the engine keeps using raw probabilities.
 *
 * Usage:
 *   node scripts/refit-basketball-calibrator.js --league=nba --seasons=2025,2026
 *   node scripts/refit-basketball-calibrator.js --no-odds --holdout=0.25 --out=report.json
 *   node scripts/refit-basketball-calibrator.js --max-games=200 --no-write   # smoke test
 *
 * The dataset is cached per (league, season) under the OS temp dir, so re-runs and
 * threshold experiments do not refetch ~1,240 games per season. `--refresh` rebuilds.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { EspnProvider } = require('../services/providers/EspnProvider');
const { getLeagueConfig } = require('../services/basketball/leagues');
const { mapLimit } = require('../services/basketball/ingestion');
const { evaluate } = require('../services/basketball/backtester');
const {
  Calibrator, canonicalizeRows, validateAgainstIdentity, brierScore, logLoss, calibrationCurve,
} = require('../services/basketball/calibration');
const { buildCalibratorDoc, saveCalibrator, loadSettled } = require('../services/basketball/persistence');
const CONFIG = require('../services/basketball/config');

const SITE_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const BUCKET_EDGES = [0.50, 0.55, 0.60, 0.65, 0.70, 1.01];
const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), 'apex-calib');

// --------------------------------------------------------------------------
// ESPN fetch helpers (raw HTTP: these endpoints are not all exposed by the provider)
// --------------------------------------------------------------------------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, { attempts = 3, timeoutMs = 20000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === attempts - 1) return null;
      await sleep(500 * (attempt + 1));
    }
  }
  return null;
}

function _num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

function _scoreOf(competitor) {
  const raw = competitor?.score;
  if (raw && typeof raw === 'object') return _num(raw.value ?? raw.displayValue);
  return _num(raw);
}

/** Team ids for a league (site API teams list). */
async function listTeamIds(espnPath) {
  const data = await fetchJson(`${SITE_BASE}/${espnPath}/teams?limit=200`);
  const list = data?.sports?.[0]?.leagues?.[0]?.teams || data?.teams || [];
  return list.map(t => String(t?.team?.id ?? t?.id ?? '')).filter(Boolean);
}

/** Completed games for one season: ids, tipoffs, venues, teams and scores. */
async function collectSeasonGames({ espnPath, seasonYear, concurrency = 6, logger = null }) {
  const teamIds = await listTeamIds(espnPath);
  if (!teamIds.length) return [];
  if (logger) logger(`teams found: ${teamIds.length}`);

  const byEvent = new Map();
  await mapLimit(teamIds, concurrency, async (teamId) => {
    const sched = await fetchJson(`${SITE_BASE}/${espnPath}/teams/${teamId}/schedule?season=${seasonYear}`);
    (sched?.events || []).forEach(ev => {
      const comp = ev?.competitions?.[0];
      if (!comp || comp.status?.type?.state !== 'post') return;
      const id = String(ev.id || '');
      if (!id || byEvent.has(id)) return;
      const home = (comp.competitors || []).find(c => c.homeAway === 'home');
      const away = (comp.competitors || []).find(c => c.homeAway === 'away');
      if (!home?.team?.id || !away?.team?.id) return;
      byEvent.set(id, {
        gameId: id,
        tipoff: ev.date || comp.date || null,
        venue: comp.venue?.fullName || null,
        home: { teamId: String(home.team.id), name: home.team.displayName || null, score: _scoreOf(home) },
        away: { teamId: String(away.team.id), name: away.team.displayName || null, score: _scoreOf(away) },
        seasonYear,
      });
    });
  });

  return [...byEvent.values()].sort((a, b) => new Date(a.tipoff) - new Date(b.tipoff));
}

/**
 * Attach real box scores (and, optionally, the market line) to each game.
 * A game whose box score cannot be read is DROPPED — a stat-less game would be
 * rated off league means and would poison the calibration.
 */
async function attachBoxScores(games, { espnPath, concurrency = 6, withOdds = true, logger = null } = {}) {
  let dropped = 0;
  const out = await mapLimit(games, concurrency, async (g) => {
    const sum = await fetchJson(`${SITE_BASE}/${espnPath}/summary?event=${g.gameId}`);
    const teams = sum?.boxscore?.teams || [];
    if (teams.length < 2) { dropped++; return null; }
    const h = teams.find(t => t.homeAway === 'home') || teams[0];
    const a = teams.find(t => t.homeAway === 'away') || teams[1];
    const homeStats = EspnProvider.extractBasketballBoxScore(h, a);
    const awayStats = EspnProvider.extractBasketballBoxScore(a, h);
    // Possessions need fga, orb, tov and fta; without them every rating collapses.
    const usable = (s) => s && s.fga != null && s.orb != null && s.tov != null && s.fta != null;
    if (!usable(homeStats) || !usable(awayStats)) { dropped++; return null; }

    const headerComps = sum?.header?.competitions?.[0]?.competitors || [];
    const headerScore = (teamId) => _scoreOf(headerComps.find(c => String(c?.team?.id) === String(teamId)));
    const homeScore = g.home.score ?? headerScore(g.home.teamId);
    const awayScore = g.away.score ?? headerScore(g.away.teamId);
    if (homeScore == null || awayScore == null) { dropped++; return null; }

    const odds = withOdds ? EspnProvider.extractBasketballOdds(sum) : null;
    const market = odds ? {
      total: _num(odds.overUnder),
      overOdds: _num(odds.overOdds),
      underOdds: _num(odds.underOdds),
      spread: _num(odds.spread),
      homeOdds: _num(odds.homeSpreadOdds),
      awayOdds: _num(odds.awaySpreadOdds),
    } : null;
    const hasMarket = market && market.total != null && market.spread != null;

    return {
      ...g,
      home: { ...g.home, score: homeScore, stats: homeStats },
      away: { ...g.away, score: awayScore, stats: awayStats },
      odds: hasMarket ? market : null,
      // ESPN exposes no opening line for a finished game; the same snapshot is
      // recorded as `closing` so CLV is reported as uninformative (and labelled).
      closing: hasMarket ? market : null,
    };
  });

  if (logger && dropped) logger(`dropped ${dropped} games with unreadable box scores`);
  return out.filter(Boolean);
}

/** Build (or load from cache) one season's dataset. */
async function loadSeasonDataset({ leagueCfg, seasonYear, cacheDir, refresh = false, concurrency = 6, maxGames = null, withOdds = true, logger = null }) {
  const [sport, league] = String(leagueCfg.espnPath).split('/');
  const espnPath = `${sport}/${league}`;
  const cacheFile = path.join(cacheDir, `bbcal-${leagueCfg.key}-${seasonYear}${withOdds ? '' : '-noodds'}.json`);
  const fullCacheFile = path.join(cacheDir, `bbcal-${leagueCfg.key}-${seasonYear}.json`);

  const readCache = (file) => {
    if (refresh || !fs.existsSync(file)) return null;
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      return cached?.games?.length ? cached.games : null;
    } catch (err) {
      if (logger) logger(`cache unreadable (${err.message}); rebuilding`);
      return null;
    }
  };

  // A `--no-odds` refit needs no new fetch: strip the lines out of the odds cache.
  // This also makes the strict no-market-data run cheap to compare against.
  let cachedGames = readCache(cacheFile);
  let reusedAs = cacheFile;
  if (!cachedGames && !withOdds) {
    const full = readCache(fullCacheFile);
    if (full) { cachedGames = full.map(g => ({ ...g, odds: null, closing: null })); reusedAs = fullCacheFile; }
  }
  if (cachedGames) {
    const games = maxGames ? cachedGames.slice(-maxGames) : cachedGames;
    if (logger) logger(`cache hit ${path.basename(reusedAs)}: ${cachedGames.length} games (using ${games.length})`);
    return { league: leagueCfg.key, seasonYear, games, cached: true };
  }

  if (logger) logger(`fetching season ${seasonYear} game list ...`);
  const listed = await collectSeasonGames({ espnPath, seasonYear, concurrency, logger });
  const selected = maxGames ? listed.slice(-maxGames) : listed;
  if (logger) logger(`season ${seasonYear}: ${listed.length} completed games, analysing ${selected.length}`);

  const games = await attachBoxScores(selected, { espnPath, concurrency, withOdds, logger });

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({
    league: leagueCfg.key, seasonYear, builtAt: new Date().toISOString(), withOdds, games,
  }));
  if (logger) logger(`wrote ${path.basename(cacheFile)} (${games.length} games)`);

  return { league: leagueCfg.key, seasonYear, games, cached: false };
}

// --------------------------------------------------------------------------
// Evaluation helpers
// --------------------------------------------------------------------------

/**
 * Backtest rows carry the raw probability as `pRaw`; the calibration API speaks
 * rows shaped `{ p, y, side }`. Convert at the boundary so the library contract
 * stays clean.
 */
function toCalRows(rows) {
  return rows
    .filter(r => Number.isFinite(r.pRaw) && r.market && r.side)
    .map(r => ({ p: r.pRaw, y: r.y, side: r.side }));
}

/** Score rows with an arbitrary probability function (side-aware). */
function scoreRows(rows, predict) {
  const graded = rows.filter(r => r.y === 0 || r.y === 1);
  const scored = graded.map(r => ({ p: predict(r), y: r.y }));
  const n = scored.length;
  const hits = scored.filter(r => r.y === 1).length;
  const avgPredicted = n ? scored.reduce((s, r) => s + r.p, 0) / n : null;
  return {
    n,
    hits,
    hitRate: n ? Number((hits / n).toFixed(4)) : null,
    avgPredicted: avgPredicted == null ? null : Number(avgPredicted.toFixed(4)),
    gap: (n && avgPredicted != null) ? Number((hits / n - avgPredicted).toFixed(4)) : null,
    brier: n ? Number(brierScore(scored).toFixed(4)) : null,
    logLoss: n ? Number(logLoss(scored).toFixed(4)) : null,
    buckets: calibrationCurve(scored, BUCKET_EDGES)
      .map(b => ({
        range: b.range,
        n: b.n,
        predicted: b.predicted == null ? null : Number(b.predicted.toFixed(4)),
        actual: b.actual == null ? null : Number(b.actual.toFixed(4)),
      })),
  };
}

/** Chronological split on whole games, so a game's picks never straddle the split. */
function splitHoldout(rows, holdoutFraction) {
  const ordered = rows
    .filter(r => r.tipoff)
    .slice()
    .sort((a, b) => new Date(a.tipoff) - new Date(b.tipoff));
  const games = [];
  const seen = new Set();
  ordered.forEach(r => { if (!seen.has(r.gameId)) { seen.add(r.gameId); games.push(r.gameId); } });
  if (!games.length) return { train: [], holdout: [] };

  const cutIndex = Math.max(1, Math.min(games.length - 1, Math.floor(games.length * (1 - holdoutFraction))));
  const cutoffGame = games[cutIndex] ?? null;
  const cutoffTs = cutoffGame
    ? new Date(ordered.find(r => r.gameId === cutoffGame).tipoff).getTime()
    : Infinity;

  const train = [];
  const holdout = [];
  ordered.forEach(r => (new Date(r.tipoff).getTime() < cutoffTs ? train : holdout).push(r));
  return { train, holdout, cutoff: cutoffGame ? new Date(cutoffTs).toISOString() : null };
}

/**
 * Legacy per-side fit, reproduced only to answer "what does the current
 * Calibrator do with the other side?". Fitting Over and Under (or home and away)
 * independently lets each side be calibrated to its own curve, so the two sides
 * of one line no longer sum to 1.
 */
function legacyPerSideFit(league, markets, trainRows, holdoutRows, cfg) {
  const keys = {
    'Total Points': ['total_over', 'total_under'],
    Spread: ['spread_home', 'spread_away'],
  };
  const cal = new Calibrator(cfg);
  const fit = {};
  markets.forEach(market => {
    keys[market].forEach(key => {
      const side = key.endsWith('_over') || key.endsWith('_home') ? 'a' : 'b';
      const rows = trainRows
        .filter(r => r.market === market && r.side === side)
        .map(r => ({ p: r.pRaw, y: r.y }))
        .filter(r => r.y === 0 || r.y === 1);
      const model = cal.fit(league, key, rows);
      fit[key] = { side, trainRows: rows.length, fitted: Boolean(model), samples: model?.samples ?? null };
    });
  });

  const keyFor = (r) => (r.market === 'Total Points'
    ? (r.side === 'a' ? 'total_over' : 'total_under')
    : (r.side === 'a' ? 'spread_home' : 'spread_away'));

  return {
    fit,
    apply: (r) => cal.apply(league, keyFor(r), r.pRaw),
    has: (r) => cal.has(league, keyFor(r)),
  };
}

// --------------------------------------------------------------------------
// Report
// --------------------------------------------------------------------------

const pct = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
const f4 = (v) => (v == null ? 'n/a' : Number(v).toFixed(4));

function fmtBuckets(buckets) {
  const filled = buckets.filter(b => b.n > 0);
  if (!filled.length) return '      (no rows in any bucket)';
  return filled
    .map(b => `      ${b.range}: n=${String(b.n).padStart(4)} stated ${pct(b.predicted)} actual ${pct(b.actual)}`)
    .join('\n');
}

function fmtBlock(label, m) {
  return [
    `  ${label}`,
    `    n ${m.n}  hit ${pct(m.hitRate)}  stated ${pct(m.avgPredicted)}  gap ${m.gap == null ? 'n/a' : `${(m.gap * 100).toFixed(1)}pp`}`,
    `    Brier ${f4(m.brier)}  log loss ${f4(m.logLoss)}`,
    fmtBuckets(m.buckets),
  ].join('\n');
}

function describeMarket({ league, market, trainRows, holdoutRows, fitted, validation, calibration, legacy }) {
  const before = scoreRows(holdoutRows, r => r.pRaw);
  const after = scoreRows(holdoutRows, r => calibration.apply(league, market, r.pRaw, r.side));
  const legacyMetrics = legacy ? scoreRows(holdoutRows.filter(legacy.has), legacy.apply) : null;

  // Two-way consistency. The backtester records only the side the engine picked,
  // so we pair each holdout pick with its MIRROR — the opposite side of the same
  // game/line at the complementary raw probability — and check the pair sums to 1.
  //   canonical: f(p) + [1 - f(1 - (1-p))] = f(p) + 1 - f(p) = 1 exactly
  //   legacy   : Over and Under are fitted independently, so the pair drifts
  const sums = { raw: [], canonical: [], legacy: [] };
  holdoutRows.forEach(r => {
    if (!Number.isFinite(r.pRaw)) return;
    const mirror = { ...r, side: r.side === 'a' ? 'b' : 'a', pRaw: 1 - r.pRaw };
    sums.raw.push(r.pRaw + mirror.pRaw);
    sums.canonical.push(
      calibration.apply(league, market, r.pRaw, r.side)
      + calibration.apply(league, market, mirror.pRaw, mirror.side),
    );
    if (legacy && legacy.has(r) && legacy.has(mirror)) sums.legacy.push(legacy.apply(r) + legacy.apply(mirror));
  });
  const dev = (arr) => (arr.length ? Number(Math.max(...arr.map(v => Math.abs(v - 1))).toFixed(6)) : null);

  // Calibration by line type: main vs alternate lines can sit on different curves.
  const byLineType = ['main', 'alternate'].map(t => {
    const sel = holdoutRows.filter(r => (t === 'main' ? r.isMain !== false : r.isMain === false));
    return {
      type: t,
      n: sel.length,
      graded: sel.filter(r => r.y === 0 || r.y === 1).length,
      before: scoreRows(sel, r => r.pRaw),
      after: scoreRows(sel, r => calibration.apply(league, market, r.pRaw, r.side)),
    };
  });

  const dates = holdoutRows.map(r => r.tipoff).filter(Boolean).sort();

  return {
    league, market,
    train: { n: trainRows.length, graded: trainRows.filter(r => r.y === 0 || r.y === 1).length },
    holdout: {
      n: holdoutRows.length,
      graded: before.n,
      from: dates[0] || null,
      to: dates[dates.length - 1] || null,
    },
    fitted: {
      has: Boolean(fitted),
      samples: fitted?.samples ?? null,
      method: fitted?.method ?? null,
    },
    validation,
    before,
    after,
    legacy: legacyMetrics,
    legacyFit: legacy?.fit || null,
    byLineType,
    twoWay: {
      pairs: sums.raw.length,
      maxDeviationRaw: dev(sums.raw),
      maxDeviationCanonical: dev(sums.canonical),
      maxDeviationLegacy: dev(sums.legacy),
    },
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

function fmtLiveRows(rows) {
  return rows.map(r => ({
    tipoff: r.tipoff, gameId: r.gameId, market: r.market, side: r.side, line: r.line,
    pRaw: r.pRaw, y: r.y,
  }));
}

/** Best-effort load of live settled picks; never fatal. */
async function loadLiveRows(log) {
  let admin;
  try {
    admin = require('firebase-admin');
    if (!admin.apps || admin.apps.length === 0) {
      if (typeof admin.initializeApp === 'function' && process.env.GOOGLE_APPLICATION_CREDENTIALS) admin.initializeApp();
    }
    if (!admin.apps || admin.apps.length === 0) { log('live rows: 0 (firebase-admin not initialised)'); return []; }
    const docs = await loadSettled(admin, { limit: 2000 });
    log(`live rows: ${docs.length}`);
    return docs.map(d => ({
      league: d.league, market: d.market, side: d.side, line: d.line, tipoff: d.tipoff,
      gameId: d.gameId, pRaw: d.probability, isMain: d.isMain !== false,
      y: d.outcome === 'push' ? null : (d.outcome === 'won' ? 1 : 0),
      live: true,
    }));
  } catch (err) {
    log(`live rows: 0 (${err.message})`);
    return [];
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const leagueKey = args.league || 'nba';
  const leagueCfg = getLeagueConfig(leagueKey);
  const seasons = String(args.seasons || '2026').split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
  const cacheDir = args.cache ? path.resolve(args.cache) : DEFAULT_CACHE_DIR;
  const holdout = args.holdout ? parseFloat(args.holdout) : 0.25;
  const concurrency = parseInt(args.concurrency, 10) || 6;
  const maxGames = args['max-games'] ? parseInt(args['max-games'], 10) : null;
  const withOdds = args['no-odds'] !== true;
  const minSamples = args['min-samples'] ? parseInt(args['min-samples'], 10) : (CONFIG.calibration?.minSamples ?? 150);
  const method = args.method || CONFIG.calibration.method || 'isotonic';
  const gateOpts = {
    minSamples: args['min-holdout'] ? parseInt(args['min-holdout'], 10) : (CONFIG.calibration?.minHoldout ?? minSamples),
    minImprovementBrier: CONFIG.calibration?.minImprovementBrier ?? 0.002,
    minImprovementLogLoss: CONFIG.calibration?.minImprovementLogLoss ?? 0.002,
    requireMonotone: CONFIG.calibration?.requireMonotone !== false,
  };
  const log = (msg) => process.stderr.write(`[refit] ${msg}\n`);

  const parts = [];
  for (const seasonYear of seasons) {
    // eslint-disable-next-line no-await-in-loop
    const part = await loadSeasonDataset({
      leagueCfg, seasonYear, cacheDir, refresh: !!args.refresh, concurrency, maxGames, withOdds, logger: log,
    });
    if (part.games.length) parts.push(part);
  }
  const games = parts.flatMap(p => p.games).sort((a, b) => new Date(a.tipoff) - new Date(b.tipoff));
  if (!games.length) {
    console.error('No games with usable box scores — nothing to fit.');
    process.exit(1);
  }

  const dataset = { league: leagueCfg.key, games };
  log(`walk-forward over ${games.length} games (${games[0].tipoff} -> ${games[games.length - 1].tipoff})`);
  const ev = evaluate(dataset, { calibrate: false, cfg: CONFIG });

  const rows = ev.rows.filter(r => Number.isFinite(r.pRaw) && r.market && r.side);
  const liveRows = args['with-live'] ? await loadLiveRows(log) : [];
  const allRows = rows.concat(liveRows.filter(r => r.league === leagueCfg.key && Number.isFinite(r.pRaw)));

  const { train, holdout: testRows, cutoff } = splitHoldout(allRows, holdout);
  const gradedTrain = train.filter(r => r.y === 0 || r.y === 1).length;
  log(`train ${train.length} rows (graded ${gradedTrain}) | holdout ${testRows.length} rows | split at ${cutoff}`);

  const markets = ['Total Points', 'Spread'];
  const calibration = new Calibrator(CONFIG);
  const validation = {};
  const perMarket = [];

  markets.forEach(market => {
    const tr = train.filter(r => r.market === market);
    const te = testRows.filter(r => r.market === market);
    const fitted = calibration.fitTwoWay(leagueCfg.key, market, toCalRows(tr), { minSamples, method });
    const gate = validateAgainstIdentity({ rows: toCalRows(te), model: fitted, ...gateOpts });
    validation[market] = gate;
    // Same minSamples as the canonical fit so the two are comparable.
    const legacyCfg = { ...CONFIG, calibration: { ...CONFIG.calibration, minSamples } };
    const legacy = legacyPerSideFit(leagueCfg.key, [market], tr, te, legacyCfg);
    perMarket.push(describeMarket({
      league: leagueCfg.key, market, trainRows: tr, holdoutRows: te,
      fitted, validation: gate, calibration, legacy,
    }));
  });

  const accepted = markets.filter(m => validation[m]?.improved === true && calibration.has(leagueCfg.key, m));
  const training = {
    rows: allRows.length,
    from: allRows.map(r => r.tipoff).filter(Boolean).sort()[0] || null,
    to: allRows.map(r => r.tipoff).filter(Boolean).sort().slice(-1)[0] || null,
    seasons,
  };
  const doc = buildCalibratorDoc({
    league: leagueCfg.key,
    calibrator: calibration,
    validation,
    markets,
    oddsSource: withOdds ? 'closing-snapshot' : 'model-lines',
    training,
  });

  // ---- Report ----
  const out = [];
  out.push(`# Basketball calibrator refit — ${leagueCfg.label} (${leagueCfg.key})`);
  out.push(`generated ${new Date().toISOString()}`);
  out.push('');
  out.push('## Data');
  parts.forEach(p => out.push(`  season ${p.seasonYear}: ${p.games.length} usable games${p.cached ? ' (cached)' : ''}`));
  out.push(`  games analysed: ${ev.games}   picks: ${ev.picks}   games without a pick: ${ev.noPickGames}   missing odds: ${ev.missingOdds}`);
  out.push(`  walk-forward window: ${games[0].tipoff} -> ${games[games.length - 1].tipoff}`);
  out.push(`  lines valued from: ${withOdds ? 'ESPN pickcenter closing snapshot (proxy for the pre-game line)' : 'model-generated lines (no market data)'}`);
  out.push(`  calibration method: ${method}   gate: min holdout ${gateOpts.minSamples} rows, >= ${gateOpts.minImprovementBrier} Brier AND >= ${gateOpts.minImprovementLogLoss} log loss, monotone ${gateOpts.requireMonotone ? 'required' : 'not required'}`);
  if (liveRows.length) out.push(`  live settled rows appended: ${liveRows.length}`);
  out.push(`  train rows ${train.length} (graded ${gradedTrain}) -> holdout rows ${testRows.length} starting ${cutoff || 'n/a'}`);
  out.push(`  residual sd (all graded games): total ${f4(ev.sigma.total)} (n=${ev.residuals.total.length}), margin ${f4(ev.sigma.margin)} (n=${ev.residuals.margin.length})`);
  out.push('');

  out.push('## Data provenance / leakage');
  out.push('  RATINGS: walk-forward only — a team is rated solely from games that tipped off');
  out.push('  strictly earlier than the game being predicted. Box scores come from');
  out.push('  summary?event=, the only endpoint carrying offensiveRebounds / turnovers, without');
  out.push('  which possessions (and therefore every rating) cannot be computed.');
  if (withOdds) {
    out.push('  LINES: ESPN publishes no opening line for a finished game — only the closing');
    out.push('  snapshot (pickcenter[0]; `open` is null). It is used as the line the pick is');
    out.push('  struck at, exactly as the live engine uses the pre-tip-off line, so it is a PROXY:');
    out.push('  a pick selected at the close could not have been selected pre-tip-off at that');
    out.push('  exact number. Re-run with --no-odds to remove market data from the fit entirely.');
  } else {
    out.push('  LINES: none. Picks are struck on model-generated lines (0.5 off the projection),');
    out.push('  so no market information — opening or closing — reaches the model.');
  }
  out.push('  CALIBRATOR: fitted on the earlier part of the walk-forward only; the holdout is');
  out.push('  untouched by the fit and is what the validation gate is judged on.');
  out.push('');

  const lineTypes = ['main', 'alternate'];
  out.push('## Line types present');
  lineTypes.forEach(t => {
    const sel = allRows.filter(r => (t === 'main' ? r.isMain !== false : r.isMain === false));
    out.push(`  ${t}: ${sel.length} rows across ${new Set(sel.map(r => r.gameId)).size} games`);
  });
  out.push('');

  perMarket.forEach(m => {
    out.push(`## ${m.market} — ${m.league}`);
    out.push(`  train rows ${m.train.n} (graded ${m.train.graded})   holdout rows ${m.holdout.n} (graded ${m.holdout.graded})`);
    out.push(`  holdout date range: ${m.holdout.from || 'n/a'} -> ${m.holdout.to || 'n/a'}`);
    out.push(`  fit: ${m.fitted.has ? `${m.fitted.method}, ${m.fitted.samples} samples` : 'NOT FITTED (below minSamples)'}`);
    out.push('');
    out.push(fmtBlock('BEFORE (raw probability)', m.before));
    out.push('');
    out.push(fmtBlock('AFTER (canonical fixed-side calibrator)', m.after));
    out.push('');
    out.push('  VALIDATION GATE (holdout, vs identity)');
    out.push(`    graded ${m.validation.n} (${m.validation.judged ? 'judged' : 'NOT judged'})`);
    out.push(`    min holdout rows ${m.validation.minSamples ?? 'n/a'}   monotone curve ${m.validation.monotone === false ? 'NO — rejected' : 'yes'}`);
    out.push(`    Brier   ${f4(m.validation.before.brier)} -> ${f4(m.validation.after.brier)}  (gain ${f4(m.validation.brierGain)}, need >= ${f4(m.validation.minImprovementBrier)})`);
    out.push(`    logLoss ${f4(m.validation.before.logLoss)} -> ${f4(m.validation.after.logLoss)}  (gain ${f4(m.validation.logLossGain)}, need >= ${f4(m.validation.minImprovementLogLoss)})`);
    out.push(`    improved on both by the required margin: ${m.validation.improved ? 'YES — accepted' : 'NO — rejected, identity kept'}`);
    out.push('');
    out.push('  TWO-WAY CONSISTENCY (P(a) + P(b) for the same game+line)');
    out.push(`    pairs ${m.twoWay.pairs}   raw max deviation ${f4(m.twoWay.maxDeviationRaw)}`);
    out.push(`    canonical fit max deviation ${f4(m.twoWay.maxDeviationCanonical)}`);
    out.push(`    per-side (legacy) fit max deviation ${f4(m.twoWay.maxDeviationLegacy)}`);
    if (m.byLineType.some(b => b.type === 'alternate' && b.n > 0)) {
      out.push('');
      out.push('  BY LINE TYPE');
      m.byLineType.forEach(b => {
        out.push(`    ${b.type}: n ${b.n} (graded ${b.graded})`);
        out.push(`      raw       Brier ${f4(b.before.brier)}  log loss ${f4(b.before.logLoss)}`);
        out.push(`      calibrated Brier ${f4(b.after.brier)}  log loss ${f4(b.after.logLoss)}`);
      });
    }
    if (m.legacy) {
      out.push('');
      if (m.legacyFit) {
        Object.entries(m.legacyFit).forEach(([key, f]) => out.push(
          `    legacy key ${key} (side ${f.side}): train ${f.trainRows} rows, ${f.fitted ? `fitted (${f.samples} samples)` : 'NOT fitted'}`,
        ));
      }
      out.push(fmtBlock('LEGACY per-side fit (what the shipped Calibrator would do)', m.legacy));
    }
    out.push('');
  });

  // Shadow log: exactly what the engine will log side by side (display stays raw).
  const shadow = testRows
    .filter(r => r.y === 0 || r.y === 1)
    .slice(-20)
    .map(r => ({
      tipoff: r.tipoff, market: r.market, line: r.line, side: r.side,
      raw: Number(r.pRaw.toFixed(4)),
      calibrated: Number(calibration.apply(leagueCfg.key, r.market, r.pRaw, r.side).toFixed(4)),
      outcome: r.y === 1 ? 'won' : 'lost',
    }));
  out.push('## Shadow log (last 20 graded holdout picks; display stays RAW until approved)');
  shadow.forEach(s => out.push(
    `  ${String(s.tipoff || '').slice(0, 10)}  ${s.market.padEnd(12)} ${String(s.line).padStart(6)} ${s.side}  raw ${s.raw.toFixed(4)}  calibrated ${s.calibrated.toFixed(4)}  ${s.outcome}`,
  ));
  out.push('');

  out.push('## Outcome');
  out.push(`  accepted markets: ${accepted.length ? accepted.join(', ') : 'NONE — engine keeps raw probabilities'}`);
  out.push(`  document id: ${doc.id}   version ${doc.version}   shadow ${doc.shadow}`);
  out.push(`  oddsSource ${doc.oddsSource}   training rows ${doc.training.rows}   ${doc.training.from} -> ${doc.training.to}`);
  out.push('');

  console.log(out.join('\n'));

  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), JSON.stringify({
      league: leagueCfg.key, generatedAt: new Date().toISOString(), seasons, withOdds, method,
      data: {
        games: ev.games, picks: ev.picks, noPickGames: ev.noPickGames, missingOdds: ev.missingOdds,
        trainRows: train.length, holdoutRows: testRows.length, cutoff,
        residuals: {
          total: { n: ev.residuals.total.length, sd: ev.sigma.total },
          margin: { n: ev.residuals.margin.length, sd: ev.sigma.margin },
        },
      },
      perMarket, validation, shadow, doc,
    }, null, 2));
    console.log(`\nWrote JSON report to ${args.out}`);
  }

  if (args.write) {
    if (!accepted.length) {
      console.log('\nNot writing a calibrator document: no market passed the holdout gate.');
    } else {
      let admin;
      try {
        admin = require('firebase-admin');
        if ((!admin.apps || admin.apps.length === 0) && typeof admin.initializeApp === 'function') admin.initializeApp();
      } catch (err) {
        admin = null;
      }
      if (!admin || !admin.apps || admin.apps.length === 0) {
        console.log('\nNot writing: firebase-admin is not initialised (set GOOGLE_APPLICATION_CREDENTIALS).');
      } else {
        await saveCalibrator(admin, doc);
        console.log(`\nWrote calibrator document ${doc.id} (shadow: ${doc.shadow}).`);
      }
    }
  }
}

module.exports = {
  parseArgs, fetchJson, listTeamIds, collectSeasonGames, attachBoxScores,
  loadSeasonDataset, scoreRows, splitHoldout, legacyPerSideFit,
  BUCKET_EDGES,
};

if (require.main === module) {
  main().catch(err => {
    console.error('Refit failed:', err?.stack || err?.message || err);
    process.exit(1);
  });
}
