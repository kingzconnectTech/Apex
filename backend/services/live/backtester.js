/**
 * live/backtester.js
 *
 * Phase 5/8 — the hard validation gate for the live models.
 *
 * It replays ESPN history through the Phase 4 models at leakage-free checkpoints
 * (see ./replay) and asks one question per sport: on games the model has not
 * seen, does its live probability beat the honest reference — by enough to
 * matter?
 *
 * The rules are deliberately unforgiving, and mirror the basketball harness:
 *
 *   - No leakage. A checkpoint only carries state the provider had already
 *     recorded, and the walk-forward calibrator is refitted from strictly
 *     earlier games.
 *   - The pre-game (de-vigged) line is reported for INFORMATION ONLY and is
 *     compared against nothing. It is a single closing price per game stamped on
 *     every checkpoint, so an in-game model beats it by construction; quoting it
 *     as a head-to-head would be dishonest. The reference baselines are the
 *     current score-and-time model and the pre-game-only model.
 *   - The gate counts GAMES, not checkpoint rows, and its confidence intervals
 *     come from a bootstrap that resamples whole games. Checkpoints inside one
 *     game share an outcome, so counting rows (or resampling them) would fake
 *     precision.
 *   - A calibrator is only kept if it improves BOTH Brier and log loss on
 *     held-out games by >= the configured margin AND stays monotone.
 *   - A sport "ships" only if the shipped probability beats the score-and-time
 *     baseline on BOTH metrics (with the gain's bootstrap interval above zero)
 *     AND the hit-rate interval clears break-even AND there are enough games.
 *     Anything else reports why it failed.
 *
 * It never tunes itself toward a passing grade: thresholds come from ./config
 * and the output is whatever the data says. The projection is always available;
 * the gate only decides whether a live PICK may be shown.
 */

const CONFIG = require('./config');
const { predictLive } = require('./liveModel');
const {
  Calibrator, validateAgainstIdentity, brierScore, logLoss, calibrationCurve,
} = require('../basketball/calibration');
const { toDecimal, removeVig } = require('../basketball/lineSelector');
const { resolveLeagueKey, LEAGUES: BB_LEAGUES } = require('../basketball/leagues');
const M = require('./liveMath');

const BT = CONFIG.liveBacktest;
const BB = CONFIG.liveModel.basketball;
const DEFAULT_WINDOWS = BT.windows;
const MODEL_VERSION = 'live-backtest-2.0.0';
const CALIB_KEY = 'home_win';

function round4(v) {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(4));
}

/** mulberry32 — tiny deterministic PRNG so a bootstrap interval is reproducible. */
function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Validate/normalise the train/validation/test chronological fractions. */
function normalizeWindows(windows) {
  const w = windows && typeof windows === 'object' ? windows : {};
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

/* ------------------------------------------------------ live-game adapters */

function liveGameShell(record, { label, clock, period, homeScore, awayScore }) {
  return {
    game_id: `${record.gameId}:${label}`,
    sport: record.sport,
    source: 'replay',
    league: { id: record.league || null, name: null },
    home: {
      id: record.home ? record.home.teamId : null,
      name: record.home ? record.home.name : null,
      logo: null, score: homeScore, record: null,
    },
    away: {
      id: record.away ? record.away.teamId : null,
      name: record.away ? record.away.name : null,
      logo: null, score: awayScore, record: null,
    },
    live: { status: 'live', is_live: true, clock, period, raw_status: null },
    data_tier: 'full_live',
    data_tier_label: 'Full live data',
    freshness: null,
    match: null,
    link: null,
    manual: false,
  };
}

/**
 * The LiveGame for one checkpoint. Score/clock/period are exactly what the
 * provider recorded at that moment — nothing is reconstructed or smoothed.
 */
function gameForCheckpoint(record, cp) {
  return liveGameShell(record, {
    label: cp.label,
    clock: cp.clock,
    period: cp.period,
    homeScore: cp.home_score != null ? cp.home_score : 0,
    awayScore: cp.away_score != null ? cp.away_score : 0,
  });
}

/**
 * The pre-game prior for a game: the same model with no usable clock, which the
 * Phase 4 models return as `prior_only`. This is the honest "did the live data
 * actually add anything?" baseline.
 */
function priorProbability(record) {
  const game = liveGameShell(record, {
    label: 'prior', clock: null, period: 0, homeScore: 0, awayScore: 0,
  });
  try {
    const out = predictLive({ game });
    return out && out.probabilities ? round4(out.probabilities.home_win) : null;
  } catch (err) {
    return null;
  }
}

/**
 * De-vigged pre-game home-win probability from the benchmark moneyline.
 *
 * NOT a comparison reference: this is one closing price per game, stamped on
 * every checkpoint, so the in-game model beats it by construction. It is
 * reported for information only.
 */
function fairHomeProbability(line, sport) {
  if (!line || !line.moneyline) return null;
  const decimals = [toDecimal(line.moneyline.home), toDecimal(line.moneyline.away)];
  if (sport === 'soccer' && line.moneyline.draw != null) decimals.push(toDecimal(line.moneyline.draw));
  const vig = removeVig(decimals);
  return vig ? round4(vig.fair[0]) : null;
}

/* --------------------------------------------------------------- timeline */

/**
 * Regulation structure for a basketball league: how long the game is and how
 * many periods it is split into. This is the physical shape of the game, not a
 * fitted parameter — a 40-minute college game (two 20-minute halves) is not
 * measured against a 48-minute pro clock. Unknown leagues fall back to the
 * sport-wide structure so the helper never throws on legacy records.
 *
 * @param {string} [league] - league id / alias (e.g. 'nba', 'wnba', 'mens-college-basketball')
 * @returns {{gameMinutes:number, periods:number, periodMinutes:number, overtimeMinutes:number}}
 */
function basketballStructure(league) {
  const fallback = BT.baselines.scoreTime.basketball;
  const key = resolveLeagueKey(league);
  const cfg = key && BB_LEAGUES[key] ? BB_LEAGUES[key] : null;
  const gameMinutes = cfg && Number.isFinite(cfg.gameMinutes) ? cfg.gameMinutes : fallback.gameMinutes;
  const periods = key && BB.leaguePeriods[key] ? BB.leaguePeriods[key] : (fallback.periods || BB.defaultPeriods);
  return {
    gameMinutes,
    periods,
    periodMinutes: gameMinutes / periods,
    overtimeMinutes: fallback.overtimeMinutes || BB.overtimeMinutes || 5,
  };
}

/**
 * Elapsed and total minutes for a basketball checkpoint, from the period and
 * the clock alone, or null when either is missing. `total` is the length of the
 * game through the end of the current period (regulation, plus any overtime
 * already played); `regulation` is the fixed regulation length used to decide
 * how far through the *game* a checkpoint is. Shared by the score-and-time
 * baseline and the time-bucket split so they agree on what "late" means.
 *
 * @param {Object} cp     replay checkpoint ({ clock, period })
 * @param {string} [league] league id / alias; unknown -> sport-wide structure
 */
function basketballElapsed(cp, league) {
  const s = basketballStructure(league);
  const clock = M.parseClock(cp && cp.clock);
  const period = Number(cp && cp.period) || 0;
  if (!clock || period < 1) return null;

  const pm = s.periodMinutes;
  const overtime = s.overtimeMinutes;
  if (period <= s.periods) {
    const inPeriod = M.clamp(pm - clock.minutes, 0, pm);
    return { elapsed: (period - 1) * pm + inPeriod, total: s.gameMinutes, regulation: s.gameMinutes };
  }
  return {
    elapsed: s.gameMinutes
      + (period - 1 - s.periods) * overtime
      + M.clamp(overtime - clock.minutes, 0, overtime),
    total: s.gameMinutes + (period - s.periods) * overtime,
    regulation: s.gameMinutes,
  };
}

/**
 * Fraction of REGULATION already played (0..1) for a checkpoint, or null when
 * the sport's clock is unreadable. Measured against each league's own regulation
 * length (NBA 48, WNBA 40, CBB 40), so a finished college game reaches 1.0 and
 * lands in 'late' rather than topping out near 0.5. Overtime clamps to 1. Used
 * only to bucket a checkpoint early/mid/late.
 *
 * @param {Object} cp       replay checkpoint
 * @param {string} sport    'basketball' | 'soccer'
 * @param {string} [league] basketball league id / alias
 */
function progressFraction(cp, sport, league) {
  if (!cp) return null;
  if (sport === 'basketball') {
    const t = basketballElapsed(cp, league);
    if (!t || !(t.regulation > 0)) return null;
    return M.clamp(t.elapsed / t.regulation, 0, 1);
  }
  if (sport === 'soccer') {
    const s = BT.baselines.scoreTime.soccer;
    const clock = M.parseClock(cp.clock);
    if (!clock) return null;
    return M.clamp(clock.minutes / s.regulationMinutes, 0, 1);
  }
  return null;
}

/** early / mid / late bucket label for a progress fraction (null when unknown). */
function bucketFor(progress) {
  if (!Number.isFinite(progress)) return null;
  const edges = BT.bucketEdges || [];
  const labels = BT.bucketLabels || [];
  for (let i = 0; i < edges.length; i++) {
    if (progress < edges[i]) return labels[i] || null;
  }
  return labels[labels.length - 1] || null;
}

/**
 * The "current score and time only" baseline named in the Phase 5 brief.
 *
 * It knows the scoreboard and the clock and NOTHING else: no team, no league, no
 * score effect, no red cards, no shot pressure, no home-court edge. Basketball
 * assumes the remaining margin is symmetric noise that shrinks with sqrt(time);
 * football assumes the remaining goals are plain Poisson at global rates. Both
 * are intentionally weaker than the live model, so the report can say whether
 * the model's extra machinery actually earns its place.
 *
 * @param {Object} cp    a replay checkpoint ({ clock, period, home_score, away_score })
 * @param {string} sport 'basketball' | 'soccer'
 * @param {string} [league] basketball league id / alias (regulation length)
 * @returns {number|null} P(home win), or null when the checkpoint has no clock
 */
function scoreTimeProbability(cp, sport, league) {
  const cfg = BT.baselines && BT.baselines.scoreTime;
  if (!cfg || !cp) return null;

  const home = Number.isFinite(cp.home_score) ? cp.home_score : 0;
  const away = Number.isFinite(cp.away_score) ? cp.away_score : 0;
  const margin = home - away;

  if (sport === 'basketball') {
    const t = basketballElapsed(cp, league);
    if (!t || !(t.total > 0)) return null;
    const b = cfg.basketball;
    const fraction = M.clamp(t.total - t.elapsed, 0, t.total) / t.total;
    const sigma = b.fullMarginSigma * Math.sqrt(fraction);
    if (!(sigma > 0)) return round4(margin > 0 ? 1 : margin < 0 ? 0 : 0.5);
    return round4(1 - M.normalCdf((0 - margin) / sigma));
  }

  if (sport === 'soccer') {
    const s = cfg.soccer;
    const clock = M.parseClock(cp.clock);
    const period = Number(cp.period) || 0;
    if (!clock || period < 1) return null;
    const elapsed = M.clamp(clock.minutes, 0, s.regulationMinutes);
    const fraction = (s.regulationMinutes - elapsed) / s.regulationMinutes;
    const lambdaHome = s.fullHomeGoals * fraction;
    const lambdaAway = s.fullAwayGoals * fraction;
    let homeWin = 0;
    for (let h = 0; h <= s.maxRemainingGoals; h++) {
      const ph = M.poissonPmf(h, lambdaHome);
      if (ph === 0) continue;
      for (let a = 0; a <= s.maxRemainingGoals; a++) {
        if (home + h > away + a) homeWin += ph * M.poissonPmf(a, lambdaAway);
      }
    }
    return round4(M.clamp(homeWin, 0, 1));
  }

  return null;
}

/* -------------------------------------------------------- walk-forward run */

function refit(calibrator, calibRows, cfg) {
  calibRows.forEach((rows, key) => {
    const [sport] = key.split('|');
    calibrator.fit(sport, CALIB_KEY, rows, {
      method: cfg.calibration.method,
      minSamples: cfg.calibration.minSamples,
    });
  });
}

/**
 * Replay every checkpoint of every game, tagging each row with its chronological
 * window. The calibrator applied to a row was fitted on strictly EARLIER games.
 *
 * @param {Array|Object} dataset - { games: [...] } or a bare array of records
 * @param {Object} [opts] { windows, refitEvery, calibrate }
 */
function evaluate(dataset, opts = {}) {
  const windows = normalizeWindows(opts.windows);
  const cfg = { calibration: { ...BT.calibration, ...(opts.calibration || {}) } };
  const refitEvery = opts.refitEvery ?? BT.refitEvery;
  const calibrateEnabled = opts.calibrate !== false;

  const games = (Array.isArray(dataset) ? dataset : (dataset && dataset.games) || [])
    // Hand-typed games are excluded from calibration/coverage: their values were
    // never verified against a provider, so letting them move a fitted
    // calibrator or a hit-rate would be counting unverified input as evidence.
    .filter(g => g && g.manual !== true && g.source !== 'manual')
    .filter(g => g && g.sport && g.final
      && Number.isFinite(g.final.home) && Number.isFinite(g.final.away)
      && Array.isArray(g.checkpoints) && g.checkpoints.length)
    .sort((a, b) => new Date(a.kickoff || 0) - new Date(b.kickoff || 0));

  const calibrator = new Calibrator(cfg);
  const calibRows = new Map();

  const rows = [];
  const failures = [];
  let checkpoints = 0;
  let skipped = 0;
  let missingLine = 0;

  games.forEach((g, i) => {
    const y = g.final.home > g.final.away ? 1 : 0;
    const win = windowOf(i, games.length, windows);
    const pregameLineP = fairHomeProbability(g.line, g.sport);
    if (pregameLineP == null) missingLine++;
    const priorP = priorProbability(g);
    if (priorP == null) {
      failures.push({ gameId: String(g.gameId), reason: 'pre-game prior could not be computed' });
      return;
    }

    g.checkpoints.forEach(cp => {
      checkpoints++;
      let out = null;
      try {
        out = predictLive({ game: gameForCheckpoint(g, cp) });
      } catch (err) {
        failures.push({ gameId: `${g.gameId}:${cp.label}`, reason: err && err.message ? err.message : String(err) });
        return;
      }
      const pRaw = out && out.probabilities ? round4(out.probabilities.home_win) : null;
      if (!out || out.status !== 'live' || !Number.isFinite(pRaw)) {
        skipped++;
        failures.push({
          gameId: `${g.gameId}:${cp.label}`,
          reason: `${out ? out.status : 'no output'} (${out && out.reason ? out.reason : 'checkpoint not modellable'})`,
        });
        return;
      }

      // Applied with the calibrator as of the START of this game (refits happen
      // after a game's rows are produced), so no row sees its own outcome.
      const pCal = calibrateEnabled
        ? round4(calibrator.apply(g.sport, CALIB_KEY, pRaw, 'a'))
        : pRaw;

      const progress = progressFraction(cp, g.sport, g.league);

      rows.push({
        window: win,
        sport: g.sport,
        league: g.league || null,
        gameId: String(g.gameId),
        kickoff: g.kickoff || null,
        checkpoint: cp.label,
        period: cp.period,
        clock: cp.clock,
        home_score: cp.home_score,
        away_score: cp.away_score,
        progress,
        bucket: bucketFor(progress),
        pRaw,
        pCal,
        priorP,
        // Reported for information only — never a comparison reference.
        pregameLineP,
        scoreTimeP: scoreTimeProbability(cp, g.sport, g.league),
        naiveP: BT.naiveProbability,
        y,
      });

      const key = `${g.sport}|${CALIB_KEY}`;
      const buf = calibRows.get(key) || [];
      buf.push({ p: pRaw, y });
      calibRows.set(key, buf);
    });

    if (calibrateEnabled && (i + 1) % refitEvery === 0) refit(calibrator, calibRows, cfg);
  });

  if (calibrateEnabled) refit(calibrator, calibRows, cfg);

  return {
    games: games.length,
    checkpoints,
    skipped,
    missingLine,
    rows,
    calibrator: calibrator.toJSON(),
    failures,
  };
}

/* ------------------------------------------------------------- game grouping */

/**
 * Group graded rows into games. Rows that carry no `gameId` each become their
 * own group, which is what a hand-built unit-test row means.
 */
function groupByGame(rows) {
  const map = new Map();
  let anon = 0;
  (Array.isArray(rows) ? rows : []).forEach(r => {
    const id = r && r.gameId != null ? `g:${r.gameId}` : `r:${anon++}`;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(r);
  });
  return [...map.values()];
}

function countGames(rows) {
  return groupByGame(rows).length;
}

/* ------------------------------------------------------------------ metrics */

/** Metrics for a set of checkpoint rows, scored on the SHIPPED probability. */
function metrics(rows, probKey = 'pShipped') {
  const list = Array.isArray(rows) ? rows : [];
  const graded = list.filter(r => r.y === 0 || r.y === 1);
  const good = graded.filter(r => Number.isFinite(r[probKey]));
  const n = good.length;
  const hits = good.filter(r => r.y === 1).length;
  const calRows = good.map(r => ({ p: r[probKey], y: r.y }));
  const avgPredicted = n ? good.reduce((s, r) => s + r[probKey], 0) / n : null;
  return {
    n,
    games: countGames(good),
    hits,
    hitRate: n ? round4(hits / n) : null,
    avgPredicted: avgPredicted == null ? null : round4(avgPredicted),
    calibrationGap: n ? round4(hits / n - avgPredicted) : null,
    brier: n ? Number(brierScore(calRows).toFixed(4)) : null,
    logLoss: n ? Number(logLoss(calRows).toFixed(4)) : null,
    buckets: calibrationCurve(calRows, BT.curveEdges).map(b => ({
      range: b.range,
      n: b.n,
      predicted: b.predicted == null ? null : round4(b.predicted),
      actual: b.actual == null ? null : round4(b.actual),
    })),
  };
}

/** One probability column scored on the same selections. */
function summariseColumn(rows, key) {
  const good = (Array.isArray(rows) ? rows : [])
    .filter(r => (r.y === 0 || r.y === 1) && Number.isFinite(r[key]));
  if (!good.length) return { n: 0, games: 0, brier: null, logLoss: null, hitRate: null, calibrationGap: null };
  const calRows = good.map(r => ({ p: r[key], y: r.y }));
  const hits = good.filter(r => (r[key] >= 0.5 ? 1 : 0) === r.y).length;
  const avg = good.reduce((s, r) => s + r[key], 0) / good.length;
  return {
    n: good.length,
    games: countGames(good),
    brier: Number(brierScore(calRows).toFixed(4)),
    logLoss: Number(logLoss(calRows).toFixed(4)),
    hitRate: round4(hits / good.length),
    calibrationGap: round4(hits / good.length - avg),
  };
}

/**
 * Model vs every baseline ON THE SAME SELECTIONS.
 *
 * `model` is the SHIPPED probability — the walk-forward calibrated value when
 * the calibration gate kept the calibrator, the raw value when it did not — so
 * the headline comparison is exactly what the UI would have shown. The raw and
 * walk-forward-calibrated columns are kept alongside so the calibrator's effect
 * is visible rather than hidden. Then the two named references: pre-game only
 * (`prior`) and current-score-and-time-only (`scoreTime`), plus the pre-game
 * line (information only — NOT comparable) and a naive coin flip.
 */
function compareBaselines(rows) {
  return {
    model: summariseColumn(rows, 'pShipped'),
    modelUncalibrated: summariseColumn(rows, 'pRaw'),
    walkForwardCalibrated: summariseColumn(rows, 'pCal'),
    prior: summariseColumn(rows, 'priorP'),
    scoreTime: summariseColumn(rows, 'scoreTimeP'),
    // Reported for information only. One closing price per game applied at every
    // checkpoint, so it is not a reference the live model can be judged against.
    pregameLine: summariseColumn(rows, 'pregameLineP'),
    naive: summariseColumn(rows, 'naiveP'),
  };
}

/**
 * Stamp the SHIPPED probability onto every row: the walk-forward calibrated
 * value when the calibration gate kept the calibrator for that sport, the raw
 * value when it did not. This is exactly what the UI would display, so every
 * headline metric and the ship gate are scored on it — NEVER on the un-gated
 * calibrated value. Mutates the rows and returns them.
 *
 * @param {Array} rows        checkpoint rows from evaluate()
 * @param {Object} calibration the per-sport verdict from calibrationGate()
 */
function stampShipped(rows, calibration) {
  const gate = calibration || {};
  (Array.isArray(rows) ? rows : []).forEach(r => {
    const c = gate[r.sport];
    r.pShipped = (c && c.kept && Number.isFinite(r.pCal)) ? r.pCal : r.pRaw;
  });
  return rows;
}

/* -------------------------------------------------------------- statistics */

/** Wilson score interval lower bound for a proportion. */
function wilsonLowerBound(hits, n, z) {
  if (!(n > 0)) return null;
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

/** Percentile of an ascending-sorted array (nearest-rank). */
function percentile(sorted, q) {
  if (!sorted || !sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx];
}

const CI_LOW_Q = 0.025;
const CI_HIGH_Q = 0.975;

function summariseDraw(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    n: values.length,
    lower: round4(percentile(sorted, CI_LOW_Q)),
    upper: round4(percentile(sorted, CI_HIGH_Q)),
  };
}

/**
 * Percentile bootstrap over WHOLE GAMES.
 *
 * Checkpoints inside one game are not independent — they share the game's
 * outcome — so resampling rows would report an interval far narrower than the
 * evidence supports. Each iteration resamples games with replacement, pools
 * their checkpoints, and recomputes the hit rate and the Brier / log-loss gain
 * against the reference baseline. The returned `lower`/`upper` are the 2.5th and
 * 97.5th percentiles.
 *
 * @param {Array} rows   graded checkpoint rows
 * @param {Object} [opts] { iterations, seed, probKey, referenceKey }
 */
function gameBootstrap(rows, opts = {}) {
  const cfg = { ...BT.shipGate.bootstrap, ...(opts.bootstrap || {}) };
  const iterations = Math.max(1, Number(cfg.iterations) || 1);
  const probKey = opts.probKey || 'pShipped';
  const referenceKey = opts.referenceKey || 'scoreTimeP';

  const good = (Array.isArray(rows) ? rows : [])
    .filter(r => (r.y === 0 || r.y === 1) && Number.isFinite(r[probKey]));
  const games = groupByGame(good);
  if (!games.length) return { iterations: 0, games: 0, hitRate: null, brierGain: null, logLossGain: null };

  const rand = mulberry32(cfg.seed);
  const draws = { hitRate: [], brierGain: [], logLossGain: [] };

  for (let it = 0; it < iterations; it++) {
    const sample = [];
    for (let i = 0; i < games.length; i++) {
      const g = games[Math.floor(rand() * games.length)];
      for (let j = 0; j < g.length; j++) sample.push(g[j]);
    }
    const model = summariseColumn(sample, probKey);
    const reference = summariseColumn(sample, referenceKey);
    if (model.hitRate != null) draws.hitRate.push(model.hitRate);
    if (model.brier != null && reference.brier != null) draws.brierGain.push(reference.brier - model.brier);
    if (model.logLoss != null && reference.logLoss != null) draws.logLossGain.push(reference.logLoss - model.logLoss);
  }

  return {
    iterations,
    games: games.length,
    hitRate: summariseDraw(draws.hitRate),
    brierGain: summariseDraw(draws.brierGain),
    logLossGain: summariseDraw(draws.logLossGain),
  };
}

/* --------------------------------------------------------- calibration gate */

/**
 * Fit a calibrator per sport on the training window and judge it on the
 * validation window via the shared identity gate. A sport whose fit does not
 * clear BOTH metrics (and stay monotone) keeps the identity — we never ship a
 * calibrator that has not earned its place.
 */
function calibrationGate(rows, opts = {}) {
  const cfg = { ...BT.calibration, ...(opts.calibration || {}) };
  const sports = [...new Set((Array.isArray(rows) ? rows : []).map(r => r.sport))].sort();
  const out = {};

  sports.forEach(sport => {
    const train = (rows || [])
      .filter(r => r.sport === sport && r.window === 'train')
      .map(r => ({ p: r.pRaw, y: r.y }));
    const validation = (rows || [])
      .filter(r => r.sport === sport && r.window === 'validation')
      .map(r => ({ p: r.pRaw, y: r.y, side: 'a' }));

    const calibrator = new Calibrator({ calibration: cfg });
    const model = calibrator.fit(sport, CALIB_KEY, train, {
      method: cfg.method,
      minSamples: cfg.minSamples,
    });
    const verdict = validateAgainstIdentity({
      rows: validation,
      model,
      minSamples: cfg.minSamples,
      minImprovementBrier: cfg.minImprovementBrier,
      minImprovementLogLoss: cfg.minImprovementLogLoss,
      requireMonotone: cfg.requireMonotone,
    });

    out[sport] = {
      method: cfg.method,
      fitted: Boolean(model),
      trainedOn: train.length,
      validatedOn: validation.length,
      monotone: verdict.monotone,
      brierGain: verdict.brierGain == null ? null : round4(verdict.brierGain),
      logLossGain: verdict.logLossGain == null ? null : round4(verdict.logLossGain),
      minImprovementBrier: cfg.minImprovementBrier,
      minImprovementLogLoss: cfg.minImprovementLogLoss,
      kept: verdict.improved,
      model: verdict.improved ? model : null,
    };
  });

  return out;
}

/* --------------------------------------------------------------- ship gate */

/**
 * Per-sport ship verdict on the out-of-sample test window.
 *
 * Every clause must pass and every failure is named. The gate is counted in
 * GAMES and its intervals are bootstrapped over whole games (see gameBootstrap).
 * The reference is the score-and-time baseline; the pre-game line is not a
 * reference (see the module header). Scored on the SHIPPED probability, i.e.
 * exactly what the UI would display.
 */
function shipGate(rows, opts = {}) {
  const cfg = { ...BT.shipGate, ...(opts.shipGate || {}) };
  const probKey = opts.probKey || 'pShipped';
  const referenceKey = opts.referenceKey || 'scoreTimeP';

  const graded = (Array.isArray(rows) ? rows : [])
    .filter(r => (r.y === 0 || r.y === 1) && Number.isFinite(r[probKey]));
  const games = countGames(graded);
  const model = summariseColumn(graded, probKey);
  const reference = summariseColumn(graded, referenceKey);
  const reasons = [];

  if (games < cfg.minGames) reasons.push(`out-of-sample games ${games} < ${cfg.minGames}`);
  if (reference.n === 0) reasons.push('score-and-time baseline unavailable for these checkpoints');

  const brierGain = (model.brier != null && reference.brier != null) ? round4(reference.brier - model.brier) : null;
  const logLossGain = (model.logLoss != null && reference.logLoss != null) ? round4(reference.logLoss - model.logLoss) : null;

  const boot = gameBootstrap(graded, { bootstrap: cfg.bootstrap, probKey, referenceKey });

  if (brierGain == null) reasons.push('Brier gain unavailable (model or baseline probabilities missing)');
  else if (brierGain < cfg.minImprovementBrier) reasons.push(`Brier gain ${brierGain} < ${cfg.minImprovementBrier}`);
  else if (boot.brierGain && boot.brierGain.lower != null && boot.brierGain.lower <= 0) {
    reasons.push(`Brier gain ${cfg.confidence * 100}% CI lower bound ${boot.brierGain.lower} <= 0`);
  }

  if (logLossGain == null) reasons.push('log loss gain unavailable');
  else if (logLossGain < cfg.minImprovementLogLoss) reasons.push(`log loss gain ${logLossGain} < ${cfg.minImprovementLogLoss}`);
  else if (boot.logLossGain && boot.logLossGain.lower != null && boot.logLossGain.lower <= 0) {
    reasons.push(`log loss gain ${cfg.confidence * 100}% CI lower bound ${boot.logLossGain.lower} <= 0`);
  }

  const hitLower = boot.hitRate ? boot.hitRate.lower : null;
  if (hitLower == null) reasons.push('hit-rate confidence interval unavailable');
  else if (hitLower <= cfg.breakEvenProbability) {
    reasons.push(`hit-rate ${cfg.confidence * 100}% CI lower bound ${round4(hitLower)} <= break-even ${cfg.breakEvenProbability}`);
  }

  return {
    games,
    rows: graded.length,
    hitRate: model.hitRate,
    hitRateLowerBound: hitLower,
    breakEvenProbability: cfg.breakEvenProbability,
    minGames: cfg.minGames,
    minImprovementBrier: cfg.minImprovementBrier,
    minImprovementLogLoss: cfg.minImprovementLogLoss,
    referenceKey,
    model,
    reference,
    brierGain,
    logLossGain,
    bootstrap: boot,
    passed: reasons.length === 0,
    reasons,
  };
}

/**
 * Per-league sanity check against the sport-level result.
 *
 * A league's own sample is too small to gate on independently, but if a league's
 * own numbers outright CONTRADICT the sport-level verdict — the model is worse
 * than the score-and-time baseline on that league's games — it is blocked, so a
 * sport-level pass cannot quietly drag a league where the model loses. Leagues
 * below `minLeagueGames` are not judged (`judged: false`); absence of evidence
 * is not a contradiction.
 */
function leagueSanity(rows, opts = {}) {
  const cfg = { ...BT.shipGate, ...(opts.shipGate || {}) };
  const probKey = opts.probKey || 'pShipped';
  const referenceKey = opts.referenceKey || 'scoreTimeP';

  const out = {};
  const keys = [...new Set((Array.isArray(rows) ? rows : []).map(r => `${r.sport}|${r.league}`))].sort();

  keys.forEach(key => {
    const list = (rows || []).filter(r => `${r.sport}|${r.league}` === key);
    const graded = list.filter(r => (r.y === 0 || r.y === 1) && Number.isFinite(r[probKey]));
    const games = countGames(graded);
    const model = summariseColumn(graded, probKey);
    const reference = summariseColumn(graded, referenceKey);
    const brierGain = (model.brier != null && reference.brier != null) ? round4(reference.brier - model.brier) : null;
    const logLossGain = (model.logLoss != null && reference.logLoss != null) ? round4(reference.logLoss - model.logLoss) : null;
    const judged = games >= cfg.minLeagueGames;

    const reasons = [];
    if (judged) {
      if (brierGain != null && brierGain < 0) reasons.push(`Brier worse than the score-and-time baseline by ${round4(-brierGain)}`);
      if (logLossGain != null && logLossGain < 0) reasons.push(`log loss worse than the score-and-time baseline by ${round4(-logLossGain)}`);
    }

    out[key] = {
      sport: list.length ? list[0].sport : null,
      league: list.length ? list[0].league : null,
      minLeagueGames: cfg.minLeagueGames,
      games,
      rows: graded.length,
      judged,
      brierGain,
      logLossGain,
      hitRate: model.hitRate,
      blocked: judged && reasons.length > 0,
      reasons,
    };
  });

  return out;
}

/* -------------------------------------------------------------- public API */

function buildVerdict(baselines, shipBySport, opts = {}) {
  const m = baselines.model;
  const st = baselines.scoreTime;
  const cfg = { ...BT.shipGate, ...(opts.shipGate || {}) };
  const games = m.games != null ? m.games : 0;
  const shipped = Object.values(shipBySport || {}).filter(g => g.passed);
  const beatsBrier = (m.brier != null && st.brier != null) ? m.brier < st.brier : null;
  const beatsLogLoss = (m.logLoss != null && st.logLoss != null) ? m.logLoss < st.logLoss : null;
  const failedReasons = [...new Set(
    Object.values(shipBySport || {}).flatMap(g => g.reasons || []),
  )];
  let statement;
  if (games < cfg.minGames) {
    statement = `Not enough graded out-of-sample games to judge (${games} < ${cfg.minGames}); treat every figure as indicative only.`;
  } else if (shipped.length) {
    statement = `Gate PASSED for ${shipped.length} sport bucket(s): the shipped live probability beats the score-and-time baseline on BOTH Brier and log loss (gain interval above zero) with a hit-rate lower bound above break-even.`;
  } else if (beatsBrier === true && beatsLogLoss === true) {
    statement = `Gate NOT passed, but on ${games} out-of-sample games the shipped projection beat the score-and-time baseline on BOTH metrics (Brier ${m.brier} vs ${st.brier}; log loss ${m.logLoss} vs ${st.logLoss}). It fell short only on the sample-size or hit-rate confidence clause${failedReasons.length ? ` (${failedReasons.join('; ')})` : ''}. Projection only; no live pick.`;
  } else if (beatsBrier === true || beatsLogLoss === true) {
    statement = `Gate NOT passed. The projection beat the score-and-time baseline on ${beatsLogLoss ? 'log loss' : 'Brier'} only (Brier ${m.brier} vs ${st.brier}; log loss ${m.logLoss} vs ${st.logLoss}) on ${games} out-of-sample games. Projection only; no live pick.`;
  } else {
    statement = `Gate NOT passed. The score-and-time baseline is the better probability (Brier ${st.brier} vs ${m.brier}; log loss ${st.logLoss} vs ${m.logLoss}) on ${games} out-of-sample games. Projection only; no live pick.`;
  }
  return {
    reference: 'score-and-time',
    beatsScoreTimeBrier: beatsBrier,
    beatsScoreTimeLogLoss: beatsLogLoss,
    modelBrier: m.brier,
    scoreTimeBrier: st.brier,
    modelLogLoss: m.logLoss,
    scoreTimeLogLoss: st.logLoss,
    games,
    shipped: shipped.length > 0,
    shippedBuckets: shipped.map(g => g.key || null),
    failedReasons,
    statement,
  };
}

/**
 * Games per sport -> season -> league, with the kick-off date range each slice
 * actually covers. This is the coverage report: it says which leagues resolved
 * through which season, and how many games backed every number above.
 */
function coverageReport(games) {
  const out = {};
  (Array.isArray(games) ? games : []).forEach(g => {
    if (!g || !g.sport) return;
    const season = (g.meta && g.meta.season) || 'unlabelled';
    const league = g.league || 'unknown';
    const at = g.kickoff || null;

    if (!out[g.sport]) out[g.sport] = { games: 0, seasons: {} };
    out[g.sport].games++;

    const seasons = out[g.sport].seasons;
    if (!seasons[season]) seasons[season] = { games: 0, from: null, to: null, leagues: {} };
    const s = seasons[season];
    s.games++;
    track(s, at);

    if (!s.leagues[league]) s.leagues[league] = { games: 0, from: null, to: null };
    const l = s.leagues[league];
    l.games++;
    track(l, at);
  });
  return out;
}

/** Extend a { from, to } window with a kick-off timestamp (in place). */
function track(node, at) {
  if (!at) return;
  if (!node.from || at < node.from) node.from = at;
  if (!node.to || at > node.to) node.to = at;
}

/**
 * Run the full validation and return an honest report.
 *
 * @param {Array|Object} dataset - { games: [...] } (see ./replay)
 * @param {Object} [opts] { windows, calibrate, refitEvery, probKey, referenceKey, calibration, shipGate }
 */
function runLiveBacktest(dataset, opts = {}) {
  const windows = normalizeWindows(opts.windows);
  const ev = evaluate(dataset, { ...opts, windows });
  const probKey = opts.probKey || 'pShipped';
  const referenceKey = opts.referenceKey || 'scoreTimeP';

  // The calibration verdict comes first: it decides, per sport, whether the
  // shipped probability is the calibrated or the raw value. Everything scored
  // below (headline metrics, baselines, ship gate) uses that shipped value, so
  // the report can never quote an un-gated calibrator as if it had shipped.
  const calibration = calibrationGate(ev.rows, opts);
  stampShipped(ev.rows, calibration);

  const gamesList = Array.isArray(dataset) ? dataset : (dataset && dataset.games) || [];
  const kicks = gamesList.map(g => g.kickoff).filter(Boolean).sort();

  const sports = [...new Set(ev.rows.map(r => r.sport))].sort();
  const checkpoints = [...new Set(ev.rows.map(r => `${r.sport}|${r.checkpoint}`))].sort();
  const bucketLabels = BT.bucketLabels || [];

  const byWindow = {};
  ['train', 'validation', 'test'].forEach(w => {
    byWindow[w] = metrics(ev.rows.filter(r => r.window === w), probKey);
  });

  const bySport = {};
  sports.forEach(s => { bySport[s] = metrics(ev.rows.filter(r => r.sport === s), probKey); });

  const byCheckpoint = {};
  checkpoints.forEach(key => {
    const list = ev.rows.filter(r => `${r.sport}|${r.checkpoint}` === key);
    byCheckpoint[key] = {
      sport: list.length ? list[0].sport : null,
      checkpoint: list.length ? list[0].checkpoint : null,
      belowMinSamples: list.length < BT.minCheckpointSamples,
      ...metrics(list, probKey),
    };
  });

  const byLeague = {};
  [...new Set(ev.rows.map(r => `${r.sport}|${r.league}`))].sort().forEach(key => {
    byLeague[key] = metrics(ev.rows.filter(r => `${r.sport}|${r.league}` === key), probKey);
  });

  const coverage = coverageReport(gamesList);

  const testRows = ev.rows.filter(r => r.window === 'test');
  const baselines = { test: compareBaselines(testRows), all: compareBaselines(ev.rows) };

  // Time buckets, per sport, on the out-of-sample window. `excludingLate` is the
  // honest headline: late checkpoints are near-decided and would inflate it.
  const byTimeBucket = {};
  sports.forEach(s => {
    const sportTest = testRows.filter(r => r.sport === s);
    byTimeBucket[s] = {};
    bucketLabels.forEach(b => {
      const list = sportTest.filter(r => r.bucket === b);
      byTimeBucket[s][b] = { ...metrics(list, probKey), reference: summariseColumn(list, referenceKey) };
    });
    byTimeBucket[s].excludingLate = metrics(sportTest.filter(r => r.bucket !== 'late'), probKey);
  });

  const shipBySport = {};
  sports.forEach(s => {
    const sportTest = testRows.filter(r => r.sport === s);
    const verdict = shipGate(sportTest, { ...opts, probKey, referenceKey });
    const leagues = leagueSanity(sportTest, { ...opts, probKey, referenceKey });
    shipBySport[s] = {
      key: s,
      ...verdict,
      leagues,
      blockedLeagues: Object.entries(leagues).filter(([, v]) => v.blocked).map(([k]) => k),
    };
  });

  return {
    modelVersion: MODEL_VERSION,
    generatedAt: new Date().toISOString(),
    dataset: {
      games: ev.games,
      checkpoints: ev.checkpoints,
      skipped: ev.skipped,
      missingLine: ev.missingLine,
      sports,
      from: kicks[0] || null,
      to: kicks[kicks.length - 1] || null,
    },
    windows,
    counts: { games: ev.games, checkpoints: ev.checkpoints, graded: ev.rows.length },
    overall: metrics(ev.rows, probKey),
    uncalibrated: metrics(ev.rows, 'pRaw'),
    byWindow,
    bySport,
    byCheckpoint,
    byLeague,
    coverage,
    baselines,
    byTimeBucket,
    calibration,
    shipGate: { bySport: shipBySport },
    verdict: buildVerdict(baselines.test, shipBySport, opts),
    failures: ev.failures.slice(0, 50),
    failureCount: ev.failures.length,
  };
}

/* ------------------------------------------------------------ report text */

function pct(v) {
  return v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
}

function fmtNum(v, dp = 4) {
  return v == null ? 'n/a' : Number(v).toFixed(dp);
}

function fmtMetrics(label, m) {
  const lines = [
    `${label}`,
    `  rows ${m.n}  games ${m.games}  hit rate ${pct(m.hitRate)}  avg predicted ${pct(m.avgPredicted)}  gap ${m.calibrationGap == null ? 'n/a' : (m.calibrationGap > 0 ? '+' : '') + (m.calibrationGap * 100).toFixed(1) + 'pp'}`,
    `  Brier ${fmtNum(m.brier)}  log loss ${fmtNum(m.logLoss)}`,
  ];
  const buckets = (m.buckets || []).filter(b => b.n > 0).map(b => `${b.range}: n=${b.n} pred ${pct(b.predicted)} actual ${pct(b.actual)}`);
  if (buckets.length) lines.push(`  buckets -> ${buckets.join(' | ')}`);
  return lines.join('\n');
}

/** Render the report as a readable multi-line string. */
function formatReport(report) {
  const out = [];
  out.push(`# Live backtest — ${report.modelVersion}`);
  out.push(`dataset: ${report.dataset.games} games, ${report.dataset.checkpoints} checkpoints (${report.dataset.sports.join(', ') || 'n/a'})`);
  out.push(`  ${report.dataset.from || '?'} -> ${report.dataset.to || '?'}  skipped ${report.dataset.skipped}  no-line ${report.dataset.missingLine}`);
  out.push(`windows: train ${report.windows.train.join('-')} validation ${report.windows.validation.join('-')} test ${report.windows.test.join('-')}`);
  out.push('');

  out.push('Coverage (games per sport / season / league):');
  Object.entries(report.coverage || {}).forEach(([sport, s]) => {
    out.push(`  ${sport} — ${s.games} games`);
    Object.entries(s.seasons).forEach(([season, v]) => {
      out.push(`    ${season}: ${v.games} games  (${(v.from || '?').slice(0, 10)} -> ${(v.to || '?').slice(0, 10)})`);
      Object.entries(v.leagues).sort().forEach(([league, l]) => {
        out.push(`      ${String(league).padEnd(22)} ${String(l.games).padStart(5)} games`);
      });
    });
  });
  out.push('');

  out.push(fmtMetrics('Overall (all checkpoints)', report.overall));
  out.push('');
  ['train', 'validation', 'test'].forEach(w => out.push(fmtMetrics(`Window: ${w}`, report.byWindow[w]) + '\n'));

  out.push('Baselines (test window, same selections):');
  const b = report.baselines.test;
  ['model', 'modelUncalibrated', 'walkForwardCalibrated', 'scoreTime', 'prior', 'pregameLine', 'naive'].forEach(k => {
    const label = k === 'pregameLine' ? 'pregameLine (info only, not comparable)' : k;
    out.push(`  ${label.padEnd(38)} log loss ${fmtNum(b[k].logLoss)}  Brier ${fmtNum(b[k].brier)}  hit ${pct(b[k].hitRate)}  n ${b[k].n}  games ${b[k].games}`);
  });
  out.push('');

  out.push('By time bucket (test window; late checkpoints are near-decided):');
  Object.entries(report.byTimeBucket || {}).forEach(([sport, buckets]) => {
    Object.entries(buckets).forEach(([label, m]) => {
      const ref = m.reference ? `  ref scoreTime log loss ${fmtNum(m.reference.logLoss)}` : '';
      out.push(`  ${sport.padEnd(11)} ${label.padEnd(14)} rows ${String(m.n).padStart(6)}  games ${String(m.games).padStart(4)}  hit ${pct(m.hitRate)}  Brier ${fmtNum(m.brier)}  log loss ${fmtNum(m.logLoss)}${ref}`);
    });
  });
  out.push('');

  out.push('Calibration gate (train -> validation, identity unless it earns its place):');
  Object.entries(report.calibration).forEach(([sport, c]) => {
    out.push(`  ${sport.padEnd(12)} fitted ${c.fitted}  monotone ${c.monotone}  Brier gain ${fmtNum(c.brierGain)}  log loss gain ${fmtNum(c.logLossGain)}  kept ${c.kept}  (trained ${c.trainedOn} / validated ${c.validatedOn})`);
  });
  out.push('');

  out.push(`Ship gate (out-of-sample test window; reference: ${report.verdict.reference}):`);
  Object.values(report.shipGate.bySport).forEach(g => {
    out.push(`  sport ${String(g.key).padEnd(12)} ${g.passed ? 'PASS' : 'FAIL'}  games ${g.games}/${g.minGames}  rows ${g.rows}  hit ${pct(g.hitRate)} CI-low ${pct(g.hitRateLowerBound)}  Brier gain ${fmtNum(g.brierGain)}  log loss gain ${fmtNum(g.logLossGain)}`);
    if (g.bootstrap && g.bootstrap.brierGain) {
      out.push(`      Brier gain CI [${fmtNum(g.bootstrap.brierGain.lower)}, ${fmtNum(g.bootstrap.brierGain.upper)}]  log loss gain CI [${fmtNum(g.bootstrap.logLossGain.lower)}, ${fmtNum(g.bootstrap.logLossGain.upper)}]  (${g.bootstrap.iterations} game-level resamples)`);
    }
    if (!g.passed) g.reasons.forEach(r => out.push(`      - ${r}`));
    Object.values(g.leagues || {}).forEach(l => {
      const flag = l.blocked ? 'BLOCKED' : l.judged ? 'ok' : 'unjudged';
      out.push(`      league ${String(l.league).padEnd(20)} ${flag.padEnd(9)} games ${String(l.games).padStart(4)}  Brier gain ${fmtNum(l.brierGain)}  log loss gain ${fmtNum(l.logLossGain)}`);
      if (l.blocked) l.reasons.forEach(r => out.push(`          ! ${r}`));
    });
  });
  out.push('');

  out.push(`verdict: ${report.verdict.statement}`);
  if (report.failureCount) out.push(`skipped/failed checkpoints: ${report.failureCount} (e.g. ${report.failures.slice(0, 3).map(f => f.reason).join('; ')})`);
  out.push('');
  out.push('Predictions are statistical estimates, not betting advice. A 68% pick still loses about 1 in 3 times.');
  return out.join('\n');
}

module.exports = {
  MODEL_VERSION,
  DEFAULT_WINDOWS,
  CALIB_KEY,
  normalizeWindows,
  windowOf,
  gameForCheckpoint,
  priorProbability,
  fairHomeProbability,
  basketballStructure,
  basketballElapsed,
  progressFraction,
  bucketFor,
  scoreTimeProbability,
  evaluate,
  groupByGame,
  countGames,
  metrics,
  summariseColumn,
  compareBaselines,
  stampShipped,
  wilsonLowerBound,
  percentile,
  gameBootstrap,
  calibrationGate,
  shipGate,
  leagueSanity,
  buildVerdict,
  coverageReport,
  runLiveBacktest,
  formatReport,
};
