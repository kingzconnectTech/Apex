const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (_) {}
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
} catch (_) {}

const PROVIDERS = {
  ESPN: 'espn',
  PITCHAPI: 'pitchapi',
};

const ESPN_BASE = 'http://site.api.espn.com/apis/site/v2/sports';
const PITCHAPI_BASE = 'https://api.pitchapi.dev';

const PITCHAPI_KEY = process.env.PITCHAPI_KEY || '';
const PITCHAPI_ENABLED = process.env.PITCHAPI_ENABLED === undefined
  ? true
  : (process.env.PITCHAPI_ENABLED === 'true' || process.env.PITCHAPI_ENABLED === '1');

/**
 * Default PitchAPI season. European football seasons run August→May.
 * Dates in Aug–Dec map to year/year+1; dates in Jan–Jul map to year-1/year.
 * e.g. 2026-10-13 → "2026/2027", 2026-03-15 → "2025/2026".
 */
function _defaultPitchApiSeason() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1-12
  return month >= 8 ? `${year}/${year + 1}` : `${year - 1}/${year}`;
}

/**
 * Resolve the configured PitchAPI season. Supports both bare-year ("2026")
 * and slashed ("2026/2027") forms. Falls back to API_FOOTBALL_SEASON for
 * backward compatibility with the legacy api-sports configuration.
 */
const PITCHAPI_SEASON = (
  process.env.PITCHAPI_SEASON ||
  process.env.API_FOOTBALL_SEASON ||
  ''
).trim() || _defaultPitchApiSeason();

/**
 * Normalize a season value into PitchAPI's required slashed form
 * (e.g. "2026" → "2026/2027"). Already-slashed values pass through.
 * Returns null for empty input.
 */
function normalizeSeason(season) {
  if (season == null) return null;
  const s = String(season).trim();
  if (!s) return null;
  if (/^\d{4}\/\d{4}$/.test(s)) return s;
  if (/^\d{4}$/.test(s)) {
    const year = parseInt(s, 10);
    return `${year}/${year + 1}`;
  }
  return s;
}

/**
 * Check whether a league's supported seasons array contains the requested
 * season. Matches both bare-year ("2026") and slashed ("2026/2027") forms.
 */
function leagueSupportsSeason(league, requestedSeason) {
  if (!requestedSeason) return true;
  const seasons = Array.isArray(league?.seasons) ? league.seasons : [];
  if (seasons.length === 0) return true; // can't filter, allow through
  const normRequested = normalizeSeason(requestedSeason);
  const bare = /^\d{4}$/.test(String(requestedSeason).trim()) ? String(requestedSeason).trim() : null;
  return seasons.some(s => {
    if (s === normRequested) return true;
    if (bare && String(s).startsWith(`${bare}/`)) return true;
    return false;
  });
}

const TTL = {
  LEAGUES: 24 * 60 * 60 * 1000,
  TEAMS: 12 * 60 * 60 * 1000,
  FIXTURES_SCHEDULED: 30 * 60 * 1000,
  FIXTURES_LIVE: 30 * 1000,
  FIXTURES_FINISHED: 24 * 60 * 60 * 1000,
  STANDINGS: 60 * 60 * 1000,
  TEAM_STATS: 60 * 60 * 1000,
  H2H: 12 * 60 * 60 * 1000,
  DEFAULT: 5 * 60 * 1000,
};

module.exports = {
  PROVIDERS,
  ESPN_BASE,
  PITCHAPI_BASE,
  PITCHAPI_KEY,
  PITCHAPI_ENABLED,
  PITCHAPI_SEASON,
  normalizeSeason,
  leagueSupportsSeason,
  TTL,
};
