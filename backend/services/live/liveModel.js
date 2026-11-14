/**
 * live/liveModel.js
 *
 * Phase 4 — entry point for the live probability models.
 *
 * Picks the model by sport, applies the data-tier blend weight from ./config,
 * and refuses to model a sport we have not validated (manual entry / projection
 * only). The per-sport maths lives in ./soccerLive and ./basketballLive.
 */

const CONFIG = require('./config');
const { predictSoccer } = require('./soccerLive');
const { predictBasketball } = require('./basketballLive');

/**
 * How much the live estimate is trusted versus the pre-game prior, by data tier.
 * An unknown tier is treated as the most conservative (lowest) weight.
 */
function tierWeight(tier) {
  const table = CONFIG.liveModel.tierWeight;
  if (tier && Object.prototype.hasOwnProperty.call(table, tier)) return table[tier];
  return Math.min(...Object.values(table));
}

/**
 * Model a live game.
 *
 * @param {Object} args
 * @param {Object} args.game    Phase 3 LiveGame (from services/live/liveGame)
 * @param {Object} [args.context] provider extras: { red_cards, shots_on_target }
 * @returns {Object} model output; `status` is 'live' | 'prior_only' | 'not_live' | 'unsupported'
 */
function predictLive({ game, context = {} } = {}) {
  if (!game || !game.sport) {
    throw new Error('predictLive requires a LiveGame object with a sport.');
  }
  if (!CONFIG.live.supportedSports.includes(game.sport)) {
    return {
      sport: game.sport,
      model: null,
      status: 'unsupported',
      reason: `live probability model is not available for ${game.sport}`,
      data_tier: game.data_tier || null,
      notes: ['Manual entry or pre-game projection only.'],
    };
  }
  if (!game.live || game.live.status === 'finished') {
    return {
      sport: game.sport,
      model: null,
      status: 'not_live',
      reason: 'the game is finished — no live model applies',
      data_tier: game.data_tier || null,
      notes: [],
    };
  }

  const manual = Boolean(game.manual);
  // Phase 7 — a hand-typed game is trusted less than its tier weight alone
  // implies: the live estimate is shrunk further toward the pre-game prior, and
  // any provider context is dropped, because nothing typed by hand has been
  // verified and no provider supplied the events.
  const weight = manual
    ? tierWeight(game.data_tier) * (1 - CONFIG.liveModel.manual.extraShrink)
    : tierWeight(game.data_tier);
  const usableContext = manual ? {} : context;

  if (game.sport === 'soccer') {
    return predictSoccer({ game, context: usableContext, weight, manual });
  }
  if (game.sport === 'basketball') return predictBasketball({ game, weight, manual });

  return {
    sport: game.sport,
    model: null,
    status: 'unsupported',
    reason: `no live model registered for ${game.sport}`,
    data_tier: game.data_tier || null,
    notes: [],
  };
}

module.exports = { predictLive, tierWeight };
