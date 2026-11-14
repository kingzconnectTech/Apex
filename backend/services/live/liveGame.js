/**
 * live/liveGame.js
 *
 * Phase 3 — assemble a single, honest LiveGame object from a matched fixture
 * (or from user-entered values) and describe how good that data actually is.
 *
 * Two responsibilities:
 *   1. `buildLiveGame` turns a matcher candidate + normalised fixture into the
 *      unified shape every later phase (models, API, UI) consumes, and picks a
 *      `data_tier` from what the provider really gave us.
 *   2. `validateManualEntry` / `buildManualLiveGame` provide the fallback path
 *      when nothing could be matched: the user types the numbers, we validate
 *      them against ./config and label the result "User-entered".
 *
 * Nothing here talks to the network. No tier is ever dressed up above the data
 * that supports it: a missing clock/period downgrades the tier, it is never
 * assumed.
 */

const CONFIG = require('./config');
const { PROVIDERS } = require('../providers/config');
const M = require('./liveMath');

const CFG = CONFIG.liveGame;

/** Source tag used for the manual path; distinct from any provider name. */
const SOURCE_MANUAL = 'manual';

/**
 * Data tiers, ordered from richest to poorest. `tierLabels` in ./config maps
 * these to the exact strings the UI shows.
 */
const TIERS = {
  FULL_LIVE: 'full_live',
  SCORE_TIME_ONLY: 'score_time_only',
  USER_ENTERED: 'user_entered',
};

/** Exact UI label for a tier, or null when the tier is unknown. */
function dataTierLabel(tier) {
  return CFG.tierLabels[tier] || null;
}

function isUsableClock(clock) {
  return typeof clock === 'string' && clock.trim().length > 0;
}

function countLetters(value) {
  const matches = String(value).match(/[A-Za-z]/g);
  return matches ? matches.length : 0;
}

/** Human "updated Ns ago" text. Seconds under a minute, then minutes, then hours. */
function formatAge(seconds) {
  if (seconds < 60) return `updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `updated ${minutes}m ago`;
  return `updated ${Math.floor(minutes / 60)}h ago`;
}

/**
 * Age of a payload relative to `now`.
 * @param {number|null} fetchedAt epoch ms the payload was retrieved
 * @param {number} [now]        epoch ms
 */
function staleness(fetchedAt, now = Date.now()) {
  if (fetchedAt == null || !Number.isFinite(fetchedAt)) {
    return {
      fetched_at: null,
      age_seconds: null,
      is_stale: true,
      updated_label: 'update time unknown',
    };
  }
  const age = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  return {
    fetched_at: new Date(fetchedAt).toISOString(),
    age_seconds: age,
    is_stale: age > CFG.staleAfterSeconds,
    updated_label: formatAge(age),
  };
}

/**
 * Decide the data tier from the fields the provider actually returned.
 *
 * - full_live needs a score AND a usable clock; basketball additionally needs a
 *   period (configurable) because the remaining-points model is period-based.
 * - anything else with provider data degrades to score_time_only.
 * - the manual path is always user_entered.
 */
function decideTier(live) {
  if (live.source === SOURCE_MANUAL) return TIERS.USER_ENTERED;
  const hasScore = live.home_score != null && live.away_score != null;
  const hasClock = isUsableClock(live.clock);
  const hasPeriod = Number(live.period) >= 1;
  const needsPeriod = CFG.requirePeriodForFullLive && live.sport === 'basketball';
  const periodOk = !needsPeriod || hasPeriod;
  return hasScore && hasClock && periodOk ? TIERS.FULL_LIVE : TIERS.SCORE_TIME_ONLY;
}

/** Copy only the fields the rest of the app expects, so provider internals never leak. */
function shapeSide(team) {
  const t = team || {};
  return {
    id: t.id || null,
    name: t.name || '',
    logo: t.logo || null,
    score: t.score != null ? t.score : null,
    record: t.record != null ? t.record : null,
  };
}

/**
 * Build the unified LiveGame object from a matcher candidate.
 *
 * @param {Object} deps
 * @param {Object} deps.candidate  a matcher candidate ({ source, fixture, match_confidence, orientation, home_similarity, away_similarity, match_notes })
 * @param {Object} [deps.parsed]   the parsed link (for display of the requested names)
 * @param {number} [deps.fetchedAt] epoch ms the provider payload was read
 * @param {number} [deps.now]       epoch ms "now"
 */
function buildLiveGame({ candidate, parsed = null, fetchedAt = Date.now(), now = Date.now() } = {}) {
  if (!candidate || !candidate.fixture) {
    throw new Error('buildLiveGame requires a matched candidate containing a fixture.');
  }
  const fx = candidate.fixture;
  const f = fx.fixture || {};
  const sport = fx.sport || null;

  const live = {
    source: candidate.source,
    sport,
    home_score: fx.homeTeam ? fx.homeTeam.score : null,
    away_score: fx.awayTeam ? fx.awayTeam.score : null,
    clock: f.clock || null,
    period: Number(f.period) || 0,
  };
  const tier = decideTier(live);

  const status = f.status || 'scheduled';
  return {
    game_id: `${candidate.source}:${f.id}`,
    sport,
    source: candidate.source,
    league: {
      id: (fx.league && fx.league.id) || null,
      name: (fx.league && fx.league.name) || null,
    },
    home: shapeSide(fx.homeTeam),
    away: shapeSide(fx.awayTeam),
    live: {
      status,
      is_live: status === 'live',
      clock: f.clock || null,
      period: Number(f.period) || 0,
      raw_status: f.rawStatus || null,
    },
    schedule: {
      kickoff: f.date || null,
      kickoff_ts: f.timestamp || null,
      venue: f.venue || null,
    },
    data_tier: tier,
    data_tier_label: dataTierLabel(tier),
    freshness: staleness(fetchedAt, now),
    match: {
      confidence: candidate.match_confidence != null ? candidate.match_confidence : null,
      orientation: candidate.orientation || 'direct',
      home_similarity: candidate.home_similarity != null ? candidate.home_similarity : null,
      away_similarity: candidate.away_similarity != null ? candidate.away_similarity : null,
      notes: candidate.match_notes || [],
    },
    // Names as written in the pasted link, when we have them, so the UI can show
    // exactly what the user asked for even if the fixture is oriented the other way.
    link: parsed && parsed.home_raw
      ? { home: parsed.home_raw, away: parsed.away_raw || null }
      : null,
    manual: false,
  };
}

/* ------------------------------------------------------------- manual entry */

function asInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

/** Recognised statuses for a hand-typed game. */
const MANUAL_STATUSES = ['live', 'scheduled', 'finished'];

/**
 * The per-sport rules a hand-typed game is checked against, falling back to the
 * global manual limits for a sport we have no specific rules for.
 */
function sportRules(sport) {
  const m = CFG.manual;
  const s = (m.sports && m.sports[sport]) || {};
  const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  return {
    maxScore: num(s.maxScore, m.maxScore),
    maxPeriods: num(s.maxPeriods, m.maxPeriod),
    regulationMinutes: num(s.regulationMinutes, null),
    halfLengthMinutes: num(s.halfLengthMinutes, null),
    maxStoppageMinutes: num(s.maxStoppageMinutes, 0),
    maxPeriodMinutes: num(s.maxPeriodMinutes, null),
    requirePeriodWhenLive: s.requirePeriodWhenLive === true,
  };
}

/**
 * Reject a score/time combination that could not physically be happening.
 * Only called once the clock itself has been recognised, so a format error is
 * never reported twice.
 */
function checkConsistency({ sport, rules, status, period, clockParsed, errors }) {
  const live = status === 'live';

  if (sport === 'basketball') {
    if (live && rules.requirePeriodWhenLive && !(period >= 1)) {
      errors.push('basketball needs the period (1 or more) for a live game');
    }
    // A "mm:ss" clock counts remaining time inside a period, so it can never be
    // longer than the longest period. "7:24" is fine; "90:00" is not.
    if (clockParsed && clockParsed.format === 'mm:ss'
      && rules.maxPeriodMinutes != null
      && clockParsed.minutes > rules.maxPeriodMinutes) {
      errors.push(`the clock cannot be longer than ${rules.maxPeriodMinutes} minutes in a basketball period`);
    }
    return;
  }

  if (sport === 'soccer') {
    if (rules.regulationMinutes == null) return;
    const fullTime = rules.regulationMinutes + rules.maxStoppageMinutes;
    if (clockParsed && clockParsed.format === 'half') {
      if (clockParsed.minutes > fullTime) {
        errors.push('the clock is past the end of a football match');
      } else if (period === 1 && rules.halfLengthMinutes != null
        && clockParsed.minutes > rules.halfLengthMinutes + rules.maxStoppageMinutes) {
        errors.push('the clock does not match period 1');
      } else if (period === 2 && rules.halfLengthMinutes != null
        && (clockParsed.minutes < rules.halfLengthMinutes || clockParsed.minutes > fullTime)) {
        errors.push('the clock does not match period 2');
      }
    }
  }
}

/**
 * Validate a user-entered live game. Returns the sanitised value plus every
 * reason it was rejected — never a silent coercion.
 *
 * @param {Object} input { sport, home_name, away_name, home_score, away_score, period, clock, status }
 */
function validateManualEntry(input = {}) {
  const errors = [];
  const m = CFG.manual;

  const sport = typeof input.sport === 'string' ? input.sport.trim().toLowerCase() : '';
  if (!sport) errors.push('sport is required');
  else if (!CONFIG.live.supportedSports.includes(sport)) {
    errors.push(`sport "${sport}" is not supported`);
  }
  const rules = sportRules(sport);

  const names = {};
  for (const side of ['home', 'away']) {
    const raw = input[`${side}_name`];
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name) {
      errors.push(`${side} team name is required`);
    } else if (name.length > m.maxNameLength) {
      errors.push(`${side} team name is longer than ${m.maxNameLength} characters`);
    } else if (countLetters(name) < m.minNameLetters) {
      errors.push(`${side} team name needs at least ${m.minNameLetters} letters`);
    }
    names[side] = name;
  }
  if (names.home && names.away && names.home.toLowerCase() === names.away.toLowerCase()) {
    errors.push('home and away teams must be different');
  }

  const status = typeof input.status === 'string' && input.status.trim()
    ? input.status.trim().toLowerCase()
    : 'live';
  if (!MANUAL_STATUSES.includes(status)) {
    errors.push(`status must be one of ${MANUAL_STATUSES.join(', ')}`);
  }
  const live = status === 'live';
  const needsScore = status === 'live' || status === 'finished';

  const scores = {};
  for (const side of ['home', 'away']) {
    const value = asInteger(input[`${side}_score`]);
    if (Number.isNaN(value)) {
      errors.push(`${side} score must be a whole number`);
    } else if (value != null && (value < 0 || value > rules.maxScore)) {
      errors.push(`${side} score must be between 0 and ${rules.maxScore}`);
    } else if (value == null && needsScore) {
      errors.push(`${side} score is required for a ${status} game`);
    } else if (!live && value != null && value !== 0) {
      errors.push(`${side} score must be 0 or blank before kick-off`);
    }
    scores[side] = Number.isNaN(value) ? null : value;
  }

  const period = asInteger(input.period);
  if (Number.isNaN(period)) {
    errors.push('period must be a whole number');
  } else if (period != null && (period < 0 || period > rules.maxPeriods)) {
    errors.push(`period must be between 0 and ${rules.maxPeriods}`);
  }

  let clock = input.clock;
  let clockParsed = null;
  if (clock != null && clock !== '') {
    clock = String(clock).trim();
    const re = new RegExp(m.clockPattern);
    clockParsed = re.test(clock) ? M.parseClock(clock) : null;
    if (!clockParsed) {
      errors.push('clock format is not recognised');
      clock = null;
    }
  } else {
    clock = null;
  }

  if (clockParsed) {
    checkConsistency({ sport, rules, status, period, clockParsed, errors });
  }
  // A clock with no period cannot be placed in a game for either sport.
  if (clockParsed && status !== 'scheduled' && !(period >= 1)) {
    errors.push('a clock was given without a period');
  }

  return {
    valid: errors.length === 0,
    errors,
    value: errors.length === 0
      ? {
        sport,
        status,
        home_name: names.home,
        away_name: names.away,
        home_score: scores.home,
        away_score: scores.away,
        period: period == null ? null : period,
        clock,
      }
      : null,
  };
}

/**
 * Build a LiveGame object from user-entered values.
 * Returns `{ ok, game, errors }` — on failure `game` is null and `errors` lists
 * every problem, so the caller can surface them instead of guessing.
 */
function buildManualLiveGame(input = {}, { now = Date.now() } = {}) {
  const check = validateManualEntry(input);
  if (!check.valid) return { ok: false, game: null, errors: check.errors };

  const v = check.value;
  const tier = TIERS.USER_ENTERED;
  const live = v.status === 'live';

  return {
    ok: true,
    errors: [],
    game: {
      game_id: null,
      sport: v.sport,
      source: SOURCE_MANUAL,
      league: { id: null, name: null },
      home: { id: null, name: v.home_name, logo: null, score: v.home_score, record: null },
      away: { id: null, name: v.away_name, logo: null, score: v.away_score, record: null },
      live: {
        status: v.status,
        is_live: live,
        clock: v.clock,
        period: v.period || 0,
        raw_status: null,
      },
      schedule: { kickoff: null, kickoff_ts: null, venue: null },
      data_tier: tier,
      data_tier_label: dataTierLabel(tier),
      freshness: staleness(now, now),
      match: {
        confidence: null,
        orientation: 'direct',
        home_similarity: null,
        away_similarity: null,
        notes: ['Values entered by the user; not verified against a provider.'],
      },
      link: null,
      manual: true,
    },
  };
}

module.exports = {
  buildLiveGame,
  buildManualLiveGame,
  validateManualEntry,
  staleness,
  dataTierLabel,
  formatAge,
  TIERS,
  SOURCE_MANUAL,
};
