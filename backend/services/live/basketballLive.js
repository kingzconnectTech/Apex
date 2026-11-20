/**
 * live/basketballLive.js
 *
 * Phase 4 — basketball live model.
 *
 * Approach: project the REMAINING points as a normal distribution and add it to
 * the current score.
 *   - The prior is the pre-game engine's own projection where available (the
 *     projected full-game margin/total the basketball scheduler publishes
 *     in-process — team ratings, Elo, home court), so a 12-point favourite is
 *     modelled as one instead of every game starting at the league home-court
 *     edge. With no published projection it falls back to the league's own
 *     mean total and fitted home-court points.
 *   - The remaining scoring rate blends the league's own total
 *     (basketball/probability.leagueMeanTotal) with the rate the game itself
 *     is actually producing (observed pts/min shrunk toward the league rate),
 *     prorated by the minutes left, then nudged by the game's own PACE when the
 *     ESPN boxscore supplied possession data (liveStats.js -> context.stats).
 *   - The remaining-margin mean is the prior margin prorated by the fraction of
 *     the game left.
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
        // League pace, for the live-stat tempo read: possessions per team per
        // game. Only known for a fitted league.
        possessionsPerTeam: cfg.leagueMean && Number.isFinite(cfg.leagueMean.possessions)
          ? cfg.leagueMean.possessions : null,
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
    possessionsPerTeam: null,
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

/**
 * Elapsed game minutes from whatever the source actually published, falling back
 * to the PERIOD when the clock is missing.
 *
 * LiveScore's basketball feed reports the QUARTER ('1Q'..'OT') but no clock, so
 * `elapsedMinutes` returns null. The quarter is still real evidence — it tells us
 * at least this much of the game has been played — and ignoring it (returning the
 * pre-game prior) was the Home Win bias: the scoreboard was never read. So when
 * only the period is known we anchor at the START of the current period — the
 * minimum elapsed, the honest floor — and let the remaining-time projection cover
 * the rest of that period plus everything after it.
 *
 * Conservative by construction: assuming MORE time remains can only DEPRESS the
 * leader's win probability, so a period-only read can never overstate a lead.
 *
 * Returns `{ elapsed, estimated }` (`estimated` true for a period-only read), or
 * null when the period is unknown too — a genuinely clock-less, period-less
 * game, which still models as a pre-game projection.
 *
 * @param {Object} live    game.live ({ clock, period })
 * @param {Object} params  leagueParams output
 * @returns {{elapsed:number, estimated:boolean}|null}
 */
function progressMinutes(live, params) {
  const byClock = elapsedMinutes(live, params);
  if (byClock != null) return { elapsed: byClock, estimated: false };
  const period = Number(live && live.period) || 0;
  if (period < 1) return null;
  const periodMinutes = params.gameMinutes / params.periods;
  let elapsed = (period - 1) * periodMinutes;
  if (period > params.periods) {
    elapsed = params.gameMinutes + (period - 1 - params.periods) * B.overtimeMinutes;
  }
  return { elapsed, estimated: true };
}

/**
 * Live-stat tempo read for the rate estimate.
 *
 * The game's own possessions per minute are a structural pace signal the score
 * alone cannot give: the same 12-10 score at the same minute could be a slow
 * grind or a fast game that just missed shots. Possessions per minute stay
 * broadly stable through a game, so the observed pace is compared to the
 * league's and used to nudge the scoring rate toward the tempo the game is
 * actually being played at (bounded by config so it can never run away with the
 * projection). Possessions already fold in FGA, turnovers and offensive boards
 * (liveStats basketball branch), so a turnover-heavy game reads as faster.
 *
 * Returns null — the rate is left untouched — when the boxscore carried no
 * possession data, when too little of the game has elapsed, or when the league
 * pace is unknown: nothing is inferred from an absent read.
 *
 * @param {Object} context  { stats } from liveStats (basketball boxscore)
 * @param {Object} params   leagueParams output
 * @param {number} elapsed  elapsed game minutes
 * @returns {{factor:number, ratio:number, observed:number, league:number}|null}
 */
function paceRead(context, params, elapsed) {
  const cfg = B.tempo;
  const stats = context && context.stats;
  if (!cfg || !stats || stats.sport !== 'basketball' || !stats.totals) return null;
  if (!Number.isFinite(elapsed) || elapsed < (cfg.minElapsed || 0)) return null;
  const poss = stats.totals.possessions;
  if (!Number.isFinite(poss) || poss < (cfg.minPossessions || 0)) return null;
  // League pace for BOTH teams (possessions are recorded per team).
  const league = params.possessionsPerTeam > 0 && params.gameMinutes > 0
    ? (2 * params.possessionsPerTeam) / params.gameMinutes : null;
  if (!(league > 0)) return null;
  const observed = poss / elapsed;
  const ratio = observed / league;
  const weight = Number.isFinite(cfg.weight) ? cfg.weight : 0.5;
  const lo = Number.isFinite(cfg.scaleMin) ? cfg.scaleMin : 0.9;
  const hi = Number.isFinite(cfg.scaleMax) ? cfg.scaleMax : 1.1;
  const factor = M.clamp(1 + weight * (ratio - 1), lo, hi);
  return {
    factor,
    ratio,
    observed: M.round(observed, 2),
    league: M.round(league, 2),
  };
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
 * @param {Object} [args.context] { stats } from liveStats (basketball boxscore)
 * @param {Object|null} [args.engineProjection] the pre-game engine's projected
 *   { margin, total } for this game (services/basketball/engineProjections)
 */
function predictBasketball({ game, weight = 1, manual = false, context = {}, engineProjection = null } = {}) {
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

  // Team strength: the pre-game engine's own projected margin/total when the
  // scheduler published one, else the league's fitted home-court edge and mean
  // total. The live models are not allowed to read a market line, so this is
  // the engine's output — never a book's — and nothing is fabricated when it
  // is absent.
  const priorTotal = engineProjection && Number.isFinite(engineProjection.total)
    ? engineProjection.total : params.totalMean;
  const priorMargin = engineProjection && Number.isFinite(engineProjection.margin)
    ? engineProjection.margin : params.homeCourtPoints;
  if (engineProjection && Number.isFinite(engineProjection.margin)) {
    notes.push('Prior margin taken from the pre-game engine projection (team strength).');
  }

  // Prior = the same model at tip-off (full game remaining, empty scoreboard).
  const prior = {
    total: priorTotal,
    margin: priorMargin,
    sigmaTotal: params.totalStd,
    sigmaMargin: params.marginStd,
  };

  const base = {
    sport: 'basketball',
    model: 'basketball_remaining_normal',
    league: params.key,
    current: { home_score: curHome, away_score: curAway, total: curTotal, margin: curMargin },
    data_tier: game.data_tier || null,
    // The PRE-GAME anchors the O/U and spread picks are priced against: the
    // engine's own projected total/margin at tip-off, else the competition mean
    // and fitted home-court edge. They do NOT move as the game does, so the live
    // projection diverges from them and a pick's confidence moves honestly
    // instead of sitting on the model's own number.
    anchor_total: prior.total,
    anchor_margin: prior.margin,
    notes,
  };

  const progress = progressMinutes(game.live, params);
  if (progress == null) {
    notes.push('No in-game clock or period — showing the pre-game projection only.');
    const zz = z();
    // Widening sigma also softens the two-way probability toward a coin flip,
    // which is the honest posture for values nobody verified.
    const sigmaTotal = prior.sigmaTotal * widen;
    const sigmaMargin = prior.sigmaMargin * widen;
    const priorProb = homeWinProbability(prior.margin, sigmaMargin);
    return {
      ...base,
      status: 'prior_only',
      reason: 'in-game clock and period unavailable',
      inputs: {
        elapsed_minutes: null,
        remaining_minutes: null,
        period: game.live.period,
        clock: game.live.clock,
        clock_estimated: false,
      },
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

  const elapsed = progress.elapsed;
  const remaining = Math.max(0, params.gameMinutes - elapsed);
  const fraction = params.gameMinutes > 0 ? remaining / params.gameMinutes : 0;
  if (progress.estimated) {
    notes.push('No in-game clock — elapsed time taken from the start of the current period (a conservative floor).');
  }

  const endgame = remaining <= B.endgame.minutes;
  const rateMultiplier = endgame ? B.endgame.rateMultiplier : 1;
  const sigmaMultiplier = endgame ? B.endgame.sigmaMultiplier : 1;
  if (endgame) notes.push('Endgame adjustment applied (foul game).');

  const leagueRate = params.gameMinutes > 0 ? priorTotal / params.gameMinutes : 0;

  // Observed scoring rate. The league mean alone made every game in a league —
  // and every unknown league — project the SAME total, which is what produced
  // the constant "Over 219.5" reads. Instead the rate is estimated from the
  // game's own points/minute, shrunk toward the league rate by `priorMinutes`
  // of pseudo-evidence:
  //     rate = (curTotal + K * leagueRate) / (elapsed + K)
  // Early in the game K dominates (the league prior); as minutes accumulate the
  // game's real pace takes over. The result is clamped so one anomalous stretch
  // cannot dominate the projection.
  let rate = leagueRate;
  if (elapsed > 0 && leagueRate > 0) {
    const K = B.observedRate ? B.observedRate.priorMinutes : 15;
    const lo = leagueRate * (B.observedRate ? B.observedRate.minFactor : 0.55);
    const hi = leagueRate * (B.observedRate ? B.observedRate.maxFactor : 1.8);
    rate = M.clamp((curTotal + K * leagueRate) / (elapsed + K), lo, hi);
    const observed = curTotal / elapsed;
    if (Math.abs(rate - leagueRate) / leagueRate > 0.08) {
      notes.push(`Scoring pace estimated from the game itself (${observed.toFixed(2)} pts/min vs league ${leagueRate.toFixed(2)}).`);
    }
  }

  // Live-stat tempo: the game's own possessions per minute are a structural
  // pace read the score alone cannot give — a fast game tends to stay fast.
  // Applied only when the ESPN boxscore supplied possession data and enough of
  // the game has elapsed, and bounded so it can never run away with the
  // projection. Possessions already fold in FGA, turnovers and offensive boards.
  const pace = paceRead(context, params, elapsed);
  if (pace) {
    rate *= pace.factor;
    if (Math.abs(pace.ratio - 1) > 0.05) {
      notes.push(`Scoring rate nudged by the game's own pace (${pace.observed} vs league ${pace.league} possessions/min).`);
    }
  }

  // The score already on the board is FACT, not an estimate: the data-tier
  // weight must never shrink it. The blend is applied to the REMAINING
  // projection only — what is still to be played — never to the banked score.
  // A lower-confidence feed widens the uncertainty about the FUTURE without
  // erasing a real lead, which is what stops the tier weight from pulling a
  // 17-point away advantage back toward the home-court prior (the Home Win
  // bias). At weight 1 the live remaining projection is used untouched; toward
  // 0 it reverts to the prorated pre-game prior.
  const remTotal = M.blend(rate * remaining * rateMultiplier, prior.total * fraction, weight);
  // The remaining-margin mean is the prior margin prorated over the time left;
  // there is no live margin signal beyond the score already banked.
  const remMargin = priorMargin * fraction;

  const total = curTotal + remTotal;
  const margin = curMargin + remMargin;

  // Sigma is blended linearly so it stays between the (tighter) live value and
  // the (wider) prior, rather than dropping below either. It is then stretched
  // by `widen` for a hand-typed game, which widens the bands and pulls the
  // two-way probability toward a coin flip.
  const liveSigmaTotal = params.totalStd * Math.sqrt(fraction) * sigmaMultiplier;
  const liveSigmaMargin = params.marginStd * Math.sqrt(fraction) * sigmaMultiplier;
  if (liveSigmaTotal <= 0) {
    notes.push('Clock indicates the game is over; uncertainty band collapsed.');
  }
  const sigmaTotal = Math.max(0.01, M.blend(liveSigmaTotal, prior.sigmaTotal, weight)) * widen;
  const sigmaMargin = Math.max(0.01, M.blend(liveSigmaMargin, prior.sigmaMargin, weight)) * widen;

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
      clock_estimated: progress.estimated,
      rate_per_minute: M.round(rate, 3),
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

module.exports = { predictBasketball, elapsedMinutes, progressMinutes, leagueParams, paceRead };
