/**
 * live/teamNormalize.js
 *
 * Phase 1 — team-name normalisation and alias lookup (pure functions, no I/O).
 *
 * Wraps providers/normalizer._normalizeTeamName so the link parser, the ESPN
 * provider and the Pitch provider all agree on what counts as "the same name":
 * lowercase, accents stripped, punctuation removed, club suffixes
 * (fc/cf/sc/ac/if/sk/bk/afc) dropped.
 *
 * The alias *data* lives in ./teamAliases.js; this file turns it into an index
 * and answers lookups. Sport scoping is deliberate: "spurs" is Tottenham
 * Hotspur in soccer and the San Antonio Spurs in basketball, so a lookup that
 * cannot be resolved by sport returns null instead of guessing.
 */

const { _normalizeTeamName } = require('../providers/normalizer');
const { TEAMS } = require('./teamAliases');

/** Canonical normalised key for a name ("Manchester Utd" -> "manchester utd"). */
function normalizeKey(raw) {
  return _normalizeTeamName(raw).replace(/\s+/g, ' ').trim();
}

/** Same key with all whitespace removed, for glued-slug matching ("manutd"). */
function compactKey(raw) {
  return normalizeKey(raw).replace(/\s+/g, '');
}

function buildIndex(teamsBySport) {
  const bySport = {};
  const bySportCompact = {};
  const byCanonical = {};
  for (const [sport, list] of Object.entries(teamsBySport)) {
    bySport[sport] = bySport[sport] || {};
    bySportCompact[sport] = bySportCompact[sport] || {};
    for (const team of list) {
      const canonical = normalizeKey(team.label);
      if (!canonical) continue;
      const entry = {
        canonical,
        label: team.label,
        league: team.league || null,
        sport,
      };
      byCanonical[canonical] = entry;
      bySport[sport][canonical] = entry;
      bySportCompact[sport][compactKey(team.label)] = entry;
      for (const alias of team.aliases || []) {
        const k = normalizeKey(alias);
        if (k && !bySport[sport][k]) bySport[sport][k] = entry;
        const ck = compactKey(alias);
        if (ck && !bySportCompact[sport][ck]) bySportCompact[sport][ck] = entry;
      }
    }
  }
  return { bySport, bySportCompact, byCanonical };
}

const INDEX = buildIndex(TEAMS);

function fromSport(sport, key, compact) {
  const exact = INDEX.bySport[sport];
  const glued = INDEX.bySportCompact[sport];
  if (exact && exact[key]) return exact[key];
  if (glued && glued[compact]) return glued[compact];
  return null;
}

/**
 * Resolve a raw name against the alias table.
 *
 * @param {string} raw            raw team name / slug from the link
 * @param {string|null} [sport]   'soccer' | 'basketball' to disambiguate
 * @returns {{canonical:string,label:string,league:string|null,sport:string}|null}
 *   null when the name is unknown, or ambiguous across sports and no sport given.
 */
function lookupTeam(raw, sport = null) {
  const key = normalizeKey(raw);
  if (!key) return null;
  const compact = key.replace(/\s+/g, '');

  if (sport) return fromSport(sport, key, compact) || null;

  const seen = new Map();
  for (const candidate of Object.keys(INDEX.bySport)) {
    const hit = fromSport(candidate, key, compact);
    if (hit) seen.set(hit.canonical, hit);
  }
  if (seen.size === 1) return { ...seen.values().next().value };
  return null; // unknown, or ambiguous (e.g. "spurs", "wolves")
}

/** Canonical key for a raw name, or null when it cannot be resolved. */
function canonicalize(raw, sport = null) {
  const hit = lookupTeam(raw, sport);
  return hit ? hit.canonical : null;
}

/** Display label for a canonical key, or null. */
function labelForCanonical(canonical) {
  const hit = INDEX.byCanonical[canonical];
  return hit ? hit.label : null;
}

/**
 * Split a separator-less glued slug into two known teams.
 * "lakersceltics" -> { home: Los Angeles Lakers, away: Boston Celtics }.
 * Returns null unless BOTH halves resolve to distinct known teams.
 *
 * @param {string} slug
 * @param {string|null} [sport]
 * @param {number} [minLetters]  minimum letters required in each half
 */
function splitGluedSlug(slug, sport = null, minLetters = 3) {
  const compact = String(slug || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
  if (compact.length < minLetters * 2) return null;
  for (let i = minLetters; i <= compact.length - minLetters; i++) {
    const left = lookupTeam(compact.slice(0, i), sport);
    const right = lookupTeam(compact.slice(i), sport);
    if (left && right && left.canonical !== right.canonical) {
      return { home: left, away: right };
    }
  }
  return null;
}

/** Total number of alias keys indexed (handy for diagnostics/tests). */
function aliasCount() {
  return Object.keys(INDEX.bySport).reduce(
    (n, sport) => n + Object.keys(INDEX.bySport[sport]).length,
    0,
  );
}

module.exports = {
  normalizeKey,
  compactKey,
  lookupTeam,
  canonicalize,
  labelForCanonical,
  splitGluedSlug,
  aliasCount,
};
