const {
  PITCHAPI_BASE,
  PITCHAPI_KEY,
  PITCHAPI_ENABLED,
  PROVIDERS,
  TTL,
} = require('./config');
const { sharedCache } = require('./cache');
const {
  normalizeLeaguePitchAPI,
  normalizeTeamPitchAPI,
  normalizeFixturePitchAPI,
  normalizeTeamStatsPitchAPI,
  normalizeH2HPitchAPI,
} = require('./normalizer');

class PitchApiProvider {
  constructor({
    logger = null,
    fetchFn = null,
    apiKey = null,
    enabled = null,
    baseUrl = null,
  } = {}) {
    this.name = PROVIDERS.PITCHAPI;
    this.baseUrl = baseUrl || PITCHAPI_BASE;
    this.apiKey = apiKey !== null ? apiKey : PITCHAPI_KEY;
    this.enabled = enabled !== null ? enabled : PITCHAPI_ENABLED;
    this.logger = logger;
    this._fetch = fetchFn || global.fetch;
    this._inflight = new Map();
    this._rateLimit = {
      windowMs: 60 * 1000,
      maxPerWindow: 120, // Fair-use client guard
      requests: [],
      blockedUntil: 0,
      errorCount: 0,
      disabled: false,
    };
    this._lastMeta = new Map();
  }

  _log(level, message, meta = {}) {
    if (!this.logger) return;
    this.logger.log(level, `[SPORTS DATA][PitchAPI] ${message}`, { provider: PROVIDERS.PITCHAPI, ...meta });
  }

  isAvailable() {
    if (!this.enabled) return false;
    if (this._rateLimit.disabled) return false;
    if (Date.now() < this._rateLimit.blockedUntil) return false;
    return Boolean(this.apiKey);
  }

  isBlocked() {
    return this._rateLimit.disabled || Date.now() < this._rateLimit.blockedUntil;
  }

  _throttle() {
    const now = Date.now();
    const rl = this._rateLimit;
    rl.requests = rl.requests.filter(t => now - t < rl.windowMs);
    if (rl.requests.length >= rl.maxPerWindow) {
      const oldest = rl.requests[0];
      const waitMs = Math.max(1, rl.windowMs - (now - oldest));
      this._log('warn', 'fair-use client throttling', { waitMs, pending: rl.requests.length });
      return new Promise(r => setTimeout(r, waitMs)).then(() => this._throttle());
    }
    rl.requests.push(now);
    return Promise.resolve();
  }

  consumeLastMeta(endpoint) {
    const raw = this._lastMeta.get(endpoint) || null;
    this._lastMeta.delete(endpoint);
    return raw;
  }

  async _request(endpoint, params = {}, { ttl = TTL.DEFAULT, cache = true, traceId = null } = {}) {
    if (!this.isAvailable()) {
      this._log('warn', 'provider unavailable (disabled, blocked, or key missing)', { endpoint, traceId });
      return null;
    }

    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const cacheKey = `pa:req:${cleanEndpoint}:${JSON.stringify(params)}`;

    if (cache) {
      const cached = sharedCache.get(cacheKey);
      if (cached) {
        this._log('debug', 'cache hit', { endpoint: cleanEndpoint, params, traceId });
        return cached;
      }
    }

    if (this._inflight.has(cacheKey)) {
      this._log('debug', 'inflight dedup', { endpoint: cleanEndpoint, traceId });
      return this._inflight.get(cacheKey);
    }

    const task = (async () => {
      await this._throttle();
      try {
        const url = new URL(`${this.baseUrl}${cleanEndpoint}`);
        Object.entries(params).forEach(([k, v]) => {
          if (v != null && v !== '') url.searchParams.set(k, String(v));
        });

        const started = Date.now();
        const res = await this._fetch(url.toString(), {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'apex-backend/1.0',
            'X-API-KEY': this.apiKey,
          },
        });
        const dur = Date.now() - started;

        // 401 / 403: Authentication errors
        if (res.status === 401 || res.status === 403) {
          this._rateLimit.errorCount++;
          if (this._rateLimit.errorCount >= 3) {
            this._rateLimit.disabled = true;
            this._log('error', 'authentication failure — provider disabled until restart', { traceId, status: res.status });
          } else {
            this._rateLimit.blockedUntil = Date.now() + 5 * 60 * 1000; // 5 min backoff
            this._log('error', `auth ${res.status} — blocked for 5m`, { traceId, duration: dur });
          }
          return null;
        }

        // 429: Rate limit / fair-use burst limit
        if (res.status === 429) {
          let retryAfterSec = 60;
          const retryHeader = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
          if (retryHeader) {
            const parsed = parseInt(retryHeader, 10);
            if (!isNaN(parsed) && parsed > 0) retryAfterSec = parsed;
          }
          this._rateLimit.blockedUntil = Date.now() + retryAfterSec * 1000;
          this.logger?.log('warn', '[SPORTS DATA] PitchAPI rate limit reached', {
            provider: PROVIDERS.PITCHAPI,
            traceId,
            duration: dur,
            retryAfterSec,
          });
          return null;
        }

        if (res.status === 404) {
          this._log('debug', 'resource not found', { endpoint: cleanEndpoint, traceId, duration: dur });
          return null;
        }

        if (!res.ok) {
          this._log('warn', `upstream ${res.status}`, { endpoint: cleanEndpoint, traceId, duration: dur });
          return null;
        }

        const payload = await res.json();
        this._rateLimit.errorCount = Math.max(0, this._rateLimit.errorCount - 1);
        this._log('info', 'upstream ok', { endpoint: cleanEndpoint, traceId, duration: dur });

        // PitchAPI envelopes successful data in payload.data
        const data = payload?.data !== undefined ? payload.data : payload;

        try {
          this._lastMeta.set(cleanEndpoint, {
            status: res.status,
            results: Array.isArray(data) ? data.length : (data ? 1 : 0),
            error: payload?.error || null,
            params: JSON.parse(JSON.stringify(params || {})),
          });
        } catch (_) {}

        if (cache && data != null) {
          sharedCache.set(cacheKey, null, data, ttl);
        }

        return data;
      } catch (err) {
        this._log('warn', 'upstream error', { endpoint: cleanEndpoint, traceId, error: err.message });
        return null;
      }
    })().finally(() => this._inflight.delete(cacheKey));

    this._inflight.set(cacheKey, task);
    return task;
  }

  async getLeagues({ traceId = null } = {}) {
    const raw = await this._request('/v1/leagues', {}, { ttl: TTL.LEAGUES, traceId });
    if (!raw) return [];
    const list = Array.isArray(raw?.leagues) ? raw.leagues : (Array.isArray(raw) ? raw : []);
    return list.map(r => normalizeLeaguePitchAPI(r)).filter(Boolean);
  }

  async getLeagueById(id, { traceId = null } = {}) {
    const cleanId = String(id).replace(/^pa-/, '');
    const raw = await this._request(`/v1/leagues/${cleanId}`, {}, { ttl: TTL.LEAGUES, traceId });
    if (!raw) return null;
    return normalizeLeaguePitchAPI(raw);
  }

  async getLeagueMatches(id, { season = null, status = 'all', traceId = null } = {}) {
    const cleanId = String(id).replace(/^pa-/, '');
    const params = { status };
    if (season) params.season = season;
    const ttl = status === 'finished' ? TTL.FIXTURES_FINISHED : TTL.FIXTURES_SCHEDULED;
    const raw = await this._request(`/v1/leagues/${cleanId}/matches`, params, { ttl, traceId });
    if (!raw) return [];
    const list = Array.isArray(raw?.matches) ? raw.matches : (Array.isArray(raw) ? raw : []);
    return list.map(m => normalizeFixturePitchAPI(m)).filter(Boolean);
  }

  async getTeam(id, { traceId = null } = {}) {
    const cleanId = String(id).replace(/^pa-/, '');
    const raw = await this._request(`/v1/teams/${cleanId}`, {}, { ttl: TTL.TEAMS, traceId });
    if (!raw) return null;
    return normalizeTeamPitchAPI(raw);
  }

  async getMatchById(id, { traceId = null } = {}) {
    const cleanId = String(id).replace(/^pa-/, '');
    const raw = await this._request(`/v1/matches/${cleanId}`, {}, { ttl: TTL.FIXTURES_SCHEDULED, traceId });
    if (!raw) return null;
    return normalizeFixturePitchAPI(raw);
  }

  async getMatchesByDate(date, { status = 'all', traceId = null } = {}) {
    const params = { status };
    const raw = await this._request(`/v1/date/${date}`, params, { ttl: TTL.FIXTURES_SCHEDULED, traceId });
    if (!raw) return [];
    const list = Array.isArray(raw?.matches) ? raw.matches : (Array.isArray(raw) ? raw : []);
    return list.map(m => normalizeFixturePitchAPI(m)).filter(Boolean);
  }

  async getMatchStats(id, { traceId = null } = {}) {
    const cleanId = String(id).replace(/^pa-/, '');
    const raw = await this._request(`/v1/matches/${cleanId}/stats`, {}, { ttl: TTL.TEAM_STATS, traceId });
    if (!raw) return null;
    return normalizeTeamStatsPitchAPI(raw);
  }

  async getMatchH2H(id, { homeTeamId = null, awayTeamId = null, traceId = null } = {}) {
    const cleanId = String(id).replace(/^pa-/, '');
    const raw = await this._request(`/v1/matches/${cleanId}/h2h`, {}, { ttl: TTL.H2H, traceId });
    if (!raw) return { homeWins: 0, awayWins: 0, draws: 0, matches: [], recent: [] };
    return normalizeH2HPitchAPI(raw, homeTeamId, awayTeamId);
  }

  /**
   * PitchAPI does not provide a standings table endpoint in its published catalogue.
   * We gracefully return null without fabricating data.
   */
  async getStandings() {
    this._log('debug', 'standings not supported by PitchAPI catalogue');
    return null;
  }
}

module.exports = { PitchApiProvider };
