/**
 * Basketball line selector unit tests.
 * Covers: American->decimal odds, proper vig removal, edge, push-aware EV,
 * threshold gating, ranking, consistency flags and "No confident pick".
 */

const {
  toDecimal, removeVig, scoreCandidate, assessConsistency, lineMovement,
  confidenceTier, bestOf, selectPicks,
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

  test('model lines are evaluated but never published as picks (R6)', () => {
    // Model projected total is 230, model line is at 218.5 (Over should be > 0.65)
    const projection = { total: 230.0, margin: 12.0, sigmaTotal: 17.6, sigmaMargin: 11.8 };
    const lines = {
      total: [{ line: 218.5, aOdds: null, bOdds: null, isMain: true, isModelLine: true }],
      spread: [{ line: -5.5, aOdds: null, bOdds: null, isMain: true, isModelLine: true }],
    };
    const out = selectPicks({ projection, lines, ctx: { ...ctx, dataQuality: 0.85 } });

    // No real bookmaker line -> nothing is published...
    expect(out.hasMarketLine).toBe(false);
    expect(out.noPick).toBe(true);
    expect(out.picks).toEqual([]);
    expect(out.noPickLabel).toBe('no market line');

    // ...but the model's read is still evaluated and returned for context, with
    // no fabricated bookmaker prices.
    const totalCand = out.evaluated.total.find(c => c.isModelLine);
    expect(totalCand.odds).toBeNull();
    expect(totalCand.ev).toBeNull();
    expect(totalCand.selection).toContain('(Model Line)');
    expect(totalCand.probability).toBeGreaterThanOrEqual(0.65);
    expect(out.flags.join(' | ')).toMatch(/no market line/);
  });

  test('model lines are never published at any data quality (R6)', () => {
    const projection = { total: 230.0, margin: 12.0, sigmaTotal: 17.6, sigmaMargin: 11.8 };
    const lines = {
      total: [{ line: 218.5, aOdds: null, bOdds: null, isMain: true, isModelLine: true }],
    };
    const out = selectPicks({ projection, lines, ctx: { ...ctx, dataQuality: 0.5 } });
    expect(out.noPick).toBe(true);
    expect(out.picks).toEqual([]);
    expect(out.hasMarketLine).toBe(false);
    expect(out.evaluated.total[0].isModelLine).toBe(true);
  });
});

describe('Confidence tiers (R12)', () => {
  const C = CFG.selection.confidence;

  test('High needs a strong probability AND strong data quality', () => {
    expect(confidenceTier({ probability: C.highProb, dq: C.highDataQuality, confirmed: false, cfg: CFG })).toBe('High');
    // Same probability, thinner data -> cannot claim High.
    expect(confidenceTier({ probability: C.highProb, dq: C.mediumDataQuality, confirmed: false, cfg: CFG })).toBe('Medium');
    // Same data, weaker claim -> cannot claim High.
    expect(confidenceTier({ probability: C.mediumProb - 0.01, dq: 0.99, confirmed: false, cfg: CFG })).toBe('Low');
  });

  test('a coin-flip line with thin data is labelled Low, not Medium', () => {
    expect(confidenceTier({ probability: 0.5, dq: 0.5, confirmed: false, cfg: CFG })).toBe('Low');
    expect(confidenceTier({ probability: 0.5, dq: 0.99, confirmed: false, cfg: CFG })).toBe('Low');
  });

  test('confirmed lineups are a credit, never a tier of their own', () => {
    // A credit cannot rescue a thin sample.
    expect(confidenceTier({ probability: C.highProb, dq: 0.2, confirmed: true, cfg: CFG })).toBe('Low');
    // A pick just under the High data bar can be lifted by verified starters...
    const nearBar = C.highDataQuality - 0.02;
    expect(confidenceTier({ probability: C.highProb, dq: nearBar, confirmed: true, cfg: CFG })).toBe('High');
    // ...and stays lower when they are not verified (the production case).
    expect(confidenceTier({ probability: C.highProb, dq: nearBar, confirmed: false, cfg: CFG })).toBe('Medium');
  });

  test('missing inputs degrade to Low instead of throwing', () => {
    expect(confidenceTier({ probability: null, dq: null, confirmed: false, cfg: CFG })).toBe('Low');
    expect(confidenceTier({ probability: undefined, dq: undefined, cfg: CFG })).toBe('Low');
  });

  test('High is computed end-to-end but held back until the ship gate passes', () => {
    const projection = { total: 218.4, margin: 7.2, sigmaTotal: 17.6, sigmaMargin: 11.8 };
    const lines = { total: [{ line: 208.5, aOdds: 1.85, bOdds: 1.95, isMain: true }], spread: [] };
    const out = selectPicks({
      projection, lines,
      ctx: { cfg: CFG, dataQuality: 0.84, confirmed: false, homeTeamName: 'A', awayTeamName: 'B' },
    });
    expect(out.picks[0].probability).toBeGreaterThan(CFG.selection.confidence.highProb);
    // The real tier is computed and preserved for the shadow report...
    expect(out.picks[0].confidenceRaw).toBe('High');
    // ...but only 'Low' is displayed while the ship gate is open (item 6).
    expect(CFG.shipGate.passed).toBe(false);
    expect(out.picks[0].confidence).toBe('Low');
    expect(out.picks[0].tierHeld).toBe(true);
  });

  test('the real tier is displayed once the ship gate has passed', () => {
    const projection = { total: 218.4, margin: 7.2, sigmaTotal: 17.6, sigmaMargin: 11.8 };
    const lines = { total: [{ line: 208.5, aOdds: 1.85, bOdds: 1.95, isMain: true }], spread: [] };
    const cfg = { ...CFG, shipGate: { ...CFG.shipGate, passed: true } };
    const out = selectPicks({
      projection, lines,
      ctx: { cfg, dataQuality: 0.84, confirmed: false, homeTeamName: 'A', awayTeamName: 'B' },
    });
    expect(out.picks[0].confidence).toBe('High');
    expect(out.picks[0].tierHeld).toBeUndefined();
  });
});

describe('Selection gates (R11)', () => {
  const projection = { total: 218.4, margin: 7.2, sigmaTotal: 17.6, sigmaMargin: 11.8 };
  const lines = { total: [{ line: 208.5, aOdds: 1.85, bOdds: 1.95, isMain: true }], spread: [] };
  const baseCtx = { cfg: CFG, dataQuality: 0.84, confirmed: false, homeTeamName: 'A', awayTeamName: 'B' };

  test('the shipping thresholds are permissive: every line passes and carries no fail reasons', () => {
    const out = selectPicks({ projection, lines, ctx: baseCtx });
    expect(out.evaluated.total.every(c => c.passes)).toBe(true);
    expect(out.evaluated.total.every(c => c.failReasons.length === 0)).toBe(true);
    expect(out.flags).toEqual([]);
  });

  test('a tightened gate records why, without hiding the line', () => {
    const cfg = {
      ...CFG,
      selection: { ...CFG.selection, mainMinProb: 0.9, minEdge: 0.5, minDataQuality: 0.99 },
    };
    const out = selectPicks({ projection, lines, ctx: { ...baseCtx, cfg } });

    // Nothing is suppressed...
    expect(out.noPick).toBe(false);
    expect(out.picks.length).toBe(1);
    // ...but every missed gate is reported, on the candidate and on the pick.
    const candidate = out.evaluated.total[0];
    expect(candidate.passes).toBe(false);
    expect(candidate.failReasons.length).toBe(3);
    expect(candidate.failReasons.join(' | ')).toMatch(/probability/);
    expect(candidate.failReasons.join(' | ')).toMatch(/edge/);
    expect(candidate.failReasons.join(' | ')).toMatch(/data quality/);
    expect(out.flags.length).toBe(3);
    expect(out.flags[0]).toMatch(/Total Points Over 208\.5:/);
  });

  test('a passing candidate is ranked ahead of an equal-probability failing one by score, not by gating', () => {
    // bestOf deliberately ignores `passes`; the flags are the honest signal.
    const out = bestOf([{ passes: false, score: 0.3, selection: 'a' }, { passes: true, score: 0.7, selection: 'b' }]);
    expect(out.selection).toBe('b');
  });
});
