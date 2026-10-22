#!/usr/bin/env node
/**
 * scripts/diagnose-basketball-projection-bias.js
 *
 * READ-ONLY diagnostic. Changes no model, wires nothing into routes, writes no
 * calibrator. It answers two questions the ordering of the recalibration
 * depends on, in this order:
 *
 *   A. PROJECTION-BIAS DIAGNOSTIC — is the projection itself biased, and if so
 *      where? Reported on the train and holdout partitions, by month and by
 *      league:
 *        mean(actual total   - projected total)
 *        mean(actual total   - closing total)
 *        mean(actual margin  - projected margin)
 *        mean(actual margin  - market-implied margin)   [= -closing handicap]
 *        share of Total Points picks that are Under
 *      plus the attribution table (projected possessions, points-per-possession
 *      pair, base total, applied adjustment total, and the same quantities for
 *      the league mean the model shrinks toward) and a prior-vs-actual league
 *      average points/team comparison per season.
 *
 *   B. MARKET-ANCHORED PROJECTION — walk-forward only. The regression
 *        actual total  ~ 1 + projected total + closing total
 *        actual margin ~ 1 + projected margin + market-implied margin
 *      is fitted on the TRAIN partition and applied to the HOLDOUT, so no
 *      holdout row ever influences a fitted weight. Weights are reported with
 *      95% confidence intervals, together with holdout Brier / log loss of the
 *      anchored projection vs the closing line alone vs the raw model.
 *
 * Sigma is held at the raw model's value throughout, so anchoring changes only
 * the point projection and the comparison isolates that one change.
 *
 * Data comes from the same verified ESPN pipeline as the refit script (site API
 * `teams/{id}/schedule?season=` for the game list, `summary?event=` for box
 * scores and the pickcenter closing snapshot) and the same warm cache, so no
 * new endpoint is trusted and nothing is refetched unnecessarily.
 *
 * Usage:
 *   node scripts/diagnose-basketball-projection-bias.js --league=nba --seasons=2025,2026
 *   node scripts/diagnose-basketball-projection-bias.js --seasons=2026 --holdout=0.25 --out=bias.json
 *   node scripts/diagnose-basketball-projection-bias.js --no-core      # skip the core-API prior probe
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { getLeagueConfig } = require('../services/basketball/leagues');
const { evaluate } = require('../services/basketball/backtester');
const {
  estimateSigma, totalsProbability, spreadProbability, leagueMeanTotal, studentTCdf,
} = require('../services/basketball/probability');
const { brierScore, logLoss } = require('../services/basketball/calibration');
const { loadSeasonDataset, splitHoldout, fetchJson, listTeamIds } = require('./refit-basketball-calibrator');
const CONFIG = require('../services/basketball/config');

const CORE_BASE = 'https://sports.core.api.espn.com/v2/sports';

// --------------------------------------------------------------------------
// Small maths helpers
// --------------------------------------------------------------------------

function mean(arr) {
  const v = (Array.isArray(arr) ? arr : []).filter(Number.isFinite);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

function sd(arr) {
  const v = (Array.isArray(arr) ? arr : []).filter(Number.isFinite);
  if (v.length < 2) return null;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / (v.length - 1));
}

function groupBy(list, keyFn) {
  const m = new Map();
  list.forEach(x => {
    const k = keyFn(x);
    if (k == null) return;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  });
  return m;
}

/** 95% Student-t quantile, inverted by bisection on the CDF we already ship. */
function tQuantile(p, df) {
  let lo = -60;
  let hi = 60;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Gauss-Jordan inverse (small k; k <= 3 here). */
function invert(A) {
  const n = A.length;
  const M = A.map((row, i) => row.concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    const tmp = M[c]; M[c] = M[p]; M[p] = tmp;
    const piv = M[c][c];
    for (let j = 0; j < 2 * n; j++) M[c][j] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (!f) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map(row => row.slice(n));
}

/**
 * Ordinary least squares with an intercept, returning coefficient standard
 * errors and 95% confidence intervals (t-distribution, df = n - k).
 *
 * @param {number[]} ys
 * @param {number[][]} xs - one row per observation, WITHOUT the intercept
 */
function ols(ys, xs) {
  const n = ys.length;
  if (!n || !xs.length || xs[0].length + 1 > n) return null;
  const k = xs[0].length + 1;
  const X = xs.map(x => [1, ...x]);

  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * ys[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }

  const inv = invert(XtX);
  if (!inv) return null;
  const coef = inv.map((row, a) => row.reduce((s, v, b) => s + v * Xty[b], 0));

  const res = ys.map((y, i) => y - X[i].reduce((s, v, j) => s + v * coef[j], 0));
  const sse = res.reduce((s, r) => s + r * r, 0);
  const df = n - k;
  const sigma2 = df > 0 ? sse / df : null;
  const ybar = mean(ys);
  const sst = ys.reduce((s, y) => s + (y - ybar) * (y - ybar), 0);
  const tcrit = df > 0 ? tQuantile(0.975, df) : null;
  const se = sigma2 == null ? coef.map(() => null) : coef.map((_, j) => Math.sqrt(Math.max(0, sigma2 * inv[j][j])));

  return {
    n, k, df,
    coef,
    se,
    ci: coef.map((c, j) => (se[j] == null ? null : [c - tcrit * se[j], c + tcrit * se[j]])),
    r2: sst > 0 ? 1 - sse / sst : null,
    residualSd: sigma2 == null ? null : Math.sqrt(sigma2),
    sse,
  };
}

// --------------------------------------------------------------------------
// Step A — bias measurement
// --------------------------------------------------------------------------

/** Market-implied home margin from the closing handicap (negative = home favoured). */
function marketMarginOf(g) {
  const s = g?.closing?.spread;
  return Number.isFinite(s) ? -s : null;
}

function biasStats(games) {
  const withClose = games.filter(g => g.closing && Number.isFinite(g.closing.total));
  return {
    n: games.length,
    nClosing: withClose.length,
    dTotalProj: mean(games.map(g => (Number.isFinite(g.actualTotal) && Number.isFinite(g.projTotal) ? g.actualTotal - g.projTotal : null))),
    dTotalClose: mean(withClose.map(g => (Number.isFinite(g.actualTotal) ? g.actualTotal - g.closing.total : null))),
    dMarginProj: mean(games.map(g => (Number.isFinite(g.actualMargin) && Number.isFinite(g.projMargin) ? g.actualMargin - g.projMargin : null))),
    dMarginMkt: mean(withClose.map(g => {
      const mkt = marketMarginOf(g);
      return (Number.isFinite(g.actualMargin) && mkt != null) ? g.actualMargin - mkt : null;
    })),
    meanProjTotal: mean(games.map(g => g.projTotal)),
    meanActualTotal: mean(games.map(g => g.actualTotal)),
    meanCloseTotal: mean(withClose.map(g => g.closing.total)),
  };
}

/** Share of Total Points picks taken on the Under side. */
function underShare(picks) {
  const totals = picks.filter(p => p.market === 'Total Points');
  if (!totals.length) return { n: 0, under: 0, share: null };
  const under = totals.filter(p => p.side === 'b').length;
  return { n: totals.length, under, share: under / totals.length };
}

/**
 * Where does the base projection sit relative to the league mean the model
 * shrinks toward? baseTotal = pace * (homePpp + awayPpp), so the multiplicative
 * gap splits into a pace factor and a points-per-possession factor.
 */
function attribution(games, leagueCfg) {
  const lm = leagueCfg.leagueMean;
  const adjByType = {};
  games.forEach(g => {
    Object.entries(g.adjByType || {}).forEach(([k, v]) => {
      if (!adjByType[k]) adjByType[k] = [];
      adjByType[k].push(v);
    });
  });

  const meanProjPossessions = mean(games.map(g => g.projPossessions));
  const meanPppPair = mean(games.map(g => (Number.isFinite(g.homePpp) && Number.isFinite(g.awayPpp) ? g.homePpp + g.awayPpp : null)));

  return {
    n: games.length,
    modelLeagueMeanTotal: leagueMeanTotal(leagueCfg),
    modelLeagueMeanPace: lm.possessions,
    modelLeagueMeanPppPair: (lm.ortg + lm.drtg) / 100,
    meanProjPossessions,
    paceFactor: (meanProjPossessions != null && lm.possessions) ? meanProjPossessions / lm.possessions : null,
    meanPppPair,
    pppFactor: (meanPppPair != null && (lm.ortg + lm.drtg)) ? meanPppPair / ((lm.ortg + lm.drtg) / 100) : null,
    meanBaseTotal: mean(games.map(g => g.baseTotal)),
    meanAdjTotal: mean(games.map(g => g.adjTotal)),
    meanProjTotal: mean(games.map(g => g.projTotal)),
    meanActualTotal: mean(games.map(g => g.actualTotal)),
    meanProjMargin: mean(games.map(g => g.projMargin)),
    meanActualMargin: mean(games.map(g => g.actualMargin)),
    meanAdjMargin: mean(games.map(g => g.adjMargin)),
    adjTotalByType: Object.fromEntries(Object.entries(adjByType).map(([k, v]) => [k, mean(v)])),
  };
}

// --------------------------------------------------------------------------
// Step A — prior vs actual league averages
// --------------------------------------------------------------------------

function possessionsOf(stats, ftWeight) {
  if (!stats) return null;
  const { fga, orb, tov, fta } = stats;
  if (![fga, orb, tov, fta].every(Number.isFinite)) return null;
  return fga - orb + tov + ftWeight * fta;
}

/** League averages derived from a season's box scores, using the engine's own maths. */
function seasonAverages(games, leagueCfg) {
  const ftWeight = leagueCfg.ftWeight ?? 0.44;
  let points = 0;
  let possessions = 0;
  let teamGames = 0;
  let totalPoints = 0;
  let scored = 0;

  games.forEach(g => {
    const hScore = g.home?.score;
    const aScore = g.away?.score;
    if (Number.isFinite(hScore)) points += hScore;
    if (Number.isFinite(aScore)) points += aScore;
    if (Number.isFinite(hScore) && Number.isFinite(aScore)) { totalPoints += hScore + aScore; scored++; }

    const hp = possessionsOf(g.home?.stats, ftWeight);
    const ap = possessionsOf(g.away?.stats, ftWeight);
    if (hp != null) { possessions += hp; teamGames++; }
    if (ap != null) { possessions += ap; teamGames++; }
  });

  return {
    games: games.length,
    ptsPerTeamGame: teamGames ? points / teamGames : null,
    possPerTeamGame: teamGames ? possessions / teamGames : null,
    ortg: possessions ? (points / possessions) * 100 : null,
    avgTotal: scored ? totalPoints / scored : null,
  };
}

/** The ratings prior for season Y, rebuilt from season Y-1 the same way the engine does. */
function priorFromSeason(prevGames, leagueCfg, teamIds) {
  // Per-team season totals, exactly as buildPriorRatings consumes them.
  const ftWeight = leagueCfg.ftWeight ?? 0.44;
  const byTeam = new Map();
  const touch = (id) => {
    if (id == null) return null;
    if (!byTeam.has(id)) byTeam.set(id, { games: 0, points: 0, possessions: 0 });
    return byTeam.get(id);
  };
  prevGames.forEach(g => {
    const h = touch(g.home?.teamId != null ? String(g.home.teamId) : null);
    const a = touch(g.away?.teamId != null ? String(g.away.teamId) : null);
    if (h && Number.isFinite(g.home?.score)) {
      h.games++; h.points += g.home.score;
      const p = possessionsOf(g.home?.stats, ftWeight);
      if (p != null) h.possessions += p;
    }
    if (a && Number.isFinite(g.away?.score)) {
      a.games++; a.points += g.away.score;
      const p = possessionsOf(g.away?.stats, ftWeight);
      if (p != null) a.possessions += p;
    }
  });

  const usable = [...byTeam.values()].filter(t => t.games > 0 && t.possessions > 0);
  if (!usable.length) return null;
  return {
    teams: usable.length,
    ptsPerTeamGame: mean(usable.map(t => t.points / t.games)),
    pace: mean(usable.map(t => t.possessions / t.games)),
    ortg: mean(usable.map(t => (t.points / t.possessions) * 100)),
    teamIds: teamIds || usable.length,
  };
}

/**
 * Real core-API prior: the exact source the live engine reads
 * (`seasons/{y}/types/2/teams/{id}/statistics` -> season totals). Confirms the
 * box-score-derived prior above is not an artefact of our own maths.
 */
async function corePriorAverages({ espnPath, seasonYear, concurrency = 6, logger = null }) {
  const [sport, league] = String(espnPath).split('/');
  const ids = await listTeamIds(espnPath);
  if (!ids.length) return null;
  const rows = [];
  const queue = ids.slice();
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const id = queue.shift();
      const data = await fetchJson(`${CORE_BASE}/${sport}/leagues/${league}/seasons/${seasonYear}/types/2/teams/${id}/statistics`);
      const cats = data?.splits?.categories;
      if (!Array.isArray(cats)) continue;
      const flat = {};
      cats.forEach(c => (c?.stats || []).forEach(s => {
        if (s?.name) { const n = parseFloat(s.value ?? s.displayValue); if (!Number.isNaN(n)) flat[s.name] = n; }
      }));
      if (!flat.gamesPlayed || !flat.possessions) continue;
      rows.push({
        teamId: id,
        ptsPerTeamGame: flat.points / flat.gamesPlayed,
        pace: flat.possessions / flat.gamesPlayed,
        ortg: (flat.points / flat.possessions) * 100,
      });
    }
  });
  await Promise.all(workers);
  if (logger) logger(`core-API prior ${seasonYear}: ${rows.length}/${ids.length} team aggregates`);
  if (!rows.length) return null;
  return {
    teams: rows.length,
    ptsPerTeamGame: mean(rows.map(r => r.ptsPerTeamGame)),
    pace: mean(rows.map(r => r.pace)),
    ortg: mean(rows.map(r => r.ortg)),
  };
}

// --------------------------------------------------------------------------
// Step B — market-anchored projection
// --------------------------------------------------------------------------

function pickProbability(row, { projTotal, projMargin, sigmaTotal, sigmaMargin }) {
  if (row.market === 'Total Points') {
    const r = totalsProbability({ line: row.line, projTotal, sigmaTotal, cfg: CONFIG });
    return row.side === 'a' ? r.over : r.under;
  }
  const r = spreadProbability({ spread: row.line, projMargin, sigmaMargin, cfg: CONFIG });
  return row.side === 'a' ? r.home : r.away;
}

function scoreSeries(pairs) {
  const good = pairs.filter(p => Number.isFinite(p.p) && (p.y === 0 || p.y === 1));
  if (!good.length) return { n: 0, hitRate: null, avgStated: null, brier: null, logLoss: null };
  const hits = good.filter(p => p.y === 1).length;
  return {
    n: good.length,
    hitRate: hits / good.length,
    avgStated: mean(good.map(p => p.p)),
    brier: brierScore(good.map(p => ({ p: p.p, y: p.y }))),
    logLoss: logLoss(good.map(p => ({ p: p.p, y: p.y }))),
  };
}

// --------------------------------------------------------------------------
// Report formatting
// --------------------------------------------------------------------------

const f2 = (v) => (v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(2));
const f3 = (v) => (v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(3));
const f4 = (v) => (v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(4));
const pct = (v) => (v == null || !Number.isFinite(v) ? 'n/a' : `${(v * 100).toFixed(1)}%`);
const sign = (v, dp = 2) => (v == null || !Number.isFinite(v) ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(dp)}`);

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(String(h).length, ...rows.map(r => String(r[i] ?? '').length)));
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  return [
    line(headers),
    widths.map(w => '-'.repeat(w)).join('  '),
    ...rows.map(line),
  ].join('\n');
}

// --------------------------------------------------------------------------
// Main
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
  const leagueKey = args.league || 'nba';
  const leagueCfg = getLeagueConfig(leagueKey);
  const seasons = String(args.seasons || '2026').split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
  const holdoutFraction = args.holdout ? parseFloat(args.holdout) : 0.25;
  const cacheDir = args.cache ? path.resolve(args.cache) : path.join(os.tmpdir(), 'apex-calib');
  const concurrency = parseInt(args.concurrency, 10) || 6;
  const useCore = args['no-core'] !== true;
  const log = (msg) => process.stderr.write(`[bias] ${msg}\n`);

  const parts = [];
  for (const seasonYear of seasons) {
    // eslint-disable-next-line no-await-in-loop
    const part = await loadSeasonDataset({ leagueCfg, seasonYear, cacheDir, concurrency, withOdds: true, logger: log });
    if (part.games.length) parts.push(part);
  }
  const games = parts.flatMap(p => p.games).sort((a, b) => new Date(a.tipoff) - new Date(b.tipoff));
  if (!games.length) {
    console.error('No games with usable box scores — nothing to diagnose.');
    process.exit(1);
  }

  const dataset = { league: leagueCfg.key, games };
  log(`walk-forward over ${games.length} games (${games[0].tipoff} -> ${games[games.length - 1].tipoff})`);
  const ev = evaluate(dataset, { calibrate: false, cfg: CONFIG });

  const rows = ev.rows;
  const allGameRows = ev.gameRows;

  const { train: trainPicks, holdout: testPicks, cutoff } = splitHoldout(rows, holdoutFraction);
  const cutoffTs = cutoff ? new Date(cutoff).getTime() : Infinity;
  const trainGames = allGameRows.filter(g => g.tipoff && new Date(g.tipoff).getTime() < cutoffTs);
  const testGames = allGameRows.filter(g => g.tipoff && new Date(g.tipoff).getTime() >= cutoffTs);

  const sets = [
    { label: 'TRAIN', games: trainGames, picks: trainPicks },
    { label: 'HOLDOUT', games: testGames, picks: testPicks },
  ];

  const out = [];
  out.push(`# Basketball projection-bias diagnostic — ${leagueCfg.label} (${leagueCfg.key})`);
  out.push(`generated ${new Date().toISOString()}`);
  out.push('');
  out.push('## Data');
  parts.forEach(p => out.push(`  season ${p.seasonYear}: ${p.games.length} usable games${p.cached ? ' (cached)' : ''}`));
  out.push(`  games analysed ${ev.games}   picks ${ev.picks}   games without a pick ${ev.noPickGames}   games without odds ${ev.missingOdds}`);
  out.push(`  walk-forward window: ${games[0].tipoff} -> ${games[games.length - 1].tipoff}`);
  out.push(`  train rows ${trainPicks.length} -> holdout rows ${testPicks.length} starting ${cutoff || 'n/a'}`);
  out.push(`  train games ${trainGames.length} -> holdout games ${testGames.length}`);
  out.push('  LINES: ESPN publishes no opening line for a finished game; pickcenter[0] is the');
  out.push('  CLOSING snapshot and is used as a proxy for the pre-game line (verified: `open` is');
  out.push('  null for finished games). "Market-implied margin" below = -closing handicap.');
  out.push('');

  // ---------------- STEP A ----------------
  out.push('==============================================================');
  out.push('STEP A — PROJECTION-BIAS DIAGNOSTIC (no model change)');
  out.push('==============================================================');
  out.push('');
  out.push('Sign convention: positive = the actual value came in ABOVE the comparison.');
  out.push('');

  const monthOf = (g) => (g.tipoff ? String(g.tipoff).slice(0, 7) : null);
  const pickMonthOf = (p) => (p.tipoff ? String(p.tipoff).slice(0, 7) : null);

  // A1 / A2: bias tables
  sets.forEach(s => {
    const months = [...new Set(s.games.map(monthOf).filter(Boolean))].sort();
    const rowsA1 = months.map(m => {
      const gm = s.games.filter(g => monthOf(g) === m);
      const pk = s.picks.filter(p => pickMonthOf(p) === m);
      const b = biasStats(gm);
      const u = underShare(pk);
      return [m, b.n, b.nClosing, sign(b.dTotalProj), sign(b.dTotalClose), sign(b.dMarginProj), sign(b.dMarginMkt), u.n ? `${u.under}/${u.n}` : 'n/a', pct(u.share)];
    });
    const bAll = biasStats(s.games);
    const uAll = underShare(s.picks);
    rowsA1.push(['ALL', bAll.n, bAll.nClosing, sign(bAll.dTotalProj), sign(bAll.dTotalClose), sign(bAll.dMarginProj), sign(bAll.dMarginMkt), uAll.n ? `${uAll.under}/${uAll.n}` : 'n/a', pct(uAll.share)]);
    out.push(`### A1. ${s.label} — bias by month`);
    out.push(table(
      ['month', 'games', 'w/closing', 'act-proj TOT', 'act-closing TOT', 'act-proj MGN', 'act-mkt MGN', 'Under', 'Under share'],
      rowsA1,
    ));
    out.push('');
  });

  sets.forEach(s => {
    const leagues = [...new Set(s.games.map(g => g.league))].sort();
    const rowsA2 = leagues.map(l => {
      const gm = s.games.filter(g => g.league === l);
      const pk = s.picks.filter(p => p.league === l);
      const b = biasStats(gm);
      const u = underShare(pk);
      return [l, b.n, b.nClosing, sign(b.dTotalProj), sign(b.dTotalClose), sign(b.dMarginProj), sign(b.dMarginMkt), u.n ? `${u.under}/${u.n}` : 'n/a', pct(u.share)];
    });
    out.push(`### A2. ${s.label} — bias by league`);
    out.push(table(
      ['league', 'games', 'w/closing', 'act-proj TOT', 'act-closing TOT', 'act-proj MGN', 'act-mkt MGN', 'Under', 'Under share'],
      rowsA2,
    ));
    out.push('');
  });

  // A3: level table
  out.push('### A3. Levels (games with a projection; closing columns from games with odds)');
  out.push(table(
    ['set', 'games', 'mean proj TOT', 'mean actual TOT', 'mean closing TOT', 'mean proj MGN', 'mean actual MGN', 'mean mkt MGN'],
    sets.map(s => {
      const b = biasStats(s.games);
      return [
        s.label, b.n,
        f2(b.meanProjTotal), f2(b.meanActualTotal), f2(b.meanCloseTotal),
        sign(mean(s.games.map(g => g.projMargin)), 2),
        sign(mean(s.games.map(g => g.actualMargin)), 2),
        sign(mean(s.games.filter(g => g.closing).map(g => marketMarginOf(g))), 2),
      ];
    }),
  ));
  out.push('');

  // A4: attribution
  out.push('### A4. Attribution — where the base projection sits vs the league mean it shrinks toward');
  out.push(`  model league mean: possessions ${f2(leagueCfg.leagueMean.possessions)}, ortg ${f2(leagueCfg.leagueMean.ortg)}, drtg ${f2(leagueCfg.leagueMean.drtg)}  ->  leagueMeanTotal ${f2(leagueMeanTotal(leagueCfg))}`);
  const attrRows = [];
  sets.forEach(s => {
    const a = attribution(s.games, leagueCfg);
    attrRows.push([
      s.label, a.n,
      f2(a.meanProjPossessions), f2(a.paceFactor),
      f2(a.meanPppPair), f2(a.pppFactor),
      f2(a.meanBaseTotal), sign(a.meanAdjTotal), f2(a.meanProjTotal), f2(a.meanActualTotal),
    ]);
  });
  out.push(table(
    ['set', 'games', 'proj poss', 'pace x', 'ppp pair', 'ppp x', 'base TOT', 'adj TOT', 'proj TOT', 'actual TOT'],
    attrRows,
  ));
  out.push('  base TOT = pace x ppp pair   (ppp pair is homePpp + awayPpp; league mean 2.280)');
  const adjTypes = ['TRAIN', 'HOLDOUT'].map((label, i) => {
    const a = attribution(sets[i].games, leagueCfg);
    const keys = Object.keys(a.adjTotalByType);
    return keys.length ? `${label}: ${keys.map(k => `${k} ${sign(a.adjTotalByType[k])}`).join(', ')}` : `${label}: (no adjustments applied)`;
  });
  adjTypes.forEach(l => out.push(`  adj by type — ${l}`));
  out.push('');

  // A5: prior vs actual league averages
  out.push('### A5. Ratings prior vs actual league average, per season');
  out.push('  "prior" for season Y is season Y-1 rebuilt with the engine\'s own maths');
  out.push('  (ortg = points/possessions*100, pace = possessions/game) — the same construction');
  out.push('  buildPriorRatings uses on the core-API season totals.');
  const seasonRows = parts
    .slice()
    .sort((a, b) => a.seasonYear - b.seasonYear)
    .map(p => {
      const actual = seasonAverages(p.games, leagueCfg);
      const prev = parts.find(q => q.seasonYear === p.seasonYear - 1);
      const prior = prev ? priorFromSeason(prev.games, leagueCfg) : null;
      return [
        String(p.seasonYear),
        f2(actual.ptsPerTeamGame), f2(actual.ortg), f2(actual.possPerTeamGame), f2(actual.avgTotal),
        prior ? f2(prior.ptsPerTeamGame) : 'n/a',
        prior ? f2(prior.ortg) : 'n/a',
        prior ? f2(prior.pace) : 'n/a',
        prior ? f2(prior.pace * 2 * prior.ortg / 100) : 'n/a',
      ];
    });
  out.push(table(
    ['season', 'ACT pts/team', 'ACT ortg', 'ACT pace', 'ACT total', 'PRIOR pts/team', 'PRIOR ortg', 'PRIOR pace', 'PRIOR implied total'],
    seasonRows,
  ));
  out.push(`  model leagueMean implied total (what shrinkage pulls toward): ${f2(leagueMeanTotal(leagueCfg))}`);
  out.push(`  model priorSeason fallback: ortg ${f2(leagueCfg.priorSeason?.ortg)}, drtg ${f2(leagueCfg.priorSeason?.drtg)}, pace ${f2(leagueCfg.priorSeason?.pace)}  ->  implied total ${f2((leagueCfg.priorSeason?.pace ?? 0) * ((leagueCfg.priorSeason?.ortg ?? 0) + (leagueCfg.priorSeason?.drtg ?? 0)) / 100)}`);

  let coreInfo = null;
  if (useCore) {
    const priorSeason = parts.length > 1 ? parts[parts.length - 1].seasonYear - 1 : null;
    if (priorSeason != null) {
      const [sport, league] = String(leagueCfg.espnPath).split('/');
      coreInfo = await corePriorAverages({ espnPath: `${sport}/${league}`, seasonYear: priorSeason, concurrency, logger: log });
    }
    if (coreInfo) {
      out.push(`  CORE-API check (season ${parts[parts.length - 1].seasonYear - 1}): ${coreInfo.teams} team aggregates -> pts/team ${f2(coreInfo.ptsPerTeamGame)}, ortg ${f2(coreInfo.ortg)}, pace ${f2(coreInfo.pace)}, implied total ${f2(coreInfo.pace * 2 * coreInfo.ortg / 100)}`);
    } else {
      out.push('  CORE-API check: unavailable (network or no aggregate) — box-score prior above is the same maths.');
    }
  }
  out.push('');

  // ---------------- STEP B ----------------
  out.push('==============================================================');
  out.push('STEP B — MARKET-ANCHORED PROJECTION (walk-forward: fit on TRAIN, test on HOLDOUT)');
  out.push('==============================================================');
  out.push('');

  const fitGames = trainGames.filter(g => g.closing && Number.isFinite(g.closing.total));
  const testFitGames = testGames.filter(g => g.closing && Number.isFinite(g.closing.total));

  const totalFit = ols(
    fitGames.map(g => g.actualTotal),
    fitGames.map(g => [g.projTotal, g.closing.total]),
  );
  const marginFit = ols(
    fitGames.map(g => g.actualMargin),
    fitGames.map(g => [g.projMargin, marketMarginOf(g)]),
  );

  const coefRow = (label, unit, fit) => {
    if (!fit) return [label, 'n/a', 'n/a', 'n/a', 'n/a', 'n/a'];
    const p = (fit.coef[1] ?? 0) + ((fit.coef[2] ?? 0) * unit);
    return [
      label, String(fit.n),
      `${f4(fit.coef[1])} [${f4(fit.ci[1][0])}, ${f4(fit.ci[1][1])}]`,
      `${f4(fit.coef[2])} [${f4(fit.ci[2][0])}, ${f4(fit.ci[2][1])}]`,
      f4(fit.coef[0]),
      f4(fit.r2),
    ];
  };
  const pValueNote = (fit, j) => {
    if (!fit || !fit.ci[j]) return 'n/a';
    return fit.ci[j][0] > 0 || fit.ci[j][1] < 0 ? 'excludes 0' : 'includes 0';
  };

  out.push('### B1. Fitted weights (TRAIN only) — actual = intercept + w_model * model + w_market * market');
  out.push(table(
    ['target', 'n', 'w_model [95% CI]', 'w_market [95% CI]', 'intercept', 'R2'],
    [
      coefRow('total points', 0, totalFit),
      coefRow('margin', 0, marginFit),
    ],
  ));
  out.push(`  total points: model weight ${pValueNote(totalFit, 1)} 0   market weight ${pValueNote(totalFit, 2)} 0`);
  out.push(`  margin      : model weight ${pValueNote(marginFit, 1)} 0   market weight ${pValueNote(marginFit, 2)} 0`);
  out.push(`  residual sd (train): total ${f4(totalFit?.residualSd)}  margin ${f4(marginFit?.residualSd)}`);
  out.push('');

  // Apply the TRAIN-fitted weights to every game.
  const anchored = new Map();
  allGameRows.forEach(g => {
    const mktT = g.closing && Number.isFinite(g.closing.total) ? g.closing.total : null;
    const mktM = marketMarginOf(g);
    anchored.set(g.gameId, {
      total: (totalFit && mktT != null)
        ? totalFit.coef[0] + totalFit.coef[1] * g.projTotal + totalFit.coef[2] * mktT
        : null,
      margin: (marginFit && mktM != null)
        ? marginFit.coef[0] + marginFit.coef[1] * g.projMargin + marginFit.coef[2] * mktM
        : null,
    });
  });

  // Anchored residuals, per partition.
  out.push('### B2. Anchored-projection residuals (actual - anchored)');
  const residRows = [['TRAIN', trainGames], ['HOLDOUT', testGames]].map(([label, list]) => {
    const rt = list.map(g => {
      const a = anchored.get(g.gameId);
      return (a && Number.isFinite(a.total) && Number.isFinite(g.actualTotal)) ? g.actualTotal - a.total : null;
    });
    const rm = list.map(g => {
      const a = anchored.get(g.gameId);
      return (a && Number.isFinite(a.margin) && Number.isFinite(g.actualMargin)) ? g.actualMargin - a.margin : null;
    });
    return [label, String(list.length), sign(mean(rt)), f2(sd(rt)), sign(mean(rm)), f2(sd(rm))];
  });
  out.push(table(
    ['set', 'games', 'mean resid TOT', 'sd resid TOT', 'mean resid MGN', 'sd resid MGN'],
    residRows,
  ));
  out.push(`  league base sigma used by the raw model: total ${f2(leagueCfg.sigma?.total)}, margin ${f2(leagueCfg.sigma?.margin)} (clamped ${CONFIG.sigma.minTotal}-${CONFIG.sigma.maxTotal} / ${CONFIG.sigma.minMargin}-${CONFIG.sigma.maxMargin})`);
  out.push('');

  // Holdout probability comparison, per market.
  const gameMap = new Map(allGameRows.map(g => [g.gameId, g]));
  const evalRows = [];
  testPicks.forEach(r => {
    const g = gameMap.get(r.gameId);
    if (!g || !Number.isFinite(g.projTotal) || !Number.isFinite(g.projMargin)) return;
    if (r.y !== 0 && r.y !== 1) return;
    const sigma = estimateSigma({
      projTotal: g.projTotal,
      projMargin: g.projMargin,
      expectedPossessions: g.projPossessions,
      leagueCfg,
      cfg: CONFIG,
    });
    const a = anchored.get(r.gameId) || {};
    const mktT = g.closing && Number.isFinite(g.closing.total) ? g.closing.total : null;
    const mktM = marketMarginOf(g);

    const pRaw = r.pRaw;
    const pAnchored = (r.market === 'Total Points' ? Number.isFinite(a.total) : Number.isFinite(a.margin))
      ? pickProbability(r, {
        projTotal: r.market === 'Total Points' ? a.total : g.projTotal,
        projMargin: r.market === 'Spread' ? a.margin : g.projMargin,
        sigmaTotal: sigma.total,
        sigmaMargin: sigma.margin,
      })
      : null;
    const pClosing = (r.market === 'Total Points' ? mktT != null : mktM != null)
      ? pickProbability(r, {
        projTotal: r.market === 'Total Points' ? mktT : g.projTotal,
        projMargin: r.market === 'Spread' ? mktM : g.projMargin,
        sigmaTotal: sigma.total,
        sigmaMargin: sigma.margin,
      })
      : null;

    evalRows.push({
      market: r.market, y: r.y,
      pRaw, pAnchored, pClosing,
      pMarket: Number.isFinite(r.closingFair) ? r.closingFair : null,
    });
  });

  ['Total Points', 'Spread'].forEach(market => {
    const list = evalRows.filter(r => r.market === market);
    const raw = scoreSeries(list.map(r => ({ p: r.pRaw, y: r.y })));
    const anc = scoreSeries(list.map(r => ({ p: r.pAnchored, y: r.y })));
    const clo = scoreSeries(list.map(r => ({ p: r.pClosing, y: r.y })));
    const mkt = scoreSeries(list.map(r => ({ p: r.pMarket, y: r.y })));
    out.push(`### B3. ${market} — HOLDOUT (engine's own selections, sigma held at the raw model's value)`);
    out.push(table(
      ['approach', 'n', 'hit rate', 'avg stated', 'Brier', 'log loss'],
      [
        ['raw model', String(raw.n), pct(raw.hitRate), pct(raw.avgStated), f4(raw.brier), f4(raw.logLoss)],
        ['closing line as projection', String(clo.n), pct(clo.hitRate), pct(clo.avgStated), f4(clo.brier), f4(clo.logLoss)],
        ['closing line implied (de-vigged)', String(mkt.n), pct(mkt.hitRate), pct(mkt.avgStated), f4(mkt.brier), f4(mkt.logLoss)],
        ['market-anchored projection', String(anc.n), pct(anc.hitRate), pct(anc.avgStated), f4(anc.brier), f4(anc.logLoss)],
      ],
    ));
    out.push('  hit rate is identical across the first, second and fourth rows by construction: the');
    out.push('  engine picks the same SIDE in every case; anchoring changes the stated probability,');
    out.push('  so only Brier / log loss can move. The de-vigged row scores the market\'s own');
    out.push('  probability for that same side (available only where the pick line = closing line).');
    out.push('');
  });

  console.log(out.join('\n'));

  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), JSON.stringify({
      league: leagueCfg.key, generatedAt: new Date().toISOString(), seasons,
      data: {
        games: ev.games, picks: ev.picks, trainRows: trainPicks.length, holdoutRows: testPicks.length,
        trainGames: trainGames.length, holdoutGames: testGames.length, cutoff,
      },
      stepA: {
        bySet: sets.map(s => ({ set: s.label, bias: biasStats(s.games), under: underShare(s.picks), attribution: attribution(s.games, leagueCfg) })),
        seasons: parts.map(p => ({
          seasonYear: p.seasonYear,
          actual: seasonAverages(p.games, leagueCfg),
          prior: (() => { const q = parts.find(x => x.seasonYear === p.seasonYear - 1); return q ? priorFromSeason(q.games, leagueCfg) : null; })(),
        })),
        corePrior: coreInfo,
      },
      stepB: {
        totalFit, marginFit,
        holdout: ['Total Points', 'Spread'].map(market => {
          const list = evalRows.filter(r => r.market === market);
          return {
            market,
            raw: scoreSeries(list.map(r => ({ p: r.pRaw, y: r.y }))),
            anchored: scoreSeries(list.map(r => ({ p: r.pAnchored, y: r.y }))),
            closingProjection: scoreSeries(list.map(r => ({ p: r.pClosing, y: r.y }))),
            closingImplied: scoreSeries(list.map(r => ({ p: r.pMarket, y: r.y }))),
          };
        }),
      },
    }, null, 2));
    console.log(`\nWrote JSON to ${args.out}`);
  }
}

module.exports = { ols, invert, tQuantile, biasStats, underShare, attribution, seasonAverages, priorFromSeason, marketMarginOf };

if (require.main === module) {
  main().catch(err => {
    console.error('Diagnostic failed:', err?.stack || err?.message || err);
    process.exit(1);
  });
}
