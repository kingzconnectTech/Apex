/**
 * live/linkParser.js
 *
 * Phase 1 — identify the game from the TEXT of a pasted link.
 *
 * It reads the URL string only: no network request is ever made to the
 * bookmaker (or anyone else). The host, path, query and hash are scanned for
 * team names, a sport and a league hint; the rules that describe which shapes
 * we accept live in ./linkPatterns.js and the numbers in ./config.js.
 *
 * Output (see parseLink):
 *   { recognised, sport, league_hint, home_raw, away_raw,
 *     home_resolved, away_resolved, confidence, parse_notes,
 *     matched_rule, reason, manual_entry_required }
 *
 * Never guesses: if the teams or the sport cannot be established honestly the
 * result is `recognised: false` with a reason and `manual_entry_required: true`.
 */

const CONFIG = require('./config');
const {
  PATH_SEPARATORS,
  NOISE_SEGMENTS,
  DOMAIN_PATTERNS,
  GENERIC_PATTERNS,
  SPORT_HINTS,
  AMERICAN_FOOTBALL_MARKERS,
  LEAGUE_HINTS,
} = require('./linkPatterns');
const {
  normalizeKey,
  lookupTeam,
  splitGluedSlug,
} = require('./teamNormalize');

const CFG = CONFIG.linkParser;
const SUPPORTED_SPORTS = CONFIG.live.supportedSports;

/** Reverse map: ESPN league code -> { code, sport }. */
const LEAGUE_BY_CODE = Object.values(LEAGUE_HINTS).reduce((acc, hint) => {
  if (!acc[hint.code]) acc[hint.code] = { code: hint.code, sport: hint.sport };
  return acc;
}, {});

/* ------------------------------------------------------------------ helpers */

/** Query-parameter keys compare punctuation-free: 'home-team' -> 'hometeam'. */
function paramKey(k) {
  return String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Word-boundary token test on a space-normalised string. */
function containsToken(text, token) {
  const re = new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, 'i');
  return re.test(text);
}

function lettersCount(s) {
  const m = String(s || '').match(/[a-z]/gi);
  return m ? m.length : 0;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function capNotes(notes) {
  const arr = (notes || []).filter(Boolean).map(String);
  return arr.length > CFG.maxNotes ? arr.slice(0, CFG.maxNotes) : arr;
}

function decodeSeg(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function toUrl(raw) {
  try {
    return new URL(raw);
  } catch {
    /* fall through */
  }
  try {
    return new URL('https://' + String(raw).replace(/^\/+/, ''));
  } catch {
    return null;
  }
}

function isNoise(seg) {
  const low = String(seg || '').toLowerCase().trim();
  if (!low) return true;
  return NOISE_SEGMENTS.has(low) || NOISE_SEGMENTS.has(paramKey(low));
}

/** Drop pure-numeric id tokens (>= idTokenMinDigits) from both ends of a slug. */
function stripIdTokens(slug) {
  const min = CFG.idTokenMinDigits;
  const isId = t => new RegExp(`^\\d{${min},}$`).test(t);
  const tokens = String(slug || '').split('-').filter(Boolean);
  while (tokens.length && isId(tokens[0])) tokens.shift();
  while (tokens.length && isId(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join('-');
}

/* -------------------------------------------------------------- url reading */

function matchDomain(host) {
  for (const [domain, pattern] of Object.entries(DOMAIN_PATTERNS)) {
    if (host === domain || host.endsWith('.' + domain)) return pattern;
  }
  return null;
}

function pathSegments(url) {
  return url.pathname
    .split('/')
    .map(decodeSeg)
    .map(s => s.trim())
    .filter(s => !isNoise(s));
}

function readParams(url) {
  const map = new Map();
  const add = (k, v) => {
    const key = paramKey(k);
    if (!key || v == null) return;
    if (!map.has(key)) map.set(key, String(v).trim());
  };
  url.searchParams.forEach((v, k) => add(k, v));
  const hash = url.hash || '';
  const q = hash.indexOf('?');
  if (q !== -1) {
    new URLSearchParams(hash.slice(q + 1)).forEach((v, k) => add(k, v));
  }
  return map;
}

function firstParam(params, keys) {
  for (const k of keys || []) {
    const v = params.get(paramKey(k));
    if (v) return v;
  }
  return null;
}

/* --------------------------------------------------------------- detection */

function detectSport(text) {
  const hasAmerican = AMERICAN_FOOTBALL_MARKERS.some(m => text.includes(m));
  for (const [token, sport] of Object.entries(SPORT_HINTS)) {
    if (token === 'football') continue; // ambiguous, handled below
    if (containsToken(text, token)) return { sport, ambiguousFootball: false };
  }
  if (containsToken(text, 'football')) {
    if (hasAmerican) return { sport: 'american_football', ambiguousFootball: false };
    return { sport: 'soccer', ambiguousFootball: true };
  }
  if (hasAmerican) return { sport: 'american_football', ambiguousFootball: false };
  return { sport: null, ambiguousFootball: false };
}

function detectLeagueHint(text) {
  const gluedText = text.replace(/\s+/g, '');
  const keys = Object.keys(LEAGUE_HINTS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const norm = normalizeKey(key);
    if (!norm) continue;
    if (containsToken(text, norm)) return { ...LEAGUE_HINTS[key], name: key };
    // Glued form ("premierleague"): only for hints long enough to be safe.
    const gluedNorm = norm.replace(/\s+/g, '');
    if (gluedNorm.length >= 5 && gluedText.includes(gluedNorm)) {
      return { ...LEAGUE_HINTS[key], name: key };
    }
  }
  return null;
}

/** Resolve a league value that came from an explicit query parameter. */
function resolveLeagueValue(value) {
  if (!value) return null;
  const norm = normalizeKey(value);
  if (LEAGUE_HINTS[norm]) return { ...LEAGUE_HINTS[norm], name: norm };
  const code = String(value).trim().toLowerCase();
  if (LEAGUE_BY_CODE[code]) return { ...LEAGUE_BY_CODE[code], name: code };
  return null;
}

/* ------------------------------------------------------------ rule executors */

function splitSegmentOnSeparator(seg, separators) {
  const seps = [...separators].sort((a, b) => b.length - a.length);
  const tokens = seg.split('-');

  for (const sep of seps) {
    const idx = tokens.indexOf(sep);
    if (idx > 0 && idx < tokens.length - 1) {
      const home = stripIdTokens(tokens.slice(0, idx).join('-'));
      const away = stripIdTokens(tokens.slice(idx + 1).join('-'));
      if (home && away) return { home_raw: home, away_raw: away };
    }
  }

  // Glued form ("manutdvschelsea"): only multi-character separators, so a lone
  // "v" never splits a slug by accident.
  const lower = seg.toLowerCase();
  for (const sep of seps) {
    if (sep.length < 2) continue;
    const at = lower.indexOf(sep);
    if (at > 0 && at < lower.length - sep.length) {
      const home = stripIdTokens(seg.slice(0, at).replace(/-+$/, ''));
      const away = stripIdTokens(seg.slice(at + sep.length).replace(/^-+/, ''));
      if (home && away) return { home_raw: home, away_raw: away };
    }
  }
  return null;
}

const EXECUTORS = {
  'query-explicit': ({ params, rule }) => {
    const home = firstParam(params, rule.homeKeys);
    const away = firstParam(params, rule.awayKeys);
    if (!home || !away || home === away) return null;
    return {
      home_raw: home,
      away_raw: away,
      sportFromRule: firstParam(params, rule.sportKey),
      leagueFromRule: firstParam(params, rule.leagueKey),
    };
  },

  'query-teams': ({ params, rule }) => {
    const home = firstParam(params, rule.homeKeys);
    const away = firstParam(params, rule.awayKeys);
    if (!home || !away || home === away) return null;
    return {
      home_raw: home,
      away_raw: away,
      sportFromRule: firstParam(params, rule.sportKey),
      leagueFromRule: firstParam(params, rule.leagueKey),
    };
  },

  'path-separator': ({ segments, rule }) => {
    const separators = rule.separators && rule.separators.length
      ? rule.separators
      : PATH_SEPARATORS;
    for (let i = segments.length - 1; i >= 0; i--) {
      const hit = splitSegmentOnSeparator(segments[i], separators);
      if (hit) return hit;
    }
    return null;
  },

  'path-adjacent': ({ segments }, sport) => {
    const segs = segments.map(stripIdTokens).filter(Boolean);
    if (segs.length < 2) return null;
    const home = segs[segs.length - 2];
    const away = segs[segs.length - 1];
    // At least one side must be a known team, otherwise "/foo/bar" would be a
    // false positive.
    if (!lookupTeam(home, sport) && !lookupTeam(away, sport)) return null;
    return { home_raw: home, away_raw: away };
  },

  'path-glued': ({ segments }, sport) => {
    const segs = segments.map(stripIdTokens).filter(Boolean);
    if (!segs.length) return null;
    const split = splitGluedSlug(segs[segs.length - 1], sport, CFG.minTeamSlugLetters);
    if (!split) return null;
    return { home_raw: split.home.label, away_raw: split.away.label };
  },
};

/* ------------------------------------------------------------------ scoring */

function scoreCandidate({ kind, rule, sport, leagueHint, matched, ambiguousFootball }) {
  const c = CFG.confidence;
  let conf = rule.confidence != null ? rule.confidence : c.byKind[kind];
  if (conf == null) conf = c.min;

  if (sport) conf += c.sportKnownBonus;
  if (leagueHint) conf += c.leagueHintBonus;

  if (matched === 2) conf += c.bothTeamsAliasMatchedBonus;
  else if (matched === 1) conf += c.oneTeamAliasMatchedBonus;
  else if (kind === 'path-separator') conf -= c.unresolvedTeamsPenalty;

  // A bare "football" token is ambiguous unless a league hint settles it.
  if (ambiguousFootball && !leagueHint) conf -= c.bareFootballPenalty;

  return clamp(conf, c.min, c.max);
}

/* ------------------------------------------------------------------- results */

function notRecognised(reason, notes, extra = {}) {
  return {
    recognised: false,
    sport: extra.sport || null,
    league_hint: extra.league_hint || null,
    home_raw: extra.home_raw || null,
    away_raw: extra.away_raw || null,
    home_resolved: null,
    away_resolved: null,
    confidence: 0,
    parse_notes: capNotes(notes),
    matched_rule: null,
    reason,
    manual_entry_required: true,
  };
}

/* --------------------------------------------------------------- public API */

/**
 * Parse a pasted link and identify the game from its text alone.
 * @param {string} input raw link as pasted by the user
 */
function parseLink(input) {
  try {
    if (typeof input !== 'string' || !input.trim()) {
      return notRecognised('empty input', ['No link supplied.']);
    }
    const raw = input.trim();
    if (raw.length > CFG.maxUrlLength) {
      return notRecognised('url too long', [
        `Link exceeds the ${CFG.maxUrlLength}-character limit.`,
      ]);
    }
    const url = toUrl(raw);
    if (!url) return notRecognised('unparseable url', ['That is not a recognisable web link.']);

    const host = url.hostname.toLowerCase();
    const domain = matchDomain(host);
    if (domain && domain.unsupported) {
      return notRecognised('unsupported source', [
        domain.note || 'This source cannot be read from the link text.',
      ]);
    }

    const segments = pathSegments(url);
    const params = readParams(url);
    const hintText = normalizeKey(
      `${url.pathname.replace(/[/_-]+/g, ' ')} ${url.search} ${url.hash.replace(/[/_-]+/g, ' ')}`,
    );

    const sportGuess = detectSport(hintText);
    const leagueHint = detectLeagueHint(hintText);
    let sport = sportGuess.sport || (leagueHint ? leagueHint.sport : null);

    if (sport === 'american_football') {
      return notRecognised('unsupported sport', [
        'American football is not a supported sport for live analysis.',
      ]);
    }

    const rules = [...((domain && domain.rules) || []), ...GENERIC_PATTERNS];
    let best = null;

    for (const rule of rules) {
      const exec = EXECUTORS[rule.kind];
      if (!exec) continue;
      const hit = exec({ url, params, segments, rule }, sport);
      if (!hit) continue;

      const homeRaw = String(hit.home_raw || '').trim();
      const awayRaw = String(hit.away_raw || '').trim();
      const notes = [`Matched rule "${rule.id}" (${rule.kind}).`];
      if (rule.note) notes.push(rule.note);

      if (!homeRaw || !awayRaw || homeRaw === awayRaw) continue;
      if (lettersCount(homeRaw) < CFG.minTeamSlugLetters || lettersCount(awayRaw) < CFG.minTeamSlugLetters) {
        notes.push('One side is too short to be a team name.');
        continue;
      }

      // Sport can also come from an explicit query parameter.
      let ruleSport = sport;
      const valueSport = detectSport(normalizeKey(hit.sportFromRule || ''));
      if (!ruleSport && valueSport.sport) ruleSport = valueSport.sport;
      if (ruleSport === 'american_football') continue;

      // League hint: URL text first, then an explicit query parameter.
      let candidateLeague = leagueHint;
      if (!candidateLeague && hit.leagueFromRule) {
        candidateLeague = resolveLeagueValue(hit.leagueFromRule);
        if (candidateLeague) notes.push(`League hint from query: ${candidateLeague.code}.`);
      }

      // Resolve both teams, then let a unanimous alias result supply the sport.
      let homeResolved = lookupTeam(homeRaw, ruleSport);
      let awayResolved = lookupTeam(awayRaw, ruleSport);
      let finalSport = ruleSport;
      if (!finalSport) {
        const sports = new Set(
          [homeResolved && homeResolved.sport, awayResolved && awayResolved.sport].filter(Boolean),
        );
        if (sports.size === 1) finalSport = [...sports][0];
      }
      if (finalSport) {
        homeResolved = lookupTeam(homeRaw, finalSport);
        awayResolved = lookupTeam(awayRaw, finalSport);
      }

      const matched = (homeResolved ? 1 : 0) + (awayResolved ? 1 : 0);
      if (matched) {
        notes.push(
          matched === 2
            ? 'Both teams matched the alias table.'
            : 'One team matched the alias table; the other will be fuzzy-matched in Phase 2.',
        );
      } else {
        notes.push('Neither team is in the alias table; Phase 2 will fuzzy-match.');
      }

      if (!candidateLeague && homeResolved && awayResolved
        && homeResolved.league && homeResolved.league === awayResolved.league
        && finalSport) {
        candidateLeague = { code: homeResolved.league, sport: finalSport, name: homeResolved.league };
      }

      const confidence = scoreCandidate({
        kind: rule.kind,
        rule,
        sport: finalSport,
        leagueHint: candidateLeague,
        matched,
        ambiguousFootball: sportGuess.ambiguousFootball,
      });

      const candidate = {
        recognised: false,
        sport: finalSport && SUPPORTED_SPORTS.includes(finalSport) ? finalSport : null,
        league_hint: candidateLeague || null,
        home_raw: homeRaw,
        away_raw: awayRaw,
        home_resolved: homeResolved,
        away_resolved: awayResolved,
        confidence,
        parse_notes: capNotes(notes),
        matched_rule: rule.id,
        reason: null,
        manual_entry_required: true,
      };

      if (!best || candidate.confidence > best.confidence) best = candidate;
    }

    if (!best) {
      return notRecognised('no teams found', [
        'No team names could be read from the link text.',
        'Enter the teams manually to continue.',
      ]);
    }

    const matched = (best.home_resolved ? 1 : 0) + (best.away_resolved ? 1 : 0);
    // Honest gate: we need either a supported sport or at least one known team.
    if (!best.sport && matched === 0) {
      return notRecognised('ambiguous teams', [
        ...best.parse_notes,
        'The teams could not be disambiguated without a sport.',
      ]);
    }
    if (best.confidence < CFG.tiers.medium) {
      return notRecognised('low confidence', [
        ...best.parse_notes,
        `Confidence ${best.confidence.toFixed(2)} is below the ${CFG.tiers.medium} threshold.`,
      ]);
    }

    best.recognised = true;
    best.manual_entry_required = false;
    return best;
  } catch (err) {
    return notRecognised('parse failed', [
      `Unexpected parse error: ${err && err.message ? err.message : String(err)}`,
    ]);
  }
}

module.exports = {
  parseLink,
  detectSport,
  detectLeagueHint,
  resolveLeagueValue,
  paramKey,
  stripIdTokens,
  splitSegmentOnSeparator,
};
