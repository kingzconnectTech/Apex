/**
 * basketball/normalize.js
 *
 * Normalises ESPN basketball provider output into the shared internal schema:
 *   Game, Team, Player, BoxScore, TeamForm, Lineup, Injury, Odds.
 *
 * Principles:
 *   - Missing fields stay null (never 0, never fabricated).
 *   - Derived metrics (eFG%, TS%, 3P%, FT%, possessions, ORtg, DRtg) are computed
 *     when the inputs exist, using the LEAGUE's possession constants.
 */

const { getLeagueConfig } = require('./leagues');

const DAY_MS = 24 * 60 * 60 * 1000;

function toNum(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mean(arr) {
  const vals = arr.filter(v => v != null && Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function median(arr) {
  const vals = arr.filter(v => v != null && Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!vals.length) return null;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

function std(arr) {
  const vals = arr.filter(v => v != null && Number.isFinite(v));
  if (vals.length < 2) return null;
  const m = vals.reduce((s, v) => s + v, 0) / vals.length;
  const variance = vals.reduce((s, v) => s + (v - m) * (v - m), 0) / (vals.length - 1);
  return Math.sqrt(variance);
}

function safeRatio(num, den) {
  const n = toNum(num);
  const d = toNum(den);
  if (n == null || d == null || d === 0) return null;
  return n / d;
}

/** Normalise a team identity. */
function normalizeTeam(team) {
  if (!team) return null;
  return {
    id: team.id != null ? String(team.id) : (team.team?.id != null ? String(team.team.id) : null),
    name: team.displayName || team.name || null,
    shortName: team.abbreviation || team.shortDisplayName || null,
    logo: team.logo || team.logos?.[0]?.href || null,
  };
}

/**
 * Normalise + enrich a raw box score.
 * @param {Object} raw - output of EspnProvider.extractBasketballBoxScore
 * @param {Object} leagueCfg
 */
function normalizeBoxScore(raw, leagueCfg) {
  if (!raw) return null;
  const ftWeight = leagueCfg?.ftWeight ?? 0.44;

  const fgm = toNum(raw.fgm);
  const fga = toNum(raw.fga);
  const tpm = toNum(raw.tpm);
  const tpa = toNum(raw.tpa);
  const ftm = toNum(raw.ftm);
  const fta = toNum(raw.fta);
  const orb = toNum(raw.orb);
  const drb = toNum(raw.drb);
  const trb = toNum(raw.trb);
  const tov = toNum(raw.tov);

  const oppFga = toNum(raw.oppFga);
  const oppOrb = toNum(raw.oppOrb);
  const oppTov = toNum(raw.oppTov);
  const oppFta = toNum(raw.oppFta);

  const possessions = (fga != null && orb != null && tov != null && fta != null)
    ? fga - orb + tov + ftWeight * fta
    : null;
  const oppPossessions = (oppFga != null && oppOrb != null && oppTov != null && oppFta != null)
    ? oppFga - oppOrb + oppTov + ftWeight * oppFta
    : null;

  return {
    fgm, fga, tpm, tpa, ftm, fta, orb, drb, trb, ast: toNum(raw.ast), tov,
    stl: toNum(raw.stl), blk: toNum(raw.blk), pf: toNum(raw.pf),
    oppFgm: toNum(raw.oppFgm), oppFga, oppOrb, oppTov, oppFta,
    // Derived
    possessions,
    oppPossessions,
    efgPct: (fgm != null && tpm != null && fga) ? (fgm + 0.5 * tpm) / fga : null,
    tsPct: null, // filled per game where points are known
    threePct: safeRatio(tpm, tpa),
    ftPct: safeRatio(ftm, fta),
  };
}

/**
 * Derive per-game metrics for one team from a raw game-log entry.
 * @param {Object} game - { pf, pa, isHome, date, boxScore, restDays, backToBack, threeInFour, roadTripLength }
 * @param {Object} leagueCfg
 */
function deriveGameMetrics(game, leagueCfg) {
  if (!game) return null;
  const box = normalizeBoxScore(game.boxScore, leagueCfg);
  const pf = toNum(game.pf);
  const pa = toNum(game.pa);

  const possessions = box?.possessions ?? null;
  const oppPossessions = box?.oppPossessions ?? null;

  const ortg = (pf != null && possessions && possessions > 0) ? (pf / possessions) * 100 : null;
  const drtg = (pa != null && oppPossessions && oppPossessions > 0) ? (pa / oppPossessions) * 100 : null;

  const tsPct = (pf != null && box && box.fga != null && box.fta != null && (box.fga + 0.44 * box.fta) > 0)
    ? pf / (2 * (box.fga + 0.44 * box.fta))
    : null;

  return {
    date: game.date || null,
    timestamp: game.timestamp ?? (game.date ? new Date(game.date).getTime() : null),
    eventId: game.eventId ?? null,
    pf,
    pa,
    total: (pf != null && pa != null) ? pf + pa : null,
    margin: (pf != null && pa != null) ? pf - pa : null,
    isHome: game.isHome === true,
    result: game.result ?? (pf != null && pa != null ? (pf > pa ? 'W' : pf < pa ? 'L' : 'D') : null),
    opponentId: game.opponentId ?? null,
    opponentName: game.opponentName ?? null,
    restDays: game.restDays ?? null,
    backToBack: !!game.backToBack,
    threeInFour: !!game.threeInFour,
    roadTripLength: game.roadTripLength ?? null,
    boxScore: box ? { ...box, tsPct } : null,
    possessions,
    ortg,
    drtg,
  };
}

/**
 * Aggregate a set of derived games into descriptive form stats.
 */
function aggregateGames(games) {
  if (!games.length) {
    return {
      sampleSize: 0,
      avgPoints: null, avgPointsAllowed: null, avgTotal: null,
      avgPossessions: null, ortg: null, drtg: null,
      efgPct: null, threePct: null, ftPct: null, tsPct: null,
      stdTotal: null, stdMargin: null,
    };
  }
  return {
    sampleSize: games.length,
    avgPoints: mean(games.map(g => g.pf)),
    avgPointsAllowed: mean(games.map(g => g.pa)),
    avgTotal: mean(games.map(g => g.total)),
    avgPossessions: mean(games.map(g => g.possessions)),
    ortg: mean(games.map(g => g.ortg)),
    drtg: mean(games.map(g => g.drtg)),
    efgPct: mean(games.map(g => g.boxScore?.efgPct)),
    threePct: mean(games.map(g => g.boxScore?.threePct)),
    ftPct: mean(games.map(g => g.boxScore?.ftPct)),
    tsPct: mean(games.map(g => g.boxScore?.tsPct)),
    stdTotal: std(games.map(g => g.total)),
    stdMargin: std(games.map(g => g.margin)),
  };
}

/**
 * Build last-5 / last-10 / season and home/away form from a derived game log.
 * Game log must be newest-first.
 *
 * @param {Array} derivedLog - output of deriveGameMetrics[]
 * @param {Object} [opts]
 * @param {boolean|null} [opts.isHomeContext]
 */
function buildTeamForm(derivedLog, { isHomeContext = null } = {}) {
  const log = Array.isArray(derivedLog) ? derivedLog.filter(Boolean) : [];
  const home = log.filter(g => g.isHome === true);
  const away = log.filter(g => g.isHome === false);

  return {
    season: aggregateGames(log),
    last10: aggregateGames(log.slice(0, 10)),
    last5: aggregateGames(log.slice(0, 5)),
    home: aggregateGames(home),
    away: aggregateGames(away),
    relevant: isHomeContext === true ? aggregateGames(home) : isHomeContext === false ? aggregateGames(away) : null,
    gamesAnalyzed: log.length,
  };
}

/** Split an injury list by team id. */
function splitInjuriesByTeam(injuries, homeTeamId, awayTeamId) {
  const list = Array.isArray(injuries) ? injuries : [];
  const home = [];
  const away = [];
  const other = [];
  list.forEach(inj => {
    const id = inj?.teamId != null ? String(inj.teamId) : null;
    if (id != null && id === String(homeTeamId)) home.push(inj);
    else if (id != null && id === String(awayTeamId)) away.push(inj);
    else other.push(inj);
  });
  return { home, away, other };
}

/**
 * Build lineups. ESPN's summary has no `rosters` array, so projected starters are
 * unavailable — we return confirmed:false with the injured players we do know about.
 */
function buildLineups(injuriesByTeam) {
  return {
    home: { confirmed: false, starters: [], injured: injuriesByTeam?.home || [] },
    away: { confirmed: false, starters: [], injured: injuriesByTeam?.away || [] },
  };
}

/**
 * Build the internal Game object.
 *
 * @param {Object} params
 * @param {Object} params.fixture  - normalised fixture (normalizeFixtureESPN shape)
 * @param {Object} [params.odds]   - output of EspnProvider.extractBasketballOdds
 * @param {Array}  [params.injuries]
 * @param {string} params.league
 */
function normalizeGame({ fixture, odds = null, injuries = [], league }) {
  if (!fixture) return null;
  const leagueCfg = getLeagueConfig(league || fixture?.league?.slug || fixture?.league?.id);
  const injuriesByTeam = splitInjuriesByTeam(
    injuries,
    fixture.homeTeam?.id,
    fixture.awayTeam?.id
  );

  return {
    id: String(fixture.fixture?.id ?? ''),
    league: leagueCfg.key,
    leagueLabel: leagueCfg.label,
    tipoff: fixture.fixture?.date || null,
    tipoffTimestamp: fixture.fixture?.timestamp ?? null,
    status: fixture.fixture?.status || 'scheduled',
    venue: fixture.fixture?.venue || null,
    home: {
      team: normalizeTeam(fixture.homeTeam),
      score: fixture.homeTeam?.score ?? null,
    },
    away: {
      team: normalizeTeam(fixture.awayTeam),
      score: fixture.awayTeam?.score ?? null,
    },
    odds: odds || null,
    injuries: injuriesByTeam,
    lineups: buildLineups(injuriesByTeam),
  };
}

module.exports = {
  DAY_MS,
  toNum,
  mean,
  median,
  std,
  safeRatio,
  normalizeTeam,
  normalizeBoxScore,
  deriveGameMetrics,
  aggregateGames,
  buildTeamForm,
  splitInjuriesByTeam,
  buildLineups,
  normalizeGame,
};
