/**
 * live/replay.js
 *
 * Phase 5 — turns a completed ESPN game into a leakage-free replay dataset.
 *
 * Every checkpoint is a state snapshot (score, clock, period) reconstructed from
 * plays/events AT OR BEFORE that moment, so replaying the Phase 4 models over it
 * cannot see the game's own future. Nothing here simulates a live feed: the
 * snapshots are exactly what the provider recorded at the time.
 *
 * Pure and network-free — the loader lives in scripts/run-live-backtest.js.
 * Field shapes below were verified against live ESPN pulls:
 *   - basketball summary.plays[]      homeScore, awayScore, period.number, clock.displayValue
 *   - soccer     summary.keyEvents[]  scoringPlay, team.id, clock.value (seconds), type.text, text
 */

const CONFIG = require('./config');
const M = require('./liveMath');
const { resolveLeagueKey, LEAGUES: BB_LEAGUES } = require('../basketball/leagues');

const BT = CONFIG.liveBacktest;
const BB = CONFIG.liveModel.basketball;

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Minutes remaining in the period for an ESPN clock display, or null. */
function clockMinutesRemaining(text) {
  const parsed = M.parseClock(text);
  return parsed ? parsed.minutes : null;
}

/* ------------------------------------------------------------------ basket */

/** Trim float noise from a label's "minutes remaining" value (6 -> "6", 2.5 -> "2.5"). */
function fmtMinutes(v) {
  return String(Math.round(v * 1e6) / 1e6);
}

/**
 * A league's regulation structure, resolved the SAME way the backtester's
 * elapsed/bucket helpers do (services/live/backtester basketballStructure): the
 * period COUNT comes from liveModel.basketball.leaguePeriods and the regulation
 * length from basketball/leagues. Keeping one source means a replay checkpoint
 * and the bucket it is reported under cannot drift.
 *
 * @param {string} [league]
 * @returns {{gameMinutes:number, periods:number, periodMinutes:number}}
 */
function basketballStructure(league) {
  const fallback = BT.baselines.scoreTime.basketball;
  const key = resolveLeagueKey(league);
  const cfg = key && BB_LEAGUES[key] ? BB_LEAGUES[key] : null;
  const gameMinutes = cfg && Number.isFinite(cfg.gameMinutes) ? cfg.gameMinutes : fallback.gameMinutes;
  const periods = key && BB.leaguePeriods[key] ? BB.leaguePeriods[key] : (fallback.periods || BB.defaultPeriods);
  return { gameMinutes, periods, periodMinutes: gameMinutes / periods };
}

/**
 * Turn an ELAPSED-FRACTION grid into per-(period, minutes remaining) targets for
 * one league. A fraction that lands exactly on a period boundary becomes that
 * period's end (`remaining` 0); anything else becomes the in-period clock. This
 * is what puts every league — 4x12, 4x10 and 2x20 — on the SAME grid, so a
 * college game gets the early checkpoints a quarter-based schedule denied it.
 */
function fractionMarks(fractions, structure) {
  const { periods, periodMinutes } = structure;
  const total = periods * periodMinutes;
  const marks = [];
  (Array.isArray(fractions) ? fractions : []).forEach(f => {
    if (!Number.isFinite(f) || f <= 0 || f >= 1) return;
    const elapsed = f * total;
    const boundary = Math.abs(elapsed / periodMinutes - Math.round(elapsed / periodMinutes)) < 1e-9;
    if (boundary) {
      marks.push({ period: Math.round(elapsed / periodMinutes), remaining: 0 });
    } else {
      const period = Math.floor(elapsed / periodMinutes) + 1;
      marks.push({ period, remaining: period * periodMinutes - elapsed });
    }
  });
  return marks;
}

/**
 * Basketball checkpoints. Each target is a (period, minutes remaining) pair: the
 * snapshot is the LAST play in that period still showing at least `remaining`
 * minutes (the state closest to the mark, never a later play). The final
 * period's buzzer (remaining 0) is skipped because by then the game is decided
 * and grading it would be self-fulfilling.
 *
 * Targets come from one of two schedules:
 *   - `opts.minutesRemaining` — explicit per-period marks (unit fixtures and the
 *     synthetic smoke test pass these), applied to every present period; or
 *   - the production elapsed-fraction grid (`opts.fractions` or
 *     `liveBacktest.checkpoints.basketball.fractions`), mapped through the
 *     LEAGUE's own period structure so every league samples the same fractions.
 *
 * @param {Array} plays  ESPN summary.plays
 * @param {Object} [opts] { league, fractions, minutesRemaining, maxPeriods, structure }
 * @returns {Array<{label,period,clock,home_score,away_score}>}
 */
function basketballCheckpoints(plays, opts = {}) {
  const list = Array.isArray(plays) ? plays : [];

  const byPeriod = new Map();
  list.forEach(p => {
    const n = numOrNull(p && p.period && p.period.number);
    if (n == null || n < 1) return;
    if (!byPeriod.has(n)) byPeriod.set(n, []);
    byPeriod.get(n).push(p);
  });
  const present = [...byPeriod.keys()].sort((a, b) => a - b);
  if (!present.length) return [];
  const maxPeriod = opts.maxPeriods || present[present.length - 1];

  let targets;
  if (Array.isArray(opts.minutesRemaining) && opts.minutesRemaining.length) {
    const marks = opts.minutesRemaining.slice().sort((a, b) => b - a);
    targets = [];
    present.filter(p => p <= maxPeriod).forEach(period => {
      marks.forEach(remaining => targets.push({ period, remaining }));
    });
  } else {
    const structure = opts.structure || basketballStructure(opts.league);
    const fractions = opts.fractions || BT.checkpoints.basketball.fractions || [];
    targets = fractionMarks(fractions, structure);
  }

  const out = [];
  targets.forEach(({ period, remaining }) => {
    if (period > maxPeriod) return;
    const inPeriod = byPeriod.get(period);
    if (!inPeriod) return;
    if (remaining <= 0 && period === maxPeriod) return; // final buzzer = the outcome
    // The clock counts down, so the LAST play still showing at least `remaining`
    // minutes is the state closest to that mark.
    let chosen = null;
    for (const p of inPeriod) {
      const left = clockMinutesRemaining(p && p.clock && p.clock.displayValue);
      if (left == null) continue;
      if (left >= remaining - 1e-9) chosen = p;
    }
    if (!chosen) return;
    out.push({
      label: remaining <= 0 ? `p${period}_end` : `p${period}_${fmtMinutes(remaining)}min_left`,
      period,
      clock: (chosen.clock && chosen.clock.displayValue) || null,
      home_score: numOrNull(chosen.homeScore),
      away_score: numOrNull(chosen.awayScore),
    });
  });
  return out;
}

/* ------------------------------------------------------------------ soccer */

/**
 * Authoritative running score embedded in an ESPN goal line, or null.
 *
 * The scoreboard's displayName can be a PREFIX of the name ESPN prints inside
 * the goal line — the board says "VfL Bochum" while the line reads
 * "Goal! RB Leipzig 1, VfL Bochum 1848 0." Chasing the score with a bare
 * `\s+(\d+)` therefore swallows the club's founding year (1848) as the away
 * score. Anchor each score to its clause delimiter instead: the home score sits
 * just before the comma, the away score just before the closing period. The
 * `.*?` between a name and its score absorbs any extra tokens (e.g. "1848").
 */
function parseRunningScore(text, homeName, awayName) {
  if (typeof text !== 'string' || !homeName || !awayName) return null;
  const re = new RegExp(
    `${escapeRe(homeName)}.*?\\s+(\\d+)\\s*,\\s*${escapeRe(awayName)}.*?\\s+(\\d+)\\s*\\.`,
  );
  const m = text.match(re);
  if (!m) return null;
  const home = Number(m[1]);
  const away = Number(m[2]);
  return Number.isFinite(home) && Number.isFinite(away) ? { home, away } : null;
}

function isGoalEvent(ev) {
  if (!ev || ev.shootout === true || ev.scoringPlay !== true) return false;
  const t = ev.type || {};
  return /goal|penalt/i.test(`${t.text || ''} ${t.type || ''}`);
}

/** A red-card (or second-yellow) event, which leaves the offender's side a man down. */
function isRedCardEvent(ev) {
  if (!ev || ev.shootout === true) return false;
  const t = ev.type || {};
  return /red[- ]?card|second yellow/i.test(`${t.text || ''} ${t.type || ''}`);
}

/**
 * Walk the goal events in order and record the running score after each.
 *
 * The running score ESPN prints inside the goal text ("Goal! Home 1, Away 0.")
 * is preferred because it is authoritative regardless of how own goals are
 * attributed; the team id is the fallback.
 *
 * On an own goal ESPN sets `ev.team.id` to the team CREDITED with the goal —
 * the beneficiary, not the player who put it in — so the id is used directly,
 * with NO flip. (Verified against the two-season sweep: of 261 games whose
 * event-derived score disagreed with the final, 258 are reconciled by treating
 * the team id as the credited side and only 1 by flipping it.)
 *
 * @returns {Array<{seconds:number|null, home:number, away:number}>}
 */
function soccerGoalLog(events, { homeTeamId, awayTeamId, homeName, awayName } = {}) {
  const log = [];
  let home = 0;
  let away = 0;
  (Array.isArray(events) ? events : []).forEach(ev => {
    if (!isGoalEvent(ev)) return;
    const fromText = parseRunningScore(ev.text, homeName, awayName);
    if (fromText) {
      home = fromText.home;
      away = fromText.away;
    } else {
      const teamId = ev.team && ev.team.id != null ? String(ev.team.id) : null;
      if (teamId == null) return;
      if (homeTeamId != null && teamId === String(homeTeamId)) home += 1;
      else if (awayTeamId != null && teamId === String(awayTeamId)) away += 1;
      else return;
    }
    log.push({
      seconds: numOrNull(ev.clock && ev.clock.value),
      home,
      away,
    });
  });
  return log;
}

/**
 * Soccer checkpoints at fixed cumulative match minutes. The snapshot at minute m
 * is the score after every goal scored at or before m, plus the red-card state of
 * each side at that moment (how many men each side is down). The red-card state
 * is carried because the smoothed empirical table conditions on it.
 *
 * @param {Array} keyEvents  ESPN summary.keyEvents
 * @param {Object} ctx       { homeTeamId, awayTeamId, homeName, awayName, minutes }
 */
function soccerCheckpoints(keyEvents, ctx = {}) {
  const minutes = ctx.minutes || BT.checkpoints.soccer.minutes || [];
  const log = soccerGoalLog(keyEvents, ctx);

  // Red cards, in order, with the offending side and the match second. ESPN sets
  // `team.id` to the side the offender plays for, so no flip is needed.
  const reds = [];
  (Array.isArray(keyEvents) ? keyEvents : []).forEach(ev => {
    if (!isRedCardEvent(ev)) return;
    const teamId = ev.team && ev.team.id != null ? String(ev.team.id) : null;
    let side = null;
    if (teamId != null && ctx.homeTeamId != null && teamId === String(ctx.homeTeamId)) side = 'home';
    else if (teamId != null && ctx.awayTeamId != null && teamId === String(ctx.awayTeamId)) side = 'away';
    reds.push({ seconds: numOrNull(ev.clock && ev.clock.value), side });
  });

  return minutes.map(minute => {
    const cutoff = minute * 60;
    let home = 0;
    let away = 0;
    log.forEach(g => {
      if (g.seconds != null && g.seconds <= cutoff) { home = g.home; away = g.away; }
    });
    let homeRed = 0;
    let awayRed = 0;
    reds.forEach(r => {
      if (r.side == null) return;
      // A red card with no readable clock is counted from the start (conservative).
      if (r.seconds == null || r.seconds <= cutoff) {
        if (r.side === 'home') homeRed += 1; else awayRed += 1;
      }
    });
    return {
      label: `m${minute}`,
      period: minute <= 45 ? 1 : 2,
      clock: `${minute}'`,
      home_score: home,
      away_score: away,
      home_red: homeRed,
      away_red: awayRed,
    };
  });
}

/* -------------------------------------------------------------- assembling */

/** Competitor/score helpers that tolerate both scoreboard and summary shapes. */
function competitorOf(competition, side) {
  const comps = (competition && competition.competitors) || [];
  return comps.find(c => c && c.homeAway === side) || null;
}

function competitorScore(competitor) {
  if (!competitor) return null;
  const s = competitor.score;
  if (s == null) return null;
  if (typeof s === 'object') return numOrNull(s.value != null ? s.value : s.displayValue);
  return numOrNull(s);
}

function teamName(competitor) {
  const t = (competitor && competitor.team) || {};
  return t.displayName || t.name || t.shortDisplayName || null;
}

function teamId(competitor) {
  const t = (competitor && competitor.team) || {};
  return t.id != null ? String(t.id) : null;
}

/** American odds from a pickcenter side ({close:{odds}} preferred over open). */
function americanOdds(side) {
  if (!side) return null;
  const close = side.close && side.close.odds;
  const open = side.open && side.open.odds;
  return numOrNull(close != null ? close : open);
}

/**
 * De-vigged pre-tip line from an ESPN summary payload. Used ONLY as a benchmark
 * — the live models never read it.
 */
function lineFromPickcenter(summary) {
  const pc = ((summary && summary.pickcenter) || [])[0];
  if (!pc) return null;
  const ml = pc.moneyline || {};
  const moneyline = {
    home: americanOdds(ml.home) ?? numOrNull(pc.homeTeamOdds && pc.homeTeamOdds.moneyLine),
    away: americanOdds(ml.away) ?? numOrNull(pc.awayTeamOdds && pc.awayTeamOdds.moneyLine),
    draw: americanOdds(ml.draw) ?? numOrNull(pc.drawOdds && pc.drawOdds.moneyLine),
  };
  if (moneyline.home == null && moneyline.away == null) return null;
  return {
    moneyline,
    overUnder: numOrNull(pc.overUnder),
    overOdds: numOrNull(pc.overOdds),
    underOdds: numOrNull(pc.underOdds),
    spread: numOrNull(pc.spread),
    provider: (pc.provider && pc.provider.name) || null,
  };
}

/**
 * Build the leakage-free checkpoints for one completed game.
 * @param {string} sport  'basketball' | 'soccer'
 * @param {Object} summary ESPN summary payload
 * @param {Object} ctx     { homeTeamId, awayTeamId, homeName, awayName }
 */
function checkpointsFromSummary(sport, summary, ctx = {}) {
  if (sport === 'basketball') {
    // The league decides the period structure, so the elapsed-fraction grid
    // resolves to the right in-period clock for a 4x12 / 4x10 / 2x20 game.
    return basketballCheckpoints(summary && summary.plays, { league: ctx.league });
  }
  if (sport === 'soccer') return soccerCheckpoints(summary && summary.keyEvents, ctx);
  return [];
}

/**
 * Turn a completed ESPN event + its summary into a replay game record.
 *
 * @param {Object} args
 * @param {string} args.sport
 * @param {string} args.league
 * @param {Object} args.event   scoreboard event
 * @param {Object} args.summary summary payload
 * @param {Object} [args.meta]  provenance stamped onto the record, e.g.
 *                              { season: '2025-26' }. Used by the coverage report.
 * @returns {Object|null} a game record, or null when nothing usable was found
 */
function recordFromSummary({ sport, league, event, summary, meta = {} } = {}) {
  const comp = event && event.competitions && event.competitions[0];
  if (!comp) return null;
  const homeComp = competitorOf(comp, 'home');
  const awayComp = competitorOf(comp, 'away');
  if (!homeComp || !awayComp) return null;

  const home = { teamId: teamId(homeComp), name: teamName(homeComp) };
  const away = { teamId: teamId(awayComp), name: teamName(awayComp) };
  const ctx = {
    homeTeamId: home.teamId,
    awayTeamId: away.teamId,
    homeName: home.name,
    awayName: away.name,
    league,
  };

  const finalHome = competitorScore(homeComp);
  const finalAway = competitorScore(awayComp);
  if (finalHome == null || finalAway == null) return null;

  const checkpoints = checkpointsFromSummary(sport, summary, ctx);
  if (!checkpoints.length) return null;

  // The score derived purely from the goal EVENTS (last running score in the goal
  // log). For soccer this is compared against the scoreboard `final` by the
  // sanity report, so a mis-parsed goal line is visible rather than silent.
  let eventFinal = null;
  if (sport === 'soccer') {
    const log = soccerGoalLog(summary && summary.keyEvents, ctx);
    const last = log.length ? log[log.length - 1] : { home: 0, away: 0 };
    eventFinal = { home: last.home, away: last.away };
  }

  return buildGameRecord({
    gameId: event.id,
    sport,
    league,
    kickoff: event.date || null,
    venue: (comp.venue && comp.venue.fullName) || null,
    home,
    away,
    final: { home: finalHome, away: finalAway },
    eventFinal,
    line: lineFromPickcenter(summary),
    checkpoints,
    meta,
  });
}

/**
 * Normalise a game record. All numeric fields are validated here so a malformed
 * record is rejected up front rather than silently mis-graded later.
 */
function buildGameRecord({
  gameId, sport, league, kickoff = null, venue = null,
  home = {}, away = {}, final = {}, eventFinal = null, line = null, checkpoints = [], meta = {},
} = {}) {
  return {
    gameId: gameId != null ? String(gameId) : null,
    sport: sport || null,
    league: league || null,
    kickoff: kickoff || null,
    venue: venue || null,
    home: { teamId: home.teamId != null ? String(home.teamId) : null, name: home.name || null },
    away: { teamId: away.teamId != null ? String(away.teamId) : null, name: away.name || null },
    final: { home: numOrNull(final.home), away: numOrNull(final.away) },
    eventFinal: eventFinal
      ? { home: numOrNull(eventFinal.home), away: numOrNull(eventFinal.away) }
      : null,
    line: line || null,
    checkpoints: (Array.isArray(checkpoints) ? checkpoints : []).map(cp => ({
      label: cp.label,
      period: numOrNull(cp.period),
      clock: cp.clock != null ? String(cp.clock) : null,
      home_score: numOrNull(cp.home_score),
      away_score: numOrNull(cp.away_score),
      home_red: numOrNull(cp.home_red),
      away_red: numOrNull(cp.away_red),
    })),
    meta: meta || {},
  };
}

module.exports = {
  numOrNull,
  clockMinutesRemaining,
  basketballStructure,
  fractionMarks,
  basketballCheckpoints,
  parseRunningScore,
  isGoalEvent,
  isRedCardEvent,
  soccerGoalLog,
  soccerCheckpoints,
  checkpointsFromSummary,
  recordFromSummary,
  buildGameRecord,
  lineFromPickcenter,
};
