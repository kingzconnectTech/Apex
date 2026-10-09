const {
  fixturesMatch,
  buildDedupKey,
} = require('../services/providers/normalizer');
const { sharedCache } = require('../services/providers/cache');
const { SportsDataService } = require('../services/SportsDataService');

function makeLoggerMock() {
  const logs = [];
  const push = (level, message, meta) => {
    logs.push({ level, message, meta: JSON.stringify(meta || {}) });
  };
  return {
    logs,
    log: (level, message, meta) => push(level, message, meta),
    info: (message, meta) => push('info', message, meta),
    warn: (message, meta) => push('warn', message, meta),
    error: (message, meta) => push('error', message, meta),
    debug: (message, meta) => push('debug', message, meta),
  };
}

function normalizeFixture(sigs, source) {
  return {
    source,
    fixture: { id: sigs.id },
    dedupSignature: sigs.sig,
  };
}

beforeEach(() => { try { sharedCache.clear(); } catch (_) {} });

describe('AC-1 ESPN-PRIMARY / PITCHAPI-SECONDARY fallback', () => {
  test('ESPN success → PitchAPI provider not called (spy)', async () => {
    const logger = makeLoggerMock();
    const espnFix = [
      normalizeFixture({ id: 'espn-1', sig: { home: 'a', away: 'b', league: 'prem', date: '2026-01-01' } }, 'espn'),
    ];
    const fakeEspn = {
      getFixtures: jest.fn(async () => espnFix),
    };
    const fakePa = {
      isAvailable: () => true,
      getLeagueMatches: jest.fn(async () => []),
    };
    const svc = new SportsDataService({ logger, espnProvider: fakeEspn, pitchApiProvider: fakePa });
    const res = await svc.getFixtures('soccer', 'eng.1', {});
    expect(res.source).toBe('espn');
    expect(res.tried).toEqual(['espn']);
    expect(res.fixtures).toEqual(espnFix);
    expect(fakeEspn.getFixtures).toHaveBeenCalledTimes(1);
    expect(fakePa.getLeagueMatches).toHaveBeenCalledTimes(0);
  });

  test('ESPN empty / soccer → PitchAPI called and merged results returned', async () => {
    const logger = makeLoggerMock();
    const fakeEspn = {
      getFixtures: jest.fn(async () => []),
    };
    const paFix = [
      normalizeFixture({ id: 'pa-100', sig: { home: 'arsenal', away: 'chelsea', league: 'premier league', date: '2026-01-01' } }, 'pitchapi'),
    ];
    const fakePa = {
      isAvailable: () => true,
      getLeagues: jest.fn(async () => [
        { league: { id: 'pa-l_1', sourceId: 'l_1', name: 'English Premier League', country: 'ENG' } },
      ]),
      getLeagueMatches: jest.fn(async () => paFix),
    };
    const svc = new SportsDataService({ logger, espnProvider: fakeEspn, pitchApiProvider: fakePa });
    const res = await svc.getFixtures('soccer', 'eng.1', { leagueDisplayName: 'English Premier League' });
    expect(fakeEspn.getFixtures).toHaveBeenCalledTimes(1);
    expect(fakePa.getLeagueMatches).toHaveBeenCalled();
    expect(res.fixtures.length).toBeGreaterThanOrEqual(1);
    expect(res.fixtures.map(r => r.source).includes('pitchapi')).toBe(true);
    expect(res.source).toBe('pitchapi');
    expect(res.tried).toEqual(['espn', 'pitchapi']);
  });

  test('ESPN empty / basketball → PitchAPI NOT called even if available', async () => {
    const logger = makeLoggerMock();
    const fakeEspn = { getFixtures: jest.fn(async () => []) };
    const fakePa = {
      isAvailable: () => true,
      getLeagueMatches: jest.fn(async () => []),
    };
    const svc = new SportsDataService({ logger, espnProvider: fakeEspn, pitchApiProvider: fakePa });
    const res = await svc.getFixtures('basketball', 'nba', {});
    expect(res.fixtures).toEqual([]);
    expect(res.source).toBeNull();
    expect(fakePa.getLeagueMatches).toHaveBeenCalledTimes(0);
  });
});

describe('AC-3 DEDUP overlapping fixtures — ESPN data preferred when both exist', () => {
  test('fixturesMatch: same sigs with fuzzy league include match, dedupKey defined for both', () => {
    const espnFix = normalizeFixture(
      { id: '123', sig: { home: 'arsenal', away: 'chelsea', league: 'premier', date: '2026-01-01' } },
      'espn'
    );
    const paFix = normalizeFixture(
      { id: 'pa-99', sig: { home: 'arsenal', away: 'chelsea', league: 'premier league', date: '2026-01-01' } },
      'pitchapi'
    );
    expect(fixturesMatch(espnFix, paFix)).toBe(true);
    const dedupKeyE = buildDedupKey(espnFix.dedupSignature);
    const dedupKeyA = buildDedupKey(paFix.dedupSignature);
    expect(typeof dedupKeyA).toBe('string');
    expect(typeof dedupKeyE).toBe('string');
  });

  test('fixturesMatch: cross-order (home/away flipped) still matches', () => {
    const a = normalizeFixture(
      { id: '1', sig: { home: 'x', away: 'y', league: 'L', date: '2026-01-01' } },
      'espn'
    );
    const b = normalizeFixture(
      { id: '2', sig: { home: 'y', away: 'x', league: 'L', date: '2026-01-01' } },
      'pitchapi'
    );
    expect(fixturesMatch(a, b)).toBe(true);
  });

  test('fixturesMatch: different date → no match', () => {
    const a = normalizeFixture(
      { id: '1', sig: { home: 'x', away: 'y', league: 'L', date: '2026-01-01' } },
      'espn'
    );
    const c = normalizeFixture(
      { id: '3', sig: { home: 'x', away: 'y', league: 'L', date: '2026-01-02' } },
      'pitchapi'
    );
    expect(fixturesMatch(a, c)).toBe(false);
  });

  test('fixturesMatch: null sigs handled safely', () => {
    const a = normalizeFixture(
      { id: '1', sig: { home: 'x', away: 'y', league: 'L', date: '2026-01-01' } },
      'espn'
    );
    const b = { source: 'pitchapi', fixture: { id: '99' } };
    expect(fixturesMatch(a, b)).toBe(false);
    expect(fixturesMatch(null, null)).toBe(false);
  });
});
