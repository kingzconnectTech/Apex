/**
 * Phase 5 — live backtest / validation-gate tests.
 *
 * Pure: no network. Replay fixtures mirror the ESPN shapes verified against live
 * pulls (basketball summary.plays[], soccer summary.keyEvents[]), and the
 * backtester is exercised through hand-built rows so the gate clauses are pinned
 * exactly rather than inferred from a stochastic dataset.
 */

const {
  basketballCheckpoints,
  soccerGoalLog,
  soccerCheckpoints,
  recordFromSummary,
  lineFromPickcenter,
  buildGameRecord,
} = require('../services/live/replay');

const {
  scoreTimeProbability,
  windowOf,
  normalizeWindows,
  evaluate,
  metrics,
  summariseColumn,
  compareBaselines,
  stampShipped,
  wilsonLowerBound,
  basketballElapsed,
  progressFraction,
  bucketFor,
  groupByGame,
  countGames,
  gameBootstrap,
  calibrationGate,
  shipGate,
  leagueSanity,
  buildVerdict,
  coverageReport,
  runLiveBacktest,
  formatReport,
} = require('../services/live/backtester');

/* ------------------------------------------------------------------ fixtures */

/** ESPN basketball summary.plays[] subset — scores/clock/period as recorded. */
const BB_PLAYS = [
  { period: { number: 1 }, clock: { displayValue: '12:00' }, homeScore: '0', awayScore: '0' },
  { period: { number: 1 }, clock: { displayValue: '7:00' }, homeScore: '10', awayScore: '8' },
  { period: { number: 1 }, clock: { displayValue: '5:30' }, homeScore: '15', awayScore: '12' },
  { period: { number: 1 }, clock: { displayValue: '0:00' }, homeScore: '28', awayScore: '26' },
  { period: { number: 2 }, clock: { displayValue: '9:00' }, homeScore: '35', awayScore: '33' },
  { period: { number: 2 }, clock: { displayValue: '3:30' }, homeScore: '45', awayScore: '42' },
];

/** ESPN soccer summary.keyEvents[] subset. `clock.value` is seconds. */
const SOCCER_KEY_EVENTS = [
  { scoringPlay: true, team: { id: 'H' }, clock: { value: 600 }, type: { text: 'Goal' }, text: 'Goal! Home 1, Away 0.' },
  { scoringPlay: true, team: { id: 'A' }, clock: { value: 1800 }, type: { text: 'Goal' }, text: 'Goal! Home 1, Away 1.' },
  { scoringPlay: true, team: { id: 'H' }, clock: { value: 3000 }, type: { text: 'Goal' }, text: 'Goal! Home 2, Away 1.' },
];

const SOCCER_CTX = {
  homeTeamId: 'H', awayTeamId: 'A', homeName: 'Home', awayName: 'Away',
  minutes: [15, 30, 45, 60, 75],
};

function basketballEvent(id, homeScore, awayScore) {
  return {
    id,
    date: '2026-04-10T23:00:00Z',
    competitions: [{
      venue: { fullName: 'Test Arena' },
      competitors: [
        { homeAway: 'home', team: { id: '1', displayName: 'Lakers' }, score: { value: homeScore } },
        { homeAway: 'away', team: { id: '2', displayName: 'Celtics' }, score: { value: awayScore } },
      ],
    }],
  };
}

function basketballSummary(plays = BB_PLAYS) {
  return {
    plays,
    pickcenter: [{
      moneyline: { home: { close: { odds: -150 } }, away: { close: { odds: 130 } } },
      overUnder: 220,
      overOdds: -110,
      underOdds: -110,
      provider: { name: 'Test Book' },
    }],
  };
}

/** A replay game record with deterministic checkpoints. */
function bbGame(i, { homeWin }) {
  const finalHome = homeWin ? 112 : 104;
  const finalAway = homeWin ? 104 : 112;
  return buildGameRecord({
    gameId: `B${i}`,
    sport: 'basketball',
    league: 'nba',
    kickoff: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString(),
    home: { teamId: 'H', name: 'Home' },
    away: { teamId: 'A', name: 'Away' },
    final: { home: finalHome, away: finalAway },
    line: { moneyline: { home: -140, away: 120 }, provider: 'test' },
    checkpoints: [
      { label: 'p1_6min_left', period: 1, clock: '6:00', home_score: 28, away_score: 26 },
      { label: 'p2_6min_left', period: 2, clock: '6:00', home_score: 56, away_score: 52 },
      { label: 'p3_6min_left', period: 3, clock: '6:00', home_score: 80, away_score: 78 },
      { label: 'p4_6min_left', period: 4, clock: '6:00', home_score: 100, away_score: 96 },
    ],
  });
}

function soccerGame(i, { homeWin }) {
  const finalHome = homeWin ? 2 : 1;
  const finalAway = homeWin ? 1 : 2;
  const checkpoints = [15, 30, 45, 60, 75].map(m => ({
    label: `m${m}`,
    period: m <= 45 ? 1 : 2,
    clock: `${m}'`,
    home_score: m >= 30 ? Math.min(finalHome, 1) : 0,
    away_score: m >= 60 ? Math.min(finalAway, 1) : 0,
  }));
  return buildGameRecord({
    gameId: `S${i}`,
    sport: 'soccer',
    league: 'eng.1',
    kickoff: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString(),
    home: { teamId: 'HS', name: 'Home S' },
    away: { teamId: 'AS', name: 'Away S' },
    final: { home: finalHome, away: finalAway },
    line: { moneyline: { home: -120, away: 300, draw: 250 }, provider: 'test' },
    checkpoints,
  });
}

/** 60 alternating games (30 per sport) — enough for the windows to be non-empty. */
function smallDataset() {
  const games = [];
  for (let i = 0; i < 60; i++) {
    games.push(i % 2 === 0 ? bbGame(i, { homeWin: i % 4 === 0 }) : soccerGame(i, { homeWin: i % 3 === 0 }));
  }
  return { games };
}

/* ------------------------------------------------------------- replay: basket */

describe('replay — basketball checkpoints', () => {
  test('snapshots the state at or BEFORE each mark and never reads a later play', () => {
    const cps = basketballCheckpoints(BB_PLAYS, { minutesRemaining: [6, 3, 0], maxPeriods: 2 });
    expect(cps.map(c => c.label)).toEqual([
      'p1_6min_left', 'p1_3min_left', 'p1_end', 'p2_6min_left', 'p2_3min_left',
    ]);
    // The 6-min-left mark must use the 7:00 play (10-8), not the later 5:30 play.
    expect(cps[0]).toMatchObject({ period: 1, clock: '7:00', home_score: 10, away_score: 8 });
    expect(cps[1]).toMatchObject({ clock: '5:30', home_score: 15, away_score: 12 });
    expect(cps[2]).toMatchObject({ clock: '0:00', home_score: 28, away_score: 26 });
    expect(cps[3]).toMatchObject({ period: 2, clock: '9:00', home_score: 35, away_score: 33 });
    expect(cps[4]).toMatchObject({ period: 2, clock: '3:30', home_score: 45, away_score: 42 });
  });

  test('skips the final period buzzer (there the game is already decided)', () => {
    const cps = basketballCheckpoints(BB_PLAYS, { minutesRemaining: [0], maxPeriods: 2 });
    expect(cps.map(c => c.label)).toEqual(['p1_end']); // period 1 only; period 2 end skipped
  });

  test('returns nothing rather than guessing when plays are missing', () => {
    expect(basketballCheckpoints([])).toEqual([]);
    expect(basketballCheckpoints(null)).toEqual([]);
  });
});

/* ------------------------------------------------------------- replay: soccer */

describe('replay — soccer checkpoints', () => {
  test('running score is the score after every goal at or before the mark', () => {
    const cps = soccerCheckpoints(SOCCER_KEY_EVENTS, SOCCER_CTX);
    expect(cps.map(c => `${c.label}:${c.home_score}-${c.away_score}`)).toEqual([
      'm15:1-0', 'm30:1-1', 'm45:1-1', 'm60:2-1', 'm75:2-1',
    ]);
  });

  test('own goal credits the team id when the running score is absent', () => {
    // ESPN sets ev.team.id to the team CREDITED with the goal (the beneficiary),
    // even on an own goal, so the id is used directly with no flip. An own goal
    // by the away side's own defender still counts for the away side only if
    // ESPN credits the away side; here team.id='A' (away) is the credited side.
    const events = [
      { scoringPlay: true, team: { id: 'A' }, clock: { value: 900 }, type: { text: 'Own Goal' }, text: 'Own goal.' },
    ];
    const log = soccerGoalLog(events, SOCCER_CTX);
    expect(log).toEqual([{ seconds: 900, home: 0, away: 1 }]);
  });

  test('shootout and non-goal events are ignored', () => {
    const events = [
      { scoringPlay: true, shootout: true, team: { id: 'H' }, clock: { value: 100 }, type: { text: 'Goal' }, text: 'x' },
      { scoringPlay: false, team: { id: 'H' }, clock: { value: 200 }, type: { text: 'Shot' }, text: 'y' },
      { scoringPlay: true, team: { id: 'H' }, clock: { value: 300 }, type: { text: 'Yellow Card' }, text: 'z' },
    ];
    expect(soccerGoalLog(events, SOCCER_CTX)).toEqual([]);
  });
});

/* ---------------------------------------------------------- replay: assembling */

describe('replay — recordFromSummary / lineFromPickcenter', () => {
  test('builds a replay record from an ESPN event + summary', () => {
    const rec = recordFromSummary({
      sport: 'basketball',
      league: 'nba',
      event: basketballEvent('401', 112, 108),
      summary: basketballSummary(),
    });
    expect(rec).not.toBeNull();
    expect(rec.final).toEqual({ home: 112, away: 108 });
    expect(rec.home.name).toBe('Lakers');
    expect(rec.checkpoints.length).toBeGreaterThan(0);
    expect(rec.line.moneyline.home).toBe(-150);
  });

  test('returns null rather than a half-built record when data is missing', () => {
    expect(recordFromSummary({ sport: 'basketball', league: 'nba', event: { id: '1' }, summary: {} })).toBeNull();
    expect(recordFromSummary({
      sport: 'basketball', league: 'nba',
      event: basketballEvent('2', 100, 99), summary: { plays: [] },
    })).toBeNull();
  });

  test('stamps provenance meta (season) onto the record when supplied', () => {
    const rec = recordFromSummary({
      sport: 'basketball',
      league: 'nba',
      event: basketballEvent('402', 110, 100),
      summary: basketballSummary(),
      meta: { season: '2025-26', seasonFrom: '20251021', seasonTo: '20260412' },
    });
    expect(rec.meta).toEqual({ season: '2025-26', seasonFrom: '20251021', seasonTo: '20260412' });
  });

  test('lineFromPickcenter prefers close odds and tolerates an empty payload', () => {
    expect(lineFromPickcenter({ pickcenter: [] })).toBeNull();
    const line = lineFromPickcenter(basketballSummary());
    expect(line.moneyline).toMatchObject({ home: -150, away: 130 });
    expect(line.provider).toBe('Test Book');
  });
});

/* --------------------------------------------------- baseline: score-and-time */

describe('scoreTimeProbability baseline', () => {
  test('basketball: a tie is a coin flip, a lead late is near-certain', () => {
    expect(scoreTimeProbability({ clock: '12:00', period: 1, home_score: 0, away_score: 0 }, 'basketball')).toBeCloseTo(0.5, 4);
    const late = scoreTimeProbability({ clock: '0:00', period: 4, home_score: 100, away_score: 80 }, 'basketball');
    expect(late).toBe(1);
    const behind = scoreTimeProbability({ clock: '0:30', period: 4, home_score: 80, away_score: 100 }, 'basketball');
    expect(behind).toBeLessThan(0.05);
  });

  test('basketball: no clock or no period yields null (never a guess)', () => {
    expect(scoreTimeProbability({ clock: null, period: 1, home_score: 10, away_score: 8 }, 'basketball')).toBeNull();
    expect(scoreTimeProbability({ clock: '6:00', period: 0, home_score: 10, away_score: 8 }, 'basketball')).toBeNull();
  });

  test('soccer: a 3-0 lead at 90 minutes is certain; 0-0 at 90 is a draw', () => {
    expect(scoreTimeProbability({ clock: "90'", period: 2, home_score: 3, away_score: 0 }, 'soccer')).toBe(1);
    expect(scoreTimeProbability({ clock: "90'", period: 2, home_score: 0, away_score: 0 }, 'soccer')).toBe(0);
    const early = scoreTimeProbability({ clock: "0'", period: 1, home_score: 0, away_score: 0 }, 'soccer');
    expect(early).toBeGreaterThan(0.4);
    expect(early).toBeLessThan(0.6);
  });
});

/* ------------------------------------------------------------------ mechanics */

describe('backtester mechanics', () => {
  test('windowOf splits the chronological list by fraction', () => {
    const w = normalizeWindows();
    expect(windowOf(0, 10, w)).toBe('train');
    expect(windowOf(5, 10, w)).toBe('train');
    expect(windowOf(6, 10, w)).toBe('validation');
    expect(windowOf(8, 10, w)).toBe('test');
  });

  test('wilsonLowerBound is below the point estimate and null for n=0', () => {
    const lower = wilsonLowerBound(60, 100, 1.96);
    expect(lower).toBeLessThan(0.6);
    expect(lower).toBeGreaterThan(0.45);
    expect(wilsonLowerBound(0, 0, 1.96)).toBeNull();
  });

  test('stampShipped uses the calibrated value only when the gate kept it', () => {
    const rows = [
      { sport: 'basketball', pRaw: 0.4, pCal: 0.55 },
      { sport: 'soccer', pRaw: 0.3, pCal: 0.2 },
      { sport: 'hockey', pRaw: 0.7, pCal: 0.9 },
      { sport: 'basketball', pRaw: 0.5, pCal: null },
    ];
    stampShipped(rows, { basketball: { kept: true }, soccer: { kept: false } });
    expect(rows[0].pShipped).toBe(0.55);   // kept -> calibrated
    expect(rows[1].pShipped).toBe(0.3);    // rejected -> raw
    expect(rows[2].pShipped).toBe(0.7);    // no verdict -> raw
    expect(rows[3].pShipped).toBe(0.5);    // no fitted value -> raw
  });

  test('compareBaselines scores the headline model on the shipped column', () => {
    const rows = [
      { y: 1, pShipped: 0.9, pRaw: 0.6, pCal: 0.7, priorP: 0.5, scoreTimeP: 0.5, pregameLineP: 0.6, naiveP: 0.5 },
      { y: 0, pShipped: 0.1, pRaw: 0.4, pCal: 0.3, priorP: 0.5, scoreTimeP: 0.5, pregameLineP: 0.6, naiveP: 0.5 },
    ];
    const b = compareBaselines(rows);
    expect(b.model.n).toBe(2);
    expect(b.model.brier).toBeCloseTo(0.01, 4);
    expect(b.modelUncalibrated.brier).toBeCloseTo(0.16, 4);
    expect(b.walkForwardCalibrated.n).toBe(2);
    // The pre-game line is reported but is not the reference the gate uses.
    expect(b.pregameLine.n).toBe(2);
    expect(b.scoreTime.n).toBe(2);
  });

  test('evaluate carries the checkpoint snapshot, not the final score', () => {
    const ev = evaluate({ games: [bbGame(0, { homeWin: true })] });
    expect(ev.games).toBe(1);
    expect(ev.rows.length).toBe(4);
    const first = ev.rows[0];
    expect(first).toMatchObject({ home_score: 28, away_score: 26, period: 1, clock: '6:00' });
    ev.rows.forEach(r => {
      expect(Number.isFinite(r.pRaw)).toBe(true);
      expect(Number.isFinite(r.priorP)).toBe(true);
      // The pre-game line is carried for information only — never a reference.
      expect(Number.isFinite(r.pregameLineP)).toBe(true);
      expect(Number.isFinite(r.scoreTimeP)).toBe(true);
      expect(['early', 'mid', 'late']).toContain(r.bucket);
    });
  });
});

/* -------------------------------------------------------------- calibration */

describe('calibrationGate', () => {
  /** Rows where the raw probabilities are already calibrated (identity wins). */
  function wellCalibratedRows(sport, n) {
    const rows = [];
    for (let i = 0; i < n; i++) {
      const p = (i % 10) / 10 + 0.05;
      rows.push({ sport, window: 'train', pRaw: p, y: p });
    }
    return rows;
  }

  test('rejects a calibrator that cannot beat the identity on held-out rows', () => {
    const rows = [
      ...wellCalibratedRows('basketball', 200),
      // Validation rows: raw is already right, so any reshape must lose.
      ...Array.from({ length: 60 }, (_, i) => ({
        sport: 'basketball', window: 'validation', pRaw: i % 2 === 0 ? 0.9 : 0.1, y: i % 2 === 0 ? 1 : 0,
      })),
    ];
    const gate = calibrationGate(rows, { calibration: { minSamples: 50 } });
    expect(gate.basketball).toBeDefined();
    expect(gate.basketball.kept).toBe(false);
    expect(gate.basketball.model).toBeNull();
  });

  test('reports fitted=false and kept=false when below the minimum sample size', () => {
    const rows = Array.from({ length: 10 }, () => ({ sport: 'soccer', window: 'train', pRaw: 0.5, y: 1 }));
    const gate = calibrationGate(rows, { calibration: { minSamples: 150 } });
    expect(gate.soccer.fitted).toBe(false);
    expect(gate.soccer.kept).toBe(false);
  });
});

/* ------------------------------------------------------------------ ship gate */

describe('shipGate', () => {
  /** n games where the model is right and the score-and-time baseline is wrong. */
  function strongRows(n, { model = 0.9, reference = 0.6, y = 1 } = {}) {
    return Array.from({ length: n }, (_, i) => ({
      sport: 'basketball', window: 'test', gameId: `G${i}`,
      pShipped: model, scoreTimeP: reference, y,
    }));
  }

  test('passes when every clause clears, with the CI lower bound above break-even', () => {
    const g = shipGate(strongRows(600));
    expect(g.games).toBe(600);
    expect(g.rows).toBe(600);
    expect(g.referenceKey).toBe('scoreTimeP');
    expect(g.passed).toBe(true);
    expect(g.reasons).toEqual([]);
    expect(g.hitRateLowerBound).toBeGreaterThan(g.breakEvenProbability);
    expect(g.bootstrap.brierGain.lower).toBeGreaterThan(0);
  });

  test('fails and names the sample-size clause on a thin window', () => {
    const g = shipGate(strongRows(100));
    expect(g.passed).toBe(false);
    expect(g.reasons.join(' ')).toMatch(/out-of-sample games 100 < 500/);
  });

  test('counts GAMES, not checkpoint rows', () => {
    // 40 games x 11 checkpoints = 440 rows, but only 40 independent outcomes.
    const rows = [];
    for (let g = 0; g < 40; g++) {
      for (let c = 0; c < 11; c++) {
        rows.push({ sport: 'basketball', window: 'test', gameId: `G${g}`, pShipped: 0.9, scoreTimeP: 0.6, y: 1 });
      }
    }
    const verdict = shipGate(rows);
    expect(verdict.rows).toBe(440);
    expect(verdict.games).toBe(40);
    expect(verdict.reasons.join(' ')).toMatch(/out-of-sample games 40 < 500/);
  });

  test('fails and names the metric clause when the model is worse than the reference', () => {
    const g = shipGate(strongRows(600, { model: 0.6, reference: 0.9, y: 1 }));
    expect(g.passed).toBe(false);
    expect(g.reasons.join(' ')).toMatch(/Brier gain .* < /);
  });

  test('fails when the score-and-time baseline is unavailable', () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({
      sport: 'basketball', window: 'test', gameId: `G${i}`, pShipped: 0.9, scoreTimeP: null, y: 1,
    }));
    const g = shipGate(rows);
    expect(g.passed).toBe(false);
    expect(g.reasons.join(' ')).toMatch(/score-and-time baseline unavailable/);
  });
});

/* ------------------------------------------------------------------ verdict */

describe('buildVerdict honesty', () => {
  test('does NOT claim score-and-time is better when the model actually beat it', () => {
    const v = buildVerdict(
      { model: { games: 600, n: 600, logLoss: 0.2, brier: 0.05 }, scoreTime: { games: 600, n: 600, logLoss: 0.5, brier: 0.15 } },
      { basketball: { passed: false, reasons: ['out-of-sample games 220 < 500'] } },
    );
    expect(v.reference).toBe('score-and-time');
    expect(v.beatsScoreTimeBrier).toBe(true);
    expect(v.beatsScoreTimeLogLoss).toBe(true);
    expect(v.statement).not.toMatch(/score-and-time baseline is the better probability/i);
    expect(v.statement).toMatch(/beat the score-and-time baseline on BOTH/);
  });

  test('says score-and-time is better only when it genuinely is', () => {
    const v = buildVerdict(
      { model: { games: 600, n: 600, logLoss: 0.6, brier: 0.2 }, scoreTime: { games: 600, n: 600, logLoss: 0.5, brier: 0.15 } },
      { basketball: { passed: false, reasons: ['x'] } },
    );
    expect(v.beatsScoreTimeBrier).toBe(false);
    expect(v.beatsScoreTimeLogLoss).toBe(false);
    expect(v.statement).toMatch(/score-and-time baseline is the better probability/i);
  });

  test('refuses to make a claim on too few games', () => {
    const v = buildVerdict(
      { model: { games: 5, n: 5, logLoss: 0.2, brier: 0.05 }, scoreTime: { games: 5, n: 5, logLoss: 0.5, brier: 0.15 } },
      {},
    );
    expect(v.statement).toMatch(/Not enough graded out-of-sample games/);
  });
});

/* ----------------------------------------------------- whole-game statistics */

describe('whole-game grouping and bootstrap', () => {
  test('groupByGame groups checkpoints under one game id', () => {
    const groups = groupByGame([
      { gameId: 'A', y: 1 }, { gameId: 'A', y: 1 }, { gameId: 'B', y: 0 },
    ]);
    expect(groups.length).toBe(2);
    expect(countGames([{ gameId: 'A' }, { gameId: 'A' }, { gameId: 'B' }])).toBe(2);
  });

  test('rows without a gameId each count as their own game', () => {
    expect(countGames([{ y: 1 }, { y: 0 }, { y: 1 }])).toBe(3);
  });

  test('gameBootstrap resamples whole games, not rows', () => {
    // 10 games, 5 rows each, in every game the model is right and the baseline
    // is wrong. The interval must be driven by the 10 games.
    const rows = [];
    for (let g = 0; g < 10; g++) {
      for (let c = 0; c < 5; c++) {
        rows.push({ gameId: `G${g}`, pShipped: 0.9, scoreTimeP: 0.6, y: 1 });
      }
    }
    const boot = gameBootstrap(rows, { bootstrap: { iterations: 500, seed: 3 } });
    expect(boot.games).toBe(10);
    expect(boot.hitRate.lower).toBe(1);
    expect(boot.brierGain.lower).toBeCloseTo(0.15, 4);
  });

  test('gameBootstrap is deterministic for a fixed seed', () => {
    const rows = [];
    for (let g = 0; g < 30; g++) {
      rows.push({ gameId: `G${g}`, pShipped: g % 3 === 0 ? 0.4 : 0.8, scoreTimeP: 0.5, y: g % 2 });
    }
    const a = gameBootstrap(rows, { bootstrap: { iterations: 400, seed: 11 } });
    const b = gameBootstrap(rows, { bootstrap: { iterations: 400, seed: 11 } });
    expect(a.brierGain).toEqual(b.brierGain);
  });
});

/* ------------------------------------------------------------------- buckets */

describe('time buckets', () => {
  test('basketballElapsed reads elapsed/total from period + clock', () => {
    const t = basketballElapsed({ clock: '6:00', period: 1 });
    expect(t.elapsed).toBeCloseTo(6, 4);
    expect(t.total).toBe(48);
  });

  test('basketballElapsed uses the league regulation length, not sport-wide 48/4', () => {
    // CBB is two 20-minute halves: end of regulation is 40 minutes, not 48.
    const cbb = basketballElapsed({ clock: '0:00', period: 2 }, 'mens-college-basketball');
    expect(cbb.elapsed).toBe(40);
    expect(cbb.total).toBe(40);
    expect(cbb.regulation).toBe(40);
    // WNBA is four 10-minute quarters.
    const wnba = basketballElapsed({ clock: '0:00', period: 4 }, 'wnba');
    expect(wnba.elapsed).toBe(40);
    expect(wnba.total).toBe(40);
    // NBA unchanged.
    const nba = basketballElapsed({ clock: '0:00', period: 4 }, 'nba');
    expect(nba.elapsed).toBe(48);
    expect(nba.total).toBe(48);
  });

  test('progressFraction maps a checkpoint to 0..1 and bucketFor labels it', () => {
    expect(bucketFor(progressFraction({ clock: '12:00', period: 1 }, 'basketball'))).toBe('early');
    expect(bucketFor(progressFraction({ clock: '6:00', period: 3 }, 'basketball'))).toBe('mid');
    expect(bucketFor(progressFraction({ clock: '2:00', period: 4 }, 'basketball'))).toBe('late');
    expect(bucketFor(progressFraction({ clock: "20'", period: 1 }, 'soccer'))).toBe('early');
    expect(bucketFor(progressFraction({ clock: "80'", period: 2 }, 'soccer'))).toBe('late');
  });

  test('progressFraction is measured against regulation, so CBB reaches late', () => {
    // End of a college game must read as fully played (1.0 -> late), not 0.5.
    expect(progressFraction({ clock: '0:00', period: 2 }, 'basketball', 'mens-college-basketball')).toBeCloseTo(1, 4);
    expect(bucketFor(progressFraction({ clock: '0:00', period: 2 }, 'basketball', 'mens-college-basketball'))).toBe('late');
    expect(bucketFor(progressFraction({ clock: '20:00', period: 1 }, 'basketball', 'mens-college-basketball'))).toBe('early');
    // A WNBA half-way checkpoint hits mid on a 40-minute clock.
    expect(bucketFor(progressFraction({ clock: '0:00', period: 2 }, 'basketball', 'wnba'))).toBe('mid');
    // Overtime clamps to the late bucket.
    expect(bucketFor(progressFraction({ clock: '5:00', period: 5 }, 'basketball', 'nba'))).toBe('late');
  });

  test('an unreadable clock yields no bucket rather than a guess', () => {
    expect(progressFraction({ clock: null, period: 1 }, 'basketball')).toBeNull();
    expect(bucketFor(null)).toBeNull();
  });
});

/* ------------------------------------------------------------ league sanity */

describe('leagueSanity', () => {
  /** A judged league (>= minLeagueGames) where the model loses to the baseline. */
  function losingLeague(league, n) {
    return Array.from({ length: n }, (_, i) => ({
      sport: 'soccer', league, window: 'test', gameId: `${league}-${i}`,
      pShipped: 0.9, scoreTimeP: 0.1, y: 0,
    }));
  }

  test('blocks a judged league whose metrics contradict the sport-level result', () => {
    const rows = losingLeague('eng.1', 120);
    const out = leagueSanity(rows);
    expect(out['soccer|eng.1'].judged).toBe(true);
    expect(out['soccer|eng.1'].blocked).toBe(true);
    expect(out['soccer|eng.1'].reasons.join(' ')).toMatch(/worse than the score-and-time baseline/);
  });

  test('does not judge a league below the minimum sample size', () => {
    const out = leagueSanity(losingLeague('mex.1', 20));
    expect(out['soccer|mex.1'].judged).toBe(false);
    expect(out['soccer|mex.1'].blocked).toBe(false);
  });
});

/* ------------------------------------------------------------------ coverage */

describe('coverageReport', () => {
  test('counts games per sport / season / league with a date range', () => {
    const games = [
      { sport: 'basketball', league: 'nba', kickoff: '2025-11-01T00:00:00Z', meta: { season: '2025-26' } },
      { sport: 'basketball', league: 'nba', kickoff: '2025-12-01T00:00:00Z', meta: { season: '2025-26' } },
      { sport: 'basketball', league: 'wnba', kickoff: '2025-06-01T00:00:00Z', meta: { season: '2024-25' } },
    ];
    const cov = coverageReport(games);
    expect(cov.basketball.games).toBe(3);
    expect(cov.basketball.seasons['2025-26'].games).toBe(2);
    expect(cov.basketball.seasons['2025-26'].leagues.nba.games).toBe(2);
    expect(cov.basketball.seasons['2025-26'].from).toBe('2025-11-01T00:00:00Z');
    expect(cov.basketball.seasons['2025-26'].to).toBe('2025-12-01T00:00:00Z');
  });

  test('games with no season meta are reported as unlabelled, never dropped', () => {
    const cov = coverageReport([{ sport: 'soccer', league: 'esp.1', kickoff: '2025-09-01T00:00:00Z' }]);
    expect(cov.soccer.seasons.unlabelled.games).toBe(1);
  });
});

/* -------------------------------------------------------- end-to-end report */

describe('runLiveBacktest end to end', () => {
  test('produces an honest report scored on the shipped probability', () => {
    const report = runLiveBacktest(smallDataset(), {});

    expect(report.dataset.games).toBe(60);
    expect(report.dataset.sports.sort()).toEqual(['basketball', 'soccer']);
    expect(Object.keys(report.bySport).sort()).toEqual(['basketball', 'soccer']);

    // With the default 150-row minimum the small dataset cannot fit a calibrator,
    // so the shipped probability IS the raw one — the gate must be respected.
    expect(report.calibration.basketball.kept).toBe(false);
    expect(report.calibration.soccer.kept).toBe(false);
    expect(report.baselines.test.model.n).toBeGreaterThan(0);
    expect(report.baselines.test.model.logLoss).toBe(report.baselines.test.modelUncalibrated.logLoss);

    // Every named baseline is scored on the same selections. The pre-game line
    // is present for information only; score-and-time is the reference.
    ['model', 'modelUncalibrated', 'walkForwardCalibrated', 'scoreTime', 'prior', 'pregameLine', 'naive']
      .forEach(k => expect(report.baselines.test[k]).toBeDefined());
    expect(report.verdict.reference).toBe('score-and-time');

    // Time buckets are reported per sport, with an excluding-late headline.
    expect(report.byTimeBucket.basketball.excludingLate).toBeDefined();
    expect(report.byTimeBucket.soccer.excludingLate).toBeDefined();

    // Coverage is reported per sport / season / league.
    expect(report.coverage.basketball.games).toBeGreaterThan(0);

    // Thin test window -> the ship gate fails and names why.
    expect(report.shipGate.bySport.basketball.passed).toBe(false);
    expect(report.verdict.statement).toMatch(/Not enough graded out-of-sample games|Gate NOT passed/);

    const text = formatReport(report);
    expect(text).toMatch(/Live backtest/);
    expect(text).toMatch(/Baselines \(test window, same selections\)/);
    expect(text).toMatch(/pregameLine \(info only, not comparable\)/);
    expect(text).toMatch(/By time bucket/);
    expect(text).toContain('statistical estimates, not betting advice');
  });

  test('summariseColumn ignores rows with a missing probability column', () => {
    const s = summariseColumn([{ y: 1, pShipped: 0.8 }, { y: 0 }, { y: 1, pShipped: null }], 'pShipped');
    expect(s.n).toBe(1);
    expect(s.brier).toBeCloseTo(0.04, 4);
  });

  test('hand-typed games are excluded from the graded dataset entirely', () => {
    const base = smallDataset();
    const games = base.games.concat([
      { ...bbGame(900, { homeWin: true }), manual: true },
      { ...soccerGame(901, { homeWin: false }), source: 'manual' },
    ]);

    const report = runLiveBacktest({ games }, {});
    // Only the 60 provider games are graded; the two typed ones never enter
    // calibration, coverage or the hit rate.
    expect(report.dataset.games).toBe(60);
  });
});
