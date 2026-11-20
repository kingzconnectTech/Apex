/**
 * basketball/engineProjections.js
 *
 * In-process bridge between the pre-game basketball engine and the live
 * basketball model.
 *
 * WHY THIS EXISTS
 * The live model used to start every game from the same league home-court edge
 * (a couple of points) and the league's mean total, so a heavy favourite was
 * modelled as if it were an average home team. The pre-game engine already
 * knows better: `formatPrediction(result).projection` carries the fitted
 * full-game margin and total (team ratings, Elo, home court). As the scheduler
 * refreshes predictions it publishes those here, and the live model reads the
 * projected margin/total for its prior.
 *
 * Deliberately NOT persisted and NOT market data — this is the engine's own
 * output, held in the same server process, keyed by the raw provider event id
 * (the part after `source:` in a live game id, which is exactly the pre-game
 * engine's `gameId`). Absent entry => the caller falls back to its own prior.
 *
 * The Map mirrors the other in-process stores in the live service
 * (liveStats.snapshotLog, liveContext.cache), bounded so it cannot grow without
 * limit.
 */

const MAX_ENTRIES = 2000;

/** eventId -> { margin, total, at } */
const store = new Map();

/** The raw provider event id behind a `source:id` game id, or the id as-is. */
function eventIdOf(gameId) {
  if (gameId == null) return null;
  const str = String(gameId);
  return str.includes(':') ? str.split(':').slice(1).join(':') : str;
}

/** Publish the pre-game projection for one game. Ignores anything unusable. */
function publish(gameId, { margin, total } = {}) {
  const id = eventIdOf(gameId);
  if (!id || !Number.isFinite(margin)) return null;
  const entry = { margin, total: Number.isFinite(total) ? total : null, at: Date.now() };
  store.set(id, entry);
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
  return entry;
}

/**
 * Publish a whole refreshed batch of formatted pre-game predictions
 * (`formatPrediction` output: `{ gameId, projection: { margin, total } }`).
 * @returns {number} how many were published
 */
function publishAll(predictions) {
  let n = 0;
  for (const p of predictions || []) {
    if (!p || !p.gameId) continue;
    const proj = p.projection || {};
    if (publish(p.gameId, { margin: proj.margin, total: proj.total })) n += 1;
  }
  return n;
}

/**
 * The published projection for a live game id, or null when absent.
 * Optional `maxAgeMs` rejects a stale entry (0 = no age limit).
 */
function lookup(gameId, { maxAgeMs = 0, now = Date.now() } = {}) {
  const id = eventIdOf(gameId);
  if (!id) return null;
  const hit = store.get(id);
  if (!hit) return null;
  if (maxAgeMs > 0 && now - hit.at > maxAgeMs) return null;
  return hit;
}

/** Test/dev helper. */
function reset() {
  store.clear();
}

function size() {
  return store.size;
}

module.exports = { publish, publishAll, lookup, eventIdOf, reset, size };
