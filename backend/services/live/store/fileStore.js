/**
 * live/store/fileStore.js
 *
 * Phase 10 round G — the FILE storage backend (tests and local dev).
 *
 * Shadow rows, health state and the ledger are JSON files beside the backend,
 * exactly the paths they used before this adapter existed, so the committed
 * artifacts, the frozen candidate ids and the criteria id do not move.
 *
 * Every method resolves its path AT CALL TIME, so a test that redirects
 * CONFIG.live.forwardTest.file (or health.file) takes effect immediately.
 * Operations are synchronous — local JSON is cheap — but the interface accepts
 * them wherever a backend may be asynchronous.
 *
 * Health and ledger writes never throw: a failed write must not break the sweep
 * it describes. Row writes DO report failure (the caller decides what to do).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG = require('../config');
const countersLib = require('./counters');

const BACKEND_DIR = path.join(__dirname, '..', '..', '..');

/**
 * Round H (item 1) — TEST ISOLATION GUARD.
 *
 * The committed evidence lives under backend/data/ (live-forward.json,
 * live-shadow-health.json, live-ledger.json). A single test that forgets to
 * redirect its config would otherwise append SYNTHETIC rows to the real forward
 * log / health / ledger — which is exactly how the committed evidence was
 * polluted before round G's redirects went in.
 *
 * So whenever NODE_ENV=test, any store path that resolves INSIDE backend/data/
 * is silently redirected into a per-process temp directory, keeping the
 * basename so rows, health and ledger stay distinct:
 *
 *   backend/data/live-forward.json  ->  <tmp>/apex-live-test-<pid>/live-forward.json
 *
 * A test that already points its config at its own temp file is unaffected (it
 * is not under data/), so the per-file isolation the live suites rely on is
 * preserved; the guard only catches the dangerous DEFAULT. It applies to every
 * read and write, because every operation resolves its path here at call time.
 */
const IS_TEST = process.env.NODE_ENV === 'test';
const DATA_DIR = path.join(BACKEND_DIR, 'data');
const TEST_ROOT = path.join(os.tmpdir(), `apex-live-test-${process.pid}`);

/** Redirect a target inside backend/data/ to the per-process test temp dir. */
function guardTestPath(target) {
  if (!IS_TEST || !target) return target;
  const rel = path.relative(DATA_DIR, target);
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  return inside ? path.join(TEST_ROOT, path.basename(target)) : target;
}

function resolve(file) {
  if (!file) return null;
  const target = path.isAbsolute(file) ? file : path.join(BACKEND_DIR, file);
  return guardTestPath(target);
}

function rowsFile(opts = {}) {
  return (opts && opts.file) || CONFIG.live.forwardTest.file;
}

function healthFile(opts = {}) {
  const H = CONFIG.live.health || {};
  return (opts && opts.file) || H.file;
}

function ledgerFile(opts = {}) {
  const S = (CONFIG.live && CONFIG.live.store) || {};
  const L = S.ledger || {};
  return (opts && opts.file) || L.file || 'data/live-ledger.json';
}

function readJson(file, fallback = null) {
  const target = resolve(file);
  if (!target) return fallback;
  try {
    const json = JSON.parse(fs.readFileSync(target, 'utf8'));
    return json && typeof json === 'object' ? json : fallback;
  } catch (err) {
    return fallback;
  }
}

function writeJson(file, value) {
  const target = resolve(file);
  if (!target) return false;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(value));
    return true;
  } catch (err) {
    return false;
  }
}

/** {rows, benchmarkLogLoss, criteria, shadowCalibratorId, updatedAt}. */
function readRowsSync(opts = {}) {
  const json = readJson(rowsFile(opts), null);
  const p = json || {};
  return {
    rows: Array.isArray(p.rows) ? p.rows : [],
    benchmarkLogLoss: Number.isFinite(p.benchmarkLogLoss) ? p.benchmarkLogLoss : null,
    criteria: p.criteria || null,
    shadowCalibratorId: p.shadow_calibrator_id || null,
    updatedAt: p.updatedAt || null,
    // The local file holds the WHOLE (bounded) row set, so a caller that reads
    // it has every row. The Firestore startup meta read is the one that is NOT
    // complete; `rows_complete` lets forwardTest tell the two apart (round I
    // item 1) so counts-only surfaces derive from the counters there instead of
    // wrongly reporting zero.
    rows_complete: true,
  };
}

/**
 * Write the whole row snapshot plus its meta. Synchronous; the file is bounded
 * by forwardTest.maxRows, so a full rewrite stays cheap.
 */
function flush({ rows = [], meta = {}, file = null } = {}) {
  const payload = {
    benchmarkLogLoss: Number.isFinite(meta.benchmarkLogLoss) ? meta.benchmarkLogLoss : null,
    criteria: meta.criteria || null,
    shadow_calibrator_id: meta.shadow_calibrator_id || null,
    updatedAt: new Date().toISOString(),
    rows: Array.isArray(rows) ? rows : [],
  };
  return writeJson(file || CONFIG.live.forwardTest.file, payload);
}

/**
 * The startup read (round I item 1): `forwardTest.init()` calls this instead of
 * a full load so a backend whose rows grow with the collection does not have to
 * read them all. The FILE backend is local and bounded (forwardTest.maxRows), so
 * it simply returns its rows WHOLE and derives the counters from them; the
 * Firestore backend overrides this with a counters-only meta read.
 *
 * `rows_complete: true` tells forwardTest these rows are the FULL set (unlike
 * the Firestore meta read), so the counts-only surfaces may use the rows
 * directly.
 */
function readMeta(opts = {}) {
  const snap = readRowsSync(opts);
  return {
    rows: Array.isArray(snap.rows) ? snap.rows : [],
    benchmarkLogLoss: snap.benchmarkLogLoss,
    criteria: snap.criteria,
    shadowCalibratorId: snap.shadowCalibratorId,
    updatedAt: snap.updatedAt,
    counters: countersLib.fromRows(snap.rows),
    rows_complete: true,
  };
}

/** Read only ONE game's rows (settlement after a restart); local filter here. */
function readRowsForGame(gameId, opts = {}) {
  if (gameId == null) return [];
  return readRowsSync(opts).rows.filter(r => r.game_id === gameId);
}

function readHealth(opts = {}) {
  return readJson(healthFile(opts), null);
}

function writeHealth(state, opts = {}) {
  // A health write must never break the sweep it is describing.
  const target = resolve(healthFile(opts));
  if (!target) return false;
  return writeJson(target, state);
}

function readLedger(opts = {}) {
  return readJson(ledgerFile(opts), null);
}

function writeLedger(ledger, opts = {}) {
  const target = resolve(ledgerFile(opts));
  if (!target) return false;
  return writeJson(target, ledger);
}

function describe() {
  // Report the EFFECTIVE (guarded) paths — what would actually be written — so
  // /live/stats tells the truth about where the evidence lands.
  return {
    kind: 'file',
    test_isolated: IS_TEST,
    rows_file: resolve(CONFIG.live.forwardTest.file),
    rows_absolute: resolve(CONFIG.live.forwardTest.file),
    health_file: resolve(healthFile()),
    ledger_file: resolve(ledgerFile()),
    note: IS_TEST
      ? 'File backend (TEST): paths under backend/data/ are redirected to a per-process temp directory so a test run can never touch the committed evidence.'
      : 'File backend: shadow rows, health and the ledger are backend-local JSON files (tests/dev only — they do not survive an ephemeral host disk).',
  };
}

/**
 * Round I (item 1) — the RECOUNT, with the same shape as the Firestore
 * backend's `count()`-based reconcile, so the one-off evaluation can call ONE
 * method whichever backend is active. The file backend holds its whole (bounded)
 * row set locally, so the recount is simply derived from those rows and can
 * never drift from the counters (which are derived from the same rows).
 */
async function reconcile(opts = {}) {
  const rows = readRowsSync(opts).rows;
  const recounted = countersLib.fromRows(rows);
  const stored = recounted; // derived from the same rows — by construction equal

  const pairs = new Map();
  rows.forEach(r => {
    if (!r || !r.sport || !r.league) return;
    const key = countersLib.leagueKey(r.sport, r.league);
    if (!key) return;
    const entry = pairs.get(key) || { sport: r.sport, league: r.league, rows: 0, games: new Set() };
    entry.rows += 1;
    if ((r.y === 0 || r.y === 1) && r.game_id != null) entry.games.add(String(r.game_id));
    pairs.set(key, entry);
  });

  const totalRows = countersLib.totalRows(recounted);
  const perLeague = [...pairs.entries()].map(([key, e]) => ({
    sport: e.sport, league: e.league, rows: e.rows, settled_games: e.games.size, counter_key: key,
  }));

  const drift = {
    total_rows: { counters: countersLib.totalRows(stored), recount: totalRows, delta: countersLib.totalRows(stored) - totalRows },
    settled_games_by_sport: {},
    settled_games_by_league: {},
  };
  Object.keys({ ...stored.settled_games_by_sport, ...recounted.settled_games_by_sport }).forEach(sport => {
    const c = Number(stored.settled_games_by_sport[sport]) || 0;
    const r = Number(recounted.settled_games_by_sport[sport]) || 0;
    drift.settled_games_by_sport[sport] = { counters: c, recount: r, delta: c - r };
  });
  Object.keys({ ...stored.settled_games_by_league, ...recounted.settled_games_by_league }).forEach(key => {
    const c = Number(stored.settled_games_by_league[key]) || 0;
    const r = Number(recounted.settled_games_by_league[key]) || 0;
    drift.settled_games_by_league[key] = { label: countersLib.labelFor(stored, key), counters: c, recount: r, delta: c - r };
  });

  const hasDrift = drift.total_rows.delta !== 0;
  return {
    source: 'file rows recount (the file backend holds the whole set locally)',
    collection: resolve(CONFIG.live.forwardTest.file),
    total_rows: { counters: countersLib.totalRows(stored), recount: totalRows },
    per_league: perLeague,
    drift,
    drift_detected: hasDrift,
  };
}

module.exports = {
  kind: 'file',
  supportsSync: true,
  testIsolated: IS_TEST,
  testRoot: TEST_ROOT,
  describe,
  readRowsSync,
  readRows: readRowsSync,           // async callers may await the sync result
  readMeta,
  readRowsForGame,
  flush,
  reconcile,
  readHealth,
  writeHealth,
  readLedger,
  writeLedger,
  resolve,
  guardTestPath,
};
