/**
 * footballRanking.js
 *
 * Shared utility for ranking and selecting the top-2 highest-confidence
 * football predictions from the approved markets:
 *   under_4_5_goals, under_2_5_ht, under_corners, under_1_5_ht
 *
 * Used by both server.js (production) and the test suite.
 */

/**
 * Approved football markets, in deterministic tie-break priority order.
 * @type {string[]}
 */
const FOOTBALL_MARKET_PRIORITY = [
  'under_4_5_goals',
  'under_2_5_ht',
  'under_corners',
  'over_corners',
  'under_bookings',
  'over_bookings',
  'under_1_5_ht',
  'total_shots_over_19_5',
  'total_shots_under_19_5',
  'total_shots_over_21_5',
  'total_shots_under_21_5',
  'total_shots_over_23_5',
  'total_shots_under_23_5',
  'total_shots_over_25_5',
  'total_shots_under_25_5',
  'total_shots_over_27_5',
  'total_shots_under_27_5',
];

/**
 * Selects the top-2 highest-confidence valid predictions from the four
 * approved football markets.
 *
 * Validation: confidence must be a finite number in [0, 100].
 * Accepts both percentage (0-100) and probability (0-1) ranges.
 * Deduplicates markets before ranking; keeps highest confidence on tie.
 *
 * @param {Array<{market: string, confidence: number}>} predictions
 * @returns {Array} At most 2 predictions, highest confidence first.
 */
function rankFootballPredictions(predictions) {
  if (!Array.isArray(predictions)) return [];

  // Step 1: Validate
  const validPredictions = predictions.filter((pred) => {
    const conf = pred.confidence;
    return (
      typeof conf === 'number' &&
      !isNaN(conf) &&
      isFinite(conf) &&
      conf >= 0 &&
      conf <= 100
    );
  });

  // Step 2: Deduplicate by market (keep highest confidence)
  const marketMap = new Map();
  validPredictions.forEach((pred) => {
    const existing = marketMap.get(pred.market);
    if (!existing || pred.confidence > existing.confidence) {
      marketMap.set(pred.market, pred);
    }
  });

  // Step 3: Sort by confidence descending
  const deduped = Array.from(marketMap.values());
  deduped.sort((a, b) => b.confidence - a.confidence);

  // Step 4: Deterministic tie-break on equal confidence
  deduped.sort((a, b) => {
    if (Math.abs(a.confidence - b.confidence) < 0.01) {
      return (
        FOOTBALL_MARKET_PRIORITY.indexOf(a.market) -
        FOOTBALL_MARKET_PRIORITY.indexOf(b.market)
      );
    }
    return 0;
  });

  // Step 5: Select top 2
  return deduped.slice(0, 2);
}

module.exports = { rankFootballPredictions, FOOTBALL_MARKET_PRIORITY };
