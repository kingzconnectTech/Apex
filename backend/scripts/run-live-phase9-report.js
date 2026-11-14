#!/usr/bin/env node
/**
 * scripts/run-live-phase9-report.js
 *
 * Phase 9 — supplementary validation reports that Phase 8 did not print.
 *
 * It reuses the Phase 5/8 harness (services/live/backtester) against the same
 * ESPN history, so every number below is scored exactly as the ship gate scores
 * its own, and adds four things:
 *
 *   A. Basketball per-league holdout (NBA / WNBA / CBB). Phase 8 split the WHOLE
 *      dataset chronologically once, so the last 20% (the test window) contained
 *      no WNBA games — the WNBA season ends in October, before the basketball
 *      tail. Here each league is split on ITS OWN calendar (train 60 / validate
 *      20 / test 20), which gives every league an out-of-sample window and makes
 *      it possible to see whether the sport-level pass was carried by one league.
 *
 *   B. Soccer score-and-time ABSOLUTE calibration. Phase 8 only asked whether
 *      the live model beat the baseline; this report asks whether the baseline
 *      ITSELF is well calibrated on the soccer test window — reliability curve,
 *      Brier, log loss, by time bucket, by league, the draw column, and 95%
 *      game-level intervals.
 *
 *   C. Market coverage: which markets the Phase 8 gate actually scored.
 *
 *   D. Latency sensitivity: the replay assumes the checkpoint state is exact
 *      (0 s old). Real live reads carry staleness. This measures how far the
 *      probability and the Brier score move when the clock is delayed by a
 *      realistic 30 / 60 / 90 s.
 *
 * Output: human-readable tables on stdout and a JSON object (--out).
 *
 * Usage:
 *   node scripts/run-live-phase9-report.js --out=data/live-report-phase9.json
 */

const fs = require('fs');
const path = require('path');

const LIVE_CONFIG = require('../services/live/config');
const M = require('../services/live/liveMath');
const {
  evaluate, calibrationGate, stampShipped, shipGate,
  metrics, summariseColumn, groupByGame,
} = require('../services/live/backtester');
const {
  brierScore, logLoss, calibrationCurve,
} = require('../services/basketball/calibration');
const { gameForCheckpoint } = require('../services/live/backtester');
const { predictLive } = require('../services/live/liveModel');
const { loadDatasetFromEspn } = require('./run-live-backtest');

const BT = LIVE_CONFIG.liveBacktest;
const DATASET = BT.dataset;
const BACKEND_DIR = path.join(__dirname, '..');

const BASKETBALL_LEAGUES = ['nba', 'wnba', 'mens-college-basketball'];

function round4(v) {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(4));
}

function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx];
}

/** 2.5/97.5 percentile interval of an array of draws. */
function ci(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  return { n: s.length, lower: round4(percentile(s, 0.025)), upper: round4(percentile(s, 0.975)) };
}

/**
 * Percentile bootstrap over WHOLE GAMES for the ABSOLUTE metrics of one
 * probability column (its own Brier / log loss / hit rate, not a gain).
 * Checkpoints inside a game are not independent, so games are the resampling
 * unit — same rule the ship gate uses.
 */
function absoluteBootstrap(rows, probKey, outcomeKey, opts = {}) {
  const iterations = opts.iterations || BT.shipGate.bootstrap.iterations;
  const seed = opts.seed || BT.shipGate.bootstrap.seed;
  const good = rows.filter(r => (r[outcomeKey] === 0 || r[outcomeKey] === 1) && Number.isFinite(r[probKey]));
  const games = groupByGame(good);
  if (!games.length) return { iterations: 0, games: 0 };
  const rand = mulberry32(seed);
  const draws = { brier: [], logLoss: [], hitRate: [] };
  for (let it = 0; it < iterations; it++) {
    const sample = [];
    for (let i = 0; i < games.length; i++) {
      const g = games[Math.floor(rand() * games.length)];
      for (const r of g) sample.push(r);
    }
    const pairs = sample.map(r => ({ p: r[probKey], y: r[outcomeKey] }));
    draws.brier.push(Number(brierScore(pairs).toFixed(6)));
    draws.logLoss.push(Number(logLoss(pairs).toFixed(6)));
    const hits = sample.filter(r => (r[probKey] >= 0.5 ? 1 : 0) === r[outcomeKey]).length;
    draws.hitRate.push(hits / sample.length);
  }
  return { iterations, games: games.length, brier: ci(draws.brier), logLoss: ci(draws.logLoss), hitRate: ci(draws.hitRate) };
}

/* ------------------------------------------------------------------ A: per-league basketball */

/** Evaluate one league on its own chronological calendar and summarise the test window. */
function leagueHoldout(dataset, league) {
  const games = (dataset.games || []).filter(g => g.sport === 'basketball' && g.league === league);
  const ev = evaluate({ games });
  const calibration = calibrationGate(ev.rows);
  stampShipped(ev.rows, calibration);
  const testRows = ev.rows.filter(r => r.window === 'test');
  const verdict = shipGate(testRows);
  return {
    league,
    gamesAvailable: games.length,
    checkpoints: ev.checkpoints,
    skipped: ev.skipped,
    windows: {
      train: ev.rows.filter(r => r.window === 'train').length,
      validation: ev.rows.filter(r => r.window === 'validation').length,
      test: testRows.length,
    },
    calibrationKept: Boolean(calibration.basketball && calibration.basketball.kept),
    test: {
      games: verdict.games,
      rows: verdict.rows,
      hitRate: verdict.hitRate,
      hitRateCI: verdict.bootstrap.hitRate,
      breakEvenProbability: verdict.breakEvenProbability,
      model: verdict.model,
      reference: verdict.reference,
      brierGain: verdict.brierGain,
      logLossGain: verdict.logLossGain,
      brierGainCI: verdict.bootstrap.brierGain,
      logLossGainCI: verdict.bootstrap.logLossGain,
      passed: verdict.passed,
      reasons: verdict.reasons,
    },
  };
}

/* ------------------------------------------------------------------ B: soccer scoreTime absolute calibration */

/**
 * The score-and-time baseline as implemented is a home-win probability only.
 * To let the draw be judged, the SAME remaining-goals Poisson is extended to
 * three outcomes (win / draw / loss). This is the baseline's own construction on
 * its own numbers, not the anchored model — the anchored model stays in shadow.
 */
function scoreTimeThreeWay(row) {
  const s = BT.baselines.scoreTime.soccer;
  const clock = M.parseClock(row.clock);
  const period = Number(row.period) || 0;
  if (!clock || period < 1) return null;
  const elapsed = M.clamp(clock.minutes, 0, s.regulationMinutes);
  const fraction = (s.regulationMinutes - elapsed) / s.regulationMinutes;
  const lh = s.fullHomeGoals * fraction;
  const la = s.fullAwayGoals * fraction;
  const home = Number.isFinite(row.home_score) ? row.home_score : 0;
  const away = Number.isFinite(row.away_score) ? row.away_score : 0;
  let h = 0; let d = 0; let a = 0;
  for (let i = 0; i <= s.maxRemainingGoals; i++) {
    const ph = M.poissonPmf(i, lh);
    if (!ph) continue;
    for (let j = 0; j <= s.maxRemainingGoals; j++) {
      const p = ph * M.poissonPmf(j, la);
      if (!p) continue;
      const fh = home + i; const fa = away + j;
      if (fh > fa) h += p; else if (fh === fa) d += p; else a += p;
    }
  }
  const sum = h + d + a;
  if (!(sum > 0)) return null;
  return { home: h / sum, draw: d / sum, away: a / sum };
}

/** Boundary binning for a reliability curve (mirrors backtester.metrics). */
function curveFor(rows, probKey, outcomeKey) {
  const pairs = rows
    .filter(r => (r[outcomeKey] === 0 || r[outcomeKey] === 1) && Number.isFinite(r[probKey]))
    .map(r => ({ p: r[probKey], y: r[outcomeKey] }));
  return calibrationCurve(pairs, BT.curveEdges).map(b => ({
    range: b.range,
    n: b.n,
    predicted: b.predicted == null ? null : round4(b.predicted),
    actual: b.actual == null ? null : round4(b.actual),
  }));
}

/** Headline metrics for one probability column against a chosen outcome. */
function columnMetrics(rows, probKey, outcomeKey) {
  const good = rows.filter(r => (r[outcomeKey] === 0 || r[outcomeKey] === 1) && Number.isFinite(r[probKey]));
  if (!good.length) return { n: 0, games: 0, brier: null, logLoss: null, hitRate: null };
  const pairs = good.map(r => ({ p: r[probKey], y: r[outcomeKey] }));
  const hits = good.filter(r => (r[probKey] >= 0.5 ? 1 : 0) === r[outcomeKey]).length;
  return {
    n: good.length,
    games: groupByGame(good).length,
    brier: Number(brierScore(pairs).toFixed(4)),
    logLoss: Number(logLoss(pairs).toFixed(4)),
    hitRate: round4(hits / good.length),
    curve: curveFor(good, probKey, outcomeKey),
  };
}

function soccerScoreTimeReport(dataset, full) {
  // Outcome per game so the draw column can be graded (rows only carry y).
  const outcome = new Map();
  (dataset.games || []).forEach(g => {
    if (!g || !g.final) return;
    const fh = g.final.home; const fa = g.final.away;
    outcome.set(String(g.gameId), {
      y: fh > fa ? 1 : 0,
      yDraw: fh === fa ? 1 : 0,
      yAway: fa > fh ? 1 : 0,
    });
  });

  const testRows = full.rows
    .filter(r => r.window === 'test' && r.sport === 'soccer')
    .map(r => {
      const o = outcome.get(String(r.gameId)) || { y: r.y, yDraw: null, yAway: null };
      const three = scoreTimeThreeWay(r);
      return {
        ...r,
        yDraw: o.yDraw,
        yAway: o.yAway,
        stHome: three ? round4(three.home) : r.scoreTimeP,
        stDraw: three ? round4(three.draw) : null,
        stAway: three ? round4(three.away) : null,
      };
    });

  const home = columnMetrics(testRows, 'scoreTimeP', 'y');
  const draw = columnMetrics(testRows, 'stDraw', 'yDraw');
  const away = columnMetrics(testRows, 'stAway', 'yAway');
  const bucketLabels = BT.bucketLabels || [];
  const byBucket = {};
  bucketLabels.concat('excludingLate').forEach(b => {
    const list = b === 'excludingLate'
      ? testRows.filter(r => r.bucket !== 'late')
      : testRows.filter(r => r.bucket === b);
    byBucket[b] = columnMetrics(list, 'scoreTimeP', 'y');
  });

  const byLeague = {};
  [...new Set(testRows.map(r => r.league))].sort().forEach(league => {
    const list = testRows.filter(r => r.league === league);
    byLeague[league] = columnMetrics(list, 'scoreTimeP', 'y');
  });

  return {
    games: groupByGame(testRows.filter(r => r.y === 0 || r.y === 1)).length,
    rows: testRows.length,
    home: { ...home, bootstrap: absoluteBootstrap(testRows, 'scoreTimeP', 'y') },
    draw: { ...draw, bootstrap: absoluteBootstrap(testRows, 'stDraw', 'yDraw') },
    away: { ...away, bootstrap: absoluteBootstrap(testRows, 'stAway', 'yAway') },
    byBucket,
    byLeague,
  };
}

/* ------------------------------------------------------------------ C: market coverage */

function marketCoverage(full) {
  const windows = ['train', 'validation', 'test'];
  const keys = new Set();
  full.rows.forEach(r => keys.add(`${r.sport}|${r.league}|${r.window}`));
  return {
    scoredOutcome: 'home_win (the winner / moneyline market, home side)',
    calibKey: 'home_win',
    modelsExpose: {
      basketball: ['home_win', 'away_win'],
      soccer: ['home_win', 'draw', 'away_win'],
    },
    spread: { evaluated: false, available: false, note: 'no spread market is modelled or gated' },
    totals: { evaluated: false, available: false, note: 'no total-points market is modelled or gated' },
    leagueWindowCombos: keys.size,
    windowsPerLeague: windows.length,
    leaguesEvaluated: [...new Set(full.rows.map(r => `${r.sport}|${r.league}`))].sort(),
  };
}

/* ------------------------------------------------------------------ E: gate column vs production column */

/**
 * The ship gate scores `pShipped`: the walk-forward CALIBRATED value when the
 * calibration gate kept the calibrator, the raw value otherwise. Production
 * (services/live/liveModel -> basketballLive / soccerLive) applies NO
 * calibrator, so what a user actually sees is `pRaw`. Where the calibrator was
 * kept this is a real gap: the validated column is not the served column.
 *
 * This scores the SAME test window both ways so the gap is a number, not a
 * caveat.
 */
function productionVsGate(full, calibration) {
  const out = {};
  ['basketball', 'soccer'].forEach(sport => {
    const test = full.rows.filter(r => r.window === 'test' && r.sport === sport);
    if (!test.length) { out[sport] = null; return; }
    out[sport] = {
      calibrationKept: Boolean(calibration[sport] && calibration[sport].kept),
      calibrationBrierGain: calibration[sport] ? calibration[sport].brierGain : null,
      calibrationLogLossGain: calibration[sport] ? calibration[sport].logLossGain : null,
      shipped: shipGate(test),
      raw: shipGate(test, { probKey: 'pRaw' }),
    };
  });
  return out;
}

/* ------------------------------------------------------------------ D: latency sensitivity */

/**
 * Recompute the score-and-time home-win probability with the clock advanced by
 * `delaySeconds`. The replay assumes the checkpoint state is exact; a live read
 * is up to `delaySeconds` stale. Both the model and the baseline consume the
 * SAME state, so the comparison between them is unaffected — what this measures
 * is how far the ABSOLUTE probability and the Brier score move.
 */
function scoreTimeDelayed(row, delaySeconds) {
  const s = BT.baselines.scoreTime.soccer;
  const b = BT.baselines.scoreTime.basketball;
  const home = Number.isFinite(row.home_score) ? row.home_score : 0;
  const away = Number.isFinite(row.away_score) ? row.away_score : 0;
  const margin = home - away;

  if (row.sport === 'basketball') {
    const clock = M.parseClock(row.clock);
    const period = Number(row.period) || 0;
    if (!clock || period < 1) return null;
    const periodMinutes = b.gameMinutes / b.periods;
    const remaining = M.clamp(periodMinutes - clock.minutes - delaySeconds / 60, 0, periodMinutes);
    const overtime = b.overtimeMinutes || 5;
    const elapsed = period <= b.periods
      ? (period - 1) * periodMinutes + (periodMinutes - remaining)
      : b.gameMinutes + (period - 1 - b.periods) * overtime + M.clamp(overtime - (clock.minutes - delaySeconds / 60), 0, overtime);
    const total = period <= b.periods ? b.gameMinutes : b.gameMinutes + (period - b.periods) * overtime;
    const fraction = M.clamp(total - elapsed, 0, total) / total;
    const sigma = b.fullMarginSigma * Math.sqrt(fraction);
    if (!(sigma > 0)) return round4(margin > 0 ? 1 : margin < 0 ? 0 : 0.5);
    return round4(1 - M.normalCdf((0 - margin) / sigma));
  }

  if (row.sport === 'soccer') {
    const clock = M.parseClock(row.clock);
    const period = Number(row.period) || 0;
    if (!clock || period < 1) return null;
    const elapsed = M.clamp(clock.minutes + delaySeconds / 60, 0, s.regulationMinutes);
    const fraction = (s.regulationMinutes - elapsed) / s.regulationMinutes;
    const lh = s.fullHomeGoals * fraction;
    const la = s.fullAwayGoals * fraction;
    let homeWin = 0;
    for (let h = 0; h <= s.maxRemainingGoals; h++) {
      const ph = M.poissonPmf(h, lh);
      if (!ph) continue;
      for (let a = 0; a <= s.maxRemainingGoals; a++) {
        if (home + h > away + a) homeWin += ph * M.poissonPmf(a, la);
      }
    }
    return round4(M.clamp(homeWin, 0, 1));
  }
  return null;
}

function latencyReport(dataset, full) {
  const delays = [0, 30, 60, 90];
  const out = {};
  ['basketball', 'soccer'].forEach(sport => {
    const testRows = full.rows.filter(r => r.window === 'test' && r.sport === sport && (r.y === 0 || r.y === 1));
    out[sport] = delays.map(d => {
      const shifted = testRows.map(r => ({ ...r, stDelayed: scoreTimeDelayed(r, d) })).filter(r => Number.isFinite(r.stDelayed));
      const model = columnMetrics(shifted, 'stDelayed', 'y');
      const base = shifted.map(r => ({ ...r, stOnTime: r.scoreTimeP })).filter(r => Number.isFinite(r.stOnTime));
      const onTime = columnMetrics(base, 'stOnTime', 'y');
      const deltas = shifted
        .filter(r => Number.isFinite(r.scoreTimeP))
        .map(r => Math.abs(r.stDelayed - r.scoreTimeP));
      const meanAbsShift = deltas.length ? deltas.reduce((s, v) => s + v, 0) / deltas.length : null;
      const p95 = deltas.length ? percentile(deltas.slice().sort((a, b) => a - b), 0.95) : null;
      return {
        delaySeconds: d,
        games: model.games,
        brier: model.brier,
        logLoss: model.logLoss,
        hitRate: model.hitRate,
        brierOnTime: onTime.brier,
        logLossOnTime: onTime.logLoss,
        meanAbsProbShift: round4(meanAbsShift),
        p95AbsProbShift: round4(p95),
      };
    });
  });
  return out;
}

/* ------------------------------------------------------------------ main */

async function main() {
  const args = {};
  process.argv.slice(2).forEach(a => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  });

  const sports = ['basketball', 'soccer'];
  const sweep = {};
  sports.forEach(s => { sweep[s] = LIVE_CONFIG.matcher.sweep[s] || []; });
  const seasons = {};
  sports.forEach(s => { seasons[s] = BT.seasons[s] || []; });

  const cacheDir = args.cache === 'off' ? null : path.join(BACKEND_DIR, DATASET.cacheDir);
  // 0 means "no cap", which is what reproduces the Phase 8 sweep exactly; the
  // default cap truncates NBA/CBB and shrinks the test window.
  const maxGames = args['max-games'] !== undefined
    ? Number(args['max-games'])
    : DATASET.maxEventsPerLeague;
  process.stderr.write(`[phase9] loading dataset from ESPN cache… (maxGames ${maxGames})\n`);
  const loaded = await loadDatasetFromEspn({
    seasons,
    sports,
    sweep,
    maxEventsPerLeague: maxGames,
    concurrency: DATASET.concurrency,
    maxDays: 400,
    cacheDir,
    cache: {
      minIntervalMs: DATASET.minIntervalMs,
      retries: DATASET.retries,
      backoffMs: DATASET.backoffMs,
      timeoutMs: DATASET.requestTimeoutMs,
    },
    progressEvery: 2000,
  });
  const dataset = { games: loaded.games };
  process.stderr.write(`[phase9] loaded ${dataset.games.length} games (cache ${loaded.cache ? `${loaded.cache.hits} hits` : 'off'})\n`);

  process.stderr.write('[phase9] evaluating full dataset (Phase 8 reproduction)…\n');
  const full = evaluate(dataset);
  const calibration = calibrationGate(full.rows);
  stampShipped(full.rows, calibration);

  process.stderr.write('[phase9] per-league basketball holdouts…\n');
  const perLeague = BASKETBALL_LEAGUES.map(l => leagueHoldout(dataset, l));

  process.stderr.write('[phase9] soccer scoreTime calibration…\n');
  const soccer = soccerScoreTimeReport(dataset, full);

  const market = marketCoverage(full);
  const latency = latencyReport(dataset, full);
  const production = productionVsGate(full, calibration);

  const report = {
    generatedAt: new Date().toISOString(),
    dataset: { games: dataset.games.length, checkpoints: full.checkpoints },
    calibrationGate: calibration,
    market,
    basketballPerLeague: perLeague,
    soccerScoreTime: soccer,
    latency,
    productionVsGate: production,
  };

  printReport(report);

  if (args.out) {
    fs.writeFileSync(path.resolve(String(args.out)), JSON.stringify(report, null, 2));
    process.stderr.write(`[phase9] wrote ${args.out}\n`);
  }
}

function pct(v) { return v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`; }
function num(v) { return v == null ? 'n/a' : Number(v).toFixed(4); }
function ci4(c) { return c == null ? '[n/a]' : `[${num(c.lower)}, ${num(c.upper)}]`; }

function printReport(r) {
  const L = [];
  L.push(`# Live Phase 9 report — ${r.generatedAt}`);
  L.push(`dataset: ${r.dataset.games} games, ${r.dataset.checkpoints} checkpoints`);
  L.push('');

  L.push('## C. Markets the Phase 8 gate actually scored');
  L.push(`  scored outcome: ${r.market.scoredOutcome}`);
  L.push(`  calibration key: ${r.market.calibKey}`);
  L.push(`  spread: evaluated=${r.market.spread.evaluated} available=${r.market.spread.available} — ${r.market.spread.note}`);
  L.push(`  totals: evaluated=${r.market.totals.evaluated} available=${r.market.totals.available} — ${r.market.totals.note}`);
  L.push(`  league x window combinations evaluated: ${r.market.leagueWindowCombos}`);
  L.push(`  leagues evaluated: ${r.market.leaguesEvaluated.join(', ')}`);
  L.push('');

  L.push('## E. Gate column vs production column (sport-level test window)');
  L.push('  The gate scores pShipped (calibrated when kept). Production serves pRaw (no calibrator).');
  ['basketball', 'soccer'].forEach(sport => {
    const p = r.productionVsGate && r.productionVsGate[sport];
    if (!p) return;
    L.push(`  ${sport}: calibration kept=${p.calibrationKept} (calib gain brier ${num(p.calibrationBrierGain)} / log loss ${num(p.calibrationLogLossGain)})`);
    L.push(`    shipped: games ${p.shipped.games}  Brier ${num(p.shipped.model.brier)}  log loss ${num(p.shipped.model.logLoss)}  BrierGain ${num(p.shipped.brierGain)}  LLGain ${num(p.shipped.logLossGain)}  ${p.shipped.passed ? 'PASS' : 'FAIL'}`);
    L.push(`    raw    : games ${p.raw.games}  Brier ${num(p.raw.model.brier)}  log loss ${num(p.raw.model.logLoss)}  BrierGain ${num(p.raw.brierGain)}  LLGain ${num(p.raw.logLossGain)}  ${p.raw.passed ? 'PASS' : 'FAIL'}`);
    if (!p.raw.passed) p.raw.reasons.forEach(rs => L.push(`      raw fail: ${rs}`));
  });
  L.push('');

  L.push('## A. Basketball per-league holdout (each league split on its own calendar)');
  L.push('  league                     games  testG  rows   hit    CI-low  Brier(mdl) Brier(ref) BrierGain  [CI]                LLGain  [CI]                kept  verdict');
  r.basketballPerLeague.forEach(x => {
    const t = x.test;
    L.push(`  ${x.league.padEnd(24)} ${String(x.gamesAvailable).padStart(5)}  ${String(t.games).padStart(5)}  ${String(t.rows).padStart(5)}  ${pct(t.hitRate).padStart(5)}  ${pct(t.hitRateCI && t.hitRateCI.lower).padStart(6)}  ${num(t.model.brier).padStart(9)}  ${num(t.reference.brier).padStart(9)}  ${num(t.brierGain).padStart(9)}  ${ci4(t.brierGainCI).padEnd(18)}  ${num(t.logLossGain).padStart(6)}  ${ci4(t.logLossGainCI).padEnd(18)}  ${String(x.calibrationKept).padStart(5)}  ${t.passed ? 'PASS' : 'FAIL'}`);
    if (!t.passed) t.reasons.forEach(rs => L.push(`      - ${rs}`));
  });
  L.push('');

  L.push('## B. Soccer score-and-time (scoreTime) absolute calibration, test window');
  const s = r.soccerScoreTime;
  L.push(`  games ${s.games}  rows ${s.rows}`);
  ['home', 'draw', 'away'].forEach(k => {
    const c = s[k];
    L.push(`  ${k.padEnd(5)} n ${String(c.n).padStart(6)}  games ${String(c.games).padStart(5)}  Brier ${num(c.brier)} ${ci4(c.bootstrap && c.bootstrap.brier)}  log loss ${num(c.logLoss)} ${ci4(c.bootstrap && c.bootstrap.logLoss)}  hit ${pct(c.hitRate)} ${ci4(c.bootstrap && c.bootstrap.hitRate)}`);
  });
  L.push('  reliability (home column):');
  s.home.curve.forEach(b => L.push(`    ${b.range.padEnd(10)} n ${String(b.n).padStart(6)}  predicted ${pct(b.predicted)}  actual ${pct(b.actual)}`));
  L.push('  reliability (draw column):');
  s.draw.curve.forEach(b => L.push(`    ${b.range.padEnd(10)} n ${String(b.n).padStart(6)}  predicted ${pct(b.predicted)}  actual ${pct(b.actual)}`));
  L.push('  by time bucket (home column):');
  Object.entries(s.byBucket).forEach(([k, m]) => L.push(`    ${k.padEnd(14)} n ${String(m.n).padStart(6)}  games ${String(m.games).padStart(5)}  Brier ${num(m.brier)}  log loss ${num(m.logLoss)}  hit ${pct(m.hitRate)}`));
  L.push('  by league (home column):');
  Object.entries(s.byLeague).forEach(([k, m]) => L.push(`    ${k.padEnd(18)} n ${String(m.n).padStart(6)}  games ${String(m.games).padStart(5)}  Brier ${num(m.brier)}  log loss ${num(m.logLoss)}  hit ${pct(m.hitRate)}`));
  L.push('');

  L.push('## D. Latency sensitivity (score-and-time, test window)');
  L.push('  sport        delay  games   Brier(on-time -> delayed)   log loss(on-time -> delayed)  mean |dP|  p95 |dP|');
  Object.entries(r.latency).forEach(([sport, rows]) => {
    rows.forEach(x => {
      L.push(`  ${sport.padEnd(11)} ${String(`${x.delaySeconds}s`).padStart(5)}  ${String(x.games).padStart(5)}   ${num(x.brierOnTime)} -> ${num(x.brier)}            ${num(x.logLossOnTime)} -> ${num(x.logLoss)}          ${num(x.meanAbsProbShift)}     ${num(x.p95AbsProbShift)}`);
    });
  });
  L.push('');

  console.log(L.join('\n'));
}

if (require.main === module) {
  main().catch(err => {
    console.error('Phase 9 report failed:', (err && err.stack) || (err && err.message) || err);
    process.exit(1);
  });
}
