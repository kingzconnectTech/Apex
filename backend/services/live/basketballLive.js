/**
 * live/basketballLive.js
 *
 * Phase 4 — basketball live model.
 *
 * Approach: project the REMAINING points as a normal distribution and add it to
 * the current score.
 *   - Remaining scoring rate comes from the league's own total mean
 *     (basketball/probability.leagueMeanTotal) prorated by the minutes left.
 *   - The remaining-margin mean is the league home-court edge prorated by the
 *     same fraction.
 *   - Sigma scales with sqrt(time): sigma_remaining = sigma_full * sqrt(fraction),
 *     so at tip-off it equals the pre-game sigma and it tightens as the clock
 *     runs down.
 *   - The final minutes get a deliberate-fouling adjustment to both rate and
 *     sigma (config.liveModel.basketball.endgame).
 *
 * As with the football model, at minute 0 the remaining window is the whole game
 * so the output equals the pre-game projection. All numbers live in ./config
 * and basketball/leagues.js (fitted) — nothing is hardcoded here.
 */

const CONFIG = require('./config');
const M = require('./liveMath');
const { resolveLeagueKey, getLeagueConfig } = require('../basketball/leagues');
const { leagueMeanTotal } = require('../basketball/probability');

const B = CONFIG.liveModel.basketball;
const LEVEL = CONFIG.liveModel.uncertaintyLevel;

/**
 * Resolve the league's live parameters, preferring the fitted basketball config
 * and falling back to the documented live defaults for an unknown league.
 */
function leagueParams(leagueId) {
  const key = resolveLeagueKey(leagueId);
  try {
    if (key) {
      const cfg = getLeagueConfig(key);
      const totalMean = leagueMeanTotal(cfg);
      return {
        key,
        gameMinutes: cfg.gameMinutes,
        periods: B.leaguePeriods[key] || B.defaultPeriods,
        homeCourtPoints: cfg.homeCourtPoints,
        totalMean: Number.isFinite(totalMean) ? totalMean : B.fallback.totalMean,
        totalStd: cfg.sigma && Number.isFinite(cfg.sigma.total) ? cfg.sigma.total : B.fallback.totalStd,
        marginStd: cfg.sigma && Number.isFinite(cfg.sigma.margin) ? cfg.sigma.margin : B.fallback.marginStd,
        fitted: true,
      };
    }
  } catch (err) {
    // Unknown/disabled league: fall through to the live defaults rather than throw.
  }
  return {
    key: key || null,
    gameMinutes: B.fallback.gameMinutes,
    periods: B.defaultPeriods,
    homeCourtPoints: B.fallback.homeCourtPoints,
    totalMean: B.fallback.totalMean,
    totalStd: B.fallback.totalStd,
    marginStd: B.fallback.marginStd,
    fitted: false,
  };
}

/**
 * Elapsed game minutes from period + remaining-in-period clock, or null.
 * Handles overtime: every period past `periods` is `overtimeMinutes` long.
 *
 * Accepts both ESPN clock forms: "7:24" (mm:ss) and the seconds-only form ESPN
 * emits inside the final minute ("50.6", "0.0").
 */
function elapsedMinutes(live, params) {
  const parsed = M.parseClock(live && live.clock);
  if (!parsed || (parsed.format !== 'mm:ss' && parsed.format !== 'seconds')) return null;
  const period = Number(live.period) || 0;
  if (period < 1) return null;
  const periodMinutes = params.gameMinutes / params.periods;
  const inPeriod = M.clamp(periodMinutes - parsed.minutes, 0, periodMinutes);
  let elapsed = (period - 1) * periodMinutes + inPeriod;
  if (period > params.periods) {
    // Replace the regulation assumption for OT periods with the OT length.
    elapsed = params.gameMinutes
      + (period - 1 - params.periods) * B.overtimeMinutes
      + M.clamp(B.overtimeMinutes - parsed.minutes, 0, B.overtimeMinutes);
  }
  return elapsed;
}

function z() {
  return M.normalInv((1 + LEVEL) / 2);
}

/** Home-win probability from a normal margin distribution (no draw in basketball). */
function homeWinProbability(marginMean, marginSigma) {
  if (!(marginSigma > 0)) return 0.5;
  return 1 - M.normalCdf((0 - marginMean) / marginSigma);
}

/**
 * @param {Object} args
 * @param {Object} args.game    Phase 3 LiveGame
 * @param {number} args.weight  live-vs-prior blend weight (from liveModel.tierWeight)
 * @param {boolean} [args.manual] true for a hand-typed game (wider bands)
 */
function predictBasketball({ game, weight = 1, manual = false } = {}) {
  const notes = [];
  const widen = manual ? CONFIG.liveModel.manual.uncertaintyWiden : 1;
  if (manual) {
    notes.push('Hand-typed values: the estimate is pulled toward the pre-game prior and the uncertainty band is widened.');
  }
  const params = leagueParams(game.league && game.league.id);
  if (!params.fitted) notes.push('League not recognised — live defaults used.');

  const curHome = game.home && game.home.score != null ? game.home.score : 0;
  const curAway = game.away && game.away.score != null ? game.away.score : 0;
  const curTotal = curHome + curAway;
  const curMargin = curHome - curAway;

  // Prior = the same model at tip-off (full game remaining, empty scoreboard).
  const prior = {
    total: params.totalMean,
    margin: params.homeCourtPoints,
    sigmaTotal: params.totalStd,
    sigmaMargin: params.marginStd,
  };

  const base = {
    sport: 'basketball',
    model: 'basketball_remaining_normal',
    league: params.key,
    current: { home_score: curHome, away_score: curAway, total: curTotal, margin: curMargin },
    data_tier: game.data_tier || null,
    notes,
  };

  const elapsed = elapsedMinutes(game.live, params);
  if (elapsed == null) {
    notes.push('No in-game clock — showing the pre-game projection only.');
    const zz = z();
    // Widening sigma also softens the two-way probability toward a coin flip,
    // which is the honest posture for values nobody verified.
    const sigmaTotal = prior.sigmaTotal * widen;
    const sigmaMargin = prior.sigmaMargin * widen;
    const priorProb = homeWinProbability(prior.margin, sigmaMargin);
    return {
      ...base,
      status: 'prior_only',
      reason: 'in-game clock unavailable',
      inputs: { elapsed_minutes: null, remaining_minutes: null, period: game.live.period, clock: game.live.clock },
      expected: expectedFrom(prior.total, prior.margin),
      probabilities: { home_win: M.round(priorProb, 4), away_win: M.round(1 - priorProb, 4) },
      uncertainty: {
        level: LEVEL,
        total: { low: M.round(prior.total - zz * sigmaTotal, 2), high: M.round(prior.total + zz * sigmaTotal, 2) },
        margin: { low: M.round(prior.margin - zz * sigmaMargin, 2), high: M.round(prior.margin + zz * sigmaMargin, 2) },
      },
      sigma: { total: M.round(sigmaTotal, 2), margin: M.round(sigmaMargin, 2) },
      blend: { weight: 0, tier: game.data_tier || null, prior_used: true },
    };
  }

  const remaining = Math.max(0, params.gameMinutes - elapsed);
  const fraction = params.gameMinutes > 0 ? remaining / params.gameMinutes : 0;

  const endgame = remaining <= B.endgame.minutes;
  const rateMultiplier = endgame ? B.endgame.rateMultiplier : 1;
  const sigmaMultiplier = endgame ? B.endgame.sigmaMultiplier : 1;
  if (endgame) notes.push('Endgame adjustment applied (foul game).');

  const ratePerMinute = params.gameMinutes > 0 ? params.totalMean / params.gameMinutes : 0;
  const live = {
    total: curTotal + ratePerMinute * remaining * rateMultiplier,
    margin: curMargin + params.homeCourtPoints * fraction,
    sigmaTotal: params.totalStd * Math.sqrt(fraction) * sigmaMultiplier,
    sigmaMargin: params.marginStd * Math.sqrt(fraction) * sigmaMultiplier,
  };
  if (live.sigmaTotal <= 0) {
    notes.push('Clock indicates the game is over; uncertainty band collapsed.');
  }

  const total = M.blend(live.total, prior.total, weight);
  const margin = M.blend(live.margin, prior.margin, weight);
  // Sigma is blended linearly so it stays between the (tighter) live value and
  // the (wider) prior, rather than dropping below either. It is then stretched
  // by `widen` for a hand-typed game, which widens the bands and pulls the
  // two-way probability toward a coin flip.
  const sigmaTotal = Math.max(0.01, M.blend(live.sigmaTotal, prior.sigmaTotal, weight)) * widen;
  const sigmaMargin = Math.max(0.01, M.blend(live.sigmaMargin, prior.sigmaMargin, weight)) * widen;

  const homeWin = homeWinProbability(margin, sigmaMargin);
  const zz = z();

  return {
    ...base,
    status: 'live',
    reason: null,
    inputs: {
      elapsed_minutes: M.round(elapsed, 2),
      remaining_minutes: M.round(remaining, 2),
      period: game.live.period,
      clock: game.live.clock,
      rate_per_minute: M.round(ratePerMinute, 3),
    },
    expected: expectedFrom(total, margin),
    probabilities: { home_win: M.round(homeWin, 4), away_win: M.round(1 - homeWin, 4) },
    uncertainty: {
      level: LEVEL,
      total: { low: M.round(total - zz * sigmaTotal, 2), high: M.round(total + zz * sigmaTotal, 2) },
      margin: { low: M.round(margin - zz * sigmaMargin, 2), high: M.round(margin + zz * sigmaMargin, 2) },
    },
    sigma: { total: M.round(sigmaTotal, 2), margin: M.round(sigmaMargin, 2) },
    blend: { weight, tier: game.data_tier || null, prior_used: weight < 1 },
  };
}

/** Split a projected (total, margin) pair into the two projected final scores. */
function expectedFrom(total, margin) {
  return {
    home_score: M.round((total + margin) / 2, 2),
    away_score: M.round((total - margin) / 2, 2),
    total: M.round(total, 2),
    margin: M.round(margin, 2),
  };
}

module.exports = { predictBasketball, elapsedMinutes, leagueParams };
