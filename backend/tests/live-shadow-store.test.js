/**
 * Phase 10 round G — the storage adapter, idempotency and the restart test.
 *
 * Item 1 puts shadow rows, settle outcomes, health state and the ledger behind
 * ONE interface with a file backend (tests/dev) and a Firestore backend
 * (production). These tests exercise the FILE backend end to end:
 *   - rows are written ONLY when their elapsed fraction maps to the replay grid
 *     (nearest within gridTolerance), and skipped otherwise;
 *   - a write is IDEMPOTENT, keyed by (sport, league, game_id, grid_checkpoint),
 *     so a retry or a double sweep cannot add a second row;
 *   - a simulated PROCESS RESTART preserves rows, outcomes and the health
 *     counters, and logging resumes without duplicates;
 *   - the ledger records the first post-freeze row exactly once.
 *
 * No network, no cron and no Firestore are involved.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG = require('../services/live/config');
const forwardTest = require('../services/live/forwardTest');
const shadowHealth = require('../services/live/shadowHealth');
const ledger = require('../services/live/ledger');
const store = require('../services/live/store');
const countersLib = require('../services/live/store/counters');
const grid = require('../services/live/store/grid');
const { executeShadowSweep } = require('../services/live/shadowScheduler');

const COMMITTED_FORWARD_FILE = CONFIG.live.forwardTest.file;
const COMMITTED_HEALTH_FILE = CONFIG.live.health.file;
const COMMITTED_LEDGER_FILE = CONFIG.live.store.ledger.file;

const stamp = `${process.pid}-${Math.random().toString(16).slice(2)}`;
const TMP_FORWARD_FILE = path.join(os.tmpdir(), `rg-forward-${stamp}.json`);
const TMP_HEALTH_FILE = path.join(os.tmpdir(), `rg-health-${stamp}.json`);
const TMP_LEDGER_FILE = path.join(os.tmpdir(), `rg-ledger-${stamp}.json`);

function rm(file) { try { fs.unlinkSync(file); } catch (err) { /* absent is fine */ } }

beforeEach(() => {
  rm(TMP_FORWARD_FILE); rm(TMP_HEALTH_FILE); rm(TMP_LEDGER_FILE);
  CONFIG.live.forwardTest.file = TMP_FORWARD_FILE;
  CONFIG.live.health.file = TMP_HEALTH_FILE;
  CONFIG.live.store.ledger.file = TMP_LEDGER_FILE;
  CONFIG.live.store.kind = 'file';
  store.resetStore();
  forwardTest.reset();
  shadowHealth.reset();
  ledger.reset();
  forwardTest.init({ benchmarkLogLoss: 0.4303 });
  shadowHealth.init();
  ledger.init();
});

afterEach(() => {
  CONFIG.live.forwardTest.file = COMMITTED_FORWARD_FILE;
  CONFIG.live.health.file = COMMITTED_HEALTH_FILE;
  CONFIG.live.store.ledger.file = COMMITTED_LEDGER_FILE;
  store.resetStore();
  forwardTest.reset();
  shadowHealth.reset();
  ledger.reset();
  rm(TMP_FORWARD_FILE); rm(TMP_HEALTH_FILE); rm(TMP_LEDGER_FILE);
});

/* --------------------------------------------------------------- fixtures */

/** A matcher candidate shaped like matcher.listLeagueFixtures output. */
function candidate({ id = '401', status = 'live', clock = '7:24', period = 3, homeScore = 70, awayScore = 66 } = {}) {
  return {
    source: 'espn',
    fixture: {
      sport: 'basketball',
      fixture: { id, status, clock, period, date: '2026-11-08T02:00:00Z', timestamp: 1700000000000, venue: 'Crypto.com Arena' },
      league: { id: 'nba', name: 'NBA' },
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

/** A LiveGame shaped object for forwardTest.recordServed directly. */
function liveGame({ id = 'g1', clock = '7:24', period = 3, league = 'nba', homeScore = 70, awayScore = 66 } = {}) {
  return {
    game_id: id,
    sport: 'basketball',
    league: { id: league, name: league },
    home: { score: homeScore },
    away: { score: awayScore },
    live: { clock, period },
    freshness: { age_seconds: 5, is_stale: false },
    data_tier: 'live',
    source: 'espn',
  };
}

/* ----------------------------------------------------------- grid adapter */

describe('grid gating (round G item 1)', () => {
  test('snaps an elapsed fraction to the nearest replay mark within tolerance', () => {
    const fractions = CONFIG.liveBacktest.checkpoints.basketball.fractions;
    expect(fractions).toContain(0.625);
    // NBA, period 3, 7:24 left => elapsed 28.6 / 48 = 0.5958 within 0.03 of 0.625.
    expect(grid.gridCheckpoint(0.5958)).toBe(0.625);
    // A fraction > tolerance from every mark is skipped (no fabricated snap).
    expect(grid.gridCheckpoint(0.55)).toBe(null);
    // Unknown progress is skipped, never defaulted.
    expect(grid.gridCheckpoint(null)).toBe(null);
  });

  test('builds a stable storage key from (sport, league, game_id, grid_checkpoint)', () => {
    expect(grid.storageKey({ sport: 'basketball', league: 'nba', game_id: '401', grid_checkpoint: 0.625 }))
      .toBe('basketball|nba|401|0.625');
    // Missing any component yields no key (the row cannot be idempotent).
    expect(grid.storageKey({ sport: 'basketball', league: 'nba', game_id: '401' })).toBe(null);
  });
});

/* ------------------------------------------------------- row idempotency */

describe('recordServed writes only grid rows, idempotently', () => {
  test('skips a checkpoint that is not near a grid mark', () => {
    // 9:36 left in period 3 (NBA) => elapsed 26.4 / 48 = 0.55, > 0.03 from 0.5.
    const row = forwardTest.recordServed({ game: liveGame({ clock: '9:36', period: 3 }), probability: 0.61, shadow: true });
    expect(row).toBe(null);
    expect(forwardTest.status().rows).toBe(0);
  });

  test('a double write of the same (game, grid mark) does not create a second row', () => {
    const game = liveGame({ id: 'g-dup', clock: '7:24', period: 3 });
    const first = forwardTest.recordServed({ game, probability: 0.61, now: 1795000000000, shadow: true });
    expect(first).not.toBe(null);
    expect(first.grid_checkpoint).toBe(0.625);

    // The identical checkpoint again (a retry / double sweep). It is not NEARER
    // the mark, so it is a no-op — no second row is appended.
    const second = forwardTest.recordServed({ game, probability: 0.62, now: 1795000001000, shadow: true });
    expect(second).toBe(null);
    expect(forwardTest.status().rows).toBe(1);
  });
});

/* -------------------------------------------------------- restart survival */

describe('a process restart preserves evidence and resumes without duplicates (round G item 4)', () => {
  test('a sweep flushes its rows before returning, so they survive an immediate restart', async () => {
    await executeShadowSweep({ matcher: { listLeagueFixtures: jest.fn(async () => [candidate()]) } });
    expect(forwardTest.status().shadowRows).toBe(1);

    // Restart IMMEDIATELY — no settle, no second sweep. The row must already be
    // on disk, or a host that slept right after the sweep would lose it.
    forwardTest.reset();
    forwardTest.init({ benchmarkLogLoss: 0.4303 });
    expect(forwardTest.status().rows).toBe(1);
    expect(forwardTest.status().shadowRows).toBe(1);
  });

  test('rows, outcomes, health counters and the ledger survive; logging resumes clean', async () => {
    // --- sweep 1: a live game logs a shadow row -------------------------------
    const liveMatcher = { listLeagueFixtures: jest.fn(async () => [candidate()]) };
    const s1 = await executeShadowSweep({ matcher: liveMatcher });
    expect(s1.logged).toBe(1);
    expect(forwardTest.status().shadowRows).toBe(1);
    expect(shadowHealth.snapshot().sweeps).toBe(1);
    // The first post-freeze row is recorded once, in the durable ledger.
    const firstRow = ledger.snapshot().first_post_freeze_row;
    expect(firstRow).not.toBe(null);
    expect(firstRow.game_id).toBe('espn:401');

    // --- sweep 2: the game is finished, its rows settle -----------------------
    const doneMatcher = { listLeagueFixtures: jest.fn(async () => [candidate({ status: 'finished', homeScore: 110, awayScore: 102 })]) };
    const s2 = await executeShadowSweep({ matcher: doneMatcher });
    expect(s2.settled).toBe(1);
    expect(forwardTest.shadowSummary('basketball').games).toBe(1);

    // --- RESTART: drop every in-memory copy, reload from the file store -------
    forwardTest.reset();
    shadowHealth.reset();
    ledger.reset();
    forwardTest.init({ benchmarkLogLoss: 0.4303 });
    shadowHealth.init();
    ledger.init();

    // Rows survived...
    expect(forwardTest.status().rows).toBe(1);
    expect(forwardTest.status().shadowRows).toBe(1);
    // ...the OUTCOME survived (the row is still graded)...
    expect(forwardTest.shadowSummary('basketball').games).toBe(1);
    // ...the health counters survived (read from durable storage, not reset)...
    const health = await shadowHealth.readSnapshot();
    expect(health.sweeps).toBe(2);
    expect(health.last_row_logged_at_ms).not.toBe(null);
    expect(health.alert.kind).not.toBe('never_ran');
    // ...and the ledger's first post-freeze row is unchanged.
    expect(ledger.snapshot().first_post_freeze_row).toEqual(firstRow);

    // --- sweep 3 after the restart: the SAME live game must NOT duplicate -----
    const s3 = await executeShadowSweep({ matcher: { listLeagueFixtures: jest.fn(async () => [candidate()]) } });
    expect(s3.logged).toBe(0);
    expect(forwardTest.status().rows).toBe(1);
    expect(shadowHealth.snapshot().sweeps).toBe(3);
  });
});

/* --------------------------------------- league labels (round J item 6) */

describe('league display labels fall back to the configured list (round J item 6)', () => {
  test('a stored key with NO league_labels entry resolves to the exact configured code', () => {
    // The counters document as it would look BEFORE this round, or one whose
    // label entry is missing: the SANITISED keys are present but `league_labels`
    // is empty. The configured sweep list still knows the true 'sport/league'.
    const counters = { settled_games_by_league: { 'soccer::uefa_champions': 4 }, league_labels: {} };

    // No label recorded -> the CONFIGURED list supplies the real code, dot intact.
    expect(countersLib.labelFor(counters, 'soccer::uefa_champions')).toBe('soccer/uefa.champions');
    expect(countersLib.labelFor(counters, 'basketball::mens_college_basketball')).toBe('basketball/mens-college-basketball');

    // A RECORDED label still wins — it is the ground truth taken from the row.
    expect(countersLib.labelFor(
      { league_labels: { 'soccer::uefa_champions': 'custom/label' } },
      'soccer::uefa_champions',
    )).toBe('custom/label');

    // A key that matches NEITHER falls back to the sanitised form (last resort).
    expect(countersLib.labelFor({ league_labels: {} }, 'soccer::mystery_league')).toBe('soccer/mystery_league');

    console.log('[item6] labelFor(no label, soccer::uefa_champions) =', countersLib.labelFor(counters, 'soccer::uefa_champions'));
    console.log('[item6] labelFor(no label, basketball::mens_college_basketball) =', countersLib.labelFor(counters, 'basketball::mens_college_basketball'));
    console.log('[item6] labelFor(unmatched, soccer::mystery_league) =', countersLib.labelFor({ league_labels: {} }, 'soccer::mystery_league'));
  });
});

/* ----------------------------------------------------- adapter selection */

describe('the storage adapter is chosen by config (round G item 1)', () => {
  test('the file backend reports itself, and firestore is selectable without initialising', () => {
    const file = store.describe();
    expect(file.kind).toBe('file');
    expect(file.rows_file).toBe(TMP_FORWARD_FILE);

    // Selecting the firestore backend must not require firebase to be initialised
    // (it only resolves when a write is actually attempted).
    const fsStore = store.getStore({ kind: 'firestore' });
    expect(fsStore.kind).toBe('firestore');
    expect(fsStore.supportsSync).toBe(false);
    expect(fsStore.describe().kind).toBe('firestore');
    // A row's Firestore document id IS its idempotency key.
    expect(fsStore.docIdFor({ sport: 'basketball', league: 'nba', game_id: '401', grid_checkpoint: 0.625 }))
      .toBe('basketball|nba|401|0.625');
  });
});
