/**
 * Frontend view-logic tests for the Live Matches screen.
 *
 * The behaviour that must never regress:
 *   - a match is shown as live ONLY when the backend marked it live;
 *   - "every source failed" (degraded) is an EMPTY state with a reason, not a
 *     hard network error;
 *   - a link the backend refused is never reported as openable, and an unknown
 *     host is never presented as a known site.
 *
 * These run under Node's built-in test runner:
 *
 *   cd frontend && npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  VIEW_STATE,
  MESSAGES,
  describeMatchesFailure,
  classifyMatchesResult,
  matchView,
  matchRows,
  scoreLine,
  statusLabel,
  isLive,
  refreshSeconds,
  updatedLabel,
  siteOptions,
  sourceSummary,
  classifyValidation,
  validateInput,
} = require('../utils/liveMatchesView');

/** A matches payload with one in-play game, shaped like the backend's. */
function payload(overrides = {}) {
  return {
    enabled: true,
    count: 1,
    fetched_at: '2026-11-17T15:30:00.000Z',
    degraded: false,
    refresh: { suggested_seconds: 30, min_seconds: 15 },
    sources: [{ id: 'livescore', name: 'LiveScore', ok: true, count: 1, error: null }],
    sites: [
      { id: 'flashscore', name: 'FlashScore', host: 'flashscore.com', home: 'https://m.flashscore.com/' },
    ],
    matches: [{
      id: 'livescore:9',
      source: 'livescore',
      source_name: 'LiveScore',
      sport: 'soccer',
      sport_label: 'Football',
      league: 'Premier League',
      country: 'England',
      home: { name: 'Arsenal', score: 2 },
      away: { name: 'Chelsea', score: 1 },
      status: { code: '2H', label: '2nd half', live: true },
      start_time: '2026-11-17T15:30:00.000Z',
      url: 'https://www.livescore.com/en/9/',
      links: [{ source: 'livescore', source_name: 'LiveScore', url: 'https://www.livescore.com/en/9/' }],
    }],
    ...overrides,
  };
}

/* ------------------------------------------------------------- failures */

test('describeMatchesFailure maps each backend code to a specific sentence', () => {
  assert.equal(describeMatchesFailure({ code: 'NETWORK_ERROR' }), MESSAGES.network);
  assert.equal(describeMatchesFailure({ code: 'RATE_LIMITED' }), MESSAGES.rateLimited);
  assert.equal(describeMatchesFailure({ code: 'MATCHES_DISABLED' }), MESSAGES.disabled);
  assert.equal(describeMatchesFailure({ code: 'MATCHES_UNAVAILABLE' }), MESSAGES.unavailable);
  assert.equal(describeMatchesFailure({ code: 'WAT' }), MESSAGES.generic);
  assert.equal(describeMatchesFailure({ message: 'custom' }), 'custom');
});

/* --------------------------------------------------- classifyMatchesResult */

test('a null result is LOADING — nothing has answered yet', () => {
  const r = classifyMatchesResult(null);
  assert.equal(r.state, VIEW_STATE.LOADING);
  assert.deepEqual(r.matches, []);
});

test('an unavailable response becomes an ERROR with a code-specific message', () => {
  const r = classifyMatchesResult({ unavailable: true, code: 'NETWORK_ERROR' });
  assert.equal(r.state, VIEW_STATE.ERROR);
  assert.equal(r.message, MESSAGES.network);
});

test('an empty list is EMPTY with the plain message', () => {
  const r = classifyMatchesResult(payload({ matches: [], count: 0 }));
  assert.equal(r.state, VIEW_STATE.EMPTY);
  assert.equal(r.message, MESSAGES.empty);
  assert.equal(r.degraded, false);
});

test('degraded (every source failed) is EMPTY with the reason, not an ERROR', () => {
  const r = classifyMatchesResult(payload({
    matches: [], count: 0, degraded: true,
    sources: [{ id: 'livescore', name: 'LiveScore', ok: false, count: 0, error: 'HTTP 503' }],
  }));
  assert.equal(r.state, VIEW_STATE.EMPTY);
  assert.equal(r.message, MESSAGES.degraded);
  assert.equal(r.degraded, true);
  assert.equal(r.sources[0].ok, false);
});

test('a populated payload is READY and carries shaped rows, sites and refresh', () => {
  const r = classifyMatchesResult(payload());
  assert.equal(r.state, VIEW_STATE.READY);
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].homeName, 'Arsenal');
  assert.equal(r.matches[0].isLive, true);
  assert.equal(r.sites[0].id, 'flashscore');
  assert.deepEqual(r.refresh, { suggested_seconds: 30, min_seconds: 15 });
});

/* -------------------------------------------------------------- matchView */

test('matchView falls back to "Unknown" and "-" and never invents liveness', () => {
  const v = matchView({ status: { code: 'NS', live: false } });
  assert.equal(v.homeName, 'Unknown');
  assert.equal(v.awayName, 'Unknown');
  assert.equal(v.score, '- - -');
  assert.equal(v.isLive, false);
  assert.equal(v.statusLabel, 'NS');
});

test('scoreLine prints real scores and dashes only for a genuinely missing one', () => {
  assert.equal(scoreLine({ home: { score: 2 }, away: { score: 1 } }), '2 - 1');
  assert.equal(scoreLine({ home: { score: 0 }, away: { score: 0 } }), '0 - 0');
  assert.equal(scoreLine({ home: {}, away: { score: 3 } }), '- - 3');
});

test('statusLabel prefers the backend label, then the code, then a live fallback', () => {
  assert.equal(statusLabel({ status: { label: 'Half time' } }), 'Half time');
  assert.equal(statusLabel({ status: { code: 'OT' } }), 'OT');
  assert.equal(statusLabel({ status: { live: false } }), MESSAGES.notStarted);
  assert.equal(statusLabel({ status: {} }), 'Live');
});

test('isLive is true only when the backend set status.live === true', () => {
  assert.equal(isLive({ status: { live: true } }), true);
  assert.equal(isLive({ status: { live: false } }), false);
  assert.equal(isLive({ status: {} }), false);
  assert.equal(isLive(null), false);
});

test('matchRows shapes every match and tolerates a missing list', () => {
  assert.equal(matchRows(payload()).length, 1);
  assert.deepEqual(matchRows(null), []);
  assert.deepEqual(matchRows({}), []);
});

test('matchView exposes every site that has the game as links', () => {
  const v = matchView(payload().matches[0]);
  assert.equal(v.links.length, 1);
  assert.equal(v.links[0].sourceName, 'LiveScore');
});

/* -------------------------------------------------------------- refresh */

test('refreshSeconds clamps to the backend floor', () => {
  assert.equal(refreshSeconds({ refresh: { suggested_seconds: 30, min_seconds: 15 } }), 30);
  assert.equal(refreshSeconds({ refresh: { suggested_seconds: 5, min_seconds: 15 } }), 15);
  assert.equal(refreshSeconds(null), 30);
  assert.equal(refreshSeconds({ refresh: {} }), 30);
});

test('updatedLabel renders just now / seconds / minutes', () => {
  const at = '2026-11-17T15:30:00.000Z';
  const t = Date.parse(at);
  assert.equal(updatedLabel({ fetched_at: at }, t + 1000), 'updated just now');
  assert.equal(updatedLabel({ fetched_at: at }, t + 12000), 'updated 12s ago');
  assert.equal(updatedLabel({ fetched_at: at }, t + 120000), 'updated 2m ago');
  assert.equal(updatedLabel({}, t), null);
  assert.equal(updatedLabel({ fetched_at: 'not-a-date' }, t), null);
});

/* ---------------------------------------------------------- siteOptions */

test('siteOptions prefers the payload list, then the capabilities list', () => {
  const caps = { matches: { sites: [{ id: 'livescore', name: 'LiveScore' }] } };
  assert.equal(siteOptions(caps)[0].id, 'livescore');
  // payload wins
  assert.equal(siteOptions(caps, payload())[0].id, 'flashscore');
  // nothing anywhere -> empty, never throws
  assert.deepEqual(siteOptions(null), []);
  assert.deepEqual(siteOptions({}), []);
});

test('sourceSummary reports per-source ok/count/error', () => {
  const s = sourceSummary({
    sources: [{ id: 'flashscore', name: 'FlashScore', ok: false, count: 0, error: 'HTTP 500' }],
  });
  assert.equal(s[0].ok, false);
  assert.equal(s[0].error, 'HTTP 500');
});

/* --------------------------------------------------------- validation */

test('classifyValidation accepts a valid link and surfaces recognised/unknown', () => {
  const known = classifyValidation({
    valid: true, url: 'https://www.flashscore.com/match/a/', recognised: true, site_name: 'FlashScore',
  });
  assert.equal(known.ok, true);
  assert.equal(known.url, 'https://www.flashscore.com/match/a/');
  assert.equal(known.recognised, true);
  assert.equal(known.siteName, 'FlashScore');

  const unknown = classifyValidation({
    valid: true, url: 'https://example.com/live', recognised: false, note: 'not a known site',
  });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.recognised, false);
  assert.equal(unknown.note, 'not a known site');
});

test('classifyValidation turns a refused link into a message, never an open url', () => {
  const r = classifyValidation({ valid: false, reason: 'Only http and https links can be opened.' });
  assert.equal(r.ok, false);
  assert.equal(r.url, null);
  assert.equal(r.message, 'Only http and https links can be opened.');

  // A refusal with no reason still yields the generic invalid-link sentence.
  assert.equal(classifyValidation({ valid: false }).message, MESSAGES.invalidLink);
});

test('classifyValidation reports a network failure distinctly', () => {
  const r = classifyValidation({ unavailable: true, code: 'NETWORK_ERROR' });
  assert.equal(r.ok, false);
  assert.equal(r.message, MESSAGES.network);
});

test('validateInput refuses empty input locally, trims otherwise', () => {
  assert.equal(validateInput('').ok, false);
  assert.equal(validateInput('   ').ok, false);
  assert.equal(validateInput('').message, MESSAGES.noLink);

  const ok = validateInput('  https://www.livescore.com/en/  ');
  assert.equal(ok.ok, true);
  assert.equal(ok.value, 'https://www.livescore.com/en/');
});
