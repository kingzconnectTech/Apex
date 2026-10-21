/**
 * Pure view logic for basketball predictions.
 *
 * Kept out of the screen components so the loading / success /
 * insufficient-data / API-failure / generation-failure states can be unit
 * tested without a React Native renderer.
 *
 * CommonJS on purpose: this module has no React Native imports, so it can be
 * loaded from plain Node (`node --test frontend/__tests__`) as well as by Metro.
 */

/** The UI states a prediction response can be in. */
const PREDICTION_STATE = {
  LOADING: 'loading',
  SUCCESS: 'success',
  INSUFFICIENT_DATA: 'insufficient_data',
  API_FAILURE: 'api_failure',
  GENERATION_FAILURE: 'generation_failure',
  INVALID_MATCH: 'invalid_match',
  UNAVAILABLE: 'unavailable',
};

const MESSAGES = {
  otherSport: 'Prediction data unavailable. Try again later.',
  noHistoricalData: 'No historical basketball data was found for this match.',
  notEnoughForPick: 'Not enough historical data to produce a basketball pick for this match.',
  noPredictions: 'No predictions available for this match.',
  generationFailure: 'Not enough usable basketball data to generate a prediction for this match.',
  apiFailure: 'The basketball data provider is unavailable right now. Please try again shortly.',
  invalidMatch: 'This match could not be identified for basketball predictions.',
  network: 'Network error. Check your connection.',
  unavailable: 'Basketball prediction data is unavailable. Try again later.',
};

/** Message used when the backend returned 200 but no market cleared. */
function insufficientMarketMessage(result, sport) {
  if (sport !== 'basketball') return MESSAGES.noPredictions;
  return result?.noPick ? MESSAGES.notEnoughForPick : MESSAGES.noPredictions;
}

/**
 * Turn a failed prediction response into a specific, honest message.
 *
 * Basketball reports distinct failure codes from the backend so the user can
 * tell "no historical data" apart from a provider outage or a generation
 * failure. Other sports keep the original generic wording.
 *
 * @param {Object|null} result - { unavailable, httpStatus, code, message }
 * @param {string} sport
 * @returns {string}
 */
function describePredictionFailure(result, sport) {
  if (sport !== 'basketball') return MESSAGES.otherSport;

  switch (result?.code) {
    case 'NO_SUMMARY':
    case 'NO_FIXTURE_DATA':
      return MESSAGES.noHistoricalData;
    case 'GENERATION_FAILURE':
      return MESSAGES.generationFailure;
    case 'UPSTREAM_FAILURE':
      return MESSAGES.apiFailure;
    case 'INVALID_LEAGUE':
    case 'INVALID_GAME_ID':
      return MESSAGES.invalidMatch;
    case 'NETWORK_ERROR':
      return MESSAGES.network;
    default:
      return result?.message || MESSAGES.unavailable;
  }
}

/**
 * Classify a prediction response into one of the required UI states.
 *
 * A successful payload always carries a `recommendations` array (possibly
 * empty) — an empty array means the engine ran but no market had usable data,
 * which is NOT an API failure.
 *
 * @param {Object|null} result
 * @param {string} sport
 * @returns {{ state: string, message: string|null }}
 */
function classifyPredictionResult(result, sport) {
  if (result == null) return { state: PREDICTION_STATE.LOADING, message: null };

  if (Array.isArray(result.recommendations)) {
    return result.recommendations.length > 0
      ? { state: PREDICTION_STATE.SUCCESS, message: null }
      : { state: PREDICTION_STATE.INSUFFICIENT_DATA, message: insufficientMarketMessage(result, sport) };
  }

  return { state: failureState(result), message: describePredictionFailure(result, sport) };
}

/** Map a backend error code to its UI state. */
function failureState(result) {
  const code = result?.code;
  switch (code) {
    case 'NO_SUMMARY':
    case 'NO_FIXTURE_DATA':
      return PREDICTION_STATE.INSUFFICIENT_DATA;
    case 'GENERATION_FAILURE':
      return PREDICTION_STATE.GENERATION_FAILURE;
    case 'UPSTREAM_FAILURE':
    case 'NETWORK_ERROR':
      return PREDICTION_STATE.API_FAILURE;
    case 'INVALID_LEAGUE':
    case 'INVALID_GAME_ID':
      return PREDICTION_STATE.INVALID_MATCH;
    default:
      // An HTTP failure with no code is a server/provider problem, not missing data.
      return result?.unavailable ? PREDICTION_STATE.API_FAILURE : PREDICTION_STATE.UNAVAILABLE;
  }
}

/** The markets the game card renders, in priority order. */
const BASKETBALL_MARKETS = ['Total Points', 'Spread'];

/**
 * Resolve what the card should render for every supported market.
 *
 * Returns one entry per market so a market with no usable data is shown as an
 * explicit "no pick" row instead of being hidden or faked, and a market that
 * DID produce a pick is still rendered when its sibling failed.
 *
 * @param {Object} prediction - formatted basketball prediction (has `picks`)
 * @param {string[]} [markets]
 * @returns {Array<{ market: string, pick: Object|null, empty: boolean, emptyLabel: string }>}
 */
function resolveMarketViews(prediction, markets = BASKETBALL_MARKETS) {
  const picks = Array.isArray(prediction?.picks) ? prediction.picks : [];
  return markets.map(market => {
    const pick = picks.find(p => p?.market === market) || null;
    return {
      market,
      pick,
      empty: !pick,
      emptyLabel: prediction?.noPickLabel || 'No confident pick',
    };
  });
}

module.exports = {
  PREDICTION_STATE,
  MESSAGES,
  BASKETBALL_MARKETS,
  insufficientMarketMessage,
  describePredictionFailure,
  classifyPredictionResult,
  resolveMarketViews,
};
