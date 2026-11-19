/**
 * Phase 11 — the live picks.
 *
 * The two picks the Live Analysis screen shows are derived HERE, from a model
 * output plus the fixed-line configuration, and nowhere else. The rules these
 * tests pin down:
 *
 *   - a pick's confidence is the model's OWN probability for the selection it
 *     recommends — never inflated, never rounded up, never merely >= 0.5;
 *   - the Over/Under line is a FIXED sport/league constant, never the live
 *     projection, so confidence moves honestly as the game moves;
 *   - a market that cannot be priced is `null`, never a placeholder.
 */

const CONFIG = require('../services/live/config');
const {
  derivePicks, overUnderLine, matchResultPick, overUnderPick, rateCountPick, projectedCount,
  soccerOver, basketballOver,
} = require('../services/live/livePicks');
const liveMarkets = require('../services/live/liveMarkets');

const CFG = CONFIG.live.pickMarkets;

describe('overUnderLine — a fixed line per sport/league', () => {
  test('soccer uses the configured line', () => {
    expect(overUnderLine('soccer')).toBe(2.5);
  });

  test('basketball derives its line from the league mean, rounded to a half point', () => {
    // The fitted NBA mean total is ~234.86, so the line is 234.5 (a X.5 so the
    // total can never push).
    expect(overUnderLine('basketball', { league: { id: 'nba' } })).toBe(234.5);
  });

  test('an unrecognised basketball league falls back to the configured default', () => {
    expect(overUnderLine('basketball', { league: { id: 'not-a-league' } })).toBe(CFG.overUnder.basketball.defaultLine);
    expect(overUnderLine('basketball')).toBe(CFG.overUnder.basketball.defaultLine);
  });

  test('a sport with no configured market has no line', () => {
    expect(overUnderLine('hockey')).toBeNull();
    expect(overUnderLine('tennis')).toBeNull();
  });
});

describe('soccerOver — P(total > line) off the model distribution', () => {
  const dist = [
    { value: 0, prob: 0.10 },
    { value: 1, prob: 0.20 },
    { value: 2, prob: 0.30 },
    { value: 3, prob: 0.30 },
    { value: 4, prob: 0.10 },
  ];

  test('sums the mass strictly above the line', () => {
    expect(soccerOver(dist, 2.5)).toBeCloseTo(0.40, 6); // values 3 and 4
    expect(soccerOver(dist, 1.5)).toBeCloseTo(0.70, 6); // values 2, 3 and 4
  });

  test('clips to [0.001, 0.999] so a pick is never certain', () => {
    expect(soccerOver([{ value: 5, prob: 1 }], 2.5)).toBe(0.999);
    expect(soccerOver([{ value: 0, prob: 1 }], 2.5)).toBe(0.001);
  });

  test('returns null rather than guessing when the distribution is absent', () => {
    expect(soccerOver(null, 2.5)).toBeNull();
    expect(soccerOver([], 2.5)).toBeNull();
    expect(soccerOver([{ value: 1 }], 2.5)).toBeNull(); // no prob => no mass
  });
});

describe('basketballOver — P(total > line) from the normal total', () => {
  test('a line below the projected mean is more likely over than under', () => {
    expect(basketballOver(220, 18, 219.5)).toBeGreaterThan(0.5);
  });

  test('a line far above the mean is unlikely to be beaten', () => {
    expect(basketballOver(220, 18, 300)).toBeLessThan(0.5);
  });

  test('clips to [0.001, 0.999] so a pick is never certain', () => {
    expect(basketballOver(220, 18, 100)).toBe(0.999);
    expect(basketballOver(220, 18, 400)).toBe(0.001);
  });

  test('returns null when the normal is unusable', () => {
    expect(basketballOver(null, 18, 219.5)).toBeNull();
    expect(basketballOver(220, 0, 219.5)).toBeNull();
    expect(basketballOver(220, NaN, 219.5)).toBeNull();
  });
});

describe('matchResultPick — the most likely outcome', () => {
  test('soccer picks the highest of the 1X2 outcomes', () => {
    const pick = matchResultPick('soccer', { home_win: 0.6, draw: 0.2, away_win: 0.2 });
    expect(pick).toEqual({ market: '1x2', selection: 'home', probability: 0.6 });
  });

  test('a draw can win the pick outright', () => {
    const pick = matchResultPick('soccer', { home_win: 0.3, draw: 0.45, away_win: 0.25 });
    expect(pick.selection).toBe('draw');
  });

  test('basketball has no draw: it is a two-way moneyline', () => {
    const pick = matchResultPick('basketball', { home_win: 0.4, away_win: 0.6, draw: 0.9 });
    expect(pick.market).toBe('moneyline');
    expect(pick.selection).toBe('away');
    expect(pick.probability).toBe(0.6);
  });

  test('returns null without probabilities', () => {
    expect(matchResultPick('soccer', null)).toBeNull();
    expect(matchResultPick('soccer', {})).toBeNull();
  });
});

describe('overUnderPick — confidence is the picked side’s probability', () => {
  test('soccer prices the O/U against the fixed 2.5 line', () => {
    const model = { total_distribution: [{ value: 3, prob: 0.7 }, { value: 1, prob: 0.3 }] };
    const pick = overUnderPick('soccer', model, {});
    expect(pick.market).toBe('over_under');
    expect(pick.line).toBe(2.5);
    expect(pick.selection).toBe('over');
    expect(pick.probability).toBeCloseTo(0.7, 4);
    expect(pick.over).toBeCloseTo(0.7, 4);
    expect(pick.under).toBeCloseTo(0.3, 4);
  });

  test('an under pick reports 1 - over as its confidence', () => {
    const model = { total_distribution: [{ value: 3, prob: 0.3 }, { value: 0, prob: 0.7 }] };
    const pick = overUnderPick('soccer', model, {});
    expect(pick.selection).toBe('under');
    expect(pick.probability).toBeCloseTo(0.7, 4);
  });

  test('basketball prices against the league line', () => {
    const model = { expected: { total: 220 }, sigma: { total: 18 } };
    const pick = overUnderPick('basketball', model, { league: { id: 'nba' } });
    expect(pick.line).toBe(234.5);
    // 220 is well below 234.5, so the model favours the under.
    expect(pick.selection).toBe('under');
    expect(pick.probability).toBeGreaterThan(0.5);
  });

  test('returns null when the market cannot be priced', () => {
    expect(overUnderPick('hockey', {}, {})).toBeNull();
    expect(overUnderPick('soccer', {}, {})).toBeNull(); // no distribution
    expect(overUnderPick('basketball', {}, { league: { id: 'nba' } })).toBeNull(); // no expected/sigma
  });
});

describe('derivePicks — both markets, or null overall when unusable', () => {
  const liveModel = {
    status: 'live',
    probabilities: { home_win: 0.55, draw: 0.25, away_win: 0.2 },
    total_distribution: [{ value: 3, prob: 0.6 }, { value: 1, prob: 0.4 }],
  };

  test('returns both picks for a usable live model', () => {
    // Soccer match result is a Double Chance pick gated at the 90% bar:
    // 0.8 + 0.15 = 0.95 for 1X clears it.
    const strongModel = { ...liveModel, probabilities: { home_win: 0.8, draw: 0.15, away_win: 0.05 } };
    const picks = derivePicks({ sport: 'soccer', model: strongModel, game: {} });
    expect(picks.match_result.market).toBe('double_chance');
    expect(picks.match_result.selection).toBe('1x');
    expect(picks.match_result.probability).toBeCloseTo(0.95, 4);
    expect(picks.over_under.line).toBe(2.5);
  });

  test('soccer match result is suppressed below the 90% double-chance bar', () => {
    // 1X = 0.55 + 0.25 = 0.80 < 0.90 -> no forced pick.
    const picks = derivePicks({ sport: 'soccer', model: liveModel, game: {} });
    expect(picks.match_result).toBeNull();
    expect(picks.over_under).not.toBeNull();
  });

  test('a prior_only model (no in-game clock) still yields picks', () => {
    const picks = derivePicks({ sport: 'soccer', model: { ...liveModel, status: 'prior_only' }, game: {} });
    expect(picks).not.toBeNull();
  });

  test('returns null for a model that is neither live nor prior_only', () => {
    expect(derivePicks({ sport: 'soccer', model: { ...liveModel, status: 'unsupported' }, game: {} })).toBeNull();
  });

  test('returns null without a sport or a model', () => {
    expect(derivePicks({ model: liveModel, game: {} })).toBeNull();
    expect(derivePicks({ sport: 'soccer', game: {} })).toBeNull();
    expect(derivePicks()).toBeNull();
  });

  test('a model with a match result but no priceable O/U still returns the match result', () => {
    const picks = derivePicks({
      sport: 'soccer',
      model: { status: 'live', probabilities: { home_win: 0.75, draw: 0.2, away_win: 0.05 } },
      game: {},
    });
    expect(picks).not.toBeNull();
    expect(picks.match_result).not.toBeNull();
    expect(picks.match_result.market).toBe('double_chance');
    expect(picks.over_under).toBeNull();
  });

  test('picks are disabled entirely when the market config is switched off', () => {
    const saved = CFG.enabled;
    CFG.enabled = false;
    try {
      expect(derivePicks({ sport: 'soccer', model: liveModel, game: {} })).toBeNull();
    } finally {
      CFG.enabled = saved;
    }
  });
});

describe('rateCountPick — the main-line pick for corners/shots', () => {
  const mk = (market, line, side, probability, status = 'available') => ({
    market, line, side, probability, status,
  });

  test('takes the line nearest the projection with the stronger side', () => {
    const markets = [
      mk('corners', 7.5, 'over', 0.4), mk('corners', 7.5, 'under', 0.6),
      mk('corners', 9.5, 'over', 0.3), mk('corners', 9.5, 'under', 0.7),
    ];
    const pick = rateCountPick('corners', markets, 7.2);
    expect(pick.line).toBe(7.5);
    expect(pick.selection).toBe('under');
    expect(pick.probability).toBe(0.6);
    expect(pick.over).toBe(0.4);
    expect(pick.under).toBe(0.6);
  });

  test('settled lines and a foreign market are never candidates', () => {
    const markets = [
      mk('corners', 7.5, 'over', 1, 'won'), mk('corners', 7.5, 'under', 0, 'lost'),
      mk('shots', 9.5, 'over', 0.9), mk('shots', 9.5, 'under', 0.1),
    ];
    expect(rateCountPick('corners', markets, 7.5)).toBeNull();
  });

  test('a line priced in one direction only is not a candidate', () => {
    expect(rateCountPick('corners', [mk('corners', 7.5, 'over', 0.6)], 7.5)).toBeNull();
  });

  test('returns null rather than guessing without a priced market', () => {
    expect(rateCountPick('corners', [], 7.5)).toBeNull();
    expect(rateCountPick('corners', null, 7.5)).toBeNull();
  });

  test('without a projection the near-even line is the anchor', () => {
    const markets = [
      mk('corners', 5.5, 'over', 0.9), mk('corners', 5.5, 'under', 0.1),
      mk('corners', 8.5, 'over', 0.55), mk('corners', 8.5, 'under', 0.45),
    ];
    const pick = rateCountPick('corners', markets, null);
    expect(pick.line).toBe(8.5);
    expect(pick.selection).toBe('over');
  });
});

describe('derivePicks — corners and shots from the live-stat markets', () => {
  const soccerModel = {
    status: 'live',
    probabilities: { home_win: 0.5, draw: 0.3, away_win: 0.2 },
    total_distribution: [{ value: 3, prob: 0.6 }, { value: 1, prob: 0.4 }],
    inputs: { elapsed_minutes: 60, remaining_minutes: 30 },
  };
  const stats = { totals: { corners: 6, shots: 12 } };

  test('prices a corner pick and a shot pick from the live-stat markets', () => {
    const markets = liveMarkets.buildSoccerMarkets({ model: soccerModel, game: {}, stats });
    const picks = derivePicks({ sport: 'soccer', model: soccerModel, game: {}, markets, stats });
    expect(picks.corners).not.toBeNull();
    expect(picks.corners.market).toBe('corners');
    expect(picks.corners.line).toBeGreaterThan(0);
    expect(picks.corners.probability).toBeGreaterThanOrEqual(0.5);
    expect(picks.shots).not.toBeNull();
    expect(picks.shots.market).toBe('shots');
    expect(picks.shots.probability).toBeGreaterThanOrEqual(0.5);
  });

  test('no corner or shot pick when the provider gave no count', () => {
    const markets = liveMarkets.buildSoccerMarkets({ model: soccerModel, game: {}, stats: null });
    const picks = derivePicks({ sport: 'soccer', model: soccerModel, game: {}, markets, stats: null });
    expect(picks.corners).toBeNull();
    expect(picks.shots).toBeNull();
  });

  test('basketball carries no corner or shot picks', () => {
    const model = {
      status: 'live',
      probabilities: { home_win: 0.6, away_win: 0.4 },
      expected: { total: 220 },
      sigma: { total: 18 },
    };
    const picks = derivePicks({ sport: 'basketball', model, game: { league: { id: 'nba' } } });
    expect(picks.corners).toBeNull();
    expect(picks.shots).toBeNull();
  });
});

describe('projectedCount — the rate extrapolation the pick line is chosen against', () => {
  test('adds the remaining count the per-minute rate implies', () => {
    const stats = { totals: { corners: 6 } };
    // 6 corners in 60 min => 0.1/min => 3 more in 30 min => 9 projected.
    expect(projectedCount(stats, 'corners', { inputs: { elapsed_minutes: 60, remaining_minutes: 30 } })).toBe(9);
  });

  test('null when the count or the clock is unknown', () => {
    expect(projectedCount({ totals: {} }, 'corners', { inputs: { elapsed_minutes: 60, remaining_minutes: 30 } })).toBeNull();
    expect(projectedCount(null, 'corners', { inputs: {} })).toBeNull();
  });
});
