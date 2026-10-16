/**
 * Basketball probability unit tests.
 * Covers: normal/t CDF, sigma estimation from residuals, totals probability
 * (half-point + whole-number push handling), spread probability.
 */

const {
  normalCdf, studentTCdf, sigmaFromResiduals, estimateSigma,
  totalsProbability, spreadProbability, leagueMeanTotal,
} = require('../services/basketball/probability');
const { getLeagueConfig } = require('../services/basketball/leagues');
const CFG = require('../services/basketball/config');

const NBA = getLeagueConfig('nba');

describe('Normal CDF', () => {
  test('anchors', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 4);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });

  test('is monotone and symmetric', () => {
    expect(normalCdf(1)).toBeGreaterThan(normalCdf(0));
    expect(normalCdf(1) + normalCdf(-1)).toBeCloseTo(1, 4);
  });
});

describe('Student-t CDF (heavier tails)', () => {
  test('t with high df approaches the normal', () => {
    expect(studentTCdf(1.96, 2000)).toBeCloseTo(normalCdf(1.96), 2);
  });

  test('t with low df puts more mass in the tails than the normal', () => {
    // Upper-tail mass beyond 2 is larger for t.
    expect(1 - studentTCdf(2, 5)).toBeGreaterThan(1 - normalCdf(2));
  });
});

describe('Sigma from residuals', () => {
  test('recovers the sample standard deviation', () => {
    const residuals = [-20, 0, 20];
    expect(sigmaFromResiduals(residuals)).toBeCloseTo(20, 6);
  });

  test('returns null for too few points', () => {
    expect(sigmaFromResiduals([5])).toBeNull();
  });
});

describe('Per-game sigma estimation', () => {
  test('stays within configured bounds and rises when data quality drops', () => {
    const good = estimateSigma({ projTotal: 225, projMargin: 3, expectedPossessions: 99.5, dataQuality: 1, leagueCfg: NBA, cfg: CFG });
    const poor = estimateSigma({ projTotal: 225, projMargin: 3, expectedPossessions: 99.5, dataQuality: 0.6, leagueCfg: NBA, cfg: CFG });
    expect(good.total).toBeGreaterThanOrEqual(CFG.sigma.minTotal);
    expect(good.total).toBeLessThanOrEqual(CFG.sigma.maxTotal);
    expect(poor.total).toBeGreaterThan(good.total);
    expect(poor.margin).toBeGreaterThan(good.margin);
  });

  test('league mean total is the pace * combined efficiency', () => {
    const mt = leagueMeanTotal(NBA);
    expect(mt).toBeCloseTo(99.5 * (114 + 114) / 100, 1);
  });
});

describe('Totals probability', () => {
  test('half-point line is a clean two-way split (no push)', () => {
    const r = totalsProbability({ line: 208.5, projTotal: 218.4, sigmaTotal: 17.6, cfg: CFG });
    expect(r.push).toBe(0);
    expect(r.over + r.under).toBeCloseTo(1, 6);
    // P(Over) = 1 - Phi((208.5-218.4)/17.6)
    expect(r.over).toBeCloseTo(1 - normalCdf((208.5 - 218.4) / 17.6), 3);
    expect(r.over).toBeCloseTo(0.713, 2);
  });

  test('whole-number line exposes an explicit push probability that sums to 1', () => {
    const r = totalsProbability({ line: 218, projTotal: 218.4, sigmaTotal: 17.6, cfg: CFG });
    expect(r.push).toBeGreaterThan(0);
    expect(r.over + r.under + r.push).toBeCloseTo(1, 6);
  });
});

describe('Spread probability', () => {
  test('home -4.5 covers per the spec formula', () => {
    const r = spreadProbability({ spread: -4.5, projMargin: 7.2, sigmaMargin: 11.8, cfg: CFG });
    // 1 - Phi((-(-4.5) - 7.2)/11.8) = 1 - Phi(-0.2288)
    expect(r.home).toBeCloseTo(1 - normalCdf((4.5 - 7.2) / 11.8), 3);
    expect(r.home).toBeCloseTo(0.591, 2);
    expect(r.push).toBe(0);
    expect(r.home + r.away).toBeCloseTo(1, 6);
  });

  test('whole-number spread handles the push', () => {
    const r = spreadProbability({ spread: -2, projMargin: 2, sigmaMargin: 12, cfg: CFG });
    expect(r.home + r.away + r.push).toBeCloseTo(1, 6);
    expect(r.push).toBeGreaterThan(0);
  });
});

describe('Heavier-tailed distribution switch', () => {
  test('t distribution widens the tails versus normal at the same sigma', () => {
    const tCfg = JSON.parse(JSON.stringify(CFG));
    tCfg.sigma.distribution = 't';
    tCfg.sigma.tDf = 5;
    const n = totalsProbability({ line: 208.5, projTotal: 218.4, sigmaTotal: 17.6, cfg: CFG });
    const t = totalsProbability({ line: 208.5, projTotal: 218.4, sigmaTotal: 17.6, cfg: tCfg });
    expect(t.over).not.toBeCloseTo(n.over, 4);
    expect(t.over).toBeGreaterThan(0);
    expect(t.over).toBeLessThan(1);
  });
});
