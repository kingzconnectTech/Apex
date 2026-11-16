/**
 * live/store/counters.js
 *
 * Phase 10 round I (item 1) — the AGGREGATE counters kept beside the rows in
 * `live_shadow/meta`.
 *
 * Until this round the only way to know how much evidence existed was to load
 * the WHOLE `rows` subcollection. On the Firestore free tier that read grows
 * linearly with the collection (tens of thousands of documents), so the startup
 * path could not stay "read every row". Instead the three things the diagnostic
 * surfaces actually need are kept as compact counters, updated as rows are
 * written:
 *
 *   - rows_by_day               { 'YYYY-MM-DD': n }   rows written per UTC day
 *   - settled_games_by_sport    { 'basketball': n }   distinct settled GAMES
 *   - settled_games_by_league   { 'basketball::nba': n } (keyed by a SAFE token)
 *   - league_labels             { 'basketball::nba': 'basketball/nba' } the exact
 *                               label each safe token stands for (never counted)
 *   - first_row_at / first_row_at_ms   the earliest row's time (set once)
 *   - last_row_at  / last_row_at_ms    the latest row's time
 *
 * The Firestore backend keeps these counters by INCREMENTING them atomically in
 * the same write as the rows (FieldValue.increment on the nested day/sport/league
 * fields); the file backend simply derives them from the whole (local, bounded)
 * row set. Both paths share the helpers here so a counter means the same thing on
 * either backend.
 *
 * Round I (item 2) — SAFE KEYS. A counter key becomes a nested Firestore field
 * name, and real league codes carry characters that a field path cannot hold:
 * dots ('eng.1', 'uefa.champions') would be read as further nesting, so a
 * settled 'uefa.champions' would land under 'uefa' -> 'champions'. Every key is
 * therefore SANITISED to [A-Za-z0-9_] ('::' kept only as the sport/league
 * separator) and the exact 'sport/league' label is kept beside it in
 * `league_labels` — so sanitising never loses the real code for display.
 *
 * Round J (item 6) — LABELS FROM THE CONFIGURED LIST. `league_labels` is only
 * written when a game is logged, so a counter document from before this round
 * (or one whose label entry is missing) would otherwise show the SANITISED key
 * ('soccer::uefa_champions') as if it were the real code. `labelFor` therefore
 * falls back to a reverse map built from the CONFIGURED league sweep list
 * (CONFIG.matcher.sweep), which always knows the true 'sport/league' for every
 * league we log — so the display is exact even with no `league_labels` entry.
 */

const CONFIG = require('../config');

function blank() {
  return {
    rows_by_day: {},
    settled_games_by_sport: {},
    settled_games_by_league: {},
    league_labels: {},
    first_row_at: null,
    first_row_at_ms: null,
    last_row_at: null,
    last_row_at_ms: null,
  };
}

/**
 * Make one key component safe as a Firestore field name. Dots are the real
 * hazard (a field path splits on them); hyphens and colons are legal, but the
 * whole class is folded to '_' so a key is unambiguously one field name. The
 * league codes come from ESPN ('nba', 'eng.1', 'uefa.champions',
 * 'mens-college-basketball'), none of which contain '_', so the substitution is
 * unambiguous. The exact label is preserved separately in `league_labels`.
 */
function sanitizeKey(part) {
  return String(part == null ? '' : part).replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Storage key for a (sport, league) pair: both parts sanitised, joined by '::'
 * (the colon itself can never appear in a sanitised part, so the split back is
 * unambiguous). e.g. 'soccer' + 'uefa.champions' -> 'soccer::uefa_champions'.
 */
function leagueKey(sport, league) {
  if (!sport || !league) return null;
  return `${sanitizeKey(sport)}::${sanitizeKey(league)}`;
}

/** The UTC day bucket a timestamp falls in. */
function dayKey(atMs) {
  if (!Number.isFinite(atMs)) return null;
  return new Date(atMs).toISOString().slice(0, 10);
}

/** Fold one row's time into the rows_by_day counter and the first/last bounds. */
function addRow(c, row) {
  if (!c || !row) return c;
  const day = dayKey(row.at_ms);
  if (day) c.rows_by_day[day] = (c.rows_by_day[day] || 0) + 1;
  touchTime(c, row.at_ms, row.at);
  return c;
}

/** Set/extend the first (min) and last (max) row-time bounds. */
function touchTime(c, ms, iso) {
  if (!c || !Number.isFinite(ms)) return c;
  const stamp = iso || new Date(ms).toISOString();
  if (!Number.isFinite(c.first_row_at_ms) || ms < c.first_row_at_ms) {
    c.first_row_at_ms = ms;
    c.first_row_at = stamp;
  }
  if (!Number.isFinite(c.last_row_at_ms) || ms > c.last_row_at_ms) {
    c.last_row_at_ms = ms;
    c.last_row_at = stamp;
  }
  return c;
}

/** Count ONE newly settled game (call once per game, not per row). */
function addSettledGame(c, { sport = null, league = null } = {}) {
  if (!c) return c;
  if (sport) c.settled_games_by_sport[sport] = (c.settled_games_by_sport[sport] || 0) + 1;
  const key = leagueKey(sport, league);
  if (key) {
    c.settled_games_by_league[key] = (c.settled_games_by_league[key] || 0) + 1;
    // Round I (item 2) — remember the EXACT 'sport/league' the safe token stands
    // for, so a sanitised key ('soccer::uefa_champions') is never shown as if it
    // were the real league code ('soccer/uefa.champions').
    if (!c.league_labels) c.league_labels = {};
    if (!c.league_labels[key]) c.league_labels[key] = `${sport}/${league}`;
  }
  return c;
}

/** Add every counter in `source` onto `target` (numeric maps add, times widen). */
function mergeInto(target, source) {
  if (!target || !source) return target;
  Object.entries(source.rows_by_day || {}).forEach(([day, n]) => {
    target.rows_by_day[day] = (target.rows_by_day[day] || 0) + (Number(n) || 0);
  });
  Object.entries(source.settled_games_by_sport || {}).forEach(([sport, n]) => {
    target.settled_games_by_sport[sport] = (target.settled_games_by_sport[sport] || 0) + (Number(n) || 0);
  });
  Object.entries(source.settled_games_by_league || {}).forEach(([key, n]) => {
    target.settled_games_by_league[key] = (target.settled_games_by_league[key] || 0) + (Number(n) || 0);
  });
  if (!target.league_labels) target.league_labels = {};
  Object.entries(source.league_labels || {}).forEach(([key, label]) => {
    if (!target.league_labels[key]) target.league_labels[key] = label;
  });
  touchTime(target, source.first_row_at_ms, source.first_row_at);
  touchTime(target, source.last_row_at_ms, source.last_row_at);
  return target;
}

/**
 * Derive the whole counter set from an in-memory row list (the file backend, and
 * the one-off evaluation). Exact, because every row is present.
 */
function fromRows(list) {
  const c = blank();
  const rows = Array.isArray(list) ? list : [];
  const settledGame = new Map();
  rows.forEach(r => {
    addRow(c, r);
    if ((r.y === 0 || r.y === 1) && r.game_id != null && !settledGame.has(r.game_id)) {
      settledGame.set(r.game_id, r);
    }
  });
  settledGame.forEach(r => addSettledGame(c, { sport: r.sport, league: r.league }));
  return c;
}

/** Total rows ever written (sum of the day buckets). */
function totalRows(c) {
  if (!c) return 0;
  return Object.values(c.rows_by_day || {}).reduce((s, n) => s + (Number(n) || 0), 0);
}

/**
 * Rows written in the last `ms`. Day-aligned APPROXIMATION: the counters are
 * bucketed by UTC day, so this sums every day bucket at or after the day the
 * window opens (up to ~2 calendar days of rows for a 24h window). Cheaper than
 * a per-day distinct-games breakdown and accurate to the day.
 */
function rowsLast24h(c, { now = Date.now(), ms = 24 * 60 * 60 * 1000 } = {}) {
  if (!c) return 0;
  const fromDay = dayKey(now - ms);
  if (!fromDay) return 0;
  return Object.entries(c.rows_by_day || {})
    .filter(([day]) => day >= fromDay)
    .reduce((s, [, n]) => s + (Number(n) || 0), 0);
}

/**
 * The rows-per-day series, `[{ date, rows }]` ascending, at or after the day
 * `sinceMs` falls in. This is the shape the health block reports as
 * `daily_since_freeze` — counts only, no probabilities.
 */
function buckets(c, { sinceMs = null } = {}) {
  if (!c) return [];
  const sinceDay = Number.isFinite(sinceMs) ? dayKey(sinceMs) : null;
  return Object.entries(c.rows_by_day || {})
    .filter(([day]) => !sinceDay || day >= sinceDay)
    .map(([date, rows]) => ({ date, rows: Number(rows) || 0 }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Turn a stored safe 'sport::league' key back into 'sport/league' (sanitised). */
function leagueLabel(key) {
  return typeof key === 'string' ? key.replace('::', '/') : key;
}

/**
 * Round J (item 6) — the reverse map from a SANITISED counter key to the EXACT
 * 'sport/league', built from the CONFIGURED league sweep list
 * (CONFIG.matcher.sweep). This is the fallback when `league_labels` has no
 * entry: the configured list always knows the true code ('soccer/uefa.champions',
 * 'basketball/mens-college-basketball'), so a dotted or hyphenated league is
 * never shown as its sanitised form. Rebuilt per call (the list is tiny and
 * static) so a test that reshapes the config is reflected immediately.
 */
function configuredLabelMap() {
  const map = {};
  const sweep = (CONFIG.matcher && CONFIG.matcher.sweep) || {};
  Object.entries(sweep).forEach(([sport, leagues]) => {
    (Array.isArray(leagues) ? leagues : []).forEach(league => {
      const key = leagueKey(sport, league);
      if (key && !map[key]) map[key] = `${sport}/${league}`;
    });
  });
  return map;
}

/**
 * The EXACT 'sport/league' for a stored key. Resolved in order:
 *   1. the label recorded in `league_labels` (keeps the real '.' / '-' chars);
 *   2. the CONFIGURED league list (round J item 6) — the true code for every
 *      league we log, used when no label was recorded;
 *   3. the sanitised form (last resort, for a key that matches neither).
 */
function labelFor(c, key) {
  if (c && c.league_labels && c.league_labels[key]) return c.league_labels[key];
  const configured = configuredLabelMap()[key];
  if (configured) return configured;
  return leagueLabel(key);
}

module.exports = {
  blank,
  sanitizeKey,
  leagueKey,
  leagueLabel,
  labelFor,
  dayKey,
  addRow,
  touchTime,
  addSettledGame,
  mergeInto,
  fromRows,
  totalRows,
  rowsLast24h,
  buckets,
};
