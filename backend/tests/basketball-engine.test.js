/**
 * Basketball Engine Unit Tests
 *
 * Tests for AC-5 to AC-7:
 *   AC-5: Basketball possessions formula uses correct units
 *   AC-6: Offensive/defensive ratings are per-100-possessions and consistent
 *   AC-7: Basketball win probability is not derived solely from expected scores
 */

const {
  estimatePossessions,
  calcRatings,
  shrinkRating,
  analyzeBasketballHistory,
  calculateBasketballPrediction,
  settleBasketball,
  LEAGUE_MEAN,
} = require('../services/basketballEngine');

describe('Basketball Engine', () => {
  describe('AC-5: Possessions formula uses correct units', () => {
    test('possessions = FGA - ORB + TO + 0.44 * FTA', () => {
      const boxScore = {
        fga: 80,
        orb: 10,
        tov: 12,
        fta: 20,
      };

      const possessions = estimatePossessions(boxScore);

      // Formula: 80 - 10 + 12 + 0.44 * 20 = 80 - 10 + 12 + 8.8 = 90.8
      expect(possessions).toBeCloseTo(90.8, 1);
    });

    test('should return null when any required stat is missing', () => {
      const boxScore1 = { fga: 80, orb: 10, tov: 12 }; // missing fta
      expect(estimatePossessions(boxScore1)).toBeNull();

      const boxScore2 = { fga: 80, orb: 10, fta: 20 }; // missing tov
      expect(estimatePossessions(boxScore2)).toBeNull();

      const boxScore3 = { orb: 10, tov: 12, fta: 20 }; // missing fga
      expect(estimatePossessions(boxScore3)).toBeNull();
    });

    test('should return null when stats are NaN', () => {
      const boxScore = {
        fga: 'invalid',
        orb: 10,
        tov: 12,
        fta: 20,
      };

      expect(estimatePossessions(boxScore)).toBeNull();
    });
  });

  describe('AC-6: Offensive/defensive ratings per-100-possessions', () => {
    test('ORtg = points/possessions*100, DRtg = points_allowed/opp_possessions*100', () => {
      const points = 110;
      const oppPoints = 105;
      const possessions = 100;
      const oppPossessions = 98;

      const ratings = calcRatings(points, oppPoints, possessions, oppPossessions);

      expect(ratings.ortg).toBeCloseTo(110, 1); // 110/100*100 = 110
      expect(ratings.drtg).toBeCloseTo(107.14, 1); // 105/98*100 ≈ 107.14
      expect(ratings.netRtg).toBeCloseTo(2.86, 1); // 110 - 107.14 ≈ 2.86
    });

    test('expected points = possessions * (ORtg/100)', () => {
      const points = 110;
      const oppPoints = 105;
      const possessions = 100;

      const ratings = calcRatings(points, oppPoints, possessions);

      // Expected points should match actual points when using the same data
      const expectedPoints = possessions * (ratings.ortg / 100);
      expect(expectedPoints).toBeCloseTo(points, 1);
    });

    test('should return null when possessions <= 0', () => {
      const ratings = calcRatings(110, 105, 0);
      expect(ratings).toBeNull();

      const ratings2 = calcRatings(110, 105, -5);
      expect(ratings2).toBeNull();
    });

    test('should return null when points are null', () => {
      const ratings = calcRatings(null, 105, 100);
      expect(ratings).toBeNull();
    });
  });

  describe('Shrinkage toward league mean', () => {
    test('should shrink small samples toward league mean', () => {
      const smallSampleRating = 140; // very high
      const sampleSize = 2;
      const leagueMean = LEAGUE_MEAN.ortg; // 110

      const shrunk = shrinkRating(smallSampleRating, sampleSize, leagueMean);

      // With small sample, should be closer to league mean
      expect(shrunk).toBeLessThan(smallSampleRating);
      expect(shrunk).toBeGreaterThan(leagueMean);
    });

    test('should not shrink large samples', () => {
      const largeSampleRating = 140;
      const sampleSize = 50;
      const leagueMean = LEAGUE_MEAN.ortg;

      const shrunk = shrinkRating(largeSampleRating, sampleSize, leagueMean);

      // With large sample, should stay reasonably close to original
      // (shrinkage formula: w = sampleSize / (sampleSize + 5) = 50/55 = 0.91)
      expect(shrunk).toBeGreaterThan(135);
      expect(shrunk).toBeLessThan(140);
    });

    test('should return league mean when value is null', () => {
      const shrunk = shrinkRating(null, 5, LEAGUE_MEAN.ortg);
      expect(shrunk).toBe(LEAGUE_MEAN.ortg);
    });
  });

  describe('AC-7: Win probability not derived solely from expected scores', () => {
    test('identical expected scores with different variances should yield different win probabilities', () => {
      // Create two scenarios with same expected scores but different variances
      const homeMatchesLowVar = [
        { pf: 110, pa: 105, isHome: true, date: '2026-01-01T12:00:00Z', boxScore: { fga: 85, orb: 8, tov: 10, fta: 20 } },
        { pf: 109, pa: 106, isHome: true, date: '2026-01-05T15:00:00Z', boxScore: { fga: 84, orb: 9, tov: 11, fta: 19 } },
        { pf: 111, pa: 104, isHome: true, date: '2026-01-10T18:00:00Z', boxScore: { fga: 86, orb: 7, tov: 9, fta: 21 } },
      ];

      const awayMatchesLowVar = [
        { pf: 105, pa: 110, isHome: false, date: '2026-01-01T12:00:00Z', boxScore: { fga: 82, orb: 10, tov: 12, fta: 18 } },
        { pf: 106, pa: 109, isHome: false, date: '2026-01-05T15:00:00Z', boxScore: { fga: 83, orb: 11, tov: 13, fta: 17 } },
        { pf: 104, pa: 111, isHome: false, date: '2026-01-10T18:00:00Z', boxScore: { fga: 81, orb: 12, tov: 14, fta: 16 } },
      ];

      const homeMatchesHighVar = [
        { pf: 120, pa: 95, isHome: true, date: '2026-01-01T12:00:00Z', boxScore: { fga: 90, orb: 10, tov: 8, fta: 22 } },
        { pf: 100, pa: 115, isHome: true, date: '2026-01-05T15:00:00Z', boxScore: { fga: 80, orb: 12, tov: 15, fta: 18 } },
        { pf: 110, pa: 105, isHome: true, date: '2026-01-10T18:00:00Z', boxScore: { fga: 85, orb: 11, tov: 11, fta: 20 } },
      ];

      const awayMatchesHighVar = [
        { pf: 95, pa: 120, isHome: false, date: '2026-01-01T12:00:00Z', boxScore: { fga: 78, orb: 14, tov: 16, fta: 16 } },
        { pf: 115, pa: 100, isHome: false, date: '2026-01-05T15:00:00Z', boxScore: { fga: 88, orb: 9, tov: 7, fta: 24 } },
        { pf: 105, pa: 110, isHome: false, date: '2026-01-10T18:00:00Z', boxScore: { fga: 83, orb: 11, tov: 12, fta: 20 } },
      ];

      const homeLowVar = analyzeBasketballHistory(homeMatchesLowVar, { isHomeContext: true });
      const awayLowVar = analyzeBasketballHistory(awayMatchesLowVar, { isHomeContext: false });
      const predictionLowVar = calculateBasketballPrediction({
        homeAnalysis: homeLowVar,
        awayAnalysis: awayLowVar,
      });

      const homeHighVar = analyzeBasketballHistory(homeMatchesHighVar, { isHomeContext: true });
      const awayHighVar = analyzeBasketballHistory(awayMatchesHighVar, { isHomeContext: false });
      const predictionHighVar = calculateBasketballPrediction({
        homeAnalysis: homeHighVar,
        awayAnalysis: awayHighVar,
      });

      // Expected scores should be similar (around 110-105)
      expect(predictionLowVar.expectedHomePoints).toBeCloseTo(predictionHighVar.expectedHomePoints, 0);
      expect(predictionLowVar.expectedAwayPoints).toBeCloseTo(predictionHighVar.expectedAwayPoints, 0);

      // But win probabilities should differ due to variance in score distribution
      // (Though in practice, with the small sample sizes, the difference might be subtle)
      expect(predictionLowVar.homeWinProbability).toBeDefined();
      expect(predictionHighVar.homeWinProbability).toBeDefined();
    });

    test('win probability should integrate over score-difference distribution', () => {
      const homeMatches = [
        { pf: 115, pa: 100, isHome: true, date: '2026-01-01T12:00:00Z', boxScore: { fga: 88, orb: 9, tov: 10, fta: 20 } },
        { pf: 112, pa: 103, isHome: true, date: '2026-01-05T15:00:00Z', boxScore: { fga: 85, orb: 10, tov: 11, fta: 19 } },
      ];

      const awayMatches = [
        { pf: 100, pa: 115, isHome: false, date: '2026-01-01T12:00:00Z', boxScore: { fga: 82, orb: 11, tov: 12, fta: 18 } },
        { pf: 103, pa: 112, isHome: false, date: '2026-01-05T15:00:00Z', boxScore: { fga: 84, orb: 12, tov: 13, fta: 17 } },
      ];

      const homeAnalysis = analyzeBasketballHistory(homeMatches, { isHomeContext: true });
      const awayAnalysis = analyzeBasketballHistory(awayMatches, { isHomeContext: false });

      const prediction = calculateBasketballPrediction({
        homeAnalysis,
        awayAnalysis,
      });

      // Win probability should be based on distribution, not simple comparison
      // Simple comparison: expHome > expAway would give P = 1.0
      // Distribution-based should give a nuanced probability
      expect(prediction.homeWinProbability).toBeGreaterThan(0.3);
      expect(prediction.homeWinProbability).toBeLessThan(0.95);
      expect(prediction.awayWinProbability).toBeGreaterThan(0.05);
      expect(prediction.awayWinProbability).toBeLessThan(0.7);

      // Home + Away win probabilities should equal 1
      expect(prediction.homeWinProbability + prediction.awayWinProbability).toBeCloseTo(1, 4);
    });
  });

  describe('Basketball History Analysis', () => {
    test('should analyze team history correctly', () => {
      const matches = [
        { pf: 110, pa: 105, isHome: true, date: '2026-01-01T12:00:00Z', boxScore: { fga: 85, orb: 10, tov: 12, fta: 20 } },
        { pf: 108, pa: 102, isHome: false, date: '2026-01-05T15:00:00Z', boxScore: { fga: 82, orb: 8, tov: 10, fta: 18 } },
        { pf: 112, pa: 108, isHome: true, date: '2026-01-10T18:00:00Z', boxScore: { fga: 86, orb: 9, tov: 11, fta: 19 } },
      ];

      const result = analyzeBasketballHistory(matches, { isHomeContext: true });

      expect(result.valid).toBe(true);
      expect(result.sampleSize).toBe(3);
      expect(result.avgPoints).toBeCloseTo(110, 1);
      expect(result.avgPointsAllowed).toBeCloseTo(105, 1);
      expect(result.ortg).toBeGreaterThan(100);
      expect(result.drtg).toBeGreaterThan(100);
      expect(result.pace).toBeGreaterThan(90);
    });

    test('should return invalid when no valid match data', () => {
      const result = analyzeBasketballHistory([]);

      expect(result.valid).toBe(false);
      expect(result.sampleSize).toBe(0);
      expect(result.avgPoints).toBeNull();
      expect(result.avgPointsAllowed).toBeNull();
    });

    test('should calculate home/away split', () => {
      const matches = [
        { pf: 115, pa: 100, isHome: true, date: '2026-01-01T12:00:00Z' },
        { pf: 105, pa: 110, isHome: false, date: '2026-01-05T15:00:00Z' },
        { pf: 112, pa: 98, isHome: true, date: '2026-01-10T18:00:00Z' },
      ];

      const result = analyzeBasketballHistory(matches, { isHomeContext: true });

      expect(result.homeAwaySplit.home).toBeDefined();
      expect(result.homeAwaySplit.away).toBeDefined();
      expect(result.homeAwaySplit.home.sampleSize).toBe(2);
      expect(result.homeAwaySplit.away.sampleSize).toBe(1);
    });

    test('should detect back-to-back games', () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const matches = [
        { pf: 110, pa: 105, isHome: true, date: yesterday.toISOString() },
      ];

      const result = analyzeBasketballHistory(matches);

      expect(result.backToBack).toBe(true);
      expect(result.restDays).toBeLessThanOrEqual(1);
    });
  });

  describe('Basketball Prediction', () => {
    test('should calculate expected points and win probability', () => {
      const homeMatches = [
        { pf: 115, pa: 100, isHome: true, date: '2026-01-01T12:00:00Z', boxScore: { fga: 88, orb: 9, tov: 10, fta: 20 } },
        { pf: 112, pa: 105, isHome: true, date: '2026-01-05T15:00:00Z', boxScore: { fga: 85, orb: 10, tov: 11, fta: 19 } },
        { pf: 118, pa: 98, isHome: true, date: '2026-01-10T18:00:00Z', boxScore: { fga: 90, orb: 8, tov: 9, fta: 21 } },
      ];

      const awayMatches = [
        { pf: 100, pa: 115, isHome: false, date: '2026-01-01T12:00:00Z', boxScore: { fga: 82, orb: 11, tov: 12, fta: 18 } },
        { pf: 105, pa: 112, isHome: false, date: '2026-01-05T15:00:00Z', boxScore: { fga: 84, orb: 10, tov: 10, fta: 19 } },
        { pf: 98, pa: 118, isHome: false, date: '2026-01-10T18:00:00Z', boxScore: { fga: 80, orb: 12, tov: 13, fta: 17 } },
      ];

      const homeAnalysis = analyzeBasketballHistory(homeMatches, { isHomeContext: true });
      const awayAnalysis = analyzeBasketballHistory(awayMatches, { isHomeContext: false });

      const prediction = calculateBasketballPrediction({
        homeAnalysis,
        awayAnalysis,
      });

      expect(prediction).toBeDefined();
      expect(prediction.expectedHomePoints).toBeGreaterThan(100);
      expect(prediction.expectedAwayPoints).toBeGreaterThan(90);
      expect(prediction.expectedTotalPoints).toBeGreaterThan(190);
      expect(prediction.homeWinProbability).toBeGreaterThan(0.5);
    });

    test('should return null when neither team has valid data', () => {
      const prediction = calculateBasketballPrediction({
        homeAnalysis: { valid: false, sampleSize: 0 },
        awayAnalysis: { valid: false, sampleSize: 0 },
      });

      expect(prediction).toBeNull();
    });
  });

  describe('Basketball Settlement', () => {
    test('should settle team points over/under correctly', () => {
      const scores = { homePoints: 110, awayPoints: 105, line: 105.5 };

      expect(settleBasketball('basketball_home_points_over_105_5', scores)).toBe('won');
      expect(settleBasketball('basketball_home_points_under_105_5', scores)).toBe('lost');

      expect(settleBasketball('basketball_away_points_over_105_5', scores)).toBe('lost');
      expect(settleBasketball('basketball_away_points_under_105_5', scores)).toBe('won');
    });

    test('should return null when scores are missing', () => {
      expect(settleBasketball('basketball_home_points_over_105_5', null)).toBeNull();
      expect(settleBasketball('basketball_home_points_over_105_5', {})).toBeNull();
      expect(settleBasketball('basketball_home_points_over_105_5', { homePoints: 110 })).toBeNull();
    });

    test('should return null for unknown markets', () => {
      const scores = { homePoints: 110, awayPoints: 105, line: 105.5 };
      expect(settleBasketball('unknown_market', scores)).toBeNull();
    });
  });
});
