/**
 * live/espnCache.js
 *
 * Phase 8 — the fetching layer for the replay sweep.
 *
 * The Phase 5 backtest needs a large slice of ESPN history (thousands of
 * scoreboards and summaries). Two things make that practical and polite:
 *
 *   - A disk cache keyed by URL. A completed season never changes, so a second
 *     run costs nothing and an interrupted sweep resumes where it stopped.
 *   - A global throttle (minimum gap between request starts) plus retry with
 *     exponential backoff, so we never hammer the upstream.
 *
 * It is a drop-in `fetch`-alike: it takes a URL and returns something with
 * `ok`, `status` and `json()`, which is exactly what EspnProvider consumes. So
 * the cache is injected without changing a line of the provider.
 *
 * Deliberately NOT cached: 4xx/5xx responses and network errors. A 404 today is
 * not proof of a 404 tomorrow, and caching a failure would silently poison a
 * later run.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

/** A Response-shaped object built from an already-parsed JSON body. */
function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Deterministic on-disk path for a URL, sharded by the first byte of the hash. */
function cachePath(dir, url) {
  const key = sha1(url);
  return path.join(dir, key.slice(0, 2), `${key}.json`);
}

/**
 * @param {Object} [opts]
 * @param {string} opts.cacheDir            directory for cached JSON bodies
 * @param {number} [opts.minIntervalMs=60]  minimum gap between outbound starts
 * @param {number} [opts.retries=3]         retries after the first attempt
 * @param {number} [opts.backoffMs=1000]    base for exponential backoff
 * @param {number} [opts.timeoutMs=20000]   per-request timeout
 * @param {Function} [opts.fetchFn]         underlying fetch (injectable for tests)
 * @param {Object} [opts.logger]
 * @returns {Function} async (url, init) => { ok, status, json() }
 */
function createCachedFetch({
  cacheDir,
  minIntervalMs = 60,
  retries = 3,
  backoffMs = 1000,
  timeoutMs = 20000,
  fetchFn = null,
  logger = null,
} = {}) {
  if (!cacheDir) throw new Error('createCachedFetch requires a cacheDir.');
  const inner = fetchFn || global.fetch;
  if (typeof inner !== 'function') throw new Error('createCachedFetch requires a fetch implementation.');

  fs.mkdirSync(cacheDir, { recursive: true });

  let lastStart = 0;
  // Requests are serialised through this chain only far enough to enforce the
  // start-gap; the bodies are still fetched concurrently.
  let gate = Promise.resolve();

  const stats = { hits: 0, misses: 0, fetches: 0, errors: 0 };

  function throttle() {
    gate = gate.then(async () => {
      const wait = lastStart + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
    });
    return gate;
  }

  function log(level, message, meta) {
    if (logger && typeof logger.log === 'function') logger.log(level, `[live-cache] ${message}`, meta || {});
  }

  async function cachedFetch(url) {
    const file = cachePath(cacheDir, url);

    if (fs.existsSync(file)) {
      try {
        stats.hits++;
        return jsonResponse(JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch (err) {
        // A truncated file from an interrupted write: drop it and refetch.
        log('warn', 'cache read failed, refetching', { url, error: err.message });
        try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
      }
    }

    stats.misses++;
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await throttle();
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const res = await inner(url, {
          headers: { Accept: 'application/json', 'User-Agent': 'apex-backend/1.0' },
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (timer) clearTimeout(timer);

        if (!res.ok) {
          // 4xx is a property of the request, not of our connection. Return it
          // as-is (never cached) so the provider treats it as "no data".
          if (res.status >= 400 && res.status < 500) {
            log('debug', `upstream ${res.status}`, { url });
            return jsonResponse(null, res.status);
          }
          throw new Error(`upstream ${res.status}`);
        }

        stats.fetches++;
        const data = await res.json();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data));
        return jsonResponse(data);
      } catch (err) {
        if (timer) clearTimeout(timer);
        lastError = err;
        stats.errors++;
        log('warn', 'fetch failed', { url, attempt: attempt + 1, error: err.message });
        if (attempt < retries) await sleep(backoffMs * Math.pow(2, attempt));
      }
    }
    throw lastError || new Error(`fetch failed for ${url}`);
  }

  // The counters are exposed so a long sweep can report how much it read from
  // disk versus the network.
  cachedFetch.stats = stats;
  return cachedFetch;
}

module.exports = { createCachedFetch, cachePath, sha1 };
