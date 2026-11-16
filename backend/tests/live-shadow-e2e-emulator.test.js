/**
 * Round J (item 3) — the END-TO-END shadow flow against the Firestore
 * emulator, driven through the REAL HTTP routes (not the internal helpers).
 *
 * This is the pre-deployment rehearsal: it proves the whole path a deployed
 * host will actually take, with nothing stubbed except the upstream provider:
 *
 *   1. POST /api/live/sweep with the bearer secret LOGS a row for each live
 *      game (the rows land in `live_shadow/container/rows`).
 *   2. The games finish; a LATER sweep SETTLES those same rows.
 *   3. The process is RESTARTED (the in-memory state dropped, exactly as a
 *      free-tier host waking from sleep) and the app is rebuilt.
 *   4. GET /api/live/stats and the confirmation progress then report the RIGHT
 *      counts — read back from durable storage — with NO duplicates, proven by
 *      the count()-based reconcile reporting zero drift.
 *
 * The route layer is the real one (`routes/live.createLiveRouter`): the secret
 * gate, the sweep trigger and the stats surface are all exercised as deployed.
 * Only the rate limiter is injected as a pass-through so the assertions do not
 * depend on request timing.
 *
 * RUNS AGAINST THE EMULATOR and is skipped unless FIRESTORE_EMULATOR_HOST is
 * set, so a normal `npm test` (file backend) is unaffected:
 *
 *   $env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
 *   $env:GCLOUD_PROJECT='demo-apex'
 *   npx jest tests/live-shadow-e2e-emulator.test.js
 */

const express = require('express');
const request = require('supertest');
const admin = require('firebase-admin');

const CONFIG = require('../services/live/config');
const store = require('../services/live/store');
const forwardTest = require('../services/live/forwardTest');
const shadowHealth = require('../services/live/shadowHealth');
const ledger = require('../services/live/ledger');
const { createLiveRouter } = require('../routes/live');

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST || null;
const FS_CFG = CONFIG.live.store.firestore || {};
const COLLECTION = FS_CFG.collection || 'live_shadow';
const ROWS_PARENT = FS_CFG.rowsParentDoc || 'container';
const ROWS_SUB = FS_CFG.rowsSubcollection || 'rows';
// A Firestore CollectionReference has no `.collection()`, so the rows path is a
// slash path with an ODD number of segments (collection/doc/collection).
const ROWS_PATH = `${COLLECTION}/${ROWS_PARENT}/${ROWS_SUB}`;
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'demo-apex';

// A secret long enough for the configured minimum (24) and never logged.
const SECRET = 'round-j-e2e-secret-0123456789abcdef';

// Only run when the emulator is reachable via the standard env var.
const describeEmulator = EMULATOR ? describe : describe.skip;

let db = null;

/* --------------------------------------------------------------- fixtures */

/** A matcher candidate shaped like matcher.listLeagueFixtures output. */
function candidate({
  id = '401', status = 'live', clock = '7:24', period = 3,
  league = 'nba', homeScore = 70, awayScore = 66,
} = {}) {
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

/** The real router, with only the rate limiter stubbed to a pass-through. */
function buildApp(matcher) {
  const pass = (req, res, next) => next();
  const app = express();
  app.use(express.json());
  app.use('/api', createLiveRouter({
    matcher,
    rateLimitMiddleware: pass,
    manualRateLimitMiddleware: pass,
    sweepRateLimitMiddleware: pass,
    logger: null,
  }));
  return app;
}

/** Simulate a process restart: drop every in-memory module, keep durable state. */
function restartProcess() {
  store.resetStore();
  forwardTest.reset();
  shadowHealth.reset();
  ledger.reset();
}

async function clearCollection() {
  const rowsSnap = await db.collection(ROWS_PATH).get();
  if (!rowsSnap.empty) {
    const batch = db.batch();
    rowsSnap.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
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

/** The exact number of row documents in the subcollection. */
async function rowCount() {
  return (await db.collection(ROWS_PATH).count().get()).data().count;
}

/** Poll until `fn()` is truthy, or give up after `timeout` ms. */
async function waitFor(fn, { timeout = 10000, interval = 100 } = {}) {
  const start = Date.now();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) return null;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r => setTimeout(r, interval));
  }
}

const sweep = (app) => request(app).post('/api/live/sweep').set('Authorization', `Bearer ${SECRET}`);
const stats = (app) => request(app).get('/api/live/stats').set('Authorization', `Bearer ${SECRET}`);

/* ------------------------------------------------------------------- setup */

describeEmulator('round J — shadow E2E through the real routes (emulator)', () => {
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
    CONFIG.live.store.firestore.collection = COLLECTION;
    restartProcess();
    await clearCollection();
    process.env.LIVE_STATS_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.LIVE_STATS_SECRET;
  });

  test('sweep logs rows, a later sweep settles them, a restart reports the right counts, no duplicates', async () => {
    /* --- 1. the sweep trigger LOGS rows for live games --------------------- */
    let app = buildApp(matcherFor(liveGames(3)));

    // The route is secret-gated: no bearer -> 401, and it fails closed.
    const unauth = await request(app).post('/api/live/sweep');
    expect(unauth.status).toBe(401);

    const live = await sweep(app);
    expect(live.status).toBe(200);
    expect(live.body.dry_run).toBe(false);
    expect(live.body.logged).toBe(3);
    expect(await rowCount()).toBe(3);

    /* --- 2. the games finish; a LATER sweep settles the SAME rows ---------- */
    const finished = await sweep(buildApp(matcherFor(liveGames(3, { status: 'finished', homeScore: 110, awayScore: 102 }))));
    expect(finished.status).toBe(200);
    expect(finished.body.settled).toBe(3);

    const metaSettled = await rawMeta();
    expect(Number(metaSettled.counters.settled_games_by_sport.basketball)).toBe(3);
    // Still exactly three rows: settling edits them in place, never appends.
    expect(await rowCount()).toBe(3);

    /* --- 3. RESTART the process and rebuild the app ------------------------ */
    restartProcess();
    app = buildApp(matcherFor(liveGames(3)));

    /* --- 4. /api/live/stats reports the durable counts --------------------- */
    // The Firestore startup path hydrates the counters ASYNCHRONOUSLY, so poll
    // until the meta read lands (exactly as a cold start would).
    const hydrated = await waitFor(async () => {
      const res = await stats(app);
      // auth is enforced before the body is produced
      expect(res.status).toBe(200);
      return res.body.forward_test.total_rows === 3 ? res.body : null;
    });
    expect(hydrated).not.toBeNull();

    const body = hydrated;
    expect(body.health.storage.kind).toBe('firestore');
    // The durable counters survived the restart.
    expect(body.forward_test.total_rows).toBe(3);
    // The shadow block is still reported per sport (rows not loaded => counts
    // only, which is exactly the honest Firestore cold-start view).
    expect(body.forward_test.shadow.basketball.sport).toBe('basketball');
    expect(body.forward_test.confirmation.basketball.settled_games).toBe(3);
    expect(body.forward_test.confirmation.basketball.counts_source).toBe('counters');
    // Progress toward the 500-game confirmation target, read from the counters.
    expect(body.forward_test.progress.per_sport.basketball.settled_games).toBe(3);
    expect(body.forward_test.progress.counts_source).toBe('counters');
    // The durable ledger's first post-freeze row is surfaced (item 5, round H).
    expect(body.health.first_post_freeze_row).toBeTruthy();

    /* --- 5. a duplicate sweep after the restart adds NOTHING --------------- */
    await sweep(app); // re-logs the same checkpoint (same idempotency key)
    expect(await rowCount()).toBe(3);

    const rec = await store.reconcile();
    expect(rec.total_rows.recount).toBe(3);
    expect(rec.total_rows.counters).toBe(3);
    expect(rec.drift.settled_games_by_sport.basketball).toEqual({ counters: 3, recount: 3, delta: 0 });
    expect(rec.drift_detected).toBe(false);

    console.log('[e2e] rows stored =', await rowCount(), '| counters =', rec.total_rows.counters, '| recount =', rec.total_rows.recount);
    console.log('[e2e] settled_games_by_sport =', JSON.stringify((await rawMeta()).counters.settled_games_by_sport));
    console.log('[e2e] stats.forward_test.total_rows =', body.forward_test.total_rows,
      '| confirmation.basketball.settled_games =', body.forward_test.confirmation.basketball.settled_games,
      '| drift_detected =', rec.drift_detected);
  }, 60000);
});
