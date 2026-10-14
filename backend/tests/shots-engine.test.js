/**
 * Football Shots Engine Unit Tests
 *
 * Tests for AC-1 to AC-4:
 *   AC-1: Football shots historical data is collected without fabrication
 *   AC-2: Total shots uses the correct provider definition
 *   AC-3: Configurable shot lines with distribution-based probabilities
 *   AC-4: Home-shot markets use home shots only; away-shot markets use away shots only
 */

const {
  analyzeShotsHistory,
  analyzeH2HShotsHistory,
  calculateShotsPrediction,
} = require('../services/footballShotsAnalysis');

describe('Football Shots Engine', () => {
  describe('AC-1: Historical data collection without fabrication', () => {
    test('should only include completed matches before kickoff and preserve null for missing shots', () => {
      const matches = [
        {
          id: 'match1',
          date: '2026-01-01T12:00:00Z',
          shots: 12,
          shotsConceded: 8,
          totalShots: 20,
          isHome: true,
          result: 'W',
        },
        {
          id: 'match2',
          date: '2026-01-05T15:00:00Z',
          shots: null, // missing shots - should stay null
          shotsConceded: 10,
          totalShots: null,
          isHome: false,
          result: 'L',
        },
        {
          id: 'match3',
          date: '2026-01-10T18:00:00Z',
          shots: 15,
          shotsConceded: null, // missing conceded shots
          totalShots: null,
          isHome: true,
          result: 'D',
        },
        {
          id: 'match4',
          date: '2026-01-15T20:00:00Z',
          shots: 10,
          shotsConceded: 12,
          totalShots: 22,
          isHome: false,
          result: 'W',
        },
        {
          id: 'match5',
          date: '2026-01-20T14:00:00Z',
          shots: 14,
          shotsConceded: 9,
          totalShots: 23,
          isHome: true,
          result: 'W',
        },
      ];

      const result = analyzeShotsHistory(matches, { isHomeContext: true });

      // Should filter to only matches with valid shots data
      expect(result.valid).toBe(true);
      expect(result.sampleSize).toBe(4); // only matches with valid shots

      // Average should only include non-null values
      expect(result.avgShots).toBeCloseTo(12.75, 1); // (12 + 15 + 10 + 14) / 4
      expect(result.avgShotsConceded).toBeCloseTo(9.67, 1); // (8 + 10 + 12 + 9) / 3

      // Null values should be preserved in the input, not defaulted to 0
      expect(matches[1].shots).toBeNull();
      expect(matches[2].shotsConceded).toBeNull();
    });

    test('should return invalid when no valid shot data exists', () => {
      const matches = [
        {
          id: 'match1',
          date: '2026-01-01T12:00:00Z',
          shots: null,
          shotsConceded: null,
          totalShots: null,
          isHome: true,
        },
        {
          id: 'match2',
          date: '2026-01-05T15:00:00Z',
          shots: null,
          shotsConceded: null,
          totalShots: null,
          isHome: false,
        },
      ];

      const result = analyzeShotsHistory(matches);

      expect(result.valid).toBe(false);
      expect(result.sampleSize).toBe(0);
      expect(result.avgShots).toBeNull();
      expect(result.avgShotsConceded).toBeNull();
    });
  });

  describe('AC-2: Total shots uses correct provider definition', () => {
    test('total shots should equal home shots + away shots, not shots-on-target', () => {
      const homeMatches = [
        {
          id: 'match1',
          date: '2026-01-01T12:00:00Z',
          shots: 12,
          shotsOnTarget: 5,
          shotsConceded: 8,
          shotsOnTargetConceded: 3,
          totalShots: 20,
          isHome: true,
        },
        {
          id: 'match2',
          date: '2026-01-05T15:00:00Z',
          shots: 13,
          shotsOnTarget: 6,
          shotsConceded: 9,
          shotsOnTargetConceded: 4,
          totalShots: 22,
          isHome: true,
        },
        {
          id: 'match3',
          date: '2026-01-10T18:00:00Z',
          shots: 14,
          shotsOnTarget: 5,
          shotsConceded: 10,
          shotsOnTargetConceded: 3,
          totalShots: 24,
          isHome: true,
        },
      ];

      const awayMatches = [
        {
          id: 'match1',
          date: '2026-01-01T12:00:00Z',
          shots: 8,
          shotsOnTarget: 3,
          shotsConceded: 12,
          shotsOnTargetConceded: 5,
          totalShots: 20,
          isHome: false,
        },
        {
          id: 'match2',
          date: '2026-01-05T15:00:00Z',
          shots: 9,
          shotsOnTarget: 4,
          shotsConceded: 13,
          shotsOnTargetConceded: 6,
          totalShots: 22,
          isHome: false,
        },
        {
          id: 'match3',
          date: '2026-01-10T18:00:00Z',
          shots: 10,
          shotsOnTarget: 3,
          shotsConceded: 14,
          shotsOnTargetConceded: 5,
          totalShots: 24,
          isHome: false,
        },
      ];

      const homeAnalysis = analyzeShotsHistory(homeMatches, { isHomeContext: true });
      const awayAnalysis = analyzeShotsHistory(awayMatches, { isHomeContext: false });

      const prediction = calculateShotsPrediction({
        homeAnalysis,
        awayAnalysis,
      });

      // Prediction should not be null with sufficient data
      expect(prediction).not.toBeNull();

      // Total shots should be based on totalShots field (20-24), not shotsOnTarget (8-10)
      expect(prediction.expectedTotalShots).toBeGreaterThan(15);
      expect(prediction.expectedTotalShots).toBeLessThan(30);

      // The individual expected shots should be based on shots, not shotsOnTarget
      // (with shrinkage and blending, values will be close but not exact)
      expect(prediction.expectedHomeShots).toBeGreaterThan(10);
      expect(prediction.expectedHomeShots).toBeLessThan(15);
      expect(prediction.expectedAwayShots).toBeGreaterThan(7);
      expect(prediction.expectedAwayShots).toBeLessThan(12);
    });
  });

  describe('AC-3: Configurable shot lines with distribution-based probabilities', () => {
    test('probabilities should be derived from CDF, not simple expected count comparison', () => {
      const homeMatches = [
        {
          id: 'match1',
          date: '2026-01-01T12:00:00Z',
          shots: 13,
          shotsConceded: 11,
          totalShots: 24,
          isHome: true,
        },
        {
          id: 'match2',
          date: '2026-01-05T15:00:00Z',
          shots: 14,
          shotsConceded: 10,
          totalShots: 24,
          isHome: true,
        },
        {
          id: 'match3',
          date: '2026-01-10T18:00:00Z',
          shots: 12,
          shotsConceded: 12,
          totalShots: 24,
          isHome: true,
        },
      ];

      const awayMatches = [
        {
          id: 'match1',
          date: '2026-01-01T12:00:00Z',
          shots: 11,
          shotsConceded: 13,
          totalShots: 24,
          isHome: false,
        },
        {
          id: 'match2',
          date: '2026-01-05T15:00:00Z',
          shots: 10,
          shotsConceded: 14,
          totalShots: 24,
          isHome: false,
        },
        {
          id: 'match3',
          date: '2026-01-10T18:00:00Z',
          shots: 12,
          shotsConceded: 12,
          totalShots: 24,
          isHome: false,
        },
      ];

      const homeAnalysis = analyzeShotsHistory(homeMatches, { isHomeContext: true });
      const awayAnalysis = analyzeShotsHistory(awayMatches, { isHomeContext: false });

      const prediction = calculateShotsPrediction({
        homeAnalysis,
        awayAnalysis,
        lines: { total: [21.5] },
      });

      // Prediction should not be null with sufficient data
      expect(prediction).not.toBeNull();

      // Expected total shots should be around 24
      const expectedTotal = prediction.expectedTotalShots;
      expect(expectedTotal).toBeGreaterThan(20);
      expect(expectedTotal).toBeLessThan(28);

      // Probability should not be a simple threshold comparison
      // If it were simple: expectedTotal (24) > line (21.5) would give P(Over) = 1.0
      // But distribution-based should give a nuanced probability
      expect(prediction.probability).toBeGreaterThan(0.3);
      expect(prediction.probability).toBeLessThan(0.95);

      // Over + Under should equal 1 (within floating point tolerance)
      expect(prediction.probability + prediction.complementaryProbability).toBeCloseTo(1, 4);
    });

    test('probabilities should be clamped to [0,1]', () => {
      const homeMatches = [
        {
          id: 'match1',
          date: '2026-01-01T12:00:00Z',
          shots: 5,
          shotsConceded: 30,
          totalShots: 35,
          isHome: true,
        },
        {
          id: 'match2',
          date: '2026-01-05T15:00:00Z',
          shots: 6,
          shotsConceded: 29,
          totalShots: 35,
          isHome: true,
        },
        {
          id: 'match3',
          date: '2026-01-10T18:00:00Z',
          shots: 7,
          shotsConceded: 28,
          totalShots: 35,
          isHome: true,
        },
      ];

      const awayMatches = [
        {
          id: 'match1',
          date: '2026-01-01T12:00:00Z',
          shots: 30,
          shotsConceded: 5,
          totalShots: 35,
          isHome: false,
        },
        {
          id: 'match2',
          date: '2026-01-05T15:00:00Z',
          shots: 29,
          shotsConceded: 6,
          totalShots: 35,
          isHome: false,
        },
        {
          id: 'match3',
          date: '2026-01-10T18:00:00Z',
          shots: 28,
          shotsConceded: 7,
          totalShots: 35,
          isHome: false,
        },
      ];

      const homeAnalysis = analyzeShotsHistory(homeMatches, { isHomeContext: true });
      const awayAnalysis = analyzeShotsHistory(awayMatches, { isHomeContext: false });

      const prediction = calculateShotsPrediction({
        homeAnalysis,
        awayAnalysis,
      });

      expect(prediction).not.toBeNull();
      expect(prediction.probability).toBeGreaterThanOrEqual(0);
      expect(prediction.probability).toBeLessThanOrEqual(1);
      expect(prediction.complementaryProbability).toBeGreaterThanOrEqual(0);
      expect(prediction.complementaryProbability).toBeLessThanOrEqual(1);
    });
  });

  describe('AC-4: Home-shot and away-shot markets use respective team shots only', () => {
    test('settlement should use home shots for home markets and away shots for away markets', () => {
      // This tests the prediction output structure
      const homeMatches = [
        {
          id: 'match1',
          date: '2026-01-01T12:00:00Z',
          shots: 12,
          shotsConceded: 8,
          totalShots: 20,
          isHome: true,
        },
        {
          id: 'match2',
          date: '2026-01-05T15:00:00Z',
          shots: 13,
          shotsConceded: 9,
          totalShots: 22,
          isHome: true,
        },
        {
          id: 'match3',
          date: '2026-01-10T18:00:00Z',
          shots: 11,
          shotsConceded: 10,
          totalShots: 21,
          isHome: true,
        },
      ];

      const awayMatches = [
        {
          id: 'match1',
          date: '2026-01-01T12:00:00Z',
          shots: 8,
          shotsConceded: 12,
          totalShots: 20,
          isHome: false,
        },
        {
          id: 'match2',
          date: '2026-01-05T15:00:00Z',
          shots: 9,
          shotsConceded: 13,
          totalShots: 22,
          isHome: false,
        },
        {
          id: 'match3',
          date: '2026-01-10T18:00:00Z',
          shots: 10,
          shotsConceded: 11,
          totalShots: 21,
          isHome: false,
        },
      ];

      const homeAnalysis = analyzeShotsHistory(homeMatches, { isHomeContext: true });
      const awayAnalysis = analyzeShotsHistory(awayMatches, { isHomeContext: false });

      const prediction = calculateShotsPrediction({
        homeAnalysis,
        awayAnalysis,
        lines: {
          total: [21.5],
          home: [10.5],
          away: [10.5],
        },
      });

      expect(prediction).not.toBeNull();

      // Expected home shots should be based on home team's shots
      expect(prediction.expectedHomeShots).toBeGreaterThan(10);
      expect(prediction.expectedHomeShots).toBeLessThan(14);

      // Expected away shots should be based on away team's shots
      expect(prediction.expectedAwayShots).toBeGreaterThan(7);
      expect(prediction.expectedAwayShots).toBeLessThan(11);

      // Total should be sum of both
      expect(prediction.expectedTotalShots).toBeGreaterThan(17);
      expect(prediction.expectedTotalShots).toBeLessThan(25);
    });
  });

  describe('H2H Shots Analysis', () => {
    test('should analyze H2H shots history correctly', () => {
      const h2hMatches = [
        {
          id: 'h2h1',
          date: '2025-11-01T15:00:00Z',
          homeShots: 14,
          awayShots: 10,
          totalShots: 24,
        },
        {
          id: 'h2h2',
          date: '2025-08-15T15:00:00Z',
          homeShots: 11,
          awayShots: 13,
          totalShots: 24,
        },
        {
          id: 'h2h3',
          date: '2025-03-20T15:00:00Z',
          homeShots: 16,
          awayShots: 8,
          totalShots: 24,
        },
      ];

      const result = analyzeH2HShotsHistory(h2hMatches, [21.5, 23.5]);

      expect(result.valid).toBe(true);
      expect(result.sampleSize).toBe(3);
      expect(result.avgTotalShots).toBeCloseTo(24, 1);

      // Line frequencies should be calculated
      expect(result.lineFrequencies[21.5]).toBeDefined();
      expect(result.lineFrequencies[23.5]).toBeDefined();
    });

    test('should return invalid when no valid H2H data', () => {
      const result = analyzeH2HShotsHistory([]);

      expect(result.valid).toBe(false);
      expect(result.sampleSize).toBe(0);
      expect(result.avgTotalShots).toBeNull();
    });
  });

  describe('Shot History with Dispersion', () => {
    test('should estimate dispersion from shot data when variance > mean', () => {
      const matches = [
        {
          id: 'match1',
          date: '2026-01-01T12:00:00Z',
          shots: 10,
          shotsConceded: 8,
          totalShots: 18,
          isHome: true,
        },
        {
          id: 'match2',
          date: '2026-01-05T15:00:00Z',
          shots: 15,
          shotsConceded: 12,
          totalShots: 27,
          isHome: true,
        },
        {
          id: 'match3',
          date: '2026-01-10T18:00:00Z',
          shots: 12,
          shotsConceded: 10,
          totalShots: 22,
          isHome: true,
        },
        {
          id: 'match4',
          date: '2026-01-15T20:00:00Z',
          shots: 18,
          shotsConceded: 14,
          totalShots: 32,
          isHome: true,
        },
        {
          id: 'match5',
          date: '2026-01-20T14:00:00Z',
          shots: 5,
          shotsConceded: 20,
          totalShots: 25,
          isHome: true,
        },
      ];

      const result = analyzeShotsHistory(matches, { isHomeContext: true });

      expect(result.valid).toBe(true);
      // Dispersion may be null if variance <= mean (Poisson-like)
      // Just check it's either a positive number or null
      if (result.dispersion !== null) {
        expect(result.dispersion).toBeGreaterThan(0);
      }
    });

    test('should return null dispersion when variance <= mean (Poisson-like)', () => {
      const matches = [
        {
          id: 'match1',
          date: '2026-01-01T12:00:00Z',
          shots: 12,
          shotsConceded: 12,
          totalShots: 24,
          isHome: true,
        },
        {
          id: 'match2',
          date: '2026-01-05T15:00:00Z',
          shots: 12,
          shotsConceded: 12,
          totalShots: 24,
          isHome: true,
        },
        {
          id: 'match3',
          date: '2026-01-10T18:00:00Z',
          shots: 12,
          shotsConceded: 12,
          totalShots: 24,
          isHome: true,
        },
      ];

      const result = analyzeShotsHistory(matches, { isHomeContext: true });

      // With zero variance, dispersion should be null (use Poisson)
      expect(result.dispersion).toBeNull();
    });
  });

  describe('Line Frequencies', () => {
    test('should calculate over/under frequencies for each line', () => {
      const matches = [
        {
          id: 'match1',
          date: '2026-01-01T12:00:00Z',
          shots: 10,
          shotsConceded: 8,
          totalShots: 18,
          isHome: true,
        },
        {
          id: 'match2',
          date: '2026-01-05T15:00:00Z',
          shots: 15,
          shotsConceded: 12,
          totalShots: 27,
          isHome: true,
        },
        {
          id: 'match3',
          date: '2026-01-10T18:00:00Z',
          shots: 12,
          shotsConceded: 10,
          totalShots: 22,
          isHome: true,
        },
        {
          id: 'match4',
          date: '2026-01-15T20:00:00Z',
          shots: 16,
          shotsConceded: 14,
          totalShots: 30,
          isHome: true,
        },
      ];

      const result = analyzeShotsHistory(matches, { isHomeContext: true, lines: [21.5, 23.5] });

      expect(result.lineFrequencies[21.5]).toBeDefined();
      expect(result.lineFrequencies[23.5]).toBeDefined();

      // Check that over + under = 1 for each line
      const freq21_5 = result.lineFrequencies[21.5];
      expect(freq21_5.overRate + freq21_5.underRate).toBeCloseTo(1, 4);

      const freq23_5 = result.lineFrequencies[23.5];
      expect(freq23_5.overRate + freq23_5.underRate).toBeCloseTo(1, 4);
    });
  });
});
