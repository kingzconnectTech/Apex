/**
 * live/liveCalibrator.js
 *
 * Phase 9 — serve the column the ship gate actually validated.
 *
 * The Phase 5/8 harness scores `pShipped`: the walk-forward CALIBRATED home-win
 * probability when the calibration gate kept the calibrator, the raw value when
 * it did not (see services/live/backtester stampShipped). Production, however,
 * built its figures from the raw model output — so for a sport whose calibrator
 * was kept, the number the UI showed was NOT the number that passed the gate.
 *
 * This module closes that gap: it loads the calibrator the fit script persisted
 * (scripts/fit-live-calibrator.js -> CONFIG.live.calibration.file) and applies
 * exactly those curves to the live home-win probability before the payload is
 * built.
 *
 * Three rules, all defensive:
 *   1. Absent, unreadable or un-kept artifact -> the IDENTITY. An unvalidated
 *      calibrator is never applied; the raw probability is served unchanged.
 *   2. Only the market the artifact names (config `market`, 'home_win') is
 *      touched. Every other figure is left alone.
 *   3. Nothing here throws on a bad artifact. A corrupt file means "no
 *      calibrator", never a 500 on a user request.
 *
 * Keys in the artifact follow the shared Calibrator registry convention,
 * `${sport}|${market}` (see services/basketball/calibration _key), so the same
 * class that fitted it can apply it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG = require('./config');
const { Calibrator } = require('../basketball/calibration');

const CALIB = CONFIG.live.calibration;
// Config file paths are relative to the backend directory (see ./config).
const BACKEND_DIR = path.join(__dirname, '..', '..');

/** Absolute path for a config-relative artifact path. */
function resolveFile(file = CALIB.file) {
  if (!file) return null;
  return path.isAbsolute(file) ? file : path.join(BACKEND_DIR, file);
}

/**
 * Read and parse the artifact. Returns null for anything unusable — a missing
 * file, unreadable bytes or invalid JSON are all "no calibrator", never a throw.
 */
function readArtifact(file = CALIB.file) {
  const target = resolveFile(file);
  if (!target) return null;
  try {
    const json = JSON.parse(fs.readFileSync(target, 'utf8'));
    return json && typeof json === 'object' ? json : null;
  } catch (err) {
    return null;
  }
}

/**
 * A stable content id for a calibrator artifact. Phase 9 freezes the calibrator
 * a shadow run is collected under, so every shadow row records the exact curves
 * it was produced with. Hashing `models` + `fittedAt` means a refit — even to the
 * same shape — yields a new id, and the same artifact read twice yields the same
 * id. Returns null for anything unusable.
 */
function computeId(artifact) {
  if (!artifact) return null;
  try {
    const payload = JSON.stringify({
      kept: artifact.kept === true,
      market: artifact.market || null,
      fittedAt: artifact.fittedAt || null,
      models: artifact.models || null,
    });
    return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 12);
  } catch (err) {
    return null;
  }
}

/**
 * Turn an artifact into the module's working state.
 * `kept` is only true when the artifact says so AND carries at least one model.
 */
function buildState(artifact) {
  const id = computeId(artifact);
  if (!artifact) {
    return { kept: false, calibrator: null, meta: null, reason: 'no calibrator artifact is present', source: null, id };
  }
  if (artifact.kept !== true) {
    return {
      kept: false,
      calibrator: null,
      meta: artifact.meta || null,
      reason: artifact.reason || 'the persisted calibrator was not kept by the calibration gate',
      source: artifact.fittedAt || null,
      id,
    };
  }
  if (!artifact.models || !Object.keys(artifact.models).length) {
    return {
      kept: false,
      calibrator: null,
      meta: artifact.meta || null,
      reason: 'the persisted calibrator carries no models',
      source: artifact.fittedAt || null,
      id,
    };
  }
  return {
    kept: true,
    calibrator: Calibrator.fromJSON(CONFIG, artifact.models),
    meta: artifact.meta || null,
    reason: null,
    source: artifact.fittedAt || null,
    id,
  };
}

let state = buildState(null);
let loaded = false;

/**
 * Load the artifact (once at server startup; idempotent). Returns the state.
 * @param {Object} [opts]
 * @param {string} [opts.file] override the config path (tests)
 */
function init({ file } = {}) {
  if (CALIB.enabled === false) {
    state = { kept: false, calibrator: null, meta: null, reason: 'live calibration is switched off', source: null, id: null };
    loaded = true;
    return state;
  }
  state = buildState(readArtifact(file));
  loaded = true;
  return state;
}

/** Load lazily if `init` was never called (so a unit test need not). */
function ensure() {
  if (!loaded) init();
  return state;
}

/**
 * Apply the kept calibrator to a probability, or return it unchanged.
 *
 * @param {string} sport    'basketball' | 'soccer'
 * @param {string} market   'home_win'
 * @param {number} p        raw probability
 * @param {'a'|'b'} [side]  'a' is the canonical side (home)
 * @returns {number} calibrated probability, or the input when nothing is kept
 */
function apply(sport, market, p, side = 'a') {
  const s = ensure();
  if (!s.kept || !s.calibrator) return p;
  if (!Number.isFinite(p)) return p;
  return s.calibrator.apply(sport, market, p, side);
}

/** Whether a trusted calibrator is loaded (for diagnostics and tests). */
function isActive() {
  return ensure().kept;
}

/**
 * The version id of the calibrator that is actually APPLIED. `'identity'` when
 * no validated calibrator is loaded (raw probabilities are served), so a shadow
 * row records exactly what produced its number. Never throws.
 */
function id() {
  const s = ensure();
  if (!s.kept) return 'identity';
  return s.id || 'unknown';
}

/** Non-sensitive description of the current state, for logs and diagnostics. */
function status() {
  const s = ensure();
  return {
    enabled: CALIB.enabled !== false,
    loaded,
    active: s.kept,
    // The applied version id ('identity' when none is kept) and the raw artifact
    // id, so a refit is visible even before it becomes active.
    id: id(),
    artifact_id: s.id,
    reason: s.reason,
    market: CALIB.market,
    fittedAt: s.source,
    meta: s.meta,
  };
}

/**
 * Persist an artifact (used by scripts/fit-live-calibrator.js). Writes the exact
 * JSON the loader reads back, and does not modify the in-memory state.
 *
 * @returns {string} the absolute path written
 */
function save(artifact, { file = CALIB.file } = {}) {
  const target = resolveFile(file);
  if (!target) throw new Error('liveCalibrator.save requires a target file');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(artifact, null, 2));
  return target;
}

/** Test/dev helper — drop the cached state so the next ensure() reloads. */
function reset() {
  state = buildState(null);
  loaded = false;
}

module.exports = {
  init,
  apply,
  isActive,
  id,
  status,
  save,
  reset,
  readArtifact,
  buildState,
  resolveFile,
};
