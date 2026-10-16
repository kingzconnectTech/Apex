/**
 * basketball/probability.js
 *
 * Turns a (total, margin) projection into calibrated-ready probabilities.
 *
 *   P(Over L)        = 1 - Phi((L - proj_total) / sigma_total)
 *   P(Home covers S) = 1 - Phi((-S - proj_margin) / sigma_margin)
 *
 * Sigma is never hardcoded: it starts from the league base (leagues.js) and is
 * nudged by pace, projected total size and data quality, then clamped.
 *
 * Whole-number lines are handled with a continuity correction so the push
 * probability is explicit; half-point lines have no push.
 *
 * The residual distribution can be normal or Student-t (heavier tails) — the
 * choice is a config switch so the backtester can pick whichever fits residuals.
 */

// --- Normal distribution (Abramowitz & Stegun 7.1.26) ---

function normalCdf(z) {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

// --- Student-t (heavier tails) — regularised incomplete beta, Numerical Recipes ---

function logGamma(x) {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += cof[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a, b, x) {
  const MAXIT = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Student-t CDF with `df` degrees of freedom. */
function studentTCdf(t, df = 6) {
  const d = Math.max(1, Number(df) || 6);
  const x = d / (d + t * t);
  const ib = betai(d / 2, 0.5, x);
  return t > 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

/** Distribution selected by config (default normal). */
function cdf(z, cfg) {
  const dist = cfg?.sigma?.distribution;
  if (dist === 't' || dist === 'student-t') return studentTCdf(z, cfg?.sigma?.tDf ?? 6);
  return normalCdf(z);
}

/**
 * Standard deviation of residuals (actual minus projected) — used to fit sigma
 * per league from walk-forward out-of-sample results.
 * @param {number[]} residuals
 * @returns {number|null}
 */
function sigmaFromResiduals(residuals) {
  const vals = (Array.isArray(residuals) ? residuals : []).filter(v => Number.isFinite(v));
  if (vals.length < 2) return null;
  const m = vals.reduce((s, v) => s + v, 0) / vals.length;
  const variance = vals.reduce((s, v) => s + (v - m) * (v - m), 0) / (vals.length - 1);
  return Math.sqrt(variance);
}

/** League-average total implied by the league means. */
function leagueMeanTotal(leagueCfg) {
  const lm = leagueCfg?.leagueMean;
  if (!lm) return null;
  return lm.possessions * (lm.ortg + lm.drtg) / 100;
}

/**
 * Estimate sigma_total and sigma_margin for a specific game.
 *
 * @param {Object} params
 * @param {number} params.projTotal
 * @param {number} params.projMargin
 * @param {number} [params.expectedPossessions]
 * @param {number} [params.dataQuality] - 0..1
 * @param {Object} params.leagueCfg
 * @param {Object} params.cfg
 * @returns {Object} { total, margin, terms }
 */
function estimateSigma({ projTotal, projMargin, expectedPossessions, dataQuality = 1, leagueCfg, cfg }) {
  const s = cfg.sigma;
  const base = leagueCfg?.sigma || {};
  const dq = Math.min(1, Math.max(0, Number.isFinite(dataQuality) ? dataQuality : 1));

  const meanTotal = leagueMeanTotal(leagueCfg);
  const totalDev = (Number.isFinite(projTotal) && Number.isFinite(meanTotal)) ? Math.abs(projTotal - meanTotal) : 0;
  const paceDev = Number.isFinite(expectedPossessions) && leagueCfg?.leagueMean
    ? Math.abs(expectedPossessions - leagueCfg.leagueMean.possessions)
    : 0;

  const sizeTerm = (s.totalSizeCoef ?? 0) * totalDev;
  const paceTerm = (s.paceCoef ?? 0) * paceDev;
  const dqTermTotal = (s.dqPenaltyTotal ?? 0) * (1 - dq);
  const dqTermMargin = (s.dqPenaltyMargin ?? 0) * (1 - dq);

  const total = clamp((base.total ?? 17.5) + sizeTerm + paceTerm + dqTermTotal, s.minTotal ?? 12, s.maxTotal ?? 26);
  const margin = clamp((base.margin ?? 11.5) + sizeTerm * 0.5 + paceTerm * 0.5 + dqTermMargin, s.minMargin ?? 8, s.maxMargin ?? 18);

  return {
    total: round(total, 2),
    margin: round(margin, 2),
    terms: {
      baseTotal: base.total, baseMargin: base.margin,
      sizeTerm: round(sizeTerm, 2), paceTerm: round(paceTerm, 2),
      dqTermTotal: round(dqTermTotal, 2), dqTermMargin: round(dqTermMargin, 2),
      totalDev: round(totalDev, 2), paceDev: round(paceDev, 2),
    },
  };
}

/**
 * Totals probability for a line.
 * Whole-number lines use a continuity correction so a push is explicit.
 *
 * @returns {Object} { over, under, push }
 */
function totalsProbability({ line, projTotal, sigmaTotal, cfg }) {
  if (!Number.isFinite(line) || !Number.isFinite(projTotal) || !Number.isFinite(sigmaTotal) || sigmaTotal <= 0) {
    return { over: null, under: null, push: null };
  }
  const whole = Number.isInteger(line);
  if (whole) {
    const pOver = 1 - cdf((line + 0.5 - projTotal) / sigmaTotal, cfg);
    const pUnder = cdf((line - 0.5 - projTotal) / sigmaTotal, cfg);
    const push = Math.max(0, 1 - pOver - pUnder);
    return { over: round(pOver, 4), under: round(pUnder, 4), push: round(push, 4) };
  }
  const pOver = 1 - cdf((line - projTotal) / sigmaTotal, cfg);
  return { over: round(pOver, 4), under: round(1 - pOver, 4), push: 0 };
}

/**
 * Spread probability. `spread` is the HOME handicap (negative when home favoured).
 * Home covers when (margin + spread) > 0.
 * Whole-number spreads use a continuity correction so a push is explicit.
 *
 * @returns {Object} { home, away, push }
 */
function spreadProbability({ spread, projMargin, sigmaMargin, cfg }) {
  if (!Number.isFinite(spread) || !Number.isFinite(projMargin) || !Number.isFinite(sigmaMargin) || sigmaMargin <= 0) {
    return { home: null, away: null, push: null };
  }
  const threshold = -spread;
  const whole = Number.isInteger(spread);
  if (whole) {
    const pHome = 1 - cdf((threshold + 0.5 - projMargin) / sigmaMargin, cfg);
    const pAway = cdf((threshold - 0.5 - projMargin) / sigmaMargin, cfg);
    const push = Math.max(0, 1 - pHome - pAway);
    return { home: round(pHome, 4), away: round(pAway, 4), push: round(push, 4) };
  }
  const pHome = 1 - cdf((threshold - projMargin) / sigmaMargin, cfg);
  return { home: round(pHome, 4), away: round(1 - pHome, 4), push: 0 };
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function round(v, dp = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  return Number(v.toFixed(dp));
}

module.exports = {
  normalCdf,
  studentTCdf,
  sigmaFromResiduals,
  leagueMeanTotal,
  estimateSigma,
  totalsProbability,
  spreadProbability,
};
