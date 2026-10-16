/**
 * basketball/leagues.js
 *
 * Per-league parameters. Every league-specific number lives here so shared code
 * paths never hardcode NBA constants.
 *
 * Key fields:
 *   gameMinutes        length of a regulation game (pace normalisation)
 *   ftWeight           coefficient on FTA in the possession formula
 *   homeCourtPoints    learned/expected home-court margin (points)
 *   leagueMean         prior means used for shrinkage + early-season blending
 *   sigma              base residual standard deviations for total/margin
 *   scoreStd           per-team score standard deviation (win-prob distribution)
 *   priorSeason        prior-season ratings used early in the season
 *   rotationSize       typical rotation size (used for replacement-level maths)
 *   espnPath           ESPN url segment for the scoreboard/summary endpoints
 */

const LEAGUES = {
  nba: {
    key: 'nba',
    label: 'NBA',
    espnPath: 'basketball/nba',
    gameMinutes: 48,
    ftWeight: 0.44,
    homeCourtPoints: 2.7,
    leagueMean: { possessions: 99.5, ortg: 114.0, drtg: 114.0 },
    sigma: { total: 17.5, margin: 11.5 },
    scoreStd: 11,
    priorSeason: { ortg: 114.0, drtg: 114.0, pace: 99.5 },
    rotationSize: 9,
    enabled: true,
  },
  wnba: {
    key: 'wnba',
    label: 'WNBA',
    espnPath: 'basketball/wnba',
    gameMinutes: 40,
    ftWeight: 0.44,
    homeCourtPoints: 2.4,
    leagueMean: { possessions: 80.5, ortg: 100.0, drtg: 100.0 },
    sigma: { total: 15.0, margin: 10.5 },
    scoreStd: 10,
    priorSeason: { ortg: 100.0, drtg: 100.0, pace: 80.5 },
    rotationSize: 8,
    enabled: true,
  },
  ncaa: {
    key: 'ncaa',
    label: 'NCAA',
    espnPath: 'basketball/mens-college-basketball',
    gameMinutes: 40,
    ftWeight: 0.44,
    homeCourtPoints: 3.2,
    leagueMean: { possessions: 70.0, ortg: 104.0, drtg: 104.0 },
    sigma: { total: 15.5, margin: 11.0 },
    scoreStd: 10.5,
    priorSeason: { ortg: 104.0, drtg: 104.0, pace: 70.0 },
    rotationSize: 9,
    enabled: true,
  },
  euroleague: {
    key: 'euroleague',
    label: 'EuroLeague',
    espnPath: 'basketball/eur',
    gameMinutes: 40,
    ftWeight: 0.44,
    homeCourtPoints: 3.0,
    leagueMean: { possessions: 72.0, ortg: 108.0, drtg: 108.0 },
    sigma: { total: 15.0, margin: 10.5 },
    scoreStd: 10.5,
    priorSeason: { ortg: 108.0, drtg: 108.0, pace: 72.0 },
    rotationSize: 9,
    enabled: true,
  },
};

// Aliases so callers can pass common provider names/paths.
const ALIASES = {
  'basketball/nba': 'nba',
  'basketball/wnba': 'wnba',
  'basketball/mens-college-basketball': 'ncaa',
  'mens-college-basketball': 'ncaa',
  'college-basketball': 'ncaa',
  ncaam: 'ncaa',
  eur: 'euroleague',
  euro: 'euroleague',
  'basketball/eur': 'euroleague',
};

/**
 * Resolve a caller-supplied league identifier to a canonical league key.
 * @param {string} [league]
 * @returns {string|null}
 */
function resolveLeagueKey(league) {
  if (!league) return null;
  const raw = String(league).trim().toLowerCase();
  if (LEAGUES[raw]) return raw;
  if (ALIASES[raw]) return ALIASES[raw];
  // Match on the last path segment (e.g. "basketball/nba" -> "nba").
  const seg = raw.split('/').filter(Boolean).pop();
  if (seg && LEAGUES[seg]) return seg;
  if (seg && ALIASES[seg]) return ALIASES[seg];
  return null;
}

/**
 * Get a league's configuration by key/alias.
 * Throws when the league is unknown or disabled rather than silently using NBA defaults.
 *
 * @param {string} league
 * @returns {Object}
 */
function getLeagueConfig(league) {
  const key = resolveLeagueKey(league);
  if (!key) {
    throw new Error(
      `Unknown basketball league "${league}". Configured leagues: ${Object.keys(LEAGUES).join(', ')}.`
    );
  }
  const cfg = LEAGUES[key];
  if (!cfg.enabled) {
    throw new Error(`Basketball league "${key}" is disabled.`);
  }
  return cfg;
}

/**
 * List enabled leagues.
 * @returns {Array<Object>}
 */
function listLeagues() {
  return Object.values(LEAGUES).filter(l => l.enabled);
}

module.exports = {
  LEAGUES,
  resolveLeagueKey,
  getLeagueConfig,
  listLeagues,
};
