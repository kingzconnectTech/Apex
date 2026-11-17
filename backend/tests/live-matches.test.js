/**
 * Live matches — external score-site feed (FlashScore / LiveScore).
 *
 * Two surfaces are covered and nothing here reaches a provider:
 *   1. the pure parsers / normalisers in services/live/matchFeed.js — the code
 *      that turns each site's own document into the one match contract;
 *   2. the HTTP contract of GET /api/live/matches and POST /api/live/validate-link,
 *      with the feed stubbed so the request never leaves the process.
 *
 * The behaviour that must never regress:
 *   - a match is listed ONLY when its source says it is in play (`Epr === 1`
 *     for LiveScore, `AB === '2'` for FlashScore) — never inferred from a
 *     start time;
 *   - the same game on both sites collapses to ONE row whose `links` carry both;
 *   - a user link is accepted only when it is http/https, and an unknown host is
 *     still openable but never presented as a known site.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');

const CONFIG = require('../services/live/config');
const matchFeed = require('../services/live/matchFeed');
const { createLiveRouter } = require('../routes/live');

/* --------------------------------------------------------------- fixtures */

/** A LiveScore day document: one live, one finished, one not-started event. */
function livescoreDoc() {
  return {
    Stages: [
      {
        CompN: 'Premier League',
        CompD: 'England',
        Ccd: 'eng.1',
        Scd: 'group-stage',
        CompUrlName: 'england/premier-league',
        Events: [
          {
            Eid: '12345', Epr: 1, Eps: '2H', Esd: '20261117153000',
            Tr1: '2', Tr2: '1',
            T1: [{ Nm: 'Arsenal' }], T2: [{ Nm: 'Chelsea' }],
          },
          {
            Eid: '999', Epr: 2, Eps: 'FT', Esd: '20261117120000',
            Tr1: '3', Tr2: '3',
            T1: [{ Nm: 'Everton' }], T2: [{ Nm: 'Fulham' }],
          },
          {
            Eid: '888', Epr: 0, Eps: 'NS', Esd: '20261117200000',
            Tr1: '0', Tr2: '0',
            T1: [{ Nm: 'Brentford' }], T2: [{ Nm: 'Wolves' }],
          },
        ],
      },
    ],
  };
}

/** The FlashScore ninja feed: one live block, one finished block. */
const FLASHSCORE_TEXT = [
  'ZA÷England: Premier League¬ZEE÷england',
  'AA÷abc123¬AD÷1763300000¬AE÷Liverpool¬AF÷Manchester City¬AG÷1¬AH÷2¬AB÷2',
  'AA÷zzz999¬AD÷1763303600¬AE÷TeamX¬AF÷TeamY¬AG÷0¬AH÷0¬AB÷3',
].join('~');

/* ----------------------------------------------------------- route harness */

const COMMITTED_FORWARD_FILE = CONFIG.live.forwardTest.file;
const COMMITTED_HEALTH_FILE = CONFIG.live.health.file;
const COMMITTED_LEDGER_FILE = CONFIG.live.store.ledger.file;
const stamp = `${process.pid}-${Math.random().toString(16).slice(2)}`;
const TMP_FORWARD_FILE = path.join(os.tmpdir(), `live-matches-forward-${stamp}.json`);
const TMP_HEALTH_FILE = path.join(os.tmpdir(), `live-matches-health-${stamp}.json`);
const TMP_LEDGER_FILE = path.join(os.tmpdir(), `live-matches-ledger-${stamp}.json`);

function rm(file) { try { fs.unlinkSync(file); } catch (err) { /* absent is fine */ } }

/** The router with the real rate limiter replaced by a pass-through. */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createLiveRouter({
    matcher: null,
    rateLimitMiddleware: (req, res, next) => next(),
    logger: null,
  }));
  return app;
}

beforeEach(() => {
  rm(TMP_FORWARD_FILE); rm(TMP_HEALTH_FILE); rm(TMP_LEDGER_FILE);
  CONFIG.live.forwardTest.file = TMP_FORWARD_FILE;
  CONFIG.live.health.file = TMP_HEALTH_FILE;
  CONFIG.live.store.ledger.file = TMP_LEDGER_FILE;
  matchFeed.resetCache();
});

afterEach(() => {
  jest.restoreAllMocks();
  matchFeed.resetCache();
});

afterAll(() => {
  rm(TMP_FORWARD_FILE); rm(TMP_HEALTH_FILE); rm(TMP_LEDGER_FILE);
  CONFIG.live.forwardTest.file = COMMITTED_FORWARD_FILE;
  CONFIG.live.health.file = COMMITTED_HEALTH_FILE;
  CONFIG.live.store.ledger.file = COMMITTED_LEDGER_FILE;
});

/* ============================ LiveScore parser ============================ */

describe('parseLiveScoreDate', () => {
  test('keeps only in-play events and normalises the contract', () => {
    const matches = matchFeed.parseLiveScoreDate(livescoreDoc(), { sport: 'soccer' });
    expect(matches).toHaveLength(1);

    const m = matches[0];
    expect(m.id).toBe('livescore:12345');
    expect(m.source).toBe('livescore');
    expect(m.source_name).toBe('LiveScore');
    expect(m.sport).toBe('soccer');
    expect(m.sport_label).toBe('Football');
    expect(m.league).toBe('Premier League');
    expect(m.country).toBe('England');
    expect(m.home).toEqual({ name: 'Arsenal', score: 2 });
    expect(m.away).toEqual({ name: 'Chelsea', score: 1 });
    expect(m.status).toEqual({ code: '2H', label: '2nd half', live: true });
    expect(m.start_time).toBe('2026-11-17T15:30:00.000Z');
    expect(m.url).toBe(
      'https://www.livescore.com/en/football/england/premier-league/group-stage/arsenal-chelsea/12345/',
    );
    expect(m.links).toHaveLength(1);
  });

  test('an `Epr:1` event is live even when `Eps` is not the literal LIVE', () => {
    const doc = livescoreDoc();
    doc.Stages[0].Events = [{
      Eid: '500', Epr: 1, Eps: 'HT', Tr1: '1', Tr2: '1',
      T1: [{ Nm: 'A' }], T2: [{ Nm: 'B' }],
    }];
    const matches = matchFeed.parseLiveScoreDate(doc, { sport: 'soccer' });
    expect(matches).toHaveLength(1);
    expect(matches[0].status.label).toBe('Half time');
  });

  test('an empty / malformed document yields no matches, never throws', () => {
    expect(matchFeed.parseLiveScoreDate(null)).toEqual([]);
    expect(matchFeed.parseLiveScoreDate({})).toEqual([]);
    expect(matchFeed.parseLiveScoreDate({ Stages: [{ Events: [] }] })).toEqual([]);
  });

  test('falls back to the site home when the stage lacks the slugs for a deep link', () => {
    const doc = livescoreDoc();
    delete doc.Stages[0].CompUrlName;
    delete doc.Stages[0].Scd;
    const matches = matchFeed.parseLiveScoreDate(doc, { sport: 'soccer' });
    expect(matches[0].url).toBe('https://www.livescore.com/en/');
  });
});

/* ========================== FlashScore parser ============================ */

describe('parseFlashScoreFeed', () => {
  test('keeps only `AB === 2` blocks and carries the league header down', () => {
    const matches = matchFeed.parseFlashScoreFeed(FLASHSCORE_TEXT, { sport: 'soccer' });
    expect(matches).toHaveLength(1);

    const m = matches[0];
    expect(m.id).toBe('flashscore:abc123');
    expect(m.source).toBe('flashscore');
    expect(m.source_name).toBe('FlashScore');
    expect(m.league).toBe('Premier League');
    expect(m.country).toBe('England');
    expect(m.home).toEqual({ name: 'Liverpool', score: 1 });
    expect(m.away).toEqual({ name: 'Manchester City', score: 2 });
    expect(m.status.live).toBe(true);
    expect(m.start_time).toBe(new Date(1763300000 * 1000).toISOString());
    expect(m.url).toBe('https://www.flashscore.com/match/abc123/');
  });

  test('a block without a league header still parses (league null)', () => {
    const text = 'AA÷one1¬AD÷1763300000¬AE÷Home¬AF÷Away¬AG÷0¬AH÷0¬AB÷2';
    const matches = matchFeed.parseFlashScoreFeed(text, { sport: 'soccer' });
    expect(matches).toHaveLength(1);
    expect(matches[0].league).toBeNull();
  });

  test('an empty feed yields no matches, never throws', () => {
    expect(matchFeed.parseFlashScoreFeed('')).toEqual([]);
    expect(matchFeed.parseFlashScoreFeed(null)).toEqual([]);
  });
});

/* ============================== helpers ================================= */

describe('matchFeed helpers', () => {
  test('fieldMap keeps the first value for a repeated key', () => {
    expect(matchFeed.fieldMap('AA÷1¬BB÷2¬AA÷3')).toEqual({ AA: '1', BB: '2' });
  });

  test('splitLeagueHeader separates COUNTRY: Competition', () => {
    expect(matchFeed.splitLeagueHeader('England: Premier League'))
      .toEqual({ league: 'Premier League', country: 'England' });
    expect(matchFeed.splitLeagueHeader('Premier League'))
      .toEqual({ league: 'Premier League', country: null });
    expect(matchFeed.splitLeagueHeader('')).toEqual({ league: null, country: null });
  });

  test('isoFromBasicStamp parses a YYYYMMDDHHmmss UTC stamp and rejects junk', () => {
    expect(matchFeed.isoFromBasicStamp('20261117153000')).toBe('2026-11-17T15:30:00.000Z');
    expect(matchFeed.isoFromBasicStamp('nope')).toBeNull();
    expect(matchFeed.isoFromBasicStamp(null)).toBeNull();
  });

  test('isoFromUnixSeconds converts seconds and rejects non-positive', () => {
    expect(matchFeed.isoFromUnixSeconds(1763300000)).toBe(new Date(1763300000 * 1000).toISOString());
    expect(matchFeed.isoFromUnixSeconds(0)).toBeNull();
    expect(matchFeed.isoFromUnixSeconds('x')).toBeNull();
  });

  test('slugify lowercases and collapses punctuation to hyphens', () => {
    expect(matchFeed.slugify('Manchester United')).toBe('manchester-united');
    expect(matchFeed.slugify("Paris Saint-Germain")).toBe('paris-saint-germain');
  });

  test('the two source URLs carry the expected sport segments', () => {
    const day = Date.UTC(2026, 10, 17);
    expect(matchFeed.livescoreUrl('soccer', day))
      .toBe('https://prod-cdn-public-api.livescore.com/v1/api/app/date/soccer/20261117/-3?MD=1');
    expect(matchFeed.flashscoreUrl('soccer')).toContain('f_1_0_3_en_1');
    expect(matchFeed.flashscoreUrl('basketball')).toContain('f_3_0_3_en_1');
  });
});

/* ============================= de-duplication =========================== */

describe('dedupeMatches', () => {
  function flash(id, home, away, url) {
    return {
      id: `flashscore:${id}`, source: 'flashscore', source_name: 'FlashScore',
      sport: 'soccer', league: null, country: null,
      home: { name: home, score: 1 }, away: { name: away, score: 0 },
      status: { code: 'live', label: 'Live', live: true }, start_time: null,
      url, links: [{ source: 'flashscore', source_name: 'FlashScore', url }],
    };
  }
  function live(id, home, away, url) {
    return {
      id: `livescore:${id}`, source: 'livescore', source_name: 'LiveScore',
      sport: 'soccer', league: 'Premier League', country: 'England',
      home: { name: home, score: 1 }, away: { name: away, score: 0 },
      status: { code: '2H', label: '2nd half', live: true },
      start_time: '2026-11-17T15:30:00.000Z',
      url, links: [{ source: 'livescore', source_name: 'LiveScore', url }],
    };
  }

  test('the same game on both sites collapses to one row with both links', () => {
    const merged = matchFeed.dedupeMatches([
      flash('a', 'Arsenal', 'Chelsea', 'https://www.flashscore.com/match/a/'),
      live('9', 'Arsenal', 'Chelsea', 'https://www.livescore.com/en/.../9/'),
    ]);
    expect(merged).toHaveLength(1);
    // LiveScore has primacy, so its row wins the score/status.
    expect(merged[0].source).toBe('livescore');
    expect(merged[0].links).toHaveLength(2);
    expect(merged[0].links.map(l => l.source).sort()).toEqual(['flashscore', 'livescore']);
  });

  test('home/away order does not matter when pairing', () => {
    const merged = matchFeed.dedupeMatches([
      live('9', 'Arsenal', 'Chelsea', 'https://www.livescore.com/en/9/'),
      flash('a', 'Chelsea', 'Arsenal', 'https://www.flashscore.com/match/a/'),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].links).toHaveLength(2);
  });

  test('different games are never merged', () => {
    const merged = matchFeed.dedupeMatches([
      live('9', 'Arsenal', 'Chelsea', 'u1'),
      live('10', 'Everton', 'Fulham', 'u2'),
    ]);
    expect(merged).toHaveLength(2);
  });
});

/* ========================== link validation ============================== */

describe('validateSiteLink', () => {
  test('accepts a known host and reports it recognised', () => {
    const v = matchFeed.validateSiteLink(
      'https://www.livescore.com/en/football/england/premier-league/x-y/123/',
    );
    expect(v.valid).toBe(true);
    expect(v.recognised).toBe(true);
    expect(v.site_id).toBe('livescore');
    expect(v.site_name).toBe('LiveScore');
    expect(v.note).toBeNull();
  });

  test('a bare sub-domain host is completed to https and still recognised', () => {
    const v = matchFeed.validateSiteLink('m.flashscore.com/match/abc/');
    expect(v.valid).toBe(true);
    expect(v.recognised).toBe(true);
    expect(v.site_id).toBe('flashscore');
    expect(v.url.startsWith('https://')).toBe(true);
  });

  test('an unknown but well-formed http(s) host is openable but NOT recognised', () => {
    const v = matchFeed.validateSiteLink('https://example.com/live/match');
    expect(v.valid).toBe(true);
    expect(v.recognised).toBe(false);
    expect(v.site_id).toBeNull();
    expect(typeof v.note).toBe('string');
  });

  test.each([
    ['javascript:alert(1)'],
    ['file:///etc/passwd'],
    ['data:text/html,<script>alert(1)</script>'],
  ])('rejects the non-http(s) scheme %s', (raw) => {
    const v = matchFeed.validateSiteLink(raw);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/http/i);
  });

  test('refuses empty input and an over-long link', () => {
    expect(matchFeed.validateSiteLink('').valid).toBe(false);
    expect(matchFeed.validateSiteLink('   ').valid).toBe(false);
    const long = 'https://example.com/' + 'a'.repeat(matchFeed.MAX_LINK_LENGTH);
    const v = matchFeed.validateSiteLink(long);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(String(matchFeed.MAX_LINK_LENGTH));
  });

  test('a host with no dot is refused', () => {
    const v = matchFeed.validateSiteLink('https://example');
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/web address/i);
  });
});

/* ================================ routes ================================ */

describe('GET /api/live/matches', () => {
  function payload(over = {}) {
    return {
      enabled: true,
      count: 1,
      fetched_at: '2026-11-17T15:30:00.000Z',
      degraded: false,
      refresh: { suggested_seconds: 30, min_seconds: 15 },
      sources: [{ id: 'livescore', name: 'LiveScore', ok: true, count: 1, error: null, duration_ms: 5 }],
      sites: matchFeed.sites(),
      matches: [{
        id: 'livescore:9', source: 'livescore', source_name: 'LiveScore',
        sport: 'soccer', sport_label: 'Football', league: 'Premier League', country: 'England',
        home: { name: 'Arsenal', score: 2 }, away: { name: 'Chelsea', score: 1 },
        status: { code: '2H', label: '2nd half', live: true },
        start_time: '2026-11-17T15:30:00.000Z', url: 'https://www.livescore.com/en/9/',
        links: [{ source: 'livescore', source_name: 'LiveScore', url: 'https://www.livescore.com/en/9/' }],
      }],
      ...over,
    };
  }

  test('serves the feed payload and adds a traceId', async () => {
    jest.spyOn(matchFeed, 'fetchLiveMatches').mockResolvedValue(payload());
    const res = await request(buildApp()).get('/api/live/matches').expect(200);
    expect(res.body.count).toBe(1);
    expect(res.body.matches[0].home.name).toBe('Arsenal');
    expect(res.body).toHaveProperty('traceId');
  });

  test('parses ?sources= and ?force= into the feed call', async () => {
    const spy = jest.spyOn(matchFeed, 'fetchLiveMatches').mockResolvedValue(payload());
    await request(buildApp()).get('/api/live/matches?sources=flashscore,livescore&force=true').expect(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0][0];
    expect(arg.sources).toEqual(['flashscore', 'livescore']);
    expect(arg.force).toBe(true);
  });

  test('503 MATCHES_DISABLED when the feed is switched off', async () => {
    jest.spyOn(matchFeed, 'isEnabled').mockReturnValue(false);
    const res = await request(buildApp()).get('/api/live/matches').expect(503);
    expect(res.body.code).toBe('MATCHES_DISABLED');
  });

  test('503 MATCHES_UNAVAILABLE when the feed throws', async () => {
    jest.spyOn(matchFeed, 'fetchLiveMatches').mockRejectedValue(new Error('boom'));
    const res = await request(buildApp()).get('/api/live/matches').expect(503);
    expect(res.body.code).toBe('MATCHES_UNAVAILABLE');
  });
});

describe('POST /api/live/validate-link', () => {
  test('a known link answers 200 with valid:true and code:null', async () => {
    const res = await request(buildApp())
      .post('/api/live/validate-link')
      .send({ link: 'https://www.flashscore.com/match/abc/' })
      .expect(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.code).toBeNull();
    expect(res.body.site_id).toBe('flashscore');
    expect(Array.isArray(res.body.sites)).toBe(true);
    expect(res.body.max_link_length).toBe(matchFeed.MAX_LINK_LENGTH);
  });

  test('a bad scheme answers 200 (not an error) with valid:false and INVALID_LINK', async () => {
    const res = await request(buildApp())
      .post('/api/live/validate-link')
      .send({ link: 'javascript:alert(1)' })
      .expect(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.code).toBe('INVALID_LINK');
    expect(typeof res.body.reason).toBe('string');
  });

  test('accepts the `url` field as an alias for `link`', async () => {
    const res = await request(buildApp())
      .post('/api/live/validate-link')
      .send({ url: 'https://www.livescore.com/en/' })
      .expect(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.site_id).toBe('livescore');
  });
});

describe('GET /api/live/capabilities', () => {
  test('exposes the matches block (enabled, refresh hint, sites)', async () => {
    const res = await request(buildApp()).get('/api/live/capabilities').expect(200);
    expect(res.body.matches).toBeDefined();
    expect(res.body.matches.enabled).toBe(true);
    expect(res.body.matches.refresh.suggested_seconds).toBe(CONFIG.live.matchFeed.refresh.suggestedSeconds);
    expect(res.body.matches.max_link_length).toBe(matchFeed.MAX_LINK_LENGTH);
    expect(res.body.matches.sites.map(s => s.id)).toEqual(['flashscore', 'livescore']);
  });
});

/* ===================== in-play clock / period ====================== */

describe('in-play clock and period', () => {
  test('liveClock accepts a real clock form and rejects a phase code', () => {
    expect(matchFeed.liveClock("67'")).toBe("67'");
    expect(matchFeed.liveClock("90+1'")).toBe("90+1'");
    expect(matchFeed.liveClock('7:24')).toBe('7:24');
    expect(matchFeed.liveClock('HT')).toBeNull();
    expect(matchFeed.liveClock('FT')).toBeNull();
    expect(matchFeed.liveClock('')).toBeNull();
    expect(matchFeed.liveClock(null)).toBeNull();
  });

  test('a LiveScore in-play event carries Eps as the clock and Esid as the period', () => {
    const doc = {
      Stages: [{
        CompN: 'Serie A', CompD: 'Italy',
        Events: [{
          Eid: '7', Epr: 1, Eps: "67'", Esid: 3, Tr1: '1', Tr2: '0',
          T1: [{ Nm: 'Inter' }], T2: [{ Nm: 'Milan' }],
        }],
      }],
    };
    const [m] = matchFeed.parseLiveScoreDate(doc, { sport: 'soccer' });
    expect(m.clock).toBe("67'");
    expect(m.period).toBe(2);
  });

  test('a phase code is not passed off as a clock', () => {
    const doc = {
      Stages: [{
        CompN: 'Serie A',
        Events: [{
          Eid: '7', Epr: 1, Eps: 'HT', Esid: 10, Tr1: '1', Tr2: '0',
          T1: [{ Nm: 'Inter' }], T2: [{ Nm: 'Milan' }],
        }],
      }],
    };
    const [m] = matchFeed.parseLiveScoreDate(doc, { sport: 'soccer' });
    expect(m.clock).toBeNull();
    expect(m.period).toBe(0);
  });

  test('a FlashScore block carries no clock and no period', () => {
    const [m] = matchFeed.parseFlashScoreFeed(FLASHSCORE_TEXT, { sport: 'soccer' });
    expect(m.clock).toBeNull();
    expect(m.period).toBe(0);
  });
});

/* ============================ predictions ========================== */

describe('toLiveGame', () => {
  test('rebuilds the shared LiveGame shape and re-attaches the provider id', () => {
    const game = matchFeed.toLiveGame({
      id: 'livescore:12345', source: 'livescore', sport: 'soccer', league: 'Premier League',
      home: { name: 'Arsenal', score: 2 }, away: { name: 'Chelsea', score: 1 },
      status: { code: '2H', label: '2nd half', live: true },
      clock: "67'", period: 2, start_time: '2026-11-17T15:30:00.000Z',
    });
    expect(game.game_id).toBe('livescore:12345');
    expect(game.sport).toBe('soccer');
    expect(game.source).toBe('livescore');
    expect(game.league).toEqual({ id: null, name: 'Premier League' });
    expect(game.live.status).toBe('live');
    expect(game.live.is_live).toBe(true);
    expect(game.live.clock).toBe("67'");
    expect(game.live.period).toBe(2);
    expect(game.data_tier).toBe('full_live');
    expect(game.manual).toBe(false);
  });

  test('a clock-less row is score_time_only — never dressed up as full live', () => {
    const game = matchFeed.toLiveGame({
      id: 'flashscore:abc', source: 'flashscore', sport: 'soccer', league: null,
      home: { name: 'A', score: 0 }, away: { name: 'B', score: 0 },
      status: { code: 'live', label: 'Live', live: true }, clock: null, period: 0,
    });
    expect(game.data_tier).toBe('score_time_only');
  });
});

describe('predictForMatch', () => {
  function soccerMatch(over = {}) {
    return {
      id: 'livescore:7', source: 'livescore', source_name: 'LiveScore',
      sport: 'soccer', sport_label: 'Football', league: 'Serie A', country: 'Italy',
      home: { name: 'Inter', score: 1 }, away: { name: 'Milan', score: 0 },
      status: { code: '2H', label: '2nd half', live: true },
      clock: "67'", period: 2, start_time: '2026-11-17T15:30:00.000Z',
      url: 'https://www.livescore.com/en/7/',
      links: [{ source: 'livescore', source_name: 'LiveScore', url: 'https://www.livescore.com/en/7/' }],
      ...over,
    };
  }

  test('a game with a real clock is modelled live, but the ship gate withholds the figure', () => {
    const p = matchFeed.predictForMatch(soccerMatch());
    expect(p.available).toBe(true);
    // The model DID analyse the live state ...
    expect(p.model.status).toBe('live');
    // ... but the gate refuses to show it, with its own reason.
    expect(p.ship_gate.decision).toBe('withheld');
    expect(p.ship_gate.reason).toMatch(/validat/i);
    expect(p.probabilities).toBeNull();
    expect(p.projection).toBeNull();
    expect(p.display.mode).toBe('context_only');
    expect(p.display.shows_probabilities).toBe(false);
  });

  test('a clock-less game degrades to the pre-game projection (still withheld)', () => {
    const p = matchFeed.predictForMatch(soccerMatch({ clock: null, period: 0 }));
    expect(p.available).toBe(true);
    expect(p.model.status).toBe('prior_only');
    expect(p.probabilities).toBeNull();
    expect(p.ship_gate.decision).toBe('withheld');
  });

  test('an unsupported sport is reported, never guessed', () => {
    const p = matchFeed.predictForMatch(soccerMatch({ sport: 'tennis' }));
    expect(p.available).toBe(true);
    expect(p.model.status).toBe('unsupported');
    expect(p.probabilities).toBeNull();
  });

  test('when predictions are switched off the block says so and computes nothing', () => {
    const prev = CONFIG.live.matchFeed.predictions.enabled;
    CONFIG.live.matchFeed.predictions.enabled = false;
    try {
      const p = matchFeed.predictForMatch(soccerMatch());
      expect(p.available).toBe(false);
      expect(p.reason).toMatch(/switched off/i);
    } finally {
      CONFIG.live.matchFeed.predictions.enabled = prev;
    }
  });

  test('a match that cannot be adapted degrades to available:false, never throws', () => {
    const p = matchFeed.predictForMatch(null);
    expect(p.available).toBe(false);
    expect(typeof p.error).toBe('string');
  });
});

/* ========================= fetch + retry =========================== */

describe('fetchLiveMatches with predictions + retry', () => {
  const liveDoc = () => ({
    Stages: [{
      CompN: 'Serie A', CompD: 'Italy',
      Events: [{
        Eid: '7', Epr: 1, Eps: "67'", Esid: 3, Tr1: '1', Tr2: '0',
        T1: [{ Nm: 'Inter' }], T2: [{ Nm: 'Milan' }],
      }],
    }],
  });

  /** A fetch stub that answers by URL and can fail the first `failures` calls. */
  function stubFetch({ failures = 0 } = {}) {
    let calls = 0;
    const impl = async (url) => {
      calls += 1;
      if (calls <= failures) throw new Error('network down');
      const body = url.includes('flashscore') ? FLASHSCORE_TEXT : JSON.stringify(liveDoc());
      return { ok: true, status: 200, text: async () => body };
    };
    impl.calls = () => calls;
    return impl;
  }

  function withSoccerOnly(fn) {
    const key = 'livescore';
    const prev = CONFIG.live.matchFeed.sources[key].sports;
    CONFIG.live.matchFeed.sources[key].sports = ['soccer'];
    return Promise.resolve().then(fn).finally(() => {
      CONFIG.live.matchFeed.sources[key].sports = prev;
    });
  }

  test('each listed match carries sources_seen and a gated prediction', async () => {
    await withSoccerOnly(async () => {
      const payload = await matchFeed.fetchLiveMatches({
        sources: ['livescore'], fetchImpl: stubFetch(), force: true,
      });
      expect(payload.count).toBe(1);
      const m = payload.matches[0];
      expect(m.sources_seen).toEqual(['livescore']);
      expect(m.prediction).toBeDefined();
      expect(m.prediction.probabilities).toBeNull();
      expect(m.prediction.ship_gate.decision).toBe('withheld');
    });
  });

  test('a transient failure is retried and the read still succeeds', async () => {
    const prevRetry = { ...CONFIG.live.matchFeed.retry };
    CONFIG.live.matchFeed.retry = { attempts: 3, baseDelayMs: 0, maxDelayMs: 0 };
    try {
      await withSoccerOnly(async () => {
        const impl = stubFetch({ failures: 1 });
        const payload = await matchFeed.fetchLiveMatches({
          sources: ['livescore'], fetchImpl: impl, sleepImpl: async () => {}, force: true,
        });
        const src = payload.sources.find(s => s.id === 'livescore');
        expect(src.ok).toBe(true);
        expect(src.count).toBeGreaterThanOrEqual(1);
        expect(impl.calls()).toBeGreaterThanOrEqual(2);
      });
    } finally {
      CONFIG.live.matchFeed.retry = prevRetry;
    }
  });

  test('a source that keeps failing is reported, not thrown', async () => {
    const prevRetry = { ...CONFIG.live.matchFeed.retry };
    CONFIG.live.matchFeed.retry = { attempts: 2, baseDelayMs: 0, maxDelayMs: 0 };
    try {
      const impl = async () => { throw new Error('network down'); };
      const payload = await matchFeed.fetchLiveMatches({
        sources: ['livescore'], fetchImpl: impl, sleepImpl: async () => {}, force: true,
      });
      expect(payload.degraded).toBe(true);
      expect(payload.matches).toHaveLength(0);
      const src = payload.sources.find(s => s.id === 'livescore');
      expect(src.ok).toBe(false);
      expect(src.error).toBeTruthy();
    } finally {
      CONFIG.live.matchFeed.retry = prevRetry;
    }
  });
});

describe('withRetry', () => {
  test('retries a retryable error then succeeds', async () => {
    let n = 0;
    const out = await matchFeed.withRetry(() => {
      n += 1;
      if (n < 3) throw new Error('HTTP 503');
      return 'ok';
    }, { attempts: 5, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} });
    expect(out).toBe('ok');
    expect(n).toBe(3);
  });

  test('does not retry a 4xx (a request problem will not fix itself)', async () => {
    let n = 0;
    await expect(matchFeed.withRetry(() => {
      n += 1;
      throw new Error('HTTP 404');
    }, { attempts: 5, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} })).rejects.toThrow('404');
    expect(n).toBe(1);
  });

  test('gives up after `attempts` tries and rethrows the last error', async () => {
    let n = 0;
    await expect(matchFeed.withRetry(() => {
      n += 1;
      throw new Error('HTTP 500');
    }, { attempts: 3, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} })).rejects.toThrow('500');
    expect(n).toBe(3);
  });
});

/* =============== pasted score-site links (identify + resolve) ============= */

describe('buildMatch links', () => {
  test('each link carries the provider id read from the row id', () => {
    const [m] = matchFeed.parseLiveScoreDate(livescoreDoc(), { sport: 'soccer' });
    expect(m.links).toHaveLength(1);
    expect(m.links[0].source).toBe('livescore');
    expect(m.links[0].source_id).toBe('12345');
  });

  test('a FlashScore link carries its alphanumeric match id', () => {
    const [m] = matchFeed.parseFlashScoreFeed(FLASHSCORE_TEXT, { sport: 'soccer' });
    expect(m.links[0].source).toBe('flashscore');
    expect(m.links[0].source_id).toBe('abc123');
  });
});

describe('matchHasProviderId', () => {
  test('matches the row id, or any carried link, for the right source only', () => {
    const m = {
      id: 'livescore:7',
      links: [
        { source: 'livescore', source_id: '7', url: 'https://www.livescore.com/en/7/' },
        { source: 'flashscore', source_id: 'abc123', url: 'https://www.flashscore.com/match/abc123/' },
      ],
    };
    expect(matchFeed.matchHasProviderId(m, 'livescore', '7')).toBe(true);
    // A FlashScore link still finds a row LiveScore won during de-duplication.
    expect(matchFeed.matchHasProviderId(m, 'flashscore', 'abc123')).toBe(true);
    expect(matchFeed.matchHasProviderId(m, 'livescore', '8')).toBe(false);
    expect(matchFeed.matchHasProviderId(m, 'flashscore', '7')).toBe(false);
    expect(matchFeed.matchHasProviderId(null, 'livescore', '7')).toBe(false);
  });

  test('falls back to the URL text for a link built before source_id existed', () => {
    const m = {
      id: 'x',
      links: [{ source: 'flashscore', url: 'https://www.flashscore.com/match/abc123/' }],
    };
    expect(matchFeed.matchHasProviderId(m, 'flashscore', 'abc123')).toBe(true);
    expect(matchFeed.matchHasProviderId(m, 'flashscore', 'nope')).toBe(false);
  });
});

describe('resolveFeedMatch', () => {
  const liveDoc = (id = '7') => ({
    Stages: [{
      CompN: 'Serie A', CompD: 'Italy',
      Events: [{
        Eid: id, Epr: 1, Eps: "67'", Esid: 3, Tr1: '1', Tr2: '0',
        T1: [{ Nm: 'Inter' }], T2: [{ Nm: 'Milan' }],
      }],
    }],
  });

  /** A fetch stub answering by URL; can fail the first `failures` calls. */
  function stubFetch({ failures = 0, id = '7' } = {}) {
    let calls = 0;
    const impl = async (url) => {
      calls += 1;
      if (calls <= failures) throw new Error('network down');
      const body = url.includes('flashscore') ? '' : JSON.stringify(liveDoc(id));
      return { ok: true, status: 200, text: async () => body };
    };
    impl.calls = () => calls;
    return impl;
  }

  /** Pin both sources to soccer for the duration of `fn`. */
  function soccerOnly(fn) {
    const prevLs = CONFIG.live.matchFeed.sources.livescore.sports;
    const prevFs = CONFIG.live.matchFeed.sources.flashscore.sports;
    CONFIG.live.matchFeed.sources.livescore.sports = ['soccer'];
    CONFIG.live.matchFeed.sources.flashscore.sports = ['soccer'];
    return Promise.resolve().then(fn).finally(() => {
      CONFIG.live.matchFeed.sources.livescore.sports = prevLs;
      CONFIG.live.matchFeed.sources.flashscore.sports = prevFs;
    });
  }

  test('a pasted id resolves against the same feed the list is built from', async () => {
    await soccerOnly(async () => {
      const r = await matchFeed.resolveFeedMatch({
        source: 'livescore', providerId: '7', fetchImpl: stubFetch(), force: true,
      });
      expect(r.match).not.toBeNull();
      expect(r.match.id).toBe('livescore:7');
      expect(r.source_ok).toBe(true);
      expect(r.reason).toBeNull();
    });
  });

  test('an id that is not in play is a miss, with the source still healthy', async () => {
    await soccerOnly(async () => {
      const r = await matchFeed.resolveFeedMatch({
        source: 'livescore', providerId: '999', fetchImpl: stubFetch(), force: true,
      });
      expect(r.match).toBeNull();
      expect(r.source_ok).toBe(true);
    });
  });

  test('an unknown source is reported, never thrown', async () => {
    const r = await matchFeed.resolveFeedMatch({ source: 'foo', providerId: '1' });
    expect(r.match).toBeNull();
    expect(r.source_ok).toBe(false);
    expect(r.reason).toBe('unknown_source');
  });

  test('a missing id is reported as unknown_source', async () => {
    const r = await matchFeed.resolveFeedMatch({ source: 'livescore', providerId: '' });
    expect(r.reason).toBe('unknown_source');
  });

  test('an unreachable feed is reported as source not ok, and never throws', async () => {
    const prevRetry = { ...CONFIG.live.matchFeed.retry };
    CONFIG.live.matchFeed.retry = { attempts: 2, baseDelayMs: 0, maxDelayMs: 0 };
    try {
      await soccerOnly(async () => {
        const r = await matchFeed.resolveFeedMatch({
          source: 'livescore', providerId: '7',
          fetchImpl: async () => { throw new Error('network down'); },
          sleepImpl: async () => {}, force: true,
        });
        expect(r.match).toBeNull();
        expect(r.source_ok).toBe(false);
        expect(r.source_error).toBeTruthy();
      });
    } finally {
      CONFIG.live.matchFeed.retry = prevRetry;
    }
  });
});
