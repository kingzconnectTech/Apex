/**
 * live/forwardTest.js
 *
 * Phase 9 — log every live probability we actually serve, and retire the pick
 * the moment the realised numbers stop matching the backtest.
 *
 * The ship gate passed on held-out HISTORY. A backtest can be right and live
 * serving still go wrong — a stale feed, a different league mix, a season that
 * simply behaves differently. Phase 9 therefore watches the pick in production:
 *
 *   - Every shipped live home-win probability is appended with its timestamp,
 *     its data staleness and (once the game ends) its outcome.
 *   - A rolling, GAME-level log loss is compared against the backtest benchmark
 *     the fit script recorded. Past the configured tolerance the pick is
 *     auto-DISABLED (services/live/policy consults this), so a drifting model
 *     withdraws itself instead of quietly serving bad numbers.
 *   - The pick is only opened to everyone after `minGames` settled live games
 *     have confirmed the benchmark (services/live/policy gates the rollout).
 *
 * The log is a plain JSON file (CONFIG.live.forwardTest.file), so it survives a
 * restart without a database and can be committed or shipped with the report.
 * It is deliberately NOT part of any user-facing payload.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG = require('./config');
const { brierScore, logLoss } = require('../basketball/calibration');
// Reused, not re-implemented: the score-and-time baseline and the game-level
// bootstrap must be the SAME code the ship gate used, or the shadow hold would
// be measured against a different ruler than the gate it is meant to confirm.
const BT = require('./backtester');
const liveCalibrator = require('./liveCalibrator');
// Phase 10 round D — the CONFIRMATION dataset is defined by the frozen
// candidate artifact's freeze instant, so the forward log has to read it.
const shadowCandidates = require('./shadowCandidates');

const FWD = CONFIG.live.forwardTest;
const BACKEND_DIR = path.join(__dirname, '..', '..');

/** Resolve a config-relative artifact path to an absolute one. */
function resolveFile(file = FWD.file) {
  if (!file) return null;
  return path.isAbsolute(file) ? file : path.join(BACKEND_DIR, file);
}

function round4(v) {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(4));
}

/** The frozen release criteria in force right now (config live.releaseCriteria). */
function releaseCriteria() {
  return (CONFIG.live && CONFIG.live.releaseCriteria) || {};
}

/**
 * A stable content id for a release-criteria block (Phase 9 freeze).
 *
 * The criteria decide when basketball may leave shadow. They are frozen BEFORE
 * any shadow row exists, and every row records the id in force when it was
 * written, so a mid-collection edit is detectable rather than silent: the same
 * values always hash to the same id, and any change to a threshold — or to the
 * frozen date — yields a different one. Never throws.
 */
function criteriaId(criteria = releaseCriteria()) {
  const c = criteria || {};
  try {
    const payload = JSON.stringify({
      frozen_at: c.frozen_at || null,
      benchmarkLogLoss: Number.isFinite(c.benchmarkLogLoss) ? c.benchmarkLogLoss : null,
      logLossTolerance: Number.isFinite(c.logLossTolerance) ? c.logLossTolerance : null,
      minSettledGames: Number.isFinite(c.minSettledGames) ? c.minSettledGames : null,
      confidence: Number.isFinite(c.confidence) ? c.confidence : null,
      bootstrap: c.bootstrap || null,
      buckets: c.buckets || null,
      perLeague: c.perLeague || null,
      // AMENDMENT 1 (2026-11-08): the log-loss-gain-vs-scoreTime CI-lower clause
      // is part of the GATE, so it is part of the id. (The `amendments` prose is
      // deliberately NOT hashed — a note edit must not move the criteria id.)
      scoreTimeGain: c.scoreTimeGain || null,
    });
    return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 12);
  } catch (err) {
    return null;
  }
}

/**
 * The frozen criteria id the current block AMENDED (Phase 9 amendment 1).
 * Every row records it alongside the id in force, so evidence collected after an
 * amendment is traceable to both the amended gate and the one it superseded.
 * Returns null when the block carries no dated amendment. Never throws.
 */
function priorCriteriaId(criteria = releaseCriteria()) {
  try {
    const list = criteria && Array.isArray(criteria.amendments) ? criteria.amendments : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const id = list[i] && list[i].prior_criteria_id;
      if (id) return id;
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * The in-game checkpoint a LiveGame represents, in the shape the baselines and
 * the bucket split read. Only the fields they actually use are copied.
 */
function checkpointOf(game) {
  const live = (game && game.live) || {};
  return {
    clock: live.clock || null,
    period: Number(live.period) || 0,
    home_score: game && game.home ? game.home.score : null,
    away_score: game && game.away ? game.away.score : null,
  };
}

/** mulberry32 — the same tiny deterministic PRNG the ship gate bootstrap uses. */
function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nearest-rank percentile of an ascending-sorted array. */
function percentileOf(sorted, q) {
  if (!sorted || !sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx];
}

/** Load the persisted log: { rows, benchmarkLogLoss, criteria, updatedAt } or an empty one. */
function readStore(file = FWD.file) {
  const target = resolveFile(file);
  if (!target) return emptyStore();
  try {
    const json = JSON.parse(fs.readFileSync(target, 'utf8'));
    const rows = Array.isArray(json && json.rows) ? json.rows : [];
    return {
      rows,
      benchmarkLogLoss: Number.isFinite(json && json.benchmarkLogLoss) ? json.benchmarkLogLoss : null,
      criteria: (json && json.criteria) || null,
      shadowCalibratorId: (json && json.shadow_calibrator_id) || null,
      updatedAt: (json && json.updatedAt) || null,
    };
  } catch (err) {
    // No file yet, or a corrupt one: start empty rather than throw on a request.
    return emptyStore();
  }
}

function emptyStore() {
  return { rows: [], benchmarkLogLoss: null, criteria: null, shadowCalibratorId: null, updatedAt: null };
}

let rows = [];
let benchmarkLogLoss = null;
let updatedAt = null;
/**
 * Phase 9 freeze: the release criteria and calibrator version the shadow run
 * started under. Captured from the FIRST shadow row and never overwritten, so a
 * later change is a detectable drift (`shadowSummary.criteria.moved`) rather
 * than a silent re-baseline.
 */
let criteriaSnapshot = null;
let shadowCalibratorId = null;
let loaded = false;
let dirty = false;
let lastWrite = 0;
const verdicts = new Map();

/**
 * Load the persisted log once. Idempotent; safe to call at startup.
 * @param {Object} [opts]
 * @param {string} [opts.file]
 * @param {number|null} [opts.benchmarkLogLoss] backtest log loss to compare against
 */
function init({ file = FWD.file, benchmarkLogLoss: bench = undefined } = {}) {
  const store = FWD.enabled === false ? emptyStore() : readStore(file);
  rows = store.rows;
  benchmarkLogLoss = bench !== undefined ? bench : store.benchmarkLogLoss;
  criteriaSnapshot = store.criteria || null;
  shadowCalibratorId = store.shadowCalibratorId || null;
  updatedAt = store.updatedAt;
  loaded = true;
  dirty = false;
  verdicts.clear();
  return status();
}

function ensure() {
  if (!loaded) init();
}

/** Write the log to disk now (used on settle, at shutdown, and by tests). */
function flush(file = FWD.file) {
  ensure();
  const target = resolveFile(file);
  if (!target) return false;
  const payload = {
    benchmarkLogLoss: Number.isFinite(benchmarkLogLoss) ? benchmarkLogLoss : null,
    // Phase 9 freeze: what the shadow run was collected under. Written once (on
    // the first shadow row) and carried forward, so the artifact documents the
    // frozen criteria and calibrator even after a restart.
    criteria: criteriaSnapshot || null,
    shadow_calibrator_id: shadowCalibratorId || null,
    updatedAt: new Date().toISOString(),
    rows,
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(payload));
  updatedAt = payload.updatedAt;
  dirty = false;
  lastWrite = Date.now();
  return true;
}

/** Throttled write: at most one per persistIntervalMs while serving. */
function maybePersist(now = Date.now(), file = FWD.file) {
  if (!dirty) return false;
  if (now - lastWrite < (FWD.persistIntervalMs || 0)) return false;
  return flush(file);
}

/** Cap the log so an unbounded watch cannot grow the file forever. */
function trim() {
  const max = FWD.maxRows || 0;
  if (max > 0 && rows.length > max) rows = rows.slice(rows.length - max);
}

/** Rows already kept for one game. */
function rowsForGame(gameId) {
  if (gameId == null) return [];
  return rows.filter(r => r.game_id === gameId);
}

/**
 * Append one served probability.
 *
 * Deduplicated on the live state: a repeated poll that returns the SAME rounding
 * of the probability at the same clock/period adds nothing, and a game is capped
 * at `maxRowsPerGame` rows so a long watch cannot dominate the sample.
 *
 * @param {Object} args
 * @param {Object} args.game        Phase 3 LiveGame
 * @param {number} args.probability the home-win probability actually served
 * @param {number} [args.raw]       the pre-calibration probability (diagnostics)
 * @param {number} [args.now]
 * @param {string} [args.source]    'provider' | 'manual' | ...
 * @param {boolean} [args.shadow]   true when this row was computed but WITHHELD
 *   from every client (Phase 9 hold). Shadow rows are kept as evidence but never
 *   counted by evaluate(), so a held pick cannot auto-disable a shipped one.
 * @param {Object} [args.candidates] Phase 10 — the FROZEN candidate columns for
 *   this checkpoint (services/live/shadowCandidates), logged verbatim so the
 *   fresh-data evaluation scores a fixed target. Never invented here.
 * @returns {Object|null} the appended row, or null when it was skipped
 */
function recordServed({ game, probability, raw = null, now = Date.now(), source = null, shadow = false, candidates = null } = {}) {
  ensure();
  if (FWD.enabled === false) return null;
  if (!game || !game.game_id) return null;
  // Hand-typed games never ship a probability, so they must never enter the
  // sample that decides whether the real pick lives or dies.
  if (game.manual) return null;
  if (!Number.isFinite(probability)) return null;

  const existing = rowsForGame(game.game_id);
  if ((FWD.maxRowsPerGame || 0) > 0 && existing.length >= FWD.maxRowsPerGame) return null;

  const p = round4(probability);
  const clock = game.live ? game.live.clock : null;
  const period = game.live ? game.live.period : null;
  const last = existing[existing.length - 1];
  if (last && last.p === p && last.clock === clock && last.period === period) return null;

  const freshness = game.freshness || {};
  const cp = checkpointOf(game);
  // The score-and-time baseline and the elapsed-fraction bucket, both derived
  // from THIS checkpoint only. A failure is recorded as null, never thrown: a
  // logged row must never be lost to a baseline derivation.
  let pScoreTime = null;
  let progress = null;
  let bucket = null;
  try {
    const leagueId = (game.league && game.league.id) || null;
    pScoreTime = round4(BT.scoreTimeProbability(cp, game.sport, leagueId));
    progress = BT.progressFraction(cp, game.sport, leagueId);
    bucket = BT.bucketFor(progress);
  } catch (err) {
    pScoreTime = null;
    progress = null;
    bucket = null;
  }

  const cid = criteriaId();
  // AMENDMENT 1: the id this block superseded, written on every row so evidence
  // collected after the amendment is traceable to both gates.
  const cidPrior = priorCriteriaId();
  const calibId = liveCalibrator.id();

  const row = {
    at: new Date(now).toISOString(),
    at_ms: now,
    game_id: game.game_id,
    sport: game.sport || null,
    league: (game.league && game.league.id) || null,
    market: CONFIG.live.calibration.market,
    p,
    p_raw: round4(raw),
    // The score-and-time baseline at this exact checkpoint, so the shadow
    // summary scores the model against it on the SAME rows (Phase 9).
    p_score_time: pScoreTime,
    // Elapsed fraction and its early/mid/late bucket, frozen ON the row so a
    // later bucket-edge edit cannot silently re-bucket collected evidence.
    progress: Number.isFinite(progress) ? round4(progress) : null,
    bucket,
    // Phase 10 — the FROZEN candidate columns for this exact checkpoint
    // (basketball logistic; soccer empirical table / multinomial logistic /
    // scoreTime). Null when the frozen artifact is absent — never a fabricated
    // number. Carried verbatim so the fresh-data evaluation (>= 500 settled
    // games) scores a fixed target that was never refit on this evidence.
    candidates: candidates || null,
    source: source || game.source || null,
    // true = computed but withheld (shadow evidence), false = actually served.
    shadow: shadow === true,
    data_tier: game.data_tier || null,
    staleness_seconds: Number.isFinite(freshness.age_seconds) ? freshness.age_seconds : null,
    is_stale: freshness.is_stale === true,
    clock,
    period,
    // The frozen release criteria and calibrator version in force right now, so
    // a mid-collection change is visible per row (see shadowSummary). The prior
    // id is the frozen id the current block amended (amendment 1), or null.
    criteria_id: cid,
    criteria_id_prior: cidPrior,
    calibrator_id: calibId,
    y: null,
    settled_at: null,
  };
  rows.push(row);
  if (shadow === true) freezeShadow(cid, calibId);
  trim();
  dirty = true;
  verdicts.clear();
  maybePersist(now);
  return row;
}

/**
 * Capture the release criteria and calibrator version the shadow run started
 * under. Called on every shadow row but only the FIRST one sticks: re-freezing
 * would defeat the point, which is that later rows can be checked against it.
 */
function freezeShadow(cid, calibId) {
  if (!criteriaSnapshot) {
    let block = null;
    try {
      block = JSON.parse(JSON.stringify(releaseCriteria()));
    } catch (err) {
      block = null;
    }
    criteriaSnapshot = { id: cid, block };
  }
  if (!shadowCalibratorId) shadowCalibratorId = calibId || null;
}

/**
 * Bind outcomes to the rows logged for a finished game.
 *
 * @returns {number} how many rows were settled by this call
 */
function settle({ gameId, homeScore, awayScore, now = Date.now() } = {}) {
  ensure();
  if (gameId == null) return 0;
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return 0;
  // Basketball has no draw; an equal score is a push and is graded as neither.
  const y = homeScore > awayScore ? 1 : (homeScore < awayScore ? 0 : null);
  const at = new Date(now).toISOString();
  let count = 0;
  rows.forEach(r => {
    if (r.game_id !== gameId || r.settled_at) return;
    r.y = y;
    // Phase 10 — the final score is frozen onto the row too, so the three-way
    // soccer candidates (home/draw/away) can be graded on the SAME rows the
    // binary basketball column uses: y alone cannot distinguish a draw from a
    // one-goal home win once collapsed to a home/not-home bit.
    r.final_home = homeScore;
    r.final_away = awayScore;
    r.settled_at = at;
    count++;
  });
  if (count) {
    dirty = true;
    verdicts.clear();
    flush();
  }
  return count;
}

/* ------------------------------------------------------------------ metrics */

/** Group graded rows by game (checkpoints inside a game share one outcome). */
function groupByGame(list) {
  const map = new Map();
  list.forEach(r => {
    if (!map.has(r.game_id)) map.set(r.game_id, []);
    map.get(r.game_id).push(r);
  });
  return [...map.values()];
}

/** Rolled-up metrics for a set of rows. */
function summarise(list = rows) {
  const graded = list.filter(r => (r.y === 0 || r.y === 1) && Number.isFinite(r.p));
  const pending = list.filter(r => r.y == null).length;
  const games = groupByGame(graded).length;
  if (!graded.length) {
    return {
      rows: list.length, graded: 0, games: 0, pending, logLoss: null, brier: null, hitRate: null, avgPredicted: null, calibrationGap: null,
    };
  }
  const pairs = graded.map(r => ({ p: r.p, y: r.y }));
  const hits = graded.filter(r => (r.p >= 0.5 ? 1 : 0) === r.y).length;
  const avg = graded.reduce((s, r) => s + r.p, 0) / graded.length;
  return {
    rows: list.length,
    graded: graded.length,
    games,
    pending,
    logLoss: Number(logLoss(pairs).toFixed(4)),
    brier: Number(brierScore(pairs).toFixed(4)),
    hitRate: round4(hits / graded.length),
    avgPredicted: round4(avg),
    calibrationGap: round4(hits / graded.length - avg),
  };
}

/**
 * Auto-disable verdict for one sport, computed over the last `window` settled
 * GAMES and reused for `verdictTtlMs`. Never a hard error: an unknown benchmark
 * or too little data yields an explicit `insufficient`/`no-benchmark` verdict
 * rather than a false "active".
 *
 * @param {string} [sport]
 * @param {number} [now]
 */
function evaluate(sport = 'basketball', now = Date.now()) {
  ensure();
  const cached = verdicts.get(sport);
  if (cached && now - cached.at < (FWD.verdictTtlMs || 0)) return cached.verdict;

  const cfg = FWD;
  const build = (status, reason, extra = {}) => ({
    status,
    reason,
    sport,
    window: cfg.window,
    minEvaluated: cfg.minEvaluated,
    minGames: cfg.minGames,
    logLossTolerance: cfg.logLossTolerance,
    benchmarkLogLoss: Number.isFinite(benchmarkLogLoss) ? round4(benchmarkLogLoss) : null,
    ...extra,
  });

  if (cfg.enabled === false) {
    return cache(sport, now, build('insufficient', 'the forward test is switched off'));
  }

  // Only rows a user actually SAW decide whether the pick lives; shadow rows
  // (computed but withheld) are evidence for the rollout decision, not for
  // retiring a pick no one is being shown yet.
  const settledGames = groupByGame(rows.filter(r => r.sport === sport && r.shadow !== true && (r.y === 0 || r.y === 1) && Number.isFinite(r.p)));
  const windowGames = (cfg.window || 0) > 0 ? settledGames.slice(-cfg.window) : settledGames;
  const windowRows = windowGames.flat();
  const all = summarise(windowRows);

  if (all.games < (cfg.minEvaluated || 0)) {
    return cache(sport, now, build('insufficient', `only ${all.games} settled live games so far (need ${cfg.minEvaluated})`, { metrics: all }));
  }
  if (!Number.isFinite(benchmarkLogLoss)) {
    return cache(sport, now, build('no-benchmark', 'no backtest log loss is recorded to compare against', { metrics: all }));
  }

  const drift = round4(all.logLoss - benchmarkLogLoss);
  if (all.logLoss > benchmarkLogLoss + (cfg.logLossTolerance || 0)) {
    return cache(sport, now, build(
      'disabled',
      `live log loss ${all.logLoss} exceeds the backtest ${round4(benchmarkLogLoss)} by ${drift} (tolerance ${cfg.logLossTolerance}) over the last ${all.games} settled games`,
      { metrics: all, drift },
    ));
  }
  return cache(sport, now, build('active', `live log loss ${all.logLoss} is within ${cfg.logLossTolerance} of the backtest ${round4(benchmarkLogLoss)}`, { metrics: all, drift }));
}

function cache(sport, now, verdict) {
  verdicts.set(sport, { at: now, verdict });
  return verdict;
}

/** Convenience for policy: is this sport's pick currently retired? */
function isDisabled(sport = 'basketball', now = Date.now()) {
  return evaluate(sport, now).status === 'disabled';
}

/**
 * Project shadow rows into the shape ./backtester's game-level bootstrap reads
 * (`gameId`, `p`, a reference column). The forward log keys games as `game_id`,
 * so without this every checkpoint would look like its own game and the
 * interval would fake precision — exactly what the gate refuses to do.
 */
function toBootstrapRows(list) {
  return (Array.isArray(list) ? list : []).map(r => ({
    gameId: r.game_id,
    y: r.y,
    p: r.p,
    p_score_time: r.p_score_time,
  }));
}

/**
 * Percentile bootstrap of the realised model log loss, resampling WHOLE GAMES.
 *
 * Checkpoints inside one game share its outcome, so resampling rows would report
 * an interval narrower than the evidence supports. Same seeded mulberry32 as the
 * ship gate, so the interval is reproducible from the frozen seed.
 */
function gameLogLossBootstrap(games, bootstrapCfg = {}, probKey = 'p') {
  const iterations = Math.max(1, Number(bootstrapCfg.iterations) || 1);
  const usable = (Array.isArray(games) ? games : []).filter(g =>
    g.some(r => (r.y === 0 || r.y === 1) && Number.isFinite(r[probKey])));
  if (!usable.length) return { n: 0, iterations: 0, lower: null, upper: null };

  const rand = mulberry32(Number(bootstrapCfg.seed) || 1);
  const draws = [];
  for (let it = 0; it < iterations; it++) {
    const sample = [];
    for (let i = 0; i < usable.length; i++) {
      const g = usable[Math.floor(rand() * usable.length)];
      for (let j = 0; j < g.length; j++) sample.push(g[j]);
    }
    const pairs = sample
      .filter(r => (r.y === 0 || r.y === 1) && Number.isFinite(r[probKey]))
      .map(r => ({ p: r[probKey], y: r.y }));
    if (pairs.length) draws.push(logLoss(pairs));
  }
  if (!draws.length) return { n: usable.length, iterations, lower: null, upper: null };
  const sorted = draws.slice().sort((a, b) => a - b);
  return {
    n: usable.length,
    iterations,
    lower: round4(percentileOf(sorted, 0.025)),
    upper: round4(percentileOf(sorted, 0.975)),
  };
}

/**
 * Per-bucket sanity from the frozen criteria: each early/mid/late bucket with at
 * least `buckets.minGames` settled games must be within `buckets.tolerance` of
 * the benchmark (a one-sided check — a bucket that beats the benchmark is not a
 * reason to hold). Buckets below the minimum are reported `judged:false`.
 */
function bucketReport(windowRows, rc, bench) {
  const cfg = rc.buckets || {};
  const labels = Array.isArray(cfg.labels) ? cfg.labels : [];
  const minGames = Number.isFinite(cfg.minGames) ? cfg.minGames : 0;
  const tolerance = Number.isFinite(cfg.tolerance) ? cfg.tolerance : null;
  const out = {};
  labels.forEach(label => {
    const seg = windowRows.filter(r => r.bucket === label);
    const s = summarise(seg);
    const judged = minGames > 0 ? s.games >= minGames : s.games > 0;
    out[label] = {
      games: s.games,
      rows: seg.length,
      logLoss: s.logLoss,
      judged,
      withinTolerance: judged && s.logLoss != null && bench != null && tolerance != null
        ? s.logLoss <= bench + tolerance
        : null,
    };
  });
  return out;
}

/**
 * Per-league sanity from the frozen criteria: a league with at least
 * `perLeague.minGames` settled games must be within `perLeague.tolerance` of the
 * benchmark on its own. This is the check that stops a sport-level pass from
 * hiding one league where the model is materially worse than the benchmark.
 */
function leagueReport(windowRows, rc, bench) {
  const cfg = rc.perLeague || {};
  const minGames = Number.isFinite(cfg.minGames) ? cfg.minGames : 0;
  const tolerance = Number.isFinite(cfg.tolerance) ? cfg.tolerance : null;
  const out = {};
  const seen = [...new Set(windowRows.map(r => r.league).filter(Boolean))];
  seen.forEach(league => {
    const seg = windowRows.filter(r => r.league === league);
    const s = summarise(seg);
    const judged = minGames > 0 ? s.games >= minGames : s.games > 0;
    out[league] = {
      games: s.games,
      rows: seg.length,
      logLoss: s.logLoss,
      judged,
      withinTolerance: judged && s.logLoss != null && bench != null && tolerance != null
        ? s.logLoss <= bench + tolerance
        : null,
    };
  });
  return out;
}

/**
 * Shadow verdict for one sport: how the WITHHELD evidence is tracking against
 * the backtest benchmark. Unlike evaluate(), this disables nothing — a shadow
 * pick is shown to nobody, so there is no served pick to retire. It answers the
 * one question the rollout decision needs: have enough settled live games
 * landed, are they within tolerance, and does every bucket/league with enough
 * games agree? Only then may the pick leave shadow.
 *
 * Everything is counted over the last `window` settled shadow GAMES — GAMES, not
 * checkpoints, because checkpoints inside one game share an outcome — and the
 * intervals come from the same whole-game bootstrap the ship gate uses.
 *
 * @param {string} [sport]
 * @param {number} [now]
 */
function shadowSummary(sport = 'basketball', now = Date.now()) {
  ensure();
  const cfg = FWD;
  const rc = releaseCriteria();
  const bootstrapCfg = rc.bootstrap || { iterations: 2000, seed: 11 };

  const shadowRows = rows.filter(r => r.shadow === true && r.sport === sport);
  const graded = shadowRows.filter(r => (r.y === 0 || r.y === 1) && Number.isFinite(r.p));
  // Settled GAMES, not checkpoints.
  const settledGames = groupByGame(graded);
  const windowGames = (cfg.window || 0) > 0 ? settledGames.slice(-cfg.window) : settledGames;
  const windowRows = windowGames.flat();
  const all = summarise(windowRows);

  const bench = Number.isFinite(benchmarkLogLoss) ? round4(benchmarkLogLoss) : null;
  const tolerance = Number.isFinite(rc.logLossTolerance) ? rc.logLossTolerance : (cfg.logLossTolerance || 0);
  const minGames = Number.isFinite(rc.minSettledGames) ? rc.minSettledGames : (cfg.minGames || 0);
  const drift = (all.logLoss != null && bench != null) ? round4(all.logLoss - bench) : null;
  const withinTolerance = (all.logLoss != null && bench != null)
    ? all.logLoss <= bench + tolerance
    : null;

  // 95% game-level bootstrap: the realised log loss, and the same interval as a
  // drift versus the fixed benchmark.
  const logLossCi = gameLogLossBootstrap(windowGames, bootstrapCfg, 'p');
  const vsBenchmark = (logLossCi.lower == null || bench == null)
    ? { lower: null, upper: null }
    : { lower: round4(logLossCi.lower - bench), upper: round4(logLossCi.upper - bench) };

  // The model's own gain over "score and time only", resampled over whole games
  // with the SAME seed, on the same shadow rows.
  const vsScoreTime = BT.gameBootstrap(toBootstrapRows(windowRows), {
    bootstrap: bootstrapCfg,
    probKey: 'p',
    referenceKey: 'p_score_time',
  });

  const byBucket = bucketReport(windowRows, rc, bench);
  const byLeague = leagueReport(windowRows, rc, bench);

  const enoughGames = all.games >= minGames;
  const bucketOk = Object.values(byBucket).every(b => b.judged !== true || b.withinTolerance === true);
  const leagueOk = Object.values(byLeague).every(l => l.judged !== true || l.withinTolerance === true);
  // AMENDMENT 1 (2026-11-08): the 95% game-level interval for the log-loss gain
  // over the score-and-time baseline must exclude zero. The benchmark tolerance
  // above is looser than the model's whole gain over scoreTime, so passing it
  // does NOT by itself show the model beats "score and time only".
  const gainCfg = rc.scoreTimeGain || {};
  const minLogLossGainCiLower = Number.isFinite(gainCfg.minLogLossGainCiLower)
    ? gainCfg.minLogLossGainCiLower
    : 0;
  const logLossGainCiLower = vsScoreTime.logLossGain ? vsScoreTime.logLossGain.lower : null;
  const scoreTimeGainOk = logLossGainCiLower != null && logLossGainCiLower >= minLogLossGainCiLower;

  const readyReasons = [];
  if (!enoughGames) readyReasons.push(`only ${all.games} settled shadow games (need ${minGames})`);
  if (withinTolerance !== true) readyReasons.push('the realised log loss is not within tolerance of the benchmark');
  if (!bucketOk) readyReasons.push('a time bucket with enough games is outside tolerance');
  if (!leagueOk) readyReasons.push('a league with enough games is outside tolerance');
  if (!scoreTimeGainOk) {
    readyReasons.push(logLossGainCiLower == null
      ? 'the log-loss gain over scoreTime could not be interval-scored yet'
      : `the log-loss gain over scoreTime is not confidently above ${minLogLossGainCiLower} (95% CI lower bound ${logLossGainCiLower})`);
  }
  const ready = readyReasons.length === 0;

  const currentCriteriaId = criteriaId();
  const currentCalibratorId = liveCalibrator.id();

  return {
    sport,
    shadow: true,
    enabled: cfg.enabled !== false,
    rows: shadowRows.length,
    graded_rows: graded.length,
    // How many window rows could be scored against the score-and-time baseline.
    score_time_rows: windowRows.filter(r => Number.isFinite(r.p_score_time)).length,
    games: all.games,
    pending: shadowRows.filter(r => r.y == null).length,
    logLoss: all.logLoss,
    brier: all.brier,
    hitRate: all.hitRate,
    benchmarkLogLoss: bench,
    drift,
    withinTolerance,
    logLossTolerance: tolerance,
    minGames,
    confidence: Number.isFinite(rc.confidence) ? rc.confidence : 0.95,
    // 95% game-level bootstrap interval for the realised log loss, and the same
    // interval expressed as a drift versus the benchmark.
    logLossCi,
    vsBenchmark,
    // The model's gain over "score and time only" on the same games (its own
    // 95% interval; a lower bound below zero means the model is not clearly
    // better than the baseline on the live evidence).
    vsScoreTime: {
      brierGain: vsScoreTime.brierGain,
      logLossGain: vsScoreTime.logLossGain,
      games: vsScoreTime.games,
      iterations: vsScoreTime.iterations,
    },
    // AMENDMENT 1 clause: the gate requires the log-loss-gain-vs-scoreTime
    // interval lower bound to be >= `minLogLossGainCiLower` (0).
    scoreTimeGain: {
      minLogLossGainCiLower,
      logLossGainCiLower,
      ok: scoreTimeGainOk,
    },
    byBucket,
    byLeague,
    // Frozen-criteria integrity: an id drift means collected evidence no longer
    // answers the frozen question and the run must be restarted. `prior_id` is
    // the frozen id amendment 1 superseded (null when there is no amendment).
    criteria: {
      id: currentCriteriaId,
      prior_id: priorCriteriaId(),
      frozen_id: criteriaSnapshot ? criteriaSnapshot.id : null,
      frozen_at: criteriaSnapshot && criteriaSnapshot.block
        ? criteriaSnapshot.block.frozen_at
        : (rc.frozen_at || null),
      amendments: Array.isArray(rc.amendments) ? rc.amendments : [],
      moved: Boolean(criteriaSnapshot && criteriaSnapshot.id && criteriaSnapshot.id !== currentCriteriaId),
    },
    calibrator: {
      id: currentCalibratorId,
      frozen_id: shadowCalibratorId || null,
      moved: Boolean(shadowCalibratorId && shadowCalibratorId !== currentCalibratorId),
    },
    ready,
    ready_reasons: readyReasons,
  };
}

/* --------------------------------------------------- confirmation dataset */

/** How many settled-GAMES every sport must reach before the one-shot run. */
function confirmationMinGames() {
  // The confirmation dataset is a PHASE 10 / ship-gate concept: the user's
  // requirement is >= 500 settled GAMES per sport, which is exactly the ship
  // gate's `minGames`. The Phase 9 release criteria (minSettledGames 300) gate
  // the ROLLING shadow summary, not this one-shot dataset, so it is only a
  // fallback here — reading it first would silently set the target to 300.
  const sg = CONFIG.liveBacktest && CONFIG.liveBacktest.shipGate;
  if (sg && Number.isFinite(sg.minGames)) return sg.minGames;
  if (FWD.minGames > 0) return FWD.minGames;
  const rc = releaseCriteria();
  if (Number.isFinite(rc.minSettledGames)) return rc.minSettledGames;
  return 500;
}

/** The frozen candidate artifact's freeze instant as { iso, ms }. */
function confirmationFreeze() {
  return shadowCandidates.frozenAt();
}

/**
 * Phase 10 round D — the CONFIRMATION dataset.
 *
 * Every earlier "fresh" window was actually a SLIDING window: Oct 1 - Nov 12
 * overlapped Sep 27 - Nov 8 by ~5 weeks, so most of its games had already been
 * scored and were no longer unseen. From this round on, the ONLY dataset that
 * may decide a release is the set of shadow rows logged STRICTLY AFTER the
 * candidate artifact was frozen (`shadow-candidates-1.0.0`'s `frozen_at_ms`).
 * It is evaluated ONCE, and only once it holds >= `confirmationMinGames()`
 * settled GAMES per sport.
 *
 * `pre_freeze_rows`/`pre_freeze_games` are the rows that predate the freeze —
 * already-scored sliding-window evidence that must never be counted as unseen.
 *
 * @param {string} [sport]
 * @returns {Object}
 */
function confirmationSummary(sport = 'basketball') {
  ensure();
  const frozen = confirmationFreeze();
  const freezeMs = frozen.ms;
  const minGames = confirmationMinGames();

  const shadowRows = rows.filter(r => r.shadow === true && r.sport === sport);
  const timestamped = shadowRows.filter(r => Number.isFinite(r.at_ms));
  // Without a recorded freeze instant we cannot claim any row is unseen, so the
  // dataset is empty rather than silently reusing old evidence.
  const preFreeze = freezeMs != null ? timestamped.filter(r => r.at_ms < freezeMs) : shadowRows;
  const confRows = freezeMs != null ? timestamped.filter(r => r.at_ms >= freezeMs) : [];

  const graded = confRows.filter(r => (r.y === 0 || r.y === 1) && Number.isFinite(r.p));
  const settledGames = groupByGame(graded);
  const all = summarise(confRows);

  // Item 3 (round E) — NO PEEKING. Until the sport holds the target number of
  // settled GAMES the confirmation surface exposes COUNTS ONLY: no Brier, no
  // log loss, no calibration. The metrics are computed in a single pass only
  // once the sport is ready, and that one pass is what the ledger records.
  const ready = settledGames.length >= minGames;
  const perf = ready
    ? { logLoss: all.logLoss, brier: all.brier, hitRate: all.hitRate }
    : { logLoss: null, brier: null, hitRate: null };

  return {
    sport,
    dataset: 'shadow rows logged after the candidate freeze timestamp, evaluated once',
    artifact_version: shadowCandidates.version(),
    frozen_at: frozen.iso,
    frozen_at_ms: freezeMs,
    min_settled_games: minGames,
    // Rows logged BEFORE the freeze: sliding-window evidence, already seen, and
    // deliberately NOT counted toward the confirmation sample.
    pre_freeze_rows: preFreeze.length,
    pre_freeze_games: groupByGame(preFreeze).length,
    rows: confRows.length,
    settled_games: settledGames.length,
    settled_rows: graded.length,
    pending_games: groupByGame(confRows.filter(r => r.y == null)).length,
    ...perf,
    // The run is made by hand, ONCE, and only when the sport is over the minimum.
    ready_to_evaluate: ready,
    evaluated: false,
    peeking_guarded: true,
  };
}

/* ---------------------------------------------------------- rollout progress */

/**
 * Phase 10 round D — rollout progress toward the confirmation target.
 *
 * Settled GAMES per sport and per league on the confirmation dataset, plus a
 * first-order estimate of when each reaches the target, extrapolated from the
 * observed settlement rate (settled games per day since the freeze). With no
 * settled games yet no rate exists, so the estimate is null — never a
 * fabricated date. A sport/league already at the target reports an ETA of now.
 */
function progress({ target = null, now = Date.now() } = {}) {
  ensure();
  const goal = Number.isFinite(target) ? target : confirmationMinGames();
  const frozen = confirmationFreeze();
  const freezeMs = frozen.ms;
  const elapsedDays = freezeMs != null ? Math.max((now - freezeMs) / 86400000, 0) : 0;

  const conf = rows.filter(r => r.shadow === true
    && (freezeMs != null ? (Number.isFinite(r.at_ms) && r.at_ms >= freezeMs) : false));
  const graded = conf.filter(r => (r.y === 0 || r.y === 1) && Number.isFinite(r.p));

  const tally = (list) => {
    const s = summarise(list);
    const games = s.games;
    const rate = elapsedDays > 0 ? games / elapsedDays : null;
    const remaining = Math.max(goal - games, 0);
    let etaDays = null;
    let etaAt = null;
    if (remaining === 0) {
      etaDays = 0;
      etaAt = new Date(now).toISOString();
    } else if (rate != null && rate > 0) {
      etaDays = round4(remaining / rate);
      etaAt = new Date(now + (remaining / rate) * 86400000).toISOString();
    }
    // Item 3 (round E) — COUNTS, RATES and ETA only. No Brier / log loss /
    // calibration is exposed here until the sport is ready, so the rollout
    // cannot be read as performance while it is still accruing.
    return {
      settled_games: games,
      settled_rows: s.graded,
      target: goal,
      remaining,
      rate_per_day: rate == null ? null : round4(rate),
      eta_days: etaDays,
      eta_at: etaAt,
      at_target: remaining === 0,
    };
  };

  const perSport = {};
  const perLeague = {};
  [...new Set(graded.map(r => r.sport).filter(Boolean))].forEach(sport => {
    const list = graded.filter(r => r.sport === sport);
    perSport[sport] = tally(list);
    [...new Set(list.map(r => r.league).filter(Boolean))].forEach(league => {
      perLeague[`${sport}/${league}`] = tally(list.filter(r => r.league === league));
    });
  });

  return {
    target: goal,
    frozen_at: frozen.iso,
    frozen_at_ms: freezeMs,
    elapsed_days: round4(elapsedDays),
    note: 'ETA extrapolates settled games per day since the candidate freeze; null until a settled game exists.',
    per_sport: perSport,
    per_league: perLeague,
  };
}

/** Read-only view for the stats/diagnostics surface. */
function status() {
  ensure();
  return {
    enabled: FWD.enabled !== false,
    file: FWD.file,
    rows: rows.length,
    shadowRows: rows.filter(r => r.shadow === true).length,
    // Phase 10 round D — the candidate freeze instant the confirmation dataset
    // accrues from, surfaced so a reader can see when the clock started.
    candidates_version: shadowCandidates.version(),
    candidates_frozen_at: confirmationFreeze().iso,
    candidates_frozen_at_ms: confirmationFreeze().ms,
    benchmarkLogLoss: Number.isFinite(benchmarkLogLoss) ? round4(benchmarkLogLoss) : null,
    // Phase 9 freeze: the criteria id in force and the calibrator version the
    // shadow run was frozen under (null until the first shadow row lands). The
    // prior id is the frozen id amendment 1 superseded.
    criteria_id: criteriaId(),
    criteria_id_prior: priorCriteriaId(),
    shadow_criteria_id: criteriaSnapshot ? criteriaSnapshot.id : null,
    shadow_calibrator_id: shadowCalibratorId || null,
    updatedAt,
  };
}

/** Test/dev helper — drop everything and reload from disk on next use. */
function reset({ benchmarkLogLoss: bench = undefined } = {}) {
  rows = [];
  benchmarkLogLoss = bench !== undefined ? bench : null;
  criteriaSnapshot = null;
  shadowCalibratorId = null;
  updatedAt = null;
  loaded = false;
  dirty = false;
  lastWrite = 0;
  verdicts.clear();
}

module.exports = {
  init,
  recordServed,
  settle,
  summarise,
  evaluate,
  isDisabled,
  shadowSummary,
  confirmationSummary,
  confirmationMinGames,
  confirmationFreeze,
  progress,
  status,
  flush,
  reset,
  groupByGame,
  resolveFile,
  criteriaId,
  priorCriteriaId,
  releaseCriteria,
};
