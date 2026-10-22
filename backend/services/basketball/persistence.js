/**
 * basketball/persistence.js
 *
 * Stores pre-tip-off basketball predictions and their results in Firestore so we
 * can report rolling accuracy / calibration and auto-downgrade a market whose
 * recent performance falls outside its expected range.
 *
 * Collection: `basketball_predictions`
 * Doc id:     `${gameId}_${marketSlug}_${selectionSlug}` (stable, so re-runs update
 *             in place rather than duplicating). A document is only rewritten when
 *             its prediction actually changed.
 *
 * Collection: `basketball_calibrators` (one doc per league; see
 *             buildCalibratorDoc / loadCalibrator)
 *
 * Collection: `basketball_line_snapshots` (Step D; see saveLineSnapshots) — the
 *             book line/odds the engine saw at each capture window, so future
 *             calibration can be anchored to real pre-tip prices.
 */

const { brierScore, logLoss, calibrationCurve, Calibrator, CALIBRATOR_VERSION } = require('./calibration');

const COLLECTION = 'basketball_predictions';
/** One document per league holding its validated calibrator (see buildCalibratorDoc). */
const CALIBRATION_COLLECTION = 'basketball_calibrators';
/** Step D: one document per game per capture window (see saveLineSnapshots). */
const SNAPSHOT_COLLECTION = 'basketball_line_snapshots';

function _slug(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function _docId(pred) {
  return `${_slug(pred.gameId)}_${_slug(pred.market)}_${_slug(pred.selection)}`;
}

/** A signature of the parts that matter — used to skip no-op writes. */
function _signature(pred) {
  return JSON.stringify([pred.line, pred.probability, pred.odds, pred.edge, pred.confidence, pred.modelVersion]);
}

/**
 * Settle one pick against the final score.
 * @returns {'won'|'lost'|'push'}
 */
function settleOne(doc, homeScore, awayScore) {
  const actualTotal = homeScore + awayScore;
  const margin = homeScore - awayScore;

  if (doc.market === 'Total Points') {
    if (actualTotal === doc.line) return 'push';
    const over = actualTotal > doc.line;
    return doc.side === 'a' ? (over ? 'won' : 'lost') : (over ? 'lost' : 'won');
  }

  // Spread: `line` is the home handicap; home covers when margin + line > 0.
  const adj = margin + doc.line;
  if (adj === 0) return 'push';
  const homeCovers = adj > 0;
  return doc.side === 'a' ? (homeCovers ? 'won' : 'lost') : (homeCovers ? 'lost' : 'won');
}

/** Profit for a unit stake at the stored decimal odds. */
function profit(outcome, odds) {
  if (outcome === 'won') return (odds ?? 0) - 1;
  if (outcome === 'lost') return -1;
  return 0;
}

/**
 * Upsert formatted predictions. Only changed documents are written.
 * @returns {Object} { written, skipped, errors }
 */
async function saveBasketballPredictions(admin, predictions, { logger = null } = {}) {
  const db = admin.firestore();
  const now = new Date().toISOString();
  let written = 0;
  let skipped = 0;
  const errors = [];

  for (const pred of predictions || []) {
    if (!pred || !pred.picks || !pred.picks.length) continue;
    for (const pick of pred.picks) {
      const doc = {
        gameId: pred.gameId,
        game: pred.game,
        league: pred.leagueKey || pred.league,
        leagueLabel: pred.league,
        tipoff: pred.tipoff,
        market: pick.market,
        selection: pick.selection,
        line: pick.line,
        side: pick.side,
        isMain: pick.isMain !== false,
        isModelLine: !!pick.isModelLine,
        probability: pick.probability,
        odds: pick.odds,
        edge: pick.edge,
        ev: pick.ev,
        confidence: pick.confidence,
        reasoning: pick.reasoning,
        projection: pred.projection,
        dataQuality: pred.data_quality,
        modelVersion: pred.modelVersion,
        keyFactors: pred.key_factors || [],
        riskFlags: pred.risk_flags || [],
        status: 'pending',
        closingLine: null,
        actual: null,
        outcome: null,
        clv: null,
        createdAt: now,
      };
      const id = _docId(doc);
      const ref = db.collection(COLLECTION).doc(id);
      try {
        const snap = await ref.get();
        const sig = _signature(pick);
        if (snap.exists && snap.data()?.signature === sig && snap.data()?.status !== 'pending') {
          skipped++;
          continue;
        }
        if (snap.exists && snap.data()?.signature === sig) {
          skipped++;
          continue;
        }
        await ref.set({ ...doc, signature: sig, updatedAt: now }, { merge: true });
        written++;
      } catch (err) {
        errors.push({ id, error: err?.message || String(err) });
      }
    }
  }

  logger?.log?.('info', '[BASKETBALL] predictions persisted', { collection: COLLECTION, written, skipped, errors: errors.length });
  return { written, skipped, errors };
}

/** Minutes from `now` to a prediction's tip-off, or null when unusable. */
function minutesToTip(pred, now) {
  const tipMs = new Date(pred?.tipoff).getTime();
  if (!Number.isFinite(tipMs)) return null;
  return (tipMs - now) / 60000;
}

/** True when the game tips off soon enough (and has not already started) to snapshot. */
function withinHorizon(pred, now, ls = {}) {
  const mins = minutesToTip(pred, now);
  if (mins == null) return false;
  return mins > -5 && mins <= (ls.maxHoursBeforeTip ?? 36) * 60;
}

/**
 * Group live predictions into the anchored capture windows they currently fall
 * inside (`minutesBeforeTip ± toleranceMinutes`). The 'morning' window has no tip
 * anchor and is handled by the morning run instead.
 *
 * @returns {Map<string, Array>} window label -> predictions
 */
function resolveSnapshotWindows(predictions, now, ls = {}) {
  const byLabel = new Map();
  for (const pred of predictions || []) {
    if (!withinHorizon(pred, now, ls)) continue;
    const mins = minutesToTip(pred, now);
    for (const w of ls.windows || []) {
      if (w.minutesBeforeTip == null) continue;
      const tol = w.toleranceMinutes ?? 10;
      if (Math.abs(mins - w.minutesBeforeTip) <= tol) {
        if (!byLabel.has(w.label)) byLabel.set(w.label, []);
        byLabel.get(w.label).push(pred);
      }
    }
  }
  return byLabel;
}

/**
 * Step D: record the book line and odds the engine saw for every live
 * prediction at each capture window, together with the capture timestamp and how
 * many minutes before tip it was taken.
 *
 * One document per game per window (`${gameId}_${window}`), so a re-run inside
 * the same window updates in place rather than duplicating. A game with no
 * market line is still snapshotted (`marketLine: false`): that absence is itself
 * the record that the game was excluded from pick statistics.
 *
 * @param {Object} admin
 * @param {Array} predictions - formatted predictions (see index.formatPrediction)
 * @param {Object} opts
 * @param {string} opts.label - window label ('morning' | 't90' | 't15' | …)
 * @param {string} [opts.at]  - capture time (ISO); defaults to now
 * @returns {Object} { written, errors }
 */
async function saveLineSnapshots(admin, predictions, { label, at = null, logger = null } = {}) {
  const db = admin.firestore();
  const capturedAt = at || new Date().toISOString();
  const capturedMs = new Date(capturedAt).getTime();
  let written = 0;
  const errors = [];

  for (const pred of predictions || []) {
    if (!pred?.gameId) continue;
    const tipMs = new Date(pred.tipoff).getTime();
    const minutesToTip = Number.isFinite(tipMs) ? Math.round((tipMs - capturedMs) / 60000) : null;
    const id = `${_slug(pred.gameId)}_${_slug(label || 'snapshot')}`;
    try {
      await db.collection(SNAPSHOT_COLLECTION).doc(id).set({
        gameId: pred.gameId,
        game: pred.game,
        league: pred.leagueKey || pred.league,
        leagueLabel: pred.league,
        tipoff: pred.tipoff,
        window: label || null,
        capturedAt,
        minutesToTip,
        marketLine: pred.marketLine !== false,
        marketOdds: pred.marketOdds || null,
        projection: pred.projection || null,
        picks: (pred.picks || []).map(p => ({
          market: p.market, selection: p.selection, line: p.line, side: p.side, odds: p.odds, probability: p.probability,
        })),
        modelVersion: pred.modelVersion || null,
      }, { merge: true });
      written++;
    } catch (err) {
      errors.push({ id, error: err?.message || String(err) });
    }
  }

  logger?.log?.('info', '[BASKETBALL] line snapshots saved', { collection: SNAPSHOT_COLLECTION, window: label, written, errors: errors.length });
  return { written, errors };
}

/**
 * Settle all pending predictions for the given finished games.
 * @param {Array} results - [{ gameId, homeScore, awayScore }]
 */
async function settleBasketballPredictions(admin, results, { logger = null } = {}) {
  const db = admin.firestore();
  const now = new Date().toISOString();
  let settled = 0;
  const errors = [];

  for (const r of results || []) {
    if (!r?.gameId || r.homeScore == null || r.awayScore == null) continue;
    try {
      const snap = await db.collection(COLLECTION).where('gameId', '==', String(r.gameId)).get();
      for (const docSnap of snap.docs) {
        const doc = docSnap.data();
        const outcome = settleOne(doc, Number(r.homeScore), Number(r.awayScore));
        if (doc.outcome === outcome && doc.actual?.homeScore === Number(r.homeScore)) continue; // idempotent
        await docSnap.ref.set({
          actual: { homeScore: Number(r.homeScore), awayScore: Number(r.awayScore), total: Number(r.homeScore) + Number(r.awayScore), margin: Number(r.homeScore) - Number(r.awayScore) },
          outcome,
          profit: profit(outcome, doc.odds),
          settledAt: now,
        }, { merge: true });
        settled++;
      }
    } catch (err) {
      errors.push({ gameId: r.gameId, error: err?.message || String(err) });
    }
  }

  logger?.log?.('info', '[BASKETBALL] predictions settled', { settled, errors: errors.length });
  return { settled, errors };
}

/** Load settled predictions, optionally filtered by league/market and recency. */
async function loadSettled(admin, { league = null, market = null, limit = 2000 } = {}) {
  const db = admin.firestore();
  let q = db.collection(COLLECTION).where('status', '!=', 'void');
  const snap = await q.limit(limit).get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(d => d.outcome === 'won' || d.outcome === 'lost' || d.outcome === 'push')
    .filter(d => (league ? d.league === league : true))
    .filter(d => (market ? d.market === market : true));
}

/** Rows shaped for the calibration helpers (pushes excluded). */
function toCalibrationRows(docs) {
  return docs.map(d => ({ p: d.probability, y: d.outcome === 'push' ? null : (d.outcome === 'won' ? 1 : 0) }));
}

/**
 * Rolling performance for one market (and optionally league).
 * Includes expected-vs-actual calibration and a downgrade verdict.
 *
 * @param {Object} opts
 * @param {number} [opts.window] - last N predictions to consider
 * @param {number} [opts.minSample] - minimum sample before a verdict is given
 * @param {number} [opts.tolerance] - allowed gap between predicted and actual
 */
function summarisePerformance(docs, { window = 100, minSample = 30, tolerance = 0.07 } = {}) {
  const rows = docs.slice(-window);
  const graded = rows.filter(d => d.outcome === 'won' || d.outcome === 'lost');
  const n = graded.length;
  const hits = graded.filter(d => d.outcome === 'won').length;
  const avgPredicted = n ? graded.reduce((s, d) => s + d.probability, 0) / n : null;
  const actual = n ? hits / n : null;
  const roi = n ? rows.reduce((s, d) => s + profit(d.outcome, d.odds), 0) / n : null;

  const cal = toCalibrationRows(graded);
  const result = {
    sample: n,
    hits,
    hitRate: actual,
    avgPredicted,
    calibrationGap: (n && avgPredicted != null) ? actual - avgPredicted : null,
    brier: brierScore(cal),
    logLoss: logLoss(cal),
    roi,
    byBucket: calibrationCurve(cal),
  };

  if (n < minSample) {
    result.verdict = 'insufficient-sample';
  } else if (actual < avgPredicted - tolerance) {
    result.verdict = 'underperforming';
  } else if (actual > avgPredicted + tolerance) {
    result.verdict = 'outperforming';
  } else {
    result.verdict = 'within-range';
  }
  return result;
}

/** Full performance report grouped by market and league. */
async function getBasketballPerformance(admin, { league = null, window = 100, cfg = null } = {}) {
  const docs = await loadSettled(admin, { league });
  const markets = ['Total Points', 'Spread'];
  const report = { overall: summarisePerformance(docs, { window }), byMarket: {}, byLeague: {} };

  markets.forEach(m => {
    report.byMarket[m] = summarisePerformance(docs.filter(d => d.market === m), { window });
  });

  const leagues = [...new Set(docs.map(d => d.league).filter(Boolean))];
  leagues.forEach(l => {
    report.byLeague[l] = summarisePerformance(docs.filter(d => d.league === l), { window });
  });

  report.policy = deriveMarketPolicy(report, cfg);
  return report;
}

/**
 * Auto-downgrade decision per market from its rolling performance.
 *
 * A market whose realised hit rate falls below the average probability it stated
 * (gap = actual - predicted) is downgraded, and disabled outright once the gap
 * is large. Markets without enough settled picks stay 'active' rather than being
 * punished for a small sample.
 *
 * @param {Object} report - getBasketballPerformance output (or { byMarket })
 * @param {Object} [cfg]  - basketball config; falls back to the module default
 * @returns {Object} { status: {market: 'active'|'downgraded'|'disabled'}, reasons, enabled }
 */
function deriveMarketPolicy(report, cfg = null) {
  const config = cfg || require('./config');
  const ad = config.selection?.autoDowngrade || {};
  const enabled = ad.enabled !== false;
  const downgradeGap = ad.downgradeGap ?? -0.07;
  const disableGap = ad.disableGap ?? -0.15;

  const status = {};
  const reasons = {};
  const byMarket = report?.byMarket || {};

  Object.keys(byMarket).forEach(market => {
    const s = byMarket[market] || {};
    const gap = s.calibrationGap;
    const n = s.sample ?? 0;

    if (!enabled || n < (ad.minSample ?? 30) || gap == null) {
      status[market] = 'active';
      reasons[market] = `insufficient-sample (n=${n})`;
      return;
    }
    if (gap <= disableGap) {
      status[market] = 'disabled';
      reasons[market] = `realised hit rate ${(s.hitRate * 100).toFixed(1)}% vs stated ${(s.avgPredicted * 100).toFixed(1)}% (gap ${(gap * 100).toFixed(1)}pp)`;
    } else if (gap <= downgradeGap) {
      status[market] = 'downgraded';
      reasons[market] = `realised hit rate ${(s.hitRate * 100).toFixed(1)}% vs stated ${(s.avgPredicted * 100).toFixed(1)}% (gap ${(gap * 100).toFixed(1)}pp)`;
    } else {
      status[market] = 'active';
      reasons[market] = 'within range';
    }
  });

  return { enabled, status, reasons };
}

// --------------------------------------------------------------------------
// Persisted calibrators
// --------------------------------------------------------------------------

/**
 * Build the document that stores one league's fitted calibrator, together with
 * the evidence that justifies applying it. Only models that passed the holdout
 * gate against the identity are described by `accepted: true`; anything else is
 * written as `accepted: false` and will be ignored on load.
 *
 * @param {Object} params
 * @param {string} params.league
 * @param {Object} params.calibrator - calibration.Calibrator (already fitted)
 * @param {Object} params.validation - per-market validateAgainstIdentity output
 * @param {string[]} params.markets
 * @param {string} [params.oddsSource] - 'book' | 'model' (how lines were valued)
 * @param {Object} [params.training]   - { rows, from, to, seasons }
 * @returns {Object}
 */
function buildCalibratorDoc({
  league, calibrator, validation = {}, markets = [], oddsSource = null, training = {}, version = CALIBRATOR_VERSION,
} = {}) {
  const accepted = markets.filter(m => validation[m]?.improved === true && calibrator?.has(league, m));
  const models = {};
  accepted.forEach(m => {
    const entry = calibrator.entry(league, m);
    if (entry) models[`${league}|${m}`] = entry;
  });

  return {
    id: String(league),
    league: String(league),
    version,
    accepted: accepted.length > 0,
    shadow: true, // R4: logged, not displayed, until the shadow report is approved
    oddsSource,
    markets: accepted,
    models,
    validation,
    training: {
      rows: training.rows ?? null,
      from: training.from ?? null,
      to: training.to ?? null,
      seasons: training.seasons ?? null,
    },
    fittedAt: new Date().toISOString(),
  };
}

/** Persist a calibrator document (one per league). */
async function saveCalibrator(admin, doc) {
  if (!doc?.league) return null;
  await admin.firestore().collection(CALIBRATION_COLLECTION).doc(String(doc.league)).set(doc);
  return doc;
}

/** Load a league's calibrator doc, or null when none was accepted. */
async function loadCalibratorDoc(admin, league) {
  if (!league) return null;
  const snap = await admin.firestore().collection(CALIBRATION_COLLECTION).doc(String(league)).get();
  if (!snap?.exists) return null;
  const data = typeof snap.data === 'function' ? snap.data() : snap.data;
  return data?.accepted === true && data?.models ? data : null;
}

/**
 * Load every accepted calibrator into one Calibrator instance for the engine.
 * Returns null when nothing was accepted, so callers pass null and the engine
 * uses raw probabilities — an unvalidated calibrator is never applied.
 */
async function loadCalibrator(admin, cfg = null) {
  const config = cfg || require('./config');
  if (config.calibration?.enabled === false) return null;
  let snap;
  try {
    snap = await admin.firestore().collection(CALIBRATION_COLLECTION).get();
  } catch (err) {
    return null;
  }
  const merged = {};
  (snap?.docs || []).forEach(d => {
    const data = typeof d.data === 'function' ? d.data() : d.data;
    if (data?.accepted !== true || !data.models) return;
    Object.assign(merged, data.models);
  });
  if (!Object.keys(merged).length) return null;
  return Calibrator.fromJSON(config, merged);
}

module.exports = {
  COLLECTION,
  CALIBRATION_COLLECTION,
  SNAPSHOT_COLLECTION,
  settleOne,
  profit,
  saveBasketballPredictions,
  saveLineSnapshots,
  minutesToTip,
  withinHorizon,
  resolveSnapshotWindows,
  settleBasketballPredictions,
  loadSettled,
  summarisePerformance,
  deriveMarketPolicy,
  getBasketballPerformance,
  buildCalibratorDoc,
  saveCalibrator,
  loadCalibratorDoc,
  loadCalibrator,
};
