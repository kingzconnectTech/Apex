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

// uuid ships as ESM; the scheduler only uses it for a trace id, which is
// irrelevant to the sweep's behaviour.
jest.mock('uuid', () => ({ v4: () => 'test-trace-id' }));

const cron = require('node-cron');
const CONFIG = require('../services/live/config');
const forwardTest = require('../services/live/forwardTest');
const { startLiveShadowScheduler } = require('../services/live/shadowScheduler');

const COMMITTED_FORWARD_FILE = CONFIG.live.forwardTest.file;
const TMP_FORWARD_FILE = path.join(os.tmpdir(), `live-forward-shadow-${process.pid}.json`);

beforeEach(() => {
  cron.schedule.mockClear();
  try { fs.unlinkSync(TMP_FORWARD_FILE); } catch (err) { /* absent is fine */ }
  CONFIG.live.forwardTest.file = TMP_FORWARD_FILE;
  forwardTest.init({ benchmarkLogLoss: 0.4303 });
});

afterEach(() => {
  CONFIG.live.forwardTest.file = COMMITTED_FORWARD_FILE;
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
