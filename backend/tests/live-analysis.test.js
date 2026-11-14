/**
 * Phase 6 — the analysis payload and the single point where the ship gate is
 * enforced.
 *
 * The brief's hard rule is "withheld, never zeroed": when the gate refuses,
 * `probabilities`, `projection` and `uncertainty` must be null so the UI has
 * nothing to render but the score, the clock and the facts. These tests pin
 * that down, plus the derivations that turn a model output into a projection.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG = require('../services/live/config');
const forwardTest = require('../services/live/forwardTest');
const {
  buildAnalysis, nextGoal, projectionFor,
  analyseLiveGame, rememberGame, resetCache, recordForwardTest, DISPLAY_MODES,
} = require('../services/live/analysis');

/** Minimal LiveGame shaped exactly like liveGame.buildLiveGame output. */
function game({
  sport = 'soccer', homeScore = 0, awayScore = 0, clock = "34'", period = 1,
  status = 'live', tier = 'full_live', league = null,
} = {}) {
  return {
    game_id: 'espn:1',
    sport,
    source: 'espn',
    league: league || { id: sport === 'basketball' ? 'nba' : 'eng.1', name: 'League' },
    home: { id: 'h', name: 'Home', logo: null, score: homeScore, record: null },
    away: { id: 'a', name: 'Away', logo: null, score: awayScore, record: null },
    live: { status, is_live: status === 'live', clock, period, raw_status: null },
    schedule: { kickoff: null, kickoff_ts: null, venue: null },
    data_tier: tier,
    data_tier_label: 'Full live data',
    freshness: { age_seconds: 5, is_stale: false, updated_label: 'updated 5s ago' },
    match: null,
    link: null,
    manual: tier === 'user_entered',
  };
}

/** Run `fn` with a league temporarily passing the ship gate. */
function withShippedLeague(sport, league, fn) {
  const original = CONFIG.live.picks[sport];
  CONFIG.live.picks[sport] = [league];
  try {
    fn();
  } finally {
    CONFIG.live.picks[sport] = original;
  }
}

// Point the forward log at a throwaway file so no test can touch the committed
// artifact (settle() writes through to disk), and give it a benchmark so the
// shadow summary has something to compare against.
const COMMITTED_FORWARD_FILE = CONFIG.live.forwardTest.file;
const TMP_FORWARD_FILE = path.join(os.tmpdir(), `live-forward-${process.pid}.json`);

beforeEach(() => {
  resetCache();
  try { fs.unlinkSync(TMP_FORWARD_FILE); } catch (err) { /* absent is fine */ }
  CONFIG.live.forwardTest.file = TMP_FORWARD_FILE;
  forwardTest.init({ benchmarkLogLoss: 0.43 });
});

afterEach(() => {
  CONFIG.live.forwardTest.file = COMMITTED_FORWARD_FILE;
});

describe('nextGoal (soccer derivation)', () => {
  test('the three outcomes sum to 1', () => {
    const ng = nextGoal({ lambda_home: 0.8, lambda_away: 0.6 });
    expect(ng.home + ng.away + ng.none).toBeCloseTo(1, 3);
  });

  test('a stronger home side is more likely to score the next goal', () => {
    const ng = nextGoal({ lambda_home: 1.2, lambda_away: 0.3 });
    expect(ng.home).toBeGreaterThan(ng.away);
  });

  test('returns null rather than guessing when the rates are missing', () => {
    expect(nextGoal({})).toBeNull();
    expect(nextGoal({ lambda_home: 0, lambda_away: 1 })).toBeNull();
    expect(nextGoal(null)).toBeNull();
  });
});

describe('projectionFor', () => {
  test('is null without a model expectation', () => {
    expect(projectionFor(null, game())).toBeNull();
    expect(projectionFor({ status: 'unsupported' }, game())).toBeNull();
  });

  test('splits a soccer projection into expected final, remaining and next goal', () => {
    const model = {
      expected: { home_score: 1.4, away_score: 1.1, total: 2.5, margin: 0.3 },
      inputs: { lambda_home: 0.8, lambda_away: 0.6 },
    };
    const p = projectionFor(model, game({ homeScore: 1, awayScore: 0 }));
    expect(p.expected_final).toEqual({ home: 1.4, away: 1.1, total: 2.5, margin: 0.3 });
    expect(p.remaining).toEqual({ home: 0.4, away: 1.1, total: 1.5 });
    expect(p.next_goal).not.toBeNull();
  });

  test('a basketball projection carries the total and margin bands', () => {
    const model = {
      expected: { home_score: 110, away_score: 105, total: 215, margin: 5 },
      sigma: { total: 16, margin: 11 },
    };
    const p = projectionFor(model, game({ sport: 'basketball', league: { id: 'nba', name: 'NBA' } }));
    expect(p.total_line).toEqual({ line: 215, sigma: 16 });
    expect(p.margin_line).toEqual({ line: 5, sigma: 11 });
  });
});

describe('buildAnalysis — the ship gate is the single chokepoint', () => {
  test('with the gate closed, every figure is null and the reason is surfaced', () => {
    const a = buildAnalysis({ game: game(), now: Date.parse('2026-10-26T18:00:00Z') });

    expect(a.display.mode).toBe(DISPLAY_MODES.CONTEXT_ONLY);
    expect(a.display.shows_probabilities).toBe(false);
    expect(a.ship_gate.decision).toBe('withheld');
    expect(a.ship_gate.allowed).toBe(false);
    // Soccer is shadow-held (Phase 10), so the reason names that plainly.
    expect(a.ship_gate.reason).toMatch(/still being validated on live games/i);

    // Withheld, not zeroed.
    expect(a.probabilities).toBeNull();
    expect(a.projection).toBeNull();
    expect(a.uncertainty).toBeNull();

    // Facts still ship: the score, the clock, the tier.
    expect(a.home.score).toBe(0);
    expect(a.away.score).toBe(0);
    expect(a.live.clock).toBe("34'");
    expect(a.data_tier).toBe('full_live');
    expect(a.probabilities_note).toMatch(/ship gate|validated/i);
  });

  test('the payload reports the model it would have run, without its numbers', () => {
    const a = buildAnalysis({ game: game() });
    expect(a.model.status).toBe('live');
    expect(a.model.name).toBeTruthy();
    expect(a.probabilities).toBeNull();
  });

  test('once a league passes, the live probability ships', () => {
    withShippedLeague('soccer', 'eng.1', () => {
      const a = buildAnalysis({ game: game() });
      expect(a.display.mode).toBe(DISPLAY_MODES.FULL);
      expect(a.display.shows_probabilities).toBe(true);
      expect(a.ship_gate.decision).toBe('shipped');
      expect(a.probabilities).toEqual(expect.objectContaining({
        home_win: expect.any(Number), draw: expect.any(Number), away_win: expect.any(Number),
      }));
      expect(a.probabilities.home_win + a.probabilities.draw + a.probabilities.away_win)
        .toBeCloseTo(1, 3);
      expect(a.projection).not.toBeNull();
      expect(a.uncertainty).not.toBeNull();
      expect(a.probabilities_note).toBeNull();
    });
  });

  test('without an in-game clock the payload degrades to the pre-game projection', () => {
    withShippedLeague('soccer', 'eng.1', () => {
      const a = buildAnalysis({ game: game({ clock: null }) });
      expect(a.model.status).toBe('prior_only');
      expect(a.display.mode).toBe(DISPLAY_MODES.PRIOR_ONLY);
      expect(a.display.shows_probabilities).toBe(true);
      expect(a.probabilities_note).toMatch(/pre-game projection/i);
    });
  });

  test('facts never invent play-by-play: no red card means no red-card bullet', () => {
    const a = buildAnalysis({ game: game(), context: {} });
    const labels = a.factors.map(f => f.label);
    expect(labels).toContain('Data quality');
    expect(labels).not.toContain('Red card');
  });

  test('a manual game is labelled unverified and can never show a probability', () => {
    const a = buildAnalysis({
      game: game({ tier: 'user_entered', league: { id: null, name: null }, status: 'live' }),
    });
    expect(a.manual).toBe(true);
    expect(a.ship_gate.decision).toBe('withheld');
    expect(a.probabilities).toBeNull();
    expect(a.factors.map(f => f.label)).toContain('Unverified input');
  });

  test('a hand-typed game carries the permanent badge in the payload', () => {
    const a = buildAnalysis({ game: game({ tier: 'user_entered', league: { id: null, name: null } }) });
    expect(a.manual).toBe(true);
    expect(a.manual_badge).toBe(CONFIG.liveApi.manualBadge);
    expect(a.manual_badge_detail).toMatch(/typed in by hand/i);
    // The refusal names why: hand-typed games are never shipped.
    expect(a.ship_gate.reason).toMatch(/entered by hand/i);
    expect(a.display.shows_probabilities).toBe(false);
  });

  test('a provider game carries no manual badge', () => {
    const a = buildAnalysis({ game: game() });
    expect(a.manual).toBe(false);
    expect(a.manual_badge).toBeNull();
    expect(a.manual_badge_detail).toBeNull();
  });

  test('a hand-typed game cannot ship even when its league has passed the gate', () => {
    withShippedLeague('soccer', 'eng.1', () => {
      const a = buildAnalysis({
        game: game({ tier: 'user_entered', league: { id: 'eng.1', name: 'Premier League' } }),
      });
      expect(a.ship_gate.allowed).toBe(false);
      expect(a.display.mode).toBe(DISPLAY_MODES.CONTEXT_ONLY);
      expect(a.probabilities).toBeNull();
      expect(a.projection).toBeNull();
    });
  });

  test('provider context is dropped for a hand-typed game', () => {
    const a = buildAnalysis({
      game: game({ tier: 'user_entered', league: { id: null, name: null } }),
      context: { red_cards: { home: 1, away: 0 } },
    });
    expect(a.factors.map(f => f.label)).not.toContain('Red card');
  });
});

describe('analyseLiveGame — resolution, caching and honest 404', () => {
  test('an unknown game id returns GAME_NOT_RESOLVED (404)', async () => {
    const out = await analyseLiveGame({ gameId: 'espn:999' });
    expect(out.error.code).toBe('GAME_NOT_RESOLVED');
    expect(out.error.status).toBe(404);
  });

  test('a remembered game is served and then reused from the shared cache', async () => {
    rememberGame(game());
    const first = await analyseLiveGame({ gameId: 'espn:1', now: 1000 });
    expect(first.error).toBeUndefined();
    expect(first.cached).toBe(false);
    expect(first.analysis.game_id).toBe('espn:1');

    const second = await analyseLiveGame({ gameId: 'espn:1', now: 1500 });
    expect(second.cached).toBe(true);
    expect(second.analysis).toBe(first.analysis);
  });

  test('a game older than the game TTL is no longer tracked', async () => {
    const t0 = 1_000_000;
    rememberGame(game(), t0);
    const out = await analyseLiveGame({ gameId: 'espn:1', now: t0 + CONFIG.liveApi.gameTtlMs + 1 });
    expect(out.error.code).toBe('GAME_NOT_RESOLVED');
  });
});

describe('Phase 9 — the shadow hold logs evidence without serving it', () => {
  const basketball = (over = {}) => game({
    sport: 'basketball', league: { id: 'nba', name: 'NBA' },
    clock: '7:24', period: 3, homeScore: 70, awayScore: 66, status: 'live', ...over,
  });

  test('a held sport is shipped to nobody and logs a shadow row', () => {
    const g = basketball();
    const a = buildAnalysis({ game: g, now: 1000 });
    // Held: the pick is withheld from every audience, so no figure is shown.
    expect(a.ship_gate.decision).toBe('withheld');
    expect(a.probabilities).toBeNull();

    // ...yet the figure production WOULD show is still captured as evidence.
    const row = recordForwardTest({ game: g, analysis: a, now: 1000 });
    expect(row).not.toBeNull();
    expect(row.shadow).toBe(true);
    expect(row.sport).toBe('basketball');
    expect(row.p).toEqual(expect.any(Number));
    expect(forwardTest.status().shadowRows).toBe(1);
  });

  test('the withheld figure never rides along in the payload', () => {
    const a = buildAnalysis({ game: basketball() });
    expect(a.probabilities).toBeNull();
    // Non-enumerable + Symbol-keyed: invisible to JSON, to keys() and to spread.
    expect(Object.keys(a)).not.toContain('shadow');
    expect(JSON.stringify(a)).not.toMatch(/shadow/i);
    expect({ ...a }.probabilities).toBeNull();
  });

  test('shadow rows never count toward the served-pick auto-disable', () => {
    const g = basketball();
    [0, 1, 2].forEach(i => {
      const gg = { ...g, live: { ...g.live, clock: `${7 - i}:24` } };
      recordForwardTest({ game: gg, analysis: buildAnalysis({ game: gg, now: i }), now: i });
    });
    forwardTest.settle({ gameId: 'espn:1', homeScore: 110, awayScore: 100, now: 10 });

    // The realised evidence exists, but it is shadow: the served verdict — the
    // one that can retire a live pick — still has no games of its own.
    const verdict = forwardTest.evaluate('basketball');
    expect(verdict.status).toBe('insufficient');
    expect(verdict.metrics.games).toBe(0);

    // The shadow summary reports the same evidence separately, for the rollout
    // decision only, and never claims it is ready on a single game.
    const shadow = forwardTest.shadowSummary('basketball');
    expect(shadow.shadow).toBe(true);
    expect(shadow.games).toBe(1);
    expect(shadow.benchmarkLogLoss).toBe(0.43);
    expect(shadow.ready).toBe(false);
  });

  test('a shadow row carries the frozen candidate columns for its sport', () => {
    const g = basketball();
    const a = buildAnalysis({ game: g });
    const row = recordForwardTest({ game: g, analysis: a });
    expect(row.shadow).toBe(true);
    // The basketball logistic is frozen in the committed artifact, so its
    // probability is logged verbatim alongside the production figure.
    expect(row.candidates).toEqual(expect.objectContaining({
      basketball_logistic: expect.any(Number),
    }));
    expect(row.candidates.basketball_logistic).toBeGreaterThan(0);
    expect(row.candidates.basketball_logistic).toBeLessThan(1);
  });

  test('nothing is logged for a sport that is neither shipped nor shadow', () => {
    const g = game({ sport: 'hockey' }); // unsupported: not shipped and not shadow
    const a = buildAnalysis({ game: g });
    expect(recordForwardTest({ game: g, analysis: a })).toBeNull();
    expect(forwardTest.status().rows).toBe(0);
  });
});

describe('Phase 9 amendment 1 — the log-loss-gain-vs-scoreTime clause', () => {
  const basketball = (over = {}) => game({
    sport: 'basketball', league: { id: 'nba', name: 'NBA' },
    clock: '7:24', period: 3, homeScore: 70, awayScore: 66, status: 'live', ...over,
  });

  test('the block carries a dated amendment naming the id it superseded', () => {
    const rc = forwardTest.releaseCriteria();
    expect(forwardTest.priorCriteriaId()).toBe('67d4708fea1d');
    expect(Array.isArray(rc.amendments)).toBe(true);
    const a = rc.amendments.find(x => x.prior_criteria_id === '67d4708fea1d');
    expect(a).toBeTruthy();
    expect(a.at).toBe('2026-11-08');
    // The structural clause is in force...
    expect(rc.scoreTimeGain.minLogLossGainCiLower).toBe(0);
    // ...and it advanced the criteria id beyond the pre-amendment one.
    expect(forwardTest.criteriaId()).not.toBe('67d4708fea1d');
  });

  test('the amendment prose is not hashed, so a note edit cannot move the gate', () => {
    const rc = forwardTest.releaseCriteria();
    const before = forwardTest.criteriaId();
    const saved = rc.amendments;
    rc.amendments = [{ ...saved[0], note: 'reworded note' }];
    try {
      expect(forwardTest.criteriaId()).toBe(before);
    } finally {
      rc.amendments = saved;
    }
  });

  test('every row records BOTH the active id and the prior id', () => {
    const g = basketball();
    const row = recordForwardTest({ game: g, analysis: buildAnalysis({ game: g, now: 1000 }), now: 1000 });
    expect(row).not.toBeNull();
    expect(row.criteria_id).toBe(forwardTest.criteriaId());
    expect(row.criteria_id_prior).toBe('67d4708fea1d');
  });

  test('the shadow summary reports the clause and the prior id, and gates on it', () => {
    const g = basketball();
    recordForwardTest({ game: g, analysis: buildAnalysis({ game: g, now: 1000 }), now: 1000 });
    const summary = forwardTest.shadowSummary('basketball');
    expect(summary.scoreTimeGain.minLogLossGainCiLower).toBe(0);
    expect(summary.criteria.prior_id).toBe('67d4708fea1d');
    // A single, unsettled row has no score-and-time gain interval, so the clause
    // cannot pass: the hold stays shut and says why.
    expect(summary.scoreTimeGain.ok).toBe(false);
    expect(summary.ready).toBe(false);
    expect(summary.ready_reasons.join(' ')).toMatch(/scoreTime/i);
  });

  test('status exposes the prior id so the drift is observable without the source', () => {
    expect(forwardTest.status().criteria_id_prior).toBe('67d4708fea1d');
  });
});

describe('Phase 10 round D — the confirmation dataset and rollout progress', () => {
  const basketball = (over = {}) => game({
    sport: 'basketball', league: { id: 'nba', name: 'NBA' },
    clock: '7:24', period: 3, homeScore: 70, awayScore: 66, status: 'live', ...over,
  });
  const freezeMs = () => forwardTest.confirmationFreeze().ms;

  test('the confirmation target is the ship gate 500, not the rolling 300', () => {
    expect(forwardTest.confirmationMinGames()).toBe(500);
  });

  test('only rows logged AFTER the freeze count toward the confirmation dataset', () => {
    const g = basketball();
    const before = freezeMs() - 86400000;
    const after = freezeMs() + 3600000;

    recordForwardTest({ game: g, analysis: buildAnalysis({ game: g, now: before }), now: before });
    const g2 = { ...g, live: { ...g.live, clock: '3:24' } };
    recordForwardTest({ game: g2, analysis: buildAnalysis({ game: g2, now: after }), now: after });

    const c = forwardTest.confirmationSummary('basketball');
    expect(c.frozen_at_ms).toBe(freezeMs());
    // The sliding-window row is counted as ALREADY SEEN, never as unseen.
    expect(c.pre_freeze_rows).toBe(1);
    expect(c.rows).toBe(1);
    expect(c.settled_games).toBe(0);
    expect(c.min_settled_games).toBe(500);
    expect(c.ready_to_evaluate).toBe(false);
    expect(c.evaluated).toBe(false);
  });

  test('progress tallies settled confirmation games per sport and per league', () => {
    const g = basketball();
    const after = freezeMs() + 3600000;
    recordForwardTest({ game: g, analysis: buildAnalysis({ game: g, now: after }), now: after });
    forwardTest.settle({ gameId: 'espn:1', homeScore: 110, awayScore: 100, now: after + 1 });

    // Force the elapsed window so the rate is deterministic (2 days).
    const p = forwardTest.progress({ now: freezeMs() + 2 * 86400000 });
    expect(p.target).toBe(500);
    expect(p.per_sport.basketball.settled_games).toBe(1);
    expect(p.per_league['basketball/nba'].settled_games).toBe(1);
    expect(p.per_league['basketball/nba'].remaining).toBe(499);
    // One settled game over a two-day window => 0.5 games/day, so a real ETA.
    expect(p.per_sport.basketball.rate_per_day).toBeCloseTo(0.5, 4);
    expect(p.per_sport.basketball.eta_at).toEqual(expect.any(String));
  });

  test('no settled confirmation games means no fabricated ETA', () => {
    const p = forwardTest.progress();
    expect(p.target).toBe(500);
    expect(p.per_sport).toEqual({});
    expect(p.per_league).toEqual({});
  });

  test('no peeking: an unready confirmation dataset exposes counts only, never Brier/log loss', () => {
    const g = basketball();
    const after = freezeMs() + 3600000;
    recordForwardTest({ game: g, analysis: buildAnalysis({ game: g, now: after }), now: after });
    forwardTest.settle({ gameId: 'espn:1', homeScore: 110, awayScore: 100, now: after + 1 });

    // One settled game is far below the 500 target, so the confirmation surface
    // must withhold performance even though the numbers already exist on disk.
    const c = forwardTest.confirmationSummary('basketball');
    expect(c.ready_to_evaluate).toBe(false);
    expect(c.peeking_guarded).toBe(true);
    expect(c.settled_games).toBe(1);
    expect(c.brier).toBeNull();
    expect(c.logLoss).toBeNull();
    expect(c.hitRate).toBeNull();
  });

  test('no peeking: rollout progress exposes counts, rate and ETA but no performance', () => {
    const g = basketball();
    const after = freezeMs() + 3600000;
    recordForwardTest({ game: g, analysis: buildAnalysis({ game: g, now: after }), now: after });
    forwardTest.settle({ gameId: 'espn:1', homeScore: 110, awayScore: 100, now: after + 1 });

    const p = forwardTest.progress({ now: freezeMs() + 2 * 86400000 });
    const t = p.per_sport.basketball;
    expect(t.settled_games).toBe(1);
    expect(t.rate_per_day).toBeCloseTo(0.5, 4);
    expect(t.eta_at).toEqual(expect.any(String));
    // Not a performance surface: the metric keys must be absent entirely.
    expect(t.brier).toBeUndefined();
    expect(t.logLoss).toBeUndefined();
    expect(t.hitRate).toBeUndefined();
  });
});
