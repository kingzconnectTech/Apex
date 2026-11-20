/**
 * live/liveContext.js
 *
 * Phase 9 — the context-only experience.
 *
 * While a sport is held in shadow (and for every sport before its gate passes,
 * and for hand-typed games) no probability may be shown. What is left is
 * CONTEXT: the live score and clock, the events that moved the game, the
 * injuries, and the pre-game setting. None of it feeds a model or a
 * probability — it is the honest fallback, and the whole point of the screen in
 * that state.
 *
 * Two sources, both best-effort and both honest about their age:
 *
 *   1. the LiveGame itself — pre-game context (records, venue, kickoff). The
 *      matcher already fetched it, so it is always available and needs no call;
 *   2. a short-TTL ESPN match-summary read — key events and injuries. It uses a
 *      dedicated (shorter) cache TTL, and a failure or an absent field degrades
 *      to context-only: it never throws and never invents an event.
 *
 * The extraction reads ONLY shapes the replay code already relies on
 * (services/live/replay.js): basketball `summary.plays[]`, soccer
 * `summary.keyEvents[]`, and `summary.injuries[]` via EspnProvider.
 */

const CONFIG = require('./config');
const { staleness } = require('./liveGame');
const { EspnProvider } = require('../providers/EspnProvider');
const { normalizeFixtureESPN } = require('../providers/normalizer');
const { scoreFixture } = require('./teamMatch');

const CFG = CONFIG.liveApi;
const CTX = CFG.context || {};
const BRIDGE = { enabled: true, minScore: 0.6, ambiguityGap: 0.08, ...(CFG.espnBridge || {}) };

function numOrNull(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ pregame */

/**
 * Pre-game setting taken from the LiveGame the matcher already built: the
 * venue, the kickoff time and each side's season record. Returns null when none
 * of it is known (e.g. a hand-typed game), so the caller can drop the block
 * rather than render empty rows.
 */
function pregameContext(game) {
  if (!game) return null;
  const schedule = game.schedule || {};
  const home = game.home || {};
  const away = game.away || {};
  const block = {
    venue: schedule.venue || null,
    kickoff: schedule.kickoff || null,
    home: { name: home.name || null, record: home.record || null },
    away: { name: away.name || null, record: away.record || null },
  };
  const hasAny = block.venue || block.kickoff || block.home.record || block.away.record;
  return hasAny ? block : null;
}

/* --------------------------------------------------------------- key events */

/** Basketball key events: the scoring plays, from ESPN `summary.plays[]`. */
function basketballKeyEvents(summary) {
  const plays = summary && Array.isArray(summary.plays) ? summary.plays : [];
  return plays
    .filter(p => p && p.scoringPlay === true)
    .map(p => ({
      clock: (p.clock && p.clock.displayValue) || null,
      period: numOrNull(p.period && p.period.number),
      team: (p.team && (p.team.displayName || p.team.name)) || null,
      type: (p.type && p.type.text) || 'Score',
      text: p.text || null,
      home_score: numOrNull(p.homeScore),
      away_score: numOrNull(p.awayScore),
      scoring: true,
    }));
}

/** Soccer clock for a key event: ESPN gives seconds plus a display string. */
function soccerClock(ev) {
  const c = ev && ev.clock;
  if (!c) return null;
  if (c.displayValue) return String(c.displayValue);
  const secs = numOrNull(c.value);
  return secs == null ? null : `${Math.floor(secs / 60)}'`;
}

/**
 * Soccer key events from ESPN `summary.keyEvents[]`: goals, cards, penalties and
 * substitutions. A shootout event is dropped (it does not describe in-play
 * state). Anything that is neither a scoring play nor a recognised key type is
 * left out rather than guessed at.
 */
function soccerKeyEvents(summary) {
  const events = summary && Array.isArray(summary.keyEvents) ? summary.keyEvents : [];
  const NOTABLE = /goal|penalt|card|red|yellow|substitut/i;
  return events
    .filter(ev => ev && ev.shootout !== true)
    .filter(ev => {
      const type = (ev.type && (ev.type.text || ev.type.type)) || '';
      return ev.scoringPlay === true || NOTABLE.test(type);
    })
    .map(ev => ({
      clock: soccerClock(ev),
      period: null,
      team: (ev.team && (ev.team.displayName || ev.team.name)) || null,
      type: (ev.type && ev.type.text) || null,
      text: ev.text || null,
      home_score: null,
      away_score: null,
      scoring: ev.scoringPlay === true,
    }));
}

/**
 * The most recent key events for a sport, newest first, capped at
 * `CFG.context.maxKeyEvents`. An unsupported sport yields [].
 */
function extractKeyEvents(summary, { sport, max = CTX.maxKeyEvents } = {}) {
  let list = [];
  if (sport === 'basketball') list = basketballKeyEvents(summary);
  else if (sport === 'soccer') list = soccerKeyEvents(summary);
  if (!list.length) return [];
  const cap = Number.isFinite(max) && max > 0 ? max : list.length;
  return list.slice(-cap).reverse();
}

/**
 * Injuries from ESPN `summary.injuries[]`, capped at `CFG.context.maxInjuries`.
 * Delegates to EspnProvider so there is exactly one injury parser; returns []
 * when the provider has nothing (never a fabricated player).
 */
function extractInjuries(summary, { max = CTX.maxInjuries } = {}) {
  const list = EspnProvider.extractBasketballInjuries(summary);
  if (!list.length) return [];
  const cap = Number.isFinite(max) && max > 0 ? max : list.length;
  return list.slice(0, cap);
}

/* ------------------------------------------------------------ context block */

/**
 * Assemble the `context` block for the analysis payload. Pure: no I/O.
 *
 * @param {Object} args
 * @param {Object} args.game
 * @param {Object|null} [args.summary]   an ESPN summary payload, or null
 * @param {number|null} [args.fetchedAt] epoch ms the summary was read
 * @param {number} [args.now]
 */
function buildContext({ game, summary = null, fetchedAt = null, now = Date.now() } = {}) {
  const pregame = pregameContext(game);
  const keyEvents = game && game.sport ? extractKeyEvents(summary, { sport: game.sport }) : [];
  const injuries = extractInjuries(summary);
  const fresh = fetchedAt != null ? staleness(fetchedAt, now) : null;
  const summaryAvailable = Boolean(summary);
  const hasAny = Boolean(pregame) || keyEvents.length > 0 || injuries.length > 0;

  return {
    available: hasAny,
    // Where the events/injuries came from, or null when there was no read.
    source: summaryAvailable ? (game && game.source) || null : null,
    summary_available: summaryAvailable,
    key_events: keyEvents,
    injuries,
    pregame,
    // Age of the SUMMARY read, so the UI can show "updated Ns ago" for the
    // events/injuries distinctly from the score/clock freshness.
    freshness: fresh,
    updated_label: fresh ? fresh.updated_label : null,
  };
}

/* -------------------------------------------------------- bookmaker line */

/** American/decimal odds from a pickcenter side ({close:{odds}} preferred). */
function americanOdds(side) {
  if (!side) return null;
  const close = side.close && side.close.odds;
  const open = side.open && side.open.odds;
  return numOrNull(close != null ? close : open);
}

/**
 * The REAL bookmaker line+odds for a game, read from an ESPN summary's
 * `pickcenter[0]` (falling back to `odds[0]`). This is the SAME field the
 * replay backtester (services/live/replay.js) and the pre-match basketball
 * engine price against, and it is the only source of a genuine line the live
 * surface has: the score feeds (LiveScore/FlashScore) publish no odds at all.
 *
 * Returns null when the summary carries no priced market, so a game ESPN does
 * not price stays line-less and its grid is withheld rather than priced off a
 * simulated line (see config live.pickMarkets.requireRealLine).
 *
 * @param {Object|null} summary an ESPN match summary payload
 * @returns {Object|null} { provider, overUnder, overOdds, underOdds, spread, moneyline }
 */
function realOddsFromSummary(summary) {
  const pickcenter = (summary && summary.pickcenter) || [];
  const odds = (summary && summary.odds) || [];
  const pc = pickcenter[0] || odds[0];
  if (!pc) return null;
  const ml = pc.moneyline || {};
  const moneyline = {
    home: americanOdds(ml.home) ?? numOrNull(pc.homeTeamOdds && pc.homeTeamOdds.moneyLine),
    away: americanOdds(ml.away) ?? numOrNull(pc.awayTeamOdds && pc.awayTeamOdds.moneyLine),
    draw: americanOdds(ml.draw) ?? numOrNull(pc.drawOdds && pc.drawOdds.moneyLine),
  };
  const overUnder = numOrNull(pc.overUnder);
  const spread = numOrNull(pc.spread);
  const priced = overUnder != null || spread != null
    || moneyline.home != null || moneyline.away != null;
  if (!priced) return null;
  return {
    provider: (pc.provider && pc.provider.name) || null,
    overUnder,
    overOdds: numOrNull(pc.overOdds),
    underOdds: numOrNull(pc.underOdds),
    spread,
    moneyline,
  };
}

/* ------------------------------------------------------------- cached fetch */

/**
 * A tiny in-process cache keyed on game id, so N pollers of one game cost one
 * summary read. The entry stores the read's timestamp, so the "updated Ns ago"
 * label counts up honestly between reads rather than always reading 0s.
 */
const cache = new Map();

function cacheGet(gameId, now) {
  const hit = cache.get(gameId);
  if (!hit) return null;
  if (now - hit.fetched_at > (CFG.contextTtlMs || 0)) {
    cache.delete(gameId);
    return null;
  }
  return hit;
}

function cachePut(gameId, summary, now) {
  cache.set(gameId, { summary, fetched_at: now });
  while (cache.size > (CFG.maxCachedGames || 0)) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** The provider event id behind a `source:id` game id, or null. */
function eventIdOf(gameId) {
  if (gameId == null) return null;
  const str = String(gameId);
  return str.includes(':') ? str.split(':').slice(1).join(':') : str;
}

/**
 * The score-site feeds whose `game_id` is the SITE's own id, not an ESPN event
 * id. For these the ESPN summary read needs a bridge (below); every other
 * source already carries an ESPN event id in its `game_id`.
 */
const FEED_SOURCES = new Set(['livescore', 'flashscore']);

/**
 * `game_id` -> resolved ESPN event id, so N polls of one game cost one
 * scoreboard read. A FOUND id is stable and kept; a NOT-FOUND is retried once
 * the summary TTL lapses (the game may simply not be on the scoreboard yet).
 */
const espnEventCache = new Map();

function espnCacheGet(gameId, now) {
  const hit = espnEventCache.get(gameId);
  if (!hit) return undefined;
  if (hit.espn_event_id == null && now - hit.at > (CFG.contextTtlMs || 0)) {
    espnEventCache.delete(gameId);
    return undefined;
  }
  return hit.espn_event_id;
}

function espnCachePut(gameId, eventId, now) {
  espnEventCache.set(gameId, { espn_event_id: eventId, at: now });
  while (espnEventCache.size > (CFG.maxCachedGames || 0)) {
    const oldest = espnEventCache.keys().next();
    if (oldest.done) break;
    espnEventCache.delete(oldest.value);
  }
}

/**
 * The ESPN event id the summary should be read with, or null.
 *
 * An ESPN-sourced game already carries the event id in its `game_id`, so it is
 * returned as-is. A score-site (LiveScore / FlashScore) game does NOT — ESPN
 * returns a 404 for the site's own id — so the matching ESPN event is looked up
 * by team NAME on the game's own league scoreboard, using the same pure
 * similarity scoring the link matcher uses. A weak or ambiguous lookup is
 * refused (null) rather than guessed: a wrong bridge would attach another
 * game's key events, stats and bookmaker line to this one.
 *
 * Never throws.
 */
async function resolveEspnEventId({ espn = null, game = null, now = Date.now(), traceId = null } = {}) {
  if (!game) return null;
  // An ESPN (or manually typed, or already-bridged) id needs no lookup.
  if (!FEED_SOURCES.has(game.source)) return eventIdOf(game.game_id);
  if (!espn || BRIDGE.enabled === false) return null;

  const league = game.league && game.league.id;
  const home = game.home && game.home.name;
  const away = game.away && game.away.name;
  if (!league || !home || !away || !game.sport) return null;

  const cached = espnCacheGet(game.game_id, now);
  if (cached !== undefined) return cached;

  let resolved = null;
  try {
    const data = await espn._request(`${game.sport}/${league}/scoreboard`, {
      ttl: CFG.contextTtlMs, traceId,
    });
    const parsed = { home_raw: home, away_raw: away, sport: game.sport };
    const scored = [];
    for (const e of (data && data.events) || []) {
      const fx = normalizeFixtureESPN(e, game.sport, league, league);
      if (!fx) continue;
      const s = scoreFixture(parsed, fx, CONFIG.matcher.minSideSimilarity);
      if (s.score > 0) scored.push({ id: String(fx.fixture.id), score: s.score });
    }
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    const runnerUp = scored[1];
    const unambiguous = !runnerUp || (best.score - runnerUp.score) >= BRIDGE.ambiguityGap;
    if (best && best.score >= BRIDGE.minScore && unambiguous) resolved = best.id;
  } catch (err) {
    resolved = null;
  }

  espnCachePut(game.game_id, resolved, now);
  return resolved;
}

/**
 * Best-effort context for one live game: pre-game fields from the game plus a
 * cached ESPN summary read for key events and injuries.
 *
 * Never throws. With no provider, no league id or a manual game it returns the
 * pre-game block alone. A summary read that fails does the same.
 *
 * @param {Object} args
 * @param {Object} [args.espn]  an EspnProvider (or any object with getMatchSummary)
 * @param {Object} args.game
 * @param {number} [args.now]
 * @param {string} [args.traceId]
 */
async function getContext({ espn = null, game = null, now = Date.now(), traceId = null } = {}) {
  const pregame = pregameContext(game);
  const base = {
    available: Boolean(pregame),
    source: null,
    summary_available: false,
    key_events: [],
    injuries: [],
    pregame,
    freshness: null,
    updated_label: null,
  };
  if (!espn || !game || !game.game_id || game.manual) return base;

  const league = game.league && game.league.id;
  // A score-site game id is bridged to its ESPN event here (see
  // resolveEspnEventId); an ESPN-sourced game already carries the event id.
  const eventId = await resolveEspnEventId({ espn, game, now, traceId });
  if (!league || !eventId) return base;

  const hit = cacheGet(game.game_id, now);
  if (hit) return buildContext({ game, summary: hit.summary, fetchedAt: hit.fetched_at, now });

  let summary = null;
  try {
    summary = await espn.getMatchSummary(game.sport, league, eventId, {
      traceId,
      ttl: CFG.contextTtlMs,
    });
  } catch (err) {
    summary = null;
  }
  if (!summary) return base;

  cachePut(game.game_id, summary, now);
  return buildContext({ game, summary, fetchedAt: now, now });
}


/**
 * Cached ESPN match-summary read for the stats pipeline (liveStats.js).
 * Returns `{ summary, fetched_at }` or null when no provider/event is
 * resolvable or the read fails. Shares the same short-TTL cache as
 * getContext, so the context view and the stats read cost one HTTP call.
 */
async function getSummary({ espn = null, game = null, now = Date.now(), traceId = null } = {}) {
  if (!espn || !game || !game.game_id || game.manual) return null;
  const league = game.league && game.league.id;
  const eventId = await resolveEspnEventId({ espn, game, now, traceId });
  if (!league || !eventId) return null;

  const hit = cacheGet(game.game_id, now);
  if (hit) return { summary: hit.summary, fetched_at: hit.fetched_at };

  let summary = null;
  try {
    summary = await espn.getMatchSummary(game.sport, league, eventId, {
      traceId,
      ttl: CFG.contextTtlMs,
    });
  } catch (err) {
    summary = null;
  }
  if (!summary) return null;
  cachePut(game.game_id, summary, now);
  return { summary, fetched_at: now };
}

/** Test/dev helper — clear the in-process summary + bridge caches. */
function resetCache() {
  cache.clear();
  espnEventCache.clear();
}

/**
 * The REAL bookmaker line+odds for a game, as the `game.odds` block the market
 * grid is priced against, or null when ESPN priced nothing. A convenience over
 * getSummary + realOddsFromSummary so every live caller (the analysis route and
 * the resolve route) attaches the SAME real line from the SAME cached summary
 * read — no extra HTTP call, and a game ESPN does not price stays un-priced so
 * its grid is withheld rather than priced off a simulated line.
 *
 * @param {Object} args
 * @param {Object} [args.espn]
 * @param {Object} args.game
 * @param {number} [args.now]
 * @param {string} [args.traceId]
 * @returns {Promise<Object|null>} { provider, overUnder, overOdds, underOdds, spread, moneyline }
 */
async function getRealOdds({ espn = null, game = null, now = Date.now(), traceId = null } = {}) {
  const read = await getSummary({ espn, game, now, traceId });
  return read ? realOddsFromSummary(read.summary) : null;
}

module.exports = {
  getContext,
  getSummary,
  getRealOdds,
  resolveEspnEventId,
  buildContext,
  realOddsFromSummary,
  pregameContext,
  extractKeyEvents,
  extractInjuries,
  resetCache,
};
