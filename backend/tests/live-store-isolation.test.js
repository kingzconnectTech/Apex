/**
 * Phase 10 round H (item 1) — the TEST ISOLATION GUARD.
 *
 * Under NODE_ENV=test every live store path that would land inside backend/data/
 * is redirected to a per-process temp directory (services/live/store/fileStore),
 * regardless of the per-test config — so a test that forgets to redirect its own
 * config can never append synthetic rows to the committed forward log, health
 * state or ledger.
 *
 * These tests prove the guard directly, and prove a real write (and a full
 * shadow sweep) leaves backend/data/ byte-for-byte unchanged. The WHOLE-SUITE
 * enforcement is the global hook (package.json jest.globalSetup /
 * jest.globalTeardown → tests/global-teardown.js), which fails the run if ANY
 * file under data/ changes during the suite.
 */

const fs = require('fs');
const path = require('path');

const CONFIG = require('../services/live/config');
const forwardTest = require('../services/live/forwardTest');
const shadowHealth = require('../services/live/shadowHealth');
const ledger = require('../services/live/ledger');
const store = require('../services/live/store');
const fileStore = require('../services/live/store/fileStore');
const { executeShadowSweep } = require('../services/live/shadowScheduler');
const { manifest, DATA_DIR } = require('./global-teardown');

// The DANGEROUS config: the committed evidence paths. A guarded store must
// redirect these while NODE_ENV=test.
const COMMITTED_FORWARD_FILE = CONFIG.live.forwardTest.file;
const COMMITTED_HEALTH_FILE = CONFIG.live.health.file;
const COMMITTED_LEDGER_FILE = CONFIG.live.store.ledger.file;

// The temp files the guard will map the committed paths onto.
const TEMP_FORWARD_FILE = path.join(fileStore.testRoot, path.basename(COMMITTED_FORWARD_FILE));
const TEMP_HEALTH_FILE = path.join(fileStore.testRoot, path.basename(COMMITTED_HEALTH_FILE));
const TEMP_LEDGER_FILE = path.join(fileStore.testRoot, path.basename(COMMITTED_LEDGER_FILE));

function rm(file) { try { fs.unlinkSync(file); } catch (err) { /* absent is fine */ } }

function pointAtCommittedPaths() {
  CONFIG.live.forwardTest.file = COMMITTED_FORWARD_FILE;
  CONFIG.live.health.file = COMMITTED_HEALTH_FILE;
  CONFIG.live.store.ledger.file = COMMITTED_LEDGER_FILE;
  CONFIG.live.store.kind = 'file';
}

// OWNER OVERRIDE (2026-11-18): every league ships, so `shadowSports()` is empty by
// default and the canary sweep would log nothing. Force basketball back into the
// hold while these tests run so the sweep still writes a shadow row.
let savedPicksBasketball;

beforeEach(() => {
  savedPicksBasketball = CONFIG.live.picks.basketball;
  CONFIG.live.picks.basketball = [];
  rm(TEMP_FORWARD_FILE); rm(TEMP_HEALTH_FILE); rm(TEMP_LEDGER_FILE);
  pointAtCommittedPaths();
  store.resetStore();
  forwardTest.reset();
  shadowHealth.reset();
  ledger.reset();
  forwardTest.init({ benchmarkLogLoss: 0.4303 });
  shadowHealth.init();
  ledger.init();
});

afterEach(() => {
  // Restore the committed config and drop the temp files so no later suite in
  // this worker inherits leftover rows from the guard's temp directory.
  CONFIG.live.picks.basketball = savedPicksBasketball;
  pointAtCommittedPaths();
  store.resetStore();
  forwardTest.reset();
  shadowHealth.reset();
  ledger.reset();
  rm(TEMP_FORWARD_FILE); rm(TEMP_HEALTH_FILE); rm(TEMP_LEDGER_FILE);
});

/** A basketball candidate shaped like matcher.listLeagueFixtures output. */
function candidate({ id = '401' } = {}) {
  return {
    source: 'espn',
    fixture: {
      sport: 'basketball',
      fixture: { id, status: 'live', clock: '7:24', period: 3, date: '2026-11-08T02:00:00Z', timestamp: 1700000000000, venue: 'Arena' },
      league: { id: 'nba', name: 'NBA' },
      homeTeam: { id: 'h', name: 'Lakers', score: 70 },
      awayTeam: { id: 'a', name: 'Celtics', score: 66 },
    },
    match_confidence: 1,
    orientation: 'direct',
    home_similarity: null,
    away_similarity: null,
    match_notes: ['listed'],
  };
}

/** A LiveGame shaped object for forwardTest.recordServed directly. */
function liveGame({ id = 'g1' } = {}) {
  return {
    game_id: id,
    sport: 'basketball',
    league: { id: 'nba', name: 'NBA' },
    home: { score: 70 },
    away: { score: 66 },
    live: { clock: '7:24', period: 3 },
    freshness: { age_seconds: 5, is_stale: false },
    data_tier: 'live',
    source: 'espn',
  };
}

describe('the NODE_ENV=test guard is active', () => {
  test('NODE_ENV is test and the file store reports the guard', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(fileStore.testIsolated).toBe(true);
    expect(store.describe().test_isolated).toBe(true);
  });
});

describe('a store left on the committed data/ path is redirected to a temp dir', () => {
  test('rows, health and the ledger all resolve outside backend/data/', () => {
    store.resetStore();
    const d = store.describe();
    for (const p of [d.rows_file, d.health_file, d.ledger_file]) {
      expect(path.isAbsolute(p)).toBe(true);
      // Outside backend/data/...
      expect(path.relative(DATA_DIR, p).startsWith('..')).toBe(true);
      // ...and inside the per-process temp root.
      expect(path.relative(fileStore.testRoot, p).startsWith('..')).toBe(false);
    }
  });

  test('a write through the store never touches backend/data/', () => {
    const before = manifest(DATA_DIR);

    // A post-freeze shadow row written with the COMMITTED (dangerous) config.
    const row = forwardTest.recordServed({ game: liveGame(), probability: 0.61, now: 1795000000000, shadow: true });
    expect(row).not.toBe(null);
    forwardTest.flush();

    // The guard redirected the write; backend/data/ is byte-for-byte unchanged.
    expect(manifest(DATA_DIR)).toEqual(before);
    // And the evidence landed in the temp dir instead.
    expect(fs.existsSync(TEMP_FORWARD_FILE)).toBe(true);
  });
});

describe('a full shadow sweep leaves backend/data/ untouched (the canary)', () => {
  test('the sweep logs evidence but never writes under data/', async () => {
    const before = manifest(DATA_DIR);
    const matcher = { listLeagueFixtures: jest.fn(async () => [candidate()]) };

    const result = await executeShadowSweep({ matcher });
    expect(result.logged).toBe(1);
    expect(forwardTest.status().shadowRows).toBe(1);

    // Proof the sweep ran (it logged) AND the committed evidence is unchanged.
    expect(manifest(DATA_DIR)).toEqual(before);
  });
});
