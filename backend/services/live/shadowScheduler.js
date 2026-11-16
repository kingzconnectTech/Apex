/**
 * live/shadowScheduler.js
 *
 * Phase 9 — the shadow scheduler.
 *
 * The forward log is otherwise written only when a user resolves or polls a
 * game, so a sport held in SHADOW would gather evidence at whatever rate it
 * happens to be requested — and none at all if nobody asks. That is not a
 * sample anyone can gate a release on.
 *
 * This job sweeps the configured leagues of every shadow sport on a fixed cron
 * cadence and, INDEPENDENT of any user request:
 *   - for each LIVE game, builds the same production analysis the API would,
 *     and records the WITHHELD winner probability as a shadow row (its
 *     timestamp, the ESPN data age, the score-and-time baseline and the
 *     early/mid/late bucket all ride along — see services/live/forwardTest);
 *   - for each FINISHED game, settles its rows with the final outcome.
 *
 * The cron runs every five minutes; the log dedupes on (probability, clock,
 * period), so each tick that the clock has moved — and each quarter change —
 * is a new checkpoint, giving both the "every 5 minutes" and "every quarter"
 * cadences from one job.
 *
 * Nothing here ships: a shadow sport is withheld from every client, so this job
 * only collects evidence. It never throws on a provider error — a failed sweep
 * is logged and the next tick tries again.
 *
 * Guarded like basketball/scheduler.js so a slow sweep can never overlap itself.
 */

const cron = require('node-cron');
const crypto = require('crypto');

const CONFIG = require('./config');
const { createLiveMatcher } = require('./matcher');
const { buildLiveGame } = require('./liveGame');
const { buildAnalysis, recordForwardTest, settleForwardTest } = require('./analysis');
const policy = require('./policy');
const shadowHealth = require('./shadowHealth');
const forwardTest = require('./forwardTest');

/**
 * Build the matcher the sweep uses: the injected one (tests) or a fresh
 * production matcher from the sports-data service.
 */
function matcherFor({ sportsData = null, logger = null, matcher = null } = {}) {
  if (matcher && typeof matcher.listLeagueFixtures === 'function') return matcher;
  if (sportsData && sportsData.espn) {
    return createLiveMatcher({ espn: sportsData.espn, pitchApi: sportsData.pitchApi, logger });
  }
  return null;
}

/**
 * Run ONE shadow sweep and return its tally.
 *
 * This is the body the cron calls, factored out so the same work can also be
 * triggered ON DEMAND (POST /api/live/sweep). That matters because the sweep is
 * an in-process cron: if the host sleeps — as a free-tier host does after a
 * period of inactivity — the cron stops firing and no evidence is collected. An
 * external scheduler pinging the endpoint keeps the evidence flowing without
 * needing the process to stay permanently awake.
 *
 * @param {Object} deps
 * @param {Object} [deps.sportsData] SportsDataService (needs `.espn`)
 * @param {Object} [deps.logger]
 * @param {Object} [deps.matcher]  createLiveMatcher() instance (tests)
 * @param {number} [deps.now]
 * @param {boolean} [deps.dryRun] Round H (item 2) — run the matcher and the grid
 *   gating and report what WOULD be written, but write NOTHING. The returned
 *   `would_log` / `would_settle` are the counts; `logged` / `settled` stay 0.
 * @returns {Promise<{traceId:string, sports:string[], live_games:number, logged:number, settled:number, truncated:boolean, dry_run?:boolean, would_log?:number, would_settle?:number}>}
 * @throws when no matcher is available (the caller decides how to surface it)
 */
async function runLiveShadowSweep({ sportsData = null, logger = null, matcher = null, now = Date.now(), dryRun = false } = {}) {
  const liveMatcher = matcherFor({ sportsData, logger, matcher });
  if (!liveMatcher) throw new Error('no matcher available');

  const traceId = crypto.randomUUID();
  const sports = policy.shadowSports();
  const sweepCfg = CONFIG.matcher.sweep || {};
  // Round G (item 2) — bound ONE call so the on-demand trigger always returns
  // well inside the host's request timeout. When the cap is hit the remaining
  // games are left for the next call, reported as `truncated:true`.
  const maxGames = (CONFIG.live.store && CONFIG.live.store.sweep
    && Number.isFinite(CONFIG.live.store.sweep.maxGamesPerCall))
    ? CONFIG.live.store.sweep.maxGamesPerCall : 12;
  let live_games = 0;
  let logged = 0;
  let settled = 0;
  let truncated = false;
  // The budget counts games that do REAL work (settle or log a NEW row) — not
  // every candidate examined. A game already logged at this checkpoint returns
  // null and must not spend the cap, otherwise a sweep whose first candidates
  // are settled/no-op would stop early and never reach the games with work,
  // stalling the same way on every call. Capping real work still bounds the
  // call, and an already-logged game is cheap (its row is a no-op).
  let work = 0;

  // Round I (item 2) — gather EVERY eligible game first, then order them
  // LEAST-RECENTLY-LOGGED first (never-logged ahead of everything, provider
  // order within a tie). Without this the budget is always spent on the same
  // leading games — which keep producing new checkpoints as the clock moves —
  // and the tail of the live set is never reached: starved. Ordering by when
  // each game was last logged makes the cap rotate through the live set instead.
  //
  // The stream is collected TOLERANTLY: a provider that throws mid-stream (an
  // interrupted sweep) still contributes what it yielded, and those games are
  // processed before the error is re-thrown below — so the rows logged before
  // the interruption survive exactly as they did before this ordering existed.
  const eligible = [];
  let streamError = null;
  let seq = 0;
  for (const sport of sports) {
    const leagues = Array.isArray(sweepCfg[sport]) ? sweepCfg[sport] : [];
    if (!leagues.length) continue;
    const iterable = await liveMatcher.listLeagueFixtures({ sport, leagues, traceId });
    try {
      for (const candidate of iterable) {
        const status = candidate.fixture && candidate.fixture.fixture
          ? candidate.fixture.fixture.status
          : null;
        if (status !== 'live' && status !== 'finished') continue;
        const game = buildLiveGame({ candidate, parsed: null, fetchedAt: now, now });
        eligible.push({ game, status, seq: seq++ });
      }
    } catch (err) {
      streamError = err;
      break;
    }
  }

  eligible.sort((a, b) => {
    const la = forwardTest.lastLoggedAt(a.game.game_id);
    const lb = forwardTest.lastLoggedAt(b.game.game_id);
    const va = la == null ? -Infinity : la;
    const vb = lb == null ? -Infinity : lb;
    if (va !== vb) return va - vb;
    return a.seq - b.seq;
  });

  for (const { game, status } of eligible) {
    // Stop once this call has produced `maxGames` units of real work; the
    // remainder is left for the next call.
    if (work >= maxGames) { truncated = true; break; }

    if (status === 'finished') {
      // Round J (item 3) — AWAIT the settlement. After a restart the rows are
      // NOT in memory (Firestore loads only the counters), so `settleForwardTest`
      // fetches that one game's rows and returns a PROMISE. Not awaiting it made
      // the sweep report `settled: 0` and — worse — let the sweep's batch close
      // BEFORE the settlement landed, so a host that slept straight after the
      // sweep could lose the outcome. Awaiting folds both into the one write.
      const settledRows = await settleForwardTest({ game, now, dryRun });
      const n = Number(settledRows) || 0;
      if (n > 0) { settled += n; work++; }
      continue;
    }

    live_games++;
    // Exactly the production path: build the same payload the API would, so
    // the shadow figure is the figure users WOULD have been shown.
    const analysis = buildAnalysis({ game, now, fetchedAt: now });
    // dryRun still runs the full path (matching + grid gating) and returns the
    // row that WOULD be written, so `logged` is a would-write count while
    // nothing is mutated. The caller relabels it `would_log` below.
    const row = recordForwardTest({ game, analysis, now, dryRun });
    if (row) { logged++; work++; }
  }

  // A mid-stream provider error surfaces only AFTER the partial stream has been
  // processed, so an interrupted sweep keeps every row it managed to log.
  if (streamError) throw streamError;

  if (dryRun) {
    // Nothing was written: report the would-write counts explicitly and leave
    // `logged` / `settled` at 0 so a consumer can never mistake a dry run for a
    // real one.
    return { traceId, sports, live_games, logged: 0, settled: 0, truncated, dry_run: true, would_log: logged, would_settle: settled };
  }
  return { traceId, sports, live_games, logged, settled, truncated };
}

/** Overlap guard: the cron and an external trigger share this so two sweeps
 *  can never run at once (a slow provider would otherwise double up the work). */
let busy = false;

/**
 * Run one sweep WITH health instrumentation and the overlap guard.
 *
 * This is the single entry point both the cron and the on-demand endpoint use,
 * so /api/live/stats reports the same state whichever path drove the run.
 *
 * @param {boolean} [deps.dryRun] Round H (item 2) — run the matcher and the grid
 *   gating and return the would-write counts WITHOUT writing anything: no rows,
 *   no health state, no ledger. It still respects the overlap guard.
 * @returns {Promise<Object|null>} the tally, or null when a sweep was already running
 * @throws when the sweep itself fails (the error is recorded first)
 */
async function executeShadowSweep({ sportsData = null, logger = null, matcher = null, dryRun = false } = {}) {
  // A dry run must touch NOTHING durable — not even the health document — so it
  // bypasses every write path here and returns the would-write tally directly.
  // It still respects the overlap guard: stacking a dry run on a live sweep would
  // double the provider load for no reason.
  if (dryRun) {
    if (busy) return { skipped: true, dry_run: true, reason: 'a sweep is already running' };
    return runLiveShadowSweep({ sportsData, logger, matcher, now: Date.now(), dryRun: true });
  }
  shadowHealth.init();
  shadowHealth.markStarted();
  if (busy) {
    logger?.log?.('debug', '[LIVE][SHADOW] scheduler busy, skipping run');
    return null;
  }
  busy = true;
  const startedMs = shadowHealth.recordSweepStart();
  const traceId = crypto.randomUUID();
  // Round I (item 3) — open ONE batch for the whole sweep. While it is open
  // `forwardTest.flush()` defers, so the rows logged and the counter delta
  // accumulated across every game in this sweep land in a SINGLE meta-document
  // write when the batch closes in `finally`, instead of one write per row / per
  // settled game. That keeps the sweep inside Firestore's single-document write
  // rate. The writes stay idempotent, so a failed flush is retried next sweep.
  forwardTest.beginBatch();
  try {
    const stats = await runLiveShadowSweep({ sportsData, logger, matcher, now: Date.now() });
    shadowHealth.recordSweepDone({ startedMs, stats });
    logger?.log?.('info', '[LIVE][SHADOW] sweep complete', { traceId, ...stats });
    return stats;
  } catch (err) {
    // Round H (item 4) — a sweep interrupted MID-WAY (a provider that throws on
    // a later game, or a caller that gives up) must not lose the rows it already
    // logged. They are flushed once by the batch close in `finally`: the writes
    // are idempotent, so the next sweep re-logs the same checkpoints (same
    // storage key) without duplicating them — it simply resumes. A hard process
    // kill still loses only the rows since the last flush, which the next sweep
    // rebuilds identically.
    shadowHealth.recordError(err);
    logger?.log?.('error', '[LIVE][SHADOW] sweep failed', { traceId, error: err?.message });
    throw err;
  } finally {
    // Close the sweep batch — this is the sweep's ONE durable write (rows +
    // counters). It runs on success AND on the interrupted path, so a partial
    // sweep's rows are still made durable.
    try { await Promise.resolve(forwardTest.endBatch()); } catch (err) { /* next sweep retries */ }
    busy = false;
  }
}

/**
 * Start the shadow scheduler.
 *
 * @param {Object} deps
 * @param {Object} deps.sportsData SportsDataService (needs `.espn`)
 * @param {Object} [deps.logger]
 * @param {Object} [deps.matcher]  createLiveMatcher() instance (tests)
 * @returns {Array} the scheduled cron jobs (empty when nothing is scheduled)
 */
function startLiveShadowScheduler({ sportsData = null, logger = null, matcher = null } = {}) {
  const shadow = CONFIG.live && CONFIG.live.shadow;
  const sched = shadow && shadow.scheduler;
  if (!shadow || shadow.enabled === false) return [];
  if (!sched || sched.enabled === false) return [];

  // The matcher is resolved up front only to decide whether the scheduler can
  // start at all; the shadow sports are still recomputed at each run so
  // releasing a sport needs no restart to stop the job logging it.
  const liveMatcher = matcherFor({ sportsData, logger, matcher });
  if (!liveMatcher) {
    logger?.log?.('warn', '[LIVE][SHADOW] scheduler not started: no matcher available');
    return [];
  }

  const jobs = [];
  jobs.push(cron.schedule(sched.cron || '*/5 * * * *', () =>
    // The cron path swallows the error: executeShadowSweep already recorded it,
    // and the next tick tries again. The returned promise is already settled by
    // this catch, so awaiting it (tests) can never reject, and leaving it
    // unhandled (production cron) can never crash the app.
    executeShadowSweep({ sportsData, logger, matcher: liveMatcher }).catch(() => {})));
  logger?.log?.('info', '[LIVE][SHADOW] scheduler started', { cron: sched.cron, sports: policy.shadowSports() });
  return jobs;
}

/**
 * Round J (item 5) — run the DAILY RECONCILE.
 *
 * The counters in `live_shadow/meta` are a CACHE; the rows are the truth. This
 * recounts the rows (`count()` aggregation on Firestore, the local set on file)
 * and compares the result to the counters, recording the drift in the durable
 * health document so /api/live/stats surfaces it and raises a `counter_drift`
 * alert on any non-zero delta. A CLEAN recount is recorded too, so the alert
 * clears once the drift is gone.
 *
 * NEVER throws: a reconcile that cannot complete is recorded (as a reconcile
 * error, distinct from a sweep error) and the next run retries.
 *
 * @returns {Promise<Object|null>} the store.reconcile() result, or null on error
 */
async function runShadowReconcile({ logger = null } = {}) {
  shadowHealth.init();
  try {
    const result = await forwardTest.reconcile();
    const drift = (result && result.drift) || null;
    const detected = Boolean(result && result.drift_detected);
    shadowHealth.recordReconcile({ result, drift, detected });
    // Round J (item 5) — /api/live/stats reads the DURABLE health document, so the
    // reconcile must leave its result committed before it reports back; otherwise
    // a reader can see a stale (or missing) reconcile on the Firestore backend,
    // where the health write is asynchronous.
    await shadowHealth.persistReady();
    if (detected) {
      logger?.log?.('error', '[LIVE][SHADOW] counter drift detected', { drift });
    } else {
      logger?.log?.('info', '[LIVE][SHADOW] reconcile clean', {
        source: result && result.source, total_rows: result && result.total_rows,
      });
    }
    return result;
  } catch (err) {
    shadowHealth.recordReconcileError(err);
    await shadowHealth.persistReady();
    logger?.log?.('error', '[LIVE][SHADOW] reconcile failed', { error: err?.message });
    return null;
  }
}

/**
 * Round J (item 5) — start the DAILY RECONCILE job.
 *
 * Governed by the same `shadow.enabled` switch as the sweep scheduler, plus its
 * own `shadow.reconcile` block, so releasing/stopping shadow stops both. The
 * cron path swallows the error (runShadowReconcile already recorded it) and the
 * next day retries.
 *
 * @returns {Array} the scheduled cron jobs (empty when nothing is scheduled)
 */
function startLiveShadowReconcile({ logger = null } = {}) {
  const shadow = CONFIG.live && CONFIG.live.shadow;
  const rec = shadow && shadow.reconcile;
  if (!shadow || shadow.enabled === false) return [];
  if (!rec || rec.enabled === false) return [];

  const job = cron.schedule(rec.cron || '0 3 * * *', () =>
    runShadowReconcile({ logger }).catch(() => {}));
  logger?.log?.('info', '[LIVE][SHADOW] reconcile job started', { cron: rec.cron || '0 3 * * *' });
  return [job];
}

module.exports = {
  startLiveShadowScheduler,
  startLiveShadowReconcile,
  runLiveShadowSweep,
  runShadowReconcile,
  executeShadowSweep,
};

