/**
 * Phase 9 — the shadow scheduler.
 *
 * A held sport must gather evidence whether or not a user happens to be
 * watching, so this job sweeps the shadow leagues on a fixed cadence and logs a
 * shadow row per live game (and settles finished ones), entirely independent of
 * any request. These tests drive the sweep directly (cron is mocked) with a stub
 * matcher, so no network and no real timer is involved.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('node-cron', () => ({
  schedule: jest.fn((expr, fn) => ({ expr, fn, stop: jest.fn() })),
}));

const cron = require('node-cron');
const CONFIG = require('../services/live/config');
const forwardTest = require('../services/live/forwardTest');
const shadowHealth = require('../services/live/shadowHealth');
const ledger = require('../services/live/ledger');
const store = require('../services/live/store');
const { startLiveShadowScheduler, executeShadowSweep } = require('../services/live/shadowScheduler');

const COMMITTED_FORWARD_FILE = CONFIG.live.forwardTest.file;
const COMMITTED_HEALTH_FILE = CONFIG.live.health.file;
const COMMITTED_LEDGER_FILE = CONFIG.live.store.ledger.file;
const stamp = `${process.pid}-${Math.random().toString(16).slice(2)}`;
const TMP_FORWARD_FILE = path.join(os.tmpdir(), `live-forward-shadow-${stamp}.json`);
// The sweep now records health on every run, so the committed health file must
// be redirected too — otherwise a test run would overwrite the production
// scheduler state that /api/live/stats reports.
const TMP_HEALTH_FILE = path.join(os.tmpdir(), `live-shadow-health-${stamp}.json`);
// The sweep ALSO records the first post-freeze row in the durable ledger
// (round G item 5). That must be redirected as well: un-redirected, this test's
// synthetic basketball row (candidate 401) would be written into the committed
// data/live-ledger.json as if it were the first real post-freeze evidence.
const TMP_LEDGER_FILE = path.join(os.tmpdir(), `live-shadow-ledger-${stamp}.json`);

function rm(file) { try { fs.unlinkSync(file); } catch (err) { /* absent is fine */ } }

beforeEach(() => {
  cron.schedule.mockClear();
  rm(TMP_FORWARD_FILE); rm(TMP_HEALTH_FILE); rm(TMP_LEDGER_FILE);
  CONFIG.live.forwardTest.file = TMP_FORWARD_FILE;
  CONFIG.live.health.file = TMP_HEALTH_FILE;
  CONFIG.live.store.ledger.file = TMP_LEDGER_FILE;
  CONFIG.live.store.kind = 'file';
  store.resetStore();
  shadowHealth.reset();
  forwardTest.reset();
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
  shadowHealth.reset();
  forwardTest.reset();
  ledger.reset();
  rm(TMP_FORWARD_FILE); rm(TMP_HEALTH_FILE); rm(TMP_LEDGER_FILE);
});

/** A matcher candidate shaped like matcher.listLeagueFixtures output. */
function candidate({ id = '401', status = 'live', homeScore = 70, awayScore = 66 } = {}) {
  return {
    source: 'espn',
    fixture: {
      sport: 'basketball',
      fixture: { id, status, clock: '7:24', period: 3, date: '2026-11-08T02:00:00Z', timestamp: 1700000000000, venue: 'Crypto.com Arena' },
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

/** The sweep callback captured by the mocked cron.schedule. */
function sweepFn() {
  expect(cron.schedule).toHaveBeenCalledTimes(1);
  return cron.schedule.mock.calls[0][1];
}

test('schedules one job and logs a shadow row for every live game', async () => {
  const matcher = { listLeagueFixtures: jest.fn(async () => [candidate()]) };
  const jobs = startLiveShadowScheduler({ sportsData: {}, logger: null, matcher });
  expect(jobs.length).toBe(1);

  await sweepFn()();

  expect(matcher.listLeagueFixtures).toHaveBeenCalledWith(
    expect.objectContaining({ sport: 'basketball', leagues: CONFIG.matcher.sweep.basketball }),
  );
  expect(forwardTest.status().shadowRows).toBe(1);
  // Not settled yet: the evidence exists but no game has a bound outcome.
  expect(forwardTest.shadowSummary('basketball').games).toBe(0);
});

test('settles a game that the sweep now reports as finished', async () => {
  const live = { listLeagueFixtures: jest.fn(async () => [candidate()]) };
  startLiveShadowScheduler({ sportsData: {}, logger: null, matcher: live });
  await sweepFn()();

  // A second sweep after the game has ended binds the outcome to its rows.
  const done = { listLeagueFixtures: jest.fn(async () => [candidate({ status: 'finished', homeScore: 110, awayScore: 102 })]) };
  startLiveShadowScheduler({ sportsData: {}, logger: null, matcher: done });
  await cron.schedule.mock.calls[1][1]();

  const summary = forwardTest.shadowSummary('basketball');
  expect(summary.games).toBe(1);
  expect(summary.rows).toBeGreaterThan(0);
});

test('does nothing when the scheduler is switched off', () => {
  const original = CONFIG.live.shadow.scheduler.enabled;
  CONFIG.live.shadow.scheduler.enabled = false;
  try {
    const jobs = startLiveShadowScheduler({ sportsData: {}, logger: null, matcher: { listLeagueFixtures: jest.fn() } });
    expect(jobs).toEqual([]);
    expect(cron.schedule).not.toHaveBeenCalled();
  } finally {
    CONFIG.live.shadow.scheduler.enabled = original;
  }
});

test('does not schedule when no matcher is available', () => {
  const jobs = startLiveShadowScheduler({ sportsData: {}, logger: null, matcher: null });
  expect(jobs).toEqual([]);
});

/* ------------------------------------------------ round H (items 2 and 4) */

test('a dry run reports the would-write counts and writes nothing', async () => {
  const matcher = { listLeagueFixtures: jest.fn(async ({ sport }) => (sport === 'basketball' ? [candidate()] : [])) };
  const result = await executeShadowSweep({ matcher, dryRun: true });

  expect(result.dry_run).toBe(true);
  expect(result.would_log).toBe(1);
  // It wrote nothing: no row, no forward file, no health state.
  expect(result.logged).toBe(0);
  expect(forwardTest.status().shadowRows).toBe(0);
  expect(fs.existsSync(TMP_FORWARD_FILE)).toBe(false);
  expect(fs.existsSync(TMP_HEALTH_FILE)).toBe(false);
});

test('an interrupted sweep persists what it logged, and a re-run resumes without duplicates', async () => {
  // A matcher whose fixture stream throws AFTER the first game — a provider that
  // drops mid-sweep, i.e. a caller whose request is cut off part-way through.
  function* interrupted() {
    yield candidate({ id: '601' });
    throw new Error('provider stream interrupted');
  }
  const broken = { listLeagueFixtures: jest.fn(async ({ sport }) => (sport === 'basketball' ? interrupted() : [])) };

  await expect(executeShadowSweep({ matcher: broken })).rejects.toThrow('provider stream interrupted');

  // The row logged BEFORE the interruption survived (flushed on the way out)...
  expect(forwardTest.status().shadowRows).toBe(1);
  expect(fs.existsSync(TMP_FORWARD_FILE)).toBe(true);

  // ...and a later, healthy sweep of the SAME game re-logs nothing: the storage
  // key (sport|league|game|grid_checkpoint) is idempotent, so the sweep resumes
  // rather than duplicating the checkpoint.
  const healthy = { listLeagueFixtures: jest.fn(async ({ sport }) => (sport === 'basketball' ? [candidate({ id: '601' })] : [])) };
  const result = await executeShadowSweep({ matcher: healthy });
  expect(result.logged).toBe(0);
  expect(forwardTest.status().shadowRows).toBe(1);
});

/* --------------------------------------------- round I (item 2): ordering */

test('a truncated sweep rotates through the live set so no game is starved', async () => {
  // SEVEN live games but a budget of THREE per call. Without ordering the cap
  // would be spent on the same leading games every call (they keep producing new
  // checkpoints as the clock moves) and the tail would never be logged. The
  // sweep now processes the LEAST-RECENTLY-LOGGED games first, so the budget
  // rotates and every game eventually gets its grid rows.
  const original = CONFIG.live.store.sweep.maxGamesPerCall;
  CONFIG.live.store.sweep.maxGamesPerCall = 3;
  try {
    const ids = ['701', '702', '703', '704', '705', '706', '707'];
    const matcher = {
      listLeagueFixtures: jest.fn(async ({ sport }) => (sport === 'basketball'
        ? ids.map(id => candidate({ id }))
        : [])),
    };

    // Three budget-3 calls must be enough to reach all seven games.
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await executeShadowSweep({ matcher });
    }

    // Every game got its row — none was starved by the truncation.
    const persisted = JSON.parse(fs.readFileSync(TMP_FORWARD_FILE, 'utf8'));
    const loggedGames = new Set(persisted.rows.map(r => r.game_id));
    ids.forEach(id => expect(loggedGames.has(`espn:${id}`)).toBe(true));
    expect(loggedGames.size).toBe(ids.length);
  } finally {
    CONFIG.live.store.sweep.maxGamesPerCall = original;
  }
});
