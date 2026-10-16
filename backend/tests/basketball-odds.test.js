/**
 * Task 11 — basketball odds / injury / schedule extraction from ESPN.
 *
 * TR-11.1: A mocked summary with `pickcenter` yields spread/total and
 *          open/close/live odds; a summary without odds yields null and no crash.
 * TR-11.2: A mocked `injury[]` yields mapped statuses; absent injuries -> [].
 * TR-11.3: Rest-days / B2B / 3-in-4 / road-trip flags are computed from a log.
 */

const { EspnProvider } = require('../services/providers/EspnProvider');

const provider = new EspnProvider({ fetchFn: async () => ({ ok: true, json: async () => ({}) }) });

describe('extractBasketballOdds (TR-11.1)', () => {
  test('reads spread/total/prices plus open/close/live from pickcenter', () => {
    const summary = {
      pickcenter: [{
        provider: { name: 'ESPN BET' },
        spread: -4.5,
        overUnder: 221.5,
        overOdds: -110,
        underOdds: -108,
        homeTeamOdds: { moneyLine: -180, spreadOdds: -105, favorite: true },
        awayTeamOdds: { moneyLine: 155, spreadOdds: -115, favorite: false },
        pointSpread: { open: -3, close: -4.5, live: -5 },
        total: { open: 219, close: 221.5, live: 222.5 },
        moneyline: {
          open: { homeMoneyLine: -160, awayMoneyLine: 140 },
          close: { homeMoneyLine: -180, awayMoneyLine: 155 },
        },
      }],
    };

    const odds = EspnProvider.extractBasketballOdds(summary);
    expect(odds.spread).toBe(-4.5);
    expect(odds.overUnder).toBe(221.5);
    expect(odds.overOdds).toBe(-110);
    expect(odds.underOdds).toBe(-108);
    expect(odds.homeMoneyLine).toBe(-180);
    expect(odds.awayMoneyLine).toBe(155);
    expect(odds.homeSpreadOdds).toBe(-105);
    expect(odds.awaySpreadOdds).toBe(-115);
    expect(odds.open).toEqual(expect.objectContaining({ spread: -3, total: 219, homeMoneyLine: -160 }));
    expect(odds.close).toEqual(expect.objectContaining({ spread: -4.5, total: 221.5, awayMoneyLine: 155 }));
    expect(odds.live).toEqual(expect.objectContaining({ spread: -5, total: 222.5 }));
  });

  test('falls back to summary.odds when pickcenter is empty', () => {
    const odds = EspnProvider.extractBasketballOdds({ odds: [{ spread: 2.5, overUnder: 210.5, overOdds: -105, underOdds: -115 }] });
    expect(odds.spread).toBe(2.5);
    expect(odds.overUnder).toBe(210.5);
  });

  test('returns null (never 0) when no odds are supplied', () => {
    expect(EspnProvider.extractBasketballOdds({})).toBeNull();
    expect(EspnProvider.extractBasketballOdds({ pickcenter: [], odds: [] })).toBeNull();
    expect(EspnProvider.extractBasketballOdds(null)).toBeNull();
  });

  test('parseAmericanOdds unwraps object wrappers and rejects junk', () => {
    expect(EspnProvider.parseAmericanOdds('-108')).toBe(-108);
    expect(EspnProvider.parseAmericanOdds('+150')).toBe(150);
    expect(EspnProvider.parseAmericanOdds({ value: -110 })).toBe(-110);
    expect(EspnProvider.parseAmericanOdds({ odds: '+145' })).toBe(145);
    expect(EspnProvider.parseAmericanOdds('')).toBeNull();
    expect(EspnProvider.parseAmericanOdds('EVEN')).toBeNull();
  });
});

describe('extractBasketballInjuries (TR-11.2)', () => {
  test('maps provider statuses into the canonical set', () => {
    const summary = {
      injuries: [{
        team: { id: '13', displayName: 'Home Hawks' },
        injuries: [
          { athlete: { id: '1', fullName: 'Star PG', position: { abbreviation: 'PG' } }, status: 'Questionable', details: { type: 'Ankle', side: 'Left' } },
          { athlete: { id: '2', fullName: 'Big Man' }, status: 'injury_status_out' },
          { athlete: { id: '3', fullName: 'Vet' }, type: { name: 'Day-To-Day' } },
          { athlete: { id: '4', fullName: 'Rookie' }, status: 'Probable' },
        ],
      }],
    };

    const injuries = EspnProvider.extractBasketballInjuries(summary);
    expect(injuries).toHaveLength(4);
    const byName = Object.fromEntries(injuries.map(i => [i.playerName, i.status]));
    expect(byName['Star PG']).toBe('questionable');
    expect(byName['Big Man']).toBe('out');
    expect(byName['Vet']).toBe('day-to-day');
    expect(byName['Rookie']).toBe('probable');
    expect(injuries[0].teamId).toBe('13');
    expect(injuries[0].position).toBe('PG');
    expect(injuries[0].injuryType).toBe('Ankle');
  });

  test('absent injuries yield an empty array, never fabricated players', () => {
    expect(EspnProvider.extractBasketballInjuries({})).toEqual([]);
    expect(EspnProvider.extractBasketballInjuries({ injuries: [] })).toEqual([]);
    expect(EspnProvider.extractBasketballInjuries(null)).toEqual([]);
  });
});

describe('processBasketballScheduleForTeam (TR-11.3)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 0, 20, 12, 0, 0);

  /** Build a completed ESPN event at `daysAgo`. */
  function event(id, daysAgo, { isHome, pf, pa }) {
    const date = new Date(now - daysAgo * DAY).toISOString();
    const home = isHome
      ? { team: { id: '13' }, homeAway: 'home', score: { value: pf } }
      : { team: { id: '13' }, homeAway: 'away', score: { value: pf } };
    const other = isHome
      ? { team: { id: '2' }, homeAway: 'away', score: { value: pa } }
      : { team: { id: '2' }, homeAway: 'home', score: { value: pa } };
    return {
      id: String(id),
      date,
      competitions: [{
        competitors: [home, other],
        status: { type: { state: 'post' } },
      }],
    };
  }

  test('computes rest days, back-to-back, 3-in-4 and road-trip length', () => {
    // Newest-first input order is handled internally (it sorts by timestamp).
    const events = [
      event(1, 1, { isHome: false, pf: 100, pa: 110 }),  // newest, away, 1 day after #2
      event(2, 2, { isHome: false, pf: 120, pa: 100 }),  // away, 2 days after #4
      event(3, 3, { isHome: false, pf: 99, pa: 101 }),   // away -> 3 away in a row so far
      event(4, 10, { isHome: true, pf: 115, pa: 100 }),  // older home game breaks the trip
    ];

    const log = provider.processBasketballScheduleForTeam(events, '13');

    expect(log).toHaveLength(4);
    expect(log[0].pf).toBe(100);
    expect(log[0].pa).toBe(110);
    expect(log[0].result).toBe('L');
    expect(log[0].isHome).toBe(false);

    // Newest game is 1 day after the previous -> back-to-back.
    expect(log[0].restDays).toBe(1);
    expect(log[0].backToBack).toBe(true);

    // Three games in the last 3 days -> 3-in-4 true for the newest game.
    expect(log[0].threeInFour).toBe(true);

    // Road trip: three consecutive away games back to the home game.
    expect(log[0].roadTripLength).toBe(3);
    expect(log[3].isHome).toBe(true);
    expect(log[3].roadTripLength).toBe(0);
  });

  test('ignores non-completed events and unknown team ids', () => {
    const scheduled = {
      id: 'x', date: new Date(now).toISOString(),
      competitions: [{ competitors: [{ team: { id: '13' }, score: {} }], status: { type: { state: 'pre' } } }],
    };
    expect(provider.processBasketballScheduleForTeam([scheduled], '13')).toEqual([]);
    expect(provider.processBasketballScheduleForTeam(undefined, '13')).toEqual([]);
  });

  test('extracts a basketball box score with null for absent stats', () => {
    const team = { statistics: [{ name: 'fieldGoalsMade', value: 40 }, { name: 'fieldGoalsAttempted', value: 88 }] };
    const box = EspnProvider.extractBasketballBoxScore(team, {});
    expect(box.fgm).toBe(40);
    expect(box.fga).toBe(88);
    expect(box.tpm).toBeNull();
    expect(box.orb).toBeNull();
  });
});
