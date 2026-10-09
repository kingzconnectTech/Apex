const { ESPN_BASE, PROVIDERS, TTL } = require('./config');
const { sharedCache } = require('./cache');
const {
  normalizeLeagueESPN,
  normalizeTeamESPN,
  normalizeFixtureESPN,
  normalizeStandingsESPN,
  normalizeTeamStatsESPN,
} = require('./normalizer');

class EspnProvider {
  constructor({ logger = null, fetchFn = null } = {}) {
    this.name = PROVIDERS.ESPN;
    this.baseUrl = ESPN_BASE;
    this.logger = logger;
    this._fetch = fetchFn || global.fetch;
    this._inflight = new Map();
  }

  _log(level, message, meta = {}) {
    if (!this.logger) return;
    this.logger.log(level, `[SPORTS DATA][ESPN] ${message}`, { provider: PROVIDERS.ESPN, ...meta });
  }

  _cacheKey(method, args) {
    return `espn:${method}:${JSON.stringify(args)}`;
  }

  async _request(relativePath, { ttl = TTL.DEFAULT, cache = true, traceId = null } = {}) {
    const url = `${this.baseUrl}/${relativePath}`;
    const cacheKey = `espn:req:${url}`;

    if (cache) {
      const cached = sharedCache.get(cacheKey);
      if (cached) {
        this._log('debug', 'cache hit', { url, traceId });
        return cached;
      }
    }

    if (this._inflight.has(cacheKey)) {
      this._log('debug', 'inflight dedup', { url, traceId });
      return this._inflight.get(cacheKey);
    }

    const task = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const started = Date.now();
          const res = await this._fetch(url, {
            headers: { Accept: 'application/json', 'User-Agent': 'apex-backend/1.0' },
          });
          const dur = Date.now() - started;
          if (!res.ok) {
            this._log('warn', `upstream ${res.status}`, { url, traceId, duration: dur, attempt: attempt + 1 });
            if (res.status === 404 || res.status === 400) return null;
            throw new Error(`ESPN ${res.status} for ${url}`);
          }
          const data = await res.json();
          this._log('info', 'upstream ok', { url, traceId, duration: dur });
          if (cache) sharedCache.set(cacheKey, null, data, ttl);
          return data;
        } catch (err) {
          this._log('warn', 'upstream error', { url, traceId, error: err.message, attempt: attempt + 1 });
          if (attempt === 2) return null;
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
      return null;
    })().finally(() => this._inflight.delete(cacheKey));

    this._inflight.set(cacheKey, task);
    return task;
  }

  async getScoreboard(sport, league, { traceId = null } = {}) {
    const ttl = TTL.FIXTURES_SCHEDULED;
    const data = await this._request(`${sport}/${league}/scoreboard`, { ttl, traceId });
    return data;
  }

  async getFixtures(sport, league, { traceId = null, leagueDisplayName = '' } = {}) {
    const data = await this.getScoreboard(sport, league, { traceId });
    const events = data?.events || [];
    const out = events
      .map(e => normalizeFixtureESPN(e, sport, league, leagueDisplayName || league))
      .filter(Boolean);
    this._log('info', `fixtures found: ${out.length}`, { sport, league, traceId, count: out.length });
    return out;
  }

  async getTeam(sport, league, teamId, { traceId = null } = {}) {
    const data = await this._request(`${sport}/${league}/teams/${teamId}`, {
      ttl: TTL.TEAMS, traceId,
    });
    if (!data) return null;
    return normalizeTeamESPN(data, sport, league);
  }

  async getTeamSchedule(sport, league, teamId, { traceId = null } = {}) {
    return this._request(`${sport}/${league}/teams/${teamId}/schedule`, {
      ttl: TTL.FIXTURES_SCHEDULED, traceId,
    });
  }

  async getTeamStats(sport, league, teamId, { traceId = null } = {}) {
    const [teamData, scheduleData] = await Promise.all([
      this._request(`${sport}/${league}/teams/${teamId}`, { ttl: TTL.TEAMS, traceId }),
      this._request(`${sport}/${league}/teams/${teamId}/schedule`, { ttl: TTL.FIXTURES_SCHEDULED, traceId }),
    ]);
    return normalizeTeamStatsESPN(teamData, teamId, sport, scheduleData);
  }

  async getMatchSummary(sport, league, eventId, { traceId = null } = {}) {
    return this._request(`${sport}/${league}/summary?event=${eventId}`, {
      ttl: TTL.DEFAULT, traceId,
    });
  }

  async getStandings(sport, league, { traceId = null } = {}) {
    const data = await this._request(`${sport}/${league}/standings`, {
      ttl: TTL.STANDINGS, traceId,
    });
    return normalizeStandingsESPN(data, sport, league);
  }

  async getTeamNews(sport, league, teamId, { limit = 5, traceId = null } = {}) {
    return this._request(`${sport}/${league}/news?team=${teamId}&limit=${limit}`, {
      ttl: TTL.DEFAULT, traceId,
    });
  }

  processScheduleForTeam(events, teamId) {
    if (!events) return [];
    const valid = events.filter(e => {
      const state = e.competitions?.[0]?.status?.type?.state;
      return state === 'post' || state === 'in';
    });
    const last5 = valid.slice(-5).reverse();
    return last5.map(event => {
      const comp = event.competitions?.[0];
      if (!comp) return null;
      const teamComp = comp.competitors?.find(c => String(c?.team?.id) === String(teamId));
      const oppComp = comp.competitors?.find(c => String(c?.team?.id) !== String(teamId));
      if (!teamComp || !oppComp) return null;
      const teamScore = parseInt(teamComp.score?.value || 0);
      const oppScore = parseInt(oppComp.score?.value || 0);
      const state = comp.status?.type?.state;
      let result;
      if (state === 'in') result = 'D';
      else if (teamScore > oppScore) result = 'W';
      else if (teamScore < oppScore) result = 'L';
      else result = 'D';
      return {
        date: event.date,
        pf: teamScore,
        pa: oppScore,
        isHome: teamComp?.homeAway === 'home',
        result,
        opponentId: oppComp?.team?.id,
      };
    }).filter(Boolean);
  }

  buildH2H(headToHeadGames, matchId, homeTeamId, awayTeamId) {
    if (!headToHeadGames || headToHeadGames.length === 0) return null;
    const valid = headToHeadGames.filter(g =>
      String(g.id) !== String(matchId) &&
      g.homeTeamScore !== undefined &&
      g.awayTeamScore !== undefined
    );
    if (valid.length === 0) return null;
    let homeWins = 0, awayWins = 0, draws = 0;
    const recent = valid.slice(0, 5).map(game => {
      const hs = parseInt(game.homeTeamScore || 0);
      const as = parseInt(game.awayTeamScore || 0);
      const isHomeHosting = String(game.homeTeamId) === String(homeTeamId);
      if (hs === as) draws++;
      else if (isHomeHosting) hs > as ? homeWins++ : awayWins++;
      else as > hs ? homeWins++ : awayWins++;
      return { date: game.gameDate, score: game.score ? game.score.replace(/\s/g, '') : '?-?', id: game.id };
    });
    return { homeWins, awayWins, draws, recent };
  }

  getSupportedSports() {
    return ['soccer', 'basketball', 'tennis'];
  }

  supportsSport(sport) {
    return this.getSupportedSports().includes(sport);
  }
}

module.exports = { EspnProvider };
