/**
 * live/analysis.js
 *
 * Phase 6 — turn a matched LiveGame into the single payload the UI renders, and
 * enforce the ship gate at the moment the payload is built.
 *
 * The gate is applied HERE, in the one function every route goes through, so
 * there is exactly one place where a probability can escape and one place where
 * it can be withheld. When the gate refuses, `probabilities`, `projection` and
 * `uncertainty` are `null` — not zeroed, not softened — and `ship_gate.reason`
 * explains why. The UI has nothing to render but the score, the clock and the
 * facts.
 *
 * Nothing in this file invents a number: every figure is either a model output
 * (services/live/soccerLive, basketballLive) or a plain derivation from one
 * (next-goal, remaining points), and every derivation is unit-tested.
 */

const CONFIG = require('./config');
const { buildLiveGame } = require('./liveGame');
const { predictLive } = require('./liveModel');
const { mayShipPick, shadowSports } = require('./policy');
const { derivePicks } = require('./livePicks');
const liveCalibrator = require('./liveCalibrator');
const forwardTest = require('./forwardTest');
const shadowCandidates = require('./shadowCandidates');
const liveContext = require('./liveContext');
const liveStats = require('./liveStats');
const liveMarkets = require('./liveMarkets');
const M = require('./liveMath');

const CFG = CONFIG.liveApi;

/**
 * Game sources that belong to the external score-site feed (matchFeed.js)
 * rather than the ESPN sweep. A game from one of these carries a
 * `<source>:<provider_id>` game_id and is refreshed against the feed itself,
 * never against the ESPN matcher.
 */
const FEED_SOURCES = new Set(['livescore', 'flashscore']);

/** UI display modes. `context_only` means no model figure is shown at all. */
const DISPLAY_MODES = {
  FULL: 'full',
  PRIOR_ONLY: 'prior_only',
  CONTEXT_ONLY: 'context_only',
};

const MODE_LABELS = {
  [DISPLAY_MODES.FULL]: 'Live probabilities',
  [DISPLAY_MODES.PRIOR_ONLY]: 'Pre-game projection (no in-game clock)',
  [DISPLAY_MODES.CONTEXT_ONLY]: 'Score, time and context only',
};

/**
 * A private channel for the figure that was computed but WITHHELD. The shadow
 * log (Phase 9) needs the number the model produced even while the ship gate
 * refuses to show it. It is attached as a non-enumerable, Symbol-keyed property,
 * so it can never ride along in a payload: JSON.stringify drops symbols, object
 * spread drops non-enumerables, and only this module holds the key.
 */
const SHADOW = Symbol('live.shadow');

/* ------------------------------------------------------------------- cache */

const games = new Map();
const analyses = new Map();

/** Cache partitions the payload by audience, so a refusal can never leak to a
 *  tester (and a tester's preview is not served to the public). */
function audienceKey(audience) {
  return audience === 'testers' ? 'testers' : 'public';
}

/** Remember a resolved game so `/analysis` can be polled for it. */
function rememberGame(game, now = Date.now()) {
  if (!game || !game.game_id) return null;
  games.set(game.game_id, { game, cached_at: now });
  // Insertion-ordered eviction: the oldest resolved game goes first.
  while (games.size > CFG.maxCachedGames) {
    const oldest = games.keys().next();
    if (oldest.done) break;
    games.delete(oldest.value);
  }
  return game.game_id;
}

/** @returns {{game:Object, cached_at:number}|null} null when unknown or expired. */
function recallGame(gameId, now = Date.now()) {
  const hit = games.get(gameId);
  if (!hit) return null;
  if (now - hit.cached_at > CFG.gameTtlMs) {
    games.delete(gameId);
    return null;
  }
  return hit;
}

function cacheKey(gameId, audience) {
  return `${gameId}::${audienceKey(audience)}`;
}

function getCachedAnalysis(gameId, audience = 'public', now = Date.now()) {
  const key = cacheKey(gameId, audience);
  const hit = analyses.get(key);
  if (!hit) return null;
  if (now >= hit.expires_at) {
    analyses.delete(key);
    return null;
  }
  return hit.payload;
}

function putCachedAnalysis(gameId, payload, audience = 'public', now = Date.now()) {
  analyses.set(cacheKey(gameId, audience), { payload, expires_at: now + CFG.analysisTtlMs });
  return payload;
}

/** Test/dev helper — the caches are process-wide on purpose. */
function resetCache() {
  games.clear();
  analyses.clear();
}

/* -------------------------------------------------------------- derivations */

/**
 * Next-goal split for soccer, from the model's own remaining-goal rates. The
 * three outcomes are renormalised so "home" + "away" + "no more goals" = 1.
 *
 * Returns null when the model did not report usable rates (rather than guessing).
 */
function nextGoal(inputs, rho = CONFIG.liveModel.soccer.rho) {
  const lh = inputs && inputs.lambda_home;
  const la = inputs && inputs.lambda_away;
  if (!Number.isFinite(lh) || !Number.isFinite(la) || lh <= 0 || la <= 0) return null;

  const none = M.poissonPmf(0, lh) * M.poissonPmf(0, la) * M.dixonColesTau(0, 0, lh, la, rho);
  const pNone = M.clamp(none, 1e-6, 1 - 1e-6);
  // P(home scores next) = P(a goal happens) * share of the remaining intensity.
  const pHome = (1 - pNone) * (lh / (lh + la));
  const pAway = (1 - pNone) * (la / (lh + la));
  const total = pHome + pAway + pNone;
  if (!(total > 0)) return null;
  return {
    home: M.round(pHome / total, 4),
    away: M.round(pAway / total, 4),
    none: M.round(pNone / total, 4),
  };
}

/** Expected final score plus what is still to come, from the model's own output. */
function projectionFor(model, game) {
  if (!model || !model.expected) return null;
  const curHome = game.home && game.home.score != null ? game.home.score : 0;
  const curAway = game.away && game.away.score != null ? game.away.score : 0;
  const e = model.expected;

  const base = {
    expected_final: { home: e.home_score, away: e.away_score, total: e.total, margin: e.margin },
    remaining: {
      home: M.round(e.home_score - curHome, 2),
      away: M.round(e.away_score - curAway, 2),
      total: M.round(e.total - (curHome + curAway), 2),
    },
  };

  if (game.sport === 'soccer') {
    const ng = model.inputs ? nextGoal(model.inputs) : null;
    return { ...base, next_goal: ng };
  }
  // Basketball: the margin/total bands are the actionable projection, and the
  // normal approximation makes them exact rather than a re-derivation.
  if (model.sigma) {
    return {
      ...base,
      total_line: { line: e.total, sigma: model.sigma.total },
      margin_line: { line: e.margin, sigma: model.sigma.margin },
    };
  }
  return base;
}

/* ----------------------------------------------------------------- factors */

/**
 * Human-readable facts behind the numbers. Every entry is either something the
 * provider told us or something the model reported about itself — no inferred
 * stories, and no event we never received (we have no play-by-play here, so we
 * never claim "red card at 34'").
 */
function buildFactors({ game, model, context = {}, stats = null }) {
  const factors = [];
  const homeName = (game.home && game.home.name) || 'Home';
  const awayName = (game.away && game.away.name) || 'Away';
  const live = game.live || {};

  if (model && model.inputs && model.inputs.elapsed_minutes != null) {
    factors.push({
      label: 'Time played',
      detail: `${model.inputs.elapsed_minutes} min played, ${model.inputs.remaining_minutes} min remaining (period ${model.inputs.period}).`,
    });
  }
  if (live.status && live.status !== 'live') {
    factors.push({ label: 'Status', detail: `The game is ${live.status}.` });
  }
  if (game.data_tier) {
    factors.push({
      label: 'Data quality',
      detail: `${game.data_tier_label || game.data_tier} — tier "${game.data_tier}".`,
    });
  }
  if (game.match && game.match.orientation === 'swapped') {
    factors.push({
      label: 'Orientation',
      detail: 'The link listed the teams in the opposite order to the fixture; the projection follows the fixture.',
    });
  }
  if (game.manual) {
    factors.push({
      label: 'Unverified input',
      detail: 'These values were typed in by you and were not checked against a provider.',
    });
  }

  // Live-stat facts (only what the provider actually reported).
  if (stats && stats.home && stats.away) {
    const h = stats.home, a = stats.away;
    const statFact = (label, hv, av, unit = '') => {
      if (hv != null && av != null) {
        factors.push({ label, detail: `${hv}${unit} - ${av}${unit} (${homeName} vs ${awayName}).` });
      }
    };
    statFact('Possession', h.possession_pct, a.possession_pct, '%');
    statFact('Shots', h.shots, a.shots);
    statFact('Shots on target', h.shots_on_target, a.shots_on_target);
    statFact('Corners', h.corners, a.corners);
    statFact('Cards', h.cards_total, a.cards_total);
  }
  const rc = context.red_cards;
  if (rc && (rc.home || rc.away)) {
    const down = rc.home ? homeName : awayName;
    factors.push({
      label: 'Red card',
      detail: `${down} are a player down (${rc.home ? 'home' : 'away'} side).`,
    });
  }
  if (model && Array.isArray(model.notes)) {
    model.notes.forEach(note => factors.push({ label: 'Model note', detail: note }));
  }
  return factors;
}

/* ------------------------------------------------------- explanations */

/**
 * "Why Apex predicts this" — short factual bullets generated ONLY from data
 * that actually arrived (live stats, momentum deltas, model notes). Nothing
 * is inferred beyond what the numbers say.
 */
function buildWhy({ game, model, stats = null, momentum = null }) {
  const why = [];
  const h = stats && stats.home;
  const a = stats && stats.away;
  const has = f => h && a && h[f] != null && a[f] != null;

  if (has('shots_on_target')) {
    if (h.shots_on_target > a.shots_on_target) why.push(`Home leads shots on target ${h.shots_on_target}-${a.shots_on_target}.`);
    else if (a.shots_on_target > h.shots_on_target) why.push(`Away leads shots on target ${a.shots_on_target}-${h.shots_on_target}.`);
  }
  if (has('shots')) {
    if (h.shots > a.shots) why.push(`Home has more total shots (${h.shots} vs ${a.shots}).`);
    else if (a.shots > h.shots) why.push(`Away has more total shots (${a.shots} vs ${h.shots}).`);
  }
  if (has('corners') && Math.abs((h.corners || 0) - (a.corners || 0)) >= 3) {
    why.push(`Corner pressure favours ${h.corners > a.corners ? 'home' : 'away'} (${h.corners || 0}-${a.corners || 0}).`);
  }
  if (has('possession_pct') && Math.abs((h.possession_pct || 0) - (a.possession_pct || 0)) >= 10) {
    why.push(`Possession favours ${h.possession_pct > a.possession_pct ? 'home' : 'away'} (${h.possession_pct}% vs ${a.possession_pct}%).`);
  }
  const rcH = h && h.red_cards, rcA = a && a.red_cards;
  if ((rcH || 0) > 0 || (rcA || 0) > 0) {
    why.push(rcH > rcA ? 'Home is playing with fewer players (red card).' : 'Away is playing with fewer players (red card).');
  }
  if (momentum && momentum.pressure_share_home != null && momentum.window_minutes >= 3) {
    const share = momentum.pressure_share_home;
    if (momentum.sport === 'basketball') {
      const ph = momentum.home && momentum.home.points;
      const pa = momentum.away && momentum.away.points;
      if (ph != null && pa != null) {
        if (share >= 0.65) why.push(`Recent scoring favours home over the last ${momentum.window_minutes} min (${ph}-${pa}).`);
        else if (share <= 0.35) why.push(`Recent scoring favours away over the last ${momentum.window_minutes} min (${ph}-${pa}).`);
      }
    } else if (share >= 0.65) {
      why.push(`Recent attacking pressure favours home over the last ${momentum.window_minutes} min.`);
    } else if (share <= 0.35) {
      why.push(`Recent attacking pressure favours away over the last ${momentum.window_minutes} min.`);
    }
  }
  if (model && model.inputs && model.inputs.elapsed_minutes != null && model.inputs.elapsed_minutes >= 70) {
    why.push(`Late in the match (${model.inputs.elapsed_minutes} min) — the current score carries most of the signal.`);
  }
  if (!why.length && model && Array.isArray(model.notes) && model.notes.length) {
    model.notes.slice(0, 3).forEach(n => why.push(n));
  }
  if (!why.length) why.push('Only score and clock are available — no live statistics to explain the projection.');
  return why.slice(0, 6);
}

/**
 * Confidence in the MODEL's inputs — deliberately separate from the outcome
 * probabilities and from data quality. High only when the tier is trusted,
 * real stats exist, and enough of the match has been played.
 */
function confidenceFor({ game, model, dataQuality }) {
  if (!model || (model.status !== 'live' && model.status !== 'prior_only')) {
    return { level: 'unavailable', basis: 'No usable model output.' };
  }
  const tierW = { full_live: 1, score_time_only: 0.5, user_entered: 0.35 }[game.data_tier] || 0.3;
  const statsScore = dataQuality ? Math.min(1, (dataQuality.stats_available || 0) / 12) : 0;
  const elapsed = model.inputs && model.inputs.elapsed_minutes;
  const timeScore = Number.isFinite(elapsed) ? Math.min(1, elapsed / 60) : 0;
  const score = tierW * 0.4 + statsScore * 0.35 + timeScore * 0.25;
  const level = score >= 0.7 ? 'high' : score >= 0.4 ? 'medium' : 'low';
  return {
    level,
    score: M.round(score, 3),
    basis: `tier ${game.data_tier || 'unknown'}, ${dataQuality ? dataQuality.stats_available : 0} stat pairs, ${Number.isFinite(elapsed) ? elapsed : '?'} min played`,
  };
}

/* ------------------------------------------------------------------ payload */

/**
 * Apply the persisted live calibrator to a model's home-win probability, so the
 * figure that ships is the one the ship gate validated (Phase 9). When no
 * calibrator is trusted the raw probability is returned unchanged, and only the
 * winner market is touched — the projection is a separate derivation.
 *
 * Returns a shallow-cloned model when it edits, so the caller's object is not
 * mutated.
 */
function calibrateModel(model, sport) {
  if (!model || !model.probabilities) return model;
  const market = CONFIG.live.calibration.market;
  const raw = model.probabilities.home_win;
  if (!Number.isFinite(raw)) return model;
  const calibrated = M.round(liveCalibrator.apply(sport, market, raw, 'a'), 4);
  // Phase 10 round D — clip the DISPLAYED (and therefore logged) home-win
  // probability to the configured band, so production can never show a literal 0
  // or 1. The clip is applied after the calibrator, so the number served is the
  // validated column bounded to an honest range.
  const clip = CONFIG.live.probabilityClip || { lower: 0.01, upper: 0.99 };
  const homeWin = M.round(M.clamp(calibrated, clip.lower, clip.upper), 4);
  if (homeWin === raw) return model;
  // Rebalance draw/away proportionally so the three outcomes still sum to 1 —
  // overwriting away_win with (1 - homeWin) would silently erase the draw.
  const p = model.probabilities;
  const others = (p.draw || 0) + (p.away_win || 0);
  const scale = others > 0 ? (1 - homeWin) / others : 1;
  const draw = M.round((p.draw || 0) * scale, 4);
  return {
    ...model,
    probabilities: {
      ...p,
      home_win: homeWin,
      draw,
      away_win: M.round(1 - homeWin - draw, 4),
    },
    calibration: calibrated !== raw
      ? { applied: true, market, raw_home_win: raw }
      : (model.calibration || null),
  };
}

/**
 * Build the UI payload for one live game. Pure: no I/O, no cache.
 *
 * @param {Object} args
 * @param {Object} args.game     Phase 3 LiveGame
 * @param {Object} [args.context] { red_cards, shots_on_target }
 * @param {Object} [args.contextView] the Phase 9 context block (pre-game setting,
 *   key events, injuries) fetched by the caller; pre-game only when omitted
 * @param {number} [args.now]
 * @param {boolean} [args.tester] true when the caller is a recognised tester
 * @returns {Object} the analysis payload
 */
function buildAnalysis({ game, context = {}, contextView = null, statsView = null, now = Date.now(), fetchedAt = null, tester = false } = {}) {
  if (!game || !game.sport) throw new Error('buildAnalysis requires a LiveGame.');

  const leagueId = (game.league && game.league.id) || null;
  const manual = Boolean(game.manual);
  // Normalised live statistics (liveStats.js) ride inside `context` for the
  // model; `statsView` is the same fetch kept for display/markets/quality.
  const stats = statsView && statsView.stats ? statsView.stats : (context.stats || null);
  const momentum = statsView && statsView.momentum ? statsView.momentum : (context.momentum || null);
  const dataQuality = statsView && statsView.data_quality
    ? statsView.data_quality
    : liveStats.dataQuality(stats, { now });
  // A hand-typed game carries no provider events we are allowed to trust, so any
  // supplied context (red cards, shots, stats) is dropped before it can
  // influence the model or the factors.
  const usableContext = manual ? {} : { ...context, stats, momentum };
  const ship = mayShipPick({ sport: game.sport, league: leagueId, manual, tester });
  const rawModel = predictLive({ game, context: usableContext });
  // Phase 9 — serve the validated calibrated column, not the raw one.
  const model = calibrateModel(rawModel, game.sport);

  const modelUsable = model && (model.status === 'live' || model.status === 'prior_only');
  let mode = DISPLAY_MODES.CONTEXT_ONLY;
  if (ship.allowed && modelUsable) {
    mode = model.status === 'live' ? DISPLAY_MODES.FULL : DISPLAY_MODES.PRIOR_ONLY;
  }
  const showFigures = mode !== DISPLAY_MODES.CONTEXT_ONLY;
  // Phase 11 — the recommended picks, derived from the SAME model output the
  // probabilities come from. Withheld (null) whenever the gate withholds the
  // figures, so a pick can never appear beside a withheld probability.
  const markets = showFigures && modelUsable
    ? (game.sport === 'soccer'
      ? liveMarkets.buildSoccerMarkets({
          model, game, stats,
          elapsed: model.inputs && model.inputs.elapsed_minutes,
          remaining: model.inputs && model.inputs.remaining_minutes,
        })
      : game.sport === 'basketball'
        ? liveMarkets.buildBasketballTotalMarkets({ model, game })
        : null)
    : null;
  const picks = showFigures ? derivePicks({ sport: game.sport, model, game, markets, stats }) : null;

  const payload = {
    game_id: game.game_id,
    sport: game.sport,
    source: game.source,
    league: game.league || { id: null, name: null },
    home: game.home,
    away: game.away,
    live: {
      status: game.live ? game.live.status : null,
      is_live: Boolean(game.live && game.live.is_live),
      clock: game.live ? game.live.clock : null,
      period: game.live ? game.live.period : 0,
      // DISPLAY-ONLY derived clock for a source that publishes none (FlashScore,
      // or LiveScore basketball's quarter-only feed). Separate from `clock`, so
      // the UI can show an in-game time without it ever being mistaken for a
      // source-reported one or reaching the model.
      derived_clock: game.live ? (game.live.derived_clock || null) : null,
    },
    data_tier: game.data_tier || null,
    data_tier_label: game.data_tier_label || null,
    manual,
    // The permanent badge a hand-typed game carries. It travels in the payload
    // so every consumer — the UI, and any share or export built from it — shows
    // it and cannot omit it.
    manual_badge: manual ? CFG.manualBadge : null,
    manual_badge_detail: manual ? CFG.manualDisclaimer : null,
    freshness: game.freshness || null,
    match: game.match || null,
    link: game.link || null,
    // Phase 9 — the context-only experience: pre-game setting, key events and
    // injuries. Never a model input. This is what the screen renders when no
    // figure is shown, and a useful sidebar when one is. When the caller did not
    // fetch a summary it degrades to the pre-game block alone.
    context: contextView || liveContext.buildContext({ game, now }),

    ship_gate: {
      ...ship,
      decision: showFigures ? 'shipped' : 'withheld',
    },
    display: {
      mode,
      mode_label: MODE_LABELS[mode],
      shows_probabilities: showFigures,
    },

    // Figures are withheld — not zeroed — when the gate refuses.
    model: modelUsable
      ? { status: model.status, name: model.model, reason: model.reason || null, notes: model.notes || [] }
      : { status: model.status, name: model.model || null, reason: model.reason || null, notes: model.notes || [] },
    probabilities: showFigures ? model.probabilities : null,
    // Phase 11 — the recommended picks (match result, Over/Under, and — for
    // soccer when the stats arrived — corners and shots), each with the model's
    // own probability as its confidence. Null when the gate withholds.
    picks,
    // Live statistics (facts, never predictions) — shown whenever they exist,
    // including context-only mode. Missing fields are null, never zero.
    stats,
    data_quality: dataQuality,
    confidence: confidenceFor({ game, model, dataQuality }),
    // Market states for soccer (available/won/lost/unavailable). Withheld
    // entirely when the gate withholds probabilities.
    markets,
    // "Why Apex predicts this" — factual bullets from real stats only.
    explanation: showFigures ? buildWhy({ game, model, stats, momentum }) : null,
    probabilities_note: showFigures
      ? (model.status === 'prior_only'
        ? 'No in-game clock, so this is the pre-game projection, not a live one.'
        : null)
      : (ship.reason || 'No validated live probability is available for this game yet.'),
    uncertainty: showFigures ? model.uncertainty || null : null,
    projection: showFigures ? projectionFor(model, game) : null,
    // Whether the shipped figure came from the persisted calibrator. Present so a
    // client (and the forward log) can tell a calibrated column from a raw one.
    calibration: showFigures && model.calibration ? model.calibration : null,

    factors: buildFactors({ game, model, context: usableContext, stats }),
    refresh: {
      suggested_seconds: CFG.refresh.suggestedSeconds,
      min_seconds: CFG.refresh.minSeconds,
    },
    fetched_at: fetchedAt ? new Date(fetchedAt).toISOString() : null,
    generated_at: new Date(now).toISOString(),
    disclaimer: CFG.disclaimer,
  };

  // Shadow evidence (Phase 9): the withheld live figure, readable only by the
  // forward log in this module. Non-enumerable, so it is never in a response.
  Object.defineProperty(payload, SHADOW, {
    value: model && model.status === 'live' && model.probabilities
      && Number.isFinite(model.probabilities.home_win)
      ? {
        probability: model.probabilities.home_win,
        raw: model.calibration ? model.calibration.raw_home_win : model.probabilities.home_win,
      }
      : null,
    enumerable: false,
  });

  return payload;
}

/* ------------------------------------------------------------ forward test */

/**
 * Append the shipped live probability to the forward-test log. No-op unless the
 * gate actually shipped a live figure, so the sample that decides whether the
 * pick lives is exactly the population users saw.
 *
 * @param {Object} args
 * @param {Object} args.game
 * @param {Object} args.analysis  a payload from buildAnalysis
 * @param {number} [args.now]
 * @param {boolean} [args.dryRun] Round H (item 2) — compute and grid-gate the row
 *   without writing it; pass through to forwardTest.recordServed.
 */
function recordForwardTest({ game, analysis, now = Date.now(), dryRun = false } = {}) {
  if (!game || !analysis) return null;

  // A shipped figure: the population users actually see decides the pick's life.
  const shipped = analysis.ship_gate && analysis.ship_gate.decision === 'shipped';
  if (shipped && analysis.probabilities && Number.isFinite(analysis.probabilities.home_win)) {
    return forwardTest.recordServed({
      game,
      probability: analysis.probabilities.home_win,
      raw: analysis.calibration ? analysis.calibration.raw_home_win : null,
      now,
      source: game.source || null,
      dryRun,
    });
  }

  // Shadow (Phase 9): a sport observed but withheld from everyone. Log the figure
  // production WOULD show, tagged so it never counts toward the served-pick
  // auto-disable — it is evidence for the rollout decision, nothing more.
  const shadow = analysis[SHADOW];
  if (shadow && Number.isFinite(shadow.probability) && shadowSports().includes(game.sport)) {
    // Phase 10 — carry the FROZEN candidate columns for this exact checkpoint
    // onto the row (basketball logistic; soccer empirical table / multinomial
    // logistic / scoreTime). Read-only and never refit, so the fresh-data
    // evaluation (>= 500 settled games) scores a fixed target. Null when the
    // artifact is absent — the logger never invents a number.
    const candidates = shadowCandidates.candidatesFor({ game });
    return forwardTest.recordServed({
      game,
      probability: shadow.probability,
      raw: shadow.raw,
      now,
      source: game.source || null,
      shadow: true,
      candidates,
      dryRun,
    });
  }

  return null;
}

/**
 * Bind the outcome to every logged row for a game the provider now reports as
 * finished. Basketball has no draw, so an equal score is graded as neither.
 *
 * @param {boolean} [args.dryRun] Round H (item 2) — count the rows that WOULD
 *   settle without writing (sweep dry run).
 */
function settleForwardTest({ game, now = Date.now(), dryRun = false } = {}) {
  if (!game || !game.game_id) return 0;
  if (!game.live || game.live.status !== 'finished') return 0;
  const home = game.home ? game.home.score : null;
  const away = game.away ? game.away.score : null;
  return forwardTest.settle({ gameId: game.game_id, homeScore: home, awayScore: away, now, dryRun });
}

/**
 * Serve an analysis for a previously resolved game, refreshing the live state
 * when the matcher can do so and reusing a shared payload inside the TTL so N
 * users watching one game cost one upstream read.
 *
 * @param {Object} args
 * @param {string} args.gameId
 * @param {Object} [args.matcher]      createLiveMatcher() instance, optional
 * @param {Object} [args.espn]         EspnProvider for the context read, optional
 * @param {number} [args.now]
 * @param {string} [args.traceId]
 * @param {boolean} [args.tester]      true when the caller is a recognised tester
 * @returns {{analysis:Object}|{error:{code:string,message:string,status:number}}}
 */
async function analyseLiveGame({ gameId, matcher = null, espn = null, now = Date.now(), traceId = null, tester = false } = {}) {
  const audience = audienceKey(tester ? 'testers' : 'public');
  const cached = getCachedAnalysis(gameId, audience, now);
  if (cached) return { analysis: cached, cached: true };

  const hit = recallGame(gameId, now);
  if (!hit) {
    return {
      error: {
        code: 'GAME_NOT_RESOLVED',
        status: 404,
        message: 'This game is not being tracked any more. Paste the link again to re-resolve it.',
      },
    };
  }

  let game = hit.game;
  const sourceId = String(gameId).includes(':')
    ? String(gameId).split(':').slice(1).join(':')
    : null;
  const canRefreshEspn = matcher
    && typeof matcher.refreshCandidate === 'function'
    && game.source !== 'manual'
    && game.league && game.league.id;
  // A LiveScore / FlashScore game carries no ESPN league id, so it cannot be
  // refreshed through the ESPN matcher; it is refreshed from the score-site feed
  // it came from, by its own match id.
  const canRefreshFeed = !canRefreshEspn
    && FEED_SOURCES.has(game.source)
    && Boolean(sourceId);

  if (canRefreshEspn) {
    const refreshed = await matcher.refreshCandidate({
      sport: game.sport,
      league: game.league.id,
      sourceId,
      traceId,
    });
    if (refreshed) {
      game = buildLiveGame({
        candidate: refreshed,
        parsed: null,
        fetchedAt: now,
        now,
      });
      // Keep the original link/orientation context the user already confirmed;
      // only the live state (score, clock, period, tier) is refreshed.
      game.link = hit.game.link || null;
      game.match = hit.game.match || game.match;
      rememberGame(game, now);
    } else {
      // Provider had nothing this tick: keep the last known state but let the
      // freshness block tell the truth about how old it is.
      game = { ...game, freshness: require('./liveGame').staleness(hit.cached_at, now) };
    }
  } else if (canRefreshFeed) {
    // Re-read the SAME feed the /live/matches list is built from, by match id.
    // A miss (match ended or the site is unreachable) keeps the last known state
    // and only the freshness block reports how old it is.
    // Lazily required: matchFeed depends on this module, so requiring it at load
    // time would be a cycle.
    const feed = require('./matchFeed');
    const resolved = await feed.resolveFeedMatch({
      source: game.source, providerId: sourceId, now,
    });
    if (resolved && resolved.match) {
      game = feed.toLiveGame(resolved.match, { now, fetchedAt: now });
      game.link = hit.game.link || null;
      game.match = hit.game.match || game.match;
      rememberGame(game, now);
    } else {
      game = { ...game, freshness: require('./liveGame').staleness(hit.cached_at, now) };
    }
  }

  // A game the provider now reports as finished closes the loop on every row we
  // logged while it was live, before the payload is built and cached.
  settleForwardTest({ game, now });

  // Phase 9 — the context-only experience. A short-TTL, best-effort summary read
  // (key events + injuries); a failure leaves the pre-game block alone. Shared
  // across pollers by the liveContext cache and by the analysis cache below.
  const contextView = await liveContext.getContext({ espn, game, now, traceId });
  // Live statistics (shots, possession, corners, cards) from the same cached
  // ESPN summary read — shared cache means this costs no extra HTTP call.
  const statsView = await liveStats.getLiveStats({ espn, game, now, traceId });

  const analysis = buildAnalysis({ game, contextView, statsView, now, fetchedAt: now, tester });
  recordForwardTest({ game, analysis, now });
  putCachedAnalysis(gameId, analysis, audience, now);
  return { analysis, cached: false };
}

module.exports = {
  DISPLAY_MODES,
  MODE_LABELS,
  buildAnalysis,
  buildFactors,
  projectionFor,
  nextGoal,
  analyseLiveGame,
  recordForwardTest,
  settleForwardTest,
  calibrateModel,
  buildWhy,
  confidenceFor,
  rememberGame,
  recallGame,
  getCachedAnalysis,
  putCachedAnalysis,
  resetCache,
};
