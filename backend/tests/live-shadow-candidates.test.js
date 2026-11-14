/**
 * Phase 10 — the frozen shadow-candidate scorer.
 *
 * services/live/shadowCandidates reads a versioned, never-refit artifact and
 * scores the candidate columns at a shadow row's checkpoint. These tests pin:
 *   - it never throws and never invents a number (null when the artifact is
 *     missing or a candidate cannot be scored);
 *   - the basketball logistic uses the artifact's per-league period structure;
 *   - the soccer empirical table reads the fixed cell;
 *   - the soccer multinomial logistic uses the stored standardiser + weights.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG = require('../services/live/config');
const shadowCandidates = require('../services/live/shadowCandidates');

const TMP = path.join(os.tmpdir(), `live-shadow-candidates-${process.pid}.json`);
const ORIGINAL = CONFIG.live.shadow.candidates.file;

function writeArtifact(obj) {
  fs.writeFileSync(TMP, JSON.stringify(obj));
  shadowCandidates.reset();
}

beforeEach(() => {
  CONFIG.live.shadow.candidates.file = TMP;
  shadowCandidates.reset();
});

afterEach(() => {
  CONFIG.live.shadow.candidates.file = ORIGINAL;
  shadowCandidates.reset();
  try { fs.unlinkSync(TMP); } catch (err) { /* absent is fine */ }
});

function basketballGame(over = {}) {
  return {
    game_id: 'espn:1',
    sport: 'basketball',
    source: 'espn',
    league: { id: 'nba', name: 'NBA' },
    home: { score: 70 },
    away: { score: 66 },
    live: { status: 'live', clock: '7:24', period: 3 },
    ...over,
  };
}

function soccerGame(over = {}) {
  return {
    game_id: 'espn:2',
    sport: 'soccer',
    source: 'espn',
    league: { id: 'eng.1', name: 'EPL' },
    home: { score: 2 },
    away: { score: 1 },
    live: { status: 'live', clock: "30'", period: 1 },
    ...over,
  };
}

test('a missing artifact yields no candidate columns and never throws', () => {
  expect(shadowCandidates.candidatesFor({ game: basketballGame() })).toBeNull();
  expect(shadowCandidates.version()).toBeNull();
});

test('the basketball logistic scores from the artifact parameters', () => {
  writeArtifact({
    version: 'test-1',
    basketball_logistic: {
      id: 'bb',
      sportWide: { intercept: 0.2, slope: 0.6 },
      leagues: { nba: { periods: 4, periodMinutes: 12 } },
      byLeague: { nba: { intercept: 0.2, slope: 0.6 } },
    },
  });
  const out = shadowCandidates.candidatesFor({ game: basketballGame() });
  expect(out.version).toBe('test-1');
  expect(out.basketball_logistic).toBeGreaterThan(0);
  expect(out.basketball_logistic).toBeLessThan(1);
  // x = margin / sqrt(remaining) with remaining = (4 - 3) * 12 + 7.4 = 19.4.
  const expected = 1 / (1 + Math.exp(-(0.2 + 0.6 * (4 / Math.sqrt(19.4)))));
  expect(out.basketball_logistic).toBeCloseTo(Number(expected.toFixed(4)), 4);
});

test('the soccer empirical table reads the fixed cell', () => {
  writeArtifact({
    version: 'test-1',
    soccer_table: { id: 'st', table: { '30|none|1': { home: 0.62, draw: 0.24, away: 0.14, n: 400 } } },
  });
  const out = shadowCandidates.candidatesFor({ game: soccerGame() });
  expect(out.soccer_table).toEqual({ home: 0.62, draw: 0.24, away: 0.14, minute: 30 });
});

test('the soccer multinomial logistic uses the stored standardiser and weights', () => {
  writeArtifact({
    version: 'test-1',
    soccer_mnl: {
      id: 'mnl',
      mu: [0, 0.5, 0, 0, 2],
      sd: [1, 1, 1, 1, 1],
      weights: { home: [0, 1, 0, 0, 0, 0], draw: [0, 0, 0, 0, 0, 0], away: [0, -1, 0, 0, 0, 0] },
    },
  });
  const out = shadowCandidates.candidatesFor({ game: soccerGame() });
  const { home, draw, away } = out.soccer_mnl;
  expect(home).toBeGreaterThan(away);
  expect(home + draw + away).toBeCloseTo(1, 3);
});

test('the dispatcher returns null for a sport it cannot score', () => {
  writeArtifact({ version: 'test-1', basketball_logistic: { id: 'bb', sportWide: { intercept: 0.2, slope: 0.6 } } });
  expect(shadowCandidates.candidatesFor({ game: soccerGame({ sport: 'hockey' }) })).toBeNull();
});

/* --- round D: ids on every row, the clip band, thin cells, freeze instant --- */

test('every scored row carries the frozen candidate ids', () => {
  writeArtifact({
    version: 'shadow-candidates-1.0.0',
    basketball_logistic: { id: '33f1a9025999', sportWide: { intercept: 0.2, slope: 0.6 } },
    soccer_table: { id: '019d7e0afab3', table: { '30|none|1': { home: 0.6, draw: 0.25, away: 0.15 } } },
    soccer_mnl: { id: '11837341b3fd', mu: [0, 0.5, 0, 0, 2], sd: [1, 1, 1, 1, 1], weights: { home: [0, 1, 0, 0, 0, 0], draw: [0, 0, 0, 0, 0, 0], away: [0, -1, 0, 0, 0, 0] } },
    soccer_score_time: { id: '213f7dd0a1d8' },
  });
  const out = shadowCandidates.candidatesFor({ game: soccerGame() });
  expect(out.ids).toEqual({
    version: 'shadow-candidates-1.0.0',
    basketball_logistic: '33f1a9025999',
    soccer_table: '019d7e0afab3',
    soccer_mnl: '11837341b3fd',
    soccer_score_time: '213f7dd0a1d8',
  });
});

test('an extreme probability is clipped into [0.01, 0.99], never 0 or 1', () => {
  writeArtifact({
    version: 'test-1',
    basketball_logistic: { id: 'bb', sportWide: { intercept: 100, slope: 0 } },
  });
  expect(shadowCandidates.candidatesFor({ game: basketballGame() }).basketball_logistic).toBe(0.99);

  writeArtifact({
    version: 'test-1',
    basketball_logistic: { id: 'bb', sportWide: { intercept: -100, slope: 0 } },
  });
  expect(shadowCandidates.candidatesFor({ game: basketballGame() }).basketball_logistic).toBe(0.01);
});

test('a soccer table cell with fewer than 30 raw rows is flagged thin', () => {
  const cell = { home: 0.6, draw: 0.25, away: 0.15 };
  writeArtifact({
    version: 'test-1',
    soccer_table: { id: 'st', minCell: 30, table: { '30|none|1': cell } },
    // Raw per-cell counts live OUTSIDE the hashed block.
    table_thin_cells: { '30|none|1': 12 },
  });
  expect(shadowCandidates.candidatesFor({ game: soccerGame() }).soccer_table.thin).toBe(true);

  writeArtifact({
    version: 'test-1',
    soccer_table: { id: 'st', minCell: 30, table: { '30|none|1': cell } },
    table_thin_cells: { '30|none|1': 120 },
  });
  expect(shadowCandidates.candidatesFor({ game: soccerGame() }).soccer_table.thin).toBeUndefined();
});

test('frozenAt reads the artifact freeze instant, defaulting nothing', () => {
  const ms = Date.parse('2026-11-12T00:00:00.000Z');
  writeArtifact({ version: 'test-1', frozen_at: '2026-11-12T00:00:00.000Z', frozen_at_ms: ms });
  expect(shadowCandidates.frozenAt()).toEqual({ iso: '2026-11-12T00:00:00.000Z', ms });
});
