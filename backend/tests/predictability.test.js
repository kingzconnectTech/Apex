/**
 * Predictability Scoring & Intelligent Match Filtering Unit & Integration Tests
 *
 * Verifies:
 *   1. Data quality scoring (sample coverage, verified scores, HT presence)
 *   2. Form consistency & scoring variance calculations
 *   3. Model agreement between empirical Bayes and Poisson expectancy
 *   4. Predictability index scoring
 *   5. Strict candidate admission & explicit rejection reasons
 *   6. Fixture ranking and separation of 'All Fixtures' vs 'Recommended Predictions'
 *   7. Zero-recommendation behavior when no fixtures meet strict 75%+ criteria
 *   8. HTTP endpoints for recommended predictions and all fixtures
 */

const request = require('supertest');

// Mocks for uuid and firebase-admin before requiring server
jest.mock('uuid', () => ({
  v4: () => 'test-pred-uuid-' + Math.random().toString(36).slice(2, 10),
}));

jest.mock('firebase-admin', () => {
  const fieldValueMock = {
    serverTimestamp: jest.fn(() => new Date().toISOString()),
    increment: jest.fn(v => v),
  };
  const firestoreMock = {
    collection: jest.fn(() => firestoreMock),
    doc: jest.fn(() => firestoreMock),
    where: jest.fn(function() { return this; }),
    orderBy: jest.fn(function() { return this; }),
    limit: jest.fn(function() { return this; }),
    get: jest.fn(async () => ({ empty: true, size: 0, docs: [] })),
    add: jest.fn(async () => ({ id: 'mock_doc' })),
    FieldValue: fieldValueMock,
  };
  const firestoreFn = jest.fn(() => firestoreMock);
  firestoreFn.FieldValue = fieldValueMock;

  return {
    apps: ['dummy'],
    initializeApp: jest.fn(),
    credential: { cert: jest.fn() },
    firestore: firestoreFn,
  };
});

const {
  DEFAULT_FILTER_CONFIG,
  calculateDataQualityScore,
  calculateFormConsistency,
  calculateModelAgreement,
  calculatePredictabilityScore,
  evaluateMarketCandidate,
  evaluateFixture,
  filterAndRankFixtures,
} = require('../services/predictabilityEngine');
const { app } = require('../server');

// Helper to generate realistic historical match records
function generateMockMatches(count, { avgPf = 1.2, avgPa = 0.9, isHome = true, hasHt = true } = {}) {
  const matches = [];
  const baseTime = Date.now() - 1000 * 60 * 60 * 24 * 60; // 60 days ago
  for (let i = 0; i < count; i++) {
    const pf = Math.max(0, Math.round(avgPf + (Math.sin(i) * 0.7)));
    const pa = Math.max(0, Math.round(avgPa + (Math.cos(i) * 0.6)));
    const date = new Date(baseTime + i * 1000 * 60 * 60 * 24 * 4).toISOString();
    const htTeam = Math.round(pf * 0.5);
    const htOpp = Math.round(pa * 0.5);
    matches.push({
      id: `match_${i}`,
      date,
      pf,
      pa,
      totalGoals: pf + pa,
      isHome,
      status: 'post',
      htScore: hasHt ? { team: htTeam, opp: htOpp, total: htTeam + htOpp } : null,
    });
  }
  return matches;
}

// ──────────────────────────────────────────────────────────
// 1. Data Quality Scoring Tests
// ──────────────────────────────────────────────────────────

describe('Data Quality Scoring', () => {
  test('returns 0 for empty or null match history', () => {
    expect(calculateDataQualityScore([], [])).toBe(0);
    expect(calculateDataQualityScore(null, null)).toBe(0);
  });

  test('scores high (>= 0.75) when both teams have 8+ verified completed matches', () => {
    const homeMatches = generateMockMatches(10);
    const awayMatches = generateMockMatches(10);
    const score = calculateDataQualityScore(homeMatches, awayMatches);
    expect(score).toBeGreaterThanOrEqual(0.75);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  test('penalizes when match records lack verified scores', () => {
    const cleanMatches = generateMockMatches(8);
    const corruptedMatches = [
      { id: '1', pf: null, pa: 2, date: '2026-09-01' },
      { id: '2', pf: NaN, pa: null, date: '2026-09-05' },
    ];
    const cleanScore = calculateDataQualityScore(cleanMatches, cleanMatches);
    const badScore = calculateDataQualityScore(corruptedMatches, corruptedMatches);
    expect(badScore).toBeLessThan(cleanScore);
  });

  test('evaluates half-time completeness when requireHt is enabled', () => {
    const withHt = generateMockMatches(8, { hasHt: true });
    const withoutHt = generateMockMatches(8, { hasHt: false });
    const scoreWithHt = calculateDataQualityScore(withHt, withHt, { requireHt: true });
    const scoreWithoutHt = calculateDataQualityScore(withoutHt, withoutHt, { requireHt: true });
    expect(scoreWithHt).toBeGreaterThan(scoreWithoutHt);
  });
});

// ──────────────────────────────────────────────────────────
// 2. Form Consistency & Scoring Variance
// ──────────────────────────────────────────────────────────

describe('Form Consistency & Variance', () => {
  test('stable low-scoring team achieves high consistency score', () => {
    // Team scoring consistently 1 goal per match
    const stableMatches = [
      { pf: 1 }, { pf: 1 }, { pf: 1 }, { pf: 2 }, { pf: 1 }, { pf: 1 },
    ];
    const { consistencyScore, variance } = calculateFormConsistency(stableMatches);
    expect(variance).toBeLessThan(0.5);
    expect(consistencyScore).toBeGreaterThan(0.85);
  });

  test('volatile scoring team achieves low consistency score and high variance', () => {
    // Volatile scores: 0, 5, 0, 4, 1, 6
    const volatileMatches = [
      { pf: 0 }, { pf: 5 }, { pf: 0 }, { pf: 4 }, { pf: 1 }, { pf: 6 },
    ];
    const { consistencyScore, variance } = calculateFormConsistency(volatileMatches);
    expect(variance).toBeGreaterThan(4.0);
    expect(consistencyScore).toBeLessThan(0.3);
  });
});

// ──────────────────────────────────────────────────────────
// 3. Model Agreement Scoring
// ──────────────────────────────────────────────────────────

describe('Model Agreement Scoring', () => {
  test('returns near 1.0 when empirical Bayesian rate and Poisson expectancy agree', () => {
    const agreement = calculateModelAgreement(0.84, 0.85);
    expect(agreement).toBeGreaterThanOrEqual(0.95);
  });

  test('penalizes when models diverge significantly', () => {
    // Empirical 90% vs Poisson 55%
    const agreement = calculateModelAgreement(0.90, 0.55);
    expect(agreement).toBeLessThanOrEqual(0.65);
  });
});

// ──────────────────────────────────────────────────────────
// 4. Candidate Admission & Explicit Rejection Reasons
// ──────────────────────────────────────────────────────────

describe('Candidate Admission & Strict Filtering', () => {
  const futureFixture = {
    id: 'fix_future_99',
    date: new Date(Date.now() + 1000 * 60 * 60 * 24 * 2).toISOString(), // 2 days in future
  };

  test('admits a candidate that satisfies all strict criteria (prob >= 75%, sample >= 5, data quality >= 0.65)', () => {
    const cleanHome = generateMockMatches(8, { avgPf: 1.0 });
    const cleanAway = generateMockMatches(8, { avgPf: 0.8 });

    const strongPrediction = {
      market: 'under_4_5_goals',
      label: 'Under 4.5 Goals',
      value: 'Under 4.5',
      probability: 0.84, // 84% > 75%
      confidence: 84,
      expectedGoals: 2.4,
      factors: [{ label: 'Strong defensive record' }],
    };

    const candidate = evaluateMarketCandidate({
      market: 'under_4_5_goals',
      predictionResult: strongPrediction,
      cleanHomeMatches: cleanHome,
      cleanAwayMatches: cleanAway,
      fixture: futureFixture,
    });

    expect(candidate.is_eligible).toBe(true);
    expect(candidate.rejection_reasons.length).toBe(0);
    expect(candidate.calibrated_probability).toBe(0.84);
    expect(candidate.predictability_score).toBeGreaterThanOrEqual(0.65);
    expect(candidate.supporting_evidence.length).toBeGreaterThan(0);
  });

  test('rejects candidate when sample size is insufficient (< 5 matches per team)', () => {
    const smallHome = generateMockMatches(3); // Only 3 matches
    const validAway = generateMockMatches(8);

    const pred = {
      market: 'under_4_5_goals',
      probability: 0.88,
      confidence: 88,
    };

    const candidate = evaluateMarketCandidate({
      market: 'under_4_5_goals',
      predictionResult: pred,
      cleanHomeMatches: smallHome,
      cleanAwayMatches: validAway,
      fixture: futureFixture,
    });

    expect(candidate.is_eligible).toBe(false);
    expect(candidate.rejection_reasons.some(r => r.includes('Insufficient historical matches'))).toBe(true);
  });

  test('rejects candidate when calibrated probability is below 75% threshold', () => {
    const cleanHome = generateMockMatches(8);
    const cleanAway = generateMockMatches(8);

    const weakPrediction = {
      market: 'under_4_5_goals',
      probability: 0.68, // 68% < 75% threshold
      confidence: 68,
    };

    const candidate = evaluateMarketCandidate({
      market: 'under_4_5_goals',
      predictionResult: weakPrediction,
      cleanHomeMatches: cleanHome,
      cleanAwayMatches: cleanAway,
      fixture: futureFixture,
    });

    expect(candidate.is_eligible).toBe(false);
    expect(candidate.rejection_reasons.some(r => r.includes('below required 75% threshold'))).toBe(true);
  });

  test('rejects fixture whose kickoff time is in the past', () => {
    const pastFixture = {
      id: 'fix_past_11',
      date: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(), // 2 hours ago
    };

    const cleanHome = generateMockMatches(8);
    const cleanAway = generateMockMatches(8);

    const strongPred = {
      market: 'under_4_5_goals',
      probability: 0.85,
    };

    const candidate = evaluateMarketCandidate({
      market: 'under_4_5_goals',
      predictionResult: strongPred,
      cleanHomeMatches: cleanHome,
      cleanAwayMatches: cleanAway,
      fixture: pastFixture,
    });

    expect(candidate.is_eligible).toBe(false);
    expect(candidate.rejection_reasons.some(r => r.includes('past or match is already underway'))).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────
// 5. Fixture Evaluation & Separation of Datasets
// ──────────────────────────────────────────────────────────

describe('evaluateFixture & filterAndRankFixtures', () => {
  const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 3).toISOString();

  test('identifies Under 4.5 Goals market on strong defensive fixture', () => {
    // Both teams score very few goals historically (avg 0.8)
    const homeMatches = generateMockMatches(10, { avgPf: 0.8, avgPa: 0.6, isHome: true });
    const awayMatches = generateMockMatches(10, { avgPf: 0.7, avgPa: 0.7, isHome: false });

    const evaluation = evaluateFixture({
      fixture: { id: 'match_strong_defense', date: futureDate, league: 'Premier League' },
      cleanHomeMatches: homeMatches,
      cleanAwayMatches: awayMatches,
      homeName: 'Arsenal',
      awayName: 'Newcastle',
    });

    expect(evaluation.isRecommended).toBe(true);
    expect(evaluation.eligibleCandidates.length).toBeGreaterThan(0);
    expect(evaluation.topCandidate).toBeDefined();
    expect(evaluation.topCandidate.calibrated_probability).toBeGreaterThanOrEqual(0.75);
    expect(evaluation.confidenceLabel).toMatch(/Validated|High Confidence/);
  });

  test('does NOT force recommendations when no market qualifies (abstains safely)', () => {
    // Highly volatile high-scoring teams (avg 3.2 goals)
    const homeMatches = generateMockMatches(6, { avgPf: 3.5, avgPa: 2.5 });
    const awayMatches = generateMockMatches(6, { avgPf: 3.0, avgPa: 3.0 });

    const evaluation = evaluateFixture({
      fixture: { id: 'match_volatile_high_scoring', date: futureDate, league: 'Bundesliga' },
      cleanHomeMatches: homeMatches,
      cleanAwayMatches: awayMatches,
      homeName: 'Bayern',
      awayName: 'Dortmund',
    });

    // None of the Under markets should pass the 75%+ threshold
    expect(evaluation.isRecommended).toBe(false);
    expect(evaluation.topCandidate).toBeNull();
    expect(evaluation.fixtureRejectionReasons.length).toBeGreaterThan(0);
  });

  test('filterAndRankFixtures strictly separates Recommended from All Fixtures', () => {
    const fixture1 = evaluateFixture({
      fixture: { id: 'f1', date: futureDate, league: 'La Liga' },
      cleanHomeMatches: generateMockMatches(10, { avgPf: 0.8 }),
      cleanAwayMatches: generateMockMatches(10, { avgPf: 0.7 }),
      homeName: 'Atletico',
      awayName: 'Getafe',
    });

    const fixture2 = evaluateFixture({
      fixture: { id: 'f2', date: futureDate, league: 'Eredivisie' },
      cleanHomeMatches: generateMockMatches(10, { avgPf: 3.5 }),
      cleanAwayMatches: generateMockMatches(10, { avgPf: 3.0 }),
      homeName: 'Ajax',
      awayName: 'Feyenoord',
    });

    const { recommended, allFixtures, stats } = filterAndRankFixtures([fixture1, fixture2]);

    expect(allFixtures.length).toBe(2);
    expect(recommended.length).toBe(1);
    expect(recommended[0].homeName).toBe('Atletico');
    expect(stats.totalAnalyzed).toBe(2);
    expect(stats.totalRecommended).toBe(1);
    expect(stats.totalRejected).toBe(1);
    expect(stats.acceptanceRate).toBe(50.0);
  });
});

// ──────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────
// 6. HTTP Endpoints via Supertest
// ──────────────────────────────────────────────────────────

describe('Predictability & Fixture HTTP Endpoints', () => {
  let originalFetch;

  beforeAll(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/scoreboard')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            events: [
              {
                id: 'mock_http_ev_1',
                date: new Date(Date.now() + 86400000).toISOString(),
                competitions: [{
                  status: { type: { state: 'pre' } },
                  league: { name: 'Premier League' },
                  competitors: [
                    { id: '101', homeAway: 'home', team: { displayName: 'Arsenal' } },
                    { id: '102', homeAway: 'away', team: { displayName: 'Chelsea' } },
                  ],
                }],
              },
            ],
          }),
        };
      }
      if (urlStr.includes('/schedule')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            events: generateMockMatches(8, { avgPf: 1.0, avgPa: 0.8 }),
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ events: [] }),
      };
    });
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  test('GET /api/predictions/recommended returns selective feed structure', async () => {
    const res = await request(app).get('/api/predictions/recommended?league=eng.1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.recommended)).toBe(true);
    expect(res.body.stats).toBeDefined();
    expect(res.body.stats.totalAnalyzed).toBeDefined();
    expect(res.body.stats.totalRecommended).toBeDefined();
  });

  test('GET /api/fixtures/all returns paginated fixture catalog', async () => {
    const res = await request(app).get('/api/fixtures/all?league=eng.1&limit=10&page=1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.fixtures)).toBe(true);
    expect(res.body.page).toBe(1);
  });

  test('POST /api/fixtures/evaluate returns full transparent evaluation', async () => {
    const cleanMatches = generateMockMatches(8, { avgPf: 0.9 });
    const res = await request(app)
      .post('/api/fixtures/evaluate')
      .send({
        fixture: { id: 'eval_fx_1', date: new Date(Date.now() + 100000000).toISOString() },
        cleanHomeMatches: cleanMatches,
        cleanAwayMatches: cleanMatches,
        homeName: 'Chelsea',
        awayName: 'Wolves',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.evaluation).toBeDefined();
    expect(res.body.evaluation.isRecommended).toBeDefined();
    expect(res.body.evaluation.totalCandidatesEvaluated).toBe(7);
  });
});
