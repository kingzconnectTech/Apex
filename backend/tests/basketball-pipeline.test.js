/**
 * Basketball pipeline end-to-end tests.
 * Wires normalise -> ratings -> projection -> adjustments -> sigma -> selection
 * and checks the formatted output shape and the "no forced pick" behaviour.
 */

const { analyzeGame, formatPrediction, predictGame, buildLines } = require('../services/basketball');
const { getLeagueConfig } = require('../services/basketball/leagues');

const HOME_ID = '13';
const AWAY_ID = '2';

/** Build a raw newest-first game log for one team. */
function mkLog(n, opts = {}) {
  const {
    pf = 112, pa = 108, fga = 88, orb = 10, tov = 13, fta = 22,
    oppFga = 87, oppOrb = 9, oppTov = 14, oppFta = 21,
    oppId = '99', isHome = true, backToBack = false, threeInFour = false, restDays = 2,
  } = opts;
  return Array.from({ length: n }, (_, i) => ({
    eventId: `e${oppId}-${i}`,
    date: new Date(Date.now() - (i + 1) * 2 * 86400000).toISOString(),
    timestamp: Date.now() - (i + 1) * 2 * 86400000,
    isHome,
    opponentId: oppId,
    pf, pa,
    boxScore: { fga, orb, tov, fta, oppFga, oppOrb, oppTov, oppFta },
    restDays: i === 0 ? restDays : 2,
    backToBack: i === 0 ? backToBack : false,
    threeInFour: i === 0 ? threeInFour : false,
    roadTripLength: 0,
  }));
}

function mkFixture() {
  const ts = Date.now() + 6 * 3600000;
  return {
    sport: 'basketball',
    league: { id: 'nba', sourceId: 'nba', name: 'NBA', slug: 'nba' },
    fixture: {
      id: '401', sourceId: '401',
      date: new Date(ts).toISOString(), timestamp: ts,
      status: 'scheduled', venue: 'Test Arena',
    },
    homeTeam: { id: HOME_ID, displayName: 'Home Hawks', abbreviation: 'HOM', score: null },
    awayTeam: { id: AWAY_ID, displayName: 'Away Aces', abbreviation: 'AWY', score: null },
  };
}

const ODDS = {
  spread: -4.5,
  overUnder: 220.5,
  overOdds: -110, underOdds: -110,
  homeSpreadOdds: -110, awaySpreadOdds: -110,
  homeMoneyLine: -180, awayMoneyLine: 155,
};

describe('Basketball pipeline', () => {
  test('analyzeGame produces a full internal result', () => {
    const result = analyzeGame({
      fixture: mkFixture(),
      odds: ODDS,
      injuries: [{ teamId: HOME_ID, playerName: 'Star', status: 'questionable' }],
      homeLog: mkLog(15, { pf: 118, pa: 104 }),
      awayLog: mkLog(15, { pf: 105, pa: 112, isHome: false, oppId: '99' }),
      league: 'nba',
    });

    expect(result).not.toBeNull();
    expect(result.game.id).toBe('401');
    expect(result.game.league).toBe('nba');
    expect(Number.isFinite(result.projection.total)).toBe(true);
    expect(Number.isFinite(result.projection.margin)).toBe(true);
    expect(result.projection.margin).toBeGreaterThan(0); // home team is stronger
    expect(result.sigma.total).toBeGreaterThan(0);
    expect(result.dataQuality.score).toBeGreaterThan(0.5);
    expect(result.lines.total.length).toBe(1);
    expect(result.lines.spread.length).toBe(1);
  });

  test('formatPrediction returns the documented JSON shape', () => {
    const out = predictGame({
      fixture: mkFixture(),
      odds: ODDS,
      injuries: [],
      homeLog: mkLog(20, { pf: 120, pa: 108 }),
      awayLog: mkLog(20, { pf: 104, pa: 114, isHome: false }),
      league: 'nba',
    });

    expect(out.game).toBe('Home Hawks vs Away Aces');
    expect(out.tipoff).toBeTruthy();
    expect(out.league).toBe('NBA');
    expect(out.projection).toHaveProperty('total');
    expect(out.projection).toHaveProperty('sigma_total');
    expect(out.projection).toHaveProperty('sigma_margin');
    expect(Array.isArray(out.picks)).toBe(true);
    expect(Array.isArray(out.key_factors)).toBe(true);
    expect(Array.isArray(out.risk_flags)).toBe(true);
    expect(out.data_quality).toBeGreaterThan(0);
    expect(out.modelVersion).toBeTruthy();
    out.picks.forEach(p => {
      expect(p).toHaveProperty('market');
      expect(p).toHaveProperty('selection');
      expect(p).toHaveProperty('probability');
      expect(p).toHaveProperty('edge');
      expect(p).toHaveProperty('confidence');
      expect(p.reasoning).toBeTruthy();
    });
  });

  test('a pick is never forced when nothing clears the thresholds', () => {
    // Make the market line sit exactly on the projection.
    const evenFixture = mkFixture();
    const result = analyzeGame({
      fixture: evenFixture,
      odds: { spread: -0.5, overUnder: null, overOdds: null, underOdds: null },
      homeLog: mkLog(10),
      awayLog: mkLog(10, { isHome: false }),
      league: 'nba',
    });
    expect(result.selection.noPick).toBe(true);
    expect(result.selection.picks).toEqual([]);
    expect(result.selection.noPickLabel).toBe('No confident pick');
  });

  test('missing odds still yields a projection but no odds-dependent picks', () => {
    const out = predictGame({
      fixture: mkFixture(),
      odds: null,
      homeLog: mkLog(12, { pf: 116, pa: 108 }),
      awayLog: mkLog(12, { pf: 106, pa: 114, isHome: false }),
      league: 'nba',
    });
    expect(Number.isFinite(out.projection.total)).toBe(true);
    expect(out.picks.length).toBe(0);
    expect(out.noPick).toBe(true);
    // The missing odds show up as a data-quality penalty rather than a forced pick.
    expect(out.data_quality_penalties.some(p => /odds/i.test(p.reason))).toBe(true);
  });

  test('buildLines maps ESPN odds into selector lines', () => {
    const lines = buildLines(ODDS);
    expect(lines.total[0]).toMatchObject({ line: 220.5, isMain: true });
    expect(lines.spread[0]).toMatchObject({ line: -4.5, isMain: true });
  });

  test('league aliases resolve and unknown leagues throw', () => {
    expect(getLeagueConfig('basketball/mens-college-basketball').key).toBe('ncaa');
    expect(() => getLeagueConfig('curling')).toThrow();
  });
});
