/**
 * footballHistoricalAnalysis.js
 *
 * Dedicated football statistical analysis and probability estimation engine for:
 *   1. Under 4.5 Goals (Full-Time total goals <= 4)
 *   2. Under 2.5 HT (First-Half total goals <= 2)
 *
 * Principles:
 *   - Only completed matches before kickoff are used (no future-data leakage).
 *   - Half-time scores are only used when verified (never estimated from FT goals).
 *   - Missing statistics remain explicitly null (never defaulted to zero).
 *   - Rigorous empirical Bayesian shrinkage + Poisson expectancy model.
 *   - Independent calculations for Under 4.5 FT and Under 2.5 HT.
 *   - Chronological backtesting with Brier score, log loss, and calibration.
 */

const BASELINE_PRIORS = {
  UNDER_4_5_GOALS: 0.85, // ~85% of matches in global professional soccer finish <= 4 goals
  UNDER_2_5_HT: 0.90,    // ~90% of first halves finish <= 2 goals
};

/**
 * Factorial helper
 */
function factorial(n) {
  if (n <= 1) return 1;
  let res = 1;
  for (let i = 2; i <= n; i++) res *= i;
  return res;
}

/**
 * Poisson PMF
 */
function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

/**
 * Poisson CDF P(X <= threshold)
 */
function poissonCdf(threshold, lambda) {
  let p = 0;
  for (let k = 0; k <= threshold; k++) {
    p += poissonPmf(k, lambda);
  }
  return Math.min(Math.max(p, 0), 1);
}

/**
 * 1. Filter, validate, and deduplicate historical matches
 *
 * Excludes:
 *   - Matches occurring after or at kickoffDate (leakage prevention)
 *   - Postponed, abandoned, canceled, incomplete matches
 *   - Invalid or missing full-time scores
 *   - Duplicate matches by ID or (date + homeId + awayId)
 *
 * @param {Array} matches
 * @param {Object} options
 * @param {string|number|Date} [options.kickoffDate]
 * @returns {Array} Clean historical matches sorted newest first
 */
function validateAndFilterHistoricalMatches(matches, { kickoffDate = null } = {}) {
  if (!Array.isArray(matches)) return [];

  const cutoffTs = kickoffDate ? new Date(kickoffDate).getTime() : null;
  const seenIds = new Set();
  const seenSignatures = new Set();
  const valid = [];

  for (const m of matches) {
    if (!m) continue;

    // Check completion status
    const status = String(m.status || m.state || '').toLowerCase();
    const isCompleted =
      status === 'post' ||
      status === 'finished' ||
      status === 'ft' ||
      m.completed === true;

    if (!isCompleted && status !== '') {
      // If status is present and not finished/post, reject (e.g. postponed, canceled, in-progress)
      if (['pre', 'scheduled', 'postponed', 'canceled', 'cancelled', 'abandoned', 'delayed', 'in'].includes(status)) {
        continue;
      }
    }

    // Check date cutoff (strictly before kickoff)
    if (cutoffTs && m.date) {
      const matchTs = new Date(m.date).getTime();
      if (!isNaN(matchTs) && matchTs >= cutoffTs) {
        continue; // Future match relative to kickoff -> skip to prevent leakage
      }
    }

    // Full-time scores must be valid numbers (can be 0)
    const pf = m.pf !== undefined && m.pf !== null ? Number(m.pf) : NaN;
    const pa = m.pa !== undefined && m.pa !== null ? Number(m.pa) : NaN;
    if (isNaN(pf) || isNaN(pa) || pf < 0 || pa < 0) {
      continue; // Invalid full-time score
    }

    // Deduplication
    const id = m.id ? String(m.id) : null;
    if (id && seenIds.has(id)) continue;
    if (id) seenIds.add(id);

    const sig = `${m.date ? String(m.date).slice(0, 10) : ''}-${m.isHome ? 'H' : 'A'}-${m.opponentId || ''}-${pf}-${pa}`;
    if (seenSignatures.has(sig)) continue;
    seenSignatures.add(sig);

    valid.push({
      ...m,
      pf,
      pa,
      totalGoals: pf + pa,
      date: m.date ? new Date(m.date).toISOString() : null,
      timestamp: m.date ? new Date(m.date).getTime() : 0,
    });
  }

  // Sort descending by date (most recent first)
  valid.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return valid;
}

/**
 * 2. Team History Analysis — Under 4.5 Goals
 *
 * Full-time match analysis for combined goals <= 4 (Under 4.5)
 *
 * @param {Array} matches - Clean historical matches for a team
 * @param {Object} options
 * @param {boolean} [options.isHomeContext] - Whether upcoming fixture is at home for this team
 * @returns {Object} Under 4.5 metrics
 */
function analyzeUnder45History(matches, { isHomeContext = null } = {}) {
  const totalMatches = matches ? matches.length : 0;
  if (totalMatches === 0) {
    return {
      valid: false,
      sampleSize: 0,
      under45HitRate: null,
      over45Frequency: null,
      avgTotalGoals: null,
      avgGoalsScored: null,
      avgGoalsConceded: null,
      recentTrend: null,
      homeAwaySplit: null,
      scorelineDistribution: {},
    };
  }

  let under45Count = 0;
  let over45Count = 0;
  let totalGoalsSum = 0;
  let scoredSum = 0;
  let concededSum = 0;
  const scorelineDistribution = {};

  let validScoredCount = 0;
  matches.forEach((m) => {
    const pf = m.pf !== undefined && m.pf !== null ? Number(m.pf) : NaN;
    const pa = m.pa !== undefined && m.pa !== null ? Number(m.pa) : NaN;
    const tot = m.totalGoals !== undefined && !isNaN(Number(m.totalGoals))
      ? Number(m.totalGoals)
      : (!isNaN(pf) && !isNaN(pa) ? pf + pa : NaN);

    if (isNaN(tot) || isNaN(pf) || isNaN(pa)) return;

    validScoredCount++;
    totalGoalsSum += tot;
    scoredSum += pf;
    concededSum += pa;

    if (tot <= 4) {
      under45Count++;
    } else {
      over45Count++;
    }

    // Scoreline distribution (from team's perspective pf-pa)
    const scoreKey = tot >= 5 ? '5+' : `${pf}-${pa}`;
    scorelineDistribution[scoreKey] = (scorelineDistribution[scoreKey] || 0) + 1;
  });

  const evaluatedMatches = validScoredCount || totalMatches;
  const under45HitRate = evaluatedMatches > 0 ? under45Count / evaluatedMatches : 0;
  const over45Frequency = evaluatedMatches > 0 ? over45Count / evaluatedMatches : 0;
  const avgTotalGoals = evaluatedMatches > 0 ? totalGoalsSum / evaluatedMatches : 0;
  const avgGoalsScored = evaluatedMatches > 0 ? scoredSum / evaluatedMatches : 0;
  const avgGoalsConceded = evaluatedMatches > 0 ? concededSum / evaluatedMatches : 0;

  // Recent goal trend: compare last 3 matches vs older matches
  let recentTrend = { direction: 'stable', diff: 0, last3Avg: null };
  if (totalMatches >= 4) {
    const last3 = matches.slice(0, 3);
    const older = matches.slice(3);
    const last3Avg = last3.reduce((s, m) => s + m.totalGoals, 0) / 3;
    const olderAvg = older.reduce((s, m) => s + m.totalGoals, 0) / older.length;
    const diff = last3Avg - olderAvg;
    recentTrend = {
      direction: diff > 0.6 ? 'more_goals' : diff < -0.6 ? 'fewer_goals' : 'stable',
      diff: Number(diff.toFixed(2)),
      last3Avg: Number(last3Avg.toFixed(2)),
      olderAvg: Number(olderAvg.toFixed(2)),
    };
  }

  // Home/away split
  const homeMatches = matches.filter((m) => m.isHome === true);
  const awayMatches = matches.filter((m) => m.isHome === false);

  const calcSplit = (subList) => {
    if (!subList || subList.length === 0) return null;
    const u45 = subList.filter((m) => m.totalGoals <= 4).length;
    const totGoals = subList.reduce((s, m) => s + m.totalGoals, 0);
    return {
      sampleSize: subList.length,
      under45HitRate: u45 / subList.length,
      avgTotalGoals: totGoals / subList.length,
      avgGoalsScored: subList.reduce((s, m) => s + m.pf, 0) / subList.length,
      avgGoalsConceded: subList.reduce((s, m) => s + m.pa, 0) / subList.length,
    };
  };

  const homeSplit = calcSplit(homeMatches);
  const awaySplit = calcSplit(awayMatches);
  const relevantSplit = isHomeContext === true ? homeSplit : isHomeContext === false ? awaySplit : null;

  return {
    valid: true,
    sampleSize: totalMatches,
    under45Count,
    over45Count,
    under45HitRate: Number(under45HitRate.toFixed(4)),
    over45Frequency: Number(over45Frequency.toFixed(4)),
    avgTotalGoals: Number(avgTotalGoals.toFixed(2)),
    avgGoalsScored: Number(avgGoalsScored.toFixed(2)),
    avgGoalsConceded: Number(avgGoalsConceded.toFixed(2)),
    recentTrend,
    homeAwaySplit: {
      home: homeSplit,
      away: awaySplit,
      relevant: relevantSplit,
    },
    scorelineDistribution,
  };
}

/**
 * 3. Team History Analysis — Under 2.5 HT
 *
 * Uses ONLY verified half-time scores. Never estimates from FT goals.
 *
 * @param {Array} matches - Clean historical matches for a team
 * @param {Object} options
 * @param {boolean} [options.isHomeContext] - Whether upcoming fixture is at home
 * @returns {Object} Under 2.5 HT metrics
 */
function analyzeUnder25HtHistory(matches, { isHomeContext = null } = {}) {
  if (!Array.isArray(matches) || matches.length === 0) {
    return {
      valid: false,
      sampleSize: 0,
      reason: 'no_matches_provided',
      under25HtHitRate: null,
    };
  }

  // Filter ONLY matches that contain verified half-time scores
  const verifiedHtMatches = matches.filter((m) => {
    if (!m.htScore) return false;
    const team = m.htScore.team !== undefined
      ? Number(m.htScore.team)
      : (m.htScore.home !== undefined ? (m.isHome === false ? Number(m.htScore.away) : Number(m.htScore.home)) : NaN);
    const opp = m.htScore.opp !== undefined
      ? Number(m.htScore.opp)
      : (m.htScore.away !== undefined ? (m.isHome === false ? Number(m.htScore.home) : Number(m.htScore.away)) : NaN);
    const tot = m.htScore.total !== undefined
      ? Number(m.htScore.total)
      : (!isNaN(team) && !isNaN(opp) ? team + opp : NaN);
    return !isNaN(tot) && !isNaN(team) && !isNaN(opp) && tot >= 0;
  });

  const sampleSize = verifiedHtMatches.length;
  if (sampleSize === 0) {
    return {
      valid: false,
      sampleSize: 0,
      reason: 'no_verified_ht_scores',
      under25HtHitRate: null,
      over25HtFrequency: null,
      avgHtTotalGoals: null,
      avgHtScored: null,
      avgHtConceded: null,
      htScorelineDistribution: {},
      earlyGoalAnalysis: null,
      firstHalfVsSecondHalf: null,
      homeAwaySplit: null,
      recentTrend: null,
    };
  }

  let under25Count = 0;
  let over25Count = 0;
  let totalHtGoalsSum = 0;
  let htScoredSum = 0;
  let htConcededSum = 0;
  const htScorelineDistribution = {};

  // Early goal tracking (first 15 and 30 mins)
  let matchesWithTimestamps = 0;
  let earlyGoal15Count = 0;
  let earlyGoal30Count = 0;

  // 1st vs 2nd half tracking
  let totalFtGoalsSum = 0;

  verifiedHtMatches.forEach((m) => {
    const htTeam = m.htScore.team !== undefined
      ? Number(m.htScore.team)
      : (m.htScore.home !== undefined ? (m.isHome === false ? Number(m.htScore.away) : Number(m.htScore.home)) : 0);
    const htOpp = m.htScore.opp !== undefined
      ? Number(m.htScore.opp)
      : (m.htScore.away !== undefined ? (m.isHome === false ? Number(m.htScore.home) : Number(m.htScore.away)) : 0);
    const htTot = m.htScore.total !== undefined
      ? Number(m.htScore.total)
      : (htTeam + htOpp);

    totalHtGoalsSum += htTot;
    htScoredSum += htTeam;
    htConcededSum += htOpp;
    totalFtGoalsSum += m.totalGoals || 0;

    if (htTot <= 2) {
      under25Count++;
    } else {
      over25Count++;
    }

    const key = htTot >= 3 ? '3+' : `${htTeam}-${htOpp}`;
    htScorelineDistribution[key] = (htScorelineDistribution[key] || 0) + 1;

    // Check goal minutes
    if (Array.isArray(m.goalMinutes) && m.goalMinutes.length > 0) {
      matchesWithTimestamps++;
      // Goal minutes can be in seconds (e.g. 1832s = ~30.5m) or minutes (1..90)
      const minutes = m.goalMinutes.map((val) => (val > 120 ? Math.floor(val / 60) : val));
      if (minutes.some((min) => min <= 15)) earlyGoal15Count++;
      if (minutes.some((min) => min <= 30)) earlyGoal30Count++;
    }
  });

  const under25HtHitRate = under25Count / sampleSize;
  const over25HtFrequency = over25Count / sampleSize;
  const avgHtTotalGoals = totalHtGoalsSum / sampleSize;
  const avgHtScored = htScoredSum / sampleSize;
  const avgHtConceded = htConcededSum / sampleSize;

  // Early goal frequency
  let earlyGoalAnalysis = null;
  if (matchesWithTimestamps > 0) {
    earlyGoalAnalysis = {
      evaluatedMatches: matchesWithTimestamps,
      goalInFirst15MinRate: Number((earlyGoal15Count / matchesWithTimestamps).toFixed(4)),
      goalInFirst30MinRate: Number((earlyGoal30Count / matchesWithTimestamps).toFixed(4)),
    };
  }

  // First half vs second half pattern
  const avgFtGoals = totalFtGoalsSum / sampleSize;
  const avgSecondHalfGoals = Math.max(0, avgFtGoals - avgHtTotalGoals);
  const firstHalfRatio = avgFtGoals > 0 ? avgHtTotalGoals / avgFtGoals : 0.40;
  const firstHalfVsSecondHalf = {
    avgFirstHalfGoals: Number(avgHtTotalGoals.toFixed(2)),
    avgSecondHalfGoals: Number(avgSecondHalfGoals.toFixed(2)),
    firstHalfRatio: Number(firstHalfRatio.toFixed(3)),
    tendency: firstHalfRatio > 0.5 ? 'early_heavy' : firstHalfRatio < 0.4 ? 'late_heavy' : 'balanced',
  };

  // Home/away split for HT
  const homeHtMatches = verifiedHtMatches.filter((m) => m.isHome === true);
  const awayHtMatches = verifiedHtMatches.filter((m) => m.isHome === false);

  const calcHtSplit = (subList) => {
    if (!subList || subList.length === 0) return null;
    const u25 = subList.filter((m) => m.htScore.total <= 2).length;
    const totHt = subList.reduce((s, m) => s + m.htScore.total, 0);
    return {
      sampleSize: subList.length,
      under25HtHitRate: u25 / subList.length,
      avgHtTotalGoals: totHt / subList.length,
      avgHtScored: subList.reduce((s, m) => s + m.htScore.team, 0) / subList.length,
      avgHtConceded: subList.reduce((s, m) => s + m.htScore.opp, 0) / subList.length,
    };
  };

  const homeHtSplit = calcHtSplit(homeHtMatches);
  const awayHtSplit = calcHtSplit(awayHtMatches);
  const relevantHtSplit = isHomeContext === true ? homeHtSplit : isHomeContext === false ? awayHtSplit : null;

  // Recent HT trend
  let recentTrend = { direction: 'stable', diff: 0 };
  if (sampleSize >= 4) {
    const last3 = verifiedHtMatches.slice(0, 3);
    const older = verifiedHtMatches.slice(3);
    const last3HtAvg = last3.reduce((s, m) => s + m.htScore.total, 0) / 3;
    const olderHtAvg = older.reduce((s, m) => s + m.htScore.total, 0) / older.length;
    const diff = last3HtAvg - olderHtAvg;
    recentTrend = {
      direction: diff > 0.4 ? 'higher_ht_scoring' : diff < -0.4 ? 'lower_ht_scoring' : 'stable',
      diff: Number(diff.toFixed(2)),
      last3HtAvg: Number(last3HtAvg.toFixed(2)),
    };
  }

  return {
    valid: true,
    sampleSize,
    under25Count,
    over25Count,
    under25HtHitRate: Number(under25HtHitRate.toFixed(4)),
    over25HtFrequency: Number(over25HtFrequency.toFixed(4)),
    avgHtTotalGoals: Number(avgHtTotalGoals.toFixed(2)),
    avgHtScored: Number(avgHtScored.toFixed(2)),
    avgHtConceded: Number(avgHtConceded.toFixed(2)),
    htScorelineDistribution,
    earlyGoalAnalysis,
    firstHalfVsSecondHalf,
    homeAwaySplit: {
      home: homeHtSplit,
      away: awayHtSplit,
      relevant: relevantHtSplit,
    },
    recentTrend,
  };
}

/**
 * 4. Head-to-Head (H2H) Analysis
 *
 * Separates full-time Under 4.5 and half-time Under 2.5 HT evidence.
 *
 * @param {Array} h2hMatches - Previous meetings between the two teams
 * @returns {Object} H2H analysis
 */
function analyzeH2HHistory(h2hMatches) {
  if (!Array.isArray(h2hMatches) || h2hMatches.length === 0) {
    return {
      valid: false,
      sampleSize: 0,
      under45: null,
      under25Ht: null,
    };
  }

  // --- Full-time H2H ---
  const validFT = h2hMatches.filter((m) => {
    const pf = m.homeTeamScore !== undefined ? Number(m.homeTeamScore) : m.pf !== undefined ? Number(m.pf) : NaN;
    const pa = m.awayTeamScore !== undefined ? Number(m.awayTeamScore) : m.pa !== undefined ? Number(m.pa) : NaN;
    return !isNaN(pf) && !isNaN(pa);
  });

  let u45 = null;
  if (validFT.length > 0) {
    let u45Count = 0;
    let totGoals = 0;
    validFT.forEach((m) => {
      const hScore = Number(m.homeTeamScore ?? m.pf);
      const aScore = Number(m.awayTeamScore ?? m.pa);
      const sum = hScore + aScore;
      totGoals += sum;
      if (sum <= 4) u45Count++;
    });
    u45 = {
      sampleSize: validFT.length,
      under45Count: u45Count,
      over45Count: validFT.length - u45Count,
      under45Rate: Number((u45Count / validFT.length).toFixed(4)),
      over45Rate: Number(((validFT.length - u45Count) / validFT.length).toFixed(4)),
      avgGoals: Number((totGoals / validFT.length).toFixed(2)),
    };
  }

  // --- Half-time H2H (only verified) ---
  const validHT = h2hMatches.filter((m) => {
    return m.htScore && typeof m.htScore.total === 'number' && !isNaN(m.htScore.total);
  });

  let u25Ht = null;
  if (validHT.length > 0) {
    let u25Count = 0;
    let totHtGoals = 0;
    const scorelines = {};
    validHT.forEach((m) => {
      const tot = m.htScore.total;
      totHtGoals += tot;
      if (tot <= 2) u25Count++;
      const key = tot >= 3 ? '3+' : `${m.htScore.home ?? 0}-${m.htScore.away ?? 0}`;
      scorelines[key] = (scorelines[key] || 0) + 1;
    });
    u25Ht = {
      sampleSize: validHT.length,
      under25Count: u25Count,
      over25Count: validHT.length - u25Count,
      under25HtRate: Number((u25Count / validHT.length).toFixed(4)),
      over25HtRate: Number(((validHT.length - u25Count) / validHT.length).toFixed(4)),
      avgHtGoals: Number((totHtGoals / validHT.length).toFixed(2)),
      scorelineDistribution: scorelines,
    };
  }

  return {
    valid: validFT.length > 0 || validHT.length > 0,
    sampleSize: validFT.length,
    under45: u45,
    under25Ht: u25Ht,
  };
}

/**
 * 5. Probability Estimation for Under 4.5 Goals
 *
 * Combines:
 *   - Empirical Bayesian shrinkage on home/away team hit rates
 *   - Home-at-home and away-at-away splits
 *   - Poisson expectation model on expected goals
 *   - H2H evidence with sample-size discounting
 *
 * @param {Object} params
 * @param {Object} params.homeAnalysis
 * @param {Object} params.awayAnalysis
 * @param {Object} [params.h2hAnalysis]
 * @param {number} [params.baselinePrior=0.85]
 * @returns {Object} Prediction object or null
 */
function calculateUnder45Prediction({
  homeAnalysis,
  awayAnalysis,
  h2hAnalysis = null,
  baselinePrior = BASELINE_PRIORS.UNDER_4_5_GOALS,
}) {
  if (!homeAnalysis?.valid && !awayAnalysis?.valid) {
    return null;
  }

  const factors = [];
  const M = 4; // Empirical prior weight (shrinkage parameter)

  // 1. Empirical Bayesian smoothed rates
  const smoothRate = (analysis) => {
    if (!analysis || !analysis.valid || analysis.sampleSize === 0) return baselinePrior;
    return (analysis.under45Count + M * baselinePrior) / (analysis.sampleSize + M);
  };

  const homeSmoothed = smoothRate(homeAnalysis);
  const awaySmoothed = smoothRate(awayAnalysis);

  // Relevant splits
  let homeSplitSmoothed = homeSmoothed;
  if (homeAnalysis?.homeAwaySplit?.relevant?.sampleSize >= 3) {
    const split = homeAnalysis.homeAwaySplit.relevant;
    const splitCount = split.under45HitRate * split.sampleSize;
    homeSplitSmoothed = (splitCount + M * baselinePrior) / (split.sampleSize + M);
  }

  let awaySplitSmoothed = awaySmoothed;
  if (awayAnalysis?.homeAwaySplit?.relevant?.sampleSize >= 3) {
    const split = awayAnalysis.homeAwaySplit.relevant;
    const splitCount = split.under45HitRate * split.sampleSize;
    awaySplitSmoothed = (splitCount + M * baselinePrior) / (split.sampleSize + M);
  }

  // Blended empirical rate (60% overall, 40% split if available)
  const homeRate = 0.6 * homeSmoothed + 0.4 * homeSplitSmoothed;
  const awayRate = 0.6 * awaySmoothed + 0.4 * awaySplitSmoothed;
  let empiricalProb = (homeRate + awayRate) / 2;

  if (homeAnalysis?.valid) {
    factors.push({
      label: `Home U4.5: ${Math.round(homeAnalysis.under45HitRate * 100)}% (${homeAnalysis.under45Count}/${homeAnalysis.sampleSize})`,
      side: 'home',
      type: homeAnalysis.under45HitRate >= 0.8 ? 'success' : 'warning',
    });
  }
  if (awayAnalysis?.valid) {
    factors.push({
      label: `Away U4.5: ${Math.round(awayAnalysis.under45HitRate * 100)}% (${awayAnalysis.under45Count}/${awayAnalysis.sampleSize})`,
      side: 'away',
      type: awayAnalysis.under45HitRate >= 0.8 ? 'success' : 'warning',
    });
  }

  // 2. Poisson expected goals model
  const hScored = homeAnalysis?.avgGoalsScored || 1.3;
  const aConceded = awayAnalysis?.avgGoalsConceded || 1.3;
  const aScored = awayAnalysis?.avgGoalsScored || 1.1;
  const hConceded = homeAnalysis?.avgGoalsConceded || 1.1;

  let expHomeGoals = (hScored + aConceded) / 2;
  let expAwayGoals = (aScored + hConceded) / 2;
  let totalExpGoals = expHomeGoals + expAwayGoals;

  // H2H adjustment to expected goals & probability
  let h2hWeight = 0;
  let h2hProb = baselinePrior;
  if (h2hAnalysis?.under45 && h2hAnalysis.under45.sampleSize >= 2) {
    const h2h = h2hAnalysis.under45;
    // Discount based on sample size: max 20% weight if >= 5 meetings
    h2hWeight = Math.min(0.20, h2h.sampleSize * 0.04);
    h2hProb = (h2h.under45Count + 2 * baselinePrior) / (h2h.sampleSize + 2);
    totalExpGoals = totalExpGoals * (1 - h2hWeight) + h2h.avgGoals * h2hWeight;

    factors.push({
      label: `H2H U4.5: ${Math.round(h2h.under45Rate * 100)}% (${h2h.under45Count}/${h2h.sampleSize})`,
      side: 'neutral',
      type: h2h.under45Rate >= 0.8 ? 'success' : 'info',
    });
  }

  const poissonProb = poissonCdf(4, totalExpGoals);

  // 3. Blend empirical and Poisson
  // Weights: 50% empirical, 35% Poisson, 15% H2H (or adjusted)
  const wEmp = 0.55 - (h2hWeight / 2);
  const wPoi = 0.45 - (h2hWeight / 2);
  const finalProb = (wEmp * empiricalProb) + (wPoi * poissonProb) + (h2hWeight * h2hProb);

  // Recent goal trend impact
  let trendAdjustment = 0;
  if (homeAnalysis?.recentTrend?.direction === 'more_goals' || awayAnalysis?.recentTrend?.direction === 'more_goals') {
    trendAdjustment -= 0.03;
  } else if (homeAnalysis?.recentTrend?.direction === 'fewer_goals' && awayAnalysis?.recentTrend?.direction === 'fewer_goals') {
    trendAdjustment += 0.03;
  }

  const calibratedProb = Math.min(Math.max(finalProb + trendAdjustment, 0.30), 0.96);
  const confidence = Math.round(calibratedProb * 100);

  if (confidence < 50) return null;

  return {
    market: 'under_4_5_goals',
    label: 'Under 4.5 Goals',
    value: 'Under 4.5 Full-Time Goals',
    confidence,
    probability: Number(calibratedProb.toFixed(4)),
    color: confidence >= 70 ? '#40c057' : confidence >= 60 ? '#ffa94d' : '#4dabf7',
    factors,
    expectedGoals: Number(totalExpGoals.toFixed(2)),
  };
}

/**
 * 6. Probability Estimation for Under 2.5 HT
 *
 * Uses ONLY verified half-time scores. Never estimates from FT goals.
 *
 * @param {Object} params
 * @param {Object} params.homeHtAnalysis
 * @param {Object} params.awayHtAnalysis
 * @param {Object} [params.h2hAnalysis]
 * @param {number} [params.baselinePrior=0.90]
 * @returns {Object} Prediction object or null
 */
function calculateUnder25HtPrediction({
  homeHtAnalysis,
  awayHtAnalysis,
  h2hAnalysis = null,
  baselinePrior = BASELINE_PRIORS.UNDER_2_5_HT,
}) {
  // If NO verified HT scores exist for both teams, do NOT fabricate data!
  const homeValid = homeHtAnalysis && homeHtAnalysis.valid && homeHtAnalysis.sampleSize > 0;
  const awayValid = awayHtAnalysis && awayHtAnalysis.valid && awayHtAnalysis.sampleSize > 0;

  if (!homeValid && !awayValid) {
    return null; // Explicitly unavailable
  }

  const factors = [];
  const M = 3; // Prior weight

  const smoothHtRate = (analysis) => {
    if (!analysis || !analysis.valid || analysis.sampleSize === 0) return baselinePrior;
    return (analysis.under25Count + M * baselinePrior) / (analysis.sampleSize + M);
  };

  const homeHtRate = smoothHtRate(homeHtAnalysis);
  const awayHtRate = smoothHtRate(awayHtAnalysis);

  // Home/away split for HT
  let homeSplitRate = homeHtRate;
  if (homeHtAnalysis?.homeAwaySplit?.relevant?.sampleSize >= 2) {
    const sp = homeHtAnalysis.homeAwaySplit.relevant;
    homeSplitRate = (sp.under25HtHitRate * sp.sampleSize + M * baselinePrior) / (sp.sampleSize + M);
  }

  let awaySplitRate = awayHtRate;
  if (awayHtAnalysis?.homeAwaySplit?.relevant?.sampleSize >= 2) {
    const sp = awayHtAnalysis.homeAwaySplit.relevant;
    awaySplitRate = (sp.under25HtHitRate * sp.sampleSize + M * baselinePrior) / (sp.sampleSize + M);
  }

  const empiricalProb = ((0.6 * homeHtRate + 0.4 * homeSplitRate) + (0.6 * awayHtRate + 0.4 * awaySplitRate)) / 2;

  if (homeValid) {
    factors.push({
      label: `Home 1st Half U2.5: ${Math.round(homeHtAnalysis.under25HtHitRate * 100)}% (${homeHtAnalysis.under25Count}/${homeHtAnalysis.sampleSize})`,
      side: 'home',
      type: homeHtAnalysis.under25HtHitRate >= 0.85 ? 'success' : 'info',
    });
  }
  if (awayValid) {
    factors.push({
      label: `Away 1st Half U2.5: ${Math.round(awayHtAnalysis.under25HtHitRate * 100)}% (${awayHtAnalysis.under25Count}/${awayHtAnalysis.sampleSize})`,
      side: 'away',
      type: awayHtAnalysis.under25HtHitRate >= 0.85 ? 'success' : 'info',
    });
  }

  // First-half Poisson expectancy from verified HT scoring averages
  const hHtScored = homeValid ? homeHtAnalysis.avgHtScored : 0.6;
  const aHtConceded = awayValid ? awayHtAnalysis.avgHtConceded : 0.6;
  const aHtScored = awayValid ? awayHtAnalysis.avgHtScored : 0.5;
  const hHtConceded = homeValid ? homeHtAnalysis.avgHtConceded : 0.5;

  let lambdaHt = (hHtScored + aHtConceded + aHtScored + hHtConceded) / 2;

  // H2H HT evidence
  let h2hWeight = 0;
  let h2hProb = baselinePrior;
  if (h2hAnalysis?.under25Ht && h2hAnalysis.under25Ht.sampleSize >= 2) {
    const h2hHt = h2hAnalysis.under25Ht;
    h2hWeight = Math.min(0.20, h2hHt.sampleSize * 0.05);
    h2hProb = (h2hHt.under25Count + 2 * baselinePrior) / (h2hHt.sampleSize + 2);
    lambdaHt = lambdaHt * (1 - h2hWeight) + h2hHt.avgHtGoals * h2hWeight;

    factors.push({
      label: `H2H 1st Half U2.5: ${Math.round(h2hHt.under25HtRate * 100)}% (${h2hHt.under25Count}/${h2hHt.sampleSize})`,
      side: 'neutral',
      type: h2hHt.under25HtRate >= 0.85 ? 'success' : 'info',
    });
  }

  const poissonProb = poissonCdf(2, lambdaHt);

  // Early goal penalty if teams frequently score in first 15 mins
  let earlyPenalty = 0;
  const hEarly = homeHtAnalysis?.earlyGoalAnalysis?.goalInFirst15MinRate || 0;
  const aEarly = awayHtAnalysis?.earlyGoalAnalysis?.goalInFirst15MinRate || 0;
  if (hEarly > 0.4 || aEarly > 0.4) {
    earlyPenalty = -0.04;
    factors.push({ label: 'Frequent Early Goals Detected', side: 'neutral', type: 'warning' });
  }

  const wEmp = 0.55 - (h2hWeight / 2);
  const wPoi = 0.45 - (h2hWeight / 2);
  const rawProb = (wEmp * empiricalProb) + (wPoi * poissonProb) + (h2hWeight * h2hProb) + earlyPenalty;

  const calibratedProb = Math.min(Math.max(rawProb, 0.35), 0.97);
  const confidence = Math.round(calibratedProb * 100);

  if (confidence < 50) return null;

  return {
    market: 'under_2_5_ht',
    label: 'Under 2.5 HT',
    value: 'Under 2.5 First-Half Goals',
    confidence,
    probability: Number(calibratedProb.toFixed(4)),
    color: confidence >= 70 ? '#40c057' : confidence >= 60 ? '#ffa94d' : '#4dabf7',
    factors,
    expectedHtGoals: Number(lambdaHt.toFixed(2)),
  };
}

/**
 * 7. Chronological Walk-Forward Backtester
 *
 * Evaluates predictions against actual results without future-data leakage.
 *
 * @param {Array<Object>} historicalFixtures - Array of finished fixtures with actual scores
 * @returns {Object} Backtest evaluation report
 */
function backtestHistoricalFixtures(historicalFixtures) {
  if (!Array.isArray(historicalFixtures) || historicalFixtures.length === 0) {
    return {
      evaluatedCount: 0,
      under45: { count: 0, wins: 0, losses: 0, hitRate: 0, brierScore: null, logLoss: null },
      under25Ht: { count: 0, wins: 0, losses: 0, hitRate: 0, brierScore: null, logLoss: null },
    };
  }

  // Sort chronological ascending (oldest first)
  const sorted = [...historicalFixtures].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  const resultsU45 = [];
  const resultsU25Ht = [];

  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    const kickoff = current.date;

    // Past matches strictly before current fixture kickoff
    const priorMatches = sorted.slice(0, i);

    const homeHistory = priorMatches.filter(
      (m) => String(m.homeTeamId) === String(current.homeTeamId) || String(m.awayTeamId) === String(current.homeTeamId)
    ).map((m) => {
      const isHome = String(m.homeTeamId) === String(current.homeTeamId);
      return {
        id: m.id,
        date: m.date,
        pf: isHome ? m.ftHome : m.ftAway,
        pa: isHome ? m.ftAway : m.ftHome,
        isHome,
        htScore: m.htHome !== undefined && m.htAway !== undefined ? {
          total: m.htHome + m.htAway,
          team: isHome ? m.htHome : m.htAway,
          opp: isHome ? m.htAway : m.htHome,
        } : null,
      };
    });

    const awayHistory = priorMatches.filter(
      (m) => String(m.homeTeamId) === String(current.awayTeamId) || String(m.awayTeamId) === String(current.awayTeamId)
    ).map((m) => {
      const isHome = String(m.homeTeamId) === String(current.awayTeamId);
      return {
        id: m.id,
        date: m.date,
        pf: isHome ? m.ftHome : m.ftAway,
        pa: isHome ? m.ftAway : m.ftHome,
        isHome,
        htScore: m.htHome !== undefined && m.htAway !== undefined ? {
          total: m.htHome + m.htAway,
          team: isHome ? m.htHome : m.htAway,
          opp: isHome ? m.htAway : m.htHome,
        } : null,
      };
    });

    const cleanHome = validateAndFilterHistoricalMatches(homeHistory, { kickoffDate: kickoff });
    const cleanAway = validateAndFilterHistoricalMatches(awayHistory, { kickoffDate: kickoff });

    // Under 4.5 Goals prediction
    const u45Home = analyzeUnder45History(cleanHome, { isHomeContext: true });
    const u45Away = analyzeUnder45History(cleanAway, { isHomeContext: false });
    const predU45 = calculateUnder45Prediction({ homeAnalysis: u45Home, awayAnalysis: u45Away });

    if (predU45 && current.ftHome !== undefined && current.ftAway !== undefined) {
      const actualTotal = current.ftHome + current.ftAway;
      const won = actualTotal <= 4;
      resultsU45.push({
        prob: predU45.probability,
        outcome: won ? 1 : 0,
        actualTotal,
      });
    }

    // Under 2.5 HT prediction
    const htHome = analyzeUnder25HtHistory(cleanHome, { isHomeContext: true });
    const htAway = analyzeUnder25HtHistory(cleanAway, { isHomeContext: false });
    const predU25Ht = calculateUnder25HtPrediction({ homeHtAnalysis: htHome, awayHtAnalysis: htAway });

    if (predU25Ht && current.htHome !== undefined && current.htAway !== undefined) {
      const actualHtTotal = current.htHome + current.htAway;
      const won = actualHtTotal <= 2;
      resultsU25Ht.push({
        prob: predU25Ht.probability,
        outcome: won ? 1 : 0,
        actualHtTotal,
      });
    }
  }

  const computeMetrics = (items, baselineRate) => {
    if (items.length === 0) return { count: 0, wins: 0, losses: 0, hitRate: 0, brierScore: null, logLoss: null, baselineComparison: null };
    const wins = items.filter((x) => x.outcome === 1).length;
    const losses = items.length - wins;
    const hitRate = wins / items.length;

    // Brier Score: 1/N sum (p - o)^2
    const brier = items.reduce((sum, x) => sum + Math.pow(x.prob - x.outcome, 2), 0) / items.length;

    // Log Loss: -1/N sum [o * ln(p) + (1-o) * ln(1-p)]
    const eps = 1e-15;
    const logLoss = -(
      items.reduce((sum, x) => {
        const p = Math.max(Math.min(x.prob, 1 - eps), eps);
        return sum + (x.outcome * Math.log(p) + (1 - x.outcome) * Math.log(1 - p));
      }, 0) / items.length
    );

    // Calibration buckets
    const buckets = { '50-70%': { count: 0, wins: 0 }, '70-85%': { count: 0, wins: 0 }, '85-100%': { count: 0, wins: 0 } };
    items.forEach((x) => {
      const bKey = x.prob < 0.70 ? '50-70%' : x.prob < 0.85 ? '70-85%' : '85-100%';
      buckets[bKey].count++;
      if (x.outcome === 1) buckets[bKey].wins++;
    });

    return {
      count: items.length,
      wins,
      losses,
      hitRate: Number(hitRate.toFixed(4)),
      brierScore: Number(brier.toFixed(4)),
      logLoss: Number(logLoss.toFixed(4)),
      baselineHitRate: baselineRate,
      baselineBrierScore: Number((items.reduce((s, x) => s + Math.pow(baselineRate - x.outcome, 2), 0) / items.length).toFixed(4)),
      calibrationBuckets: buckets,
    };
  };

  return {
    evaluatedCount: sorted.length,
    under45: computeMetrics(resultsU45, BASELINE_PRIORS.UNDER_4_5_GOALS),
    under25Ht: computeMetrics(resultsU25Ht, BASELINE_PRIORS.UNDER_2_5_HT),
  };
}

module.exports = {
  BASELINE_PRIORS,
  validateAndFilterHistoricalMatches,
  analyzeUnder45History,
  analyzeUnder25HtHistory,
  analyzeH2HHistory,
  calculateUnder45Prediction,
  calculateUnder25HtPrediction,
  backtestHistoricalFixtures,
};
