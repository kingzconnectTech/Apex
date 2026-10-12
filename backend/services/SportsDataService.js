const { PROVIDERS, TTL } = require('./providers/config');
const { EspnProvider } = require('./providers/EspnProvider');
const { PitchApiProvider } = require('./providers/PitchApiProvider');
const { buildDedupKey, fixturesMatch, _normalizeTeamName } = require('./providers/normalizer');
const { sharedCache } = require('./providers/cache');

function _sportForAF(sport) {
  return sport === 'soccer' || sport === 'football';
}

class SportsDataService {
  constructor({
    logger = null,
    espnProvider = null,
    pitchApiProvider = null,
  } = {}) {
    this.logger = logger;
    this.espn = espnProvider || new EspnProvider({ logger });
    this.pitchApi = pitchApiProvider || new PitchApiProvider({ logger });
    this._paLeagueSlugMap = new Map();
  }

  _log(level, message, meta = {}) {
    if (!this.logger) return;
    this.logger.log(level, `[SPORTS DATA] ${message}`, meta);
  }

  async _getPitchApiLeagueMap({ traceId = null } = {}) {
    const CACHE_KEY_ALL = 'pa:leagues:all';
    let map = sharedCache.get(CACHE_KEY_ALL, null);
    if (map) return map;

    if (!this.pitchApi.isAvailable()) {
      return new Map();
    }
    this._log('debug', 'rebuilding PitchAPI league map', { traceId });
    const allLeagues = await this.pitchApi.getLeagues({ traceId }).catch(() => []);
    map = new Map();
    allLeagues.forEach(lg => {
      if (!lg || !lg.league) return;
      const name = _normalizeTeamName(lg.league.name || '');
      const country = _normalizeTeamName(lg.league.country || '');
      const paId = lg.league.sourceId || lg.league.id;
      if (name && paId) {
        if (!map.has(name)) map.set(name, []);
        map.get(name).push({ paId, country, season: lg.league.season || null, raw: lg });
      }
      if (country && name && paId) {
        const key = `${country}:${name}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({ paId, country, season: lg.league.season || null, raw: lg });
      }
    });
    sharedCache.set(CACHE_KEY_ALL, null, map, TTL.LEAGUES);
    return map;
  }

  async _getPitchApiLeagueId(sport, leagueSlug, { traceId = null, leagueDisplayName = '' } = {}) {
    if (!_sportForAF(sport)) return null;
    if (String(leagueSlug).startsWith('pa-l_') || String(leagueSlug).startsWith('l_')) {
      return String(leagueSlug).replace(/^pa-/, '');
    }
    if (this._paLeagueSlugMap.has(leagueSlug)) {
      return this._paLeagueSlugMap.get(leagueSlug);
    }
    const cached = sharedCache.get('pa:leagueIdFromSlug', leagueSlug);
    if (cached) return cached;

    const map = await this._getPitchApiLeagueMap({ traceId });
    if (map.size === 0) return null;

    const lastSegment = leagueSlug.split('.').pop() || '';
    const normSlug = _normalizeTeamName(lastSegment);
    const leagueNamePart = _normalizeTeamName(leagueSlug);
    const normDisplayName = leagueDisplayName ? _normalizeTeamName(leagueDisplayName) : '';

    let candidates = (normDisplayName ? map.get(normDisplayName) : null)
      || map.get(leagueNamePart)
      || map.get(normSlug)
      || [];
    if (candidates.length === 0) {
      for (const [key, arr] of map.entries()) {
        if (
          (normDisplayName && (key.includes(normDisplayName) || normDisplayName.includes(key))) ||
          key.includes(normSlug) ||
          (normSlug && key.split(':').some(p => p.includes(normSlug)))
        ) {
          candidates = candidates.concat(arr || []);
        }
      }
    }
    if (candidates.length === 0) {
      return null;
    }
    const best = candidates[0];
    const paId = best.paId;
    if (paId) {
      sharedCache.set('pa:leagueIdFromSlug', leagueSlug, paId, TTL.LEAGUES);
      this._paLeagueSlugMap.set(leagueSlug, paId);
      return paId;
    }
    return null;
  }

  async listFootballLeagues({ country = null, season = null, traceId = null } = {}) {
    // Discover dynamically from PitchAPI if available (77 leagues with lower tiers & cups)
    if (this.pitchApi.isAvailable()) {
      const paLeagues = await this.pitchApi.getLeagues({ traceId }).catch(() => []);
      if (paLeagues.length > 0) {
        if (country) {
          const normCountry = _normalizeTeamName(country);
          return paLeagues.filter(lg => {
            const c = _normalizeTeamName(lg.league?.country || '');
            return c === normCountry || c.includes(normCountry) || normCountry.includes(c);
          });
        }
        return paLeagues;
      }
    }

    return [];
  }

  async getFixtures(sport, leagueSlug, { traceId = null, leagueDisplayName = '' } = {}) {
    const tried = [];

    // 1. Primary: ESPN
    const espnStart = Date.now();
    const espnFixtures = await this.espn.getFixtures(sport, leagueSlug, { traceId, leagueDisplayName });
    const espnMs = Date.now() - espnStart;
    tried.push(PROVIDERS.ESPN);

    if (espnFixtures.length > 0) {
      this.logger?.log('info', '[SPORTS DATA] ESPN fixture found', {
        traceId, sport, leagueSlug, count: espnFixtures.length, duration: espnMs,
      });
      return { fixtures: espnFixtures, source: PROVIDERS.ESPN, tried };
    }

    this.logger?.log('info', '[SPORTS DATA] ESPN fixture unavailable', {
      traceId, sport, leagueSlug, duration: espnMs,
    });

    if (!_sportForAF(sport)) {
      return { fixtures: [], source: null, tried };
    }

    // 2. Secondary: PitchAPI (free, lower divisions, missing competitions)
    if (this.pitchApi.isAvailable()) {
      this.logger?.log('info', '[SPORTS DATA] PitchAPI fallback requested', { traceId, sport, leagueSlug });
      tried.push(PROVIDERS.PITCHAPI);
      const paStart = Date.now();
      const paLeagueId = await this._getPitchApiLeagueId(sport, leagueSlug, { traceId, leagueDisplayName });

      let paFixtures = [];
      if (paLeagueId) {
        paFixtures = await this.pitchApi.getLeagueMatches(paLeagueId, { status: 'all', traceId });
      }

      const paMs = Date.now() - paStart;
      if (paFixtures.length > 0) {
        this.logger?.log('info', '[SPORTS DATA] PitchAPI fixture found', {
          traceId, sport, leagueSlug, count: paFixtures.length, duration: paMs,
        });
        return { fixtures: paFixtures, source: PROVIDERS.PITCHAPI, tried };
      }
    }

    this.logger?.log('info', '[SPORTS DATA] All enabled providers exhausted', {
      traceId, sport, leagueSlug, tried,
    });
    return { fixtures: [], source: null, tried };
  }

  async getFixturesMerged(sport, leagueSlug, { traceId = null, leagueDisplayName = '' } = {}) {
    const all = [];
    const dedupKeys = new Set();

    const [espnResult, paResult] = await Promise.all([
      this.espn.getFixtures(sport, leagueSlug, { traceId, leagueDisplayName }).catch(() => []),
      (_sportForAF(sport) && this.pitchApi.isAvailable())
        ? (async () => {
            const paId = await this._getPitchApiLeagueId(sport, leagueSlug, { traceId, leagueDisplayName });
            if (!paId) return [];
            return this.pitchApi.getLeagueMatches(paId, { status: 'all', traceId }).catch(() => []);
          })()
        : Promise.resolve([]),
    ]);

    // 1. Primary: ESPN
    for (const fx of espnResult) {
      const k = buildDedupKey(fx.dedupSignature);
      if (k) dedupKeys.add(k);
      all.push(fx);
    }

    // 2. Secondary: PitchAPI
    for (const fx of paResult) {
      const k = buildDedupKey(fx.dedupSignature);
      if (k && dedupKeys.has(k)) continue;
      let dup = false;
      for (const existing of all) {
        if (fixturesMatch(existing, fx)) { dup = true; break; }
      }
      if (dup) continue;
      if (k) dedupKeys.add(k);
      all.push(fx);
    }

    all.sort((a, b) => (a.fixture.timestamp || 0) - (b.fixture.timestamp || 0));
    return all;
  }

  async getLiveFixtures({ traceId = null, leagueConfigs = null } = {}) {
    const leagues = leagueConfigs || [
      { sport: 'soccer', league: 'eng.1' }, { sport: 'soccer', league: 'esp.1' },
      { sport: 'soccer', league: 'ita.1' }, { sport: 'soccer', league: 'ger.1' },
      { sport: 'soccer', league: 'fra.1' }, { sport: 'soccer', league: 'uefa.champions' },
      { sport: 'soccer', league: 'eng.2' }, { sport: 'soccer', league: 'eng.3' },
      { sport: 'soccer', league: 'eng.4' }, { sport: 'soccer', league: 'esp.2' },
      { sport: 'soccer', league: 'ita.2' }, { sport: 'soccer', league: 'ger.2' },
      { sport: 'soccer', league: 'fra.2' }, { sport: 'soccer', league: 'ned.2' },
      { sport: 'soccer', league: 'por.2' }, { sport: 'soccer', league: 'sct.2' },
      { sport: 'soccer', league: 'bra.2' }, { sport: 'soccer', league: 'mex.2' },
      { sport: 'soccer', league: 'usa.2' }, { sport: 'soccer', league: 'jpn.2' },
      { sport: 'basketball', league: 'nba' }, { sport: 'basketball', league: 'wnba' },
      { sport: 'tennis', league: 'atp' }, { sport: 'tennis', league: 'wta' },
    ];
    const out = [];
    for (const cfg of leagues) {
      const { fixtures } = await this.getFixtures(cfg.sport, cfg.league, { traceId, leagueDisplayName: cfg.league });
      out.push(...fixtures.filter(f => f.fixture.status === 'live'));
    }

    if (this.pitchApi.isAvailable()) {
      const today = new Date().toISOString().slice(0, 10);
      const paLive = await this.pitchApi.getMatchesByDate(today, { status: 'all', traceId }).catch(() => []);
      for (const fx of paLive.filter(f => f.fixture.status === 'live')) {
        let dup = false;
        for (const existing of out) {
          if (fixturesMatch(existing, fx)) { dup = true; break; }
        }
        if (!dup) out.push(fx);
      }
    }
    return out;
  }

  async getMatchDataForPrediction({
    matchId, sport, leagueSlug, homeTeamId, awayTeamId, traceId = null,
  }) {
    const result = {
      source: null,
      tried: [],
      homeTeamData: null,
      awayTeamData: null,
      matchSummary: null,
      homeSchedule: null,
      awaySchedule: null,
      homeNews: null,
      awayNews: null,
      homeLastMatches: [],
      awayLastMatches: [],
      h2h: null,
      homeName: '',
      awayName: '',
      homeRecord: null,
      awayRecord: null,
      homeNewsParsed: [],
      awayNewsParsed: [],
    };

    const espnStart = Date.now();
    try {
      const [ht, at, ms, hs, as, hn, an] = await Promise.all([
        this.espn._request(`${sport}/${leagueSlug}/teams/${homeTeamId}`, { traceId }),
        this.espn._request(`${sport}/${leagueSlug}/teams/${awayTeamId}`, { traceId }),
        this.espn.getMatchSummary(sport, leagueSlug, matchId, { traceId }),
        this.espn.getTeamSchedule(sport, leagueSlug, homeTeamId, { traceId }),
        this.espn.getTeamSchedule(sport, leagueSlug, awayTeamId, { traceId }),
        this.espn.getTeamNews(sport, leagueSlug, homeTeamId, { limit: 5, traceId }),
        this.espn.getTeamNews(sport, leagueSlug, awayTeamId, { limit: 5, traceId }),
      ]);

      const homeTeam = ht?.team;
      const awayTeam = at?.team;
      const hasSufficient =
        homeTeam?.displayName && awayTeam?.displayName &&
        ((hs?.events?.length || 0) > 0 || (as?.events?.length || 0) > 0 || ms);

      if (hasSufficient) {
        this._log('info', `ESPN → match data found`, { traceId, matchId, duration: Date.now() - espnStart });
        result.tried.push(PROVIDERS.ESPN);
        result.source = PROVIDERS.ESPN;
        result.homeTeamData = ht; result.awayTeamData = at; result.matchSummary = ms;
        result.homeSchedule = hs; result.awaySchedule = as;
        result.homeNews = hn; result.awayNews = an;
        result.homeName = homeTeam.displayName || `Team ${homeTeamId}`;
        result.awayName = awayTeam.displayName || `Team ${awayTeamId}`;
        result.homeRecord = homeTeam?.record?.items?.[0]?.summary || null;
        result.awayRecord = awayTeam?.record?.items?.[0]?.summary || null;
        result.homeLastMatches = this.espn.processScheduleForTeam(hs?.events || [], homeTeamId);
        result.awayLastMatches = this.espn.processScheduleForTeam(as?.events || [], awayTeamId);
        result.homeNewsParsed = (hn?.articles || []).map(a => ({ headline: a.headline || '', description: a.description || '' }));
        result.awayNewsParsed = (an?.articles || []).map(a => ({ headline: a.headline || '', description: a.description || '' }));

        let rawH2H = ms?.headToHeadGames || [];
        if (rawH2H.length > 0 && rawH2H[0]?.events) {
          rawH2H = rawH2H.flatMap(item => item.events || []);
          rawH2H = [...new Map(rawH2H.map(item => [item.id, item])).values()];
        }
        result.h2h = this.espn.buildH2H(rawH2H, matchId, homeTeamId, awayTeamId);
        return result;
      }
    } catch (err) {
      this._log('warn', `ESPN → match data error: ${err.message}`, { traceId, matchId });
    }
    result.tried.push(PROVIDERS.ESPN);
    this.logger?.log('info', '[SPORTS DATA] ESPN fixture unavailable', { traceId, matchId, duration: Date.now() - espnStart });

    if (!_sportForAF(sport)) {
      return result;
    }

    // 2. Secondary: PitchAPI
    if (this.pitchApi.isAvailable()) {
      this.logger?.log('info', '[SPORTS DATA] PitchAPI fallback requested', { traceId, matchId, sport, leagueSlug });
      try {
        const paStart = Date.now();
        let fixture = null;

        if (String(matchId).startsWith('pa-m_') || String(matchId).startsWith('m_')) {
          fixture = await this.pitchApi.getMatchById(matchId, { traceId });
        } else {
          const paLeagueId = await this._getPitchApiLeagueId(sport, leagueSlug, { traceId });
          if (paLeagueId) {
            const leagueMatches = await this.pitchApi.getLeagueMatches(paLeagueId, { status: 'all', traceId });
            const homeClean = String(homeTeamId).replace(/^pa-/, '');
            const awayClean = String(awayTeamId).replace(/^pa-/, '');

            fixture = leagueMatches.find(f =>
              (f.homeTeam.sourceId === homeClean && f.awayTeam.sourceId === awayClean) ||
              (f.homeTeam.name && f.awayTeam.name &&
                _normalizeTeamName(f.homeTeam.name) === _normalizeTeamName(homeName || '') &&
                _normalizeTeamName(f.awayTeam.name) === _normalizeTeamName(awayName || ''))
            ) || null;
          }
        }

        if (fixture) {
          result.tried.push(PROVIDERS.PITCHAPI);
          result.source = PROVIDERS.PITCHAPI;
          result.homeName = fixture.homeTeam.name;
          result.awayName = fixture.awayTeam.name;

          this.logger?.log('info', '[SPORTS DATA] PitchAPI fixture found', {
            traceId, matchId, duration: Date.now() - paStart,
          });

          const [paH2H, paStats, paLeagueMatches] = await Promise.all([
            this.pitchApi.getMatchH2H(fixture.fixture.sourceId, {
              homeTeamId: fixture.homeTeam.sourceId,
              awayTeamId: fixture.awayTeam.sourceId,
              traceId,
            }).catch(() => null),
            this.pitchApi.getMatchStats(fixture.fixture.sourceId, { traceId }).catch(() => null),
            fixture.league.sourceId
              ? this.pitchApi.getLeagueMatches(fixture.league.sourceId, { status: 'all', traceId }).catch(() => [])
              : Promise.resolve([]),
          ]);

          result.h2h = paH2H;

          // Build form from league finished matches
          if (Array.isArray(paLeagueMatches) && paLeagueMatches.length > 0) {
            const transformLast = (list, teamSrc) => list
              .filter(f => f.fixture.status === 'finished' &&
                (f.homeTeam.sourceId === teamSrc || f.awayTeam.sourceId === teamSrc))
              .sort((a, b) => (b.fixture.timestamp || 0) - (a.fixture.timestamp || 0))
              .slice(0, 5)
              .map(f => {
                const isHome = f.homeTeam.sourceId === teamSrc;
                const pf = isHome ? f.homeTeam.score : f.awayTeam.score;
                const pa = isHome ? f.awayTeam.score : f.homeTeam.score;
                let r = 'D';
                if (pf != null && pa != null) {
                  if (pf > pa) r = 'W'; else if (pf < pa) r = 'L';
                }
                return {
                  date: f.fixture.date,
                  pf: pf ?? 0,
                  pa: pa ?? 0,
                  isHome,
                  result: r,
                  opponentId: isHome ? f.awayTeam.sourceId : f.homeTeam.sourceId,
                };
              });

            result.homeLastMatches = transformLast(paLeagueMatches, fixture.homeTeam.sourceId);
            result.awayLastMatches = transformLast(paLeagueMatches, fixture.awayTeam.sourceId);

            // Compute season record from league matches if available
            const calcRecord = (matches) => {
              if (!matches || matches.length === 0) return null;
              let w = 0, d = 0, l = 0;
              matches.forEach(m => {
                if (m.result === 'W') w++;
                else if (m.result === 'L') l++;
                else d++;
              });
              return `${w}-${d}-${l}`;
            };

            result.homeRecord = calcRecord(result.homeLastMatches);
            result.awayRecord = calcRecord(result.awayLastMatches);
          }

          return result;
        } else {
          result.tried.push(PROVIDERS.PITCHAPI);
        }
      } catch (err) {
        this._log('warn', `PitchAPI → match data error: ${err.message}`, { traceId, matchId });
        result.tried.push(PROVIDERS.PITCHAPI);
      }
    }

    this.logger?.log('info', '[SPORTS DATA] All enabled providers exhausted', { traceId, matchId, tried: result.tried });
    return result;
  }

  getProvidersStatus() {
    return {
      [PROVIDERS.ESPN]: { available: true, priority: 1 },
      [PROVIDERS.PITCHAPI]: {
        available: this.pitchApi.isAvailable(),
        priority: 2,
        enabled: this.pitchApi.enabled,
        blockedUntil: this.pitchApi._rateLimit.blockedUntil || null,
        disabled: this.pitchApi._rateLimit.disabled,
      },
    };
  }

  purgeExpired() {
    const removed = sharedCache.purgeExpired();
    this._log('debug', `cache cleanup: removed ${removed} entries`, { removed });
    return removed;
  }

  cacheSize() {
    return sharedCache.size();
  }
}

module.exports = { SportsDataService };
