const { SportsDataService } = require('../services/SportsDataService');
const { PitchApiProvider } = require('../services/providers/PitchApiProvider');
const { PROVIDERS } = require('../services/providers/config');
const {
  normalizeLeaguePitchAPI,
  normalizeTeamPitchAPI,
  normalizeFixturePitchAPI,
  normalizeH2HPitchAPI,
  normalizeTeamStatsPitchAPI,
  fixturesMatch,
  buildDedupKey,
} = require('../services/providers/normalizer');

function makeLoggerMock() {
  const logs = [];
  return {
    logs,
    log: (level, message, meta) => logs.push({ level, message, meta }),
    info: (message, meta) => logs.push({ level: 'info', message, meta }),
    warn: (message, meta) => logs.push({ level: 'warn', message, meta }),
    error: (message, meta) => logs.push({ level: 'error', message, meta }),
    debug: (message, meta) => logs.push({ level: 'debug', message, meta }),
  };
}

describe('PitchAPI — Provider and Normalization Unit Tests', () => {
  test('normalizeLeaguePitchAPI maps PitchAPI league catalogue structure', () => {
    const raw = {
      id: 'l_4Kd0Wq',
      name: 'Championship',
      country_code: 'ENG',
      image_url: 'https://cdn.pitchapi.dev/leagues/48.webp',
      seasons: ['2025/2026', '2024/2025'],
      is_free: true,
    };
    const norm = normalizeLeaguePitchAPI(raw);
    expect(norm).not.toBeNull();
    expect(norm.sport).toBe('football');
    expect(norm.league.id).toBe('pa-l_4Kd0Wq');
    expect(norm.league.sourceId).toBe('l_4Kd0Wq');
    expect(norm.league.name).toBe('Championship');
    expect(norm.league.country).toBe('ENG');
    expect(norm.league.season).toBe('2025/2026');
    expect(norm.source).toBe(PROVIDERS.PITCHAPI);
    expect(norm.providerIds[PROVIDERS.PITCHAPI]).toBe('l_4Kd0Wq');
  });

  test('normalizeTeamPitchAPI maps PitchAPI team structure with pa- prefix', () => {
    const raw = {
      id: 't_9aB2xQ',
      name: 'Leeds United',
      short_name: 'Leeds',
      country_code: 'ENG',
      image_url: 'https://cdn.pitchapi.dev/teams/8456.webp',
    };
    const norm = normalizeTeamPitchAPI(raw, 'l_4Kd0Wq');
    expect(norm).not.toBeNull();
    expect(norm.team.id).toBe('pa-t_9aB2xQ');
    expect(norm.team.sourceId).toBe('t_9aB2xQ');
    expect(norm.team.name).toBe('Leeds United');
    expect(norm.league.id).toBe('pa-l_4Kd0Wq');
    expect(norm.normalizedName).toBe('leeds united');
  });

  test('normalizeFixturePitchAPI maps match fixture and generates valid dedupSignature', () => {
    const raw = {
      id: 'm_B8x2K9',
      league: { id: 'l_4Kd0Wq', name: 'Championship', country_code: 'ENG' },
      home_team: { id: 't_9aB2xQ', name: 'Leeds United' },
      away_team: { id: 't_2mLp7C', name: 'Sunderland' },
      date: '2025-11-09',
      time_utc: '2025-11-09T15:00:00Z',
      status: 'finished',
      score_home: 2,
      score_away: 1,
      stadium: 'Elland Road',
      referee: 'Anthony Taylor',
    };
    const norm = normalizeFixturePitchAPI(raw);
    expect(norm).not.toBeNull();
    expect(norm.fixture.id).toBe('pa-m_B8x2K9');
    expect(norm.fixture.status).toBe('finished');
    expect(norm.homeTeam.id).toBe('pa-t_9aB2xQ');
    expect(norm.homeTeam.name).toBe('Leeds United');
    expect(norm.homeTeam.score).toBe(2);
    expect(norm.homeTeam.winner).toBe(true);
    expect(norm.awayTeam.id).toBe('pa-t_2mLp7C');
    expect(norm.awayTeam.score).toBe(1);
    expect(norm.awayTeam.winner).toBe(false);
    expect(norm.dedupSignature).toEqual({
      home: 'leeds united',
      away: 'sunderland',
      league: 'championship',
      date: '2025-11-09',
    });
  });

  test('normalizeH2HPitchAPI calculates homeWins, awayWins, and draws without fabricating', () => {
    const rawH2H = {
      data: {
        h2h: [
          {
            home: { id: 't_1', name: 'Team A' },
            away: { id: 't_2', name: 'Team B' },
            score_home: 2,
            score_away: 0,
            finished: true,
            date: '2024-10-01',
          },
          {
            home: { id: 't_2', name: 'Team B' },
            away: { id: 't_1', name: 'Team A' },
            score_home: 1,
            score_away: 1,
            finished: true,
            date: '2024-03-01',
          },
        ],
      },
    };
    const h2h = normalizeH2HPitchAPI(rawH2H, 'pa-t_1', 'pa-t_2');
    expect(h2h.homeWins).toBe(1);
    expect(h2h.awayWins).toBe(0);
    expect(h2h.draws).toBe(1);
    expect(h2h.matches.length).toBe(2);
    expect(h2h.recent.length).toBe(2);
  });

  test('normalizeTeamStatsPitchAPI parses xG and stats correctly', () => {
    const rawStats = {
      data: {
        periods: [
          {
            period: 'All',
            groups: [
              {
                group_name: 'Expected goals (xG)',
                items: [
                  { key: 'expected_goals', home: '2.45', away: '1.10' },
                ],
              },
              {
                group_name: 'Shots',
                items: [
                  { key: 'shots', home: '15', away: '7' },
                ],
              },
            ],
          },
        ],
      },
    };
    const norm = normalizeTeamStatsPitchAPI(rawStats);
    expect(norm.stats.homeXG).toBe(2.45);
    expect(norm.stats.awayXG).toBe(1.10);
    expect(norm.stats.homeShots).toBe(15);
    expect(norm.stats.awayShots).toBe(7);
  });
});

describe('PitchAPI — Provider Priority and Fallback Scenarios (Items 13 TEST A - I)', () => {
  // TEST A: ESPN contains a fixture -> ESPN used, PitchAPI not called
  test('TEST A: ESPN contains fixture → ESPN is used and PitchAPI is not called', async () => {
    const logger = makeLoggerMock();
    const espnFixture = {
      sport: 'soccer',
      league: { id: 'eng.1', name: 'Premier League' },
      fixture: { id: '695000', status: 'scheduled' },
      homeTeam: { id: '1', name: 'Arsenal' },
      awayTeam: { id: '2', name: 'Chelsea' },
      source: PROVIDERS.ESPN,
      dedupSignature: { home: 'arsenal', away: 'chelsea', league: 'premier league', date: '2026-10-10' },
    };

    const fakeEspn = {
      getFixtures: jest.fn(async () => [espnFixture]),
    };
    const fakePitchApi = {
      isAvailable: jest.fn(() => true),
      getLeagueMatches: jest.fn(async () => []),
    };

    const svc = new SportsDataService({
      logger,
      espnProvider: fakeEspn,
      pitchApiProvider: fakePitchApi,
    });

    const res = await svc.getFixtures('soccer', 'eng.1', { traceId: 't-test-a' });

    expect(res.source).toBe(PROVIDERS.ESPN);
    expect(res.fixtures.length).toBe(1);
    expect(fakeEspn.getFixtures).toHaveBeenCalledTimes(1);
    expect(fakePitchApi.getLeagueMatches).toHaveBeenCalledTimes(0); // PitchAPI never called
  });

  // TEST B: ESPN does not contain fixture, PitchAPI does -> PitchAPI supplies fixture
  test('TEST B: ESPN does not contain fixture, PitchAPI does → PitchAPI supplies fixture', async () => {
    const logger = makeLoggerMock();
    const fakeEspn = {
      getFixtures: jest.fn(async () => []), // ESPN empty for lower tier
    };
    const paFixture = {
      sport: 'football',
      league: { id: 'pa-l_championship', name: 'Championship' },
      fixture: { id: 'pa-m_123', status: 'scheduled' },
      homeTeam: { id: 'pa-t_10', name: 'Sheffield Wednesday' },
      awayTeam: { id: 'pa-t_11', name: 'Coventry City' },
      source: PROVIDERS.PITCHAPI,
      dedupSignature: { home: 'sheffield wednesday', away: 'coventry city', league: 'championship', date: '2026-10-11' },
    };
    const fakePitchApi = {
      isAvailable: jest.fn(() => true),
      getLeagues: jest.fn(async () => [
        { league: { id: 'pa-l_championship', sourceId: 'l_championship', name: 'Championship', country: 'ENG' } },
      ]),
      getLeagueMatches: jest.fn(async () => [paFixture]),
    };

    const svc = new SportsDataService({
      logger,
      espnProvider: fakeEspn,
      pitchApiProvider: fakePitchApi,
    });

    const res = await svc.getFixtures('soccer', 'championship', { traceId: 't-test-b' });

    expect(res.source).toBe(PROVIDERS.PITCHAPI);
    expect(res.fixtures.length).toBe(1);
    expect(res.fixtures[0].homeTeam.name).toBe('Sheffield Wednesday');
    expect(res.tried).toEqual([PROVIDERS.ESPN, PROVIDERS.PITCHAPI]);
    expect(fakeEspn.getFixtures).toHaveBeenCalledTimes(1);
    expect(fakePitchApi.getLeagueMatches).toHaveBeenCalledTimes(1);
  });

  // TEST C: Both providers contain the same fixture -> Deduplication prefers ESPN
  test('TEST C: Both providers contain the same fixture → One fixture appears with ESPN preferred', async () => {
    const logger = makeLoggerMock();
    const espnFixture = {
      sport: 'soccer',
      league: { id: 'eng.2', name: 'Championship' },
      fixture: { id: 'espn-999', status: 'scheduled', timestamp: 1770000000 },
      homeTeam: { id: '10', name: 'Leeds' },
      awayTeam: { id: '11', name: 'Sunderland' },
      source: PROVIDERS.ESPN,
      dedupSignature: { home: 'leeds', away: 'sunderland', league: 'championship', date: '2026-10-15' },
    };
    const paFixture = {
      sport: 'football',
      league: { id: 'pa-l_2', name: 'Championship' },
      fixture: { id: 'pa-m_888', status: 'scheduled', timestamp: 1770000000 },
      homeTeam: { id: 'pa-t_10', name: 'Leeds' },
      awayTeam: { id: 'pa-t_11', name: 'Sunderland' },
      source: PROVIDERS.PITCHAPI,
      dedupSignature: { home: 'leeds', away: 'sunderland', league: 'championship', date: '2026-10-15' },
    };

    const fakeEspn = {
      getFixtures: jest.fn(async () => [espnFixture]),
    };
    const fakePitchApi = {
      isAvailable: jest.fn(() => true),
      getLeagues: jest.fn(async () => [
        { league: { id: 'pa-l_2', sourceId: 'l_2', name: 'Championship', country: 'ENG' } },
      ]),
      getLeagueMatches: jest.fn(async () => [paFixture]),
    };

    const fakeAf = {
      isAvailable: jest.fn(() => false),
      getFixtures: jest.fn(async () => []),
    };

    const svc = new SportsDataService({
      logger,
      espnProvider: fakeEspn,
      pitchApiProvider: fakePitchApi,
      apiFootballProvider: fakeAf,
    });

    const merged = await svc.getFixturesMerged('soccer', 'eng.2', { traceId: 't-test-c' });
    expect(merged.length).toBe(1);
    expect(merged[0].source).toBe(PROVIDERS.ESPN);
    expect(merged[0].fixture.id).toBe('espn-999');
  });

  // TEST D: PitchAPI returns authentication error (401/403)
  test('TEST D: PitchAPI returns authentication error → Apex remains functional, failure is logged', async () => {
    const logger = makeLoggerMock();
    const fakeFetch401 = jest.fn(async () => ({
      status: 401,
      ok: false,
      json: async () => ({ error: { code: 'UNAUTHORIZED', message: 'invalid key' } }),
    }));

    const provider = new PitchApiProvider({
      logger,
      fetchFn: fakeFetch401,
      apiKey: 'pk_test_badkey',
      enabled: true,
    });

    const result = await provider.getLeagues({ traceId: 't-test-d' });
    expect(result).toEqual([]);
    expect(provider._rateLimit.errorCount).toBe(1);
    expect(provider._rateLimit.blockedUntil).toBeGreaterThan(Date.now());
    expect(provider.isAvailable()).toBe(false); // Provider backoff active

    const logMessages = logger.logs.map(l => l.message).join(' ');
    expect(logMessages).toContain('auth 401');
  });

  // TEST E: PitchAPI reaches rate limit (429) -> Gracefully backs off using Retry-After
  test('TEST E: PitchAPI reaches rate limit (429) → No uncontrolled retry loop, handles error gracefully', async () => {
    const logger = makeLoggerMock();
    const headers = new Map();
    headers.set('retry-after', '15');

    const fakeFetch429 = jest.fn(async () => ({
      status: 429,
      ok: false,
      headers: {
        get: (h) => headers.get(h.toLowerCase()),
      },
      json: async () => ({ error: { code: 'RATE_LIMIT_EXCEEDED' } }),
    }));

    const provider = new PitchApiProvider({
      logger,
      fetchFn: fakeFetch429,
      apiKey: 'pk_live_key',
      enabled: true,
    });

    const result = await provider.getLeagueMatches('l_4Kd0Wq', { traceId: 't-test-e' });
    expect(result).toEqual([]);
    expect(provider.isAvailable()).toBe(false);
    expect(provider._rateLimit.blockedUntil).toBeGreaterThan(Date.now() + 10000); // 15 seconds backoff

    // Second call immediately returns empty without making extra HTTP request
    const secondCall = await provider.getLeagueMatches('l_4Kd0Wq', { traceId: 't-test-e-2' });
    expect(secondCall).toEqual([]);
    expect(provider.isBlocked()).toBe(true);
    expect(fakeFetch429).toHaveBeenCalledTimes(1); // No infinite or redundant retries
  });

  // TEST F: PitchAPI returns incomplete statistics -> No fabricated data reaches prediction engine
  test('TEST F: PitchAPI returns incomplete statistics → Nulls preserved, no fabricated values', async () => {
    const rawIncompleteStats = {
      data: {
        periods: [
          {
            period: 'All',
            groups: [
              {
                group_name: 'Expected goals (xG)',
                items: [], // missing xG values
              },
            ],
          },
        ],
      },
    };
    const norm = normalizeTeamStatsPitchAPI(rawIncompleteStats);
    expect(norm.stats.homeXG).toBeNull();
    expect(norm.stats.awayXG).toBeNull();
    expect(norm.stats.homeShots).toBeNull();
    expect(norm.stats.awayShots).toBeNull();
  });

  // TEST G: PitchAPI is disabled -> ESPN works normally, no PitchAPI requests
  test('TEST G: PitchAPI is disabled (PITCHAPI_ENABLED=false) → ESPN works normally, 0 PitchAPI requests', async () => {
    const logger = makeLoggerMock();
    const fakeEspn = {
      getFixtures: jest.fn(async () => []),
    };
    const fakePitchApi = {
      enabled: false,
      isAvailable: jest.fn(() => false),
      getLeagueMatches: jest.fn(async () => []),
    };
    const fakeAf = {
      isAvailable: jest.fn(() => false),
      getFixtures: jest.fn(async () => []),
    };

    const svc = new SportsDataService({
      logger,
      espnProvider: fakeEspn,
      pitchApiProvider: fakePitchApi,
      apiFootballProvider: fakeAf,
    });

    const res = await svc.getFixtures('soccer', 'lower-tier-slug', { traceId: 't-test-g' });
    expect(res.source).toBeNull();
    expect(res.fixtures).toEqual([]);
    expect(fakeEspn.getFixtures).toHaveBeenCalledTimes(1);
    expect(fakePitchApi.getLeagueMatches).toHaveBeenCalledTimes(0);
    expect(res.tried).toEqual([PROVIDERS.ESPN]); // PitchAPI skipped
  });

  // TEST H: A PitchAPI-only fixture reaches the prediction engine
  test('TEST H: PitchAPI-only fixture reaches prediction engine → Normalized structure accepted', async () => {
    const logger = makeLoggerMock();
    const fakeEspn = {
      _request: jest.fn(async () => { throw new Error('Not in ESPN'); }),
      getMatchSummary: jest.fn(async () => null),
      getTeamSchedule: jest.fn(async () => null),
      getTeamNews: jest.fn(async () => null),
    };

    const paMatch = {
      id: 'm_special_1',
      league: { id: 'l_lower', name: 'National League' },
      home_team: { id: 't_wrexham', name: 'Wrexham' },
      away_team: { id: 't_notts', name: 'Notts County' },
      date: '2026-10-12',
      status: 'scheduled',
    };

    const finishedMatches = [
      {
        id: 'm_prev_1',
        league: { id: 'l_lower', name: 'National League' },
        home_team: { id: 't_wrexham', name: 'Wrexham', score: 3 },
        away_team: { id: 't_other', name: 'Other', score: 1 },
        date: '2026-10-05',
        status: 'finished',
        score_home: 3,
        score_away: 1,
      },
      {
        id: 'm_prev_2',
        league: { id: 'l_lower', name: 'National League' },
        home_team: { id: 't_notts', name: 'Notts County', score: 0 },
        away_team: { id: 't_other', name: 'Other', score: 2 },
        date: '2026-10-05',
        status: 'finished',
        score_home: 0,
        score_away: 2,
      },
    ];

    const fakePitchApi = {
      isAvailable: jest.fn(() => true),
      getMatchById: jest.fn(async () => normalizeFixturePitchAPI(paMatch)),
      getMatchH2H: jest.fn(async () => ({ homeWins: 2, awayWins: 1, draws: 1, matches: [] })),
      getMatchStats: jest.fn(async () => ({ stats: {} })),
      getLeagueMatches: jest.fn(async () => finishedMatches.map(m => normalizeFixturePitchAPI(m))),
    };

    const svc = new SportsDataService({
      logger,
      espnProvider: fakeEspn,
      pitchApiProvider: fakePitchApi,
    });

    const predData = await svc.getMatchDataForPrediction({
      matchId: 'pa-m_special_1',
      sport: 'soccer',
      leagueSlug: 'national-league',
      homeTeamId: 'pa-t_wrexham',
      awayTeamId: 'pa-t_notts',
      traceId: 't-test-h',
    });

    expect(predData.source).toBe(PROVIDERS.PITCHAPI);
    expect(predData.homeName).toBe('Wrexham');
    expect(predData.awayName).toBe('Notts County');
    expect(predData.homeRecord).toBe('1-0-0');
    expect(predData.awayRecord).toBe('0-0-1');
    expect(predData.h2h.homeWins).toBe(2);
    expect(Array.isArray(predData.homeLastMatches)).toBe(true);
    expect(predData.homeLastMatches.length).toBe(1);
    expect(predData.homeLastMatches[0].result).toBe('W');
  });

  // TEST I: Basketball and tennis requests -> Handled by ESPN only, never routed to PitchAPI
  test('TEST I: Basketball and tennis requests → Handled by ESPN only, PitchAPI never queried', async () => {
    const logger = makeLoggerMock();
    const fakeEspn = {
      getFixtures: jest.fn(async () => []),
    };
    const fakePitchApi = {
      isAvailable: jest.fn(() => true),
      getLeagueMatches: jest.fn(async () => []),
    };

    const svc = new SportsDataService({
      logger,
      espnProvider: fakeEspn,
      pitchApiProvider: fakePitchApi,
    });

    // Basketball request
    const bballRes = await svc.getFixtures('basketball', 'nba', { traceId: 't-bball' });
    expect(fakeEspn.getFixtures).toHaveBeenCalledTimes(1);
    expect(fakePitchApi.getLeagueMatches).toHaveBeenCalledTimes(0);
    expect(bballRes.tried).toEqual([PROVIDERS.ESPN]);

    // Tennis request
    const tennisRes = await svc.getFixtures('tennis', 'atp', { traceId: 't-tennis' });
    expect(fakeEspn.getFixtures).toHaveBeenCalledTimes(2);
    expect(fakePitchApi.getLeagueMatches).toHaveBeenCalledTimes(0);
    expect(tennisRes.tried).toEqual([PROVIDERS.ESPN]);
  });
});
