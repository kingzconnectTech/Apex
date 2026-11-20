/**
 * live/liveStats.js
 *
 * Live Statistics Engine — normalises provider match statistics into one
 * Apex structure for the prediction engine.
 *
 * Sources:
 *   - ESPN match summary `boxscore.teams[].statistics[]` (the only feed
 *     Apex currently has that exposes real in-match soccer stats).
 *   - LiveScore / Flashscore list feeds provide score+clock only; they are
 *     score sources, not statistics sources. A future authorised adapter
 *     can feed `normalizeStats` directly without touching the model.
 *
 * Rules this module enforces:
 *   - missing fields stay `null`, never 0;
 *   - every stat block carries `fetched_at` and a staleness verdict;
 *   - home/away assignment comes from the provider's own `homeAway` flag,
 *     never from array order;
 *   - `dataQuality()` reports how much usable evidence arrived.
 */

const liveContext = require('./liveContext');
const CONFIG = require('./config');

const CTX = (CONFIG.liveApi && CONFIG.liveApi.context) || {};
const STALE_MS = CTX.statsStaleMs || 5 * 60 * 1000;

/* ESPN statistic name -> Apex field. Names are the `name` values ESPN
 * returns inside boxscore.teams[].statistics[]. */
const STAT_MAP = {
  possessionPct: 'possession_pct',
  totalShots: 'shots',
  shotsOnTarget: 'shots_on_target',
  blockedShots: 'shots_blocked',
  wonCorners: 'corners',
  yellowCards: 'yellow_cards',
  redCards: 'red_cards',
  foulsCommitted: 'fouls',
  offsides: 'offsides',
  saves: 'saves',
  totalTackles: 'tackles',
  interceptions: 'interceptions',
  totalClearance: 'clearances',
  totalPasses: 'passes',
  accuratePasses: 'accurate_passes',
  totalCrosses: 'crosses',
  accurateCrosses: 'accurate_crosses',
  penaltyKickGoals: 'penalty_goals',
  penaltyKickShots: 'penalties',
};

/* Display-order list used by the UI and by dataQuality(). */
const TRACKED_FIELDS = [
  'possession_pct', 'shots', 'shots_on_target', 'shots_blocked', 'corners',
  'yellow_cards', 'red_cards', 'fouls', 'offsides', 'saves', 'tackles',
  'interceptions', 'clearances', 'passes', 'accurate_passes', 'crosses',
  'accurate_crosses', 'penalty_goals', 'penalties',
];

/* Basketball (liveStats.js basketball branch). ESPN's summary boxscore carries
 * the shooting lines as a compound "made-attempted" stat and the counting stats
 * as plain numbers. */
const BALL_PAIR_MAP = {
  'fieldGoalsMade-fieldGoalsAttempted': ['fgm', 'fga'],
  'threePointFieldGoalsMade-threePointFieldGoalsAttempted': ['tpm', 'tpa'],
  'freeThrowsMade-freeThrowsAttempted': ['ftm', 'fta'],
};

const BALL_STAT_MAP = {
  fieldGoalsMade: 'fgm',
  fieldGoalsAttempted: 'fga',
  threePointFieldGoalsMade: 'tpm',
  threePointFieldGoalsAttempted: 'tpa',
  freeThrowsMade: 'ftm',
  freeThrowsAttempted: 'fta',
  offensiveRebounds: 'orb',
  defensiveRebounds: 'drb',
  totalRebounds: 'trb',
  rebounds: 'trb',
  assists: 'ast',
  turnovers: 'tov',
  steals: 'stl',
  blocks: 'blk',
  fouls: 'pf',
  personalFouls: 'pf',
};

/* Display-order list for basketball and dataQuality(). */
const BALL_TRACKED_FIELDS = [
  'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'orb', 'drb', 'trb',
  'ast', 'tov', 'stl', 'blk', 'pf', 'possessions',
];

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace('%', ''));
  return Number.isFinite(n) ? n : null;
}

function emptySide() {
  const side = {};
  for (const f of TRACKED_FIELDS) side[f] = null;
  return side;
}

/**
 * Normalise one provider team-statistics block into Apex's per-side shape.
 * Accepts ESPN `statistics: [{name, displayValue}]` arrays.
 */
function normalizeTeamStats(statistics) {
  const side = emptySide();
  if (!Array.isArray(statistics)) return side;
  const byName = {};
  for (const s of statistics) {
    if (s && s.name != null) byName[s.name] = s.displayValue;
  }
  for (const [espnName, field] of Object.entries(STAT_MAP)) {
    const n = numOrNull(byName[espnName]);
    if (n != null) side[field] = n;
  }
  // Derived fields (only when every input is present).
  if (side.shots != null && side.shots_on_target != null && side.shots_blocked != null) {
    side.shots_off_target = Math.max(0, side.shots - side.shots_on_target - side.shots_blocked);
  } else {
    side.shots_off_target = null;
  }
  if (side.passes != null && side.accurate_passes != null && side.passes > 0) {
    side.pass_accuracy = Math.round((side.accurate_passes / side.passes) * 1000) / 10;
  } else {
    side.pass_accuracy = null;
  }
  side.cards_total = cardTotal(side);
  return side;
}

function cardTotal(side) {
  if (side.yellow_cards == null && side.red_cards == null) return null;
  return (side.yellow_cards || 0) + (side.red_cards || 0);
}

/**
 * Normalise an ESPN summary payload into the Apex stats structure.
 * Returns null when the boxscore has no usable team rows.
 */
function normalizeStats(summary, { fetchedAt = null, source = 'espn' } = {}) {
  const teams = summary && summary.boxscore && Array.isArray(summary.boxscore.teams)
    ? summary.boxscore.teams : [];
  if (!teams.length) return null;

  const home = emptySide();
  const away = emptySide();
  let found = false;
  for (const t of teams) {
    const side = t && t.homeAway === 'home' ? home : t && t.homeAway === 'away' ? away : null;
    if (!side) continue;
    const stats = t.statistics || (t.team && t.team.statistics) || [];
    Object.assign(side, normalizeTeamStats(stats));
    found = true;
  }
  if (!found) return null;

  return {
    source,
    fetched_at: fetchedAt,
    home,
    away,
    totals: {
      shots: addNullable(home.shots, away.shots),
      shots_on_target: addNullable(home.shots_on_target, away.shots_on_target),
      corners: addNullable(home.corners, away.corners),
      cards: addNullable(home.cards_total, away.cards_total),
      possession_home_pct: home.possession_pct,
    },
  };
}

function addNullable(a, b) {
  return a == null && b == null ? null : (a || 0) + (b || 0);
}

/* ------------------------------------------------------- basketball */

function emptyBallSide() {
  const side = {};
  for (const f of BALL_TRACKED_FIELDS) side[f] = null;
  return side;
}

/** Parse an ESPN compound "made-attempted" stat into [made, attempted]. */
function parsePairStat(stat) {
  if (!stat) return null;
  const raw = stat.displayValue != null ? stat.displayValue : stat.value;
  if (raw === undefined || raw === null || raw === '') return null;
  const parts = String(raw).split('-');
  if (parts.length !== 2) return null;
  const made = parseFloat(parts[0]);
  const attempted = parseFloat(parts[1]);
  if (!Number.isFinite(made) || !Number.isFinite(attempted)) return null;
  return [made, attempted];
}

/** Raw display value of a stat, or null when it is a compound "a-b" string. */
function ballScalar(stat) {
  if (!stat) return null;
  const raw = stat.displayValue != null ? stat.displayValue : stat.value;
  if (raw == null || raw === '') return null;
  if (String(raw).includes('-')) return null; // a compound pair, parsed separately
  return numOrNull(raw);
}

/**
 * Normalise one provider basketball team-statistics block into Apex's per-side
 * shape. Accepts ESPN `statistics: [{name, displayValue}]` arrays.
 */
function normalizeBasketballTeamStats(statistics) {
  const side = emptyBallSide();
  if (!Array.isArray(statistics)) return side;
  const byName = {};
  for (const s of statistics) {
    if (s && s.name != null) byName[s.name] = s;
  }
  for (const [name, [madeF, attF]] of Object.entries(BALL_PAIR_MAP)) {
    const pair = parsePairStat(byName[name]);
    if (pair) { side[madeF] = pair[0]; side[attF] = pair[1]; }
  }
  for (const [espnName, field] of Object.entries(BALL_STAT_MAP)) {
    const n = ballScalar(byName[espnName]);
    if (n != null) side[field] = n;
  }
  // Possessions: FGA - ORB + TOV + 0.44 * FTA — the same maths basketball/
  // normalize.js uses — only when every input is present.
  side.possessions = (side.fga != null && side.orb != null && side.tov != null && side.fta != null)
    ? side.fga - side.orb + side.tov + 0.44 * side.fta
    : null;
  return side;
}

/**
 * Normalise an ESPN basketball summary payload into the Apex stats structure.
 * Returns null when the boxscore has no usable team rows.
 */
function normalizeBasketballStats(summary, { fetchedAt = null, source = 'espn' } = {}) {
  const teams = summary && summary.boxscore && Array.isArray(summary.boxscore.teams)
    ? summary.boxscore.teams : [];
  if (!teams.length) return null;

  const home = emptyBallSide();
  const away = emptyBallSide();
  let found = false;
  for (const t of teams) {
    const side = t && t.homeAway === 'home' ? home : t && t.homeAway === 'away' ? away : null;
    if (!side) continue;
    const stats = t.statistics || (t.team && t.team.statistics) || [];
    Object.assign(side, normalizeBasketballTeamStats(stats));
    found = true;
  }
  if (!found) return null;

  return {
    source,
    sport: 'basketball',
    fetched_at: fetchedAt,
    home,
    away,
    totals: {
      // Combined possessions (both teams) — the live model's pace read.
      possessions: addNullable(home.possessions, away.possessions),
      possessions_home: home.possessions,
      possessions_away: away.possessions,
      rebounds: addNullable(home.trb, away.trb),
      turnovers: addNullable(home.tov, away.tov),
      fga: addNullable(home.fga, away.fga),
      orb: addNullable(home.orb, away.orb),
      fta: addNullable(home.fta, away.fta),
    },
  };
}

/* ------------------------------------------------------------- quality */

/** The tracked-field list for a stats block, by sport. */
function trackedFieldsFor(stats) {
  return stats && stats.sport === 'basketball' ? BALL_TRACKED_FIELDS : TRACKED_FIELDS;
}

/** Count of tracked fields populated for BOTH sides (a usable comparison). */
function availableCount(stats) {
  if (!stats) return 0;
  let n = 0;
  for (const f of trackedFieldsFor(stats)) {
    if (stats.home[f] != null && stats.away[f] != null) n += 1;
  }
  return n;
}

/**
 * Data-quality verdict for the prediction payload. Deliberately separate
 * from model confidence: this says how much live evidence exists, not how
 * sure the model is.
 */
function dataQuality(stats, { now = Date.now() } = {}) {
  const fields = trackedFieldsFor(stats);
  const count = availableCount(stats);
  const fetchedAt = stats && stats.fetched_at;
  const ageMs = fetchedAt ? Math.max(0, now - fetchedAt) : null;
  const stale = ageMs != null && ageMs > STALE_MS;
  let level = 'none';
  if (count >= 8) level = stale ? 'stale' : 'high';
  else if (count >= 4) level = stale ? 'stale' : 'medium';
  else if (count > 0) level = 'low';
  return {
    level,
    stats_available: count,
    stats_tracked: fields.length,
    stale,
    age_ms: ageMs,
    updated_label: fetchedAt ? `${Math.round(ageMs / 1000)}s ago` : null,
    note: count === 0
      ? 'No live statistics available — score and clock only.'
      : stale
        ? 'Live statistics may be outdated.'
        : null,
  };
}

/* --------------------------------------------------------- live fetch */

/**
 * Fetch + normalise stats for one game. Returns
 * `{ stats, momentum, data_quality }` — stats may be null, momentum is null
 * when there is not enough snapshot history, and data_quality always
 * describes what actually arrived.
 */
async function getLiveStats({ espn = null, game = null, now = Date.now(), traceId = null } = {}) {
  const empty = { stats: null, momentum: null, data_quality: dataQuality(null, { now }) };
  if (!game || game.manual || !espn) return empty;

  const read = await liveContext.getSummary({ espn, game, now, traceId });
  if (!read || !read.summary) return empty;

  // Sport-shaped normalisation: the ESPN boxscore differs between football and
  // basketball, so the branch produces the fields each model reads (soccer:
  // shots/corners; basketball: possessions/rebounds/turnovers).
  const stats = game.sport === 'basketball'
    ? normalizeBasketballStats(read.summary, { fetchedAt: read.fetched_at, source: game.source || 'espn' })
    : normalizeStats(read.summary, { fetchedAt: read.fetched_at, source: game.source || 'espn' });
  if (!stats) return empty;

  // Momentum is a soccer shots/corners concept; basketball has no equivalent
  // snapshot signal here, so it stays null rather than being invented.
  const momentum = game.sport === 'basketball' ? null : recordAndDiff(game.game_id, {
    home_shots_on_target: stats.home.shots_on_target,
    away_shots_on_target: stats.away.shots_on_target,
    home_corners: stats.home.corners,
    away_corners: stats.away.corners,
  }, now);

  return { stats, momentum, data_quality: dataQuality(stats, { now }) };
}

/* ------------------------------------------------------ momentum state */

/**
 * Per-game snapshot ring for momentum. Kept in-process; each entry is the
 * last N stat snapshots with their timestamps. Momentum is derived ONLY
 * from real deltas between snapshots — never invented.
 */
const snapshotLog = new Map();
const MAX_SNAPSHOTS = 12;
const SNAPSHOT_GAP_MS = 60 * 1000;
const MIN_WINDOW_MS = 3 * 60 * 1000;

function recordAndDiff(gameId, point, now) {
  if (!gameId) return null;
  let log = snapshotLog.get(gameId);
  if (!log) { log = []; snapshotLog.set(gameId, log); }
  // Record at most one snapshot per minute.
  const last = log[log.length - 1];
  if (!last || now - last.at >= SNAPSHOT_GAP_MS) {
    log.push({ at: now, point });
    while (log.length > MAX_SNAPSHOTS) log.shift();
  }
  // Need a baseline at least ~3 minutes old for a meaningful window.
  const base = log.length > 1 ? log[0] : null;
  if (!base || now - base.at < MIN_WINDOW_MS) return null;
  const spanMin = (now - base.at) / 60000;
  const dSotH = delta(point.home_shots_on_target, base.point.home_shots_on_target);
  const dSotA = delta(point.away_shots_on_target, base.point.away_shots_on_target);
  const dShH = delta(point.home_corners, base.point.home_corners);
  const dShA = delta(point.away_corners, base.point.away_corners);
  if (dSotH == null && dSotA == null && dShH == null && dShA == null) return null;
  const sotTotal = (dSotH || 0) + (dSotA || 0);
  return {
    window_minutes: Math.round(spanMin),
    home: { shots_on_target: dSotH, corners: dShH },
    away: { shots_on_target: dSotA, corners: dShA },
    pressure_share_home: sotTotal > 0 ? (dSotH || 0) / sotTotal : null,
    note: 'Deltas over the last recorded snapshots; confidence grows with window length.',
  };
}

function delta(cur, prev) {
  if (cur == null || prev == null) return null;
  return Math.max(0, cur - prev);
}

/** Test/dev helper. */
function resetSnapshots() {
  snapshotLog.clear();
}

module.exports = {
  normalizeStats,
  normalizeTeamStats,
  normalizeBasketballStats,
  normalizeBasketballTeamStats,
  availableCount,
  dataQuality,
  getLiveStats,
  recordAndDiff,
  resetSnapshots,
  TRACKED_FIELDS,
  BALL_TRACKED_FIELDS,
  STAT_MAP,
};
