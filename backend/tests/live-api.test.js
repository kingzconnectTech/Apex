/**
 * Phase 6 — live analysis HTTP surface.
 *
 * The router is exercised with a stubbed matcher (no network), so the focus is
 * the contract the app depends on: the documented keys, the honest refusal when
 * the ship gate has not passed, the manual-entry fallback, and the secret-gated
 * counters. Nothing here reaches a provider.
 */

const express = require('express');
const request = require('supertest');

const CONFIG = require('../services/live/config');
const stats = require('../services/live/stats');
const policy = require('../services/live/policy');
const { createLiveRouter, DISCLAIMER } = require('../routes/live');

const LINK = 'https://example.com/football/premier-league/manchester-united-vs-chelsea';

/** A normalised fixture, shaped exactly like providers/normalizer output. */
function fixture({
  id = '900', sport = 'soccer', league = 'eng.1', status = 'live',
  clock = "34'", period = 1, homeScore = 1, awayScore = 0,
} = {}) {
  return {
    sport,
    league: { id: league, sourceId: league, name: 'League', slug: league },
    fixture: {
      id: String(id), sourceId: String(id), date: '2026-10-26T17:30:00.000Z',
      timestamp: Date.parse('2026-10-26T17:30:00Z'), status, rawStatus: null,
      clock, period, venue: null,
    },
    homeTeam: { id: 'h', sourceId: 'h', name: 'Manchester United', logo: null, score: homeScore, record: null, form: null },
    awayTeam: { id: 'a', sourceId: 'a', name: 'Chelsea', logo: null, score: awayScore, record: null, form: null },
    source: 'espn',
    providerIds: { espn: String(id) },
  };
}

function candidate(opts = {}, over = {}) {
  return {
    source: 'espn',
    fixture: fixture(opts),
    match_confidence: 0.9,
    orientation: 'direct',
    home_similarity: 1,
    away_similarity: 1,
    match_notes: [],
    ...over,
  };
}

function buildApp({ matcher = null, rateLimitMiddleware = null, manualRateLimitMiddleware = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api', createLiveRouter({
    matcher, rateLimitMiddleware, manualRateLimitMiddleware, logger: null,
  }));
  return app;
}

beforeEach(() => {
  stats.reset();
  delete process.env.LIVE_STATS_SECRET;
});

describe('GET /api/live/capabilities', () => {
  test('reports the feature switches, supported sports and refresh hints', async () => {
    const res = await request(buildApp()).get('/api/live/capabilities');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      enabled: true,
      supported_sports: ['soccer', 'basketball'],
      shipping: [],
      manual_entry: true,
      disclaimer: DISCLAIMER,
    }));
    expect(res.body.refresh).toEqual(CONFIG.liveApi.refresh);
    expect(res.body.sports).toEqual({ soccer: true, basketball: true });
    // Phase 9/10 hold: basketball (a candidate awaiting 500 fresh games) and
    // soccer (its frozen candidates are observed) are shadowed; neither ships.
    expect(res.body.shadow).toEqual(['basketball', 'soccer']);
    expect(res.body.rollout).toEqual({ testers_only: true, sports: {} });
  });
});

describe('POST /api/live/resolve', () => {
  test('a missing link is a 400 with a machine-readable code', async () => {
    const res = await request(buildApp({ matcher: { resolveGame: jest.fn() } }))
      .post('/api/live/resolve').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LINK');
  });

  test('an unrecognised link asks for manual entry instead of failing', async () => {
    const res = await request(buildApp({ matcher: { resolveGame: jest.fn() } }))
      .post('/api/live/resolve').send({ link: 'https://example.com/' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('none');
    expect(res.body.manual_entry_required).toBe(true);
    expect(res.body.parsed.recognised).toBe(false);
  });

  test('a matched link returns the game and an analysis with figures withheld', async () => {
    const matcher = {
      resolveGame: jest.fn().mockResolvedValue({
        status: 'matched', source: 'espn', reason: null,
        candidates: [candidate()], manual_entry_required: false,
        stats: { fixtures_considered: 1 },
      }),
      refreshCandidate: jest.fn().mockResolvedValue(null),
    };

    const res = await request(buildApp({ matcher }))
      .post('/api/live/resolve').send({ link: LINK });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('matched');
    expect(res.body.parsed).toEqual(expect.objectContaining({ recognised: true, sport: 'soccer' }));
    expect(res.body.game.game_id).toBe('espn:900');
    expect(res.body.game.home.name).toBe('Manchester United');

    const a = res.body.analysis;
    expect(a.ship_gate.decision).toBe('withheld');
    expect(a.display.mode).toBe('context_only');
    expect(a.probabilities).toBeNull();
    expect(a.projection).toBeNull();
    expect(a.uncertainty).toBeNull();
    expect(a.disclaimer).toBe(DISCLAIMER);

    // The resolved game can now be polled without resolving again.
    const poll = await request(buildApp({ matcher })).get('/api/live/analysis/espn:900');
    expect(poll.status).toBe(200);
    expect(poll.body.game_id).toBe('espn:900');
  });

  test('an ambiguous link returns candidates for confirmation', async () => {
    const matcher = {
      resolveGame: jest.fn().mockResolvedValue({
        status: 'candidates', source: 'espn', reason: 'several plausible fixtures',
        candidates: [candidate({ id: '900' }), candidate({ id: '901' })],
        manual_entry_required: false, stats: {},
      }),
    };

    const res = await request(buildApp({ matcher }))
      .post('/api/live/resolve').send({ link: LINK });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('candidates');
    expect(res.body.candidates).toHaveLength(2);
    expect(res.body.candidates.map(g => g.game_id)).toEqual(['espn:900', 'espn:901']);
    expect(res.body.manual_entry_required).toBe(false);
  });

  test('a feature switched off globally is a 503, and the provider is never called', async () => {
    const resolveGame = jest.fn();
    const original = CONFIG.live.enabled;
    CONFIG.live.enabled = false;
    try {
      const res = await request(buildApp({ matcher: { resolveGame } }))
        .post('/api/live/resolve').send({ link: LINK });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('FEATURE_DISABLED');
      expect(resolveGame).not.toHaveBeenCalled();
    } finally {
      CONFIG.live.enabled = original;
    }
  });
});

describe('GET /api/live/analysis/:gameId', () => {
  test('an untracked game is a 404 with a clear code', async () => {
    const res = await request(buildApp({ matcher: {} })).get('/api/live/analysis/espn:404');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('GAME_NOT_RESOLVED');
  });

  test('a resolved game exposes only facts while the gate is closed', async () => {
    const matcher = {
      resolveGame: jest.fn().mockResolvedValue({
        status: 'matched', source: 'espn', candidates: [candidate()],
        manual_entry_required: false, stats: {},
      }),
      refreshCandidate: jest.fn().mockResolvedValue(null),
    };
    const app = buildApp({ matcher });
    await request(app).post('/api/live/resolve').send({ link: LINK });

    const res = await request(app).get('/api/live/analysis/espn:900');
    expect(res.status).toBe(200);
    expect(res.body.display.shows_probabilities).toBe(false);
    expect(res.body.probabilities).toBeNull();
    expect(res.body.factors.length).toBeGreaterThan(0);
    expect(res.body.freshness).toBeDefined();
  });
});

describe('POST /api/live/manual', () => {
  test('invalid values return every problem at once', async () => {
    const res = await request(buildApp({ matcher: {} }))
      .post('/api/live/manual').send({ sport: 'soccer' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MANUAL_ENTRY');
    expect(res.body.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/home team name/i),
      expect.stringMatching(/away team name/i),
      expect.stringMatching(/home score/i),
    ]));
  });

  test('a valid manual entry returns a labelled, context-only analysis', async () => {
    const res = await request(buildApp({ matcher: {} }))
      .post('/api/live/manual')
      .send({
        sport: 'soccer', home_name: 'Arsenal', away_name: 'Liverpool',
        home_score: 1, away_score: 1, clock: "60'", period: 2, status: 'live',
      });
    expect(res.status).toBe(200);
    expect(res.body.manual).toBe(true);
    expect(res.body.data_tier).toBe('user_entered');
    expect(res.body.display.mode).toBe('context_only');
    expect(res.body.probabilities).toBeNull();
    expect(res.body.factors.map(f => f.label)).toContain('Unverified input');
  });

  test('a hand-typed game always carries the permanent badge in the payload', async () => {
    const res = await request(buildApp({ matcher: {} }))
      .post('/api/live/manual')
      .send({
        sport: 'basketball', home_name: 'Lakers', away_name: 'Celtics',
        home_score: 88, away_score: 91, clock: '7:24', period: 3, status: 'live',
      });
    expect(res.status).toBe(200);
    expect(res.body.manual).toBe(true);
    expect(res.body.manual_badge).toBe(CONFIG.liveApi.manualBadge);
    expect(res.body.manual_badge_detail).toBe(CONFIG.liveApi.manualDisclaimer);
  });

  test('manual entry switched off is a 503 with its own code, and nothing is served', async () => {
    const original = CONFIG.live.manualEntry;
    CONFIG.live.manualEntry = false;
    try {
      const res = await request(buildApp({ matcher: {} }))
        .post('/api/live/manual')
        .send({
          sport: 'soccer', home_name: 'Arsenal', away_name: 'Liverpool',
          home_score: 0, away_score: 0, clock: "10'", period: 1, status: 'live',
        });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('MANUAL_ENTRY_DISABLED');
      expect(res.body.manual).toBeUndefined();
    } finally {
      CONFIG.live.manualEntry = original;
    }
  });

  test('the manual route uses its own, stricter injected limiter', async () => {
    const { createRateLimitMiddleware, createRateLimiter } = require('../services/live/rateLimit');
    let limited = 0;
    const manualRateLimitMiddleware = createRateLimitMiddleware({
      ipLimiter: createRateLimiter({ windowMs: 60_000, max: 1, now: () => 0 }),
      userLimiter: createRateLimiter({ windowMs: 60_000, max: 1, now: () => 0 }),
      onLimited: () => { limited += 1; },
    });
    const app = buildApp({ matcher: {}, manualRateLimitMiddleware });
    const body = {
      sport: 'soccer', home_name: 'Arsenal', away_name: 'Liverpool',
      home_score: 0, away_score: 0, clock: "10'", period: 1, status: 'live',
    };

    const first = await request(app).post('/api/live/manual').send(body);
    expect(first.status).toBe(200);

    const blocked = await request(app).post('/api/live/manual').send(body);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(limited).toBe(1);
  });
});

describe('feature flags are independent, and each is enforced', () => {
  const manualBody = {
    sport: 'soccer', home_name: 'Arsenal', away_name: 'Liverpool',
    home_score: 0, away_score: 0, clock: "10'", period: 1, status: 'live',
  };

  test('per-sport off degrades that sport to context only on the link path', async () => {
    const matcher = {
      resolveGame: jest.fn().mockResolvedValue({
        status: 'matched', source: 'espn', candidates: [candidate()],
        manual_entry_required: false, stats: {},
      }),
      refreshCandidate: jest.fn().mockResolvedValue(null),
    };
    const original = CONFIG.live.sports.soccer;
    CONFIG.live.sports.soccer = false;
    try {
      const res = await request(buildApp({ matcher }))
        .post('/api/live/resolve').send({ link: LINK });
      expect(res.status).toBe(200);
      expect(res.body.analysis.display.mode).toBe('context_only');
      expect(res.body.analysis.probabilities).toBeNull();
      expect(res.body.analysis.ship_gate.reason).toMatch(/switched off for soccer/i);
    } finally {
      CONFIG.live.sports.soccer = original;
    }
  });

  test('per-sport off degrades that sport to context only on the manual path', async () => {
    const original = CONFIG.live.sports.soccer;
    CONFIG.live.sports.soccer = false;
    try {
      const res = await request(buildApp({ matcher: {} }))
        .post('/api/live/manual').send(manualBody);
      expect(res.status).toBe(200);
      expect(res.body.display.mode).toBe('context_only');
      expect(res.body.probabilities).toBeNull();
    } finally {
      CONFIG.live.sports.soccer = original;
    }
  });

  test('globally off refuses the manual path first, with FEATURE_DISABLED', async () => {
    const original = CONFIG.live.enabled;
    CONFIG.live.enabled = false;
    try {
      const res = await request(buildApp({ matcher: {} }))
        .post('/api/live/manual').send(manualBody);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('FEATURE_DISABLED');
    } finally {
      CONFIG.live.enabled = original;
    }
  });
});

describe('GET /api/live/stats', () => {
  test('is open when no secret is configured and returns the counters', async () => {
    const res = await request(buildApp({ matcher: {} })).get('/api/live/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      resolve_total: expect.any(Number),
      by_domain: expect.any(Object),
      disclaimer: DISCLAIMER,
    }));
  });

  test('requires the secret header once one is configured', async () => {
    process.env.LIVE_STATS_SECRET = 'sekret';
    const app = buildApp({ matcher: {} });

    const denied = await request(app).get('/api/live/stats');
    expect(denied.status).toBe(401);

    const allowed = await request(app).get('/api/live/stats').set('x-live-stats-secret', 'sekret');
    expect(allowed.status).toBe(200);
  });

  test('surfaces the Phase 9 calibrator and the shadow hold, without a number', async () => {
    const res = await request(buildApp({ matcher: {} })).get('/api/live/stats');
    expect(res.status).toBe(200);
    // The served calibrator column, described — never a coefficient value.
    expect(res.body.calibrator).toEqual(expect.objectContaining({
      enabled: true, market: 'home_win',
    }));
    // A held sport has a SHADOW verdict and never a served one.
    expect(res.body.forward_test.verdicts).toEqual({});
    expect(res.body.forward_test.shadow).toEqual(expect.objectContaining({
      basketball: expect.objectContaining({
        shadow: true, sport: 'basketball', ready: expect.any(Boolean),
      }),
    }));
  });

  test('surfaces the confirmation dataset and the rollout progress', async () => {
    const res = await request(buildApp({ matcher: {} })).get('/api/live/stats');
    expect(res.status).toBe(200);
    // Only rows logged after the freeze count, and the one-shot run waits for
    // the ship gate's 500 settled GAMES per sport.
    expect(res.body.forward_test.confirmation).toEqual(expect.objectContaining({
      basketball: expect.objectContaining({
        dataset: expect.any(String),
        min_settled_games: 500,
        settled_games: expect.any(Number),
        evaluated: false,
      }),
    }));
    // Settled GAMES per sport and per league, with an ETA toward the 500 target.
    expect(res.body.forward_test.progress).toEqual(expect.objectContaining({
      target: 500,
      per_sport: expect.any(Object),
      per_league: expect.any(Object),
    }));
  });
});

describe('rate limiting is wired onto the expensive routes', () => {
  test('resolve sets the X-RateLimit-Remaining header', async () => {
    const matcher = { resolveGame: jest.fn().mockResolvedValue({ status: 'none', candidates: [], reason: 'no', stats: {} }) };
    const res = await request(buildApp({ matcher }))
      .post('/api/live/resolve').send({ link: LINK });
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });

  test('a strict injected limiter produces a 429 with Retry-After', async () => {
    const { createRateLimitMiddleware, createRateLimiter } = require('../services/live/rateLimit');
    const rateLimitMiddleware = createRateLimitMiddleware({
      ipLimiter: createRateLimiter({ windowMs: 60_000, max: 1, now: () => 0 }),
      userLimiter: createRateLimiter({ windowMs: 60_000, max: 1, now: () => 0 }),
    });
    const matcher = { resolveGame: jest.fn().mockResolvedValue({ status: 'none', candidates: [], reason: 'no', stats: {} }) };
    const app = buildApp({ matcher, rateLimitMiddleware });

    await request(app).post('/api/live/resolve').send({ link: LINK });
    const blocked = await request(app).post('/api/live/resolve').send({ link: LINK });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  test('the analysis route is limited per IP', async () => {
    const { createRateLimitMiddleware, createRateLimiter } = require('../services/live/rateLimit');
    const rateLimitMiddleware = createRateLimitMiddleware({
      ipLimiter: createRateLimiter({ windowMs: 60_000, max: 1, now: () => 0 }),
      userLimiter: createRateLimiter({ windowMs: 60_000, max: 100, now: () => 0 }),
    });
    const app = buildApp({ matcher: {}, rateLimitMiddleware });

    const first = await request(app).get('/api/live/analysis/espn:900');
    expect(first.status).not.toBe(429); // allowed through the limiter

    const blocked = await request(app).get('/api/live/analysis/espn:900');
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
  });

  test('resolve is limited per user even across different IPs', async () => {
    const { createRateLimitMiddleware, createRateLimiter } = require('../services/live/rateLimit');
    const rateLimitMiddleware = createRateLimitMiddleware({
      ipLimiter: createRateLimiter({ windowMs: 60_000, max: 100, now: () => 0 }),
      userLimiter: createRateLimiter({ windowMs: 60_000, max: 1, now: () => 0 }),
    });
    const matcher = { resolveGame: jest.fn().mockResolvedValue({ status: 'none', candidates: [], reason: 'no', stats: {} }) };
    const app = buildApp({ matcher, rateLimitMiddleware });

    const a = await request(app).post('/api/live/resolve')
      .set('x-user-id', 'u1').set('x-forwarded-for', '1.1.1.1').send({ link: LINK });
    expect(a.status).toBe(200);

    const b = await request(app).post('/api/live/resolve')
      .set('x-user-id', 'u1').set('x-forwarded-for', '2.2.2.2').send({ link: LINK });
    expect(b.status).toBe(429);
    expect(b.body.code).toBe('RATE_LIMITED');

    // A different user on a fresh IP is unaffected.
    const c = await request(app).post('/api/live/resolve')
      .set('x-user-id', 'u2').set('x-forwarded-for', '3.3.3.3').send({ link: LINK });
    expect(c.status).toBe(200);
  });
});

describe('stats are recorded from real requests', () => {
  test('a resolve increments the counters and a refusal is counted', async () => {
    const matcher = {
      resolveGame: jest.fn().mockResolvedValue({
        status: 'matched', source: 'espn', candidates: [candidate()],
        manual_entry_required: false, stats: {},
      }),
      refreshCandidate: jest.fn().mockResolvedValue(null),
    };
    const app = buildApp({ matcher });
    await request(app).post('/api/live/resolve').send({ link: LINK });
    await request(app).get('/api/live/analysis/espn:900');

    const snap = stats.snapshot();
    expect(snap.resolve_total).toBe(1);
    expect(snap.resolve_matched).toBe(1);
    expect(snap.analyses_served).toBe(1);
    expect(snap.ship_gate_refusals).toBe(1);
    expect(snap.by_domain).toEqual({ 'example.com': 1 });
  });
});

describe('policy is exposed through the router without exposing a number', () => {
  test('capabilities.shipping matches policy.shippingSports', async () => {
    const res = await request(buildApp({ matcher: {} })).get('/api/live/capabilities');
    expect(res.body.shipping).toEqual(policy.shippingSports());
  });
});
