/**
 * Live engine v2 — the 14 required scenarios plus stats/markets units.
 *
 * Pure maths: no network. Games are hand-built LiveGame-shaped objects;
 * stats are normalised through liveStats.normalizeStats from ESPN-shaped
 * boxscore payloads, exactly as the pipeline does.
 */

const { predictLive } = require('../services/live/liveModel');
const { buildAnalysis } = require('../services/live/analysis');
const liveStats = require('../services/live/liveStats');
const liveMarkets = require('../services/live/liveMarkets');

function game({ clock = "30'", period = 1, homeScore = 0, awayScore = 0, status = 'live', odds = null } = {}) {
  return {
    game_id: 'espn:1', sport: 'soccer', source: 'espn',
    league: { id: 'eng.1', name: 'L' },
    home: { id: 'h', name: 'Home', score: homeScore },
    away: { id: 'a', name: 'Away', score: awayScore },
    live: { status, is_live: status === 'live', clock, period },
    schedule: {}, data_tier: 'full_live', freshness: null,
    match: null, link: null, odds, manual: false,
  };
}

/** ESPN-shaped summary -> normalised stats (what getLiveStats produces). */
function statsFor({ home = {}, away = {} } = {}, fetchedAt = Date.now()) {
  const stat = (o) => Object.entries(o).map(([name, v]) => ({ name, displayValue: String(v) }));
  const summary = { boxscore: { teams: [
    { homeAway: 'home', statistics: stat(home) },
    { homeAway: 'away', statistics: stat(away) },
  ]}};
  return liveStats.normalizeStats(summary, { fetchedAt });
}

const FULL = {
  possessionPct: 50, totalShots: 8, shotsOnTarget: 4, blockedShots: 1,
  wonCorners: 4, yellowCards: 1, redCards: 0, totalPasses: 300, accuratePasses: 250,
};

function ctx(stats, extra = {}) {
  return { stats, momentum: null, ...extra };
}

const sum3 = p => p.home_win + p.draw + p.away_win;

describe('normaliseStats', () => {
  test('maps ESPN names, keeps missing as null, derives off-target', () => {
    const st = statsFor({ home: { totalShots: 10, shotsOnTarget: 5, blockedShots: 2, wonCorners: 6 }, away: { totalShots: 7, shotsOnTarget: 3, blockedShots: 1, wonCorners: 2 } });
    expect(st.home.shots).toBe(10);
    expect(st.home.shots_on_target).toBe(5);
    expect(st.home.shots_off_target).toBe(3);
    expect(st.home.corners).toBe(6);
    expect(st.away.corners).toBe(2);
    expect(st.home.possession_pct).toBeNull();
    expect(st.home.tackles).toBeNull();
  });

  test('dataQuality reports coverage and never invents', () => {
    const none = liveStats.dataQuality(null);
    expect(none.level).toBe('none');
    expect(none.stats_available).toBe(0);
    const full = statsFor({ home: FULL, away: FULL });
    const q = liveStats.dataQuality(full);
    expect(q.stats_available).toBeGreaterThanOrEqual(8);
    expect(q.level).toBe('high');
  });

  test('stale stats are flagged', () => {
    const st = statsFor({ home: FULL, away: FULL }, Date.now() - 10 * 60 * 1000);
    const q = liveStats.dataQuality(st);
    expect(q.stale).toBe(true);
    expect(q.level).toBe('stale');
  });
});

describe('normaliseBasketballStats', () => {
  const ball = ({ home = {}, away = {} } = {}) => {
    const stat = (o) => Object.entries(o).map(([name, v]) => ({ name, displayValue: String(v) }));
    const summary = { boxscore: { teams: [
      { homeAway: 'home', statistics: stat(home) },
      { homeAway: 'away', statistics: stat(away) },
    ]}};
    return liveStats.normalizeBasketballStats(summary, { fetchedAt: Date.now() });
  };

  test('parses compound shooting lines and counting stats, derives possessions', () => {
    const st = ball({
      home: {
        'fieldGoalsMade-fieldGoalsAttempted': '30-65',
        'threePointFieldGoalsMade-threePointFieldGoalsAttempted': '10-28',
        'freeThrowsMade-freeThrowsAttempted': '18-22',
        offensiveRebounds: 9, defensiveRebounds: 25, totalRebounds: 34,
        assists: 20, turnovers: 12, steals: 7, blocks: 4, fouls: 15,
      },
      // Away is missing offensiveRebounds, so its possessions cannot be derived.
      away: {
        'fieldGoalsMade-fieldGoalsAttempted': '28-60',
        'freeThrowsMade-freeThrowsAttempted': '14-18', turnovers: 9,
      },
    });
    expect(st.sport).toBe('basketball');
    expect(st.home.fgm).toBe(30);
    expect(st.home.fga).toBe(65);
    expect(st.home.tpm).toBe(10);
    expect(st.home.trb).toBe(34);
    // possessions = FGA - ORB + TOV + 0.44 * FTA = 65 - 9 + 12 + 0.44*22
    expect(st.home.possessions).toBeCloseTo(77.68, 2);
    // A missing input leaves the derived value null rather than guessing.
    expect(st.away.possessions).toBeNull();
    // Combined possessions (both teams) is what the live model's pace read uses.
    expect(st.totals.possessions).toBeCloseTo(st.home.possessions, 3);
  });

  test('dataQuality follows the basketball field set', () => {
    const both = {
      'fieldGoalsMade-fieldGoalsAttempted': '10-20',
      'freeThrowsMade-freeThrowsAttempted': '5-6',
      offensiveRebounds: 3, defensiveRebounds: 9, totalRebounds: 12,
      assists: 6, turnovers: 4, steals: 2, blocks: 1, fouls: 4,
    };
    const q = liveStats.dataQuality(ball({ home: both, away: both }));
    expect(q.stats_tracked).toBe(liveStats.BALL_TRACKED_FIELDS.length);
    expect(q.stats_available).toBeGreaterThanOrEqual(8);
    expect(q.level).toBe('high');
  });

  test('returns null when the boxscore has no team rows', () => {
    expect(liveStats.normalizeBasketballStats({})).toBeNull();
    expect(liveStats.normalizeBasketballStats({ boxscore: { teams: [] } })).toBeNull();
  });
});

describe('1X2 probabilities', () => {
  test('T1: 0-0 at 15 min evaluates all three outcomes', () => {
    const r = predictLive({ game: game({ clock: "15'" }) });
    expect(r.status).toBe('live');
    expect(sum3(r.probabilities)).toBeCloseTo(1, 3);
    expect(r.probabilities.home_win).toBeGreaterThan(0);
    expect(r.probabilities.draw).toBeGreaterThan(0);
    expect(r.probabilities.away_win).toBeGreaterThan(0);
  });

  test('T2: 0-0 at 80 min raises the draw probability vs 15 min', () => {
    const early = predictLive({ game: game({ clock: "15'" }) }).probabilities;
    const late = predictLive({ game: game({ clock: "80'", period: 2 }) }).probabilities;
    expect(late.draw).toBeGreaterThan(early.draw);
    expect(sum3(late)).toBeCloseTo(1, 3);
  });

  test('T3: 1-0 home at 30 still evaluates draw and away win', () => {
    const r = predictLive({ game: game({ clock: "30'", homeScore: 1 }) });
    expect(r.probabilities.home_win).toBeLessThan(0.95);
    expect(r.probabilities.draw).toBeGreaterThan(0.05);
    expect(r.probabilities.away_win).toBeGreaterThan(0.02);
    expect(sum3(r.probabilities)).toBeCloseTo(1, 3);
  });

  test('T4: 1-0 home at 85 keeps an equaliser alive but favours home', () => {
    const r = predictLive({ game: game({ clock: "85'", period: 2, homeScore: 1 }) });
    expect(r.probabilities.home_win).toBeGreaterThan(0.6);
    expect(r.probabilities.away_win).toBeGreaterThan(0);
    expect(r.probabilities.draw).toBeGreaterThan(0);
  });

  test('T5: away attacking stats shift probability toward away', () => {
    const g = game({ clock: "60'", period: 2, homeScore: 0, awayScore: 1 });
    const base = predictLive({ game: g });
    const awayDominant = predictLive({
      game: g,
      context: ctx(statsFor({
        home: { ...FULL, totalShots: 4, shotsOnTarget: 1, wonCorners: 1 },
        away: { ...FULL, totalShots: 14, shotsOnTarget: 8, wonCorners: 8 },
      })),
    });
    expect(awayDominant.probabilities.away_win).toBeGreaterThan(base.probabilities.away_win);
    expect(awayDominant.probabilities.home_win).toBeLessThan(base.probabilities.home_win);
  });

  test('T6: away leading is evaluated symmetrically (away can be the pick)', () => {
    const r = predictLive({ game: game({ clock: "70'", period: 2, homeScore: 0, awayScore: 1 }) });
    expect(r.probabilities.away_win).toBeGreaterThan(r.probabilities.home_win);
    const pick = require('../services/live/livePicks').matchResultPick('soccer', r.probabilities);
    expect(pick.selection).toBe('away');
  });

  test('T10: a red card shifts expected goals and probabilities', () => {
    const g = game({ clock: "60'", period: 2, homeScore: 1 });
    const plain = predictLive({ game: g });
    const red = predictLive({ game: g, context: ctx(statsFor({
      home: { ...FULL, redCards: 1 }, away: FULL,
    })) });
    expect(red.inputs.lambda_home).toBeLessThan(plain.inputs.lambda_home);
    expect(red.probabilities.home_win).toBeLessThan(plain.probabilities.home_win);
    expect(red.notes.join(' ')).toMatch(/Red-card/);
  });

  test('T13: changing live stats changes the probabilities', () => {
    const g = game({ clock: "50'", period: 2 });
    const calm = predictLive({ game: g, context: ctx(statsFor({ home: FULL, away: FULL })) });
    const pressure = predictLive({
      game: g,
      context: ctx(statsFor({
        home: { ...FULL, shotsOnTarget: 12, wonCorners: 12 },
        away: { ...FULL, shotsOnTarget: 1, wonCorners: 1 },
      })),
    });
    expect(pressure.probabilities.home_win).toBeGreaterThan(calm.probabilities.home_win);
  });
});

describe('goal markets', () => {
  function marketsFor(g, stats) {
    const model = predictLive({ game: g, context: stats ? ctx(stats) : {} });
    return liveMarkets.buildSoccerMarkets({ model, game: g, stats, elapsed: model.inputs && model.inputs.elapsed_minutes, remaining: model.inputs && model.inputs.remaining_minutes });
  }
  const find = (ms, market, line, side) => ms.find(m => m.market === market && m.line === line && m.side === side);

  test('T7: 1-1 at 65 — Over 2.5 is available and needs exactly one more goal', () => {
    const ms = marketsFor(game({ clock: "65'", period: 2, homeScore: 1, awayScore: 1 }));
    const over = find(ms, 'total_goals', 2.5, 'over');
    const under = find(ms, 'total_goals', 2.5, 'under');
    expect(over.status).toBe('available');
    expect(under.status).toBe('available');
    // One more goal settles it: neither side is a lock.
    expect(over.probability).toBeGreaterThan(0.2);
    expect(over.probability).toBeLessThan(0.95);
    expect(over.probability + under.probability).toBeCloseTo(1, 3);
  });

  test('T8: 2-1 at 55 — Over 2.5 already achieved, never a fresh pick', () => {
    const g = game({ clock: "55'", period: 2, homeScore: 2, awayScore: 1 });
    const ms = marketsFor(g);
    const over = find(ms, 'total_goals', 2.5, 'over');
    const under = find(ms, 'total_goals', 2.5, 'under');
    expect(over.status).toBe('won');
    expect(under.status).toBe('lost');
    // The pick layer must refuse to recommend the settled line.
    const model = predictLive({ game: g });
    const { derivePicks } = require('../services/live/livePicks');
    const picks = derivePicks({ sport: 'soccer', model, game: g, markets: ms });
    expect(picks.over_under).toBeNull();
  });

  test('T9: 0-0 with very few chances does not inflate Over 2.5', () => {
    const g = game({ clock: "30'", homeScore: 0, awayScore: 0 });
    const quiet = statsFor({
      home: { ...FULL, totalShots: 1, shotsOnTarget: 0, wonCorners: 0 },
      away: { ...FULL, totalShots: 1, shotsOnTarget: 0, wonCorners: 0 },
    });
    const model = predictLive({ game: g, context: ctx(quiet) });
    const ms = liveMarkets.buildSoccerMarkets({ model, game: g, stats: quiet });
    const over = find(ms, 'total_goals', 2.5, 'over');
    expect(over.status).toBe('available');
    expect(over.probability).toBeLessThan(0.6);
  });

  test('markets sum check: over + under = 1 for every available goal line', () => {
    const g = game({ clock: "40'", period: 1, homeScore: 1, awayScore: 0 });
    const ms = marketsFor(g, statsFor({ home: FULL, away: FULL }));
    for (const line of [0.5, 1.5, 2.5, 3.5, 4.5]) {
      const o = find(ms, 'total_goals', line, 'over');
      const u = find(ms, 'total_goals', line, 'under');
      if (o.status === 'available') expect(o.probability + u.probability).toBeCloseTo(1, 3);
    }
  });

  test('corner markets only appear with real corner stats', () => {
    const g = game({ clock: "50'", period: 2, homeScore: 1, awayScore: 1 });
    const withStats = marketsFor(g, statsFor({ home: FULL, away: FULL }));
    const corners = withStats.filter(m => m.market === 'corners');
    expect(corners.length).toBeGreaterThan(0);
    const noStats = marketsFor(g, null);
    const c2 = noStats.filter(m => m.market === 'corners');
    expect(c2.every(m => m.status === 'unavailable' || m.key === 'corners_unavailable')).toBe(true);
  });
});

describe('momentum', () => {
  test('recorded stat deltas produce a pressure share; model responds to it', () => {
    liveStats.resetSnapshots();
    const t0 = Date.now();
    liveStats.recordAndDiff('g1', { home_shots_on_target: 2, away_shots_on_target: 2, home_corners: 1, away_corners: 1 }, t0);
    const m = liveStats.recordAndDiff('g1', { home_shots_on_target: 7, away_shots_on_target: 3, home_corners: 4, away_corners: 2 }, t0 + 4 * 60 * 1000);
    expect(m).not.toBeNull();
    expect(m.window_minutes).toBeGreaterThanOrEqual(3);
    expect(m.pressure_share_home).toBeGreaterThan(0.5);

    const g = game({ clock: "50'", period: 2, homeScore: 0, awayScore: 0 });
    const calm = predictLive({ game: g });
    const pushed = predictLive({ game: g, context: { momentum: m } });
    expect(pushed.inputs.lambda_home).toBeGreaterThan(calm.inputs.lambda_home);
    expect(pushed.notes.join(' ')).toMatch(/Momentum/);
    liveStats.resetSnapshots();
  });

  test('insufficient snapshot history yields no momentum claim', () => {
    liveStats.resetSnapshots();
    const m = liveStats.recordAndDiff('g2', { home_shots_on_target: 1, away_shots_on_target: 1 }, Date.now());
    expect(m).toBeNull();
  });
});

describe('analysis payload', () => {
  test('T11: missing statistics lower data quality, never invent values', () => {
    const g = game({ clock: "40'", homeScore: 1 });
    const emptyStats = liveStats.normalizeStats({ boxscore: { teams: [
      { homeAway: 'home', statistics: [] }, { homeAway: 'away', statistics: [] },
    ]}}, { fetchedAt: Date.now() });
    const a = buildAnalysis({ game: g, statsView: { stats: emptyStats, momentum: null, data_quality: liveStats.dataQuality(emptyStats) } });
    expect(a.data_quality.stats_available).toBe(0);
    expect(a.stats.home.shots).toBeNull();
    expect(a.stats.home.shots).not.toBe(0);
  });

  test('T14: a finished game produces no live markets or probabilities', () => {
    const g = game({ clock: "90'", period: 2, homeScore: 2, awayScore: 1, status: 'finished' });
    const a = buildAnalysis({ game: g });
    expect(a.markets).toBeNull();
    expect(a.probabilities).toBeNull();
  });

  test('payload carries stats, data_quality, confidence, markets, explanation', () => {
    const g = game({ clock: "55'", period: 2, homeScore: 2, awayScore: 1, odds: { overUnder: 2.5 } });
    const st = statsFor({ home: FULL, away: { ...FULL, shotsOnTarget: 2, wonCorners: 1 } });
    const a = buildAnalysis({ game: g, statsView: { stats: st, momentum: null, data_quality: liveStats.dataQuality(st) } });
    expect(a.stats).toBeTruthy();
    expect(a.data_quality.level).not.toBe('none');
    expect(a.confidence.level).toBeTruthy();
    expect(Array.isArray(a.markets)).toBe(true);
    expect(Array.isArray(a.explanation)).toBe(true);
    expect(a.explanation.length).toBeGreaterThan(0);
    // Probabilities still sum to 1.
    const p = a.probabilities;
    expect(p.home_win + p.draw + p.away_win).toBeCloseTo(1, 3);
  });
});
