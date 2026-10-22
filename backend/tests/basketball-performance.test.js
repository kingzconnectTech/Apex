/**
 * Task 22 — live tracking, performance dashboard and auto-downgrade.
 *
 * TR-22.1: A predicted record is stored with its confidence and result and
 *          appears in the performance payload.
 * TR-22.2: A market whose last-100 hit rate falls below the expected band is
 *          auto-downgraded / disabled.
 */

const CONFIG = require('../services/basketball/config');
const {
  COLLECTION, saveBasketballPredictions, saveLineSnapshots, resolveSnapshotWindows,
  settleBasketballPredictions, loadSettled, summarisePerformance, deriveMarketPolicy,
  getBasketballPerformance,
} = require('../services/basketball/persistence');
const { selectPicks } = require('../services/basketball/lineSelector');

/** Minimal in-memory Firestore stand-in. */
function makeAdmin() {
  const docs = new Map();
  const snapshot = (filterFn) => ({
    docs: [...docs.entries()]
      .filter(([, d]) => filterFn(d))
      .map(([id, d]) => ({
        id,
        data: () => d,
        ref: { set: async (patch) => { docs.set(id, { ...docs.get(id), ...patch }); } },
      })),
  });
  const query = (filterFn) => ({
    limit: () => query(filterFn),
    get: async () => snapshot(filterFn),
  });
  const collection = () => ({
    doc: (id) => ({
      get: async () => ({ exists: docs.has(id), data: () => docs.get(id) }),
      set: async (data) => { docs.set(id, { ...(docs.get(id) || {}), ...data }); },
    }),
    where: (field, op, value) => query(d => (op === '!=' ? d[field] !== value : d[field] === value)),
  });
  return { firestore: () => ({ collection }), _docs: docs };
}

/** A formatted prediction with one pick, ready to store. */
function mkPrediction({ gameId, market, selection, side, line, probability, odds = 1.9, confidence = 'Medium', league = 'nba' }) {
  return {
    gameId,
    game: `Home vs Away ${gameId}`,
    leagueKey: league,
    league: league.toUpperCase(),
    tipoff: '2026-01-20T23:00:00.000Z',
    projection: { total: 220, margin: 5, sigma_total: 17, sigma_margin: 11 },
    data_quality: 0.9,
    modelVersion: 'bb-1.0.0',
    key_factors: [],
    risk_flags: [],
    picks: [{ market, selection, side, line, probability, odds, edge: 0.06, confidence, ev: 0.1, isMain: true }],
  };
}

describe('basketball live tracking (TR-22.1)', () => {
  test('a stored pick keeps its confidence and appears settled in the performance payload', async () => {
    const admin = makeAdmin();
    await saveBasketballPredictions(admin, [
      mkPrediction({ gameId: 'g1', market: 'Total Points', selection: 'Over 214.5', side: 'a', line: 214.5, probability: 0.68 }),
    ]);

    let docs = [...admin._docs.values()];
    expect(docs).toHaveLength(1);
    expect(docs[0].market).toBe('Total Points');
    expect(docs[0].confidence).toBe('Medium');
    expect(docs[0].status).toBe('pending');
    expect(docs[0].outcome).toBeNull();

    // Final score 118-102 -> total 220 over 214.5 -> won.
    await settleBasketballPredictions(admin, [{ gameId: 'g1', homeScore: 118, awayScore: 102 }]);

    docs = [...admin._docs.values()];
    expect(docs[0].outcome).toBe('won');
    expect(typeof docs[0].profit).toBe('number');

    const report = await getBasketballPerformance(admin, { window: 100 });
    expect(report.byMarket['Total Points'].sample).toBe(1);
    expect(report.byMarket['Total Points'].hitRate).toBe(1);
    expect(report.policy).toBeDefined();
    expect(report.policy.status['Total Points']).toBe('active'); // small sample -> not punished
  });

  test('the same prediction is not duplicated on a re-run with an unchanged signature', async () => {
    const admin = makeAdmin();
    const p = mkPrediction({ gameId: 'g2', market: 'Spread', selection: 'Home -4.5', side: 'a', line: -4.5, probability: 0.62 });
    const first = await saveBasketballPredictions(admin, [p]);
    const second = await saveBasketballPredictions(admin, [p]);
    expect(first.written).toBe(1);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(1);
    expect(admin._docs.size).toBe(1);
  });

  test('settlement is idempotent', async () => {
    const admin = makeAdmin();
    await saveBasketballPredictions(admin, [
      mkPrediction({ gameId: 'g3', market: 'Total Points', selection: 'Under 230.5', side: 'b', line: 230.5, probability: 0.65 }),
    ]);
    const first = await settleBasketballPredictions(admin, [{ gameId: 'g3', homeScore: 110, awayScore: 100 }]);
    const second = await settleBasketballPredictions(admin, [{ gameId: 'g3', homeScore: 110, awayScore: 100 }]);
    expect(first.settled).toBe(1);
    expect(second.settled).toBe(0);
  });

  test('loadSettled returns only graded rows and honours league/market filters', async () => {
    const admin = makeAdmin();
    await saveBasketballPredictions(admin, [
      mkPrediction({ gameId: 'a', market: 'Total Points', selection: 'Over 1', side: 'a', line: 200.5, probability: 0.7, league: 'nba' }),
      mkPrediction({ gameId: 'b', market: 'Spread', selection: 'Home -3.5', side: 'a', line: -3.5, probability: 0.7, league: 'wnba' }),
    ]);
    await settleBasketballPredictions(admin, [
      { gameId: 'a', homeScore: 120, awayScore: 110 },
      { gameId: 'b', homeScore: 100, awayScore: 105 },
    ]);

    expect((await loadSettled(admin)).length).toBe(2);
    expect((await loadSettled(admin, { league: 'nba' })).length).toBe(1);
    expect((await loadSettled(admin, { market: 'Spread' })).length).toBe(1);
  });
});

describe('auto-downgrade policy (TR-22.2)', () => {
  test('deriveMarketPolicy disables a market far below its stated probabilities', () => {
    const report = {
      byMarket: {
        'Total Points': { sample: 100, hitRate: 0.52, avgPredicted: 0.68, calibrationGap: -0.16 },
        Spread: { sample: 100, hitRate: 0.60, avgPredicted: 0.68, calibrationGap: -0.08 },
      },
    };
    const policy = deriveMarketPolicy(report, CONFIG);
    expect(policy.status['Total Points']).toBe('disabled');
    expect(policy.status.Spread).toBe('downgraded');
    expect(policy.reasons['Total Points']).toMatch(/gap/i);
  });

  test('a small sample is never punished', () => {
    const report = { byMarket: { 'Total Points': { sample: 5, hitRate: 0.2, avgPredicted: 0.7, calibrationGap: -0.5 } } };
    const policy = deriveMarketPolicy(report, CONFIG);
    expect(policy.status['Total Points']).toBe('active');
    expect(policy.reasons['Total Points']).toMatch(/insufficient-sample/);
  });

  test('a well-calibrated market stays active', () => {
    const report = { byMarket: { Spread: { sample: 200, hitRate: 0.66, avgPredicted: 0.65, calibrationGap: 0.01 } } };
    expect(deriveMarketPolicy(report, CONFIG).status.Spread).toBe('active');
  });

  test('summarisePerformance flags an underperforming market as a verdict', () => {
    const docs = Array.from({ length: 40 }, (_, i) => ({
      outcome: i < 20 ? 'won' : 'lost',
      probability: 0.7,
      odds: 1.9,
    }));
    const s = summarisePerformance(docs, { window: 100 });
    expect(s.sample).toBe(40);
    expect(s.calibrationGap).toBeLessThan(0);
    expect(s.verdict).toBe('underperforming');
  });

  test('the selector drops a disabled market and steps a downgraded market down a tier', () => {
    // Tiers are held back until the ship gate passes (item 6), so the tier-stepping
    // behaviour is asserted with the gate open.
    const openCfg = { ...CONFIG, shipGate: { ...CONFIG.shipGate, passed: true } };
    const projection = { total: 230, margin: 8, sigmaTotal: 17, sigmaMargin: 11 };
    const lines = {
      total: [{ line: 220.5, aOdds: -110, bOdds: -110, isMain: true }],
      spread: [{ line: -4.5, aOdds: -110, bOdds: -110, isMain: true }],
    };
    const baseCtx = { cfg: openCfg, dataQuality: 0.9, confirmed: true, homeTeamName: 'Home', awayTeamName: 'Away' };

    const noPolicy = selectPicks({ projection, lines, ctx: baseCtx });
    expect(noPolicy.picks.map(p => p.market).sort()).toEqual(['Spread', 'Total Points']);
    expect(noPolicy.picks.find(p => p.market === 'Spread').confidence).toBe('High');

    const withPolicy = selectPicks({
      projection, lines,
      ctx: { ...baseCtx, marketPolicy: { 'Total Points': 'disabled', Spread: 'downgraded' } },
    });

    const markets = withPolicy.picks.map(p => p.market);
    expect(markets).toEqual(['Spread']); // Total Points dropped
    const spread = withPolicy.picks[0];
    expect(spread.confidence).toBe('Medium'); // High -> Medium
    expect(spread.downgraded).toBe(true);
    expect(withPolicy.flags.join(' ')).toMatch(/auto-disabled/i);
  });

  test('a disabled market can leave a game with no confident pick at all', () => {
    const projection = { total: 230, margin: 8, sigmaTotal: 17, sigmaMargin: 11 };
    const lines = {
      total: [{ line: 220.5, aOdds: -110, bOdds: -110, isMain: true }],
      spread: [{ line: -4.5, aOdds: -110, bOdds: -110, isMain: true }],
    };
    const sel = selectPicks({
      projection, lines,
      ctx: {
        cfg: CONFIG, dataQuality: 0.9, confirmed: true,
        homeTeamName: 'Home', awayTeamName: 'Away',
        marketPolicy: { 'Total Points': 'disabled', Spread: 'disabled' },
      },
    });
    expect(sel.picks).toEqual([]);
    expect(sel.noPick).toBe(true);
    expect(sel.noPickLabel).toBe(CONFIG.selection.noPickLabel);
  });
});

describe('Step D pre-tip line snapshots', () => {
  test('records the market the engine saw, with a capture time and minutes to tip', async () => {
    const admin = makeAdmin();
    const capturedAt = '2026-01-20T22:00:00.000Z';
    const prediction = {
      gameId: 'g-snap',
      game: 'Home vs Away',
      leagueKey: 'nba',
      league: 'NBA',
      tipoff: '2026-01-20T23:00:00.000Z',
      marketLine: true,
      marketOdds: { total: { line: 220.5, aOdds: -110, bOdds: -110 }, spread: null },
      projection: { total: 221, margin: 4 },
      picks: [{ market: 'Total Points', selection: 'Over 220.5', line: 220.5, side: 'a', odds: 1.909, probability: 0.55 }],
      modelVersion: 'bb-1.0.0',
    };

    const res = await saveLineSnapshots(admin, [prediction], { label: 't90', at: capturedAt });
    expect(res.written).toBe(1);

    const doc = [...admin._docs.values()][0];
    expect(doc.window).toBe('t90');
    expect(doc.capturedAt).toBe(capturedAt);
    expect(doc.minutesToTip).toBe(60);
    expect(doc.marketLine).toBe(true);
    expect(doc.marketOdds.total.line).toBe(220.5);
    expect(doc.picks[0].selection).toBe('Over 220.5');
  });

  test('a game with no market line is still recorded as such', async () => {
    const admin = makeAdmin();
    await saveLineSnapshots(admin, [
      { gameId: 'g-none', tipoff: '2026-01-20T23:00:00.000Z', marketLine: false, marketOdds: null },
    ], { label: 'morning' });

    const doc = [...admin._docs.values()][0];
    expect(doc.marketLine).toBe(false);
    expect(doc.marketOdds).toBeNull();
  });

  test('resolveSnapshotWindows captures only games inside each anchored window', () => {
    const now = Date.parse('2026-01-20T20:00:00.000Z');
    const at = (mins) => new Date(now + mins * 60000).toISOString();
    const ls = CONFIG.lineSnapshots;

    const predictions = [
      { gameId: 't90', tipoff: at(88) },   // inside 90 ± 10
      { gameId: 't15', tipoff: at(12) },   // inside 15 ± 10
      { gameId: 'mid', tipoff: at(45) },   // between windows
      { gameId: 'far', tipoff: at(48 * 60) }, // beyond the horizon
      { gameId: 'started', tipoff: at(-30) },
    ];

    const byLabel = resolveSnapshotWindows(predictions, now, ls);
    expect((byLabel.get('t90') || []).map(p => p.gameId)).toEqual(['t90']);
    expect((byLabel.get('t15') || []).map(p => p.gameId)).toEqual(['t15']);
    expect(byLabel.has('mid')).toBe(false);
    // 'morning' has no tip anchor and is handled by the morning run, not here.
    expect(byLabel.has('morning')).toBe(false);
  });
});
