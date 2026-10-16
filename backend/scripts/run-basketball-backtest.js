#!/usr/bin/env node
/**
 * scripts/run-basketball-backtest.js
 *
 * Runs the basketball walk-forward backtester and prints an honest report.
 *
 * Data sources (in priority order):
 *   1. --dataset=<path.json>  A persisted dataset (see BACKTEST_DATASET_NOTES
 *      below). This is the ONLY way to get a true multi-season (>=3 seasons)
 *      walk-forward, because the ESPN provider methods exposed today take no
 *      season/date-range parameter.
 *   2. --synthetic[=N]        A deterministic synthetic dataset for smoke-testing
 *      the harness end-to-end without network access.
 *   3. default                On-the-fly load from the existing ESPN provider
 *      (current season only — see the limitation note).
 *
 * Usage:
 *   node scripts/run-basketball-backtest.js --synthetic=400 --tune
 *   node scripts/run-basketball-backtest.js --dataset=data/nba-3y.json --tune --out=report.json
 *   node scripts/run-basketball-backtest.js --league=nba --with-odds --max-games=300
 *
 * BACKTEST_DATASET_NOTES
 * ----------------------
 * A dataset is { "league": "nba", "games": [ ... ] } where each game is:
 *   { gameId, tipoff (ISO), league, venue,
 *     home: { teamId, name, score, stats:{fgm,fga,tpm,tpa,ftm,fta,orb,drb,tov,ast,stl,blk,pf} },
 *     away: { teamId, name, score, stats:{...} },
 *     odds:    { total, overOdds, underOdds, spread, homeOdds, awayOdds },
 *     closing: { total, overOdds, underOdds, spread, homeOdds, awayOdds } }
 *
 * IMPORTANT: with the on-the-fly ESPN load we can only capture ONE odds snapshot
 * per game, so `closing` equals `odds`. That makes CLV uninformative (it will be
 * ~0 for every pick) — use a persisted dataset with true opening vs closing lines
 * to get a meaningful closing-line-value benchmark.
 */

const fs = require('fs');
const path = require('path');

const { runBacktest, formatReport, DEFAULT_CANDIDATES } = require('../services/basketball/backtester');
const { getLeagueConfig } = require('../services/basketball/leagues');

// --------------------------------------------------------------------------
// Deterministic synthetic dataset (for smoke tests / demos)
// --------------------------------------------------------------------------

/** mulberry32 — tiny deterministic PRNG. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box score that produces a target number of points at a shared pace. */
function _boxFor(points, possessions, rand) {
  const fta = Math.round(18 + rand() * 8);
  const orb = Math.round(8 + rand() * 6);
  const tov = Math.round(11 + rand() * 6);
  const fga = Math.max(50, Math.round(possessions + orb - tov - 0.44 * fta));
  const fgm = Math.round(fga * (0.40 + rand() * 0.10));
  const tpa = Math.round(30 + rand() * 14);
  const tpm = Math.round(tpa * (0.30 + rand() * 0.12));
  const ftm = Math.max(0, Math.round(fta * (0.70 + rand() * 0.18)));
  return {
    fgm, fga, tpm, tpa, ftm, fta, orb, drb: Math.round(28 + rand() * 8),
    tov, ast: Math.round(20 + rand() * 10), stl: Math.round(4 + rand() * 6),
    blk: Math.round(2 + rand() * 6), pf: Math.round(15 + rand() * 8),
    _points: points, _possessions: possessions,
  };
}

/**
 * Build a deterministic synthetic dataset with a learnable latent strength and a
 * systematically mispriced market, so picks clear the thresholds.
 *
 * @param {Object} [opts]
 * @param {number} [opts.games=360]
 * @param {number} [opts.teams=12]
 * @param {number} [opts.seed=42]
 * @param {string} [opts.league='nba']
 */
function synthesizeDataset({ games = 360, teams = 12, seed = 42, league = 'nba' } = {}) {
  const rand = mulberry32(seed);
  const leagueCfg = getLeagueConfig(league);
  const basePoss = leagueCfg.leagueMean.possessions;
  const baseOrtg = leagueCfg.leagueMean.ortg;
  const hca = leagueCfg.homeCourtPoints;

  const strength = {};
  const names = {};
  for (let i = 0; i < teams; i++) {
    const id = `T${i}`;
    strength[id] = (rand() * 2 - 1) * 4; // -4..+4 points of true quality
    names[id] = `Team ${i}`;
  }

  const ids = Object.keys(names);
  const out = [];
  let day = 0;
  const perDay = Math.max(1, Math.floor(teams / 2));
  const totalDays = Math.ceil(games / perDay);
  const tipoffBase = Date.UTC(2023, 9, 1, 23, 0, 0); // 2023-10-01

  for (let d = 0; d < totalDays && out.length < games; d++) {
    const pool = ids.slice();
    for (let g = 0; g < perDay && out.length < games; g++) {
      const hi = Math.floor(rand() * pool.length);
      const homeId = pool.splice(hi, 1)[0];
      const ai = Math.floor(rand() * pool.length);
      const awayId = pool.splice(ai, 1)[0];
      if (!homeId || !awayId) break;

      const edge = strength[homeId] - strength[awayId];
      const possessions = basePoss + (rand() * 8 - 4);

      // True expected points.
      const ortgHome = baseOrtg + 1.25 * edge;
      const ortgAway = baseOrtg - 1.25 * edge;
      const expHome = possessions * ortgHome / 100 + hca / 2;
      const expAway = possessions * ortgAway / 100 - hca / 2;
      const expTotal = expHome + expAway;
      const expMargin = expHome - expAway;

      // Realised (noise ~9 pts per side).
      const noise = () => (rand() + rand() + rand() + rand() - 2) * 6.4; // ~sd 9
      const homeScore = Math.round(expHome + noise());
      const awayScore = Math.round(expAway + noise());

      // Mispriced market: line is 6 points too kind to the home side and the
      // total is 6 points too low, so both markets carry systematic value.
      const marketTotal = Math.round(expTotal - 6) + 0.5;
      const marketSpread = -(expMargin - 6); // home handicap
      const openOdds = { overOdds: -105, underOdds: -105, homeOdds: -105, awayOdds: -105 };
      const closeOdds = { overOdds: -110, underOdds: -110, homeOdds: -110, awayOdds: -110 };

      out.push({
        gameId: `G${out.length}`,
        tipoff: new Date(tipoffBase + d * 86400000).toISOString(),
        league,
        venue: 'Synthetic Arena',
        home: { teamId: homeId, name: names[homeId], score: homeScore, stats: _boxFor(homeScore, possessions, rand) },
        away: { teamId: awayId, name: names[awayId], score: awayScore, stats: _boxFor(awayScore, possessions, rand) },
        odds: { total: marketTotal, spread: marketSpread, ...openOdds },
        closing: { total: marketTotal, spread: marketSpread, ...closeOdds },
      });
    }
    day++;
  }
  return { league, games: out };
}

// --------------------------------------------------------------------------
// On-the-fly ESPN loader (current season only)
// --------------------------------------------------------------------------

const { SportsDataService } = require('../services/SportsDataService');
const { EspnProvider } = require('../services/providers/EspnProvider');
const { mapLimit } = require('../services/basketball/ingestion');

function _splitPath(leagueCfg) {
  const [sport, league] = String(leagueCfg.espnPath).split('/');
  return { sport, league };
}

/**
 * Build a dataset from the existing ESPN provider.
 *
 * LIMITATION: the ESPN provider methods take no season/date-range argument, so
 * this only returns the season currently served by the upstream endpoints. For a
 * true >=3-season walk-forward, persist a dataset and pass --dataset.
 */
async function loadDatasetFromEspn({ league = 'nba', withOdds = false, maxGames = 300, concurrency = 4, logger = null } = {}) {
  const leagueCfg = getLeagueConfig(league);
  const { sport, league: espnLeague } = _splitPath(leagueCfg);
  const sportsData = new SportsDataService({ logger });

  const scoreboard = await sportsData.espn.getScoreboard(sport, espnLeague);
  const events = scoreboard?.events || [];
  const teamIds = new Set();
  events.forEach(e => {
    (e.competitions?.[0]?.competitors || []).forEach(c => { if (c?.team?.id != null) teamIds.add(String(c.team.id)); });
  });
  if (!teamIds.size) return { league: leagueCfg.key, games: [] };

  const schedules = await mapLimit([...teamIds], concurrency, (teamId) => (
    sportsData.espn.getTeamSchedule(sport, espnLeague, teamId).catch(() => null)
  ));

  const byEvent = new Map();
  schedules.forEach(sched => {
    (sched?.events || []).forEach(ev => {
      if (ev?.competitions?.[0]?.status?.type?.state !== 'post') return;
      if (ev?.id != null && !byEvent.has(String(ev.id))) byEvent.set(String(ev.id), ev);
    });
  });

  const evList = [...byEvent.values()].slice(0, maxGames);
  const oddsArr = withOdds
    ? await mapLimit(evList, concurrency, (ev) => (
      sportsData.espn.getMatchSummary(sport, espnLeague, ev.id).then(s => EspnProvider.extractBasketballOdds(s)).catch(() => null)
    ))
    : evList.map(() => null);

  const games = [];
  evList.forEach((ev, i) => {
    const comp = ev.competitions?.[0];
    if (!comp) return;
    const homeComp = comp.competitors?.find(c => c.homeAway === 'home');
    const awayComp = comp.competitors?.find(c => c.homeAway === 'away');
    if (!homeComp || !awayComp) return;
    const score = (c) => {
      const v = c?.score?.value ?? c?.score?.displayValue;
      const n = v == null || v === '' ? NaN : parseFloat(v);
      return Number.isNaN(n) ? null : n;
    };
    const homeScore = score(homeComp);
    const awayScore = score(awayComp);
    if (homeScore == null || awayScore == null) return;

    const odds = oddsArr[i];
    games.push({
      gameId: String(ev.id),
      tipoff: ev.date,
      league: leagueCfg.key,
      venue: comp.venue?.fullName || null,
      home: {
        teamId: String(homeComp.team?.id), name: homeComp.team?.displayName || null, score: homeScore,
        stats: EspnProvider.extractBasketballBoxScore(homeComp, awayComp),
      },
      away: {
        teamId: String(awayComp.team?.id), name: awayComp.team?.displayName || null, score: awayScore,
        stats: EspnProvider.extractBasketballBoxScore(awayComp, homeComp),
      },
      odds: odds ? { total: odds.overUnder, overOdds: odds.overOdds, underOdds: odds.underOdds, spread: odds.spread, homeOdds: odds.homeSpreadOdds, awayOdds: odds.awaySpreadOdds } : null,
      // Only one snapshot is available on the fly — see the header note.
      closing: odds ? { total: odds.overUnder, overOdds: odds.overOdds, underOdds: odds.underOdds, spread: odds.spread, homeOdds: odds.homeSpreadOdds, awayOdds: odds.awaySpreadOdds } : null,
    });
  });

  games.sort((a, b) => new Date(a.tipoff) - new Date(b.tipoff));
  return { league: leagueCfg.key, games };
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  argv.forEach(a => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) { args._.push(a); return; }
    args[m[1]] = m[2] === undefined ? true : m[2];
  });
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const league = args.league || 'nba';

  let dataset;
  if (args.dataset) {
    dataset = JSON.parse(fs.readFileSync(path.resolve(args.dataset), 'utf8'));
  } else if (args.synthetic) {
    const n = args.synthetic === true ? 360 : parseInt(args.synthetic, 10) || 360;
    dataset = synthesizeDataset({ games: n, league });
  } else {
    dataset = await loadDatasetFromEspn({
      league,
      withOdds: !!args['with-odds'],
      maxGames: parseInt(args['max-games'], 10) || 300,
    });
  }

  if (!dataset?.games?.length) {
    console.error('No games to backtest. Supply --dataset=<file> or --synthetic[=N].');
    process.exit(1);
  }

  const report = runBacktest(dataset, {
    candidates: args.tune ? DEFAULT_CANDIDATES : undefined,
  });

  const text = formatReport(report);
  console.log(text);

  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), JSON.stringify(report, null, 2));
    console.log(`\nWrote JSON report to ${args.out}`);
  }
}

module.exports = { synthesizeDataset, loadDatasetFromEspn, parseArgs };

if (require.main === module) {
  main().catch(err => {
    console.error('Backtest failed:', err?.stack || err?.message || err);
    process.exit(1);
  });
}
