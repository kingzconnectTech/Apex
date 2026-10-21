/**
 * Basketball line selector unit tests.
 * Covers: American->decimal odds, proper vig removal, edge, push-aware EV,
 * threshold gating, ranking, consistency flags and "No confident pick".
 */

const {
  toDecimal, removeVig, scoreCandidate, assessConsistency, lineMovement,
  bestOf, selectPicks,
} = require('../services/basketball/lineSelector');
const CFG = require('../services/basketball/config');

describe('Odds conversion', () => {
  test('converts American moneylines to decimal', () => {
    expect(toDecimal(-110)).toBeCloseTo(1.909, 3);
    expect(toDecimal(150)).toBeCloseTo(2.5, 3);
  });

  test('passes decimal odds through', () => {
    expect(toDecimal(1.91)).toBeCloseTo(1.91, 6);
  });
});

describe('Vig removal', () => {
  test('a symmetric -110/-110 market de-vigs to 50/50', () => {
    const { fair, overround } = removeVig([toDecimal(-110), toDecimal(-110)]);
    expect(fair[0]).toBeCloseTo(0.5, 6);
    expect(fair[1]).toBeCloseTo(0.5, 6);
    expect(overround).toBeGreaterThan(0.04);
  });

  test('fair probabilities always sum to 1 and preserve the favourite', () => {
    const { fair } = removeVig([toDecimal(-200), toDecimal(170)]);
    expect(fair[0] + fair[1]).toBeCloseTo(1, 6);
    expect(fair[0]).toBeGreaterThan(fair[1]);
  });

  test('returns null when an odd is missing', () => {
    expect(removeVig([1.91, null])).toBeNull();
  });
});

describe('Ranking and consistency', () => {
  test('score blends probability and edge-scaled EV', () => {
    const highProb = scoreCandidate({ probability: 0.7, ev: 0.05, cfg: CFG });
    const lowProb = scoreCandidate({ probability: 0.6, ev: 0.05, cfg: CFG });
    expect(highProb).toBeGreaterThan(lowProb);
  });

  test('big margin + low total is flagged, not dropped', () => {
    const flags = assessConsistency({ projTotal: 198, projMargin: 12, cfg: CFG });
    expect(flags.length).toBeGreaterThan(0);
  });

  test('consistent projection produces no flags', () => {
    expect(assessConsistency({ projTotal: 222, projMargin: 6, cfg: CFG })).toEqual([]);
  });

  test('line movement is detected beyond tolerance', () => {
    expect(lineMovement(210, 212, 0.5).moved).toBe(true);
    expect(lineMovement(210, 210, 0.5).moved).toBe(false);
  });
});

describe('Pick selection', () => {
  const ctx = {
    cfg: CFG,
    dataQuality: 0.84,
    confirmed: false,
    homeTeamName: 'Team A',
    awayTeamName: 'Team B',
  };

  test('returns the best passing pick per market', () => {
    const projection = { total: 218.4, margin: 7.2, sigmaTotal: 17.6, sigmaMargin: 11.8 };
    const lines = {
      total: [{ line: 208.5, aOdds: 1.85, bOdds: 1.95, isMain: true }],
      spread: [{ line: -2.5, aOdds: 1.91, bOdds: 1.91, isMain: true }],
    };
    const out = selectPicks({ projection, lines, ctx });
    expect(out.picks.length).toBe(2);
    const total = out.picks.find(p => p.market === 'Total Points');
    expect(total.selection).toBe('Over 208.5');
    expect(total.probability).toBeGreaterThan(0.6);
    expect(total.edge).toBeGreaterThan(0.04);
    const spread = out.picks.find(p => p.market === 'Spread');
    expect(spread.selection).toBe('Team A -2.5');
    expect(spread.probability).toBeGreaterThan(0.6);
  });

  test('a ~50/50 line is still returned with its honest probability (no threshold filtering)', () => {
    // Line sits right on the projection -> probability ~0.5. Thresholds are
    // intentionally zeroed, so the pick is returned instead of being suppressed.
    const projection = { total: 218.0, margin: 0, sigmaTotal: 17.6, sigmaMargin: 11.8 };
    const lines = {
      total: [{ line: 218.5, aOdds: 1.91, bOdds: 1.91, isMain: true }],
      spread: [{ line: -0.5, aOdds: 1.91, bOdds: 1.91, isMain: true }],
    };
    const out = selectPicks({ projection, lines, ctx });
    expect(out.noPick).toBe(false);
    expect(out.picks.map(p => p.market)).toEqual(['Total Points', 'Spread']);
    out.evaluated.total.forEach(c => expect(c.passes).toBe(true));
    const total = out.picks.find(p => p.market === 'Total Points');
    expect(total.probability).toBeGreaterThan(0.4);
    expect(total.probability).toBeLessThan(0.6);
    expect(out.noPickLabel).toBe('No confident pick');
  });

  test('low data quality demotes confidence but does not suppress picks', () => {
    const projection = { total: 218.4, margin: 7.2, sigmaTotal: 17.6, sigmaMargin: 11.8 };
    const lines = { total: [{ line: 208.5, aOdds: 1.85, bOdds: 1.95, isMain: true }], spread: [] };
    const out = selectPicks({ projection, lines, ctx: { ...ctx, dataQuality: 0.5 } });
    expect(out.noPick).toBe(false);
    expect(out.picks.length).toBe(1);
    expect(out.picks[0].confidence).not.toBe('High');
  });

  test('alternate lines are evaluated exactly like main lines', () => {
    const projection = { total: 218.4, margin: 0, sigmaTotal: 17.6, sigmaMargin: 11.8 };
    const lines = {
      total: [{ line: 205.5, aOdds: 1.85, bOdds: 1.95, isMain: false }], // ~0.77 over prob
      spread: [],
    };
    const out = selectPicks({ projection, lines, ctx });
    const evaluated = out.evaluated.total[0];
    expect(evaluated.isMain).toBe(false);
    expect(evaluated.passes).toBe(true);
    expect(evaluated.probability).toBeGreaterThan(0.5);
  });

  test('bestOf selects by score without filtering on passes', () => {
    expect(bestOf([{ passes: false, score: 0.99 }, { passes: true, score: 0.2 }])).toEqual({ passes: false, score: 0.99 });
    expect(bestOf([{ passes: false, score: 1 }])).toEqual({ passes: false, score: 1 });
    expect(bestOf([])).toBeNull();
  });

  test('model lines evaluate with null odds and no fabricated bookmaker prices', () => {
    // Model projected total is 230, model line is at 218.5 (Over should be > 0.65)
    const projection = { total: 230.0, margin: 12.0, sigmaTotal: 17.6, sigmaMargin: 11.8 };
    const lines = {
      total: [{ line: 218.5, aOdds: null, bOdds: null, isMain: true, isModelLine: true }],
      spread: [{ line: -5.5, aOdds: null, bOdds: null, isMain: true, isModelLine: true }],
    };
    const out = selectPicks({ projection, lines, ctx: { ...ctx, dataQuality: 0.85 } });
    expect(out.picks.length).toBe(2);
    const totalPick = out.picks.find(p => p.market === 'Total Points');
    expect(totalPick.isModelLine).toBe(true);
    expect(totalPick.odds).toBeNull();
    expect(totalPick.ev).toBeNull();
    expect(totalPick.selection).toContain('(Model Line)');
    expect(totalPick.probability).toBeGreaterThanOrEqual(0.65);

    const spreadPick = out.picks.find(p => p.market === 'Spread');
    expect(spreadPick.isModelLine).toBe(true);
    expect(spreadPick.odds).toBeNull();
    expect(spreadPick.probability).toBeGreaterThanOrEqual(0.65);
  });

  test('model lines evaluate at any data quality (no model-line data-quality floor)', () => {
    const projection = { total: 230.0, margin: 12.0, sigmaTotal: 17.6, sigmaMargin: 11.8 };
    const lines = {
      total: [{ line: 218.5, aOdds: null, bOdds: null, isMain: true, isModelLine: true }],
    };
    const out = selectPicks({ projection, lines, ctx: { ...ctx, dataQuality: 0.5 } });
    expect(out.noPick).toBe(false);
    expect(out.picks.length).toBe(1);
    expect(out.picks[0].isModelLine).toBe(true);
    expect(out.picks[0].selection).toContain('(Model Line)');
  });
});
