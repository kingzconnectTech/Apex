/**
 * tests/basketball-backtest.test.js
 *
 * Covers the walk-forward harness:
 *   - TR-21.1  no game with tip-off after the training cutoff enters the training fold
 *   - TR-21.2  every metric per market/league + the explicit beat/lose statement
 *   - TR-21.3  probability buckets are computed with non-empty sample sizes
 */

const {
  mergeDeep,
  normalizeWindows,
  windowOf,
  buildTeamLogs,
  priorLog,
  toFixture,
  toOdds,
  toClosing,
  calibKeyFor,
  rawProbabilityFor,
  computeClv,
  evaluate,
  metrics,
  compareBaselines,
  favouriteBaseline,
  tuneHyperparameters,
  runBacktest,
  formatReport,
  DEFAULT_CANDIDATES,
} = require('../services/basketball/backtester');

const { synthesizeDataset } = require('../../backend/scripts/run-basketball-backtest');

const DAY = 24 * 60 * 60 * 1000;

function iso(dayOffset) {
  return new Date(Date.UTC(2024, 0, 1) + dayOffset * DAY).toISOString();
}

/** A minimal 4-game, 2-team dataset with explicit tip-offs and box scores. */
function tinyDataset() {
  const box = (points) => ({
    fgm: 40, fga: 85, tpm: 12, tpa: 33, ftm: 15, fta: 20, orb: 10, drb: 30,
    tov: 13, ast: 22, stl: 7, blk: 4, pf: 19, _points: points,
  });
  const mk = (id, day, home, hScore, aScore) => ({
    gameId: id,
    tipoff: iso(day),
    league: 'nba',
    home: { teamId: home ? 'A' : 'B', name: home ? 'Alpha' : 'Bravo', score: hScore, stats: box(hScore) },
    away: { teamId: home ? 'B' : 'A', name: home ? 'Bravo' : 'Alpha', score: aScore, stats: box(aScore) },
    odds: { total: 220.5, overOdds: -110, underOdds: -110, spread: -4.5, homeOdds: -110, awayOdds: -110 },
    closing: { total: 221.5, overOdds: -110, underOdds: -110, spread: -5.5, homeOdds: -110, awayOdds: -110 },
  });
  return [
    mk('g1', 0, true, 112, 104),
    mk('g2', 3, false, 100, 110),
    mk('g3', 6, true, 118, 99),
    mk('g4', 9, false, 105, 101),
  ];
}

describe('basketball backtester — utilities', () => {
  test('mergeDeep merges nested config without dropping siblings', () => {
    const base = { ratings: { halfLifeGames: 9, elo: { enabled: true, k: 20 } }, projection: { paceBlendWeight: 0.55 } };
    const merged = mergeDeep(base, { ratings: { halfLifeGames: 7 } });
    expect(merged.ratings.halfLifeGames).toBe(7);
    expect(merged.ratings.elo.k).toBe(20);
    expect(merged.projection.paceBlendWeight).toBe(0.55);
    expect(base.ratings.halfLifeGames).toBe(9); // base untouched
  });

  test('normalizeWindows fills defaults for missing windows', () => {
    const w = normalizeWindows({ test: [0.9, 1.0] });
    expect(w.train).toEqual([0, 0.6]);
    expect(w.validation).toEqual([0.6, 0.8]);
    expect(w.test).toEqual([0.9, 1.0]);
  });

  test('windowOf maps chronological fractions to train/validation/test', () => {
    const w = normalizeWindows();
    expect(windowOf(0, 100, w)).toBe('train');
    expect(windowOf(59, 100, w)).toBe('train');
    expect(windowOf(60, 100, w)).toBe('validation');
    expect(windowOf(79, 100, w)).toBe('validation');
    expect(windowOf(80, 100, w)).toBe('test');
    expect(windowOf(99, 100, w)).toBe('test');
  });

  test('toOdds / toClosing / toFixture adapt the dataset shape', () => {
    const g = tinyDataset()[0];
    const odds = toOdds(g);
    expect(odds.overUnder).toBe(220.5);
    expect(odds.spread).toBe(-4.5);
    expect(odds.homeSpreadOdds).toBe(-110);

    const closing = toClosing(g);
    expect(closing.total).toBe(221.5);
    expect(closing.spread).toBe(-5.5);

    const fx = toFixture(g, 'nba');
    expect(fx.fixture.id).toBe('g1');
    expect(fx.homeTeam.displayName).toBe('Alpha');
    expect(fx.fixture.timestamp).toBe(Date.parse(iso(0)));
  });

  test('toOdds returns null when no line is present', () => {
    expect(toOdds({ gameId: 'x', home: {}, away: {} })).toBeNull();
  });
});

describe('basketball backtester — no leakage (TR-21.1)', () => {
  test('priorLog never contains the game itself or any later game', () => {
    const games = tinyDataset().sort((a, b) => new Date(a.tipoff) - new Date(b.tipoff));
    const byTeam = buildTeamLogs(games);

    // For each game, a team's prior log must only contain strictly earlier tip-offs.
    games.forEach((g, i) => {
      const ts = new Date(g.tipoff).getTime();
      const log = priorLog(byTeam, g.home.teamId, ts);
      expect(log.every(e => e.timestamp < ts)).toBe(true);
      const expected = games.slice(0, i).filter(x => x.home?.teamId === g.home.teamId || x.away?.teamId === g.home.teamId).length;
      expect(log.length).toBe(expected);
    });
  });

  test('the first game for a team has an empty prior log', () => {
    const games = tinyDataset().sort((a, b) => new Date(a.tipoff) - new Date(b.tipoff));
    const byTeam = buildTeamLogs(games);
    const first = games[0];
    expect(priorLog(byTeam, first.home.teamId, new Date(first.tipoff).getTime()).length).toBe(0);
  });

  test('training fold never contains a game that tipped off after the cutoff', () => {
    const games = tinyDataset().sort((a, b) => new Date(a.tipoff) - new Date(b.tipoff));
    const byTeam = buildTeamLogs(games);

    // A "cutoff" at the third game: everything used to evaluate game 3 must be
    // strictly earlier than game 3's tip-off.
    const cutoffTs = new Date(games[2].tipoff).getTime();
    ['home', 'away'].forEach(side => {
      const log = priorLog(byTeam, games[2][side].teamId, cutoffTs);
      log.forEach(entry => expect(entry.timestamp < cutoffTs).toBe(true));
      expect(log.some(e => e.timestamp >= cutoffTs)).toBe(false);
    });
  });

  test('buildTeamLogs computes back-to-back flags from the real schedule', () => {
    // Games on days 0, 1 (B2B) and 5 for team A.
    const box = { fgm: 40, fga: 85, tpm: 12, tpa: 33, ftm: 15, fta: 20, orb: 10, drb: 30, tov: 13 };
    const mk = (id, day) => ({
      gameId: id, tipoff: iso(day), league: 'nba',
      home: { teamId: 'A', name: 'A', score: 100, stats: box },
      away: { teamId: 'B', name: 'B', score: 95, stats: box },
    });
    const byTeam = buildTeamLogs([mk('g1', 0), mk('g2', 1), mk('g3', 5)].sort((a, b) => new Date(a.tipoff) - new Date(b.tipoff)));
    const aLog = byTeam.get('A');
    expect(aLog[0].restDays).toBeNull();
    expect(aLog[0].backToBack).toBe(false);
    expect(aLog[1].restDays).toBe(1);
    expect(aLog[1].backToBack).toBe(true);
    expect(aLog[2].restDays).toBe(4);
    expect(aLog[2].backToBack).toBe(false);
  });
});

describe('basketball backtester — selection helpers', () => {
  test('calibKeyFor maps markets/sides to calibration keys', () => {
    expect(calibKeyFor({ market: 'Total Points', side: 'a' })).toBe('total_over');
    expect(calibKeyFor({ market: 'Total Points', side: 'b' })).toBe('total_under');
    expect(calibKeyFor({ market: 'Spread', side: 'a' })).toBe('spread_home');
    expect(calibKeyFor({ market: 'Spread', side: 'b' })).toBe('spread_away');
  });

  test('rawProbabilityFor reproduces the projection probability for the pick side', () => {
    const cfg = require('../services/basketball/config');
    const projection = { total: 218, margin: 6, sigmaTotal: 17, sigmaMargin: 11 };
    const overP = rawProbabilityFor({ market: 'Total Points', side: 'a', line: 208.5 }, projection, cfg);
    const underP = rawProbabilityFor({ market: 'Total Points', side: 'b', line: 208.5 }, projection, cfg);
    expect(overP).toBeGreaterThan(underP);
    expect(overP + underP).toBeCloseTo(1, 6);
  });

  test('computeClv is positive when we took a better price than the close, and null on a line mismatch', () => {
    const row = { market: 'Total Points', side: 'a', line: 220.5, odds: 1.95 };
    const closing = { total: 220.5, overOdds: -110, underOdds: -110 };
    expect(computeClv(row, closing)).toBeGreaterThan(0);
    // Different line -> not comparable -> null
    expect(computeClv({ ...row, line: 219.5 }, closing)).toBeNull();
  });
});

describe('basketball backtester — metrics', () => {
  test('metrics ignores pushes and computes Brier/log loss/ROI', () => {
    const rows = [
      { pCal: 0.7, y: 1, outcome: 'won', odds: 1.9, clv: 0.02 },
      { pCal: 0.7, y: 0, outcome: 'lost', odds: 1.9, clv: -0.01 },
      { pCal: 0.6, y: null, outcome: 'push', odds: 1.9, clv: null },
    ];
    const m = metrics(rows);
    expect(m.n).toBe(2);
    expect(m.pushes).toBe(1);
    expect(m.hitRate).toBeCloseTo(0.5, 6);
    expect(m.brier).toBeCloseTo((0.09 + 0.49) / 2, 4);
    expect(m.logLoss).toBeGreaterThan(0);
    expect(m.clv.n).toBe(2);
    expect(m.clv.beatRate).toBeCloseTo(0.5, 6);
  });

  test('metrics buckets (55-60 … 70+) have the documented ranges', () => {
    const ranges = metrics([]).buckets.map(b => b.range);
    expect(ranges).toEqual(['0.55-0.60', '0.60-0.65', '0.65-0.70', '0.70-1.00']);
  });

  test('compareBaselines scores model, uncalibrated, bookmaker and naive on the same rows', () => {
    // Well-calibrated model: states 0.75, and 3 of 4 such picks win. A model that
    // is *correctly* calibrated must beat both the bookmaker's implied probability
    // and the naive 0.5 baseline in log loss.
    const rows = [
      { pCal: 0.75, pRaw: 0.72, closingFair: 0.55, naiveP: 0.5, y: 1, outcome: 'won', odds: 1.9 },
      { pCal: 0.75, pRaw: 0.72, closingFair: 0.55, naiveP: 0.5, y: 1, outcome: 'won', odds: 1.9 },
      { pCal: 0.75, pRaw: 0.72, closingFair: 0.55, naiveP: 0.5, y: 1, outcome: 'won', odds: 1.9 },
      { pCal: 0.75, pRaw: 0.72, closingFair: 0.55, naiveP: 0.5, y: 0, outcome: 'lost', odds: 1.9 },
    ];
    const b = compareBaselines(rows);
    expect(b.model.n).toBe(4);
    expect(b.bookmaker.n).toBe(4);
    expect(b.naive.n).toBe(4);
    expect(b.model.logLoss).toBeLessThan(b.bookmaker.logLoss);
    expect(b.model.logLoss).toBeLessThan(b.naive.logLoss);
    // An overconfident model scores worse than a well-calibrated one.
    const overconfident = rows.map(r => ({ ...r, pCal: 0.95 }));
    expect(compareBaselines(overconfident).model.logLoss).toBeGreaterThan(b.model.logLoss);
  });

  test('favouriteBaseline grades the closing favourite and excludes pushes', () => {
    const gameRows = [
      { closing: { spread: -4.5, homeOdds: -110, awayOdds: -110 }, actualMargin: 10 }, // home fav covers
      { closing: { spread: -4.5, homeOdds: -110, awayOdds: -110 }, actualMargin: 1 },  // home fav loses
      { closing: { spread: -4.5, homeOdds: -110, awayOdds: -110 }, actualMargin: 4.5 },// push -> excluded
    ];
    const f = favouriteBaseline(gameRows);
    expect(f.n).toBe(2);
    expect(f.hitRate).toBeCloseTo(0.5, 6);
  });
});

describe('basketball backtester — end-to-end on a synthetic season', () => {
  const dataset = synthesizeDataset({ games: 360, teams: 12, seed: 7 });

  test('report carries every required metric per market and league (TR-21.2)', () => {
    const report = runBacktest(dataset);

    expect(report.dataset.games).toBe(360);
    ['overall', 'byWindow', 'byMarket', 'byLeague', 'uncalibrated'].forEach(k => expect(report[k]).toBeDefined());

    // Per-market metrics for both markets.
    expect(Object.keys(report.byMarket).sort()).toEqual(['Spread', 'Total Points']);
    Object.values(report.byMarket).forEach(m => {
      expect(m).toHaveProperty('hitRate');
      expect(m).toHaveProperty('brier');
      expect(m).toHaveProperty('logLoss');
      expect(m).toHaveProperty('roi');
      expect(m).toHaveProperty('clv');
      expect(Array.isArray(m.buckets)).toBe(true);
    });

    // Per-league.
    expect(report.byLeague.nba).toBeDefined();

    // Explicit beat/lose statement against the bookmaker's implied probabilities.
    expect(report.verdict).toHaveProperty('beatsBookmaker');
    expect(typeof report.verdict.statement).toBe('string');
    expect(report.verdict.statement).toMatch(/log loss|Insufficient/i);
  });

  test('probability buckets are populated with non-empty samples (TR-21.3)', () => {
    const report = runBacktest(dataset);
    const nonEmpty = report.overall.buckets.filter(b => b.n > 0);
    expect(nonEmpty.length).toBeGreaterThan(0);
    nonEmpty.forEach(b => {
      expect(b.predicted).toBeGreaterThan(0);
      expect(b.actual).toBeGreaterThanOrEqual(0);
      expect(b.actual).toBeLessThanOrEqual(1);
    });
  });

  test('sigma is estimated from residuals and is positive per direction', () => {
    const report = runBacktest(dataset);
    expect(report.residuals.total.n).toBeGreaterThan(0);
    expect(report.sigmaRecommendation.total).toBeGreaterThan(0);
    expect(report.sigmaRecommendation.margin).toBeGreaterThan(0);
  });

  test('the calibration harness is walk-forward: evaluated picks exist in every window', () => {
    const report = runBacktest(dataset);
    expect(report.byWindow.train.n).toBeGreaterThan(0);
    expect(report.byWindow.test.n).toBeGreaterThan(0);
  });

  test('a deliberately broken sigma config degrades calibration without crashing', () => {
    const report = runBacktest(dataset, { config: { sigma: { minTotal: 40, maxTotal: 40, minMargin: 40, maxMargin: 40 } } });
    expect(report.overall).toHaveProperty('logLoss');
    expect(report.verdict.statement).toEqual(expect.any(String));
  });
});

describe('basketball backtester — hyperparameter tuning', () => {
  const dataset = synthesizeDataset({ games: 300, teams: 10, seed: 11 });

  test('tuneHyperparameters evaluates every candidate and returns the best on validation', () => {
    const tuning = tuneHyperparameters(dataset, DEFAULT_CANDIDATES);
    expect(tuning.results.length).toBe(DEFAULT_CANDIDATES.length);
    expect(tuning.best).toBeTruthy();
    expect(tuning.best).toHaveProperty('label');
    expect(tuning.best.logLoss).toEqual(expect.any(Number));
    // The chosen candidate must be the minimum validation log loss.
    const valid = tuning.results.filter(r => r.n > 0 && r.logLoss != null);
    const minLL = Math.min(...valid.map(r => r.logLoss));
    expect(tuning.best.logLoss).toBeCloseTo(minLL, 6);
  });

  test('runBacktest freezes the tuned patch before the test window', () => {
    const report = runBacktest(dataset, { candidates: DEFAULT_CANDIDATES });
    expect(report.hyperparameters.source).toBe('tuned-on-validation');
    expect(report.hyperparameters.tuning.candidates.length).toBe(DEFAULT_CANDIDATES.length);
    expect(report.byWindow.test.n).toBeGreaterThan(0);
  });
});

describe('basketball backtester — evaluate() window tagging', () => {
  test('every pick row is tagged with a window and the dataset league', () => {
    const ev = evaluate(synthesizeDataset({ games: 200, teams: 10, seed: 3 }));
    expect(ev.rows.length).toBeGreaterThan(0);
    ev.rows.forEach(r => {
      expect(['train', 'validation', 'test']).toContain(r.window);
      expect(r.league).toBe('nba');
    });
  });
});

describe('basketball backtester — report formatting', () => {
  test('formatReport renders the disclaimer and the verdict', () => {
    const report = runBacktest(synthesizeDataset({ games: 160, teams: 10, seed: 5 }));
    const text = formatReport(report);
    expect(text).toMatch(/basketball backtest/i);
    expect(text).toMatch(/verdict:/i);
    expect(text).toMatch(/not betting advice/i);
  });
});
