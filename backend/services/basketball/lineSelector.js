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
 * Confidence tier, derived from the pick's own probability AND the data quality
 * behind it. Probability alone is not enough: a 62% read off a thin sample is a
 * weaker claim than a 62% read off a verified one, so both bars must be cleared.
 * Nothing here is padded to reach a tier.
 *
 * `confirmed` (a real lineup source) is a small credit on the data-quality term
 * and can never carry a tier on its own. Verified against ESPN: the pre-game
 * core roster returns the squad but no `starter`/`active` flags, so it is false
 * in production.
 *
 * @param {Object} params
 * @param {number} params.probability - the pick's stated probability (0..1)
 * @param {number} params.dq          - data quality score (0..1)
 * @param {boolean} [params.confirmed] - verified starters for both teams
 * @param {Object} params.cfg
 */
function confidenceTier({ probability, dq, confirmed, cfg }) {
  const c = cfg.selection?.confidence || {};
  const highProb = c.highProb ?? 0.62;
  const mediumProb = c.mediumProb ?? 0.55;
  const highDQ = c.highDataQuality ?? 0.70;
  const mediumDQ = c.mediumDataQuality ?? 0.45;

  const p = Number.isFinite(probability) ? probability : 0;
  const credit = confirmed ? (c.confirmedLineupsDqCredit ?? 0.05) : 0;
  const effectiveDQ = clamp((Number.isFinite(dq) ? dq : 0) + credit, 0, 1);

  if (p >= highProb && effectiveDQ >= highDQ) return 'High';
  if (p >= mediumProb && effectiveDQ >= mediumDQ) return 'Medium';
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
        ? (cfg.modelLines?.minProb ?? 0.0)
        : (isMain ? (cfg.selection.mainMinProb ?? 0.0) : (cfg.selection.alternateMinProb ?? 0.0));

      const failReasons = [];
      // Real gates. With the shipping config these are permissive (all zero), so
      // every line passes and nothing is hidden; a line that misses a tightened
      // gate is still returned, but labelled with why it missed.
      if (effectiveMinDQ > 0 && (dataQuality ?? 0) < effectiveMinDQ) {
        failReasons.push(`data quality ${round(dataQuality, 3)} below ${effectiveMinDQ}`);
      }
      if (minProb > 0 && p < minProb) {
        failReasons.push(`probability ${round(p, 4)} below ${minProb}`);
      }
      const minEdge = cfg?.selection?.minEdge ?? 0;
      if (minEdge > 0 && edge < minEdge) {
        failReasons.push(`edge ${round(edge, 4)} below ${minEdge}`);
      }
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
        confidence: confidenceTier({ probability: p, dq: dataQuality, confirmed, cfg }),
      });
    });
  });

  return candidates;
}

/**
 * Select the best candidate for a market.
 *
 * Deliberately does NOT filter on `passes`: the product policy is to publish
 * every evaluated line with an honest label rather than hide a low-signal one.
 * `passes`/`failReasons` ride along on the returned pick so the caller can
 * label or flag it.
 *
 * @returns {Object|null}
 */
function bestOf(candidates) {
  if (!candidates.length) return null;
  return candidates.reduce((best, c) => (c.score > best.score ? c : best), candidates[0]);
}

/**
 * Full selection for one game.
 *
 * Prioritizes markets according to the configured marketPriority array.
 * Every evaluated line is returned; confidence is labelled honestly rather than
 * used to suppress a pick. No straight-winner or moneyline fallback is allowed.
 *
 * R6 — a pick is only ever published against a REAL bookmaker line. Model lines
 * are still evaluated (they ride back in `evaluated` so the callers can show the
 * model's read) but never become picks: with no market line there is no fair
 * price to beat, so publishing an "edge" against an assumed 50% would be a claim
 * we cannot back. Those games get a projection and `noPickLabel: 'no market
 * line'`, and because no pick is produced nothing is persisted, which keeps them
 * out of the hit-rate and calibration statistics.
 *
 * @param {Object} params
 * @param {Object} params.projection - adjusted projection ({ total, margin }) plus sigma
 * @param {Object} params.lines      - { total:[...], spread:[...] }
 * @param {Object} params.ctx        - { cfg, dataQuality, confirmed, homeTeamName, awayTeamName, calibrate, marketPolicy }
 * @returns {Object} { picks, noPick, noPickLabel, hasMarketLine, flags, policy, evaluated }
 */
function selectPicks({ projection, lines, ctx }) {
  const { cfg } = ctx;
  const calibrate = typeof ctx.calibrate === 'function' ? ctx.calibrate : (m, p) => p;
  const policy = ctx.marketPolicy || null;
  const policyFlags = [];
  const pickPolicy = cfg?.pickPolicy || {};
  const requireMarketLine = pickPolicy.requireMarketLine !== false;
  const noMarketLineLabel = pickPolicy.noMarketLineLabel || 'no market line';

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
  const gateFlags = [];
  const marketPriority = cfg.selection?.marketPriority || ['Total Points'];

  // Did the game have ANY real bookmaker line to pick against? Model-generated
  // lines are excluded: they are a projection read, not a market.
  const evaluated = { total: totalCandidates, spread: spreadCandidates };
  const hasMarketLine = [...totalCandidates, ...spreadCandidates].some(c => !c.isModelLine);

  // Item 6 (flag): until the ship gate has passed out of sample, a pick carries
  // its probability but NOT a tier claim we cannot yet back. The real tier rides
  // along as `confidenceRaw` for the shadow report; only 'Low' is displayed.
  const shipGatePassed = cfg?.shipGate?.passed === true;
  const hiddenTiers = pickPolicy.hideTiersUntilShipGate === false
    ? []
    : (pickPolicy.hiddenTiers || []);
  const maskTier = (pick) => {
    if (!pick || shipGatePassed || !hiddenTiers.includes(pick.confidence)) return pick;
    return { ...pick, confidenceRaw: pick.confidence, confidence: 'Low', tierHeld: true };
  };

  // Process markets in priority order
  // Primary markets: Total Points, Spread
  // Secondary markets (Team Total, First-Half, Quarter) are prepared for future data availability
  marketPriority.forEach(market => {
    const add = (pick) => {
      if (!pick) return;
      // R6: no real bookmaker line -> no pick. Nothing is published and, because
      // publication is what persists, the game never enters hit-rate or
      // calibration statistics.
      if (requireMarketLine && pick.isModelLine) {
        gateFlags.push(`${market}: ${noMarketLineLabel}`);
        return;
      }
      // A published pick that missed a gate says so instead of hiding it.
      (pick.failReasons || []).forEach(r => gateFlags.push(`${market} ${pick.selection}: ${r}`));
      picks.push(maskTier(pick));
    };
    if (market === 'Total Points') {
      add(applyPolicy(bestOf(totalCandidates), 'Total Points'));
    } else if (market === 'Spread') {
      add(applyPolicy(bestOf(spreadCandidates), 'Spread'));
    }
    // Secondary markets would be added here when period-level data becomes available
    // Example for Team Total (when data is available):
    // else if (market === 'Team Total' && lines?.teamTotal) { ... }
  });

  // No straight-winner or moneyline fallback is allowed
  // All markets show predictions regardless of threshold

  const consistencyFlags = assessConsistency({
    projTotal: projection.total, projMargin: projection.margin, cfg,
  });

  return {
    picks,
    noPick: picks.length === 0,
    // A game with no bookmaker line at all says exactly that, rather than the
    // generic label: the absence of a market is the reason, not weak confidence.
    noPickLabel: picks.length === 0 && !hasMarketLine
      ? noMarketLineLabel
      : (cfg.selection.noPickLabel || 'No confident pick'),
    hasMarketLine,
    flags: [...consistencyFlags, ...policyFlags, ...gateFlags],
    policy: policy || null,
    evaluated,
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
