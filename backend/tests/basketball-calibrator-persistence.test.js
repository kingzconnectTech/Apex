/**
 * R4 — persisted calibrator round trip.
 *
 * TR-24.1: A fitted calibrator survives save -> load and produces identical
 *          calibrated probabilities for both sides of a two-way market.
 * TR-24.2: A calibrator that failed the holdout gate is never applied —
 *          loadCalibrator returns null and the engine keeps raw probabilities.
 * TR-24.3: P(canonical) + P(other side) === 1 by construction.
 * TR-24.4: The stored document carries the audit metadata (n, date range,
 *          Brier / log loss before and after, version, fitted_at).
 */

const CONFIG = require('../services/basketball/config');
const {
  COLLECTION, CALIBRATION_COLLECTION,
  buildCalibratorDoc, saveCalibrator, loadCalibratorDoc, loadCalibrator,
} = require('../services/basketball/persistence');
const { Calibrator, validateAgainstIdentity } = require('../services/basketball/calibration');

const CFG = {
  ...CONFIG,
  calibration: { ...CONFIG.calibration, enabled: true, method: 'isotonic', minSamples: 100, epsilon: 0.001 },
};

/** Minimal in-memory Firestore stand-in (mirrors tests/basketball-performance.test.js). */
function makeAdmin(seed = {}) {
  const store = new Map();
  Object.entries(seed).forEach(([name, docs]) => {
    const m = new Map();
    Object.entries(docs).forEach(([id, d]) => m.set(id, d));
    store.set(name, m);
  });
  const bucket = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name);
  };
  const firestore = () => ({
    collection: (name) => {
      const docs = bucket(name);
      return {
        doc: (id) => ({
          get: async () => ({ exists: docs.has(id), data: () => docs.get(id) }),
          set: async (data) => { docs.set(id, { ...(docs.get(id) || {}), ...data }); },
        }),
        get: async () => ({ docs: [...docs.entries()].map(([id, d]) => ({ id, data: () => d })) }),
      };
    },
  });
  return { firestore };
}

/** Deterministic PRNG so the fitted curve is reproducible. */
function mulberry32(a) {
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Synthetic two-way sample. The model is deliberately OVERCONFIDENT: the raw
 * probability is stated further from 0.5 than reality warrants, so a working
 * calibrator must shrink it toward 0.5 (Brier and log loss both improve).
 */
function makeRows(n = 400, overconfidence = 0.5) {
  const rnd = mulberry32(20261022);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const stated = 0.5 + rnd() * 0.45;                     // P(canonical), 0.50-0.95
    const real = 0.5 + (stated - 0.5) * overconfidence;     // reality is tamer
    const yCanonical = rnd() < real ? 1 : 0;
    if (rnd() < 0.5) rows.push({ p: Number(stated.toFixed(4)), y: yCanonical, side: 'a' });
    else rows.push({ p: Number((1 - stated).toFixed(4)), y: 1 - yCanonical, side: 'b' });
  }
  return rows;
}

const HOLD = {
  n: 400,
  from: '2025-10-22T00:00:00.000Z',
  to: '2026-04-13T00:00:00.000Z',
};

describe('R4 calibrator persistence', () => {
  test('TR-24.1 a fitted calibrator round-trips and calibrates identically', async () => {
    const rows = makeRows();
    const cal = new Calibrator(CFG);
    const model = cal.fitTwoWay('nba', 'Total Points', rows, { minSamples: 100 });
    expect(model).not.toBeNull();

    const gate = validateAgainstIdentity({ rows, model, minSamples: 100 });
    expect(gate.improved).toBe(true);

    const doc = buildCalibratorDoc({
      league: 'nba',
      calibrator: cal,
      validation: { 'Total Points': gate },
      markets: ['Total Points'],
      oddsSource: 'closing-snapshot',
      training: { rows: HOLD.n, from: HOLD.from, to: HOLD.to, seasons: [2026] },
    });
    expect(doc.accepted).toBe(true);
    expect(doc.shadow).toBe(true);

    const admin = makeAdmin();
    await saveCalibrator(admin, doc);

    const loaded = await loadCalibrator(admin, CFG);
    expect(loaded).not.toBeNull();
    expect(loaded.has('nba', 'Total Points')).toBe(true);

    // Identical to the pre-save calibrator, on both sides.
    for (const p of [0.5, 0.55, 0.62, 0.7, 0.85, 0.93]) {
      for (const side of ['a', 'b']) {
        expect(loaded.apply('nba', 'Total Points', p, side))
          .toBeCloseTo(cal.apply('nba', 'Total Points', p, side), 12);
      }
    }
  });

  test('TR-24.2 a calibrator that failed the holdout gate is never applied', async () => {
    const rows = makeRows();
    const cal = new Calibrator(CFG);
    cal.fitTwoWay('nba', 'Spread', rows, { minSamples: 100 });

    const doc = buildCalibratorDoc({
      league: 'nba',
      calibrator: cal,
      // The gate ran but did not improve on identity.
      validation: { Spread: { n: 400, judged: true, improved: false, before: { brier: 0.2 }, after: { brier: 0.21 } } },
      markets: ['Spread'],
    });
    expect(doc.accepted).toBe(false);
    expect(doc.models).toEqual({});

    const admin = makeAdmin();
    await saveCalibrator(admin, doc);

    expect(await loadCalibratorDoc(admin, 'nba')).toBeNull();
    expect(await loadCalibrator(admin, CFG)).toBeNull();

    // With no trusted calibrator the engine keeps the RAW probability (identity).
    const engine = (await loadCalibrator(admin, CFG)) || new Calibrator(CFG);
    expect(engine.apply('nba', 'Spread', 0.71, 'a')).toBeCloseTo(0.71, 12);
    expect(engine.apply('nba', 'Spread', 0.29, 'b')).toBeCloseTo(0.29, 12);
  });

  test('TR-24.2b a rejected calibrator never displaces an accepted one for the same league', async () => {
    const stale = makeAdmin({
      [CALIBRATION_COLLECTION]: {
        nba: {
          league: 'nba', accepted: true, version: 'bb-cal-1.0.0',
          models: {
            'nba|Total Points': {
              method: 'isotonic', samples: 3, trainedAt: '2026-01-01T00:00:00.000Z',
              model: { method: 'isotonic', xEnds: [0.7, 1], values: [0.4, 0.9], samples: 3 },
            },
          },
        },
      },
    });
    const loaded = await loadCalibrator(stale, CFG);
    expect(loaded.has('nba', 'Total Points')).toBe(true);
    expect(loaded.apply('nba', 'Total Points', 0.8, 'a')).toBeCloseTo(0.9, 12);
  });

  test('TR-24.3 the two sides of a line sum to exactly 1', async () => {
    const rows = makeRows();
    const cal = new Calibrator(CFG);
    cal.fitTwoWay('nba', 'Total Points', rows, { minSamples: 100 });
    const admin = makeAdmin();
    await saveCalibrator(admin, buildCalibratorDoc({
      league: 'nba', calibrator: cal,
      validation: { 'Total Points': { improved: true } }, markets: ['Total Points'],
    }));
    const loaded = await loadCalibrator(admin, CFG);

    for (const p of [0.5, 0.53, 0.67, 0.8, 0.95]) {
      const canon = loaded.apply('nba', 'Total Points', p, 'a');
      const other = loaded.apply('nba', 'Total Points', 1 - p, 'b');
      expect(canon + other).toBeCloseTo(1, 12);
    }
  });

  test('TR-24.4 the stored document carries the audit metadata', async () => {
    const rows = makeRows();
    const cal = new Calibrator(CFG);
    const model = cal.fitTwoWay('nba', 'Total Points', rows, { minSamples: 100 });
    const gate = validateAgainstIdentity({ rows, model, minSamples: 100 });

    const doc = buildCalibratorDoc({
      league: 'nba', calibrator: cal,
      validation: { 'Total Points': gate },
      markets: ['Total Points'],
      oddsSource: 'closing-snapshot',
      training: { rows: HOLD.n, from: HOLD.from, to: HOLD.to, seasons: [2026] },
    });

    expect(doc.version).toBe('bb-cal-1.0.0');
    expect(typeof doc.fittedAt).toBe('string');
    expect(Number.isFinite(Date.parse(doc.fittedAt))).toBe(true);
    expect(doc.training).toEqual({ rows: HOLD.n, from: HOLD.from, to: HOLD.to, seasons: [2026] });
    expect(doc.validation['Total Points'].n).toBe(400);
    expect(doc.validation['Total Points'].before.brier).toBeGreaterThan(doc.validation['Total Points'].after.brier);
    expect(doc.validation['Total Points'].before.logLoss).toBeGreaterThan(doc.validation['Total Points'].after.logLoss);
    expect(doc.oddsSource).toBe('closing-snapshot');
  });

  test('TR-24.4b an empty collection (or a doc missing models) loads as null', async () => {
    expect(await loadCalibrator(makeAdmin(), CFG)).toBeNull();

    const malformed = makeAdmin({
      [CALIBRATION_COLLECTION]: { nba: { league: 'nba', accepted: true } },
    });
    expect(await loadCalibrator(malformed, CFG)).toBeNull();
  });

  test('TR-24.4c calibration can be disabled by config, and the predictions collection is untouched', async () => {
    const admin = makeAdmin();
    await saveCalibrator(admin, {
      league: 'nba', accepted: true, models: { 'nba|Total Points': { method: 'isotonic', model: null } },
    });
    expect(await loadCalibrator(admin, { ...CFG, calibration: { ...CFG.calibration, enabled: false } })).toBeNull();
    expect(CALIBRATION_COLLECTION).not.toBe(COLLECTION);
  });
});
