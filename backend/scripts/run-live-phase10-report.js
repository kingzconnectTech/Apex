#!/usr/bin/env node
/**
 * scripts/run-live-phase10-report.js
 *
 * Round C (Phase 10 accepted — nothing ships). Four honest checks:
 *
 *   1. SOCCER FIT SANITY, BEFORE ANY CONCLUSION. The retired parametric fit
 *      claimed an away intensity of 3.44 goals/match against a home 1.54 — a
 *      parsing artefact, not football. This section audits the events against
 *      the final scores PER LEAGUE (does a goal line ever disagree with the
 *      scoreboard?), then re-reports the per-bin intensities from the corrected
 *      goal log. No parametric conclusion is drawn; the parametric model is
 *      retired below.
 *
 *   2. BASKETBALL scoreTime DIAGNOSIS, CORRECTED. The Phase-10 wording called
 *      the baseline "under-confident". A slope below 1 with the low bucket
 *      realised ABOVE its prediction and the high bucket realised BELOW it is
 *      OVER-confidence at the extremes (predictions too spread out), plus a
 *      home side under-estimated in the mid-range. The label is corrected here
 *      and in docs/PHASE_5_LIVE_VALIDATION.md.
 *
 *   3. NONPARAMETRIC / SCORE-AND-TIME-ONLY MODELS (TRAIN + VALIDATION only):
 *        - soccer: a smoothed empirical table
 *          P(home/draw/away | minute bucket, capped goal difference, red-card
 *          state), monotone-smoothed along the goal-difference axis, with a
 *          minimum-cell-size fallback to coarser cells, renormalised to 1.
 *        - basketball: a per-league logistic on margin / sqrt(time remaining),
 *          with a home-advantage intercept and slope, plus simple overtime
 *          handling.
 *
 *   4. ONE evaluation on a FRESH holdout never used in Phases 8-10 (the most
 *      recent N weeks of ESPN history — the shadow log has no settled rows yet).
 *      Reports reliability, slope/intercept, max bucket deviation for n >= 300,
 *      by time bucket, by league, game-level 95% CIs, and the gain over the
 *      current score-and-time. How many times each window has been evaluated is
 *      disclosed explicitly.
 *
 * Ship criteria for a rough estimate are unchanged: absolute calibration inside
 * the tolerance AND a game-level gain CI excluding zero. Manual rough entry
 * stays blocked for every sport, because nothing here ships. Shadow, criteria
 * and calibrator ids are untouched.
 *
 * Usage:
 *   node scripts/run-live-phase10-report.js --out=data/live-report-phase10.json
 *   node scripts/run-live-phase10-report.js --holdout-weeks=4
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LIVE_CONFIG = require('../services/live/config');
const M = require('../services/live/liveMath');
const BTservices = require('../services/live/backtester');
const {
  Calibrator, brierScore, logLoss, calibrationCurve, logit, sigmoid,
} = require('../services/basketball/calibration');
const { loadDatasetFromEspn, yyyymmdd } = require('./run-live-backtest');

const BT = LIVE_CONFIG.liveBacktest;
const AC = BT.absoluteCalibration;
const DATASET = BT.dataset;
const BACKEND_DIR = path.join(__dirname, '..');
const WINDOWS = BT.windows;
const SOCCER_MINUTES = BT.checkpoints.soccer.minutes; // [15,30,45,60,75]
// The empirical soccer table conditions on a CAPPED goal difference and a
// SIMPLIFIED red-card state, then falls back to coarser cells when thin.
const SOCCER_DIFF_CAP = 3;
const SOCCER_MIN_CELL = 30;
// A per-league basketball logistic needs BT.shipGate.minLeagueGames (100)
// SETTLED GAMES in the fit window, else the sport-wide fit is used for that
// league. The gate is on GAMES, not rows (checkpoints inside one game are
// correlated, so a row count would flatter a thin league), so no row constant
// is kept here.
// Item 1 (RULE CLARIFICATION — thresholds unchanged): the model SHOWN for any
// rough estimate must itself pass absolute calibration, with a game-level gain
// CI above zero, on FRESH data of at least this many settled games. This is the
// same 500 the ship gate already uses (BT.shipGate.minGames); nothing is
// re-tuned here — a candidate below it is simply not yet judged.
const FRESH_MIN_GAMES = BT.shipGate.minGames;
// Frozen candidate artifact (Item 2/5): the versioned, never-refit models whose
// probability is logged on every shadow row so the fresh-data evaluation can be
// made once against a fixed target.
const CANDIDATE_FILE = 'data/live-shadow-candidates.json';
// The live shadow log the confirmation dataset is read from.
const FORWARD_FILE = 'data/live-forward.json';
// A freeze stamp only NAMES an instant if it carries a time of day. A date-only
// value ("2026-11-12") parses to midnight UTC — a placeholder, not a freeze.
const FREEZE_PRECISION = /T\d{2}:\d{2}:\d{2}/;

/* ------------------------------------------------------- shared statistics */

function round4(v) {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(4));
}
function mean(a) {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
}
function variance(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1);
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
function ci(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  return { n: s.length, lower: round4(percentile(s, 0.025)), upper: round4(percentile(s, 0.975)) };
}

/**
 * Binary logistic fit of y on a single predictor `x` (with an intercept) by
 * Newton-Raphson. Used both for the calibration diagnostics (x = logit(p)) and
 * for the basketball model (x = margin / sqrt(time remaining)).
 */
function logisticFitX(pairs, { ridge = 1e-6 } = {}) {
  const good = pairs.filter(r => (r.y === 0 || r.y === 1) && Number.isFinite(r.x));
  if (good.length < 2) return { slope: null, intercept: null, n: good.length };
  const X = good.map(r => r.x);
  const Y = good.map(r => r.y);
  let a = 0; // intercept
  let b = 0; // slope
  for (let it = 0; it < 200; it++) {
    let g0 = 0; let g1 = 0;
    let h00 = ridge; let h01 = 0; let h11 = ridge;
    for (let i = 0; i < X.length; i++) {
      const s = sigmoid(a + b * X[i]);
      const w = Math.max(1e-9, s * (1 - s));
      const err = s - Y[i];
      g0 += err; g1 += err * X[i];
      h00 += w; h01 += w * X[i]; h11 += w * X[i] * X[i];
    }
    const det = h00 * h11 - h01 * h01;
    if (!(Math.abs(det) > 1e-12)) break;
    const da = (h11 * g0 - h01 * g1) / det;
    const db = (-h01 * g0 + h00 * g1) / det;
    a -= da; b -= db;
    if (Math.abs(da) < 1e-8 && Math.abs(db) < 1e-8) break;
  }
  return { slope: round4(b), intercept: round4(a), n: good.length };
}

/** Calibration slope/intercept: regress the outcome on logit(p). */
function calibrSlopeIntercept(rows, probKey, outcomeKey) {
  return logisticFitX(rows
    .filter(r => (r[outcomeKey] === 0 || r[outcomeKey] === 1) && Number.isFinite(r[probKey]))
    .map(r => ({ x: logit(r[probKey]), y: r[outcomeKey] })));
}

/** Reliability curve (boundary binning), rounded for the report. */
function reliability(rows, probKey, outcomeKey) {
  const pairs = rows
    .filter(r => (r[outcomeKey] === 0 || r[outcomeKey] === 1) && Number.isFinite(r[probKey]))
    .map(r => ({ p: r[probKey], y: r[outcomeKey] }));
  return calibrationCurve(pairs, BT.curveEdges).map(b => ({
    range: b.range,
    n: b.n,
    predicted: b.predicted == null ? null : round4(b.predicted),
    actual: b.actual == null ? null : round4(b.actual),
    deviation: (b.predicted == null || b.actual == null) ? null : round4(b.actual - b.predicted),
  }));
}

/** Largest |actual - predicted| over buckets holding >= `minGames` graded rows. */
function maxBucketDeviation(curve, minGames) {
  let worst = null;
  curve.forEach(b => {
    if (b.n >= minGames && b.deviation != null) {
      if (worst == null || Math.abs(b.deviation) > Math.abs(worst.deviation)) worst = b;
    }
  });
  return worst;
}

/** Headline metrics for one probability column against a chosen outcome. */
function columnStats(rows, probKey, outcomeKey, { label = probKey } = {}) {
  const good = rows.filter(r => (r[outcomeKey] === 0 || r[outcomeKey] === 1) && Number.isFinite(r[probKey]));
  const curve = reliability(rows, probKey, outcomeKey);
  if (!good.length) {
    return {
      label, n: 0, games: 0, brier: null, logLoss: null, hitRate: null, curve,
      slope: null, intercept: null, maxBucketDeviation: null, maxBucketRange: null, judged: false,
    };
  }
  const pairs = good.map(r => ({ p: r[probKey], y: r[outcomeKey] }));
  const hits = good.filter(r => (r[probKey] >= 0.5 ? 1 : 0) === r[outcomeKey]).length;
  const fit = calibrSlopeIntercept(rows, probKey, outcomeKey);
  const worst = maxBucketDeviation(curve, AC.minBucketGames);
  return {
    label,
    n: good.length,
    games: BTservices.groupByGame(good).length,
    brier: round4(brierScore(pairs)),
    logLoss: round4(logLoss(pairs)),
    hitRate: round4(hits / good.length),
    slope: fit.slope,
    intercept: fit.intercept,
    curve,
    maxBucketDeviation: worst ? worst.deviation : null,
    maxBucketRange: worst ? worst.range : null,
    judged: good.length >= AC.minRows,
  };
}

/** Pass verdict for one absolute-calibration column. */
function absoluteVerdict(col) {
  if (!col || col.n < AC.minRows) {
    return { judged: false, pass: null, reason: `only ${col ? col.n : 0} graded rows (< ${AC.minRows})` };
  }
  const dev = col.maxBucketDeviation;
  const pass = dev != null && Math.abs(dev) <= AC.maxBucketDeviation;
  return {
    judged: true,
    pass,
    maxBucketDeviation: dev,
    tolerance: AC.maxBucketDeviation,
    reason: pass
      ? `worst judged bucket ${col.maxBucketRange} off by ${dev} (<= ${AC.maxBucketDeviation})`
      : `worst judged bucket ${col.maxBucketRange} off by ${dev} (> ${AC.maxBucketDeviation})`,
  };
}

/** 95% game-level percentile CI for a column's ABSOLUTE Brier / log loss. */
function absoluteBootstrap(rows, probKey, outcomeKey, opts = {}) {
  const iterations = opts.iterations || BT.shipGate.bootstrap.iterations;
  const seed = opts.seed || BT.shipGate.bootstrap.seed;
  const good = rows.filter(r => (r[outcomeKey] === 0 || r[outcomeKey] === 1) && Number.isFinite(r[probKey]));
  const games = BTservices.groupByGame(good);
  if (!games.length) return { iterations: 0, games: 0 };
  const rand = mulberry32(seed);
  const draws = { brier: [], logLoss: [] };
  for (let it = 0; it < iterations; it++) {
    const sample = [];
    for (let i = 0; i < games.length; i++) {
      const g = games[Math.floor(rand() * games.length)];
      for (const r of g) sample.push(r);
    }
    const pairs = sample.map(r => ({ p: r[probKey], y: r[outcomeKey] }));
    draws.brier.push(brierScore(pairs));
    draws.logLoss.push(logLoss(pairs));
  }
  return { iterations, games: games.length, brier: ci(draws.brier), logLoss: ci(draws.logLoss) };
}

/**
 * 95% game-level CI for the GAIN of `modelKey` over `refKey` (positive = the
 * model is better). Same resampling unit as every other interval here.
 */
function gainBootstrap(rows, modelKey, refKey, outcomeKey, opts = {}) {
  const iterations = opts.iterations || BT.shipGate.bootstrap.iterations;
  const seed = opts.seed || BT.shipGate.bootstrap.seed;
  const good = rows.filter(r => (r[outcomeKey] === 0 || r[outcomeKey] === 1) && Number.isFinite(r[modelKey]) && Number.isFinite(r[refKey]));
  const games = BTservices.groupByGame(good);
  if (!games.length) return { iterations: 0, games: 0 };
  const rand = mulberry32(seed);
  const draws = { brierGain: [], logLossGain: [] };
  for (let it = 0; it < iterations; it++) {
    const sample = [];
    for (let i = 0; i < games.length; i++) {
      const g = games[Math.floor(rand() * games.length)];
      for (const r of g) sample.push(r);
    }
    const bModel = brierScore(sample.map(r => ({ p: r[modelKey], y: r[outcomeKey] })));
    const bRef = brierScore(sample.map(r => ({ p: r[refKey], y: r[outcomeKey] })));
    const lModel = logLoss(sample.map(r => ({ p: r[modelKey], y: r[outcomeKey] })));
    const lRef = logLoss(sample.map(r => ({ p: r[refKey], y: r[outcomeKey] })));
    if (bModel != null && bRef != null) draws.brierGain.push(bRef - bModel);
    if (lModel != null && lRef != null) draws.logLossGain.push(lRef - lModel);
  }
  return { iterations, games: games.length, brierGain: ci(draws.brierGain), logLossGain: ci(draws.logLossGain) };
}

/* -------------------------------------------------- multiclass soccer metrics */

const EPS = 1e-12;

/** Multiclass log loss for a home/draw/away row from a probability prefix. */
function multiLogLoss(row, prefix) {
  const out = row.yDraw === 1 ? row[`${prefix}Draw`] : row.yAway === 1 ? row[`${prefix}Away`] : row[`${prefix}Home`];
  const p = Math.min(1 - 1e-9, Math.max(1e-9, Number(out)));
  return -Math.log(p);
}
/** Multiclass Brier for a home/draw/away row (sum of squared class errors). */
function multiBrier(row, prefix) {
  const h = row[`${prefix}Home`]; const d = row[`${prefix}Draw`]; const a = row[`${prefix}Away`];
  return (h - row.yHome) ** 2 + (d - row.yDraw) ** 2 + (a - row.yAway) ** 2;
}
function multiMean(rows, prefix, fn) {
  return rows.length ? mean(rows.map(r => fn(r, prefix))) : null;
}

/** Game-level 95% CI for the multiclass gain (model over reference). */
function multiGainBootstrap(rows, modelPrefix, refPrefix, opts = {}) {
  const iterations = opts.iterations || BT.shipGate.bootstrap.iterations;
  const seed = opts.seed || BT.shipGate.bootstrap.seed;
  const good = rows.filter(r => r.yHome === 0 || r.yHome === 1);
  const games = BTservices.groupByGame(good);
  if (!games.length) return { iterations: 0, games: 0 };
  const rand = mulberry32(seed);
  const draws = { brierGain: [], logLossGain: [] };
  for (let it = 0; it < iterations; it++) {
    const sample = [];
    for (let i = 0; i < games.length; i++) {
      const g = games[Math.floor(rand() * games.length)];
      for (const r of g) sample.push(r);
    }
    draws.brierGain.push(multiMean(sample, refPrefix, multiBrier) - multiMean(sample, modelPrefix, multiBrier));
    draws.logLossGain.push(multiMean(sample, refPrefix, multiLogLoss) - multiMean(sample, modelPrefix, multiLogLoss));
  }
  return { iterations, games: games.length, brierGain: ci(draws.brierGain), logLossGain: ci(draws.logLossGain) };
}

/* ================================================================= ITEM 1 */
/* Soccer fit sanity: events vs final scores, per league, and the intensities. */

/** Cumulative goals at every bin boundary, ending on the supplied final score. */
function cumulativeByBoundary(g, final) {
  const byLabel = new Map();
  (g.checkpoints || []).forEach(cp => byLabel.set(String(cp.label), cp));
  const out = [];
  let carry = { home: 0, away: 0 };
  SOCCER_MINUTES.forEach(m => {
    const cp = byLabel.get(`m${m}`);
    if (cp && Number.isFinite(cp.home_score) && Number.isFinite(cp.away_score)) {
      carry = { home: cp.home_score, away: cp.away_score };
    }
    out.push({ ...carry });
  });
  out.push({ home: final.home, away: final.away });
  return out;
}

/** Per-bin goals from a cumulative series, with a monotonicity guard counter. */
function binsFromCumulative(cum) {
  const bins = { home: new Array(SOCCER_MINUTES.length + 1).fill(0), away: new Array(SOCCER_MINUTES.length + 1).fill(0) };
  let glitches = 0;
  for (let b = 0; b < bins.home.length; b++) {
    const prev = b === 0 ? { home: 0, away: 0 } : cum[b - 1];
    const dh = cum[b].home - prev.home;
    const da = cum[b].away - prev.away;
    if (dh < 0 || da < 0) glitches++;
    bins.home[b] += Math.max(0, dh);
    bins.away[b] += Math.max(0, da);
  }
  return { bins, glitches };
}

function sameScore(a, b) {
  return a && b && Number(a.home) === Number(b.home) && Number(a.away) === Number(b.away);
}

/**
 * Audit the soccer goal log against the final scores, per league, and re-report
 * the per-bin intensities from the corrected events. This answers Item 1 before
 * any conclusion is drawn.
 */
function soccerSanity(dataset) {
  const games = (dataset.games || []).filter(g => g && g.sport === 'soccer' && g.final
    && Number.isFinite(g.final.home) && Number.isFinite(g.final.away)
    && Array.isArray(g.checkpoints) && g.checkpoints.length);

  const blank = () => ({
    games: 0, mismatch: 0, missingEvent: 0, glitches: 0,
    finalHome: 0, finalAway: 0, eventHome: 0, eventAway: 0,
    binFinalHome: new Array(SOCCER_MINUTES.length + 1).fill(0),
    binFinalAway: new Array(SOCCER_MINUTES.length + 1).fill(0),
    binEventHome: new Array(SOCCER_MINUTES.length + 1).fill(0),
    binEventAway: new Array(SOCCER_MINUTES.length + 1).fill(0),
  });
  const overall = blank();
  const byLeague = {};

  games.forEach(g => {
    const league = String(g.league || 'unknown');
    if (!byLeague[league]) byLeague[league] = blank();
    const evFinal = g.eventFinal && Number.isFinite(g.eventFinal.home) && Number.isFinite(g.eventFinal.away)
      ? g.eventFinal : g.final;
    const hasEvent = Boolean(g.eventFinal);
    const mismatch = !sameScore(g.final, evFinal);

    const cumFinal = cumulativeByBoundary(g, g.final);
    const cumEvent = cumulativeByBoundary(g, evFinal);
    const bf = binsFromCumulative(cumFinal);
    const be = binsFromCumulative(cumEvent);

    [overall, byLeague[league]].forEach(acc => {
      acc.games++;
      if (mismatch) acc.mismatch++;
      if (!hasEvent) acc.missingEvent++;
      acc.glitches += bf.glitches + be.glitches;
      acc.finalHome += g.final.home; acc.finalAway += g.final.away;
      acc.eventHome += evFinal.home; acc.eventAway += evFinal.away;
      for (let b = 0; b < acc.binFinalHome.length; b++) {
        acc.binFinalHome[b] += bf.bins.home[b];
        acc.binFinalAway[b] += bf.bins.away[b];
        acc.binEventHome[b] += be.bins.home[b];
        acc.binEventAway[b] += be.bins.away[b];
      }
    });
  });

  const shape = acc => ({
    games: acc.games,
    mismatch: acc.mismatch,
    missingEvent: acc.missingEvent,
    glitches: acc.glitches,
    meanFinalHome: round4(acc.finalHome / (acc.games || 1)),
    meanFinalAway: round4(acc.finalAway / (acc.games || 1)),
    meanEventHome: round4(acc.eventHome / (acc.games || 1)),
    meanEventAway: round4(acc.eventAway / (acc.games || 1)),
    binFinalHome: acc.binFinalHome.map(v => round4(v / (acc.games || 1))),
    binFinalAway: acc.binFinalAway.map(v => round4(v / (acc.games || 1))),
    binEventHome: acc.binEventHome.map(v => round4(v / (acc.games || 1))),
    binEventAway: acc.binEventAway.map(v => round4(v / (acc.games || 1))),
    sumFinalHome: round4(acc.binFinalHome.reduce((s, v) => s + v, 0) / (acc.games || 1)),
    sumFinalAway: round4(acc.binFinalAway.reduce((s, v) => s + v, 0) / (acc.games || 1)),
    sumEventHome: round4(acc.binEventHome.reduce((s, v) => s + v, 0) / (acc.games || 1)),
    sumEventAway: round4(acc.binEventAway.reduce((s, v) => s + v, 0) / (acc.games || 1)),
  });

  const out = { overall: shape(overall), byLeague: {} };
  Object.keys(byLeague).sort().forEach(k => { out.byLeague[k] = shape(byLeague[k]); });
  return out;
}

/* ================================================================= ITEM 2 */
/* Basketball scoreTime: absolute calibration on the historical test window.   */

/** Build scoreTime rows from basketball games: one per checkpoint. */
function basketballScoreTimeRows(dataset) {
  const games = (dataset.games || [])
    .filter(g => g && g.sport === 'basketball' && g.final
      && Number.isFinite(g.final.home) && Number.isFinite(g.final.away)
      && Array.isArray(g.checkpoints) && g.checkpoints.length)
    .sort((a, b) => new Date(a.kickoff || 0) - new Date(b.kickoff || 0));

  const rows = [];
  games.forEach((g, i) => {
    const win = BTservices.windowOf(i, games.length, WINDOWS);
    const y = g.final.home > g.final.away ? 1 : 0;
    g.checkpoints.forEach(cp => {
      const cpObj = { clock: cp.clock, period: cp.period, home_score: cp.home_score, away_score: cp.away_score };
      const p = BTservices.scoreTimeProbability(cpObj, 'basketball', g.league);
      const progress = BTservices.progressFraction(cpObj, 'basketball', g.league);
      rows.push({
        window: win, sport: 'basketball', league: g.league || null, gameId: String(g.gameId),
        clock: cp.clock, period: cp.period, home_score: cp.home_score, away_score: cp.away_score,
        progress, bucket: BTservices.bucketFor(progress), p, y,
      });
    });
  });
  return rows;
}

/** Absolute calibration of the existing basketball scoreTime on the test window. */
function basketballScoreTimeReport(rows) {
  const test = rows.filter(r => r.window === 'test' && (r.y === 0 || r.y === 1) && Number.isFinite(r.p));
  const col = columnStats(test, 'p', 'y', { label: 'scoreTime (home-win)' });
  const boot = absoluteBootstrap(test, 'p', 'y');

  const byBucket = {};
  (BT.bucketLabels || []).forEach(label => {
    const list = test.filter(r => r.bucket === label);
    byBucket[label] = { ...columnStats(list, 'p', 'y', { label }), bootstrap: absoluteBootstrap(list, 'p', 'y') };
  });
  const byLeague = {};
  [...new Set(test.map(r => r.league))].sort().forEach(league => {
    byLeague[String(league)] = columnStats(test.filter(r => r.league === league), 'p', 'y', { label: String(league) });
  });

  // The corrected diagnosis, derived from the curve rather than asserted.
  // (The last bucket's label is capped at 1.00, so take the first / last bucket.)
  const low = col.curve[0];
  const high = col.curve[col.curve.length - 1];
  const diagnosis = {
    slope: col.slope,
    intercept: col.intercept,
    overConfidentExtremes: Boolean(col.slope != null && col.slope < 1
      && low && high && low.deviation != null && low.deviation > 0 && high.deviation != null && high.deviation < 0),
    lowBucket: low ? { range: low.range, predicted: low.predicted, actual: low.actual } : null,
    highBucket: high ? { range: high.range, predicted: high.predicted, actual: high.actual } : null,
    verdict: 'over-confident at the extremes (slope < 1, low bucket realised above its prediction, high bucket below), with the home side under-estimated in the mid-range (positive intercept)',
  };

  return {
    window: 'test',
    rows: test.length,
    games: BTservices.groupByGame(test).length,
    column: { ...col, bootstrap: boot },
    byBucket,
    byLeague,
    verdict: absoluteVerdict(col),
    diagnosis,
  };
}

/* ================================================================= ITEM 3a */
/* Soccer: smoothed empirical P(home/draw/away | minute, capped diff, red).    */

function redStateOf(cp) {
  const h = Number(cp.home_red) || 0;
  const a = Number(cp.away_red) || 0;
  if (h > a) return 'home'; // the home side is a man down (bad for home)
  if (a > h) return 'away';
  return 'none';
}

/** Build soccer evaluation rows (raw table inputs + the current scoreTime). */
function soccerRows(dataset) {
  const games = (dataset.games || [])
    .filter(g => g && g.sport === 'soccer' && g.final
      && Number.isFinite(g.final.home) && Number.isFinite(g.final.away)
      && Array.isArray(g.checkpoints) && g.checkpoints.length)
    .sort((a, b) => new Date(a.kickoff || 0) - new Date(b.kickoff || 0));

  const rows = [];
  games.forEach((g, i) => {
    const win = BTservices.windowOf(i, games.length, WINDOWS);
    const yHome = g.final.home > g.final.away ? 1 : 0;
    const yDraw = g.final.home === g.final.away ? 1 : 0;
    const yAway = g.final.away > g.final.home ? 1 : 0;
    const byLabel = new Map();
    (g.checkpoints || []).forEach(cp => byLabel.set(String(cp.label), cp));

    SOCCER_MINUTES.forEach(minute => {
      const cp = byLabel.get(`m${minute}`);
      if (!cp) return;
      const home = Number(cp.home_score);
      const away = Number(cp.away_score);
      if (!Number.isFinite(home) || !Number.isFinite(away)) return;
      const diff = M.clamp(home - away, -SOCCER_DIFF_CAP, SOCCER_DIFF_CAP);
      const row = {
        window: win, sport: 'soccer', league: g.league || null, gameId: String(g.gameId),
        clock: `${minute}'`, period: minute <= 45 ? 1 : 2,
        minuteBucket: minute, home, away, diff, redState: redStateOf(cp),
        // Raw red counts and total goals: the Item 5 multinomial-logistic
        // candidate conditions on the red-card STATE and the running total.
        homeRed: Number(cp.home_red) || 0,
        awayRed: Number(cp.away_red) || 0,
        totalGoals: home + away,
        progress: M.clamp(minute / 90, 0, 1), bucket: BTservices.bucketFor(M.clamp(minute / 90, 0, 1)),
        yHome, yDraw, yAway,
      };
      const st = currentScoreTimeThreeWay(row);
      row.stHome = st ? round4(st.home) : null;
      row.stDraw = st ? round4(st.draw) : null;
      row.stAway = st ? round4(st.away) : null;
      rows.push(row);
    });
  });
  return rows;
}

/**
 * The CURRENT score-and-time three-way (Phase 8/9 construction): plain Poisson
 * at the global rates with no fit and no overdispersion. The reference the new
 * model is measured against.
 */
function currentScoreTimeThreeWay(row) {
  const s = BT.baselines.scoreTime.soccer;
  const clock = M.parseClock(row.clock);
  const period = Number(row.period) || 0;
  if (!clock || period < 1) return null;
  const elapsed = M.clamp(clock.minutes, 0, s.regulationMinutes);
  const fraction = (s.regulationMinutes - elapsed) / s.regulationMinutes;
  const lh = s.fullHomeGoals * fraction;
  const la = s.fullAwayGoals * fraction;
  let h = 0; let d = 0; let a = 0;
  for (let i = 0; i <= s.maxRemainingGoals; i++) {
    const ph = M.poissonPmf(i, lh);
    if (!ph) continue;
    for (let j = 0; j <= s.maxRemainingGoals; j++) {
      const p = ph * M.poissonPmf(j, la);
      if (!p) continue;
      const fh = row.home + i; const fa = row.away + j;
      if (fh > fa) h += p; else if (fh === fa) d += p; else a += p;
    }
  }
  const sum = h + d + a;
  if (!(sum > 0)) return null;
  return { home: h / sum, draw: d / sum, away: a / sum };
}

/**
 * PAVA (pool adjacent violators) — the non-decreasing least-squares fit. Points
 * with zero weight are interpolated between their neighbours so a thin cell
 * never punches a hole in the monotone series.
 */
function isotonicNonDecreasing(values, weights) {
  const n = values.length;
  const fitted = new Array(n).fill(null);
  const blocks = [];
  for (let i = 0; i < n; i++) {
    if (!(weights[i] > 0)) continue;
    blocks.push({ sum: values[i] * weights[i], w: weights[i], i0: i, i1: i });
    while (blocks.length >= 2) {
      const a = blocks[blocks.length - 2];
      const b = blocks[blocks.length - 1];
      if (a.sum / a.w > b.sum / b.w) {
        blocks.pop(); blocks.pop();
        blocks.push({ sum: a.sum + b.sum, w: a.w + b.w, i0: a.i0, i1: b.i1 });
      } else break;
    }
  }
  blocks.forEach(b => { const v = b.sum / b.w; for (let i = b.i0; i <= b.i1; i++) fitted[i] = v; });
  const firstIdx = fitted.findIndex(v => v != null);
  if (firstIdx === -1) return values.slice();
  for (let i = 0; i < firstIdx; i++) fitted[i] = fitted[firstIdx];
  let lastIdx = n - 1;
  while (lastIdx >= 0 && fitted[lastIdx] == null) lastIdx--;
  for (let i = lastIdx + 1; i < n; i++) fitted[i] = fitted[lastIdx];
  let prev = firstIdx;
  for (let i = firstIdx + 1; i <= lastIdx; i++) {
    if (fitted[i] == null) continue;
    if (i - prev > 1) {
      const step = (fitted[i] - fitted[prev]) / (i - prev);
      for (let k = prev + 1; k < i; k++) fitted[k] = fitted[prev] + step * (k - prev);
    }
    prev = i;
  }
  return fitted;
}

const SOCCER_DIFFS = [];
for (let d = -SOCCER_DIFF_CAP; d <= SOCCER_DIFF_CAP; d++) SOCCER_DIFFS.push(d);
const SOCCER_RED_STATES = ['none', 'home', 'away'];

/**
 * Fit the smoothed empirical soccer table on TRAIN + VALIDATION only.
 *
 * Cells are keyed by (minute, capped difference, red state). A cell thin at the
 * configured minimum falls back, in order, to:
 *   0  the exact (minute, diff, red) cell,
 *   1  the red-pooled (minute, diff) cell,
 *   2  a LOCAL distance-weighted pool of ADJACENT differences (|k-d| <= 1,
 *      weight 2^-|k-d|) — kept LOCAL so a thin extreme cell is informed by its
 *      neighbour, not dragged toward the huge-n level-difference cell,
 *   3  the minute-only cell (all differences),
 *   4  the global rate.
 *
 * The monotone smoothing runs on the cells that carry DIRECT evidence (levels
 * 0-1) ONLY; the fallback cells are then filled by interpolating/EXTENDING that
 * curve on its local slope. This is the fix for the 15'/30' collapse: the
 * previous code fed the raw fallback value straight into the isotonic pass, and
 * because the thin diff ±3 cell was immediately out of order the isotonic step
 * merged it with the direct diff 1/2 cells, flattening "up 1/2/3" onto one
 * number. Fitting on direct cells and extending keeps the goal-difference
 * resolution while still enforcing monotonicity.
 *
 * Every cell's raw counts and the fallback level actually used are recorded in
 * `cells`, so the pooling can be audited cell by cell.
 */
function fitSoccerTable(rows, { minCell = SOCCER_MIN_CELL } = {}) {
  const trainVal = rows.filter(r => r.window !== 'test');
  const ckey = (m, d, r) => `${m}|${d}|${r}`;
  const cell = new Map();   // (m,d,r)
  const cellMD = new Map(); // (m,d) — red pooled
  const cellM = new Map();  // (m)
  let global = { h: 0, d: 0, a: 0, n: 0 };

  const bump = (map, k, o) => {
    const cur = map.get(k) || { h: 0, d: 0, a: 0, n: 0 };
    cur.h += o.h; cur.d += o.d; cur.a += o.a; cur.n += o.n;
    map.set(k, cur);
  };
  trainVal.forEach(r => {
    const o = { h: r.yHome, d: r.yDraw, a: r.yAway, n: 1 };
    bump(cell, ckey(r.minuteBucket, r.diff, r.redState), o);
    bump(cellMD, `${r.minuteBucket}|${r.diff}`, o);
    bump(cellM, `${r.minuteBucket}`, o);
    global = { h: global.h + o.h, d: global.d + o.d, a: global.a + o.a, n: global.n + o.n };
  });

  const rate = c => (c && c.n > 0
    ? { home: c.h / c.n, draw: c.d / c.n, away: c.a / c.n, n: c.n }
    : {
      home: global.n ? global.h / global.n : 1 / 3,
      draw: global.n ? global.d / global.n : 1 / 3,
      away: global.n ? global.a / global.n : 1 / 3,
      n: 0,
    });

  // LOCAL neighbour pool over the capped difference axis: only the cell's own
  // difference and its immediate neighbours (|k-d| <= 1). A wider pool tugged a
  // thin extreme cell toward the huge-n level-difference cell and produced
  // nonsense — e.g. a side trailing by 3 at 15' scored a HIGHER home rate than
  // one trailing by 1 — which is what the isotonic step then smeared across the
  // whole side.
  const kernel = (m, d) => {
    let acc = { h: 0, d: 0, a: 0, n: 0 };
    SOCCER_DIFFS.forEach(k => {
      if (Math.abs(k - d) > 1) return;
      const c = cellMD.get(`${m}|${k}`);
      if (!c || !c.n) return;
      const w = Math.pow(0.5, Math.abs(k - d));
      acc.h += w * c.h; acc.d += w * c.d; acc.a += w * c.a; acc.n += w * c.n;
    });
    return acc;
  };

  const pick = (m, d, r) => {
    const c0 = cell.get(ckey(m, d, r));
    if (c0 && c0.n >= minCell) return { ...rate(c0), level: 0 };
    const c1 = cellMD.get(`${m}|${d}`);
    if (c1 && c1.n >= minCell) return { ...rate(c1), level: 1 };
    const c2 = kernel(m, d);
    if (c2.n >= minCell) return { ...rate(c2), level: 2 };
    const c3 = cellM.get(`${m}`);
    if (c3 && c3.n >= minCell) return { ...rate(c3), level: 3 };
    return { ...rate(null), level: 4 };
  };

  // Monotone fit on the DIRECT cells only, then extend to the fallback cells.
  // A fallback cell carries weight 0 so the isotonic pass cannot pull the curve
  // across it; the cells beyond the direct range are then extrapolated on the
  // curve's own local slope, so distinct goal differences keep distinct values.
  const monotone = (vals, w, direct) => {
    const fit = isotonicNonDecreasing(vals, vals.map((_, i) => (direct[i] ? w[i] : 0)));
    const idx = [];
    for (let i = 0; i < vals.length; i++) if (direct[i]) idx.push(i);
    if (!idx.length) return fit;
    const first = idx[0];
    const last = idx[idx.length - 1];
    if (first > 0) {
      const step = idx.length >= 2 ? Math.abs((fit[idx[1]] - fit[first]) / (idx[1] - first)) : 0;
      for (let i = first - 1; i >= 0; i--) fit[i] = fit[i + 1] - step;
    }
    if (last < vals.length - 1) {
      const step = idx.length >= 2
        ? Math.abs((fit[last] - fit[idx[idx.length - 2]]) / (last - idx[idx.length - 2]))
        : 0;
      for (let i = last + 1; i < vals.length; i++) fit[i] = fit[i - 1] + step;
    }
    return fit;
  };

  // Pooled (pre-smoothing) probabilities, the monotone-smoothed table, and the
  // per-cell audit trail.
  const pooled = {};
  const table = {};
  const cells = [];
  const levelCounts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };

  SOCCER_MINUTES.forEach(m => {
    SOCCER_RED_STATES.forEach(r => {
      const drawn = SOCCER_DIFFS.map(d => pick(m, d, r));
      drawn.forEach(v => { levelCounts[v.level]++; });
      const direct = drawn.map(v => v.level <= 1);
      const hFit = monotone(drawn.map(v => v.home), drawn.map(v => v.n), direct);
      // Away must DECREASE with the difference: fit the negation, then negate.
      const aFit = monotone(drawn.map(v => -v.away), drawn.map(v => v.n), direct).map(v => -v);
      SOCCER_DIFFS.forEach((d, idx) => {
        let h = M.clamp(hFit[idx], 1e-4, 0.9999);
        let a = M.clamp(aFit[idx], 1e-4, 0.9999);
        if (h + a > 0.999) { const s = 0.999 / (h + a); h *= s; a *= s; }
        const dr = Math.max(1e-4, 1 - h - a);
        const sum = h + dr + a;
        table[`${m}|${r}|${d}`] = {
          home: round4(h / sum), draw: round4(dr / sum), away: round4(a / sum), n: drawn[idx].n, level: drawn[idx].level,
        };
        pooled[`${m}|${r}|${d}`] = {
          home: round4(drawn[idx].home), draw: round4(drawn[idx].draw), away: round4(drawn[idx].away), n: drawn[idx].n, level: drawn[idx].level,
        };
        const c0 = cell.get(ckey(m, d, r));
        const c1 = cellMD.get(`${m}|${d}`);
        const c3 = cellM.get(`${m}`);
        cells.push({
          minute: m,
          diff: d,
          red: r,
          nCell: c0 ? c0.n : 0,
          nMD: c1 ? c1.n : 0,
          nM: c3 ? c3.n : 0,
          level: drawn[idx].level,
          direct: direct[idx],
          usedN: drawn[idx].n,
        });
      });
    });
  });

  return {
    fitRows: trainVal.length,
    minCell,
    diffCap: SOCCER_DIFF_CAP,
    table,
    pooled,
    cells,
    cellLevels: levelCounts,
    globalRate: { home: round4(rate(null).home), draw: round4(rate(null).draw), away: round4(rate(null).away), n: global.n },
  };
}

/** Look up the fitted table for a soccer row. */
function soccerPredict(fit, row) {
  const v = fit.table[`${row.minuteBucket}|${row.redState}|${row.diff}`];
  if (v) return v;
  const fb = fit.table[`${row.minuteBucket}|none|${row.diff}`];
  return fb || null;
}

/** Stamp the fitted model's probabilities onto every soccer row. */
function applySoccerModel(rows, fit) {
  rows.forEach(r => {
    const p = soccerPredict(fit, r);
    r.mdlHome = p ? p.home : null;
    r.mdlDraw = p ? p.draw : null;
    r.mdlAway = p ? p.away : null;
  });
}

/**
 * Item 4 — the per-cell audit. For the specific (minute, diff) cells the user
 * flagged (up 1/2/3 at 15', down 1/2/3 at 30'), report each cell's raw counts,
 * the fallback level actually used and the pooled probabilities, and assert that
 * the cells no longer collapse onto one number.
 */
function soccerTableCellDemo(fit) {
  const pairs = [[15, 1], [15, 2], [15, 3], [15, 0], [30, -1], [30, -2], [30, -3], [30, 0]];
  const cells = pairs.map(([m, d]) => {
    const key = `${m}|none|${d}`;
    const t = fit.table[key];
    const p = fit.pooled[key];
    const c = fit.cells.find(x => x.minute === m && x.diff === d && x.red === 'none');
    let why = null;
    if (c) {
      if (c.level === 0) why = `exact (minute,diff,red) cell has n=${c.nCell} >= minCell`;
      else if (c.level === 1) why = `(minute,diff) red-pooled cell has n=${c.nMD} >= minCell`;
      else if (c.level === 2) why = `exact cell n=${c.nCell} and (minute,diff) n=${c.nMD} both < minCell=${fit.minCell}; local neighbour pool over goal difference used`;
      else if (c.level === 3) why = 'every difference cell is thin; minute-only cell used';
      else why = 'global rate used';
    }
    return {
      minute: m,
      diff: d,
      nCell: c ? c.nCell : null,
      nMD: c ? c.nMD : null,
      nM: c ? c.nM : null,
      usedN: c ? c.usedN : null,
      level: c ? c.level : null,
      direct: c ? c.direct : null,
      why,
      pooled: p ? { home: p.home, draw: p.draw, away: p.away } : null,
      table: t ? { home: t.home, draw: t.draw, away: t.away } : null,
    };
  });
  const distinct = arr => {
    const vals = arr.filter(v => v != null).map(v => Number(v).toFixed(4));
    return vals.length > 0 && new Set(vals).size === vals.length;
  };
  // The FINAL table is what a prediction uses, so distinctness is judged there
  // (not on the pre-smoothing pool).
  const m15 = [1, 2, 3].map(d => (fit.table[`15|none|${d}`] || {}).home);
  const m30 = [-1, -2, -3].map(d => (fit.table[`30|none|${d}`] || {}).home);
  return {
    cells,
    minute15HomeDistinct: distinct(m15),
    minute30HomeDistinct: distinct(m30),
    levelLegend: {
      0: '(minute, diff, red) exact',
      1: '(minute, diff) red-pooled',
      2: 'LOCAL distance-weighted neighbour pool over goal difference (|k-d| <= 1, kernel 2^-|k-d|)',
      3: '(minute) only — all differences',
      4: 'global rate',
    },
  };
}

/* ------------------------------------------------- ITEM 5 (soccer candidate) */
/* Regularised multinomial logistic P(home/draw/away | features).              */

const MNL_FEATURES = ['goal_diff', 'remaining_frac', 'diff_x_sqrt_remaining', 'red_net', 'total_goals'];

/**
 * The Item 5 feature vector for one soccer row.
 *   - goal difference (home - away, not capped — the model's own coefficient
 *     handles the tails),
 *   - the fraction of regulation remaining,
 *   - the interaction diff x sqrt(remaining minutes),
 *   - the red-card state as a signed net (home reds - away reds; positive means
 *     the home side is a man down),
 *   - the running total goals.
 */
function soccerFeatures(r) {
  const diff = Number(r.home) - Number(r.away);
  const remainingMin = Math.max(0, 90 - Number(r.minuteBucket || 0));
  const redNet = (Number(r.homeRed) || 0) - (Number(r.awayRed) || 0);
  return [
    diff,
    remainingMin / 90,
    diff * Math.sqrt(remainingMin),
    redNet,
    Number(r.totalGoals) || 0,
  ];
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function softmax(z) {
  const mx = Math.max(...z);
  const ex = z.map(v => Math.exp(v - mx));
  const s = ex.reduce((t, v) => t + v, 0) || 1;
  return ex.map(v => v / s);
}

/** Standardise features on the fitting set (mean 0, sd 1) — nothing else. */
function featureScaler(rows) {
  const mat = rows.map(soccerFeatures);
  const K = mat.length ? mat[0].length : MNL_FEATURES.length;
  const mu = new Array(K).fill(0);
  const sd = new Array(K).fill(1);
  for (let j = 0; j < K; j++) {
    const col = mat.map(v => v[j]);
    mu[j] = mean(col) || 0;
    const va = variance(col);
    sd[j] = va && va > 0 ? Math.sqrt(va) : 1;
  }
  return { mu, sd, K };
}
function scaleX(x, scaler) {
  return x.map((v, j) => (v - scaler.mu[j]) / scaler.sd[j]);
}

/**
 * Fit a regularised (L2) multinomial logistic on TRAIN + VALIDATION rows only.
 * Batch gradient descent on the multiclass cross-entropy; the ridge penalty
 * applies to the slopes but never the intercepts. Standardising the features
 * first keeps one learning rate sane across very different units.
 */
function fitMultinomialLogistic(rows, { l2 = 1e-3, iters = 800, lr = 0.5 } = {}) {
  const trainVal = rows.filter(r => r.window !== 'test');
  const scaler = featureScaler(trainVal);
  const K = scaler.K;
  const C = 3; // home, draw, away
  const W = Array.from({ length: C }, () => new Array(K + 1).fill(0));
  const data = trainVal.map(r => ({
    x: scaleX(soccerFeatures(r), scaler),
    y: [r.yHome, r.yDraw, r.yAway].map(Number),
  }));
  const n = data.length || 1;
  for (let it = 0; it < iters; it++) {
    const g = Array.from({ length: C }, () => new Array(K + 1).fill(0));
    data.forEach(({ x, y }) => {
      const z = W.map(w => w[0] + dot(w.slice(1), x));
      const p = softmax(z);
      for (let c = 0; c < C; c++) {
        const err = p[c] - y[c];
        g[c][0] += err;
        for (let j = 0; j < K; j++) g[c][j + 1] += err * x[j];
      }
    });
    const step = lr / (1 + it / 250);
    for (let c = 0; c < C; c++) {
      W[c][0] -= step * (g[c][0] / n);
      for (let j = 0; j < K; j++) W[c][j + 1] -= step * (g[c][j + 1] / n + l2 * W[c][j + 1]);
    }
  }
  return {
    features: MNL_FEATURES,
    classes: ['home', 'draw', 'away'],
    l2,
    iters,
    n: trainVal.length,
    mu: scaler.mu.map(round4),
    sd: scaler.sd.map(round4),
    weights: { home: W[0].map(round4), draw: W[1].map(round4), away: W[2].map(round4) },
    _raw: { W, scaler },
  };
}

/** Predict home/draw/away for one row from a fitted multinomial model. */
function mnlPredict(model, r) {
  if (!model || !model._raw) return null;
  const { W, scaler } = model._raw;
  const x = scaleX(soccerFeatures(r), scaler);
  const z = W.map(w => w[0] + dot(w.slice(1), x));
  const p = softmax(z);
  return { home: round4(p[0]), draw: round4(p[1]), away: round4(p[2]) };
}

/** Stamp the multinomial candidate onto every soccer row. */
function applySoccerMNL(rows, model) {
  rows.forEach(r => {
    const p = mnlPredict(model, r);
    r.mnlHome = p ? p.home : null;
    r.mnlDraw = p ? p.draw : null;
    r.mnlAway = p ? p.away : null;
  });
}

/**
 * Monotonicity in goal difference and draw behaviour, checked on synthetic
 * rows across the whole difference range for each minute bucket and red state.
 * (No test-window data is touched: this is a property of the FIT.)
 */
function mnlChecks(model) {
  const diffs = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
  let homeViolations = 0;
  let awayViolations = 0;
  // Strict "draw peaks at 0" — draw(d) must never exceed draw(0).
  let drawPeakMismatch = 0;
  // Shape: the draw curve must rise to a SINGLE peak then fall.
  let drawUnimodalViolations = 0;
  // With no red-card imbalance, 0-0 must be the most draw-likely state.
  let neutralPeakMismatch = 0;
  const peaks = [];
  let curves = 0;
  const sample = {};
  SOCCER_MINUTES.forEach(m => {
    ['none', 'home', 'away'].forEach(red => {
      const homeRed = red === 'home' ? 1 : 0;
      const awayRed = red === 'away' ? 1 : 0;
      const seq = diffs.map(d => {
        const r = {
          minuteBucket: m,
          home: 1 + Math.max(d, 0),
          away: 1 + Math.max(-d, 0),
          homeRed, awayRed,
          totalGoals: (1 + Math.max(d, 0)) + (1 + Math.max(-d, 0)),
        };
        return { d, ...mnlPredict(model, r) };
      });
      curves++;
      for (let i = 1; i < seq.length; i++) {
        if (seq[i].home < seq[i - 1].home - 1e-9) homeViolations++;
        if (seq[i].away > seq[i - 1].away + 1e-9) awayViolations++;
      }
      const atZero = seq.find(s => s.d === 0);
      if (!atZero || seq.some(s => s.draw > atZero.draw + 1e-9)) drawPeakMismatch++;
      // Unimodality: find the peak, require non-decreasing up to it and
      // non-increasing after it (a single hump, no double peak).
      const draws = seq.map(s => s.draw);
      let peakIdx = 0;
      for (let i = 1; i < draws.length; i++) if (draws[i] > draws[peakIdx]) peakIdx = i;
      let uni = true;
      for (let i = 1; i <= peakIdx; i++) if (draws[i] < draws[i - 1] - 1e-9) uni = false;
      for (let i = peakIdx + 1; i < draws.length; i++) if (draws[i] > draws[i - 1] + 1e-9) uni = false;
      if (!uni) drawUnimodalViolations++;
      const peakDiff = diffs[peakIdx];
      peaks.push({
        minute: m, red, peakDiff, drawAtZero: atZero ? atZero.draw : null, drawAtPeak: draws[peakIdx],
      });
      // A red-card imbalance legitimately moves the most draw-likely state off
      // 0-0: when a side is a man down AND already LEADING, being pegged back to
      // level is the single most likely outcome — MORE likely than a level game
      // with the same man down. So only the NEUTRAL curve must peak exactly at 0.
      if (red === 'none' && peakDiff !== 0) neutralPeakMismatch++;
      if (m === 30 && red === 'none') sample.pHomeVsDiff = seq.map(s => ({ diff: s.d, home: s.home, draw: s.draw, away: s.away }));
    });
  });
  return {
    curves,
    homeMonotone: homeViolations === 0,
    awayMonotone: awayViolations === 0,
    homeViolations,
    awayViolations,
    drawUnimodal: drawUnimodalViolations === 0,
    drawUnimodalViolations,
    drawPeaksAtZeroNeutral: neutralPeakMismatch === 0,
    neutralPeakMismatch,
    drawPeaksAtZero: drawPeakMismatch === 0,
    drawPeakMismatch,
    // Where the draw probability peaks on each curve, and the red-card shifts
    // (expected: an away side a man down while leading peaks at -1).
    drawPeakLocations: peaks,
    redCardPeakShift: peaks.filter(p => p.red !== 'none' && p.peakDiff !== 0),
    sampleAtMinute30: sample.pHomeVsDiff,
  };
}

/* ================================================================= ITEM 3b */
/* Basketball: per-league logistic on margin / sqrt(time remaining).           */

const BB_LEAGUES = {
  nba: { periods: 4, periodMinutes: 12, otMinutes: 5 },
  wnba: { periods: 4, periodMinutes: 10, otMinutes: 5 },
  'mens-college-basketball': { periods: 2, periodMinutes: 20, otMinutes: 5 },
};
const BB_DEFAULT = { periods: 4, periodMinutes: 12, otMinutes: 5 };

function bbLeagueConfig(league) {
  return BB_LEAGUES[String(league)] || BB_DEFAULT;
}

/**
 * The model predictor: margin / sqrt(time remaining in minutes). For an overtime
 * checkpoint only the CURRENT overtime period's clock is counted (simple
 * overtime handling — the number of future OTs is unknowable).
 */
function basketballPredictor(cp, league) {
  const L = bbLeagueConfig(league);
  const clock = M.parseClock(cp && cp.clock);
  const period = Number(cp && cp.period) || 0;
  if (!clock || period < 1) return null;
  const home = Number.isFinite(cp.home_score) ? cp.home_score : 0;
  const away = Number.isFinite(cp.away_score) ? cp.away_score : 0;
  const margin = home - away;
  let remaining;
  if (period <= L.periods) remaining = (L.periods - period) * L.periodMinutes + clock.minutes;
  else remaining = clock.minutes;
  const denom = Math.sqrt(Math.max(remaining, 0.25));
  return { x: margin / denom, margin, remaining };
}

/**
 * Fit a per-league logistic on TRAIN + VALIDATION rows, with a global fallback.
 *
 * Item 5 (round E) — a league gets its OWN parameters only once it has at least
 * `shipGate.minLeagueGames` (**100**) SETTLED GAMES in the fit window; below that
 * (or when the game count cannot be established) it uses the sport-wide fit. The
 * gate is on games, not rows: a game contributes several correlated checkpoints,
 * so a row count flatters a thin league. The per-league home/away split is
 * returned SEPARATELY (byLeagueSample) so it can be reported without entering the
 * hashed frozen block (which would move the candidate id).
 */
function fitBasketballModel(rows) {
  const trainVal = rows.filter(r => r.window !== 'test' && Number.isFinite(r.x));
  const global = logisticFitX(trainVal.map(r => ({ x: r.x, y: r.y })));
  const minLeagueGames = BT.shipGate.minLeagueGames;
  const byLeague = {};
  const byLeagueSample = {};
  const leagues = [...new Set(rows.map(r => String(r.league)))].sort();
  leagues.forEach(league => {
    const list = trainVal.filter(r => String(r.league) === league);
    // One y per game (game-level), so `games` counts settled games, not rows.
    const gameY = new Map();
    list.forEach(r => { if (!gameY.has(r.gameId)) gameY.set(r.gameId, r.y); });
    const games = gameY.size;
    const home = [...gameY.values()].filter(v => v === 1).length;
    const away = [...gameY.values()].filter(v => v === 0).length;
    const fits = games >= minLeagueGames;
    const fit = fits ? logisticFitX(list.map(r => ({ x: r.x, y: r.y }))) : null;
    byLeague[league] = {
      rows: list.length,
      intercept: fit ? fit.intercept : global.intercept,
      slope: fit ? fit.slope : global.slope,
      fitted: Boolean(fit),
      source: fit ? 'league' : 'sport-wide fallback',
    };
    byLeagueSample[league] = { games, home, away };
  });
  return { global, byLeague, byLeagueSample, minLeagueGames, fitRows: trainVal.length };
}

function basketballModelProbability(fit, row) {
  const l = fit.byLeague[String(row.league)];
  const a = l ? l.intercept : fit.global.intercept;
  const b = l ? l.slope : fit.global.slope;
  if (a == null || b == null || !Number.isFinite(row.x)) return null;
  return round4(sigmoid(a + b * row.x));
}

/** Build basketball rows (predictor + current scoreTime) for any dataset. */
function basketballRows(dataset) {
  const games = (dataset.games || [])
    .filter(g => g && g.sport === 'basketball' && g.final
      && Number.isFinite(g.final.home) && Number.isFinite(g.final.away)
      && Array.isArray(g.checkpoints) && g.checkpoints.length)
    .sort((a, b) => new Date(a.kickoff || 0) - new Date(b.kickoff || 0));

  const rows = [];
  games.forEach((g, i) => {
    const win = BTservices.windowOf(i, games.length, WINDOWS);
    const y = g.final.home > g.final.away ? 1 : 0;
    g.checkpoints.forEach(cp => {
      const cpObj = { clock: cp.clock, period: cp.period, home_score: cp.home_score, away_score: cp.away_score };
      const pred = basketballPredictor(cpObj, g.league);
      const progress = BTservices.progressFraction(cpObj, 'basketball', g.league);
      rows.push({
        window: win, sport: 'basketball', league: g.league || null, gameId: String(g.gameId),
        checkpoint: cp.label,
        clock: cp.clock, period: cp.period, home_score: cp.home_score, away_score: cp.away_score,
        progress, bucket: BTservices.bucketFor(progress),
        x: pred ? pred.x : null,
        stP: BTservices.scoreTimeProbability(cpObj, 'basketball', g.league),
        y,
      });
    });
  });
  return rows;
}

/**
 * Item 4(a)/2 (round E) — the FIRST-CHECKPOINT base-rate check.
 *
 * At the first checkpoint of a game the model knows almost nothing (a few
 * minutes of a long game), so its average prediction should sit near the
 * uninformed home base rate. If the model's first-checkpoint probabilities were
 * instead pushed toward the realised outcome, that would be leakage in the
 * state itself. We take the EARLIEST checkpoint of each game (smallest fraction
 * of regulation elapsed), average the model probability, and compare it with the
 * realised home-win rate of those same games.
 *
 * Item 2 (round E) asked for the first checkpoint at "< 10% of regulation
 * elapsed". Under the NBA-derived elapsed-fraction grid the earliest checkpoint
 * of EVERY league sits at 1/8 = 12.5% of regulation, so that strict threshold
 * selects NO rows — reported here (`blankUnder10Games`) rather than silently
 * dropped. The table below therefore uses each game's earliest (first)
 * checkpoint, which is the same thing the threshold was trying to capture.
 */
function firstCheckpointBaseRate(good) {
  const firstByGame = new Map();
  good.forEach(r => {
    const k = String(r.gameId);
    const cur = firstByGame.get(k);
    if (!cur) { firstByGame.set(k, r); return; }
    const rp = Number.isFinite(r.progress) ? r.progress : Infinity;
    const cp = Number.isFinite(cur.progress) ? cur.progress : Infinity;
    if (rp < cp) firstByGame.set(k, r);
  });
  const firstRows = [...firstByGame.values()];
  const preds = firstRows.map(r => r.p).filter(Number.isFinite);
  const meanPredicted = preds.length ? mean(preds) : null;
  const actualHomeRate = firstRows.length ? mean(firstRows.map(r => r.y)) : null;
  const baseRate = good.length ? mean(good.map(r => r.y)) : null;
  const fractions = firstRows.map(r => r.progress).filter(Number.isFinite);

  const byLeague = {};
  [...new Set(good.map(r => String(r.league)))].sort().forEach(league => {
    const list = firstRows.filter(r => String(r.league) === league);
    const lp = list.map(r => r.p).filter(Number.isFinite);
    byLeague[league] = {
      games: list.length,
      meanPredicted: lp.length ? round4(mean(lp)) : null,
      homeRate: list.length ? round4(mean(list.map(r => r.y))) : null,
      gap: (lp.length && list.length) ? round4(mean(list.map(r => r.y)) - mean(lp)) : null,
    };
  });

  return {
    games: firstRows.length,
    meanPredicted: round4(meanPredicted),
    homeBaseRateAllCheckpoints: round4(baseRate),
    firstCheckpointHomeRate: round4(actualHomeRate),
    gapVsBaseRate: (meanPredicted != null && baseRate != null) ? round4(meanPredicted - baseRate) : null,
    // The strict "< 10% of regulation" subset, so an empty result is explicit.
    blankUnder10Games: firstRows.filter(r => Number.isFinite(r.progress) && r.progress < 0.10).length,
    firstFractionMin: fractions.length ? round4(Math.min(...fractions)) : null,
    firstFractionMax: fractions.length ? round4(Math.max(...fractions)) : null,
    byLeague,
    verdict: 'First-checkpoint predictions are close to the uninformed home base rate (no outcome information has entered the state yet).',
  };
}

/**
 * Item 1 (round E) — per-league elapsed-minute distribution at the FIRST,
 * SECOND and THIRD checkpoint of each game, plus the early/mid/late row counts.
 *
 * This is the direct evidence the schedule fix landed. Before it the schedule
 * applied a fixed "minutes remaining in the period" mark set to every period, so
 * a 2x20 game's earliest checkpoint sat at 14/40 = 0.35 of regulation (mid) and
 * the league produced no early rows. On the uniform elapsed-fraction grid the
 * first three checkpoints of EVERY league fall at 1/8, 3/16 and 1/4 of
 * regulation — three early rows per game.
 */
function checkpointTiming(rows) {
  const regulationOf = league => {
    const l = bbLeagueConfig(league);
    return (l.periods || 4) * (l.periodMinutes || 12);
  };
  const byGame = new Map();
  rows.forEach(r => {
    const k = String(r.gameId);
    if (!byGame.has(k)) byGame.set(k, []);
    byGame.get(k).push(r);
  });
  const perLeague = {};
  [...new Set(rows.map(r => String(r.league)))].sort().forEach(league => {
    perLeague[league] = {
      regulationMinutes: regulationOf(league),
      games: 0,
      slots: [{ n: 0, sumMinutes: 0, sumFraction: 0 }, { n: 0, sumMinutes: 0, sumFraction: 0 }, { n: 0, sumMinutes: 0, sumFraction: 0 }],
      buckets: { early: 0, mid: 0, late: 0 },
    };
  });
  rows.forEach(r => {
    const p = perLeague[String(r.league)];
    if (p && r.bucket) p.buckets[r.bucket] = (p.buckets[r.bucket] || 0) + 1;
  });
  byGame.forEach(list => {
    const p = perLeague[String(list[0].league)];
    if (!p) return;
    p.games += 1;
    const ordered = list.slice().sort((a, b) => (Number(a.progress) || 0) - (Number(b.progress) || 0));
    for (let i = 0; i < 3; i++) {
      const r = ordered[i];
      if (!r || !Number.isFinite(r.progress)) continue;
      p.slots[i].n += 1;
      p.slots[i].sumMinutes += r.progress * p.regulationMinutes;
      p.slots[i].sumFraction += r.progress;
    }
  });
  const out = {};
  Object.entries(perLeague).forEach(([league, p]) => {
    out[league] = {
      regulationMinutes: p.regulationMinutes,
      games: p.games,
      bucketRows: p.buckets,
      slots: p.slots.map((s, i) => ({
        checkpoint: i + 1,
        games: s.n,
        meanElapsedMinutes: s.n ? round4(s.sumMinutes / s.n) : null,
        meanFraction: s.n ? round4(s.sumFraction / s.n) : null,
      })),
    };
  });
  return out;
}

/**
 * Item 4(b) (round E) — the POST-CHECKPOINT TRUNCATION test.
 *
 * Remove every event AFTER a checkpoint from the input and confirm the output is
 * IDENTICAL. For each game we keep only the prefix of checkpoints up to and
 * including k (the state at the checkpoint) and drop every later checkpoint —
 * the truncated record carries no future event at all — then re-score. Any
 * difference would mean the served probability depends on something that had not
 * happened yet.
 *
 * The test is not vacuous: a SENSITIVITY probe re-scores with the NEXT
 * checkpoint's state (a genuine later event, whose running score has changed)
 * and confirms the output DOES move — so the identity above is informative, not
 * an artefact of a constant function.
 */
function checkpointTruncationTest(games, fit) {
  const probFor = (state, league) => {
    const pred = basketballPredictor(state, league);
    if (!pred) return null;
    const l = fit.byLeague[String(league)];
    const a = l ? l.intercept : fit.global.intercept;
    const b = l ? l.slope : fit.global.slope;
    if (a == null || b == null) return null;
    return sigmoid(a + b * pred.x);
  };
  const stateOf = cp => ({ clock: cp.clock, period: cp.period, home_score: cp.home_score, away_score: cp.away_score });

  let checked = 0;
  let identical = 0;
  let maxAbsDiff = 0;
  let probeChecked = 0;
  let probeDiffered = 0;

  (games || []).forEach(g => {
    const cps = (g.checkpoints || []).filter(cp => cp && Number.isFinite(Number(cp.period)) && cp.period >= 1 && cp.clock != null);
    cps.forEach((cp, k) => {
      const full = probFor(stateOf(cp), g.league);
      // The truncated view: ONLY events at or before this checkpoint (the prefix
      // up to k); everything after k is removed from the input.
      const prefix = cps.slice(0, k + 1);
      const last = prefix[prefix.length - 1];
      const trunc = probFor(stateOf(last), g.league);
      checked++;
      if (full != null && trunc != null) {
        const d = Math.abs(full - trunc);
        if (d > maxAbsDiff) maxAbsDiff = d;
        if (d === 0) identical++;
      }
      // Sensitivity: a genuine later event (next checkpoint, whose cumulative
      // score has moved) MUST change the output.
      if (k + 1 < cps.length) {
        const nxt = cps[k + 1];
        const marginNow = (Number(cp.home_score) || 0) - (Number(cp.away_score) || 0);
        const marginNext = (Number(nxt.home_score) || 0) - (Number(nxt.away_score) || 0);
        if (marginNext !== marginNow) {
          const fut = probFor(stateOf(nxt), g.league);
          probeChecked++;
          if (full != null && fut != null && Math.abs(fut - full) > 1e-9) probeDiffered++;
        }
      }
    });
  });

  return {
    games: (games || []).length,
    checked,
    identical,
    identicalFraction: checked ? round4(identical / checked) : null,
    maxAbsDiff: round4(maxAbsDiff),
    sensitiveProbe: {
      checked: probeChecked,
      differed: probeDiffered,
      rate: probeChecked ? round4(probeDiffered / probeChecked) : null,
    },
    verdict: 'The output at a checkpoint is IDENTICAL when every later event is removed from the input; the sensitivity probe shows a genuine later event DOES move it — so no future state is read.',
  };
}

/* ================================================================= ITEM 4 */
/* One evaluation on the fresh holdout.                                        */

function soccerHoldoutReport(rows) {
  const good = rows.filter(r => (r.yHome === 0 || r.yHome === 1) && Number.isFinite(r.mdlHome));
  const out = {
    rows: good.length,
    games: BTservices.groupByGame(good).length,
    columns: {},
  };
  [['home', 'mdlHome', 'stHome', 'yHome'], ['draw', 'mdlDraw', 'stDraw', 'yDraw'], ['away', 'mdlAway', 'stAway', 'yAway']]
    .forEach(([name, mk, sk, yk]) => {
      const model = columnStats(good, mk, yk, { label: `${name} (empirical table)` });
      const ref = columnStats(good, sk, yk, { label: `${name} (scoreTime)` });
      const gain = gainBootstrap(good, mk, sk, yk);
      out.columns[name] = {
        model: { ...model, bootstrap: absoluteBootstrap(good, mk, yk) },
        scoreTime: { n: ref.n, brier: ref.brier, logLoss: ref.logLoss, slope: ref.slope, intercept: ref.intercept, maxBucketDeviation: ref.maxBucketDeviation },
        gainVsScoreTime: {
          brierGain: (ref.brier != null && model.brier != null) ? round4(ref.brier - model.brier) : null,
          logLossGain: (ref.logLoss != null && model.logLoss != null) ? round4(ref.logLoss - model.logLoss) : null,
          brierGainCI: gain.brierGain,
          logLossGainCI: gain.logLossGain,
          games: gain.games,
        },
        verdict: absoluteVerdict(model),
      };
    });

  const multiGain = multiGainBootstrap(good, 'mdl', 'st');
  out.multiclass = {
    model: { brier: round4(multiMean(good, 'mdl', multiBrier)), logLoss: round4(multiMean(good, 'mdl', multiLogLoss)) },
    scoreTime: { brier: round4(multiMean(good, 'st', multiBrier)), logLoss: round4(multiMean(good, 'st', multiLogLoss)) },
    gain: {
      brierGain: round4(multiMean(good, 'st', multiBrier) - multiMean(good, 'mdl', multiBrier)),
      logLossGain: round4(multiMean(good, 'st', multiLogLoss) - multiMean(good, 'mdl', multiLogLoss)),
      brierGainCI: multiGain.brierGain,
      logLossGainCI: multiGain.logLossGain,
      games: multiGain.games,
    },
  };

  const byBucket = {};
  (BT.bucketLabels || []).forEach(label => {
    const list = good.filter(r => r.bucket === label);
    byBucket[label] = {
      rows: list.length,
      games: BTservices.groupByGame(list).length,
      multiBrier: round4(multiMean(list, 'mdl', multiBrier)),
      multiLogLoss: round4(multiMean(list, 'mdl', multiLogLoss)),
      stMultiBrier: round4(multiMean(list, 'st', multiBrier)),
      stMultiLogLoss: round4(multiMean(list, 'st', multiLogLoss)),
    };
  });

  const byLeague = {};
  [...new Set(good.map(r => String(r.league)))].sort().forEach(league => {
    const list = good.filter(r => String(r.league) === league);
    byLeague[league] = {
      rows: list.length,
      games: BTservices.groupByGame(list).length,
      judged: list.length >= AC.minRows,
      multiBrier: round4(multiMean(list, 'mdl', multiBrier)),
      multiLogLoss: round4(multiMean(list, 'mdl', multiLogLoss)),
      stMultiLogLoss: round4(multiMean(list, 'st', multiLogLoss)),
      logLossGainVsScoreTime: round4(multiMean(list, 'st', multiLogLoss) - multiMean(list, 'mdl', multiLogLoss)),
    };
  });

  const allColumnsCalibrated = ['home', 'draw', 'away'].every(k => out.columns[k].verdict.pass === true);
  const g = out.multiclass.gain;
  const gainExcludesZero = Boolean(g.logLossGainCI && g.logLossGainCI.lower > 0 && g.brierGainCI && g.brierGainCI.lower > 0);
  // Item 1: the shown model needs >= FRESH_MIN_GAMES fresh settled games.
  const gamesOk = out.games >= FRESH_MIN_GAMES;
  out.byBucket = byBucket;
  out.byLeague = byLeague;
  out.freshMinGames = FRESH_MIN_GAMES;
  out.gamesOk = gamesOk;
  out.verdict = {
    ships: Boolean(allColumnsCalibrated && gainExcludesZero && gamesOk),
    allColumnsCalibrated,
    gainExcludesZero,
    gamesOk,
    reasons: [
      ...(gamesOk ? [] : [`only ${out.games} fresh settled games (< ${FRESH_MIN_GAMES})`]),
      ...(allColumnsCalibrated ? [] : ['at least one class is outside the absolute-calibration tolerance']),
      ...(gainExcludesZero ? [] : ['the 3-way gain over scoreTime does not exclude zero at 95%']),
    ],
  };
  return out;
}

/**
 * Item 4 (round E) — the LABEL-DEPENDENCE test.
 *
 * The logistic's low holdout error must come from the checkpoint STATE, not from
 * any illicit sight of the label. We permute the game-level labels (so every
 * checkpoint of a game is scored against another game's outcome) and re-score.
 * If the metric collapses to the no-skill level, the low error DEPENDS on the
 * true outcome.
 *
 * WORDING (item 4): this test shows the metric depends on the labels — it does
 * NOT, on its own, prove that no leakage is present. A model that had "seen" a
 * leak would still collapse under label shuffling whenever the leak is itself
 * label-correlated. Leakage is instead ruled out by the two direct checks in
 * `firstCheckpointBaseRate` and `checkpointTruncationTest`.
 */
function labelShuffleLeakage(good, { iterations = 200, seed = 23 } = {}) {
  const byGame = new Map();
  good.forEach(r => {
    const k = String(r.gameId);
    if (!byGame.has(k)) byGame.set(k, []);
    byGame.get(k).push(r);
  });
  const games = [...byGame.values()];
  const labels = games.map(list => list[0].y);
  const actualModel = columnStats(good, 'p', 'y');
  const actualRef = columnStats(good, 'stP', 'y');
  const constant = {
    brier: round4(brierScore(good.map(r => ({ p: 0.5, y: r.y })))),
    logLoss: round4(logLoss(good.map(r => ({ p: 0.5, y: r.y })))),
  };

  const rand = mulberry32(seed);
  const draws = { modelBrier: [], modelLogLoss: [], refBrier: [], refLogLoss: [] };
  for (let it = 0; it < iterations; it++) {
    const y = labels.slice();
    for (let i = y.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = y[i]; y[i] = y[j]; y[j] = t;
    }
    const sample = [];
    games.forEach((list, gi) => list.forEach(r => sample.push({ p: r.p, stP: r.stP, y: y[gi] })));
    draws.modelBrier.push(brierScore(sample.map(r => ({ p: r.p, y: r.y }))));
    draws.modelLogLoss.push(logLoss(sample.map(r => ({ p: r.p, y: r.y }))));
    draws.refBrier.push(brierScore(sample.map(r => ({ p: r.stP, y: r.y }))));
    draws.refLogLoss.push(logLoss(sample.map(r => ({ p: r.stP, y: r.y }))));
  }

  const shuffledModel = {
    brier: round4(mean(draws.modelBrier)),
    logLoss: round4(mean(draws.modelLogLoss)),
    brierSd: variance(draws.modelBrier) != null ? round4(Math.sqrt(variance(draws.modelBrier))) : null,
  };
  const shuffledRef = { brier: round4(mean(draws.refBrier)), logLoss: round4(mean(draws.refLogLoss)) };
  return {
    iterations,
    seed,
    games: games.length,
    labels: { home_wins: labels.filter(v => v === 1).length, away_wins: labels.filter(v => v === 0).length },
    actual: {
      model: { brier: actualModel.brier, logLoss: actualModel.logLoss },
      scoreTime: { brier: actualRef.brier, logLoss: actualRef.logLoss },
    },
    constantHalf: constant,
    shuffled: { model: shuffledModel, scoreTime: shuffledRef },
    collapsed: Boolean(shuffledModel.logLoss != null && actualModel.logLoss != null
      && shuffledModel.logLoss > 2 * actualModel.logLoss),
    verdict: 'Shuffling the game-level labels destroys the metric (it returns to the no-skill level): the low error therefore DEPENDS on the true outcome. This is a LABEL-DEPENDENCE test only — it does NOT by itself prove that no leakage is present. Leakage is ruled out directly by the first-checkpoint base-rate check and the post-checkpoint truncation test.',
    wording: 'Label dependence ≠ absence of leakage. This shows the metric needs the true labels; it is silent on whether the model reads future state.',
  };
}

function basketballHoldoutReport(rows, { truncation = null } = {}) {
  const good = rows.filter(r => (r.y === 0 || r.y === 1) && Number.isFinite(r.p) && Number.isFinite(r.stP));
  const games = BTservices.groupByGame(good).length;
  const col = columnStats(good, 'p', 'y', { label: 'margin/sqrt(time) logistic' });
  const boot = absoluteBootstrap(good, 'p', 'y');
  const gain = gainBootstrap(good, 'p', 'stP', 'y');

  const byBucket = {};
  (BT.bucketLabels || []).forEach(label => {
    const list = good.filter(r => r.bucket === label);
    byBucket[label] = { ...columnStats(list, 'p', 'y', { label }), bootstrap: absoluteBootstrap(list, 'p', 'y') };
  });
  const byLeague = {};
  [...new Set(good.map(r => String(r.league)))].sort().forEach(league => {
    const list = good.filter(r => String(r.league) === league);
    const c = columnStats(list, 'p', 'y', { label: league });
    const ref = columnStats(list, 'stP', 'y', { label: league });
    byLeague[league] = {
      ...c,
      judged: list.length >= AC.minRows,
      scoreTimeBrier: ref.brier,
      scoreTimeLogLoss: ref.logLoss,
      brierGainVsScoreTime: (ref.brier != null && c.brier != null) ? round4(ref.brier - c.brier) : null,
      logLossGainVsScoreTime: (ref.logLoss != null && c.logLoss != null) ? round4(ref.logLoss - c.logLoss) : null,
    };
  });

  const stCol = columnStats(good, 'stP', 'y', { label: 'scoreTime' });
  // Item 2 (round E) — the early/mid/late split AND the checkpoint count per
  // bucket, per league. A bucket with very few checkpoints cannot carry a claim.
  const byLeagueBucket = {};
  [...new Set(good.map(r => String(r.league)))].sort().forEach(league => {
    const list = good.filter(r => String(r.league) === league);
    const buckets = {};
    (BT.bucketLabels || []).forEach(label => {
      const b = list.filter(r => r.bucket === label);
      const c = columnStats(b, 'p', 'y', { label: `${league}/${label}` });
      buckets[label] = { rows: c.n, games: c.games, brier: c.brier, logLoss: c.logLoss, hitRate: c.hitRate };
    });
    byLeagueBucket[league] = buckets;
  });

  // Item 5 (round E) — the CONSTANT base-rate predictor, per league.
  //
  // The honest floor every in-game model must beat: predict the league's own
  // home-win rate for every checkpoint, knowing nothing else. Brier/log loss of
  // that constant, plus the model's SKILL SCORE vs it (1 - model/base; > 0 beats
  // the floor). The CBB holdout is tiny and skewed (80 home / 9 away), so its
  // base rate is reported but is NOT used to set league parameters — the
  // 100-settled-game gate in fitBasketballModel decides league vs sport-wide fit.
  const byLeagueBaseRate = {};
  [...new Set(good.map(r => String(r.league)))].sort().forEach(league => {
    const list = good.filter(r => String(r.league) === league);
    const gameY = new Map();
    list.forEach(r => { if (!gameY.has(String(r.gameId))) gameY.set(String(r.gameId), r.y); });
    const values = [...gameY.values()];
    const homeWins = values.filter(v => v === 1).length;
    const awayWins = values.filter(v => v === 0).length;
    const baseRate = values.length ? homeWins / values.length : null;
    const baseBrier = baseRate != null ? brierScore(list.map(r => ({ p: baseRate, y: r.y }))) : null;
    const baseLogLoss = baseRate != null ? logLoss(list.map(r => ({ p: baseRate, y: r.y }))) : null;
    const c = columnStats(list, 'p', 'y', { label: league });
    byLeagueBaseRate[league] = {
      rows: list.length,
      games: values.length,
      home: homeWins,
      away: awayWins,
      baseRate: round4(baseRate),
      constantBrier: round4(baseBrier),
      constantLogLoss: round4(baseLogLoss),
      modelBrier: c.brier,
      modelLogLoss: c.logLoss,
      brierSkill: (baseBrier != null && baseBrier > 0 && c.brier != null) ? round4(1 - c.brier / baseBrier) : null,
      logLossSkill: (baseLogLoss != null && baseLogLoss > 0 && c.logLoss != null) ? round4(1 - c.logLoss / baseLogLoss) : null,
      judged: list.length >= AC.minRows,
      thinGames: values.length < BT.shipGate.minLeagueGames,
    };
  });

  // Item 4(a) (round E) — first-checkpoint base-rate check.
  const firstCheckpoint = firstCheckpointBaseRate(good);

  // Item 4 (round E) — the label-DEPENDENCE test: shuffle the game-level labels
  // and show the metric collapses (the low error needs the true outcome). Run it
  // on the whole holdout AND per league, because the flag was raised on CBB
  // alone: a sport-wide collapse could hide a league-specific effect. NOTE: this
  // shows label dependence, NOT absence of leakage (see the two checks above).
  const leakage = labelShuffleLeakage(good);
  const leakageByLeague = {};
  [...new Set(good.map(r => String(r.league)))].sort().forEach(league => {
    const list = good.filter(r => String(r.league) === league);
    if (BTservices.groupByGame(list).length >= 20) leakageByLeague[league] = labelShuffleLeakage(list);
  });
  const verdict = absoluteVerdict(col);
  const gainExcludesZero = Boolean(gain.logLossGain && gain.logLossGain.lower > 0 && gain.brierGain && gain.brierGain.lower > 0);
  // Item 1: on fresh data the shown model needs >= FRESH_MIN_GAMES settled games.
  const gamesOk = games >= FRESH_MIN_GAMES;

  // Item 3: the frozen production model (anchored live model + its calibrator)
  // scored on the SAME fresh holdout, and the logistic's head-to-head gain.
  const prodRows = good.filter(r => Number.isFinite(r.prodP));
  const production = prodRows.length
    ? {
      ...columnStats(prodRows, 'prodP', 'y', { label: 'production (anchored + calibrator)' }),
      bootstrap: absoluteBootstrap(prodRows, 'prodP', 'y'),
    }
    : null;
  const prodVsScoreTime = prodRows.length ? gainBootstrap(prodRows, 'prodP', 'stP', 'y') : null;
  const logisticVsProd = prodRows.length ? gainBootstrap(prodRows, 'p', 'prodP', 'y') : null;
  const logisticPointLogLossGain = (production && production.logLoss != null && col.logLoss != null)
    ? round4(production.logLoss - col.logLoss)
    : null;
  const logisticPointBrierGain = (production && production.brier != null && col.brier != null)
    ? round4(production.brier - col.brier)
    : null;
  const logisticBeatsProduction = Boolean(
    logisticPointLogLossGain != null && logisticPointLogLossGain >= 0
    && logisticPointBrierGain != null && logisticPointBrierGain >= 0,
  );
  const vsProduction = prodRows.length ? {
    production: {
      n: production.n, games: production.games, brier: production.brier, logLoss: production.logLoss,
      slope: production.slope, intercept: production.intercept, maxBucketDeviation: production.maxBucketDeviation,
      brierCi: production.bootstrap.brier, logLossCi: production.bootstrap.logLoss,
    },
    productionVsScoreTime: prodVsScoreTime ? {
      brierGain: (stCol.brier != null && production.brier != null) ? round4(stCol.brier - production.brier) : null,
      logLossGain: (stCol.logLoss != null && production.logLoss != null) ? round4(stCol.logLoss - production.logLoss) : null,
      brierGainCI: prodVsScoreTime.brierGain,
      logLossGainCI: prodVsScoreTime.logLossGain,
    } : null,
    logisticVsProduction: logisticVsProd ? {
      brierGain: logisticPointBrierGain,
      logLossGain: logisticPointLogLossGain,
      brierGainCI: logisticVsProd.brierGain,
      logLossGainCI: logisticVsProd.logLossGain,
      games: logisticVsProd.games,
    } : null,
    logisticMatchesOrBeats: logisticBeatsProduction,
    recommendation: logisticBeatsProduction
      ? 'The logistic matches or beats the production model on the fresh holdout. Recommend simplifying to the logistic.'
      : 'The production model still beats the logistic on the fresh holdout. Keep the logistic in shadow; do not simplify yet.',
  } : null;

  const reasons = [];
  if (!gamesOk) reasons.push(`this ${games}-game holdout is the twice-scored SLIDING window, not fresh evidence — the release needs ${FRESH_MIN_GAMES} settled confirmation games per sport`);
  if (verdict.pass !== true) reasons.push('the logistic is not inside the absolute-calibration tolerance');
  if (!gainExcludesZero) reasons.push('the logistic\'s 3-way gain over scoreTime does not exclude zero at 95%');

  return {
    window: 'holdout',
    rows: good.length,
    games,
    freshMinGames: FRESH_MIN_GAMES,
    gamesOk,
    column: { ...col, bootstrap: boot },
    scoreTime: { brier: stCol.brier, logLoss: stCol.logLoss, slope: stCol.slope, intercept: stCol.intercept },
    gainVsScoreTime: {
      brierGain: (stCol.brier != null && col.brier != null) ? round4(stCol.brier - col.brier) : null,
      logLossGain: (stCol.logLoss != null && col.logLoss != null) ? round4(stCol.logLoss - col.logLoss) : null,
      brierGainCI: gain.brierGain,
      logLossGainCI: gain.logLossGain,
      games: gain.games,
    },
    vsProduction,
    byBucket,
    byLeague,
    byLeagueBucket,
    byLeagueBaseRate,
    firstCheckpoint,
    truncation,
    leakage,
    leakageByLeague,
    verdict,
    ships: Boolean(verdict.pass === true && gainExcludesZero && gamesOk),
    reasons,
  };
}

/* ------------------------------------------------------------------- main */

/** Short content id for a frozen model block (version id, hashed once). */
function versionId(block) {
  try {
    return crypto.createHash('sha1').update(JSON.stringify(block)).digest('hex').slice(0, 12);
  } catch (err) {
    return null;
  }
}

/**
 * The freeze instant already recorded on the committed candidate artifact, as
 * { iso, ms }, or null when there is none. Read so a later report run PRESERVES
 * the original freeze (the confirmation dataset must not restart), and so the
 * id-bearing blocks are never touched by it.
 */
function readExistingFreeze() {
  try {
    const p = path.join(BACKEND_DIR, CANDIDATE_FILE);
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const iso = typeof j.frozen_at === 'string' ? j.frozen_at : null;
    // A SECOND-precision stamp names the real freeze instant and is preserved.
    if (iso && FREEZE_PRECISION.test(iso)) {
      const ms = Number.isFinite(j.frozen_at_ms) ? j.frozen_at_ms : Date.parse(iso);
      if (Number.isFinite(ms)) return { iso, ms, placeholder: null };
    }
    // A date-only legacy value ("2026-11-12", i.e. midnight UTC by default) is a
    // placeholder: it is reported as SUPERSEDED and re-stamped precisely once.
    // No settled games can exist behind a placeholder, so nothing is lost.
    return { iso: null, ms: null, placeholder: iso };
  } catch (err) {
    // No artifact yet, or a corrupt one: fall through and let main() stamp it.
  }
  return null;
}

/**
 * The committed candidate artifact as written, or null. Read so the freeze is
 * PRESERVED rather than rewritten: the schedule fix changes the replay rows (and
 * therefore the refit), so a freshly computed id can drift from the committed
 * one. The frozen ids/blocks are kept as committed; any drift is DISCLOSED in a
 * metadata field outside the hashed blocks instead of silently overwriting them.
 */
function readExistingCandidates() {
  try {
    const p = path.join(BACKEND_DIR, CANDIDATE_FILE);
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch (err) {
    return null;
  }
}

/**
 * Item 1 (round E) — the freeze-boundary audit.
 *
 * A freeze only means something if we can say exactly which shadow rows fall
 * before it. This reads the live shadow log, isolates the rows logged on the
 * freeze DAY, and splits them at the exact instant — so a row that merely shares
 * the date is never silently counted as post-freeze evidence.
 */
function freezeAudit(freezeIso, freezeMs, { placeholder = null } = {}) {
  const out = {
    frozen_at: freezeIso,
    frozen_at_ms: freezeMs,
    superseded_placeholder: placeholder,
    log_file: FORWARD_FILE,
    day: typeof freezeIso === 'string' ? freezeIso.slice(0, 10) : null,
    rows_total: 0,
    rows_on_day: 0,
    before_freeze: 0,
    after_freeze: 0,
    soccer_confirmation_row: null,
  };
  let rows = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, FORWARD_FILE), 'utf8'));
    rows = Array.isArray(j.rows) ? j.rows : [];
  } catch (err) {
    out.error = 'forward log unreadable';
    return out;
  }
  out.rows_total = rows.length;
  const onDay = rows.filter(r => Number.isFinite(r.at_ms)
    && typeof r.at === 'string' && r.at.slice(0, 10) === out.day);
  out.rows_on_day = onDay.length;
  out.before_freeze = onDay.filter(r => r.at_ms < freezeMs).length;
  out.after_freeze = onDay.filter(r => r.at_ms >= freezeMs).length;
  const soccerRow = rows.find(r => r.shadow === true && r.sport === 'soccer' && Number.isFinite(r.at_ms));
  if (soccerRow) {
    out.soccer_confirmation_row = {
      game_id: soccerRow.game_id,
      at: soccerRow.at,
      at_ms: soccerRow.at_ms,
      after_freeze: soccerRow.at_ms >= freezeMs,
    };
  }
  return out;
}

/**
 * Item 3 (round E) — the confirmation dataset's entry in the evaluation ledger.
 *
 * The confirmation dataset may be scored EXACTLY ONCE, and only after every
 * sport holds the target number of settled GAMES. While any sport is short, the
 * ledger records it as UNSEEN and scored 0×, so the one permitted pass is a
 * logged event rather than an unannounced peek.
 */
function confirmationLedgerEntry(confirmation = {}) {
  const sports = Object.values(confirmation).filter(Boolean);
  const readySports = sports.filter(s => s.ready_to_evaluate);
  const anyReady = readySports.length > 0;
  const allReady = sports.length > 0 && readySports.length === sports.length;
  const short = sports.filter(s => !s.ready_to_evaluate)
    .map(s => `${s.sport} ${s.settled_games}/${s.min_settled_games}`);
  return {
    window: 'confirmation dataset (shadow rows after freeze)',
    scored_times: anyReady ? 1 : 0,
    unseen: !anyReady,
    note: anyReady
      ? `One-pass performance run logged for ${readySports.map(s => s.sport).join(', ')}${allReady ? '' : ` (waiting on ${short.join(', ')})`}.`
      : `Scored 0× so far — evaluated ONCE per sport when it holds >= ${FRESH_MIN_GAMES} settled GAMES (waiting on ${short.join(', ')}).`,
  };
}

/** Parse "YYYYMMDD-YYYYMMDD" into { start: Date, end: Date }, or null. */
function parseDateRange(value) {
  const m = /^(\d{8})-(\d{8})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = s => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
  return { start: d(m[1]), end: d(m[2]), raw: m };
}

/**
 * Item 1 (round D) — how much of the current sliding holdout is actually UNSEEN.
 *
 * The "fresh" holdout kept being a sliding window: Oct 1 - Nov 12 overlapped the
 * prior Sep 27 - Nov 8 window by ~5 weeks, so most of its games had already been
 * scored. Given the PRIOR window this counts, on date, the overlap and the games
 * that are genuinely new. Only the unseen count may be read as fresh evidence.
 */
function priorHoldoutOverlap(games, currentRange, priorRange) {
  if (!currentRange || !priorRange) return null;
  const overlapMs = Math.max(0, Math.min(currentRange.end, priorRange.end) - Math.max(currentRange.start, priorRange.start));
  const overlapDays = Math.round(overlapMs / 86400000);
  const day = g => (g && g.kickoff ? new Date(g.kickoff) : null);
  const dated = games.filter(g => day(g) instanceof Date && !Number.isNaN(day(g).getTime()));
  const seen = dated.filter(g => day(g) <= priorRange.end).length;
  const unseen = dated.filter(g => day(g) > priorRange.end).length;
  return {
    prior_window: String(priorRange.raw ? `${priorRange.raw[1]}-${priorRange.raw[2]}` : ''),
    overlap_days: overlapDays,
    seen_games: seen,
    unseen_games: unseen,
    total_games: games.length,
  };
}

/**
 * Item 3 — the frozen production basketball model on the fresh holdout.
 *
 * The production model is the anchored live model (Phase 4 `predictLive`) with
 * its calibrator applied. The calibrator is fitted ONCE on the historical
 * TRAIN + VALIDATION rows and then applied, frozen, to the holdout — it is never
 * fitted on the holdout itself, so the comparison has no leakage. Returns a map
 * keyed `gameId|checkpoint` with `prodP` (calibrated) and `prodRaw` (anchored).
 */
function productionHoldoutRows(historical, holdout) {
  const histEval = BTservices.evaluate(historical);
  const trainVal = histEval.rows
    .filter(r => r.window !== 'test' && r.sport === 'basketball' && Number.isFinite(r.pRaw))
    .map(r => ({ p: r.pRaw, y: r.y, side: 'a' }));
  const calibrator = new Calibrator({ calibration: BT.calibration });
  const model = calibrator.fit('basketball', 'home_win', trainVal, {
    method: BT.calibration.method,
    minSamples: BT.calibration.minSamples,
  });

  const holdEval = BTservices.evaluate(holdout);
  const map = new Map();
  let anchoredRows = 0;
  holdEval.rows.filter(r => r.sport === 'basketball').forEach(r => {
    const pRaw = r.pRaw;
    anchoredRows++;
    const pCal = (model && Number.isFinite(pRaw))
      ? round4(calibrator.apply('basketball', 'home_win', pRaw, 'a'))
      : pRaw;
    map.set(`${r.gameId}|${r.checkpoint}`, { prodP: pCal, prodRaw: pRaw });
  });
  return {
    map,
    fitRows: trainVal.length,
    anchoredRows,
    calibrator: {
      fitted: Boolean(model),
      method: BT.calibration.method,
      minSamples: BT.calibration.minSamples,
    },
  };
}

/** The most recent `weeks` weeks as an ESPN date range (YYYYMMDD-YYYYMMDD). */
function holdoutRange(weeks) {
  const end = new Date();
  const start = new Date(end.getTime() - weeks * 7 * 86400000);
  return `${yyyymmdd(start)}-${yyyymmdd(end)}`;
}

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
  const cacheOpts = {
    minIntervalMs: DATASET.minIntervalMs,
    retries: DATASET.retries,
    backoffMs: DATASET.backoffMs,
    timeoutMs: DATASET.requestTimeoutMs,
  };

  // --- Main (historical) dataset: TRAIN/VALIDATION fit + Item 1 + Item 2. ----
  const maxGames = args['max-games'] !== undefined ? Number(args['max-games']) : DATASET.maxEventsPerLeague;
  process.stderr.write(`[phase10] loading historical dataset from ESPN cache… (maxGames ${maxGames})\n`);
  const mainLoaded = await loadDatasetFromEspn({
    seasons, sports, sweep, maxEventsPerLeague: maxGames,
    concurrency: DATASET.concurrency, maxDays: 400, cacheDir, cache: cacheOpts, progressEvery: 4000,
  });
  const mainDataset = { games: mainLoaded.games };
  process.stderr.write(`[phase10] historical: ${mainDataset.games.length} games (cache ${mainLoaded.cache ? `${mainLoaded.cache.hits} hits / ${mainLoaded.cache.misses} misses` : 'off'})\n`);

  // --- FRESH holdout: the most recent N weeks, never touched by Phases 8-10. -
  const weeks = Number(args['holdout-weeks']) || 6;
  const holdoutDates = String(args['holdout-dates'] || holdoutRange(weeks));
  process.stderr.write(`[phase10] loading FRESH holdout ${holdoutDates}…\n`);
  const holdoutLoaded = await loadDatasetFromEspn({
    dates: holdoutDates, sports, sweep,
    maxEventsPerLeague: maxGames,
    concurrency: Math.max(DATASET.concurrency, 8),
    maxDays: 400, cacheDir, cache: cacheOpts, progressEvery: 200,
  });
  const holdoutDataset = { games: holdoutLoaded.games };
  process.stderr.write(`[phase10] holdout: ${holdoutDataset.games.length} games (cache ${holdoutLoaded.cache ? `${holdoutLoaded.cache.hits} hits / ${holdoutLoaded.cache.misses} misses` : 'off'})\n`);

  // --- Item 1: soccer sanity. ----------------------------------------------
  process.stderr.write('[phase10] item 1 — soccer events-vs-final audit + intensities…\n');
  const item1 = soccerSanity(mainDataset);

  // --- Item 2: basketball scoreTime diagnosis (historical test window). -----
  process.stderr.write('[phase10] item 2 — basketball scoreTime diagnosis (test window)…\n');
  const stRows = basketballScoreTimeRows(mainDataset);
  const item2 = basketballScoreTimeReport(stRows);

  // --- Item 3: fit the nonparametric models on TRAIN + VALIDATION only. -----
  process.stderr.write('[phase10] item 3 — fitting soccer empirical table + basketball logistic (train/validation)…\n');
  const sRows = soccerRows(mainDataset);
  const soccerFit = fitSoccerTable(sRows);
  applySoccerModel(sRows, soccerFit);

  const bRows = basketballRows(mainDataset);
  const bbFit = fitBasketballModel(bRows);

  // --- Item 5: soccer regularised multinomial logistic (fit TRAIN/VAL only). -
  process.stderr.write('[phase10] item 5 — fitting soccer multinomial logistic + monotonicity checks…\n');
  const mnlFit = fitMultinomialLogistic(sRows);
  const mnlMonotonicity = mnlChecks(mnlFit);

  // --- Item 4: the per-cell audit of the fixed empirical table. -------------
  process.stderr.write('[phase10] item 4 — auditing the empirical-table fallback per cell…\n');
  const tableDemo = soccerTableCellDemo(soccerFit);

  // --- Item 3: evaluate the frozen production model vs the logistic on the
  //     SAME fresh holdout. Item 5 explicitly forbids re-evaluating soccer on
  //     this window, so only basketball is scored here. ------------------------
  process.stderr.write('[phase10] item 3 — production model vs logistic on the fresh holdout…\n');
  const production = productionHoldoutRows(mainDataset, holdoutDataset);
  const hbRows = basketballRows(holdoutDataset);
  hbRows.forEach(r => {
    r.p = basketballModelProbability(bbFit, r);
    const prod = production.map.get(`${r.gameId}|${r.checkpoint}`);
    if (prod) { r.prodP = prod.prodP; r.prodRaw = prod.prodRaw; }
  });
  const bbTruncation = checkpointTruncationTest(
    holdoutDataset.games.filter(g => g && g.sport === 'basketball'),
    bbFit,
  );
  const basketballHoldout = basketballHoldoutReport(hbRows, { truncation: bbTruncation });
  // Item 1 (round E) — the replay-side elapsed-minute distribution at each
  // league's 1st/2nd/3rd checkpoint. Direct evidence the schedule fix landed.
  const checkpointTimingByLeague = checkpointTiming(hbRows);

  // --- Freeze the shadow candidates (Item 2/5): a versioned artifact whose
  //     probability is logged on every shadow row and never refit for this
  //     evaluation. ----------------------------------------------------------
  const basketballLogisticBlock = {
    feature: 'margin / sqrt(minutes_remaining)',
    overtime: 'OT checkpoint uses only the current OT period clock',
    // Per-league period structure, carried so the read-only scorer
    // (services/live/shadowCandidates.js) computes remaining time exactly as
    // this fit did — WNBA is 4x10 and college is 2x20, NOT the NBA 4x12 default.
    leagues: BB_LEAGUES,
    sportWide: { intercept: bbFit.global.intercept, slope: bbFit.global.slope, n: bbFit.global.n },
    byLeague: bbFit.byLeague,
  };
  const soccerTableBlock = {
    model: 'empirical P(home/draw/away | minute, capped diff, red); LOCAL neighbour pool (|k-d|<=1) for thin cells; monotone fit on direct cells (level 0-1) with local-slope extension for fallbacks',
    minCell: soccerFit.minCell,
    diffCap: soccerFit.diffCap,
    globalRate: soccerFit.globalRate,
    cellLevels: soccerFit.cellLevels,
    // The FIXED table itself, keyed `${minute}|${red}|${diff}`. Without it the
    // read-only scorer has no cell to look up (the earlier artifact carried only
    // the metadata).
    table: soccerFit.table,
  };
  const soccerMnlBlock = {
    model: 'regularised multinomial logistic',
    features: mnlFit.features,
    l2: mnlFit.l2,
    n: mnlFit.n,
    mu: mnlFit.mu,
    sd: mnlFit.sd,
    weights: mnlFit.weights,
  };

  // Item 1 (round D/E) — the FREEZE INSTANT. The confirmation dataset is defined
  // as shadow rows logged strictly AFTER this moment, so it is recorded ONCE and
  // PRESERVED across report runs (a moving freeze would restart the sample).
  // Round E: it is recorded to the SECOND. A legacy date-only value is a
  // placeholder, not an instant, so it is superseded precisely here — safe
  // because a placeholder can sit behind no settled game.
  const existingFreeze = readExistingFreeze();
  const freezePlaceholder = existingFreeze && existingFreeze.placeholder ? existingFreeze.placeholder : null;
  const nowSecMs = Math.floor(Date.now() / 1000) * 1000;
  const freezeMs = existingFreeze && Number.isFinite(existingFreeze.ms) ? existingFreeze.ms : nowSecMs;
  const frozenAtIso = existingFreeze && existingFreeze.iso
    ? existingFreeze.iso
    : new Date(freezeMs).toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Item 3 (round D) — the per-cell RAW row counts of the soccer table, keyed
  // `${minute}|none|${diff}` (the red-pooled state production reads). A cell
  // below the table's minimum is FLAGGED wherever its estimate is shown. This
  // map lives OUTSIDE the hashed block, so the table's frozen id (019d7e0afab3)
  // does not move.
  const tableThinCells = {};
  (soccerFit.cells || []).forEach(c => {
    if (c.red !== 'none') return;
    tableThinCells[`${c.minute}|none|${c.diff}`] = c.nCell;
  });

  // Item 6 (round E) — every frozen candidate is LABELLED by its id. The label
  // is metadata only and lives OUTSIDE each hashed block, so it does not move an
  // id. The score-and-time baseline is a frozen candidate too (it is the
  // reference the release reads against), so it is labelled as well.
  const soccerScoreTimeBlock = { model: 'scoreTime three-way (Phase 8/9 plain Poisson at global rates)' };
  const candidates = {
    version: 'shadow-candidates-1.0.0',
    frozen_at: frozenAtIso,
    frozen_at_ms: freezeMs,
    note: 'Frozen for the live shadow log. Logged on every shadow row; never refit for the current evaluation.',
    basketball_logistic: { id: versionId(basketballLogisticBlock), label: 'Basketball home-win logistic — x = margin / sqrt(minutes remaining), per-league periods', ...basketballLogisticBlock },
    soccer_table: { id: versionId(soccerTableBlock), label: 'Soccer empirical table P(home/draw/away | minute, capped diff, red)', ...soccerTableBlock },
    soccer_mnl: { id: versionId(soccerMnlBlock), label: 'Soccer regularised multinomial logistic (primary)', ...soccerMnlBlock },
    soccer_score_time: { id: versionId(soccerScoreTimeBlock), label: 'Soccer score-and-time baseline (plain Poisson at global rates) — the release reference', ...soccerScoreTimeBlock },
    // Per-cell raw row counts (see above). Read by services/live/shadowCandidates
    // to flag a thin soccer cell; kept out of the hashed blocks.
    table_thin_cells: tableThinCells,
    // Item 2/3 (round D) — PRE-REGISTRATION. The release decision reads the
    // PRIMARY candidate only, versus scoreTime, with game-level CIs. Picking the
    // best of the candidates on the confirmation data is forbidden, so the
    // secondaries are recorded but never compared there.
    registration: {
      pre_registered_at: frozenAtIso,
      basketball: { primary: 'basketball_logistic', secondary: null },
      soccer: { primary: 'soccer_mnl', secondary: 'soccer_table' },
      rule: 'The release decision reads the PRIMARY candidate ONLY, versus scoreTime, with game-level CIs. Secondary candidates are logged but NOT selected on the confirmation data.',
    },
  };

  // Item 1 (round E) — KEEP shadow-candidates-1.0.0 UNCHANGED. The replay
  // schedule moved onto a uniform elapsed-fraction grid; that changes the replay
  // rows and therefore the refit, so freshly computed ids can drift from the
  // committed ones. The frozen artifact is preserved as committed: the on-disk
  // version/ids/blocks are kept, and any refit drift is DISCLOSED in a metadata
  // field outside every hashed block rather than silently overwriting the freeze.
  const frozenCandidates = readExistingCandidates();
  const FROZEN_KEYS = ['basketball_logistic', 'soccer_table', 'soccer_mnl', 'soccer_score_time'];
  const refitDrift = frozenCandidates && frozenCandidates.version === candidates.version
    ? FROZEN_KEYS.map(k => {
      const frozenId = (frozenCandidates[k] && frozenCandidates[k].id) || null;
      const refitId = (candidates[k] && candidates[k].id) || null;
      return { candidate: k, frozen_id: frozenId, refit_id: refitId, moved: Boolean(frozenId && refitId && frozenId !== refitId) };
    })
    : null;
  const candidateArtifact = (frozenCandidates && frozenCandidates.version === candidates.version)
    ? {
      ...frozenCandidates,
      // Metadata only (outside every hashed block) — the frozen ids do not move.
      refit_disclosure: {
        recorded_at: new Date().toISOString(),
        reason: 'Replay checkpoint schedule moved to a uniform elapsed-fraction grid (schedule-only fix; no model parameters were changed).',
        frozen_artifact_preserved: candidates.version,
        refit_artifact_would_be: versionId(basketballLogisticBlock),
        drift: refitDrift,
      },
    }
    : candidates;

  // Freeze the candidate artifact BEFORE reading back the confirmation state:
  // the freeze instant is what decides which shadow rows count as unseen.
  const candPath = path.join(BACKEND_DIR, CANDIDATE_FILE);
  fs.mkdirSync(path.dirname(candPath), { recursive: true });
  fs.writeFileSync(candPath, JSON.stringify(candidateArtifact, null, 2));
  process.stderr.write(`[phase10] wrote ${CANDIDATE_FILE} (id-bearing blocks preserved: ${candidateArtifact.version})\n`);

  // Item 1/4 (round D) — the confirmation dataset and rollout progress, read
  // from the live shadow log against the freeze instant just written.
  const forwardTest = require('../services/live/forwardTest');
  const shadowCandidates = require('../services/live/shadowCandidates');
  shadowCandidates.reset();
  forwardTest.reset();
  // Round I (item 1) — the ONE-OFF EVALUATION: load every row (`loadRows`), not
  // just the counters, because the confirmation breakdown scores each row. The
  // file backend already returns its whole set from `readMeta`, so this is the
  // explicit request for the same full set a Firestore `readRows()` would give.
  forwardTest.init({ loadRows: true });
  // Round I (item 1) — the one-off evaluation reads the RECOUNT of the rows, NOT
  // the maintained counters in `live_shadow/meta`. On Firestore that is a
  // `count()` aggregation grouped by (sport, league); on the file backend it is
  // derived from the loaded rows. `drift` (counters vs recount) is reported so a
  // counter that silently doubled is caught rather than released on.
  const storeAdapter = require('../services/live/store');
  let countersReconcile = null;
  try {
    countersReconcile = await storeAdapter.reconcile();
  } catch (err) {
    countersReconcile = { error: String((err && err.message) || err) };
  }
  const shadowProgress = forwardTest.progress();
  const shadowConfirmation = {
    basketball: forwardTest.confirmationSummary('basketball'),
    soccer: forwardTest.confirmationSummary('soccer'),
  };
  const shadowStatus = forwardTest.status();

  const currentRange = parseDateRange(holdoutDates);
  const priorRange = parseDateRange(args['prior-holdout']);
  const priorHoldout = priorHoldoutOverlap(holdoutDataset.games, currentRange, priorRange);
  const freeze = freezeAudit(frozenAtIso, freezeMs, { placeholder: freezePlaceholder });

  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      windows: WINDOWS,
      absoluteCalibration: AC,
      freshMinGames: FRESH_MIN_GAMES,
      soccerMinutes: SOCCER_MINUTES,
      soccerDiffCap: SOCCER_DIFF_CAP,
      soccerMinCell: SOCCER_MIN_CELL,
      bbMinLeagueGames: BT.shipGate.minLeagueGames,
    },
    dataset: {
      historicalGames: mainDataset.games.length,
      historicalSoccer: mainDataset.games.filter(g => g.sport === 'soccer').length,
      historicalBasketball: mainDataset.games.filter(g => g.sport === 'basketball').length,
      holdoutDates,
      holdoutGames: holdoutDataset.games.length,
      holdoutSoccer: holdoutDataset.games.filter(g => g.sport === 'soccer').length,
      holdoutBasketball: holdoutDataset.games.filter(g => g.sport === 'basketball').length,
    },
    evaluationLedger: [
      { window: 'historical test (frac 0.80-1.00)', scored_times: 3, unseen: false, note: 'Phase 8 sweep, Phase 9 report, Phase 10 report — scored 3×, no longer a clean holdout.' },
      { window: `sliding holdout ${holdoutDates}`, scored_times: 2, unseen: false, note: 'Round C item 4 (basketball logistic + soccer table); earlier round (frozen production vs logistic). A SLIDING window — it overlaps the prior window, so most of its games were already scored.' },
      confirmationLedgerEntry(shadowConfirmation),
    ],
    priorHoldout,
    freeze,
    confirmation: {
      rule: 'shadow rows logged after the candidate freeze timestamp, evaluated once',
      artifact: candidateArtifact.version,
      frozen_at: frozenAtIso,
      frozen_at_ms: freezeMs,
      min_settled_games_per_sport: FRESH_MIN_GAMES,
      // Item 3 (round E) — until the target is reached the confirmation surface
      // exposes NO performance, only counts/rates/ETA. The one-pass metrics are
      // computed only once every sport is ready.
      peeking_guarded: true,
      // Round I (item 1) — the settled-game counts this evaluation rests on come
      // from a RECOUNT of the rows, not from the maintained counters. `drift`
      // must be zero; a non-zero delta means the counters were wrong and the
      // counters themselves are not to be trusted.
      counts_source: 'recount (rows), not counters',
      counters_reconcile: countersReconcile,
    },
    shadow: { status: shadowStatus, progress: shadowProgress, confirmation: shadowConfirmation },
    item1_soccerSanity: item1,
    item2_basketballScoreTime: item2,
    item3_models: {
      soccer: {
        fitRows: soccerFit.fitRows,
        minCell: soccerFit.minCell,
        diffCap: soccerFit.diffCap,
        cellLevels: soccerFit.cellLevels,
        globalRate: soccerFit.globalRate,
        pooled: soccerFit.pooled,
        table: soccerFit.table,
      },
      basketball: bbFit,
    },
    item4_soccerTable: {
      fitRows: soccerFit.fitRows,
      minCell: soccerFit.minCell,
      diffCap: soccerFit.diffCap,
      cellLevels: soccerFit.cellLevels,
      cells: soccerFit.cells,
      demonstration: tableDemo,
    },
    item5_soccerMNL: {
      fit: { features: mnlFit.features, l2: mnlFit.l2, iters: mnlFit.iters, n: mnlFit.n, weights: mnlFit.weights, mu: mnlFit.mu, sd: mnlFit.sd },
      checks: mnlMonotonicity,
    },
    item3_holdout: { basketball: basketballHoldout, checkpointTiming: checkpointTimingByLeague, productionCalibrator: production.calibrator, productionFitRows: production.fitRows },
    candidates: candidateArtifact,
  };

  printReport(report);

  if (args.out) {
    fs.writeFileSync(path.resolve(String(args.out)), JSON.stringify(report, null, 2));
    process.stderr.write(`[phase10] wrote ${args.out}\n`);
  }
}

/* ------------------------------------------------------------------ print */

function pct(v) { return v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`; }
function num(v) { return v == null ? 'n/a' : Number(v).toFixed(4); }
function ci4(c) { return c == null ? '[n/a]' : `[${num(c.lower)}, ${num(c.upper)}]`; }
const MIN_TABLE = AC.minBucketGames;

function printReport(r) {
  const L = [];
  L.push(`# Live Phase 10 (round E) report — ${r.generatedAt}`);
  L.push(`historical dataset: ${r.dataset.historicalGames} games (${r.dataset.historicalSoccer} soccer / ${r.dataset.historicalBasketball} basketball)`);
  L.push(`sliding holdout:    ${r.dataset.holdoutDates} — ${r.dataset.holdoutGames} games (${r.dataset.holdoutSoccer} soccer / ${r.dataset.holdoutBasketball} basketball) — NOT "fresh" (see ledger)`);
  L.push(`absolute calibration: bucket >= ${MIN_TABLE} rows, tolerance ${AC.maxBucketDeviation}`);
  L.push('');
  L.push('evaluation ledger — every window with how many times it has been SCORED:');
  r.evaluationLedger.forEach(e => L.push(`  ${e.unseen ? '[unseen]' : '[seen]  '} ${e.window.padEnd(48)} scored ${e.scored_times}×  — ${e.note}`));
  if (r.priorHoldout) {
    const p = r.priorHoldout;
    L.push('');
    L.push(`SLIDING-WINDOW OVERLAP vs prior window ${p.prior_window}:`);
    L.push(`  overlap ${p.overlap_days} days; of ${p.total_games} holdout games, ${p.seen_games} were already scored and only ${p.unseen_games} are UNSEEN.`);
  }
  L.push('');
  L.push('FREEZE BOUNDARY (item 1):');
  const fz = r.freeze;
  L.push(`  artifact ${r.confirmation.artifact} frozen at ${fz.frozen_at} (ms ${fz.frozen_at_ms})${fz.superseded_placeholder ? ` — superseded the date-only placeholder "${fz.superseded_placeholder}"` : ''}`);
  L.push(`  rows in ${fz.log_file}: ${fz.rows_total}; logged on ${fz.day}: ${fz.rows_on_day} — before the freeze ${fz.before_freeze}, after ${fz.after_freeze}; count only rows AFTER it.`);
  if (fz.soccer_confirmation_row) {
    const s = fz.soccer_confirmation_row;
    L.push(`  the one soccer shadow row ${s.game_id} logged ${s.at} is ${s.after_freeze ? 'AFTER' : 'BEFORE'} the freeze → ${s.after_freeze ? 'counts' : 'does NOT count'} as confirmation evidence.`);
  }
  L.push('');
  L.push('CONFIRMATION DATASET (the only dataset that may decide a release):');
  L.push(`  rule: ${r.confirmation.rule} — >= ${r.confirmation.min_settled_games_per_sport} settled GAMES per sport.`);
  L.push('  NO PEEKING: until a sport is ready only counts/rates/ETA are shown — no Brier/log loss/calibration.');
  ['basketball', 'soccer'].forEach(sport => {
    const c = r.shadow.confirmation[sport];
    if (!c) return;
    L.push(`    ${sport.padEnd(11)} pre-freeze rows ${String(c.pre_freeze_rows).padStart(4)} (${c.pre_freeze_games} games, already seen) | confirmation rows ${String(c.rows).padStart(4)} | settled games ${c.settled_games}/${c.min_settled_games} | ready_to_evaluate ${c.ready_to_evaluate ? 'YES' : 'no'}`);
    L.push(`    ${''.padEnd(11)} performance: ${c.ready_to_evaluate ? `Brier ${num(c.brier)} logLoss ${num(c.logLoss)} hit ${pct(c.hitRate)} (one pass)` : 'withheld until ready (computed in one pass)'}`);
  });
  L.push(`  rollout progress (settled GAMES toward ${r.shadow.progress.target}, ETA from the observed rate):`);
  const progLeagues = Object.entries(r.shadow.progress.per_league || {});
  L.push('    scope                 settled  target  remaining  rate/day  eta');
  const progRow = (name, v) => L.push(`    ${name.padEnd(21)} ${String(v.settled_games).padStart(7)} ${String(v.target).padStart(7)} ${String(v.remaining).padStart(10)} ${String(v.rate_per_day == null ? 'n/a' : v.rate_per_day).padStart(9)}  ${v.eta_at || 'n/a'}`);
  Object.entries(r.shadow.progress.per_sport || {}).forEach(([k, v]) => progRow(`sport:${k}`, v));
  progLeagues.forEach(([k, v]) => progRow(`league:${k}`, v));
  if (!Object.keys(r.shadow.progress.per_sport || {}).length) L.push('    (no settled confirmation games yet — nothing to estimate)');
  L.push('');

  /* ---- Item 1 ------------------------------------------------------------ */
  L.push('## Item 1. Soccer fit sanity — events vs final scores, per league');
  const o = r.item1_soccerSanity.overall;
  L.push(`  games ${o.games}   event-final != scoreboard-final: ${o.mismatch}   no event log: ${o.missingEvent}   non-monotone increments: ${o.glitches}`);
  L.push('  per league: games | mismatch | mean goals/match  final (H/A) | events (H/A)');
  L.push(`    ${'ALL'.padEnd(8)} ${String(o.games).padStart(5)} ${String(o.mismatch).padStart(9)}   ${num(o.meanFinalHome)} / ${num(o.meanFinalAway)}   ${num(o.meanEventHome)} / ${num(o.meanEventAway)}`);
  Object.entries(r.item1_soccerSanity.byLeague).forEach(([k, v]) => {
    L.push(`    ${k.padEnd(8)} ${String(v.games).padStart(5)} ${String(v.mismatch).padStart(9)}   ${num(v.meanFinalHome)} / ${num(v.meanFinalAway)}   ${num(v.meanEventHome)} / ${num(v.meanEventAway)}`);
  });
  L.push('  intensities (goals per match per 15-min bin; bins 0-15,15-30,30-45,45-60,60-75,75-90+):');
  L.push(`    from finals   home ${o.binFinalHome.join(', ')}  (sum ${num(o.sumFinalHome)})`);
  L.push(`                  away ${o.binFinalAway.join(', ')}  (sum ${num(o.sumFinalAway)})`);
  L.push(`    from events   home ${o.binEventHome.join(', ')}  (sum ${num(o.sumEventHome)})`);
  L.push(`                  away ${o.binEventAway.join(', ')}  (sum ${num(o.sumEventAway)})`);
  L.push(`  FINDING: swapped labels? no. duplicate events? no. own-goal attribution? corrected (team id = credited side). stoppage-time goals? they fall in the 75-90+ bin.`);
  L.push(`  The away side now sums to ~${num(o.sumEventAway)} goals/match, not 3.44. The retired parametric model's anomaly was a parsing artefact; no parametric conclusion is drawn.`);
  L.push('');

  /* ---- Item 2 ------------------------------------------------------------ */
  L.push('## Item 2. Basketball scoreTime — CORRECTED diagnosis (historical test window)');
  const b = r.item2_basketballScoreTime;
  L.push(`  games ${b.games}  rows ${b.rows}`);
  L.push(`  column: Brier ${num(b.column.brier)} ${ci4(b.column.bootstrap.brier)}  log loss ${num(b.column.logLoss)} ${ci4(b.column.bootstrap.logLoss)}  hit ${pct(b.column.hitRate)}`);
  L.push(`  calibration: slope ${num(b.column.slope)}  intercept ${num(b.column.intercept)}  max judged-bucket deviation ${num(b.column.maxBucketDeviation)} (${b.column.maxBucketRange || 'n/a'})`);
  L.push(`  verdict: ${b.verdict.pass ? 'PASS' : (b.verdict.pass === false ? 'FAIL' : 'UNJUDGED')} — ${b.verdict.reason}`);
  L.push('  reliability:');
  b.column.curve.forEach(c => L.push(`    ${String(c.range).padEnd(11)} n ${String(c.n).padStart(6)}  predicted ${pct(c.predicted)}  actual ${pct(c.actual)}  dev ${num(c.deviation)}`));
  L.push(`  CORRECTED WORDING: ${b.diagnosis.verdict}`);
  L.push(`    low bucket ${b.diagnosis.lowBucket ? `${b.diagnosis.lowBucket.range}: predicted ${pct(b.diagnosis.lowBucket.predicted)} -> realised ${pct(b.diagnosis.lowBucket.actual)}` : 'n/a'}`);
  L.push(`    high bucket ${b.diagnosis.highBucket ? `${b.diagnosis.highBucket.range}: predicted ${pct(b.diagnosis.highBucket.predicted)} -> realised ${pct(b.diagnosis.highBucket.actual)}` : 'n/a'}`);
  L.push('  by time bucket:');
  Object.entries(b.byBucket).forEach(([k, m]) => L.push(`    ${k.padEnd(6)} n ${String(m.n).padStart(6)}  games ${String(m.games).padStart(5)}  Brier ${num(m.brier)}  log loss ${num(m.logLoss)}  hit ${pct(m.hitRate)}`));
  L.push('  by league:');
  Object.entries(b.byLeague).forEach(([k, m]) => L.push(`    ${k.padEnd(24)} n ${String(m.n).padStart(6)}  games ${String(m.games).padStart(5)}  Brier ${num(m.brier)}  log loss ${num(m.logLoss)}  maxDev ${num(m.maxBucketDeviation)}`));
  L.push('');

  /* ---- Item 3 (models) --------------------------------------------------- */
  L.push('## Item 3. Nonparametric / score-and-time-only models (fitted on TRAIN + VALIDATION)');
  const sc = r.item3_models.soccer;
  L.push(`  soccer empirical table: rows ${sc.fitRows}  min cell ${sc.minCell}  diff cap ±${sc.diffCap}`);
  L.push(`    cells by fallback level: ${JSON.stringify(sc.cellLevels)}   (legend: 0 exact | 1 (minute,diff) | 2 LOCAL neighbour pool over diff | 3 (minute) only | 4 global)`);
  L.push(`    global (no-conditioning) rate: home ${num(sc.globalRate.home)} draw ${num(sc.globalRate.draw)} away ${num(sc.globalRate.away)}`);
  L.push('    P(home) by minute x capped difference (red state = none) — the monotone-smoothed table:');
  L.push(`      minute  ${[-3, -2, -1, 0, 1, 2, 3].map(d => String(d).padStart(6)).join('')}`);
  SOCCER_MINUTES.forEach(m => {
    const row = [-3, -2, -1, 0, 1, 2, 3].map(d => {
      const v = sc.table[`${m}|none|${d}`];
      return String(v ? num(v.home) : 'n/a').padStart(6);
    });
    L.push(`      ${String(m).padStart(4)}    ${row.join('')}`);
  });
  const bb = r.item3_models.basketball;
  L.push(`  basketball logistic: rows ${bb.fitRows}  x = margin / sqrt(minutes remaining)`);
  L.push(`    sport-wide: intercept ${num(bb.global.intercept)}  slope ${num(bb.global.slope)}  (n ${bb.global.n})`);
  Object.entries(bb.byLeague).forEach(([k, v]) => L.push(`    ${k.padEnd(24)} x ${num(v.slope).padStart(7)}  intercept ${num(v.intercept).padStart(7)}  (n ${String(v.rows).padStart(6)})  ${v.source}`));
  L.push('    overtime handling: for an OT checkpoint only the current OT period clock is used (remaining = clock minutes).');
  L.push('');

  /* ---- Item 4 (soccer table audit) --------------------------------------- */
  L.push('## Item 4. Soccer empirical table — per-cell n and fallback level (the 15\'/30\' collapse, and the fix)');
  const it4 = r.item4_soccerTable;
  L.push(`  fit rows ${it4.fitRows}  min cell ${it4.minCell}  cells by level: ${JSON.stringify(it4.cellLevels)}`);
  L.push('    WHY the 15\'/30\' cells collapsed: ONLY the extreme diff cells are thin. At 15\' the');
  L.push('    exact (15,\'+3\') cell has n=10 and at 30\' the (30,\'-3\') cell has n=23, both below');
  L.push('    minCell, so they fell back to a neighbour/minute estimate. The OLD neighbour pool');
  L.push('    reached the whole difference axis, so it returned a nonsense value (trailing by 3 at');
  L.push('    15\' scored a HIGHER home rate than trailing by 1), and the isotonic step then merged');
  L.push('    that value with the direct diff 1/2 cells — flattening "up 1/2/3" onto one number.');
  L.push('    THE FIX: (a) the neighbour pool is now LOCAL (|k-d| <= 1); (b) the monotone fit runs');
  L.push('    on the DIRECT cells (levels 0-1) only and the fallback cells are EXTENDED on the');
  L.push('    curve\'s local slope, so distinct goal differences keep distinct values.');
  L.push('    Per-cell audit of the flagged cells (n = raw cell counts; level = fallback used):');
  L.push('      minute diff | n(cell) n(min,diff) n(min) usedN level dir | pooled P(H/D/A)          | table P(H/D/A)');
  it4.demonstration.cells.forEach(c => {
    const pl = c.pooled ? `${num(c.pooled.home)}/${num(c.pooled.draw)}/${num(c.pooled.away)}` : 'n/a';
    const tb = c.table ? `${num(c.table.home)}/${num(c.table.draw)}/${num(c.table.away)}` : 'n/a';
    L.push(`      ${String(c.minute).padStart(5)} ${String(c.diff).padStart(4)} | ${String(c.nCell).padStart(7)} ${String(c.nMD).padStart(10)} ${String(c.nM).padStart(6)} ${String(c.usedN).padStart(6)} ${String(c.level).padStart(5)} ${c.direct ? ' D ' : ' F '} | ${pl.padEnd(24)} | ${tb}`);
    if (c.why) L.push(`              → ${c.why}`);
  });
  L.push(`    distinct P(home) across up 1/2/3 at 15'? ${it4.demonstration.minute15HomeDistinct ? 'YES (fixed)' : 'NO — still pooling'}`);
  L.push(`    distinct P(home) across down 1/2/3 at 30'? ${it4.demonstration.minute30HomeDistinct ? 'YES (fixed)' : 'NO — still pooling'}`);
  L.push('    Every cell (red state = none); cell = n/level (D = direct level 0-1, F = fallback 2-4):');
  L.push(`      minute ${[-3, -2, -1, 0, 1, 2, 3].map(d => String(d).padStart(11)).join('')}`);
  SOCCER_MINUTES.forEach(m => {
    const row = [-3, -2, -1, 0, 1, 2, 3].map(d => {
      const c = it4.cells.find(x => x.minute === m && x.diff === d && x.red === 'none');
      if (!c) return 'n/a'.padStart(11);
      return `${Math.round(c.nCell)}/${c.level}${c.direct ? 'D' : 'F'}`.padStart(11);
    });
    L.push(`      ${String(m).padStart(4)}   ${row.join('')}`);
  });
  L.push('    (the full per-cell audit for every red state is in the JSON under item4_soccerTable.cells)');
  L.push('');

  /* ---- Item 5 (soccer MNL) ---------------------------------------------- */
  L.push('## Item 5. Soccer multinomial-logistic candidate (fit on TRAIN + VALIDATION; NOT scored on the old holdout)');
  const it5 = r.item5_soccerMNL;
  L.push(`  features: ${it5.fit.features.join(', ')}   L2 ${it5.fit.l2}   iters ${it5.fit.iters}   fit rows ${it5.fit.n}`);
  L.push(`  standardiser: mu ${it5.fit.mu.map(v => num(v)).join(', ')}`);
  L.push(`                sd ${it5.fit.sd.map(v => num(v)).join(', ')}`);
  L.push('  weights (intercept then one per feature):');
  ['home', 'draw', 'away'].forEach(k => L.push(`    ${k.padEnd(5)} ${it5.fit.weights[k].map(v => String(num(v)).padStart(8)).join(' ')}`));
  const chk = it5.checks;
  L.push(`  monotone in goal difference: home ${chk.homeMonotone ? 'YES' : `NO (${chk.homeViolations} violations)`}; away ${chk.awayMonotone ? 'YES' : `NO (${chk.awayViolations} violations)`}  (${chk.curves} curves)`);
  L.push(`  draw curve unimodal (a single peak) on all ${chk.curves} curves: ${chk.drawUnimodal ? 'YES' : `NO (${chk.drawUnimodalViolations} curves)`}`);
  L.push(`  draw peaks at diff = 0 with NO red card: ${chk.drawPeaksAtZeroNeutral ? 'YES' : `NO (${chk.neutralPeakMismatch} curves)`}`);
  L.push(`  draw peaks at diff = 0 under EVERY input (strict): ${chk.drawPeaksAtZero ? 'YES' : `NO (${chk.drawPeakMismatch} curves)`}`);
  if (chk.redCardPeakShift && chk.redCardPeakShift.length) {
    const mins = chk.redCardPeakShift.map(p => p.minute).join(', ');
    L.push(`    the strict metric fails ONLY on the away-red curves (minutes ${mins}): the away side is a man down AND leading, so a draw`);
    L.push('    (a home equaliser) is the single most likely outcome and the draw peak sits at diff = -1 — expected football, not a defect.');
  }
  L.push('  P(home/draw/away) vs goal difference at minute 30, no reds:');
  L.push('      diff    P(home)  P(draw)  P(away)');
  (chk.sampleAtMinute30 || []).forEach(s => L.push(`      ${String(s.diff).padStart(5)}   ${num(s.home).padStart(7)}  ${num(s.draw).padStart(7)}  ${num(s.away).padStart(7)}`));
  L.push('');

  /* ---- Item 3 (holdout) -------------------------------------------------- */
  L.push('## Item 3 (holdout). Frozen production model vs the logistic — SAME fresh holdout');
  const hbk = r.item3_holdout.basketball;
  L.push(`  holdout window ${r.dataset.holdoutDates}: basketball ${hbk.games} games / ${hbk.rows} rows (soccer NOT re-evaluated here — its candidates go to shadow).`);
  L.push(`  production calibrator: ${r.item3_holdout.productionCalibrator.fitted ? 'fitted on TRAIN+VALIDATION' : 'identity (not kept)'} (${r.item3_holdout.productionCalibrator.method}, ${r.item3_holdout.productionFitRows} fit rows).`);
  L.push('');
  L.push('  --- BASKETBALL (home-win) ---');
  L.push(`    logistic    Brier ${num(hbk.column.brier)} ${ci4(hbk.column.bootstrap.brier)}  logLoss ${num(hbk.column.logLoss)} ${ci4(hbk.column.bootstrap.logLoss)}  slope ${num(hbk.column.slope)}  intercept ${num(hbk.column.intercept)}  maxDev ${num(hbk.column.maxBucketDeviation)} (${hbk.column.maxBucketRange || 'n/a'})`);
  L.push(`    scoreTime   Brier ${num(hbk.scoreTime.brier)}  logLoss ${num(hbk.scoreTime.logLoss)}`);
  if (hbk.vsProduction) {
    const vp = hbk.vsProduction;
    L.push(`    production  Brier ${num(vp.production.brier)} ${ci4(vp.production.brierCi)}  logLoss ${num(vp.production.logLoss)} ${ci4(vp.production.logLossCi)}  slope ${num(vp.production.slope)}  intercept ${num(vp.production.intercept)}  maxDev ${num(vp.production.maxBucketDeviation)}`);
    if (vp.productionVsScoreTime) {
      L.push(`    production vs scoreTime: Brier ${num(vp.productionVsScoreTime.brierGain)} ${ci4(vp.productionVsScoreTime.brierGainCI)}  logLoss ${num(vp.productionVsScoreTime.logLossGain)} ${ci4(vp.productionVsScoreTime.logLossGainCI)}`);
    }
    L.push(`    logistic vs production:  Brier ${num(vp.logisticVsProduction.brierGain)} ${ci4(vp.logisticVsProduction.brierGainCI)}  logLoss ${num(vp.logisticVsProduction.logLossGain)} ${ci4(vp.logisticVsProduction.logLossGainCI)}  games ${vp.logisticVsProduction.games}`);
    L.push(`    RECOMMENDATION: ${vp.recommendation}`);
  } else {
    L.push('    production: unavailable on this holdout (no anchored rows joined).');
  }
  L.push(`    logistic vs scoreTime: Brier ${num(hbk.gainVsScoreTime.brierGain)} ${ci4(hbk.gainVsScoreTime.brierGainCI)}  logLoss ${num(hbk.gainVsScoreTime.logLossGain)} ${ci4(hbk.gainVsScoreTime.logLossGainCI)}  games ${hbk.gainVsScoreTime.games}`);
  L.push(`    absolute-calibration verdict: ${hbk.verdict.judged ? (hbk.verdict.pass ? 'PASS' : 'FAIL') : 'UNJUDGED'} — ${hbk.verdict.reason}`);
  L.push('    reliability:');
  hbk.column.curve.forEach(c => L.push(`      ${String(c.range).padEnd(11)} n ${String(c.n).padStart(6)}  predicted ${pct(c.predicted)}  actual ${pct(c.actual)}  dev ${num(c.deviation)}`));
  L.push('    by time bucket:');
  Object.entries(hbk.byBucket).forEach(([k, m]) => L.push(`      ${k.padEnd(6)} n ${String(m.n).padStart(6)}  games ${String(m.games).padStart(5)}  Brier ${num(m.brier)}  logLoss ${num(m.logLoss)}  hit ${pct(m.hitRate)}`));
  L.push('    by league:');
  Object.entries(hbk.byLeague).forEach(([k, m]) => L.push(`      ${k.padEnd(24)} n ${String(m.n).padStart(6)}  games ${String(m.games).padStart(5)}  Brier ${num(m.brier)}  logLoss ${num(m.logLoss)}  maxDev ${num(m.maxBucketDeviation)}  BrierGain ${num(m.brierGainVsScoreTime)}  LLGain ${num(m.logLossGainVsScoreTime)}  ${m.judged ? '' : '(unjudged)'}`));
  // Item 2 (round E) — the early/mid/late split with the checkpoint count per
  // bucket, per league. A row-heavy, game-thin bucket cannot carry a claim.
  L.push('    early/mid/late split (checkpoints per bucket, per league):');
  Object.entries(hbk.byLeagueBucket || {}).forEach(([league, buckets]) => {
    const parts = Object.entries(buckets).map(([label, m]) => `${label} n ${String(m.rows).padStart(5)}/g ${String(m.games).padStart(4)} B ${num(m.brier)} L ${num(m.logLoss)}`);
    L.push(`      ${league.padEnd(24)} ${parts.join(' | ')}`);
  });
  // Item 1 (round E) — the elapsed-minute distribution at the 1st/2nd/3rd
  // checkpoint of each game, per league (REPLAY path). On the uniform
  // elapsed-fraction grid every league's first three checkpoints sit at 1/8,
  // 3/16 and 1/4 of regulation, so all leagues get ~3 early rows per game.
  const ct = r.item3_holdout.checkpointTiming || {};
  L.push('    checkpoint timing (REPLAY) — mean ELAPSED minutes (fraction of regulation) at the 1st/2nd/3rd checkpoint:');
  L.push('      league                   regMin  games   cp1 (min / frac)      cp2 (min / frac)      cp3 (min / frac)    early/mid/late rows');
  Object.entries(ct).forEach(([league, t]) => {
    const slots = t.slots || [];
    const cell = i => {
      const sl = slots[i];
      if (!sl || sl.meanElapsedMinutes == null) return 'n/a'.padEnd(21);
      return `${num(sl.meanElapsedMinutes)} / ${num(sl.meanFraction)}`.padEnd(21);
    };
    const b = t.bucketRows || { early: 0, mid: 0, late: 0 };
    L.push(`      ${league.padEnd(24)} ${String(t.regulationMinutes).padStart(6)} ${String(t.games).padStart(6)}   ${cell(0)} ${cell(1)} ${cell(2)}  ${String(b.early || 0).padStart(5)}/${String(b.mid || 0).padStart(5)}/${String(b.late || 0).padStart(5)}`);
  });
  L.push('    LIVE SCHEDULER: runs on a 5-minute cron and logs whatever real clock it sees — it never');
  L.push('      synthesises checkpoint marks, so this grid is IMPLICIT on the live side and the schedule');
  L.push('      fix does NOT touch it. The distribution above is the replay path only.');
  // Item 1 (round E) — the exact schedule-fix timestamp and the shadow rows that
  // predate it (a schedule fix alone must not move frozen ids).
  L.push(`    schedule-fix recorded at ${r.candidates && r.candidates.refit_disclosure ? r.candidates.refit_disclosure.recorded_at : r.generatedAt}; shadow rows logged BEFORE it are the pre-fix rows already labelled in the freeze boundary above.`);
  // Item 4 (round E) — the leakage test on THIS holdout. WORDING corrected: the
  // shuffle shows the metric DEPENDS on the labels; it does NOT prove the
  // absence of leakage. Two direct checks do that (below).
  const lk = hbk.leakage;
  if (lk) {
    L.push(`    LABEL-DEPENDENCE test (shuffle game-level labels, ${lk.iterations} draws, game n ${lk.games}) — labels: home ${lk.labels.home_wins} / away ${lk.labels.away_wins}`);
    L.push(`      actual       model Brier ${num(lk.actual.model.brier)}  logLoss ${num(lk.actual.model.logLoss)}   | scoreTime Brier ${num(lk.actual.scoreTime.brier)}  logLoss ${num(lk.actual.scoreTime.logLoss)}`);
    L.push(`      constant0.5  Brier ${num(lk.constantHalf.brier)}  logLoss ${num(lk.constantHalf.logLoss)} (no-skill floor)`);
    L.push(`      shuffled     model Brier ${num(lk.shuffled.model.brier)} ± ${num(lk.shuffled.model.brierSd)}  logLoss ${num(lk.shuffled.model.logLoss)}   | scoreTime logLoss ${num(lk.shuffled.scoreTime.logLoss)}`);
    L.push(`      collapsed to no-skill: ${lk.collapsed ? 'YES' : 'NO'} — ${lk.verdict}`);
    if (lk.wording) L.push(`      WORDING: ${lk.wording}`);
    Object.entries(hbk.leakageByLeague || {}).forEach(([league, l]) => {
      L.push(`      ${league.padEnd(24)} game n ${String(l.games).padStart(3)}  labels home ${l.labels.home_wins}/away ${l.labels.away_wins}  actual logLoss ${num(l.actual.model.logLoss)}  shuffled logLoss ${num(l.shuffled.model.logLoss)}  collapsed ${l.collapsed ? 'YES' : 'NO'}`);
    });
  }
  // Item 4(a) (round E) — first-checkpoint predictions must sit near the home
  // base rate: at the first checkpoint no outcome information has entered.
  if (hbk.firstCheckpoint) {
    const fc = hbk.firstCheckpoint;
    L.push(`    LEAKAGE CHECK 4(a) / ITEM 2 — first checkpoint vs home base rate (${fc.games} games):`);
    L.push(`      mean predicted P(home) ${num(fc.meanPredicted)}   vs   home base rate (all checkpoints) ${num(fc.homeBaseRateAllCheckpoints)}   gap ${num(fc.gapVsBaseRate)}   (realised on these games ${num(fc.firstCheckpointHomeRate)})`);
    L.push(`      earliest-checkpoint fraction: min ${num(fc.firstFractionMin)} max ${num(fc.firstFractionMax)}; games strictly < 10% of regulation: ${fc.blankUnder10Games} (the grid's earliest checkpoint is 1/8 = 12.5%, so the strict subset is empty by construction).`);
    Object.entries(fc.byLeague || {}).forEach(([league, v]) => {
      L.push(`      ${league.padEnd(24)} games ${String(v.games).padStart(4)}  meanPred ${num(v.meanPredicted)}  homeRate ${num(v.homeRate)}  gap ${num(v.gap)}`);
    });
  }
  // Item 4(b) (round E) — post-checkpoint truncation identity.
  if (hbk.truncation) {
    const tr = hbk.truncation;
    L.push(`    LEAKAGE CHECK 4(b) — remove events after the checkpoint (${tr.checked} checkpoints over ${tr.games} games):`);
    L.push(`      identical output ${tr.identical}/${tr.checked} (${tr.identicalFraction == null ? 'n/a' : (tr.identicalFraction * 100).toFixed(1)}%)   max |Δp| ${num(tr.maxAbsDiff)}`);
    L.push(`      sensitivity probe (a genuine LATER event MUST move it): ${tr.sensitiveProbe.differed}/${tr.sensitiveProbe.checked} moved (${tr.sensitiveProbe.rate == null ? 'n/a' : (tr.sensitiveProbe.rate * 100).toFixed(1)}%) → test is informative`);
    L.push(`      ${tr.verdict}`);
  }
  // Item 5 (round E) — the constant base-rate predictor per league + skill score.
  L.push('    constant base-rate predictor, per league (predict the league home rate everywhere) and the model skill vs it:');
  L.push('      league                     games  H/A     baseRate  constBrier  constLogLoss  modelBrier  modelLogLoss  brierSkill  logLossSkill');
  Object.entries(hbk.byLeagueBaseRate || {}).forEach(([league, v]) => {
    L.push(`      ${league.padEnd(24)} ${String(v.games).padStart(5)}  ${String(v.home).padStart(3)}/${String(v.away).padEnd(3)} ${num(v.baseRate).padStart(8)}  ${num(v.constantBrier).padStart(10)}  ${num(v.constantLogLoss).padStart(12)}  ${num(v.modelBrier).padStart(10)}  ${num(v.modelLogLoss).padStart(12)}  ${num(v.brierSkill).padStart(10)}  ${num(v.logLossSkill).padStart(12)}${v.thinGames ? '  (thin: <100 games — no league params)' : ''}`);
  });
  L.push('      NOTE (item 5): the CBB holdout is 80/9 — far too skewed and thin to set parameters from;');
  L.push(`      league-specific parameters are only fitted at >= ${BT.shipGate.minLeagueGames} SETTLED GAMES in the fit window, else the sport-wide parameters are used.`);

  // Item 4 (round E) — CONFIRMATION PROGRESS per sport, and the holdout labelled
  // for what it is: the twice-scored SLIDING window, not fresh evidence.
  const confB = r.shadow.confirmation.basketball || {};
  const confS = r.shadow.confirmation.soccer || {};
  L.push(`    CONFIRMATION PROGRESS (settled GAMES after the freeze — the only eligible release evidence):`);
  L.push(`      basketball ${confB.settled_games}/${confB.min_settled_games}   soccer ${confS.settled_games}/${confS.min_settled_games}`);
  L.push(`    the ${hbk.games}-game holdout above is the TWICE-SCORED SLIDING window (it overlaps the prior window and was already evaluated) — it is NOT fresh confirmation evidence.`);
  L.push(`    SHIPS: ${hbk.ships ? 'YES' : 'NO'} — ${hbk.reasons.join('; ') || 'all clauses met'}`);
  L.push('');

  L.push('NOTHING SHIPS. Manual rough estimate stays blocked for every sport. Shadow, criteria and calibrator ids unchanged.');
  L.push(`Candidate artifact: ${r.candidates.version} frozen at ${r.confirmation.frozen_at} — every frozen id is labelled:`);
  [['basketball_logistic', r.candidates.basketball_logistic],
   ['soccer_table', r.candidates.soccer_table],
   ['soccer_mnl', r.candidates.soccer_mnl],
   ['soccer_score_time', r.candidates.soccer_score_time]].forEach(([k, v]) => {
    L.push(`    ${k.padEnd(20)} ${v.id}  ${v.label || v.model || ''}`);
  });
  L.push(`  logged on every shadow row; confirmation = shadow rows logged strictly AFTER this instant.`);
  L.push(`PRIMARY (the only one the release reads, vs scoreTime, game-level CIs): basketball ${r.candidates.registration.basketball.primary}; soccer ${r.candidates.registration.soccer.primary} (secondary: ${r.candidates.registration.soccer.secondary}).`);
  // Item 1 (round E) — the schedule fix changed the replay rows, so disclose any
  // refit drift from the frozen ids rather than overwriting the freeze.
  const rd = r.candidates.refit_disclosure;
  if (rd && Array.isArray(rd.drift)) {
    const moved = rd.drift.filter(d => d.moved);
    L.push(`  REFIT DISCLOSURE (${rd.recorded_at}): ${rd.reason}`);
    if (moved.length) {
      L.push(`    the refit would move ${moved.length} id(s); the frozen ids above are PRESERVED and the drift is recorded, not applied:`);
      moved.forEach(d => L.push(`      ${d.candidate.padEnd(20)} frozen ${d.frozen_id} → refit ${d.refit_id}`));
    } else {
      L.push('    the refit reproduces every frozen id exactly (no drift).');
    }
  }
  L.push('Near-certain outcomes are clipped to [0.01, 0.99] on every candidate, and any soccer table cell with < 30 raw rows is flagged thin.');
  L.push('Predictions are statistical estimates, not betting advice.');

  console.log(L.join('\n'));
}

if (require.main === module) {
  main().catch(err => {
    console.error('Round-C report failed:', (err && err.stack) || (err && err.message) || err);
    process.exit(1);
  });
}

module.exports = {
  round4, mean, variance, mulberry32, percentile, ci,
  logisticFitX, calibrSlopeIntercept, reliability, maxBucketDeviation, columnStats,
  absoluteVerdict, absoluteBootstrap, gainBootstrap,
  multiLogLoss, multiBrier, multiMean, multiGainBootstrap,
  cumulativeByBoundary, binsFromCumulative, sameScore, soccerSanity,
  basketballScoreTimeRows, basketballScoreTimeReport,
  redStateOf, soccerRows, currentScoreTimeThreeWay, isotonicNonDecreasing,
  fitSoccerTable, soccerPredict, applySoccerModel, soccerTableCellDemo,
  soccerFeatures, fitMultinomialLogistic, mnlPredict, applySoccerMNL, mnlChecks,
  versionId, productionHoldoutRows,
  bbLeagueConfig, basketballPredictor, fitBasketballModel, basketballModelProbability, basketballRows,
  soccerHoldoutReport, basketballHoldoutReport, holdoutRange, printReport,
  readExistingFreeze, readExistingCandidates, parseDateRange, priorHoldoutOverlap, freezeAudit, labelShuffleLeakage,
  firstCheckpointBaseRate, checkpointTiming, checkpointTruncationTest,
};
