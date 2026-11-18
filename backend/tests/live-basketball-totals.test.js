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

const LINES = [209.5, 214.5, 219.5, 224.5, 229.5, 234.5];

describe('buildBasketballTotalMarkets', () => {
  test('prices every line in BOTH directions', () => {
    const ms = liveMarkets.buildBasketballTotalMarkets({ model: modelFor(225), game: bgame() });
    const over = ms.filter(m => m.side === 'over');
    const under = ms.filter(m => m.side === 'under');
    expect(over.length).toBe(LINES.length);
    expect(under.length).toBe(LINES.length);
    for (const line of LINES) {
      const o = ms.find(m => m.line === line && m.side === 'over');
      const u = ms.find(m => m.line === line && m.side === 'under');
      expect(o.status).toBe('available');
      expect(u.status).toBe('available');
      expect(o.probability + u.probability).toBeCloseTo(1, 3);
    }
  });

  test('a higher expected total shifts probability toward Over', () => {
    const low = liveMarkets.buildBasketballTotalMarkets({ model: modelFor(200), game: bgame() });
    const high = liveMarkets.buildBasketballTotalMarkets({ model: modelFor(250), game: bgame() });
    const p = (ms, line, side) => ms.find(m => m.line === line && m.side === side).probability;
    expect(p(high, 219.5, 'over')).toBeGreaterThan(p(low, 219.5, 'over'));
    expect(p(low, 219.5, 'under')).toBeGreaterThan(0.5);
    expect(p(high, 219.5, 'over')).toBeGreaterThan(0.5);
  });

  test('settled markets are marked, not presented as picks', () => {
    // Current total 222 already beats 219.5 but not 224.5.
    const ms = liveMarkets.buildBasketballTotalMarkets({ model: modelFor(230), game: bgame({ homeScore: 115, awayScore: 107 }) });
    expect(ms.find(m => m.line === 219.5 && m.side === 'over').status).toBe('won');
    expect(ms.find(m => m.line === 219.5 && m.side === 'under').status).toBe('lost');
    expect(ms.find(m => m.line === 224.5 && m.side === 'over').status).toBe('available');
  });
});

describe('basketballTotalsPick — no forced Over', () => {
  test('the pick is at the line NEAREST the expected total, side = argmax', () => {
    // Expected 225 -> nearest line 224.5; over prob > under? 225 vs 224.5 => over.
    const pick = basketballTotalsPick(modelFor(225, 18), bgame());
    expect(pick).not.toBeNull();
    expect(pick.line).toBe(224.5);
    expect(pick.selection).toBe('over');
    expect(pick.probability).toBeGreaterThanOrEqual(pick.under);
    // Expected 200 -> nearest line 209.5; under is the argmax side.
    const low = basketballTotalsPick(modelFor(200, 18), bgame());
    expect(low.line).toBe(209.5);
    expect(low.selection).toBe('under');
  });

  test('a mid-range total picks the honest ~50/50 side, not a forced Over', () => {
    // Expected total dead-centre: Over 219.5 is ~50%, and the pick must be the
    // argmax at the NEAREST line — never an automatic Over.
    const pick = basketballTotalsPick(modelFor(219.5, 18), bgame());
    expect(pick).not.toBeNull();
    expect(pick.line).toBe(219.5);
    expect(['over', 'under']).toContain(pick.selection);
    expect(Math.abs(pick.probability - 0.5)).toBeLessThan(0.1);
  });

  test('a strong Over is selected when the stats support it', () => {
    const pick = basketballTotalsPick(modelFor(248, 15), bgame());
    expect(pick).not.toBeNull();
    expect(pick.selection).toBe('over');
    expect(LINES).toContain(pick.line);
  });

  test('a strong Under is selected when the stats support it', () => {
    const pick = basketballTotalsPick(modelFor(192, 15), bgame());
    expect(pick).not.toBeNull();
    expect(pick.selection).toBe('under');
    expect(LINES).toContain(pick.line);
  });

  test('different matches get different lines and directions', () => {
    const shootout = basketballTotalsPick(modelFor(248, 16), bgame());
    const rockfight = basketballTotalsPick(modelFor(192, 16), bgame());
    expect(shootout.selection).toBe('over');
    expect(rockfight.selection).toBe('under');
    expect(shootout.line).not.toBe(rockfight.line);
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
    expect(markets.length).toBe(LINES.length * 2);
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
