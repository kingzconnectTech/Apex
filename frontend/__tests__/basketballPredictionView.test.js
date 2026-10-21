/**
 * Frontend view-logic tests for basketball predictions.
 *
 * These are the pure decisions the UI makes: which state to show, which message
 * to print, and which markets the game card renders. They run under Node's
 * built-in test runner (no React Native renderer needed):
 *
 *   cd frontend && npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PREDICTION_STATE,
  MESSAGES,
  BASKETBALL_MARKETS,
  classifyPredictionResult,
  describePredictionFailure,
  insufficientMarketMessage,
  resolveMarketViews,
} = require('../utils/basketballPredictionView');

/** A successful backend basketball payload (POST /api/match-prediction). */
function successPayload(overrides = {}) {
  return {
    matchId: '401',
    sport: 'basketball',
    homeName: 'Home Hawks',
    awayName: 'Away Aces',
    recommendations: [
      {
        type: 'Total Points', label: 'Total Points', value: 'Over 220.5',
        confidence: 'Medium', probability: 0.6139, edge: 0.1031,
      },
      {
        type: 'Spread', label: 'Spread', value: 'Home Hawks -3.5',
        confidence: 'Medium', probability: 0.5901, edge: 0.06,
      },
    ],
    prediction: 'Over 220.5',
    confidence: 'Medium',
    noPick: false,
    noPickLabel: null,
    factors: [],
    projection: { total: 221.4, margin: 4.1 },
    dataQuality: 0.72,
    modelVersion: 'bb-1.0.0',
    ...overrides,
  };
}

test('a paint-by-numbers success payload classifies as success', () => {
  const outcome = classifyPredictionResult(successPayload(), 'basketball');
  assert.equal(outcome.state, PREDICTION_STATE.SUCCESS);
  assert.equal(outcome.message, null);
});

test('no response yet means loading, not an error', () => {
  const outcome = classifyPredictionResult(null, 'basketball');
  assert.equal(outcome.state, PREDICTION_STATE.LOADING);
  assert.equal(outcome.message, null);
});

test('a 200 with an empty recommendations array is insufficient data, not an API failure', () => {
  const outcome = classifyPredictionResult(successPayload({ recommendations: [], noPick: true }), 'basketball');
  assert.equal(outcome.state, PREDICTION_STATE.INSUFFICIENT_DATA);
  assert.equal(outcome.message, MESSAGES.notEnoughForPick);
});

test('an empty recommendations array without a noPick flag still reads as no predictions', () => {
  const outcome = classifyPredictionResult({ recommendations: [], noPick: false }, 'basketball');
  assert.equal(outcome.state, PREDICTION_STATE.INSUFFICIENT_DATA);
  assert.equal(outcome.message, MESSAGES.noPredictions);
});

test('each backend failure code maps to its own UI state and message', () => {
  const cases = [
    ['NO_SUMMARY', PREDICTION_STATE.INSUFFICIENT_DATA, MESSAGES.noHistoricalData],
    ['NO_FIXTURE_DATA', PREDICTION_STATE.INSUFFICIENT_DATA, MESSAGES.noHistoricalData],
    ['GENERATION_FAILURE', PREDICTION_STATE.GENERATION_FAILURE, MESSAGES.generationFailure],
    ['UPSTREAM_FAILURE', PREDICTION_STATE.API_FAILURE, MESSAGES.apiFailure],
    ['NETWORK_ERROR', PREDICTION_STATE.API_FAILURE, MESSAGES.network],
    ['INVALID_LEAGUE', PREDICTION_STATE.INVALID_MATCH, MESSAGES.invalidMatch],
    ['INVALID_GAME_ID', PREDICTION_STATE.INVALID_MATCH, MESSAGES.invalidMatch],
  ];

  cases.forEach(([code, state, message]) => {
    const outcome = classifyPredictionResult({ unavailable: true, httpStatus: 404, code, message: 'server detail' }, 'basketball');
    assert.equal(outcome.state, state, `${code} state`);
    assert.equal(outcome.message, message, `${code} message`);
  });
});

test('an HTTP failure with no code is an API failure, never blamed on missing data', () => {
  const outcome = classifyPredictionResult({ unavailable: true, httpStatus: 500, code: null, message: null }, 'basketball');
  assert.equal(outcome.state, PREDICTION_STATE.API_FAILURE);
});

test('an unknown response shape falls back to the generic unavailable message', () => {
  const outcome = classifyPredictionResult({}, 'basketball');
  assert.equal(outcome.state, PREDICTION_STATE.UNAVAILABLE);
  assert.equal(outcome.message, MESSAGES.unavailable);
});

test('a backend message is surfaced verbatim when the code is unknown', () => {
  const outcome = classifyPredictionResult({ code: 'SOMETHING_NEW', message: 'Specific reason' }, 'basketball');
  assert.equal(outcome.message, 'Specific reason');
});

test('other sports keep the original generic wording', () => {
  assert.equal(describePredictionFailure({ code: 'NO_SUMMARY' }, 'soccer'), MESSAGES.otherSport);
  assert.equal(insufficientMarketMessage({ noPick: true }, 'soccer'), MESSAGES.noPredictions);
  assert.equal(classifyPredictionResult(null, 'soccer').state, PREDICTION_STATE.LOADING);
});

test('the card renders Total Points and Spread from a full prediction', () => {
  // Shape returned by GET /api/basketball/predictions (formatPrediction output).
  const prediction = {
    game: 'Home Hawks vs Away Aces',
    picks: [
      { market: 'Total Points', selection: 'Over 220.5', probability: 0.6139, edge: 0.1031, confidence: 'Medium', line: 220.5, isModelLine: false },
      { market: 'Spread', selection: 'Home Hawks -3.5', probability: 0.5901, edge: 0.06, confidence: 'Medium', line: -3.5, isModelLine: false },
    ],
    noPick: false,
  };

  const views = resolveMarketViews(prediction);
  assert.deepEqual(views.map(v => v.market), BASKETBALL_MARKETS);
  assert.deepEqual(views.map(v => v.empty), [false, false]);
  assert.equal(views[0].pick.selection, 'Over 220.5');
  assert.equal(views[1].pick.selection, 'Home Hawks -3.5');
});

test('a market with no pick renders its own empty row while the other still renders', () => {
  const views = resolveMarketViews({
    noPickLabel: 'No confident pick',
    picks: [{ market: 'Total Points', selection: 'Under 219.5', probability: 0.6, edge: 0.05, confidence: 'Low', line: 219.5 }],
  });

  const [total, spread] = views;
  assert.equal(total.empty, false);
  assert.equal(total.pick.selection, 'Under 219.5');
  assert.equal(spread.empty, true);
  assert.equal(spread.pick, null);
  assert.equal(spread.emptyLabel, 'No confident pick');
});

test('a prediction with no picks renders every market as an explicit empty row (nothing fabricated)', () => {
  const views = resolveMarketViews({ picks: [], noPick: true, noPickLabel: 'Not enough historical data' });

  assert.equal(views.length, 2);
  views.forEach(v => {
    assert.equal(v.empty, true);
    assert.equal(v.pick, null);
    assert.equal(v.emptyLabel, 'Not enough historical data');
  });
});

test('a malformed prediction never throws while rendering', () => {
  assert.doesNotThrow(() => resolveMarketViews(null));
  assert.doesNotThrow(() => resolveMarketViews({}));
  assert.doesNotThrow(() => resolveMarketViews({ picks: null }));
  assert.deepEqual(resolveMarketViews(undefined).map(v => v.empty), [true, true]);
});
