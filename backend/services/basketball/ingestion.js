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

/** Error codes returned by getGamePrediction() so callers can map a status. */
const ERROR_CODES = {
  INVALID_LEAGUE: 'INVALID_LEAGUE',
  INVALID_GAME_ID: 'INVALID_GAME_ID',
  NO_SUMMARY: 'NO_SUMMARY',
  NO_FIXTURE_DATA: 'NO_FIXTURE_DATA',
  GENERATION_FAILURE: 'GENERATION_FAILURE',
  UPSTREAM_FAILURE: 'UPSTREAM_FAILURE',
};

/**
 * Build the internal fixture shape from an ESPN match summary.
 *
 * ESPN's basketball summary endpoint nests the game under
 * `header.competitions[0]` (with venue in `gameInfo.venue`) and exposes no
 * top-level `event`. Older/normalised payloads may still carry `event`, so both
 * shapes are accepted. Returns null when there is not enough data to identify
 * the game and both teams — never fabricates identifiers.
 *
 * @param {Object} summary  - raw ESPN summary payload
 * @param {string} gameId   - requested game id (fallback for the fixture id)
 * @param {Object} leagueCfg - league config (for the display label)
 * @returns {Object|null}
 */
function fixtureFromSummary(summary, gameId, leagueCfg) {
  const event = summary?.event || null;
  const comp = event?.competitions?.[0] || summary?.header?.competitions?.[0] || null;
  if (!comp) return null;

  const toTeam = (homeAway) => {
    const c = (comp.competitors || []).find(x => x?.homeAway === homeAway);
    if (!c) return null;
    // ESPN may send `score` as a number, as { value }, or as { displayValue }.
    // Anything unparseable stays null — a scheduled game has no score.
    let rawScore = c.score?.value ?? c.score ?? null;
    if (rawScore && typeof rawScore === 'object') {
      rawScore = rawScore.value ?? rawScore.displayValue ?? null;
    }
    const numScore = rawScore == null || rawScore === '' ? null : Number(rawScore);
    const id = c.team?.id ?? c.id ?? null;
    return {
      id: id == null ? null : String(id),
      name: c.team?.displayName || c.team?.name || c.team?.shortDisplayName || null,
      logo: c.team?.logo || null,
      score: Number.isFinite(numScore) ? numScore : null,
    };
  };

  const homeTeam = toTeam('home');
  const awayTeam = toTeam('away');
  if (!homeTeam?.id || !awayTeam?.id) return null;

  const date = comp.date || event?.date || null;

  return {
    fixture: {
      id: String(summary?.header?.id || event?.id || gameId),
      date,
      timestamp: date ? new Date(date).getTime() : null,
      status: comp.status?.type?.state || event?.status?.type?.state || 'scheduled',
      venue: summary?.gameInfo?.venue?.fullName || comp.venue?.fullName || null,
    },
    homeTeam,
    awayTeam,
    league: leagueCfg.label,
  };
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

/**
 * Analyse a single game by id (used by GET /basketball/predictions/:gameId and
 * POST /api/match-prediction).
 *
 * @returns {Promise<{result:Object, formatted:Object}|{error:{code:string,message:string}}>}
 *   Success: `{ result, formatted }`. Failure: `{ error }` with a machine-readable
 *   `code` from ERROR_CODES so callers can distinguish an unreadable/empty
 *   upstream payload from an insufficient-data or engine failure.
 */
async function getGamePrediction({ sportsData, gameId, league, traceId = null, cfg = CONFIG, calibrator = null }) {
  if (gameId == null || String(gameId).trim() === '') {
    return { error: { code: ERROR_CODES.INVALID_GAME_ID, message: 'A game id is required.' } };
  }

  let leagueCfg;
  try {
    leagueCfg = getLeagueConfig(league);
  } catch (err) {
    return { error: { code: ERROR_CODES.INVALID_LEAGUE, message: err.message } };
  }

  const { espn } = sportsData;
  const { sport, league: leaguePath } = espnPaths(leagueCfg);

  let summary;
  try {
    summary = await espn.getMatchSummary(sport, leaguePath, gameId, { traceId });
  } catch (err) {
    console.error(`[Basketball] Summary request failed for game ${gameId}:`, err.message);
    return {
      error: {
        code: ERROR_CODES.UPSTREAM_FAILURE,
        message: `ESPN summary request failed for game ${gameId}: ${err.message}`,
      },
    };
  }

  if (!summary) {
    console.warn(`[Basketball] No match summary found for game ${gameId} in ${leagueCfg.label}`);
    return {
      error: {
        code: ERROR_CODES.NO_SUMMARY,
        message: `No ESPN summary returned for game ${gameId} in ${leagueCfg.label}.`,
      },
    };
  }

  const fixture = fixtureFromSummary(summary, gameId, leagueCfg);
  if (!fixture) {
    console.warn(`[Basketball] Summary for game ${gameId} has no competition/competitor data`);
    return {
      error: {
        code: ERROR_CODES.NO_FIXTURE_DATA,
        message: `ESPN summary for game ${gameId} is missing competition or competitor data.`,
      },
    };
  }

  let result;
  try {
    result = await processFixture({ sportsData, leagueCfg, fixture, traceId, cfg, calibrator });
  } catch (err) {
    console.error(`[Basketball] Failed to get prediction for game ${gameId}:`, err.message);
    return {
      error: {
        code: ERROR_CODES.GENERATION_FAILURE,
        message: `Prediction pipeline failed for game ${gameId}: ${err.message}`,
      },
    };
  }

  if (!result || result.error) {
    const detail = result?.error || 'engine returned no result';
    console.warn(`[Basketball] Prediction generation failed for game ${gameId}: ${detail}`);
    return {
      error: {
        code: ERROR_CODES.GENERATION_FAILURE,
        message: `Could not generate a prediction for game ${gameId}: ${detail}`,
      },
    };
  }

  const formatted = formatPrediction(result);
  if (!formatted) {
    return {
      error: {
        code: ERROR_CODES.GENERATION_FAILURE,
        message: `Could not format the prediction for game ${gameId}.`,
      },
    };
  }

  return { result, formatted };
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
  fixtureFromSummary,
  ERROR_CODES,
  fetchFixtures,
  processFixture,
  getPredictions,
  getGamePrediction,
  getFinishedGames,
};
