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

  async getScoreboard(sport, league, { dates = null, page = null, limit = null, traceId = null } = {}) {
    const ttl = TTL.FIXTURES_SCHEDULED;
    const queryParts = [];
    if (dates) queryParts.push(`dates=${encodeURIComponent(dates)}`);
    if (page != null) queryParts.push(`page=${encodeURIComponent(page)}`);
    if (limit != null) queryParts.push(`limit=${encodeURIComponent(limit)}`);
    const qs = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
    const data = await this._request(`${sport}/${league}/scoreboard${qs}`, { ttl, traceId });
    return data;
  }

  async getFixtures(sport, league, { dates = null, page = null, limit = null, traceId = null, leagueDisplayName = '' } = {}) {
    const data = await this.getScoreboard(sport, league, { dates, page, limit, traceId });
    const events = data?.events || [];
    const out = events
      .map(e => normalizeFixtureESPN(e, sport, league, leagueDisplayName || league))
      .filter(Boolean);
    this._log('info', `fixtures found: ${out.length}`, { sport, league, traceId, count: out.length });
    return out;
  }

  async getFixturesPaginated(sport, league, { dates = null, limit = 50, maxPages = 5, traceId = null, leagueDisplayName = '' } = {}) {
    let page = 1;
    const all = [];
    const seenIds = new Set();
    while (page <= maxPages) {
      const data = await this.getScoreboard(sport, league, { dates, page, limit, traceId });
      const events = data?.events || [];
      if (events.length === 0) break;
      let newCount = 0;
      for (const ev of events) {
        if (!seenIds.has(ev.id)) {
          seenIds.add(ev.id);
          const normalized = normalizeFixtureESPN(ev, sport, league, leagueDisplayName || league);
          if (normalized) all.push(normalized);
          newCount++;
        }
      }
      const pageCount = data?.pageCount || data?.pagination?.pages;
      if (events.length < limit || newCount === 0 || (pageCount && page >= pageCount)) break;
      page++;
    }
    return all;
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

  /**
   * Extract a single numeric stat from a competitor's statistics array.
   * Searches by both `name` and `label` fields. Returns null when absent.
   */
  static findStatValue(competitor, names) {
    if (!competitor?.statistics) return null;
    const s = competitor.statistics.find(item => names.includes(item.name) || names.includes(item.label));
    if (!s) return null;
    const raw = s.displayValue ?? s.value;
    if (raw === undefined || raw === null || raw === '') return null;
    const num = parseFloat(raw);
    return isNaN(num) ? null : num;
  }

  /**
   * Extract football shot statistics for both teams.
   * Total shots uses the provider's total-shots field — NEVER shots-on-target.
   * Returns null for any stat the provider does not supply.
   */
  static extractFootballShotStats(teamComp, oppComp) {
    const find = (c, names) => EspnProvider.findStatValue(c, names);

    const shots = find(teamComp, ['totalShots', 'shots', 'shotsTotal']);
    const shotsOnTarget = find(teamComp, ['shotsOnTarget', 'shots_on_target', 'shotsOnTargetPercentage']);
    const shotsConceded = find(oppComp, ['totalShots', 'shots', 'shotsTotal']);
    const shotsOnTargetConceded = find(oppComp, ['shotsOnTarget', 'shots_on_target']);
    const blockedShots = find(teamComp, ['blockedShots', 'blocked_shots']);
    const totalShots = (shots != null && shotsConceded != null) ? shots + shotsConceded : null;

    return {
      shots,
      shotsOnTarget,
      shotsConceded,
      shotsOnTargetConceded,
      blockedShots,
      totalShots,
    };
  }

  /**
   * Extract a basketball box score for both teams.
   * Returns null for any stat the provider does not supply.
   */
  static extractBasketballBoxScore(teamComp, oppComp) {
    const find = (c, names) => EspnProvider.findStatValue(c, names);

    const fgm = find(teamComp, ['fieldGoalsMade', 'field_goals_made', 'fgMade']);
    const fga = find(teamComp, ['fieldGoalsAttempted', 'field_goals_attempted', 'fgAttempted']);
    const tpm = find(teamComp, ['threePointFieldGoalsMade', 'three_point_field_goals_made', 'threePointersMade', 'threeMade']);
    const tpa = find(teamComp, ['threePointFieldGoalsAttempted', 'three_point_field_goals_attempted', 'threePointersAttempted', 'threeAttempted']);
    const ftm = find(teamComp, ['freeThrowsMade', 'free_throws_made', 'ftMade']);
    const fta = find(teamComp, ['freeThrowsAttempted', 'free_throws_attempted', 'ftAttempted']);
    const orb = find(teamComp, ['offensiveRebounds', 'offensive_rebounds', 'offRebounds']);
    const drb = find(teamComp, ['defensiveRebounds', 'defensive_rebounds', 'defRebounds']);
    const trb = find(teamComp, ['totalRebounds', 'total_rebounds', 'rebounds']);
    const ast = find(teamComp, ['assists', 'assist']);
    const tov = find(teamComp, ['turnovers', 'turnover']);
    const stl = find(teamComp, ['steals', 'steal']);
    const blk = find(teamComp, ['blocks', 'block']);
    const pf = find(teamComp, ['fouls', 'foul', 'personalFouls', 'personal_fouls']);

    const oppFgm = find(oppComp, ['fieldGoalsMade', 'field_goals_made', 'fgMade']);
    const oppFga = find(oppComp, ['fieldGoalsAttempted', 'field_goals_attempted', 'fgAttempted']);
    const oppOrb = find(oppComp, ['offensiveRebounds', 'offensive_rebounds', 'offRebounds']);
    const oppTov = find(oppComp, ['turnovers', 'turnover']);
    const oppFta = find(oppComp, ['freeThrowsAttempted', 'free_throws_attempted', 'ftAttempted']);

    return {
      fgm, fga, tpm, tpa, ftm, fta, orb, drb, trb, ast, tov, stl, blk, pf,
      oppFgm, oppFga, oppOrb, oppTov, oppFta,
    };
  }

  /**
   * Parse an American odds value (number or string like "-108" / "+150").
   * Handles ESPN wrappers such as { value } / { odds }. Returns null when absent.
   */
  static parseAmericanOdds(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw === 'object') {
      raw = raw.value ?? raw.odds ?? raw.displayValue ?? raw.current?.value;
    }
    if (raw === undefined || raw === null || raw === '') return null;
    const num = parseFloat(String(raw).replace(/\s/g, ''));
    return isNaN(num) ? null : num;
  }

  /**
   * Parse a line value that may be a number or a string such as "-3.5" or "o228.5".
   */
  static _parseLineValue(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw === 'object') {
      raw = raw.value ?? raw.line ?? raw.displayValue ?? raw.current?.value;
    }
    if (raw === undefined || raw === null || raw === '') return null;
    const num = parseFloat(String(raw).replace(/[^0-9.+-]/g, ''));
    return isNaN(num) ? null : num;
  }

  /**
   * Extract basketball bookmaker odds from an ESPN summary payload.
   * Uses `pickcenter[0]` / `odds[0]`. Returns null when no odds exist (never 0).
   */
  static extractBasketballOdds(summary) {
    if (!summary) return null;
    const pickcenter = Array.isArray(summary.pickcenter) ? summary.pickcenter : [];
    const oddsList = Array.isArray(summary.odds) ? summary.odds : [];
    const src = pickcenter[0] || oddsList[0] || null;
    if (!src) return null;

    const homeTeamOdds = src.homeTeamOdds || {};
    const awayTeamOdds = src.awayTeamOdds || {};
    const line = v => EspnProvider._parseLineValue(v);

    const moneyLineBlock = src.moneyline || {};
    const lineBlock = (block) => (block ? {
      spread: line(block.spread ?? block.line),
      total: line(block.total ?? block.overUnder),
      homeMoneyLine: EspnProvider.parseAmericanOdds(block.homeMoneyLine ?? block.homeTeamOdds?.moneyLine),
      awayMoneyLine: EspnProvider.parseAmericanOdds(block.awayMoneyLine ?? block.awayTeamOdds?.moneyLine),
    } : null);

    return {
      provider: src.provider?.name || src.provider || 'espn',
      details: src.details ?? null,
      // Home spread (negative = home favourite), total, and two-way prices.
      spread: line(src.spread),
      overUnder: line(src.overUnder),
      overOdds: EspnProvider.parseAmericanOdds(src.overOdds),
      underOdds: EspnProvider.parseAmericanOdds(src.underOdds),
      homeMoneyLine: EspnProvider.parseAmericanOdds(homeTeamOdds.moneyLine ?? src.homeMoneyLine),
      awayMoneyLine: EspnProvider.parseAmericanOdds(awayTeamOdds.moneyLine ?? src.awayMoneyLine),
      homeSpreadOdds: EspnProvider.parseAmericanOdds(homeTeamOdds.spreadOdds ?? src.homeSpreadOdds),
      awaySpreadOdds: EspnProvider.parseAmericanOdds(awayTeamOdds.spreadOdds ?? src.awaySpreadOdds),
      homeIsFavorite: homeTeamOdds.favorite ?? null,
      awayIsFavorite: awayTeamOdds.favorite ?? null,
      open: {
        spread: line(src.pointSpread?.open),
        total: line(src.total?.open),
        homeMoneyLine: EspnProvider.parseAmericanOdds(moneyLineBlock.open?.homeMoneyLine ?? moneyLineBlock.open?.home),
        awayMoneyLine: EspnProvider.parseAmericanOdds(moneyLineBlock.open?.awayMoneyLine ?? moneyLineBlock.open?.away),
      },
      close: {
        spread: line(src.pointSpread?.close ?? src.spread),
        total: line(src.total?.close ?? src.overUnder),
        homeMoneyLine: EspnProvider.parseAmericanOdds(moneyLineBlock.close?.homeMoneyLine ?? moneyLineBlock.close?.home),
        awayMoneyLine: EspnProvider.parseAmericanOdds(moneyLineBlock.close?.awayMoneyLine ?? moneyLineBlock.close?.away),
      },
      live: {
        spread: line(src.pointSpread?.live),
        total: line(src.total?.live),
      },
    };
  }

  /**
   * Extract basketball injuries from an ESPN summary payload.
   * Returns [] when absent; never fabricates players.
   */
  static extractBasketballInjuries(summary) {
    const groups = summary?.injuries;
    if (!Array.isArray(groups) || groups.length === 0) return [];

    const STATUS_MAP = {
      out: 'out', o: 'out',
      doubtful: 'doubtful', d: 'doubtful',
      questionable: 'questionable', q: 'questionable',
      probable: 'probable', p: 'probable',
      'day-to-day': 'day-to-day', 'day to day': 'day-to-day', dtd: 'day-to-day',
    };
    const mapStatus = (raw) => {
      if (!raw) return null;
      const key = String(raw).toLowerCase().trim()
        .replace(/^injury_status_/, '')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return STATUS_MAP[key] || STATUS_MAP[key.replace(/\s/g, '-')] || null;
    };

    const out = [];
    groups.forEach(g => {
      const teamId = g?.team?.id != null ? String(g.team.id) : null;
      const teamName = g?.team?.displayName ?? null;
      const injuries = Array.isArray(g?.injuries) ? g.injuries : [];
      injuries.forEach(inj => {
        const rawStatus = inj?.status || inj?.type?.name || null;
        out.push({
          teamId,
          teamName,
          playerId: inj?.athlete?.id != null ? String(inj.athlete.id) : null,
          playerName: inj?.athlete?.fullName || inj?.athlete?.displayName || null,
          position: inj?.athlete?.position?.abbreviation || inj?.athlete?.position?.name || null,
          status: mapStatus(rawStatus) || (rawStatus ? String(rawStatus).toLowerCase() : null),
          rawStatus,
          detail: inj?.details?.detail ?? null,
          injuryType: inj?.details?.type ?? null,
          location: inj?.details?.location ?? null,
          side: inj?.details?.side ?? null,
          returnDate: inj?.details?.returnDate ?? null,
        });
      });
    });
    return out;
  }

  /**
   * Process a basketball team's completed games into a chronological log with
   * rest, back-to-back, 3-in-4 and road-trip context.
   * Returns entries newest-first. Missing stats stay null.
   */
  processBasketballScheduleForTeam(events, teamId) {
    if (!Array.isArray(events)) return [];
    const DAY = 24 * 60 * 60 * 1000;

    const completed = events
      .filter(e => e?.competitions?.[0]?.status?.type?.state === 'post')
      .map(e => ({ event: e, ts: new Date(e.date).getTime() }))
      .filter(x => !isNaN(x.ts))
      .sort((a, b) => b.ts - a.ts);

    const games = completed.map(({ event, ts }) => {
      const comp = event.competitions?.[0];
      if (!comp) return null;
      const teamComp = comp.competitors?.find(c => String(c?.team?.id) === String(teamId));
      const oppComp = comp.competitors?.find(c => String(c?.team?.id) !== String(teamId));
      if (!teamComp || !oppComp) return null;

      const scoreOf = (c) => {
        const v = c?.score?.value ?? c?.score?.displayValue;
        if (v === undefined || v === null || v === '') return null;
        const n = parseFloat(v);
        return isNaN(n) ? null : n;
      };
      const pf = scoreOf(teamComp);
      const pa = scoreOf(oppComp);
      if (pf === null || pa === null) return null;

      return {
        date: event.date,
        timestamp: ts,
        eventId: String(event.id || ''),
        pf,
        pa,
        total: pf + pa,
        margin: pf - pa,
        isHome: teamComp?.homeAway === 'home',
        result: pf > pa ? 'W' : pf < pa ? 'L' : 'D',
        opponentId: oppComp?.team?.id != null ? String(oppComp.team.id) : null,
        opponentName: oppComp?.team?.displayName || null,
        boxScore: EspnProvider.extractBasketballBoxScore(teamComp, oppComp),
      };
    }).filter(Boolean);

    // Rest days + congestion (games are newest-first, so index+1 is the older game).
    games.forEach((g, i) => {
      const older = games[i + 1];
      g.restDays = older ? Math.round((g.timestamp - older.timestamp) / DAY) : null;
      g.backToBack = g.restDays != null && g.restDays <= 1;

      const windowStart = g.timestamp - 3 * DAY;
      const inWindow = games.filter(x => x.timestamp <= g.timestamp && x.timestamp >= windowStart);
      g.threeInFour = inWindow.length >= 3;

      let trip = 0;
      for (let j = i; j < games.length; j++) {
        if (games[j].isHome) break;
        trip++;
      }
      g.roadTripLength = g.isHome ? 0 : trip;
    });

    return games;
  }

  processScheduleForTeam(events, teamId) {
    if (!events) return [];
    const valid = events.filter(e => {
      const state = e.competitions?.[0]?.status?.type?.state;
      return state === 'post' || state === 'in';
    });
    const last10 = valid.slice(-10).reverse();
    return last10.map(event => {
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

      const findStat = (c, names) => EspnProvider.findStatValue(c, names);

      const cornersWon = findStat(teamComp, ['wonCorners', 'cornerKicks', 'corners']);
      const cornersConceded = findStat(oppComp, ['wonCorners', 'cornerKicks', 'corners']);
      const totalCorners = (cornersWon != null && cornersConceded != null) ? cornersWon + cornersConceded : null;
      const yellowCards = findStat(teamComp, ['yellowCards', 'yellow_cards']);
      const redCards = findStat(teamComp, ['redCards', 'red_cards']);
      const opponentYellowCards = findStat(oppComp, ['yellowCards', 'yellow_cards']);
      const opponentRedCards = findStat(oppComp, ['redCards', 'red_cards']);
      const totalBookings = (yellowCards != null && opponentYellowCards != null)
        ? yellowCards + opponentYellowCards + (redCards || 0) + (opponentRedCards || 0)
        : null;

      // Football shot statistics (null when not supplied by provider)
      const shotStats = EspnProvider.extractFootballShotStats(teamComp, oppComp);
      // Basketball box-score statistics (null when not supplied by provider)
      const boxScore = EspnProvider.extractBasketballBoxScore(teamComp, oppComp);

      return {
        date: event.date,
        pf: teamScore,
        pa: oppScore,
        totalGoals: teamScore + oppScore,
        corners: cornersWon,
        cornersConceded,
        totalCorners,
        yellowCards,
        redCards,
        opponentYellowCards,
        opponentRedCards,
        totalBookings,
        shots: shotStats.shots,
        shotsOnTarget: shotStats.shotsOnTarget,
        shotsConceded: shotStats.shotsConceded,
        shotsOnTargetConceded: shotStats.shotsOnTargetConceded,
        blockedShots: shotStats.blockedShots,
        totalShots: shotStats.totalShots,
        boxScore,
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
