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
 * Push rows (y === null) are excluded from fitting — they are not wins or losses.
 */

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

  /** Apply the stored calibrator, or the identity when none is trusted. */
  apply(league, market, p) {
    const eps = this.cfg?.calibration?.epsilon ?? 0.001;
    if (!Number.isFinite(p)) return p;
    const entry = this.models.get(_key(league, market));
    if (!entry) return clampProb(p, eps);
    const out = entry.method === 'platt' ? applyPlatt(entry.model, p) : applyIsotonic(entry.model, p);
    return clampProb(out, eps);
  }

  has(league, market) {
    return this.models.has(_key(league, market));
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
  fitIsotonic,
  applyIsotonic,
  fitPlatt,
  applyPlatt,
  brierScore,
  logLoss,
  calibrationCurve,
  Calibrator,
  logit,
  sigmoid,
  clampProb,
};
