/**
 * live/store/firestoreStore.js
 *
 * Phase 10 round G — the FIRESTORE storage backend (production).
 *
 * Uses the EXISTING Firebase admin setup (server.js initialises it from
 * FIREBASE_SERVICE_ACCOUNT_JSON or ./serviceAccountKey.json). One collection
 * (CONFIG.live.store.firestore.collection, default `live_shadow`) holds a meta
 * document, a health document, a ledger document and a `rows` subcollection.
 *
 * A row's DOCUMENT ID IS its idempotency key (grid.storageKey), so a retry or a
 * double sweep SETS the same document instead of appending a second row — the
 * whole point of moving off the local file: the evidence survives a sleeping
 * host and its ephemeral disk.
 *
 * Never deletes rows (old evidence is the product here); the grid keying bounds
 * the collection to <= 11 rows per game anyway. Anything that fails is surfaced
 * to the caller rather than swallowed, except health/ledger writes, which must
 * never break the sweep they describe.
 */

const CONFIG = require('../config');
const grid = require('./grid');
const countersLib = require('./counters');

const S = (CONFIG.live && CONFIG.live.store) || {};
const FS = S.firestore || {};
const BATCH_LIMIT = 400; // Firestore allows 500 writes per commit; leave headroom.

function getAdmin() {
  let admin;
  try {
    admin = require('firebase-admin');
  } catch (err) {
    throw new Error('firebase-admin is not installed (required for the Firestore store)');
  }
  if (!admin.apps || admin.apps.length === 0) {
    throw new Error('Firebase admin is not initialized (set FIREBASE_SERVICE_ACCOUNT_JSON or add serviceAccountKey.json)');
  }
  return admin;
}

function getDb() {
  return getAdmin().firestore();
}

function collectionName() {
  return FS.collection || 'live_shadow';
}
function rowsCollection() {
  return (FS.rowsSubcollection || 'rows');
}
function rowsParentDoc() {
  return (FS.rowsParentDoc || 'container');
}
function metaDocId() { return FS.metaDoc || 'meta'; }
function healthDocId() { return FS.healthDoc || 'health'; }
function ledgerDocId() { return FS.ledgerDoc || 'ledger'; }

/** A Firestore doc id must not contain '/'; the storage key uses '|'. */
function docIdFor(row) {
  const key = grid.storageKey(row);
  return key == null ? null : key.replace(/\//g, '_');
}

/**
 * Round J (item 3) — the settlement columns. An unsettled re-log must never
 * erase an outcome that is ALREADY stored: after a restart the same grid
 * checkpoint looks new to the in-memory nearest-wins check, and a provider can
 * even re-report a settled game as live. Excluding these from the overwrite's
 * field mask keeps the authoritative outcome (`y`), its time and the final score
 * on the document while every other column is refreshed.
 */
const SETTLEMENT_FIELDS = ['y', 'settled_at', 'final_home', 'final_away'];

/** True once a row has been graded with a final score. */
function rowIsSettled(row) {
  return !!(row && row.settled_at != null);
}

/** The field mask for an unsettled overwrite: every key EXCEPT the outcome. */
function unsettledFields(row) {
  const keys = Object.keys(row || {}).filter(k => !SETTLEMENT_FIELDS.includes(k));
  // A field mask may never be empty; fall back to the whole row if it would be.
  return keys.length ? keys : Object.keys(row || {});
}

/** The slash path of the rows subcollection (odd segment count = a collection). */
function rowsPath() {
  return `${collectionName()}/${rowsParentDoc()}/${rowsCollection()}`;
}

/**
 * The rows SUBCOLLECTION reference: `live_shadow/<rowsParentDoc>/rows`.
 *
 * A Firestore CollectionReference has NO `.collection()`; a subcollection must
 * be reached through a DOCUMENT reference (`.doc(id).collection(name)`) or a
 * slash path with an ODD number of segments. Passing
 * `live_shadow/container/rows` (3 segments) yields a valid collection whose
 * documents are keyed by the idempotency key. The parent `container` document is
 * never written, so it holds no data and never shows up in a listing of
 * `live_shadow`; it exists only to own the subcollection. The security rule
 * `live_shadow/{document=**}` already denies all client access to this path.
 */
function rowsRef(db = null) {
  return (db || getDb()).collection(rowsPath());
}

/** Coerce a stored counters object into the fully-shaped, defensive form. */
function normalizeCounters(raw) {
  const c = countersLib.blank();
  if (raw && typeof raw === 'object') countersLib.mergeInto(c, raw);
  return c;
}

/**
 * Read ONLY the `meta` document (1 read): the calibrator/criteria/benchmark
 * pointers plus the AGGREGATE COUNTERS. This is what `forwardTest.init()` uses at
 * startup — it deliberately does NOT touch the `rows` subcollection, so the
 * startup cost is O(1) instead of O(rows).
 */
async function readMeta() {
  const db = getDb();
  let meta = {};
  try {
    const snap = await db.collection(collectionName()).doc(metaDocId()).get();
    meta = (snap.exists && snap.data()) || {};
  } catch (err) {
    meta = {};
  }
  return {
    rows: [],
    rows_complete: false,
    benchmarkLogLoss: Number.isFinite(meta.benchmarkLogLoss) ? meta.benchmarkLogLoss : null,
    criteria: meta.criteria || null,
    shadowCalibratorId: meta.shadow_calibrator_id || null,
    updatedAt: meta.updatedAt || null,
    counters: normalizeCounters(meta.counters),
  };
}

/**
 * Read ONLY one game's rows (<= 11 grid documents). Settlement after a restart
 * needs the finished game's rows, but loading the whole subcollection to get
 * them would defeat the point of the counters; this query is bounded by the grid
 * and costs one read per stored row of that single game.
 */
async function readRowsForGame(gameId) {
  if (gameId == null) return [];
  const db = getDb();
  const col = rowsRef(db);
  const snap = await col.where('game_id', '==', gameId).get();
  const out = [];
  snap.forEach(doc => { const d = doc.data(); if (d && typeof d === 'object') out.push(d); });
  return out;
}

/**
 * Read the WHOLE rows subcollection plus meta. Retained ONLY for the one-off
 * confirmation evaluation (backend/scripts/run-live-phase10-report.js), which
 * legitimately needs every row to score the frozen candidates. It must NOT be
 * called on a request or startup path — that is exactly the O(rows) read the
 * counters exist to avoid.
 */
async function readRows() {
  const db = getDb();
  const col = db.collection(collectionName());
  const rows = [];
  const snap = await rowsRef(db).get();
  snap.forEach(doc => { const d = doc.data(); if (d && typeof d === 'object') rows.push(d); });
  let meta = {};
  try {
    const metaSnap = await col.doc(metaDocId()).get();
    meta = (metaSnap.exists && metaSnap.data()) || {};
  } catch (err) { meta = {}; }
  return {
    rows,
    rows_complete: true,
    benchmarkLogLoss: Number.isFinite(meta.benchmarkLogLoss) ? meta.benchmarkLogLoss : null,
    criteria: meta.criteria || null,
    shadowCalibratorId: meta.shadow_calibrator_id || null,
    updatedAt: meta.updatedAt || null,
    counters: normalizeCounters(meta.counters),
  };
}

/** gRPC status code for ALREADY_EXISTS (a `create()` on an existing document). */
const ALREADY_EXISTS = 6;

/** True for the error a `create()`/batched `create()` throws on an existing doc. */
function isAlreadyExists(err) {
  if (!err) return false;
  const code = err.code;
  return code === ALREADY_EXISTS || code === 'already-exists'
    || /already exists/i.test(String(err.message || ''));
}

/**
 * Round I (item 1) — upsert rows with CREATE semantics and report which
 * documents were GENUINELY created.
 *
 * The old write was an unconditional `set()`, so it could not tell a first write
 * from a re-write. That is exactly what made the rows_by_day counter
 * double-count: after a restart the in-memory row set is empty, so every
 * re-logged checkpoint looked new and incremented the counter again.
 *
 * Here a row is written with `create()`; a document that ALREADY EXISTS (a
 * retry, a double sweep, or a re-log after a restart) falls back to `set()` —
 * still idempotent, still one document per (sport|league|game|grid_checkpoint) —
 * but is NOT reported as created, so it does not move the counter.
 *
 * @returns {Promise<{written:number, createdRows:Array}>}
 */
async function commitUpserts(db, list) {
  const col = rowsRef(db);
  const rowsIn = (Array.isArray(list) ? list : []).filter(r => docIdFor(r) != null);
  const createdRows = [];
  let written = 0;

  for (let i = 0; i < rowsIn.length; i += BATCH_LIMIT) {
    const chunk = rowsIn.slice(i, i + BATCH_LIMIT);
    try {
      // Fast path: create the whole chunk in one commit. On an all-new sweep
      // this is one round trip instead of one per row.
      const batch = db.batch();
      chunk.forEach(row => batch.create(col.doc(docIdFor(row)), row));
      await batch.commit();
      createdRows.push(...chunk);
      written += chunk.length;
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      // At least one document already exists, so the batch was rejected as a
      // whole: fall back to per-document create-or-overwrite, which is exact
      // about which rows are new.
      for (const row of chunk) {
        const ref = col.doc(docIdFor(row));
        try {
          await ref.create(row);
          createdRows.push(row);
        } catch (e) {
          if (!isAlreadyExists(e)) throw e;
          // Exists → overwrite in place, not a new row. An UNSETTLED re-log
          // writes everything EXCEPT the settlement columns (field mask), so a
          // finished game whose checkpoint is re-logged (a restart, or a
          // provider re-reporting it as live) keeps the `y` already stored
          // rather than being reset to pending. A settled row overwrites whole.
          if (rowIsSettled(row)) await ref.set(row);
          else await ref.set(row, { mergeFields: unsettledFields(row) });
        }
        written += 1;
      }
    }
  }
  return { written, createdRows };
}

/**
 * Apply the counter DELTA to the meta document ATOMICALLY, in ONE write.
 *
 * Every counter is a NESTED numeric field incremented with `FieldValue.increment`
 * so two writers can never read-modify-write over each other, and so the whole
 * delta lands in a single meta-document write (the single-document write-rate
 * budget — Round I item 3).
 *
 * Round I (item 2) — SAFE KEYS. The keys are nested Firestore field names, and a
 * real league code carries '.' ('uefa.champions') which a field PATH reads as
 * further nesting ('uefa' -> 'champions'). Every key is therefore the SANITISED
 * token from counters.js ('uefa_champions'); the exact code rides in the
 * `league_labels` map written alongside (plain, never incremented). A nested MAP
 * value passed to `set(..., {merge:true})` preserves such keys literally.
 *
 * `rows_by_day` comes from the documents this flush ACTUALLY created
 * (`createdByDay`), never from an in-memory guess. The first/last row-time bounds
 * are not incremented: `last_row_at` is the batch's newest time, and
 * `first_row_at` is written ONCE (`first_row_at_apply`) so the durable minimum is
 * never overwritten by a later batch.
 */
function applyCounters(write, countersDelta, createdByDay = null) {
  const inc = getAdmin().firestore.FieldValue.increment;
  const d = countersDelta || {};
  const counters = {};

  const addInc = (group, key, n) => {
    if (!Number(n)) return;
    if (!counters[group]) counters[group] = {};
    counters[group][key] = inc(Number(n));
  };

  // rows_by_day — authoritative: only the documents created by THIS flush.
  Object.entries(createdByDay || {}).forEach(([day, n]) => addInc('rows_by_day', day, n));
  Object.entries(d.settled_games_by_sport || {}).forEach(([sport, n]) => addInc('settled_games_by_sport', sport, n));
  Object.entries(d.settled_games_by_league || {}).forEach(([key, n]) => addInc('settled_games_by_league', key, n));

  // The exact label each sanitised league token stands for (plain VALUES, nested
  // beside the counter maps so `readMeta`'s normalizeCounters reads them back).
  const labels = {};
  Object.entries(d.league_labels || {}).forEach(([key, label]) => { if (label) labels[key] = label; });
  if (Object.keys(labels).length) counters.league_labels = labels;

  if (Number.isFinite(d.last_row_at_ms)) {
    counters.last_row_at_ms = d.last_row_at_ms;
    counters.last_row_at = d.last_row_at || new Date(d.last_row_at_ms).toISOString();
  }
  if (d.first_row_at_apply === true && Number.isFinite(d.first_row_at_ms)) {
    counters.first_row_at_ms = d.first_row_at_ms;
    counters.first_row_at = d.first_row_at || new Date(d.first_row_at_ms).toISOString();
  }
  if (Object.keys(counters).length) write.counters = counters;
  return write;
}

/**
 * Persist rows + meta + the counter delta in ONE meta-document write. `pending`
 * (rows changed since the last flush) keeps the row write volume bounded; when it
 * is absent every row is upserted (a full sync).
 *
 * Round I (item 3) — the caller (the shadow sweep) opens a BATCH so this runs
 * ONCE per sweep, not once per row and not once per settled game: the counter
 * delta accumulates in memory and is applied in a single `FieldValue.increment`
 * write, which is what keeps the sweep inside the single-document write rate.
 *
 * Round I (item 1) — `rows_by_day` is derived from the rows this flush actually
 * CREATED (create semantics), so a re-logged checkpoint never inflates it. The
 * applied delta is returned so forwardTest can keep its in-memory mirror exact.
 *
 * @param {boolean} [writeMeta] false defers the meta/counter write (mid-batch).
 * @returns {Promise<{written:number, created:number, createdByDay:Object, counters_delta:Object}>}
 */
async function flush({ rows = [], meta = {}, pending = null, countersDelta = null, writeMeta = true } = {}) {
  const db = getDb();
  const col = db.collection(collectionName());
  const list = Array.isArray(pending) ? pending : (Array.isArray(rows) ? rows : []);

  const { written, createdRows } = await commitUpserts(db, list);
  const createdByDay = {};
  createdRows.forEach(r => {
    const day = countersLib.dayKey(r.at_ms);
    if (day) createdByDay[day] = (createdByDay[day] || 0) + 1;
  });

  if (writeMeta) {
    const write = {
      benchmarkLogLoss: Number.isFinite(meta.benchmarkLogLoss) ? meta.benchmarkLogLoss : null,
      criteria: meta.criteria || null,
      shadow_calibrator_id: meta.shadow_calibrator_id || null,
      updatedAt: new Date().toISOString(),
    };
    applyCounters(write, countersDelta, createdByDay);
    await col.doc(metaDocId()).set(write, { merge: true });
  }

  // The delta the caller may fold into its in-memory mirror.
  const counters_delta = { rows_by_day: createdByDay };
  const d = countersDelta || {};
  if (Object.keys(d.settled_games_by_sport || {}).length) counters_delta.settled_games_by_sport = { ...d.settled_games_by_sport };
  if (Object.keys(d.settled_games_by_league || {}).length) counters_delta.settled_games_by_league = { ...d.settled_games_by_league };
  if (Object.keys(d.league_labels || {}).length) counters_delta.league_labels = { ...d.league_labels };
  if (Number.isFinite(d.last_row_at_ms)) { counters_delta.last_row_at_ms = d.last_row_at_ms; counters_delta.last_row_at = d.last_row_at; }
  if (d.first_row_at_apply === true && Number.isFinite(d.first_row_at_ms)) { counters_delta.first_row_at_ms = d.first_row_at_ms; counters_delta.first_row_at = d.first_row_at; }

  return { written, created: createdRows.length, createdByDay, counters_delta };
}

/** Every configured (sport, league) pair the sweep logs, from CONFIG. */
function configuredLeaguePairs() {
  const sweep = (CONFIG.matcher && CONFIG.matcher.sweep) || {};
  const out = [];
  Object.entries(sweep).forEach(([sport, leagues]) => {
    (Array.isArray(leagues) ? leagues : []).forEach(league => out.push({ sport, league: String(league) }));
  });
  return out;
}

/**
 * Round I (item 1) — RECONCILE the durable counters against the ROWS.
 *
 * The counters in `live_shadow/meta` are a CACHE; the rows are the truth. This
 * recounts the rows directly and reports the drift, so a counter that has
 * silently doubled is caught rather than trusted:
 *
 *   - total rows      → one count() aggregation over the whole subcollection;
 *   - rows per league → a count() aggregation per configured (sport, league)
 *                       (groupBy aggregation is unavailable, so the grouping is
 *                       done with one query per pair);
 *   - settled GAMES   → the DISTINCT `game_id`s among a league's settled rows.
 *                       `count()` cannot do DISTINCT, so this one step reads the
 *                       `game_id` field only (a projection, never the row body)
 *                       for the settled rows of a league — bounded by the settled
 *                       rows, and run only by this admin/one-off path.
 *
 * The one-off 500-game confirmation evaluation calls this instead of the
 * counters: a released pick must rest on a number recounted from the evidence.
 */
async function reconcile() {
  const db = getDb();
  const col = db.collection(collectionName());
  const rowsCol = rowsRef(db);

  const metaSnap = await col.doc(metaDocId()).get();
  const stored = normalizeCounters(metaSnap.exists ? (metaSnap.data() || {}).counters : null);

  const totalSnap = await rowsCol.count().get();
  const totalRows = totalSnap.data().count;

  const perLeague = [];
  const recountByLeague = {};
  const recountBySport = {};
  for (const { sport, league } of configuredLeaguePairs()) {
    const base = rowsCol.where('sport', '==', sport).where('league', '==', league);
    const rows = (await base.count().get()).data().count;

    const settledSnap = await base.where('y', 'in', [0, 1]).select('game_id').get();
    const games = new Set();
    settledSnap.forEach(doc => { const g = doc.get('game_id'); if (g != null) games.add(String(g)); });

    const key = countersLib.leagueKey(sport, league);
    recountByLeague[key] = games.size;
    recountBySport[sport] = (recountBySport[sport] || 0) + games.size;
    perLeague.push({ sport, league, rows, settled_games: games.size, counter_key: key });
  }

  const storedTotal = countersLib.totalRows(stored);
  const drift = {
    total_rows: { counters: storedTotal, recount: totalRows, delta: storedTotal - totalRows },
    settled_games_by_sport: {},
    settled_games_by_league: {},
  };
  const sportKeys = new Set([...Object.keys(stored.settled_games_by_sport), ...Object.keys(recountBySport)]);
  sportKeys.forEach(sport => {
    const c = Number(stored.settled_games_by_sport[sport]) || 0;
    const r = recountBySport[sport] || 0;
    drift.settled_games_by_sport[sport] = { counters: c, recount: r, delta: c - r };
  });
  const leagueKeys = new Set([...Object.keys(stored.settled_games_by_league), ...Object.keys(recountByLeague)]);
  leagueKeys.forEach(key => {
    const c = Number(stored.settled_games_by_league[key]) || 0;
    const r = recountByLeague[key] || 0;
    drift.settled_games_by_league[key] = { label: countersLib.labelFor(stored, key), counters: c, recount: r, delta: c - r };
  });

  const hasDrift = drift.total_rows.delta !== 0
    || Object.values(drift.settled_games_by_sport).some(d => d.delta !== 0)
    || Object.values(drift.settled_games_by_league).some(d => d.delta !== 0);

  return {
    source: `firestore count() aggregation over ${rowsPath()}`,
    collection: rowsPath(),
    total_rows: { counters: storedTotal, recount: totalRows },
    per_league: perLeague,
    drift,
    drift_detected: hasDrift,
  };
}

async function readHealth() {
  const db = getDb();
  const snap = await db.collection(collectionName()).doc(healthDocId()).get();
  return snap.exists ? (snap.data() || null) : null;
}

async function writeHealth(state) {
  try {
    const db = getDb();
    await db.collection(collectionName()).doc(healthDocId()).set(state, { merge: true });
    return true;
  } catch (err) {
    // A health write must never break the sweep it describes.
    return false;
  }
}

async function readLedger() {
  const db = getDb();
  const snap = await db.collection(collectionName()).doc(ledgerDocId()).get();
  return snap.exists ? (snap.data() || null) : null;
}

async function writeLedger(ledger) {
  try {
    const db = getDb();
    await db.collection(collectionName()).doc(ledgerDocId()).set(ledger, { merge: true });
    return true;
  } catch (err) {
    return false;
  }
}

function describe() {
  return {
    kind: 'firestore',
    collection: collectionName(),
    rows_subcollection: rowsCollection(),
    rows_path: rowsPath(),
    meta_doc: metaDocId(),
    health_doc: healthDocId(),
    ledger_doc: ledgerDocId(),
    note: 'Firestore backend (production): rows are keyed by (sport|league|game_id|grid_checkpoint); the evidence survives an ephemeral host disk.',
  };
}

module.exports = {
  kind: 'firestore',
  supportsSync: false,
  describe,
  readMeta,
  readRowsForGame,
  readRows,
  flush,
  // Round I (item 1) — the recount the one-off evaluation uses instead of the
  // counters: `count()` aggregation over the rows, grouped by (sport, league).
  reconcile,
  readHealth,
  writeHealth,
  readLedger,
  writeLedger,
  docIdFor,
};
