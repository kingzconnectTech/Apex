/**
 * live/linkPatterns.js
 *
 * Phase 1 — declarative parser rules for pasted bookmaker links.
 *
 * RULES ONLY, NO LOGIC. The parser (./linkParser.js) knows how to execute four
 * rule kinds; everything about *which* URL shapes we accept is data here.
 * Adding a new bookmaker format therefore means adding an entry to
 * DOMAIN_PATTERNS (preferred) or GENERIC_PATTERNS — no code change.
 *
 * Rule kinds understood by the parser:
 *   'query-explicit'  - teams in named query parameters (home/away style)
 *   'query-teams'     - teams in numbered query parameters (team1/team2 style)
 *   'path-separator'  - teams separated by -v- / -vs- / -versus- in the path
 *   'path-adjacent'   - two consecutive path segments, one team each
 *   'path-glued'      - one hyphen-glued slug that must be alias-split
 *
 * Rule fields:
 *   id         unique id (used in parse_notes and tests)
 *   kind       one of the kinds above
 *   confidence optional override for this rule's base score
 *   homeKeys   (query kinds) normalised parameter names carrying the home team
 *   awayKeys   (query kinds) normalised parameter names carrying the away team
 *   sportKey / leagueKey  (query kinds) optional hint parameters
 *   separators (path-separator) separator words, longest first
 *   note       human explanation surfaced in parse_notes
 *
 * Only the URL *text* is ever read. Nothing in this file triggers a network
 * request to the bookmaker.
 */

/** Separator words accepted in path slugs, longest first so `vs` wins over `v`. */
const PATH_SEPARATORS = ['versus', 'vrs', 'vs', 'v'];

/**
 * Path segments that are never a team name. Keeping these out of team
 * candidates is what stops `/basketball/nba/...` from matching "nba" as a team.
 */
const NOISE_SEGMENTS = new Set([
  'sport', 'sports', 'sportsbook', 'bet', 'betting', 'bets', 'odds', 'market',
  'markets', 'match', 'matches', 'event', 'events', 'game', 'games', 'fixture',
  'fixtures', 'live', 'inplay', 'in-play', 'today', 'tomorrow', 'upcoming',
  'results', 'result', 'score', 'scores', 'coupon', 'tips', 'tip', 'predictions',
  'prediction', 'en', 'int', 'us', 'uk', 'au', 'betting-en', 'home', 'away',
  'football', 'soccer', 'fussball', 'futbol', 'calcio', 'futebol', 'voetbal',
  'basketball', 'basket', 'hoops', 'nba', 'wnba', 'ncaa', 'ncaab', 'euroleague',
  'nfl', 'ncaaf', 'mlb', 'nhl', 'tennis', 'hockey', 'baseball', 'rugby',
  'preview', 'stats', 'statistics', 'h2h', 'head-to-head', 'standings', 'team',
  'teams', 'player', 'players', 'outright', 'outrights', 'specials', 'index',
  'html', 'htm', 'php', 'aspx', 'jsp', 'cgi-bin', 'default', 'main', 'detail',
  'details', 'overview', 'summary', 'vs', 'v', 'versus',
]);

/**
 * Domain-scoped rules. Keys are matched as suffixes of the hostname, so
 * 'sportsbet.com.au' also matches 'www.sportsbet.com.au'.
 *
 * A domain entry is either:
 *   { unsupported: true, note: '...' }         -> hard stop with a clear reason
 *   { rules: [ ...rule objects... ], note }    -> tried BEFORE the generic rules
 *
 * The map is intentionally the only place a bookmaker host appears. Example of
 * the shape to add (replace with a real captured URL before relying on it):
 *
 *   'example-bookmaker.com': {
 *     note: 'Teams are in a trailing -v- slug after a numeric market id.',
 *     rules: [
 *       { id: 'examplebook-v', kind: 'path-separator', separators: PATH_SEPARATORS },
 *     ],
 *   },
 */
const DOMAIN_PATTERNS = {
  // Hash-routed single-page bookmakers put no team text in the URL at all:
  // everything after '#' is a client-side route (market ids and bet codes).
  // There is nothing honest to parse, so we say so instead of guessing.
  'bet365.com': {
    unsupported: true,
    note: 'Hash-routed interface; the teams are not present in the URL text.',
  },
};

/**
 * Generic fallback rules, tried in order. The first rule that extracts a
 * plausible home/away pair wins, so the most reliable shape is listed first.
 */
const GENERIC_PATTERNS = [
  {
    id: 'generic-query-explicit',
    kind: 'query-explicit',
    note: 'Teams read from explicit home/away query parameters.',
    homeKeys: ['home', 'hometeam', 'home-team', 'hteam', 'teamhome', 'localteam'],
    awayKeys: ['away', 'awayteam', 'away-team', 'ateam', 'teamaway', 'visitorteam'],
    sportKey: ['sport', 'sportname', 'discipline'],
    leagueKey: ['league', 'competition', 'tournament', 'leagueid', 'leagueidname'],
  },
  {
    id: 'generic-query-teams',
    kind: 'query-teams',
    note: 'Teams read from numbered query parameters (team1/team2).',
    homeKeys: ['team1', 'teama', 'participant1', 'firstteam', 't1'],
    awayKeys: ['team2', 'teamb', 'participant2', 'secondteam', 't2'],
    sportKey: ['sport', 'sportname', 'discipline'],
    leagueKey: ['league', 'competition', 'tournament'],
  },
  {
    id: 'generic-path-separator',
    kind: 'path-separator',
    note: 'Teams separated by -v-/-vs-/-versus- in the final path segment.',
    separators: PATH_SEPARATORS,
  },
  {
    id: 'generic-path-adjacent',
    kind: 'path-adjacent',
    note: 'Last two path segments treated as one team each.',
  },
  {
    id: 'generic-path-glued',
    kind: 'path-glued',
    note: 'Single hyphen-glued slug split using the alias table.',
  },
];

/**
 * Sport hints found in the URL. Keys are normalised tokens (lowercase, no
 * punctuation). Bare 'football' is handled separately by the parser because it
 * is ambiguous between soccer and American football.
 */
const SPORT_HINTS = {
  soccer: 'soccer',
  fussball: 'soccer',
  futbol: 'soccer',
  calcio: 'soccer',
  futebol: 'soccer',
  voetbal: 'soccer',
  football: 'soccer',
  basketball: 'basketball',
  basket: 'basketball',
  bball: 'basketball',
  hoops: 'basketball',
  nba: 'basketball',
  wnba: 'basketball',
  ncaab: 'basketball',
  ncaam: 'basketball',
  euroleague: 'basketball',
};

/**
 * Tokens that mean "American football" rather than soccer when combined with a
 * bare 'football' hint.
 */
const AMERICAN_FOOTBALL_MARKERS = ['nfl', 'ncaaf', 'american-football', 'american football', 'gridiron'];

/**
 * League slug -> { code, sport }. `code` is the ESPN league identifier the
 * sweep uses in Phase 2. Hints are best-effort: they only reorder/prioritise the
 * sweep, they never decide the match on their own.
 *
 * Only leagues we have actually verified against the ESPN scoreboard are
 * listed. Add an entry here when you add a league.
 */
const LEAGUE_HINTS = {
  // Soccer
  'premier league': { code: 'eng.1', sport: 'soccer' },
  'english premier league': { code: 'eng.1', sport: 'soccer' },
  'england premier league': { code: 'eng.1', sport: 'soccer' },
  epl: { code: 'eng.1', sport: 'soccer' },
  championship: { code: 'eng.2', sport: 'soccer' },
  'efl championship': { code: 'eng.2', sport: 'soccer' },
  'la liga': { code: 'esp.1', sport: 'soccer' },
  laliga: { code: 'esp.1', sport: 'soccer' },
  'spanish la liga': { code: 'esp.1', sport: 'soccer' },
  'primera division': { code: 'esp.1', sport: 'soccer' },
  'serie a': { code: 'ita.1', sport: 'soccer' },
  'italian serie a': { code: 'ita.1', sport: 'soccer' },
  bundesliga: { code: 'ger.1', sport: 'soccer' },
  'german bundesliga': { code: 'ger.1', sport: 'soccer' },
  'ligue 1': { code: 'fra.1', sport: 'soccer' },
  'french ligue 1': { code: 'fra.1', sport: 'soccer' },
  'champions league': { code: 'uefa.champions', sport: 'soccer' },
  'uefa champions league': { code: 'uefa.champions', sport: 'soccer' },
  ucl: { code: 'uefa.champions', sport: 'soccer' },
  'europa league': { code: 'uefa.europa', sport: 'soccer' },
  'uefa europa league': { code: 'uefa.europa', sport: 'soccer' },
  eredivisie: { code: 'ned.1', sport: 'soccer' },
  'primeira liga': { code: 'por.1', sport: 'soccer' },
  'super lig': { code: 'tur.1', sport: 'soccer' },
  'turkish super lig': { code: 'tur.1', sport: 'soccer' },
  'scottish premiership': { code: 'sco.1', sport: 'soccer' },
  mls: { code: 'usa.1', sport: 'soccer' },
  'major league soccer': { code: 'usa.1', sport: 'soccer' },
  'liga mx': { code: 'mex.1', sport: 'soccer' },
  brasileirao: { code: 'bra.1', sport: 'soccer' },
  // Basketball
  nba: { code: 'nba', sport: 'basketball' },
  wnba: { code: 'wnba', sport: 'basketball' },
  ncaa: { code: 'ncaa', sport: 'basketball' },
  'college basketball': { code: 'ncaa', sport: 'basketball' },
  'march madness': { code: 'ncaa', sport: 'basketball' },
  euroleague: { code: 'euroleague', sport: 'basketball' },
};

module.exports = {
  PATH_SEPARATORS,
  NOISE_SEGMENTS,
  DOMAIN_PATTERNS,
  GENERIC_PATTERNS,
  SPORT_HINTS,
  AMERICAN_FOOTBALL_MARKERS,
  LEAGUE_HINTS,
};
