/**
 * Live Game Analysis API (Phase 6).
 *
 * Mounted at `/api`, exposing:
 *   GET  /api/live/capabilities   — what is on, and which sports may show a probability
 *   GET  /api/live/matches        — the games IN PLAY now (FlashScore / LiveScore)
 *   POST /api/live/validate-link  — check a user-supplied link before opening it
 *   POST /api/live/resolve        — paste a bookmaker link, identify the game
 *   GET  /api/live/analysis/:id   — poll the live analysis for a resolved game
 *   POST /api/live/manual         — type the values when nothing could be matched
 *   GET  /api/live/stats          — non-personal counters (secret-gated)
 *   POST /api/live/sweep          — run the shadow sweep now (secret-gated, the
 *                                   PRIMARY trigger; node-cron is the backup)
 *   POST /api/live/reconcile      — run the counter reconcile now (secret-gated;
 *                                   reports counter-vs-recount drift in health)
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

const crypto = require('crypto');
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
const liveStats = require('../services/live/liveStats');
const stats = require('../services/live/stats');
const shadowHealth = require('../services/live/shadowHealth');
const ledger = require('../services/live/ledger');
const { executeShadowSweep, runShadowReconcile } = require('../services/live/shadowScheduler');
const { createRateLimitMiddleware, createRateLimiter } = require('../services/live/rateLimit');
const matchFeed = require('../services/live/matchFeed');

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
    // Present only for a LiveScore / FlashScore match page: the site and the
    // canonical match id the link was identified by.
    source: parsed.source || null,
    provider_id: parsed.provider_id || null,
    notes: parsed.notes || [],
  };
}

/**
 * Constant-time string compare.
 *
 * A plain `a !== b` short-circuits on the first differing byte, leaking the
 * shared prefix — and the length — through timing. Both sides are hashed to a
 * fixed-width SHA-256 digest first, so equal-length buffers can never make
 * `timingSafeEqual` throw and no length information leaks either. Used for the
 * stats/sweep secret (round G item 2). Never throws.
 */
function safeEqual(a, b) {
  try {
    const x = crypto.createHash('sha256').update(String(a)).digest();
    const y = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
  } catch (err) {
    return false;
  }
}

/** Truthy for `true`, `'true'`, `1`, `'1'`, `'yes'` — the query/body dry_run flag. */
function isTruthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
}

/**
 * Secret-gated access to the counters and the sweep trigger.
 *
 * Round H (item 2) hardening:
 *   - the secret is accepted ONLY from the `Authorization: Bearer <secret>`
 *     header — never a query string and never a request body, both of which
 *     leak into access logs, proxies and referrers;
 *   - a MISSING or SHORT (< `live.store.secret.minLength`, default 24) configured
 *     secret is a 401, NOT an open route: an endpoint that writes evidence must
 *     fail closed;
 *   - the compare is constant time and the secret value is NEVER logged.
 */
function createStatsAuth() {
  const cfg = (CONFIG.live.store && CONFIG.live.store.secret) || {};
  const envName = cfg.env || 'LIVE_STATS_SECRET';
  const fallbackName = cfg.fallbackEnv || 'SETTLEMENT_CRON_SECRET';
  const minLength = Number.isFinite(cfg.minLength) ? cfg.minLength : 24;
  return function requireStatsAuth(req, res, next) {
    const secret = process.env[envName] || process.env[fallbackName];
    // Fail closed: no secret, or one too short to be safe. (Nothing is logged.)
    if (typeof secret !== 'string' || secret.length < minLength) {
      return res.status(401).json({ error: 'Unauthorized', traceId: req.traceId });
    }
    const raw = req.headers.authorization;
    const token = typeof raw === 'string' ? raw.replace(/^Bearer\s+/i, '').trim() : null;
    // Missing/blank header, or a mismatch under a constant-time compare → 401.
    if (typeof token !== 'string' || !token || !safeEqual(token, secret)) {
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
 * @param {Function} [deps.sweepRateLimitMiddleware] limiter for the sweep trigger
 * @param {Object} [deps.statsStore] defaults to services/live/stats
 */
function createLiveRouter({
  sportsData = null,
  logger = null,
  matcher = null,
  rateLimitMiddleware = null,
  manualRateLimitMiddleware = null,
  sweepRateLimitMiddleware = null,
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

  // Round H (item 3) — /api/live/stats reads DURABLE state (the scheduler health
  // document) on every poll. Cache that durable read for a few seconds —
  // configurable via `live.store.stats.cacheTtlMs` — so a burst of polling does
  // not multiply Firestore reads. The HEALTH COUNTS ride along in the same
  // cached value: they are derived from the same durable row set and must not be
  // fresher than the scheduler state they are reported beside.
  const statsCacheTtlMs = (CONFIG.live.store && CONFIG.live.store.stats
    && Number.isFinite(CONFIG.live.store.stats.cacheTtlMs))
    ? CONFIG.live.store.stats.cacheTtlMs : 5000;
  let statsCache = { at: 0, value: null };

  /** The durable health block, served from a short cache so polling is cheap. */
  async function durableHealth(now) {
    if (statsCacheTtlMs > 0 && statsCache.value && now - statsCache.at < statsCacheTtlMs) {
      return statsCache.value;
    }
    const value = {
      scheduler: await shadowHealth.readSnapshot({ now }),
      rows_last_24h: forwardTest.rowsLast24h({ now }),
      daily_since_freeze: forwardTest.dailyCounts({ sinceMs: forwardTest.confirmationFreeze().ms }),
      // Round I (item 1) — the earliest and latest row times, read from the
      // durable counters in `live_shadow/meta`, so they survive a cold start
      // without loading the rows subcollection.
      first_row_at: forwardTest.firstRowAt(),
      last_row_at: forwardTest.lastRowAt(),
      // Round H (item 5) — the ledger's first post-freeze row, surfaced next to
      // the counts so a deployment checklist can confirm logging actually began.
      // Read durably (a cold start must not blank it) and cached with the rest.
      first_post_freeze_row: (await ledger.read()).first_post_freeze_row || null,
    };
    statsCache = { at: now, value };
    return value;
  }

  // Round G (item 2) — POST /api/live/sweep is the PRIMARY shadow trigger, so it
  // gets its own per-IP budget (config live.store.sweep.rateLimit). It is a
  // cheap no-op when a sweep is already running (the scheduler's lock returns
  // `skipped:true`), but a burst of calls would still hammer the provider, so the
  // limit is enforced before the sweep runs. The secret check runs FIRST, so an
  // unauthenticated caller can never consume the budget.
  const sweepRateLimit = sweepRateLimitMiddleware || createRateLimitMiddleware({
    ipLimiter: createRateLimiter({
      windowMs: CONFIG.live.store.sweep.rateLimit.windowMs,
      max: CONFIG.live.store.sweep.rateLimit.perIp,
    }),
    onLimited: () => statsStore.record('rate_limited'),
  });

  /* --------------------------------------------------------- capabilities */

  router.get('/live/capabilities', (req, res) => {
    res.json({
      ...policy.featureState(),
      refresh: CONFIG.liveApi.refresh,
      max_link_length: CONFIG.liveApi.maxLinkLength,
      // The live-matches surface (FlashScore / LiveScore). `enabled` gates the
      // list itself; `sites` is the allow-list of hosts a user may save as a
      // preferred link. Exposed here so the client can render the picker before
      // it ever calls /live/matches. `refresh` uses the SAME snake_case shape as
      // the /live/matches payload, so a client reads one contract from either.
      matches: {
        enabled: matchFeed.isEnabled(),
        refresh: {
          suggested_seconds: CONFIG.live.matchFeed.refresh.suggestedSeconds,
          min_seconds: CONFIG.live.matchFeed.refresh.minSeconds,
        },
        max_link_length: matchFeed.MAX_LINK_LENGTH,
        sites: matchFeed.sites(),
      },
      disclaimer: DISCLAIMER,
    });
  });

  /* --------------------------------------------------------------- matches */

  /**
   * GET /api/live/matches — the games IN PLAY right now.
   *
   * The SERVER reads the two public score sites and normalises the list; the
   * client renders it. No odds are read and nothing is stored. Each source is
   * fetched independently, so a source that is down is reported in `sources`
   * and degrades the list rather than emptying it; when EVERY source fails the
   * payload still returns 200 with `degraded:true` and `count:0`, so the UI can
   * say "could not reach the sites" instead of showing a bare network error.
   *
   * Each match carries a `prediction` block produced by the SAME live engine the
   * rest of the product uses (services/live/matchFeed -> analysis). It is gated
   * by the Phase 5 ship gate, so `probabilities`, `projection` and `uncertainty`
   * are null wherever a figure may not be shown and `ship_gate.reason` explains
   * why — the feed never emits an unvalidated number.
   *
   * `?sources=flashscore,livescore` restricts the read; `?force=true` bypasses
   * the short server-side cache (an explicit user refresh).
   */
  router.get('/live/matches', rateLimit, async (req, res) => {
    const traceId = req.traceId || null;
    try {
      if (!matchFeed.isEnabled()) {
        return res.status(503).json({
          error: 'The live matches feed is switched off.',
          code: 'MATCHES_DISABLED',
          traceId,
        });
      }

      const rawSources = req.query && req.query.sources;
      const requested = typeof rawSources === 'string'
        ? rawSources.split(',').map(s => s.trim()).filter(Boolean)
        : null;

      const payload = await matchFeed.fetchLiveMatches({
        sources: requested,
        force: isTruthy(req.query && req.query.force),
      });
      return res.json({ ...payload, traceId });
    } catch (err) {
      logger?.log('error', '[LIVE] matches failed', { traceId, error: err?.message });
      return res.status(503).json({
        error: 'The live matches could not be fetched right now.',
        code: 'MATCHES_UNAVAILABLE',
        reason: err?.message || null,
        traceId,
      });
    }
  });

  /**
   * POST /api/live/validate-link — check a link the USER supplies before it is
   * opened in the in-app browser.
   *
   * Only http/https links are accepted, so a `javascript:` / `file:` / `data:`
   * URL can never reach the WebView. A host that is one of the known score
   * sites is reported `recognised:true`; any other well-formed host is still
   * accepted, but marked `recognised:false` so the UI never presents an unknown
   * site as a known one.
   *
   * Unlike /live/resolve (which does work and 400s on a bad input), this is a
   * pure INPUT CHECK, so it always answers 200 with the verdict in `valid` +
   * `reason`: the client renders the reason inline while the user types instead
   * of treating "not a link yet" as a request failure. `code` is still supplied
   * (INVALID_LINK) so callers can map it programmatically.
   */
  router.post('/live/validate-link', rateLimit, (req, res) => {
    const traceId = req.traceId || null;
    const body = req.body || {};
    const raw = typeof body.link === 'string' ? body.link
      : (typeof body.url === 'string' ? body.url : '');

    const verdict = matchFeed.validateSiteLink(raw);
    return res.json({
      ...verdict,
      code: verdict.valid ? null : 'INVALID_LINK',
      sites: matchFeed.sites(),
      max_link_length: matchFeed.MAX_LINK_LENGTH,
      traceId,
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

      // A pasted LiveScore / FlashScore MATCH page is identified by its own
      // canonical match id, and resolved against the SAME live feed the
      // /live/matches list is built from — the ESPN sweep below cannot see these
      // two sites. This runs before the matcher check, so a score-site link
      // still works on a server with no ESPN provider configured.
      if (parsed.platform && parsed.provider_id) {
        const feed = await matchFeed.resolveFeedMatch({
          source: parsed.platform, providerId: parsed.provider_id,
        });

        if (feed.match) {
          const game = matchFeed.toLiveGame(feed.match, { now, fetchedAt: now });
          rememberGame(game, now);
          const contextView = await liveContext.getContext({ espn, game, now, traceId });
          const statsView = await liveStats.getLiveStats({ espn, game, now, traceId });
          // R6 — attach the REAL bookmaker line so the FIRST payload the UI
          // renders carries the same real-line grid the later polls will.
          const priced = { ...game, odds: await liveContext.getRealOdds({ espn, game, now, traceId }) };
          const analysis = putCachedAnalysis(
            game.game_id,
            buildAnalysis({ game: priced, contextView, statsView, now, fetchedAt: now, tester }),
            tester ? 'testers' : 'public',
            now,
          );
          recordForwardTest({ game, analysis, now });
          statsStore.record('matched', { sport: game.sport, league: null });
          logger?.log('info', '[LIVE] resolve (score-site link)', {
            traceId, status: 'matched', source: parsed.platform,
          });
          return res.json({
            status: 'matched',
            parsed: parsedSummary(parsed),
            game,
            analysis,
            disclaimer: DISCLAIMER,
          });
        }

        // Distinguish "that match is not in play" from "the site is down", so
        // the UI can say which. Either way the honest answer is `none`.
        const siteName = parsed.source_name
          || (parsed.platform === 'livescore' ? 'LiveScore' : 'FlashScore');
        const reason = feed.source_ok
          ? `That ${siteName} match is not in play right now, so there is no live data for it yet.`
          : `The ${siteName} live feed could not be reached just now. Please try again.`;
        statsStore.record('parse_failed', { domain, sport });
        logger?.log('info', '[LIVE] resolve (score-site link)', {
          traceId, status: 'none', source: parsed.platform, source_ok: feed.source_ok,
        });
        return res.json({
          status: 'none',
          reason,
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
          const statsView = await liveStats.getLiveStats({ espn, game: games[0], now, traceId });
          // R6 — attach the REAL bookmaker line so the first payload carries it.
          const priced = { ...games[0], odds: await liveContext.getRealOdds({ espn, game: games[0], now, traceId }) };
          const analysis = putCachedAnalysis(
            games[0].game_id,
            buildAnalysis({ game: priced, contextView, statsView, now, fetchedAt: now, tester }),
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

  router.get('/live/stats', requireStatsAuth, async (req, res) => {
    const now = Date.now();
    // Round J (item 3) — on the Firestore backend the startup counters hydrate
    // ASYNCHRONOUSLY, so `status()` and `confirmationSummary()` below must not be
    // read from different hydration states (a cold start could otherwise answer
    // `total_rows: 3` beside `confirmation.settled_games: 0`). Await the (single)
    // hydrate first so the whole payload is one consistent snapshot. Resolves
    // immediately on the file backend and after a restart on Firestore.
    await forwardTest.ready();
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
    // Round G (item 3) — the scheduler health is read from DURABLE storage, not
    // the in-memory copy, so a cold start (the free-tier host having slept) does
    // not reset it to `never_ran`. Round H (item 3) caches that durable read for
    // `cacheTtlMs` so polling is cheap. Never throws (a read failure is blank).
    const durable = await durableHealth(now);
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
        progress: forwardTest.progress({ now }),
      },
      // Phase 10 round F (item 1) — the health block. Where shadow rows live,
      // whether the sweep is actually ticking, how many rows landed in the last
      // 24h, and an actionable alert when live games are served but no row is
      // being logged. All counts; no probability is exposed here.
      // Round G: `storage` reports the ACTIVE adapter (file or Firestore), and
      // `scheduler` is the durable read above. Round H: `cache_ttl_ms` is how
      // long those durable counts are reused before storage is read again.
      health: {
        storage: forwardTest.storage(),
        scheduler: durable.scheduler,
        rows_last_24h: durable.rows_last_24h,
        // Rows / distinct games per UTC day on the confirmation dataset (shadow
        // rows logged at/after the candidate freeze). Empty means none landed.
        daily_since_freeze: durable.daily_since_freeze,
        // Round I (item 1) — the earliest and latest shadow-row times, read from
        // the durable counters (present even when the rows are not loaded).
        first_row_at: durable.first_row_at,
        last_row_at: durable.last_row_at,
        // Round H (item 5) — the exact instant the FIRST post-freeze shadow row
        // was logged (from the durable ledger). `null` means logging has not
        // started; rows before it do not exist, so nothing is backfilled.
        first_post_freeze_row: durable.first_post_freeze_row,
        // Round J (item 5) — the DAILY RECONCILE result: when it last ran,
        // whether the durable counters disagreed with a recount of the rows, the
        // drift itself (counts only) and any reconcile error. A non-zero delta
        // also raises the `counter_drift` scheduler alert above.
        reconcile: durable.scheduler ? durable.scheduler.reconcile : null,
        cache_ttl_ms: statsCacheTtlMs,
      },
      disclaimer: DISCLAIMER,
    });
  });

  /* ---------------------------------------------------------- sweep trigger */

  /**
   * POST /api/live/sweep — run the shadow sweep NOW.
   *
   * This is the PRIMARY shadow trigger (round G item 2). The in-process
   * node-cron is only a BACKUP: it stops the moment the host sleeps (a free-tier
   * host sleeps after inactivity), so an EXTERNAL 5-minute scheduler should ping
   * this endpoint to keep the evidence flowing without a permanently-awake
   * process. See the README for the exact free-scheduler setup.
   *
   * Hardened:
   *   - secret-gated, accepted ONLY from `Authorization: Bearer <secret>`
   *     (`LIVE_STATS_SECRET`, falling back to `SETTLEMENT_CRON_SECRET`), compared
   *     in constant time → 401 on a missing, short or wrong secret;
   *   - per-IP rate limited (config live.store.sweep.rateLimit);
   *   - safe under concurrency: a sweep already running returns `skipped:true`
   *     (the scheduler's lock) instead of stacking a second sweep;
   *   - bounded per call (`maxGamesPerCall`), so it returns well inside the
   *     host's request timeout and the next call continues from where it stopped
   *     (`truncated:true` reports that).
   *
   * `?dry_run=true` (or `{"dry_run":true}`) performs the SAME matching and grid
   * gating but WRITES NOTHING — no rows, no health, no ledger — and reports what
   * WOULD have been written (`would_log` / `would_settle`). Use it to check the
   * trigger end to end without touching the evidence.
   */
  router.post('/live/sweep', requireStatsAuth, sweepRateLimit, async (req, res) => {
    const traceId = req.traceId || null;
    const dryRun = isTruthy(req.query && req.query.dry_run)
      || isTruthy(req.body && req.body.dry_run);
    try {
      // Reuse the router's matcher (the injected one in tests, else the shared
      // production instance) so the sweep hits the same provider view as resolve.
      const result = await executeShadowSweep({ sportsData, logger, matcher: liveMatcher, dryRun });
      return res.json({ ...(result || { skipped: true }), dry_run: dryRun, traceId });
    } catch (err) {
      logger?.log('error', '[LIVE] on-demand shadow sweep failed', { traceId, dry_run: dryRun, error: err?.message });
      return res.status(503).json({
        error: 'The shadow sweep could not be run.',
        code: 'SWEEP_UNAVAILABLE',
        reason: err?.message || null,
        traceId,
      });
    }
  });

  /**
   * POST /api/live/reconcile — run the DAILY COUNTER RECONCILE now (round J item 5).
   *
   * The counters in `live_shadow/meta` are a CACHE; the rows are the truth. This
   * recounts the rows (`count()` aggregation on Firestore) and compares the
   * result to the counters, recording any drift in the durable health document —
   * /api/live/stats then surfaces it and raises a `counter_drift` alert on any
   * non-zero delta.
   *
   * The in-process node-cron (`0 3 * * *`) is a BACKUP only: a free-tier host
   * sleeps and the cron stops, exactly as for the sweep. This endpoint lets the
   * SAME external scheduler that drives `/api/live/sweep` also drive the
   * reconcile on its own (daily) schedule.
   *
   * Guarded identically to /api/live/sweep: secret-gated from the
   * `Authorization: Bearer <secret>` header ONLY, constant-time compared, and
   * per-IP rate limited. NEVER throws into the request — a reconcile that cannot
   * complete is recorded in health and reported as `ok:false`.
   */
  router.post('/live/reconcile', requireStatsAuth, sweepRateLimit, async (req, res) => {
    const traceId = req.traceId || null;
    try {
      const result = await runShadowReconcile({ logger });
      if (!result) {
        return res.status(503).json({ ok: false, error: 'The reconcile could not be run.', traceId });
      }
      return res.json({
        ok: true,
        drift_detected: result.drift_detected === true,
        total_rows: result.total_rows || null,
        drift: result.drift || null,
        source: result.source || null,
        traceId,
      });
    } catch (err) {
      logger?.log('error', '[LIVE] on-demand reconcile failed', { traceId, error: err?.message });
      return res.status(503).json({
        ok: false,
        error: 'The reconcile could not be run.',
        code: 'RECONCILE_UNAVAILABLE',
        reason: err?.message || null,
        traceId,
      });
    }
  });

  return router;
}

module.exports = { createLiveRouter, DISCLAIMER };
