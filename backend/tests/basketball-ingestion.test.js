/**
 * Basketball ingestion tests.
 *
 * Covers the path that was broken in production:
 *   ESPN summary -> fixture extraction -> team game logs -> engine -> formatted output.
 *
 * ESPN's basketball summary nests the game under `header.competitions[0]` (with
 * the venue under `gameInfo`) and has NO top-level `event` — reading
 * `summary.event` was the original bug, so both shapes are asserted here.
 *
 * All upstream calls are mocked with realistic ESPN payloads; the parsers
 * (extractBasketballOdds / extractBasketballInjuries /
 * processBasketballScheduleForTeam) are the real implementations.
 */

const { EspnProvider } = require('../services/providers/EspnProvider');
const { sharedCache } = require('../services/providers/cache');
const { normalizeBoxScore, buildPriorRatings } = require('../services/basketball/normalize');
const { getLeagueConfig } = require('../services/basketball/leagues');
const CONFIG = require('../services/basketball/config');
const {
  fetchFixtures,
  fixtureFromSummary,
  getGamePrediction,
  getPredictions,
  processFixture,
  espnSeasonYear,
  ERROR_CODES,
} = require('../services/basketball/ingestion');

const HOME_ID = '13';
const AWAY_ID = '2';
const GAME_ID = '401';
const TIPOFF = '2026-10-22T23:00:00.000Z';

/** Real ESPN stat entries are { name|label, displayValue|value }. */
const stat = (name, value) => ({ name, displayValue: String(value) });

function boxStats({ fgm, fga = 88, tpm = 12, tpa = 32, ftm = 18, fta = 22, orb = 10, drb = 32, tov = 13 }) {
  return [
    stat('fieldGoalsMade', fgm), stat('fieldGoalsAttempted', fga),
    stat('threePointFieldGoalsMade', tpm), stat('threePointFieldGoalsAttempted', tpa),
    stat('freeThrowsMade', ftm), stat('freeThrowsAttempted', fta),
    stat('offensiveRebounds', orb), stat('defensiveRebounds', drb),
    stat('totalRebounds', orb + drb), stat('assists', 25),
    stat('turnovers', tov), stat('steals', 8), stat('blocks', 5), stat('fouls', 19),
  ];
}

function competitor(teamId, name, { home = false, score = null, stats = null } = {}) {
  return {
    id: teamId,
    homeAway: home ? 'home' : 'away',
    team: { id: teamId, displayName: name, abbreviation: name.slice(0, 3).toUpperCase() },
    score: score == null ? undefined : { value: score },
    statistics: stats || [],
  };
}

/** One completed ESPN schedule event. */
function completedEvent(id, isoDate, home, away) {
  return {
    id: String(id),
    date: isoDate,
    competitions: [{
      status: { type: { state: 'post' } },
      competitors: [home, away],
    }],
  };
}

/**
 * A team's last `n` games (newest first). `opponentId` defaults to a neutral
 * third team so the two logs never accidentally create head-to-head games.
 */
function scheduleFor(teamId, name, n, { pf = 112, pa = 108, opponentId = '99', includeH2H = false } = {}) {
  const events = [];
  for (let i = 0; i < n; i += 1) {
    const opponent = includeH2H && i === 0 ? AWAY_ID : opponentId;
    const oppName = opponent === AWAY_ID ? 'Away Aces' : 'Other Team';
    const home = i % 2 === 0;
    const ts = new Date(Date.parse(TIPOFF) - (i + 1) * 2 * 86400000).toISOString();
    const us = competitor(teamId, name, { home, score: pf, stats: boxStats({ fgm: 42 }) });
    const them = competitor(opponent, oppName, { home: !home, score: pa, stats: boxStats({ fgm: 40 }) });
    events.push(completedEvent(1000 + i, ts, home ? us : them, home ? them : us));
  }
  return { events };
}

/** ESPN basketball summary: game under `header.competitions[0]`. */
function summaryPayload({ withOdds = true, withInjuries = true, state = 'pre' } = {}) {
  return {
    header: {
      id: GAME_ID,
      competitions: [{
        date: TIPOFF,
        status: { type: { state } },
        competitors: [
          competitor(HOME_ID, 'Home Hawks', { home: true }),
          competitor(AWAY_ID, 'Away Aces', { home: false }),
        ],
      }],
    },
    gameInfo: { venue: { fullName: 'Test Arena' } },
    pickcenter: withOdds ? [{
      provider: { name: 'ESPN BET' },
      spread: -4.5,
      overUnder: 220.5,
      overOdds: -110,
      underOdds: -110,
      homeTeamOdds: { moneyLine: -180, spreadOdds: -110 },
      awayTeamOdds: { moneyLine: 155, spreadOdds: -110 },
    }] : [],
    injuries: withInjuries ? [{
      team: { id: HOME_ID, displayName: 'Home Hawks' },
      injuries: [{
        athlete: { id: '99', fullName: 'Star Guard', position: { abbreviation: 'PG' } },
        status: 'questionable',
        details: { type: 'Ankle', detail: 'Soreness' },
      }],
    }] : [],
  };
}

/**
 * A prior-season team aggregate in the core-API shape: season TOTALS (points,
 * possessions) which buildPriorRatings converts to per-game ratings.
 */
function priorAggregate({ gamesPlayed = 82, avgPoints = 116.34, possessions = 8242.36 } = {}) {
  return { gamesPlayed, points: avgPoints * gamesPlayed, possessions };
}

/**
 * Real EspnProvider with the network methods replaced by mocks.
 *
 * The prior-season fetches must be mocked too: `mkProvider` instantiates a real
 * provider, so an unmocked getTeamSeasonStatistics / getTeamSeasonSchedule would
 * make genuine HTTP calls from inside the suite. Defaults return "no prior",
 * which is exactly the pre-Phase-1 behaviour.
 */
function mkProvider({
  summary = summaryPayload(), homeSched = null, awaySched = null,
  homePriorStats = null, awayPriorStats = null, priorSchedule = null,
} = {}) {
  const provider = new EspnProvider({ logger: null });
  provider.getMatchSummary = jest.fn().mockResolvedValue(summary);
  provider.getTeamSchedule = jest.fn().mockImplementation((_sport, _league, teamId) => {
    if (String(teamId) === HOME_ID) {
      return Promise.resolve(homeSched || scheduleFor(HOME_ID, 'Home Hawks', 12, { pf: 118, pa: 104 }));
    }
    return Promise.resolve(awaySched || scheduleFor(AWAY_ID, 'Away Aces', 12, { pf: 104, pa: 114 }));
  });
  provider.getTeamSeasonStatistics = jest.fn().mockImplementation((_sport, _league, _season, teamId) => (
    Promise.resolve(String(teamId) === HOME_ID ? homePriorStats : awayPriorStats)
  ));
  // The prior-season schedule supplies points-allowed, which the aggregate omits.
  // It defaults to a full-season log whenever prior stats are supplied, so a test
  // only has to say "this team had a real prior" once.
  provider.getTeamSeasonSchedule = jest.fn().mockImplementation((_sport, _league, _season, teamId) => {
    if (priorSchedule) {
      return Promise.resolve(typeof priorSchedule === 'function' ? priorSchedule(teamId) : priorSchedule);
    }
    if (String(teamId) === HOME_ID && homePriorStats) {
      return Promise.resolve(scheduleFor(HOME_ID, 'Home Hawks', 20, { pf: 116, pa: 111 }));
    }
    if (String(teamId) === AWAY_ID && awayPriorStats) {
      return Promise.resolve(scheduleFor(AWAY_ID, 'Away Aces', 20, { pf: 110, pa: 114 }));
    }
    return Promise.resolve({ events: [] });
  });
  return provider;
}

const mkSportsData = (provider) => ({ espn: provider });

const callGame = (provider, extra = {}) => getGamePrediction({
  sportsData: mkSportsData(provider),
  gameId: GAME_ID,
  league: 'nba',
  ...extra,
});

describe('basketball ingestion — fixture extraction', () => {
  test('parses the real ESPN summary shape (header.competitions[0], gameInfo.venue)', () => {
    const fx = fixtureFromSummary(summaryPayload(), GAME_ID, { label: 'NBA' });

    expect(fx).not.toBeNull();
    expect(fx.fixture.id).toBe(GAME_ID);
    expect(fx.fixture.date).toBe(TIPOFF);
    expect(fx.fixture.status).toBe('pre');
    expect(fx.fixture.venue).toBe('Test Arena');
    expect(fx.league).toBe('NBA');
    expect(fx.homeTeam).toEqual({ id: HOME_ID, name: 'Home Hawks', logo: null, score: null });
    expect(fx.awayTeam).toEqual({ id: AWAY_ID, name: 'Away Aces', logo: null, score: null });
  });

  test('still accepts the legacy top-level event shape', () => {
    const legacy = {
      event: {
        id: 'legacy-1',
        competitions: [{
          status: { type: { state: 'in' } },
          competitors: [
            competitor(HOME_ID, 'Home Hawks', { home: true, score: 55 }),
            competitor(AWAY_ID, 'Away Aces', { home: false, score: 51 }),
          ],
        }],
      },
    };

    const fx = fixtureFromSummary(legacy, 'legacy-1', { label: 'NBA' });
    expect(fx.fixture.id).toBe('legacy-1');
    expect(fx.fixture.status).toBe('in');
    expect(fx.homeTeam.score).toBe(55);
    expect(fx.awayTeam.score).toBe(51);
  });

  test('returns null when there is no competition to read', () => {
    expect(fixtureFromSummary({ header: {} }, GAME_ID, { label: 'NBA' })).toBeNull();
    expect(fixtureFromSummary(null, GAME_ID, { label: 'NBA' })).toBeNull();
  });

  test('returns null when a competitor or its team id is missing', () => {
    const oneSided = {
      header: { competitions: [{ competitors: [competitor(HOME_ID, 'Home Hawks', { home: true })] }] },
    };
    expect(fixtureFromSummary(oneSided, GAME_ID, { label: 'NBA' })).toBeNull();

    const noTeamId = {
      header: {
        competitions: [{
          competitors: [
            { homeAway: 'home', team: { displayName: 'Nameless' } },
            competitor(AWAY_ID, 'Away Aces', { home: false }),
          ],
        }],
      },
    };
    expect(fixtureFromSummary(noTeamId, GAME_ID, { label: 'NBA' })).toBeNull();
  });

  test('never coerces an unparseable score into a number', () => {
    const junk = {
      header: {
        competitions: [{
          competitors: [
            { homeAway: 'home', team: { id: HOME_ID, displayName: 'Home Hawks' }, score: { value: null } },
            { homeAway: 'away', team: { id: AWAY_ID, displayName: 'Away Aces' }, score: { displayValue: 'N/A' } },
          ],
        }],
      },
    };
    const fx = fixtureFromSummary(junk, GAME_ID, { label: 'NBA' });
    expect(fx.homeTeam.score).toBeNull();
    expect(fx.awayTeam.score).toBeNull();
  });
});

describe('basketball ingestion — getGamePrediction failure modes', () => {
  test('a blank game id is rejected before any request', async () => {
    const provider = mkProvider();
    const out = await callGame(provider, { gameId: '  ' });

    expect(out.error.code).toBe(ERROR_CODES.INVALID_GAME_ID);
    expect(provider.getMatchSummary).not.toHaveBeenCalled();
  });

  test('an unknown league is rejected before any request', async () => {
    const provider = mkProvider();
    const out = await callGame(provider, { league: 'not-a-league' });

    expect(out.error.code).toBe(ERROR_CODES.INVALID_LEAGUE);
    expect(provider.getMatchSummary).not.toHaveBeenCalled();
  });

  test('a thrown summary request becomes UPSTREAM_FAILURE (not a silent 404)', async () => {
    const provider = mkProvider();
    provider.getMatchSummary.mockRejectedValue(new Error('socket hang up'));

    const out = await callGame(provider);
    expect(out.error.code).toBe(ERROR_CODES.UPSTREAM_FAILURE);
    expect(out.error.message).toMatch(/socket hang up/);
  });

  test('an empty upstream response becomes NO_SUMMARY', async () => {
    const provider = mkProvider({ summary: null });
    const out = await callGame(provider);

    expect(out.error.code).toBe(ERROR_CODES.NO_SUMMARY);
    expect(out.result).toBeUndefined();
  });

  test('a summary without competition data becomes NO_FIXTURE_DATA', async () => {
    const provider = mkProvider({ summary: { header: { id: GAME_ID } } });
    const out = await callGame(provider);

    expect(out.error.code).toBe(ERROR_CODES.NO_FIXTURE_DATA);
  });

  test('a broken engine configuration becomes GENERATION_FAILURE, never a fake pick', async () => {
    const provider = mkProvider();
    // cfg = null makes the projection stage refuse to run.
    const out = await callGame(provider, { cfg: null });

    expect(out.error.code).toBe(ERROR_CODES.GENERATION_FAILURE);
    expect(out.formatted).toBeUndefined();
  });

  test('processFixture reports the missing identifiers instead of guessing', async () => {
    const provider = mkProvider();
    const out = await processFixture({
      sportsData: mkSportsData(provider),
      leagueCfg: { key: 'nba', label: 'NBA', espnPath: 'basketball/nba' },
      fixture: { fixture: { id: null }, homeTeam: { id: HOME_ID }, awayTeam: { id: null } },
    });

    expect(out.error).toMatch(/Missing fixture data/);
    expect(provider.getMatchSummary).not.toHaveBeenCalled();
  });
});

describe('basketball ingestion — successful prediction', () => {
  test('returns both Total Points and Spread for a well-formed summary', async () => {
    const provider = mkProvider();
    const out = await callGame(provider);

    expect(out.error).toBeUndefined();
    expect(out.result).toBeTruthy();

    const f = out.formatted;
    expect(f.gameId).toBe(GAME_ID);
    expect(f.homeTeam.name).toBe('Home Hawks');
    expect(f.awayTeam.name).toBe('Away Aces');
    expect(Number.isFinite(f.projection.total)).toBe(true);
    expect(Number.isFinite(f.projection.margin)).toBe(true);
    expect(f.data_quality).toBeGreaterThanOrEqual(0);
    expect(f.data_quality).toBeLessThanOrEqual(1);

    const markets = f.picks.map(p => p.market);
    expect(markets).toContain('Total Points');
    expect(markets).toContain('Spread');
    expect(f.noPick).toBe(false);

    f.picks.forEach(p => {
      expect(Number.isFinite(p.probability)).toBe(true);
      expect(p.probability).toBeGreaterThan(0);
      expect(p.probability).toBeLessThan(1);
      expect(Number.isFinite(p.line)).toBe(true);
      expect(typeof p.confidence).toBe('string');
      expect(typeof p.selection).toBe('string');
    });

    // The bookmaker line must be the one supplied by ESPN, not an invented one.
    const total = f.picks.find(p => p.market === 'Total Points');
    expect(total.line).toBe(220.5);
    expect(total.isModelLine).toBe(false);
  });

  test('retrieves historical statistics for BOTH teams and uses them', async () => {
    const provider = mkProvider();
    const out = await callGame(provider);

    const scheduledTeamIds = provider.getTeamSchedule.mock.calls.map(c => String(c[2]));
    expect(scheduledTeamIds).toContain(HOME_ID);
    expect(scheduledTeamIds).toContain(AWAY_ID);

    // The home team scores much more than the away team in the mocked logs, so
    // the projection must reflect the logs rather than league priors.
    expect(out.result.projection.margin).toBeGreaterThan(0);
    expect(out.result.homeForm.last10).toBeTruthy();
    expect(out.result.awayForm.last10).toBeTruthy();
    expect(out.result.dataQuality.score).toBeGreaterThan(0.5);
  });

  test('derives head-to-head games from the home team log when they exist', async () => {
    const provider = mkProvider({
      homeSched: scheduleFor(HOME_ID, 'Home Hawks', 12, { pf: 118, pa: 104, includeH2H: true }),
    });
    const out = await callGame(provider);

    const h2h = out.result.game.h2hStats;
    expect(h2h).toBeTruthy();
    expect(h2h.sampleSize).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(h2h.avgTotal)).toBe(true);

    const totalPick = out.formatted.picks.find(p => p.market === 'Total Points');
    expect(totalPick.reasoning).toMatch(/H2H avg/);
  });

  test('reads injuries from the summary into the engine (no invented players)', async () => {
    const provider = mkProvider();
    const out = await callGame(provider);

    expect(out.result.game.injuries.home).toHaveLength(1);
    expect(out.result.game.injuries.home[0].playerName).toBe('Star Guard');
    expect(out.result.game.injuries.home[0].status).toBe('questionable');
    expect(out.result.game.injuries.away).toHaveLength(0);
  });
});

describe('basketball ingestion — partial data and independent markets', () => {
  test('returns Total Points only when ESPN prices no spread line (markets are independent)', async () => {
    const summary = summaryPayload();
    delete summary.pickcenter[0].spread;
    delete summary.pickcenter[0].homeTeamOdds.spreadOdds;
    delete summary.pickcenter[0].awayTeamOdds.spreadOdds;

    const provider = mkProvider({ summary });
    const cfg = { ...CONFIG, modelLines: { ...CONFIG.modelLines, enabled: false } };

    const out = await callGame(provider, { cfg });
    expect(out.error).toBeUndefined();
    expect(out.formatted.picks.map(p => p.market)).toEqual(['Total Points']);
    expect(out.formatted.noPick).toBe(false);
  });

  test('a policy-disabled market is withheld while the other market is still returned', async () => {
    const provider = mkProvider();
    const out = await processFixture({
      sportsData: mkSportsData(provider),
      leagueCfg: { key: 'nba', label: 'NBA', espnPath: 'basketball/nba' },
      fixture: fixtureFromSummary(summaryPayload(), GAME_ID, { label: 'NBA' }),
      marketPolicy: { Spread: 'disabled' },
    });

    expect(out.error).toBeUndefined();
    expect(out.selection.picks.map(p => p.market)).toEqual(['Total Points']);
    expect(out.selection.noPick).toBe(false);
    expect(out.selection.flags.join(' ')).toMatch(/Spread pick withheld/);
  });

  test('no bookmaker odds yields the projection and no pick (R6)', async () => {
    const provider = mkProvider({ summary: summaryPayload({ withOdds: false }) });
    const out = await callGame(provider);

    expect(out.error).toBeUndefined();
    // R6: no real market line -> nothing is published, but the projection remains.
    expect(out.formatted.marketLine).toBe(false);
    expect(out.formatted.picks).toEqual([]);
    expect(out.formatted.noPick).toBe(true);
    expect(out.formatted.noPickLabel).toBe('no market line');
    expect(Number.isFinite(out.formatted.projection.total)).toBe(true);
  });

  test('with no odds it returns an explicit "no market line" no-pick, not a fabricated one', async () => {
    const provider = mkProvider({ summary: summaryPayload({ withOdds: false }) });
    const cfg = { ...CONFIG, modelLines: { ...CONFIG.modelLines, enabled: false } };

    const out = await callGame(provider, { cfg });
    expect(out.error).toBeUndefined();
    expect(out.formatted.picks).toEqual([]);
    expect(out.formatted.noPick).toBe(true);
    expect(out.formatted.noPickLabel).toBe('no market line');
  });

  test('missing historical statistics still produce a flagged, low-quality result', async () => {
    const provider = mkProvider({
      homeSched: { events: [] },
      awaySched: { events: [] },
    });
    const out = await callGame(provider);

    expect(out.error).toBeUndefined();
    const f = out.formatted;
    // League priors keep the engine honest, but the low data quality is exposed.
    expect(f.data_quality).toBeLessThan(0.5);
    expect(Number.isFinite(f.projection.total)).toBe(true);
  });
});

describe('Phase 1 — ESPN season labelling', () => {
  test('an Oct-Dec game belongs to the season ending in the NEXT year', () => {
    // 2026-10-22 is the 2026-27 season, which ESPN labels `2027`.
    expect(espnSeasonYear('2026-10-22T23:00:00.000Z')).toBe(2027);
    expect(espnSeasonYear('2026-12-31T00:00:00.000Z')).toBe(2027);
  });

  test('a Jan-Jul game belongs to the season ending in the SAME year', () => {
    expect(espnSeasonYear('2026-03-01T00:00:00.000Z')).toBe(2026);
    expect(espnSeasonYear('2026-06-15T00:00:00.000Z')).toBe(2026);
  });

  test('an unreadable date falls back to now rather than throwing', () => {
    expect(Number.isFinite(espnSeasonYear(null))).toBe(true);
    expect(Number.isFinite(espnSeasonYear('not-a-date'))).toBe(true);
  });

  test('the prior season year is requested from the core aggregate endpoint', async () => {
    const provider = mkProvider();
    await callGame(provider);

    const seasons = provider.getTeamSeasonStatistics.mock.calls.map(c => c[2]);
    expect(seasons).toEqual([2026, 2026]); // TIPOFF is Oct 2026 -> prior 2025-26
    const teamIds = provider.getTeamSeasonStatistics.mock.calls.map(c => String(c[3]));
    expect(teamIds).toContain(HOME_ID);
    expect(teamIds).toContain(AWAY_ID);
  });
});

describe('Phase 1 — prior-season baseline (buildPriorRatings)', () => {
  // Real ESPN values recorded from a live core-API probe (NBA team 13, 2025-26):
  // the aggregate exposes season TOTALS for points/possessions.
  const STATS = { gamesPlayed: 82, points: 9540, possessions: 8242.36 };

  test('converts a season TOTALS aggregate into per-game ratings', () => {
    const prior = buildPriorRatings({
      stats: STATS,
      games: [{ pa: 118 }, { pa: 110 }], // -> avgPointsAllowed 114
      leagueCfg: getLeagueConfig('nba'),
    });

    expect(prior).not.toBeNull();
    expect(prior.source).toBe('prior-season');
    expect(prior.gamesPlayed).toBe(82);
    expect(prior.avgPoints).toBeCloseTo(116.34, 2);   // 9540 / 82
    expect(prior.pace).toBeCloseTo(100.52, 2);        // 8242.36 / 82
    expect(prior.ortg).toBeCloseTo(115.75, 1);        // 9540 / 8242.36 * 100
    expect(prior.avgPointsAllowed).toBeCloseTo(114, 2);
    expect(prior.drtg).toBeCloseTo(113.41, 1);        // 114 / pace * 100
  });

  test('returns null — never a guess — when the aggregate cannot support a rating', () => {
    expect(buildPriorRatings({ stats: null, games: [], leagueCfg: getLeagueConfig('nba') })).toBeNull();
    expect(buildPriorRatings({ stats: { gamesPlayed: 0, points: 0, possessions: 0 }, games: [] })).toBeNull();
    expect(buildPriorRatings({ stats: { gamesPlayed: 82, points: null, possessions: 8242 }, games: [] })).toBeNull();
    // No prior schedule -> points-allowed is unknown -> DRtg cannot be derived.
    expect(buildPriorRatings({ stats: STATS, games: [], leagueCfg: getLeagueConfig('nba') })).toBeNull();
  });
});

describe('Phase 1 — R1b compound made-attempted stats', () => {
  test('splitPairStat parses "made-attempted" and rejects anything else', () => {
    expect(EspnProvider.splitPairStat({ displayValue: '38-92' })).toEqual({ made: 38, attempted: 92 });
    expect(EspnProvider.splitPairStat({ value: '8-36' })).toEqual({ made: 8, attempted: 36 });
    expect(EspnProvider.splitPairStat({ displayValue: '44' })).toBeNull();
    expect(EspnProvider.splitPairStat({ displayValue: 'N/A' })).toBeNull();
    expect(EspnProvider.splitPairStat(null)).toBeNull();
  });

  test('extractBasketballBoxScore reads the summary endpoint\'s compound stats', () => {
    // Verified ESPN summary shape: value is undefined, displayValue carries "38-92".
    const team = {
      statistics: [
        { name: 'fieldGoalsMade-fieldGoalsAttempted', label: 'FG', displayValue: '38-92' },
        { name: 'threePointFieldGoalsMade-threePointFieldGoalsAttempted', label: '3PT', displayValue: '8-36' },
        { name: 'freeThrowsMade-freeThrowsAttempted', label: 'FT', displayValue: '21-27' },
        { name: 'totalRebounds', label: 'REB', displayValue: '44' },
        { name: 'offensiveRebounds', label: 'OREB', displayValue: '9' },
        { name: 'turnovers', label: 'TO', displayValue: '12' },
      ],
    };
    const opp = { statistics: [{ name: 'fieldGoalsMade-fieldGoalsAttempted', displayValue: '35-88' }] };

    const box = EspnProvider.extractBasketballBoxScore(team, opp);
    expect(box.fgm).toBe(38);
    expect(box.fga).toBe(92);
    expect(box.tpm).toBe(8);
    expect(box.tpa).toBe(36);
    expect(box.ftm).toBe(21);
    expect(box.fta).toBe(27);
    expect(box.trb).toBe(44);
    expect(box.orb).toBe(9);
    expect(box.tov).toBe(12);
    expect(box.oppFgm).toBe(35);
    expect(box.oppFga).toBe(88);
  });

  test('a compound-stat schedule now yields possessions (the Phase-0 gap)', () => {
    const compound = [{ name: 'fieldGoalsMade-fieldGoalsAttempted', displayValue: '38-92' },
      { name: 'freeThrowsMade-freeThrowsAttempted', displayValue: '21-27' },
      { name: 'offensiveRebounds', displayValue: '9' },
      { name: 'turnovers', displayValue: '12' }];
    const us = competitor(HOME_ID, 'Home Hawks', { home: true, score: 112, stats: compound });
    const them = competitor(AWAY_ID, 'Away Aces', { home: false, score: 108, stats: compound });
    const events = [completedEvent(2001, TIPOFF, us, them)];

    const provider = mkProvider();
    const games = provider.processBasketballScheduleForTeam(events, HOME_ID);

    expect(games).toHaveLength(1);
    // fga(92) - orb(9) + tov(12) + 0.44 * fta(27)
    const box = normalizeBoxScore(games[0].boxScore, getLeagueConfig('nba'));
    expect(box.possessions).toBeCloseTo(106.88, 2);
    expect(box.possessions).toBeGreaterThan(0);
  });

  test('the separate made/attempted stat shape still works (no regression)', () => {
    const provider = mkProvider();
    const box = EspnProvider.extractBasketballBoxScore(
      { statistics: boxStats({ fgm: 42, fga: 88, tpm: 12, tpa: 32, ftm: 18, fta: 22 }) },
      { statistics: boxStats({ fgm: 40 }) },
    );
    expect(box.fgm).toBe(42);
    expect(box.fga).toBe(88);
    expect(box.tpa).toBe(32);
  });
});

describe('Phase 1 — prior-aware data quality', () => {
  test('an early-season team with a real prior is penalised less than one without', async () => {
    const early = () => ({
      homeSched: scheduleFor(HOME_ID, 'Home Hawks', 2, { pf: 118, pa: 104 }),
      awaySched: scheduleFor(AWAY_ID, 'Away Aces', 2, { pf: 104, pa: 114 }),
    });

    const without = await callGame(mkProvider(early()));
    const with_ = await callGame(mkProvider({
      ...early(),
      homePriorStats: priorAggregate(),
      awayPriorStats: priorAggregate(),
    }));

    const penalise = out => out.result.dataQuality.penalties.filter(p => /sample|early season/.test(p.reason));

    // Both games are still early-season, but a real prior counts as an input.
    expect(penalise(without)).toHaveLength(2);
    expect(penalise(without).every(p => /small sample/.test(p.reason))).toBe(true);
    expect(penalise(with_)).toHaveLength(2);
    expect(penalise(with_).every(p => /prior-season baseline/.test(p.reason))).toBe(true);

    expect(with_.result.dataQuality.score).toBeGreaterThan(without.result.dataQuality.score);
  });

  test('ratings report the prior source so the penalty can be explained', async () => {
    const provider = mkProvider({
      homeSched: scheduleFor(HOME_ID, 'Home Hawks', 2, { pf: 118, pa: 104 }),
      homePriorStats: priorAggregate(),
    });
    const out = await callGame(provider);

    expect(out.result.homeRatings.realPrior).toBe(true);
    expect(out.result.homeRatings.priorSource).toBe('prior-season');
    expect(out.result.homeRatings.priorGames).toBe(82);
  });

  test('without a prior the ratings fall back to the league mean (unchanged behaviour)', async () => {
    const out = await callGame(mkProvider());
    expect(out.result.homeRatings.realPrior).toBe(false);
    expect(out.result.homeRatings.priorSource).toBe('league-mean');
  });
});

describe('basketball ingestion — list endpoint', () => {
  const leagueCfg = { key: 'nba', label: 'NBA', espnPath: 'basketball/nba' };

  test('formats every fixture and skips the ones that fail without throwing', async () => {
    const provider = mkProvider();
    provider.getFixtures = jest.fn().mockResolvedValue([
      {
        fixture: { id: GAME_ID, date: TIPOFF, status: 'pre' },
        homeTeam: { id: HOME_ID, name: 'Home Hawks' },
        awayTeam: { id: AWAY_ID, name: 'Away Aces' },
      },
      // Broken fixture: no team ids -> processFixture must reject it quietly.
      { fixture: { id: 'broken' }, homeTeam: {}, awayTeam: {} },
    ]);

    const out = await getPredictions({ sportsData: mkSportsData(provider), leagues: ['nba'] });
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0].gameId).toBe(GAME_ID);
  });

  test('a fixture that throws upstream is skipped, not propagated', async () => {
    const provider = mkProvider();
    provider.getFixtures = jest.fn().mockResolvedValue([
      {
        fixture: { id: GAME_ID, date: TIPOFF, status: 'pre' },
        homeTeam: { id: HOME_ID, name: 'Home Hawks' },
        awayTeam: { id: AWAY_ID, name: 'Away Aces' },
      },
    ]);
    provider.getMatchSummary.mockRejectedValue(new Error('provider down'));

    const out = await getPredictions({ sportsData: mkSportsData(provider), leagues: ['nba'] });
    expect(out).toEqual([]);
  });

  test('an unknown league is rejected before any upstream fixture call', async () => {
    const provider = mkProvider();
    provider.getFixtures = jest.fn();

    await expect(getPredictions({ sportsData: mkSportsData(provider), leagues: ['nope'] }))
      .rejects.toThrow(/nope/);
    expect(provider.getFixtures).not.toHaveBeenCalled();
  });

  test('the requested day is forwarded to ESPN as YYYYMMDD', async () => {
    // Without `dates` ESPN only returns a narrow window around now, which dropped
    // most of the day's games from the Tips list.
    const provider = mkProvider();
    provider.getFixtures = jest.fn().mockResolvedValue([]);

    await fetchFixtures({
      sportsData: mkSportsData(provider),
      leagueCfg,
      date: '2026-10-21',
    });

    expect(provider.getFixtures).toHaveBeenCalledWith('basketball', 'nba', expect.objectContaining({
      dates: '20261021',
    }));
  });

  test('fixtures outside the requested day are still filtered out', async () => {
    const provider = mkProvider();
    provider.getFixtures = jest.fn().mockResolvedValue([
      {
        fixture: { id: '401-a', date: '2026-10-21T23:30:00.000Z', status: 'pre' },
        homeTeam: { id: HOME_ID, name: 'Home Hawks' },
        awayTeam: { id: AWAY_ID, name: 'Away Aces' },
      },
      // ESPN's +/- 1 day window must not leak other days into the list.
      {
        fixture: { id: '401-b', date: '2026-10-22T23:30:00.000Z', status: 'pre' },
        homeTeam: { id: HOME_ID, name: 'Home Hawks' },
        awayTeam: { id: AWAY_ID, name: 'Away Aces' },
      },
    ]);

    const out = await fetchFixtures({
      sportsData: mkSportsData(provider),
      leagueCfg,
      date: '2026-10-21',
    });

    expect(out.map(f => f.fixture.id)).toEqual(['401-a']);
  });

  test('no date returns every fixture the scoreboard supplied', async () => {
    const provider = mkProvider();
    provider.getFixtures = jest.fn().mockResolvedValue([{ fixture: { id: '401-a', date: '2026-10-25T23:30:00.000Z' } }]);

    const out = await fetchFixtures({ sportsData: mkSportsData(provider), leagueCfg });

    expect(provider.getFixtures).toHaveBeenCalledWith('basketball', 'nba', expect.objectContaining({
      dates: null,
    }));
    expect(out).toHaveLength(1);
  });
});

describe('ESPN provider cache behaviour (hit / miss / refresh / recovery)', () => {
  beforeEach(() => sharedCache.clear());

  const jsonResponse = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  test('a cache miss fetches upstream; a cache hit does not', async () => {
    const fetchFn = jest.fn().mockResolvedValue(jsonResponse({ events: ['a'] }));
    const provider = new EspnProvider({ logger: null, fetchFn });

    const first = await provider.getTeamSchedule('basketball', 'nba', HOME_ID, {});
    const second = await provider.getTeamSchedule('basketball', 'nba', HOME_ID, {});

    expect(first).toEqual({ events: ['a'] });
    expect(second).toEqual({ events: ['a'] });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('a 404 is not cached, so a later request can refresh and succeed', async () => {
    const fetchFn = jest.fn()
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse({ events: ['recovered'] }));
    const provider = new EspnProvider({ logger: null, fetchFn });

    expect(await provider.getTeamSchedule('basketball', 'nba', HOME_ID, {})).toBeNull();
    expect(await provider.getTeamSchedule('basketball', 'nba', HOME_ID, {})).toEqual({ events: ['recovered'] });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test('distinct team ids never share a cache entry', async () => {
    const fetchFn = jest.fn().mockImplementation(async (url) => jsonResponse({ url }));
    const provider = new EspnProvider({ logger: null, fetchFn });

    const home = await provider.getTeamSchedule('basketball', 'nba', HOME_ID, {});
    const away = await provider.getTeamSchedule('basketball', 'nba', AWAY_ID, {});

    expect(home.url).not.toBe(away.url);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
