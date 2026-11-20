/**
 * APEX — BASKETBALL LIVE PREDICTION ENGINE AND QUARTER CLOCK CORRECTION
 * Spec §13 automated tests (winner prediction, integrity, competition time).
 *
 * These pin the numbered guarantees of the brief:
 *   §13.1–10  winner prediction — a two-way model in which the SCORE MARGIN and
 *             the REMAINING TIME decide the favourite, and either side can be
 *             selected. A 15-point lead in Q1 is tuned down by the time left; the
 *             same lead in Q4 is near-decisive. Home advantage never overrides a
 *             real live lead.
 *   §13.19    competition-specific quarter lengths (NBA 12 vs FIBA 10).
 *   §13.20    a clock that only ever counts DOWN inside a period.
 *   §13.21–28 prediction integrity — no auto-Home, no hardcoded 219.5, both sides
 *             of the total reachable, a 75% floor, no fabricated statistics, and
 *             a tracker that preserves the ORIGINAL selection.
 *
 * Pure maths + the pick derivation: no network. The one tracker test redirects
 * its store paths to a throwaway file so no committed evidence is touched.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG = require('../services/live/config');
const { predictLive } = require('../services/live/liveModel');
const { predictBasketball, leagueParams } = require('../services/live/basketballLive');
const {
  derivePicks, overUnderLine, basketballTotalsPick, matchResultPick,
} = require('../services/live/livePicks');
const matchFeed = require('../services/live/matchFeed');
const liveStats = require('../services/live/liveStats');
const forwardTest = require('../services/live/forwardTest');
const shadowHealth = require('../services/live/shadowHealth');
const ledger = require('../services/live/ledger');
const store = require('../services/live/store');

/** A Phase-3-shaped basketball LiveGame (the model's input contract). */
function bgame({
  clock = null, period = 0, homeScore = 0, awayScore = 0,
  league = { id: 'nba', name: 'NBA' }, tier = 'full_live',
} = {}) {
  return {
    game_id: 'espn:spec',
    sport: 'basketball',
    source: 'espn',
    league,
    home: { id: 'h', name: 'Home', score: homeScore },
    away: { id: 'a', name: 'Away', score: awayScore },
    live: { status: 'live', is_live: true, clock, period },
    data_tier: tier,
    freshness: { age_seconds: 5, is_stale: false },
    manual: false,
  };
}

const twoWay = p => p.home_win + p.away_win;

/* ==================================================================== */
/* §13.1–10  WINNER PREDICTION                                           */
/* ==================================================================== */

describe('§13 winner prediction — margin and remaining time decide, either side selectable', () => {
  test('1. a 15-point home lead in Q1 is a favourite, not a certainty', () => {
    const r = predictLive({ game: bgame({ clock: '6:00', period: 1, homeScore: 30, awayScore: 15 }) });
    expect(r.status).toBe('live');
    expect(r.expected.margin).toBeGreaterThan(0);
    expect(r.probabilities.home_win).toBeGreaterThan(r.probabilities.away_win);
    // Lots of basketball left, so a 15-point cushion is softened by the time.
    expect(r.probabilities.home_win).toBeGreaterThan(0.8);
    expect(r.probabilities.home_win).toBeLessThan(0.98);
    expect(twoWay(r.probabilities)).toBeCloseTo(1, 3);
  });

  test('2. a 15-point AWAY lead in Q1 flips the favourite to the away side', () => {
    const r = predictLive({ game: bgame({ clock: '6:00', period: 1, homeScore: 15, awayScore: 30 }) });
    expect(r.probabilities.away_win).toBeGreaterThan(r.probabilities.home_win);
    expect(r.probabilities.away_win).toBeGreaterThan(0.8);
    expect(twoWay(r.probabilities)).toBeCloseTo(1, 3);
  });

  test('3. the SAME 15-point home lead in Q4 is near-decisive (time decay)', () => {
    const early = predictLive({ game: bgame({ clock: '6:00', period: 1, homeScore: 30, awayScore: 15 }) });
    const late = predictLive({ game: bgame({ clock: '1:00', period: 4, homeScore: 100, awayScore: 85 }) });
    expect(late.probabilities.home_win).toBeGreaterThanOrEqual(0.99);
    // Identical margin, far less time -> a much stronger favourite.
    expect(late.probabilities.home_win).toBeGreaterThan(early.probabilities.home_win);
  });

  test('4. a 15-point AWAY lead in Q4 is near-decisive for the away side', () => {
    const r = predictLive({ game: bgame({ clock: '1:00', period: 4, homeScore: 85, awayScore: 100 }) });
    expect(r.probabilities.away_win).toBeGreaterThanOrEqual(0.99);
    expect(r.probabilities.home_win).toBeLessThan(r.probabilities.away_win);
  });

  test('5. a close match with two minutes left is a coin flip, not a forced winner', () => {
    const r = predictLive({ game: bgame({ clock: '2:00', period: 4, homeScore: 95, awayScore: 94 }) });
    expect(r.probabilities.home_win).toBeGreaterThan(0.45);
    expect(r.probabilities.home_win).toBeLessThan(0.72);
    // Both outcomes are live: neither side is auto-selected.
    expect(r.probabilities.away_win).toBeGreaterThan(0.25);
    expect(twoWay(r.probabilities)).toBeCloseTo(1, 3);
  });

  test('6. an away side leading with the better game gets the higher probability', () => {
    // The score is the primary evidence; live stats are present but must not
    // override a real away lead.
    const r = predictLive({
      game: bgame({ clock: '6:00', period: 3, homeScore: 60, awayScore: 72 }),
      context: { stats: { sport: 'basketball', totals: { possessions: 120 } } },
    });
    expect(r.probabilities.away_win).toBeGreaterThan(0.5);
    expect(r.probabilities.away_win).toBeGreaterThan(r.probabilities.home_win);
  });

  test('7. a home scoring drought is detected from real snapshots', () => {
    // Home was up 70-60 but has gone cold: over four recorded minutes it adds
    // nothing while the away side scores nine. Momentum must read the drought —
    // it is never invented, only measured from the snapshots that arrived.
    liveStats.resetSnapshots();
    expect(liveStats.recordBasketballMomentum('spec-drought', { home_score: 70, away_score: 60 }, 0)).toBeNull();
    const m = liveStats.recordBasketballMomentum('spec-drought', { home_score: 70, away_score: 69 }, 4 * 60 * 1000);
    expect(m).not.toBeNull();
    expect(m.window_minutes).toBe(4);
    expect(m.home.points).toBe(0);       // the drought
    expect(m.away.points).toBe(9);
    expect(m.net_home).toBe(-9);
    expect(m.pressure_share_home).toBe(0);
    liveStats.resetSnapshots();
  });

  test('8. a match tied at the end of Q4 is a 50/50 (heading for overtime)', () => {
    const r = predictLive({ game: bgame({ clock: '0:00', period: 4, homeScore: 100, awayScore: 100 }) });
    expect(r.probabilities.home_win).toBeCloseTo(0.5, 2);
    expect(r.probabilities.away_win).toBeCloseTo(0.5, 2);
    expect(twoWay(r.probabilities)).toBeCloseTo(1, 3);
  });

  test('9. overtime is modelled — the leader is favoured and the two ways sum to 1', () => {
    const ot = predictLive({ game: bgame({ clock: '3:00', period: 5, homeScore: 100, awayScore: 96 }) });
    expect(ot.probabilities.home_win).toBeGreaterThan(0.9);
    expect(twoWay(ot.probabilities)).toBeCloseTo(1, 3);

    // A second overtime is handled the same way (period 6, never "Q6").
    const ot2 = predictLive({ game: bgame({ clock: '2:00', period: 6, homeScore: 110, awayScore: 106 }) });
    expect(ot2.probabilities.home_win).toBeGreaterThan(0.9);
    expect(twoWay(ot2.probabilities)).toBeCloseTo(1, 3);
  });

  test('10. incomplete statistics still produce a finite, honest two-way read', () => {
    // Only the score and (optionally) the clock — nothing else. No NaN leaks.
    const withClock = predictLive({ game: bgame({ clock: '5:00', period: 2, homeScore: 48, awayScore: 44 }) });
    expect(Number.isFinite(withClock.probabilities.home_win)).toBe(true);
    expect(Number.isFinite(withClock.probabilities.away_win)).toBe(true);
    expect(twoWay(withClock.probabilities)).toBeCloseTo(1, 3);
    expect(Number.isFinite(withClock.inputs.rate_per_minute)).toBe(true);
    // No fabricated stat block was attached to the model output.
    expect(withClock.stats).toBeUndefined();

    // No clock at all -> the pre-game projection, still summing to 1.
    const noClock = predictLive({ game: bgame({ clock: null, period: 0, homeScore: 50, awayScore: 48 }) });
    expect(noClock.status).toBe('prior_only');
    expect(twoWay(noClock.probabilities)).toBeCloseTo(1, 3);
  });
});

/* ==================================================================== */
/* §13.19–20  COMPETITION TIME                                          */
/* ==================================================================== */

describe('§13 competition time — quarter lengths and a count-down clock', () => {
  const kickoff = Date.UTC(2026, 10, 20, 15, 0, 0);
  const at = min => kickoff + min * 60 * 1000;

  test('19. NBA 12-minute and FIBA 10-minute quarters are both honoured', () => {
    // Derived clock: 4 minutes into Q1, a FIBA quarter has 6' left, an NBA 8'.
    expect(matchFeed.deriveClock('basketball', kickoff, at(4), { period: 1, league: 'FIBA' }))
      .toEqual({ clock: "6'", period: 1 });
    expect(matchFeed.deriveClock('basketball', kickoff, at(4), { period: 1, league: 'NBA' }))
      .toEqual({ clock: "8'", period: 1 });

    // The model reads the same competition lengths from the league key.
    expect(leagueParams('nba').gameMinutes).toBe(48);
    expect(leagueParams('fiba').gameMinutes).toBe(40);
    const nba = predictBasketball({ game: bgame({ clock: '6:00', period: 1 }), weight: 1 });
    const fiba = predictBasketball({ game: bgame({ clock: '6:00', period: 1, league: { id: 'fiba', name: 'FIBA' } }), weight: 1 });
    // 6:00 left of a quarter -> 6 min elapsed in the NBA, 4 in FIBA.
    expect(nba.inputs.elapsed_minutes).toBe(6);
    expect(fiba.inputs.elapsed_minutes).toBe(4);
  });

  test('20. the clock counts DOWN and never increases inside a period', () => {
    const step = [1, 2, 6, 11, 12].map(m => matchFeed.deriveClock('basketball', kickoff, at(m)));
    // Strictly non-increasing remaining minutes, and it reaches zero.
    const mins = step.map(s => Number(String(s.clock).replace("'", '')));
    for (let i = 1; i < mins.length; i += 1) expect(mins[i]).toBeLessThanOrEqual(mins[i - 1]);
    expect(mins[mins.length - 1]).toBe(0);
    expect(step.every(s => s.period === 1)).toBe(true);

    // A later wall-clock time moves into the NEXT period rather than rewinding.
    expect(matchFeed.deriveClock('basketball', kickoff, at(16)).period).toBe(2);

    // The model's remaining time only shrinks as the period clock runs down.
    const a = predictBasketball({ game: bgame({ clock: '6:00', period: 1 }), weight: 1 });
    const b = predictBasketball({ game: bgame({ clock: '3:00', period: 1 }), weight: 1 });
    expect(b.inputs.remaining_minutes).toBeLessThan(a.inputs.remaining_minutes);
  });
});

/* ==================================================================== */
/* §13.21–28  PREDICTION INTEGRITY                                      */
/* ==================================================================== */

describe('§13 prediction integrity', () => {
  const decisiveAway = () => bgame({ clock: '0:30', period: 4, homeScore: 88, awayScore: 110 });

  test('21. Home Win is not automatically selected — an away lead yields an away read', () => {
    const model = predictLive({ game: decisiveAway() });
    // The argmax (minProb 0) follows the evidence, not the venue.
    expect(matchResultPick('basketball', model.probabilities, 0).selection).toBe('away');
  });

  test('22. Away Win is selectable when the away side is stronger', () => {
    const game = decisiveAway();
    const model = predictLive({ game });
    const picks = derivePicks({ sport: 'basketball', model, game });
    expect(picks.match_result.market).toBe('moneyline');
    expect(picks.match_result.selection).toBe('away');
    expect(picks.match_result.probability).toBeGreaterThanOrEqual(0.75);
  });

  test('23. the two-way probabilities sum to 100%', () => {
    const states = [
      bgame({ clock: '6:00', period: 1, homeScore: 30, awayScore: 15 }),
      bgame({ clock: '3:00', period: 2, homeScore: 44, awayScore: 50 }),
      bgame({ clock: '0:30', period: 4, homeScore: 88, awayScore: 110 }),
      bgame({ clock: '0:00', period: 4, homeScore: 100, awayScore: 100 }),
    ];
    states.forEach(g => {
      const p = predictLive({ game: g }).probabilities;
      expect(p.home_win + p.away_win).toBeCloseTo(1, 3);
      expect(p.home_win).toBeGreaterThanOrEqual(0);
      expect(p.home_win).toBeLessThanOrEqual(1);
    });
  });

  test('24. the basketball total is anchored per match, never a hardcoded 219.5', () => {
    const nbaMean = overUnderLine('basketball', { league: { id: 'nba' } }, {});
    const a = overUnderLine('basketball', { league: { id: 'nba' } }, { anchor_total: 228.4 });
    const b = overUnderLine('basketball', { league: { id: 'nba' } }, { anchor_total: 212.6 });
    // Per-match anchors snap to the nearest half point and differ from each other.
    expect(a).toBe(228.5);
    expect(b).toBe(212.5);
    expect(a).not.toBe(b);
    // The fallback (fitted league mean), not a constant 219.5.
    expect(nbaMean).toBe(234.5);
    expect([a, b, nbaMean]).not.toContain(219.5);
  });

  test('25. both Over and Under can be selected from the same anchor', () => {
    const game = { league: { id: 'nba' }, home: { score: 0 }, away: { score: 0 } };
    const anchor = 205.5;
    const high = basketballTotalsPick({
      expected: { total: 225, margin: 5 }, sigma: { total: 16, margin: 11 },
      anchor_total: anchor, anchor_margin: 3,
    }, game);
    const low = basketballTotalsPick({
      expected: { total: 190, margin: 5 }, sigma: { total: 16, margin: 11 },
      anchor_total: anchor, anchor_margin: 3,
    }, game);
    expect(high.selection).toBe('over');
    expect(low.selection).toBe('under');
    expect(high.probability).toBeGreaterThanOrEqual(0.75);
    expect(low.probability).toBeGreaterThanOrEqual(0.75);
  });

  test('26. a read below the 75% bar is withheld, never forced', () => {
    // A 66% moneyline read is below the bar.
    expect(matchResultPick('basketball', { home_win: 0.66, away_win: 0.34 }, 0.75)).toBeNull();
    // A projection sitting exactly on the line is a coin flip -> no totals pick.
    const flat = basketballTotalsPick({
      expected: { total: 205.5, margin: 3 }, sigma: { total: 16, margin: 11 },
      anchor_total: 205.5, anchor_margin: 3,
    }, { league: { id: 'nba' }, home: { score: 0 }, away: { score: 0 } });
    expect(flat).toBeNull();
    // An even mid-game state clears no bar at all: the whole pick set is null.
    const even = bgame({ clock: '7:24', period: 3, homeScore: 70, awayScore: 66 });
    const evenModel = predictLive({ game: even });
    expect(evenModel.probabilities.home_win).toBeLessThan(0.75);
    expect(derivePicks({ sport: 'basketball', model: evenModel, game: even })).toBeNull();
  });

  test('27. missing statistics are never fabricated into a line or a stat', () => {
    // No anchor and an unfitted league -> no total line, so no O/U pick. A
    // made-up "219.5" is never substituted.
    expect(overUnderLine('basketball', { league: { id: 'no-such-league' } }, {})).toBeNull();
    const model = {
      status: 'live',
      probabilities: { home_win: 0.8, away_win: 0.2 },
      expected: { total: 200, margin: 10 }, sigma: { total: 16, margin: 11 },
      anchor_margin: 1, // no anchor_total: nothing to anchor a total to
    };
    const picks = derivePicks({
      sport: 'basketball', model, game: { league: { id: 'no-such-league' }, home: { score: 0 }, away: { score: 0 } },
    });
    // The spread can still be priced off the margin anchor, but the total has
    // nothing to anchor to, so it is omitted rather than fabricated.
    expect(picks).not.toBeNull();
    expect(picks.over_under).toBeNull();
    expect(picks.spread).not.toBeNull();

    // Soccer with no live stats invents no corners/shots pick.
    const soccer = derivePicks({
      sport: 'soccer',
      model: { status: 'live', probabilities: { home_win: 0.5, draw: 0.3, away_win: 0.2 }, total_distribution: null },
      game: {}, markets: [], stats: null,
    });
    if (soccer) {
      expect(soccer.corners).toBeNull();
      expect(soccer.shots).toBeNull();
    }
  });

  test('28. the tracker preserves the ORIGINAL selection when a later poll differs', () => {
    const game = {
      game_id: 'g-track', sport: 'basketball', league: { id: 'nba', name: 'NBA' },
      home: { score: 70 }, away: { score: 66 },
      live: { clock: '7:24', period: 3 },
      freshness: { age_seconds: 5, is_stale: false }, data_tier: 'full_live', source: 'espn',
    };
    // First poll: the served pick. (7:24 in Q3 snaps to the 0.625 grid mark.)
    const first = forwardTest.recordServed({ game, probability: 0.61, now: 1795000000000 });
    expect(first).not.toBeNull();
    expect(first.p).toBe(0.61);

    // The game moves on and the live probability changes, but the SAME historical
    // checkpoint is not nearer the grid mark, so nothing is overwritten.
    const again = forwardTest.recordServed({ game, probability: 0.85, now: 1795000001000 });
    expect(again).toBeNull();
    expect(forwardTest.status().rows).toBe(1);

    // Settling grades the ORIGINAL row, leaving its logged selection intact.
    expect(forwardTest.settle({ gameId: 'g-track', homeScore: 110, awayScore: 100, now: 1795000002000 })).toBe(1);
    forwardTest.flush(TMP_FORWARD_FILE);
    const [stored] = store.getStore().readRowsForGame('g-track', { file: TMP_FORWARD_FILE });
    expect(stored.p).toBe(0.61);
    expect(stored.y).toBe(1);
  });
});

/* ==================================================================== */
/* tracker scaffolding — redirect every store path to a throwaway file    */
/* ==================================================================== */

const COMMITTED_FORWARD_FILE = CONFIG.live.forwardTest.file;
const COMMITTED_HEALTH_FILE = CONFIG.live.health.file;
const COMMITTED_LEDGER_FILE = CONFIG.live.store.ledger.file;

const stamp = `${process.pid}-${Math.random().toString(16).slice(2)}`;
const TMP_FORWARD_FILE = path.join(os.tmpdir(), `spec-forward-${stamp}.json`);
const TMP_HEALTH_FILE = path.join(os.tmpdir(), `spec-health-${stamp}.json`);
const TMP_LEDGER_FILE = path.join(os.tmpdir(), `spec-ledger-${stamp}.json`);

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
  forwardTest.init({ benchmarkLogLoss: 0.43 });
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
