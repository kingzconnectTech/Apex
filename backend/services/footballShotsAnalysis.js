/**
 * footballShotsAnalysis.js
 *
 * Football shot-market prediction engine:
 *   - Total Match Shots over/under (configurable half-lines)
 *   - Home Team Shots over/under
 *   - Away Team Shots over/under
 *
 * Principles (matching footballHistoricalAnalysis.js):
 *   - Only completed matches before kickoff are used (no future-data leakage).
 *   - Total shots uses the provider's total-shots field — NEVER shots-on-target.
 *   - Missing statistics remain explicitly null (never defaulted to zero).
 *   - Probabilities come from the full predictive count-distribution CDF
 *     (Poisson, with Negative-Binomial option for overdispersion),
 *     not from a simple expected-count threshold comparison.
 *   - Home/away expected shots blend a team's attack with the opponent's defence.
 *   - Total-shot expectation accounts for tempo/game-state correlation via a
 *     variance-inflated (Negative-Binomial) total distribution rather than
 *     blindly assuming independence.
 */

const { calculateMedian, poissonPmf, poissonCdf } = require('./footballHistoricalAnalysis');

/**
 * Baseline competition shot priors (global professional football averages).
 * Typical total shots ~ 24 per match (~13 home, ~11 away).
 */
const BASELINE_SHOT_PRIORS = {
  HOME_SHOTS: 13.0,
  AWAY_SHOTS: 11.0,
  TOTAL_SHOTS: 24.0,
  TOTAL_UNDER_21_5: 0.40,
  TOTAL_OVER_21_5: 0.60,
};

const DEFAULT_SHOT_LINES = {
  total: [19.5, 21.5, 23.5, 25.5, 27.5],
  home: [8.5, 10.5, 12.5],
  away: [8.5, 10.5, 12.5],
};

/**
 * Negative-Binomial PMF (alternative for overdispersed count data).
 * Uses mean (mu) and dispersion parameter r.
 * Var = mu + mu^2 / r.  As r -> infinity, converges to Poisson.
 */
function negBinomPmf(k, mu, r) {
  if (mu <= 0 || r <= 0) return k === 0 ? 1 : 0;
  const p = r / (r + mu);
  // P(X=k) = C(k+r-1, k) * (1-p)^k * p^r
  let logCoeff = 0;
  for (let i = 0; i < k; i++) {
    logCoeff += Math.log((r + i) / (i + 1));
  }
  return Math.exp(logCoeff + k * Math.log(1 - p) + r * Math.log(p));
}

function negBinomCdf(threshold, mu, r) {
  let p = 0;
  for (let k = 0; k <= threshold; k++) {
    p += negBinomPmf(k, mu, r);
  }
  return Math.min(Math.max(p, 0), 1);
}

/**
 * Compute over/under probabilities for a count distribution.
 *
 * @param {number} expected - expected count (lambda for Poisson, mu for NB)
 * @param {number} line - half-line threshold (e.g. 21.5)
 * @param {Object} [opts]
 * @param {number} [opts.dispersion] - if provided & finite, use Negative-Binomial
 * @returns {{ over: number, under: number }}
 */
function calculateShotsDistribution(expected, line, opts = {}) {
  const mu = Math.max(0, Number(expected) || 0);
  const kThreshold = Math.floor(line); // under L means <= floor(L) for half-lines
  const dispersion = opts.dispersion;

  let pUnder;
  if (dispersion != null && isFinite(dispersion) && dispersion > 0) {
    pUnder = negBinomCdf(kThreshold, mu, dispersion);
  } else {
    pUnder = poissonCdf(kThreshold, mu);
  }
  const pOver = Math.min(Math.max(1 - pUnder, 0), 1);
  return {
    over: Number(pOver.toFixed(6)),
    under: Number(Math.min(Math.max(pUnder, 0), 1).toFixed(6)),
  };
}

/**
 * Estimate the Negative-Binomial dispersion parameter r from a sample of counts
 * using the method of moments:  r = mu^2 / max(0, var - mu).
 * Returns null if the sample is too small or variance <= mean (Poisson-like).
 */
function estimateDispersion(counts) {
  const arr = Array.isArray(counts) ? counts.filter(v => typeof v === 'number' && !isNaN(v)) : [];
  if (arr.length < 3) return null;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  if (variance <= mean) return null; // no overdispersion -> Poisson
  const r = (mean * mean) / (variance - mean);
  return Number(r.toFixed(2));
}

/**
 * 1. Team History Analysis — Shots
 *
 * Analyzes last-N matches for shots taken, conceded, and totals.
 * Missing shot values are preserved as null and excluded from averages.
 *
 * @param {Array} matches - Clean historical matches for a team
 * @param {Object} options
 * @param {boolean} [options.isHomeContext] - Whether upcoming fixture is at home
 * @param {Array<number>} [options.lines] - Total-shot half-line thresholds
 * @returns {Object} Shots history analysis
 */
function analyzeShotsHistory(matches, { isHomeContext = null, lines = DEFAULT_SHOT_LINES.total } = {}) {
  const list = Array.isArray(matches) ? matches : [];
  const validMatches = list.filter(m => m && (typeof m.shots === 'number' || typeof m.totalShots === 'number'));

  if (validMatches.length === 0) {
    return {
      valid: false,
      sampleSize: 0,
      avgShots: null,
      medianShots: null,
      stdShots: null,
      varianceShots: null,
      minShots: null,
      maxShots: null,
      avgShotsConceded: null,
      avgTotalShots: null,
      medianTotalShots: null,
      shotsOnTargetRate: null,
      lineFrequencies: {},
      homeAwaySplit: null,
      last5: null,
      recentTrend: null,
      dispersion: null,
    };
  }

  const sampleSize = validMatches.length;
  const shotsArr = validMatches.filter(m => typeof m.shots === 'number').map(m => m.shots);
  const shotsConcededArr = validMatches.filter(m => typeof m.shotsConceded === 'number').map(m => m.shotsConceded);
  const totalShotsArr = validMatches.filter(m => typeof m.totalShots === 'number').map(m => m.totalShots);
  const shotsOnTargetArr = validMatches.filter(m => typeof m.shotsOnTarget === 'number' && typeof m.shots === 'number' && m.shots > 0);

  const mean = (arr) => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  const std = (arr, m) => arr.length > 1
    ? Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1))
    : 0;

  const avgShots = mean(shotsArr);
  const medianShots = calculateMedian(shotsArr);
  const stdShots = avgShots != null ? Number(std(shotsArr, avgShots).toFixed(2)) : null;
  const varianceShots = stdShots != null ? Number((stdShots * stdShots).toFixed(2)) : null;
  const minShots = shotsArr.length > 0 ? Math.min(...shotsArr) : null;
  const maxShots = shotsArr.length > 0 ? Math.max(...shotsArr) : null;

  const avgShotsConceded = mean(shotsConcededArr);
  const avgTotalShots = totalShotsArr.length > 0
    ? mean(totalShotsArr)
    : (avgShots != null && avgShotsConceded != null ? avgShots + avgShotsConceded : null);
  const medianTotalShots = calculateMedian(totalShotsArr);

  // Shots-on-target ratio (only where both shots and shotsOnTarget exist)
  let shotsOnTargetRate = null;
  if (shotsOnTargetArr.length > 0) {
    const sumSot = shotsOnTargetArr.reduce((s, m) => s + m.shotsOnTarget, 0);
    const sumShots = shotsOnTargetArr.reduce((s, m) => s + m.shots, 0);
    shotsOnTargetRate = sumShots > 0 ? Number((sumSot / sumShots).toFixed(4)) : null;
  }

  // Line frequencies (over/under for each configured total-shot line)
  const lineFrequencies = {};
  lines.forEach(line => {
    if (totalShotsArr.length > 0) {
      const underCount = totalShotsArr.filter(t => t < line).length;
      lineFrequencies[line] = {
        underRate: Number((underCount / totalShotsArr.length).toFixed(4)),
        overRate: Number((1 - underCount / totalShotsArr.length).toFixed(4)),
        underCount,
        overCount: totalShotsArr.length - underCount,
        sampleSize: totalShotsArr.length,
      };
    }
  });

  // Home / Away venue split
  const homeMatches = validMatches.filter(m => m.isHome === true);
  const awayMatches = validMatches.filter(m => m.isHome === false);

  const calcShotSplit = (subList) => {
    if (!subList || subList.length === 0) return null;
    const won = subList.filter(m => typeof m.shots === 'number').map(m => m.shots);
    const conc = subList.filter(m => typeof m.shotsConceded === 'number').map(m => m.shotsConceded);
    const tot = subList.filter(m => typeof m.totalShots === 'number').map(m => m.totalShots);
    return {
      sampleSize: subList.length,
      avgShots: won.length > 0 ? Number((won.reduce((s, v) => s + v, 0) / won.length).toFixed(2)) : null,
      avgShotsConceded: conc.length > 0 ? Number((conc.reduce((s, v) => s + v, 0) / conc.length).toFixed(2)) : null,
      avgTotalShots: tot.length > 0 ? Number((tot.reduce((s, v) => s + v, 0) / tot.length).toFixed(2)) : null,
    };
  };

  const homeSplit = calcShotSplit(homeMatches);
  const awaySplit = calcShotSplit(awayMatches);
  const relevantSplit = isHomeContext === true ? homeSplit : isHomeContext === false ? awaySplit : null;

  // Last-5 recency comparison
  const last5Arr = totalShotsArr.slice(0, 5);
  const last5 = last5Arr.length > 0
    ? { avgTotalShots: Number((last5Arr.reduce((s, v) => s + v, 0) / last5Arr.length).toFixed(2)), sampleSize: last5Arr.length }
    : null;

  let recentTrend = { direction: 'stable', diff: 0 };
  if (totalShotsArr.length >= 6) {
    const recent = totalShotsArr.slice(0, 3);
    const older = totalShotsArr.slice(3);
    const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
    const olderAvg = older.reduce((s, v) => s + v, 0) / older.length;
    const diff = recentAvg - olderAvg;
    recentTrend = {
      direction: diff > 3 ? 'more_shots' : diff < -3 ? 'fewer_shots' : 'stable',
      diff: Number(diff.toFixed(2)),
      recentAvg: Number(recentAvg.toFixed(2)),
      olderAvg: Number(olderAvg.toFixed(2)),
    };
  }

  // Estimate dispersion for the team's shots-taken distribution
  const dispersion = estimateDispersion(shotsArr);

  return {
    valid: true,
    sampleSize,
    avgShots: avgShots != null ? Number(avgShots.toFixed(2)) : null,
    medianShots,
    stdShots,
    varianceShots,
    minShots,
    maxShots,
    avgShotsConceded: avgShotsConceded != null ? Number(avgShotsConceded.toFixed(2)) : null,
    avgTotalShots: avgTotalShots != null ? Number(avgTotalShots.toFixed(2)) : null,
    medianTotalShots,
    shotsOnTargetRate,
    lineFrequencies,
    homeAwaySplit: { home: homeSplit, away: awaySplit, relevant: relevantSplit },
    last5,
    recentTrend,
    dispersion,
  };
}

/**
 * 2. Head-to-Head Shots Analysis
 *
 * Supporting evidence only (never the primary predictor).
 *
 * @param {Array} h2hMatches
 * @param {Array<number>} [lines]
 * @returns {Object}
 */
function analyzeH2HShotsHistory(h2hMatches, lines = DEFAULT_SHOT_LINES.total) {
  if (!Array.isArray(h2hMatches) || h2hMatches.length === 0) {
    return { valid: false, sampleSize: 0, avgTotalShots: null, lineFrequencies: {} };
  }
  const valid = h2hMatches.filter(m => {
    const tot = m.totalShots != null
      ? Number(m.totalShots)
      : (m.homeShots != null && m.awayShots != null
        ? Number(m.homeShots) + Number(m.awayShots)
        : (m.shots != null && m.shotsConceded != null
          ? Number(m.shots) + Number(m.shotsConceded)
          : NaN));
    return !isNaN(tot);
  });
  if (valid.length === 0) {
    return { valid: false, sampleSize: 0, avgTotalShots: null, lineFrequencies: {} };
  }
  const totalArr = valid.map(m => m.totalShots != null
    ? Number(m.totalShots)
    : (m.homeShots != null && m.awayShots != null
      ? Number(m.homeShots) + Number(m.awayShots)
      : Number(m.shots) + Number(m.shotsConceded)));
  const avgTotalShots = totalArr.reduce((s, v) => s + v, 0) / totalArr.length;

  const lineFrequencies = {};
  lines.forEach(line => {
    const underCount = totalArr.filter(t => t < line).length;
    lineFrequencies[line] = {
      underRate: Number((underCount / totalArr.length).toFixed(4)),
      overRate: Number((1 - underCount / totalArr.length).toFixed(4)),
      sampleSize: totalArr.length,
    };
  });

  return {
    valid: true,
    sampleSize: valid.length,
    avgTotalShots: Number(avgTotalShots.toFixed(2)),
    lineFrequencies,
  };
}

/**
 * 3. Football Shots Prediction Engine
 *
 * Blends:
 *   - Home attack (home shots taken) + Away defence (away shots conceded) -> lambda_home
 *   - Away attack (away shots taken) + Home defence (home shots conceded) -> lambda_away
 *   - Empirical-Bayes shrinkage toward competition baseline
 *   - H2H shot average (discount-weighted, supporting evidence)
 *   - Poisson CDF (or Negative-Binomial if overdispersion detected) for probabilities
 *
 * Total shots uses a variance-inflated distribution to account for
 * home/away shot correlation (tempo/game-state), not blind independence.
 *
 * @param {Object} params
 * @param {Object} params.homeAnalysis
 * @param {Object} params.awayAnalysis
 * @param {Object} [params.h2hAnalysis]
 * @param {Object} [params.lines]
 * @returns {Object|null}
 */
function calculateShotsPrediction({
  homeAnalysis,
  awayAnalysis,
  h2hAnalysis = null,
  lines = DEFAULT_SHOT_LINES,
}) {
  const homeValid = homeAnalysis?.valid && homeAnalysis.sampleSize >= 2;
  const awayValid = awayAnalysis?.valid && awayAnalysis.sampleSize >= 2;

  // Abstain when neither team has verified shot data (never fabricate!)
  if (!homeValid && !awayValid) {
    return null;
  }

  const factors = [];
  const compHomeBaseline = BASELINE_SHOT_PRIORS.HOME_SHOTS;
  const compAwayBaseline = BASELINE_SHOT_PRIORS.AWAY_SHOTS;

  // --- Home expected shots: home attack + away defence ---
  const hShots = homeAnalysis?.homeAwaySplit?.relevant?.avgShots ?? homeAnalysis?.avgShots ?? compHomeBaseline;
  const aShotsConc = awayAnalysis?.homeAwaySplit?.relevant?.avgShotsConceded ?? awayAnalysis?.avgShotsConceded ?? compHomeBaseline;
  const homeSample = homeAnalysis?.sampleSize || 0;
  const hShrinkage = Math.min(0.8, homeSample / (homeSample + 4));
  const rawLambdaHome = (hShots + aShotsConc) / 2;
  const lambdaHome = (rawLambdaHome * hShrinkage) + (compHomeBaseline * (1 - hShrinkage));

  // --- Away expected shots: away attack + home defence ---
  const aShots = awayAnalysis?.homeAwaySplit?.relevant?.avgShots ?? awayAnalysis?.avgShots ?? compAwayBaseline;
  const hShotsConc = homeAnalysis?.homeAwaySplit?.relevant?.avgShotsConceded ?? homeAnalysis?.avgShotsConceded ?? compAwayBaseline;
  const awaySample = awayAnalysis?.sampleSize || 0;
  const aShrinkage = Math.min(0.8, awaySample / (awaySample + 4));
  const rawLambdaAway = (aShots + hShotsConc) / 2;
  const lambdaAway = (rawLambdaAway * aShrinkage) + (compAwayBaseline * (1 - aShrinkage));

  let lambdaTotal = lambdaHome + lambdaAway;

  // --- H2H adjustment (supporting evidence, discount-weighted) ---
  let h2hWeight = 0;
  const h2hShots = h2hAnalysis?.shots ?? h2hAnalysis;
  if (h2hShots && h2hShots.sampleSize >= 2 && h2hShots.avgTotalShots != null) {
    h2hWeight = Math.min(0.20, h2hShots.sampleSize * 0.04);
    lambdaTotal = lambdaTotal * (1 - h2hWeight) + h2hShots.avgTotalShots * h2hWeight;
    factors.push({
      label: `H2H Avg Shots: ${h2hShots.avgTotalShots.toFixed(1)} (${h2hShots.sampleSize} matches)`,
      side: 'neutral',
      type: 'info',
    });
  }

  if (homeValid) {
    factors.push({
      label: `Home Shots: ${homeAnalysis.avgShots} taken, ${homeAnalysis.avgShotsConceded ?? 'N/A'} conceded`,
      side: 'home',
      type: 'info',
    });
  }
  if (awayValid) {
    factors.push({
      label: `Away Shots: ${awayAnalysis.avgShots} taken, ${awayAnalysis.avgShotsConceded ?? 'N/A'} conceded`,
      side: 'away',
      type: 'info',
    });
  }

  // --- Total-shot distribution with correlation/variance inflation ---
  // Home and away shots are positively correlated (tempo/game-state).
  // Rather than assuming independence (sum of two Poissons = Poisson),
  // we apply a Negative-Binomial inflation to the total to widen the
  // predictive distribution. The dispersion is estimated from each team's
  // shot history when available; otherwise a moderate inflation factor.
  const homeDisp = homeAnalysis?.dispersion;
  const awayDisp = awayAnalysis?.dispersion;
  const rawDispersions = [homeDisp, awayDisp].filter(d => d != null && d > 0);
  // Convert per-team dispersion (r) to an effective total dispersion.
  // For a NB(mu, r), var = mu + mu^2/r.  Sum variance with correlation rho:
  // Var(T) = Var(H) + Var(A) + 2*rho*sqrt(Var(H)*Var(A)).
  // We then back out an effective r_total from Var(T) and mu_total.
  const varHome = homeValid && homeDisp
    ? lambdaHome + (lambdaHome * lambdaHome) / homeDisp
    : lambdaHome;
  const varAway = awayValid && awayDisp
    ? lambdaAway + (lambdaAway * lambdaAway) / awayDisp
    : lambdaAway;
  const rho = 0.25; // moderate positive tempo correlation
  const varTotal = varHome + varAway + 2 * rho * Math.sqrt(varHome * varAway);
  const muTotal = lambdaTotal;
  let totalDispersion = null;
  if (varTotal > muTotal && muTotal > 0) {
    totalDispersion = Number(((muTotal * muTotal) / (varTotal - muTotal)).toFixed(2));
  }

  // --- Per-line probabilities for TOTAL shots ---
  const totalLineProbs = {};
  (lines.total || DEFAULT_SHOT_LINES.total).forEach(l => {
    const dist = calculateShotsDistribution(lambdaTotal, l, { dispersion: totalDispersion || undefined });
    totalLineProbs[l] = { line: l, over: dist.over, under: dist.under };
  });

  // --- Per-line probabilities for HOME shots ---
  const homeLineProbs = {};
  (lines.home || DEFAULT_SHOT_LINES.home).forEach(l => {
    const dist = calculateShotsDistribution(lambdaHome, l, { dispersion: homeDisp || undefined });
    homeLineProbs[l] = { line: l, over: dist.over, under: dist.under };
  });

  // --- Per-line probabilities for AWAY shots ---
  const awayLineProbs = {};
  (lines.away || DEFAULT_SHOT_LINES.away).forEach(l => {
    const dist = calculateShotsDistribution(lambdaAway, l, { dispersion: awayDisp || undefined });
    awayLineProbs[l] = { line: l, over: dist.over, under: dist.under };
  });

  // --- Select the strongest total-shot recommendation ---
  // Pick the line whose over/under probability is highest (most confident),
  // bounded away from 0.5.
  let bestTotal = null;
  Object.values(totalLineProbs).forEach(stat => {
    const maxP = Math.max(stat.over, stat.under);
    if (!bestTotal || maxP > Math.max(bestTotal.over, bestTotal.under)) {
      bestTotal = { ...stat, maxP, side: stat.over >= stat.under ? 'over' : 'under' };
    }
  });

  // Empirical under-rate blending (from team line frequencies)
  const chosenLine = bestTotal ? bestTotal.line : (lines.total || DEFAULT_SHOT_LINES.total)[2];
  const hFreq = homeAnalysis?.lineFrequencies?.[chosenLine];
  const aFreq = awayAnalysis?.lineFrequencies?.[chosenLine];
  let empiricalUnderRate = null;
  if (hFreq && aFreq) empiricalUnderRate = (hFreq.underRate + aFreq.underRate) / 2;
  else if (hFreq) empiricalUnderRate = hFreq.underRate;
  else if (aFreq) empiricalUnderRate = aFreq.underRate;

  const rawOver = bestTotal ? bestTotal.over : 0.5;
  const rawUnder = bestTotal ? bestTotal.under : 0.5;
  const side = bestTotal ? bestTotal.side : 'over';
  let prob = side === 'over' ? rawOver : rawUnder;
  if (empiricalUnderRate !== null) {
    const empTarget = side === 'over' ? (1 - empiricalUnderRate) : empiricalUnderRate;
    prob = 0.55 * prob + 0.45 * empTarget;
  }
  const calibratedProb = Math.min(Math.max(prob, 0.30), 0.95);
  const confidence = Math.round(calibratedProb * 100);

  factors.push({
    label: `Expected Shots: ${lambdaTotal.toFixed(1)} (Home: ${lambdaHome.toFixed(1)}, Away: ${lambdaAway.toFixed(1)})`,
    side: 'neutral',
    type: 'success',
  });

  const market = `total_shots_${side}_${String(chosenLine).replace('.', '_')}`;
  const label = `${side === 'over' ? 'Over' : 'Under'} ${chosenLine} Total Shots`;
  const value = `${side === 'over' ? 'Over' : 'Under'} ${chosenLine} Total Match Shots`;

  return {
    market,
    label,
    value,
    line: chosenLine,
    marketType: side,
    category: 'shots',
    confidence,
    probability: Number(calibratedProb.toFixed(4)),
    complementaryProbability: Number((1 - calibratedProb).toFixed(4)),
    expectedTotalShots: Number(lambdaTotal.toFixed(2)),
    expectedHomeShots: Number(lambdaHome.toFixed(2)),
    expectedAwayShots: Number(lambdaAway.toFixed(2)),
    totalLineProbabilities: totalLineProbs,
    homeLineProbabilities: homeLineProbs,
    awayLineProbabilities: awayLineProbs,
    totalDispersion,
    homeDispersion: homeDisp,
    awayDispersion: awayDisp,
    factors,
    color: confidence >= 70 ? '#40c057' : confidence >= 60 ? '#ffa94d' : '#4dabf7',
    dataQuality: {
      homeSampleSize: homeSample,
      awaySampleSize: awaySample,
      h2hSampleSize: h2hShots?.sampleSize || 0,
      homeValid,
      awayValid,
    },
  };
}

/**
 * Settle a shots market.
 *
 * @param {'total'|'home'|'away'} scope
 * @param {'over'|'under'} side
 * @param {number} line
 * @param {Object} stats - { totalShots, homeShots, awayShots }
 * @returns {'won'|'lost'|null}
 */
function settleShots(scope, side, line, stats) {
  if (!stats || line == null) return null;
  let value = null;
  if (scope === 'total') value = stats.totalShots;
  else if (scope === 'home') value = stats.homeShots;
  else if (scope === 'away') value = stats.awayShots;
  if (value == null || isNaN(Number(value))) return null;
  const v = Number(value);
  if (side === 'over') return v > line ? 'won' : 'lost';
  return v < line ? 'won' : 'lost';
}

module.exports = {
  BASELINE_SHOT_PRIORS,
  DEFAULT_SHOT_LINES,
  poissonPmf,
  poissonCdf,
  negBinomPmf,
  negBinomCdf,
  calculateShotsDistribution,
  estimateDispersion,
  analyzeShotsHistory,
  analyzeH2HShotsHistory,
  calculateShotsPrediction,
  settleShots,
};
