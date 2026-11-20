/**
 * Phase 4 — live probability model tests.
 *
 * Pure maths: no network, no providers. Games are Phase 3 LiveGame objects built
 * by hand (or via buildLiveGame) so the input contract is exercised end to end.
 */

const { predictLive, tierWeight } = require('../services/live/liveModel');
const { buildLiveGame } = require('../services/live/liveGame');
const { predictSoccer, elapsedMinutes: soccerElapsed, scoreMultiplier } = require('../services/live/soccerLive');
const {
  predictBasketball, elapsedMinutes: nbaElapsed, leagueParams, paceRead,
} = require('../services/live/basketballLive');
const M = require('../services/live/liveMath');
const CFG = require('../services/live/config');

/** Minimal LiveGame shaped exactly like liveGame.buildLiveGame output. */
function game({
  sport = 'soccer', homeScore = 0, awayScore = 0, clock = null, period = 0,
  status = 'live', tier = 'full_live', league = null,
} = {}) {
  return {
    game_id: 'x:1',
    sport,
    source: 'espn',
    league: league || { id: sport === 'basketball' ? 'nba' : 'eng.1', name: 'L' },
    home: { id: 'h', name: 'Home', logo: null, score: homeScore, record: null },
    away: { id: 'a', name: 'Away', logo: null, score: awayScore, record: null },
    live: { status, is_live: status === 'live', clock, period, raw_status: null },
    schedule: { kickoff: null, kickoff_ts: null, venue: null },
    data_tier: tier,
    data_tier_label: null,
    freshness: null,
    match: null,
    link: null,
    manual: tier === 'user_entered',
  };
}

describe('liveMath helpers', () => {
  test('normalInv is the inverse of normalCdf', () => {
    [-1.5, -0.4, 0, 0.4, 1.5].forEach(z => {
      expect(M.normalInv(M.normalCdf(z))).toBeCloseTo(z, 6);
    });
  });

  test('parseClock understands both clock formats and rejects junk', () => {
    expect(M.parseClock('7:24')).toEqual({ minutes: 7.4, stoppage: 0, format: 'mm:ss' });
    expect(M.parseClock("34'")).toEqual({ minutes: 34, stoppage: 0, format: 'half' });
    expect(M.parseClock("90+4'")).toEqual({ minutes: 94, stoppage: 4, format: 'half' });
    expect(M.parseClock('half time')).toBeNull();
    expect(M.parseClock(null)).toBeNull();
  });

  test('poissonPmf sums to ~1 and peaks at lambda', () => {
    let total = 0;
    for (let k = 0; k <= 30; k++) total += M.poissonPmf(k, 1.55);
    expect(total).toBeCloseTo(1, 6);
    expect(M.poissonPmf(2, 2)).toBeGreaterThan(M.poissonPmf(0, 2));
  });

  test('dixonColesTau only touches the four low-score cells', () => {
    expect(M.dixonColesTau(2, 3, 1.5, 1.2, -0.05)).toBe(1);
    expect(M.dixonColesTau(1, 1, 1.5, 1.2, -0.05)).toBeCloseTo(1.05, 6);
  });
});

describe('Soccer model', () => {
  test('at kick-off the output equals the pre-game baseline projection', () => {
    const r = predictSoccer({ game: game({ clock: "0'", period: 1 }), weight: 1 });
    expect(r.status).toBe('live');
    expect(r.inputs.remaining_minutes).toBe(90);
    // 0-0 at 0' -> expected full-match goals from config.
    expect(r.expected.home_score).toBeCloseTo(CFG.liveModel.soccer.baseHomeGoals, 1);
    expect(r.expected.away_score).toBeCloseTo(CFG.liveModel.soccer.baseAwayGoals, 1);
  });

  test('probabilities sum to 1', () => {
    const r = predictSoccer({ game: game({ clock: "34'", period: 1, homeScore: 1 }), weight: 1 });
    const { home_win, draw, away_win } = r.probabilities;
    expect(home_win + draw + away_win).toBeCloseTo(1, 3);
  });

  test('a 2-0 lead at 85 minutes is a very likely home win', () => {
    const r = predictSoccer({ game: game({ clock: "85'", period: 2, homeScore: 2 }), weight: 1 });
    expect(r.inputs.remaining_minutes).toBeCloseTo(5, 1);
    expect(r.probabilities.home_win).toBeGreaterThan(0.9);
  });

  test('the trailing side gets a rate boost, the leading side a drag', () => {
    expect(scoreMultiplier(-1)).toBeGreaterThan(1);
    expect(scoreMultiplier(1)).toBeLessThan(1);
    expect(scoreMultiplier(0)).toBe(1);
  });

  test('red cards shift the rate split', () => {
    const base = { game: game({ clock: "60'", period: 2, homeScore: 1, awayScore: 0 }), weight: 1 };
    const plain = predictSoccer(base);
    const withRed = predictSoccer({ ...base, context: { red_cards: { home: 1, away: 0 } } });
    expect(withRed.inputs.lambda_home).toBeLessThan(plain.inputs.lambda_home);
    expect(withRed.inputs.lambda_away).toBeGreaterThan(plain.inputs.lambda_away);
    expect(withRed.probabilities.home_win).toBeLessThan(plain.probabilities.home_win);
    expect(withRed.notes.join(' ')).toMatch(/Red-card/);
  });

  test('shot pressure redistributes the rate without inflating the total', () => {
    const base = { game: game({ clock: "50'", period: 2 }), weight: 1 };
    const plain = predictSoccer(base);
    const shots = predictSoccer({ ...base, context: { shots_on_target: { home: 8, away: 2 } } });
    const before = plain.inputs.lambda_home + plain.inputs.lambda_away;
    const after = shots.inputs.lambda_home + shots.inputs.lambda_away;
    expect(after).toBeCloseTo(before, 3);
    expect(shots.inputs.lambda_home).toBeGreaterThan(plain.inputs.lambda_home);
    expect(shots.notes.join(' ')).toMatch(/Shot-pressure/);
  });

  test('too few shots means no shot-pressure adjustment', () => {
    const r = predictSoccer({
      game: game({ clock: "50'", period: 2 }), weight: 1,
      context: { shots_on_target: { home: 2, away: 1 } },
    });
    expect(r.notes.join(' ')).toMatch(/not applied/);
  });

  test('without a clock it returns prior_only rather than guessing', () => {
    const r = predictSoccer({ game: game({ clock: null, period: 0, homeScore: 1 }), weight: 1 });
    expect(r.status).toBe('prior_only');
    expect(r.reason).toMatch(/clock/);
    expect(r.blend.weight).toBe(0);
    expect(r.probabilities.home_win + r.probabilities.draw + r.probabilities.away_win).toBeCloseTo(1, 3);
  });

  test('the soccer clock is the cumulative match minute (ESPN convention)', () => {
    expect(soccerElapsed({ clock: "20'", period: 2 })).toBe(20);
    expect(soccerElapsed({ clock: "34'", period: 1 })).toBe(34);
    expect(soccerElapsed({ clock: "90'+7'", period: 2 })).toBe(90);
  });

  test('uncertainty band surrounds the projection and is ordered', () => {
    const r = predictSoccer({ game: game({ clock: "60'", period: 2, homeScore: 1, awayScore: 1 }), weight: 1 });
    expect(r.uncertainty.level).toBe(CFG.liveModel.uncertaintyLevel);
    expect(r.uncertainty.total.low).toBeLessThanOrEqual(r.uncertainty.total.high);
    expect(r.uncertainty.margin.low).toBeLessThanOrEqual(r.uncertainty.margin.high);
  });
});

describe('Basketball model', () => {
  const nbaGame = over => game({ sport: 'basketball', league: { id: 'nba', name: 'NBA' }, ...over });

  test('at tip-off the totals project at the league mean', () => {
    const r = predictBasketball({ game: nbaGame({ clock: '12:00', period: 1, homeScore: 0, awayScore: 0 }), weight: 1 });
    expect(r.status).toBe('live');
    expect(r.inputs.remaining_minutes).toBe(48);
    // The prior total is the league's own fitted mean (basketball/leagues.js).
    expect(r.expected.total).toBeCloseTo(leagueParams('nba').totalMean, 1);
  });

  test('sigma shrinks with the square root of the time left', () => {
    const full = predictBasketball({ game: nbaGame({ clock: '12:00', period: 1 }), weight: 1 });
    const half = predictBasketball({ game: nbaGame({ clock: '0:00', period: 3 }), weight: 1 });
    expect(half.inputs.remaining_minutes).toBeCloseTo(12, 1);
    expect(half.sigma.total).toBeLessThan(full.sigma.total);
    expect(half.sigma.total).toBeCloseTo(full.sigma.total * Math.sqrt(12 / 48), 1);
  });

  test('a big late lead makes the leader a heavy favourite', () => {
    const r = predictBasketball({
      game: nbaGame({ clock: '1:00', period: 4, homeScore: 110, awayScore: 88 }), weight: 1,
    });
    expect(r.probabilities.home_win).toBeGreaterThan(0.97);
    expect(r.expected.margin).toBeGreaterThan(20);
  });

  test('the endgame adjustment widens sigma and lifts the rate', () => {
    const normal = predictBasketball({ game: nbaGame({ clock: '3:00', period: 4, homeScore: 100, awayScore: 98 }), weight: 1 });
    const endgame = predictBasketball({ game: nbaGame({ clock: '1:00', period: 4, homeScore: 100, awayScore: 98 }), weight: 1 });
    expect(endgame.notes.join(' ')).toMatch(/Endgame/);
    const ratio = endgame.sigma.margin / endgame.inputs.remaining_minutes;
    expect(ratio).toBeGreaterThan(normal.sigma.margin / normal.inputs.remaining_minutes);
  });

  test('overtime periods are accounted for', () => {
    const params = leagueParams('nba');
    expect(nbaElapsed({ clock: '3:00', period: 5 }, params)).toBeCloseTo(50, 2);
  });

  test('an unknown league falls back to the documented defaults', () => {
    const params = leagueParams('some-other-league');
    expect(params.fitted).toBe(false);
    const r = predictBasketball({
      game: game({ sport: 'basketball', league: { id: 'some-other-league', name: 'X' }, clock: '12:00', period: 1 }),
      weight: 1,
    });
    expect(r.notes.join(' ')).toMatch(/not recognised/);
    expect(r.expected.total).toBeCloseTo(CFG.liveModel.basketball.fallback.totalMean, 0);
  });

  test('without a clock it returns prior_only', () => {
    const r = predictBasketball({ game: nbaGame({ clock: null, period: 0, homeScore: 50, awayScore: 48 }), weight: 1 });
    expect(r.status).toBe('prior_only');
    expect(r.probabilities.home_win + r.probabilities.away_win).toBeCloseTo(1, 3);
  });
});

describe('Basketball live-stat tempo (paceRead)', () => {
  const params = leagueParams('nba'); // fitted: ~102.5 possessions/team over 48 min
  const ballStats = possessions => ({ sport: 'basketball', totals: { possessions } });
  const leaguePace = (2 * params.possessionsPerTeam) / params.gameMinutes;

  test('a game played at league tempo leaves the rate untouched', () => {
    const read = paceRead({ stats: ballStats(leaguePace * 24) }, params, 24);
    expect(read).not.toBeNull();
    expect(read.ratio).toBeCloseTo(1, 3);
    expect(read.factor).toBeCloseTo(1, 3);
  });

  test('a fast game lifts the rate and a slow one drags it, both bounded', () => {
    const cfg = CFG.liveModel.basketball.tempo;
    const fast = paceRead({ stats: ballStats(leaguePace * 24 * 1.4) }, params, 24);
    const slow = paceRead({ stats: ballStats(leaguePace * 24 * 0.5) }, params, 24);
    expect(fast.factor).toBeGreaterThan(1);
    expect(slow.factor).toBeLessThan(1);
    expect(fast.factor).toBeLessThanOrEqual(cfg.scaleMax);
    expect(slow.factor).toBeGreaterThanOrEqual(cfg.scaleMin);
  });

  test('no read without possession data, enough time, or a league pace', () => {
    expect(paceRead({ stats: ballStats(100) }, params, 3)).toBeNull();          // too early
    expect(paceRead({ stats: ballStats(5) }, params, 24)).toBeNull();           // too few
    expect(paceRead({}, params, 24)).toBeNull();                                // no stats
    expect(paceRead({ stats: { sport: 'basketball', totals: {} } }, params, 24)).toBeNull();
    expect(paceRead({ stats: ballStats(100) }, leagueParams('unknown'), 24)).toBeNull(); // no league pace
  });
});

describe('Engine projections bridge (in-process)', () => {
  const engineProjections = require('../services/basketball/engineProjections');

  beforeEach(() => engineProjections.reset());
  afterAll(() => engineProjections.reset());

  test('publishes formatted projections and reads them back by live game id', () => {
    const n = engineProjections.publishAll([
      { gameId: 'espn:401', projection: { margin: -7.5, total: 228.5 } },
      { gameId: 'espn:402', projection: { margin: 2, total: 219 } },
    ]);
    expect(n).toBe(2);
    expect(engineProjections.lookup('espn:401')).toMatchObject({ margin: -7.5, total: 228.5 });
    // A live game id is `source:eventId`; the bridge keys on the event id only.
    expect(engineProjections.lookup('flashscore:401')).toMatchObject({ margin: -7.5 });
  });

  test('an unusable projection is ignored and absence reads as null', () => {
    expect(engineProjections.publish('espn:1', { margin: null, total: 220 })).toBeNull();
    expect(engineProjections.lookup('espn:1')).toBeNull();
    expect(engineProjections.lookup(null)).toBeNull();
    expect(engineProjections.lookup('espn:nope')).toBeNull();
  });

  test('the live model uses the projected margin as its prior when present', () => {
    engineProjections.publish('401', { margin: -9, total: 230 });
    const g = { ...game({ sport: 'basketball', league: { id: 'nba' }, clock: '12:00', period: 1 }), game_id: 'espn:401' };
    const withEngine = predictBasketball({ game: g, weight: 1, engineProjection: engineProjections.lookup(g.game_id) });
    const without = predictBasketball({ game: g, weight: 1 });
    // No engine prior: the league's small home-court edge. With it: a 9-point
    // AWAY favourite, so the home prior margin flips negative.
    expect(without.expected.margin).toBeGreaterThan(0);
    expect(withEngine.expected.margin).toBeLessThan(0);
    expect(withEngine.notes.join(' ')).toMatch(/pre-game engine projection/);
  });
});

describe('Blending by data tier', () => {
  test('a lower tier pulls the REMAINING projection toward the prior, never the banked score', () => {
    // Half the game gone (period 2, 0:00) and a high-scoring, lopsided game.
    const fixture = { sport: 'basketball', league: { id: 'nba' }, clock: '0:00', period: 2, homeScore: 80, awayScore: 60 };
    const full = predictLive({ game: game({ ...fixture, tier: 'full_live' }) });
    const user = predictLive({ game: game({ ...fixture, tier: 'user_entered' }) });

    expect(full.blend.weight).toBe(1);
    // A hand-typed game is shrunk FURTHER than its tier weight alone (Phase 7).
    const shrunk = CFG.liveModel.tierWeight.user_entered * (1 - CFG.liveModel.manual.extraShrink);
    expect(user.blend.weight).toBeCloseTo(shrunk, 6);
    expect(user.blend.prior_used).toBe(true);

    // RC2: the score already on the board is FACT — a less-trusted feed widens
    // the uncertainty about the future but never shrinks a real 20-point lead.
    expect(user.current.margin).toBe(20);
    expect(user.expected.margin).toBeCloseTo(full.expected.margin, 6);

    // The REMAINING total (what is still to be played) IS blended: the faster-
    // than-league live read is pulled toward the lower pre-game prior.
    expect(user.expected.total).toBeLessThan(full.expected.total);
    // Same margin mean with a wider band -> the two-way read sits nearer a coin flip.
    expect(user.probabilities.home_win).toBeLessThan(full.probabilities.home_win);
  });

  test('tail probability is preserved through the helpers', () => {
    expect(predictLive({ game: game({ sport: 'basketball', clock: '0:00', period: 4, homeScore: 100, awayScore: 100 }) })
      .probabilities.home_win).toBeCloseTo(0.5, 1);
  });
});

describe('Manual (hand-typed) conservatism — Phase 7', () => {
  test('a hand-typed game is shrunk further toward the prior than its tier alone', () => {
    const base = game({
      sport: 'basketball', league: { id: 'nba' }, clock: '0:00', period: 2,
      homeScore: 80, awayScore: 60, tier: 'user_entered',
    });
    const asTyped = predictLive({ game: base });                 // manual: true
    const asVerified = predictLive({ game: { ...base, manual: false } });

    expect(asTyped.blend.weight).toBeLessThan(asVerified.blend.weight);
    // The extra shrink pulls the REMAINING projection harder toward the prior;
    // the banked score itself is untouched by either weight (RC2).
    expect(asTyped.expected.total).toBeLessThan(asVerified.expected.total);
    expect(asTyped.expected.margin).toBeCloseTo(asVerified.expected.margin, 6);
  });

  test('a hand-typed basketball game gets a wider margin band', () => {
    const base = game({
      sport: 'basketball', league: { id: 'nba' }, clock: '0:00', period: 4,
      homeScore: 120, awayScore: 90, tier: 'user_entered',
    });
    const typed = predictLive({ game: base });
    const verified = predictLive({ game: { ...base, manual: false } });
    const width = r => r.uncertainty.margin.high - r.uncertainty.margin.low;
    expect(width(typed)).toBeGreaterThan(width(verified));
  });

  test('a hand-typed soccer game gets a wider total band', () => {
    const base = game({
      sport: 'soccer', clock: "60'", period: 2, homeScore: 1, awayScore: 1, tier: 'user_entered',
    });
    const typed = predictLive({ game: base });
    const verified = predictLive({ game: { ...base, manual: false } });
    const width = r => r.uncertainty.total.high - r.uncertainty.total.low;
    expect(width(typed)).toBeGreaterThan(width(verified));
  });

  test('provider context is ignored for a hand-typed game', () => {
    const g = game({ sport: 'soccer', clock: "60'", period: 2, homeScore: 1, awayScore: 0, tier: 'user_entered' });
    const ignored = predictLive({
      game: g,
      // Neither of these may influence a hand-typed game: nothing was verified.
      context: { red_cards: { home: 1, away: 0 }, shots_on_target: { home: 9, away: 1 } },
    });
    const plain = predictLive({ game: g });
    expect(ignored.inputs).toEqual(plain.inputs);
    expect(ignored.notes.join(' ')).not.toMatch(/Red-card adjustment|Shot-pressure adjustment/);
    expect(ignored.notes.join(' ')).toMatch(/Hand-typed/);
  });
});

describe('Dispatcher', () => {
  test('routes by sport and rejects an unvalidated sport', () => {
    expect(predictLive({ game: game({ sport: 'soccer', clock: "10'", period: 1 }) }).model)
      .toBe('soccer_remaining_poisson_dc');
    expect(predictLive({ game: game({ sport: 'basketball', clock: '5:00', period: 2 }) }).model)
      .toBe('basketball_remaining_normal');
    const bad = predictLive({ game: game({ sport: 'hockey' }) });
    expect(bad.status).toBe('unsupported');
  });

  test('a finished game is not modelled', () => {
    const r = predictLive({ game: game({ status: 'finished', clock: "90'", period: 2, homeScore: 2, awayScore: 1 }) });
    expect(r.status).toBe('not_live');
  });

  test('throws when there is no game', () => {
    expect(() => predictLive({ game: null })).toThrow(/LiveGame/);
    expect(() => predictLive({ game: { sport: null } })).toThrow(/sport/);
  });

  test('an unknown data tier gets the most conservative weight', () => {
    expect(tierWeight('nonsense')).toBe(Math.min(...Object.values(CFG.liveModel.tierWeight)));
    expect(tierWeight('full_live')).toBe(1);
  });
});

describe('Integration with Phase 3 output', () => {
  test('a LiveGame built by liveGame.js feeds straight into the model', () => {
    const fixture = {
      sport: 'basketball',
      league: { id: 'nba', name: 'NBA' },
      fixture: {
        id: '401', sourceId: '401', date: null, timestamp: null,
        status: 'live', rawStatus: null, clock: '6:00', period: 3, venue: null,
      },
      homeTeam: { id: 'h', name: 'Home', logo: null, score: 82, record: null },
      awayTeam: { id: 'a', name: 'Away', logo: null, score: 79, record: null },
      source: 'espn',
    };
    const lg = buildLiveGame({ candidate: { source: 'espn', fixture, match_confidence: 0.9 }, fetchedAt: Date.now() });
    expect(lg.data_tier).toBe('full_live');
    const model = predictLive({ game: lg });
    expect(model.status).toBe('live');
    expect(model.expected.margin).toBeGreaterThan(0);
  });
});
