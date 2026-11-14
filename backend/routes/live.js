/**
 * Live Game Analysis API (Phase 6).
 *
 * Mounted at `/api`, exposing:
 *   GET  /api/live/capabilities   — what is on, and which sports may show a probability
 *   POST /api/live/resolve        — paste a bookmaker link, identify the game
 *   GET  /api/live/analysis/:id   — poll the live analysis for a resolved game
 *   POST /api/live/manual         — type the values when nothing could be matched
 *   GET  /api/live/stats          — non-personal counters (secret-gated)
 *
 * The pasted link is used ONLY to identify the game. It is never fetched, never
 * scraped for odds, and never stored — only its hostname is counted.
 *
 * Whether a live PROBABILITY may be shown is not decided here: it is decided by
 * services/live/analysis.js via services/live/policy.js, against the Phase 5
 * ship gate. While `live.picks` is empty the whole surface degrades to score,
 * time and context with a reasoned `ship_gate.reason`.
 *
 * Live estimates are statistical model outputs, not betting advice.
 */

const express = require('express');
const CONFIG = require('../services/live/config');
const { parseLink } = require('../services/live/linkParser');
const { createLiveMatcher } = require('../services/live/matcher');
const { buildLiveGame, buildManualLiveGame } = require('../services/live/liveGame');
const {
  buildAnalysis,
  analyseLiveGame,
  rememberGame,
  putCachedAnalysis,
  recordForwardTest,
} = require('../services/live/analysis');
const policy = require('../services/live/policy');
const liveCalibrator = require('../services/live/liveCalibrator');
const forwardTest = require('../services/live/forwardTest');
const liveContext = require('../services/live/liveContext');
const stats = require('../services/live/stats');
const { createRateLimitMiddleware, createRateLimiter } = require('../services/live/rateLimit');

const DISCLAIMER = CONFIG.liveApi.disclaimer;

/**
 * Resolve whether this request carries a recognised tester identity.
 *
 * The identity is the SAME client-asserted signal the rate limiter uses (the
 * configured rollout header, falling back to a body userId). It is a ROLLOUT
 * SELECTOR, not an authorization boundary: it only decides who previews a pick
 * that has cleared the gate but is not public yet (services/live/policy.js).
 */
function resolveTester(req) {
  const rollout = CONFIG.live.rollout;
  if (!rollout) return false;
  const header = rollout.identityHeader || 'x-user-id';
  const body = req.body || {};
  const identity = req.headers[header] || body.userId || body.user_id || null;
  return policy.isRecognisedTester(identity);
}

/** The subset of the parse result the UI is allowed to see. */
function parsedSummary(parsed) {
  if (!parsed) return null;
  return {
    recognised: Boolean(parsed.recognised),
    sport: parsed.sport || null,
    home_raw: parsed.home_raw || null,
    away_raw: parsed.away_raw || null,
    league_hint: parsed.league_hint || null,
    confidence: parsed.confidence != null ? parsed.confidence : null,
    notes: parsed.notes || [],
  };
}

/** Secret-gated access to the counters, mirroring requireSettlementAuth. */
function createStatsAuth() {
  return function requireStatsAuth(req, res, next) {
    const secret = process.env.LIVE_STATS_SECRET || process.env.SETTLEMENT_CRON_SECRET;
    if (!secret) return next();
    const header = req.headers['x-live-stats-secret']
      || req.headers['x-settlement-secret']
      || (typeof req.headers.authorization === 'string'
        ? req.headers.authorization.replace(/^Bearer\s+/i, '')
        : null);
    if (header !== secret) {
      return res.status(401).json({ error: 'Unauthorized', traceId: req.traceId });
    }
    return next();
  };
}

/**
 * @param {Object} deps
 * @param {Object} [deps.sportsData] SportsDataService (ESPN + Pitch)
 * @param {Object} [deps.logger]
 * @param {Object} [deps.matcher]    createLiveMatcher() instance, injected in tests
 * @param {Function} [deps.rateLimitMiddleware]
 * @param {Function} [deps.manualRateLimitMiddleware] stricter limiter for the manual path
 * @param {Object} [deps.statsStore] defaults to services/live/stats
 */
function createLiveRouter({
  sportsData = null,
  logger = null,
  matcher = null,
  rateLimitMiddleware = null,
  manualRateLimitMiddleware = null,
  statsStore = stats,
} = {}) {
  const router = express.Router();

  // Phase 9 — load the persisted calibrator and the forward-test log ONCE at
  // startup, so a request never pays for the disk read and the process serves
  // exactly the column the ship gate validated. Both init() calls are
  // idempotent and never throw on a missing/corrupt artifact.
  const calibState = liveCalibrator.init();
  const fwdState = forwardTest.init();
  logger?.log('info', '[LIVE] startup', {
    calibrator_active: calibState.kept,
    calibrator_reason: calibState.reason || null,
    forward_rows: fwdState.rows,
  });

  const liveMatcher = matcher || (sportsData && sportsData.espn
    ? createLiveMatcher({ espn: sportsData.espn, pitchApi: sportsData.pitchApi, logger })
    : null);

  // Phase 9 — the context read falls back to pre-game only when there is no
  // provider (e.g. a test with an injected matcher).
  const espn = (sportsData && sportsData.espn) || null;

  const rateLimit = rateLimitMiddleware || createRateLimitMiddleware({
    ipLimiter: createRateLimiter({ max: CONFIG.liveApi.rateLimit.perIp }),
    userLimiter: createRateLimiter({ max: CONFIG.liveApi.rateLimit.perUser }),
    onLimited: () => statsStore.record('rate_limited'),
  });

  // Manual entry gets its own, stricter per-IP/per-user budget (config
  // liveApi.manualRateLimit): it is cheap to serve but trivial to hammer, and a
  // typed game can never ship a probability anyway.
  const manualRateLimit = manualRateLimitMiddleware || createRateLimitMiddleware({
    ipLimiter: createRateLimiter({
      windowMs: CONFIG.liveApi.manualRateLimit.windowMs,
      max: CONFIG.liveApi.manualRateLimit.perIp,
    }),
    userLimiter: createRateLimiter({
      windowMs: CONFIG.liveApi.manualRateLimit.windowMs,
      max: CONFIG.liveApi.manualRateLimit.perUser,
    }),
    onLimited: () => statsStore.record('rate_limited'),
  });

  const requireStatsAuth = createStatsAuth();

  /* --------------------------------------------------------- capabilities */

  router.get('/live/capabilities', (req, res) => {
    res.json({
      ...policy.featureState(),
      refresh: CONFIG.liveApi.refresh,
      max_link_length: CONFIG.liveApi.maxLinkLength,
      disclaimer: DISCLAIMER,
    });
  });

  /* -------------------------------------------------------------- resolve */

  router.post('/live/resolve', rateLimit, async (req, res) => {
    const traceId = req.traceId || null;
    const now = Date.now();
    const tester = resolveTester(req);
    try {
      if (!policy.isFeatureEnabled()) {
        statsStore.record('feature_disabled');
        return res.status(503).json({
          error: 'Live game analysis is switched off.',
          code: 'FEATURE_DISABLED',
          traceId,
        });
      }

      const body = req.body || {};
      const raw = typeof body.link === 'string' ? body.link.trim()
        : (typeof body.url === 'string' ? body.url.trim() : '');
      if (!raw) {
        return res.status(400).json({
          error: 'A bookmaker link is required.', code: 'INVALID_LINK', traceId,
        });
      }
      if (raw.length > CONFIG.liveApi.maxLinkLength) {
        return res.status(400).json({
          error: `The link is longer than ${CONFIG.liveApi.maxLinkLength} characters.`,
          code: 'INVALID_LINK',
          traceId,
        });
      }

      const parsed = parseLink(raw);
      const domain = statsStore.hostnameOf(raw);
      const sport = parsed.sport || null;
      const league = parsed.league_hint && parsed.league_hint.code;
      statsStore.record('resolve', { domain, sport, league });

      if (!parsed.recognised) {
        statsStore.record('parse_failed', { domain, sport });
        return res.json({
          status: 'none',
          reason: parsed.reason || 'The link could not be understood.',
          parsed: parsedSummary(parsed),
          manual_entry_required: true,
          disclaimer: DISCLAIMER,
        });
      }

      if (!liveMatcher) {
        return res.status(503).json({
          error: 'The live matcher is not configured.', code: 'NOT_CONFIGURED', traceId,
        });
      }

      const verdict = await liveMatcher.resolveGame(parsed, { traceId });
      statsStore.record(verdict.status, { sport, league });
      logger?.log('info', '[LIVE] resolve', {
        traceId, status: verdict.status, considered: verdict.stats?.fixtures_considered,
      });

      if (verdict.status === 'matched' || verdict.status === 'candidates') {
        const games = verdict.candidates.map(candidate => buildLiveGame({
          candidate, parsed, fetchedAt: now, now,
        }));
        // Remember every listed game so `/analysis` can be polled for the one
        // the user confirms, without a second resolve.
        games.forEach(g => rememberGame(g, now));

        if (verdict.status === 'matched') {
          // Phase 9 — the context-only experience: fetch the pre-game / key-event
          // / injury block once, here, so the first payload the UI renders has it
          // without waiting for the first poll. Best-effort: a failure degrades to
          // pre-game only.
          const contextView = await liveContext.getContext({ espn, game: games[0], now, traceId });
          const analysis = putCachedAnalysis(
            games[0].game_id,
            buildAnalysis({ game: games[0], contextView, now, fetchedAt: now, tester }),
            tester ? 'testers' : 'public',
            now,
          );
          // Phase 9 — /analysis later serves THIS cached payload without building
          // it again, so the resolve-time checkpoint would otherwise never reach
          // the forward-test log. Log it here: the shipped figure, or the shadow
          // figure when the pick is held and withheld from everyone.
          recordForwardTest({ game: games[0], analysis, now });
          return res.json({
            status: 'matched',
            parsed: parsedSummary(parsed),
            game: games[0],
            analysis,
            disclaimer: DISCLAIMER,
          });
        }

        return res.json({
          status: 'candidates',
          reason: verdict.reason,
          parsed: parsedSummary(parsed),
          candidates: games,
          manual_entry_required: false,
          disclaimer: DISCLAIMER,
        });
      }

      return res.json({
        status: 'none',
        reason: verdict.reason,
        parsed: parsedSummary(parsed),
        manual_entry_required: true,
        disclaimer: DISCLAIMER,
      });
    } catch (err) {
      statsStore.record('upstream_error');
      logger?.log('error', '[LIVE] resolve failed', { traceId, error: err?.message });
      return res.status(500).json({
        error: 'Live game analysis could not be completed right now.',
        code: 'LIVE_ERROR',
        traceId,
      });
    }
  });

  /* ------------------------------------------------------------- analysis */

  router.get('/live/analysis/:gameId', rateLimit, async (req, res) => {
    const traceId = req.traceId || null;
    const tester = resolveTester(req);
    try {
      if (!policy.isFeatureEnabled()) {
        statsStore.record('feature_disabled');
        return res.status(503).json({
          error: 'Live game analysis is switched off.',
          code: 'FEATURE_DISABLED',
          traceId,
        });
      }

      const result = await analyseLiveGame({
        gameId: req.params.gameId, matcher: liveMatcher, espn,
        now: Date.now(), traceId, tester,
      });

      if (result.error) {
        return res.status(result.error.status || 404).json({
          error: result.error.message,
          code: result.error.code,
          traceId,
        });
      }

      const analysis = result.analysis;
      const meta = {
        sport: analysis.sport,
        league: analysis.league && analysis.league.id,
      };
      if (analysis.ship_gate && analysis.ship_gate.decision === 'withheld') {
        statsStore.record('ship_gate_refusal', meta);
      }
      statsStore.record('analysis', meta);

      return res.json({ ...analysis, cached: Boolean(result.cached), traceId });
    } catch (err) {
      statsStore.record('upstream_error');
      logger?.log('error', '[LIVE] analysis failed', {
        traceId, gameId: req.params.gameId, error: err?.message,
      });
      return res.status(500).json({
        error: 'Live game analysis could not be completed right now.',
        code: 'LIVE_ERROR',
        traceId,
      });
    }
  });

  /* --------------------------------------------------------- manual entry */

  router.post('/live/manual', manualRateLimit, (req, res) => {
    const traceId = req.traceId || null;
    try {
      if (!policy.isFeatureEnabled()) {
        statsStore.record('feature_disabled');
        return res.status(503).json({
          error: 'Live game analysis is switched off.',
          code: 'FEATURE_DISABLED',
          traceId,
        });
      }
      // Manual entry is its own switch: the live surface can be on while
      // hand-typed games are refused.
      if (!policy.manualEntryEnabled()) {
        statsStore.record('feature_disabled');
        return res.status(503).json({
          error: 'Manual entry is switched off.',
          code: 'MANUAL_ENTRY_DISABLED',
          traceId,
        });
      }

      const now = Date.now();
      const built = buildManualLiveGame(req.body || {}, { now });
      if (!built.ok) {
        return res.status(400).json({
          error: 'The values entered could not be used.',
          code: 'INVALID_MANUAL_ENTRY',
          errors: built.errors,
          traceId,
        });
      }

      statsStore.record('manual_entry', { sport: built.game.sport });
      const analysis = buildAnalysis({ game: built.game, now, fetchedAt: now });
      return res.json({ ...analysis, traceId });
    } catch (err) {
      logger?.log('error', '[LIVE] manual entry failed', { traceId, error: err?.message });
      return res.status(500).json({
        error: 'The values entered could not be used.',
        code: 'LIVE_ERROR',
        traceId,
      });
    }
  });

  /* ---------------------------------------------------------------- stats */

  router.get('/live/stats', requireStatsAuth, (req, res) => {
    // Phase 9 operational state (secret-gated, never on a user payload): which
    // calibrated column is served, whether each ROLLED-OUT pick is still within
    // tolerance of its backtest benchmark, and how the WITHHELD (shadow) evidence
    // is tracking toward the rollout decision.
    const forwardVerdicts = {};
    Object.keys(policy.rolloutSports()).forEach(sport => {
      forwardVerdicts[sport] = forwardTest.evaluate(sport);
    });
    // Shadow sports are held — no pick is served, so nothing to auto-disable.
    // shadowSummary answers the one rollout question: enough settled live games,
    // still within tolerance? Kept separate from `verdicts` so a held sport can
    // never be read as an active pick.
    const shadowVerdicts = {};
    const confirmationVerdicts = {};
    policy.shadowSports().forEach(sport => {
      shadowVerdicts[sport] = forwardTest.shadowSummary(sport);
      // Phase 10 round D — the CONFIRMATION dataset for this sport: only shadow
      // rows logged AFTER the candidate freeze count, evaluated once at >= 500
      // settled GAMES. Surfaced alongside so the empty-but-forthcoming window is
      // explicit rather than implied by the rolling summary above.
      confirmationVerdicts[sport] = forwardTest.confirmationSummary(sport);
    });
    res.json({
      ...statsStore.snapshot(),
      calibrator: liveCalibrator.status(),
      forward_test: {
        ...forwardTest.status(),
        verdicts: forwardVerdicts,
        shadow: shadowVerdicts,
        confirmation: confirmationVerdicts,
        // Phase 10 round D — settled GAMES per sport and per league on the
        // confirmation dataset, with a first-order estimate of when each reaches
        // the 500-game target at the observed settlement rate.
        progress: forwardTest.progress(),
      },
      disclaimer: DISCLAIMER,
    });
  });

  return router;
}

module.exports = { createLiveRouter, DISCLAIMER };
