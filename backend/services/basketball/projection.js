/**
 * basketball/projection.js
 *
 * Game projection:
 *   expected_possessions = blended pace (weighted toward the faster team; a
 *                          weight of 0.5 is a plain average)
 *   home_pts = expected_possessions * (home_ORtg vs away_DRtg) / 100
 *   away_pts = expected_possessions * (away_ORtg vs home_DRtg) / 100
 *   proj_total  = home_pts + away_pts
 *   proj_margin = home_pts - away_pts + home_court_adj
 *
 * The Elo margin is an optional second signal blended into the margin.
 */

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Blend two paces, leaning toward the faster team as the weight rises above 0.5.
 * @param {number} homePace
 * @param {number} awayPace
 * @param {number} weight - 0.5 = plain average; >0.5 leans faster
 */
function blendPace(homePace, awayPace, weight = 0.5) {
  const h = Number.isFinite(homePace) ? homePace : awayPace;
  const a = Number.isFinite(awayPace) ? awayPace : homePace;
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  const avg = (h + a) / 2;
  const faster = Math.max(h, a);
  const lean = clamp((weight - 0.5) * 2, 0, 1);
  return avg + (faster - avg) * lean;
}

/**
 * Project a game.
 *
 * @param {Object} params
 * @param {Object} params.home - home team ratings ({ ortg, drtg, pace })
 * @param {Object} params.away - away team ratings
 * @param {Object} params.leagueCfg
 * @param {Object} params.cfg
 * @param {number|null} [params.eloMargin] - Elo-derived margin (already home-court adjusted)
 * @returns {Object|null}
 */
function projectGame({ home, away, leagueCfg, cfg, eloMargin = null }) {
  if (!home || !away || !leagueCfg || !cfg) return null;

  const lm = leagueCfg.leagueMean;
  const homeOrtg = home.ortg ?? lm.ortg;
  const homeDrtg = home.drtg ?? lm.drtg;
  const awayOrtg = away.ortg ?? lm.ortg;
  const awayDrtg = away.drtg ?? lm.drtg;

  const pace = blendPace(home.pace ?? lm.possessions, away.pace ?? lm.possessions, cfg.projection.paceBlendWeight);
  const effectivePace = (pace != null && pace > 0) ? pace : (lm.possessions ?? 100);
  if (effectivePace == null || effectivePace <= 0) return null;

  // Points per possession: attack vs opposing defence.
  const homePpp = ((homeOrtg + awayDrtg) / 2) / 100;
  const awayPpp = ((awayOrtg + homeDrtg) / 2) / 100;

  const baseHome = effectivePace * homePpp;
  const baseAway = effectivePace * awayPpp;
  const baseTotal = baseHome + baseAway;

  const homeCourtPoints = leagueCfg.homeCourtPoints ?? 0;
  const ratingsMargin = (baseHome - baseAway) + homeCourtPoints;

  // Optional Elo blend on the margin only.
  const { blendMargins } = require('./ratings');
  const marginPreAdjust = blendMargins(ratingsMargin, eloMargin, cfg);

  return {
    expectedPossessions: round(effectivePace),
    homePpp: round(homePpp, 4),
    awayPpp: round(awayPpp, 4),
    total: round(baseTotal),
    margin: round(marginPreAdjust),
    ratingsMargin: round(ratingsMargin),
    eloMargin: eloMargin != null ? round(eloMargin) : null,
    homeCourtPoints,
  };
}

/** Convert a (total, margin) pair into home/away points. */
function pointsFromTotalMargin(total, margin) {
  return {
    homePoints: (total + margin) / 2,
    awayPoints: (total - margin) / 2,
  };
}

function round(v, dp = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  return Number(v.toFixed(dp));
}

module.exports = {
  clamp,
  blendPace,
  projectGame,
  pointsFromTotalMargin,
  round,
};
