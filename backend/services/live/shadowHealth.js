/**
 * live/shadowHealth.js
 *
 * Phase 10 round F — persistent health state for the shadow sweep.
 *
 * The sweep runs inside the web process on a node-cron tick (see
 * services/live/shadowScheduler). Until round F it kept no record of whether it
 * had run: a host that has gone to sleep, a process that restarted, and a
 * matcher that throws on every tick all looked exactly like a quiet, healthy
 * scheduler — the forward log simply stopped growing and nothing said why.
 *
 * Round G (item 3): the state persists through the SAME storage adapter as the
 * rows (file in tests/dev, Firestore in production), so a COLD START does not
 * reset it — `readSnapshot()` reads the durable document rather than the
 * in-memory copy. That is what lets /api/live/stats keep reporting the truth
 * after the free-tier host has slept and woken.
 *
 * It NEVER throws: a health read/write failure must never be able to break a
 * sweep or a diagnostics request.
 */

const path = require('path');

const CONFIG = require('./config');
const store = require('./store');

const H = (CONFIG.live && CONFIG.live.health) || {};
const BACKEND_DIR = path.join(__dirname, '..', '..');

let file = H.file;
let state = null;
let loaded = false;
// Round J (item 5) — the in-flight durable health write. `persist()` is
// deliberately fire-and-forget on the hot sweep path (a health write must never
// slow a sweep), but the RECONCILE job must not report until its result is
// COMMITTED, so it awaits this (see persistReady()).
let lastPersist = null;

/** Resolve the config-relative health file to an absolute one (file backend). */
function resolveFile(f = file) {
  if (!f) return null;
  return path.isAbsolute(f) ? f : path.join(BACKEND_DIR, f);
}

function blank() {
  return {
    started_at: null,
    started_at_ms: null,
    // Last sweep: when it began, when it finished, how long it took.
    last_sweep_started_at: null,
    last_sweep_started_at_ms: null,
    last_sweep_finished_at: null,
    last_sweep_finished_at_ms: null,
    last_sweep_duration_ms: null,
    // Lifetime counters for THIS process (the document is rewritten each sweep).
    sweeps: 0,
    errors: 0,
    last_error: null,
    // The last sweep's own tally: {sports, live_games, logged, settled}.
    last_sweep_stats: null,
    // When a sweep last LOGGED a row / SAW a live game / SETTLED a game.
    last_row_logged_at: null,
    last_row_logged_at_ms: null,
    last_live_games_at: null,
    last_live_games_at_ms: null,
    last_settle_at: null,
    last_settle_at_ms: null,
    // Round J (item 5) — the DAILY RECONCILE. The counters in `live_shadow/meta`
    // are a cache; the rows are the truth. A reconcile recounts the rows and
    // compares; the drift (counts only) is recorded here so /api/live/stats
    // surfaces it and ALERTS on any non-zero delta.
    last_reconcile_at: null,
    last_reconcile_at_ms: null,
    last_reconcile_drift: null,
    last_reconcile_drift_detected: false,
    last_reconcile_source: null,
    last_reconcile_error: null,
  };
}

function load() {
  if (loaded) return state;
  loaded = true;
  const st = store.getStore();
  if (st.supportsSync) {
    let raw = null;
    try { raw = st.readHealth({ file }); } catch (err) { raw = null; }
    state = Object.assign(blank(), raw && typeof raw === 'object' ? raw : {});
  } else {
    // Firestore (production): no synchronous read. Start blank and hydrate when
    // the async read lands — unless this process has already recorded a sweep,
    // in which case the local state is the newer truth.
    state = blank();
    Promise.resolve(st.readHealth())
      .then(raw => {
        if (state && !state.last_sweep_finished_at_ms) {
          state = Object.assign(blank(), raw && typeof raw === 'object' ? raw : {});
        }
      })
      .catch(() => {});
  }
  return state;
}

function ensure() {
  if (!loaded) load();
}

function persist() {
  ensure();
  const st = store.getStore();
  try {
    const res = st.writeHealth(state, { file });
    // Track the async (Firestore) write so a caller that needs it committed can
    // await persistReady(); the file backend returns synchronously and is a no-op.
    if (res && typeof res.then === 'function') lastPersist = res.catch(() => false);
    return res;
  } catch (err) {
    // A health write must never break the sweep it is describing.
    return false;
  }
}

/**
 * Round J (item 5) — await the last durable health write.
 *
 * The reconcile job AWAITS this before it reports: /api/live/stats reads the
 * durable health document, so a reconcile whose write is still in flight would
 * surface a stale (or missing) result. Resolves immediately on the file backend
 * and when nothing has been written.
 *
 * @returns {Promise<void>}
 */
function persistReady() {
  return lastPersist || Promise.resolve();
}

/** Load (once) the health document; idempotent and safe to call at startup. */
function init({ file: f = H.file } = {}) {
  file = f;
  state = null;
  loaded = false;
  return load();
}

/** Stamp the process start time the first time the scheduler runs. */
function markStarted(now = Date.now()) {
  ensure();
  if (!state.started_at_ms) {
    state.started_at = new Date(now).toISOString();
    state.started_at_ms = now;
    persist();
  }
  return state.started_at;
}

/** Record the start of one sweep; returns the start instant for the duration. */
function recordSweepStart(now = Date.now()) {
  ensure();
  state.last_sweep_started_at = new Date(now).toISOString();
  state.last_sweep_started_at_ms = now;
  // No persist here: the completed sweep (or its error) is what matters, and one
  // durable write per sweep keeps the write volume low.
  return now;
}

/**
 * Record a completed sweep and its tally.
 *
 * @param {Object} args
 * @param {number} [args.startedMs] the instant recordSweepStart returned
 * @param {Object} [args.stats] {sports, live_games, logged, settled}
 * @param {number} [args.now]
 */
function recordSweepDone({ startedMs = null, stats = null, now = Date.now() } = {}) {
  ensure();
  state.sweeps = (state.sweeps || 0) + 1;
  state.last_sweep_finished_at = new Date(now).toISOString();
  state.last_sweep_finished_at_ms = now;
  if (Number.isFinite(startedMs)) state.last_sweep_duration_ms = Math.max(now - startedMs, 0);
  if (stats) {
    state.last_sweep_stats = {
      sports: Array.isArray(stats.sports) ? stats.sports : [],
      live_games: Number(stats.live_games) || 0,
      logged: Number(stats.logged) || 0,
      settled: Number(stats.settled) || 0,
      truncated: stats.truncated === true,
    };
    if (state.last_sweep_stats.live_games > 0) {
      state.last_live_games_at = new Date(now).toISOString();
      state.last_live_games_at_ms = now;
    }
    if (state.last_sweep_stats.logged > 0) {
      state.last_row_logged_at = new Date(now).toISOString();
      state.last_row_logged_at_ms = now;
    }
    if (state.last_sweep_stats.settled > 0) {
      state.last_settle_at = new Date(now).toISOString();
      state.last_settle_at_ms = now;
    }
  }
  persist();
  return state;
}

/** Record a failed sweep. Kept as a counter plus the LAST error. */
function recordError(err, now = Date.now()) {
  ensure();
  state.errors = (state.errors || 0) + 1;
  state.last_error = {
    at: new Date(now).toISOString(),
    at_ms: now,
    message: (err && err.message) ? String(err.message) : String(err || 'unknown error'),
  };
  persist();
  return state.last_error;
}

/**
 * Round J (item 5) — record the result of a RECONCILE (counters vs a recount of
 * the rows). Only COUNTS are stored: the recount never carries a probability.
 * `detected` is what `computeSnapshot` turns into the `counter_drift` alert.
 *
 * @param {Object} args
 * @param {Object} [args.result] the store.reconcile() result
 * @param {Object} [args.drift] result.drift
 * @param {boolean} [args.detected] result.drift_detected
 * @param {number} [args.now]
 */
function recordReconcile({ result = null, drift = null, detected = false, now = Date.now() } = {}) {
  ensure();
  state.last_reconcile_at = new Date(now).toISOString();
  state.last_reconcile_at_ms = now;
  state.last_reconcile_drift = drift || (result && result.drift) || null;
  state.last_reconcile_drift_detected = Boolean(detected || (result && result.drift_detected));
  state.last_reconcile_source = (result && result.source) || null;
  // A clean recount clears a prior reconcile error; a drifted one is not an
  // error, it is the answer.
  state.last_reconcile_error = null;
  persist();
  return state;
}

/** Round J (item 5) — record a reconcile that could not complete (kept, never thrown). */
function recordReconcileError(err, now = Date.now()) {
  ensure();
  state.last_reconcile_error = {
    at: new Date(now).toISOString(),
    at_ms: now,
    message: (err && err.message) ? String(err.message) : String(err || 'unknown error'),
  };
  persist();
  return state.last_reconcile_error;
}

/**
 * A one-line summary of a drift object for the alert reason: only the NON-ZERO
 * deltas, so a clean recount reads as empty and a drift names exactly what
 * disagreed (counts only).
 */
function summariseDrift(drift) {
  if (!drift) return 'drift detected';
  const parts = [];
  const tr = drift.total_rows;
  if (tr && Number(tr.delta)) parts.push(`total rows ${tr.counters} vs ${tr.recount} (delta ${tr.delta})`);
  ['settled_games_by_sport', 'settled_games_by_league'].forEach(group => {
    Object.entries(drift[group] || {}).forEach(([key, d]) => {
      if (d && Number(d.delta)) parts.push(`${group}:${key} ${d.counters} vs ${d.recount} (delta ${d.delta})`);
    });
  });
  return parts.length ? parts.join('; ') : 'drift detected';
}

/**
 * Derive the read-only health view from a state object.
 *
 * `running` answers "is the sweep actually ticking?" from the age of the last
 * completed sweep. `alert` is the one-line actionable state: the durable
 * counters DISAGREE with a recount of the rows (round J item 5 — a correctness
 * fault, highest priority), the scheduler never ran, has gone stale, or is
 * ticking while live games are being served but no shadow row is landing.
 * Computed here (not stored) so it reflects the moment it is read.
 */
function computeSnapshot(s, now = Date.now()) {
  const st = s || blank();
  const staleMs = Number.isFinite(H.staleAfterMs) ? H.staleAfterMs : 15 * 60 * 1000;
  const liveWindowMs = Number.isFinite(H.liveWindowMs) ? H.liveWindowMs : 6 * 60 * 60 * 1000;
  const noRowAlertMs = Number.isFinite(H.noRowAlertMs) ? H.noRowAlertMs : 6 * 60 * 60 * 1000;

  const lastSweepMs = st.last_sweep_finished_at_ms || st.last_sweep_started_at_ms || null;
  const sweepAgeMs = lastSweepMs != null ? Math.max(now - lastSweepMs, 0) : null;
  const rowAgeMs = st.last_row_logged_at_ms != null ? Math.max(now - st.last_row_logged_at_ms, 0) : null;
  const liveAgeMs = st.last_live_games_at_ms != null ? Math.max(now - st.last_live_games_at_ms, 0) : null;
  const settleAgeMs = st.last_settle_at_ms != null ? Math.max(now - st.last_settle_at_ms, 0) : null;
  const reconcileAgeMs = st.last_reconcile_at_ms != null ? Math.max(now - st.last_reconcile_at_ms, 0) : null;

  const running = lastSweepMs != null && sweepAgeMs <= staleMs;
  const driftDetected = st.last_reconcile_drift_detected === true;

  let alert = { active: false, kind: null, reason: null };
  if (driftDetected) {
    // Round J (item 5) — the counters are a cache and the rows are the truth; a
    // non-zero recount delta is a data-integrity fault, so it outranks the
    // flowing-data alerts below.
    alert = {
      active: true,
      kind: 'counter_drift',
      reason: 'the durable counters disagree with a recount of the rows: ' + summariseDrift(st.last_reconcile_drift),
    };
  } else if (lastSweepMs == null) {
    alert = { active: true, kind: 'never_ran', reason: 'the shadow sweep has never run' };
  } else if (!running) {
    alert = {
      active: true,
      kind: 'scheduler_stale',
      reason: `the shadow sweep last ran ${Math.round(sweepAgeMs / 60000)} min ago (stale after ${Math.round(staleMs / 60000)} min): the scheduler is not ticking`,
    };
  } else if (liveAgeMs != null && liveAgeMs <= liveWindowMs && (rowAgeMs == null || rowAgeMs > noRowAlertMs)) {
    alert = {
      active: true,
      kind: 'no_rows_while_live',
      reason: rowAgeMs == null
        ? 'live games were seen but no shadow row has been logged at all'
        : `live games were seen within ${Math.round(liveWindowMs / 3600000)}h but no shadow row has been logged for ${Math.round(rowAgeMs / 3600000)}h`,
    };
  }

  return {
    running,
    ...st,
    sweep_age_ms: sweepAgeMs,
    row_age_ms: rowAgeMs,
    live_games_age_ms: liveAgeMs,
    settle_age_ms: settleAgeMs,
    stale_after_ms: staleMs,
    no_row_alert_ms: noRowAlertMs,
    // Round J (item 5) — the last reconcile: when it ran, whether it found drift,
    // the drift itself (counts only) and any reconcile error. Surfaced beside the
    // alert so a reader can see the evidence behind a `counter_drift` alert.
    reconcile: {
      last_at: st.last_reconcile_at || null,
      last_at_ms: st.last_reconcile_at_ms != null ? st.last_reconcile_at_ms : null,
      age_ms: reconcileAgeMs,
      drift_detected: driftDetected,
      drift: st.last_reconcile_drift || null,
      source: st.last_reconcile_source || null,
      last_error: st.last_reconcile_error || null,
    },
    alert,
  };
}

/** The health view from the in-memory copy (internal / tests). */
function snapshot({ now = Date.now() } = {}) {
  ensure();
  return computeSnapshot(state, now);
}

/**
 * The health view from DURABLE storage (round G item 3). A cold start must not
 * reset it, so this reads the storage adapter rather than the in-memory copy.
 *
 * @returns {Promise<Object>} the same shape as snapshot()
 */
async function readSnapshot({ now = Date.now() } = {}) {
  const st = store.getStore();
  let raw = null;
  try {
    raw = st.supportsSync ? st.readHealth({ file }) : await st.readHealth();
  } catch (err) {
    raw = null;
  }
  const durable = Object.assign(blank(), raw && typeof raw === 'object' ? raw : {});
  return computeSnapshot(durable, now);
}

/** Test/dev helper — drop the in-memory state; reload on next use. */
function reset() {
  state = null;
  loaded = false;
  lastPersist = null;
}

module.exports = {
  init,
  markStarted,
  recordSweepStart,
  recordSweepDone,
  recordError,
  recordReconcile,
  recordReconcileError,
  persistReady,
  snapshot,
  readSnapshot,
  reset,
  resolveFile,
  blank,
};
