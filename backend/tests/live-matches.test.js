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
