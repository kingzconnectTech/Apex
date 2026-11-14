/**
 * Phase 9 — the context-only experience.
 *
 * When no probability may be shown (a held sport, a game before its gate, a
 * hand-typed game) the screen falls back to CONTEXT. This module assembles that
 * context and must be honest: it never invents an event, never throws, and
 * degrades to the pre-game setting when the summary read is unavailable.
 *
 * These tests pin the extraction (reusing the shapes replay.js already relies
 * on), the assembly, and the cached best-effort fetch.
 */

const CONFIG = require('../services/live/config');
const liveContext = require('../services/live/liveContext');

beforeEach(() => {
  liveContext.resetCache();
});

/** A LiveGame shaped like liveGame.buildLiveGame output. */
function game({
  sport = 'basketball', leagueId = 'nba', gameId = 'espn:401',
  venue = 'Crypto.com Arena', kickoff = '2026-11-08T02:00:00Z',
  homeRecord = '6-3', awayRecord = '7-2', manual = false,
} = {}) {
  return {
    game_id: gameId,
    sport,
    source: 'espn',
    league: { id: leagueId, name: 'NBA' },
    home: { id: 'h', name: 'Lakers', logo: null, score: 70, record: homeRecord },
    away: { id: 'a', name: 'Celtics', logo: null, score: 66, record: awayRecord },
    live: { status: 'live', is_live: true, clock: '7:24', period: 3, raw_status: null },
    schedule: { kickoff, kickoff_ts: null, venue },
    data_tier: 'full_live',
    match: null,
    link: null,
    manual,
  };
}

const BASKETBALL_SUMMARY = {
  plays: [
    { scoringPlay: true, clock: { displayValue: '9:10' }, period: { number: 1 }, team: { displayName: 'Lakers' }, type: { text: 'Layup' }, text: 'makes layup', homeScore: 2, awayScore: 0 },
    { scoringPlay: false, clock: { displayValue: '8:40' }, period: { number: 1 }, type: { text: 'Foul' }, text: 'shooting foul' },
    { scoringPlay: true, clock: { displayValue: '8:00' }, period: { number: 1 }, team: { displayName: 'Celtics' }, type: { text: '3PT Jumper' }, text: 'makes three', homeScore: 2, awayScore: 3 },
  ],
};

const SOCCER_SUMMARY = {
  keyEvents: [
    { scoringPlay: true, clock: { displayValue: "12'", value: 720 }, team: { displayName: 'Arsenal' }, type: { text: 'Goal' }, text: 'Goal!' },
    { scoringPlay: false, shootout: true, clock: { displayValue: 'Pens' }, type: { text: 'Penalty' }, text: 'shootout goal' },
    { scoringPlay: false, clock: { value: 1800 }, type: { text: 'Yellow Card' }, text: 'booked' },
  ],
};

const INJURY_SUMMARY = {
  injuries: [
    {
      team: { id: 1, displayName: 'Lakers' },
      injuries: [
        { athlete: { id: 9, fullName: 'A. Player', position: { abbreviation: 'SF' } }, status: 'questionable', details: { detail: 'Ankle' } },
      ],
    },
  ],
};

describe('pregameContext', () => {
  test('reads venue, kickoff and both records from the game', () => {
    const pg = liveContext.pregameContext(game());
    expect(pg.venue).toBe('Crypto.com Arena');
    expect(pg.kickoff).toBe('2026-11-08T02:00:00Z');
    expect(pg.home).toEqual({ name: 'Lakers', record: '6-3' });
    expect(pg.away).toEqual({ name: 'Celtics', record: '7-2' });
  });

  test('is null when the game carries nothing worth showing', () => {
    expect(liveContext.pregameContext(game({ venue: null, kickoff: null, homeRecord: null, awayRecord: null }))).toBeNull();
    expect(liveContext.pregameContext(null)).toBeNull();
  });
});

describe('extractKeyEvents', () => {
  test('keeps only basketball scoring plays, newest first', () => {
    const evs = liveContext.extractKeyEvents(BASKETBALL_SUMMARY, { sport: 'basketball', max: 5 });
    expect(evs.map(e => e.type)).toEqual(['3PT Jumper', 'Layup']);
    expect(evs[0].clock).toBe('8:00');
    expect(evs[0].period).toBe(1);
    expect(evs[0].team).toBe('Celtics');
    expect(evs[0].scoring).toBe(true);
  });

  test('caps the list to the most recent events', () => {
    const evs = liveContext.extractKeyEvents(BASKETBALL_SUMMARY, { sport: 'basketball', max: 1 });
    expect(evs.length).toBe(1);
    expect(evs[0].type).toBe('3PT Jumper');
  });

  test('soccer keeps goals and cards, drops shootout events, newest first', () => {
    const evs = liveContext.extractKeyEvents(SOCCER_SUMMARY, { sport: 'soccer', max: 5 });
    expect(evs.map(e => e.type)).toEqual(['Yellow Card', 'Goal']);
    // The shootout entry never appears.
    expect(evs.some(e => /shootout/i.test(e.text || ''))).toBe(false);
    // A seconds-only clock is shown as a minute.
    expect(evs[0].clock).toBe("30'");
  });

  test('an unsupported sport yields nothing rather than guessing', () => {
    expect(liveContext.extractKeyEvents(BASKETBALL_SUMMARY, { sport: 'hockey' })).toEqual([]);
    expect(liveContext.extractKeyEvents(null, { sport: 'basketball' })).toEqual([]);
  });
});

describe('extractInjuries', () => {
  test('reuses the provider parser and reports the player and status', () => {
    const list = liveContext.extractInjuries(INJURY_SUMMARY, { max: 8 });
    expect(list.length).toBe(1);
    expect(list[0].playerName).toBe('A. Player');
    expect(list[0].position).toBe('SF');
    expect(list[0].teamName).toBe('Lakers');
    expect(list[0].status).toBe('questionable');
    expect(list[0].detail).toBe('Ankle');
  });

  test('returns nothing rather than a fabricated player', () => {
    expect(liveContext.extractInjuries({}, { max: 8 })).toEqual([]);
    expect(liveContext.extractInjuries(null)).toEqual([]);
  });
});

describe('buildContext (pure)', () => {
  test('assembles events, injuries, pre-game fields and a summary age label', () => {
    const summary = { ...BASKETBALL_SUMMARY, ...INJURY_SUMMARY };
    const ctx = liveContext.buildContext({ game: game(), summary, fetchedAt: 1000, now: 8000 });

    expect(ctx.available).toBe(true);
    expect(ctx.summary_available).toBe(true);
    expect(ctx.source).toBe('espn');
    expect(ctx.key_events.length).toBe(2);
    expect(ctx.injuries.length).toBe(1);
    expect(ctx.pregame.venue).toBe('Crypto.com Arena');
    expect(ctx.updated_label).toBe('updated 7s ago');
  });

  test('with no summary it degrades to the pre-game setting alone', () => {
    const ctx = liveContext.buildContext({ game: game(), summary: null, now: 8000 });
    expect(ctx.available).toBe(true);
    expect(ctx.summary_available).toBe(false);
    expect(ctx.key_events).toEqual([]);
    expect(ctx.injuries).toEqual([]);
    expect(ctx.updated_label).toBeNull();
  });
});

describe('getContext (cached, best-effort)', () => {
  function stubEspn(summary) {
    return { calls: 0, async getMatchSummary() { this.calls += 1; return summary; } };
  }

  test('fetches the summary once and reuses it for later pollers', async () => {
    const espn = stubEspn(BASKETBALL_SUMMARY);
    const g = game();

    const first = await liveContext.getContext({ espn, game: g, now: 1000 });
    expect(first.key_events.length).toBeGreaterThan(0);
    expect(espn.calls).toBe(1);

    const second = await liveContext.getContext({ espn, game: g, now: 1500 });
    expect(espn.calls).toBe(1); // served from the in-process cache
    expect(second.available).toBe(true);
  });

  test('re-reads the summary once the short TTL has passed', async () => {
    const espn = stubEspn(BASKETBALL_SUMMARY);
    const g = game();

    await liveContext.getContext({ espn, game: g, now: 1000 });
    await liveContext.getContext({ espn, game: g, now: 1000 + CONFIG.liveApi.contextTtlMs + 1 });
    expect(espn.calls).toBe(2);
  });

  test('a hand-typed game never triggers a read and returns pre-game only', async () => {
    const espn = stubEspn(BASKETBALL_SUMMARY);
    const ctx = await liveContext.getContext({ espn, game: game({ manual: true }), now: 1000 });
    expect(espn.calls).toBe(0);
    expect(ctx.summary_available).toBe(false);
    expect(ctx.pregame.venue).toBe('Crypto.com Arena');
  });

  test('never throws when the provider read fails', async () => {
    const espn = { async getMatchSummary() { throw new Error('upstream down'); } };
    const ctx = await liveContext.getContext({ espn, game: game(), now: 1000 });
    expect(ctx.summary_available).toBe(false);
    expect(ctx.key_events).toEqual([]);
    expect(ctx.pregame.venue).toBe('Crypto.com Arena');
  });

  test('without a provider it still returns the pre-game context', async () => {
    const ctx = await liveContext.getContext({ espn: null, game: game(), now: 1000 });
    expect(ctx.summary_available).toBe(false);
    expect(ctx.pregame).not.toBeNull();
  });
});
