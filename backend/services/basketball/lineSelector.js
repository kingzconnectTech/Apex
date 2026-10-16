/**
 * basketball/lineSelector.js
 *
 * Turns model probabilities + market odds into at most one pick per market.
 *
 * For every available line it computes:
 *   - the model probability (raw win probability, push handled separately)
 *   - the fair implied probability (proper no-vig removal, not a naive 1/odds)
 *   - edge = model probability - fair implied probability
 *   - expected value per unit stake (push-aware)
 *
 * Only lines that clear the configured thresholds are selectable. Among those,
 * the best per market is chosen by  score = wProb * prob + wEv * edgeScaledEv.
 * If nothing clears, the market returns no pick — picks are never forced.
 */

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function round(v, dp = 4) {
  if (v == null || !Number.isFinite(v)) return null;
  return Number(v.toFixed(dp));
}

/** Convert American odds to decimal. Passes decimals through unchanged. */
function toDecimal(odds) {
  if (odds == null) return null;
  const n = Number(odds);
  if (!Number.isFinite(n) || n === 0) return null;
  // American odds are <= -100 or >= +100; decimal odds sit strictly between 1 and 100.
  if (n <= -100) return 1 + 100 / Math.abs(n);
  if (n >= 100) return 1 + n / 100;
  if (n > 1) return n;
  return null;
}

/**
 * Remove the vig from a two-way market.
 * Fair probabilities are the implied probabilities normalised to sum to 1.
 * @param {number[]} decimals - decimal odds
 * @returns {Object|null} { fair:number[], overround:number, implied:number[] }
 */
function removeVig(decimals) {
  const implied = decimals.map(o => (Number.isFinite(o) && o > 1 ? 1 / o : null));
  if (implied.some(v => v == null)) return null;
  const sum = implied.reduce((s, v) => s + v, 0);
  if (sum <= 0) return null;
  return {
    implied,
    fair: implied.map(v => v / sum),
    overround: sum - 1,
  };
}

/** Score a candidate for ranking (both terms bounded 0..1). */
function scoreCandidate({ probability, ev, cfg }) {
  const s = cfg.selection;
  const evScaled = clamp((ev ?? 0) / (s.evScale || 0.1), 0, 1);
  return (s.rankProbWeight ?? 0.5) * clamp(probability ?? 0, 0, 1) + (s.rankEvWeight ?? 0.5) * evScaled;
}

/**
 * Confidence tier. High requires confirmed lineups (rare with ESPN's summary);
 * borderline data quality yields Low.
 */
function confidenceTier({ dq, confirmed, cfg }) {
  const s = cfg.selection;
  const highDQ = s.confidence?.highDataQuality ?? 0.85;
  const minDQ = s.minDataQuality ?? 0.7;
  if (dq >= highDQ && confirmed) return 'High';
  if (dq >= minDQ + 0.05) return 'Medium';
  return 'Low';
}

/**
 * Consistency check between projected margin and total. Flags are advisory —
 * the pick is flagged, not silently dropped.
 */
function assessConsistency({ projTotal, projMargin, cfg }) {
  const c = cfg.selection.consistency;
  const flags = [];
  const absM = Math.abs(projMargin ?? 0);
  if (absM >= (c.bigMargin ?? 10)) {
    if (projTotal < (c.minTotalForBigMargin ?? 205)) {
      flags.push(`Large margin (${round(projMargin, 1)}) with a low total (${round(projTotal, 1)}) — verify pace explains it`);
    } else if (projTotal > (c.maxTotalForBigMargin ?? 245)) {
      flags.push(`Large margin (${round(projMargin, 1)}) with a very high total (${round(projTotal, 1)}) — verify pace explains it`);
    }
  }
  return flags;
}

/** Detect whether a line has moved away from its opening number. */
function lineMovement(open, current, tol = 0.5) {
  if (!Number.isFinite(open) || !Number.isFinite(current)) return { moved: false, from: open ?? null, to: current ?? null, delta: null };
  const delta = current - open;
  return { moved: Math.abs(delta) >= tol, from: open, to: current, delta: round(delta, 2) };
}

/**
 * Evaluate a two-way market.
 *
 * @param {Object} params
 * @param {Array} params.lines     - [{ line, aOdds, bOdds, isMain }]
 * @param {Function} params.probFn - (line) => { a, b, push } raw model probabilities
 * @param {Function} [params.nameFn] - (side) => display selection text
 * @param {string} params.market
 * @param {number} params.sigma    - sigma used for probability (for reporting)
 * @param {Object} params.ctx      - { cfg, dataQuality, confirmed, homeTeamName, awayTeamName }
 */
function evaluateTwoWayMarket({ lines, probFn, nameFn, market, sigma, ctx }) {
  const { cfg, dataQuality, confirmed } = ctx;
  const minDQ = cfg.selection.minDataQuality ?? 0.7;
  const candidates = [];

  (Array.isArray(lines) ? lines : []).forEach(raw => {
    const isMain = raw?.isMain !== false; // default to main when unspecified
    const line = Number(raw?.line);
    if (!Number.isFinite(line)) return;

    const isModelLine = raw?.isModelLine === true || (raw.aOdds == null && raw.bOdds == null && cfg?.modelLines?.enabled);

    const aOdds = toDecimal(raw.aOdds);
    const bOdds = toDecimal(raw.bOdds);
    const vig = (!isModelLine && aOdds && bOdds) ? removeVig([aOdds, bOdds]) : null;
    if (!isModelLine && !vig) return; // no odds -> cannot value the line without modelLines

    const probs = probFn(line);
    if (!probs || probs.a == null || probs.b == null) return;

    const sides = isModelLine
      ? [{ side: 'a', p: probs.a, o: null, fair: cfg?.modelLines?.impliedProb ?? 0.5 },
         { side: 'b', p: probs.b, o: null, fair: cfg?.modelLines?.impliedProb ?? 0.5 }]
      : [{ side: 'a', p: probs.a, o: aOdds, fair: vig.fair[0] },
         { side: 'b', p: probs.b, o: bOdds, fair: vig.fair[1] }];

    sides.forEach(({ side, p, o, fair }) => {
      const push = probs.push ?? 0;
      const other = side === 'a' ? probs.b : probs.a;

      // Normalise away the push for edge comparison against fair prob.
      const denom = p + other;
      const edgeProb = denom > 0 ? p / denom : p;
      const edge = edgeProb - fair;

      // Push-aware EV per unit stake (only calculated when bookmaker odds exist).
      const ev = o != null ? (p * (o - 1) - other) : null;

      const effectiveMinDQ = isModelLine
        ? (cfg.modelLines?.minDataQuality ?? 0.75)
        : minDQ;

      const minProb = isModelLine
        ? (cfg.modelLines?.minProb ?? 0.65)
        : (isMain ? (cfg.selection.mainMinProb ?? 0.6) : (cfg.selection.alternateMinProb ?? 0.68));

      const failReasons = [];
      if (dataQuality < effectiveMinDQ) failReasons.push(`data quality ${round(dataQuality, 2)} < ${effectiveMinDQ}`);
      if (p < minProb) failReasons.push(`probability ${round(p, 3)} < ${minProb}`);
      if (edge < (cfg.selection.minEdge ?? 0.04)) failReasons.push(`edge ${round(edge, 3)} < ${cfg.selection.minEdge}`);

      const passes = failReasons.length === 0;
      const score = scoreCandidate({ probability: p, ev, cfg });

      const baseSelection = nameFn ? nameFn(side, line, ctx) : `${side} ${line}`;
      const selection = isModelLine ? `${baseSelection} (Model Line)` : baseSelection;

      candidates.push({
        market,
        line,
        isMain,
        isModelLine: !!isModelLine,
        side,
        selection,
        probability: round(p, 4),
        push: round(push, 4),
        odds: round(o, 3),
        fairImplied: round(fair, 4),
        edge: round(edge, 4),
        ev: round(ev, 4),
        score: round(score, 4),
        sigma,
        passes,
        failReasons,
        confidence: confidenceTier({ dq: dataQuality, confirmed, cfg }),
      });
    });
  });

  return candidates;
}

/**
 * Select the best passing candidate for a market.
 * @returns {Object|null}
 */
function bestOf(candidates) {
  const passing = candidates.filter(c => c.passes);
  if (!passing.length) return null;
  return passing.reduce((best, c) => (c.score > best.score ? c : best), passing[0]);
}

/**
 * Full selection for one game.
 *
 * @param {Object} params
 * @param {Object} params.projection - adjusted projection ({ total, margin }) plus sigma
 * @param {Object} params.lines      - { total:[...], spread:[...] }
 * @param {Object} params.ctx        - { cfg, dataQuality, confirmed, homeTeamName, awayTeamName, calibrate, marketPolicy }
 * @returns {Object} { picks, noPick, noPickLabel, flags, policy, evaluated }
 */
function selectPicks({ projection, lines, ctx }) {
  const { cfg } = ctx;
  const calibrate = typeof ctx.calibrate === 'function' ? ctx.calibrate : (m, p) => p;
  const policy = ctx.marketPolicy || null;
  const policyFlags = [];

  const sigmaTotal = projection.sigmaTotal;
  const sigmaMargin = projection.sigmaMargin;

  const { totalsProbability, spreadProbability } = require('./probability');

  const totalCandidates = evaluateTwoWayMarket({
    lines: lines?.total,
    market: 'Total Points',
    sigma: sigmaTotal,
    ctx,
    probFn: (line) => {
      const r = totalsProbability({ line, projTotal: projection.total, sigmaTotal, cfg });
      return { a: calibrate('total_over', r.over), b: calibrate('total_under', r.under), push: r.push };
    },
    nameFn: (side, line) => (side === 'a' ? `Over ${line}` : `Under ${line}`),
  });

  const spreadCandidates = evaluateTwoWayMarket({
    lines: lines?.spread,
    market: 'Spread',
    sigma: sigmaMargin,
    ctx,
    probFn: (line) => {
      const r = spreadProbability({ spread: line, projMargin: projection.margin, sigmaMargin, cfg });
      return { a: calibrate('spread_home', r.home), b: calibrate('spread_away', r.away), push: r.push };
    },
    nameFn: (side, line, c) => {
      const home = c.homeTeamName || 'Home';
      const away = c.awayTeamName || 'Away';
      if (side === 'a') return `${home} ${line > 0 ? '+' : ''}${line}`;
      return `${away} ${-line > 0 ? '+' : ''}${-line}`;
    },
  });

  const TIERS = ['Low', 'Medium', 'High'];

  /**
   * Apply the live auto-downgrade policy for a market to a selected pick.
   * 'disabled' -> drop the pick; 'downgraded' -> step the confidence tier down one.
   */
  const applyPolicy = (pick, market) => {
    const st = policy ? policy[market] : null;
    if (!st || st === 'active') return pick;
    if (st === 'disabled') {
      policyFlags.push(`${market} pick withheld — market auto-disabled by rolling performance`);
      return null;
    }
    // downgraded
    const i = TIERS.indexOf(pick.confidence);
    const next = i > 0 ? TIERS[i - 1] : 'Low';
    policyFlags.push(`${market} confidence downgraded ${pick.confidence} -> ${next} (rolling performance)`);
    return { ...pick, confidence: next, downgraded: true };
  };

  const picks = [];
  const totalPick = applyPolicy(bestOf(totalCandidates), 'Total Points');
  if (totalPick) picks.push(totalPick);
  const spreadPick = applyPolicy(bestOf(spreadCandidates), 'Spread');
  if (spreadPick) picks.push(spreadPick);

  const consistencyFlags = assessConsistency({
    projTotal: projection.total, projMargin: projection.margin, cfg,
  });

  return {
    picks,
    noPick: picks.length === 0,
    noPickLabel: cfg.selection.noPickLabel || 'No confident pick',
    flags: [...consistencyFlags, ...policyFlags],
    policy: policy || null,
    evaluated: { total: totalCandidates, spread: spreadCandidates },
  };
}

module.exports = {
  toDecimal,
  removeVig,
  scoreCandidate,
  confidenceTier,
  assessConsistency,
  lineMovement,
  evaluateTwoWayMarket,
  bestOf,
  selectPicks,
};
