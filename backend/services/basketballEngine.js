/**
 * basketballEngine.js
 *
 * Advanced basketball prediction pipeline:
 *   - Pace / possessions estimation (FGA - ORB + TO + 0.44 * FTA)
 *   - Offensive / defensive / net ratings per 100 possessions
 *   - Expected points (home, away, total) with opponent-strength & home-court adjustment
 *   - Win probability via the score-difference distribution (NOT a simple expected-score comparison)
 *   - Total-point over/under probabilities via the total-score distribution
 *
 * Principles:
 *   - Missing box-score stats stay null (never fabricated or zeroed).
 *   - Small-sample ratings are shrunk toward the league mean.
 *   - Player availability is reflected in data quality only when reliably available.
 */

const { getLeagueConfig } = require('./basketball/leagues');

/**
 * Legacy default league constants, now sourced from the NBA league config so the
 * values live in one place (basketball/leagues.js). Kept as an export for
 * backward compatibility with callers/tests that import LEAGUE_MEAN.
 */
const DEFAULT_LEAGUE_KEY = 'nba';

function leagueMeanFor(league) {
  const cfg = getLeagueConfig(league || DEFAULT_LEAGUE_KEY);
  return {
    possessions: cfg.leagueMean.possessions,
    ortg: cfg.leagueMean.ortg,
    drtg: cfg.leagueMean.drtg,
    homeCourtAdvantage: cfg.homeCourtPoints,
  };
}

const LEAGUE_MEAN = leagueMeanFor(DEFAULT_LEAGUE_KEY);

const DEFAULT_BASKETBALL_TOTAL_LINES = [195.5, 200.5, 205.5, 210.5, 215.5, 220.5];

/**
 * Standard normal CDF (Abramowitz & Stegun approximation).
 */
function normalCdf(x, mean = 0, std = 1) {
  const t = 1 / (1 + 0.2316419 * Math.abs((x - mean) / std));
  const d = 0.3989423 * Math.exp(-((x - mean) * (x - mean)) / (2 * std * std));
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > mean ? 1 - p : p;
}

/**
 * Estimate possessions from a box score.
 * Possessions ≈ FGA - ORB + TO + 0.44 * FTA
 *
 * @param {Object} box - { fga, orb, tov, fta }
 * @returns {number|null}
 */
function estimatePossessions(box) {
  if (!box) return null;
  const fga = box.fga;
  const orb = box.orb;
  const tov = box.tov;
  const fta = box.fta;
  if ([fga, orb, tov, fta].some(v => v == null || isNaN(Number(v)))) return null;
  return Number(Number(fga) - Number(orb) + Number(tov) + 0.44 * Number(fta));
}

/**
 * Calculate offensive, defensive, and net ratings per 100 possessions.
 *
 * @param {number} points - points scored
 * @param {number} oppPoints - points allowed
 * @param {number} possessions - team's possessions
 * @param {number} [oppPossessions] - opponent's possessions (defaults to team's)
 * @returns {{ ortg: number, drtg: number, netRtg: number }|null}
 */
function calcRatings(points, oppPoints, possessions, oppPossessions) {
  if (points == null || oppPoints == null || possessions == null) return null;
  if (possessions <= 0) return null;
  const p = Number(possessions);
  const oppP = oppPossessions != null ? Number(oppPossessions) : p;
  const ortg = (Number(points) / p) * 100;
  const drtg = oppP > 0 ? (Number(oppPoints) / oppP) * 100 : null;
  const netRtg = drtg != null ? ortg - drtg : null;
  return {
    ortg: Number(ortg.toFixed(2)),
    drtg: drtg != null ? Number(drtg.toFixed(2)) : null,
    netRtg: netRtg != null ? Number(netRtg.toFixed(2)) : null,
  };
}

/**
 * Shrink a rating toward the league mean for small samples.
 */
function shrinkRating(value, sampleSize, leagueMean, m = 5) {
  if (value == null) return leagueMean;
  const w = Math.min(1, sampleSize / (sampleSize + m));
  return value * w + leagueMean * (1 - w);
}

/**
 * Analyze a team's last-N basketball matches.
 *
 * @param {Array} matches - each match has pf (team points), pa (opp points), boxScore, isHome, date
 * @param {Object} [opts]
 * @param {boolean} [opts.isHomeContext]
 * @param {string} [opts.league] - league key/alias; drives the per-league mean
 * @returns {Object}
 */
function analyzeBasketballHistory(matches, { isHomeContext = null, league = DEFAULT_LEAGUE_KEY } = {}) {
  const mean = leagueMeanFor(league);
  const list = Array.isArray(matches) ? matches : [];
  const validMatches = list.filter(m => m && typeof m.pf === 'number' && typeof m.pa === 'number');

  if (validMatches.length === 0) {
    return {
      valid: false,
      sampleSize: 0,
      avgPoints: null,
      avgPointsAllowed: null,
      avgPossessions: null,
      ortg: null,
      drtg: null,
      netRtg: null,
      pace: null,
      homeAwaySplit: null,
      restDays: null,
      backToBack: false,
      recentTrend: null,
    };
  }

  const sampleSize = validMatches.length;
  const pointsArr = validMatches.map(m => m.pf);
  const oppArr = validMatches.map(m => m.pa);

  const avgPoints = pointsArr.reduce((s, v) => s + v, 0) / sampleSize;
  const avgPointsAllowed = oppArr.reduce((s, v) => s + v, 0) / sampleSize;

  // Possessions & ratings from box scores where available
  const posArr = [];
  const ortgArr = [];
  const drtgArr = [];
  validMatches.forEach(m => {
    const box = m.boxScore || {};
    const poss = estimatePossessions(box);
    if (poss != null && poss > 0) {
      posArr.push(poss);
      const r = calcRatings(m.pf, m.pa, poss);
      if (r) {
        ortgArr.push(r.ortg);
        if (r.drtg != null) drtgArr.push(r.drtg);
      }
    }
  });

  const avgPossessions = posArr.length > 0 ? posArr.reduce((s, v) => s + v, 0) / posArr.length : null;
  const rawOrtg = ortgArr.length > 0 ? ortgArr.reduce((s, v) => s + v, 0) / ortgArr.length : null;
  const rawDrtg = drtgArr.length > 0 ? drtgArr.reduce((s, v) => s + v, 0) / drtgArr.length : null;

  // Shrink small-sample ratings toward league mean
  const ortg = shrinkRating(rawOrtg, sampleSize, mean.ortg);
  const drtg = shrinkRating(rawDrtg, sampleSize, mean.drtg);
  const netRtg = ortg - drtg;
  const pace = avgPossessions != null ? shrinkRating(avgPossessions, sampleSize, mean.possessions) : mean.possessions;

  // Home/away split
  const homeMatches = validMatches.filter(m => m.isHome === true);
  const awayMatches = validMatches.filter(m => m.isHome === false);
  const split = (sub) => {
    if (!sub.length) return null;
    return {
      sampleSize: sub.length,
      avgPoints: Number((sub.reduce((s, m) => s + m.pf, 0) / sub.length).toFixed(2)),
      avgPointsAllowed: Number((sub.reduce((s, m) => s + m.pa, 0) / sub.length).toFixed(2)),
    };
  };
  const homeSplit = split(homeMatches);
  const awaySplit = split(awayMatches);
  const relevantSplit = isHomeContext === true ? homeSplit : isHomeContext === false ? awaySplit : null;

  // Rest days / back-to-back (from the most recent match date)
  let restDays = null;
  let backToBack = false;
  if (validMatches[0]?.date) {
    const lastDate = new Date(validMatches[0].date).getTime();
    if (!isNaN(lastDate)) {
      const now = Date.now();
      restDays = Math.floor((now - lastDate) / (1000 * 60 * 60 * 24));
      backToBack = restDays <= 1;
    }
  }

  // Recent trend (last 3 vs older)
  let recentTrend = { direction: 'stable', diff: 0 };
  if (sampleSize >= 4) {
    const recent = pointsArr.slice(0, 3);
    const older = pointsArr.slice(3);
    const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
    const olderAvg = older.reduce((s, v) => s + v, 0) / older.length;
    const diff = recentAvg - olderAvg;
    recentTrend = {
      direction: diff > 5 ? 'scoring_up' : diff < -5 ? 'scoring_down' : 'stable',
      diff: Number(diff.toFixed(2)),
    };
  }

  return {
    valid: true,
    sampleSize,
    avgPoints: Number(avgPoints.toFixed(2)),
    avgPointsAllowed: Number(avgPointsAllowed.toFixed(2)),
    avgPossessions: avgPossessions != null ? Number(avgPossessions.toFixed(2)) : null,
    ortg: Number(ortg.toFixed(2)),
    drtg: Number(drtg.toFixed(2)),
    netRtg: Number(netRtg.toFixed(2)),
    pace: Number(pace.toFixed(2)),
    homeAwaySplit: { home: homeSplit, away: awaySplit, relevant: relevantSplit },
    restDays,
    backToBack,
    recentTrend,
  };
}

/**
 * Basketball prediction engine.
 *
 * Expected points = Expected Possessions * Expected Points Per Possession.
 * Win probability is derived from the score-difference distribution
 * (Normal with mean = expHome - expAway, variance = sum of variances),
 * NOT from a simple expected-score comparison.
 *
 * @param {Object} params
 * @param {Object} params.homeAnalysis
 * @param {Object} params.awayAnalysis
 * @param {Object} [params.h2h]
 * @param {Array<number>} [params.totalLines]
 * @param {string} [params.league] - league key/alias; drives home-court + score variance
 * @returns {Object|null}
 */
function calculateBasketballPrediction({
  homeAnalysis,
  awayAnalysis,
  h2h = null,
  totalLines = DEFAULT_BASKETBALL_TOTAL_LINES,
  league = DEFAULT_LEAGUE_KEY,
}) {
  const mean = leagueMeanFor(league);
  const scoreStd = getLeagueConfig(league).scoreStd;
  const homeValid = homeAnalysis?.valid && homeAnalysis.sampleSize >= 2;
  const awayValid = awayAnalysis?.valid && awayAnalysis.sampleSize >= 2;
  if (!homeValid && !awayValid) return null;

  const factors = [];

  // --- Expected possessions (blend both teams' pace) ---
  const homePace = homeAnalysis?.pace ?? mean.possessions;
  const awayPace = awayAnalysis?.pace ?? mean.possessions;
  const expPossessions = (homePace + awayPace) / 2;

  // --- Expected points per possession (attack vs defence) ---
  // Home PPP = home ORtg vs away DRtg; Away PPP = away ORtg vs home DRtg
  const homeOrtg = homeAnalysis?.ortg ?? mean.ortg;
  const homeDrtg = homeAnalysis?.drtg ?? mean.drtg;
  const awayOrtg = awayAnalysis?.ortg ?? mean.ortg;
  const awayDrtg = awayAnalysis?.drtg ?? mean.drtg;

  const homePpp = ((homeOrtg + awayDrtg) / 2) / 100;
  const awayPpp = ((awayOrtg + homeDrtg) / 2) / 100;

  let expHomePoints = expPossessions * homePpp;
  let expAwayPoints = expPossessions * awayPpp;

  // --- Home-court advantage ---
  expHomePoints += mean.homeCourtAdvantage / 2;
  expAwayPoints -= mean.homeCourtAdvantage / 2;

  // --- Rest / back-to-back adjustment (small) ---
  if (homeAnalysis?.backToBack) { expHomePoints -= 2; factors.push({ label: 'Home on back-to-back', side: 'home', type: 'warning' }); }
  if (awayAnalysis?.backToBack) { expAwayPoints -= 2; factors.push({ label: 'Away on back-to-back', side: 'away', type: 'warning' }); }

  // --- H2H adjustment (supporting evidence) ---
  if (h2h?.valid && h2h.sampleSize >= 2 && h2h.avgTotalPoints != null) {
    const h2hWeight = Math.min(0.15, h2h.sampleSize * 0.03);
    const currentTotal = expHomePoints + expAwayPoints;
    const adjTotal = currentTotal * (1 - h2hWeight) + h2h.avgTotalPoints * h2hWeight;
    const ratio = currentTotal > 0 ? adjTotal / currentTotal : 1;
    expHomePoints *= ratio;
    expAwayPoints *= ratio;
    factors.push({ label: `H2H avg total: ${h2h.avgTotalPoints.toFixed(1)}`, side: 'neutral', type: 'info' });
  }

  const expTotal = expHomePoints + expAwayPoints;

  // --- Score variance for distribution modeling ---
  // Per-team score std comes from the league config (no hardcoded constant).
  const homeVariance = scoreStd * scoreStd;
  const awayVariance = scoreStd * scoreStd;

  // --- Win probability via score-difference distribution ---
  // diff = Home - Away ~ Normal(expHome - expAway, homeVar + awayVar)
  const diffMean = expHomePoints - expAwayPoints;
  const diffStd = Math.sqrt(homeVariance + awayVariance);
  // P(Home wins) = P(diff > 0.5) for integer scores (continuity correction)
  const homeWinProb = 1 - normalCdf(0.5, diffMean, diffStd);
  const awayWinProb = 1 - homeWinProb;

  // --- Total-point over/under probabilities ---
  // total = Home + Away ~ Normal(expTotal, homeVar + awayVar)
  const totalStd = Math.sqrt(homeVariance + awayVariance);
  const totalLineProbs = {};
  totalLines.forEach(line => {
    const pOver = 1 - normalCdf(line + 0.5, expTotal, totalStd);
    const pUnder = 1 - pOver;
    totalLineProbs[line] = {
      line,
      over: Number(pOver.toFixed(6)),
      under: Number(pUnder.toFixed(6)),
    };
  });

  // Select strongest total recommendation
  let bestTotal = null;
  Object.values(totalLineProbs).forEach(stat => {
    const maxP = Math.max(stat.over, stat.under);
    if (!bestTotal || maxP > Math.max(bestTotal.over, bestTotal.under)) {
      bestTotal = { ...stat, maxP, side: stat.over >= stat.under ? 'over' : 'under' };
    }
  });

  // Match winner selection
  const winnerSide = homeWinProb >= awayWinProb ? 'home' : 'away';
  const winnerProb = Math.max(homeWinProb, awayWinProb);

  factors.push({
    label: `Expected: ${expHomePoints.toFixed(0)} - ${expAwayPoints.toFixed(0)} (total ${expTotal.toFixed(0)})`,
    side: 'neutral',
    type: 'success',
  });
  factors.push({
    label: `Pace: ${expPossessions.toFixed(0)} poss | ORtg H:${homeOrtg.toFixed(0)} A:${awayOrtg.toFixed(0)}`,
    side: 'neutral',
    type: 'info',
  });

  return {
    market: winnerSide === 'home' ? 'basketball_match_winner_home' : 'basketball_match_winner_away',
    label: `${winnerSide === 'home' ? 'Home' : 'Away'} Win`,
    value: `${winnerSide === 'home' ? 'Home' : 'Away'} Team to Win`,
    category: 'basketball',
    confidence: Math.round(winnerProb * 100),
    probability: Number(winnerProb.toFixed(4)),
    expectedHomePoints: Number(expHomePoints.toFixed(2)),
    expectedAwayPoints: Number(expAwayPoints.toFixed(2)),
    expectedTotalPoints: Number(expTotal.toFixed(2)),
    homeWinProbability: Number(homeWinProb.toFixed(4)),
    awayWinProbability: Number(awayWinProb.toFixed(4)),
    totalLineProbabilities: totalLineProbs,
    bestTotalLine: bestTotal ? {
      line: bestTotal.line,
      side: bestTotal.side,
      probability: Number(bestTotal.maxP.toFixed(4)),
    } : null,
    pace: Number(expPossessions.toFixed(2)),
    homeOrtg: Number(homeOrtg.toFixed(2)),
    awayOrtg: Number(awayOrtg.toFixed(2)),
    homeDrtg: Number(homeDrtg.toFixed(2)),
    awayDrtg: Number(awayDrtg.toFixed(2)),
    factors,
    color: winnerProb >= 0.7 ? '#40c057' : winnerProb >= 0.6 ? '#ffa94d' : '#4dabf7',
    dataQuality: {
      homeSampleSize: homeAnalysis?.sampleSize || 0,
      awaySampleSize: awayAnalysis?.sampleSize || 0,
      homeValid,
      awayValid,
    },
  };
}

/**
 * Settle a basketball market.
 *
 * @param {string} market
 * @param {Object} scores - { homePoints, awayPoints, line }
 * @returns {'won'|'lost'|null}
 */
function settleBasketball(market, scores) {
  if (!scores) return null;
  const home = scores.homePoints;
  const away = scores.awayPoints;
  if (home == null || away == null) return null;
  const line = scores.line;

  if (market === 'basketball_match_winner_home' || market === 'basketball_match_winner') {
    return home > away ? 'won' : 'lost';
  }
  if (market === 'basketball_match_winner_away') {
    return away > home ? 'won' : 'lost';
  }
  if (line == null) return null;
  const total = Number(home) + Number(away);
  if (market.startsWith('basketball_total_points_over')) return total > line ? 'won' : 'lost';
  if (market.startsWith('basketball_total_points_under')) return total < line ? 'won' : 'lost';
  if (market.startsWith('basketball_home_points_over')) return Number(home) > line ? 'won' : 'lost';
  if (market.startsWith('basketball_home_points_under')) return Number(home) < line ? 'won' : 'lost';
  if (market.startsWith('basketball_away_points_over')) return Number(away) > line ? 'won' : 'lost';
  if (market.startsWith('basketball_away_points_under')) return Number(away) < line ? 'won' : 'lost';
  return null;
}

module.exports = {
  LEAGUE_MEAN,
  DEFAULT_BASKETBALL_TOTAL_LINES,
  normalCdf,
  estimatePossessions,
  calcRatings,
  shrinkRating,
  analyzeBasketballHistory,
  calculateBasketballPrediction,
  settleBasketball,
};
