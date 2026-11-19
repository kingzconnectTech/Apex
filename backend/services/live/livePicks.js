/**
 * live/livePicks.js
 *
 * Phase 11 — turn a live model output into the two picks the Live Analysis
 * screen shows: the match-result pick (1X2 in soccer, moneyline in basketball)
 * and the Over/Under pick.
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

const CFG = CONFIG.live.pickMarkets;

/** The match-result market name for a sport. */
function resultMarket(sport) {
  return sport === 'soccer' ? '1x2' : 'moneyline';
}

/**
 * The FIXED Over/Under line for this game — a sport/league constant, never the
 * live projection. Soccer uses the configured line; basketball uses the
 * configured line, else the league's own mean total rounded to the nearest half
 * point. Returns null when no line can be established, so the O/U pick is
 * omitted rather than guessed.
 *
 * @param {string} sport
 * @param {Object} [game] LiveGame (for the basketball league id)
 * @returns {number|null}
 */
function overUnderLine(sport, game) {
  const cfg = CFG.overUnder[sport];
  if (!cfg) return null;
  if (Number.isFinite(cfg.line)) return cfg.line;
  if (sport !== 'basketball') return null;
  // A fitted league: its own mean total rounded to the nearest half point. An
  // unrecognised league: the configured fallback line. A half point (X.5) so the
  // total can never push.
  const params = leagueParams(game && game.league && game.league.id);
  if (params && params.fitted && Number.isFinite(params.totalMean)) {
    return M.round(Math.round(params.totalMean) - 0.5, 1);
  }
  return Number.isFinite(cfg.defaultLine) ? cfg.defaultLine : null;
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

/** The most likely match-result selection, with the model's probability. */
function matchResultPick(sport, probabilities) {
  if (!probabilities) return null;
  const p = probabilities;
  const options = [];
  if (Number.isFinite(p.home_win)) options.push({ selection: 'home', probability: p.home_win });
  if (sport === 'soccer' && Number.isFinite(p.draw)) options.push({ selection: 'draw', probability: p.draw });
  if (Number.isFinite(p.away_win)) options.push({ selection: 'away', probability: p.away_win });
  if (!options.length) return null;
  const best = options.reduce((a, b) => (b.probability > a.probability ? b : a));
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
 * Basketball total-points pick: price EVERY evaluation line (Over AND Under)
 * — lines generated around THIS match's expected total — off the model's
 * normal distribution, drop lines the current score has already decided, then
 * take the side at the line NEAREST the expected total (the "main" total),
 * argmax of Over vs Under. Settled lines are never fresh picks.
 *
 * This replaces the old behaviour of pinning one fixed line and reporting
 * whichever side sat a hair above 50% — the source of the constant
 * "Over 219.5" reads on games the model had no real read on.
 */
function basketballTotalsPick(model, game, markets) {
  const cfg = (CFG.overUnder && CFG.overUnder.basketball) || {};
  const minProb = Number.isFinite(cfg.minPickProbability) ? cfg.minPickProbability : 0;
  const list = Array.isArray(markets) && markets.length
    ? markets
    : liveMarkets.buildBasketballTotalMarkets({ model, game });
  const mean = model && model.expected ? model.expected.total : null;

  // Candidate lines: AVAILABLE only (settled markets are never fresh picks),
  // each carrying both sides' probabilities.
  const byLine = new Map();
  for (const m of list) {
    if (!m || m.market !== 'total_points' || m.status !== 'available') continue;
    if (!Number.isFinite(m.probability)) continue;
    const cur = byLine.get(m.line) || { line: m.line, over: null, under: null };
    if (m.side === 'over') cur.over = m.probability; else cur.under = m.probability;
    byLine.set(m.line, cur);
  }
  const candidates = [...byLine.values()].filter(c => c.over != null && c.under != null);
  if (!candidates.length) return null;

  // The pick line is the one NEAREST the expected total — the market's "main"
  // total — not the most extreme profitable line. This is what makes the pick
  // meaningful: it answers "over or under the projected total?", not "which
  // tail is safest?".
  let line;
  if (Number.isFinite(mean)) {
    line = candidates.reduce((a, b) => (Math.abs(b.line - mean) < Math.abs(a.line - mean) ? b : a)).line;
  } else {
    line = candidates[0].line;
  }
  const chosen = byLine.get(line);
  const selection = chosen.over >= chosen.under ? 'over' : 'under';
  const probability = selection === 'over' ? chosen.over : chosen.under;
  if (probability < minProb) return null;
  return {
    market: 'over_under',
    line,
    selection,
    probability,
    over: chosen.over,
    under: chosen.under,
  };
}

/**
 * Derive the picks for one live model output. Returns `{ match_result, over_under }`
 * — each key is an object or null (a null means that market could not be priced,
 * never a placeholder). Returns null overall when the model is not usable.
 *
 * @param {Object} args
 * @param {string} args.sport
 * @param {Object} args.model  a predictLive output (status live | prior_only)
 * @param {Object} [args.game] the LiveGame
 */
function derivePicks({ sport, model, game, markets } = {}) {
  if (!CFG || CFG.enabled === false) return null;
  if (!sport || !model) return null;
  if (model.status !== 'live' && model.status !== 'prior_only') return null;

  const matchResult = sport === 'soccer'
    ? doubleChancePick(model.probabilities)
    : matchResultPick(sport, model.probabilities);
  const overUnder = sport === 'basketball'
    ? basketballTotalsPick(model, game || {}, markets)
    : overUnderPick(sport, model, game || {}, markets);
  if (!matchResult && !overUnder) return null;
  return { match_result: matchResult, over_under: overUnder };
}

module.exports = { derivePicks, overUnderLine, matchResultPick, doubleChancePick, overUnderPick, basketballTotalsPick, soccerOver, basketballOver };
