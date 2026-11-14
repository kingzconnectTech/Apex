/**
 * live/liveMath.js
 *
 * Small numerical helpers shared by the Phase 4 live models. Pure functions
 * only — no config, no I/O, so they are trivially unit-testable.
 *
 * `normalCdf` is re-exported from basketball/probability.js so there is exactly
 * one normal-CDF implementation in the codebase.
 */

const { normalCdf } = require('../basketball/probability');

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function round(v, dp = 4) {
  if (v == null || !Number.isFinite(v)) return null;
  return Number(v.toFixed(dp));
}

/**
 * Inverse standard-normal CDF (Acklam's rational approximation, |err| < 1.15e-9).
 * Used to turn a confidence level into a z-score for the reported bands.
 */
function normalInv(p) {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
    -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
    3.754408661907416e0];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q;
  let r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
    / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Poisson pmf, computed in log space for numerical stability. */
function poissonPmf(k, lambda) {
  if (k < 0) return 0;
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logp = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logp -= Math.log(i);
  return Math.exp(logp);
}

/**
 * Dixon-Coles low-score dependence factor for a remaining-goals pair.
 * `rho` is negative for the usual mild low-score inflation.
 */
function dixonColesTau(x, y, lambda, mu, rho) {
  if (x === 0 && y === 0) return 1 - lambda * mu * rho;
  if (x === 0 && y === 1) return 1 + lambda * rho;
  if (x === 1 && y === 0) return 1 + mu * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/**
 * Parse a provider clock string.
 *   "7:24"     -> { minutes: 7.4, stoppage: 0, format: 'mm:ss' }
 *   "50.6"     -> { minutes: 0.843, stoppage: 0, format: 'seconds' }
 *   "34'"      -> { minutes: 34,  stoppage: 0, format: 'half'  }
 *   "90+4'"    -> { minutes: 94,  stoppage: 4, format: 'half'  }
 *   "90'+7'"   -> { minutes: 97,  stoppage: 7, format: 'half'  }  (ESPN soccer)
 * Returns null for anything unrecognised rather than guessing.
 *
 * The `seconds` form is what ESPN's basketball play-by-play emits inside the
 * final minute of a period ("50.6", "3.0", "0.0" seconds remaining), verified
 * against a live play-by-play pull.
 */
function parseClock(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;
  let m = t.match(/^(\d{1,3}):([0-5]\d)$/);
  if (m) return { minutes: Number(m[1]) + Number(m[2]) / 60, stoppage: 0, format: 'mm:ss' };
  m = t.match(/^(\d{1,3})\.(\d{1,2})$/);
  if (m) return { minutes: (Number(m[1]) + Number(`0.${m[2]}`)) / 60, stoppage: 0, format: 'seconds' };
  m = t.match(/^(\d{1,3})'?(?:\+(\d{1,2})'?)?$/);
  if (m) {
    const stoppage = m[2] ? Number(m[2]) : 0;
    return { minutes: Number(m[1]) + stoppage, stoppage, format: 'half' };
  }
  return null;
}

/**
 * Discrete quantile of a pmf given as [{ value, prob }].
 * Returns the smallest value whose cumulative probability reaches `q`.
 */
function quantileFromPairs(pairs, q) {
  if (!Array.isArray(pairs) || !pairs.length) return null;
  const sorted = [...pairs].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, p) => s + p.prob, 0);
  if (!(total > 0)) return null;
  let cum = 0;
  for (const p of sorted) {
    cum += p.prob;
    if (cum / total >= q) return p.value;
  }
  return sorted[sorted.length - 1].value;
}

/** Weighted blend of two numbers; `w` is the weight on `live`. */
function blend(live, prior, w) {
  if (!Number.isFinite(live)) return prior;
  if (!Number.isFinite(prior)) return live;
  return w * live + (1 - w) * prior;
}

module.exports = {
  normalCdf,
  normalInv,
  poissonPmf,
  dixonColesTau,
  parseClock,
  quantileFromPairs,
  blend,
  clamp,
  round,
};
