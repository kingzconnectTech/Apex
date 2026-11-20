/**
 * live/livePicks.js
 *
 * Phase 11 — turn a live model output into the picks the Live Analysis screen
 * shows: the match-result pick (1X2 in soccer, moneyline in basketball), the
 * Over/Under pick, and — for soccer, when the live-stat feed supplied the count
 * — the corners and shots Over/Under picks.
 *
 * Pure: no I/O, no cache. It reads only the model output it is handed plus the
 * line configuration, never recomputes the model, and never invents a number.
 * The confidence it reports is the model's OWN probability for the selection it
 * recommends — nothing is inflated, rounded up or "boosted".
 *
 * The line matters: the live model has no bookmaker line to compare against, so
 * the Over/Under pick is made against a FIXED standard line per sport/league
 * (config live.pickMarkets.overUnder). Because the line is a constant and not
 * the live projection, the pick's confidence moves honestly as the game state
 * moves the projection away from it.
 */

const CONFIG = require('./config');
const M = require('./liveMath');
const { leagueParams } = require('./basketballLive');
const liveMarkets = require('./liveMarkets');
const { spreadProbability } = require('../basketball/probability');

const CFG = CONFIG.live.pickMarkets;

/** The configured basketball moneyline bar (a pick below it is withheld). */
function moneylineMin() {
  const cfg = (CFG.pickMarkets && CFG.pickMarkets.moneyline) || {};
  return Number.isFinite(cfg.minProbability) ? cfg.minProbability : 0.75;
}

/** The match-result market name for a sport. */
function resultMarket(sport) {
  return sport === 'soccer' ? '1x2' : 'moneyline';
}

/**
 * The FIXED Over/Under line for this game — the PRE-GAME expected total for the
 * match, never the live projection. Soccer uses the configured line; basketball
 * uses the model's own pre-game anchor (`model.anchor_total`: the engine's
 * published projection when there is one, else the competition's own mean),
 * snapped to a half point so the total can never push. When no anchor and no
 * fitted league mean are available the line is null, so the O/U pick is omitted
 * rather than guessed.
 *
 * The line is fixed for the whole game — it does NOT move with the score — so
 * the live projection diverges from it and the pick's confidence moves honestly.
 *
 * @param {string} sport
 * @param {Object} [game]  LiveGame (for the basketball league id)
 * @param {Object} [model] the model output (for the pre-game anchor total)
 * @returns {number|null}
 */
function overUnderLine(sport, game, model) {
  const cfg = CFG.overUnder[sport];
  if (!cfg) return null;
  if (Number.isFinite(cfg.line)) return cfg.line;
  if (sport !== 'basketball') return null;
  // Prefer THIS match's pre-game expected total; fall back to the competition's
  // own mean for a fitted league. Nothing is fabricated when neither is known.
  const anchor = model && Number.isFinite(model.anchor_total) ? model.anchor_total : null;
  const params = leagueParams(game && game.league && game.league.id);
  const mean = anchor != null
    ? anchor
    : (params && params.fitted && Number.isFinite(params.totalMean) ? params.totalMean : null);
  if (!Number.isFinite(mean)) return null;
  // Nearest half point (X.5) so the total can never push.
  return M.round(Math.round(mean - 0.5) + 0.5, 1);
}

/**
 * P(total > line) read off the soccer model's own final-total distribution
 * (`total_distribution`, current score already folded in). Null when the
 * distribution is absent.
 */
function soccerOver(distribution, line) {
  if (!Array.isArray(distribution) || !distribution.length) return null;
  let over = 0;
  let total = 0;
  for (const p of distribution) {
    if (!Number.isFinite(p && p.prob)) continue;
    total += p.prob;
    if (p.value > line) over += p.prob;
  }
  if (!(total > 0)) return null;
  return M.clamp(over / total, 0.001, 0.999);
}

/** P(total > line) for basketball, from the model's normal total. */
function basketballOver(mean, sigma, line) {
  if (!Number.isFinite(mean) || !(sigma > 0)) return null;
  return M.clamp(1 - M.normalCdf((line - mean) / sigma), 0.001, 0.999);
}

/**
 * The most likely match-result selection, with the model's probability.
 *
 * `minProb` gates the recommendation: when the strongest outcome sits below the
 * bar the pick is withheld (null) — the winner probability is still shown as
 * ANALYSIS elsewhere, but a sub-threshold read is never dressed up as a pick.
 * It defaults to 0, so the raw "most likely outcome" utility is unchanged for
 * callers that want the argmax regardless (e.g. soccer's T6 symmetry check).
 */
function matchResultPick(sport, probabilities, minProb = 0) {
  if (!probabilities) return null;
  const p = probabilities;
  const options = [];
  if (Number.isFinite(p.home_win)) options.push({ selection: 'home', probability: p.home_win });
  if (sport === 'soccer' && Number.isFinite(p.draw)) options.push({ selection: 'draw', probability: p.draw });
  if (Number.isFinite(p.away_win)) options.push({ selection: 'away', probability: p.away_win });
  if (!options.length) return null;
  const best = options.reduce((a, b) => (b.probability > a.probability ? b : a));
  if (best.probability < minProb) return null;
  return { market: resultMarket(sport), selection: best.selection, probability: M.round(best.probability, 4) };
}

/**
 * Soccer match-result pick as a DOUBLE CHANCE market (1X / X2 / 12), derived
 * from the same underlying home/draw/away probabilities — straight winners
 * are never presented as football recommendations. All three options are
 * evaluated independently and only the strongest is returned, and only when
 * its calibrated probability clears the configured football threshold
 * (default 0.90). Below it: no pick rather than a forced one.
 */
function doubleChancePick(probabilities) {
  const p = probabilities || {};
  const hw = Number.isFinite(p.home_win) ? p.home_win : null;
  const dr = Number.isFinite(p.draw) ? p.draw : null;
  const aw = Number.isFinite(p.away_win) ? p.away_win : null;
  if (hw == null || dr == null || aw == null) return null;
  const cfg = (CFG.pickMarkets && CFG.pickMarkets.doubleChance) || {};
  const minProb = Number.isFinite(cfg.minProbability) ? cfg.minProbability : 0.90;
  const options = [
    { selection: '1x', probability: hw + dr },
    { selection: 'x2', probability: dr + aw },
    { selection: '12', probability: hw + aw },
  ];
  const best = options.reduce((a, b) => (b.probability > a.probability ? b : a));
  if (best.probability < minProb) return null;
  return { market: 'double_chance', selection: best.selection, probability: M.round(best.probability, 4) };
}

/** The Over/Under pick against the fixed line, or null when it cannot be priced. */
function overUnderPick(sport, model, game, markets) {
  const line = overUnderLine(sport, game);
  if (line == null) return null;

  // A settled market is never a fresh pick: if the market layer reports the
  // line already won or lost, there is nothing to recommend.
  if (sport === 'soccer' && Array.isArray(markets)) {
    const tag = String(line);
    const settled = markets.some(m => m && m.market === 'total_goals' && m.line === line
      && (m.status === 'won' || m.status === 'lost'));
    if (settled) return null;
  }

  let overProb = null;
  if (sport === 'soccer') {
    overProb = soccerOver(model.total_distribution, line);
  } else if (sport === 'basketball') {
    const mean = model.expected && model.expected.total;
    const sigma = model.sigma && model.sigma.total;
    overProb = basketballOver(mean, sigma, line);
  }
  if (overProb == null) return null;

  const selection = overProb >= 0.5 ? 'over' : 'under';
  const probability = selection === 'over' ? overProb : 1 - overProb;
  return {
    market: 'over_under',
    line,
    selection,
    probability: M.round(probability, 4),
    over: M.round(overProb, 4),
    under: M.round(1 - overProb, 4),
  };
}

/**
 * Basketball total-points pick at the league's MAIN line — the total a book
 * would hang (overUnderLine), never the model's own projection and never the
 * most extreme evaluation line. The side is the one the model favours AT that
 * line, priced off the model's own normal total distribution, and the pick is
 * emitted only when that side clears `minPickProbability`; below it there is NO
 * pick rather than a ~50/50 read dressed up as a recommendation. A line the
 * current score has already settled is never a fresh pick.
 *
 * This replaces the old behaviour of reporting whichever side sat a hair above
 * 50% at a line picked off the model's own projection — the source of the
 * constant "Over 219.5" reads on games the model had no real read on.
 */
function basketballTotalsPick(model, game) {
  const cfg = (CFG.overUnder && CFG.overUnder.basketball) || {};
  const minProb = Number.isFinite(cfg.minPickProbability) ? cfg.minPickProbability : 0;
  const mean = model && model.expected ? model.expected.total : null;
  const sigma = model && model.sigma ? model.sigma.total : null;
  if (!Number.isFinite(mean) || !(sigma > 0)) return null;

  // The line is THIS match's PRE-GAME expected total (the engine's projection,
  // else the competition mean) — the line a book would hang — fixed for the
  // whole game. It is never the live projection, so the pick's confidence moves
  // honestly as the game moves the projection away from it.
  const line = overUnderLine('basketball', game, model);
  if (!Number.isFinite(line)) return null;

  // A line the current score has already settled is never a fresh pick.
  const curTotal = ((game && game.home && game.home.score) || 0) + ((game && game.away && game.away.score) || 0);
  if (curTotal > line) return null;

  const over = basketballOver(mean, sigma, line);
  if (over == null) return null;
  const selection = over >= 0.5 ? 'over' : 'under';
  const probability = selection === 'over' ? over : 1 - over;
  if (probability < minProb) return null;
  return {
    market: 'over_under',
    line,
    selection,
    probability: M.round(probability, 4),
    over: M.round(over, 4),
    under: M.round(1 - over, 4),
  };
}

/**
 * Basketball POINT-SPREAD (handicap) pick.
 *
 * The line is the HOME handicap derived from the match's PRE-GAME expected
 * margin (`model.anchor_margin`) — negative when the home team is favoured —
 * set on a half point so the margin can never push. Like the totals line it is
 * fixed for the whole game; the side is whichever of home/away covers at the
 * LIVE projected margin (`model.expected.margin`) with the model's own margin
 * sigma, and the pick is emitted only when that side clears the configured bar.
 * Below it: no pick rather than a ~50/50 read.
 *
 * Convention mirrors basketball/index.js and basketball/probability.js: the
 * spread is the HOME handicap, and home covers when (margin + spread) > 0.
 */
function spreadPick(model, game) {
  const cfg = (CFG.pickMarkets && CFG.pickMarkets.spread) || {};
  const minProb = Number.isFinite(cfg.minProbability) ? cfg.minProbability : 0.75;
  const anchorMargin = model && Number.isFinite(model.anchor_margin) ? model.anchor_margin : null;
  const projMargin = model && model.expected ? model.expected.margin : null;
  const sigmaMargin = model && model.sigma ? model.sigma.margin : null;
  if (anchorMargin == null || !Number.isFinite(projMargin) || !(sigmaMargin > 0)) return null;

  // HOME handicap on a half point, signed by which side is favoured.
  const half = Math.round(Math.abs(anchorMargin) * 2) / 2 + 0.5;
  const line = anchorMargin >= 0 ? -half : half;

  const probs = spreadProbability({ spread: line, projMargin, sigmaMargin });
  if (probs.home == null || probs.away == null) return null;
  const selection = probs.home >= probs.away ? 'home' : 'away';
  const probability = selection === 'home' ? probs.home : probs.away;
  if (probability < minProb) return null;
  return {
    market: 'spread',
    line,
    selection,
    probability: M.round(probability, 4),
    home: M.round(probs.home, 4),
    away: M.round(probs.away, 4),
  };
}

/**
 * The Over/Under pick for a rate-based count market (corners, shots): among the
 * AVAILABLE lines, take the one NEAREST the projected final count — the model's
 * "main" line — and the stronger side, exactly as the basketball totals pick
 * takes the line nearest its expected total. Confidence is that side's own
 * probability. Settled lines are never fresh picks, and a market that cannot be
 * priced is null, never a placeholder.
 *
 * @param {string} market  'corners' | 'shots'
 * @param {Array} markets  the soccer market list
 * @param {number|null} projected  projected final count (for the main line)
 */
function rateCountPick(market, markets, projected) {
  const byLine = new Map();
  for (const m of markets || []) {
    if (!m || m.market !== market || m.status !== 'available') continue;
    if (!Number.isFinite(m.probability)) continue;
    const cur = byLine.get(m.line) || { line: m.line, over: null, under: null };
    if (m.side === 'over') cur.over = m.probability;
    else if (m.side === 'under') cur.under = m.probability;
    byLine.set(m.line, cur);
  }
  const candidates = [...byLine.values()].filter(c => c.over != null && c.under != null);
  if (!candidates.length) return null;

  // The main line is the one nearest the projection; with no projection the
  // model's own near-even line (P(over) closest to 0.5) is the honest anchor.
  const line = Number.isFinite(projected)
    ? candidates.reduce((a, b) => (Math.abs(b.line - projected) < Math.abs(a.line - projected) ? b : a)).line
    : candidates.reduce((a, b) => (Math.abs(a.over - 0.5) <= Math.abs(b.over - 0.5) ? a : b)).line;
  const chosen = byLine.get(line);
  const selection = chosen.over >= chosen.under ? 'over' : 'under';
  return {
    market,
    line,
    selection,
    probability: M.round(selection === 'over' ? chosen.over : chosen.under, 4),
    over: M.round(chosen.over, 4),
    under: M.round(chosen.under, 4),
  };
}

/**
 * The projected final count of a rate statistic (corners, shots): the count so
 * far plus the remaining count the per-minute rate implies. Null when the count
 * or the clock is unknown — the pick then falls back to the near-even line.
 */
function projectedCount(stats, field, model) {
  const cur = stats && stats.totals ? stats.totals[field] : null;
  if (!Number.isFinite(cur)) return null;
  const el = model && model.inputs ? model.inputs.elapsed_minutes : null;
  const rem = model && model.inputs ? model.inputs.remaining_minutes : null;
  const rest = liveMarkets.expectedRemaining(cur, el, rem);
  return Number.isFinite(rest) ? M.round(cur + rest, 2) : null;
}

/**
 * Derive the picks for one live model output. Returns
 * `{ match_result, over_under, spread, corners, shots }` — each key is an
 * object or null (a null means that market could not be priced, never a
 * placeholder). Returns null overall when the model is not usable.
 *
 * Basketball gets `over_under` (anchored on the match's pre-game expected
 * total), `spread` (handicap off the pre-game expected margin) and, only when
 * its winner probability clears the moneyline bar, `match_result`. `corners`
 * and `shots` are soccer only and are priced from the live-stat markets, so
 * they are null whenever the provider gave no shots/corners count (e.g. a
 * score-site game).
 *
 * @param {Object} args
 * @param {string} args.sport
 * @param {Object} args.model  a predictLive output (status live | prior_only)
 * @param {Object} [args.game] the LiveGame
 * @param {Array} [args.markets] the priced market list from liveMarkets
 * @param {Object} [args.stats] normalised live stats from liveStats
 */
function derivePicks({ sport, model, game, markets, stats = null } = {}) {
  if (!CFG || CFG.enabled === false) return null;
  if (!sport || !model) return null;
  if (model.status !== 'live' && model.status !== 'prior_only') return null;

  const matchResult = sport === 'soccer'
    ? doubleChancePick(model.probabilities)
    : matchResultPick(sport, model.probabilities, moneylineMin());
  const overUnder = sport === 'basketball'
    ? basketballTotalsPick(model, game || {})
    : overUnderPick(sport, model, game || {}, markets);
  const spread = sport === 'basketball' ? spreadPick(model, game || {}) : null;
  const corners = sport === 'soccer'
    ? rateCountPick('corners', markets, projectedCount(stats, 'corners', model))
    : null;
  const shots = sport === 'soccer'
    ? rateCountPick('shots', markets, projectedCount(stats, 'shots', model))
    : null;
  if (!matchResult && !overUnder && !spread && !corners && !shots) return null;
  return { match_result: matchResult, over_under: overUnder, spread, corners, shots };
}

module.exports = { derivePicks, overUnderLine, matchResultPick, doubleChancePick, overUnderPick, basketballTotalsPick, spreadPick, rateCountPick, projectedCount, soccerOver, basketballOver };
