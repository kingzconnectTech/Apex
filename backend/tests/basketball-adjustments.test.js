/**
 * Basketball adjustments + data-quality + calibration unit tests.
 */

const {
  fatiguePenalty, injuryPenalty, paceInteractionTotal, computeAdjustments,
  computeDataQuality, coverageScore,
} = require('../services/basketball/adjustments');
const {
  fitIsotonic, applyIsotonic, fitPlatt, applyPlatt, brierScore, logLoss,
  calibrationCurve, Calibrator,
} = require('../services/basketball/calibration');
const { getLeagueConfig } = require('../services/basketball/leagues');
const CFG = require('../services/basketball/config');

const NBA = getLeagueConfig('nba');

describe('Fatigue adjustments', () => {
  test('back-to-back and 3-in-4 stack but stay within caps', () => {
    const p = fatiguePenalty({ backToBack: true, threeInFour: true }, CFG);
    expect(p.margin).toBeGreaterThan(0);
    expect(p.margin).toBeLessThanOrEqual(CFG.adjustments.caps.restMargin);
  });

  test('no flags for well-rested teams', () => {
    expect(fatiguePenalty({ backToBack: false, threeInFour: false }, CFG).margin).toBe(0);
  });
});

describe('Injury adjustments (probability-weighted, capped)', () => {
  test('an out player loses impact minus the replacement share', () => {
    const r = injuryPenalty([{ playerName: 'A', status: 'out' }], CFG);
    const expected = CFG.adjustments.injuries.defaultImpactMargin * (1 - CFG.adjustments.replacementLevelShare);
    expect(r.margin).toBeCloseTo(expected, 2);
  });

  test('questionable = half the impact of out', () => {
    const out = injuryPenalty([{ playerName: 'A', status: 'out' }], CFG).margin;
    const q = injuryPenalty([{ playerName: 'A', status: 'questionable' }], CFG).margin;
    expect(q).toBeCloseTo(out * 0.5, 2);
  });

  test('per-player margin is capped at 5', () => {
    const r = injuryPenalty([{ playerName: 'A', status: 'out', impactMargin: 100 }], CFG);
    expect(r.margin).toBeLessThanOrEqual(CFG.adjustments.caps.perPlayerMargin);
  });

  test('combined injury margin is capped', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ playerName: `P${i}`, status: 'out', impactMargin: 5 }));
    const r = injuryPenalty(many, CFG);
    expect(r.margin).toBeLessThanOrEqual(CFG.adjustments.caps.combined);
  });

  test('probable players barely move the line', () => {
    const r = injuryPenalty([{ playerName: 'A', status: 'probable' }], CFG);
    expect(r.margin).toBeLessThan(0.2);
  });
});

describe('Pace interaction', () => {
  test('two slow teams shrink the total; fast teams are left alone', () => {
    expect(paceInteractionTotal(95, NBA, CFG)).toBeLessThan(0);
    expect(paceInteractionTotal(105, NBA, CFG)).toBe(0);
  });
});

describe('Combined adjustments + overall caps', () => {
  test('total and margin adjustments respect overall ceilings', () => {
    const projection = { total: 220, margin: 3 };
    const adj = computeAdjustments({
      projection,
      homeRatings: { backToBack: true, threeInFour: true, pace: 92 },
      awayRatings: { backToBack: true, threeInFour: true, pace: 92 },
      injuries: {
        home: [{ playerName: 'H', status: 'out', impactMargin: 5 }],
        away: [{ playerName: 'A', status: 'questionable', impactMargin: 5 }],
      },
      leagueCfg: NBA,
      cfg: CFG,
    });
    expect(Math.abs(adj.margin)).toBeLessThanOrEqual(CFG.adjustments.caps.marginOverall);
    expect(Math.abs(adj.total)).toBeLessThanOrEqual(CFG.adjustments.caps.totalOverall);
    expect(adj.breakdown.length).toBeGreaterThan(0);
  });
});

describe('Data quality', () => {
  test('full data scores near 1; missing odds and small samples lower it', () => {
    const ratings = { gamesPlayed: 30, ortg: 112, drtg: 110, pace: 99 };
    const form = { season: { avgTotal: 220, ortg: 112, efgPct: 0.52 } };
    const full = computeDataQuality({
      homeRatings: ratings, awayRatings: ratings, homeForm: form, awayForm: form,
      injuries: { home: [], away: [] }, odds: { overUnder: 220 }, lineups: { home: { confirmed: false }, away: { confirmed: false } },
      leagueCfg: NBA, cfg: CFG,
    });
    const poor = computeDataQuality({
      homeRatings: { gamesPlayed: 1, ortg: null, drtg: null, pace: null },
      awayRatings: { gamesPlayed: 2, ortg: null, drtg: null, pace: null },
      homeForm: { season: {} }, awayForm: { season: {} },
      injuries: { home: [{ status: 'questionable' }], away: [] }, odds: null,
      lineups: { home: { confirmed: false }, away: { confirmed: false } },
      leagueCfg: NBA, cfg: CFG,
    });
    expect(full.score).toBeGreaterThan(0.95);
    expect(poor.score).toBeLessThan(full.score);
    expect(poor.penalties.length).toBeGreaterThan(0);
  });

  test('coverage score reflects missing core metrics', () => {
    expect(coverageScore({ ortg: 112, drtg: 110, pace: 99 }, { season: { avgTotal: 220, ortg: 112, efgPct: 0.5 } })).toBeCloseTo(1, 6);
    expect(coverageScore({}, { season: {} })).toBeCloseTo(0, 6);
  });
});

describe('Calibration', () => {
  // Build miscalibrated rows: predicted 0.9 wins 70%, predicted 0.6 wins 60%.
  function syntheticRows() {
    const rows = [];
    for (let i = 0; i < 100; i++) rows.push({ p: 0.9, y: i < 70 ? 1 : 0 });
    for (let i = 0; i < 100; i++) rows.push({ p: 0.6, y: i < 60 ? 1 : 0 });
    return rows;
  }

  test('isotonic regression is monotone and corrects overconfidence', () => {
    const model = fitIsotonic(syntheticRows(), { minSamples: 150 });
    expect(model).not.toBeNull();
    for (let i = 1; i < model.values.length; i++) {
      expect(model.values[i]).toBeGreaterThanOrEqual(model.values[i - 1]);
    }
    expect(applyIsotonic(model, 0.9)).toBeCloseTo(0.7, 2);
    expect(applyIsotonic(model, 0.6)).toBeCloseTo(0.6, 2);
  });

  test('Platt scaling trains and stays in [0,1]', () => {
    const model = fitPlatt(syntheticRows(), { minSamples: 150, iterations: 2000 });
    expect(model).not.toBeNull();
    const out = applyPlatt(model, 0.9);
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThan(1);
  });

  test('Calibrator falls back to identity when untrained, then applies once fitted', () => {
    const c = new Calibrator(CFG);
    expect(c.apply('nba', 'total_over', 0.9)).toBeCloseTo(0.9, 6);
    c.fit('nba', 'total_over', syntheticRows(), { minSamples: 150 });
    expect(c.has('nba', 'total_over')).toBe(true);
    expect(c.apply('nba', 'total_over', 0.9)).toBeCloseTo(0.7, 1);
    // A different league is still uncalibrated.
    expect(c.apply('wnba', 'total_over', 0.9)).toBeCloseTo(0.9, 6);
  });

  test('Calibrator refuses to fit on too few samples', () => {
    const c = new Calibrator(CFG);
    expect(c.fit('nba', 'spread_home', [{ p: 0.6, y: 1 }], { minSamples: 150 })).toBeNull();
    expect(c.has('nba', 'spread_home')).toBe(false);
  });

  test('Brier score and log loss ignore pushes', () => {
    const rows = [{ p: 0.7, y: 1 }, { p: 0.7, y: 0 }, { p: 0.7, y: null }];
    expect(brierScore(rows)).toBeCloseTo((0.09 + 0.49) / 2, 4);
    expect(logLoss(rows)).toBeCloseTo(-(Math.log(0.7) + Math.log(0.3)) / 2, 4);
  });

  test('calibration curve buckets by predicted probability', () => {
    const rows = [
      { p: 0.62, y: 1 }, { p: 0.63, y: 0 },
      { p: 0.72, y: 1 },
    ];
    const curve = calibrationCurve(rows, [0.6, 0.7, 1.01]);
    expect(curve[0].n).toBe(2);
    expect(curve[1].n).toBe(1);
    expect(curve[1].actual).toBe(1);
  });
});
