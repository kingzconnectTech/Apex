/**
 * Phase 2 — live game matcher unit tests.
 *
 * Providers are injected stubs, so the real ESPN/Pitch mapping and the real
 * fuzzy scoring run, but nothing touches the network. Raw payloads are shaped
 * exactly like the ones verified in Phase 0.
 */

const { parseLink } = require('../services/live/linkParser');
const {
  createLiveMatcher, STATUSES, mapLimit, buildSweep, withinWindow,
} = require('../services/live/matcher');
const { teamSimilarity, scoreFixture } = require('../services/live/teamMatch');
const { normalizeFixturePitchAPI } = require('../services/providers/normalizer');
const CFG = require('../services/live/config');

const NOW = Date.parse('2026-10-26T18:00:00.000Z');
const now = () => NOW;
const iso = offsetMinutes => new Date(NOW + offsetMinutes * 60 * 1000).toISOString();

/** Raw ESPN scoreboard event (same shape Phase 0 verified). */
function espnEvent({
  id, state = 'in', home, away, date = iso(-30), homeScore = 1, awayScore = 0,
}) {
  return {
    id: String(id),
    date,
    competitions: [{
      status: { type: { state }, displayClock: "34'", period: 1 },
      competitors: [
        { homeAway: 'home', team: { id: 'h' + id, displayName: home }, score: { value: homeScore } },
        { homeAway: 'away', team: { id: 'a' + id, displayName: away }, score: { value: awayScore } },
      ],
    }],
  };
}

/** Raw PitchAPI match (no clock/period, per Phase 0 findings). */
function pitchMatch({ id, home, away, status = 'live', date = iso(-30) }) {
  return {
    id,
    time_utc: date,
    status,
    score_home: 1,
    score_away: 0,
    home_team: { id: 10, name: home },
    away_team: { id: 11, name: away },
    league: { id: 8, name: 'Premier League' },
  };
}

function makeEspn(eventsByPath, { delayMs = 0 } = {}) {
  const requests = [];
  const espn = {
    requests,
    maxActive: 0,
    _request: async (path) => {
      requests.push(path);
      espn.maxActive = Math.max(espn.maxActive, espn._active = (espn._active || 0) + 1);
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      espn._active--;
      return eventsByPath[path] || { events: [] };
    },
  };
  return espn;
}

function makePitch(matchesByDate, { available = true } = {}) {
  return {
    isAvailable: () => available,
    isBlocked: () => false,
    calls: [],
    // Mirrors the real provider: getMatchesByDate returns NORMALISED fixtures.
    getMatchesByDate: async function (date) {
      this.calls.push(date);
      return (matchesByDate[date] || []).map(m => normalizeFixturePitchAPI(m)).filter(Boolean);
    },
  };
}

const PREMIER_URL = 'https://example.com/football/premier-league/manchester-united-vs-chelsea';

/* --------------------------------------------------------------- fuzzy core */

describe('Team similarity', () => {
  test('identical and alias-equivalent names score 1', () => {
    expect(teamSimilarity('Manchester United', 'Manchester United')).toBe(1);
    expect(teamSimilarity('man utd', 'Manchester United', 'soccer')).toBe(1);
  });

  test('a nickname contained in the full name scores high', () => {
    expect(teamSimilarity('Brighton', 'Brighton & Hove Albion')).toBeGreaterThanOrEqual(0.75);
  });

  test('a typo still scores high but below an exact match', () => {
    const s = teamSimilarity('Manchster United', 'Manchester United');
    expect(s).toBeGreaterThan(0.8);
    expect(s).toBeLessThan(1);
  });

  test('unrelated teams score low', () => {
    expect(teamSimilarity('Arsenal', 'Tottenham Hotspur')).toBeLessThan(0.3);
  });

  test('scoreFixture rejects a one-sided match', () => {
    const fixture = {
      homeTeam: { name: 'Manchester United' },
      awayTeam: { name: 'Chelsea' },
    };
    const parsed = { home_raw: 'Manchester United', away_raw: 'Fake Rovers', sport: 'soccer' };
    expect(scoreFixture(parsed, fixture, CFG.matcher.minSideSimilarity).score).toBe(0);
  });

  test('scoreFixture detects a swapped home/away order', () => {
    const fixture = { homeTeam: { name: 'Chelsea' }, awayTeam: { name: 'Manchester United' } };
    const parsed = { home_raw: 'Manchester United', away_raw: 'Chelsea', sport: 'soccer' };
    const out = scoreFixture(parsed, fixture, CFG.matcher.minSideSimilarity);
    expect(out.orientation).toBe('swapped');
    expect(out.score).toBeGreaterThan(0.9);
  });
});

/* ------------------------------------------------------------ sweep helpers */

describe('Sweep helpers', () => {
  test('buildSweep puts the league hint first and de-duplicates', () => {
    const list = buildSweep('soccer', { code: 'esp.1', sport: 'soccer' });
    expect(list[0]).toBe('esp.1');
    expect(list.filter(l => l === 'esp.1')).toHaveLength(1);
    expect(list).toContain('eng.1');
  });

  test('buildSweep ignores a hint for a different sport', () => {
    expect(buildSweep('soccer', { code: 'nba', sport: 'basketball' })[0]).toBe('eng.1');
  });

  test('withinWindow keeps live and near fixtures, drops distant ones', () => {
    expect(withinWindow({ fixture: { status: 'live', timestamp: NOW } }, NOW)).toBe(true);
    expect(withinWindow({ fixture: { status: 'scheduled', timestamp: NOW + 3 * 3600e3 } }, NOW)).toBe(true);
    expect(withinWindow({ fixture: { status: 'scheduled', timestamp: NOW + 10 * 3600e3 } }, NOW)).toBe(false);
    expect(withinWindow({ fixture: { status: 'finished', timestamp: NOW - 1 * 3600e3 } }, NOW)).toBe(true);
    expect(withinWindow({ fixture: { status: 'postponed', timestamp: NOW } }, NOW)).toBe(false);
  });

  test('mapLimit never exceeds the concurrency cap', async () => {
    let active = 0, peak = 0;
    await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });
});

/* -------------------------------------------------------------- resolveGame */

describe('resolveGame — ESPN match', () => {
  test('a single unambiguous high-confidence fixture is returned as matched', async () => {
    const espn = makeEspn({
      'soccer/eng.1/scoreboard': {
        events: [espnEvent({ id: 401, home: 'Manchester United', away: 'Chelsea' })],
      },
    });
    const matcher = createLiveMatcher({ espn, now });
    const out = await matcher.resolveGame(parseLink(PREMIER_URL));

    expect(out.status).toBe(STATUSES.MATCHED);
    expect(out.source).toBe('espn');
    expect(out.candidates).toHaveLength(1);
    expect(out.manual_entry_required).toBe(false);
    expect(out.candidates[0].match_confidence).toBeGreaterThanOrEqual(CFG.matcher.tiers.high);
    expect(out.candidates[0].fixture.fixture.id).toBe('401');
    expect(out.candidates[0].fixture.fixture.status).toBe('live');
    expect(out.candidates[0].fixture.homeTeam.score).toBe(1);
  });

  test('the league hint is swept first', async () => {
    const espn = makeEspn({});
    const matcher = createLiveMatcher({ espn, now });
    await matcher.resolveGame(parseLink(PREMIER_URL));
    expect(espn.requests[0]).toBe('soccer/eng.1/scoreboard');
  });

  test('a reversed fixture is still matched and the orientation recorded', async () => {
    const espn = makeEspn({
      'soccer/eng.1/scoreboard': {
        events: [espnEvent({ id: 402, home: 'Chelsea', away: 'Manchester United' })],
      },
    });
    const matcher = createLiveMatcher({ espn, now });
    const out = await matcher.resolveGame(parseLink(PREMIER_URL));
    expect(out.status).toBe(STATUSES.MATCHED);
    expect(out.candidates[0].orientation).toBe('swapped');
  });

  test('two equally plausible fixtures are returned as candidates for confirmation', async () => {
    const espn = makeEspn({
      'soccer/eng.1/scoreboard': {
        events: [espnEvent({ id: 403, home: 'Manchester United', away: 'Chelsea' })],
      },
      'soccer/eng.2/scoreboard': {
        events: [espnEvent({ id: 404, home: 'Manchester Utd', away: 'Chelsea' })],
      },
    });
    const matcher = createLiveMatcher({ espn, now });
    const out = await matcher.resolveGame(parseLink(PREMIER_URL));
    expect(out.status).toBe(STATUSES.CANDIDATES);
    expect(out.candidates.length).toBe(2);
    expect(out.candidates.length).toBeLessThanOrEqual(CFG.matcher.maxCandidates);
    expect(out.manual_entry_required).toBe(false);
  });

  test('concurrency stays within the configured cap during a full sweep', async () => {
    const espn = makeEspn({}, { delayMs: 3 });
    const matcher = createLiveMatcher({ espn, now });
    await matcher.resolveGame(parseLink(PREMIER_URL));
    expect(espn.maxActive).toBeLessThanOrEqual(CFG.matcher.maxConcurrency);
    expect(espn.requests.length).toBe(CFG.matcher.sweep.soccer.length);
  });

  test('only fixtures inside the time window are considered', async () => {
    const espn = makeEspn({
      'soccer/eng.1/scoreboard': {
        events: [
          espnEvent({ id: 405, home: 'Manchester United', away: 'Chelsea' }),
          espnEvent({
            id: 406, state: 'pre', home: 'Manchester United', away: 'Chelsea', date: iso(20 * 60),
          }),
        ],
      },
    });
    const matcher = createLiveMatcher({ espn, now });
    const out = await matcher.resolveGame(parseLink(PREMIER_URL));
    expect(out.stats.fixtures_considered).toBe(1);
    expect(out.candidates).toHaveLength(1);
  });
});

describe('resolveGame — Pitch fallback (soccer only)', () => {
  test('falls back to Pitch when ESPN finds nothing', async () => {
    const espn = makeEspn({});
    const pitch = makePitch({ [new Date(NOW).toISOString().slice(0, 10)]: [pitchMatch({ id: 900, home: 'Manchester United', away: 'Chelsea' })] });
    const matcher = createLiveMatcher({ espn, pitchApi: pitch, now });
    const out = await matcher.resolveGame(parseLink(PREMIER_URL));

    expect(out.status).toBe(STATUSES.MATCHED);
    expect(out.source).toBe('pitchapi');
    expect(out.stats.pitch_used).toBe(true);
    expect(out.candidates[0].fixture.fixture.id).toBe('pa-900');
  });

  test('does not consult Pitch when ESPN already matched', async () => {
    const espn = makeEspn({
      'soccer/eng.1/scoreboard': {
        events: [espnEvent({ id: 407, home: 'Manchester United', away: 'Chelsea' })],
      },
    });
    const pitch = makePitch({});
    const matcher = createLiveMatcher({ espn, pitchApi: pitch, now });
    await matcher.resolveGame(parseLink(PREMIER_URL));
    expect(pitch.calls).toHaveLength(0);
  });

  test('basketball never uses the Pitch fallback', async () => {
    const espn = makeEspn({});
    const pitch = makePitch({});
    const matcher = createLiveMatcher({ espn, pitchApi: pitch, now });
    await matcher.resolveGame(parseLink('https://x.com/basketball/nba/los-angeles-lakers-vs-boston-celtics'));
    expect(pitch.calls).toHaveLength(0);
  });
});

describe('resolveGame — honest failures', () => {
  test('no fixture anywhere yields manual entry', async () => {
    const espn = makeEspn({});
    const pitch = makePitch({});
    const matcher = createLiveMatcher({ espn, pitchApi: pitch, now });
    const out = await matcher.resolveGame(parseLink(PREMIER_URL));
    expect(out.status).toBe(STATUSES.NONE);
    expect(out.candidates).toEqual([]);
    expect(out.manual_entry_required).toBe(true);
    expect(out.reason).toMatch(/manual entry/i);
  });

  test('a non-recognised parse never sweeps', async () => {
    const espn = makeEspn({});
    const matcher = createLiveMatcher({ espn, now });
    const out = await matcher.resolveGame(parseLink('https://example.com/'));
    expect(out.status).toBe(STATUSES.NONE);
    expect(espn.requests).toHaveLength(0);
  });

  test('an upstream error is logged and does not throw', async () => {
    const espn = {
      requests: [],
      _request: async () => { throw new Error('boom'); },
    };
    const logs = [];
    const matcher = createLiveMatcher({ espn, now, logger: { log: (...a) => logs.push(a) } });
    const out = await matcher.resolveGame(parseLink(PREMIER_URL));
    expect(out.status).toBe(STATUSES.NONE);
    expect(out.stats.errors).toBeGreaterThan(0);
    expect(logs.some(l => l[0] === 'warn')).toBe(true);
  });

  test('basketball sweeps the basketball league list', async () => {
    const espn = makeEspn({
      'basketball/nba/scoreboard': {
        events: [espnEvent({ id: 500, home: 'Los Angeles Lakers', away: 'Boston Celtics', homeScore: 88, awayScore: 84 })],
      },
    });
    const matcher = createLiveMatcher({ espn, now });
    const out = await matcher.resolveGame(parseLink('https://x.com/basketball/nba/los-angeles-lakers-vs-boston-celtics'));
    expect(out.status).toBe(STATUSES.MATCHED);
    expect(espn.requests[0]).toBe('basketball/nba/scoreboard');
    expect(espn.requests.length).toBe(CFG.matcher.sweep.basketball.length);
  });
});
