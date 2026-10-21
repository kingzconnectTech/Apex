/**
 * basketball/ratings.js
 *
 * Team ratings with:
 *   - exponential recency decay (configurable half-life)
 *   - empirical-Bayes shrinkage toward the league mean / prior season
 *   - iterative opponent adjustment (SRS-style)
 *   - home/away splits shrunk toward the overall rating
 *   - an optional Elo (margin-of-victory adjusted, home-court aware) second signal
 *
 * Missing inputs stay null; nothing is fabricated.
 */

const { toNum, mean } = require('./normalize');

/**
 * Exponential decay weights for a list ordered newest-first.
 * w_i = 0.5 ^ (i / halfLife)
 * @param {number} n
 * @param {number} halfLife
 * @returns {number[]}
 */
function decayWeights(n, halfLife) {
  const hl = halfLife > 0 ? halfLife : 1;
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.pow(0.5, i / hl));
  return out;
}

/** Weighted mean of values with matching weights (nulls skipped). */
function weightedMean(values, weights) {
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    const w = weights && Number.isFinite(weights[i]) ? weights[i] : 1;
    num += v * w;
    den += w;
  }
  return den > 0 ? num / den : null;
}

/** Decayed mean of a metric array (newest-first). */
function decayedMean(values, halfLife) {
  const arr = Array.isArray(values) ? values : [];
  return weightedMean(arr, decayWeights(arr.length, halfLife));
}

/**
 * Decay weights adjusted for blowouts: games decided by `blowout.marginDiff` or
 * more are down-weighted (we have no clean-time stats to correct for garbage time).
 * @param {Array} games - derived games (newest-first), each with `margin`
 * @param {number} halfLife
 * @param {Object} cfg
 */
function gameWeights(games, halfLife, cfg) {
  const w = decayWeights(games.length, halfLife);
  const bw = cfg?.adjustments?.blowout;
  if (!bw) return w;
  return w.map((weight, i) => {
    const m = Math.abs(games[i]?.margin ?? 0);
    return m >= bw.marginDiff ? weight * bw.downWeight : weight;
  });
}

/** Empirical-Bayes shrinkage of a value toward a prior. */
function shrink(value, sampleSize, prior, m = 6) {
  if (value == null) return prior ?? null;
  if (prior == null) return value;
  const n = Math.max(0, Number(sampleSize) || 0);
  const w = n / (n + Math.max(0, m));
  return value * w + prior * (1 - w);
}

/**
 * Shrink a home/away split toward the overall rating. Small splits move much
 * closer to the overall value than large splits.
 */
function shrinkSplit(splitValue, splitSize, overallValue, m = 4) {
  if (splitValue == null) return overallValue ?? null;
  if (overallValue == null) return splitValue;
  return shrink(splitValue, splitSize, overallValue, m);
}

/**
 * Blend a current-season value with the prior-season value.
 * Current weight ramps from 0 at 0 games to 1 at `fullWeightGames`.
 */
function blendPrior(current, prior, gamesPlayed, fullWeightGames = 20) {
  if (current == null) return prior ?? null;
  if (prior == null) return current;
  const g = Math.max(0, Number(gamesPlayed) || 0);
  const full = Math.max(1, Number(fullWeightGames) || 20);
  const w = Math.min(1, g / full);
  return current * w + prior * (1 - w);
}

/** Current-season weight as a function of games played (0..1). */
function priorBlendWeight(gamesPlayed, fullWeightGames = 20) {
  const g = Math.max(0, Number(gamesPlayed) || 0);
  const full = Math.max(1, Number(fullWeightGames) || 20);
  return Math.min(1, g / full);
}

/**
 * Iterative opponent adjustment of ORtg/DRtg (SRS-style).
 *
 * adjOrtg[i] = ortg[i] - wmean(oppDrtg) + leagueMeanDrtg
 * adjDrtg[i] = drtg[i] - wmean(oppOrtg) + leagueMeanOrtg
 *
 * iterated so ratings are self-consistent, with ridge regularisation toward the
 * raw (unadjusted) value for stability.
 *
 * @param {Object} rawById - { [teamId]: { ortg, drtg, games:[{opponentId, isHome}] } }
 * @param {Object} leagueCfg
 * @param {Object} cfg
 * @returns {Object} { [teamId]: { ortg, drtg } }
 */
function opponentAdjustRatings(rawById, leagueCfg, cfg) {
  const { srsIterations = 12, srsRidge = 0.15, halfLifeGames = 9 } = cfg.ratings || {};
  const lm = leagueCfg.leagueMean;

  const adj = {};
  Object.keys(rawById).forEach(id => {
    adj[id] = { ortg: rawById[id].ortg, drtg: rawById[id].drtg };
  });

  for (let iter = 0; iter < srsIterations; iter++) {
    const next = {};
    Object.keys(rawById).forEach(id => {
      const { ortg, drtg, games } = rawById[id];
      const weights = decayWeights(games.length, halfLifeGames);
      const oppDrtgs = [];
      const oppOrtgs = [];
      games.forEach((g, i) => {
        const opp = adj[g.opponentId];
        if (!opp) {
          oppDrtgs.push(null);
          oppOrtgs.push(null);
          return;
        }
        oppDrtgs.push(opp.drtg);
        oppOrtgs.push(opp.ortg);
      });
      const wOppDrtg = weightedMean(oppDrtgs, weights);
      const wOppOrtg = weightedMean(oppOrtgs, weights);

      let nextOrtg = ortg;
      let nextDrtg = drtg;
      if (ortg != null && wOppDrtg != null) nextOrtg = ortg - wOppDrtg + lm.drtg;
      if (drtg != null && wOppOrtg != null) nextDrtg = drtg - wOppOrtg + lm.ortg;

      // Ridge: dampen the adjustment toward the raw value.
      if (ortg != null && nextOrtg != null) nextOrtg = ortg + (1 - srsRidge) * (nextOrtg - ortg);
      if (drtg != null && nextDrtg != null) nextDrtg = drtg + (1 - srsRidge) * (nextDrtg - drtg);

      next[id] = { ortg: nextOrtg, drtg: nextDrtg };
    });
    Object.keys(next).forEach(id => { adj[id] = next[id]; });
  }

  return adj;
}

/**
 * Elo over a set of team logs, processed chronologically with a home-court term
 * and a margin-of-victory multiplier.
 *
 * @param {Object} teamLogs - { [teamId]: derivedGameLog[] } (newest-first)
 * @param {Object} leagueCfg
 * @param {Object} cfg
 * @returns {Object} { [teamId]: number }
 */
function computeElo(teamLogs, leagueCfg, cfg) {
  const eloCfg = cfg.ratings?.elo || {};
  const k = eloCfg.k ?? 20;
  const movCap = eloCfg.movCap ?? 20;
  const hca = leagueCfg.homeCourtPoints ?? 2.5;
  const initial = 1500;
  // Convert home-court points into an Elo-equivalent edge.
  const hcaElo = hca * (eloCfg.pointsPerElo ?? 28);

  // Collect unique games.
  const seen = new Set();
  const games = [];
  Object.keys(teamLogs || {}).forEach(teamId => {
    (teamLogs[teamId] || []).forEach(g => {
      const key = g.eventId || `${g.date}|${g.opponentId}|${g.pf}-${g.pa}`;
      if (seen.has(key)) return;
      seen.add(key);
      const ts = g.timestamp ?? (g.date ? new Date(g.date).getTime() : null);
      if (ts == null || g.pf == null || g.pa == null) return;
      const homeId = g.isHome ? String(teamId) : String(g.opponentId);
      const awayId = g.isHome ? String(g.opponentId) : String(teamId);
      const homePf = g.isHome ? g.pf : g.pa;
      const awayPf = g.isHome ? g.pa : g.pf;
      games.push({ ts, homeId, awayId, homePf, awayPf });
    });
  });
  games.sort((a, b) => a.ts - b.ts);

  const elo = {};
  const get = id => (elo[id] != null ? elo[id] : initial);

  games.forEach(game => {
    const home = get(game.homeId);
    const away = get(game.awayId);
    const expectedHome = 1 / (1 + Math.pow(10, -((home + hcaElo) - away) / 400));
    const homeWon = game.homePf > game.awayPf ? 1 : game.homePf < game.awayPf ? 0 : 0.5;
    const margin = Math.abs(game.homePf - game.awayPf);
    const cappedMargin = Math.min(margin, movCap);
    // MOV multiplier (dampened for large favourites).
    const winnerElo = homeWon >= 0.5 ? home : away;
    const eloDiffWinner = Math.abs(winnerElo - (homeWon >= 0.5 ? away : home));
    const movMult = Math.log(cappedMargin + 1) * (2.2 / (eloDiffWinner * 0.001 + 2.2));
    const delta = k * movMult * (homeWon - expectedHome);
    elo[game.homeId] = home + delta;
    elo[game.awayId] = away - delta;
  });

  Object.keys(teamLogs || {}).forEach(id => {
    if (elo[id] == null) elo[id] = initial;
  });
  return elo;
}

/** Convert an Elo difference into a projected margin in points. */
function eloDiffToMargin(eloDiff, cfg) {
  const per = cfg.ratings?.elo?.pointsPerElo ?? 28;
  return eloDiff / per;
}

/** Blend a ratings-based margin with an Elo-based margin. */
function blendMargins(ratingsMargin, eloMargin, cfg) {
  const eloCfg = cfg.ratings?.elo || {};
  if (!eloCfg.enabled || eloMargin == null || !Number.isFinite(eloMargin)) return ratingsMargin;
  const w = eloCfg.blendWeight ?? 0;
  const cw = Math.min(1, Math.max(0, w));
  return ratingsMargin * (1 - cw) + eloMargin * cw;
}

/**
 * Compute full team ratings for one team.
 *
 * @param {Array} log - derived game log (newest-first)
 * @param {Object} leagueCfg
 * @param {Object} cfg
 * @param {Object} [opts]
 * @param {boolean|null} [opts.isHomeContext]
 * @param {Object} [opts.adjusted] - { ortg, drtg } from opponentAdjustRatings for this team
 * @returns {Object}
 */
function computeTeamRatings(log, leagueCfg, cfg, { isHomeContext = null, adjusted = null } = {}) {
  const games = Array.isArray(log) ? log.filter(Boolean) : [];
  const rCfg = cfg.ratings || {};
  const hl = rCfg.halfLifeGames ?? 9;
  const m = rCfg.shrinkageM ?? 6;
  const splitM = rCfg.splitShrinkageM ?? 4;
  const gamesPlayed = games.length;
  const lm = leagueCfg.leagueMean;
  const prior = leagueCfg.priorSeason || lm;

  const weights = decayWeights(gamesPlayed, hl);

  if (gamesPlayed === 0) {
    return {
      valid: true,  // Prior-based ratings are valid for projection
      sampleSize: 0,
      ortg: prior.ortg, drtg: prior.drtg, netRtg: (prior.ortg ?? 0) - (prior.drtg ?? 0),
      pace: prior.pace,
      rawOrtg: null, rawDrtg: null,
      priorWeight: 1.0,  // Fully rely on prior
      splits: { home: null, away: null, relevant: null },
      restDays: null, backToBack: false, threeInFour: false, roadTripLength: 0,
      gamesPlayed: 0,
    };
  }

  const rawOrtg = adjusted?.ortg != null ? adjusted.ortg : decayedMean(games.map(g => g.ortg), hl);
  const rawDrtg = adjusted?.drtg != null ? adjusted.drtg : decayedMean(games.map(g => g.drtg), hl);
  const rawPace = decayedMean(games.map(g => g.possessions), hl);

  // Prior-season blend, then empirical-Bayes shrinkage.
  const blendedOrtg = blendPrior(rawOrtg, prior.ortg, gamesPlayed, rCfg.priorBlendFullWeightGames);
  const blendedDrtg = blendPrior(rawDrtg, prior.drtg, gamesPlayed, rCfg.priorBlendFullWeightGames);
  const blendedPace = blendPrior(rawPace, prior.pace, gamesPlayed, rCfg.priorBlendFullWeightGames);

  const ortg = shrink(blendedOrtg, gamesPlayed, lm.ortg, m);
  const drtg = shrink(blendedDrtg, gamesPlayed, lm.drtg, m);
  const pace = shrink(blendedPace, gamesPlayed, lm.possessions, m);

  // Home/away splits (decayed within the split), shrunk toward the overall rating.
  const splitOf = (subset) => {
    if (!subset.length) return null;
    const subWeights = decayWeights(subset.length, hl);
    return {
      sampleSize: subset.length,
      ortg: weightedMean(subset.map(g => g.ortg), subWeights),
      drtg: weightedMean(subset.map(g => g.drtg), subWeights),
      pace: weightedMean(subset.map(g => g.possessions), subWeights),
      avgPoints: mean(subset.map(g => g.pf)),
      avgPointsAllowed: mean(subset.map(g => g.pa)),
    };
  };
  const homeSplitRaw = splitOf(games.filter(g => g.isHome === true));
  const awaySplitRaw = splitOf(games.filter(g => g.isHome === false));
  const shrinkSplitObj = (s) => (s ? {
    ...s,
    ortg: shrinkSplit(s.ortg, s.sampleSize, ortg, splitM),
    drtg: shrinkSplit(s.drtg, s.sampleSize, drtg, splitM),
    pace: shrinkSplit(s.pace, s.sampleSize, pace, splitM),
  } : null);
  const homeSplit = shrinkSplitObj(homeSplitRaw);
  const awaySplit = shrinkSplitObj(awaySplitRaw);
  const relevant = isHomeContext === true ? homeSplit : isHomeContext === false ? awaySplit : null;

  const latest = games[0];
  return {
    valid: true,
    sampleSize: gamesPlayed,
    ortg: round(ortg), drtg: round(drtg), netRtg: round((ortg ?? 0) - (drtg ?? 0)),
    pace: round(pace),
    rawOrtg: round(rawOrtg), rawDrtg: round(rawDrtg),
    priorWeight: round(priorBlendWeight(gamesPlayed, rCfg.priorBlendFullWeightGames), 3),
    splits: { home: homeSplit, away: awaySplit, relevant },
    restDays: latest?.restDays ?? null,
    backToBack: !!latest?.backToBack,
    threeInFour: !!latest?.threeInFour,
    roadTripLength: latest?.roadTripLength ?? 0,
    gamesPlayed,
  };
}

function round(v, dp = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  return Number(v.toFixed(dp));
}

module.exports = {
  decayWeights,
  weightedMean,
  decayedMean,
  shrink,
  shrinkSplit,
  blendPrior,
  priorBlendWeight,
  opponentAdjustRatings,
  computeElo,
  eloDiffToMargin,
  blendMargins,
  computeTeamRatings,
  round,
};
