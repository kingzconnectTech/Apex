/**
 * live/stats.js
 *
 * Phase 6 — the non-personal counters that answer "which bookmaker links and
 * which leagues need support?".
 *
 * Deliberately narrow: we record a BOOKMAKER DOMAIN, a sport, a league, an
 * outcome — never a full URL, never a user id, never an IP. The pasted link
 * itself is never stored (it can carry a session token), only the hostname.
 *
 * In-process and resettable, matching how the rest of the app keeps volatile
 * state. Nothing here is persisted, so a restart clears it.
 */

const CONFIG = require('./config');

const EMPTY = () => ({
  resolve_total: 0,
  resolve_matched: 0,
  resolve_candidates: 0,
  resolve_none: 0,
  parse_failed: 0,
  manual_entries: 0,
  analyses_served: 0,
  ship_gate_refusals: 0,
  feature_disabled: 0,
  rate_limited: 0,
  upstream_errors: 0,
  by_domain: {},
  by_sport: {},
  by_league: {},
});

let counters = EMPTY();

function enabled() {
  return CONFIG.liveApi.recordStats !== false;
}

function bump(map, key) {
  if (!key) return;
  map[key] = (map[key] || 0) + 1;
}

/**
 * Bookmaker hostname, lower-cased, without a leading "www.".
 * Returns null for anything that is not a plain hostname — we never store a
 * path, query or fragment, because a pasted URL can carry a session token.
 */
function hostnameOf(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return host.replace(/^www\./, '') || null;
  } catch (_) {
    return null;
  }
}

const TYPE_FIELDS = {
  resolve: 'resolve_total',
  matched: 'resolve_matched',
  candidates: 'resolve_candidates',
  none: 'resolve_none',
  parse_failed: 'parse_failed',
  manual_entry: 'manual_entries',
  analysis: 'analyses_served',
  ship_gate_refusal: 'ship_gate_refusals',
  feature_disabled: 'feature_disabled',
  rate_limited: 'rate_limited',
  upstream_error: 'upstream_errors',
};

/**
 * Record one event.
 *
 * @param {string} type one of the keys of TYPE_FIELDS
 * @param {Object} [meta] { domain, sport, league }
 */
function record(type, meta = {}) {
  if (!enabled()) return;
  const field = TYPE_FIELDS[type];
  if (!field) return;
  counters[field] += 1;
  if (meta.domain) bump(counters.by_domain, meta.domain);
  if (meta.sport) bump(counters.by_sport, meta.sport);
  if (meta.league) bump(counters.by_league, `${meta.sport || '?'}/${meta.league}`);
}

function ratio(numerator, denominator) {
  if (!denominator) return null;
  return Number((numerator / denominator).toFixed(4));
}

/** A copy of the counters plus the three rates the brief asks for. */
function snapshot() {
  const c = counters;
  const resolved = c.resolve_matched + c.resolve_candidates + c.resolve_none;
  return {
    ...c,
    by_domain: { ...c.by_domain },
    by_sport: { ...c.by_sport },
    by_league: { ...c.by_league },
    // Rates are null (not 0) when the denominator is empty — an unknown rate is
    // not the same as a rate of zero.
    match_success_rate: ratio(c.resolve_matched, resolved),
    candidates_rate: ratio(c.resolve_candidates, resolved),
    // The share of resolve attempts that needed the manual fallback. Hand-typed
    // games (`manual_entries`) are a raw tally ONLY and are deliberately kept
    // out of every rate here: they are unverified, so they must never move our
    // match, parse or coverage numbers.
    manual_entry_rate: ratio(c.resolve_none, c.resolve_total),
    parse_failure_rate: ratio(c.parse_failed, c.resolve_total),
  };
}

/** Test/dev helper. */
function reset() {
  counters = EMPTY();
}

module.exports = { record, snapshot, reset, hostnameOf };
