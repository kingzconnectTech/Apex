'use strict';

const {
  buildPreMatchMarkets,
  selectFootballMarkets,
  outcomeMatrix,
  totalGoalsDist,
  estimateHtRatio,
} = require('../services/footballMarkets');
const { settleMarket, marketRequiresStatistic } = require('../services/settlementService');

const mkMatches = (n, over = {}) =>
  Array.from({ length: n }, (_, i) => ({
    pf: over.pf ?? 1.4,
    pa: over.pa ?? 1.1,
    totalGoals: (over.pf ?? 1.4) + (over.pa ?? 1.1),
    isHome: i % 2 === 0,
    result: 'W',
    date: `2025-02-${String(i + 1).padStart(2, '0')}`,
    corners: over.corners ?? 5,
    opponentCorners: over.opponentCorners ?? 4,
    cornersConceded: over.cornersConceded ?? 4,
    opponentCornersConceded: over.opponentCornersConceded ?? 5,
    yellowCards: over.yellowCards ?? 1,
    opponentYellowCards: over.opponentYellowCards ?? 1,
    redCards: 0,
    opponentRedCards: 0,
    totalBookings: over.totalBookings ?? 2,
    htScore: { team: 1, opp: 0, total: 1 },
  }));

const baseInput = (over = {}) => ({
  homeExpected: 1.6,
  awayExpected: 1.0,
  homeName: 'Home FC',
  awayName: 'Away FC',
  homeMatches: mkMatches(8, over.home || {}),
  awayMatches: mkMatches(8, over.away || {}),
});

describe('footballMarkets — market evaluation', () => {
  test('evaluates all supported market families', () => {
    const c = buildPreMatchMarkets(baseInput());
    const cats = new Set(c.map(x => x.category));
    for (const cat of ['double_chance', 'goals', 'team_goals', 'btts', 'first_half', 'corners', 'cards']) {
      expect(cats.has(cat)).toBe(true);
    }
    expect(c.some(x => x.category === 'first_half')).toBe(true);
    expect(c.some(x => x.category === 'corners')).toBe(true);
    expect(c.some(x => x.category === 'cards')).toBe(true);
  });

  test('double chance probabilities derive from the same 1X2 matrix', () => {
    const oc = outcomeMatrix(1.6, 1.0);
    const c = buildPreMatchMarkets(baseInput());
    const dc = Object.fromEntries(
      c.filter(x => x.market === 'double_chance').map(x => [x.selection, x.probability])
    );
    expect(dc['1X']).toBeCloseTo(oc.home + oc.draw, 3);
    expect(dc['X2']).toBeCloseTo(oc.away + oc.draw, 3);
    expect(dc['12']).toBeCloseTo(oc.home + oc.away, 3);
    expect(dc['1X'] + dc['X2'] + dc['12']).toBeCloseTo(2, 3);
  });

  test('no straight Home/Draw/Away win markets are emitted', () => {
    const c = buildPreMatchMarkets(baseInput());
    expect(c.some(x => ['home_win', 'away_win', 'draw', 'match_result', '1x2'].includes(x.market))).toBe(false);
    expect(c.filter(x => x.market === 'double_chance')).toHaveLength(3);
  });

  test('goal lines are evaluated independently across FT/HT/2H/team', () => {
    const c = buildPreMatchMarkets(baseInput());
    const ft = c.filter(x => x.family === 'goals_ft').map(x => x.market);
    expect(ft).toEqual(expect.arrayContaining(['over_0_5_goals', 'under_4_5_goals', 'over_2_5_goals', 'under_2_5_goals']));
    const ht = c.filter(x => x.family === 'goals_ht').map(x => x.market);
    expect(ht).toEqual(expect.arrayContaining(['over_0_5_ht', 'under_0_5_ht', 'over_1_5_ht', 'under_1_5_ht']));
    const tg = c.filter(x => x.category === 'team_goals').map(x => x.market);
    expect(tg).toEqual(expect.arrayContaining(['home_over_0_5_goals', 'home_under_2_5_goals', 'away_under_1_5_goals']));
  });

  test('under 4.5 and over 0.5 have different probabilities (not a fixed pick)', () => {
    const c = buildPreMatchMarkets(baseInput());
    const u45 = c.find(x => x.market === 'under_4_5_goals');
    const o05 = c.find(x => x.market === 'over_0_5_goals');
    expect(u45.probability).not.toBe(o05.probability);
    // λ_total = 2.6 → P(≥1 goal) ≈ 0.926, P(≤4) ≈ 0.88 — genuinely different markets.
    expect(o05.probability).toBeGreaterThan(u45.probability);
  });

  test('BTTS yes/no are complementary', () => {
    const c = buildPreMatchMarkets(baseInput());
    const yes = c.find(x => x.market === 'btts' && x.selection === 'yes');
    const no = c.find(x => x.market === 'btts' && x.selection === 'no');
    expect(yes.probability + no.probability).toBeCloseTo(1, 4);
  });

  test('corner and card markets are priced from real match stats', () => {
    const c = buildPreMatchMarkets(baseInput());
    const corners = c.filter(x => x.category === 'corners');
    const cards = c.filter(x => x.category === 'cards');
    expect(corners.length).toBeGreaterThan(0);
    expect(cards.length).toBeGreaterThan(0);
    expect(corners.every(x => x.model === 'poisson_corners' || x.model === 'poisson_corners_team')).toBe(true);
    // Each match contributes corners=5 + opponentCorners=4 → total 9 per match.
    const totalLine = corners.find(x => x.market.startsWith('corners_over_'));
    expect(totalLine).toBeTruthy();
  });

  test('missing statistics produce no corner/card markets (not fabricated zeros)', () => {
    const c = buildPreMatchMarkets({
      homeExpected: 1.5, awayExpected: 1.0,
      homeMatches: [{ pf: 1, pa: 1 }], awayMatches: [{ pf: 1, pa: 1 }],
    });
    expect(c.filter(x => x.category === 'corners')).toHaveLength(0);
    expect(c.filter(x => x.category === 'cards')).toHaveLength(0);
    // Goal markets still work — they need only expected goals.
    expect(c.some(x => x.market === 'double_chance')).toBe(true);
  });

  test('ht ratio is estimated from real HT scores, defaulting to 0.40', () => {
    const matches = mkMatches(10, {});
    const ratio = estimateHtRatio(matches, matches);
    // htScore.total = 1, totalGoals ≈ 2.5 → ratio ≈ 0.4
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(0.7);
    expect(estimateHtRatio([], [])).toBe(0.40);
  });
});

describe('footballMarkets — selection engine', () => {
  const cands = buildPreMatchMarkets(baseInput());

  test('only markets at/above the 90% threshold are selected', () => {
    const sel = selectFootballMarkets(cands, { threshold: 0.9 });
    sel.forEach(x => expect(x.probability).toBeGreaterThanOrEqual(0.9));
  });

  test('mutually exclusive family members do not all appear', () => {
    const sel = selectFootballMarkets(cands, { threshold: 0.5, maxPicks: 20 });
    const dc = sel.filter(x => x.family === 'double_chance');
    expect(dc.length).toBeLessThanOrEqual(1);
    const btts = sel.filter(x => x.family === 'btts');
    expect(btts.length).toBeLessThanOrEqual(1);
  });

  test('no picks when nothing clears the threshold', () => {
    const sel = selectFootballMarkets(cands, { threshold: 0.999 });
    expect(sel).toHaveLength(0);
  });

  test('higher-probability markets rank first', () => {
    const sel = selectFootballMarkets(cands, { threshold: 0.5 });
    for (let i = 1; i < sel.length; i += 1) {
      expect(sel[i - 1].probability).toBeGreaterThanOrEqual(sel[i].probability);
    }
  });
});

describe('footballMarkets — settlement of new market keys', () => {
  const extra = {
    htHome: 1, htAway: 0, totalCorners: 9, totalBookings: 4,
    homeCorners: 5, awayCorners: 4, homeBookings: 2, awayBookings: 2,
  };

  test('double chance settles on full-time score', () => {
    expect(settleMarket('double_chance', '1X', 2, 1, {})).toBe('won');
    expect(settleMarket('double_chance', 'X2', 0, 1, {})).toBe('won');
    expect(settleMarket('double_chance', '12', 1, 1, {})).toBe('lost');
  });

  test('all FT goal lines settle', () => {
    expect(settleMarket('over_0_5_goals', 'over', 0, 0, {})).toBe('lost');
    expect(settleMarket('over_0_5_goals', 'over', 1, 0, {})).toBe('won');
    expect(settleMarket('under_4_5_goals', 'under', 2, 2, {})).toBe('won');
    expect(settleMarket('over_3_5_goals', 'over', 2, 2, {})).toBe('won');
    expect(settleMarket('under_0_5_goals', 'under', 0, 0, {})).toBe('won');
  });

  test('HT and 2H goal lines settle on period scores', () => {
    // FT 2-1, HT 1-0 → HT total 1, 2H total 2
    expect(settleMarket('over_0_5_ht', 'over', 2, 1, extra)).toBe('won');
    expect(settleMarket('under_0_5_ht', 'under', 2, 1, extra)).toBe('lost');
    expect(settleMarket('over_0_5_2h', 'over', 2, 1, extra)).toBe('won');
    expect(settleMarket('under_1_5_2h', 'under', 2, 1, extra)).toBe('lost'); // 2H total = 2
    expect(settleMarket('under_1_5_2h', 'under', 0, 0, { htHome: 0, htAway: 0 })).toBe('won');
  });

  test('team goal markets settle per side', () => {
    expect(settleMarket('home_over_0_5_goals', 'over', 1, 0, {})).toBe('won');
    expect(settleMarket('home_under_2_5_goals', 'under', 2, 3, {})).toBe('won');
    expect(settleMarket('away_under_1_5_goals', 'under', 1, 3, {})).toBe('lost');
    expect(settleMarket('home_under_0_5_goals', 'under', 0, 2, {})).toBe('won');
  });

  test('BTTS and HT result markets settle', () => {
    expect(settleMarket('btts', 'yes', 1, 1, {})).toBe('won');
    expect(settleMarket('btts', 'no', 0, 1, {})).toBe('won');
    expect(settleMarket('ht_double_chance', '1X', 2, 0, extra)).toBe('won');
    expect(settleMarket('ht_double_chance', 'X2', 0, 1, extra)).toBe('lost'); // HT was 1-0
    expect(settleMarket('ht_draw', 'draw', 1, 1, { htHome: 1, htAway: 1 })).toBe('won');
  });

  test('dynamic corner and card lines settle', () => {
    expect(settleMarket('corners_over_8_5', 'over', 2, 1, extra)).toBe('won');   // 9 > 8.5
    expect(settleMarket('corners_over_10_5', 'over', 2, 1, extra)).toBe('lost');  // 9 < 10.5
    expect(settleMarket('corners_under_11_5', 'under', 2, 1, extra)).toBe('won');
    expect(settleMarket('home_corners_over_2_5', 'over', 2, 1, extra)).toBe('won');  // 5 > 2.5
    expect(settleMarket('away_corners_under_5_5', 'under', 2, 1, extra)).toBe('won'); // 4 < 5.5
    expect(settleMarket('cards_over_2_5', 'over', 2, 1, extra)).toBe('won');    // 4 > 2.5
    expect(settleMarket('cards_under_4_5', 'under', 2, 1, extra)).toBe('won');  // 4 < 4.5
    expect(settleMarket('home_cards_over_0_5', 'over', 2, 1, extra)).toBe('won');
    expect(settleMarket('away_cards_under_0_5', 'under', 2, 1, extra)).toBe('lost'); // away had 2
  });

  test('missing stats stay pending, never fabricated', () => {
    const noStats = {};
    expect(settleMarket('corners_over_8_5', 'over', 2, 1, noStats)).toBeNull();
    expect(settleMarket('cards_over_2_5', 'over', 2, 1, noStats)).toBeNull();
    expect(settleMarket('over_0_5_ht', 'over', 2, 1, noStats)).toBeNull();
    expect(marketRequiresStatistic('corners_over_8_5')).toBe('corners');
    expect(marketRequiresStatistic('home_corners_over_2_5')).toBe('corners');
    expect(marketRequiresStatistic('cards_over_2_5')).toBe('bookings');
    expect(marketRequiresStatistic('over_0_5_2h')).toBe('ht');
    expect(marketRequiresStatistic('ht_double_chance')).toBe('ht');
    expect(marketRequiresStatistic('home_over_0_5_goals')).toBeNull();
    expect(marketRequiresStatistic('btts')).toBeNull();
  });
});

describe('footballMarkets — model sanity', () => {
  test('total goals distribution sums to ~1', () => {
    const d = totalGoalsDist(1.6, 1.0);
    const sum = d.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 2);
  });

  test('different matches produce different market probabilities', () => {
    const high = buildPreMatchMarkets({ ...baseInput(), homeExpected: 2.8, awayExpected: 2.2 });
    const low = buildPreMatchMarkets({ ...baseInput(), homeExpected: 0.7, awayExpected: 0.5 });
    const o25h = high.find(x => x.market === 'over_2_5_goals');
    const o25l = low.find(x => x.market === 'over_2_5_goals');
    expect(o25h.probability).toBeGreaterThan(o25l.probability);
  });
});
