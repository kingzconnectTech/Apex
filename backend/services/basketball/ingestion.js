/**
 * basketball/ingestion.js
 *
 * Pulls basketball fixtures, odds, injuries and team game logs through the
 * EXISTING ESPN provider (no new data layer) and runs the prediction pipeline.
 *
 * Everything is bounded: a small concurrency limiter avoids hammering the
 * upstream, and the provider itself handles caching, retry/backoff and dedup.
 */

const { EspnProvider } = require('../providers/EspnProvider');
const { getLeagueConfig, listLeagues } = require('./leagues');
const { analyzeGame, formatPrediction } = require('./index');
const CONFIG = require('./config');

/** Run async `fn` over `items` with at most `limit` in flight. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        out[i] = { error: err?.message || String(err) };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

function espnPaths(leagueCfg) {
  const [sport, league] = String(leagueCfg.espnPath).split('/');
  return { sport, league };
}

function sameDay(iso, dateStr) {
  if (!iso || !dateStr) return true;
  return String(iso).slice(0, 10) === String(dateStr).slice(0, 10);
}

/** Fetch today's (or a given date's) basketball fixtures for one league. */
async function fetchFixtures({ sportsData, leagueCfg, date = null, traceId = null }) {
  const { sport, league } = espnPaths(leagueCfg);
  const fixtures = await sportsData.espn.getFixtures(sport, league, {
    traceId,
    leagueDisplayName: leagueCfg.label,
  });
  if (!date) return fixtures || [];
  return (fixtures || []).filter(f => sameDay(f?.fixture?.date, date));
}

/**
 * Analyse a single fixture: summary (odds + injuries) and both team schedules.
 * @returns {Object|null} analyzeGame() result
 */
async function processFixture({ sportsData, leagueCfg, fixture, traceId = null, cfg = CONFIG, eloRatings = null, calibrator = null, marketPolicy = null, context = null }) {
  const { espn } = sportsData;
  const { sport, league } = espnPaths(leagueCfg);
  const eventId = fixture?.fixture?.id;
  const homeId = fixture?.homeTeam?.id;
  const awayId = fixture?.awayTeam?.id;
  if (!eventId || !homeId || !awayId) {
    return { error: `Missing fixture data: eventId=${eventId}, homeId=${homeId}, awayId=${awayId}` };
  }

  const [summary, homeSched, awaySched] = await Promise.all([
    espn.getMatchSummary(sport, league, eventId, { traceId }),
    espn.getTeamSchedule(sport, league, homeId, { traceId }),
    espn.getTeamSchedule(sport, league, awayId, { traceId }),
  ]);

  const odds = EspnProvider.extractBasketballOdds(summary);
  const injuries = EspnProvider.extractBasketballInjuries(summary);
  const homeLog = espn.processBasketballScheduleForTeam(homeSched?.events || [], homeId);
  const awayLog = espn.processBasketballScheduleForTeam(awaySched?.events || [], awayId);

  try {
    const result = analyzeGame({
      fixture,
      odds,
      injuries,
      homeLog,
      awayLog,
      league: leagueCfg.key,
      context,
      eloRatings,
      calibrator,
      marketPolicy,
      cfg,
    });
    if (!result) {
      return { error: `analyzeGame returned null for fixture ${eventId}` };
    }
    return result;
  } catch (err) {
    return { error: `analyzeGame failed for fixture ${eventId}: ${err.message}` };
  }
}

/**
 * Produce predictions for a set of leagues (defaults to all enabled leagues).
 *
 * @param {Object} params
 * @param {Object} params.sportsData - SportsDataService instance
 * @param {string[]} [params.leagues] - league keys/aliases
 * @param {string} [params.date]      - YYYY-MM-DD filter
 * @param {number} [params.concurrency]
 * @param {Object} [params.calibrator]
 * @param {Object} [params.eloRatings]
 * @param {string} [params.traceId]
 * @param {Object} [params.cfg]
 * @returns {Promise<Array>} formatted predictions
 */
async function getPredictions({
  sportsData, leagues = null, date = null, concurrency = 4,
  calibrator = null, eloRatings = null, marketPolicy = null, traceId = null, cfg = CONFIG,
}) {
  const leagueCfgs = (leagues && leagues.length ? leagues.map(getLeagueConfig) : listLeagues());
  const out = [];

  for (const leagueCfg of leagueCfgs) {
    const fixtures = await fetchFixtures({ sportsData, leagueCfg, date, traceId }).catch(() => []);
    const analyzed = await mapLimit(fixtures, concurrency, (fixture) => processFixture({
      sportsData, leagueCfg, fixture, traceId, cfg, eloRatings, calibrator, marketPolicy,
    }));
    analyzed.filter(Boolean).forEach(r => {
      if (r.error) {
        console.warn(`[Basketball] Fixture processing error:`, r.error);
        return;
      }
      const formatted = formatPrediction(r);
      if (formatted) out.push(formatted);
    });
  }

  return out;
}

/** Analyse a single game by id (used by GET /basketball/predictions/:gameId). */
async function getGamePrediction({ sportsData, gameId, league, traceId = null, cfg = CONFIG, calibrator = null }) {
  const leagueCfg = getLeagueConfig(league);
  const fixtures = await fetchFixtures({ sportsData, leagueCfg, traceId });
  const fixture = fixtures.find(f => String(f?.fixture?.id) === String(gameId));
  if (!fixture) return null;
  const result = await processFixture({ sportsData, leagueCfg, fixture, traceId, cfg, calibrator });
  return result ? { result, formatted: formatPrediction(result) } : null;
}

/**
 * Collect completed games (with final scores) so stored predictions can be settled.
 * @returns {Promise<Array>} [{ gameId, league, homeScore, awayScore }]
 */
async function getFinishedGames({ sportsData, leagues = null, date = null, traceId = null }) {
  const leagueCfgs = (leagues && leagues.length ? leagues.map(getLeagueConfig) : listLeagues());
  const out = [];

  for (const leagueCfg of leagueCfgs) {
    const fixtures = await fetchFixtures({ sportsData, leagueCfg, date, traceId }).catch(() => []);
    fixtures
      .filter(f => f?.fixture?.status === 'finished')
      .forEach(f => {
        const homeScore = f.homeTeam?.score;
        const awayScore = f.awayTeam?.score;
        if (homeScore == null || awayScore == null) return;
        out.push({ gameId: f.fixture.id, league: leagueCfg.key, homeScore: Number(homeScore), awayScore: Number(awayScore) });
      });
  }

  return out;
}

module.exports = {
  mapLimit,
  sameDay,
  fetchFixtures,
  processFixture,
  getPredictions,
  getGamePrediction,
  getFinishedGames,
};
