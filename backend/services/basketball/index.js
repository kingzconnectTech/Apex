/**
 * basketball/index.js
 *
 * Orchestrates the basketball prediction pipeline:
 *   normalise -> ratings -> projection -> adjustments -> sigma -> calibration
 *   -> line selection -> output.
 *
 * The individual stages are pure and independently testable; this module wires
 * them together and formats the result for the API and the backtester.
 */

const CONFIG = require('./config');
const { getLeagueConfig } = require('./leagues');
const { deriveGameMetrics, buildTeamForm, normalizeGame } = require('./normalize');
const { computeTeamRatings, opponentAdjustRatings, eloDiffToMargin } = require('./ratings');
const { projectGame, pointsFromTotalMargin } = require('./projection');
const { computeAdjustments, applyAdjustments, computeDataQuality } = require('./adjustments');
const { estimateSigma } = require('./probability');
const { selectPicks } = require('./lineSelector');

/**
 * Build the line lists the selector consumes.
 *
 * When ESPN supplies bookmaker odds the real lines (overUnder / spread) are
 * used. When no odds are available but a projection exists, model-generated
 * half-point lines are synthesised from the projected total / margin so that
 * Total Points and Spread markets can still be evaluated.
 *
 * Model-generated lines carry isModelLine: true. No fabricated bookmaker prices
 * are attached — the selector handles these lines through a dedicated path.
 *
 * @param {Object|null} odds        - EspnProvider.extractBasketballOdds output
 * @param {Object|null} projection  - from projectGame / analyzeGame (optional)
 * @param {Object}      cfg         - basketball config
 */
function buildLines(odds, projection = null, cfg = CONFIG) {
  const out = { total: [], spread: [] };

  if (odds) {
    if (odds.overUnder != null && odds.overOdds != null && odds.underOdds != null) {
      out.total.push({ line: odds.overUnder, aOdds: odds.overOdds, bOdds: odds.underOdds, isMain: true, isModelLine: false });
    }
    if (odds.spread != null && odds.homeSpreadOdds != null && odds.awaySpreadOdds != null) {
      out.spread.push({ line: odds.spread, aOdds: odds.homeSpreadOdds, bOdds: odds.awaySpreadOdds, isMain: true, isModelLine: false });
    }

    // Alternates, if a richer provider ever supplies them.
    (Array.isArray(odds.totalAlternates) ? odds.totalAlternates : []).forEach(l => {
      out.total.push({ line: l.line, aOdds: l.overOdds, bOdds: l.underOdds, isMain: false, isModelLine: false });
    });
    (Array.isArray(odds.spreadAlternates) ? odds.spreadAlternates : []).forEach(l => {
      out.spread.push({ line: l.line, aOdds: l.homeOdds, bOdds: l.awayOdds, isMain: false, isModelLine: false });
    });
  }

  // ── Model-generated lines (fallback when no bookmaker lines exist) ─────────
  const ml = cfg?.modelLines;
  if (ml?.enabled && projection) {
    const impOdds = null; // no fabricated bookmaker prices
    // Total: half-point above the projected total so there is no push.
    if (out.total.length === 0 && Number.isFinite(projection.total)) {
      const line = Math.round(projection.total * 2) / 2 + (ml.totalOffsetHalfPoint ?? 0.5);
      out.total.push({ line, aOdds: impOdds, bOdds: impOdds, isMain: true, isModelLine: true });
    }
    // Spread: half-point from the projected margin so there is no push.
    if (out.spread.length === 0 && Number.isFinite(projection.margin)) {
      // Home handicap = -(margin + offset); positive margin means home is favoured.
      const line = -(Math.round(Math.abs(projection.margin) * 2) / 2 + (ml.spreadOffsetHalfPoint ?? 0.5));
      // Apply sign: if margin > 0 home is the favourite (negative handicap).
      const signedLine = projection.margin >= 0 ? line : -line;
      out.spread.push({ line: signedLine, aOdds: impOdds, bOdds: impOdds, isMain: true, isModelLine: true });
    }
  }

  return out;
}

/**
 * Run the full analysis for one game.
 *
 * @param {Object} params
 * @param {Object} params.fixture        - normalised ESPN fixture
 * @param {Object} [params.odds]         - EspnProvider.extractBasketballOdds output
 * @param {Array}  [params.injuries]     - EspnProvider.extractBasketballInjuries output
 * @param {Array}  [params.homeLog]      - raw game log for the home team (newest-first)
 * @param {Array}  [params.awayLog]      - raw game log for the away team (newest-first)
 * @param {string} params.league
 * @param {Object} [params.context]      - { travelKm, altitudeMeters, motivation }
 * @param {Object} [params.eloRatings]   - league-wide { teamId: elo }
 * @param {Object} [params.calibrator]   - calibration.Calibrator
 * @param {Object} [params.homePrior]    - real prior-season baseline for the home team
 * @param {Object} [params.awayPrior]    - real prior-season baseline for the away team
 * @param {Object} [params.observed]     - observedLeagueMean() for the current season (opt.)
 * @param {Object} [params.cfg]
 * @returns {Object|null}
 */
function analyzeGame({
  fixture, odds = null, injuries = [], homeLog = [], awayLog = [],
  league, context = null, eloRatings = null, calibrator = null, marketPolicy = null,
  homePrior = null, awayPrior = null, observed = null, cfg = CONFIG,
}) {
  if (!fixture) return null;

  try {
    const leagueCfg = getLeagueConfig(league, observed ? { observed } : null);

    const homeDerived = (homeLog || []).map(g => deriveGameMetrics(g, leagueCfg)).filter(Boolean);
    const awayDerived = (awayLog || []).map(g => deriveGameMetrics(g, leagueCfg)).filter(Boolean);

    // Extract head-to-head games from team logs
    const homeId = fixture.homeTeam?.id;
    const awayId = fixture.awayTeam?.id;
    const h2hLog = [];
    if (homeId && awayId) {
      (homeDerived || []).forEach(g => {
        if (String(g.opponentId) === String(awayId)) {
          h2hLog.push(g);
        }
      });
      // Sort newest-first
      h2hLog.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }

    const game = normalizeGame({ fixture, odds, injuries, league, h2hLog });

    const homeRatings = computeTeamRatings(homeDerived, leagueCfg, cfg, { isHomeContext: true, prior: homePrior });
    const awayRatings = computeTeamRatings(awayDerived, leagueCfg, cfg, { isHomeContext: false, prior: awayPrior });

    const homeForm = buildTeamForm(homeDerived, { isHomeContext: true });
    const awayForm = buildTeamForm(awayDerived, { isHomeContext: false });

    // Optional Elo second signal for the margin.
    let eloMargin = null;
    if (eloRatings) {
      const h = eloRatings[game.home.team.id];
      const a = eloRatings[game.away.team.id];
      if (h != null && a != null) eloMargin = eloDiffToMargin(h - a, cfg);
    }

    const baseProjection = projectGame({ home: homeRatings, away: awayRatings, leagueCfg, cfg, eloMargin });
    if (!baseProjection) {
      console.warn(`[Basketball] Failed to project game ${game.id} - baseProjection is null`);
      return null;
    }

    const adjustments = computeAdjustments({
      projection: baseProjection,
      homeRatings,
      awayRatings,
      injuries: game.injuries,
      context,
      leagueCfg,
      cfg,
    });
    const projection = applyAdjustments(baseProjection, adjustments);

    const dataQuality = computeDataQuality({
      homeRatings, awayRatings, homeForm, awayForm,
      injuries: game.injuries, odds: game.odds, lineups: game.lineups,
      leagueCfg, cfg,
    });

    // Sigma is a property of the game, not of how much we know about it — no
    // data-quality input here. Data quality flows to the confidence tier below.
    const sigma = estimateSigma({
      projTotal: projection.total,
      projMargin: projection.margin,
      expectedPossessions: projection.expectedPossessions,
      leagueCfg,
      cfg,
    });

    const projectionWithSigma = { ...projection, sigmaTotal: sigma.total, sigmaMargin: sigma.margin };

    const confirmed = !!(game.lineups.home.confirmed && game.lineups.away.confirmed);
    const calibrate = calibrator
      ? (market, p) => calibrator.apply(game.league, market, p)
      : null;

    const lines = buildLines(game.odds, projection, cfg);
    const selection = selectPicks({
      projection: projectionWithSigma,
      lines,
      ctx: {
        cfg,
        dataQuality: dataQuality.score,
        confirmed,
        homeTeamName: game.home.team.name,
        awayTeamName: game.away.team.name,
        calibrate,
        marketPolicy,
      },
    });

    return {
      game,
      leagueCfg,
      homeRatings, awayRatings,
      homeForm, awayForm,
      baseProjection,
      adjustments,
      projection: projectionWithSigma,
      sigma,
      dataQuality,
      selection,
      lines,
    };
  } catch (err) {
    console.error(`[Basketball] analyzeGame error for league ${league}:`, err.message);
    return null;
  }
}

/** Join the applied adjustments into a small list of displayable factors. */
function keyFactors(result) {
  const factors = [];
  (result.adjustments?.breakdown || []).forEach(b => {
    const parts = [];
    if (b.margin) parts.push(`margin ${b.margin > 0 ? '+' : ''}${b.margin}`);
    if (b.total) parts.push(`total ${b.total > 0 ? '+' : ''}${b.total}`);
    factors.push({
      type: b.type,
      team: b.team,
      effect: parts.join(', '),
      notes: b.notes || [],
      details: b.details || [],
    });
  });
  return factors;
}

/** Build a one-line reasoning string for a pick. */
function buildReasoning(pick, result) {
  const isTotal = pick.market === 'Total Points';
  const proj = isTotal
    ? `Projected total ${result.projection.total}`
    : `Projected margin ${result.projection.margin > 0 ? '+' : ''}${result.projection.margin}`;
  const parts = [proj];

  // Add form-based evidence (last 10 games scoring trends)
  const homeLast10 = result.homeForm?.last10;
  const awayLast10 = result.awayForm?.last10;
  if (isTotal && homeLast10 && awayLast10) {
    const avgCombined = (homeLast10.avgTotal || 0) + (awayLast10.avgTotal || 0);
    if (avgCombined > 0) {
      parts.push(`teams avg ${avgCombined.toFixed(1)} pts in last 10`);
    }
  }

  // Add head-to-head evidence when available
  if (result.game?.h2hStats && result.game.h2hStats.sampleSize > 0) {
    const h2hAvg = result.game.h2hStats.avgTotal;
    if (h2hAvg != null) {
      parts.push(`H2H avg ${h2hAvg.toFixed(1)} pts`);
    }
  }

  // Add adjustments (injuries, rest, travel, etc.)
  const relevant = (result.adjustments?.breakdown || []).filter(b => (isTotal ? b.total : b.margin));
  relevant.slice(0, 2).forEach(b => {
    const val = isTotal ? b.total : b.margin;
    const label = b.type === 'injuries' ? 'injuries' : b.type === 'fatigue' ? 'rest/fatigue' : b.type;
    parts.push(`${label} ${val > 0 ? '+' : ''}${val}`);
  });

  if (pick.edge != null) parts.push(`edge ${(pick.edge * 100).toFixed(1)}%`);
  return parts.join('; ');
}

/**
 * The raw two-way book prices for a game, both sides, as ESPN supplied them.
 *
 * Totals:  a = Over,  b = Under
 * Spread:  a = home handicap, b = away handicap (the mirrored number)
 *
 * Kept separate from `picks` so a pre-tip snapshot can record the whole market
 * (and de-vig it later) even when no pick was published for it.
 *
 * @param {Object|null} odds - EspnProvider.extractBasketballOdds output
 * @returns {Object|null} { total, spread } each null when that market has no line
 */
function buildMarketOdds(odds) {
  if (!odds) return null;
  const total = Number.isFinite(Number(odds.overUnder))
    ? {
      line: Number(odds.overUnder),
      aOdds: odds.overOdds ?? null,
      bOdds: odds.underOdds ?? null,
    }
    : null;
  const spread = Number.isFinite(Number(odds.spread))
    ? {
      line: Number(odds.spread),
      aOdds: odds.homeSpreadOdds ?? null,
      bOdds: odds.awaySpreadOdds ?? null,
    }
    : null;
  if (!total && !spread) return null;
  return { total, spread };
}

/**
 * Format the analysis into the spec's JSON output shape.
 */
function formatPrediction(result) {
  if (!result) return null;
  const { game, projection, selection, dataQuality } = result;

  const picks = (selection.picks || []).map(p => ({
    market: p.market,
    selection: p.selection,
    probability: p.probability,
    odds: p.odds,
    edge: p.edge,
    confidence: p.confidence,
    reasoning: buildReasoning(p, result),
    line: p.line,
    side: p.side,
    isMain: p.isMain,
    isModelLine: !!p.isModelLine,
    ev: p.ev,
  }));

  const riskFlags = [...(selection.flags || []), ...(result.adjustments?.flags || [])];

  return {
    game: `${game.home.team.name} vs ${game.away.team.name}`,
    gameId: game.id,
    tipoff: game.tipoff,
    league: game.leagueLabel,
    leagueKey: game.league,
    homeTeam: game.home.team,
    awayTeam: game.away.team,
    projection: {
      total: projection.total,
      margin: projection.margin,
      sigma_total: projection.sigmaTotal,
      sigma_margin: projection.sigmaMargin,
    },
    score: pointsFromTotalMargin(projection.total, projection.margin),
    picks,
    // R6: false when the game had no bookmaker line at all, so the caller can
    // render the projection with the "no market line" label and no pick.
    marketLine: selection.hasMarketLine !== false,
    // Step D: the raw book prices the engine saw, both sides, so a pre-tip line
    // snapshot can record the de-viggable market rather than only the side the
    // engine happened to pick. Null when ESPN supplied no line.
    marketOdds: buildMarketOdds(game.odds),
    noPick: selection.noPick,
    noPickLabel: selection.noPick ? selection.noPickLabel : null,
    key_factors: keyFactors(result),
    risk_flags: riskFlags,
    data_quality: dataQuality.score,
    data_quality_penalties: dataQuality.penalties,
    modelVersion: CONFIG.modelVersion,
  };
}

/** Convenience: analyse + format in one call. */
function predictGame(params) {
  return formatPrediction(analyzeGame(params));
}

module.exports = {
  CONFIG,
  buildLines,
  analyzeGame,
  formatPrediction,
  predictGame,
  keyFactors,
  buildReasoning,
  // Re-exported for callers/backtester convenience.
  opponentAdjustRatings,
};
