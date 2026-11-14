/**
 * live/teamMatch.js
 *
 * Phase 2 — fuzzy team-name similarity (pure functions, no I/O).
 *
 * The parser gives us two raw names from a bookmaker link ("man-utd",
 * "Brighton"). The sweep gives us provider names ("Manchester United",
 * "Brighton & Hove Albion"). This module scores how likely those refer to the
 * same team, so the matcher can rank fixtures honestly instead of guessing.
 *
 * Signals, strongest first:
 *   1. identical once normalised                  -> 1.00
 *   2. both resolve to the same alias canonical    -> 1.00
 *   3. one name contains the other as a token run  -> 0.75
 *   4. character-level similarity (typos/spelling) -> up to 0.95
 *   5. word-set overlap (Jaccard)                  -> up to 1.00
 *
 * Nothing here invents a match: an unrelated pair scores near 0.
 */

const { normalizeKey, lookupTeam } = require('./teamNormalize');

function tokens(raw) {
  const k = normalizeKey(raw);
  return k ? k.split(' ') : [];
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const inter = a.filter(t => setB.has(t)).length;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
}

/** True when every token of the shorter list appears, in order, in the longer. */
function containsRun(shorter, longer) {
  if (!shorter.length || shorter.length > longer.length) return false;
  for (let i = 0; i + shorter.length <= longer.length; i++) {
    let ok = true;
    for (let j = 0; j < shorter.length; j++) {
      if (longer[i + j] !== shorter[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

function levRatio(a, b) {
  const max = Math.max(a.length, b.length);
  return max ? 1 - levenshtein(a, b) / max : 0;
}

/**
 * Similarity of two team names in [0, 1].
 * @param {string} a
 * @param {string} b
 * @param {string|null} [sport] used to disambiguate aliases ("spurs")
 */
function teamSimilarity(a, b, sport = null) {
  const ka = normalizeKey(a);
  const kb = normalizeKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;

  const ca = lookupTeam(a, sport);
  const cb = lookupTeam(b, sport);
  if (ca && cb && ca.canonical === cb.canonical) return 1;

  const ta = tokens(a);
  const tb = tokens(b);

  let best = jaccard(ta, tb);
  if (containsRun(ta, tb) || containsRun(tb, ta)) best = Math.max(best, 0.75);
  best = Math.max(best, levRatio(ka, kb) * 0.95);

  return Math.min(1, best);
}

/**
 * Score one provider fixture against the parsed names, in both orientations.
 *
 * @param {{home_raw:string, away_raw:string, sport:string|null}} parsed
 * @param {Object} fixture normalised fixture (normalizeFixtureESPN / PitchAPI)
 * @returns {{score:number, orientation:'direct'|'swapped',
 *            home_similarity:number, away_similarity:number,
 *            home_name:string, away_name:string}}
 *   `score` is 0 when either side fails the minimum similarity, so a one-sided
 *   match never becomes a candidate.
 */
function scoreFixture(parsed, fixture, minSideSimilarity = 0) {
  const sport = parsed.sport || null;
  const fxHome = fixture.homeTeam?.name || '';
  const fxAway = fixture.awayTeam?.name || '';

  const directHome = teamSimilarity(parsed.home_raw, fxHome, sport);
  const directAway = teamSimilarity(parsed.away_raw, fxAway, sport);
  const swapHome = teamSimilarity(parsed.home_raw, fxAway, sport);
  const swapAway = teamSimilarity(parsed.away_raw, fxHome, sport);

  const direct = (directHome + directAway) / 2;
  const swapped = (swapHome + swapAway) / 2;

  const useSwapped = swapped > direct;
  const homeSim = useSwapped ? swapHome : directHome;
  const awaySim = useSwapped ? swapAway : directAway;

  const passes = homeSim >= minSideSimilarity && awaySim >= minSideSimilarity;

  return {
    score: passes ? (homeSim + awaySim) / 2 : 0,
    orientation: useSwapped ? 'swapped' : 'direct',
    home_similarity: homeSim,
    away_similarity: awaySim,
    home_name: fxHome,
    away_name: fxAway,
  };
}

module.exports = {
  teamSimilarity,
  scoreFixture,
  tokens,
  jaccard,
  containsRun,
  levenshtein,
  levRatio,
};
