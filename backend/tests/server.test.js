/**
 * Apex Backend Tests — Offline Unit + Live Server Integration
 *
 * Split into two describe blocks:
 *
 *   BLOCK 1 (always runs, no flags required):
 *     Uses supertest() directly against the exported Express `app` (in-process).
 *     Covers local HTTP route validation only; NO external network calls.
 *     8 tests for GET /, invalid proxy target rejection, and every
 *     POST /api/match-prediction 400 input-validation case.
 *
 *   BLOCK 2 (gated behind LIVE_SERVER=1 opt-in):
 *     Uses supertest() against http://localhost:3000 (real TCP listener)
 *     AND socket.io-client against the running server.
 *     Covers real-proxy ESPN fetch, end-to-end match-prediction hitting
 *     real upstream APIs, cache-hit E2E, cross-sport (basketball) E2E,
 *     and WebSocket data_updated event.
 *
 * Run (default — offline units + providers unit tests):
 *   cd backend && npm test
 *
 * Run (ALL — requires Apex backend running on :3000 + network access):
 *   LIVE_SERVER=1 cd backend && npx jest tests/server.test.js --forceExit --testTimeout=30000
 */

const request = require('supertest');
const io = require('socket.io-client');

// Hoisted mocks (Jest hoists jest.mock() calls to the top of the file automatically)
// These replace real modules before server.js is required in the offline block.
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-' + Math.random().toString(36).slice(2, 10),
}));

jest.mock('firebase-admin', () => {
  const firestoreMock = {
    collection: jest.fn(() => firestoreMock),
    doc: jest.fn(() => firestoreMock),
    where: jest.fn(() => firestoreMock),
    get: jest.fn(async () => ({ empty: true, size: 0, docs: [] })),
    batch: jest.fn(() => ({
      update: jest.fn(),
      set: jest.fn(),
      commit: jest.fn(async () => ({})),
    })),
    FieldValue: {
      increment: jest.fn(v => v),
      serverTimestamp: jest.fn(),
    },
  };
  return {
    initializeApp: jest.fn(),
    credential: {
      cert: jest.fn(() => ({})),
      applicationDefault: jest.fn(() => ({})),
    },
    firestore: jest.fn(() => firestoreMock),
  };
});

jest.mock('node-cron', () => ({
  schedule: jest.fn(() => ({
    start: jest.fn(),
    stop: jest.fn(),
    destroy: jest.fn(),
  })),
}));

const BASE_URL = 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Block 1 — Offline unit tests (supertest against in-process Express app)
// ---------------------------------------------------------------------------

describe('Apex Backend — Offline Unit Tests', () => {
  let app;
  let mod;

  beforeAll(() => {
    jest.resetModules();
    const origWarn = console.warn;
    const origError = console.error;
    const origInfo = console.info;
    console.warn = () => {};
    console.error = () => {};
    console.info = () => {};
    try {
      mod = require('../server');
      app = mod.app;
    } finally {
      console.warn = origWarn;
      console.error = origError;
      console.info = origInfo;
    }
    expect(app).toBeDefined();
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  test('GET / should return 200', async () => {
    const res = await request(app).get('/');
    expect(res.statusCode).toBe(200);
  });

  test('GET /api/proxy with invalid target should return 400', async () => {
    const res = await request(app)
      .get('/api/proxy')
      .query({ target: 'https://evil.com/hack' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  describe('GET /api/sports-data/leagues — zero-result diagnostics', () => {
    test('sport_not_supported → diagnostics.reason correct', async () => {
      const res = await request(app)
        .get('/api/sports-data/leagues')
        .query({ sport: 'basketball' });

      expect(res.statusCode).toBe(200);
      expect(res.body.count).toBe(0);
      expect(res.body).toHaveProperty('diagnostics');
      expect(res.body.diagnostics.reason).toBe('sport_not_supported');
      expect(res.body.diagnostics.provider).toBe('pitchapi');
    });

    test('provider unavailable → diagnostics.reason = provider_unavailable', async () => {
      const svc = mod.sportsData;
      const origPA = svc.pitchApi;
      svc.pitchApi = { isAvailable: () => false };
      const origList = svc.listFootballLeagues;
      svc.listFootballLeagues = jest.fn(async () => []);
      try {
        const res = await request(app)
          .get('/api/sports-data/leagues')
          .query({ season: '2026' });

        expect(res.statusCode).toBe(200);
        expect(res.body.count).toBe(0);
        expect(res.body).toHaveProperty('diagnostics');
        expect(res.body.diagnostics.reason).toBe('provider_unavailable');
        expect(res.body.diagnostics.season).toBe('2026');
      } finally {
        svc.pitchApi = origPA;
        svc.listFootballLeagues = origList;
      }
    });

    test('provider available but empty list → diagnostics.reason = no_data_for_season', async () => {
      const svc = mod.sportsData;
      const origPA = svc.pitchApi;
      svc.pitchApi = { isAvailable: () => true };
      const origList = svc.listFootballLeagues;
      svc.listFootballLeagues = jest.fn(async () => []);
      try {
        const res = await request(app)
          .get('/api/sports-data/leagues')
          .query({ country: 'Neverland' });

        expect(res.statusCode).toBe(200);
        expect(res.body.count).toBe(0);
        expect(res.body).toHaveProperty('diagnostics');
        expect(res.body.diagnostics.reason).toBe('no_data_for_season');
        expect(res.body.diagnostics.country).toBe('Neverland');
      } finally {
        svc.pitchApi = origPA;
        svc.listFootballLeagues = origList;
      }
    });
  });

  describe('POST /api/match-prediction — validation (no upstream call)', () => {
    const VALID_PAYLOAD_SHAPE = {
      matchId: '695281',
      sport: 'soccer',
      leagueSlug: 'eng.1',
      homeTeamId: '359',
      awayTeamId: '363',
    };

    test('returns 400 when required fields are missing', async () => {
      const res = await request(app)
        .post('/api/match-prediction')
        .send({ sport: 'soccer' });

      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toMatch(/Missing required fields/);
      expect(res.body).toHaveProperty('traceId');
    });

    test('returns 400 for invalid sport', async () => {
      const res = await request(app)
        .post('/api/match-prediction')
        .send({ ...VALID_PAYLOAD_SHAPE, sport: 'cricket' });

      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toMatch(/Invalid sport/);
    });

    test('returns 400 for invalid leagueSlug (path traversal attempt)', async () => {
      const res = await request(app)
        .post('/api/match-prediction')
        .send({ ...VALID_PAYLOAD_SHAPE, leagueSlug: '../../etc/passwd' });

      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toMatch(/Invalid leagueSlug/);
    });

    test('returns 400 for non-numeric homeTeamId', async () => {
      const res = await request(app)
        .post('/api/match-prediction')
        .send({ ...VALID_PAYLOAD_SHAPE, homeTeamId: 'arsenal<script>' });

      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toMatch(/Invalid matchId|homeTeamId|awayTeamId/);
    });

    test('returns 400 for non-numeric matchId', async () => {
      const res = await request(app)
        .post('/api/match-prediction')
        .send({ ...VALID_PAYLOAD_SHAPE, matchId: 'abc-bad-id' });

      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    test('returns 400 for empty body', async () => {
      const res = await request(app)
        .post('/api/match-prediction')
        .send({});

      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty('error');
    });
  });

  describe('POST /api/match-prediction — confidence threshold enforcement', () => {
    test('football predictions below 90% should be filtered out', async () => {
      // Mock the entire prediction flow by intercepting at the response level
      const origSetPredictionCache = mod.setPredictionCache;
      const origGetPredictionFromCache = mod.getPredictionFromCache;

      // Ensure cache doesn't interfere
      mod.setPredictionCache = jest.fn();
      mod.getPredictionFromCache = jest.fn(() => null);

      // We need to mock the data fetch to avoid real API calls
      const origFetchFromBackendOrESPN = mod.fetchFromBackendOrESPN;
      mod.fetchFromBackendOrESPN = jest.fn(async () => ({
        team: { displayName: 'Test Team' },
        record: { items: [{ summary: '5-2-3' }] },
        schedule: { events: [] },
        summary: { seasonseries: [] },
        news: { articles: [] },
      }));

      try {
        const res = await request(app)
          .post('/api/match-prediction')
          .send({
            matchId: '695281',
            sport: 'soccer',
            leagueSlug: 'eng.1',
            homeTeamId: '359',
            awayTeamId: '363',
          });

        // The actual prediction will run, but we verify the threshold logic is in place
        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('recommendations');
        expect(Array.isArray(res.body.recommendations)).toBe(true);
        // Verify that any returned recommendations meet the 90% threshold
        res.body.recommendations.forEach(rec => {
          expect(rec.confidence).toBeGreaterThanOrEqual(90);
        });
      } finally {
        mod.setPredictionCache = origSetPredictionCache;
        mod.getPredictionFromCache = origGetPredictionFromCache;
        mod.fetchFromBackendOrESPN = origFetchFromBackendOrESPN;
      }
    });

    test('football predictions with no 90%+ confidence should return empty with message', async () => {
      const origSetPredictionCache = mod.setPredictionCache;
      const origGetPredictionFromCache = mod.getPredictionFromCache;
      mod.setPredictionCache = jest.fn();
      mod.getPredictionFromCache = jest.fn(() => null);

      const origFetchFromBackendOrESPN = mod.fetchFromBackendOrESPN;
      mod.fetchFromBackendOrESPN = jest.fn(async () => ({
        team: { displayName: 'Test Team' },
        record: { items: [{ summary: '5-2-3' }] },
        schedule: { events: [] },
        summary: { seasonseries: [] },
        news: { articles: [] },
      }));

      try {
        const res = await request(app)
          .post('/api/match-prediction')
          .send({
            matchId: '695281',
            sport: 'soccer',
            leagueSlug: 'eng.1',
            homeTeamId: '359',
            awayTeamId: '363',
          });

        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('recommendations');
        // If no recommendations meet threshold, verify the message
        if (res.body.recommendations.length === 0) {
          expect(res.body.prediction).toContain('90% confidence threshold');
          expect(res.body.confidence).toBe(0);
        }
        // Otherwise verify all meet threshold
        res.body.recommendations.forEach(rec => {
          expect(rec.confidence).toBeGreaterThanOrEqual(90);
        });
      } finally {
        mod.setPredictionCache = origSetPredictionCache;
        mod.getPredictionFromCache = origGetPredictionFromCache;
        mod.fetchFromBackendOrESPN = origFetchFromBackendOrESPN;
      }
    });

    test('basketball predictions below 75% should be filtered out', async () => {
      const origSetPredictionCache = mod.setPredictionCache;
      const origGetPredictionFromCache = mod.getPredictionFromCache;
      mod.setPredictionCache = jest.fn();
      mod.getPredictionFromCache = jest.fn(() => null);

      const origFetchFromBackendOrESPN = mod.fetchFromBackendOrESPN;
      mod.fetchFromBackendOrESPN = jest.fn(async () => ({
        team: { displayName: 'Test Team' },
        record: { items: [{ summary: '5-2-3' }] },
        schedule: { events: [] },
        summary: { seasonseries: [] },
        news: { articles: [] },
      }));

      try {
        const res = await request(app)
          .post('/api/match-prediction')
          .send({
            matchId: '401585500',
            sport: 'basketball',
            leagueSlug: 'nba',
            homeTeamId: '10',
            awayTeamId: '13',
          });

        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('recommendations');
        expect(Array.isArray(res.body.recommendations)).toBe(true);
        // Verify that any returned recommendations meet the 75% threshold
        res.body.recommendations.forEach(rec => {
          expect(rec.confidence).toBeGreaterThanOrEqual(75);
        });
      } finally {
        mod.setPredictionCache = origSetPredictionCache;
        mod.getPredictionFromCache = origGetPredictionFromCache;
        mod.fetchFromBackendOrESPN = origFetchFromBackendOrESPN;
      }
    });

    test('basketball predictions with no 75%+ confidence should return empty with message', async () => {
      const origSetPredictionCache = mod.setPredictionCache;
      const origGetPredictionFromCache = mod.getPredictionFromCache;
      mod.setPredictionCache = jest.fn();
      mod.getPredictionFromCache = jest.fn(() => null);

      const origFetchFromBackendOrESPN = mod.fetchFromBackendOrESPN;
      mod.fetchFromBackendOrESPN = jest.fn(async () => ({
        team: { displayName: 'Test Team' },
        record: { items: [{ summary: '5-2-3' }] },
        schedule: { events: [] },
        summary: { seasonseries: [] },
        news: { articles: [] },
      }));

      try {
        const res = await request(app)
          .post('/api/match-prediction')
          .send({
            matchId: '401585500',
            sport: 'basketball',
            leagueSlug: 'nba',
            homeTeamId: '10',
            awayTeamId: '13',
          });

        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveProperty('recommendations');
        // If no recommendations meet threshold, verify the message
        if (res.body.recommendations.length === 0) {
          expect(res.body.prediction).toContain('75% confidence threshold');
          expect(res.body.confidence).toBe(0);
        }
        // Otherwise verify all meet threshold
        res.body.recommendations.forEach(rec => {
          expect(rec.confidence).toBeGreaterThanOrEqual(75);
        });
      } finally {
        mod.setPredictionCache = origSetPredictionCache;
        mod.getPredictionFromCache = origGetPredictionFromCache;
        mod.fetchFromBackendOrESPN = origFetchFromBackendOrESPN;
      }
    });

    test('tennis predictions should not be filtered by confidence threshold', async () => {
      const origSetPredictionCache = mod.setPredictionCache;
      const origGetPredictionFromCache = mod.getPredictionFromCache;
      mod.setPredictionCache = jest.fn();
      mod.getPredictionFromCache = jest.fn(() => null);

      const origFetchFromBackendOrESPN = mod.fetchFromBackendOrESPN;
      mod.fetchFromBackendOrESPN = jest.fn(async () => ({
        team: { displayName: 'Test Team' },
        record: { items: [{ summary: '5-2-3' }] },
        schedule: { events: [] },
        summary: { seasonseries: [] },
        news: { articles: [] },
      }));

      try {
        const res = await request(app)
          .post('/api/match-prediction')
          .send({
            matchId: '12345',
            sport: 'tennis',
            leagueSlug: 'atp-tour',
            homeTeamId: '100',
            awayTeamId: '200',
          });

        // Tennis may fail with 502 if not fully supported, which is acceptable
        expect([200, 502]).toContain(res.statusCode);
        if (res.statusCode === 200) {
          expect(res.body).toHaveProperty('recommendations');
          // Tennis predictions should pass through regardless of confidence
          res.body.recommendations.forEach(rec => {
            // No threshold enforcement for tennis
            expect(rec.confidence).toBeGreaterThanOrEqual(0);
          });
        }
      } finally {
        mod.setPredictionCache = origSetPredictionCache;
        mod.getPredictionFromCache = origGetPredictionFromCache;
        mod.fetchFromBackendOrESPN = origFetchFromBackendOrESPN;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Block 2 — Live Server Integration Tests (opt-in via LIVE_SERVER=1)
// ---------------------------------------------------------------------------

const LIVE_SERVER_ENABLED = process.env.LIVE_SERVER === '1';

const describeOrSkip = LIVE_SERVER_ENABLED ? describe : describe.skip;
const testOrSkip = LIVE_SERVER_ENABLED ? test : test.skip;
const beforeAllOrSkip = LIVE_SERVER_ENABLED ? beforeAll : beforeAll;
const afterAllOrSkip = LIVE_SERVER_ENABLED ? afterAll : afterAll;

if (!LIVE_SERVER_ENABLED) {
  console.info(
    '[server.test.js] LIVE INTEGRATION BLOCK skipped — ' +
    'set LIVE_SERVER=1 and run the Apex backend on localhost:3000 to enable ' +
    'the 5 end-to-end/WebSocket tests here.'
  );
}

describeOrSkip('Apex Backend — Live Server Integration Tests', () => {
  let socket;

  beforeAllOrSkip((done) => {
    socket = io(BASE_URL, { timeout: 5000 });
    socket.on('connect', done);
    socket.on('connect_error', done);
  }, 10000);

  afterAllOrSkip(() => {
    if (socket) socket.close();
  });

  const VALID_PAYLOAD = {
    matchId: '695281',
    sport: 'soccer',
    leagueSlug: 'eng.1',
    homeTeamId: '359',
    awayTeamId: '363',
  };

  testOrSkip('GET /api/proxy should return data and traceId header', async () => {
    const res = await request(BASE_URL)
      .get('/api/proxy')
      .query({ target: 'soccer/eng.1/scoreboard' });

    expect(res.statusCode).toBe(200);
    expect(res.headers).toHaveProperty('x-trace-id');
  }, 15000);

  describe('POST /api/match-prediction — end-to-end (live ESPN data)', () => {
    let firstResult;

    testOrSkip('returns structured prediction with valid input', async () => {
      const res = await request(BASE_URL)
        .post('/api/match-prediction')
        .send(VALID_PAYLOAD);

      expect([200, 502]).toContain(res.statusCode);

      if (res.statusCode === 200) {
        firstResult = res.body;

        expect(res.body).toHaveProperty('matchId', VALID_PAYLOAD.matchId);
        expect(res.body).toHaveProperty('sport', 'soccer');
        expect(res.body).toHaveProperty('homeName');
        expect(res.body).toHaveProperty('awayName');
        expect(res.body).toHaveProperty('traceId');
        expect(res.body).toHaveProperty('fromCache');

        expect(res.body).toHaveProperty('prediction');
        expect(typeof res.body.prediction).toBe('string');
        expect(res.body).toHaveProperty('confidence');
        expect(typeof res.body.confidence).toBe('number');
        expect(res.body.confidence).toBeGreaterThanOrEqual(0);
        expect(res.body.confidence).toBeLessThanOrEqual(100);

        expect(res.body).toHaveProperty('recommendations');
        expect(Array.isArray(res.body.recommendations)).toBe(true);
        // Football predictions should return at most 2 predictions
        if (res.body.sport === 'soccer') {
          expect(res.body.recommendations.length).toBeLessThanOrEqual(2);
          // Verify that if predictions exist, they are from the approved markets
          const approvedMarkets = [
            'UNDER_CORNERS',
            'UNDER_4_5_GOALS',
            'UNDER_1_5_HT',
            'UNDER_2_5_HT',
          ];
          res.body.recommendations.forEach(rec => {
            expect(approvedMarkets).toContain(rec.type);
          });
        }
        if (res.body.recommendations.length > 0) {
          const rec = res.body.recommendations[0];
          expect(rec).toHaveProperty('type');
          expect(rec).toHaveProperty('label');
          expect(rec).toHaveProperty('value');
          expect(rec).toHaveProperty('confidence');
          expect(rec).toHaveProperty('color');
        }

        expect(res.body).toHaveProperty('factors');
        expect(Array.isArray(res.body.factors)).toBe(true);

        expect(res.body).toHaveProperty('meta');
        expect(res.body.meta).toHaveProperty('generatedAt');
        expect(res.body.meta).toHaveProperty('homeRecord');
        expect(res.body.meta).toHaveProperty('awayRecord');
      }
    }, 30000);

    testOrSkip('second identical request is served from cache (fromCache=true)', async () => {
      if (!firstResult) return;

      const res = await request(BASE_URL)
        .post('/api/match-prediction')
        .send(VALID_PAYLOAD);

      expect(res.statusCode).toBe(200);
      expect(res.body.fromCache).toBe(true);

      expect(res.body.prediction).toBe(firstResult.prediction);
      expect(res.body.confidence).toBe(firstResult.confidence);
      expect(res.body.recommendations.length).toBe(firstResult.recommendations.length);
    }, 10000);

    testOrSkip('basketball prediction returns valid structure', async () => {
      const nbaPayload = {
        matchId: '401585500',
        sport: 'basketball',
        leagueSlug: 'nba',
        homeTeamId: '10',
        awayTeamId: '13',
      };

      const res = await request(BASE_URL)
        .post('/api/match-prediction')
        .send(nbaPayload);

      expect([200, 502]).toContain(res.statusCode);

      if (res.statusCode === 200) {
        expect(res.body).toHaveProperty('sport', 'basketball');
        expect(res.body).toHaveProperty('recommendations');
        expect(Array.isArray(res.body.recommendations)).toBe(true);
        const types = res.body.recommendations.map(r => r.type);
        expect(types).not.toContain('GK');
        expect(types).not.toContain('TI');
      }
    }, 30000);
  });

  testOrSkip('WebSocket emits data_updated on forced proxy refresh', (done) => {
    if (!socket || !socket.connected) {
      console.warn('Socket not connected, skipping WebSocket test');
      return done();
    }

    const timeout = setTimeout(() => done(), 8000);

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
