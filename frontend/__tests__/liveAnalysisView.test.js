/**
 * Frontend view-logic tests for Live Game Analysis.
 *
 * The behaviour that must never regress: when the backend's ship gate refuses,
 * the screen renders NO probability and NO projection — only score, clock and
 * facts — and says why. These run under Node's built-in test runner:
 *
 *   cd frontend && npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  VIEW_STATE,
  MESSAGES,
  describeLiveFailure,
  classifyResolveResult,
  classifyAnalysisResult,
  formatPercent,
  scoreLine,
  clockLine,
  showsProbabilities,
  manualBadge,
  manualBadgeDetail,
  shareText,
  withheldNotice,
  probabilityRows,
  resultLabel,
  pickRows,
  projectionRows,
  factors,
  contextBlock,
  keyEvents,
  injuries,
  pregameContext,
  contextUpdatedLabel,
  tierLabel,
  hasContext,
  refreshSeconds,
  shouldPoll,
  candidateOptions,
  isAutoResolvableLink,
  SCORE_SITE_HOSTS,
  SCORE_SITE_LABELS,
  WITHHELD_HINT,
} = require('../utils/liveAnalysisView');

/** An analysis payload from the backend, gate CLOSED (the current state). */
function withheldAnalysis(overrides = {}) {
  return {
    game_id: 'espn:900',
    sport: 'soccer',
    league: { id: 'eng.1', name: 'English Premier League' },
    home: { name: 'Manchester United', score: 1 },
    away: { name: 'Chelsea', score: 0 },
    live: { status: 'live', is_live: true, clock: "34'", period: 1 },
    data_tier: 'full_live',
    ship_gate: { allowed: false, reason: 'the soccer backtest has not passed the Phase 5 ship gate', decision: 'withheld' },
    display: { mode: 'context_only', shows_probabilities: false },
    probabilities: null,
    uncertainty: null,
    projection: null,
    probabilities_note: 'No validated live probability is available for this game yet.',
    factors: [{ label: 'Data quality', detail: 'Full live data' }],
    refresh: { suggested_seconds: 30, min_seconds: 15 },
    freshness: { age_seconds: 12, updated_label: 'updated 12s ago' },
    ...overrides,
  };
}

/** The same payload once a league has passed the gate. */
function shippedAnalysis(overrides = {}) {
  return withheldAnalysis({
    ship_gate: { allowed: true, reason: null, decision: 'shipped' },
    display: { mode: 'full', shows_probabilities: true },
    probabilities: { home_win: 0.62, draw: 0.23, away_win: 0.15 },
    uncertainty: { level: 0.8, total: { low: 1, high: 3 }, margin: { low: 0, high: 2 } },
    projection: {
      expected_final: { home: 2.1, away: 1.05, total: 3.15, margin: 1.05 },
      remaining: { home: 1.1, away: 1.05, total: 2.15 },
      next_goal: { home: 0.55, away: 0.3, none: 0.15 },
    },
    probabilities_note: null,
    ...overrides,
  });
}

test('classifyResolveResult maps each backend status to a UI state', () => {
  assert.equal(classifyResolveResult(null).state, VIEW_STATE.LOADING);

  const matched = classifyResolveResult({ status: 'matched', analysis: withheldAnalysis(), game: { game_id: 'espn:900' } });
  assert.equal(matched.state, VIEW_STATE.ANALYSIS);
  assert.equal(matched.analysis.game_id, 'espn:900');

  const candidates = classifyResolveResult({ status: 'candidates', candidates: [{ game_id: 'espn:1' }], reason: 'pick one' });
  assert.equal(candidates.state, VIEW_STATE.CANDIDATES);
  assert.equal(candidates.candidates.length, 1);

  const none = classifyResolveResult({ status: 'none', reason: 'no match', manual_entry_required: true });
  assert.equal(none.state, VIEW_STATE.NONE);
  assert.equal(none.manualEntry, true);
  assert.equal(none.message, 'no match');
});

test('an unavailable response becomes an ERROR with a code-specific message', () => {
  assert.equal(classifyResolveResult({ unavailable: true, code: 'NETWORK_ERROR' }).state, VIEW_STATE.ERROR);
  assert.equal(describeLiveFailure({ code: 'NETWORK_ERROR' }), MESSAGES.network);
  assert.equal(describeLiveFailure({ code: 'RATE_LIMITED' }), MESSAGES.rateLimited);
  assert.equal(describeLiveFailure({ code: 'FEATURE_DISABLED' }), MESSAGES.featureDisabled);
  assert.equal(describeLiveFailure({ code: 'MANUAL_ENTRY_DISABLED' }), MESSAGES.manualDisabled);
  assert.equal(describeLiveFailure({ code: 'GAME_NOT_RESOLVED' }), MESSAGES.notResolved);
  assert.equal(
    describeLiveFailure({ code: 'INVALID_MANUAL_ENTRY', errors: ['home score is required'] }),
    'home score is required',
  );
  assert.equal(describeLiveFailure({ code: 'WHAT', message: 'custom' }), 'custom');
});

test('classifyAnalysisResult recognises a good poll and an error', () => {
  assert.equal(classifyAnalysisResult(null).state, VIEW_STATE.LOADING);
  assert.equal(classifyAnalysisResult(withheldAnalysis()).state, VIEW_STATE.ANALYSIS);
  assert.equal(classifyAnalysisResult({ unavailable: true, code: 'GAME_NOT_RESOLVED' }).state, VIEW_STATE.ERROR);
});

test('WITHHELD: no probability and no projection are rendered, only facts', () => {
  const a = withheldAnalysis();
  assert.equal(showsProbabilities(a), false);
  assert.deepEqual(probabilityRows(a), []);
  assert.deepEqual(projectionRows(a), []);
  assert.match(withheldNotice(a), /ship gate/);

  // The facts are still present.
  assert.equal(scoreLine(a), '1 - 0');
  assert.equal(clockLine(a), "34' · P1");
  assert.equal(factors(a).length, 1);
});

test('SHIPPED: probabilities and the projection render', () => {
  const a = shippedAnalysis();
  assert.equal(showsProbabilities(a), true);
  assert.equal(withheldNotice(a), null);

  const rows = probabilityRows(a);
  assert.deepEqual(rows.map(r => r.label), ['Manchester United win', 'Draw', 'Chelsea win']);
  assert.equal(rows[0].display, '62.0%');

  const proj = projectionRows(a);
  assert.ok(proj.some(r => r.label === 'Projected total'));
  assert.ok(proj.some(r => r.label === 'Next goal'));
});

test('basketball exposes only the two-way outcomes it actually models', () => {
  const a = shippedAnalysis({
    sport: 'basketball',
    probabilities: { home_win: 0.58, away_win: 0.42 },
    projection: { expected_final: { home: 112, away: 106, total: 218, margin: 6 }, total_line: { line: 218, sigma: 16 }, margin_line: { line: 6, sigma: 11 } },
  });
  const rows = probabilityRows(a);
  assert.deepEqual(rows.map(r => r.key), ['home_win', 'away_win']);
  assert.ok(projectionRows(a).some(r => r.label === 'Total line'));
});

test('resultLabel names the picked outcome, or null when unrecognised', () => {
  assert.equal(resultLabel('home', 'Manchester United', 'Chelsea'), 'Manchester United win');
  assert.equal(resultLabel('away', 'Manchester United', 'Chelsea'), 'Chelsea win');
  assert.equal(resultLabel('draw', 'Manchester United', 'Chelsea'), 'Draw');
  assert.equal(resultLabel('x', 'A', 'B'), null);
});

test('WITHHELD: no pick rows render when the gate withholds', () => {
  assert.deepEqual(pickRows(withheldAnalysis()), []);
  assert.deepEqual(pickRows(null), []);
});

test('SHIPPED: the match-result and Over/Under picks render with their confidence', () => {
  const a = shippedAnalysis({
    picks: {
      match_result: { market: '1x2', selection: 'home', probability: 0.62 },
      over_under: { market: 'over_under', line: 2.5, selection: 'over', probability: 0.54, over: 0.54, under: 0.46 },
    },
  });
  const rows = pickRows(a);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].key, 'match_result');
  assert.equal(rows[0].market, 'Match result');
  assert.equal(rows[0].label, 'Manchester United win');
  assert.equal(rows[0].display, '62.0%');
  assert.equal(rows[1].key, 'over_under');
  assert.equal(rows[1].market, 'Total');
  assert.equal(rows[1].label, 'Over 2.5');
  assert.equal(rows[1].display, '54.0%');
});

test('a basketball pick labels the winner market without a draw', () => {
  const a = shippedAnalysis({
    sport: 'basketball',
    probabilities: { home_win: 0.58, away_win: 0.42 },
    picks: {
      match_result: { market: 'moneyline', selection: 'away', probability: 0.42 },
      over_under: { market: 'over_under', line: 218.5, selection: 'under', probability: 0.6 },
    },
  });
  const rows = pickRows(a);
  assert.equal(rows[0].market, 'Winner');
  assert.equal(rows[0].label, 'Chelsea win');
  assert.equal(rows[0].display, '42.0%');
  assert.equal(rows[1].label, 'Under 218.5');
  assert.equal(rows[1].display, '60.0%');
});

test('a pick that could not be priced is omitted, never a placeholder', () => {
  const a = shippedAnalysis({
    picks: {
      match_result: null,
      over_under: { market: 'over_under', line: 2.5, selection: 'over', probability: 0.54 },
    },
  });
  const rows = pickRows(a);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'over_under');
});

test('SHIPPED: corner and shot picks render alongside the main picks', () => {
  const a = shippedAnalysis({
    picks: {
      match_result: { market: 'double_chance', selection: '1x', probability: 0.92 },
      over_under: { market: 'over_under', line: 2.5, selection: 'over', probability: 0.54, over: 0.54, under: 0.46 },
      corners: { market: 'corners', line: 8.5, selection: 'over', probability: 0.71, over: 0.71, under: 0.29 },
      shots: { market: 'shots', line: 21.5, selection: 'under', probability: 0.58, over: 0.42, under: 0.58 },
    },
  });
  const rows = pickRows(a);
  assert.deepEqual(rows.map(r => r.key), ['match_result', 'over_under', 'corners', 'shots']);
  const corners = rows.find(r => r.key === 'corners');
  assert.equal(corners.market, 'Corners');
  assert.equal(corners.label, 'Over 8.5');
  assert.equal(corners.display, '71.0%');
  const shots = rows.find(r => r.key === 'shots');
  assert.equal(shots.market, 'Shots');
  assert.equal(shots.label, 'Under 21.5');
  assert.equal(shots.display, '58.0%');
});

test('SHIPPED: a missing corner/shot pick is omitted, never a placeholder', () => {
  const a = shippedAnalysis({
    picks: {
      match_result: null,
      over_under: { market: 'over_under', line: 2.5, selection: 'over', probability: 0.54 },
      corners: null,
      shots: null,
    },
  });
  const rows = pickRows(a);
  assert.deepEqual(rows.map(r => r.key), ['over_under']);
});

test('formatPercent is null-safe and honest about missing numbers', () => {
  assert.equal(formatPercent(0.6234), '62.3%');
  assert.equal(formatPercent(0), '0.0%');
  assert.equal(formatPercent(null), null);
  assert.equal(formatPercent('x'), null);
});

test('clockLine distinguishes live, finished, scheduled and a missing clock', () => {
  assert.equal(clockLine({ live: { status: 'finished' } }), 'Finished');
  assert.equal(clockLine({ live: { status: 'scheduled' } }), 'Not started');
  assert.equal(clockLine({ live: { status: 'live', clock: "60'", period: 2 } }), "60' · P2");
  assert.equal(clockLine({ live: { status: 'live', clock: null, period: 0 } }), 'Clock unavailable');
});

test('clockLine shows a server-derived clock, labelled as an estimate', () => {
  // A source that publishes no clock (FlashScore) still gets one derived from
  // kick-off; it is shown, but only ever labelled "(est.)".
  assert.equal(
    clockLine({ live: { status: 'live', clock: null, period: 0, derived_clock: { clock: "57'", period: 2 } } }),
    "57' · P2 (est.)",
  );
  assert.equal(
    clockLine({ live: { status: 'live', clock: null, derived_clock: { clock: "34'", period: 0 } } }),
    "34' (est.)",
  );
  // A source-reported clock always wins over a derived one.
  assert.equal(
    clockLine({ live: { status: 'live', clock: "60'", period: 2, derived_clock: { clock: "57'", period: 2 } } }),
    "60' · P2",
  );
});

test('clockLine shows basketball time in quarters, e.g. 6\'-Q1', () => {
  assert.equal(
    clockLine({ sport: 'basketball', live: { status: 'live', clock: '6:24', period: 3 } }),
    '6:24-Q3',
  );
  assert.equal(
    clockLine({ sport: 'basketball', live: { status: 'live', clock: null, period: 0, derived_clock: { clock: "6'", period: 1 } } }),
    "6'-Q1 (est.)",
  );
  // Overtime reads OT rather than a fifth quarter.
  assert.equal(
    clockLine({ sport: 'basketball', live: { status: 'live', clock: null, period: 0, derived_clock: { clock: "3'", period: 5 } } }),
    "3'-OT (est.)",
  );
});

test('refreshSeconds honours the backend floor', () => {
  assert.equal(refreshSeconds({ refresh: { suggested_seconds: 30, min_seconds: 15 } }), 30);
  assert.equal(refreshSeconds({ refresh: { suggested_seconds: 5, min_seconds: 15 } }), 15);
  assert.equal(refreshSeconds({}), 30);
});

test('shouldPoll keeps polling a live game and stops once it is finished', () => {
  assert.equal(shouldPoll(withheldAnalysis()), true);
  assert.equal(shouldPoll(withheldAnalysis({ live: { status: 'finished' } })), false);
  assert.equal(shouldPoll(null), false);
});

test('candidateOptions turn candidate games into pickable rows', () => {
  const opts = candidateOptions({
    status: 'candidates',
    candidates: [
      { game_id: 'espn:1', home: { name: 'A' }, away: { name: 'B' }, league: { name: 'L' }, live: { status: 'live', clock: "20'", period: 1 }, match: { confidence: 0.7 } },
      { game_id: 'espn:2', home: { name: 'C' }, away: { name: 'D' }, league: { name: 'L' }, live: { status: 'live' }, match: null },
    ],
  });
  assert.equal(opts.length, 2);
  assert.equal(opts[0].gameId, 'espn:1');
  assert.equal(opts[0].label, 'A vs B');
  assert.equal(opts[0].clock, "20' · P1");
  assert.equal(opts[0].confidence, 0.7);
  assert.equal(opts[1].confidence, null);
});

/** A hand-typed analysis: always context-only, always badged. */
function manualAnalysis(overrides = {}) {
  return withheldAnalysis({
    manual: true,
    manual_badge: 'User-entered, unverified',
    manual_badge_detail: 'These values were typed in by hand.',
    league: { id: null, name: null },
    data_tier: 'user_entered',
    ...overrides,
  });
}

test('the manual badge is permanent and present regardless of the ship gate', () => {
  const a = manualAnalysis();
  assert.equal(manualBadge(a), 'User-entered, unverified');
  assert.equal(manualBadgeDetail(a), 'These values were typed in by hand.');

  // A provider game never carries the badge, even when its figures are withheld.
  assert.equal(manualBadge(withheldAnalysis()), null);
  assert.equal(manualBadgeDetail(withheldAnalysis()), null);
  assert.equal(manualBadge(null), null);

  // The badge survives the payload omitting the wording (view-side fallback).
  const bare = manualAnalysis({ manual_badge: undefined, manual_badge_detail: undefined });
  assert.equal(manualBadge(bare), 'User-entered, unverified');
  assert.equal(manualBadgeDetail(bare), null);
});

test('a hand-typed game never renders a probability or a projection', () => {
  const a = manualAnalysis();
  assert.equal(showsProbabilities(a), false);
  assert.deepEqual(probabilityRows(a), []);
  assert.deepEqual(projectionRows(a), []);
});

test('shareText prepends the badge for a hand-typed game and only then', () => {
  const manual = shareText(manualAnalysis());
  assert.match(manual, /^\[User-entered, unverified\] /);
  assert.match(manual, /Manchester United 1 - 0 Chelsea/);

  const provider = shareText(withheldAnalysis());
  assert.ok(!provider.includes('unverified'));
  assert.match(provider, /^Manchester United 1 - 0 Chelsea/);

  assert.equal(shareText(null), '');
});

/** A held-sport analysis carrying the Phase 9 context block. */
function contextAnalysis(overrides = {}) {
  return withheldAnalysis({
    sport: 'basketball',
    data_tier_label: 'Full live data',
    context: {
      available: true,
      source: 'espn',
      summary_available: true,
      key_events: [
        { clock: '7:24', period: 3, team: 'Lakers', type: '3PT Jumper', text: 'makes three', scoring: true },
        { clock: '6:10', period: 3, team: 'Celtics', type: 'Turnover', text: 'bad pass', scoring: false },
      ],
      injuries: [
        { playerName: 'A. Player', position: 'SF', teamName: 'Lakers', status: 'questionable', detail: 'Ankle' },
      ],
      pregame: {
        venue: 'Crypto.com Arena',
        kickoff: '2026-11-08T02:00:00Z',
        home: { name: 'Lakers', record: '6-3' },
        away: { name: 'Celtics', record: '7-2' },
      },
      freshness: { age_seconds: 8, is_stale: false, updated_label: 'updated 8s ago' },
      updated_label: 'updated 8s ago',
    },
    ...overrides,
  });
}

test('key events render newest-first with a when label and a scoring flag', () => {
  const evs = keyEvents(contextAnalysis());
  assert.equal(evs.length, 2);
  assert.equal(evs[0].when, '7:24 · P3');
  assert.equal(evs[0].team, 'Lakers');
  assert.equal(evs[0].what, '3PT Jumper');
  assert.equal(evs[0].detail, 'makes three');
  assert.equal(evs[0].scoring, true);
  assert.equal(evs[1].scoring, false);
});

test('an event with no clock still renders, just without a time', () => {
  const a = contextAnalysis({
    context: { key_events: [{ team: 'Lakers', type: 'Timeout', scoring: false }] },
  });
  const evs = keyEvents(a);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].when, '');
  assert.equal(evs[0].what, 'Timeout');
});

test('injuries always name a player, with a safe fallback', () => {
  const list = injuries(contextAnalysis());
  assert.equal(list.length, 1);
  assert.equal(list[0].who, 'A. Player');
  assert.equal(list[0].position, 'SF');
  assert.equal(list[0].status, 'questionable');

  const bare = injuries(contextAnalysis({ context: { injuries: [{ teamName: 'Lakers' }] } }));
  assert.equal(bare[0].who, 'Unknown player');
});

test('pre-game context becomes label/value lines, or null when nothing is known', () => {
  const pg = pregameContext(contextAnalysis());
  assert.ok(pg);
  const labels = pg.lines.map(l => l.label);
  assert.deepEqual(labels, ['Venue', 'Kick-off', 'Lakers record', 'Celtics record']);
  assert.equal(pg.lines[0].value, 'Crypto.com Arena');

  // A game with no venue, kickoff or records drops the block entirely.
  assert.equal(pregameContext(contextAnalysis({ context: { pregame: null } })), null);
  assert.equal(pregameContext(withheldAnalysis()), null);
});

test('the tier label and the summary "updated" label both come from the payload', () => {
  const a = contextAnalysis();
  assert.equal(tierLabel(a), 'Full live data');
  assert.equal(contextUpdatedLabel(a), 'updated 8s ago');
  assert.equal(tierLabel(withheldAnalysis()), null);
  assert.equal(contextUpdatedLabel(withheldAnalysis()), null);
});

test('hasContext is true only when something is actually worth showing', () => {
  assert.equal(hasContext(contextAnalysis()), true);
  assert.equal(hasContext(contextAnalysis({ context: { key_events: [], injuries: [], pregame: null } })), false);
  assert.equal(hasContext(withheldAnalysis()), false);
  assert.equal(hasContext(null), false);
});

test('a missing context block degrades to empty sections rather than throwing', () => {
  const a = withheldAnalysis({ context: undefined });
  assert.equal(contextBlock(a), null);
  assert.deepEqual(keyEvents(a), []);
  assert.deepEqual(injuries(a), []);
  assert.equal(pregameContext(a), null);
  assert.equal(hasContext(a), false);
});

test('isAutoResolvableLink fires only for a complete LiveScore / FlashScore link', () => {
  // The two score sites — the ones the live feed can answer for — auto-resolve.
  assert.equal(isAutoResolvableLink(
    'https://www.livescore.com/en/football/england/premier-league/group-stage/arsenal-chelsea/12345/',
  ), true);
  assert.equal(isAutoResolvableLink('https://www.flashscore.com/match/abc123/'), true);
  // Sub-domains and http both count.
  assert.equal(isAutoResolvableLink('https://m.flashscore.com/match/abc123/'), true);
  assert.equal(isAutoResolvableLink('http://www.livescore.com/en/football/england/x/1/'), true);
  // Surrounding whitespace from a paste is tolerated.
  assert.equal(isAutoResolvableLink('  https://www.livescore.com/en/football/england/x/1/  '), true);

  // A bare host with no path is a link still being typed, not a paste.
  assert.equal(isAutoResolvableLink('https://www.livescore.com'), false);
  assert.equal(isAutoResolvableLink('https://www.livescore.com/'), false);
  // Other sites keep waiting for the Analyse button.
  assert.equal(isAutoResolvableLink('https://example.com/football/a-vs-b'), false);
  // Near-miss hosts that merely CONTAIN the name are not the site.
  assert.equal(isAutoResolvableLink('https://notlivescore.com/en/x/1/'), false);
  assert.equal(isAutoResolvableLink('https://livescore.com.evil.example/en/x/1/'), false);
  // Junk and non-strings are refused, never thrown.
  assert.equal(isAutoResolvableLink('not a link'), false);
  assert.equal(isAutoResolvableLink(''), false);
  assert.equal(isAutoResolvableLink(null), false);
  assert.equal(isAutoResolvableLink(undefined), false);
});

test('the score-site prompt names exactly the two hosts the analysis accepts', () => {
  // The hint the screen shows, and the host list the auto-resolve uses, must
  // stay in lockstep — otherwise the prompt advertises a site the feed cannot
  // answer for (or hides one it can).
  assert.deepEqual(SCORE_SITE_LABELS.map(s => s.host), [...SCORE_SITE_HOSTS]);
  assert.deepEqual(SCORE_SITE_HOSTS, ['livescore.com', 'flashscore.com']);
  SCORE_SITE_LABELS.forEach(site => {
    assert.ok(site.name);
    assert.ok(SCORE_SITE_HOSTS.includes(site.host));
  });
});

test('the withheld hint is present whenever the gate withholds, and absent when it ships', () => {
  // The standing explanation is a fixed string the screen renders under the
  // gate reason, so a reader never reads "withheld" as "broken".
  assert.equal(typeof WITHHELD_HINT, 'string');
  assert.ok(WITHHELD_HINT.length > 0);
  assert.ok(/backtest/i.test(WITHHELD_HINT));

  // It is the withheld (gate-closed) case that shows it; a shipped payload does
  // not, because probabilities render instead.
  assert.equal(showsProbabilities(withheldAnalysis()), false);
  assert.ok(withheldNotice(withheldAnalysis()));
  assert.equal(showsProbabilities(shippedAnalysis()), true);
  assert.equal(withheldNotice(shippedAnalysis()), null);
});
