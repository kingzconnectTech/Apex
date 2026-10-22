/**
 * basketball/scheduler.js
 *
 * Cron-driven runs of the basketball engine:
 *   - morning run   (09:00)  — initial predictions for the day's games, plus the
 *                              Step D 'morning' line snapshot for every one.
 *   - refresh       (every 5 min) — re-runs near tip-off (60-90 min window and
 *                                    again ~15 min out) so confirmed injury
 *                                    reports / starter news are picked up, and
 *                                    captures the t90 / t15 line snapshots. Only
 *                                    changed predictions are written, and a pick
 *                                    that no longer clears the thresholds is voided.
 *   - settlement    (every 20 min) — grades stored picks against final scores.
 *
 * Guarded so a slow run can never overlap itself.
 */

const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const { getPredictions, getFinishedGames } = require('./ingestion');
const {
  saveBasketballPredictions, saveLineSnapshots, resolveSnapshotWindows, withinHorizon,
  settleBasketballPredictions, getBasketballPerformance, deriveMarketPolicy,
} = require('./persistence');
const CONFIG = require('./config');

function startBasketballScheduler({ sportsData, admin, logger = null, leagues = null } = {}) {
  const jobs = [];
  let running = false;

  const runGuarded = async (name, fn) => {
    if (running) {
      logger?.log?.('debug', '[BASKETBALL] scheduler busy, skipping run', { name });
      return;
    }
    running = true;
    const traceId = uuidv4();
    try {
      await fn(traceId);
    } catch (err) {
      logger?.log?.('error', '[BASKETBALL] scheduled run failed', { name, traceId, error: err?.message });
    } finally {
      running = false;
    }
  };

  /**
   * Derive the live auto-downgrade policy from rolling performance. A failure
   * here must never block prediction generation, so it degrades to no policy.
   */
  const currentPolicy = async (traceId) => {
    const ad = CONFIG.selection?.autoDowngrade || {};
    if (ad.enabled === false || !admin) return null;
    try {
      const report = await getBasketballPerformance(admin, { window: ad.window ?? 100 });
      const policy = deriveMarketPolicy(report, CONFIG).status;
      const nonActive = Object.entries(policy).filter(([, s]) => s !== 'active');
      if (nonActive.length) {
        logger?.log?.('warn', '[BASKETBALL] auto-downgrade active', { traceId, policy: Object.fromEntries(nonActive) });
      }
      return policy;
    } catch (err) {
      logger?.log?.('warn', '[BASKETBALL] performance lookup failed; continuing with no policy', { traceId, error: err?.message });
      return null;
    }
  };

  /**
   * Step D: record the line/odds the engine just saw. The morning run writes one
   * 'morning' snapshot per game per day; the pre-tip refresh writes the anchored
   * t90 / t15 snapshots for whichever games are currently inside those windows.
   * A failure here must never break prediction generation.
   */
  const captureSnapshots = async (name, predictions, traceId) => {
    const ls = CONFIG.lineSnapshots || {};
    if (ls.enabled === false || !admin) return;
    const now = Date.now();
    const live = (predictions || []).filter(p => p?.gameId && withinHorizon(p, now, ls));
    if (!live.length) return;
    try {
      if (name === 'morning') {
        const res = await saveLineSnapshots(admin, live, { label: 'morning', logger });
        logger?.log?.('info', '[BASKETBALL] line snapshots captured', { traceId, window: 'morning', ...res });
        return;
      }
      for (const [label, preds] of resolveSnapshotWindows(live, now, ls)) {
        const res = await saveLineSnapshots(admin, preds, { label, logger });
        logger?.log?.('info', '[BASKETBALL] line snapshots captured', { traceId, window: label, ...res });
      }
    } catch (err) {
      logger?.log?.('warn', '[BASKETBALL] line snapshot pass failed', { traceId, name, error: err?.message });
    }
  };

  const refresh = (name) => runGuarded(name, async (traceId) => {
    const marketPolicy = await currentPolicy(traceId);
    const predictions = await getPredictions({ sportsData, leagues, marketPolicy, traceId });
    const res = await saveBasketballPredictions(admin, predictions, { logger });
    logger?.log?.('info', '[BASKETBALL] predictions refreshed', { name, traceId, games: predictions.length, ...res });
    await captureSnapshots(name, predictions, traceId);
  });

  const settle = () => runGuarded('settle', async (traceId) => {
    const results = await getFinishedGames({ sportsData, leagues, traceId });
    if (!results.length) return;
    const res = await settleBasketballPredictions(admin, results, { logger });
    logger?.log?.('info', '[BASKETBALL] settlement pass complete', { traceId, games: results.length, ...res });
  });

  jobs.push(cron.schedule('0 9 * * *', () => refresh('morning')));
  jobs.push(cron.schedule(CONFIG.lineSnapshots?.refreshCron || '*/10 * * * *', () => refresh('pre-tip')));
  jobs.push(cron.schedule('*/20 * * * *', settle));

  logger?.log?.('info', '[BASKETBALL] scheduler started', { jobs: jobs.length });
  return jobs;
}

module.exports = { startBasketballScheduler };
