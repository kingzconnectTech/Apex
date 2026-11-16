/**
 * Phase 10 round I — the durable COUNTERS against the Firestore emulator.
 *
 * Round H replaced the full-subcollection startup read with compact counters in
 * `live_shadow/meta`, incremented as rows are written. Round I makes that
 * increment EXACT:
 *
 *   item 1 — `rows_by_day` moves ONLY when a row document is GENUINELY created
 *            (create() semantics) and the settled counter only on a game's first
 *            unsettled->settled transition. The tests below run the same sweep
 *            TWICE and an INTERRUPTED-THEN-RESUMED sweep and prove the counters
 *            still equal the number of DISTINCT rows / settled games, and that a
 *            `count()`-based RECONCILE agrees with them.
 *   item 2 — a league code carries '.' ('eng.1', 'uefa.champions') and '-'
 *            ('mens-college-basketball'); the counter keys are SANITISED so a
 *            field path cannot split them. Exercised for EVERY configured
 *            league code, and the stored meta structure is printed.
 *   item 3 — the whole sweep applies its counter delta in ONE meta write.
 *
 * These tests RUN AGAINST THE EMULATOR and are skipped unless
 * FIRESTORE_EMULATOR_HOST is set, so a normal `npm test` (file backend) is
 * unaffected:
 *
 *   $env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
 *   npx jest tests/live-shadow-counters-emulator.test.js
 */

const admin = require('firebase-admin');

const CONFIG = require('../services/live/config');
const forwardTest = require('../services/live/forwardTest');
const store = require('../services/live/store');
const firestoreStore = require('../services/live/store/firestoreStore');
const countersLib = require('../services/live/store/counters');
const shadowHealth = require('../services/live/shadowHealth');
const ledger = require('../services/live/ledger');
const { executeShadowSweep, runShadowReconcile } = require('../services/live/shadowScheduler');

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST || null;
const FS_CFG = CONFIG.live.store.firestore || {};
const COLLECTION = FS_CFG.collection || 'live_shadow';
const ROWS_PARENT = FS_CFG.rowsParentDoc || 'container';
const ROWS_SUB = FS_CFG.rowsSubcollection || 'rows';
// The rows live in a SUBCOLLECTION under a fixed parent document; a Firestore
// CollectionReference has no `.collection()`, so the path is built as a slash
// path with an ODD number of segments (collection/doc/collection).
const ROWS_PATH = `${COLLECTION}/${ROWS_PARENT}/${ROWS_SUB}`;
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'demo-apex';

// Only run when the emulator is reachable via the standard env var.
const describeEmulator = EMULATOR ? describe : describe.skip;

let db = null;

/* --------------------------------------------------------------- fixtures */

/** A matcher candidate shaped like matcher.listLeagueFixtures output. */
function candidate({ id = '401', status = 'live', clock = '7:24', period = 3, league = 'nba', homeScore = 70, awayScore = 66 } = {}) {
  return {
    source: 'espn',
    fixture: {
      sport: 'basketball',
      fixture: { id, status, clock, period, date: '2026-11-08T02:00:00Z', timestamp: 1700000000000, venue: 'Arena' },
      league: { id: league, name: league },
      homeTeam: { id: 'h', name: 'Lakers', score: homeScore },
      awayTeam: { id: 'a', name: 'Celtics', score: awayScore },
    },
    match_confidence: 1,
    orientation: 'direct',
    home_similarity: null,
    away_similarity: null,
    match_notes: ['listed'],
  };
}

/** N distinct games, all at the same clock (=> the same grid checkpoint). */
function liveGames(n, { clock = '7:24', period = 3, status = 'live', homeScore = 70, awayScore = 66 } = {}) {
  return Array.from({ length: n }, (_, i) => candidate({ id: String(401 + i), clock, period, status, homeScore, awayScore }));
}

/** A matcher that returns `list` for basketball and nothing for any other sport. */
function matcherFor(list) {
  return { listLeagueFixtures: jest.fn(async ({ sport }) => (sport === 'basketball' ? list : [])) };
}

/* ----------------------------------------------------------------- helpers */

async function clearCollection() {
  // Rows first (the subcollection under the fixed parent document).
  const rowsSnap = await db.collection(ROWS_PATH).get();
  if (!rowsSnap.empty) {
    const batch = db.batch();
    rowsSnap.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
  // Then the singleton documents (meta / health / ledger).
  const docsSnap = await db.collection(COLLECTION).get();
  if (!docsSnap.empty) {
    const batch = db.batch();
    docsSnap.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
}

/** The RAW stored meta document (what the emulator actually holds). */
async function rawMeta() {
  const snap = await db.collection(COLLECTION).doc('meta').get();
  return snap.exists ? snap.data() : null;
}

/** Total rows recorded by the durable counters. */
function countersTotal(count) {
  return countersLib.totalRows(count);
}

/* ------------------------------------------------------------------- setup */

describeEmulator('round I — durable counters against the Firestore emulator', () => {
  beforeAll(() => {
    if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT_ID });
    db = admin.firestore();
  });

  afterAll(async () => {
    CONFIG.live.store.kind = 'file';
    store.resetStore();
    forwardTest.reset();
    try { await admin.app().delete(); } catch (err) { /* already gone */ }
  });

  beforeEach(async () => {
    CONFIG.live.store.kind = 'firestore';
    store.resetStore();
    forwardTest.reset();
    shadowHealth.reset();
    ledger.reset();
    // Point the durable ledger/health at the emulator collection too.
    CONFIG.live.store.firestore.collection = COLLECTION;
    await clearCollection();
    forwardTest.init({ benchmarkLogLoss: 0.4303 });
  });

  /* ------------------------------------------------- item 1: no double count */

  test('item 1 — the SAME sweep run twice does not double-count (rows or games)', async () => {
    const games = liveGames(3);
    const matcher = matcherFor(games);

    // --- sweep 1: three new grid rows are created ---------------------------
    const s1 = await executeShadowSweep({ matcher });
    expect(s1.logged).toBe(3);
    const meta1 = await rawMeta();
    const rowsAfterFirst = countersTotal(meta1.counters);
    expect(rowsAfterFirst).toBe(3);

    // --- sweep 2: the IDENTICAL sweep. Every checkpoint is already stored, so
    // `create()` reports nothing new and rows_by_day must NOT move.
    const s2 = await executeShadowSweep({ matcher });
    expect(s2.logged).toBe(0); // not nearer the mark -> no overwrite, no row
    const meta2 = await rawMeta();
    expect(countersTotal(meta2.counters)).toBe(rowsAfterFirst);

    // --- the RECOUNT agrees with the counters, and there is no drift --------
    const rec = await store.reconcile();
    expect(rec.total_rows.counters).toBe(rowsAfterFirst);
    expect(rec.total_rows.recount).toBe(rowsAfterFirst);
    expect(rec.drift_detected).toBe(false);

    console.log('[item1 same-sweep-twice] counters rows_by_day =', JSON.stringify(meta2.counters.rows_by_day));
    console.log('[item1 same-sweep-twice] recount =', JSON.stringify(rec.total_rows));
    console.log('[item1 same-sweep-twice] drift_detected =', rec.drift_detected);
  });

  test('item 1 — an INTERRUPTED-THEN-RESUMED sweep equals distinct rows and games', async () => {
    const matcher = matcherFor(liveGames(3));

    // --- process 1: log three rows, then the process is interrupted (the host
    // slept). The rows are durable; the in-memory set is gone.
    await executeShadowSweep({ matcher });
    const rowsAfterProcess1 = countersTotal((await rawMeta()).counters);
    expect(rowsAfterProcess1).toBe(3);

    // --- RESTART: a Firestore startup loads the counters, NOT the rows, so in
    // memory every checkpoint looks brand new. Without create() semantics this
    // is exactly where rows_by_day would double.
    forwardTest.reset();
    forwardTest.init({ benchmarkLogLoss: 0.4303 });
    expect(forwardTest.status().rows).toBe(0); // rows not loaded, as in production

    // --- RESUME sweep A: the SAME three checkpoints re-logged -----------------
    await executeShadowSweep({ matcher });
    const rowsAfterResumeA = countersTotal((await rawMeta()).counters);
    expect(rowsAfterResumeA).toBe(rowsAfterProcess1); // NOT 6

    // --- RESUME sweep B: the clock advanced to a NEW grid mark ---------------
    await executeShadowSweep({ matcher: matcherFor(liveGames(3, { clock: '4:24' })) });
    const rowsAfterResumeB = countersTotal((await rawMeta()).counters);
    expect(rowsAfterResumeB).toBe(6); // 3 games x 2 distinct checkpoints

    // --- the game finishes: settle, once per game ---------------------------
    await executeShadowSweep({ matcher: matcherFor(liveGames(3, { status: 'finished', homeScore: 110, awayScore: 102 })) });
    const metaSettled = await rawMeta();
    expect(Number(metaSettled.counters.settled_games_by_sport.basketball)).toBe(3);

    // --- re-sweep the SAME finished games: no new settle count ---------------
    await executeShadowSweep({ matcher: matcherFor(liveGames(3, { status: 'finished', homeScore: 110, awayScore: 102 })) });
    const metaSettled2 = await rawMeta();
    expect(Number(metaSettled2.counters.settled_games_by_sport.basketball)).toBe(3);

    // --- the RECOUNT agrees: 6 distinct rows, 3 distinct settled games -------
    const rec = await store.reconcile();
    expect(rec.total_rows.recount).toBe(6);
    expect(rec.total_rows.counters).toBe(6);
    expect(rec.drift.settled_games_by_sport.basketball).toEqual({ counters: 3, recount: 3, delta: 0 });
    expect(rec.drift_detected).toBe(false);

    console.log('[item1 interrupted-resumed] counters rows_by_day =', JSON.stringify(metaSettled2.counters.rows_by_day));
    console.log('[item1 interrupted-resumed] counters settled_games_by_sport =', JSON.stringify(metaSettled2.counters.settled_games_by_sport));
    console.log('[item1 interrupted-resumed] recount total_rows =', JSON.stringify(rec.total_rows));
    console.log('[item1 interrupted-resumed] drift =', JSON.stringify(rec.drift));
  });

  /* ------------------------------------------------------ item 2: safe keys */

  test('item 2 — every configured league code is stored under a SANITISED key', async () => {
    const sweepCfg = CONFIG.matcher.sweep || {};
    const settled_games_by_sport = {};
    const settled_games_by_league = {};
    const league_labels = {};
    const expected = [];
    Object.entries(sweepCfg).forEach(([sport, leagues]) => {
      (Array.isArray(leagues) ? leagues : []).forEach(league => {
        const key = countersLib.leagueKey(sport, league);
        settled_games_by_sport[sport] = (settled_games_by_sport[sport] || 0) + 1;
        settled_games_by_league[key] = 1;
        league_labels[key] = `${sport}/${league}`;
        expected.push({ sport, league, key });
      });
    });

    // One flush carries the settled counters of EVERY configured league.
    await store.getStore().flush({
      rows: [], meta: {}, pending: [],
      countersDelta: { settled_games_by_sport, settled_games_by_league, league_labels },
    });

    const meta = await rawMeta();
    const storedLeagues = meta.counters.settled_games_by_league || {};

    // 1. Exactly one stored key per configured (sport, league) pair — nothing
    //    was split into nested objects by a '.' in the code.
    expect(Object.keys(storedLeagues).sort()).toEqual(expected.map(e => e.key).sort());
    // 2. No stored key still carries a '.' or a '-' that a field path could trip on.
    Object.keys(storedLeagues).forEach(k => expect(k).toMatch(/^[A-Za-z0-9_]+::[A-Za-z0-9_]+$/));
    // 3. The exact code is preserved beside it, so sanitising loses nothing.
    expected.forEach(({ league, key }) => {
      const label = meta.counters.league_labels[key];
      expect(label.endsWith(`/${league}`)).toBe(true);
    });
    // 4. A dotted code specifically resolves back to its REAL league code.
    expect(meta.counters.league_labels['soccer::uefa_champions']).toBe('soccer/uefa.champions');
    expect(meta.counters.league_labels['soccer::eng_1']).toBe('soccer/eng.1');
    expect(meta.counters.league_labels['basketball::mens_college_basketball']).toBe('basketball/mens-college-basketball');

    console.log('[item2] configured (sport, league) pairs:', expected.length);
    console.log('[item2] STORED meta.counters structure:');
    console.log(JSON.stringify({ counters: meta.counters }, null, 2));
  });

  /* ---------------------------------------------- item 3: one write a sweep */

  test('item 3 — a whole sweep applies its counter delta in ONE meta write', async () => {
    const games = liveGames(8);
    const matcher = matcherFor(games);

    // Count the meta writes the sweep makes, by wrapping the store's flush.
    const realFlush = firestoreStore.flush;
    let metaWrites = 0;
    firestoreStore.flush = (args = {}) => {
      if (args.writeMeta !== false) metaWrites += 1;
      return realFlush(args);
    };

    let stats;
    let elapsedMs = 0;
    try {
      const t0 = Date.now();
      stats = await executeShadowSweep({ matcher });
      elapsedMs = Math.max(Date.now() - t0, 1);
    } finally {
      firestoreStore.flush = realFlush;
    }

    expect(stats.logged).toBe(8);
    // ONE meta write for the whole sweep, regardless of how many rows moved.
    expect(metaWrites).toBe(1);

    const writesPerSecond = metaWrites / (elapsedMs / 1000);
    console.log('[item3] rows logged in sweep =', stats.logged, '| meta writes =', metaWrites);
    console.log(`[item3] sweep duration = ${elapsedMs} ms | writes/sec to meta at peak = ${writesPerSecond.toFixed(3)}`);
  });

  /* -------------------------- item 5: the daily reconcile -> health + alert */

  test('item 5 — the reconcile job records drift in health and alerts on a non-zero delta', async () => {
    await executeShadowSweep({ matcher: matcherFor(liveGames(3)) });
    await executeShadowSweep({ matcher: matcherFor(liveGames(3, { status: 'finished', homeScore: 110, awayScore: 102 })) });

    // CLEAN: the counters agree with a recount -> drift 0 and NO drift alert.
    const clean = await runShadowReconcile({ logger: null });
    expect(clean.drift_detected).toBe(false);
    let snap = await shadowHealth.readSnapshot({ now: Date.now() });
    expect(snap.reconcile.last_at).toBeTruthy();
    expect(snap.reconcile.drift_detected).toBe(false);
    expect(snap.alert.kind).not.toBe('counter_drift');

    // TAMPER: inflate a durable counter so it can no longer match the rows. The
    // recount is the truth, so the job must report the drift and alert.
    await db.collection(COLLECTION).doc('meta')
      .set({ counters: { settled_games_by_sport: { basketball: 99 } } }, { merge: true });

    const drifted = await runShadowReconcile({ logger: null });
    expect(drifted.drift_detected).toBe(true);
    snap = await shadowHealth.readSnapshot({ now: Date.now() });
    expect(snap.reconcile.drift_detected).toBe(true);
    expect(snap.alert.active).toBe(true);
    expect(snap.alert.kind).toBe('counter_drift');

    console.log('[item5] clean total_rows =', JSON.stringify(clean.total_rows));
    console.log('[item5] tampered drift.settled_games_by_sport =', JSON.stringify(drifted.drift.settled_games_by_sport));
    console.log('[item5] health alert =', JSON.stringify(snap.alert));
  });
});
