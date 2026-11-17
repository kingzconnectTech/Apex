/**
 * live/matchFeed.js
 *
 * "Live matches" — list the games that are IN PLAY right now, read from the two
 * public score sites the product targets:
 *
 *   - LiveScore  : the public CDN JSON the site itself loads, one document per
 *                  (sport, UTC day). An event carries `Epr` (0 not started,
 *                  1 in progress, 2 finished), so the live set is exact.
 *   - FlashScore : the public "ninja" feed (plain text) the mobile site loads.
 *                  Each match block carries `AB` (1 scheduled, 2 live,
 *                  3 finished) and `AG`/`AH` (the score), so the live set is
 *                  read from a status field, never inferred from a start time.
 *
 * Nothing here places a bet, reads odds or writes anything: the list is built on
 * demand, cached for a few seconds (config.live.matchFeed.cacheTtlMs) and handed
 * to the client. Each source is fetched independently, so one site being down
 * degrades the list instead of emptying it.
 *
 * `validateSiteLink` is the companion check for a link the USER supplies (their
 * own streaming or score site): it accepts only http/https links and reports
 * whether the host is one of the known sites (config.live.matchFeed.sites). An
 * unknown host is still allowed — it is simply labelled unrecognised, never
 * passed off as known.
 */

const CONFIG = require('./config');

const CFG = CONFIG.live.matchFeed;

/** The public per-day window, in ms. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Printable-length link cap, mirroring the bookmaker parser's limit. */
const MAX_LINK_LENGTH = 2048;

/**
 * The header FlashScore's OWN public feed endpoint requires. It is a fixed,
 * publicly-served site constant (it ships in their page source), not a
 * credential of ours, and it is never treated as a secret here.
 */
const FLASHSCORE_FSIGN = 'SW9D1eZo';

const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

/** Display names + the sport label the UI shows. */
const SPORT_LABELS = { soccer: 'Football', basketball: 'Basketball' };
const SOURCE_NAMES = { livescore: 'LiveScore', flashscore: 'FlashScore' };
/** Primacy when the same game appears on both sites (lower = wins). */
const SOURCE_ORDER = ['livescore', 'flashscore'];

/** LiveScore `Eps` codes -> readable phase labels (the in-play ones matter). */
const LIVESCORE_PHASE_LABELS = {
  NS: 'Not started',
  '1H': '1st half',
  '2H': '2nd half',
  HT: 'Half time',
  ET: 'Extra time',
  BT: 'Break',
  P: 'Penalties',
  PEN: 'Penalties',
  OT: 'Overtime',
  AET: 'After extra time',
  AP: 'After penalties',
  FT: 'Full time',
  'Canc.': 'Cancelled',
  'Postp.': 'Postponed',
  'Aban.': 'Abandoned',
};

/* ------------------------------------------------------------------ helpers */

function trimName(v) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s || null;
}

function toInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** Lowercase, punctuation-free key used to pair a match across sources. */
function teamKey(name) {
  return String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** URL slug: lowercase, non-alphanumerics collapsed to single hyphens. */
function slugify(v) {
  return String(v == null ? '' : v)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** LiveScore start stamps are `YYYYMMDDHHmmss` (UTC) -> ISO, or null. */
function isoFromBasicStamp(stamp) {
  const s = String(stamp == null ? '' : stamp);
  if (!/^\d{14}$/.test(s)) return null;
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
    + `T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** FlashScore start stamps are unix SECONDS -> ISO, or null. */
function isoFromUnixSeconds(sec) {
  const n = toInt(sec);
  if (n == null || n <= 0) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** `YYYYMMDD` (UTC) for the given instant. */
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}`
    + `${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    + `${String(d.getUTCDate()).padStart(2, '0')}`;
}

/* ----------------------------------------------------------- LiveScore source */

function livescoreUrl(sport, ms) {
  return 'https://prod-cdn-public-api.livescore.com/v1/api/app/date/'
    + `${sport}/${dayKey(ms)}/-3?MD=1`;
}

/** The first entry of a LiveScore `T1`/`T2` array is the side's team. */
function livescoreTeam(ev, key) {
  const list = ev && Array.isArray(ev[key]) ? ev[key] : [];
  const first = list[0];
  return first && first.Nm ? trimName(first.Nm) : null;
}

/**
 * In-play test. `Epr` is LiveScore's progress marker and is the reliable
 * signal: it is 0 on every not-started event and 2 on every finished one
 * (both verified against the live feed), so 1 is in progress. A literal
 * `Eps === 'LIVE'` is honoured too, in case the code is ever used directly.
 */
function isLiveScoreLive(ev) {
  return ev && (ev.Epr === 1 || ev.Eps === 'LIVE');
}

function livescoreLabel(ev) {
  const code = String((ev && ev.Eps) || '');
  return LIVESCORE_PHASE_LABELS[code] || 'Live';
}

/**
 * The site URL for a LiveScore match:
 *   https://www.livescore.com/en/<sport>/<competition>/<stage>/<home>-<away>/<id>/
 * (verified reachable; the numeric segment is the event id). Falls back to the
 * site home when the stage did not carry the slugs needed to build it.
 */
function livescoreMatchUrl(stage, ev, sport) {
  const home = livescoreTeam(ev, 'T1');
  const away = livescoreTeam(ev, 'T2');
  const comp = stage && (stage.CompUrlName || stage.Ccd);
  const stageSlug = stage && stage.Scd;
  const id = ev && ev.Eid;
  if (!home || !away || !comp || !stageSlug || !id) return 'https://www.livescore.com/en/';
  const pathSport = sport === 'basketball' ? 'basketball' : 'football';
  return `https://www.livescore.com/en/${pathSport}/${comp}/${stageSlug}/`
    + `${slugify(home)}-${slugify(away)}/${id}/`;
}

/**
 * Parse a LiveScore day document into normalised live matches.
 * Pure: no network, no clock dependency beyond `now`.
 */
function parseLiveScoreDate(json, { sport = 'soccer' } = {}) {
  const stages = json && Array.isArray(json.Stages) ? json.Stages : [];
  const out = [];
  for (const stage of stages) {
    const events = stage && Array.isArray(stage.Events) ? stage.Events : [];
    const league = trimName(stage.CompN || stage.Cnm || stage.Csnm || stage.Snm);
    const country = trimName(stage.CompD);
    for (const ev of events) {
      if (!isLiveScoreLive(ev)) continue;
      const home = livescoreTeam(ev, 'T1');
      const away = livescoreTeam(ev, 'T2');
      if (!home || !away || !ev.Eid) continue;
      out.push(buildMatch({
        id: `livescore:${ev.Eid}`,
        source: 'livescore',
        sport,
        league,
        country,
        home: { name: home, score: toInt(ev.Tr1) },
        away: { name: away, score: toInt(ev.Tr2) },
        status: { code: String(ev.Eps || ''), label: livescoreLabel(ev), live: true },
        start_time: isoFromBasicStamp(ev.Esd),
        url: livescoreMatchUrl(stage, ev, sport),
      }));
    }
  }
  return out;
}

/* ---------------------------------------------------------- FlashScore source */

/**
 * FlashScore's sport ids inside the feed path. Football is 1 and basketball is
 * 3 (verified returning distinct feeds). Day offset 0 is the current day.
 */
function flashscoreUrl(sport) {
  const sportId = sport === 'basketball' ? 3 : 1;
  return `https://global.flashscore.ninja/2/x/feed/f_${sportId}_0_3_en_1`;
}

/** `AA÷id¬AD÷ts¬...` -> { AA: 'id', AD: 'ts', ... } (first value wins). */
function fieldMap(block) {
  const map = {};
  for (const part of String(block || '').split('¬')) {
    const i = part.indexOf('÷');
    if (i <= 0) continue;
    const key = part.slice(0, i);
    if (map[key] === undefined) map[key] = part.slice(i + 1);
  }
  return map;
}

/**
 * A league header reads "COUNTRY: Competition - Stage"; split it so the league
 * shows a clean name. A header without a colon is the league name alone.
 */
function splitLeagueHeader(value) {
  const raw = String(value || '').trim();
  if (!raw) return { league: null, country: null };
  const at = raw.indexOf(':');
  if (at === -1) return { league: raw, country: null };
  return {
    league: raw.slice(at + 1).trim() || null,
    country: raw.slice(0, at).trim() || null,
  };
}

/**
 * Parse the FlashScore ninja feed into normalised live matches.
 *
 * Blocks are separated by `~`; a block carrying `ZA` opens a new league and
 * every subsequent block carrying `AA` is one of its matches. `AB` is the match
 * state (1 scheduled, 2 live, 3 finished) — only `2` is kept — and `AG`/`AH`
 * are the two sides' scores.
 */
function parseFlashScoreFeed(text, { sport = 'soccer' } = {}) {
  const out = [];
  let league = null;
  let country = null;
  for (const block of String(text || '').split('~')) {
    if (!block) continue;
    const fields = fieldMap(block);
    if (fields.ZA) {
      const split = splitLeagueHeader(fields.ZA);
      league = split.league;
      country = split.country;
      continue;
    }
    if (!fields.AA) continue;
    if (fields.AB !== '2') continue;
    const home = trimName(fields.AE);
    const away = trimName(fields.AF);
    if (!home || !away) continue;
    out.push(buildMatch({
      id: `flashscore:${fields.AA}`,
      source: 'flashscore',
      sport,
      league,
      country,
      home: { name: home, score: toInt(fields.AG) },
      away: { name: away, score: toInt(fields.AH) },
      status: { code: 'live', label: 'Live', live: true },
      start_time: isoFromUnixSeconds(fields.AD),
      url: `https://www.flashscore.com/match/${fields.AA}/`,
    }));
  }
  return out;
}

/* -------------------------------------------------------------- normalisation */

/** Shape one source's match into the single contract the UI renders. */
function buildMatch(m) {
  const name = SOURCE_NAMES[m.source] || m.source;
  return {
    id: m.id,
    source: m.source,
    source_name: name,
    sport: m.sport,
    sport_label: SPORT_LABELS[m.sport] || null,
    league: m.league || null,
    country: m.country || null,
    home: m.home,
    away: m.away,
    status: m.status,
    start_time: m.start_time || null,
    url: m.url || null,
    links: [{ source: m.source, source_name: name, url: m.url || null }],
  };
}

/** Order-independent key for one match: sport + the two team names. */
function matchKey(m) {
  return `${m.sport}|${[teamKey(m.home && m.home.name), teamKey(m.away && m.away.name)].sort().join('|')}`;
}

/** Collapse duplicate (source, url) link entries. */
function uniqueLinks(links) {
  const seen = new Set();
  const out = [];
  for (const l of links || []) {
    const k = `${l.source}|${l.url}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

/**
 * Merge the same game reported by both sites into ONE row, so the list never
 * shows a match twice. The higher-priority source keeps its score, status and
 * clock; every site that has the match is kept in `links` so the user can pick
 * which one to open.
 */
function dedupeMatches(list) {
  const byKey = new Map();
  for (const m of list) {
    const key = matchKey(m);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, m);
      continue;
    }
    const mRank = SOURCE_ORDER.indexOf(m.source);
    const eRank = SOURCE_ORDER.indexOf(existing.source);
    if (mRank !== -1 && (eRank === -1 || mRank < eRank)) {
      m.links = uniqueLinks([...m.links, ...existing.links]);
      byKey.set(key, m);
    } else {
      existing.links = uniqueLinks([...existing.links, ...m.links]);
    }
  }
  return [...byKey.values()];
}

/* ------------------------------------------------------------------- network */

async function httpGet(url, { headers, timeoutMs, fetchImpl } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('fetch is not available');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  if (controller && timeoutMs > 0) timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      headers: { 'User-Agent': UA, ...(headers || {}) },
      signal: controller ? controller.signal : undefined,
    });
    if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
    return await res.text();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sourceHeaders(sourceId) {
  if (sourceId === 'flashscore') {
    return { 'x-fsign': FLASHSCORE_FSIGN, Referer: 'https://www.flashscore.com/' };
  }
  return {};
}

/**
 * The URLs one source needs for one sport. LiveScore is read per UTC day and
 * both today and yesterday are read, so a game that kicked off before midnight
 * UTC and is still running is not missed. FlashScore's feed is a single
 * document for the current day.
 */
function sourceUrls(sourceId, sport, now) {
  if (sourceId === 'livescore') {
    return [livescoreUrl(sport, now), livescoreUrl(sport, now - DAY_MS)];
  }
  return [flashscoreUrl(sport)];
}

/** Fetch and parse one source across its configured sports, isolating failures. */
async function loadSource(sourceId, { now, fetchImpl }) {
  const def = (CFG.sources && CFG.sources[sourceId]) || {};
  const sports = Array.isArray(def.sports) ? def.sports : [];
  const started = Date.now();
  const matches = [];
  const errors = [];
  for (const sport of sports) {
    for (const url of sourceUrls(sourceId, sport, now)) {
      try {
        const text = await httpGet(url, {
          headers: sourceHeaders(sourceId),
          timeoutMs: CFG.requestTimeoutMs,
          fetchImpl,
        });
        const parsed = sourceId === 'livescore'
          ? parseLiveScoreDate(JSON.parse(text), { sport, now })
          : parseFlashScoreFeed(text, { sport, now });
        matches.push(...parsed);
      } catch (err) {
        errors.push(`${sport}: ${(err && err.message) || String(err)}`);
      }
    }
  }
  return {
    id: sourceId,
    name: SOURCE_NAMES[sourceId] || sourceId,
    ok: errors.length === 0,
    count: matches.length,
    error: errors.length ? errors.join('; ') : null,
    duration_ms: Date.now() - started,
    matches,
  };
}

/** Module-level cache, shared across requests (see CFG.cacheTtlMs). */
let cache = { at: 0, value: null };

/** Drop the cached list. Tests use this; a restart does it for free. */
function resetCache() {
  cache = { at: 0, value: null };
}

/** Which source ids are switched on in config. */
function enabledSourceIds() {
  return Object.keys(CFG.sources || {}).filter(id => CFG.sources[id] && CFG.sources[id].enabled);
}

function isEnabled() {
  return CFG.enabled !== false;
}

/** The known sites a user may save as a preferred link. */
function sites() {
  return (CFG.sites || []).map(s => ({ id: s.id, name: s.name, host: s.host, home: s.home }));
}

/**
 * List the live games across the enabled sources.
 *
 * @param {Object}   [opts]
 * @param {string[]} [opts.sources]   restrict to these source ids
 * @param {number}   [opts.now]       injected clock (ms)
 * @param {Function} [opts.fetchImpl] injected fetch (tests)
 * @param {boolean}  [opts.force]     bypass the short cache
 * @returns {Promise<Object>} the payload the route serves
 */
async function fetchLiveMatches({ sources = null, now = Date.now(), fetchImpl = null, force = false } = {}) {
  if (!force && cache.value && now - cache.at < CFG.cacheTtlMs) return cache.value;

  const requested = Array.isArray(sources) && sources.length
    ? sources.filter(id => CFG.sources && CFG.sources[id])
    : enabledSourceIds();
  const ids = requested.length ? requested : enabledSourceIds();

  const results = await Promise.all(ids.map(id => loadSource(id, { now, fetchImpl })));

  const all = [];
  results.forEach(r => { all.push(...r.matches); });

  const merged = dedupeMatches(all);
  merged.sort((a, b) => {
    const at = a.start_time ? Date.parse(a.start_time) : 0;
    const bt = b.start_time ? Date.parse(b.start_time) : 0;
    return at - bt;
  });
  const matches = merged.slice(0, CFG.maxMatches);

  const value = {
    enabled: isEnabled(),
    count: matches.length,
    fetched_at: new Date(now).toISOString(),
    // Every source failed: the surface is up but has nothing to show.
    degraded: results.length > 0 && results.every(r => !r.ok),
    refresh: {
      suggested_seconds: CFG.refresh.suggestedSeconds,
      min_seconds: CFG.refresh.minSeconds,
    },
    sources: results.map(r => ({
      id: r.id,
      name: r.name,
      ok: r.ok,
      count: r.count,
      error: r.error,
      duration_ms: r.duration_ms,
    })),
    sites: sites(),
    matches,
  };

  cache = { at: now, value };
  return value;
}

/* ------------------------------------------------------- user link validation */

/**
 * Validate a link the USER supplies (their own streaming or score site).
 *
 * Only http/https links are accepted, so a `javascript:` / `file:` / `data:`
 * URL can never reach the in-app browser. A host that is one of the known sites
 * is reported as recognised; any other well-formed host is still allowed, but
 * is explicitly marked unrecognised rather than presented as known.
 *
 * @param {string} raw
 * @returns {{valid:boolean, reason?:string, url?:string, site_id?:string|null,
 *            site_name?:string|null, recognised?:boolean, note?:string|null}}
 */
function validateSiteLink(raw) {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input) return { valid: false, reason: 'Enter a link first.' };
  if (input.length > MAX_LINK_LENGTH) {
    return { valid: false, reason: `That link is longer than ${MAX_LINK_LENGTH} characters.` };
  }

  let url = null;
  try {
    url = new URL(input);
  } catch (err) {
    try {
      url = new URL('https://' + input.replace(/^\/+/, ''));
    } catch (err2) {
      return { valid: false, reason: 'That is not a recognisable web link.' };
    }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { valid: false, reason: 'Only http and https links can be opened.' };
  }

  const host = url.hostname.toLowerCase();
  if (!host || !host.includes('.')) {
    return { valid: false, reason: 'That link has no web address.' };
  }

  const site = (CFG.sites || []).find(s => host === s.host || host.endsWith('.' + s.host));
  return {
    valid: true,
    url: url.toString(),
    site_id: site ? site.id : null,
    site_name: site ? site.name : null,
    recognised: Boolean(site),
    note: site
      ? null
      : 'This is not one of the known score sites. It will still open in the in-app browser.',
  };
}

module.exports = {
  fetchLiveMatches,
  validateSiteLink,
  sites,
  isEnabled,
  resetCache,
  // exported for the unit tests
  parseLiveScoreDate,
  parseFlashScoreFeed,
  dedupeMatches,
  validateLink: validateSiteLink,
  livescoreUrl,
  flashscoreUrl,
  splitLeagueHeader,
  fieldMap,
  isoFromBasicStamp,
  isoFromUnixSeconds,
  slugify,
  MAX_LINK_LENGTH,
};
