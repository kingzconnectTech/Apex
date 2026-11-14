/**
 * live/shadowCandidates.js
 *
 * Phase 10 — the FROZEN shadow-candidate columns.
 *
 * The evaluator (scripts/run-live-phase10-report.js) fits candidate models once
 * on TRAIN + VALIDATION and freezes them into a versioned artifact
 * (CONFIG.live.shadow.candidates.file). This module reads that artifact and
 * scores the candidates at the SAME checkpoint as a shadow row, so
 * forwardTest.recordServed can log them alongside the production figure. The
 * fresh-data evaluation (>= 500 settled games) then has a fixed target that was
 * never refit on the evidence it is judged against.
 *
 * Candidates:
 *   - basketball_logistic    a per-league logistic on margin / sqrt(minutes
 *                            remaining), with a sport-wide fallback.
 *   - soccer_table           the smoothed empirical P(home/draw/away | minute,
 *                            capped goal difference, red state).
 *   - soccer_mnl             a regularised multinomial logistic on goal
 *                            difference, time remaining, their interaction,
 *                            red-card state and total goals.
 *   - soccer_score_time      the current score-and-time three-way baseline.
 *
 * The artifact is READ-ONLY: nothing is ever refit here. When it is missing (or
 * a candidate cannot be scored at this checkpoint) the column is null — never a
 * fabricated number. Everything is wrapped so a scoring failure can never throw
 * into a request or a scheduled sweep.
 */

const fs = require('fs');
const path = require('path');

const CONFIG = require('./config');
const M = require('./liveMath');
const { sigmoid } = require('../basketball/calibration');

const CFG = (CONFIG.live && CONFIG.live.shadow && CONFIG.live.shadow.candidates) || {};
const BACKEND_DIR = path.join(__dirname, '..', '..');

/**
 * Phase 10 round D — the probability clip band. Every scored candidate is
 * clipped to this inclusive range so no column can emit a literal 0 or 1, even
 * at an extreme checkpoint. Applied at SCORE time only; the frozen artifact is
 * never rewritten (its ids are frozen for the confirmation run).
 */
const CLIP = (CONFIG.live && CONFIG.live.probabilityClip) || { lower: 0.01, upper: 0.99 };

// The soccer empirical table is keyed on the backtest's cumulative-minute
// checkpoints; a live clock is snapped to the nearest one (see soccerTable).
const SOCCER_MINUTES = (CONFIG.liveBacktest.checkpoints.soccer.minutes || []).slice();
const SOCCER_DIFF_CAP = 3;
const SOCCER_REGULATION_MINUTES = 90;

// Per-league period structure, used only when the artifact does not carry it.
const BB_LEAGUE_DEFAULT = { periods: 4, periodMinutes: 12, otMinutes: 5 };

let artifact = null;
let loaded = false;

/** Resolve the config-relative artifact path to an absolute one. */
function resolveFile(file = CFG.file) {
  if (!file) return null;
  return path.isAbsolute(file) ? file : path.join(BACKEND_DIR, file);
}

/** Load (once) the frozen candidate artifact; null when absent or disabled. */
function load() {
  if (loaded) return artifact;
  loaded = true;
  if (CFG.enabled === false) { artifact = null; return artifact; }
  try {
    const target = resolveFile();
    artifact = target ? JSON.parse(fs.readFileSync(target, 'utf8')) : null;
  } catch (err) {
    // No artifact yet, or a corrupt one: log no candidate column rather than throw.
    artifact = null;
  }
  return artifact;
}

/** Test/dev helper — drop the artifact and read it again on next use. */
function reset() { artifact = null; loaded = false; }

/** The frozen artifact's version string, or null when unloaded. */
function version() {
  const a = load();
  return (a && a.version) || null;
}

/** The frozen id of every candidate, for status/report surfaces. */
function ids() {
  const a = load() || {};
  const idOf = k => (a[k] && a[k].id) || null;
  return {
    version: a.version || null,
    basketball_logistic: idOf('basketball_logistic'),
    soccer_table: idOf('soccer_table'),
    soccer_mnl: idOf('soccer_mnl'),
    soccer_score_time: idOf('soccer_score_time'),
  };
}

function round4(v) {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(4));
}

/** Clip one probability to the configured band (never 0 or 1). */
function clipProb(v) {
  if (!Number.isFinite(v)) return v;
  return M.clamp(v, CLIP.lower, CLIP.upper);
}

/**
 * Clip a three-way distribution and renormalise, so the parts still sum to 1.
 * A literal 0/1 in any leg is lifted off the boundary but the relative ordering
 * the model produced is preserved.
 */
function clipTriple(p) {
  const c = p.map(clipProb);
  const sum = c.reduce((t, v) => t + v, 0) || 1;
  return { home: round4(c[0] / sum), draw: round4(c[1] / sum), away: round4(c[2] / sum) };
}

/** The frozen artifact's freeze instant as { iso, ms }, or nulls when unloaded. */
function frozenAt() {
  const a = load();
  const iso = (a && a.frozen_at) || null;
  const ms = (a && Number.isFinite(a.frozen_at_ms)) ? a.frozen_at_ms
    : (iso ? Date.parse(iso) : NaN);
  return { iso, ms: Number.isFinite(ms) ? ms : null };
}

/* ------------------------------------------------------------- basketball */

function bbLeagueConfig(league, block) {
  const fromArtifact = block && block.leagues ? block.leagues[String(league)] : null;
  if (fromArtifact && Number.isFinite(fromArtifact.periods) && Number.isFinite(fromArtifact.periodMinutes)) {
    return fromArtifact;
  }
  return BB_LEAGUE_DEFAULT;
}

/**
 * The frozen basketball logistic: P(home win) = sigmoid(intercept + slope * x),
 * x = margin / sqrt(minutes remaining). An overtime checkpoint counts only the
 * current OT period's clock (the number of future OTs is unknowable).
 */
function basketballLogistic(game, block) {
  if (!block) return null;
  const live = game.live || {};
  const clock = M.parseClock(live.clock);
  const period = Number(live.period) || 0;
  if (!clock || period < 1) return null;

  const L = bbLeagueConfig(game.league && game.league.id, block);
  const home = game.home && Number.isFinite(game.home.score) ? game.home.score : 0;
  const away = game.away && Number.isFinite(game.away.score) ? game.away.score : 0;
  const margin = home - away;
  const remaining = period <= L.periods
    ? (L.periods - period) * L.periodMinutes + clock.minutes
    : clock.minutes;
  const x = margin / Math.sqrt(Math.max(remaining, 0.25));

  const league = String((game.league && game.league.id) || '');
  const l = block.byLeague ? block.byLeague[league] : null;
  const a = l ? l.intercept : (block.sportWide && block.sportWide.intercept);
  const b = l ? l.slope : (block.sportWide && block.sportWide.slope);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(x)) return null;
  return round4(clipProb(sigmoid(a + b * x)));
}

/* ----------------------------------------------------------------- soccer */

/** Elapsed match minute from a soccer clock ("34'" -> 34, "90+4'" -> 94). */
function soccerMinuteOf(game) {
  const clock = M.parseClock(game.live && game.live.clock);
  return clock ? clock.minutes : null;
}

/** Snap a live minute to the nearest empirical-table checkpoint minute. */
function snapMinute(minute) {
  if (!SOCCER_MINUTES.length) return null;
  let best = SOCCER_MINUTES[0];
  let bestDist = Math.abs(minute - best);
  for (let i = 1; i < SOCCER_MINUTES.length; i++) {
    const d = Math.abs(minute - SOCCER_MINUTES[i]);
    if (d < bestDist) { bestDist = d; best = SOCCER_MINUTES[i]; }
  }
  return best;
}

/**
 * Empirical-table lookup at the nearest checkpoint minute. The table is keyed on
 * a CAPPED goal difference and a red-card state; the production path supplies no
 * red-card state, so the red-pooled cell is used.
 */
function soccerTable(block, { minute, home, away, thin = null } = {}) {
  if (!block || !block.table) return null;
  const snapped = snapMinute(minute);
  if (snapped == null) return null;
  const diff = M.clamp(home - away, -SOCCER_DIFF_CAP, SOCCER_DIFF_CAP);
  const key = `${snapped}|none|${diff}`;
  const cell = block.table[key] || block.table[`${snapped}|none|0`];
  if (!cell) return null;
  const out = { ...clipTriple([cell.home, cell.draw, cell.away]), minute: snapped };
  // Phase 10 round D — flag a cell whose RAW row count is below the table's
  // minimum, so a thin cell is visible wherever the estimate is read. The
  // artifact's own `n` is the pooled count; the raw cell count rides alongside
  // in `table_thin_cells` (kept OUTSIDE the hashed block so the frozen id holds).
  const rawN = thin && thin[key] != null ? Number(thin[key]) : null;
  if (rawN != null && Number.isFinite(rawN) && rawN < (block.minCell || 30)) out.thin = true;
  return out;
}

const MNL_FEATURES = ['goal_diff', 'remaining_frac', 'diff_x_sqrt_remaining', 'red_net', 'total_goals'];

/**
 * The frozen multinomial-logistic probability for one soccer checkpoint, using
 * the artifact's stored standardiser (mu/sd) and weights. No refit.
 */
function soccerMnl(block, { minute, home, away, redNet = 0 }) {
  if (!block || !block.weights) return null;
  if (!block.weights.home || !block.weights.draw || !block.weights.away) return null;
  const mu = block.mu;
  const sd = block.sd;
  if (!Array.isArray(mu) || !Array.isArray(sd)) return null;

  const remainingMin = Math.max(0, SOCCER_REGULATION_MINUTES - minute);
  const diff = home - away;
  const x = [
    diff,
    remainingMin / SOCCER_REGULATION_MINUTES,
    diff * Math.sqrt(remainingMin),
    redNet,
    home + away,
  ];
  const xs = x.map((v, j) => (v - mu[j]) / (sd[j] || 1));
  const z = ['home', 'draw', 'away'].map(k => {
    const w = block.weights[k];
    let s = w[0];
    for (let j = 0; j < xs.length; j++) s += w[j + 1] * xs[j];
    return s;
  });
  const mx = Math.max(...z);
  const ex = z.map(v => Math.exp(v - mx));
  const denom = ex.reduce((t, v) => t + v, 0) || 1;
  return clipTriple(ex.map(v => v / denom));
}

/** The current score-and-time three-way baseline (plain Poisson, global rates). */
function soccerScoreTime({ minute, home, away }) {
  const s = CONFIG.liveBacktest.baselines.scoreTime.soccer;
  const elapsed = M.clamp(minute, 0, s.regulationMinutes);
  const fraction = (s.regulationMinutes - elapsed) / s.regulationMinutes;
  const lh = s.fullHomeGoals * fraction;
  const la = s.fullAwayGoals * fraction;
  let h = 0; let d = 0; let a = 0;
  for (let i = 0; i <= s.maxRemainingGoals; i++) {
    const ph = M.poissonPmf(i, lh);
    if (!ph) continue;
    for (let j = 0; j <= s.maxRemainingGoals; j++) {
      const p = ph * M.poissonPmf(j, la);
      if (!p) continue;
      const fh = home + i; const fa = away + j;
      if (fh > fa) h += p; else if (fh === fa) d += p; else a += p;
    }
  }
  const sum = h + d + a;
  if (!(sum > 0)) return null;
  return clipTriple([h / sum, d / sum, a / sum]);
}

/* ------------------------------------------------------------- dispatcher */

/**
 * The frozen candidate columns for one LiveGame checkpoint, or null when the
 * artifact is absent or the game cannot be scored. Never throws.
 *
 * @param {Object} args
 * @param {Object} args.game Phase 3 LiveGame
 * @returns {Object|null}
 */
function candidatesFor({ game } = {}) {
  try {
    const a = load();
    if (!a || !game || !game.sport) return null;

    const out = { version: a.version || null };
    // Phase 10 round D — every row carries the frozen candidate IDS, so a
    // collected row is self-describing: which exact models produced its columns,
    // independent of the artifact file at read time.
    out.ids = ids();

    if (game.sport === 'basketball') {
      out.basketball_logistic = basketballLogistic(game, a.basketball_logistic);
    } else if (game.sport === 'soccer') {
      const minute = soccerMinuteOf(game);
      const home = game.home && Number.isFinite(game.home.score) ? game.home.score : null;
      const away = game.away && Number.isFinite(game.away.score) ? game.away.score : null;
      if (minute != null && home != null && away != null) {
        out.soccer_minute = round4(minute);
        out.soccer_table = soccerTable(a.soccer_table, { minute, home, away, thin: a.table_thin_cells });
        out.soccer_mnl = soccerMnl(a.soccer_mnl, { minute, home, away });
        out.soccer_score_time = soccerScoreTime({ minute, home, away });
      }
    }

    // Nothing usable (unknown sport, or no scorable checkpoint): write no row
    // column at all rather than an empty object. `version` and `ids` are
    // bookkeeping, so they never make an otherwise-empty column look usable.
    const any = Object.keys(out).some(k => k !== 'version' && k !== 'ids' && out[k] != null);
    return any ? out : null;
  } catch (err) {
    return null;
  }
}

module.exports = {
  load,
  reset,
  version,
  ids,
  frozenAt,
  resolveFile,
  candidatesFor,
  clipProb,
  clipTriple,
  // exported for tests
  basketballLogistic,
  soccerTable,
  soccerMnl,
  soccerScoreTime,
  snapMinute,
};
