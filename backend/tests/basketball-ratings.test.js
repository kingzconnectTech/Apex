/**
 * Basketball ratings + projection unit tests.
 * Covers: possession formula, decay weights, shrinkage, prior blend, pace blend,
 * projection math (total & margin).
 */

const { normalizeBoxScore } = require('../services/basketball/normalize');
const {
  decayWeights, shrink, shrinkSplit, blendPrior, priorBlendWeight,
} = require('../services/basketball/ratings');
const { blendPace, projectGame, pointsFromTotalMargin } = require('../services/basketball/projection');
const { getLeagueConfig } = require('../services/basketball/leagues');
const CFG = require('../services/basketball/config');

const NBA = getLeagueConfig('nba');

describe('Basketball possession formula', () => {
  test('possessions = FGA - OREB + TOV + 0.44 * FTA', () => {
    const box = normalizeBoxScore({ fga: 80, orb: 10, tov: 12, fta: 20 }, NBA);
    expect(box.possessions).toBeCloseTo(90.8, 1);
  });

  test('opponent possessions use the same formula on opponent stats', () => {
    const box = normalizeBoxScore({ oppFga: 90, oppOrb: 8, oppTov: 15, oppFta: 25 }, NBA);
    expect(box.oppPossessions).toBeCloseTo(90 - 8 + 15 + 11, 1);
  });

  test('missing inputs leave possessions null (never fabricated)', () => {
    expect(normalizeBoxScore({ fga: 80, orb: 10, tov: 12 }, NBA).possessions).toBeNull();
  });

  test('eFG% = (FGM + 0.5*3PM) / FGA', () => {
    const box = normalizeBoxScore({ fgm: 40, fga: 80, tpm: 10 }, NBA);
    expect(box.efgPct).toBeCloseTo((40 + 5) / 80, 4);
  });
});

describe('Recency weighting + shrinkage', () => {
  test('decay weights halve at the half-life', () => {
    const w = decayWeights(19, 9);
    expect(w[0]).toBeCloseTo(1, 6);
    expect(w[9]).toBeCloseTo(0.5, 6);
    expect(w[18]).toBeCloseTo(0.25, 6);
  });

  test('shrinkage moves small samples toward the prior', () => {
    const small = shrink(120, 2, 110, 6); // w = 2/8 = 0.25
    expect(small).toBeCloseTo(120 * 0.25 + 110 * 0.75, 6);
    const large = shrink(120, 60, 110, 6); // w = 60/66
    expect(large).toBeGreaterThan(small);
  });

  test('split shrinkage pulls an 8-game split toward the overall rating', () => {
    const out = shrinkSplit(125, 8, 112, 4); // w = 8/12
    expect(out).toBeCloseTo(125 * (8 / 12) + 112 * (4 / 12), 6);
    expect(out).toBeLessThan(125);
    expect(out).toBeGreaterThan(112);
  });

  test('prior blend ramps current weight to full at 20 games', () => {
    expect(blendPrior(120, 110, 0, 20)).toBeCloseTo(110, 6);
    expect(blendPrior(120, 110, 10, 20)).toBeCloseTo(115, 6);
    expect(blendPrior(120, 110, 20, 20)).toBeCloseTo(120, 6);
    expect(priorBlendWeight(25, 20)).toBe(1);
  });
});

describe('Game projection', () => {
  test('blendPace of 0.5 is a plain average; higher leans to the faster team', () => {
    expect(blendPace(102, 96, 0.5)).toBeCloseTo(99, 6);
    expect(blendPace(102, 96, 0.55)).toBeCloseTo(99.3, 6);
    expect(blendPace(102, 96, 1)).toBeCloseTo(102, 6);
  });

  test('projects total, margin and home-court adjustment correctly', () => {
    const home = { ortg: 118, drtg: 106, pace: 102 };
    const away = { ortg: 110, drtg: 116, pace: 96 };
    const proj = projectGame({ home, away, leagueCfg: NBA, cfg: CFG });

    // expected possessions = 99.3
    expect(proj.expectedPossessions).toBeCloseTo(99.3, 2);
    // home ppp = (118+116)/2/100 = 1.17 ; away ppp = (110+106)/2/100 = 1.08
    const expTotal = 99.3 * 1.17 + 99.3 * 1.08;
    expect(proj.total).toBeCloseTo(expTotal, 1);
    const expMargin = 99.3 * (1.17 - 1.08) + NBA.homeCourtPoints;
    expect(proj.margin).toBeCloseTo(expMargin, 1);
  });

  test('pointsFromTotalMargin inverts total/margin into team scores', () => {
    const { homePoints, awayPoints } = pointsFromTotalMargin(220, 8);
    expect(homePoints).toBeCloseTo(114, 6);
    expect(awayPoints).toBeCloseTo(106, 6);
  });
});

describe('Multi-league: no hardcoded NBA constants', () => {
  test('each league carries its own pace, ratings and sigma', () => {
    const wnba = getLeagueConfig('wnba');
    const ncaa = getLeagueConfig('ncaa');
    expect(wnba.gameMinutes).toBe(40);
    expect(ncaa.gameMinutes).toBe(40);
    expect(wnba.leagueMean.possessions).not.toBe(NBA.leagueMean.possessions);
    expect(ncaa.sigma.total).not.toBe(NBA.sigma.total);
  });
});
