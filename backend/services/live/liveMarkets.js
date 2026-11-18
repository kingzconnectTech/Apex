/**
 * live/liveMarkets.js
 *
 * Live Market Predictor — prices the markets the Live Analysis screen can
 * show, and — critically — decides whether each market is still tradeable.
 *
 * Every market carries a status:
 *   AVAILABLE    — the outcome is not yet decided; a probability is shown.
 *   WON          — the condition is already achieved (e.g. Over 2.5 at 2-1).
 *   LOST         — the condition can no longer be achieved.
 *   UNAVAILABLE  — not enough data to price it honestly.
 *
 * Settled markets are emitted with their status but are never presented as
 * fresh predictions — the UI filters on `status === 'available'`.
 *
 * Goal markets read the model's own final-total distribution
 * (`total_distribution`, current score already folded in). Corner and card
 * markets are priced from per-minute rates extrapolated over the remaining
 * time, and only when the underlying statistic actually arrived — a corner
 * market is never priced from goals, and vice versa.
 */

const CONFIG = require('./config');
const M = require('./liveMath');

const STATUS = { AVAILABLE: 'available', WON: 'won', LOST: 'lost', UNAVAILABLE: 'unavailable' };

/* Standard lines the analysis surface reports. Half-point lines so no push. */
const GOAL_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];
const CORNER_OVER_LINES = [4.5, 5.5, 6.5, 7.5, 8.5];
const CORNER_UNDER_LINES = [8.5, 9.5, 10.5];
const CARD_LINES = [3.5, 4.5];
const TEAM_GOAL_LINE = 0.5;
const TEAM_CORNER_LINE = 3.5;

/** P(final total > line) off the model's total_distribution. */
function probOverTotal(distribution, line) {
  if (!Array.isArray(distribution) || !distribution.length) return null;
  let over = 0;
  let total = 0;
  for (const p of distribution) {
    if (!Number.isFinite(p && p.prob)) continue;
    total += p.prob;
    if (p.value > line) over += p.prob;
  }
  if (!(total > 0)) return null;
  return M.clamp(over / total, 0.0001, 0.9999);
}

/**
 * Settle-aware status for an Over/Under line against a current count.
 * `count` = goals/cards/corners recorded so far; `line` = the x.5 line.
 * Over is WON once count > line; Under is LOST at the same moment.
 * Both stay AVAILABLE while the match can still move either way.
 */
function overUnderStatus(count, line) {
  if (!Number.isFinite(count)) return STATUS.UNAVAILABLE;
  return count > line ? { over: STATUS.WON, under: STATUS.LOST } : { over: STATUS.AVAILABLE, under: STATUS.AVAILABLE };
}

function entry(key, market, line, side, probability, status, extra = {}) {
  return {
    key, market, line, side,
    probability: Number.isFinite(probability) ? M.round(probability, 4) : null,
    status,
    ...extra,
  };
}

/* ------------------------------------------------------- goal markets */

function goalMarkets(model, game) {
  const out = [];
  const curTotal = (game.home && game.home.score || 0) + (game.away && game.away.score || 0);
  const dist = model && model.total_distribution;

  for (const line of GOAL_LINES) {
    const overProb = probOverTotal(dist, line);
    if (overProb == null) {
      out.push(entry(`goals_over_${line}`, 'total_goals', line, 'over', null, STATUS.UNAVAILABLE));
      out.push(entry(`goals_under_${line}`, 'total_goals', line, 'under', null, STATUS.UNAVAILABLE));
      continue;
    }
    const st = overUnderStatus(curTotal, line);
    out.push(entry(`goals_over_${line}`, 'total_goals', line, 'over', overProb, st.over));
    out.push(entry(`goals_under_${line}`, 'total_goals', line, 'under', 1 - overProb, st.under));
  }

  // Team goal markets: "team scores over 0.5" = at least one goal all match.
  // Already scored => WON; otherwise priced off the remaining-goal lambda.
  const lambdas = model && model.inputs ? { home: model.inputs.lambda_home, away: model.inputs.lambda_away } : null;
  const sides = [
    { key: 'home', score: game.home && game.home.score, lambda: lambdas && lambdas.home },
    { key: 'away', score: game.away && game.away.score, lambda: lambdas && lambdas.away },
  ];
  for (const t of sides) {
    if (!Number.isFinite(t.score)) {
      out.push(entry(`team_goals_${t.key}`, 'team_goals', TEAM_GOAL_LINE, t.key, null, STATUS.UNAVAILABLE));
      continue;
    }
    if (t.score > TEAM_GOAL_LINE) {
      out.push(entry(`team_goals_${t.key}`, 'team_goals', TEAM_GOAL_LINE, t.key, 1, STATUS.WON, { detail: 'Already scored.' }));
      continue;
    }
    if (!Number.isFinite(t.lambda) || t.lambda <= 0) {
      out.push(entry(`team_goals_${t.key}`, 'team_goals', TEAM_GOAL_LINE, t.key, null, STATUS.UNAVAILABLE));
      continue;
    }
    // P(>=1 more goal) = 1 - P(0 remaining goals).
    const p = M.clamp(1 - M.poissonPmf(0, t.lambda), 0.0001, 0.9999);
    out.push(entry(`team_goals_${t.key}`, 'team_goals', TEAM_GOAL_LINE, t.key, p, STATUS.AVAILABLE));
  }
  return out;
}

/* ----------------------------------------------------- 1X2 double chance */

function doubleChanceMarkets(model) {
  const p = model && model.probabilities;
  if (!p) return [];
  const rows = [
    { key: 'dc_1x', label: '1X', probability: (p.home_win || 0) + (p.draw || 0) },
    { key: 'dc_x2', label: 'X2', probability: (p.draw || 0) + (p.away_win || 0) },
    { key: 'dc_12', label: '12', probability: (p.home_win || 0) + (p.away_win || 0) },
  ];
  return rows.map(r => entry(r.key, 'double_chance', null, r.label, r.probability, STATUS.AVAILABLE, { label: r.label }));
}

/* ------------------------------------------- rate-based markets (corners/cards) */

/**
 * Expected remaining count for a per-minute rate: count so far scaled by the
 * share of the match left. Returns null when there is not enough elapsed
 * match or the count is unknown — never a guess.
 */
function expectedRemaining(count, elapsed, remaining) {
  if (!Number.isFinite(count) || !Number.isFinite(elapsed) || elapsed < 5) return null;
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  // Per-minute rate over the elapsed part of the match.
  return (count / elapsed) * remaining;
}

/** P(final > line) for Poisson-distributed remaining events added to `current`. */
function probOverCount(current, lambdaRemaining, line) {
  if (!Number.isFinite(current) || !Number.isFinite(lambdaRemaining)) return null;
  // Need remaining events > line - current.
  const need = line - current;
  // P(X > need) where X ~ Poisson(lambda). For need < 0 the market is already won.
  if (need < 0) return 1;
  // P(X > need) = 1 - P(X <= need); need is a half-integer boundary so
  // P(X <= need) = P(X <= floor(need)) for x.5 lines.
  const k = Math.floor(need);
  let cdf = 0;
  for (let i = 0; i <= k; i++) cdf += M.poissonPmf(i, lambdaRemaining);
  return M.clamp(1 - cdf, 0.0001, 0.9999);
}

function cornerMarkets(stats, elapsed, remaining) {
  const out = [];
  if (!stats || !stats.totals || !Number.isFinite(stats.totals.corners)) {
    return [entry('corners_unavailable', 'corners', null, 'total', null, STATUS.UNAVAILABLE)];
  }
  const curTotal = stats.totals.corners;
  const lambdaTotal = expectedRemaining(curTotal, elapsed, remaining);

  for (const line of CORNER_OVER_LINES) {
    const overProb = probOverCount(curTotal, lambdaTotal, line);
    if (overProb == null) {
      out.push(entry(`corners_over_${line}`, 'corners', line, 'over', null, STATUS.UNAVAILABLE));
      out.push(entry(`corners_under_${line}`, 'corners', line, 'under', null, STATUS.UNAVAILABLE));
      continue;
    }
    const st = overUnderStatus(curTotal, line);
    out.push(entry(`corners_over_${line}`, 'corners', line, 'over', overProb, st.over));
    out.push(entry(`corners_under_${line}`, 'corners', line, 'under', 1 - overProb, st.under));
  }
  for (const line of CORNER_UNDER_LINES) {
    const overProb = probOverCount(curTotal, lambdaTotal, line);
    if (overProb == null) {
      out.push(entry(`corners_over_${line}`, 'corners', line, 'over', null, STATUS.UNAVAILABLE));
      out.push(entry(`corners_under_${line}`, 'corners', line, 'under', null, STATUS.UNAVAILABLE));
      continue;
    }
    const st = overUnderStatus(curTotal, line);
    out.push(entry(`corners_over_${line}`, 'corners', line, 'over', overProb, st.over));
    out.push(entry(`corners_under_${line}`, 'corners', line, 'under', 1 - overProb, st.under));
  }

  // Per-side corner markets at a fixed line, priced off each side's own rate.
  for (const side of ['home', 'away']) {
    const cur = stats[side] && stats[side].corners;
    const lambda = expectedRemaining(cur, elapsed, remaining);
    const p = probOverCount(cur, lambda, TEAM_CORNER_LINE);
    if (p == null) {
      out.push(entry(`corners_${side}`, 'team_corners', TEAM_CORNER_LINE, side, null, STATUS.UNAVAILABLE));
      continue;
    }
    const st = overUnderStatus(cur, TEAM_CORNER_LINE);
    out.push(entry(`corners_${side}`, 'team_corners', TEAM_CORNER_LINE, side, p, st.over));
  }
  return out;
}

function cardMarkets(stats, elapsed, remaining) {
  const out = [];
  if (!stats || !stats.totals || !Number.isFinite(stats.totals.cards)) {
    return [entry('cards_unavailable', 'cards', null, 'total', null, STATUS.UNAVAILABLE)];
  }
  const curTotal = stats.totals.cards;
  const lambdaTotal = expectedRemaining(curTotal, elapsed, remaining);
  for (const line of CARD_LINES) {
    const overProb = probOverCount(curTotal, lambdaTotal, line);
    if (overProb == null) {
      out.push(entry(`cards_over_${line}`, 'cards', line, 'over', null, STATUS.UNAVAILABLE));
      out.push(entry(`cards_under_${line}`, 'cards', line, 'under', null, STATUS.UNAVAILABLE));
      continue;
    }
    const st = overUnderStatus(curTotal, line);
    out.push(entry(`cards_over_${line}`, 'cards', line, 'over', overProb, st.over));
    out.push(entry(`cards_under_${line}`, 'cards', line, 'under', 1 - overProb, st.under));
  }
  for (const side of ['home', 'away']) {
    const cur = stats[side] && stats[side].cards_total;
    const lambda = expectedRemaining(cur, elapsed, remaining);
    const p = probOverCount(cur, lambda, 1.5);
    if (p == null) {
      out.push(entry(`cards_${side}`, 'team_cards', 1.5, side, null, STATUS.UNAVAILABLE));
      continue;
    }
    const st = overUnderStatus(cur, 1.5);
    out.push(entry(`cards_${side}`, 'team_cards', 1.5, side, p, st.over));
  }
  return out;
}

/* ------------------------------------------- basketball total points */

/** P(final total > line) for a normal total (half-point line, no push). */
function probOverNormal(mean, sigma, line) {
  if (!Number.isFinite(mean) || !Number.isFinite(sigma) || !(sigma > 0) || !Number.isFinite(line)) return null;
  return M.clamp(1 - M.normalCdf((line - mean) / sigma), 0.0001, 0.9999);
}

/**
 * Basketball total-points markets. Every configured line is priced
 * independently — Over AND Under — from the model's expected final total and
 * sigma. Lines already decided by the current score are marked won/lost and
 * are never presented as fresh predictions.
 *
 * @param {Object} args
 * @param {Object} args.model  predictLive output (expected.total, sigma.total)
 * @param {Object} args.game   LiveGame (current score)
 * @param {number[]} [args.lines] evaluation lines (defaults to config)
 */
function buildBasketballTotalMarkets({ model, game, lines = null } = {}) {
  const cfg = (CONFIG.live.pickMarkets.overUnder || {}).basketball || {};
  const evalLines = Array.isArray(lines) && lines.length ? lines : (cfg.evaluationLines || []);
  const mean = model && model.expected ? model.expected.total : null;
  const sigma = model && model.sigma ? model.sigma.total : null;
  const curTotal = ((game && game.home && game.home.score) || 0) + ((game && game.away && game.away.score) || 0);

  const out = [];
  for (const line of evalLines) {
    const overProb = probOverNormal(mean, sigma, line);
    if (overProb == null) {
      out.push(entry(`bball_over_${line}`, 'total_points', line, 'over', null, STATUS.UNAVAILABLE));
      out.push(entry(`bball_under_${line}`, 'total_points', line, 'under', null, STATUS.UNAVAILABLE));
      continue;
    }
    const st = overUnderStatus(curTotal, line);
    out.push(entry(`bball_over_${line}`, 'total_points', line, 'over', overProb, st.over));
    out.push(entry(`bball_under_${line}`, 'total_points', line, 'under', 1 - overProb, st.under));
  }
  return out;
}

/** The single strongest AVAILABLE total-points side across all lines, or null. */
function bestBasketballTotal(markets) {
  let best = null;
  for (const m of markets || []) {
    if (!m || m.market !== 'total_points' || m.status !== STATUS.AVAILABLE) continue;
    if (!Number.isFinite(m.probability)) continue;
    if (!best || m.probability > best.probability) best = m;
  }
  return best;
}

/* ------------------------------------------------------------------ main */

/**
 * Build the full market list for a soccer model output.
 *
 * @param {Object} args
 * @param {Object} args.model  predictLive output (needs total_distribution,
 *   probabilities, inputs.lambda_*)
 * @param {Object} args.game   LiveGame (current score)
 * @param {Object} [args.stats] normalised stats from liveStats.js
 * @param {number} [args.elapsed] elapsed match minutes (from model.inputs)
 * @param {number} [args.remaining] remaining match minutes
 * @returns {Array} market entries, each with a status
 */
function buildSoccerMarkets({ model, game, stats = null, elapsed = null, remaining = null } = {}) {
  const markets = [];
  markets.push(...goalMarkets(model, game));
  markets.push(...doubleChanceMarkets(model));

  const el = Number.isFinite(elapsed) ? elapsed : (model && model.inputs && model.inputs.elapsed_minutes);
  const rem = Number.isFinite(remaining) ? remaining : (model && model.inputs && model.inputs.remaining_minutes);
  markets.push(...cornerMarkets(stats, el, rem));
  markets.push(...cardMarkets(stats, el, rem));
  return markets;
}

/** Convenience: the markets a UI should actually present as predictions. */
function availableMarkets(markets) {
  return (markets || []).filter(m => m && m.status === STATUS.AVAILABLE && Number.isFinite(m.probability));
}

module.exports = {
  STATUS,
  buildSoccerMarkets,
  buildBasketballTotalMarkets,
  bestBasketballTotal,
  availableMarkets,
  probOverTotal,
  probOverCount,
  overUnderStatus,
  GOAL_LINES,
  CORNER_OVER_LINES,
  CORNER_UNDER_LINES,
  CARD_LINES,
};
