/**
 * live/store/index.js
 *
 * Phase 10 round G — the storage selector.
 *
 * Shadow rows, settle outcomes, health state and the evaluation ledger all
 * persist through ONE interface with two implementations chosen by CONFIG
 * (live.store.kind, or LIVE_STORE_KIND):
 *
 *   - 'file'      → services/live/store/fileStore   (tests and local dev)
 *   - 'firestore' → services/live/store/firestoreStore (production)
 *
 * The interface:
 *   kind                       'file' | 'firestore'
 *   supportsSync               true when reads are synchronous (file)
 *   describe()                 where the data actually lives (for /live/stats)
 *   readRowsSync({file})       file only: {rows, benchmarkLogLoss, ...}
 *   readMeta()                 meta + AGGREGATE COUNTERS (startup path; the
 *                              file backend also returns its whole local set,
 *                              flagged `rows_complete`)
 *   readRowsForGame(gameId)    one game's rows (settlement after a restart)
 *   readRows()                 Promise of the full row set — ONE-OFF EVAL ONLY
 *   flush({rows, meta, pending, countersDelta}) persist rows + meta + counters
 *   readHealth()               Promise|state of the durable health document
 *   writeHealth(state)         persist the health document
 *   readLedger() / writeLedger(ledger)
 *
 * Round I (item 1): `readMeta()` returns the compact counters kept in the meta
 * document (rows per day, settled games per sport and league, first/last row
 * time) so startup never loads the whole `rows` subcollection; `readRows()` is
 * reserved for the one-off confirmation evaluation. `readRowsForGame()` bounds
 * an after-restart settlement to a single game's rows.
 *
 * Every read result carries `rows_complete`: true only when the returned rows
 * are the WHOLE set (the file backend, or a `readRows()` full load). The
 * Firestore startup meta read is `false`, which is how forwardTest knows to
 * derive its counts-only surfaces from the counters instead of the empty rows.
 *
 * Nothing here throws at require time: a missing firebase-admin or an
 * uninitialized app surfaces when the store is actually used, never at startup.
 */

const CONFIG = require('../config');
const grid = require('./grid');
const fileStore = require('./fileStore');
const firestoreStore = require('./firestoreStore');

const S = (CONFIG.live && CONFIG.live.store) || {};

/** The configured kind, read at call time so a test can flip it. */
function configuredKind() {
  const kind = (CONFIG.live && CONFIG.live.store && CONFIG.live.store.kind) || 'file';
  return String(kind).toLowerCase() === 'firestore' ? 'firestore' : 'file';
}

let cached = null;

/** The active store adapter (cached per kind; recreated when the kind changes). */
function getStore({ kind = null } = {}) {
  const k = kind ? (String(kind).toLowerCase() === 'firestore' ? 'firestore' : 'file') : configuredKind();
  if (cached && cached.kind === k) return cached;
  cached = k === 'firestore' ? firestoreStore : fileStore;
  return cached;
}

/** Test/dev helper — forget the cached adapter. */
function resetStore() { cached = null; }

/** Where the evidence lives right now (used by the health block). */
function describe(opts = {}) {
  return getStore(opts).describe();
}

/**
 * Round I (item 1) — recount the rows and compare with the durable counters.
 * Backend-agnostic: Firestore uses `count()` aggregation per (sport, league);
 * the file backend derives it from its local rows. The one-off confirmation
 * evaluation calls this so a released pick rests on a number RECOUNTED from the
 * evidence, never on the maintained counters.
 */
function reconcile(opts = {}) {
  const st = getStore(opts);
  return typeof st.reconcile === 'function' ? st.reconcile(opts) : null;
}

module.exports = { getStore, resetStore, describe, reconcile, configuredKind, grid };
