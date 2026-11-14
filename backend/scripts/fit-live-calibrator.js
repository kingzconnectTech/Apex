#!/usr/bin/env node
/**
 * scripts/fit-live-calibrator.js
 *
 * Phase 9 — fit the LIVE calibrator that production must serve, persist it,
 * record the backtest log loss the forward test compares against, and
 * re-confirm the ship gate on the column production will actually display.
 *
 * WHY THIS EXISTS
 *   The Phase 5/8 ship gate scores `pShipped`: the walk-forward CALIBRATED
 *   home-win probability when the calibration gate kept the calibrator, the raw
 *   value when it did not (services/live/backtester, stampShipped). Production
 *   built its figures from the raw model output — so for a sport whose
 *   calibrator was kept, the number a user saw was NOT the number that passed
 *   the gate. This script closes that gap. services/live/liveCalibrator loads
 *   the persisted artifact at startup and applies exactly those curves to the
 *   live home-win probability, so the served column equals the validated one.
 *
 * WHAT IT DOES
 *   1. Loads the SAME ESPN history the Phase 8/9 reports used (disk-cached, so a
 *      repeat run re-downloads nothing).
 *   2. Runs the walk-forward backtest and the calibration gate.
 *   3. Persists the final walk-forward calibrator, but ONLY for a sport whose
 *      calibration gate KEPT the calibrator. An un-kept sport is never written,
 *      so liveCalibrator falls back to the identity for it — an unvalidated
 *      calibrator is never applied.
 *   4. Writes the gate's out-of-sample log loss into the forward-test log, so
 *      the live auto-disable (services/live/forwardTest) has a benchmark to
 *      compare the realised live numbers against.
 *   5. Re-confirms the gate THREE ways on the same held-out test window:
 *        - raw        : what production served BEFORE this change (`pRaw`).
 *        - shipped    : the walk-forward calibrated column the gate scored
 *                       (`pShipped`) — the column production now serves.
 *        - production : a calibrator fitted on train+validation ONLY and applied
 *                       to the held-out test window. This is the leakage-free
 *                       proxy for what a deploy-time fit does on unseen games.
 *
 * Nothing here tunes toward a passing grade: the thresholds come from
 * services/live/config.js and the output is whatever the data says. If the gate
 * does not pass on the production column, the artifact is NOT kept and the
 * script says so plainly.
 *
 * Usage:
 *   node scripts/fit-live-calibrator.js                 # full cached sweep
 *   node scripts/fit-live-calibrator.js --max-games=0   # uncapped (matches Phase 8)
 *   node scripts/fit-live-calibrator.js --dry-run       # fit + report, write nothing
 *   node scripts/fit-live-calibrator.js --out=data/live-calibrator.json --forward=data/live-forward.json
 */

const fs = require('fs');
const path = require('path');

const LIVE_CONFIG = require('../services/live/config');
const {
  evaluate, calibrationGate, stampShipped, shipGate, CALIB_KEY,
} = require('../services/live/backtester');
const { Calibrator } = require('../services/basketball/calibration');
const liveCalibrator = require('../services/live/liveCalibrator');
const forwardTest = require('../services/live/forwardTest');
const { loadDatasetFromEspn } = require('./run-live-backtest');

const BT = LIVE_CONFIG.liveBacktest;
const CALIB = LIVE_CONFIG.live.calibration;
const FWD = LIVE_CONFIG.live.forwardTest;
const DATASET = BT.dataset;
// The market the calibration gate and the live calibrator both key on.
const MARKET = CALIB.market;
const BACKEND_DIR = path.join(__dirname, '..');

function parseArgs(argv) {
  const out = {};
  argv.forEach(a => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  });
  return out;
}

function num(v, dp = 4) {
  return v == null || !Number.isFinite(v) ? 'n/a' : Number(v).toFixed(dp);
}
function pct(v) {
  return v == null || !Number.isFinite(v) ? 'n/a' : `${(v * 100).toFixed(1)}%`;
}

/**
 * Fit a calibrator on everything BEFORE the test window (train + validation) for
 * one sport. This is the honest production proxy: production fits on all data
 * available before deploy, and the test window is deploy-time future.
 */
function fitPreTest(rows, sport) {
  const train = rows
    .filter(r => r.sport === sport && r.window !== 'test')
    .map(r => ({ p: r.pRaw, y: r.y }));
  const calibrator = new Calibrator({ calibration: BT.calibration });
  const model = calibrator.fit(sport, CALIB_KEY, train, {
    method: BT.calibration.method,
    minSamples: BT.calibration.minSamples,
  });
  return model ? calibrator : null;
}

/** Re-score the test window three ways for one sport. */
function confirmSport(rows, sport, kept) {
  const test = rows.filter(r => r.window === 'test' && r.sport === sport);
  if (!test.length) return null;

  const raw = shipGate(test, { probKey: 'pRaw' });
  const shipped = shipGate(test, { probKey: 'pShipped' });

  const calibrator = fitPreTest(rows, sport);
  const productionColumn = calibrator
    ? test.map(r => ({ ...r, pProd: calibrator.apply(sport, CALIB_KEY, r.pRaw, 'a') }))
    : test;
  const production = shipGate(productionColumn, { probKey: 'pProd' });

  return { sport, calibrationKept: kept, raw, shipped, production };
}

function gateLine(label, g) {
  if (!g) return `  ${label.padEnd(11)} n/a`;
  return `  ${label.padEnd(11)} games ${String(g.games).padStart(5)}/${g.minGames}  hit ${pct(g.hitRate)} CI-low ${pct(g.hitRateLowerBound)}  Brier ${num(g.model.brier)}  logLoss ${num(g.model.logLoss)}  BrierGain ${num(g.brierGain)}  LLGain ${num(g.logLossGain)}  ${g.passed ? 'PASS' : 'FAIL'}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outFile = args.out ? String(args.out) : CALIB.file;
  const forwardFile = args.forward ? String(args.forward) : FWD.file;
  const dryRun = args['dry-run'] === true || args.dryRun === true;

  const sports = ['basketball', 'soccer'];
  const sweep = {};
  sports.forEach(s => { sweep[s] = LIVE_CONFIG.matcher.sweep[s] || []; });
  const seasons = {};
  sports.forEach(s => { seasons[s] = BT.seasons[s] || []; });

  const cacheDir = args.cache === 'off' ? null : path.join(BACKEND_DIR, DATASET.cacheDir);
  // 0 means "no cap", which reproduces the Phase 8 sweep exactly. That is the
  // default here so the persisted calibrator and the re-confirmed gate describe
  // the same dataset the accepted Phase 8/9 reports were built on.
  const maxGames = args['max-games'] !== undefined
    ? Number(args['max-games'])
    : 0;

  process.stderr.write(`[fit] loading dataset from ESPN cache… (maxGames ${maxGames})\n`);
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
  process.stderr.write(`[fit] loaded ${dataset.games.length} games\n`);

  process.stderr.write('[fit] walk-forward backtest + calibration gate…\n');
  const ev = evaluate(dataset);
  const calibration = calibrationGate(ev.rows);
  stampShipped(ev.rows, calibration);

  // Persist only the keys whose calibration gate KEPT the calibrator.
  const models = {};
  const keptSports = [];
  Object.keys(calibration).forEach(sport => {
    const c = calibration[sport];
    if (!c || !c.kept) return;
    const key = `${sport}|${CALIB_KEY}`;
    if (ev.calibrator && ev.calibrator[key]) {
      models[key] = ev.calibrator[key];
      keptSports.push(sport);
    }
  });

  const confirmations = {};
  Object.keys(calibration).forEach(sport => {
    confirmations[sport] = confirmSport(ev.rows, sport, Boolean(calibration[sport] && calibration[sport].kept));
  });

  // The forward test compares one realised log loss against one benchmark: the
  // out-of-sample log loss of the shipped column for the sport being rolled out.
  const benchSport = keptSports.includes('basketball') ? 'basketball' : keptSports[0] || null;
  const benchmarkLogLoss = benchSport && confirmations[benchSport]
    ? confirmations[benchSport].shipped.model.logLoss
    : null;

  const artifact = {
    kept: keptSports.length > 0,
    reason: keptSports.length ? null : 'no sport cleared the calibration gate, so the identity is served',
    market: MARKET,
    method: CALIB.method,
    fittedAt: new Date().toISOString(),
    dataset: {
      games: ev.games,
      checkpoints: ev.checkpoints,
      sports: [...new Set(ev.rows.map(r => r.sport))].sort(),
    },
    // The calibration gate's own verdict, per sport. Informational: it explains
    // WHY a key is present (or absent) below.
    gate: Object.fromEntries(Object.entries(calibration).map(([s, c]) => [s, {
      kept: Boolean(c && c.kept),
      monotone: c ? c.monotone : null,
      brierGain: c ? c.brierGain : null,
      logLossGain: c ? c.logLossGain : null,
      trainedOn: c ? c.trainedOn : null,
      validatedOn: c ? c.validatedOn : null,
    }])),
    models,
  };

  /* ------------------------------------------------------------- report */
  const L = [];
  L.push(`# Live calibrator fit — ${artifact.fittedAt}`);
  L.push(`dataset: ${ev.games} games, ${ev.checkpoints} checkpoints (${artifact.dataset.sports.join(', ') || 'n/a'})`);
  L.push('');
  L.push('Calibration gate (train -> validation, identity unless it earns its place):');
  Object.entries(artifact.gate).forEach(([sport, c]) => {
    L.push(`  ${sport.padEnd(12)} kept ${String(c.kept).padEnd(5)} monotone ${String(c.monotone).padEnd(5)} Brier gain ${num(c.brierGain)}  log loss gain ${num(c.logLossGain)}  (trained ${c.trainedOn} / validated ${c.validatedOn})`);
  });
  L.push('');
  L.push('Ship gate on the test window — raw vs walk-forward-shipped vs production-fit:');
  L.push('  (raw = what production served before; shipped = the column the gate scored; production = calibrator fitted on train+validation only, applied to test)');
  Object.values(confirmations).forEach(c => {
    if (!c) return;
    L.push(`  ${c.sport}  (calibration kept ${c.calibrationKept})`);
    L.push(gateLine('raw', c.raw));
    L.push(gateLine('shipped', c.shipped));
    L.push(gateLine('production', c.production));
    if (!c.production.passed) c.production.reasons.forEach(r => L.push(`      production fail: ${r}`));
  });
  L.push('');
  L.push(`artifact kept: ${artifact.kept}  keys: ${Object.keys(models).join(', ') || '(none)'}`);
  L.push(`forward-test benchmark log loss: ${num(benchmarkLogLoss)} (${benchSport || 'n/a'})`);
  L.push('');

  if (dryRun) {
    L.push('--dry-run: nothing written.');
    console.log(L.join('\n'));
    return;
  }

  const written = liveCalibrator.save(artifact, { file: outFile });
  L.push(`wrote calibrator: ${written}`);

  // Seed the forward log's benchmark WITHOUT disturbing any rows already logged.
  forwardTest.init({ file: forwardFile, benchmarkLogLoss });
  forwardTest.flush(forwardFile);
  L.push(`wrote forward benchmark: ${forwardTest.resolveFile(forwardFile)}`);
  console.log(L.join('\n'));
}

if (require.main === module) {
  main().catch(err => {
    console.error('Live calibrator fit failed:', (err && err.stack) || (err && err.message) || err);
    process.exit(1);
  });
}

module.exports = { fitPreTest, confirmSport };
