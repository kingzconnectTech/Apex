/**
 * basketball/calibration.js
 *
 * Calibrates raw model probabilities so a stated 65% wins about 65% of the time.
 *
 * Two methods (config-selected):
 *   - isotonic regression (PAVA) — monotone step function, distribution-free
 *   - Platt scaling — logistic fit on the logit of the raw probability
 *
 * Models are kept per (league, market). When a (league, market) has fewer than
 * `calibration.minSamples` out-of-sample rows, apply() falls back to the identity
 * (raw probability unchanged) rather than pretending to calibrate.
 *
 * Two-way markets are fitted on a FIXED side (Over for totals, home for spreads)
 * and the other side is derived as the complement, so P(Over) + P(Under) === 1.
 * See canonicalizeRow().
 *
 * Push rows (y === null) are excluded from fitting — they are not wins or losses.
 */

/** Stamped into the persisted model document so a fitted artifact is traceable. */
const CALIBRATOR_VERSION = 'bb-cal-1.0.0';

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function clampProb(p, epsilon = 0.001) {
  if (!Number.isFinite(p)) return null;
  return clamp(p, epsilon, 1 - epsilon);
}

function logit(p) {
  const q = clamp(p, 1e-6, 1 - 1e-6);
  return Math.log(q / (1 - q));
}

function sigmoid(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

function _validRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(r => Number.isFinite(r?.p) && (r?.y === 0 || r?.y === 1))
    .sort((a, b) => a.p - b.p);
}

// --- Isotonic regression (pool adjacent violators) ---

/**
 * Fit a monotone increasing step function to (p -> y) pairs.
 * @returns {Object|null} { method:'isotonic', xEnds:number[], values:number[], samples:number }
 */
function fitIsotonic(rows, { minSamples = 150 } = {}) {
  const data = _validRows(rows);
  if (data.length < minSamples) return null;

  // Blocks of pooled observations; merge while means violate monotonicity.
  const blocks = [];
  data.forEach(row => {
    blocks.push({ w: 1, wy: row.y, start: blocks.length ? null : 0, lastP: row.p, firstP: row.p });
    while (blocks.length > 1) {
      const a = blocks[blocks.length - 2];
      const b = blocks[blocks.length - 1];
      if (a.wy / a.w > b.wy / b.w) {
        a.w += b.w;
        a.wy += b.wy;
        a.lastP = b.lastP;
        blocks.pop();
      } else break;
    }
  });

  return {
    method: 'isotonic',
    xEnds: blocks.map(b => b.lastP),
    values: blocks.map(b => b.wy / b.w),
    samples: data.length,
  };
}

/** Apply an isotonic step model. */
function applyIsotonic(model, p) {
  if (!model || !Number.isFinite(p)) return p;
  const { xEnds, values } = model;
  for (let i = 0; i < xEnds.length; i++) {
    if (p <= xEnds[i]) return values[i];
  }
  return values[values.length - 1];
}

// --- Platt scaling ---

/**
 * Fit y = sigmoid(a * logit(p) + b) by gradient descent.
 * @returns {Object|null} { method:'platt', a, b, samples }
 */
function fitPlatt(rows, { minSamples = 150, iterations = 3000, lr = 0.1, l2 = 0.01 } = {}) {
  const data = _validRows(rows);
  if (data.length < minSamples) return null;

  const X = data.map(r => logit(r.p));
  const Y = data.map(r => r.y);
  const n = data.length;

  let a = 1;
  let b = 0;
  for (let it = 0; it < iterations; it++) {
    let ga = 0;
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const pred = sigmoid(a * X[i] + b);
      const err = pred - Y[i];
      ga += err * X[i];
      gb += err;
    }
    ga = ga / n + l2 * a;
    gb /= n;
    a -= lr * ga;
    b -= lr * gb;
  }
  return { method: 'platt', a, b, samples: n };
}

/** Apply a Platt model. */
function applyPlatt(model, p) {
  if (!model || !Number.isFinite(p)) return p;
  return sigmoid(model.a * logit(p) + model.b);
}

/** Apply whichever model shape was fitted (no-op for a null model). */
function applyModel(model, p) {
  if (!model || !Number.isFinite(p)) return p;
  return model.method === 'platt' ? applyPlatt(model, p) : applyIsotonic(model, p);
}

/**
 * Is the fitted curve monotone non-decreasing in the raw probability?
 *
 * Isotonic regression is monotone by construction, so a non-monotone `values`
 * array can only come from a corrupt or hand-edited model. A Platt curve is
 * monotone exactly while its slope `a` is positive — a negative slope means the
 * fit inverted the signal and must never be applied.
 *
 * @param {Object} model
 * @param {number} [tolerance] - slack for floating-point noise
 * @returns {boolean}
 */
function isMonotone(model, tolerance = 1e-9) {
  if (!model) return false;
  if (model.method === 'platt') return Number.isFinite(model.a) && model.a > 0;
  const values = model.values;
  if (!Array.isArray(values) || !values.length) return false;
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[i - 1] - tolerance) return false;
  }
  return true;
}

// --- Metric functions (used by the backtester and performance dashboard) ---

/** Brier score; rows with y === null (pushes) are ignored. */
function brierScore(rows) {
  const data = (Array.isArray(rows) ? rows : []).filter(r => Number.isFinite(r?.p) && (r?.y === 0 || r?.y === 1));
  if (!data.length) return null;
  return data.reduce((s, r) => s + Math.pow(r.p - r.y, 2), 0) / data.length;
}

/** Log loss; rows with y === null (pushes) are ignored. */
function logLoss(rows) {
  const data = (Array.isArray(rows) ? rows : []).filter(r => Number.isFinite(r?.p) && (r?.y === 0 || r?.y === 1));
  if (!data.length) return null;
  const eps = 1e-12;
  return -data.reduce((s, r) => {
    const p = clamp(r.p, eps, 1 - eps);
    return s + (r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p));
  }, 0) / data.length;
}

/**
 * Calibration curve: bucket rows by predicted probability.
 * @param {Array} rows
 * @param {number[]} edges - bucket boundaries, e.g. [0.55,0.60,0.65,0.70,1.01]
 */
function calibrationCurve(rows, edges = [0.55, 0.6, 0.65, 0.7, 1.01]) {
  const data = (Array.isArray(rows) ? rows : []).filter(r => Number.isFinite(r?.p) && (r?.y === 0 || r?.y === 1));
  const buckets = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i];
    const hi = edges[i + 1];
    const inBucket = data.filter(r => r.p >= lo && r.p < hi);
    buckets.push({
      range: `${lo.toFixed(2)}-${Math.min(hi, 1).toFixed(2)}`,
      n: inBucket.length,
      predicted: inBucket.length ? inBucket.reduce((s, r) => s + r.p, 0) / inBucket.length : null,
      actual: inBucket.length ? inBucket.reduce((s, r) => s + r.y, 0) / inBucket.length : null,
    });
  }
  return buckets;
}

// --- Two-way (fixed-side) canonicalisation ---

/**
 * A two-way market must calibrate as ONE probability, not two independent ones:
 * P(Over) + P(Under) has to stay exactly 1, otherwise the two sides of the same
 * line can both claim an edge. Every pick is therefore collapsed onto the
 * canonical side — 'a' (Over for totals, home for spreads) — before fitting, and
 * the complement is derived from the fitted curve afterwards:
 *
 *   side 'a': P_cal = f(p)
 *   side 'b': P_cal = 1 - f(1 - p)
 *
 * @param {Object} row - { p, y, side } with side 'a' (canonical) or 'b'
 * @returns {Object} { p, y } expressed on the canonical side
 */
function canonicalizeRow(row) {
  const flip = row?.side === 'b';
  const p = Number(row?.p);
  const y = row?.y;
  return {
    p: flip && Number.isFinite(p) ? 1 - p : p,
    y: (y === 0 || y === 1) ? (flip ? 1 - y : y) : null,
  };
}

/** Canonicalise a batch of side-tagged rows. */
function canonicalizeRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(canonicalizeRow)
    .filter(r => Number.isFinite(r.p));
}

/**
 * Score a fitted model against the identity (raw probability, uncalibrated) on
 * held-out rows. This is the validation gate: a calibrator is only worth saving
 * when it beats doing nothing on data it has not seen — by a margin large enough
 * not to be noise.
 *
 * A fit must clear ALL of:
 *   - at least `minSamples` graded holdout rows (below that: no verdict),
 *   - a monotone non-decreasing curve (see isMonotone),
 *   - `minImprovementBrier` better Brier than identity, AND
 *   - `minImprovementLogLoss` better log loss than identity.
 *
 * Evaluated canonical-side, which covers both sides of the market at once.
 *
 * @param {Object} params
 * @param {Array} params.rows       - held-out side-tagged rows ({ p, y, side })
 * @param {Object} params.model     - fitted model (isotonic/platt)
 * @param {number} [params.minSamples] - minimum graded holdout rows to judge
 * @param {number} [params.minImprovementBrier]
 * @param {number} [params.minImprovementLogLoss]
 * @param {boolean} [params.requireMonotone]
 * @returns {Object} { n, graded, judged, monotone, brierGain, logLossGain, before, after, improved }
 */
function validateAgainstIdentity({
  rows, model, minSamples = 150,
  minImprovementBrier = 0.002, minImprovementLogLoss = 0.002, requireMonotone = true,
} = {}) {
  const canonical = canonicalizeRows(rows).filter(r => r.y === 0 || r.y === 1);
  const n = canonical.length;
  const before = { brier: brierScore(canonical), logLoss: logLoss(canonical) };
  const monotone = isMonotone(model);
  const scored = Boolean(model) && n >= minSamples;
  const after = scored
    ? {
      brier: brierScore(canonical.map(r => ({ p: applyModel(model, r.p), y: r.y }))),
      logLoss: logLoss(canonical.map(r => ({ p: applyModel(model, r.p), y: r.y }))),
    }
    : { brier: null, logLoss: null };

  const brierGain = scored ? before.brier - after.brier : null;
  const logLossGain = scored ? before.logLoss - after.logLoss : null;
  const judged = scored && (!requireMonotone || monotone);

  return {
    n,
    graded: n,
    judged,
    monotone,
    brierGain,
    logLossGain,
    minSamples,
    minImprovementBrier,
    minImprovementLogLoss,
    before,
    after,
    improved: judged
      && brierGain >= minImprovementBrier
      && logLossGain >= minImprovementLogLoss,
  };
}

// --- Calibrator registry ---

function _key(league, market) {
  return `${String(league)}|${String(market)}`;
}

class Calibrator {
  constructor(cfg) {
    this.cfg = cfg;
    this.models = new Map();
  }

  /** Fit and store a calibrator for one (league, market). Returns the model or null. */
  fit(league, market, rows, opts = {}) {
    const calCfg = this.cfg?.calibration || {};
    const method = opts.method || calCfg.method || 'isotonic';
    const minSamples = opts.minSamples ?? calCfg.minSamples ?? 150;
    const data = Array.isArray(rows) ? rows : [];

    const model = method === 'platt'
      ? fitPlatt(data, { minSamples })
      : fitIsotonic(data, { minSamples });

    if (!model) return null;
    this.models.set(_key(league, market), { method, model, samples: model.samples, trainedAt: new Date().toISOString() });
    return model;
  }

  /**
   * Fit a two-way market on its canonical side so the complement stays exact.
   *
   * `rows` must be side-tagged ({ p, y, side }): both sides' observations are
   * pooled into one monotone curve on the canonical side, instead of fitting the
   * Over and Under picks independently (which lets both sides claim >50%).
   *
   * @param {string} league
   * @param {string} market - 'Total Points' | 'Spread'
   * @param {Array} rows    - [{ p, y, side }]
   */
  fitTwoWay(league, market, rows, opts = {}) {
    return this.fit(league, market, canonicalizeRows(rows), opts);
  }

  /**
   * Apply the stored calibrator, or the identity when none is trusted.
   *
   * @param {string} league
   * @param {string} market
   * @param {number} p
   * @param {'a'|'b'} [side='a'] - 'a' is the canonical side (Over / home)
   */
  apply(league, market, p, side = 'a') {
    const eps = this.cfg?.calibration?.epsilon ?? 0.001;
    if (!Number.isFinite(p)) return p;
    const entry = this.models.get(_key(league, market));
    if (!entry) return clampProb(p, eps);
    // The complement is derived, never fitted separately: 1 - f(1 - p) keeps
    // P(a) + P(b) === 1 by construction.
    const out = side === 'b'
      ? 1 - applyModel(entry.model, 1 - p)
      : applyModel(entry.model, p);
    return clampProb(out, eps);
  }

  has(league, market) {
    return this.models.has(_key(league, market));
  }

  /** Metadata for one fitted key (samples, method, training time). */
  entry(league, market) {
    return this.models.get(_key(league, market)) || null;
  }

  toJSON() {
    const out = {};
    this.models.forEach((v, k) => { out[k] = v; });
    return out;
  }

  static fromJSON(cfg, json) {
    const c = new Calibrator(cfg);
    Object.entries(json || {}).forEach(([k, v]) => c.models.set(k, v));
    return c;
  }
}

module.exports = {
  CALIBRATOR_VERSION,
  fitIsotonic,
  applyIsotonic,
  fitPlatt,
  applyPlatt,
  applyModel,
  isMonotone,
  canonicalizeRow,
  canonicalizeRows,
  validateAgainstIdentity,
  brierScore,
  logLoss,
  calibrationCurve,
  Calibrator,
  logit,
  sigmoid,
  clampProb,
};
