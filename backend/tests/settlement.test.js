/**
 * Settlement Engine Unit & API Tests
 *
 * Comprehensive tests covering:
 *   1. Market settlement rules (Under 4.5, Under 2.5 HT, Home U2.5, Away U2.5, Corners, 1X2, BTTS, DC)
 *   2. Match status classification (finished vs live vs scheduled vs cancelled)
 *   3. Score validation and defensive checks
 *   4. Prediction persistence, idempotency, and reconciliation
 *   5. Automatic batch settlement
 *   6. User prediction statistics and history
 *   7. Express HTTP settlement endpoints via supertest
 */

const request = require('supertest');

// Mocks for uuid and firebase-admin before requiring modules
jest.mock('uuid', () => ({
  v4: () => 'test-settle-uuid-' + Math.random().toString(36).slice(2, 10),
}));

// In-memory Firestore mock store
let mockFirestoreStore = new Map();

const createMockDocRef = (id, data) => ({
  id,
  get: jest.fn(async () => ({
    exists: mockFirestoreStore.has(id),
    id,
    data: () => mockFirestoreStore.get(id),
  })),
  update: jest.fn(async (updateData) => {
    const existing = mockFirestoreStore.get(id) || {};
    mockFirestoreStore.set(id, { ...existing, ...updateData });
    return {};
  }),
});

const createMockQuerySnapshot = (docsArray) => ({
  empty: docsArray.length === 0,
  size: docsArray.length,
  docs: docsArray.map(d => ({
    id: d.id,
    data: () => d,
    ref: createMockDocRef(d.id, d),
  })),
});

jest.mock('firebase-admin', () => {
  const fieldValueMock = {
    serverTimestamp: jest.fn(() => new Date().toISOString()),
    increment: jest.fn(v => v),
  };

  const firestoreMock = {
    collection: jest.fn((colName) => ({
      add: jest.fn(async (docData) => {
        const id = 'pred_doc_' + Math.random().toString(36).slice(2, 8);
        mockFirestoreStore.set(id, { ...docData, id });
        return createMockDocRef(id, docData);
      }),
      doc: jest.fn((id) => createMockDocRef(id, mockFirestoreStore.get(id))),
      where: jest.fn(function() { return this; }),
      orderBy: jest.fn(function() { return this; }),
      limit: jest.fn(function() { return this; }),
      get: jest.fn(async function() {
        const all = Array.from(mockFirestoreStore.values());
        return createMockQuerySnapshot(all);
      }),
    })),
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

const admin = require('firebase-admin');
const {
  settleMarket,
  classifyMatchStatus,
  normaliseMarketKey,
  normaliseSelection,
  isValidScore,
  savePrediction,
  settlePrediction,
  getUnsettledPredictions,
  getUserPredictionHistory,
  getUserPredictionStats,
  getMatchSettlement,
  autoSettleFinishedMatches,
} = require('../services/settlementService');
const { app } = require('../server');

beforeEach(() => {
  mockFirestoreStore.clear();
});

// ──────────────────────────────────────────────────────────
// 1. Settlement Rules Tests
// ──────────────────────────────────────────────────────────

describe('Market Settlement Rules', () => {
  describe('Under 4.5 Goals', () => {
    test('settles WON when total full-time goals is 0, 1, 2, 3, or 4', () => {
      expect(settleMarket('under_4_5_goals', 'YES', 0, 0)).toBe('won');
      expect(settleMarket('under_4_5_goals', 'YES', 1, 0)).toBe('won');
      expect(settleMarket('under_4_5_goals', 'YES', 2, 1)).toBe('won');
      expect(settleMarket('under_4_5_goals', 'YES', 2, 2)).toBe('won');
      expect(settleMarket('under_4_5_goals', 'YES', 4, 0)).toBe('won');
    });

    test('settles LOST when total full-time goals is 5 or more', () => {
      expect(settleMarket('under_4_5_goals', 'YES', 3, 2)).toBe('lost');
      expect(settleMarket('under_4_5_goals', 'YES', 5, 0)).toBe('lost');
      expect(settleMarket('under_4_5_goals', 'YES', 4, 2)).toBe('lost');
    });
  });

  describe('Under 2.5 HT (Half-Time)', () => {
    test('settles WON when combined first-half goals is 0, 1, or 2', () => {
      expect(settleMarket('under_2_5_ht', 'YES', 2, 1, { htHome: 0, htAway: 0 })).toBe('won');
      expect(settleMarket('under_2_5_ht', 'YES', 3, 2, { htHome: 1, htAway: 0 })).toBe('won');
      expect(settleMarket('under_2_5_ht', 'YES', 4, 1, { htHome: 1, htAway: 1 })).toBe('won');
    });

    test('settles LOST when combined first-half goals is 3 or more', () => {
      expect(settleMarket('under_2_5_ht', 'YES', 3, 1, { htHome: 2, htAway: 1 })).toBe('lost');
      expect(settleMarket('under_2_5_ht', 'YES', 3, 3, { htHome: 3, htAway: 0 })).toBe('lost');
    });

    test('returns null if half-time score is missing or invalid', () => {
      expect(settleMarket('under_2_5_ht', 'YES', 2, 1, {})).toBeNull();
      expect(settleMarket('under_2_5_ht', 'YES', 2, 1, { htHome: null, htAway: 1 })).toBeNull();
    });
  });

  describe('Home Team Under 2.5 Goals', () => {
    test('settles WON when home team scores 0, 1, or 2 goals', () => {
      expect(settleMarket('home_team_under_2_5', 'YES', 0, 0)).toBe('won');
      expect(settleMarket('home_team_under_2_5', 'YES', 1, 4)).toBe('won');
      expect(settleMarket('home_team_under_2_5', 'YES', 2, 5)).toBe('won');
    });

    test('settles LOST when home team scores 3 or more goals', () => {
      expect(settleMarket('home_team_under_2_5', 'YES', 3, 0)).toBe('lost');
      expect(settleMarket('home_team_under_2_5', 'YES', 4, 1)).toBe('lost');
      expect(settleMarket('home_team_under_2_5', 'YES', 5, 2)).toBe('lost');
    });
  });

  describe('Away Team Under 2.5 Goals', () => {
    test('settles WON when away team scores 0, 1, or 2 goals', () => {
      expect(settleMarket('away_team_under_2_5', 'YES', 0, 0)).toBe('won');
      expect(settleMarket('away_team_under_2_5', 'YES', 3, 1)).toBe('won'); // Away scored 1 in 3-1 match
      expect(settleMarket('away_team_under_2_5', 'YES', 4, 2)).toBe('won');
    });

    test('settles LOST when away team scores 3 or more goals', () => {
      expect(settleMarket('away_team_under_2_5', 'YES', 0, 3)).toBe('lost');
      expect(settleMarket('away_team_under_2_5', 'YES', 2, 4)).toBe('lost');
    });
  });

  describe('Under Corners', () => {
    test('settles against corner line correctly', () => {
      expect(settleMarket('under_corners', 'YES', 1, 0, { totalCorners: 7, cornersLine: 10.5 })).toBe('won');
      expect(settleMarket('under_corners', 'YES', 1, 0, { totalCorners: 12, cornersLine: 10.5 })).toBe('lost');
    });

    test('returns null if corner data is not provided', () => {
      expect(settleMarket('under_corners', 'YES', 1, 0, {})).toBeNull();
    });
  });

  describe('1X2 and Double Chance', () => {
    test('settles 1X2 correctly', () => {
      expect(settleMarket('match_result', 'home_win', 2, 1)).toBe('won');
      expect(settleMarket('match_result', 'home_win', 1, 1)).toBe('lost');
      expect(settleMarket('match_result', 'draw', 1, 1)).toBe('won');
      expect(settleMarket('match_result', 'away_win', 0, 2)).toBe('won');
    });

    test('settles Double Chance 1X, X2, 12 correctly', () => {
      expect(settleMarket('double_chance', '1x', 1, 0)).toBe('won');
      expect(settleMarket('double_chance', '1x', 1, 1)).toBe('won');
      expect(settleMarket('double_chance', '1x', 0, 1)).toBe('lost');

      expect(settleMarket('double_chance', 'x2', 0, 1)).toBe('won');
      expect(settleMarket('double_chance', 'x2', 1, 1)).toBe('won');
      expect(settleMarket('double_chance', 'x2', 2, 0)).toBe('lost');
    });
  });

  describe('BTTS (Both Teams To Score)', () => {
    test('settles BTTS yes/no', () => {
      expect(settleMarket('btts', 'yes', 1, 1)).toBe('won');
      expect(settleMarket('btts', 'yes', 2, 0)).toBe('lost');
      expect(settleMarket('btts', 'no', 2, 0)).toBe('won');
      expect(settleMarket('btts', 'no', 1, 1)).toBe('lost');
    });
  });
});

// ──────────────────────────────────────────────────────────
// 2. Status Classification and Defensive Validation
// ──────────────────────────────────────────────────────────

describe('Status Classification & Score Validation', () => {
  test('correctly identifies finished matches', () => {
    expect(classifyMatchStatus('post')).toBe('finished');
    expect(classifyMatchStatus('FT')).toBe('finished');
    expect(classifyMatchStatus('finished')).toBe('finished');
    expect(classifyMatchStatus('full-time')).toBe('finished');
    expect(classifyMatchStatus('complete')).toBe('finished');
    expect(classifyMatchStatus('FINAL')).toBe('finished');
  });

  test('correctly identifies in-progress / live matches', () => {
    expect(classifyMatchStatus('in')).toBe('live');
    expect(classifyMatchStatus('live')).toBe('live');
    expect(classifyMatchStatus('1h')).toBe('live');
    expect(classifyMatchStatus('2h')).toBe('live');
    expect(classifyMatchStatus('ht')).toBe('live');
  });

  test('correctly identifies scheduled matches', () => {
    expect(classifyMatchStatus('pre')).toBe('scheduled');
    expect(classifyMatchStatus('scheduled')).toBe('scheduled');
    expect(classifyMatchStatus('not_started')).toBe('scheduled');
  });

  test('correctly identifies postponed and cancelled matches', () => {
    expect(classifyMatchStatus('postponed')).toBe('postponed');
    expect(classifyMatchStatus('pst')).toBe('postponed');
    expect(classifyMatchStatus('canc')).toBe('cancelled');
    expect(classifyMatchStatus('abandoned')).toBe('cancelled');
  });

  test('validates numeric non-negative finite scores', () => {
    expect(isValidScore(0)).toBe(true);
    expect(isValidScore(3)).toBe(true);
    expect(isValidScore('2')).toBe(true);
    expect(isValidScore(-1)).toBe(false);
    expect(isValidScore(NaN)).toBe(false);
    expect(isValidScore(null)).toBe(false);
    expect(isValidScore(undefined)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────
// 3. Persistence, Idempotency & Reconciliation
// ──────────────────────────────────────────────────────────

describe('Prediction Persistence & Settlement Lifecycle', () => {
  test('savePrediction stores pending prediction in Firestore', async () => {
    const docId = await savePrediction(admin, {
      userId: 'user_123',
      matchId: 'match_4001',
      sport: 'soccer',
      leagueSlug: 'eng.1',
      league: 'Premier League',
      homeName: 'Arsenal',
      awayName: 'Chelsea',
      homeTeamId: '359',
      awayTeamId: '363',
      matchDate: '2026-10-14T19:00:00Z',
      predictions: [
        { market: 'under_4_5_goals', label: 'Under 4.5 Goals', value: 'Under 4.5', confidence: 85 },
        { market: 'home_team_under_2_5', label: 'Home Under 2.5', value: 'Home Under 2.5', confidence: 82 },
      ],
    });

    expect(docId).toBeDefined();
    const stored = mockFirestoreStore.get(docId);
    expect(stored.settlementStatus).toBe('pending');
    expect(stored.predictions.length).toBe(2);
    expect(stored.actualHomeScore).toBeNull();
  });

  test('settlePrediction calculates won/lost and updates record idempotently', async () => {
    const docId = await savePrediction(admin, {
      userId: 'user_456',
      matchId: 'match_4002',
      sport: 'soccer',
      leagueSlug: 'eng.1',
      homeName: 'Liverpool',
      awayName: 'Everton',
      predictions: [
        { market: 'under_4_5_goals', label: 'Under 4.5 Goals', value: 'Under 4.5', confidence: 90 },
        { market: 'away_team_under_2_5', label: 'Away Under 2.5', value: 'Away Under 2.5', confidence: 88 },
      ],
    });

    const docSnapshot = {
      id: docId,
      data: () => mockFirestoreStore.get(docId),
      ref: createMockDocRef(docId, mockFirestoreStore.get(docId)),
    };

    // Settle with score Liverpool 2 - 0 Everton
    const res = await settlePrediction(admin, docSnapshot, { homeGoals: 2, awayGoals: 0 }, 'espn');
    expect(res).not.toBeNull();
    expect(res.results.length).toBe(2);
    expect(res.results[0].outcome).toBe('won'); // 2 < 5
    expect(res.results[1].outcome).toBe('won'); // away 0 <= 2

    const updated = mockFirestoreStore.get(docId);
    expect(updated.settlementStatus).toBe('settled');
    expect(updated.actualHomeScore).toBe(2);
    expect(updated.actualAwayScore).toBe(0);

    // Idempotent re-run with same score returns null and changes nothing
    const rerun = await settlePrediction(admin, {
      id: docId,
      data: () => mockFirestoreStore.get(docId),
      ref: createMockDocRef(docId, mockFirestoreStore.get(docId)),
    }, { homeGoals: 2, awayGoals: 0 }, 'espn');
    expect(rerun).toBeNull();
  });

  test('score correction reconciles previously settled prediction', async () => {
    const docId = await savePrediction(admin, {
      userId: 'user_789',
      matchId: 'match_4003',
      sport: 'soccer',
      predictions: [
        { market: 'home_team_under_2_5', label: 'Home Under 2.5', value: 'Home Under 2.5', confidence: 80 },
      ],
    });

    // Initial erroneous report: 2-0 (Home won market)
    await settlePrediction(admin, {
      id: docId,
      data: () => mockFirestoreStore.get(docId),
      ref: createMockDocRef(docId, mockFirestoreStore.get(docId)),
    }, { homeGoals: 2, awayGoals: 0 }, 'espn');

    let current = mockFirestoreStore.get(docId);
    expect(current.results[0].outcome).toBe('won');

    // Official VAR correction: 3-0 (Home scored 3, so Home Under 2.5 lost)
    await settlePrediction(admin, {
      id: docId,
      data: () => mockFirestoreStore.get(docId),
      ref: createMockDocRef(docId, mockFirestoreStore.get(docId)),
    }, { homeGoals: 3, awayGoals: 0 }, 'espn');

    current = mockFirestoreStore.get(docId);
    expect(current.actualHomeScore).toBe(3);
    expect(current.results[0].outcome).toBe('lost');
    expect(current.settlementVersion).toBe(3);
  });
});

// ──────────────────────────────────────────────────────────
// 4. Batch Auto-Settlement Worker
// ──────────────────────────────────────────────────────────

describe('autoSettleFinishedMatches Worker', () => {
  test('automatically fetches and settles pending matches when finished', async () => {
    await savePrediction(admin, {
      userId: 'user_auto_1',
      matchId: 'match_finish_100',
      sport: 'soccer',
      leagueSlug: 'eng.1',
      predictions: [
        { market: 'under_4_5_goals', label: 'Under 4.5', value: 'Under 4.5', confidence: 85 },
      ],
    });

    // Mock summary fetcher returning finished match 2-1
    const mockFetcher = jest.fn(async (sport, leagueSlug, matchId) => {
      if (matchId === 'match_finish_100') {
        return {
          header: {
            competitions: [{
              status: { type: { state: 'post' } },
              competitors: [
                { homeAway: 'home', score: '2' },
                { homeAway: 'away', score: '1' },
              ],
            }],
          },
        };
      }
      return null;
    });

    const report = await autoSettleFinishedMatches(admin, mockFetcher);
    expect(report.settled).toBe(1);
    expect(report.errors).toBe(0);
  });

  test('leaves live or upcoming matches as pending', async () => {
    await savePrediction(admin, {
      userId: 'user_auto_2',
      matchId: 'match_live_200',
      sport: 'soccer',
      predictions: [{ market: 'under_4_5_goals', label: 'Under 4.5', confidence: 80 }],
    });

    const mockFetcher = jest.fn(async () => ({
      header: {
        competitions: [{
          status: { type: { state: 'in' } }, // Live match
          competitors: [
            { homeAway: 'home', score: '1' },
            { homeAway: 'away', score: '0' },
          ],
        }],
      },
    }));

    const report = await autoSettleFinishedMatches(admin, mockFetcher);
    expect(report.settled).toBe(0); // Not settled because not finished
  });
});

// ──────────────────────────────────────────────────────────
// 5. Express HTTP Endpoints via Supertest
// ──────────────────────────────────────────────────────────

describe('Settlement HTTP Endpoints', () => {
  test('POST /api/predictions/save rejects missing required fields', async () => {
    const res = await request(app)
      .post('/api/predictions/save')
      .send({ sport: 'soccer' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing userId or matchId/);
  });

  test('POST /api/predictions/save stores prediction successfully', async () => {
    const res = await request(app)
      .post('/api/predictions/save')
      .send({
        userId: 'usr_api_test',
        matchId: 'match_api_99',
        sport: 'soccer',
        leagueSlug: 'eng.1',
        predictions: [{ market: 'under_4_5_goals', value: 'Under 4.5', confidence: 85 }],
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.docId).toBeDefined();
  });

  test('GET /api/predictions/history returns prediction history', async () => {
    await request(app)
      .post('/api/predictions/save')
      .send({
        userId: 'usr_history_1',
        matchId: 'match_hist_1',
        predictions: [{ market: 'under_4_5_goals', value: 'Under 4.5', confidence: 80 }],
      });

    const res = await request(app)
      .get('/api/predictions/history?userId=usr_history_1');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.history)).toBe(true);
  });

  test('GET /api/predictions/stats returns user win rate and totals', async () => {
    const res = await request(app)
      .get('/api/predictions/stats?userId=usr_history_1');
    expect(res.status).toBe(200);
    expect(res.body.stats).toBeDefined();
    expect(res.body.stats.winRate).toBeDefined();
  });

  test('GET /api/predictions/settlement/:matchId returns match status', async () => {
    const res = await request(app)
      .get('/api/predictions/settlement/match_hist_1?userId=usr_history_1');
    expect(res.status).toBe(200);
    expect(res.body.settlement).toBeDefined();
  });

  test('POST /api/predictions/settle triggers manual batch run', async () => {
    const res = await request(app).post('/api/predictions/settle');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.checked).toBeDefined();
  });
});
