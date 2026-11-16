/**
 * live/ledger.js
 *
 * Phase 10 round G — the durable EVALUATION LEDGER.
 *
 * The confirmation protocol may score the post-freeze dataset EXACTLY ONCE, and
 * only after every sport holds its target settled games. That one pass has to be
 * a logged event, not an unannounced peek — so the ledger records, durably:
 *
 *   - `first_post_freeze_row`: the exact instant the FIRST shadow row after the
 *     candidate freeze was logged (round G item 5). Rows before it do not exist,
 *     so nothing is backfilled; it is set once and never moved.
 *   - `entries[]`: {window, scored_times, unseen, note} — one line per scored
 *     window, so a regeneration is a NEW scored pass rather than an invisible
 *     recompute (the same shape scripts/run-live-phase10-report.js reports).
 *
 * It persists through the SAME storage adapter as the rows and the health state
 * (services/live/store), so in production it lives in Firestore and survives an
 * ephemeral host disk. `snapshot()` reads the in-memory copy for tests;
 * `read()` reads the durable document (a cold start must not reset it).
 */

const store = require('./store');
const shadowCandidates = require('./shadowCandidates');

const VERSION = 1;

let state = null;
let loaded = false;

function blank() {
  return {
    version: VERSION,
    updated_at: null,
    first_post_freeze_row: null,
    entries: [],
  };
}

function normalise(raw) {
  const base = blank();
  if (!raw || typeof raw !== 'object') return base;
  return {
    version: Number.isFinite(raw.version) ? raw.version : VERSION,
    updated_at: raw.updated_at || null,
    first_post_freeze_row: raw.first_post_freeze_row || null,
    entries: Array.isArray(raw.entries) ? raw.entries.map(e => ({
      window: e && e.window != null ? e.window : null,
      scored_times: e && Number.isFinite(e.scored_times) ? e.scored_times : (e && e.scored_times != null ? e.scored_times : 0),
      unseen: e && e.unseen === true,
      note: e && e.note != null ? e.note : null,
    })) : [],
  };
}

function ensure() {
  if (loaded) return state;
  loaded = true;
  const st = store.getStore();
  if (st.supportsSync) {
    state = normalise(st.readLedger());
  } else {
    state = blank();
    Promise.resolve(st.readLedger()).then(raw => {
      // Guard: once anything has been recorded locally, keep it.
      if (state && state.first_post_freeze_row == null && (!state.entries || !state.entries.length)) {
        state = normalise(raw);
      }
    }).catch(() => {});
  }
  return state;
}

/** Persist through the adapter; never throws. */
function persist() {
  ensure();
  state.updated_at = new Date().toISOString();
  const st = store.getStore();
  try { return st.writeLedger(JSON.parse(JSON.stringify(state))); } catch (err) { return false; }
}

/** The freeze instant the ledger accrues from (candidate artifact). */
function freeze() {
  try { return shadowCandidates.frozenAt(); } catch (err) { return { iso: null, ms: null }; }
}

/**
 * Record the first post-freeze shadow row (round G item 5). Idempotent: only the
 * FIRST one sticks, so a later sweep can never move the start of the window.
 *
 * @param {Object} row a shadow row freshly appended by forwardTest
 * @returns {Object|null} the recorded entry, or null when nothing was recorded
 */
function recordShadowRow(row) {
  if (!row || row.shadow !== true) return null;
  const fr = freeze();
  if (fr.ms == null || !Number.isFinite(row.at_ms) || row.at_ms < fr.ms) return null;
  ensure();
  if (state.first_post_freeze_row) return null;
  state.first_post_freeze_row = {
    at: row.at,
    at_ms: row.at_ms,
    game_id: row.game_id,
    sport: row.sport || null,
    league: row.league || null,
    grid_checkpoint: row.grid_checkpoint != null ? row.grid_checkpoint : null,
    candidates_frozen_at: fr.iso,
    note: 'First shadow row logged strictly after the candidate freeze. Rows before it do not exist; no backfill.',
  };
  persist();
  return state.first_post_freeze_row;
}

/**
 * Record (or increment) a scored window. `scored_times` is how many times the
 * window has been SCORED — each call is a new pass, so it can never look unseen.
 */
function recordScoring({ window: name = null, note = null, unseen = false, increment = true } = {}) {
  ensure();
  if (name == null) return null;
  let entry = state.entries.find(e => e.window === name);
  if (!entry) {
    entry = { window: name, scored_times: 0, unseen: true, note: null };
    state.entries.push(entry);
  }
  if (increment) entry.scored_times = (Number(entry.scored_times) || 0) + 1;
  entry.unseen = unseen === true;
  if (note != null) entry.note = note;
  persist();
  return entry;
}

/** The durable ledger document (async), normalised. */
async function read() {
  const st = store.getStore();
  try {
    const raw = await st.readLedger();
    return normalise(raw);
  } catch (err) {
    return ensure();
  }
}

/** In-memory view (tests / report). Not a durable read. */
function snapshot() {
  return JSON.parse(JSON.stringify(ensure()));
}

function reset() {
  state = null;
  loaded = false;
}

module.exports = {
  init: ensure,
  recordShadowRow,
  recordScoring,
  read,
  snapshot,
  reset,
  blank,
  VERSION,
};
