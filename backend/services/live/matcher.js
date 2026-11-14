/**
 * live/matcher.js
 *
 * Phase 2 — find the live game the user pasted a link for.
 *
 * Flow:
 *   1. Sweep ESPN scoreboards for the parsed sport's configured leagues
 *      (concurrency-capped, short TTL, deduped by event id).
 *   2. Keep fixtures that are live, or within the configured time window.
 *   3. Score every fixture against both parsed team names (./teamMatch).
 *   4. high + unambiguous -> 'matched'; several plausible -> 'candidates'
 *      (top N for the user to confirm); none -> try Pitch (soccer only);
 *      still none -> 'none' with manual entry.
 *
 * Nothing is ever guessed: a fixture must clear the minimum similarity on BOTH
 * sides to be a candidate, and an ambiguous result is returned as candidates
 * for confirmation rather than silently picking one.
 *
 * Providers are injected so this is unit-testable without any network.
 */

const CONFIG = require('./config');
const { PROVIDERS } = require('../providers/config');
const { normalizeFixtureESPN, normalizeFixturePitchAPI } = require('../providers/normalizer');
const { scoreFixture } = require('./teamMatch');

const CFG = CONFIG.matcher;

const STATUSES = {
  MATCHED: 'matched',
  CANDIDATES: 'candidates',
  NONE: 'none',
};

/** Run `fn` over `items` with at most `limit` promises in flight. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: size }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Swapping in an explicit sport makes later lookups deterministic. */
function withSport(parsed, sport) {
  return { ...parsed, sport };
}

function inferSport(parsed) {
  if (parsed.sport) return parsed.sport;
  const fromTeams = [
    parsed.home_resolved && parsed.home_resolved.sport,
    parsed.away_resolved && parsed.away_resolved.sport,
  ].filter(Boolean);
  const unique = new Set(fromTeams);
  return unique.size === 1 ? [...unique][0] : null;
}

/** League-hint first, then the configured order, de-duplicated. */
function buildSweep(sport, leagueHint) {
  const configured = (CFG.sweep && CFG.sweep[sport]) || [];
  const ordered = [];
  const add = l => { if (l && !ordered.includes(l)) ordered.push(l); };
  if (leagueHint && leagueHint.sport === sport) add(leagueHint.code);
  configured.forEach(add);
  return ordered;
}

function withinWindow(fixture, now) {
  const status = fixture.fixture.status;
  if (!CFG.includeStatuses.includes(status)) return false;
  if (status === 'live') return true;
  const ts = fixture.fixture.timestamp;
  if (!ts) return false;
  if (status === 'scheduled') return ts <= now + CFG.window.preHours * 3600 * 1000;
  if (status === 'finished') return ts >= now - CFG.window.postHours * 3600 * 1000;
  return false;
}

function dateKey(offsetDays, now) {
  return new Date(now + offsetDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * @param {Object} deps
 * @param {Object} deps.espn       EspnProvider (or a compatible stub)
 * @param {Object} [deps.pitchApi] PitchApiProvider (or stub)
 * @param {Object} [deps.logger]
 * @param {Function} [deps.now]    () => epoch ms (injected for tests)
 */
function createLiveMatcher({ espn, pitchApi = null, logger = null, now = Date.now } = {}) {
  if (!espn) throw new Error('createLiveMatcher requires an espn provider.');

  function log(level, message, meta = {}) {
    if (logger && typeof logger.log === 'function') {
      logger.log(level, `[LIVE][MATCH] ${message}`, meta);
    }
  }

  async function sweepEspn(sport, sweepList, nowMs, stats, traceId) {
    const pages = await mapLimit(sweepList, CFG.maxConcurrency, async league => {
      stats.leagues_swept++;
      try {
        const data = await espn._request(`${sport}/${league}/scoreboard`, {
          ttl: CFG.cacheTtlMs, traceId,
        });
        if (!data) return [];
        stats.espn_ok++;
        return (data.events || [])
          .map(e => normalizeFixtureESPN(e, sport, league, league))
          .filter(Boolean);
      } catch (err) {
        stats.errors++;
        log('warn', 'scoreboard sweep failed', { sport, league, error: err.message, traceId });
        return [];
      }
    });

    const seen = new Set();
    const fixtures = [];
    for (const page of pages) {
      for (const fx of page) {
        if (!withinWindow(fx, nowMs)) continue;
        const id = `${PROVIDERS.ESPN}:${fx.fixture.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        fixtures.push(fx);
      }
    }
    return fixtures;
  }

  function scoreAll(parsed, fixtures, source) {
    const out = [];
    for (const fixture of fixtures) {
      const scored = scoreFixture(parsed, fixture, CFG.minSideSimilarity);
      if (scored.score <= 0) continue;

      let confidence = scored.score;
      const notes = [];
      if (source === PROVIDERS.ESPN && parsed.league_hint
        && parsed.league_hint.code === fixture.league.id) {
        confidence += CFG.leagueHintBonus;
        notes.push('League hint agrees with the fixture league.');
      }
      if (fixture.fixture.status === 'live') {
        confidence += CFG.liveBonus;
        notes.push('Fixture is live.');
      }
      if (scored.orientation === 'swapped') {
        notes.push('Home/away order is the reverse of the link; orientation recorded.');
      }

      out.push({
        source,
        fixture,
        match_confidence: Math.min(CFG.maxConfidence, confidence),
        orientation: scored.orientation,
        home_similarity: Number(scored.home_similarity.toFixed(4)),
        away_similarity: Number(scored.away_similarity.toFixed(4)),
        match_notes: notes,
      });
    }
    out.sort((a, b) => b.match_confidence - a.match_confidence);
    return out;
  }

  async function pitchFallback(parsed, nowMs, stats, traceId) {
    if (!pitchApi || typeof pitchApi.isAvailable !== 'function' || !pitchApi.isAvailable()) return [];
    stats.pitch_used = true;

    const dates = [];
    for (let d = -CFG.pitchFallback.daySpan; d <= CFG.pitchFallback.daySpan; d++) {
      dates.push(dateKey(d, nowMs));
    }

    const collected = [];
    for (const date of dates) {
      try {
        // PitchAPI's status filter is unreliable (only status=all returns
        // matches), so we always request all and filter client-side.
        // getMatchesByDate already returns normalised fixtures, unlike the ESPN
        // scoreboard read above which is normalised here.
        const matches = await pitchApi.getMatchesByDate(date, { status: 'all', traceId });
        (matches || []).forEach(fx => collected.push(fx));
      } catch (err) {
        stats.errors++;
        log('warn', 'pitch fallback failed', { date, error: err.message, traceId });
      }
    }

    const seen = new Set();
    const fixtures = [];
    for (const fx of collected) {
      if (!withinWindow(fx, nowMs)) continue;
      const id = `${PROVIDERS.PITCHAPI}:${fx.fixture.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      fixtures.push(fx);
    }
    return scoreAll(parsed, fixtures, PROVIDERS.PITCHAPI);
  }

  function finalize(status, candidates, source, reason, stats, startedAt) {
    stats.duration_ms = Date.now() - startedAt;
    return {
      status,
      source: source || (candidates[0] ? candidates[0].source : null),
      candidates,
      reason: reason || null,
      manual_entry_required: status === STATUSES.NONE,
      stats,
    };
  }

  function decide(candidates) {
    if (!candidates.length) return null;
    const top = candidates[0];
    if (top.match_confidence < CFG.tiers.medium) {
      return { status: STATUSES.NONE, reason: 'no fixture scored above the match threshold' };
    }
    const second = candidates[1];
    const unambiguousHigh = top.match_confidence >= CFG.tiers.high
      && (!second || second.match_confidence < CFG.tiers.medium);
    if (unambiguousHigh) return { status: STATUSES.MATCHED, reason: null };
    return {
      status: STATUSES.CANDIDATES,
      reason: 'several plausible fixtures — please confirm the correct one',
    };
  }

  /**
   * Resolve a parsed link result to live fixtures.
   * @param {Object} parsed output of services/live/linkParser.parseLink
   * @param {{traceId?:string}} [opts]
   */
  async function resolveGame(parsed, { traceId = null } = {}) {
    const startedAt = Date.now();
    const nowMs = now();
    const stats = {
      leagues_swept: 0,
      fixtures_considered: 0,
      espn_ok: 0,
      pitch_used: false,
      errors: 0,
      duration_ms: 0,
    };

    if (!parsed || !parsed.recognised || !parsed.home_raw || !parsed.away_raw) {
      return finalize(STATUSES.NONE, [], null,
        'link not recognised — manual entry required', stats, startedAt);
    }

    const sweepable = inferSport(parsed);
    if (!sweepable || !CONFIG.live.supportedSports.includes(sweepable)) {
      return finalize(STATUSES.NONE, [], null,
        'sport could not be established from the link — manual entry required', stats, startedAt);
    }
    if (!CONFIG.live.sports[sweepable]) {
      return finalize(STATUSES.NONE, [], null,
        `live analysis is disabled for ${sweepable}`, stats, startedAt);
    }

    const target = withSport(parsed, sweepable);
    const sweepList = buildSweep(sweepable, target.league_hint);
    const fixtures = await sweepEspn(sweepable, sweepList, nowMs, stats, traceId);
    stats.fixtures_considered = fixtures.length;

    let candidates = scoreAll(target, fixtures, PROVIDERS.ESPN);

    if (!candidates.length && sweepable === 'soccer' && CFG.pitchFallback.enabled) {
      log('info', 'no ESPN match — falling back to Pitch', { traceId });
      candidates = await pitchFallback(target, nowMs, stats, traceId);
    }

    const verdict = decide(candidates);
    if (!verdict) {
      return finalize(STATUSES.NONE, [], null,
        'no matching fixture found — manual entry required', stats, startedAt);
    }

    const listed = verdict.status === STATUSES.MATCHED
      ? candidates.slice(0, 1)
      : candidates.slice(0, CFG.maxCandidates);

    log('info', `resolve -> ${verdict.status}`, {
      traceId, status: verdict.status, candidates: listed.length,
      considered: stats.fixtures_considered,
    });

    return finalize(verdict.status, listed, listed[0].source, verdict.reason, stats, startedAt);
  }

  /**
   * Re-read ONE fixture the caller already resolved, by its provider id, using
   * the same short live TTL as the initial sweep.
   *
   * This is the `/analysis` poll path: the game id is `${source}:${fixtureId}`,
   * so there is nothing to guess — we look for that exact event id in the
   * league's scoreboard and return it as a candidate with confidence 1.
   *
   * @param {Object} args
   * @param {string} args.sport    e.g. 'soccer' | 'basketball'
   * @param {string} args.league   ESPN league id, e.g. 'eng.1' | 'nba'
   * @param {string} args.sourceId the provider fixture id
   * @param {string} [args.traceId]
   * @returns {Promise<Object|null>} a matcher candidate, or null when the
   *   provider has no such event this tick (unknown id, or the game rolled off
   *   the scoreboard). Never throws.
   */
  async function refreshCandidate({ sport, league, sourceId, traceId = null } = {}) {
    if (!sport || !league || !sourceId) return null;
    if (!CONFIG.live.supportedSports.includes(sport)) return null;

    try {
      const data = await espn._request(`${sport}/${league}/scoreboard`, {
        ttl: CFG.cacheTtlMs, traceId,
      });
      const event = ((data && data.events) || [])
        .find(e => String(e.id) === String(sourceId));
      if (!event) return null;

      const fixture = normalizeFixtureESPN(event, sport, league, league);
      if (!fixture) return null;

      return {
        source: PROVIDERS.ESPN,
        fixture,
        // The id is an exact match — nothing was inferred, so nothing is
        // discounted. Similarities are recorded as 1 for that same reason.
        match_confidence: 1,
        orientation: 'direct',
        home_similarity: 1,
        away_similarity: 1,
        match_notes: ['Refreshed by provider event id.'],
      };
    } catch (err) {
      log('warn', 'refresh failed', { sport, league, sourceId, error: err.message, traceId });
      return null;
    }
  }

  /**
   * List EVERY fixture in the given leagues that is live or recently finished,
   * as matcher candidates. Unlike resolveGame, nothing is scored against team
   * names — the whole league is listed — so the confidence is nominal (there was
   * nothing to match) and the orientation is direct.
   *
   * This is the Phase 9 shadow scheduler's entry point: it sweeps a sport's
   * leagues on a fixed cadence, independent of any user request, so a held pick
   * gathers evidence whether or not anyone is watching.
   *
   * @param {Object} args
   * @param {string} args.sport    e.g. 'basketball'
   * @param {string[]} args.leagues ESPN league ids to sweep
   * @param {string} [args.traceId]
   * @returns {Promise<Array>} matcher candidates (possibly empty). Never throws.
   */
  async function listLeagueFixtures({ sport, leagues, traceId = null } = {}) {
    if (!sport || !Array.isArray(leagues) || !leagues.length) return [];
    if (!CONFIG.live.supportedSports.includes(sport)) return [];

    const nowMs = now();
    const stats = {
      leagues_swept: 0, fixtures_considered: 0, espn_ok: 0, pitch_used: false, errors: 0, duration_ms: 0,
    };
    const fixtures = await sweepEspn(sport, leagues, nowMs, stats, traceId);
    return fixtures.map(fixture => ({
      source: PROVIDERS.ESPN,
      fixture,
      match_confidence: 1,
      orientation: 'direct',
      home_similarity: null,
      away_similarity: null,
      match_notes: ['Listed by league sweep (shadow scheduler).'],
    }));
  }

  return { resolveGame, refreshCandidate, listLeagueFixtures };
}

module.exports = {
  createLiveMatcher,
  STATUSES,
  mapLimit,
  buildSweep,
  withinWindow,
};
