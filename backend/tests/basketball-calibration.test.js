/**
 * Task 16 — probability calibration (isotonic / Platt, per market + league).
 *
 * TR-16.1: Separate calibrators are produced per market and league.
 * TR-16.2: Calibrated probabilities are monotonic non-decreasing in the raw
 *          probability and within (0,1).
 * TR-16.3: A failing calibrator falls back to identity rather than producing
 *          out-of-range values.
 */

const CONFIG = require('../services/basketball/config');
const {
  fitIsotonic, applyIsotonic, fitPlatt, applyPlatt,
  brierScore, logLoss, calibrationCurve, Calibrator,
} = require('../services/basketball/calibration');

function rows(pairs) {
  return pairs.map(([p, y]) => ({ p, y }));
}

describe('basketball calibration (TR-16.1, TR-16.2, TR-16.3)', () => {
  test('TR-16.2: isotonic fit is monotonic non-decreasing and stays in (0,1)', () => {
    const data = rows([
      [0.55, 0], [0.55, 0],
      [0.65, 0], [0.65, 1],
      [0.75, 1], [0.75, 1],
      [0.85, 1], [0.85, 1],
    ]);
    const model = fitIsotonic(data, { minSamples: 8 });
    expect(model).not.toBeNull();

    const probes = [0.50, 0.60, 0.70, 0.80, 0.90];
    const applied = probes.map(p => applyIsotonic(model, p));
    for (let i = 1; i < applied.length; i++) {
      expect(applied[i]).toBeGreaterThanOrEqual(applied[i - 1]);
    }
    applied.forEach(v => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    });
  });

  test('TR-16.1: the Calibrator keeps a separate model per (league, market)', () => {
    const cal = new Calibrator(CONFIG);
    const data = rows([
      [0.55, 0], [0.55, 0], [0.60, 0], [0.62, 1],
      [0.70, 1], [0.72, 1], [0.80, 1], [0.82, 1],
    ]);

    const m1 = cal.fit('nba', 'Total Points', data, { minSamples: 8 });
    expect(m1).not.toBeNull();
    expect(cal.has('nba', 'Total Points')).toBe(true);
    // A different market / league is NOT calibrated by the same fit.
    expect(cal.has('nba', 'Spread')).toBe(false);
    expect(cal.has('wnba', 'Total Points')).toBe(false);

    // Only the fitted key is transformed; others pass through (clamped) unchanged.
    const fitted = cal.apply('nba', 'Total Points', 0.65);
    const untouched = cal.apply('nba', 'Spread', 0.65);
    expect(untouched).toBeCloseTo(0.65, 6);
    expect(fitted).not.toBeCloseTo(0.65, 6);
  });

  test('TR-16.3: too few samples -> no model -> identity with an in-range clamp', () => {
    const cal = new Calibrator(CONFIG); // CONFIG.calibration.minSamples = 150
    const fitted = cal.fit('nba', 'Total Points', rows([[0.6, 1], [0.7, 0], [0.8, 1]]));
    expect(fitted).toBeNull();
    expect(cal.has('nba', 'Total Points')).toBe(false);

    // Identity, but never exactly 0 or 1.
    expect(cal.apply('nba', 'Total Points', 0.6)).toBeCloseTo(0.6, 6);
    expect(cal.apply('nba', 'Total Points', 0)).toBeGreaterThan(0);
    expect(cal.apply('nba', 'Total Points', 1)).toBeLessThan(1);
    // Non-finite input is returned untouched (not fabricated).
    expect(cal.apply('nba', 'Total Points', NaN)).toBeNaN();
  });

  test('Platt scaling is monotonic and can be selected via config', () => {
    const data = rows([
      [0.55, 0], [0.58, 0], [0.62, 0], [0.66, 1],
      [0.70, 1], [0.74, 1], [0.80, 1], [0.85, 1],
    ]);
    const model = fitPlatt(data, { minSamples: 8, iterations: 2000, lr: 0.2 });
    expect(model).not.toBeNull();
    expect(model.method).toBe('platt');

    const applied = [0.5, 0.6, 0.7, 0.8, 0.9].map(p => applyPlatt(model, p));
    for (let i = 1; i < applied.length; i++) {
      expect(applied[i]).toBeGreaterThanOrEqual(applied[i - 1] - 1e-9);
    }

    const cal = new Calibrator({ ...CONFIG, calibration: { ...CONFIG.calibration, method: 'platt', minSamples: 8 } });
    expect(cal.fit('euroleague', 'Spread', data)).not.toBeNull();
    const out = cal.apply('euroleague', 'Spread', 0.7);
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThan(1);
  });

  test('the calibrator round-trips through JSON', () => {
    const cal = new Calibrator(CONFIG);
    cal.fit('nba', 'Total Points', rows([
      [0.55, 0], [0.55, 0], [0.65, 0], [0.65, 1], [0.75, 1], [0.75, 1], [0.85, 1], [0.85, 1],
    ]), { minSamples: 8 });

    const restored = Calibrator.fromJSON(CONFIG, cal.toJSON());
    expect(restored.has('nba', 'Total Points')).toBe(true);
    expect(restored.apply('nba', 'Total Points', 0.7)).toBeCloseTo(cal.apply('nba', 'Total Points', 0.7), 9);
  });

  test('Brier / log loss / calibration curve ignore pushes (y === null)', () => {
    const withPushes = rows([[0.7, 1], [0.7, 0], [0.6, null]]);
    // ((0.7-1)^2 + (0.7-0)^2) / 2 = (0.09 + 0.49) / 2 = 0.29
    expect(brierScore(withPushes)).toBeCloseTo(0.29, 6);
    expect(logLoss(withPushes)).toBeGreaterThan(0);

    const curve = calibrationCurve(rows([[0.56, 1], [0.62, 0], [0.72, 1], [0.9, 1]]));
    expect(curve.map(b => b.range)).toEqual(['0.55-0.60', '0.60-0.65', '0.65-0.70', '0.70-1.00']);
    expect(curve[0].n).toBe(1);
    expect(curve[0].actual).toBe(1);
    expect(curve[2].n).toBe(0);
    expect(curve[2].predicted).toBeNull();
  });
});
