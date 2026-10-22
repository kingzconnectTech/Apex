/**
 * basketball/backtester.js
 *
 * Walk-forward backtesting and calibration harness for the basketball engine.
 *
 * Guarantees:
 *   - No leakage: for every game, a team's ratings are computed ONLY from games
 *     that tipped off strictly earlier than the game being predicted.
 *   - No leakage from calibrators: the calibrator is refitted walk-forward from
 *     graded picks that finished strictly before the current game.
 *   - Closing lines are used ONLY as a benchmark (CLV / bookmaker baseline) and
 *     are never fed to the model as an input.
 *
 * The module is pure: it takes a dataset (array of games with box scores and,
 * optionally, prediction-time / closing odds) and returns a report object. The
 * runnable script `backend/scripts/run-basketball-backtest.js` builds a dataset
 * from the existing ESPN provider (or loads a JSON file) and prints the report.
 *
 * Dataset game shape (all fields optional except ids + tipoff + scores):
 * {
 *   gameId, tipoff (ISO), league, venue,
 *   home: { teamId, name, score, stats: { fgm, fga, tpm, tpa, ftm, fta, orb, drb, tov, ast, stl, blk, pf } },
 *   away: { teamId, name, score, stats: { ... } },
 *   odds:    { total, overOdds, underOdds, spread, homeOdds, awayOdds },   // prediction-time
 *   closing: { total, overOdds, underOdds, spread, homeOdds, awayOdds },   // benchmark only
 *   injuries: [...],
 *   context: { travelKm:{home,away}, altitudeMeters, motivation:{home,away} }
 * }
 */

const CONFIG = require('./config');
const { getLeagueConfig } = require('./leagues');
const { analyzeGame } = require('./index');
const {
  totalsProbability, spreadProbability, leagueMeanTotal, sigmaFromResiduals,
} = require('./probability');
const { Calibrator, brierScore, logLoss, calibrationCurve } = require('./calibration');
const { toDecimal, removeVig } = require('./lineSelector');
const { settleOne, profit } = require('./persistence');
const { deriveGameMetrics } = require('./normalize');
const { observedLeagueMean } = require('./params');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOWS = { train: [0, 0.6], validation: [0.6, 0.8], test: [0.8, 1.0] };

/** Candidate hyperparameter sets tuned on the validation window, frozen for test. */
const DEFAULT_CANDIDATES = [
  { label: 'baseline', cfg: {} },
  { label: 'halfLife-7', cfg: { ratings: { halfLifeGames: 7 } } },
  { label: 'halfLife-12', cfg: { ratings: { halfLifeGames: 12 } } },
  { label: 'shrinkM-3', cfg: { ratings: { shrinkageM: 3 } } },
  { label: 'shrinkM-10', cfg: { ratings: { shrinkageM: 10 } } },
  { label: 'paceBlend-0.50', cfg: { projection: { paceBlendWeight: 0.5 } } },
  { label: 'paceBlend-0.65', cfg: { projection: { paceBlendWeight: 0.65 } } },
  { label: 'elo-off', cfg: { ratings: { elo: { enabled: false } } } },
];

// --------------------------------------------------------------------------
// Small utilities
// --------------------------------------------------------------------------

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep-merge a config patch onto a base config (arrays replaced, not merged). */
function mergeDeep(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = isPlainObject(base) ? { ...base } : {};
  Object.keys(patch).forEach(k => {
    const pv = patch[k];
    out[k] = isPlainObject(pv) ? mergeDeep(base?.[k], pv) : pv;
  });
  return out;
}

/**
 * ESPN labels a basketball season by its ENDING year, exactly as
 * services/basketball/ingestion.js does (2026 = the 2025-26 season).
 *
 * Used here only to scope the observed league-mean pool to the CURRENT season.
 * params.resolveLeagueMean blends the fitted league mean toward "the current
 * season's observed means, quickly", so a pool that spanned every season in the
 * dataset would defeat the point: it would converge on the all-time average
 * instead of the live scoring environment.
 */
function seasonYearOf(tipoff) {
  const d = new Date(tipoff);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  return (d.getUTCMonth() + 1) >= 8 ? year + 1 : year;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}


function num(v) {
  return v === undefined || v === null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
}

function describe(arr) {
  const vals = (Array.isArray(arr) ? arr : []).filter(v => Number.isFinite(v));
  if (!vals.length) return { n: 0, mean: null, sd: null };
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const sd = vals.length > 1
    ? Math.sqrt(vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (vals.length - 1))
    : null;
  return { n: vals.length, mean: Number(mean.toFixed(3)), sd: sd == null ? null : Number(sd.toFixed(3)) };
}

/** Validate/normalise the train/validation/test chronological fractions. */
function normalizeWindows(windows) {
  const w = isPlainObject(windows) ? windows : {};
  const out = {};
  ['train', 'validation', 'test'].forEach(k => {
    const v = w[k] || DEFAULT_WINDOWS[k];
    out[k] = [Number(v[0]), Number(v[1])];
  });
  return out;
}

/** Chronological window label for game `index` of `n`, by fraction. */
function windowOf(index, n, windows) {
  if (n <= 0) return 'train';
  const frac = index / n;
  for (const name of ['train', 'validation', 'test']) {
    const w = windows[name];
    if (w && frac >= w[0] && frac < w[1]) return name;
  }
  return 'test';
}

// --------------------------------------------------------------------------
// Dataset index: per-team chronological logs with schedule context
// --------------------------------------------------------------------------

function _boxFromStats(stats, oppStats) {
  if (!stats) return null;
  return {
    fgm: num(stats.fgm), fga: num(stats.fga),
    tpm: num(stats.tpm), tpa: num(stats.tpa),
    ftm: num(stats.ftm), fta: num(stats.fta),
    orb: num(stats.orb ?? stats.oreb), drb: num(stats.drb ?? stats.dreb), trb: num(stats.trb),
    ast: num(stats.ast), tov: num(stats.tov), stl: num(stats.stl), blk: num(stats.blk), pf: num(stats.pf),
    oppFgm: oppStats ? num(oppStats.fgm) : null,
    oppFga: oppStats ? num(oppStats.fga) : null,
    oppOrb: oppStats ? num(oppStats.orb ?? oppStats.oreb) : null,
    oppTov: oppStats ? num(oppStats.tov) : null,
    oppFta: oppStats ? num(oppStats.fta) : null,
  };
}

/** Rest days, back-to-back and 3-in-4 flags for a game given a team's prior games. */
function _scheduleFlags(priorChron, ts) {
  const prev = priorChron.length ? priorChron[priorChron.length - 1] : null;
  let restDays = null;
  let backToBack = false;
  let threeInFour = false;
  if (prev && prev.timestamp != null && ts != null) {
    restDays = Math.round((ts - prev.timestamp) / DAY_MS);
    backToBack = restDays <= 1;
    const windowStart = ts - 4 * DAY_MS;
    const inWindow = priorChron.filter(e => e.timestamp != null && e.timestamp > windowStart && e.timestamp <= ts).length;
    threeInFour = inWindow + 1 >= 3;
  }
  return { restDays, backToBack, threeInFour };
}

/**
 * Build a per-team chronological game log from a flat dataset.
 * Every entry carries its OWN box score AND the opponent's box score for the
 * same game, so possessions/ratings can be derived from either side.
 *
 * @returns {Map<string, Array>} teamId -> ascending-by-timestamp log
 */
function buildTeamLogs(gamesAsc) {
  const byTeam = new Map();
  const push = (teamId, entry) => {
    if (teamId == null) return;
    if (!byTeam.has(teamId)) byTeam.set(teamId, []);
    byTeam.get(teamId).push(entry);
  };

  gamesAsc.forEach(g => {
    const ts = g.tipoff ? new Date(g.tipoff).getTime() : null;
    const homeStats = g.home?.stats || g.home?.boxScore || null;
    const awayStats = g.away?.stats || g.away?.boxScore || null;

    push(g.home?.teamId, {
      eventId: g.gameId, date: g.tipoff, timestamp: ts, isHome: true,
      opponentId: g.away?.teamId ?? null, opponentName: g.away?.name ?? null,
      pf: num(g.home?.score), pa: num(g.away?.score),
      boxScore: _boxFromStats(homeStats, awayStats),
    });
    push(g.away?.teamId, {
      eventId: g.gameId, date: g.tipoff, timestamp: ts, isHome: false,
      opponentId: g.home?.teamId ?? null, opponentName: g.home?.name ?? null,
      pf: num(g.away?.score), pa: num(g.home?.score),
      boxScore: _boxFromStats(awayStats, homeStats),
    });
  });

  byTeam.forEach(arr => {
    arr.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    arr.forEach((entry, i) => Object.assign(entry, _scheduleFlags(arr.slice(0, i), entry.timestamp)));
  });

  return byTeam;
}

/** A team's log as of (strictly before) `beforeTs`, newest-first. */
function priorLog(byTeam, teamId, beforeTs) {
  const arr = byTeam.get(teamId) || [];
  if (beforeTs == null) return [];
  return arr.filter(e => e.timestamp != null && e.timestamp < beforeTs).slice().reverse();
}

// --------------------------------------------------------------------------
// Provider-shaped adapters
// --------------------------------------------------------------------------

function toFixture(g, league) {
  const ts = g.tipoff ? new Date(g.tipoff).getTime() : null;
  return {
    league: { slug: league, id: league },
    fixture: {
      id: String(g.gameId), date: g.tipoff || null, timestamp: ts,
      status: 'scheduled', venue: g.venue || null,
    },
    homeTeam: {
      id: g.home?.teamId != null ? String(g.home.teamId) : '',
      displayName: g.home?.name || `Home ${g.home?.teamId ?? ''}`.trim(),
      score: num(g.home?.score),
    },
    awayTeam: {
      id: g.away?.teamId != null ? String(g.away.teamId) : '',
      displayName: g.away?.name || `Away ${g.away?.teamId ?? ''}`.trim(),
      score: num(g.away?.score),
    },
  };
}

function toOdds(g) {
  const o = g.odds || null;
  if (!o) return null;
  const mapped = {
    overUnder: num(o.total ?? o.overUnder),
    overOdds: num(o.overOdds),
    underOdds: num(o.underOdds),
    spread: num(o.spread),
    homeSpreadOdds: num(o.homeOdds ?? o.homeSpreadOdds),
    awaySpreadOdds: num(o.awayOdds ?? o.awaySpreadOdds),
    totalAlternates: Array.isArray(o.totalAlternates) ? o.totalAlternates : [],
    spreadAlternates: Array.isArray(o.spreadAlternates) ? o.spreadAlternates : [],
  };
  const hasAnything = mapped.overUnder != null || mapped.spread != null;
  return hasAnything ? mapped : null;
}

function toClosing(g) {
  const c = g.closing || null;
  if (!c) return null;
  const total = num(c.total ?? c.overUnder);
  const spread = num(c.spread);
  if (total == null && spread == null) return null;
  return {
    total,
    overOdds: num(c.overOdds),
    underOdds: num(c.underOdds),
    spread,
    homeOdds: num(c.homeOdds ?? c.homeSpreadOdds),
    awayOdds: num(c.awayOdds ?? c.awaySpreadOdds),
  };
}

// --------------------------------------------------------------------------
// Selection bookkeeping helpers
// --------------------------------------------------------------------------

function calibKeyFor(pick) {
  if (pick.market === 'Total Points') return pick.side === 'a' ? 'total_over' : 'total_under';
  return pick.side === 'a' ? 'spread_home' : 'spread_away';
}

/** Recompute the RAW (pre-calibration) probability for a selected pick. */
function rawProbabilityFor(pick, projection, cfg) {
  if (pick.market === 'Total Points') {
    const r = totalsProbability({
      line: pick.line, projTotal: projection.total, sigmaTotal: projection.sigmaTotal, cfg,
    });
    return pick.side === 'a' ? r.over : r.under;
  }
  const r = spreadProbability({
    spread: pick.line, projMargin: projection.margin, sigmaMargin: projection.sigmaMargin, cfg,
  });
  return pick.side === 'a' ? r.home : r.away;
}

/** Fair implied probability of the pick's side at the closing line (benchmark). */
function closingFairFor(row, closing) {
  if (!closing) return null;
  if (row.market === 'Total Points' && row.line === closing.total) {
    const vig = removeVig([toDecimal(closing.overOdds), toDecimal(closing.underOdds)]);
    return vig ? (row.side === 'a' ? vig.fair[0] : vig.fair[1]) : null;
  }
  if (row.market === 'Spread' && row.line === closing.spread) {
    const vig = removeVig([toDecimal(closing.homeOdds), toDecimal(closing.awayOdds)]);
    return vig ? (row.side === 'a' ? vig.fair[0] : vig.fair[1]) : null;
  }
  return null;
}

/** Naive league-average model probability for the pick's side. */
function naiveFor(row, leagueCfg, cfg) {
  const s = cfg.sigma;
  if (row.market === 'Total Points') {
    const proj = leagueMeanTotal(leagueCfg);
    const sigmaTotal = clamp(leagueCfg.sigma?.total ?? 17.5, s.minTotal, s.maxTotal);
    const r = totalsProbability({ line: row.line, projTotal: proj, sigmaTotal, cfg });
    return row.side === 'a' ? r.over : r.under;
  }
  const proj = leagueCfg.homeCourtPoints ?? 2.5;
  const sigmaMargin = clamp(leagueCfg.sigma?.margin ?? 11.5, s.minMargin, s.maxMargin);
  const r = spreadProbability({ spread: row.line, projMargin: proj, sigmaMargin, cfg });
  return row.side === 'a' ? r.home : r.away;
}

/** Closing-line value: our taken price vs the closing price for the SAME selection. */
function computeClv(row, closing) {
  if (!closing || !Number.isFinite(row.odds)) return null;
  let closingOdds = null;
  if (row.market === 'Total Points' && row.line === closing.total) {
    closingOdds = toDecimal(row.side === 'a' ? closing.overOdds : closing.underOdds);
  } else if (row.market === 'Spread' && row.line === closing.spread) {
    closingOdds = toDecimal(row.side === 'a' ? closing.homeOdds : closing.awayOdds);
  }
  if (!Number.isFinite(closingOdds) || closingOdds <= 1) return null;
  return Number((row.odds / closingOdds - 1).toFixed(4));
}

// --------------------------------------------------------------------------
// Walk-forward evaluation
// --------------------------------------------------------------------------

function refitCalibrators(calibrator, calibRows, calCfg) {
  calibRows.forEach((rows, key) => {
    const [league, market] = key.split('|');
    calibrator.fit(league, market, rows, { minSamples: calCfg.calibration.minSamples, method: calCfg.calibration.method });
  });
}

/**
 * Run the walk-forward loop. Produces one row per SELECTED pick plus per-game
 * rows used for baselines, residual/sigma fitting and closing-line benchmarks.
 *
 * @param {Array|Object} dataset
 * @param {Object} opts - { cfg, windows, calibrate, refitEvery, minCalibrationSample, probKey }
 * @returns {Object}
 */
function evaluate(dataset, opts = {}) {
  const gamesInput = Array.isArray(dataset) ? dataset : (dataset?.games || []);
  const defaultLeague = Array.isArray(dataset) ? null : (dataset?.league || null);
  const cfg = opts.cfg || CONFIG;
  const windows = opts.windows || DEFAULT_WINDOWS;
  const calibrateEnabled = opts.calibrate !== false;
  const refitEvery = opts.refitEvery ?? 25;

  const calCfg = {
    ...cfg,
    calibration: { ...cfg.calibration, minSamples: opts.minCalibrationSample ?? cfg.calibration.minSamples },
  };

  const games = gamesInput
    .map(g => ({ ...g, league: g.league || defaultLeague }))
    .filter(g => g && g.tipoff && g.home?.teamId != null && g.away?.teamId != null)
    .sort((a, b) => new Date(a.tipoff) - new Date(b.tipoff));

  const byTeam = buildTeamLogs(games);
  const calibrator = new Calibrator(calCfg);
  const calibRows = new Map(); // `${league}|${key}` -> [{p,y}]

  // Current-season league means, accumulated league-wide as the walk advances and
  // keyed by league + season so the pool RESETS each season. Only games that have
  // ALREADY been analysed feed the pool, so the observed mean a game sees is built
  // purely from strictly earlier games of the same season.
  const gameEntries = new Map();
  byTeam.forEach(arr => arr.forEach(e => {
    if (!gameEntries.has(e.eventId)) gameEntries.set(e.eventId, []);
    gameEntries.get(e.eventId).push(e);
  }));
  const observedPools = new Map(); // `${league}|${seasonYear}` -> derived per-team-game metrics

  const rows = [];
  const gameRows = [];
  const residualTotal = [];
  const residualMargin = [];
  const failures = [];
  let picks = 0;
  let noPickGames = 0;
  let missingOdds = 0;

  games.forEach((g, i) => {
    const ts = new Date(g.tipoff).getTime();
    const league = g.league;
    const poolKey = `${league}|${seasonYearOf(g.tipoff)}`;

    let leagueCfg;
    try {
      leagueCfg = getLeagueConfig(league);
    } catch (err) {
      failures.push({ gameId: g.gameId, reason: err?.message || String(err) });
      return;
    }

    const odds = toOdds(g);
    if (!odds) missingOdds++;

    let result = null;
    try {
      result = analyzeGame({
        fixture: toFixture(g, league),
        odds,
        injuries: g.injuries || [],
        homeLog: priorLog(byTeam, g.home.teamId, ts),
        awayLog: priorLog(byTeam, g.away.teamId, ts),
        league,
        context: g.context || null,
        calibrator: calibrateEnabled ? calibrator : null,
        observed: observedLeagueMean(observedPools.get(poolKey) || []),
        cfg,
      });
    } catch (err) {
      failures.push({ gameId: g.gameId, reason: `analysis failed: ${err?.message || err}` });
      return;
    }

    // Feed this game into the league-wide observed pool AFTER it has been analysed.
    (gameEntries.get(String(g.gameId)) || []).forEach(e => {
      const d = deriveGameMetrics(e, leagueCfg);
      if (!d) return;
      const pool = observedPools.get(poolKey) || [];
      pool.push(d);
      observedPools.set(poolKey, pool);
    });
    if (!result) {
      failures.push({ gameId: g.gameId, reason: 'insufficient data for a projection' });
      return;
    }

    const homeScore = num(g.home?.score);
    const awayScore = num(g.away?.score);
    const hasResult = homeScore != null && awayScore != null;
    const actualTotal = hasResult ? homeScore + awayScore : null;
    const actualMargin = hasResult ? homeScore - awayScore : null;

    const win = windowOf(i, games.length, windows);
    const closing = toClosing(g);

    if (hasResult) {
      residualTotal.push(actualTotal - result.projection.total);
      residualMargin.push(actualMargin - result.projection.margin);
    }

    // Per-game row. Used for baselines, residual/sigma fitting, closing-line
    // benchmarks and the projection-bias diagnostics, which need the BASE
    // projection and the applied adjustments separately to attribute a bias to
    // pace, efficiency or a specific bounded adjustment.
    const adj = result.adjustments || { margin: 0, total: 0, breakdown: [] };
    const adjByType = {};
    (adj.breakdown || []).forEach(b => {
      const t = b.type || 'other';
      adjByType[t] = (adjByType[t] || 0) + (Number.isFinite(b.total) ? b.total : 0);
    });
    gameRows.push({
      window: win,
      league,
      gameId: String(g.gameId),
      tipoff: g.tipoff || null,
      actualTotal,
      actualMargin,
      homeScore,
      awayScore,
      closing,
      projTotal: result.projection.total ?? null,
      projMargin: result.projection.margin ?? null,
      projPossessions: result.projection.expectedPossessions ?? null,
      homePpp: result.projection.homePpp ?? null,
      awayPpp: result.projection.awayPpp ?? null,
      baseTotal: result.baseProjection?.total ?? null,
      baseMargin: result.baseProjection?.margin ?? null,
      adjTotal: Number.isFinite(adj.total) ? adj.total : 0,
      adjMargin: Number.isFinite(adj.margin) ? adj.margin : 0,
      adjByType,
      homePace: result.homeRatings?.pace ?? null,
      awayPace: result.awayRatings?.pace ?? null,
      homeGamesPlayed: result.homeRatings?.gamesPlayed ?? null,
      awayGamesPlayed: result.awayRatings?.gamesPlayed ?? null,
    });

    const selected = result.selection?.picks || [];
    if (!selected.length) noPickGames++;

    selected.forEach(pick => {
      picks++;
      const rawP = rawProbabilityFor(pick, result.projection, cfg);
      const row = {
        window: win,
        league,
        gameId: String(g.gameId),
        tipoff: g.tipoff || null,
        market: pick.market,
        side: pick.side,
        line: pick.line,
        isMain: pick.isMain !== false,
        confidence: pick.confidence,
        dataQuality: result.dataQuality?.score ?? null,
        pCal: pick.probability,
        pRaw: rawP,
        odds: pick.odds,
        edge: pick.edge,
        ev: pick.ev,
        projTotal: result.projection.total,
        projMargin: result.projection.margin,
        actualTotal,
        actualMargin,
        y: null,
        outcome: null,
        clv: null,
        closingFair: null,
        naiveP: null,
      };

      if (hasResult) {
        const outcome = settleOne({ market: pick.market, line: pick.line, side: pick.side }, homeScore, awayScore);
        row.outcome = outcome;
        row.y = outcome === 'push' ? null : (outcome === 'won' ? 1 : 0);
        const key = `${league}|${calibKeyFor(pick)}`;
        const buf = calibRows.get(key) || [];
        buf.push({ p: rawP, y: row.y });
        calibRows.set(key, buf);
      }

      row.closingFair = closingFairFor(row, closing);
      row.naiveP = naiveFor(row, leagueCfg, cfg);
      row.clv = computeClv(row, closing);

      rows.push(row);
    });

    if (calibrateEnabled && (i + 1) % refitEvery === 0) refitCalibrators(calibrator, calibRows, calCfg);
  });

  if (calibrateEnabled) refitCalibrators(calibrator, calibRows, calCfg);

  return {
    games: games.length,
    picks,
    noPickGames,
    missingOdds,
    rows,
    gameRows,
    residuals: { total: residualTotal, margin: residualMargin },
    sigma: { total: sigmaFromResiduals(residualTotal), margin: sigmaFromResiduals(residualMargin) },
    calibrator: calibrator.toJSON(),
    failures,
  };
}

// --------------------------------------------------------------------------
// Metrics
// --------------------------------------------------------------------------

/**
 * Metrics for a set of pick rows.
 * @param {Array} rows
 * @param {string} [probKey='pCal'] - which probability column to score ('pCal' | 'pRaw')
 */
function metrics(rows, probKey = 'pCal') {
  const list = Array.isArray(rows) ? rows : [];
  const graded = list.filter(r => r.y === 0 || r.y === 1);
  const good = graded.filter(r => Number.isFinite(r[probKey]));
  const n = good.length;
  const hits = good.filter(r => r.y === 1).length;
  const calRows = good.map(r => ({ p: r[probKey], y: r.y }));
  const avgPredicted = n ? good.reduce((s, r) => s + r[probKey], 0) / n : null;
  const staked = list.filter(r => r.outcome === 'won' || r.outcome === 'lost' || r.outcome === 'push');
  const roi = staked.length ? staked.reduce((s, r) => s + profit(r.outcome, r.odds), 0) / staked.length : null;

  const clvRows = list.filter(r => Number.isFinite(r.clv));

  return {
    n,
    graded: graded.length,
    pushes: list.filter(r => r.outcome === 'push').length,
    hits,
    hitRate: n ? Number((hits / n).toFixed(4)) : null,
    avgPredicted: avgPredicted == null ? null : Number(avgPredicted.toFixed(4)),
    calibrationGap: (n && avgPredicted != null) ? Number((hits / n - avgPredicted).toFixed(4)) : null,
    brier: n ? Number(brierScore(calRows).toFixed(4)) : null,
    logLoss: n ? Number(logLoss(calRows).toFixed(4)) : null,
    roi: roi == null ? null : Number(roi.toFixed(4)),
    buckets: calibrationCurve(calRows, [0.55, 0.60, 0.65, 0.70, 1.01])
      .map(b => ({ range: b.range, n: b.n, predicted: b.predicted == null ? null : Number(b.predicted.toFixed(4)), actual: b.actual == null ? null : Number(b.actual.toFixed(4)) })),
    clv: clvRows.length ? {
      n: clvRows.length,
      mean: Number((clvRows.reduce((s, r) => s + r.clv, 0) / clvRows.length).toFixed(4)),
      beatRate: Number((clvRows.filter(r => r.clv > 0).length / clvRows.length).toFixed(4)),
    } : { n: 0, mean: null, beatRate: null },
  };
}

/** Always-pick-the-favourite baseline, graded on closing lines. */
function favouriteBaseline(gameRows) {
  let n = 0;
  let hits = 0;
  let ret = 0;
  (Array.isArray(gameRows) ? gameRows : []).forEach(g => {
    if (!g.closing || !Number.isFinite(g.actualMargin)) return;
    const vig = removeVig([toDecimal(g.closing.homeOdds), toDecimal(g.closing.awayOdds)]);
    if (!vig) return;
    const homeFav = vig.fair[0] >= vig.fair[1];
    const adj = g.actualMargin + g.closing.spread;
    if (adj === 0) return; // push — excluded
    const homeCovers = adj > 0;
    const won = homeFav === homeCovers;
    n++;
    if (won) hits++;
    const odds = homeFav ? toDecimal(g.closing.homeOdds) : toDecimal(g.closing.awayOdds);
    ret += won ? ((Number.isFinite(odds) ? odds : 1.9) - 1) : -1;
  });
  return { n, hits, hitRate: n ? Number((hits / n).toFixed(4)) : null, roi: n ? Number((ret / n).toFixed(4)) : null };
}

/**
 * Compare the model against the bookmaker's implied probabilities and a naive
 * league-average model, ON THE SAME SELECTIONS (a fair head-to-head).
 */
function compareBaselines(rows) {
  const graded = (Array.isArray(rows) ? rows : []).filter(r => r.y === 0 || r.y === 1);
  const onKey = (key) => {
    const good = graded.filter(r => Number.isFinite(r[key]));
    if (!good.length) return { n: 0, brier: null, logLoss: null, hitRate: null, roi: null };
    const calRows = good.map(r => ({ p: r[key], y: r.y }));
    const hit = good.filter(r => (r[key] >= 0.5 ? 1 : 0) === r.y).length;
    const staked = good.filter(r => r.outcome === 'won' || r.outcome === 'lost' || r.outcome === 'push');
    return {
      n: good.length,
      brier: Number(brierScore(calRows).toFixed(4)),
      logLoss: Number(logLoss(calRows).toFixed(4)),
      hitRate: Number((hit / good.length).toFixed(4)),
      roi: staked.length ? Number((staked.reduce((s, r) => s + profit(r.outcome, r.odds), 0) / staked.length).toFixed(4)) : null,
    };
  };
  return {
    model: onKey('pCal'),
    modelUncalibrated: onKey('pRaw'),
    bookmaker: onKey('closingFair'),
    naive: onKey('naiveP'),
  };
}

function buildVerdict(baselines) {
  const m = baselines.model;
  const b = baselines.bookmaker;
  const enough = m.n >= 30 && b.n >= 30;
  let beats = null;
  let statement;
  if (!enough) {
    statement = `Insufficient graded test picks (model n=${m.n}, bookmaker n=${b.n}) for a confident comparison; treat it as indicative only.`;
  } else if (m.logLoss == null || b.logLoss == null) {
    statement = 'Log loss could not be computed for one side; comparison unavailable.';
  } else {
    beats = m.logLoss < b.logLoss;
    statement = beats
      ? `Model log loss ${m.logLoss} beats the bookmaker's implied log loss ${b.logLoss} on ${m.n} test picks.`
      : `Model log loss ${m.logLoss} does NOT beat the bookmaker's implied log loss ${b.logLoss} on ${m.n} test picks — the market is better calibrated.`;
  }
  return {
    beatsBookmaker: beats,
    modelLogLoss: m.logLoss,
    bookmakerLogLoss: b.logLoss,
    sample: m.n,
    statement,
  };
}

// --------------------------------------------------------------------------
// Hyperparameter tuning (on the validation window only)
// --------------------------------------------------------------------------

/**
 * Evaluate each candidate config on the validation window (chronological),
 * score by validation log loss, and return the best.
 *
 * @param {Array|Object} dataset
 * @param {Array} candidates - [{ label, cfg }] or bare patches
 * @returns {Object} { best, results, objective }
 */
function tuneHyperparameters(dataset, candidates, opts = {}) {
  const windows = opts.windows || DEFAULT_WINDOWS;
  const baseCfg = opts.cfg || CONFIG;
  const list = Array.isArray(candidates) ? candidates : DEFAULT_CANDIDATES;

  const results = list.map((cand, index) => {
    const patch = cand?.cfg || cand || {};
    const label = cand?.label || `cand-${index}`;
    const cfg = mergeDeep(baseCfg, patch);
    const ev = evaluate(dataset, { ...opts, cfg, windows });
    const m = metrics(ev.rows.filter(r => r.window === 'validation'));
    return { index, label, patch, logLoss: m.logLoss, brier: m.brier, hitRate: m.hitRate, n: m.n };
  });

  const scored = results.filter(r => r.n > 0 && r.logLoss != null).sort((a, b) => a.logLoss - b.logLoss);
  return {
    best: scored.length ? scored[0] : null,
    results,
    objective: 'validation log loss (lower is better)',
  };
}

// --------------------------------------------------------------------------
// Public entry point
// --------------------------------------------------------------------------

/**
 * Run a full walk-forward backtest and return an honest report.
 *
 * @param {Array|Object} dataset
 * @param {Object} [opts]
 * @param {Object} [opts.config]        - config patch merged onto CONFIG
 * @param {Array}  [opts.candidates]    - hyperparameter candidates to tune
 * @param {Object} [opts.windows]       - { train, validation, test } fractions
 * @param {boolean}[opts.calibrate=true]
 * @param {string} [opts.probKey='pCal']- 'pCal' | 'pRaw' for the headline metrics
 * @param {number} [opts.refitEvery=25]
 * @param {number} [opts.minCalibrationSample]
 * @returns {Object} report
 */
function runBacktest(dataset, opts = {}) {
  const windows = normalizeWindows(opts.windows);
  let cfg = mergeDeep(CONFIG, opts.config || {});
  let tuning = null;
  let hyperparameterSource = 'default';

  if (Array.isArray(opts.candidates) && opts.candidates.length) {
    tuning = tuneHyperparameters(dataset, opts.candidates, { ...opts, cfg, windows });
    if (tuning.best && Object.keys(tuning.best.patch || {}).length) {
      cfg = mergeDeep(cfg, tuning.best.patch);
      hyperparameterSource = 'tuned-on-validation';
    } else if (tuning.best) {
      hyperparameterSource = 'default-won-tuning';
    }
  }

  const ev = evaluate(dataset, { ...opts, cfg, windows });
  const probKey = opts.probKey || 'pCal';

  const markets = [...new Set(ev.rows.map(r => r.market))].sort();
  const leagues = [...new Set(ev.rows.map(r => r.league))].sort();

  const byWindow = {};
  ['train', 'validation', 'test'].forEach(w => {
    byWindow[w] = metrics(ev.rows.filter(r => r.window === w), probKey);
  });

  const byMarket = {};
  const byMarketWindow = { test: {} };
  markets.forEach(m => {
    byMarket[m] = metrics(ev.rows.filter(r => r.market === m), probKey);
    byMarketWindow.test[m] = metrics(ev.rows.filter(r => r.market === m && r.window === 'test'), probKey);
  });

  const byLeague = {};
  leagues.forEach(l => { byLeague[l] = metrics(ev.rows.filter(r => r.league === l), probKey); });

  // Scored markets (with decimal odds) — used by the live auto-downgrade.
  const baselinesTest = compareBaselines(ev.rows.filter(r => r.window === 'test'));
  const baselinesAll = compareBaselines(ev.rows);

  const gamesList = Array.isArray(dataset) ? dataset : (dataset?.games || []);
  const tips = gamesList.map(g => g.tipoff).filter(Boolean).sort();

  return {
    modelVersion: cfg.modelVersion,
    generatedAt: new Date().toISOString(),
    dataset: {
      games: ev.games,
      from: tips[0] || null,
      to: tips[tips.length - 1] || null,
      leagues,
    },
    windows,
    hyperparameters: {
      source: hyperparameterSource,
      applied: hyperparameterSource.startsWith('tuned') ? tuning.best.patch : {},
      tuning: tuning
        ? { objective: tuning.objective, candidates: tuning.results.map(r => ({ label: r.label, logLoss: r.logLoss, brier: r.brier, hitRate: r.hitRate, n: r.n })) }
        : null,
    },
    counts: {
      games: ev.games,
      picks: ev.picks,
      noPickGames: ev.noPickGames,
      missingOdds: ev.missingOdds,
    },
    overall: metrics(ev.rows, probKey),
    byWindow,
    byMarket,
    byMarketWindow,
    byLeague,
    uncalibrated: metrics(ev.rows, 'pRaw'),
    residuals: { total: describe(ev.residuals.total), margin: describe(ev.residuals.margin) },
    sigmaRecommendation: { total: ev.sigma.total, margin: ev.sigma.margin },
    baselines: { test: baselinesTest, all: baselinesAll, favourite: favouriteBaseline(ev.gameRows.filter(g => g.window === 'test')) },
    verdict: buildVerdict(baselinesTest),
    failures: ev.failures.slice(0, 50),
    failureCount: ev.failures.length,
  };
}

// --------------------------------------------------------------------------
// Human-readable report
// --------------------------------------------------------------------------

function pct(v) {
  return v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
}

function fmtNum(v, dp = 3) {
  return v == null ? 'n/a' : Number(v).toFixed(dp);
}

function fmtMetrics(label, m) {
  const lines = [
    `${label}`,
    `  picks ${m.n}  hit rate ${pct(m.hitRate)}  avg predicted ${pct(m.avgPredicted)}  gap ${m.calibrationGap == null ? 'n/a' : (m.calibrationGap > 0 ? '+' : '') + (m.calibrationGap * 100).toFixed(1) + 'pp'}`,
    `  Brier ${fmtNum(m.brier, 4)}  log loss ${fmtNum(m.logLoss, 4)}  ROI ${pct(m.roi)}  pushes ${m.pushes}`,
    `  CLV: n=${m.clv.n} mean ${fmtNum(m.clv.mean, 4)} beat rate ${pct(m.clv.beatRate)}`,
  ];
  const buckets = m.buckets.filter(b => b.n > 0).map(b => `${b.range}: n=${b.n} pred ${pct(b.predicted)} actual ${pct(b.actual)}`);
  if (buckets.length) lines.push(`  buckets -> ${buckets.join(' | ')}`);
  return lines.join('\n');
}

/** Render a report as a readable multi-line string. */
function formatReport(report) {
  const out = [];
  out.push(`# Basketball backtest — ${report.modelVersion}`);
  out.push(`dataset: ${report.dataset.games} games (${report.dataset.leagues.join(', ') || 'n/a'}) ${report.dataset.from || '?'} -> ${report.dataset.to || '?'}`);
  out.push(`windows: train ${report.windows.train.join('-')} validation ${report.windows.validation.join('-')} test ${report.windows.test.join('-')}`);
  out.push(`hyperparameters: ${report.hyperparameters.source}${Object.keys(report.hyperparameters.applied).length ? ' ' + JSON.stringify(report.hyperparameters.applied) : ''}`);
  out.push('');
  out.push(fmtMetrics('Overall (all picks)', report.overall));
  out.push('');
  ['train', 'validation', 'test'].forEach(w => out.push(fmtMetrics(`Window: ${w}`, report.byWindow[w]) + '\n'));
  Object.keys(report.byMarket).forEach(m => out.push(fmtMetrics(`Market: ${m}`, report.byMarket[m]) + '\n'));
  Object.keys(report.byLeague).forEach(l => out.push(fmtMetrics(`League: ${l}`, report.byLeague[l]) + '\n'));

  const b = report.baselines.test;
  out.push('Baselines (test window, same selections):');
  out.push(`  model         log loss ${fmtNum(b.model.logLoss, 4)}  Brier ${fmtNum(b.model.brier, 4)}  hit ${pct(b.model.hitRate)}`);
  out.push(`  bookmaker     log loss ${fmtNum(b.bookmaker.logLoss, 4)}  Brier ${fmtNum(b.bookmaker.brier, 4)}  hit ${pct(b.bookmaker.hitRate)}`);
  out.push(`  naive league  log loss ${fmtNum(b.naive.logLoss, 4)}  Brier ${fmtNum(b.naive.brier, 4)}  hit ${pct(b.naive.hitRate)}`);
  out.push(`  favourite     hit ${pct(report.baselines.favourite.hitRate)}  ROI ${pct(report.baselines.favourite.roi)}`);
  out.push('');
  out.push(`residuals: total sd ${fmtNum(report.residuals.total.sd)} (n=${report.residuals.total.n})  margin sd ${fmtNum(report.residuals.margin.sd)} (n=${report.residuals.margin.n})`);
  out.push(`sigma recommendation: total ${fmtNum(report.sigmaRecommendation.total)}  margin ${fmtNum(report.sigmaRecommendation.margin)}`);
  out.push('');
  out.push(`verdict: ${report.verdict.statement}`);
  if (report.failureCount) out.push(`failures: ${report.failureCount} (e.g. ${report.failures.slice(0, 3).map(f => f.reason).join('; ')})`);
  out.push('');
  out.push('Predictions are statistical estimates, not betting advice. A 68% pick still loses about 1 in 3 times.');
  return out.join('\n');
}

module.exports = {
  DAY_MS,
  DEFAULT_WINDOWS,
  DEFAULT_CANDIDATES,
  mergeDeep,
  normalizeWindows,
  windowOf,
  buildTeamLogs,
  priorLog,
  toFixture,
  toOdds,
  toClosing,
  calibKeyFor,
  rawProbabilityFor,
  closingFairFor,
  naiveFor,
  computeClv,
  evaluate,
  metrics,
  compareBaselines,
  favouriteBaseline,
  buildVerdict,
  tuneHyperparameters,
  runBacktest,
  formatReport,
};
