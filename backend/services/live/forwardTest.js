/**
 * live/forwardTest.js
 *
 * Phase 9 — log every live probability we actually serve, and retire the pick
 * the moment the realised numbers stop matching the backtest.
 *
 * The ship gate passed on held-out HISTORY. A backtest can be right and live
 * serving still go wrong — a stale feed, a different league mix, a season that
 * simply behaves differently. Phase 9 therefore watches the pick in production:
 *
 *   - Every shipped live home-win probability is appended with its timestamp,
 *     its data staleness and (once the game ends) its outcome.
 *   - A rolling, GAME-level log loss is compared against the backtest benchmark
 *     the fit script recorded. Past the configured tolerance the pick is
 *     auto-DISABLED (services/live/policy consults this), so a drifting model
 *     withdraws itself instead of quietly serving bad numbers.
 *   - The pick is only opened to everyone after `minGames` settled live games
 *     have confirmed the benchmark (services/live/policy gates the rollout).
 *
 * The log is a plain JSON file (CONFIG.live.forwardTest.file), so it survives a
 * restart without a database and can be committed or shipped with the report.
 * It is deliberately NOT part of any user-facing payload.
 */

const path = require('path');
const crypto = require('crypto');

const CONFIG = require('./config');
const { brierScore, logLoss } = require('../basketball/calibration');
// Reused, not re-implemented: the score-and-time baseline and the game-level
// bootstrap must be the SAME code the ship gate used, or the shadow hold would
// be measured against a different ruler than the gate it is meant to confirm.
const BT = require('./backtester');
const liveCalibrator = require('./liveCalibrator');
// Phase 10 round D — the CONFIRMATION dataset is defined by the frozen
// candidate artifact's freeze instant, so the forward log has to read it.
const shadowCandidates = require('./shadowCandidates');
// Phase 10 round G (item 1) — durability goes through ONE storage adapter
// (file in tests/dev, Firestore in production) and the evaluation ledger.
const store = require('./store');
const ledger = require('./ledger');
const countersLib = require('./store/counters');
const grid = store.grid;

const FWD = CONFIG.live.forwardTest;
const BACKEND_DIR = path.join(__dirname, '..', '..');

/** Resolve a config-relative artifact path to an absolute one. */
function resolveFile(file = FWD.file) {
  if (!file) return null;
  return path.isAbsolute(file) ? file : path.join(BACKEND_DIR, file);
}

function round4(v) {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(4));
}

/** The frozen release criteria in force right now (config live.releaseCriteria). */
function releaseCriteria() {
  return (CONFIG.live && CONFIG.live.releaseCriteria) || {};
}

/**
 * A stable content id for a release-criteria block (Phase 9 freeze).
 *
 * The criteria decide when basketball may leave shadow. They are frozen BEFORE
 * any shadow row exists, and every row records the id in force when it was
 * written, so a mid-collection edit is detectable rather than silent: the same
 * values always hash to the same id, and any change to a threshold — or to the
 * frozen date — yields a different one. Never throws.
 */
function criteriaId(criteria = releaseCriteria()) {
  const c = criteria || {};
  try {
    const payload = JSON.stringify({
      frozen_at: c.frozen_at || null,
      benchmarkLogLoss: Number.isFinite(c.benchmarkLogLoss) ? c.benchmarkLogLoss : null,
      logLossTolerance: Number.isFinite(c.logLossTolerance) ? c.logLossTolerance : null,
      minSettledGames: Number.isFinite(c.minSettledGames) ? c.minSettledGames : null,
      confidence: Number.isFinite(c.confidence) ? c.confidence : null,
      bootstrap: c.bootstrap || null,
      buckets: c.buckets || null,
      perLeague: c.perLeague || null,
      // AMENDMENT 1 (2026-11-08): the log-loss-gain-vs-scoreTime CI-lower clause
      // is part of the GATE, so it is part of the id. (The `amendments` prose is
      // deliberately NOT hashed — a note edit must not move the criteria id.)
      scoreTimeGain: c.scoreTimeGain || null,
    });
    return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 12);
  } catch (err) {
    return null;
  }
}

/**
 * The frozen criteria id the current block AMENDED (Phase 9 amendment 1).
 * Every row records it alongside the id in force, so evidence collected after an
 * amendment is traceable to both the amended gate and the one it superseded.
 * Returns null when the block carries no dated amendment. Never throws.
 */
function priorCriteriaId(criteria = releaseCriteria()) {
  try {
    const list = criteria && Array.isArray(criteria.amendments) ? criteria.amendments : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const id = list[i] && list[i].prior_criteria_id;
      if (id) return id;
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * The in-game checkpoint a LiveGame represents, in the shape the baselines and
 * the bucket split read. Only the fields they actually use are copied.
 */
function checkpointOf(game) {
  const live = (game && game.live) || {};
  return {
    clock: live.clock || null,
    period: Number(live.period) || 0,
    home_score: game && game.home ? game.home.score : null,
    away_score: game && game.away ? game.away.score : null,
  };
}

/** mulberry32 — the same tiny deterministic PRNG the ship gate bootstrap uses. */
function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nearest-rank percentile of an ascending-sorted array. */
function percentileOf(sorted, q) {
  if (!sorted || !sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx];
}

/* --------------------------------------------------- durable storage (round G) */

/** An empty store result (no rows, no meta, blank counters). */
function emptyStore() {
  return {
    rows: [],
    benchmarkLogLoss: null,
    criteria: null,
    shadowCalibratorId: null,
    updatedAt: null,
    counters: countersLib.blank(),
    rows_complete: false,
  };
}

/**
 * Hydrate the in-memory working set from a storage-adapter result.
 *
 * Round I (item 1): the durable AGGREGATE COUNTERS ride along on the meta read,
 * so the health surface (rows per day, settled games per sport/league, the
 * first/last row time) is available even when the rows themselves are not
 * loaded — which, in production (Firestore), is the normal case.
 */
function applyStore(data) {
  const d = data || {};
  rows = Array.isArray(d.rows) ? d.rows : [];
  benchmarkLogLoss = Number.isFinite(d.benchmarkLogLoss) ? d.benchmarkLogLoss : null;
  criteriaSnapshot = d.criteria || null;
  shadowCalibratorId = d.shadowCalibratorId || null;
  updatedAt = d.updatedAt || null;
  counters = d.counters ? countersLib.mergeInto(countersLib.blank(), d.counters) : countersLib.blank();
  countersDelta = countersLib.blank();
  // The meta already carries a first-row time, so this session must NOT re-apply
  // it (a later, larger timestamp would overwrite the durable minimum).
  countersFirstApplied = Number.isFinite(counters.first_row_at_ms);
  // Round I (item 1) — are these rows the WHOLE set? True for the file backend
  // and a `readRows()` full load; false for the Firestore startup meta read.
  // The counts-only surfaces (progress, confirmationSummary) consult this so
  // they derive from the durable counters instead of reporting an empty set.
  rowsComplete = d.rows_complete === true;
}

let rows = [];
let benchmarkLogLoss = null;
let updatedAt = null;
/**
 * Round I (item 1) — the durable AGGREGATE counters, mirrored in memory.
 * `counters` is the running truth (rows per UTC day, settled games per
 * sport/league, first/last row time); `countersDelta` is what has changed since
 * the last flush and is what the Firestore backend applies ATOMICALLY
 * (FieldValue.increment) in the same write as the rows. The file backend
 * ignores the delta and re-derives the counters from its local rows.
 */
let counters = countersLib.blank();
let countersDelta = countersLib.blank();
let countersFirstApplied = false;
/**
 * Round I (item 1) — whether `rows` currently holds the WHOLE evidence set (the
 * file backend, or a `readRows()` full load) or only the handful written since
 * this process started (the Firestore startup path, which loads no rows). The
 * counts-only surfaces use it to decide between scoring the rows and reading the
 * durable counters.
 */
let rowsComplete = false;
/**
 * Phase 9 freeze: the release criteria and calibrator version the shadow run
 * started under. Captured from the FIRST shadow row and never overwritten, so a
 * later change is a detectable drift (`shadowSummary.criteria.moved`) rather
 * than a silent re-baseline.
 */
let criteriaSnapshot = null;
let shadowCalibratorId = null;
let loaded = false;
let dirty = false;
let lastWrite = 0;
/**
 * Round J (item 3) — the STARTUP HYDRATE promise. On the Firestore backend the
 * meta read (which carries the durable counters) is ASYNCHRONOUS, so `init()`
 * returns before the counters are in memory. A surface that must report a
 * CONSISTENT view (the /live/stats route spreads `status()` and
 * `confirmationSummary()` into one payload) awaits `ready()` first, so the two
 * are never computed from different hydration states — otherwise a cold start
 * could show `status.total_rows = 3` beside `confirmation.settled_games = 0`.
 */
let hydratePromise = null;
/**
 * Round I (item 3) — open sweep BATCHES. While > 0, `flush()` defers, so a whole
 * sweep's rows + counter delta land in ONE meta write at the outermost
 * `endBatch()`. Guards against the single-document write rate.
 */
let batchDepth = 0;
const verdicts = new Map();
/**
 * Rows changed since the last flush, keyed by their storage key. The Firestore
 * backend upserts only these, so a sweep writes the rows it actually touched
 * instead of the whole collection; the file backend ignores it and rewrites the
 * snapshot (bounded by maxRows).
 */
const pendingRows = new Map();

/** The frozen meta carried alongside the rows. */
function currentMeta() {
  return {
    benchmarkLogLoss: Number.isFinite(benchmarkLogLoss) ? benchmarkLogLoss : null,
    // Phase 9 freeze: what the shadow run was collected under. Written once (on
    // the first shadow row) and carried forward, so the artifact documents the
    // frozen criteria and calibrator even after a restart.
    criteria: criteriaSnapshot || null,
    shadow_calibrator_id: shadowCalibratorId || null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Load the persisted log once, through the storage adapter (round G item 1).
 * Idempotent; safe to call at startup.
 *
 * Round I (item 1) — the startup path reads the META document only
 * (`store.readMeta`): the durable counters plus the calibrator/criteria/benchmark
 * pointers, NEVER the whole `rows` subcollection. On the Firestore free tier a
 * full subcollection read grows with the collection (tens of thousands of
 * documents), so it is reserved for the one-off confirmation evaluation
 * (`loadRows: true`). The file backend (tests/dev) is local and bounded, so its
 * `readMeta` still returns the rows and the working set behaves exactly as
 * before.
 *
 * @param {Object} [opts]
 * @param {string} [opts.file]
 * @param {number|null} [opts.benchmarkLogLoss] backtest log loss to compare against
 * @param {boolean} [opts.loadRows] ONE-OFF EVAL ONLY — force `readRows()` so the
 *   full row set is present (the confirmation evaluation needs every row). Never
 *   on a request or startup path.
 */
function init({ file = FWD.file, benchmarkLogLoss: bench = undefined, loadRows = false } = {}) {
  loaded = true;
  dirty = false;
  verdicts.clear();
  pendingRows.clear();
  if (FWD.enabled === false) {
    applyStore(emptyStore());
  } else {
    const st = store.getStore();
    const meta = typeof st.readMeta === 'function' ? st.readMeta({ file }) : null;
    if (meta && typeof meta.then === 'function') {
      // A Firestore backend (production) has no synchronous read: start empty and
      // hydrate when the meta read lands — guarded so rows appended in the
      // meantime are never lost.
      applyStore(emptyStore());
      hydratePromise = Promise.resolve(meta)
        .then(data => { if (!rows.length) applyStore(data); })
        .catch(() => {});
    } else {
      applyStore(meta || emptyStore());
      hydratePromise = null;
    }
  }
  if (bench !== undefined) benchmarkLogLoss = bench;
  if (loadRows && FWD.enabled !== false) {
    // ONE-OFF EVAL ONLY. A Firestore readRows is async; guard the same way so the
    // full set lands without clobbering anything logged meanwhile.
    const st = store.getStore();
    const full = typeof st.readRows === 'function' ? st.readRows({ file }) : null;
    if (full && typeof full.then === 'function') {
      Promise.resolve(full)
        .then(data => { if (!rows.length) applyStore(data); })
        .catch(() => {});
    } else if (full) {
      applyStore(full);
    }
  }
  return status();
}

function ensure() {
  if (!loaded) init();
}

/**
 * Persist rows + meta (+ the counter delta) through the adapter now (on settle,
 * at shutdown, tests).
 *
 * The file backend writes the whole snapshot and returns a boolean; the Firestore
 * backend writes the meta document — applying the counter delta ATOMICALLY via
 * FieldValue.increment — and upserts the rows changed since the last flush,
 * returning a promise. Both are best-effort: a failed write is swallowed here and
 * the next sweep retries.
 *
 * Round I (item 1): `countersDelta` is what changed since the last flush (rows
 * per day, settled games per sport/league, the latest row time). It is reset
 * after the attempt; `first_row_at` is applied exactly once via `first_row_at_apply`
 * so a later batch can never overwrite the durable minimum.
 *
 * Round I (item 3): while a sweep BATCH is open (`beginBatch`) this defers — it
 * records the work as dirty and returns without a write, so the whole sweep
 * lands in ONE meta-document write at `endBatch`, not one per row or per
 * settled game. That keeps the sweep inside Firestore's single-document write
 * rate.
 */
function flush(file = FWD.file) {
  ensure();
  if (batchDepth > 0) { dirty = true; return false; }
  return flushNow(file);
}

/** The actual write; `flush` defers to here once the batch (if any) has closed. */
function flushNow(file = FWD.file) {
  const st = store.getStore();
  const meta = currentMeta();
  const pending = [...pendingRows.values()];
  pendingRows.clear();
  const delta = countersDelta;
  countersDelta = countersLib.blank();
  // The very first row ever written fixes first_row_at; set it only until the
  // store has persisted it (applyStore sets the flag when meta already had one).
  if (!countersFirstApplied && Number.isFinite(delta.first_row_at_ms)) {
    delta.first_row_at_apply = true;
    countersFirstApplied = true;
  }
  let result;
  try {
    result = st.flush({ rows, meta, pending, file, countersDelta: delta });
  } catch (err) {
    result = false;
  }
  updatedAt = meta.updatedAt;
  dirty = false;
  lastWrite = Date.now();
  if (result && typeof result.then === 'function') {
    return result
      .then(res => { reconcileMirror(delta, res); return res; })
      .catch(() => false);
  }
  return result;
}

/**
 * Round I (item 1) — correct the in-memory counter mirror with what the store
 * ACTUALLY created.
 *
 * On Firestore the rows subcollection is NOT loaded at startup, so `recordServed`
 * cannot tell a brand-new checkpoint from one already stored — it can only see
 * whether the key is new to THIS process's memory. After a restart every
 * re-logged checkpoint therefore looks new and would inflate `rows_by_day`. The
 * store, writing with create() semantics, KNOWS which documents it created, and
 * returns them as `counters_delta.rows_by_day`. This replaces the guess with that
 * truth, so the counts-only surfaces (progress, confirmation) never inherit an
 * inflated count.
 *
 * `guess` is the delta the caller accumulated; both it and the mirrored
 * `counters` carry the guess, so subtracting the difference for each day the
 * guess touched leaves the mirror equal to the durable value.
 */
function reconcileMirror(guess, result) {
  if (!result || typeof result !== 'object') return;
  const truth = (result.counters_delta && result.counters_delta.rows_by_day) || {};
  Object.keys((guess && guess.rows_by_day) || {}).forEach(day => {
    const g = Number(guess.rows_by_day[day]) || 0;
    const t = Number(truth[day]) || 0;
    if (g !== t) counters.rows_by_day[day] = Math.max(0, (counters.rows_by_day[day] || 0) + (t - g));
  });
}

/**
 * Round I (item 3) — open a sweep BATCH. While one is open, `flush()` defers all
 * durable writes so the ROW WRITES and the COUNTER DELTA of an entire sweep land
 * in a single meta-document write at `endBatch`. Nested batches are counted, so
 * only the outermost close performs the write.
 */
function beginBatch() {
  batchDepth += 1;
}

/**
 * Close a sweep BATCH; when the outermost one closes, perform the single
 * deferred flush. Safe to call more times than `beginBatch` (a close with no
 * open batch is a normal flush).
 */
function endBatch(file = FWD.file) {
  if (batchDepth > 0) batchDepth -= 1;
  if (batchDepth === 0) return flushNow(file);
  return false;
}

/** Throttled write: at most one per persistIntervalMs while serving. */
function maybePersist(now = Date.now(), file = FWD.file) {
  if (!dirty) return false;
  if (now - lastWrite < (FWD.persistIntervalMs || 0)) return false;
  return flush(file);
}

/** Cap the log so an unbounded watch cannot grow the file forever. */
function trim() {
  const max = FWD.maxRows || 0;
  if (max > 0 && rows.length > max) rows = rows.slice(rows.length - max);
}

/** Rows already kept for one game. */
function rowsForGame(gameId) {
  if (gameId == null) return [];
  return rows.filter(r => r.game_id === gameId);
}

/**
 * Round I (item 2) — the most recent time a row was logged for one game, as
 * epoch ms, or null when no row for it is in the working set.
 *
 * The sweep orders its candidates by this (least-recently-logged first) so a
 * truncated call cannot keep spending its budget on the same leading games and
 * starve the rest. It reads only the rows in memory — on the file backend that
 * is the whole log; on Firestore it is the rows written since this process
 * started, which is exactly the window a burst of sweeps between host sleeps
 * competes over. A tie (or no row at all) is treated as `null` by the caller —
 * never-logged games sort first.
 */
function lastLoggedAt(gameId) {
  ensure();
  if (gameId == null) return null;
  let last = null;
  rows.forEach(r => {
    if (r.game_id === gameId && Number.isFinite(r.at_ms) && (last == null || r.at_ms > last)) {
      last = r.at_ms;
    }
  });
  return last;
}

/**
 * Append one served probability.
 *
 * Store only rows that map to the replay grid: a checkpoint whose elapsed
 * fraction is not within gridTolerance of a grid mark is skipped. Writing is
 * IDEMPOTENT, keyed by (sport, league, game_id, grid_checkpoint) — a retry or a
 * double sweep cannot add a second row, and a game is bounded at one row per
 * grid mark.
 *
 * @param {Object} args
 * @param {Object} args.game        Phase 3 LiveGame
 * @param {number} args.probability the home-win probability actually served
 * @param {number} [args.raw]       the pre-calibration probability (diagnostics)
 * @param {number} [args.now]
 * @param {string} [args.source]    'provider' | 'manual' | ...
 * @param {boolean} [args.shadow]   true when this row was computed but WITHHELD
 *   from every client (Phase 9 hold). Shadow rows are kept as evidence but never
 *   counted by evaluate(), so a held pick cannot auto-disable a shipped one.
 * @param {Object} [args.candidates] Phase 10 — the FROZEN candidate columns for
 *   this checkpoint (services/live/shadowCandidates), logged verbatim so the
 *   fresh-data evaluation scores a fixed target. Never invented here.
 * @param {boolean} [args.dryRun] Round H (item 2) — run the full computation and
 *   grid gating and RETURN the row that would be written, but mutate NOTHING
 *   (no row, no pending entry, no ledger, no freeze). Used by the sweep dry run.
 * @returns {Object|null} the appended row, or null when it was skipped
 */
function recordServed({ game, probability, raw = null, now = Date.now(), source = null, shadow = false, candidates = null, dryRun = false } = {}) {
  ensure();
  if (FWD.enabled === false) return null;
  if (!game || !game.game_id) return null;
  // Hand-typed games never ship a probability, so they must never enter the
  // sample that decides whether the real pick lives or dies.
  if (game.manual) return null;
  if (!Number.isFinite(probability)) return null;

  const p = round4(probability);
  const clock = game.live ? game.live.clock : null;
  const period = game.live ? game.live.period : null;

  const freshness = game.freshness || {};
  const cp = checkpointOf(game);
  // The score-and-time baseline and the elapsed fraction, both derived from THIS
  // checkpoint only. A failure is recorded as null, never thrown: a logged row
  // must never be lost to a baseline derivation.
  let pScoreTime = null;
  let progress = null;
  let bucket = null;
  try {
    const leagueId = (game.league && game.league.id) || null;
    pScoreTime = round4(BT.scoreTimeProbability(cp, game.sport, leagueId));
    progress = BT.progressFraction(cp, game.sport, leagueId);
    bucket = BT.bucketFor(progress);
  } catch (err) {
    pScoreTime = null;
    progress = null;
    bucket = null;
  }

  // Phase 10 round G (item 1) — store ONLY rows that map to the replay grid.
  // A checkpoint whose elapsed fraction is not within gridTolerance of a grid
  // mark is skipped entirely, so what is stored is exactly the schedule the
  // replay scores, and the storage key (below) is stable across re-runs.
  const gc = grid.gridCheckpoint(progress);
  if (gc == null) return null;
  // The value stored ON the row (rounded), used for both the row and the
  // nearest-wins comparison below — comparing a raw fraction against a stored
  // rounded one would let an identical checkpoint look (very slightly) nearer
  // and spuriously overwrite itself.
  const storedProgress = Number.isFinite(progress) ? round4(progress) : null;

  const cid = criteriaId();
  // AMENDMENT 1: the id this block superseded, written on every row so evidence
  // collected after the amendment is traceable to both gates.
  const cidPrior = priorCriteriaId();
  const calibId = liveCalibrator.id();

  const row = {
    at: new Date(now).toISOString(),
    at_ms: now,
    game_id: game.game_id,
    sport: game.sport || null,
    league: (game.league && game.league.id) || null,
    market: CONFIG.live.calibration.market,
    p,
    p_raw: round4(raw),
    // The score-and-time baseline at this exact checkpoint, so the shadow
    // summary scores the model against it on the SAME rows (Phase 9).
    p_score_time: pScoreTime,
    // Elapsed fraction and its early/mid/late bucket, frozen ON the row so a
    // later bucket-edge edit cannot silently re-bucket collected evidence.
    progress: storedProgress,
    bucket,
    // Phase 10 round G (item 1) — the replay grid mark this row was snapped to.
    // It is the idempotency key's last component, so a retry or a double sweep
    // overwrites the same stored row instead of appending a second one.
    grid_checkpoint: gc,
    // Phase 10 — the FROZEN candidate columns for this exact checkpoint
    // (basketball logistic; soccer empirical table / multinomial logistic /
    // scoreTime). Null when the frozen artifact is absent — never a fabricated
    // number. Carried verbatim so the fresh-data evaluation (>= 500 settled
    // games) scores a fixed target that was never refit on this evidence.
    candidates: candidates || null,
    source: source || game.source || null,
    // true = computed but withheld (shadow evidence), false = actually served.
    shadow: shadow === true,
    data_tier: game.data_tier || null,
    staleness_seconds: Number.isFinite(freshness.age_seconds) ? freshness.age_seconds : null,
    is_stale: freshness.is_stale === true,
    clock,
    period,
    // The frozen release criteria and calibrator version in force right now, so
    // a mid-collection change is visible per row (see shadowSummary). The prior
    // id is the frozen id the current block amended (amendment 1), or null.
    criteria_id: cid,
    criteria_id_prior: cidPrior,
    calibrator_id: calibId,
    y: null,
    settled_at: null,
  };

  // Phase 10 round G (item 1) — idempotent write keyed by
  // (sport, league, game_id, grid_checkpoint). The log holds AT MOST one row per
  // (game, grid mark): a retry or a double sweep finds the existing key, and if
  // the new checkpoint is not NEARER the mark it adds nothing. Keeping the
  // nearest row (rather than first- or last-write-wins) makes the stored set
  // independent of sweep order and identical to what resampleToGrid would pick.
  const key = grid.storageKey(row);
  const existingIdx = key == null ? -1 : rows.findIndex(r => grid.storageKey(r) === key);
  if (existingIdx >= 0) {
    const prev = rows[existingIdx];
    const prevD = Math.abs((Number.isFinite(prev.progress) ? prev.progress : NaN) - gc);
    const newD = Math.abs(storedProgress - gc);
    if (!(newD < prevD)) return null;
    // Round H (item 2) — a DRY RUN reports the row that WOULD overwrite and
    // stops here: nothing is mutated.
    if (dryRun) return row;
    rows[existingIdx] = row;
  } else {
    // Cap rows per game so a long watch cannot dominate the sample; the grid
    // already bounds a game at one row per mark.
    if ((FWD.maxRowsPerGame || 0) > 0 && rowsForGame(game.game_id).length >= FWD.maxRowsPerGame) return null;
    if (dryRun) return row;
    rows.push(row);
  }
  if (key != null) pendingRows.set(key, row);

  // Round I (item 1) — keep the durable counters in step with the rows written.
  // A NEW grid key adds a row to today's bucket and may move the first/last
  // bounds; an OVERWRITE adds no row (same key) but may still extend the latest
  // row time. `counters` is the running truth, `countersDelta` what the store
  // applies atomically on the next flush.
  if (existingIdx < 0) {
    countersLib.addRow(counters, row);
    countersLib.addRow(countersDelta, row);
  } else {
    countersLib.touchTime(counters, row.at_ms, row.at);
    countersLib.touchTime(countersDelta, row.at_ms, row.at);
  }

  if (shadow === true) {
    freezeShadow(cid, calibId);
    // Round G item 5 — record the FIRST post-freeze row in the durable ledger.
    // Best-effort: a ledger failure must never lose the evidence row itself.
    try { ledger.recordShadowRow(row); } catch (err) { /* ledger is non-critical */ }
  }
  trim();
  dirty = true;
  verdicts.clear();
  maybePersist(now);
  return row;
}

/**
 * Capture the release criteria and calibrator version the shadow run started
 * under. Called on every shadow row but only the FIRST one sticks: re-freezing
 * would defeat the point, which is that later rows can be checked against it.
 */
function freezeShadow(cid, calibId) {
  if (!criteriaSnapshot) {
    let block = null;
    try {
      block = JSON.parse(JSON.stringify(releaseCriteria()));
    } catch (err) {
      block = null;
    }
    criteriaSnapshot = { id: cid, block };
  }
  if (!shadowCalibratorId) shadowCalibratorId = calibId || null;
}

/**
 * Bind outcomes to the rows logged for a finished game.
 *
 * Round I (item 1) — in production (Firestore) the rows subcollection is NOT
 * loaded at startup, so a game that finished after a restart would have no rows
 * in memory. When that is the case this fetches ONLY that game's rows
 * (`store.readRowsForGame`, <= maxRowsPerGame documents) and settles them
 * exactly, rather than loading the whole collection. The in-memory path stays
 * synchronous, so callers that settle a game already in the working set (the
 * live request path, tests) are unaffected.
 *
 * @param {boolean} [args.dryRun] Round H (item 2) — count the rows that WOULD
 *   settle and mutate nothing (no outcome, no flush). Used by the sweep dry run.
 * @returns {number|Promise<number>} how many rows were settled by this call
 */
function settle({ gameId, homeScore, awayScore, now = Date.now(), dryRun = false } = {}) {
  ensure();
  if (gameId == null) return 0;
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return 0;
  // Basketball has no draw; an equal score is a push and is graded as neither.
  const y = homeScore > awayScore ? 1 : (homeScore < awayScore ? 0 : null);
  const at = new Date(now).toISOString();
  const params = { y, at, homeScore, awayScore, dryRun };

  const inMemory = rows.filter(r => r.game_id === gameId);
  if (inMemory.length) {
    return applySettlement(inMemory, params);
  }

  // Not in memory (a restart in Firestore mode): fetch ONLY this game's rows.
  const st = store.getStore();
  if (!st || typeof st.readRowsForGame !== 'function') return 0;
  let fetched;
  try {
    fetched = st.readRowsForGame(gameId);
  } catch (err) {
    return 0;
  }
  if (fetched && typeof fetched.then === 'function') {
    return fetched.then(list => applySettlement(Array.isArray(list) ? list : [], params)).catch(() => 0);
  }
  return applySettlement(Array.isArray(fetched) ? fetched : [], params);
}

/**
 * Settle the (unsettled) rows for one game and, when a game becomes settled for
 * the first time, count it once in the durable settled-games counters.
 *
 * @param {Array} list       the game's rows (in memory or fetched for one game)
 * @param {Object} params    { y, at, homeScore, awayScore, dryRun }
 * @returns {number} how many rows were settled
 */
function applySettlement(list, { y, at, homeScore, awayScore, dryRun } = {}) {
  const settledBefore = list.some(r => !!r.settled_at);
  let count = 0;
  let sample = null;
  list.forEach(r => {
    if (r.settled_at) return;
    count++;
    if (dryRun) return;
    r.y = y;
    // Phase 10 — the final score is frozen onto the row too, so the three-way
    // soccer candidates (home/draw/away) can be graded on the SAME rows the
    // binary basketball column uses: y alone cannot distinguish a draw from a
    // one-goal home win once collapsed to a home/not-home bit.
    r.final_home = homeScore;
    r.final_away = awayScore;
    r.settled_at = at;
    // The outcome change must reach the store: register the row so a Firestore
    // flush upserts it (the file backend rewrites the whole snapshot anyway).
    const key = grid.storageKey(r);
    if (key != null) pendingRows.set(key, r);
    if (!sample) sample = r;
  });
  if (count && !dryRun) {
    // Count the settled GAME once — only if it was not already settled before
    // (a later checkpoint for an already-graded game must not inflate the tally).
    if (sample && !settledBefore) {
      countersLib.addSettledGame(counters, { sport: sample.sport, league: sample.league });
      countersLib.addSettledGame(countersDelta, { sport: sample.sport, league: sample.league });
    }
    dirty = true;
    verdicts.clear();
    flush();
  }
  return count;
}

/* ------------------------------------------------------------------ metrics */

/** Group graded rows by game (checkpoints inside a game share one outcome). */
function groupByGame(list) {
  const map = new Map();
  list.forEach(r => {
    if (!map.has(r.game_id)) map.set(r.game_id, []);
    map.get(r.game_id).push(r);
  });
  return [...map.values()];
}

/** Rolled-up metrics for a set of rows. */
function summarise(list = rows) {
  const graded = list.filter(r => (r.y === 0 || r.y === 1) && Number.isFinite(r.p));
  const pending = list.filter(r => r.y == null).length;
  const games = groupByGame(graded).length;
  if (!graded.length) {
    return {
      rows: list.length, graded: 0, games: 0, pending, logLoss: null, brier: null, hitRate: null, avgPredicted: null, calibrationGap: null,
    };
  }
  const pairs = graded.map(r => ({ p: r.p, y: r.y }));
  const hits = graded.filter(r => (r.p >= 0.5 ? 1 : 0) === r.y).length;
  const avg = graded.reduce((s, r) => s + r.p, 0) / graded.length;
  return {
    rows: list.length,
    graded: graded.length,
    games,
    pending,
    logLoss: Number(logLoss(pairs).toFixed(4)),
    brier: Number(brierScore(pairs).toFixed(4)),
    hitRate: round4(hits / graded.length),
    avgPredicted: round4(avg),
    calibrationGap: round4(hits / graded.length - avg),
  };
}

/**
 * Auto-disable verdict for one sport, computed over the last `window` settled
 * GAMES and reused for `verdictTtlMs`. Never a hard error: an unknown benchmark
 * or too little data yields an explicit `insufficient`/`no-benchmark` verdict
 * rather than a false "active".
 *
 * @param {string} [sport]
 * @param {number} [now]
 */
function evaluate(sport = 'basketball', now = Date.now()) {
  ensure();
  const cached = verdicts.get(sport);
  if (cached && now - cached.at < (FWD.verdictTtlMs || 0)) return cached.verdict;

  const cfg = FWD;
  const build = (status, reason, extra = {}) => ({
    status,
    reason,
    sport,
    window: cfg.window,
    minEvaluated: cfg.minEvaluated,
    minGames: cfg.minGames,
    logLossTolerance: cfg.logLossTolerance,
    benchmarkLogLoss: Number.isFinite(benchmarkLogLoss) ? round4(benchmarkLogLoss) : null,
    ...extra,
  });

  if (cfg.enabled === false) {
    return cache(sport, now, build('insufficient', 'the forward test is switched off'));
  }

  // Only rows a user actually SAW decide whether the pick lives; shadow rows
  // (computed but withheld) are evidence for the rollout decision, not for
  // retiring a pick no one is being shown yet.
  const settledGames = groupByGame(rows.filter(r => r.sport === sport && r.shadow !== true && (r.y === 0 || r.y === 1) && Number.isFinite(r.p)));
  const windowGames = (cfg.window || 0) > 0 ? settledGames.slice(-cfg.window) : settledGames;
  const windowRows = windowGames.flat();
  const all = summarise(windowRows);

  if (all.games < (cfg.minEvaluated || 0)) {
    return cache(sport, now, build('insufficient', `only ${all.games} settled live games so far (need ${cfg.minEvaluated})`, { metrics: all }));
  }
  if (!Number.isFinite(benchmarkLogLoss)) {
    return cache(sport, now, build('no-benchmark', 'no backtest log loss is recorded to compare against', { metrics: all }));
  }

  const drift = round4(all.logLoss - benchmarkLogLoss);
  if (all.logLoss > benchmarkLogLoss + (cfg.logLossTolerance || 0)) {
    return cache(sport, now, build(
      'disabled',
      `live log loss ${all.logLoss} exceeds the backtest ${round4(benchmarkLogLoss)} by ${drift} (tolerance ${cfg.logLossTolerance}) over the last ${all.games} settled games`,
      { metrics: all, drift },
    ));
  }
  return cache(sport, now, build('active', `live log loss ${all.logLoss} is within ${cfg.logLossTolerance} of the backtest ${round4(benchmarkLogLoss)}`, { metrics: all, drift }));
}

function cache(sport, now, verdict) {
  verdicts.set(sport, { at: now, verdict });
  return verdict;
}

/** Convenience for policy: is this sport's pick currently retired? */
function isDisabled(sport = 'basketball', now = Date.now()) {
  return evaluate(sport, now).status === 'disabled';
}

/**
 * Project shadow rows into the shape ./backtester's game-level bootstrap reads
 * (`gameId`, `p`, a reference column). The forward log keys games as `game_id`,
 * so without this every checkpoint would look like its own game and the
 * interval would fake precision — exactly what the gate refuses to do.
 */
function toBootstrapRows(list) {
  return (Array.isArray(list) ? list : []).map(r => ({
    gameId: r.game_id,
    y: r.y,
    p: r.p,
    p_score_time: r.p_score_time,
  }));
}

/**
 * Percentile bootstrap of the realised model log loss, resampling WHOLE GAMES.
 *
 * Checkpoints inside one game share its outcome, so resampling rows would report
 * an interval narrower than the evidence supports. Same seeded mulberry32 as the
 * ship gate, so the interval is reproducible from the frozen seed.
 */
function gameLogLossBootstrap(games, bootstrapCfg = {}, probKey = 'p') {
  const iterations = Math.max(1, Number(bootstrapCfg.iterations) || 1);
  const usable = (Array.isArray(games) ? games : []).filter(g =>
    g.some(r => (r.y === 0 || r.y === 1) && Number.isFinite(r[probKey])));
  if (!usable.length) return { n: 0, iterations: 0, lower: null, upper: null };

  const rand = mulberry32(Number(bootstrapCfg.seed) || 1);
  const draws = [];
  for (let it = 0; it < iterations; it++) {
    const sample = [];
    for (let i = 0; i < usable.length; i++) {
      const g = usable[Math.floor(rand() * usable.length)];
      for (let j = 0; j < g.length; j++) sample.push(g[j]);
    }
    const pairs = sample
      .filter(r => (r.y === 0 || r.y === 1) && Number.isFinite(r[probKey]))
      .map(r => ({ p: r[probKey], y: r.y }));
    if (pairs.length) draws.push(logLoss(pairs));
  }
  if (!draws.length) return { n: usable.length, iterations, lower: null, upper: null };
  const sorted = draws.slice().sort((a, b) => a - b);
  return {
    n: usable.length,
    iterations,
    lower: round4(percentileOf(sorted, 0.025)),
    upper: round4(percentileOf(sorted, 0.975)),
  };
}

/**
 * Per-bucket sanity from the frozen criteria: each early/mid/late bucket with at
 * least `buckets.minGames` settled games must be within `buckets.tolerance` of
 * the benchmark (a one-sided check — a bucket that beats the benchmark is not a
 * reason to hold). Buckets below the minimum are reported `judged:false`.
 */
function bucketReport(windowRows, rc, bench) {
  const cfg = rc.buckets || {};
  const labels = Array.isArray(cfg.labels) ? cfg.labels : [];
  const minGames = Number.isFinite(cfg.minGames) ? cfg.minGames : 0;
  const tolerance = Number.isFinite(cfg.tolerance) ? cfg.tolerance : null;
  const out = {};
  labels.forEach(label => {
    const seg = windowRows.filter(r => r.bucket === label);
    const s = summarise(seg);
    const judged = minGames > 0 ? s.games >= minGames : s.games > 0;
    out[label] = {
      games: s.games,
      rows: seg.length,
      logLoss: s.logLoss,
      judged,
      withinTolerance: judged && s.logLoss != null && bench != null && tolerance != null
        ? s.logLoss <= bench + tolerance
        : null,
    };
  });
  return out;
}

/**
 * Per-league sanity from the frozen criteria: a league with at least
 * `perLeague.minGames` settled games must be within `perLeague.tolerance` of the
 * benchmark on its own. This is the check that stops a sport-level pass from
 * hiding one league where the model is materially worse than the benchmark.
 */
function leagueReport(windowRows, rc, bench) {
  const cfg = rc.perLeague || {};
  const minGames = Number.isFinite(cfg.minGames) ? cfg.minGames : 0;
  const tolerance = Number.isFinite(cfg.tolerance) ? cfg.tolerance : null;
  const out = {};
  const seen = [...new Set(windowRows.map(r => r.league).filter(Boolean))];
  seen.forEach(league => {
    const seg = windowRows.filter(r => r.league === league);
    const s = summarise(seg);
    const judged = minGames > 0 ? s.games >= minGames : s.games > 0;
    out[league] = {
      games: s.games,
      rows: seg.length,
      logLoss: s.logLoss,
      judged,
      withinTolerance: judged && s.logLoss != null && bench != null && tolerance != null
        ? s.logLoss <= bench + tolerance
        : null,
    };
  });
  return out;
}

/**
 * Shadow verdict for one sport: how the WITHHELD evidence is tracking against
 * the backtest benchmark. Unlike evaluate(), this disables nothing — a shadow
 * pick is shown to nobody, so there is no served pick to retire. It answers the
 * one question the rollout decision needs: have enough settled live games
 * landed, are they within tolerance, and does every bucket/league with enough
 * games agree? Only then may the pick leave shadow.
 *
 * Everything is counted over the last `window` settled shadow GAMES — GAMES, not
 * checkpoints, because checkpoints inside one game share an outcome — and the
 * intervals come from the same whole-game bootstrap the ship gate uses.
 *
 * @param {string} [sport]
 * @param {number} [now]
 */
function shadowSummary(sport = 'basketball', now = Date.now()) {
  ensure();
  const cfg = FWD;
  const rc = releaseCriteria();
  const bootstrapCfg = rc.bootstrap || { iterations: 2000, seed: 11 };

  const shadowRows = rows.filter(r => r.shadow === true && r.sport === sport);
  const graded = shadowRows.filter(r => (r.y === 0 || r.y === 1) && Number.isFinite(r.p));
  // Settled GAMES, not checkpoints.
  const settledGames = groupByGame(graded);
  const windowGames = (cfg.window || 0) > 0 ? settledGames.slice(-cfg.window) : settledGames;
  const windowRows = windowGames.flat();
  const all = summarise(windowRows);

  const bench = Number.isFinite(benchmarkLogLoss) ? round4(benchmarkLogLoss) : null;
  const tolerance = Number.isFinite(rc.logLossTolerance) ? rc.logLossTolerance : (cfg.logLossTolerance || 0);
  const minGames = Number.isFinite(rc.minSettledGames) ? rc.minSettledGames : (cfg.minGames || 0);
  const drift = (all.logLoss != null && bench != null) ? round4(all.logLoss - bench) : null;
  const withinTolerance = (all.logLoss != null && bench != null)
    ? all.logLoss <= bench + tolerance
    : null;

  // 95% game-level bootstrap: the realised log loss, and the same interval as a
  // drift versus the fixed benchmark.
  const logLossCi = gameLogLossBootstrap(windowGames, bootstrapCfg, 'p');
  const vsBenchmark = (logLossCi.lower == null || bench == null)
    ? { lower: null, upper: null }
    : { lower: round4(logLossCi.lower - bench), upper: round4(logLossCi.upper - bench) };

  // The model's own gain over "score and time only", resampled over whole games
  // with the SAME seed, on the same shadow rows.
  const vsScoreTime = BT.gameBootstrap(toBootstrapRows(windowRows), {
    bootstrap: bootstrapCfg,
    probKey: 'p',
    referenceKey: 'p_score_time',
  });

  const byBucket = bucketReport(windowRows, rc, bench);
  const byLeague = leagueReport(windowRows, rc, bench);

  const enoughGames = all.games >= minGames;
  const bucketOk = Object.values(byBucket).every(b => b.judged !== true || b.withinTolerance === true);
  const leagueOk = Object.values(byLeague).every(l => l.judged !== true || l.withinTolerance === true);
  // AMENDMENT 1 (2026-11-08): the 95% game-level interval for the log-loss gain
  // over the score-and-time baseline must exclude zero. The benchmark tolerance
  // above is looser than the model's whole gain over scoreTime, so passing it
  // does NOT by itself show the model beats "score and time only".
  const gainCfg = rc.scoreTimeGain || {};
  const minLogLossGainCiLower = Number.isFinite(gainCfg.minLogLossGainCiLower)
    ? gainCfg.minLogLossGainCiLower
    : 0;
  const logLossGainCiLower = vsScoreTime.logLossGain ? vsScoreTime.logLossGain.lower : null;
  const scoreTimeGainOk = logLossGainCiLower != null && logLossGainCiLower >= minLogLossGainCiLower;

  const readyReasons = [];
  if (!enoughGames) readyReasons.push(`only ${all.games} settled shadow games (need ${minGames})`);
  if (withinTolerance !== true) readyReasons.push('the realised log loss is not within tolerance of the benchmark');
  if (!bucketOk) readyReasons.push('a time bucket with enough games is outside tolerance');
  if (!leagueOk) readyReasons.push('a league with enough games is outside tolerance');
  if (!scoreTimeGainOk) {
    readyReasons.push(logLossGainCiLower == null
      ? 'the log-loss gain over scoreTime could not be interval-scored yet'
      : `the log-loss gain over scoreTime is not confidently above ${minLogLossGainCiLower} (95% CI lower bound ${logLossGainCiLower})`);
  }
  const ready = readyReasons.length === 0;

  const currentCriteriaId = criteriaId();
  const currentCalibratorId = liveCalibrator.id();

  return {
    sport,
    shadow: true,
    enabled: cfg.enabled !== false,
    rows: shadowRows.length,
    graded_rows: graded.length,
    // How many window rows could be scored against the score-and-time baseline.
    score_time_rows: windowRows.filter(r => Number.isFinite(r.p_score_time)).length,
    games: all.games,
    pending: shadowRows.filter(r => r.y == null).length,
    logLoss: all.logLoss,
    brier: all.brier,
    hitRate: all.hitRate,
    benchmarkLogLoss: bench,
    drift,
    withinTolerance,
    logLossTolerance: tolerance,
    minGames,
    confidence: Number.isFinite(rc.confidence) ? rc.confidence : 0.95,
    // 95% game-level bootstrap interval for the realised log loss, and the same
    // interval expressed as a drift versus the benchmark.
    logLossCi,
    vsBenchmark,
    // The model's gain over "score and time only" on the same games (its own
    // 95% interval; a lower bound below zero means the model is not clearly
    // better than the baseline on the live evidence).
    vsScoreTime: {
      brierGain: vsScoreTime.brierGain,
      logLossGain: vsScoreTime.logLossGain,
      games: vsScoreTime.games,
      iterations: vsScoreTime.iterations,
    },
    // AMENDMENT 1 clause: the gate requires the log-loss-gain-vs-scoreTime
    // interval lower bound to be >= `minLogLossGainCiLower` (0).
    scoreTimeGain: {
      minLogLossGainCiLower,
      logLossGainCiLower,
      ok: scoreTimeGainOk,
    },
    byBucket,
    byLeague,
    // Frozen-criteria integrity: an id drift means collected evidence no longer
    // answers the frozen question and the run must be restarted. `prior_id` is
    // the frozen id amendment 1 superseded (null when there is no amendment).
    criteria: {
      id: currentCriteriaId,
      prior_id: priorCriteriaId(),
      frozen_id: criteriaSnapshot ? criteriaSnapshot.id : null,
      frozen_at: criteriaSnapshot && criteriaSnapshot.block
        ? criteriaSnapshot.block.frozen_at
        : (rc.frozen_at || null),
      amendments: Array.isArray(rc.amendments) ? rc.amendments : [],
      moved: Boolean(criteriaSnapshot && criteriaSnapshot.id && criteriaSnapshot.id !== currentCriteriaId),
    },
    calibrator: {
      id: currentCalibratorId,
      frozen_id: shadowCalibratorId || null,
      moved: Boolean(shadowCalibratorId && shadowCalibratorId !== currentCalibratorId),
    },
    ready,
    ready_reasons: readyReasons,
  };
}

/* --------------------------------------------------- confirmation dataset */

/** How many settled-GAMES every sport must reach before the one-shot run. */
function confirmationMinGames() {
  // The confirmation dataset is a PHASE 10 / ship-gate concept: the user's
  // requirement is >= 500 settled GAMES per sport, which is exactly the ship
  // gate's `minGames`. The Phase 9 release criteria (minSettledGames 300) gate
  // the ROLLING shadow summary, not this one-shot dataset, so it is only a
  // fallback here — reading it first would silently set the target to 300.
  const sg = CONFIG.liveBacktest && CONFIG.liveBacktest.shipGate;
  if (sg && Number.isFinite(sg.minGames)) return sg.minGames;
  if (FWD.minGames > 0) return FWD.minGames;
  const rc = releaseCriteria();
  if (Number.isFinite(rc.minSettledGames)) return rc.minSettledGames;
  return 500;
}

/** The frozen candidate artifact's freeze instant as { iso, ms }. */
function confirmationFreeze() {
  return shadowCandidates.frozenAt();
}

/**
 * Phase 10 round D — the CONFIRMATION dataset.
 *
 * Every earlier "fresh" window was actually a SLIDING window: Oct 1 - Nov 12
 * overlapped Sep 27 - Nov 8 by ~5 weeks, so most of its games had already been
 * scored and were no longer unseen. From this round on, the ONLY dataset that
 * may decide a release is the set of shadow rows logged STRICTLY AFTER the
 * candidate artifact was frozen (`shadow-candidates-1.0.0`'s `frozen_at_ms`).
 * It is evaluated ONCE, and only once it holds >= `confirmationMinGames()`
 * settled GAMES per sport.
 *
 * `pre_freeze_rows`/`pre_freeze_games` are the rows that predate the freeze —
 * already-scored sliding-window evidence that must never be counted as unseen.
 *
 * @param {string} [sport]
 * @returns {Object}
 */
function confirmationSummary(sport = 'basketball') {
  ensure();
  const frozen = confirmationFreeze();
  const freezeMs = frozen.ms;
  const minGames = confirmationMinGames();

  // Round I (item 1) — when the rows subcollection is NOT loaded (production
  // Firestore startup) the per-row breakdown cannot be produced from memory.
  // Derive the counts the durable counters DO carry — settled games for this
  // sport, and the total rows ever written — and mark the row-derived detail as
  // unavailable (null) rather than reporting a misleading zero. The full
  // breakdown is produced in the one-off evaluation, where `loadRows:true` loads
  // every row (then `rowsComplete` is true and the row path below runs).
  if (!rowsComplete) {
    const settled = Number(counters.settled_games_by_sport[sport]) || 0;
    const ready = settled >= minGames;
    return {
      sport,
      dataset: 'shadow rows logged after the candidate freeze timestamp, evaluated once',
      artifact_version: shadowCandidates.version(),
      frozen_at: frozen.iso,
      frozen_at_ms: freezeMs,
      min_settled_games: minGames,
      // The counts came from live_shadow/meta, not from loaded rows.
      counts_source: 'counters',
      pre_freeze_rows: null,
      pre_freeze_games: null,
      rows: countersLib.totalRows(counters),
      settled_games: settled,
      settled_rows: null,
      pending_games: null,
      // No peeking: performance is never derived from the counters.
      logLoss: null,
      brier: null,
      hitRate: null,
      ready_to_evaluate: ready,
      evaluated: false,
      peeking_guarded: true,
      // Row-derived breakdowns are unavailable without the rows.
      resample: null,
      per_league_release: null,
    };
  }

  const shadowRows = rows.filter(r => r.shadow === true && r.sport === sport);
  const timestamped = shadowRows.filter(r => Number.isFinite(r.at_ms));
  // Without a recorded freeze instant we cannot claim any row is unseen, so the
  // dataset is empty rather than silently reusing old evidence.
  const preFreeze = freezeMs != null ? timestamped.filter(r => r.at_ms < freezeMs) : shadowRows;
  const confRows = freezeMs != null ? timestamped.filter(r => r.at_ms >= freezeMs) : [];

  const graded = confRows.filter(r => (r.y === 0 || r.y === 1) && Number.isFinite(r.p));
  const settledGames = groupByGame(graded);
  const all = summarise(confRows);

  // Item 3 (round E) — NO PEEKING. Until the sport holds the target number of
  // settled GAMES the confirmation surface exposes COUNTS ONLY: no Brier, no
  // log loss, no calibration. The metrics are computed in a single pass only
  // once the sport is ready, and that one pass is what the ledger records.
  const ready = settledGames.length >= minGames;
  const perf = ready
    ? { logLoss: all.logLoss, brier: all.brier, hitRate: all.hitRate }
    : { logLoss: null, brier: null, hitRate: null };

  return {
    sport,
    dataset: 'shadow rows logged after the candidate freeze timestamp, evaluated once',
    artifact_version: shadowCandidates.version(),
    frozen_at: frozen.iso,
    frozen_at_ms: freezeMs,
    min_settled_games: minGames,
    // Full per-row breakdown — the counts came from the loaded rows.
    counts_source: 'rows',
    // Rows logged BEFORE the freeze: sliding-window evidence, already seen, and
    // deliberately NOT counted toward the confirmation sample.
    pre_freeze_rows: preFreeze.length,
    pre_freeze_games: groupByGame(preFreeze).length,
    rows: confRows.length,
    settled_games: settledGames.length,
    settled_rows: graded.length,
    pending_games: groupByGame(confRows.filter(r => r.y == null)).length,
    ...perf,
    // The run is made by hand, ONCE, and only when the sport is over the minimum.
    ready_to_evaluate: ready,
    evaluated: false,
    peeking_guarded: true,
    // Item 3 (round F) — how the confirmation rows sit on the REPLAY fraction
    // grid: games with and without a row near the earliest mark, and the settled
    // GAME count (not rows). Counts only — no metric is exposed before `ready`.
    resample: resampleToGrid(confRows),
    // Item 2 (round F) — the pre-registered per-league release verdict. Counts
    // only until a league holds its minimum settled games (see perLeagueRelease).
    per_league_release: perLeagueRelease(sport),
  };
}

/* ---------------------------------------------------------- rollout progress */

/**
 * Phase 10 round D — rollout progress toward the confirmation target.
 *
 * Settled GAMES per sport and per league on the confirmation dataset, plus a
 * first-order estimate of when each reaches the target, extrapolated from the
 * observed settlement rate (settled games per day since the freeze). With no
 * settled games yet no rate exists, so the estimate is null — never a
 * fabricated date. A sport/league already at the target reports an ETA of now.
 */
function progress({ target = null, now = Date.now() } = {}) {
  ensure();
  const goal = Number.isFinite(target) ? target : confirmationMinGames();
  const frozen = confirmationFreeze();
  const freezeMs = frozen.ms;
  const elapsedDays = freezeMs != null ? Math.max((now - freezeMs) / 86400000, 0) : 0;

  const conf = rows.filter(r => r.shadow === true
    && (freezeMs != null ? (Number.isFinite(r.at_ms) && r.at_ms >= freezeMs) : false));
  const graded = conf.filter(r => (r.y === 0 || r.y === 1) && Number.isFinite(r.p));

  const tally = (games, settledRows) => {
    const rate = elapsedDays > 0 ? games / elapsedDays : null;
    const remaining = Math.max(goal - games, 0);
    let etaDays = null;
    let etaAt = null;
    if (remaining === 0) {
      etaDays = 0;
      etaAt = new Date(now).toISOString();
    } else if (rate != null && rate > 0) {
      etaDays = round4(remaining / rate);
      etaAt = new Date(now + (remaining / rate) * 86400000).toISOString();
    }
    // Item 3 (round E) — COUNTS, RATES and ETA only. No Brier / log loss /
    // calibration is exposed here until the sport is ready, so the rollout
    // cannot be read as performance while it is still accruing.
    return {
      settled_games: games,
      settled_rows: Number.isFinite(settledRows) ? settledRows : null,
      target: goal,
      remaining,
      rate_per_day: rate == null ? null : round4(rate),
      eta_days: etaDays,
      eta_at: etaAt,
      at_target: remaining === 0,
    };
  };

  const perSport = {};
  const perLeague = {};
  if (rowsComplete) {
    // The file backend / one-off evaluation holds every row, so the tally is the
    // exact per-row breakdown (settled games AND settled rows).
    [...new Set(graded.map(r => r.sport).filter(Boolean))].forEach(sport => {
      const list = graded.filter(r => r.sport === sport);
      const s = summarise(list);
      perSport[sport] = tally(s.games, s.graded);
      [...new Set(list.map(r => r.league).filter(Boolean))].forEach(league => {
        const ls = summarise(list.filter(r => r.league === league));
        perLeague[`${sport}/${league}`] = tally(ls.games, ls.graded);
      });
    });
  } else {
    // Round I (item 1) — the rows subcollection is NOT loaded (production
    // Firestore startup), so derive the SETTLED-GAME counts from the durable
    // counters in `live_shadow/meta`. They are all-time (logging only began
    // after the candidate freeze, so they ARE the post-freeze window) and
    // survive a restart. Per-row detail (settled_rows) is unknown here — it is
    // produced in the one-off evaluation, where the rows are loaded.
    Object.entries(counters.settled_games_by_sport || {}).forEach(([sport, games]) => {
      if (games > 0) perSport[sport] = tally(games, null);
    });
    Object.entries(counters.settled_games_by_league || {}).forEach(([key, games]) => {
      // Round I (item 2) — the stored key is sanitised ('soccer::uefa_champions');
      // show the EXACT 'soccer/uefa.champions' from `league_labels`.
      if (games > 0) perLeague[countersLib.labelFor(counters, key)] = tally(games, null);
    });
  }

  return {
    target: goal,
    frozen_at: frozen.iso,
    frozen_at_ms: freezeMs,
    elapsed_days: round4(elapsedDays),
    // Which source the settled-game counts came from: the loaded rows, or the
    // durable counters (rows not loaded). Diagnostic only.
    counts_source: rowsComplete ? 'rows' : 'counters',
    note: 'ETA extrapolates settled games per day since the candidate freeze; null until a settled game exists.',
    per_sport: perSport,
    per_league: perLeague,
  };
}

/* ------------------------------------------------ item 3: confirmation grid */

/** The confirmation rows for a sport: shadow rows logged at/after the freeze. */
function confirmationRows(sport) {
  const freezeMs = confirmationFreeze().ms;
  return rows.filter(r => r.shadow === true && r.sport === sport
    && (freezeMs != null ? (Number.isFinite(r.at_ms) && r.at_ms >= freezeMs) : false));
}

/**
 * Phase 10 round F (item 3) — resample the confirmation rows onto the REPLAY
 * fraction grid.
 *
 * The replay scores each game at a FIXED grid of elapsed-fraction checkpoints
 * (CONFIG.liveBacktest.checkpoints.basketball.fractions: 1/8, 3/16, 1/4, 3/8,
 * ...). The live sweep logs a row whenever the clock has moved, so a live game
 * carries many more rows than the replay — the two are not directly comparable.
 * This snaps each game to the SAME grid: for every grid mark it keeps the ONE
 * live row whose elapsed fraction is nearest that mark (within `slotTolerance`),
 * so a fresh-data evaluation and the replay are scored on the same schedule.
 *
 * The grid's earliest mark is 1/8 = 12.5% of regulation. A game with NO row near
 * that mark is counted separately (`games_without_early_row`), because an unequal
 * early-row distribution is exactly the schedule artefact this resample exists to
 * catch. Counts GAMES, not rows: checkpoints inside one game share an outcome.
 *
 * @param {Array} [list] confirmation rows (shadow, post-freeze)
 * @param {Object} [opts]
 * @param {number[]} [opts.fractions] the grid; defaults to the replay's
 * @param {number} [opts.slotTolerance] how near a grid mark a row must fall
 */
function resampleToGrid(list = [], { fractions = null, slotTolerance = 0.03 } = {}) {
  const cfgGrid = CONFIG.liveBacktest && CONFIG.liveBacktest.checkpoints
    && CONFIG.liveBacktest.checkpoints.basketball
    && CONFIG.liveBacktest.checkpoints.basketball.fractions;
  const grid = (Array.isArray(fractions) && fractions.length ? fractions : (cfgGrid || [])).slice();

  const timed = (Array.isArray(list) ? list : []).filter(r => Number.isFinite(r.at_ms));
  const games = groupByGame(timed);
  const slotCounts = grid.map(() => 0);
  let withEarly = 0;
  let withoutEarly = 0;
  let snappedRows = 0;

  games.forEach(gameRows => {
    let hasEarly = false;
    grid.forEach((f, gi) => {
      let best = null;
      let bestD = Infinity;
      gameRows.forEach(r => {
        if (!Number.isFinite(r.progress)) return;
        const d = Math.abs(r.progress - f);
        if (d < bestD) { bestD = d; best = r; }
      });
      if (best && bestD <= slotTolerance) {
        slotCounts[gi] += 1;
        snappedRows += 1;
        if (gi === 0) hasEarly = true;
      }
    });
    if (hasEarly) withEarly += 1; else withoutEarly += 1;
  });

  const graded = timed.filter(r => (r.y === 0 || r.y === 1) && Number.isFinite(r.p));

  return {
    dataset: 'confirmation rows resampled to the replay elapsed-fraction grid (one nearest row per grid mark, per game)',
    grid,
    slot_tolerance: slotTolerance,
    games: games.length,
    games_with_early_row: withEarly,
    games_without_early_row: withoutEarly,
    settled_games: groupByGame(graded).length,
    snapped_rows: snappedRows,
    slot_games: grid.map((f, i) => ({ fraction: f, games: slotCounts[i] })),
  };
}

/* --------------------------------------------- item 2: per-league release */

/**
 * Phase 10 round F (item 2) — the PER-LEAGUE release verdict.
 *
 * Release is per league (CONFIG.live.perLeagueRelease): a league ships only when
 * its own confirmation data passes a minimum settled-game count, an absolute
 * calibration tolerance, and a positive log-loss gain over scoreTime. Under the
 * no-peeking protocol this exposes the PRE-REGISTERED rule and per-league COUNTS
 * only; the pass/fail verdict — which needs the calibration gap and the
 * scoreTime-gain interval — is computed ONLY once a league holds its minimum
 * settled games, so the rule cannot be read off before it may decide anything.
 *
 * A league that is not judged is explicitly WITHHELD (`judged:false`,
 * `pass:null`, `released:false`) rather than silently absent: withheld leagues
 * show score, time and context only.
 *
 * @param {string} [sport]
 * @param {Object} [opts]
 * @param {number} [opts.now]
 */
function perLeagueRelease(sport = 'basketball', { now = Date.now() } = {}) {
  ensure();
  const cfg = CONFIG.live.perLeagueRelease || {};
  const rc = releaseCriteria();
  const bootstrapCfg = rc.bootstrap || { iterations: 2000, seed: 11 };
  const minGames = Number.isFinite(cfg.minGames) ? cfg.minGames : 100;
  const calTol = Number.isFinite(cfg.calibrationTolerance) ? cfg.calibrationTolerance : 0.05;
  const minGainLower = cfg.scoreTimeGain && Number.isFinite(cfg.scoreTimeGain.minLogLossGainCiLower)
    ? cfg.scoreTimeGain.minLogLossGainCiLower
    : 0;

  const graded = confirmationRows(sport).filter(r => (r.y === 0 || r.y === 1) && Number.isFinite(r.p));
  const listed = Array.isArray(cfg.leagues) ? cfg.leagues.map(String) : [];
  const seen = [...new Set(graded.map(r => r.league).filter(Boolean))].map(String);
  const leagues = [...new Set([...listed, ...seen])];

  const perLeague = {};
  leagues.forEach(league => {
    const seg = graded.filter(r => String(r.league) === league);
    const settled = groupByGame(seg).length;
    const judged = settled >= minGames;
    let verdict = { pass: null, calibration_ok: null, calibration_gap: null, score_time_gain_ci_lower: null, score_time_gain_ok: null };
    if (judged) {
      const realised = seg.reduce((s, r) => s + r.y, 0) / seg.length;
      const meanPred = seg.reduce((s, r) => s + r.p, 0) / seg.length;
      const gap = round4(realised - meanPred);
      const calibOk = gap != null && Math.abs(gap) <= calTol;
      const bt = BT.gameBootstrap(toBootstrapRows(seg), { bootstrap: bootstrapCfg, probKey: 'p', referenceKey: 'p_score_time' });
      const gainLower = bt.logLossGain ? bt.logLossGain.lower : null;
      const gainOk = gainLower != null && gainLower >= minGainLower;
      verdict = {
        pass: Boolean(calibOk && gainOk),
        calibration_ok: calibOk,
        calibration_gap: gap,
        score_time_gain_ci_lower: gainLower,
        score_time_gain_ok: gainOk,
      };
    }
    perLeague[league] = {
      settled_games: settled,
      remaining: Math.max(minGames - settled, 0),
      min_games: minGames,
      judged,
      ...verdict,
      released: judged && verdict.pass === true,
    };
  });

  return {
    sport,
    frozen_at: cfg.frozen_at || null,
    criteria: { minGames, calibrationTolerance: calTol, scoreTimeGain: { minLogLossGainCiLower: minGainLower } },
    note: cfg.note || null,
    // The leagues actually released so far (populated only by the one-shot run).
    released: Array.isArray(cfg.released) ? cfg.released.slice() : [],
    leagues: perLeague,
  };
}

/* ------------------------------------------------- item 1: store diagnostics */

/**
 * Phase 10 round F (item 1) — shadow rows per UTC day, read from the DURABLE
 * counters (round I item 1) rather than from the in-memory rows.
 *
 * This is the shape the health block reports as `daily_since_freeze`:
 * `[{ date, rows }]`, ascending. `sinceMs` restricts to days at or after the day
 * an instant falls in (the candidate freeze, in the health block). Counts only —
 * no probability, no per-day distinct-game breakdown (the counters are day- and
 * (sport,league)-keyed, not row-keyed).
 *
 * @param {Object} [opts]
 * @param {number|null} [opts.sinceMs]
 */
function dailyCounts({ sinceMs = null } = {}) {
  ensure();
  return countersLib.buckets(counters, { sinceMs });
}

/** Rows logged in the last `ms` (default 24h) — the item-1 health count. */
function rowsLast24h({ now = Date.now(), ms = 24 * 60 * 60 * 1000 } = {}) {
  ensure();
  return countersLib.rowsLast24h(counters, { now, ms });
}

/** The earliest row's ISO time, from the durable counters (null until one lands). */
function firstRowAt() {
  ensure();
  return counters.first_row_at || null;
}

/** The latest row's ISO time, from the durable counters (null until one lands). */
function lastRowAt() {
  ensure();
  return counters.last_row_at || null;
}

/**
 * Round J (item 3) — await the startup hydrate so a caller can build a
 * CONSISTENT view (status + confirmation + progress) from one hydration state.
 * Resolves immediately on the file backend (no async read) and after the meta
 * read lands on Firestore. Never rejects.
 */
function ready() {
  ensure();
  return hydratePromise || Promise.resolve();
}

/** Read-only view for the stats/diagnostics surface. */
function status() {
  ensure();
  return {
    enabled: FWD.enabled !== false,
    file: FWD.file,
    rows: rows.length,
    shadowRows: rows.filter(r => r.shadow === true).length,
    // Round I (item 1) — the durable counts, available even when the rows are
    // not loaded (Firestore): total rows ever written and the first/last times.
    total_rows: countersLib.totalRows(counters),
    first_row_at: counters.first_row_at || null,
    last_row_at: counters.last_row_at || null,
    // Phase 10 round D — the candidate freeze instant the confirmation dataset
    // accrues from, surfaced so a reader can see when the clock started.
    candidates_version: shadowCandidates.version(),
    candidates_frozen_at: confirmationFreeze().iso,
    candidates_frozen_at_ms: confirmationFreeze().ms,
    benchmarkLogLoss: Number.isFinite(benchmarkLogLoss) ? round4(benchmarkLogLoss) : null,
    // Phase 9 freeze: the criteria id in force and the calibrator version the
    // shadow run was frozen under (null until the first shadow row lands). The
    // prior id is the frozen id amendment 1 superseded.
    criteria_id: criteriaId(),
    criteria_id_prior: priorCriteriaId(),
    shadow_criteria_id: criteriaSnapshot ? criteriaSnapshot.id : null,
    shadow_calibrator_id: shadowCalibratorId || null,
    updatedAt,
  };
}

/** Test/dev helper — drop everything and reload from disk on next use. */
function reset({ benchmarkLogLoss: bench = undefined } = {}) {
  rows = [];
  benchmarkLogLoss = bench !== undefined ? bench : null;
  criteriaSnapshot = null;
  shadowCalibratorId = null;
  updatedAt = null;
  loaded = false;
  dirty = false;
  lastWrite = 0;
  batchDepth = 0;
  hydratePromise = null;
  verdicts.clear();
  pendingRows.clear();
  // Round I (item 1) — drop the in-memory counters and the not-yet-persisted
  // delta too, so a reset starts from a blank slate exactly like the rows.
  counters = countersLib.blank();
  countersDelta = countersLib.blank();
  countersFirstApplied = false;
  rowsComplete = false;
}

module.exports = {
  init,
  recordServed,
  settle,
  summarise,
  lastLoggedAt,
  evaluate,
  isDisabled,
  shadowSummary,
  confirmationSummary,
  confirmationMinGames,
  confirmationFreeze,
  confirmationRows,
  progress,
  resampleToGrid,
  perLeagueRelease,
  dailyCounts,
  rowsLast24h,
  firstRowAt,
  lastRowAt,
  status,
  // Round J (item 3) — await the async startup hydrate before building a
  // consistent view (status + confirmation + progress) on the stats surface.
  ready,
  flush,
  // Round I (item 3) — the sweep opens ONE batch and closes it once, so the whole
  // sweep's rows + counters land in a single meta-document write.
  beginBatch,
  endBatch,
  // Round I (item 1) — the recount the one-off evaluation uses instead of the
  // maintained counters (backend-agnostic; Firestore uses count() aggregation).
  reconcile: (opts = {}) => store.reconcile(opts),
  reset,
  groupByGame,
  resolveFile,
  // Phase 10 round G (item 1) — where the evidence actually lives (storage
  // adapter kind + paths), for the /live/stats health block.
  storage: () => store.describe(),
  criteriaId,
  priorCriteriaId,
  releaseCriteria,
};
