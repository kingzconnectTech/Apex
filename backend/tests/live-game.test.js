/**
 * Phase 3 — unified LiveGame object, data tiers, staleness and manual entry.
 *
 * No network: candidates are built from the same normalised fixture shape the
 * matcher produces (Phase 0 verified fields).
 */

const {
  buildLiveGame, buildManualLiveGame, validateManualEntry,
  staleness, dataTierLabel, formatAge, TIERS, SOURCE_MANUAL,
} = require('../services/live/liveGame');
const CFG = require('../services/live/config');

const NOW = Date.parse('2026-10-26T18:00:00.000Z');

/** Normalised fixture, same shape normalizeFixtureESPN returns. */
function fixture({
  sport = 'soccer', status = 'live', clock = "34'", period = 1,
  homeScore = 1, awayScore = 0, home = 'Manchester United', away = 'Chelsea',
} = {}) {
  return {
    sport,
    league: { id: 'eng.1', sourceId: 'eng.1', name: 'eng.1', slug: 'eng.1' },
    fixture: {
      id: '700001', sourceId: '700001', date: '2026-10-26T17:30:00.000Z',
      timestamp: NOW - 30 * 60 * 1000, status, rawStatus: { state: 'in' },
      clock, period, venue: 'Old Trafford',
    },
    homeTeam: { id: 'h1', name: home, logo: 'h.png', score: homeScore, record: '5-2' },
    awayTeam: { id: 'a1', name: away, logo: 'a.png', score: awayScore, record: '3-4' },
    source: 'espn',
    providerIds: { espn: '700001' },
  };
}

function candidate(fx, extra = {}) {
  return {
    source: fx.source,
    fixture: fx,
    match_confidence: 0.9,
    orientation: 'direct',
    home_similarity: 0.95,
    away_similarity: 0.9,
    match_notes: ['Fixture is live.'],
    ...extra,
  };
}

describe('Data tiers', () => {
  test('soccer with score and clock is full live data', () => {
    const game = buildLiveGame({ candidate: candidate(fixture()), fetchedAt: NOW, now: NOW });
    expect(game.data_tier).toBe(TIERS.FULL_LIVE);
    expect(game.data_tier_label).toBe('Full live data');
  });

  test('basketball needs a period as well as a clock', () => {
    const withPeriod = buildLiveGame({
      candidate: candidate(fixture({ sport: 'basketball', clock: '7:24', period: 3, homeScore: 88, awayScore: 91 })),
      fetchedAt: NOW, now: NOW,
    });
    expect(withPeriod.data_tier).toBe(TIERS.FULL_LIVE);

    const noPeriod = buildLiveGame({
      candidate: candidate(fixture({ sport: 'basketball', clock: '7:24', period: 0, homeScore: 88, awayScore: 91 })),
      fetchedAt: NOW, now: NOW,
    });
    expect(noPeriod.data_tier).toBe(TIERS.SCORE_TIME_ONLY);
    expect(noPeriod.data_tier_label).toBe('Score and time only');
  });

  test('a missing clock downgrades to score and time only', () => {
    const game = buildLiveGame({
      candidate: candidate(fixture({ clock: null, period: 0 })),
      fetchedAt: NOW, now: NOW,
    });
    expect(game.data_tier).toBe(TIERS.SCORE_TIME_ONLY);
  });

  test('an empty-string clock is not treated as usable', () => {
    const game = buildLiveGame({
      candidate: candidate(fixture({ clock: '   ' })),
      fetchedAt: NOW, now: NOW,
    });
    expect(game.data_tier).toBe(TIERS.SCORE_TIME_ONLY);
  });

  test('soccer at 0-0 with a clock is still full live data', () => {
    const game = buildLiveGame({
      candidate: candidate(fixture({ homeScore: 0, awayScore: 0 })),
      fetchedAt: NOW, now: NOW,
    });
    expect(game.data_tier).toBe(TIERS.FULL_LIVE);
  });

  test('a scheduled game has no score and degrades honestly', () => {
    const game = buildLiveGame({
      candidate: candidate(fixture({ status: 'scheduled', clock: null, period: 0, homeScore: null, awayScore: null })),
      fetchedAt: NOW, now: NOW,
    });
    expect(game.live.is_live).toBe(false);
    expect(game.data_tier).toBe(TIERS.SCORE_TIME_ONLY);
  });
});

describe('Unified LiveGame object', () => {
  test('carries the stable game id, teams, schedule and match traceability', () => {
    const game = buildLiveGame({
      candidate: candidate(fixture(), { orientation: 'swapped' }),
      parsed: { home_raw: 'Chelsea', away_raw: 'Man United' },
      fetchedAt: NOW, now: NOW,
    });
    expect(game.game_id).toBe('espn:700001');
    expect(game.sport).toBe('soccer');
    expect(game.league).toEqual({ id: 'eng.1', name: 'eng.1' });
    expect(game.home).toEqual({
      id: 'h1', name: 'Manchester United', logo: 'h.png', score: 1, record: '5-2',
    });
    expect(game.away.name).toBe('Chelsea');
    expect(game.live).toEqual({
      status: 'live', is_live: true, clock: "34'", period: 1, raw_status: { state: 'in' },
    });
    expect(game.schedule).toEqual({
      kickoff: '2026-10-26T17:30:00.000Z',
      kickoff_ts: NOW - 30 * 60 * 1000,
      venue: 'Old Trafford',
    });
    expect(game.match.orientation).toBe('swapped');
    // Fixture stays in true home/away order; the link's names are kept separately.
    expect(game.home.name).toBe('Manchester United');
    expect(game.link).toEqual({ home: 'Chelsea', away: 'Man United' });
    expect(game.manual).toBe(false);
  });

  test('throws rather than fabricating a game when no fixture is supplied', () => {
    expect(() => buildLiveGame({ candidate: null })).toThrow(/fixture/);
    expect(() => buildLiveGame({ candidate: { source: 'espn' } })).toThrow(/fixture/);
  });

  test('link is null when the parsed link is absent', () => {
    const game = buildLiveGame({ candidate: candidate(fixture()), fetchedAt: NOW, now: NOW });
    expect(game.link).toBeNull();
  });
});

describe('Staleness', () => {
  test('fresh payload is not stale and labels in seconds', () => {
    const s = staleness(NOW - 12 * 1000, NOW);
    expect(s.age_seconds).toBe(12);
    expect(s.is_stale).toBe(false);
    expect(s.updated_label).toBe('updated 12s ago');
  });

  test('age beyond the configured threshold is flagged stale', () => {
    const s = staleness(NOW - (CFG.liveGame.staleAfterSeconds + 1) * 1000, NOW);
    expect(s.is_stale).toBe(true);
  });

  test('minutes and hours get friendlier labels', () => {
    expect(formatAge(0)).toBe('updated 0s ago');
    expect(formatAge(59)).toBe('updated 59s ago');
    expect(formatAge(125)).toBe('updated 2m ago');
    expect(formatAge(3 * 3600)).toBe('updated 3h ago');
  });

  test('an unknown fetch time is stale with an explicit label', () => {
    const s = staleness(null, NOW);
    expect(s.age_seconds).toBeNull();
    expect(s.is_stale).toBe(true);
    expect(s.updated_label).toBe('update time unknown');
  });
});

describe('Manual entry validation', () => {
  const good = {
    sport: 'basketball',
    home_name: 'Lakers',
    away_name: 'Celtics',
    home_score: 88,
    away_score: 91,
    period: 3,
    clock: '7:24',
  };

  test('a complete live entry validates', () => {
    const r = validateManualEntry(good);
    expect(r.valid).toBe(true);
    expect(r.value).toMatchObject({ sport: 'basketball', home_score: 88, clock: '7:24' });
  });

  test('an unsupported sport is rejected', () => {
    const r = validateManualEntry({ ...good, sport: 'cricket' });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/not supported/);
  });

  test('team names must carry enough letters and be different', () => {
    expect(validateManualEntry({ ...good, home_name: 'A' }).errors.join(' '))
      .toMatch(/at least 3 letters/);
    expect(validateManualEntry({ ...good, away_name: 'lakers' }).errors.join(' '))
      .toMatch(/must be different/);
    expect(validateManualEntry({ ...good, home_name: 'x'.repeat(61) }).errors.join(' '))
      .toMatch(/longer than 60/);
  });

  test('scores must be whole and in range, and are required when live', () => {
    expect(validateManualEntry({ ...good, home_score: 12.5 }).errors.join(' '))
      .toMatch(/whole number/);
    expect(validateManualEntry({ ...good, home_score: 999 }).errors.join(' '))
      .toMatch(/between 0 and 250/);
    expect(validateManualEntry({ ...good, home_score: '' }).errors.join(' '))
      .toMatch(/score is required/);
  });

  test('scores are optional for a finished entry', () => {
    const r = validateManualEntry({
      sport: 'soccer', home_name: 'Arsenal', away_name: 'Chelsea', status: 'scheduled',
    });
    expect(r.valid).toBe(true);
  });

  test('period and clock are range- and format-checked', () => {
    expect(validateManualEntry({ ...good, period: 99 }).errors.join(' '))
      .toMatch(/between 0 and 10/);
    expect(validateManualEntry({ ...good, clock: 'half time' }).errors.join(' '))
      .toMatch(/clock format/);
    // Soccer stoppage clock is accepted.
    expect(validateManualEntry({ ...good, clock: "90+4'" }).valid).toBe(true);
  });

  test('every problem is reported at once, never just the first', () => {
    const r = validateManualEntry({ sport: 'cricket', home_name: 'A', away_name: 'B' });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('Manual entry — strict, per-sport validation (Phase 7)', () => {
  const soccer = {
    sport: 'soccer', home_name: 'Arsenal', away_name: 'Chelsea',
    home_score: 1, away_score: 0, status: 'live', clock: "60'", period: 2,
  };
  const basketball = {
    sport: 'basketball', home_name: 'Lakers', away_name: 'Celtics',
    home_score: 88, away_score: 91, status: 'live', clock: '7:24', period: 3,
  };

  test('each sport has its own score ceiling', () => {
    expect(validateManualEntry({ ...soccer, home_score: 40 }).errors.join(' '))
      .toMatch(/between 0 and 30/);
    expect(validateManualEntry({ ...basketball, away_score: 240 }).valid).toBe(true);
  });

  test('a basketball live game needs a period', () => {
    const r = validateManualEntry({ ...basketball, period: 0 });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/needs the period/);
  });

  test('a basketball clock cannot be longer than a period', () => {
    expect(validateManualEntry({ ...basketball, clock: '90:00' }).errors.join(' '))
      .toMatch(/longer than 20 minutes/);
  });

  test('a soccer clock cannot run past the end of the match', () => {
    expect(validateManualEntry({ ...soccer, clock: "120'", period: 2 }).errors.join(' '))
      .toMatch(/past the end/);
  });

  test('a soccer clock must match its half', () => {
    expect(validateManualEntry({ ...soccer, clock: "80'", period: 1 }).errors.join(' '))
      .toMatch(/does not match period 1/);
    expect(validateManualEntry({ ...soccer, clock: "30'", period: 2 }).errors.join(' '))
      .toMatch(/does not match period 2/);
  });

  test('a clock without a period is refused', () => {
    expect(validateManualEntry({ ...soccer, period: 0 }).errors.join(' '))
      .toMatch(/clock was given without a period/);
  });

  test('a game that has not kicked off must be 0-0', () => {
    const r = validateManualEntry({
      sport: 'soccer', home_name: 'Arsenal', away_name: 'Chelsea',
      status: 'scheduled', home_score: 1, away_score: 0,
    });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/before kick-off/);
  });

  test('consistent entries for both sports still validate', () => {
    expect(validateManualEntry(soccer).valid).toBe(true);
    expect(validateManualEntry(basketball).valid).toBe(true);
    // Stoppage time inside regulation is fine.
    expect(validateManualEntry({ ...soccer, clock: "45+2'", period: 1 }).valid).toBe(true);
  });
});

describe('Manual LiveGame', () => {
  test('builds a user-entered game with the right tier and label', () => {
    const { ok, game, errors } = buildManualLiveGame({
      sport: 'soccer', home_name: 'Arsenal', away_name: 'Chelsea',
      home_score: 2, away_score: 1, status: 'live', clock: "67'", period: 2,
    }, { now: NOW });
    expect(ok).toBe(true);
    expect(errors).toEqual([]);
    expect(game.source).toBe(SOURCE_MANUAL);
    expect(game.game_id).toBeNull();
    expect(game.data_tier).toBe(TIERS.USER_ENTERED);
    expect(game.data_tier_label).toBe('User-entered');
    expect(game.manual).toBe(true);
    expect(game.home).toMatchObject({ name: 'Arsenal', score: 2 });
    expect(game.live).toMatchObject({ is_live: true, clock: "67'", period: 2 });
    expect(game.match.notes[0]).toMatch(/entered by the user/i);
  });

  test('an invalid manual entry returns no game and the full error list', () => {
    const r = buildManualLiveGame({ sport: 'soccer', home_name: '', away_name: '' }, { now: NOW });
    expect(r.ok).toBe(false);
    expect(r.game).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
  });

  test('dataTierLabel returns null for an unknown tier', () => {
    expect(dataTierLabel('nonsense')).toBeNull();
    expect(dataTierLabel(TIERS.FULL_LIVE)).toBe('Full live data');
  });
});
