/**
 * Basketball totals.
 *
 * The old live pick pinned ONE line (the league mean or a 219.5 fallback) and
 * reported whichever side sat a hair above 50% — so unrecognised-league games
 * all read "Over 219.5" at ~51%. The path now prices EVERY evaluation line,
 * both directions, drops settled lines, anchors the pick on the league-typical
 * MAIN total (the line a book would hang), and only emits a pick when its side
 * clears the configured 55% edge bar — otherwise: no pick.
 */

const { derivePicks, basketballTotalsPick, overUnderPick, overUnderLine } = require('../services/live/livePicks');
const liveMarkets = require('../services/live/liveMarkets');
const { predictLive } = require('../services/live/liveModel');
const { buildAnalysis } = require('../services/live/analysis');

function bgame({ clock = '12:00', period = 1, homeScore = 0, awayScore = 0, league = 'nba', status = 'live' } = {}) {
  return {
    game_id: 'espn:9', sport: 'basketball', source: 'espn',
    league: { id: league, name: 'L' },
    home: { id: 'h', name: 'Home', score: homeScore },
    away: { id: 'a', name: 'Away', score: awayScore },
    live: { status, is_live: status === 'live', clock, period },
    schedule: {}, data_tier: 'full_live', freshness: null,
    match: null, link: null, manual: false,
  };
}

function modelFor(total, sigma = 18) {
  return {
    status: 'live',
    expected: { total, margin: 3, home_score: total / 2, away_score: total / 2 },
    sigma: { total: sigma, margin: 11 },
    probabilities: { home_win: 0.55, away_win: 0.45 },
    inputs: {},
  };
}

// Lines are generated per match around expected.total; tests pin them
// explicitly where a fixed grid is needed.
const PINNED = [209.5, 214.5, 219.5, 224.5, 229.5, 234.5];

describe('buildBasketballTotalMarkets', () => {
  test("lines are generated around THIS match's expected total", () => {
    // A ~235 NBA projection and a ~145 NCAA projection must NOT share a grid.
    const nba = liveMarkets.buildBasketballTotalMarkets({ model: modelFor(235), game: bgame() });
    const ncaa = liveMarkets.buildBasketballTotalMarkets({ model: modelFor(145), game: bgame({ league: 'ncaa' }) });
    const nbaLines = [...new Set(nba.map(m => m.line))].sort((a, b) => a - b);
    const ncaaLines = [...new Set(ncaa.map(m => m.line))].sort((a, b) => a - b);
    expect(nbaLines).not.toEqual(ncaaLines);
    // The line nearest the projection is within half a point of it.
    expect(Math.min(...nbaLines.map(l => Math.abs(l - 235)))).toBeLessThanOrEqual(0.5);
    expect(Math.min(...ncaaLines.map(l => Math.abs(l - 145)))).toBeLessThanOrEqual(0.5);
    expect(nbaLines.every(l => l > 200)).toBe(true);
    expect(ncaaLines.every(l => l < 200)).toBe(true);
  });

  test('prices every generated line in BOTH directions', () => {
    const ms = liveMarkets.buildBasketballTotalMarkets({ model: modelFor(225), game: bgame() });
    const lines = [...new Set(ms.map(m => m.line))];
    expect(lines.length).toBe(6);
    for (const line of lines) {
      const o = ms.find(m => m.line === line && m.side === 'over');
      const u = ms.find(m => m.line === line && m.side === 'under');
      expect(o.status).toBe('available');
      expect(u.status).toBe('available');
      expect(o.probability + u.probability).toBeCloseTo(1, 3);
    }
  });

  test('explicit lines are honoured (fixed grid still supported)', () => {
    const ms = liveMarkets.buildBasketballTotalMarkets({ model: modelFor(225), game: bgame(), lines: PINNED });
    expect(ms.filter(m => m.side === 'over').length).toBe(PINNED.length);
    const p = (m, line, side) => m.find(x => x.line === line && x.side === side).probability;
    const low = liveMarkets.buildBasketballTotalMarkets({ model: modelFor(200), game: bgame(), lines: PINNED });
    const high = liveMarkets.buildBasketballTotalMarkets({ model: modelFor(250), game: bgame(), lines: PINNED });
    expect(p(high, 219.5, 'over')).toBeGreaterThan(p(low, 219.5, 'over'));
    expect(p(low, 219.5, 'under')).toBeGreaterThan(0.5);
    expect(p(high, 219.5, 'over')).toBeGreaterThan(0.5);
  });

  test('settled markets are marked, not presented as picks', () => {
    // Current total 222 already beats 219.5 but not 224.5.
    const ms = liveMarkets.buildBasketballTotalMarkets({ model: modelFor(230), game: bgame({ homeScore: 115, awayScore: 107 }), lines: PINNED });
    expect(ms.find(m => m.line === 219.5 && m.side === 'over').status).toBe('won');
    expect(ms.find(m => m.line === 219.5 && m.side === 'under').status).toBe('lost');
    expect(ms.find(m => m.line === 224.5 && m.side === 'over').status).toBe('available');
  });
});

describe('basketballTotalsPick — pick anchored on the league main total', () => {
  // The NBA's fitted mean total is ~234.86, so its main line is 234.5. The pick
  // now sits on THAT line — the total a book would hang — not on the model's own
  // projection, and it is only emitted when a side clears the 55% edge bar.
  const NBA_MAIN = 234.5;

  test('the pick line is the league main total, not the model projection', () => {
    const pick = basketballTotalsPick(modelFor(225, 18), bgame());
    expect(pick).not.toBeNull();
    expect(pick.line).toBe(NBA_MAIN);
    // 225 is a long way under 234.5, so the honest side is the under.
    expect(pick.selection).toBe('under');
    expect(pick.probability).toBeCloseTo(pick.under, 3);
  });

  test('the same main line is used whatever the projection; only the side moves', () => {
    const high = basketballTotalsPick(modelFor(260, 15), bgame());
    const low = basketballTotalsPick(modelFor(180, 15), bgame());
    expect(high.line).toBe(NBA_MAIN);
    expect(low.line).toBe(NBA_MAIN);
    expect(high.selection).toBe('over');
    expect(low.selection).toBe('under');
    for (const pick of [high, low]) {
      const expected = pick.over >= pick.under ? 'over' : 'under';
      expect(pick.selection).toBe(expected);
      expect(pick.probability).toBeCloseTo(Math.max(pick.over, pick.under), 3);
    }
  });

  test('a genuine coin-flip at the main line yields no pick at all', () => {
    // Projection sits on the main line -> P(over) ~ 0.5 < 0.55 -> withheld.
    const pick = basketballTotalsPick(modelFor(NBA_MAIN - 0.1, 18), bgame());
    expect(pick).toBeNull();
  });

  test('Over is selected when the projection sits above the main line', () => {
    const pick = basketballTotalsPick(modelFor(248.6, 15), bgame());
    expect(pick).not.toBeNull();
    expect(pick.selection).toBe('over');
    expect(pick.line).toBe(NBA_MAIN);
  });

  test('Under is selected when the projection sits below the main line', () => {
    const pick = basketballTotalsPick(modelFor(192.4, 15), bgame());
    expect(pick).not.toBeNull();
    expect(pick.selection).toBe('under');
    expect(pick.line).toBe(NBA_MAIN);
  });

  test('each competition anchors on its OWN main line', () => {
    const nba = basketballTotalsPick(modelFor(250.6, 16), bgame());
    // An unrecognised league has no fitted mean -> the configured default line.
    const other = basketballTotalsPick(modelFor(250.6, 16), bgame({ league: 'unknown' }));
    expect(nba.line).toBe(NBA_MAIN);
    expect(other.line).toBe(219.5);
    expect(nba.selection).toBe('over');
  });

  test('a settled main line is not a fresh pick', () => {
    // Current total 240 already beats the 234.5 main line, so the pick must not
    // sit on it.
    const pick = basketballTotalsPick(modelFor(250, 15), bgame({ homeScore: 120, awayScore: 120 }));
    expect(pick === null || pick.line > NBA_MAIN).toBe(true);
  });

  test('derivePicks routes basketball through the anchored totals path', () => {
    const model = { ...modelFor(245, 15), status: 'live' };
    const picks = derivePicks({ sport: 'basketball', model, game: bgame() });
    expect(picks.over_under).not.toBeNull();
    expect(picks.over_under.line).toBe(NBA_MAIN);
    expect(picks.over_under.probability).toBeCloseTo(picks.over_under.over, 3);
    // A projection sitting on the main line is a coin flip -> no O/U pick.
    const weak = derivePicks({ sport: 'basketball', model: modelFor(NBA_MAIN - 0.1, 18), game: bgame() });
    expect(weak.over_under).toBeNull();
  });

  test('the legacy single-line pricer still works for callers that use it', () => {
    const line = overUnderLine('basketball', { league: { id: 'nba' } });
    expect(line).toBe(234.5);
    const p = overUnderPick('basketball', { expected: { total: 220 }, sigma: { total: 18 } }, { league: { id: 'nba' } });
    expect(p.selection).toBe('under');
  });
});

describe('live model integration', () => {
  test('a real predictLive basketball output flows into markets + picks', () => {
    const g = bgame({ clock: '12:00', period: 1 });
    const model = predictLive({ game: g });
    const markets = liveMarkets.buildBasketballTotalMarkets({ model, game: g });
    expect(markets.length).toBe(12);
    const picks = derivePicks({ sport: 'basketball', model, game: g });
    // Tip-off projection ~235 sits on the league main line, so the O/U read is a
    // coin flip and is withheld; that is honest, never forced.
    if (picks.over_under) {
      expect(picks.over_under.probability).toBeGreaterThanOrEqual(picks.over_under.under || 0);
      const m = markets.find(x => x.line === picks.over_under.line && x.side === picks.over_under.selection);
      expect(m.status).toBe('available');
    }
  });

  test('analysis payload exposes basketball markets and suppresses weak picks', () => {
    const g = bgame({ clock: '12:00', period: 1 });
    const a = buildAnalysis({ game: g });
    expect(Array.isArray(a.markets)).toBe(true);
    expect(a.markets.every(m => ['available', 'won', 'lost', 'unavailable'].includes(m.status))).toBe(true);
    if (a.picks && a.picks.over_under) {
      expect(a.picks.over_under.probability).toBeGreaterThanOrEqual(a.picks.over_under.under ?? 0);
    }
  });
});

describe('pre-match engine sanity', () => {
  // The pre-match pipeline (services/basketball) prices BOTH sides of every
  // real book line symmetrically — prove a Under pick is reachable there too.
  test('selectPicks can emit Under when the projection sits below the line', () => {
    const { selectPicks } = require('../services/basketball/lineSelector');
    const cfg = require('../services/basketball/config');
    const res = selectPicks({
      projection: { total: 200, margin: 4, sigmaTotal: 17, sigmaMargin: 11 },
      lines: { total: [{ line: 219.5, aOdds: -110, bOdds: -110, isMain: true }], spread: [] },
      ctx: { cfg, dataQuality: 0.9, confirmed: false, homeTeamName: 'H', awayTeamName: 'A' },
    });
    const totalPick = (res.picks || []).find(p => p.market === 'Total Points');
    expect(totalPick).toBeTruthy();
    expect(totalPick.selection).toBe('Under 219.5');
  });

  test('selectPicks can emit Over when the projection sits above the line', () => {
    const { selectPicks } = require('../services/basketball/lineSelector');
    const cfg = require('../services/basketball/config');
    const res = selectPicks({
      projection: { total: 240, margin: 4, sigmaTotal: 17, sigmaMargin: 11 },
      lines: { total: [{ line: 219.5, aOdds: -110, bOdds: -110, isMain: true }], spread: [] },
      ctx: { cfg, dataQuality: 0.9, confirmed: false, homeTeamName: 'H', awayTeamName: 'A' },
    });
    const totalPick = (res.picks || []).find(p => p.market === 'Total Points');
    expect(totalPick).toBeTruthy();
    expect(totalPick.selection).toBe('Over 219.5');
  });
});
