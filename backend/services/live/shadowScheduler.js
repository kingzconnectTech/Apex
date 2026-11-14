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
const { v4: uuidv4 } = require('uuid');

const CONFIG = require('./config');
const { createLiveMatcher } = require('./matcher');
const { buildLiveGame } = require('./liveGame');
const { buildAnalysis, recordForwardTest, settleForwardTest } = require('./analysis');
const policy = require('./policy');

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

  // The shadow sports, minus any that have started shipping. Computed at each
  // run, not once at startup, so releasing a sport needs no restart to stop the
  // job logging a pick that is now live.
  const liveMatcher = matcher || (sportsData && sportsData.espn
    ? createLiveMatcher({ espn: sportsData.espn, pitchApi: sportsData.pitchApi, logger })
    : null);
  if (!liveMatcher || typeof liveMatcher.listLeagueFixtures !== 'function') {
    logger?.log?.('warn', '[LIVE][SHADOW] scheduler not started: no matcher available');
    return [];
  }

  const sweepCfg = CONFIG.matcher.sweep || {};
  let running = false;

  const runGuarded = async (fn) => {
    if (running) {
      logger?.log?.('debug', '[LIVE][SHADOW] scheduler busy, skipping run');
      return;
    }
    running = true;
    const traceId = uuidv4();
    try {
      await fn(traceId);
    } catch (err) {
      logger?.log?.('error', '[LIVE][SHADOW] sweep failed', { traceId, error: err?.message });
    } finally {
      running = false;
    }
  };

  const sweep = () => runGuarded(async (traceId) => {
    const sports = policy.shadowSports();
    if (!sports.length) return;

    const now = Date.now();
    let live_games = 0;
    let logged = 0;
    let settled = 0;

    for (const sport of sports) {
      const leagues = Array.isArray(sweepCfg[sport]) ? sweepCfg[sport] : [];
      if (!leagues.length) continue;

      const candidates = await liveMatcher.listLeagueFixtures({ sport, leagues, traceId });
      for (const candidate of candidates) {
        const status = candidate.fixture && candidate.fixture.fixture
          ? candidate.fixture.fixture.status
          : null;
        if (status !== 'live' && status !== 'finished') continue;

        const game = buildLiveGame({ candidate, parsed: null, fetchedAt: now, now });

        if (status === 'finished') {
          settled += settleForwardTest({ game, now });
          continue;
        }

        live_games++;
        // Exactly the production path: build the same payload the API would, so
        // the shadow figure is the figure users WOULD have been shown.
        const analysis = buildAnalysis({ game, now, fetchedAt: now });
        const row = recordForwardTest({ game, analysis, now });
        if (row) logged++;
      }
    }

    logger?.log?.('info', '[LIVE][SHADOW] sweep complete', {
      traceId, sports, live_games, logged, settled,
    });
  });

  const jobs = [];
  jobs.push(cron.schedule(sched.cron || '*/5 * * * *', sweep));
  logger?.log?.('info', '[LIVE][SHADOW] scheduler started', { cron: sched.cron, sports: policy.shadowSports() });
  return jobs;
}

module.exports = { startLiveShadowScheduler };
