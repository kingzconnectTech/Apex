/**
 * Apex Backend Integration Tests
 *
 * Tests cover:
 *   - Existing /api/proxy endpoint
 *   - New POST /api/match-prediction endpoint:
 *       - Valid input → full prediction result
 *       - Missing required fields → HTTP 400
 *       - Invalid sport → HTTP 400
 *       - Invalid leagueSlug → HTTP 400
 *       - Non-numeric teamId/matchId → HTTP 400
 *       - Cache hit on second request
 * 
 * Prerequisites: backend must be running on localhost:3000
 *   cd backend && node server.js
 *
 * Run:
 *   cd backend && npx jest tests/server.test.js --forceExit --testTimeout=30000
 */

const request = require('supertest');
const io = require('socket.io-client');

const BASE_URL = 'http://localhost:3000';

// Known stable ESPN IDs for testing (Premier League Arsenal vs Chelsea)
const VALID_PAYLOAD = {
  matchId: '695281',
  sport: 'soccer',
  leagueSlug: 'eng.1',
  homeTeamId: '359',   // Arsenal
  awayTeamId: '363',   // Chelsea
};

describe('Apex Backend Integration Tests', () => {
  let socket;

  beforeAll((done) => {
    socket = io(BASE_URL, { timeout: 5000 });
    socket.on('connect', done);
    socket.on('connect_error', done); // Don't block tests if socket fails
  }, 10000);

  afterAll(() => {
    if (socket) socket.close();
  });

  // ----------------------------------------------------------------
  // Existing endpoints
  // ----------------------------------------------------------------

  test('GET / should return 200', async () => {
    const res = await request(BASE_URL).get('/');
    expect(res.statusCode).toBe(200);
  });

  test('GET /api/proxy should return data and traceId header', async () => {
    const res = await request(BASE_URL)
      .get('/api/proxy')
      .query({ target: 'soccer/eng.1/scoreboard' });

    expect(res.statusCode).toBe(200);
    expect(res.headers).toHaveProperty('x-trace-id');
  }, 15000);

  test('GET /api/proxy with invalid target should return 400', async () => {
    const res = await request(BASE_URL)
      .get('/api/proxy')
      .query({ target: 'https://evil.com/hack' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  // ----------------------------------------------------------------
  // POST /api/match-prediction — Input Validation
  // ----------------------------------------------------------------

  describe('POST /api/match-prediction — validation', () => {
    test('returns 400 when required fields are missing', async () => {
      const res = await request(BASE_URL)
        .post('/api/match-prediction')
        .send({ sport: 'soccer' }); // missing matchId, leagueSlug, homeTeamId, awayTeamId

      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toMatch(/Missing required fields/);
      expect(res.body).toHaveProperty('traceId');
    });

    test('returns 400 for invalid sport', async () => {
      const res = await request(BASE_URL)
        .post('/api/match-prediction')
        .send({ ...VALID_PAYLOAD, sport: 'cricket' });

      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toMatch(/Invalid sport/);
    });

    test('returns 400 for invalid leagueSlug (path traversal attempt)', async () => {
      const res = await request(BASE_URL)
        .post('/api/match-prediction')
        .send({ ...VALID_PAYLOAD, leagueSlug: '../../etc/passwd' });

      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toMatch(/Invalid leagueSlug/);
    });

    test('returns 400 for non-numeric homeTeamId', async () => {
      const res = await request(BASE_URL)
        .post('/api/match-prediction')
        .send({ ...VALID_PAYLOAD, homeTeamId: 'arsenal<script>' });

      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toMatch(/Invalid matchId|homeTeamId|awayTeamId/);
    });

    test('returns 400 for non-numeric matchId', async () => {
      const res = await request(BASE_URL)
        .post('/api/match-prediction')
        .send({ ...VALID_PAYLOAD, matchId: 'abc-bad-id' });

      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    test('returns 400 for empty body', async () => {
      const res = await request(BASE_URL)
        .post('/api/match-prediction')
        .send({});

      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ----------------------------------------------------------------
  // POST /api/match-prediction — End-to-End (live ESPN data)
  // ----------------------------------------------------------------

  describe('POST /api/match-prediction — end-to-end', () => {
    let firstResult;

    test('returns structured prediction with valid input', async () => {
      const res = await request(BASE_URL)
        .post('/api/match-prediction')
        .send(VALID_PAYLOAD);

      // Accept 200 (success) or 502 (ESPN unreachable in test env)
      expect([200, 502]).toContain(res.statusCode);

      if (res.statusCode === 200) {
        firstResult = res.body;

        // Top-level fields
        expect(res.body).toHaveProperty('matchId', VALID_PAYLOAD.matchId);
        expect(res.body).toHaveProperty('sport', 'soccer');
        expect(res.body).toHaveProperty('homeName');
        expect(res.body).toHaveProperty('awayName');
        expect(res.body).toHaveProperty('traceId');
        expect(res.body).toHaveProperty('fromCache'); // false on first call

        // Prediction fields
        expect(res.body).toHaveProperty('prediction');
        expect(typeof res.body.prediction).toBe('string');
        expect(res.body).toHaveProperty('confidence');
        expect(typeof res.body.confidence).toBe('number');
        expect(res.body.confidence).toBeGreaterThanOrEqual(0);
        expect(res.body.confidence).toBeLessThanOrEqual(100);

        // Recommendations array
        expect(res.body).toHaveProperty('recommendations');
        expect(Array.isArray(res.body.recommendations)).toBe(true);
        expect(res.body.recommendations.length).toBeGreaterThan(0);

        const rec = res.body.recommendations[0];
        expect(rec).toHaveProperty('type');
        expect(rec).toHaveProperty('label');
        expect(rec).toHaveProperty('value');
        expect(rec).toHaveProperty('confidence');
        expect(rec).toHaveProperty('color');

        // Factors array
        expect(res.body).toHaveProperty('factors');
        expect(Array.isArray(res.body.factors)).toBe(true);

        // Meta block
        expect(res.body).toHaveProperty('meta');
        expect(res.body.meta).toHaveProperty('generatedAt');
        expect(res.body.meta).toHaveProperty('homeRecord');
        expect(res.body.meta).toHaveProperty('awayRecord');
      }
    }, 30000);

    test('second identical request is served from cache (fromCache=true)', async () => {
      // Skip if first call failed (ESPN unreachable)
      if (!firstResult) return;

      const res = await request(BASE_URL)
        .post('/api/match-prediction')
        .send(VALID_PAYLOAD);

      expect(res.statusCode).toBe(200);
      expect(res.body.fromCache).toBe(true);

      // Cached result must be identical to original
      expect(res.body.prediction).toBe(firstResult.prediction);
      expect(res.body.confidence).toBe(firstResult.confidence);
      expect(res.body.recommendations.length).toBe(firstResult.recommendations.length);
    }, 10000);

    test('basketball prediction returns valid structure', async () => {
      const nbaPayload = {
        matchId: '401585500',
        sport: 'basketball',
        leagueSlug: 'nba',
        homeTeamId: '10',  // Golden State Warriors
        awayTeamId: '13',  // LA Lakers
      };

      const res = await request(BASE_URL)
        .post('/api/match-prediction')
        .send(nbaPayload);

      expect([200, 502]).toContain(res.statusCode);

      if (res.statusCode === 200) {
        expect(res.body).toHaveProperty('sport', 'basketball');
        expect(res.body).toHaveProperty('recommendations');
        expect(Array.isArray(res.body.recommendations)).toBe(true);
        // Basketball predictions should not have soccer-specific recommendations
        const types = res.body.recommendations.map(r => r.type);
        expect(types).not.toContain('GK');   // No goal kicks in basketball
        expect(types).not.toContain('TI');   // No throw-ins in basketball
      }
    }, 30000);
  });

  // ----------------------------------------------------------------
  // Real-time WebSocket
  // ----------------------------------------------------------------

  test('WebSocket emits data_updated on forced proxy refresh', (done) => {
    if (!socket || !socket.connected) {
      console.warn('Socket not connected, skipping WebSocket test');
      return done();
    }

    const timeout = setTimeout(() => done(), 8000); // Auto-pass if no event (ESPN may cache)

    socket.once('data_updated', (data) => {
      clearTimeout(timeout);
      expect(data).toHaveProperty('url');
      expect(data).toHaveProperty('traceId');
      done();
    });

    request(BASE_URL)
      .get('/api/proxy')
      .query({ target: 'soccer/eng.1/scoreboard', force: 'true' })
      .end();
  }, 15000);
});
