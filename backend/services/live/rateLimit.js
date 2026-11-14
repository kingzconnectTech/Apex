/**
 * live/rateLimit.js
 *
 * A tiny fixed-window counter. No dependency: the whole app already keeps its
 * short-lived state in in-process Maps (see server.js `cache`), so a second
 * cache library would be out of place and a new paid dependency is forbidden.
 *
 * This is FAIRNESS, not security. The per-user bucket is keyed on an identity
 * the client asserts, so it can be evaded by omitting it; the per-IP bucket is
 * the one that cannot. Neither is an authorization boundary — that is what the
 * existing settlement secret middleware is for.
 */

const CONFIG = require('./config');

const CFG = CONFIG.liveApi.rateLimit;

/** Prune expired buckets once the store grows past this, so it cannot leak. */
const PRUNE_THRESHOLD = 5000;

/**
 * @param {Object} [opts]
 * @param {number} [opts.windowMs]
 * @param {number} [opts.max]
 * @param {Function} [opts.now] () => epoch ms (injected for tests)
 */
function createRateLimiter({ windowMs = CFG.windowMs, max = CFG.perIp, now = Date.now } = {}) {
  const hits = new Map();

  function prune(t) {
    if (hits.size < PRUNE_THRESHOLD) return;
    for (const [key, rec] of hits) {
      if (!rec || t >= rec.resetAt) hits.delete(key);
    }
  }

  /**
   * Record one hit against `key`.
   * @returns {{allowed:boolean, remaining:number, retryAfterMs:number, resetAt:number}}
   */
  function check(key) {
    const t = now();
    prune(t);
    const rec = hits.get(key);
    if (!rec || t >= rec.resetAt) {
      const resetAt = t + windowMs;
      hits.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: Math.max(0, max - 1), retryAfterMs: 0, resetAt };
    }
    rec.count += 1;
    if (rec.count > max) {
      return { allowed: false, remaining: 0, retryAfterMs: rec.resetAt - t, resetAt: rec.resetAt };
    }
    return { allowed: true, remaining: Math.max(0, max - rec.count), retryAfterMs: 0, resetAt: rec.resetAt };
  }

  return {
    check,
    reset() { hits.clear(); },
    size() { return hits.size; },
  };
}

/** Client IP, honouring a single proxy hop when the app is behind one. */
function clientIp(req) {
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Express middleware enforcing both buckets.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.ipLimiter]   createRateLimiter() for the IP bucket
 * @param {Object} [opts.userLimiter] createRateLimiter() for the user bucket
 * @param {Function} [opts.userKey]   (req) => string|null
 * @param {Function} [opts.onLimited] (req, info) => void, for logging
 */
function createRateLimitMiddleware({
  ipLimiter = createRateLimiter({ max: CFG.perIp }),
  userLimiter = createRateLimiter({ max: CFG.perUser }),
  userKey = req => (req.headers && req.headers['x-user-id']) || (req.body && req.body.userId) || null,
  onLimited = null,
} = {}) {
  return function rateLimit(req, res, next) {
    const ipResult = ipLimiter.check(`ip:${clientIp(req)}`);
    if (!ipResult.allowed) {
      if (onLimited) onLimited(req, { bucket: 'ip', retryAfterMs: ipResult.retryAfterMs });
      res.setHeader('Retry-After', String(Math.ceil(ipResult.retryAfterMs / 1000)));
      return res.status(429).json({
        error: 'Too many live-analysis requests from this network. Please slow down.',
        code: 'RATE_LIMITED',
        retryAfterSeconds: Math.ceil(ipResult.retryAfterMs / 1000),
      });
    }

    const uid = userKey(req);
    if (uid) {
      const userResult = userLimiter.check(`user:${uid}`);
      if (!userResult.allowed) {
        if (onLimited) onLimited(req, { bucket: 'user', retryAfterMs: userResult.retryAfterMs });
        res.setHeader('Retry-After', String(Math.ceil(userResult.retryAfterMs / 1000)));
        return res.status(429).json({
          error: 'Too many live-analysis requests for this account. Please slow down.',
          code: 'RATE_LIMITED',
          retryAfterSeconds: Math.ceil(userResult.retryAfterMs / 1000),
        });
      }
    }

    res.setHeader('X-RateLimit-Remaining', String(ipResult.remaining));
    return next();
  };
}

module.exports = {
  createRateLimiter,
  createRateLimitMiddleware,
  clientIp,
};
