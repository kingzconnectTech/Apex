/**
 * Task 18 — basketball API endpoints.
 *
 * TR-18.1: Supertest returns the documented JSON keys for a mocked game.
 * TR-18.2: An unknown gameId returns 404 without throwing.
 * TR-18.3: `date` / `league` filters narrow the result set correctly.
 * Also covers the leagues endpoint and the persistence-backed performance route.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../services/basketball/ingestion', () => ({
  getPredictions: jest.fn(),
  getGamePrediction: jest.fn(),
}));
jest.mock('../services/basketball/persistence', () => ({
  getBasketballPerformance: jest.fn(),
}));

const ingestion = require('../services/basketball/ingestion');
const persistence = require('../services/basketball/persistence');
const { createBasketballRouter, DISCLAIMER } = require('../routes/basketball');

/** A formatted prediction in the documented shape. */
function mkPrediction({ gameId = '401', league = 'nba', confidence = 'Medium', market = 'Total Points', probability = 0.78 } = {}) {
  return {
    game: 'Home Hawks vs Away Aces',
    gameId,
    tipoff: '2026-01-20T23:00:00.000Z',
    league: league.toUpperCase(),
    leagueKey: league,
    projection: { total: 218.4, margin: 7.2, sigma_total: 17.6, sigma_margin: 11.8 },
    score: { homePoints: 112.8, awayPoints: 105.6 },
    picks: [{
      market,
      selection: 'Over 208.5',
      probability,
      odds: 1.85,
      edge: 0.06,
      confidence,
      reasoning: 'Projected total 218.4; both teams top-10 pace.',
      line: 208.5,
      side: 'over',
      isMain: true,
      ev: 0.11,
    }],
    noPick: false,
    key_factors: [],
    risk_flags: ['Starting PG questionable'],
    data_quality: 0.84,
    modelVersion: 'bb-1.0.0',
  };
}

function buildApp({ admin = null, sportsData = {} } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api', createBasketballRouter({ sportsData, admin }));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('basketball API (TR-18.1, TR-18.2, TR-18.3)', () => {
  test('TR-18.1: GET /basketball/predictions returns the documented keys', async () => {
    ingestion.getPredictions.mockResolvedValue([mkPrediction()]);
    const res = await request(buildApp()).get('/api/basketball/predictions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      date: expect.any(String),
      league: 'all',
      count: 1,
      modelVersion: expect.any(String),
      disclaimer: DISCLAIMER,
    }));
    expect(Array.isArray(res.body.predictions)).toBe(true);

    const p = res.body.predictions[0];
    expect(p).toEqual(expect.objectContaining({
      game: expect.any(String),
      tipoff: expect.any(String),
      league: expect.any(String),
      projection: expect.objectContaining({
        total: expect.any(Number), margin: expect.any(Number),
        sigma_total: expect.any(Number), sigma_margin: expect.any(Number),
      }),
      picks: expect.any(Array),
      data_quality: expect.any(Number),
    }));
    expect(p.picks[0]).toEqual(expect.objectContaining({
      market: expect.any(String), selection: expect.any(String),
      probability: expect.any(Number), odds: expect.any(Number),
      edge: expect.any(Number), confidence: expect.any(String), reasoning: expect.any(String),
    }));
  });

  test('TR-18.3: confidence and market query params narrow the result set', async () => {
    ingestion.getPredictions.mockResolvedValue([
      mkPrediction({ gameId: '1', confidence: 'High', market: 'Total Points', probability: 0.82 }),
      mkPrediction({ gameId: '2', confidence: 'Low', market: 'Spread', probability: 0.78 }),
    ]);

    const byConfidence = await request(buildApp()).get('/api/basketball/predictions?confidence=High');
    expect(byConfidence.body.count).toBe(1);
    expect(byConfidence.body.predictions[0].gameId).toBe('1');

    const byMarket = await request(buildApp()).get('/api/basketball/predictions?market=Spread');
    expect(byMarket.body.count).toBe(1);
    expect(byMarket.body.predictions[0].gameId).toBe('2');
  });

  test('TR-18.3: date and league are forwarded to the ingestion layer', async () => {
    ingestion.getPredictions.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/basketball/predictions?date=2026-01-20&league=wnba');

    expect(res.status).toBe(200);
    expect(res.body.date).toBe('2026-01-20');
    expect(res.body.league).toBe('wnba');
    const arg = ingestion.getPredictions.mock.calls[0][0];
    expect(arg.date).toBe('2026-01-20');
    expect(arg.leagues).toEqual(['wnba']);
  });

  test('TR-18.2: an unknown gameId returns 404 (not a throw) when a league is given', async () => {
    ingestion.getGamePrediction.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/basketball/predictions/nope?league=nba');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no basketball game/i);
  });

  test('a missing league param on the single-game route returns 400', async () => {
    const res = await request(buildApp()).get('/api/basketball/predictions/401');
    expect(res.status).toBe(400);
    expect(ingestion.getGamePrediction).not.toHaveBeenCalled();
  });

  test('a known gameId returns the formatted game with the disclaimer', async () => {
    ingestion.getGamePrediction.mockResolvedValue({ result: {}, formatted: mkPrediction() });
    const res = await request(buildApp()).get('/api/basketball/predictions/401?league=nba');
    expect(res.status).toBe(200);
    expect(res.body.gameId).toBe('401');
    expect(res.body.disclaimer).toBe(DISCLAIMER);
  });

  test('GET /basketball/leagues lists the configured leagues and model version', async () => {
    const res = await request(buildApp()).get('/api/basketball/leagues');
    expect(res.status).toBe(200);
    expect(res.body.modelVersion).toBe('bb-1.0.0');
    expect(res.body.leagues.length).toBeGreaterThanOrEqual(4);
    expect(res.body.leagues.map(l => l.key)).toContain('nba');
  });

  test('GET /basketball/performance is 503 without persistence, and reports with it', async () => {
    const noAdmin = await request(buildApp()).get('/api/basketball/performance');
    expect(noAdmin.status).toBe(503);

    persistence.getBasketballPerformance.mockResolvedValue({
      window: 100, markets: { 'Total Points': { hitRate: 0.57, n: 100 } },
    });
    const withAdmin = await request(buildApp({ admin: {} })).get('/api/basketball/performance?window=50');
    expect(withAdmin.status).toBe(200);
    expect(withAdmin.body.disclaimer).toBe(DISCLAIMER);
    expect(withAdmin.body.markets).toBeDefined();
    expect(persistence.getBasketballPerformance.mock.calls[0][1].window).toBe(50);
  });

  test('an ingestion error surfaces as a 500 with a clear body', async () => {
    ingestion.getPredictions.mockRejectedValue(new Error('upstream down'));
    const res = await request(buildApp()).get('/api/basketball/predictions');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to generate/i);
  });

  test('75% confidence threshold is applied to basketball predictions', async () => {
    ingestion.getPredictions.mockResolvedValue([
      mkPrediction({ gameId: '1', confidence: 'High', market: 'Total Points', probability: 0.82 }),
      mkPrediction({ gameId: '2', confidence: 'Medium', market: 'Total Points', probability: 0.68 }),
      mkPrediction({ gameId: '3', confidence: 'High', market: 'Spread', probability: 0.78 }),
      mkPrediction({ gameId: '4', confidence: 'Low', market: 'Total Points', probability: 0.72 }),
    ]);

    const res = await request(buildApp()).get('/api/basketball/predictions');
    expect(res.status).toBe(200);
    // Only predictions with probability >= 0.75 should be included
    expect(res.body.count).toBeGreaterThanOrEqual(0);
    expect(res.body.count).toBeLessThanOrEqual(2);
    // Verify all returned predictions meet the threshold
    res.body.predictions.forEach(pred => {
      pred.picks.forEach(pick => {
        expect(pick.probability).toBeGreaterThanOrEqual(0.75);
      });
    });
  });

  test('individual game prediction applies 75% confidence threshold', async () => {
    const gameWithLowConfidence = mkPrediction({
      gameId: '401',
      confidence: 'Low',
      market: 'Total Points',
      probability: 0.68,
    });
    gameWithLowConfidence.picks = [
      { ...gameWithLowConfidence.picks[0], probability: 0.68 },
      { ...gameWithLowConfidence.picks[0], market: 'Spread', probability: 0.72 },
    ];

    ingestion.getGamePrediction.mockResolvedValue({
      result: {},
      formatted: gameWithLowConfidence,
    });

    const res = await request(buildApp()).get('/api/basketball/predictions/401?league=nba');
    expect(res.status).toBe(200);
    // All picks below 75% should be filtered out
    expect(res.body.picks.length).toBe(0);
    expect(res.body.message).toContain('75% confidence threshold');
  });

  test('individual game prediction keeps picks above 75% threshold', async () => {
    const gameWithHighConfidence = mkPrediction({
      gameId: '401',
      confidence: 'High',
      market: 'Total Points',
      probability: 0.82,
    });
    gameWithHighConfidence.picks = [
      { ...gameWithHighConfidence.picks[0], probability: 0.82 },
      { ...gameWithHighConfidence.picks[0], market: 'Spread', probability: 0.78 },
    ];

    ingestion.getGamePrediction.mockResolvedValue({
      result: {},
      formatted: gameWithHighConfidence,
    });

    const res = await request(buildApp()).get('/api/basketball/predictions/401?league=nba');
    expect(res.status).toBe(200);
    // Both picks above 75% should remain
    expect(res.body.picks.length).toBe(2);
    expect(res.body.picks[0].probability).toBeGreaterThanOrEqual(0.75);
    expect(res.body.picks[1].probability).toBeGreaterThanOrEqual(0.75);
  });
});
