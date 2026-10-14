/**
 * Backtesting Service Unit Tests
 *
 * Tests for AC-11:
 *   - Chronological train/validation/test split
 *   - No future-data leakage validation
 *   - Brier score, log loss, MAE, RMSE calculations
 *   - Calibration bands
 *   - Shots market backtesting
 *   - Basketball market backtesting
 */

const {
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
} = require('../services/backtestingService');

describe('Backtesting Service', () => {
  describe('Metric Calculations', () => {
    test('calculates Brier score correctly', () => {
      const predictions = [
        { probability: 0.8, actual: 1 },
        { probability: 0.3, actual: 0 },
        { probability: 0.6, actual: 1 },
        { probability: 0.4, actual: 0 },
      ];

      const brier = calculateBrierScore(predictions);
      // Expected: ((0.8-1)^2 + (0.3-0)^2 + (0.6-1)^2 + (0.4-0)^2) / 4
      // = (0.04 + 0.09 + 0.16 + 0.16) / 4 = 0.45 / 4 = 0.1125
      expect(brier).toBeCloseTo(0.1125, 4);
    });

    test('calculates log loss correctly', () => {
      const predictions = [
        { probability: 0.8, actual: 1 },
        { probability: 0.3, actual: 0 },
      ];

      const logLoss = calculateLogLoss(predictions);
      // Expected: -(log(0.8) + log(0.7)) / 2
      expect(logLoss).toBeGreaterThan(0);
      expect(logLoss).toBeLessThan(1);
    });

    test('calculates hit rate correctly', () => {
      const predictions = [
        { probability: 0.8, actual: 1 },
        { probability: 0.3, actual: 0 },
        { probability: 0.6, actual: 0 }, // incorrect
        { probability: 0.4, actual: 1 }, // incorrect
      ];

      const hitRate = calculateHitRate(predictions, 0.5);
      expect(hitRate).toBe(0.5); // 2 correct out of 4
    });

    test('calculates MAE correctly', () => {
      const predictions = [
        { predicted: 10, actual: 12 },
        { predicted: 15, actual: 14 },
        { predicted: 20, actual: 18 },
      ];

      const mae = calculateMAE(predictions);
      // Expected: (|10-12| + |15-14| + |20-18|) / 3 = (2 + 1 + 2) / 3 = 1.67
      expect(mae).toBeCloseTo(1.67, 2);
    });

    test('calculates RMSE correctly', () => {
      const predictions = [
        { predicted: 10, actual: 12 },
        { predicted: 15, actual: 14 },
        { predicted: 20, actual: 18 },
      ];

      const rmse = calculateRMSE(predictions);
      // Expected: sqrt((4 + 1 + 4) / 3) = sqrt(3) ≈ 1.73
      expect(rmse).toBeCloseTo(1.73, 2);
    });

    test('calculates calibration bands correctly', () => {
      const predictions = [
        { probability: 0.55, actual: 1 },
        { probability: 0.56, actual: 1 },
        { probability: 0.57, actual: 0 },
        { probability: 0.65, actual: 1 },
        { probability: 0.75, actual: 1 },
        { probability: 0.76, actual: 0 },
      ];

      const bands = calculateCalibrationBands(predictions, 0.1);

      expect(bands).toBeDefined();
      expect(bands['0.5-0.6']).toBeDefined();
      expect(bands['0.5-0.6'].sampleSize).toBe(3);
      expect(bands['0.5-0.6'].avgPredictedProb).toBeCloseTo(0.56, 2);
      expect(bands['0.5-0.6'].actualHitRate).toBeCloseTo(0.67, 2); // 2/3
    });

    test('returns null for empty predictions', () => {
      expect(calculateBrierScore([])).toBeNull();
      expect(calculateLogLoss([])).toBeNull();
      expect(calculateHitRate([])).toBeNull();
      expect(calculateMAE([])).toBeNull();
      expect(calculateRMSE([])).toBeNull();
      expect(calculateCalibrationBands([])).toBeNull();
    });
  });

  describe('AC-11: Chronological Split', () => {
    test('splits data chronologically without leakage', () => {
      const matches = [
        { id: 1, date: '2026-01-01' },
        { id: 2, date: '2026-01-05' },
        { id: 3, date: '2026-01-10' },
        { id: 4, date: '2026-01-15' },
        { id: 5, date: '2026-01-20' },
        { id: 6, date: '2026-01-25' },
        { id: 7, date: '2026-01-30' },
        { id: 8, date: '2026-02-05' },
        { id: 9, date: '2026-02-10' },
        { id: 10, date: '2026-02-15' },
      ];

      const split = chronologicalSplit(matches, { trainPct: 0.6, valPct: 0.2 });

      expect(split.train.length).toBe(6);
      expect(split.val.length).toBe(2);
      expect(split.test.length).toBe(2);

      // Verify chronological order
      const trainDates = split.train.map(m => new Date(m.date).getTime());
      const testDates = split.test.map(m => new Date(m.date).getTime());

      expect(Math.max(...trainDates)).toBeLessThan(Math.min(...testDates));
    });

    test('handles empty input', () => {
      const split = chronologicalSplit([]);
      expect(split.train).toEqual([]);
      expect(split.val).toEqual([]);
      expect(split.test).toEqual([]);
    });

    test('validates no future leakage', () => {
      const train = [
        { id: 1, date: '2026-01-01' },
        { id: 2, date: '2026-01-05' },
        { id: 3, date: '2026-01-10' },
      ];

      const test = [
        { id: 4, date: '2026-01-15' },
        { id: 5, date: '2026-01-20' },
      ];

      expect(validateNoFutureLeakage(train, test)).toBe(true);
    });

    test('detects future leakage', () => {
      const train = [
        { id: 1, date: '2026-01-01' },
        { id: 2, date: '2026-01-05' },
        { id: 3, date: '2026-01-25' }, // Future leak!
      ];

      const test = [
        { id: 4, date: '2026-01-15' },
        { id: 5, date: '2026-01-20' },
      ];

      expect(validateNoFutureLeakage(train, test)).toBe(false);
    });
  });

  describe('Shots Market Backtesting', () => {
    test('runs backtest on shots data', () => {
      const matches = [
        {
          id: 1,
          date: '2026-01-01',
          homeTeamId: 'team1',
          awayTeamId: 'team2',
          homeShots: 12,
          awayShots: 8,
        },
        {
          id: 2,
          date: '2026-01-05',
          homeTeamId: 'team1',
          awayTeamId: 'team3',
          homeShots: 14,
          awayShots: 10,
        },
        {
          id: 3,
          date: '2026-01-10',
          homeTeamId: 'team2',
          awayTeamId: 'team1',
          homeShots: 10,
          awayShots: 13,
        },
        {
          id: 4,
          date: '2026-01-15',
          homeTeamId: 'team1',
          awayTeamId: 'team2',
          homeShots: 11,
          awayShots: 9,
        },
        {
          id: 5,
          date: '2026-01-20',
          homeTeamId: 'team3',
          awayTeamId: 'team1',
          homeShots: 9,
          awayShots: 12,
        },
        {
          id: 6,
          date: '2026-01-25',
          homeTeamId: 'team1',
          awayTeamId: 'team2',
          homeShots: 13,
          awayShots: 11,
        },
        {
          id: 7,
          date: '2026-01-30',
          homeTeamId: 'team2',
          awayTeamId: 'team1',
          homeShots: 8,
          awayShots: 14,
        },
        {
          id: 8,
          date: '2026-02-05',
          homeTeamId: 'team1',
          awayTeamId: 'team2',
          homeShots: 15,
          awayShots: 7,
        },
        {
          id: 9,
          date: '2026-02-10',
          homeTeamId: 'team3',
          awayTeamId: 'team1',
          homeShots: 10,
          awayShots: 11,
        },
        {
          id: 10,
          date: '2026-02-15',
          homeTeamId: 'team1',
          awayTeamId: 'team2',
          homeShots: 12,
          awayShots: 10,
        },
      ];

      const result = backtestShotsMarkets(matches);

      expect(result.valid).toBe(true);
      expect(result.market).toBe('shots');
      expect(result.sampleSizes).toBeDefined();
      expect(result.predictions).toBeInstanceOf(Array);
      expect(result.metrics).toBeDefined();
    });

    test('returns error for insufficient data', () => {
      const matches = [
        { id: 1, date: '2026-01-01', homeTeamId: 'team1', awayTeamId: 'team2', homeShots: 12, awayShots: 8 },
      ];

      const result = backtestShotsMarkets(matches);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Insufficient data');
    });

    test('calculates metrics for shots predictions', () => {
      const matches = [
        {
          id: 1,
          date: '2026-01-01',
          homeTeamId: 'team1',
          awayTeamId: 'team2',
          homeShots: 12,
          awayShots: 8,
        },
        {
          id: 2,
          date: '2026-01-05',
          homeTeamId: 'team1',
          awayTeamId: 'team3',
          homeShots: 14,
          awayShots: 10,
        },
        {
          id: 3,
          date: '2026-01-10',
          homeTeamId: 'team2',
          awayTeamId: 'team1',
          homeShots: 10,
          awayShots: 13,
        },
        {
          id: 4,
          date: '2026-01-15',
          homeTeamId: 'team1',
          awayTeamId: 'team2',
          homeShots: 11,
          awayShots: 9,
        },
        {
          id: 5,
          date: '2026-01-20',
          homeTeamId: 'team3',
          awayTeamId: 'team1',
          homeShots: 9,
          awayShots: 12,
        },
        {
          id: 6,
          date: '2026-01-25',
          homeTeamId: 'team1',
          awayTeamId: 'team2',
          homeShots: 13,
          awayShots: 11,
        },
        {
          id: 7,
          date: '2026-01-30',
          homeTeamId: 'team2',
          awayTeamId: 'team1',
          homeShots: 8,
          awayShots: 14,
        },
        {
          id: 8,
          date: '2026-02-05',
          homeTeamId: 'team1',
          awayTeamId: 'team2',
          homeShots: 15,
          awayShots: 7,
        },
        {
          id: 9,
          date: '2026-02-10',
          homeTeamId: 'team3',
          awayTeamId: 'team1',
          homeShots: 10,
          awayShots: 11,
        },
        {
          id: 10,
          date: '2026-02-15',
          homeTeamId: 'team1',
          awayTeamId: 'team2',
          homeShots: 12,
          awayShots: 10,
        },
      ];

      const result = backtestShotsMarkets(matches);

      if (result.valid && result.predictions.length > 0) {
        expect(result.metrics.totalMAE).toBeDefined();
        expect(result.metrics.totalRMSE).toBeDefined();
        expect(result.metrics.brierScore).toBeDefined();
        expect(result.metrics.logLoss).toBeDefined();
        expect(result.metrics.hitRate).toBeDefined();
        expect(result.metrics.calibrationBands).toBeDefined();
      }
    });
  });

  describe('Basketball Market Backtesting', () => {
    test('runs backtest on basketball data', () => {
      const matches = [
        {
          id: 1,
          date: '2026-01-01',
          homeTeamId: 'team1',
          awayTeamId: 'team2',
          homePoints: 110,
          awayPoints: 105,
          boxScore: { fga: 85, orb: 10, tov: 12, fta: 20 },
        },
        {
          id: 2,
          date: '2026-01-05',
          homeTeamId: 'team1',
          awayTeamId: 'team3',
          homePoints: 108,
          awayPoints: 102,
          boxScore: { fga: 82, orb: 8, tov: 10, fta: 18 },
        },
        {
          id: 3,
          date: '2026-01-10',
          homeTeamId: 'team2',
          awayTeamId: 'team1',
          homePoints: 105,
          awayPoints: 112,
          boxScore: { fga: 84, orb: 11, tov: 11, fta: 19 },
        },
        {
          id: 4,
          date: '2026-01-15',
          homeTeamId: 'team1',
          awayTeamId: 'team2',
          homePoints: 115,
          awayPoints: 100,
          boxScore: { fga: 88, orb: 9, tov: 10, fta: 20 },
        },
        {
          id: 5,
          date: '2026-01-20',
          homeTeamId: 'team3',
          awayTeamId: 'team1',
          homePoints: 98,
          awayPoints: 118,
          boxScore: { fga: 80, orb: 12, tov: 13, fta: 17 },
        },
        {
          id: 6,
          date: '2026-01-25',
          homeTeamId: 'team1',
          awayTeamId: 'team2',
          homePoints: 112,
          awayPoints: 108,
          boxScore: { fga: 86, orb: 10, tov: 11, fta: 19 },
        },
        {
          id: 7,
          date: '2026-01-30',
          homeTeamId: 'team2',
          awayTeamId: 'team1',
          homePoints: 100,
          awayPoints: 115,
          boxScore: { fga: 81, orb: 11, tov: 12, fta: 18 },
        },
        {
          id: 8,
          date: '2026-02-05',
          homeTeamId: 'team1',
          awayTeamId: 'team2',
          homePoints: 118,
          awayPoints: 95,
          boxScore: { fga: 90, orb: 8, tov: 9, fta: 21 },
        },
        {
          id: 9,
          date: '2026-02-10',
          homeTeamId: 'team3',
          awayTeamId: 'team1',
          homePoints: 105,
          awayPoints: 110,
          boxScore: { fga: 83, orb: 12, tov: 12, fta: 18 },
        },
        {
          id: 10,
          date: '2026-02-15',
          homeTeamId: 'team1',
          awayTeamId: 'team2',
          homePoints: 110,
          awayPoints: 105,
          boxScore: { fga: 85, orb: 10, tov: 12, fta: 20 },
        },
      ];

      const result = backtestBasketballMarkets(matches);

      expect(result.valid).toBe(true);
      expect(result.market).toBe('basketball');
      expect(result.sampleSizes).toBeDefined();
      expect(result.predictions).toBeInstanceOf(Array);
      expect(result.metrics).toBeDefined();
    });

    test('returns error for insufficient data', () => {
      const matches = [
        {
          id: 1,
          date: '2026-01-01',
          homeTeamId: 'team1',
          awayTeamId: 'team2',
          homePoints: 110,
          awayPoints: 105,
          boxScore: { fga: 85, orb: 10, tov: 12, fta: 20 },
        },
      ];

      const result = backtestBasketballMarkets(matches);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Insufficient data');
    });

    test('calculates metrics for basketball predictions', () => {
      const matches = [
        {
          id: 1,
          date: '2026-01-01',
          homeTeamId: 'team1',
          awayTeamId: 'team2',
          homePoints: 110,
          awayPoints: 105,
          boxScore: { fga: 85, orb: 10, tov: 12, fta: 20 },
        },
        {
          id: 2,
          date: '2026-01-05',
          homeTeamId: 'team1',
          awayTeamId: 'team3',
          homePoints: 108,
          awayPoints: 102,
          boxScore: { fga: 82, orb: 8, tov: 10, fta: 18 },
        },
        {
          id: 3,
          date: '2026-01-10',
          homeTeamId: 'team2',
          awayTeamId: 'team1',
          homePoints: 105,
          awayPoints: 112,
          boxScore: { fga: 84, orb: 11, tov: 11, fta: 19 },
        },
        {
          id: 4,
          date: '2026-01-15',
          homeTeamId: 'team1',
          awayTeamId: 'team2',
          homePoints: 115,
          awayPoints: 100,
          boxScore: { fga: 88, orb: 9, tov: 10, fta: 20 },
        },
        {
          id: 5,
          date: '2026-01-20',
          homeTeamId: 'team3',
          awayTeamId: 'team1',
          homePoints: 98,
          awayPoints: 118,
          boxScore: { fga: 80, orb: 12, tov: 13, fta: 17 },
        },
        {
          id: 6,
          date: '2026-01-25',
          homeTeamId: 'team1',
          awayTeamId: 'team2',
          homePoints: 112,
          awayPoints: 108,
          boxScore: { fga: 86, orb: 10, tov: 11, fta: 19 },
        },
        {
          id: 7,
          date: '2026-01-30',
          homeTeamId: 'team2',
          awayTeamId: 'team1',
          homePoints: 100,
          awayPoints: 115,
          boxScore: { fga: 81, orb: 11, tov: 12, fta: 18 },
        },
        {
          id: 8,
          date: '2026-02-05',
          homeTeamId: 'team1',
          awayTeamId: 'team2',
          homePoints: 118,
          awayPoints: 95,
          boxScore: { fga: 90, orb: 8, tov: 9, fta: 21 },
        },
        {
          id: 9,
          date: '2026-02-10',
          homeTeamId: 'team3',
          awayTeamId: 'team1',
          homePoints: 105,
          awayPoints: 110,
          boxScore: { fga: 83, orb: 12, tov: 12, fta: 18 },
        },
        {
          id: 10,
          date: '2026-02-15',
          homeTeamId: 'team1',
          awayTeamId: 'team2',
          homePoints: 110,
          awayPoints: 105,
          boxScore: { fga: 85, orb: 10, tov: 12, fta: 20 },
        },
      ];

      const result = backtestBasketballMarkets(matches);

      if (result.valid && result.predictions.length > 0) {
        expect(result.metrics.totalMAE).toBeDefined();
        expect(result.metrics.totalRMSE).toBeDefined();
        expect(result.metrics.brierScore).toBeDefined();
        expect(result.metrics.logLoss).toBeDefined();
        expect(result.metrics.hitRate).toBeDefined();
        expect(result.metrics.calibrationBands).toBeDefined();
      }
    });
  });

  describe('AC-11: Time-Split Integrity Test', () => {
    test('asserts no future-date match in training fold', () => {
      const matches = [
        { id: 1, date: '2026-01-01', homeTeamId: 'team1', awayTeamId: 'team2', homeShots: 12, awayShots: 8 },
        { id: 2, date: '2026-01-05', homeTeamId: 'team1', awayTeamId: 'team3', homeShots: 14, awayShots: 10 },
        { id: 3, date: '2026-01-10', homeTeamId: 'team2', awayTeamId: 'team1', homeShots: 10, awayShots: 13 },
        { id: 4, date: '2026-01-15', homeTeamId: 'team1', awayTeamId: 'team2', homeShots: 11, awayShots: 9 },
        { id: 5, date: '2026-01-20', homeTeamId: 'team3', awayTeamId: 'team1', homeShots: 9, awayShots: 12 },
        { id: 6, date: '2026-01-25', homeTeamId: 'team1', awayTeamId: 'team2', homeShots: 13, awayShots: 11 },
        { id: 7, date: '2026-01-30', homeTeamId: 'team2', awayTeamId: 'team1', homeShots: 8, awayShots: 14 },
        { id: 8, date: '2026-02-05', homeTeamId: 'team1', awayTeamId: 'team2', homeShots: 15, awayShots: 7 },
        { id: 9, date: '2026-02-10', homeTeamId: 'team3', awayTeamId: 'team1', homeShots: 10, awayShots: 11 },
        { id: 10, date: '2026-02-15', homeTeamId: 'team1', awayTeamId: 'team2', homeShots: 12, awayShots: 10 },
      ];

      const split = chronologicalSplit(matches, { trainPct: 0.6, valPct: 0.2 });

      // AC-11: Assert no future-date match is in the training fold
      const noLeakage = validateNoFutureLeakage(split.train, split.test);
      expect(noLeakage).toBe(true);
    });
  });
});
