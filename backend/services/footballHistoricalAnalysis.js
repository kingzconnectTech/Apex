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
  UNDER_4_5_GOALS: 0.85,     // ~85% of matches in global professional soccer finish <= 4 goals
  UNDER_2_5_HT: 0.90,        // ~90% of first halves finish <= 2 goals
  HOME_TEAM_UNDER_2_5: 0.84, // ~84% of matches home team scores <= 2 goals
  AWAY_TEAM_UNDER_2_5: 0.88, // ~88% of matches away team scores <= 2 goals
  UNDER_10_5_CORNERS: 0.62,  // ~62% of matches finish under 10.5 total corners
  UNDER_9_5_CORNERS: 0.50,   // ~50% of matches finish under 9.5 total corners
  UNDER_8_5_CORNERS: 0.38,   // ~38% of matches finish under 8.5 total corners
  UNDER_3_5_BOOKINGS: 0.42,  // ~42% of matches finish under 3.5 total bookings
  UNDER_4_5_BOOKINGS: 0.65,  // ~65% of matches finish under 4.5 total bookings
  DEFAULT_MATCH_CORNERS: 9.8,// European league average ~9.8 corners per match (~5.4 home, ~4.4 away)
  DEFAULT_MATCH_BOOKINGS: 4.2,// Global soccer average ~4.2 bookings per match (~2.0 home, ~2.2 away)
};

/** Documented booking convention: Total Cards issued (Yellow Cards + Red Cards) */
const BOOKING_CONVENTION = 'TOTAL_CARDS';
const DEFAULT_CORNER_LINES = [7.5, 8.5, 9.5, 10.5, 11.5];
const DEFAULT_BOOKING_LINES = [2.5, 3.5, 4.5, 5.5, 6.5];

/**
 * Median calculation helper
 * @param {Array<number>} arr
 * @returns {number|null}
 */
function calculateMedian(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const nums = arr.map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 !== 0 ? nums[mid] : Number(((nums[mid - 1] + nums[mid]) / 2).toFixed(2));
}

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

    // Extract corners if present as numbers, keeping null if absent
    const corners = (m.corners !== undefined && m.corners !== null && !isNaN(Number(m.corners)))
      ? Number(m.corners)
      : (m.stats?.corners !== undefined && m.stats?.corners !== null && !isNaN(Number(m.stats.corners))
        ? Number(m.stats.corners)
        : null);

    const cornersConceded = (m.cornersConceded !== undefined && m.cornersConceded !== null && !isNaN(Number(m.cornersConceded)))
      ? Number(m.cornersConceded)
      : (m.oppCorners !== undefined && m.oppCorners !== null && !isNaN(Number(m.oppCorners))
        ? Number(m.oppCorners)
        : null);

    const totalCorners = (corners !== null && cornersConceded !== null)
      ? corners + cornersConceded
      : (m.totalCorners !== undefined && m.totalCorners !== null && !isNaN(Number(m.totalCorners))
        ? Number(m.totalCorners)
        : null);

    // Cards / Bookings
    const yellowCards = (m.yellowCards !== undefined && m.yellowCards !== null && !isNaN(Number(m.yellowCards)))
      ? Number(m.yellowCards)
      : null;
    const redCards = (m.redCards !== undefined && m.redCards !== null && !isNaN(Number(m.redCards)))
      ? Number(m.redCards)
      : null;
    const opponentYellowCards = (m.opponentYellowCards !== undefined && m.opponentYellowCards !== null && !isNaN(Number(m.opponentYellowCards)))
      ? Number(m.opponentYellowCards)
      : null;
    const opponentRedCards = (m.opponentRedCards !== undefined && m.opponentRedCards !== null && !isNaN(Number(m.opponentRedCards)))
      ? Number(m.opponentRedCards)
      : null;

    let totalBookings = null;
    if (m.totalBookings !== undefined && m.totalBookings !== null && !isNaN(Number(m.totalBookings))) {
      totalBookings = Number(m.totalBookings);
    } else if (yellowCards !== null && opponentYellowCards !== null) {
      totalBookings = yellowCards + opponentYellowCards + (redCards || 0) + (opponentRedCards || 0);
    } else if (yellowCards !== null && redCards !== null) {
      totalBookings = yellowCards + redCards;
    }

    valid.push({
      ...m,
      pf,
      pa,
      totalGoals: pf + pa,
      corners,
      cornersConceded,
      totalCorners,
      yellowCards,
      redCards,
      opponentYellowCards,
      opponentRedCards,
      totalBookings,
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
 * 3b. Team History Analysis — Team Under 2.5 Goals (Individual Team Scoring <= 2)
 *
 * Evaluates whether a team scores 0, 1, or 2 goals (Under 2.5 for this team).
 * Excludes opponent's goals from this team's threshold.
 *
 * @param {Array} matches - Clean historical matches for the team
 * @param {Object} options
 * @param {boolean} [options.isHomeContext] - Whether upcoming fixture is at home for this team
 * @returns {Object} Team Under 2.5 metrics
 */
function analyzeTeamUnder25History(matches, { isHomeContext = null } = {}) {
  const totalMatches = matches ? matches.length : 0;
  if (totalMatches === 0) {
    return {
      valid: false,
      sampleSize: 0,
      under25HitRate: null,
      over25Frequency: null,
      avgGoalsScored: null,
      avgGoalsConceded: null,
      under25ConcededRate: null,
      recentTrend: null,
      homeAwaySplit: null,
      goalsScoredDistribution: {},
    };
  }

  let under25Count = 0;
  let over25Count = 0;
  let under25ConcededCount = 0;
  let scoredSum = 0;
  let concededSum = 0;
  const goalsScoredDistribution = { 0: 0, 1: 0, 2: 0, '3+': 0 };
  const goalsConcededDistribution = { 0: 0, 1: 0, 2: 0, '3+': 0 };
  const pfArr = [];
  const paArr = [];

  let validMatchesCount = 0;
  matches.forEach((m) => {
    const pf = m.pf !== undefined && m.pf !== null ? Number(m.pf) : NaN;
    const pa = m.pa !== undefined && m.pa !== null ? Number(m.pa) : NaN;
    if (isNaN(pf) || isNaN(pa)) return;

    validMatchesCount++;
    scoredSum += pf;
    concededSum += pa;
    pfArr.push(pf);
    paArr.push(pa);

    if (pf <= 2) {
      under25Count++;
    } else {
      over25Count++;
    }

    if (pa <= 2) {
      under25ConcededCount++;
    }

    const sKey = pf >= 3 ? '3+' : String(pf);
    goalsScoredDistribution[sKey] = (goalsScoredDistribution[sKey] || 0) + 1;

    const cKey = pa >= 3 ? '3+' : String(pa);
    goalsConcededDistribution[cKey] = (goalsConcededDistribution[cKey] || 0) + 1;
  });

  const sampleSize = validMatchesCount || totalMatches;
  const under25HitRate = sampleSize > 0 ? under25Count / sampleSize : 0;
  const over25Frequency = sampleSize > 0 ? over25Count / sampleSize : 0;
  const under25ConcededRate = sampleSize > 0 ? under25ConcededCount / sampleSize : 0;
  const avgGoalsScored = sampleSize > 0 ? scoredSum / sampleSize : 0;
  const avgGoalsConceded = sampleSize > 0 ? concededSum / sampleSize : 0;
  const medianGoalsScored = calculateMedian(pfArr);
  const medianGoalsConceded = calculateMedian(paArr);

  const goalsScoredPercentages = {
    0: sampleSize > 0 ? Number(((goalsScoredDistribution[0] || 0) / sampleSize).toFixed(4)) : 0,
    1: sampleSize > 0 ? Number(((goalsScoredDistribution[1] || 0) / sampleSize).toFixed(4)) : 0,
    2: sampleSize > 0 ? Number(((goalsScoredDistribution[2] || 0) / sampleSize).toFixed(4)) : 0,
    '3+': sampleSize > 0 ? Number(((goalsScoredDistribution['3+'] || 0) / sampleSize).toFixed(4)) : 0,
  };

  const goalsConcededPercentages = {
    0: sampleSize > 0 ? Number(((goalsConcededDistribution[0] || 0) / sampleSize).toFixed(4)) : 0,
    1: sampleSize > 0 ? Number(((goalsConcededDistribution[1] || 0) / sampleSize).toFixed(4)) : 0,
    2: sampleSize > 0 ? Number(((goalsConcededDistribution[2] || 0) / sampleSize).toFixed(4)) : 0,
    '3+': sampleSize > 0 ? Number(((goalsConcededDistribution['3+'] || 0) / sampleSize).toFixed(4)) : 0,
  };

  // Recent attacking trend: compare last 3-5 matches goals scored vs older matches
  let recentTrend = { direction: 'stable', diff: 0, last3ScoredAvg: null };
  if (sampleSize >= 4) {
    const last3 = matches.slice(0, 3);
    const older = matches.slice(3);
    const last3Avg = last3.reduce((s, m) => s + (Number(m.pf) || 0), 0) / 3;
    const olderAvg = older.reduce((s, m) => s + (Number(m.pf) || 0), 0) / older.length;
    const diff = last3Avg - olderAvg;
    recentTrend = {
      direction: diff > 0.6 ? 'more_goals' : diff < -0.6 ? 'fewer_goals' : 'stable',
      diff: Number(diff.toFixed(2)),
      last3ScoredAvg: Number(last3Avg.toFixed(2)),
      olderScoredAvg: Number(olderAvg.toFixed(2)),
    };
  }

  // Home/away split
  const homeMatches = matches.filter((m) => m.isHome === true);
  const awayMatches = matches.filter((m) => m.isHome === false);

  const calcSplit = (subList) => {
    if (!subList || subList.length === 0) return null;
    const u25 = subList.filter((m) => Number(m.pf) <= 2).length;
    const u25Conc = subList.filter((m) => Number(m.pa) <= 2).length;
    const scored = subList.reduce((s, m) => s + Number(m.pf), 0);
    const conceded = subList.reduce((s, m) => s + Number(m.pa), 0);
    return {
      sampleSize: subList.length,
      under25HitRate: u25 / subList.length,
      under25ConcededRate: u25Conc / subList.length,
      avgGoalsScored: scored / subList.length,
      avgGoalsConceded: conceded / subList.length,
    };
  };

  const homeSplit = calcSplit(homeMatches);
  const awaySplit = calcSplit(awayMatches);
  const relevantSplit = isHomeContext === true ? homeSplit : isHomeContext === false ? awaySplit : null;

  return {
    valid: true,
    sampleSize,
    under25Count,
    over25Count,
    under25HitRate: Number(under25HitRate.toFixed(4)),
    over25Frequency: Number(over25Frequency.toFixed(4)),
    under25ConcededRate: Number(under25ConcededRate.toFixed(4)),
    under25ConcededCount,
    avgGoalsScored: Number(avgGoalsScored.toFixed(2)),
    avgGoalsConceded: Number(avgGoalsConceded.toFixed(2)),
    medianGoalsScored,
    medianGoalsConceded,
    goalsScoredDistribution,
    goalsScoredPercentages,
    goalsConcededDistribution,
    goalsConcededPercentages,
    recentTrend,
    homeAwaySplit: {
      home: homeSplit,
      away: awaySplit,
      relevant: relevantSplit,
    },
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
  let homeUnder25 = null;
  let awayUnder25 = null;
  if (validFT.length > 0) {
    let u45Count = 0;
    let totGoals = 0;
    let homeU25Count = 0;
    let awayU25Count = 0;
    let homeGoalsSum = 0;
    let awayGoalsSum = 0;
    validFT.forEach((m) => {
      const hScore = Number(m.homeTeamScore ?? m.pf);
      const aScore = Number(m.awayTeamScore ?? m.pa);
      const sum = hScore + aScore;
      totGoals += sum;
      homeGoalsSum += hScore;
      awayGoalsSum += aScore;
      if (sum <= 4) u45Count++;
      if (hScore <= 2) homeU25Count++;
      if (aScore <= 2) awayU25Count++;
    });
    u45 = {
      sampleSize: validFT.length,
      under45Count: u45Count,
      over45Count: validFT.length - u45Count,
      under45Rate: Number((u45Count / validFT.length).toFixed(4)),
      over45Rate: Number(((validFT.length - u45Count) / validFT.length).toFixed(4)),
      avgGoals: Number((totGoals / validFT.length).toFixed(2)),
    };
    homeUnder25 = {
      sampleSize: validFT.length,
      under25Count: homeU25Count,
      under25Rate: Number((homeU25Count / validFT.length).toFixed(4)),
      avgGoals: Number((homeGoalsSum / validFT.length).toFixed(2)),
    };
    awayUnder25 = {
      sampleSize: validFT.length,
      under25Count: awayU25Count,
      under25Rate: Number((awayU25Count / validFT.length).toFixed(4)),
      avgGoals: Number((awayGoalsSum / validFT.length).toFixed(2)),
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

  // --- Corners H2H ---
  const validCorners = h2hMatches.filter((m) => {
    const tot = m.totalCorners !== undefined && m.totalCorners !== null
      ? Number(m.totalCorners)
      : (m.homeCorners != null && m.awayCorners != null
        ? Number(m.homeCorners) + Number(m.awayCorners)
        : m.stats?.corners != null
          ? Number(m.stats.corners)
          : NaN);
    return !isNaN(tot);
  });
  let h2hCorners = null;
  if (validCorners.length > 0) {
    let totCornersSum = 0;
    validCorners.forEach(m => {
      const tot = m.totalCorners != null
        ? Number(m.totalCorners)
        : (m.homeCorners != null && m.awayCorners != null
          ? Number(m.homeCorners) + Number(m.awayCorners)
          : Number(m.stats.corners));
      totCornersSum += tot;
    });
    h2hCorners = {
      sampleSize: validCorners.length,
      avgCorners: Number((totCornersSum / validCorners.length).toFixed(2)),
    };
  }

  // --- Bookings H2H ---
  const validBookings = h2hMatches.filter((m) => {
    const tot = m.totalBookings !== undefined && m.totalBookings !== null
      ? Number(m.totalBookings)
      : (m.yellowCards != null && m.opponentYellowCards != null
        ? Number(m.yellowCards) + Number(m.opponentYellowCards)
        : NaN);
    return !isNaN(tot);
  });
  let h2hBookings = null;
  if (validBookings.length > 0) {
    let totBookingsSum = 0;
    validBookings.forEach(m => {
      const tot = m.totalBookings != null
        ? Number(m.totalBookings)
        : Number(m.yellowCards) + Number(m.opponentYellowCards);
      totBookingsSum += tot;
    });
    h2hBookings = {
      sampleSize: validBookings.length,
      avgBookings: Number((totBookingsSum / validBookings.length).toFixed(2)),
    };
  }

  return {
    valid: validFT.length > 0 || validHT.length > 0 || validCorners.length > 0 || validBookings.length > 0,
    sampleSize: validFT.length,
    under45: u45,
    under25Ht: u25Ht,
    homeUnder25,
    awayUnder25,
    corners: h2hCorners,
    bookings: h2hBookings,
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
 * 6b. Probability Estimation for Team Under 2.5 Goals (Home Team or Away Team)
 *
 * Models P(Team Goals <= 2) using:
 *   - Empirical Bayesian smoothed hit rate for target team
 *   - Opponent defensive strength (how often opponent concedes <= 2 goals)
 *   - Poisson expected goals model for target team lambda = (teamScored + oppConceded) / 2
 *   - Head-to-Head goal records against upcoming opponent
 *   - Calibrated probability clamped [0.30, 0.96]
 *
 * @param {Object} params
 * @param {Object} params.teamAnalysis - Historical analysis for the target team
 * @param {Object} [params.oppAnalysis] - Historical analysis for opponent (defensive strength)
 * @param {boolean} [params.isHome=true] - True for Home Team Under 2.5, false for Away Team Under 2.5
 * @param {string} [params.teamName='Home Team']
 * @param {string} [params.oppName='Away Team']
 * @param {Object} [params.h2hAnalysis=null]
 * @param {number} [params.baselinePrior=null]
 * @returns {Object|null} Prediction object or null
 */
function calculateTeamUnder25Prediction({
  teamAnalysis,
  oppAnalysis = null,
  isHome = true,
  teamName = isHome ? 'Home Team' : 'Away Team',
  oppName = isHome ? 'Away Team' : 'Home Team',
  h2hAnalysis = null,
  baselinePrior = null,
}) {
  if (!teamAnalysis?.valid || teamAnalysis.sampleSize === 0) {
    return null;
  }

  const market = isHome ? 'home_team_under_2_5' : 'away_team_under_2_5';
  const label = isHome ? 'Home Team Under 2.5 Goals' : 'Away Team Under 2.5 Goals';
  const value = `${teamName} Under 2.5 Goals`;
  const defaultPrior = isHome ? BASELINE_PRIORS.HOME_TEAM_UNDER_2_5 : BASELINE_PRIORS.AWAY_TEAM_UNDER_2_5;
  const prior = typeof baselinePrior === 'number' ? baselinePrior : defaultPrior;

  const factors = [];
  const M = 4; // Empirical prior weight

  // 1. Empirical Bayesian smoothed rates
  const smoothRate = (count, size, priorVal) => {
    if (!size || size === 0) return priorVal;
    return (count + M * priorVal) / (size + M);
  };

  const teamSmoothed = smoothRate(teamAnalysis.under25Count, teamAnalysis.sampleSize, prior);

  // Relevant venue split for team
  let teamSplitSmoothed = teamSmoothed;
  if (teamAnalysis.homeAwaySplit?.relevant?.sampleSize >= 3) {
    const sp = teamAnalysis.homeAwaySplit.relevant;
    const spCount = sp.under25HitRate * sp.sampleSize;
    teamSplitSmoothed = smoothRate(spCount, sp.sampleSize, prior);
  }

  const teamRate = 0.6 * teamSmoothed + 0.4 * teamSplitSmoothed;

  // Opponent defensive contribution (how often opponent concedes <= 2 goals)
  let oppDefRate = prior;
  if (oppAnalysis?.valid) {
    const oppSmoothed = smoothRate(
      oppAnalysis.under25ConcededCount || (oppAnalysis.under25ConcededRate * oppAnalysis.sampleSize),
      oppAnalysis.sampleSize,
      prior
    );
    let oppSplitSmoothed = oppSmoothed;
    if (oppAnalysis.homeAwaySplit?.relevant?.sampleSize >= 3) {
      const sp = oppAnalysis.homeAwaySplit.relevant;
      const spConc = sp.under25ConcededRate * sp.sampleSize;
      oppSplitSmoothed = smoothRate(spConc, sp.sampleSize, prior);
    }
    oppDefRate = 0.6 * oppSmoothed + 0.4 * oppSplitSmoothed;
  }

  // Blended empirical probability: 70% attacking team scoring history, 30% opponent defensive resilience
  let empiricalProb = 0.70 * teamRate + 0.30 * oppDefRate;

  factors.push({
    label: `${teamName} scored <= 2 in ${Math.round(teamAnalysis.under25HitRate * 100)}% (${teamAnalysis.under25Count}/${teamAnalysis.sampleSize})`,
    side: isHome ? 'home' : 'away',
    type: teamAnalysis.under25HitRate >= 0.85 ? 'success' : 'info',
  });

  if (oppAnalysis?.valid) {
    factors.push({
      label: `${oppName} conceded <= 2 in ${Math.round(oppAnalysis.under25ConcededRate * 100)}% of recent matches`,
      side: isHome ? 'away' : 'home',
      type: oppAnalysis.under25ConcededRate >= 0.85 ? 'success' : 'info',
    });
  }

  // 2. Poisson Expected Goals model for this team
  const teamScored = teamAnalysis.homeAwaySplit?.relevant?.sampleSize >= 3
    ? 0.6 * teamAnalysis.homeAwaySplit.relevant.avgGoalsScored + 0.4 * teamAnalysis.avgGoalsScored
    : teamAnalysis.avgGoalsScored || (isHome ? 1.4 : 1.1);

  const oppConceded = oppAnalysis?.valid
    ? (oppAnalysis.homeAwaySplit?.relevant?.sampleSize >= 3
        ? 0.6 * oppAnalysis.homeAwaySplit.relevant.avgGoalsConceded + 0.4 * oppAnalysis.avgGoalsConceded
        : oppAnalysis.avgGoalsConceded || (isHome ? 1.2 : 1.4))
    : (isHome ? 1.2 : 1.4);

  let lambda = (teamScored + oppConceded) / 2;

  // H2H adjustment if available
  let h2hWeight = 0;
  let h2hProb = prior;
  const h2hData = isHome ? h2hAnalysis?.homeUnder25 : h2hAnalysis?.awayUnder25;
  if (h2hData && h2hData.sampleSize >= 2) {
    h2hWeight = Math.min(0.20, h2hData.sampleSize * 0.04);
    h2hProb = (h2hData.under25Count + 2 * prior) / (h2hData.sampleSize + 2);
    lambda = lambda * (1 - h2hWeight) + h2hData.avgGoals * h2hWeight;

    factors.push({
      label: `H2H ${teamName} scored <= 2: ${Math.round(h2hData.under25Rate * 100)}% (${h2hData.under25Count}/${h2hData.sampleSize})`,
      side: 'neutral',
      type: h2hData.under25Rate >= 0.85 ? 'success' : 'info',
    });
  }

  // Poisson CDF: P(Goals <= 2) = sum_{k=0}^2 e^(-lambda) * lambda^k / k!
  const poissonProb = poissonCdf(2, lambda);

  // 3. Blend empirical and Poisson
  const wEmp = 0.55 - (h2hWeight / 2);
  const wPoi = 0.45 - (h2hWeight / 2);
  const finalProb = (wEmp * empiricalProb) + (wPoi * poissonProb) + (h2hWeight * h2hProb);

  // Recent goal trend impact
  let trendAdjustment = 0;
  if (teamAnalysis.recentTrend?.direction === 'more_goals') {
    trendAdjustment -= 0.03;
    factors.push({ label: `${teamName} on recent high-scoring run`, side: isHome ? 'home' : 'away', type: 'warning' });
  } else if (teamAnalysis.recentTrend?.direction === 'fewer_goals') {
    trendAdjustment += 0.03;
    factors.push({ label: `${teamName} scoring dip in last 3 matches`, side: isHome ? 'home' : 'away', type: 'info' });
  }

  const calibratedProb = Math.min(Math.max(finalProb + trendAdjustment, 0.30), 0.96);
  const confidence = Math.round(calibratedProb * 100);

  if (confidence < 50) return null;

  return {
    market,
    label,
    value,
    selectedTeam: teamName,
    opponentTeam: oppName,
    confidence,
    probability: Number(calibratedProb.toFixed(4)),
    color: confidence >= 70 ? '#40c057' : confidence >= 60 ? '#ffa94d' : '#4dabf7',
    factors,
    expectedGoals: Number(lambda.toFixed(2)),
    probabilities: {
      zeroGoals: Number(poissonPmf(0, lambda).toFixed(4)),
      oneGoal: Number(poissonPmf(1, lambda).toFixed(4)),
      twoGoals: Number(poissonPmf(2, lambda).toFixed(4)),
      threePlusGoals: Number((1 - poissonCdf(2, lambda)).toFixed(4)),
    },
  };
}

/**
 * Settlement evaluation for Home Team Under 2.5 and Away Team Under 2.5
 *
 * @param {number} homeGoals - Full-time goals scored by home team
 * @param {number} awayGoals - Full-time goals scored by away team
 * @returns {{ homeUnder25: 'WIN'|'LOSS'|null, awayUnder25: 'WIN'|'LOSS'|null }}
 */
function settleTeamUnder25(homeGoals, awayGoals) {
  if (homeGoals === undefined || homeGoals === null || isNaN(Number(homeGoals)) ||
      awayGoals === undefined || awayGoals === null || isNaN(Number(awayGoals))) {
    return { homeUnder25: null, awayUnder25: null };
  }
  const hg = Number(homeGoals);
  const ag = Number(awayGoals);
  return {
    homeUnder25: hg <= 2 ? 'WIN' : 'LOSS',
    awayUnder25: ag <= 2 ? 'WIN' : 'LOSS',
  };
}

/**
 * 6c. Corners History Analysis
 *
 * Analyzes historical match corners won, conceded, and total corners per team.
 * Preserves missing values as null (never substitutes zero).
 *
 * @param {Array} matches - Clean historical matches
 * @param {Object} options
 * @param {boolean} [options.isHomeContext]
 * @param {Array<number>} [options.lines] - Half-line thresholds e.g. [7.5, 8.5, 9.5, 10.5, 11.5]
 * @returns {Object} Corners history analysis
 */
function analyzeCornersHistory(matches, { isHomeContext = null, lines = DEFAULT_CORNER_LINES } = {}) {
  const list = Array.isArray(matches) ? matches : [];
  const validMatches = list.filter(m => m && (typeof m.corners === 'number' || typeof m.totalCorners === 'number'));

  if (validMatches.length === 0) {
    return {
      valid: false,
      sampleSize: 0,
      avgCornersWon: null,
      medianCornersWon: null,
      avgCornersConceded: null,
      medianCornersConceded: null,
      avgTotalCorners: null,
      medianTotalCorners: null,
      lineFrequencies: {},
      homeAwaySplit: null,
      recentTrend: null,
    };
  }

  const sampleSize = validMatches.length;
  const cornersWonArr = validMatches.filter(m => typeof m.corners === 'number').map(m => m.corners);
  const cornersConcededArr = validMatches.filter(m => typeof m.cornersConceded === 'number').map(m => m.cornersConceded);
  const totalCornersArr = validMatches.filter(m => typeof m.totalCorners === 'number').map(m => m.totalCorners);

  const avgCornersWon = cornersWonArr.length > 0 ? cornersWonArr.reduce((s, c) => s + c, 0) / cornersWonArr.length : null;
  const medianCornersWon = calculateMedian(cornersWonArr);

  const avgCornersConceded = cornersConcededArr.length > 0 ? cornersConcededArr.reduce((s, c) => s + c, 0) / cornersConcededArr.length : null;
  const medianCornersConceded = calculateMedian(cornersConcededArr);

  const avgTotalCorners = totalCornersArr.length > 0
    ? totalCornersArr.reduce((s, c) => s + c, 0) / totalCornersArr.length
    : (avgCornersWon != null && avgCornersConceded != null ? avgCornersWon + avgCornersConceded : null);
  const medianTotalCorners = calculateMedian(totalCornersArr);

  // Line frequencies across configurable thresholds
  const lineFrequencies = {};
  lines.forEach(line => {
    if (totalCornersArr.length > 0) {
      const underCount = totalCornersArr.filter(t => t < line).length;
      lineFrequencies[line] = {
        underRate: Number((underCount / totalCornersArr.length).toFixed(4)),
        overRate: Number((1 - (underCount / totalCornersArr.length)).toFixed(4)),
        underCount,
        overCount: totalCornersArr.length - underCount,
        sampleSize: totalCornersArr.length,
      };
    }
  });

  // Home / Away venue split
  const homeMatches = validMatches.filter(m => m.isHome === true);
  const awayMatches = validMatches.filter(m => m.isHome === false);

  const calcCornerSplit = (subList) => {
    if (!subList || subList.length === 0) return null;
    const won = subList.filter(m => typeof m.corners === 'number').map(m => m.corners);
    const conc = subList.filter(m => typeof m.cornersConceded === 'number').map(m => m.cornersConceded);
    const tot = subList.filter(m => typeof m.totalCorners === 'number').map(m => m.totalCorners);
    return {
      sampleSize: subList.length,
      avgCornersWon: won.length > 0 ? Number((won.reduce((s, c) => s + c, 0) / won.length).toFixed(2)) : null,
      avgCornersConceded: conc.length > 0 ? Number((conc.reduce((s, c) => s + c, 0) / conc.length).toFixed(2)) : null,
      avgTotalCorners: tot.length > 0 ? Number((tot.reduce((s, c) => s + c, 0) / tot.length).toFixed(2)) : null,
    };
  };

  const homeSplit = calcCornerSplit(homeMatches);
  const awaySplit = calcCornerSplit(awayMatches);
  const relevantSplit = isHomeContext === true ? homeSplit : isHomeContext === false ? awaySplit : null;

  // Recent form trend
  let recentTrend = { direction: 'stable', diff: 0 };
  if (totalCornersArr.length >= 4) {
    const last3 = totalCornersArr.slice(0, 3);
    const older = totalCornersArr.slice(3);
    const last3Avg = last3.reduce((s, c) => s + c, 0) / 3;
    const olderAvg = older.reduce((s, c) => s + c, 0) / older.length;
    const diff = last3Avg - olderAvg;
    recentTrend = {
      direction: diff > 1.5 ? 'more_corners' : diff < -1.5 ? 'fewer_corners' : 'stable',
      diff: Number(diff.toFixed(2)),
      last3Avg: Number(last3Avg.toFixed(2)),
    };
  }

  return {
    valid: true,
    sampleSize,
    avgCornersWon: avgCornersWon != null ? Number(avgCornersWon.toFixed(2)) : null,
    medianCornersWon,
    avgCornersConceded: avgCornersConceded != null ? Number(avgCornersConceded.toFixed(2)) : null,
    medianCornersConceded,
    avgTotalCorners: avgTotalCorners != null ? Number(avgTotalCorners.toFixed(2)) : null,
    medianTotalCorners,
    lineFrequencies,
    homeAwaySplit: {
      home: homeSplit,
      away: awaySplit,
      relevant: relevantSplit,
    },
    recentTrend,
  };
}

/**
 * 6d. Expected Corners Prediction Engine
 *
 * Dedicated statistical count model for Total Match Corners:
 *   - Blends home attacking corners won + away defensive corners conceded
 *   - Blends away attacking corners won + home defensive corners conceded
 *   - Shrinkage towards competition baseline (~5.4 home, ~4.4 away = 9.8 total)
 *   - Poisson count model CDF for configurable half-lines
 *   - Strictly complementary Over/Under probabilities
 *
 * @param {Object} params
 * @param {Object} params.homeCornersAnalysis
 * @param {Object} params.awayCornersAnalysis
 * @param {Object} [params.h2hAnalysis]
 * @param {number} [params.targetLine=10.5]
 * @param {'under'|'over'} [params.marketType='under']
 * @param {Array<number>} [params.lines]
 * @returns {Object|null} Corners prediction
 */
function calculateCornersPrediction({
  homeCornersAnalysis,
  awayCornersAnalysis,
  h2hAnalysis = null,
  targetLine = 10.5,
  marketType = 'under',
  lines = DEFAULT_CORNER_LINES,
}) {
  const homeValid = homeCornersAnalysis?.valid && homeCornersAnalysis.sampleSize >= 2;
  const awayValid = awayCornersAnalysis?.valid && awayCornersAnalysis.sampleSize >= 2;

  // Abstain if neither team has verified corner statistics (never fabricate!)
  if (!homeValid && !awayValid) {
    return null;
  }

  const factors = [];
  const compHomeBaseline = 5.4;
  const compAwayBaseline = 4.4;

  // 1. Home expected corners
  const hWon = homeCornersAnalysis?.homeAwaySplit?.relevant?.avgCornersWon ?? homeCornersAnalysis?.avgCornersWon ?? compHomeBaseline;
  const aConc = awayCornersAnalysis?.homeAwaySplit?.relevant?.avgCornersConceded ?? awayCornersAnalysis?.avgCornersConceded ?? compHomeBaseline;
  const homeSample = homeCornersAnalysis?.sampleSize || 0;
  const hShrinkage = Math.min(0.8, homeSample / (homeSample + 4));
  const rawLambdaHome = (hWon + aConc) / 2;
  const lambdaHome = (rawLambdaHome * hShrinkage) + (compHomeBaseline * (1 - hShrinkage));

  // 2. Away expected corners
  const aWon = awayCornersAnalysis?.homeAwaySplit?.relevant?.avgCornersWon ?? awayCornersAnalysis?.avgCornersWon ?? compAwayBaseline;
  const hConc = homeCornersAnalysis?.homeAwaySplit?.relevant?.avgCornersConceded ?? homeCornersAnalysis?.avgCornersConceded ?? compAwayBaseline;
  const awaySample = awayCornersAnalysis?.sampleSize || 0;
  const aShrinkage = Math.min(0.8, awaySample / (awaySample + 4));
  const rawLambdaAway = (aWon + hConc) / 2;
  const lambdaAway = (rawLambdaAway * aShrinkage) + (compAwayBaseline * (1 - aShrinkage));

  let lambdaCorners = lambdaHome + lambdaAway;

  // 3. H2H corner statistics adjustment
  let h2hWeight = 0;
  if (h2hAnalysis?.corners && h2hAnalysis.corners.sampleSize >= 2) {
    const h2h = h2hAnalysis.corners;
    h2hWeight = Math.min(0.20, h2h.sampleSize * 0.04);
    lambdaCorners = lambdaCorners * (1 - h2hWeight) + (h2h.avgCorners * h2hWeight);
    factors.push({
      label: `H2H Avg Corners: ${h2h.avgCorners.toFixed(1)} (${h2h.sampleSize} matches)`,
      side: 'neutral',
      type: 'info',
    });
  }

  if (homeValid) {
    factors.push({
      label: `Home Corners: ${homeCornersAnalysis.avgCornersWon} won, ${homeCornersAnalysis.avgCornersConceded ?? 'N/A'} conceded`,
      side: 'home',
      type: 'info',
    });
  }
  if (awayValid) {
    factors.push({
      label: `Away Corners: ${awayCornersAnalysis.avgCornersWon} won, ${awayCornersAnalysis.avgCornersConceded ?? 'N/A'} conceded`,
      side: 'away',
      type: 'info',
    });
  }

  // 4. Calculate probabilities for each configurable line from Poisson count distribution
  const allLineProbabilities = {};
  lines.forEach(l => {
    const kThreshold = Math.floor(l); // for 10.5, under means <= 10
    const pUnder = poissonCdf(kThreshold, lambdaCorners);
    const pOver = 1 - pUnder;
    allLineProbabilities[l] = {
      line: l,
      underProbability: Number(pUnder.toFixed(4)),
      overProbability: Number(pOver.toFixed(4)),
    };
  });

  const chosenLine = typeof targetLine === 'number' ? targetLine : 10.5;
  const lineStats = allLineProbabilities[chosenLine] || allLineProbabilities[10.5];
  const pUnder = lineStats.underProbability;
  const pOver = lineStats.overProbability;

  // Empirical hit rate
  let empiricalUnderRate = null;
  const hFreq = homeCornersAnalysis?.lineFrequencies?.[chosenLine];
  const aFreq = awayCornersAnalysis?.lineFrequencies?.[chosenLine];
  if (hFreq && aFreq) {
    empiricalUnderRate = (hFreq.underRate + aFreq.underRate) / 2;
  } else if (hFreq) {
    empiricalUnderRate = hFreq.underRate;
  } else if (aFreq) {
    empiricalUnderRate = aFreq.underRate;
  }

  const rawProb = marketType === 'over' ? pOver : pUnder;
  let blendedProb = rawProb;
  if (empiricalUnderRate !== null) {
    const empTarget = marketType === 'over' ? (1 - empiricalUnderRate) : empiricalUnderRate;
    blendedProb = (0.55 * rawProb) + (0.45 * empTarget);
  }

  const calibratedProb = Math.min(Math.max(blendedProb, 0.30), 0.95);
  const confidence = Math.round(calibratedProb * 100);

  factors.push({
    label: `Expected Corners: ${lambdaCorners.toFixed(1)} (Home: ${lambdaHome.toFixed(1)}, Away: ${lambdaAway.toFixed(1)})`,
    side: 'neutral',
    type: 'success',
  });

  const market = marketType === 'over' ? 'over_corners' : 'under_corners';
  const label = `${marketType === 'over' ? 'Over' : 'Under'} ${chosenLine} Corners`;
  const value = `${marketType === 'over' ? 'Over' : 'Under'} ${chosenLine} Total Corners`;

  return {
    market,
    label,
    value,
    line: chosenLine,
    marketType,
    confidence,
    probability: Number(calibratedProb.toFixed(4)),
    complementaryProbability: Number((1 - calibratedProb).toFixed(4)),
    expectedCorners: Number(lambdaCorners.toFixed(2)),
    expectedHomeCorners: Number(lambdaHome.toFixed(2)),
    expectedAwayCorners: Number(lambdaAway.toFixed(2)),
    allLineProbabilities,
    factors,
    color: confidence >= 70 ? '#40c057' : confidence >= 60 ? '#ffa94d' : '#4dabf7',
  };
}

/**
 * Settlement evaluation for Corners
 *
 * @param {number} totalCorners
 * @param {number} [line=10.5]
 * @param {'under'|'over'} [marketType='under']
 * @returns {'WIN'|'LOSS'|null}
 */
function settleCorners(totalCorners, line = 10.5, marketType = 'under') {
  if (totalCorners === undefined || totalCorners === null || isNaN(Number(totalCorners))) {
    return null;
  }
  const corners = Number(totalCorners);
  if (marketType === 'over') {
    return corners > line ? 'WIN' : 'LOSS';
  }
  return corners < line ? 'WIN' : 'LOSS';
}

/**
 * 6e. Total Bookings History Analysis
 *
 * Tracks yellow cards, red cards, opponent cards, and total bookings.
 * Follows documented convention: Total Bookings = Total Cards (Yellow Cards + Red Cards).
 *
 * @param {Array} matches - Clean historical matches
 * @param {Object} options
 * @param {boolean} [options.isHomeContext]
 * @param {Array<number>} [options.lines] - Half-line thresholds e.g. [2.5, 3.5, 4.5, 5.5, 6.5]
 * @returns {Object} Bookings history analysis
 */
function analyzeBookingsHistory(matches, { isHomeContext = null, lines = DEFAULT_BOOKING_LINES } = {}) {
  const list = Array.isArray(matches) ? matches : [];
  const validMatches = list.filter(m => m && (typeof m.yellowCards === 'number' || typeof m.totalBookings === 'number'));

  if (validMatches.length === 0) {
    return {
      valid: false,
      sampleSize: 0,
      avgYellowCards: null,
      medianYellowCards: null,
      avgRedCards: null,
      avgTotalBookings: null,
      medianTotalBookings: null,
      avgOpponentBookings: null,
      lineFrequencies: {},
      homeAwaySplit: null,
      recentTrend: null,
    };
  }

  const sampleSize = validMatches.length;
  const yellowArr = validMatches.filter(m => typeof m.yellowCards === 'number').map(m => m.yellowCards);
  const redArr = validMatches.filter(m => typeof m.redCards === 'number').map(m => m.redCards);
  const oppBookingsArr = validMatches.filter(m => typeof m.opponentYellowCards === 'number').map(m => m.opponentYellowCards + (m.opponentRedCards || 0));
  const totalBookingsArr = validMatches.filter(m => typeof m.totalBookings === 'number').map(m => m.totalBookings);

  const avgYellowCards = yellowArr.length > 0 ? yellowArr.reduce((s, c) => s + c, 0) / yellowArr.length : null;
  const medianYellowCards = calculateMedian(yellowArr);

  const avgRedCards = redArr.length > 0 ? redArr.reduce((s, c) => s + c, 0) / redArr.length : null;

  const avgTotalBookings = totalBookingsArr.length > 0
    ? totalBookingsArr.reduce((s, c) => s + c, 0) / totalBookingsArr.length
    : (avgYellowCards != null ? avgYellowCards + (avgRedCards || 0) : null);
  const medianTotalBookings = calculateMedian(totalBookingsArr);

  const avgOpponentBookings = oppBookingsArr.length > 0 ? oppBookingsArr.reduce((s, c) => s + c, 0) / oppBookingsArr.length : null;

  // Line frequencies
  const lineFrequencies = {};
  lines.forEach(line => {
    if (totalBookingsArr.length > 0) {
      const underCount = totalBookingsArr.filter(t => t < line).length;
      lineFrequencies[line] = {
        underRate: Number((underCount / totalBookingsArr.length).toFixed(4)),
        overRate: Number((1 - (underCount / totalBookingsArr.length)).toFixed(4)),
        underCount,
        overCount: totalBookingsArr.length - underCount,
        sampleSize: totalBookingsArr.length,
      };
    }
  });

  // Home / Away venue split
  const homeMatches = validMatches.filter(m => m.isHome === true);
  const awayMatches = validMatches.filter(m => m.isHome === false);

  const calcBookingsSplit = (subList) => {
    if (!subList || subList.length === 0) return null;
    const tot = subList.filter(m => typeof m.totalBookings === 'number').map(m => m.totalBookings);
    const yellows = subList.filter(m => typeof m.yellowCards === 'number').map(m => m.yellowCards);
    return {
      sampleSize: subList.length,
      avgYellowCards: yellows.length > 0 ? Number((yellows.reduce((s, c) => s + c, 0) / yellows.length).toFixed(2)) : null,
      avgTotalBookings: tot.length > 0 ? Number((tot.reduce((s, c) => s + c, 0) / tot.length).toFixed(2)) : null,
    };
  };

  const homeSplit = calcBookingsSplit(homeMatches);
  const awaySplit = calcBookingsSplit(awayMatches);
  const relevantSplit = isHomeContext === true ? homeSplit : isHomeContext === false ? awaySplit : null;

  return {
    valid: true,
    sampleSize,
    avgYellowCards: avgYellowCards != null ? Number(avgYellowCards.toFixed(2)) : null,
    medianYellowCards,
    avgRedCards: avgRedCards != null ? Number(avgRedCards.toFixed(2)) : null,
    avgTotalBookings: avgTotalBookings != null ? Number(avgTotalBookings.toFixed(2)) : null,
    medianTotalBookings,
    avgOpponentBookings: avgOpponentBookings != null ? Number(avgOpponentBookings.toFixed(2)) : null,
    lineFrequencies,
    homeAwaySplit: {
      home: homeSplit,
      away: awaySplit,
      relevant: relevantSplit,
    },
  };
}

/**
 * 6f. Expected Bookings Prediction Engine
 *
 * Count-data model for Over/Under Total Match Bookings:
 *   - Blends team card rates with opponent conceded card rates
 *   - Shrinkage towards global soccer competition average (~2.0 home, ~2.2 away = 4.2)
 *   - Poisson count model CDF for lines [2.5, 3.5, 4.5, 5.5, 6.5]
 *   - Strictly complementary probabilities
 *
 * @param {Object} params
 * @param {Object} params.homeBookingsAnalysis
 * @param {Object} params.awayBookingsAnalysis
 * @param {Object} [params.h2hAnalysis]
 * @param {number} [params.targetLine=3.5]
 * @param {'under'|'over'} [params.marketType='under']
 * @param {Array<number>} [params.lines]
 * @returns {Object|null} Bookings prediction
 */
function calculateBookingsPrediction({
  homeBookingsAnalysis,
  awayBookingsAnalysis,
  h2hAnalysis = null,
  targetLine = 3.5,
  marketType = 'under',
  lines = DEFAULT_BOOKING_LINES,
}) {
  const homeValid = homeBookingsAnalysis?.valid && homeBookingsAnalysis.sampleSize >= 2;
  const awayValid = awayBookingsAnalysis?.valid && awayBookingsAnalysis.sampleSize >= 2;

  // Abstain if card statistics are missing (never substitute zero!)
  if (!homeValid && !awayValid) {
    return null;
  }

  const factors = [];
  const compHomeBaseline = 2.0;
  const compAwayBaseline = 2.2;

  // 1. Home expected bookings
  const hCards = homeBookingsAnalysis?.avgTotalBookings ?? compHomeBaseline;
  const aOppCards = awayBookingsAnalysis?.avgOpponentBookings ?? compHomeBaseline;
  const homeSample = homeBookingsAnalysis?.sampleSize || 0;
  const hShrinkage = Math.min(0.8, homeSample / (homeSample + 4));
  const rawLambdaHome = (hCards + aOppCards) / 2;
  const lambdaHome = (rawLambdaHome * hShrinkage) + (compHomeBaseline * (1 - hShrinkage));

  // 2. Away expected bookings
  const aCards = awayBookingsAnalysis?.avgTotalBookings ?? compAwayBaseline;
  const hOppCards = homeBookingsAnalysis?.avgOpponentBookings ?? compAwayBaseline;
  const awaySample = awayBookingsAnalysis?.sampleSize || 0;
  const aShrinkage = Math.min(0.8, awaySample / (awaySample + 4));
  const rawLambdaAway = (aCards + hOppCards) / 2;
  const lambdaAway = (rawLambdaAway * aShrinkage) + (compAwayBaseline * (1 - aShrinkage));

  let lambdaBookings = lambdaHome + lambdaAway;

  // 3. H2H card history adjustment
  if (h2hAnalysis?.bookings && h2hAnalysis.bookings.sampleSize >= 2) {
    const h2h = h2hAnalysis.bookings;
    const h2hWeight = Math.min(0.20, h2h.sampleSize * 0.04);
    lambdaBookings = lambdaBookings * (1 - h2hWeight) + (h2h.avgBookings * h2hWeight);
    factors.push({
      label: `H2H Avg Bookings: ${h2h.avgBookings.toFixed(1)} (${h2h.sampleSize} matches)`,
      side: 'neutral',
      type: 'info',
    });
  }

  if (homeValid) {
    factors.push({
      label: `Home Cards: ${homeBookingsAnalysis.avgTotalBookings || homeBookingsAnalysis.avgYellowCards} avg`,
      side: 'home',
      type: 'info',
    });
  }
  if (awayValid) {
    factors.push({
      label: `Away Cards: ${awayBookingsAnalysis.avgTotalBookings || awayBookingsAnalysis.avgYellowCards} avg`,
      side: 'away',
      type: 'info',
    });
  }

  // 4. Calculate probabilities for each line
  const allLineProbabilities = {};
  lines.forEach(l => {
    const kThreshold = Math.floor(l);
    const pUnder = poissonCdf(kThreshold, lambdaBookings);
    const pOver = 1 - pUnder;
    allLineProbabilities[l] = {
      line: l,
      underProbability: Number(pUnder.toFixed(4)),
      overProbability: Number(pOver.toFixed(4)),
    };
  });

  const chosenLine = typeof targetLine === 'number' ? targetLine : 3.5;
  const lineStats = allLineProbabilities[chosenLine] || allLineProbabilities[3.5];
  const pUnder = lineStats.underProbability;
  const pOver = lineStats.overProbability;

  const rawProb = marketType === 'over' ? pOver : pUnder;
  const calibratedProb = Math.min(Math.max(rawProb, 0.30), 0.95);
  const confidence = Math.round(calibratedProb * 100);

  factors.push({
    label: `Expected Bookings: ${lambdaBookings.toFixed(1)} (${BOOKING_CONVENTION})`,
    side: 'neutral',
    type: 'success',
  });

  const market = marketType === 'over' ? 'over_bookings' : 'under_bookings';
  const label = `${marketType === 'over' ? 'Over' : 'Under'} ${chosenLine} Bookings`;
  const value = `${marketType === 'over' ? 'Over' : 'Under'} ${chosenLine} Total Bookings`;

  return {
    market,
    label,
    value,
    line: chosenLine,
    marketType,
    convention: BOOKING_CONVENTION,
    confidence,
    probability: Number(calibratedProb.toFixed(4)),
    complementaryProbability: Number((1 - calibratedProb).toFixed(4)),
    expectedBookings: Number(lambdaBookings.toFixed(2)),
    expectedHomeBookings: Number(lambdaHome.toFixed(2)),
    expectedAwayBookings: Number(lambdaAway.toFixed(2)),
    allLineProbabilities,
    factors,
    color: confidence >= 70 ? '#40c057' : confidence >= 60 ? '#ffa94d' : '#4dabf7',
  };
}

/**
 * Settlement evaluation for Bookings
 *
 * @param {number} totalBookings
 * @param {number} [line=3.5]
 * @param {'under'|'over'} [marketType='under']
 * @returns {'WIN'|'LOSS'|null}
 */
function settleBookings(totalBookings, line = 3.5, marketType = 'under') {
  if (totalBookings === undefined || totalBookings === null || isNaN(Number(totalBookings))) {
    return null;
  }
  const bookings = Number(totalBookings);
  if (marketType === 'over') {
    return bookings > line ? 'WIN' : 'LOSS';
  }
  return bookings < line ? 'WIN' : 'LOSS';
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
      homeTeamUnder25: { count: 0, wins: 0, losses: 0, hitRate: 0, brierScore: null, logLoss: null },
      awayTeamUnder25: { count: 0, wins: 0, losses: 0, hitRate: 0, brierScore: null, logLoss: null },
      underCorners: { count: 0, wins: 0, losses: 0, hitRate: 0, brierScore: null, logLoss: null },
      underBookings: { count: 0, wins: 0, losses: 0, hitRate: 0, brierScore: null, logLoss: null },
    };
  }

  // Sort chronological ascending (oldest first)
  const sorted = [...historicalFixtures].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  const resultsU45 = [];
  const resultsU25Ht = [];
  const resultsHomeU25 = [];
  const resultsAwayU25 = [];
  const resultsCorners = [];
  const resultsBookings = [];

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
        corners: isHome ? m.homeCorners : m.awayCorners,
        cornersConceded: isHome ? m.awayCorners : m.homeCorners,
        totalCorners: m.totalCorners,
        yellowCards: isHome ? m.homeYellowCards : m.awayYellowCards,
        redCards: isHome ? m.homeRedCards : m.awayRedCards,
        totalBookings: m.totalBookings,
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
        corners: isHome ? m.homeCorners : m.awayCorners,
        cornersConceded: isHome ? m.awayCorners : m.homeCorners,
        totalCorners: m.totalCorners,
        yellowCards: isHome ? m.homeYellowCards : m.awayYellowCards,
        redCards: isHome ? m.homeRedCards : m.awayRedCards,
        totalBookings: m.totalBookings,
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

    // Home Team Under 2.5 Goals prediction
    const teamHomeU25 = analyzeTeamUnder25History(cleanHome, { isHomeContext: true });
    const teamAwayU25 = analyzeTeamUnder25History(cleanAway, { isHomeContext: false });

    const predHomeU25 = calculateTeamUnder25Prediction({
      teamAnalysis: teamHomeU25,
      oppAnalysis: teamAwayU25,
      isHome: true,
      teamName: current.homeName || 'Home',
      oppName: current.awayName || 'Away',
    });

    if (predHomeU25 && current.ftHome !== undefined) {
      const won = current.ftHome <= 2;
      resultsHomeU25.push({
        prob: predHomeU25.probability,
        outcome: won ? 1 : 0,
        actualGoals: current.ftHome,
      });
    }

    // Away Team Under 2.5 Goals prediction
    const predAwayU25 = calculateTeamUnder25Prediction({
      teamAnalysis: teamAwayU25,
      oppAnalysis: teamHomeU25,
      isHome: false,
      teamName: current.awayName || 'Away',
      oppName: current.homeName || 'Home',
    });

    if (predAwayU25 && current.ftAway !== undefined) {
      const won = current.ftAway <= 2;
      resultsAwayU25.push({
        prob: predAwayU25.probability,
        outcome: won ? 1 : 0,
        actualGoals: current.ftAway,
      });
    }

    // Under Corners prediction (10.5 line)
    const cornersHome = analyzeCornersHistory(cleanHome, { isHomeContext: true });
    const cornersAway = analyzeCornersHistory(cleanAway, { isHomeContext: false });
    const predCorners = calculateCornersPrediction({
      homeCornersAnalysis: cornersHome,
      awayCornersAnalysis: cornersAway,
      targetLine: 10.5,
      marketType: 'under',
    });

    if (predCorners && current.totalCorners !== undefined && current.totalCorners !== null) {
      const won = current.totalCorners < 10.5;
      resultsCorners.push({
        prob: predCorners.probability,
        outcome: won ? 1 : 0,
        actualCorners: current.totalCorners,
      });
    }

    // Under Bookings prediction (3.5 line)
    const bookingsHome = analyzeBookingsHistory(cleanHome, { isHomeContext: true });
    const bookingsAway = analyzeBookingsHistory(cleanAway, { isHomeContext: false });
    const predBookings = calculateBookingsPrediction({
      homeBookingsAnalysis: bookingsHome,
      awayBookingsAnalysis: bookingsAway,
      targetLine: 3.5,
      marketType: 'under',
    });

    if (predBookings && current.totalBookings !== undefined && current.totalBookings !== null) {
      const won = current.totalBookings < 3.5;
      resultsBookings.push({
        prob: predBookings.probability,
        outcome: won ? 1 : 0,
        actualBookings: current.totalBookings,
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
    homeTeamUnder25: computeMetrics(resultsHomeU25, BASELINE_PRIORS.HOME_TEAM_UNDER_2_5),
    awayTeamUnder25: computeMetrics(resultsAwayU25, BASELINE_PRIORS.AWAY_TEAM_UNDER_2_5),
    underCorners: computeMetrics(resultsCorners, BASELINE_PRIORS.UNDER_10_5_CORNERS),
    underBookings: computeMetrics(resultsBookings, BASELINE_PRIORS.UNDER_3_5_BOOKINGS),
  };
}

module.exports = {
  BASELINE_PRIORS,
  BOOKING_CONVENTION,
  DEFAULT_CORNER_LINES,
  DEFAULT_BOOKING_LINES,
  poissonPmf,
  poissonCdf,
  calculateMedian,
  validateAndFilterHistoricalMatches,
  analyzeUnder45History,
  analyzeUnder25HtHistory,
  analyzeTeamUnder25History,
  analyzeCornersHistory,
  analyzeBookingsHistory,
  analyzeH2HHistory,
  calculateUnder45Prediction,
  calculateUnder25HtPrediction,
  calculateTeamUnder25Prediction,
  calculateCornersPrediction,
  calculateBookingsPrediction,
  settleTeamUnder25,
  settleCorners,
  settleBookings,
  backtestHistoricalFixtures,
};
