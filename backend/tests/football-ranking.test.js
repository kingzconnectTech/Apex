/**
 * Football Prediction Ranking Tests
 *
 * Tests the shared rankFootballPredictions utility used by server.js.
 * Covers all edge cases from the specification:
 *   - All four valid predictions
 *   - Changing confidence rankings
 *   - Per-fixture independence
 *   - Invalid/missing/non-finite/out-of-range confidence values
 *   - Confidence normalization (probability vs percentage)
 *   - Tied confidence values + deterministic tie-breaking
 *   - Duplicate market predictions
 *   - 0, 1, 2, 3, and 4 valid predictions
 *   - Only approved markets in output
 */

jest.mock('uuid', () => ({
  v4: () => 'test-uuid-' + Math.random().toString(36).slice(2, 10),
}));

jest.mock('firebase-admin', () => {
  const firestoreMock = {
    collection: jest.fn(() => firestoreMock),
    doc: jest.fn(() => firestoreMock),
    where: jest.fn(() => firestoreMock),
    get: jest.fn(async () => ({ empty: true, size: 0, docs: [] })),
  };
  return {
    apps: ['dummy'],
    initializeApp: jest.fn(),
    credential: { cert: jest.fn() },
    firestore: jest.fn(() => firestoreMock),
  };
});

const { rankFootballPredictions, FOOTBALL_MARKET_PRIORITY } = require('../services/footballRanking');

// Convenience factory for a prediction object
const pred = (market, confidence, extra = {}) => ({
  market,
  label: market,
  value: market,
  confidence,
  color: '#40c057',
  ...extra,
});

describe('Football Prediction Ranking Logic', () => {
  // 1. All four valid predictions -> top 2 selected
  test('correct ranking when all four predictions are valid', () => {
    const predictions = [
      pred('under_corners',   76),
      pred('under_4_5_goals', 91),
      pred('under_1_5_ht',   69),
      pred('under_2_5_ht',   84),
    ];
    const ranked = rankFootballPredictions(predictions);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].market).toBe('under_4_5_goals');
    expect(ranked[0].confidence).toBe(91);
    expect(ranked[1].market).toBe('under_2_5_ht');
    expect(ranked[1].confidence).toBe(84);
  });

  // 2. Confidence rankings change -> selection changes accordingly
  test('correct selection when confidence rankings change', () => {
    const predictions = [
      pred('under_corners',   85),
      pred('under_4_5_goals', 70),
      pred('under_1_5_ht',   60),
      pred('under_2_5_ht',   75),
    ];
    const ranked = rankFootballPredictions(predictions);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].market).toBe('under_corners');
    expect(ranked[0].confidence).toBe(85);
    expect(ranked[1].market).toBe('under_2_5_ht');
    expect(ranked[1].confidence).toBe(75);
  });

  // 3. Per-fixture independence
  test('correct selection independently for multiple fixtures', () => {
    const fixture1 = [pred('under_corners', 80), pred('under_4_5_goals', 60)];
    const fixture2 = [pred('under_corners', 55), pred('under_4_5_goals', 90)];
    const ranked1 = rankFootballPredictions(fixture1);
    const ranked2 = rankFootballPredictions(fixture2);
    expect(ranked1[0].market).toBe('under_corners');
    expect(ranked2[0].market).toBe('under_4_5_goals');
  });

  // 4. Invalid, missing, non-finite, out-of-range values excluded
  test('handles invalid, missing, non-finite, and out-of-range confidence values', () => {
    const predictions = [
      pred('under_corners',   76),
      pred('under_4_5_goals', NaN),
      pred('under_1_5_ht',   Infinity),
      pred('under_2_5_ht',   -10),
      pred('under_4_5_goals', 150),
    ];
    const ranked = rankFootballPredictions(predictions);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].market).toBe('under_corners');
    expect(ranked[0].confidence).toBe(76);
  });

  test('excludes predictions with missing confidence field', () => {
    const predictions = [
      { market: 'under_corners', label: 'x', value: 'x', color: '#fff' },
      pred('under_4_5_goals', 80),
    ];
    const ranked = rankFootballPredictions(predictions);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].market).toBe('under_4_5_goals');
  });

  test('excludes predictions with string confidence', () => {
    const predictions = [
      { market: 'under_corners', confidence: '76', label: 'x', value: 'x', color: '#fff' },
      pred('under_4_5_goals', 80),
    ];
    const ranked = rankFootballPredictions(predictions);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].market).toBe('under_4_5_goals');
  });

  // 5. Confidence normalization (probability 0-1 treated as valid)
  test('confidence normalization (probability vs percentage)', () => {
    const predictions = [
      pred('under_corners',   0.76),
      pred('under_4_5_goals', 0.91),
    ];
    const ranked = rankFootballPredictions(predictions);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].market).toBe('under_4_5_goals');
    expect(ranked[0].confidence).toBe(0.91);
    expect(ranked[1].market).toBe('under_corners');
    expect(ranked[1].confidence).toBe(0.76);
  });

  // 6. Tied confidence values -> deterministic tie-break
  test('handles tied confidence values with deterministic tie-breaking', () => {
    const predictions = [
      pred('under_corners',   80),
      pred('under_4_5_goals', 80),
      pred('under_1_5_ht',   80),
      pred('under_2_5_ht',   80),
    ];
    const ranked = rankFootballPredictions(predictions);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].market).toBe('under_4_5_goals');
    expect(ranked[1].market).toBe('under_2_5_ht');
  });

  test('tie-break priority order matches FOOTBALL_MARKET_PRIORITY export', () => {
    expect(FOOTBALL_MARKET_PRIORITY).toEqual([
      'under_4_5_goals',
      'under_2_5_ht',
      'home_team_under_2_5',
      'away_team_under_2_5',
      'under_corners',
      'under_1_5_ht',
    ]);
  });

  // 7. Duplicate markets -> deduplicated (keep highest confidence)
  test('deduplicates duplicate market predictions', () => {
    const predictions = [
      pred('under_corners',   70),
      pred('under_corners',   85),
      pred('under_4_5_goals', 90),
      pred('under_2_5_ht',   75),
    ];
    const ranked = rankFootballPredictions(predictions);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].market).toBe('under_4_5_goals');
    expect(ranked[0].confidence).toBe(90);
    expect(ranked[1].market).toBe('under_corners');
    expect(ranked[1].confidence).toBe(85);
  });

  // 8. Edge counts: 0, 1, 2, 3, 4 valid predictions
  test('handles zero valid predictions', () => {
    const predictions = [
      pred('under_corners',   NaN),
      pred('under_4_5_goals', -5),
      pred('under_1_5_ht',   Infinity),
    ];
    expect(rankFootballPredictions(predictions)).toHaveLength(0);
  });

  test('handles one valid prediction', () => {
    const predictions = [
      pred('under_corners',   76),
      pred('under_4_5_goals', NaN),
    ];
    const ranked = rankFootballPredictions(predictions);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].market).toBe('under_corners');
  });

  test('handles two valid predictions', () => {
    const predictions = [pred('under_corners', 76), pred('under_4_5_goals', 85)];
    const ranked = rankFootballPredictions(predictions);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].market).toBe('under_4_5_goals');
    expect(ranked[1].market).toBe('under_corners');
  });

  test('handles three valid predictions (selects top 2)', () => {
    const predictions = [
      pred('under_corners',   76),
      pred('under_4_5_goals', 91),
      pred('under_2_5_ht',   84),
    ];
    const ranked = rankFootballPredictions(predictions);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].market).toBe('under_4_5_goals');
    expect(ranked[1].market).toBe('under_2_5_ht');
  });

  test('handles four valid predictions (selects top 2)', () => {
    const predictions = [
      pred('under_corners',   76),
      pred('under_4_5_goals', 91),
      pred('under_1_5_ht',   69),
      pred('under_2_5_ht',   84),
    ];
    const ranked = rankFootballPredictions(predictions);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].market).toBe('under_4_5_goals');
    expect(ranked[1].market).toBe('under_2_5_ht');
  });

  // 9 & 10. Only approved markets in output
  test('only approved football markets appear in the output', () => {
    const approvedMarkets = new Set([
      'under_corners',
      'under_4_5_goals',
      'under_1_5_ht',
      'under_2_5_ht',
      'home_team_under_2_5',
      'away_team_under_2_5',
    ]);
    const predictions = [
      pred('under_corners',       76),
      pred('under_4_5_goals',     91),
      pred('home_team_under_2_5', 88),
      pred('away_team_under_2_5', 85),
      pred('under_1_5_ht',       69),
      pred('under_2_5_ht',       84),
    ];
    const ranked = rankFootballPredictions(predictions);
    ranked.forEach(r => expect(approvedMarkets.has(r.market)).toBe(true));
  });

  test('output has at most 2 entries with required fields', () => {
    const predictions = [
      pred('under_4_5_goals', 90),
      pred('under_2_5_ht',   80),
    ];
    const ranked = rankFootballPredictions(predictions);
    expect(ranked.length).toBeLessThanOrEqual(2);
    ranked.forEach(r => {
      expect(r).toHaveProperty('market');
      expect(r).toHaveProperty('confidence');
      expect(r).toHaveProperty('label');
      expect(r).toHaveProperty('value');
    });
  });

  // 11. Empty / null / undefined input
  test('returns empty array for null/undefined/empty input', () => {
    expect(rankFootballPredictions(null)).toEqual([]);
    expect(rankFootballPredictions(undefined)).toEqual([]);
    expect(rankFootballPredictions([])).toEqual([]);
  });
});

describe('Sport-Specific Prediction Engine (analyzeMatchServer)', () => {
  const { analyzeMatchServer } = require('../server');

  test('football produces at most 2 recommendations from approved markets in descending confidence', () => {
    const result = analyzeMatchServer({
      homeName: 'Arsenal',
      awayName: 'Chelsea',
      homeStats: {
        record: '20-5-5',
        lastMatches: [
          { pf: 2, pa: 0, result: 'W' },
          { pf: 1, pa: 0, result: 'W' },
          { pf: 2, pa: 1, result: 'W' },
        ],
      },
      awayStats: {
        record: '18-6-6',
        lastMatches: [
          { pf: 1, pa: 0, result: 'W' },
          { pf: 0, pa: 0, result: 'D' },
          { pf: 1, pa: 1, result: 'D' },
        ],
      },
      h2h: {
        deepStats: [
          { homeStats: { corners: 4 }, awayStats: { corners: 5 } },
          { homeStats: { corners: 5 }, awayStats: { corners: 4 } },
        ],
      },
      sport: 'soccer',
      isDetailed: true,
    });

    expect(result.recommendations.length).toBeLessThanOrEqual(2);
    const approvedMarkets = [
      'UNDER_CORNERS',
      'UNDER_4_5_GOALS',
      'UNDER_1_5_HT',
      'UNDER_2_5_HT',
      'HOME_TEAM_UNDER_2_5',
      'AWAY_TEAM_UNDER_2_5',
    ];
    result.recommendations.forEach(rec => {
      expect(approvedMarkets).toContain(rec.type);
    });
    if (result.recommendations.length === 2) {
      expect(result.recommendations[0].confidence).toBeGreaterThanOrEqual(result.recommendations[1].confidence);
    }
  });

  test('basketball predictions remain unchanged (WIN + GOALS)', () => {
    const result = analyzeMatchServer({
      homeName: 'Lakers',
      awayName: 'Celtics',
      homeStats: {
        record: '40-20',
        lastMatches: [{ pf: 110, pa: 105, isHome: true, date: '2026-01-01' }],
      },
      awayStats: {
        record: '42-18',
        lastMatches: [{ pf: 108, pa: 102, isHome: false, date: '2026-01-01' }],
      },
      sport: 'basketball',
      isDetailed: true,
    });

    const types = result.recommendations.map(r => r.type);
    expect(types).toContain('WIN');
    expect(types).toContain('GOALS');
  });

  test('tennis predictions remain unchanged (WIN only)', () => {
    const result = analyzeMatchServer({
      homeName: 'Alcaraz',
      awayName: 'Sinner',
      homeStats: { record: '50-10' },
      awayStats: { record: '45-12' },
      sport: 'tennis',
      isDetailed: true,
    });

    expect(result.recommendations.length).toBeGreaterThanOrEqual(1);
    expect(result.recommendations[0].type).toBe('WIN');
  });

  test('football analyzeMatchServer produces Home/Away Team Under 2.5 when supported by history', () => {
    const result = analyzeMatchServer({
      homeName: 'Real Madrid',
      awayName: 'Getafe',
      homeStats: {
        record: '22-4-2',
        lastMatches: [
          { pf: 2, pa: 0, isHome: true, result: 'W' },
          { pf: 1, pa: 0, isHome: false, result: 'W' },
          { pf: 2, pa: 1, isHome: true, result: 'W' },
          { pf: 1, pa: 1, isHome: false, result: 'D' },
          { pf: 0, pa: 0, isHome: true, result: 'D' },
        ],
      },
      awayStats: {
        record: '8-8-12',
        lastMatches: [
          { pf: 0, pa: 1, isHome: false, result: 'L' },
          { pf: 1, pa: 1, isHome: true, result: 'D' },
          { pf: 0, pa: 0, isHome: false, result: 'D' },
          { pf: 1, pa: 2, isHome: true, result: 'L' },
          { pf: 0, pa: 2, isHome: false, result: 'L' },
        ],
      },
      sport: 'soccer',
      isDetailed: true,
    });

    expect(result).toHaveProperty('recommendations');
    expect(result.recommendations.length).toBeLessThanOrEqual(2);
    expect(result).toHaveProperty('allMarkets');
    expect(Array.isArray(result.allMarkets)).toBe(true);
    const marketTypes = result.allMarkets.map(m => m.market);
    expect(marketTypes).toContain('home_team_under_2_5');
    expect(marketTypes).toContain('away_team_under_2_5');
  });
});

describe('Section 8 — Team Under 2.5 Scoreline Matrix & Settlement', () => {
  const { settleTeamUnder25 } = require('../services/footballHistoricalAnalysis');

  const SCORELINE_CASES = [
    { home: 0, away: 0, expectedHome: 'WIN', expectedAway: 'WIN' },
    { home: 1, away: 0, expectedHome: 'WIN', expectedAway: 'WIN' },
    { home: 0, away: 1, expectedHome: 'WIN', expectedAway: 'WIN' },
    { home: 1, away: 1, expectedHome: 'WIN', expectedAway: 'WIN' },
    { home: 2, away: 0, expectedHome: 'WIN', expectedAway: 'WIN' },
    { home: 0, away: 2, expectedHome: 'WIN', expectedAway: 'WIN' },
    { home: 2, away: 1, expectedHome: 'WIN', expectedAway: 'WIN' },
    { home: 1, away: 2, expectedHome: 'WIN', expectedAway: 'WIN' },
    { home: 3, away: 0, expectedHome: 'LOSS', expectedAway: 'WIN' },
    { home: 0, away: 3, expectedHome: 'WIN', expectedAway: 'LOSS' },
    { home: 3, away: 2, expectedHome: 'LOSS', expectedAway: 'WIN' },
    { home: 2, away: 3, expectedHome: 'WIN', expectedAway: 'LOSS' },
    { home: 3, away: 3, expectedHome: 'LOSS', expectedAway: 'LOSS' },
  ];

  SCORELINE_CASES.forEach(({ home, away, expectedHome, expectedAway }) => {
    test(`Scoreline ${home}–${away}: Home Under 2.5 = ${expectedHome}, Away Under 2.5 = ${expectedAway}`, () => {
      const outcome = settleTeamUnder25(home, away);
      expect(outcome.homeUnder25).toBe(expectedHome);
      expect(outcome.awayUnder25).toBe(expectedAway);
    });
  });

  test('0–0 is classified as a WIN for both markets', () => {
    const outcome = settleTeamUnder25(0, 0);
    expect(outcome.homeUnder25).toBe('WIN');
    expect(outcome.awayUnder25).toBe('WIN');
  });

  test('3–1 result: Home loses (3 goals), Away wins (1 goal)', () => {
    const outcome = settleTeamUnder25(3, 1);
    expect(outcome.homeUnder25).toBe('LOSS');
    expect(outcome.awayUnder25).toBe('WIN');
  });

  test('invalid / missing scores return null', () => {
    expect(settleTeamUnder25(null, 1)).toEqual({ homeUnder25: null, awayUnder25: null });
    expect(settleTeamUnder25(1, undefined)).toEqual({ homeUnder25: null, awayUnder25: null });
    expect(settleTeamUnder25(NaN, 2)).toEqual({ homeUnder25: null, awayUnder25: null });
  });
});

describe('Statistical Team Under 2.5 Calculation & Backtesting', () => {
  const {
    analyzeTeamUnder25History,
    calculateTeamUnder25Prediction,
    backtestHistoricalFixtures,
  } = require('../services/footballHistoricalAnalysis');

  test('analyzeTeamUnder25History correctly computes hit rates and goal averages', () => {
    const matches = [
      { pf: 2, pa: 1, isHome: true },
      { pf: 1, pa: 0, isHome: false },
      { pf: 0, pa: 2, isHome: true },
      { pf: 3, pa: 0, isHome: true }, // Over 2.5
      { pf: 1, pa: 1, isHome: false },
    ];
    const analysis = analyzeTeamUnder25History(matches, { isHomeContext: true });
    expect(analysis.valid).toBe(true);
    expect(analysis.sampleSize).toBe(5);
    expect(analysis.under25Count).toBe(4);
    expect(analysis.over25Count).toBe(1);
    expect(analysis.under25HitRate).toBe(0.8);
    expect(analysis.avgGoalsScored).toBe(1.4);
    expect(analysis.homeAwaySplit.home.sampleSize).toBe(3);
  });

  test('calculateTeamUnder25Prediction generates calibrated independent probability', () => {
    const homeMatches = [
      { pf: 1, pa: 0, isHome: true },
      { pf: 2, pa: 1, isHome: true },
      { pf: 0, pa: 0, isHome: false },
      { pf: 1, pa: 1, isHome: true },
      { pf: 2, pa: 0, isHome: false },
    ];
    const awayMatches = [
      { pf: 0, pa: 1, isHome: false },
      { pf: 1, pa: 2, isHome: true },
      { pf: 0, pa: 0, isHome: false },
      { pf: 0, pa: 3, isHome: false }, // high concede
      { pf: 1, pa: 1, isHome: true },
    ];
    const hAnalysis = analyzeTeamUnder25History(homeMatches, { isHomeContext: true });
    const aAnalysis = analyzeTeamUnder25History(awayMatches, { isHomeContext: false });

    const homePred = calculateTeamUnder25Prediction({
      teamAnalysis: hAnalysis,
      oppAnalysis: aAnalysis,
      isHome: true,
      teamName: 'Arsenal',
      oppName: 'Chelsea',
    });

    const awayPred = calculateTeamUnder25Prediction({
      teamAnalysis: aAnalysis,
      oppAnalysis: hAnalysis,
      isHome: false,
      teamName: 'Chelsea',
      oppName: 'Arsenal',
    });

    expect(homePred).not.toBeNull();
    expect(awayPred).not.toBeNull();
    expect(homePred.market).toBe('home_team_under_2_5');
    expect(awayPred.market).toBe('away_team_under_2_5');
    expect(homePred.value).toBe('Arsenal Under 2.5 Goals');
    expect(awayPred.value).toBe('Chelsea Under 2.5 Goals');
    expect(homePred.confidence).toBeGreaterThanOrEqual(50);
    expect(awayPred.confidence).toBeGreaterThanOrEqual(50);
  });

  test('backtestHistoricalFixtures evaluates homeTeamUnder25 and awayTeamUnder25', () => {
    const fixtures = [
      { id: '1', date: '2026-01-01', homeTeamId: 't1', awayTeamId: 't2', ftHome: 1, ftAway: 0, htHome: 0, htAway: 0 },
      { id: '2', date: '2026-01-08', homeTeamId: 't1', awayTeamId: 't3', ftHome: 2, ftAway: 1, htHome: 1, htAway: 0 },
      { id: '3', date: '2026-01-15', homeTeamId: 't2', awayTeamId: 't1', ftHome: 0, ftAway: 2, htHome: 0, htAway: 1 },
      { id: '4', date: '2026-01-22', homeTeamId: 't3', awayTeamId: 't1', ftHome: 1, ftAway: 1, htHome: 0, htAway: 0 },
      { id: '5', date: '2026-01-29', homeTeamId: 't1', awayTeamId: 't2', ftHome: 1, ftAway: 1, htHome: 0, htAway: 0 },
    ];
    const report = backtestHistoricalFixtures(fixtures);
    expect(report.evaluatedCount).toBe(5);
    expect(report).toHaveProperty('homeTeamUnder25');
    expect(report).toHaveProperty('awayTeamUnder25');
    expect(report.homeTeamUnder25.brierScore !== undefined).toBe(true);
  });
});

