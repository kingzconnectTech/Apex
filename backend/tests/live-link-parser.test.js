/**
 * Phase 1 — link parser + team normaliser unit tests.
 *
 * Covers the 5 generic URL shapes (query-explicit, query-teams,
 * path-separator, path-adjacent, path-glued), sport/league hints, the
 * unsupported-source path, id stripping, ambiguity handling and the honest
 * "not recognised" fallback. Realistic bookmaker-style links throughout.
 */

const {
  parseLink,
  detectSport,
  detectLeagueHint,
  resolveLeagueValue,
  paramKey,
  stripIdTokens,
  splitSegmentOnSeparator,
} = require('../services/live/linkParser');
const {
  normalizeKey,
  lookupTeam,
  canonicalize,
  splitGluedSlug,
} = require('../services/live/teamNormalize');
const CFG = require('../services/live/config');

describe('Team normalisation', () => {
  test('strips accents, punctuation and club suffixes', () => {
    expect(normalizeKey('Atlético Madrid')).toBe('atletico madrid');
    expect(normalizeKey('AFC Bournemouth')).toBe('bournemouth');
    expect(normalizeKey('AS Saint-Etienne')).toBe('as saint etienne');
  });

  test('resolves an alias to the same canonical team as the label', () => {
    expect(canonicalize('man utd', 'soccer')).toBe(canonicalize('Manchester United', 'soccer'));
    expect(lookupTeam('man utd', 'soccer').label).toBe('Manchester United');
  });

  test('sport scoping disambiguates identical nicknames', () => {
    expect(lookupTeam('spurs', 'soccer').label).toBe('Tottenham Hotspur');
    expect(lookupTeam('spurs', 'basketball').label).toBe('San Antonio Spurs');
    expect(lookupTeam('spurs')).toBeNull(); // ambiguous without a sport
  });

  test('splitGluedSlug only fires when both halves are known teams', () => {
    const hit = splitGluedSlug('lakersceltics', null, 3);
    expect(hit.home.label).toBe('Los Angeles Lakers');
    expect(hit.away.label).toBe('Boston Celtics');
    expect(splitGluedSlug('foobarbaz', null, 3)).toBeNull();
  });
});

describe('Parser helpers', () => {
  test('paramKey normalises parameter names', () => {
    expect(paramKey('home-team')).toBe('hometeam');
    expect(paramKey('Team_1')).toBe('team1');
  });

  test('stripIdTokens removes opaque numeric ids from both ends', () => {
    expect(stripIdTokens('chelsea-1234567')).toBe('chelsea');
    expect(stripIdTokens('987654-manchester-united')).toBe('manchester-united');
    expect(stripIdTokens('philadelphia-76ers')).toBe('philadelphia-76ers');
  });

  test('splitSegmentOnSeparator handles hyphen and glued forms', () => {
    expect(splitSegmentOnSeparator('man-utd-vs-chelsea', ['versus', 'vrs', 'vs', 'v']))
      .toEqual({ home_raw: 'man-utd', away_raw: 'chelsea' });
    expect(splitSegmentOnSeparator('manutdvschelsea', ['versus', 'vrs', 'vs', 'v']))
      .toEqual({ home_raw: 'manutd', away_raw: 'chelsea' });
    expect(splitSegmentOnSeparator('denver-nuggets', ['versus', 'vrs', 'vs', 'v'])).toBeNull();
  });

  test('detectLeagueHint maps known competitions', () => {
    expect(detectLeagueHint('premier league').code).toBe('eng.1');
    expect(detectLeagueHint('nba').sport).toBe('basketball');
    expect(detectLeagueHint('nothing here')).toBeNull();
  });

  test('detectSport treats a bare "football" as ambiguous soccer', () => {
    expect(detectSport('football premier league')).toEqual({ sport: 'soccer', ambiguousFootball: true });
    expect(detectSport('nfl football')).toEqual({ sport: 'american_football', ambiguousFootball: false });
    expect(detectSport('basketball nba')).toEqual({ sport: 'basketball', ambiguousFootball: false });
    expect(detectSport('totally unrelated')).toEqual({ sport: null, ambiguousFootball: false });
  });

  test('resolveLeagueValue accepts names and ESPN codes', () => {
    expect(resolveLeagueValue('premier-league').code).toBe('eng.1');
    expect(resolveLeagueValue('eng.2').code).toBe('eng.2');
    expect(resolveLeagueValue('made-up-league')).toBeNull();
  });
});

describe('Shape 1 — query-explicit (home/away parameters)', () => {
  const url = 'https://www.example-sports.com/live?home=Manchester%20United&away=Chelsea&sport=football';

  test('identifies both teams, the sport and a high confidence', () => {
    const r = parseLink(url);
    expect(r.recognised).toBe(true);
    expect(r.matched_rule).toBe('generic-query-explicit');
    expect(r.sport).toBe('soccer');
    expect(r.home_raw).toBe('Manchester United');
    expect(r.away_raw).toBe('Chelsea');
    expect(r.home_resolved.label).toBe('Manchester United');
    expect(r.away_resolved.label).toBe('Chelsea');
    expect(r.confidence).toBeGreaterThanOrEqual(CFG.linkParser.tiers.high);
    expect(r.manual_entry_required).toBe(false);
  });
});

describe('Shape 2 — query-teams (numbered parameters)', () => {
  const url = 'https://book.example.com/event?id=123&team1=Arsenal&team2=Liverpool&league=premier-league';

  test('reads team1/team2 and the league hint', () => {
    const r = parseLink(url);
    expect(r.recognised).toBe(true);
    expect(r.matched_rule).toBe('generic-query-teams');
    expect(r.sport).toBe('soccer');
    expect(r.league_hint.code).toBe('eng.1');
    expect(r.home_resolved.label).toBe('Arsenal');
    expect(r.away_resolved.label).toBe('Liverpool');
  });
});

describe('Shape 3 — path-separator (-v-/-vs- slug)', () => {
  test('splits a hyphenated -vs- slug and drops a trailing numeric id', () => {
    const r = parseLink('https://www.example.com/football/premier-league/manchester-united-vs-chelsea-1234567');
    expect(r.recognised).toBe(true);
    expect(r.matched_rule).toBe('generic-path-separator');
    expect(r.sport).toBe('soccer');
    expect(r.league_hint.code).toBe('eng.1');
    expect(r.home_resolved.label).toBe('Manchester United');
    expect(r.away_resolved.label).toBe('Chelsea');
    expect(r.confidence).toBeGreaterThanOrEqual(CFG.linkParser.tiers.high);
  });

  test('splits a separator-less glued slug (manutdvschelsea)', () => {
    const r = parseLink('https://example.com/football/manutdvschelsea');
    expect(r.recognised).toBe(true);
    expect(r.home_resolved.label).toBe('Manchester United');
    expect(r.away_resolved.label).toBe('Chelsea');
  });

  test('a -v- pair of unknown teams is recognised but not claimed as high confidence', () => {
    const r = parseLink('https://example.com/basketball/nba/foo-vs-bar');
    expect(r.recognised).toBe(true);
    expect(r.sport).toBe('basketball');
    expect(r.home_resolved).toBeNull();
    expect(r.confidence).toBeLessThan(CFG.linkParser.tiers.high);
  });
});

describe('Shape 4 — path-adjacent (two Consecutive segments)', () => {
  const url = 'https://bet.example.com/nba/los-angeles-lakers/boston-celtics';

  test('treats the last two segments as the two teams', () => {
    const r = parseLink(url);
    expect(r.recognised).toBe(true);
    expect(r.matched_rule).toBe('generic-path-adjacent');
    expect(r.sport).toBe('basketball');
    expect(r.home_resolved.label).toBe('Los Angeles Lakers');
    expect(r.away_resolved.label).toBe('Boston Celtics');
  });
});

describe('Shape 5 — path-glued (single glued slug)', () => {
  test('splits the glued slug using the alias table', () => {
    const r = parseLink('https://example.com/lakersceltics');
    expect(r.recognised).toBe(true);
    expect(r.matched_rule).toBe('generic-path-glued');
    expect(r.sport).toBe('basketball'); // inferred from the two resolved teams
    expect(r.home_resolved.label).toBe('Los Angeles Lakers');
    expect(r.away_resolved.label).toBe('Boston Celtics');
  });
});

describe('Sport hint inferred from the path', () => {
  test('reads nba as basketball and keeps a medium-high confidence', () => {
    const r = parseLink('https://x.example.com/basketball/nba/phoenix-suns-vs-denver-nuggets');
    expect(r.recognised).toBe(true);
    expect(r.sport).toBe('basketball');
    expect(r.league_hint.code).toBe('nba');
    expect(r.home_resolved.label).toBe('Phoenix Suns');
    expect(r.away_resolved.label).toBe('Denver Nuggets');
  });
});

describe('Honest failures (never a guess)', () => {
  test('hash-routed source is reported as unsupported', () => {
    const r = parseLink('https://www.bet365.com/#/AC/B18/C1/D1/E1/F1/');
    expect(r.recognised).toBe(false);
    expect(r.reason).toBe('unsupported source');
    expect(r.manual_entry_required).toBe(true);
    expect(r.parse_notes.length).toBeGreaterThan(0);
  });

  test('a plain homepage yields "no teams found"', () => {
    const r = parseLink('https://example.com/');
    expect(r.recognised).toBe(false);
    expect(r.reason).toBe('no teams found');
    expect(r.manual_entry_required).toBe(true);
  });

  test('a near-miss with unknown segments is not mistaken for teams', () => {
    const r = parseLink('https://example.com/foo/bar');
    expect(r.recognised).toBe(false);
    expect(r.manual_entry_required).toBe(true);
  });

  test('ambiguous nicknames without a sport are refused rather than guessed', () => {
    const r = parseLink('https://example.com/wolves-vs-spurs');
    expect(r.recognised).toBe(false);
    expect(r.reason).toBe('ambiguous teams');
    expect(r.manual_entry_required).toBe(true);
  });

  test('american football is refused as unsupported', () => {
    const r = parseLink('https://example.com/nfl/chiefs-vs-eagles');
    expect(r.recognised).toBe(false);
    expect(r.reason).toBe('unsupported sport');
  });

  test('empty and non-string inputs are refused', () => {
    expect(parseLink('').reason).toBe('empty input');
    expect(parseLink('   ').reason).toBe('empty input');
    expect(parseLink(null).reason).toBe('empty input');
  });

  test('an over-long link is refused', () => {
    const long = 'https://example.com/' + 'a'.repeat(CFG.linkParser.maxUrlLength + 10);
    expect(parseLink(long).reason).toBe('url too long');
  });

  test('a non-url string is refused as unparseable', () => {
    expect(parseLink('not a link at all').reason).toBe('unparseable url');
  });
});

describe('Result shape contract', () => {
  const url = 'https://www.example-sports.com/live?home=Manchester%20United&away=Chelsea&sport=football';

  test('always returns the documented keys and a capped notes array', () => {
    const r = parseLink(url);
    for (const key of [
      'recognised', 'sport', 'league_hint', 'home_raw', 'away_raw',
      'home_resolved', 'away_resolved', 'confidence', 'parse_notes',
      'matched_rule', 'reason', 'manual_entry_required',
    ]) {
      expect(r).toHaveProperty(key);
    }
    expect(Array.isArray(r.parse_notes)).toBe(true);
    expect(r.parse_notes.length).toBeLessThanOrEqual(CFG.linkParser.maxNotes);
    expect(r.recognised).toBe(true);
    expect(r.reason).toBeNull();
  });

  test('parsing is pure — the same input twice gives the same result', () => {
    expect(parseLink(url)).toEqual(parseLink(url));
  });
});
