/**
 * Phase 6 — policy, rate limiting and stats.
 *
 * These are the three services that decide whether the live surface is honest
 * and fair: policy refuses to ship an unvalidated probability, the limiter keeps
 * one client from draining the upstream, and stats records only non-personal
 * facts. Nothing here touches the network.
 */

const express = require('express');
const request = require('supertest');

const CONFIG = require('../services/live/config');
const policy = require('../services/live/policy');
const stats = require('../services/live/stats');
const {
  createRateLimiter, createRateLimitMiddleware, clientIp,
} = require('../services/live/rateLimit');

/** Run `fn` with `league` temporarily added to a sport's ship-gate allowlist. */
function withShippedLeague(sport, league, fn) {
  const original = CONFIG.live.picks[sport];
  CONFIG.live.picks[sport] = [league];
  try {
    fn();
  } finally {
    CONFIG.live.picks[sport] = original;
  }
}

describe('policy — feature switches vs ship gate', () => {
  test('featureState reports the supported sports and no shipping sports by default', () => {
    const state = policy.featureState();
    expect(state.enabled).toBe(true);
    expect(state.supported_sports).toEqual(['soccer', 'basketball']);
    expect(state.sports).toEqual({ soccer: true, basketball: true });
    expect(state.manual_entry).toBe(true);
    // The honest current state: nothing has cleared the Phase 5 gate.
    expect(state.shipping).toEqual([]);
    // Phase 9/10 hold: basketball is observed in SHADOW — computed and logged as
    // evidence, shown to nobody — and soccer joins it so its frozen candidate
    // columns can be scored on fresh data. Neither is previewed to any tester.
    expect(state.shadow).toEqual(['basketball', 'soccer']);
    expect(state.rollout).toEqual({ testers_only: true, sports: {} });
  });

  test('manual entry is its own switch, independent of the per-sport switches', () => {
    expect(policy.manualEntryEnabled()).toBe(true);

    const originalManual = CONFIG.live.manualEntry;
    CONFIG.live.manualEntry = false;
    try {
      // The live surface is still on; only hand-typed games are refused.
      expect(policy.isFeatureEnabled()).toBe(true);
      expect(policy.manualEntryEnabled()).toBe(false);
      expect(policy.featureState().manual_entry).toBe(false);
    } finally {
      CONFIG.live.manualEntry = originalManual;
    }

    const originalEnabled = CONFIG.live.enabled;
    CONFIG.live.enabled = false;
    try {
      expect(policy.manualEntryEnabled()).toBe(false);
    } finally {
      CONFIG.live.enabled = originalEnabled;
    }
  });

  test('mayShipPick refuses a hand-typed game even when its league has passed the gate', () => {
    withShippedLeague('soccer', 'eng.1', () => {
      const out = policy.mayShipPick({ sport: 'soccer', league: 'eng.1', manual: true });
      expect(out.allowed).toBe(false);
      expect(out.reason).toMatch(/entered by hand/i);
      // The provider game for the same league is still allowed.
      expect(policy.mayShipPick({ sport: 'soccer', league: 'eng.1' }).allowed).toBe(true);
    });
  });

  test('mayShipPick refuses a shadow-held sport with a plain reason', () => {
    const out = policy.mayShipPick({ sport: 'soccer', league: 'eng.1' });
    expect(out.allowed).toBe(false);
    // Soccer joined the shadow hold in Phase 10, so the reason names it.
    expect(out.reason).toMatch(/still being validated on live games/i);
    expect(out.sport).toBe('soccer');
    expect(out.league).toBe('eng.1');
  });

  test('mayShipPick refuses an unknown sport, a disabled sport and an unlisted league', () => {
    expect(policy.mayShipPick({ sport: 'tennis' }).allowed).toBe(false);
    expect(policy.mayShipPick({ sport: 'tennis' }).reason).toMatch(/switched off/i);

    const original = CONFIG.live.sports.soccer;
    CONFIG.live.sports.soccer = false;
    try {
      expect(policy.mayShipPick({ sport: 'soccer', league: 'eng.1' }).reason)
        .toMatch(/switched off for soccer/i);
      expect(policy.isFeatureEnabled('soccer')).toBe(false);
    } finally {
      CONFIG.live.sports.soccer = original;
    }

    withShippedLeague('soccer', 'eng.1', () => {
      expect(policy.mayShipPick({ sport: 'soccer' }).allowed).toBe(false);
      expect(policy.mayShipPick({ sport: 'soccer' }).reason).toMatch(/could not be established/i);
      expect(policy.mayShipPick({ sport: 'soccer', league: 'esp.1' }).allowed).toBe(false);
      expect(policy.mayShipPick({ sport: 'soccer', league: 'esp.1' }).reason)
        .toMatch(/soccer\/esp\.1 has not passed/i);
    });
  });

  test('mayShipPick allows exactly the listed league once it has passed', () => {
    withShippedLeague('soccer', 'eng.1', () => {
      const out = policy.mayShipPick({ sport: 'soccer', league: 'eng.1' });
      expect(out).toEqual({ allowed: true, reason: null, audience: 'public', sport: 'soccer', league: 'eng.1' });
      expect(policy.shippingSports()).toEqual(['soccer']);
      expect(policy.featureState().shipping).toEqual(['soccer']);
    });
  });

  test('mayShipPick refuses everything when the feature is switched off globally', () => {
    const original = CONFIG.live.enabled;
    CONFIG.live.enabled = false;
    try {
      const out = policy.mayShipPick({ sport: 'soccer', league: 'eng.1' });
      expect(out.allowed).toBe(false);
      expect(out.reason).toMatch(/switched off globally/i);
      expect(policy.isFeatureEnabled()).toBe(false);
    } finally {
      CONFIG.live.enabled = original;
    }
  });
});

describe('policy — Phase 9 shadow hold', () => {
  test('shadowSports lists the observed-but-withheld sports', () => {
    expect(policy.shadowSports()).toEqual(['basketball', 'soccer']);
  });

  test('a held sport ships to nobody, public and tester alike', () => {
    const pub = policy.mayShipPick({ sport: 'basketball', league: 'nba' });
    const tester = policy.mayShipPick({ sport: 'basketball', league: 'nba', tester: true });
    expect(pub.allowed).toBe(false);
    expect(tester.allowed).toBe(false);
    expect(pub.audience).toBeNull();
    expect(tester.audience).toBeNull();
    expect(pub.reason).toMatch(/still being validated/i);
    expect(pub.reason).toMatch(/not shown/i);
  });

  test('a sport that starts shipping leaves the shadow list', () => {
    withShippedLeague('basketball', 'nba', () => {
      expect(policy.shadowSports()).not.toContain('basketball');
      expect(policy.shippingSports()).toContain('basketball');
    });
    // The hold is unchanged once the temporary allowlist is gone.
    expect(policy.shadowSports()).toContain('basketball');
  });

  test('the shadow list is empty when the hold switch is off', () => {
    const original = CONFIG.live.shadow.enabled;
    CONFIG.live.shadow.enabled = false;
    try {
      expect(policy.shadowSports()).toEqual([]);
    } finally {
      CONFIG.live.shadow.enabled = original;
    }
  });
});

describe('rateLimit — fixed window', () => {
  test('allows up to max then refuses with a retry hint, and resets after the window', () => {
    let t = 1_000_000;
    const limiter = createRateLimiter({ windowMs: 1000, max: 3, now: () => t });

    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').remaining).toBe(1);
    expect(limiter.check('a').allowed).toBe(true);
    const blocked = limiter.check('a');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(1000);
    expect(blocked.remaining).toBe(0);

    t += 1000;
    expect(limiter.check('a').allowed).toBe(true);
  });

  test('buckets are independent per key', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => 0 });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
    expect(limiter.check('b').allowed).toBe(true);
  });

  test('clientIp honours one x-forwarded-for hop, then falls back to req.ip', () => {
    expect(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } })).toBe('1.2.3.4');
    expect(clientIp({ headers: {}, ip: '9.9.9.9' })).toBe('9.9.9.9');
  });

  test('middleware returns 429 with Retry-After and a machine-readable code', async () => {
    const app = express();
    const middleware = createRateLimitMiddleware({
      ipLimiter: createRateLimiter({ windowMs: 60_000, max: 1, now: () => 0 }),
      userLimiter: createRateLimiter({ windowMs: 60_000, max: 10, now: () => 0 }),
      onLimited: () => { limited += 1; },
    });
    let limited = 0;
    app.get('/x', middleware, (req, res) => res.json({ ok: true }));

    const first = await request(app).get('/x');
    expect(first.status).toBe(200);
    expect(first.headers['x-ratelimit-remaining']).toBe('0');

    const second = await request(app).get('/x');
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('RATE_LIMITED');
    expect(second.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(second.headers['retry-after']).toBeDefined();
    expect(limited).toBe(1);
  });

  test('the per-user bucket is checked only when the client asserts an identity', async () => {
    const app = express();
    app.use(express.json());
    app.use(createRateLimitMiddleware({
      ipLimiter: createRateLimiter({ windowMs: 60_000, max: 100, now: () => 0 }),
      userLimiter: createRateLimiter({ windowMs: 60_000, max: 1, now: () => 0 }),
    }));
    app.get('/x', (req, res) => res.json({ ok: true }));

    const a = await request(app).get('/x').set('x-user-id', 'u1');
    expect(a.status).toBe(200);
    const b = await request(app).get('/x').set('x-user-id', 'u1');
    expect(b.status).toBe(429);
    // A different user, same IP, is unaffected.
    const c = await request(app).get('/x').set('x-user-id', 'u2');
    expect(c.status).toBe(200);
  });
});

describe('stats — non-personal counters', () => {
  beforeEach(() => stats.reset());

  test('hostnameOf keeps only the hostname, never the path or token', () => {
    expect(stats.hostnameOf('https://www.Bet365.com/en/live#/AC?token=secret')).toBe('bet365.com');
    expect(stats.hostnameOf('https://odds.example.com/x')).toBe('odds.example.com');
    expect(stats.hostnameOf('not a url')).toBeNull();
    expect(stats.hostnameOf(null)).toBeNull();
  });

  test('rates are null (not zero) until their denominator exists', () => {
    const empty = stats.snapshot();
    expect(empty.match_success_rate).toBeNull();
    expect(empty.parse_failure_rate).toBeNull();
  });

  test('records outcomes and derives the three rates the brief asks for', () => {
    stats.record('resolve', { domain: 'bet365.com', sport: 'soccer', league: 'eng.1' });
    stats.record('matched', { sport: 'soccer', league: 'eng.1' });
    stats.record('resolve', { domain: 'bet365.com', sport: 'basketball' });
    stats.record('none', { sport: 'basketball' });
    stats.record('resolve', { sport: 'soccer' });
    stats.record('parse_failed', { sport: 'soccer' });

    const s = stats.snapshot();
    expect(s.resolve_total).toBe(3);
    expect(s.resolve_matched).toBe(1);
    expect(s.resolve_none).toBe(1);
    expect(s.parse_failed).toBe(1);
    expect(s.by_domain).toEqual({ 'bet365.com': 2 });
    expect(s.match_success_rate).toBe(0.5); // 1 matched / 2 resolved outcomes
    expect(s.parse_failure_rate).toBeCloseTo(1 / 3, 4);
  });

  test('bookmaker counter never carries a full URL, only the hostname', () => {
    stats.record('resolve', { domain: stats.hostnameOf('https://www.bet365.com/a/b?t=1') });
    expect(stats.snapshot().by_domain).toEqual({ 'bet365.com': 1 });
  });

  test('hand-typed games are tallied but kept out of every rate', () => {
    stats.record('resolve', { domain: 'bet365.com', sport: 'soccer' });
    stats.record('matched', { sport: 'soccer', league: 'eng.1' });
    const before = stats.snapshot();

    // Two hand-typed games; neither is a verified resolve outcome.
    stats.record('manual_entry', { sport: 'soccer' });
    stats.record('manual_entry', { sport: 'basketball' });

    const after = stats.snapshot();
    expect(after.manual_entries).toBe(2);
    // The raw tally moved, but every derived rate is computed from the verified
    // denominators only — a hand-typed game never moves a rate or a domain.
    expect(after.manual_entry_rate).toBe(before.manual_entry_rate);
    expect(after.match_success_rate).toBe(before.match_success_rate);
    expect(after.parse_failure_rate).toBe(before.parse_failure_rate);
    expect(after.by_domain).toEqual(before.by_domain);
  });
});
