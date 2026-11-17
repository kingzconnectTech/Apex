/**
 * Frontend view-logic tests for the Admin Predictions system.
 *
 * These exercise the pure decision layer the Admin Picks screen, the upload
 * form and the management/history screens all share — labelling, filtering,
 * validation, duplicate detection and payload shaping — without a React Native
 * renderer. They run under Node's built-in test runner:
 *
 *   cd frontend && npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const view = require('../utils/adminPicksView');
const {
  COLLECTION,
  SPORTS,
  STATUS,
  STATUSES,
  VISIBILITY,
  validatePickForm,
  buildCreatePayload,
  buildUpdatePayload,
  isDuplicatePick,
  duplicateKey,
  pickMatchesSearch,
  applyUserFilter,
  applyManageFilters,
  leagueOptions,
  summarizePicks,
  sortPicks,
  pickToForm,
  formatMatchDateTime,
  dayKey,
  sanitizeText,
  normalizeStatus,
  statusLabel,
  isPublished,
  formatConfidence,
  confidenceBand,
} = view;

const FIXED_DATE = new Date(2026, 0, 5, 14, 30); // Mon, 5 Jan 2026 14:30 local

function validForm(overrides = {}) {
  return {
    sport: 'Football',
    league: 'Premier League',
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    matchDate: FIXED_DATE,
    market: 'Over/Under Goals',
    selection: 'Over 1.5 Goals',
    confidence: 92,
    analysis: 'Arsenal press high and Chelsea concede early goals.',
    ...overrides,
  };
}

function pick(overrides = {}) {
  return {
    id: 'p1',
    ...validForm(),
    status: STATUS.PENDING,
    visibility: VISIBILITY.PUBLISHED,
    ...overrides,
  };
}

/* ------------------------------------------------------------- collection */

test('uses only the dedicated admin_predictions collection', () => {
  assert.equal(COLLECTION, 'admin_predictions');
});

/* ------------------------------------------------------------- validation */

test('a complete form validates', () => {
  const { valid, errors, values } = validatePickForm(validForm());
  assert.equal(valid, true);
  assert.deepEqual(errors, {});
  assert.equal(values.confidence, 92);
  assert.equal(values.league, 'Premier League');
});

test('required fields are enforced', () => {
  const { valid, errors } = validatePickForm({});
  assert.equal(valid, false);
  for (const key of ['league', 'homeTeam', 'awayTeam', 'matchDate', 'market', 'selection', 'analysis']) {
    assert.ok(errors[key], `expected an error for ${key}`);
  }
});

test('confidence must be within 0 and 100', () => {
  assert.equal(validatePickForm(validForm({ confidence: 0 })).valid, true);
  assert.equal(validatePickForm(validForm({ confidence: 100 })).valid, true);
  assert.ok(validatePickForm(validForm({ confidence: -1 })).errors.confidence);
  assert.ok(validatePickForm(validForm({ confidence: 101 })).errors.confidence);
  assert.ok(validatePickForm(validForm({ confidence: '' })).errors.confidence);
  assert.ok(validatePickForm(validForm({ confidence: 'abc' })).errors.confidence);
});

test('the same home and away team is rejected', () => {
  const { errors } = validatePickForm(validForm({ awayTeam: 'arsenal' }));
  assert.ok(errors.awayTeam);
});

test('an invalid sport is rejected', () => {
  assert.ok(validatePickForm(validForm({ sport: 'Cricket' })).errors.sport);
  assert.ok(validatePickForm(validForm({ sport: 'Football' })).valid);
  assert.ok(validatePickForm(validForm({ sport: 'Basketball' })).valid);
});

test('an unparsable match date is rejected', () => {
  assert.ok(validatePickForm(validForm({ matchDate: 'not-a-date' })).errors.matchDate);
});

/* -------------------------------------------------------- payload shaping */

test('create payload always starts pending and carries the given visibility', () => {
  const draft = buildCreatePayload(validForm(), { visibility: VISIBILITY.DRAFT });
  assert.equal(draft.ok, true);
  assert.equal(draft.payload.status, STATUS.PENDING);
  assert.equal(draft.payload.visibility, VISIBILITY.DRAFT);
  assert.equal(draft.payload.confidence, 92);

  const published = buildCreatePayload(validForm(), { visibility: VISIBILITY.PUBLISHED });
  assert.equal(published.payload.visibility, VISIBILITY.PUBLISHED);
  assert.equal(published.payload.status, STATUS.PENDING);
});

test('create payload refuses an invalid form', () => {
  const result = buildCreatePayload({});
  assert.equal(result.ok, false);
  assert.ok(result.errors);
});

test('update payload never carries status, visibility or settlement fields', () => {
  const result = buildUpdatePayload(validForm({ selection: 'Over 2.5 Goals' }));
  assert.equal(result.ok, true);
  assert.equal(result.payload.selection, 'Over 2.5 Goals');
  for (const forbidden of ['status', 'visibility', 'createdBy', 'settledBy', 'settledAt', 'createdAt', 'updatedAt']) {
    assert.equal(Object.prototype.hasOwnProperty.call(result.payload, forbidden), false, `${forbidden} must not be editable`);
  }
});

/* ------------------------------------------------------------ duplicates */

test('duplicate identity covers sport, teams, day, market and selection', () => {
  const a = pick();
  const b = pick({ id: 'p2', matchDate: new Date(2026, 0, 5, 20, 0) }); // same calendar day
  assert.equal(duplicateKey(a), duplicateKey(b));
  assert.equal(isDuplicatePick(b, [a]), true);
});

test('a different selection is not a duplicate', () => {
  const a = pick();
  const b = pick({ id: 'p2', selection: 'Over 2.5 Goals' });
  assert.equal(isDuplicatePick(b, [a]), false);
});

test('editing a pick does not collide with itself', () => {
  const a = pick();
  assert.equal(isDuplicatePick(a, [a]), true);
  assert.equal(isDuplicatePick(a, [a], { excludeId: a.id }), false);
});

/* --------------------------------------------------------------- display */

test('formatMatchDateTime is deterministic and locale-independent', () => {
  const formatted = formatMatchDateTime(FIXED_DATE);
  assert.equal(formatted.date, 'Mon, 5 Jan 2026');
  assert.equal(formatted.time, '14:30');
  assert.equal(dayKey(FIXED_DATE), '2026-01-05');
  assert.equal(formatMatchDateTime('nonsense'), null);
});

test('status labelling, tones and confidence formatting', () => {
  assert.equal(statusLabel('won'), 'Won');
  assert.equal(statusLabel('LOST'), 'Lost');
  assert.equal(statusLabel('void'), 'Void');
  assert.equal(statusLabel('pending'), 'Pending');
  assert.equal(statusLabel('unknown'), 'Pending'); // unknown falls back to pending
  assert.equal(normalizeStatus('WON'), STATUS.WON);
  assert.equal(formatConfidence(92), '92%');
  assert.equal(formatConfidence(null), null);
  assert.equal(confidenceBand(85), 'high');
  assert.equal(confidenceBand(65), 'medium');
  assert.equal(confidenceBand(20), 'low');
});

test('only published picks are considered public', () => {
  assert.equal(isPublished(pick({ visibility: VISIBILITY.PUBLISHED })), true);
  assert.equal(isPublished(pick({ visibility: VISIBILITY.DRAFT })), false);
  assert.equal(isPublished(null), false);
});

test('sanitizeText strips tags and control characters and caps length', () => {
  assert.equal(sanitizeText('  <b>Arsenal</b>\n  FC  '), 'Arsenal FC');
  assert.equal(sanitizeText('a\u0000b\u0007c'), 'a b c');
  assert.equal(sanitizeText('abcdef', 3), 'abc');
});

/* -------------------------------------------------------------- filtering */

test('search matches either team name, case-insensitively', () => {
  const p = pick({ homeTeam: 'Manchester United', awayTeam: 'Chelsea' });
  assert.equal(pickMatchesSearch(p, 'united'), true);
  assert.equal(pickMatchesSearch(p, 'CHELSEA'), true);
  assert.equal(pickMatchesSearch(p, 'arsenal'), false);
  assert.equal(pickMatchesSearch(p, ''), true);
});

test('user filter chips select the right subset', () => {
  const list = [
    pick({ id: 'a', sport: 'Football', status: STATUS.PENDING }),
    pick({ id: 'b', sport: 'Basketball', status: STATUS.WON }),
    pick({ id: 'c', sport: 'Football', status: STATUS.LOST }),
    pick({ id: 'd', sport: 'Basketball', status: STATUS.VOID }),
  ];
  assert.equal(applyUserFilter(list, 'all').length, 4);
  assert.equal(applyUserFilter(list, 'football').length, 2);
  assert.equal(applyUserFilter(list, 'basketball').length, 2);
  assert.equal(applyUserFilter(list, 'won').map(p => p.id).join(','), 'b');
  assert.equal(applyUserFilter(list, 'lost').map(p => p.id).join(','), 'c');
  assert.equal(applyUserFilter(list, 'void').map(p => p.id).join(','), 'd');
  assert.equal(applyUserFilter(list, 'pending').map(p => p.id).join(','), 'a');
});

test('manage filters combine sport, league, status and day', () => {
  const list = [
    pick({ id: 'a', sport: 'Football', league: 'Premier League', status: STATUS.PENDING }),
    pick({ id: 'b', sport: 'Basketball', league: 'NBA', status: STATUS.WON }),
    pick({ id: 'c', sport: 'Football', league: 'La Liga', status: STATUS.WON, matchDate: new Date(2026, 5, 1, 20, 0) }),
  ];
  assert.equal(applyManageFilters(list, { sport: 'Football' }).length, 2);
  assert.equal(applyManageFilters(list, { league: 'NBA' }).map(p => p.id).join(','), 'b');
  assert.equal(applyManageFilters(list, { status: STATUS.WON }).length, 2);
  assert.equal(applyManageFilters(list, { date: FIXED_DATE }).map(p => p.id).sort().join(','), 'a,b');
  assert.equal(
    applyManageFilters(list, { sport: 'Football', status: STATUS.PENDING }).map(p => p.id).join(','),
    'a',
  );
});

test('league options are distinct and sorted', () => {
  const list = [
    pick({ league: 'Premier League' }),
    pick({ league: 'NBA' }),
    pick({ league: 'Premier League' }),
  ];
  assert.deepEqual(leagueOptions(list), ['NBA', 'Premier League']);
});

/* -------------------------------------------------------------- summaries */

test('summarizePicks counts each status and splits published from draft', () => {
  const list = [
    pick({ status: STATUS.PENDING, visibility: VISIBILITY.PUBLISHED }),
    pick({ status: STATUS.WON, visibility: VISIBILITY.PUBLISHED }),
    pick({ status: STATUS.LOST, visibility: VISIBILITY.DRAFT }),
    pick({ status: STATUS.VOID, visibility: VISIBILITY.DRAFT }),
  ];
  const summary = summarizePicks(list);
  assert.equal(summary.total, 4);
  assert.equal(summary.pending, 1);
  assert.equal(summary.won, 1);
  assert.equal(summary.lost, 1);
  assert.equal(summary.void, 1);
  assert.equal(summary.published, 2);
  assert.equal(summary.draft, 2);
});

test('sortPicks puts the newest kick-off first and undated picks last', () => {
  const list = [
    pick({ id: 'old', matchDate: new Date(2026, 0, 1, 12, 0) }),
    pick({ id: 'new', matchDate: new Date(2026, 0, 10, 12, 0) }),
    pick({ id: 'none', matchDate: null }),
  ];
  assert.deepEqual(sortPicks(list).map(p => p.id), ['new', 'old', 'none']);
});

/* ------------------------------------------------------------- round trip */

test('pickToForm reproduces the editable form and re-validates', () => {
  const source = pick({ confidence: 75, matchDate: FIXED_DATE });
  const form = pickToForm(source);
  assert.equal(form.confidence, '75');
  assert.equal(form.homeTeam, 'Arsenal');
  assert.ok(form.matchDate instanceof Date);
  assert.equal(validatePickForm(form).valid, true);
});

test('SPORTS and STATUSES expose exactly the supported values', () => {
  assert.deepEqual(SPORTS, ['Football', 'Basketball']);
  assert.deepEqual(STATUSES, ['pending', 'won', 'lost', 'void']);
});
