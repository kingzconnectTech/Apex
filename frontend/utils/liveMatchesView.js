/**
 * Pure view logic for the Live Matches screen.
 *
 * Kept out of the screen so every decision the UI makes — which state to show,
 * how to label a match, how to phrase a bad link — can be unit tested without a
 * React Native renderer.
 *
 * CommonJS on purpose: no React Native imports, so it loads from plain Node
 * (`node --test frontend/__tests__`) as well as from Metro.
 *
 * The screen's job is narrow: list the games the SERVER says are in play, let
 * the user open any of them (or their own preferred site link) in the in-app
 * browser, and say clearly when a link is not usable. All labelling lives here.
 */

/** The states the live-matches screen can be in. */
const VIEW_STATE = {
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  EMPTY: 'empty',
  ERROR: 'error',
};

const MESSAGES = {
  network: 'Network error. Check your connection.',
  rateLimited: 'Too many requests right now. Please wait a moment and try again.',
  disabled: 'The live matches feed is switched off.',
  unavailable: 'Live matches are unavailable on this server.',
  empty: 'No matches are in play right now. Check back soon.',
  degraded: 'Could not reach the score sites. Pull to refresh, or try again shortly.',
  invalidLink: 'That is not a recognisable http(s) link.',
  generic: 'Live matches could not be loaded right now.',
  noLink: 'Paste a link first.',
  notStarted: 'Not started',
  unknownSite: 'Not one of the known score sites',
};

/** Fallbacks when a match row is missing a field. */
const UNKNOWN_TEAM = 'Unknown';

/**
 * Turn a failed matches response into a specific, honest message.
 * @param {Object|null} result { unavailable, httpStatus, code, message }
 * @returns {string}
 */
function describeMatchesFailure(result) {
  switch (result && result.code) {
    case 'NETWORK_ERROR': return MESSAGES.network;
    case 'RATE_LIMITED': return MESSAGES.rateLimited;
    case 'MATCHES_DISABLED': return MESSAGES.disabled;
    case 'MATCHES_UNAVAILABLE': return MESSAGES.unavailable;
    default: return (result && result.message) || MESSAGES.generic;
  }
}

/** `"1 - 0"`, or `"- - -"` when a score is genuinely missing. */
function scoreLine(match) {
  const home = match && match.home ? match.home.score : null;
  const away = match && match.away ? match.away.score : null;
  const fmt = v => (v == null ? '-' : String(v));
  return `${fmt(home)} - ${fmt(away)}`;
}

/**
 * The phase label a row shows. The backend already resolved it (`status.label`,
 * e.g. "1st half", "Half time", "Overtime"); we only fall back, never invent.
 */
function statusLabel(match) {
  const status = (match && match.status) || {};
  if (status.label) return String(status.label);
  if (status.code) return String(status.code);
  if (status.live === false) return MESSAGES.notStarted;
  return 'Live';
}

/** True only when the backend marked the match in play. */
function isLive(match) {
  return Boolean(match && match.status && match.status.live === true);
}

/**
 * One match, shaped for rendering. `links` carries every site that has the game
 * (the list is de-duplicated server-side), so the user can pick which to open.
 */
function matchView(match) {
  const home = (match && match.home) || {};
  const away = (match && match.away) || {};
  const links = Array.isArray(match && match.links) ? match.links : [];
  return {
    id: (match && match.id) || null,
    sport: (match && match.sport) || null,
    sportLabel: (match && match.sport_label) || null,
    league: (match && match.league) || null,
    country: (match && match.country) || null,
    homeName: home.name || UNKNOWN_TEAM,
    awayName: away.name || UNKNOWN_TEAM,
    homeScore: home.score == null ? null : home.score,
    awayScore: away.score == null ? null : away.score,
    score: scoreLine(match),
    statusLabel: statusLabel(match),
    isLive: isLive(match),
    source: (match && match.source_name) || (match && match.source) || null,
    sourceNames: links.map(l => l && l.source_name).filter(Boolean),
    url: (match && match.url) || null,
    links: links.map(l => ({
      source: (l && l.source) || null,
      sourceName: (l && l.source_name) || (l && l.source) || null,
      url: (l && l.url) || null,
    })),
    startTime: (match && match.start_time) || null,
  };
}

/** Every match in the payload, shaped for rendering. */
function matchRows(payload) {
  const list = (payload && Array.isArray(payload.matches)) ? payload.matches : [];
  return list.map(matchView);
}

/**
 * Classify a matches response into the one state the screen renders.
 *
 * `degraded` (every source failed) is deliberately NOT a hard error: the
 * request succeeded, the sites are simply unreachable, so the screen shows an
 * empty list plus the reason rather than a network-error box.
 *
 * @param {Object|null} result
 * @returns {{state:string, message:string|null, matches:Array, sites:Array,
 *            degraded:boolean, sources:Array, refresh:Object|null, updatedLabel:string|null}}
 */
function classifyMatchesResult(result) {
  const base = {
    state: VIEW_STATE.LOADING,
    message: null,
    matches: [],
    sites: [],
    degraded: false,
    sources: [],
    refresh: null,
    updatedLabel: null,
  };

  if (result == null) return base;
  if (result.unavailable) {
    return { ...base, state: VIEW_STATE.ERROR, message: describeMatchesFailure(result) };
  }

  const matches = matchRows(result);
  const sites = Array.isArray(result.sites) ? result.sites : [];
  const sources = Array.isArray(result.sources) ? result.sources : [];
  const degraded = result.degraded === true;

  if (matches.length === 0) {
    return {
      ...base,
      state: VIEW_STATE.EMPTY,
      message: degraded ? MESSAGES.degraded : MESSAGES.empty,
      sites,
      sources,
      degraded,
      refresh: result.refresh || null,
    };
  }

  return {
    ...base,
    state: VIEW_STATE.READY,
    matches,
    sites,
    sources,
    degraded,
    refresh: result.refresh || null,
  };
}

/** Poll interval in seconds, clamped to the backend's floor. */
function refreshSeconds(payload) {
  const r = (payload && payload.refresh) || {};
  const suggested = Number.isFinite(r.suggested_seconds) ? r.suggested_seconds : 30;
  const min = Number.isFinite(r.min_seconds) ? r.min_seconds : 15;
  return Math.max(min, suggested);
}

/**
 * "updated 12s ago" for the payload's `fetched_at`, or null when unknown.
 * @param {Object} payload
 * @param {number} [now] injected clock (ms)
 */
function updatedLabel(payload, now = Date.now()) {
  const at = payload && payload.fetched_at;
  if (!at) return null;
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'updated just now';
  if (s < 60) return `updated ${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `updated ${m}m ago`;
  return `updated ${Math.round(m / 60)}h ago`;
}

/**
 * The preferred-site picker options. Prefers the list on the matches payload,
 * falling back to the capabilities payload, then to a static pair so the picker
 * is never empty.
 */
function siteOptions(capabilities, payload = null) {
  const fromPayload = payload && Array.isArray(payload.sites) ? payload.sites : null;
  const fromCaps = capabilities && capabilities.matches
    && Array.isArray(capabilities.matches.sites) ? capabilities.matches.sites : null;
  const list = (fromPayload && fromPayload.length ? fromPayload : fromCaps) || [];
  return list
    .filter(s => s && s.id)
    .map(s => ({ id: s.id, name: s.name || s.id, host: s.host || null, home: s.home || null }));
}

/** A short per-source status line: "FlashScore 12 · LiveScore (failed)". */
function sourceSummary(payload) {
  const sources = (payload && Array.isArray(payload.sources)) ? payload.sources : [];
  return sources.map(s => ({
    id: s.id,
    name: s.name || s.id,
    ok: s.ok !== false,
    count: Number.isFinite(s.count) ? s.count : null,
    error: s.error || null,
  }));
}

/**
 * Classify a validate-link response into what the UI should show.
 *
 * A valid link always carries an `url` to open; `recognised:false` means the
 * host is not one of the known score sites — still openable, never presented as
 * a known site.
 *
 * @param {Object|null} verdict
 * @returns {{ok:boolean, message:string|null, url:string|null, recognised:boolean,
 *            siteName:string|null, note:string|null}}
 */
function classifyValidation(verdict) {
  const base = { ok: false, message: null, url: null, recognised: false, siteName: null, note: null };
  if (verdict == null) return { ...base, message: MESSAGES.generic };
  if (verdict.unavailable) return { ...base, message: describeMatchesFailure(verdict) };
  if (verdict.valid !== true) {
    return { ...base, message: verdict.reason || MESSAGES.invalidLink };
  }
  return {
    ok: true,
    message: null,
    url: verdict.url || null,
    recognised: verdict.recognised === true,
    siteName: verdict.site_name || null,
    note: verdict.note || null,
  };
}

/** A local pre-check before hitting the network: empty input is refused here. */
function validateInput(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return { ok: false, message: MESSAGES.noLink };
  return { ok: true, value: trimmed, message: null };
}

module.exports = {
  VIEW_STATE,
  MESSAGES,
  describeMatchesFailure,
  classifyMatchesResult,
  matchView,
  matchRows,
  scoreLine,
  statusLabel,
  isLive,
  refreshSeconds,
  updatedLabel,
  siteOptions,
  sourceSummary,
  classifyValidation,
  validateInput,
};
