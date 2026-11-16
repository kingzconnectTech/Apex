/**
 * live/store/grid.js
 *
 * Phase 10 round G — the REPLAY GRID as a storage concern.
 *
 * The shadow sweep logs a row whenever the clock has moved, so a live game
 * carries far more rows than the replay, which samples each game at a FIXED
 * grid of elapsed fractions (CONFIG.liveBacktest.checkpoints.basketball
 * .fractions). The store keeps ONE row per (game, grid mark): a row is written
 * ONLY when its elapsed fraction lands within `gridTolerance` of a mark, and it
 * is keyed by that mark — so a retry or a double sweep OVERWRITES rather than
 * appends, and what is stored is exactly what resampleToGrid would score.
 *
 * Two rules live here, shared by every backend:
 *   - gridCheckpoint(progress) → the nearest mark within tolerance, or null;
 *   - storageKey(row)          → 'sport|league|game_id|grid_checkpoint', the
 *                                idempotency key (also the Firestore doc id).
 */

const CONFIG = require('../config');

/** The replay grid marks (elapsed fractions of regulation). */
function fractions() {
  return (CONFIG.liveBacktest && CONFIG.liveBacktest.checkpoints
    && CONFIG.liveBacktest.checkpoints.basketball
    && CONFIG.liveBacktest.checkpoints.basketball.fractions) || [];
}

/** How near a mark a row's progress must fall to be stored. */
function tolerance() {
  const S = (CONFIG.live && CONFIG.live.store) || {};
  return Number.isFinite(S.gridTolerance) ? S.gridTolerance : 0.03;
}

/**
 * The replay grid mark an elapsed fraction maps to.
 *
 * @param {number} progress elapsed / regulation (0..1)
 * @param {Object} [opts] { fractions, tolerance } overrides (tests)
 * @returns {number|null} the nearest mark within tolerance, else null (skip)
 */
function gridCheckpoint(progress, { fractions: fr = null, tolerance: tol = null } = {}) {
  if (!Number.isFinite(progress)) return null;
  const marks = (Array.isArray(fr) && fr.length ? fr : fractions());
  const T = Number.isFinite(tol) ? tol : tolerance();
  let best = null;
  let bestD = Infinity;
  for (const m of marks) {
    const d = Math.abs(progress - m);
    if (d < bestD) { bestD = d; best = m; }
  }
  if (best == null || bestD > T) return null;
  return best;
}

/**
 * The idempotency key for a row: 'sport|league|game_id|grid_checkpoint'.
 *
 * `null` when any part is missing — a row without a grid checkpoint is never
 * stored, so a keyless row simply has nothing to collide with.
 */
function storageKey(row) {
  if (!row || row.grid_checkpoint == null) return null;
  const parts = [row.sport, row.league, row.game_id, row.grid_checkpoint];
  if (parts.some(p => p == null || p === '')) return null;
  return parts.map(String).join('|');
}

module.exports = { fractions, tolerance, gridCheckpoint, storageKey };
