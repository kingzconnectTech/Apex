/**
 * backtestingService.js
 *
 * Chronological backtesting engine for Apex prediction markets.
 *
 * Responsibilities:
 *   1. Perform time-ordered train/validation/test splits with no future-data leakage
 *   2. Run predictions on historical data using the same model pipelines
 *   3. Calculate evaluation metrics:
 *      - Binary markets: hit rate, Brier score, log loss, calibration bands
 *      - Count/score markets: MAE, RMSE
 *   4. Aggregate and report performance by market and model version
 *   5. Support shots and basketball markets specifically
 *
 * Principles:
 *   - Strict chronological ordering: training data must precede test data
 *   - No leakage: predictions at time T can only use data from < T
 *   - Idempotent: same input always produces same output
 */

const {
  validateAndFilterHistoricalMatches,
  analyzeShotsHistory,
  calculateShotsPrediction,
} = require('./footballShotsAnalysis');

const {
  analyzeBasketballHistory,
  calculateBasketballPrediction,
} = require('./basketballEngine');

/**
 * Calculate Brier score for binary predictions
 * Brier = (1/N) * Σ (p_i - y_i)^2
 * where p_i is predicted probability and y_i is actual outcome (0 or 1)
 *
 * @param {Array<{probability: number, actual: number}>} predictions
 * @returns {number|null}
 */
function calculateBrierScore(predictions) {
  if (!Array.isArray(predictions) || predictions.length === 0) return null;
  const valid = predictions.filter(p => p.probability != null && p.actual != null);
  if (valid.length === 0) return null;

  const sumSquaredError = valid.reduce((sum, p) => {
    const prob = Math.max(0, Math.min(1, p.probability));
    const actual = p.actual === 1 || p.actual === true ? 1 : 0;
    return sum + Math.pow(prob - actual, 2);
  }, 0);

  return sumSquaredError / valid.length;
}

/**
 * Calculate log loss for binary predictions
 * LogLoss = -(1/N) * Σ [y_i * log(p_i) + (1-y_i) * log(1-p_i)]
 *
 * @param {Array<{probability: number, actual: number}>} predictions
 * @returns {number|null}
 */
function calculateLogLoss(predictions) {
  if (!Array.isArray(predictions) || predictions.length === 0) return null;
  const valid = predictions.filter(p => p.probability != null && p.actual != null);
  if (valid.length === 0) return null;

  const sumLogLoss = valid.reduce((sum, p) => {
    const prob = Math.max(0.0001, Math.min(0.9999, p.probability)); // avoid log(0)
    const actual = p.actual === 1 || p.actual === true ? 1 : 0;
    const logLoss = actual === 1
      ? -Math.log(prob)
      : -Math.log(1 - prob);
    return sum + logLoss;
  }, 0);

  return sumLogLoss / valid.length;
}

/**
 * Calculate hit rate (accuracy) for binary predictions
 *
 * @param {Array<{probability: number, actual: number, threshold?: number}>} predictions
 * @param {number} [threshold=0.5]
 * @returns {number|null}
 */
function calculateHitRate(predictions, threshold = 0.5) {
  if (!Array.isArray(predictions) || predictions.length === 0) return null;
  const valid = predictions.filter(p => p.probability != null && p.actual != null);
  if (valid.length === 0) return null;

  const correct = valid.filter(p => {
    const predicted = p.probability >= threshold ? 1 : 0;
    const actual = p.actual === 1 || p.actual === true ? 1 : 0;
    return predicted === actual;
  }).length;

  return correct / valid.length;
}

/**
 * Calculate Mean Absolute Error (MAE) for count/score predictions
 *
 * @param {Array<{predicted: number, actual: number}>} predictions
 * @returns {number|null}
 */
function calculateMAE(predictions) {
  if (!Array.isArray(predictions) || predictions.length === 0) return null;
  const valid = predictions.filter(p => p.predicted != null && p.actual != null);
  if (valid.length === 0) return null;

  const sumAbsError = valid.reduce((sum, p) => sum + Math.abs(p.predicted - p.actual), 0);
  return sumAbsError / valid.length;
}

/**
 * Calculate Root Mean Squared Error (RMSE) for count/score predictions
 *
 * @param {Array<{predicted: number, actual: number}>} predictions
 * @returns {number|null}
 */
function calculateRMSE(predictions) {
  if (!Array.isArray(predictions) || predictions.length === 0) return null;
  const valid = predictions.filter(p => p.predicted != null && p.actual != null);
  if (valid.length === 0) return null;

  const sumSquaredError = valid.reduce((sum, p) => sum + Math.pow(p.predicted - p.actual, 2), 0);
  return Math.sqrt(sumSquaredError / valid.length);
}

/**
 * Calculate calibration by probability band
 * Groups predictions into bands (e.g., 0.5-0.6, 0.6-0.7, etc.) and compares
 * predicted probability to actual hit rate in each band
 *
 * @param {Array<{probability: number, actual: number}>} predictions
 * @param {number} [bandWidth=0.1]
 * @returns {Object|null}
 */
function calculateCalibrationBands(predictions, bandWidth = 0.1) {
  if (!Array.isArray(predictions) || predictions.length === 0) return null;
  const valid = predictions.filter(p => p.probability != null && p.actual != null);
  if (valid.length === 0) return null;

  const bands = {};
  valid.forEach(p => {
    const prob = p.probability;
    const bandStart = Math.floor(prob / bandWidth) * bandWidth;
    const bandEnd = bandStart + bandWidth;
    const bandKey = `${bandStart.toFixed(1)}-${bandEnd.toFixed(1)}`;

    if (!bands[bandKey]) {
      bands[bandKey] = { count: 0, sumProb: 0, sumActual: 0 };
    }

    bands[bandKey].count++;
    bands[bandKey].sumProb += prob;
    const actual = p.actual === 1 || p.actual === true ? 1 : 0;
    bands[bandKey].sumActual += actual;
  });

  // Calculate metrics per band
  const result = {};
  Object.keys(bands).forEach(key => {
    const band = bands[key];
    result[key] = {
      sampleSize: band.count,
      avgPredictedProb: band.sumProb / band.count,
      actualHitRate: band.sumActual / band.count,
      calibrationError: (band.sumProb / band.count) - (band.sumActual / band.count),
    };
  });

  return result;
}

/**
 * Chronological time-based split for backtesting
 * Splits matches into train/validation/test based on date cutoffs
 * Ensures no future data leakage
 *
 * @param {Array} matches - Historical matches with date field
 * @param {Object} options
 * @param {number} [options.trainPct=0.6] - Percentage for training
 * @param {number} [options.valPct=0.2] - Percentage for validation
 * @returns {{train: Array, val: Array, test: Array}}
 */
function chronologicalSplit(matches, { trainPct = 0.6, valPct = 0.2 } = {}) {
  if (!Array.isArray(matches) || matches.length === 0) {
    return { train: [], val: [], test: [] };
  }

  // Sort by date ascending
  const sorted = [...matches].sort((a, b) => {
    const dateA = new Date(a.date).getTime();
    const dateB = new Date(b.date).getTime();
    return dateA - dateB;
  });

  const total = sorted.length;
  const trainSize = Math.floor(total * trainPct);
  const valSize = Math.floor(total * valPct);

  return {
    train: sorted.slice(0, trainSize),
    val: sorted.slice(trainSize, trainSize + valSize),
    test: sorted.slice(trainSize + valSize),
  };
}

/**
 * Run backtesting for football shots markets
 *
 * @param {Array} matches - Historical match data with shots statistics
 * @param {Object} options
 * @returns {Object} Backtest results
 */
function backtestShotsMarkets(matches, options = {}) {
  if (!Array.isArray(matches) || matches.length < 10) {
    return {
      valid: false,
      error: 'Insufficient data for backtesting (minimum 10 matches required)',
    };
  }

  const split = chronologicalSplit(matches, options);
  const { train, val, test } = split;

  if (test.length === 0) {
    return {
      valid: false,
      error: 'Insufficient test data after split',
    };
  }

  const results = {
    valid: true,
    market: 'shots',
    sampleSizes: { train: train.length, val: val.length, test: test.length },
    predictions: [],
    metrics: {},
  };

  // For each test match, generate prediction using only training data
  test.forEach((match, idx) => {
    const homeTeamId = match.homeTeamId;
    const awayTeamId = match.awayTeamId;
    const kickoffDate = match.date;

    // Get historical data for both teams from training set only (no leakage)
    const homeHistory = train.filter(m => {
      const isHome = m.homeTeamId === homeTeamId;
      const isAway = m.awayTeamId === homeTeamId;
      const matchDate = new Date(m.date).getTime();
      const kickoffTime = new Date(kickoffDate).getTime();
      return (isHome || isAway) && matchDate < kickoffTime;
    });

    const awayHistory = train.filter(m => {
      const isHome = m.homeTeamId === awayTeamId;
      const isAway = m.awayTeamId === awayTeamId;
      const matchDate = new Date(m.date).getTime();
      const kickoffTime = new Date(kickoffDate).getTime();
      return (isHome || isAway) && matchDate < kickoffTime;
    });

    // Format history for shots analysis
    const homeMatches = homeHistory.map(m => ({
      ...m,
      shots: m.homeShots,
      shotsConceded: m.awayShots,
      totalShots: m.homeShots + m.awayShots,
      isHome: m.homeTeamId === homeTeamId,
    }));

    const awayMatches = awayHistory.map(m => ({
      ...m,
      shots: m.awayShots,
      shotsConceded: m.homeShots,
      totalShots: m.homeShots + m.awayShots,
      isHome: m.awayTeamId === awayTeamId,
    }));

    // Generate prediction
    const homeAnalysis = analyzeShotsHistory(homeMatches, { isHomeContext: true });
    const awayAnalysis = analyzeShotsHistory(awayMatches, { isHomeContext: false });

    const prediction = calculateShotsPrediction({
      homeAnalysis,
      awayAnalysis,
    });

    if (prediction) {
      const actualTotalShots = match.homeShots + match.awayShots;
      const actualHomeShots = match.homeShots;
      const actualAwayShots = match.awayShots;

      results.predictions.push({
        matchId: match.id,
        matchDate: match.date,
        predictedTotal: prediction.expectedTotalShots,
        actualTotal: actualTotalShots,
        predictedHome: prediction.expectedHomeShots,
        actualHome: actualHomeShots,
        predictedAway: prediction.expectedAwayShots,
        actualAway: actualAwayShots,
        probability: prediction.probability,
        market: prediction.market,
        line: prediction.line,
        side: prediction.marketType,
      });
    }
  });

  // Calculate metrics
  if (results.predictions.length > 0) {
    // Count metrics (MAE, RMSE)
    const totalPredictions = results.predictions.map(p => ({
      predicted: p.predictedTotal,
      actual: p.actualTotal,
    }));
    results.metrics.totalMAE = calculateMAE(totalPredictions);
    results.metrics.totalRMSE = calculateRMSE(totalPredictions);

    // Binary metrics (Brier, log loss, hit rate) for over/under
    const binaryPredictions = results.predictions.map(p => {
      const line = p.line || 21.5;
      const actualOver = p.actualTotal > line ? 1 : 0;
      const predictedOver = p.side === 'over' ? p.probability : 1 - p.probability;
      return { probability: predictedOver, actual: actualOver };
    });
    results.metrics.brierScore = calculateBrierScore(binaryPredictions);
    results.metrics.logLoss = calculateLogLoss(binaryPredictions);
    results.metrics.hitRate = calculateHitRate(binaryPredictions);
    results.metrics.calibrationBands = calculateCalibrationBands(binaryPredictions);
  }

  return results;
}

/**
 * Run backtesting for basketball markets
 *
 * @param {Array} matches - Historical match data with basketball box scores
 * @param {Object} options
 * @returns {Object} Backtest results
 */
function backtestBasketballMarkets(matches, options = {}) {
  if (!Array.isArray(matches) || matches.length < 10) {
    return {
      valid: false,
      error: 'Insufficient data for backtesting (minimum 10 matches required)',
    };
  }

  const split = chronologicalSplit(matches, options);
  const { train, val, test } = split;

  if (test.length === 0) {
    return {
      valid: false,
      error: 'Insufficient test data after split',
    };
  }

  const results = {
    valid: true,
    market: 'basketball',
    sampleSizes: { train: train.length, val: val.length, test: test.length },
    predictions: [],
    metrics: {},
  };

  // For each test match, generate prediction using only training data
  test.forEach((match, idx) => {
    const homeTeamId = match.homeTeamId;
    const awayTeamId = match.awayTeamId;
    const kickoffDate = match.date;

    // Get historical data for both teams from training set only
    const homeHistory = train.filter(m => {
      const isHome = m.homeTeamId === homeTeamId;
      const isAway = m.awayTeamId === homeTeamId;
      const matchDate = new Date(m.date).getTime();
      const kickoffTime = new Date(kickoffDate).getTime();
      return (isHome || isAway) && matchDate < kickoffTime;
    });

    const awayHistory = train.filter(m => {
      const isHome = m.homeTeamId === awayTeamId;
      const isAway = m.awayTeamId === awayTeamId;
      const matchDate = new Date(m.date).getTime();
      const kickoffTime = new Date(kickoffDate).getTime();
      return (isHome || isAway) && matchDate < kickoffTime;
    });

    // Format history for basketball analysis
    const homeMatches = homeHistory.map(m => ({
      pf: m.homeTeamId === homeTeamId ? m.homePoints : m.awayPoints,
      pa: m.homeTeamId === homeTeamId ? m.awayPoints : m.homePoints,
      boxScore: m.boxScore,
      isHome: m.homeTeamId === homeTeamId,
      date: m.date,
    }));

    const awayMatches = awayHistory.map(m => ({
      pf: m.awayTeamId === awayTeamId ? m.homePoints : m.awayPoints,
      pa: m.awayTeamId === awayTeamId ? m.awayPoints : m.homePoints,
      boxScore: m.boxScore,
      isHome: m.awayTeamId === awayTeamId,
      date: m.date,
    }));

    // Generate prediction
    const homeAnalysis = analyzeBasketballHistory(homeMatches, { isHomeContext: true });
    const awayAnalysis = analyzeBasketballHistory(awayMatches, { isHomeContext: false });

    const prediction = calculateBasketballPrediction({
      homeAnalysis,
      awayAnalysis,
    });

    if (prediction) {
      const actualHomePoints = match.homePoints;
      const actualAwayPoints = match.awayPoints;
      const actualTotalPoints = actualHomePoints + actualAwayPoints;
      const actualHomeWin = actualHomePoints > actualAwayPoints ? 1 : 0;

      results.predictions.push({
        matchId: match.id,
        matchDate: match.date,
        predictedHome: prediction.expectedHomePoints,
        actualHome: actualHomePoints,
        predictedAway: prediction.expectedAwayPoints,
        actualAway: actualAwayPoints,
        predictedTotal: prediction.expectedTotalPoints,
        actualTotal: actualTotalPoints,
        homeWinProbability: prediction.homeWinProbability,
        actualHomeWin,
        market: prediction.market,
      });
    }
  });

  // Calculate metrics
  if (results.predictions.length > 0) {
    // Count metrics (MAE, RMSE)
    const totalPredictions = results.predictions.map(p => ({
      predicted: p.predictedTotal,
      actual: p.actualTotal,
    }));
    results.metrics.totalMAE = calculateMAE(totalPredictions);
    results.metrics.totalRMSE = calculateRMSE(totalPredictions);

    // Binary metrics for match winner
    const winnerPredictions = results.predictions.map(p => ({
      probability: p.homeWinProbability,
      actual: p.actualHomeWin,
    }));
    results.metrics.brierScore = calculateBrierScore(winnerPredictions);
    results.metrics.logLoss = calculateLogLoss(winnerPredictions);
    results.metrics.hitRate = calculateHitRate(winnerPredictions);
    results.metrics.calibrationBands = calculateCalibrationBands(winnerPredictions);
  }

  return results;
}

/**
 * Validate that no future-date match appears in training data
 * Ensures strict chronological split integrity
 *
 * @param {Array} train - Training matches
 * @param {Array} test - Test matches
 * @returns {boolean}
 */
function validateNoFutureLeakage(train, test) {
  if (!Array.isArray(train) || !Array.isArray(test)) return false;

  const testDates = test.map(m => new Date(m.date).getTime());
  const maxTestDate = Math.max(...testDates);

  const futureInTrain = train.filter(m => {
    const trainDate = new Date(m.date).getTime();
    return trainDate >= maxTestDate;
  });

  return futureInTrain.length === 0;
}

module.exports = {
  calculateBrierScore,
  calculateLogLoss,
  calculateHitRate,
  calculateMAE,
  calculateRMSE,
  calculateCalibrationBands,
  chronologicalSplit,
  backtestShotsMarkets,
  backtestBasketballMarkets,
  validateNoFutureLeakage,
};
