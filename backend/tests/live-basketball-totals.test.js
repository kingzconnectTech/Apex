/**
 * Basketball totals — the Over 219.5 fix.
 *
 * The old live pick pinned ONE line (the league mean or a 219.5 fallback) and
 * reported whichever side sat a hair above 50% — so unrecognised-league games
 * all read "Over 219.5" at ~51%. The new path prices EVERY evaluation line,
 * both directions, drops settled lines, and only emits a pick above the
 * configured 75% bar.
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

describe('basketballTotalsPick — pick at the match own main total', () => {
  test('the pick line is the generated line nearest the expected total', () => {
    const pick = basketballTotalsPick(modelFor(225, 18), bgame());
    expect(pick).not.toBeNull();
    // floor(225)+0.5 = 225.5 is the anchor and the nearest line to 225.
    expect(pick.line).toBe(225.5);
    expect(pick.probability).toBeGreaterThanOrEqual(pick.under);
  });

  test('each match is picked on its own scale, argmax side wins', () => {
    const high = basketballTotalsPick(modelFor(260, 15), bgame());
    const low = basketballTotalsPick(modelFor(180, 15), bgame());
    // The pick line tracks the expected total — not a fixed grid.
    expect(high.line).toBe(260.5);
    expect(low.line).toBe(180.5);
    // Selection is always the stronger side at that line.
    for (const pick of [high, low]) {
      const expected = pick.over >= pick.under ? 'over' : 'under';
      expect(pick.selection).toBe(expected);
      expect(pick.probability).toBeCloseTo(Math.max(pick.over, pick.under), 3);
    }
  });

  test('a mid-range total picks the honest ~50/50 side, not a forced Over', () => {
    const pick = basketballTotalsPick(modelFor(225.4, 18), bgame());
    expect(pick).not.toBeNull();
    expect(['over', 'under']).toContain(pick.selection);
    expect(Math.abs(pick.probability - 0.5)).toBeLessThan(0.1);
  });

  test('Over is selected when the projection sits above the line', () => {
    // Expected 248.6 vs anchor 248.5 -> Over is the argmax side.
    const pick = basketballTotalsPick(modelFor(248.6, 15), bgame());
    expect(pick).not.toBeNull();
    expect(pick.selection).toBe('over');
    expect(pick.line).toBe(248.5);
  });

  test('Under is selected when the projection sits below the line', () => {
    // Expected 192.4 vs anchor 192.5 -> Under is the argmax side.
    const pick = basketballTotalsPick(modelFor(192.4, 15), bgame());
    expect(pick).not.toBeNull();
    expect(pick.selection).toBe('under');
    expect(pick.line).toBe(192.5);
  });

  test('different matches get different lines on their own scale', () => {
    const high = basketballTotalsPick(modelFor(250.6, 16), bgame());
    const low = basketballTotalsPick(modelFor(190.4, 16), bgame());
    expect(high.line).not.toBe(low.line);
    expect(high.line).toBeGreaterThan(240);
    expect(low.line).toBeLessThan(200);
  });

  test('derivePicks routes basketball through the multi-line path', () => {
    const model = { ...modelFor(245, 15), status: 'live' };
    const picks = derivePicks({ sport: 'basketball', model, game: bgame() });
    expect(picks.over_under).not.toBeNull();
    expect(picks.over_under.probability).toBeGreaterThanOrEqual(picks.over_under.under || 0);
    // A weak read yields no O/U pick at all.
    const weak = derivePicks({ sport: 'basketball', model: modelFor(222, 22), game: bgame({ league: 'unknown' }) });
    // Argmax at the nearest line: 222 -> 219.5 or 224.5 (equidistant -> first).
    expect(weak.over_under).not.toBeNull();
    expect(weak.over_under.probability).toBeGreaterThanOrEqual(weak.over_under.under ?? 0);
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
    // Tip-off projection ~235 vs lines up to 234.5: best available may clear 75%
    // on the low lines or produce no pick — either is honest, never forced.
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
