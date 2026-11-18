/**
 * live/soccerLive.js
 *
 * Phase 4 — football live model.
 *
 * Approach: only the REMAINING goals are modelled, then added to the current
 * score. The remaining-goal rates come from a full-match baseline scaled by the
 * fraction of the match still to play, then adjusted for:
 *   - the current score (trailing sides push, leading sides sit back),
 *   - red cards (a man down shifts the rate split toward the other side),
 *   - shot pressure (observed shots-on-target share blended into the split),
 * and the joint distribution carries a Dixon-Coles low-score dependence term.
 *
 * Because the remaining window is the whole match at kick-off, the output at
 * minute 0 equals the pre-game projection — there is no jump when play starts.
 * Every knob lives in ./config (liveModel.soccer). Nothing is invented here.
 *
 * Inputs are the Phase 3 LiveGame plus an OPTIONAL `context`:
 *   - red_cards / shots_on_target (legacy flat fields),
 *   - stats: normalised live statistics from liveStats.js ({home,away}),
 *   - momentum: recorded stat deltas ({pressure_share_home, ...}).
 * When a context piece is missing the corresponding adjustment is skipped
 * and said so in `notes`.
 */

const CONFIG = require('./config');
const M = require('./liveMath');

const S = CONFIG.liveModel.soccer;
const LEVEL = CONFIG.liveModel.uncertaintyLevel;

/**
 * Elapsed match minutes, or null if unknowable.
 *
 * ESPN's soccer `displayClock` is the CUMULATIVE match minute ("34'", "90'+7'")
 * — verified against a live scoreboard pull — so no half offset is applied.
 */
function elapsedMinutes(live) {
  const parsed = M.parseClock(live && live.clock);
  if (!parsed) return null;
  return M.clamp(parsed.minutes, 0, S.regulationMinutes);
}

/** Score-effect multiplier for one side, given its score minus the opponent's. */
function scoreMultiplier(diff) {
  const e = S.scoreEffect;
  if (diff > 0) return M.clamp(1 - e.leadingDrag * diff, e.min, e.max);
  if (diff < 0) return M.clamp(1 + e.trailingBoost * -diff, e.min, e.max);
  return 1;
}

/** Red-card shift applied symmetrically to both rates. */
function redCardShift(ownCards, oppCards) {
  const e = S.redCard;
  const own = Math.min(e.maxShift, e.rateShift * (ownCards || 0));
  const opp = Math.min(e.maxShift, e.rateShift * (oppCards || 0));
  return { own, opp };
}

/**
 * Blend the observed shots-on-target share into the base rate split, keeping the
 * combined rate unchanged (we redistribute, we do not inflate).
 */
function applyShotPressure(lambdaHome, lambdaAway, sot) {
  const total = (sot && sot.home != null && sot.away != null) ? sot.home + sot.away : 0;
  if (total < S.shotPressure.minShots) return null;
  const combined = lambdaHome + lambdaAway;
  if (!(combined > 0)) return null;
  const observed = sot.home / total;
  const baseShare = lambdaHome / combined;
  const share = (1 - S.shotPressure.weight) * baseShare + S.shotPressure.weight * observed;
  return { home: combined * share, away: combined * (1 - share) };
}

/**
 * Weighted attacking-threat share for one side from normalised live stats.
 * Only components present for BOTH sides count; weights are renormalised over
 * what is available so a missing stat never counts as zero.
 */
function threatShare(stats) {
  const cfg = S.threatShare || {};
  const comps = cfg.components || {};
  if (!stats || !stats.home || !stats.away) return null;
  const h = stats.home;
  const a = stats.away;
  let wSum = 0;
  let hSum = 0;
  for (const [field, w] of Object.entries(comps)) {
    const hv = h[field];
    const av = a[field];
    if (hv == null || av == null || !(hv + av > 0)) continue;
    wSum += w;
    hSum += w * (hv / (hv + av));
  }
  const evidence = wSum > 0 ? Object.keys(comps).filter(f => h[f] != null && a[f] != null && (h[f] + a[f]) > 0).length : 0;
  if (wSum <= 0 || evidence < (cfg.minEvidence || 0)) return null;
  return { homeShare: hSum / wSum, evidence };
}

/**
 * Blend the observed threat share into the base rate split, keeping the
 * combined rate unchanged (redistribute, never inflate).
 */
function applyThreatShare(lambdaHome, lambdaAway, share, weight) {
  const combined = lambdaHome + lambdaAway;
  if (!(combined > 0)) return null;
  const baseShare = lambdaHome / combined;
  const blended = (1 - weight) * baseShare + weight * share.homeShare;
  return { home: combined * blended, away: combined * (1 - blended) };
}

/**
 * Scale both remaining-goal rates toward the observed scoring tempo.
 * Returns a multiplier in [scaleMin, scaleMax] or 1 when there is not
 * enough elapsed match / expected goals to judge.
 */
function tempoScale(elapsed, curHome, curAway) {
  const cfg = S.tempo || {};
  if (elapsed == null || elapsed < (cfg.minElapsed || 0)) return 1;
  const expectedSoFar = (S.baseHomeGoals + S.baseAwayGoals) * (elapsed / S.regulationMinutes);
  const actual = (curHome || 0) + (curAway || 0);
  if (expectedSoFar < 1) return 1;
  const ratio = actual / expectedSoFar;
  const w = cfg.weight != null ? cfg.weight : 0.5;
  const raw = 1 + (ratio - 1) * w;
  return M.clamp(raw, cfg.scaleMin != null ? cfg.scaleMin : 0.8, cfg.scaleMax != null ? cfg.scaleMax : 1.3);
}

/**
 * Joint pmf of remaining goals, with the Dixon-Coles low-score adjustment, then
 * renormalised. Indexed [homeGoals][awayGoals].
 */
function remainingMatrix(lambdaHome, lambdaAway) {
  const max = S.maxRemainingGoals;
  const matrix = [];
  for (let h = 0; h <= max; h++) {
    matrix.push([]);
    for (let a = 0; a <= max; a++) {
      const tau = M.dixonColesTau(h, a, lambdaHome, lambdaAway, S.rho);
      matrix[h].push(Math.max(0, M.poissonPmf(h, lambdaHome) * M.poissonPmf(a, lambdaAway) * tau));
    }
  }
  let total = 0;
  for (let h = 0; h <= max; h++) for (let a = 0; a <= max; a++) total += matrix[h][a];
  if (total > 0) for (let h = 0; h <= max; h++) for (let a = 0; a <= max; a++) matrix[h][a] /= total;
  return matrix;
}

/** Reduce a remaining-goals matrix (plus the current score) to outcomes. */
function outcomes(matrix, curHome, curAway) {
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let expHome = 0;
  let expAway = 0;
  const totals = new Map();
  const margins = new Map();
  const add = (map, key, p) => map.set(key, (map.get(key) || 0) + p);

  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      const p = matrix[h][a];
      if (p === 0) continue;
      const fh = curHome + h;
      const fa = curAway + a;
      expHome += fh * p;
      expAway += fa * p;
      if (fh > fa) homeWin += p;
      else if (fh === fa) draw += p;
      else awayWin += p;
      add(totals, fh + fa, p);
      add(margins, fh - fa, p);
    }
  }
  const pairs = map => [...map.entries()].map(([value, prob]) => ({ value, prob }));
  return {
    homeWin, draw, awayWin, expHome, expAway,
    totalPairs: pairs(totals),
    marginPairs: pairs(margins),
  };
}

/**
 * Central uncertainty band from a distribution, optionally WIDENED by `widen`
 * around its own midpoint. Hand-typed games get a stretched band because
 * nothing about them was verified (config liveModel.manual.uncertaintyWiden).
 */
function band(pairs, widen = 1) {
  const lo = M.quantileFromPairs(pairs, (1 - LEVEL) / 2);
  const hi = M.quantileFromPairs(pairs, (1 + LEVEL) / 2);
  if (lo == null || hi == null || widen === 1) return { low: lo, high: hi };
  const center = (lo + hi) / 2;
  return {
    low: M.round(center - (center - lo) * widen, 2),
    high: M.round(center + (hi - center) * widen, 2),
  };
}

function summarize(o) {
  return {
    expected: {
      home_score: M.round(o.expHome, 2),
      away_score: M.round(o.expAway, 2),
      total: M.round(o.expHome + o.expAway, 2),
      margin: M.round(o.expHome - o.expAway, 2),
    },
    probabilities: {
      home_win: M.round(o.homeWin, 4),
      draw: M.round(o.draw, 4),
      away_win: M.round(o.awayWin, 4),
    },
  };
}

/**
 * @param {Object} args
 * @param {Object} args.game    Phase 3 LiveGame
 * @param {Object} [args.context] { red_cards, shots_on_target, stats, momentum }
 *   — ignored for a hand-typed game, which carries no provider events
 * @param {number} args.weight  live-vs-prior blend weight (from liveModel.tierWeight)
 * @param {boolean} [args.manual] true for a hand-typed game (wider bands)
 */
function predictSoccer({ game, context = {}, weight = 1, manual = false } = {}) {
  const notes = [];
  const widen = manual ? CONFIG.liveModel.manual.uncertaintyWiden : 1;
  if (manual) {
    notes.push('Hand-typed values: the estimate is pulled toward the pre-game prior and the uncertainty band is widened.');
  }
  const curHome = game.home && game.home.score != null ? game.home.score : 0;
  const curAway = game.away && game.away.score != null ? game.away.score : 0;

  // The prior is the same model at kick-off: full-match baseline, no score.
  const priorOutcome = outcomes(remainingMatrix(S.baseHomeGoals, S.baseAwayGoals), 0, 0);
  const prior = summarize(priorOutcome);

  const base = {
    sport: 'soccer',
    model: 'soccer_remaining_poisson_dc',
    current: {
      home_score: curHome, away_score: curAway, total: curHome + curAway, margin: curHome - curAway,
    },
    data_tier: game.data_tier || null,
    blend: { weight, tier: game.data_tier || null, prior_used: weight < 1 },
    notes,
  };

  const elapsed = elapsedMinutes(game.live);
  if (elapsed == null) {
    notes.push('No in-game clock — showing the pre-game projection only.');
    return {
      ...base,
      status: 'prior_only',
      reason: 'in-game clock unavailable',
      inputs: { elapsed_minutes: null, remaining_minutes: null, period: game.live.period, clock: game.live.clock },
      expected: prior.expected,
      probabilities: prior.probabilities,
      // The full final-total distribution (current score already folded in), for
      // the Over/Under pick. [{ value, prob }], summing to 1.
      total_distribution: priorOutcome.totalPairs,
      uncertainty: {
        level: LEVEL,
        total: band(priorOutcome.totalPairs, widen),
        margin: band(priorOutcome.marginPairs, widen),
      },
      blend: { weight: 0, tier: game.data_tier || null, prior_used: true },
    };
  }

  const remaining = Math.max(0, S.regulationMinutes - elapsed);
  const fraction = remaining / S.regulationMinutes;
  let lambdaHome = S.baseHomeGoals * fraction;
  let lambdaAway = S.baseAwayGoals * fraction;

  const multHome = scoreMultiplier(curHome - curAway);
  const multAway = scoreMultiplier(curAway - curHome);
  lambdaHome *= multHome;
  lambdaAway *= multAway;
  if (multHome !== 1 || multAway !== 1) notes.push('Score effect applied.');

  // Normalised live stats (liveStats.js) supply the same signals under
  // friendlier names; fall back to them when the legacy fields are absent.
  const stats = context.stats || null;
  const statSide = side => (stats && stats[side]) || {};
  const rc = context.red_cards || {
    home: statSide('home').red_cards,
    away: statSide('away').red_cards,
  };
  if (rc && (rc.home != null || rc.away != null)) {
    const shift = redCardShift(rc.home || 0, rc.away || 0);
    lambdaHome *= (1 - shift.own) * (1 + shift.opp);
    lambdaAway *= (1 - shift.opp) * (1 + shift.own);
    notes.push('Red-card adjustment applied.');
  } else {
    notes.push('No red-card data available.');
  }

  const sotSideH = statSide('home').shots_on_target;
  const sotSideA = statSide('away').shots_on_target;
  const sot = context.shots_on_target || {
    home: sotSideH != null || sotSideA != null ? (sotSideH || 0) : null,
    away: sotSideA != null || sotSideH != null ? (sotSideA || 0) : null,
  };
  const pressured = applyShotPressure(lambdaHome, lambdaAway, sot);
  if (pressured) {
    lambdaHome = pressured.home;
    lambdaAway = pressured.away;
    notes.push('Shot-pressure adjustment applied.');
  } else {
    notes.push('No shot data (or too few shots) — shot pressure not applied.');
  }

  // --- Live-statistics adjustments (only when real stats arrived) ---
  const share = threatShare(stats);
  if (share) {
    const tilted = applyThreatShare(lambdaHome, lambdaAway, share, S.threatShare.weight);
    if (tilted) {
      lambdaHome = tilted.home;
      lambdaAway = tilted.away;
      notes.push(`Live-stat threat share applied (${share.evidence} components).`);
    }
  }

  const scale = tempoScale(elapsed, curHome, curAway);
  if (scale !== 1) {
    lambdaHome *= scale;
    lambdaAway *= scale;
    notes.push(scale > 1 ? 'Match is more open than baseline — goal rates scaled up.' : 'Match is tighter than baseline — goal rates scaled down.');
  }

  const mt = context.momentum;
  if (mt && mt.pressure_share_home != null) {
    const t = (mt.pressure_share_home - 0.5) * 2 * (S.momentum.maxTilt || 0.08);
    if (Math.abs(t) >= 0.005) {
      const combined = lambdaHome + lambdaAway;
      const baseShareH = lambdaHome / combined;
      const shareH = M.clamp(baseShareH + t / 2, 0.02, 0.98);
      lambdaHome = combined * shareH;
      lambdaAway = combined * (1 - shareH);
      notes.push('Momentum adjustment applied from recorded stat deltas.');
    }
  }

  const liveOutcome = outcomes(remainingMatrix(lambdaHome, lambdaAway), curHome, curAway);
  const live = summarize(liveOutcome);

  const blendProbability = (l, p) => M.round(M.blend(l, p, weight), 4);
  const probabilities = {
    home_win: blendProbability(live.probabilities.home_win, prior.probabilities.home_win),
    draw: blendProbability(live.probabilities.draw, prior.probabilities.draw),
    away_win: blendProbability(live.probabilities.away_win, prior.probabilities.away_win),
  };
  // Re-normalise after blending so the three outcomes still sum to exactly 1.
  const sum = probabilities.home_win + probabilities.draw + probabilities.away_win;
  if (sum > 0) {
    probabilities.home_win = M.round(probabilities.home_win / sum, 4);
    probabilities.draw = M.round(probabilities.draw / sum, 4);
    probabilities.away_win = M.round(1 - probabilities.home_win - probabilities.draw, 4);
  }

  return {
    ...base,
    status: 'live',
    reason: null,
    inputs: {
      elapsed_minutes: M.round(elapsed, 2),
      remaining_minutes: M.round(remaining, 2),
      period: game.live.period,
      clock: game.live.clock,
      lambda_home: M.round(lambdaHome, 3),
      lambda_away: M.round(lambdaAway, 3),
    },
    expected: {
      home_score: M.round(M.blend(live.expected.home_score, prior.expected.home_score, weight), 2),
      away_score: M.round(M.blend(live.expected.away_score, prior.expected.away_score, weight), 2),
      total: M.round(M.blend(live.expected.total, prior.expected.total, weight), 2),
      margin: M.round(M.blend(live.expected.margin, prior.expected.margin, weight), 2),
    },
    probabilities,
    // The full final-total distribution (current score already folded in), for
    // the Over/Under pick. [{ value, prob }], summing to 1.
    total_distribution: liveOutcome.totalPairs,
    uncertainty: {
      level: LEVEL,
      total: band(liveOutcome.totalPairs, widen),
      margin: band(liveOutcome.marginPairs, widen),
    },
  };
}

module.exports = { predictSoccer, elapsedMinutes, scoreMultiplier };
